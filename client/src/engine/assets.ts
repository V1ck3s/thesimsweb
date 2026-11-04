/**
 * Streaming asset client.
 *
 * Talks to the dev server (`/api/manifest`, `/assets/*` with `Range`) and uses the WASM
 * parsers to pull individual entries out of FAR archives without downloading the whole
 * archive. Decoded payloads are cached in memory by `(farPath, entryName)`.
 *
 * Game-folder data read here (FAR tables and entries, whole files, byte
 * ranges) is also kept in IndexedDB (engine/idb.ts), so a reload does not
 * download it again. Files the game writes (Sims/UserData*, served from the
 * save overlay) change and are always read from the server, never cached.
 * When the instance keeps saves in the browser (engine/saves.ts, "client"
 * mode), a file saved here is read from the saves database instead, and the
 * manifest lists it over the server's files.
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
const entryCache = new Map<string, Promise<Uint8Array>>();

let manifest: Promise<Manifest> | null = null;

/**
 * The asset manifest, fetched once per page (it lists ~10 000 files, 1.5 MB)
 * and fetched again after invalidateManifest (data/files.ts calls it after
 * every write or delete of a game file). Callers must not mutate it.
 */
export function fetchManifest(): Promise<Manifest> {
  if (!manifest) {
    const p = (async () => {
      const res = await fetch("/api/manifest", { cache: "no-store" });
      if (!res.ok) throw new Error(`manifest ${res.status}`);
      const m = (await res.json()) as Manifest;
      if ((await getSaveMode()) === "client") {
        // Files saved in this browser replace or add to the server's (as the overlay does there).
        const saved = await localSaveList();
        if (saved.length) {
          const byPath = new Map(m.files.map((f) => [f.path.toLowerCase(), f]));
          for (const f of saved) {
            const kind = f.path.toLowerCase().endsWith(".far") ? "far" : f.path.toLowerCase().endsWith(".iff") ? "iff" : "other";
            byPath.set(f.path.toLowerCase(), { path: byPath.get(f.path.toLowerCase())?.path ?? f.path, size: f.size, kind });
          }
          m.files = [...byPath.values()];
        }
      }
      return m;
    })();
    manifest = p;
    p.catch(() => {
      if (manifest === p) manifest = null;
    });
  }
  return manifest;
}

/** The next fetchManifest asks the server again (the game files changed). */
export function invalidateManifest(): void {
  manifest = null;
}

/** Whether `path` (relative to /assets/) is a file the game can write (Sims/UserData*), which is never cached. */
export function isWritableAssetPath(path: string): boolean {
  return isSavePath(path);
}

/** The copy of a save file kept in this browser, in client save mode (null otherwise). */
async function savedCopy(path: string): Promise<Uint8Array | null> {
  return (await isLocalSave(path)) ? localSaveRead(path) : null;
}

/**
 * `fetch` of `path` (relative to /assets/, not URL-encoded) for the callers
 * that want a Response: a save file kept in this browser answers from there
 * (status 200, or 206 for a `Range: bytes=a-b` request); anything else goes to
 * the server's /assets/.
 */
export async function assetFetch(path: string, init?: RequestInit): Promise<Response> {
  const saved = await savedCopy(path);
  if (saved) {
    const range = /^bytes=(\d+)-(\d*)$/.exec(new Headers(init?.headers).get("range") ?? "");
    if (!range) return new Response(saved.slice(), { status: 200, headers: { "content-length": String(saved.length) } });
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]) + 1, saved.length) : saved.length;
    if (start >= saved.length) return new Response(null, { status: 416 });
    return new Response(saved.slice(start, end), { status: 206, headers: { "content-length": String(end - start) } });
  }
  return fetch(assetUrl(path), init);
}

function assetUrl(path: string): string {
  return ASSETS_BASE + path.split("/").map(encodeURIComponent).join("/");
}

const fileReads = new Map<string, Promise<Uint8Array>>();
/** Bigger loose files (music tracks) are left to the HTTP cache. */
const PERSIST_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The whole file `path` (relative to /assets/, e.g. "Sims/UIGraphics/Res_CPanel.RT").
 * Game-folder files come from the IndexedDB cache when present (stored after
 * the first download); concurrent reads of the same file share one request.
 * Files the game writes (Sims/UserData*) are always fetched, uncached.
 * Rejects when the server has no such file.
 */
export function readAssetFile(path: string): Promise<Uint8Array> {
  if (isWritableAssetPath(path)) {
    return (async () => {
      const saved = await savedCopy(path);
      if (saved) return saved.slice();
      const res = await fetch(assetUrl(path), { cache: "no-store" });
      if (!res.ok) throw new Error(`${path}: ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    })();
  }
  const pending = fileReads.get(path);
  // A read joining one in flight gets its own copy, as if it had fetched the file itself.
  if (pending) return pending.then((b) => b.slice());
  const p = (async () => {
    const persisted = await idbGetIffFile(path);
    if (persisted) return persisted;
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
    const saved = await savedCopy(path);
    if (saved) {
      if (start >= saved.length) throw new Error(`range fetch ${path} ${start}-${endInclusive}: 416`);
      return saved.slice(start, endInclusive + 1);
    }
  }
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
 */
export async function readAssetRangeBatched(path: string, start: number, end: number): Promise<Uint8Array> {
  sharedBatcher ??= new RangeBatcher();
  return (await sharedBatcher.read(path, start, end)).slice();
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
    const persisted = await idbGetRange(path, start, end);
    if (persisted) return persisted;
    const bytes = await readAssetRangeBatched(path, start, end);
    void idbPutRange(path, start, end, bytes.slice());
    return bytes;
  })();
  rangeReads.set(key, p);
  const settled = (): void => void rangeReads.delete(key);
  p.then(settled, settled);
  return p;
}

/**
 * Read the FAR header (first 16 B) + the manifest tail and parse the entry table via WASM.
 * Pulls only `header_size + tail_size` bytes from the network — typically a few hundred B.
 */
export async function readFarManifest(farPath: string): Promise<FarEntryInfo[]> {
  let cached = farManifestCache.get(farPath);
  if (!cached) {
    cached = (async () => {
      const persisted = (await idbGetFarManifest(farPath)) as FarEntryInfo[] | null;
      if (Array.isArray(persisted)) return persisted;
      const wasm = await engine();
      const head = await fetchRange(farPath, 0, FAR_HEADER_SIZE - 1);
      if (!wasm.checkFarMagic(head)) {
        throw new Error(`${farPath}: not a FAR archive`);
      }
      const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
      const manifestOffset = view.getUint32(12, true);
      // Manifest is from manifestOffset to EOF. We need the size — get it via HEAD.
      const headRes = await fetch(`${ASSETS_BASE}${farPath}`, { method: "HEAD" });
      if (!headRes.ok) throw new Error(`HEAD ${farPath}: ${headRes.status}`);
      const totalSize = Number(headRes.headers.get("content-length") ?? "0");
      if (!Number.isFinite(totalSize) || totalSize === 0) {
        throw new Error(`${farPath}: no content-length`);
      }
      const tail = await fetchRange(farPath, manifestOffset, totalSize - 1);
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
      void idbPutFarManifest(farPath, entries);
      return entries;
    })();
    farManifestCache.set(farPath, cached);
  }
  return cached;
}

/**
 * Read one entry from a FAR archive. Uses a Range request bounded to the entry's bytes.
 */
export async function readFarEntry(farPath: string, entryName: string): Promise<Uint8Array> {
  const cacheKey = `${farPath}|${entryName.toLowerCase()}`;
  let cached = entryCache.get(cacheKey);
  if (!cached) {
    cached = (async () => {
      const persisted = await idbGetFarEntry(farPath, entryName);
      if (persisted) return persisted;
      const entries = await readFarManifest(farPath);
      const target = entries.find(
        (e) => e.filename.toLowerCase() === entryName.toLowerCase(),
      );
      if (!target) {
        throw new Error(`${farPath}: entry "${entryName}" not found`);
      }
      const start = target.offset;
      const end = start + target.sizeCompressed - 1;
      const bytes = await fetchRange(farPath, start, end);
      // (a copy: the put is queued, the caller may change its bytes meanwhile)
      void idbPutFarEntry(farPath, entryName, bytes.slice());
      return bytes;
    })();
    entryCache.set(cacheKey, cached);
  }
  return cached;
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
  // Files the game writes (UserData*, served from the save overlay) change:
  // readAssetFile never keeps them in the persistent cache.
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

  /** Bytes [start, end) of `path` (relative to /assets/). */
  read(path: string, start: number, end: number): Promise<Uint8Array> {
    // A save file kept in this browser (client save mode) is read from there.
    if (isWritableAssetPath(path)) {
      return savedCopy(path).then((saved) => {
        if (!saved) return this.enqueue(path, start, end);
        if (start >= saved.length) throw new Error(`${path} ${start}-${end}: unreadable`);
        return saved.subarray(start, end);
      });
    }
    return this.enqueue(path, start, end);
  }

  private enqueue(path: string, start: number, end: number): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      this.queue.push({ path, start, end, resolve, reject });
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
            r.resolve(body.subarray(at, at + len));
            at += len;
          });
          return;
        }
      } catch {
        // fall through to single requests
      }
    }
    await RangeBatcher.single(batch);
  }

  /** Requests in flight on the fallback path (browsers fail requests beyond a few hundred). */
  private static singleSlots = 12;
  private static readonly singleWaiters: Array<() => void> = [];

  private static async single(batch: PendingRange[]): Promise<void> {
    await Promise.all(
      batch.map(async (r) => {
        if (RangeBatcher.singleSlots > 0) RangeBatcher.singleSlots--;
        else await new Promise<void>((go) => RangeBatcher.singleWaiters.push(go));
        try {
          const res = await fetch(`${ASSETS_BASE}${r.path}`, { headers: { Range: `bytes=${r.start}-${r.end - 1}` }, cache: "no-store" });
          if (res.status !== 206 && res.status !== 200) throw new Error(`${r.path} ${r.start}-${r.end}: ${res.status}`);
          const b = new Uint8Array(await res.arrayBuffer());
          // A server ignoring Range answers 200 with the whole file.
          r.resolve(res.status === 200 ? b.subarray(r.start, r.end) : b);
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
