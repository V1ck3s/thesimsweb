/**
 * cXPortal routing (cXPortal.cpp): doors, arches and stairs are portals
 * (cXPortal objects, ObjectModule +0x9c). People only path inside their
 * room; to reach another room they walk through portals, each running the
 * portal's "portal" tree (entry point 15), which routes to the portal,
 * animates and moves the person to the other side.
 *
 * Each portal keeps a vector of floats (+0x1ac) indexed by route id - 1.
 * Route ids (object data 6) are given to portals (as Dijkstra sources) and
 * to people (as routes in progress) by FindAvailRouteID. For a portal
 * source the values are distances from that portal (GetDistToPortal, a
 * Dijkstra over the portals: same room or the other side, cost 1 +
 * CalcShortDistance); for a person they are the route's marks: 10001
 * dirty, 10000 unreachable, 1001..1100 walked through on this route (in
 * order), 1101 failed, otherwise the estimated cost through that portal
 * (capped at 1000).
 */

import { EP } from "./objfntable.js";
import { calcShortDistance } from "./routing.js";
import type { SimModule } from "./simmodule.js";
import type { SimObject } from "./xobject.js";

/** lbl_105BBBE8. */
const ABSENT = 0;
const FAILED = 1101;
const FAR = 10000;
const DIRTY = 10001;
const USED_LO = 1001;
const USED_HI = 1100;
const CAP = 1000;

/** cXPortal +0x1ac. */
const dists = new WeakMap<SimObject, number[]>();

function getDist(p: SimObject, id: number): number {
  const d = dists.get(p);
  if (id < 1 || !d || d.length < id) return ABSENT;
  return d[id - 1]!;
}

function setDist(p: SimObject, id: number, v: number): void {
  let d = dists.get(p);
  if (!d) dists.set(p, (d = []));
  // Grown with lbl_105BE87C (10001, dirty).
  while (d.length < id) d.push(DIRTY);
  d[id - 1] = Math.fround(v);
}

/**
 * The portals of the lot (ObjectModule +0x9c): cXPortal objects with a
 * portal tree (the parts of a staircase without one, e.g. its middle
 * steps, are not routed through).
 */
export function portals(module: SimModule): SimObject[] {
  return module.list.filter((o) => o.obj.kind === "portal" && o.fnTable.getTreeID(EP.portal) !== 0);
}

function room(o: SimObject): number {
  return o.obj.objectData[29]!;
}

/** cXPortal::FindAvailRouteID: the lowest id no person nor portal uses (0 when none below 10000). */
export function findAvailRouteID(module: SimModule): number {
  const used = new Set<number>();
  for (const p of module.people) used.add(p.obj.objectData[6]!);
  for (const p of portals(module)) used.add(p.obj.objectData[6]!);
  for (let i = 1; i < 10000; i++) if (!used.has(i)) return i;
  return 0;
}

/**
 * cXPortal::GetOtherSide (Mac 10113c00): from this part, the next part of the
 * multi-tile chain (+0x18c, then the lead +0x190); when this portal's OBJD
 * +0x8a is 1, the first part from the lead, other than the current one, of
 * the current one's OBJD +0x10 group (none when the walk comes back to the
 * lead). That part must be a portal other than this one; without a portal
 * tree the walk goes on from it.
 */
export function getOtherSide(module: SimModule, p: SimObject): SimObject | null {
  const leadId = p.obj.mtLeadId || p.id;
  const chain = module.list.filter((o) => (o.obj.mtLeadId || o.id) === leadId);
  if (chain.length < 2 || !chain.includes(p)) return null;
  const lead = chain.find((o) => o.id === leadId) ?? chain[0]!;
  const ordered = [lead, ...chain.filter((o) => o !== lead)];
  const next = (o: SimObject): SimObject | null => ordered[ordered.indexOf(o) + 1] ?? null;
  const byGroup = p.obj.selector.objd.i16(0x8a) === 1;
  const group = (o: SimObject): number => o.obj.selector.objd.i16(0x10);
  let cur = p;
  for (let guard = 0; guard < ordered.length; guard++) {
    let o: SimObject | null;
    if (byGroup) {
      o = lead;
      while (o === cur || group(o) !== group(cur)) {
        o = next(o);
        if (!o) return null;
      }
    } else {
      o = next(cur) ?? lead;
    }
    if (o === p || o.obj.kind !== "portal") return null;
    if (o.fnTable.getTreeID(EP.portal) !== 0) return o;
    cur = o;
  }
  return null;
}

/** cXPortal::InitPortalRoute(module, person): a route id for the person, every portal dirty for it. */
export function initPortalRoute(module: SimModule, person: SimObject): boolean {
  let id = person.obj.objectData[6]!;
  if (id === 0) {
    id = findAvailRouteID(module);
    person.obj.objectData[6] = id;
  }
  for (const p of portals(module)) setDist(p, id, DIRTY);
  return true;
}

/** cXPortal::DirtyAllRoutes: every mark dirty (walls or portals changed). */
export function dirtyAllRoutes(module: SimModule): void {
  for (const p of portals(module)) {
    const d = dists.get(p);
    if (d) d.fill(DIRTY);
  }
}

/**
 * ObjectModule::InvalidateAllRoutes (House::EnterLiveMode): every person's
 * routes are re-planned on their next step (cXPerson::InvalidateRoutes
 * clears each route's +0x78) and every portal mark is dirty, so walls and
 * doors changed in build mode are taken into account.
 */
export function invalidateAllRoutes(module: SimModule): void {
  for (const p of module.persons) for (const r of p.routes) r.loaded = false;
  dirtyAllRoutes(module);
}

/** cXPortal::GetDistToPortal(from, to): the portal graph distance (computed once per source). */
export function getDistToPortal(module: SimModule, from: SimObject, to: SimObject): number {
  let id = from.obj.objectData[6]!;
  const all = portals(module);
  if (id === 0) {
    id = findAvailRouteID(module);
    from.obj.objectData[6] = id;
    for (const p of all) setDist(p, id, DIRTY);
  }
  const d = dists.get(from);
  if (!d || d.length < id || getDist(from, id) === DIRTY) {
    for (const p of all) setDist(p, id, FAR);
    setDist(from, id, 0);
    const queue: SimObject[] = [from];
    while (queue.length) {
      let bi = queue.length - 1;
      for (let i = queue.length - 2; i >= 0; i--) if (getDist(queue[i]!, id) < getDist(queue[bi]!, id)) bi = i;
      const p = queue.splice(bi, 1)[0]!;
      const other = getOtherSide(module, p);
      for (const q of all) {
        if (room(q) !== room(p) && q !== other) continue;
        if (!(getDist(p, id) < getDist(q, id))) continue;
        const nd = Math.fround(1 + Math.fround(getDist(p, id) + calcShortDistance(p.obj, q.obj)));
        if (nd < getDist(q, id)) {
          setDist(q, id, nd);
          queue.push(q);
        }
      }
    }
  }
  return getDist(to, id);
}

/**
 * cXPortal::FindBestPortal(module, person, target): among the portals of
 * the person's room, the one with the lowest estimated cost to the
 * target's room (person -> portal -> ... -> a portal of the target's room
 * -> target), skipping the unreachable and failed ones and those already
 * walked through on this route. Null when none.
 */
export function findBestPortal(module: SimModule, person: SimObject, target: SimObject): SimObject | null {
  const id = person.obj.objectData[6]!;
  if (id === 0) return null;
  const all = portals(module);
  let best: SimObject | null = null;
  for (const p of all) {
    if (room(p) !== room(person)) continue;
    let v = getDist(p, id);
    if (v === DIRTY) {
      setDist(p, id, FAR);
      const d0 = calcShortDistance(person.obj, p.obj);
      const other = getOtherSide(module, p);
      for (const q of all) {
        if (room(q) !== room(target)) continue;
        const dq = getDistToPortal(module, p, q);
        if (dq === FAR || !other) continue;
        const dother = getDistToPortal(module, other, q);
        if (dother > dq) continue;
        let total = Math.fround(calcShortDistance(q.obj, target.obj) + Math.fround(d0 + dq));
        if (total > CAP) total = CAP;
        if (total < getDist(p, id)) setDist(p, id, total);
      }
      v = getDist(p, id);
    }
    if (v === FAR || v === FAILED) continue;
    if (best && getDist(best, id) <= v) continue;
    best = p;
  }
  return best;
}

/**
 * cXPortal::BeginningPortalTree(module, person, portal): the portal (and
 * its other side) marked as walked through, after the ones already used in
 * this room; walking through it a second time marks it failed.
 */
export function beginningPortalTree(module: SimModule, person: SimObject, portal: SimObject): void {
  const id = person.obj.objectData[6]!;
  const v = getDist(portal, id);
  const other = getOtherSide(module, portal);
  let nv: number;
  if (v < USED_LO || v > USED_HI) {
    if (v === FAILED) return;
    nv = USED_LO;
    for (const q of portals(module)) {
      if (room(q) !== room(portal)) continue;
      const qv = getDist(q, id);
      if (qv >= USED_LO && qv <= USED_HI && nv <= qv) nv = qv + 1;
    }
  } else {
    nv = FAILED;
  }
  setDist(portal, id, nv);
  if (other) setDist(other, id, nv);
}

/** cXPortal::FailedPortalTree: the portal (and its other side) failed for this route. */
export function failedPortalTree(module: SimModule, person: SimObject, portal: SimObject): void {
  const id = person.obj.objectData[6]!;
  setDist(portal, id, FAILED);
  const other = getOtherSide(module, portal);
  if (other) setDist(other, id, FAILED);
}

/** Some route of the person's routes stack walks through `p` (state 1's "target is a portal in use" test). */
export function isPortalInUse(routes: ReadonlyArray<{ portal: SimObject | null }>, p: SimObject): boolean {
  return routes.some((r) => r.portal === p);
}
