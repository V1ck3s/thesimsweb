/**
 * Lot data for the neighborhood screens: the parts of Neighborhood and
 * NghInterface.cpp (GetHouseInfo) that the lot buttons and the lot popup read.
 *
 * Files, all relative to the neighborhood directory (UserData, UserData2, ...):
 *   LotZoning.iff     STR# 1, English entries "house, residential|community"
 *                     (Neighborhood::Load builds the zoning list from it; the
 *                     neighborhood screen creates one lot per entry).
 *   LotLocations.iff  STR# 1..7, English entries "house, x, y": the lot center
 *                     on the 800x600 map. Falls back to GameData/LotLocations.iff.
 *   Houses/HouseNN.iff
 *                     BMP_ 512/513 (thumbnail without / with only the roof),
 *                     BMP_ 1024/1025 (the half-size pair used by the Unleashed
 *                     screen), THMB 512/1024 (thumbnail anchor) and SIMI (lot value).
 *   Neighborhood.iff  families (decoded by data/neighborhood.ts).
 */

import { assetFetch, fetchManifest, type IffChunkInfo, readStandaloneIff } from "../../engine/assets.js";
import {
  familyInHouse,
  loadNeighborhood,
  localizedStrings,
  neighborByGuid,
  PD,
  type Family,
  type NeighborhoodData,
} from "../data/neighborhood.js";
import { writeGameFile } from "../data/files.js";
import { copyMissingUnleashedFilesIntoUserData } from "../data/nbhdstore.js";
import { buildIff, decodeStrSet, encodeStrSet, parseIff } from "../data/iff.js";
import { ReconReader } from "../data/recon.js";
import { decodeImage } from "../res/bmp.js";
import { friendshipThreshold } from "../sim/floatconstants.js";

/** ZoningData::eZoneTypes */
export const enum Zone {
  None = 0,
  Residential = 1,
  Community = 2,
}

/** STR# entry language of LoadOnlyEnglish / LoadEnglishUIStrings. */
const LANG_US_ENGLISH = 1;

/** THMB chunk: thumbnail anchor and roof offset; null when missing (0x7fffffff in the game). */
export interface Thmb {
  x: number;
  y: number;
  z: number;
  /** Offset of the roof bitmap relative to the house bitmap. */
  dx: number;
  dy: number;
}

/** HouseInfo as filled by GetHouseInfo(int, HouseInfo *, int). */
export interface HouseInfo {
  houseNumber: number;
  /** [0] BMP_ 512 (or 612): the house. */
  thumb: ImageBitmap | null;
  /** [1] BMP_ 513 (or 613): the roof. */
  roof: ImageBitmap | null;
  /** [2] BMP_ 1024 (or 1124), else [0] scaled by 0.5. */
  thumbSmall: ImageBitmap | null;
  /** [3] BMP_ 1025 (or 1125), else [1] scaled by 0.5. */
  roofSmall: ImageBitmap | null;
  /** +0x44: THMB 512 (or 612). */
  thmb: Thmb | null;
  /** +0x58: THMB 1024 (or 1124), else THMB 512 halved. */
  thmbSmall: Thmb | null;
  /** +0x10: nothing built and no objects (SIMI globals 21 and 26 both zero). */
  isEmpty: boolean;
  /** +0x14: SIMI global 26 (the tutorial house). */
  isTutorial: boolean;
  /** +0x18: SIMI global 22 (a house stands on the lot). */
  hasHouse: boolean;
  /** +0x1c: lot value (Neighborhood::GetHouseFileInfo). */
  value: number;
  /** +0x20: SIMI global 37, the lot type bits the town pickers filter on (1 lodging, 2 food, 4 gardening, 8 shopping, 0x10 pets...). */
  lotTypeFlags: number;
  /** +0x24: family number, -1 when nobody lives here. */
  familyNumber: number;
  /** +0x28 / +0x2c / +0x30 */
  familyName: string;
  netWorth: number;
  friends: number;
  /** +0x6c / +0x70: lot center on the neighborhood map. */
  lotX: number;
  lotY: number;
  /**
   * +0x00 holds no bitmap: GetHouseInfo loads BMP_ 512 only when the half-size
   * BMP_ 1024 is not used (or the file has neither). SaveLotPositions writes
   * only the lots for which this is set.
   */
  noLargeThumb: boolean;
}

/** Neighborhood directories present in the install, in neighborhood-number order. */
export async function listNeighborhoodDirs(): Promise<string[]> {
  const manifest = await fetchManifest();
  const dirs = new Set<string>();
  for (const f of manifest.files) {
    const m = /^Sims\/(UserData\d*)\/Neighborhood\.iff$/i.exec(f.path);
    if (m) dirs.add(m[1]!);
  }
  return [...dirs].sort((a, b) => neighborhoodNumber(a) - neighborhoodNumber(b));
}

/** Neighborhood::GetCurrentNeighborhoodNumber: UserData is 1, UserDataN is N. */
export function neighborhoodNumber(dir: string): number {
  const m = /(\d+)$/.exec(dir);
  return m ? Number(m[1]) : 1;
}

const fileCache = new Map<string, Promise<{ data: Uint8Array; chunks: IffChunkInfo[] } | null>>();

/** A standalone IFF under the game folder, or null when it does not exist. */
export function readIff(path: string): Promise<{ data: Uint8Array; chunks: IffChunkInfo[] } | null> {
  let p = fileCache.get(path);
  if (!p) {
    p = readStandaloneIff(`Sims/${path}`).catch(() => null);
    fileCache.set(path, p);
  }
  return p;
}

/** Drops the cached files (called after the game writes one, see data/files.ts). */
export function clearIffFileCache(): void {
  fileCache.clear();
}

function payload(data: Uint8Array, c: IffChunkInfo): Uint8Array {
  return data.subarray(c.dataStart, c.dataStart + c.dataLen);
}

/** One STR# chunk of `path` for `lang` (US English fallback), or null. */
export async function loadStrSet(path: string, id: number, lang: number): Promise<string[] | null> {
  const f = await readIff(path);
  const c = f?.chunks.find((c) => c.kind === "STR#" && c.id === id);
  return f && c ? localizedStrings(payload(f.data, c), lang) : null;
}

/** "a, b, c" -> numbers, read with atoi like the game (strchr ',' then atoi). */
function splitInts(s: string): number[] {
  return s.split(",").map((p) => Number.parseInt(p.trim(), 10) || 0);
}

/** lbl_105BCD5C strings of cWinNeighborhoodUL::SaveLotPositions. */
export const LOT_POSITIONS = {
  title: "Lot Positions",
  notWriteable: "Lot Positions are not writeable. Check out the file, enter Lot Move Mode again, and exit again to save.",
  saved: "Lot Positions have been saved",
  format: (house: number, x: number, y: number): string => `${house}, ${x}, ${y}`,
} as const;

/**
 * The file part of cWinNeighborhoodUL::SaveLotPositions: the neighborhood's
 * LotLocations.iff (GetStringConstant(10), ConstructRuntimePath) STR# 4,
 * StringSetBase::Load(false, true) (the current language's entries, else the
 * US English ones), then for each lot in house order the first entry whose
 * atoi is the house number becomes "%d, %d, %d" (house, x, y), and
 * StringSetBase::Save writes the set back in the current language. Without
 * the file the original opens GameData's copy and saves nothing ("missing");
 * a file that cannot be written gives "readonly" (the original checks the
 * open file's writability first).
 */
export async function saveLotPositions(
  dir: string,
  lots: ReadonlyArray<{ house: number; x: number; y: number }>,
  lang: number,
): Promise<"saved" | "readonly" | "missing"> {
  const path = `${dir}/LotLocations.iff`;
  const res = await assetFetch(`Sims/${path}`, { cache: "no-store" });
  if (!res.ok) return "missing";
  const chunks = parseIff(new Uint8Array(await res.arrayBuffer()));
  const all = chunks.find((c) => c.type === "STR#" && c.id === 4);
  const entries = all ? decodeStrSet(all.data) : [];
  const pick = entries.some((e) => e.lang === lang) ? entries.filter((e) => e.lang === lang) : entries.filter((e) => e.lang === LANG_US_ENGLISH);
  const set = pick.map((e) => ({ ...e, lang }));
  for (const { house, x, y } of lots) {
    const e = set.find((e) => (Number.parseInt(e.value, 10) || 0) === house);
    if (e) e.value = LOT_POSITIONS.format(house, x, y);
  }
  const data = encodeStrSet(set);
  if (all) all.data = data;
  else chunks.push({ type: "STR#", id: 4, flags: 0x10, label: "", data });
  try {
    await writeGameFile(path, buildIff(chunks));
  } catch (e) {
    console.warn(`[nbhd] ${path}`, e);
    return "readonly";
  }
  return "saved";
}

export class Neighborhood {
  private constructor(
    readonly dir: string,
    /** Replaced by reloadData() after the neighborhood file is saved. */
    public data: NeighborhoodData,
    /** The zoning list (Neighborhood+0x16c), in LotZoning.iff order. */
    readonly zoning: Array<{ house: number; zone: Zone }>,
  ) {}

  /** Re-reads Neighborhood.iff (the screen's view of the families after a save). */
  async reloadData(): Promise<void> {
    this.data = await loadNeighborhood(this.dir);
  }

  /**
   * Neighborhood::SetZoningType: the lot's entry of the zoning list changes,
   * then LotZoning.iff STR# 1 (loaded English only) gets the entry whose atoi
   * matches rewritten as "<house>, residential|community" and is saved.
   * Returns false when the lot is not in the list or already has that zone.
   */
  async setZoningType(house: number, zone: Zone): Promise<boolean> {
    const z = this.zoning.find((e) => e.house === house);
    if (!z || z.zone === zone) return false;
    z.zone = zone;
    const path = `${this.dir}/LotZoning.iff`;
    const res = await assetFetch(`Sims/${path}`, { cache: "no-store" });
    if (!res.ok) return false;
    const chunks = parseIff(new Uint8Array(await res.arrayBuffer()));
    const str = chunks.find((c) => c.type === "STR#" && c.id === 1);
    if (!str) return false;
    // LoadOnlyEnglish keeps the US English entries; Save writes them back.
    const entries = decodeStrSet(str.data).filter((e) => e.lang === LANG_US_ENGLISH);
    const i = entries.findIndex((e) => e.value.includes(",") && (Number.parseInt(e.value, 10) || 0) === house);
    if (i >= 0) entries[i] = { ...entries[i]!, value: `${house}, ${zone === Zone.Community ? "community" : "residential"}` };
    str.data = encodeStrSet(entries);
    await writeGameFile(path, buildIff(chunks));
    return true;
  }

  /** Neighborhood::Load (the parts the neighborhood screen needs). */
  static async load(dir: string): Promise<Neighborhood> {
    await copyMissingUnleashedFilesIntoUserData(dir);
    const data = await loadNeighborhood(dir);
    const zoning: Array<{ house: number; zone: Zone }> = [];
    for (const line of (await loadStrSet(`${dir}/LotZoning.iff`, 1, LANG_US_ENGLISH)) ?? []) {
      const comma = line.indexOf(",");
      if (comma < 0) continue;
      const word = line.slice(comma + 1).trim().toLowerCase();
      // "residential" -> 1, "community" -> 2, anything else -> 1.
      const zone = word === "community" ? Zone.Community : Zone.Residential;
      zoning.push({ house: Number.parseInt(line, 10) || 0, zone });
    }
    return new Neighborhood(dir, data, zoning);
  }

  get number(): number {
    return neighborhoodNumber(this.dir);
  }

  /** Neighborhood::GetZoningType */
  getZoningType(house: number): Zone {
    if (house === 0) return Zone.Residential;
    return this.zoning.find((z) => z.house === house)?.zone ?? Zone.None;
  }

  /** Neighborhood::GetHousePath */
  getHousePath(house: number): string {
    return `${this.dir}/Houses/House${String(house).padStart(2, "0")}.iff`;
  }

  getFamilyInHouse(house: number): Family | undefined {
    return familyInHouse(this.data, house);
  }

  /** Neighborhood::GetFamilyNetWorth (outside of a loaded lot). */
  getFamilyNetWorth(f: Family): number {
    return f.budget + f.netWorth;
  }

  /**
   * Neighborhood::UpdateFamilyFriendsCount: neighbors outside the family who
   * belong to a family themselves and share a daily relationship of at least
   * lbl_105BA1F4 (friendshipThreshold) both ways with one of the members.
   */
  getFamilyFriendsCount(f: Family): number {
    const members = f.memberGuids.map((g) => neighborByGuid(this.data, g)).filter((m) => m !== undefined);
    const daily = (from: { relationships: Array<{ other: number; values: number[] }> }, to: number): number | null => {
      const r = from.relationships.find((r) => r.other === to);
      return r && r.values.length > 0 ? r.values[0]! : null;
    };
    let count = 0;
    for (const n of this.data.neighbors) {
      if (f.memberGuids.includes(n.guid)) continue;
      const pd = n.personData;
      if (!pd || pd[PD.familyNumber] === 0) continue;
      const friend = members.some((m) => {
        const a = daily(n, m.id);
        const b = daily(m, n.id);
        return a !== null && b !== null && a >= friendshipThreshold && b >= friendshipThreshold;
      });
      if (friend && (pd[PD.gender] ?? 0) < 2) count++;
    }
    return count;
  }
}

/**
 * NeighborhoodConstants "architecture value multiplier" (default 0.7; the
 * neighborhood can override it through FloatConstants, which no shipped file does).
 */
const ARCHITECTURE_VALUE_MULTIPLIER = 0.7;

/** cSimulator fields that Neighborhood::GetHouseFileInfo reads from SIMI. */
export interface SimInfo {
  globals: Int16Array;
  /** cSimulator+0x9c / +0xa0 / +0xa4 */
  lotValue: number;
  objectsValue: number;
  architectureValue: number;
}

/** cSimulator::DoStream, up to the three value fields. */
export function readSimi(bytes: Uint8Array): SimInfo {
  const r = new ReconReader(bytes);
  r.i32();
  const v = r.i32();
  r.tag();
  const globals = r.i16s(v < 0x12 ? 0x10 : v < 0x41 ? 0x20 : 0x40);
  if (v < 0x12) r.i32();
  r.i32();
  r.i16();
  if (v > 1) r.i32();
  if (v > 0xd) {
    r.i32();
    r.i32();
  }
  if (v >= 0xf) r.i32();
  if (v < 0x25) return { globals, lotValue: 4500, objectsValue: 0, architectureValue: 0 };
  return { globals, lotValue: r.i32(), objectsValue: r.i32(), architectureValue: r.i32() };
}

function readThmb(bytes: Uint8Array): Thmb {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = (i: number): number => (i * 4 + 4 <= bytes.length ? v.getInt32(i * 4, true) : 0);
  return { x: at(0), y: at(1), z: at(2), dx: at(3), dy: at(4) };
}

/**
 * cTSBuffer::SetTransparency(magenta) compares in the 16-bit screen format, so
 * the thumbnails' (248, 0, 248) is transparent too.
 */
async function toBitmap(bytes: Uint8Array): Promise<ImageBitmap> {
  const img = decodeImage(bytes, "thumbnail.bmp");
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i]! >> 3 === 31 && d[i + 1]! >> 3 === 0 && d[i + 2]! >> 3 === 31) d[i + 3] = 0;
  }
  return createImageBitmap(new ImageData(img.data, img.width, img.height));
}

/** ScaleBitmap(0.5, ...) */
async function halve(src: ImageBitmap): Promise<ImageBitmap> {
  const c = new OffscreenCanvas(Math.max(1, Math.trunc(src.width * 0.5)), Math.max(1, Math.trunc(src.height * 0.5)));
  c.getContext("2d")!.drawImage(src, 0, 0, c.width, c.height);
  return createImageBitmap(c);
}

/** LotLocations STR# for a house: the range sets of GetHouseInfo. */
function lotLocationSet(house: number, zone: Zone): number | null {
  if (house >= 0x15 && house <= 0x1e) return 2;
  if (house >= 0x28 && house <= 0x31) return 3;
  if (house >= 0x51 && house <= 0x59) return 5;
  if (house >= 0x5a && house <= 0x63) return 7;
  if ((house >= 0x32 && house <= 0x50) || (house >= 0 && house <= 0xb)) return zone !== Zone.None ? 4 : 1;
  return null;
}

async function lotLocation(nb: Neighborhood, house: number, zone: Zone): Promise<{ x: number; y: number }> {
  const set = lotLocationSet(house, zone);
  if (set === null) return { x: 0, y: 0 };
  const lines =
    (await loadStrSet(`${nb.dir}/LotLocations.iff`, set, LANG_US_ENGLISH)) ??
    (await loadStrSet("GameData/LotLocations.iff", set, LANG_US_ENGLISH)) ??
    [];
  for (const line of lines) {
    const [h, x, y] = splitInts(line);
    if (line.split(",").length >= 3 && h === house) return { x: x!, y: y! };
  }
  return { x: 0, y: 0 };
}

/** GetHouseInfo(int, HouseInfo *, int) with images (third argument 1). */
export async function getHouseInfo(nb: Neighborhood, house: number): Promise<HouseInfo | null> {
  const file = await readIff(nb.getHousePath(house));
  if (!file) return null;
  const { data, chunks } = file;
  const chunk = (kind: string, ...ids: number[]): Uint8Array | null => {
    for (const id of ids) {
      const c = chunks.find((c) => c.kind === kind && c.id === id);
      if (c) return payload(data, c);
    }
    return null;
  };

  // The Unleashed screen wants the half-size bitmaps for zoned lots outside Magic Town's 90..99.
  const zone = nb.getZoningType(house);
  const wantSmall = (house < 0x5a || house > 0x63) && zone !== Zone.None;

  const bmp = async (...ids: number[]): Promise<ImageBitmap | null> => {
    const b = chunk("BMP_", ...ids);
    return b ? toBitmap(b) : null;
  };
  const thumb = await bmp(0x200, 0x264);
  const roof = await bmp(0x201, 0x265);
  let thumbSmall: ImageBitmap | null = null;
  let roofSmall: ImageBitmap | null = null;
  let hasSmall = false;
  if (wantSmall) {
    thumbSmall = await bmp(0x400, 0x464);
    if (thumbSmall) {
      hasSmall = true;
      roofSmall = await bmp(0x401, 0x465);
    }
  }
  if (!hasSmall) {
    thumbSmall = thumb ? await halve(thumb) : null;
    roofSmall = roof ? await halve(roof) : null;
  }

  const thmbBytes = chunk("THMB", 0x200, 0x264);
  const thmb = thmbBytes ? readThmb(thmbBytes) : null;
  const smallBytes = hasSmall ? chunk("THMB", 0x400, 0x464) : thmbBytes;
  let thmbSmall = smallBytes ? readThmb(smallBytes) : null;
  if (thmbSmall && !hasSmall) {
    thmbSmall = {
      x: Math.trunc(thmbSmall.x / 2),
      y: Math.trunc(thmbSmall.y / 2),
      z: Math.trunc(thmbSmall.z / 2),
      dx: Math.trunc(thmbSmall.dx / 2),
      dy: Math.trunc(thmbSmall.dy / 2),
    };
  }

  // Neighborhood::GetHouseFileInfo
  const simiBytes = chunk("SIMI", 1) ?? chunk("SIMI", chunks.find((c) => c.kind === "SIMI")?.id ?? -1);
  const sim = simiBytes ? readSimi(simiBytes) : null;
  const g = (i: number): number => sim?.globals[i] ?? 0;
  const value = sim
    ? Math.trunc(ARCHITECTURE_VALUE_MULTIPLIER * sim.architectureValue) + sim.lotValue + sim.objectsValue
    : 0;

  const family = nb.getFamilyInHouse(house);
  const { x: lotX, y: lotY } = await lotLocation(nb, house, zone);
  return {
    houseNumber: house,
    thumb,
    roof,
    thumbSmall,
    roofSmall,
    thmb,
    thmbSmall,
    isEmpty: g(26) === 0 && g(21) === 0,
    isTutorial: g(26) !== 0,
    hasHouse: g(22) !== 0,
    value,
    lotTypeFlags: g(37),
    familyNumber: family ? family.familyNumber : -1,
    familyName: family?.name ?? "",
    netWorth: family ? nb.getFamilyNetWorth(family) : 0,
    friends: family ? nb.getFamilyFriendsCount(family) : 0,
    lotX,
    lotY,
    noLargeThumb: hasSmall || !thumb,
  };
}

/** cTSLanguageUtility::MakeMoneyString (res/langutil.ts). */
export { makeMoneyString } from "../res/langutil.js";

/** localStorage key standing for the registry values SIMS_CURRENT_NEIGHBORHOOD_NUM / _PATH. */
const CURRENT_NBHD_KEY = "thesimsweb.currentNeighborhood";

/** The neighborhood directory SwitchToNewNeighborhood last stored ("UserData" by default). */
export function currentNeighborhoodDir(): string {
  try {
    const v = localStorage.getItem(CURRENT_NBHD_KEY);
    if (v && /^UserData\d*$/.test(v)) return v;
  } catch {
    // storage unavailable: the default neighborhood
  }
  return "UserData";
}

/** Neighborhood::SwitchToNewNeighborhood: the registry write. */
export function storeCurrentNeighborhoodDir(dir: string): void {
  try {
    localStorage.setItem(CURRENT_NBHD_KEY, dir);
  } catch {
    // not persisted
  }
}
