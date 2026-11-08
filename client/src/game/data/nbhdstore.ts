/**
 * The game's Neighborhood object on the save side: the parts of
 * Neighborhood / Neighbor / Family / NghInterface.cpp that create characters
 * and families, and Neighborhood::Save.
 *
 * <dir>/Neighborhood.iff is kept as raw chunks. NBRS (the Neighbor pointer
 * vector) is parsed losslessly, so re-serializing it reproduces the file's
 * bytes; FAMI chunks are parsed and only the families changed here are
 * written back. Neighborhood::Save rewrites every chunk (NGBH, NBRS, all
 * families, ObjectFolder's data: TATT, written from the folder when it is
 * open) in the current version; we keep the chunks
 * we do not touch verbatim and write NBRS in the version the file already has
 * (Neighbor::DoStream picks the neighbor stream version from it), FAMI in
 * version 9 (Family::SaveFamily always saves 9) with its FAMs name.
 *
 * Neighbor slots: the NBRS vector holds null entries; a neighbor's id is its
 * slot + 1 (FindNeighborByID, AddNewNeighbor).
 */

import { assetFetch, fetchManifest } from "../../engine/assets.js";
import { UI_LANGUAGE } from "../res/uires.js";
import { createCharacterFile, createCharacterFileFrom, deleteCharacterFile, GUID_TEMPLATE_PERSON, readCharacterFirstName } from "./character.js";
import { serializeFamilyHistory } from "./familyhistory.js";
import { deleteGameFile, writeGameFile } from "./files.js";
import { buildIff, decodeStrSet, parseIff, stringSetBaseResave, stringSetMultiSave, stringSetMultiSaveLocal, type IffChunk } from "./iff.js";
import { PD, removeNeighbor as removeNeighborData, type Neighbor, type NeighborhoodData } from "./neighborhood.js";
import { ReconReader, ReconWriter } from "./recon.js";
import { friendshipThreshold } from "../sim/floatconstants.js";

/** RelMatrix: a counted list (count >= 0) or a pointer vector (count < 0). */
interface RelMatrixRaw {
  count: number;
  /** Pointer-vector length (count < 0). */
  vecCount: number;
  entries: Array<{ present: number; other: number; values: number[] } | null>;
}

interface NeighborRaw {
  /** Pointer-vector marker (non-zero). */
  present: number;
  /** Stream version words as stored (Neighbor::DoStream writes 0, 1 or 2 of them). */
  streamWords: number[];
  name: string;
  namePad: number;
  /** +0x1c */
  unk: number;
  /** +0x18: persistent data version, 0 = no person data. */
  pdVersion: number;
  /** Always 256 entries in memory; the stream holds 0x40, 0x50 or 0x100 of them. */
  personData: Int16Array;
  /** The extra short of stream versions < 3. */
  pdTail: number;
  id: number;
  guid: number;
  rels: RelMatrixRaw;
}

interface NbrsRaw {
  head: number;
  version: number;
  entries: Array<NeighborRaw | null>;
}

interface FamilyRaw {
  id: number;
  name: string;
  /** +0x110 */
  houseNumber: number;
  /** +0x114 */
  familyNumber: number;
  /** +0x118 */
  budget: number;
  /** +0x11c */
  netWorth: number;
  /** +0x120 */
  unk120: number;
  /** +0x138 */
  flags: number;
  memberGuids: number[];
  /** +0x13c (version > 7) */
  unk13c: number;
  /** +0x14e, 6 shorts (version > 8). */
  spells: number[];
  /** Original chunk bytes (written back verbatim unless dirty). */
  dirty: boolean;
}

/**
 * The Neighborhood the simulation holds in memory while a lot is loaded (the
 * module's NeighborhoodData): the relationships (Neighbor +0xc RelMatrix) and
 * SimInventories (Neighborhood +400) the behaviors change live there, and
 * Neighborhood::SavePersistentData calls made by the simulation (generic sim
 * call 25, ...) are queued in `persistent` by GUID. Neighborhood::Save writes
 * them out (see `NeighborhoodStore.save`).
 */
export interface LiveNeighborhood {
  data: NeighborhoodData;
  persistent: Map<number, Int16Array>;
  /**
   * The loaded house (Neighborhood +0x164) and its live net worth: cSimulator
   * +0x9c (lot) + +0xa0 (objects) + (int)(+0xa4 (architecture) * the
   * architecture value multiplier). Neighborhood::Save gives it to the
   * families of that house.
   */
  loadedHouse?: () => { house: number; netWorth: number };
}

let liveNeighborhood: LiveNeighborhood | null = null;

/** The lot's Neighborhood in memory (null when no lot is loaded). */
export function setLiveNeighborhood(live: LiveNeighborhood | null): void {
  liveNeighborhood = live;
}

export function getLiveNeighborhood(): LiveNeighborhood | null {
  return liveNeighborhood;
}

/** SimInventory vector as NGBH stores it (DoPtrVectorStream: count, then present, id, tokens of type, GUID, count). */
function serializeInventories(data: NeighborhoodData): Uint8Array {
  const w = new ReconWriter();
  const invs = data.inventories;
  w.i32(invs.length);
  for (const inv of invs) {
    w.i32(1);
    w.i16(inv.neighborId);
    w.i32(inv.tokens.length);
    for (const t of inv.tokens) {
      w.i32(t.type);
      w.i32(t.guid | 0);
      w.i16(t.count);
    }
  }
  return w.finish();
}

/** NghInterface: families that are not "real" (downtown, vacation, studio town, magic town...). */
const SPECIAL_FAMILY_IDS = new Set([0, 2000, 4000, 5000, 5500, 6000]);

/** NeighborhoodConstants "money for new family" (lbl_105BA1DC, default 20000). */
export const MONEY_FOR_NEW_FAMILY = 20000;

/** Neighbor::GetLatestPersDataVersion */
const LATEST_PERS_DATA_VERSION = 9;

/** Neighbor::GetPersistentDataFields(9): person data indices saved into the neighbor. */
export const PERSISTENT_DATA_FIELDS = [
  2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 16, 20, 15, 26, 17, 18, 46, 47, 48, 49, 50, 51, 52, 53, 13, 14, 58, 60, 61, 56, 57,
  63, 65, 67, 68, 69, 74, 54, 55, 75, 76, 80, 81, 82,
];

/** Person data index cleared by Neighborhood::AddToFamily (Neighbor +0xfa). */
const PD_67 = 67;

/** The game's current language (StringSetMulti saves the family name in it). */
const CURRENT_LANG: number = UI_LANGUAGE;

/** A neighbor's character file name (its short name, capitalized: "user00000" -> "User00000.iff"). */
function characterFileName(name: string): string {
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}.iff`;
}

function streamLocal(words: number[]): number {
  return words.length ? words[words.length - 1]! : 0;
}

/** Neighbor::DoStream's stream version words for a file version. */
function streamWordsFor(version: number): number[] {
  if (version > 0x48) return [10, 9];
  if (version < 0x48) return version >= 0x1f ? [4] : [];
  return [9];
}

function readRelMatrix(r: ReconReader, version: number): RelMatrixRaw {
  const readArray = (present: number): { present: number; other: number; values: number[] } => {
    const other = version > 0 ? r.i32() : -1;
    const n = r.i32();
    const values: number[] = [];
    for (let k = 0; k < n; k++) values.push(r.i32());
    return { present, other, values };
  };
  const count = r.i32();
  const m: RelMatrixRaw = { count, vecCount: 0, entries: [] };
  if (count < 0) {
    m.vecCount = r.i32();
    for (let k = 0; k < m.vecCount; k++) {
      const present = r.i32();
      m.entries.push(present !== 0 ? readArray(present) : null);
    }
  } else {
    for (let k = 0; k < count; k++) m.entries.push(readArray(1));
  }
  return m;
}

function writeRelMatrix(w: ReconWriter, m: RelMatrixRaw, version: number): void {
  w.i32(m.count);
  const writeArray = (a: { other: number; values: number[] }): void => {
    if (version > 0) w.i32(a.other);
    w.i32(a.values.length);
    for (const v of a.values) w.i32(v);
  };
  if (m.count < 0) {
    w.i32(m.vecCount);
    for (const e of m.entries) {
      w.i32(e ? e.present : 0);
      if (e) writeArray(e);
    }
  } else {
    for (const e of m.entries) if (e) writeArray(e);
  }
}

export function parseNbrsRaw(bytes: Uint8Array): NbrsRaw {
  const r = new ReconReader(bytes);
  const head = r.i32();
  const version = r.i32();
  if (r.tag() !== "SRBN") throw new Error("NBRS: bad magic");
  const count = r.i32();
  const entries: Array<NeighborRaw | null> = [];
  for (let i = 0; i < count; i++) {
    const present = r.i32();
    if (present === 0) {
      entries.push(null);
      continue;
    }
    const streamWords: number[] = [];
    if (version > 0x48) streamWords.push(r.i32());
    if (version >= 0x1f) streamWords.push(r.i32());
    const local = streamLocal(streamWords);
    let name = "";
    let namePad = 0;
    let unk = 0;
    if (local > 1) {
      const start = r.pos;
      name = r.cstr();
      // ReconString pads to an even length; keep the pad byte (garbage in the game's files).
      const nul = r.bytes.indexOf(0, start);
      if ((nul - start + 1) & 1) namePad = r.bytes[nul + 1]!;
      unk = r.i32();
    }
    const personData = new Int16Array(256);
    let pdVersion = 0;
    let pdTail = 0;
    if (local > 0) {
      pdVersion = r.i32();
      if (pdVersion !== 0) {
        const n = local >= 8 ? 0x100 : local >= 3 ? 0x50 : 0x40;
        personData.set(r.i16s(n));
        if (local < 3) pdTail = r.i16();
      }
    }
    const id = r.i16();
    const guid = r.u32();
    entries.push({ present, streamWords, name, namePad, unk, pdVersion, personData, pdTail, id, guid, rels: readRelMatrix(r, version) });
  }
  if (r.remaining !== 0) throw new Error(`NBRS: ${r.remaining} trailing bytes`);
  return { head, version, entries };
}

export function serializeNbrs(n: NbrsRaw): Uint8Array {
  const w = new ReconWriter();
  w.i32(n.head);
  w.i32(n.version);
  w.tag("SRBN");
  w.i32(n.entries.length);
  for (const e of n.entries) {
    if (!e) {
      w.i32(0);
      continue;
    }
    w.i32(e.present);
    for (const s of e.streamWords) w.i32(s);
    const local = streamLocal(e.streamWords);
    if (local > 1) {
      w.cstr(e.name, e.namePad);
      w.i32(e.unk);
    }
    if (local > 0) {
      w.i32(e.pdVersion);
      if (e.pdVersion !== 0) {
        const n = local >= 8 ? 0x100 : local >= 3 ? 0x50 : 0x40;
        w.i16s(e.personData.subarray(0, n));
        if (local < 3) w.i16(e.pdTail);
      }
    }
    w.i16(e.id);
    w.i32(e.guid | 0);
    writeRelMatrix(w, e.rels, n.version);
  }
  return w.finish();
}

/** Family::DoStream, read side (every field kept). */
function parseFamily(bytes: Uint8Array, id: number, name: string): FamilyRaw {
  const r = new ReconReader(bytes);
  r.i32();
  const v = r.i32();
  if (r.tag() !== "IMAF") throw new Error("FAMI: bad magic");
  const f: FamilyRaw = {
    id,
    name,
    houseNumber: r.i32(),
    familyNumber: 0,
    budget: 0,
    netWorth: 0,
    unk120: 0,
    flags: 0,
    memberGuids: [],
    unk13c: 0,
    spells: [0, 0, 0, 0, 0, 0],
    dirty: false,
  };
  if (v < 5) f.name = r.cstr() || f.name;
  if (v > 0) f.familyNumber = r.i32();
  if (v > 1) {
    f.budget = r.i32();
    f.netWorth = r.i32();
    f.unk120 = r.i32();
  }
  if (v < 7) {
    f.flags = v < 3 ? 1 : r.bool() ? 1 : 0;
    if (v > 3 && r.bool()) f.flags |= 2;
    if (v > 5) {
      f.flags &= ~2;
      if (r.bool()) f.flags |= 2;
    }
  } else {
    f.flags = r.i32();
  }
  if (id !== 0) {
    const n = r.i32();
    for (let i = 0; i < n; i++) f.memberGuids.push(r.u32());
  }
  if (v > 7) f.unk13c = r.i32();
  if (v > 8) f.spells = Array.from(r.i16s(6));
  return f;
}

/** Family::DoStream, write side, in the version Family::SaveFamily uses (9). */
function serializeFamily(f: FamilyRaw): Uint8Array {
  const w = new ReconWriter();
  w.i32(0);
  w.i32(9);
  w.tag("IMAF");
  w.i32(f.houseNumber);
  w.i32(f.familyNumber);
  w.i32(f.budget);
  w.i32(f.netWorth);
  w.i32(f.unk120);
  w.i32(f.flags);
  if (f.id !== 0) {
    w.i32(f.memberGuids.length);
    for (const g of f.memberGuids) w.i32(g | 0);
  }
  w.i32(f.unk13c);
  w.i16s(f.spells);
  return w.finish();
}

export interface FamilyView {
  id: number;
  name: string;
  houseNumber: number;
  familyNumber: number;
  budget: number;
  netWorth: number;
  flags: number;
  memberGuids: number[];
  /** FAMI +0x120: the cached friend count (Neighborhood::GetFamilyFriendsCount). */
  friends: number;
}

export class NeighborhoodStore {
  /** Neighborhood +0x160: the next User%05d number tried by AddNewCharacter. */
  private nextUserFile = 0;

  private constructor(
    readonly dir: string,
    private chunks: IffChunk[],
    private readonly nbrs: NbrsRaw,
    private readonly families: FamilyRaw[],
  ) {}

  static async open(dir: string): Promise<NeighborhoodStore> {
    const res = await assetFetch(`Sims/${dir}/Neighborhood.iff`, { cache: "no-store" });
    if (!res.ok) throw new Error(`${dir}/Neighborhood.iff: ${res.status}`);
    const chunks = parseIff(new Uint8Array(await res.arrayBuffer()));
    const nbrsChunk = chunks.find((c) => c.type === "NBRS");
    if (!nbrsChunk) throw new Error(`${dir}/Neighborhood.iff: no NBRS`);
    const nbrs = parseNbrsRaw(nbrsChunk.data);
    const names = new Map<number, string>();
    for (const c of chunks.filter((c) => c.type === "FAMs")) {
      const entries = decodeStrSet(c.data);
      const pick = entries.find((e) => e.lang === CURRENT_LANG) ?? entries.find((e) => e.lang === 1) ?? entries[0];
      names.set(c.id, pick?.value ?? "");
    }
    const families = chunks.filter((c) => c.type === "FAMI").map((c) => parseFamily(c.data, c.id, names.get(c.id) ?? ""));
    return new NeighborhoodStore(dir, chunks, nbrs, families);
  }

  /** NBRS file version (0x49 for a Complete Collection save, 0x3f for the templates). */
  get version(): number {
    return this.nbrs.version;
  }

  private neighborByGuid(guid: number): NeighborRaw | undefined {
    return this.nbrs.entries.find((e): e is NeighborRaw => !!e && e.guid >>> 0 === guid >>> 0);
  }

  private familyRaw(id: number): FamilyRaw | undefined {
    return this.families.find((f) => f.id === id);
  }

  /**
   * Neighborhood::AddNewCharacter(kAdult) as called by MakeNewPerson: the
   * template's character file is copied to the first free User%05d.iff, then
   * AddNewNeighbor puts a neighbor for it in the last free slot (or a new one).
   */
  async addNewCharacter(): Promise<{ guid: number; neighborId: number; shortName: string; fileName: string }> {
    if (!this.neighborByGuid(GUID_TEMPLATE_PERSON)) throw new Error("no template person neighbor");
    const prefix = `sims/${this.dir}/characters/`.toLowerCase();
    const taken = new Set(
      (await fetchManifest()).files.map((f) => f.path.toLowerCase()).filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length)),
    );
    let base = "";
    while (this.nextUserFile < 32000) {
      const candidate = `User${String(this.nextUserFile).padStart(5, "0")}`;
      this.nextUserFile++;
      if (!taken.has(`${candidate}.iff`.toLowerCase())) {
        base = candidate;
        break;
      }
    }
    if (this.nextUserFile > 31999) this.nextUserFile = 0;
    if (!base) throw new Error("no free character file name");
    const fileName = `${base}.iff`;
    const { guid } = await createCharacterFile(this.dir, fileName, base);
    const neighborId = this.addNewNeighbor(guid, base.toLowerCase());
    return { guid, neighborId, shortName: base.toLowerCase(), fileName };
  }

  /**
   * Neighborhood::AddNewNeighbor(selector, id) + Neighbor(short, ObjSelector*):
   * the slot of `id` when it is free (the vector grows to it), else the last
   * free slot, else a new one at the end.
   */
  private addNewNeighbor(guid: number, shortName: string, id = -1): number {
    const entries = this.nbrs.entries;
    let slot = -1;
    if (id > 0) {
      while (entries.length < id) entries.push(null);
      if (!entries[id - 1]) slot = id - 1;
    }
    // The game keeps the last free slot it sees.
    if (slot < 0)
      entries.forEach((e, i) => {
        if (!e) slot = i;
      });
    if (slot < 0) {
      entries.push(null);
      slot = entries.length - 1;
    }
    entries[slot] = {
      present: 1,
      streamWords: streamWordsFor(this.nbrs.version),
      name: shortName,
      namePad: 0,
      unk: 0,
      pdVersion: 0,
      personData: new Int16Array(256),
      pdTail: 0,
      id: slot + 1,
      guid,
      rels: { count: -1, vecCount: 0, entries: [] },
    };
    return slot + 1;
  }

  /** Neighborhood::DeleteCharacter: refused (false) while the person belongs to a family. */
  async deleteCharacter(guid: number): Promise<boolean> {
    const n = this.neighborByGuid(guid);
    if (!n) return false;
    if (this.families.some((f) => f.memberGuids.includes(guid >>> 0))) return false;
    // RemoveNeighbor: its inventory loses every token of types 0..9
    // (GetInventoryByNeighbourID, RemoveAllTokensOfType), then the slot is
    // freed and the relationships to it dropped (RelMatrix::RemoveArray).
    this.clearInventoryTokens(n.id);
    // The lot's Neighborhood is the same one in the original: takeLive must not bring it back.
    if (liveNeighborhood?.data.dir === this.dir) removeNeighborData(liveNeighborhood.data, guid);
    this.nbrs.entries[n.id - 1] = null;
    for (const e of this.nbrs.entries) {
      if (!e) continue;
      e.rels.entries = e.rels.entries.filter((a) => !a || a.other !== n.id);
      if (e.rels.count >= 0) e.rels.count = e.rels.entries.length;
      else e.rels.vecCount = e.rels.entries.length;
    }
    await deleteCharacterFile(this.dir, characterFileName(n.name));
    return true;
  }

  /**
   * The characters Neighborhood::MoveOut(bulldoze) deletes: neighbors whose
   * Neighbor +0xfa (person data 0x43) is `house`, in neighbor order.
   */
  charactersOfHouse(house: number): number[] {
    return this.nbrs.entries.filter((e): e is NeighborRaw => e !== null && e.personData[PD_67] === house).map((e) => e.guid >>> 0);
  }

  /**
   * std::sort of the family vector with SortFamilyByCreation (lbl_105BB988,
   * Mac 100adc50), run after DoFirstTimeTownies / DoFirstTimeTouristFamilies:
   * a before b when a's family number (+0x114) is greater, or equal and a's
   * id (+0x10c) is greater (signed compares). Neighborhood::Save then writes
   * the families in this order (Family::SaveFamily per vector entry).
   */
  sortFamiliesByCreation(): void {
    this.families.sort((a, b) => (b.familyNumber | 0) - (a.familyNumber | 0) || (b.id | 0) - (a.id | 0));
  }

  /** Neighborhood::MakeNewFamily */
  makeNewFamily(): number {
    let id = 1;
    while (this.families.some((f) => f.id === id)) id++;
    let familyNumber = 1;
    for (const f of this.families) if (familyNumber <= f.familyNumber) familyNumber = f.familyNumber + 1;
    this.families.push({
      id,
      name: "",
      houseNumber: 0,
      familyNumber,
      budget: MONEY_FOR_NEW_FAMILY,
      netWorth: 0,
      unk120: 0,
      flags: 0,
      memberGuids: [],
      unk13c: 0,
      spells: [0, 0, 0, 0, 0, 0],
      dirty: true,
    });
    return id;
  }

  /** SetFamilyName (NghInterface) */
  setFamilyName(familyId: number, name: string): void {
    const f = this.familyRaw(familyId);
    if (!f) return;
    f.name = name;
    f.dirty = true;
  }

  /** Neighborhood::AddToFamily */
  addToFamily(guid: number, familyId: number): void {
    const f = this.familyRaw(familyId);
    const n = this.neighborByGuid(guid);
    if (!f || !n || f.memberGuids.includes(guid >>> 0)) return;
    f.memberGuids.push(guid >>> 0);
    n.personData[PD.familyNumber] = familyId;
    n.personData[PD_67] = 0;
    f.flags &= ~8;
    f.dirty = true;
  }

  /** RemoveFamily(int) (NghInterface): members leave and their characters are deleted, then the family goes. */
  async removeFamily(familyId: number): Promise<void> {
    const f = this.familyRaw(familyId);
    if (!f) return;
    // RemoveFamily(int): DeleteFamilyExport first, the family's exported file in
    // <UserData>/Export (Family::GetExportName, the .FAM / .MTF ExportFamily writes).
    for (const ext of [".FAM", ".MTF"]) await deleteGameFile(`${this.dir}/Export/${f.name}_${f.id}${ext}`).catch(() => undefined);
    while (f.memberGuids.length) {
      const guid = f.memberGuids[0]!;
      // Neighborhood::RemoveFromFamily
      f.memberGuids.shift();
      const n = this.neighborByGuid(guid);
      if (n) n.personData[PD.familyNumber] = 0;
      await this.deleteCharacter(guid);
    }
    // Neighborhood::RemoveFamily only removes housed-nowhere families other than 0.
    if (f.id !== 0 && f.houseNumber === 0) {
      this.families.splice(this.families.indexOf(f), 1);
      this.chunks = this.chunks.filter((c) => !((c.type === "FAMI" || c.type === "FAMs" || c.type === "FAMh") && c.id === f.id));
    }
    await this.save();
  }

  /** Neighborhood::SavePersistentData */
  savePersistentData(guid: number, personData: Int16Array): void {
    // A later call wins over one the simulation queued.
    if (liveNeighborhood?.data.dir === this.dir) liveNeighborhood.persistent.delete(guid >>> 0);
    const n = this.neighborByGuid(guid);
    if (!n) return;
    n.pdVersion = LATEST_PERS_DATA_VERSION;
    for (const i of PERSISTENT_DATA_FIELDS) n.personData[i] = personData[i] ?? 0;
  }

  /**
   * Neighborhood::SaveAllPersistentDataForMatterTransferance: for each
   * neighbor in order (the walk stops at the first empty slot), the person
   * on the lot with its GUID (`instance`: its person data, null when not
   * there) saves its persistent fields into the neighbor its person data 0x1f
   * (cXPerson +0x5ca, the neighbor id) names.
   */
  saveAllPersistentDataForMatterTransferance(instance: (guid: number) => Int16Array | null): void {
    for (const n of this.nbrs.entries) {
      if (!n) break;
      const pd = instance(n.guid >>> 0);
      if (!pd) continue;
      const target = this.nbrs.entries[(pd[0x1f] ?? 0) - 1];
      if (target) this.savePersistentData(target.guid, pd);
    }
  }

  /** Family +0x138 &= ~`mask` for the family `guid` belongs to (get_family_from_selector_guid). */
  clearMemberFamilyFlags(guid: number, mask: number): void {
    const f = this.families.find((x) => x.memberGuids.includes(guid >>> 0));
    if (!f || !(f.flags & mask)) return;
    f.flags &= ~mask;
    f.dirty = true;
  }

  /** Family +0x118 (budget) and +0x138 (flags) set as given (Neighborhood::SaveHouse). */
  setFamilyBudgetAndFlags(familyId: number, budget: number, flags: number): void {
    const f = this.familyRaw(familyId);
    if (!f) return;
    f.budget = budget | 0;
    f.flags = flags;
    f.dirty = true;
  }

  /** PersonFinder::GetData without an instance: the neighbor's person data (live). */
  getPersonData(guid: number): Int16Array {
    return this.neighborByGuid(guid)?.personData ?? new Int16Array(256);
  }

  /** The neighbor of `guid` as a simulator's NeighborhoodData holds it (a copy, without relationships), or null. */
  neighborData(guid: number): Neighbor | null {
    const n = this.neighborByGuid(guid);
    return n ? { id: n.id, guid: n.guid >>> 0, name: n.name, personData: n.personData.slice(), relationships: [], version: n.pdVersion } : null;
  }

  /** GetUnhousedFamilies (NghInterface) */
  unhousedFamilies(): number[] {
    return this.families
      .filter((f) => f.houseNumber === 0 && !SPECIAL_FAMILY_IDS.has(f.id) && (f.id < 3000 || f.id > 3009))
      .map((f) => f.id);
  }

  family(familyId: number): FamilyView | undefined {
    const f = this.familyRaw(familyId);
    if (!f) return undefined;
    const { id, name, houseNumber, familyNumber, budget, netWorth, flags, memberGuids } = f;
    return { id, name, houseNumber, familyNumber, budget, netWorth, flags, memberGuids: [...memberGuids], friends: f.unk120 };
  }

  /**
   * Moving a family into a lot, data part of Neighborhood::LoadHouse(house,
   * family): the family takes the house number, flags = (flags & ~0xc) | 4,
   * then pays for the lot: budget += netWorth - value, netWorth = value, with
   * value = 0.7 * architecture + lot + objects of the house's SIMI (the
   * neighborhood screen's lot value, nbhd/nghinterface.ts getHouseInfo).
   */
  setFamilyHouse(familyId: number, house: number, houseValue: number): void {
    const f = this.familyRaw(familyId);
    if (!f) return;
    f.houseNumber = house;
    f.flags = (f.flags & ~0xc) | 4;
    f.budget = f.budget + f.netWorth - houseValue;
    f.netWorth = houseValue;
    f.dirty = true;
  }

  /**
   * Neighborhood::LoadHouse(house, family) after the house file is read:
   * Family +0x138 bit 2 (set by setFamilyHouse) makes this load a move in;
   * it is cleared. Returns whether it was set.
   */
  takeMoveInFlag(familyId: number): boolean {
    const f = this.familyRaw(familyId);
    if (!f || (f.flags & 4) === 0) return false;
    f.flags &= ~4;
    f.dirty = true;
    return true;
  }

  /** The family living in house `house` (Neighborhood::GetFamily of the house's family number), if any. */
  familyOfHouse(house: number): number | undefined {
    return this.families.find((f) => f.houseNumber === house && house !== 0 && !SPECIAL_FAMILY_IDS.has(f.id))?.id;
  }

  /**
   * Saving the lot of a resident family (House::SaveFile, Neighborhood::SaveHouse):
   * Family +0x138 bits 0 / 1 from ObjectModule::ComputeStats, bit 3 cleared,
   * and the budget (+0x118) set to the simulator's funds.
   */
  setFamilyLotSave(familyId: number, budget: number, statFlags: number): void {
    const f = this.familyRaw(familyId);
    if (!f) return;
    f.flags = ((f.flags & ~3) | (statFlags & 3)) & ~8;
    f.budget = budget | 0;
    f.dirty = true;
  }

  /**
   * The family part of Neighborhood::MoveOut(house, bulldoze): the family
   * living in `house` (Family +0x110, or +0x13c, the vacation lot) leaves it
   * (house 0), its +0x138 bit 3 is cleared, and it sells the lot: budget =
   * GetFamilyNetWorth (budget + lot value, the house being no longer theirs),
   * lot value 0. Returns the family id, or -1 when nobody lives there. The
   * house file side (objects killed, walls / floors / pool cleared on a
   * bulldoze, funds and global 26 zeroed, SaveHouse) is not done here. With
   * `sell` false the sale is left to it (world/moveout.ts: the family's funds
   * go through the simulator around "evict lot", then sellLot).
   */
  moveOutFamily(house: number, sell = true): number {
    const f = this.families.find((x) => x.houseNumber === house || x.unk13c === house);
    if (!f || house === 0) return -1;
    f.houseNumber = 0;
    f.flags &= ~8;
    if (sell) this.sellLot(f.id);
    f.dirty = true;
    return f.id;
  }

  /** MoveOut's end of the sale: Family +0x118 = Family::GetNetWorth (budget + lot value), +0x11c = 0. */
  sellLot(familyId: number): void {
    const f = this.familyRaw(familyId);
    if (!f) return;
    f.budget = f.budget + f.netWorth;
    f.netWorth = 0;
    f.dirty = true;
  }

  /** Family +0x118, the family's funds (0 without the family). */
  familyBudget(familyId: number): number {
    return this.familyRaw(familyId)?.budget ?? 0;
  }

  /** Family +0x118 := `budget`. */
  setFamilyBudget(familyId: number, budget: number): void {
    const f = this.familyRaw(familyId);
    if (!f) return;
    f.budget = budget | 0;
    f.dirty = true;
  }

  /**
   * Neighborhood::ExportFamily(<dir>/Export/, family): the family file
   * Family::GetExportName ("<name>_<id>") + ".FAM" (".MTF" for a Magic Town
   * house, 0x5a..0x5c). When the family has a house, the house file is the
   * base (CopyFileA) and the family chunks are added to it. Chunks:
   * - Family::SaveFamily: FAMI (version 9), FAMs (its name), FAMh (the
   *   history, copied from the neighborhood file);
   * - CTSS 1000: the family name (entry 1, language slot 0);
   * - EXPi 0 (ExpFamilyInfo, version 0x3f): family id, the members' neighbor
   *   ids (8 shorts), the game's language;
   * - per neighbor of the family (Neighbor +0xee), in neighbor order, with
   *   its neighbor id: uChr (the character's STR# 200 body strings,
   *   StringSetBase: in the current language), CTSS
   *   (CatalogResource::Save: catalog name and description in the current
   *   language), CTSS 2000 + id (its CTSS 2000, StringSetMulti::SaveLocal:
   *   all language slots) and BMP_ (its BMP_ 2004 portrait);
   * - NBRS 1 (every neighbor) and FINV 2 (the members' SimInventory records
   *   from NGBH, null where a member has none), in version 0x49.
   * Then <base>.FAM and <base>.MTF are deleted and the new file takes the
   * name. Resolves false when a file could not be read or written.
   */
  async exportFamily(familyId: number): Promise<boolean> {
    const f = this.familyRaw(familyId);
    if (!f) return false;
    const base = `${this.dir}/Export/${f.name}_${f.id}`;
    const read = async (path: string): Promise<IffChunk[] | null> => {
      const res = await assetFetch(`Sims/${path}`, { cache: "no-store" });
      return res.ok ? parseIff(new Uint8Array(await res.arrayBuffer())) : null;
    };
    const out: IffChunk[] = [];
    if (f.houseNumber !== 0) {
      const house = await read(`${this.dir}/Houses/House${String(f.houseNumber).padStart(2, "0")}.iff`);
      if (!house) return false;
      out.push(...house);
    }
    const add = (c: IffChunk): void => {
      const i = out.findIndex((x) => x.type === c.type && x.id === c.id);
      if (i >= 0) out.splice(i, 1);
      out.push(c);
    };
    const fams = this.chunks.find((c) => c.type === "FAMs" && c.id === f.id);
    add({ type: "FAMI", id: f.id, flags: 0x10, label: "", data: serializeFamily(f) });
    add({ type: "FAMs", id: f.id, flags: 0x10, label: "", data: stringSetMultiSave(fams?.data ?? null, CURRENT_LANG, [f.name]) });
    const famh = this.chunks.find((c) => c.type === "FAMh" && c.id === f.id);
    if (famh) add({ ...famh, data: famh.data.slice() });
    add({ type: "CTSS", id: 1000, flags: 0x10, label: "", data: stringSetMultiSave(null, 1, [f.name]) });
    // ExpFamilyInfo: the members' neighbor ids in family order (the first neighbor with the GUID).
    const memberIds = f.memberGuids.map((g) => this.neighborByGuid(g)?.id ?? 0);
    const expi = new ReconWriter();
    expi.i32(0);
    expi.i32(0x3f);
    expi.tag("iPXE");
    expi.i16(f.id);
    for (let i = 0; i < 8; i++) expi.i16(memberIds[i] ?? 0);
    expi.u8(CURRENT_LANG);
    add({ type: "EXPi", id: 0, flags: 0x10, label: "", data: expi.finish() });
    for (const n of this.nbrs.entries) {
      if (!n || n.personData[PD.familyNumber] !== f.id) continue;
      const chr = await read(`${this.dir}/Characters/${characterFileName(n.name)}`);
      const body = chr?.find((c) => c.type === "STR#" && c.id === 200);
      if (!chr || !body) return false;
      add({ type: "uChr", id: n.id, flags: 0x10, label: body.label, data: stringSetBaseResave(body.data, CURRENT_LANG) });
      const ctss = chr.find((c) => c.type === "CTSS" && c.id === 2000);
      const entries = ctss ? decodeStrSet(ctss.data) : [];
      const pick = (i: number): string => (entries.filter((e) => e.lang === CURRENT_LANG)[i] ?? entries.filter((e) => e.lang === 1)[i])?.value ?? "";
      add({ type: "CTSS", id: n.id, flags: 0x10, label: "", data: stringSetMultiSave(null, CURRENT_LANG, [pick(0), pick(1)]) });
      if (ctss) add({ type: "CTSS", id: n.id + 2000, flags: 0x10, label: "", data: stringSetMultiSaveLocal(ctss.data) });
      const portrait = chr.find((c) => c.type === "BMP_" && c.id === 2004);
      if (portrait) add({ type: "BMP_", id: n.id, flags: 0x10, label: "", data: portrait.data.slice() });
    }
    add({ type: "NBRS", id: 1, flags: 0x10, label: "", data: serializeNbrs(this.nbrs) });
    add({ type: "FINV", id: 2, flags: 0x10, label: "", data: this.familyInventories(memberIds) });
    const magic = f.houseNumber >= 0x5a && f.houseNumber <= 0x5c;
    for (const ext of [".FAM", ".MTF"]) await deleteGameFile(`${base}${ext}`).catch(() => undefined);
    try {
      await writeGameFile(`${base}${magic ? ".MTF" : ".FAM"}`, buildIff(out));
    } catch {
      return false;
    }
    return true;
  }

  /**
   * ReconSavePtrVector<SimInventory>(FINV, version 0x49) of
   * GetInventoryByNeighbourID for each id: the records are copied from the
   * NGBH SimInventory vector (i32 present, i16 neighbor id, i32 token count,
   * 10-byte tokens).
   */
  private familyInventories(neighborIds: number[]): Uint8Array {
    const records = new Map<number, Uint8Array>();
    const inv = this.ngbh().inventory;
    if (inv && inv.length >= 4) {
      const v = new DataView(inv.buffer, inv.byteOffset, inv.byteLength);
      const count = v.getInt32(0, true);
      let p = 4;
      for (let i = 0; i < count && p + 4 <= inv.length; i++) {
        const present = v.getInt32(p, true);
        p += 4;
        if (!present) continue;
        const id = v.getInt16(p, true);
        const end = p + 6 + v.getInt32(p + 2, true) * 10;
        if (!records.has(id)) records.set(id, inv.slice(p, end));
        p = end;
      }
    }
    const w = new ReconWriter();
    w.i32(0);
    w.i32(NGBH_CURRENT_VERSION);
    w.tag("VNIF");
    w.i32(neighborIds.length);
    for (const id of neighborIds) {
      const r = records.get(id);
      w.i32(r ? 1 : 0);
      if (r) w.bytes(r);
    }
    return w.finish();
  }

  /** Family +0x13c: the lot the family is on vacation on (0 = none). */
  familyOnVacationAt(house: number): number | undefined {
    return this.families.find((f) => f.houseNumber === house && f.unk13c !== 0)?.id;
  }

  /** Family +0x13c of family `id`: its vacation lot (0 = none). */
  familyVacationLot(id: number): number {
    return this.families.find((f) => f.id === id)?.unk13c ?? 0;
  }

  /**
   * Neighborhood::RemoveFromVacation's family side: the family living in or
   * staying at `house` (+0x110 or +0x13c) gets its vacation lot (+0x13c)
   * and its +0x138 bit 3 cleared. Returns its id, or -1 when there is none.
   */
  removeFromVacation(house: number): number {
    const f = house === 0 ? this.families.find((x) => x.id === 0) : this.families.find((x) => x.houseNumber === house || x.unk13c === house);
    if (!f) return -1;
    f.unk13c = 0;
    f.flags &= ~8;
    f.dirty = true;
    return f.id;
  }

  /** Family +0x13c := `house` (cSimsApp::LoadGame on a family trip; 0 back home). */
  setFamilyVacationLot(id: number, house: number): void {
    const f = this.familyRaw(id);
    if (!f) return;
    f.unk13c = house;
    f.dirty = true;
  }

  /** Neighbor::GetID of the neighbor whose GUID is `guid` (Neighborhood::FindNeighborByGUID), or undefined. */
  neighborIdOf(guid: number): number | undefined {
    return this.neighborByGuid(guid)?.id;
  }

  /**
   * SimInventory::FindToken(type, guid) on Neighborhood::GetInventoryByNeighbourID(id):
   * the token's count, 0 when the neighbor has no such token.
   */
  findToken(neighborId: number, type: number, guid: number): number {
    const records = parseInventoryRecords(this.ngbh().inventory ?? new Uint8Array(4));
    for (const r of records) {
      if (!r) continue;
      const v = new DataView(r.buffer, r.byteOffset, r.byteLength);
      if (v.getInt16(0, true) !== neighborId) continue;
      // GetInventoryByNeighbourID: the first record of the neighbor.
      const n = v.getInt32(2, true);
      for (let k = 0; k < n; k++) {
        const p = 6 + k * 10;
        if (v.getInt32(p, true) === type && v.getInt32(p + 4, true) >>> 0 === guid >>> 0) return v.getInt16(p + 8, true);
      }
      return 0;
    }
    return 0;
  }

  /** Family::GetMagiCoins: the members' magicoin tokens (type 7, GUID 0x99e81bec), added as shorts. */
  magiCoins(familyId: number): number {
    let sum = 0;
    for (const guid of this.familyRaw(familyId)?.memberGuids ?? []) {
      const id = this.neighborIdOf(guid);
      if (id !== undefined) sum += this.findToken(id, 7, 0x99e81bec);
    }
    return (sum << 16) >> 16;
  }

  /** RemoveAllTokensOfType(0..9) on the neighbor's first inventory record. */
  private clearInventoryTokens(neighborId: number): void {
    const records = parseInventoryRecords(this.ngbh().inventory ?? new Uint8Array(4));
    const i = records.findIndex((r) => r !== null && new DataView(r.buffer, r.byteOffset, r.byteLength).getInt16(0, true) === neighborId);
    const r = i >= 0 ? records[i] : null;
    if (!r) return;
    const v = new DataView(r.buffer, r.byteOffset, r.byteLength);
    const n = v.getInt32(2, true);
    const kept: Uint8Array[] = [];
    for (let k = 0; k < n; k++) {
      const p = 6 + k * 10;
      const type = v.getInt32(p, true);
      if (type < 0 || type > 9) kept.push(r.subarray(p, p + 10));
    }
    if (kept.length === n) return;
    const out = new Uint8Array(6 + kept.length * 10);
    out.set(r.subarray(0, 2));
    new DataView(out.buffer).setInt32(2, kept.length, true);
    kept.forEach((t, k) => out.set(t, 6 + k * 10));
    records[i] = out;
    this.ngbh().inventory = serializeInventoryRecords(records);
    this.touchNgbh();
  }

  /**
   * SimInventory::RemoveCountTokens(type, guid, count): nothing for 0, false
   * without the token or with fewer than `count`; the count drops by `count`
   * and an emptied token is erased.
   */
  removeCountTokens(neighborId: number, type: number, guid: number, count: number): boolean {
    if (count === 0) return true;
    const records = parseInventoryRecords(this.ngbh().inventory ?? new Uint8Array(4));
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (!r) continue;
      const v = new DataView(r.buffer, r.byteOffset, r.byteLength);
      if (v.getInt16(0, true) !== neighborId) continue;
      const n = v.getInt32(2, true);
      for (let k = 0; k < n; k++) {
        const p = 6 + k * 10;
        if (v.getInt32(p, true) !== type || v.getInt32(p + 4, true) >>> 0 !== guid >>> 0) continue;
        const have = v.getInt16(p + 8, true);
        if (have < count) return false;
        const left = Math.max(0, have - count);
        if (left > 0) {
          v.setInt16(p + 8, left, true);
        } else {
          const out = new Uint8Array(r.length - 10);
          out.set(r.subarray(0, p));
          out.set(r.subarray(p + 10), p);
          new DataView(out.buffer).setInt32(2, n - 1, true);
          records[i] = out;
        }
        this.ngbh().inventory = serializeInventoryRecords(records);
        this.touchNgbh();
        return true;
      }
      return false;
    }
    return false;
  }

  /**
   * Neighborhood::Save streams the families in vector order: the FAMI and
   * FAMs chunks take the family order, each type within its own slots.
   */
  private orderFamilyChunks(): void {
    const rank = new Map(this.families.map((f, i) => [f.id, i]));
    for (const type of ["FAMI", "FAMs"]) {
      const slots: number[] = [];
      this.chunks.forEach((c, i) => {
        if (c.type === type && rank.has(c.id)) slots.push(i);
      });
      const sorted = slots.map((i) => this.chunks[i]!).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
      slots.forEach((slot, k) => (this.chunks[slot] = sorted[k]!));
    }
  }

  private put(c: IffChunk): void {
    const i = this.chunks.findIndex((x) => x.type === c.type && x.id === c.id);
    if (i >= 0) this.chunks[i] = c;
    else this.chunks.push(c);
  }

  /** Neighborhood::Save (see the file comment for what is rewritten). */
  async save(): Promise<void> {
    this.takeLive();
    // Neighborhood::Save's family loop: the families of the loaded house get its
    // live net worth (Family +0x11c), and each family's friend count (+0x120,
    // UpdateFamilyFriendsCount; the original redoes it when RelationshipsChanged
    // set +0x124, the count only depends on the relationships so it is redone here).
    const live = liveNeighborhood?.data.dir === this.dir ? liveNeighborhood.loadedHouse?.() : undefined;
    for (const f of this.families) {
      if (live && f.houseNumber !== 0 && f.houseNumber === live.house && f.netWorth !== live.netWorth) {
        f.netWorth = live.netWorth;
        f.dirty = true;
      }
      const friends = this.familyFriendsCount(f);
      if (f.unk120 !== friends) {
        f.unk120 = friends;
        f.dirty = true;
      }
    }
    const nbrs = this.chunks.find((c) => c.type === "NBRS")!;
    this.put({ ...nbrs, data: serializeNbrs(this.nbrs) });
    for (const f of this.families) {
      if (!f.dirty) continue;
      const fami = this.chunks.find((c) => c.type === "FAMI" && c.id === f.id);
      this.put({ type: "FAMI", id: f.id, flags: fami?.flags ?? 0x10, label: fami?.label ?? "", data: serializeFamily(f) });
      const fams = this.chunks.find((c) => c.type === "FAMs" && c.id === f.id);
      this.put({
        type: "FAMs",
        id: f.id,
        flags: fams?.flags ?? 0x10,
        label: fams?.label ?? "",
        data: stringSetMultiSave(fams?.data ?? null, CURRENT_LANG, [f.name]),
      });
      f.dirty = false;
    }
    this.orderFamilyChunks();
    // NGBH, written in the current version once something changed it (townie flags).
    if (this.ngbhRaw?.dirty) {
      const ngbh = this.chunks.find((c) => c.type === "NGBH");
      this.put({ type: "NGBH", id: ngbh?.id ?? 1, flags: ngbh?.flags ?? 0x10, label: ngbh?.label ?? "", data: serializeNgbh(this.ngbhRaw, NGBH_CURRENT_VERSION) });
      this.ngbhRaw.dirty = false;
    }
    // ObjectFolder::Save: the type attribute blocks (TATT 1) of this neighborhood's folder, when it is open.
    const folder = await (await import("../world/objectfolder.js")).ObjectFolder.loaded(this.dir)?.catch(() => null);
    if (folder) {
      const tatt = this.chunks.find((c) => c.type === "TATT" && c.id === 1);
      this.put({ type: "TATT", id: 1, flags: tatt?.flags ?? 0x10, label: tatt?.label ?? "", data: folder.saveTypeAttributes() });
    }
    await writeGameFile(`${this.dir}/Neighborhood.iff`, buildIff(this.chunks));
  }

  /**
   * The in-memory Neighborhood's state that Neighborhood::Save streams: the
   * queued persistent data, every neighbor's RelMatrix and the SimInventory
   * vector (NGBH).
   */
  /**
   * Neighborhood::UpdateFamilyFriendsCount: the neighbors outside the family
   * who belong to a family (Neighbor +0xee) and are not pets, with a daily
   * relationship of at least the friendship threshold both ways with a member.
   */
  private familyFriendsCount(f: FamilyRaw): number {
    const nbrs = this.nbrs.entries.filter((e): e is NeighborRaw => !!e);
    const members = new Set(f.memberGuids.map((g) => g >>> 0));
    const memberNbrs = nbrs.filter((n) => members.has(n.guid >>> 0));
    const daily = (from: NeighborRaw, to: number): number | null => {
      const r = from.rels.entries.find((x) => x?.other === to);
      return r && r.values.length > 0 ? r.values[0]! : null;
    };
    let count = 0;
    for (const n of nbrs) {
      if (members.has(n.guid >>> 0) || n.pdVersion === 0 || n.personData[PD.familyNumber] === 0) continue;
      const friend = memberNbrs.some((m) => {
        const a = daily(n, m.id);
        const b = daily(m, n.id);
        return a !== null && b !== null && a >= friendshipThreshold && b >= friendshipThreshold;
      });
      if (friend && (n.personData[PD.gender] ?? 0) < 2) count++;
    }
    return count;
  }

  private takeLive(): void {
    const live = liveNeighborhood;
    if (!live || live.data.dir !== this.dir) return;
    for (const [guid, pd] of live.persistent) this.savePersistentData(guid, pd);
    live.persistent.clear();
    for (const e of this.nbrs.entries) {
      if (!e) continue;
      const n = live.data.neighbors.find((x) => x.id === e.id && x.guid >>> 0 === e.guid >>> 0);
      if (!n) continue;
      const entries = n.relationships.map((r) => ({ present: 1, other: r.other, values: [...r.values] }));
      e.rels = e.rels.count < 0 ? { count: e.rels.count, vecCount: entries.length, entries } : { count: entries.length, vecCount: 0, entries };
    }
    // Neighborhood::RemoveFromFamily in the lot (generic sim call 6): the family's member
    // list (Family +0x124 set: saved) and the neighbor's family number (+0xee, person data 0x3d).
    for (const f of this.families) {
      const lf = live.data.families.find((x) => x.chunkId === f.id);
      if (!lf || lf.memberGuids.length === f.memberGuids.length) continue;
      const kept = new Set(lf.memberGuids.map((g) => g >>> 0));
      for (const g of f.memberGuids) {
        const n = kept.has(g >>> 0) ? undefined : this.neighborByGuid(g);
        if (n) n.personData[0x3d] = 0;
      }
      f.memberGuids = [...kept];
      f.flags &= ~8;
      f.dirty = true;
    }
    // Family::SaveFamily: a history loaded in the lot (Family::GetHistory, +0x144) is saved
    // (ReconSaveObject, FAMh version 1); one never loaded keeps the chunk as read.
    for (const lf of live.data.families) {
      if (!lf.history) continue;
      const famh = this.chunks.find((c) => c.type === "FAMh" && c.id === lf.chunkId);
      this.put({ type: "FAMh", id: lf.chunkId, flags: famh?.flags ?? 0x10, label: famh?.label ?? "", data: serializeFamilyHistory(lf.history) });
    }
    const ngbh = this.ngbh();
    if (ngbh.version > 0x3f || ngbh.inventory || live.data.inventories.length) {
      ngbh.inventory = serializeInventories(live.data);
      ngbh.dirty = true;
    }
  }

  // --- Family import (Neighborhood::ImportFamily, nbhd/imports.ts) -----------------

  /** Neighborhood::AddNewCharacter(kind, id): StubObject::CreateNew of `template` into the next free User%05d.iff. */
  private async newCharacterFile(template: readonly IffChunk[], neighborId: number): Promise<{ guid: number; neighborId: number; fileName: string }> {
    const prefix = `sims/${this.dir}/characters/`.toLowerCase();
    const taken = new Set(
      (await fetchManifest()).files.map((f) => f.path.toLowerCase()).filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length)),
    );
    let base = "";
    while (this.nextUserFile < 32000) {
      const candidate = `User${String(this.nextUserFile).padStart(5, "0")}`;
      this.nextUserFile++;
      if (!taken.has(`${candidate}.iff`.toLowerCase())) {
        base = candidate;
        break;
      }
    }
    if (this.nextUserFile > 31999) this.nextUserFile = 0;
    if (!base) throw new Error("no free character file name");
    const fileName = `${base}.iff`;
    let created = await createCharacterFileFrom(this.dir, fileName, base, template);
    while (this.neighborByGuid(created.guid)) created = await createCharacterFileFrom(this.dir, fileName, base, template);
    return { guid: created.guid, neighborId: this.addNewNeighbor(created.guid, base.toLowerCase(), neighborId), fileName };
  }

  /**
   * The data part of Neighborhood::ImportFamily(file): `file` is a .FAM (an
   * exported family, a house file with the family chunks when it had a lot).
   *  - EXPi 0 (ExpFamilyInfo): the family id and its members' neighbor ids in
   *    the exporting neighborhood; FAMI <id> (Family::LoadFamily), the name
   *    from CTSS 1000 entry 1; NBRS 1 (the exporting neighborhood's
   *    neighbors) and FINV 2 (the members' SimInventories).
   *  - MakeNewFamily, which takes the file's id when no family has it; name,
   *    budget and net worth from the file.
   *  - A house in the file (FAMI +0x110): the family living there (or on
   *    vacation there) moves out (house 0, budget = net worth, flags bit 3
   *    off) and the characters of that lot (Neighbor +0xfa) are deleted.
   *  - Per member (up to 8): uChr <id> body strings, entry 13 picks the
   *    template ("dog" 1, "cat" 2, else 0: `templateFor`); AddNewCharacter
   *    with the old neighbor id wished; Family::AddMember; its FINV record
   *    renumbered into the SimInventory vector (replacing one of that id);
   *    the catalog name / description from CTSS <id> + 2000 (else CTSS <id>),
   *    written by the caller with the body strings into the new file.
   *  - GUIDTranslation pairs old -> new GUID, the RelMatrix arrays between
   *    members copied, the person data version and the persistent fields.
   *  - UpdateFamilyNumbers; with a house: the family takes it (flags bits 2 / 3
   *    off; bit 0 from the file) and Gtab 1 of the file gets the pairs (the
   *    caller moves the file onto Houses/House%02d.iff).
   *  - Global 26 (tutorial) of the file's SIMI: Neighborhood +0x12c = house.
   * Returns null when the file is not a family (the caller's error box).
   * Not ported: the ObjectTypeAttrBlock reset of the tutorial lot's objects
   * (OBJD +0xb6 bit 1) and the per-field persistent data versions (all the
   * version 9 fields are copied).
   */
  async importFamily(
    file: readonly IffChunk[],
    templateFor: (kind: number) => Promise<readonly IffChunk[] | null>,
    tutorial: boolean,
  ): Promise<ImportedFamily | null> {
    const get = (type: string, id: number): IffChunk | undefined => file.find((c) => c.type === type && c.id === id);
    const expiChunk = get("EXPi", 0);
    if (!expiChunk) return null;
    const expi = new ReconReader(expiChunk.data);
    expi.i32();
    expi.i32();
    expi.tag();
    const fileFamilyId = expi.i16();
    const ids = Array.from(expi.i16s(8));
    const fami = get("FAMI", fileFamilyId);
    if (!fami) return null;
    // Family::LoadFamily: the name is FAMs <id> (entry 1 in the current language); CTSS 1000 overrides it.
    const fams = get("FAMs", fileFamilyId);
    const loaded = parseFamily(fami.data, fileFamilyId, fams ? pickString(fams.data, 0) : "");
    const names = get("CTSS", 1000);
    const famName = names ? pickString(names.data, 0) : "";
    const nbrsChunk = get("NBRS", 1);
    if (!nbrsChunk) return null;
    const source = parseNbrsRaw(nbrsChunk.data);
    const finv = get("FINV", 2);
    const records = finv ? parseInventoryRecords(finv.data.subarray(12)) : [];

    const familyId = this.makeNewFamily();
    const fam = this.familyRaw(familyId)!;
    if (!this.families.some((f) => f.id === fileFamilyId)) fam.id = fileFamilyId;
    fam.name = famName || loaded.name;
    fam.budget = loaded.budget;
    fam.netWorth = loaded.netWorth;
    const house = loaded.houseNumber;
    let displaced = -1;
    if (house !== 0) {
      displaced = this.moveOutFamily(house);
      for (const guid of this.charactersOfHouse(house)) await this.deleteCharacter(guid);
    }

    const members: ImportedMember[] = [];
    const newIds: number[] = [];
    const inventory = parseInventoryRecords(this.ngbh().inventory ?? new Uint8Array(4));
    for (let i = 0; i < 8 && ids[i] !== 0; i++) {
      const oldId = ids[i]!;
      const uChr = get("uChr", oldId);
      const bodyStrings = uChr ? pickStrings(uChr.data) : [];
      const skeleton = bodyStrings[12] ?? "";
      const kind = skeleton.includes("dog") ? 1 : skeleton.includes("cat") ? 2 : 0;
      const template = await templateFor(kind);
      if (!template) return null;
      const made = await this.newCharacterFile(template, oldId);
      newIds.push(made.neighborId);
      fam.memberGuids.push(made.guid >>> 0);
      const record = records[i];
      if (record) {
        new DataView(record.buffer, record.byteOffset, record.byteLength).setInt16(0, made.neighborId, true);
        const at = inventory.findIndex((r) => r && new DataView(r.buffer, r.byteOffset, 2).getInt16(0, true) === made.neighborId);
        if (at >= 0) inventory[at] = record;
        else inventory.push(record);
      }
      const desc = get("CTSS", oldId + 2000) ?? get("CTSS", oldId);
      members.push({
        guid: made.guid >>> 0,
        fileName: made.fileName,
        firstName: desc ? pickString(desc.data, 0) : "",
        bio: desc ? pickString(desc.data, 1) : "",
        bodyStrings,
      });
    }
    if (records.length || inventory.length) {
      this.ngbh().inventory = serializeInventoryRecords(inventory);
      this.touchNgbh();
    }

    // GUIDTranslation pairs, relationships between the members, person data.
    const pairs: Array<[number, number]> = [];
    ids.slice(0, newIds.length).forEach((oldId, i) => {
      const from = source.entries[oldId - 1];
      const to = this.nbrs.entries[newIds[i]! - 1];
      if (!from || !to) return;
      pairs.push([from.guid >>> 0, to.guid >>> 0]);
      ids.slice(0, newIds.length).forEach((otherOld, j) => {
        const arr = from.rels.entries.find((a) => a && a.other === otherOld);
        const other = newIds[j]!;
        to.rels.entries = to.rels.entries.filter((a) => !a || a.other !== other);
        if (arr && arr.values.length) to.rels.entries.push({ present: 1, other, values: [...arr.values] });
        if (to.rels.count >= 0) to.rels.count = to.rels.entries.length;
        else to.rels.vecCount = to.rels.entries.length;
      });
      to.pdVersion = from.pdVersion;
      if (from.pdVersion) for (const k of PERSISTENT_DATA_FIELDS) to.personData[k] = from.personData[k] ?? 0;
    });
    // UpdateFamilyNumbers
    for (const g of fam.memberGuids) {
      const n = this.neighborByGuid(g);
      if (n) n.personData[PD.familyNumber] = fam.id;
    }

    let gtab: IffChunk | null = null;
    if (house !== 0) {
      if (this.families.some((f) => f !== fam && (f.houseNumber === house || f.unk13c === house))) return null;
      fam.houseNumber = house;
      fam.flags &= ~0xc;
      const old = get("Gtab", 1);
      gtab = { type: "Gtab", id: 1, flags: old?.flags ?? 0x10, label: old?.label ?? "", data: serializeGtab([...(old ? parseGtab(old.data) : []), ...pairs]) };
    }
    if (loaded.flags & 1) fam.flags |= 1;
    fam.dirty = true;
    // Neighborhood +0x12c / +0x12e (NGBH shorts 2 / 3): the tutorial lot.
    const ngbh = this.ngbh();
    if (tutorial) {
      ngbh.shorts[2] = house;
      ngbh.shorts[3] = 0;
      this.touchNgbh();
    } else if (ngbh.shorts[2] === house) {
      ngbh.shorts[2] = 0;
      this.touchNgbh();
    }
    return { familyId: fam.id, displaced, house, members, gtab };
  }

  // --- Townies (Neighborhood::DoFirstTimeTownies / RefillTownies / AddNewTownie, nbhd/townies.ts) ---

  /** Parsed NGBH (Neighborhood::DoStream), read on first use. */
  private ngbhRaw: NgbhRaw | null = null;

  /** The NGBH flags block (Neighborhood +0x19c..+0x1a6). */
  ngbh(): NgbhRaw {
    if (!this.ngbhRaw) {
      const c = this.chunks.find((x) => x.type === "NGBH");
      if (!c) throw new Error(`${this.dir}/Neighborhood.iff: no NGBH`);
      this.ngbhRaw = parseNgbh(c.data);
    }
    return this.ngbhRaw;
  }

  /** Marks the NGBH as changed: Save writes it in version 0x49. */
  touchNgbh(): void {
    this.ngbh().dirty = true;
  }

  /** The families' ids (Neighborhood::GetFamilies). */
  familyIds(): number[] {
    return this.families.map((f) => f.id);
  }

  /** Family +0x130: the number of members. */
  familyMemberCount(familyId: number): number {
    return this.familyRaw(familyId)?.memberGuids.length ?? 0;
  }

  /** DoFirstTimeTownies: a family that already uses id 2000 moves to max id + 1. */
  renumberFamily(oldId: number, newId: number): void {
    const f = this.familyRaw(oldId);
    if (!f) return;
    this.chunks = this.chunks.filter((c) => !((c.type === "FAMI" || c.type === "FAMs" || c.type === "FAMh") && c.id === oldId));
    f.id = newId;
    f.dirty = true;
  }

  /** `new Family(module, id)` + SetName + insertion into the family vector (RefillTownies). */
  newFamily(id: number, name: string): void {
    if (this.familyRaw(id)) return;
    this.families.push({
      id,
      name,
      houseNumber: 0,
      familyNumber: -1,
      budget: 0,
      netWorth: 0,
      unk120: 0,
      flags: 0,
      memberGuids: [],
      unk13c: 0,
      spells: [0, 0, 0, 0, 0, 0],
      dirty: true,
    });
  }

  /** PersonFinder::GetName of every member of a family, in member order (Neighborhood::IsNameUnique). */
  async familyMemberNames(familyId: number): Promise<string[]> {
    const f = this.familyRaw(familyId);
    if (!f) return [];
    const out: string[] = [];
    for (const g of f.memberGuids) {
      const n = this.neighborByGuid(g);
      out.push(n ? await readCharacterFirstName(this.dir, characterFileName(n.name)) : "");
    }
    return out;
  }

  /** Family::AddMember: the GUID joins the member list (the neighbor itself is not touched). */
  addFamilyMember(familyId: number, guid: number): void {
    const f = this.familyRaw(familyId);
    if (!f || f.memberGuids.includes(guid >>> 0)) return;
    f.memberGuids.push(guid >>> 0);
    f.dirty = true;
  }

  /**
   * The file part of AddNewTownie: StubObject::CreateNew of the template into
   * the first free Characters/User%05d.iff (Neighborhood +0x160 counter, 32000
   * wrap), the OBJD type set to 2 (person), then AddNewNeighbor for it.
   */
  async addNewCharacterFrom(template: readonly IffChunk[]): Promise<{ guid: number; neighborId: number; shortName: string; fileName: string }> {
    const prefix = `sims/${this.dir}/characters/`.toLowerCase();
    const taken = new Set(
      (await fetchManifest()).files.map((f) => f.path.toLowerCase()).filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length)),
    );
    let base = "";
    while (this.nextUserFile < 32000) {
      const candidate = `User${String(this.nextUserFile).padStart(5, "0")}`;
      this.nextUserFile++;
      if (!taken.has(`${candidate}.iff`.toLowerCase())) {
        base = candidate;
        break;
      }
    }
    if (this.nextUserFile > 31999) this.nextUserFile = 0;
    if (!base) throw new Error("no free character file name");
    const fileName = `${base}.iff`;
    let created = await createCharacterFileFrom(this.dir, fileName, base, template, 2);
    // Two files made in the same millisecond could draw the same GUID: draw again.
    while (this.neighborByGuid(created.guid)) created = await createCharacterFileFrom(this.dir, fileName, base, template, 2);
    const neighborId = this.addNewNeighbor(created.guid, base.toLowerCase());
    return { guid: created.guid, neighborId, shortName: base.toLowerCase(), fileName };
  }
}

/** The files CopyMissingUnleashedFilesIntoUserData copies after the 31 houses (lbl_105BB990 + 0x26f..0x474): source in the game folder, destination in the neighborhood. */
const UNLEASHED_TEMPLATE_FILES: ReadonlyArray<readonly [string, string]> = [
  ["TemplateCommunity/NeighborhoodDesc.iff", "Houses/NeighborhoodDesc.iff"],
  ["TemplateCommunity/LotLocations.iff", "LotLocations.iff"],
  ["TemplateCommunity/LotZoning.iff", "LotZoning.iff"],
  ["TemplateCommunity/StreetNames.iff", "StreetNames.iff"],
  ["TemplateUserData/Patch/Burb_11.FAM", "Patch/Burb_11.FAM"],
  ["TemplateUserData/Patch/Charming_13.FAM", "Patch/Charming_13.FAM"],
  ["TemplateUserData/Patch/Goth Sr_12.FAM", "Patch/Goth Sr_12.FAM"],
  ["TemplateUserData/Patch/Hick_10.FAM", "Patch/Hick_10.FAM"],
  ["TemplateUserData/Patch/Kat_6.FAM", "Patch/Kat_6.FAM"],
  ["TemplateUserData/Patch/Strays_4000.FAM", "Patch/Strays_4000.FAM"],
];

/**
 * CopyMissingUnleashedFilesIntoUserData(Neighborhood *), the first thing
 * Neighborhood::Load does (no expansion check): a neighborhood without
 * Houses/House50.iff (made before Unleashed) gets TemplateCommunity's
 * House50..House80, NeighborhoodDesc (into Houses/), LotLocations, LotZoning
 * and StreetNames, a Patch directory and TemplateUserData/Patch's six
 * families (which the neighborhood screen's TryImportUnleashedFamilies then
 * imports). Every copy is cTSFile::Copy(src, dst, true): CopyFileA with
 * bFailIfExists, so a file the neighborhood already has is kept; failures are
 * ignored. The CQuickTimePlayer::UpdateAll calls between copies keep the
 * intro movie going (nothing to do here). Returns whether it copied.
 */
export async function copyMissingUnleashedFilesIntoUserData(dir: string): Promise<boolean> {
  const present = new Set((await fetchManifest()).files.map((f) => f.path.toLowerCase()));
  const exists = (path: string): boolean => present.has(`sims/${path}`.toLowerCase());
  if (exists(`${dir}/Houses/House50.iff`)) return false;
  const copy = async (src: string, dst: string): Promise<void> => {
    if (exists(`${dir}/${dst}`)) return;
    try {
      const res = await assetFetch(`Sims/${src}`, { cache: "no-store" });
      if (!res.ok) return;
      await writeGameFile(`${dir}/${dst}`, new Uint8Array(await res.arrayBuffer()));
    } catch (e) {
      console.warn(`[nbhd] copy ${src} -> ${dir}/${dst}`, e);
    }
  };
  for (let house = 50; house < 81; house++) await copy(`TemplateCommunity/House${house}.iff`, `Houses/House${house}.iff`);
  // The _mkdir of <dir>/Patch is implicit: the overlay creates the directories of a written file.
  for (const [src, dst] of UNLEASHED_TEMPLATE_FILES) await copy(src, dst);
  return true;
}

/** One member made by importFamily (its character file still needs the strings and portraits). */
export interface ImportedMember {
  guid: number;
  fileName: string;
  firstName: string;
  bio: string;
  bodyStrings: string[];
}

export interface ImportedFamily {
  familyId: number;
  /** The family moved out of the imported lot, -1 for none. */
  displaced: number;
  house: number;
  members: ImportedMember[];
  /** Gtab 1 for the house file (with a house). */
  gtab: IffChunk | null;
}

/** Entry `i` of a string set in the current language, else US English (StringSetMulti::GetString). */
function pickString(data: Uint8Array, i: number): string {
  const e = decodeStrSet(data);
  return (e.filter((x) => x.lang === CURRENT_LANG)[i] ?? e.filter((x) => x.lang === 1)[i] ?? e[i])?.value ?? "";
}

/** Every entry of a string set in one language (StringSetBase::Load: the current one, else US English). */
function pickStrings(data: Uint8Array): string[] {
  const e = decodeStrSet(data);
  const cur = e.filter((x) => x.lang === CURRENT_LANG);
  const pick = cur.length ? cur : e.filter((x) => x.lang === 1);
  return (pick.length ? pick : e).map((x) => x.value);
}

/** A SimInventory pointer vector body (count, then present + id, token count, 10-byte tokens): the records, null where absent. */
function parseInventoryRecords(b: Uint8Array): Array<Uint8Array | null> {
  if (b.length < 4) return [];
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const count = v.getInt32(0, true);
  const out: Array<Uint8Array | null> = [];
  let p = 4;
  for (let i = 0; i < count && p + 4 <= b.length; i++) {
    const present = v.getInt32(p, true);
    p += 4;
    if (!present) {
      out.push(null);
      continue;
    }
    const end = p + 6 + v.getInt32(p + 2, true) * 10;
    out.push(b.slice(p, end));
    p = end;
  }
  return out;
}

function serializeInventoryRecords(records: ReadonlyArray<Uint8Array | null>): Uint8Array {
  const w = new ReconWriter();
  w.i32(records.length);
  for (const r of records) {
    w.i32(r ? 1 : 0);
    if (r) w.bytes(r);
  }
  return w.finish();
}

/** GUIDTranslation::Load: the pairs of Gtab 1. */
function parseGtab(b: Uint8Array): Array<[number, number]> {
  const r = new ReconReader(b);
  r.i32();
  r.i32();
  r.tag();
  const n = r.i32();
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) out.push([r.u32(), r.u32()]);
  return out;
}

/** GUIDTranslation::Save (ReconSaveVector<GUIDPair>, version 0). */
function serializeGtab(pairs: ReadonlyArray<readonly [number, number]>): Uint8Array {
  const w = new ReconWriter();
  w.i32(0);
  w.i32(0);
  w.tag("batG");
  w.i32(pairs.length);
  for (const [a, b] of pairs) {
    w.i32(a | 0);
    w.i32(b | 0);
  }
  return w.finish();
}

/** Neighborhood::Save's NGBH version (Complete Collection). */
export const NGBH_CURRENT_VERSION = 0x49;

/**
 * NGBH (Neighborhood::DoStream): the 16 shorts at +0x128 (1 before version
 * 0x14), the SimInventory pointer vector (versions > 0x3f, kept as raw
 * bytes) and the one-byte bools; versions without a bool get DoStream's
 * defaults.
 */
export interface NgbhRaw {
  head: number;
  version: number;
  shorts: number[];
  /** The SimInventory vector as stored (null before version 0x40: an empty vector). */
  inventory: Uint8Array | null;
  /** +0x19c townies done, +0x19d townies needed (DoFirstTimeTownies). */
  townies: [boolean, boolean];
  /** +0x19e / +0x19f */
  b19e: [boolean, boolean];
  /** +0x1a6 */
  b1a6: boolean;
  /** +0x1a0..+0x1a3 */
  b1a0: [boolean, boolean, boolean, boolean];
  /** +0x1a4 / +0x1a5 */
  b1a4: [boolean, boolean];
  dirty: boolean;
}

function ngbhBoolCount(v: number): number {
  return (v >= 0x42 ? 2 : 0) + (v >= 0x44 ? 2 : 0) + (v >= 0x45 ? 1 : 0) + (v >= 0x46 ? 4 : 0) + (v >= 0x49 ? 2 : 0);
}

export function parseNgbh(bytes: Uint8Array): NgbhRaw {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const head = v.getInt32(0, true);
  const version = v.getInt32(4, true);
  const tag = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
  if (tag !== "HBGN" && tag !== "NGBH") throw new Error("NGBH: bad magic");
  const nShorts = version < 0x14 ? 1 : 0x10;
  const shorts: number[] = [];
  for (let i = 0; i < nShorts; i++) shorts.push(v.getInt16(12 + 2 * i, true));
  const nBools = ngbhBoolCount(version);
  const end = bytes.length - nBools;
  const inventory = version > 0x3f ? bytes.slice(12 + 2 * nShorts, end) : null;
  const b = (i: number): boolean => bytes[end + i] !== 0;
  let k = 0;
  const next = (dflt: boolean, present: boolean): boolean => (present ? b(k++) : dflt);
  const townies: [boolean, boolean] = [next(false, version >= 0x42), next(true, version >= 0x42)];
  const b19e: [boolean, boolean] = [next(false, version >= 0x44), next(true, version >= 0x44)];
  const b1a6 = next(true, version >= 0x45);
  const has46 = version >= 0x46;
  const b1a0: [boolean, boolean, boolean, boolean] = [next(false, has46), next(true, has46), next(false, has46), next(true, has46)];
  const b1a4: [boolean, boolean] = [next(false, version >= 0x49), next(true, version >= 0x49)];
  return { head, version, shorts, inventory, townies, b19e, b1a6, b1a0, b1a4, dirty: false };
}

export function serializeNgbh(n: NgbhRaw, version = n.version): Uint8Array {
  const nShorts = version < 0x14 ? 1 : 0x10;
  const inv = version > 0x3f ? (n.inventory ?? new Uint8Array(4)) : new Uint8Array(0);
  const bools: boolean[] = [];
  if (version >= 0x42) bools.push(...n.townies);
  if (version >= 0x44) bools.push(...n.b19e);
  if (version >= 0x45) bools.push(n.b1a6);
  if (version >= 0x46) bools.push(...n.b1a0);
  if (version >= 0x49) bools.push(...n.b1a4);
  const out = new Uint8Array(12 + 2 * nShorts + inv.length + bools.length);
  const v = new DataView(out.buffer);
  v.setInt32(0, n.head, true);
  v.setInt32(4, version, true);
  out.set([0x4e, 0x47, 0x42, 0x48].reverse(), 8);
  for (let i = 0; i < nShorts; i++) v.setInt16(12 + 2 * i, n.shorts[i] ?? 0, true);
  out.set(inv, 12 + 2 * nShorts);
  bools.forEach((x, i) => (out[12 + 2 * nShorts + inv.length + i] = x ? 1 : 0));
  return out;
}
