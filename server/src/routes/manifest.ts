import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { FastifyInstance } from "fastify";

interface ManifestEntry {
  path: string;
  size: number;
  kind: "far" | "iff" | "other";
}

interface Options {
  assetsDir: string;
  /** Writable overlay (routes/userdata.ts): its files replace or add to the originals. */
  overlayDir?: string;
  /**
   * Where the game folder's listing is kept between runs. A start serves the
   * kept listing at once and walks the folder again in the background (a
   * walk over the WSL2 /mnt/c mount takes minutes when the disk is busy).
   */
  cacheFile?: string;
}

interface CachedListing {
  assetsDir: string;
  files: ManifestEntry[];
}

async function readCache(cacheFile: string, assetsDir: string): Promise<ManifestEntry[] | null> {
  try {
    const kept = JSON.parse(await readFile(cacheFile, "utf8")) as CachedListing;
    return kept.assetsDir === assetsDir && Array.isArray(kept.files) && kept.files.length > 0 ? kept.files : null;
  } catch {
    return null;
  }
}

async function writeCache(cacheFile: string, assetsDir: string, files: ManifestEntry[]): Promise<void> {
  if (!files.length) return;
  try {
    await mkdir(dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, JSON.stringify({ assetsDir, files } satisfies CachedListing));
  } catch {
    // (a read-only data folder: no cache, every start walks)
  }
}

/**
 * The folder's files, recursively, in listing order. Each folder's entries are
 * looked at in parallel: one after another, the stats of a game folder and
 * its saves on a Windows drive under WSL (/mnt/c) took over a minute.
 */
async function walk(dir: string, base = dir): Promise<ManifestEntry[]> {
  let listing;
  try {
    listing = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const parts = await Promise.all(
    listing.map(async (ent): Promise<ManifestEntry[]> => {
      const full = join(dir, ent.name);
      let isDir = ent.isDirectory();
      let isFile = ent.isFile();
      if (ent.isSymbolicLink()) {
        // Resolve the symlink target so users can `ln -s "/path/to/The Sims" server/assets/Sims`
        // and have the manifest find the install.
        const s = await stat(full).catch(() => null);
        if (!s) return [];
        isDir = s.isDirectory();
        isFile = s.isFile();
      }
      if (isDir) return walk(full, base);
      if (!isFile) return [];
      // A file can vanish between readdir and stat (a save being replaced): skip it.
      const s = await stat(full).catch(() => null);
      if (!s) return [];
      const rel = relative(base, full).split("\\").join("/");
      const lower = rel.toLowerCase();
      return [{ path: rel, size: s.size, kind: lower.endsWith(".far") ? "far" : lower.endsWith(".iff") ? "iff" : "other" }];
    }),
  );
  return parts.flat();
}

export async function registerManifestRoute(
  app: FastifyInstance,
  { assetsDir, overlayDir, cacheFile }: Options,
): Promise<{ invalidateOverlay: () => void; overlayChanged: (path: string, size: number | null) => void }> {
  // Walking the install over the WSL2 /mnt/c mount takes tens of seconds (minutes
  // on a busy disk), and the game folder is read-only: walk once at startup and
  // serve the result; with a kept listing, serve it until the new walk is done.
  const walkAndKeep = (): Promise<ManifestEntry[]> => {
    const p = walk(assetsDir);
    if (cacheFile) void p.then((list) => writeCache(cacheFile, assetsDir, list), () => undefined);
    return p;
  };
  const kept = cacheFile ? await readCache(cacheFile, assetsDir) : null;
  let files: Promise<ManifestEntry[]>;
  if (kept) {
    const keptListing = Promise.resolve(kept);
    files = keptListing;
    void walkAndKeep().then(
      (list) => {
        // (unless a ?refresh=all walk replaced it meanwhile)
        if (files === keptListing && list.length) files = Promise.resolve(list);
      },
      () => undefined,
    );
  } else {
    files = walkAndKeep();
  }
  // The overlay changes as the game saves, through routes/userdata.ts, which
  // calls invalidateOverlay; walked again on the next request after a change
  // (a walk over /mnt/c costs seconds once the saves pile up).
  let overlay: Promise<ManifestEntry[]> | null = null;
  app.get("/api/manifest", async (req) => {
    // ?refresh: the saves are listed again (a save folder made or removed by hand);
    // ?refresh=all also walks the read-only game folder again (minutes over /mnt/c).
    const refresh = (req.query as { refresh?: string }).refresh;
    if (refresh !== undefined) {
      if (refresh === "all") files = walkAndKeep();
      overlay = null;
    }
    // A failed walk is not kept: the next request walks again.
    const filesWalk = files;
    let list = await filesWalk.catch((e: unknown) => {
      if (files === filesWalk) files = walkAndKeep();
      throw e;
    });
    if (overlayDir) {
      const overWalk = (overlay ??= walk(overlayDir));
      const over = await overWalk.catch((e: unknown) => {
        if (overlay === overWalk) overlay = null;
        throw e;
      });
      if (over.length) {
        const byPath = new Map(list.map((f) => [f.path, f]));
        for (const f of over) byPath.set(f.path, f);
        list = [...byPath.values()];
      }
    }
    return {
      version: 1,
      assetsRoot: "/assets/",
      files: list,
    };
  });
  return {
    invalidateOverlay: () => {
      overlay = null;
    },
    // A save written or deleted through routes/userdata.ts: the listing is updated in
    // place (walking the overlay again costs tens of seconds once the saves pile up).
    overlayChanged: (path, size) => {
      if (!overlay) return;
      overlay = overlay.then((list) => {
        const rest = list.filter((f) => f.path !== path);
        if (size === null) return rest;
        const lower = path.toLowerCase();
        rest.push({ path, size, kind: lower.endsWith(".far") ? "far" : lower.endsWith(".iff") ? "iff" : "other" });
        return rest;
      });
    },
  };
}
