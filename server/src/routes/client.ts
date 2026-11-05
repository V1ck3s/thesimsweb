import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";

/**
 * Serves the production build of the client (`client/dist`, from `vite build`).
 *
 * `/` (and `/index.html`) is the landing page (`index.html`: play button,
 * saves export / import); with a query string it is the game (`game.html`),
 * so `/?house=1`, `/?nbhd=UserData2`, `/?test=<name>` (bookmarks from before
 * the landing page) still start the game, like the dev server's rewrite
 * (vite.config.ts). `/game.html` is the game. Hashed bundle files live under
 * `/static/` and are cached forever; the HTML pages, the service worker
 * (`/sw.js`) and the web manifest are always revalidated.
 *
 * Returns false (nothing registered) when the client has not been built.
 */
export async function registerClientRoute(app: FastifyInstance, { clientDir }: { clientDir: string }): Promise<boolean> {
  if (!existsSync(join(clientDir, "game.html"))) return false;

  await app.register(fastifyStatic, {
    root: clientDir,
    prefix: "/",
    // `reply.sendFile` for the "/" route below; the other static roots opt out.
    decorateReply: true,
    index: false,
    cacheControl: false,
    etag: true,
    // Do not shadow /api/*, /assets/*, /overlay/* (registered elsewhere).
    allowedPath: (path) => !/^\/(api|assets|overlay)\//.test(path),
    setHeaders: (res, path) => {
      const immutable = /[\\/]static[\\/]/.test(path) && !path.endsWith(".map");
      res.setHeader("cache-control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
    },
  });

  // (a build from before the landing page has no index.html: the game, as then)
  const hasLanding = existsSync(join(clientDir, "index.html"));
  const root = (req: FastifyRequest, reply: FastifyReply): FastifyReply => {
    const q = req.url.indexOf("?");
    return reply.sendFile(hasLanding && (q < 0 || q === req.url.length - 1) ? "index.html" : "game.html");
  };
  app.get("/", root);
  app.get("/index.html", root);
  return true;
}
