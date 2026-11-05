/**
 * The game files imported into this browser (GAME_FILES=client, engine/config.ts).
 *
 * On such an instance the server never serves a game file: each player
 * selects their own install folder of The Sims (Complete Collection) on the
 * landing page (client/src/landing/), and the files the game reads are copied
 * into IndexedDB, as Blobs. engine/assets.ts then answers the manifest, the
 * whole-file reads and the range reads from here instead of /assets/.
 *
 * Database "thesimsweb-gamefiles", separate from the asset cache
 * (engine/idb.ts, rebuildable) and from the saves (engine/saves.ts, which
 * keep shadowing the UserData* originals stored here):
 *
 * - store "files": one record per file, keyed by its lower-cased path (the
 *   game folder is case-insensitive), path relative to /assets/ as the
 *   server's manifest gives it ("Sims/GameData/Behavior.iff");
 * - store "meta": "state" (import in progress or complete), "index" (the
 *   file list of a complete import: the manifest), "handle" (the folder
 *   picked with the File System Access API, when the browser has it, to
 *   resume an import after a reload without picking it again).
 *
 * An import copies only the files whose size or date changed since the last
 * one (so an interrupted import resumes where it stopped) and drops the files
 * no longer in the folder. The game starts only once an import is complete.
 */

import { getServerConfig } from "./config.js";

/** Whether this instance takes its game files from this browser (GAME_FILES=client). */
export async function isGameFilesLocal(): Promise<boolean> {
  return (await getServerConfig()).gameFiles === "client";
}

// --- Database -------------------------------------------------------------------

const DB_NAME = "thesimsweb-gamefiles";
const DB_VERSION = 1;
const FILES = "files";
const META = "meta";

interface StoredFile {
  /** Relative to /assets/, original case ("Sims/GameData/Behavior.iff"). */
  path: string;
  size: number;
  /** lastModified of the source file (an unchanged file is not copied again). */
  mtime: number;
  blob: Blob;
}

export interface IndexedFile {
  path: string;
  size: number;
}

interface GameIndex {
  files: IndexedFile[];
  bytes: number;
  finishedAt: number;
  /** The selected folder's name. */
  source: string;
}

interface ImportState {
  complete: boolean;
  startedAt: number;
  source: string;
  /** Files and bytes the import copies or keeps (the whole set). */
  fileCount: number;
  bytes: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available in this browser"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      for (const name of [FILES, META]) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error("game files: open failed"));
    req.onblocked = () => reject(new Error("game files: database blocked by another tab"));
  });
  const p = dbPromise;
  p.catch(() => {
    if (dbPromise === p) dbPromise = null;
  });
  return p;
}

function request<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve(req.result);
        tx.onabort = tx.onerror = () => reject(tx.error ?? req.error ?? new Error("game files: transaction failed"));
      }),
  );
}

const keyOf = (path: string): string => path.toLowerCase();

// --- Reading (engine/assets.ts) -------------------------------------------------

let index: Promise<GameIndex | null> | null = null;
const blobs = new Map<string, Promise<Blob | null>>();

/** The imported files (the manifest), or null when no import is complete. Read once per page. */
export function localGameIndex(): Promise<IndexedFile[] | null> {
  index ??= request<GameIndex | undefined>(META, "readonly", (s) => s.get("index") as IDBRequest<GameIndex | undefined>).then(
    (i) => i ?? null,
    () => null,
  );
  return index.then((i) => i?.files ?? null);
}

/** The stored file `path` (relative to /assets/, any case), or null when it was not imported. */
function localBlob(path: string): Promise<Blob | null> {
  const key = keyOf(path);
  let p = blobs.get(key);
  if (!p) {
    p = request<StoredFile | undefined>(FILES, "readonly", (s) => s.get(key) as IDBRequest<StoredFile | undefined>).then((f) => f?.blob ?? null);
    blobs.set(key, p);
    p.catch(() => {
      if (blobs.get(key) === p) blobs.delete(key);
    });
  }
  return p;
}

/** The imported file `path` as a Blob (not read), or null when it was not imported. */
export function localGameBlob(path: string): Promise<Blob | null> {
  return localBlob(path);
}

/** Size of the imported file `path`, or null when it was not imported. */
export async function localGameSize(path: string): Promise<number | null> {
  return (await localBlob(path))?.size ?? null;
}

/** The whole imported file `path`, or null when it was not imported. */
export async function localGameRead(path: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const blob = await localBlob(path);
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

/**
 * Bytes [start, end) of the imported file `path`, cut at the end of the file
 * (as a `Range` request). Throws where that request would fail: no such
 * file (404), `start` at or past the end (416).
 */
export async function localGameRange(path: string, start: number, end: number): Promise<Uint8Array<ArrayBuffer>> {
  const blob = await localBlob(path);
  if (!blob) throw new Error(`${path}: 404`);
  if (start >= blob.size) throw new Error(`${path} ${start}-${end}: 416`);
  return new Uint8Array(await blob.slice(start, Math.min(end, blob.size)).arrayBuffer());
}

// --- Checking a folder --------------------------------------------------------------

/** A file of the folder the player selected. */
export interface SourceFile {
  /** Path inside the selection, "/"-separated ("Les Sims/GameData/Behavior.iff"). */
  rel: string;
  size: number;
  mtime: number;
  file: () => Promise<File>;
}

/**
 * Files the game needs, relative to the install folder: the base game and
 * the seven expansion packs of the Complete Collection, and the original
 * neighborhood.
 */
export const REQUIRED_FILES = [
  "GameData/Behavior.iff",
  "GameData/Global/Global.far",
  "GameData/Objects/Objects.far",
  "GameData/Animation/Animation.far",
  "GameData/Textures/Textures.far",
  "UIGraphics/UIGraphics.far",
  "SoundData/SoundData.far",
  "ExpansionShared/ExpansionShared.far",
  "ExpansionPack/ExpansionPack.far",
  "ExpansionPack2/ExpansionPack2.far",
  "ExpansionPack3/ExpansionPack3.far",
  "ExpansionPack4/ExpansionPack4.far",
  "ExpansionPack5/ExpansionPack5.far",
  "ExpansionPack6/ExpansionPack6.far",
  "ExpansionPack7/ExpansionPack7.far",
  "UserData/Neighborhood.iff",
];

/** Extensions of the files the game never reads (programs, libraries, logs, installers, intro movies). */
const SKIPPED_EXT = new Set(["exe", "dll", "log", "cab", "jar", "avi", "tmp", "bak"]);
const SKIPPED_NAME = new Set(["thumbs.db", "desktop.ini", ".ds_store"]);

/** Whether the game reads `rel` (relative to the install folder). */
function isGameFile(rel: string): boolean {
  const parts = rel.toLowerCase().split("/");
  // Files at the top of the install (the program, its libraries, logs) and the support/ folder (help, registration).
  if (parts.length < 2 || parts[0] === "support") return false;
  const name = parts[parts.length - 1]!;
  if (SKIPPED_NAME.has(name)) return false;
  const dot = name.lastIndexOf(".");
  return dot < 0 || !SKIPPED_EXT.has(name.slice(dot + 1));
}

export interface ImportPlan {
  /** The install folder's name ("Les Sims"). */
  source: string;
  /** The files to store, path relative to /assets/ ("Sims/GameData/Behavior.iff"). */
  files: Array<{ path: string; size: number; mtime: number; file: () => Promise<File> }>;
  bytes: number;
  /** Files of the folder left out (programs, support/...). */
  skipped: number;
}

/**
 * Checks that `files` hold an install of The Sims (Complete Collection) and
 * lists what to import. The selection may be the install folder itself or a
 * folder above it. Throws with a message for the player when it is not one.
 */
export function planImport(files: readonly SourceFile[]): ImportPlan {
  // The install folder: the shallowest one holding GameData/Behavior.iff.
  let root: string | null = null;
  for (const f of files) {
    const lower = f.rel.toLowerCase();
    if (lower !== "gamedata/behavior.iff" && !lower.endsWith("/gamedata/behavior.iff")) continue;
    const r = f.rel.slice(0, f.rel.length - "gamedata/behavior.iff".length);
    if (root === null || r.length < root.length) root = r;
  }
  if (root === null) {
    throw new Error('this folder is not an install of The Sims: it has no "GameData/Behavior.iff". Select the folder that holds GameData, ExpansionShared, UserData…');
  }
  const present = new Set<string>();
  const plan: ImportPlan = { source: root.split("/").filter(Boolean).pop() ?? "", files: [], bytes: 0, skipped: 0 };
  for (const f of files) {
    if (!f.rel.toLowerCase().startsWith(root.toLowerCase())) continue;
    const rel = f.rel.slice(root.length);
    present.add(rel.toLowerCase());
    if (!isGameFile(rel)) {
      plan.skipped++;
      continue;
    }
    plan.files.push({ path: `Sims/${rel}`, size: f.size, mtime: f.mtime, file: f.file });
    plan.bytes += f.size;
  }
  const missing = REQUIRED_FILES.filter((p) => !present.has(p.toLowerCase()));
  if (missing.length) {
    throw new Error(
      `this install of The Sims is not a Complete Collection: ${missing.length} required file${missing.length > 1 ? "s are" : " is"} missing (${missing.slice(0, 4).join(", ")}${missing.length > 4 ? "…" : ""}).`,
    );
  }
  if (!plan.source) plan.source = "The Sims";
  return plan;
}

/** The files of an `<input type="file" webkitdirectory>` selection. */
export function sourceFromInput(list: FileList): SourceFile[] {
  return Array.from(list, (f) => ({ rel: (f.webkitRelativePath || f.name).replace(/\\/g, "/"), size: f.size, mtime: f.lastModified, file: () => Promise.resolve(f) }));
}

// The File System Access API (Chrome, Edge): an optional enhancement. The
// folder handle is kept, so an interrupted import resumes after a reload
// without selecting the folder again. Not in TypeScript's DOM library
// (the async iteration of a folder): declared here.
interface DirHandle {
  kind: "directory";
  name: string;
  values(): AsyncIterable<DirHandle | FileHandle>;
  queryPermission?(o: { mode: "read" }): Promise<PermissionState>;
  requestPermission?(o: { mode: "read" }): Promise<PermissionState>;
}
interface FileHandle {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
}
type PickerWindow = Window & { showDirectoryPicker?: (o?: { id?: string; mode?: "read" }) => Promise<DirHandle> };

/** Whether the browser can pick a folder with the File System Access API. */
export function hasFolderPicker(): boolean {
  return typeof (window as PickerWindow).showDirectoryPicker === "function";
}

/** Shows the browser's folder picker (hasFolderPicker); rejects with an AbortError when the player cancels. */
export async function pickFolder(): Promise<unknown> {
  const pick = (window as PickerWindow).showDirectoryPicker;
  if (!pick) throw new Error("this browser has no folder picker");
  return pick.call(window, { id: "thesims", mode: "read" });
}

/** The files under a folder handle (pickFolder), read one by one. */
export async function sourceFromHandle(handle: unknown, onCount?: (n: number) => void): Promise<SourceFile[]> {
  const dir = handle as DirHandle;
  const out: SourceFile[] = [];
  const walk = async (d: DirHandle, prefix: string): Promise<void> => {
    for await (const h of d.values()) {
      const rel = `${prefix}${h.name}`;
      if (h.kind === "directory") {
        // (skipped wholesale: the only big folder the game never reads)
        if (prefix === `${dir.name}/` && h.name.toLowerCase() === "support") continue;
        await walk(h, `${rel}/`);
      } else {
        const f = await h.getFile();
        out.push({ rel, size: f.size, mtime: f.lastModified, file: () => h.getFile() });
        if (out.length % 200 === 0) onCount?.(out.length);
      }
    }
  };
  await walk(dir, `${dir.name}/`);
  return out;
}

/** Keeps the picked folder to resume an import after a reload (best effort). */
export async function rememberFolder(handle: unknown): Promise<void> {
  await request(META, "readwrite", (s) => s.put(handle, "handle")).catch(() => undefined);
}

/** Whether a folder picked with the folder picker is kept (rememberedFolder may then give it back). */
export async function hasRememberedFolder(): Promise<boolean> {
  const handle = await request<unknown>(META, "readonly", (s) => s.get("handle")).catch(() => undefined);
  return (handle as DirHandle | undefined)?.kind === "directory";
}

/**
 * The folder of an import left incomplete, when it was picked with the
 * folder picker and the browser still allows reading it (asking the player
 * when needed: call from a click). Null otherwise.
 */
export async function rememberedFolder(ask: boolean): Promise<unknown> {
  const handle = await request<unknown>(META, "readonly", (s) => s.get("handle")).catch(() => undefined);
  const dir = handle as DirHandle | undefined;
  if (!dir || dir.kind !== "directory") return null;
  try {
    if ((await dir.queryPermission?.({ mode: "read" })) === "granted") return dir;
    if (ask && (await dir.requestPermission?.({ mode: "read" })) === "granted") return dir;
  } catch {
    // (permission API missing or refused)
  }
  return null;
}

// --- Importing --------------------------------------------------------------------

export interface ImportProgress {
  /** Bytes and files of the set already in this browser (kept or copied). */
  doneBytes: number;
  totalBytes: number;
  doneFiles: number;
  totalFiles: number;
  /** The file being copied. */
  current: string;
}

/** Most bytes and files per transaction: a transaction is committed (kept on disk) as one. */
const BATCH_BYTES = 64 * 1024 * 1024;
const BATCH_FILES = 200;

/**
 * Copies the files of `plan` into this browser: the files already stored
 * with the same size and date are kept, the others copied, the stored files
 * no longer in the folder dropped. Resumable: what was copied before an
 * interruption (a reload, `signal`) is kept, and the next import of the same
 * folder copies the rest. The game sees the new set once this resolves.
 */
export async function importGameFiles(plan: ImportPlan, onProgress?: (p: ImportProgress) => void, signal?: AbortSignal): Promise<void> {
  // Ask the browser not to evict ~3 GB under storage pressure (best effort).
  try {
    if (navigator.storage?.persisted && !(await navigator.storage.persisted())) await navigator.storage.persist?.();
  } catch {
    // not supported
  }

  // What is stored already (path, size and date only: the Blobs are not read).
  const stored = new Map<string, { size: number; mtime: number }>();
  await openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(FILES, "readonly");
        const cur = tx.objectStore(FILES).openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c) return;
          const v = c.value as StoredFile;
          stored.set(c.key as string, { size: v.size, mtime: v.mtime });
          c.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("game files: listing failed"));
      }),
  );

  const wanted = new Map(plan.files.map((f) => [keyOf(f.path), f]));
  const stale = [...stored.keys()].filter((k) => !wanted.has(k));
  const todo = plan.files.filter((f) => {
    const s = stored.get(keyOf(f.path));
    return !s || s.size !== f.size || s.mtime !== f.mtime;
  });

  // From now on the stored set is not a complete import: the game waits for the end.
  const state: ImportState = { complete: false, startedAt: Date.now(), source: plan.source, fileCount: plan.files.length, bytes: plan.bytes };
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([FILES, META], "readwrite");
    tx.objectStore(META).put(state, "state");
    tx.objectStore(META).delete("index");
    for (const k of stale) tx.objectStore(FILES).delete(k);
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("game files: import failed"));
  });
  index = null;
  blobs.clear();

  const progress: ImportProgress = {
    doneBytes: plan.bytes - todo.reduce((n, f) => n + f.size, 0),
    totalBytes: plan.bytes,
    doneFiles: plan.files.length - todo.length,
    totalFiles: plan.files.length,
    current: "",
  };
  onProgress?.({ ...progress });

  let i = 0;
  while (i < todo.length) {
    if (signal?.aborted) throw new DOMException("import stopped", "AbortError");
    // One transaction per batch of files, read beforehand (a transaction
    // cannot wait for a file read without committing).
    const batch: StoredFile[] = [];
    let bytes = 0;
    while (i < todo.length && batch.length < BATCH_FILES && (batch.length === 0 || bytes + todo[i]!.size <= BATCH_BYTES)) {
      const f = todo[i++]!;
      progress.current = f.path;
      onProgress?.({ ...progress });
      let file: File;
      try {
        file = await f.file();
      } catch (e) {
        throw new Error(`${f.path}: cannot be read (${(e as Error).message}); select the folder again`);
      }
      batch.push({ path: f.path, size: f.size, mtime: f.mtime, blob: file });
      bytes += f.size;
    }
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(FILES, "readwrite");
      const store = tx.objectStore(FILES);
      for (const rec of batch) store.put(rec, keyOf(rec.path));
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => {
        const err = tx.error;
        reject(
          err?.name === "QuotaExceededError"
            ? new Error("the browser has no room left for the game files (about 3.2 GB are needed): free disk space or allow this site more storage, then select the folder again to resume")
            : (err ?? new Error("game files: write failed")),
        );
      };
    });
    progress.doneBytes += bytes;
    progress.doneFiles += batch.length;
    onProgress?.({ ...progress });
  }

  const done: GameIndex = {
    files: plan.files.map((f) => ({ path: f.path, size: f.size })).sort((a, b) => a.path.localeCompare(b.path)),
    bytes: plan.bytes,
    finishedAt: Date.now(),
    source: plan.source,
  };
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(META, "readwrite");
    tx.objectStore(META).put({ ...state, complete: true } satisfies ImportState, "state");
    tx.objectStore(META).put(done, "index");
    tx.objectStore(META).delete("handle");
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("game files: import failed"));
  });
  index = null;
}

export type GameFilesStatus =
  | { state: "none" }
  | { state: "partial"; source: string; startedAt: number; fileCount: number; bytes: number; storedFiles: number; storedBytes: number }
  | { state: "complete"; source: string; finishedAt: number; fileCount: number; bytes: number };

/** What this browser holds (the landing page). */
export async function gameFilesStatus(): Promise<GameFilesStatus> {
  const [state, idx] = await Promise.all([
    request<ImportState | undefined>(META, "readonly", (s) => s.get("state") as IDBRequest<ImportState | undefined>),
    request<GameIndex | undefined>(META, "readonly", (s) => s.get("index") as IDBRequest<GameIndex | undefined>),
  ]);
  if (idx) return { state: "complete", source: idx.source, finishedAt: idx.finishedAt, fileCount: idx.files.length, bytes: idx.bytes };
  if (!state) return { state: "none" };
  let storedFiles = 0;
  let storedBytes = 0;
  const db = await openDb();
  await new Promise<void>((resolve) => {
    const tx = db.transaction(FILES, "readonly");
    const cur = tx.objectStore(FILES).openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return;
      storedFiles++;
      storedBytes += (c.value as StoredFile).size;
      c.continue();
    };
    tx.oncomplete = tx.onabort = tx.onerror = () => resolve();
  });
  return { state: "partial", source: state.source, startedAt: state.startedAt, fileCount: state.fileCount, bytes: state.bytes, storedFiles, storedBytes };
}

/** Removes every imported file from this browser (the saves stay). */
export async function removeGameFiles(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([FILES, META], "readwrite");
    tx.objectStore(FILES).clear();
    tx.objectStore(META).clear();
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("game files: removal failed"));
  });
  index = null;
  blobs.clear();
}
