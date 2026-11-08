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

/**
 * A Uint8Array view that does not cover its whole buffer stored as its own
 * bytes: IndexedDB (structured clone) would store the whole buffer.
 */
function ownBytes(value: unknown): unknown {
  return value instanceof Uint8Array && (value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength) ? value.slice() : value;
}

/** The puts of one batch in one readwrite transaction; `done` when it ends (committed or not). */
export function writePuts(db: IDBDatabase, puts: ReadonlyArray<readonly [store: string, key: string, value: unknown, ...rest: unknown[]]>, done: () => void): void {
  try {
    const tx = db.transaction([...new Set(puts.map((p) => p[0]))], "readwrite");
    tx.oncomplete = tx.onabort = () => done();
    for (const [name, key, value] of puts) {
      try {
        // A failed put must not abort the others.
        tx.objectStore(name).put(ownBytes(value), key).onerror = (e) => e.preventDefault();
      } catch {
        // (value that cannot be cloned)
      }
    }
  } catch {
    done();
  }
}

/**
 * The values of one batch of gets, read in one readonly transaction (null for
 * a missing key or a failed get); `done` once every get has answered.
 */
export function readGets(db: IDBDatabase, gets: ReadonlyArray<readonly [store: string, key: string, ...rest: unknown[]]>, done: (values: unknown[]) => void): void {
  const values = new Array<unknown>(gets.length).fill(null);
  let tx: IDBTransaction;
  try {
    tx = db.transaction([...new Set(gets.map((g) => g[0]))], "readonly");
  } catch {
    done(values);
    return;
  }
  let left = gets.length;
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    done(values);
  };
  tx.onabort = finish;
  const answered = (): void => {
    if (--left === 0) finish();
  };
  gets.forEach(([store, key], i) => {
    try {
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => {
        values[i] = req.result ?? null;
        answered();
      };
      req.onerror = (e) => {
        e.preventDefault();
        answered();
      };
    } catch {
      answered();
    }
  });
  if (!gets.length) finish();
}

/**
 * The buffers of the Uint8Arrays in `values` and in arrays within (the
 * portraits' [id, bytes] pairs), each once, to transfer with a message.
 */
export function bufferList(values: Iterable<unknown>, into = new Set<ArrayBuffer>()): Set<ArrayBuffer> {
  for (const v of values) {
    if (v instanceof Uint8Array) {
      if (v.buffer instanceof ArrayBuffer) into.add(v.buffer);
    } else if (Array.isArray(v)) {
      bufferList(v, into);
    }
  }
  return into;
}

/**
 * The worker that does the cache's IndexedDB work (engine/idbworker.ts):
 * IndexedDB copies every value it stores or reads (structured clone) on the
 * calling thread, which was the biggest main-thread cost of a lot load (~1 s
 * of puts for the ~2500 FAR entries and ranges of House01 cold, 0.25..0.4 s of
 * gets warm). Bytes go both ways as transfers (no copy). null when workers
 * are unavailable (the batches are then done here).
 */
let idbWorker: Worker | null | undefined;
const workerBatches = new Map<number, (values?: unknown[]) => void>();
let nextBatch = 1;

function getIdbWorker(): Worker | null {
  if (idbWorker !== undefined) return idbWorker;
  idbWorker = null;
  if (typeof Worker === "undefined" || typeof window === "undefined") return null;
  try {
    const w = new Worker(new URL("./idbworker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<{ batch: number; values?: unknown[] }>) => {
      workerBatches.get(e.data.batch)?.(e.data.values);
      workerBatches.delete(e.data.batch);
    };
    w.onerror = (e) => {
      // A worker that cannot start: later batches are done here, the pending puts are lost (it is a cache), the pending gets answer null.
      e.preventDefault();
      if (idbWorker === w) idbWorker = null;
      for (const done of workerBatches.values()) done();
      workerBatches.clear();
      w.terminate();
    };
    idbWorker = w;
  } catch {
    idbWorker = null;
  }
  return idbWorker;
}

/**
 * Asset bytes arrive in bursts (a lot loading hundreds of FAR entries, a
 * catalog page of icons): the puts issued in one task share one transaction
 * instead of one each, which Chrome commits much faster. `transfer`: the
 * value is a Uint8Array whose buffer the caller does not keep (it is handed
 * to the worker and becomes unusable here); it may be a view on part of a
 * buffer (the buffer is handed over, the view's bytes are stored).
 */
function queuePut(store: string, key: string, value: unknown, transfer = false): Promise<void> {
  queuedPuts.push([store, key, value, transfer]);
  queuedPutsDone ??= new Promise<void>((done) => {
    setTimeout(() => {
      const puts = queuedPuts;
      queuedPuts = [];
      queuedPutsDone = null;
      const w = getIdbWorker();
      if (w) {
        const batch = nextBatch++;
        const buffers = bufferList(puts.filter((p) => p[3]).map((p) => p[2]));
        try {
          workerBatches.set(batch, () => done());
          w.postMessage({ batch, puts: puts.map(([s, k, v]) => [s, k, v]) }, [...buffers]);
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
 * cost of a cold lot load), read by the worker (the values come back in one
 * message, bytes transferred) or, without it, here. Every get of a batch
 * answers at once, in one task: the misses of a cold load then ask the range
 * batcher (engine/assets.ts) for their bytes together. A failed get answers null.
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
      const answer = (values?: unknown[]): void => gets.forEach((g, i) => g[2](values?.[i] ?? null));
      const w = getIdbWorker();
      if (w) {
        const batch = nextBatch++;
        try {
          workerBatches.set(batch, answer);
          w.postMessage({ batch, gets: gets.map(([s, k]) => [s, k]) });
          return;
        } catch {
          workerBatches.delete(batch);
        }
      }
      void openDb().then((db) => {
        if (!db) return answer();
        readGets(db, gets, answer);
      });
    });
  });
}

export async function idbGetFarManifest(farPath: string): Promise<unknown | null> {
  return (await queueGet(STORE_FAR_MANIFEST, farPath)) ?? null;
}

export async function idbPutFarManifest(farPath: string, value: unknown): Promise<void> {
  await queuePut(STORE_FAR_MANIFEST, farPath, value);
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

/**
 * The keys of the FAR entries ("farPath|entry", entry lower-cased) and of the
 * whole files (game paths) kept in the cache, without their bytes: what the
 * preloader (engine/preload.ts) does not need to download. Empty sets when
 * IndexedDB is unavailable.
 */
export async function idbCachedKeys(): Promise<{ entries: Set<string>; files: Set<string> }> {
  const [entries, files] = await Promise.all([
    withStore<IDBValidKey[]>(STORE_FAR_ENTRY, "readonly", (s) => s.getAllKeys()),
    withStore<IDBValidKey[]>(STORE_IFF_FILE, "readonly", (s) => s.getAllKeys()),
  ]);
  const strings = (keys: IDBValidKey[] | null): Set<string> => new Set((keys ?? []).filter((k): k is string => typeof k === "string"));
  return { entries: strings(entries), files: strings(files) };
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
