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
import { simThrow, treeSimGlobals } from "./treesim.js";
import { EP } from "./objfntable.js";
import { PersonSim, SCORE_CURVE_MOTIVES, type Interaction, type MenuItem } from "./person.js";
import { curvesFromStrings, HAPPY_CURVE_MOTIVES, type MotiveCurve } from "./motives.js";
import { loadStringSet, loadTree } from "./behavior.js";
import type { Neighbor, NeighborhoodData, SimInventory } from "../data/neighborhood.js";
import { getLiveNeighborhood, PERSISTENT_DATA_FIELDS, setLiveNeighborhood } from "../data/nbhdstore.js";
import type { SimCareer } from "./careers.js";
import type { FameScoring } from "./fametrack.js";
import { ObjectDialog, type DialogHooks } from "./objectdialog.js";
import type { StackElem } from "./treestack.js";
import { TreeTable, type TreeTableEntry } from "./treetable.js";
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

/** A fixed-point lot position (1/16 tile). */
export interface FPos {
  fx: number;
  fy: number;
}

/** See SimModule.worldHooks. */
export interface WorldHooks {
  selector(guid: number): ObjSelector | null | undefined;
  make(sel: ObjSelector): XObject | null;
  canPlace(obj: XObject, pos: FPos, level: number, container: XObject | null, slot: number): boolean;
  place(obj: XObject, pos: FPos, level: number, container: XObject | null, slot: number): void;
  moveTo(obj: XObject, pos: FPos, level: number): void;
  /** cXObject::Pickup (out of the world). */
  pickup(obj: XObject): void;
  /** cXObject::FindGoodLocation (Placement.findGoodLocation). */
  findGoodLocation(obj: XObject, start: FPos, level: number, opts: { emptyTile: boolean; buildable: boolean; random: (() => number) | null; sameRoom?: boolean; direction?: number }): FPos | null;
  kill(obj: XObject): void;
  /** Placement's last error (lbl_105BA1A8) and the object TestIntersection hit (lbl_105BA248). */
  lastError(): { code: number; obstacle: number };
  /** The person's body strings changed (TryGenericSimCall 24): redress it (SAnimator::UpdateOutfitAndHands). */
  bodyStringsChanged?(obj: XObject, strings: readonly string[]): void;
}

/** See SimModule.transitHooks (nbhd/transit.ts). */
export interface TransitHooks {
  /** cXObject::TryDialog kinds 5 / 7 / 0xb / 0xd; undefined = not handled. */
  tryDialog(o: SimObject, kind: number): number | undefined;
  /** cXObject::TryGenericSimCall entries 3 (RemoveTaxiDialog) and 17 (TryChangeLots). */
  genericSimCall(o: SimObject, call: number): number;
}

/** One recorded side effect the port does not perform (sounds, dialogs, UI). */
export interface SimEvent {
  tick: number;
  objectId: number;
  kind: string;
  value: string | number;
}

/** Family::LoadSpellsForFamily's spell book (ObjectModule::GetObjectByGUID). */
const GUID_SPELL_BOOK = 0xb6c90029;

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
  /**
   * ObjTestSim's menu globals (lbl_105BA35C / 358 / 354) while
   * AppendInteractionsForMenu runs a check tree: the menu being made and the
   * entry tested (ObjTestSim::IsMenuInProgress, MakeNewMenuItem).
   */
  menuInProgress: { items: MenuItem[]; entry: TreeTableEntry } | null = null;
  /** Inventories made while no neighborhood is loaded (GetInventoryByNeighbourID). */
  private readonly sessionInventories: SimInventory[] = [];
  /** GetCareers: the careers in LoadCareers' order (sim/careers.ts); set by the Simulator. */
  careers: SimCareer[] = [];
  /** lbl_105BB7F0: cJob::GetGrade's strings (work.iff STR# 0x1001); set by the Simulator. */
  jobGrades: string[] = [];
  /** GetFameTrackData: the fame titles by level (sim/fametrack.ts), null without a fame track; set by the Simulator. */
  fameTitles: string[] | null = null;
  /** cFameTrack's scoring tables (null without GameData/fame.iff: no fame track). */
  fameScoring: FameScoring | null = null;
  /**
   * ObjectModule +0x110: the person who asked for the Studio Town picker
   * (generic call 35); PostSim's picker reads then clears it.
   */
  studioCaller: SimObject | null = null;
  /**
   * Neighborhood +0x11c: the other house numbers, sorted by distance to the
   * current one (Neighborhood::LoadHouse, compareHouses). LoadHouse adds the
   * numbers 1 .. n-1, n being the size of the house position vector
   * (+0x110), which nothing in the Mac build fills: the list stays empty.
   */
  readonly neighborhoodHouses: number[] = [];
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
  /**
   * cSoundPlayer as the sound primitives reach it (cXObject::TryPlaySound:
   * the FWAV event of the private or global file, PlayBySource(name, source);
   * TryKillSounds: QuietBySourceID(source)). Null: the primitives only record.
   */
  soundHooks: { playSound(behavior: Behavior | null, soundId: number, source: number): void; killSounds(source: number): void } | null = null;
  /** The UI side of prim 34 (UI Effect): Tut_FlashButtonByImageID(image id, on). Null: recorded only. */
  tutorialHooks: { flashButtonByImageID(id: number, on: boolean): void } | null = null;
  /** Called when an object's look changed (cXObject::Dirty) or it was killed. */
  onDirty: ((o: SimObject) => void) | null = null;
  onKill: ((o: SimObject) => void) | null = null;
  /** Neighborhood +0x16c zoning: house number -> 1 residential / 2 community (UserData LotZoning.iff STR# 1). */
  readonly zoning = new Map<number, number>();
  /** ObjectModule::DisableBuyAndBuild: the object that disabled buy and build modes (0 = enabled). */
  buyBuildDisabledBy = 0;
  /**
   * cXObject::TryUserEvent's outside world: cOptionsMgr::GetLivePIP and
   * GViewer::DoPictureInPicture (`window` false: cDDDSimsView centers the lot
   * view on the object; true: cWinPictureInPicture opens / closes).
   */
  userEventHooks: {
    livePIP(): boolean;
    pictureInPicture(o: SimObject, a: { open: boolean; window: boolean; ms: number; arg3: number; arg2: number; flag4: boolean; snapshot: boolean; caption: string }): void;
  } | null = null;
  /** RoomManager::GetRoom for cXObject::InterpValue's scope 23 (the lot view's rooms and lighting). */
  roomHooks: { room(id: number): { ambient: number; outside: boolean; level: number; area: number } | null } | null = null;
  /**
   * Neighborhood::GetNumCharacters: the neighbors whose definition comes from
   * the neighborhood's Characters folder (Neighbor::IsCharacter). Set by the
   * lot view (it knows the object folder); the people on the lot until then.
   */
  numCharacters: number | null = null;
  /** ObjectModule +0xac: the object holding the tutorial (cXObject::TryTutorial). */
  tutorialObject: SimObject | null = null;
  /** GlobalDispatch(0x107) -> cSimsApp: cTutorialIcon::ObjectChanged (the tutorial icon is not ported). */
  onTutorialObjectChanged: ((o: SimObject | null) => void) | null = null;
  /**
   * ObjectModule +0xb0 / +0xb4 / +0xc0: the persons whose date (person data
   * 77) or fame (81) was written, for ObjectModule::UpdatePlumbBobs
   * (world/plumbbobs.ts) to move the date and star plumb bobs.
   */
  plumbBobsDirty = false;
  readonly autofollowDirty: SimObject[] = [];
  readonly starDirty: SimObject[] = [];

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

  /** ObjectModule::SetStarSimDirty. */
  setStarSimDirty(p: SimObject | null): void {
    if (p) this.starDirty.push(p);
    this.plumbBobsDirty = true;
  }

  /** ObjectModule::SetAutofollowSimDirty: a person with a date (person data 77), once. */
  setAutofollowSimDirty(p: SimObject | null): void {
    if (!p?.person || p.person.personData[0x4d] === 0) return;
    if (this.autofollowDirty.some((q) => q && q.id === p.id)) return;
    this.autofollowDirty.push(p);
    this.plumbBobsDirty = true;
  }

  /** The people as PersonSim. */
  get persons(): PersonSim[] {
    return this.people.filter((p): p is PersonSim => p instanceof PersonSim);
  }

  /**
   * ObjectModule::CleanupPeople: every person but `obj` gets Cleanup(obj)
   * (vtable +0x40, cXPerson::Cleanup: what it was doing with `obj`).
   */
  cleanupPeople(obj: SimObject): void {
    for (const p of this.people) if (p !== obj) p.cleanupFor(obj);
  }

  /**
   * The world side of the placement primitives (set by the lot view; null
   * in the headless test, where they are logged and fail): `selector` looks
   * a GUID up (undefined while its object file opens, null when unknown),
   * `make` builds an object out of the world (ObjectModule::
   * MakeNewOutOfWorldObject; its Init runs through the placement hooks),
   * `canPlace` / `place` are cXObject::CanPlace / Place (vtable +0x5c /
   * +0x60; `slot` is the container's slot index, objectSlots[slot + 1]),
   * `moveTo` moves a walking person (its tile link and contents follow,
   * cXObject::SetLocation) and `kill` is ObjectModule::KillObject's world
   * part.
   */
/** lbl_105BE790: the interaction being run immediately by cXPerson::AddAction. */
  immediateAction: Interaction | null = null;
    worldHooks: WorldHooks | null = null;

  /** Lot changes (town pickers, taxi splash, TryChangeLots), set by the game. */
  transitHooks: TransitHooks | null = null;

  /** +0x64: the queued object dialogs (EnqueueObjectDialog). */
  readonly dialogs: ObjectDialog[] = [];
  /** Shows the generic object dialogs (cWinPictureDialog), set by the game; none: dialogs stay queued. */
  dialogHooks: DialogHooks | null = null;
  /** lbl_105BA210: the text of the last text entry dialog (type 3). */
  dialogText = "";
  /**
   * +0xec: the phone book request (TryDialog kind 0xa): minus the caller's
   * neighbor id while PostSim has to show CWinPhoneBook, then the picked
   * neighbor id, or -9999 when cancelled.
   */
  phoneBook = 0;
  /**
   * The person pickers of TryDialog kinds 6 (clothing) and 0xe (transform):
   * +0xf8 the clothing type in, the result's low word out (-2: OK); +0xfa
   * the transform's temp 0 in, the result's high word out (the index);
   * +0xfc / +0x100 the person waiting for the clothing / transform window.
   */
  outfitLo = 0;
  outfitHi = 0;
  clothingPerson: SimObject | null = null;
  transformPerson: SimObject | null = null;
  /** Kind 9 (pet pen): +0x104 the result's high word (the index), +0x108 the pet, +0x10c the low word (-2: OK). */
  petIndex = 0;
  petPerson: SimObject | null = null;
  petStatus = 0;
  /** A picker window PostSim opened and that is still up (the primitive waits). */
  pickerPending = false;
  /** Kinds 0xc / 0xf: the person whose magic book is open (the original runs it inside TryDialog). */
  magicBookPerson: SimObject | null = null;
  /** The person whose magic book was just closed (its primitive answers true on its next run). */
  magicBookDone: SimObject | null = null;
  /**
   * Edited body strings by person GUID (cXObject::TryGenericSimCall 24
   * writes the selector's STR# through EditPerson::End): read before the
   * object file's own.
   */
  readonly bodyStringEdits = new Map<number, string[]>();

  /** ObjectModule::GetCurrentDialog: the first queued dialog of `o` (done ones are dropped, as PostSim does). */
  getCurrentDialog(o: SimObject): ObjectDialog | null {
    for (let i = this.dialogs.length - 1; i >= 0; i--) if (this.dialogs[i]!.state === 5) this.dialogs.splice(i, 1);
    return this.dialogs.find((d) => d.obj === o) ?? null;
  }

  /**
   * ObjectModule::EnqueueObjectDialog (the generic kinds): a new
   * ObjectDialog with SetParams, shown by PostSim once the tick is over.
   */
  enqueueObjectDialog(o: SimObject, elem: StackElem, op: Uint8Array): void {
    const d = new ObjectDialog(o);
    d.setParams(elem, op, this.dialogHooks);
    this.dialogs.push(d);
    this.record(o, "dialog", d.message);
    const hooks = this.dialogHooks;
    if (hooks) queueMicrotask(() => {
      // ObjectModule::PostSim: Show every dialog still at state 0.
      if (d.state === 0) hooks.show(d);
    });
  }

  /** A person joined the module at run time (SAnimator::Initialize: the simulator gives it a skeleton). */
  onPersonMade: ((p: PersonSim) => void) | null = null;

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
    // AddObject stores 0xffff; MakeNewOutOfWorldObject then sets sim flag 1
    // (0x10000: TickAllObjects runs it) on the object and on every part.
    // Without it a bought object's Main never runs and its lockout count
    // (object data 25) never counts down: autonomy skips it for good.
    this.simFlags[id - 1] = 0x1ffff;
    // The list stays in object id order (TickAllObjects, Set To Next).
    let k = this.list.findIndex((y) => y.id > id);
    if (k < 0) k = this.list.length;
    this.list.splice(k, 0, o);
    if (x.isPerson) {
      this.people.push(o);
      if (o instanceof PersonSim) this.onPersonMade?.(o);
    }
    // A multi-tile part arrives alone (the factory adds them one by one): its own Init runs.
    if (runInit) {
      if (x.selector.objd.masterId === 0) o.reset(false);
      else o.resetPart(false);
    } else o.resetTree(o.behavior, o.fnTable.getTreeID(EP.main));
    this.updatePrimitiveLimit();
    // MakeNewOutOfWorldObject ends with GlobalDispatch(0xe2, id): House::DoCommand
    // runs Neighborhood::UpdateInstanceVisitorTypes when the new object is a person.
    if (runInit && x.isPerson) this.updateInstanceVisitorTypes();
    return o;
  }

  /**
   * Neighborhood::UpdateInstanceVisitorTypes: every person of the lot gets
   * its person type (person data 0x20, cXPerson +0x5cc): a member of the
   * active family is 0 (a resident), anyone else keeps a non-zero type (0
   * becomes 1, a visitor); on a lot that is not residential (GetZoningType
   * of the house != 1) a 0 becomes 1 too.
   */
  updateInstanceVisitorTypes(): void {
    const family = this.sim.state?.family ?? [];
    const residential = this.getZoningType(this.sim.globals[10]!) === 1;
    for (const p of this.persons) {
      const pd = p.pd;
      let t = pd[0x20] || 1;
      if (family.some((f) => ((f.guid ?? 0) | 0) === (p.obj.selector.guid | 0))) t = 0;
      if (!residential && t === 0) t = 1;
      pd[0x20] = t;
    }
  }

  /** ObjectModule::KillObject's module part for an object removed by the world (buy / build tools). */
  removeObject(x: XObject): void {
    const o = this.objects[x.objectId - 1];
    if (!o || o.obj !== x || o.killed) return;
    // KillOutOfWorldObject: the people using it let go (cXPerson::Cleanup(obj)).
    this.cleanupPeople(o);
    o.killed = true;
    // ObjectModule::RemoveObject: the object's dialogs are aborted.
    for (const d of this.dialogs) if (d.obj === o) d.abort();
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
    // This Neighborhood is the one in memory: Neighborhood::Save writes its relationships and inventories.
    setLiveNeighborhood(nbhd ? { data: nbhd, persistent: new Map() } : null);
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

  /**
   * Neighborhood::SavePersistentData(person): the persistent data fields
   * (Neighbor::GetPersistentDataFields) copied from the person (+0x58c) into
   * its neighbor (+0x74); the next Neighborhood::Save writes them.
   */
  savePersistentData(p: SimObject): void {
    if (!p.person) return;
    const guid = p.obj.selector.guid >>> 0;
    const nb = this.findNeighborByGUID(guid);
    if (!nb) return;
    if (!nb.personData || nb.personData.length < 0x100) {
      const pd = new Int16Array(0x100);
      if (nb.personData) pd.set(nb.personData);
      nb.personData = pd;
    }
    for (const i of PERSISTENT_DATA_FIELDS) nb.personData[i] = p.person.personData[i] ?? 0;
    const live = getLiveNeighborhood();
    if (live?.data === this.nbhd) live.persistent.set(guid, nb.personData.slice());
  }

  /** Neighborhood::GetZoningType: house 0 -> 1, listed -> its type, else 0. */
  getZoningType(house: number): number {
    if (house === 0) return 1;
    return this.zoning.get(house) ?? 0;
  }

  /**
   * PersonFinder::GetPersonInHouseIndex(0) then GetInstance: the person of the
   * current family's first member (CPState's family), or null when it is not here.
   */
  firstPersonInHouse(): SimObject | null {
    const guid = this.sim.state?.family[0]?.guid;
    if (guid === undefined) return null;
    return this.people.find((p) => !p.killed && (p.obj.selector.guid | 0) === (guid | 0)) ?? null;
  }

  /**
   * Family::LoadSpellsForFamily on the current family (the one of global 9):
   * when its spells were streamed (+0x14c), its id is not 0, the lot (global
   * 10) is residential and the spell book (GUID 0xb6c90029) is here, each of
   * the book's attributes 0..5 rises to the family's spell (+0x14e..+0x158).
   */
  loadSpellsForFamily(): void {
    const id = this.sim.globals[9]!;
    const fam = id !== 0 ? this.nbhd?.families.find((f) => f.chunkId === id) : undefined;
    if (!fam?.spells || this.getZoningType(this.sim.globals[10]!) !== 1) return;
    const book = this.getInstances(GUID_SPELL_BOOK)[0];
    if (!book) return;
    const a = book.obj.attributes;
    fam.spells.forEach((v, i) => {
      if (i < a.length && a[i]! < v) a[i] = v;
    });
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

  /**
   * The GUIDs named by the Create Object Instance nodes (primitive 42, not
   * "create neighbor") of the loaded behaviors. The original ObjectFolder
   * holds every object so a check tree can create one at once; here their
   * files are loaded ahead (WinLotView.initSimulator).
   */
  createdObjectGUIDs(): Set<number> {
    const files = new Set<ResFile>();
    for (const b of this.behaviors.values()) for (const f of [b.glob, b.priv, b.middle]) if (f) files.add(f);
    const out = new Set<number>();
    for (const f of files) {
      for (const c of f.list("BHAV")) {
        const t = loadTree(f, c.id);
        if (!t) continue;
        for (let i = 0; i < t.count; i++) {
          const off = t.nodeOffset(i);
          if ((t.primitive(off) & 0x7fff) !== 42 || (t.bytes[off + 4 + 5]! & 4) !== 0) continue;
          out.add(t.view.getUint32(off + 4, true));
        }
      }
    }
    return out;
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

  /**
   * ObjectModule::SetTutorialObject: taken when free (or released with null);
   * the dialogs of the object that held it are aborted. False when another
   * object holds it.
   */
  setTutorialObject(o: SimObject | null): boolean {
    const cur = this.tutorialObject;
    if (cur && o) return false;
    if (cur === o) return true;
    if (cur) for (const d of this.dialogs) if (d.obj === cur) d.abort();
    this.tutorialObject = o;
    this.onTutorialObjectChanged?.(o);
    return true;
  }

  /** ObjectModule::AddObject's primitive limit (lbl_105BA2EC): objects x 15 + 10000 + characters^2 x 15. */
  updatePrimitiveLimit(): void {
    const n = this.numCharacters ?? this.people.length;
    treeSimGlobals.maxPrimitives = this.count * 0xf + 10000 + n * n * 0xf;
  }

  /**
   * ObjectModule::ResetForVacation (cSimsApp::LoadGame on vacation, community
   * and Magic Town lots, before the arrivals come in): every person on the
   * lot is killed (KillOutOfWorldObject), objects whose OBJD +0xc4 is 2 go
   * to the kill queue, those with 1 are reset (vtable +0x48: Init runs, e.g.
   * the vacation NPC controller's "CT - Lot Reset" makes the mascot,
   * janitor, maid and director when global 0x20 is 0). `keep`: people made
   * before the call that the original makes after it (the arriving family).
   * The house +0x3c reset and GlobalDispatch(0x108) are not ported.
   */
  resetForVacation(keep: (o: SimObject) => boolean): void {
    for (const o of [...this.list]) {
      if (o.killed) continue;
      const objd = o.obj.selector.objd;
      if (objd.objectType === 2) {
        if (!keep(o)) this.killObject(o);
        continue;
      }
      const action = objd.i16(0xc4);
      if (action === 2) this.addToKillQueue(o.id, 0);
      else if (action === 1) o.reset(false);
    }
  }

  /** ObjectModule::AddToKillQueue. */
  addToKillQueue(id: number, flag: number): void {
    if (!this.killQueue.some((k) => k.id === id)) this.killQueue.push({ id, flag });
  }

  /**
   * The kill queue: ObjectModule::KillObject for each entry (whose object
   * may already be gone with a container or a multi-tile group).
   */
  runKillQueue(): void {
    while (this.killQueue.length) {
      const { id } = this.killQueue.shift()!;
      const o = this.getObject(id);
      if (o) this.killObject(o);
    }
  }

  /**
   * ObjectModule::KillObject + KillOutOfWorldObject, module part. A
   * multi-tile object dies as a whole (every part of the lead's chain). For
   * each object: every other person forgets what it did with it
   * (cXPerson::Cleanup(obj): its frames running the object's trees are
   * popped, which gives back the object data 62 counts, e.g. of a social
   * interaction object), then the object's own Cleanup(0) (a person lets go
   * of its records the same way); the objects in its slots (1..n) are killed
   * with it; it leaves the module (RemoveObject: its dialogs are aborted).
   * The world part (pick up out of the tile or the container's slot, the
   * drawing) is `worldHooks.kill`, once for the whole object.
   */
  killObject(o: SimObject): void {
    if (o.killed) return;
    const lead = o.obj.selector.objd.masterId !== 0 ? (o.obj.mtLeadId !== 0 ? o.obj.mtLeadId : o.id) : 0;
    const group = lead !== 0 ? this.list.filter((x) => x.id === lead || x.obj.mtLeadId === lead) : [o];
    if (!group.includes(o)) group.push(o);
    // KillOutOfWorldObject flags every part (+0x114 0x40) before the first one goes.
    for (const x of group) x.killed = true;
    for (const x of group) {
      this.cleanupPeople(x);
      x.cleanup();
      for (const s of x.obj.objectSlots.slice(1)) {
        const c = s.containedId !== 0 ? this.getObject(s.containedId) : null;
        if (c && !c.killed) this.killObject(c);
      }
    }
    for (const x of group) {
      for (const d of this.dialogs) if (d.obj === x) d.abort();
      if (this.objects[x.id - 1] === x) this.objects[x.id - 1] = null;
      const li = this.list.indexOf(x);
      if (li >= 0) this.list.splice(li, 1);
      const pi = this.people.indexOf(x);
      if (pi >= 0) this.people.splice(pi, 1);
    }
    this.worldHooks?.kill(o.obj);
    for (const x of group) {
      // KillOutOfWorldObject: cXObject::HierSever (out of its container's slot even
      // when it was not in the world, e.g. a controller held by a person brought in
      // by a ped marker), then RelMatrix::RemoveArray on every object.
      for (const y of this.list) {
        for (const s of y.obj.objectSlots) if (s.containedId === x.id) s.containedId = 0;
        y.obj.relations.delete(x.id);
      }
      if (this.tutorialObject === x) this.setTutorialObject(null);
    }
    for (const x of group) this.onKill?.(x);
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

  /** Neighborhood::GetNextNeighborID: the next id above `id` that has a neighbor (0 when none). */
  nextNeighborID(id: number): number {
    let best = 0;
    for (const n of this.nbhd?.neighbors ?? []) if (n.id > id && (best === 0 || n.id < best)) best = n.id;
    return best;
  }

  /** Neighborhood::FindNeighborByID. */
  findNeighborByID(id: number): Neighbor | null {
    return this.nbhd?.neighbors.find((n) => n.id === id) ?? null;
  }

  /** Neighborhood::FindNeighborByGUID. */
  findNeighborByGUID(guid: number): Neighbor | null {
    return this.nbhd?.neighbors.find((n) => (n.guid | 0) === (guid | 0)) ?? null;
  }

  /**
   * Neighborhood::GetInventoryByNeighbourID: the neighbor's SimInventory,
   * a new empty one added when it has none. Without a neighborhood they
   * are kept for the session.
   */
  getInventoryByNeighbourID(id: number): SimInventory {
    const list = this.nbhd?.inventories ?? this.sessionInventories;
    let inv = list.find((x) => x.neighborId === id);
    if (!inv) {
      inv = { neighborId: id, tokens: [] };
      list.push(inv);
    }
    return inv;
  }

  /**
   * RelMatrix of a neighbor (Neighbor +0xc): the array of values kept for
   * `other` (undefined when there is none) and how to grow it to n values
   * (RelMatrix::SetArraySize, new values 0). The arrays are the
   * neighborhood's own (the relationships panel and the save read them).
   */
  neighborRelation(nb: Neighbor, other: number): { arr: number[] | undefined; grow: (n: number) => number[] } {
    const find = () => nb.relationships.find((r) => r.other === other);
    return {
      arr: find()?.values,
      grow: (n) => {
        let r = find();
        if (!r) {
          r = { other, values: [] };
          nb.relationships.push(r);
        }
        while (r.values.length < n) r.values.push(0);
        return r.values;
      },
    };
  }

  /**
   * InterpValue scope 32: the person data of the neighbor whose id is
   * `neighborId` (Neighbor +0x74). Errors 0x37 (no such neighbor), 0x21
   * (index out of 0..0xff).
   */
  neighborPersonData(neighborId: number, data: number): number {
    const nb = this.findNeighborByID(neighborId);
    if (!nb) simThrow(0x37);
    if (data < 0 || data >= 0x100) simThrow(0x21);
    return nb.personData?.[data] ?? 0;
  }

  /**
   * Neighborhood::GetNeighborData (InterpValue scope 24) of the neighbor
   * `neighborId` (0 when unknown): 0 its person's object id on this lot (0
   * when absent), 1 whether it belongs to the active family, 3 / 4 zero, 6
   * the house of its family (0 when none). Others (2 Neighbor +0xe8, 5 the
   * friend count, 7..9 family flags) are not ported (0).
   */
  neighborData(neighborId: number, data: number): number {
    const nb = this.findNeighborByID(neighborId);
    if (!nb || data < 0 || data > 9) return 0;
    switch (data) {
      case 0:
        return this.people.find((p) => (p.obj.selector.guid | 0) === (nb.guid | 0))?.id ?? 0;
      case 1:
        return this.sim.state?.family.some((f) => ((f.guid ?? 0) | 0) === (nb.guid | 0)) ? 1 : 0;
      case 2: // Neighbor +0xe8: the stored person data 0x3a (age)
        return nb.personData?.[0x3a] ?? 0;
      case 3:
      case 4:
        return 0;
      case 7: // the family (Neighbor +0xee = Family +0x10c) living in a house: Family +0x138 bit 0
      case 8: { // ... bit 1
        const fn = nb.personData?.[0x3d] ?? 0;
        if (fn === 0) return 0;
        const fam = this.nbhd?.families.find((f) => f.chunkId === fn);
        if (!fam || fam.houseNumber === 0) return 0;
        return data === 7 ? fam.flags & 1 : (fam.flags >> 1) & 1;
      }
      case 6:
        return this.nbhd?.families.find((f) => f.memberGuids.some((g) => (g | 0) === (nb.guid | 0)))?.houseNumber ?? 0;
      case 5: // Neighborhood::GetFriendCount(neighbor)
        return this.neighborFriendCount(nb);
      case 9: { // Family::GetFriendCount -> Neighborhood::GetFamilyFriendsCount of the neighbor's family
        const fn = nb.personData?.[0x3d] ?? 0;
        const fam = fn === 0 ? undefined : this.nbhd?.families.find((f) => f.chunkId === fn);
        return fam ? this.familyFriendCount(fam.memberGuids) : 0;
      }
      default:
        return this.unportedValue(`scope 24 neighbor data ${data}`, 0);
    }
  }

  /** The daily relationship (RelMatrix value 0) of `from` toward neighbor id `to`, null without an entry. */
  private static dailyRel(from: Neighbor, to: number): number | null {
    const r = from.relationships.find((x) => x.other === to);
    return r && r.values.length > 0 ? r.values[0]! : null;
  }

  /** Both ways at least lbl_105BA1F4 (25). */
  private static areFriends(a: Neighbor, b: Neighbor): boolean {
    const ab = SimModule.dailyRel(a, b.id);
    const ba = SimModule.dailyRel(b, a.id);
    return ab !== null && ba !== null && ab >= 25 && ba >= 25;
  }

  /**
   * Neighborhood::GetFriendCount(Neighbor *): the other characters belonging
   * to a family (Neighbor +0xee, person data 0x3d) sharing a daily
   * relationship of at least 25 both ways. The original caches it at
   * Neighbor +0x20 and recomputes when +0x24 is set; it is recomputed here.
   */
  private neighborFriendCount(nb: Neighbor): number {
    let n = 0;
    for (const o of this.nbhd?.neighbors ?? []) {
      if (o === nb || !o.personData || o.personData[0x3d] === 0) continue;
      if (SimModule.areFriends(nb, o)) n++;
    }
    return n;
  }

  /**
   * Neighborhood::GetFamousFriendCount(neighbor), through
   * PersonFinder::GetFamousFriendCount: the fame levels (person data 0x51) of
   * the other characters of another family (person data 0x3d) sharing a
   * daily relationship of at least 25 both ways.
   */
  famousFriendCount(guid: number): number {
    const nb = this.findNeighborByGUID(guid);
    if (!nb) return 0;
    const fam = nb.personData?.[0x3d] ?? 0;
    let n = 0;
    for (const o of this.nbhd?.neighbors ?? []) {
      const ofam = o.personData?.[0x3d] ?? 0;
      if (o === nb || ofam === 0 || ofam === fam) continue;
      if (SimModule.areFriends(nb, o)) n += o.personData?.[0x51] ?? 0;
    }
    return n;
  }

  /** Neighborhood::UpdateFamilyFriendsCount for one family (see NghInterface.getFamilyFriendsCount). */
  private familyFriendCount(memberGuids: number[]): number {
    const all = this.nbhd?.neighbors ?? [];
    const members = all.filter((n) => memberGuids.some((g) => (g | 0) === (n.guid | 0)));
    let count = 0;
    for (const n of all) {
      if (members.includes(n) || !n.personData || n.personData[0x3d] === 0) continue;
      if (members.some((m) => SimModule.areFriends(n, m)) && (n.personData[65] ?? 0) < 2) count++;
    }
    return count;
  }

}
