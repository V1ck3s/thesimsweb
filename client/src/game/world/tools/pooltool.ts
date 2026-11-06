/**
 * cPoolTool (tool 9, the Water panel's pool button) and cPoolUndoable;
 * cWaterTool (tool 10, the pond button) and cWaterUndoable, the same code on
 * the water layer: no deck, pool / deck tiles refuse water (0x13), any object
 * refuses removal (0x23), removals are free, price lbl_105BA5C4.
 *
 * While the tool is selected the world's pool layer is empty: the tool
 * keeps two copies, +0x3c the layer as of the last release ("original") and
 * +0x38 the preview, which HouseViewer draws instead
 * (HouseViewer::ApplyDynamicPoolLayer). Deselect writes the preview back
 * into the world and dispatches 0x91 (rooms / lighting rebuild).
 *
 * A gesture drags a world rectangle from the click tile (lbl_105BA520) to
 * the current one; every Drag restarts from the original layer, refunds the
 * previous count and adds (or, with Ctrl, removes) the whole rectangle
 * again, then rebuilds the deck (AddDeck). Adding costs lbl_105BA4C8 (the
 * catalog's pool price) per new tile; removing refunds
 * trunc(0.8 * price + 0.5) per tile (lbl_105BBE1C: 0.5, -0.8).
 *
 * Fields: +0x2c mode (0 add, 1 delete), +0x34 undoable, +0x38 preview,
 * +0x3c original, +0x40 rectangle (world, [min, max)), +0x48 tile count
 * (negative when deleting), +0x50 the click tile's packed altitude, +0x54
 * error (UIText STR# 137 entry - 1), +0x58 active, +0x59 button released.
 */

import { loadBuildCatalog } from "../../data/buildcatalog.js";
import { OBJ_TYPE_PERSON } from "../objselector.js";
import { addPool, clearDeck, POOL_DECK, POOL_NONE, removePool, type ByteLayer } from "../pools.js";
import { getOppositeSegment, getWall } from "../tilewalls.js";
import { ARRAY_SIZE, DIRS, type FixedWorld } from "../world.js";
import { Tool, type ToolEvent, type ToolHost } from "./tool.js";
import { Undoable } from "./undo.js";
import { makeMoneyString } from "../../res/langutil.js";
import { UI_LANGUAGE } from "../../res/uires.js";

/** lbl_105BBE20: the drag sounds. */
const SOUND_MOUSE_UP = "UI_bld_dragtool_mouseup";
const SOUND_MOUSE_DOWN = "UI_bld_dragtool_mousedown";

/** cMoveTool::ShowPlacementTip codes (UIText STR# 137, code - 1). */
const STR_PLACEMENT_ERRS = 137;
const TIP_DEFAULT = "Can't place here!";
const ERR_BOUNDS = 1;
const ERR_WALL = 7;
const ERR_OBJECT = 0xb;
const ERR_NOT_FLAT = 0x11;
const ERR_FUNDS = 0x15;
const ERR_FUNDS2 = 0x19;
const TIP_TOTAL = 0x1a;
const ERR_NOTHING_TO_ADD = 0x1b;
const ERR_NOTHING_TO_REMOVE = 0x1c;
const ERR_POOL_THERE = 0x13;
const ERR_WATER = 0x1d;
const ERR_WATER_OBJECT = 0x23;
const ERR_LEVEL = 0x1f;
const ERR_PERSON_IN_POOL = 0x2c;
const ERR_POOL_EQUIPMENT = 0x2d;

/** cDDDSimsView::SetToolCursor ids. */
const CURSOR_NORMAL = 0;
const CURSOR_DELETE = 6;

/** lbl_105BBE24: the four neighbor directions AllTilesPoolable checks for walls. */
const WALL_CHECK_DIRS = [0, 3, 2, 1];

/** OBJD build mode type 7 (pool equipment: ladders, diving boards). */
const BUILD_TYPE_POOL_EQUIPMENT = 7;

/**
 * lbl_105BA580 / lbl_105BA5BC: a cPoolTool / cWaterTool is selected (its
 * undoable writes into the tool instead of the world).
 */
const toolSelected = { pool: false, water: false };

/** A pool layer copy (cPoolLayer, 64 x 64 bytes, world coordinates). */
export class PoolLayer implements ByteLayer {
  readonly data = new Uint8Array(ARRAY_SIZE * ARRAY_SIZE).fill(POOL_NONE);

  u8(x: number, y: number): number {
    return this.data[x * ARRAY_SIZE + y]!;
  }

  /** cPoolLayer::operator= */
  assign(src: ByteLayer): void {
    this.data.set(src.data.subarray(0, this.data.length));
  }

  /** cPoolLayer::Clone */
  clone(): PoolLayer {
    const c = new PoolLayer();
    c.assign(this);
    return c;
  }
}

/** A world rectangle (CTileRect, level 1): [x0, x1) x [y0, y1). */
interface TileRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const EMPTY_RECT: TileRect = { x0: 0, y0: 0, x1: 0, y1: 0 };

function rectEmpty(r: TileRect): boolean {
  return !(r.x0 < r.x1 && r.y0 < r.y1);
}

function* rectTiles(r: TileRect): Generator<[number, number]> {
  for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) yield [x, y];
}

/** TileWalls::GetWallBetween(CTilePt::Dir): the segment of a tile facing a DIRS neighbor. */
function getWallBetween(dir: number): number {
  switch (dir) {
    case 0:
      return 2;
    case 1:
      return 8;
    case 2:
      return 1;
    case 3:
      return 4;
    case 4:
    case 5:
      return 0x20;
    default:
      return 0x10;
  }
}

/** The refund of `n` removed tiles (n < 0): (int)(-0.8 * n * price + 0.5). */
function removalValue(n: number, price: number): number {
  return Math.trunc(-0.8 * (n * price) + 0.5);
}

export class PoolTool extends Tool {
  /** +0x2c: 0 add, 1 delete (Ctrl). */
  private mode = 0;
  /** +0x34 */
  private undoable: PoolUndoable | null = null;
  /** +0x38 / +0x3c */
  readonly preview = new PoolLayer();
  readonly original = new PoolLayer();
  /** +0x40 */
  private rect: TileRect = { ...EMPTY_RECT };
  /** +0x48 */
  private count = 0;
  /** +0x50: the click (or hover) tile's packed altitude, null when outside. */
  private clickAlt: number | null = null;
  /** +0x54 */
  private error = 0;
  /** +0x58 / +0x59 */
  private active = false;
  private released = true;
  /** lbl_105BA520: the click point (view fixed point). */
  private anchor = { fx: 0, fy: 0 };
  /** lbl_105BA4C8 (pool) / lbl_105BA5C4 (water): price of a tile. */
  price: number;
  /** cDDDSimsView::SetToolCursor's last id. */
  toolCursor = CURSOR_NORMAL;
  /** The last mouse event (cTSWinMgrW95::PumpMouseMoveMsg replays it). */
  private lastEvent: ToolEvent | null = null;

  constructor(
    host: ToolHost,
    /** cWaterTool: the same tool on the water layer (no deck, free removals). */
    readonly water = false,
  ) {
    super(host);
    this.price = water ? 15 : 100;
    void loadBuildCatalog(host.ctx).then((c) => {
      const p = water ? c.prices.water : c.prices.pool;
      if (p > 0) this.price = p;
    });
  }

  private get fixed(): FixedWorld {
    return this.host.fixed;
  }

  /** cFixedWorld::GetPoolLayer / GetWaterLayer */
  private get worldLayer(): ByteLayer {
    return this.water ? this.fixed.water : this.fixed.pool;
  }

  private set selectedFlag(v: boolean) {
    if (this.water) toolSelected.water = v;
    else toolSelected.pool = v;
  }

  /** A pool tile (< 0x10) / a water tile (!= 0xff) of the preview. */
  private filled(x: number, y: number): boolean {
    const v = this.preview.u8(x, y);
    return this.water ? v !== POOL_NONE : v < 0x10;
  }

  private setViewerLayer(layer: ByteLayer | null): void {
    const v = this.host.viewer;
    if (this.water) {
      if (layer) v.applyDynamicWaterLayer(layer);
      else v.removeDynamicWaterLayer();
    } else if (layer) {
      v.applyDynamicPoolLayer(layer);
    } else {
      v.removeDynamicPoolLayer();
    }
  }

  // --- vtable -------------------------------------------------------------------

  /** cPoolTool::Select */
  override select(): void {
    this.selectedFlag = true;
    this.rect = { ...EMPTY_RECT };
    this.count = 0;
    this.original.assign(this.worldLayer);
    this.preview.assign(this.original);
    this.worldLayer.data.fill(POOL_NONE);
    this.setViewerLayer(this.preview);
    this.host.invalidate();
    this.active = true;
    // cWaterTool::Select shows the water cursor.
    if (this.water) this.showCursor(0x26);
  }

  /** cPoolTool::Deselect */
  override deselect(): void {
    this.selectedFlag = false;
    this.undoable = null;
    this.setViewerLayer(null);
    this.worldLayer.data.set(this.preview.data);
    this.host.invalidate();
    this.active = false;
    if (this.water) this.showCursor(0);
    // GlobalDispatch(0x91): rooms (pool rooms), cutaway and lighting.
    this.host.dirty.walls(1);
  }

  /** cPoolTool::Cancel */
  override cancel(): void {
    this.released = true;
    if (this.active) {
      this.preview.assign(this.original);
      this.active = false;
      this.host.invalidate();
    }
  }

  /** cPoolTool::OnExitWorld */
  override onExitWorld(): void {
    if (this.active) {
      this.preview.assign(this.original);
      this.active = false;
      this.host.invalidate();
    }
    this.host.resetTip();
  }

  /** cPoolTool::OnEnterWorld */
  override onEnterWorld(): void {
    if (this.released) {
      const ctrl = this.host.keys().ctrl;
      if (this.mode === 0 && ctrl) this.setMode(1);
      else if (this.mode === 1 && !ctrl) this.setMode(0);
    }
    if (!this.active) this.active = true;
  }

  /** cPoolTool::OnKeyDown: Ctrl switches to delete while the button is up. */
  override onKeyDown(key: string): boolean {
    if (key === "Control") {
      if (this.released && this.mode === 0) this.setMode(1);
      this.pumpMouseMove();
    }
    return false;
  }

  /** cPoolTool::OnKeyUp */
  override onKeyUp(key: string): boolean {
    if (key === "Control") {
      if (this.released && this.mode === 1) this.setMode(0);
      this.pumpMouseMove();
    }
    return false;
  }

  /** cPoolTool::Float: the one-tile preview under the cursor. */
  override float(e: ToolEvent): void {
    this.lastEvent = e;
    if (!this.active) return;
    this.error = 0;
    this.host.resetTip();
    const w = this.host.world;
    const x = e.fx >> 4;
    const y = e.fy >> 4;
    if (this.currentLevel() < 2) {
      if (!rectEmpty(this.rect)) this.preview.assign(this.original);
      if (!w.inInterior(x, y) || !w.inInterior(x + 1, y + 1)) {
        this.error = ERR_BOUNDS;
      } else {
        this.rect = this.worldRect(x, y, x, y);
        if (this.mode === 0) {
          this.clickAlt = this.packedAlt(x, y);
          if (!this.allTilesPoolable(this.rect)) {
            this.rect = { ...EMPTY_RECT };
          } else {
            const [wx, wy] = w.toWorld(x, y);
            if (this.filled(wx, wy)) {
              this.rect = { ...EMPTY_RECT };
            } else {
              this.anchor = { fx: e.fx, fy: e.fy };
              this.addPoolRect(this.rect);
              if (!this.water) this.addDeck(this.preview);
            }
          }
        } else if (!this.allTilesDepoolable(this.rect)) {
          this.rect = { ...EMPTY_RECT };
        } else {
          this.count = 0;
          const [wx, wy] = w.toWorld(x, y);
          if (this.filled(wx, wy)) removePool(this.preview, wx, wy);
        }
      }
    } else {
      this.error = ERR_LEVEL;
    }
    if (this.error === 0) {
      if (this.count !== 0 && this.mode === 0) this.showPlacementTip(TIP_TOTAL, this.price);
    } else {
      this.showPlacementTip(this.error);
    }
    this.count = 0;
    this.host.invalidate();
  }

  /** cPoolTool::Click */
  override click(e: ToolEvent): void {
    this.lastEvent = e;
    if (this.currentLevel() > 1) {
      this.error = ERR_LEVEL;
      this.showPlacementTip(ERR_LEVEL);
      return;
    }
    this.released = false;
    const w = this.host.world;
    const x = e.fx >> 4;
    const y = e.fy >> 4;
    if (!w.inInterior(x, y) || !w.inInterior(x + 1, y + 1)) {
      this.error = ERR_BOUNDS;
      this.showPlacementTip(ERR_BOUNDS);
      return;
    }
    this.rect = this.worldRect(x, y, x, y);
    if (this.mode === 0) {
      if (!this.allTilesPoolable(this.rect)) {
        this.count = 0;
        this.showPlacementTip(this.error);
        this.doDeniedSound();
        return;
      }
    } else if (!this.allTilesDepoolable(this.rect)) {
      this.count = 0;
      this.showPlacementTip(this.error);
      return;
    }
    this.anchor = { fx: e.fx, fy: e.fy };
    // The new undoable starts from the last done one's result, else from the original.
    let before: PoolLayer | null = null;
    if (this.undoable) {
      if (this.undoable.getState() === 1) before = this.undoable.after;
      this.undoable = null;
    }
    before ??= this.original.clone();
    this.undoable = new PoolUndoable(this, before);
    this.drag(e);
    if (this.count === 0 || this.mode === 1) return;
    this.host.playSound(SOUND_MOUSE_DOWN);
  }

  /** cPoolTool::Drag: the rectangle from the click tile to the current one. */
  override drag(e: ToolEvent): void {
    this.lastEvent = e;
    if (!this.active || this.released) return;
    this.error = 0;
    if (this.currentLevel() > 1) {
      this.error = ERR_LEVEL;
      this.showPlacementTip(ERR_LEVEL);
      return;
    }
    const w = this.host.world;
    const ax = this.anchor.fx >> 4;
    const ay = this.anchor.fy >> 4;
    let bx = e.fx >> 4;
    let by = e.fy >> 4;
    if (!w.inInterior(ax, ay) || !w.inInterior(bx, by)) {
      this.error = ERR_BOUNDS;
    } else {
      const x0 = Math.min(ax, bx);
      const y0 = Math.min(ay, by);
      bx = Math.max(ax, bx);
      by = Math.max(ay, by);
      // Take back what the previous Drag of this gesture charged.
      // (cWaterTool's removals are free: only additions are taken back.)
      if (this.count !== 0) {
        if (this.count > 0) this.refund(this.count * this.price);
        else if (!this.water) this.purchase(removalValue(this.count, this.price));
      }
      this.count = 0;
      this.preview.assign(this.original);
      this.rect = this.worldRect(x0, y0, bx, by);
      if (this.mode === 0) {
        if (!this.allTilesPoolable(this.rect)) {
          this.rect = { ...EMPTY_RECT };
          this.count = 0;
        } else if (this.count === 0) {
          this.error = ERR_NOTHING_TO_ADD;
        } else {
          this.addPoolRect(this.rect);
          this.purchase(this.count * this.price);
        }
      } else if (!this.allTilesDepoolable(this.rect)) {
        this.rect = { ...EMPTY_RECT };
        this.count = 0;
      } else if (this.count === 0) {
        this.error = ERR_NOTHING_TO_REMOVE;
      } else {
        for (const [tx, ty] of rectTiles(this.rect)) removePool(this.preview, tx, ty);
        if (!this.water) this.refund(removalValue(this.count, this.price));
        this.doExplodeSound();
      }
    }
    if (this.error === 0) {
      if (!this.water) this.addDeck(this.preview);
      if (this.mode === 0) this.showPlacementTip(TIP_TOTAL, this.count * this.price);
    } else {
      this.showPlacementTip(this.error);
    }
    this.host.invalidate();
  }

  /** cPoolTool::Release */
  override release(e: ToolEvent): void {
    this.released = true;
    this.host.resetTip();
    if (!this.active) return;
    // The virtual Drag returns at once now that the button is released.
    this.drag(e);
    if (this.count === 0) {
      this.undoable = null;
    } else {
      if (this.count > 1 && this.mode !== 1) this.host.playSound(SOUND_MOUSE_UP);
      if (this.undoable) {
        this.undoable.after = this.preview.clone();
        this.undoable.count = this.count;
        this.host.undo.submitUndoable(this.undoable);
      }
      this.original.assign(this.preview);
      this.rect = { ...EMPTY_RECT };
      this.count = 0;
      this.finalizePurchase();
      this.doKachingSound();
    }
    if (this.mode === 1 && !this.host.keys().ctrl) this.setMode(0);
  }

  // --- cPoolTool -----------------------------------------------------------------

  private setMode(mode: number): void {
    this.mode = mode;
    this.toolCursor = mode === 1 ? CURSOR_DELETE : CURSOR_NORMAL;
    this.showCursor(this.toolCursor);
  }

  /** cTSWinMgrW95::PumpMouseMoveMsg: the last mouse move again. */
  private pumpMouseMove(): void {
    if (this.lastEvent && this.released) this.float(this.lastEvent);
  }

  /** The view rectangle [x0, x1] x [y0, y1] (inclusive) as a world CTileRect. */
  private worldRect(x0: number, y0: number, x1: number, y1: number): TileRect {
    const w = this.host.world;
    const [ax, ay] = w.toWorld(x0, y0);
    const [bx, by] = w.toWorld(x1, y1);
    return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx) + 1, y1: Math.max(ay, by) + 1 };
  }

  /** The click tile's PackedAlt as one number (4 bytes), from a view tile. */
  private packedAlt(x: number, y: number): number {
    const [wx, wy] = this.host.world.toWorld(x, y);
    return this.worldAlt(wx, wy);
  }

  private worldAlt(wx: number, wy: number): number {
    const a = this.fixed.alt;
    const o = a.offset(wx, wy);
    return ((a.data[o]! << 24) | (a.data[o + 1]! << 16) | (a.data[o + 2]! << 8) | a.data[o + 3]!) >>> 0;
  }

  private static isFlat(alt: number): boolean {
    const b = alt & 0xff;
    return ((alt >>> 24) & 0xff) === b && ((alt >>> 16) & 0xff) === b && ((alt >>> 8) & 0xff) === b;
  }

  private inLot(x: number, y: number): boolean {
    const n = this.fixed.size - 1;
    return x >= 1 && x < n && y >= 1 && y < n;
  }

  /** cRotatableWorld::MayEditTile on a world tile (flag bit 5, lbl_105BA244 off). */
  private mayEdit(x: number, y: number): boolean {
    return this.host.placement.anywhere || (this.fixed.flags[0]!.u8(x, y) & 0x20) === 0;
  }

  /** cPoolLayer::AddPool(CTileRect) */
  private addPoolRect(r: TileRect): void {
    for (const [x, y] of rectTiles(r)) addPool(this.preview, x, y);
  }

  /** cPoolTool::AllTilesPoolable(CTileRect): sets the error and the count. */
  private allTilesPoolable(r: TileRect): boolean {
    if (!this.inLot(r.x0, r.y0) || !this.inLot(r.x1, r.y1)) {
      this.error = ERR_BOUNDS;
      return false;
    }
    this.error = 0;
    const click = this.clickAlt;
    if (click === null || !PoolTool.isFlat(click)) {
      this.error = ERR_NOT_FLAT;
      return false;
    }
    for (const [x, y] of rectTiles(r)) {
      if (!this.inLot(x, y) || !this.mayEdit(x, y)) {
        this.error = ERR_BOUNDS;
        return false;
      }
      if (this.worldAlt(x, y) !== click) {
        this.error = ERR_NOT_FLAT;
        return false;
      }
      // Objects in the way, except hidden ones and windows (cMoveTool::IsSelectorOfType 4).
      for (const obj of this.host.placement.tileObjects(x, y, 1)) {
        const objd = obj.selector.getMasterSelector().objd;
        // OBJD room sort (+0x4e) 0 and build mode type 2.
        const window = objd.i16(0x4e) === 0 && objd.buildModeType === 2;
        if (obj.hidden === 0 && !window) {
          this.error = ERR_OBJECT;
          return false;
        }
      }
      if (this.water) {
        if (this.fixed.pool.u8(x, y) <= POOL_DECK) {
          this.error = ERR_POOL_THERE;
          return false;
        }
      } else if (this.fixed.water.u8(x, y) !== POOL_NONE) {
        this.error = ERR_WATER;
        return false;
      }
      if (this.fixed.walls[0]!.data[this.fixed.walls[0]!.offset(x, y)] !== 0) {
        const segs = getWall(this.fixed, x, y, 1).segs;
        if (segs & 0x30) {
          this.error = ERR_WALL;
          return false;
        }
        for (const dir of WALL_CHECK_DIRS) {
          const [dx, dy] = DIRS[dir]!;
          const nx = x + dx;
          const ny = y + dy;
          const inRect = !rectEmpty(r) && nx >= r.x0 && nx < r.x1 && ny >= r.y0 && ny < r.y1;
          if (this.filled(nx, ny) || inRect) {
            const between = getWallBetween(dir);
            if ((between & segs) === between) {
              this.error = ERR_WALL;
              return false;
            }
          }
        }
      }
    }
    if (!this.canAffordRect(r)) {
      this.count = 0;
      this.error = ERR_FUNDS;
      return false;
    }
    return true;
  }

  /** cPoolTool::AllTilesDepoolable(CTileRect) */
  private allTilesDepoolable(r: TileRect): boolean {
    if (!this.inLot(r.x0, r.y0) || !this.inLot(r.x1, r.y1)) {
      this.error = ERR_BOUNDS;
      return false;
    }
    this.error = 0;
    const rooms = this.host.rooms;
    for (const [x, y] of rectTiles(r)) {
      if (!this.inLot(x, y) || !this.mayEdit(x, y)) {
        this.error = ERR_BOUNDS;
        return false;
      }
      if (!this.water && this.filled(x, y)) {
        const roomId = this.fixed.rooms[0]!.u16(x, y);
        if (roomId < 0xfffb && rooms && this.roomIsPool(roomId)) {
          // A person in that pool room (person +0x84: its room).
          for (const obj of this.host.placement.module.objects.values()) {
            if (obj.selector.objd.objectType !== OBJ_TYPE_PERSON || obj.level !== 1) continue;
            const px = obj.fx >> 4;
            const py = obj.fy >> 4;
            if (this.fixed.outOfGrid(px, py)) continue;
            if (this.fixed.rooms[0]!.u16(px, py) === roomId) {
              this.error = ERR_PERSON_IN_POOL;
              return false;
            }
          }
        }
      }
      for (const obj of this.host.placement.tileObjects(x, y, 1)) {
        if (obj.selector.getMasterSelector().objd.buildModeType === BUILD_TYPE_POOL_EQUIPMENT) {
          this.error = ERR_POOL_EQUIPMENT;
          return false;
        }
        // cWaterTool: any other object on the tile (only the tile's first one is looked at).
        if (this.water) {
          this.error = ERR_WATER_OBJECT;
          return false;
        }
      }
    }
    return this.canAffordRect(r);
  }

  /**
   * Room::IsPool: the room's tiles are pool tiles. While the tool is selected
   * the world's pool layer is empty, so the original's test only ever sees
   * pool rooms built before the tool was selected; the original layer is
   * what the world held then.
   */
  private roomIsPool(roomId: number): boolean {
    const room = this.host.rooms?.getRoom(roomId);
    const t = room?.tiles[0];
    return !!t && t.level === 1 && this.original.u8(t.x, t.y) < 0x10;
  }

  /** cPoolTool::CanAfford(CTileRect, int*): counts the tiles that change. */
  private canAffordRect(r: TileRect): boolean {
    this.count = 0;
    for (const [x, y] of rectTiles(r)) {
      if (this.mode === 0) {
        if (!this.filled(x, y)) this.count++;
      } else if (this.filled(x, y)) {
        this.count--;
      }
    }
    const cost = this.mode === 0 ? this.count * this.price : 0;
    const ok = super.canAfford(cost);
    if (!ok) this.error = ERR_FUNDS2;
    return ok;
  }

  /** cPoolTool::AddDeck(cPoolLayer*): deck tiles around every pool tile. */
  private addDeck(layer: PoolLayer): void {
    const size = this.fixed.size;
    clearDeck(layer, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (layer.u8(x, y) >= 0x10) continue;
        const done = [false, false, false, false, false, false, false, false];
        for (let dir = 0; dir < 8; dir++) {
          const [dx, dy] = DIRS[dir]!;
          const nx = x + dx;
          const ny = y + dy;
          if (this.fixed.outOfGrid(nx, ny)) continue;
          const v = layer.u8(nx, ny);
          if (v <= POOL_DECK) {
            done[dir] = true;
          } else if (this.canSupportDeck(nx, ny, dir, done)) {
            done[dir] = true;
            layer.data[nx * ARRAY_SIZE + ny] = POOL_DECK;
          }
        }
      }
    }
  }

  /** cPoolTool::CanSupportDeck(CTilePt, CTilePt::Dir, bool const*) */
  private canSupportDeck(x: number, y: number, dir: number, done: readonly boolean[]): boolean {
    if (!this.mayEdit(x, y)) return false;
    if (this.fixed.floors[0]!.u16(x, y) !== 0) return false;
    if (!PoolTool.isFlat(this.worldAlt(x, y))) return false;
    const segs = getWall(this.fixed, x, y, 1).segs;
    if (segs & 0x30) return false;
    const opp = getOppositeSegment(getWallBetween(dir));
    if (opp === 0x10) {
      if (dir === 7) return done[2]! && done[1]!;
      return done[0]! && done[3]!;
    }
    if (opp === 0x20) {
      if (dir === 4) return done[2]! && done[0]!;
      return done[1]! && done[3]!;
    }
    return (opp & segs) !== opp;
  }

  /** cMoveTool::ShowPlacementTip(code, amount): next to the mouse, 0 takes it away. */
  private showPlacementTip(code: number, amount = 0): void {
    if (code === 0) {
      this.host.resetTip();
      return;
    }
    let text = TIP_DEFAULT;
    if (code === TIP_TOTAL) text = makeMoneyString(amount, UI_LANGUAGE);
    else text = this.host.getString("UIText", STR_PLACEMENT_ERRS, code - 1) || text;
    const m = this.host.mouse();
    this.host.setTip(m.x + 0x11, m.y - 5, text);
  }

  // --- cPoolUndoable access ---------------------------------------------------------

  /** cPoolUndoable::UndoSelf / RedoSelf: a layer becomes current. */
  applyLayer(layer: PoolLayer): void {
    if (!(this.water ? toolSelected.water : toolSelected.pool)) {
      this.worldLayer.data.set(layer.data);
      this.host.invalidate();
      this.host.dirty.walls(1);
    } else {
      this.preview.assign(layer);
      this.original.assign(layer);
      this.host.invalidate();
    }
  }
}

/**
 * cPoolUndoable: +0x24 the layer before the gesture, +0x28 after, +0x2c the
 * tile count (negative for removals), +0x30 the tool.
 */
export class PoolUndoable extends Undoable {
  after: PoolLayer | null = null;
  count = 0;

  constructor(
    private readonly tool: PoolTool,
    readonly before: PoolLayer,
  ) {
    super();
  }

  protected commitSelf(): number {
    return 0;
  }

  /** cPoolUndoable::UndoSelf */
  protected undoSelf(): number {
    const t = this.tool;
    t.applyLayer(this.before);
    if (this.count === 0) {
      t.doKachingSound();
    } else {
      if (this.count > 0) t.refund(this.count * t.price);
      else if (!t.water) t.purchase(removalValue(this.count, t.price));
      t.finalizePurchase();
      t.doExplodeSound();
    }
    return 0;
  }

  /** cPoolUndoable::RedoSelf */
  protected override redoSelf(): number {
    const t = this.tool;
    if (!this.after) return 0;
    t.applyLayer(this.after);
    if (this.count === 0) {
      t.doExplodeSound();
    } else {
      if (this.count > 0) t.purchase(this.count * t.price);
      else if (!t.water) t.refund(removalValue(this.count, t.price));
      t.finalizePurchase();
      t.doKachingSound();
    }
    return 0;
  }
}

/** cWaterTool (tool 10). */
export class WaterTool extends PoolTool {
  constructor(host: ToolHost) {
    super(host, true);
  }
}
