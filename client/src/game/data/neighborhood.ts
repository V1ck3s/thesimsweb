/**
 * Neighborhood data (UserData<N>/Neighborhood.iff), decoded like the game's
 * Neighborhood / Family / Neighbor DoStream methods.
 *
 *   NBRS  "SRBN" list of Neighbor: name (= character file short name), GUID,
 *         neighbor id, person data (Int16[256], indices named by Behavior.iff
 *         STR# 200 "Person Data Labels") and the relationship matrix.
 *   FAMI  "IMAF" one Family per chunk: house number, budget, member GUIDs...
 *   FAMs  the family name (STR#, chunk id = FAMI id).
 *   NGBH  Neighborhood::DoStream (chunk 1): tutorial flags, then (version
 *         > 0x3f) the SimInventory of each neighbor.
 *
 * Characters live in UserData<N>/Characters/<Name>.iff: CTSS 2000 holds the first
 * name and biography per language, BMP_ 2002..2004 the pre-rendered portraits.
 */

import { readStandaloneIff, type IffChunkInfo } from "../../engine/assets.js";
import { engine } from "../../engine/wasm.js";
import { LANG_FRENCH } from "../res/uires.js";
import { decodeBmp } from "../res/bmp.js";
import { ReconBuffer } from "../world/reconbuffer.js";
import type { FamilyStat } from "./familyhistory.js";
import { ReconReader } from "./recon.js";

/** Person data indices (Behavior.iff STR# 200). */
export const PD = {
  nicePersonality: 2,
  activePersonality: 3,
  generousPersonality: 4,
  playfulPersonality: 5,
  outgoingPersonality: 6,
  neatPersonality: 7,
  currentOutfit: 8,
  cleaningSkill: 9,
  cookingSkill: 10,
  charismaSkill: 11,
  mechanicalSkill: 12,
  creativitySkill: 15,
  bodySkill: 17,
  logicSkill: 18,
  jobData: 24,
  neighborId: 31,
  personType: 32,
  jobType: 56,
  jobPromotionLevel: 57,
  personAge: 58,
  skinColor: 60,
  familyNumber: 61,
  jobPerformance: 63,
  gender: 65,
  isGhost: 68,
  zodiac: 70,
  fameScore: 81,
} as const;

export interface Relationship {
  /** Neighbor id of the other person. */
  other: number;
  /** [daily, flags, lifetime] for most entries. */
  values: number[];
}

export interface Neighbor {
  id: number;
  guid: number;
  /** Character file short name ("user00001", "maid", ...). */
  name: string;
  personData: Int16Array | null;
  relationships: Relationship[];
  /** Neighbor::DoStream version (Neighbor +0x18; LoadPersistentData compares it with each field's minimum). */
  version?: number;
}

export interface Family {
  chunkId: number;
  name: string;
  houseNumber: number;
  familyNumber: number;
  budget: number;
  netWorth: number;
  flags: number;
  memberGuids: number[];
  /** Family +0x13c (version > 7): the vacation lot the family stays on, 0 for none. */
  vacationLot?: number;
  /** Family +0x14e: the six spell levels, when the stream had them (Family +0x14c). */
  spells?: number[];
  /** Family +0x140: the FAMh chunk LoadFamily read (data/familyhistory.ts getFamilyHistory loads it). */
  historyChunk?: Uint8Array | undefined;
  /** Family +0x144: the history once loaded (Family::GetHistory). */
  history?: FamilyStat[] | undefined;
}

export interface Character {
  firstName: string;
  bio: string;
  /** Chunk id -> BMP_ bytes (2002 faces, 2003 relationship images, 2004 thumbnail). */
  bitmaps: Map<number, Uint8Array>;
}

/** SimInventoryToken: +0 token type, +4 GUID, +8 count. */
export interface SimInventoryToken {
  type: number;
  guid: number;
  count: number;
}

/** SimInventory: +0 neighbor id, +4 its tokens. */
export interface SimInventory {
  neighborId: number;
  tokens: SimInventoryToken[];
}

export interface NeighborhoodData {
  dir: string;
  neighbors: Neighbor[];
  families: Family[];
  /** Neighborhood +400 (NGBH): one SimInventory per neighbor that has one. */
  inventories: SimInventory[];
  /** Neighborhood +0x128 (NGBH): 16 shorts (one before version 0x14), read by expression scope 34. */
  data: Int16Array;
}

/**
 * Neighborhood::DoStream (read): +0x128 one short (version < 0x14) or 16,
 * then (version > 0x3f) DoPtrVectorStream<SimInventory>: a count, then per
 * entry a ReconInt "present" flag and SimInventory::DoStream (neighbor id,
 * DoContainerStream of tokens: count, then type, GUID, count). The flags
 * that follow (+0x19c..) are not kept.
 */
export function parseNgbh(bytes: Uint8Array): { data: Int16Array; inventories: SimInventory[] } {
  const { buf, version } = ReconBuffer.fromChunk(bytes);
  const data = new Int16Array(0x10);
  data.set(buf.recon16s(version < 0x14 ? 1 : 0x10));
  const out: SimInventory[] = [];
  if (version <= 0x3f) return { data, inventories: out };
  const n = buf.recon32();
  for (let i = 0; i < n; i++) {
    if (buf.recon32() === 0) continue;
    const neighborId = buf.recon16();
    const count = buf.recon32();
    const tokens: SimInventoryToken[] = [];
    for (let k = 0; k < count; k++) tokens.push({ type: buf.recon32(), guid: buf.recon32(), count: buf.recon16() });
    out.push({ neighborId, tokens });
  }
  return { data, inventories: out };
}

function payload(data: Uint8Array, c: IffChunkInfo): Uint8Array {
  return data.subarray(c.dataStart, c.dataStart + c.dataLen);
}

export function parseNbrs(bytes: Uint8Array): Neighbor[] {
  const r = new ReconReader(bytes);
  r.i32();
  const version = r.i32();
  if (r.tag() !== "SRBN") throw new Error("NBRS: bad magic");
  const count = r.i32();
  const out: Neighbor[] = [];
  for (let i = 0; i < count; i++) {
    if (r.i32() === 0) continue;
    // Neighbor::DoStream: a stream version precedes the fields.
    let local = 0;
    if (version > 0x48) local = r.i32();
    if (version < 0x48) local = version >= 0x1f ? r.i32() : 0;
    else local = r.i32();
    let name = "";
    if (local > 1) {
      name = r.cstr();
      r.i32();
    }
    let personData: Int16Array | null = null;
    if (local > 0 && r.i32() !== 0) {
      if (local >= 8) personData = r.i16s(0x100);
      else if (local >= 3) personData = r.i16s(0x50);
      else {
        personData = r.i16s(0x40);
        r.i16();
      }
    }
    const id = r.i16();
    const guid = r.u32();
    out.push({ id, guid, name, personData, relationships: readRelMatrix(r, version), version: local });
  }
  return out;
}

/** RelMatrix::DoStream: either a counted list or (count < 0) a pointer vector. */
function readRelMatrix(r: ReconReader, version: number): Relationship[] {
  const rels: Relationship[] = [];
  const readArray = (): void => {
    const other = version > 0 ? r.i32() : -1;
    const n = r.i32();
    const values: number[] = [];
    for (let k = 0; k < n; k++) values.push(r.i32());
    rels.push({ other, values });
  };
  const count = r.i32();
  if (count < 0) {
    const n = r.i32();
    for (let k = 0; k < n; k++) if (r.i32() !== 0) readArray();
  } else {
    for (let k = 0; k < count; k++) readArray();
  }
  return rels;
}

export function parseFami(bytes: Uint8Array, chunkId: number, name: string): Family {
  const r = new ReconReader(bytes);
  r.i32();
  const v = r.i32();
  if (r.tag() !== "IMAF") throw new Error("FAMI: bad magic");
  // Family::DoStream
  const houseNumber = r.i32();
  if (v < 5) r.cstr();
  const familyNumber = v > 0 ? r.i32() : 0;
  let budget = 0;
  let netWorth = 0;
  if (v > 1) {
    budget = r.i32();
    netWorth = r.i32();
    r.i32();
  }
  let flags = 0;
  if (v < 7) {
    if (v >= 3) flags = r.bool() ? 1 : 0;
    if (v > 3 && r.bool()) flags |= 2;
    if (v > 5 && r.bool()) flags |= 2;
  } else {
    flags = r.i32();
  }
  // The member list is only streamed for families other than 0 (Family +0x10c, the chunk id).
  const memberGuids: number[] = [];
  if (chunkId !== 0) {
    const n = r.i32();
    for (let i = 0; i < n; i++) memberGuids.push(r.u32());
  }
  const f: Family = { chunkId, name, houseNumber, familyNumber, budget, netWorth, flags, memberGuids };
  // +0x13c: the vacation lot the family stays on (0: none).
  if (v > 7) f.vacationLot = r.i32();
  // +0x14e: the spells (version > 8); +0x14c is set when they were read.
  if (v > 8) f.spells = Array.from(r.i16s(6));
  return f;
}

async function strEntries(bytes: Uint8Array): Promise<Array<{ langCode?: number; data: Uint8Array }>> {
  const wasm = await engine();
  return (wasm.parseStrTable(bytes) as { entries: Array<{ langCode?: number; data: Uint8Array }> }).entries;
}

const cp1252 = new TextDecoder("windows-1252");

/** Strings of a format -3 STR#/CTSS for one language (US English fallback). */
export async function localizedStrings(bytes: Uint8Array, lang: number): Promise<string[]> {
  const entries = await strEntries(bytes);
  if (!entries.some((e) => e.langCode !== undefined)) return entries.map((e) => cp1252.decode(e.data));
  const ours = entries.filter((e) => e.langCode === lang);
  const pick = ours.length ? ours : entries.filter((e) => e.langCode === 1);
  return pick.map((e) => cp1252.decode(e.data));
}

export async function loadNeighborhood(dir = "UserData", lang = LANG_FRENCH): Promise<NeighborhoodData> {
  const { data, chunks } = await readStandaloneIff(`Sims/${dir}/Neighborhood.iff`);
  const nbrs = chunks.find((c) => c.kind === "NBRS");
  const neighbors = nbrs ? parseNbrs(payload(data, nbrs)) : [];
  const names = new Map<number, string>();
  for (const c of chunks.filter((c) => c.kind === "FAMs")) {
    names.set(c.id, (await localizedStrings(payload(data, c), lang))[0] ?? "");
  }
  const families = chunks
    .filter((c) => c.kind === "FAMI")
    .map((c) => parseFami(payload(data, c), c.id, names.get(c.id) ?? ""));
  for (const f of families) {
    const famh = chunks.find((c) => c.kind === "FAMh" && c.id === f.chunkId);
    if (famh) f.historyChunk = payload(data, famh);
  }
  const ngbh = chunks.find((c) => c.kind === "NGBH" && c.id === 1);
  let ngbhData: { data: Int16Array; inventories: SimInventory[] } = { data: new Int16Array(0x10), inventories: [] };
  try {
    if (ngbh) ngbhData = parseNgbh(payload(data, ngbh));
  } catch {
    // keep the defaults
  }
  return { dir, neighbors, families, inventories: ngbhData.inventories, data: ngbhData.data };
}

export async function loadCharacter(dir: string, shortName: string, lang = LANG_FRENCH): Promise<Character> {
  const file = shortName.charAt(0).toUpperCase() + shortName.slice(1);
  const { data, chunks } = await readStandaloneIff(`Sims/${dir}/Characters/${file}.iff`);
  const ctss = chunks.find((c) => c.kind === "CTSS");
  const strings = ctss ? await localizedStrings(payload(data, ctss), lang) : [];
  const bitmaps = new Map<number, Uint8Array>();
  for (const c of chunks) if (c.kind === "BMP_") bitmaps.set(c.id, payload(data, c));
  if (blankHeadIds(bitmaps).length) {
    const key = `${dir}/${file}`;
    let fixed = regeneratedFaces.get(key);
    if (!fixed) {
      fixed = regenerateFaces(dir, shortName);
      regeneratedFaces.set(key, fixed);
    }
    const generated = await fixed;
    for (const id of blankHeadIds(bitmaps)) {
      const bytes = generated?.get(id);
      if (bytes) bitmaps.set(id, bytes);
    }
  }
  return { firstName: strings[0] ?? shortName, bio: strings[1] ?? "", bitmaps };
}

/**
 * Faces (BMP_ 2002) and relationship heads (2003) regenerated in memory, by
 * character file. MakePersonBtnImage / MakeRelationshipBtnImage do not clear
 * their buffer, so a head whose MakePersonHeadImage failed is saved as a
 * solid black cell (UserData's User00109..User00174 have a black middle,
 * "happy", face and two black relationship heads). The original only
 * re-renders the pictures when the person's thumbnails are dirty
 * (PersonFinder::DirtyThumbnails, then GetPictureBuffer -> GenerateBitmaps(i,
 * 1, 0): rendered, not saved); this port treats a blank head cell as such a
 * dirty picture so the portrait is not black.
 */
const regeneratedFaces = new Map<string, Promise<Map<number, Uint8Array> | null>>();

async function regenerateFaces(dir: string, shortName: string): Promise<Map<number, Uint8Array> | null> {
  try {
    const bodyStrings = await loadBodyStrings(dir, shortName);
    const { generatePortraits } = await import("../cas/portraits.js");
    return await generatePortraits(bodyStrings);
  } catch {
    return null;
  }
}

/** The head cells of the pictures that can be saved blank: 2002 three faces, 2003 five relationship heads. */
const HEAD_CELLS: ReadonlyMap<number, number> = new Map([
  [2002, 3],
  [2003, 5],
]);

/** The BMP_ ids (2002, 2003) of `bitmaps` with a blank head cell. */
export function blankHeadIds(bitmaps: ReadonlyMap<number, Uint8Array>): number[] {
  return [...HEAD_CELLS].filter(([id, cells]) => {
    const bytes = bitmaps.get(id);
    return !!bytes && hasBlankCell(bytes, cells);
  }).map(([id]) => id);
}

/** A bitmap cut in `cells` columns, one of which is all 0x000000. */
function hasBlankCell(bytes: Uint8Array, cells: number): boolean {
  let img;
  try {
    img = decodeBmp(bytes);
  } catch {
    return false;
  }
  const cell = Math.trunc(img.width / cells);
  if (cell <= 0) return false;
  for (let i = 0; i < cells; i++) {
    let blank = true;
    for (let y = 0; y < img.height && blank; y++) {
      for (let x = i * cell; x < (i + 1) * cell; x++) {
        const o = (y * img.width + x) * 4;
        if (img.data[o] !== 0 || img.data[o + 1] !== 0 || img.data[o + 2] !== 0) {
          blank = false;
          break;
        }
      }
    }
    if (blank) return true;
  }
  return false;
}

export function familyInHouse(n: NeighborhoodData, houseNumber: number): Family | undefined {
  return n.families.find((f) => f.houseNumber === houseNumber);
}

export function neighborByGuid(n: NeighborhoodData, guid: number): Neighbor | undefined {
  return n.neighbors.find((x) => x.guid === guid);
}

/**
 * The character's body strings (STR# 200 "bodystring", read by
 * BodyStrings::Load): skeleton, suits and textures, see sims/bodystrings.ts.
 */
export async function loadBodyStrings(dir: string, shortName: string): Promise<string[]> {
  const file = shortName.charAt(0).toUpperCase() + shortName.slice(1);
  const { data, chunks } = await readStandaloneIff(`Sims/${dir}/Characters/${file}.iff`);
  const c = chunks.find((c) => c.kind === "STR#" && c.id === 200);
  return c ? localizedStrings(payload(data, c), 1) : [];
}
