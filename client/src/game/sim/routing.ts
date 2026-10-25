/**
 * Person routing: RoutingSlot goals, a tile path and its following.
 *
 * What the original does (XRoute.cpp, cXPerson::TryGotoRoutingSlot,
 * SAnimator::BeginFollow / FollowOneStep / EndFollow): XRoute builds route
 * goals from the object's routing slot (SLOT records of type 3: proximity
 * min / max / optimal in 1/16 tile, allowed directions around the object,
 * facing), finds a path over the tiles (walls, objects, other people, rooms,
 * altitudes, stairs), and the animator walks it with the standard walking
 * skills (start, loop, turns, stop), the person's position following the
 * walk animation's root displacement. A state machine (lbl_105BBB3C, 18
 * states) handles blocked routes, retries and failure trees.
 *
 * This port keeps the primitive interface and results but simplifies the
 * route: goals are the tile centers at the slot's distances in the allowed
 * directions (scored by distance to the optimal proximity), the path is an
 * A* over 8-connected tiles of the person's level (blocked by walls - door
 * tiles excepted - and by objects that do not allow person intersection),
 * and the person moves along it at the walking loop's speed (its distance
 * over its duration), turning at once at each corner. Other people,
 * stairs, room permissions, altitude and failure trees are not handled.
 */

import type { SlotDescriptor } from "../world/slots.js";

/** Direction n (0..7, cXObject +0x4c / DirectionTo) as a world tile step. */
export const DIR_VEC: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

/** The direction (0..7) of a vector, as DirectionTo rounds it. */
export function dirOf(dx: number, dy: number): number {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  let d = ax * 2 < ay ? 4 : ay * 2 < ax ? 2 : 3;
  if (dx < 0) {
    if (d === 3) d = 5;
    else if (d === 2) d = 6;
  }
  if (dy < 0) {
    if (d === 4) d = 0;
    else if (d === 3) d = 1;
    else if (d === 5) d = 7;
  }
  return d & 7;
}

/** A continuous direction (0..8, 45 degree units) of a vector. */
export function angleDirOf(dx: number, dy: number): number {
  // Direction 0 is -y, 2 is +x: angle measured clockwise from -y.
  const a = Math.atan2(dx, -dy);
  let d = (a / (Math.PI / 4) + 8) % 8;
  if (d < 0) d += 8;
  return d;
}

/** Facing of a routing slot (SLOT +0x40): -3 any, -2 towards the object, -1 away from it, 0..7 a direction relative to the object. */
export const FACE_ANY = -3;
export const FACE_TOWARDS = -2;
export const FACE_AWAY = -1;

/** RoutingSlot (0x3c bytes), the fields used here. */
export interface RoutingSlot {
  /** Offsets from the object (1/16 tile), used when no direction is allowed. */
  x: number;
  y: number;
  /** +0x30 / +0x34 / +0x38: proximities in 1/16 tile. */
  minProximity: number;
  maxProximity: number;
  optimalProximity: number;
  /** +0x1c flags: bits 0..7 allowed directions, 0x100 any rotation, 0x200 absolute directions, 0x4000 allow failure trees. */
  flags: number;
  facing: number;
  /** +0x20 (descriptor +0x2c): the object slot a Snap puts the person in (< 0: the x / y offset instead). */
  snapTarget: number;
}

/** SlotLoader for a SLOT record of type 3. */
export function routingSlotFrom(d: SlotDescriptor): RoutingSlot {
  return {
    x: d.x,
    y: d.y,
    minProximity: d.f30,
    maxProximity: d.f34,
    optimalProximity: d.f38,
    flags: d.flags,
    facing: d.f40,
    snapTarget: d.f2c,
  };
}

export interface RouteGoal {
  /** Tile. */
  tx: number;
  ty: number;
  /** Position (1/16 tile). */
  fx: number;
  fy: number;
  score: number;
  /** Direction to face on arrival (-1: keep). */
  facing: number;
}

/** XRoute::ConstructGoals (simplified): goal tiles around the object at (ox, oy) facing `odir`. */
export function buildGoals(slot: RoutingSlot, ox: number, oy: number, odir: number): RouteGoal[] {
  const goals: RouteGoal[] = [];
  const dirs = slot.flags & 0xff;
  const absolute = (slot.flags & 0x200) !== 0;
  const add = (fx: number, fy: number, score: number): void => {
    const tx = fx >> 4;
    const ty = fy >> 4;
    const cx = tx * 16 + 8;
    const cy = ty * 16 + 8;
    let facing = -1;
    const toward = dirOf(ox - cx, oy - cy);
    if (slot.facing === FACE_TOWARDS) facing = cx === ox && cy === oy ? odir : toward;
    else if (slot.facing === FACE_AWAY) facing = (toward + 4) & 7;
    else if (slot.facing >= 0) facing = (slot.facing + odir) & 7;
    const prev = goals.find((g) => g.tx === tx && g.ty === ty);
    if (prev) {
      if (score < prev.score) {
        prev.score = score;
        prev.facing = facing;
      }
      return;
    }
    goals.push({ tx, ty, fx: cx, fy: cy, score, facing });
  };
  if (dirs === 0) {
    // No direction: the slot's own offset, rotated with the object.
    const [fx, fy] = rotateOffset(slot.x, slot.y, absolute ? 0 : odir);
    add(Math.round(ox + fx), Math.round(oy + fy), 0);
    return goals;
  }
  const minP = Math.max(0, slot.minProximity);
  const maxP = Math.max(minP, slot.maxProximity);
  const opt = slot.optimalProximity > 0 ? slot.optimalProximity : minP;
  for (let k = 0; k < 8; k++) {
    if (!(dirs & (1 << k))) continue;
    const d = absolute ? k : (k + odir) & 7;
    const [vx, vy] = DIR_VEC[d]!;
    for (let r = minP; r <= maxP; r += 8) {
      add(Math.round(ox + vx * r), Math.round(oy + vy * r), Math.abs(r - opt) / 16);
      if (maxP === minP) break;
    }
  }
  return goals;
}

/** Rotate an offset (1/16 tile, as for a direction-0 object) to direction `dir` (even values). */
export function rotateOffset(x: number, y: number, dir: number): [number, number] {
  switch ((dir >> 1) & 3) {
    case 0:
      return [x, y];
    case 1:
      return [-y, x];
    case 2:
      return [-x, -y];
    default:
      return [y, -x];
  }
}

/** What blocks a person on the lot. */
export interface RouteWorld {
  size: number;
  /** A tile a person cannot stand on (objects, out of the lot). */
  blocked(tx: number, ty: number, level: number): boolean;
  /** A wall between two orthogonal neighbors. */
  wallBetween(ax: number, ay: number, bx: number, by: number, level: number): boolean;
}

/** XRoute::FindPath (simplified A*): tiles from the start to the best goal, null when unreachable. */
export function findPath(world: RouteWorld, sx: number, sy: number, level: number, goals: readonly RouteGoal[], maxNodes = 6000): { path: Array<[number, number]>; goal: RouteGoal } | null {
  const n = world.size;
  const key = (x: number, y: number): number => y * n + x;
  const goalAt = new Map<number, RouteGoal>();
  for (const g of goals) {
    if (g.tx < 0 || g.ty < 0 || g.tx >= n || g.ty >= n) continue;
    if (world.blocked(g.tx, g.ty, level) && !(g.tx === sx && g.ty === sy)) continue;
    goalAt.set(key(g.tx, g.ty), g);
  }
  if (goalAt.size === 0) return null;
  const h = (x: number, y: number): number => {
    let best = Infinity;
    for (const g of goalAt.values()) best = Math.min(best, Math.max(Math.abs(g.tx - x), Math.abs(g.ty - y)) + g.score);
    return best;
  };
  const gScore = new Map<number, number>();
  const came = new Map<number, number>();
  const open: Array<{ k: number; f: number }> = [];
  const sk = key(sx, sy);
  gScore.set(sk, 0);
  open.push({ k: sk, f: h(sx, sy) });
  const closed = new Set<number>();
  let best: { k: number; cost: number } | null = null;
  let expanded = 0;
  while (open.length && expanded < maxNodes) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i]!.f < open[bi]!.f) bi = i;
    const { k, f } = open.splice(bi, 1)[0]!;
    if (closed.has(k)) continue;
    if (best && f >= best.cost) break;
    closed.add(k);
    expanded++;
    const x = k % n;
    const y = (k - x) / n;
    const g0 = gScore.get(k)!;
    const goal = goalAt.get(k);
    if (goal) {
      const cost = g0 + goal.score;
      if (!best || cost < best.cost) best = { k, cost };
    }
    for (let d = 0; d < 8; d++) {
      const [dx, dy] = DIR_VEC[d]!;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 1 || ny < 1 || nx >= n - 1 || ny >= n - 1) continue;
      const nk = key(nx, ny);
      if (closed.has(nk)) continue;
      if (world.blocked(nx, ny, level)) continue;
      if (dx !== 0 && dy !== 0) {
        // A diagonal step needs both orthogonal steps free.
        if (world.blocked(x + dx, y, level) || world.blocked(x, y + dy, level)) continue;
        if (world.wallBetween(x, y, x + dx, y, level) || world.wallBetween(x, y, x, y + dy, level)) continue;
        if (world.wallBetween(x + dx, y, nx, ny, level) || world.wallBetween(x, y + dy, nx, ny, level)) continue;
      } else if (world.wallBetween(x, y, nx, ny, level)) {
        continue;
      }
      const ng = g0 + (dx !== 0 && dy !== 0 ? Math.SQRT2 : 1);
      if (ng < (gScore.get(nk) ?? Infinity)) {
        gScore.set(nk, ng);
        came.set(nk, k);
        open.push({ k: nk, f: ng + h(nx, ny) });
      }
    }
  }
  if (!best) return null;
  const path: Array<[number, number]> = [];
  for (let k: number | undefined = best.k; k !== undefined; k = came.get(k)) {
    const x = k % n;
    path.push([x, (k - x) / n]);
  }
  path.reverse();
  return { path, goal: goalAt.get(best.k)! };
}

/** A route being walked (XRoute + the animator's follow state). */
export class Route {
  /** Points to walk through (1/16 tile), the first is the start position. */
  readonly points: Array<[number, number]> = [];
  index = 1;
  done = false;

  constructor(
    readonly goal: RouteGoal,
    start: [number, number],
    tiles: ReadonlyArray<readonly [number, number]>,
  ) {
    this.points.push(start);
    for (let i = 1; i < tiles.length; i++) {
      const [tx, ty] = tiles[i]!;
      this.points.push([tx * 16 + 8, ty * 16 + 8]);
    }
    this.points.push([goal.fx, goal.fy]);
  }

  /**
   * One tick of following (SAnimator::FollowOneStep): moves `speed` (1/16
   * tile) towards the next points; returns the new position and the walking
   * direction (continuous, 45 degree units).
   */
  step(pos: [number, number], speed: number): { pos: [number, number]; dir: number | null } {
    let [x, y] = pos;
    let left = speed;
    let dir: number | null = null;
    while (left > 0 && this.index < this.points.length) {
      const [px, py] = this.points[this.index]!;
      const dx = px - x;
      const dy = py - y;
      const dist = Math.hypot(dx, dy);
      if (dist > 1e-6) dir = angleDirOf(dx, dy);
      if (dist <= left) {
        x = px;
        y = py;
        left -= dist;
        this.index++;
      } else {
        x += (dx / dist) * left;
        y += (dy / dist) * left;
        left = 0;
      }
    }
    if (this.index >= this.points.length) this.done = true;
    return { pos: [x, y], dir };
  }
}
