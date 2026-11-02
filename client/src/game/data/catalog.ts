/**
 * The buy mode object catalog (Catalog / Product / ObjSelector), built the way
 * the game builds it:
 *
 *  - ObjectFolder::AddAllSelectors opens every object file and makes one
 *    selector per OBJD chunk; AddSelector skips disabled ones (OBJD +0x20).
 *    Object files are the IFFs of GameData/Objects/Objects.far, the expansion
 *    archives (ExpansionShared, ExpansionPack*, Deluxe) and Downloads.
 *  - Catalog::Init keeps the selectors that are not multi-tile sub-objects
 *    (GetIsMultiTileSubObject), not people (ObjectType 2) and that have
 *    graphics or interactions, wraps each in a Product (Product::SetObject:
 *    CTSS name and description, OBJD price), then sorts by price and name
 *    (CatalogSortPred).
 *  - The catalog filters products with the OBJD sort fields: room flags
 *    (+0x4e), function flags (+0x50), function sub-sort (+0xbc) and the
 *    community sorts of the expansions (downtown +0xbe, vacation +0xc2,
 *    community +0xc6, studio town +0xce, magic town +0xd0).
 *  - CatalogResource::Load reads the name and description: a CATS resource
 *    with the catalog strings id when present, otherwise strings 1 and 2 of
 *    the CTSS StringSet with that id; an empty name becomes "*" + the OBJD
 *    chunk name (ObjSelector::GetCatalogName).
 *  - The thumbnail (Product::GenerateGraphics) is the object file's BMP_
 *    resource with the catalog strings id when it is 74x37 (normal and
 *    highlighted 37x37 icons side by side), else a render of the object
 *    (RenderCatalogShot, cpanel/buy/objecticon.ts) that the game writes back
 *    into the file. Without graphics the product shows kItemUnknown.
 *
 * OBJD offsets above are the game's in-memory record (version u32, then u16
 * fields): field index = (offset - 4) / 2.
 *
 * Object files are big (sprites); the scan only reads each file's header and
 * resource map (rsmp) and then the chunks it needs, with batched range reads.
 * The result is cached in IndexedDB, keyed by the archives' sizes; so are the
 * catalog icons' bytes (engine/assets.ts readAssetRangeCached).
 */

import { fetchManifest, readAssetRangeBatched, readAssetRangeCached, readFarManifest } from "../../engine/assets.js";
import { idbGetFarManifest, idbPutFarManifest } from "../../engine/idb.js";
import { engine } from "../../engine/wasm.js";
import { decodeImage } from "../res/bmp.js";
import { LANG_FRENCH } from "../res/uires.js";
import { ResFile } from "../world/iffres.js";

/** OBJD field indices (in-memory offset in the comment). */
export const OBJD = {
  numGraphics: 2, // +0x08
  baseGraphic: 1, // +0x06
  treeTableId: 5, // +0x0e
  objectType: 7, // +0x12
  masterId: 8, // +0x14
  subIndex: 9, // +0x16
  guidLo: 12,
  guidHi: 13,
  disabled: 14, // +0x20
  price: 16, // +0x24
  roomSort: 37, // +0x4e
  functionSort: 38, // +0x50
  catalogStringsId: 39, // +0x52
  frontDirection: 59, // +0x7a
  buildModeType: 67, // +0x8a
  thumbnailGraphic: 73, // +0x96
  shadowFlags: 74, // +0x98
  ratingHunger: 80, // +0xa4, then comfort, hygiene, bladder, energy, fun, room
  ratingSkillFlags: 87, // +0xb2
  functionSubSort: 92, // +0xbc
  downtownSort: 93, // +0xbe
  vacationSort: 95, // +0xc2
  communitySort: 97, // +0xc6
  studiotownSort: 101, // +0xce
  magictownSort: 102, // +0xd0
} as const;

const OBJECT_TYPE_PERSON = 2;
const CATALOG_ICON_W = 0x4a;
const CATALOG_ICON_H = 0x25;
/** Bumped when the cached record layout changes. */
const CACHE_KEY = "catalog:v2";

/** Where an object file lives: inside a FAR (far set) or loose under the game folder. */
export interface ObjectFileRef {
  /** FAR path relative to the game folder, or null for a loose file. */
  far: string | null;
  /** FAR entry name, or the loose path relative to the game folder. */
  entry: string;
  /** Absolute offset of the IFF in the served file (0 for loose files). */
  base: number;
}

/** A catalog product's data, as cached. */
export interface ProductRecord {
  file: ObjectFileRef;
  /** OBJD chunk id and label (the selector name). */
  objdId: number;
  label: string;
  /** The whole OBJD record, signed 16-bit fields. */
  fields: number[];
  name: string;
  description: string;
  /** BMP_ catalog icon chunk [absolute offset, chunk size], or null. */
  icon: [number, number] | null;
}

function signed16(v: number): number {
  return (v << 16) >> 16;
}

/** Product (object products; the build mode floor, wall and tool products are in data/buildcatalog.ts). */
export class Product {
  private iconPromise: Promise<ImageBitmap | null> | null = null;

  constructor(readonly rec: ProductRecord) {}

  field(i: number): number {
    return this.rec.fields[i] ?? 0;
  }

  get guid(): number {
    return ((this.field(OBJD.guidHi) & 0xffff) * 0x10000 + (this.field(OBJD.guidLo) & 0xffff)) >>> 0;
  }

  /** Product::GetPrice */
  getPrice(): number {
    return this.field(OBJD.price);
  }

  /** Product::GetProductName */
  getProductName(): string {
    return this.rec.name;
  }

  /** Product::GetDescription */
  getDescription(): string {
    return this.rec.description;
  }

  /** Product::CanAfford */
  canAfford(funds: number): boolean {
    return this.getPrice() <= funds;
  }

  /** ObjSelector::GetCatalogRating: 0..6 motive ratings, 7..13 skill flags. */
  getCatalogRating(i: number): number {
    if (i < 0 || i > 13) return 0;
    if (i < 7) return this.field(OBJD.ratingHunger + i);
    return (this.field(OBJD.ratingSkillFlags) >> (i - 7)) & 1;
  }

  hasRoomSort(): boolean {
    return this.field(OBJD.roomSort) !== 0;
  }

  testInRoom(mask: number): boolean {
    return (mask & this.field(OBJD.roomSort)) !== 0;
  }

  hasFunctionSort(): boolean {
    return this.field(OBJD.functionSort) !== 0;
  }

  /** Product::TestHasFunction(int) */
  testHasFunction(mask: number): boolean {
    return (mask & this.field(OBJD.functionSort)) !== 0;
  }

  /** Product::TestHasFunction(int, eFunctionSubSortMasks): 0xff also takes products without a sub-sort. */
  testHasFunctionSub(mask: number, subMask: number): boolean {
    if ((mask & this.field(OBJD.functionSort)) === 0) return false;
    const sub = this.field(OBJD.functionSubSort);
    return (subMask & sub) !== 0 || (subMask === 0xff && sub === 0);
  }

  hasFunctionSubsort(): boolean {
    return this.field(OBJD.functionSubSort) !== 0;
  }

  testHasSubFunction(mask: number): boolean {
    return (mask & this.field(OBJD.functionSubSort)) !== 0;
  }

  /** Has{Downtown,Vacation,Community,Studiotown,Magictown}Sort, by CatalogSort - 2. */
  hasCommunitySort(sort: number): boolean {
    return this.communityField(sort) !== 0;
  }

  /** TestIn{Downtown,...}Room. */
  testInCommunityRoom(sort: number, mask: number): boolean {
    return (mask & this.communityField(sort)) !== 0;
  }

  private communityField(sort: number): number {
    const f = [OBJD.downtownSort, OBJD.vacationSort, OBJD.communitySort, OBJD.studiotownSort, OBJD.magictownSort][sort - 2];
    return f === undefined ? 0 : this.field(f);
  }

  /** Product::SetObject: a one-frame button when the object has no sort at all. */
  hasAnySort(): boolean {
    return this.hasRoomSort() || this.hasFunctionSort() || this.field(OBJD.buildModeType) !== 0;
  }

  /** The 74x37 catalog icon (Product::GenerateGraphics), null when the file has none. */
  icon(): Promise<ImageBitmap | null> {
    this.iconPromise ??= loadIcon(this.rec);
    return this.iconPromise;
  }

  /** ObjSelector::GetHasGraphics */
  hasGraphics(): boolean {
    return this.field(OBJD.masterId) !== 0 || this.field(OBJD.numGraphics) !== 0;
  }

  /** The object product whose picture RenderCatalogShot renders (the product itself). */
  catalogObject(): Product {
    return this;
  }

  /** The whole object file (sprites for DrawDefaultObjectIcon, TTAB). */
  openFile(): Promise<ResFile> {
    const f = this.rec.file;
    return f.far ? ResFile.openInFar(f.far, f.entry) : ResFile.open(f.entry);
  }
}

async function loadIcon(rec: ProductRecord): Promise<ImageBitmap | null> {
  if (!rec.icon) return null;
  const [off, size] = rec.icon;
  const path = `Sims/${rec.file.far ?? rec.file.entry}`;
  const bytes = await readAssetRangeCached(path, off + 76, off + size).catch(() => null);
  if (!bytes) return null;
  try {
    const img = decodeImage(bytes, "catalog.bmp");
    if (img.width !== CATALOG_ICON_W || img.height !== CATALOG_ICON_H) return null;
    return await createImageBitmap(new ImageData(img.data, img.width, img.height));
  } catch {
    return null;
  }
}

/** CatalogSortPred: price, then name (data/buildcatalog.ts sorts the build mode products with it too). */
export function catalogSortPred(a: { getPrice(): number; getProductName(): string }, b: { getPrice(): number; getProductName(): string }): number {
  const pa = a.getPrice() >>> 0;
  const pb = b.getPrice() >>> 0;
  if (pa !== pb) return pa < pb ? -1 : 1;
  const na = a.getProductName().toLowerCase();
  const nb = b.getProductName().toLowerCase();
  return na < nb ? -1 : na > nb ? 1 : 0;
}

export class Catalog {
  constructor(readonly products: Product[]) {}
}

// --- scanning ------------------------------------------------------------------

interface RsmpEntry {
  kind: string;
  id: number;
  offset: number;
  size: number;
  label: string;
}

const HEAD_BYTES = 16384;
const latin1 = new TextDecoder("windows-1252");

/** The rsmp chunk (resource map, version 0 or 1), with sizes from the chunk headers' order. */
function parseRsmp(map: Uint8Array, fileSize: number): RsmpEntry[] {
  const v = new DataView(map.buffer, map.byteOffset, map.byteLength);
  const version = v.getUint32(4, true);
  const types = v.getUint32(16, true);
  let p = 20;
  const out: RsmpEntry[] = [];
  for (let t = 0; t < types && p + 8 <= map.length; t++) {
    const kind = String.fromCharCode(map[p + 3]!, map[p + 2]!, map[p + 1]!, map[p]!);
    const count = v.getUint32(p + 4, true);
    p += 8;
    for (let i = 0; i < count && p + 8 <= map.length; i++) {
      const offset = v.getUint32(p, true);
      p += 4;
      const id = version === 0 ? v.getUint16(p, true) : v.getUint32(p, true);
      p += version === 0 ? 2 : 4;
      p += 2; // flags
      let label: string;
      if (version === 0) {
        let e = p;
        while (e < map.length && map[e] !== 0) e++;
        label = latin1.decode(map.subarray(p, e));
        p = e + 1;
        if (p & 1) p++;
      } else {
        const n = map[p] ?? 0;
        label = latin1.decode(map.subarray(p + 1, p + 1 + n));
        p += 1 + n;
      }
      out.push({ kind, id, offset, size: 0, label });
    }
  }
  const offsets = [...new Set(out.map((e) => e.offset))].sort((a, b) => a - b);
  for (const e of out) {
    const next = offsets.find((o) => o > e.offset) ?? fileSize;
    e.size = next - e.offset;
  }
  return out;
}

/** One object file read through batched range reads (RangeBatcher). */
class RangedIff {
  private head: Uint8Array | null = null;

  constructor(
    readonly ref: ObjectFileRef,
    readonly size: number,
  ) {}

  private get path(): string {
    return `Sims/${this.ref.far ?? this.ref.entry}`;
  }

  async read(start: number, end: number): Promise<Uint8Array> {
    end = Math.min(end, this.size);
    const head = this.head;
    if (head && end <= head.length) return head.subarray(start, end);
    return readAssetRangeBatched(this.path, this.ref.base + start, this.ref.base + end);
  }

  async map(): Promise<RsmpEntry[] | null> {
    this.head = await readAssetRangeBatched(this.path, this.ref.base, this.ref.base + Math.min(this.size, HEAD_BYTES));
    if (this.head.length < 64) return null;
    const hv = new DataView(this.head.buffer, this.head.byteOffset, this.head.byteLength);
    const at = hv.getUint32(60, false);
    if (at === 0 || at + 76 > this.size) return null;
    const hdr = await this.read(at, at + 76);
    const size = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength).getUint32(4, false);
    const map = await this.read(at + 76, at + size);
    return parseRsmp(map, this.size);
  }

  /** Data of a chunk (without its 76-byte header). */
  async chunk(e: RsmpEntry): Promise<Uint8Array> {
    const hdr = await this.read(e.offset, e.offset + 76);
    const size = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength).getUint32(4, false);
    return this.read(e.offset + 76, e.offset + size);
  }
}

interface StrEntry {
  kind: "single" | "pair" | "lang";
  langCode?: number;
  data: Uint8Array;
}

/** StringSetMulti strings in the UI language (format -3 falls back to US English). */
async function stringSet(data: Uint8Array): Promise<string[]> {
  const wasm = await engine();
  const { entries } = wasm.parseStrTable(data) as { entries: StrEntry[] };
  const text = (e: StrEntry | undefined): string => (e ? latin1.decode(e.data) : "");
  if (!entries.some((e) => e.kind === "lang")) return entries.map((e) => text(e));
  const ours = entries.filter((e) => e.langCode === LANG_FRENCH);
  const us = entries.filter((e) => e.langCode === 1);
  const n = Math.max(ours.length, us.length);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(text(ours[i]?.data.length ? ours[i] : us[i]));
  return out;
}

/** CatalogResource::Load: CATS ("description\0name") or CTSS strings 1 and 2. */
async function catalogStrings(file: RangedIff, map: RsmpEntry[], id: number): Promise<[string, string]> {
  const cats = map.find((e) => e.kind === "CATS" && e.id === id);
  if (cats) {
    const b = await file.chunk(cats);
    let z = b.indexOf(0);
    if (z < 0) z = b.length;
    const desc = latin1.decode(b.subarray(0, z));
    let z2 = b.indexOf(0, z + 1);
    if (z2 < 0) z2 = b.length;
    return [z + 1 < b.length ? latin1.decode(b.subarray(z + 1, z2)) : "", desc];
  }
  const ctss = map.find((e) => e.kind === "CTSS" && e.id === id);
  if (!ctss) return ["", ""];
  const s = await stringSet(await file.chunk(ctss)).catch(() => []);
  return [s[0] ?? "", s[1] ?? ""];
}

/** The products of one object file (ObjectFolder::AddAllSelectors + Catalog::Init filter). */
async function scanFile(ref: ObjectFileRef, size: number): Promise<ProductRecord[]> {
  const file = new RangedIff(ref, size);
  const map = await file.map().catch(() => null);
  if (!map) return [];
  const wasm = await engine();
  const out: ProductRecord[] = [];
  for (const e of map.filter((m) => m.kind === "OBJD").sort((a, b) => a.id - b.id)) {
    const data = await file.chunk(e).catch(() => null);
    if (!data) continue;
    let raw: number[];
    try {
      raw = (wasm.parseObjd(data) as { fields: number[] }).fields;
    } catch {
      continue;
    }
    const fields = raw.map(signed16);
    const f = (i: number): number => fields[i] ?? 0;
    if (f(OBJD.disabled) !== 0) continue;
    // GetIsMultiTileSubObject, GetIsPerson.
    if (f(OBJD.masterId) !== 0 && f(OBJD.subIndex) !== -1) continue;
    if (f(OBJD.objectType) === OBJECT_TYPE_PERSON) continue;
    // GetHasGraphics || GetHasInteractions (a tree table to look interactions up in).
    const hasGraphics = f(OBJD.masterId) !== 0 || f(OBJD.numGraphics) !== 0;
    if (!hasGraphics && !map.some((m) => m.kind === "TTAB" && m.id === f(OBJD.treeTableId))) continue;
    // Objects without any catalog sort (buy mode) or build mode type (build mode) never show.
    const sorts = [OBJD.roomSort, OBJD.functionSort, OBJD.downtownSort, OBJD.vacationSort, OBJD.communitySort, OBJD.studiotownSort, OBJD.magictownSort, OBJD.buildModeType];
    if (!sorts.some((i) => f(i) !== 0)) continue;
    const id = f(OBJD.catalogStringsId);
    let [name, description] = await catalogStrings(file, map, id);
    if (!name) name = `*${e.label}`;
    const bmp = map.find((m) => m.kind === "BMP_" && m.id === id);
    out.push({
      file: ref,
      objdId: e.id,
      label: e.label,
      fields,
      name,
      description,
      icon: bmp ? [ref.base + bmp.offset, bmp.size] : null,
    });
  }
  return out;
}

const OBJECT_ARCHIVE = /^(gamedata\/objects\/[^/]+\.far|expansionshared\/expansionshared\.far|expansionpack\d*\/expansionpack\d*\.far|deluxe\/deluxe\.far|downloads\/.+\.far)$/;
const LOOSE_OBJECT = /^(gamedata\/objects|downloads)\/.+\.iff$/;

/** Every object file the folder scan would open, in scan order. */
async function objectFiles(): Promise<{ files: Array<{ ref: ObjectFileRef; size: number }>; signature: string }> {
  const m = await fetchManifest();
  const files: Array<{ ref: ObjectFileRef; size: number }> = [];
  const sig: string[] = [];
  const fars: string[] = [];
  for (const f of m.files) {
    if (!f.path.startsWith("Sims/")) continue;
    const rel = f.path.slice(5);
    const lower = rel.toLowerCase();
    if (OBJECT_ARCHIVE.test(lower)) {
      fars.push(rel);
      sig.push(`${rel}:${f.size}`);
    } else if (LOOSE_OBJECT.test(lower)) {
      files.push({ ref: { far: null, entry: rel, base: 0 }, size: f.size });
      sig.push(`${rel}:${f.size}`);
    }
  }
  const lists = await Promise.all(fars.map((far) => readFarManifest(`Sims/${far}`).then((e) => ({ far, e })).catch(() => null)));
  for (const l of lists) {
    if (!l) continue;
    for (const e of l.e) {
      if (!e.filename.toLowerCase().endsWith(".iff")) continue;
      files.push({ ref: { far: l.far, entry: e.filename, base: e.offset }, size: e.sizeCompressed });
    }
  }
  return { files, signature: sig.sort().join("|") };
}

/** Object files scanned at once (results keep the scan order). */
const SCAN_CONCURRENCY = 64;

async function scanAll(): Promise<ProductRecord[]> {
  const { files, signature } = await objectFiles();
  const cached = (await idbGetFarManifest(CACHE_KEY).catch(() => null)) as { signature: string; records: ProductRecord[] } | null;
  if (cached && cached.signature === signature && Array.isArray(cached.records)) return cached.records;
  const results: ProductRecord[][] = new Array(files.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const i = next++;
      const f = files[i]!;
      results[i] = await scanFile(f.ref, f.size).catch(() => []);
    }
  };
  // The reads of all files in flight go out together (one batch per round trip).
  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
  const records = results.flat();
  void idbPutFarManifest(CACHE_KEY, { signature, records });
  return records;
}

let catalog: Promise<Catalog> | null = null;

/** CPState::GetCatalog: built once, on first use. */
export function loadCatalog(): Promise<Catalog> {
  catalog ??= scanAll().then((records) => {
    const products = records.map((r) => new Product(r));
    if (products.length > 2) products.sort(catalogSortPred);
    return new Catalog(products);
  });
  return catalog;
}

/** Objects of the same file sharing a master id (multi-tile parts), for icon rendering. */
export async function readObjdTable(file: ResFile): Promise<Array<{ id: number; fields: number[] }>> {
  const wasm = await engine();
  const out: Array<{ id: number; fields: number[] }> = [];
  for (const c of file.list("OBJD")) {
    try {
      const raw = (wasm.parseObjd(file.payload(c)) as { fields: number[] }).fields;
      out.push({ id: c.id, fields: raw.map(signed16) });
    } catch {
      // Unreadable definitions are skipped like the game skips unknown versions.
    }
  }
  return out;
}
