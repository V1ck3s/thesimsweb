/**
 * Streaming asset client.
 *
 * Talks to the dev server (`/api/manifest`, `/assets/*` with `Range`) and uses the WASM
 * parsers to pull individual entries out of FAR archives without downloading the whole
 * archive. Decoded payloads are cached in memory by `(farPath, entryName)`.
 */

import { engine } from "./wasm.js";
import {
  idbGetFarEntry,
  idbGetFarManifest,
  idbGetIffFile,
  idbPutFarEntry,
  idbPutFarManifest,
  idbPutIffFile,
} from "./idb.js";

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

export async function fetchManifest(): Promise<Manifest> {
  const res = await fetch("/api/manifest");
  if (!res.ok) throw new Error(`manifest ${res.status}`);
  return (await res.json()) as Manifest;
}

async function fetchRange(path: string, start: number, endInclusive: number): Promise<Uint8Array> {
  const url = `${ASSETS_BASE}${path}`;
  const res = await fetch(url, {
    headers: { Range: `bytes=${start}-${endInclusive}` },
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
      void idbPutFarEntry(farPath, entryName, bytes);
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

/** Paths the save overlay can write (server/src/routes/userdata.ts). */
const WRITABLE_PATH = /^Sims\/UserData\d*\//i;

/** Open a standalone .iff/.flr/.wll file on disk (no FAR wrapping). */
export async function readStandaloneIff(
  path: string,
): Promise<{ data: Uint8Array; chunks: IffChunkInfo[] }> {
  const wasm = await engine();
  // Files the game writes (UserData*, served from the save overlay) change:
  // they are never kept in the persistent cache.
  const writable = WRITABLE_PATH.test(path);
  let data = writable ? null : await idbGetIffFile(path);
  if (!data) {
    const res = await fetch(`${ASSETS_BASE}${path}`, writable ? { cache: "no-store" } : {});
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    data = new Uint8Array(await res.arrayBuffer());
    if (!writable) void idbPutIffFile(path, data);
  }
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
