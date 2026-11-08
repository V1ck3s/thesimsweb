/**
 * cXPerson: the simulation half of a person (Person.cpp). A SimObject with
 * person data (+0x58c, 0x100 shorts), motives (+0x78c, 16 floats + the 16
 * previous values), motive increments (+0xa80), the interaction queue
 * (+0xa00..+0xa04 head/tail over 8 slots at +0x820, +0xa08 the current
 * action, +0xa44 the last one) and its animator (+0xa8c, SAnimator).
 *
 * cXPerson::TryElement handles primitives 3..47 through lbl_105BBB5C and
 * passes the rest to cXObject::TryElement:
 *   3 Find Best Interaction, 6 Change Suit, 17 Idle For Input,
 *   22 Look Towards, 27 Go To Relative, 29 Set Motive Change,
 *   30 Gosub Found Action, 37 Test Sim Interacting With,
 *   44 Animate (SAnimator::TryAnimate), 45 Go To Routing Slot, 47 Reach.
 */

import type { Neighbor } from "../data/neighborhood.js";
import type { XObject } from "../world/objects.js";
import type { BehaviorTree } from "./behavior.js";
import { simLog } from "./simlog.js";
import { applyMotiveIncs, calcHappy, MOTIVE, motivesSim, type MotiveCurve, type MotiveInc } from "./motives.js";
import type { SimModule } from "./simmodule.js";
import { PRIM_FALSE, PRIM_TRUE, PRIM_WAIT, simThrow, SimError } from "./treesim.js";
import type { ParamSource, StackElem } from "./treestack.js";
import { SimObject, XERR } from "./xobject.js";
import { loadStringSet } from "./behavior.js";
import { findToken } from "./inventory.js";
import { PersonAnimator, requestSkill } from "./personanim.js";
import { handleAnimSound } from "./animsound.js";
import type { Skill } from "../sims/skill.js";
import { PRIM_CONTINUE } from "./treesim.js";
import { allowDirection, DIR_VEC, dirOf, FACE_ANY, FACE_AWAY, FACE_TOWARDS, newRoutingSlot, ROUTE, RSF, setTileDistances, updateRoomIDs, XRoute, type PathPt, type RoutingSlot } from "./routing.js";
import { beginningPortalTree, failedPortalTree, findBestPortal, initPortalRoute, isPortalInUse } from "./portals.js";
import { EP } from "./objfntable.js";
import { RotatableWorld } from "../world/world.js";
import type { TreeTableEntry } from "./treetable.js";
import { fc, type FloatConstants } from "./floatconstants.js";
import { personLooks } from "../sims/personlook.js";
import { getTrackedObject } from "../world/tracking.js";

/** Object data 29 (+0x84): the object's room; 59 (+0xc0): its category. */
const OD_ROOM = 29;
const OD_CATEGORY = 59;

/** Person data indexes used by the person code (Behavior.iff STR# 200). */
export const PDX = {
  sitting: 0x00,
  activePersonality: 0x03,
  outgoingPersonality: 0x06,
  motivesStatic: 0x1d,
  neighborId: 0x1f,
  personType: 0x20,
  routeEntryFlags: 0x25,
  routingComplete: 0x27,
  personAge: 0x3a,
  familyNumber: 0x3d,
  routeResult: 0x3e,
  gender: 0x41,
  nonInterruptible: 0x47,
} as const;

/**
 * Neighbor::GetPersistentDataFields: the person data copied from the
 * neighbor record by Neighborhood::LoadPersistentData, with the neighbor
 * stream version each needs. The last ones depend on the version too.
 */
function persistentFields(version: number): Array<[number, number]> {
  const f: Array<[number, number]> = [];
  for (const i of [2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 0x10, 0x14, 0xf, 0x1a, 0x11, 0x12, 0x2e, 0x2f, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0xd, 0xe, 0x3a, 0x3c, 0x3d]) {
    f.push([i, 1]);
  }
  f.push([0x38, 2], [0x39, 2], [0x3f, 2], [0x41, 3], [0x43, 4], [0x44, 4], [0x45, 5], [0x4a, 6], [0x36, 7], [0x37, 7], [0x4b, 7], [0x4c, 7]);
  if (version > 7) f.push([0x50, 1], [0x51, 1]);
  if (version > 8) f.push([0x52, 1]);
  if (version > 9) f.push([0x53, 1], [0x54, 1], [0x55, 1], [0x56, 1]);
  return f;
}

/** One queued interaction (Interaction, 0x3c bytes). */
export interface Interaction {
  /** +8 the object offering it. */
  target: number;
  /** +0x14 the TTAB entry's action tree (+0x18 its check tree). */
  actionTree: number;
  checkTree: number;
  /** +0x1c the TTAB entry index, +0x20 the stack object / icon owner. */
  ttabIndex: number;
  icon: number;
  /** Parameters passed to the action tree (Push Interaction's temps). */
  args: Int16Array;
  /** +0x38 flags: 2 user-pushed, 8 continuation... */
  flags: number;
  /** +0x34 priority. */
  priority: number;
  name: string;
}

/**
 * An entry of the user pie menu (cObjPickerTool's Interaction list): a tree
 * table entry, or one made by its check tree through
 * ObjTestSim::MakeNewMenuItem with its own name and stack vars
 * (Interaction +0x14..+0x1a, the action tree's parameters).
 */
export interface MenuItem {
  entry: TreeTableEntry;
  name: string;
  args: Int16Array | null;
  /**
   * A join (Interaction(person, other), type 1): the clicked person `actor`
   * is asked to join the menu's person, on `target` (the object of that
   * person's current action) with interaction flags `flags`.
   */
  join?: { actor: PersonSim; target: SimObject; flags: number };
}

/** lbl_1059A1E0: TTAB motive personality index -> (person data, inverted). */
const PERSONALITY_ADS: ReadonlyArray<readonly [number, number] | null> = [
  null,
  [2, 0], [2, 1], [3, 0], [3, 1], [4, 0], [4, 1], [5, 0], [5, 1], [6, 0], [6, 1], [7, 0], [7, 1],
  [9, 0], [10, 0], [11, 0], [12, 0], [0x37, 0], [0x37, 0], [0xf, 0], [0x37, 0], [0x11, 0], [0x12, 0],
];

/** AutonomyConstantsClient: the FCNS 2 values (defaults in parentheses as in the client). */
export interface AutonomyConstants {
  minFamily: number;
  minVisitors: number;
  minSitting: number;
  /** Attenuations low / moderate / high, family then visitors. */
  low: number;
  moderate: number;
  high: number;
  visitorLow: number;
  visitorModerate: number;
  visitorHigh: number;
  randomCount: number;
}

export function autonomyConstants(c: FloatConstants): AutonomyConstants {
  return {
    minFamily: fc(c, "min autonomy score for family", 1e-7),
    minVisitors: fc(c, "min autonomy score for visitors", 1e-7),
    minSitting: fc(c, "min autonomy score for sitting", 1e-6),
    low: fc(c, "low attenuation", 0.1),
    moderate: fc(c, "moderate attenuation", 0.3),
    high: fc(c, "high attenuation", 0.6),
    visitorLow: fc(c, "visitor low attenuation", 0.01),
    visitorModerate: fc(c, "visitor moderate attenuation", 0.02),
    visitorHigh: fc(c, "visitor high attenuation", 0.03),
    randomCount: fc(c, "random selection count", 4),
  };
}

/** TreeTableEntry::GetAttenuationValue: 0 custom, 1 none, 2 low, 3 moderate, 4 high. */
function attenuation(e: TreeTableEntry, k: AutonomyConstants, visitor: boolean): number {
  switch (e.attenuationCode) {
    case 0:
      return e.attenuationValue;
    case 1:
      return 0;
    case 2:
      return visitor ? k.visitorLow : k.low;
    case 4:
      return visitor ? k.visitorHigh : k.high;
    default:
      return visitor ? k.visitorModerate : k.moderate;
  }
}

/** MotiveEffects' motives (lbl_105FE558), in curve order. */
export const SCORE_CURVE_MOTIVES = [5, 6, 7, 8, 9, 3, 13, 14, 15] as const;

/** SkillLookup's string tables (Global.iff STR# 150..160), loaded once. */
const stdTables = new Map<number, string[] | null>();

/** The object files whose animation tables were asked for (prefetchSkills). */
const prefetched = new WeakSet<object>();

/**
 * Not in the original (its VBAnimMgr loads a skill synchronously when an
 * Animate primitive starts it): when a person starts running an object's
 * tree, the skills of the object's animation tables (STR# 0x81..0x84) start
 * loading, so they are usually there by the time the person, done routing,
 * animates with the object.
 */
function prefetchSkills(o: SimObject): void {
  const sel = o.obj.selector;
  if (o.isPerson || prefetched.has(sel)) return;
  prefetched.add(sel);
  for (const id of [0x81, 0x82, 0x83, 0x84]) for (const n of loadStringSet(sel.res, id) ?? []) if (n) requestSkill(n);
}

/** lbl_105BA328: 1 / (2 sqrt 6) (doubles of lbl_105BBB74), computed once by TryGetReachInfo. */
const REACH_HEIGHT_SCALE = Math.fround(1 / (2 * Math.sqrt(6)));

/** Routing slots replaced at run time (MoveOutOfWay writes the helper object's slot 0). */
const slotOverrides = new WeakMap<SimObject, RoutingSlot[]>();

export class PersonSim extends SimObject {
  /** cXPerson +0xa80 */
  readonly motiveIncs: MotiveInc[] = [];
  /** cXPerson +0x810: the tick Motives::Sim last ran. */
  lastMotiveTick = 0;
  /** +0x820 queue (head first), +0xa08 current action, +0xa44 last action. */
  readonly queue: Interaction[] = [];
  currentAction: Interaction | null = null;
  lastAction: Interaction | null = null;
  /** +0xa7c bit 0x20 (SetCurrentAction): the tree of the last action returned true (SimLog's result). */
  lastActionResult = false;
  /** cXPerson +0xa8c */
  readonly animator: PersonAnimator;
  /** Continuous facing for the renderer (45 degree units), null: object data direction. */
  private turnDir: number | null = null;
  /** Continuous facing for the renderer (45 degree units): the walk engine's direction while following. */
  get renderDir(): number | null {
    return this.animator.followDir ?? this.turnDir;
  }
  set renderDir(d: number | null) {
    this.turnDir = d;
  }
  /** cXPerson +0x814 scored interactions of the last Find Best Interaction (trace). */
  lastScores: Array<{ object: number; name: string; score: number }> = [];
  /**
   * cXPerson +0xab0: ObjectRecords, the objects whose trees run on this
   * person's stack (pushed by GosubObjectTree with the stack size after the
   * push, dropped by StackJustPopped).
   */
  readonly objectRecords: Array<{ id: number; depth: number; action: boolean }> = [];
  /** Primitive trace (debug): "tree:node op -> result". */
  readonly trace: string[] = [];
  traceOn = false;
  /** Autonomy decisions (debug): tick, candidates, pick. */
  readonly autonomyLog: string[] = [];
  private watch = 0;
  private watchTree = -1;
  private watchFull = 0;

  constructor(obj: XObject, module: SimModule) {
    super(obj, module);
    const rec = obj.personRecord;
    const pd = new Int16Array(0x100);
    const m = new Float32Array(32);
    if (rec) {
      pd.set(rec.personData);
      m.set(rec.motives, 0);
      m.set(rec.motives2, 16);
    } else {
      // Motives::Init: all 0 but energy (and its previous value) 70 and motive 7 -40.
      m[5] = 70;
      m[0x15] = 70;
      m[7] = -40;
    }
    this.person = { personData: pd, motives: m };
    // cXPerson::ReconStream: the saved ObjectRecords (object id, stack size, action flag).
    for (const r of rec?.tail?.objectRecords ?? []) this.objectRecords.push({ id: r.object, depth: r.value, action: r.flag });
    for (const x of rec?.tail?.motiveIncs ?? []) this.motiveIncs.push({ ...x });
    this.animator = new PersonAnimator({
      setPersonData: (i, v) => {
        this.pd[i] = v;
      },
      record: (kind, value) => this.module.record(this, kind, value),
      stdSkillName: (idx) => this.stdSkillName(idx),
      bodyStrings: () => this.module.bodyStringEdits.get(this.obj.selector.guid | 0) ?? loadStringSet(this.obj.selector.res, this.obj.selector.objd.i16(0x26)) ?? [],
      middleStrings: (id) => {
        const f = this.obj.selector.semiGlobalName ? this.module.res.semiGlobal(this.obj.selector.semiGlobalName) : null;
        return f ? loadStringSet(f, id) : null;
      },
      objdFlags: () => this.obj.selector.objd.i16(0xcc),
      personData: (i) => this.pd[i]!,
      objectData: (i) => this.obj.objectData[i]!,
      setDirection: (d) => {
        this.obj.objectData[1] = d & 7;
      },
      canPlace: (fx, fy) => {
        const h = this.module.worldHooks;
        if (!h || h.canPlace(this.obj, { fx, fy }, this.obj.level, null, -1)) return true;
        this.lastBlock = h.lastError();
        return false;
      },
      setLocation: (fx, fy) => this.setLocation(fx, fy),
      holding: () => (this.obj.objectSlots[1]?.containedId ?? 0) !== 0,
      animSound: (key, value, forward) => handleAnimSound(this, key, value, forward),
    });
    // What the lot renderer dresses (SAnimator::UpdateOutfitAndHands from SAnimator::Render).
    const personData = (): Int16Array => this.pd;
    const animator = this.animator;
    personLooks.set(obj, {
      get pd() { return personData(); },
      get suitsVersion() { return animator.suitsVersion; },
      objdFlags: obj.selector.objd.i16(0xcc),
      accessories: this.animator.accessories,
      job: (child) => this.jobSuit(child),
    });
  }

  /** cXPerson::GetJobSuitTex's cJob (GetCareerByID(person data 56), level 57, 0 for a child): suits, texture, accessory. */
  private jobSuit(child: boolean): { suit: string; femaleSuit: string; texture: string; accessory: string } | null {
    const career = this.module.careers.find((c) => c.id === this.pd[56]);
    const job = career?.jobs[child ? 0 : this.pd[57]!];
    if (!job) return null;
    const s = job.strings;
    return { suit: s[1] ?? "", femaleSuit: s[2] ?? "", texture: s[3] ?? "", accessory: s[4] ?? "" };
  }

  get pd(): Int16Array {
    return this.person!.personData;
  }
  get motives(): Float32Array {
    return this.person!.motives;
  }

  /** Neighborhood::LoadPersistentData: the neighbor's id and its persistent fields. */
  loadPersistentData(nb: Neighbor): void {
    const pd = this.pd;
    pd[PDX.neighborId] = nb.id;
    const src = nb.personData;
    const version = nb.version ?? 0;
    if (src && version !== 0) {
      for (const [i, min] of persistentFields(version)) if (min <= version && i < src.length) pd[i] = src[i]!;
    }
    if (src && PDX.familyNumber < src.length) pd[PDX.familyNumber] = src[PDX.familyNumber]!;
  }

  /** cXPerson::IsChild (person age 1..17). */
  get isChild(): boolean {
    const age = this.pd[PDX.personAge]!;
    return age !== 0 && age < 0x12;
  }

  /**
   * cXPerson::Simulate: cXObject::Simulate, then (when the tick ran) the
   * motive decay every 60 ticks, the animator, the current room
   * (UpdateCurrentRoom) and the room motive, the motive increments every
   * tick, and every 10 ticks a layout tick for the house. Head text and
   * the head fee: not ported.
   */
  override simulate(): boolean {
    const a = this.animator;
    const drawn = { ...(a.followPos ?? { fx: this.obj.fx, fy: this.obj.fy }), dir: this.renderDir ?? this.obj.dir };
    const r = super.simulate();
    if (r) {
      a.settleLoadHold(drawn);
      const tick = this.module.sim.tickCount;
      const m = this.motives;
      if (this.lastMotiveTick + 0x3c <= tick) {
        this.lastMotiveTick = tick;
        if (this.pd[PDX.motivesStatic] === 0 && this.obj.hidden === 0) {
          motivesSim(m, this.pd, this.module.sim.globals[0]!);
          calcHappy(m, this.isChild ? this.module.happyCurvesChild : this.module.happyCurves);
        }
      }
      // SAnimator::Tick (vtable +0x58) on every tick the person ran.
      this.animator.tick();
      this.updateCurrentRoom();
      this.updateRoomMotive();
      // Person data 27, "tick counter" (read by the "divide tick counts" tree).
      this.pd[27] = this.pd[27]! + 1;
      applyMotiveIncs(m, this.motiveIncs);
      // House::AddLayoutTick every 10 ticks for an awake resident in the world (motive 11 >= 0),
      // counted as routing while the person has a route.
      if (tick % 10 === 0 && this.pd[PDX.personType] === 0 && this.obj.hidden === 0 && m[MOTIVE.sleepState]! >= 0) {
        this.module.sim.addLayoutTick(this.routes.length > 0);
      }
      // SimLog::SimTickCompleted ("sim_log begin").
      simLog.simTickCompleted(this);
    }
    return r;
  }

  /** cXPerson +0xaac: the room the person is in (0xfffb, none, until UpdateCurrentRoom). */
  currentRoom = 0xfffb;

  /**
   * cXPerson::UpdateCurrentRoom: when the room (object data 29) changed,
   * the old room's overhead lights go off once nobody is left in it and the
   * new room's go on (person data 0x41 <= 1: not for pets); the selected or
   * tracked person dispatches 0xf7 (the dynamic cutaway follows).
   */
  updateCurrentRoom(): void {
    const room = this.obj.objectData[OD_ROOM]! & 0xffff;
    if (room === this.currentRoom) return;
    const old = this.currentRoom;
    this.currentRoom = room;
    const h = this.module.roomHooks;
    if (this.pd[0x41]! <= 1) {
      if (old < 0xfffb && this.getPeopleCount(old) === 0) h?.setOverheadLights?.(old, false);
      if (room < 0xfffb) h?.setOverheadLights?.(room, true);
    }
    const sel = this.module.sim.state?.personGetSelected();
    const selected = !!sel && sel.guid !== undefined && (sel.guid | 0) === (this.obj.selector.guid | 0);
    if (selected || getTrackedObject() === this.obj) h?.currentRoomChanged?.();
  }

  /**
   * Room::GetPeopleCount: the people of the lot whose current room is `id`
   * (person data 0x44 and 0x54 bit 0 leave one out).
   */
  private getPeopleCount(id: number): number {
    let n = 0;
    for (const p of this.module.persons) {
      if ((p.pd[0x54]! & 1) === 1 || (p.pd[0x44]! & 1) === 1) continue;
      if (p.currentRoom === id) n++;
    }
    return n;
  }

  /**
   * cXPerson::Simulate's room motive (13): the score of the current room
   * (Room +0x68; RoomManager +0x48 outside; 0 without the room), not below
   * 0 outside (room 0) on a lot that is not residential (zoning type 1).
   */
  private updateRoomMotive(): void {
    const id = this.currentRoom;
    const hooks = this.module.roomHooks;
    if (id === 0xfffb || !hooks?.roomScore) return;
    let v = hooks.roomScore(id) ?? 0;
    if (id === 0 && this.module.getZoningType(this.module.sim.globals[10]!) !== 1 && v < 0) v = 0;
    this.motives[MOTIVE.room] = v;
  }

  /**
   * cXPerson::Reset: person data cleared (person type 32, greet status 34
   * and 35 kept), the animator stopped, persistent data from the neighbor,
   * cXObject::Reset (Main restarts, Init runs), persistent data again
   * (unless data 25 holds the 0x7ae marker, then cleared), visitors on a
   * non-residential lot become type 1, and the motive curve sets.
   */
  override reset(tick: boolean): void {
    const pd = this.pd;
    const keep = [pd[32]!, pd[34]!, pd[35]!];
    pd.fill(0);
    pd[32] = keep[0]!;
    pd[34] = keep[1]!;
    pd[35] = keep[2]!;
    // SAnimator::Reset (vtable +0x14)
    this.animator.reset();
    this.queue.length = 0;
    this.currentAction = null;
    this.objectRecords.length = 0;
    this.routes.length = 0;
    this.module.initPerson(this);
    super.reset(tick);
    if (pd[25] === 0x7ae) pd[25] = 0;
    else this.module.initPerson(this);
    if (this.module.getZoningType(this.module.sim.globals[10]!) !== 1 && pd[32] !== 2) pd[32] = 1;
  }

  /**
   * cXPerson::GosubObjectTree: cXObject's, then an ObjectRecord for `other`
   * (its object data 62, the count of people running its trees, goes up).
   */
  override gosubObjectTree(other: SimObject, params: ParamSource | null, treeId: number, action = false): boolean {
    if (!super.gosubObjectTree(other, params, treeId)) return false;
    this.objectRecords.push({ id: other.id, depth: this.getStackSize(), action });
    other.obj.objectData[62] = other.obj.objectData[62]! + 1;
    prefetchSkills(other);
    return true;
  }

  /**
   * cXPerson::StackJustPopped: the last ObjectRecord goes when the stack
   * shrank below its frame (its object's data 62 goes down); with no record
   * left the current action is cleared (SetCurrentAction of an empty
   * Interaction).
   */
  override stackJustPopped(): void {
    const n = this.getStackSize();
    const top = this.objectRecords[this.objectRecords.length - 1];
    if (!top) return;
    if (n === top.depth - 1 || n < top.depth) {
      const o = this.module.getObject(top.id);
      if (o) o.obj.objectData[62] = o.obj.objectData[62]! - 1;
      this.objectRecords.pop();
    }
    if (this.objectRecords.length === 0) this.setCurrentAction(null);
  }

  /** cXPerson +0x114 bit 0x800: Cleanup is running (it does not reenter). */
  private inCleanup = false;

  /** cXPerson::Cleanup(0) (vtable +0x40 with no object): see cleanupFor. */
  override cleanup(): void {
    this.cleanupFor(null);
  }

  /**
   * cXPerson::Cleanup(obj), from ObjectModule::CleanupPeople (an object's
   * error, PostLoad) or with null for the person's own cleanup.
   * When `obj` is null, is one of the ObjectRecords or the action object
   * (+0xa14), the person lets go of everything: each record's frames are
   * popped (StackJustPopped) and its object is cleaned up too
   * (CleanupPeople + Cleanup(0)), the animations stop, the routes go, the
   * sprite slots go off, a person out of the lot is put back near its
   * center (FindGoodLocation), Main restarts, the Cleanup entry point runs,
   * person data 0, 40 and 59 and object data 9 (route preference) and 34
   * (hidden) are cleared and the current action is emptied.
   * Then the queue: all of it (null), or the interactions with `obj`, go
   * (each one's object runs its entry point 4, "queue skipped", with the
   * person as parameter); the last and current actions with `obj` are
   * forgotten; when `obj` is a person, the routes asking it to move forget
   * it (marked as asked).
   * The record objects are not cleaned up when the person (own cleanup) or
   * `obj` has +0x114 bit 0x1000 (AddToKillQueue(id, false), e.g. a visitor
   * removed by the pedestrian portal with operand flag 2: the Studio Town
   * car whose interaction the visitor was running keeps going instead of
   * restarting Main and spawning three more visitors).
   * The container part of PlacementSpec (the person in a slot) is not kept.
   */
  override cleanupFor(obj: SimObject | null): void {
    if (this.inCleanup) return;
    this.inCleanup = true;
    try {
      const m = this.module;
      // The record objects are cleaned up unless the object cleaned up for (or this person, for
      // its own cleanup) was queued for death with AddToKillQueue(id, false): bit 0x1000.
      const cleanRecords = !(obj ?? this).keepRecordObjects;
      const all = obj === null || this.objectRecords.some((r) => r.id === obj.id) || this.currentAction?.icon === obj.id;
      if (all) {
        while (this.objectRecords.length) {
          const r = this.objectRecords[this.objectRecords.length - 1]!;
          while (this.getStackSize() > r.depth - 1) {
            this.stack.pop();
            this.stackJustPopped();
          }
          // StackJustPopped may keep the record when the stack was already shorter
          if (this.objectRecords[this.objectRecords.length - 1] === r) {
            const o = m.getObject(r.id);
            if (o) o.obj.objectData[62] = o.obj.objectData[62]! - 1;
            this.objectRecords.pop();
          }
          const o = m.getObject(r.id);
          if (cleanRecords && o && o !== this) {
            m.cleanupPeople(o);
            o.cleanup();
          }
        }
        // SAnimator::SetPixelated(0) and the animator's vtable +0x14 / +0x1c (ResetSuits)
        this.animator.reset();
        this.animator.resetSuits();
        this.routes.length = 0;
        for (const sl of this.obj.spriteSlots) sl.activeTicks = 0;
        this.putBackInWorld();
        this.resetTree(this.behavior, this.fnTable.getTreeID(EP.main));
        const tree = this.fnTable.getTreeID(EP.cleanup);
        if (tree !== 0) this.runCheckTree(this.behavior, 0, tree, null);
        this.pd[0] = 0;
        this.pd[40] = 0;
        this.pd[59] = 0;
        this.obj.objectData[34] = 0;
        this.obj.objectData[9] = 0;
        this.setCurrentAction(null);
      }
      const skipped = (i: Interaction): void => {
        const o = m.getObject(i.target);
        const tree = o ? o.fnTable.getTreeID(EP.queueSkipped) : 0;
        if (o && tree !== 0) o.runCheckTree(o.behavior, this.id, tree, null);
      };
      if (obj === null) {
        for (const i of this.queue.splice(0)) skipped(i);
      } else {
        const keep: Interaction[] = [];
        // Interactions on the object or whose icon (+0xc) it is are dropped.
        for (const i of this.queue.splice(0)) {
          if (i.target === obj.id || i.icon === obj.id) skipped(i);
          else keep.push(i);
        }
        this.queue.push(...keep.slice(0, 8));
        if (this.lastAction?.target === obj.id) this.lastAction = null;
        else if (this.lastAction?.icon === obj.id) this.lastAction.icon = 0;
        if (this.currentAction?.target === obj.id) this.setCurrentAction(null);
        else if (this.currentAction?.icon === obj.id) this.currentAction.icon = 0;
        if (obj.isPerson) {
          for (const r of this.routes) {
            if (r.askedPerson === obj) {
              r.asked = true;
              r.askedPerson = null;
              r.askedInteraction = null;
            }
          }
        }
      }
      m.onQueueChanged?.(this);
    } finally {
      this.inCleanup = false;
    }
  }

  /**
   * The placement part of cXPerson::Cleanup: a person (object flag 0x40
   * clear) not on a tile of the lot is placed at the lot's center tile or
   * the good location nearest it (an empty tile first, then any).
   */
  private putBackInWorld(): void {
    const hooks = this.module.worldHooks;
    const fixed = this.module.sim.world;
    if (!hooks || !fixed || this.obj.objFlags & 0x40) return;
    const x = this.obj.fx >> 4;
    const y = this.obj.fy >> 4;
    if (x >= 1 && y >= 1 && x < fixed.size - 1 && y < fixed.size - 1) return;
    const c = ((fixed.size >> 1) << 4) | 8;
    let pos: { fx: number; fy: number } | null = { fx: c, fy: c };
    const level = this.obj.level || 1;
    if (!hooks.canPlace(this.obj, pos, level, null, 0)) {
      pos =
        hooks.findGoodLocation(this.obj, pos, level, { emptyTile: true, buildable: false, random: null }) ??
        hooks.findGoodLocation(this.obj, pos, level, { emptyTile: false, buildable: false, random: null });
    }
    this.module.record(this, "cleanupPlace", pos ? `${pos.fx},${pos.fy}` : "none");
    if (pos) hooks.place(this.obj, pos, level, null, 0);
    this.module.dirty(this);
  }

  /** cXPerson::TryTestInteractingWith: is the stack object one of the ObjectRecords of me (mode 0, 2) or of the person in (scope, data) (mode 1, error 0x1c)? */
  protected tryTestInteractingWith(elem: StackElem, mode: number, scope: number, data: number): number {
    let who: PersonSim = this;
    if (mode === 1) {
      const o = this.module.getObject(this.interpValue(scope, data, false));
      if (!(o instanceof PersonSim)) simThrow(XERR.notPerson);
      who = o;
    }
    return who.objectRecords.some((r) => r.id === elem.stackObj) ? PRIM_TRUE : PRIM_FALSE;
  }

  protected override moved(): void {
    this.renderDir = null;
  }

  override error(code: number): void {
    if (this.traceOn) {
      const frames: string[] = [];
      for (let i = 0; i < this.getStackSize(); i++) {
        const e = this.stack.getNthFrame(i);
        if (e) frames.push(`${e.behavior?.getTreeName(e.getTreeID()) ?? "?"}(${e.getTreeID()}):${e.node}`);
      }
      this.autonomyLog.push(`! t${this.module.sim.tickCount} error 0x${code.toString(16)} at ${frames.join(" > ")}`);
    }
    super.error(code);
  }

  override tryElement(elem: StackElem, t: BehaviorTree, off: number): number {
    const op = t.primitive(off) & 0x7fff;
    let r: number;
    switch (op) {
      case 3:
      case 6:
      case 17:
      case 22:
      case 27:
      case 29:
      case 30:
      case 37:
      case 44:
      case 45:
      case 47:
        this.primCounts.set(op, (this.primCounts.get(op) ?? 0) + 1);
        r = this.tryPersonElement(op, elem, t, off + 4);
        break;
      default:
        r = super.tryElement(elem, t, off);
    }
    if (this.traceOn) {
      const line = `${elem.behavior?.getTreeName(elem.getTreeID()) ?? ""}(${elem.getTreeID()}):${elem.node} op${op} -> ${r}`;
      this.trace.push(line);
      if (this.trace.length > 400) this.trace.splice(0, 100);
      if (this.watch > 0) {
        this.watch--;
        if (this.watchFull > 0) this.watchFull--;
        const tree = elem.getTreeID();
        if (tree !== this.watchTree || this.watch > 19980 || this.watchFull > 0) this.autonomyLog.push(`  t${this.module.sim.tickCount} ${line}`);
        this.watchTree = tree;
      }
      if (op === 3 || op === 30) {
        this.watch = 40;
        this.autonomyLog.push(`* ${line}`);
      }
    }
    return r;
  }

  protected tryPersonElement(op: number, elem: StackElem, t: BehaviorTree, p: number): number {
    const v = t.view;
    const s16 = (o: number): number => v.getInt16(p + o, true);
    const u8 = (o: number): number => t.bytes[p + o]!;
    switch (op) {
      case 29:
        return this.trySetMotiveDelta(u8(0), u8(1), u8(2), u8(3), s16(4), s16(6));
      case 17:
        return this.tryIdleForInput(elem, s16(0), s16(2));
      case 3:
        return this.tryFindBestAction(elem);
      case 6:
        return this.tryChangeSuit(elem, u8(0), u8(1), s16(2));
      case 22:
        return this.tryLookTowards(elem, s16(0));
      case 27:
        return this.tryGotoRelative(elem, (u8(2) << 24) >> 24, (u8(3) << 24) >> 24, u8(6));
      case 30:
        return this.tryGosubFoundAction(elem);
      case 37:
        return this.tryTestInteractingWith(elem, u8(0), (u8(1) << 24) >> 24, s16(2));
      case 45:
        return this.tryGotoRoutingSlot(elem, s16(0), s16(2), u8(4));
      case 44:
        return this.tryAnimate(elem, s16(0), u8(2), (u8(4) << 24) >> 24, u8(5), (u8(6) << 24) >> 24);
      case 47:
        return this.tryReach(elem, s16(0), s16(2), s16(4));
      default:
        return this.module.unportedPrim(op, `person primitive ${op}`, PRIM_FALSE);
    }
  }

  /**
   * cXPerson::TrySetMotiveDelta: flags bit 1 clears the list; otherwise adds
   * (motive, delta = value / 60 / 30 per tick, stop value). Motives 5..9, 14,
   * 15 only (error 0x1a).
   */
  protected trySetMotiveDelta(deltaScope: number, limitScope: number, motive: number, flags: number, deltaData: number, limitData: number): number {
    if (flags & 1) {
      this.motiveIncs.length = 0;
      return PRIM_TRUE;
    }
    if (!((motive >= 5 && motive <= 9) || motive === 14 || motive === 15)) simThrow(XERR.motiveRange);
    const d = this.interpValue((deltaScope << 24) >> 24, deltaData, false);
    const l = this.interpValue((limitScope << 24) >> 24, limitData, false);
    this.motiveIncs.push({ motive, delta: d / 60 / 30, limit: l });
    return PRIM_TRUE;
  }

  /**
   * SAnimator::ResolveSkillForPrimitive: the skill name. Source 0: the anim
   * table of the object whose tree runs (or, with flag 4, of the stack
   * object), GetObjectSkill(object, person, index, other): STR# 0x81 adult,
   * 0x82 child, 0x83 adult to child, 0x84 child to adult; the other side's
   * age is the person's own, or (main practice only: neither flag 1 nor
   * 0x10) that of the current interaction's icon person (+0xa14) when the
   * interaction is on that object; 1: Global.iff STR# 0x80; 2: the person
   * stock table (Global.iff 0x82); 3: misc (0x9c adult / 0x9d child).
   * Error 0x17 when the object is missing.
   */
  protected resolveSkillName(elem: StackElem, index: number, source: number, flags: number): string | null {
    this.animator.checkResetSuits();
    const m = this.module;
    const g = m.res.glob;
    let table: string[] | null = null;
    if (source === 0) {
      let sel = null;
      if (flags & 4) sel = m.getObject(elem.stackObj)?.obj.selector ?? null;
      else sel = m.selectorOfBehavior(elem.behavior) ?? this.obj.selector;
      if (!sel) simThrow(0x17);
      const child = this.isChild;
      let otherChild = child;
      const cur = this.currentAction;
      if (!(flags & 0x11) && cur && m.getObject(cur.target)?.obj.selector === sel) {
        const other = m.getObject(cur.icon);
        if (other instanceof PersonSim) otherChild = other.isChild;
      }
      table = loadStringSet(sel.res, child ? (otherChild ? 0x82 : 0x84) : otherChild ? 0x83 : 0x81);
    } else if (source === 1) {
      table = g ? loadStringSet(g, 0x80) : null;
    } else if (source === 2) {
      table = g ? loadStringSet(g, 0x82) : null;
    } else if (source === 3) {
      table = g ? loadStringSet(g, this.isChild ? 0x9d : 0x9c) : null;
    }
    const name = table?.[index];
    return name ? name.toLowerCase() : null;
  }

  /**
   * SAnimator::TryAnimate. Operands: animation index (or, flag 4, the
   * parameter holding it), local for events, source, flags (1 carry, 2
   * backwards, 4 index from parameter, 8 interruptible, 0x10 background,
   * 0x20 events into the local instead of parameter 0), expected event
   * count. Index 0 stops the slot. The main animation: waits while it
   * plays; each "xevt" event in order returns false with the event number
   * stored; the end returns true (after reporting events that did not fire).
   */
  protected tryAnimate(elem: StackElem, index: number, local: number, source: number, flags: number, expected: number): number {
    const a = this.animator;
    if (a.state !== 0 && !(a.state > 0 && a.state < 4)) return PRIM_WAIT;
    let anim = index;
    if (flags & 4) {
      if (anim < 0 || anim >= elem.numParams) simThrow(XERR.paramRange);
      anim = elem.getParam(anim);
    }
    // Flag 1 alone: the +0x14 practice (priority -10); 0x10 alone: +0x134 (priority 10); both: main, stopping +0x134.
    const slot = flags & 1 ? (flags & 0x10 ? "carry3" : "background") : flags & 0x10 ? "carry" : "main";
    const backwards = (flags & 2) !== 0;
    const store = (v: number): void => {
      if (flags & 0x20) {
        if (local >= elem.numLocals) simThrow(XERR.paramRange);
        elem.stack.mem[elem.localsAt() + local] = v;
      } else {
        if (elem.numParams === 0) simThrow(XERR.paramRange);
        elem.setParam(0, v);
      }
    };
    if (slot === "carry" || slot === "background") {
      if (anim === 0) {
        a.stop(slot);
        // the trees give the carry practice back to UpdateCarryPractice (+0x1a0 = 0, +0x1a4 = -1)
        if (slot === "carry") {
          a.carryMode = 0;
          a.carryAnim = -1;
        }
        return PRIM_TRUE;
      }
      const skill = this.loadSkill(elem, anim, source, flags);
      if (skill === undefined) return PRIM_WAIT;
      const t = skill ? a.start(slot, skill, backwards) : null;
      // the trees own the carry practice (+0x1a0 = 6) until they stop it
      if (t && slot === "carry") {
        a.carryMode = 6;
        a.carryAnim = -1;
      }
      return PRIM_TRUE;
    }
    if (anim === 0) {
      a.stop("main");
      a.state = this.restState();
      this.pd[0x13] = 0;
      a.carryBlocked = false;
      return PRIM_TRUE;
    }
    if (!a.animating) {
      const skill = this.loadSkill(elem, anim, source, flags);
      if (skill === undefined) {
        a.loadWait = true;
        return PRIM_WAIT;
      }
      a.events.length = 0;
      a.stop("main");
      // A skill that does not start (missing: e.g. SocialChild.iff's adult table entry 73,
      // "Listen normal apathetic", lacks its "a2a-" name) runs the person's "missing
      // animation tree" and plays StdAnimIdx 0x25 instead (SAnimator::TryAnimate).
      const t = skill ? a.start("main", skill, backwards) : this.startMissingAnimation(a);
      if (t) t.interruptible = (flags & 8) !== 0;
      // flags 1 | 0x10: a full-body animation, the carry practice stops until it ends (+0x19c = 1)
      if (slot === "carry3") {
        a.stop("carry");
        a.carryBlocked = true;
        a.carryAnim = -1;
      }
      a.animating = true;
      a.eventCount = 0;
      a.state = 0;
    }
    const e = a.dequeueEvent();
    if (e === undefined) {
      const done = a.isMainDone();
      if (!done && !(a.main?.interruptible && this.shouldInterrupt())) return PRIM_WAIT;
      if (a.eventCount < expected) {
        let ev = a.eventCount;
        if (backwards) ev = expected - ev - 1;
        store(ev);
        a.eventCount++;
        return PRIM_FALSE;
      }
      a.animating = false;
      a.state = this.restState();
      a.carryBlocked = false;
      return PRIM_TRUE;
    }
    let ev = e;
    if (e < 100) {
      let want = backwards ? expected - a.eventCount - 1 : a.eventCount;
      if (want >= expected || want < 0) want = -1;
      if (e !== want || e < 0) return PRIM_WAIT;
      a.eventCount++;
      ev = want;
    }
    store(ev);
    return PRIM_FALSE;
  }

  /**
   * SAnimator::TryAnimate when StartSkill fails on the main practice: the
   * person's "missing animation tree" runs (cXObject::RunTree, no stack
   * object), then GetSkill(0x25) is started instead (none while it loads).
   */
  private startMissingAnimation(a: PersonAnimator): ReturnType<PersonAnimator["start"]> {
    const tree = this.behavior.getTreeID("missing animation tree");
    if (tree !== 0) this.runCheckTree(this.behavior, 0, tree, null);
    const name = this.stdSkillName(0x25);
    const skill = name ? requestSkill(name) : null;
    return skill ? a.start("main", skill, false) : null;
  }

  /** The animator state after an animation: person data 0 (sitting?) 1 -> 1, 2 -> 2, 0 -> 3. */
  private restState(): number {
    const s = this.pd[PDX.sitting]!;
    if (s === 1) return 1;
    if (s === 2) return 2;
    if (s === 0) return 3;
    return this.animator.state;
  }

  /**
   * cXPerson::TryReach (Reach / Put). Operands: mode (0 take the stack
   * object into my hand, 1 put what I hold into a slot of the stack object,
   * 2 reach for nothing), `transfer` (0: only animate), the parameter
   * holding the slot (mode 1). StackElem +8 is the state: 0 start the reach
   * animation, 1 wait for its contact event (xevt 0) or its end, then move
   * the object (CanPlace / Place, then the object's "CT - Grab" / "CT - Put"
   * tree run on me), 2 / 3 wait for the end, true / false.
   */
  protected tryReach(elem: StackElem, mode: number, transfer: number, slotParam: number): number {
    const a = this.animator;
    const state = elem.state;
    if (state === 0) {
      const info = this.getReachInfo(elem, mode, slotParam);
      if (!info) return transfer === 0 ? PRIM_TRUE : PRIM_FALSE;
      const started = this.startReachAnimation(info.height);
      if (started === undefined) return PRIM_WAIT;
      if (!started) return transfer === 0 ? PRIM_TRUE : PRIM_FALSE;
      elem.state = 1;
      return PRIM_WAIT;
    }
    if (state === 1) {
      // The animation's events (vtable +0x88, DequeueAnimEvent): event 0 is the contact.
      let contact = false;
      for (let e = a.dequeueEvent(); e !== undefined; e = a.dequeueEvent()) if (e === 0) contact = true;
      if (a.isMainDone()) contact = true;
      if (!contact) return PRIM_WAIT;
      const info = this.getReachInfo(elem, mode, slotParam);
      if (!info) return transfer === 0 ? PRIM_TRUE : PRIM_FALSE;
      const hooks = this.module.worldHooks;
      if (transfer === 0) elem.state = 2;
      else if (mode === 0) {
        const o = info.obj!;
        const me = this.obj;
        const at = { fx: me.fx, fy: me.fy };
        if (!hooks || !hooks.canPlace(o.obj, at, me.level, me, 0)) elem.state = 3;
        else {
          hooks.place(o.obj, at, me.level, me, 0);
          this.module.dirty(o);
          this.runObjectTreeByName(o, "CT - Grab");
          elem.state = 2;
        }
      } else if (mode === 1) {
        const o = info.obj;
        const c = info.container!;
        const at = { fx: c.obj.fx, fy: c.obj.fy };
        if (!o || !hooks || !hooks.canPlace(o.obj, at, c.obj.level, c.obj, info.slot)) elem.state = 3;
        else {
          hooks.place(o.obj, at, c.obj.level, c.obj, info.slot);
          this.module.dirty(o);
          this.runObjectTreeByName(o, "CT - Put");
          elem.state = 2;
        }
      }
      return PRIM_WAIT;
    }
    if (state === 2 || state === 3) {
      if (!a.isMainDone()) return PRIM_WAIT;
      this.stopReachAnimation();
      return state === 2 ? PRIM_TRUE : PRIM_FALSE;
    }
    return -1;
  }

  /** cXObject::RunTree: the object's tree `name` run now on my stack, the object as stack object. */
  private runObjectTreeByName(o: SimObject, name: string): void {
    const tree = o.behavior.getTreeID(name);
    if (tree !== 0) this.runCheckTree(o.behavior, o.id, tree, null);
  }

  /**
   * cXPerson::TryGetReachInfo: the object reached for, its container and
   * slot, and the reach height (mode 2: -1; no container: 0; else the
   * container slot's height, cXObject::GetSlotHeight, times 3 / (2 sqrt 6),
   * lbl_105BA328). Null when something is missing; error 8 for a bad slot
   * parameter.
   */
  private getReachInfo(elem: StackElem, mode: number, slotParam: number): { obj: SimObject | null; container: SimObject | null; slot: number; height: number } | null {
    const m = this.module;
    if (mode === 2) return { obj: null, container: null, slot: 0, height: -1 };
    let obj: SimObject | null;
    let container: SimObject | null;
    let slot: number;
    if (mode === 0) {
      obj = m.getObject(elem.stackObj);
      if (!obj) return null;
      container = m.getObject(obj.obj.containerId);
      slot = obj.obj.slotNumber;
    } else if (mode === 1) {
      container = m.getObject(elem.stackObj);
      if (!container) return null;
      obj = m.getObject(this.obj.objectSlots[1]?.containedId ?? 0);
      if (slotParam < 0 || slotParam >= elem.numParams) simThrow(XERR.paramRange);
      slot = elem.getParam(slotParam);
    } else return null;
    if (!container) return { obj, container, slot, height: 0 };
    if (slot < 0 || slot >= container.obj.objectSlots.length - 1) return null;
    // cXObject::GetSlotHeight: the slot heights summed up the container chain.
    let h = 0;
    let c: SimObject | null = container;
    let s = slot;
    while (c) {
      const os = s >= 0 && s < c.obj.objectSlots.length - 1 ? c.obj.objectSlots[s + 1] : undefined;
      if (os) h = Math.fround(h + os.z);
      s = c.obj.slotNumber;
      c = m.getObject(c.obj.containerId);
    }
    return { obj, container, slot, height: Math.fround(3 * Math.fround(h * REACH_HEIGHT_SCALE)) };
  }

  /**
   * SAnimator::StartReachAnimation: FindReachAnimationIndex (heights
   * lbl_105BC8A8 +0x28..+0x38: below 0 -> 9, 0.75 -> 1, 2 -> 3, 8/3 -> 5,
   * 4 -> 7, higher: none; +1 when sitting, person data 0 = 1), the skill
   * GetReachSkill (Global.iff STR# 0x9a adult / 0x9b child, index + 1)
   * started on the main practice, events cleared, animation state 0.
   * Undefined while the skill loads.
   */
  private startReachAnimation(height: number): boolean | undefined {
    let idx: number;
    if (height < 0) idx = 9;
    else if (height < 0.75) idx = 1;
    else if (height < 2) idx = 3;
    else if (height < Math.fround(8 / 3)) idx = 5;
    else if (height < 4) idx = 7;
    else return false;
    if (this.pd[PDX.sitting] === 1) idx++;
    this.animator.checkResetSuits();
    const g = this.module.res.glob;
    const table = g ? loadStringSet(g, this.isChild ? 0x9b : 0x9a) : null;
    const name = table?.[idx]?.toLowerCase();
    if (!name) return false;
    const skill = requestSkill(name);
    if (skill === undefined) {
      this.animator.loadWait = true;
      return undefined;
    }
    if (!skill) {
      this.module.unportedValue(`missing skill ${name}`, 0);
      return false;
    }
    const a = this.animator;
    a.events.length = 0;
    if (!a.start("main", skill, false)) return false;
    a.carryBlocked = true;
    a.state = 0;
    return true;
  }

  /** SAnimator::StopReachAnimation: StopCurAnim, events cleared, the rest state. */
  private stopReachAnimation(): void {
    const a = this.animator;
    a.stop("main");
    a.carryBlocked = false;
    a.events.length = 0;
    a.state = this.restState();
  }

  /** Resolves and requests the skill: undefined while it loads, null when missing (logged). */
  protected loadSkill(elem: StackElem, anim: number, source: number, flags: number): Skill | null | undefined {
    const name = this.resolveSkillName(elem, anim, source, flags);
    if (!name) {
      this.module.unportedValue(`missing animation ${source}:${anim}`, 0);
      return null;
    }
    const s = requestSkill(name);
    if (s === null) this.module.unportedValue(`missing skill ${name}`, 0);
    return s;
  }

  /**
   * GetStdSkill(cXPerson, StdAnimIdx)'s name lookup (SkillLookup tables,
   * Global.iff STR# 150..160, entry idx + 1): swimming people (person data
   * 64) use the pool tables (158 / 159 by gender for adults, 160 for
   * children); others the child (151) or male / female (152 / 153) table,
   * then the adult one (150). First of all, ObjSelector::GetCustomWalkAnimTable:
   * STR# 150 of the person's own object file (the pets' character files
   * carry their "d2o-" / "k2o-" walk, turn and stand skills there).
   */
  stdSkillName(idx: number): string | null {
    const g = this.module.res.glob;
    if (!g) return null;
    const pd = this.pd;
    const get = (id: number): string | null => {
      const t = stdTables.get(id) ?? loadStringSet(g, id);
      stdTables.set(id, t);
      const v = t?.[idx];
      return v ? v.toLowerCase() : null;
    };
    const age = pd[PDX.personAge]!;
    const gender = pd[PDX.gender]! & 1;
    const custom = loadStringSet(this.obj.selector.res, 150)?.[idx];
    let name: string | null = custom ? custom.toLowerCase() : null;
    if (pd[64] !== 0) name = get(age >= 0x12 ? 158 + gender : 160);
    if (!name) {
      name = age < 0x12 ? get(151) : get(152 + gender);
      if (!name) name = get(150);
    }
    return name;
  }

  /**
   * cXObject::SetLocation for a walking person: what it carries follows,
   * its tile link moves with it and its room (object data 29) is resolved.
   */
  setLocation(fx: number, fy: number): void {
    const h = this.module.worldHooks;
    if (h) h.moveTo(this.obj, { fx, fy }, this.obj.level);
    else {
      this.obj.fx = fx;
      this.obj.fy = fy;
    }
    this.module.dirty(this);
  }

  // --- routing ---------------------------------------------------------------------

  /** The placement error of the last step that did not fit (trace). */
  private lastBlock: { code: number; obstacle: number } | null = null;

  /** cXPerson +0xaa0: the routes stack (portal trees push nested routes). */
  readonly routes: XRoute[] = [];

  /** cXPerson::GetCurrentRoute. */
  get route(): XRoute | null {
    return this.routes[this.routes.length - 1] ?? null;
  }

  /** On a lot tile (cXObject::IsInWorld's PlacementSpec test). */
  private inWorld(o: SimObject): boolean {
    const fixed = this.module.sim.world;
    const x = o.obj.tileX;
    const y = o.obj.tileY;
    return !!fixed && x >= 1 && y >= 1 && x < fixed.size - 1 && y < fixed.size - 1;
  }

  /** SAnimator::IsInterruptable. */
  private isInterruptable(): boolean {
    return this.animator.isInterruptable();
  }

  private traceRoute(text: string): void {
    if (this.traceOn) this.autonomyLog.push(`  route t${this.module.sim.tickCount} ${text}`);
  }

  /**
   * cXPerson::TryGotoRoutingSlot(StackElem, XPrimParam): operands slot
   * (parameter index when the type is 0, else the slot number), type (0
   * parameter, 1 literal, 2 the global routing slots), flags (bit 0 clear:
   * failure trees allowed, slot flag 0x4000). Error 0x34 without a stack
   * object, 0x25 for a bad slot, 8 for a bad parameter. Already running
   * (state != 0): the state machine goes on with the route on top.
   */
  protected tryGotoRoutingSlot(elem: StackElem, slotArg: number, type: number, flags: number): number {
    if (elem.state !== 0) return this.gotoRoutingSlot(elem, null);
    const target = this.module.getObject(elem.stackObj);
    if (!target) simThrow(0x34);
    if (!this.inWorld(target)) return PRIM_FALSE;
    let slots: RoutingSlot[];
    let index = slotArg;
    if (type === 0) {
      if (slotArg < 0 || slotArg >= elem.numParams) simThrow(XERR.paramRange);
      index = elem.getParam(slotArg);
      slots = this.routingSlotsOfObject(target);
    } else if (type === 1) {
      slots = this.routingSlotsOfObject(target);
    } else {
      if (type !== 2) simThrow(0x25);
      slots = this.module.globalRoutingSlots();
    }
    const slot = slots[index];
    if (!slot) simThrow(0x25);
    slot.flags &= ~RSF.failureTrees;
    if (!(flags & 1)) slot.flags |= RSF.failureTrees;
    return this.gotoRoutingSlot(elem, slot);
  }

  /** cXObject +0x140: the object's routing slots (MoveOutOfWay overrides the helper's). */
  private routingSlotsOfObject(o: SimObject): RoutingSlot[] {
    return slotOverrides.get(o) ?? this.module.routingSlotsOf(o.obj.selector);
  }

  /**
   * cXPerson::TryGotoRelative: a routing slot made on the fly (standing
   * weight 1, 1 tile away): location (byte 2) -2 on the object, -1 or
   * others the four sides 1 to 2 tiles away, 0..7 that direction (odd ones:
   * the two neighbouring even ones); direction (byte 3) -1 any facing, -2
   * towards the object, 0..7 that direction (others: error); flags (byte 6)
   * bit 1 clear allows failure trees, bit 2 ignores altitudes.
   */
  protected tryGotoRelative(elem: StackElem, location: number, direction: number, flags: number): number {
    if (elem.state !== 0) return this.gotoRoutingSlot(elem, null);
    const s = newRoutingSlot();
    s.multipliers[0] = 1;
    setTileDistances(s, 1, 1, 1);
    s.flags &= ~RSF.failureTrees;
    if (((flags >> 1) & 1) !== 1) s.flags |= RSF.failureTrees;
    s.flags &= ~RSF.ignoreAltitude;
    if ((flags >> 2) & 1) s.flags |= RSF.ignoreAltitude;
    const sides = (): void => {
      for (const d of [0, 2, 4, 6]) allowDirection(s, d);
      setTileDistances(s, 1, 2, 1);
    };
    switch (location) {
      case -2:
        s.flags &= ~0xff;
        break;
      case -1:
        sides();
        break;
      case 0:
      case 2:
      case 4:
      case 6:
        allowDirection(s, location);
        break;
      case 1:
      case 3:
      case 5:
      case 7:
        allowDirection(s, (location - 1) & 7);
        allowDirection(s, (location + 1) & 7);
        break;
      default:
        sides();
    }
    if (direction === -1) s.facing = FACE_ANY;
    else if (direction === -2) s.facing = FACE_TOWARDS;
    else if (direction >= 0 && direction < 8) s.facing = direction;
    else return PRIM_FALSE;
    return this.gotoRoutingSlot(elem, s);
  }

  /**
   * cXPerson::TryGotoRoutingSlot(StackElem, RoutingSlot): the route state
   * machine (elem state = the state, sub_1010683C / jump table
   * lbl_105BBB3C). States: 1 plan, 2 through a portal, 3 walking, 4 after
   * the chair's sit tree, 5 after the stand tree, 6 blocked, 7 failed, 8
   * arrived, 9 / 10 / 11 stop walking then 8 / 6 / 7, 12 start walking, 13
   * waiting animation, 14 waiting for the person asked to move, 15 stop
   * walking then replan, 16 failure (failure tree), 17 after it, 18 the
   * path (InitRoute), 19 / 20 the target left the world.
   */
  protected gotoRoutingSlot(elem: StackElem, slot: RoutingSlot | null): number {
    const target = this.module.getObject(elem.stackObj);
    const gone = !target || !this.inWorld(target);
    let state = elem.state;
    if (state === 0) {
      if (gone || !slot) return PRIM_FALSE;
      const r = new XRoute(this.module, this, target, slot);
      if ((this.pd[68]! & 1) === 1) r.slot.flags |= RSF.ignoreRooms;
      const top = this.route;
      if (top && !(top.slot.flags & RSF.failureTrees)) r.slot.flags &= ~RSF.failureTrees;
      this.routes.push(r);
      state = 1;
    }
    const route = this.route;
    if (!route) return PRIM_FALSE;
    if (!route.target) {
      elem.state = 0;
      this.routes.pop();
      return PRIM_WAIT;
    }
    if (gone) state = state === 3 ? 20 : 19;
    if (!route.loaded) {
      // A route saved mid-walk: portal choices are forgotten, a walk restarts.
      if (state === 2) route.portal = null;
      else if (state === 3) state = 15;
      route.loaded = true;
    }
    const r = this.routeStateMachine(elem, route, state);
    return r;
  }

  private routeStateMachine(elem: StackElem, route: XRoute, start: number): number {
    const pd = this.pd;
    const m = this.module;
    const me = this.obj;
    let state = start;
    const wait = (s: number, r: number = PRIM_WAIT): number => {
      elem.state = s;
      return r;
    };
    for (let guard = 0; guard < 64; guard++) {
      switch (state) {
        case 1: {
          // Plan: walk through portals to the target's room, or build the goals here.
          updateRoomIDs(m, 0);
          if (!(me.objectData[8]! & 8)) {
            state = 7;
            break;
          }
          const t = route.target!;
          if ((t.obj.objectData[29]! & 0xffff) !== (me.objectData[29]! & 0xffff) && !(route.slot.flags & RSF.ignoreRooms)) {
            // A portal some route of the stack walks through (its own tree routing to it from the other side): fail quietly.
            state = (t.obj.selector.objd.objectType === 8 || t.obj.kind === "portal") && isPortalInUse(this.routes, t) ? 7 : 2;
            break;
          }
          if (this.shouldInterrupt() && this.isInterruptable()) {
            route.result = ROUTE.interrupted;
            state = 7;
            break;
          }
          route.buildGoalList();
          this.traceRoute(`plan ${me.selector.name} at ${me.fx},${me.fy} -> ${t.obj.selector.name} ${t.obj.fx},${t.obj.fy}: ${route.goals.length} goals, result ${route.result}`);
          state = 18;
          if (pd[PDX.sitting] === 1) {
            if (route.isPersonSittingOnChairGoal(this)) {
              state = 8;
              break;
            }
            // Stand up first: a chair (sit and stand trees, entry points 26 / 27) runs its
            // stand tree with the starting point's directions, which also become the
            // route entry flags (person data 37). Without one, the route ends (state 7).
            const chair = me.parentId !== 0 ? m.getObject(me.parentId) : null;
            const tree = chair && chair.fnTable.getTreeID(EP.sit) !== 0 ? chair.fnTable.getTreeID(EP.stand) : 0;
            if (chair && tree !== 0 && this.gosubObjectTree(chair, { src: [route.startDirs, 0, 0, 0], at: 0 }, tree)) {
              pd[PDX.routeEntryFlags] = route.startDirs;
              pd[72] = 0;
              return wait(5, PRIM_CONTINUE);
            }
            state = 7;
          }
          break;
        }
        case 2: {
          // Through a portal (cXPortal::FindBestPortal, the portal tree).
          if (this.shouldInterrupt() && this.isInterruptable()) {
            route.result = ROUTE.interrupted;
            state = 7;
            break;
          }
          const t = route.target!;
          if ((t.obj.objectData[29]! & 0xffff) === (me.objectData[29]! & 0xffff)) {
            pd[72] = route.footprint;
            state = 1;
            break;
          }
          if (route.portal && !this.lastResult) failedPortalTree(m, this, route.portal);
          if (!route.portal) initPortalRoute(m, this);
          const p = findBestPortal(m, this, t);
          const tree = p ? p.fnTable.getTreeID(EP.portal) : 0;
          if (p && tree !== 0 && this.gosubObjectTree(p, null, tree)) {
            this.traceRoute(`portal ${p.obj.selector.name} (${p.id}) room ${p.obj.objectData[29]} for room ${t.obj.objectData[29]}`);
            beginningPortalTree(m, this, p);
            route.portal = p;
            pd[72] = 0;
            return wait(2, PRIM_CONTINUE);
          }
          route.result = ROUTE.roomUnreachable;
          state = 16;
          break;
        }
        case 3: {
          if (this.shouldInterrupt() && this.isInterruptable()) {
            route.result = ROUTE.interrupted;
            state = 11;
            break;
          }
          if (route.path.length === 0) {
            state = 11;
            break;
          }
          const r = this.animator.followOneStep();
          if (r === 1) state = 9;
          else if (r === 0) {
            const b = this.animator.blockedAt;
            const e = this.lastBlock;
            this.traceRoute(`blocked at ${me.fx},${me.fy} follow ${this.animator.followState} anim ${this.animator.state} step ${b ? `${b.fx},${b.fy}` : "-"} error ${e?.code} obstacle ${e?.obstacle}`);
            state = 10;
          }
          else return wait(3);
          break;
        }
        case 4:
          if (this.lastResult) state = 8;
          else {
            route.result = pd[PDX.routeResult] || ROUTE.couldNotSit;
            state = 16;
          }
          break;
        case 5:
          pd[72] = route.footprint;
          if (this.lastResult && pd[PDX.sitting] === 0) state = 1;
          else {
            route.result = ROUTE.couldNotStand;
            state = 16;
          }
          break;
        case 6: {
          // Blocked: replan while moving, then ask people in the way to move, replan once more, give up.
          const dx = me.fx - route.lastFx;
          const dy = me.fy - route.lastFy;
          route.lastFx = me.fx;
          route.lastFy = me.fy;
          switch (route.blockedStage) {
            case 0:
              // Not moved: straight on to the next stage (no replan).
              if (dx * dx + dy * dy > 0x40) state = 1;
              else route.blockedStage = 1;
              break;
            case 1:
              route.blockedStage = 2;
              if (!route.askedPerson && this.askOthersToMove(route)) state = 14;
              else state = 16;
              break;
            case 2:
              route.blockedStage = 3;
              state = 1;
              break;
            case 3:
              state = 16;
              break;
            default:
              state = 7;
          }
          break;
        }
        case 7:
        case 8:
          return this.finishRoute(elem, route, state === 8);
        case 9:
        case 10:
        case 11:
        case 15:
        case 20:
          if (!this.animator.isFollowing() || this.animator.endFollow()) {
            if (state === 9) m.record(this, "sound", "end_route");
            state = state === 9 ? 8 : state === 10 ? 6 : state === 11 ? 7 : state === 15 ? 1 : 19;
            break;
          }
          return wait(state);
        case 12:
          m.record(this, "sound", "begin_route");
          this.animator.beginFollow(route.path, me);
          return wait(3);
        case 13: {
          // Waiting animation for up to 15 ticks, then replan.
          if (m.sim.tickCount - route.waitTick < 15) {
            const tree = this.behavior.getTreeID("route waiting animation");
            if (tree !== 0 && this.gosubObjectTree(this, null, tree)) return wait(13, PRIM_CONTINUE);
            return wait(13);
          }
          state = 1;
          break;
        }
        case 14: {
          // Waiting for the person asked to move: the ask animation once, then the waiting
          // animation for 100 ticks at most (+0x5c the tick it started), then blocked again.
          if (this.shouldInterrupt() && this.isInterruptable()) {
            route.result = ROUTE.interrupted;
            state = 7;
            break;
          }
          if (!route.askedPerson) {
            // The asked person was cleaned up (+0x84): the blocked stages start over.
            route.waitTick = 0;
            if (route.asked) route.blockedStage = 0;
            state = 1;
            break;
          }
          const now = m.sim.tickCount;
          if (route.waitTick === 0) {
            const tree = this.behavior.getTreeID("route ask to move animation");
            if (tree !== 0 && this.gosubObjectTree(this, null, tree)) {
              const e = this.getCurElem();
              if (e) e.stackObj = route.askedPerson.id;
              route.waitTick = now;
              return wait(14, PRIM_CONTINUE);
            }
            state = 6;
            break;
          }
          if (now - route.waitTick < 100) {
            const tree = this.behavior.getTreeID("route waiting animation");
            if (tree !== 0 && this.gosubObjectTree(this, null, tree)) return wait(14, PRIM_CONTINUE);
          }
          route.waitTick = 0;
          state = 6;
          break;
        }
        case 16: {
          // Failure: the target's "Route failure feedback" tree (the thought balloon) when allowed.
          if (route.result === 0) route.result = ROUTE.unknown;
          pd[PDX.routeResult] = route.result;
          this.traceRoute(`failed: result ${route.result} blocker ${route.blocker}`);
          const t = route.target;
          if (route.slot.flags & RSF.failureTrees && t) {
            const tree = t.behavior.getTreeID("Route failure feedback");
            if (tree !== 0 && this.gosubObjectTree(t, { src: [route.result, route.blocker, 0, 0], at: 0 }, tree)) return wait(17, PRIM_CONTINUE);
          }
          state = 7;
          break;
        }
        case 17:
          pd[PDX.routeResult] = route.result;
          state = 7;
          break;
        case 18: {
          const r = this.initRoute(route);
          this.traceRoute(`path ${route.path.map((p) => `${p.fx},${p.fy}`).join(" ")} -> ${r}`);
          if (r === 2) state = 12;
          else if (r === 0) state = 6;
          else if (r === 1) state = 8;
          else {
            pd[72] = 0;
            return wait(4, PRIM_CONTINUE);
          }
          break;
        }
        case 19:
          state = 7;
          break;
        default:
          state = 7;
      }
    }
    return wait(state);
  }

  /**
   * States 7 / 8 of the route state machine: on success the person takes
   * its route footprint back (person data 72 -> 73) and must fit where it
   * stands (else the route fails with result 1), faces the facing point
   * and snaps to the grid; then the route result (person data 62), routing
   * complete (data 39) for a top-level route, object data 9 cleared, the
   * people waiting for this one released, the move-out-of-the-way action
   * pushed on the asked person removed, and the route popped.
   */
  private finishRoute(elem: StackElem, route: XRoute, success: boolean): number {
    const pd = this.pd;
    const m = this.module;
    const me = this.obj;
    if (success) {
      const h = m.worldHooks;
      if (pd[PDX.sitting] === 0 && h && me.parentId === 0) {
        // The route footprint becomes the footprint extension when the person fits with it
        // (else it is dropped); not fitting where the walk ended fails the route (result 1).
        const fp = pd[72]!;
        if (fp !== 0) pd[73] = fp;
        if (!h.canPlace(me, { fx: me.fx, fy: me.fy }, me.level, null, -1)) {
          if (fp !== 0) pd[73] = 0;
          route.result = ROUTE.unknown;
          success = false;
        }
      }
      if (success) {
        const n = route.path.length;
        if (n >= 2 && !me.objectData[9]) {
          const a = route.path[n - 2]!;
          const b = route.path[n - 1]!;
          if (a.fx !== b.fx || a.fy !== b.fy) me.objectData[1] = dirOf(b.fx - a.fx, b.fy - a.fy);
        }
        this.forceLocation();
        this.renderDir = null;
        route.result = 0;
      }
    }
    if (this.animator.isFollowing()) this.animator.endFollow();
    // State 7 (failure) without a result gives result 1.
    if (!success && route.result === 0) route.result = ROUTE.unknown;
    pd[PDX.routeResult] = route.result;
    if (this.routes.length === 1 && pd[38] === 0) pd[PDX.routingComplete] = 1;
    me.objectData[9] = 0;
    // This person moved out of someone's way: the asker's route (its top one) is released,
    // +0x84 telling whether the move worked.
    const cur = this.currentAction;
    if (cur) {
      for (const p of m.people) {
        if (p === this || !(p instanceof PersonSim)) continue;
        const r = p.route;
        if (r && r.askedPerson === this && r.askedInteraction === cur) {
          r.asked = success;
          r.askedPerson = null;
          r.askedInteraction = null;
        }
      }
    }
    // The move-out-of-the-way action pushed on the asked person is removed (RemoveAction).
    if (route.askedPerson instanceof PersonSim && route.askedInteraction) route.askedPerson.removeAction(route.askedInteraction as Interaction);
    this.routes.pop();
    this.module.dirty(this);
    this.traceRoute(`${success ? "arrived" : "gave up"} at ${me.fx},${me.fy} dir ${me.dir} result ${route.result}`);
    void elem;
    return success ? PRIM_TRUE : PRIM_FALSE;
  }

  /**
   * cXPerson::InitRoute: the path (XRoute::FindPath from the starting
   * point; chairs not wanted by pets), person data 37 = the goal's
   * direction flags; a chair goal runs the chair's sit tree (1: already in
   * it, 3: tree pushed, 0: result 5); a walk ends with the facing point
   * (1 tile from the last point: along the last segment for "any facing",
   * towards / away from the object, or the object's direction + n).
   * Returns 0 (no path), 1, 2 (walk) or 3.
   */
  private initRoute(route: XRoute): number {
    const me = this.obj;
    const slot = route.slot;
    const target = route.target!;
    if (slot.multipliers[1] !== 0 && this.pd[0x41]! >= 2) slot.multipliers[1] = 0;
    const ok = route.findPath();
    let r = 0;
    if (ok) {
      r = 2;
      const goal = route.currentGoal()!;
      this.pd[PDX.routeEntryFlags] = goal.dirFlags;
      if (goal.chair !== 0) {
        r = 0;
        const c = this.module.getObject(goal.chair);
        const tree = c ? c.fnTable.getTreeID(EP.sit) : 0;
        if (c && tree !== 0) {
          if (me.parentId === c.id) r = 1;
          else if (this.pd[0x41]! < 2 && this.gosubObjectTree(c, null, tree)) r = 3;
        }
        if (r === 0) route.result = ROUTE.couldNotSit;
      }
    }
    if (r === 2 && route.path.length < 2) r = 0;
    if (r !== 2) {
      if (r === 0) route.resetGoals();
      return r;
    }
    const path = route.path;
    const end = path[path.length - 1]!;
    const t = target.obj;
    let fx = t.fx;
    let fy = t.fy;
    let dir = -1;
    if (slot.facing === FACE_ANY) {
      const prev = path[path.length - 2]!;
      if (prev.fx === end.fx && prev.fy === end.fy) dir = me.dir & 7;
      else {
        fx = end.fx + (end.fx - prev.fx);
        fy = end.fy + (end.fy - prev.fy);
      }
    } else if (slot.facing === FACE_AWAY || slot.facing === FACE_TOWARDS) {
      if ((slot.flags & 0xff) === 0) {
        dir = t.fx === end.fx && t.fy === end.fy ? t.dir : dirOf(t.fx - end.fx, t.fy - end.fy);
        if (slot.facing === FACE_AWAY) dir = (dir + 4) & 7;
      } else if (!(slot.flags & RSF.anyRotation)) {
        dir = dirOf(t.fx - end.fx, t.fy - end.fy);
        if (slot.facing === FACE_AWAY) dir = (dir + 4) & 7;
      }
    } else {
      dir = (t.dir + slot.facing) & 7;
    }
    if (dir >= 0) {
      const [vx, vy] = DIR_VEC[dir]!;
      fx = end.fx + vx * 16;
      fy = end.fy + vy * 16;
    }
    if (fx === end.fx && fy === end.fy) {
      route.resetGoals();
      return 0;
    }
    path.push({ fx, fy });
    return 2;
  }

  /**
   * cXPerson::AskOthersToMove: the people near the route (not ignored by
   * it, not already asked by someone) are tried one by one: when ignoring
   * one of them gives a path, that one is asked to move (MoveOutOfWay).
   * Otherwise, with everybody ignored, the first person whose footprint
   * the path crosses is asked. Never while sitting.
   */
  private askOthersToMove(route: XRoute): boolean {
    const m = this.module;
    if (this.pd[PDX.sitting] !== 0) return false;
    const candidates: PersonSim[] = [];
    for (const p of m.people) {
      if (p === this || !(p instanceof PersonSim) || route.shouldIgnore(p)) continue;
      const asked = m.people.some((q) => q instanceof PersonSim && q.routes.some((r) => r.askedPerson === p));
      if (!asked) candidates.push(p);
    }
    if (!candidates.length) return false;
    const dir = this.obj.objectData[1]!;
    const trial = new XRoute(m, this, route.target, route.slot);
    for (const p of candidates) {
      trial.ignorePerson = p;
      trial.buildGoalList();
      if (trial.findPath() && p.moveOutOfWay(this, route, trial.path)) {
        this.obj.objectData[1] = dir;
        return true;
      }
    }
    this.obj.objectData[1] = dir;
    // Everybody ignored: who stands on the path?
    const all = new XRoute(m, this, route.target, route.slot);
    all.ignoreAll = true;
    all.buildGoalList();
    this.obj.objectData[1] = dir;
    if (!all.findPath() || all.path.length < 2) return false;
    for (let i = 0; i + 1 < all.path.length; i++) {
      const a = all.path[i]!;
      const b = all.path[i + 1]!;
      const steps = Math.max(Math.abs(b.fx - a.fx), Math.abs(b.fy - a.fy)) + 1;
      for (let s = 0; s < steps; s++) {
        const fx = Math.trunc(0.5 + a.fx + ((b.fx - a.fx) * s) / steps);
        const fy = Math.trunc(0.5 + a.fy + ((b.fy - a.fy) * s) / steps);
        const hit = candidates.find((c) => fx < c.obj.rect[1] && c.obj.rect[3] <= fx && fy < c.obj.rect[0] && c.obj.rect[2] <= fy);
        if (hit) return hit.moveOutOfWay(this, route, all.path);
      }
    }
    return false;
  }

  /** The "Destination - For Go Here & Shoo" helper object (MoveOutOfWay's target). */
  private static readonly MOVE_HELPER_GUID = 0x7c4;

  /** Is a move-out-of-the-way interaction (helper 0x7c4, TTAB 3) current or queued? */
  hasMoveOutOfWay(): boolean {
    const isMove = (i: Interaction | null): boolean => {
      if (!i) return false;
      const o = this.module.getObject(i.target);
      return !!o && o.obj.guid === PersonSim.MOVE_HELPER_GUID && i.ttabIndex === 3;
    };
    return isMove(this.currentAction) || this.queue.some(isMove);
  }

  /**
   * cXPerson::MoveOutOfWay(asker's route, path): false when already moving
   * out of the way or waiting on someone; else the helper object 0x7c4 is made at
   * this person's position with a routing slot to either side of the
   * asker's path (1 to 5 tiles, 8 units resolution, any facing, random
   * scores; straight ahead too when the sides are blocked), and its
   * interaction 3 is pushed with the asker's priority (person data 33).
   */
  moveOutOfWay(asker: PersonSim, route: XRoute, path: readonly PathPt[]): boolean {
    if (this.hasMoveOutOfWay() || path.length < 2) return false;
    const top = this.route;
    if (top && top.askedPerson) return false;
    const me = this.obj;
    // Where the path enters and leaves this person's footprint.
    let stage = 0;
    let ex = 0;
    let ey = 0;
    let lx = 0;
    let ly = 0;
    for (let i = 0; i + 1 < path.length && stage < 2; i++) {
      const a = path[i]!;
      const b = path[i + 1]!;
      const steps = Math.max(Math.abs(b.fx - a.fx), Math.abs(b.fy - a.fy)) + 1;
      for (let s = 0; s < steps; s++) {
        const fx = Math.trunc(0.5 + a.fx + ((b.fx - a.fx) * s) / steps);
        const fy = Math.trunc(0.5 + a.fy + ((b.fy - a.fy) * s) / steps);
        const inside = fx < me.rect[1] && me.rect[3] <= fx && fy < me.rect[0] && me.rect[2] <= fy;
        if (inside) {
          if (stage === 0) {
            stage = 1;
            ex = fx;
            ey = fy;
          }
        } else if (stage === 1) {
          stage = 2;
          lx = fx;
          ly = fy;
          break;
        }
      }
    }
    if (stage === 0) {
      ex = path[0]!.fx;
      ey = path[0]!.fy;
      lx = me.fx;
      ly = me.fy;
    } else if (stage === 1) {
      lx = path[path.length - 1]!.fx;
      ly = path[path.length - 1]!.fy;
    }
    const h = this.module.worldHooks;
    const sel = h?.selector(PersonSim.MOVE_HELPER_GUID);
    if (!h || !sel) return false;
    const helperObj = h.make(sel);
    if (!helperObj) return false;
    const helper = this.module.getObject(helperObj.objectId);
    if (!helper) return false;
    h.place(helperObj, { fx: me.fx, fy: me.fy }, me.level, null, -1);
    const s = newRoutingSlot();
    const dx = lx - ex;
    const dy = ly - ey;
    const d = dx === 0 && dy === 0 ? 0 : dirOf(dx, dy);
    allowDirection(s, (d + 2) & 7);
    allowDirection(s, (d + 6) & 7);
    s.flags |= RSF.anyRotation;
    s.minProximity = 0x10;
    s.maxProximity = 0x50;
    s.optimalProximity = 0x10;
    s.resolution = 8;
    s.facing = FACE_ANY;
    s.multipliers[0] = 1;
    s.flags |= RSF.randomScore;
    const test = new XRoute(this.module, this, helper, s);
    const dir = me.objectData[1]!;
    test.buildGoalList();
    if (!test.findPath()) {
      allowDirection(s, d);
      s.optimalProximity = 0x50;
    }
    me.objectData[1] = dir;
    const own = [...this.routingSlotsOfObject(helper)];
    own[0] = s;
    slotOverrides.set(helper, own);
    const e = this.module.treeTableOf(helper.obj.selector)?.entries.find((x) => x.stringIndex === 3);
    if (!e) return false;
    const i = this.makeInteraction(helper, e, asker.pd[33]!);
    if (!this.addAction(i)) {
      this.module.killObject(helper);
      return false;
    }
    route.askedPerson = this;
    route.askedInteraction = i;
    route.asked = false;
    this.module.record(asker, "askToMove", this.id);
    return true;
  }

  /** TrySnap's flag 2 (cXObject::TrySnap): the person in the way moves, with my current action's priority. */
  protected override askToMoveOutOfWay(other: SimObject): boolean {
    return other instanceof PersonSim && other.moveOutOfWayFor(this.currentAction?.priority ?? 0);
  }

  /**
   * cXPerson::MoveOutOfWay(int priority), TrySnap's flag 2: false when
   * already moving out of the way; else the helper object 0x7c4 is made at
   * this person's position with a routing slot on its four sides (1 to 5
   * tiles, any facing and rotation, random scores) and its interaction 3 is
   * pushed with `priority`.
   */
  moveOutOfWayFor(priority: number): boolean {
    if (this.hasMoveOutOfWay()) return false;
    const me = this.obj;
    const h = this.module.worldHooks;
    const sel = h?.selector(PersonSim.MOVE_HELPER_GUID);
    if (!h || !sel) return false;
    const helperObj = h.make(sel);
    if (!helperObj) return false;
    const helper = this.module.getObject(helperObj.objectId);
    if (!helper) return false;
    h.place(helperObj, { fx: me.fx, fy: me.fy }, me.level, null, -1);
    const s = newRoutingSlot();
    for (const d of [0, 2, 4, 6]) allowDirection(s, d);
    s.flags |= RSF.anyRotation;
    s.minProximity = 0x10;
    s.maxProximity = 0x50;
    s.optimalProximity = 0x10;
    s.facing = FACE_ANY;
    s.multipliers[0] = 1;
    s.flags |= RSF.randomScore;
    const own = [...this.routingSlotsOfObject(helper)];
    own[0] = s;
    slotOverrides.set(helper, own);
    const e = this.module.treeTableOf(helper.obj.selector)?.entries.find((x) => x.stringIndex === 3);
    if (!e || !this.addAction(this.makeInteraction(helper, e, priority))) {
      this.module.killObject(helper);
      return false;
    }
    return true;
  }

  /**
   * cXPerson::TryLookTowards: 0 turns the head (SAnimator::LookTowards, not
   * drawn here; true); 1 faces the camera; 2 / 3 face towards / away from
   * the stack object (error 0x15 without one). 1..3 walk a path [me, me,
   * facing point] with the walk engine (a StandingTurn), false when
   * sitting; others error 0x27.
   */
  protected tryLookTowards(elem: StackElem, mode: number): number {
    if (mode === 0) return PRIM_TRUE;
    if (mode < 0 || mode > 3) simThrow(0x27);
    const a = this.animator;
    if (elem.state === 0) {
      if (this.pd[PDX.sitting] !== 0) return PRIM_FALSE;
      const me = this.obj;
      let fx: number;
      let fy: number;
      if (mode === 1) {
        // A point one tile towards the viewer: (+16, +16) in view coordinates, rotated back.
        const rot = this.module.sim.state?.getRotation() ?? 0;
        const [vx, vy] = RotatableWorld.rotateCoords(me.fx, me.fy, rot, 0x400);
        [fx, fy] = RotatableWorld.rotateCoords(vx + 16, vy + 16, (4 - rot) & 3, 0x400);
        me.objectData[9] = 0;
      } else {
        const o = this.module.getObject(elem.stackObj);
        if (!o) simThrow(0x15);
        fx = o.obj.fx;
        fy = o.obj.fy;
        if (mode === 3) {
          fx = me.fx * 2 - fx;
          fy = me.fy * 2 - fy;
        }
      }
      a.beginFollow(
        [
          { fx: me.fx, fy: me.fy },
          { fx: me.fx, fy: me.fy },
          { fx, fy },
        ],
        me,
      );
      elem.state = 1;
    }
    let r = a.followOneStep();
    if (r === 0) r = 1;
    if (r === 2) return PRIM_WAIT;
    if (!a.endFollow()) return PRIM_WAIT;
    this.module.dirty(this);
    return PRIM_TRUE;
  }

  /**
   * cXPerson::TryChangeSuit (primitive 6). Operands: suit index, scope,
   * flags. Scope 1 (outfit): person data 8 := index (flag 1: nothing); a
   * costume trunk outfit (>= 8) draws its variant into person data 21 (a
   * child: 0 / 1, toggled when the outfit stays; an adult: 0..9, another one
   * when it stays), other outfits clear it; SAnimator::UpdateOutfitAndHands
   * dresses it at the next render. Scope 0 (global file) / 2 (private
   * file): STR# 0x130 entry index + 1, lowercased, is an accessory put on
   * (SAnimator::Dress) or, flag 1, taken off (Undress). Errors 0x2f (bad
   * scope, no file), 0x30 (no suit name).
   */
  protected tryChangeSuit(elem: StackElem, index: number, scope: number, flags: number): number {
    const pd = this.pd;
    if (scope === 1) {
      if (flags & 1) return PRIM_TRUE;
      if (index < 8) pd[21] = 0;
      else {
        const cur = pd[21]!;
        const rnd = (): number => this.module.sim.random();
        let v: number;
        if (index === pd[8]) {
          if (this.isChild) v = cur === 0 ? 1 : 0;
          else
            do v = rnd() % 10;
            while (v === cur);
        } else v = this.isChild ? rnd() & 1 : rnd() % 10;
        pd[21] = v;
      }
      pd[8] = index;
      return PRIM_TRUE;
    }
    const beh = elem.behavior;
    const file = scope === 0 ? beh?.glob : scope === 2 ? beh?.priv : null;
    if (!file) simThrow(0x2f);
    const name = loadStringSet(file, 0x130)?.[index];
    if (!name) simThrow(0x30);
    const suit = name.toLowerCase();
    const acc = this.animator.accessories;
    acc.delete(suit);
    if (!(flags & 1)) acc.set(suit, "");
    return PRIM_TRUE;
  }

  // --- interactions --------------------------------------------------------------------

  /** Interaction score curves (MotiveEffects: Global.iff STR# 0x1f5 adult / 0x1f7 child, 9 curves). */
  scoreCurves: readonly MotiveCurve[] = [];

  /** MotiveEffects::GetCurrentScore: mean of the curves at the current motives. */
  currentScore(): number {
    const c = this.scoreCurves;
    if (!c.length) return 0;
    let s = 0;
    for (const k of c) s += k.fn.count ? k.fn.eval(this.motives[k.motive]!) : 0;
    return s / c.length;
  }

  /** MotiveEffects::GetInteractionScore: the mean of the curves at the motives plus the entry's advertised effects. */
  interactionScore(e: TreeTableEntry, ads?: readonly Int16Array[]): number {
    const c = this.scoreCurves;
    if (!c.length) return 0;
    let s = 0;
    for (const k of c) {
      // the check tree may have changed the advertisements (the scratch entry)
      const a = ads && k.motive < e.motives.length ? ads[k.motive] : undefined;
      const ad = a ? { personality: a[0]!, min: a[1]!, delta: a[2]! } : e.motives[k.motive];
      let effect = 0;
      if (ad) {
        if (ad.personality === 0) effect = ad.min + ad.delta;
        else {
          const p = PERSONALITY_ADS[ad.personality];
          let v = p ? this.pd[p[0]]! : 0;
          if (p && p[1]) v = 1000 - v;
          effect = ad.min + (v * ad.delta) / 1000;
        }
      }
      s += k.fn.count ? k.fn.eval(this.motives[k.motive]! + effect * 0.001) : 0;
    }
    return s / c.length;
  }

  /**
   * ObjTestSim::TestInteraction for autonomy: the entry's flags against the
   * person (visitor flags 1 / 0x20, children 0x10, adults-only 0x40, pets 0x200 /
   * 0x400), the object's lockout count, then its check tree run on the person
   * with the object as stack object (parameter 0 = 1: autonomous). The
   * person's temps are restored afterwards.
   */
  testInteraction(target: SimObject, e: TreeTableEntry, auto: boolean, wantAds = false, joinVar: number | null = null): boolean {
    const pd = this.pd;
    // The person's object data 50 (+0xae) is cleared first; a check tree that
    // sets it hides the entry from the pie menu (interaction flag 0x10).
    this.obj.objectData[50] = 0;
    const visitor = pd[PDX.personType] !== 0;
    if (target.obj.objectData[8]! & 0x200) return false;
    if (auto && target.obj.objectData[25]! >= 1) return false;
    // A visitor (person data 0x20) needs "allow visitors" (flag 1); on a lot that is not
    // residential (zoning type != 1: the travelling family are visitors there too) flag
    // 0x20 is enough. Objects with object data 59 (+0xc0) 4 or 7 (hotel rooms) stay
    // usable when the person's neighbor holds the key token (type 0, ObjectFolder::GetKeyGUID).
    if (!(e.flags & 1) && visitor && (this.module.getZoningType(this.module.sim.globals[10]!) === 1 || !(e.flags & 0x20))) {
      const t = target.obj.objectData[59];
      if (t !== 4 && t !== 7) return false;
      const inv = this.module.getInventoryByNeighbourID(pd[PDX.neighborId]!);
      if (findToken(inv, 0, this.module.worldHooks?.keyGUID?.() ?? 0).count <= 0) return false;
    }
    if (this.isChild) {
      if (e.flags & 0x10) return false;
    } else if (pd[PDX.gender]! & 2) {
      if (!(e.flags & 0x400)) return false;
    } else if (pd[PDX.gender]! & 4) {
      if (!(e.flags & 0x200)) return false;
    } else if (e.flags & 0x40) return false;
    if (wantAds) {
      // TreeTableEntry::CopyFrom into the scratch entry (lbl_105BA320)
      const ads = this.module.sim.currentAd;
      const n = Math.min(ads.length, e.motives.length);
      for (let i = 0; i < n; i++) {
        const mo = e.motives[i]!;
        ads[i]!.set([mo.personality, mo.min, mo.delta]);
      }
    }
    const r = this.runTestTree(target, e, auto, joinVar);
    // another room (object data 29): the room advertisement's delta is -min
    if (wantAds && target.obj.objectData[29] !== this.obj.objectData[29]) {
      const a13 = this.module.sim.currentAd[13];
      if (a13) a13[2] = -a13[1]!;
    }
    return r;
  }

  /**
   * The check tree part of ObjTestSim::TestInteraction: parameter 0 is 1 when
   * autonomous; for a join (interaction type 1) parameter 1 is 1 and
   * parameter 2 the interaction's stack var 2 (`joinVar`).
   */
  private runTestTree(target: SimObject, e: TreeTableEntry, auto: boolean, joinVar: number | null = null): boolean {
    if (e.checkTree === 0) return true;
    // ObjTestSim runs the check tree on its own stack: an error there only
    // fails the test. Here it runs above the person's stack, unwound on error.
    const saved = new Int16Array(this.temps.subarray(0, 8));
    const depth = this.getStackSize();
    try {
      return this.runCheckTree(target.behavior, target.id, e.checkTree, { src: [auto ? 1 : 0, joinVar === null ? 0 : 1, joinVar ?? 0, 0], at: 0 });
    } catch (err) {
      while (this.getStackSize() > depth) {
        this.stack.pop();
        this.stackJustPopped();
      }
      if (this.traceOn) this.autonomyLog.push(`  test ${target.obj.selector.name}: ${e.name} failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    } finally {
      this.temps.set(saved, 0);
    }
  }

  /**
   * cXPerson::TryFindBestAction (autonomy): scores the interactions of the
   * autonomous objects (sim flag 8) the person may use (TTAB autonomy
   * threshold <= person data 0x24, check tree passes) as
   * (interaction score - current score) / (1 + distance * attenuation),
   * keeps those >= the FCNS 2 minimum score, and picks at random among the
   * best "random selection count" (minus logic / 2000), or the best one for a
   * visitor or a TTAB flag 0x100 entry on a residential lot: the stack object
   * becomes the object and object data 20 the entry.
   */
  protected tryFindBestAction(elem: StackElem): number {
    const m = this.module;
    // Free will off (lbl_105BA218): a human of the household (person type 0, not
    // a pet: person data 0x41 bits 1 / 2 clear) or a human of the house's family
    // (family number global 9, gender <= 1) picks nothing.
    if (!m.sim.freeWillOn) {
      const gender = this.pd[0x41]!;
      if (this.pd[PDX.personType] === 0) {
        if ((gender & 6) === 0) return PRIM_FALSE;
      } else if (m.sim.globals[9] === this.pd[PDX.familyNumber] && gender <= 1) return PRIM_FALSE;
    }
    const cur = this.currentScore();
    const k = m.autonomy;
    const visitor = this.pd[PDX.personType] !== 0;
    const minScore = visitor ? k.minVisitors : k.minFamily;
    const scored: Array<{ o: SimObject; e: TreeTableEntry; score: number }> = [];
    const autonomy = this.pd[0x24]!;
    // The objects looked at rotate with the tick (cSimulator +0x98) and the person's id:
    // 0 all of them, 1 those within 7 tiles (lbl_105BBB78 +0x1c), 2 even ids, 3 odd ids;
    // all of them on a lot whose zoning type is not 0 (any lot listed in the zoning table, and lot 0).
    const lot = m.sim.globals[10]!;
    const zoning = m.getZoningType(lot);
    let filter = (m.sim.tickCount + this.id) & 3;
    if (zoning !== 0) filter = 0;
    // Vacation lots (40..49): someone not of the family in global 9 leaves the bathroom
    // objects (category 5..7) of the inside rooms alone when the lot has an object of
    // category 0x2e (the front desks).
    const vacation = lot > 0x27 && lot < 0x32;
    const skipBathrooms = vacation && this.pd[PDX.familyNumber] !== m.sim.globals[9] && m.list.some((o) => o.obj.objectData[OD_CATEGORY] === 0x2e);
    for (const o of m.list) {
      if (o.obj.selector.objd.i16(0xe) === 0) continue;
      if (!(m.getSimFlags(o.id) & 0x80000)) continue;
      // On a vacation lot or a zoning type 2 lot, not the objects whose master OBJD
      // build mode type (+0x8a) is 4 or 5.
      if (zoning === 2 || vacation) {
        const buildType = o.obj.selector.getMasterSelector().objd.i16(0x8a);
        if (buildType === 4 || buildType === 5) continue;
      }
      // The person itself only for pets (person data 0x41 >= 2).
      if ((o === this && this.pd[0x41]! < 2) || o.obj.hidden !== 0) continue;
      if (o.obj.objectData[25]! >= 1) continue;
      if (skipBathrooms && this.isInsideBathroomObject(o)) continue;
      const dist = this.distanceTo(o);
      if (filter === 1 ? dist > 7 : filter === 2 ? (o.id & 1) !== 0 : filter === 3 && (o.id & 1) === 0) continue;
      const tt = m.treeTableOf(o.obj.selector);
      if (!tt) continue;
      for (let i = tt.entries.length - 1; i >= 0; i--) {
        const e = tt.entries[i]!;
        if (e.autonomyThreshold <= 0 || e.autonomyThreshold > autonomy || e.flags & 0x80) continue;
        if (!this.testInteraction(o, e, true, true)) continue;
        const ad = this.interactionScore(e, m.sim.currentAd);
        if (ad === 0) continue;
        const att = attenuation(e, k, visitor);
        const score = (1 / (dist * att + 1)) * (ad - cur);
        if (score >= minScore) scored.push({ o, e, score });
      }
      // ObjTestSim::AppendInteractionsForAuto's last block: a person whose current
      // action is joinable (TTAB flag 2) offers to join it (Interaction(me, o), type 1).
      const join = o.person && o !== this ? (o as PersonSim).joinOffer() : null;
      if (join && this.testInteraction(join.target, join.entry, true, true, 0)) {
        const ad = this.interactionScore(join.entry, m.sim.currentAd);
        if (ad !== 0) {
          const att = attenuation(join.entry, k, visitor);
          const score = (1 / (this.distanceTo(join.target) * att + 1)) * (ad - cur);
          if (score >= minScore) scored.push({ o: join.target, e: join.entry, score });
        }
      }
    }
    scored.sort((a, b) => b.score - a.score);
    this.lastScores = scored.slice(0, 10).map((x) => ({ object: x.o.id, name: `${x.o.obj.selector.name}: ${x.e.name}`, score: x.score }));
    if (this.traceOn) {
      this.autonomyLog.push(`t${m.sim.tickCount} cur ${cur.toFixed(2)} n=${scored.length} ${this.lastScores.slice(0, 4).map((x) => `${x.name}=${x.score.toFixed(3)}`).join(", ")}`);
      if (this.autonomyLog.length > 5000) this.autonomyLog.shift();
    }
    if (!scored.length) return PRIM_FALSE;
    const n = Math.max(1, Math.trunc(k.randomCount) - Math.trunc(this.pd[0x12]! / 2000));
    // A visitor, or a best entry whose interaction has flag 1 (TTAB entry flag 0x100,
    // ScoredInteraction +0xc), on a residential lot takes the top score.
    const top = (visitor || (scored[0]!.e.flags & 0x100) !== 0) && zoning === 1;
    const pick = top ? 0 : scored.length < n ? m.sim.random() % scored.length : m.sim.random() % n;
    const best = scored[pick]!;
    if (this.pd[PDX.sitting] !== 0 && best.score < k.minSitting) return PRIM_FALSE;
    this.obj.objectData[20] = best.e.stringIndex;
    elem.stackObj = best.o.id;
    return PRIM_TRUE;
  }

  /** TryFindBestAction's vacation lot test: in a room (object data 29) that exists and is inside, of category 5, 6 or 7. */
  private isInsideBathroomObject(o: SimObject): boolean {
    const room = o.obj.objectData[OD_ROOM]! & 0xffff;
    if (room === 0xfffb) return false;
    const r = this.module.roomHooks?.room(room);
    if (!r || r.outside) return false;
    const category = o.obj.objectData[OD_CATEGORY]!;
    return category === 5 || category === 6 || category === 7;
  }

  /** cXObject::CalcShortDistance in tiles. */
  private distanceTo(o: SimObject): number {
    const dx = (o.obj.fx - this.obj.fx) / 16;
    const dy = (o.obj.fy - this.obj.fy) / 16;
    const dl = (o.obj.level - this.obj.level) * 20;
    return Math.sqrt(dx * dx + dy * dy + dl * dl);
  }

  /**
   * cXPerson::TryGosubFoundAction: pushes the action tree of the stack
   * object's TTAB entry chosen by Find Best Interaction (object data 20) and
   * makes it the current action (error 0x15 without stack object, 0x16 when
   * the entry is gone).
   */
  protected tryGosubFoundAction(elem: StackElem): number {
    if (elem.stackObj === 0) simThrow(XERR.noStackObject);
    const o = this.module.getObject(elem.stackObj);
    if (!o) return PRIM_FALSE;
    const tt = this.module.treeTableOf(o.obj.selector);
    if (!tt) return PRIM_FALSE;
    const idx = this.obj.objectData[20]!;
    const e = tt.entries.find((x) => x.stringIndex === idx);
    if (!e) simThrow(0x16);
    if (!this.gosubObjectTree(o, { src: [0, 0, 0, 0], at: 0 }, e.actionTree)) return PRIM_FALSE;
    // Interaction(person, object, entry, priority 2): autonomous.
    this.setCurrentAction(this.makeInteraction(o, e, 2));
    this.module.record(this, "action", `${o.obj.selector.name}: ${e.name}`);
    return PRIM_CONTINUE;
  }

  /** Interaction::Interaction(person, object, entry, priority). */
  makeInteraction(o: SimObject, e: TreeTableEntry, priority: number, item: MenuItem | null = null): Interaction {
    return {
      target: o.id,
      actionTree: e.actionTree,
      checkTree: e.checkTree,
      ttabIndex: e.stringIndex,
      icon: o.id,
      // Interaction::SetStackVars of a MakeNewMenuItem entry
      args: item?.args ? new Int16Array(item.args) : new Int16Array(4),
      flags: e.flags & 0x100 ? 1 : 0,
      priority,
      name: item?.name ?? e.name,
    };
  }

  /**
   * cXPerson::SetCurrentAction: the current action becomes the last one;
   * person data 33 ("Priority") takes the new priority, the motive
   * increments are cleared, and so are person data 71..73.
   */
  setCurrentAction(i: Interaction | null): void {
    if (this.currentAction) {
      this.lastAction = this.currentAction;
      // +0xa7c bit 0x20: the last action's tree returned true (the tree result, +0x1c).
      this.lastActionResult = this.lastResult;
    }
    this.currentAction = i;
    // A new action with a target starts with its routing flags (person data 38 / 39) cleared.
    if (i && i.target !== 0) {
      this.pd[38] = 0;
      this.pd[PDX.routingComplete] = 0;
    }
    this.pd[33] = i ? i.priority : 0;
    this.motiveIncs.length = 0;
    // The footprint extension (73, the rect recomputed), route footprint mask (72) and
    // non-interruptible (71) are reset: a social interrupted before "walk away" leaves no
    // footprint behind.
    if (this.pd[73] !== 0) {
      this.pd[73] = 0;
      if (this.obj.parentId === 0 && this.inWorld(this)) this.setLocation(this.obj.fx, this.obj.fy);
    }
    this.pd[72] = 0;
    this.pd[71] = 0;
    this.module.onQueueChanged?.(this);
  }

  /**
   * cXPerson::AddAction. Entries flagged "run immediately" (TTAB flag 4)
   * are not queued: once ObjTestSim::TestInteraction passes, their action
   * tree runs at once as a one-tick tree on this person (stack object = the
   * target, priority person data 33 = the interaction's for the time of
   * it), unless one already runs (lbl_105BE790). Others: without
   * interaction flag 2 the queued interactions of lower priority are
   * dropped (their object's entry point 4 check tree runs) and `i` goes at
   * the end; with flag 2 it goes in front (the 8th one falls off).
   */
  addAction(i: Interaction): boolean {
    const m = this.module;
    const tgt = m.getObject(i.target);
    const e = tgt ? m.treeTableOf(tgt.obj.selector)?.entries.find((x) => x.stringIndex === i.ttabIndex) : null;
    if (!tgt || !e) return false;
    if (e.flags & 4) return this.runImmediately(tgt, e, i);
    if (!(i.flags & 2)) {
      let k = this.queue.length;
      while (k > 0 && this.queue[k - 1]!.priority < i.priority) k--;
      for (const d of this.queue.splice(k)) {
        const o = m.getObject(d.target);
        const tree = o ? o.fnTable.getTreeID(4) : 0;
        if (o && tree !== 0) o.runCheckTree(o.behavior, this.id, tree, null);
      }
      if (this.queue.length >= 8) return false;
      this.queue.push(i);
    } else {
      // interaction flag 0x40: it takes the current action's name
      if (i.flags & 0x40 && this.currentAction) i.name = this.currentAction.name;
      this.queue.unshift(i);
      if (this.queue.length > 8) this.queue.length = 8;
    }
    m.onQueueChanged?.(this);
    return true;
  }

  /** The "run immediately" part of cXPerson::AddAction (TreeSim::RunOneTickTree). */
  private runImmediately(target: SimObject, e: TreeTableEntry, i: Interaction): boolean {
    const m = this.module;
    if (!this.testInteraction(target, e, false) || m.immediateAction) return false;
    m.immediateAction = i;
    const saved = this.pd[33]!;
    this.pd[33] = i.priority;
    // the ObjTestSim around it gives the person's temps back afterwards
    const temps = new Int16Array(this.temps.subarray(0, 8));
    const depth = this.getStackSize();
    try {
      this.runOneTickTree(target.behavior, target.id, i.actionTree, { src: Array.from(i.args), at: 0 });
    } catch (err) {
      if (err instanceof SimError) this.recordError(err.code);
      while (this.getStackSize() > depth) {
        this.stack.pop();
        this.stackJustPopped();
      }
      m.record(this, "error", `run immediately ${target.obj.selector.name}: ${i.name}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      m.immediateAction = null;
      this.pd[33] = saved;
      this.temps.set(temps, 0);
    }
    return true;
  }

  /**
   * ObjTestSim::AppendInteractionsForMenu: the entries of `target`'s tree
   * table the person may be asked to do (the user pie menu): each one is
   * tested as an interaction of priority 50, not autonomous; debug entries
   * (TTAB flag 0x80) are tested like the others (only autonomy skips them),
   * their name starting with "*" (Interaction::GetName, lbl_105BB8AC).
   * Pets only get menus from GUID 0x7c4.
   * While a check tree runs the menu is "in progress": its Add / Change
   * Action String primitives add items (MakeNewMenuItem, e.g. the phone's
   * "$Family/Call $Neighbor" for each friend) and then the entry itself
   * is not added. Entries whose check tree sets the person's object data
   * 50 are hidden (hiddenFromMenu).
   */
  menuItemsFor(target: SimObject): MenuItem[] {
    const g = this.pd[PDX.gender]!;
    if (g & 6 && (target.obj.selector.guid >>> 0) !== 0x7c4) return [];
    const tt = this.module.treeTableOf(target.obj.selector);
    if (!tt) return [];
    const items: MenuItem[] = [];
    const m = this.module;
    try {
      for (const e of tt.entries) {
        m.menuInProgress = { items, entry: e };
        const n = items.length;
        // an entry whose check tree made items of its own is not added itself
        if (this.testInteraction(target, e, false) && items.length === n && !this.hiddenFromMenu()) items.push({ entry: e, name: e.flags & 0x80 ? `*${e.name}` : e.name, args: null });
      }
      // The join block: when my current action is joinable, a clicked person may be
      // asked to join it (Interaction(clicked person, me), stack var 2 = my id,
      // tested with the interaction type 1).
      const join = target.person && target !== this ? this.joinOffer() : null;
      if (join) {
        const other = target as PersonSim;
        m.menuInProgress = { items, entry: join.entry };
        const n = items.length;
        if (other.testInteraction(join.target, join.entry, false, false, this.id) && items.length === n && !other.hiddenFromMenu()) {
          items.push({ entry: join.entry, name: join.entry.name, args: new Int16Array([0, 0, this.id, 0]), join: { actor: other, target: join.target, flags: join.flags } });
        }
      }
    } finally {
      m.menuInProgress = null;
    }
    return items;
  }

  /**
   * cXPerson::ForceLocation: the animator snaps to the position, then person
   * data 64 (swimming) is 1 when the person's tile (inside the lot) has pool
   * water (cFixedWorld::HasPool), else 0.
   */
  override forceLocation(): void {
    const me = this.obj;
    this.animator.forceLocation(me);
    this.pd[64] = 0;
    const world = this.module.sim.world;
    if (!world) return;
    const x = ((me.fx >> 4) << 24) >> 24;
    const y = ((me.fy >> 4) << 24) >> 24;
    if (x > 0 && x < world.size - 1 && y > 0 && y < world.size - 1 && world.hasPool(x, y, me.level)) this.pd[64] = 1;
  }

  /**
   * Interaction::Interaction(person, this): joining this person's current
   * action, when its TTAB entry is joinable (flag 2): the action's object (its
   * interaction leader for a multi-tile one) and the entry at that entry's
   * joining index; null when there is none. The interaction keeps the
   * action's flags but 2 and 4.
   */
  joinOffer(): { target: SimObject; entry: TreeTableEntry; flags: number } | null {
    const m = this.module;
    const a = this.currentAction;
    const src = a ? m.getObject(a.target) : null;
    if (!a || !src) return null;
    const cur = m.treeTableOf(src.obj.selector)?.entries.find((x) => x.stringIndex === a.ttabIndex);
    if (!cur || !(cur.flags & 2)) return null;
    const target = src.obj.selector.objd.i16(0x14) !== 0 ? src.getInteractionLeader() : src;
    const entries = m.treeTableOf(target.obj.selector)?.entries ?? [];
    const own = entries.find((x) => x.stringIndex === a.ttabIndex);
    const entry = own ? entries.find((x) => x.stringIndex === own.joiningIndex) : undefined;
    return entry ? { target, entry, flags: a.flags & ~6 } : null;
  }

  /**
   * The tree table entries of menuItemsFor (check trees run with no menu in
   * progress, so they make no items of their own).
   */
  menuFor(target: SimObject): TreeTableEntry[] {
    const g = this.pd[PDX.gender]!;
    if (g & 6 && (target.obj.selector.guid >>> 0) !== 0x7c4) return [];
    const tt = this.module.treeTableOf(target.obj.selector);
    if (!tt) return [];
    const out: TreeTableEntry[] = [];
    for (const e of tt.entries) {
      if (this.testInteraction(target, e, false) && !this.hiddenFromMenu()) out.push(e);
    }
    return out;
  }

  /**
   * TestInteraction's interaction flag 0x10: the check tree left the person's
   * object data 50 non-zero ("hide from the menu"; e.g. the Go Here object's
   * pet commands for a person who is not a pet). AppendInteractionsForMenu
   * only keeps entries with flag 8 (test passed) and without 0x10.
   */
  hiddenFromMenu(): boolean {
    return this.obj.objectData[50] !== 0;
  }

  /**
   * cXPerson::RemoveAction (the user cancels an action icon). The current
   * action: priority (person data 33) drops to 0, the interaction is flagged
   * cancelled (0x100) and, unless something already interrupts, the
   * person's own interaction 0x21 is queued at priority 50 so the next
   * Idle For Input lets go. That interaction is queued without an icon
   * object (Interaction +0xc cleared before AddAction, Windows 0x45d764 /
   * Mac 0x10101da0), so PersonFinder::ConvertAction gives it no action
   * icon: the player only sees the cancelled icon's red cross until the
   * current action ends. A queued one: it leaves the queue and its
   * object's entry point 4 check tree runs.
   */
  removeAction(i: Interaction): boolean {
    if (i === this.currentAction) {
      this.pd[33] = 0;
      i.flags |= 0x100;
      if (!this.shouldInterrupt()) {
        const e = this.module.treeTableOf(this.obj.selector)?.entries.find((x) => x.stringIndex === 0x21);
        if (e) {
          const cancel = this.makeInteraction(this, e, 50);
          cancel.icon = 0;
          this.addAction(cancel);
        }
      }
      this.module.onQueueChanged?.(this);
      return true;
    }
    const k = this.queue.indexOf(i);
    if (k < 0) return false;
    this.queue.splice(k, 1);
    const o = this.module.getObject(i.target);
    const tree = o ? o.fnTable.getTreeID(4) : 0;
    if (o && tree !== 0) {
      try {
        o.runCheckTree(o.behavior, this.id, tree, null);
      } catch {
        // The original ignores the result.
      }
    }
    this.module.onQueueChanged?.(this);
    return true;
  }

  /**
   * cXPerson::ShouldInterrupt: never while person data 71 is set; else the
   * head of the queue has a higher priority than the current one (person
   * data 33) or interaction flag 2; else, on a residential lot for a
   * person with data 32 < 2, a motive emergency (motive 7 or 9 below -99,
   * or motive 5 below -99 when person data 65 <= 1).
   */
  shouldInterrupt(): boolean {
    const pd = this.pd;
    if (pd[71] !== 0) return false;
    const h = this.queue[0];
    let r = h ? h.priority > pd[33]! || (h.flags & 2) !== 0 : false;
    // motive emergencies on a residential lot (threshold lbl_1059A524+0x2c = -99)
    if (!r && this.module.getZoningType(this.module.sim.globals[10]!) === 1 && pd[32]! < 2) {
      const m = this.motives;
      if (m[7]! < -99 || m[9]! < -99 || (m[5]! < -99 && pd[65]! <= 1)) r = true;
    }
    return r;
  }

  /**
   * cXPerson::TryIdleForInput: counts parameter `param` down (true at 0)
   * unless an interaction is waiting; then, when allowed (`interruptible`),
   * the head of the queue is tested and its action tree pushed with the
   * interaction's object as stack object (the frame's state 1 marks it).
   * A failed test drops it (the object's entry point 4 runs).
   */
  protected tryIdleForInput(elem: StackElem, param: number, interruptible: number): number {
    if (param < 0 || param >= elem.numParams) simThrow(XERR.paramRange);
    const at = elem.paramsAt() + param;
    const mem = elem.stack.mem;
    const d = this.obj.objectData;
    if (!this.shouldInterrupt()) {
      if (mem[at] === 0) {
        d[8] = d[8]! & 0xffbf;
        return PRIM_TRUE;
      }
      mem[at] = mem[at]! - 1;
      return PRIM_WAIT;
    }
    d[8] = d[8]! | 0x40;
    if (interruptible === 0 || this.queue.length === 0) return PRIM_TRUE;
    if (elem.state === 1 && !(this.queue[0]!.flags & 2)) return PRIM_TRUE;
    const i = this.queue.shift()!;
    this.module.onQueueChanged?.(this);
    const o = this.module.getObject(i.target);
    if (!o) return PRIM_WAIT;
    // ObjTestSim::TestInteraction (not autonomous): a failed test, a missing action tree or a
    // failed push drops it, and its object's entry point 4 ("queue skipped") check tree runs.
    const e = this.module.treeTableOf(o.obj.selector)?.entries.find((x) => x.stringIndex === i.ttabIndex) ?? null;
    if (!e || !this.testInteraction(o, e, false) || i.actionTree === 0 || !this.gosubObjectTree(o, { src: Array.from(i.args), at: 0 }, i.actionTree)) {
      const skipped = o.fnTable.getTreeID(4);
      if (skipped !== 0) o.runCheckTree(o.behavior, this.id, skipped, null);
      return PRIM_WAIT;
    }
    this.setCurrentAction(i);
    mem[at] = 0;
    elem.state = 1;
    d[8] = d[8]! | 0x40;
    this.module.record(this, "action", `${o.obj.selector.name}: ${i.name}`);
    return PRIM_CONTINUE;
  }
}
