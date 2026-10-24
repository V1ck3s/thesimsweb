/**
 * Neighborhood data (UserData<N>/Neighborhood.iff), decoded like the game's
 * Neighborhood / Family / Neighbor DoStream methods.
 *
 *   NBRS  "SRBN" list of Neighbor: name (= character file short name), GUID,
 *         neighbor id, person data (Int16[256], indices named by Behavior.iff
 *         STR# 200 "Person Data Labels") and the relationship matrix.
 *   FAMI  "IMAF" one Family per chunk: house number, budget, member GUIDs...
 *   FAMs  the family name (STR#, chunk id = FAMI id).
 *
 * Characters live in UserData<N>/Characters/<Name>.iff: CTSS 2000 holds the first
 * name and biography per language, BMP_ 2002..2004 the pre-rendered portraits.
 */

import { readStandaloneIff, type IffChunkInfo } from "../../engine/assets.js";
import { engine } from "../../engine/wasm.js";
import { LANG_FRENCH } from "../res/uires.js";
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
}

export interface Character {
  firstName: string;
  bio: string;
  /** Chunk id -> BMP_ bytes (2002 faces, 2003 relationship images, 2004 thumbnail). */
  bitmaps: Map<number, Uint8Array>;
}

export interface NeighborhoodData {
  dir: string;
  neighbors: Neighbor[];
  families: Family[];
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
    out.push({ id, guid, name, personData, relationships: readRelMatrix(r, version) });
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
  const memberGuids: number[] = [];
  const n = r.i32();
  for (let i = 0; i < n; i++) memberGuids.push(r.u32());
  return { chunkId, name, houseNumber, familyNumber, budget, netWorth, flags, memberGuids };
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
  return { dir, neighbors, families };
}

export async function loadCharacter(dir: string, shortName: string, lang = LANG_FRENCH): Promise<Character> {
  const file = shortName.charAt(0).toUpperCase() + shortName.slice(1);
  const { data, chunks } = await readStandaloneIff(`Sims/${dir}/Characters/${file}.iff`);
  const ctss = chunks.find((c) => c.kind === "CTSS");
  const strings = ctss ? await localizedStrings(payload(data, ctss), lang) : [];
  const bitmaps = new Map<number, Uint8Array>();
  for (const c of chunks) if (c.kind === "BMP_") bitmaps.set(c.id, payload(data, c));
  return { firstName: strings[0] ?? shortName, bio: strings[1] ?? "", bitmaps };
}

export function familyInHouse(n: NeighborhoodData, houseNumber: number): Family | undefined {
  return n.families.find((f) => f.houseNumber === houseNumber);
}

export function neighborByGuid(n: NeighborhoodData, guid: number): Neighbor | undefined {
  return n.neighbors.find((x) => x.guid === guid);
}
