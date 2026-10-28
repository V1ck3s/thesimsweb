/**
 * ObjectModule::UpdateSimObjects (called by ObjectModule::Load after the
 * objects are read, before CheckIntegrity): every lot holds exactly one
 * instance of each "sim object" of the object folder, the definitions whose
 * OBJD type (+0x12) is 7 or 0xc and whose OBJD +0x54 is set: the NPC
 * controllers, the help systems, the phone plugins (Go Downtown, Vacation,
 * Neighborhood, Studio...), the expansion lot controllers, the inventory
 * tokens. A missing one is made out of the world (MakeNewOutOfWorldObject:
 * Reset(1) runs its Init, then ObjectModule::PostLoad its Load tree); a
 * second instance of the same selector is killed.
 *
 * This is how a lot saved before an expansion (or a fresh template lot) gets
 * the expansion's controllers: the template houses only carry the base
 * game's (NPC Controller, Visit Generator, Job Finder).
 */

import type { SimModule } from "../sim/simmodule.js";
import type { ObjectFolder } from "./objectfolder.js";
import type { XObject } from "./objects.js";
import { killObject, makeNewOutOfWorldObject } from "./tools/objectfactory.js";
import type { Placement } from "./tools/placement.js";

/** ObjectModule +0x84 is set to the AnimTester's id (GUID 0x3eec206c). */
export const GUID_ANIM_TESTER = 0x3eec206c;

/**
 * ObjectModule::UpdateSimObjects over the lot's module. `sim` (when the lot
 * simulates) gets the new objects through the placement hooks (their Init
 * runs) and opens, beforehand, the objects their trees create.
 * Returns the AnimTester's id (0 when none).
 */
export async function updateSimObjects(p: Placement, folder: ObjectFolder, sim: SimModule | null): Promise<number> {
  const selectors = (await Promise.all(folder.simObjectGUIDs().map((g) => folder.getSelectorByGUID(g).catch(() => null)))).filter((s) => s !== null);
  if (sim) {
    // The original folder holds every object: the Init trees below may create
    // objects synchronously (Create Object Instance), so their files open first.
    for (const s of selectors) sim.behaviorOf(s);
    await Promise.all([...sim.createdObjectGUIDs()].map((g) => folder.getSelectorByGUID(g >>> 0).catch(() => null)));
  }
  // The objects of the module whose OBJD +0x54 is set.
  const flagged: XObject[] = [...p.module.objects.values()].filter((o) => o.selector.objd.i16(0x54) !== 0);
  let animTester = 0;
  const made: XObject[] = [];
  for (const sel of selectors) {
    const t = sel.objd.objectType;
    if ((t !== 7 && t !== 0xc) || sel.objd.i16(0x54) === 0) continue;
    let id = 0;
    for (const o of flagged.filter((x) => (x.selector.guid | 0) === (sel.guid | 0))) {
      if (id === 0) {
        id = o.objectId;
        continue;
      }
      // A second instance: ObjectModule::KillObjectOutOfWorld (OnKill, Cleanup).
      killObject(p, o);
      flagged.splice(flagged.indexOf(o), 1);
    }
    if (id === 0) {
      const x = makeNewOutOfWorldObject(p, folder, sel);
      id = x?.objectId ?? 0;
      if (x) made.push(x);
    }
    if ((sel.guid | 0) === GUID_ANIM_TESTER) animTester = id;
  }
  // ObjectModule::PostLoad follows Load: the new objects' Load trees run too
  // (the expansion controllers kill themselves there on the lots they do not serve).
  if (sim) {
    for (const x of made) {
      const o = sim.getObject(x.objectId);
      if (o && o.obj === x && !o.killed) sim.sim.postLoadObject(o);
    }
  }
  return animTester;
}
