/**
 * Rooms: cFixedWorld::ComputeRooms (the room partition of each level),
 * RoomManager (rooms by id, the diagonal-tile map) and Room (tile list,
 * IsOutside, the cutaway matrix the dynamic cutaway ORs together).
 *
 * The room arrays (cFixedWorld+0x2c per level) are not saved in the house
 * file: the game recomputes them when the lot loads. Room ids carry their
 * level in bits 10..11 ((level - 1) << 10 | counter). Array values above
 * 0xfffa are transient flood states or markers:
 *   0xffff unvisited, 0xfffe / 0xfffd one half of a diagonal tile claimed,
 *   0xfffc queued, 0xfffb degenerate diagonal tile (two rooms, see the
 *   RoomManager diagonal map).
 * Flags array (per level): 0x02 visited / 0x04 outside (flood from (0,0)
 * that does not cross non-fence walls), 0x40 / 0x80 diagonal kind.
 */

import type { HouseViewer } from "./houseviewer.js";
import { generateRoofs } from "./roofs.js";
import { CutawayMask } from "./walls.js";
import { getWall, SEG_HORIZ, SEG_ROTATION, SEG_VERT } from "./tilewalls.js";
import { ARRAY_SIZE, DIRS, type FixedWorld, type TilePt } from "./world.js";

export const ROOM_UNVISITED = 0xffff;
export const ROOM_DEGENERATE = 0xfffb;
const ROOM_QUEUED = 0xfffc;
const ROOM_HALF_E = 0xfffe;
const ROOM_HALF_D = 0xfffd;

/** lbl_105BBCE8: the neighbor's wall bit facing back toward us, per DIRS[0..3]. */
const NEIGHBOR_WALL = [8, 2, 4, 1] as const;

/** IsFenceStyle. */
function isFenceStyle(s: number): boolean {
  return s === 2 || s === 0xc || s === 0xd || s === 0xe;
}

/** One diagonal tile shared by two rooms (RoomManager's pair<DiagonalNode, DiagonalNode>). */
export interface DiagonalNode {
  room1: number;
  side1: number;
  room2: number;
  side2: number;
}

const tileKey = (x: number, y: number, level: number): number => x | (y << 8) | (level << 16);

export class Room {
  /** +0x04 tiles (world coordinates). */
  tiles: TilePt[] = [];
  /** +0x34. */
  inUse = false;
  /** +0x71 / +0x72: IsOutside cache. */
  private outsideKnown = false;
  private outside = false;
  /** +0x7c: tiles (view coordinates) the dynamic cutaway cuts when this room is cut. */
  readonly cutaway = new CutawayMask();

  constructor(
    /** +0x00. */
    readonly id: number,
    private readonly mgr: RoomManager,
  ) {}

  /** Room::GetLevel. */
  get level(): number {
    return ((this.id >> 10) & 3) + 1;
  }

  /** Room::Clear (the parts this port keeps). */
  clear(): void {
    this.inUse = false;
    this.outsideKnown = false;
    this.outside = false;
  }

  /** Room::AbsorbNewRoomList. */
  absorbNewRoomList(tiles: TilePt[]): void {
    this.clear();
    this.tiles = tiles.slice();
    this.inUse = true;
  }

  /** Room::IsOutside: the outside flag of the first tile that is really ours. */
  isOutside(): boolean {
    if (!this.outsideKnown) {
      const f = this.mgr.fixed;
      for (const t of this.tiles) {
        if (f.rooms[t.level - 1]!.u16(t.x, t.y) === this.id) {
          this.outside = ((f.flags[t.level - 1]!.u8(t.x, t.y) >> 2) & 1) !== 0;
          this.outsideKnown = true;
          break;
        }
      }
      if (!this.outsideKnown) {
        this.outside = this.tiles.length === 1;
        this.outsideKnown = true;
      }
    }
    return this.outside;
  }

  /**
   * Room::ComputeCutawayMatrix: the room's own tiles, plus every tile in the
   * screen column below each of them (three tiles wide, walking +x+y) whose
   * full-height wall extent overlaps the room tile on screen. Outside rooms
   * cut nothing.
   */
  computeCutawayMatrix(viewer: HouseViewer): void {
    const mask = this.cutaway;
    mask.clear();
    if (this.isOutside()) return;
    const w = viewer.world;
    const rot = w.rotation;
    const half = 8 << viewer.scale;
    for (const t of this.tiles) {
      const [vx, vy] = w.toView(t.x, t.y);
      const diag = this.hasViewWall(t, SEG_VERT, rot);
      mask.set(vx, vy);
      const p = viewer.tileToPoint(vx, vy, t.level);
      let left = p.h - half + 1;
      let right = p.h + half - 2;
      const top = p.v + 1;
      const bottom = p.v + half - 2;
      if (diag) {
        const d = this.mgr.resolveDiagonal(t.x, t.y, t.level);
        const s1 = viewSide(d.side1, rot);
        const s2 = viewSide(d.side2, rot);
        const side = d.room1 === this.id ? s1 : d.room2 === this.id ? s2 : 0;
        if (side === 1) right -= half;
        else if (side === 3) left += half;
      }
      const check = (x: number, y: number): number => {
        if (!w.inInterior(x, y)) return 1;
        if (!mask.has(x, y)) {
          const e = viewer.getTheoreticalWallExtent(x, y, t.level);
          if (e.bottom > top && bottom > e.top && right > e.left && e.right > left) mask.set(x, y);
        }
        return 0;
      };
      // Steps DIRS[1] (0, +1) and DIRS[6] (+1, -1): the tiles (k, k+1), (k+1, k), (k+1, k+1) below.
      let x = vx;
      let y = vy + 1;
      for (;;) {
        let out = check(x, y);
        x += 1;
        y -= 1;
        out += check(x, y);
        y += 1;
        out += check(x, y);
        if (out > 2) break;
        y += 1;
      }
    }
  }

  /** cRotatableWorld::HasWalls on a world tile, `seg` in view space. */
  private hasViewWall(t: TilePt, seg: number, rot: number): boolean {
    const m = SEG_ROTATION[(4 - rot) & 3]![seg]!;
    return (this.mgr.fixed.wallStorage(t.x, t.y, t.level).segs & m) === m;
  }
}

/** A diagonal side (1..4) seen through the view rotation (0 stays 0). */
function viewSide(side: number, rot: number): number {
  return side !== 0 ? ((side + ((4 - rot) & 3) - 1) & 3) + 1 : 0;
}

export class RoomManager {
  /** +0x04: rooms by id. */
  private readonly rooms = new Map<number, Room>();
  /** +0x14: degenerate diagonal tiles (world coordinates). */
  private readonly diagonals = new Map<number, DiagonalNode>();

  constructor(readonly fixed: FixedWorld) {}

  /** RoomManager::GetRoom (in-use or not, like the original's map lookup). */
  getRoom(id: number): Room | null {
    return this.rooms.get(id) ?? null;
  }

  /** RoomManager::GetNewRoom. */
  getNewRoom(id: number): Room {
    let r = this.rooms.get(id);
    if (!r) {
      r = new Room(id, this);
      this.rooms.set(id, r);
    } else r.clear();
    r.inUse = true;
    return r;
  }

  /** RoomManager::ResetRooms(level): 0 = all levels. */
  resetRooms(level: number): void {
    for (const r of this.rooms.values()) if (r.inUse && (level === 0 || r.level === level)) r.clear();
    if (level === 0) this.diagonals.clear();
    else for (const k of [...this.diagonals.keys()]) if (k >> 16 === level) this.diagonals.delete(k);
  }

  /** RoomManager::ResolveDiagonal(CTilePt, ushort*, ushort*, Sides*, Sides*): zeros when the tile is not degenerate. */
  resolveDiagonal(x: number, y: number, level: number): DiagonalNode {
    const n = this.diagonals.get(tileKey(x, y, level));
    if (n) {
      // The Room** overload maps a missing second room to the first one.
      if (n.room2 >= ROOM_DEGENERATE) return { room1: n.room1, side1: 0, room2: n.room1, side2: 0 };
      return { ...n };
    }
    const id = this.fixed.rooms[level - 1]!.u16(x, y);
    return { room1: id, side1: 0, room2: id, side2: 0 };
  }

  /** The ushort overload of ResolveDiagonal used by ComputeRooms (raw node, zeros if absent). */
  diagonalNode(x: number, y: number, level: number): DiagonalNode {
    return { ...(this.diagonals.get(tileKey(x, y, level)) ?? { room1: 0, side1: 0, room2: 0, side2: 0 }) };
  }

  /**
   * RoomManager::ProcessDegenerateTile: record that `room` owns `side` of a
   * diagonal tile. False when both halves end up in the same room (the tile
   * is then an ordinary tile of that room).
   */
  processDegenerateTile(x: number, y: number, level: number, room: number, side: number): boolean {
    const opposite = side === 3 ? 1 : side === 1 ? 3 : side === 2 ? 4 : side === 4 ? 2 : 0;
    const key = tileKey(x, y, level);
    const n = this.diagonals.get(key);
    if (!n) {
      this.diagonals.set(key, { room1: room, side1: side, room2: ROOM_UNVISITED, side2: opposite });
      return true;
    }
    if (n.room1 === room) {
      this.diagonals.delete(key);
      return false;
    }
    n.room2 = room;
    n.side2 = side;
    return true;
  }

  /** RoomManager::ComputeCutaway(level): 0 = all levels. */
  computeCutaway(viewer: HouseViewer, level: number): void {
    for (const r of this.rooms.values()) if (r.inUse && (level === 0 || r.level === level)) r.computeCutawayMatrix(viewer);
  }

  /** In-use rooms (debugging / lighting). */
  inUseRooms(): Room[] {
    return [...this.rooms.values()].filter((r) => r.inUse);
  }
}

/** Disabled flood directions per diagonal side (the enable bytes of ComputeRooms). */
const SIDE_DISABLE: Record<number, readonly number[]> = { 1: [0, 3], 2: [2, 0], 3: [2, 1], 4: [1, 3] };

/**
 * cFixedWorld::ComputeRooms(level) (0 = both levels): flood-fill each level
 * into rooms (walls, floor / no floor on upper levels and pool / no pool
 * separate rooms; diagonal walls split tiles in halves), then flood the
 * outside flag from the corner. The flat-terrain pass (flags bit 0) is not
 * ported: the bit loaded from the house file is kept.
 */
export function computeRooms(fixed: FixedWorld, mgr: RoomManager, level = 0): void {
  mgr.resetRooms(level);
  const from = level === 0 ? 1 : level;
  const to = level === 0 ? 2 : level;
  for (let l = from; l <= to; l++) {
    computeLevelRooms(fixed, mgr, l);
    computeOutside(fixed, l);
  }
  // The end of ComputeRooms: cRoofLayer::GenerateRoof for both roof layers.
  generateRoofs(fixed, mgr);
}

function computeLevelRooms(fixed: FixedWorld, mgr: RoomManager, level: number): void {
  const size = fixed.size;
  const rooms = fixed.rooms[level - 1]!;
  const flags = fixed.flags[level - 1]!;
  const floors = fixed.floors[level - 1]!;
  const rd = rooms.data;
  rd.fill(0xff);
  for (let i = 0; i < flags.data.length; i++) flags.data[i] = flags.data[i]! & 0x29;
  const getR = (x: number, y: number): number => rooms.u16(x, y);
  const setR = (x: number, y: number, v: number): void => {
    const o = rooms.offset(x, y);
    rd[o] = v & 0xff;
    rd[o + 1] = v >> 8;
  };
  const segs = (x: number, y: number): number => fixed.walls[level - 1]!.u8(x, y);
  const base = (level - 1) * 0x400;
  let counter = 0;
  for (let sx = 0; sx < size; sx++) {
    for (let sy = 0; sy < size; sy++) {
      const v = getR(sx, sy);
      if (!(v >= ROOM_HALF_D || v === ROOM_DEGENERATE)) continue;
      if (v === ROOM_DEGENERATE && mgr.diagonalNode(sx, sy, level).room2 !== ROOM_UNVISITED) continue;
      const startFloor = floors.u16(sx, sy) !== 0;
      const startPool = fixed.hasPool(sx, sy, level);
      const id = base | counter;
      counter++;
      const list: TilePt[] = [];
      const stack: TilePt[] = [{ x: sx, y: sy, level }];
      for (let t = stack.pop(); t; t = stack.pop()) {
        const { x, y } = t;
        const cur = getR(x, y);
        if (cur === id) continue;
        const en = [true, true, true, true];
        const off = (side: number): void => {
          for (const i of SIDE_DISABLE[side] ?? []) en[i] = false;
        };
        const degenerate = (side: number): void => setR(x, y, mgr.processDegenerateTile(x, y, level, id, side) ? ROOM_DEGENERATE : id);
        const ws = segs(x, y);
        if (cur === ROOM_QUEUED) {
          setR(x, y, id);
        } else if (cur === ROOM_UNVISITED) {
          if (ws & SEG_HORIZ) {
            off(4);
            setR(x, y, ROOM_HALF_E);
          } else if (ws & SEG_VERT) {
            off(3);
            setR(x, y, ROOM_HALF_D);
          } else setR(x, y, ROOM_QUEUED);
          stack.push(t);
          list.push(t);
        } else if (cur === ROOM_HALF_E) {
          if (ws & SEG_HORIZ) {
            off(4);
            degenerate(4);
          } else if (ws & SEG_VERT) {
            off(1);
            degenerate(1);
          }
        } else if (cur === ROOM_HALF_D) {
          if (ws & SEG_HORIZ) {
            off(2);
            degenerate(2);
          } else {
            off(3);
            degenerate(3);
          }
        } else if (cur === ROOM_DEGENERATE) {
          const d = mgr.diagonalNode(x, y, level);
          if (d.room2 === id) continue;
          if (d.room2 === ROOM_UNVISITED) list.push(t);
          off(d.side2);
          degenerate(d.side2);
        }
        const border = x < 1 || x >= size - 1 || y < 1 || y >= size - 1;
        for (let i = 0; i < 4; i++) {
          if (!en[i]) continue;
          const nx = x + DIRS[i]![0];
          const ny = y + DIRS[i]![1];
          if (border && (nx < 0 || nx >= size || ny < 0 || ny >= size)) continue;
          const nv = getR(nx, ny);
          if (nv < ROOM_DEGENERATE) continue;
          const d = nv === ROOM_DEGENERATE ? mgr.diagonalNode(nx, ny, level) : null;
          if (level !== 1 && (floors.u16(nx, ny) !== 0) !== startFloor) continue;
          if (fixed.hasPool(nx, ny, level) !== startPool) continue;
          const wb = segs(nx, ny);
          if (wb & NEIGHBOR_WALL[i]!) continue;
          let nn: number | null;
          if ((wb & (SEG_HORIZ | SEG_VERT)) === 0) nn = ROOM_QUEUED;
          else if (wb & SEG_HORIZ) nn = i === 0 || i === 2 ? half(nv, ROOM_HALF_D, ROOM_HALF_E, 2, d) : half(nv, ROOM_HALF_E, ROOM_HALF_D, 4, d);
          else nn = i === 0 || i === 3 ? half(nv, ROOM_HALF_E, ROOM_HALF_D, 1, d) : half(nv, ROOM_HALF_D, ROOM_HALF_E, 3, d);
          if (nn === null) continue;
          const n = { x: nx, y: ny, level };
          stack.push(n);
          setR(nx, ny, nn);
          list.push(n);
        }
      }
      if (list.length === 0) counter--;
      else mgr.getNewRoom(id).absorbNewRoomList(list);
    }
  }
}

/** Entering a diagonal tile's half: the new array value, or null when that half is taken. */
function half(nv: number, claim: number, other: number, side: number, d: DiagonalNode | null): number | null {
  if (nv === ROOM_UNVISITED) return claim;
  if (nv === other) return ROOM_QUEUED;
  if (nv === ROOM_DEGENERATE && d) {
    if (d.side1 === side && d.room1 === ROOM_UNVISITED) return ROOM_DEGENERATE;
    if (d.side2 === side && d.room2 === ROOM_UNVISITED) return ROOM_DEGENERATE;
  }
  return null;
}

/** ComputeRooms' second pass: flags |= 6 on every tile reachable from (0, 0) without crossing a non-fence wall. */
function computeOutside(fixed: FixedWorld, level: number): void {
  const size = fixed.size;
  const flags = fixed.flags[level - 1]!;
  const fd = flags.data;
  const fl = (x: number, y: number): number => (x < 0 || y < 0 || x >= ARRAY_SIZE || y >= ARRAY_SIZE ? 2 : flags.u8(x, y));
  const inRange = (v: number): boolean => v >= 0 && v <= size - 1;
  /** The neighbor's own diagonal wall (non-fence) blocks entering it. */
  const diagBlocks = (x: number, y: number): boolean => {
    const st = fixed.wallStorage(x, y, level);
    return (st.segs & (SEG_HORIZ | SEG_VERT)) !== 0 && !isFenceStyle(st.w[1]!);
  };
  const stack: Array<[number, number]> = [[0, 0]];
  for (let t = stack.pop(); t; t = stack.pop()) {
    const [x, y] = t;
    if (fl(x, y) & 2) continue;
    let f = fl(x, y) | 6;
    const tw = getWall(fixed, x, y, level);
    const wallOn = (seg: number): boolean => (tw.segs & seg) !== 0 && !isFenceStyle(tw.getStyle(seg));
    if (wallOn(SEG_HORIZ) || wallOn(SEG_VERT)) {
      const h = (tw.segs & SEG_HORIZ) !== 0;
      const ya = h ? y + 1 : y - 1;
      const yb = h ? y - 1 : y + 1;
      f |= h ? 0x40 : 0x80;
      const b41 = inRange(ya) ? fl(x, ya) & 2 : 2;
      const b39 = inRange(x) ? fl(x + 1, y) & 2 : 2;
      const b37 = inRange(x) ? fl(x - 1, y) & 2 : 2;
      const b35 = inRange(ya) ? fl(x, yb) & 2 : 2;
      if (b41 && !b39) stack.push([x + 1, y]);
      if (b39 && !b41) stack.push([x, ya]);
      if (b37 && !b35) stack.push([x, yb]);
      if (b35 && !b37) stack.push([x - 1, y]);
    } else {
      const open = (seg: number): boolean => (tw.segs & seg) === 0 || isFenceStyle(tw.getStyle(seg));
      if (x > 0 && !(fl(x - 1, y) & 2) && open(1) && !diagBlocks(x - 1, y)) stack.push([x - 1, y]);
      if (x < size - 1 && !(fl(x + 1, y) & 2) && open(4) && !diagBlocks(x + 1, y)) stack.push([x + 1, y]);
      if (y > 0 && !(fl(x, y - 1) & 2) && open(2) && !diagBlocks(x, y - 1)) stack.push([x, y - 1]);
      if (y < size - 1 && !(fl(x, y + 1) & 2) && open(8) && !diagBlocks(x, y + 1)) stack.push([x, y + 1]);
    }
    fd[flags.offset(x, y)] = f;
  }
}
