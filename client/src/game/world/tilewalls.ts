/**
 * Wall data per tile: TileWalls (segment bits, styles, patterns, placement)
 * built from the world's TileWallStorage records (cFixedWorld::GetWall), the
 * segment helpers of TileWalls (DirToWallSeg, GetOppositeSegment,
 * GetAdjacentTile, GenerateRotationLookups) and the vertex configurations the
 * wall graph is built from (cFixedWorld::AnalyzeWallVertex,
 * VertexConfig::GenerateLookups).
 *
 * Segments of a tile (x, y), seen in view space with the tile's top corner at
 * grid point (x, y):
 *   0x01 edge toward x - 1 (top-left edge)    0x02 edge toward y - 1 (top-right edge)
 *   0x04 edge toward x + 1 (bottom-right)     0x08 edge toward y + 1 (bottom-left)
 *   0x10 diagonal (x, y + 1)-(x + 1, y) (horizontal on screen)
 *   0x20 diagonal (x, y)-(x + 1, y + 1) (vertical on screen)
 * A wall between two tiles is stored in both (0x01 of one is 0x04 of the other).
 *
 * TileWallStorage (14 bytes, LE on disk) as read by TileWalls::TileWalls:
 *   [0] segment bits   [1] placement (2 bits per segment 0x01 / 0x02)
 *   w0 style of 0x01   w1 style of 0x02 and of the diagonals
 *   w2 pattern facing this tile on 0x01   w3 ... on 0x02
 *   w4 pattern on 0x08 / first side of a diagonal
 *   w5 pattern on 0x04 / second side of a diagonal
 * Styles of 0x04 / 0x08 come from the neighbors' 0x01 / 0x02 (GetWall).
 *
 * Vertex configuration bits (grid point (x, y), AnalyzeWallVertex):
 *   0x01 wall toward (0,-1)   0x02 (-1,0)   0x04 (0,+1)   0x08 (+1,0)
 *   0x10 (-1,-1)   0x20 (-1,+1)   0x40 (+1,+1)   0x80 (+1,-1)
 */

import { DIRS, type FixedWorld, type TileWallStorage } from "./world.js";

/** Segment bits. */
export const SEG_TL = 0x01;
export const SEG_TR = 0x02;
export const SEG_BR = 0x04;
export const SEG_BL = 0x08;
export const SEG_HORIZ = 0x10;
export const SEG_VERT = 0x20;

/** Bit index of a segment (the loops `for (; (seg & 1) == 0; seg >>= 1) i++`). */
export function segIndex(seg: number): number {
  let i = 0;
  for (let s = seg; s !== 0 && (s & 1) === 0; s >>= 1) i++;
  return i;
}

/** TileWalls::DirToWallSeg. */
export function dirToWallSeg(dir: number): number {
  if (dir < 4) {
    if (dir > 1) return SEG_TR;
    if (dir >= 0) return SEG_TL;
    return SEG_TL;
  }
  if (dir < 8) return dir > 5 ? SEG_HORIZ : SEG_VERT;
  return SEG_TL;
}

/** TileWalls::GetOppositeSegment (jump table lbl_105BC67C). */
export function getOppositeSegment(seg: number): number {
  switch (seg) {
    case SEG_TL:
      return SEG_BR;
    case SEG_TR:
      return SEG_BL;
    case SEG_BR:
      return SEG_TL;
    case SEG_BL:
      return SEG_TR;
    case SEG_HORIZ:
    case SEG_VERT:
      return seg;
    default:
      return 0;
  }
}

/** TileWalls::GetAdjacentTile (jump table lbl_105BC678): the tile across a segment. */
export function getAdjacentTile(seg: number, x: number, y: number): [number, number] {
  const d = seg === SEG_TL ? DIRS[2] : seg === SEG_TR ? DIRS[0] : seg === SEG_BR ? DIRS[3] : seg === SEG_BL ? DIRS[1] : null;
  return d ? [x + d[0], y + d[1]] : [x, y];
}

/**
 * Index into TileWalls' pattern array for a segment and a diagonal side
 * (the `placement` switch shared by Wall::BuildFromVertex, RefreshFromMap
 * and WallGraphicsMgr::LoadUsageMapAndUpdate).
 */
export function patternIndex(seg: number, side: number): number {
  let i = segIndex(seg);
  let v = side;
  if (seg === SEG_HORIZ && v === 0) v = 4;
  else if (seg === SEG_VERT && v === 0) v = 1;
  if (v === 1 || v === 4) i += 1;
  else if (v === 3) i += 2;
  return i;
}

/**
 * TileWalls::GenerateRotationLookups (lbl_105BA24C): segment masks seen
 * through a rotation of `rot` quarter turns.
 */
export const SEG_ROTATION: ReadonlyArray<Uint8Array> = (() => {
  const out: Uint8Array[] = [];
  for (let r = 0; r < 4; r++) {
    const t = new Uint8Array(64);
    for (let b = 0; b < 6; b++) {
      const s = 1 << b;
      if (s === SEG_VERT) t[s] = r & 1 ? SEG_HORIZ : SEG_VERT;
      else if (s === SEG_HORIZ) t[s] = r & 1 ? SEG_VERT : SEG_HORIZ;
      else {
        let v = s;
        for (let k = 0; k < r; k++) {
          v <<= 1;
          if (v > 8) v = 1;
        }
        t[s] = v;
      }
    }
    for (let m = 1; m < 64; m++) {
      if (t[m] !== 0) continue;
      let v = m & 1 ? t[1]! : 0;
      for (const b of [2, 4, 8, 16, 32]) if (m & b) v |= t[b]!;
      t[m] = v;
    }
    out.push(t);
  }
  return out;
})();

/** TileWalls: one tile's walls in usable form (0x2c bytes in the original). */
export class TileWalls {
  /** +0x00 segment bits. */
  segs = 0;
  /** +0x04 placement, 2 bits per ortho segment (SetPlacement / GetPlacement). */
  placement = 0;
  /** +0x08 styles by segment bit index. */
  readonly styles = new Uint16Array(6);
  /** +0x14 patterns: [0..3] ortho segments, [4]/[5] sides of 0x10, [6]/[7] sides of 0x20. */
  readonly patterns = new Uint16Array(8);

  /** TileWalls::TileWalls(TileWallStorage const &, ...). */
  static fromStorage(st: TileWallStorage): TileWalls {
    const t = new TileWalls();
    const w = st.w;
    t.segs = st.segs;
    t.placement = st.placement;
    t.styles[0] = w[0]!;
    t.styles[1] = w[1]!;
    t.styles[4] = w[1]!;
    t.styles[5] = w[1]!;
    t.patterns[0] = w[2]!;
    t.patterns[1] = w[3]!;
    t.patterns[2] = w[5]!;
    t.patterns[3] = w[4]!;
    if (st.segs & SEG_HORIZ) {
      t.patterns[4] = w[4]!;
      t.patterns[5] = w[5]!;
    }
    if (st.segs & SEG_VERT) {
      t.patterns[6] = w[4]!;
      t.patterns[7] = w[5]!;
    }
    return t;
  }

  /** TileWalls::SetPlacement. */
  setPlacement(value: number, seg: number): void {
    const i = segIndex(seg);
    if (i < 4) this.placement = (this.placement & ~(3 << (i * 2))) | (value << (i * 2));
  }

  /** TileWalls::GetStyle. */
  getStyle(seg: number): number {
    return this.styles[segIndex(seg)]!;
  }
}

/**
 * cFixedWorld::GetWall (world coordinates): the tile's record plus the
 * styles and placements of its 0x04 / 0x08 segments, which live in the
 * neighbors' 0x01 / 0x02.
 */
export function getWall(fixed: FixedWorld, x: number, y: number, level: number): TileWalls {
  const t = TileWalls.fromStorage(fixed.wallStorage(x, y, level));
  const n = fixed.size - 1;
  if (y < n) {
    const s = fixed.wallStorage(x, y + 1, level);
    if (s.segs & SEG_TR) {
      t.styles[3] = s.w[1]!;
      t.setPlacement((s.placement >> 2) & 3, SEG_BL);
    }
  }
  if (x < n) {
    const s = fixed.wallStorage(x + 1, y, level);
    if (s.segs & SEG_TL) {
      t.styles[2] = s.w[0]!;
      t.setPlacement(s.placement & 3, SEG_BR);
    }
  }
  return t;
}

/** Segment bits of a tile record, 0 outside the lot's interior (AnalyzeWallVertex's bounds test). */
function interiorSegs(fixed: FixedWorld, x: number, y: number, level: number): number {
  const n = fixed.size - 1;
  if (x < 1 || x >= n || y < 1 || y >= n) return 0;
  return fixed.wallStorage(x, y, level).segs;
}

/** cFixedWorld::AnalyzeWallVertex: configuration bits of grid point (x, y). */
export function analyzeWallVertex(fixed: FixedWorld, x: number, y: number, level: number): number {
  const t0 = interiorSegs(fixed, x - 1, y - 1, level);
  const t1 = interiorSegs(fixed, x, y - 1, level);
  const t2 = interiorSegs(fixed, x - 1, y, level);
  const t3 = interiorSegs(fixed, x, y, level);
  // lbl_105BEF88..A4 = 0x02, 0x10, 0x01, 0x80, 0x04, 0x20, 0x08, 0x40.
  let c = 0;
  if (t0 & SEG_BL) c |= 0x02;
  if (t0 & SEG_VERT) c |= 0x10;
  if (t1 & SEG_TL) c |= 0x01;
  if (t1 & SEG_HORIZ) c |= 0x80;
  if (t2 & SEG_BR) c |= 0x04;
  if (t2 & SEG_HORIZ) c |= 0x20;
  if (t3 & SEG_TR) c |= 0x08;
  if (t3 & SEG_VERT) c |= 0x40;
  return c;
}

/**
 * VertexConfig::GenerateLookups:
 *  - CONFIG_ROTATION[r - 1][c] (lbl_105BA3B4): configuration seen through r quarter turns;
 *  - VERTEX_JOINT[c] (lbl_105BAB3C): a wall turns or branches here;
 *  - VERTEX_END[c] (lbl_105BAB38): a single wall ends here.
 * Walls run between vertices of either kind.
 */
export const CONFIG_ROTATION: ReadonlyArray<Uint8Array> = [new Uint8Array(256), new Uint8Array(256), new Uint8Array(256)];
export const VERTEX_JOINT = new Uint8Array(256);
export const VERTEX_END = new Uint8Array(256);
(() => {
  // [bit, rot1, rot2, rot3] from the ori sequences.
  const rot: ReadonlyArray<readonly [number, number, number, number]> = [
    [0x01, 0x08, 0x04, 0x02],
    [0x02, 0x01, 0x08, 0x04],
    [0x04, 0x02, 0x01, 0x08],
    [0x08, 0x04, 0x02, 0x01],
    [0x10, 0x80, 0x40, 0x20],
    [0x20, 0x10, 0x80, 0x40],
    [0x40, 0x20, 0x10, 0x80],
    [0x80, 0x40, 0x20, 0x10],
  ];
  // TOC constants lbl_105C10F8..1124 (invalid combinations) and 1148..1184 (joints).
  const invalid: ReadonlyArray<readonly [number, number, number]> = [
    [0x10, 0x01, 0x02],
    [0x20, 0x02, 0x04],
    [0x40, 0x04, 0x04],
    [0x80, 0x08, 0x01],
  ];
  const joint: ReadonlyArray<readonly [number, number]> = [
    [0x01, 0xfa],
    [0x02, 0xf5],
    [0x08, 0xf5],
    [0x08, 0xf5],
    [0x10, 0xaf],
    [0x40, 0xaf],
    [0x80, 0x5f],
    [0x20, 0x5f],
  ];
  for (let c = 0; c < 256; c++) {
    for (const [b, r1, r2, r3] of rot) {
      if (c & b) {
        CONFIG_ROTATION[0]![c] = CONFIG_ROTATION[0]![c]! | r1;
        CONFIG_ROTATION[1]![c] = CONFIG_ROTATION[1]![c]! | r2;
        CONFIG_ROTATION[2]![c] = CONFIG_ROTATION[2]![c]! | r3;
      }
    }
    const valid = !invalid.some(([d, a, b]) => (c & d) !== 0 && ((c & a) !== 0 || (c & b) !== 0));
    if (!valid) continue;
    if (joint.some(([a, b]) => (c & a) !== 0 && (c & b) !== 0)) VERTEX_JOINT[c] = 1;
    let bits = 0;
    for (let v = c; v; v &= v - 1) bits++;
    if (bits === 1) VERTEX_END[c] = 1;
  }
})();

/** Rotate a configuration by `delta` quarter turns (no-op for 0). */
export function rotateConfig(c: number, delta: number): number {
  return delta === 0 ? c : CONFIG_ROTATION[delta - 1]![c]!;
}
