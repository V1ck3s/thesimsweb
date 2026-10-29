import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";

/**
 * Serves the production build of the client (`client/dist`, from `vite build`).
 *
 * `/` (and `/index.html`) answer with `game.html`, query string untouched, like
 * the dev server's rewrite (vite.config.ts): `/?house=1`, `/?nbhd=UserData2`,
 * `/?test=<name>` all reach the game page. Hashed bundle files live under
 * `/static/` and are cached forever; the HTML pages are always revalidated.
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

  const game = (_req: unknown, reply: FastifyReply): FastifyReply => reply.sendFile("game.html");
  app.get("/", game);
  app.get("/index.html", game);
  return true;
}
