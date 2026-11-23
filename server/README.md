# @thesimsweb/server

Local development server. Two responsibilities:

1. **Stream game assets** from `server/assets/` (gitignored, populated manually
   from your own legal install) over HTTP with Range support.
2. **Persist saves** the way the game does: files written to the overlay
   `server/data/overlay/`, served in place of the game's own copies.

## Setup

The first time, drop your Sims install into `server/assets/`:

```bash
mkdir -p server/assets
# Either copy the folder you want to host:
cp -r "/path/to/The Sims/." server/assets/
# Or symlink it (faster, no duplication):
ln -s "/path/to/The Sims" server/assets
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
- `POST /api/ranges` — batched byte-range reads.
- `PUT` / `DELETE /api/files/Sims/UserData*/<path>` — write / remove a save in
  the writable overlay `server/data/overlay/` (the game folder stays read-only).
- `/`, `/static/*` — the built client (`client/dist`), when it exists.

Auth is intentionally a stub for phase 0 (`X-User` header). JWT will
replace this when the client gets a login UI.
