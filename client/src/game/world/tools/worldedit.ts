/**
 * The world edits the floor and wallpaper tools make, in view coordinates:
 * cRotatableWorld::GetWall / SetWall / SetFloor / HasWalls / MayEditTile,
 * TileWalls::Rotate (ConvertToViewCoords), cFixedWorld::SetWall and the
 * Room** overload of RoomManager::ResolveDiagonal.
 *
 * The wall primitives (TileWalls::Rotate, cFixedWorld::SetWall, the pattern
 * slots) live in wallworld.ts; this module carries the rotation a TileWalls
 * is expressed in (+0x24) alongside it: GetWall rotates the world record
 * into the view (ConvertToViewCoords), SetWall rotates it back
 * (Rotate(4 - rotation)) before cFixedWorld::SetWall writes the
 * TileWallStorage records.
 *
 * On a tile with a diagonal wall, the two floor halves live in the
 * TileWalls' styles[0] (sides 1 and 2) and patterns[0] (sides 3 and 4),
 * stored as w0 / w2 of the record (the tile's floor is then 0xff).
 */

import type { Room, RoomManager } from "../rooms.js";
import { getWall, SEG_ROTATION, type TileWalls } from "../tilewalls.js";
import type { FixedWorld, RotatableWorld } from "../world.js";
import { cloneWalls, mayEditTile as mayEditViewTile, rotateSide, rotateWalls as rotateTileWalls, setFixedWall, setViewFloor } from "./wallworld.js";

export { patternSlot } from "./wallworld.js";

/** TileWalls::GenerateRotationLookups (lbl_105BA55C): a diagonal side (1..4, 0 = none) after r quarter turns. */
export const DIAG_SIDE_ROTATION: ReadonlyArray<readonly number[]> = [0, 1, 2, 3].map((r) =>
  [0, 1, 2, 3, 4].map((s) => (s === 0 ? 0 : rotateSide(s, r))),
);

/** A TileWalls and the rotation it is expressed in (TileWalls +0x24). */
export interface RotWalls {
  t: TileWalls;
  rot: number;
}

/** TileWalls copy (the 0x2c-byte memcpy). */
export const copyWalls: (src: TileWalls) => TileWalls = cloneWalls;

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
  return { t: rotateTileWalls(src.t, r), rot: (src.rot + r) & 3 };
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

/** cFixedWorld::SetWall (world tile), after rotating the walls back to world space. */
export function fixedSetWall(fixed: FixedWorld, x: number, y: number, level: number, w: RotWalls): void {
  setFixedWall(fixed, x, y, level, w.rot !== 0 ? rotateTileWalls(w.t, 4 - w.rot) : w.t);
}

/** cRotatableWorld::HasWalls(view tile, view segment). */
export function hasWalls(world: RotatableWorld, x: number, y: number, level: number, seg: number): boolean {
  const m = SEG_ROTATION[(4 - world.rotation) & 3]![seg]!;
  return (m & world.getWallStorage(x, y, level).segs) === m;
}

/** cRotatableWorld::SetFloor (view tile). */
export const setFloor: (world: RotatableWorld, x: number, y: number, level: number, pattern: number) => void = setViewFloor;

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
  return mayEditViewTile(world, x, y, 1);
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
