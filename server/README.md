# @thesimsweb/server

Local development server. Two responsibilities:

1. **Stream game assets** from `server/assets/` (gitignored, populated manually
   from your own legal install) over HTTP with Range support.
2. **Persist saves** in a local SQLite file, exposed via a simple REST API.

## Setup

The first time, drop your Sims install into `server/assets/`:

```bash
mkdir -p server/assets
# Either copy the folder you want to host:
cp -r "/mnt/c/Program Files (x86)/Maxis/Les Sims/." server/assets/
# Or symlink it (faster, no duplication):
ln -s "/mnt/c/Program Files (x86)/Maxis/Les Sims" server/assets
```

`server/assets/` and `server/data/` are gitignored — assets are never
committed, saves stay local.

## Run

```bash
pnpm --filter @thesimsweb/server dev
# → http://127.0.0.1:3000/
```

## Endpoints

- `GET /api/health` — liveness check.
- `GET /api/manifest` — JSON listing of every file under `server/assets/`.
- `GET /assets/<path>` — streams the asset, supports `Range`, sets ETag and
  cache headers.
- `GET /api/saves` — list saves of the current user (header `X-User`,
  defaults to `anonymous`).
- `GET /api/saves/:id` — fetch one save (raw bytes).
- `PUT /api/saves/:id?name=...` — upload a save (body: `application/octet-stream`).
- `DELETE /api/saves/:id` — remove a save.

Auth is intentionally a stub for phase 0 (`X-User` header). JWT will
replace this when the client gets a login UI.
