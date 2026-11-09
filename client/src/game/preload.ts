/**
 * Download of the game files nearly every session reads (not part of the
 * original, which read them from the disk), started from the landing page
 * (landing/main.ts: a button, a progress bar, a stop button and one that
 * clears what was downloaded), so that a slow connection can pay once, up
 * front, instead of during play (a family created with invisible sims while
 * their skins were still on the way, a lot taking minutes to open). Without
 * it the game downloads the files as it needs them.
 *
 * What is downloaded:
 *
 * - the files every lot load reads, whatever the lot: measured on recorded
 *   lot loads (preload-lots.json, scripts/preload-list.mjs: the people,
 *   cars, NPCs, doors, windows, stairs... about 200 MB of object files that
 *   different lots all read), and the object files ObjectFolder names for
 *   every lot (everyLotFiles: the sim objects, the placeholders);
 * - the wall and floor plugin files (the build catalogs and every lot's
 *   walls and floors read them all);
 * - the bodies and heads of the sims (meshes, textures, suits: the files
 *   whose names start with "b" / "c" or "xskin-b" / "xskin-c"), which
 *   Create-a-Sim browses and every sim wears.
 *
 * The files land in the IndexedDB asset cache (engine/idb.ts) through the
 * usual reads (readFarEntry, readAssetFile); what the cache holds already is
 * skipped. Not offered when the game files are imported into this browser
 * (GAME_FILES=client: they are local) or without IndexedDB.
 */

import { fetchManifest, readAssetFile, readFarEntry, readFarManifest } from "../engine/assets.js";
import { isGameFilesLocal } from "../engine/gamefiles.js";
import { idbCachedKeys, openDb } from "../engine/idb.js";
import lots from "./preload-lots.json";
import { VBAnimMgr } from "./sims/vbanimmgr.js";
import { scanPluginFiles } from "./world/floors.js";
import { ObjectFolder } from "./world/objectfolder.js";

/** One file to have in the cache: a FAR entry or a loose file ("Sims/..." paths). */
type Item = { far: string; entry: string; size: number } | { path: string; size: number };

/** Loose files bigger than this are not kept by readAssetFile (left to the HTTP cache): not preloaded. */
const LOOSE_MAX_BYTES = 8 * 1024 * 1024;
/** Bytes asked for at once (one wave of reads shares batched requests, engine/assets.ts RangeBatcher). */
const WAVE_BYTES = 6 * 1024 * 1024;
/** Waves in flight together. */
const WAVES = 3;

/** Bodies and heads: meshes, textures and suits (lower-case file names). */
function isBodyOrHead(name: string): boolean {
  const ext = name.slice(name.lastIndexOf(".") + 1);
  if (ext === "skn" || ext === "bmf") return name.startsWith("xskin-b") || name.startsWith("xskin-c");
  if (ext === "bmp" || ext === "cmx" || ext === "bcf") return name.startsWith("b") || name.startsWith("c");
  return false;
}

/** The files to preload, each once. */
async function wanted(folder: ObjectFolder): Promise<Item[]> {
  const manifest = await fetchManifest();
  const sizes = new Map(manifest.files.map((f) => [f.path.toLowerCase(), f.size]));
  const items = new Map<string, Item>();
  const farEntries = new Map<string, Promise<Map<string, number>>>();
  const entrySizes = (far: string): Promise<Map<string, number>> => {
    let p = farEntries.get(far);
    if (!p) {
      p = readFarManifest(far).then(
        (es) => new Map(es.map((e) => [e.filename.toLowerCase(), e.sizeCompressed])),
        () => new Map(),
      );
      farEntries.set(far, p);
    }
    return p;
  };
  const addEntry = async (far: string, entry: string): Promise<void> => {
    const size = (await entrySizes(far)).get(entry.toLowerCase());
    if (size !== undefined) items.set(`${far}|${entry.toLowerCase()}`, { far, entry, size });
  };
  const addFile = (path: string): void => {
    const size = sizes.get(path.toLowerCase());
    if (size !== undefined && size <= LOOSE_MAX_BYTES) items.set(path, { path, size });
  };
  const add = (src: { far: string; entry: string } | { path: string }): Promise<void> | void => ("far" in src ? addEntry(src.far, src.entry) : addFile(src.path));

  const [walls, floors, anim] = await Promise.all([scanPluginFiles(".wll", "Walls").catch(() => []), scanPluginFiles(".flr", "Floors").catch(() => []), VBAnimMgr.get()]);
  const pending: Array<Promise<void> | void> = [];
  for (const key of folder.everyLotFiles()) {
    const bar = key.indexOf("|");
    pending.push(bar < 0 ? addFile(`Sims/${key}`) : addEntry(`Sims/${key.slice(0, bar)}`, key.slice(bar + 1)));
  }
  for (const f of lots.files) pending.push(f.length === 2 ? addEntry(f[0]!, f[1]!) : addFile(f[0]!));
  for (const f of [...walls, ...floors]) pending.push(f.far ? addEntry(`Sims/${f.far}`, f.path) : addFile(`Sims/${f.path}`));
  for (const src of anim.fileSources(isBodyOrHead)) pending.push(add(src));
  await Promise.all(pending);
  return [...items.values()];
}

/** Where a download is: listing what to download (the object catalog is read the first time), then downloading. */
export interface PreloadProgress {
  phase: "listing" | "downloading";
  doneBytes: number;
  totalBytes: number;
}

export interface PreloadResult {
  /** Bytes downloaded by this run (0: the cache held everything). */
  bytes: number;
  /** Files that could not be read (left to be read when the game needs them). */
  failed: number;
}

/**
 * Brings the files into the cache, reporting its progress as it goes.
 * Rejects with an AbortError when `signal` aborts (what was downloaded is
 * kept), or when the files cannot be kept here (imported game files, no
 * IndexedDB).
 */
export async function preloadGameFiles(progress: (p: PreloadProgress) => void, signal?: AbortSignal): Promise<PreloadResult> {
  const aborted = (): void => {
    if (signal?.aborted) throw new DOMException("stopped", "AbortError");
  };
  if (await isGameFilesLocal()) throw new Error("the game files are imported into this browser");
  if (!(await openDb())) throw new Error("IndexedDB is unavailable");
  progress({ phase: "listing", doneBytes: 0, totalBytes: 0 });
  const folder = await ObjectFolder.get("UserData");
  aborted();
  const [items, cached] = await Promise.all([wanted(folder), idbCachedKeys()]);
  aborted();
  const missing = items.filter((it) => ("far" in it ? !cached.entries.has(`${it.far}|${it.entry.toLowerCase()}`) : !cached.files.has(it.path)));
  const total = missing.reduce((n, it) => n + it.size, 0);
  let done = 0;
  let failed = 0;
  progress({ phase: "downloading", doneBytes: 0, totalBytes: total });
  // Waves of about WAVE_BYTES, a few in flight.
  const waves: Item[][] = [];
  let wave: Item[] = [];
  let bytes = 0;
  for (const it of missing) {
    if (wave.length && bytes + it.size > WAVE_BYTES) {
      waves.push(wave);
      wave = [];
      bytes = 0;
    }
    wave.push(it);
    bytes += it.size;
  }
  if (wave.length) waves.push(wave);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < waves.length && !signal?.aborted) {
      const w = waves[next++]!;
      await Promise.all(
        w.map(async (it) => {
          try {
            await ("far" in it ? readFarEntry(it.far, it.entry) : readAssetFile(it.path));
          } catch (e) {
            failed++;
            console.warn("preload:", e);
          }
          done += it.size;
          progress({ phase: "downloading", doneBytes: done, totalBytes: total });
        }),
      );
    }
  };
  await Promise.all(Array.from({ length: WAVES }, worker));
  aborted();
  return { bytes: total, failed };
}
