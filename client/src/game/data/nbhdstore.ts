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
import { createCharacterFile, deleteCharacterFile, GUID_TEMPLATE_PERSON } from "./character.js";
import { writeGameFile } from "./files.js";
import { buildIff, decodeStrSet, parseIff, stringSetMultiSave, type IffChunk } from "./iff.js";
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

  /** Neighborhood::DeleteCharacter: refused while the person belongs to a family. */
  async deleteCharacter(guid: number): Promise<void> {
    const n = this.neighborByGuid(guid);
    if (!n) return;
    if (this.families.some((f) => f.memberGuids.includes(guid >>> 0))) return;
    // RemoveNeighbor: free the slot and drop the relationships to it.
    this.nbrs.entries[n.id - 1] = null;
    for (const e of this.nbrs.entries) {
      if (!e) continue;
      e.rels.entries = e.rels.entries.filter((a) => !a || a.other !== n.id);
      if (e.rels.count >= 0) e.rels.count = e.rels.entries.length;
      else e.rels.vecCount = e.rels.entries.length;
    }
    await deleteCharacterFile(this.dir, `${n.name.charAt(0).toUpperCase()}${n.name.slice(1)}.iff`);
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
    await writeGameFile(`${this.dir}/Neighborhood.iff`, buildIff(this.chunks));
  }
}
