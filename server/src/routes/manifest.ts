import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
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
}

async function walk(dir: string, base = dir): Promise<ManifestEntry[]> {
  const entries: ManifestEntry[] = [];
  let listing;
  try {
    listing = await readdir(dir, { withFileTypes: true });
  } catch {
    return entries;
  }
  for (const ent of listing) {
    const full = join(dir, ent.name);
    let isDir = ent.isDirectory();
    let isFile = ent.isFile();
    if (ent.isSymbolicLink()) {
      // Resolve the symlink target so users can `ln -s "/mnt/c/.../Les Sims" server/assets/Sims`
      // and have the manifest find the install.
      try {
        const s = await stat(full);
        isDir = s.isDirectory();
        isFile = s.isFile();
      } catch {
        continue;
      }
    }
    if (isDir) {
      entries.push(...(await walk(full, base)));
    } else if (isFile) {
      const s = await stat(full);
      const rel = relative(base, full).split("\\").join("/");
      entries.push({
        path: rel,
        size: s.size,
        kind: rel.toLowerCase().endsWith(".far")
          ? "far"
          : rel.toLowerCase().endsWith(".iff")
            ? "iff"
            : "other",
      });
    }
  }
  return entries;
}

export async function registerManifestRoute(
  app: FastifyInstance,
  { assetsDir, overlayDir }: Options,
): Promise<void> {
  // Walking the install over the WSL2 /mnt/c mount takes tens of seconds, and
  // the game folder is read-only: walk once at startup and serve the result.
  let files: Promise<ManifestEntry[]> = walk(assetsDir);
  app.get("/api/manifest", async (req) => {
    if ((req.query as { refresh?: string }).refresh !== undefined) files = walk(assetsDir);
    let list = await files;
    if (overlayDir) {
      // The overlay is small and changes as the game saves: walk it every time.
      const over = await walk(overlayDir);
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
}
