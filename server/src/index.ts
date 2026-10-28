import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { registerManifestRoute } from "./routes/manifest.js";
import { registerRangesRoute } from "./routes/ranges.js";
import { registerSavesRoute } from "./routes/saves.js";
import { registerTemplatesRoute } from "./routes/templates.js";
import { overlayDirOf, overlayRewrite, registerUserDataRoute } from "./routes/userdata.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..", "..");
const assetsDir = resolve(repoRoot, "server", "assets");
const overlayDir = overlayDirOf(repoRoot);

const HOST = process.env["HOST"] ?? "127.0.0.1";
const PORT = Number(process.env["PORT"] ?? 3000);

const app = Fastify({
  // Saved game files shadow the read-only originals (routes/userdata.ts).
  rewriteUrl: (req) => overlayRewrite(overlayDir, req.url ?? "/"),
  logger: {
    transport: { target: "pino-pretty" },
  },
});

await app.register(fastifyCors, { origin: true });

await app.register(fastifyStatic, {
  root: assetsDir,
  prefix: "/assets/",
  decorateReply: false,
  acceptRanges: true,
  cacheControl: true,
  maxAge: "1h",
  etag: true,
  immutable: false,
});

app.get("/api/health", async () => ({ ok: true }));

// The manifest caches its overlay listing; saves invalidate it.
let invalidateOverlay = (): void => {};
await registerUserDataRoute(app, { overlayDir, onChange: () => invalidateOverlay() });
({ invalidateOverlay } = await registerManifestRoute(app, { assetsDir, overlayDir }));
await registerRangesRoute(app, { assetsDir, overlayDir });
await registerSavesRoute(app, { repoRoot });
await registerTemplatesRoute(app, { assetsDir });

try {
  await app.listen({ host: HOST, port: PORT });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
