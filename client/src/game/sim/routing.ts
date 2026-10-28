/**
 * Person routing: RoutingSlot, XRoute (XRoute.cpp / XRouting.cpp) and the
 * room helpers it uses (ResolveRoomID, GetWallBlockFlagsAtTile, SectWall).
 *
 * XRoute (0x9c bytes) holds the goals (vector<RouteGoal>), a copy of the
 * routing slot (+0xc), the target (+0x48) and the person (+0x4c), the
 * current goal (+0x50), the best goal score (+0x54), the blocked-state
 * counters (+0x58 stage, +0x5c wait tick, +0x60/+0x64 the position when
 * blocked), the portal walked through (+0x68), the starting point
 * (+0x6c/+0x70, +0x74 its direction flags), the "loaded" flag (+0x78), the
 * person to ignore (+0x7c), the person asked to move (+0x80, +0x84 asked,
 * +0x90 the interaction pushed), the route result (+0x88), the blocking
 * object (+0x8c), the person's footprint (+0x94, person data 72) and the
 * maximum goal count (+0x98).
 *
 * ConstructGoals, EvalTileForGoal, ChooseStartingPoint, BuildGoalList,
 * ShouldIgnore, IsPersonSittingOnChairGoal and TransformToWorldCoords are
 * ported from the decompiled code. XRoute::FindPath is not: the original
 * builds a SpacePartition of penalty rectangles (BuildRoomPartition, the
 * objects' footprints with ShouldIgnore, the goals as rectangles weighted
 * (best score - score) * 16) and searches it with Path; the port searches
 * the same constraints (the person's room, walls through SectWall, the
 * footprints inflated by the person's half width, weight 0x7fffffff or 10
 * for objects with a route penalty, goal weights) on a 4-unit lattice with
 * A*, then shortens the polyline where the line of sight is clear.
 */

import type { FixedWorld } from "../world/world.js";
import type { SlotDescriptor } from "../world/slots.js";
import { getWall, segIndex } from "../world/tilewalls.js";
import type { XObject } from "../world/objects.js";
import type { SimModule } from "./simmodule.js";
import type { SimObject } from "./xobject.js";
import { EP } from "./objfntable.js";

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

/** The direction (0..7) of a vector, as the inline DirectionTo of ConstructGoals / InitRoute rounds it (x, y deltas). */
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

/** A continuous direction (0..8, 45 degree units) of a vector: 0 is -y, 2 is +x. */
export function angleDirOf(dx: number, dy: number): number {
  const a = Math.atan2(dx, -dy);
  let d = (a / (Math.PI / 4) + 8) % 8;
  if (d < 0) d += 8;
  return d;
}

/** RoutingSlot facing (+0x34): -3 any (AllowAnyFacing), -2 towards the object (FaceTowardsObject, the default), -1 away, 0..7 relative to the object. */
export const FACE_ANY = -3;
export const FACE_TOWARDS = -2;
export const FACE_AWAY = -1;

/** RoutingSlot flags (+0x1c) above the 8 direction bits. */
export const RSF = {
  anyRotation: 0x100,
  absolute: 0x200,
  ignoreRooms: 0x800,
  randomScore: 0x2000,
  failureTrees: 0x4000,
  ignoreAltitude: 0x8000,
  averageLocation: 0x10000,
} as const;

/** RoutingSlot (0x3c bytes). */
export interface RoutingSlot {
  /** +0 / +4 / +8: offset from the object (1/16 tile). */
  x: number;
  y: number;
  z: number;
  /** +0xc: SLOT record index + 1 (-1 made on the fly). */
  index: number;
  /** +0x10 / +0x14 / +0x18: goal weights standing, sitting, on the ground. */
  multipliers: [number, number, number];
  /** +0x1c: RSF and the allowed directions (bits 0..7). */
  flags: number;
  /** +0x20: the object slot a Snap uses (-1: none). */
  snapTarget: number;
  /** +0x24 / +0x28 / +0x2c: proximities (1/16 tile). */
  minProximity: number;
  maxProximity: number;
  optimalProximity: number;
  /** +0x30: score lost per unit away from the optimal proximity. */
  gradient: number;
  /** +0x34: FACE_* or 0..7. */
  facing: number;
  /** +0x38: goal sampling step (1/16 tile). */
  resolution: number;
}

/** RoutingSlot::RoutingSlot. */
export function newRoutingSlot(): RoutingSlot {
  return {
    x: 0,
    y: 0,
    z: 0,
    index: -1,
    multipliers: [0, 0, 0],
    flags: 0,
    snapTarget: -1,
    minProximity: 16,
    maxProximity: 16,
    optimalProximity: 16,
    gradient: 0.1875,
    facing: FACE_TOWARDS,
    resolution: 16,
  };
}

export function copyRoutingSlot(s: RoutingSlot): RoutingSlot {
  return { ...s, multipliers: [...s.multipliers] };
}

/** SlotLoader::Load for a SLOT record of type 3 (record `i`). */
export function routingSlotFrom(d: SlotDescriptor, i = -2): RoutingSlot {
  return {
    x: d.x,
    y: d.y,
    z: d.z,
    index: i + 1,
    multipliers: [d.f1c, d.f20, d.f24],
    flags: d.flags,
    snapTarget: d.f2c,
    minProximity: d.f30,
    maxProximity: d.f34,
    optimalProximity: d.f38,
    gradient: d.f3c,
    facing: d.f40,
    resolution: d.f44,
  };
}

/** RoutingSlot::SetTileDistances (tiles -> 1/16, truncated). */
export function setTileDistances(s: RoutingSlot, min: number, max: number, opt: number): void {
  s.minProximity = Math.trunc(16 * min);
  s.maxProximity = Math.trunc(16 * max);
  s.optimalProximity = Math.trunc(16 * opt);
}

/** RoutingSlot::AllowDirection. */
export function allowDirection(s: RoutingSlot, d: number): void {
  if (d >= 0 && d <= 7) s.flags |= 1 << d;
}

/** RouteGoal (0x10 bytes): position, score, chair (+0xc), direction flags (+0xe). */
export interface RouteGoal {
  fy: number;
  fx: number;
  score: number;
  chair: number;
  dirFlags: number;
}

/** Route results (person data 62, Behavior.iff STR# 241). */
export const ROUTE = {
  success: 0,
  unknown: 1,
  roomUnreachable: 2,
  noPath: 3,
  interrupted: 4,
  couldNotSit: 5,
  couldNotStand: 6,
  noValidGoals: 7,
  destOccupied: 8,
  chairOccupied: 9,
  noChair: 10,
  wallInWay: 11,
  altitudes: 12,
  personInWay: 13,
} as const;

/** cXObject::IsInWorld-ish test for the router: on a lot tile, not held. */
function tileOutOfBounds(fixed: FixedWorld, x: number, y: number): boolean {
  return x < 1 || y < 1 || x >= fixed.size - 1 || y >= fixed.size - 1;
}

const ROOM_DEGENERATE = 0xfffb;

/**
 * ResolveRoomID(FTilePt, level): the room array value; on a tile split by a
 * diagonal wall, the room of the neighbour on the point's side (then of the
 * other neighbour). 0xfffb (-5) off the lot.
 */
export function resolveRoomID(fixed: FixedWorld, fx: number, fy: number, level: number): number {
  const x = ((fx >> 4) << 24) >> 24;
  const y = ((fy >> 4) << 24) >> 24;
  if (tileOutOfBounds(fixed, x, y) || level < 1 || level > 2) return ROOM_DEGENERATE;
  const rooms = fixed.rooms[level - 1]!;
  let id = rooms.u16(x, y);
  if (id !== ROOM_DEGENERATE) return id;
  const segs = getWall(fixed, x, y, level).segs;
  let x1 = x;
  let y2 = y;
  if ((segs & 0x10) === 0x10) {
    if ((fx & 0xf) < 0x10 - (fy & 0xf)) {
      x1 = x - 1;
      y2 = y - 1;
    } else {
      x1 = x + 1;
      y2 = y + 1;
    }
  } else if ((segs & 0x20) === 0x20) {
    if ((fx & 0xf) < (fy & 0xf)) {
      x1 = x - 1;
      y2 = y + 1;
    } else {
      x1 = x + 1;
      y2 = y - 1;
    }
  }
  if (!tileOutOfBounds(fixed, x1, y)) {
    id = rooms.u16(x1, y);
    if (id === ROOM_DEGENERATE && !tileOutOfBounds(fixed, x, y2)) id = rooms.u16(x, y2);
  }
  return id;
}

/** Objects on a tile (ObjectIterator from the tile's head object, slot hierarchy included). */
export function* tileObjects(module: SimModule, x: number, y: number, level: number): Generator<SimObject> {
  const fixed = module.sim.world;
  if (!fixed || x < 0 || y < 0 || x >= fixed.size || y >= fixed.size || level < 1 || level > 2) return;
  const head = module.getObject(fixed.objects[level - 1]!.s16(x, y));
  const seen = new Set<number>();
  const walk = function* (o: SimObject | null, depth: number): Generator<SimObject> {
    if (!o || depth > 64 || seen.has(o.id)) return;
    seen.add(o.id);
    yield o;
    for (const s of o.obj.objectSlots) yield* walk(module.getObject(s.containedId), depth + 1);
  };
  yield* walk(head, 0);
}

/**
 * cXObject::GetWallBlockFlagsAtTile(tile, dir): the tile's walls as
 * direction bits (left 0x40, top 1, right 4, bottom 0x10), the wall block
 * flags (object data 53, rotated with the object) of the objects on it,
 * then rotated so that bit k is direction dir + k.
 */
export function wallBlockFlagsAtTile(module: SimModule, x: number, y: number, level: number, dir: number): number {
  const fixed = module.sim.world;
  if (!fixed || tileOutOfBounds(fixed, x, y)) return 0;
  const segs = getWall(fixed, x, y, level).segs;
  let f = 0;
  if (segs & 1) f = 0x40;
  if (segs & 2) f |= 1;
  if (segs & 4) f |= 4;
  if (segs & 8) f |= 0x10;
  for (const o of tileObjects(module, x, y, level)) {
    const b = o.obj.objectData[53]!;
    if (b !== 0) {
      const v = b << (o.obj.dir & 0x3f);
      f |= (v | (v >> 8)) & 0xff;
    }
  }
  if (dir !== 0) {
    f = f << ((8 - dir) & 0x3f);
    f = (f | (f >> 8)) & 0xff;
  }
  return f;
}

/** SectWall(FTileRect [maxY, maxX, minY, minX], level): does a wall cross the rectangle (door / arch styles let through)? */
export function sectWall(fixed: FixedWorld, r: readonly [number, number, number, number], level: number): boolean {
  for (let y = r[2] >> 4; y <= (r[0] - 1) >> 4; y++) {
    for (let x = r[3] >> 4; x <= (r[1] - 1) >> 4; x++) {
      if (x < 0 || y < 0 || x >= fixed.size || y >= fixed.size) continue;
      const walls = getWall(fixed, x, y, level);
      for (let seg = 1; seg <= 0x20; seg <<= 1) {
        if (!(walls.segs & seg)) continue;
        const style = walls.styles[segIndex(seg)]!;
        if (style === 3 || style === 5 || style === 6 || style === 0xf || style === 0x17) continue;
        let wall: number;
        let lo: number;
        let hi: number;
        if (seg === 0x10) {
          wall = (y + x + 1) * 16;
          lo = r[0] + r[1];
          hi = r[2] + r[3];
        } else if (seg === 2) {
          wall = y << 4;
          lo = r[2];
          hi = r[0];
        } else if (seg === 1) {
          wall = x << 4;
          lo = r[3];
          hi = r[1];
        } else if (seg === 0x20) {
          wall = (y - x) * 16;
          lo = r[2] - r[1];
          hi = r[0] - r[3];
        } else {
          continue;
        }
        if ((lo < wall && wall < hi) || (wall < lo && hi < wall)) return true;
      }
    }
  }
  return false;
}

/** Round half away from zero (TransformToWorldCoords' floor(v + 0.5) / ceil(v - 0.5)). */
function roundAway(v: number): number {
  return v >= 0 ? Math.floor(v + 0.5) : Math.ceil(v - 0.5);
}

/**
 * TransformToWorldCoords(base, a, b, dir): the offset (a along x, b along
 * y, as for a direction-0 object) rotated to `dir` and added to `base`.
 * Even directions are exact quarter turns; odd ones use the rotation
 * (ObjectRotationTf) rounded half away from zero.
 */
export function transformToWorldCoords(baseX: number, baseY: number, a: number, b: number, dir: number): { fx: number; fy: number } {
  let x: number;
  let y: number;
  switch (dir & 7) {
    case 0:
      x = a;
      y = b;
      break;
    case 2:
      x = -b;
      y = Math.trunc(a);
      break;
    case 4:
      x = -a;
      y = -b;
      break;
    case 6:
      x = b;
      y = -Math.trunc(a);
      break;
    default: {
      const t = ((dir & 7) * Math.PI) / 4;
      const c = Math.cos(t);
      const s = Math.sin(t);
      x = roundAway(Math.fround(a * c - b * s));
      y = roundAway(Math.fround(a * s + b * c));
    }
  }
  return { fx: Math.trunc(x + baseX), fy: Math.trunc(y + baseY) };
}

/**
 * SetDirectionForGoalSearch(person, objectDir, goalDir, slot): the person
 * faces the way it will on the goal while goals are tested (CanPlace uses
 * the direction): no directions: object dir + 4; facing -2: goal dir + 4;
 * -3: unchanged; -1: goal dir; n: object dir + n.
 */
function setDirectionForGoalSearch(person: XObject, odir: number, gdir: number, slot: RoutingSlot): void {
  let d = gdir;
  if ((slot.flags & 0xff) === 0) d = odir + 4;
  else if (slot.facing !== FACE_AWAY) {
    if (slot.facing === FACE_TOWARDS) d = gdir + 4;
    else if (slot.facing === FACE_ANY) return;
    else d = odir + slot.facing;
  }
  while (d < 0) d += 8;
  person.objectData[1] = d & 7;
}

/** cXObject::CalcShortDistance (tiles; levels count 20 tiles). */
export function calcShortDistance(a: XObject, b: XObject): number {
  if (b.selector.objd.objectType === 7) return 0;
  const dx = a.fx - b.fx;
  const dy = a.fy - b.fy;
  const dl = (b.level - a.level) * 20;
  return Math.fround(Math.sqrt(Math.fround(0.00390625 * (dx * dx + dy * dy)) + dl * dl));
}

/** Allow-person-intersection test of GetObstacleAtLocation / TestIntersection (object data 8 flags). */
export function passable(flags: number): boolean {
  const allow = flags & 4 ? ((flags >> 1) & 1) ^ 1 : (flags >> 4) & 1;
  return allow !== 0;
}

/** cXObject::GetObstacleAtLocation(FTilePt, level): the first object on the tile people cannot walk through. */
export function obstacleAtLocation(module: SimModule, fx: number, fy: number, level: number): SimObject | null {
  const x = ((fx >> 4) << 24) >> 24;
  const y = ((fy >> 4) << 24) >> 24;
  for (const o of tileObjects(module, x, y, level)) if (!passable(o.obj.flags)) return o;
  return null;
}

/** GetAverageLocation: the mean position of a multi-tile object's parts. */
function averageLocation(module: SimModule, o: SimObject): { fx: number; fy: number } {
  const lead = o.obj.mtLeadId || o.id;
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (const p of module.list) {
    if ((p.obj.mtLeadId || p.id) !== lead) continue;
    sx += p.obj.fx;
    sy += p.obj.fy;
    n++;
  }
  return n ? { fx: Math.trunc(sx / n), fy: Math.trunc(sy / n) } : { fx: o.obj.fx, fy: o.obj.fy };
}

/** Path point (1/16 tile). */
export interface PathPt {
  fx: number;
  fy: number;
}

export class XRoute {
  goals: RouteGoal[] = [];
  readonly slot: RoutingSlot;
  /** +0x50 current goal, +0x54 best score. */
  goalIndex = -1;
  maxScore = -1;
  /** +0x58 blocked stage, +0x5c the tick blocked / waiting started. */
  blockedStage = 0;
  waitTick = 0;
  /** +0x60 / +0x64: where the person was when last blocked. */
  lastFx = 0;
  lastFy = 0;
  /** +0x68: the portal this route walks through. */
  portal: SimObject | null = null;
  /** +0x6c / +0x70 starting point, +0x74 its direction bit. */
  startFy = 0;
  startFx = 0;
  startDirs = 0;
  /** +0x78: set when built (cleared by a load: the route is re-planned). */
  loaded = true;
  /** +0x7c: the person not to avoid; +0x8e: avoid nobody (AskOthersToMove). */
  ignorePerson: SimObject | null = null;
  ignoreAll = false;
  /** +0x80 / +0x84: the person asked to move, asked already. */
  askedPerson: SimObject | null = null;
  asked = false;
  /** +0x88 route result, +0x8c the blocking object's id. */
  result = 0;
  blocker = 0;
  /** +0x90: the interaction pushed on the asked person. */
  askedInteraction: unknown = null;
  /** +0x94: the person's footprint (person data 72). */
  footprint = 0;
  /** +0x98: goals kept at most. */
  maxGoals = 0x30;
  /** The path (cXPerson +0xa90 TileList), its last point being the facing point when one was added. */
  path: PathPt[] = [];
  /** Wait state counters of states 13 / 14 (the route's +0x5c). */
  stateTick = 0;

  /** XRoute::Construct. */
  constructor(
    readonly module: SimModule,
    readonly person: SimObject,
    readonly target: SimObject | null,
    slot: RoutingSlot | null,
  ) {
    this.slot = slot ? copyRoutingSlot(slot) : newRoutingSlot();
    this.lastFy = person.obj.fy;
    this.lastFx = person.obj.fx;
    this.footprint = person.isPerson ? (person.person?.personData[72] ?? 0) : 0;
  }

  get fixed(): FixedWorld {
    return this.module.sim.world!;
  }

  /** XRoute::GetCurrentGoal. */
  currentGoal(): RouteGoal | null {
    return this.goals[this.goalIndex] ?? null;
  }

  /** XRoute::ResetGoals. */
  resetGoals(): void {
    this.goals = [];
    this.goalIndex = -1;
    this.maxScore = -1;
  }

  /**
   * XRoute::EvalTileForGoal(point, dir): 0 off the lot, 2 another room, 3 a
   * wall between the point and the object (or CanPlace error 7), 4 another
   * altitude, 1 an object in the way, 5 a person in the way, 6 valid.
   * (dir = -1: no wall test.) Sets the blocker id.
   */
  evalTileForGoal(fx: number, fy: number, dir: number): number {
    const fixed = this.fixed;
    const x = ((fx >> 4) << 24) >> 24;
    const y = ((fy >> 4) << 24) >> 24;
    if (tileOutOfBounds(fixed, x, y)) return 0;
    const me = this.person.obj;
    if (!(this.slot.flags & RSF.ignoreRooms)) {
      const level = me.level;
      if (level < 1 || level > 2) return 2;
      if (fixed.rooms[level - 1]!.u16(x, y) !== (me.objectData[29]! & 0xffff)) return 2;
      if (dir !== -1) {
        const w = wallBlockFlagsAtTile(this.module, x, y, level, (dir + 4) & 7);
        if (w & 1) return 3;
        if (dir & 1 && (w & 2 || w & 0x80)) return 3;
      }
    }
    if (!(this.slot.flags & RSF.ignoreAltitude) && this.target) {
      const t = this.target.obj;
      const a = fixed.alt.data;
      const ot = fixed.alt.offset(t.fx >> 4, t.fy >> 4);
      const og = fixed.alt.offset(fx >> 4, fy >> 4);
      for (let k = 0; k < 4; k++) if (a[ot + k] !== a[og + k]) return 4;
      if (a[og] !== a[og + 1] || a[og] !== a[og + 2] || a[og] !== a[og + 3]) return 4;
    }
    const h = this.module.worldHooks;
    if (!h) return 6;
    if (!h.canPlace(me, { fx, fy }, me.level, null, -1)) {
      const e = h.lastError();
      if (e.code !== 0xb) return e.code === 7 ? 3 : 0;
      const o = e.obstacle !== 0 ? this.module.getObject(e.obstacle) : null;
      if (o && o !== this.ignorePerson) {
        this.blocker = o.id;
        return o.isPerson ? 5 : 1;
      }
    }
    return 6;
  }

  /**
   * XRoute::ChooseStartingPoint: the person's position; when sitting in a
   * chair (a container with a sit tree), the nearest valid (or person-
   * blocked) tile next to the chair in one of its allowed directions
   * (OBJD +0x84), with that direction's bit.
   */
  chooseStartingPoint(): void {
    const me = this.person.obj;
    this.startFy = me.fy;
    this.startFx = me.fx;
    this.startDirs = 0;
    const chair = me.parentId !== 0 ? this.module.getObject(me.parentId) : null;
    if (!chair || chair.fnTable.getTreeID(EP.sit) === 0 || !this.target) return;
    const t = this.target.obj;
    const allowed = chair.obj.selector.objd.i16(0x84);
    let best = -1;
    for (let k = 0; k < 8; k++) {
      const bit = 1 << k;
      if (!(allowed & bit)) continue;
      const d = (k + chair.obj.dir) & 7;
      const [vx, vy] = DIR_VEC[d]!;
      const fx = me.fx + vx * 16;
      const fy = me.fy + vy * 16;
      const r = this.evalTileForGoal(fx, fy, -1);
      if (r !== 6 && r !== 5) continue;
      const dd = (t.fx - fx) ** 2 + (t.fy - fy) ** 2;
      if (best < 0 || dd < best) {
        best = dd;
        this.startFy = fy;
        this.startFx = fx;
        this.startDirs = bit;
      }
    }
  }

  /**
   * XRoute::BuildGoalList: the starting point, at most 8 goals in rooms
   * larger than 250 tiles, ConstructGoals (chairs allowed for people, not
   * pets) with the route's footprint in person data 73; the person's
   * direction is restored.
   */
  buildGoalList(): void {
    this.chooseStartingPoint();
    const p = this.person;
    const pd = p.person?.personData ?? null;
    const fixed = this.fixed;
    const room = p.obj.objectData[29]! & 0xffff;
    if (pd) {
      let area = 0;
      const level = p.obj.level;
      if (level >= 1 && level <= 2 && room < ROOM_DEGENERATE) {
        const rooms = fixed.rooms[level - 1]!;
        for (let x = 0; x < fixed.size; x++) for (let y = 0; y < fixed.size; y++) if (rooms.u16(x, y) === room) area++;
      }
      if (area > 0xfa) this.maxGoals = 8;
    }
    const dir = p.obj.objectData[1]!;
    if (pd) pd[73] = this.footprint;
    const gender = pd ? pd[0x41]! : 0;
    this.constructGoals(gender < 2);
    if (pd) pd[73] = 0;
    p.obj.objectData[1] = dir;
  }

  /** XRoute::ConstructGoals(allowChairs). */
  constructGoals(allowChairs: boolean): void {
    this.goals = [];
    this.goalIndex = -1;
    this.maxScore = -1;
    const target = this.target;
    if (!target) return;
    const slot = this.slot;
    const me = this.person.obj;
    const t = target.obj;
    const odir = slot.flags & RSF.absolute ? 0 : t.dir;
    let base = { fx: t.fx, fy: t.fy };
    if (slot.flags & RSF.averageLocation) base = averageLocation(this.module, target);
    const random = (): number => this.module.sim.random();
    if ((slot.flags & 0xff) === 0) {
      // On the object (or at the slot's offset): one goal facing the object.
      const p = transformToWorldCoords(base.fx, base.fy, slot.x, slot.y, odir);
      let dir = -1;
      if (!(p.fx === base.fx && p.fy === base.fy) && !(p.fx >> 4 === base.fx >> 4 && p.fy >> 4 === base.fy >> 4)) {
        dir = dirOf(p.fx - base.fx, p.fy - base.fy);
      }
      setDirectionForGoalSearch(me, odir, 0, slot);
      const r = this.evalTileForGoal(p.fx, p.fy, dir);
      if (r === 6) {
        this.goals.push({ fy: p.fy, fx: p.fx, score: 100, chair: 0, dirFlags: 0 });
        this.maxScore = Math.max(this.maxScore, 100);
        this.result = 0;
      } else {
        this.result = r === 5 ? ROUTE.personInWay : r === 1 ? ROUTE.destOccupied : r === 2 || r === 3 ? ROUTE.wallInWay : r === 4 ? ROUTE.altitudes : 0;
      }
      return;
    }
    const minP = slot.minProximity;
    const maxP = slot.maxProximity;
    const opt = slot.optimalProximity;
    if (!(minP > 0 && minP <= 0x200 && maxP > 0 && maxP <= 0x200 && minP <= maxP && minP <= opt && opt <= maxP)) return;
    const chairWeight = allowChairs ? slot.multipliers[1] * 10 : 0;
    const standWeight = Math.max(slot.multipliers[0], slot.multipliers[2]) * 10;
    const maxSq = maxP * maxP;
    const minSq = minP * minP;
    const wallFlags = slot.flags & RSF.ignoreRooms ? 0 : wallBlockFlagsAtTile(this.module, t.tileX, t.tileY, t.level, odir);
    // Directions next to a blocked one lose the "open side" bonus.
    let nearWall = 0;
    for (let k = 0; k < 8; k++) if (wallFlags & (1 << k)) nearWall |= (1 << ((k - 1) & 7)) | (1 << k) | (1 << ((k + 1) & 7));
    const res = chairWeight !== 0 ? 16 : slot.resolution;
    const inv = 16 / res;
    const onlyChairs = chairWeight > 0 && standWeight === 0;
    const ringFar = Math.trunc(0.0625 * inv * -maxP);
    const ringNear = Math.trunc(0.0625 * inv * -minP);
    let chairTaken = false;
    let personInWay = false;
    let objectInWay = false;
    let wallInWay = false;
    let altitudes = false;
    for (let k = 0; k < 8; k++) {
      const bit = 1 << k;
      if (!(slot.flags & bit)) continue;
      if (wallFlags & bit) {
        wallInWay = true;
        continue;
      }
      const gdir = (odir + k) & 7;
      const chairDir = (gdir + 4) & 7;
      let lo = ringFar;
      let ring = ringNear;
      if (chairWeight > 0) {
        ring = Math.min(ringNear + 1, -1);
        lo = ringFar - 1;
      }
      setDirectionForGoalSearch(me, odir, gdir, slot);
      const nextAllowed = (slot.flags & (1 << ((k + 2) & 7))) !== 0;
      const openSide = (nearWall & bit) === 0;
      let stop = false;
      for (; lo <= ring && !stop; ring--) {
        const last = -ring - (nextAllowed ? 1 : 0);
        for (let i = ring; i <= last; i++) {
          // The point, then (chairs allowed) the 8 tiles around it looking for a chair facing the object.
          for (let n = -1; n < 9; n++) {
            let lx = Math.trunc(slot.x + i * res);
            let ly = Math.trunc(slot.y + ring * res);
            let weight = 0;
            let chair = 0;
            let dirFlags = 0;
            if (n === -1 || n === 8) {
              const standFirst = !(standWeight < chairWeight);
              if ((standFirst && n === -1) || (!standFirst && n === 8)) weight = standWeight;
              dirFlags = bit;
            } else if (chairWeight !== 0) {
              const [vx, vy] = DIR_VEC[n]!;
              lx += vx * 16;
              ly += vy * 16;
              const cx = lx >> 4;
              const cy = ly >> 4;
              let inRing: boolean;
              if (cy === ring) inRing = ring <= cx && cx <= last;
              else inRing = ring < cy && ring < cx && cx < last;
              if (inRing) {
                const w = transformToWorldCoords(base.fx, base.fy, lx, ly, gdir);
                const wx = ((w.fx >> 4) << 24) >> 24;
                const wy = ((w.fy >> 4) << 24) >> 24;
                const c = tileOutOfBounds(this.fixed, wx, wy) ? null : obstacleAtLocation(this.module, w.fx, w.fy, t.level);
                if (c && c.fnTable.getTreeID(EP.sit) !== 0 && c.obj.dir === chairDir && c.obj.selector.objd.i16(0x84) & (1 << (n & 0x3f))) {
                  const occupant = c.obj.objectSlots[1] ? this.module.getObject(c.obj.objectSlots[1].containedId) : null;
                  if (!occupant || occupant === this.person) {
                    chair = c.id;
                    weight = chairWeight;
                  } else {
                    chairTaken = true;
                    this.blocker = occupant.id;
                  }
                }
              }
            }
            if (weight === 0) continue;
            const dsq = lx * lx + ly * ly;
            if (!(dsq <= maxSq && minSq <= dsq)) continue;
            const dist = Math.trunc(Math.sqrt(dsq));
            let score = 100 - Math.trunc(Math.abs(dist - opt) * slot.gradient) + weight;
            if (slot.flags & RSF.randomScore) score += (random() % 20) - 10;
            if (openSide) score += 25;
            const w = transformToWorldCoords(base.fx, base.fy, lx, ly, gdir);
            if (w.fx === this.startFx && w.fy === this.startFy) score += 20;
            const r = this.evalTileForGoal(w.fx, w.fy, gdir);
            if (r === 1) objectInWay = true;
            else if (r === 2) wallInWay = true;
            else if (r === 3) {
              wallInWay = true;
              stop = true;
            } else if (r === 4) altitudes = true;
            else if (r === 5) personInWay = true;
            if (r === 6) {
              this.goals.push({ fy: w.fy, fx: w.fx, score, chair, dirFlags });
              if (this.maxScore < score) this.maxScore = score;
              break;
            }
          }
        }
      }
    }
    if (this.goals.length > this.maxGoals) {
      // Keep the chairs, then random picks.
      const all = this.goals;
      const taken = new Array<boolean>(all.length).fill(false);
      this.goals = [];
      all.forEach((g, i) => {
        if (g.chair !== 0) {
          this.goals.push(g);
          taken[i] = true;
        }
      });
      for (let n = this.goals.length; n < this.maxGoals; n++) {
        const start = random() % all.length;
        for (let i = start; i < all.length; i++) {
          if (!taken[i]) {
            this.goals.push(all[i]!);
            taken[i] = true;
            break;
          }
        }
      }
    }
    if (this.goals.length === 0) {
      this.result = chairTaken
        ? ROUTE.chairOccupied
        : personInWay
          ? ROUTE.personInWay
          : objectInWay
            ? ROUTE.destOccupied
            : wallInWay
              ? ROUTE.wallInWay
              : altitudes
                ? ROUTE.altitudes
                : onlyChairs
                  ? ROUTE.noChair
                  : 0;
    }
  }

  /**
   * XRoute::ShouldIgnore(obj): contained objects; objects people may walk
   * through with no route penalty (object data 10); people out of the
   * route's concern (the ignored person, farther than 3 tiles); objects
   * whose allow-intersection tree accepts the person.
   */
  shouldIgnore(o: SimObject): boolean {
    const x = o.obj;
    if (x.parentId !== 0 || x.containerId !== 0) return true;
    if (passable(x.flags) && x.objectData[10] === 0) return true;
    if (x.selector.objd.objectType === 2) {
      if (o.isPerson) {
        if (o === this.ignorePerson || this.ignoreAll) return true;
        if (calcShortDistance(this.person.obj, x) > 3) return true;
      }
      return false;
    }
    const tree = o.fnTable.getTreeID(EP.allowIntersection);
    return tree !== 0 && o.runCheckTree(o.behavior, this.person.id, tree, null);
  }

  /** XRoute::IsPersonSittingOnChairGoal: the person's container is one of the goal chairs. */
  isPersonSittingOnChairGoal(p: SimObject): boolean {
    for (const g of this.goals) {
      if (g.chair === 0) continue;
      const c = this.module.getObject(g.chair);
      if (c && c.fnTable.getTreeID(EP.sit) !== 0 && p.obj.parentId === c.id) return true;
    }
    return false;
  }

  /**
   * XRoute::FindPath (see the file comment): fills `path` from the starting
   * point to the best reachable goal (cost: length + (best score - score)
   * * 16) and sets the current goal. False when no goal is reachable.
   */
  findPath(): boolean {
    this.path = [];
    const fixed = this.fixed;
    const me = this.person.obj;
    const level = me.level;
    if (!this.goals.length || level < 1 || level > 2) return false;
    const pd = this.person.person?.personData ?? null;
    const ghost = pd ? (pd[68]! & 1) === 1 : false;
    const room = me.objectData[29]! & 0xffff;
    // The person's footprint (ComputeRect with the OBJD footprint mask), its largest half extent.
    const half = Math.max(1, me.fx - me.rect[3], me.rect[1] - me.fx, me.fy - me.rect[2], me.rect[0] - me.fy);
    // Penalty rectangles: [minX, minY, maxX, maxY, weight], footprints inflated by the person's half width.
    const rects: Array<[number, number, number, number, number]> = [];
    const chairs = new Set(this.goals.map((g) => g.chair).filter((c) => c !== 0));
    for (const o of this.module.list) {
      const x = o.obj;
      if (o === this.person || x.level !== level || chairs.has(o.id)) continue;
      if (tileOutOfBounds(fixed, x.tileX, x.tileY)) continue;
      if (x.kind === "portal") continue;
      if (this.shouldIgnore(o)) continue;
      const r = x.rect;
      // Impassable footprints are tested exactly by CanPlace below (direction-dependent footprints);
      // objects with a route penalty (object data 10) only cost.
      if (x.objectData[10] !== 0) rects.push([r[3] - half, r[2] - half, r[1] + half, r[0] + half, 10]);
    }
    const hooks = this.module.worldHooks;
    const validCache = new Map<number, number>();
    const myDir = me.objectData[1]!;
    const valid = (fx: number, fy: number, dir: number): number => {
      const k = (fy * 0x10000 + fx) * 8 + dir;
      let v = validCache.get(k);
      if (v === undefined) {
        v = validAt(fx, fy, dir);
        validCache.set(k, v);
      }
      return v;
    };
    // The footprint depends on the direction (OBJD +0x9a mask): tested facing the way the person walks.
    const validAt = (fx: number, fy: number, dir: number): number => {
      const tx = fx >> 4;
      const ty = fy >> 4;
      if (tileOutOfBounds(fixed, tx, ty)) return -1;
      if (!ghost && !(this.slot.flags & RSF.ignoreRooms) && resolveRoomID(fixed, fx, fy, level) !== room) return -1;
      if (sectWall(fixed, [fy + half, fx + half, fy - half, fx - half], level)) return -1;
      let cost = 0;
      for (const r of rects) {
        if (fx > r[0] && fx < r[2] && fy > r[1] && fy < r[3]) {
          if (r[4] === 0x7fffffff) return -1;
          cost += r[4];
        }
      }
      // The person's own footprint must fit there too (cXObject::CanPlace, as FollowOneStep tests each step),
      // unless only people block it (they move; the rectangles above decide for them).
      me.objectData[1] = dir;
      const fits = !hooks || hooks.canPlace(me, { fx, fy }, level, null, -1);
      me.objectData[1] = myDir;
      if (!fits && hooks) {
        const e = hooks.lastError();
        const o = e.code === 0xb && e.obstacle !== 0 ? this.module.getObject(e.obstacle) : null;
        // People the route ignores (far away, the one asked to move) and the goal chairs do not block.
        if (!(o && ((o.isPerson && this.shouldIgnore(o)) || chairs.has(o.id) || (o.obj.objectData[10] !== 0 && !o.isPerson)))) return -1;
      }
      return cost;
    };
    const lineClear = (ax: number, ay: number, bx: number, by: number): boolean => {
      const d = Math.hypot(bx - ax, by - ay);
      const n = Math.max(1, Math.ceil(d));
      const dir = dirOf(bx - ax, by - ay);
      for (let i = 1; i <= n; i++) {
        const fx = Math.round(ax + ((bx - ax) * i) / n);
        const fy = Math.round(ay + ((by - ay) * i) / n);
        if (valid(fx, fy, dir) !== 0) return false;
      }
      return true;
    };
    const STEP = 4;
    const n = fixed.size * 4;
    const key = (gx: number, gy: number): number => gy * n + gx;
    const nodeCost = (gx: number, gy: number, dir: number): number => valid(gx * STEP, gy * STEP, dir);
    const sx = this.startFx;
    const sy = this.startFy;
    // Goals reachable from lattice nodes (a straight clear segment within one step).
    const goalCost = this.goals.map((g) => (this.maxScore - g.score) * 16);
    const goalNear = new Map<number, number[]>();
    this.goals.forEach((g, i) => {
      const gx0 = Math.floor(g.fx / STEP);
      const gy0 = Math.floor(g.fy / STEP);
      for (let dy = 0; dy <= 1; dy++) {
        for (let dx = 0; dx <= 1; dx++) {
          const k = key(gx0 + dx, gy0 + dy);
          const l = goalNear.get(k) ?? [];
          l.push(i);
          goalNear.set(k, l);
        }
      }
    });
    // Direct segment start -> goal.
    let best: { cost: number; goal: number; node: number } | null = null;
    this.goals.forEach((g, i) => {
      if (Math.hypot(g.fx - sx, g.fy - sy) < 0.5 || lineClear(sx, sy, g.fx, g.fy)) {
        const c = Math.hypot(g.fx - sx, g.fy - sy) + goalCost[i]!;
        if (!best || c < best.cost) best = { cost: c, goal: i, node: -1 };
      }
    });
    const gScore = new Map<number, number>();
    const came = new Map<number, number>();
    // Binary heap over [f, key].
    const heap: Array<[number, number]> = [];
    const push = (f: number, k: number): void => {
      heap.push([f, k]);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p]![0] <= heap[i]![0]) break;
        [heap[p], heap[i]] = [heap[i]!, heap[p]!];
        i = p;
      }
    };
    const pop = (): [number, number] | undefined => {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length && last) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1;
          const r = l + 1;
          let m = i;
          if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l;
          if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i]!, heap[m]!];
          i = m;
        }
      }
      return top;
    };
    const h = (gx: number, gy: number): number => {
      let m = Infinity;
      this.goals.forEach((g, i) => {
        m = Math.min(m, Math.hypot(g.fx - gx * STEP, g.fy - gy * STEP) + goalCost[i]!);
      });
      return m;
    };
    // Seed: lattice nodes around the start.
    const sgx = Math.floor(sx / STEP);
    const sgy = Math.floor(sy / STEP);
    for (let dy = -1; dy <= 2; dy++) {
      for (let dx = -1; dx <= 2; dx++) {
        const gx = sgx + dx;
        const gy = sgy + dy;
        const sd = dirOf(gx * STEP - sx, gy * STEP - sy);
        if (nodeCost(gx, gy, sd) < 0) continue;
        if (!lineClear(sx, sy, gx * STEP, gy * STEP)) continue;
        const k = key(gx, gy);
        const g = Math.hypot(gx * STEP - sx, gy * STEP - sy) + nodeCost(gx, gy, sd);
        if (g < (gScore.get(k) ?? Infinity)) {
          gScore.set(k, g);
          came.set(k, -1);
          push(g + h(gx, gy), k);
        }
      }
    }
    const closed = new Set<number>();
    let expanded = 0;
    while (heap.length && expanded < 40000) {
      const [f, k] = pop()!;
      if (closed.has(k)) continue;
      const bestNow = best as { cost: number } | null;
      if (bestNow && f >= bestNow.cost) break;
      closed.add(k);
      expanded++;
      const gx = k % n;
      const gy = (k - gx) / n;
      const g0 = gScore.get(k)!;
      for (const i of goalNear.get(k) ?? []) {
        const goal = this.goals[i]!;
        const px = gx * STEP;
        const py = gy * STEP;
        if (!(goal.fx === px && goal.fy === py) && !lineClear(px, py, goal.fx, goal.fy)) continue;
        const c = g0 + Math.hypot(goal.fx - px, goal.fy - py) + goalCost[i]!;
        if (!best || c < (best as { cost: number }).cost) best = { cost: c, goal: i, node: k };
      }
      for (let d = 0; d < 8; d++) {
        const [vx, vy] = DIR_VEC[d]!;
        const nx = gx + vx;
        const ny = gy + vy;
        const nk = key(nx, ny);
        if (closed.has(nk)) continue;
        const c = nodeCost(nx, ny, d);
        if (c < 0) continue;
        if (vx !== 0 && vy !== 0 && (nodeCost(gx + vx, gy, d) < 0 || nodeCost(gx, gy + vy, d) < 0)) continue;
        const ng = g0 + (vx !== 0 && vy !== 0 ? STEP * Math.SQRT2 : STEP) + c;
        if (ng < (gScore.get(nk) ?? Infinity)) {
          gScore.set(nk, ng);
          came.set(nk, k);
          push(ng + h(nx, ny), nk);
        }
      }
    }
    const found = best as { cost: number; goal: number; node: number } | null;
    if (!found) return false;
    const pts: PathPt[] = [{ fx: sx, fy: sy }];
    const mid: PathPt[] = [];
    for (let k = found.node; k !== -1 && k !== undefined; k = came.get(k)!) {
      const gx = k % n;
      mid.push({ fx: gx * STEP, fy: ((k - gx) / n) * STEP });
    }
    mid.reverse();
    pts.push(...mid);
    const goal = this.goals[found.goal]!;
    pts.push({ fx: goal.fx, fy: goal.fy });
    // Line-of-sight shortening.
    const out: PathPt[] = [pts[0]!];
    let i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      while (j > i + 1 && !lineClear(pts[i]!.fx, pts[i]!.fy, pts[j]!.fx, pts[j]!.fy)) j--;
      out.push(pts[j]!);
      i = j;
    }
    // The person's own start point is first even when routing from a chair's side.
    if (this.startFx !== me.fx || this.startFy !== me.fy) out.unshift({ fx: me.fx, fy: me.fy });
    this.path = out;
    this.goalIndex = found.goal;
    return true;
  }
}

/**
 * ObjectModule's room update after ComputeRooms (level 0: all): every
 * object's room (object data 29) resolved from its position. (People's
 * UpdateCurrentRoom - overhead lights - is not ported.)
 */
export function updateRoomIDs(module: SimModule, level: number): void {
  const fixed = module.sim.world;
  if (!fixed) return;
  for (const o of module.list) {
    const x = o.obj;
    if (level !== 0 && x.level !== level) continue;
    x.objectData[29] = resolveRoomID(fixed, x.fx, x.fy, x.level);
  }
}

/** Rotate an offset (1/16 tile, as for a direction-0 object) to direction `dir` (quarter turns, TransformToWorldCoords' even cases). */
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
