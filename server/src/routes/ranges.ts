import { existsSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * POST /api/ranges: many byte ranges of asset files in one round trip.
 *
 * The client's first object-folder scan reads the IFF header, resource map
 * and OBJD chunks of ~1500 object files (a few thousand small ranges, mostly
 * inside FAR archives); one HTTP request per range is what made it slow.
 *
 * Body: `{ "ranges": [[path, start, end], ...] }`, paths relative to
 * `/assets/`, `end` exclusive. Response (application/octet-stream): one u32
 * little-endian length per range (0xffffffff when the range is unreadable:
 * missing file, or `start` at or past the end, like a 416), then the bytes of
 * every readable range in order. A range running past the end of the file is
 * cut there, like a `Range:` request. Files of the writable overlay
 * (routes/userdata.ts) win over the originals, as for `/assets/`.
 */

const MAX_RANGES = 4096;
const MAX_BYTES = 64 * 1024 * 1024;
const READ_CONCURRENCY = 64;
const UNREADABLE = 0xffffffff;

interface Options {
  assetsDir: string;
  overlayDir: string;
}

function safeJoin(root: string, rel: string): string | null {
  const full = resolve(root, rel);
  return full.startsWith(root + sep) ? full : null;
}

export async function registerRangesRoute(app: FastifyInstance, { assetsDir, overlayDir }: Options): Promise<void> {
  const locate = (path: string): string | null => {
    const over = safeJoin(overlayDir, path);
    if (over && existsSync(over)) return over;
    return safeJoin(assetsDir, path);
  };

  app.post("/api/ranges", { bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    const ranges = (req.body as { ranges?: unknown } | null)?.ranges;
    if (!Array.isArray(ranges) || ranges.length > MAX_RANGES) return reply.code(400).send({ error: `expected { ranges: [path, start, end][] } (at most ${MAX_RANGES})` });
    const list: Array<{ path: string; start: number; end: number }> = [];
    let requested = 0;
    for (const r of ranges as unknown[]) {
      if (!Array.isArray(r) || typeof r[0] !== "string" || !Number.isSafeInteger(r[1]) || !Number.isSafeInteger(r[2])) return reply.code(400).send({ error: "bad range" });
      const [path, start, end] = r as [string, number, number];
      if (start < 0 || end < start) return reply.code(400).send({ error: `bad range ${path} ${start}-${end}` });
      requested += end - start;
      list.push({ path, start, end });
    }
    if (requested > MAX_BYTES) return reply.code(413).send({ error: `more than ${MAX_BYTES} bytes requested` });

    // Every file opened once; the reads run in parallel (the game folder sits
    // on a slow mount where each read waits on a round trip).
    const out: Array<Buffer | null> = new Array<Buffer | null>(list.length).fill(null);
    const files = new Map<string, Promise<{ fh: FileHandle; size: number } | null>>();
    const file = (path: string): Promise<{ fh: FileHandle; size: number } | null> => {
      let f = files.get(path);
      if (!f) {
        const full = locate(path);
        f = full
          ? open(full, "r").then(
              async (fh) => ({ fh, size: (await fh.stat()).size }),
              () => null,
            )
          : Promise.resolve(null);
        files.set(path, f);
      }
      return f;
    };
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < list.length) {
        const i = next++;
        const { path, start, end } = list[i]!;
        const f = await file(path);
        if (!f || start >= f.size) continue;
        const len = Math.min(end, f.size) - start;
        const buf = Buffer.allocUnsafe(len);
        let got = 0;
        while (got < len) {
          const { bytesRead } = await f.fh.read(buf, got, len - got, start + got);
          if (bytesRead === 0) break;
          got += bytesRead;
        }
        out[i] = got === len ? buf : buf.subarray(0, got);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, list.length) }, worker));
    } finally {
      await Promise.all([...files.values()].map(async (f) => (await f)?.fh.close()));
    }

    const head = Buffer.alloc(4 * list.length);
    out.forEach((b, i) => head.writeUInt32LE(b ? b.length : UNREADABLE, 4 * i));
    return reply
      .header("content-type", "application/octet-stream")
      .header("cache-control", "no-store")
      .send(Buffer.concat([head, ...out.filter((b): b is Buffer => b !== null)]));
  });
}
