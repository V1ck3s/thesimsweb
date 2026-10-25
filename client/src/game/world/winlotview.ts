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
import { soundPlayer } from "../audio/index.js";
import { DIRTY_ARCH_SUBTOOL, DIRTY_ARCH_TOOL, DIRTY_ARCH_UNDO, DIRTY_SHOP_ITEM, Mode, type CPState, type HouseViewerHooks, type WallState } from "../cpstate.js";
import { DefaultTTWindow } from "../ui/ttwindow.js";
import { Gfx, TSWin } from "../ui/tswin.js";
import { Compositor } from "./compositor.js";
import { DynamicCutaway } from "./cutaway.js";
import { EdgeDetectScroller } from "./edgescroll.js";
import { FloorGraphicsMgr } from "./floors.js";
import { HouseViewer, type ObjectDrawer, type TerrainDrawer, type WallDrawer } from "./houseviewer.js";
import { ResFile } from "./iffres.js";
import { loadLotObjectDrawer, type LotObjects } from "./lotobjects.js";
import type { DrawableObject } from "./objectdraw.js";
import type { RenderParam } from "./renderparam.js";
import { LotPeople } from "./lotpeople.js";
import { RoomLighting, timeOfDay } from "./lighting.js";
import { loadRoofSettings, makeArchRoofHooks, roofLayersOf } from "./roofs.js";
import { computeRooms, RoomManager } from "./rooms.js";
import { Terrain } from "./terrain.js";
import { WallManager } from "./walls.js";
import { CursorDrawer, GUID_TILE_CURSOR } from "./tools/cursorobject.js";
import { BUILD_TOOLS } from "./tools/buildtools.js";
import { GameTools, MoveToolAdapter, ToolId } from "./tools/gametools.js";
import { MoveTool } from "./tools/movetool.js";
import type { ToolHost } from "./tools/tool.js";
import { UndoManager } from "./tools/undo.js";
import { Placement, type ObjectBehaviorHooks } from "./tools/placement.js";
import { FixedWorld, RotatableWorld } from "./world.js";
import type { XObject } from "./objects.js";
import type { ObjSelector } from "./objselector.js";
import { Simulator } from "../sim/simulator.js";
import type { WorldHooks } from "../sim/simmodule.js";
import { SimObject } from "../sim/xobject.js";
import type { PersonSim } from "../sim/person.js";
import { TSPieMenu } from "../ui/piemenu.js";
import { popupHeadImage } from "../cas/portraits.js";
import { winMgr } from "../ui/winmgr.js";
import type { TreeTableEntry } from "../sim/treetable.js";
import { pointToObjectId, PickMode } from "./tools/picking.js";
import { ActionIcons } from "./actionicons.js";
import { killObject, makeNewOutOfWorldObject } from "./tools/objectfactory.js";

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
export function readLotSize(house: ResFile): number {
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
  /** The SimAntics simulator ticking the lot's objects (sim/simulator.ts); people are not ticked yet. */
  sim: Simulator | null = null;
  /** Rooms and the dynamic cutaway (only with the view's own wall graph). */
  rooms: RoomManager | null = null;
  cutaway: DynamicCutaway | null = null;
  lighting: RoomLighting | null = null;
  /** The terrain when this view created it (relit with the time of day; the thumbnails switch it to daytime). */
  terrain: Terrain | null = null;
  /** Last mouse position over the view (the dynamic cutaway reads the cursor). */
  private cursor: { x: number; y: number } | null = null;
  /** Buy mode: cGameTools' cMoveTool, its placement rules and the tip it shows (cDDDSimsView::SetTip). */
  buyTool: MoveTool | null = null;
  /** Buy / build commands submitted, undone or redone (the save's dirty test). */
  editCount = 0;
  placement: Placement | null = null;
  private tip: { win: DefaultTTWindow; x: number; y: number; text: string } | null = null;
  private tipWin: DefaultTTWindow | null = null;
  private buttonDown = false;
  private shift = false;
  private ctrl = false;
  /** cGameTools (buy and build tools). */
  gameTools: GameTools | null = null;
  private readonly onModifiers = (e: KeyboardEvent | PointerEvent): void => {
    this.shift = e.shiftKey;
    this.ctrl = e.ctrlKey;
    if (e.type === "keyup" && e instanceof KeyboardEvent) this.activeTools()?.keyUp(e.key);
  };
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
    await floors.loadUsageMap(house, world.fixed);
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
      this.terrain = terrain;
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
      this.lotObjects.drawer.placeHeld = (d, rp) => this.placeHeld(d, rp);
      // `?nosim` keeps the lot static (debug comparison).
      if (!new URLSearchParams(location.search).has("nosim")) await this.initSimulator(house, this.lotObjects);
    }
    // HouseViewer::DoStream's roof settings; DiscoverTilesToRoof's stairs test reads the objects.
    loadRoofSettings(house);
    roofLayersOf(world.fixed).objects = () => this.lotObjects?.objects ?? null;
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
    if (this.lotObjects) await this.initBuyTool(v, this.lotObjects);
    if (this.lotObjects && this.sim) await this.bringInFamily(v, this.lotObjects);
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
    if (this.lotObjects) this.lotObjects.drawer.cutawayView = walls;
    // Room lighting follows the time of day (cSimulator global 4).
    const lighting = new RoomLighting(rooms, v.world, () => this.lotObjects?.objects ?? null);
    const phase0 = timeOfDay(st.getTime().hour);
    lighting.compute(phase0);
    // cSimulator::SetCurrentHour -> GlobalDispatch(0xdd): the terrain is relit too.
    this.terrain?.setLatitudeByTimeOfDay(phase0);
    this.lighting = lighting;
    v.lighting = lighting;

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

  /**
   * Buy mode's tool (cGameTools tool 7, cMoveTool): the hand, or the catalog
   * product being placed (CPState's shop item -> SetParameter).
   */
  private async initBuyTool(v: HouseViewer, lot: LotObjects): Promise<void> {
    const cursorSel = await lot.folder.getSelectorByGUID(GUID_TILE_CURSOR);
    if (!cursorSel) return;
    this.tipWin = await DefaultTTWindow.create(this.ctx.fonts);
    const st = this.ctx.state;
    const p = new Placement(lot.module, v.world.fixed, this.simHooks(), () => v.level);
    const drawer = new CursorDrawer(p);
    const tool = new MoveTool({
      viewer: v,
      placement: p,
      folder: lot.folder,
      cursorSelector: cursorSel,
      renderer: (res) => lot.renderer(res),
      // cSimulator::GetFunds / Spend (expense type 6, "furnishings") when the simulator runs.
      getFunds: () => this.sim?.getFunds() ?? st.getFunds(),
      spend: (n, expense = 6) => {
        if (this.sim) this.sim.spend(expense, n);
        else st.setFunds(st.getFunds() - n);
      },
      shopSoldItem: () => st.shopSoldItem(),
      setTip: (x, y, text) => {
        if (this.tipWin) this.tip = { win: this.tipWin, x, y, text };
      },
      resetTip: () => {
        this.tip = null;
      },
      // UIText STR# 137 "PlacementErrs".
      placementErrorText: (code) => this.ctx.strings.get("UIText", 137, code - 1),
      // cSoundPlayer::PlayBySource(event, -4): UI_object_place, UI_buy_moneyback, UI_error, ...
      playSound: (event) => {
        soundPlayer.playBySource(event);
      },
      shiftDown: () => this.shift,
      invalidate: () => {
        v.dirty = true;
        const c = tool.cursor;
        drawer.cursor = c;
      },
    });
    this.placement = p;
    this.buyTool = tool;
    const tools = this.initGameTools(v, lot, p, tool);
    // CPState::UpdateWorldFromCPState: the build panel's sub-tool picked inside CPState::Update.
    st.worldUpdateHook = (bits) => {
      if (st.getMode() === Mode.Build && bits & (DIRTY_ARCH_TOOL | DIRTY_ARCH_SUBTOOL)) {
        tools.archSetCurrentTool(st.archGetCurrentTool(), st.archGetCurrentSubtool());
      }
    };
    v.cursor = {
      draw: (viewer, comp, rp) => {
        drawer.draw(viewer, comp, rp);
        tools.drawOverlay(viewer, comp, rp);
      },
    };
    window.addEventListener("keydown", this.onModifiers);
    window.addEventListener("keyup", this.onModifiers);
    window.addEventListener("pointermove", this.onModifiers);
    let guid: number | null = null;
    let mode: Mode | null = null;
    let pending = 0;
    this.listen(() => {
      if (st.getMode() !== mode) {
        mode = st.getMode();
        guid = null;
        // CPState::SetMode -> SetCurrentToolByID: buy mode's hand, build mode's arch tool, no tool elsewhere
        // (leaving puts a held object back: the tool's Cancel).
        if (mode === Mode.Buy) {
          tools.setCurrentToolByID(ToolId.Move, -1);
          tool.setParameter(null);
        } else if (mode === Mode.Build) {
          tools.archSetCurrentTool(st.archGetCurrentTool(), st.archGetCurrentSubtool());
        } else {
          tools.current?.cancel();
          tools.issueToolSelection(null);
        }
      } else if (mode === Mode.Build && st.dirty & (DIRTY_ARCH_TOOL | DIRTY_ARCH_SUBTOOL)) {
        tools.archSetCurrentTool(st.archGetCurrentTool(), st.archGetCurrentSubtool());
      }
      if (mode !== Mode.Buy) return;
      const product = st.shopGetCatalogItem();
      const g = product?.guid ?? null;
      // A click on the catalog sets the shop item again (DIRTY_SHOP_ITEM), even the same product.
      if (g === guid && !(st.dirty & DIRTY_SHOP_ITEM && g !== null)) return;
      guid = g;
      const ticket = ++pending;
      if (g === null) {
        if (tool.newPurchase) tool.setParameter(null);
        return;
      }
      void this.selectorForPurchase(lot, g).then((sel) => {
        if (ticket !== pending) return;
        tool.setParameter(sel);
        // The mouse is already over the lot: OnEnterWorld right away.
        if (this.cursor) {
          tool.onEnterWorld();
          tool.float(this.cursor.x, this.cursor.y);
        }
      });
    });
  }

  /** ObjectFolder::GetSelectorByGUID, with the object's semi-global file opened before its init tree runs. */
  private async selectorForPurchase(lot: LotObjects, guid: number): Promise<ObjSelector | null> {
    const sel = await lot.folder.getSelectorByGUID(guid);
    if (sel) await this.sim?.module.res.prepare([sel]);
    return sel;
  }

  /**
   * cGameTools: the build tools around the buy tool, their host (funds,
   * sounds, tips, world refreshes) and the undo manager behind CPState's
   * ArchUndo / ArchRedo.
   */
  private initGameTools(v: HouseViewer, lot: LotObjects, p: Placement, move: MoveTool): GameTools {
    const st = this.ctx.state;
    const undo = new UndoManager();
    const host: ToolHost = {
      ctx: this.ctx,
      state: st,
      viewer: v,
      world: v.world,
      fixed: v.world.fixed,
      walls: this.wallManager,
      rooms: this.rooms,
      lot,
      placement: p,
      undo,
      dirty: {
        walls: (level) => this.wallsChanged(level),
        wallsPreview: (level) => {
          this.wallManager?.rebuildFromMap(level);
          v.dirty = true;
        },
        floors: () => {
          v.dirty = true;
        },
        terrain: () => {
          this.terrain?.markDirty();
          v.buildMaxAltsTable();
          v.dirty = true;
        },
      },
      getFunds: () => this.sim?.getFunds() ?? st.getFunds(),
      spend: (expense, n) => {
        if (this.sim) this.sim.spend(expense, n);
        else st.setFunds(st.getFunds() - n);
      },
      playSound: (event) => {
        soundPlayer.playBySource(event);
      },
      setTip: (x, y, text) => {
        if (this.tipWin) this.tip = { win: this.tipWin, x, y, text };
      },
      resetTip: () => {
        this.tip = null;
      },
      getString: (file, id, index) => this.ctx.strings.get(file, id, index),
      keys: () => ({ shift: this.shift, ctrl: this.ctrl }),
      mouse: () => this.cursor ?? { x: 0, y: 0 },
      invalidate: () => {
        v.dirty = true;
      },
    };
    const tools = new GameTools(host, new MoveToolAdapter(host, move), (g) => this.selectorForPurchase(lot, g));
    for (const [id, make] of BUILD_TOOLS) tools.tools[id] = make(host);
    undo.onChange = () => {
      this.editCount++;
      st.setDirty(DIRTY_ARCH_UNDO);
    };
    // cWinRoofPanel's cRoofLayer::SetPitch / SetRoofPattern, each a cRoofUndoable.
    st.archRoofHooks = makeArchRoofHooks(undo, () => {
      v.dirty = true;
    });
    st.archUndoHooks = {
      undo: () => undo.undoLastCommand(),
      redo: () => undo.redoLastCommand(),
      canUndo: () => undo.canUndo(),
      canRedo: () => undo.canRedo(),
    };
    // cXPortal::ApplyWallStyle / Pickup: a door or window changed its wall.
    p.onWallsChanged = (level) => this.wallsChanged(level);
    this.gameTools = tools;
    return tools;
  }

  /**
   * Walls changed on a level (WallManager::AsynchronousRebuild, then the
   * rooms (cFixedWorld::ComputeRooms), their cutaway and lighting).
   */
  wallsChanged(level: number): void {
    const v = this.viewer;
    if (!v) return;
    this.wallManager?.rebuildFromMap(level);
    if (this.rooms) {
      computeRooms(v.world.fixed, this.rooms, level);
      this.rooms.computeCutaway(v, level);
      this.cutaway?.onRoomsChanged();
    }
    if (this.lighting) this.lighting.compute(this.lighting.phase);
    v.dirty = true;
  }

  /**
   * What placement asks of the simulation: the init tree of a new object
   * (cXObject::Reset; the object joins the simulator's module), the
   * allow-intersection / place / pickup check trees, and KillObject.
   */
  private simHooks(): ObjectBehaviorHooks {
    // An object of the world module the simulator does not hold (e.g. back
    // from an undone deletion) joins it with its data kept, Main restarted.
    const simObject = (obj: XObject): SimObject | null => {
      const m = this.sim?.module;
      if (!m || this.killing.has(obj)) return null;
      const o = m.getObject(obj.objectId);
      if (o && o.obj === obj && !o.killed) return o;
      if (this.lotObjects?.module.objects.get(obj.objectId) !== obj) return null;
      try {
        return m.addObject(obj, false);
      } catch (e) {
        console.warn("[sim] could not take object back", obj.selector.guid.toString(16), e);
        return null;
      }
    };
    return {
      runInitTree: (obj) => {
        const m = this.sim?.module;
        if (!m) return false;
        try {
          m.addObject(obj, true);
        } catch (e) {
          console.warn("[buy] init tree failed", obj.selector.guid.toString(16), e);
          return false;
        }
        // Every part ran its Init (cXMTObject::Reset runs each part's).
        return true;
      },
      runCheckTree: (obj, entry, stackObj) => {
        const o = simObject(obj);
        if (!o) return false;
        const tree = o.fnTable.getTreeID(entry);
        if (tree === 0) return false;
        try {
          return o.runCheckTree(o.behavior, stackObj, tree, null);
        } catch {
          return false;
        }
      },
      onEnterWorld: (obj) => {
        simObject(obj);
      },
      onKill: (obj) => {
        this.sim?.module.removeObject(obj);
      },
    };
  }

  /**
   * The world side of the sim's placement primitives (SimModule.worldHooks):
   * ObjectFolder::GetSelectorByGUID (an object file not opened yet opens in
   * the background: the primitive waits), ObjectModule::
   * MakeNewOutOfWorldObject, cXObject::CanPlace / Place through Placement,
   * a walking person's moves (its tile link follows: out of the old tile,
   * into the new one; its contents follow, SetLocation) and KillObject.
   */
  private createObjectHooks(): WorldHooks {
    const loading = new Map<number, boolean>();
    return {
      selector: (guid) => {
        const lot = this.lotObjects;
        if (!lot) return null;
        const sel = lot.folder.selectorByGUID(guid);
        if (sel) return sel;
        const g = guid >>> 0;
        if (loading.get(g) === false) return null;
        if (!loading.has(g)) {
          loading.set(g, true);
          void lot.folder
            .getSelectorByGUID(g)
            .then((s) => loading.set(g, s !== null))
            .catch(() => loading.set(g, false));
        }
        return undefined;
      },
      make: (sel) => {
        const p = this.placement;
        const lot = this.lotObjects;
        if (!p || !lot) return null;
        const obj = makeNewOutOfWorldObject(p, lot.folder, sel);
        if (obj && this.viewer) this.viewer.dirty = true;
        return obj;
      },
      canPlace: (obj, pos, level, container, slot) => {
        const p = this.placement;
        if (!p) return false;
        p.error = 0;
        p.obstacle = null;
        return p.canPlace(obj, pos, level, container, slot);
      },
      place: (obj, pos, level, container, slot) => {
        const p = this.placement;
        if (!p) return;
        p.place(obj, pos, level, container, slot, true);
        if (this.viewer) this.viewer.dirty = true;
      },
      moveTo: (obj, pos, level) => {
        const p = this.placement;
        if (!p) {
          obj.fx = pos.fx;
          obj.fy = pos.fy;
          return;
        }
        const tile = (f: number): number => f >> 4;
        const sameTile = tile(obj.fx) === tile(pos.fx) && tile(obj.fy) === tile(pos.fy) && obj.level === level;
        const onTile = !sameTile && p.isInWorld(obj) && obj.parentId === 0;
        if (onTile) p.testAndPlace(obj, { placing: false, fy: 0, fx: 0, container: null, slot: -1, level: 0 }, true);
        p.setLocation(obj, pos, level);
        if (onTile && !p.outOfBounds(tile(pos.fx), tile(pos.fy))) {
          p.testAndPlace(obj, { placing: true, fy: pos.fy, fx: pos.fx, container: null, slot: -1, level }, true);
        }
      },
      pickup: (obj) => {
        this.placement?.pickup(obj, true);
        if (this.viewer) this.viewer.dirty = true;
      },
      findGoodLocation: (obj, start, level, opts) => this.placement?.findGoodLocation(obj, start, level, opts) ?? null,
      kill: (obj) => {
        const p = this.placement;
        const lot = this.lotObjects;
        if (!p || !lot || lot.module.objects.get(obj.objectId) !== obj) return;
        this.killing.add(obj);
        try {
          killObject(p, obj);
        } finally {
          this.killing.delete(obj);
        }
        if (this.viewer) this.viewer.dirty = true;
      },
      lastError: () => ({ code: this.placement?.error ?? 0, obstacle: this.placement?.obstacle?.objectId ?? 0 }),
    };
  }

  /**
   * cXPerson::DrawIso: the object in a person's slot 0 is drawn at the
   * person's hand registration (SAnimator::PrepReg, then
   * RenderLoc::SetWorldCoord: world (x, y, z) -> fixed (z, x) / 0.1875 and
   * altitude y * 2 sqrt 6 / 3).
   */
  private placeHeld(d: DrawableObject, rp: RenderParam): boolean {
    const obj = (d as { obj?: XObject }).obj;
    const v = this.viewer;
    const lot = this.lotObjects;
    if (!obj || !v || !lot || !this.people) return false;
    const parent = lot.objects.get(obj.parentId);
    if (!parent?.isPerson || obj.slotHierNumber !== 1) return false;
    const p = this.people.registrationPoint(parent, 0, v.world.rotation, v.world.fixed.getFAlt(parent.fx, parent.fy));
    if (!p) return false;
    rp.x = p[2] / 0.1875;
    rp.y = p[0] / 0.1875;
    rp.z = Math.fround((p[1] * 2 * Math.sqrt(6)) / 3);
    rp.level = parent.level;
    rp.updateScreenCoords();
    return true;
  }

  /** Objects being killed by the simulation (their pickup check trees must not bring them back). */
  private readonly killing = new Set<XObject>();

  /**
   * Family members without a person object on the lot (a new move-in, or
   * members away) get one: PersonFinder::CreateInstance (CPState::
   * SetSelectedPerson creates the missing instance) makes the character's
   * object out of the world (cXPerson::Reset: persistent data, Init) and
   * cXObject::FindGoodLocation places it from the view's centermost tile
   * outwards (level 1). The lot view then dresses and draws it. The
   * arrival by car / from the road is not ported: they appear in place.
   */
  private async bringInFamily(v: HouseViewer, lot: LotObjects): Promise<void> {
    const sim = this.sim;
    const p = this.placement;
    if (!sim || !p) return;
    const nbhdDir = this.housePath.split("/")[0] ?? "UserData";
    const present = new Set([...lot.module.objects.values()].filter((o) => o.isPerson).map((o) => o.guid | 0));
    for (const info of this.ctx.state.family) {
      if (info.guid === undefined || present.has(info.guid | 0)) continue;
      const sel = await lot.folder.getSelectorByGUID(info.guid).catch(() => null);
      if (!sel) continue;
      const obj = makeNewOutOfWorldObject(p, lot.folder, sel);
      if (!obj) continue;
      const w = v.world;
      const c = v.pointToWholeTile(v.viewW >> 1, v.viewH >> 1, 1);
      const [cx, cy] = RotatableWorld.rotateCoords(c.x, c.y, (4 - w.rotation) & 3, 0x40);
      let placed = false;
      for (let r = 0; r < w.size && !placed; r++) {
        for (let dy = -r; dy <= r && !placed; dy++) {
          for (let dx = -r; dx <= r && !placed; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const pos = { fx: ((cx + dx) << 4) | 8, fy: ((cy + dy) << 4) | 8 };
            if (p.outOfBounds(cx + dx, cy + dy) || !p.canPlace(obj, pos, 1, null, 0)) continue;
            p.place(obj, pos, 1, null, 0, true);
            placed = true;
          }
        }
      }
      if (!placed) {
        killObject(p, obj);
        continue;
      }
      present.add(info.guid | 0);
      const ps = sim.module.persons.find((x) => x.obj === obj);
      if (ps && this.people && (await this.people.addPerson(nbhdDir, obj))) {
        this.people.bindSim(obj, (sk) => ps.animator.attach(sk), () => ps.renderDir ?? ps.obj.dir);
      }
    }
    v.dirty = true;
  }

  /** The selected sim's action icons (Live mode). */
  private readonly actionIcons = new ActionIcons();

  /** The Live mode pie menu (cWinPeople's cTSPieMenu), made on first use. */
  private pie: TSPieMenu | null = null;

  /** The selected family member's cXPerson. */
  selectedPerson(): PersonSim | null {
    const info = this.ctx.state.personGetSelected();
    if (!info || info.guid === undefined || !this.sim) return null;
    return this.sim.module.persons.find((p) => (p.obj.selector.guid | 0) === (info.guid! | 0)) ?? null;
  }

  /**
   * cObjPickerTool::TryClick in Live mode: the object or person under the
   * cursor (HouseViewer::PointToObjectID) offers the
   * interactions the selected sim passes (ObjTestSim's menu), shown by
   * DoMenu; the one picked goes to the sim with priority 50
   * (MenuItemSelected -> cXPerson::AddAction).
   */
  private async liveClick(x: number, y: number): Promise<void> {
    const sim = this.sim;
    const v = this.viewer;
    const p = this.placement;
    const lot = this.lotObjects;
    const person = this.selectedPerson();
    if (!sim || !v || !p || !lot || !person) return;
    const people = this.people;
    const id = pointToObjectId(v, p, (r) => lot.renderer(r), x, y, v.level || 1, PickMode.Any, people ? (o) => people.screenRect(o, v) : null);
    const target = id ? sim.module.getObject(id) : null;
    if (!target) return;
    const entries = person.menuFor(target);
    if (!entries.length) return;
    const e = await this.doMenu(person, entries, this.area.left + x, this.area.top + y);
    if (e) person.addAction(person.makeInteraction(target, e, 50));
  }

  /** The Live mode sub pie (cWinPeople::GetPeopleSubPie), made on first use. */
  private subPie: TSPieMenu | null = null;
  /** The pie heads made so far, by body strings. */
  private readonly popupHeads = new Map<string, ImageBitmap | null>();

  /**
   * cObjPickerTool::DoMenu: names "a/b" go in a sub menu "a" (made at the
   * place of its first entry), others straight in the people pie. Picking a
   * sub menu pops the sub pie up at the cursor with the sub menu's name as
   * title; letting go there near its center comes back to the people pie,
   * elsewhere cancels. The selected sim's head (SAnimator::StartPopupHead)
   * sits at the center. Not ported: pages of 12 items (-3), and the people
   * pie staying up, its items disabled, under the sub pie.
   */
  private async doMenu(person: PersonSim, entries: TreeTableEntry[], x: number, y: number): Promise<TreeTableEntry | null> {
    type Item = { text: string; entry: TreeTableEntry | null; sub: Array<{ text: string; entry: TreeTableEntry }> };
    const top: Item[] = [];
    for (const e of entries) {
      const slash = e.name.indexOf("/");
      if (slash < 0) {
        top.push({ text: e.name, entry: e, sub: [] });
        continue;
      }
      const head = e.name.slice(0, slash);
      let m = top.find((t) => t.entry === null && t.text === head);
      if (!m) {
        m = { text: head, entry: null, sub: [] };
        top.push(m);
      }
      m.sub.push({ text: e.name.slice(slash + 1), entry: e });
    }
    const pie = (this.pie ??= await TSPieMenu.forLiveMode(this.ctx));
    const sub = (this.subPie ??= await TSPieMenu.forLiveMode(this.ctx));
    const headImg = await this.popupHead(person, pie);
    const paintHead = headImg
      ? (g: Gfx, cx: number, cy: number): void => g.blit(headImg, cx - (headImg.width >> 1), cy - (headImg.height >> 1))
      : null;
    pie.onPaintCenter = paintHead;
    sub.onPaintCenter = paintHead;
    const popup = (m: TSPieMenu, px: number, py: number, items: string[]): Promise<number> =>
      new Promise((resolve) => m.show(px, py, items, resolve));
    for (;;) {
      const sel = await popup(
        pie,
        x,
        y,
        top.map((t) => t.text),
      );
      const it = top[sel];
      if (!it) return null;
      if (it.entry) return it.entry;
      sub.title = it.text;
      const c = winMgr.cursorPosition();
      const s = await popup(
        sub,
        c.x,
        c.y,
        it.sub.map((t) => t.text),
      );
      const leaf = it.sub[s];
      if (leaf) return leaf.entry;
      if (sub.inactiveRadius < sub.getDistance()) return null;
    }
  }

  /** PopupHead: the selected sim's head for the pie center (a still here). */
  private async popupHead(person: PersonSim, pie: TSPieMenu): Promise<ImageBitmap | null> {
    const lp = this.people?.people.find((q) => q.obj === person.obj);
    if (!lp) return null;
    const strings = lp.anim.bodyStrings.strings;
    const key = strings.join("|");
    if (!this.popupHeads.has(key)) {
      // inside the pie's inactive circle
      const size = Math.max(16, 2 * pie.inactiveRadius - 6);
      this.popupHeads.set(key, await popupHeadImage(strings, Math.trunc(size * 0.8), size).catch(() => null));
    }
    return this.popupHeads.get(key) ?? null;
  }

  /** XViewer routes the mouse to cGameTools' current tool in buy and build modes. */
  private activeTools(): GameTools | null {
    const m = this.ctx.state.getMode();
    return m === Mode.Buy || m === Mode.Build ? this.gameTools : null;
  }

  override postChildDraw(g: Gfx): void {
    if (this.sim && this.ctx.state.getMode() === Mode.Live) {
      const p = this.selectedPerson();
      if (p) this.actionIcons.paint(g, p);
    }
    const t = this.tip;
    if (!t) return;
    t.win.setToolTip(t.text);
    t.win.moveTo(t.x, t.y);
    t.win.plot(g.ctx, g.ox, g.oy);
  }

  override tsOnMouseDownL(x: number, y: number): boolean {
    const tools = this.activeTools();
    if (!tools && this.viewer && this.ctx.state.getMode() === Mode.Live && this.sim) {
      const p = this.selectedPerson();
      const a = p ? this.actionIcons.hit(p, x, y) : null;
      if (p && a) p.removeAction(a);
      else void this.liveClick(x, y);
      return true;
    }
    if (!tools || !this.viewer) return false;
    this.buttonDown = true;
    tools.mouseDown(x, y);
    return true;
  }

  override tsOnMouseUpL(x: number, y: number): boolean {
    const tools = this.activeTools();
    if (!tools || !this.viewer) return false;
    this.buttonDown = false;
    tools.mouseUp(x, y);
    return true;
  }

  override tsOnMouseEnter(): void {
    this.activeTools()?.enterWorld();
  }

  /**
   * cSimulator over the loaded objects: their saved tree stacks resume (or
   * their Init trees run); the view redraws when an object's look changes
   * and hides killed objects (the object module and tile arrays are not
   * updated yet). A load failure leaves the lot static.
   */
  private async initSimulator(house: ResFile, lot: LotObjects): Promise<void> {
    try {
      const sim = await Simulator.create(house, lot.objects.values() as Iterable<XObject>);
      sim.state = this.ctx.state;
      sim.module.onDirty = (): void => {
        if (this.viewer) this.viewer.dirty = true;
      };
      sim.module.onKill = (o): void => {
        o.obj.objectData[34] = 1;
        if (this.viewer) this.viewer.dirty = true;
      };
      this.sim = sim;
      sim.module.worldHooks = this.createObjectHooks();
      // objects the behaviors create (the original folder has them all)
      await Promise.all([...sim.module.createdObjectGUIDs()].map((g) => lot.folder.getSelectorByGUID(g >>> 0).catch(() => null)));
      // The people's VitaBoys follow the simulation's animators.
      for (const ps of sim.module.persons) {
        this.people?.bindSim(
          ps.obj,
          (sk) => ps.animator.attach(sk),
          () => ps.renderDir ?? ps.obj.dir,
        );
      }
    } catch (e) {
      console.error("[sim] simulator not started", e);
    }
  }

  /** cSimulator::SetCurrentHour's time-of-day change (global 4): relight the rooms and the terrain. */
  private updateTimeOfDay(): void {
    const l = this.lighting;
    if (!l || !this.viewer) return;
    const phase = timeOfDay(this.ctx.state.getTime().hour);
    if (phase === l.phase) return;
    l.compute(phase);
    this.terrain?.setLatitudeByTimeOfDay(phase);
    this.viewer.dirty = true;
  }

  private listen(fn: (s: CPState) => void): void {
    this.listeners.push(fn);
    this.ctx.state.onChange(fn);
  }

  override shutdown(): void {
    for (const fn of this.listeners) this.ctx.state.offChange(fn);
    window.removeEventListener("keydown", this.onKey);
    window.removeEventListener("keydown", this.onModifiers);
    window.removeEventListener("keyup", this.onModifiers);
    window.removeEventListener("pointermove", this.onModifiers);
    this.buyTool?.cancel();
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
    this.updateTimeOfDay();
    if (this.sim && this.viewer) {
      this.sim.syncFromState();
      this.sim.simulate(nowMs);
    }
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
    if (this.activeTools()?.keyDown(key)) return true;
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
    this.activeTools()?.mouseTrack(x, y);
    return this.viewer !== null;
  }

  override tsOnMouseExit(): void {
    this.edge?.stop();
    this.cursor = null;
    this.buttonDown = false;
    this.activeTools()?.exitWorld();
  }

  override tsOnMouseDownR(_x: number, _y: number): boolean {
    return this.viewer !== null;
  }
}
