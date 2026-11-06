/**
 * Object placement: the cXObject / cXMTObject methods the buy and build
 * tools place, test and pick up objects with, plus the wall tests of
 * walls.cpp (CheckWallFlags, SectWall).
 *
 * Coordinates are world fixed point (1/16 tile, unrotated): `fx` is cXObject
 * +0xf8 (tile x), `fy` +0xf4 (tile y); FTilePt is { y, x } in the original.
 * Every function reports its failure reason the way the original does, in
 * the global placement error (lbl_105BA1A8): `Placement.error`, a code whose
 * text is UIText.iff STR# 137 ("PlacementErrs") string code - 1.
 *
 * The hierarchy (HierSever / HierSetSite): an object stands on a tile (the
 * level's tile object array holds the first one) or in a slot of a
 * container; objects sharing a tile are chained through slot 0 (the new one
 * becomes the head, the previous head goes into its slot 0, with parent id =
 * the new one and slot hier number 0).
 *
 * Not ported here (SimAntics or rendering side): the trees the original runs
 * on place / pickup / allow-intersection (`hooks.runCheckTree`), room ids
 * (ResolveRoomID), UpdateWallAdjacency, UpdateChairFacing, lights, render
 * layers and damage rectangles.
 */

import { cheatFlags } from "../../cheatflags.js";
import { resolveRoomID } from "../../sim/routing.js";
import { OD, type ObjectModule, type XObject } from "../objects.js";
import { getWall, segIndex, SEG_ROTATION, type TileWalls } from "../tilewalls.js";
import { setFixedWall } from "./wallworld.js";
import type { FixedWorld } from "../world.js";

/** Object data indices used by placement (Behavior.iff STR# 141), beyond objects.ts OD. */
export const ODX = {
  wallAdjacency: 5,
  repairState: 15,
  birthMinute: 21,
  rotationNotches: 23,
  birthHour: 24,
  weight: 27,
  supportStrength: 28,
  roomPlacement: 30,
  flagField2: 40,
  birthYear: 45,
  birthMonth: 46,
  birthDay: 47,
  wallBlockFlags: 53,
  useCount: 62,
  exclusivePlacementFlags: 63,
} as const;

/** Placement flags (OD 42, STR# 202). */
export const PF = {
  onFloor: 0x1,
  onTerrain: 0x2,
  onWater: 0x4,
  onSlope: 0x100,
  inAir: 0x200,
  inWall: 0x400,
  allowOnPool: 0x800,
  requirePool: 0x1000,
  requireWater: 0x2000,
} as const;

/** Object flags (OD 8, STR# 142). */
const FL_ZERO_EXTENT = 0x4;
const FL_IN_USE = 0x20;
const FL_CHAIR_FACING = 0x100;
/** Movement flags (OD 43, STR# 203). */
const MV_PLAYERS_CAN_MOVE = 0x2;
const MV_PLAYERS_CAN_DELETE = 0x8;
/** OBJD +0x12 object type 2 (person). */
const TYPE_PERSON = 2;
/** lbl_105BA224: a person's width (1/16 tile) in cXObject::ComputeRect. */
const PERSON_WIDTH = 6;

/** ObjFnTable entries the placement code runs trees for. */
export const FN = {
  init: 0,
  allowIntersection: 5,
  place: 9,
  pickup: 10,
  userPlace: 11,
  userPickup: 12,
} as const;

/** What placement needs from the simulation (SimAntics); every member is optional. */
export interface ObjectBehaviorHooks {
  /** TreeSim::RunCheckTree on `obj`'s function table entry; false when the object has no such tree. */
  runCheckTree?(obj: XObject, entry: number, param: number): boolean;
  /** cXObject::Reset's init tree on a new object; return false to fall back to seeded data. */
  runInitTree?(obj: XObject): boolean;
  /** ObjectModule::OnEnterWorld / OnExitWorld. */
  onEnterWorld?(obj: XObject): void;
  onExitWorld?(obj: XObject): void;
  /** ObjectModule::KillObject: the object left the module (the simulation drops it too). */
  onKill?(obj: XObject): void;
  /** The person data (cXPerson +0x58c) of a person object, null for others. */
  personData?(obj: XObject): Int16Array | null;
  /** cSimulator +0x36 (global 19, the mode freeze: 0 Live, 1 Build, 2 Buy); 0 when missing. */
  modeFreeze?(): number;
  /** GlobalDispatch(0xf3, room): an object with a room impact changed rooms (House::DoCommand -> RoomManager::RoomScoreChanged). */
  roomChanged?(room: number): void;
}

/** FTilePt (fixed point, world space). */
export interface FPt {
  fx: number;
  fy: number;
}

/** PlacementSpec / HierarchySite. */
export interface PlacementSpec {
  /** [0]: in the world (false = taken out). */
  placing: boolean;
  /** +4 / +8 */
  fy: number;
  fx: number;
  /** +0xc */
  container: XObject | null;
  /** +0x10: slot index (GetPlacementSpec: index - 1, -1 = none; HierSetSite: raw objectSlots index). */
  slot: number;
  /** +0x14 */
  level: number;
}

/** Tile delta tables lbl_105BA22C (x) / lbl_105BA228 (y): the 8 neighbors, then the tile itself. */
const NEIGHBOR_DX = [0, 1, 1, 1, 0, -1, -1, -1, 0];
const NEIGHBOR_DY = [-1, -1, 0, 1, 1, 1, 0, -1, 0];
/** CheckWallFlags' segment order (lbl_105BBCB0), object-relative after TileWalls::Rotate. */
const WALL_ORDER = [0x02, 0x01, 0x04, 0x08];

/** Signed char of a fixed-point coordinate's tile (the original's `(char)(f >> 4)`). */
export function tileOf(f: number): number {
  return ((f >> 4) << 24) >> 24;
}

export class Placement {
  /** lbl_105BA1A8: the last placement error code. */
  error = 0;
  /** lbl_105BA248: the object TestIntersection hit. */
  obstacle: XObject | null = null;
  /** lbl_105BA244: build/buy anywhere (the "move_objects" cheat). */
  get anywhere(): boolean {
    return cheatFlags.moveObjects;
  }
  /** WallManager::AsynchronousRefresh after a portal changed a wall style (cXPortal::ApplyWallStyle / Pickup). */
  onWallsChanged: ((level: number) => void) | null = null;

  constructor(
    readonly module: ObjectModule,
    readonly world: FixedWorld,
    readonly hooks: ObjectBehaviorHooks = {},
    /** GViewer::GetLevel (the viewer's current level). */
    readonly viewerLevel: () => number = () => 1,
  ) {}

  get(id: number): XObject | null {
    return id > 0 ? (this.module.objects.get(id) ?? null) : null;
  }

  // --- world access -------------------------------------------------------------

  private get size(): number {
    return this.world.size;
  }

  /** The "out of bounds" test of a tile: outside 1 .. size - 2. */
  outOfBounds(x: number, y: number): boolean {
    return x < 1 || x >= this.size - 1 || y < 1 || y >= this.size - 1;
  }

  private outOfGrid(x: number, y: number): boolean {
    return x < 0 || y < 0 || x >= this.size || y >= this.size;
  }

  /** The level's tile object id (0 off the grid and on levels other than 1 and 2). */
  tileObjectId(x: number, y: number, level: number): number {
    if (this.outOfGrid(x, y) || level < 1 || level > 2) return 0;
    return this.world.objects[level - 1]!.s16(x, y);
  }

  private setTileObjectId(x: number, y: number, level: number, id: number): void {
    if (this.outOfGrid(x, y) || level < 1 || level > 2) return;
    const a = this.world.objects[level - 1]!;
    const o = a.offset(x, y);
    a.data[o] = id & 0xff;
    a.data[o + 1] = (id >> 8) & 0xff;
  }

  private floor(x: number, y: number, level: number): number {
    if (this.outOfGrid(x, y) || level < 1 || level > 2) return 0;
    return this.world.floors[level - 1]!.u16(x, y);
  }

  private tileFlags(x: number, y: number, level: number): number {
    if (this.outOfGrid(x, y) || level < 1 || level > 2) return 0;
    return this.world.flags[level - 1]!.u8(x, y);
  }

  private setTileFlags(x: number, y: number, level: number, v: number): void {
    if (this.outOfGrid(x, y) || level < 1 || level > 2) return;
    const a = this.world.flags[level - 1]!;
    a.data[a.offset(x, y)] = v & 0xff;
  }

  /**
   * cXObject::GetObstacleAtLocation (100c0a00): the first object of the
   * tile's list (the tile object, then slot 0 down) in the way; an object
   * is not when flags 0x4 is set and 0x2 clear, or 0x4 clear and 0x10 set.
   * Levels 1 and 2 only.
   */
  obstacleAtLocation(at: FPt, level: number): XObject | null {
    for (let o = this.get(this.tileObjectId(tileOf(at.fx), tileOf(at.fy), level)), guard = 0; o && guard < 256; guard++) {
      const f = Placement.uod(o, OD.flags);
      const clear = f & 4 ? !(f & 2) : !!(f & 0x10);
      if (!clear) return o;
      o = this.get(o.objectSlots[0]?.containedId ?? 0);
    }
    return null;
  }

  /** ObjectIterator(House, tile): every object of the tile's hierarchy, depth first. */
  *tileObjects(x: number, y: number, level: number): Generator<XObject> {
    const head = this.get(this.tileObjectId(x, y, level));
    if (head) yield* this.hierarchy(head, 0);
  }

  private *hierarchy(obj: XObject, depth: number): Generator<XObject> {
    yield obj;
    if (depth > 64) return;
    for (const s of obj.objectSlots) {
      const c = this.get(s.containedId);
      if (c) yield* this.hierarchy(c, depth + 1);
    }
  }

  // --- object data helpers -----------------------------------------------------

  static od(obj: XObject, i: number): number {
    return obj.objectData[i]!;
  }

  static setOd(obj: XObject, i: number, v: number): void {
    obj.objectData[i] = v;
  }

  private static uod(obj: XObject, i: number): number {
    return obj.objectData[i]! & 0xffff;
  }

  /** cXMTObject's chain: the head (+0x190 = 0) first, then its parts in module order. */
  chain(obj: XObject): XObject[] {
    if (obj.selector.objd.masterId === 0) return [obj];
    const head = obj.mtLeadId !== 0 ? (this.get(obj.mtLeadId) ?? obj) : obj;
    const parts = [head];
    for (const o of this.module.objects.values()) if (o !== head && o.mtLeadId === head.objectId) parts.push(o);
    return parts;
  }

  isMultiTile(obj: XObject): boolean {
    return obj.selector.objd.masterId !== 0;
  }

  /** IsPartOfMe (cXObject: itself; cXMTObject: any part of the chain). */
  isPartOfMe(obj: XObject, other: XObject): boolean {
    if (other === obj) return true;
    if (!this.isMultiTile(obj)) return false;
    // chain(obj).includes(other) without building the chain (it scans every object).
    const head = obj.mtLeadId !== 0 ? (this.get(obj.mtLeadId) ?? obj) : obj;
    return other === head || (other.mtLeadId === head.objectId && this.module.objects.get(other.objectId) === other);
  }

  // --- hierarchy ------------------------------------------------------------------

  /** cXObject::GetPlacementSpec. */
  getPlacementSpec(obj: XObject): PlacementSpec {
    const out = this.outOfBounds(tileOf(obj.fx), tileOf(obj.fy));
    const spec: PlacementSpec = { placing: !out, fy: out ? -16 : obj.fy, fx: out ? -16 : obj.fx, container: null, slot: -1, level: obj.level };
    let top = obj;
    for (let guard = 0; guard < 256; guard++) {
      const parent = Placement.od(top, OD.slotHierNumber) === 0 ? this.get(top.parentId) : null;
      if (!parent) break;
      top = parent;
    }
    spec.container = this.get(top.parentId);
    const hier = Placement.od(top, OD.slotHierNumber);
    spec.slot = hier;
    if (hier !== -1) {
      spec.slot = hier - 1;
      if (spec.slot === -1) Placement.setOd(top, OD.slotHierNumber, -1);
    }
    return spec;
  }

  /** cXObject::IsInWorld. */
  isInWorld(obj: XObject): boolean {
    return this.getPlacementSpec(obj).placing;
  }

  /** cXObject::HierSever: out of the tile array or the container's slot. */
  hierSever(obj: XObject): void {
    const parent = this.get(obj.parentId);
    if (parent) {
      const s = parent.objectSlots[Placement.od(obj, OD.slotHierNumber)];
      if (s) s.containedId = 0;
    } else if (!this.outOfBounds(tileOf(obj.fx), tileOf(obj.fy))) {
      this.setTileObjectId(tileOf(obj.fx), tileOf(obj.fy), obj.level, 0);
    }
    Placement.setOd(obj, OD.parentId, 0);
    Placement.setOd(obj, OD.slotHierNumber, -1);
  }

  /** cXObject::HierSetSite (`site.slot` is the raw objectSlots index). */
  hierSetSite(obj: XObject, site: PlacementSpec): void {
    if (!site.placing) {
      this.hierSever(obj);
      return;
    }
    if (!site.container) {
      this.setTileObjectId(tileOf(site.fx), tileOf(site.fy), site.level, obj.objectId);
      Placement.setOd(obj, OD.slotHierNumber, -1);
      Placement.setOd(obj, OD.parentId, 0);
    } else {
      const s = site.container.objectSlots[site.slot];
      if (s) s.containedId = obj.objectId;
      Placement.setOd(obj, OD.slotHierNumber, site.slot);
      Placement.setOd(obj, OD.parentId, site.container.objectId);
    }
    obj.level = site.level;
  }

  // --- location ---------------------------------------------------------------------

  /**
   * cXObject::ComputeRect: footprint [maxY, maxX, minY, minX] (+0x100..+0x10c) at `p`.
   * People are lbl_105BA224 (6) wide, 0 when person data 84 or 68 has bit 0
   * (routing through a portal); facing an even direction, their route
   * footprint (person data 73) is taken off the OBJD footprint mask.
   */
  computeRect(obj: XObject, p: FPt): [number, number, number, number] {
    const objd = obj.selector.objd;
    const pd = objd.objectType === TYPE_PERSON ? (this.hooks.personData?.(obj) ?? null) : null;
    let w = objd.i16(0x86) || 0x10;
    if (objd.objectType === TYPE_PERSON) w = pd && ((pd[84]! & 1) === 1 || (pd[68]! & 1) === 1) ? 0 : PERSON_WIDTH;
    const half = Math.trunc(w / 2);
    const r: [number, number, number, number] = [p.fy + half, p.fx + half, p.fy - half, p.fx - half];
    const mask = objd.i16(0x9a) & 0xffff;
    const fp = pd && (obj.dir & 1) === 0 ? pd[73]! & 0xffff : 0;
    if (mask !== 0 || fp !== 0) {
      const n = [(mask & 0xf) - (fp & 0xf), ((mask >> 4) & 0xf) - ((fp >> 4) & 0xf), ((mask >> 8) & 0xf) - ((fp >> 8) & 0xf), ((mask >> 12) & 0xf) - ((fp >> 12) & 0xf)];
      const k = Math.trunc((8 - obj.dir) / 2);
      r[2] += n[k & 3]!;
      r[1] -= n[(k + 1) & 3]!;
      r[0] -= n[(k + 2) & 3]!;
      r[3] += n[(k + 3) & 3]!;
    }
    return r;
  }

  /** cXObject::SetLocation (contained objects follow; the room id is resolved). */
  setLocation(obj: XObject, p: FPt, level: number, depth = 0): void {
    obj.isStatic = false;
    obj.staticWhenIdle = false;
    obj.fx = p.fx;
    obj.fy = p.fy;
    obj.level = level;
    obj.rect = this.computeRect(obj, p);
    // ResolveRoomID into object data 29; an object with a room impact (object data 7) tells the old and the new room (0xf3).
    const old = Placement.od(obj, 29);
    const room = resolveRoomID(this.world, p.fx, p.fy, level);
    Placement.setOd(obj, 29, room);
    if (old !== room && Placement.od(obj, 7) !== 0) {
      this.hooks.roomChanged?.(old);
      this.hooks.roomChanged?.(room);
    }
    if (depth > 64) return;
    for (const s of obj.objectSlots.slice(1)) {
      const c = this.get(s.containedId);
      if (c) this.setLocation(c, p, level, depth + 1);
    }
  }

  /** cXObject::Turn. */
  turn(obj: XObject, n: number): void {
    const notches = Placement.od(obj, ODX.rotationNotches);
    if (n === 0 || notches === 0) return;
    Placement.setOd(obj, OD.direction, (obj.dir + notches * n) & 7);
    obj.isStatic = false;
    obj.staticWhenIdle = false;
    obj.rect = this.computeRect(obj, obj);
  }

  // --- TestAndPlace -------------------------------------------------------------------

  /** cXObject::TestAndPlace: `doIt` false tests a placement, true performs it (or the removal). */
  testAndPlace(obj: XObject, spec: PlacementSpec, doIt: boolean): boolean {
    if (!spec.placing) {
      if (doIt) {
        const site: PlacementSpec = {
          placing: !this.outOfBounds(tileOf(obj.fx), tileOf(obj.fy)),
          fy: obj.fy,
          fx: obj.fx,
          container: this.get(obj.parentId),
          slot: Placement.od(obj, OD.slotHierNumber),
          level: obj.level,
        };
        this.hierSever(obj);
        const next = this.get(obj.objectSlots[0]?.containedId ?? 0);
        if (next) {
          this.hierSever(next);
          this.hierSetSite(next, site);
        }
      }
      return true;
    }
    if (!doIt && !this.testPlacement(obj, spec)) return false;
    const slotRaw = spec.slot === -1 ? -1 : spec.slot + 1;
    let occupant: XObject | null = null;
    if (!spec.container) {
      if (spec.level >= 1 && spec.level <= 3) occupant = this.get(this.tileObjectId(tileOf(spec.fx), tileOf(spec.fy), spec.level));
    } else {
      occupant = this.get(spec.container.objectSlots[slotRaw]?.containedId ?? 0);
    }
    if (doIt && occupant !== obj) {
      if (occupant) this.hierSever(occupant);
      this.hierSetSite(obj, { ...spec, slot: slotRaw });
      if (occupant) this.hierSetSite(occupant, { placing: true, fy: spec.fy, fx: spec.fx, container: obj, slot: 0, level: obj.level });
    }
    return true;
  }

  /** TestAndPlace's checks (param_3 == 0). */
  private testPlacement(obj: XObject, spec: PlacementSpec): boolean {
    const notPerson = obj.selector.objd.objectType !== TYPE_PERSON;
    const x = tileOf(spec.fx);
    const y = tileOf(spec.fy);
    if (this.outOfBounds(x, y)) {
      this.error = 1;
      return false;
    }
    const level = spec.level;
    if (level < 1 || level > 3) {
      this.error = 2;
      return false;
    }
    const pf = Placement.uod(obj, OD.placementFlags);
    if (level > 1 && pf & PF.requirePool) {
      this.error = 0x1f;
      return false;
    }
    if (notPerson && !this.checkWallFlags(spec, obj.dir, Placement.uod(obj, OD.wallPlacementFlags)) && !spec.container) return false;
    if (!(pf & PF.inAir) && level > 1 && this.floor(x, y, level) === 0) {
      this.error = level === this.viewerLevel() ? 0x12 : 0x29;
      return false;
    }
    if (!this.world.hasWater(x, y, 1)) {
      if (pf & PF.requireWater) {
        this.error = 0x2f;
        return false;
      }
    } else if (!(pf & PF.onWater)) {
      let floats = false;
      for (const o of this.tileObjects(x, y, 1)) if (Placement.uod(o, OD.flags) & 0x1000) floats = true;
      if (!floats) {
        this.error = 0x1d;
        return false;
      }
    }
    const pool = this.world.pool.u8(x, y);
    if (level === 1) {
      if (!(pf & PF.allowOnPool) && pool < 0x10) {
        this.error = 0x1d;
        return false;
      }
      if (pf & PF.requirePool && pool > 0xf) {
        this.error = 0x1e;
        return false;
      }
    }
    if (!(pf & PF.onSlope) && !spec.container) {
      const o = this.world.alt.offset(x, y);
      const a = this.world.alt.data;
      if (a[o] !== a[o + 1] || a[o] !== a[o + 2] || a[o] !== a[o + 3]) {
        this.error = 0x11;
        return false;
      }
    }
    if (!(pf & PF.onFloor) && !spec.container && (this.floor(x, y, level) !== 0 || (level === 1 && pool === 0x10))) {
      this.error = level === this.viewerLevel() ? 0x13 : 0x2a;
      return false;
    }
    if (!(pf & PF.onTerrain) && !spec.container && level === 1 && this.floor(x, y, level) === 0) {
      this.error = 0x14;
      return false;
    }
    const roomPlacement = Placement.od(obj, ODX.roomPlacement);
    if (roomPlacement !== 0 && !spec.container) {
      const inside = (this.tileFlags(x, y, level) >> 2) & 1;
      if (roomPlacement === 1 && !inside) {
        this.error = 9;
        return false;
      }
      if (roomPlacement === 2 && inside) {
        this.error = 10;
        return false;
      }
    }
    const allowedHeights = Placement.od(obj, OD.allowedHeightFlags);
    let height: number;
    if (!spec.container) {
      if (!this.testIntersection(obj, spec, level)) return false;
      height = 1;
    } else {
      const h = this.testContainer(obj, spec, notPerson);
      if (h === null) return false;
      height = h;
    }
    if (height === 0 || allowedHeights === 0 || !(allowedHeights & (1 << ((height - 1) & 0x3f)))) {
      this.error = 0x18;
      return false;
    }
    return true;
  }

  /** TestAndPlace's container branch: the slot's standard height, or null when it cannot take the object. */
  private testContainer(obj: XObject, spec: PlacementSpec, notPerson: boolean): number | null {
    const c = spec.container!;
    const flags = Placement.uod(obj, OD.flags);
    if (flags & FL_ZERO_EXTENT || Placement.uod(c, OD.flags) & FL_ZERO_EXTENT) {
      this.error = 0xc;
      return null;
    }
    const slot = spec.slot >= 0 && spec.slot < c.objectSlots.length - 1 ? c.objectSlots[spec.slot + 1]! : null;
    if (!slot) {
      this.error = 0xd;
      return null;
    }
    if (slot.containedId !== 0 && slot.containedId !== obj.objectId) {
      this.error = 0xb;
      return null;
    }
    const n = c.objectSlots.length;
    const height = slot.height;
    // Simulator +0x36 (global 19): in buy mode an object goes only in the (0, 0) slot of a container with
    // several slots (unless flag 0x2000); people's hands take nothing outside live mode.
    const freeze = this.hooks.modeFreeze?.() ?? 0;
    if (notPerson && !(flags & 0x2000) && freeze === 2 && (slot.x !== 0 || slot.y !== 0) && n - 1 > 1) {
      this.error = 3;
      return null;
    }
    if (c.selector.objd.objectType === TYPE_PERSON && freeze !== 0) {
      this.error = 0xd;
      return null;
    }
    for (let i = n - 2; i >= 0; i--) {
      const other = c.objectSlots[i + 1]!;
      if (other.height !== height || other.containedId === 0 || other.containedId === obj.objectId) continue;
      if (other.x === 0 && other.y === 0 && notPerson) {
        const held = this.get(other.containedId);
        if (held && !(Placement.uod(held, OD.flags) & 0x2000)) {
          this.error = 0xb;
          return null;
        }
      }
      if (slot.x === 0 && slot.y === 0 && notPerson && !(flags & 0x2000)) {
        this.error = 0xb;
        return null;
      }
    }
    if (Placement.od(c, ODX.supportStrength) < Placement.od(obj, ODX.weight)) {
      this.error = 0xe;
      return null;
    }
    for (let p: XObject | null = c, guard = 0; p && guard < 64; guard++) {
      if (p === obj) {
        this.error = 0xb;
        return null;
      }
      p = this.getPlacementSpec(p).container;
    }
    return height;
  }

  /** cXObject::TestIntersection: other objects on the 3x3 tiles around, then the walls. */
  private testIntersection(obj: XObject, p: FPt, level: number): boolean {
    const isPerson = obj.selector.objd.objectType === TYPE_PERSON;
    // A person whose person data 68 has bit 0 (walking through a portal) intersects nothing.
    // (The person data 84 case, tested against the running tree's stack object, is not ported.)
    if (isPerson && ((this.hooks.personData?.(obj)?.[68] ?? 0) & 1) === 1) return true;
    const rect = this.computeRect(obj, p);
    const myFlags = Placement.uod(obj, OD.flags);
    const zero = (myFlags & FL_ZERO_EXTENT) !== 0;
    const x0 = tileOf(p.fx);
    const y0 = tileOf(p.fy);
    for (let i = 0; i < 9; i++) {
      const x = x0 + NEIGHBOR_DX[i]!;
      const y = y0 + NEIGHBOR_DY[i]!;
      if (this.outOfBounds(x, y)) continue;
      for (let other = this.get(this.tileObjectId(x, y, level)), guard = 0; other && guard < 256; other = this.get(other.nextSiblingId), guard++) {
        if (this.isPartOfMe(obj, other)) continue;
        const otherFlags = Placement.uod(other, OD.flags);
        let rectTest = false;
        if (isPerson) {
          rectTest = personMayCollide(otherFlags);
        } else if (other.isPerson) {
          rectTest = ((this.hooks.personData?.(other)?.[68] ?? 0) & 1) !== 1 && !personMayCollide(myFlags);
        } else {
          const otherZero = (otherFlags & FL_ZERO_EXTENT) !== 0;
          if (!zero && !otherZero) {
            rectTest = true;
          } else if (i === 8) {
            if (Placement.od(obj, ODX.exclusivePlacementFlags) & Placement.od(other, ODX.exclusivePlacementFlags) & 1) {
              this.error = 0xb;
              return false;
            }
            if (zero && otherZero) {
              const a = this.getRequiredSegment(obj);
              const b = this.getRequiredSegment(other);
              const wa = obj.selector.getMasterSelector().objd.buildModeType === 2;
              const wb = other.selector.getMasterSelector().objd.buildModeType === 2;
              if (wa === wb && a === b && a !== 0) {
                this.error = 0x16;
                return false;
              }
            }
          }
        }
        if (rectTest && !this.allowsIntersection(obj, other)) {
          const r = other.rect;
          if (r[2] < rect[0] && rect[2] < r[0] && r[3] < rect[1] && rect[3] < r[1]) {
            this.error = 0xb;
            this.obstacle = other;
            return false;
          }
        }
      }
    }
    if (!(Placement.uod(obj, OD.placementFlags) & PF.inWall) && this.sectWall(rect, level)) {
      this.error = 7;
      return false;
    }
    return true;
  }

  /** The "allow intersection" trees, both ways. */
  private allowsIntersection(obj: XObject, other: XObject): boolean {
    const run = this.hooks.runCheckTree;
    if (!run) return false;
    return run(obj, FN.allowIntersection, other.objectId) || run(other, FN.allowIntersection, obj.objectId);
  }

  /** cXObject::GetRequiredSegment: the wall segment a wall object (wall placement flags 1 / 4) hangs on. */
  getRequiredSegment(obj: XObject): number {
    const f = Placement.uod(obj, OD.wallPlacementFlags) & 5;
    let seg = f === 1 ? 2 : f === 4 ? 8 : 0;
    if (seg !== 0 && obj.dir !== 0) seg = SEG_ROTATION[Math.trunc(obj.dir / 2) & 3]![seg]!;
    return seg;
  }

  /** CheckWallFlags(FTilePt, level, direction, wall placement flags). */
  private checkWallFlags(p: PlacementSpec, dir: number, wpf: number): boolean {
    const x = tileOf(p.fx);
    const y = tileOf(p.fy);
    const walls = getWall(this.world, x, y, p.level);
    const diag = (walls.segs & 0x30) !== 0;
    if (wpf & 0x40 && !diag) {
      this.error = 0x17;
      return false;
    }
    if (!(wpf & 0x80) && diag) {
      this.error = 7;
      return false;
    }
    if (wpf === 0) return true;
    const r = ((8 - dir) >>> 1) & 3;
    const w = r !== 0 ? rotateWalls(walls, r) : { segs: walls.segs, styles: walls.styles };
    const has = (s: number): boolean => (w.segs & s) === s;
    const corner = (has(1) && has(2)) || (has(1) && has(8)) || (has(2) && has(4)) || (has(8) && has(4));
    if (wpf & 0x20 && !corner) {
      this.error = 4;
      return false;
    }
    if (wpf & 0x10 && corner) {
      this.error = 5;
      return false;
    }
    const required = [wpf & 1, (wpf >> 3) & 1, (wpf >> 1) & 1, (wpf >> 2) & 1];
    const forbidden = [(wpf >> 8) & 1, (wpf >> 11) & 1, (wpf >> 9) & 1, (wpf >> 10) & 1];
    const present: boolean[] = [];
    const usable: boolean[] = [];
    for (const seg of WALL_ORDER) {
      const on = has(seg);
      const style = w.styles[segIndex(seg)]!;
      present.push(on);
      usable.push(on && !(style === 2 || style === 0xc || style === 0xd || style === 0xe));
    }
    for (let i = 0; i < 4; i++) {
      if (forbidden[i] && present[i]) {
        this.error = 7;
        return false;
      }
      if (required[i] && !usable[i]) {
        this.error = present[i] ? 0x16 : 6;
        return false;
      }
    }
    return true;
  }

  /** SectWall(FTileRect, level): does a wall cross the footprint? */
  private sectWall(r: readonly [number, number, number, number], level: number): boolean {
    for (let y = r[2] >> 4; y <= (r[0] - 1) >> 4; y++) {
      for (let x = r[3] >> 4; x <= (r[1] - 1) >> 4; x++) {
        if (this.outOfGrid(x, y)) continue;
        const walls = getWall(this.world, x, y, level);
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

  // --- cXObject placement ---------------------------------------------------------

  /** cXObject::CanPlace. */
  canPlaceSingle(obj: XObject, p: FPt, level: number, container: XObject | null, slot: number): boolean {
    const at = container ?? p;
    return this.testAndPlace(obj, { placing: true, fy: at.fy, fx: at.fx, container, slot: container ? slot : -1, level }, false);
  }

  /** cXObject::Place. */
  placeSingle(obj: XObject, p: FPt, level: number, container: XObject | null, slot: number, notify: boolean): void {
    const oldX = obj.fx;
    const oldY = obj.fy;
    const wasOut = this.outOfBounds(tileOf(oldX), tileOf(oldY));
    const oldLevel = obj.level;
    this.testAndPlace(obj, { placing: false, fy: 0, fx: 0, container: null, slot: -1, level: 0 }, true);
    const column = obj.selector.getMasterSelector().objd.buildModeType === 6;
    if (column && !this.outOfBounds(oldX >> 4, oldY >> 4)) this.setTileFlags(oldX >> 4, oldY >> 4, oldLevel, this.tileFlags(oldX >> 4, oldY >> 4, oldLevel) & 0xf7);
    const lvl = container ? container.level : level;
    const at = container ?? p;
    const spec: PlacementSpec = { placing: true, fy: at.fy, fx: at.fx, container, slot: container ? slot : -1, level: lvl };
    this.testAndPlace(obj, spec, true);
    Placement.setOd(obj, OD.containerId, container ? container.objectId : 0);
    Placement.setOd(obj, OD.slotNumber, spec.slot);
    this.setLocation(obj, { fx: at.fx, fy: at.fy }, lvl);
    if (!this.isMultiTile(obj)) this.hooks.runCheckTree?.(obj, FN.place, 0);
    if (container) this.hooks.runCheckTree?.(container, FN.place, 0);
    if ((oldX !== obj.fx || oldY !== obj.fy) && wasOut && notify) this.hooks.onEnterWorld?.(obj);
    const nx = obj.fx >> 4;
    const ny = obj.fy >> 4;
    if (column && !this.outOfBounds(nx, ny)) this.setTileFlags(nx, ny, obj.level, (this.tileFlags(nx, ny, obj.level) & 0xf7) | 8);
  }

  /** cXObject::Pickup. */
  pickupSingle(obj: XObject, notify: boolean): void {
    if (!this.isMultiTile(obj)) this.hooks.runCheckTree?.(obj, FN.pickup, 0);
    const ox = obj.fx >> 4;
    const oy = obj.fy >> 4;
    const container = this.getPlacementSpec(obj).container;
    this.testAndPlace(obj, { placing: false, fy: 0, fx: 0, container: null, slot: -1, level: 0 }, true);
    Placement.setOd(obj, OD.containerId, 0);
    Placement.setOd(obj, OD.slotNumber, -1);
    const oldLevel = obj.level;
    this.setLocation(obj, { fx: -16, fy: -16 }, 1);
    Placement.setOd(obj, OD.flags, Placement.uod(obj, OD.flags) & ~FL_CHAIR_FACING);
    if (container) this.hooks.runCheckTree?.(container, FN.place, 0);
    if (obj.selector.getMasterSelector().objd.buildModeType === 6 && !this.outOfBounds(ox, oy)) {
      this.setTileFlags(ox, oy, oldLevel, this.tileFlags(ox, oy, oldLevel) & 0xf7);
    }
    if (notify) this.hooks.onExitWorld?.(obj);
  }

  /** cXObject::UserCanPlace: lot tile, centered position, then CanPlace. */
  userCanPlaceSingle(obj: XObject, p: FPt, level: number, container: XObject | null, slot: number): boolean {
    this.error = 0;
    this.obstacle = null;
    const x = tileOf(p.fx);
    const y = tileOf(p.fy);
    let bad = this.outOfBounds(x, y);
    if (!bad && !this.anywhere) bad = (this.tileFlags(x, y, 1) & 0x20) !== 0;
    if (bad) {
      this.error = 1;
      return false;
    }
    if (!this.canPlace(obj, p, level, container, slot)) return false;
    if ((p.fx & 0xf) !== 8 || (p.fy & 0xf) !== 8) return false;
    if (!this.anywhere && container) {
      const s = container.objectSlots[slot + 1];
      if (s && s.height < 8 && s.height > 4) {
        this.error = 0xb;
        return false;
      }
    }
    return true;
  }

  /**
   * cXObject::FindGoodLocation: the first tile around `start` where `obj`
   * can be placed (CanPlace at the tile's center): inside the lot, no
   * diagonal wall (segments 0x30), empty when `emptyTile` (levels 1 / 2),
   * in the start tile's room when `sameRoom`, no pool, not flagged 0x20
   * when `buildable`. `random` starts from a random tile near `start` (or
   * anywhere). The walk around the start: with no `direction` (-1) a
   * square spiral; directions 0 / 4 search along y (0, 1, -1, 2, -2, ...),
   * 2 / 6 along x, odd ones stay on the start tile (jump table
   * lbl_105BB9A4). The original works on FTilePt { y, x }: its first
   * coordinate (r28, +0xf4) is `fy`, the second (r27, +0xf8) `fx` (the
   * random start's offset loop draws y first). It gives up after 0x1000 steps or
   * size * 8 steps in a row off the lot.
   */
  findGoodLocation(
    obj: XObject,
    start: FPt,
    level: number,
    opts: { emptyTile: boolean; buildable: boolean; random: (() => number) | null; sameRoom?: boolean; direction?: number },
  ): FPt | null {
    const n = this.size;
    let fx = start.fx;
    let fy = start.fy;
    if (opts.random) {
      const rnd = opts.random;
      if (tileOf(fx) === 0 && tileOf(fy) === 0) {
        fx = ((rnd() % n) << 4) | 8;
        fy = ((rnd() % n) << 4) | 8;
      } else {
        // the offsets add up until the tile is inside the lot
        for (let guard = 0; guard < 64; guard++) {
          const ry = rnd();
          const rx = rnd();
          fy += (((ry % 10) - 5) << 4) | 8;
          fx += (((rx % 10) - 5) << 4) | 8;
          if (!this.outOfBounds(tileOf(fx), tileOf(fy))) break;
        }
      }
    }
    const sx = Math.min(Math.max(tileOf(fx), 1), n - 2);
    const sy = Math.min(Math.max(tileOf(fy), 1), n - 2);
    const rooms = level >= 1 && level <= 2 ? this.world.rooms[level - 1]! : null;
    const startRoom = rooms ? rooms.u16(sx, sy) : 0;
    const dir = opts.direction ?? -1;
    let dx = 0;
    let dy = 0;
    let offLot = 0;
    for (let step = 0; offLot < n * 8 && step < 0x1000; step++) {
      const x = sx + dx;
      const y = sy + dy;
      if (this.outOfBounds(x, y)) offLot++;
      else {
        offLot = 0;
        if (
          !(getWall(this.world, x, y, level).segs & 0x30) &&
          !(opts.emptyTile && this.tileObjectId(x, y, level) !== 0) &&
          !(opts.sameRoom && rooms && rooms.u16(x, y) !== startRoom) &&
          !(level === 1 && this.world.pool.u8(x, y) < 0x10) &&
          !(opts.buildable && !this.anywhere && this.tileFlags(x, y, 1) & 0x20) &&
          this.canPlace(obj, { fx: (x << 4) | 8, fy: (y << 4) | 8 }, level, null, 0)
        ) {
          return { fx: (x << 4) | 8, fy: (y << 4) | 8 };
        }
      }
      // r28 = dy (the FTilePt's first coordinate), r27 = dx
      if (dir === -1) {
        if (dy <= -dx && dy <= dx) dx--;
        else if (dy <= dx && dy > -dx) dy--;
        else if (dy > dx && dy >= -dx) dx++;
        else if (dy > dx && dy < -dx) dy++;
      } else if (dir === 0 || dir === 4) dy = dy > 0 ? -dy : 1 - dy;
      else if (dir === 2 || dir === 6) dx = dx > 0 ? -dx : 1 - dx;
    }
    return null;
  }

  // --- cXMTObject ----------------------------------------------------------------------

  /** Offsets of a part (+0x1a0 x, +0x1a4 y, +0x1a8 level), multi-tile only. */
  private static offsets(o: XObject): [number, number, number] {
    return [o.mt1a0, o.mt1a4, o.mt1a8];
  }

  /** cXMTObject::AssignOffsets: part offsets from the head, rotated by the head's direction. */
  assignOffsets(obj: XObject): void {
    if (!this.isMultiTile(obj)) return;
    const parts = this.chain(obj);
    const head = parts[0]!;
    const dir = head.dir & 7;
    for (const p of parts) {
      p.mt1a8 = p.mtLevelOffset - head.mtLevelOffset;
      const dx = p.mtOffsetX - head.mtOffsetX;
      const dy = p.mtOffsetY - head.mtOffsetY;
      [p.mt1a0, p.mt1a4] = dir === 0 ? [dx, dy] : dir === 2 ? [-dy, dx] : dir === 4 ? [-dx, -dy] : dir === 6 ? [dy, -dx] : [0, 0];
    }
  }

  /** CanPlace (cXObject or cXMTObject). */
  canPlace(obj: XObject, p: FPt, level: number, container: XObject | null, slot: number): boolean {
    if (!this.isMultiTile(obj)) return this.canPlaceSingle(obj, p, level, container, slot);
    if (container) {
      this.error = 0x10;
      return false;
    }
    const [ox, oy, ol] = Placement.offsets(obj);
    const hx = p.fx - ox * 16;
    const hy = p.fy - oy * 16;
    if (this.outOfBounds(tileOf(hx), tileOf(hy))) {
      this.error = 1;
      return false;
    }
    let err = 0;
    let firstAlt = -1;
    for (const part of this.chain(obj)) {
      const [px, py, pl] = Placement.offsets(part);
      const at = { fx: hx + px * 16, fy: hy + py * 16 };
      if (this.canPlaceSingle(part, at, level - ol + pl, null, slot)) continue;
      const cur = this.error;
      if (err === 0 || cur === 0x1e || cur === 0x1f) err = cur;
      if (cur !== 1 && !(Placement.uod(obj, OD.placementFlags) & PF.onSlope)) {
        const t = this.world.alt.offset(tileOf(at.fx), tileOf(at.fy));
        const a = this.world.alt.data[t]!;
        if (firstAlt === -1) firstAlt = a;
        else if (firstAlt !== a && err === 0) err = 0x11;
      }
    }
    if (err === 0) return obj.kind === "portal" ? this.portalCanPlace(obj, hx, hy, level) : true;
    this.error = err;
    return false;
  }

  /** The part's wall style (OBJD +0x5c) and the segment it needs, or null. */
  private portalWall(part: XObject): { style: number; seg: number } | null {
    const style = part.selector.objd.i16(0x5c);
    if (style === 0) return null;
    const seg = this.getRequiredSegment(part);
    return seg === 0 ? null : { style, seg };
  }

  /** cXPortal::CanPlace after cXMTObject::CanPlace: plain walls (style 1) where the parts go, centered on the tile. */
  private portalCanPlace(obj: XObject, hx: number, hy: number, level: number): boolean {
    const [, , ol] = Placement.offsets(obj);
    for (const part of this.chain(obj)) {
      const w = this.portalWall(part);
      if (!w) continue;
      const [px, py, pl] = Placement.offsets(part);
      const x = tileOf(hx + px * 16);
      const y = tileOf(hy + py * 16);
      if (this.outOfBounds(x, y)) continue;
      if (getWall(this.world, x, y, level - ol + pl).styles[segIndex(w.seg)] !== 1) {
        this.error = 0x16;
        return false;
      }
    }
    if ((hx & ~0xf) + 8 !== hx || (hy & ~0xf) + 8 !== hy) {
      this.error = 3;
      return false;
    }
    return true;
  }

  /** cXPortal::ApplyWallStyle (place) / the style reset of cXPortal::Pickup: the wall under each part. */
  private portalApplyWallStyle(obj: XObject, placing: boolean): void {
    const levels = new Set<number>();
    for (const part of this.chain(obj)) {
      const w = this.portalWall(part);
      if (!w) continue;
      const x = tileOf(part.fx);
      const y = tileOf(part.fy);
      if (this.outOfBounds(x, y)) continue;
      const t = getWall(this.world, x, y, part.level);
      for (let b = 1; b <= 0x20; b <<= 1) if (w.seg & b) t.styles[segIndex(b)] = placing ? w.style : 1;
      setFixedWall(this.world, x, y, part.level, t);
      levels.add(part.level);
    }
    for (const l of levels) this.onWallsChanged?.(l);
  }

  /** Place (cXObject or cXMTObject). */
  place(obj: XObject, p: FPt, level: number, container: XObject | null, slot: number, notify: boolean): void {
    if (!this.isMultiTile(obj)) {
      this.placeSingle(obj, p, level, container, slot, notify);
      return;
    }
    const parts = this.chain(obj);
    const wasOut = this.outOfBounds(tileOf(obj.fx), tileOf(obj.fy));
    const [ox, oy, ol] = Placement.offsets(obj);
    const hx = p.fx - ox * 16;
    const hy = p.fy - oy * 16;
    for (const part of parts) {
      if (this.outOfBounds(tileOf(p.fx), tileOf(p.fy))) {
        this.pickupSingle(part, notify);
      } else {
        const [px, py, pl] = Placement.offsets(part);
        this.placeSingle(part, { fx: hx + px * 16, fy: hy + py * 16 }, level - ol + pl, container, slot, notify);
      }
    }
    for (const part of parts) this.hooks.runCheckTree?.(part, FN.place, 0);
    if (obj.kind === "portal" && this.isInWorld(parts[0]!)) this.portalApplyWallStyle(obj, true);
    if (wasOut && notify) this.hooks.onEnterWorld?.(obj);
  }

  /** Pickup (cXObject or cXMTObject). */
  pickup(obj: XObject, notify: boolean): void {
    if (!this.isMultiTile(obj)) {
      this.pickupSingle(obj, notify);
      return;
    }
    const parts = this.chain(obj);
    if (obj.kind === "portal" && this.isInWorld(parts[0]!)) this.portalApplyWallStyle(obj, false);
    for (const part of parts) this.hooks.runCheckTree?.(part, FN.pickup, 0);
    for (const part of parts) this.pickupSingle(part, false);
    if (notify) this.hooks.onExitWorld?.(obj);
  }

  /** Turn (cXObject::Turn, or cXMTObject::Turn: every part, put back where it was if it still fits). */
  turnObject(obj: XObject, n: number): void {
    if (!this.isMultiTile(obj)) {
      this.turn(obj, n);
      return;
    }
    const at = { fx: obj.fx, fy: obj.fy };
    const level = obj.level;
    this.pickup(obj, true);
    const step = (Placement.od(obj, ODX.rotationNotches) * n) & 7;
    if (step === 0) return;
    const parts = this.chain(obj);
    for (const p of parts) {
      Placement.setOd(p, OD.direction, (p.dir + step) & 7);
      p.isStatic = false;
      p.staticWhenIdle = false;
    }
    this.assignOffsets(obj);
    if (!this.canPlace(obj, at, level, null, 0) && !this.outOfBounds(tileOf(at.fx), tileOf(at.fy))) {
      for (const p of parts) Placement.setOd(p, OD.direction, (p.dir - step) & 7);
      this.assignOffsets(obj);
    }
    if (this.canPlace(obj, at, level, null, 0)) this.place(obj, at, level, null, 0, true);
  }

  /** UserCanPlace (cXObject, or cXMTObject: every part at its offset). */
  userCanPlace(obj: XObject, p: FPt, level: number, container: XObject | null, slot: number): boolean {
    if (!this.isMultiTile(obj)) return this.userCanPlaceSingle(obj, p, level, container, slot);
    const [ox, oy, ol] = Placement.offsets(obj);
    const hx = p.fx - ox * 16;
    const hy = p.fy - oy * 16;
    for (const part of this.chain(obj)) {
      const [px, py, pl] = Placement.offsets(part);
      if (!this.userCanPlaceSingle(part, { fx: hx + px * 16, fy: hy + py * 16 }, level - ol + pl, null, 0)) return false;
    }
    return true;
  }

  /** UserPlace: Place, then the user placement trees. */
  userPlace(obj: XObject, p: FPt, level: number, container: XObject | null, slot: number): void {
    this.place(obj, p, level, container, slot, true);
    for (const part of this.chain(obj)) {
      this.hooks.runCheckTree?.(part, FN.userPlace, 0);
      for (const s of part.objectSlots.slice(1)) {
        const c = this.get(s.containedId);
        if (c) this.hooks.runCheckTree?.(c, FN.userPlace, 0);
      }
    }
  }

  /** UserPickup: the user pickup trees, then Pickup. */
  userPickup(obj: XObject): void {
    for (const part of this.chain(obj)) {
      this.hooks.runCheckTree?.(part, FN.userPickup, 0);
      for (const s of part.objectSlots.slice(1)) {
        const c = this.get(s.containedId);
        if (c) this.hooks.runCheckTree?.(c, FN.userPickup, 0);
      }
    }
    this.pickup(obj, true);
  }

  /** cXObject::UserCanPickup (cXMTObject: every part). */
  userCanPickup(obj: XObject): boolean {
    for (const part of this.chain(obj)) if (!this.userCanPickupSingle(part, 0)) return false;
    return true;
  }

  private userCanPickupSingle(obj: XObject, depth: number): boolean {
    this.error = 0;
    this.obstacle = null;
    if (this.anywhere) return true;
    if (!(Placement.uod(obj, OD.movementFlags) & MV_PLAYERS_CAN_MOVE)) {
      this.error = 0x25;
      return false;
    }
    if (Placement.od(obj, ODX.useCount) > 0 || Placement.uod(obj, OD.flags) & FL_IN_USE) {
      this.error = 0x26;
      return false;
    }
    for (const s of obj.objectSlots.slice(1)) {
      const c = this.get(s.containedId);
      if (c && depth < 64 && !this.userCanPickupSingle(c, depth + 1)) return false;
    }
    const x = obj.tileX;
    const y = obj.tileY;
    if (!this.outOfGrid(x, y) && this.tileFlags(x, y, 1) & 0x20) {
      this.error = 0x27;
      return false;
    }
    return true;
  }

  /** cXObject::UserCanDelete (cXMTObject: every part). */
  userCanDelete(obj: XObject): boolean {
    if (this.anywhere) return true;
    for (const part of this.chain(obj)) {
      if (!this.userCanPickupSingle(part, 0)) return false;
      if (!(Placement.uod(part, OD.movementFlags) & MV_PLAYERS_CAN_DELETE)) return false;
      if (part.objectSlots.slice(1).some((s) => this.get(s.containedId) !== null)) return false;
    }
    return true;
  }

  /** cXObject::GetCurrentValue: the lead's value, halved when any part is broken (repair state). */
  getCurrentValue(obj: XObject): number {
    const parts = this.chain(obj);
    const broken = parts.some((p) => Placement.od(p, ODX.repairState) !== 0);
    const v = Placement.od(parts[0]!, OD.currentValue);
    return broken ? Math.trunc(v / 2) : v;
  }

  /** cXObject::ShouldAutoRotate: wall objects turn to face the wall they are dropped against. */
  shouldAutoRotate(obj: XObject): boolean {
    if (Placement.uod(obj, OD.wallPlacementFlags) & 0xf) return true;
    if (!this.isMultiTile(obj)) return false;
    const parts = this.chain(obj);
    for (const a of parts) {
      if (Placement.uod(a, OD.wallPlacementFlags) & 0xf) return true;
      for (const b of parts) if (Placement.uod(a, OD.placementFlags) & PF.allowOnPool && !(Placement.uod(b, OD.placementFlags) & PF.allowOnPool)) return true;
    }
    return false;
  }

  /** cXObject::GetFrontFaceDirection: the master definition's front direction (OBJD +0x7a). */
  static getFrontFaceDirection(obj: XObject): number {
    return obj.selector.getMasterSelector().objd.i16(0x7a);
  }
}

/** The person-intersection test of TestIntersection: zero-extent objects use "disallow", others "allow". */
function personMayCollide(flags: number): boolean {
  const allow = flags & FL_ZERO_EXTENT ? ((flags >> 1) & 1) ^ 1 : (flags >> 4) & 1;
  return allow === 0;
}

/** TileWalls::Rotate (segments and their styles) by `r` quarter turns. */
function rotateWalls(w: TileWalls, r: number): { segs: number; styles: Uint16Array } {
  const styles = new Uint16Array(6);
  let segs = 0;
  for (let b = 1; b <= 0x20; b <<= 1) {
    if (!(w.segs & b)) continue;
    const nb = SEG_ROTATION[r]![b]!;
    segs |= nb;
    styles[segIndex(nb)] = w.styles[segIndex(b)]!;
  }
  return { segs, styles };
}

/**
 * cXObject::DayPassed's depreciation (OBJD +0x24 price, +0x46 initial and
 * +0x48 daily depreciation, +0x4a self depreciating, +0x4c limit), for the
 * simulation to call once a day on each lead object.
 */
export function dayPassedDepreciation(obj: XObject): void {
  const objd = obj.selector.getMasterSelector().objd;
  if (objd.i16(0x4a) !== 0) return;
  const v = obj.objectData[OD.currentValue]!;
  const initial = objd.i16(0x46);
  const step = v !== objd.i16(0x24) || initial === 0 ? objd.i16(0x48) : initial;
  obj.objectData[OD.currentValue] = Math.max(v - step, objd.i16(0x4c));
}
