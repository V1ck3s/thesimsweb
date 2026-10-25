/**
 * WinLotView: the lot view window (cDDDSimsView's HouseViewer area). Loads a
 * house file, owns the HouseViewer and its WebGL compositor, paints the
 * rendered view into the 2D game canvas under the control panel, and
 * implements the CPState viewer hooks (zoom, rotation, level, walls).
 *
 * Input follows EdgeDetectScroller: arrow keys scroll by one tile width
 * horizontally / half a tile width vertically (AsyncScroll), a right click
 * centers the view on the clicked tile (CenterView).
 */

import type { GameContext } from "../context.js";
import { Mode, type CPState, type HouseViewerHooks, type WallState } from "../cpstate.js";
import { Gfx, TSWin } from "../ui/tswin.js";
import { Compositor } from "./compositor.js";
import { DynamicCutaway } from "./cutaway.js";
import { EdgeDetectScroller } from "./edgescroll.js";
import { FloorGraphicsMgr } from "./floors.js";
import { HouseViewer, type ObjectDrawer, type TerrainDrawer, type WallDrawer } from "./houseviewer.js";
import { ResFile } from "./iffres.js";
import { loadLotObjectDrawer, type LotObjects } from "./lotobjects.js";
import { LotPeople } from "./lotpeople.js";
import { computeRooms, RoomManager } from "./rooms.js";
import { Terrain } from "./terrain.js";
import { WallManager } from "./walls.js";
import { FixedWorld, RotatableWorld } from "./world.js";

/** HOUS chunk id 0: HouseViewer::DoStream (saved camera). */
interface SavedView {
  cutaway: boolean;
  scale: number;
  originX: number;
  originY: number;
  rotation: number;
  level: number;
  drawRoof: boolean;
}

function readSavedView(house: ResFile): SavedView | null {
  const b = house.get("HOUS", 0);
  if (!b || b.length < 28) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const version = v.getInt32(4, true);
  let p = 12;
  const cut = v.getUint32(p, true);
  const scale = v.getInt32(p + 4, true);
  const originX = v.getInt32(p + 8, true);
  const originY = v.getInt32(p + 12, true);
  p += 16;
  let rotation = 0;
  let level = 1;
  let drawRoof = false;
  if (version > 8) {
    rotation = v.getInt16(p, true);
    p += 2;
  }
  if (version >= 0x1d) {
    level = v.getInt16(p, true);
    p += 2;
  }
  if (version > 0x29) drawRoof = v.getInt16(p, true) !== 0;
  return { cutaway: cut >> 8 !== 0, scale, originX, originY, rotation, level, drawRoof };
}

/**
 * Lot size: simulator global 23 (cSimulator+0x3e), saved in the SIMI chunk
 * as 16-bit globals from offset 12 (House::LoadFile; 0 means 64).
 */
function readLotSize(house: ResFile): number {
  const b = house.get("SIMI", 1) ?? house.list("SIMI").map((c) => house.payload(c))[0];
  if (!b || b.length < 12 + 24 * 2) return 64;
  const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getInt16(12 + 23 * 2, true);
  return n > 3 && n <= 64 ? n : 64;
}

export interface LotViewParts {
  terrain?: TerrainDrawer;
  walls?: WallDrawer;
  objects?: ObjectDrawer;
}

export class WinLotView extends TSWin implements HouseViewerHooks {
  viewer: HouseViewer | null = null;
  house: ResFile | null = null;
  private frame: OffscreenCanvas | null = null;
  private edge: EdgeDetectScroller | null = null;
  /** The wall graph when this view created it (no `parts.walls`). */
  wallManager: WallManager | null = null;
  /** The lot objects when this view loaded them (no `parts.objects`). */
  lotObjects: LotObjects | null = null;
  people: LotPeople | null = null;
  /** Rooms and the dynamic cutaway (only with the view's own wall graph). */
  rooms: RoomManager | null = null;
  cutaway: DynamicCutaway | null = null;
  /** Last mouse position over the view (the dynamic cutaway reads the cursor). */
  private cursor: { x: number; y: number } | null = null;
  /** CPState listeners registered by init, removed by shutdown. */
  private readonly listeners: Array<(s: CPState) => void> = [];
  private readonly onKey = (e: KeyboardEvent): void => {
    if (this.tsOnKeyDown(e.key)) e.preventDefault();
  };

  constructor(
    private readonly ctx: GameContext,
    /** House file relative to the game folder. */
    readonly housePath: string,
    private readonly parts: LotViewParts = {},
  ) {
    super();
  }

  override async init(): Promise<boolean> {
    const house = await ResFile.open(this.housePath);
    this.house = house;
    const world = new RotatableWorld(FixedWorld.load(house, readLotSize(house)));
    const floors = new FloorGraphicsMgr();
    await floors.initialize();
    await floors.loadUsageMap(house);
    // cAnimDeviceSub::NewWorld sizes the 3D viewport to (width, height - 100).
    const viewW = this.ctx.width;
    const viewH = this.ctx.height - 100;
    const comp = new Compositor(viewW, viewH);
    const v = new HouseViewer(world, comp, floors, viewW, viewH);
    if (this.parts.terrain) {
      v.terrain = this.parts.terrain;
    } else {
      const terrain = Terrain.create();
      // Terrain pixels carry GetTerrainZ(tile, clamped) + 0x50 (cColorSwatch blitters).
      terrain.terrainZ = (x, y) => Math.min(0xffff, Math.max(0, v.getTerrainZ(x, y)));
      // CPState hides the terrain grid overlay in live (2) and camera (4) modes.
      let shown: boolean | null = null;
      const syncOverlay = (): void => {
        const m = this.ctx.state.getMode();
        const on = m !== Mode.Live && m !== Mode.Camera;
        if (on === shown) return;
        shown = on;
        terrain.showOverlay(on);
        v.dirty = true;
      };
      syncOverlay();
      this.listen(syncOverlay);
      v.terrain = terrain;
    }
    if (this.parts.walls) {
      v.walls = this.parts.walls;
    } else {
      const walls = await WallManager.create(house, world);
      const st = this.ctx.state;
      walls.setWallState(st.getWallState());
      walls.mode = st.getMode();
      this.listen(() => {
        walls.mode = st.getMode();
      });
      this.wallManager = walls;
      v.walls = walls;
    }
    if (this.parts.objects) {
      v.objects = this.parts.objects;
    } else {
      this.lotObjects = await loadLotObjectDrawer(house, world.fixed);
      v.objects = this.lotObjects.drawer;
      this.people = await LotPeople.load(comp, this.housePath.split("/")[0] ?? "UserData", this.lotObjects.objects.values());
      v.people = this.people;
    }
    const saved = readSavedView(house);
    if (saved) {
      world.setRotation(saved.rotation);
      v.buildMaxAltsTable();
      v.scale = saved.scale >= 1 && saved.scale <= 3 ? saved.scale : 3;
      v.level = saved.level || 1;
      v.cutaway = saved.cutaway;
      v.drawRoof = saved.drawRoof;
      v.setOffsets(saved.originX, saved.originY);
    } else {
      v.setOffsets(0, 0);
    }
    this.viewer = v;
    if (this.wallManager) this.initCutaway(v, this.wallManager);
    this.edge = new EdgeDetectScroller(v, this.ctx.width, this.ctx.height);
    const st = this.ctx.state;
    st.viewer = this;
    st.setZoom(v.scale);
    st.setRotation(world.rotation);
    st.setLevel(v.level);
    window.addEventListener("keydown", this.onKey);
    return true;
  }

  /** House load: cFixedWorld::ComputeRooms(0), RoomManager::ComputeCutaway(0), then the dynamic cutaway. */
  private initCutaway(v: HouseViewer, walls: WallManager): void {
    const fixed = v.world.fixed;
    const rooms = new RoomManager(fixed);
    computeRooms(fixed, rooms);
    rooms.computeCutaway(v, 0);
    const st = this.ctx.state;
    const cut = new DynamicCutaway(v, walls, rooms, {
      mode: () => st.getMode(),
      selectedPerson: () => {
        const guid = st.personGetSelected()?.guid;
        const objs = this.lotObjects?.objects;
        if (guid === undefined || !objs) return null;
        for (const o of objs.values()) if (o.isPerson && o.guid === guid && o.hidden === 0) return { x: o.tileX, y: o.tileY, level: o.level };
        return null;
      },
      cursor: () => this.cursor,
    });
    this.rooms = rooms;
    this.cutaway = cut;
    v.cutawayCtl = cut;
    let mode = st.getMode();
    let sel = st.selectedIndex();
    this.listen(() => {
      if (st.getMode() === mode && st.selectedIndex() === sel) return;
      mode = st.getMode();
      sel = st.selectedIndex();
      cut.onModeChange();
    });
    cut.doDynamicCutaway(false);
  }

  private listen(fn: (s: CPState) => void): void {
    this.listeners.push(fn);
    this.ctx.state.onChange(fn);
  }

  override shutdown(): void {
    for (const fn of this.listeners) this.ctx.state.offChange(fn);
    window.removeEventListener("keydown", this.onKey);
    if (this.ctx.state.viewer === this) this.ctx.state.viewer = null;
    super.shutdown();
  }

  /**
   * cXObject::CenterHouseViewOnMe (not smooth): CPState::SetSelectedPerson
   * centers the view on the selected sim when the lot opens. The head-height
   * adjustment of the person branch (ScrollToCenter) is not ported.
   */
  centerOnPerson(guid: number | undefined): void {
    const v = this.viewer;
    const objs = this.lotObjects?.objects;
    if (!v || !objs) return;
    const people = [...objs.values()].filter((o) => o.isPerson && o.hidden === 0);
    const o = people.find((p) => p.guid === guid) ?? people[0];
    if (!o) return;
    const [fx, fy] = RotatableWorld.rotateCoords(o.fx, o.fy, v.world.rotation, 0x400);
    v.scrollToTile(fx, fy, o.level, false);
  }

  // --- HouseViewerHooks ---------------------------------------------------------

  setScale(zoom: number): void {
    this.viewer?.setScale(zoom);
  }

  setRotation(rotation: number): void {
    this.viewer?.setRotation(rotation);
  }

  setLevel(level: number): void {
    this.viewer?.setLevel(level);
  }

  setWallState(state: WallState): void {
    if (this.cutaway) this.cutaway.setWallState(state);
    else this.wallManager?.setWallState(state);
    if (this.viewer) this.viewer.dirty = true;
  }

  // --- painting / input -----------------------------------------------------------

  override pump(nowMs: number): void {
    this.edge?.pump(nowMs);
    this.viewer?.pump(nowMs);
    this.cutaway?.updateWorld();
    if (this.viewer && this.people?.people.length) {
      this.people.update(nowMs);
      this.viewer.dirty = true;
    }
    super.pump(nowMs);
  }

  override tsPaint(g: Gfx): void {
    const v = this.viewer;
    if (!v) {
      g.fill(0, 0, this.getW(), this.getH(), "#000");
      return;
    }
    if (v.dirty) {
      v.render();
      // One readback per rendered frame; painting reuses the copy.
      this.frame ??= new OffscreenCanvas(v.comp.width, v.comp.height);
      const fc = this.frame.getContext("2d")!;
      fc.drawImage(v.comp.canvas, 0, 0);
    }
    if (this.frame) g.ctx.drawImage(this.frame, g.ox, g.oy);
  }

  /** EdgeDetectScroller::OnKeyDown: arrows scroll (VK_LEFT 0x25 .. VK_DOWN 0x28). */
  override tsOnKeyDown(key: string): boolean {
    const v = this.viewer;
    if (!v) return false;
    const tw = 16 << v.scale;
    switch (key) {
      case "ArrowLeft":
        v.asyncScroll(tw, 0);
        return true;
      case "ArrowRight":
        v.asyncScroll(-tw, 0);
        return true;
      case "ArrowUp":
        v.asyncScroll(0, tw >> 1);
        return true;
      case "ArrowDown":
        v.asyncScroll(0, -(tw >> 1));
        return true;
      default:
        return false;
    }
  }

  /** EdgeDetectScroller::OnMouseUpR -> CenterView: scroll the clicked tile to the center. */
  override tsOnMouseUpR(x: number, y: number): boolean {
    const v = this.viewer;
    if (!v) return false;
    const w = v.world;
    const t = v.pointToWholeTile(x, y, v.level);
    const n = w.size - 2;
    const cx = Math.min(Math.max(t.x - w.minX, 1), n) + w.minX;
    const cy = Math.min(Math.max(t.y - w.minY, 1), n) + w.minY;
    v.scrollToTile((cx << 4) | 8, (cy << 4) | 8, v.level, true);
    return true;
  }

  override tsOnMouseMove(x: number, y: number): boolean {
    this.edge?.onMouseMove(x, y);
    this.cursor = { x, y };
    this.cutaway?.mouseTrack(x, y);
    return this.viewer !== null;
  }

  override tsOnMouseExit(): void {
    this.edge?.stop();
    this.cursor = null;
  }

  override tsOnMouseDownR(_x: number, _y: number): boolean {
    return this.viewer !== null;
  }
}
