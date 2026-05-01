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
    if (ent.isDirectory()) {
      entries.push(...(await walk(full, base)));
    } else if (ent.isFile()) {
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
  { assetsDir }: Options,
): Promise<void> {
  app.get("/api/manifest", async () => {
    const files = await walk(assetsDir);
    return {
      version: 1,
      assetsRoot: "/assets/",
      files,
    };
  });
}
