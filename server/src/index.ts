import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Fastify, { type FastifyReply } from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { registerClientRoute } from "./routes/client.js";
import { registerManifestRoute } from "./routes/manifest.js";
import { registerRangesRoute } from "./routes/ranges.js";
import { overlayDirOf, overlayRewrite, registerUserDataRoute } from "./routes/userdata.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..", "..");
const assetsDir = resolve(repoRoot, "server", "assets");
const overlayDir = overlayDirOf(repoRoot);
const clientDir = resolve(process.env["CLIENT_DIST"] ?? resolve(repoRoot, "client", "dist"));

const HOST = process.env["HOST"] ?? "127.0.0.1";
const PORT = Number(process.env["PORT"] ?? 3000);
/**
 * Where the game's saves live. "server" (default): one shared set, written to
 * the overlay (routes/userdata.ts). "client": each browser keeps its own in
 * IndexedDB (client/src/engine/saves.ts); the server is then read-only and
 * serves the game folder as installed, its UserData* folders included.
 */
const SAVES = process.env["SAVES"] ?? "server";
if (SAVES !== "server" && SAVES !== "client") {
  console.error(`SAVES must be "server" or "client" (got "${SAVES}")`);
  process.exit(1);
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
await app.register(fastifyStatic, {
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
app.get("/api/config", async () => ({ saves: SAVES }));

if (serverSaves) {
  // The manifest caches its overlay listing; saves invalidate it.
  let invalidateOverlay = (): void => {};
  await registerUserDataRoute(app, { overlayDir, onChange: () => invalidateOverlay() });
  ({ invalidateOverlay } = await registerManifestRoute(app, { assetsDir, overlayDir }));
  await registerRangesRoute(app, { assetsDir, overlayDir });
} else {
  const refuse = async (_req: unknown, reply: FastifyReply) =>
    reply.code(403).send({ error: "saves are kept in the browser on this server (SAVES=client)" });
  // (any body: the write is refused, not its content type)
  app.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: 128 * 1024 * 1024 }, (_req, _body, done) => done(null));
  app.put("/api/files/*", refuse);
  app.delete("/api/files/*", refuse);
  await registerManifestRoute(app, { assetsDir });
  await registerRangesRoute(app, { assetsDir });
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
