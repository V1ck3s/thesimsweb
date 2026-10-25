/**
 * Light pools: LightLayer (per level, which point lights reach each tile),
 * LightMapSet (the precomputed light maps: FloorLightMap per scale,
 * CanonicalLightMap per distance from a wall and their ShearedLightMap
 * slices per wall direction, scale and lateral offset) and cRenderer's
 * ProcessFloorLightEntry / ProcessWallLightEntry.
 *
 * LightLayer (cFixedWorld +0x64 + level * 4): 64x64 LightEntry, 4 signed
 * bytes = up to two (dx, dy) offsets from the light to the tile (world
 * coordinates), 0x7f = none. Room::CollectObjectStats calls
 * LightLayer::RemoveLight then PositionLight for every object with light
 * source 1 (object data 16) and a lighting contribution: every tile within
 * (int)(0.5 + radius / 3) tiles in the light's room gets the offset, keeping
 * the two nearest lights. cRotatableWorld::GetLightEntry turns the offsets
 * into view coordinates.
 *
 * The light maps hold 0..255 light added to the ambient level by the lit
 * blitters (LitFloorBlit, LitFloorAddBlit, LitWallBlit, LitWallAddBlit):
 *   level = clamp((int)(255 * ambient + 0.5) + map, 0, 255)
 * then the dark map at (level & 0xf8) / 8 (see Compositor.light). A point
 * light at height 5 (tile = 3 units) gives 255 * (1/d^2 - 1/r^2) / (1/d0^2 -
 * 1/r^2), r = LightingParameters +0x24 (12) for the walls, sqrt(r^2 - 25)
 * horizontally for the floors.
 *
 * The original caches the generated maps in a file (LightMapSet +0x60); they
 * are generated in memory here, lazily.
 */

import { ROOM_DEGENERATE, type RoomManager } from "./rooms.js";
import { ARRAY_SIZE, type FixedWorld } from "./world.js";

/** LightEntry "no light" byte. */
export const NO_LIGHT = 0x7f;

/** LightingParameters (lbl_105BBF64 values copied by the constructor). */
const LP_RADIUS = 12; // +0x1c
const LP_INNER = 3.2; // +0x20
const LP_OUTER = 12; // +0x24
/** LightingParameters +0x3a: light pools on. */
export const LIGHT_POOLS_ENABLED = true;
/** lbl_105BBF7C: world units per tile. */
const TILE_UNITS = 3;
/** lbl_105BBF8C: canonical light x / first distance (1.5) and light height (5.0). */
const LIGHT_X = 1.5;
const LIGHT_Z = 5;
/** lbl_105BBEB4: canonical map row height, column width (3 / 64), cutoff. */
const CANON_ROW = Math.fround(0.03827);
const CANON_COL = 0.046875;
/** CanonicalLightMap::Init: rows. */
const CANON_H = 0xe8;

/** LightLayer::PositionLight / RemoveLight radius in tiles. */
export function lightRadiusTiles(): number {
  return Math.trunc(0.5 + LP_RADIUS / TILE_UNITS);
}

/** LightLayer: one level's LightEntry array, index x + y * 64 (world coordinates). */
export class LightLayer {
  readonly e = new Int8Array(ARRAY_SIZE * ARRAY_SIZE * 4).fill(NO_LIGHT);

  clear(): void {
    this.e.fill(NO_LIGHT);
  }

  /** LightEntry::Count. */
  count(x: number, y: number): number {
    const o = (x + y * ARRAY_SIZE) * 4;
    return (this.e[o] !== NO_LIGHT ? 1 : 0) + (this.e[o + 2] !== NO_LIGHT ? 1 : 0);
  }

  private inside(fixed: FixedWorld, x: number, y: number): boolean {
    const m = fixed.size - 1;
    return !(x < 1 || x >= m || y < 1 || y >= m);
  }

  /** LightLayer::RemoveLight. */
  removeLight(fixed: FixedWorld, lx: number, ly: number): void {
    if (!this.inside(fixed, lx, ly)) return;
    const r = lightRadiusTiles();
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = lx + dx;
        const y = ly + dy;
        if (!this.inside(fixed, x, y)) continue;
        const o = (x + y * ARRAY_SIZE) * 4;
        const e = this.e;
        const n = this.count(x, y);
        if (n === 1) {
          if (e[o] === dx && e[o + 1] === dy) e.fill(NO_LIGHT, o, o + 4);
        } else if (n === 2) {
          if (e[o] === dx && e[o + 1] === dy) {
            e[o] = e[o + 2]!;
            e[o + 1] = e[o + 3]!;
            e[o + 2] = NO_LIGHT;
            e[o + 3] = NO_LIGHT;
          } else if (e[o + 2] === dx && e[o + 3] === dy) {
            e[o + 2] = NO_LIGHT;
            e[o + 3] = NO_LIGHT;
          }
        }
      }
    }
  }

  /**
   * LightLayer::PositionLight: tiles of the light's room (or degenerate
   * diagonal tiles one of whose rooms it is) get the offset; a full entry
   * keeps the two nearest lights.
   */
  positionLight(fixed: FixedWorld, rooms: RoomManager, lx: number, ly: number, level: number): void {
    if (!this.inside(fixed, lx, ly)) return;
    const r = lightRadiusTiles();
    const roomArr = fixed.rooms[level - 1]!;
    const room = roomArr.u16(lx, ly);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = lx + dx;
        const y = ly + dy;
        if (!this.inside(fixed, x, y)) continue;
        const id = roomArr.u16(x, y);
        if (id !== room) {
          if (id !== ROOM_DEGENERATE) continue;
          const d = rooms.resolveDiagonal(x, y, level);
          if (d.room1 !== room && d.room2 !== room) continue;
        }
        const o = (x + y * ARRAY_SIZE) * 4;
        const e = this.e;
        const n = this.count(x, y);
        if (n === 0) {
          e[o] = dx;
          e[o + 1] = dy;
        } else if (n === 1) {
          e[o + 2] = dx;
          e[o + 3] = dy;
        } else {
          const d2 = dx * dx + dy * dy;
          if (d2 < e[o]! * e[o]! + e[o + 1]! * e[o + 1]!) {
            e[o] = dx;
            e[o + 1] = dy;
          } else if (d2 < e[o + 2]! * e[o + 2]! + e[o + 3]! * e[o + 3]!) {
            e[o + 2] = dx;
            e[o + 3] = dy;
          }
        }
      }
    }
  }

  /**
   * cRotatableWorld::GetLightEntry for a world tile: the offsets turned by
   * the view rotation (1: (-dy, dx), 2: (-dx, -dy), 3: (dy, -dx)).
   */
  getEntry(x: number, y: number, rotation: number): [number, number, number, number] {
    const o = (x + y * ARRAY_SIZE) * 4;
    const out: [number, number, number, number] = [this.e[o]!, this.e[o + 1]!, this.e[o + 2]!, this.e[o + 3]!];
    const n = this.count(x, y);
    if (rotation === 0 || n === 0) return out;
    const turn = (a: number, b: number): [number, number] => (rotation === 1 ? [-b, a] : rotation === 2 ? [-a, -b] : [b, -a]);
    [out[0], out[1]] = turn(out[0], out[1]);
    if (n > 1) [out[2], out[3]] = turn(out[2], out[3]);
    return out;
  }
}

/** An 8-bit light map (Surface8): `data[row * width + col]`. */
export interface LightMap {
  width: number;
  height: number;
  data: Uint8Array;
}

/** (int)(0.5 + v) clamped like the generators (>= 256 -> 255, v < 0 -> 0). */
function lightByte(v: number): number {
  const i = Math.trunc(0.5 + v);
  if (i >= 0x100) return 0xff;
  return v < 0 ? 0 : i;
}

/** LightMapSet::Get (lbl_105BBF88): the maps, generated on first use. */
export class LightMapSet {
  private readonly floors = new Map<number, LightMap & { tileW: number }>();
  private readonly canon = new Map<number, LightMap>();
  private readonly sheared = new Map<string, LightMap>();

  /** CanonicalLightMap::MaxY. */
  static maxY(): number {
    return Math.trunc(0.5 + Math.floor(LP_RADIUS / 3 - 0.5));
  }

  /** CanonicalLightMap::WallTileCount: wall tiles a light at distance index i reaches. */
  static wallTileCount(i: number): number {
    const k = i * 2 + 1;
    const chord = Math.fround(Math.sqrt(4 * LP_RADIUS * LP_RADIUS - k * k * 9));
    return Math.trunc(0.5 + Math.ceil((3 + chord) / 6));
  }

  /**
   * FloorLightMap::Init(radius, height 5, scale): the floor pool around a
   * light at the center of tile (0, 0), in screen pixels of the scale
   * (tileW = 0x80 >> (3 - scale), 2:1 iso).
   */
  floor(scale: number): LightMap & { tileW: number } {
    const have = this.floors.get(scale);
    if (have) return have;
    const tileW = 0x80 >> (3 - scale);
    const sqrt2 = Math.SQRT2;
    const h2 = LIGHT_Z * LIGHT_Z;
    const reach2 = LP_RADIUS * LP_RADIUS - h2;
    const range = Math.ceil(Math.sqrt(reach2) / (3 * sqrt2));
    const w = tileW * (Math.trunc(2 * range + 0.5) + 1);
    const h = Math.trunc(w / 2);
    const half = 0x40 >> (3 - scale);
    const cx = w * 0.5;
    const ey = h - 2 * Math.trunc(h / 2);
    const ex = h - cx;
    const d0h = (3 * Math.sqrt(ex * ex + ey * ey)) / (half * sqrt2);
    const d0 = Math.fround(Math.sqrt(d0h * d0h + h2));
    const reach = Math.fround(Math.sqrt(reach2));
    const f1 = Math.fround(1 / Math.fround(reach * reach));
    const f2 = Math.fround(255 / (Math.fround(1 / Math.fround(d0 * d0)) - f1));
    const data = new Uint8Array(w * h);
    for (let r = 0; r < h; r++) {
      const dy = h - 2 * r;
      for (let c = 0; c < w; c++) {
        const dx = c - cx;
        const dh = (3 * Math.sqrt(dx * dx + dy * dy)) / (half * sqrt2);
        const d = Math.fround(Math.sqrt(dh * dh + h2));
        const v = Math.fround(f2 * Math.fround(1 / Math.fround(d * d)) + -f2 * f1);
        data[r * w + c] = lightByte(v);
      }
    }
    const m = { width: w, height: h, data, tileW };
    this.floors.set(scale, m);
    return m;
  }

  /** FloorLightMap::GetTileRange. */
  floorRange(scale: number): number {
    const m = this.floor(scale);
    return Math.trunc((m.width / m.tileW - 1) / 2);
  }

  /**
   * FloorLightMap::GetBits(dx, dy): map pixel (column, row) under the top-left
   * corner of the tile at view offset (dx, dy) from the light.
   */
  floorOrigin(scale: number, dx: number, dy: number): { col: number; row: number } {
    const m = this.floor(scale);
    const k = Math.trunc((m.width / m.tileW - 1) / 2) * 2;
    return { col: Math.trunc(m.tileW / 2) * (dx - dy + k), row: Math.trunc(m.tileW / 4) * (dx + dy + k) };
  }

  /**
   * CanonicalLightMap::GenerateLightMap for distance index i: a light at
   * (1.5, -(1.5 + 3i), 5) in front of the wall plane y = 0; column = position
   * along the wall (3/64 unit), row = height (top row first).
   */
  private canonical(i: number): LightMap {
    const have = this.canon.get(i);
    if (have) return have;
    const w = LightMapSet.wallTileCount(i) << 6;
    const h = CANON_H;
    const ly = Math.fround(-(LIGHT_X + 3 * i));
    const f1 = Math.fround(1 / (LP_OUTER * LP_OUTER));
    const f2 = Math.fround(255 / (Math.fround(1 / Math.fround(LP_INNER * LP_INNER)) - f1));
    const data = new Uint8Array(w * h);
    for (let row = 0; row < h; row++) {
      const dz = Math.fround(LIGHT_Z - Math.fround(CANON_ROW + CANON_ROW * row));
      const out = (h - row - 1) * w;
      for (let col = 0; col < w; col++) {
        const dx = Math.fround(LIGHT_X - Math.fround(CANON_COL * col + CANON_COL));
        const d = Math.fround(Math.sqrt(dx * dx + ly * ly + dz * dz));
        const v = Math.fround(f2 * Math.fround(1 / Math.fround(d * d)) + -f2 * f1);
        data[out + col] = lightByte(v);
      }
    }
    const m = { width: w, height: h, data };
    this.canon.set(i, m);
    return m;
  }

  /** Number of canonical maps (CanonicalLightMap::MaxY + 1). */
  static distances(): number {
    return LightMapSet.maxY() + 1;
  }

  /** ShearedLightMap +4: lateral range of distance index i. */
  static wallRange(i: number): number {
    return LightMapSet.wallTileCount(i) - 1;
  }

  /**
   * ShearedLightMap::GenerateShear(scale, type) slice `lat` of distance i: the
   * canonical map sheared to a wall sprite of the scale (8 << scale wide,
   * GetStride; type 0 for segment 0x01, type 1 for 0x02), negative laterals
   * mirrored.
   */
  wall(scale: number, type: number, i: number, lat: number): LightMap {
    const key = `${scale}:${type}:${i}:${lat}`;
    const have = this.sheared.get(key);
    if (have) return have;
    const c = this.canonical(i);
    const sh = 3 - scale;
    const w = 0x40 >> sh;
    const h = (8 << scale) + (0x3a << (scale - 1));
    const stride = 0x10 << (scale - 1);
    const u9 = type === 0 ? (4 << scale) - 1 : 0;
    const base = 0x40 * Math.abs(lat);
    const data = new Uint8Array(stride * h);
    for (let r = 0; r < h; r++) {
      for (let k = 0; k < w; k++) {
        const sc = k << sh;
        const off = type === 1 ? -Math.trunc((sc + 1) / 2) : Math.trunc((sc + type) / 2);
        const row = (r - u9) * (1 << sh) + off;
        if (row < 0 || row >= c.height) continue;
        const col = lat >= 0 ? sc + base : 0x3f - sc + base;
        data[r * stride + k] = c.data[col + row * c.width]!;
      }
    }
    const m = { width: stride, height: h, data };
    this.sheared.set(key, m);
    return m;
  }

  /** ShearedLightMap::GetSkipCount (1 << scale). */
  static wallSkip(scale: number): number {
    return 1 << scale;
  }

  /** LightMapSet::InWallRange. */
  static inWallRange(lat: number, dist: number): boolean {
    if (dist < 0 || dist >= LightMapSet.distances()) return false;
    return Math.abs(lat) <= LightMapSet.wallRange(dist);
  }
}

/**
 * cRenderer::ProcessFloorLightEntry: the lights (0, 1 or 2 view offsets)
 * within the floor maps' tile range.
 */
export function processFloorLightEntry(e: readonly number[], range: number): Array<[number, number]> {
  let n = (e[0] !== NO_LIGHT ? 1 : 0) + (e[2] !== NO_LIGHT ? 1 : 0);
  if (n === 0) return [];
  let a: [number, number] = [e[0]!, e[1]!];
  const out = (p: [number, number]): boolean => range < Math.abs(p[0]) || range < Math.abs(p[1]);
  if (n === 2) {
    const b: [number, number] = [e[2]!, e[3]!];
    if (out(b)) n = 1;
    if (out(a)) {
      if (n === 2) {
        n = 1;
        a = b;
      } else n = 0;
    }
    return n === 2 ? [a, b] : n === 1 ? [a] : [];
  }
  return out(a) ? [] : [a];
}

/**
 * cRenderer::ProcessWallLightEntry: for wall segment 0x01 a light counts
 * when dx < 1 (lateral -dy, distance |dx|), for 0x02 when dy < 1 (lateral
 * dx, distance |dy|), and only within LightMapSet::InWallRange. Diagonal
 * walls (0x10 / 0x20) are never lit. Returns (lateral, distance) pairs.
 */
export function processWallLightEntry(e: readonly number[], seg: number): Array<[number, number]> {
  const n = (e[0] !== NO_LIGHT ? 1 : 0) + (e[2] !== NO_LIGHT ? 1 : 0);
  if (n === 0 || seg === 0x10 || seg === 0x20) return [];
  const out: Array<[number, number]> = [];
  for (let k = 0; k < n; k++) {
    const dx = e[k * 2]!;
    const dy = e[k * 2 + 1]!;
    let p: [number, number] | null = null;
    if (seg === 1) {
      if (dx < 1) p = [-dy, Math.abs(dx)];
    } else if (dy < 1) p = [dx, Math.abs(dy)];
    if (p && LightMapSet.inWallRange(p[0], p[1])) out.push(p);
  }
  return out;
}

/** The process-wide LightMapSet (LightMapSet::Get). */
export const lightMapSet = new LightMapSet();
