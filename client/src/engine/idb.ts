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
/** 3: + the "ranges" store; 4: + the "portraits" store. */
const DB_VERSION = 4;

const STORE_FAR_MANIFEST = "farManifests";
const STORE_FAR_ENTRY = "farEntries";
/** Whole files by game path (the store kept its first name: it held standalone IFFs only). */
const STORE_IFF_FILE = "iffFiles";
/** Byte ranges of game files, keyed "path|start|end". */
const STORE_RANGE = "ranges";
/**
 * Person pictures rendered from body strings (cas/portraits.ts), keyed by
 * a version tag and the body strings: [BMP_ id, 24-bit BMP bytes][].
 */
const STORE_PORTRAITS = "portraits";
const STORES = [STORE_FAR_MANIFEST, STORE_FAR_ENTRY, STORE_IFF_FILE, STORE_RANGE, STORE_PORTRAITS];

let dbPromise: Promise<IDBDatabase | null> | null = null;

export function openDb(): Promise<IDBDatabase | null> {
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

type QueuedPut = [store: string, key: string, value: unknown, transfer: boolean];

let queuedPuts: QueuedPut[] = [];
let queuedPutsDone: Promise<void> | null = null;

/** The puts of one batch in one readwrite transaction; `done` when it ends (committed or not). */
export function writePuts(db: IDBDatabase, puts: ReadonlyArray<readonly [store: string, key: string, value: unknown, ...rest: unknown[]]>, done: () => void): void {
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
}

/**
 * The worker that writes the batches (engine/idbworker.ts): IndexedDB copies
 * every value it stores (structured clone) on the calling thread, which was
 * the biggest main-thread cost of a cold lot load (~1 s for the ~2500 FAR
 * entries and ranges of House01). Bytes handed over with `transfer` move to
 * the worker without a copy. null when workers are unavailable (the batches
 * are then written here).
 */
let putWorker: Worker | null | undefined;
const workerBatches = new Map<number, () => void>();
let nextBatch = 1;

function getPutWorker(): Worker | null {
  if (putWorker !== undefined) return putWorker;
  putWorker = null;
  if (typeof Worker === "undefined" || typeof window === "undefined") return null;
  try {
    const w = new Worker(new URL("./idbworker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<{ batch: number }>) => {
      workerBatches.get(e.data.batch)?.();
      workerBatches.delete(e.data.batch);
    };
    w.onerror = (e) => {
      // A worker that cannot start: later batches are written here, the pending ones are lost (it is a cache).
      e.preventDefault();
      if (putWorker === w) putWorker = null;
      for (const done of workerBatches.values()) done();
      workerBatches.clear();
      w.terminate();
    };
    putWorker = w;
  } catch {
    putWorker = null;
  }
  return putWorker;
}

/**
 * Asset bytes arrive in bursts (a lot loading hundreds of FAR entries, a
 * catalog page of icons): the puts issued in one task share one transaction
 * instead of one each, which Chrome commits much faster. `transfer`: the
 * value is a Uint8Array the caller does not keep (its buffer is handed to the
 * writer worker and becomes unusable here).
 */
function queuePut(store: string, key: string, value: unknown, transfer = false): Promise<void> {
  queuedPuts.push([store, key, value, transfer]);
  queuedPutsDone ??= new Promise<void>((done) => {
    setTimeout(() => {
      const puts = queuedPuts;
      queuedPuts = [];
      queuedPutsDone = null;
      const w = getPutWorker();
      if (w) {
        const batch = nextBatch++;
        const buffers: ArrayBuffer[] = [];
        for (const [, , v, t] of puts) {
          // Only a buffer the view covers whole (a fresh copy) is moved.
          if (t && v instanceof Uint8Array && v.buffer instanceof ArrayBuffer && v.byteOffset === 0 && v.byteLength === v.buffer.byteLength && !buffers.includes(v.buffer)) buffers.push(v.buffer);
        }
        try {
          workerBatches.set(batch, done);
          w.postMessage({ batch, puts: puts.map(([s, k, v]) => [s, k, v]) }, buffers);
          return;
        } catch {
          workerBatches.delete(batch);
          // (a value the worker cannot receive: written here)
        }
      }
      void openDb().then((db) => {
        if (!db) return done();
        writePuts(db, puts, done);
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

/** `bytes` is handed over (pass a copy the caller does not keep). */
export async function idbPutFarEntry(
  farPath: string,
  entryName: string,
  bytes: Uint8Array,
): Promise<void> {
  await queuePut(STORE_FAR_ENTRY, `${farPath}|${entryName.toLowerCase()}`, bytes, true);
}

export async function idbGetIffFile(path: string): Promise<Uint8Array | null> {
  const result = await queueGet(STORE_IFF_FILE, path);
  return result instanceof Uint8Array ? result : null;
}

/** `bytes` is handed over (pass a copy the caller does not keep). */
export async function idbPutIffFile(path: string, bytes: Uint8Array): Promise<void> {
  await queuePut(STORE_IFF_FILE, path, bytes, true);
}

export async function idbGetRange(path: string, start: number, end: number): Promise<Uint8Array | null> {
  const result = await queueGet(STORE_RANGE, `${path}|${start}|${end}`);
  return result instanceof Uint8Array ? result : null;
}

/** `bytes` is handed over (pass a copy the caller does not keep). */
export async function idbPutRange(path: string, start: number, end: number, bytes: Uint8Array): Promise<void> {
  await queuePut(STORE_RANGE, `${path}|${start}|${end}`, bytes, true);
}

export async function idbGetPortraits(key: string): Promise<Array<[number, Uint8Array]> | null> {
  const result = await queueGet(STORE_PORTRAITS, key);
  return Array.isArray(result) && result.every((e) => Array.isArray(e) && typeof e[0] === "number" && e[1] instanceof Uint8Array)
    ? (result as Array<[number, Uint8Array]>)
    : null;
}

export async function idbPutPortraits(key: string, bitmaps: Array<[number, Uint8Array]>): Promise<void> {
  await queuePut(STORE_PORTRAITS, key, bitmaps);
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
