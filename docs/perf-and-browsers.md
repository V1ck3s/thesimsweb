# Performance and browser compatibility (2026-10-28)

Firefox pass of the faithful client (`game.html`), Live-mode profiling in Chrome and Firefox, and the
cold-start object scan. Nothing here changes game logic: every optimization below was checked to
produce the same pixels or the same data as before.

## Test setup

- Host: Windows 11 + WSL2 Debian, AMD Radeon iGPU. Dev servers: vite :5173, Fastify :3000 (and a
  second pair on :5174 / :3001 for the server-side changes, see "Server restart" below).
- Firefox: Playwright Firefox 141 (`npx playwright-core install firefox` in `~/simsweb-build/tools`),
  headless. It runs WebGL on the real GPU through Mesa D3D12 (the renderer string is sanitized to
  "Generic Renderer"; `webgl.sanitize-unmasked-renderer=false` shows `D3D12 (AMD Radeon(TM) Graphics)`).
- Chrome: `/usr/bin/google-chrome`, two modes:
  - headless + SwiftShader (the existing tooling): GL rasterized on the CPU;
  - headed (`HEADED=1`, a window opens through WSLg): ANGLE on D3D12, real GPU. Headless Chrome has
    no GPU here (`--use-angle=gl/vulkan` gives no WebGL2 context).
- Scenario: `game.html?house=1` (House01), modal dialogs answered with Enter, Live mode, speed 3,
  20 s sample after 2 s of warm-up. Numbers are per displayed frame; "screen paint" is the whole
  `WinMgr` plot (lot view, control panel, balloons, copies).

Tooling (all in `~/simsweb-build/tools/`):

| Script | What |
|---|---|
| `drive.mjs` | `interact.mjs` with `BROWSER=firefox` and `HEADED=1`; same steps |
| `perf.mjs [url] [s] [speed]` | wraps the lot view's hot methods from the page and prints frame / sim / render / copy times (`PRE_EVAL` runs code before the sample, e.g. to disable a cache) |
| `cpuprof.mjs` | Chrome CPU profile of a live lot: self time per function, callers of `getImageData` / `drawImage` |
| `scanindex.mjs <profile> <base> [firefox]` | boots, waits for the object scan, prints time, request count and a SHA of the cached index |
| `cmpframe.mjs <dir>` | renders the lot in Chrome and Firefox (profiles `<dir>/chprof`, `<dir>/fxprof`) and diffs the pixels |
| `samecheck.js`, `invalcheck.js` | page-side checks of the terrain cache (cold vs warm render, invalidation) |
| `audiocheck.mjs` | counts `decodeAudioData` successes / failures and started sources |

## Firefox compatibility

Main flow walked in Firefox: splash, neighborhood (hover popups, lot click), House01, Live mode with
sims moving and NPCs arriving, pie menu, action icons, Buy catalog, Build, Options, camera keys.
No page errors, no console errors (the only warnings are the `[sim] not ported` notes, same as
Chrome).

| Area | Result |
|---|---|
| WebGL2 compositor (z-buffer through `gl_FragDepth`) | Pixel-identical to Chrome: `cmpframe.mjs` diffs the whole 1024x668 lot render (terrain, floors, walls, objects, VitaBoy sims) with 0 differing pixels |
| VitaBoy sims | Same as Chrome (included in the diff above) |
| Web Audio | XA (WASM decoder -> WAV) and MP3 decode through `decodeAudioData` in both; context unlocks on the first pointerdown / keydown |
| IndexedDB object cache | Works; the cached index is byte-identical to Chrome's |
| Fonts | The game draws its own bitmap fonts (FFN); no CSS / canvas fonts involved |
| 2D canvas, `OffscreenCanvas`, `createImageBitmap` | Fine |
| Pointer / wheel | Mouse events only; wheel uses the sign of `deltaY`, so Firefox's line mode is fine |
| Keyboard | Fixed: `/` and `'` open Firefox's Quick Find bar, which then eats every key. `WinMgr` now cancels them when no window handles them |

Not browser issues, noted while testing: the F1..F5 mode shortcuts are not ported (in a browser F1 /
F5 open help / reload); `favicon.ico` 404 on every load (fixed with an empty icon in `game.html`).

## Live mode profile

Before the fixes, a frame cost 55..65 ms in every browser (16..18 fps):

1. **Static layers redrawn every frame.** As soon as people are on the lot, the view is dirty every
   frame and `HouseViewer.render` redraws everything. The worst part is the terrain: the grass swatch
   is rasterized in software into a 1024x668 color + depth buffer (`cColorSwatch` blitters), the
   16-bit depth is byte-swapped pixel by pixel and both are uploaded as textures. 14 ms (Chrome) to
   28 ms (Firefox) per frame.
2. **Action icons read the screen back.** `ObjectIcon.draw` composites over the canvas pixels with
   `getImageData` / `putImageData`. On the screen canvas (GPU-backed in Chrome) this forces a GPU
   sync per icon per frame: 59 % of the CPU profile in headed Chrome with a few queued actions.
3. Minor: per-wall-sprite allocations (`new Float32Array(256)` and three string keys in
   `WallBlitter.tables`, two typed arrays per `drawWallSprite`), and the lot frame copied twice
   (WebGL -> `OffscreenCanvas` -> screen) on rendered frames.

The simulation itself is cheap: ~0.2..0.3 ms per tick, 1.5..2.5 ms per frame at speed 3
(~480 ticks/s, the 2 ms tick period).

### Fixes

| Fix | Where | How it stays identical |
|---|---|---|
| Terrain raster cache | `world/houseviewer.ts` (`TerrainCache`), `world/terrain.ts` (`cacheKey`), `world/compositor.ts` (`drawRaw(..., changed)`) | The software terrain pass is redone only when an input changed: view origin / scale / rotation / bounds, the terrain's own state (PreCompute generation, overlay, quality, `terrainZ`), and the fixed-world arrays the swatches read (alt, ground, grass, target grass, pool, water, floors, walls, flags) compared byte for byte with a copy. Disabled while the dirt tool highlights tiles and during thumbnails. The `RenderParam` state the pass leaves behind is restored. Checked: cold vs warm renders identical in Live / Buy / Options, after a rotation and zoom; after changing grass, altitudes, time of day, the grid overlay and scrolling, the warm render equals a cold one (`invalcheck.js`) |
| Boxed action icons | `world/actionicons.ts` | An icon over its opaque box is always the same pixels: drawn once into a small canvas and blitted. Dimmed (cancelled) actions keep the old path. Checked pixel-identical for every icon seen in a session, in both browsers |
| One copy per rendered frame | `world/winlotview.ts` (`tsPaint`) | A rendered frame goes straight from the WebGL canvas to the screen; the `OffscreenCanvas` copy is only made when frames are repainted without a render |
| Allocation-free wall draws | `world/wallrender.ts`, `world/compositor.ts` | Table slots cached per scale (`table1D` slots never move); uniform arrays reused |
| Depth upload | `world/compositor.ts` | One `u16` store per pixel instead of two byte stores, into a reused buffer |

### Results (Live, speed 3, House01)

| Browser | Before: fps / frame / screen paint | After: fps / frame / screen paint | Notes |
|---|---|---|---|
| Chrome, GPU (headed) | 17.3 fps / 57.9 ms / 51.7 ms | 59.8 fps / 16.7 ms (vsync) / 2.4 ms | render 1.9 ms, sim 1.4 ms |
| Firefox (GPU) | 17.6 fps / 56.7 ms / 40.6 ms | 57.5 fps / 17.4 ms / 11.1 ms | render 2.9 ms, WebGL -> 2D readback 7.4 ms, sim 2.3 ms |
| Chrome, SwiftShader | 15.8 fps / 63.5 ms / 57.2 ms | 30.4 fps / 32.9 ms / 29.7 ms | the remaining 28 ms is the CPU rasterizing GL and reading it back; tests only |

"Before" for Chrome GPU is the current code with the terrain cache disabled before the icon fix,
i.e. the original paths. Ablation with only the terrain cache disabled (all other fixes in):
Chrome GPU 55.6 fps / render 14.2 ms, Firefox 21.4 fps / render 28.7 ms, SwiftShader 16.8 fps.

## Cold start (object folder scan)

`ObjectFolder.scan` reads the IFF header, resource map and OBJD chunks of every object file
(1408 IFFs: loose, or entries of ~85 FAR archives), ~5800 small `Range` requests, then caches the
index in IndexedDB.

1. **Chrome serializes requests to one URL in its HTTP cache** (cache lock), and most object files
   are entries of the same few FARs. Chrome: 67 s, Firefox: 22.5 s. Scan reads now use
   `cache: "no-store"` (the result is cached in IndexedDB anyway): Chrome 18.9 s.
2. **Batched ranges.** New endpoint `POST /api/ranges` (`server/src/routes/ranges.ts`): many
   `[path, start, end)` ranges in one request, overlay files first like `/assets/`, reads in
   parallel on the server. Client side, `RangeBatcher` (`engine/assets.ts`) sends every read issued
   in the same task together, so all files in flight advance one step per round trip. Each read
   resolves with the same bytes a `Range` request would (cut at end of file, failing where a 416
   would). The FAR entry tables are also fetched in parallel instead of one after the other.
   Without the endpoint (older server) it falls back to single uncached `Range` requests, 12 at a
   time (an unbounded fallback made Chrome drop requests and cache an incomplete index; bounded, it
   is correct).
3. **Manifest overlay listing cached.** `/api/manifest` walked the save overlay
   (`server/data/overlay/`, now ~4200 files) on every call: 7..9 s per call over `/mnt/c`, and a
   boot + lot load calls it about ten times. The listing is now cached and invalidated by the
   overlay's PUT / DELETE routes (`?refresh` also re-walks it).

| | Chrome | Firefox | Requests |
|---|---|---|---|
| Scan, before | 67.3 s | 22.5 s | ~5800 |
| Scan, fallback (server without `/api/ranges`) | 15.8..16.6 s | 16.3 s | ~6000 |
| Scan, batched | 5.1..5.8 s | 5.4 s | ~390 |
| Warm boot to the scan done (index cached), old manifest route | 48 s | 66 s | |
| Warm boot, cached overlay listing | 0.7 s | 1.1 s | |
| `?house=1` lot ready, warm, old manifest route | 138 s | 128 s | |
| `?house=1` lot ready, warm, new server | 10.7 s | 9.7 s | |

The index is byte-identical in every configuration (SHA-256 `85d73993…`, 1408 files, 5460 OBJDs,
141 sim objects, same stamp). The old-manifest timings were taken on the shared :3000 server while
another session was using it, so they are inflated, but each manifest call alone was 7..9 s.

## Server restart

The shared dev server (:3000, `tsx watch`) does not see file changes on `/mnt/c`, so it still runs
the old routes: no `/api/ranges` (the client falls back, scan ~16 s) and the per-call overlay walk.
Restart `pnpm dev` to get both. The :5174 / :3001 pair used for the measurements was stopped.

## Long play (soak test, 2026-10-30)

House01 at speed 3 for ~22 sim days in headless Chrome (SwiftShader), details in
`docs/decomp/playtest.md` ("Soak test"). About 2 real minutes per sim day.

| | Before the fixes | After |
|---|---|---|
| Heap (after GC) per sim day | +33..48 MB (killed visitors kept their VitaBoys, visitor flood) | +11..17 MB, back to ~320..350 MB on reload |
| Tick mean | 0.11 → 0.47 ms (up to 29 people) | 0.13..0.30 ms |
| Ticks ≥ 100 ms | 30 in 2 sim days (route failures in the crowd) | none in 11 sim days; 5..40 of 20..50 ms per 4 days |
| Save size | | House01.iff +17 KB in 11 sim days |

## Warm loads: asset requests (2026-11-02)

The devtools Network tab showed the same files many times on every load. Measured on a second load
(IndexedDB filled) of `?nbhd=UserData34` (a throwaway copy of the game's UserData), of its lot 1
(`&house=1`), and of every catalog icon (`loadCatalog()` then `icon()` of all 1209 products, what
paging through Buy mode does). "Browser" = requests the page issued (what devtools lists, HTTP cache
hits included); "network" = what reached the server (a counting proxy between vite and :3000).
Headless Firefox 141 and Chrome (SwiftShader); the game was being edited by other sessions at the
same time, so times vary by ~1 s.

What was re-requested on every load:

1. **`/api/manifest` (1.3..2 MB of JSON) on almost every asset lookup**: 6 calls for the
   neighborhood, 32 for a lot, ~100 for a cold lot (150 MB). It is not cacheable (it lists the
   save overlay). `fetchManifest` now fetches it once per page; `data/files.ts` invalidates it after
   every write or delete of a game file (checked: a written file shows up, a deleted one goes away).
2. **`UIRes.load` ran 24 times per lot** (once per family portrait, `cas/portraits.ts`): 24 x the
   five `Res_*.RT` / `.h` tables and 96 x `Res_Languages.h`. It now loads once per language.
3. **Catalog icons** were one uncached `Range` request each (`data/catalog.ts` `readAssetRange`).
   Firefox does not serve byte ranges from its HTTP cache here: 1209 requests and 9.6 MB from the
   server every time. They now go through `readAssetRangeCached` (engine/assets.ts): one batched
   `POST /api/ranges` the first time, IndexedDB (new `ranges` store, `DB_VERSION` 3) after.
4. **Loose files fetched without the IndexedDB cache**, served from the HTTP cache (`max-age` 1 h,
   then revalidated): HIT sound tables (`.hot` / `.hsm` / `.hit`), loose UI bitmaps and tables,
   VitaBoy skins, roof textures, cursors, `stdlight.lgt`, TemplateNPCs. They now use
   `readAssetFile` (engine/assets.ts): IndexedDB for game-folder files up to 8 MB (music is left to
   the HTTP cache), concurrent reads of one file share one request.
5. FAR entry reads (`readFarEntry`) skip the HTTP cache (`cache: "no-store"`): their bytes are in
   IndexedDB, and Chrome serializes cached requests to one URL. IndexedDB puts issued in one task
   share one transaction (Chrome lost part of thousands of single-put transactions when the page
   closed soon after a cold load, which the HTTP cache used to hide).

The object folder scan was already skipped on warm loads (0 `POST /api/ranges`); the catalog's
cold scan (`RangedIff`) now goes through the batcher (142 POSTs instead of ~3000 `Range` GETs).
Files under `Sims/UserData*` are still never stored (they change when the game saves) and are always
fetched `no-store`. Server side, `/assets` sends `Cache-Control: no-cache` for `Sims/UserData*`
(originals and overlay copies; the overlay sent no header, so browsers could reuse a saved file
heuristically) and keeps `public, max-age=3600` for the rest.

| Warm load | Before: browser / network (bytes) / time | After: browser / network (bytes) / time |
|---|---|---|
| Neighborhood, Firefox | 144 / 50 (24 MB) / idle 8.9..11 s | 48 / 46 (16.5 MB) / idle 5.1..6.2 s |
| Neighborhood, Chrome | 143 / 52 (24 MB + 6 MB music) / idle 7.2 s | 46 / 46 (16.5 MB) / idle 4.4 s |
| Lot, Firefox | 518 / 124 (56 MB) / lot view 9.4 s | 96..114 / 95 (9.3 MB) / lot view 6.7..8.2 s |
| Lot, Chrome | 513 / 126 (56 MB) / lot view 11.3 s | 113 / 95 (9.3 MB) / lot view 5.4..6.8 s |
| 1209 catalog icons, Firefox | 1209 / 1209 (9.6 MB) / 6.0..7.4 s, every time | first: 2 POSTs (9.4 MB) / 0.6..1.2 s; then 0 / 0.36 s |
| 1209 catalog icons, Chrome | 1358 / 420 (4.8 MB) / 3.2 s (first 14 s) | first: 3 POSTs / 0.85..1.0 s; then 0 / 0.26 s |

What is left on a warm load is the save data: 44 (neighborhood) or 93 (lot) requests for ~38
distinct `UserData34` files (7.5..15 MB; `Neighborhood.iff` 5 times, some characters 2..4 times, read
by different modules), one manifest, and `UserData/Neighborhood.iff` (the neighborhood list). They
are uncached on purpose; sharing one read between modules would need a per-load cache of writable
files. Music streams through `<audio>` (HTTP cache). Cold loads are unchanged within noise (Firefox
lot ~23 s to the lot view; Chrome's cold lot still waits ~2 min on its last requests).

## Save files and cold lots (2026-11-05)

**Per-load save-file cache** (`engine/assets.ts`, `saveFile`). Every read of a `Sims/UserData*`
file (`assetFetch` GET, `readAssetFile`, `readStandaloneIff`, and the range reads when the file is
already in hand) goes through one map of whole files: each file is fetched (or, with `SAVES=client`,
read from the browser's saves database) once per load, every caller gets its own copy of the bytes
(`readStandaloneIff` also parses the chunk list once and hands out copies). It stays correct by:
`data/files.ts` dropping the file after each `writeGameFile` / `deleteGameFile` (both save modes);
`resetSaveFileCache()` at the start of every load (`game/main.ts`: `showNeighborhood`, `showTown`,
`enterLot`), so a load still sees files changed elsewhere (another tab, another player of the shared
saves); failed reads are not kept, a missing file (404) is. Checked in both modes: 4 readers of one
file = 1 request, mutating a copy does not leak, missing → write → rewrite → delete reads 404 /
new bytes / newer bytes / 404, a client-mode copy shadowing an original goes back to the original
after a delete, and a file changed behind the page's back shows on the next load, not inside this one.

| Warm `?nbhd=UserData33&house=1`, Chrome | Before | After |
|---|---|---|
| Save-file requests (distinct files) | 94 (39): `Neighborhood.iff` 6 x, characters 2..4 x, `LotZoning.iff` 2 x | 39 (39) |
| Same, `SAVES=client` (`UserData2`, house 1) | | 4 (4) |

The neighborhood screen alone read each of its 45 files once already.

**Chrome cold lot.** Not a stall any more: with empty IndexedDB / HTTP cache the lot view is up in
15..19 s (dev server; 28..36 s on a prod build while the shared :3000 server was busy, its
`/api/manifest` alone took 8..21 s). What looked like "2 minutes on the last requests" is the
network-idle mark: once the lot runs, Live mode keeps reading animations and sounds on demand
(bursts of 20..60 FAR entries each time a sim starts something new), so the network stays busy for
1..2 min after the lot is playable. No request takes long (the slowest are ~1..2 s while ~1000 others
are queued). The `net::ERR_ABORTED` that Playwright reports for every `HEAD` of a FAR is a reporting
artifact (the same `fetch` resolves 200 with its content-length).

Each FAR entry was one `Range` request (2271 per cold lot, Chrome queueing them 6 at a time per
host). `readFarEntry` now reads through the shared `RangeBatcher`: 2967 → 1239..1351 requests per cold
lot, 180 GETs left (FAR heads and tails); the lot-view time is within noise (16.3 s → 15.6..18.8 s).
The entries are byte-identical (301 entries sampled from IndexedDB vs direct `Range` reads).
Firefox cold lot after the change: 23.4 s to the lot view, as before.

## Long play memory (2026-11-05)

House01 (a copy of the user's neighborhood) at speed 3 in Chrome, heap after a forced GC
(CDP `HeapProfiler.collectGarbage`) once per sim day, heap snapshots on day +1, +3 and +6 compared
by (type, constructor) with retainer paths for the new nodes.

- Heap per sim day: 540 → 597 → 614 → 650 → 654 → 664 MB; the growth goes down day after day
  (+57, +17, +36, +4, +10 MB). Most of it is caches filling on first use, not a leak:
  `VBAnimMgr`'s CMX cache (animation `Skill` rotations, 24 MB on days 1..3, 13 MB on days 3..6), the
  raw FAR entry cache in `engine/assets.ts` (`entryCache`, 16 then 15 MB: entries are kept even
  when their consumer keeps its own parsed copy), `VBAnimMgr`'s texture cache (3..4 MB) and the
  tree tables (bounded by the BHAVs in use).
- **One real leak, fixed**: `world/lotobjects.ts` kept each object's drawable in a `Map` keyed by
  the object, so every deleted object (food, dishes, visitors' objects, ...) stayed alive with its
  drawable: +480..700 `XObject` / `DrawableLotObject` per 2..3 sim days. It is a `WeakMap` now;
  after the fix the day +1 → +3 snapshot diff is 34 MB in all, 31 MB of it ArrayBuffers (the caches
  above), and no game object type is among the growers.
- Not done: `entryCache` could drop entries once their parsed form is cached (or not cache them for
  consumers that cache), which would remove most of the remaining growth; `engine/assets.ts` was
  being changed by other work at the time.

## Remaining issues

- **Firefox: WebGL -> 2D readback, ~7 ms per frame.** The lot is rendered in a WebGL canvas and
  copied into the 2D screen canvas every rendered frame. Chrome does this copy on the GPU
  (0.06 ms); Firefox on Linux reads it back. Removing it would mean showing the WebGL canvas as its
  own layer under a transparent UI canvas (or drawing the UI with WebGL): a window-manager change,
  not done here.
- **Simulation spikes** of 30..100 ms on some frames (first use of a tree, animation or sound, route
  searches). They are in `sim/*`, left alone while that code is being worked on.
- **Static objects, walls and floors are still redrawn every frame** with people on the lot (only
  the terrain raster is cached). It now costs ~2 ms on a GPU. A full static-layer cache needs the
  object-change notifications to be complete (the original's static/dynamic layer split); not worth
  the risk at this cost.
- **Headless Chrome (SwiftShader)** spends ~28 ms per frame rasterizing on the CPU: screenshot runs
  are slower than the real game. Use `HEADED=1` for timings.
- One-off `GPU stall due to ReadPixels` warnings in Chrome come from the portrait renderer
  (`cas/portraits.ts`, `readPixels` once per head).
- Lot load after the splash is ~2 s warm, mostly a chain of dependent fetches (neighborhood, family,
  characters, house); the splash itself has a minimum display time.

## Caches and route searches (2026-11-06)

- **Raw FAR entries** (`engine/assets.ts`, `readFarEntry`): reads in flight are still shared, but
  resolved entries are kept in a least-recently-used map bounded to 16 MB (entries over 4 MB are not
  kept); an entry dropped there is read again from IndexedDB. It used to keep every entry for the
  page's life (15..16 MB per sim day in the soak above). A failed read is no longer remembered (the
  next call tries again).
- **Animation skills** (`sims/vbanimmgr.ts`): VBAnimMgr::TryUnloadSkills is ported. HouseViewer::
  UpdateWorld calls it every frame (`world/winlotview.ts` pump); a skill whose keyframes are loaded,
  that a practice used once and that no practice has used for lbl_105BA0E4 = 160 s (Globs, 128 MB of
  RAM or more) is unloaded (Envelope<Skill>::Unload): dropped from the manager, its CMX file's parsed
  form dropped, the next FindSkill reads it again; `sim/personanim.ts` forgets it too. The port's
  practices are dropped without Skill::UnbindPractice, so Practice::Apply stamps the skill's last use
  (`Skill.lastUse`) instead of the original's practice count + unbind time; a practice still holding
  an unloaded skill keeps its own copy. Measured (dev server, Chrome SwiftShader, UserData copy, four
  lots one after the other, 60 s at speed 3 each): 809 skills / 623 with keyframes after lot 1, 753 /
  567 once lot 1's skills passed 160 s unused; heap after a forced GC 61 → 66 → 70 → 73 MB.
- **Route searches**: the original's XRoute::FindPath runs its whole search in one call (budget goals x
  area + 50 steps, at most 1000; no per-tick routing budget anywhere in the shipped code), so there is
  nothing to spread over ticks faithfully. 900 searches recorded on House01 (240 s, speed 3) replay in
  155 ms in all (worst 5 ms, median 0.04 ms, Node); the slow simulate calls of that run (up to 31 ms)
  held 0..4 searches whose sum stayed under ~10 ms. A spatial grid for ExpandRect's overlap scans gave
  identical results but was slower on these small searches (240 ms in all) and was not kept. A steady
  sim-side cost seen in the profile: `SimModule.familyFriendCount` (`cpFamilyFriendCount`, called by
  UpdateCPStateFromWorld every frame) is the top sim function (0.8 % of a 40 s profile).
- **Cold lot load** (empty browser profile, game folder on a busy /mnt/c): lot view after 33.6 s, 923
  requests, but the main thread was busy only ~4.5 s of it (idle 26.7 s): the load waits on the server.
  Our biggest main-thread cost was IndexedDB: one transaction per get (`engine/idb.ts` `withStore`,
  ~0.9 s). The gets issued in one task (FAR entries, IFF files, ranges, FAR manifests) now share one
  readonly transaction (`queueGet`, like the puts' `queuePut`). Next in that profile: portrait renders
  (`portraits.ts`, 0.4 s), WASM text decoding (0.3 s), floors' plugin scan (0.2 s). Warm load
  (filled IndexedDB, same lot) after the change: 5.5..5.9 s to the lot view, no errors.
