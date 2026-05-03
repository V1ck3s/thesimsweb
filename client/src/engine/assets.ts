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

/** Open a standalone .iff/.flr/.wll file on disk (no FAR wrapping). */
export async function readStandaloneIff(
  path: string,
): Promise<{ data: Uint8Array; chunks: IffChunkInfo[] }> {
  const wasm = await engine();
  let data = await idbGetIffFile(path);
  if (!data) {
    const res = await fetch(`${ASSETS_BASE}${path}`);
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    data = new Uint8Array(await res.arrayBuffer());
    void idbPutIffFile(path, data);
  }
  const chunks = wasm.parseIffChunks(data) as IffChunkInfo[];
  return { data, chunks };
}
