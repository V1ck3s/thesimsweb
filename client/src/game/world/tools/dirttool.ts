/**
 * cDirtTool: the base of the terrain tools (cSimpleAltTool raise / lower,
 * cLevelDirtTool). It owns what they share: the click (level check, undo
 * snapshot), the release (TerrainUndoable submitted when something was
 * paid), the "may this corner move" test, ForceGrade (neighbors pulled within
 * 5 altitude units), the grass reset of changed tiles, the tile highlight map
 * and the error tooltip with its red cursor.
 *
 * Altitudes are the PackedAlt bytes; the terrain tools move a tile's top
 * corner (view byte 1: the vertex at the tile's (x, y) corner), so a vertex
 * is addressed by the view tile it is the top corner of.
 *
 * cDirtTool fields: +0x2c released (no drag in progress), +0x30 cost of the
 * current operation, +0x34 error tile, +0x38 error code, +0x3c error shown,
 * +0x40 time the error tip may be cleared, +0x44 TerrainUndoable, +0x48 the
 * error cursor (Terrain cursor graphic 2).
 * Statics: lbl_105BA51C "terrain scratch" (altitude copy), lbl_105BA58C
 * "terrain flags" (64x64 view tiles: bits 0/1 green/red highlight, bit 2
 * graded), lbl_105BA520 the click point, lbl_105BA4A4 the last drag point.
 */

import type { Compositor } from "../compositor.js";
import type { HouseViewer } from "../houseviewer.js";
import { OD } from "../objects.js";
import type { DrawableObject, DrawGroupItem } from "../objectdraw.js";
import { drawIso } from "../objectdraw.js";
import type { ObjSelector } from "../objselector.js";
import type { Renderer } from "../renderer.js";
import type { RenderParam } from "../renderparam.js";
import { Terrain } from "../terrain.js";
import { DIRS, RotatableWorld, type TilePt } from "../world.js";
import { PF, Placement, tileOf } from "./placement.js";
import { TerrainUndoable } from "./terrainundo.js";
import { Tool, type ToolEvent, type ToolHost } from "./tool.js";

/** GUID of the "Terrain cursor" object (Cursors.iff). */
export const GUID_TERRAIN_CURSOR = 0x2f39b7a6;

/** Terrain cursor graphics (+0x4a of the cursor object). */
export const TerrainCursorGraphic = {
  raise: 0,
  lower: 1,
  error: 2,
  levelAnchor: 3,
  levelCorner: 4,
} as const;

/** cDirtTool error codes (+0x38): UpdateErrorMessage's jump table lbl_105BBE50. */
export const DirtError = {
  none: 0,
  cannotModify: 1,
  tooHigh: 2,
  tooLow: 3,
  needsFlat: 4,
  multiTile: 5,
  noFunds: 6,
  areaTooLarge: 7,
  firstStoryOnly: 8,
} as const;

/** The flags array size (c2DArray(1, 0x40, 0x40)). */
const FLAGS_SIZE = 0x40;
/** "terrain flags" bit 2: the tile was graded by this ForceGrade (cleared with lbl_105BF2F8 = 0xfb). */
const FLAG_GRADED = 4;
/** Highest corner altitude (PullAltitude clamps to 0 .. MAX_ALT). */
export const MAX_ALT = 0x40;
/** The steepest step between neighboring corners (ForceGrade). */
const MAX_STEP = 5;

/** lbl_105BBE4C: from a vertex, the four tiles sharing it: the tile, then (-1, 0), (-1, -1), (0, -1). */
const VERTEX_TILE_STEPS: ReadonlyArray<readonly [number, number]> = [DIRS[2]!, DIRS[0]!, DIRS[3]!, [0, 0]];
/** lbl_105BA590 (__sinit_TerrainTools_cpp): the four neighbors ForceGrade and AvgPullAltitude look at. */
export const GRADE_NEIGHBORS: ReadonlyArray<readonly [number, number]> = [DIRS[3]!, DIRS[1]!, DIRS[2]!, DIRS[0]!];

/** ObjectFolder::GetSelectorByGUID(0x2f39b7a6), once per folder. */
const cursorSelectors = new WeakMap<object, Promise<ObjSelector | null>>();

/**
 * A terrain cursor object (MakeTerrainCursor: an out-of-world instance of
 * GUID 0x2f39b7a6 with its graphic set). Placing it puts it at a tile corner
 * in the world; the tools' PickUp (vtable +0x58) takes it out.
 *
 * Shortcut (like cXCursorObject, see cursorobject.ts): the cursor is not put
 * in the tile object arrays; CanPlace is "on the lot", and it is drawn by the
 * tool's overlay.
 */
export class TerrainCursor implements DrawableObject {
  /** +0xf8 / +0xf4 (world fixed point), +0x110. */
  fx = -16;
  fy = -16;
  level = 1;
  /** +0x4c */
  dir = 0;
  hidden = 0;
  isDynamic = true;
  spriteMask = null;
  next = null;
  inWorld = false;
  private sel: ObjSelector | null = null;
  private rend: Renderer | null = null;

  constructor(
    private readonly host: ToolHost,
    /** +0x4a */
    public graphic: number,
  ) {
    const folder = host.lot.folder;
    let p = cursorSelectors.get(folder);
    if (!p) {
      p = folder.getSelectorByGUID(GUID_TERRAIN_CURSOR);
      cursorSelectors.set(folder, p);
    }
    void p.then((sel) => {
      this.sel = sel;
      this.rend = sel ? host.lot.renderer(sel.res) : null;
      host.invalidate();
    });
  }

  get renderer(): Renderer {
    return this.rend!;
  }

  get spriteMaskBase(): number {
    return this.sel?.objd.dynamicSpritesBaseId ?? 0;
  }

  items(graphic: number, dirIndex: number, scale: number): readonly DrawGroupItem[] | null {
    return this.sel?.getDrawGroup(graphic)?.getItemList(dirIndex, scale)?.items ?? null;
  }

  /** cXObject::Dirty after a graphic change. */
  setGraphic(g: number): void {
    if (this.graphic === g) return;
    this.graphic = g;
    this.host.invalidate();
  }

  /** vtable +0x5c CanPlace(FTilePt, level, container, slot) (see the class comment). */
  canPlace(fx: number, fy: number, level: number): boolean {
    return level >= 1 && level <= 3 && !this.host.placement.outOfBounds(tileOf(fx), tileOf(fy));
  }

  /** vtable +0x60 Place */
  place(fx: number, fy: number, level: number): void {
    this.fx = fx;
    this.fy = fy;
    this.level = level;
    this.inWorld = true;
    this.host.invalidate();
  }

  /** vtable +0x58 PickUp */
  pickUp(): void {
    if (!this.inWorld) return;
    this.inWorld = false;
    this.host.invalidate();
  }

  draw(viewer: HouseViewer, comp: Compositor, rp: RenderParam): void {
    if (!this.inWorld || !this.rend || this.level > viewer.level) return;
    const q = rp.clone();
    q.setGridCoords(this.fx, this.fy, this.level);
    drawIso(this, viewer, comp, q);
  }
}

export abstract class DirtTool extends Tool {
  /** lbl_105BA51C "terrain scratch": the altitude array before the change (world tiles, 4 bytes each). */
  static scratch: Uint8Array | null = null;
  /** lbl_105BA58C "terrain flags" (view tiles). */
  static flags: Uint8Array | null = null;
  /** lbl_105BA520: the click's fixed-point position. */
  static clickFx = 0;
  static clickFy = 0;
  /** lbl_105BA4A4: XViewer's last drag position (the tools reset and update it). */
  static lastFx = -16;
  static lastFy = -16;

  /** +0x2c */
  released = true;
  /** +0x30 */
  cost = 0;
  /** +0x34 */
  errTile: TilePt = { x: 0, y: 0, level: 0 };
  /** +0x38 / +0x3c */
  err: number = DirtError.none;
  private errShown = -1;
  /** +0x40 */
  private tipClearTime = 0;
  /** +0x44 */
  private undoable: TerrainUndoable | null = null;
  /** +0x48 */
  private errorCursor: TerrainCursor | null = null;

  constructor(host: ToolHost) {
    super(host);
  }

  protected get world(): RotatableWorld {
    return this.host.world;
  }

  /** lbl_105BA524: the price of one altitude unit (Build.iff STR# 0x80, the terrain products' price). */
  protected altPrice(): number {
    return Number.parseInt(this.host.getString("Build", 0x80, 0), 10) || 0;
  }

  /** The "!OutOfBounds" test the tools run on view tiles. */
  protected inInterior(x: number, y: number): boolean {
    return this.world.inInterior(x, y);
  }

  /** The view tile's top corner altitude (GetPackedAlt byte 1). */
  protected topAlt(x: number, y: number): number {
    return this.world.getPackedAlt(x, y)[1];
  }

  protected setError(code: number, x: number, y: number, level: number): void {
    this.err = code;
    this.errTile = { x, y, level };
  }

  // --- vtable ------------------------------------------------------------------

  /** RapidFire__9cDirtToolFv */
  override rapidFire(): boolean {
    return false;
  }

  /** cDirtTool::Select: the scratch and flags arrays, the error cursor. */
  override select(): void {
    const n = this.host.fixed.size;
    if (!DirtTool.scratch) DirtTool.scratch = new Uint8Array(n * n * 4);
    if (!DirtTool.flags) {
      DirtTool.flags = new Uint8Array(FLAGS_SIZE * FLAGS_SIZE);
      // cColorSwatch::Predraw reads the highlight bits while the array exists.
      const t = this.host.viewer.terrain;
      if (t instanceof Terrain) {
        t.swatch.highlightAt = (x, y) => {
          const f = DirtTool.flags;
          return f && x >= 0 && y >= 0 && x < FLAGS_SIZE && y < FLAGS_SIZE ? f[x * FLAGS_SIZE + y]! : 0;
        };
      }
    }
    this.errShown = -1;
    if (!this.errorCursor) this.errorCursor = new TerrainCursor(this.host, TerrainCursorGraphic.error);
  }

  /** cDirtTool::Deselect */
  override deselect(): void {
    DirtTool.scratch = null;
    if (DirtTool.flags) {
      DirtTool.flags = null;
      const t = this.host.viewer.terrain;
      if (t instanceof Terrain) t.swatch.highlightAt = null;
      this.host.invalidate();
    }
    this.errorCursor?.pickUp();
    this.errorCursor = null;
  }

  /** cDirtTool::Float: the error tip goes away once the mouse is up and 500 ms have passed. */
  override float(_e: ToolEvent): void {
    if (this.released && this.tipClearTime <= performance.now()) {
      this.errShown = 0;
      this.err = DirtError.none;
      this.setToolTip(null);
    }
  }

  /** cDirtTool::Click: ground floor only; a fresh undo snapshot. */
  override click(e: ToolEvent): void {
    if (this.currentLevel() < 2) {
      this.setToolTip(null);
      DirtTool.clickFx = e.fx;
      DirtTool.clickFy = e.fy;
      DirtTool.lastFx = -16;
      DirtTool.lastFy = -16;
      this.errShown = -1;
      this.released = false;
      if (!this.undoable) this.undoable = new TerrainUndoable(this, this.host);
      this.undoable.takeSnapshot();
    } else {
      this.setError(DirtError.firstStoryOnly, e.fx >> 4, e.fy >> 4, this.currentLevel());
      this.doDeniedSound();
      this.updateErrorMessage();
    }
  }

  /** cDirtTool::Release: the undo record is submitted when the operation cost something. */
  override release(_e: ToolEvent): void {
    if (this.released) return;
    if (this.undoable) {
      if (this.cost !== 0) {
        this.undoable.setCost(this.cost);
        this.host.undo.submitUndoable(this.undoable);
      }
      this.undoable = null;
    }
    this.released = true;
  }

  /** cDirtTool::OnChar: the cTerrain display commands ('o' 0xbc grid overlay, 'h' 800 steep tiles only). */
  override onChar(ch: string): boolean {
    const t = this.host.viewer.terrain;
    if (ch === "o") {
      if (t instanceof Terrain) t.showOverlay(!t.overlayVisible);
    } else if (ch === "h") {
      if (t instanceof Terrain) t.flatOnly = !t.flatOnly;
    } else {
      return false;
    }
    this.host.invalidate();
    return true;
  }

  override drawOverlay(viewer: HouseViewer, comp: Compositor, rp: RenderParam): void {
    this.errorCursor?.draw(viewer, comp, rp);
  }

  // --- cDirtTool ---------------------------------------------------------------

  /** cDirtTool::UpdateErrorMessage: the cost or error tip, and the red cursor on the error tile. */
  updateErrorMessage(): void {
    let showCursor = false;
    if (!this.released && this.err === DirtError.none) {
      if (this.cost === 0) this.setToolTip(null);
      else this.setToolTip(`§${this.cost.toLocaleString("en-US")}`);
      this.errShown = this.err;
    } else if (this.errShown === this.err) {
      showCursor = !this.released;
    } else {
      this.errShown = this.err;
      showCursor = !this.released;
      // UIText STR# 0x95 (cDirtTool::cDirtTool loads its 7 strings).
      const msg = (i: number): string => this.host.getString("UIText", 0x95, i);
      switch (this.err) {
        case DirtError.cannotModify:
        case DirtError.tooHigh:
        case DirtError.tooLow:
        case DirtError.needsFlat:
        case DirtError.multiTile:
        case DirtError.noFunds:
          this.setToolTip(msg(this.err - 1));
          break;
        case DirtError.areaTooLarge:
          this.setToolTip("Area too large");
          break;
        case DirtError.firstStoryOnly:
          this.setToolTip(msg(6));
          showCursor = true;
          break;
        default:
          this.setToolTip(null);
      }
    }
    this.tipClearTime = performance.now() + 500;
    const c = this.errorCursor;
    if (!c) return;
    if (showCursor) DirtTool.placeTerrainCursor(this.host, c, this.errTile.x, this.errTile.y, this.currentLevel());
    else c.pickUp();
  }

  /**
   * cDirtTool::MayModifyTerrain(vertex, checkObjects): the four tiles around
   * the vertex (on the lot) have no floor or wall on either level, no water,
   * no pool or deck, are not on the lot's second row, have no object needing
   * flat ground (when asked) and may be edited. Error 1 on the vertex's tile.
   */
  mayModifyTerrain(pt: TilePt, checkObjects: boolean): boolean {
    const w = this.world;
    const f = this.host.fixed;
    const n = f.size;
    let x = pt.x;
    let y = pt.y;
    const fail = (): boolean => {
      this.setError(DirtError.cannotModify, x, y, 1);
      return false;
    };
    for (let i = 0; i < 4; i++) {
      const [wx, wy] = w.toWorld(x, y);
      if (wx >= 1 && wx < n - 1 && wy >= 1 && wy < n - 1) {
        if (f.floors[0]!.u16(wx, wy) !== 0) return fail();
        if (f.floors[1]!.u16(wx, wy) !== 0 || f.walls[0]!.u8(wx, wy) !== 0 || f.walls[1]!.u8(wx, wy) !== 0 || f.hasWater(wx, wy, 1)) return fail();
        if (n - 2 < wx || n - 2 < wy || wx < 2 || wy < 2 || f.hasPoolOrDeck(wx, wy, 1)) return fail();
        if (checkObjects && (this.hasFlatObjects({ x, y, level: 1 }) || this.hasFlatObjects({ x, y, level: 2 }))) return fail();
        if (!w.mayEditTile(x, y, this.host.placement.anywhere)) return fail();
      }
      const step = VERTEX_TILE_STEPS[i]!;
      x += step[0];
      y += step[1];
    }
    return true;
  }

  /** cDirtTool::HasFlatObjects: an object on the view tile that cannot stand on a slope. */
  hasFlatObjects(pt: TilePt): boolean {
    const [wx, wy] = this.world.toWorld(pt.x, pt.y);
    for (const o of this.host.placement.tileObjects(wx, wy, pt.level)) {
      if (!(Placement.od(o, OD.placementFlags) & PF.onSlope)) return true;
    }
    return false;
  }

  /** cDirtTool::DirtyTileNeighborhood (the terrain is redrawn whole here). */
  protected dirtyTileNeighborhood(): void {
    this.host.invalidate();
  }

  /**
   * cDirtTool::ForceGrade(x0, y0, x1, y1): the vertices inside the rectangle
   * are fixed; from its border outward, every neighbor more than 5 units
   * above or below is pulled to 5 units, and pulls its own neighbors in turn.
   * Fails (error 1) on a vertex that may not move or was fixed. Each pulled
   * unit beyond 5 costs the altitude price.
   */
  forceGrade(x0: number, y0: number, x1: number, y1: number): boolean {
    const flags = DirtTool.flags!;
    for (let i = 0; i < flags.length; i++) flags[i] = flags[i]! & 0xfb;
    const list: Array<[number, number]> = [];
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        if (x === x0 || x === x1 || y === y0 || y === y1) list.push([x, y]);
        else flags[x * FLAGS_SIZE + y]! |= FLAG_GRADED;
      }
    }
    const price = this.altPrice();
    for (let i = 0; i < list.length; i++) {
      const [cx, cy] = list[i]!;
      if (!this.inInterior(cx, cy)) continue;
      const alt = this.topAlt(cx, cy);
      flags[cx * FLAGS_SIZE + cy]! |= FLAG_GRADED;
      for (const [dx, dy] of GRADE_NEIGHBORS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (!this.inInterior(nx, ny)) continue;
        let d = this.topAlt(nx, ny) - alt;
        if (d <= MAX_STEP && d >= -MAX_STEP) continue;
        // Already waiting in the list (after the current vertex).
        if (list.slice(i + 1).some(([lx, ly]) => lx === nx && ly === ny)) continue;
        if (flags[nx * FLAGS_SIZE + ny]! & FLAG_GRADED) {
          this.setError(DirtError.cannotModify, nx, ny, 1);
          return false;
        }
        if (!this.mayModifyTerrain({ x: nx, y: ny, level: 1 }, true)) {
          this.setError(DirtError.cannotModify, nx, ny, 1);
          return false;
        }
        let step: number = MAX_STEP;
        if (d < MAX_STEP + 1) {
          step = -MAX_STEP;
          d = -d;
        }
        this.cost += (d - MAX_STEP) * price;
        this.setTopAlt({ x: nx, y: ny, level: 1 }, (alt + step) & 0xff);
        list.push([nx, ny]);
      }
    }
    return true;
  }

  /** cDirtTool::SetHiliteArea: green (valid) or red highlight on the tiles of a rectangle, none elsewhere. */
  setHiliteArea(a: TilePt, b: TilePt, valid: boolean): void {
    const flags = DirtTool.flags;
    if (!flags) return;
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    for (let x = 0; x < FLAGS_SIZE; x++) {
      for (let y = 0; y < FLAGS_SIZE; y++) {
        const old = flags[x * FLAGS_SIZE + y]!;
        let v = old & 0xfc;
        if (x0 <= x && x <= x1 && y0 <= y && y <= y1) v |= valid ? 1 : 2;
        if (v !== old) {
          this.dirtyTileNeighborhood();
          flags[x * FLAGS_SIZE + y] = v;
        }
      }
    }
  }

  /**
   * cDirtTool::FinalizeChanges(before): the tiles whose own corner moved
   * (and the three tiles sharing that corner) lose their grass (0x80).
   */
  finalizeChanges(before: Uint8Array): void {
    const f = this.host.fixed;
    const n = f.size;
    const grass = f.grass;
    const bare = (x: number, y: number): void => {
      grass.data[grass.offset(x, y)] = 0x80;
    };
    const inside = (x: number, y: number): boolean => x >= 1 && x < n - 1 && y >= 1 && y < n - 1;
    let changed = false;
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) {
        const o = f.alt.offset(x, y) + 1;
        if (before[o] === f.alt.data[o]) continue;
        bare(x, y);
        // DIRS[0], then DIRS[2], then DIRS[1]: (x, y - 1), (x - 1, y - 1), (x - 1, y).
        let cx = x;
        let cy = y;
        for (const d of [DIRS[0]!, DIRS[2]!, DIRS[1]!]) {
          cx += d[0];
          cy += d[1];
          if (inside(cx, cy)) bare(cx, cy);
        }
        changed = true;
      }
    }
    if (changed) this.dirtyTileNeighborhood();
  }

  /** cDirtTool::SetTopAlt: a view tile's top corner (byte 1). */
  setTopAlt(pt: TilePt, alt: number): void {
    const a = this.world.getPackedAlt(pt.x, pt.y);
    a[1] = alt;
    this.world.setPackedAlt(pt.x, pt.y, a);
  }

  /** c2DArray::CopyFrom("altitude"): the scratch array takes the world's altitudes. */
  protected saveAltitudes(): Uint8Array {
    const s = DirtTool.scratch!;
    s.set(this.host.fixed.alt.data.subarray(0, s.length));
    return s;
  }

  /** c2DArray::CopyTo("altitude"): the world's altitudes come back from the scratch array. */
  protected restoreAltitudes(): void {
    const s = DirtTool.scratch!;
    this.host.fixed.alt.data.set(s);
  }

  /** GlobalDispatch(0x85): the terrain changed (cTerrain::DoCommand, max altitudes...). */
  protected terrainChanged(): void {
    this.host.dirty.terrain();
  }

  // --- the terrain cursor objects -----------------------------------------------

  /** +0x3c = -1: the next UpdateErrorMessage shows the error again. */
  protected resetErrorShown(): void {
    this.errShown = -1;
  }

  /** The error cursor's PickUp (vtable +0x58 on +0x48). */
  protected errorCursorPickUp(): void {
    this.errorCursor?.pickUp();
  }

  /** cDirtTool::PlaceTerrainCursor(cursor, view tile): at the tile's top corner, else picked up. */
  static placeTerrainCursor(host: ToolHost, c: TerrainCursor | null, x: number, y: number, level: number): void {
    if (!c) return;
    if (!host.world.inInterior(x, y)) {
      c.pickUp();
      return;
    }
    const [fx, fy] = RotatableWorld.rotateCoords(x << 4, y << 4, (4 - host.world.rotation) & 3, 0x400);
    if (c.canPlace(fx, fy, level)) c.place(fx, fy, level);
    else c.pickUp();
  }
}
