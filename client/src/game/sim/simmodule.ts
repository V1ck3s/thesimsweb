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
  /** ObjectModule::DisableBuyAndBuild: the object that disabled buy and build modes (0 = enabled). */
  buyBuildDisabledBy = 0;

  constructor(
    readonly sim: Simulator,
    readonly res: SimResources,
    placed: Iterable<XObject>,
  ) {
    for (const x of placed) {
      const o = new SimObject(x, this);
      const id = x.objectId;
      while (this.objects.length < id) {
        this.objects.push(null);
        this.simFlags.push(0xffff);
      }
      this.objects[id - 1] = o;
      this.simFlags[id - 1] = x.isPerson ? 0xffff : x.simFlags >>> 0;
      this.list.push(o);
      if (x.isPerson) this.people.push(o);
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
    const parts = this.list.filter((x) => x.obj.mtLeadId === lead || x.id === lead);
    const i = parts.indexOf(o);
    return parts[i + 1] ?? this.getObject(lead);
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
