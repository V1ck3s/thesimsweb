/**
 * Moving sims between lots: the town pickers asked by the Dialog primitive,
 * the taxi splash, cXPerson::TryChangeLots (generic sim call 17),
 * cSimsApp::SetChangeLotTrigger / SwitchLots and LoadGame's location
 * branches (visiting a community lot, a downtown member, a family trip).
 *
 * The original chain, for a sim going downtown from home (Hot Date):
 *  1. A behavior runs the Dialog primitive (cXObject::TryDialog) of kind 5:
 *     ObjectModule +0xee is 0, so it becomes -1 and the primitive waits.
 *  2. ObjectModule::PostSim sees +0xee < 0: "bkground_fade" and
 *     "kill_all_objectsounds", cWinDowntown(picker) run by
 *     cSimsApp::DoSimsModalDialog (the simulation is blocked meanwhile);
 *     a house 21..30 goes into +0xee and cSimsApp::CreateTaxiDialog(0)
 *     shows the taxi picture.
 *  3. The primitive runs again: +0xee != 0 -> temp 0 = the house, +0xee = 0,
 *     true.
 *  4. Generic sim call 17 (cXObject::TryGenericSimCall, lbl_105BBAC0 entry
 *     17): the caller must be a person (error 0x1c); a valid lbl_105BA254
 *     window gets message 3 / 0x10; cXPerson::TryChangeLots(temp 0, temp 1,
 *     temp 2, temp 3); cSimulator +0xe1 = 1.
 *     TryChangeLots(house, hours, minutes, mode): house -1 means home (the
 *     neighborhood's current family becomes family 0, the house is the
 *     person's family's); mode 0 takes this person (and a date, SimInventory
 *     token 3 / 1), mode 1 the whole family (SavePersistentData of every
 *     member); motives and person data go into SimInventory type-2 tokens,
 *     the arrival clock (now + hours:minutes, except from a residential lot
 *     to a vacation lot) into tokens 7 / 8; Neighborhood::Save;
 *     SetChangeLotTrigger(house, guid, 0) or (house, 0, family).
 *  5. cSimsApp's main loop sees the trigger (+0xf8): SwitchLots = SaveGame,
 *     the flags +0x108 (a downtown member: houses 21..30, or a guid for
 *     vacation / Magic Town / a community lot), +0x109 (the family: vacation,
 *     Studio Town, Magic Town, community lot), +0x10a (a Studio Town
 *     member), UnloadHouse, LoadGame(house), the trigger cleared, the
 *     standard cursor, CPState dirty 0x80000.
 *  6. LoadGame (cSimsApp::LoadGame, see applyLoadGameLocation): with
 *     +0x108, Family::AddDowntownMember(family 0, guid) and
 *     PersonFinder::CreateDowntownSim (out of the world: the lot's behaviors
 *     bring it in), funds = the member's own family's, the clock from the
 *     tokens.
 *  7. On the new lot, generic sim call 3 runs cSimsApp::RemoveTaxiDialog.
 * Coming back is the same with house -1.
 *
 * Kinds of TryDialog: 5 downtown (cWinDowntown, houses 0x15..0x1e, taxi 0),
 * 7 vacation (cWinVacation, 0x28..0x30, taxi 2 from a residential lot, else 1),
 * 8 a community lot of the neighborhood (cWinNeighborhoodUL picker, zoning 2,
 * taxi 3), 0xb Studio Town (0x51..0x59, taxi 5 for a star, else 4), 0xd
 * Magic Town (0x5a..0x62, taxi 6 when global 34 is set, else 7).
 *
 * Port: the ObjectModule fields live here (one Transit per loaded lot), the
 * modal picker is awaited while the simulator is held, the trigger is
 * handed to the game (Game.switchLots) once the tick is over. The arrival
 * clock also rides along with the trigger.
 */

import { MUSIC, soundPlayer, UI_SOURCE } from "../audio/index.js";
import type { GameContext } from "../context.js";
import { DIRTY_ALL } from "../cpstate.js";
import { personFromNeighbor } from "../data/family.js";
import { NeighborhoodStore } from "../data/nbhdstore.js";
import { loadNeighborhood, neighborByGuid } from "../data/neighborhood.js";
import type { SimInventory } from "../data/neighborhood.js";
import { addToken, removeAllTokensOfType, setToNextToken } from "../sim/inventory.js";
import { PDX } from "../sim/person.js";
import type { TransitHooks } from "../sim/simmodule.js";
import { G, type Simulator } from "../sim/simulator.js";
import { PRIM_TRUE, PRIM_WAIT, simThrow } from "../sim/treesim.js";
import type { SimObject } from "../sim/xobject.js";
import { winMgr } from "../ui/winmgr.js";
import type { WinLotView } from "../world/winlotview.js";
import { Zone, type Neighborhood } from "./nghinterface.js";
import { createTaxiDialog, removeTaxiDialog, TransitScreen } from "./winpicturesplashdialog.js";
import { Town, WinTown } from "./wintown.js";
import { WinNeighborhoodUL } from "./winneighborhoodul.js";

/** Simulator global 0x20: the lot is visited without sims (free funds, buy mode only). */
const G_VISIT = G.freeFunds;
/** Simulator global 9: the family number of the lot. */
const G_FAMILY = 9;
/** Global 34, "Lot Transit Info" (Behavior.iff global labels): cSimulator +0x54. */
const G_LOT_TRANSIT_INFO = 34;

/** CPState dirty bits of LoadGame's tail. */
const DIRTY_LIVE_DISABLED = 0x8000000;
const DIRTY_FUNDS = 0x4000;

/** cSimsApp's lot change (+0xfa house, +0xfc person guid, +0x100 family) and the arrival clock (SimInventory tokens 7 / 8). */
export interface ChangeLotTrigger {
  house: number;
  guid: number;
  family: number;
  hour: number;
  minute: number;
}

/** What SwitchLots tells LoadGame: the +0x108 / +0x109 / +0x10a flags with the trigger's guid / family. */
export interface LotArrival {
  /** +0x108: a single sim (guid) arriving (downtown, vacation, Magic Town, a community lot). */
  member: number;
  /** +0x109: a whole family (id) arriving. */
  family: number;
  /** +0x10a: a single sim arriving in Studio Town. */
  studioMember: number;
  hour: number;
  minute: number;
}

/** cSimsApp::SwitchLots' flags for a trigger. */
export function arrivalFor(t: ChangeLotTrigger, zoning: Zone): LotArrival {
  const a: LotArrival = { member: 0, family: 0, studioMember: 0, hour: t.hour, minute: t.minute };
  const h = t.house;
  if (h > 0x14 && h < 0x1f) a.member = t.guid;
  if ((h > 0x27 && h < 0x32) || (h > 0x59 && h < 100) || zoning === Zone.Community) {
    if (t.guid) a.member = t.guid;
    if (t.family) a.family = t.family;
  }
  if (h > 0x50 && h < 0x5a) {
    if (t.guid) a.studioMember = t.guid;
    if (t.family) a.family = t.family;
  }
  return a;
}

/** What the game does for the transit code. */
export interface TransitHost {
  ctx: GameContext;
  nb(): Neighborhood | null;
  /** The view of the lot the transit is on (the pickers and the splash go over it). */
  lotView(): WinLotView | null;
  /** cSimsApp's main loop -> SwitchLots, after the current tick. */
  switchLots(trigger: ChangeLotTrigger): void;
}

/** ObjectModule fields by TryDialog kind. */
const DIALOG_KINDS = new Set([5, 7, 8, 0xb, 0xd]);

/** One per loaded lot: the ObjectModule side (+0xee..+0xf6) and the primitives' entry points. */
export class Transit implements TransitHooks {
  /** ObjectModule +0xee (5), +0xf0 (7), +0xf2 (0xb), +0xf4 (0xd): 0 idle, -1 asked, else the picked house. */
  private readonly picks = new Map<number, number>();
  /** cSimsApp+0xf8: a trigger is set (SetChangeLotTrigger ignores the next ones). */
  private triggered = false;

  constructor(
    private readonly host: TransitHost,
    private readonly sim: Simulator,
  ) {}

  /**
   * cXObject::TryDialog, kinds 5 / 7 / 8 / 0xb / 0xd (operand byte 7 bit 0
   * clear). (Kind 0xd keeps its field at 0 when cSimsApp +0xc0 is set: not
   * tracked.)
   */
  tryDialog(o: SimObject, kind: number): number | undefined {
    if (!DIALOG_KINDS.has(kind)) return undefined;
    const v = this.picks.get(kind) ?? 0;
    if (v === 0) {
      this.picks.set(kind, -1);
      // ObjectModule::PostSim: the picker, modal, once this tick is over.
      queueMicrotask(() => void this.postSim(kind));
      return PRIM_WAIT;
    }
    if (v < 0) return PRIM_WAIT;
    o.obj.temps[0] = v;
    this.picks.set(kind, 0);
    return PRIM_TRUE;
  }

  /**
   * ObjectModule::PostSim's picker part: "bkground_fade",
   * "kill_all_objectsounds", the town screen as a picker run by
   * DoSimsModalDialog (the simulation does not run meanwhile); a house of
   * the town's range is kept and the taxi splash shown, anything else
   * resets the field.
   */
  private async postSim(kind: number): Promise<void> {
    const view = this.host.lotView();
    const nb = this.host.nb();
    if (!view || !nb) {
      this.picks.set(kind, 0);
      return;
    }
    if (kind === 8) {
      await this.neighborhoodPicker(view, nb);
      return;
    }
    const town = kind === 5 ? Town.Downtown : kind === 7 ? Town.Vacation : kind === 0xb ? Town.Studiotown : Town.Magictown;
    soundPlayer.playBySource(MUSIC.fade, UI_SOURCE);
    soundPlayer.playBySource("kill_all_objectsounds", UI_SOURCE);
    // The picker's vehicle flag, set by PostSim before the screen shows:
    // - cWinStudiotown +0xd0: the asking person (ObjectModule +0x110, generic call 35) is a star,
    //   person data 0x50 (+0x62c, star points) > 0 and 0x38 (+0x5fc, job) 0;
    // - cWinMagicland +0xdc: cSimulator +0x54, global 34 ("Lot Transit Info"), not 0.
    let vehicle = false;
    if (town === Town.Studiotown) {
      const caller = this.sim.module.studioCaller?.person?.personData;
      vehicle = !!caller && caller[0x50]! > 0 && caller[0x38] === 0;
    } else if (town === Town.Magictown) {
      vehicle = this.sim.globals[G_LOT_TRANSIT_INFO] !== 0;
    }
    const release = holdSimulator(this.sim);
    let house = 0;
    try {
      house = await runTownPicker(this.host.ctx, nb, town, view, vehicle);
    } finally {
      release();
    }
    const range: Readonly<Record<Town, readonly [number, number]>> = {
      [Town.Downtown]: [0x15, 0x1e],
      [Town.Vacation]: [0x28, 0x30],
      [Town.Studiotown]: [0x51, 0x59],
      [Town.Magictown]: [0x5a, 0x62],
    };
    const [lo, hi] = range[town];
    if (house < lo || house > hi) {
      this.picks.set(kind, 0);
      return;
    }
    this.picks.set(kind, house);
    let screen = TransitScreen.Downtown;
    if (town === Town.Vacation) {
      const here = this.sim.globals[G.houseNumber]!;
      screen = nb.getZoningType(here) === Zone.Residential ? TransitScreen.Vacation2 : TransitScreen.Vacation;
    } else if (town === Town.Studiotown) {
      // Taxi 5 (the limo) for a star, else 4; +0x110 is cleared.
      screen = vehicle ? TransitScreen.Studiotown : TransitScreen.StudiotownFan;
      this.sim.module.studioCaller = null;
    } else if (town === Town.Magictown) {
      // Taxi 6 (the balloon) with the flag, else 7 (the hole).
      screen = vehicle ? TransitScreen.Magictown : TransitScreen.MagictownHole;
    }
    await createTaxiDialog(this.host.ctx, view, screen);
  }

  /**
   * ObjectModule::PostSim, ObjectModule +0xf6 < 0 (TryDialog kind 8): the
   * neighborhood screen as a picker (cWinNeighborhoodUL(false) in the
   * Complete Collection, cSimsApp +0x66 bit 0x20) over the lot, after
   * "bkground_fade" and "kill_all_objectsounds", run by DoSimsModalDialog;
   * a community lot (zoning 2) is kept with the taxi splash 3, anything
   * else resets the field.
   */
  private async neighborhoodPicker(view: WinLotView, nb: Neighborhood): Promise<void> {
    soundPlayer.playBySource(MUSIC.fade, UI_SOURCE);
    soundPlayer.playBySource("kill_all_objectsounds", UI_SOURCE);
    const release = holdSimulator(this.sim);
    let house = 0;
    try {
      house = await runNeighborhoodPicker(this.host.ctx, nb, view);
    } finally {
      release();
    }
    if (nb.getZoningType(house) !== Zone.Community) {
      this.picks.set(8, 0);
      return;
    }
    this.picks.set(8, house);
    await createTaxiDialog(this.host.ctx, view, TransitScreen.Neighborhood);
  }

  /** cXObject::TryGenericSimCall entries 3 (cSimsApp::RemoveTaxiDialog) and 17 (change lots). */
  genericSimCall(o: SimObject, call: number): number {
    if (call === 3) {
      removeTaxiDialog();
      return PRIM_TRUE;
    }
    // Entry 17: the caller must be a person (error 0x1c).
    if (!o.person) simThrow(0x1c);
    void this.tryChangeLots(o, o.obj.temps[0]!, o.obj.temps[1]!, o.obj.temps[2]!, o.obj.temps[3]!);
    return PRIM_TRUE;
  }

  /**
   * cXPerson::TryChangeLots, then cSimsApp::SetChangeLotTrigger. The
   * SimInventory tokens carry the sims across: type-2 tokens 0..6 (motives
   * 9, 6, 5, 15, 7, 8, 14), 9..12 (person data 8, 0x50, 0x52, 0x51) for each
   * sim going (generic sim call 21 reads them back), 7 / 8 the arrival
   * clock; the companion of a single sim is the neighbor of its first token
   * of type 1 (going out) or 3 (going home), when it is on the lot.
   */
  private async tryChangeLots(o: SimObject, houseArg: number, hours: number, minutes: number, mode: number): Promise<void> {
    const person = o.person;
    if (!person) return;
    const m = o.module;
    const nbhdDir = this.host.nb()?.dir;
    if (!nbhdDir) return;
    const guid = o.obj.guid >>> 0;
    const me = m.findNeighborByGUID(guid);
    if (!me) return;
    let inv: SimInventory | null = m.getInventoryByNeighbourID(me.id);
    const store = await NeighborhoodStore.open(nbhdDir);
    const familyId = person.personData[PDX.familyNumber] ?? 0;
    let house = houseArg;
    if (house === -1) house = store.family(familyId)?.houseNumber ?? 0;
    // The companion (mode 0) or the family (mode 1).
    let companion: SimObject | null = null;
    let family: number[] | null = null;
    if (mode === 0) {
      const at = setToNextToken(inv, houseArg === -1 ? 3 : 1, -1, 0);
      if (at.index >= 0) {
        const g = inv.tokens[at.index]!.guid;
        companion = m.people.find((p) => !p.killed && (p.obj.selector.guid | 0) === (g | 0)) ?? null;
      }
    } else if (mode === 1) {
      family = store.family(familyId)?.memberGuids ?? [];
    }
    const writeTokens = (target: SimInventory, p: SimObject): void => {
      removeAllTokensOfType(target, 2);
      const mv = p.person!.motives;
      [9, 6, 5, 0xf, 7, 8, 0xe].forEach((k, i) => addToken(target, 2, i, Math.trunc(mv[k] ?? 0)));
      const pd = p.person!.personData;
      [8, 0x50, 0x52, 0x51].forEach((k, i) => addToken(target, 2, 9 + i, pd[k] ?? 0));
    };
    if (companion) {
      const nb = m.findNeighborByGUID(companion.obj.selector.guid >>> 0);
      if (nb) writeTokens(m.getInventoryByNeighbourID(nb.id), companion);
    }
    if (!family) {
      writeTokens(inv, o);
    } else {
      family.forEach((g, i) => {
        const p = m.persons.find((x) => x.obj.guid >>> 0 === g >>> 0);
        if (!p?.person) return;
        // Neighborhood::SavePersistentData of each member here.
        store.savePersistentData(g, p.person.personData);
        const nb = m.findNeighborByGUID(g);
        if (!nb) return;
        const memberInv = m.getInventoryByNeighbourID(nb.id);
        if (i === 0) inv = memberInv;
        writeTokens(memberInv, p);
      });
    }
    // The arrival clock: now + hours:minutes, unless leaving a residential lot for a vacation lot.
    let hour = this.sim.globals[G.hour]!;
    let minute = this.sim.globals[G.minute]!;
    const here = this.sim.globals[G.houseNumber]!;
    const nb = this.host.nb();
    if (nb?.getZoningType(here) !== Zone.Residential || houseArg < 0x28 || houseArg > 0x31) {
      minute += minutes;
      if (minute > 0x3b) {
        hour += 1;
        minute %= 0x3c;
      }
      hour = (hour + hours) % 0x18;
    }
    if (inv) {
      addToken(inv, 2, 7, hour);
      addToken(inv, 2, 8, minute);
    }
    // Neighborhood::Save (the live inventories go with it).
    await store.save();
    // SetChangeLotTrigger: ignored while one is pending.
    if (this.triggered) return;
    this.triggered = true;
    this.host.switchLots({ house, guid: mode === 0 ? guid : 0, family: mode === 1 ? familyId : 0, hour, minute });
  }
}

/** Modal dialogs holding each simulator, and its own simulate method. */
const holds = new WeakMap<Simulator, { count: number; simulate: Simulator["simulate"] }>();

/**
 * DoSimsModalDialog: the simulation does not run while a modal dialog is up.
 * Holds nest (several dialogs queued in one tick): the simulation resumes
 * when the last one is released.
 */
export function holdSimulator(sim: Simulator): () => void {
  let h = holds.get(sim);
  if (!h) {
    h = { count: 0, simulate: sim.simulate };
    holds.set(sim, h);
    sim.simulate = (): number => 0;
  }
  h.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const cur = holds.get(sim);
    if (!cur || --cur.count > 0) return;
    holds.delete(sim);
    sim.simulate = cur.simulate;
    // No catching up on the time the dialog was up.
    sim.setSpeed(sim.globals[G.speed]!);
  };
}

/** The neighborhood screen as a community lot picker over `view`; resolves with the picked house (0: none). */
export async function runNeighborhoodPicker(ctx: GameContext, nb: Neighborhood, view: WinLotView): Promise<number> {
  const screen: WinNeighborhoodUL = new WinNeighborhoodUL(
    ctx,
    nb,
    {
      onEnterLot: () => undefined,
      onEndModal: (result) => winMgr.endDialog(screen, result),
      onSwitchNeighborhood: () => undefined,
      onUnported: (what) => console.log(`not ported: ${what}`),
    },
    true,
  );
  screen.setArea(0, 0, view.getW(), view.getH());
  if (!(await screen.init())) return 0;
  const r = await winMgr.doModalWin(screen);
  screen.shutdown();
  return r;
}

/** The town screen as a destination picker over `view`; resolves with the picked house. */
export async function runTownPicker(ctx: GameContext, nb: Neighborhood, town: Town, view: WinLotView, vehicle = false): Promise<number> {
  return new Promise<number>((resolve) => {
    const screen: WinTown = new WinTown(ctx, nb, town, false, {
      onEnd: (result) => winMgr.endDialog(screen, result),
      onUnported: (what) => console.log(`not ported: ${what}`),
    }, vehicle);
    screen.setArea(0, 0, view.getW(), view.getH());
    void screen.init().then(async (ok) => {
      if (!ok) {
        resolve(0);
        return;
      }
      const r = await winMgr.doModalWin(screen);
      screen.shutdown();
      resolve(r);
    });
  });
}

/**
 * The family part of cSimsApp::LoadGame before the house loads: the
 * people the control panel shows. A downtown / Studio Town member is
 * Family::AddDowntownMember(family 0, guid); a family trip makes that
 * family current; otherwise the family living in the house (if any).
 * Returns false when nothing was arranged (the caller activates the
 * house's family as usual).
 */
export async function prepareArrival(ctx: GameContext, nbhdDir: string, arrival: LotArrival | null): Promise<boolean> {
  if (!arrival) return false;
  const guid = arrival.member || arrival.studioMember;
  const n = await loadNeighborhood(nbhdDir);
  const state = ctx.state;
  if (guid) {
    const nbr = neighborByGuid(n, guid);
    if (!nbr) return false;
    const famId = nbr.personData?.[PDX.familyNumber] ?? 0;
    const fam = n.families.find((f) => f.chunkId === famId);
    state.familyName = fam?.name ?? "";
    state.family = [await personFromNeighbor(n, nbr, fam?.name ?? "")];
    state.setFunds(fam?.budget ?? 0);
    return true;
  }
  if (arrival.family) {
    const fam = n.families.find((f) => f.chunkId === arrival.family);
    if (!fam) return false;
    state.familyName = fam.name;
    const members = fam.memberGuids.map((g) => neighborByGuid(n, g)).filter((x) => x !== undefined);
    state.family = await Promise.all(members.map((m) => personFromNeighbor(n, m, fam.name)));
    state.setFunds(fam.budget);
    return true;
  }
  return false;
}

/** cSimsApp::LoadGame's location part, after Neighborhood::LoadHouse; returns whether the lot is visited without sims (global 0x20). */
export async function applyLoadGameLocation(ctx: GameContext, view: WinLotView, nb: Neighborhood, house: number, arrival: LotArrival | null): Promise<boolean> {
  const sim = view.sim;
  const state = ctx.state;
  const zoning = nb.getZoningType(house);
  // SetGlobal(0x20, 0) around Neighborhood::LoadHouse (a saved visit must not carry over).
  if (sim) sim.globals[G_VISIT] = 0;
  const visit = (): void => {
    // Global 0x20 = 1, family 0's budget 0, SetFunds(0) (ignored once 0x20 is set), CPState dirty 0x4000.
    if (sim) sim.globals[G_VISIT] = 1;
    sim?.setFunds(0);
    state.setDirty(DIRTY_FUNDS);
  };
  const arrive = (): void => {
    // The funds of the arriving sims' family (set by prepareArrival), the clock of the tokens.
    sim?.setFunds(state.getFunds());
    if (arrival && sim) sim.setCurrentHour(arrival.hour, arrival.minute);
    if (house === 99) sim?.setCurrentHour(0xc, 0);
    state.setDirty(DIRTY_FUNDS);
  };
  // ObjectModule::ResetForVacation; the arriving family (made by the lot view before this,
  // after it in the original: PersonFinder::CreateDowntownSim) is spared.
  const resetForVacation = (): void => {
    const arriving = new Set(state.family.map((f) => (f.guid ?? 0) | 0));
    sim?.module.resetForVacation((o) => arriving.has(o.obj.selector.guid | 0));
  };
  // Global 9 as Neighborhood::LoadHouse leaves it: the family living in the house (0 for none).
  const familyNumber = house > 0 ? (nb.getFamilyInHouse(house)?.chunkId ?? 0) : 0;
  // Neighborhood::LoadHouse: SetGlobal(9, the family's id, Family +0x10c) and SetGlobal(10, house).
  // The Scheduler's "final check" kills its NPC visit unless a person of family global 9 is on the lot.
  if (sim) {
    sim.globals[G_FAMILY] = familyNumber;
    sim.globals[G.houseNumber] = house;
  }
  if (familyNumber === 0) {
    if (zoning === Zone.None || (arrival && (arrival.member || arrival.family || arrival.studioMember))) {
      if (house >= 0x15 && house <= 0x1e) {
        if (arrival?.member) arrive();
        else visit();
      } else if (house >= 0x51 && house <= 0x59) {
        if (arrival?.studioMember) arrive();
        else visit();
      } else if ((house > 0x27 && house < 0x32) || zoning === Zone.Community || (house > 0x5c && house < 100)) {
        if (arrival?.member || arrival?.family) {
          resetForVacation();
          arrive();
          // The family trip: the family becomes the lot's (global 9).
          if (arrival.family && sim) sim.globals[G_FAMILY] = arrival.family;
          if (arrival.family && house > 0x27 && house < 0x32) {
            // Family +0x13c = the vacation lot, Neighborhood::Save (and SaveGame after the load).
            const store = await NeighborhoodStore.open(nb.dir);
            store.setFamilyVacationLot(arrival.family, house);
            await store.save();
            const fam = sim?.module.nbhd?.families.find((f) => f.chunkId === arrival.family);
            if (fam) fam.vacationLot = house;
          }
        } else {
          visit();
          if (house > 0x27 && house < 0x32) {
            resetForVacation();
            sim?.setCurrentHour(10, 0);
          }
        }
      }
    } else {
      visit();
      resetForVacation();
      sim?.setCurrentHour(10, 0);
    }
  } else if (zoning === Zone.Residential) {
    // Back home: the family's vacation lot is cleared, its funds restored.
    const store = await NeighborhoodStore.open(nb.dir);
    const id = store.familyOfHouse(house);
    if (id !== undefined && store.familyVacationLot(id)) {
      store.setFamilyVacationLot(id, 0);
      await store.save();
    }
    if (id !== undefined) sim?.setFunds(store.family(id)?.budget ?? state.getFunds());
    state.setDirty(DIRTY_FUNDS);
  }

  // The tail: DisableLiveMode, DisableSave, HideButtonsForLocation, buy mode and pause for a visit.
  const visiting = (sim?.globals[G_VISIT] ?? 0) === 1;
  state.liveModeDisabled = visiting;
  if (zoning === Zone.Community || (house > 0x5c && house < 100)) {
    state.disableSave(!visiting);
  } else {
    state.disableSave(!visiting && familyNumber === 0 && !arrival?.member && !arrival?.studioMember && !arrival?.family);
  }
  state.hideForLocation = visiting;
  state.setDirty(DIRTY_LIVE_DISABLED);
  if (visiting) {
    state.family = [];
    state.pause(true);
  }
  state.dirty = DIRTY_ALL;
  return visiting;
}
