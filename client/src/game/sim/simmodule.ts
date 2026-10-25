/**
 * SimModule: the simulation half of ObjectModule (ObjectModule.cpp), over the
 * objects world/objects.ts loaded.
 *
 * ObjectModule fields used (byte offsets):
 *   +0x1c / +0x20 objects by id (index id - 1), +0x2c one sim flag word per id:
 *     low 16 bits: idle counter (signed; TickAllObjects runs the object when
 *       < 1, else counts it down; 0xffff = running),
 *     SetSimFlag(id, f, on) toggles f << 16: 1 tick, 2 tick while paused,
 *       4 error pending, 8 may be chosen autonomously.
 *   +0x30 / cXObject +0xe0 the module list, +0x8c / +0x90 the people.
 *
 * People (cXPerson) are kept in the lists but their tick flag is cleared:
 * their Main loop needs routing, animation and the interaction queue
 * (cXPerson::TryElement), which are not ported in this phase.
 */

import { type FarEntryInfo, readFarManifest } from "../../engine/assets.js";
import { ResFile } from "../world/iffres.js";
import type { XObject } from "../world/objects.js";
import type { ObjSelector } from "../world/objselector.js";
import { Behavior } from "./behavior.js";
import type { Simulator } from "./simulator.js";
import { SimObject } from "./xobject.js";
import { EP } from "./objfntable.js";
import { PersonSim, SCORE_CURVE_MOTIVES } from "./person.js";
import { curvesFromStrings, HAPPY_CURVE_MOTIVES, type MotiveCurve } from "./motives.js";
import { loadStringSet } from "./behavior.js";
import type { NeighborhoodData } from "../data/neighborhood.js";
import { TreeTable } from "./treetable.js";
import { loadFloatConstants } from "./floatconstants.js";
import { setMotiveConstants } from "./motives.js";
import { autonomyConstants, type AutonomyConstants } from "./person.js";
import { readSlotChunk } from "../world/slots.js";
import { routingSlotFrom, type RoutingSlot } from "./routing.js";

const GLOBAL_FAR = "GameData/Global/Global.far";

/** Global.iff and the semi-global files (ObjectFolder +0x2c / AddSelector's "<global folder><GLOB name>"). */
export class SimResources {
  private readonly semi = new Map<string, ResFile | null>();
  private entries: FarEntryInfo[] = [];

  private constructor(readonly glob: ResFile | null) {}

  static async load(): Promise<SimResources> {
    let entries: FarEntryInfo[] = [];
    try {
      entries = await readFarManifest(`Sims/${GLOBAL_FAR}`);
    } catch {
      entries = [];
    }
    const g = entries.find((e) => e.filename.toLowerCase() === "global.iff");
    const r = new SimResources(g ? await ResFile.openInFar(GLOBAL_FAR, g.filename) : null);
    r.entries = entries;
    return r;
  }

  /** Opens the semi-global files of `selectors` (they must be loaded before ticking). */
  async prepare(selectors: Iterable<ObjSelector>): Promise<void> {
    const names = new Set<string>();
    for (const s of selectors) if (s.semiGlobalName) names.add(s.semiGlobalName.toLowerCase());
    await Promise.all(
      [...names].map(async (n) => {
        if (this.semi.has(n)) return;
        const want = n.endsWith(".iff") ? n : `${n}.iff`;
        const e = this.entries.find((x) => x.filename.toLowerCase() === want);
        this.semi.set(n, e ? await ResFile.openInFar(GLOBAL_FAR, e.filename) : null);
      }),
    );
  }

  /**
   * Opens every semi-global file of the global folder (24 files), so objects
   * created later (buy / build mode, Create Object Instance) find their
   * semi-global trees synchronously.
   */
  async prepareAll(): Promise<void> {
    await Promise.all(
      this.entries
        .filter((e) => e.filename.toLowerCase() !== "global.iff" && e.filename.toLowerCase().endsWith(".iff"))
        .map(async (e) => {
          const n = e.filename.toLowerCase().replace(/\.iff$/, "");
          if (this.semi.has(n) || this.semi.has(`${n}.iff`)) return;
          const f = await ResFile.openInFar(GLOBAL_FAR, e.filename).catch(() => null);
          this.semi.set(n, f);
          this.semi.set(`${n}.iff`, f);
        }),
    );
  }

  semiGlobal(name: string): ResFile | null {
    return name ? (this.semi.get(name.toLowerCase()) ?? null) : null;
  }
}

/** One recorded side effect the port does not perform (sounds, dialogs, UI). */
export interface SimEvent {
  tick: number;
  objectId: number;
  kind: string;
  value: string | number;
}

export class SimModule {
  /** +0x20: objects by id - 1. */
  readonly objects: Array<SimObject | null> = [];
  /** +0x2c */
  readonly simFlags: number[] = [];
  /** +0x30 list (module order). */
  readonly list: SimObject[] = [];
  /** +0x90 */
  readonly people: SimObject[] = [];
  /** The neighborhood (person persistent data, relationships); null when it failed to load. */
  nbhd: NeighborhoodData | null = null;
  /** cXPerson's happiness weight curves (Global.iff STR# 0x1f6 adult, 0x1f8 child). */
  happyCurves: MotiveCurve[] = [];
  happyCurvesChild: MotiveCurve[] = [];
  /** Kill queue (ObjectModule::AddToKillQueue), emptied after each tick. */
  private readonly killQueue: Array<{ id: number; flag: number }> = [];
  private readonly behaviors = new Map<ObjSelector, Behavior>();
  private readonly typeAttrs = new Map<number, Int16Array>();
  /** Unported features hit (name -> count); logged once each. */
  readonly unported = new Map<string, number>();
  /** Recorded side effects (bounded). */
  readonly events: SimEvent[] = [];
  /** Called when an object's look changed (cXObject::Dirty) or it was killed. */
  onDirty: ((o: SimObject) => void) | null = null;
  onKill: ((o: SimObject) => void) | null = null;
  /** Neighborhood +0x16c zoning: house number -> 1 residential / 2 community (UserData LotZoning.iff STR# 1). */
  readonly zoning = new Map<number, number>();
  /** ObjectModule::DisableBuyAndBuild: the object that disabled buy and build modes (0 = enabled). */
  buyBuildDisabledBy = 0;

  constructor(
    readonly sim: Simulator,
    readonly res: SimResources,
    placed: Iterable<XObject>,
  ) {
    for (const x of placed) {
      const o = x.isPerson ? new PersonSim(x, this) : new SimObject(x, this);
      const id = x.objectId;
      while (this.objects.length < id) {
        this.objects.push(null);
        this.simFlags.push(0xffff);
      }
      this.objects[id - 1] = o;
      this.simFlags[id - 1] = x.isPerson ? 0x1ffff : x.simFlags >>> 0;
      this.list.push(o);
      if (x.isPerson) this.people.push(o);
    }
  }

  /** The people as PersonSim. */
  get persons(): PersonSim[] {
    return this.people.filter((p): p is PersonSim => p instanceof PersonSim);
  }

  /**
   * The world side of Create New Object Instance (set by the lot view):
   * `selector` looks a GUID up (undefined while its object file opens, null
   * when unknown), `make` builds the object out of the world (its Init runs
   * through the placement hooks) and places it per the primitive's mode;
   * null when it cannot be placed.
   */
  worldHooks: {
    selector(guid: number): ObjSelector | null | undefined;
    make(sel: ObjSelector, mode: number, me: XObject, stack: XObject | null): XObject | null;
  } | null = null;

  /** Called when a person's interaction queue or current action changes (the Live panel). */
  onQueueChanged: ((p: PersonSim) => void) | null = null;

  /**
   * ObjectModule::AddObject + cXObject::Reset for an object made at run time
   * (buy / build mode): it joins the module under its object id and, with
   * `runInit`, its data is reset and its Init tree runs (lead objects only,
   * as Reset does); without it (an object coming back, e.g. undo of a
   * deletion) its data is kept and Main restarts. Returns the existing
   * SimObject when the object is already in the module.
   */
  addObject(x: XObject, runInit: boolean): SimObject {
    const id = x.objectId;
    const cur = this.objects[id - 1];
    if (cur && cur.obj === x && !cur.killed) return cur;
    const o = x.isPerson ? new PersonSim(x, this) : new SimObject(x, this);
    while (this.objects.length < id) {
      this.objects.push(null);
      this.simFlags.push(0xffff);
    }
    if (cur) {
      const i = this.list.indexOf(cur);
      if (i >= 0) this.list.splice(i, 1);
    }
    this.objects[id - 1] = o;
    this.simFlags[id - 1] = x.isPerson ? 0x1ffff : 0xffff;
    // The list stays in object id order (TickAllObjects, Set To Next).
    let k = this.list.findIndex((y) => y.id > id);
    if (k < 0) k = this.list.length;
    this.list.splice(k, 0, o);
    if (x.isPerson) this.people.push(o);
    // A multi-tile part arrives alone (the factory adds them one by one): its own Init runs.
    if (runInit) {
      if (x.selector.objd.masterId === 0) o.reset(false);
      else o.resetPart(false);
    } else o.resetTree(o.behavior, o.fnTable.getTreeID(EP.main));
    return o;
  }

  /** ObjectModule::KillObject's module part for an object removed by the world (buy / build tools). */
  removeObject(x: XObject): void {
    const o = this.objects[x.objectId - 1];
    if (!o || o.obj !== x) return;
    o.killed = true;
    this.objects[x.objectId - 1] = null;
    const i = this.list.indexOf(o);
    if (i >= 0) this.list.splice(i, 1);
    const j = this.people.indexOf(o);
    if (j >= 0) this.people.splice(j, 1);
  }

  /** AutonomyConstantsClient (FCNS 2 of Global.iff). */
  autonomy: AutonomyConstants = autonomyConstants(new Map());

  /** cXPerson::Initialize / PostLoad's person part: neighbor data and motive curves. */
  initPeople(nbhd: NeighborhoodData | null): void {
    this.nbhd = nbhd;
    const g = this.res.glob;
    // GlobalConstantsClient: FCNS 1 / 5 / 6 motives, FCNS 2 autonomy.
    setMotiveConstants([1, 5, 6].map((id) => loadFloatConstants(g, id)));
    this.autonomy = autonomyConstants(loadFloatConstants(g, 2));
    if (g) {
      this.happyCurves = curvesFromStrings(loadStringSet(g, 0x1f6) ?? [], HAPPY_CURVE_MOTIVES);
      this.happyCurvesChild = curvesFromStrings(loadStringSet(g, 0x1f8) ?? [], HAPPY_CURVE_MOTIVES);
    }
    for (const p of this.persons) this.initPerson(p);
  }

  /** Neighborhood::LoadPersistentData + the motive curve sets of one person. */
  initPerson(p: PersonSim): void {
    const g = this.res.glob;
    const nb = this.nbhd?.neighbors.find((n) => (n.guid | 0) === (p.obj.selector.guid | 0));
    if (nb) p.loadPersistentData(nb);
    p.happyCurves = p.isChild ? this.happyCurvesChild : this.happyCurves;
    // cXPerson::PostLoad: MotiveEffects curves from OBJD +0x66 (private file), else Global.iff 0x1f7 (child) / 0x1f5.
    const own = p.obj.selector.objd.i16(0x66);
    const strings = own !== 0 ? loadStringSet(p.obj.selector.res, own) : g ? loadStringSet(g, p.isChild ? 0x1f7 : 0x1f5) : null;
    p.scoreCurves = curvesFromStrings(strings ?? [], SCORE_CURVE_MOTIVES, 4);
  }

  /** Neighborhood::GetZoningType: house 0 -> 1, listed -> its type, else 0. */
  getZoningType(house: number): number {
    if (house === 0) return 1;
    return this.zoning.get(house) ?? 0;
  }

  /** The zoning file's lines "house, residential|community" (other words count as residential). */
  loadZoning(lines: readonly string[]): void {
    this.zoning.clear();
    for (const l of lines) {
      const i = l.indexOf(",");
      if (i < 0) continue;
      const h = Number.parseInt(l.slice(0, i), 10);
      const word = l.slice(i + 1).trim().toLowerCase();
      if (Number.isFinite(h)) this.zoning.set(h, word === "community" ? 2 : 1);
    }
  }

  /** The Behavior of a selector (ObjSelector +0xc). */
  behaviorOf(sel: ObjSelector): Behavior {
    let b = this.behaviors.get(sel);
    if (!b) {
      b = new Behavior(this.res.glob, sel.res, this.res.semiGlobal(sel.semiGlobalName));
      this.behaviors.set(sel, b);
    }
    return b;
  }

  /**
   * ObjectFolder::GetTypeAttrBlock: one block of shorts per type, keyed by the
   * OBJD type-attribute GUID (+0xb8, else the GUID), OBJD +0xb4 shorts, zeroed
   * at load. The original saves them with the neighborhood; here they live
   * for the session only.
   */
  typeAttributes(sel: ObjSelector): Int16Array | null {
    const count = sel.objd.i16(0xb4);
    if (count <= 0 || count > 31999) return null;
    const key = sel.objd.u32(0xb8) || sel.objd.u32(0x1c);
    let b = this.typeAttrs.get(key);
    if (!b) {
      b = new Int16Array(count);
      this.typeAttrs.set(key, b);
    }
    return b;
  }

  private readonly treeTables = new Map<ObjSelector, TreeTable | null>();
  private readonly routingSlots = new Map<ObjSelector, RoutingSlot[]>();

  /**
   * ObjSelector::GetTreeTable: TTAB OBJD +0xe (-1: the master's id) from the
   * private file, else the semi-global one.
   */
  treeTableOf(sel: ObjSelector): TreeTable | null {
    let t = this.treeTables.get(sel);
    if (t === undefined) {
      let id = sel.objd.i16(0xe);
      if (id === -1) id = sel.getMasterSelector().objd.i16(0xe);
      else if (id < 0) id = 0;
      t = TreeTable.load(sel.res, id);
      if (!t) {
        const semi = this.res.semiGlobal(sel.semiGlobalName);
        if (semi) t = TreeTable.load(semi, id);
      }
      this.treeTables.set(sel, t);
    }
    return t;
  }

  /** The routing slots (SLOT records of type 3, in order) of a selector. */
  routingSlotsOf(sel: ObjSelector): RoutingSlot[] {
    let r = this.routingSlots.get(sel);
    if (!r) {
      r = [];
      const id = sel.objd.slotsId;
      const payload = id !== 0 ? sel.res.get("SLOT", id) : null;
      if (payload) for (const d of readSlotChunk(payload)) if (d.type === 3) r.push(routingSlotFrom(d));
      this.routingSlots.set(sel, r);
    }
    return r;
  }

  private globalSlots: RoutingSlot[] | null = null;

  /** ObjectModule +0xa0: the global routing slots (SLOT 100 of the global file, loaded on message 0x10b). */
  globalRoutingSlots(): RoutingSlot[] {
    if (!this.globalSlots) {
      const payload = this.res.glob?.get("SLOT", 100) ?? null;
      this.globalSlots = payload ? readSlotChunk(payload).filter((d) => d.type === 3).map(routingSlotFrom) : [];
    }
    return this.globalSlots;
  }

  /** The selector whose Behavior `b` is (the object whose tree a frame runs). */
  selectorOfBehavior(b: Behavior | null): ObjSelector | null {
    if (!b) return null;
    for (const [sel, beh] of this.behaviors) if (beh === b) return sel;
    return null;
  }

  /** +0x1c */
  get count(): number {
    return this.objects.length;
  }

  /** cXObject::GetObjectFromID. */
  getObject(id: number): SimObject | null {
    if (id <= 0 || id > this.objects.length) return null;
    return this.objects[id - 1] ?? null;
  }

  /** ObjectModule::SetSimFlag. */
  setSimFlag(id: number, flag: number, on: boolean): void {
    const i = id - 1;
    if (i < 0 || i >= this.simFlags.length) return;
    let f = this.simFlags[i]! & ~(flag << 16);
    if (on) f |= flag << 16;
    this.simFlags[i] = f >>> 0;
  }

  getSimFlags(id: number): number {
    return this.simFlags[id - 1] ?? 0;
  }

  /** The signed low half of the flag word. */
  idleCounter(id: number): number {
    return ((this.simFlags[id - 1] ?? 0) << 16) >> 16;
  }

  setIdleCounter(id: number, v: number): void {
    const i = id - 1;
    if (i < 0 || i >= this.simFlags.length) return;
    this.simFlags[i] = ((this.simFlags[i]! & 0xffff0000) | (v & 0xffff)) >>> 0;
  }

  /**
   * ObjectModule::ClearIdleStatus: wakes the object; when its main frame is
   * sleeping (primitive 0) the remaining ticks go back into its parameter 0.
   */
  clearIdleStatus(id: number): void {
    const o = this.getObject(id);
    if (o) {
      const main = o.getMainSimElem();
      const ref = main?.behavior?.getNodeRef(main.getTreeID(), main.node) ?? null;
      if (main && ref && (ref.tree.primitive(ref.off) & 0x7fff) === 0) {
        const left = this.idleCounter(id);
        if (left >= 0) main.setParam(0, left);
      }
    }
    this.setIdleCounter(id, 0xfffe);
  }

  /** ObjectModule::GetInstances of the selector with this GUID, in module order. */
  getInstances(guid: number): SimObject[] {
    return this.list.filter((o) => (o.obj.selector.guid | 0) === (guid | 0));
  }

  /** cXObject +0xe0 */
  nextInList(o: SimObject): SimObject | null {
    const i = this.list.indexOf(o);
    return i < 0 ? null : (this.list[i + 1] ?? null);
  }

  /**
   * cXMTObject +0x18c (next part), else +0x190 (lead). The part chain is not
   * kept by the loader; the parts sharing the lead are taken in module order.
   */
  nextMultiTilePart(o: SimObject): SimObject | null {
    const lead = o.obj.mtLeadId !== 0 ? o.obj.mtLeadId : o.id;
    // The lead first, then its parts; the iteration wraps around.
    const head = this.getObject(lead);
    const parts = this.list.filter((x) => x.obj.mtLeadId === lead && x.id !== lead);
    if (head) parts.unshift(head);
    const i = parts.indexOf(o);
    return parts[(i + 1) % parts.length] ?? null;
  }

  /** ObjectModule::AddToKillQueue. */
  addToKillQueue(id: number, flag: number): void {
    if (!this.killQueue.some((k) => k.id === id)) this.killQueue.push({ id, flag });
  }

  /**
   * The kill queue (ObjectModule::KillObject for each entry): the object
   * leaves the module. Its Cleanup tree, slot hierarchy and the world tile
   * arrays are not handled yet; the lot view hides it through `onKill`.
   */
  runKillQueue(): void {
    while (this.killQueue.length) {
      const { id } = this.killQueue.shift()!;
      const o = this.getObject(id);
      if (!o) continue;
      o.killed = true;
      this.objects[id - 1] = null;
      this.list.splice(this.list.indexOf(o), 1);
      const pi = this.people.indexOf(o);
      if (pi >= 0) this.people.splice(pi, 1);
      this.onKill?.(o);
    }
  }

  /** cXObject::Dirty: the renderer must redraw the object. */
  dirty(o: SimObject): void {
    this.onDirty?.(o);
  }

  /** cXObject::JustBorn / the age part of Reset: birth date fields from the simulator clock. */
  ageFields(o: SimObject): void {
    const g = this.sim.globals;
    const d = o.obj.objectData;
    // Birth date: +0xa4 year, +0xa6 month, +0xa8 day (object data 45, 46, 47); age: +0x6e years (18), +0xaa months (48).
    let years = g[8]! - d[45]!;
    let months = g[7]! - d[46]!;
    if (g[1]! - d[47]! < 0) months--;
    if (months < 0) {
      months += 12;
      years--;
    }
    d[18] = years;
    d[48] = months + years * 12;
  }

  /** A side effect that is recorded instead of performed. */
  record(o: SimObject, kind: string, value: string | number): void {
    this.events.push({ tick: this.sim.tickCount, objectId: o.id, kind, value });
    if (this.events.length > 2000) this.events.splice(0, this.events.length - 2000);
  }

  /** An unported primitive: logged once, counted, `fallback` returned. */
  unportedPrim(op: number, what: string, fallback: number): number {
    this.noteUnported(`prim ${op} ${what}`);
    return fallback;
  }

  /** An unported variable scope: logged once, counted, `fallback` returned. */
  unportedValue(what: string, fallback: number): number {
    this.noteUnported(what);
    return fallback;
  }

  private noteUnported(key: string): void {
    const n = this.unported.get(key) ?? 0;
    if (n === 0) console.warn(`[sim] not ported: ${key}`);
    this.unported.set(key, n + 1);
  }

  /** Neighbor person data (scope 32): the neighborhood is not wired to the simulator yet. */
  neighborPersonData(_neighborId: number, data: number): number {
    if (data < 0 || data >= 0x100) return 0;
    return this.unportedValue("scope 32 neighbor's person data", 0);
  }
}
