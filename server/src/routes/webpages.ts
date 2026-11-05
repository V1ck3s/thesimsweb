import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * GET /webpages/<path>: the game's web pages (Sims/UserData*\/Web Pages/,
 * written by the game, client/src/game/nbhd/exporthtml.ts), as /assets/<path>
 * serves them (the saved copy in the overlay, else the game folder's), with
 * the compatibility script (client/public/webpages-compat.js) put at the top
 * of each HTML page: the pages' scripts were written for Internet Explorer 4
 * and Netscape 4 and do nothing in a current browser. The files themselves
 * are left as the game writes them.
 *
 * In SAVES=client mode the pages are in the browser: the service worker
 * (client/src/sw/sw.ts) answers these requests from its saves first.
 */
const WEB_PAGES = /^Sims\/UserData\d*\/Web Pages\//i;

const TYPES: Record<string, string> = {
  ".htm": "text/html; charset=windows-1252",
  ".html": "text/html; charset=windows-1252",
  ".css": "text/css; charset=windows-1252",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".png": "image/png",
  ".bmp": "image/bmp",
  ".js": "text/javascript; charset=windows-1252",
};

/** The script tag put in front of every page (before its own scripts run). */
export const COMPAT_TAG = '<script src="/webpages-compat.js"></script>';

/** The page's bytes (8-bit text) with the compatibility script right after `<head>` (else at the top). */
export function injectCompat(bytes: Buffer): Buffer {
  const text = bytes.toString("latin1");
  const m = /<head[^>]*>/i.exec(text);
  const at = m ? m.index + m[0].length : 0;
  return Buffer.concat([bytes.subarray(0, at), Buffer.from(COMPAT_TAG, "latin1"), bytes.subarray(at)]);
}

function safeJoin(root: string, rel: string): string | null {
  const full = resolve(root, rel);
  return full.startsWith(root + sep) ? full : null;
}

export async function registerWebPagesRoute(
  app: FastifyInstance,
  { assetsDir, overlayDir }: { assetsDir: string; /** SAVES=server: the saved copies, read first. */ overlayDir?: string },
): Promise<void> {
  app.get("/webpages/*", async (req, reply) => {
    const path = decodeURIComponent((req.params as { "*": string })["*"]);
    if (!WEB_PAGES.test(path)) return reply.code(404).send();
    let bytes: Buffer | null = null;
    for (const root of overlayDir ? [overlayDir, assetsDir] : [assetsDir]) {
      const full = safeJoin(root, path);
      if (!full) return reply.code(404).send();
      bytes = await readFile(full).catch(() => null);
      if (bytes) break;
    }
    if (!bytes) return reply.code(404).send();
    const ext = extname(path).toLowerCase();
    reply.header("cache-control", "no-cache");
    reply.type(TYPES[ext] ?? "application/octet-stream");
    return reply.send(ext === ".htm" || ext === ".html" ? injectCompat(bytes) : bytes);
  });
}
