/**
 * Where the game's saves live (the files it writes, Sims/UserData*).
 *
 * The server picks one mode per instance (`SAVES` environment variable,
 * GET /api/config, server/src/index.ts):
 *
 * - "server" (default): one shared set of saves on the server, written
 *   through PUT /api/files (the overlay, server/src/routes/userdata.ts).
 * - "client": every browser keeps its own saves in IndexedDB (this module);
 *   the server only serves the game folder, its original UserData* files
 *   included (the starting neighborhoods). A file saved here shadows the
 *   original of the same path, as the overlay does on the server.
 *
 * The saves database is separate from the asset cache (engine/idb.ts): the
 * cache can be cleared or rebuilt, the saves cannot.
 */

export type SaveMode = "server" | "client";

/** Paths the game writes, relative to /assets/ ("Sims/UserData2/Houses/House01.iff"). */
const WRITABLE_PATH = /^Sims\/UserData\d*\//i;

export function isSavePath(path: string): boolean {
  return WRITABLE_PATH.test(path);
}

let mode: Promise<SaveMode> | null = null;

/** The instance's save mode, asked once per page ("server" when the server does not say). */
export function getSaveMode(): Promise<SaveMode> {
  mode ??= (async (): Promise<SaveMode> => {
    try {
      const res = await fetch("/api/config", { cache: "no-store" });
      if (!res.ok) return "server";
      const cfg = (await res.json()) as { saves?: unknown };
      return cfg.saves === "client" ? "client" : "server";
    } catch {
      return "server";
    }
  })();
  return mode;
}

/** Whether saves are kept in this browser (the path is a save path and the instance is in client mode). */
export async function isLocalSave(path: string): Promise<boolean> {
  return isSavePath(path) && (await getSaveMode()) === "client";
}

// --- IndexedDB store ------------------------------------------------------------

const DB_NAME = "thesimsweb-saves";
const DB_VERSION = 1;
const STORE = "files";

/** A saved file; keyed by its lower-cased path (the game folder is case-insensitive). */
interface SavedFile {
  path: string;
  bytes: Uint8Array;
  mtime: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("saves: IndexedDB is not available"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error("saves: open failed"));
    req.onblocked = () => reject(new Error("saves: database blocked by another tab"));
  });
  const p = dbPromise;
  p.catch(() => {
    if (dbPromise === p) dbPromise = null;
  });
  return p;
}

function request<T>(storeMode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, storeMode);
        const req = fn(tx.objectStore(STORE));
        // Writes resolve once committed: a save must be on disk before the game goes on.
        tx.oncomplete = () => resolve(req.result);
        tx.onabort = tx.onerror = () => reject(tx.error ?? req.error ?? new Error("saves: transaction failed"));
      }),
  );
}

const keyOf = (path: string): string => path.toLowerCase();

/** The saved bytes of `path` (relative to /assets/), or null when this browser has not saved it. */
export async function localSaveRead(path: string): Promise<Uint8Array | null> {
  const f = await request<SavedFile | undefined>("readonly", (s) => s.get(keyOf(path)) as IDBRequest<SavedFile | undefined>);
  return f ? f.bytes : null;
}

export async function localSaveWrite(path: string, bytes: Uint8Array): Promise<void> {
  const file: SavedFile = { path, bytes: bytes.slice(), mtime: Date.now() };
  await request("readwrite", (s) => s.put(file, keyOf(path)));
}

/** Drops the saved copy: the original file (if any) shows through again. */
export async function localSaveDelete(path: string): Promise<void> {
  await request("readwrite", (s) => s.delete(keyOf(path)));
}

/** Every file saved in this browser, with its size. */
export async function localSaveList(): Promise<Array<{ path: string; size: number }>> {
  const all = await request<SavedFile[]>("readonly", (s) => s.getAll() as IDBRequest<SavedFile[]>);
  return all.map((f) => ({ path: f.path, size: f.bytes.length }));
}

/**
 * Asks the browser not to evict this site's storage under pressure (the
 * saves would go with it). Best effort: browsers may refuse or ask the user.
 */
export async function requestPersistentStorage(): Promise<void> {
  try {
    if (navigator.storage?.persisted && !(await navigator.storage.persisted())) await navigator.storage.persist?.();
  } catch {
    // not supported
  }
}
