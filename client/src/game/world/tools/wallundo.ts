/**
 * WallUndoable: one wall tool gesture (a line, a rectangle or a deletion).
 *
 * The preview is the world itself: the undoable keeps a copy of the level's
 * wall records (+0 .. +0xe000, taken by Reset); every drag restores it
 * (Reset -> UndoSelf), then DoLine / DoRectangle write the new walls tile by
 * tile (ChangeTile -> cRotatableWorld::SetWall) and the wall manager
 * rebuilds. UndoSelf / RedoSelf swap the copy with the world, so the copy
 * always holds the other state.
 *
 * Everything is in view coordinates (cRotatableWorld): vertices are CTilePts
 * of grid points, a line walks tiles in a CTilePt::Dir (lbl_105BA078):
 *   0 (0,-1)  1 (0,1)  2 (-1,0)  3 (1,0)  4 (-1,-1)  5 (1,1)  6 (1,-1)  7 (-1,1), 8 none,
 * touching segment 0x01 for dirs 0 / 1, 0x02 for 2 / 3, 0x20 for 4 / 5 and
 * 0x10 for 6 / 7.
 *
 * Fields: +0xe024 dirty, +0xe028 cost, +0xe02c origin vertex (+0xe02f its
 * altitude), +0xe030 end vertex, +0xe034 direction, +0xe038 style, +0xe03c
 * pattern, +0xe040 mode, +0xe044 tool, +0xe048 / +0xe04b last good end and
 * start, +0xe050 / +0xe054 explosions / explosion sounds played, +0xe060
 * cannot afford, +0xe064 error (UIText STR# 137 "PlacementErrs").
 */

import { OD, type XObject } from "../objects.js";
import { OBJ_TYPE_PERSON, OBJ_TYPE_PORTAL } from "../objselector.js";
import { getAdjacentTile, getOppositeSegment, getWall, SEG_HORIZ, SEG_ROTATION, SEG_VERT, segIndex, type TileWalls } from "../tilewalls.js";
import { ARRAY_SIZE, DIRS, type TilePt } from "../world.js";
import { ObjectAction, ObjectUndoable } from "./objectundo.js";
import { ODX } from "./placement.js";
import type { Tool, ToolHost } from "./tool.js";
import { Undoable, UndoState } from "./undo.js";
import {
  frontSlot,
  getViewWall,
  mayEditTile,
  patternSlot,
  readWallRecord,
  setFixedWall,
  setViewFloor,
  setViewWall,
  WALL_RECORD,
  writeWallRecord,
} from "./wallworld.js";

/** cNewWallTool::Mode */
export const WallMode = { Draw: 0, Delete: 1, Rect: 2 } as const;

export const DIR_NONE = 8;

/** What the undoable needs from its tool (WallUndoable +0xe044). */
export interface WallToolLink {
  readonly host: ToolHost;
  readonly tool: Tool;
  /** lbl_105BA4CC[style]: the price of a wall segment. */
  price(style: number): number;
  /** cTool vtable +0x6c (cNewWallTool::CannotAfford). */
  cannotAfford(): boolean;
}

/** Fences: no flat ground needed, a pattern of their own on both sides (CleanupWallpaper). */
export function isFence(style: number): boolean {
  return style === 2 || style === 0xc || style === 0xd || style === 0xe;
}

/** cNewWallTool::SetParameter / CleanupWallpaper: the pattern of a fence style. */
export function fencePattern(style: number): number {
  return style === 0xc ? 0xf9 : style === 0xd ? 0xfa : style === 0xe ? 0xfb : 0xf8;
}

/** Wall styles of door / window walls (ChangeTile kills the object first). */
function isArchStyle(s: number): boolean {
  return s === 3 || s === 5 || s === 6 || s === 0xf || s === 0x17 || s === 0x16;
}

/** The segment a direction walks along. */
export function dirSeg(dir: number): number {
  if (dir < 0) return 0;
  if (dir < 2) return 0x01;
  if (dir < 4) return 0x02;
  if (dir < 6) return SEG_VERT;
  if (dir < 8) return SEG_HORIZ;
  return 0;
}

const pt = (x: number, y: number, level: number): TilePt => ({ x, y, level });
const same = (a: TilePt, b: TilePt): boolean => a.x === b.x && a.y === b.y && a.level === b.level;
const step = (p: TilePt, d: number, k = 1): TilePt => pt(p.x + DIRS[d]![0] * k, p.y + DIRS[d]![1] * k, p.level);

/** WallUndoable::NextTile */
export function nextTile(t: TilePt, dir: number): TilePt {
  return step(t, dir);
}

/** WallUndoable::VertexToTile (jump table lbl_105BBE68): the tile whose segment starts at the vertex. */
export function vertexToTile(v: TilePt, dir: number): TilePt {
  if (dir === 0 || dir === 2 || dir === 4) return step(v, dir);
  if (dir === 6) return step(v, 0);
  if (dir === 7) return step(v, 2);
  return { ...v };
}

/** WallUndoable::TileToVertex (lbl_105BBE6C): the inverse. */
export function tileToVertex(t: TilePt, dir: number): TilePt {
  if (dir === 0 || dir === 2 || dir === 4) return step(t, dir, -1);
  if (dir === 6) return step(t, 0, -1);
  if (dir === 7) return step(t, 2, -1);
  return { ...t };
}

/** WallUndoable::GetDirection: the line direction closest to from -> to (8 when equal). */
export function getDirection(from: TilePt, to: TilePt): number {
  if (same(from, to)) return DIR_NONE;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const ad = Math.trunc(Math.abs(to.x - to.y - (from.x - from.y)) / 2);
  const as = Math.trunc(Math.abs(to.x + to.y - (from.x + from.y)) / 2);
  if (ax < ay && ax <= ad && ax <= as) return dy < 0 ? 0 : 1;
  if (ay < ax && ay <= ad && ay <= as) return dx < 0 ? 2 : 3;
  if (ad < ax && ad < ay && ad < as) return to.x + to.y < from.x + from.y ? 4 : 5;
  return to.x - to.y < from.x - from.y ? 7 : 6;
}

/** WallUndoable::SnapToLine: `to` moved onto the line from `from` in `dir` (collapsed onto `from` when behind it). */
export function snapToLine(from: TilePt, to: TilePt, dir: number): TilePt {
  let x = to.x;
  let y = to.y;
  const dx = x - from.x;
  const dy = y - from.y;
  const add = (d: number, k = 1): void => {
    x += DIRS[d]![0] * k;
    y += DIRS[d]![1] * k;
  };
  if (dir === 0 || dir === 1) {
    x = from.x;
    if ((dy > 0 && dir === 0) || (dy < 0 && dir === 1)) y = from.y;
  } else if (dir === 2 || dir === 3) {
    y = from.y;
    if ((dx < 0 && dir === 3) || (dx > 0 && dir === 2)) x = from.x;
  } else if (dir === 4 || dir === 5) {
    const fd = from.x - from.y;
    const fs = from.x + from.y;
    if (((x - y) & 1) !== (fd & 1)) {
      if (x - y < fd) {
        if (fs < x + y) add(1);
        else if (x + y < fs) add(2);
      } else if (fs < x + y) add(3);
      else if (x + y < fs) add(0);
    }
    const k = Math.trunc(Math.abs(x - y - fd) / 2);
    if (k !== 0) add(x - y < fd ? 6 : 7, k);
    if ((fs < x + y && dir === 4) || (x + y < fs && dir === 5)) {
      x = from.x;
      y = from.y;
    }
  } else if (dir === 6 || dir === 7) {
    const fd = from.x - from.y;
    const fs = from.x + from.y;
    if (((x + y) & 1) !== (fs & 1)) {
      if (x + y < fs) {
        if (fd < x - y) add(0);
        else if (x - y < fd) add(2);
      } else if (fd < x - y) add(3);
      else if (x - y < fd) add(1);
    }
    const k = Math.trunc(Math.abs(x + y - fs) / 2);
    if (k !== 0) add(x + y < fs ? 5 : 4, k);
    if ((x - y < fd && dir === 6) || (fd < x - y && dir === 7)) {
      x = from.x;
      y = from.y;
    }
  }
  return pt(x, y, from.level);
}

/** DoRectangle's turn after each side (jump tables lbl_105BBE78 / 74 / 70). */
const TURN = [2, 3, 1, 0, 7, 6, 4, 5];

export class WallUndoable extends Undoable {
  /** +0 .. +0xe000: the level's wall records (world coordinates). */
  private readonly backup = new Uint8Array(ARRAY_SIZE * ARRAY_SIZE * WALL_RECORD);
  /** +0xe024 */
  dirty = false;
  /** +0xe028 */
  cost = 0;
  /** +0xe02c / +0xe02f */
  origin: TilePt = pt(0, 0, 0);
  private originAlt = 0;
  /** +0xe030 */
  end: TilePt = pt(0, 0, 0);
  /** +0xe034 */
  dir = DIR_NONE;
  /** +0xe038 / +0xe03c */
  style = 0;
  pattern = 0;
  /** +0xe040 */
  mode: number = WallMode.Draw;
  /** +0xe048 / +0xe04b */
  private lastEnd: TilePt = pt(0, 0, 0);
  private lastStart: TilePt = pt(0, 0, 0);
  /** +0xe050 / +0xe054 */
  private explosions = 0;
  private explosionsPlayed = 0;
  /** +0xe060 */
  cannotAfford = false;
  /** +0xe064 */
  error = 0;

  constructor(private readonly link: WallToolLink) {
    super();
  }

  private get host(): ToolHost {
    return this.link.host;
  }

  private setError(code: number): void {
    if (this.error === 0) this.error = code;
  }

  // --- Undoable ----------------------------------------------------------------------

  /** The changes are in the world already. */
  protected commitSelf(): number {
    return 0;
  }

  /** Swaps the backup with the world's records that differ. */
  private swap(): void {
    const level = this.origin.level;
    if (level < 1 || level > 2) return;
    const f = this.host.fixed;
    const cur = new Uint8Array(WALL_RECORD);
    for (let x = 0; x < f.size; x++) {
      for (let y = 0; y < f.size; y++) {
        const o = (x * ARRAY_SIZE + y) * WALL_RECORD;
        readWallRecord(f, x, y, level, cur);
        let diff = false;
        for (let k = 0; k < WALL_RECORD; k++) {
          if (cur[k] !== this.backup[o + k]) {
            diff = true;
            break;
          }
        }
        if (!diff) continue;
        writeWallRecord(f, x, y, level, this.backup, o);
        this.backup.set(cur, o);
      }
    }
  }

  /**
   * GlobalDispatch(0x91, 0): ComputeRooms on every level (the level above
   * walls takes its floorable tiles from them), the changed level first.
   */
  private recomputeRooms(): void {
    const level = this.origin.level;
    this.host.dirty.walls(level);
    this.host.dirty.walls(level === 1 ? 2 : 1);
  }

  /** WallUndoable::UndoSelf */
  protected undoSelf(): number {
    if (this.state === UndoState.New && !this.dirty) return 0;
    if (this.undoPreSubs()) return 1;
    this.swap();
    this.link.tool.refund(this.cost);
    if (this.state !== UndoState.New || this.link.cannotAfford()) {
      this.link.tool.finalizePurchase();
      this.recomputeRooms();
    }
    return this.undoPostSubs() ? 1 : 0;
  }

  /** WallUndoable::RedoSelf */
  protected override redoSelf(): number {
    if (this.state === UndoState.New && !this.dirty) return 0;
    if (this.redoPostSubs()) return 1;
    this.swap();
    const r = this.redoPreSubs() ? 1 : 0;
    this.link.tool.purchase(this.cost);
    if (this.state !== UndoState.New) {
      this.link.tool.finalizePurchase();
      this.recomputeRooms();
    }
    return r;
  }

  // --- gesture state -----------------------------------------------------------------

  /** WallUndoable::Reset: the preview undone, then a fresh copy of the level's walls. */
  reset(): void {
    if (this.dirty) this.undoSelf();
    this.freeSubUndoables();
    this.cost = 0;
    this.dirty = false;
    this.explosions = 0;
    const level = this.origin.level;
    if (level < 1 || level > 2) return;
    const f = this.host.fixed;
    for (let x = 0; x < f.size; x++) for (let y = 0; y < f.size; y++) readWallRecord(f, x, y, level, this.backup, (x * ARRAY_SIZE + y) * WALL_RECORD);
  }

  /** WallUndoable::ResetAll */
  resetAll(): void {
    this.reset();
    this.end = { ...this.origin };
    this.dir = DIR_NONE;
    this.cannotAfford = false;
    this.error = 0;
  }

  /** WallUndoable::SetOriginVertex */
  setOriginVertex(v: TilePt): void {
    this.origin = { ...v };
    this.lastEnd = { ...v };
    this.lastStart = { ...v };
    this.originAlt = this.host.world.getPackedAlt(v.x, v.y)[1];
    this.reset();
    this.end = { ...this.origin };
    this.dir = DIR_NONE;
    this.cannotAfford = false;
    this.explosionsPlayed = 0;
    this.error = 0;
  }

  /** WallUndoable::SetWallType */
  setWallType(style: number, pattern: number): void {
    this.style = style;
    this.pattern = pattern;
  }

  /** WallUndoable::ComputeArtificialDragPoint: the next vertex in the screen direction of the drag (dh, dv). */
  computeArtificialDragPoint(v: TilePt, dh: number, dv: number): TilePt {
    if (dh === 0 && dv === 0) return { ...v };
    let d: number;
    if (dh === 0) {
      d = dv < 1 ? 4 : 5;
    } else {
      // lbl_105BBE80 +8 / +0xc / +0x10: 3, 0.125, -3 (times pi).
      const a = Math.fround(Math.atan(dv / dh));
      const k = Math.PI * 0.125;
      if (a > 3 * k) d = 5;
      else if (a > k) d = dh < 0 ? 2 : 3;
      else if (a > -k) d = dh < 1 ? 7 : 6;
      else if (a > -3 * k) d = dh < 1 ? 1 : 0;
      else d = dv < 1 ? 4 : 5;
    }
    return step(v, d);
  }

  /** WallUndoable::AdjustEndpointVertex: the line (or rectangle) from the origin to `v`. */
  adjustEndpointVertex(v: TilePt): void {
    const collapse = (): void => {
      this.reset();
      this.end = { ...this.origin };
      this.dir = DIR_NONE;
      this.cannotAfford = false;
      this.error = 0;
    };
    if (this.mode === WallMode.Draw || this.mode === WallMode.Delete) {
      if (this.dir === DIR_NONE) {
        this.dir = getDirection(this.origin, v);
        if (this.dir === DIR_NONE) {
          collapse();
          this.explosionsPlayed = 0;
          return;
        }
      }
      const to = snapToLine(this.origin, v, this.dir);
      if (same(this.origin, to)) {
        collapse();
        this.explosionsPlayed = 0;
        return;
      }
      this.reset();
      const out = this.doLine(this.origin, to, this.dir, this.mode);
      if (!out) {
        this.link.tool.doDeniedSound();
        if (this.cannotAfford) {
          if (same(this.origin, this.lastStart)) this.lastStart = { ...to };
          this.end = { ...this.lastStart };
        } else {
          this.end = { ...this.lastEnd };
          this.lastStart = { ...this.origin };
        }
      } else {
        this.end = { ...to };
        this.lastEnd = { ...to };
        this.lastStart = { ...this.origin };
        while (this.explosionsPlayed < this.explosions) {
          this.link.tool.doExplodeSound();
          this.explosionsPlayed++;
        }
      }
    } else if (this.mode === WallMode.Rect) {
      if (same(this.origin, v)) {
        collapse();
        return;
      }
      if (same(this.end, v)) return;
      this.reset();
      const r = this.doRectangle(this.origin, v);
      if (!r) {
        this.link.tool.doDeniedSound();
        this.reset();
        this.end = { ...v };
        const afford = this.cannotAfford;
        this.doRectangle(this.origin, this.lastEnd);
        this.cannotAfford = afford;
        if (same(this.origin, this.lastStart)) this.lastStart = { ...v };
        this.end = { ...this.lastStart };
      } else {
        this.end = { ...r };
        this.lastEnd = { ...r };
        this.lastStart = { ...this.origin };
      }
    }
  }

  /** WallUndoable::DoRectangle: four lines around the box of a and b (a line when they share a row). Returns the far corner. */
  doRectangle(a: TilePt, b: TilePt): TilePt | null {
    if (a.x === b.x || a.y === b.y) return this.doLine(a, b, getDirection(a, b), WallMode.Draw);
    const start = { ...a };
    let c1: TilePt;
    let c3: TilePt;
    let d: number;
    if (a.x < b.x) {
      if (a.y < b.y) {
        c1 = pt(a.x, b.y, b.level);
        c3 = pt(b.x, a.y, b.level);
        d = 1;
      } else {
        c1 = pt(b.x, a.y, b.level);
        c3 = pt(a.x, b.y, b.level);
        d = 3;
      }
    } else if (a.y < b.y) {
      c1 = pt(b.x, a.y, b.level);
      c3 = pt(a.x, b.y, b.level);
      d = 2;
    } else {
      c1 = pt(a.x, b.y, b.level);
      c3 = pt(b.x, a.y, b.level);
      d = 0;
    }
    const s1 = this.doLine(start, c1, d, WallMode.Draw);
    if (!s1) return null;
    d = TURN[d]!;
    let c2 = snapToLine(s1, b, d);
    const s2 = this.doLine(s1, c2, d, WallMode.Draw);
    if (!s2) return null;
    c2 = s2;
    d = TURN[d]!;
    c3 = snapToLine(c2, c3, d);
    const s3 = this.doLine(c2, c3, d, WallMode.Draw);
    if (!s3) return null;
    d = TURN[d]!;
    const back = snapToLine(s3, start, d);
    if (!this.doLine(s3, back, d, WallMode.Draw)) return null;
    return c2;
  }

  /** WallUndoable::DoLine: every tile from `from` to `to`; the vertex reached, or null when a tile is refused. */
  doLine(from: TilePt, to: TilePt, dir: number, mode: number): TilePt | null {
    let t = vertexToTile(from, dir);
    const e = vertexToTile(to, dir);
    for (let guard = 0; !same(t, e) && guard < 256; guard++) {
      if (!this.canChangeTile(t, mode, dir)) return null;
      this.changeTile(t, mode, dir);
      t = nextTile(t, dir);
    }
    return tileToVertex(t, dir);
  }

  // --- tile tests ----------------------------------------------------------------------

  /** ObjectIterator on a view tile. */
  private objectsAt(t: TilePt): XObject[] {
    const [wx, wy] = this.host.world.toWorld(t.x, t.y);
    return [...this.host.placement.tileObjects(wx, wy, t.level)];
  }

  /** A view segment seen from an object (the rotation index of lbl_105BA24C). */
  private objectSeg(obj: XObject, seg: number): number {
    const r = ((((8 - obj.dir) >> 1) & 3) - this.host.world.rotation) & 3;
    return SEG_ROTATION[r]![seg]!;
  }

  /** Wall placement flags 0x100..0x800: no wall on that side of the object. */
  private blocksWall(obj: XObject, seg: number): boolean {
    const s = this.objectSeg(obj, seg);
    const f = obj.wallPlacementFlags;
    return (s === 1 && (f & 0x800) !== 0) || (s === 8 && (f & 0x400) !== 0) || (s === 2 && (f & 0x100) !== 0) || (s === 4 && (f & 0x200) !== 0);
  }

  /** Wall placement flags 1..8: the object hangs on that wall. */
  private hangsOn(obj: XObject, seg: number): boolean {
    const s = this.objectSeg(obj, seg);
    const f = obj.wallPlacementFlags;
    return (s === 1 && (f & 8) !== 0) || (s === 8 && (f & 4) !== 0) || (s === 2 && (f & 1) !== 0) || (s === 4 && (f & 2) !== 0);
  }

  private interior(t: TilePt): boolean {
    return this.host.world.inInterior(t.x, t.y);
  }

  private mayEdit(t: TilePt): boolean {
    return mayEditTile(this.host.world, t.x, t.y, t.level, this.host.placement.anywhere);
  }

  /** WallUndoable::LegalWallTile: editable tiles on both sides, nobody there, nothing in use. */
  legalWallTile(t: TilePt, seg: number): boolean {
    if (seg === 0) {
      if (!this.interior(t) || !this.mayEdit(t)) {
        this.setError(1);
        return false;
      }
      return true;
    }
    const [ax, ay] = getAdjacentTile(seg, t.x, t.y);
    const adj = pt(ax, ay, t.level);
    if (!this.interior(t) || !this.interior(adj)) {
      this.setError(1);
      return false;
    }
    if (!this.mayEdit(t) || !this.mayEdit(adj)) {
      this.setError(1);
      return false;
    }
    for (const tile of same(t, adj) ? [t] : [t, adj]) {
      for (const obj of this.objectsAt(tile)) {
        if (obj.objectData[OD.hidden] !== 0) continue;
        if (obj.selector.objd.objectType === OBJ_TYPE_PERSON || this.host.placement.chain(obj).some((o) => (o.objectData[ODX.useCount] ?? 0) > 0)) {
          this.setError(0xb);
          return false;
        }
      }
    }
    return true;
  }

  /** WallUndoable::FlatTile: the tile (and the one across an ortho segment) flat at the origin's altitude. */
  private flatTile(t: TilePt, seg: number): boolean {
    const flat = (x: number, y: number): boolean => {
      const a = this.host.world.getPackedAlt(x, y);
      return a[1] === this.originAlt && a[0] === a[1] && a[2] === a[1] && a[3] === a[1];
    };
    if (!flat(t.x, t.y)) {
      this.setError(0x11);
      return false;
    }
    if (seg === SEG_HORIZ || seg === SEG_VERT) return true;
    const [ax, ay] = getAdjacentTile(seg, t.x, t.y);
    if (!flat(ax, ay)) {
      this.setError(0x11);
      return false;
    }
    return true;
  }

  /** TileWalls::CanAdd: diagonals stand alone; no ortho segment against a diagonal tile. */
  private canAdd(w: TileWalls, t: TilePt, seg: number): boolean {
    const all = w.segs | seg;
    if ((all & SEG_HORIZ && all !== SEG_HORIZ) || (all & SEG_VERT && all !== SEG_VERT)) return false;
    if (seg & 0x0f) {
      const [ax, ay] = getAdjacentTile(seg, t.x, t.y);
      if (this.interior(pt(ax, ay, t.level)) && getViewWall(this.host.world, ax, ay, t.level).segs & 0x30) return false;
    }
    return true;
  }

  /** The diagonal-against-vertex conflicts of CanChangeTile (no error code). */
  private diagonalConflict(t: TilePt, seg: number): boolean {
    const has = (dx: number, dy: number, bits: number): boolean => {
      const n = pt(t.x + dx, t.y + dy, t.level);
      return this.interior(n) && (getViewWall(this.host.world, n.x, n.y, n.level).segs & bits) !== 0;
    };
    switch (seg) {
      case SEG_HORIZ:
        return has(-1, -1, 0x0c) || has(1, 1, 0x03);
      case 0x02:
        return has(-1, -1, SEG_HORIZ) || has(1, 0, SEG_HORIZ) || has(-1, 0, SEG_VERT) || has(1, -1, SEG_VERT);
      case 0x01:
        return has(-1, -1, SEG_HORIZ) || has(0, 1, SEG_HORIZ) || has(0, -1, SEG_VERT) || has(-1, 1, SEG_VERT);
      case SEG_VERT:
        return has(-1, 1, 0x06) || has(1, -1, 0x09);
      default:
        return false;
    }
  }

  /** The tile across an ortho segment, as CanChangeTile walks it (0x01: (-1, 0), 0x02: (0, -1)). */
  private across(t: TilePt, seg: number): TilePt {
    return seg === 0x01 ? step(t, 2) : step(t, 0);
  }

  /** WallUndoable::CanChangeTile */
  canChangeTile(t: TilePt, mode: number, dir: number): boolean {
    const seg = dirSeg(dir);
    const world = this.host.world;
    const w = getViewWall(world, t.x, t.y, t.level);
    const p = this.host.placement;
    if (mode === WallMode.Delete) {
      if ((w.segs & seg) !== seg) return false;
      if (seg !== 0x01 && seg !== 0x02) return true;
      for (const obj of this.objectsAt(t)) {
        const type = obj.selector.objd.objectType;
        if (type === OBJ_TYPE_PORTAL && !p.userCanDelete(obj)) {
          this.setError(0x23);
          return false;
        }
        if (type !== OBJ_TYPE_PORTAL && type !== OBJ_TYPE_PERSON && this.hangsOn(obj, seg)) {
          this.setError(0xb);
          return false;
        }
      }
      const opp = SEG_ROTATION[2]![seg]!;
      for (const obj of this.objectsAt(this.across(t, seg))) {
        const type = obj.selector.objd.objectType;
        if (type !== OBJ_TYPE_PORTAL && type !== OBJ_TYPE_PERSON && this.hangsOn(obj, opp)) {
          this.setError(0xb);
          return false;
        }
      }
      return true;
    }
    if (mode !== WallMode.Draw) return false;
    if (!this.legalWallTile(t, seg)) return false;
    const fence = isFence(this.style);
    if (!fence && !this.flatTile(t, seg)) return false;
    if (!this.mayEdit(t)) return false;
    let ok = this.canAdd(w, t, seg);
    if (ok && !(world.getFlags(t.x, t.y, t.level) & 1) && (!fence || this.currentLevel() !== 1)) {
      if (seg === SEG_HORIZ || seg === SEG_VERT) {
        this.setError(0x20);
        ok = false;
      } else {
        const a = this.across(t, seg);
        if (!(world.getFlags(a.x, a.y, a.level) & 1)) {
          this.setError(0x20);
          ok = false;
        }
      }
    }
    if (ok) {
      if (seg === 0x01 || seg === 0x02) {
        for (const obj of this.objectsAt(t)) {
          if (obj.selector.objd.objectType !== OBJ_TYPE_PERSON && this.blocksWall(obj, seg)) {
            this.setError(0xb);
            ok = false;
            break;
          }
        }
        if (ok) {
          const a = this.across(t, seg);
          const opp = SEG_ROTATION[2]![seg]!;
          for (const obj of this.objectsAt(a)) {
            if (obj.selector.objd.objectType !== OBJ_TYPE_PERSON && this.blocksWall(obj, opp)) {
              this.setError(0xb);
              ok = false;
              break;
            }
          }
          if (ok && world.hasPool(t.x, t.y, t.level) && world.hasPool(a.x, a.y, a.level)) {
            this.setError(0x1d);
            ok = false;
          }
        }
      } else {
        // Diagonals: no object at all on the tile (type 9 aside).
        for (const obj of this.objectsAt(t)) {
          if (obj.selector.objd.objectType !== 9) {
            this.setError(0xb);
            ok = false;
            break;
          }
        }
        if (ok && world.hasPool(t.x, t.y, t.level)) {
          this.setError(0x1d);
          ok = false;
        }
      }
    }
    if (ok && this.diagonalConflict(t, seg)) ok = false;
    if (ok && (w.segs & seg) !== seg) {
      if (!this.link.tool.canAfford(this.link.price(this.style))) {
        this.cannotAfford = true;
        ok = false;
      } else {
        this.cannotAfford = false;
      }
    }
    return ok;
  }

  private currentLevel(): number {
    return this.host.viewer.level || 1;
  }

  /**
   * WallUndoable::KillArchitecturalObject (1018d450): the door / window on
   * the segment gets an ObjectUndoable(id, 3 = delete, 0, tool +0xe044) as a
   * sub-undoable (post in delete mode, pre otherwise), then Pickup(true): it
   * only leaves the world. Its undo puts the same object back
   * (ObjectState::CreateObject finds it alive, InvokeOntoObject); it is
   * killed when the undoable goes (ObjectState::RemoveEntry). The refund is
   * 0.5 + 0.8 x its value; null when there is no such object.
   */
  private killArchitecturalObject(t: TilePt, seg: number): number | null {
    const p = this.host.placement;
    const found = this.objectsAt(t).find((o) => o.selector.objd.objectType === OBJ_TYPE_PORTAL && this.hangsOn(o, seg));
    if (!found) return null;
    const refund = Math.trunc(Math.fround(0.8) * p.getCurrentValue(found) + 0.5);
    const u = new ObjectUndoable(p, this.host.lot.folder, found.objectId, ObjectAction.Delete, 0, this.link.tool);
    if (this.mode === WallMode.Delete) this.addPostSubUndoable(u);
    else this.addPreSubUndoable(u);
    p.pickup(found, true);
    // +0xe050; ChangeTile's draw branch counts the explosion once more.
    this.explosions++;
    return refund;
  }

  /** The backup's style of a view segment set back to a plain wall (the door went with the deletion). */
  private plainWallInBackup(t: TilePt, seg: number): void {
    const world = this.host.world;
    const r = (4 - world.rotation) & 3;
    const ws = SEG_ROTATION[r]![seg]!;
    const [x, y] = world.toWorld(t.x, t.y);
    const at = (tx: number, ty: number, field: number): number => (tx * ARRAY_SIZE + ty) * WALL_RECORD + field;
    let o = -1;
    if (ws === 0x01) o = at(x, y, 2);
    else if (ws === 0x02) o = at(x, y, 4);
    else if (ws === 0x08 && y + 1 < ARRAY_SIZE) o = at(x, y + 1, 4);
    else if (ws === 0x04 && x + 1 < ARRAY_SIZE) o = at(x + 1, y, 2);
    if (o < 0) return;
    this.backup[o] = 1;
    this.backup[o + 1] = 0;
  }

  /** WallUndoable::ChangeTile: adds (draw) or removes (delete) the segment of a view tile, buying / refunding it. */
  changeTile(t: TilePt, mode: number, dir: number): void {
    if (mode !== WallMode.Draw && mode !== WallMode.Delete) return;
    const world = this.host.world;
    let w = getViewWall(world, t.x, t.y, t.level);
    const seg = dirSeg(dir);
    const i = segIndex(seg);
    const present = (w.segs & seg) === seg;
    let delta = 0;
    let changed = false;
    let mirror = false;
    if (mode === WallMode.Draw) {
      if (present) {
        if (isArchStyle(w.styles[i]!)) {
          const r = this.killArchitecturalObject(t, seg);
          if (r !== null) {
            delta = -r;
            w = getViewWall(world, t.x, t.y, t.level);
            changed = true;
            this.explosions++;
          }
        }
      } else {
        w.segs |= seg;
        delta = this.link.price(this.style);
        if (seg === SEG_HORIZ || seg === SEG_VERT) {
          w.styles[0] = 0;
          w.patterns[0] = 0;
        }
        w.styles[i] = this.style;
        w.patterns[frontSlot(seg)] = this.pattern;
        changed = true;
        if (this.style === 0xff) mirror = true;
      }
    } else {
      const style = w.styles[i]!;
      if (isArchStyle(style)) {
        const r = this.killArchitecturalObject(t, seg);
        if (r !== null) {
          delta = -r;
          this.plainWallInBackup(t, seg);
          changed = true;
        }
      }
      if (present) {
        if ((seg === SEG_HORIZ || seg === SEG_VERT) && world.getFloor(t.x, t.y, t.level) === 0xff) {
          setViewFloor(world, t.x, t.y, t.level, w.patterns[0]!);
        }
        w.segs &= ~seg;
        delta = Math.trunc(-(Math.fround(0.8) * this.link.price(style) - delta));
        changed = true;
        this.explosions++;
      }
    }
    if (!changed) return;
    this.cost += delta;
    this.dirty = true;
    setViewWall(world, t.x, t.y, t.level, w);
    if (mirror) {
      const [ax, ay] = getAdjacentTile(seg, t.x, t.y);
      const opp = getOppositeSegment(seg);
      const n = getViewWall(world, ax, ay, t.level);
      n.patterns[frontSlot(opp)] = this.pattern;
      setViewWall(world, ax, ay, t.level, n);
    }
    this.link.tool.purchase(delta);
  }

  /**
   * WallUndoable::CleanupWallpaper: construction walls (style / pattern 0xff)
   * become plain walls without wallpaper, fences get their pattern on both
   * sides (world coordinates, the whole level).
   */
  cleanupWallpaper(): void {
    const level = this.origin.level;
    if (level < 1 || level > 2) return;
    const f = this.host.fixed;
    const read = (x: number, y: number): TileWalls => {
      // Fresh records: earlier writes of this pass may have touched the neighbors.
      return getViewWallFixed(this.host, x, y, level);
    };
    for (let x = 0; x < f.size; x++) {
      for (let y = 0; y < f.size; y++) {
        const w = read(x, y);
        if (!w.segs) continue;
        let changed = false;
        for (let seg = 1; seg <= 0x20; seg <<= 1) {
          if (!(w.segs & seg)) continue;
          const i = segIndex(seg);
          const style = w.styles[i]!;
          const fence = isFence(style);
          const fp = fencePattern(style);
          if (seg === SEG_HORIZ || seg === SEG_VERT) {
            const slots = seg === SEG_HORIZ ? [patternSlot(seg, 2), patternSlot(seg, 4)] : [patternSlot(seg, 3), patternSlot(seg, 1)];
            for (const s of slots) {
              if (w.patterns[s] === 0xff) {
                w.patterns[s] = 0;
                w.styles[i] = 1;
                changed = true;
              }
              if (fence && w.patterns[s] !== fp) {
                w.patterns[s] = fp;
                changed = true;
              }
            }
            continue;
          }
          const own = w.patterns[i]!;
          if (own === 0xff) {
            w.styles[i] = 1;
            w.patterns[i] = 0;
            changed = true;
          }
          const [ax, ay] = getAdjacentTile(seg, x, y);
          if (ax < 0 || ay < 0 || ax >= f.size || ay >= f.size) continue;
          const opp = getOppositeSegment(seg);
          const oi = segIndex(opp);
          const n = read(ax, ay);
          const back = n.patterns[oi]!;
          let nChanged = false;
          if (back === 0xff) {
            n.styles[oi] = 1;
            n.patterns[oi] = 0;
            nChanged = true;
          }
          if (fence && own !== fp) {
            w.patterns[i] = fp;
            changed = true;
          }
          if (fence && back !== fp) {
            n.patterns[oi] = fp;
            nChanged = true;
          }
          if (nChanged) setFixedWallLevel(this.host, ax, ay, level, n);
        }
        if (changed) setFixedWallLevel(this.host, x, y, level, w);
      }
    }
  }
}

function getViewWallFixed(host: ToolHost, x: number, y: number, level: number): TileWalls {
  return getWall(host.fixed, x, y, level);
}

function setFixedWallLevel(host: ToolHost, x: number, y: number, level: number, t: TileWalls): void {
  setFixedWall(host.fixed, x, y, level, t);
}
