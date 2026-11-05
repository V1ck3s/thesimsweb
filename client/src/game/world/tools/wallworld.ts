/**
 * Writing walls: cFixedWorld::SetWall, TileWalls::Rotate and the view-space
 * wall accessors of cRotatableWorld (GetWall / SetWall), plus the raw
 * TileWallStorage records WallUndoable backs up and swaps.
 *
 * TileWalls (tilewalls.ts) holds the segment bits, the styles by segment bit
 * index and eight pattern slots:
 *   [0..3] the ortho segments' patterns facing the tile,
 *   [4] / [5] the 0x10 diagonal's sides 2 / 4, [6] / [7] the 0x20 diagonal's sides 1 / 3.
 * A diagonal tile keeps its two half floors in styles[0] (sides 1 / 2) and
 * patterns[0] (sides 3 / 4).
 *
 * Diagonal sides turn with the view (TileWalls::GenerateRotationLookups,
 * lbl_105BA55C): side s seen through r quarter turns is ((s - 1 + r) & 3) + 1.
 */

import { getWall, SEG_HORIZ, SEG_ROTATION, SEG_VERT, segIndex, TileWalls } from "../tilewalls.js";
import type { FixedWorld, RotatableWorld } from "../world.js";

/** Bytes of a TileWallStorage record. */
export const WALL_RECORD = 14;

/** lbl_105BA55C: a diagonal side seen through `r` quarter turns. */
export function rotateSide(side: number, r: number): number {
  return ((side - 1 + r) & 3) + 1;
}

/**
 * The pattern slot of a segment side (the loop over the eight slots in
 * TileWalls::Rotate and WallpaperUndoable::ChangeTile): slots 0..3 are the
 * ortho segments (side 0), 4 / 5 the sides 2 / 4 of 0x10, 6 / 7 the sides
 * 1 / 3 of 0x20; side 0 of a diagonal means 4 for 0x10, 1 for 0x20. -1 for a
 * side the segment does not have.
 */
export function patternSlot(seg: number, side: number): number {
  let s = side;
  if (seg === SEG_HORIZ && s === 0) s = 4;
  else if (seg === SEG_VERT && s === 0) s = 1;
  for (let i = 0; i < 8; i++) {
    let bit = 1 << i;
    let bs = 0;
    if (bit === 0x10) bs = 2;
    else if (bit === 0x20) {
      bs = 4;
      bit = 0x10;
    } else if (bit === 0x40) {
      bs = 1;
      bit = 0x20;
    } else if (bit === 0x80) {
      bs = 3;
      bit = 0x20;
    }
    if (seg & bit && bs === s) return i;
  }
  return -1;
}

/** The slot a tool writes a new wall's pattern to (side 0; 0x10 -> side 4, 0x20 -> side 1). */
export function frontSlot(seg: number): number {
  return seg === SEG_HORIZ ? 5 : seg === SEG_VERT ? 6 : segIndex(seg);
}

export function cloneWalls(t: TileWalls): TileWalls {
  const c = new TileWalls();
  c.segs = t.segs;
  c.placement = t.placement;
  c.styles.set(t.styles);
  c.patterns.set(t.patterns);
  return c;
}

/** TileWalls::Rotate(r): the walls seen through `r` quarter turns. */
export function rotateWalls(t: TileWalls, r: number): TileWalls {
  r &= 3;
  if (r === 0) return cloneWalls(t);
  const out = new TileWalls();
  const rot = SEG_ROTATION[r]!;
  for (let seg = 1; seg <= 0x20; seg <<= 1) {
    if (!(t.segs & seg)) continue;
    const ns = rot[seg]!;
    out.segs |= ns;
    out.styles[segIndex(ns)] = t.styles[segIndex(seg)]!;
    if (seg === SEG_HORIZ || seg === SEG_VERT) {
      const sides: Array<[number, number]> =
        seg === SEG_VERT
          ? [
              [1, t.patterns[6]!],
              [3, t.patterns[7]!],
            ]
          : [
              [2, t.patterns[4]!],
              [4, t.patterns[5]!],
            ];
      for (const [side, pat] of sides) out.patterns[patternSlot(ns, rotateSide(side, r))] = pat;
      // The half floors follow their sides.
      const halves: Array<[number, number]> =
        seg === SEG_VERT
          ? [
              [1, t.styles[0]!],
              [3, t.patterns[0]!],
            ]
          : [
              [2, t.styles[0]!],
              [4, t.patterns[0]!],
            ];
      for (const [side, v] of halves) {
        const s = rotateSide(side, r);
        if (s === 1 || s === 2) out.styles[0] = v;
        else out.patterns[0] = v;
      }
    } else {
      out.patterns[segIndex(ns)] = t.patterns[segIndex(seg)]!;
    }
    const i = segIndex(seg);
    const pl = i < 4 ? (t.placement >> (i * 2)) & 3 : 3;
    const j = segIndex(ns);
    if (j < 4) out.placement = (out.placement & ~(3 << (j * 2))) | (pl << (j * 2));
  }
  return out;
}

/** Raw record access (the c2DArray of TileWallStorage of a level). */
export function readWallRecord(fixed: FixedWorld, x: number, y: number, level: number, out: Uint8Array, at = 0): void {
  const a = fixed.walls[level - 1]!;
  const o = a.offset(x, y);
  out.set(a.data.subarray(o, o + WALL_RECORD), at);
}

export function writeWallRecord(fixed: FixedWorld, x: number, y: number, level: number, src: Uint8Array, at = 0): void {
  const a = fixed.walls[level - 1]!;
  a.data.set(src.subarray(at, at + WALL_RECORD), a.offset(x, y));
}

function setU16(d: Uint8Array, o: number, v: number): void {
  d[o] = v & 0xff;
  d[o + 1] = (v >> 8) & 0xff;
}

/**
 * cFixedWorld::SetWall (world coordinates): the tile's record, and the
 * neighbors' 0x01 / 0x02 for its 0x04 / 0x08 (style, placement; cleared with
 * their facing pattern when the segment goes). The vertex configurations are
 * recomputed by the wall manager's rebuild.
 */
export function setFixedWall(fixed: FixedWorld, x: number, y: number, level: number, t: TileWalls): void {
  const a = fixed.walls[level - 1]!;
  const d = a.data;
  const n = fixed.size - 1;
  const o = a.offset(x, y);
  const rec = (tx: number, ty: number): number => a.offset(tx, ty);
  if (t.segs & SEG_HORIZ) {
    d[o] = SEG_HORIZ;
    setU16(d, o + 4, t.styles[4]!);
    setU16(d, o + 10, t.patterns[4]!);
    setU16(d, o + 12, t.patterns[5]!);
    setU16(d, o + 2, t.styles[0]!);
    setU16(d, o + 6, t.patterns[0]!);
  } else {
    d[o] = d[o]! & 0xef;
  }
  if (t.segs & SEG_VERT) {
    d[o] = SEG_VERT;
    setU16(d, o + 4, t.styles[5]!);
    setU16(d, o + 10, t.patterns[6]!);
    setU16(d, o + 12, t.patterns[7]!);
    setU16(d, o + 2, t.styles[0]!);
    setU16(d, o + 6, t.patterns[0]!);
  } else {
    d[o] = d[o]! & 0xdf;
  }
  const placement = (seg: number): number => {
    const i = segIndex(seg);
    return i < 4 ? (t.placement >> (i * 2)) & 3 : 3;
  };
  // 0x01: own style / pattern; the tile at x - 1 gets 0x04.
  if (t.segs & 0x01) {
    d[o] = d[o]! | 0x01;
    setU16(d, o + 2, t.styles[0]!);
    setU16(d, o + 6, t.patterns[0]!);
    d[o + 1] = d[o + 1]! | placement(0x01);
    if (x > 0) d[rec(x - 1, y)] = d[rec(x - 1, y)]! | 0x04;
  } else if (d[o]! & 0x01) {
    d[o] = d[o]! & 0xfe;
    if (x > 0) {
      const p = rec(x - 1, y);
      d[p] = d[p]! & 0xfb;
      setU16(d, p + 12, 0);
    }
  }
  // 0x02: own style / pattern; the tile at y - 1 gets 0x08.
  if (t.segs & 0x02) {
    d[o] = d[o]! | 0x02;
    setU16(d, o + 4, t.styles[1]!);
    setU16(d, o + 8, t.patterns[1]!);
    d[o + 1] = d[o + 1]! | (placement(0x02) << 2);
    if (y > 0) d[rec(x, y - 1)] = d[rec(x, y - 1)]! | 0x08;
  } else if (d[o]! & 0x02) {
    d[o] = d[o]! & 0xfd;
    if (y > 0) {
      const p = rec(x, y - 1);
      d[p] = d[p]! & 0xf7;
      setU16(d, p + 10, 0);
    }
  }
  // 0x04: the pattern facing this tile; style and placement live in x + 1's 0x01.
  if (t.segs & 0x04) {
    d[o] = d[o]! | 0x04;
    setU16(d, o + 12, t.patterns[2]!);
    if (x < n) {
      const p = rec(x + 1, y);
      d[p] = d[p]! | 0x01;
      setU16(d, p + 2, t.styles[2]!);
      d[p + 1] = d[p + 1]! | placement(0x04);
    }
  } else if (d[o]! & 0x04) {
    d[o] = d[o]! & 0xfb;
    if (x < n) {
      const p = rec(x + 1, y);
      d[p] = d[p]! & 0xfe;
      setU16(d, p + 6, 0);
    }
  }
  // 0x08: the pattern facing this tile; style and placement live in y + 1's 0x02.
  if (t.segs & 0x08) {
    d[o] = d[o]! | 0x08;
    setU16(d, o + 10, t.patterns[3]!);
    if (y < n) {
      const p = rec(x, y + 1);
      d[p] = d[p]! | 0x02;
      setU16(d, p + 4, t.styles[3]!);
      d[p + 1] = d[p + 1]! | (placement(0x08) << 2);
    }
  } else if (d[o]! & 0x08) {
    d[o] = d[o]! & 0xf7;
    if (y < n) {
      const p = rec(x, y + 1);
      d[p] = d[p]! & 0xfd;
      setU16(d, p + 8, 0);
    }
  }
}

/** cRotatableWorld::GetWall: a view tile's walls in view coordinates (TileWalls::ConvertToViewCoords). */
export function getViewWall(world: RotatableWorld, x: number, y: number, level: number): TileWalls {
  const [wx, wy] = world.toWorld(x, y);
  return rotateWalls(getWall(world.fixed, wx, wy, level), world.rotation);
}

/** cRotatableWorld::SetWall: view-space walls back to world space, then cFixedWorld::SetWall. */
export function setViewWall(world: RotatableWorld, x: number, y: number, level: number, t: TileWalls): void {
  const [wx, wy] = world.toWorld(x, y);
  setFixedWall(world.fixed, wx, wy, level, rotateWalls(t, (4 - world.rotation) & 3));
}

/** cRotatableWorld::SetFloor (a view tile's floor pattern). */
export function setViewFloor(world: RotatableWorld, x: number, y: number, level: number, pattern: number): void {
  const [wx, wy] = world.toWorld(x, y);
  const a = world.fixed.floors[level - 1]!;
  setU16(a.data, a.offset(wx, wy), pattern);
}

/** cRotatableWorld::MayEditTile: the tile's flags have no 0x20 (lot-protected) bit, or the build-anywhere cheat. */
export function mayEditTile(world: RotatableWorld, x: number, y: number, level: number, anywhere = false): boolean {
  if (anywhere) return true;
  return (world.getFlags(x, y, level) & 0x20) === 0;
}
