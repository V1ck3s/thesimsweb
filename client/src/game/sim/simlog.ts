/**
 * SimLog (lbl_105BA390, SimLogging.cpp): the "sim_log begin|end" cheat.
 *
 * While logging, every person's tick (cXPerson::Simulate, SimTickCompleted)
 * is counted against its current interaction. When the interaction changes,
 * the one that ended becomes a sample of its LogInteraction (object GUID and
 * the interaction's TTAB string index): the tick it started, its total,
 * animation (current primitive 0x2c) and routing ticks, whether it succeeded
 * (the last action's flag 0x20, the tree's result, or always for interactions
 * without an object) and how much each motive changed (mood, energy,
 * comfort, hunger, hygiene, bladder, room, social, fun: motives 3, 5..9,
 * 13..15). "sim_log end" (EndLogging) writes every sample to SimLog.txt (here
 * a download), shows "Logging completed..." under "Sim Logging" and clears
 * the log.
 *
 * Not kept from the original: the tracker's copy of the person data
 * (+0x50, never read). The selectors the original looks up by GUID when
 * printing (ObjectFolder::GetSelectorByGUID) are the ones the GUIDs came from,
 * kept with them here.
 */

import type { ObjSelector } from "../world/objselector.js";
import { MOTIVE } from "./motives.js";
import type { PersonSim } from "./person.js";
import type { SimModule } from "./simmodule.js";

/** lbl_105BBC40 strings. */
const S = {
  file: "SimLog.txt",
  object: "Object\t",
  interaction: "Interaction\t",
  tab: "\t",
  done: "Logging completed and written to SimLog.txt in the Sims directory.",
  cantOpen: "File SimLog.txt in the Sims directory could not be opened!",
  title: "Sim Logging",
  self: "Self",
  idle: "Idle",
  newline: "\n",
  header: [
    "Start Time", "Total Ticks", "Anim Ticks", "Routing Ticks", "Result", "Mood", "Energy", "Comfort", "Hunger",
    "Hygiene", "Bladder", "Room", "Social", "Fun", "Person Running",
  ],
  ok: "",
  failed: "failed",
} as const;

/** LogPersonState's motives (cXPerson +0x798, +0x7a0..+0x7b0, +0x7c0..+0x7c8). */
const LOGGED_MOTIVES = [MOTIVE.mood, MOTIVE.energy, MOTIVE.comfort, MOTIVE.hunger, MOTIVE.hygiene, MOTIVE.bladder, MOTIVE.room, MOTIVE.social, MOTIVE.fun];

/** TreeSim::GetCurrentPrimitive's animation primitive. */
const PRIM_ANIMATE = 0x2c;

/** LogInteractionSample (0x3c bytes). */
interface Sample {
  /** +0: the person (its GUID; the selector for Print). */
  person: ObjSelector | null;
  personGuid: number;
  /** +4..+0x24: motive changes. */
  motives: number[];
  /** +0x28 total, +0x2c animation, +0x30 routing ticks, +0x34 start tick, +0x38 success. */
  total: number;
  anim: number;
  routing: number;
  start: number;
  ok: boolean;
}

/** LogPersonTracker (0x250 bytes). */
interface Tracker {
  /** +0 person GUID, +4 its object id. */
  guid: number;
  id: number;
  /** +8 the interaction's object (master GUID), +0xc its object id, +0x10 the interaction's TTAB string index. */
  objGuid: number;
  objSel: ObjSelector | null;
  objId: number;
  index: number;
  /** +0x14..+0x4c: the running sample (motives absolute until the interaction ends). */
  sample: Sample;
}

/** LogInteraction (0x1c bytes). */
interface LoggedInteraction {
  guid: number;
  index: number;
  /** +8 the object's catalog name, +0xc the interaction's name. */
  objectName: string;
  name: string;
  samples: Sample[];
}

/** LogPersonState(person): its GUID and the logged motives (null: zeros). */
function personState(p: PersonSim | null): { sel: ObjSelector | null; guid: number; motives: number[] } {
  if (!p) return { sel: null, guid: 0, motives: LOGGED_MOTIVES.map(() => 0) };
  const m = p.motives;
  return { sel: p.obj.selector, guid: p.obj.selector.guid | 0, motives: LOGGED_MOTIVES.map((i) => m[i]!) };
}

/** printf "%f". */
function f6(v: number): string {
  return v.toFixed(6);
}

export class SimLog {
  /** +0 */
  logging = false;
  /** +4 */
  private interactions: LoggedInteraction[] = [];
  /** +0x10 */
  private trackers: Tracker[] = [];

  /** SimLog::BeginLogging */
  beginLogging(): void {
    this.logging = true;
  }

  /**
   * SimLog::EndLogging: the text of SimLog.txt ("Object", "Interaction", the
   * sample header, then one line per sample), then the log is cleared.
   */
  endLogging(): string {
    let text = S.object + S.interaction;
    // LogInteractionSample::PrintHeader
    for (const h of S.header) text += h + S.tab;
    text += S.newline;
    for (const li of this.interactions) {
      for (const s of li.samples) {
        text += li.objectName + S.tab + li.name + S.tab;
        // LogInteractionSample::Print
        text += `${s.start}${S.tab}${s.total}${S.tab}${s.anim}${S.tab}${s.routing}${S.tab}${s.ok ? S.ok : S.failed}${S.tab}`;
        for (const v of s.motives) text += f6(v) + S.tab;
        text += s.person ? s.person.name + S.tab : String(s.personGuid);
        text += S.newline;
      }
    }
    this.interactions = [];
    this.trackers = [];
    this.logging = false;
    return text;
  }

  /** SimLog::SimTickCompleted(person), at the end of the person's tick. */
  simTickCompleted(p: PersonSim): void {
    if (!this.logging) return;
    const guid = p.obj.selector.guid | 0;
    let t = this.trackers.find((x) => x.guid === guid && x.id === p.id);
    if (!t) {
      const z = personState(null);
      t = {
        guid,
        id: p.id,
        objGuid: -1,
        objSel: null,
        objId: 0,
        index: -1,
        sample: { person: z.sel, personGuid: z.guid, motives: z.motives, total: 0, anim: 0, routing: 0, start: 0, ok: false },
      };
      this.trackers.push(t);
    }
    const m = p.module;
    const action = p.currentAction;
    const obj = action ? m.getObject(action.target) : null;
    const master = obj ? obj.obj.selector.getMasterSelector() : null;
    const objGuid = master ? master.guid | 0 : 0;
    const objId = obj ? obj.id : 0;
    const index = obj && action ? action.ttabIndex : -1;
    if (objGuid !== t.objGuid || objId !== t.objId || index !== t.index) {
      let li = this.interactions.find((x) => x.guid === t.objGuid && x.index === t.index);
      if (!li) {
        li = this.logInteraction(m, t);
        this.interactions.push(li);
      }
      const s = t.sample;
      // The result of the interaction that ended: the last action's 0x20 (its tree returned true).
      s.ok = li.guid === 0 ? true : p.lastActionResult;
      const now = personState(p);
      s.motives = s.motives.map((v, i) => Math.fround(now.motives[i]! - v));
      if (s.total !== 0) li.samples.push({ ...s, motives: [...s.motives] });
      // LogPersonTracker::SetInteraction
      t.objGuid = objGuid;
      t.objSel = master;
      t.objId = objId;
      t.index = index;
      t.sample = { person: now.sel, personGuid: now.guid, motives: now.motives, total: 0, anim: 0, routing: 0, start: m.sim.tickCount, ok: s.ok };
    }
    t.sample.total++;
    if (p.route === null) {
      if (p.getCurrentPrimitive() === PRIM_ANIMATE) t.sample.anim++;
    } else t.sample.routing++;
  }

  /** LogInteraction::LogInteraction(tracker): "Self" / "Idle" without an object, else its catalog name and the TTAB entry's name. */
  private logInteraction(m: SimModule, t: Tracker): LoggedInteraction {
    const li: LoggedInteraction = { guid: t.objGuid, index: t.index, objectName: S.self, name: S.idle, samples: [] };
    const sel = t.objSel;
    if (!sel) return li;
    li.objectName = sel.getMasterSelector().getCatalogName();
    li.name = m.treeTableOf(sel)?.entries.find((e) => e.stringIndex === t.index)?.name ?? "";
    return li;
  }
}

/** lbl_105BA390: the one SimLog. */
export const simLog = new SimLog();

/** S.file and the dialog strings for the cheat. */
export const SIM_LOG_STRINGS = { file: S.file, done: S.done, cantOpen: S.cantOpen, title: S.title } as const;
