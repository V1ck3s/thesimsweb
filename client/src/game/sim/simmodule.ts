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

import { Transforms } from "./transforms.js";
import { type FarEntryInfo, readFarManifest } from "../../engine/assets.js";
import { ResFile } from "../world/iffres.js";
import type { XObject } from "../world/objects.js";
import type { HousePageStats } from "../world/housestats.js";
import { addNewStat, FAMILY_STAT_FIELDS, getFamilyHistory } from "../data/familyhistory.js";
import type { ObjSelector } from "../world/objselector.js";
import { Behavior } from "./behavior.js";
import type { Simulator } from "./simulator.js";
import { SimObject } from "./xobject.js";
import { simThrow, treeSimGlobals } from "./treesim.js";
import { EP } from "./objfntable.js";
import { PersonSim, SCORE_CURVE_MOTIVES, type Interaction, type MenuItem } from "./person.js";
import { curvesFromStrings, HAPPY_CURVE_MOTIVES, type MotiveCurve } from "./motives.js";
import { loadStringSet, loadTree } from "./behavior.js";
import type { Family, Neighbor, NeighborhoodData, SimInventory } from "../data/neighborhood.js";
import { getLiveNeighborhood, PERSISTENT_DATA_FIELDS, setLiveNeighborhood } from "../data/nbhdstore.js";
import type { SimCareer } from "./careers.js";
import type { FameScoring } from "./fametrack.js";
import { ObjectDialog, type DialogHooks } from "./objectdialog.js";
import type { StackElem } from "./treestack.js";
import { TreeTable, type TreeTableEntry } from "./treetable.js";
import { friendshipThreshold, loadFloatConstants, setFriendshipThreshold } from "./floatconstants.js";
import { setMotiveConstants } from "./motives.js";
import { autonomyConstants, type AutonomyConstants } from "./person.js";
import { readSlotChunk } from "../world/slots.js";
import { resolveRoomID, routingSlotFrom, type RoutingSlot } from "./routing.js";

const GLOBAL_FAR = "GameData/Global/Global.far";

/** NeighborhoodConstants "architecture value multiplier" (lbl_105BA1EC, 0.7 as a float). */
const ARCHITECTURE_VALUE_MULTIPLIER = Math.fround(0.7);

/**
 * GlobalConstantsClient::UpdateConstants at start-up (cSimsApp): the
 * constants the neighborhood screens read before any lot is loaded, here the
 * friendship threshold of FCNS 2 (AutonomyConstantsClient).
 */
export async function loadGlobalConstants(): Promise<void> {
  const r = await SimResources.load();
  setFriendshipThreshold(loadFloatConstants(r.glob, 2));
}

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
  /** ComputeRect(obj, pos) then SectWall(rect, level), with the object's current direction. */
  sectWall(obj: XObject, pos: FPos, level: number): boolean;
  moveTo(obj: XObject, pos: FPos, level: number): void;
  /** cXObject::Pickup (out of the world). */
  pickup(obj: XObject): void;
  /** Turn (vtable +0x54): cXObject::Turn, or cXMTObject::Turn turning every part of the group. */
  turn(obj: XObject, n: number): void;
  /** cXObject::FindGoodLocation (Placement.findGoodLocation). */
  findGoodLocation(obj: XObject, start: FPos, level: number, opts: { emptyTile: boolean; buildable: boolean; random: (() => number) | null; sameRoom?: boolean; direction?: number }): FPos | null;
  kill(obj: XObject): void;
  /** Placement's last error (lbl_105BA1A8) and the object TestIntersection hit (lbl_105BA248). */
  lastError(): { code: number; obstacle: number };
  /** The person's body strings changed (TryGenericSimCall 24): redress it (SAnimator::UpdateOutfitAndHands). */
  bodyStringsChanged?(obj: XObject, strings: readonly string[]): void;
  /** ObjectFolder::GetKeyGUID: the GUID of the folder's key token object (OBJD type 13), 0 without one. */
  keyGUID?(): number;
}

/** See SimModule.transitHooks (nbhd/transit.ts). */
export interface TransitHooks {
  /** cXObject::TryDialog kinds 5 / 7 / 0xb / 0xd; undefined = not handled. */
  tryDialog(o: SimObject, kind: number): number | undefined;
  /** cXObject::TryGenericSimCall entries 3 (RemoveTaxiDialog) and 17 (TryChangeLots). */
  genericSimCall(o: SimObject, call: number): number;
}

/**
 * cXObject::TryMakeNewCharacter's request: Neighborhood::AddNewCharacter of
 * `type` (0 person, 1 dog, 2 cat), then the EditPerson steps on the new
 * character (see nbhd/makecharacter.ts). `color` is the entry of the new
 * character's semi-global STR# 0x2000, `head` / `body` the
 * GetNextRandomNumber draws, `petBody` the module's +0x104 (the coat picked
 * in cWinPetSelectDlg, -1 for none), `name` lbl_105BA210 or its default.
 */
export interface MakeCharacterRequest {
  type: number;
  colorIndex: number;
  age: number;
  gender: number;
  head: number;
  body: number;
  petBody: number;
  name: string;
}

/** The new neighbor's id, 0 when it failed; `error` a simulation error to throw (0x3b: no such colour). */
export interface MakeCharacterResult {
  neighborId: number;
  error?: number;
}

/** A person redesigned in the lot (Neighborhood::ChildToAdult's EndDesignAPerson(save)). */
export interface DesignedPerson {
  guid: number;
  /** The character file (ObjSelector.fileKey). */
  fileKey: string;
  name: string;
  bio: string;
  bodyStrings: string[];
  personData: Int16Array;
}

/** See SimModule.characterHooks. */
export interface CharacterHooks {
  makeNewCharacter(req: MakeCharacterRequest): Promise<MakeCharacterResult>;
  /** The character file, person data and portraits of a person redesigned in the lot. */
  saveDesignedPerson(p: DesignedPerson): Promise<void>;
  /** cSimsApp::SaveGame, asked by a transform (cSimulator +0xe0). */
  saveGame?(): void;
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

/**
 * The first relationship entry of `nb` toward `other` (what
 * `relationships.find` returns), through an index rebuilt when entries were
 * added: the neighbor loops of the Visit Generator read friend counts for
 * every neighbor pair each hour.
 */
const relIndexes = new WeakMap<Neighbor, { n: number; map: Map<number, Neighbor["relationships"][number]> }>();
function relationEntry(nb: Neighbor, other: number): Neighbor["relationships"][number] | undefined {
  let ix = relIndexes.get(nb);
  if (!ix || ix.n !== nb.relationships.length) {
    const map = new Map<number, Neighbor["relationships"][number]>();
    for (const r of nb.relationships) if (!map.has(r.other)) map.set(r.other, r);
    ix = { n: nb.relationships.length, map };
    relIndexes.set(nb, ix);
  }
  return ix.map.get(other);
}

/** The neighbors by id (the first one of an id, as `find`) and their sorted ids, rebuilt when neighbors were added. */
const neighborIndexes = new WeakMap<Neighbor[], { n: number; byId: Map<number, Neighbor>; ids: number[] }>();
function neighborIndex(list: Neighbor[]): { byId: Map<number, Neighbor>; ids: number[] } {
  let ix = neighborIndexes.get(list);
  if (!ix || ix.n !== list.length) {
    const byId = new Map<number, Neighbor>();
    for (const nb of list) if (!byId.has(nb.id)) byId.set(nb.id, nb);
    ix = { n: list.length, byId, ids: [...byId.keys()].sort((a, b) => a - b) };
    neighborIndexes.set(list, ix);
  }
  return ix;
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
  /** The neighborhood (person persistent data, relationships); null when it failed to load. */
  nbhd: NeighborhoodData | null = null;
  /**
   * PersonFinder::GetName of every neighbor, by neighbor id: the catalog name
   * of the person's object (the character file's CTSS for the player's sims,
   * the NPC object's for townies). Filled in the background once the lot
   * runs (data/family.ts shareSimulationNeighborhood): the text tokens
   * ($Neighbor, $NeighborLocal) are expanded synchronously, and a neighbor's
   * own name is only its file's ("User00109").
   */
  readonly neighborNames = new Map<number, string>();
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
  /**
   * The UI side of prim 34 (UI Effect): Tut_FlashButtonByImageID(image id, on),
   * Tut_FlashPersonPanelButton and Tut_FlashRelButton (by the person's GUID,
   * Neighborhood::FindNeighborByID done here). Null: recorded only.
   */
  tutorialHooks: {
    flashButtonByImageID(id: number, on: boolean): void;
    flashPersonPanelButton?(guid: number, on: boolean): void;
    flashRelButton?(guid: number, on: boolean): void;
    /** Generic sim call 0: Neighborhood::TutorialCompleted(0)'s neighborhood side (NGBH +0x12a / +0x12c). */
    tutorialCompleted?(n: number): void;
  } | null = null;
  /** Called when an object's look changed (cXObject::Dirty) or it was killed. */
  onDirty: ((o: SimObject) => void) | null = null;
  onKill: ((o: SimObject) => void) | null = null;
  /** KillOutOfWorldObject's deselection of the selected person (OnSelectionChange, GlobalDispatch(0xe4, 0)). */
  onDeselect: ((o: SimObject) => void) | null = null;
  /** Neighborhood +0x16c zoning: house number -> 1 residential / 2 community (UserData LotZoning.iff STR# 1). */
  readonly zoning = new Map<number, number>();
  /**
   * ObjectModule +0x38: the objects that disabled Buy and Build
   * (DisableBuyAndBuild adds one entry, EnableBuyAndBuild erases one of that
   * object, RemoveObject all of them). Saved with the module (ObjM v > 0x33):
   * the lot view shares the loaded ObjectModule's vector here.
   */
  buyBuildDisablers: number[] = [];

  /** Disable (true) or EnableBuyAndBuild (false) for `id`. */
  setBuyAndBuildDisabled(id: number, disabled: boolean): void {
    const was = this.buyBuildDisablers.length > 0;
    if (disabled) this.buyBuildDisablers.push(id);
    else {
      const i = this.buyBuildDisablers.indexOf(id);
      if (i >= 0) this.buyBuildDisablers.splice(i, 1);
    }
    if (was !== this.buyBuildDisablers.length > 0) this.buyAndBuildChanged();
  }

  /**
   * ObjectModule::UpdateRooms(level) (House::DoCommand, after the rooms were
   * computed; 0: every level): an object at level 0 is put on level 1; the
   * objects of that level get their room (object data 29) resolved, people
   * their current room (cXPerson::UpdateCurrentRoom); then each of them with
   * a "room changed" tree (entry 7, the doors) runs it.
   */
  updateRooms(level: number): void {
    const fixed = this.sim.world;
    if (!fixed) return;
    for (const o of [...this.list]) {
      const x = o.obj;
      if (x.level === 0) x.level = 1;
      if (level !== 0 && x.level !== level) continue;
      x.objectData[29] = resolveRoomID(fixed, x.fx, x.fy, x.level);
      if (o instanceof PersonSim) o.updateCurrentRoom();
    }
    for (const o of [...this.list]) {
      if (o.killed || (level !== 0 && o.obj.level !== level)) continue;
      const tree = o.fnTable.getTreeID(7);
      if (tree === 0) continue;
      try {
        o.runCheckTree(o.behavior, 0, tree, null);
      } catch (e) {
        console.warn("[rooms] room changed tree failed", o.obj.selector.name, e);
      }
    }
  }

  /** ObjectModule::RemoveObject: every Buy and Build lock of object `id` goes. */
  private liftBuyBuildLocks(id: number): void {
    if (!this.buyBuildDisablers.includes(id)) return;
    for (let k = this.buyBuildDisablers.length - 1; k >= 0; k--) if (this.buyBuildDisablers[k] === id) this.buyBuildDisablers.splice(k, 1);
    if (this.buyBuildDisablers.length === 0) this.buyAndBuildChanged();
  }

  /**
   * GlobalDispatch(0x108) -> cSimsApp::DoCommand(0x106): CPState 0x1000000,
   * UpdateCPStateFromWorld sets IsBuyAndBuildDisabled from the vector.
   */
  buyAndBuildChanged(): void {
    const st = this.sim.state;
    if (!st) return;
    st.buyAndBuildDisabled = this.buyBuildDisablers.length > 0;
    st.setDirty(0x1000000);
  }
  /**
   * cXObject::TryUserEvent's outside world: cOptionsMgr::GetLivePIP and
   * GViewer::DoPictureInPicture (`window` false: cDDDSimsView centers the lot
   * view on the object; true: cWinPictureInPicture opens / closes).
   */
  userEventHooks: {
    livePIP(): boolean;
    pictureInPicture(o: SimObject, a: { open: boolean; window: boolean; ms: number; arg3: number; arg2: number; flag4: boolean; snapshot: boolean; caption: string }): void;
  } | null = null;
  /**
   * RoomManager::GetRoom for cXObject::InterpValue's scope 23 (the lot view's rooms and lighting),
   * and RoomManager::RoomLightingChanged / RoomScoreChanged(room) for cXObject::TryUpdate.
   */
  roomHooks: {
    room(id: number): { ambient: number; outside: boolean; level: number; area: number } | null;
    roomLightingChanged?(id: number): void;
    roomScoreChanged?(id: number): void;
    /** cXPerson::Simulate's room motive: Room +0x68, RoomManager +0x48 outside, null without the room. */
    roomScore?(id: number): number | null;
    /** Room::SetOverheadLights (cXPerson::UpdateCurrentRoom). */
    setOverheadLights?(id: number, on: boolean): void;
    /** UpdateCurrentRoom's GlobalDispatch(0xf7) (HouseViewer: the dynamic cutaway). */
    currentRoomChanged?(): void;
  } | null = null;
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

  /** cXPerson::Place (vtable +0x60): after cXObject::Place, a person updates its current room. */
  placed(obj: XObject): void {
    for (const p of this.persons) if (p.obj === obj) p.updateCurrentRoom();
  }

  /** ObjectModule::DayChanged: cXObject::DayPassed on every object, in module order. */
  dayChanged(): void {
    for (const o of this.list) this.dayPassed(o);
  }

  /**
   * cXObject::DayPassed: the age from the birth date (object data 45..47,
   * +0xa4..+0xa8) against the simulator's date: years into object data 18
   * (+0x6e), months into 48 (+0xaa); then the depreciation of the OBJD (the
   * master selector's for the lead of a multi-tile object, none for its other
   * parts) unless it is self depreciating (+0x4a): the current value (object
   * data 41) loses the initial depreciation (+0x46) while it is the price
   * (+0x24), else the daily one (+0x48), down to the limit (+0x4c).
   */
  private dayPassed(o: SimObject): void {
    const d = o.obj.objectData;
    const g = this.sim.globals;
    let years = (g[8]! - d[45]!) << 16 >> 16;
    let months = (g[7]! - d[46]!) << 16 >> 16;
    if (((g[1]! - d[47]!) << 16 >> 16) < 0) months = (months - 1) << 16 >> 16;
    if (months < 0) {
      months += 12;
      years = (years - 1) << 16 >> 16;
    }
    d[18] = years;
    d[48] = months + years * 12;
    let objd = o.obj.selector.objd;
    if (objd.masterId !== 0) {
      if (o.obj.mtLeadId !== 0 && o.obj.mtLeadId !== o.id) return;
      objd = o.obj.selector.getMasterSelector().objd;
    }
    if (objd.i16(0x4a) !== 0) return;
    const v = d[41]!;
    const step = v !== objd.i16(0x24) || objd.i16(0x46) === 0 ? objd.i16(0x48) : objd.i16(0x46);
    const next = (v - step) << 16 >> 16;
    d[41] = next < objd.i16(0x4c) ? objd.i16(0x4c) : next;
  }

  /**
   * Neighborhood::AddFamilyHistoryStat (at midnight, before PostSim): for the
   * family of the house (global 9, Family +0x10c not 0), a FamilyStat into
   * its history (Family::GetHistory, FamilyHistory::AddNewStat). `house` is
   * House::GetHouseStats; the values are those the simulator holds now.
   */
  addFamilyHistoryStat(house: HousePageStats): void {
    const fn = this.sim.globals[9]!;
    const fam = fn === 0 ? undefined : this.nbhd?.families.find((f) => f.chunkId === fn);
    if (!fam) return;
    const s = new Int32Array(FAMILY_STAT_FIELDS);
    s[0] = fam.houseNumber << 16 >> 16;
    // Members with an instance on the lot: count, then by (child ? 2 : 0) | person data 0x41 bit 0,
    // and the grown-ups whose person data 0x38 is set.
    for (const guid of fam.memberGuids) {
      const p = this.persons.find((x) => (x.obj.selector.guid | 0) === (guid | 0));
      if (!p) continue;
      s[1]!++;
      const child = p.pd[0x3a]! < 0x12 ? 2 : 0;
      const kind = (p.pd[0x41]! & 1) | child;
      s[2 + kind]!++;
      if (child === 0 && p.pd[0x38] !== 0) s[6]!++;
    }
    s[7] = house.objectCount << 16 >> 16;
    s[8] = this.sim.objectValue;
    s[9] = this.sim.archValue;
    s[10] = house.squareFeet << 16 >> 16;
    s[11] = house.lotSize;
    s[12] = house.furnishingsScore << 16 >> 16;
    s[13] = house.sizeScore << 16 >> 16;
    s[14] = house.yardScore << 16 >> 16;
    s[15] = house.upkeepScore << 16 >> 16;
    s[16] = house.layoutScore << 16 >> 16;
    const e = this.sim.getTodaysExpenses();
    s[17] = e[1]!;
    s[18] = e[4]!;
    s[19] = e[3]!;
    s[20] = e[5]!;
    s[21] = e[6]!;
    s[22] = (e[2]! + e[0]!) | 0;
    s[23] = e[7]!;
    s[24] = this.sim.getFunds();
    // Relationships across the family's border: value 1 set (members toward others, others
    // toward members), value 0 at least lbl_105BA1F4 (friendshipThreshold) (members toward others, others toward members).
    const members = new Set(fam.memberGuids.map((g) => g | 0));
    const byId = new Map((this.nbhd?.neighbors ?? []).map((n) => [n.id, n]));
    for (const n of this.nbhd?.neighbors ?? []) {
      const inFamily = members.has(n.guid | 0);
      for (const r of n.relationships) {
        const other = byId.get(r.other);
        if (!other || members.has(other.guid | 0) === inFamily) continue;
        if ((r.values[0] ?? 0) >= friendshipThreshold) s[inFamily ? 27 : 28]!++;
        if (r.values.length > 1 && r.values[1] !== 0) s[inFamily ? 25 : 26]!++;
      }
    }
    s[29] = this.familyFriendsCount(fam) << 16 >> 16;
    for (const k of [1, 2, 3, 4, 5, 6, 25, 26, 27, 28]) s[k] = s[k]! << 16 >> 16;
    addNewStat(getFamilyHistory(fam), s);
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

  /**
   * Primitive 19 (Make New Character), set by the game: the character file,
   * the neighbor and its EditPerson steps are asynchronous here, so the
   * primitive waits for them (`characterJobs`, keyed by the frame's state).
   */
  characterHooks: CharacterHooks | null = null;
  readonly characterJobs = new Map<number, { result: MakeCharacterResult | null }>();
  /** cSimulator +0x1a4: the transform requests of generic sim calls 39 / 40. */
  readonly transforms = new Transforms(this);
  characterJobSerial = 0;

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
    // ObjectModule::RemoveObject: the object's dialogs are aborted, its Buy and Build locks lifted.
    for (const d of this.dialogs) if (d.obj === o) d.abort();
    this.liftBuyBuildLocks(o.id);
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
    setLiveNeighborhood(
      nbhd
        ? {
            data: nbhd,
            persistent: new Map(),
            loadedHouse: () => ({
              house: this.sim.globals[10]!,
              netWorth: (this.sim.lotValue + this.sim.objectValue + Math.trunc(Math.fround(Math.fround(this.sim.archValue) * ARCHITECTURE_VALUE_MULTIPLIER))) | 0,
            }),
          }
        : null,
    );
    const g = this.res.glob;
    // GlobalConstantsClient: FCNS 1 / 5 / 6 motives, FCNS 2 autonomy.
    setMotiveConstants([1, 5, 6].map((id) => loadFloatConstants(g, id)));
    const autonomy = loadFloatConstants(g, 2);
    this.autonomy = autonomyConstants(autonomy);
    setFriendshipThreshold(autonomy);
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
   * ObjectModule::IsFamilyMemberAwakeAndVisible: one of the lot's people
   * (+0x8c / +0x90) is not hidden (object data 34, +0x8e: away at work, at
   * school, in a car), is a Sim (person data 65, +0x60e, below 2: not a pet),
   * is awake (cXPerson::IsSleeping: motive 11, +0x7b8, below 0.0,
   * lbl_105BBB78 + 4) and is a resident (person data 0x20, +0x5cc, 0).
   */
  isFamilyMemberAwakeAndVisible(): boolean {
    return this.persons.some(
      (p) => !p.killed && p.obj.objectData[34] === 0 && p.pd[65]! < 2 && !(p.motives[11]! < 0) && p.pd[0x20] === 0,
    );
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

  /**
   * The GUIDs whose catalog name cXObject::ParseUIString's $TokenNameLocal
   * may look up (ObjectFolder::GetSelectorByGUID, synchronous in the
   * original, whose folder has every selector open): the tokens of every
   * SimInventory, and the literal GUIDs of the Manage Inventory (51) nodes
   * of the loaded behaviors. The lot view opens their files before the
   * simulation starts.
   */
  tokenGUIDs(): Set<number> {
    const out = new Set<number>();
    for (const inv of this.nbhd?.inventories ?? this.sessionInventories) for (const t of inv.tokens) if (t.guid) out.add(t.guid >>> 0);
    const files = new Set<ResFile>();
    for (const b of this.behaviors.values()) for (const f of [b.glob, b.priv, b.middle]) if (f) files.add(f);
    for (const f of files) {
      for (const c of f.list("BHAV")) {
        const t = loadTree(f, c.id);
        if (!t) continue;
        for (let i = 0; i < t.count; i++) {
          const off = t.nodeOffset(i);
          if ((t.primitive(off) & 0x7fff) !== 51) continue;
          const guid = t.view.getUint32(off + 4 + 4, true);
          if (guid) out.add(guid);
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
   * ObjSelector::GetTypeAttributes (Mac 100f9e20): the ObjectFolder's block
   * (ObjectFolder::GetTypeAttrBlock) of the OBJD type-attribute GUID (+0xb8,
   * else the GUID). The folder keeps the blocks for the session and the
   * neighborhood file saves them (TATT); a block is the size AddSelector gives
   * it, the OBJD +0xb4 of the selector with that GUID (this one's when that
   * selector is not opened yet). A folder without blocks (tests) keeps them
   * in the module.
   */
  typeAttributes(sel: ObjSelector): Int16Array | null {
    const key = sel.objd.u32(0xb8) || sel.objd.u32(0x1c);
    const owner = key === sel.objd.u32(0x1c) ? sel : (sel.folder.selectorByGUID?.(key) ?? sel);
    const count = owner.objd.i16(0xb4);
    if (sel.folder.getTypeAttrBlock) return sel.folder.getTypeAttrBlock(key, count);
    if (count <= 0 || count > 31999) return null;
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

  /**
   * ObjectModule::BroadcastMessage(name, param) (Mac 100da7a0): every object
   * along the module's list whose Behavior has a tree of that name runs it
   * at once (TreeSim::RunOneTickTree, stack object 0, parameter 0 = param).
   */
  broadcastMessage(name: string, param: number): void {
    for (const o of [...this.list]) {
      if (o.killed) continue;
      const tree = o.behavior.getTreeID(name);
      if (tree === 0) continue;
      try {
        o.runOneTickTree(o.behavior, 0, tree, { src: [param, 0, 0, 0], at: 0 });
      } catch (e) {
        console.warn(`[sim] ${name}: object ${o.id} failed`, e);
      }
    }
  }

  /** ObjectModule::AddToKillQueue. */
  addToKillQueue(id: number, flag: number): void {
    const o = this.getObject(id);
    if (!o) return;
    // A multi-tile part queues its lead (cXMTObject: the +0x190 lead of a static object).
    const lead = o.obj.selector.objd.masterId !== 0 && o.obj.mtLeadId !== 0 ? (this.getObject(o.obj.mtLeadId) ?? o) : o;
    if (this.killQueue.some((k) => k.id === lead.id || k.id === id)) return;
    // Pickup(1) is left to KillObject's world part. Bit 0x1000: kept records (see SimObject.keepRecordObjects).
    lead.keepRecordObjects = flag === 0;
    this.killQueue.push({ id: lead.id, flag });
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
      // The selected person (+0x114 bit 2) loses its hilite and OnSelectionChange
      // runs first: the plumb bob on its head is picked up, not killed with the slots.
      if (x.isPerson && this.sim.globals[3] === x.id) {
        this.sim.globals[3] = 0;
        this.onDeselect?.(x);
      }
      this.cleanupPeople(x);
      x.cleanup();
      for (const s of x.obj.objectSlots.slice(1)) {
        const c = s.containedId !== 0 ? this.getObject(s.containedId) : null;
        if (c && !c.killed) this.killObject(c);
      }
    }
    for (const x of group) {
      for (const d of this.dialogs) if (d.obj === x) d.abort();
      this.liftBuyBuildLocks(x.id);
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
      // ~cXObject: cSoundPlayer::QuietBySourceID(id) (a looping voice track
      // with this source, e.g. the mail carrier's mailbox_deliver_vox, stops).
      this.soundHooks?.killSounds(x.id);
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
    const ids = neighborIndex(this.nbhd?.neighbors ?? []).ids;
    let lo = 0;
    let hi = ids.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ids[mid]! > id) hi = mid;
      else lo = mid + 1;
    }
    return ids[lo] ?? 0;
  }

  /** Neighborhood::FindNeighborByID. */
  findNeighborByID(id: number): Neighbor | null {
    return neighborIndex(this.nbhd?.neighbors ?? []).byId.get(id) ?? null;
  }

  /** Neighborhood::FindNeighborByGUID. */
  findNeighborByGUID(guid: number): Neighbor | null {
    return this.nbhd?.neighbors.find((n) => (n.guid | 0) === (guid | 0)) ?? null;
  }

  /**
   * Neighborhood::RemoveFromFamily(neighbor): fails (false) when the
   * neighbor's family number (Neighbor +0xee, person data 0x3d) is 0, names
   * no family or the family does not list them. Otherwise the person's
   * instance (ObjectModule::GetPersonByGUID, cXPerson +0x606) and the
   * neighbor lose the family number, Family::RemoveMember drops the GUID,
   * UpdateInstanceVisitorTypes runs and the family is marked changed
   * (+0x124 = 1, +0x138 bit 3 cleared; NeighborhoodStore saves the member
   * list); GlobalDispatch(0xe8) refreshes the control panel.
   */
  removeFromFamily(nb: Neighbor): boolean {
    const number = nb.personData?.[0x3d] ?? 0;
    if (number === 0) return false;
    const fam = this.nbhd?.families.find((f) => f.chunkId === number);
    const i = fam ? fam.memberGuids.findIndex((g) => (g | 0) === (nb.guid | 0)) : -1;
    if (!fam || i < 0) return false;
    const inst = this.persons.find((p) => (p.obj.selector.guid | 0) === (nb.guid | 0));
    if (inst) inst.pd[0x3d] = 0;
    nb.personData![0x3d] = 0;
    fam.memberGuids.splice(i, 1);
    this.familyFriendCounts.delete(fam);
    this.memberIndex = null;
    this.sim.state?.removeFamilyMember(nb.guid);
    this.updateInstanceVisitorTypes();
    fam.flags &= ~8;
    return true;
  }

  /**
   * Neighborhood::AddToFamily(neighbor, family): fails (false) when the
   * family already lists the neighbor. Otherwise Family::AddMember appends
   * the GUID, UpdateInstanceVisitorTypes runs, the person's instance
   * (cXPerson +0x606 / +0x612) and the neighbor (+0xee / +0xfa) take the
   * family number and person data 0x43 = 0, the family is marked changed
   * (+0x124 = 1, +0x138 bit 3 cleared) and GlobalDispatch(0xe8) refreshes
   * the control panel, whose family list (PersonFinder, Family::
   * GetIndexedMember) gets the new last member.
   */
  addToFamily(nb: Neighbor, fam: Family): boolean {
    if (fam.memberGuids.some((g) => (g | 0) === (nb.guid | 0))) return false;
    fam.memberGuids.push(nb.guid >>> 0);
    this.familyFriendCounts.delete(fam);
    this.memberIndex = null;
    this.updateInstanceVisitorTypes();
    const inst = this.persons.find((p) => (p.obj.selector.guid | 0) === (nb.guid | 0));
    if (inst) {
      inst.pd[0x3d] = fam.chunkId;
      inst.pd[0x43] = 0;
    }
    if (nb.personData) {
      nb.personData[0x3d] = fam.chunkId;
      nb.personData[0x43] = 0;
    }
    fam.flags &= ~8;
    const state = this.sim.state;
    const data = this.nbhd;
    if (state && data) {
      void import("../data/family.js")
        .then(({ personFromNeighbor }) => personFromNeighbor(data, nb, fam.name))
        .then((info) => {
          state.addFamilyMember(info);
          // (UpdateInstanceVisitorTypes reads the family list, which is complete only now)
          this.updateInstanceVisitorTypes();
        })
        .catch((e: unknown) => console.error("[sim] AddToFamily", e));
    }
    return true;
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
    const find = () => relationEntry(nb, other);
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
        return this.familyOfMember(nb.guid)?.houseNumber ?? 0;
      case 5: // Neighborhood::GetFriendCount(neighbor)
        return this.neighborFriendCount(nb);
      case 9: { // Family::GetFriendCount -> Neighborhood::GetFamilyFriendsCount of the neighbor's family
        const fn = nb.personData?.[0x3d] ?? 0;
        const fam = fn === 0 ? undefined : this.nbhd?.families.find((f) => f.chunkId === fn);
        return fam ? this.familyFriendsCount(fam) : 0;
      }
      default:
        return this.unportedValue(`scope 24 neighbor data ${data}`, 0);
    }
  }

  /** The daily relationship (RelMatrix value 0) of `from` toward neighbor id `to`, null without an entry. */
  private static dailyRel(from: Neighbor, to: number): number | null {
    const r = relationEntry(from, to);
    return r && r.values.length > 0 ? r.values[0]! : null;
  }

  /** Both ways at least lbl_105BA1F4 (friendshipThreshold). */
  private static areFriends(a: Neighbor, b: Neighbor): boolean {
    const ab = SimModule.dailyRel(a, b.id);
    const ba = SimModule.dailyRel(b, a.id);
    return ab !== null && ba !== null && ab >= friendshipThreshold && ba >= friendshipThreshold;
  }

  /**
   * Neighborhood::GetFriendCount(Neighbor *): the other characters belonging
   * to a family (Neighbor +0xee, person data 0x3d) sharing a daily
   * relationship of at least 25 both ways. The original caches it at
   * Neighbor +0x20 and recomputes when +0x24 is set (RelationshipsChanged;
   * a neighbor without an entry here counts as set).
   */
  private neighborFriendCount(nb: Neighbor): number {
    const kept = this.neighborFriendCounts.get(nb);
    if (kept !== undefined) return kept;
    let n = 0;
    for (const o of this.nbhd?.neighbors ?? []) {
      if (o === nb || !o.personData || o.personData[0x3d] === 0) continue;
      if (SimModule.areFriends(nb, o)) n++;
    }
    this.neighborFriendCounts.set(nb, n);
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

  /**
   * CPState::GetFamilyFriendCount (the view control's friend count): on a
   * residential lot the app's current family (global 9), elsewhere the
   * selected person's family (its person data 0x3d); Family::GetFriendCount
   * of it, 0 without one.
   */
  cpFamilyFriendCount(selectedGuid: number | undefined): number {
    const g = this.sim.globals;
    let fn = 0;
    if (this.getZoningType(g[10]!) === 1) fn = g[9]!;
    else if (selectedGuid !== undefined) fn = this.persons.find((p) => (p.obj.selector.guid | 0) === (selectedGuid | 0))?.pd[0x3d] ?? 0;
    const fam = fn === 0 ? undefined : this.nbhd?.families.find((f) => f.chunkId === fn);
    return fam ? this.familyFriendsCount(fam) : 0;
  }

  /**
   * Family +0x120 / +0x124: the friend count Neighborhood::GetFamilyFriendsCount
   * returns and its dirty flag. Families without an entry are dirty (a new
   * lot recounts once); AddToFamily, RemoveFromFamily and
   * RelationshipsChanged (ObjectModule::SetRelationshipDirty) drop the entry.
   */
  private readonly familyFriendCounts = new Map<Family, number>();
  /**
   * The first family listing each member GUID (what families.find(f =>
   * f.memberGuids has guid) answers), rebuilt when the families or their
   * member counts change (BHAVs ask it for every neighbor in loops).
   */
  private memberIndex: { stamp: number; byGuid: Map<number, Family> } | null = null;

  private familyOfMember(guid: number): Family | undefined {
    const families = this.nbhd?.families;
    if (!families) return undefined;
    // (AddToFamily / RemoveFromFamily also drop it; this catches changes made elsewhere.)
    let stamp = families.length;
    for (let i = 0; i < families.length; i++) stamp = (stamp * 31 + families[i]!.memberGuids.length) | 0;
    if (this.memberIndex?.stamp !== stamp) {
      const byGuid = new Map<number, Family>();
      for (const f of families) for (const g of f.memberGuids) if (!byGuid.has(g | 0)) byGuid.set(g | 0, f);
      this.memberIndex = { stamp, byGuid };
    }
    return this.memberIndex.byGuid.get(guid | 0);
  }

  /** Neighbor +0x20 / +0x24: Neighborhood::GetFriendCount's kept count (dirty when absent). */
  private readonly neighborFriendCounts = new Map<Neighbor, number>();

  /**
   * Neighborhood::GetFamilyFriendsCount(family) (Family::GetFriendCount):
   * Neighborhood::UpdateFamilyFriendsCount when the family is marked
   * changed, else the count kept from the last update.
   */
  private familyFriendsCount(fam: Family): number {
    let n = this.familyFriendCounts.get(fam);
    if (n === undefined) {
      n = this.familyFriendCount(fam.memberGuids);
      this.familyFriendCounts.set(fam, n);
    }
    return n;
  }

  /**
   * Neighborhood::RelationshipsChanged(neighbor): marks the neighbor's
   * friend count changed (+0x24), and the friend count of the family its
   * family number (+0xee, person data 0x3d) names (+0x124).
   */
  relationshipsChanged(nb: Neighbor | undefined): void {
    if (!nb) return;
    this.neighborFriendCounts.delete(nb);
    const fn = nb.personData?.[0x3d] ?? 0;
    const fam = this.nbhd?.families.find((f) => f.chunkId === fn);
    if (fam) this.familyFriendCounts.delete(fam);
  }

  /**
   * ObjectModule::SetRelationshipDirty(a, b): RelationshipsChanged for both
   * neighbors (by neighbor id; the original also sets ObjectModule +0x12).
   */
  setRelationshipDirty(a: number, b: number): void {
    this.relationshipsChanged(this.findNeighborByID(a) ?? undefined);
    this.relationshipsChanged(this.findNeighborByID(b) ?? undefined);
  }

  /** Neighborhood::UpdateFamilyFriendsCount for one family (see NghInterface.getFamilyFriendsCount). */
  private familyFriendCount(memberGuids: number[]): number {
    const all = this.nbhd?.neighbors ?? [];
    const guids = new Set(memberGuids.map((g) => g | 0));
    const members = all.filter((n) => guids.has(n.guid | 0));
    let count = 0;
    for (const n of all) {
      if (guids.has(n.guid | 0) || !n.personData || n.personData[0x3d] === 0) continue;
      if (members.some((m) => SimModule.areFriends(n, m)) && (n.personData[65] ?? 0) < 2) count++;
    }
    return count;
  }

}
