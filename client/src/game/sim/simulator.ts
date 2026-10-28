/**
 * cSimulator (Simulator.cpp): the clock, the money, the globals and the
 * tick loop over the ObjectModule.
 *
 * Fields (byte offsets): +0x10 globals[0x40] (global i at +0x10 + 2i):
 *   0 hour, 1 day of month, 4 time of day (0 day, 1 dusk, 2 night, 3 dawn),
 *   5 minute, 6 second, 7 month, 8 year, 10 house number, 11 stop request,
 *   13 / 14 funds % 10000 / funds / 10000, 16 speed, 17 paused,
 *   18 speed saved while suspended (-1 none), 19 mode freeze (from CPState),
 *   20 installed packs, 23 lot size, 28 days running, 29 days in month,
 *   32 free funds (1: GetFunds answers 999999).
 * +0x90 funds, +0x98 ticks run, +0xac the simulation's random seed (the
 * global seed is swapped in around TickAllObjects), +0xb8 / +0xbc last time
 * and accumulated milliseconds, +0xc0 milliseconds per tick (SetSpeed),
 * +0x1b0 the id TickAllObjects is at (it resumes there after a stop).
 * Each tick is two game seconds.
 */

import { invalidateAllRoutes } from "./portals.js";
import { loadNeighborhood } from "../data/neighborhood.js";
import { loadSimCareers } from "./careers.js";
import { VBAnimMgr } from "../sims/vbanimmgr.js";
import { Mode, type CPState } from "../cpstate.js";
import { ResFile } from "../world/iffres.js";
import { FixedWorld } from "../world/world.js";
import { loadStringSet } from "./behavior.js";
import type { XObject } from "../world/objects.js";
import type { ObjSelector } from "../world/objselector.js";
import { getNextRandomNumber, getSRandSeed, setSRandSeed } from "../world/random.js";
import { ReconBuffer } from "../world/reconbuffer.js";
import { EP } from "./objfntable.js";
import { SimModule, SimResources } from "./simmodule.js";
import { treeSimGlobals } from "./treesim.js";
import type { SimObject } from "./xobject.js";
import type { PersonSim } from "./person.js";

/** Global indexes. */
export const G = {
  hour: 0,
  day: 1,
  /** cSimulator::DoCommand(0xe4): the selected person's object id (0 for none). */
  selectedPerson: 3,
  timeOfDay: 4,
  minute: 5,
  second: 6,
  month: 7,
  year: 8,
  houseNumber: 10,
  stop: 11,
  fundsLow: 13,
  fundsHigh: 14,
  speed: 16,
  paused: 17,
  suspendedSpeed: 18,
  modeFreeze: 19,
  packs: 20,
  lotSize: 23,
  daysRunning: 28,
  daysInMonth: 29,
  freeFunds: 32,
  machineLevel: 33,
} as const;

/**
 * Globs::Globs's machine level (app +0x6a): 0 below 129 MB of RAM or
 * 600 MHz, 1 below 193 MB or 1000 MHz, else 2. Any machine running the
 * browser game is above both.
 */
const MACHINE_LEVEL = 2;

/** SetSpeed constants (lbl_1059A758): period = 172 - speed / 1000 * 171 ms, rounded. */
const PERIOD_SLOWEST = 172;
const PERIOD_RANGE = 171;
const SPEED_SCALE = 1000;
/** cWinViewControl speed buttons (lbl_1059B8D8): speed = 1000 * k. */
const SPEED_BUTTONS = [0.7602, 0.924, 0.99415] as const;
/** PulseGenerator::SetMaxPulses(0x1e). */
const MAX_PULSES = 0x1e;

/** GameTime::CountDaysInMonth returns 30 for every month. */
function countDaysInMonth(): number {
  return 30;
}

/** cSimulator::GetTimeOfDay class of an hour (SetCurrentHour). */
function timeOfDay(hour: number): number {
  if (hour < 6) return 2;
  if (hour < 7) return 3;
  if (hour < 0x12) return 0;
  if (hour < 0x13) return 1;
  return 2;
}

/** cSimulator::PeriodToSimSpeed */
export function periodToSimSpeed(period: number): number {
  return Math.trunc(0.5 + SPEED_SCALE * ((PERIOD_SLOWEST - period) / PERIOD_RANGE));
}

export class Simulator {
  /** +0x10 */
  readonly globals = new Int16Array(0x40);
  /** +0x90 */
  funds = 0;
  /** +0x98 */
  tickCount = 0;
  /** +0xac */
  seed = 0;
  /** +0xbc */
  private accumulated = 0;
  /** +0xb8 */
  private lastMs = 0;
  /** +0xc0 */
  period = 42;
  /** +0x1b0 */
  private cursor = 0;
  /**
   * lbl_105BA320: the scratch TreeTableEntry whose advertisements check trees
   * read and write (scopes 12, 28, 29), one [personality, min, delta] per
   * motive. ObjTestSim::TestInteraction copies the tested entry in when the
   * caller wants the result (autonomy); otherwise it keeps the last one.
   */
  currentAd: Int16Array[] = Array.from({ length: 16 }, () => new Int16Array(3));
  module!: SimModule;
  /** Objects whose Init / Load trees failed at load (id -> code). */
  readonly loadErrors = new Map<number, number>();
  /** CPState to keep in sync (clock, funds, speed, pause, mode). */
  state: CPState | null = null;
  /** The lot's tile arrays (routing). */
  world: FixedWorld | null = null;
  /** Tick the people (cXPerson); false keeps them frozen (debug). */
  static simulatePeople = true;
  /**
   * lbl_105BA214 (byte 1 in the data section; a cheat command stores into
   * it): cXObject::PostLoad restarts objects whose trees changed since the
   * save only while it is set.
   */
  static resetChangedTrees = true;

  /** cSimulator::Init defaults. */
  constructor() {
    const g = this.globals;
    g[G.speed] = 2;
    g[G.hour] = 1;
    g[G.day] = 0xf;
    g[G.minute] = 0;
    g[G.month] = 6;
    g[G.year] = 0x7cd;
    g[G.timeOfDay] = 2;
    g[G.suspendedSpeed] = -1;
    this.seed = getSRandSeed();
    this.setSpeed(Math.trunc(0.5 + SPEED_SCALE * SPEED_BUTTONS[0]));
  }

  /**
   * Builds the simulator of a loaded lot: cSimulator::DoStream of the house's
   * SIMI chunk, then ObjectModule::PostLoad's tree part. `gameEdition` is
   * the installed-pack mask (app +0x66, ObjectFolder.packs).
   */
  static async create(house: ResFile, objects: Iterable<XObject>, gameEdition = 0): Promise<Simulator> {
    const sim = new Simulator();
    sim.readSimi(house);
    // House::LoadFile: the game edition (global 0x14, set by cSimulator::Init
    // from app +0x66) is kept across the SIMI load, then global 0x21 := the
    // machine level (app +0x6a) and 0x20 := 0. Expansion objects' Load trees
    // kill the object when the game edition is 0.
    sim.globals[G.packs] = gameEdition;
    sim.globals[G.machineLevel] = MACHINE_LEVEL;
    sim.globals[G.freeFunds] = 0;
    const placed = [...objects];
    const res = await SimResources.load();
    await res.prepare(placed.map((o) => o.selector));
    // Objects created later (buy / build mode) need their semi-globals synchronously.
    await res.prepareAll();
    sim.module = new SimModule(sim, res, placed);
    try {
      sim.world = FixedWorld.load(house);
    } catch {
      sim.world = null;
    }
    const nbhdDir = house.name.split("/")[0] ?? "UserData";
    sim.module.initPeople(await loadNeighborhood(nbhdDir).catch(() => null));
    // Neighborhood::Load reads the lot zoning from <neighborhood>/LotZoning.iff.
    const zoning = await ResFile.open(`${nbhdDir}/LotZoning.iff`).catch(() => null);
    if (zoning) sim.module.loadZoning(loadStringSet(zoning, 1) ?? []);
    // LoadCareers: one cCareer per CARR chunk of work.iff, in index order (GetCareers).
    sim.module.careers = await loadSimCareers();
    // SAnimator::Initialize: a skeleton per person (the lot view attaches its VitaBoy's instead).
    for (const p of sim.module.persons) await Simulator.attachSkeleton(p);
    sim.module.onPersonMade = (p) => void Simulator.attachSkeleton(p);
    sim.postLoad();
    return sim;
  }

  /**
   * SAnimator::Initialize's skeleton for a person (adult or child) until the
   * lot view attaches its VitaBoy's: people made at run time (NPCs, visitors,
   * arrivals) get one too, or their walks never start.
   */
  static async attachSkeleton(p: PersonSim): Promise<void> {
    const mgr = await VBAnimMgr.get().catch(() => null);
    const sk = await mgr?.findSkeleton(p.isChild ? "child" : "adult").catch(() => null);
    if (sk && !p.animator.skeleton) p.animator.attach(sk.clone());
  }

  /** cSimulator::DoStream (read; versions > 0x40 keep 0x40 globals). */
  private readSimi(house: ResFile): void {
    const payload = house.get("SIMI", 1) ?? house.list("SIMI").map((c) => house.payload(c))[0];
    if (!payload) return;
    const { buf, version: v } = ReconBuffer.fromChunk(payload);
    const keep25 = this.globals[25]!;
    const n = v < 0x12 ? 0x10 : v < 0x41 ? 0x20 : 0x40;
    for (let i = 0; i < n; i++) this.globals[i] = buf.recon16();
    if (v < 0x12) this.globals[G.speed] = buf.recon32();
    else this.globals[25] = keep25;
    this.tickCount = buf.recon32();
    this.cursor = buf.recon16();
    if (v > 1) this.funds = buf.recon32();
    if (v > 0xd) {
      this.seed = buf.recon32();
      // The global seed is restored only on residential lots (zoning type 1); houses are.
      setSRandSeed(buf.recon32());
    }
    if (v >= 0xf) this.funds += buf.recon32();
    this.setFundsGlobals();
    // Versions < 0x15 store the speed button; later ones the speed itself.
    const speed = this.globals[G.speed]!;
    this.setSpeed(speed > 0 ? speed : Math.trunc(0.5 + SPEED_SCALE * SPEED_BUTTONS[0]));
  }

  /** ObjectModule::PostLoad -> cXObject::PostLoad for every object (the tree part). */
  private postLoad(): void {
    const m = this.module;
    const n = m.people.length;
    // ObjectModule::AddObject: objects * 15 + 10000 + characters^2 * 15 (characters: the people on the lot here).
    treeSimGlobals.maxPrimitives = m.count * 0xf + 10000 + n * n * 0xf;
    for (const o of m.list) {
      const saved = o.obj.savedStack;
      if (saved && saved.frames.length) {
        o.stack.restore(
          saved.memBytes,
          saved.frames.map((f) => ({ ...f, behavior: f.selector ? m.behaviorOf(f.selector) : null })),
        );
      }
    }
    const versions = new Map<ObjSelector, boolean>();
    for (const o of m.list) this.postLoadObject(o, versions);
  }

  /** cXObject::PostLoad (the tree part) of one object; ObjectModule::PostLoad runs it for every object of the module. */
  postLoadObject(o: SimObject, versions = new Map<ObjSelector, boolean>()): void {
    const m = this.module;
    // cXObject::PostLoad ends with sim flag 8 = CanChooseAutonomously (people too:
    // without it nobody picks a social interaction on them autonomously).
    m.setSimFlag(o.id, 8, o.canChooseAutonomously());
    if (o.isPerson && !Simulator.simulatePeople) {
      m.setSimFlag(o.id, 1, false);
      return;
    }
    try {
      const load = o.fnTable.getTreeID(EP.load);
      if (load !== 0) o.runCheckTree(o.behavior, 0, load, null);
      // cXObject::PostLoad: changed trees (ObjSelector +0xb4 bit 1, with
      // lbl_105BA214 set) or the standard placeholder: ObjectModule::CleanupPeople
      // and Cleanup(0); changed trees then rerun Init. (An object saved
      // without a stack is also restarted here: it would underflow on its
      // first tick.)
      const changed = Simulator.resetChangedTrees && this.treeVersionChanged(o, versions);
      const empty = o.stack.getStackSize() === 0;
      if (changed || o.obj.isPlaceholder || empty) {
        m.cleanupPeople(o);
        o.cleanup();
        const init = changed || empty ? o.fnTable.getTreeID(EP.init) : 0;
        if (init !== 0) o.runCheckTree(o.behavior, 0, init, null);
      }
    } catch (e) {
      const code = (e as { code?: number }).code;
      if (code === undefined) throw e;
      this.loadErrors.set(o.id, code);
      o.errorCode = code;
      o.error(code);
    }
    m.setSimFlag(o.id, 2, o.obj.objectData[60]! !== 0);
  }

  /**
   * ObjectSaveTypeTable::DoStream (read) sets ObjSelector +0xb4 bit 1 when
   * the type's saved init / main cumulative tree versions differ from the
   * installed trees' (ObjSelector::GetInitTreeVersion / GetMainTreeVersion);
   * a version 0 table saved none and flags the person types. Cached per
   * selector like the selector bit.
   */
  private treeVersionChanged(o: SimObject, cache: Map<ObjSelector, boolean>): boolean {
    const sel = o.obj.selector;
    let changed = cache.get(sel);
    if (changed === undefined) {
      const saved = o.obj.savedTreeVersions;
      if (!saved) {
        changed = o.isPerson;
      } else {
        const b = this.module.behaviorOf(sel);
        changed =
          saved.init !== b.getCumulativeTreeVersion(o.fnTable.getTreeID(EP.init)) ||
          saved.main !== b.getCumulativeTreeVersion(o.fnTable.getTreeID(EP.main));
      }
      cache.set(sel, changed);
    }
    return changed;
  }

  // --- clock / speed ----------------------------------------------------------------

  /** cSimulator::SetSpeed (0..1000). */
  setSpeed(speed: number): void {
    const s = Math.min(1000, Math.max(0, speed));
    this.globals[G.speed] = s;
    this.period = Math.trunc(0.5 + (PERIOD_SLOWEST - (s / SPEED_SCALE) * PERIOD_RANGE));
    this.accumulated = 0;
    this.lastMs = 0;
  }

  /** The speed for a CPState speed button (1..3). */
  static speedForButton(button: number): number {
    const k = SPEED_BUTTONS[Math.min(3, Math.max(1, button)) - 1]!;
    return Math.trunc(0.5 + SPEED_SCALE * k);
  }

  isPaused(): boolean {
    return this.globals[G.paused]! !== 0;
  }
  pause(): void {
    this.globals[G.paused] = 1;
  }
  resume(): void {
    if (this.globals[G.paused] === 0) return;
    this.globals[G.paused] = 0;
    this.accumulated = 0;
    this.lastMs = 0;
  }

  /** cSimulator::SetCurrentHour. */
  setCurrentHour(hour: number, minute: number): void {
    this.globals[G.hour] = hour;
    this.globals[G.minute] = minute;
    this.updateTimeOfDay();
  }

  private updateTimeOfDay(): void {
    const t = timeOfDay(this.globals[G.hour]!);
    // cTerrain::SetColor follows (terrain tint per time of day; not wired).
    if (t !== this.globals[G.timeOfDay]) this.globals[G.timeOfDay] = t;
  }

  // --- money ------------------------------------------------------------------------

  /** cSimulator::GetFunds */
  getFunds(): number {
    return this.globals[G.freeFunds] === 1 ? 999999 : this.funds;
  }

  /** cSimulator::Spend (the expense history per type is not kept). */
  spend(_expense: number, amount: number): void {
    if (this.globals[G.freeFunds] === 1) return;
    this.funds -= amount;
    this.setFundsGlobals();
    this.state?.setFunds(this.funds);
  }

  /** cSimulator::SetFunds */
  setFunds(funds: number): void {
    if (this.globals[G.freeFunds] !== 0) return;
    this.funds = funds;
    this.setFundsGlobals();
  }

  private setFundsGlobals(): void {
    const hi = Math.trunc(this.funds / 10000);
    this.globals[G.fundsHigh] = hi;
    this.globals[G.fundsLow] = this.funds - hi * 10000;
  }

  /** GetNextRandomNumber with the simulation seed in place (TickAllObjects runs with it). */
  random(): number {
    return getNextRandomNumber();
  }

  // --- ticking ----------------------------------------------------------------------

  /** CPState -> simulator (CPState::UpdateWorldFromCPState's speed / pause / mode part). */
  syncFromState(): void {
    const s = this.state;
    if (!s) return;
    const mode = s.getMode();
    const freeze = mode === Mode.Live ? 0 : mode === Mode.Build ? 1 : mode === Mode.Buy ? 2 : mode;
    // House::EnterLiveMode: ObjectModule::InvalidateAllRoutes.
    if (freeze === 0 && this.globals[G.modeFreeze] !== 0) invalidateAllRoutes(this.module);
    this.globals[G.modeFreeze] = freeze;
    const speed = Simulator.speedForButton(s.getSpeed());
    if (speed !== this.globals[G.speed]) this.setSpeed(speed);
    if (s.isPaused()) this.pause();
    else this.resume();
    // ObjectModule::SetSelectedPerson -> GlobalDispatch(0xe4, id) -> cSimulator::DoCommand: global 3.
    const guid = s.personGetSelected()?.guid;
    const sel = guid === undefined ? null : this.module.persons.find((p) => !p.killed && (p.obj.selector.guid | 0) === (guid | 0));
    this.globals[G.selectedPerson] = sel ? sel.id : 0;
  }

  /**
   * cSimulator::Simulate: runs the ticks due since the last call (one per
   * `period` milliseconds, PulseGenerator capping a burst at 30).
   */
  simulate(nowMs: number): number {
    if (this.lastMs === 0) this.accumulated = this.period;
    else this.accumulated += nowMs - this.lastMs;
    this.lastMs = nowMs;
    let n = 0;
    while (this.accumulated >= this.period && n < MAX_PULSES) {
      this.accumulated -= this.period;
      this.simulateOneTick();
      n++;
      if (this.globals[G.stop] !== 0) {
        this.globals[G.stop] = 0;
        break;
      }
    }
    if (n === MAX_PULSES) this.accumulated = 0;
    return n;
  }

  /** cSimulator::SimulateOneTick. */
  simulateOneTick(): boolean {
    const saved = getSRandSeed();
    setSRandSeed(this.seed);
    const advanced = this.tickAllObjects();
    this.seed = getSRandSeed();
    setSRandSeed(saved);
    if (advanced) {
      this.tickCount++;
      const g = this.globals;
      g[G.second] = g[G.second]! + 2;
      if (g[G.second]! > 0x3b) {
        g[G.second] = g[G.second]! - 0x3c;
        g[G.minute] = g[G.minute]! + 1;
        if (g[G.minute]! > 0x3b) {
          g[G.minute] = g[G.minute]! - 0x3c;
          g[G.hour] = g[G.hour]! + 1;
          if (g[G.hour]! > 0x17) {
            // ObjectModule::DayChanged / the expense history / family history are not ported.
            g[G.daysRunning] = g[G.daysRunning]! + 1;
            g[G.hour] = g[G.hour]! - 0x18;
            g[G.day] = g[G.day]! + 1;
            if (g[G.day]! > countDaysInMonth()) {
              g[G.day] = 1;
              g[G.month] = g[G.month]! + 1;
              if (g[G.month]! > 0xc) {
                g[G.month] = 1;
                g[G.year] = g[G.year]! + 1;
              }
              g[G.daysInMonth] = countDaysInMonth();
            }
          }
          this.updateTimeOfDay();
        }
        this.pushClock();
      }
    }
    // ObjectModule::PostSim: object dialogs are recorded only; the kill queue runs here.
    this.module.runKillQueue();
    if (advanced) this.pushPeople();
    return advanced;
  }

  /**
   * UpdateCPStateFromWorld's people part: the family's motives and person
   * data (the Live panel reads them each pump) come from their cXPerson.
   */
  private pushPeople(): void {
    const s = this.state;
    if (!s) return;
    for (const info of s.family) {
      if (info.guid === undefined) continue;
      const p = this.module.persons.find((x) => (x.obj.selector.guid | 0) === (info.guid! | 0));
      if (!p) continue;
      for (let i = 0; i < 16; i++) info.motives[i] = p.motives[i]!;
      info.personData = p.pd;
    }
  }

  /** The clock as CPState shows it (UpdateCPStateFromWorld). */
  private pushClock(): void {
    const g = this.globals;
    this.state?.setTime(this.state.getTime().day, g[G.hour]! * 60 + g[G.minute]!);
  }

  /**
   * cSimulator::TickAllObjects: every object by id, from where the last
   * call stopped. Frozen (paused, or not in live mode on a lot) only objects
   * flagged "tick while paused" run and time does not advance. Returns
   * false when it stopped early (an error was handled, or an object's
   * stack broke): the next tick resumes at that object.
   */
  tickAllObjects(): boolean {
    const g = this.globals;
    const frozen = g[G.paused] !== 0 || (g[G.modeFreeze] !== 0 && g[G.houseNumber] !== 0);
    const m = this.module;
    if (this.cursor === 0) this.cursor = 1;
    for (; this.cursor <= m.count; this.cursor++) {
      const o = m.getObject(this.cursor);
      if (!o) continue;
      const id = this.cursor;
      if (m.getSimFlags(id) & 0x40000) {
        if (o.getError() !== 0) {
          o.handleError();
          return false;
        }
        m.setSimFlag(id, 4, false);
      }
      const f = m.getSimFlags(id);
      if (!(f & 0x10000) || (frozen && !(f & 0x20000))) continue;
      const idle = (f << 16) >> 16;
      if (idle < 1) {
        if (!o.simulate()) return false;
      } else {
        m.setIdleCounter(id, idle - 1);
      }
    }
    this.cursor = 0;
    return !frozen;
  }

  /** Per-object summary for traces. */
  trace(): Array<{ id: number; name: string; tree: string; node: number; depth: number; prims: number; errors: number; idle: number; flags: number }> {
    return this.module.list.map((o: SimObject) => {
      const e = o.getCurElem();
      const prims = [...o.primCounts.values()].reduce((a, b) => a + b, 0);
      return {
        id: o.id,
        name: o.obj.selector.name,
        tree: e ? `${e.getTreeID()} ${e.behavior?.getTreeName(e.getTreeID()) ?? ""}` : "-",
        node: e?.node ?? -1,
        depth: o.getStackSize(),
        prims,
        errors: o.errors.length,
        idle: this.module.idleCounter(o.id),
        flags: this.module.getSimFlags(o.id) >>> 16,
      };
    });
  }
}

