
## Townies (Hot Date) and cWinProgressPictureDialog

Files: `client/src/game/nbhd/townies.ts`, `client/src/game/nbhd/winprogresspicturedialog.ts`,
NGBH parse/write and family helpers in `client/src/game/data/nbhdstore.ts`,
`createCharacterFileFrom` in `client/src/game/data/character.ts`, dev test
`game.html?test=townies[&refill=N][&dir=UserDataN]`.

### NGBH (Neighborhood::DoStream)

`i32 head, i32 version, "HBGN"`, 16 shorts (1 if version < 0x14), the
SimInventory vector when version > 0x3f (`i32 count` + entries; empty = `i32 0`),
then one-byte bools: +0x19c townies done, +0x19d townies needed (≥ 0x42,
defaults 0/1), +0x19e/+0x19f tourists done/needed (≥ 0x44, 0/1), +0x1a6
(≥ 0x45, 1), +0x1a0..+0x1a3 (≥ 0x46, 0 1 0 1), +0x1a4/+0x1a5 (≥ 0x49, 0/1).
We write version 0x49 when the chunk was touched. `parseNgbh` →
`serializeNgbh` is byte-identical on every shipped Neighborhood.iff
(UserData v0x49 2069 bytes, UserData2/4/5 v0x3f 44 bytes) and on our own
written file.

### DoFirstTimeTownies / RefillTownies / AddNewTownie

- Gate: Hot Date installed (we test for the 0x200 template in TemplateNPCs)
  and NGBH +0x19d. An existing family 2000 is renumbered to max id + 1, then
  RefillTownies(30), flags +0x19c = 1 / +0x19d = 0, save.
- Templates: TemplateNPCs objects with OBJD type 0x400 (premade HDT_*) and the
  first of type 0x200 (HDT_Generic, GUID 0x4fd5dd92).
- New family 2000 named UIText STR# 211 entry 1 ("Delaville"), dialog STR#
  211 entries 2/3 + kSocialPopupIcon, up to 10 premades first; refill of an
  existing family: entries 4/5 ("Renouveau urbain"), total n − members. Then
  until n members: premade with 1/5 chance (each template used once), generic
  otherwise.
- AddNewTownie: template copied into the first free `Characters/User%05d.iff`
  (OBJD type 2, template GUID at +0x8c, as in the shipped UserData townies);
  generic: gender, skin (lgt/med/drk), random body + head, SetupNewHDSkins;
  first name from Live.iff STR# 150/151 avoiding the names already given;
  EndDesignAPerson(save) (the name goes into the current-language CTSS slot).

### cWinProgressPictureDialog

Popup tiles frame (BltEdge), title in font 14 centered over the indented text
column (the text window is widened to title + picture + 0x12), wrapped text
around the 45×45 picture over kPictureDialogStub, width searched for a 2:1
ratio, bar (20, h−35, w−20, h−15) color 0x32 and done part color 0x98 (read as
565: rgb(0,4,144) / rgb(0,16,192) — unverified).

### Not ported / gaps

- The family sort after DoFirstTimeTownies / DoFirstTimeTouristFamilies
  (comparator lbl_105BB988).

### Premade townie personality

The game copies nothing from the template in code: AddNewTownie only runs
BeginDesignAPerson (CreateInstance: the template's Init tree), the name and
EndDesignAPerson (SavePersistentData), on a neighbor whose person data
Neighbor::Neighbor zeroed. The template's values live in its own trees,
copied into the character file with its other resources: "init tree" (BHAV
4097) calls "init traits" (4100: interests 13, 14, 16, 20, 26, 46..55) and
sets job 15 level 3 only when person data 61 is 2000 and there is no job
(not the case at creation: Family::AddMember comes later); "Main" (4096)
calls "Clear Personality" (4099) and writes the five traits. They run when
the townie is instantiated on a lot (our VM, from the copied file).

### Tourist families (Vacation)

`doFirstTimeTouristFamilies` / `refillTouristFamilies` / `addNewTourist` in
`nbhd/townies.ts`, run by `cWinNeighborhoodUL` after the townies (lot click,
move in, Downtown), as in the game (Mac 100a1c20 / 100a1db0 / 100a9830).

- Gate: Vacation (ExpansionPack4 present = app +0x66 & 8); DoFirstTime also
  needs NGBH +0x19f. Families using 3000..3009 move to max id + 1, then
  Refill(10), +0x19e = 1 / +0x19f = 0, save.
- Refill: each missing id of 3000..3009 becomes a family named from Live
  STR# 160 (rand(1000) % count, removed), dialog UIText STR# 230 entries 2/3
  + kDialogVILogo ticked per family. Adults: couple 60 %, man 20 %, woman
  20 %; children 1 or 2 (40 / 60 %); skins lgt/med/drk 33/33/34 %, second
  skin same 70 %; names Live STR# 161 men, 162 women, 163 boys, 164 girls.
- AddNewTourist: HDT_Generic copied to `Characters/User%05d.iff`, age,
  gender, skin, random body / head suit (rand(max(1000, 2n)) % n),
  SetupNewHDSkins, name, EndDesignAPerson(save).
- The generic GenNPCInfo lists are recorded but, as in the game, never cause a
  re-draw.
- A failing AddNewTownie stops after n failures (the game would loop).

## Credits and family picker additions (cWinCredits, cPickFamilyPersonInfo, scroll ramp, first-run hint)

Files: `client/src/game/nbhd/wincredits.ts`, `client/src/game/cas/personinfo.ts`
(new), `cas/winpickfamily.ts`, `cas/windesignfamily.ts`; small additive hooks in
`ui/winmgr.ts` (`ToolTipsWindowSource`: a window may supply its own tooltip
window, the override of cTSWin::GetToolTipsWindow) and
`cpanel/live/personality.ts` (`setPersonData` for a neighbor, `fixedCol` for
SetCol). Test pages: `game.html?test=cas&screen=credits`,
`game.html?test=cas&screen=pick&dir=UserData`.

### cWinCredits (Credits.cpp)

- A cTSWinGenDlg framed by BltEdge of `kCatalogPopupBackTiles` (cells a third of
  the bitmap, center filled; vfunc 0xc8 of cTSBuffer is BltEdge, not a stretch).
  The background color is sampled once at (tiles.w, tiles.h), which is the center
  color, so the band fills cannot be seen.
- OK button (UIText STR# 152 entry 0, id 0), centered, 20 px above the bottom.
- Credit lists from `GameData/Credits.iff`. STR# 171, 170, 169, 167, 166 and 165
  are added when the matching pack bit is set (0x80 … 2). Then STR# 168 if
  Deluxe (0x10) is set, otherwise STR# 164 if Livin' Large (1) is set. STR# 163
  always comes last. Each line of an entry is one credit, and an entry ending in
  CR LF adds an empty credit. The first credit starts 1 s after Init, and the
  rest follow 750 ms apart.
- Credit states:
  - Waiting;
  - FadingIn (400 ms, background → text color);
  - Rising: scroll = −trunc(0.035 · ms + 0.5). The color is a triangle
    TEXT → WHITE → TEXT between the bottom band (h − 200) and the top band (100).
    The clock advances at most 50 ms per frame;
  - FadingOut;
  - Gone.
- Scrolling copies the rows between the bands. After a pause of 200 ms or more,
  everything is redrawn. When no credit is left, the dialog closes itself.
- A click, Escape or Enter closes it (`tsEndDialog(0)`).
- Init and Shutdown never touch the music. The caller plays `bkground_credits`
  and then restores the neighborhood music.
- Not ported: the AnimDevice frame rate (+0x70) and the page-flip repair fill.

### cPickFamilyPersonInfo (PickFamilyPersonInfo.cpp)

- One shared instance per picker (`lbl_105BAB50`). cPickFamilyItemMember::GetToolTipsWindow
  calls SetPerson(guid) on it and returns it. cWinDesignFamily creates its own
  instance (+0x170), and cWinDesignFamPeopleBtn::GetToolTipsWindow does the same
  with the button's person.
- Init:
  - fonts size 12 (name) and size 10 (text); background 0x14b4
    `kPickFamilyPersonInfoBkg`; area (0, 0, 0x71, 0x7a);
  - 5 cWinPersonality built as in BuildPersonalityButtons (Live STR# 131/170,
    traits 7, 6, 3, 5, 2, widest text rect). Each one is disabled, with
    SetCol(2) (caption in hilite color 2), laid out from (3, 0x16) every 0x13 px
    (`__sinit_PickFamilyPersonInfo_cpp`).
- Layout:
  - the text column is 200 px wide, or nameW − traitW − 15 when the name is
    wider than traitW + 0xd7;
  - name rect at (15, 10); the traits 10 px below it, one per pitch;
  - the biography sits right of the traits for ceil(traitsH / h10) lines. The
    rest runs under the traits across the full width, or under the column only
    when it is a single short line;
  - size = (column right − 15) + 30 by nameH + max(textH, traitsH) + restH + 30.
- TSPaint:
  - BltEdge background;
  - the name centered, with a black shadow at (+1, +1);
  - the biography left-aligned.
- UnfurlToolTip:
  - bottom-left at (rect.left, rect.bottom);
  - alpha 255 · t + 0.5, clamped (lbl_105BC6E4 = {0.5, 255});
  - drawn through a private buffer (BlitPrivateBufferToParent: 0 = nothing,
    255 = blit, otherwise blend).
- As in the game, portraits only take the mouse once their family is selected,
  so the tooltip only appears on the selected row.
- Unresolved: the name format `lbl_105BAB74` is built by a static initializer
  from a code address. The name is shown as is (STR# 128 entry 12 "Personnalité
  de %s" is not referenced by any code we read).

### cPickFamilyList scroll ramp

- ScrollTo(row) runs a RampGenerator from the current value to the new row:
  - the current value is the ramp's value, or the top row when it is not
    running;
  - speed = 0.001 · clamp(5.0909 · |Δrows| − 1.0909, 4, 60) rows per ms
    (lbl_105BC6D0).
  One row therefore takes 250 ms, and 6 rows about 204 ms.
- TSPaint: top row = trunc(val + 0.5); offset = trunc((val − row) · itemH + 0.5),
  carried to the next row when it reaches itemH. TileItems shifts the items by
  −offset (+0x100). The empty rows are shifted by the same amount.
- The list clips its children while scrolling.
- AddItem and DeleteSelection still set the top row immediately (SetTopRow).
- Not ported: cPickFamilyList::GetTTPosition (where the list's own tooltip goes).

### First-run hint (cWinPickFamily::Init / TSOnTimerMsg)

- Once per session (`lbl_105C14AA`), if cOptionsMgr::GetRunCount() < 2:
  - Init subscribes a 500 ms timer;
  - TSOnTimerMsg unsubscribes it and shows MessageDialog(text = entry 14,
    title = entry 13) ("Créer une famille ?"). StringSetBase::GetString is
    1-based, so 0xe and 0xf are these entries.
- The Makin' Magic variant (GetRunPAFMagicCount < 6, entries 18/19) is not
  ported, because there is no coins column.
- The game's run count is not kept yet. `getRunCount()` reads
  `localStorage["thesimsweb.runCount"]`, which nothing increments, so the hint
  shows once per session.

## Neighborhood screen modes (cWinNeighborhoodUL: SetMode, Evict, Rezone, buttons, switching)

Files: `client/src/game/nbhd/winneighborhoodul.ts`, `nbhd/winlotbtn.ts`, `nbhd/nghinterface.ts`,
`data/nbhdstore.ts`, `ui/cursor.ts`, `ui/radiodialog.ts`, `ui/tswin.ts` (`winCursor`), `ui/winmgr.ts`
(cursor), `main.ts` (callbacks).

### SetMode / handlers
- Mode +0xcc; lot handler (+0x198) and button handler (+0x1a4) member pointers are a switch
  (`lotHandler` / `btnHandler`): regular = RegularModeLot/Btn, move in = MoveInModeLot + RegularModeBtn,
  evict and rezone = their own pair, visit = VisitModeLot (town screens only, not used here).
- Leaving rezone / evict: their button up, lots `setMode(0)`, `UI_Nhood_bdoze_cancel`. Leaving move in:
  its button up.
- Entering regular: all buttons enabled (town buttons: the cSimsApp +0x66 pack bits, all set in the
  Complete Collection), Import from CheckForNewImports (`<dir>/Import/*.FAM|*.rdt|*.cmt` in the
  manifest), standard cursor 4 (arrow). Move in: cursor 0x21. Evict: all but Bulldoze / Import disabled,
  cursor 0x22, lots mode 1, `UI_Nhood_bdoze`. Rezone: all but Rezone / Import disabled, cursor 0x28,
  lots mode 1. Visit: cursor 0x29, lots mode 2. Then the cursor on the screen and every lot, and
  HighlightLotsForMode (import hilite off; in rezone: community (0,0,0xff), empty residential
  (0,200,0), occupied residential (0xf2,0,0)).
- cWinLotBtn::SetMode / Hilite*: mode 0 = rollover + click sounds, actions 5; modes 1 / 2 = actions 1.
  Hilite = 1 px outline around the opaque pixels + BrightenColor (YIQ, Y + 0.09), restored on "off".
- Cursors: `ui/cursor.ts` maps the cSimsApp::SetupWinCtrlMgr ids to `UIGraphics/Shared/cursors/*.cur`
  (CSS `cursor: url(...)`), `TSWin.winCursor` per window, `winMgr.setGlobalCursor` for the wait cursor
  (id 3, hourglass) around EvictFamily and Previous / Next.
- ShouldAllowRoofDissolve per mode (move in: affordable, empty, unoccupied; evict / rezone: a family or a
  house and not the tutorial lot; visit: community; else a family).
- TSOnKeyDown: Escape in move in -> regular + the family picker again; in evict / rezone -> regular.

### Evict (Bulldoze button)
- EvictModeLotHandler: family on vacation there (+0x13c) -> STR# 131 [16]/[17]. No family: no house ->
  cancel sound + [5]/[4] + bdoze sound; house -> yes/no [1]/[0], `UI_Nhood_bdoze_demolish`,
  EvictFamily(house, bulldoze=1). Family: yes/no sprintf([3], name, net worth) / [2], then when there is a
  house the bulldoze question [1]/[0]; `UI_Nhood_bdoze_evict` or `_demolish`; EvictFamily; failure -> [11]/[10].
  Then ReloadThumbnail.
- EvictFamily = Neighborhood::MoveOut + ExportFamily. Ported: the family side
  (`NeighborhoodStore.moveOutFamily`: house 0, flags &= ~8, budget += lot value, value 0; saved), the
  bulldoze side of NeighborhoodDesc.iff (STR# 2000 + house entries 1 / 2 emptied).
  The house file side (`onMoveOutHouse(house, bulldoze, store)`, `world/moveout.ts`) and ExportFamily
  (`NeighborhoodStore.exportFamily`) are described in "Lot transitions, MoveOut house side, ExportFamily"
  below. The HTML export is not ported.
- EvictModeBtnHandler: Move In -> regular + picker; Bulldoze -> regular; Exit / Inet / Credits / Import /
  logo as regular; the rest nothing.

### Rezone
- RezoneModeLotHandler: `WinRadioDialogBox.show` (cSimsApp::RadioDialog; STR# 250 [0] title, [1] text
  with the STR# 251 zone name; choices STR# 251). Same zone / cancel -> nothing; vacation check; empty lot
  -> SetZoningType; house without family -> bulldoze question [9]/[8] then EvictFamily(1); family ->
  [7]/[6], bulldoze question when there is a house, evict, SetZoningType. Then ReloadThumbnail +
  HighlightLotsForMode.
- `Neighborhood.setZoningType`: LotZoning.iff STR# 1 (English entries only, as LoadOnlyEnglish) entry
  "N, residential|community" rewritten, saved through the overlay.
- cWinRadioDialogBox: buttons post their id (2 OK, 1 Cancel, 10 + i radios); OK returns the selected index.
- RezoneModeBtnHandler: Move In -> regular + picker; Rezone -> regular; Exit / Inet / Credits / Import /
  logo as regular.

### Regular buttons
- Exit: cSimsApp::Quit dialog (STR# 153 [1] title, [2] text, OK / Cancel); OK -> `bkground_fade`, end
  code -1 (`NBHD_EXIT`). The browser cannot quit: main.ts logs the note.
- Credits / logo: `WinCredits` modal over the screen (one at a time), `bkground_credits` then
  `bkground_nhood1`.
- Inet (DoInternetUpdate) and Import (CycleThroughImports): `onUnported` with a precise note.
- Previous / Next: wait cursor, all buttons disabled, Neighborhood::Previous / Next over the UserData*
  directories (wrapping), rebuild. The registry SIMS_CURRENT_NEIGHBORHOOD_NUM / _PATH is
  `localStorage["thesimsweb.currentNeighborhood"]` (`currentNeighborhoodDir` /
  `storeCurrentNeighborhoodDir` in nghinterface.ts); `?nbhd=` still overrides.
- Downtown: DoFirstTimeTownies + RefillTownies(30) (tourists not ported), fade, -20. Vacation -30,
  Studio Town -40, Magic Town -50 (fade). main.ts logs `NBHD_END_NOTES[code]` (cWinDowntown,
  cWinVacation, cWinStudiotown, cWinMagicland are not ported); the screen stays up.
- RegularModeLotHandler: fade, townies refill, LoadGame(house) or the family's vacation lot (+0x13c).
- The run count (cOptionsMgr) is `localStorage["thesimsweb.runCount"]`, incremented at boot.

### Gaps
- Tourist families (DoFirstTimeTouristFamilies /
  RefillTouristFamilies(10)) are not called; the dev Move mode (5) and the digit / arrow keys are not ported;
  the internet update busy flag (+0x1b4) is never set.

## Lot transitions, MoveOut house side, ExportFamily, the game at "/"

Files: `client/src/game/screens/frozen.ts` (new), `world/moveout.ts` (new), `main.ts` (callbacks),
`data/nbhdstore.ts` (`exportFamily`, `charactersOfHouse`, `deleteCharacter` now returns a boolean),
`data/iff.ts` (`stringSetMultiSaveLocal`, `stringSetBaseResave`), `world/housesave.ts` (`clearHistory`),
`world/winlotview.ts` (`readLotSize` exported), `nbhd/winneighborhoodul.ts` (the store goes to
`onMoveOutHouse`; ExportFamily after MoveOut), `client/vite.config.ts`, `client/legacy.html`.

### Entering and leaving a lot (cSimsApp::LoadGame, ShowNbhdDialog)
- The original has **no loading screen and no progress dialog** for a lot. Checked: LoadGame,
  Neighborhood::LoadHouse / UnloadHouse, ShowNbhdDialog, DoNbhdScreen; the splash stages "hous" / "lobj" /
  "hvwr" belong to InitGame (startup only); cWinProgressPictureDialog is only used by the townie / tourist /
  Makin' Magic refills (`nbhd/townies.ts`, which runs before LoadGame on the first lot click);
  cWinPictureSplashDialog is CreateTaxiDialog, used by ObjectModule's transit primitives (not ported).
- Entering (RegularModeLotHandler / MoveInModeLotHandler): `bkground_fade` (already played by the screen),
  NPC refills, then LoadGame: cDDDSimsView::StartWatchCursor (global standard cursor 3, the hourglass),
  LoadHouse synchronously with the neighborhood screen still on screen, PlaySoundA of the lot's ambience
  (`setambience_beach` for houses 0x1c-0x1d / 0x2e-0x30, `_park` for 0x15-0x1e / 0x2b-0x2d, `_magictown`
  for 0x5a-0x5c, else `_backyard`), then the screen ends, the view is shown, and the hourglass is removed at
  the end of the view's next draw (cDDDSimsView +0x11a8 / +0x11a4).
- Leaving (Options > Neighborhood): CPState::LeavingHouse, UnloadHouse, the screen built, the view hidden,
  DoModalWin: the last lot frame stays until the neighborhood draws, no cursor change. The mode music
  goes on until the screen's Init plays `bkground_nhood1`.
- Port: `whileFrozen(mgr, watchCursor, work)` copies the current canvas into a front-most modal window that
  paints it and swallows input while the asynchronous load runs (the original is frozen), so the windows
  behind can be swapped; the hourglass is cleared two animation frames after the lot view is added. Used by
  onEnterLot, onMoveIn (hourglass), showNeighborhood and onSwitchNeighborhood (no hourglass).
- Gaps: the ambience events resolve (HotDate.hot / sep7snds.hot, kSetAmbienceMode = 52) but cBoxX::Event
  has no case 52 and cBoxX::UpdateAmbienceLoop is not ported, so nothing is heard. The NPC refill before
  LoadGame is not frozen (the original's handler is synchronous as a whole). LoadGame's vacation /
  downtown / visitor branches are not ported (main.ts enterLot).

### Neighborhood::MoveOut, house file side (`world/moveout.ts`, `moveOutHouse(ctx, store, house, bulldoze)`)
- Headless LoadHouse: ResFile, FixedWorld (lot size from SIMI), FloorGraphicsMgr / WallGraphicsMgr with
  the usage maps, `loadLotModule`, `Simulator.create` (ObjectModule::PostLoad: Load / Init trees), a
  Placement whose onKill drops the sim object, and minimal WorldHooks. No view, no WebGL.
- LoadHouse's person pass: family-less people whose person data 0x43 is another house, and people of a
  resident family (not 0 / 2000 / 3000-3009 / 4000 / 5000 / 5500 / 6000) without a house (the evicted
  family: moveOutFamily has run on the store) are killed.
- BroadcastMessage("evict lot", 0): the BHAV named so (Behavior::GetTreeID by name; Bills.iff has it) runs
  once per object (RunOneTickTree, param 0), then the kill queue.
- Kill pass in module order, objects not held by another (PlacementSpec container null): IsDeletedByEvict
  (world/housestats.ts); bulldoze adds out-of-world objects with OBJD +0x54 == 0 and objects without
  movement flag 0x10 on a tile without flag 0x20 (an out-of-lot tile reads 0, the original reads past the
  array).
- Bulldoze: levels 1 and 2, inner tiles without flag 0x20: floor 0 and `fixedSetWall` with an empty
  TileWalls; cPoolLayer::Clear (every lot tile 0xff).
- Funds 0 (SetFunds), global 26 = 0, ClearHistory (global 28 and the six SIMI history blocks: new
  `clearHistory` option of buildHouseFile), GlobalDispatch(0x91) = cFixedWorld::ComputeRooms.
- Bulldoze: DeleteCharacter for each neighbor whose Neighbor +0xfa (person data 0x43) is the house, in NBRS
  order, until one is refused; the person objects with that GUID are killed first.
- GViewer::SetLevel(1) (HOUS 0 level patched, the HOUS 0 chunk being carried without a viewer), SaveHouse:
  stats (summarizeHouseStats) and buildHouseFile with the live simulator, written to the overlay.
- A load or save failure resolves false: evictFamily then returns before saving the store (the family keeps
  its house, as MoveOut puts +0x110 back) and the screen shows STR# 131 [11]/[10].
- Not ported: House::ClearRouteHistory, the family 0 budget reset in SaveHouse, SaveHouse's DeleteCharacter
  loop over family-less house-less characters, the GUID 0xc3249a1d object LoadHouse may create, the
  "import lot" broadcast. The thumbnails are rendered from a view opened on the saved file (world/thumbnail.ts
  withHouseThumbnails, see save-port.md "Thumbnails"): an evicted or bulldozed lot shows its new state.
- Checked (UserData, overlay, then deleted): evicting house 7 kept 106 of 182 objects (all build-mode objects
  plus those with movement flag 0x10: mailbox, trash can), no person, funds 0, globals 26 / 28 = 0; the lot
  reloads in buy mode. Bulldozing house 5 removed walls, floors and every object but trees, tombstones,
  mailbox and trash can (movement flag 0x10 or a locked tile). A MoveOut takes about 0.9 s (warm cache).

### ExportFamily (`NeighborhoodStore.exportFamily(id)`)
- EvictFamily calls Neighborhood::ExportFamily(ConstructUserDataPath("Export"), family) after MoveOut when
  the family exists (result ignored); ExportFamilyHTML (option) is not ported.
- File `<dir>/Export/<name>_<id>.FAM` (Family::GetExportName; `.MTF` for a Magic Town house 0x5a-0x5c);
  with a house, the house file is the base (CopyFileA) and the chunks are added. Chunks in order: FAMI (v9),
  FAMs, FAMh (copied), CTSS 1000 (name, language slot 0), EXPi 0 (ExpFamilyInfo v0x3f: id, 8 member
  neighbor ids, language byte 3), then per neighbor of the family (Neighbor +0xee) in NBRS order: uChr id
  (STR# 200 re-saved by StringSetBase: entries re-tagged with the current language), CTSS id
  (CatalogResource::Save: name and description in the current language), CTSS 2000 + id (SaveLocal: all 20
  language slots, missing ones copied from US English), BMP_ id (BMP_ 2004); NBRS 1; FINV 2 (version 0x49:
  the members' SimInventory records from the NGBH vector, `i32 0` for none); rsmp. `.FAM` and `.MTF` are
  deleted first (overlay copies only).
- Checked against the game's own `UserData/Export/Fez_7.FAM` after evicting house 1 (Fez, id 7): FAMs,
  FAMh, CTSS 1000, EXPi, every uChr / CTSS / BMP_, NBRS and FINV are byte-identical except the slack bytes
  the game leaves uninitialized after string sets; FAMI differs only by the state (house 0, budget = net
  worth after the eviction); the game's file was exported with its house, ours has none (eviction).

### Import character set test (cWinNeighborhoodUL / cWinMagicland CycleThroughImports)
- After GetImportInfoForFile: cTSFrameWork::GetLanguageManager()->(+0x60)(0) gives the cTSLanguageUtility,
  whose GetCharacterSetFromLanguage (+0x80) is called with the game's language (cSimsApp +100) and with
  ImportInfo +0x188 (ExpFamilyInfo byte 0: the language streamed after the 9 shorts from version 0x3f on, else
  the game's language). GetCharacterSetFromLanguage: DoesLanguageUseWesternCharacterSet (languages 1..11, 14)
  1252, DoesLanguageUseEasternCharacterSet (13, 16) 1250, else the jump table lbl_105BCEB8 (mac.bin 0x1062a308)
  for 12..20: 12 1255, 15 932, 17 950, 18 936, 19 874, 20 949; otherwise 1252.
- When they differ and the file is not the tutorial lot (ImportInfo +0x110: GetHouseInfo found a SIMI, and
  HouseInfo +0x14: its global 26, Neighborhood::GetHouseFileInfo reads cSimulator +0x44): a cWinPictureDialog
  with STR# 154 entries 20 and 21 (1-based), OK (cTSWinMsgBox::GetButtonLabel(1), id 1) and Delete (STR# 144
  entry 5, id 2); Delete asks STR# 154 entries 18 / 19 (Yes / No) and deletes the file on Yes. Then the next file.
  cWinMagicland::CycleResidentialImports (the .MTF families) does the same; the Downtown / Vacation / Studio
  Town lot imports have no such test.
- Port: `getCharacterSetFromLanguage`, `isWrongCharacterSet`, ImportInfo `language` / `tutorial`
  (nbhd/imports.ts); the box in `WinNeighborhoodUL.wrongCharacterSetDialog` and `WinTown.residentialImport`.
  The tutorial lot's direct import (no dialog) stays with nbhd/tutorial.ts.

### Family web pages (ExportFamilyHTML, DoInternetUpdate): not ported
- Callers: cSimsApp::SaveGame (after ExportFamily, option on), EvictFamily (after ExportFamily, option on),
  cWinNeighborhoodUL::DoInternetUpdate (Inet button and TSOnTimerMsg while the busy flag +0x1b4 is set).
- DoInternetUpdate: first call (+0x1b4 clear) GetFamiliesNeedingHTMLExport (families without Family +0x138
  bit 3; on the first two runs with Neighborhood +0x66 bit 5, every housed family of 1..9 once), a STR# (lbl_105BCD48)
  1 / 2 confirmation when any, then +0x1b4 = 1, SetBlockSimulator, a 100 ms timer, every lot button flag 0x400
  and 2 off. Each timer tick: a cWinPictureDialog (STR# 1 / 3 with the family name, kNghInetUpdateIcon 0x14e6)
  for the next family, then ExportFamilyHTML(family) and the dialog closed; at the end +0x1b4 = 0,
  ExportNghHTML (ExportHTMLNeighborhood), ShellExecute of <UserData>/Web Pages/<index page>, the buttons back.
- ExportFamilyHTML (Mac 102288e0): LoadHouse of the family's house when it is not loaded, ExportHTML (or
  ExportHTMLHomelessFamilies without a house), Family +0x138 bits 3-4 set and the family re-saved.
  ExportHTML (Mac 10218070, ~500 lines of pseudo-C) builds two 0x1ab-entry tables (GenerateLookupTagsList,
  GenerateHouseData, GenerateFamilyAndScrapbookData), copies <Web Templates>/<language>/StockGFX, runs
  MakeWebPagesFromTemplate (~700 lines) / MakeWebPageX on every .html / .css template, renders
  GenerateFamilyMemberJPEGs (PersonFinder::GenerateJPEGs: a face and a full-body 3D render per member, JPEG) and
  four HouseViewer::MakeWebPageThumbnail renders (exterior with roof, thumb, floor 1, floor 2 when visited, JPEG),
  then MakePublishingInfo (the .pub / faminfo files, htmlEncrypt). In all about 4,600 lines of pseudo-C
  (exporthtml.cpp, Mac 10216510..10220d10) plus the two render paths and a JPEG writer: left for a dedicated task.

### The game at "/" (task: game.html as the main entry)
- `client/vite.config.ts`: a `game-as-root` plugin rewrites `/` and `/index.html` (query kept) to
  `/game.html` in the dev and preview servers; the build has two inputs (game, legacy). `game.html?...`
  URLs keep working. The old prototype page moved to `client/legacy.html` (`src/main.ts`, unchanged).
- The Fastify server does not serve the client (only /api and /assets): nothing to change there.

