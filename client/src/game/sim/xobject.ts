/**
 * The simulation half of cXObject (ObjectSim.cpp): an XObject loaded by
 * ObjectModule (world/objects.ts) driven by the TreeSim interpreter.
 *
 * cXObject fields used here (byte offsets of the original):
 *   +0x2c / +0x30 attributes        +0x34 / +0x38 dynamic sprite flags
 *   +0x3a temps[8] (the default parameters, TreeSim +0x20)
 *   +0x4a object data[0x48]         +0x60 object data 11 = own id
 *   +0x7c object data 25: ticks during which the object is kept awake
 *   +0xdc ObjectModule              +0xf0 object id
 *   +0x114 flags (0x100 = error pending, 0x40 / 2 ...)
 *   +0x118 ObjDefinition            +0x11c ObjSelector (+0xc its Behavior)
 *   +0x128 / +0x12c where InterpValue stores the address of the value it
 *          read (short / float motive) when asked to (`outRef` / `outFRef`)
 *   +0x148 SpriteSlots (+0x14c count, +0x150 data)
 *
 * TryElement dispatches primitives 0..0x33 through lbl_10601898 (52 entries;
 * the person-only ones are entries that throw error 5 here and are handled
 * by cXPerson::TryElement first).
 */

import { OD as WOD, type XObject } from "../world/objects.js";
import { OBJ_TYPE_PERSON, type ObjSelector } from "../world/objselector.js";
import type { Neighbor } from "../data/neighborhood.js";
import type { BehaviorTree } from "./behavior.js";
import { getTreeClass, getBaseID, loadStringSet, loadUIStringSet } from "./behavior.js";
import { EP, ObjFnTable } from "./objfntable.js";
import type { SimModule } from "./simmodule.js";
import { PRIM_CONTINUE, PRIM_FALSE, PRIM_TRUE, PRIM_WAIT, TreeSim, simThrow, treeSimGlobals } from "./treesim.js";
import type { ParamSource, StackElem } from "./treestack.js";
import { DIR_VEC, rotateOffset } from "./routing.js";
import { getBehCareerData, offerDialogText, simJobName, type SimCareer } from "./careers.js";
import { addToken, findToken, removeAllTokensOfType, removeToken, removeTokenByIndex, setToNextToken } from "./inventory.js";

/** Object data indexes (Behavior.iff STR# 141; index = (offset - 0x4a) / 2). */
const OD = {
  ...WOD,
  /** +0x60: the object's own id (set by Reset). */
  objectId: 11,
  /** +0x74 / +0x7a: birth minute / hour. */
  birthMinute: 21,
  birthHour: 24,
  /** +0x7c: ticks during which the object is kept awake (cXObject::Simulate counts it down). */
  keepAwake: 25,
  /** +0x84: room impact (-5: no room score). */
  roomImpact: 29,
  /** +0xa4 / +0xa6 / +0xa8: birth year / month / day. */
  birthYear: 45,
  birthMonth: 46,
  birthDay: 47,
  /** +0xbe: the OBJD's +0x62 (type attribute GUID). */
  typeAttrGuid: 58,
  /** +0xc0: compared with parameter 0 by Set To Next (search type 6). */
  category: 59,
  /** +0xc2: non-zero ticks while paused (sim flag 2). */
  tickWhenPaused: 60,
  /** +0xc6: cleared by Cleanup. */
  cleanupFlags: 62,
} as const;

/** A writable short InterpValue resolved (+0x128). */
export interface ShortRef {
  a: Int16Array;
  i: number;
}
/** A writable float (motives, +0x12c). */
export interface FloatRef {
  a: Float32Array;
  i: number;
}

/** cXObject error codes (thrown with lbl_105BBB08). */
export const XERR = {
  unknownPrimitive: 5,
  attrRange: 6,
  objectDataRange: 7,
  paramRange: 8,
  badScope: 9,
  noObject: 0xa,
  flagRange: 0xd,
  stackObjIdData: 0xf,
  cantWrite: 0x13,
  noStackObject: 0x15,
  noTestObject: 0x17,
  motiveRange: 0x1a,
  slotRange: 0x1b,
  notPerson: 0x1c,
  personDataRange: 0x21,
  definitionRange: 0x23,
  divideByZero: 0x26,
  tempRange: 2,
  randomZero: 4,
  constants: 0x2e,
  expenseType: 0x38,
  neighbor: 0x37,
  globalRange: 0x3f,
  typeAttrRange: 0x40,
  breakpoint: 0x3e,
  setToNextType: 0x1e,
  namedTreeMode: 0x2c,
  sprite: 0x31,
} as const;

/** Expression operators that write their left operand (lbl_1059A48C). */
const OP_WRITES = [0, 0, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 1] as const;

/** Motive values are clamped to [-100, 100] after a write (lbl_1059A4A8 +0x20 / +0x24). */
const MOTIVE_MIN = -100;
const MOTIVE_MAX = 100;

/** What a primitive the port does not implement does instead (documented per primitive). */
export interface PrimitiveLog {
  /** opcode -> runs */
  counts: Map<number, number>;
}

/** Person data read by ParseUIString (cXPerson +0x5fc / +0x5fe / +0x60e): job type, job level, gender. */
const PD_JOB_TYPE = 0x38;
const PD_JOB_LEVEL = 0x39;
const PD_GENDER = 0x41;
/** cXPerson +0x5ca: neighbor id. */
const PD_NEIGHBOR_ID = 0x1f;

/** Dynamic-cast helper for cXPerson fields this phase keeps on the object. */
export interface PersonSimData {
  /** cXPerson +0x58c: person data[0x100]. */
  personData: Int16Array;
  /** cXPerson +0x78c: motives[16]. */
  motives: Float32Array;
}

export class SimObject extends TreeSim {
  /** cXObject +0x114 bit 0x100 (Error sets it, HandleError clears it). */
  errorPending = false;
  /** Primitive opcode -> times run (trace). */
  readonly primCounts = new Map<number, number>();
  /** Errors caught on this object (code, tree, node). */
  readonly errors: Array<{ code: number; tree: number; node: number }> = [];
  /** InterpValue outputs (+0x128 / +0x12c). */
  outRef: ShortRef | null = null;
  outFRef: FloatRef | null = null;
  /** Person data / motives (cXPerson only). */
  person: PersonSimData | null = null;
  /** Removed by ObjectModule::KillObject (the kill queue ran). */
  killed = false;
  protected readonly temps: Int16Array;

  constructor(
    readonly obj: XObject,
    readonly module: SimModule,
  ) {
    super();
    // TreeSim::Initialize(stack size, +0x3a): temps are followed by the object data (+0x4a).
    this.temps = new Int16Array(obj.temps.buffer, obj.temps.byteOffset, 8 + 0x48);
    if (obj.isPerson) this.person = { personData: new Int16Array(0x100), motives: new Float32Array(16) };
  }

  get id(): number {
    return this.obj.objectId;
  }
  get isPerson(): boolean {
    return this.obj.selector.objd.objectType === OBJ_TYPE_PERSON;
  }
  get behavior() {
    return this.module.behaviorOf(this.obj.selector);
  }
  get fnTable(): ObjFnTable {
    return ObjFnTable.forSelector(this.obj.selector);
  }

  protected defaultParams(): ParamSource {
    return { src: this.temps, at: 0 };
  }

  /** cXObject::Error: flags the object; TickAllObjects handles it on the next pass. */
  error(code: number): void {
    const e = this.getCurElem();
    this.errors.push({ code, tree: e?.getTreeID() ?? -1, node: e?.node ?? -1 });
    this.errorPending = true;
    this.module.setSimFlag(this.id, 4, true);
  }

  /** cXObject::Simulate: one tick of the main stack, then the keep-awake counter and sprite slots. */
  simulate(): boolean {
    const r = this.simulateTrees();
    if (r) {
      const d = this.obj.objectData;
      if (d[OD.keepAwake]! !== 0) d[OD.keepAwake] = d[OD.keepAwake]! - 1;
      for (const s of this.obj.spriteSlots) {
        // SpriteSlot::Tick counts down an active slot; a change dirties the object.
        if (s.activeTicks > 0) {
          s.activeTicks--;
          this.module.dirty(this);
        }
      }
    }
    return r;
  }

  /**
   * cXObject::HandleError (retail: no dialog): ObjectModule::CleanupPeople
   * then Cleanup.
   */
  handleError(): void {
    this.errorPending = false;
    if (this.getError() === 0) return;
    this.module.cleanupPeople(this);
    this.cleanup();
  }

  /**
   * Cleanup (vtable +0x40) called with another object, as
   * ObjectModule::CleanupPeople does on people: cXPerson::Cleanup(obj)
   * (not ported; PersonSim overrides this). Objects never get it.
   */
  cleanupFor(_obj: SimObject): void {}

  /**
   * cXObject::Cleanup(0): runs the cleanup entry point and restarts Main, or
   * (no cleanup tree) Pickup + Reset + Place. Pickup / Place keep the object
   * where it is here (placement is not simulated): only Reset runs.
   */
  cleanup(): void {
    const fns = this.fnTable;
    const cleanupTree = fns.getTreeID(EP.cleanup);
    if (cleanupTree === 0) {
      this.reset(true);
    } else {
      this.runCheckTree(this.behavior, 0, cleanupTree, null);
      this.obj.objectData[OD.cleanupFlags] = 0;
      this.obj.objectData[OD.flags] = this.obj.objectData[OD.flags]! & 0xffdf;
      this.resetTree(this.behavior, fns.getTreeID(EP.main));
    }
    this.module.setIdleCounter(this.id, 0xffff);
  }

  /**
   * cXObject::Reset: clears object data (keeping direction, current value,
   * the age fields, and a few others), attributes and temps, restarts Main,
   * then (single-tile objects) runs Init and, when asked, one tick.
   * Multi-tile objects (cXMTObject::Reset, also portals): a part resets the
   * whole object through its lead, which resets every part's data first and
   * then runs each part's Init. The slot hierarchy is left as is.
   */
  reset(tick: boolean): void {
    if (this.obj.selector.objd.masterId === 0) {
      this.resetData();
      this.finishReset(tick);
      return;
    }
    const leadId = this.obj.mtLeadId !== 0 ? this.obj.mtLeadId : this.id;
    const lead = this.module.getObject(leadId);
    if (lead && lead !== this) {
      lead.reset(tick);
      return;
    }
    const parts = this.module.list.filter((x) => x === this || (x.obj.mtLeadId === this.id && x.id !== this.id));
    for (const x of parts) x.resetData();
    for (const x of parts) x.finishReset(tick);
  }

  /** One multi-tile part alone: its data reset and its Init (a part created at run time). */
  resetPart(tick: boolean): void {
    this.resetData();
    this.finishReset(tick);
  }

  /** cXObject::Reset's Init tree, optional tick and sim flags 2 / 8. */
  private finishReset(tick: boolean): void {
    const d = this.obj.objectData;
    const init = this.fnTable.getTreeID(EP.init);
    if (init !== 0) this.runCheckTree(this.behavior, 0, init, null);
    if (tick) this.simulate();
    this.module.setSimFlag(this.id, 2, d[OD.tickWhenPaused]! !== 0);
    this.module.setSimFlag(this.id, 8, true);
  }

  /** cXObject::Reset's data part. */
  private resetData(): void {
    const d = this.obj.objectData;
    const keep = new Int16Array(d);
    d.fill(0);
    const k = (i: number): void => {
      d[i] = keep[i]!;
    };
    k(OD.roomImpact);
    let dir = keep[OD.direction]!;
    while (dir < 0) dir += 8;
    d[OD.direction] = dir & 7;
    k(OD.currentValue);
    k(OD.birthYear);
    k(OD.birthMonth);
    k(OD.birthDay);
    k(OD.birthHour);
    k(OD.birthMinute);
    k(OD.slotCount);
    k(OD.containerId);
    k(OD.slotNumber);
    // HierSetSite restores the slot hierarchy site (parent object).
    k(WOD.parentId);
    d[OD.objectId] = this.id;
    d[OD.typeAttrGuid] = this.obj.selector.objd.i16(0x62);
    this.obj.attributes.fill(0);
    this.obj.temps.fill(0);
    this.resetTree(this.behavior, this.fnTable.getTreeID(EP.main));
    this.module.ageFields(this);
    this.module.setIdleCounter(this.id, 0xffff);
  }

  /** cXObject::GosubObjectTree: pushes a tree of `other` (stack object = other) on this stack. */
  gosubObjectTree(other: SimObject, params: ParamSource | null, treeId: number): boolean {
    this.module.clearIdleStatus(this.id);
    if (!this.gosub(other.behavior, params, treeId)) return false;
    this.getCurElem()!.stackObj = other.id;
    return true;
  }

  // --- InterpValue / Expression --------------------------------------------------

  protected obj_(id: number): SimObject | null {
    return this.module.getObject(id);
  }

  /** The current frame's stack object (error 0xa / 0x15 when missing). */
  protected stackObject(code: number = XERR.noObject): SimObject {
    const o = this.obj_(this.getCurElem()!.stackObj);
    if (!o) simThrow(code);
    return o;
  }

  protected personOf(o: SimObject): PersonSimData {
    if (o.obj.selector.objd.objectType !== OBJ_TYPE_PERSON || !o.person) simThrow(XERR.notPerson);
    return o.person;
  }

  /** cXPerson::GetMotive read as InterpValue does (rounded half away from zero). */
  protected motiveValue(p: PersonSimData, i: number, want: boolean): number {
    const f = p.motives[i]!;
    if (want) this.outFRef = { a: p.motives, i };
    return f < 0 ? Math.trunc(f - 0.5) : Math.trunc(f + 0.5);
  }

  protected short(a: Int16Array, i: number, want: boolean): number {
    if (want) this.outRef = { a, i };
    return a[i]!;
  }

  /**
   * cXObject::InterpValue(scope, data, wantAddress): the value of a variable
   * reference; when `want`, also where it lives (`outRef` / `outFRef`) so the
   * caller can write it. Scopes are Behavior.iff STR# 202.
   */
  interpValue(scope: number, data: number, want: boolean): number {
    const m = this.module;
    switch (scope) {
      case 0: // my attributes
        if (data < 0 || data >= this.obj.attributes.length) simThrow(XERR.attrRange);
        return this.short(this.obj.attributes, data, want);
      case 1: {
        // stack object's attributes
        const o = this.stackObject();
        if (data < 0 || data >= o.obj.attributes.length) simThrow(XERR.attrRange);
        return this.short(o.obj.attributes, data, want);
      }
      case 3: // my object data
        if (data < 0 || data >= 0x48) simThrow(XERR.objectDataRange);
        {
          const v = this.short(this.obj.objectData, data, want);
          if (data === OD.keepAwake) m.clearIdleStatus(this.id);
          return v;
        }
      case 4: {
        // stack object's object data
        if (data < 0 || data >= 0x48) simThrow(XERR.objectDataRange);
        const o = this.stackObject();
        const v = this.short(o.obj.objectData, data, want);
        if (data === OD.keepAwake) m.clearIdleStatus(o.id);
        return v;
      }
      case 6: // global (only 0x22 and 0x24 are writable)
        if (data < 0 || data >= 0x40) simThrow(XERR.globalRange);
        if (want && (data === 0x22 || data === 0x24)) this.outRef = { a: m.sim.globals, i: data };
        return m.sim.globals[data & 0xff]!;
      case 7: // literal
        return data;
      case 8: // temps
        if (data < 0 || data >= 8) simThrow(XERR.tempRange);
        return this.short(this.obj.temps, data, want);
      case 9: {
        // parameters
        const e = this.getCurElem()!;
        if (data < 0 || data >= e.numParams) simThrow(XERR.paramRange);
        return this.short(e.stack.mem, e.paramsAt() + data, want);
      }
      case 10: {
        // stack object id (data must be 0)
        if (data !== 0) simThrow(XERR.stackObjIdData);
        const e = this.getNthElem(this.getStackSize() - 1 - data)!;
        if (want) this.outRef = { a: e.stack.mem, i: e.at + 2 };
        return e.stackObj;
      }
      case 11: {
        // temp[temp]
        if (data < 0 || data >= 8) simThrow(XERR.tempRange);
        const i = this.obj.temps[data]!;
        if (i < 0 || i >= 8) simThrow(XERR.tempRange);
        return this.short(this.obj.temps, i, want);
      }
      case 12: // check tree ad range
      case 28: // check tree ad personality var
      case 29: {
        // check tree ad min
        const ad = m.sim.currentAd;
        if (data < 0 || data >= ad.length) simThrow(XERR.motiveRange);
        const e = ad[data]!;
        const field = scope === 12 ? 2 : scope === 28 ? 0 : 1;
        if (want) this.outRef = { a: e, i: field };
        return e[field]!;
      }
      case 13: {
        // stack object's temps
        const o = this.stackObject();
        if (data < 0 || data >= 8) simThrow(XERR.tempRange);
        return this.short(o.obj.temps, data, want);
      }
      case 14: // my motives
        if (data < 0 || data >= 16) simThrow(XERR.motiveRange);
        return this.motiveValue(this.personOf(this), data, want);
      case 15: {
        // stack object's motives
        if (data < 0 || data >= 16) simThrow(XERR.motiveRange);
        return this.motiveValue(this.personOf(this.stackObject(XERR.noStackObject)), data, want);
      }
      case 16: {
        // stack object's slot (contained object id)
        const o = this.stackObject(XERR.noStackObject);
        return this.slotValue(o, data);
      }
      case 17: {
        // stack object's motive[temp]
        if (data < 0 || data >= 8) simThrow(XERR.tempRange);
        const i = this.obj.temps[data]!;
        if (i < 0 || i >= 16) simThrow(XERR.motiveRange);
        return this.motiveValue(this.personOf(this.stackObject(XERR.noStackObject)), i, want);
      }
      case 18: // my person data
        this.personOf(this);
        if (data < 0 || data >= 0x100) simThrow(XERR.personDataRange);
        return this.personData(this, data, want);
      case 19: {
        // stack object's person data
        if (data < 0 || data >= 0x100) simThrow(XERR.personDataRange);
        const o = this.stackObject(XERR.noStackObject);
        this.personOf(o);
        return this.personData(o, data, want);
      }
      case 20: // my slot
        return this.slotValue(this, data);
      case 21: {
        // stack object's definition
        if (data < 0 || data >= 0x6c) simThrow(XERR.definitionRange);
        return this.stackObject().obj.selector.objd.i16(data * 2);
      }
      case 22: {
        // stack object's attribute[param]
        const e = this.getCurElem()!;
        if (data < 0 || data >= e.numParams) simThrow(XERR.paramRange);
        const i = e.getParam(data);
        const o = this.stackObject();
        if (i >= o.obj.attributes.length) simThrow(XERR.attrRange);
        if (i < 0) return 0;
        return this.short(o.obj.attributes, i, want);
      }
      case 23: // room[temp 0]: rooms are not simulated yet.
        return m.unportedValue("scope 23 room[temp0]", 0);
      case 24: // neighbor in stack object: Neighborhood::GetNeighborData(stack object, data)
        return m.neighborData(this.getCurElem()!.stackObj, data);
      case 25: {
        // locals
        const e = this.getCurElem()!;
        if (data < 0 || data >= e.numLocals) simThrow(XERR.paramRange);
        return this.short(e.stack.mem, e.localsAt() + data, want);
      }
      case 26: {
        // tuning constant: XObjLang::GetConstantsID
        const cls = (data >> 13) & 7;
        if (cls > 2) simThrow(XERR.constants);
        const base = cls === 1 ? 0x2000 : cls === 0 ? 0x1000 : 0x100;
        const id = base + ((data >> 7) & 0x3f);
        const index = data & 0x7f;
        const k = this.getCurElem()!.behavior?.getConstants(id) ?? null;
        if (!k) simThrow(XERR.constants);
        if (index >= (k[0]! & 0x7fff) || index >= k.length - 1) simThrow(XERR.constants);
        return k[index + 1]!;
      }
      case 27: {
        // stack object's dynamic sprite flag[temp]
        if (data < 0 || data >= 8) simThrow(XERR.tempRange);
        const o = this.stackObject();
        const i = this.obj.temps[data]!;
        if (i < 0 || i >= o.obj.spriteVisibility.length) simThrow(XERR.sprite);
        return this.short(o.obj.spriteVisibility, i, want);
      }
      case 30: {
        // my person data[temp]
        this.personOf(this);
        if (data < 0 || data >= 8) simThrow(XERR.tempRange);
        const i = this.obj.temps[data]!;
        if (i < 0 || i >= 0x100) simThrow(XERR.personDataRange);
        return this.personData(this, i, want);
      }
      case 31: {
        // stack object's person data[temp]
        const o = this.stackObject(XERR.noStackObject);
        this.personOf(o);
        if (data < 0 || data >= 8) simThrow(XERR.tempRange);
        const i = this.obj.temps[data]!;
        if (i < 0 || i >= 0x100) simThrow(XERR.personDataRange);
        return this.personData(o, i, want);
      }
      case 32: // neighbor's person data
        return m.neighborPersonData(this.getCurElem()!.stackObj, data);
      case 33: {
        // job data: cCareer::GetBehCareerData of career temp 0 (error 0x39 when
        // none), job level temp 1 (0 for career -1), field `data` (error 0x3a)
        const career = m.careers.find((c) => c.id === this.obj.temps[0]!);
        if (!career) simThrow(0x39);
        const level = career.id === -1 ? 0 : this.obj.temps[1]!;
        const v = getBehCareerData(career, level, data);
        if (v === null) simThrow(0x3a);
        return (v << 16) >> 16;
      }
      case 34: // neighborhood data (Neighborhood +0x128, read only)
        if (data <= 0 || data >= 0x10) simThrow(0x3c);
        return m.nbhd?.data[data] ?? 0;
      case 35: {
        // stack object's function: does it have this entry point?
        const o = this.stackObject();
        return o.fnTable.getTreeID(data) !== 0 ? 1 : 0;
      }
      case 36: // my type attributes
        return this.typeAttribute(this, data, want);
      case 37: {
        // stack object's type attributes (error 0xa without a stack object)
        const o = m.getObject(this.getCurElem()!.stackObj);
        if (!o) simThrow(0xa);
        return this.typeAttribute(o, data, want);
      }
      case 38: // definition of the neighbor in the stack object
        return m.unportedValue("scope 38 neighbor definition", 0);
      default:
        m.unportedValue(`bad scope ${scope} (error 9)`, 0);
        simThrow(XERR.badScope);
    }
  }

  /** ObjSelector::GetTypeAttributes()[data]; out of [0, CountTypeAttributes) is error 0x40. */
  protected typeAttribute(o: SimObject, data: number, want: boolean): number {
    const block = this.module.typeAttributes(o.obj.selector);
    if (!block || data < 0 || data >= block.length) simThrow(XERR.typeAttrRange);
    if (want) this.outRef = { a: block, i: data };
    return block[data]!;
  }

  /** ObjectSlot +0x10 of slot `data` (slot 0 is the tile link, so data + 1). */
  protected slotValue(o: SimObject, data: number): number {
    const s = data >= 0 && data < o.obj.objectSlots.length - 1 ? o.obj.objectSlots[data + 1] : undefined;
    if (!s) simThrow(XERR.slotRange);
    return s.containedId;
  }

  /** cXPerson +0x58c[data]; writes mark CPState dirty in the original (person panels). */
  protected personData(o: SimObject, data: number, want: boolean): number {
    const p = o.person!;
    if (want) this.outRef = { a: p.personData, i: data };
    return p.personData[data]!;
  }

  /** cXObject::TryExpression. */
  tryExpression(t: BehaviorTree, off: number): number {
    const v = t.view;
    const lhsData = v.getInt16(off + 4, true);
    const rhsData = v.getInt16(off + 6, true);
    const op = (t.bytes[off + 9]! << 24) >> 24;
    const lhsScope = (t.bytes[off + 10]! << 24) >> 24;
    const rhsScope = (t.bytes[off + 11]! << 24) >> 24;
    const writes = OP_WRITES[op] === 1;
    // A tree fix-up the original applies: local 3 out of [0, 5000] before "my motives" ops on 5000.
    if (lhsData === 3 && rhsData === 5000 && op === 0xe) {
      const e = this.getCurElem()!;
      const l = e.getLocal(3);
      if (l < 0 || l > 5000) e.stack.mem[e.localsAt() + 3] = 0;
    }
    const rhs = this.interpValue(rhsScope, rhsData, false);
    this.outRef = null;
    this.outFRef = null;
    let lhs = this.interpValue(lhsScope, lhsData, writes);
    const ref = this.outRef as ShortRef | null;
    const fref = this.outFRef as FloatRef | null;
    this.outRef = null;
    this.outFRef = null;
    if (op < 0 || op > 0x14) simThrow(1);
    const noRef: () => never = () => simThrow(XERR.cantWrite);
    const arith = (fi: (a: number) => number, ff: (a: number) => number): void => {
      if (ref) ref.a[ref.i] = fi(ref.a[ref.i]!);
      else if (fref) fref.a[fref.i] = ff(fref.a[fref.i]!);
      else noRef();
    };
    let result: number;
    switch (op) {
      case 0:
        result = lhs > rhs ? 1 : 0;
        break;
      case 1:
        result = lhs < rhs ? 1 : 0;
        break;
      case 2:
        result = lhs === rhs ? 1 : 0;
        break;
      case 3:
        arith((a) => a + rhs, (a) => a + rhs);
        result = 1;
        break;
      case 4:
        arith((a) => a - rhs, (a) => a - rhs);
        result = 1;
        break;
      case 5:
        arith(() => rhs, () => rhs);
        result = 1;
        break;
      case 6:
        arith((a) => Math.imul(a, rhs), (a) => a * rhs);
        result = 1;
        break;
      case 7:
        if (rhs === 0) simThrow(XERR.divideByZero);
        arith((a) => Math.trunc(a / rhs), (a) => a / rhs);
        result = 1;
        break;
      case 8:
        if ((rhs & 0xffff) > 0x10) simThrow(XERR.flagRange);
        result = lhs & (1 << ((rhs - 1) & 31)) ? 1 : 0;
        break;
      case 9:
        if ((rhs & 0xffff) > 0x10) simThrow(XERR.flagRange);
        if (!ref) noRef();
        ref.a[ref.i] = ref.a[ref.i]! | (1 << ((rhs - 1) & 31));
        result = 1;
        break;
      case 10:
        if ((rhs & 0xffff) > 0x10) simThrow(XERR.flagRange);
        if (!ref) noRef();
        ref.a[ref.i] = ref.a[ref.i]! & ~(1 << ((rhs - 1) & 31));
        result = 1;
        break;
      case 11:
        // ++ and <. With a float motive the original re-reads the short address (null): the rounded motive is used here.
        if (ref) {
          ref.a[ref.i] = ref.a[ref.i]! + 1;
          lhs = ref.a[ref.i]!;
        } else if (fref) {
          fref.a[fref.i] = fref.a[fref.i]! + 1;
          lhs = Math.trunc(fref.a[fref.i]!);
        } else noRef();
        result = lhs < rhs ? 1 : 0;
        break;
      case 12: {
        if (!ref) noRef();
        if (rhs === 0) simThrow(XERR.divideByZero);
        if (ref.a[ref.i]! < 0) ref.a[ref.i] = -ref.a[ref.i]!;
        const r = rhs < 0 ? -rhs : rhs;
        ref.a[ref.i] = ref.a[ref.i]! % ((r << 16) >> 16);
        result = 1;
        break;
      }
      case 13:
        if (!ref) noRef();
        ref.a[ref.i] = ref.a[ref.i]! & rhs;
        result = 1;
        break;
      case 14:
        result = lhs >= rhs ? 1 : 0;
        break;
      case 15:
        result = lhs <= rhs ? 1 : 0;
        break;
      case 16:
        result = lhs !== rhs ? 1 : 0;
        break;
      case 17:
        if (ref) {
          ref.a[ref.i] = ref.a[ref.i]! - 1;
          lhs = ref.a[ref.i]!;
        } else if (fref) {
          fref.a[fref.i] = fref.a[fref.i]! - 1;
          lhs = Math.trunc(fref.a[fref.i]!);
        } else noRef();
        result = lhs > rhs ? 1 : 0;
        break;
      case 18:
        if (!ref) noRef();
        ref.a[ref.i] = ref.a[ref.i]! | rhs;
        result = 1;
        break;
      case 19:
        if (!ref) noRef();
        ref.a[ref.i] = ref.a[ref.i]! ^ rhs;
        result = 1;
        break;
      default:
        // 20: := sqrt(rhs)
        if (!ref) noRef();
        ref.a[ref.i] = Math.trunc(Math.fround(Math.sqrt(rhs)));
        result = 1;
        break;
    }
    if (writes && fref && (lhsScope === 14 || lhsScope === 15 || lhsScope === 17)) {
      const f = fref.a[fref.i]!;
      if (f < MOTIVE_MIN) fref.a[fref.i] = MOTIVE_MIN;
      else if (f > MOTIVE_MAX) fref.a[fref.i] = MOTIVE_MAX;
    }
    if (writes && ref && ref.a === this.obj.objectData && ref.i === OD.graphic) this.module.dirty(this);
    return result;
  }

  // --- primitives ---------------------------------------------------------------------

  /** cXObject::TryElement (lbl_10601898). */
  tryElement(elem: StackElem, t: BehaviorTree, off: number): number {
    const op = t.primitive(off) & 0x7fff;
    this.primCounts.set(op, (this.primCounts.get(op) ?? 0) + 1);
    const v = t.view;
    const p = off + 4;
    const s16 = (o: number): number => v.getInt16(p + o, true);
    const u8 = (o: number): number => t.bytes[p + o]!;
    switch (op) {
      case 0:
        return this.tryIdle(elem, s16(0));
      case 1:
        return this.tryGenericSimCall(elem, s16(0));
      case 2:
        return this.tryExpression(t, off);
      case 4:
        return this.tryGrab(elem);
      case 5:
        return this.tryDrop();
      case 7:
        return this.tryUpdate(elem, s16(0), s16(2));
      case 8:
        return this.tryRandom(s16(0), s16(2), s16(4), s16(6));
      case 9: // Burn
        return this.module.unportedPrim(op, "burn", PRIM_FALSE);
      case 10: // Tutorial
        return this.module.unportedPrim(op, "tutorial", PRIM_TRUE);
      case 11:
        return this.tryGetDistanceTo(elem, s16(0), u8(2), u8(3), s16(4));
      case 12:
        return this.tryDirectionTo(elem, s16(0), s16(2), u8(4), u8(5), s16(6));
      case 13:
        return this.tryPushInteraction(elem, u8(0), u8(1), u8(2), u8(3), u8(4));
      case 14:
        return this.tryFindFunctionalObject(elem, s16(0), s16(2), s16(4), u8(6));
      case 15: {
        // Breakpoint: throws when the value is non-zero.
        if (this.interpValue(s16(2), s16(0), false) !== 0) simThrow(XERR.breakpoint);
        return PRIM_TRUE;
      }
      case 16:
        return this.tryFindGoodLocation(elem, u8(0), u8(1), u8(2));
      case 18:
        return this.tryKillObject(elem, s16(0), u8(2));
      case 19: // Make New Character
        return this.module.unportedPrim(op, "make new character", PRIM_FALSE);
      case 20:
        return this.tryCallFunctionalTree(elem, s16(0), s16(2));
      case 21: // Show String: a string of the private file sent to the UI (GlobalDispatch 0xeb); recorded only.
        this.module.record(this, "showString", s16(0));
        return PRIM_TRUE;
      case 23: {
        // Play Sound Event (cXObject::TryPlaySound always succeeds): operand 4 bit 1 plays it for the stack object.
        this.module.record(this, "playSound", s16(0));
        const f = u8(4);
        this.module.soundHooks?.playSound(elem.behavior, s16(0), f !== 0xff && f & 2 ? elem.stackObj : this.id);
        return PRIM_TRUE;
      }
      case 24:
        return this.tryRelationship(elem, u8(0), (u8(1) << 24) >> 24, (u8(2) << 24) >> 24, (u8(3) << 24) >> 24, u8(4));
      case 26: // Relationship
        return this.tryRelationship2(elem, u8(0), u8(1), u8(2), u8(3), (u8(4) << 24) >> 24, s16(6));
      case 25:
        return this.tryBudget(u8(0), u8(1), s16(2), v.getUint16(p + 4, true), u8(6));
      case 28:
        return this.tryCallNamedTree(elem, s16(0), s16(2), u8(4), u8(5));
      case 31:
        return this.trySetToNext(elem, t, p);
      case 32:
        return this.tryTestObjectType(v.getUint32(p, true), u8(6), s16(4));
      case 33:
        return this.tryFind5WorstMotives(elem, s16(4), s16(6));
      case 34: // UI Effect (tutorial button flashes): recorded only.
        this.module.record(this, "uiEffect", s16(0));
        return PRIM_TRUE;
      case 35: // Special effect (TryUserEvent): recorded only.
        return this.module.unportedPrim(op, "user event", PRIM_TRUE);
      case 36:
        return this.tryDialog(elem, new Uint8Array(v.buffer, v.byteOffset + p, 8));
      case 41: // Set Balloon / Headline: recorded only (no sprite slot activation).
        this.module.record(this, "balloon", s16(2));
        return PRIM_TRUE;
      case 42:
        return this.tryCreateObject(elem, v.getUint32(p, true), (u8(4) << 24) >> 24, u8(5), (u8(6) << 24) >> 24);
      case 43:
        return this.tryDropOnto(elem, s16(0), s16(2), s16(4), s16(6));
      case 46:
        return this.trySnap(elem, s16(0), s16(2), s16(4));
      case 48: // Stop All Sounds (cXObject::TryKillSounds): of this object, or of the stack object when operand 0 is set.
        this.module.record(this, "killSounds", 0);
        this.module.soundHooks?.killSounds(s16(0) === 0 ? this.id : elem.stackObj);
        return PRIM_TRUE;
      case 49:
        return this.tryNotifyOutOfIdle(elem);
      case 50:
        return this.tryMakeActionString(elem, s16(0), u8(4));
      case 51:
        return this.tryInventoryAction(elem, u8(0), u8(1), v.getUint16(p + 2, true), v.getUint32(p + 4, true));
      default:
        // 3, 6, 17, 22, 27, 29, 30, 37..40, 44, 45, 47 (person primitives) and >= 0x34: error 5.
        simThrow(XERR.unknownPrimitive);
    }
  }

  /**
   * cXObject::TryIdle (Sleep): the parameter `paramIndex` of the frame counts
   * the ticks left. When nothing keeps the object awake the count moves to the
   * module's per-object idle counter (TickAllObjects skips the object until
   * it runs out); otherwise it counts down here, one tick per call.
   */
  protected tryIdle(elem: StackElem, paramIndex: number): number {
    if (paramIndex < 0 || paramIndex >= elem.numParams) simThrow(XERR.paramRange);
    const at = elem.paramsAt() + paramIndex;
    const mem = elem.stack.mem;
    if (this.module.idleCounter(this.id) === 0) {
      mem[at] = 0;
      this.module.setIdleCounter(this.id, 0xffff);
    }
    if (mem[at]! < 0) mem[at] = 0;
    const n = mem[at]!;
    if (n === 0) return PRIM_TRUE;
    const slot0 = this.obj.spriteSlots[0];
    const awake = this.isPerson || (slot0 !== undefined && slot0.activeTicks !== 0) || this.obj.objectData[OD.keepAwake]! !== 0;
    if (!awake) this.module.setIdleCounter(this.id, (n - 1) & 0xffff);
    else mem[at] = n - 1;
    return PRIM_WAIT;
  }

  /** cXObject::TryUpdate (Refresh): who 0 me / 1 stack object; what 0 graphic, 1 UI, 2 room score. */
  protected tryUpdate(elem: StackElem, who: number, what: number): number {
    let o: SimObject | null = this;
    if (who === 1) {
      o = this.obj_(elem.stackObj);
      if (!o) simThrow(XERR.noStackObject);
    } else if (who !== 0) {
      simThrow(3);
    }
    if (what === 0) this.module.dirty(o);
    else if (what === 1) this.module.record(o, "refreshUI", o.id);
    else if (what === 2) {
      if (o.obj.objectData[OD.roomImpact] !== -5) this.module.record(o, "roomScoreChanged", 0);
    } else simThrow(3);
    return PRIM_TRUE;
  }

  /** cXObject::TryRandom: lhs := random % rhs (operands: lhs data, lhs scope, rhs data, rhs scope). */
  protected tryRandom(lhsData: number, lhsScope: number, rhsData: number, rhsScope: number): number {
    this.outRef = null;
    this.outFRef = null;
    this.interpValue(lhsScope, lhsData, true);
    const ref = this.outRef as ShortRef | null;
    const fref = this.outFRef as FloatRef | null;
    this.outRef = null;
    this.outFRef = null;
    const n = this.interpValue(rhsScope, rhsData, false);
    if (n === 0) simThrow(XERR.randomZero);
    const r = this.module.sim.random();
    const value = r - Math.trunc(r / (n >>> 0)) * n;
    if (ref) ref.a[ref.i] = value;
    else if (fref) fref.a[fref.i] = value >>> 0;
    else simThrow(XERR.cantWrite);
    return PRIM_TRUE;
  }

  /** The Get Distance To case of TryElement: temps[t] := CalcShortDistance(object, stack object). */
  protected tryGetDistanceTo(elem: StackElem, temp: number, flags: number, scope: number, data: number): number {
    if (temp < 0 || temp >= 8) simThrow(XERR.tempRange);
    const id = this.interpValue(flags & 1 ? scope : 3, flags & 1 ? data : OD.objectId, false);
    const a = this.obj_(id);
    if (!a) simThrow(XERR.noTestObject);
    const b = this.obj_(elem.stackObj);
    if (!b) simThrow(XERR.noTestObject);
    this.obj.temps[temp] = Math.trunc(calcShortDistance(a.obj, b.obj));
    return PRIM_TRUE;
  }

  /** cXObject::TryDirectionTo: the 8-way direction from the object to the stack object. */
  protected tryDirectionTo(elem: StackElem, lhsData: number, lhsScope: number, flags: number, scope: number, data: number): number {
    this.outRef = null;
    this.interpValue(lhsScope, lhsData, true);
    const ref = this.outRef as ShortRef | null;
    this.outRef = null;
    const id = this.interpValue(flags & 1 ? scope : 3, flags & 1 ? data : OD.objectId, false);
    const from = this.obj_(id);
    if (!from) simThrow(XERR.noTestObject);
    const to = this.obj_(elem.stackObj);
    if (!to) simThrow(XERR.noStackObject);
    const dx = to.obj.fx - from.obj.fx;
    const dy = to.obj.fy - from.obj.fy;
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
    if (!ref) simThrow(XERR.cantWrite);
    ref.a[ref.i] = (d + 8) & 7;
    return PRIM_TRUE;
  }

  /** cXObject::TryKillObject: who 0 me / 1 stack object / 2 nobody. */
  protected tryKillObject(elem: StackElem, who: number, flags: number): number {
    if (who < 0 || who > 2) simThrow(9);
    const id = who === 0 ? this.id : who === 1 ? elem.stackObj : 0;
    const o = this.obj_(id);
    if (!o) return PRIM_FALSE;
    this.module.addToKillQueue(id, ((flags >> 1) & 1) ^ 1);
    if (id === this.id && treeSimGlobals.notInCheckTree && (flags & 1) === 0) return PRIM_WAIT;
    return PRIM_TRUE;
  }

  /** cXObject::TryCallFunctionalTree: an entry point of the stack object, run on this stack. */
  protected tryCallFunctionalTree(elem: StackElem, fn: number, flags: number): number {
    const o = this.obj_(elem.stackObj);
    if (!o) simThrow(XERR.noStackObject);
    const EPS = [0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, -1, 0x1b, 0xe, 0x1c, 0x10, 0x11, 0x1d];
    if (fn < 0 || fn > 14) return PRIM_FALSE;
    const ep = EPS[fn]!;
    if (ep === -1) {
      // Entry point 0x1a is only called for people (a cXPerson +0x60e test): not ported.
      if (!this.isPerson) return PRIM_FALSE;
      return this.module.unportedPrim(20, "functional tree 8 (person)", PRIM_FALSE);
    }
    const tree = o.fnTable.getTreeID(ep);
    if (tree === 0) return PRIM_FALSE;
    // Bit 0 of the flags is GosubObjectTree's last argument (unused by cXObject's).
    void flags;
    return this.gosubObjectTree(o, null, tree) ? PRIM_CONTINUE : PRIM_FALSE;
  }

  /** cXObject::TryBudget. */
  /**
   * cXObject::TryGenericSimCall: 44 calls through lbl_105BBAC0, all returning
   * true; calls >= 0x2c (and 7, 22) are error 0x2a. Ported: 2 (the stack
   * object becomes the current action's icon), 10/11 (buy and build
   * disabled/enabled: recorded), 14 (global 0x1f := temp 0), 15 (person
   * data 0x48 := temp 0), 28 (lot zoning into temp 0). Others
   * are logged and return true.
   */
  protected tryGenericSimCall(elem: StackElem, call: number): number {
    const m = this.module;
    if (call < 0 || call >= 0x2c || call === 7 || call === 22) simThrow(0x2a);
    switch (call) {
      case 2: {
        // The stack object (error 0xa) becomes my current action's icon (person only, error 0x1c).
        const o = this.obj_(elem.stackObj);
        if (!o) simThrow(XERR.noObject);
        const me = m.persons.find((x) => x === (this as SimObject));
        if (!me) simThrow(XERR.notPerson);
        if (me.currentAction && me.currentAction.priority !== 0) {
          me.currentAction.icon = o.id;
          m.onQueueChanged?.(me);
        }
        return PRIM_TRUE;
      }
      case 14:
        // cSimulator::SetGlobal(0x1f, temp 0).
        m.sim.globals[0x1f] = this.temps[0]!;
        return PRIM_TRUE;
      case 15: {
        // Person data 0x48 := temp 0, 0x49 := 0 (person only, error 0x1c); the footprint is recomputed.
        if (!this.person) simThrow(XERR.notPerson);
        this.person.personData[0x48] = this.temps[0]!;
        this.person.personData[0x49] = 0;
        return PRIM_TRUE;
      }
      case 10:
      case 11:
        // ObjectModule::DisableBuyAndBuild / EnableBuyAndBuild(this).
        m.buyBuildDisabledBy = call === 10 ? this.id : 0;
        m.record(this, call === 10 ? "disableBuyAndBuild" : "enableBuyAndBuild", this.id);
        return PRIM_TRUE;
      case 28: {
        // Zoning of house temp 0: 90-92 -> 0, 93-98 -> 1, else
        // Neighborhood::GetZoningType (house 0 -> 1; listed house -> its
        // type, else 0) mapped 1 -> 0, 2 -> 1, other -> -1.
        const h = this.temps[0]!;
        let r: number;
        if (h >= 0x5a && h <= 0x5c) r = 0;
        else if (h >= 0x5d && h <= 0x62) r = 1;
        else {
          const z = m.getZoningType(h);
          r = z === 1 ? 0 : z === 2 ? 1 : -1;
        }
        this.temps[0] = r;
        return PRIM_TRUE;
      }
      case 3:
      case 17:
        // cSimsApp::RemoveTaxiDialog / cXPerson::TryChangeLots (nbhd/transit.ts).
        if (m.transitHooks) return m.transitHooks.genericSimCall(this, call);
        return m.unportedPrim(1, `generic sim call ${call}`, PRIM_TRUE);
      default:
        return m.unportedPrim(1, `generic sim call ${call}`, PRIM_TRUE);
    }
  }

  /**
   * cXObject::TryRelationship2. Operands: variable index, mode (0 me -> stack
   * object, 1 stack object -> me, 2 stack object -> local's object, 3
   * local's object -> stack object), flags (1 fail when the variable is
   * missing, 2 the ids are neighbor ids, 4 set instead of get), local index,
   * value scope and data. Between two people (or with flag 2) the
   * relationship lives in the source neighbor's RelMatrix (Neighbor +0xc,
   * Neighborhood::FindNeighborByID of person data 0x1f) keyed by the other
   * neighbor's id; otherwise in the source object's RelMatrix keyed by the
   * target's object id. A missing variable grows the array (zeros). Errors:
   * 0x33 bad local, 0x15 missing object / neighbor, 0x1c flag 2 with modes
   * 0 / 1 run by a non-person, 0x13 nothing to write the value into.
   */
  protected tryRelationship2(elem: StackElem, index: number, mode: number, flags: number, local: number, scope: number, data: number): number {
    const m = this.module;
    const localId = (): number => {
      if (local >= elem.numLocals) simThrow(0x33);
      return elem.getLocal(local);
    };
    let arr: number[] | undefined;
    let grow: (n: number) => number[];
    if (flags & 2) {
      const nb = (id: number) => m.findNeighborByID(id);
      const myNeighbor = (): number => {
        if (!this.person) simThrow(XERR.notPerson);
        return this.person.personData[0x1f]!;
      };
      let from = null;
      let to = null;
      if (mode === 0) {
        from = nb(myNeighbor());
        to = nb(elem.stackObj);
      } else if (mode === 1) {
        const me = myNeighbor();
        from = nb(elem.stackObj);
        to = nb(me);
      } else if (mode === 2) {
        const l = localId();
        from = nb(elem.stackObj);
        to = nb(l);
      } else if (mode === 3) {
        from = nb(localId());
        to = nb(elem.stackObj);
      }
      if (!from || !to) simThrow(XERR.noStackObject);
      ({ arr, grow } = m.neighborRelation(from, to.id));
      if (flags & 4) m.record(this, "relationshipDirty", `${from.id}->${to.id}:${index}`);
    } else {
      let from: SimObject | null = null;
      let to: SimObject | null = null;
      if (mode === 0) {
        from = this;
        to = m.getObject(elem.stackObj);
      } else if (mode === 1) {
        from = m.getObject(elem.stackObj);
        to = this;
      } else if (mode === 2) {
        to = m.getObject(localId());
        from = m.getObject(elem.stackObj);
      } else if (mode === 3) {
        from = m.getObject(localId());
        to = m.getObject(elem.stackObj);
      }
      if (!from || !to) simThrow(XERR.noStackObject);
      if (from.person && to.person) {
        const a = m.findNeighborByID(from.person.personData[0x1f]!);
        if (!a) simThrow(XERR.noStackObject);
        ({ arr, grow } = m.neighborRelation(a, to.person.personData[0x1f]!));
        if (flags & 4) m.record(this, "relationshipDirty", `${a.id}->${to.person.personData[0x1f]}:${index}`);
      } else {
        const rel = from.obj.relations;
        const key = to.id;
        arr = rel.get(key);
        grow = (n) => {
          const x = rel.get(key) ?? [];
          while (x.length < n) x.push(0);
          rel.set(key, x);
          return x;
        };
      }
    }
    if (!arr || arr.length <= index) {
      if (flags & 1) return PRIM_FALSE;
      arr = grow(index + 1);
    }
    this.outRef = null;
    this.outFRef = null;
    const value = this.interpValue(scope, data, true);
    const ref = this.outRef as ShortRef | null;
    this.outRef = null;
    this.outFRef = null;
    if (flags & 4) arr[index] = (value << 16) >> 16;
    else {
      if (!ref) simThrow(XERR.cantWrite);
      ref.a[ref.i] = arr[index]!;
    }
    return PRIM_TRUE;
  }

  /**
   * cXObject::TryRelationship (Old Relationship). Operands: +0 get (0) or
   * set, +1 variable index, +2 parameter holding / receiving the value, +3
   * mode (0 me -> stack object, 1 stack object -> me, 2 stack object ->
   * parameter 0's object, 3 parameter 0's object -> stack object), +4 flags
   * (1 fail when the variable is missing, 2 the ids are neighbor ids). Two
   * people use the source neighbor's RelMatrix keyed by the other's neighbor
   * id, other objects the source object's keyed by the target's object id.
   * Errors: 0x15 missing object / neighbor, 0x1c flag 2 with modes 0 / 1
   * run by a non-person, 8 bad parameter index (or a frame without
   * parameters).
   */
  protected tryRelationship(elem: StackElem, set: number, index: number, param: number, mode: number, flags: number): number {
    const m = this.module;
    let arr: number[] | undefined;
    let grow: (n: number) => number[];
    if (flags & 2) {
      const myNeighbor = (): number => {
        if (!this.person) simThrow(XERR.notPerson);
        return this.person.personData[0x1f]!;
      };
      let from = null;
      let to = null;
      if (mode === 0) {
        from = m.findNeighborByID(myNeighbor());
        to = m.findNeighborByID(elem.stackObj);
      } else if (mode === 1) {
        const me = myNeighbor();
        from = m.findNeighborByID(elem.stackObj);
        to = m.findNeighborByID(me);
      } else if (mode === 2) {
        from = m.findNeighborByID(elem.stackObj);
        to = m.findNeighborByID(elem.getParam(0));
      } else if (mode === 3) {
        from = m.findNeighborByID(elem.getParam(0));
        to = m.findNeighborByID(elem.stackObj);
      }
      if (!from || !to) simThrow(XERR.noStackObject);
      ({ arr, grow } = m.neighborRelation(from, to.id));
      // ObjectModule::SetRelationshipDirty
      if (set) m.record(this, "relationshipDirty", `${from.id}->${to.id}:${index}`);
    } else {
      let from: SimObject | null = null;
      let to: SimObject | null = null;
      if (mode === 0) {
        from = this;
        to = m.getObject(elem.stackObj);
      } else if (mode === 1) {
        from = m.getObject(elem.stackObj);
        to = this;
      } else if (mode === 2) {
        from = m.getObject(elem.stackObj);
        to = m.getObject(elem.getParam(0));
      } else if (mode === 3) {
        from = m.getObject(elem.getParam(0));
        to = m.getObject(elem.stackObj);
      }
      if (!from || !to) simThrow(XERR.noStackObject);
      if (from.obj.selector.objd.objectType === OBJ_TYPE_PERSON && to.obj.selector.objd.objectType === OBJ_TYPE_PERSON) {
        const a = m.findNeighborByID(from.person?.personData[0x1f] ?? 0);
        const b = to.person?.personData[0x1f] ?? 0;
        if (!a) simThrow(XERR.noStackObject);
        ({ arr, grow } = m.neighborRelation(a, b));
        if (set) m.record(this, "relationshipDirty", `${a.id}->${b}:${index}`);
      } else {
        const rel = from.obj.relations;
        const key = to.id;
        arr = rel.get(key);
        grow = (n) => {
          const x = rel.get(key) ?? [];
          while (x.length < n) x.push(0);
          rel.set(key, x);
          return x;
        };
      }
    }
    if (!arr || arr.length <= index) {
      if (flags & 1) return PRIM_FALSE;
      arr = grow(index + 1);
    }
    if (param < 0 || elem.numParams === 0) simThrow(8);
    if (set === 0) elem.setParam(param, arr[index]!);
    else arr[index] = elem.getParam(param);
    return PRIM_TRUE;
  }

  /**
   * cXObject::TryInventoryAction (Manage Inventory). Operands: +0 action,
   * +1 token type, +2 flags, +4 GUID (0: the stack object's). The inventory
   * is the neighbor's of the person running it (flag 0x2000: of the person
   * whose id is in temp 4); error 0x1c when that is no person. Flags pick
   * temps 0..3 by 2-bit fields: bit 1 + 0x0c the count (else 1), 0x300 the
   * index read, 0x60 the count written, 0x1800 the index written; bit 0
   * makes Set To Next match the GUID. Actions: 0 add, 1 remove one (count
   * -1: the whole token), 2 remove by index, 3 find (false when missing),
   * 4 set to next (false at the end), 5 / 6 replace the type 1 / 3 tokens
   * by one for the neighbor whose id is in temp 0. Success dirties the
   * control panel's inventory (CPState::SetDirty 0x4000000).
   */
  protected tryInventoryAction(elem: StackElem, action: number, type: number, flags: number, guidOperand: number): number {
    const m = this.module;
    const who = flags & 0x2000 ? m.getObject(this.temps[4]!) : this;
    if (!who?.person) simThrow(XERR.notPerson);
    const nb = m.findNeighborByGUID(who.obj.selector.guid);
    if (!nb) return m.unportedPrim(51, "inventory of a person without neighbor", PRIM_FALSE);
    const inv = m.getInventoryByNeighbourID(nb.id);
    let guid = guidOperand | 0;
    if (guid === 0) guid = m.getObject(elem.stackObj)?.obj.selector.guid ?? 0;
    const temps = this.temps;
    const count = flags & 2 ? temps[(flags >> 2) & 3]! : 1;
    const indexIn = temps[(flags >> 8) & 3]!;
    let ok = true;
    switch (action) {
      case 0:
        ok = addToken(inv, type, guid, count);
        break;
      case 1:
        ok = removeToken(inv, type, guid, count);
        break;
      case 2:
        ok = removeTokenByIndex(inv, indexIn, count);
        break;
      case 3: {
        const r = findToken(inv, type, guid);
        if (r.count === 0) return PRIM_FALSE;
        temps[(flags >> 5) & 3] = r.count;
        temps[(flags >> 11) & 3] = r.index;
        break;
      }
      case 4: {
        const r = setToNextToken(inv, type, indexIn, flags & 1 ? guid : 0);
        temps[(flags >> 5) & 3] = r.count;
        temps[(flags >> 11) & 3] = r.index;
        ok = r.index !== -1;
        break;
      }
      case 5:
      case 6: {
        const t = action === 5 ? 1 : 3;
        const g = m.findNeighborByID(temps[0]!)?.guid ?? 0;
        removeAllTokensOfType(inv, t);
        addToken(inv, t, g, 1);
        break;
      }
      default:
        break;
    }
    if (!ok) return PRIM_FALSE;
    m.record(this, "inventoryDirty", nb.id);
    return PRIM_TRUE;
  }

  protected tryBudget(kind: number, scope: number, data: number, flags: number, expense: number): number {
    const s = kind === 2 ? 0x19 : kind === 0 ? 7 : kind === 1 ? 9 : scope;
    if (expense > 8) simThrow(XERR.expenseType);
    let amount = this.interpValue(s, data, false);
    const funds = this.module.sim.getFunds();
    if (flags & 2) amount = -amount;
    if (amount < 0 || amount <= funds) {
      if ((flags & 1) === 0) this.module.sim.spend(expense, amount);
      return PRIM_TRUE;
    }
    return PRIM_FALSE;
  }

  /**
   * cXObject::TryDialog. A dialog of this object still shown (state 1) is
   * aborted, a done one (5) ignored. Operand byte 7 bit 0: the dialog is
   * queued and the primitive goes on (true). Otherwise kinds 5 / 7 / 0xb /
   * 0xd (town pickers) go to the transit hooks; kinds 6, 8, 9, 0xa (phone
   * book), 0xc / 0xf (magic book) and 0xe are not ported (recorded, true).
   * The generic kinds queue an ObjectDialog (EnqueueObjectDialog) and wait;
   * then the state answers: 2 (first button) true, the text of a type 3
   * dialog kept; 3 false (type 2: temp[(byte 7 >> 4) & 7] = 0); 4 false
   * (type 2: that temp = 1).
   */
  protected tryDialog(elem: StackElem, op: Uint8Array): number {
    const m = this.module;
    let cur = m.getCurrentDialog(this);
    if (cur?.state === 1) {
      cur.abort();
      cur = null;
    } else if (cur?.state === 5) cur = null;
    if (op[7]! & 1) {
      m.enqueueObjectDialog(this, elem, op);
      return PRIM_TRUE;
    }
    const kind = op[5]! & 0x7f;
    const r = m.transitHooks?.tryDialog(this, kind);
    if (r !== undefined) return r;
    if (kind === 0xa && m.dialogHooks?.showPhoneBook) return this.tryPhoneBookDialog();
    if (kind === 6 || kind === 8 || kind === 9 || kind === 0xa || kind === 0xc || kind === 0xf || kind === 0xe) {
      return m.unportedPrim(36, `dialog kind ${kind}`, PRIM_TRUE);
    }
    if (!cur) {
      // Without a way to show it, the dialog would wait forever: answered as its first button.
      if (!m.dialogHooks) {
        m.record(this, "dialog", kind);
        return PRIM_TRUE;
      }
      m.enqueueObjectDialog(this, elem, op);
      return PRIM_WAIT;
    }
    const st = cur.state;
    cur.resultProcessed();
    const t = (op[7]! >> 4) & 7;
    if (st === 2) {
      if (kind === 3) m.dialogText = cur.edited;
      return PRIM_TRUE;
    }
    if (st < 2) return PRIM_WAIT;
    if (st === 4) {
      if (kind === 2) this.temps[t] = 1;
      return PRIM_FALSE;
    }
    if (st === 3) {
      if (kind === 2) this.temps[t] = 0;
      return PRIM_FALSE;
    }
    return PRIM_TRUE;
  }

  /**
   * cXObject::TryDialog kind 0xa (the phone book), on a person: the module's
   * +0xec at 0 becomes minus my neighbor id and the primitive waits while
   * PostSim runs CWinPhoneBook; a picked neighbor id goes to temp 0 (true),
   * a cancel (-9999) answers false.
   */
  private tryPhoneBookDialog(): number {
    const m = this.module;
    if (!this.person) simThrow(XERR.notPerson);
    const v = m.phoneBook;
    if (v === 0) {
      const caller = this.person.personData[PD_NEIGHBOR_ID]!;
      m.phoneBook = -caller;
      const hooks = m.dialogHooks;
      queueMicrotask(() => {
        if (m.phoneBook >= 0 || m.phoneBook === -9999 || !hooks?.showPhoneBook) return;
        void hooks.showPhoneBook(caller).then((sel) => {
          m.phoneBook = sel < 1 ? -9999 : sel;
        });
      });
      return PRIM_WAIT;
    }
    if (v < 1) {
      if (v === -9999) {
        m.phoneBook = 0;
        return PRIM_FALSE;
      }
      return PRIM_WAIT; // the phone book is still up
    }
    this.temps[0] = v;
    m.phoneBook = 0;
    return PRIM_TRUE;
  }

  /**
   * cXObject::TryMakeActionString (Add / Change Action String): entry
   * `index` (1-based) of the private STR# `strId`, its tokens replaced
   * (ParseUIString). While a pie menu is made (ObjTestSim::IsMenuInProgress)
   * it becomes a new menu item (MakeNewMenuItem) whose stack vars are those
   * ParseUIString set, the first one defaulting to the stack object.
   * Otherwise it would rename the person's current interaction when
   * lbl_105BA314 is set (not ported: recorded only).
   */
  protected tryMakeActionString(elem: StackElem, strId: number, index: number): number {
    const m = this.module;
    const menu = m.menuInProgress;
    if (!menu) {
      m.record(this, "actionString", strId);
      return PRIM_TRUE;
    }
    const file = elem.behavior?.priv;
    const text = (file && index >= 1 ? loadUIStringSet(file, strId)?.[index - 1] : undefined) ?? "";
    const vars = new Int16Array(4);
    const name = this.parseUIString(text, elem, vars);
    if (vars[0] === 0) vars[0] = elem.stackObj;
    menu.items.push({ entry: menu.entry, name, args: vars });
    return PRIM_TRUE;
  }

  /**
   * cXObject::ParseUIString: the "$Token" / "$Token:n" / "$Token:a:b"
   * (ParseOneString) placeholders of a UI string, in the original order:
   * $FamilyAssets:n (net worth of the family whose id is local n), $Family
   * (family of the neighbor whose id is the stack object; `vars[1]` becomes
   * its id), $Me / $Object (catalog names of this / the stack object, whose
   * selector goes to `out`), $Local:n, $Attrib:n (stack object attribute),
   * $NameAttrib:n / $NameLocal:n (catalog name of the object whose id is
   * there), $NeighborLocal:n (that neighbor's full name), $Neighbor (the
   * neighbor whose id is the stack object; `vars[0]` becomes it),
   * $CatalogLocal:n (catalog description), $TimeLocal:n (an hour), then
   * $JobOffer / $JobDesc / $Job (career and level from locals a / b, from
   * this person's job person data otherwise). $TokenNameLocal,
   * $FameTitleLocal and $Grade are not ported (left as they are).
   */
  parseUIString(text: string, elem: StackElem | null, vars: Int16Array | null, out?: { selector: ObjSelector | null }): string {
    const m = this.module;
    let s = text;
    if (!s.includes("$")) return s;
    const id = elem?.stackObj ?? 0;
    const nLocals = elem?.numLocals ?? 0;
    const local = (n: number): number | null => (elem && n >= 0 && n < nLocals ? elem.getLocal(n) : null);
    /** ParseOneString over every occurrence; `fn` returns the replacement or null to keep it. */
    const each = (token: string, fn: (a: number, b: number) => string | null): void => {
      let from = 0;
      for (;;) {
        const at = s.indexOf(token, from);
        if (at < 0) return;
        let end = at + token.length;
        let a = -1;
        let b = -1;
        const num = (): number | null => {
          let q = end + 1;
          while (q < s.length && s.charCodeAt(q) >= 0x30 && s.charCodeAt(q) <= 0x39) q++;
          const v = q > end + 1 ? Number(s.slice(end + 1, q)) : null;
          end = q;
          return v;
        };
        if (s[end] === ":") {
          a = num() ?? -1;
          if (s[end] === ":") b = num() ?? -1;
        }
        const r = fn(a, b);
        if (r !== null) s = s.slice(0, at) + r + s.slice(end);
        from = at + 1;
      }
    };
    const famOfNeighbor = (nb: Neighbor) => m.nbhd?.families.find((f) => f.memberGuids.some((g) => (g | 0) === (nb.guid | 0))) ?? null;
    const objName = (oid: number): string | null => this.obj_(oid)?.obj.selector.getCatalogName() ?? null;
    each("$FamilyAssets", (a) => {
      const v = local(a);
      const fam = v === null ? null : m.nbhd?.families.find((f) => f.chunkId === v);
      return fam ? String(fam.budget + fam.netWorth) : null;
    });
    each("$Family", () => {
      const nb = m.findNeighborByID(id);
      const fam = nb ? famOfNeighbor(nb) : null;
      if (!fam) return null;
      if (vars) vars[1] = fam.chunkId;
      return fam.name;
    });
    each("$Me", () => this.obj.selector.getCatalogName());
    each("$Object", () => {
      const o = this.obj_(id);
      if (!o) return null;
      if (out) out.selector = o.obj.selector;
      return o.obj.selector.getCatalogName();
    });
    each("$Local", (a) => {
      const v = local(a);
      return v === null ? null : String(v);
    });
    each("$Attrib", (a) => {
      const o = this.obj_(id);
      return o && a >= 0 && a < o.obj.attributes.length ? String(o.obj.attributes[a]) : null;
    });
    each("$NameAttrib", (a) => {
      const o = this.obj_(id);
      return o && a >= 0 && a < o.obj.attributes.length ? objName(o.obj.attributes[a]!) : null;
    });
    each("$NameLocal", (a) => {
      const v = local(a);
      return v === null ? null : objName(v);
    });
    each("$NeighborLocal", (a) => {
      const v = local(a);
      return v === null ? null : this.neighborFullName(v);
    });
    each("$Neighbor", () => {
      const nb = m.findNeighborByID(id);
      if (!nb) return null;
      if (vars) vars[0] = id;
      const st = m.sim.state;
      const info = st ? [...st.family, ...st.neighbors].find((q) => q.neighborId === id) : undefined;
      return info?.firstName ?? nb.name;
    });
    each("$CatalogLocal", (a) => {
      const v = local(a);
      const o = v === null ? null : this.obj_(v);
      return o ? o.obj.selector.getCatalogDescription() : null;
    });
    each("$TimeLocal", (a) => {
      const v = local(a);
      return v !== null && v >= 0 && v < 24 ? `${v}:00` : null;
    });
    // lbl_105BBA80: $JobOffer (cCareer::GetOfferDialogText), $JobDesc (cJob +0x3b4), $Job (cJob::GetName).
    const pd = this.person?.personData ?? null;
    const female = pd ? (pd[PD_GENDER]! & 1) !== 0 : false;
    const job = (a: number, b: number): { career: SimCareer; level: number } | null => {
      let careerId = 0;
      let level = 0;
      if (a === -1 || b === -1) {
        if (pd) {
          careerId = pd[PD_JOB_TYPE]!;
          level = pd[PD_JOB_LEVEL]!;
        }
      } else {
        const va = local(a);
        const vb = local(b);
        if (va === null || vb === null) return null;
        careerId = va;
        level = vb;
      }
      const career = m.careers.find((c) => c.id === careerId);
      return career && level >= 0 && level < career.jobs.length ? { career, level } : null;
    };
    each("$JobOffer", (a, b) => {
      const j = job(a, b);
      return j ? offerDialogText(j.career, female) : null;
    });
    each("$JobDesc", (a, b) => {
      const j = job(a, b);
      return j ? j.career.jobs[j.level]!.description : null;
    });
    each("$Job", (a, b) => {
      const j = job(a, b);
      return j ? simJobName(j.career.jobs[j.level]!, female) : null;
    });
    return s;
  }

  /** PersonFinder::GetFullName of the neighbor `neighborId` (null when unknown). */
  private neighborFullName(neighborId: number): string | null {
    const nb = this.module.findNeighborByID(neighborId);
    if (!nb) return null;
    const st = this.module.sim.state;
    const info = st ? [...st.family, ...st.neighbors].find((q) => q.neighborId === neighborId) : undefined;
    return info ? [info.firstName, info.lastName].filter(Boolean).join(" ") || nb.name : nb.name;
  }

  /**
   * cXObject::TryCallNamedTree: a tree looked up by name (STR# `strId`
   * entry `index` of the private / semi-global file, or Global.iff when
   * flag 1) in the stack object's Behavior; mode 0 runs it now on this
   * object, 1 on the stack object, 2 pushes it on this stack.
   */
  protected tryCallNamedTree(elem: StackElem, strId: number, flags: number, index: number, mode: number): number {
    if (elem.state === 1) return this.lastResult ? PRIM_TRUE : PRIM_FALSE;
    const beh = elem.behavior!;
    let file;
    if (flags & 1) file = beh.glob;
    else if (getTreeClass(elem.getTreeID()) === 2) file = beh.priv;
    else file = beh.getResFile(getBaseID(3));
    // StringSetBase::GetString is 1-based
    const name = file && index >= 1 ? loadStringSet(file, strId)?.[index - 1] : undefined;
    if (!name) return PRIM_FALSE;
    const stackObj = this.obj_(elem.stackObj);
    let runner: SimObject | null;
    let now: boolean;
    if (mode === 1) {
      runner = stackObj;
      now = true;
    } else if (mode === 0) {
      runner = this;
      now = true;
    } else if (mode < 3) {
      runner = this;
      now = false;
    } else {
      simThrow(XERR.namedTreeMode);
    }
    if (!runner || !stackObj) simThrow(XERR.noStackObject);
    const treeBeh = stackObj.behavior;
    const tree = treeBeh.getTreeID(name);
    if (tree === 0) return PRIM_FALSE;
    if (now) return runner.runCheckTree(treeBeh, stackObj.id, tree, null) ? PRIM_TRUE : PRIM_FALSE;
    if (runner !== this || !this.gosubObjectTree(stackObj, null, tree)) return PRIM_FALSE;
    elem.state = 1;
    return PRIM_CONTINUE;
  }

  /** The Test Object Type case of TryElement: the object's GUID (or its master's) is `guid`. */
  protected tryTestObjectType(guid: number, scope: number, data: number): number {
    const o = this.obj_(this.interpValue(scope, data, false));
    if (!o) simThrow(XERR.noTestObject);
    const sel = o.obj.selector;
    if ((sel.guid | 0) === (guid | 0)) return PRIM_TRUE;
    return (sel.getMasterSelector().guid | 0) === (guid | 0) ? PRIM_TRUE : PRIM_FALSE;
  }

  /** The Notify Stack Object Out Of Idle case: wakes a sleeping stack object now. */
  protected tryNotifyOutOfIdle(elem: StackElem): number {
    const o = this.obj_(elem.stackObj);
    if (!o) simThrow(XERR.noStackObject);
    const main = o.getMainSimElem();
    const ref = main?.behavior?.getNodeRef(main.getTreeID(), main.node) ?? null;
    if (main && ref) {
      const prim = ref.tree.primitive(ref.off) & 0x7fff;
      if (prim === 0) {
        main.setParam(0, 0);
        this.module.setIdleCounter(o.id, 0);
      } else if (prim === 0x11) {
        main.setParam(0, 0);
      }
    }
    return PRIM_TRUE;
  }

  /**
   * cXObject::TryCreateObject (Create New Object Instance). Operands: GUID,
   * placement mode (byte 4, jump table lbl_10601BC4), flags (byte 5), local
   * (byte 6). Modes: 0 in front of me, 1 / 2 my slot 0 (on top of me / in
   * my hand), 3 in front of the stack object, 4 the stack object's slot 0,
   * 5 where I stand, 6 out of the world (not placed), 7 / 8 where the
   * object in parameter 0 / local [byte 6] is, 9 in front of me turned by
   * local [byte 6] (odd directions: on my tile), 10 / 11 my slot 2 / 3,
   * 12..14 the stack object's slot 2..4. Flags: 1 fail when an instance
   * of the type is on the target tile, 2 the new object's Main gets my id
   * as parameter 0 and my stack object, 4 the neighbor in the stack object
   * (not ported), 8 fail when anything is on the target tile, 0x10 my temp
   * 0 as its parameter 0, 0x20 face the stack object's direction. The new
   * object is made out of the world, then CanPlace / Place (it is killed
   * when it does not fit) and becomes the stack object. The room check of
   * the target tile is not ported. An object file not opened yet loads
   * asynchronously: the primitive waits meanwhile (the original loads
   * synchronously).
   */
  protected tryCreateObject(elem: StackElem, guid: number, mode: number, flags: number, local: number): number {
    const hooks = this.module.worldHooks;
    if (!hooks || flags & 4) return this.module.unportedPrim(42, flags & 4 ? "create neighbor" : "create object (no world)", PRIM_FALSE);
    const sel = hooks.selector(guid);
    if (sel === undefined) return PRIM_WAIT;
    if (!sel) return PRIM_FALSE;
    const me = this.obj;
    const stack = this.obj_(elem.stackObj)?.obj ?? null;
    let pos = { fx: 0, fy: 0 };
    let level = me.level;
    let container: XObject | null = null;
    let slot = 0;
    let place = true;
    let wallDir = -1;
    const front = (o: XObject, d: number): { fx: number; fy: number } => {
      const [dx, dy] = DIR_VEC[d & 7]!;
      return { fx: o.fx + dx * 16, fy: o.fy + dy * 16 };
    };
    const at = (o: XObject | null): boolean => {
      if (!o) return false;
      pos = { fx: o.fx, fy: o.fy };
      level = o.level;
      return true;
    };
    switch (mode) {
      case 0:
        pos = front(me, me.dir);
        break;
      case 1:
      case 2:
      case 10:
      case 11:
        at(me);
        container = me;
        slot = mode === 10 ? 2 : mode === 11 ? 3 : 0;
        break;
      case 3:
        if (!at(stack)) return PRIM_FALSE;
        pos = front(stack!, stack!.dir);
        break;
      case 4:
      case 12:
      case 13:
      case 14:
        if (!at(stack)) return PRIM_FALSE;
        container = stack;
        slot = mode === 4 ? 0 : mode - 10;
        break;
      case 5:
        at(me);
        break;
      case 6:
        pos = { fx: -16, fy: -16 };
        level = 1;
        place = false;
        break;
      case 7:
        if (elem.numParams === 0) simThrow(XERR.paramRange);
        if (!at(this.obj_(elem.getParam(0))?.obj ?? null)) return PRIM_FALSE;
        break;
      case 8:
        if (local < 0 || local >= elem.numLocals) simThrow(XERR.paramRange);
        if (!at(this.obj_(elem.getLocal(local))?.obj ?? null)) return PRIM_FALSE;
        break;
      case 9: {
        const d = (me.dir + this.interpValue(25, local, false)) & 7;
        pos = d & 1 ? { fx: me.fx, fy: me.fy } : front(me, d);
        wallDir = (d + 4) & 7;
        break;
      }
      default:
        at(me);
        break;
    }
    void wallDir;
    const tx = pos.fx >> 4;
    const ty = pos.fy >> 4;
    const onTarget = (): SimObject[] => this.module.list.filter((x) => x.obj.tileX === tx && x.obj.tileY === ty && x.obj.level === level && x.obj.containerId === 0);
    if (flags & 1 && onTarget().some((x) => x.obj.selector === sel)) return PRIM_FALSE;
    if (flags & 8 && onTarget().length > 0) return PRIM_FALSE;
    if (place) {
      const n = this.module.sim.world?.size ?? 64;
      if (tx < 1 || ty < 1 || tx >= n - 1 || ty >= n - 1) return PRIM_FALSE;
    }
    const x = hooks.make(sel);
    if (!x) return PRIM_FALSE;
    const o = this.module.addObject(x, true);
    if (flags & 0x20 && stack) {
      x.objectData[1] = o.isPerson ? stack.dir : stack.dir & 6;
      this.module.dirty(o);
    }
    if (place) {
      if (!hooks.canPlace(x, pos, level, container, slot)) {
        this.module.removeObject(x);
        hooks.kill(x);
        return PRIM_FALSE;
      }
      hooks.place(x, pos, level, container, slot);
    }
    const main = o.getStackSize() > 0 ? o.stack.getNthFrame(0) : null;
    if (flags & 2) {
      if (flags & 0x10) simThrow(0x36);
      if (main) {
        if (main.numParams > 0) main.setParam(0, this.id);
        main.stackObj = elem.stackObj;
      }
    } else if (flags & 0x10 && main && main.numParams > 0) {
      main.setParam(0, this.temps[0]!);
    }
    elem.stackObj = o.id;
    this.module.dirty(o);
    return PRIM_TRUE;
  }

  /**
   * cXObject::TryFindFunctionalObject (Find Best Object For Function).
   * Operands: function (jump table lbl_10601BE8: the object data holding
   * each object's score and the entry point it must have), data / scope of
   * a reference object (flag 8: distances are taken from it, error 0x17
   * when missing), flags (byte 6: 1 outside, 2 inside, 4 same room; the
   * room tests are not ported and pass). Every object not locked out
   * (object data 25) nor flagged 0x200 with that entry point's action tree
   * scores its object data (50 for function 8 and the type test of
   * function 15), its check tree (run on me with it as the stack object)
   * must pass and may change the score (my object data 66); the score
   * minus 3 x the distance (halved beyond a tile for function 11, at least
   * 1) is compared, the best becomes the stack object.
   */
  protected tryFindFunctionalObject(elem: StackElem, fn: number, data: number, scope: number, flags: number): number {
    const FNS: ReadonlyArray<readonly [number, number] | null> = [
      [0x1f, 0x12], [0x20, 0x13], [0x21, 0x14], [0x24, 0x15], null, null, [0x25, 0x18], [0x26, 0x19],
      [-1, 0x1a], null, [0x3d, 0xe], [0x27, 0x1c], [0x40, 0x10], [0x41, 0x11], [0xf, 0x1d], [-1, -1],
    ];
    const f = fn >= 0 && fn < FNS.length ? FNS[fn] : null;
    if (!f) return PRIM_FALSE;
    // Function 8 (lbl_100EB5E8): people only (pets fail).
    if (fn === 8 && this.person) {
      const g = this.person.personData[0x41]! | 0;
      const x = g ^ 1;
      if ((x >> 1) - (x & g) < 0) return PRIM_FALSE;
    }
    const [scoreField, entry] = f;
    let from: SimObject = this;
    if (flags & 8) {
      const o = this.obj_(this.interpValue(scope, data, false));
      if (!o) simThrow(XERR.noTestObject);
      from = o;
    }
    const my = this.obj.objectData;
    let best: SimObject | null = null;
    let bestScore = 0;
    for (const o of [...this.module.list]) {
      const d = o.obj.objectData;
      if (d[OD.keepAwake]! > 0 || d[8]! & 0x200) continue;
      if (fn === 15) {
        if (d[OD.category] !== 4) continue;
        my[66] = 50;
      } else {
        const action = o.fnTable.getTreeID(entry);
        if (action === 0) continue;
        my[66] = scoreField === -1 ? 50 : d[scoreField]!;
        if (my[66] === 0) continue;
        const check = o.fnTable.getCheckTreeID(entry);
        if (check !== 0) {
          if (!this.runCheckTree(o.behavior, o.id, check, null)) continue;
          if (my[66] === 0) continue;
        }
      }
      let dist = calcShortDistance(from.obj, o.obj);
      if (dist > 1 && fn === 11) dist *= 0.5;
      let score = Math.fround(my[66]! - dist * 3);
      if (score < 1) score = 1;
      if (score > bestScore) {
        best = o;
        bestScore = score;
      }
    }
    if (!best) return PRIM_FALSE;
    elem.stackObj = best.id;
    return PRIM_TRUE;
  }

  /**
   * cXObject::TryFindGoodLocation (Find Location For): places the stack
   * object (error 0x15 without one). Operands: mode (byte 0), local (byte
   * 1), flags (byte 2: 1 start from the object in local [byte 1], error
   * 0x33 / 0x17; 2 any tile, else an empty one; 4 a buildable tile). Modes:
   * 1 out of the world (Pickup); 2 at the reference object (or me), turned
   * to face its direction + 5; 3 / 4 the first spot from the reference
   * object (error 0x3d without one) along its facing (+2 for 4), same room;
   * 5 from a random spot; others from the start (16, 16 by default) or the
   * reference object, same room first. CanPlace / Place on the spot found.
   * The search is Placement.findGoodLocation's ring search for every mode
   * (the per-direction searches of the original are not ported).
   */
  protected tryFindGoodLocation(elem: StackElem, mode: number, local: number, flags: number): number {
    const target = this.obj_(elem.stackObj);
    if (!target) simThrow(XERR.noStackObject);
    const hooks = this.module.worldHooks;
    if (!hooks) return this.module.unportedPrim(16, "find good location (no world)", PRIM_FALSE);
    let ref: SimObject | null = null;
    let start = { fx: 0x10, fy: 0x10 };
    let level = 1;
    if (flags & 1) {
      if (local >= elem.numLocals) simThrow(0x33);
      ref = this.obj_(elem.getLocal(local));
      if (!ref) simThrow(XERR.noTestObject);
      start = { fx: ref.obj.fx, fy: ref.obj.fy };
      level = ref.obj.level;
    }
    const x = target.obj;
    const placeAt = (pos: { fx: number; fy: number } | null, lvl: number): number => {
      if (!pos || !hooks.canPlace(x, pos, lvl, null, 0)) return PRIM_FALSE;
      hooks.place(x, pos, lvl, null, 0);
      this.module.dirty(target);
      return PRIM_TRUE;
    };
    const opts = { emptyTile: (flags & 2) === 0, buildable: (flags & 4) !== 0, random: null as (() => number) | null };
    if (mode === 2) {
      const r = ref ?? (this as SimObject);
      // Turn((((dir + 5) & 7) - my dir) & 7) / 2) with the usual 2 rotation notches.
      const steps = ((((r.obj.dir + 5) & 7) - x.dir) & 7) >> 1;
      x.objectData[1] = (x.dir + 2 * steps) & 7;
      return placeAt({ fx: r.obj.fx, fy: r.obj.fy }, r.obj.level);
    }
    if (mode === 1) {
      hooks.pickup(x);
      this.module.dirty(target);
      return PRIM_TRUE;
    }
    if (mode === 3 || mode === 4) {
      if (!ref) simThrow(0x3d);
      return placeAt(hooks.findGoodLocation(x, start, level, opts), level);
    }
    if (mode === 5) opts.random = () => this.module.sim.random();
    return placeAt(hooks.findGoodLocation(x, start, level, opts), level);
  }

  /**
   * cXObject::TryFind5WorstMotives: the motives 5, 6, 7, 8, 9, 13, 14, 15
   * (lbl_1059A468) of me (`who` 0) or the stack object (1), lowest value
   * first; the first five go to temps 0..4. Error 10 when that object is
   * not a person, 0x1e for a list type above 2.
   */
  protected tryFind5WorstMotives(elem: StackElem, who: number, kind: number): number {
    const o = who === 1 ? this.obj_(elem.stackObj) : who === 0 ? (this as SimObject) : null;
    if (!o || !o.person) simThrow(10);
    if (kind < 0 || kind >= 3) simThrow(0x1e);
    const m = o.person.motives;
    const list = [5, 6, 7, 8, 9, 13, 14, 15].sort((a, b) => m[a]! - m[b]!);
    for (let i = 0; i < 5; i++) this.temps[i] = list[i]!;
    return PRIM_TRUE;
  }

  /**
   * cXObject::TryPushInteraction: queues interaction `entry` (TTAB string
   * index) of the object in parameter / local (flag 2) `objArg` on the stack
   * object, which must be a person (errors 0x17 no object, 0x1f no tree
   * table, 0x16 no entry, 0x15 no stack object, 0x1c not a person).
   * Priority code: 0 the pusher's own (a person's current priority, else 1),
   * 1 = 100, 2 = 2, 3 = 50. Flags: 1 icon object from local `iconLocal`,
   * 4 interaction flag 2 (interrupts), 8 interaction flag 0x40.
   */
  protected tryPushInteraction(elem: StackElem, entry: number, objArg: number, prio: number, flags: number, iconLocal: number): number {
    let id: number;
    if (flags & 2) {
      if (objArg > elem.numLocals) simThrow(0x33);
      id = elem.getLocal(objArg);
    } else {
      if (objArg > elem.numParams) simThrow(8);
      id = elem.getParam(objArg);
    }
    const o = this.obj_(id);
    if (!o) simThrow(0x17);
    const tt = this.module.treeTableOf(o.obj.selector);
    if (!tt) simThrow(0x1f);
    const e = tt.entries.find((x) => x.stringIndex === entry);
    if (!e) simThrow(0x16);
    if (!this.obj_(elem.stackObj)) simThrow(0x15);
    const person = this.module.persons.find((x) => x.id === elem.stackObj);
    if (!person) simThrow(0x1c);
    let priority = 1;
    if (prio === 0) {
      const me = this.module.persons.find((x) => x === (this as SimObject));
      if (me) priority = me.pd[33]!;
    } else if (prio === 1) priority = 100;
    else if (prio === 2) priority = 2;
    else if (prio === 3) priority = 50;
    else simThrow(0x2d);
    const i = person.makeInteraction(o, e, priority);
    if (flags & 8) i.flags |= 0x40;
    if (flags & 1) {
      if (iconLocal >= elem.numLocals) simThrow(0x33);
      i.icon = elem.getLocal(iconLocal);
    }
    if (flags & 4) i.flags |= 2;
    return person.addAction(i) ? PRIM_TRUE : PRIM_FALSE;
  }

  /**
   * cXObject::TrySnap(StackElem, XPrimParam): moves this object to a spot of
   * the stack object. Operands: slot (or the parameter holding it), mode,
   * flags. Modes: 0 routing slot whose index is parameter `slot`, 3 routing
   * slot `slot`, 4 global routing slot `slot` (SLOT 100); 1 the stack
   * object's slot 0; 2 the tile in front of it. A routing slot with a snap
   * target (+0x20 >= 0) puts this object into that containment slot of the
   * stack object (error 0x20 when it has none), else at the slot's offset
   * turned with the object; slot flag 0x1000 faces the object's direction
   * plus the first allowed direction, else the facing is kept; slot flag
   * 0x800 skips the bounds check. Then TrySnap(FTilePt, ...): bounds, then
   * CanPlace / Place (Placement) and the facing. On failure object data 52
   * is 2 when the spot was out of bounds and object data 54 the obstacle.
   * Not ported: the room and wall checks between the two tiles, the
   * animation displacement (flag 1) and moving people out of the way
   * (flag 2, cXPerson::MoveOutOfWay). Without world hooks (headless) the
   * object is moved without placement checks.
   */
  protected trySnap(elem: StackElem, slotArg: number, mode: number, flags: number): number {
    void flags;
    const o = this.obj_(elem.stackObj);
    if (!o) simThrow(0x15);
    const t = o.obj;
    let pos = { fx: t.fx, fy: t.fy };
    let dir = this.obj.dir;
    let container: XObject | null = null;
    let slot = 0;
    let checkBounds = true;
    if (mode === 2) {
      const [vx, vy] = DIR_VEC[t.dir & 7]!;
      pos = { fx: t.fx + vx * 16, fy: t.fy + vy * 16 };
    } else if (mode === 1) {
      container = t;
    } else {
      let idx = slotArg;
      if (mode === 0) {
        if (slotArg < 0 || slotArg >= elem.numParams) simThrow(8);
        idx = elem.getParam(slotArg);
      } else if (mode !== 3 && mode !== 4) {
        simThrow(0x24);
      }
      const slots = mode === 4 ? this.module.globalRoutingSlots() : this.module.routingSlotsOf(t.selector);
      const rs = slots[idx];
      if (!rs || idx < 0) simThrow(0x1b);
      if (rs.flags & 0x1000) {
        let k = 0;
        while (k < 7 && !(rs.flags & (1 << k))) k++;
        dir = t.dir + (k === 7 ? 0 : k);
      }
      checkBounds = (rs.flags & 0x800) === 0;
      if (rs.snapTarget < 0) {
        const [dx, dy] = rotateOffset(rs.x, rs.y, t.dir);
        pos = { fx: Math.round(t.fx + dx), fy: Math.round(t.fy + dy) };
      } else {
        if (rs.snapTarget >= t.objectSlots.length - 1) simThrow(0x20);
        container = t;
        slot = rs.snapTarget;
      }
    }
    const d = this.obj.objectData;
    d[52] = 0;
    const hooks = this.module.worldHooks;
    if (!hooks) {
      this.obj.fx = pos.fx;
      this.obj.fy = pos.fy;
      this.obj.level = t.level;
    } else {
      const n = this.module.sim.world?.size ?? 64;
      const tx = pos.fx >> 4;
      const ty = pos.fy >> 4;
      let ok = !(checkBounds && (tx < 1 || ty < 1 || tx >= n - 1 || ty >= n - 1));
      if (ok) ok = hooks.canPlace(this.obj, pos, t.level, container, slot);
      if (!ok) {
        const e = hooks.lastError();
        if (!checkBounds || e.code === 1 || tx < 1 || ty < 1 || tx >= n - 1 || ty >= n - 1) d[52] = 2;
        d[54] = e.obstacle;
        return PRIM_FALSE;
      }
      hooks.place(this.obj, pos, t.level, container, slot);
    }
    d[1] = ((dir % 8) + 8) % 8;
    this.moved();
    this.module.dirty(this);
    return PRIM_TRUE;
  }

  /**
   * The Grab case of TryElement: the stack object goes into my slot 0
   * (CanPlace / Place at my position); false when it does not fit.
   */
  protected tryGrab(elem: StackElem): number {
    const hooks = this.module.worldHooks;
    if (!hooks) return this.module.unportedPrim(4, "grab (no world)", PRIM_FALSE);
    const o = this.obj_(elem.stackObj);
    if (!o) return PRIM_FALSE;
    const me = this.obj;
    const pos = { fx: me.fx, fy: me.fy };
    if (!hooks.canPlace(o.obj, pos, me.level, me, 0)) return PRIM_FALSE;
    hooks.place(o.obj, pos, me.level, me, 0);
    this.module.dirty(o);
    return PRIM_TRUE;
  }

  /**
   * The Drop case of TryElement: what my slot 0 holds goes to the tile in
   * front of me (my position plus my direction's step, lbl_10601878).
   */
  protected tryDrop(): number {
    const hooks = this.module.worldHooks;
    if (!hooks) return this.module.unportedPrim(5, "drop (no world)", PRIM_FALSE);
    const held = this.obj_(this.obj.objectSlots[1]?.containedId ?? 0);
    if (!held) return PRIM_FALSE;
    const me = this.obj;
    const [dx, dy] = DIR_VEC[me.dir & 7]!;
    const pos = { fx: me.fx + dx * 16, fy: me.fy + dy * 16 };
    if (!hooks.canPlace(held.obj, pos, me.level, null, 0)) return PRIM_FALSE;
    hooks.place(held.obj, pos, me.level, null, 0);
    this.module.dirty(held);
    return PRIM_TRUE;
  }

  /**
   * cXObject::TryDropOnto: what my slot `src` holds goes into slot `dst` of
   * the stack object. Operands: source is a parameter index (flag), source
   * slot, destination is a parameter index (flag), destination slot.
   * Errors: 8 bad parameter, 0x1b no such slot of mine, 0x15 no stack
   * object. False when the slot is empty or the object does not fit.
   */
  protected tryDropOnto(elem: StackElem, srcIsParam: number, src: number, dstIsParam: number, dst: number): number {
    const param = (i: number): number => {
      if (i < 0 || i >= elem.numParams) simThrow(XERR.paramRange);
      return elem.getParam(i);
    };
    const from = srcIsParam !== 0 ? param(src) : src;
    const to = dstIsParam !== 0 ? param(dst) : dst;
    const s = from >= 0 && from < this.obj.objectSlots.length - 1 ? this.obj.objectSlots[from + 1] : undefined;
    if (!s) simThrow(XERR.slotRange);
    const target = this.obj_(elem.stackObj);
    if (!target) simThrow(XERR.noStackObject);
    if (s.containedId === 0) return PRIM_FALSE;
    const held = this.obj_(s.containedId);
    const hooks = this.module.worldHooks;
    if (!held) return PRIM_FALSE;
    if (!hooks) return this.module.unportedPrim(43, "drop onto (no world)", PRIM_FALSE);
    const pos = { fx: -16, fy: -16 };
    if (!hooks.canPlace(held.obj, pos, 1, target.obj, to)) return PRIM_FALSE;
    hooks.place(held.obj, pos, 1, target.obj, to);
    this.module.dirty(held);
    return PRIM_TRUE;
  }

  /** Called after a primitive moved or turned this object (the person resets its drawn facing). */
  protected moved(): void {}

  /**
   * cXObject::TrySetToNext. Operands: +0 GUID, +4 search type (bit 7: the
   * target is the variable +5 / +7, else the stack object id), +6 local.
   */
  protected trySetToNext(elem: StackElem, t: BehaviorTree, p: number): number {
    const v = t.view;
    const kindByte = t.bytes[p + 4]!;
    const scope = kindByte & 0x80 ? t.bytes[p + 5]! : 10;
    const data = kindByte & 0x80 ? t.bytes[p + 7]! : 0;
    this.outRef = null;
    this.interpValue(scope, data, true);
    const ref = this.outRef as ShortRef | null;
    this.outRef = null;
    if (!ref) simThrow(XERR.cantWrite);
    const kind = kindByte & 0x7f;
    const m = this.module;
    const cur = ref.a[ref.i]!;
    const nextIn = (list: readonly SimObject[]): number => {
      if (cur === 0) return list[0]?.id ?? 0;
      const i = list.findIndex((o) => o.id === cur);
      return i < 0 ? 0 : (list[i + 1]?.id ?? 0);
    };
    let found = 0;
    switch (kind) {
      case 1: // person
        found = nextIn(m.people);
        ref.a[ref.i] = found;
        return found !== 0 ? PRIM_TRUE : PRIM_FALSE;
      case 3: {
        // the next part of a multi-tile object
        const o = m.getObject(cur);
        if (!o || o.obj.selector.objd.masterId === 0) {
          ref.a[ref.i] = 0;
          return PRIM_FALSE;
        }
        const part = m.nextMultiTilePart(o);
        ref.a[ref.i] = part ? part.id : 0;
        return part ? PRIM_TRUE : PRIM_FALSE;
      }
      case 4: {
        // object of type (GUID)
        found = nextIn(m.getInstances(v.getUint32(p, true)));
        ref.a[ref.i] = found;
        return found !== 0 ? PRIM_TRUE : PRIM_FALSE;
      }
      case 5: // Neighborhood::GetNextNeighborID
        found = m.nextNeighborID(cur);
        ref.a[ref.i] = found;
        return found !== 0 ? PRIM_TRUE : PRIM_FALSE;
      case 7: {
        // the next neighbor whose selector has this GUID
        const guid = v.getUint32(p, true) | 0;
        for (found = m.nextNeighborID(cur); found !== 0; found = m.nextNeighborID(found)) {
          if ((m.findNeighborByID(found)!.guid | 0) === guid) break;
        }
        ref.a[ref.i] = found;
        return found !== 0 ? PRIM_TRUE : PRIM_FALSE;
      }
      case 12: {
        // the next person (people list, wrapping) of the same family (person data 0x3d) as the person in the variable
        if (cur === 0) return PRIM_FALSE;
        const me = m.getObject(cur);
        if (!me?.person) simThrow(XERR.notPerson);
        const fam = me.person.personData[0x3d];
        const list = m.people;
        const at = list.findIndex((x) => x.id === cur);
        for (let k = 1; at >= 0 && k < list.length; k++) {
          const o = list[(at + k) % list.length]!;
          if (o.person && o.person.personData[0x3d] === fam) {
            ref.a[ref.i] = o.id;
            return PRIM_TRUE;
          }
        }
        return PRIM_FALSE;
      }
      case 9: {
        // the next object on the 4 tiles beside the object in local (operand byte 6):
        // east, south, west then north of it, the one in the variable giving the start;
        // the tile's first object, with the same object data 29 (room)
        const li = t.bytes[p + 6]!;
        if (li >= elem.numLocals) simThrow(8);
        const center = m.getObject(elem.getLocal(li));
        if (!center) simThrow(XERR.noObject);
        const c = center.obj;
        const curObj = cur > 0 ? m.getObject(cur) : null;
        let dx = 1;
        let dy = 0;
        let first = true;
        if (curObj) {
          dx = (curObj.obj.fx >> 4) - (c.fx >> 4);
          dy = (curObj.obj.fy >> 4) - (c.fy >> 4);
          first = false;
        }
        const n = m.sim.world?.size ?? 64;
        for (;;) {
          if (!first) {
            if (dx > 0) [dx, dy] = [0, 1];
            else if (dx < 0) [dx, dy] = [0, -1];
            else if (dy > 0) [dx, dy] = [-1, 0];
            else return PRIM_FALSE;
          }
          first = false;
          const tx = (c.fx >> 4) + dx;
          const ty = (c.fy >> 4) + dy;
          if (tx < 0 || ty < 0 || tx >= n || ty >= n || c.level < 1 || c.level > 2) continue;
          const o = m.list.find((x) => x.obj.tileX === tx && x.obj.tileY === ty && x.obj.level === c.level && x.obj.containerId === 0);
          if (!o || o.obj.objectData[29] !== c.objectData[29]) continue;
          ref.a[ref.i] = o.id;
          return PRIM_TRUE;
        }
      }
      case 10: {
        // career (GetCareers / GetCareerByID): the career after the one whose id
        // is in the variable, the first one when it holds no career id
        const ids = m.careers.map((c) => c.id);
        const at = ids.indexOf(cur);
        const next = at < 0 ? 0 : at + 1;
        if (next >= ids.length) return PRIM_FALSE;
        ref.a[ref.i] = ids[next]!;
        return PRIM_TRUE;
      }
      case 11: {
        // the neighborhood's other houses (Neighborhood +0x11c): from the first
        // (variable 0) or after the house number in the variable
        const list = m.neighborhoodHouses;
        let at = 0;
        if (cur !== 0) {
          at = list.indexOf(cur);
          at = at < 0 ? list.length : at + 1;
        }
        if (at >= list.length) return PRIM_FALSE;
        ref.a[ref.i] = list[at]!;
        return PRIM_TRUE;
      }
      case 8: {
        // object on the same tile (ObjectIterator over the tile, wrapping)
        const o = m.getObject(cur);
        if (!o || o.obj.tileX < 0) return PRIM_FALSE;
        const here = m.list.filter((x) => x.obj.tileX === o.obj.tileX && x.obj.tileY === o.obj.tileY && x.obj.level === o.obj.level);
        const i = here.indexOf(o);
        const n = here[i + 1] ?? here[0]!;
        ref.a[ref.i] = n.id;
        return PRIM_TRUE;
      }
      default: {
        // 0 any object, 2 non-person, 6 object whose data 59 (+0xc0) is parameter 0: the module list.
        let o: SimObject | null;
        if (cur === 0) o = m.list[0] ?? null;
        else {
          const c = m.getObject(cur);
          o = c ? m.nextInList(c) : null;
        }
        if (o) {
          if (kind === 2) {
            while (o && o.isPerson) o = m.nextInList(o);
          } else if (kind === 6) {
            const want = elem.getParam(0);
            while (o && o.obj.objectData[OD.category] !== want) o = m.nextInList(o);
          } else if (kind !== 0) {
            simThrow(XERR.setToNextType);
          }
        }
        if (o) ref.a[ref.i] = o.id;
        return o ? PRIM_TRUE : PRIM_FALSE;
      }
    }
  }
}

/** cXObject::CalcShortDistance: tiles between two objects (levels count 20 units each, 1/256 scale on the plane). */
export function calcShortDistance(a: XObject, b: XObject): number {
  if (b.selector.objd.objectType === 7) return 0;
  const dx = a.fx - b.fx;
  const dy = a.fy - b.fy;
  const dz = Math.fround((b.level - a.level) * 0x14);
  return Math.fround(Math.sqrt(Math.fround(Math.fround(1 / 256) * (dx * dx + dy * dy)) + dz * dz));
}

