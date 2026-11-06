import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";

/**
 * Writable overlay over the read-only game folder.
 *
 * The game saves into its own folder (UserData<N>/Houses, Characters,
 * Neighborhood.iff...). That folder is read-only here, so writes go to
 * `server/data/overlay/<asset path>` and every `/assets/<path>` request is
 * served from the overlay when the file exists there (see `overlayRewrite`,
 * installed as Fastify's `rewriteUrl`). The manifest lists overlay files over
 * the originals. Only paths under `Sims/UserData*` can be written.
 */

const OVERLAY_PREFIX = "/overlay/";
const WRITABLE = /^Sims\/UserData\d*\//i;

export function overlayDirOf(repoRoot: string): string {
  return resolve(repoRoot, "server", "data", "overlay");
}

/** `/assets/<path>` → `/overlay/<path>` when the overlay holds that file. */
export function overlayRewrite(overlayDir: string, url: string): string {
  if (!url.startsWith("/assets/")) return url;
  const q = url.indexOf("?");
  const path = decodeURIComponent((q < 0 ? url : url.slice(0, q)).slice("/assets/".length));
  const full = safeJoin(overlayDir, path);
  return full && existsSync(full) ? OVERLAY_PREFIX + url.slice("/assets/".length) : url;
}

function safeJoin(root: string, rel: string): string | null {
  const full = resolve(root, rel);
  return full.startsWith(root + sep) ? full : null;
}

export async function registerUserDataRoute(
  app: FastifyInstance,
  {
    overlayDir,
    onChange,
  }: {
    overlayDir: string;
    /** After every write (size) or delete (null), with the path relative to the overlay (the manifest's overlay listing). */
    onChange?: (path: string, size: number | null) => void;
  },
): Promise<void> {
  await mkdir(overlayDir, { recursive: true });
  await app.register(fastifyStatic, {
    root: overlayDir,
    prefix: OVERLAY_PREFIX,
    decorateReply: false,
    acceptRanges: true,
    // Saved files change: never let the browser reuse a stale copy (without a
    // Cache-Control header browsers may reuse it heuristically, from Last-Modified).
    cacheControl: false,
    etag: true,
    setHeaders: (res) => res.setHeader("cache-control", "no-cache"),
  });

  const target = (path: string): string | null => {
    const full = safeJoin(overlayDir, path);
    // Test the normalized path so "UserData/../.." cannot leave the UserData folders.
    return full && WRITABLE.test(full.slice(overlayDir.length + 1).split(sep).join("/")) ? full : null;
  };

  // Raw bytes content type so PUT bodies arrive as Buffers.
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  app.put("/api/files/*", { bodyLimit: 128 * 1024 * 1024 }, async (req, reply) => {
    const path = (req.params as { "*": string })["*"];
    const full = target(path);
    if (!full) return reply.code(403).send({ error: "only Sims/UserData*/ is writable" });
    if (!Buffer.isBuffer(req.body)) return reply.code(400).send({ error: "expected application/octet-stream" });
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, req.body);
    onChange?.(full.slice(overlayDir.length + 1).split(sep).join("/"), req.body.length);
    return { ok: true, path, size: req.body.length };
  });

  /**
   * GET /api/saves: every file the game saved (the overlay's Sims/UserData*
   * files), for the saves export (client/src/engine/saves.ts). Paths are
   * relative to /assets/ ("Sims/UserData2/Neighborhood.iff").
   */
  app.get("/api/saves", async () => {
    const files: Array<{ path: string; size: number; mtime: number }> = [];
    let names: string[] = [];
    try {
      names = await readdir(resolve(overlayDir, "Sims"), { recursive: true });
    } catch {
      // no saves yet
    }
    for (const name of names) {
      const rel = `Sims/${name.split(sep).join("/")}`;
      if (!WRITABLE.test(rel)) continue;
      const s = await stat(resolve(overlayDir, rel)).catch(() => null);
      if (s?.isFile()) files.push({ path: rel, size: s.size, mtime: s.mtimeMs });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { files };
  });

  /** Drops the overlay copy: the original file shows through again. */
  app.delete("/api/files/*", async (req, reply) => {
    const path = (req.params as { "*": string })["*"];
    const full = target(path);
    if (!full) return reply.code(403).send({ error: "only Sims/UserData*/ is writable" });
    await rm(full, { force: true });
    onChange?.(full.slice(overlayDir.length + 1).split(sep).join("/"), null);
    return { ok: true, path };
  });
}
