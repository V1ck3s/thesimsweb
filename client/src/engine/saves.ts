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
 *   original of the same path, as the overlay does on the server. Forced
 *   when the game files themselves are imported in the browser
 *   (GAME_FILES=client, engine/gamefiles.ts): the originals come from there.
 *
 * The saves database is separate from the asset cache (engine/idb.ts): the
 * cache can be cleared or rebuilt, the saves cannot.
 */

import { getServerConfig } from "./config.js";

export type SaveMode = "server" | "client";

/** Paths the game writes, relative to /assets/ ("Sims/UserData2/Houses/House01.iff"). */
const WRITABLE_PATH = /^Sims\/UserData\d*\//i;

export function isSavePath(path: string): boolean {
  return WRITABLE_PATH.test(path);
}

/** The instance's save mode, asked once per page ("server" when the server does not say). */
export async function getSaveMode(): Promise<SaveMode> {
  return (await getServerConfig()).saves;
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

// --- Export / import (the landing page, client/src/landing/) --------------------

/** A save file of this instance, as listed for the export. */
export interface SaveListing {
  path: string;
  size: number;
  mtime: number;
}

/**
 * Every save file the game wrote: this browser's (client mode), or the
 * server's (server mode: GET /api/saves lists the overlay's files). The
 * unchanged originals of the game folder are not saves and are left out.
 */
export async function listSaves(): Promise<SaveListing[]> {
  if ((await getSaveMode()) === "client") {
    const all = await request<SavedFile[]>("readonly", (s) => s.getAll() as IDBRequest<SavedFile[]>);
    return all.map((f) => ({ path: f.path, size: f.bytes.length, mtime: f.mtime })).sort((a, b) => a.path.localeCompare(b.path));
  }
  const res = await fetch("/api/saves", { cache: "no-store" });
  if (!res.ok) throw new Error(`listing the server's saves failed (${res.status})`);
  return ((await res.json()) as { files: SaveListing[] }).files;
}

function assetUrl(path: string): string {
  return `/assets/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** Runs `fn` over `items`, `limit` at a time. */
async function eachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export type Progress = (done: number, total: number) => void;

/**
 * One ZIP archive (engine/zip.ts) of every save file (listSaves), paths
 * relative to the game folder's parent ("Sims/UserData2/Houses/House01.iff").
 */
export async function exportSaves(onProgress?: Progress): Promise<{ blob: Blob; count: number; bytes: number }> {
  const { zipStore } = await import("./zip.js");
  const list = await listSaves();
  const client = (await getSaveMode()) === "client";
  const entries: Array<{ path: string; bytes: Uint8Array; mtime: number }> = [];
  let done = 0;
  await eachLimited(list, 6, async (f) => {
    let bytes: Uint8Array | null;
    if (client) bytes = await localSaveRead(f.path);
    else {
      const res = await fetch(assetUrl(f.path), { cache: "no-store" });
      if (!res.ok) throw new Error(`${f.path}: ${res.status}`);
      bytes = new Uint8Array(await res.arrayBuffer());
    }
    if (bytes) entries.push({ path: f.path, bytes, mtime: f.mtime });
    onProgress?.(++done, list.length);
  });
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { blob: zipStore(entries), count: entries.length, bytes: entries.reduce((n, e) => n + e.bytes.length, 0) };
}

/**
 * The save path ("Sims/UserData2/...") of an archive member, or null when it
 * is not one. Accepts archives made elsewhere: any folder above the
 * UserData* folder is dropped ("saves/Sims/UserData2/x" and "UserData2/x"
 * both give "Sims/UserData2/x"); ".." anywhere refuses the member.
 */
export function savePathOfArchiveMember(member: string): string | null {
  const parts = member.replace(/\\/g, "/").split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) return null;
  const i = parts.findIndex((p) => /^UserData\d*$/i.test(p));
  if (i < 0 || i === parts.length - 1) return null;
  const path = ["Sims", ...parts.slice(i)].join("/");
  return isSavePath(path) ? path : null;
}

/**
 * Replaces every save file of this instance with the archive's: the saves
 * the archive does not hold are dropped (the game folder's originals show
 * through again), then its files are written. In client mode that is one
 * IndexedDB transaction (all or nothing); in server mode it goes through
 * DELETE and PUT /api/files, file by file. Members outside UserData* are
 * ignored. Refuses an archive without any save file (nothing is changed).
 */
export async function importSaves(archive: Blob, onProgress?: Progress): Promise<{ count: number; ignored: number }> {
  const { unzip } = await import("./zip.js");
  const members = await unzip(new Uint8Array(await archive.arrayBuffer()));
  const files = new Map<string, { path: string; bytes: Uint8Array; mtime: number }>();
  let ignored = 0;
  for (const m of members) {
    const path = savePathOfArchiveMember(m.path);
    if (path) files.set(keyOf(path), { path, bytes: m.bytes, mtime: m.mtime ?? Date.now() });
    else ignored++;
  }
  if (!files.size) throw new Error("this archive holds no save file (no UserData folder)");
  const incoming = [...files.values()];

  if ((await getSaveMode()) === "client") {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      store.clear();
      for (const f of incoming) store.put({ path: f.path, bytes: f.bytes, mtime: f.mtime } satisfies SavedFile, keyOf(f.path));
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("saves: import failed"));
    });
    onProgress?.(incoming.length, incoming.length);
    return { count: incoming.length, ignored };
  }

  const stale = (await listSaves()).filter((f) => !files.has(keyOf(f.path)));
  const total = stale.length + incoming.length;
  let done = 0;
  const api = (path: string): string => `/api/files/${path.split("/").map(encodeURIComponent).join("/")}`;
  await eachLimited(stale, 4, async (f) => {
    const res = await fetch(api(f.path), { method: "DELETE" });
    if (!res.ok) throw new Error(`delete ${f.path}: ${res.status}`);
    onProgress?.(++done, total);
  });
  await eachLimited(incoming, 4, async (f) => {
    const res = await fetch(api(f.path), {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Blob([f.bytes as Uint8Array<ArrayBuffer>]),
    });
    if (!res.ok) throw new Error(`write ${f.path}: ${res.status}`);
    onProgress?.(++done, total);
  });
  return { count: incoming.length, ignored };
}
