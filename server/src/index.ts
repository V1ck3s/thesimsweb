import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { registerManifestRoute } from "./routes/manifest.js";
import { registerSavesRoute } from "./routes/saves.js";
import { registerTemplatesRoute } from "./routes/templates.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..", "..");
const assetsDir = resolve(repoRoot, "server", "assets");

const HOST = process.env["HOST"] ?? "127.0.0.1";
const PORT = Number(process.env["PORT"] ?? 3000);

const app = Fastify({
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

await registerManifestRoute(app, { assetsDir });
await registerSavesRoute(app, { repoRoot });
await registerTemplatesRoute(app, { assetsDir });

try {
  await app.listen({ host: HOST, port: PORT });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
