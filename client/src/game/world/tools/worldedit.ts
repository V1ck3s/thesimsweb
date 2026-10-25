/**
 * The world edits the floor and wallpaper tools make, in view coordinates:
 * cRotatableWorld::GetWall / SetWall / SetFloor / HasWalls / MayEditTile,
 * TileWalls::Rotate (ConvertToViewCoords), cFixedWorld::SetWall and the
 * Room** overload of RoomManager::ResolveDiagonal.
 *
 * A TileWalls carries the rotation it is expressed in (+0x24): GetWall
 * rotates the world record into the view (ConvertToViewCoords), SetWall
 * rotates it back (Rotate(4 - rotation)) before cFixedWorld::SetWall writes
 * the TileWallStorage records.
 *
 * On a tile with a diagonal wall, the two floor halves live in the
 * TileWalls' styles[0] (sides 1 and 2) and patterns[0] (sides 3 and 4),
 * stored as w0 / w2 of the record (the tile's floor is then 0xff).
 *
 * Not done here: cFixedWorld::SetWall's AnalyzeWallVertex of the four
 * corners (the WallManager recomputes its vertex configurations when it
 * rebuilds; the floor and wallpaper tools never change segments).
 */

import type { Room, RoomManager } from "../rooms.js";
import { getWall, SEG_HORIZ, SEG_ROTATION, SEG_VERT, segIndex, TileWalls } from "../tilewalls.js";
import type { FixedWorld, RotatableWorld } from "../world.js";

/** TileWalls::GenerateRotationLookups (lbl_105BA55C): a diagonal side (1..4, 0 = none) after r quarter turns. */
export const DIAG_SIDE_ROTATION: ReadonlyArray<readonly number[]> = [0, 1, 2, 3].map((r) =>
  [0, 1, 2, 3, 4].map((s) => (s === 0 ? 0 : ((s - 1 + r) % 4) + 1)),
);

/** A TileWalls and the rotation it is expressed in (TileWalls +0x24). */
export interface RotWalls {
  t: TileWalls;
  rot: number;
}

/** TileWalls copy (the 0x2c-byte memcpy). */
export function copyWalls(src: TileWalls): TileWalls {
  const t = new TileWalls();
  t.segs = src.segs;
  t.placement = src.placement;
  t.styles.set(src.styles);
  t.patterns.set(src.patterns);
  return t;
}

/** TileWalls::GetPlacement. */
export function getPlacement(t: TileWalls, seg: number): number {
  const i = segIndex(seg);
  return i > 3 ? 3 : (t.placement >> (i * 2)) & 3;
}

/**
 * The pattern slot written for a segment and side (the loop over the eight
 * slots in TileWalls::Rotate and WallpaperUndoable::ChangeTile: slots 0..3
 * are the ortho segments (side 0), 4 / 5 the sides 2 / 4 of 0x10, 6 / 7 the
 * sides 1 / 3 of 0x20; side 0 of a diagonal means 4 for 0x10, 1 for 0x20).
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

/** Diagonal floor halves: sides 1 and 2 are styles[0], 3 and 4 patterns[0]. */
export function getDiagFloor(t: TileWalls, side: number): number {
  return side === 1 || side === 2 ? t.styles[0]! : t.patterns[0]!;
}

export function setDiagFloor(t: TileWalls, side: number, v: number): void {
  if (side === 1 || side === 2) t.styles[0] = v;
  else t.patterns[0] = v;
}

/** TileWalls::Rotate(r): the same walls seen through r more quarter turns. */
export function rotateWalls(src: RotWalls, r: number): RotWalls {
  const s = src.t;
  const d = copyWalls(s);
  d.segs = 0;
  const segRot = SEG_ROTATION[r & 3]!;
  const sides = DIAG_SIDE_ROTATION[r & 3]!;
  for (let old = 1; old < 0x40; old <<= 1) {
    if (!(s.segs & old)) continue;
    const nw = segRot[old]!;
    d.segs |= nw;
    if (nw === SEG_HORIZ || nw === SEG_VERT) {
      d.styles[0] = 0;
      d.patterns[0] = 0;
    }
    const style = s.styles[segIndex(old)]!;
    for (let b = 0; b < 6; b++) if (nw & (1 << b)) d.styles[b] = style;
    const put = (side: number, v: number): void => {
      const i = patternSlot(nw, side);
      if (i >= 0) d.patterns[i] = v;
    };
    const floorTo = (side: number, v: number): void => {
      if (side === 2 || side === 1) d.styles[0] = v;
      else d.patterns[0] = v;
    };
    if (old === SEG_VERT) {
      put(sides[1]!, s.patterns[6]!);
      put(sides[3]!, s.patterns[7]!);
      floorTo(sides[3]!, s.patterns[0]!);
      floorTo(sides[1]!, s.styles[0]!);
    } else if (old === SEG_HORIZ) {
      put(sides[2]!, s.patterns[4]!);
      put(sides[4]!, s.patterns[5]!);
      floorTo(sides[2]!, s.styles[0]!);
      floorTo(sides[4]!, s.patterns[0]!);
    } else {
      put(0, s.patterns[segIndex(old)]!);
    }
    const oi = segIndex(old);
    const place = oi < 4 ? (s.placement >> (oi * 2)) & 3 : 3;
    const ni = segIndex(nw);
    if (ni < 4) d.placement = (d.placement & ~(3 << (ni * 2))) | (place << (ni * 2));
  }
  return { t: d, rot: (src.rot + r) & 3 };
}

/** cRotatableWorld::GetWall: the walls of a view tile, in view coordinates. */
export function getViewWall(world: RotatableWorld, x: number, y: number, level: number): RotWalls {
  const [wx, wy] = world.toWorld(x, y);
  const w: RotWalls = { t: getWall(world.fixed, wx, wy, level), rot: 0 };
  // TileWalls::ConvertToViewCoords.
  return world.rotation !== 0 ? rotateWalls(w, world.rotation) : w;
}

/** cRotatableWorld::SetWall (view tile). */
export function setViewWall(world: RotatableWorld, x: number, y: number, level: number, w: RotWalls): void {
  const [wx, wy] = world.toWorld(x, y);
  fixedSetWall(world.fixed, wx, wy, level, w);
}

/** cFixedWorld::SetWall (world tile): the TileWalls back into the records of the tile and its neighbors. */
export function fixedSetWall(fixed: FixedWorld, x: number, y: number, level: number, w: RotWalls): void {
  const t = w.rot !== 0 ? rotateWalls(w, 4 - w.rot).t : w.t;
  const a = fixed.walls[level - 1]!;
  const d = a.data;
  const n = fixed.size;
  const o = a.offset(x, y);
  const put = (off: number, k: number, v: number): void => {
    d[off + 2 + k * 2] = v & 0xff;
    d[off + 3 + k * 2] = (v >> 8) & 0xff;
  };
  if (t.segs & SEG_HORIZ) {
    d[o] = SEG_HORIZ;
    put(o, 1, t.styles[4]!);
    put(o, 4, t.patterns[4]!);
    put(o, 5, t.patterns[5]!);
    put(o, 0, t.styles[0]!);
    put(o, 2, t.patterns[0]!);
  } else d[o] = d[o]! & 0xef;
  if (t.segs & SEG_VERT) {
    d[o] = SEG_VERT;
    put(o, 1, t.styles[5]!);
    put(o, 4, t.patterns[6]!);
    put(o, 5, t.patterns[7]!);
    put(o, 0, t.styles[0]!);
    put(o, 2, t.patterns[0]!);
  } else d[o] = d[o]! & 0xdf;
  if (t.segs & 1) {
    d[o] = d[o]! | 1;
    put(o, 0, t.styles[0]!);
    put(o, 2, t.patterns[0]!);
    d[o + 1] = d[o + 1]! | getPlacement(t, 1);
    if (x > 0) {
      const p = a.offset(x - 1, y);
      d[p] = d[p]! | 4;
    }
  } else if (d[o]! & 1) {
    d[o] = d[o]! & 0xfe;
    if (x > 0) {
      const p = a.offset(x - 1, y);
      d[p] = d[p]! & 0xfb;
      put(p, 5, 0);
    }
  }
  if (t.segs & 2) {
    d[o] = d[o]! | 2;
    put(o, 1, t.styles[1]!);
    put(o, 3, t.patterns[1]!);
    d[o + 1] = d[o + 1]! | (getPlacement(t, 2) << 2);
    if (y > 0) {
      const p = a.offset(x, y - 1);
      d[p] = d[p]! | 8;
    }
  } else if (d[o]! & 2) {
    d[o] = d[o]! & 0xfd;
    if (y > 0) {
      const p = a.offset(x, y - 1);
      d[p] = d[p]! & 0xf7;
      put(p, 4, 0);
    }
  }
  if (t.segs & 4) {
    d[o] = d[o]! | 4;
    put(o, 5, t.patterns[2]!);
    if (x < n - 1) {
      const p = a.offset(x + 1, y);
      d[p] = d[p]! | 1;
      put(p, 0, t.styles[2]!);
      d[p + 1] = d[p + 1]! | getPlacement(t, 4);
    }
  } else if (d[o]! & 4) {
    d[o] = d[o]! & 0xfb;
    if (x < n - 1) {
      const p = a.offset(x + 1, y);
      d[p] = d[p]! & 0xfe;
      put(p, 2, 0);
    }
  }
  if (t.segs & 8) {
    d[o] = d[o]! | 8;
    put(o, 4, t.patterns[3]!);
    if (y < n - 1) {
      const p = a.offset(x, y + 1);
      d[p] = d[p]! | 2;
      put(p, 1, t.styles[3]!);
      d[p + 1] = d[p + 1]! | (getPlacement(t, 8) << 2);
    }
  } else if (d[o]! & 8) {
    d[o] = d[o]! & 0xf7;
    if (y < n - 1) {
      const p = a.offset(x, y + 1);
      d[p] = d[p]! & 0xfd;
      put(p, 3, 0);
    }
  }
}

/** cRotatableWorld::HasWalls(view tile, view segment). */
export function hasWalls(world: RotatableWorld, x: number, y: number, level: number, seg: number): boolean {
  const m = SEG_ROTATION[(4 - world.rotation) & 3]![seg]!;
  return (m & world.getWallStorage(x, y, level).segs) === m;
}

/** cRotatableWorld::SetFloor (view tile). */
export function setFloor(world: RotatableWorld, x: number, y: number, level: number, pattern: number): void {
  const [wx, wy] = world.toWorld(x, y);
  const a = world.fixed.floors[level - 1]!;
  const o = a.offset(wx, wy);
  a.data[o] = pattern & 0xff;
  a.data[o + 1] = (pattern >> 8) & 0xff;
}

/** cFixedWorld floors array write (world tile). */
export function setFixedFloor(fixed: FixedWorld, x: number, y: number, level: number, pattern: number): void {
  const a = fixed.floors[level - 1]!;
  const o = a.offset(x, y);
  a.data[o] = pattern & 0xff;
  a.data[o + 1] = (pattern >> 8) & 0xff;
}

/** The pool layer (cFixedWorld::GetPoolLayer) at a world tile, and its write. */
export function getPool(fixed: FixedWorld, x: number, y: number): number {
  return fixed.pool.u8(x, y);
}

export function setPool(fixed: FixedWorld, x: number, y: number, v: number): void {
  fixed.pool.data[fixed.pool.offset(x, y)] = v & 0xff;
}

/**
 * cRotatableWorld::MayEditTile (view tile): bit 5 of the ground floor's
 * flags is clear (lbl_105BA244, the edit-anywhere switch, is off).
 */
export function mayEditTile(world: RotatableWorld, x: number, y: number): boolean {
  const [wx, wy] = world.toWorld(x, y);
  return (world.fixed.flags[0]!.u8(wx, wy) & 0x20) === 0;
}

/** RoomManager::ResolveDiagonal(CTilePt, Room**, Room**, Sides*, Sides*) (world tile). */
export function resolveDiagonal(
  rooms: RoomManager,
  x: number,
  y: number,
  level: number,
): { found: boolean; room1: Room | null; room2: Room | null; side1: number; side2: number } {
  const n = rooms.diagonalNode(x, y, level);
  if (n.side1 === 0) {
    const r = rooms.getRoom(rooms.fixed.rooms[level - 1]!.u16(x, y));
    return { found: false, room1: r, room2: r, side1: 0, side2: 0 };
  }
  return { found: true, room1: rooms.getRoom(n.room1), room2: rooms.getRoom(n.room2), side1: n.side1, side2: n.side2 };
}

/** The room sides of ResolveDiagonal seen from the view, as the tools convert them. */
export function viewSide(side: number, rotation: number): number {
  return side === 0 ? 0 : ((side + ((4 - rotation) & 3) - 1) & 3) + 1;
}
