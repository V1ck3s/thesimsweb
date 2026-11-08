/**
 * cXObject::TryGenericSimCall's lot change entries on the arrival side
 * (jump table lbl_105BBAC0, Hot Date and later; the departure side, 3 and
 * 17, is nbhd/transit.ts):
 *
 *   18 (0x100EA150): temp 0 = the object id of the house family's first
 *      member (PersonFinder::GetPersonInHouseIndex(0) -> GetInstance), or -1.
 *      The downtown / vacation / studio ped markers wait for it to send a
 *      cab that brings the sim in.
 *   19 / 20 (0x100EA1DC / 0x100EA320): the person in temp 0 (error 0x1c
 *      otherwise) carries a companion in its SimInventory (token type 1 /
 *      3, the GUID of the neighbor): the companion's person (made out of
 *      the world by PersonFinder::CreateDowntownSim when missing) goes into
 *      temp 0, the token is removed and the neighborhood saved; -1 when there
 *      is no such token or no person could be made.
 *   21 (0x100EA464): the person in temp 0 gets back what its type-2 tokens
 *      carried (cXPerson::TryChangeLots wrote them): GUIDs 0..6 are motives
 *      9, 6, 5, 15, 7, 8, 14 (SetMotive), 9..12 person data 8, 0x50, 0x52,
 *      0x51; each token used is removed. The loop runs CountTokensOfType(2)
 *      times from the first type-2 token: the clock tokens (7 / 8) are not
 *      removed, so one of them first stops the restore (as in the original).
 *   32 (0x100EA954, NeighborhoodPhonePlugin "Go To Community"): each member
 *      of the house family without a person here is made
 *      (CreateDowntownSim), gets its type-2 tokens back (as 21) and is placed
 *      near me (FindGoodLocation: my room first), then ForceLocation.
 *   23 (0x100EA710): on me (a person): temp 0 = the count of my type-2 token
 *      7 (arrival hour), temp 1 = token 8 (minutes), each removed; stops at
 *      the first one missing.
 *
 * The inventories are not written back to the neighborhood file
 * (Neighborhood::Save after 19 / 20): the port keeps them in memory.
 */

import { removeTokenByIndex, setToNextToken, countTokensOfType } from "./inventory.js";
import type { SimObject } from "./xobject.js";
import { PRIM_TRUE, PRIM_WAIT, simThrow } from "./treesim.js";

/** XERR.notPerson */
const ERR_NOT_PERSON = 0x1c;

/** Call 21: token GUID -> motive (SetMotive) or person data (`pd`). */
const TOKEN_MOTIVES: ReadonlyArray<{ motive: number } | { pd: number } | null> = [
  { motive: 9 },
  { motive: 6 },
  { motive: 5 },
  { motive: 0xf },
  { motive: 7 },
  { motive: 8 },
  { motive: 0xe },
  null,
  null,
  { pd: 8 },
  { pd: 0x50 },
  { pd: 0x52 },
  { pd: 0x51 },
];

/** Neighbor id of a person (cXPerson +0x5ca, person data 0x1f). */
function neighborIdOf(o: SimObject): number {
  return o.person!.personData[0x1f]!;
}

/** PersonFinder::GetInstance of the neighbor whose GUID is `guid`: its person on the lot. */
function instanceOf(o: SimObject, guid: number): SimObject | null {
  return o.module.people.find((p) => !p.killed && (p.obj.selector.guid | 0) === (guid | 0)) ?? null;
}

/**
 * Call 21's restore (also run by call 32): the person gets back what its
 * type-2 tokens carried; each token used is removed.
 */
function restoreChangeLotsTokens(who: SimObject): void {
  const person = who.person!;
  const inv = who.module.getInventoryByNeighbourID(neighborIdOf(who));
  for (let n = countTokensOfType(inv, 2); n > 0; n--) {
    const at = setToNextToken(inv, 2, -1, 0);
    if (at.index < 0) continue;
    const t = inv.tokens[at.index]!;
    const what = t.guid >>> 0 <= 12 ? TOKEN_MOTIVES[t.guid] : undefined;
    if (what === undefined) continue;
    if (what === null) continue;
    if ("motive" in what) person.motives[what.motive] = t.count;
    else person.personData[what.pd] = t.count;
    removeTokenByIndex(inv, at.index, -1);
  }
}

/**
 * The calls above; `temps` are the caller's temps and `obj` resolves an
 * object id (cXObject's ObjectModule lookup). Returns null for other calls.
 */
export function tryLotChangeCall(o: SimObject, call: number, temps: Int16Array, obj: (id: number) => SimObject | null): number | null {
  const m = o.module;
  switch (call) {
    case 18: {
      const p = m.firstPersonInHouse();
      temps[0] = p ? p.id : -1;
      return PRIM_TRUE;
    }
    case 19:
    case 20: {
      const who = obj(temps[0]!);
      if (!who?.person) simThrow(ERR_NOT_PERSON);
      const inv = m.getInventoryByNeighbourID(neighborIdOf(who));
      const at = setToNextToken(inv, call === 19 ? 1 : 3, -1, 0);
      if (at.index < 0) {
        temps[0] = -1;
        return PRIM_TRUE;
      }
      const guid = inv.tokens[at.index]!.guid;
      let p = instanceOf(o, guid);
      if (!p) {
        // PersonFinder::CreateDowntownSim: MakeNewOutOfWorldObject of the neighbor's selector.
        const hooks = m.worldHooks;
        const sel = hooks?.selector(guid);
        if (sel === undefined) return PRIM_WAIT;
        const x = sel && hooks ? hooks.make(sel) : null;
        p = x ? m.addObject(x, true) : null;
      }
      temps[0] = p ? p.id : -1;
      removeTokenByIndex(inv, at.index, 1);
      return PRIM_TRUE;
    }
    case 21: {
      const who = obj(temps[0]!);
      if (!who?.person) simThrow(ERR_NOT_PERSON);
      restoreChangeLotsTokens(who);
      return PRIM_TRUE;
    }
    case 32: {
      // Every member of the house family without a person on the lot: CreateDowntownSim, its
      // type-2 tokens restored (as call 21), then FindGoodLocation around me (my room, empty
      // tile, buildable; then any room), CanPlace / cXPerson::Place and ForceLocation.
      const hooks = m.worldHooks;
      for (const member of m.sim.state?.family ?? []) {
        const guid = member.guid;
        if (guid === undefined || instanceOf(o, guid)) continue;
        const sel = hooks?.selector(guid);
        if (sel === undefined) return PRIM_WAIT;
        const x = sel && hooks ? hooks.make(sel) : null;
        const p = x ? m.addObject(x, true) : null;
        if (!p?.person || !hooks) continue;
        restoreChangeLotsTokens(p);
        const start = { fx: o.obj.fx, fy: o.obj.fy };
        const level = o.obj.level;
        const opts = { emptyTile: true, buildable: true, random: null };
        const pos = hooks.findGoodLocation(p.obj, start, level, { ...opts, sameRoom: true }) ?? hooks.findGoodLocation(p.obj, start, level, { ...opts, sameRoom: false });
        if (!pos || !hooks.canPlace(p.obj, pos, level, null, 0)) continue;
        hooks.place(p.obj, pos, level, null, 0);
        p.forceLocation();
        m.dirty(p);
      }
      return PRIM_TRUE;
    }
    case 23: {
      if (!o.person) simThrow(ERR_NOT_PERSON);
      const inv = m.getInventoryByNeighbourID(neighborIdOf(o));
      for (const [guid, temp] of [
        [7, 0],
        [8, 1],
      ] as const) {
        const at = setToNextToken(inv, 2, -1, guid);
        if (at.index < 0) break;
        temps[temp] = inv.tokens[at.index]!.count;
        removeTokenByIndex(inv, at.index, -1);
      }
      return PRIM_TRUE;
    }
    default:
      return null;
  }
}
