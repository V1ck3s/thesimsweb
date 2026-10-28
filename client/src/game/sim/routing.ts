/**
 * Person routing: RoutingSlot, XRoute (XRoute.cpp / XRouting.cpp) and the
 * room helpers it uses (ResolveRoomID, GetWallBlockFlagsAtTile).
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
 * ShouldIgnore, IsPersonSittingOnChairGoal, TransformToWorldCoords and
 * FindPath are ported from the decompiled code; FindPath's search
 * (SpacePartition, Path, BuildRoomPartition) is in spacepartition.ts.
 */

import type { FixedWorld } from "../world/world.js";
import type { SlotDescriptor } from "../world/slots.js";
import { getWall, segIndex } from "../world/tilewalls.js";
import type { XObject } from "../world/objects.js";
import type { SimModule } from "./simmodule.js";
import type { SimObject } from "./xobject.js";
import { EP } from "./objfntable.js";
import { BLOCKED, buildRoomPartition, findIntersectingRect, inflateRect, Path, penaltyRect, roomIsOutside, roomLevel, roomStats, type PenaltyRect, type RoutingParams } from "./spacepartition.js";

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

/** cXObject::GetPlacementSpec's container: the parent of the top of the tile stack (slot hierarchy 0 links stacked objects). */
export function placementContainer(module: SimModule, o: SimObject): SimObject | null {
  let top = o;
  for (let guard = 0; guard < 256 && top.obj.slotHierNumber === 0; guard++) {
    const p = module.getObject(top.obj.parentId);
    if (!p) break;
    top = p;
  }
  return module.getObject(top.obj.parentId);
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
  /** +0x80: the person asked to move; +0x84: set when that person's move ended (true: it worked). */
  askedPerson: SimObject | null = null;
  asked = false;
  /** +0x88 route result, +0x8c the blocking object's id. */
  result = 0;
  blocker = 0;
  /** +0x90: the interaction pushed on the asked person (its move out of the way). */
  askedInteraction: object | null = null;
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
   * XRoute::ShouldIgnore(obj): objects in a container (GetPlacementSpec:
   * stacked objects, slot hierarchy 0, are on the tile); objects people may walk
   * through with no route penalty (object data 10); people out of the
   * route's concern (the ignored person, farther than 3 tiles); objects
   * whose allow-intersection tree accepts the person.
   */
  shouldIgnore(o: SimObject): boolean {
    const x = o.obj;
    if (placementContainer(this.module, o) !== null) return true;
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

  /** Drop the current goal (its score set to 0; +0x50 / +0x54 = -1). */
  private dropCurrentGoal(): void {
    if (this.goalIndex !== -1) {
      const g = this.goals[this.goalIndex];
      if (g) g.score = 0;
      this.goalIndex = -1;
      this.maxScore = -1;
    }
  }

  /**
   * XRoute::FindPath(TileList&): the path from the starting point to the
   * best reachable goal (see spacepartition.ts). Ghosts (person data 84 /
   * 68 bit 0) route through everything; others need the target in their
   * room, and avoid the room partition (cached per room; built without the
   * outdoor paths when running outside) and the obstacles: the room's other
   * objects (ShouldIgnore aside) that do not overlap the person, their
   * footprints weighted blocked or 10 (route penalty) and inflated by half
   * a person's width (3); a door's wall block flags turn it into a strip
   * along each blocking side, weighted 10000. Goals of positive score are
   * 1x1 rectangles weighted (best - score) * 16. Big (> 256) uncluttered
   * rooms are searched once with unlimited rectangles (unreachable: no
   * path), then with rectangles of at most 8 tiles. The search and the
   * smoothing share a budget of goals * area + 50 (at most 1000) steps.
   */
  findPath(): boolean {
    this.path = [];
    const m = this.module;
    const me = this.person.obj;
    const pd = this.person.person?.personData ?? null;
    const ghost = pd !== null && ((pd[84]! & 1) === 1 || (pd[68]! & 1) === 1);
    const running = me.objectData[17] !== 0;
    if (this.goals.length === 0) {
      if (this.result === ROUTE.unknown) this.result = ROUTE.noValidGoals;
      return false;
    }
    const room = me.objectData[29]! & 0xffff;
    const targetRoom = this.target ? this.target.obj.objectData[29]! & 0xffff : room;
    if (!ghost && room !== targetRoom) {
      this.dropCurrentGoal();
      return false;
    }
    const level = roomLevel(room);
    if (room >= ROOM_DEGENERATE || level < 1 || level > 2 || me.level !== level) {
      this.dropCurrentGoal();
      return false;
    }
    const stats = roomStats(m, room);
    if (stats.tiles === 0) {
      this.dropCurrentGoal();
      return false;
    }
    const outside = level === 1 && roomIsOutside(m, room);
    const half = PERSON_WIDTH >> 1;
    const obstacles: PenaltyRect[] = [];
    if (!ghost) {
      const mr = routeRect(me, pd);
      const myRect = penaltyRect(mr[3], mr[2], mr[1], mr[0], 0);
      for (const o of m.list) {
        const x = o.obj;
        if (o === this.person || (x.objectData[29]! & 0xffff) !== room || this.shouldIgnore(o)) continue;
        let w = x.objectData[10] !== 0 ? 10 : BLOCKED;
        const r = routeRect(x, o.person?.personData ?? null);
        let rect = penaltyRect(r[3], r[2], r[1], r[0], w);
        if (x.selector.objd.objectType === 8) {
          const f = wallBlockFlags(x);
          if (f & 1) {
            w = 10000;
            rect = penaltyRect(r[3], r[2], r[1], r[2] + 1, w);
            inflateRect(rect, half, half);
          }
          if (f & 4) {
            w = 10000;
            rect = penaltyRect(r[1] - 1, r[2], r[1], r[0], w);
            inflateRect(rect, half, half);
          }
          if (f & 0x10) {
            w = 10000;
            rect = penaltyRect(r[3], r[0] - 1, r[1], r[0], w);
            inflateRect(rect, half, half);
          }
          if (f & 0x40) {
            w = 10000;
            rect = penaltyRect(r[3], r[2], r[3] + 1, r[0], w);
            inflateRect(rect, half, half);
          }
        }
        // Objects the person already overlaps are left out.
        if (findIntersectingRect(myRect, [rect]) !== -1) continue;
        if (x.selector.objd.objectType === 2 || w === BLOCKED || w > 7) inflateRect(rect, half, half);
        obstacles.push(rect);
      }
    }
    let partition: PenaltyRect[] | null = null;
    if (!ghost) partition = running && outside ? buildRoomPartition(m, room, false) : roomPartition(m, room);
    const goals: PenaltyRect[] = [];
    const goalMap: number[] = [];
    this.goals.forEach((g, i) => {
      if (g.score <= 0) return;
      goals.push(penaltyRect(g.fx, g.fy, g.fx + 1, g.fy + 1, (this.maxScore - g.score) * 16));
      goalMap.push(i);
    });
    const params: RoutingParams = {
      goals,
      obstacles,
      partition,
      x: this.startFx,
      y: this.startFy,
      noGoalPoint: false,
      limitSize: false,
      maxSize: 0x40,
      defaultWeight: !running && outside ? 3 : 0,
      smooth: true,
    };
    if (ghost || (stats.objects / (stats.area * 2) <= 0.2 && stats.area > 99)) {
      params.limitSize = true;
      params.maxSize = 0x80;
    }
    const budget = Math.min(1000, goals.length * stats.area + 50);
    const path = new Path();
    if (stats.area > 0x100 && params.limitSize) {
      // Reachability first, with unlimited rectangles.
      params.limitSize = false;
      path.initPath(params);
      path.run(budget);
      const unreachable = path.points.length === 0;
      params.limitSize = true;
      if (unreachable) {
        this.result = ROUTE.noPath;
        return false;
      }
    }
    path.initPath(params);
    path.run(budget);
    if (path.goalIndex === -1) this.dropCurrentGoal();
    else this.goalIndex = goalMap[path.goalIndex]!;
    if (path.points.length === 0) {
      this.result = ROUTE.noPath;
      return false;
    }
    const out: PathPt[] = path.points.map((p) => ({ fx: p.x, fy: p.y }));
    // The walk engine starts from the person: when routing from a chair's side, the person's position comes first.
    if (this.startFx !== me.fx || this.startFy !== me.fy) out.unshift({ fx: me.fx, fy: me.fy });
    this.path = out;
    return true;
  }
}

/** The person width (lbl_105BA224, 1/16 tile) ComputeRect gives people. */
const PERSON_WIDTH = 6;

/**
 * cXObject::ComputeRect for the router: people are PERSON_WIDTH wide (0
 * for ghosts, person data 84 / 68 bit 0), their OBJD footprint mask
 * (+0x9a) minus the route footprint (person data 73, facing an even
 * direction); other objects keep their footprint (+0x100..+0x10c).
 * [maxY, maxX, minY, minX].
 */
function routeRect(x: XObject, pd: Int16Array | null): [number, number, number, number] {
  if (x.selector.objd.objectType !== 2) return x.rect;
  const ghost = pd !== null && ((pd[84]! & 1) === 1 || (pd[68]! & 1) === 1);
  const h = ghost ? 0 : PERSON_WIDTH >> 1;
  const r: [number, number, number, number] = [x.fy + h, x.fx + h, x.fy - h, x.fx - h];
  const mask = x.selector.objd.i16(0x9a);
  const fp = pd !== null && (x.objectData[1]! & 1) === 0 ? pd[73]! : 0;
  if (mask !== 0 || fp !== 0) {
    const n = [(mask & 0xf) - (fp & 0xf), ((mask >> 4) & 0xf) - ((fp >> 4) & 0xf), ((mask >> 8) & 0xf) - ((fp >> 8) & 0xf), ((mask >> 12) & 0xf) - ((fp >> 12) & 0xf)];
    const k = Math.trunc((8 - x.objectData[1]!) / 2);
    r[2] += n[k & 3]!;
    r[1] -= n[(k + 1) & 3]!;
    r[0] -= n[(k + 2) & 3]!;
    r[3] += n[(k + 3) & 3]!;
  }
  return r;
}

/** cXObject::GetWallBlockFlags: object data 53 rotated with the object. */
function wallBlockFlags(x: XObject): number {
  const b = x.objectData[53]!;
  if (b === 0) return 0;
  const v = b << (x.objectData[1]! & 0x3f);
  return (v | (v >> 8)) & 0xff;
}

/**
 * Room::GetPartition: BuildRoomPartition cached per room until the house
 * changes (RoomManager::ClearRoomPartitions on EnterLiveMode, Room::Clear
 * when the rooms are recomputed). The port keys the cache on the level's
 * room, wall and floor arrays.
 */
const partitions = new WeakMap<FixedWorld, Map<number, { key: number; rects: PenaltyRect[] }>>();

function roomPartition(m: SimModule, room: number): PenaltyRect[] {
  const fixed = m.sim.world!;
  const level = roomLevel(room);
  let h = 0x811c9dc5;
  for (const a of [fixed.rooms[level - 1]!, fixed.walls[level - 1]!, fixed.floors[level - 1]!]) {
    const d = a.data;
    for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i]!, 0x01000193);
  }
  let cache = partitions.get(fixed);
  if (!cache) {
    cache = new Map();
    partitions.set(fixed, cache);
  }
  const c = cache.get(room);
  if (c && c.key === h) return c.rects;
  const rects = buildRoomPartition(m, room, true);
  cache.set(room, { key: h, rects });
  return rects;
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
