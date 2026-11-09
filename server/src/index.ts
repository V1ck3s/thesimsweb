import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readdir } from "node:fs/promises";
import Fastify, { type FastifyReply } from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { registerClientRoute } from "./routes/client.js";
import { registerManifestRoute } from "./routes/manifest.js";
import { registerMoviesRoute } from "./routes/movies.js";
import { registerRangesRoute } from "./routes/ranges.js";
import { overlayDirOf, overlayRewrite, registerUserDataRoute } from "./routes/userdata.js";
import { registerWebPagesRoute } from "./routes/webpages.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..", "..");
const assetsDir = resolve(repoRoot, "server", "assets");
// OVERLAY_DIR: where the saves are written in SAVES=server mode (default server/data/overlay).
const overlayDir = process.env["OVERLAY_DIR"] ? resolve(process.env["OVERLAY_DIR"]) : overlayDirOf(repoRoot);
// The game folder's listing kept between runs (routes/manifest.ts).
const manifestCache = resolve(repoRoot, "server", "data", "manifest-cache.json");
const clientDir = resolve(process.env["CLIENT_DIST"] ?? resolve(repoRoot, "client", "dist"));

const HOST = process.env["HOST"] ?? "127.0.0.1";
const PORT = Number(process.env["PORT"] ?? 3000);
/**
 * Where the game files come from. "server" (default): the game folder under
 * server/assets/ (served under /assets/, listed by /api/manifest). "client":
 * each player imports their own install folder into their browser
 * (client/src/engine/gamefiles.ts); the server then serves no game file at
 * all (no /assets/, /api/manifest, /api/ranges), only the app, and the saves
 * stay in the browsers (SAVES=client is forced).
 */
const GAME_FILES = process.env["GAME_FILES"] ?? "server";
if (GAME_FILES !== "server" && GAME_FILES !== "client") {
  console.error(`GAME_FILES must be "server" or "client" (got "${GAME_FILES}")`);
  process.exit(1);
}
const serverGameFiles = GAME_FILES === "server";
/**
 * Where the game's saves live. "server" (default): one shared set, written to
 * the overlay (routes/userdata.ts). "client": each browser keeps its own in
 * IndexedDB (client/src/engine/saves.ts); the server is then read-only and
 * serves the game folder as installed, its UserData* folders included.
 */
const SAVES = serverGameFiles ? (process.env["SAVES"] ?? "server") : "client";
if (SAVES !== "server" && SAVES !== "client") {
  console.error(`SAVES must be "server" or "client" (got "${SAVES}")`);
  process.exit(1);
}
if (!serverGameFiles && process.env["SAVES"] === "server") {
  console.warn('GAME_FILES=client: SAVES=server is ignored (the saves stay in the browsers)');
}
const serverSaves = SAVES === "server";

const app = Fastify({
  // Saved game files shadow the read-only originals (routes/userdata.ts).
  rewriteUrl: (req) => (serverSaves ? overlayRewrite(overlayDir, req.url ?? "/") : (req.url ?? "/")),
  logger: {
    transport: { target: "pino-pretty" },
  },
});

await app.register(fastifyCors, { origin: true });

// The game folder is read-only: its files may be reused for an hour (then
// revalidated by ETag; the client keeps most of them in IndexedDB anyway).
// UserData* files change when the game saves (a saved copy then shadows the
// original through the overlay): always revalidated.
const USERDATA_FILE = /^Sims[\\/]UserData\d*[\\/]/i;
// (GAME_FILES=client: never served, whatever server/assets/ holds)
if (serverGameFiles) await app.register(fastifyStatic, {
  root: assetsDir,
  prefix: "/assets/",
  decorateReply: false,
  acceptRanges: true,
  cacheControl: false,
  etag: true,
  setHeaders: (res, path) => {
    const rel = path.startsWith(assetsDir) ? path.slice(assetsDir.length + 1) : path;
    res.setHeader("cache-control", USERDATA_FILE.test(rel) ? "no-cache" : "public, max-age=3600");
  },
});

app.get("/api/health", async () => ({ ok: true }));
// Read by the client at startup (client/src/engine/saves.ts).
app.get("/api/config", async () => ({ saves: SAVES, gameFiles: GAME_FILES }));

if (!serverGameFiles) {
  // No game file leaves this server: the browsers read their own import.
  const refuse = async (_req: unknown, reply: FastifyReply) =>
    reply.code(403).send({ error: "saves are kept in the browser on this server (GAME_FILES=client)" });
  app.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: 128 * 1024 * 1024 }, (_req, _body, done) => done(null));
  app.put("/api/files/*", refuse);
  app.delete("/api/files/*", refuse);
} else if (serverSaves) {
  // The manifest caches its overlay listing; saves update it.
  let overlayChanged = (_path: string, _size: number | null): void => {};
  await registerUserDataRoute(app, { overlayDir, onChange: (path, size) => overlayChanged(path, size) });
  ({ overlayChanged } = await registerManifestRoute(app, { assetsDir, overlayDir, cacheFile: manifestCache }));
  await registerRangesRoute(app, { assetsDir, overlayDir });
} else {
  const refuse = async (_req: unknown, reply: FastifyReply) =>
    reply.code(403).send({ error: "saves are kept in the browser on this server (SAVES=client)" });
  // (any body: the write is refused, not its content type)
  app.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: 128 * 1024 * 1024 }, (_req, _body, done) => done(null));
  app.put("/api/files/*", refuse);
  app.delete("/api/files/*", refuse);
  await registerManifestRoute(app, { assetsDir, cacheFile: manifestCache });
  await registerRangesRoute(app, { assetsDir });
}
// The intro movie transcoded for the browsers when ffmpeg is installed (routes/movies.ts).
if (serverGameFiles) await registerMoviesRoute(app, { assetsDir, cacheDir: resolve(repoRoot, "server", "data", "movies") });
// The game's web pages with their compatibility script (in the browsers' saves when SAVES=client: the service worker).
if (serverGameFiles) await registerWebPagesRoute(app, serverSaves ? { assetsDir, overlayDir } : { assetsDir });
app.log.info(`game files: ${serverGameFiles ? `served from ${assetsDir}` : "imported by each browser (none served)"}`);
if (serverGameFiles && (await readdir(resolve(assetsDir, "Sims")).catch(() => [])).length === 0) {
  app.log.warn(`no game folder in ${resolve(assetsDir, "Sims")}: link or mount the install of The Sims there (SIMS_DIR with Docker), or set GAME_FILES=client`);
}
app.log.info(`saves: ${SAVES === "server" ? "on the server (shared)" : "in each browser"}`);
// The built game (`pnpm build`); in dev, vite serves the client on :5173 instead.
// Served whenever client/dist exists; SERVE_CLIENT=0 turns it off.
if (process.env["SERVE_CLIENT"] !== "0" && (await registerClientRoute(app, { clientDir }))) {
  app.log.info(`serving the built client from ${clientDir}`);
}

try {
  await app.listen({ host: HOST, port: PORT });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
