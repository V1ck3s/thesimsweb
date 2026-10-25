/**
 * The game's Neighborhood object on the save side: the parts of
 * Neighborhood / Neighbor / Family / NghInterface.cpp that create characters
 * and families, and Neighborhood::Save.
 *
 * <dir>/Neighborhood.iff is kept as raw chunks. NBRS (the Neighbor pointer
 * vector) is parsed losslessly, so re-serializing it reproduces the file's
 * bytes; FAMI chunks are parsed and only the families changed here are
 * written back. Neighborhood::Save rewrites every chunk (NGBH, NBRS, all
 * families, ObjectFolder's data) in the current version; we keep the chunks
 * we do not touch verbatim and write NBRS in the version the file already has
 * (Neighbor::DoStream picks the neighbor stream version from it), FAMI in
 * version 9 (Family::SaveFamily always saves 9) with its FAMs name.
 *
 * Neighbor slots: the NBRS vector holds null entries; a neighbor's id is its
 * slot + 1 (FindNeighborByID, AddNewNeighbor).
 */

import { fetchManifest } from "../../engine/assets.js";
import { LANG_FRENCH } from "../res/uires.js";
import { createCharacterFile, createCharacterFileFrom, deleteCharacterFile, GUID_TEMPLATE_PERSON } from "./character.js";
import { deleteGameFile, writeGameFile } from "./files.js";
import { buildIff, decodeStrSet, parseIff, stringSetBaseResave, stringSetMultiSave, stringSetMultiSaveLocal, type IffChunk } from "./iff.js";
import { PD } from "./neighborhood.js";
import { ReconReader, ReconWriter } from "./recon.js";

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
const CURRENT_LANG = LANG_FRENCH;

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
    const res = await fetch(`/assets/Sims/${dir}/Neighborhood.iff`, { cache: "no-store" });
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

  /** Neighborhood::AddNewNeighbor(selector, -1) + Neighbor(short, ObjSelector*). */
  private addNewNeighbor(guid: number, shortName: string): number {
    const entries = this.nbrs.entries;
    let slot = -1;
    // The game keeps the last free slot it sees.
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
    // RemoveNeighbor: free the slot and drop the relationships to it.
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
    const n = this.neighborByGuid(guid);
    if (!n) return;
    n.pdVersion = LATEST_PERS_DATA_VERSION;
    for (const i of PERSISTENT_DATA_FIELDS) n.personData[i] = personData[i] ?? 0;
  }

  /** PersonFinder::GetData without an instance: the neighbor's person data (live). */
  getPersonData(guid: number): Int16Array {
    return this.neighborByGuid(guid)?.personData ?? new Int16Array(256);
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
   * bulldoze, funds and global 26 zeroed, SaveHouse) is not done here.
   */
  moveOutFamily(house: number): number {
    const f = this.families.find((x) => x.houseNumber === house || x.unk13c === house);
    if (!f || house === 0) return -1;
    f.houseNumber = 0;
    f.flags &= ~8;
    f.budget = f.budget + f.netWorth;
    f.netWorth = 0;
    f.dirty = true;
    return f.id;
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
      const res = await fetch(`/assets/Sims/${path}`, { cache: "no-store" });
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

  private put(c: IffChunk): void {
    const i = this.chunks.findIndex((x) => x.type === c.type && x.id === c.id);
    if (i >= 0) this.chunks[i] = c;
    else this.chunks.push(c);
  }

  /** Neighborhood::Save (see the file comment for what is rewritten). */
  async save(): Promise<void> {
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
    // NGBH, written in the current version once something changed it (townie flags).
    if (this.ngbhRaw?.dirty) {
      const ngbh = this.chunks.find((c) => c.type === "NGBH");
      this.put({ type: "NGBH", id: ngbh?.id ?? 1, flags: ngbh?.flags ?? 0x10, label: ngbh?.label ?? "", data: serializeNgbh(this.ngbhRaw, NGBH_CURRENT_VERSION) });
      this.ngbhRaw.dirty = false;
    }
    await writeGameFile(`${this.dir}/Neighborhood.iff`, buildIff(this.chunks));
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
