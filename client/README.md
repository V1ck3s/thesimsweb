# @thesimsweb/client

Vite + TypeScript frontend. The game is `game.html` (`src/game/`, ported from
the decompiled shell); `legacy.html` (`src/main.ts`) is the old prototype.

## Dev

```bash
# from repo root: client (vite :5173) + server (Fastify :3000) together
pnpm dev
# → http://localhost:5173/            the game (game.html)
# → http://localhost:5173/legacy.html the old prototype client
```

Vite proxies `/api/*` and `/assets/*` to the server on port 3000.

## Production

```bash
pnpm --filter @thesimsweb/client build   # tsc --noEmit + vite build → client/dist/
```

Hashed bundle files go to `dist/static/` (not vite's default `assets/`, which
is the server's game-data prefix). The Fastify server serves `client/dist`
itself: run `pnpm start` from the repo root (see the root README).
