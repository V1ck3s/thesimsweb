/**
 * Lot tile data: cFixedWorld (arrays in world coordinates, loaded from the
 * house file's "Arry" chunks) and cRotatableWorld (the same data seen through
 * the current view rotation; every accessor takes view coordinates).
 *
 * Arrays are indexed [x][y] like the original c2DArray (row = x), 64x64 for
 * every lot size; levels are 1-based (1 = ground floor, 2 = upstairs).
 *
 * Arry ids read by cFixedWorld::Load:
 *   0 altitude (PackedAlt, 4 bytes)   4 "ground"        6 grass   7 target grass
 *   9 pool                            10 water
 *   per level (+100 for level 2): 11 floors (u16)  12 walls (TileWallStorage, 14 bytes)
 *   (old saves: 1 floors (u8), 2 walls (8 bytes)), 3 tile object id (s16), 8 flags (u8).
 */

import type { ResFile } from "./iffres.js";

export const ARRAY_SIZE = 64;

/** CTilePt: tile x, y and 1-based level. */
export interface TilePt {
  x: number;
  y: number;
  level: number;
}

/**
 * Neighbor offsets (lbl_105BA078, set by __sinit_ctilept_cpp), as (dx, dy):
 * index 6 (+1, -1) is the screen-horizontal step HouseViewer walks rows with.
 */
export const DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
  [-1, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
];

/** PackedAlt byte order per view rotation (lbl_105BBCD0). */
const PACKED_ALT_PERM = [0, 1, 2, 3, 3, 0, 1, 2, 2, 3, 0, 1, 1, 2, 3, 0];

/** TileWallStorage: one tile's wall record (14 bytes). */
export interface TileWallStorage {
  /** Segment presence bits (byte 0). */
  segs: number;
  /** Byte 1 (placement / style bits). */
  placement: number;
  /** Six 16-bit fields (bytes 2..13): wall styles and patterns. */
  w: Uint16Array;
}

/** Bytes per element and storage of one c2DArray. */
class Array2D {
  readonly data: Uint8Array;
  constructor(
    readonly elemSize: number,
    readonly size = ARRAY_SIZE,
  ) {
    this.data = new Uint8Array(size * size * elemSize);
  }

  offset(x: number, y: number): number {
    return (x * this.size + y) * this.elemSize;
  }

  u8(x: number, y: number): number {
    return this.data[this.offset(x, y)]!;
  }

  s8(x: number, y: number): number {
    return (this.data[this.offset(x, y)]! << 24) >> 24;
  }

  u16(x: number, y: number): number {
    const o = this.offset(x, y);
    return this.data[o]! | (this.data[o + 1]! << 8);
  }

  s16(x: number, y: number): number {
    return (this.u16(x, y) << 16) >> 16;
  }
}

/**
 * c2DArray::ReadFromDisk / DoStream: u16 0, u16 0, i32 rows, i32 columns,
 * i32 element size, i32 compressed; then blocks of u16 n: high bit clear =
 * n raw bytes, set = one byte repeated (n & 0x7fff) times; the stream is
 * re-aligned to an even offset after each block.
 */
export function decodeArry(b: Uint8Array): { rows: number; cols: number; elemSize: number; data: Uint8Array } {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const rows = v.getInt32(4, true);
  const cols = v.getInt32(8, true);
  const elemSize = v.getInt32(12, true);
  const compressed = v.getInt32(16, true);
  const data = new Uint8Array(rows * cols * elemSize);
  let p = 20;
  if (!compressed) {
    data.set(b.subarray(p, p + data.length));
    return { rows, cols, elemSize, data };
  }
  let o = 0;
  while (o < data.length && p + 2 <= b.length) {
    const w = v.getUint16(p, true);
    p += 2;
    const n = w & 0x7fff;
    if (w & 0x8000) {
      data.fill(b[p]!, o, Math.min(data.length, o + n));
      p += 1;
    } else {
      data.set(b.subarray(p, p + Math.min(n, data.length - o)), o);
      p += n;
    }
    o += n;
    p += p & 1;
  }
  return { rows, cols, elemSize, data };
}

function readArry(res: ResFile, id: number, elemSize: number): Array2D | null {
  const bytes = res.get("Arry", id);
  if (!bytes) return null;
  const a = decodeArry(bytes);
  const out = new Array2D(elemSize);
  const copy = (src: number, dst: number): void => {
    if (a.elemSize === elemSize) {
      out.data.set(a.data.subarray(src * elemSize, src * elemSize + elemSize), dst * elemSize);
    } else if (a.elemSize === 1 && elemSize === 2) {
      // Old 1-byte floors widen to u16 (cFixedWorld::Load converts them the same way).
      out.data[dst * 2] = a.data[src]!;
    } else {
      throw new Error(`Arry ${id}: ${a.elemSize} bytes per tile, expected ${elemSize}`);
    }
  };
  for (let x = 0; x < Math.min(a.rows, ARRAY_SIZE); x++) {
    for (let y = 0; y < Math.min(a.cols, ARRAY_SIZE); y++) copy(x * a.cols + y, x * ARRAY_SIZE + y);
  }
  return out;
}

/** Old 8-byte wall records widened to TileWallStorage (cFixedWorld::Load). */
function widenWalls(old: Array2D): Array2D {
  const out = new Array2D(14);
  for (let i = 0; i < ARRAY_SIZE * ARRAY_SIZE; i++) {
    const s = i * 8;
    const d = i * 14;
    out.data[d] = old.data[s]!;
    out.data[d + 1] = old.data[s + 1]!;
    for (let k = 0; k < 6; k++) out.data[d + 2 + k * 2] = old.data[s + 2 + k]!;
  }
  return out;
}

export class FixedWorld {
  /** Lot size in tiles (cFixedWorld+0x10). */
  size = ARRAY_SIZE;
  alt = new Array2D(4);
  ground = new Array2D(1);
  grass = new Array2D(1);
  targetGrass = new Array2D(1);
  pool = new Array2D(1);
  water = new Array2D(1);
  /** Per level (index 0 = level 1). */
  floors = [new Array2D(2), new Array2D(2)];
  rooms = [new Array2D(2), new Array2D(2)];
  walls = [new Array2D(14), new Array2D(14)];
  objects = [new Array2D(2), new Array2D(2)];
  flags = [new Array2D(1), new Array2D(1)];
  /** cFixedWorld+0x80 (CPState::HasBeenTo2ndLevel): level 2 holds a floor, an object or a wall. */
  beenTo2ndLevel = false;
  /** cFixedWorld+0x81 (CPState::Is2ndLevelFloorable): some level 2 tile takes a floor (flags bit 0). */
  secondLevelFloorable = false;

  /** cFixedWorld::Load for the arrays present in the house file. */
  static load(res: ResFile, size = ARRAY_SIZE): FixedWorld {
    const w = new FixedWorld();
    w.size = size;
    const req = (id: number, n: number): Array2D => readArry(res, id, n) ?? new Array2D(n);
    w.alt = req(0, 4);
    w.ground = req(4, 1);
    w.grass = req(6, 1);
    w.targetGrass = req(7, 1);
    w.pool = req(9, 1);
    w.water = req(10, 1);
    // Pool and water default to "none" (0xff) where the house has no array.
    if (!res.find("Arry", 9)) w.pool.data.fill(0xff);
    if (!res.find("Arry", 10)) w.water.data.fill(0xff);
    for (let l = 0; l < 2; l++) {
      const base = (l + 1) * 100;
      if (res.find("Arry", base - 89)) {
        w.floors[l] = req(base - 89, 2);
        w.walls[l] = req(base - 88, 14);
      } else {
        w.floors[l] = req(base - 99, 2);
        const old = readArry(res, base - 98, 8);
        if (old) w.walls[l] = widenWalls(old);
      }
      w.objects[l] = req(base - 97, 2);
      w.flags[l] = req(base - 92, 1);
    }
    return w;
  }

  outOfGrid(x: number, y: number): boolean {
    return x < 0 || y < 0 || x >= this.size || y >= this.size;
  }

  hasPool(x: number, y: number, level: number): boolean {
    return level === 1 && this.pool.u8(x, y) < 0x10;
  }

  hasPoolOrDeck(x: number, y: number, level: number): boolean {
    return level === 1 && this.pool.u8(x, y) <= 0x10;
  }

  hasWater(x: number, y: number, level: number): boolean {
    return level === 1 && this.water.u8(x, y) !== 0xff;
  }

  wallStorage(x: number, y: number, level: number): TileWallStorage {
    const a = this.walls[level - 1]!;
    const o = a.offset(x, y);
    const w = new Uint16Array(6);
    for (let k = 0; k < 6; k++) w[k] = a.data[o + 2 + k * 2]! | (a.data[o + 3 + k * 2]! << 8);
    return { segs: a.data[o]!, placement: a.data[o + 1]!, w };
  }

  /**
   * cFixedWorld::GetFAlt: altitude at a fixed-point position (1/16 tile),
   * interpolated over the tile's two triangles.
   */
  getFAlt(fx: number, fy: number): number {
    const o = this.alt.offset(fx >> 4, fy >> 4);
    const b = this.alt.data;
    const b0 = b[o]!;
    const b1 = b[o + 1]!;
    const b2 = b[o + 2]!;
    const b3 = b[o + 3]!;
    const ty = fy & 0xf;
    const tx = fx & 0xf;
    // lbl_105BBCCC = { 0, 16, 1/16 }.
    if (ty < 0 || tx < 0 || ty > 16 || tx > 16) return b1;
    const k = 1 / 16;
    if (ty === tx) return b1 + tx * (b3 - b1) * k;
    if (ty < tx) {
      const a = tx * (b2 - b1) * k;
      return b1 + a + (ty * (tx * (b3 - b1) * k - a)) / tx;
    }
    const a = ty * (b0 - b1) * k;
    return b1 + a + (tx * (ty * (b3 - b1) * k - a)) / ty;
  }
}

/** Rotation lookup (CTilePt::BuildRotationLookup): world <-> view coordinates. */
export function rotateTile(x: number, y: number, rot: number, size = ARRAY_SIZE): [number, number] {
  const m = size - 1;
  switch (rot & 3) {
    case 1:
      return [m - y, x];
    case 2:
      return [m - x, m - y];
    case 3:
      return [y, m - x];
    default:
      return [x, y];
  }
}

export class RotatableWorld {
  /** View rotation (cRotatableWorld+0x84). */
  rotation = 0;
  /** View-space tile bounds (+0x70 minX, +0x74 maxX, +0x78 minY, +0x7c maxY). */
  minX = 0;
  maxX = ARRAY_SIZE - 1;
  minY = 0;
  maxY = ARRAY_SIZE - 1;

  constructor(readonly fixed: FixedWorld) {
    this.setRotation(0);
  }

  get size(): number {
    return this.fixed.size;
  }

  /** cRotatableWorld::SetRotation: also recomputes the view-space bounds. */
  setRotation(rot: number): void {
    this.rotation = rot & 3;
    const m = this.fixed.size - 1;
    const corners = [rotateTile(0, 0, rot), rotateTile(m, 0, rot), rotateTile(m, m, rot), rotateTile(0, m, rot)];
    this.minX = Math.min(...corners.map((c) => c[0]));
    this.maxX = Math.max(...corners.map((c) => c[0]));
    this.minY = Math.min(...corners.map((c) => c[1]));
    this.maxY = Math.max(...corners.map((c) => c[1]));
  }

  /** cRotatableWorld::RotateCoords on fixed-point or tile coordinates (`range` = 0x40 or 0x401). */
  static rotateCoords(a: number, b: number, rot: number, range: number): [number, number] {
    const m = range - 1;
    switch (rot & 3) {
      case 1:
        return [m - b, a];
      case 2:
        return [m - a, m - b];
      case 3:
        return [b, m - a];
      default:
        return [a, b];
    }
  }

  /** View -> world tile coordinates. */
  toWorld(x: number, y: number): [number, number] {
    return rotateTile(x, y, (4 - this.rotation) & 3);
  }

  /** World -> view tile coordinates. */
  toView(x: number, y: number): [number, number] {
    return rotateTile(x, y, this.rotation);
  }

  /** Inside the lot excluding its border row (the "!OutOfBounds" test HouseViewer uses). */
  inInterior(x: number, y: number): boolean {
    return x >= this.minX + 1 && x <= this.maxX - 1 && y >= this.minY + 1 && y <= this.maxY - 1;
  }

  inBounds(x: number, y: number): boolean {
    return x >= this.minX && x <= this.maxX && y >= this.minY && y <= this.maxY;
  }

  /** cRotatableWorld::GetPackedAlt: corner altitudes [left, top, right, bottom] in view space. */
  getPackedAlt(x: number, y: number): [number, number, number, number] {
    const [wx, wy] = this.toWorld(x, y);
    const o = this.fixed.alt.offset(wx, wy);
    const d = this.fixed.alt.data;
    const p = this.rotation * 4;
    return [d[o + PACKED_ALT_PERM[p]!]!, d[o + PACKED_ALT_PERM[p + 1]!]!, d[o + PACKED_ALT_PERM[p + 2]!]!, d[o + PACKED_ALT_PERM[p + 3]!]!];
  }

  /**
   * cRotatableWorld::SetPackedAlt: a view tile's corners (view order), then
   * the copies of its own corners its eight neighbors keep.
   */
  setPackedAlt(x: number, y: number, alt: readonly [number, number, number, number]): void {
    const [wx, wy] = this.toWorld(x, y);
    // View -> world byte order (the inverse of PACKED_ALT_PERM).
    const p = this.rotation * 4;
    const w = [0, 0, 0, 0];
    for (let k = 0; k < 4; k++) w[PACKED_ALT_PERM[p + k]!] = alt[k]!;
    const a = this.fixed.alt;
    const set = (tx: number, ty: number, byte: number, v: number): void => {
      if (this.fixed.outOfGrid(tx, ty)) return;
      a.data[a.offset(tx, ty) + byte] = v;
    };
    for (let k = 0; k < 4; k++) set(wx, wy, k, w[k]!);
    set(wx - 1, wy, 2, w[1]!);
    set(wx - 1, wy, 3, w[0]!);
    set(wx, wy - 1, 0, w[1]!);
    set(wx, wy - 1, 3, w[2]!);
    set(wx + 1, wy, 1, w[2]!);
    set(wx + 1, wy, 0, w[3]!);
    set(wx, wy + 1, 1, w[0]!);
    set(wx, wy + 1, 2, w[3]!);
    set(wx + 1, wy - 1, 0, w[2]!);
    set(wx - 1, wy + 1, 2, w[0]!);
    set(wx + 1, wy + 1, 1, w[3]!);
    set(wx - 1, wy - 1, 3, w[1]!);
  }

  /** cRotatableWorld::GetTargetGrass */
  getTargetGrass(x: number, y: number): number {
    const [wx, wy] = this.toWorld(x, y);
    return this.fixed.targetGrass.s8(wx, wy);
  }

  /** cRotatableWorld::SetGrass (signed char). */
  setGrass(x: number, y: number, v: number): void {
    const [wx, wy] = this.toWorld(x, y);
    const a = this.fixed.grass;
    a.data[a.offset(wx, wy)] = v & 0xff;
  }

  /** cRotatableWorld::SetTargetGrass (signed char). */
  setTargetGrass(x: number, y: number, v: number): void {
    const [wx, wy] = this.toWorld(x, y);
    const a = this.fixed.targetGrass;
    a.data[a.offset(wx, wy)] = v & 0xff;
  }

  /**
   * cRotatableWorld::MayEditTile: build/buy anywhere (lbl_105BA244), else the
   * ground floor tile's flag 0x20 is clear.
   */
  mayEditTile(x: number, y: number, anywhere: boolean): boolean {
    if (anywhere) return true;
    const [wx, wy] = this.toWorld(x, y);
    return (this.fixed.flags[0]!.u8(wx, wy) & 0x20) === 0;
  }

  getFloor(x: number, y: number, level: number): number {
    const [wx, wy] = this.toWorld(x, y);
    return this.fixed.floors[level - 1]!.u16(wx, wy);
  }

  getRoom(x: number, y: number, level: number): number {
    const [wx, wy] = this.toWorld(x, y);
    return this.fixed.rooms[level - 1]!.u16(wx, wy);
  }

  getFlags(x: number, y: number, level: number): number {
    const [wx, wy] = this.toWorld(x, y);
    return this.fixed.flags[level - 1]!.u8(wx, wy);
  }

  getGrass(x: number, y: number): number {
    const [wx, wy] = this.toWorld(x, y);
    return this.fixed.grass.s8(wx, wy);
  }

  getTileObjectID(x: number, y: number, level: number): number {
    const [wx, wy] = this.toWorld(x, y);
    return this.fixed.objects[level - 1]!.s16(wx, wy);
  }

  hasPool(x: number, y: number, level: number): boolean {
    const [wx, wy] = this.toWorld(x, y);
    return this.fixed.hasPool(wx, wy, level);
  }

  hasPoolOrDeck(x: number, y: number, level: number): boolean {
    const [wx, wy] = this.toWorld(x, y);
    return this.fixed.hasPoolOrDeck(wx, wy, level);
  }

  hasWater(x: number, y: number, level: number): boolean {
    const [wx, wy] = this.toWorld(x, y);
    return this.fixed.hasWater(wx, wy, level);
  }

  /** Raw wall record at a view tile (world-space segment bits; see walls module). */
  getWallStorage(x: number, y: number, level: number): TileWallStorage {
    const [wx, wy] = this.toWorld(x, y);
    return this.fixed.wallStorage(wx, wy, level);
  }
}
