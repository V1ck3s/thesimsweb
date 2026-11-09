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
| Terrain scroll | `world/houseviewer.ts` (`scrollTerrain`, `computeTerrainExtents`, `crossing`), `world/compositor.ts` (`shiftRaw`, `uploadRaw`), `world/terrain_swatch.ts` (`carryLog`, `putRow4`) | A scroll keeps the terrain pass: the raw layer is moved on the GPU (`blitFramebuffer` between two texture sets) and only the uncovered strips and the bands along the edges are drawn again. The terrain's pixels follow the view except where the original's clipping shows: tiles culled by their top corner and by a rectangle their columns overrun, the bottom clip's row parity, the dropped partial column at the right edge. The bands cover every tile crossing an edge, old and new, from each tile's real pixel extent (the column formulas, computed from the altitudes after each full pass); each strip is drawn by the whole pass (same tiles, same order) clipped to a target that reaches past its inner edges to rows no crossing tile reaches. The swatches dither by screen row: the layer keeps the colors for both origin parities (`TerrainTarget.color2`), so odd vertical moves work. A tile that takes state from the tile drawn before it (a floored tile with a diagonal wall keeps the previous blade count; border tiles when drawn) is logged, and any change sends the frame to a full pass. Checked: after random scrolls (odd and even, single steps and chains of 5) at the three zooms on four lots, with the grid overlay, at 1366, 1820 and 2731 wide, every incremental frame equals a full render (0 differing pixels) |
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
- **Animation suits**: VBAnimMgr::TryUnloadSuits / TryUnloadAll are ported (`sims/vbanimmgr.ts`,
  called on entering Live mode), but as in the original the suits pass shares the skills pass's
  clock gate and never runs, so no memory is freed (see docs/decomp/sim-port.md).
- **BoboVision gadget blend** (`cpanel/viewcontrol.ts`, `compose565`): the exact AlphaBlend_565_565_P5
  table blend reads back the parent's 220 x 183 pixels under the view control gadget every frame it
  is plotted. Measured (Chrome SwiftShader, House 1, 10 s live): WinViewControl.plot 0.58 ms mean
  with the old canvas blend at the table's mean weights, 1.24 ms with the exact blend (max 4.2 ms);
  0.28..0.33 ms without BoboVision.
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

## Lot load and tick costs (2026-11-06, second pass)

Method: Chrome (SwiftShader) through the Vite dev server, a copy of UserData, House01. Cold = an
empty browser profile; warm = the same profile loaded again. "Busy" is the main thread's non-idle
time in a CDP CPU profile from navigation to the lot view (`window.game.lotView.sim`). Five sessions
shared the machine and the server, so wall-clock times vary a lot between runs (the first cold run
waited 111 s on the server, later ones 12..52 s); the busy time and request counts are the
comparable figures.

| | before | after |
|---|---|---|
| cold: requests (assets / api / dev modules) | 918 (434 / 217 / 267) | 608..616 (46 / 290..298 / 272) |
| cold: main thread busy | 7.1 s | 3.2..3.3 s |
| warm: lot view, main thread busy | 8.0 s, 4.4 s | 4.9..6.1 s, 1.6..2.6 s |

What changed (behaviour unchanged):

- **IndexedDB puts off the main thread** (`engine/idb.ts`, new `engine/idbworker.ts`): IndexedDB
  structured-clones every stored value on the calling thread; the put batches (`queuePut`) now go to
  a module worker that writes them, the FAR entry / file / range bytes being transferred (they are
  fresh copies) instead of copied. ~1 s of the cold load (the ~2500 entries and ranges of House01).
  Without workers the batches are written on the main thread as before. Gets still deserialize on
  the main thread (`req.onsuccess`, 0.25..0.4 s of a warm load: the next item).
- **Portraits kept in IndexedDB** (`cas/portraits.ts` `generatePortraits`, new store "portraits",
  DB version 4): the pictures rendered from body strings (family members and NPCs whose stored
  pictures are missing or blank) are kept under `v<version>|<language>|<body strings>`; a warm load
  renders none (0.5..0.7 s before). Bump `PORTRAIT_CACHE_VERSION` when the rendering changes.
- **WASM strings** (`crates/wasm-bindings/src/lib.rs`): every `JsValue::from_str("literal")` made a
  new JS string through `TextDecoder` (property names of every STR# entry and IFF chunk); the
  literals and the chunk kinds are now made once and reused (`key`, `kind_value`). `decodeText`
  0.25..0.31 s → 0.02..0.06 s.
- **Plugin scan** (`world/floors.ts` `scanPluginFiles`, floors and walls): the manifest's ~10 000
  paths are lower-cased once per manifest instead of ~20 times per scan, and the expansion archives'
  FAR manifests are all asked for at once (then used in order). 0.26 s → 0.09 s.
- **Requests** (`engine/assets.ts`): `readFarManifest` read a FAR header (Range), its size (HEAD)
  and its manifest (Range) one archive at a time: the header and the manifest now go through the
  range batcher and the size comes from the asset manifest (HEAD only for a file it does not list),
  so the ~70 Downloads archives and the expansion images cost a few `/api/ranges` posts instead of
  ~240 requests. `readAssetFile`, for a file of at most 1 MB the already-loaded manifest lists, also
  goes through the batcher (the 46 cursors, the loose .flr / .wll plugins). The remaining asset
  requests are the save files (Sims/UserData*, never cached) and the large IFFs.

Steady sim and tick spikes (House01, speed 3, CPU profiles of 40..90 s):

- `CPState::GetFamilyFriendCount` (control panel, every frame through `pushPeople`) counted the
  family's friends over the whole neighborhood each time (0.2 % of a 40 s profile, the top sim
  function). The original keeps the count in the Family (+0x120) with a dirty flag (+0x124) set by
  AddToFamily, RemoveFromFamily and Neighborhood::RelationshipsChanged, which
  ObjectModule::SetRelationshipDirty calls for both neighbors whenever a relationship primitive
  writes one; Neighborhood::GetFriendCount (neighbor data 5) does the same with Neighbor +0x20 /
  +0x24. Both are ported (`sim/simmodule.ts` `familyFriendsCount`, `neighborFriendCount`,
  `setRelationshipDirty`, called from the two relationship primitives in `sim/xobject.ts`); a lot
  load starts with every count dirty. Not in the profile any more.
- Slow simulate calls (over 12 ms; 10 in 90 s, worst 21..31 ms) were mostly BHAV execution,
  routing and placement tests (faithful work). Ours in them, now cut: STR# parsing on first use
  (`sim/behavior.ts` `parseStringSet`: format -3 sets decoded every language's string and comment
  to keep one; strings of other languages and comments are now skipped, short ASCII strings are
  decoded without `TextDecoder`), ~13 % of the spike samples; `Placement.isPartOfMe` built the
  multi-tile chain (a scan of every object) for each object it tested (`world/tools/placement.ts`),
  ~8 %; neighbor data 6 (`familyOfMember`: a GUID → family index instead of a search of every
  family's members), ~8 %.
- After these, the slow calls (still 10..12 per 90 s over 12 ms, worst 22..28 ms on the shared
  machine) are route searches: `spacepartition.ts` `intersectingPartitionRect` / `overlaps` (~17 %
  of the spike samples), `routing.ts` `constructGoals` (~6 %), then BHAV interpretation. See the
  route search notes above (no faithful way to spread a search over ticks).

Left: IndexedDB gets deserialize on the main thread (warm load 0.25..0.4 s; reading through the
worker would move it, at the price of a copy back or a transfer per entry); the cold load still makes
~290 `/api/ranges` posts (each task's reads are one post; a short delay before flushing would merge
more of them, at a latency cost); portraits are still rendered on the first load of a person.

## Lot load, third pass (2026-11-07)

Method as in the second pass (Chrome SwiftShader, Vite dev server, a copy of UserData, House01, CDP
CPU profile of the main thread from navigation to `window.game.lotView.sim`; cold = empty browser
profile, warm = the same profile again). Before and after were run alternately, three times each,
with the old files served from a snapshot of the same tree (machine load ~5).

| | before | after |
|---|---|---|
| cold: main thread busy | 2.97..3.08 s | 2.63..2.68 s |
| cold: POST /api/ranges (of which single-range) | 286..291 (209..218) | 235..247 (152..167) |
| cold: wall clock to the lot view | 10.1..10.8 s | 10.7..11.1 s |
| cold: portrait rendering (`renderPortraits`, inclusive) | 250..266 ms | 180..203 ms |
| warm: main thread busy | 1.57..1.61 s | 1.06..1.14 s |
| warm: `engine/idb.ts` self time | 229..245 ms | 14..16 ms |

What changed (behaviour unchanged):

- **IndexedDB gets in the worker** (`engine/idb.ts` `queueGet`, `readGets`; `engine/idbworker.ts`):
  the gets batched per task are read by the cache's worker (the one that already wrote the puts),
  which answers each batch with one message, the values' buffers transferred: the main thread no
  longer deserializes the FAR entries, files and ranges it reads (the 0.23..0.25 s of
  `req.onsuccess` in a warm load). Every get of a batch now answers in the same task, so the misses
  of a cold load ask the range batcher together (fewer, larger `/api/ranges` posts). Without
  workers the batch is read on the main thread as before. FAR manifest puts (`idbPutFarManifest`)
  go through the same batched worker puts instead of one main-thread transaction each.
- **One copy per range read** (`engine/assets.ts` `RangeBatcher(copies)`, `readAssetRangeBatched`'s
  `persist`): the shared batcher copies each range out of the `/api/ranges` response for its
  reader, and the reads to be kept in IndexedDB (FAR entries, small files, cached ranges) hand
  their view of the response to the put queue, which transfers the response buffer to the worker
  (the worker stores each view's own bytes: `ownBytes`). Before, each such read was copied twice on
  the main thread (once for the reader, once for the put). The put batch's transfer list is a Set
  (it was an O(n²) `includes` over ~2500 buffers).
- **FAR entry lookup by name** (`assets.ts` `entryByName`): `readFarEntry` searched the archive's
  manifest with two `toLowerCase` per entry for each of ~2000 reads; a per-manifest map is made once.
- **Portrait rendering** (`cas/portraits.ts`): `quantize` masks the channels (`& 0xf8 / 0xfc / 0xf8`,
  what expand565 of the 565 color gives) instead of building a 3-element array per pixel, and
  `scaleBitmap` uses precomputed taps and direct array reads instead of closures; the output is
  bit-identical (checked on random images against the old code). What remains of the ~0.2 s is
  mostly `readPixels` waiting for the (software) GPU: 12 head renders per person.

Left:

- **Range posts**: of the ~240 cold posts, ~150 still carry one range, but they are spaced
  20..40 ms apart: they are chains of dependent reads, not reads that a flush window would catch
  (only ~30 posts follow the previous within 5 ms). The single-range chains are the UI resource
  tables (`res/uires.ts`: each `.RT` / `.h` read after the previous one is parsed), the sound
  `.hot` / `.HIT` / `.hsm` triples per expansion (`audio/`), the FAR header-then-manifest of each
  expansion archive, and the tail of the object folder scan (`world/objectfolder.ts` `pool`, one
  OBJD read per Downloads / expansion file as the last workers finish). Merging those means
  issuing them in parallel in their callers (prefetching the tables, the sound files), not a
  batcher change; a timer window would only add latency to every chain. (Done in the fourth
  pass below.)
- **Portraits off the main thread**: rendering them in a worker (OffscreenCanvas) needs the
  person's skeleton, suits, meshes and textures (VBAnimMgr) and the UI template bitmaps (UIRes)
  loaded in the worker; not done. They cannot simply be deferred: the control panel shows the
  family's faces (2002 / 2003) as soon as the lot is up. First load of a person only (IndexedDB
  cache since the second pass).
- In a warm load, ours that remain are small and spread out (WASM glue building JS objects with
  `Reflect.set` ~40 ms, audio `parseHot` / `listDir`, the floors' plugin scan, BMP decoding).

## Lot load, fourth pass: serial read chains (2026-11-07)

Method as in the third pass (Chrome SwiftShader, Vite dev server, House01 of a copy of UserData,
CDP CPU profile from navigation; cold = empty browser profile, left 30 s so its IndexedDB writes
land, warm = the same profile again), plus a second end point: the lot view joining the screen
(`window.game.lotView.parent`, after the control panel's init; `lotView.sim` is set before it).
Old files served by a second Vite from a snapshot of the tree; before and after alternated, three
runs each (machine load 3..6).

| | before | after |
|---|---|---|
| cold: wall clock to `lotView.sim` | 10.1..10.3 s | 7.8..7.9 s |
| cold: wall clock to the lot on screen | 13.6..13.8 s | 9.3..9.4 s |
| cold: main thread busy to `lotView.sim` | 2.59..2.64 s | 2.41..2.42 s |
| cold: main thread busy to the lot on screen | 3.47..3.52 s | 3.00..3.04 s |
| cold: POST /api/ranges to `lotView.sim` (single-range) | 240..243 (154..155) | 112..123 (32..48) |
| cold: POST /api/ranges to the lot on screen (single-range) | 491..495 (271..275) | 131..141 (32..48) |
| warm: to `lotView.sim` / on screen | 4.6..4.7 s / 5.1..5.2 s | 4.5..4.7 s / 4.9..5.1 s |
| warm: main thread busy (sim / screen) | 1.03..1.11 s / 1.49..1.59 s | 1.01..1.12 s / 1.47..1.58 s |

Found with the initiator stacks of the single-range posts (CDP `Network.requestWillBeSent` with
async stacks). The callers now ask for their reads together and use the results in the same
order as before; the loaded state is the same (digests of the sound tables, UI resource ids, the
VitaBoy indexes, both object folder indexes, the buy catalog, the careers / fame / zoning tables
compared between old and new, cold and warm):

- **VitaBoy indexes** (`sims/vbanimmgr.ts` `create`): the `.ndx` of each expansion archive and of
  every Downloads archive (~80) were read one after another (~1.3 s of 10 ms round trips, on the
  portrait path of the lot load); now one batch, applied in site order.
- **Control panel bitmaps** (`res/uires.ts` `prefetchTable`, `game/main.ts` `enterLot`): the
  control panel's windows load their bitmaps one by one (interest, view control, camera, people,
  options panels: ~70 dependent reads, ~2 s between `lotView.sim` and the lot on screen). The
  bytes of every bitmap `Res_CPanel.RT` maps (in the UI language) are now read when `enterLot`
  starts, during the lot load, and handed to the first read of each; the rest is dropped when
  `enterLot` ends. A cold load reads up to ~3 MB more than it uses (once: then IndexedDB).
- **UI resource tables** (`res/uires.ts` `read`): the four `.RT` tables in one batch, then the
  `.h` headers they include in a second, parsed in the old order (9 round trips to 2).
- **Sound tables** (`audio/boxx.ts` `init`, `readDataDirectory`; `audio/fresh.ts` `init`'s
  `read`): the `.hot` / `.HIT` / `.hsm` of the nine data folders and the four ambience scores in
  one batch, registered folder by folder as before.
- **FAR tables** (`engine/assets.ts` `readFarManifest`, `farTailGuess`): with the archive size
  from the asset manifest, its last 1/256 (4..64 KiB) is read with the header; a manifest table
  that fits (all but the dozen biggest archives) costs one round trip instead of two, a bigger one
  two as before (the part before the guess, then the guess). At most ~1.5 MB more read for the
  ~90 archives, once.
- **Object folder scans** (`world/objectfolder.ts` `scannedObjds`): the start-up scan
  (`ObjectFolder.get("UserData")`) and the lot's neighborhood scan read the same OBJD
  ranges of the game's object files twice (cold, when the neighborhood is not UserData); the
  OBJD chunks a scan read are now kept for the page (a copy, ~1 MB) and shared, the save files
  (`Sims/UserData*`) excepted.
- **Smaller ones**: the four placeholder selectors (`ObjectFolder.getPlaceholders`) together;
  `Simulator.create` asks for LotZoning.iff, work.iff (careers, grades) and fame.iff (titles,
  scoring: it was read twice) when it starts and uses them where it did.

Left:

- The buy catalog scan (`data/catalog.ts`, 64 files in flight, each reading its OBJDs one after
  another) still runs ~25 s after a cold lot load in 64-range posts. More files in flight
  (tried 512) pulled that work into the lot load (main thread busy +0.5 s) for little gain.
- The remaining single-range posts are dependent by nature (a CMX, then its meshes, then their
  textures for each portrait; a font, then its bitmap), or single files read at different times
  (floors.iff, Sprites.iff).

## Screen sizes (2026-11-07)

**Update (same day): the game now runs at `gameSize` (about 768 high) and the canvas is scaled up**
(see ui-coverage.md "Screen size"), so a large resolution draws about as much as 1024 x 768. Headed
Chrome on a busier host, same probe: 1024 x 768 19.6 fps (render 26.0 ms), 3840 x 2160 (1365 x 768)
render 24.2 ms, 5120 x 1440 (2731 x 768) 17.8 fps (render 29.3 ms). The table below is the earlier
native-pixel rendering.

The screen size is now a setting (`engine/display.ts`, see docs/decomp/ui-coverage.md "Screen
size"). Measured on House01 of a throwaway copy of UserData, Live, speed 3, 15 s, mouse over the
lot, with `perf.mjs` taking the viewport and `?res=` (fps / frame mean / screen plot mean /
lot render mean, ms). "CPU blend" is the view control gadget's exact BoboVision blend as it was
(`compose565`, the screen read back with `getImageData`), "GPU blend" the new path below.

| Size | Chrome headed (ANGLE D3D12), CPU blend | Chrome headed, GPU blend | Chrome SwiftShader, CPU blend | SwiftShader, GPU blend | Firefox headless (Linux), GPU blend |
|---|---|---|---|---|---|
| 1024 x 768 | 28.3 / 35.3 / 32.8 / 17.2 | 29.6 / 33.8 / 31.1 / 17.8 | 23.5 / 42.5 / 39.5 / 34.0 | 20.7 / 48.3 / 45.0 / 38.4 | 25.1 / 39.8 / 32.0 / 24.7 (copy 5.9) |
| 1920 x 1080 | 13.5 / 74.7 / 71.5 / 51.5 (noisy) | 25.3 / 39.6 / 36.5 / 22.8 | 10.4 / 96.4 / 90.2 / 76.0 | | 22.0 / 45.4 / 40.1 / 23.8 (copy 11.5) |
| 2560 x 1440 | 18.3 / 54.8 / 51.0 / 26.7 | 22.2 / 45.0 / 41.5 / 26.8 | 7.7 / 130 / 126 / 102 | 6.8 / 148 / 143 / 116 | |
| 3840 x 2160 | 12.5 / 80.4 / 75.9 / 38.2 | 17.0 / 58.9 / 54.9 / 37.4 | 4.3 / 231 / 225 / 169 | 4.3 / 234 / 228 / 171 | |
| 5120 x 1440 | 13.7 / 72.7 / 68.2 / 34.9 | 17.0 / 58.6 / 54.0 / 37.1 | 4.7 / 214 / 208 / 158 | 4.5 / 221 / 215 / 164 | 11.7 / 85.1 / 76.2 / 32.0 (copy 35.3) |

The 1024 x 768 numbers are well below the 2026-10-28 table (59.8 fps headed): the host was
busier (other browser sessions on the same GPU) and the lot does more since; compare columns,
not with that table.

- **View control blend read back (fixed).** A headed Chrome CPU profile at 1024 x 768 had 73 % of
  the main thread in `getImageData` under `WinViewControl.compose`: reading the screen canvas
  waits for the GPU to finish everything queued for the frame. The blend now runs in a small
  WebGL 2 context (`cpanel/compose565gl.ts`): the screen rectangle under the gadget is copied
  canvas to canvas, uploaded, blended by a fragment shader with the same table and integer
  arithmetic, and drawn back. Checked identical to `compose565` on a noise background (0 of
  360 000 bytes differ; `WinViewControl.cpuCompose = true` switches back for checks). The upload
  still waits for the screen canvas (it moved the sync to `texImage2D`), so the gain is the
  readback and CPU blend, not the wait: +5 % fps at 1024 x 768, +25..85 % at the large sizes in
  headed Chrome. Without the blend at all (BoboVision off, or the call stubbed) headed Chrome
  runs at 48 fps at 1024 x 768: the remaining cost is the GPU itself, see below. In SwiftShader
  the second GL context costs a little (GL is on the CPU there).
- **The lot render is GPU bound here.** The CPU profile of the lot render is mostly idle while the
  frame takes ~17 ms at 1024 x 768 (340 draw calls a frame); it grows to ~37 ms at 5120 x 1440 as
  more of the lot is on screen (the original draws more there too). ANGLE on D3D12 through WSLg
  is a slow path for many small draws; on a native Windows browser it should be far faster
  (not measured here).
- **Scrolling at large sizes (2026-11-08)**: the terrain pass was redone on every scrolled frame,
  in proportion to the view's area (CPU time of a render at 2731 x 668: 33 / 71 / 50 ms at the
  three zooms). With the terrain scroll: 3.7 / 4.8 / 3.9 ms scrolling sideways, 13 / 31 / 29 ms
  diagonally (the edge bands); a full pass costs a little more than before (both parities are
  written). End to end in headed Chrome here, sideways scroll 15.9 -> 26.5 fps; diagonal moves
  stay GPU bound on this host.
- **Firefox (headless, Linux): the WebGL -> 2D copy grows with the size**: 5.9 ms at 1024 x 768,
  11.5 ms at 1920 x 1080, 35 ms at 5120 x 1440 (a CPU readback of the lot frame, see "Remaining
  issues"). Firefox on Windows draws canvases on the GPU and is expected not to read back (not
  measurable from WSL). Removing the copy means showing the lot's WebGL canvas as its own layer
  under a transparent UI canvas; the view control blend and the frozen-screen copy
  (`screens/frozen.ts`) would then have to read both layers. Not done.
- SwiftShader rasterizes GL on the CPU: its frame time grows with the pixel count (4.5 fps at
  5120 x 1440). Use it for screenshots, not for timings of large sizes.

## Slow connections and phones (2026-11-08)

Measured on the deployed instance (headless Chrome, a fresh profile each time, recorded with
`scripts/record-reads.mjs`):

| Cold load | Downloaded |
|---|---|
| Start-up to the neighborhood | 42 MB |
| First lot (House01 / House05 / House03) | 273 / 168 / ~100 MB, of which ~180 MB is common to all three |
| Create-a-Sim | a few MB, then each body or head browsed |

Every lot load reads the same object files whatever the lot (people, cars, NPCs, the magic wagon,
doors, windows, stairs, beds…), plus every wall and floor plugin. On a slow connection this made
the first lot take minutes, and Create-a-Sim showed sims without their meshes or textures.

- **Preload** (`client/src/game/preload.ts`, only when the server sets `PRELOAD=1`; off by
  default): under the splash screen, with a progress bar, the
  files common to the recorded lot loads (`client/src/game/preload-lots.json`, written by
  `scripts/preload-list.mjs` from recordings), the object files `ObjectFolder.everyLotFiles`
  names, every wall and floor plugin, and the sims' bodies and heads (meshes, textures, suits:
  names starting with `b` / `c` / `xskin-b` / `xskin-c`). The first run downloads about 340 MB.
  The cache's keys are read once (`idbCachedKeys`), so later starts skip the step. After it, a lot
  not among the recorded ones (House02) downloads 29 MB instead of 200+.
- **Retries** (`fetchRetry`, `engine/assets.ts`): asset requests are asked again on a network
  error or a 408 / 429 / 502..504, about 30 s in all. VBAnimMgr no longer keeps a failed read: a
  mesh, texture, suit or animation that could not be downloaded is read again the next time
  instead of leaving the sim invisible for the rest of the page's life.
- **Landing page on phones**: the clouds lost their `filter: blur()` and the turning plumbob its
  two `drop-shadow()` filters, which the GPU redid every frame. The glow is now a still gradient
  behind it. The installation check downloads the server's file list (890 KB) only once its panel
  scrolls into view. Main-thread style work at idle (emulated phone, CPU / 6) went from 337 to
  199 ms per 4 s; the GPU cost cannot be measured here (SwiftShader).


## Picture in picture (2026-11-09)

The live zoom window (cWinPictureInPicture, user events such as the car pool) draws the lot a
second time each frame, at its own scale and origin (`drawPictureInPicture`). Measured in headless
Chrome (SwiftShader, House01 of a throwaway UserData copy, speed 1): 31 frames/s without the window,
9.3 with a 300 x 300 window at scale 1.

- The software terrain pass is cached for one scale and origin (`TerrainCache`, the compositor's raw
  layer). The picture invalidated it each frame, so the whole terrain was rasterized twice a frame
  (for the picture, then again for the lot view). The picture now has its own terrain state
  (`HouseViewer.swapTerrainState`, `Compositor.swapRawState`); each one scrolls its own cache.
- `ColorSwatch.initGrass` kept the blades of one scale only: they are now kept by scale (same seed,
  same blades).
- The picture's frame is clipped to its square (`Compositor.setFrameClip`, scissor), the floor and
  object tiles that cannot reach it are skipped (`HouseViewer.pictureCull`), the frame is not copied
  to the canvas (`render(false)`) and only the square is read back (`Compositor.readColor`).

Result: 18 to 19 frames/s with the window at scale 1, 23.7 at scale 3 (the lot view alone: 26 to
31). What remains is the second draw of the lot's sprites and people in the square.
