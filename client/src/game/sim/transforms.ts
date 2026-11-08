/**
 * The simulator's transform requests (cSimulator +0x1a4, a list of
 * TransformInfo), made by generic sim calls 39 / 40 (the Makin' Magic
 * "Grow Me" charm, the "Kid to Adult" and "Pet to Adult" spells).
 *
 *  - RequestTransform (Mac 1012f990): the request {id = the caller's object
 *    id, a = its temp 0 (the person to transform), b = 0, mode 0 (call 39,
 *    ChildToAdult) or 1 (call 40, AnyoneToAdult)} is queued with state 0 and
 *    age 0;
 *  - ExecuteTransforms (Mac 1012f6f0), after each simulated tick (unless
 *    the simulation was stopped): every state-0 request runs its transform;
 *    success sets state 2 and asks for a SaveGame (cSimulator +0xe0), failure
 *    state 3. Then every request ages one tick, and goes at age 100;
 *  - RetrieveDoneTransform (Mac 1012f890): the caller's done request (state
 *    2 or 3) is handed back and removed.
 *
 * Neighborhood::ChildToAdult (Mac 1009e790) redesigns the person in place:
 * PersonFinder's design steps on its body strings (gender kept, the skin of
 * person data 60, person data 0x51 / 0x52 := 0x51 and 0x50 kept, adult, a
 * random body and head suit, SetupNewHDSkins), person data 0xa, 0xb, 0xc,
 * 0xf, 0x11, 0x12, 0x38 and 0x39 (the job) cleared, the name kept, then
 * EndDesignAPerson(save), the family's flag 8 cleared, LoadPersistentData,
 * +0x114 |= 0x1000, Cleanup(0) and TrySnap back to where the person was. A
 * selected person is unselected first (the port's selection follows the
 * control panel, which picks the next one).
 *
 * Neighborhood::AnyoneToAdult (call 40) goes through ChangeSimBaseType: a
 * new character file from the person template takes the old GUID
 * (ObjectFolder::HotSwapSelectorGuid) and the old file and selector go. Not
 * ported: the request fails (state 3).
 */

import { EditPerson, PERSON_AGE_ADULT, type PersonColor } from "../cas/editperson.js";
import { loadStringSet } from "./behavior.js";
import type { SimModule } from "./simmodule.js";

export interface TransformInfo {
  id: number;
  a: number;
  b: number;
  mode: number;
  state: number;
  age: number;
}

/** ChildToAdult's skins by person data 60 (lbl_105BA09C / 98 / 94). */
const SKIN_BY_PD: Record<number, PersonColor> = { 1: "lgt", 2: "drk", 3: "med" };

/** cRZRandom::RandomUint32Uniform(n) */
function randomUniform(n: number): number {
  return Math.floor(Math.random() * n);
}

export class Transforms {
  private readonly list: TransformInfo[] = [];
  /** cSimulator +0xe0: a transform asked for a SaveGame. */
  saveRequested = false;

  constructor(private readonly module: SimModule) {}

  /** cSimulator::RequestTransform */
  request(t: Omit<TransformInfo, "state" | "age">): void {
    this.list.push({ ...t, state: 0, age: 0 });
  }

  /** cSimulator::RetrieveDoneTransform: the done request of `id` (removed), or null. */
  retrieveDone(id: number): TransformInfo | null {
    const i = this.list.findIndex((t) => t.id === id);
    const t = this.list[i];
    if (!t || (t.state !== 2 && t.state !== 3)) return null;
    this.list.splice(i, 1);
    return t;
  }

  /** cSimulator::ExecuteTransforms */
  execute(): void {
    for (const t of this.list) {
      if (t.state !== 0) continue;
      const ok = t.mode === 0 ? this.childToAdult(t) : t.mode === 1 ? this.anyoneToAdult(t) : null;
      if (ok === null) continue;
      if (ok) {
        this.saveRequested = true;
        t.state = 2;
      } else {
        t.state = 3;
      }
    }
    for (let i = 0; i < this.list.length; ) {
      if (++this.list[i]!.age < 100) i++;
      else this.list.splice(i, 1);
    }
  }

  /** Neighborhood::ChildToAdult(a, b): see the file comment. */
  private childToAdult(t: TransformInfo): boolean {
    const m = this.module;
    const p = m.persons.find((x) => !x.killed && x.id === t.a);
    if (!p) return false;
    const pd = p.pd;
    const nb = m.findNeighborByID(pd[0x1f]!);
    if (!nb) return false;
    const sel = p.obj.selector;
    const guid = sel.guid | 0;
    const me = p.obj;
    const at = { fx: me.fx, fy: me.fy };
    const level = me.level;
    const dir = me.objectData[1]!;
    const skin = pd[0x3c]!;
    const gender = pd[65]!;
    const v51 = pd[0x51]!;
    const v50 = pd[0x50]!;
    const strings = m.bodyStringEdits.get(guid) ?? loadStringSet(sel.res, sel.objd.i16(0x26)) ?? [];
    const ep = EditPerson.beginLoaded(strings, pd);
    if (!ep) {
      m.unportedPrim(1, "generic sim call 39 (suit catalog not loaded)", 0);
      return false;
    }
    ep.setGender(gender & 1, false);
    const color = SKIN_BY_PD[skin];
    if (color) ep.setColor(color, false);
    pd[0x51] = v51;
    pd[0x52] = v51;
    pd[0x50] = v50;
    ep.setAge(PERSON_AGE_ADULT, false);
    const bodies = ep.countAvailableBodySuits();
    const heads = ep.countAvailableHeadSuits();
    ep.setBodySuit(bodies > 0 ? randomUniform(bodies) : 0, false);
    ep.setHeadSuit(heads > 0 ? randomUniform(heads) : 0, false);
    ep.setupNewHDSkins();
    for (const i of [0xa, 0xb, 0xc, 0xf, 0x11, 0x12, 0x38, 0x39]) pd[i] = 0;
    // PersonFinder::SetName(catalog name), EndDesignAPerson(save, no kill, no neighborhood save).
    ep.end(true);
    const edited = ep.bodyStrings();
    m.bodyStringEdits.set(guid, edited);
    m.worldHooks?.bodyStringsChanged?.(me, edited);
    m.record(p, "portraitsDirty", guid);
    const fam = m.nbhd?.families.find((f) => f.memberGuids.some((g) => g >>> 0 === guid >>> 0));
    if (fam) fam.flags &= ~8;
    void m.characterHooks
      ?.saveDesignedPerson({ guid, fileKey: sel.fileKey, name: sel.getCatalogName(), bio: sel.getCatalogDescription(), bodyStrings: edited, personData: pd.slice() })
      .catch((e: unknown) => console.warn("[sim] ChildToAdult save", e));
    // +0x114 |= 0x1000, Cleanup(0) (ResetSuits there: age, gender, skin), TrySnap back.
    p.keepRecordObjects = true;
    p.cleanup();
    const hooks = m.worldHooks;
    if (hooks && hooks.canPlace(me, at, level, null, 0)) hooks.place(me, at, level, null, 0);
    me.objectData[1] = dir;
    p.forceLocation();
    m.dirty(p);
    t.b = p.id;
    return true;
  }

  /** Neighborhood::AnyoneToAdult: ChangeSimBaseType is not ported (false). */
  private anyoneToAdult(t: TransformInfo): boolean {
    void t;
    this.module.unportedPrim(1, "generic sim call 40 (ChangeSimBaseType)", 0);
    return false;
  }
}
