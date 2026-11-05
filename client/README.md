# @thesimsweb/client

Vite + TypeScript frontend. The game is `game.html` (`src/game/`, ported from
the decompiled shell). `index.html` (`src/landing/`) is the landing page around
it: play button, saves export / import (`src/engine/saves.ts`, `zip.ts`),
storage and offline state. `src/sw/sw.ts` is the service worker (built to
`/sw.js` by `vite.config.ts`, production builds only; `src/engine/pwa.ts`
registers it); `public/` holds the web manifest and icons.

## Dev

```bash
# from repo root: client (vite :5173) + server (Fastify :3000) together
pnpm dev
# → http://localhost:5173/            the landing page (index.html)
# → http://localhost:5173/game.html   the game ("/?house=1" etc. also start the game)
```

Vite proxies `/api/*` and `/assets/*` to the server on port 3000.

## Production

```bash
pnpm --filter @thesimsweb/client build   # tsc --noEmit + vite build → client/dist/
```

Hashed bundle files go to `dist/static/` (not vite's default `assets/`, which
is the server's game-data prefix). The Fastify server serves `client/dist`
itself: run `pnpm start` from the repo root (see the root README).
