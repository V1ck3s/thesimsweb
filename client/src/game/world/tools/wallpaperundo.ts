/**
 * WallpaperUndoable: the wall sides one cNewWallpaperTool gesture painted (a
 * vector of WallpaperChangePacket, 0x34 bytes each: the tile's world walls
 * before the first change and what the changes cost).
 *
 * ChangeTile paints one side of one segment of a view tile with the
 * undoable's wallpaper (+0x38), or takes the wallpaper off (pattern 0) in
 * the delete modes, and pays: the wallpaper's price
 * (WallGraphicsMgr::GetWallPatternCost), or a refund of
 * trunc(0.8 * old price + 0.5) (lbl_105BBE64). CanChangeTile says whether
 * that side can change (on the lot, editable, the segment exists, not the
 * same pattern, not a fence (error 0x2e), affordable). Reset takes the
 * gesture back off the world (UndoSelf) and forgets it.
 *
 * Fields: +0x24 the packets, +0x38 wallpaper, +0x3c the tool, +0x40 the last
 * CanChangeTile failed for money.
 */

import { getWall } from "../tilewalls.js";
import type { RotatableWorld } from "../world.js";
import { UndoState, Undoable } from "./undo.js";
import { fixedSetWall, getViewWall, mayEditTile, patternSlot, setViewWall, type RotWalls } from "./worldedit.js";

/** lbl_105BBE64: { -0.5f, 0.8f }. */
const REFUND = Math.fround(0.8);

/** cNewWallpaperTool::Mode: 0 paint, 1 delete (Ctrl), 2 room (Shift), 3 delete room (Shift + Ctrl). */
export const enum WallpaperMode {
  Paint = 0,
  Delete = 1,
  Room = 2,
  DeleteRoom = 3,
}

/** IsFenceStyle: picket fence, privacy fence, iron and Italian railings. */
function isFenceStyle(s: number): boolean {
  return s === 2 || s === 0xc || s === 0xd || s === 0xe;
}

/** WallpaperChangePacket. */
export interface WallpaperChangePacket {
  /** +0x00: world tile and level. */
  x: number;
  y: number;
  level: number;
  /** +0x04: the tile's walls (world coordinates). */
  walls: RotWalls;
  /** +0x30 */
  cost: number;
}

/** What WallpaperUndoable needs from its tool (+0x3c). */
export interface WallpaperUndoTool {
  purchase(n: number): void;
  refund(n: number): void;
  finalizePurchase(): void;
  canAfford(n: number): boolean;
  /** cTool::GetCurrentLevel (for WallManager::AsynchronousRefresh). */
  level(): number;
  /** WallManager::AsynchronousRefresh(level). */
  refreshWalls(level: number): void;
  /** cTool::DirtyTile */
  dirtyTile(): void;
  /** WallGraphicsMgr::GetWallPatternCost */
  wallPatternCost(pattern: number): number;
}

export class WallpaperUndoable extends Undoable {
  /** +0x24 */
  readonly changes: WallpaperChangePacket[] = [];
  /** +0x38 */
  private wallpaper = 0;
  /** +0x40 */
  private cannotAffordFlag = false;

  constructor(
    private readonly world: RotatableWorld,
    /** +0x3c */
    private readonly tool: WallpaperUndoTool,
  ) {
    super();
  }

  /** WallpaperUndoable::SetWallpaper */
  setWallpaper(p: number): void {
    this.wallpaper = p;
  }

  /** WallpaperUndoable::CannotAfford */
  cannotAfford(): boolean {
    return this.cannotAffordFlag;
  }

  /** WallpaperUndoable::Reset: the changes off the world and forgotten. */
  reset(): void {
    this.undoSelf();
    this.changes.length = 0;
    this.cannotAffordFlag = false;
  }

  /** The pattern a mode paints (the delete modes take the wallpaper off). */
  private patternFor(mode: number): number {
    return mode === WallpaperMode.Delete || mode === WallpaperMode.DeleteRoom ? 0 : this.wallpaper;
  }

  /**
   * WallpaperUndoable::CanChangeTile(view tile, mode, view segment, side,
   * error out): `err.code` gets 0x2e on a fence.
   */
  canChangeTile(x: number, y: number, level: number, mode: number, seg: number, side: number, err: { code: number } | null): boolean {
    if (err) err.code = 0;
    this.cannotAffordFlag = false;
    const w = this.world;
    if (!w.inInterior(x, y) || !mayEditTile(w, x, y)) return false;
    const vw = getViewWall(w, x, y, level);
    if (seg === 0 || (seg & vw.t.segs) !== seg) return false;
    const pattern = this.patternFor(mode);
    if (pattern === vw.t.patterns[patternSlot(seg, side)]) return false;
    if (isFenceStyle(vw.t.getStyle(seg))) {
      if (err) err.code = 0x2e;
      return false;
    }
    if (mode !== WallpaperMode.Delete && !this.tool.canAfford(this.tool.wallPatternCost(pattern))) {
      this.cannotAffordFlag = true;
      return false;
    }
    return true;
  }

  /** WallpaperUndoable::ChangeTile(view tile, mode, view segment, side). */
  changeTile(x: number, y: number, level: number, mode: number, seg: number, side: number): void {
    const w = this.world;
    const vw = getViewWall(w, x, y, level);
    const slot = patternSlot(seg, side);
    const pattern = this.patternFor(mode);
    const old = vw.t.patterns[slot]!;
    if (old === pattern) return;
    let cost: number;
    if (mode === WallpaperMode.Delete || mode === WallpaperMode.DeleteRoom) {
      cost = Math.trunc(-Math.fround(Math.fround(REFUND * Math.fround(this.tool.wallPatternCost(old))) + 0.5));
    } else {
      cost = this.tool.wallPatternCost(pattern);
    }
    this.aboutToChange(x, y, level, cost);
    vw.t.patterns[slot] = pattern;
    setViewWall(w, x, y, level, vw);
    this.tool.dirtyTile();
    this.tool.purchase(cost);
  }

  /** WallpaperUndoable::AboutToChange: the tile's world walls, once per gesture; later changes add their cost. */
  private aboutToChange(x: number, y: number, level: number, cost: number): void {
    const [wx, wy] = this.world.toWorld(x, y);
    const c = this.changes.find((p) => p.x === wx && p.y === wy && p.level === level);
    if (c) {
      c.cost += cost;
      return;
    }
    this.changes.push({ x: wx, y: wy, level, walls: { t: getWall(this.world.fixed, wx, wy, level), rot: 0 }, cost });
  }

  /** WallpaperUndoable::UndoOne: swap the packet's walls with the world's. */
  private undoOne(p: WallpaperChangePacket): void {
    const fixed = this.world.fixed;
    const cur = getWall(fixed, p.x, p.y, p.level);
    fixedSetWall(fixed, p.x, p.y, p.level, p.walls);
    this.tool.dirtyTile();
    p.walls = { t: cur, rot: 0 };
  }

  /** WallpaperUndoable::RedoSelf */
  protected override redoSelf(): number {
    for (const p of this.changes) {
      this.undoOne(p);
      this.tool.purchase(p.cost);
    }
    if (this.getState() !== UndoState.New) this.tool.finalizePurchase();
    this.tool.refreshWalls(this.tool.level());
    return 0;
  }

  /** WallpaperUndoable::UndoSelf */
  protected override undoSelf(): number {
    for (let i = this.changes.length - 1; i >= 0; i--) {
      const p = this.changes[i]!;
      this.undoOne(p);
      this.tool.refund(p.cost);
    }
    if (this.getState() !== UndoState.New) this.tool.finalizePurchase();
    this.tool.refreshWalls(this.tool.level());
    return 0;
  }

  /** Undoable::CommitSelf */
  protected commitSelf(): number {
    return 0;
  }
}
