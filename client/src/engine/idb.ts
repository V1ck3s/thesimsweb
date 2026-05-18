/**
 * IndexedDB asset cache. Persists FAR manifests, FAR entries, and standalone IFF
 * payloads across page reloads so cold start only pays the network cost once.
 *
 * Schema is bumped via DB_VERSION; on open mismatch we wipe and rebuild. There
 * is no per-entry invalidation — the user can clear via DevTools or via
 * `clearAssetCache()` exported from this module.
 */

const DB_NAME = "thesimsweb-assets";
const DB_VERSION = 2;

const STORE_FAR_MANIFEST = "farManifests";
const STORE_FAR_ENTRY = "farEntries";
const STORE_IFF_FILE = "iffFiles";
const STORE_SAVES = "saves";

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of [STORE_FAR_MANIFEST, STORE_FAR_ENTRY, STORE_IFF_FILE, STORE_SAVES]) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name);
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
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
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

export async function idbGetFarManifest(farPath: string): Promise<unknown | null> {
  return withStore(STORE_FAR_MANIFEST, "readonly", (s) => s.get(farPath));
}

export async function idbPutFarManifest(farPath: string, value: unknown): Promise<void> {
  await withStore(STORE_FAR_MANIFEST, "readwrite", (s) => s.put(value, farPath));
}

export async function idbGetFarEntry(
  farPath: string,
  entryName: string,
): Promise<Uint8Array | null> {
  const key = `${farPath}|${entryName.toLowerCase()}`;
  const result = await withStore<unknown>(STORE_FAR_ENTRY, "readonly", (s) => s.get(key));
  return result instanceof Uint8Array ? result : null;
}

export async function idbPutFarEntry(
  farPath: string,
  entryName: string,
  bytes: Uint8Array,
): Promise<void> {
  const key = `${farPath}|${entryName.toLowerCase()}`;
  await withStore(STORE_FAR_ENTRY, "readwrite", (s) => s.put(bytes, key));
}

export async function idbGetIffFile(path: string): Promise<Uint8Array | null> {
  const result = await withStore<unknown>(STORE_IFF_FILE, "readonly", (s) => s.get(path));
  return result instanceof Uint8Array ? result : null;
}

export async function idbPutIffFile(path: string, bytes: Uint8Array): Promise<void> {
  await withStore(STORE_IFF_FILE, "readwrite", (s) => s.put(bytes, path));
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
  for (const name of [STORE_FAR_MANIFEST, STORE_FAR_ENTRY, STORE_IFF_FILE]) {
    await withStore(name, "readwrite", (s) => s.clear());
  }
}

// ----------------------------------------------------------------------------
// Saves — local mirror of the server's /api/saves endpoint. Lets the user keep
// playing offline; sync happens lazily via engine/save.ts.
// ----------------------------------------------------------------------------

export interface LocalSaveRecord {
  id: string;
  name: string;
  payload: string;
  updatedAt: number;
}

export async function idbGetSave(id: string): Promise<LocalSaveRecord | null> {
  const result = await withStore<unknown>(STORE_SAVES, "readonly", (s) => s.get(id));
  if (!result || typeof result !== "object") return null;
  const rec = result as Partial<LocalSaveRecord>;
  if (typeof rec.id !== "string" || typeof rec.name !== "string" || typeof rec.payload !== "string") {
    return null;
  }
  return {
    id: rec.id,
    name: rec.name,
    payload: rec.payload,
    updatedAt: typeof rec.updatedAt === "number" ? rec.updatedAt : 0,
  };
}

export async function idbPutSave(rec: LocalSaveRecord): Promise<void> {
  await withStore(STORE_SAVES, "readwrite", (s) => s.put(rec, rec.id));
}

export async function idbDeleteSave(id: string): Promise<void> {
  await withStore(STORE_SAVES, "readwrite", (s) => s.delete(id));
}

export async function idbListSaves(): Promise<LocalSaveRecord[]> {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_SAVES, "readonly");
    const store = tx.objectStore(STORE_SAVES);
    const req = store.getAll();
    req.onsuccess = () => {
      const arr = (req.result as unknown[]).filter(
        (r): r is LocalSaveRecord =>
          typeof r === "object" &&
          r !== null &&
          typeof (r as LocalSaveRecord).id === "string" &&
          typeof (r as LocalSaveRecord).payload === "string",
      );
      arr.sort((a, b) => b.updatedAt - a.updatedAt);
      resolve(arr);
    };
    req.onerror = () => resolve([]);
  });
}
