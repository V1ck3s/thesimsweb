# Remaining work

Single list of what is still open, checked against the code on 2026-11-05. The "not ported" notes
in the porting documents (`docs/decomp/*-port.md`) and the "Remaining" tables in
`docs/decomp/playtest.md` are history; this list is the reference. When an item is done, remove it
from here and record the fix in `playtest.md` / the git history.

In parentheses: the original class or function, then the relevant port file (paths under
`client/src/game/`).

## 1. Observed bugs

- **Pets stuck in "Action - Chase Tail"** for more than 8 game hours: not reproduced (an action
  lasts 30 to 60 min; the pet probably picks it again, fun ad 20).
- **Error 62 in "do new adult idle"**: Breakpoint in the data (node 29 of tree 8330), also in the
  original; what pushes "Wait" on a person who is carrying something: not found.
- **"user00177"**: fixed (write order of the original's character file: name before the
  neighborhood save, on import as in Create a Sim). The user's orphan files
  `UserData/Characters/User00177.iff` and `User00178.iff` (Create a Sim interrupted by a
  reload) are left as they are.

## 2. Missing features (visible in game)

Live
- **Pet needs popups**: ported, not verified. Celebrity page: levels 0 and
  0x11..0x13 not verified.
- **PIP**: exact BoboVision composition (AlphaBlend_565_P5 table, ~0.7 ms per frame). Live zoom
  window with no GPU readback (2026-11-09), judged smooth in Firefox by the user.
- **Undo a wall deletion**: ported (the door is picked up then put back, without Init, like the
  original); to be checked in game.
- **Pizza**: call, arrival, greeting and dialog seen; payment and handing over the box not observed.

Neighborhood / save
- **Web pages**: album with photos not tested; with SAVES=client the pages are served only by
  the service worker (documented in the guide). `ObjectFolder` follows the original's order
  (`data/dirimage.ts`); still by name: floor / wall plugins, skin textures, MatchFolderScanner.
- **Language**: 14 languages offered (including Polish, CJK and Thai); IME and byte capacity
  ported. Not offered: Russian and Hebrew (the install only has copies of the English texts).
  800x600: the port still runs at 1024x768 (the original picks the largest mode);
  SetMiniUI not ported. cDDDSimsView's "Paused" text ported: to be confirmed against the game.
- **Magic Town**: the Windows version's alpha decoders ported (thresholds 8 / 0xf7, depth
  written) and thumbnails without alpha; not compared with the game. Risk: a window's glass writes
  depth and may hide a Sim behind it (contrary to note U44 in playtest.md): to be checked.
  `objecticon.ts`, `buildcatalog.ts` and the web export keep the old rule.
- **Create a Sim**: House00 loaded behind the neighborhood, the original's starting tile, neighbor
  visible to the simulator, deletion flag; House00's simulator only runs during the dialog
  (nothing to simulate otherwise).
- **Unleashed import**: ported and tested (copy of missing files, import only once).
  It imports 6 families into the neighborhoods shipped in version 0x3f (including UserData3) the
  next time they are opened, like the original.

Building
- **Held door and wall cutaway**: the code follows the original (no discrepancy found); to be
  compared with the game. Diagonal wall cutaway fixed (Wall::ComputeCutaway), to be checked on
  House02.

Interface / cheats
- **Cheats**: all ported and tested except those with no equivalent: ReportMissingTextures
  (box never shown by the original; EditPerson::ValidateTextures not ported), damagelist and
  sweep (no damage rectangles or profiler here), draw_routes (no drawing code).

## 2bis. Remaining discrepancies from the 2026-11 audit (decompiled code vs port)

The discrepancies confirmed by the full audit have all been dealt with (git history, 2026-11-08).

- **"Low" findings** from the audit: listed in
  [`docs/decomp/audit-2026-11-low.md`](decomp/audit-2026-11-low.md). All verified (2026-11-08 and
  2026-11-09) and the real discrepancies fixed. Remaining, annotated: intended discrepancies, false
  or uncertain ones; the pet veto without Unleashed (#67, #104); reconciling Neighborhood::Load
  with the Characters folder (#125); the capped clock of the frame loop (#135).

## 3. Sound

- kSndob* events 4..10: verified, no shipped .hot file uses them (nothing to port).

## 4. Animation

- Root motion correction of the walk engine (disabled in the original too).

## 5. Performance

- **Loading a lot**: cold, lot on screen in 9.3 s (13.7 before the parallel reads), ~135
  POST /api/ranges; warm ~5 s. Remaining: reads that are dependent by nature
  (CMX then meshes then textures), buy catalog scan ~25 s after a cold load,
  portraits rendered on the main thread at first load.
- **Memory**: `entryCache` bounded, TryUnloadSkills / TryUnloadSuits / TryUnloadAll ported (the
  switch of outfits frees nothing, like the original: clock shared with skills).
- **Tick spikes**: remaining are route searches and BHAV interpretation (the original's work);
  familyFriendCount cached like the original.
- **Large resolutions**: the game runs at ~768 high then is scaled up, so a large resolution
  costs about as much as 1024x768 (17.8 fps at 5120x1440 vs 19.6 at 1024x768 on the loaded WSL
  host; the lot rendering, ~25 ms per frame here, is the limit). Scrolling no longer redraws
  the whole terrain (uncovered strips and edges only, see perf-and-browsers.md); diagonal
  scrolling is still only ~2x cheaper (edge strips). Remaining leads:
  show the lot's WebGL canvas as a layer under a transparent UI canvas (removes the copy
  WebGL → 2D); measure on a native Windows browser (here the GPU goes through WSLg).
- **Server on /mnt/c**: game inventory kept on disk (`server/data/manifest-cache.json`);
  folders walked in parallel: `/api/saves` ~10 s on the first call after a start
  (~2 min before, 5,000 files), `?refresh` 0.2 s.

## 6. To verify (comparison with the original still to do)

- Camera follow, moving in without a mailbox, pet needs popups and celebrity
  page: consistent with the decompiled code, not seen in game.
- U50 (invisible object): the user's exact case was not reproduced.
- Landing page: seen in Chrome only (not Firefox); translations written by the port
  (game terms taken from UIText when they exist), to be reviewed by native speakers.
- Resolutions other than 1024x768: not seen in the towns, options pages, opened catalog categories,
  transit screen; double-byte languages not seen. "following its size" mode: not seen on the
  towns, in camera mode, or with the overlay open.
- Touch version: tested in Chrome emulation only (no real device, no Firefox Android).

## 7. User action

- **U56, the Charmant family's front door**: the save `UserData/Houses/House69.iff` predates the
  U50 fix. Take the front door and the "Wood 2" door of the hallway / bathroom again by
  hand, put them back in the same place, then save.

## 8. Polish and distribution

Done: landing page, save export / import, offline PWA, user guide
(`docs/user-guide.md`), touch version, `GAME_FILES=client` mode (each player imports their folder).
Target: personal use first (one player per server), public mode as an option.

## 9. Development tools (low priority)

See §2 "Interface / cheats".
