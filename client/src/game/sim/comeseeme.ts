/**
 * ComeSeeMe.cpp: the "come and see me" helpers (Objects.far comeandsee.iff,
 * an invisible object whose interaction draws the family to an object just
 * bought). CPState::SetMode runs UpdateComeSeeMeObjects when the game goes
 * back to Live mode (cpstate.ts enterLiveModeHooks).
 *
 *  - UpdateComeSeeMeObjects (Mac 100577c0): nothing without the comeandsee
 *    selector, on lots 0x15..0x1e, 0x51..0x59 (downtown, studio town) and
 *    0x28..0x31 (vacation), or on a lot of zoning type 2. Otherwise, for each
 *    object in module order of OBJD type 4 (buy mode), in the world, shown
 *    (object data 34 clear), without flag 0x4000 (object data 8) and that is
 *    not a multi-tile part other than the lead: its come-see-me object
 *    (GetComeSeeMe); none, the object less than a minute old
 *    (cXObject::GetAgeInMinutes 0) and a residential lot (zoning type 1):
 *    a new one (MakeNewOutOfWorldObject) the object points to (RelMatrix
 *    entry of the new id, size 1, value 1). The come-see-me object then goes
 *    to the object's average location and level (vtable +0x60) unless it is
 *    already there;
 *  - GetComeSeeMe (Mac 10057b60): the first object of the RelMatrix keys
 *    whose selector is comeandsee with a first value above 0;
 *  - GetAverageLocation (Mac 10057c80): a multi-tile object's parts averaged
 *    from the lead (integer division), else the object's own location.
 */

import type { SimModule } from "./simmodule.js";
import type { SimObject } from "./xobject.js";

/** comeandsee.iff's GUID (lbl_105BB814 names it by its OBJD label). */
const COME_SEE_ME_GUID = 0xf3aaa62f;

/** GameTime::GetDaysSince1900: 360-day years of 30-day months (0 before 1900 or for a bad month). */
function daysSince1900(year: number, month: number, day: number): number {
  if (year < 1900 || month < 1 || month > 12) return 0;
  return day - 1 + (month - 1) * 30 + (year - 1900) * 360;
}

/** cXObject::IsInWorld */
function inWorld(o: SimObject): boolean {
  return o.obj.tileX >= 0 && o.obj.tileY >= 0 && o.obj.level >= 1;
}

/** cXObject::GetAgeInMinutes: minutes since the birth date and time (object data 45..47, 24, 21). */
export function ageInMinutes(m: SimModule, o: SimObject): number {
  const g = m.sim.globals;
  const d = o.obj.objectData;
  let minutes = g[5]! - d[21]!;
  let hours = g[0]! - d[24]!;
  let days = daysSince1900(g[8]!, g[7]!, g[1]!) - daysSince1900(d[45]!, d[46]!, d[47]!);
  if (minutes < 0) {
    minutes += 60;
    hours--;
  }
  if (hours < 0) {
    hours += 24;
    days--;
  }
  return minutes + (hours + days * 24) * 60;
}

function getComeSeeMe(m: SimModule, o: SimObject): SimObject | null {
  for (const [id, values] of o.obj.relations) {
    const x = m.getObject(id);
    if (x && !x.killed && x.obj.selector.guid >>> 0 === COME_SEE_ME_GUID && values.length > 0 && values[0]! > 0) return x;
  }
  return null;
}

function averageLocation(m: SimModule, o: SimObject): { fx: number; fy: number } {
  if (o.obj.selector.objd.masterId === 0) return { fx: o.obj.fx, fy: o.obj.fy };
  const leadId = o.obj.mtLeadId || o.id;
  const parts = m.list.filter((x) => !x.killed && (x.id === leadId || x.obj.mtLeadId === leadId));
  let fx = 0;
  let fy = 0;
  for (const p of parts) {
    fx += p.obj.fx;
    fy += p.obj.fy;
  }
  const n = Math.max(1, parts.length);
  return { fx: Math.trunc(fx / n), fy: Math.trunc(fy / n) };
}

/** UpdateComeSeeMeObjects: see the file comment. */
export function updateComeSeeMeObjects(m: SimModule): void {
  const hooks = m.worldHooks;
  const sel = hooks?.selector(COME_SEE_ME_GUID);
  if (!hooks || !sel) return;
  const lot = m.sim.globals[10]!;
  if ((lot > 0x14 && lot < 0x1f) || (lot > 0x50 && lot < 0x5a) || (lot > 0x27 && lot < 0x32)) return;
  if (m.getZoningType(lot) === 2) return;
  for (const o of [...m.list]) {
    if (o.killed || o.obj.selector.objd.objectType !== 4 || !inWorld(o)) continue;
    if (o.obj.objectData[34] !== 0 || o.obj.objectData[8]! & 0x4000) continue;
    if (o.obj.selector.objd.masterId !== 0 && o.obj.mtLeadId !== 0 && o.obj.mtLeadId !== o.id) continue;
    let cs = getComeSeeMe(m, o);
    if (!cs && ageInMinutes(m, o) === 0 && m.getZoningType(lot) === 1) {
      const x = hooks.make(sel);
      if (x) {
        cs = m.addObject(x, true);
        o.obj.relations.set(cs.id, [1]);
      }
    }
    if (!cs) continue;
    const at = averageLocation(m, o);
    if (inWorld(cs) && cs.obj.fx === at.fx && cs.obj.fy === at.fy && cs.obj.level === o.obj.level) continue;
    // vtable +0x60 (at, level, 0, 0, 1), as MoveOutOfWay places its helper.
    hooks.place(cs.obj, at, o.obj.level, null, -1);
    m.dirty(cs);
  }
}
