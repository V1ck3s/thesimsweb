# Deploying on a server (Docker)

`Dockerfile` + `docker-compose.yml` at the root. The image contains the built game (WASM engine,
`client/dist`, Fastify server); **The Sims files are not in it** and must never be: they are
mounted read-only from the server, or, in "game files on the player's side" mode
(`THESIMSWEB_GAME_FILES=client`, see below), imported by each player into their browser.

## Setup

1. Copy the game's install folder to the server (for example `/srv/sims/TheSims`, the one that
   contains `GameData/`, `UserData/`, `ExpansionShared/`...). It is read as is, and the case of
   file names does not matter (verified on a case-sensitive Linux file system).
2. Copy the repository (or only the sources: see `.dockerignore`) to the server.
3. `cp .env.example .env` and set `SIMS_DIR` (required, except in
   `THESIMSWEB_GAME_FILES=client` mode), `THESIMSWEB_PORT`, `THESIMSWEB_BIND`, `THESIMSWEB_SAVES`,
   `THESIMSWEB_GAME_FILES` (see below). Without `SIMS_DIR`, compose mounts `./server/assets/Sims`
   (created empty if needed) and the server logs that it has no game folder.
4. `docker compose up -d --build`, then open `http://<server>:<port>/` (landing page: play,
   export / import saves; player's guide: [`user-guide.md`](./user-guide.md)).

Updating after a `git pull`: `docker compose up -d --build` (saves are kept).

### Image built by GitHub (without the sources on the server)

The workflow `.github/workflows/docker.yml` builds the image on every push to `main` and publishes
it to `ghcr.io/<owner>/thesimsweb` (tags `main`, `latest`, `sha-<commit>`, and `x.y.z` for a
`vx.y.z` tag). If the package is private, the server authenticates once with
`docker login ghcr.io` (a GitHub token with `read:packages`).

On the server, all you then need is a `docker-compose.yml` that replaces `build: .` with
`image: ghcr.io/<owner>/thesimsweb:main` (same variables, same volumes), a `.env` and the game
folder. Update: `docker compose pull && docker compose up -d`.

## Saves: two modes (`THESIMSWEB_SAVES`, the server's `SAVES` variable)

- **`server`** (default): one instance = one player. A single set of saves, on the server; it can
  be reached from any browser.
- **`client`**: one instance = several players. Each browser keeps its own saves
  (IndexedDB, `thesimsweb-saves` database, `client/src/engine/saves.ts`) and starts from the
  original neighbourhoods of the game folder. The server then refuses any write (403) and does not
  use the `saves` volume. Saves are tied to the site address (domain + port) and to the
  browser: changing address, browser, or clearing the site data loses them. The game
  asks the browser for persistent storage (`navigator.storage.persist`). The landing page
  exports and imports these saves (a ZIP archive, see [`user-guide.md`](./user-guide.md) § 4).

Changing mode converts nothing: the server's saves stay in the volume, the browsers' saves in the
browsers.

### `server` mode

The game writes its `UserData*` to the named volume `saves` (mounted on `/app/server/data/overlay`);
it survives rebuilds. To bring over existing saves (the local overlay
`server/data/overlay/`):

```bash
docker compose cp server/data/overlay/Sims thesimsweb:/app/server/data/overlay/
docker compose exec -u root thesimsweb chown -R node:node /app/server/data/overlay
```

To retrieve them: `docker compose cp thesimsweb:/app/server/data/overlay/Sims ./saves`.
Simpler: **Export saves** / **Import saves...** on the landing page (`GET /api/saves` lists the
overlay's files, the import goes through `DELETE` / `PUT /api/files`). Outside Docker, the server's
`OVERLAY_DIR` variable changes the overlay folder (default `server/data/overlay`).

## Intro movie

At startup, the game shows the EA intro movie for its language (`Music/eag_<language>.avi`, in
MS-MPEG4, which browsers cannot play). The server converts it once to WebM with
`ffmpeg` (`server/src/routes/movies.ts`, a copy is kept in `server/data/movies/`). The image
installs it by default; `docker compose build --build-arg WITH_FFMPEG=0` omits it (smaller image,
the movie is then skipped). In `GAME_FILES=client` mode, it is always skipped.

## Game files: on the server or on each player's side (`THESIMSWEB_GAME_FILES`, the server's `GAME_FILES` variable)

- **`server`** (default): the game runs on the server's `SIMS_DIR` folder, served under
  `/assets/` (with `/api/manifest` and `/api/ranges`). This is personal use: your own game, on your
  own server.
- **`client`**: **the server serves no game file**, only the application (pages,
  scripts, WASM engine). On the landing page, each player selects the install folder
  of **their own copy** of The Sims (Complete Collection); the page checks that it really is a
  complete game folder (`GameData/`, `ExpansionShared/`, `ExpansionPack...7/`, `UIGraphics/`,
  `SoundData/`, `UserData/Neighborhood.iff`...) and copies into the browser (IndexedDB,
  `thesimsweb-gamefiles` database, `client/src/engine/gamefiles.ts`) the files the game reads (not
  the `.exe` / `.dll`, the logs, `support/`, or the intro videos). The game only starts
  once the import is done; without an import, `/game.html` redirects to the landing page.
  `/assets/`, `/api/manifest` and `/api/ranges` answer 404, and saves stay in the
  browsers (`SAVES=client` is forced, `THESIMSWEB_SAVES` is ignored).

**Why this mode**: to open an instance to other people without **ever distributing the
files of Maxis / Electronic Arts**, which are protected by copyright. The server only
hosts the port's code (free software); each player brings their own copy of the game, which does not
leave their computer (the file is read by the browser, nothing is sent to the server). In
`server` mode, on the other hand, the instance serves the game to anyone who reaches it: reserve it
for yourself.

Limits:

- **Space**: about **3.2 GB** per browser (the whole Complete Collection minus the
  programs), stored in the browser profile. Firefox and Chrome accept it on a disk that
  has the room; the page requests persistent storage (`navigator.storage.persist`) so that the
  browser does not clear it when space runs low.
- **One import per browser** (and per site address, like saves): another
  browser, another device, another address (domain, port) requires a new import.
- The import takes a few minutes (a local copy of 3 GB). If interrupted (tab closed, **Stop**
  button), it resumes where it stopped when the folder is selected again: files
  already copied, with the same size and date, are not copied again. In Chrome / Edge, the
  folder picker (File System Access API) keeps the folder, and a **Resume** button resumes
  without selecting it again.
- The selected folder is only read. The original saves it contains (`UserData*`) are
  copied like the rest; the player's saves then hide them, as in
  `SAVES=client` mode.
- **Remove the game files** erases the import (saves stay); **Import again...** redoes
  an import (only changed files are copied again, those that disappeared from the folder are removed).
- The game then runs entirely in the browser: once the import is done, it starts without a
  connection if the service worker is active (HTTPS or localhost, see below).

Outside Docker: `GAME_FILES=client pnpm start` (or `GAME_FILES=client npx tsx src/index.ts` in
`server/`).

## Downloading files in advance

No more server variable (the old `THESIMSWEB_PRELOAD` / `PRELOAD` is ignored): each player
can, from the landing page ("Game files" panel), download in advance the files
that almost every game uses (about 340 MB: the objects every lot loads, walls and
floors, the Sims' bodies and heads; `client/src/game/preload.ts`), with a progress bar,
a button to stop and a button to clear what has been downloaded. Useful on a slow
connection: a lot or family creation then no longer waits for these files. Without this
download, the game reads files at the moment it needs them. Not offered with
`THESIMSWEB_GAME_FILES=client` (the files are already in the browser).

## Security

The server has **no authentication**: in `server` mode, anyone who reaches it can play and
overwrite the saves (`PUT` / `DELETE /api/files/Sims/UserData*/`). In `client` mode, it is
read-only, but still serves the game files to whoever reaches it, except with
`THESIMSWEB_GAME_FILES=client` (it then only serves the application). By default the port is only published on
`127.0.0.1`; put it behind a reverse proxy (Caddy, nginx, Traefik) with authentication and
HTTPS, or keep it on a private network (VPN). `THESIMSWEB_BIND=0.0.0.0` exposes it directly.

The reverse proxy must let `Range` requests and `PUT` bodies of up to 128 MB through
(nginx: `client_max_body_size 128m;`). Offline mode (service worker) requires HTTPS, except on
`localhost`: behind an HTTPS reverse proxy it works, over `http://<LAN-ip>` it does not.

## Image details

- `wasm` stage: `rust:1.95` + `wasm-pack` 0.14 → `crates/wasm-bindings/pkg`.
- `build` stage: `pnpm install --frozen-lockfile`, client and server build, `pnpm deploy`
  of the server with only its production dependencies.
- Final stage: `node:22-bookworm-slim`, `node` user, `HOST=0.0.0.0`, `PORT=3000`,
  healthcheck on `/api/health`. About 360 MB.
