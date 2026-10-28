import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
  { overlayDir, onChange }: { overlayDir: string; /** After every write or delete (the manifest's overlay listing). */ onChange?: () => void },
): Promise<void> {
  await mkdir(overlayDir, { recursive: true });
  await app.register(fastifyStatic, {
    root: overlayDir,
    prefix: OVERLAY_PREFIX,
    decorateReply: false,
    acceptRanges: true,
    // Saved files change: never let the browser reuse a stale copy.
    cacheControl: false,
    etag: true,
  });

  const target = (path: string): string | null => {
    const full = safeJoin(overlayDir, path);
    // Test the normalized path so "UserData/../.." cannot leave the UserData folders.
    return full && WRITABLE.test(full.slice(overlayDir.length + 1).split(sep).join("/")) ? full : null;
  };

  // Bodies arrive as Buffers through the application/octet-stream parser of routes/saves.ts.
  app.put("/api/files/*", { bodyLimit: 128 * 1024 * 1024 }, async (req, reply) => {
    const path = (req.params as { "*": string })["*"];
    const full = target(path);
    if (!full) return reply.code(403).send({ error: "only Sims/UserData*/ is writable" });
    if (!Buffer.isBuffer(req.body)) return reply.code(400).send({ error: "expected application/octet-stream" });
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, req.body);
    onChange?.();
    return { ok: true, path, size: req.body.length };
  });

  /** Drops the overlay copy: the original file shows through again. */
  app.delete("/api/files/*", async (req, reply) => {
    const path = (req.params as { "*": string })["*"];
    const full = target(path);
    if (!full) return reply.code(403).send({ error: "only Sims/UserData*/ is writable" });
    await rm(full, { force: true });
    onChange?.();
    return { ok: true, path };
  });
}
