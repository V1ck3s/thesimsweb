/**
 * Streaming asset client.
 *
 * Talks to the dev server (`/api/manifest`, `/assets/*` with `Range`) and uses the WASM
 * parsers to pull individual entries out of FAR archives without downloading the whole
 * archive. Recently read entries are kept in memory by `(farPath, entryName)` (bounded, see entryCache).
 *
 * Game-folder data read here (FAR tables and entries, whole files, byte
 * ranges) is also kept in IndexedDB (engine/idb.ts), so a reload does not
 * download it again. Files the game writes (Sims/UserData*, served from the
 * save overlay) change: they are never stored, only read once per load (the
 * save-file cache below). When the instance keeps saves in the browser (engine/saves.ts, "client"
 * mode), a file saved here is read from the saves database instead, and the
 * manifest lists it over the server's files.
 *
 * When the instance serves no game file (GAME_FILES=client, engine/config.ts)
 * every read is answered from the game files the player imported into this
 * browser (engine/gamefiles.ts) instead of /assets/, /api/manifest and
 * /api/ranges: nothing goes to the server, and the IndexedDB asset cache is
 * not used (it would only copy what is stored already).
 */

import { engine } from "./wasm.js";
import {
  idbGetFarEntry,
  idbGetFarManifest,
  idbGetIffFile,
  idbGetRange,
  idbPutFarEntry,
  idbPutFarManifest,
  idbPutIffFile,
  idbPutRange,
} from "./idb.js";
import { getSaveMode, isLocalSave, isSavePath, localSaveList, localSaveRead } from "./saves.js";
import { isGameFilesLocal, localGameBlob, localGameIndex, localGameRange, localGameRead, localGameSize } from "./gamefiles.js";

export interface ManifestFile {
  path: string;
  size: number;
  kind: "far" | "iff" | "other";
}

export interface Manifest {
  version: number;
  assetsRoot: string;
  files: ManifestFile[];
}

export interface FarEntryInfo {
  filename: string;
  sizeDecompressed: number;
  sizeCompressed: number;
  offset: number;
}

const FAR_HEADER_SIZE = 16;
const ASSETS_BASE = "/assets/";

const farManifestCache = new Map<string, Promise<FarEntryInfo[]>>();
/** FAR entry reads in flight (concurrent readers share one read). */
const entryReads = new Map<string, Promise<Uint8Array>>();
/**
 * FAR entries already read, least recently used first, kept up to
 * ENTRY_CACHE_BYTES. Most consumers keep their own parsed form (animations,
 * meshes, textures, sounds, fonts, object files), so keeping every raw entry
 * for the page's life only grew the heap (15..16 MB per sim day); an entry
 * dropped here is read again from IndexedDB.
 */
const entryCache = new Map<string, Uint8Array>();
let entryCacheBytes = 0;
const ENTRY_CACHE_BYTES = 16 * 1024 * 1024;

function keepEntry(key: string, bytes: Uint8Array): void {
  if (bytes.byteLength > ENTRY_CACHE_BYTES / 4) return;
  entryCache.set(key, bytes);
  entryCacheBytes += bytes.byteLength;
  for (const [k, b] of entryCache) {
    if (entryCacheBytes <= ENTRY_CACHE_BYTES) break;
    entryCache.delete(k);
    entryCacheBytes -= b.byteLength;
  }
}

let manifest: Promise<Manifest> | null = null;

/**
 * The asset manifest, fetched once per page (it lists ~10 000 files, 1.5 MB)
 * and fetched again after invalidateManifest (data/files.ts calls it after
 * every write or delete of a game file). Callers must not mutate it.
 */
export function fetchManifest(): Promise<Manifest> {
  if (!manifest) {
    const p = (async () => {
      let m: Manifest;
      if (await isGameFilesLocal()) {
        const files = await localGameIndex();
        if (!files) throw new Error("the game files are not imported in this browser");
        m = { version: 1, assetsRoot: ASSETS_BASE, files: files.map((f) => ({ path: f.path, size: f.size, kind: kindOf(f.path) })) };
      } else {
        const res = await fetch("/api/manifest", { cache: "no-store" });
        if (!res.ok) throw new Error(`manifest ${res.status}`);
        m = (await res.json()) as Manifest;
      }
      if ((await getSaveMode()) === "client") {
        // Files saved in this browser replace or add to the server's (as the overlay does there).
        const saved = await localSaveList();
        if (saved.length) {
          const byPath = new Map(m.files.map((f) => [f.path.toLowerCase(), f]));
          for (const f of saved) {
            byPath.set(f.path.toLowerCase(), { path: byPath.get(f.path.toLowerCase())?.path ?? f.path, size: f.size, kind: kindOf(f.path) });
          }
          m.files = [...byPath.values()];
        }
      }
      return m;
    })();
    manifest = p;
    p.then(
      (m) => {
        if (manifest === p) resolvedManifest = m;
      },
      () => {
        if (manifest === p) manifest = null;
      },
    );
  }
  return manifest;
}

function kindOf(path: string): ManifestFile["kind"] {
  const lower = path.toLowerCase();
  return lower.endsWith(".far") ? "far" : lower.endsWith(".iff") ? "iff" : "other";
}

/** The next fetchManifest asks the server again (the game files changed). */
export function invalidateManifest(): void {
  manifest = null;
  resolvedManifest = null;
}

/** The manifest fetchManifest last returned, once it arrived (null before, or after invalidateManifest). */
let resolvedManifest: Manifest | null = null;

/** Whether `path` (relative to /assets/) is a file the game can write (Sims/UserData*), never stored across loads. */
export function isWritableAssetPath(path: string): boolean {
  return isSavePath(path);
}

/** The copy of a save file kept in this browser, in client save mode (null otherwise). */
async function savedCopy(path: string): Promise<Uint8Array | null> {
  return (await isLocalSave(path)) ? localSaveRead(path) : null;
}

// --- Save files: one read per load ------------------------------------------------

interface SaveFile {
  bytes: Uint8Array;
  /** Its chunk list (readStandaloneIff), parsed on first use. */
  chunks?: IffChunkInfo[];
}

/**
 * The save files (Sims/UserData*) read since the current load began, by
 * lower-cased path (the game folder is case-insensitive); null: no such file.
 * A neighborhood or lot load reads the same files from several modules
 * (Neighborhood.iff about six times, the characters two to four times): each
 * is now fetched, or read from this browser's saves, once, and every reader
 * gets its own copy of the bytes.
 *
 * Kept correct by: data/files.ts dropping a file after the game writes or
 * deletes it (invalidateSaveFile), so the next read sees the new file (in
 * both save modes); and resetSaveFileCache at the start of every load
 * (game/main.ts), so a load still sees files changed elsewhere (another tab,
 * another player of the shared server saves), as when nothing was cached.
 * Failed reads (network, server errors) are not kept.
 */
const saveFiles = new Map<string, Promise<SaveFile | null>>();

function saveFile(path: string): Promise<SaveFile | null> {
  const key = path.toLowerCase();
  const cached = saveFiles.get(key);
  if (cached) return cached;
  const p = (async (): Promise<SaveFile | null> => {
    const saved = await savedCopy(path);
    if (saved) return { bytes: saved };
    if (await isGameFilesLocal()) {
      const original = await localGameRead(path);
      return original ? { bytes: original } : null;
    }
    const res = await fetch(assetUrl(path), { cache: "no-store" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return { bytes: new Uint8Array(await res.arrayBuffer()) };
  })();
  saveFiles.set(key, p);
  p.catch(() => {
    if (saveFiles.get(key) === p) saveFiles.delete(key);
  });
  return p;
}

/**
 * Bytes [start, end) of a save file already read in this load, or kept in
 * this browser (client save mode); undefined when neither has it (the caller
 * reads the range from the server, as before). Throws where a Range request
 * would fail (missing file, `start` at or past the end).
 */
async function saveFileRange(path: string, start: number, end: number): Promise<Uint8Array | undefined> {
  const cached = saveFiles.get(path.toLowerCase());
  let bytes: Uint8Array | undefined;
  if (cached) {
    const f = await cached.catch(() => undefined);
    if (f === null) throw new Error(`${path} ${start}-${end}: 404`);
    bytes = f?.bytes;
  }
  bytes ??= (await savedCopy(path)) ?? undefined;
  if (!bytes) return undefined;
  if (start >= bytes.length) throw new Error(`${path} ${start}-${end}: 416`);
  return bytes.slice(start, end);
}

/** `path` (relative to /assets/, "Sims/UserData2/Neighborhood.iff") changed: its next read goes to the server (or this browser's saves) again. */
export function invalidateSaveFile(path: string): void {
  saveFiles.delete(path.toLowerCase());
}

/** A new load begins: every save file is read again (once). */
export function resetSaveFileCache(): void {
  saveFiles.clear();
}

/**
 * `fetch` of `path` (relative to /assets/, not URL-encoded) for the callers
 * that want a Response. A GET of a save file (Sims/UserData*) answers from the
 * save-file cache (read once per load, from this browser's saves in client
 * mode, else the server, uncached): status 200, 206 for a `Range: bytes=a-b`
 * request, 404 when there is no such file. Anything else goes to the
 * server's /assets/.
 */
export async function assetFetch(path: string, init?: RequestInit): Promise<Response> {
  if (isSavePath(path) && (init?.method ?? "GET").toUpperCase() === "GET") {
    const f = await saveFile(path).catch(() => undefined);
    if (f === null) return new Response(null, { status: 404 });
    if (f) {
      const saved = f.bytes;
      const range = /^bytes=(\d+)-(\d*)$/.exec(new Headers(init?.headers).get("range") ?? "");
      if (!range) return new Response(saved.slice(), { status: 200, headers: { "content-length": String(saved.length) } });
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]) + 1, saved.length) : saved.length;
      if (start >= saved.length) return new Response(null, { status: 416 });
      return new Response(saved.slice(start, end), { status: 206, headers: { "content-length": String(end - start) } });
    }
    // The read failed (not kept): this request gets the server's answer itself.
  }
  if (await isGameFilesLocal()) return localFetch(path, init);
  return fetch(assetUrl(path), init);
}

/** assetFetch answered from the imported game files (GET and HEAD, with or without a Range header). */
async function localFetch(path: string, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return new Response(null, { status: 405 });
  const size = await localGameSize(path);
  if (size === null) return new Response(null, { status: 404 });
  const head = method === "HEAD";
  const range = /^bytes=(\d+)-(\d*)$/.exec(new Headers(init?.headers).get("range") ?? "");
  if (!range) return new Response(head ? null : await localGameRead(path), { status: 200, headers: { "content-length": String(size) } });
  const start = Number(range[1]);
  const end = range[2] ? Math.min(Number(range[2]) + 1, size) : size;
  if (start >= size) return new Response(null, { status: 416 });
  return new Response(head ? null : await localGameRange(path, start, end), { status: 206, headers: { "content-length": String(end - start) } });
}

function assetUrl(path: string): string {
  return ASSETS_BASE + path.split("/").map(encodeURIComponent).join("/");
}

const objectUrls = new Map<string, Promise<string | null>>();

/**
 * A URL of the game file `path` (relative to /assets/) for the browser to
 * load itself (an `<audio>` element streaming a music track): its /assets/
 * URL, or, when the game files are imported in this browser, a blob: URL of
 * the stored file (made once per page). Null when the file was not imported.
 */
export function assetObjectUrl(path: string): Promise<string | null> {
  const key = path.toLowerCase();
  let p = objectUrls.get(key);
  if (!p) {
    p = (async () => {
      if (!(await isGameFilesLocal())) return assetUrl(path);
      const blob = await localGameBlob(path);
      return blob ? URL.createObjectURL(blob) : null;
    })();
    objectUrls.set(key, p);
  }
  return p;
}

const fileReads = new Map<string, Promise<Uint8Array>>();
/** Bigger loose files (music tracks) are left to the HTTP cache. */
const PERSIST_MAX_BYTES = 8 * 1024 * 1024;
/** Whole files up to this size are read through the range batcher (readAssetFile). */
const BATCHED_FILE_MAX_BYTES = 1024 * 1024;

/**
 * The whole file `path` (relative to /assets/, e.g. "Sims/UIGraphics/Res_CPanel.RT").
 * Game-folder files come from the IndexedDB cache when present (stored after
 * the first download); concurrent reads of the same file share one request.
 * Files the game writes (Sims/UserData*) are never stored: they are read
 * once per load (the save-file cache), each caller getting its own copy.
 * Rejects when the server has no such file.
 */
export function readAssetFile(path: string): Promise<Uint8Array> {
  if (isWritableAssetPath(path)) {
    return saveFile(path).then((f) => {
      if (!f) throw new Error(`${path}: 404`);
      return f.bytes.slice();
    });
  }
  const pending = fileReads.get(path);
  // A read joining one in flight gets its own copy, as if it had fetched the file itself.
  if (pending) return pending.then((b) => b.slice());
  const p = (async () => {
    if (await isGameFilesLocal()) {
      const local = await localGameRead(path);
      if (!local) throw new Error(`${path}: 404`);
      return local;
    }
    const persisted = await idbGetIffFile(path);
    if (persisted) return persisted;
    // A small file the manifest (when already here) lists goes through the
    // shared batcher: the files asked for in one task (the cursors, the
    // loose wall / floor plugins) share one request.
    const size = resolvedManifest ? sizeIn(resolvedManifest, path) : null;
    if (size !== null && size <= BATCHED_FILE_MAX_BYTES) {
      const data = await readAssetRangeBatched(path, 0, size, (view) => {
        if (view.length === size) void idbPutIffFile(path, view);
      }).catch(() => null);
      if (data?.length === size) return data;
    }
    const res = await fetch(assetUrl(path));
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.length <= PERSIST_MAX_BYTES) void idbPutIffFile(path, data.slice());
    return data;
  })();
  // Only in-flight reads are shared; callers keep what they need.
  fileReads.set(path, p);
  const settled = (): void => void fileReads.delete(path);
  p.then(settled, settled);
  return p;
}

async function fetchRange(path: string, start: number, endInclusive: number): Promise<Uint8Array> {
  if (isWritableAssetPath(path)) {
    const known = await saveFileRange(path, start, endInclusive + 1);
    if (known) return known;
  }
  if (await isGameFilesLocal()) return localGameRange(path, start, endInclusive + 1);
  const url = `${ASSETS_BASE}${path}`;
  // Not through the HTTP cache: the bytes are kept in IndexedDB, and Chrome
  // serializes cached requests to one URL (a FAR archive), which stalled cold loads.
  const res = await fetch(url, {
    headers: { Range: `bytes=${start}-${endInclusive}` },
    cache: "no-store",
  });
  if (res.status !== 206 && res.status !== 200) {
    throw new Error(`range fetch ${path} ${start}-${endInclusive}: ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/** Bytes [start, end) of a file under /assets (one Range request, not cached). */
export function readAssetRange(path: string, start: number, end: number): Promise<Uint8Array> {
  return fetchRange(path, start, end - 1);
}

let sharedBatcher: RangeBatcher | null = null;

/**
 * Bytes [start, end) of a file under /assets, not cached, read through a
 * shared RangeBatcher: the reads issued in one task go out in one request.
 * The result is a copy (the batch response buffer is not kept alive).
 * `persist`, for bytes read from the server: called with a view of them in
 * the response, which it may hand to the IndexedDB writer (idbPut*: the
 * response buffer is transferred to its worker once every read of the batch
 * has its copy), saving a copy on this thread.
 */
export function readAssetRangeBatched(path: string, start: number, end: number, persist?: (view: Uint8Array) => void): Promise<Uint8Array> {
  sharedBatcher ??= new RangeBatcher(true);
  return sharedBatcher.read(path, start, end, persist);
}

const rangeReads = new Map<string, Promise<Uint8Array>>();

/**
 * Like readAssetRangeBatched, with the range kept in IndexedDB for game-folder
 * files (never for Sims/UserData*). For small ranges read again on later
 * loads (catalog icons).
 */
export function readAssetRangeCached(path: string, start: number, end: number): Promise<Uint8Array> {
  if (isWritableAssetPath(path)) return readAssetRangeBatched(path, start, end);
  const key = `${path}|${start}|${end}`;
  const pending = rangeReads.get(key);
  if (pending) return pending.then((b) => b.slice());
  const p = (async () => {
    if (await isGameFilesLocal()) return readAssetRangeBatched(path, start, end);
    const persisted = await idbGetRange(path, start, end);
    if (persisted) return persisted;
    return readAssetRangeBatched(path, start, end, (view) => void idbPutRange(path, start, end, view));
  })();
  rangeReads.set(key, p);
  const settled = (): void => void rangeReads.delete(key);
  p.then(settled, settled);
  return p;
}

/** Sizes of the asset manifest's files by lower-case path, made once per manifest. */
const manifestSizes = new WeakMap<Manifest, Map<string, number>>();

function sizeIn(m: Manifest, path: string): number | null {
  let sizes = manifestSizes.get(m);
  if (!sizes) {
    sizes = new Map(m.files.map((f) => [f.path.toLowerCase(), f.size]));
    manifestSizes.set(m, sizes);
  }
  const size = sizes.get(path.toLowerCase());
  return typeof size === "number" && size > 0 ? size : null;
}

/** The size the asset manifest lists for `path`, null when it is not listed (or there is no manifest). */
async function manifestFileSize(path: string): Promise<number | null> {
  const m = await fetchManifest().catch(() => null);
  return m ? sizeIn(m, path) : null;
}

/**
 * Bytes at the end of a FAR archive of `size` bytes read with its header, as
 * a guess at its manifest table: 1/256 of the archive, 4..64 KiB. The shipped
 * tables are 0.1..1 % of their archive (UIGraphics.far 37 KB of 55 MB,
 * ExpansionPack2.far 64 KB of 60 MB; the Downloads archives' a few hundred
 * bytes), so most fit; a bigger one costs one more read, as without a guess.
 */
function farTailGuess(size: number): number {
  return Math.min(size, Math.max(4096, Math.min(65536, Math.floor(size / 256))));
}

/**
 * Read the FAR header (first 16 B) + the manifest tail and parse the entry table via WASM.
 * Pulls only `header_size + tail_size` bytes from the network — typically a few hundred B.
 */
export async function readFarManifest(farPath: string): Promise<FarEntryInfo[]> {
  let cached = farManifestCache.get(farPath);
  if (!cached) {
    cached = (async () => {
      const local = await isGameFilesLocal();
      const persisted = local ? null : ((await idbGetFarManifest(farPath)) as FarEntryInfo[] | null);
      if (Array.isArray(persisted)) return persisted;
      const wasm = await engine();
      // The archive's size from the asset manifest (the manifest table runs to its end).
      const known = local ? null : await manifestFileSize(farPath);
      // Header and manifest through the shared batcher: the archives scanned in
      // one task (the plugin folders, ~70 Downloads archives) share one request
      // per step instead of three requests each (range, HEAD, range). With the
      // size known, the archive's last bytes are asked for with the header (a
      // guess at the manifest table, farTailGuess): most tables fit, and the
      // header-then-table chain of round trips becomes one.
      const guessStart = known !== null && known > FAR_HEADER_SIZE ? Math.max(FAR_HEADER_SIZE, known - farTailGuess(known)) : -1;
      const guessRead = known !== null && guessStart >= 0 ? readAssetRangeBatched(farPath, guessStart, known) : null;
      guessRead?.catch(() => {}); // (its failure is the header's, or it is read again below)
      const head = await readAssetRangeBatched(farPath, 0, FAR_HEADER_SIZE);
      if (!wasm.checkFarMagic(head)) {
        throw new Error(`${farPath}: not a FAR archive`);
      }
      const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
      const manifestOffset = view.getUint32(12, true);
      // Manifest is from manifestOffset to EOF: the size from the asset manifest, else a HEAD.
      let totalSize: number;
      if (local) totalSize = (await localGameSize(farPath)) ?? 0;
      else {
        if (known !== null) totalSize = known;
        else {
          const headRes = await fetch(`${ASSETS_BASE}${farPath}`, { method: "HEAD" });
          if (!headRes.ok) throw new Error(`HEAD ${farPath}: ${headRes.status}`);
          totalSize = Number(headRes.headers.get("content-length") ?? "0");
        }
      }
      if (!Number.isFinite(totalSize) || totalSize === 0) {
        throw new Error(`${farPath}: no content-length`);
      }
      const guess = guessRead && manifestOffset >= FAR_HEADER_SIZE && manifestOffset <= totalSize ? await guessRead.catch(() => null) : null;
      let tail: Uint8Array | null = null;
      if (guess && guess.length === totalSize - guessStart) {
        if (manifestOffset >= guessStart) tail = guess.subarray(manifestOffset - guessStart);
        else {
          // A bigger table: the part before the guess, then the guess.
          const before = await readAssetRangeBatched(farPath, manifestOffset, guessStart);
          if (before.length === guessStart - manifestOffset) {
            tail = new Uint8Array(before.length + guess.length);
            tail.set(before, 0);
            tail.set(guess, before.length);
          }
        }
      }
      tail ??= await readAssetRangeBatched(farPath, manifestOffset, totalSize);
      // Reassemble a minimal "FAR view" for the WASM parser: header pointing at offset 16
      // for the manifest, then the manifest bytes. We rebuild the header so the parser
      // sees a coherent buffer without downloading the payload region.
      const fake = new Uint8Array(FAR_HEADER_SIZE + tail.length);
      fake.set(head, 0);
      const fv = new DataView(fake.buffer);
      fv.setUint32(12, FAR_HEADER_SIZE, true); // manifest now at offset 16
      fake.set(tail, FAR_HEADER_SIZE);
      // We need to re-base entry offsets later, so keep the original manifestOffset.
      const entries = wasm.parseFarManifest(fake) as FarEntryInfo[];
      // Entries point into the original archive; their `offset` is absolute in the
      // un-truncated archive, which matches what we want for downstream Range requests.
      if (!local) void idbPutFarManifest(farPath, entries);
      return entries;
    })();
    farManifestCache.set(farPath, cached);
  }
  return cached;
}

/** The entries of each FAR manifest by lower-case name (the first of a name), made once per manifest. */
const farEntryNames = new WeakMap<FarEntryInfo[], Map<string, FarEntryInfo>>();

/** The entry of `entries` named `name` (case-insensitive), like a search of the list in order. */
function entryByName(entries: FarEntryInfo[], name: string): FarEntryInfo | undefined {
  let byName = farEntryNames.get(entries);
  if (!byName) {
    byName = new Map();
    for (const e of entries) {
      const k = e.filename.toLowerCase();
      if (!byName.has(k)) byName.set(k, e);
    }
    farEntryNames.set(entries, byName);
  }
  return byName.get(name.toLowerCase());
}

/**
 * Read one entry from a FAR archive: the entry's bytes only, batched with the
 * other reads of the same task (RangeBatcher), kept in IndexedDB.
 */
export function readFarEntry(farPath: string, entryName: string): Promise<Uint8Array> {
  const cacheKey = `${farPath}|${entryName.toLowerCase()}`;
  const kept = entryCache.get(cacheKey);
  if (kept) {
    // Most recently used: to the end of the map.
    entryCache.delete(cacheKey);
    entryCache.set(cacheKey, kept);
    return Promise.resolve(kept);
  }
  let pending = entryReads.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      const local = await isGameFilesLocal();
      const persisted = local ? null : await idbGetFarEntry(farPath, entryName);
      if (persisted) return persisted;
      const target = entryByName(await readFarManifest(farPath), entryName);
      if (!target) {
        throw new Error(`${farPath}: entry "${entryName}" not found`);
      }
      // Through the shared batcher: the entries asked for in one task (a lot
      // load asks for ~2000, Live mode a few dozen per new animation) share one
      // POST /api/ranges instead of one Range request each.
      // (the put gets the response's bytes, not the caller's copy: the caller may change them)
      const start = target.offset;
      return readAssetRangeBatched(farPath, start, start + target.sizeCompressed, (view) => void idbPutFarEntry(farPath, entryName, view));
    })();
    entryReads.set(cacheKey, pending);
    const p = pending;
    p.then(
      (bytes) => {
        entryReads.delete(cacheKey);
        keepEntry(cacheKey, bytes);
      },
      () => entryReads.delete(cacheKey),
    );
  }
  return pending;
}

/**
 * Convenience: resolve a logical asset by `(farPath, entryName)` and decode its IFF chunks.
 */
export async function readIffFromFar(
  farPath: string,
  entryName: string,
): Promise<{ data: Uint8Array; chunks: IffChunkInfo[] }> {
  const wasm = await engine();
  const data = await readFarEntry(farPath, entryName);
  const chunks = wasm.parseIffChunks(data) as IffChunkInfo[];
  return { data, chunks };
}

export interface IffChunkInfo {
  kind: string;
  size: number;
  id: number;
  flags: number;
  /** 64-byte chunk label, trimmed at the first null. Empty if absent. */
  label: string;
  offset: number;
  dataStart: number;
  dataLen: number;
}

/** Open a standalone .iff/.flr/.wll file on disk (no FAR wrapping). */
export async function readStandaloneIff(
  path: string,
): Promise<{ data: Uint8Array; chunks: IffChunkInfo[] }> {
  const wasm = await engine();
  // Files the game writes (UserData*) are read and parsed once per load (the
  // save-file cache); every caller gets its own copy of the bytes and chunk list.
  if (isWritableAssetPath(path)) {
    const f = await saveFile(path);
    if (!f) throw new Error(`${path}: 404`);
    f.chunks ??= wasm.parseIffChunks(f.bytes) as IffChunkInfo[];
    return { data: f.bytes.slice(), chunks: f.chunks.map((c) => ({ ...c })) };
  }
  const data = await readAssetFile(path);
  const chunks = wasm.parseIffChunks(data) as IffChunkInfo[];
  return { data, chunks };
}

/** Most ranges per POST /api/ranges (the server accepts 4096). */
const BATCH_MAX_RANGES = 1024;
/** Most requested bytes per POST /api/ranges (the server accepts 64 MiB). */
const BATCH_MAX_BYTES = 16 * 1024 * 1024;
const RANGE_UNREADABLE = 0xffffffff;

interface PendingRange {
  path: string;
  start: number;
  end: number;
  persist: ((view: Uint8Array) => void) | undefined;
  resolve: (b: Uint8Array) => void;
  reject: (e: unknown) => void;
}

/**
 * Byte ranges of asset files read in batches: the reads asked for in one
 * task go to the server together (POST /api/ranges, server/src/routes/ranges.ts),
 * so thousands of small reads cost a few round trips. Each read resolves with
 * the same bytes as a `Range: bytes=start-(end-1)` request (cut at the end of
 * the file) and fails where that request would. Without the endpoint (an
 * older server), reads fall back to one uncached Range request each.
 */
export class RangeBatcher {
  private queue: PendingRange[] = [];
  private scheduled = false;
  private static endpoint: boolean | null = null;

  /**
   * `copies`: every read gets its own buffer (else views of the batch's
   * response, which they keep alive), and the response is handed to the
   * reads' `persist`.
   */
  constructor(private readonly copies = false) {}

  /**
   * Bytes [start, end) of `path` (relative to /assets/). `persist` (a
   * copying batcher only): called with a view of the bytes in the server's
   * response, before the read resolves; it may hand the view to the
   * IndexedDB writer (the response is used here only by the copies).
   */
  read(path: string, start: number, end: number, persist?: (view: Uint8Array) => void): Promise<Uint8Array> {
    // A save file read in this load or kept in this browser (client save mode) is read from there.
    if (isWritableAssetPath(path)) {
      return saveFileRange(path, start, end).then(
        (known) => known ?? this.source(path, start, end, persist),
        () => {
          throw new Error(`${path} ${start}-${end}: unreadable`);
        },
      );
    }
    return this.source(path, start, end, persist);
  }

  /** The imported game files when the server serves none (GAME_FILES=client), else the server, batched. */
  private async source(path: string, start: number, end: number, persist: ((view: Uint8Array) => void) | undefined): Promise<Uint8Array> {
    if (await isGameFilesLocal()) {
      return localGameRange(path, start, end).catch(() => {
        throw new Error(`${path} ${start}-${end}: unreadable`);
      });
    }
    return this.enqueue(path, start, end, persist);
  }

  private enqueue(path: string, start: number, end: number, persist: ((view: Uint8Array) => void) | undefined): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      this.queue.push({ path, start, end, persist: this.copies ? persist : undefined, resolve, reject });
      if (!this.scheduled) {
        this.scheduled = true;
        setTimeout(() => this.flush(), 0);
      }
    });
  }

  private flush(): void {
    this.scheduled = false;
    const all = this.queue;
    this.queue = [];
    let batch: PendingRange[] = [];
    let bytes = 0;
    for (const r of all) {
      if (batch.length && (batch.length >= BATCH_MAX_RANGES || bytes + (r.end - r.start) > BATCH_MAX_BYTES)) {
        void this.send(batch);
        batch = [];
        bytes = 0;
      }
      batch.push(r);
      bytes += r.end - r.start;
    }
    if (batch.length) void this.send(batch);
  }

  private async send(batch: PendingRange[]): Promise<void> {
    if (RangeBatcher.endpoint !== false) {
      try {
        const res = await fetch("/api/ranges", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ranges: batch.map((r) => [r.path, r.start, r.end]) }),
        });
        if (res.status === 404) {
          RangeBatcher.endpoint = false;
        } else if (res.ok) {
          RangeBatcher.endpoint = true;
          const body = new Uint8Array(await res.arrayBuffer());
          const head = new DataView(body.buffer, body.byteOffset, 4 * batch.length);
          let at = 4 * batch.length;
          batch.forEach((r, i) => {
            const len = head.getUint32(4 * i, true);
            if (len === RANGE_UNREADABLE) {
              r.reject(new Error(`${r.path} ${r.start}-${r.end}: unreadable`));
              return;
            }
            const view = body.subarray(at, at + len);
            at += len;
            // The copy first: `persist` may hand the response buffer over.
            const out = this.copies ? view.slice() : view;
            r.persist?.(view);
            r.resolve(out);
          });
          return;
        }
      } catch {
        // fall through to single requests
      }
    }
    await RangeBatcher.single(batch, this.copies);
  }

  /** Requests in flight on the fallback path (browsers fail requests beyond a few hundred). */
  private static singleSlots = 12;
  private static readonly singleWaiters: Array<() => void> = [];

  private static async single(batch: PendingRange[], copies: boolean): Promise<void> {
    await Promise.all(
      batch.map(async (r) => {
        if (RangeBatcher.singleSlots > 0) RangeBatcher.singleSlots--;
        else await new Promise<void>((go) => RangeBatcher.singleWaiters.push(go));
        try {
          const res = await fetch(`${ASSETS_BASE}${r.path}`, { headers: { Range: `bytes=${r.start}-${r.end - 1}` }, cache: "no-store" });
          if (res.status !== 206 && res.status !== 200) throw new Error(`${r.path} ${r.start}-${r.end}: ${res.status}`);
          const b = new Uint8Array(await res.arrayBuffer());
          // A server ignoring Range answers 200 with the whole file.
          const view = res.status === 200 ? b.subarray(r.start, r.end) : b;
          r.persist?.(view.slice());
          r.resolve(copies && view !== b ? view.slice() : view);
        } catch (e) {
          r.reject(e);
        } finally {
          const go = RangeBatcher.singleWaiters.shift();
          if (go) go();
          else RangeBatcher.singleSlots++;
        }
      }),
    );
  }
}
