/**
 * The order in which the Windows build walks a game folder: CTGFileManager
 * directory images and FolderScanner::ScanFileManager.
 *
 * FolderScanner::Scan walks a folder with CTGFileManager::FindFirstFile /
 * FindNextFile (ScanFileManager when the folder is mapped, ScanDisk through a
 * temporary manager's AddDirectoryImage otherwise): the iteration order of the
 * folder's directory image, a hash_map<CTGString, sDirectoryEntry,
 * CTGStringHash> keyed by the lowercase names. Sub-folders are walked depth
 * first where they come; ProcessOneFile gets every file. Used by
 * ObjectFolder::ScanForNewFiles (world/objectfolder.ts) and, through the
 * folder's selector order, by the .pub's [objects] (nbhd/exporthtml.ts).
 * See docs/decomp/nbhd-port.md ("Folder order").
 */

/** nRZHash::OneAtATime (signed chars). */
export function oneAtATime(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    const c = ((s.charCodeAt(i) & 0xff) << 24) >> 24;
    h = Math.imul((h + c) >>> 0, 0x401) >>> 0;
    h = (h ^ (h >>> 6)) >>> 0;
  }
  const t = Math.imul(h, 9) >>> 0;
  return Math.imul((t ^ (t >>> 11)) >>> 0, 0x8001) >>> 0;
}

/** The bucket counts of the Windows build's hash_map (the SGI prime list from 53). */
const HASH_PRIMES = [53, 97, 193, 389, 769, 1543, 3079, 6151, 12289, 24593, 49157, 98317, 196613];

/**
 * The iteration order of one CTGFileManager directory image: a
 * hash_map<CTGString, sDirectoryEntry, CTGStringHash> keyed by the lowercase
 * names, made with the default 100 buckets (193), a new node at the front of
 * its bucket, a rehash to the next prime once the count passes the bucket
 * count (moving each chain's nodes, from its head, to the front of their new
 * bucket); FindFirstFile / FindNextFile walk the buckets in order. `keys` are
 * in insertion order (ScanDirectory: the disk's order; AddFARToMapping adds a
 * FAR's entries to its folder's image when the FAR is met).
 */
export function directoryImageOrder(keys: readonly string[]): string[] {
  let n = 193;
  let buckets: string[][] = Array.from({ length: n }, () => []);
  let count = 0;
  for (const k of keys) {
    if (buckets[oneAtATime(k) % n]!.includes(k)) continue;
    if (count + 1 > n) {
      const nn = HASH_PRIMES.find((p) => p >= count + 1) ?? n;
      const nb: string[][] = Array.from({ length: nn }, () => []);
      for (const chain of buckets) for (const x of chain) nb[oneAtATime(x) % nn]!.unshift(x);
      buckets = nb;
      n = nn;
    }
    buckets[oneAtATime(k) % n]!.unshift(k);
    count++;
  }
  return buckets.flat();
}

/** FindFirstFile on NTFS: the upper-cased names in code point order (the disk order ScanDirectory adds). */
export function diskOrder(a: string, b: string): number {
  const ua = a.toUpperCase();
  const ub = b.toUpperCase();
  return ua < ub ? -1 : ua > ub ? 1 : 0;
}

/** One file ScanFileManager hands to ProcessOneFile. */
export interface ScannedFile<E> {
  /** Path relative to the game folder: the loose file, or "<far path>|<entry name>". */
  key: string;
  /** The loose file, or the FAR holding the entry (relative to the game folder). */
  file: string;
  /** The FAR entry, null for a loose file. */
  entry: E | null;
}

/**
 * FolderScanner::ScanFileManager over game folder `dir` ("Downloads/"; any
 * case): every file under it, sub-folders and the entries of its FAR archives
 * included, in the order the original visits them. `paths` are the game's
 * files relative to the game folder (the asset manifest); `readFar` lists a
 * FAR's entries (null or a throw: no entries). The FARs are listed together
 * before the walk.
 */
export async function scanFolder<E extends { filename: string }>(
  paths: readonly string[],
  dir: string,
  readFar: (far: string) => Promise<readonly E[] | null>,
): Promise<Array<ScannedFile<E>>> {
  const lowerDir = dir.toLowerCase();
  const under = paths.filter((p) => p.toLowerCase().startsWith(lowerDir));
  const fars = under.filter((p) => p.toLowerCase().endsWith(".far"));
  const listed = await Promise.all(fars.map((f) => readFar(f).catch(() => null)));
  const farEntries = new Map<string, readonly E[]>(fars.map((f, i) => [f, listed[i] ?? []]));
  const out: Array<ScannedFile<E>> = [];
  const walk = (base: string, files: readonly string[]): void => {
    // The folder's names (files and sub-folders), as spelled on disk.
    const names = new Map<string, string>();
    for (const p of files) {
      const rest = p.slice(base.length);
      const slash = rest.indexOf("/");
      const name = slash < 0 ? rest : `${rest.slice(0, slash)}/`;
      if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
    }
    const keys: string[] = [];
    const entries = new Map<string, { dir: string | null; file: ScannedFile<E> | null }>();
    for (const name of [...names.values()].sort(diskOrder)) {
      const isDir = name.endsWith("/");
      const key = (isDir ? name.slice(0, -1) : name).toLowerCase();
      keys.push(key);
      const path = `${base}${name}`;
      entries.set(key, { dir: isDir ? path : null, file: isDir ? null : { key: path, file: path, entry: null } });
      if (isDir || !key.endsWith(".far")) continue;
      for (const e of farEntries.get(path) ?? []) {
        const k = e.filename.toLowerCase();
        keys.push(k);
        if (!entries.has(k)) entries.set(k, { dir: null, file: { key: `${path}|${e.filename}`, file: path, entry: e } });
      }
    }
    for (const k of directoryImageOrder(keys)) {
      const e = entries.get(k)!;
      if (e.dir) {
        const sub = e.dir.toLowerCase();
        walk(e.dir, files.filter((p) => p.toLowerCase().startsWith(sub)));
      } else if (e.file) out.push(e.file);
    }
  };
  // The folder as spelled on disk.
  const root = under.length > 0 ? under[0]!.slice(0, dir.length) : dir;
  walk(root, under);
  return out;
}
