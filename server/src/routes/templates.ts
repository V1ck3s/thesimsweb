import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { FastifyInstance } from "fastify";

interface TemplateEntry {
  /** Display name (filename minus extension). */
  name: string;
  /** Path relative to the assets root — feed straight into `/assets/<path>` or
   *  `readStandaloneIff()` on the client. */
  path: string;
  size: number;
}

interface Options {
  assetsDir: string;
}

const TEMPLATE_DIRS = ["Sims/TemplateMagictown"] as const;

async function listIffsIn(root: string, sub: string): Promise<TemplateEntry[]> {
  const dir = join(root, sub);
  let listing;
  try {
    listing = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: TemplateEntry[] = [];
  for (const ent of listing) {
    const full = join(dir, ent.name);
    let isFile = ent.isFile();
    if (ent.isSymbolicLink()) {
      try {
        isFile = (await stat(full)).isFile();
      } catch {
        continue;
      }
    }
    if (!isFile) continue;
    if (!ent.name.toLowerCase().endsWith(".iff")) continue;
    // Magictown ships 10 actual House??.iff lots plus 4 metadata IFFs
    // (LotLocations / LotZoning / MTDesc / StreetNames). Only the houses are
    // loadable as lots, so filter the rest out at the API boundary.
    if (!/^house\d+\.iff$/i.test(ent.name)) continue;
    const s = await stat(full);
    const rel = relative(root, full).split("\\").join("/");
    out.push({
      name: ent.name.replace(/\.iff$/i, ""),
      path: rel,
      size: s.size,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function registerTemplatesRoute(
  app: FastifyInstance,
  { assetsDir }: Options,
): Promise<void> {
  app.get("/api/templates", async () => {
    const all: TemplateEntry[] = [];
    for (const sub of TEMPLATE_DIRS) {
      all.push(...(await listIffsIn(assetsDir, sub)));
    }
    return {
      version: 1,
      templates: all,
    };
  });
}
