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
import { applyMotiveIncs, calcHappy, motivesSim, type MotiveCurve, type MotiveInc } from "./motives.js";
import type { SimModule } from "./simmodule.js";
import { PRIM_FALSE, PRIM_TRUE, PRIM_WAIT, simThrow, SimError } from "./treesim.js";
import type { ParamSource, StackElem } from "./treestack.js";
import { SimObject, XERR } from "./xobject.js";
import { loadStringSet } from "./behavior.js";
import { PersonAnimator, requestSkill } from "./personanim.js";
import type { Skill } from "../sims/skill.js";
import { PRIM_CONTINUE } from "./treesim.js";
import { buildGoals, dirOf, findPath, Route, type RouteWorld, type RoutingSlot, FACE_ANY, FACE_TOWARDS } from "./routing.js";
import { getWall } from "../world/tilewalls.js";
import type { TreeTableEntry } from "./treetable.js";
import { fc, type FloatConstants } from "./floatconstants.js";

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

export class PersonSim extends SimObject {
  /** cXPerson +0xa80 */
  readonly motiveIncs: MotiveInc[] = [];
  /** cXPerson +0x810: the tick Motives::Sim last ran. */
  lastMotiveTick = 0;
  /** The happiness weight curves (global). */
  happyCurves: readonly MotiveCurve[] = [];
  /** +0x820 queue (head first), +0xa08 current action, +0xa44 last action. */
  readonly queue: Interaction[] = [];
  currentAction: Interaction | null = null;
  lastAction: Interaction | null = null;
  /** cXPerson +0xa8c */
  readonly animator: PersonAnimator;
  /** The route being walked (cXPerson +0xaa0, the top route). */
  route: Route | null = null;
  /** Continuous facing for the renderer (45 degree units), null: object data direction. */
  renderDir: number | null = null;
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
    });
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
   * motive decay every 60 ticks, the motive increments every tick, and the
   * happiness. Room / lighting motive, layout ticks, head text: not ported.
   */
  override simulate(): boolean {
    const r = super.simulate();
    if (r) {
      const tick = this.module.sim.tickCount;
      const m = this.motives;
      if (this.lastMotiveTick + 0x3c <= tick) {
        this.lastMotiveTick = tick;
        if (this.pd[PDX.motivesStatic] === 0 && this.obj.hidden === 0) {
          motivesSim(m, this.pd, this.module.sim.globals[0]!);
          calcHappy(m, this.happyCurves);
        }
      }
      // SAnimator::Tick (vtable +0x58) on every tick the person ran.
      this.animator.tick();
      // Person data 27, "tick counter" (read by the "divide tick counts" tree).
      this.pd[27] = this.pd[27]! + 1;
      applyMotiveIncs(m, this.motiveIncs);
    }
    return r;
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
    this.animator.stop("main");
    this.animator.stop("carry");
    this.animator.stop("background");
    this.queue.length = 0;
    this.currentAction = null;
    this.objectRecords.length = 0;
    this.route = null;
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
        return this.tryChangeSuit(u8(0), u8(1), s16(2));
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
   * table (STR# 0x81 adult / 0x82 child) of the object whose tree runs (or,
   * with flag 4, of the stack object); 1: Global.iff STR# 0x80; 2: the person
   * stock table (Global.iff 0x82); 3: misc (0x9c adult / 0x9d child).
   * Error 0x17 when the object is missing.
   */
  protected resolveSkillName(elem: StackElem, index: number, source: number, flags: number): string | null {
    const m = this.module;
    const g = m.res.glob;
    let table: string[] | null = null;
    if (source === 0) {
      let sel = null;
      if (flags & 4) sel = m.getObject(elem.stackObj)?.obj.selector ?? null;
      else sel = m.selectorOfBehavior(elem.behavior) ?? this.obj.selector;
      if (!sel) simThrow(0x17);
      table = loadStringSet(sel.res, this.isChild ? 0x82 : 0x81);
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
        return PRIM_TRUE;
      }
      const skill = this.loadSkill(elem, anim, source, flags);
      if (skill === undefined) return PRIM_WAIT;
      if (skill) a.start(slot, skill, backwards);
      return PRIM_TRUE;
    }
    if (anim === 0) {
      a.stop("main");
      a.state = this.restState();
      this.pd[0x13] = 0;
      return PRIM_TRUE;
    }
    if (!a.animating) {
      const skill = this.loadSkill(elem, anim, source, flags);
      if (skill === undefined) return PRIM_WAIT;
      a.events.length = 0;
      a.stop("main");
      if (skill) {
        const t = a.start("main", skill, backwards);
        if (t) t.interruptible = (flags & 8) !== 0;
      }
      if (slot === "carry3") a.stop("carry");
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

  /** The animator state after an animation: person data 0 (sitting?) 1 -> 1, 2 -> 2, 0 -> 3. */
  private restState(): number {
    const s = this.pd[PDX.sitting]!;
    if (s === 1) return 1;
    if (s === 2) return 2;
    if (s === 0) return 3;
    return this.animator.state;
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

  // --- routing ---------------------------------------------------------------------

  /** What blocks this person on the lot (objects other than `ignore`, walls; doors let through). */
  private routeWorld(ignore: SimObject | null): RouteWorld | null {
    const fixed = this.module.sim.world;
    if (!fixed) return null;
    const blocked = new Set<number>();
    const doors = new Set<number>();
    const n = fixed.size;
    const ignoreLead = ignore ? (ignore.obj.mtLeadId || ignore.id) : -1;
    for (const o of this.module.list) {
      const x = o.obj;
      if (o === this || x.isPerson || x.hidden !== 0 || x.containerId !== 0) continue;
      if ((x.mtLeadId || o.id) === ignoreLead) continue;
      const k = (x.level * n + x.tileY) * n + x.tileX;
      if (x.kind === "portal") {
        doors.add(k);
        continue;
      }
      if (x.wallPlacementFlags !== 0) continue;
      const f = x.flags;
      if (f & (0x4 | 0x8 | 0x10)) continue;
      blocked.add(k);
    }
    const key = (tx: number, ty: number, level: number): number => (level * n + ty) * n + tx;
    return {
      size: n,
      blocked: (tx, ty, level) => {
        if (tx < 1 || ty < 1 || tx >= n - 1 || ty >= n - 1) return true;
        if (blocked.has(key(tx, ty, level))) return true;
        const segs = fixed.wallStorage(tx, ty, level).segs;
        return (segs & 0x30) !== 0;
      },
      wallBetween: (ax, ay, bx, by, level) => {
        if (doors.has(key(ax, ay, level)) || doors.has(key(bx, by, level))) return false;
        if (bx === ax - 1) return (getWall(fixed, ax, ay, level).segs & 0x01) !== 0 || (getWall(fixed, bx, by, level).segs & 0x04) !== 0;
        if (bx === ax + 1) return (getWall(fixed, bx, by, level).segs & 0x01) !== 0 || (getWall(fixed, ax, ay, level).segs & 0x04) !== 0;
        if (by === ay - 1) return (getWall(fixed, ax, ay, level).segs & 0x02) !== 0 || (getWall(fixed, bx, by, level).segs & 0x08) !== 0;
        if (by === ay + 1) return (getWall(fixed, bx, by, level).segs & 0x02) !== 0 || (getWall(fixed, ax, ay, level).segs & 0x08) !== 0;
        return false;
      },
    };
  }

  /** XRoute + cXPerson::InitRoute (simplified, see routing.ts): null when no goal is reachable. */
  protected startRoute(target: SimObject, slot: RoutingSlot): Route | null {
    const world = this.routeWorld(target);
    if (!world) return null;
    const t = target.obj;
    const goals = buildGoals(slot, t.fx, t.fy, t.dir);
    const me = this.obj;
    const found = findPath(world, me.tileX, me.tileY, me.level, goals);
    if (this.traceOn) {
      this.autonomyLog.push(`  route t${this.module.sim.tickCount} from ${me.tileX},${me.tileY} (${me.fx.toFixed(0)},${me.fy.toFixed(0)}) to ${target.obj.selector.name} ${t.tileX},${t.tileY}: ${goals.length} goals, ${found ? `path ${found.path.length} -> ${found.goal.tx},${found.goal.ty}` : "none"} speed ${this.walkSpeed().toFixed(2)}`);
    }
    if (!found) return null;
    return new Route(found.goal, [me.fx, me.fy], found.path);
  }

  /**
   * cXObject::SetLocation for a walking person: what it carries follows,
   * and (world hooks) its tile link moves with it.
   */
  private setLocation(fx: number, fy: number): void {
    const h = this.module.worldHooks;
    if (h) h.moveTo(this.obj, { fx, fy }, this.obj.level);
    else {
      this.obj.fx = fx;
      this.obj.fy = fy;
    }
  }

  /** The walking speed in 1/16 tile per tick: the walking loop's distance over its duration (3 units per tile). */
  private walkSpeed(): number {
    const name = this.isChild ? "c2o-walking-loop" : "a2o-walking-loop";
    const s = requestSkill(name);
    if (s && s.duration > 0 && s.distance > 0) return (s.distance / 3 / s.duration) * 16 * 42;
    return 1.6;
  }

  /**
   * One tick on the route: walks (the walking loop playing), and on arrival
   * faces the goal's direction and goes back to standing. True when arrived.
   */
  protected followRoute(): boolean {
    const r = this.route;
    if (!r) return true;
    const a = this.animator;
    const walk = this.isChild ? "c2o-walking-loop" : "a2o-walking-loop";
    if (a.mainName !== walk) {
      const s = requestSkill(walk);
      if (s) a.start("main", s, false, true);
    }
    const { pos, dir } = r.step([this.obj.fx, this.obj.fy], this.walkSpeed());
    this.setLocation(pos[0], pos[1]);
    if (dir !== null) {
      this.renderDir = dir;
      this.obj.objectData[1] = Math.round(dir) & 7;
    }
    this.module.dirty(this);
    if (!r.done) return false;
    this.setLocation(r.goal.fx, r.goal.fy);
    if (r.goal.facing >= 0) {
      this.obj.objectData[1] = r.goal.facing;
      this.renderDir = r.goal.facing;
    }
    const stand = requestSkill(this.isChild ? "c2o-standing-loop" : "a2o-standing-loop");
    if (stand) a.start("main", stand, false, true);
    a.mainName = "";
    this.route = null;
    if (this.traceOn) {
      this.autonomyLog.push(`  arrived t${this.module.sim.tickCount} at ${this.obj.tileX},${this.obj.tileY} (${this.obj.fx.toFixed(0)},${this.obj.fy.toFixed(0)})`);
      this.watch = Math.max(this.watch, 120);
      this.watchFull = 120;
    }
    return true;
  }

  /**
   * cXPerson::TryGotoRoutingSlot: operands slot (parameter index when the
   * type is 0, else the slot number), type (0 parameter, 1 literal, 2 global
   * slot: not ported), flags (bit 0 clear: allow failure trees). Waits while
   * walking; true on arrival, false when no route (error 0x34 without a
   * stack object, 0x25 bad slot).
   */
  protected tryGotoRoutingSlot(elem: StackElem, slotArg: number, type: number, flags: number): number {
    if (elem.state !== 0 && this.route) return this.followRoute() ? PRIM_TRUE : PRIM_WAIT;
    const target = this.module.getObject(elem.stackObj);
    if (!target) simThrow(0x34);
    if (target.obj.hidden !== 0) return PRIM_FALSE;
    let index = slotArg;
    if (type === 0) {
      if (slotArg < 0 || slotArg >= elem.numParams) simThrow(XERR.paramRange);
      index = elem.getParam(slotArg);
    } else if (type !== 1 && type !== 2) {
      simThrow(0x25);
    }
    // Type 2: the global routing slots (ObjectModule +0xa0, Global.iff SLOT 100).
    const slots = type === 2 ? this.module.globalRoutingSlots() : this.module.routingSlotsOf(target.obj.selector);
    const slot = slots[index];
    if (!slot) simThrow(0x25);
    void flags;
    this.route = this.startRoute(target, slot);
    if (!this.route) return PRIM_FALSE;
    elem.state = 1;
    return this.followRoute() ? PRIM_TRUE : PRIM_WAIT;
  }

  /**
   * cXPerson::TryGotoRelative: a routing slot made on the fly, 1 tile from
   * the stack object. Location (byte 2): 0..7 a direction relative to the
   * object, others the four sides; direction (byte 3): -1 any facing, -2
   * towards the object, 0..7 a direction.
   */
  protected tryGotoRelative(elem: StackElem, location: number, direction: number, flags: number): number {
    if (elem.state !== 0 && this.route) return this.followRoute() ? PRIM_TRUE : PRIM_WAIT;
    const target = this.module.getObject(elem.stackObj);
    if (!target) simThrow(XERR.noStackObject);
    const dirs = location >= 0 && location < 8 ? 1 << location : 0x55;
    const facing = direction === -1 ? FACE_ANY : direction === -2 ? FACE_TOWARDS : direction >= 0 && direction < 8 ? direction : FACE_TOWARDS;
    void flags;
    const slot: RoutingSlot = { x: 0, y: 0, minProximity: 16, maxProximity: 16, optimalProximity: 16, flags: dirs, facing, snapTarget: -1 };
    this.route = this.startRoute(target, slot);
    if (!this.route) return PRIM_FALSE;
    elem.state = 1;
    return this.followRoute() ? PRIM_TRUE : PRIM_WAIT;
  }

  /**
   * cXPerson::TryLookTowards: 0 turns the head (true); 1 turns around; 2 / 3
   * face towards / away from the stack object. The turning walk
   * (BeginFollow) is replaced by an immediate turn. Error 0x27 otherwise.
   */
  protected tryLookTowards(elem: StackElem, mode: number): number {
    if (mode === 0) return PRIM_TRUE;
    if (mode === 1) {
      const d = (this.obj.dir + 4) & 7;
      this.obj.objectData[1] = d;
      this.renderDir = d;
      this.module.dirty(this);
      return PRIM_TRUE;
    }
    if (mode === 2 || mode === 3) {
      if (this.pd[PDX.sitting] !== 0) return PRIM_FALSE;
      const o = this.module.getObject(elem.stackObj);
      if (!o) simThrow(XERR.noStackObject);
      let d = dirOf(o.obj.fx - this.obj.fx, o.obj.fy - this.obj.fy);
      if (mode === 3) d = (d + 4) & 7;
      this.obj.objectData[1] = d;
      this.renderDir = d;
      this.module.dirty(this);
      return PRIM_TRUE;
    }
    simThrow(0x27);
  }

  /** cXPerson::TryChangeSuit: recorded (the outfit change is not applied to the 3D model yet). */
  protected tryChangeSuit(scope: number, kind: number, data: number): number {
    this.module.record(this, "changeSuit", `${scope}:${kind}:${data}`);
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
   * person (visitor flag 1, children 0x10, adults-only 0x40, pets 0x200 /
   * 0x400), the object's lockout count, then its check tree run on the person
   * with the object as stack object (parameter 0 = 1: autonomous). The
   * person's temps are restored afterwards.
   */
  testInteraction(target: SimObject, e: TreeTableEntry, auto: boolean, wantAds = false): boolean {
    const pd = this.pd;
    const visitor = pd[PDX.personType] !== 0;
    if (target.obj.objectData[8]! & 0x200) return false;
    if (auto && target.obj.objectData[25]! >= 1) return false;
    if (!(e.flags & 1) && visitor && this.module.getZoningType(this.module.sim.globals[10]!) === 1) return false;
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
    const r = this.runTestTree(target, e, auto);
    // another room (object data 29): the room advertisement's delta is -min
    if (wantAds && target.obj.objectData[29] !== this.obj.objectData[29]) {
      const a13 = this.module.sim.currentAd[13];
      if (a13) a13[2] = -a13[1]!;
    }
    return r;
  }

  /** The check tree part of ObjTestSim::TestInteraction. */
  private runTestTree(target: SimObject, e: TreeTableEntry, auto: boolean): boolean {
    if (e.checkTree === 0) return true;
    // ObjTestSim runs the check tree on its own stack: an error there only
    // fails the test. Here it runs above the person's stack, unwound on error.
    const saved = new Int16Array(this.temps.subarray(0, 8));
    const depth = this.getStackSize();
    try {
      return this.runCheckTree(target.behavior, target.id, e.checkTree, { src: [auto ? 1 : 0, 0, 0, 0], at: 0 });
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
   * best "random selection count" (minus logic / 2000): the stack object becomes the object and object data 20 the entry.
   */
  protected tryFindBestAction(elem: StackElem): number {
    const m = this.module;
    const cur = this.currentScore();
    const k = m.autonomy;
    const visitor = this.pd[PDX.personType] !== 0;
    const minScore = visitor ? k.minVisitors : k.minFamily;
    const scored: Array<{ o: SimObject; e: TreeTableEntry; score: number }> = [];
    const autonomy = this.pd[0x24]!;
    for (const o of m.list) {
      if (o.obj.selector.objd.i16(0xe) === 0) continue;
      if (!(m.getSimFlags(o.id) & 0x80000)) continue;
      if (o === this || o.obj.hidden !== 0) continue;
      if (o.obj.objectData[25]! >= 1) continue;
      const tt = m.treeTableOf(o.obj.selector);
      if (!tt) continue;
      const dist = this.distanceTo(o);
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
    }
    scored.sort((a, b) => b.score - a.score);
    this.lastScores = scored.slice(0, 10).map((x) => ({ object: x.o.id, name: `${x.o.obj.selector.name}: ${x.e.name}`, score: x.score }));
    if (this.traceOn) {
      this.autonomyLog.push(`t${m.sim.tickCount} cur ${cur.toFixed(2)} n=${scored.length} ${this.lastScores.slice(0, 4).map((x) => `${x.name}=${x.score.toFixed(3)}`).join(", ")}`);
      if (this.autonomyLog.length > 5000) this.autonomyLog.shift();
    }
    if (!scored.length) return PRIM_FALSE;
    const n = Math.max(1, Math.trunc(k.randomCount - this.pd[0x12]! / 2000));
    const pick = scored.length < n ? m.sim.random() % scored.length : m.sim.random() % n;
    const best = scored[pick]!;
    if (this.pd[PDX.sitting] !== 0 && best.score < k.minSitting) return PRIM_FALSE;
    this.obj.objectData[20] = best.e.stringIndex;
    elem.stackObj = best.o.id;
    return PRIM_TRUE;
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
  makeInteraction(o: SimObject, e: TreeTableEntry, priority: number): Interaction {
    return {
      target: o.id,
      actionTree: e.actionTree,
      checkTree: e.checkTree,
      ttabIndex: e.stringIndex,
      icon: o.id,
      args: new Int16Array(4),
      flags: e.flags & 0x100 ? 1 : 0,
      priority,
      name: e.name,
    };
  }

  /**
   * cXPerson::SetCurrentAction: the current action becomes the last one;
   * person data 33 ("Priority") takes the new priority and the motive
   * increments are cleared.
   */
  setCurrentAction(i: Interaction | null): void {
    if (this.currentAction) this.lastAction = this.currentAction;
    this.currentAction = i;
    this.pd[33] = i ? i.priority : 0;
    this.motiveIncs.length = 0;
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
      const cur = this.getCurElem();
      if (err instanceof SimError) this.errors.push({ code: err.code, tree: cur?.getTreeID() ?? -1, node: cur?.node ?? -1 });
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
   * (TTAB flag 0x80) are left out. Pets only get menus from GUID 0x7c4.
   */
  menuFor(target: SimObject): TreeTableEntry[] {
    const g = this.pd[PDX.gender]!;
    if (g & 6 && (target.obj.selector.guid >>> 0) !== 0x7c4) return [];
    const tt = this.module.treeTableOf(target.obj.selector);
    if (!tt) return [];
    const out: TreeTableEntry[] = [];
    for (const e of tt.entries) {
      if (e.flags & 0x80) continue;
      if (this.testInteraction(target, e, false)) out.push(e);
    }
    return out;
  }

  /**
   * cXPerson::RemoveAction (the user cancels an action icon). The current
   * action: priority (person data 33) drops to 0, the interaction is flagged
   * cancelled (0x100) and, unless something already interrupts, the
   * person's own interaction 0x21 is queued at priority 50 so the next
   * Idle For Input lets go. A queued one: it leaves the queue and its
   * object's entry point 4 check tree runs.
   */
  removeAction(i: Interaction): boolean {
    if (i === this.currentAction) {
      this.pd[33] = 0;
      i.flags |= 0x100;
      if (!this.shouldInterrupt()) {
        const e = this.module.treeTableOf(this.obj.selector)?.entries.find((x) => x.stringIndex === 0x21);
        if (e) this.addAction(this.makeInteraction(this, e, 50));
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
   * A failed test drops it (the object's entry point 4 is not run).
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
    // ObjTestSim::TestInteraction (not autonomous): a failed test drops it.
    const e = this.module.treeTableOf(o.obj.selector)?.entries.find((x) => x.stringIndex === i.ttabIndex) ?? null;
    if (!e || !this.testInteraction(o, e, false) || i.actionTree === 0) return PRIM_WAIT;
    if (!this.gosubObjectTree(o, { src: Array.from(i.args), at: 0 }, i.actionTree)) return PRIM_WAIT;
    this.setCurrentAction(i);
    mem[at] = 0;
    elem.state = 1;
    d[8] = d[8]! | 0x40;
    this.module.record(this, "action", `${o.obj.selector.name}: ${i.name}`);
    return PRIM_CONTINUE;
  }
}
