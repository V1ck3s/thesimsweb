# @thesimsweb/client

Vite + TypeScript frontend. Phase 0 ships a "Hello, Sims" gradient triangle
on a WebGL 2 canvas to prove the build pipeline.

## Run

```bash
pnpm --filter @thesimsweb/client dev
# → http://localhost:5173/
```

The client proxies `/api/*` and `/assets/*` to the dev server on port 3000.
Run the server in parallel:

```bash
# from repo root:
pnpm dev   # runs both client and server
```
