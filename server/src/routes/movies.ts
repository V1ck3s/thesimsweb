import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * GET /api/movie/:name: one of the game's movies (Music/eag_<lang>.avi, the EA
 * intro the game plays at startup; Music/simsintro.avi) as WebM.
 *
 * The AVIs are MS-MPEG4 v1 ("MPG4") with PCM sound, which no browser decodes.
 * When ffmpeg is installed (FFMPEG, else `ffmpeg` on the PATH) the movie is
 * transcoded once (VP8 + Vorbis) into the cache folder and served from there;
 * the cache name carries the source's size and date, so a changed file is
 * transcoded again. Without ffmpeg (or without the movie) the answer is 404
 * and the client skips the intro. Nothing transcoded leaves the cache folder
 * (server/data/movies/, gitignored with the rest of server/data/).
 */

interface Options {
  assetsDir: string;
  cacheDir: string;
}

/** The movies the game plays (cSimsApp, Windows FUN_004ef759). */
const MOVIE = /^(eag_[a-z]{2}|simsintro)\.avi$/i;
const FFMPEG = process.env["FFMPEG"] ?? "ffmpeg";
/** A transcode taking longer than this is given up (the client then skips the movie). */
const TRANSCODE_TIMEOUT_MS = 60_000;

function run(cmd: string, args: string[], timeoutMs: number): Promise<boolean> {
  return new Promise((done) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: "ignore" });
    } catch {
      done(false);
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      done(false);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      done(code === 0);
    });
  });
}

export async function registerMoviesRoute(app: FastifyInstance, { assetsDir, cacheDir }: Options): Promise<void> {
  let ffmpeg: Promise<boolean> | null = null;
  const hasFfmpeg = (): Promise<boolean> => (ffmpeg ??= run(FFMPEG, ["-hide_banner", "-version"], 10_000));
  const running = new Map<string, Promise<string | null>>();

  const transcode = async (src: string, out: string): Promise<string | null> => {
    if (existsSync(out)) return out;
    if (!(await hasFfmpeg())) return null;
    await mkdir(cacheDir, { recursive: true });
    const tmp = `${out}.${process.pid}.tmp.webm`;
    const ok = await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-c:v", "libvpx", "-b:v", "1M", "-c:a", "libvorbis", tmp], TRANSCODE_TIMEOUT_MS);
    if (!ok) {
      await rm(tmp, { force: true });
      app.log.warn(`movie transcode failed: ${src}`);
      return null;
    }
    await rename(tmp, out);
    return out;
  };

  app.get<{ Params: { name: string } }>("/api/movie/:name", async (req, reply) => {
    const { name } = req.params;
    if (!MOVIE.test(name)) return reply.code(404).send({ error: "no such movie" });
    const src = resolve(assetsDir, "Sims", "Music", name.toLowerCase());
    const st = await stat(src).catch(() => null);
    if (!st?.isFile()) return reply.code(404).send({ error: "no such movie" });
    const out = resolve(cacheDir, `${name.toLowerCase().replace(/\.avi$/, "")}-${st.size}-${Math.trunc(st.mtimeMs)}.webm`);
    let job = running.get(out);
    if (!job) {
      job = transcode(src, out).finally(() => running.delete(out));
      running.set(out, job);
    }
    const file = await job;
    if (!file) return reply.code(404).send({ error: "movie not available (no ffmpeg on the server)" });
    return reply.type("video/webm").header("cache-control", "public, max-age=3600").send(await readFile(file));
  });
}
