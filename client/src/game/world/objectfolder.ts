/**
 * ObjectFolder: every object definition the game knows, keyed by GUID
 * (ObjectFolder::ScanForNewFiles -> FolderScanner -> NewFileAdded ->
 * AddAllSelectors -> AddSelector), plus the house file's saved type table
 * (ObjectSaveTypeTable, chunk "objt") and GUIDTranslation ("Gtab").
 *
 * Scan order (ScanForNewFiles; later files win, AddSelector's
 * hash_map::find_or_insert overwrites), with the source flag AddSelector keeps:
 *   GameData/Objects/ 0, GameData/UserObjects/ 3, <neighborhood>/Characters/ 1
 *   (ObjectFolder::SetUserPath from Neighborhood load), Downloads/ 2,
 *   ExpansionPack/ 4, ExpansionPack2/ 8, ExpansionPack3/ 0x10,
 *   ExpansionPack4/ 0x20, Deluxe/ 0x40, ExpansionPack5/ 0x80,
 *   ExpansionPack6/ 0x100, ExpansionShared/ 0x200 and TemplateNPCs/ 0x400
 *   (when the installed-pack mask > 3), ExpansionPack7/ 0x800.
 * Each expansion folder is only scanned when its pack is installed (app +0x66
 * bit 1, 2, 4, 8, 0x10 Deluxe, 0x20, 0x40, 0x80; here: present in the asset
 * manifest). Windows maps a folder's FAR archives as directory images
 * (CTGFileManager::AddDirectoryImage), so the .iff entries of every .far
 * under a source folder are scanned like loose .iff files.
 *
 * AddSelector skips disabled definitions (OBJD +0x20, ObjectFolder::Init is
 * called with "skip disabled" = 1). Reading every OBJD of ~1400 files is what
 * the game does at start-up; here only the OBJD chunks are fetched (IFF
 * header -> rsmp resource map -> OBJD chunks, by HTTP Range) and the resulting
 * GUID -> (file, OBJD id) index is cached in IndexedDB. Object files are only
 * opened (ResFile) when one of their GUIDs is requested; all selectors of the
 * file are then built at once, which is what ObjSelector::TestFromSameFile
 * based lookups (master / sub-tile selectors) need.
 */

import { fetchManifest, readFarManifest, type FarEntryInfo } from "../../engine/assets.js";
import { idbGetFarManifest, idbPutFarManifest } from "../../engine/idb.js";
import { engine } from "../../engine/wasm.js";
import { ResFile } from "./iffres.js";
import { getSubIndex, ObjDefinition, ObjSelector, type SelectorFolder } from "./objselector.js";
import { ReconBuffer } from "./reconbuffer.js";

/** Placeholder GUIDs (ObjectFolder::Get*Placeholder). */
export const GUID_STANDARD_PLACEHOLDER = 0x3c08965f;
export const GUID_PERSON_PLACEHOLDER = 0x7fd96b54;
export const GUID_DOG_PLACEHOLDER = 0x4a70df92;
export const GUID_CAT_PLACEHOLDER = 0x7bea0977;

/** Installed-pack bit of ExpansionPack5 (pets): distinct dog / cat placeholders. */
const PACK_UNLEASHED = 0x20;

interface Source {
  dir: string;
  /** Source flag passed to AddSelector. */
  flag: number;
  /** Installed-pack bit required (0 = always), or -1 for "mask > 3". */
  pack: number;
}

function sources(userDir: string): Source[] {
  return [
    { dir: "GameData/Objects/", flag: 0, pack: 0 },
    { dir: "GameData/UserObjects/", flag: 3, pack: 0 },
    { dir: `${userDir}/Characters/`, flag: 1, pack: 0 },
    { dir: "Downloads/", flag: 2, pack: 0 },
    { dir: "ExpansionPack/", flag: 4, pack: 0x1 },
    { dir: "ExpansionPack2/", flag: 8, pack: 0x2 },
    { dir: "ExpansionPack3/", flag: 0x10, pack: 0x4 },
    { dir: "ExpansionPack4/", flag: 0x20, pack: 0x8 },
    { dir: "Deluxe/", flag: 0x40, pack: 0x10 },
    { dir: "ExpansionPack5/", flag: 0x80, pack: 0x20 },
    { dir: "ExpansionPack6/", flag: 0x100, pack: 0x40 },
    { dir: "ExpansionShared/", flag: 0x200, pack: -1 },
    { dir: "TemplateNPCs/", flag: 0x400, pack: -1 },
    { dir: "ExpansionPack7/", flag: 0x800, pack: 0x80 },
  ];
}

/** Pack folders that define the installed-pack mask (bit i = PACK_DIRS[i]). */
const PACK_DIRS = ["ExpansionPack/", "ExpansionPack2/", "ExpansionPack3/", "ExpansionPack4/", "Deluxe/", "ExpansionPack5/", "ExpansionPack6/", "ExpansionPack7/"];

/** Scanned index, as cached. */
interface FolderIndex {
  stamp: string;
  packs: number;
  /** [file key, source flag]; key = "far|entry" or a loose path, relative to the game folder. */
  files: Array<[string, number]>;
  /** [guid, file index, OBJD chunk id], in AddSelector order. */
  objds: Array<[number, number, number]>;
}

const INDEX_VERSION = 1;
const ASSETS_BASE = "/assets/";
const IFF_HEADER = 64;
const CHUNK_HEADER = 76;
const OBJD_SIZE = 0xd8;
const SCAN_CONCURRENCY = 12;

async function fetchRange(path: string, start: number, end: number): Promise<Uint8Array> {
  const res = await fetch(`${ASSETS_BASE}${path}`, { headers: { Range: `bytes=${start}-${end - 1}` } });
  if (res.status !== 206 && res.status !== 200) throw new Error(`${path} ${start}-${end}: ${res.status}`);
  const b = new Uint8Array(await res.arrayBuffer());
  // A server ignoring Range answers 200 with the whole file.
  return res.status === 200 ? b.subarray(start, end) : b;
}

async function pool<T>(items: readonly T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

/** FNV-1a over the scanned file list, to invalidate the cached index. */
function stampOf(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return `${INDEX_VERSION}:${s.length}:${(h >>> 0).toString(16)}`;
}

/**
 * The OBJD chunks of one IFF read through its resource map (rsmp, version 0:
 * per type a reversed four-character code, a count, then offset u32, id u16,
 * flags u16 and an even-padded C-string label per chunk).
 */
async function readObjdChunks(path: string, base: number, size: number): Promise<Array<{ id: number; objd: Uint8Array }>> {
  const head = await fetchRange(path, base, base + IFF_HEADER);
  const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const rsmp = hv.getUint32(60, false);
  if (rsmp === 0 || rsmp + CHUNK_HEADER > size) return readObjdChunksByWalk(path, base, size);
  const rh = await fetchRange(path, base + rsmp, base + rsmp + CHUNK_HEADER);
  if (String.fromCharCode(...rh.subarray(0, 4)) !== "rsmp") return readObjdChunksByWalk(path, base, size);
  const rsize = new DataView(rh.buffer, rh.byteOffset, rh.byteLength).getUint32(4, false);
  const map = await fetchRange(path, base + rsmp + CHUNK_HEADER, base + rsmp + rsize);
  const mv = new DataView(map.buffer, map.byteOffset, map.byteLength);
  if (mv.getUint32(4, true) !== 0) return readObjdChunksByWalk(path, base, size);
  const offsets: number[] = [];
  let p = 20;
  const nTypes = mv.getUint32(16, true);
  for (let t = 0; t < nTypes; t++) {
    const code = String.fromCharCode(map[p + 3]!, map[p + 2]!, map[p + 1]!, map[p]!);
    const n = mv.getUint32(p + 4, true);
    p += 8;
    for (let i = 0; i < n; i++) {
      if (code === "OBJD") offsets.push(mv.getUint32(p, true));
      p += 8;
      while (map[p] !== 0) p++;
      p++;
      if (p & 1) p++;
    }
  }
  if (offsets.length === 0) return [];
  const lo = Math.min(...offsets);
  const hi = Math.min(size, Math.max(...offsets) + CHUNK_HEADER + OBJD_SIZE);
  const span = await fetchRange(path, base + lo, base + hi);
  const out: Array<{ id: number; objd: Uint8Array }> = [];
  for (const off of offsets) {
    const o = off - lo;
    const cv = new DataView(span.buffer, span.byteOffset + o, CHUNK_HEADER);
    const csize = cv.getUint32(4, false);
    out.push({ id: cv.getInt16(8, false), objd: span.subarray(o + CHUNK_HEADER, Math.min(span.length, o + csize)) });
  }
  return out;
}

/** Fallback for IFFs without a resource map: read the whole file and walk its chunks. */
async function readObjdChunksByWalk(path: string, base: number, size: number): Promise<Array<{ id: number; objd: Uint8Array }>> {
  const data = await fetchRange(path, base, base + size);
  const wasm = await engine();
  const res = new ResFile(path, data, wasm.parseIffChunks(data) as ResFile["chunks"]);
  return res.list("OBJD").map((c) => ({ id: c.id, objd: res.payload(c) }));
}

/** MissingObject: a saved type whose GUID no longer resolves (ObjectSaveTypeTable). */
export interface MissingObject {
  /** +0: catalog name saved with the type. */
  name: string;
  /** +4 */
  guid: number;
  /** +8: OBJD +0x8c of the saved definition. */
  originalGuid: number;
  /** +0xc: OBJD object type. */
  objectType: number;
  /** +0x10: saved type index. */
  index: number;
}

/** One record of the "objt" chunk. */
export interface SavedType {
  guid: number;
  initTreeVersion: number;
  mainTreeVersion: number;
  index: number;
  objectType: number;
  name: string;
  originalGuid: number;
}

/** ObjectSaveTypeTable::DoStream (read). */
export function readObjectSaveTypeTable(payload: Uint8Array, translation: GUIDTranslation): SavedType[] {
  const { buf, version } = ReconBuffer.fromChunk(payload);
  const out: SavedType[] = [];
  for (let guid = buf.recon32() >>> 0; guid !== 0; guid = buf.recon32() >>> 0) {
    let initTreeVersion = 0;
    let mainTreeVersion = 0;
    if (version > 0) {
      initTreeVersion = buf.recon32();
      mainTreeVersion = buf.recon32();
    }
    const index = buf.recon16();
    const objectType = version < 2 ? -1 : buf.recon16();
    const name = buf.reconString();
    const originalGuid = version < 3 ? 0 : buf.recon32() >>> 0;
    out.push({ guid: translation.findNewGUID(guid), initTreeVersion, mainTreeVersion, index, objectType, name, originalGuid });
  }
  return out;
}

/** GUIDTranslation ("Gtab" chunk 1): old -> new GUID pairs. */
export class GUIDTranslation {
  constructor(readonly pairs: ReadonlyArray<readonly [number, number]> = []) {}

  /** GUIDTranslation::Load: ReconLoadVector<GUIDPair>. */
  static load(house: ResFile): GUIDTranslation {
    const payload = house.get("Gtab", 1);
    if (!payload) return new GUIDTranslation();
    const { buf } = ReconBuffer.fromChunk(payload);
    const pairs: Array<[number, number]> = [];
    const n = buf.recon32();
    for (let i = 0; i < n; i++) pairs.push([buf.recon32() >>> 0, buf.recon32() >>> 0]);
    return new GUIDTranslation(pairs);
  }

  /** GUIDTranslation::FindNewGUID: follow the chain, each pair used at most once. */
  findNewGUID(guid: number): number {
    const used = new Array<boolean>(this.pairs.length).fill(false);
    for (;;) {
      const i = this.pairs.findIndex((p, k) => !used[k] && p[0] === guid);
      if (i < 0) return guid;
      used[i] = true;
      guid = this.pairs[i]![1];
    }
  }
}

/** The house's saved types resolved against the folder (PrepareForModuleLoad). */
export interface SaveTypeTable {
  /** Saved type index -> selector (the folder's +0x1278 index -> GUID vector). */
  selectors: Map<number, ObjSelector>;
  /** Saved types whose GUID is not installed. */
  missing: Map<number, MissingObject>;
  /**
   * Saved type index -> the init / main cumulative tree versions saved with
   * the type (ObjectSaveTypeTable::DoStream, stream version > 0; null for
   * version 0 tables, which saved none).
   */
  treeVersions: Map<number, { init: number; main: number } | null>;
}

export class ObjectFolder implements SelectorFolder {
  private static readonly folders = new Map<string, Promise<ObjectFolder>>();

  private readonly byGuid = new Map<number, [file: number, objdId: number, index: number]>();
  private readonly opened = new Map<number, Promise<ObjSelector[]>>();
  private readonly selectors = new Map<number, ObjSelector>();
  private readonly byFile = new Map<string, ObjSelector[]>();

  private constructor(
    /** Neighborhood folder whose Characters/ are scanned ("UserData", "UserData2"...). */
    readonly userDir: string,
    private readonly index: FolderIndex,
  ) {
    index.objds.forEach(([guid, file, objdId], i) => this.byGuid.set(guid, [file, objdId, i]));
  }

  /** Installed-pack mask (app +0x66). */
  get packs(): number {
    return this.index.packs;
  }

  /** The folder for a neighborhood (scanned once, then cached). */
  static get(userDir = "UserData"): Promise<ObjectFolder> {
    let f = ObjectFolder.folders.get(userDir);
    if (!f) {
      f = ObjectFolder.scan(userDir).then((index) => new ObjectFolder(userDir, index));
      ObjectFolder.folders.set(userDir, f);
    }
    return f;
  }

  /** ScanForNewFiles over the asset manifest. */
  private static async scan(userDir: string): Promise<FolderIndex> {
    const manifest = await fetchManifest();
    const all = manifest.files
      .filter((f) => f.path.startsWith("Sims/"))
      .map((f) => ({ rel: f.path.slice(5), lower: f.path.slice(5).toLowerCase(), size: f.size }))
      .sort((a, b) => (a.lower < b.lower ? -1 : a.lower > b.lower ? 1 : 0));
    let packs = 0;
    PACK_DIRS.forEach((d, i) => {
      if (all.some((f) => f.lower.startsWith(d.toLowerCase()))) packs |= 1 << i;
    });
    const scanned: Array<{ rel: string; lower: string; size: number; flag: number }> = [];
    for (const s of sources(userDir)) {
      if (s.pack === -1 ? packs <= 3 : s.pack !== 0 && !(packs & s.pack)) continue;
      const dir = s.dir.toLowerCase();
      for (const f of all) {
        if (f.lower.startsWith(dir) && (f.lower.endsWith(".iff") || f.lower.endsWith(".far"))) scanned.push({ ...f, flag: s.flag });
      }
    }
    const stamp = stampOf(scanned.map((f) => `${f.rel}:${f.size}`).join("|"));
    const cacheKey = `@ObjectFolder/${userDir}`;
    const cached = (await idbGetFarManifest(cacheKey)) as FolderIndex | null;
    if (cached && cached.stamp === stamp) return cached;

    // Every IFF (loose or inside a FAR) in scan order, then their OBJDs in parallel.
    const iffs: Array<{ key: string; path: string; base: number; size: number; flag: number }> = [];
    for (const f of scanned) {
      if (f.lower.endsWith(".iff")) {
        iffs.push({ key: f.rel, path: `Sims/${f.rel}`, base: 0, size: f.size, flag: f.flag });
        continue;
      }
      let entries: FarEntryInfo[];
      try {
        entries = await readFarManifest(`Sims/${f.rel}`);
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.filename.toLowerCase().endsWith(".iff")) continue;
        iffs.push({ key: `${f.rel}|${e.filename}`, path: `Sims/${f.rel}`, base: e.offset, size: e.sizeCompressed, flag: f.flag });
      }
    }
    const found = new Map<string, Array<{ id: number; objd: Uint8Array }>>();
    await pool(iffs, SCAN_CONCURRENCY, async (f) => {
      try {
        found.set(f.key, await readObjdChunks(f.path, f.base, f.size));
      } catch (e) {
        console.warn(`ObjectFolder: ${f.key}:`, e);
      }
    });
    const index: FolderIndex = { stamp, packs, files: [], objds: [] };
    for (const f of iffs) {
      const objds = found.get(f.key);
      if (!objds?.length) continue;
      const fi = index.files.push([f.key, f.flag]) - 1;
      for (const { id, objd } of objds) {
        const def = new ObjDefinition(objd);
        if (def.disabled !== 0) continue;
        index.objds.push([def.guid, fi, id]);
      }
    }
    void idbPutFarManifest(cacheKey, index);
    return index;
  }

  /** Open an object file and build all its selectors (AddAllSelectors). */
  private openFile(fi: number): Promise<ObjSelector[]> {
    let p = this.opened.get(fi);
    if (!p) {
      p = (async () => {
        const [key, flag] = this.index.files[fi]!;
        const bar = key.indexOf("|");
        const res = bar < 0 ? await ResFile.open(key) : await ResFile.openInFar(key.slice(0, bar), key.slice(bar + 1));
        const glob = res.list("GLOB")[0];
        const semiGlobal = glob ? readGlobName(res.payload(glob)) : "";
        const list: ObjSelector[] = [];
        for (const c of res.list("OBJD")) {
          const objd = new ObjDefinition(res.payload(c));
          if (objd.disabled !== 0) continue;
          const entry = this.byGuid.get(objd.guid);
          // Only the definition the scan kept for this GUID (a later file overrides).
          if (!entry || entry[0] !== fi || entry[1] !== c.id) continue;
          const sel = new ObjSelector(this, res, key, c.id, objd, c.label, entry[2], flag & 3, semiGlobal);
          this.selectors.set(objd.guid, sel);
          list.push(sel);
        }
        this.byFile.set(key, list);
        return list;
      })();
      this.opened.set(fi, p);
    }
    return p;
  }

  /** ObjectFolder::GetSelectorByGUID (opens the object's file on first use). */
  async getSelectorByGUID(guid: number): Promise<ObjSelector | null> {
    const entry = this.byGuid.get(guid >>> 0);
    if (!entry) return null;
    await this.openFile(entry[0]);
    return this.selectors.get(guid >>> 0) ?? null;
  }

  /** Synchronous lookup of an already opened selector. */
  selectorByGUID(guid: number): ObjSelector | null {
    return this.selectors.get(guid >>> 0) ?? null;
  }

  /** ObjectFolder::GetStandardPlaceholder etc. (dog / cat fall back to standard without the pets pack). */
  async getPlaceholders(): Promise<{ standard: ObjSelector | null; person: ObjSelector | null; dog: ObjSelector | null; cat: ObjSelector | null }> {
    const standard = await this.getSelectorByGUID(GUID_STANDARD_PLACEHOLDER);
    const person = await this.getSelectorByGUID(GUID_PERSON_PLACEHOLDER);
    const pets = (this.packs & PACK_UNLEASHED) !== 0;
    const dog = pets ? await this.getSelectorByGUID(GUID_DOG_PLACEHOLDER) : standard;
    const cat = pets ? await this.getSelectorByGUID(GUID_CAT_PLACEHOLDER) : standard;
    return { standard, person, dog, cat };
  }

  /** ObjectFolder::GetMasterSelector: the same file's definition with the master id and sub index -1. */
  getMasterSelector(sel: ObjSelector): ObjSelector | null {
    const master = sel.objd.masterId;
    if (master === 0) return sel;
    for (const s of this.byFile.get(sel.fileKey) ?? []) {
      if (s.objd.masterId === master && s.objd.subIndex === -1) return s;
    }
    return null;
  }

  /**
   * ObjectFolder::GetLeadSelector: the same file's definition of the master
   * with an "mt lead object" (OBJD +0x7e), else its sub-tile (0, 0) on level 0.
   */
  getLeadSelector(sel: ObjSelector): ObjSelector | null {
    const master = sel.objd.masterId;
    if (master === 0) return null;
    for (const s of this.byFile.get(sel.fileKey) ?? []) {
      if (s.objd.masterId === master && s.objd.mtLeadObject !== 0) return s;
    }
    return this.getSubTileSelector(sel, 0, 0, 0);
  }

  /** ObjectFolder::GetNthSubSelector: the n-th part definition (sub index != -1) of the master, in file order. */
  getNthSubSelector(sel: ObjSelector, n: number): ObjSelector | null {
    const master = sel.objd.masterId;
    if (master === 0) return null;
    let k = n;
    for (const s of this.byFile.get(sel.fileKey) ?? []) {
      if (s.objd.masterId !== master || s.objd.subIndex === -1) continue;
      if (k === 0) return s;
      k--;
    }
    return null;
  }

  /** ObjectFolder::GetSubTileSelector. */
  getSubTileSelector(sel: ObjSelector, x: number, y: number, level: number): ObjSelector | null {
    if (x < 0 || y < 0) return null;
    const sub = getSubIndex(x, y);
    const master = sel.objd.masterId;
    if (master === 0) return null;
    for (const s of this.byFile.get(sel.fileKey) ?? []) {
      if (s.objd.masterId === master && s.objd.subIndex === sub && s.objd.levelOffset === level) return s;
    }
    return null;
  }

  /**
   * ObjectFolder::PrepareForModuleLoad: read the house's "objt" table and map
   * each saved type index to the installed selector of its GUID. (The game
   * also flags types whose saved init / main tree versions differ from the
   * installed BHAVs, +0xb4 bit 1, so that cXObject::PostLoad resets those
   * objects by running their trees; that needs the SimAntics VM.)
   */
  async prepareForModuleLoad(house: ResFile): Promise<SaveTypeTable> {
    const table: SaveTypeTable = { selectors: new Map(), missing: new Map(), treeVersions: new Map() };
    const objt = house.get("objt", 0);
    if (!objt) return table;
    const types = readObjectSaveTypeTable(objt, GUIDTranslation.load(house));
    const versioned = ReconBuffer.fromChunk(objt).version > 0;
    const sels = await Promise.all(types.map((t) => this.getSelectorByGUID(t.guid)));
    types.forEach((t, i) => {
      const sel = sels[i] ?? null;
      if (!sel) {
        table.missing.set(t.index, { name: t.name, guid: t.guid, originalGuid: t.originalGuid, objectType: t.objectType, index: t.index });
        return;
      }
      table.selectors.set(t.index, sel);
      table.treeVersions.set(t.index, versioned ? { init: t.initTreeVersion, main: t.mainTreeVersion } : null);
    });
    return table;
  }
}

/** GLOB chunk: the semi-global file name, Pascal or C string (AddSelector). */
function readGlobName(b: Uint8Array): string {
  if (b.length > 0 && b[b.length - 1] === 0) {
    const end = b.indexOf(0);
    return String.fromCharCode(...b.subarray(0, end));
  }
  return String.fromCharCode(...b.subarray(1, 1 + (b[0] ?? 0)));
}
