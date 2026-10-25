
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

- Tourist families (DoFirstTimeTouristFamilies, RefillTouristFamilies,
  AddNewTourist: families 3000–3009, Live STR# 160–164, STR# 230,
  kDialogVILogo; random family composition) — read but not ported.
- The family sort after DoFirstTimeTownies (comparator lbl_105BB988).
- Premade townie personality: person data stays at the template/CAS defaults
  (+ RandomizeAllInterests), not read from the template object.
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
  **Not ported**: the house file side (LoadHouse, kill IsDeletedByEvict objects; on bulldoze kill objects /
  walls / floors / pool off 0x20 tiles, delete the house's characters; funds and global 26 = 0, clear
  history, SaveHouse). It needs a headless lot load + save (world/**): the screen calls the optional
  callback `onMoveOutHouse(house, bulldoze)` and otherwise logs `onUnported`. ExportFamily (Export/*.FAM)
  and the HTML export are not ported.
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
- MoveOut house file side, ExportFamily (see above); tourist families (DoFirstTimeTouristFamilies /
  RefillTouristFamilies(10)) are not called; the dev Move mode (5) and the digit / arrow keys are not ported;
  the internet update busy flag (+0x1b4) is never set.
