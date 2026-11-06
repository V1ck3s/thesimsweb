/**
 * IndexedDB asset cache. Persists FAR manifests, FAR entries, whole game files
 * (standalone IFFs and other loose files) and byte ranges of game files across
 * page reloads so cold start only pays the network cost once.
 *
 * Schema is bumped via DB_VERSION; an upgrade adds the missing stores and
 * keeps the others. There is no per-entry invalidation (the game folder is
 * read-only; files the game writes, Sims/UserData*, are never stored: see
 * engine/assets.ts) — the user can clear via DevTools or via
 * `clearAssetCache()` exported from this module.
 */

const DB_NAME = "thesimsweb-assets";
/** 3: + the "ranges" store. */
const DB_VERSION = 3;

const STORE_FAR_MANIFEST = "farManifests";
const STORE_FAR_ENTRY = "farEntries";
/** Whole files by game path (the store kept its first name: it held standalone IFFs only). */
const STORE_IFF_FILE = "iffFiles";
/** Byte ranges of game files, keyed "path|start|end". */
const STORE_RANGE = "ranges";
const STORES = [STORE_FAR_MANIFEST, STORE_FAR_ENTRY, STORE_IFF_FILE, STORE_RANGE];

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name);
        }
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // A newer page asks for a schema upgrade: let it through (this page then runs without the cache).
      db.onversionchange = () => {
        db.close();
        dbPromise = Promise.resolve(null);
      };
      resolve(db);
    };
    req.onerror = () => {
      console.warn("idb: open failed, falling back to memory cache only", req.error);
      resolve(null);
    };
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

async function withStore<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(store, mode);
      tx.onabort = () => resolve(null);
      const req = fn(tx.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      // closed database, values that cannot be cloned...
      resolve(null);
    }
  });
}

let queuedPuts: Array<[store: string, key: string, value: Uint8Array]> = [];
let queuedPutsDone: Promise<void> | null = null;

/**
 * Asset bytes arrive in bursts (a lot loading hundreds of FAR entries, a
 * catalog page of icons): the puts issued in one task share one transaction
 * instead of one each, which Chrome commits much faster.
 */
function queuePut(store: string, key: string, value: Uint8Array): Promise<void> {
  queuedPuts.push([store, key, value]);
  queuedPutsDone ??= new Promise<void>((done) => {
    setTimeout(() => {
      const puts = queuedPuts;
      queuedPuts = [];
      queuedPutsDone = null;
      void openDb().then((db) => {
        if (!db) return done();
        try {
          const tx = db.transaction([...new Set(puts.map((p) => p[0]))], "readwrite");
          tx.oncomplete = tx.onabort = () => done();
          for (const [name, key, value] of puts) {
            try {
              // A failed put must not abort the others.
              tx.objectStore(name).put(value, key).onerror = (e) => e.preventDefault();
            } catch {
              // (value that cannot be cloned)
            }
          }
        } catch {
          done();
        }
      });
    }, 0);
  });
  return queuedPutsDone;
}

let queuedGets: Array<[store: string, key: string, resolve: (v: unknown) => void]> = [];
let getsScheduled = false;

/**
 * Reads come in the same bursts as the puts (a lot load looks up ~2000 FAR
 * entries): the gets issued in one task share one readonly transaction
 * instead of one each (a transaction per get was the biggest main-thread
 * cost of a cold lot load). Each get still answers on its own; a failed one
 * answers null.
 */
function queueGet(store: string, key: string): Promise<unknown> {
  return new Promise((resolve) => {
    queuedGets.push([store, key, resolve]);
    if (getsScheduled) return;
    getsScheduled = true;
    queueMicrotask(() => {
      const gets = queuedGets;
      queuedGets = [];
      getsScheduled = false;
      void openDb().then((db) => {
        if (!db) {
          for (const g of gets) g[2](null);
          return;
        }
        let tx: IDBTransaction;
        try {
          tx = db.transaction([...new Set(gets.map((g) => g[0]))], "readonly");
        } catch {
          for (const g of gets) g[2](null);
          return;
        }
        const pending = new Set(gets);
        tx.onabort = () => {
          for (const g of pending) g[2](null);
        };
        for (const g of gets) {
          try {
            const req = tx.objectStore(g[0]).get(g[1]);
            req.onsuccess = () => {
              pending.delete(g);
              g[2](req.result);
            };
            req.onerror = (e) => {
              e.preventDefault();
              pending.delete(g);
              g[2](null);
            };
          } catch {
            pending.delete(g);
            g[2](null);
          }
        }
      });
    });
  });
}

export async function idbGetFarManifest(farPath: string): Promise<unknown | null> {
  return (await queueGet(STORE_FAR_MANIFEST, farPath)) ?? null;
}

export async function idbPutFarManifest(farPath: string, value: unknown): Promise<void> {
  await withStore(STORE_FAR_MANIFEST, "readwrite", (s) => s.put(value, farPath));
}

export async function idbGetFarEntry(
  farPath: string,
  entryName: string,
): Promise<Uint8Array | null> {
  const key = `${farPath}|${entryName.toLowerCase()}`;
  const result = await queueGet(STORE_FAR_ENTRY, key);
  return result instanceof Uint8Array ? result : null;
}

export async function idbPutFarEntry(
  farPath: string,
  entryName: string,
  bytes: Uint8Array,
): Promise<void> {
  await queuePut(STORE_FAR_ENTRY, `${farPath}|${entryName.toLowerCase()}`, bytes);
}

export async function idbGetIffFile(path: string): Promise<Uint8Array | null> {
  const result = await queueGet(STORE_IFF_FILE, path);
  return result instanceof Uint8Array ? result : null;
}

export async function idbPutIffFile(path: string, bytes: Uint8Array): Promise<void> {
  await queuePut(STORE_IFF_FILE, path, bytes);
}

export async function idbGetRange(path: string, start: number, end: number): Promise<Uint8Array | null> {
  const result = await queueGet(STORE_RANGE, `${path}|${start}|${end}`);
  return result instanceof Uint8Array ? result : null;
}

export async function idbPutRange(path: string, start: number, end: number, bytes: Uint8Array): Promise<void> {
  await queuePut(STORE_RANGE, `${path}|${start}|${end}`, bytes);
}

export async function idbStats(): Promise<{ manifests: number; entries: number; iffs: number }> {
  const counts = await Promise.all([
    withStore<number>(STORE_FAR_MANIFEST, "readonly", (s) => s.count()),
    withStore<number>(STORE_FAR_ENTRY, "readonly", (s) => s.count()),
    withStore<number>(STORE_IFF_FILE, "readonly", (s) => s.count()),
  ]);
  return {
    manifests: counts[0] ?? 0,
    entries: counts[1] ?? 0,
    iffs: counts[2] ?? 0,
  };
}

export async function clearAssetCache(): Promise<void> {
  for (const name of STORES) {
    await withStore(name, "readwrite", (s) => s.clear());
  }
}
