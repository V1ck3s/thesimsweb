# User guide

thesimsweb runs **The Sims (2000, Complete Collection)** in a browser, from the files of an
installed copy of the game. The project contains **no game files**: you need your own installed
copy (the folder that contains `GameData/`, `UserData/`, `ExpansionShared/`...), either on the
server (the default), or, on an instance open to other people, imported into your own browser
(§ 3 bis).

## 1. Installation

### Locally (one machine, one player)

Tools: Node 22, pnpm 10, Rust + `wasm-pack` (see `docs/DEVELOPMENT.md`).

```bash
pnpm install
mkdir -p server/assets
ln -s "/path/to/The Sims" server/assets/Sims   # the game's install folder (read, never modified)
pnpm start                                     # builds what is missing, then serves the game
```

To check the game installation: `pnpm check-game` (the folder linked in `server/assets/Sims`), or
`pnpm check-game "/path/to/The Sims"`. The command compares the folder with the list of files of a
complete installation (Complete Collection, `client/public/gamefiles-reference.json`: paths and
sizes only) and reports what is missing, folder by folder (`--all`: list everything). Exit code 1 if
game files are missing; if only skins, music or sounds are missing: 0 (the game runs, with less);
a different size (another language or version, or a damaged copy) is reported without an error.
The landing page performs the same check (the "Game files" section).

Open <http://127.0.0.1:3000/>. Options: `pnpm start --port 4000` (or `PORT=4000`),
`HOST=0.0.0.0 pnpm start` for the local network, `SAVES=client pnpm start` to keep saves in the
browser (see § 3), `GAME_FILES=client pnpm start` so that each player imports their own game into
their browser (§ 3 bis).

### On a server (Docker)

`cp .env.example .env`, set `SIMS_DIR` (the game folder on the server) and
`THESIMSWEB_SAVES`, then `docker compose up -d --build`. Details, security and reverse proxy:
[`docker.md`](./docker.md). The server has no authentication: put it behind a reverse proxy with a
password and HTTPS, or on a private network.

## 2. The landing page

`/` opens a landing page (in English, outside the game):

- **Play** starts the game (`/game.html`);
- the **Game files** section: the installation check (missing files, per folder, and sizes that
  differ from the reference installation); on an instance in `GAME_FILES=client` mode, importing
  the game folder into the browser (§ 3 bis), checked once imported; **Play** is only enabled once
  the import is done;
- the instance's save mode, the number of saved files, **Export saves** and
  **Import saves...** (§ 4);
- the state of the browser storage (persistent or not, space used) and of offline mode (§ 6);
- the **Display** section: the game resolution, the centred interface and fullscreen (below).

### Resolution, centred interface and fullscreen

The original game draws one game pixel per screen pixel: in a large mode (the "widescreen" trick of
`Sims.exe`), the neighbourhood and the lot look tiny and the panels minuscule. The port keeps the
look of the default 1024 × 768 at every resolution: same zoom, same panels, scaled up to the size of
the screen; a wider screen shows more terrain to the left and right. The game renders its image at
about 768 pixels high (5120 × 1440 → 2731 × 768), so a high resolution costs about as much as
1024 × 768.

- **Resolution**: 1024 × 768 by default, or a common size from 800 × 600 to 5120 × 2160 (including
  5120 × 1440 at 32:9); 800 × 600 and 1024 × 768 run as they are, as in the original.
  - **Fit the window, following its size**: the game follows the size of the window during play
    (windows are repositioned; the control panel is rebuilt in a second or two, the old one stays
    displayed meanwhile; during family or Sim creation, the change waits until the screen is
    closed).
  - **Fit the window when the game starts**: the size of the window at launch, kept afterwards.
- Outside the centred interface, a screen wider than 1024 uses the "800" layouts of the Life panel
  pages (people, gifts, interests, relationships), as the original does: the game only provides its
  wide pages at exactly 1024 wide.
- **Keep the interface centred on very wide screens** (a port option, absent from the original,
  off by default): the control panel, the view control (the disc at the bottom left) and the
  overlay are placed in a centred band 1024 wide, exactly the 1024 × 768 interface (with its wide
  Life pages); the terrain fills the whole screen, including beside the panel.
- **Fullscreen** (a port option, off by default): on the first click, the game asks the browser for
  real fullscreen (the browser bar does not reappear at the top of the screen, unlike F11), and
  asks again on the next click if it was left.
- **Alt+Enter**, in game, turns fullscreen on or off at any time (a port shortcut) and remembers
  that choice like the option above: after leaving it this way, the game no longer asks for it on
  the next click. In Chrome, holding Escape also leaves it.
- Choices other than "following its size" apply at the next launch (reload the game tab). In the
  URL: `?res=1920x1080`, `?res=auto` or `?res=window`, `?hud=centred` or `?hud=full`,
  `?fullscreen=1` or `?fullscreen=0`.

Direct game addresses remain valid: `/game.html`, and `/` followed by a query string
(`/?house=1` goes straight into house 1, `/?nbhd=UserData2` picks the neighbourhood). A
bookmark on `/?...` therefore always starts the game.

The first launch reads the whole object catalogue; the game files are then kept by the browser
(IndexedDB) and later launches take a few seconds. On a slow connection, the "Game files" panel of
the landing page lets you download in advance, with a progress bar, the files that almost every
game uses (about 340 MB: the objects every lot loads, walls and floors, the Sims' bodies and
heads): entering a lot or creating a family then no longer waits for them. "Stop" keeps what has
been downloaded; "Clear downloaded files" removes the kept game files from the browser (not the
saves): the game downloads them again as needed and its next launch re-reads the object catalogue.
Play in only one tab at a time.

## 3. The two save modes

The mode is chosen per instance, when the server starts (the `SAVES` variable, or
`THESIMSWEB_SAVES` with Docker). The landing page displays it.

- **`server`** (default): a single set of saves, on the server
  (`server/data/overlay/`, or the `saves` volume with Docker). It can be reached from any browser;
  everyone who plays on the instance shares the same neighbourhoods.
- **`client`**: each browser keeps its own saves (IndexedDB) and starts from the original
  neighbourhoods of the game folder; the server is read-only. Saves are tied to the browser, the
  device and the site address (domain + port): changing any of the three, or clearing the site
  data, makes them disappear. **Export regularly** (§ 4) and accept persistent storage ("Keep this
  site's data" button on the landing page, or the browser's prompt).

Changing mode converts nothing; to switch from one mode to the other, export then import.

## 3 bis. Importing your own game into the browser (`GAME_FILES=client`)

An instance can be started without any game file on the server (the `GAME_FILES=client` variable,
or `THESIMSWEB_GAME_FILES=client` with Docker, see [`docker.md`](./docker.md)). This is the mode
for opening an instance to other people: the server only hosts the port's code and **never**
distributes the game files, which are protected by Maxis / Electronic Arts copyright. Each player
uses **their own copy** of the game:

1. Open the landing page, **Game files** section, then **Select the game folder...**.
2. Choose The Sims (Complete Collection) install folder on your computer: the one that contains
   `GameData`, `ExpansionShared`, `ExpansionPack` ... `ExpansionPack7`, `UserData`... (a folder one
   level above also works). Firefox and Chrome ask you to confirm access to the folder.
3. The page checks that the folder is complete (otherwise it says which files are missing), then
   copies into the browser the files the game reads (about **3.2 GB**, a few minutes; not the
   `.exe` / `.dll` programs, the logs, or the `support` folder). Nothing is sent to the server. A
   progress bar follows the copy.
4. **Play** becomes enabled. The original folder is never modified and is no longer needed
   afterwards.

Good to know:

- **One import per browser**: another browser, another device or another site address
  requires a new import. Plan for ~3.2 GB of free space on the browser's disk; accept persistent
  storage if the browser asks.
- **Interrupted** (tab closed, **Stop** button, out of space): selecting the same folder again
  resumes the copy where it stopped. In Chrome / Edge, the **Resume** button resumes without
  selecting the folder again.
- **Import again...** updates the import (after a game patch, for example): only changed files
  are copied again.
- **Remove the game files** frees the space; the saves stay.
- Saves stay in the browser (like the `SAVES=client` mode, § 3): export regularly (§ 4).
- Once the import is done, the game no longer needs the server for its files: it works offline
  (§ 6), music included.

## 4. Exporting and importing saves

**Export saves (.zip)** downloads a ZIP archive `thesims-saves-YYYY-MM-DD.zip` of all the files
written by the game, with their path in the game folder
(`Sims/UserData2/Houses/House01.iff`, `Sims/UserData/Characters/User00012.iff`...):

- in `client` mode, the files saved in this browser;
- in `server` mode, the files saved on the server (the originals of the game folder, never
  modified, are not included).

**Import saves...** replaces **all** the instance's saves with the contents of an archive, after
confirmation: saves absent from the archive are deleted (the game's original files reappear), those
in the archive are written. In `server` mode, this affects all the instance's players. Close the
game tabs before importing. The operation cannot be undone: export first if in doubt.

The import also accepts a hand-made archive (stored or "deflate"-compressed ZIP, as produced by
Windows, macOS and `zip`): only files under a `UserData`, `UserData2`... folder are taken,
whatever the folder above (`backup/UserData2/...`, `Sims/UserData2/...`, `UserData2/...`). You can
therefore bring over the saves of the original game on Windows by zipping its `UserData*` folders
(note: the archive replaces everything, original neighbourhoods included if it contains them). An
archive with no `UserData*` file at all is rejected without changing anything.

In `server` mode you can also copy the files directly (see [`docker.md`](./docker.md)).

## 5. Browsers

- **Firefox** and **Chrome / Edge** (desktop): supported.
- Safari: not tested regularly.
- The game is played with the mouse and keyboard.

## 6. Offline and installing as an app

The site can be installed as an application (Chrome / Edge: install icon in the address bar, or the
"Install..." menu; desktop Firefox generally does not offer it, but offline mode works there).

Once the game has been launched once on the device, **it restarts without a connection**:

- the landing page and the game (pages, scripts, WASM engine) are kept by a service worker;
- the game files already read are kept in the IndexedDB cache;
- the latest server responses (configuration, file list, neighbourhood and house files that were
  read) are kept by the service worker.

Limits:

- **HTTPS or localhost required**: browsers do not enable a service worker on an `http://` address
  of the local network (`http://192.168.x.x:3000`). The game works there, but not offline. Use
  `http://localhost` / `127.0.0.1`, or HTTPS via a reverse proxy.
- Offline, only what has already been read is available: a neighbourhood or lot never opened, a
  catalogue page never displayed, and the music (streamed, not kept) need the server.
- In `server` mode, the game **cannot save offline** (saves go to the server). In `client` mode,
  it saves normally in the browser.
- The development server (`pnpm dev`, port 5173) does not install a service worker: offline mode
  only applies to builds (`pnpm start`, Docker).
- **Family web pages in `client` mode** (the neighbourhood's Internet button, "export as HTML"
  option): the game writes them in the browser, and only the service worker serves them
  (`/webpages/...`). A build opened over HTTPS or on localhost is therefore required; without a
  service worker (`http://` address of the local network, `pnpm dev`), the link opens the original
  pages of the game folder (or a 404 error), not the player's. In `server` mode, the server always
  serves them.
- After a game update on the server, the new code is loaded at the next launch (online); the old
  one remains in use offline until the new version has been loaded.

## 7. Known limitations

- You need your own copy of the game, installed on the server, or imported into each browser
  (§ 3 bis, ~3.2 GB per browser).
- No server-side authentication (see [`docker.md`](./docker.md), "Security").
- Browser data (the game files cache, several hundred MB, and saves in `client` mode) can be
  cleared by the browser if the disk runs low on space, as long as storage is not persistent.
- Only one game tab at a time.
- The touch / mobile version is in progress.
- The rest (missing game features, known bugs): [`TODO.md`](./TODO.md).

## 8. Troubleshooting

- **The game does not start, or objects, sounds, neighbourhoods are missing**: `pnpm check-game`
  (or the "Game files" section of the landing page) says which files are missing.

- **The game no longer starts after an update**: reload the page (Ctrl+F5); if needed,
  developer tools → Application → Service workers → "Unregister", then reload.
- **Starting from scratch** (loses saves in `client` mode: export first): clear the site data in
  the browser settings.
