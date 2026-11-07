# UI window coverage (2026-10-29)

Every `cWin*` / `cTSWin*` class of the Mac build (`~/simsweb-build/decomp/mac/symbols.tsv`, 86
names), plus the other window-like UI classes, checked against `client/src/game/`. The Windows
build (`Sims.exe`, Complete Collection) has no extra window class: its RTTI names
(`.?AVcWin...@@`) are exactly the Mac ones (only the `cITS*` interfaces and the STL / blitter
classes differ), so the expansion windows (Downtown, Vacation, Studio Town, Magic Town, magic
book, pets...) are all in the table below.

Result of the 2026-10-29 audit: 13 classes were missing a port and are now ported or partial
(budget, help, report card, pet skills, biography, delta meters, sell page, town lot
description, tutorial arrow, cheat console and help, the Ask-for-Lot picker's filter toolbar).
What is still missing is either debug-only or listed in the "partial" notes. The open items are tracked in [`../TODO.md`](../TODO.md).

Status: **ported** (the class and the behaviour a player sees), **partial** (the class exists,
named parts missing), **missing**, **n/a** (OS / debug / IME plumbing replaced by the browser,
or developer-only tools).

## Framework and widgets

| Class | What it is | Status | Where |
|---|---|---|---|
| cTSWin | Window base: area, flags, children, plot, hit testing | ported | `ui/tswin.ts` |
| cTSWinMgrW95 | Window manager: input routing, capture, modal loop, paint | ported (focus / modal key routing, WF_NO_FOCUS, TSSetFocus kill / set messages, double clicks as messages 9 / 10: CS_DBLCLKS, the browser's click count). Web addition: the touch mapping (tap, double tap, long press = right button where the window has a handler, two-finger Alt pan, pinch '+' / '-', twist ',' / '.') and a hidden input for the on-screen keyboard | `ui/winmgr.ts` |
| cTSWinCtrlMgr | System bitmaps and fonts of the controls | ported | `ui/ctrlmgr.ts`, `ui/syscolors.ts` |
| cTSWinBtn | Button (frame columns, push / toggle, async timers) | ported | `ui/btn.ts` |
| cTSWinCheck | Check box | ported | `ui/check.ts` |
| cTSWinText | Static text | ported | `ui/text.ts` |
| cTSWinTextEdit2 | Edit field | ported (selection, clipboard, undo, scrollbar, double-click word selection, double-byte characters: whole characters from the browser, IsUnsupportedDBLeadByte "-"; no IME composition) | `ui/textedit.ts` |
| cTSWinTextList | Text list | ported | `ui/textlist.ts` |
| cTSWinScrollbar | Scroll bar | ported | `ui/scrollbar.ts` |
| cTSWinSlider | Slider | ported | `ui/slider.ts` |
| cTSWinDlg | Dialog base (modal) | ported | `ui/dlg.ts` |
| cTSWinGenDlg | Generic dialog frame (Sims skin) | ported | `ui/gendlg.ts` |
| cTSWinMsgBox | Message box (OK, OK / Cancel, Yes / No): the error and question boxes | ported | `ui/msgbox.ts` |
| cTSSystemButton | Default push button of the dialogs | ported | `ui/systembutton.ts` |
| cDefaultTTWindow | Tooltip window | ported | `ui/ttwindow.ts` |
| cWinTriRadio / cWinTriText | Three-state radio and its captions (options) | ported | `ui/triradio.ts`, `cpanel/options.ts` |
| cWinTextWrap | Wrapped text pane of the picture dialogs | ported | `ui/textwrap.ts` |
| cTSPieMenu, PieMenuItem, PopupHead | Pie menu with the sim's head | ported | `ui/piemenu.ts`, `sims/popuphead.ts` |
| cTSWinSplashScreen | Boot splash | ported | `screens/splash.ts` |
| cTSFrameWin, cTSMainWindow, cTSMainWindowW95, CWin32MainThread, CWin32Thread | OS frame window and threads | n/a (the page and its canvas) | `main.ts` |
| cTSWinIMECandidate, cTSWinIMEComposition | Asian IME candidate / composition windows | n/a (browser IME) | - |

## Control panel (Live / Buy / Build / Options / Camera)

| Class | What it is | Status | Where |
|---|---|---|---|
| cWinCPanel | Control panel container, panel switching | ported | `cpanel/cpanel.ts` |
| cWinViewControl | Clock, speed, zoom, rotation, levels, funds, help button, friend count dialog (STR# 162), SetMode with BoboVision (panel fade) | ported (BlitPrivateBufferToParent: the gadget is drawn into its private buffer, UniversalBack.tga as GIMEXFactory decodes it: premultiplied colors divided back by the alpha, the transparent color where the alpha is 0. BoboVision: Compose through the TGA's alpha with AlphaBlend_565_565_P5, exact: alpha < 8 keeps the lot view, > 0xf7 copies, else each 5-bit channel (the 565 green's top 5 bits) is InitAlphaZSpriteBlit's table entry [alpha >> 3][src][dst] (built as the original does, single-precision fmadds / fctiwz, per level on first use), expanded with zero low bits; the parent's pixels under the gadget only (220 x 183) are read back through a CPU-side canvas, blended and put back (`compose565`; ~0.7 ms more per frame than the canvas blend, Chrome SwiftShader). Without BoboVision: the color-keyed Blt, hard edges, children drawn over alpha-0 pixels shown. The mode patch is drawn after, unmasked). The panel's fade-in end (message 0x1b) sets the viewport height in WinLotView.doAsyncShowHideMessage (cDDDSimsView::DoMessage) | `cpanel/viewcontrol.ts` |
| cWinBudgetDlg, cWinBudgetRow | Budget window (funds click on a residential lot): 3-day / today income and expenses by type, funds, net worth, days | ported (object / architecture values recomputed at opening) | `cpanel/budgetdlg.ts` |
| cWinHelp | Help window (view control "?" button): topic list and text | ported | `cpanel/help.ts` |
| cWinPeople | Live panel: portraits (person popup, TrackPerson / StopTracking, UpdateAtWorkStatus), mood, page buttons | ported (its two pie menus are the lot's) | `cpanel/people.ts`, `world/tracking.ts` |
| cWinMotive | Needs page, with its delta meters | ported | `cpanel/live/motive.ts` |
| cWinDeltaMeter, cAverageHistory | Up / down change arrows of the needs | ported (needs; the relationship page's meter is wired but, as in the original, its history is null so it never draws arrows) | `cpanel/live/deltameter.ts` |
| cWinPersonality | Personality page | ported | `cpanel/live/personality.ts` |
| cWinSubpanelJob, cFlashyBtn, cPerformanceBtn | Job page (adult) | ported | `cpanel/live/job.ts` |
| cWinSubpanelReportCard | Job page of a child: blinking grade ("Bulletin"), school popup | ported | `cpanel/live/reportcard.ts` |
| cWinSubpanelCatSkills, cWinSubpanelDogSkills | Job page of a cat / dog (pet skills and popups) | ported | `cpanel/live/petskills.ts` |
| cWinSubpanelFame | Job page of a celebrity (Superstar) | ported (popup panes: the lbl_105BCCBC skill objects, the lbl_105BCCB8 level objects or kFameRunway / kFameMusicVideo / kFameMovieSet) | `cpanel/live/fame.ts` |
| cWinSubpanelHouse | House page | ported | `cpanel/live/house.ts` |
| cWinRelationship | Relationships page | ported | `cpanel/live/relationship.ts` |
| cWinInterest (+ BufferCleanup) | Interests page | ported | `cpanel/live/interest.ts` |
| cWinGift | Gifts / inventory page | ported | `cpanel/live/gifts.ts` |
| cWinEditBio | Biography editor (Ctrl+click on a portrait), saved into the character's CTSS | ported | `cpanel/live/editbio.ts` |
| cWinLivePopup, cWinLivePopupClient | Description popup of the pages and options | ported (object panes: SetObject / SetSpecialScale -> DrawObjectIcon -> cXObject::DrawIconic, the object's own sprites at graphic 0; the needs' lbl_105BC498 / lbl_105BC48C GUIDs, `cpanel/live/motive.ts`, `cpanel/people.ts`) | `cpanel/livepopup.ts`, `cpanel/buy/objecticon.ts` |
| cWinCatalog, ProductButton | Buy mode catalog | ported | `cpanel/catalog.ts`, `cpanel/buy/` |
| cWinCatalogPopup | Catalog product popup | ported | `cpanel/buy/catalogpopup.ts` |
| cWinDisposePopup | Sell page of the control panel while a lot object is held in Buy / Build mode (picture, "click here to sell X for $", refund) | ported (its slide-in ramp is never started in either build) | `cpanel/disposepopup.ts` |
| cWinArch | Build mode panel | ported | `cpanel/arch.ts` |
| cWinRoofPanel | Roof sub-panel | ported | `cpanel/arch/roofpanel.ts` |
| cWinOptions | Options panel: save, neighborhood, quit, graphics / sound / play sub-panels (shadows, lighting, terrain and character detail, effects / music / voice volumes, scroll speed, screen size via play options) | partial (town lot save variants) | `cpanel/options.ts` |
| cWinCamPanel, cCustButton | Camera mode panel | ported | `cpanel/campanel.ts` |
| cWinScrapbook | Family photo album | ported | `cpanel/camscrapbook.ts` |
| cDDDSimsView | Lot view mode keys and snapshot | ported (keys, camera) | `cpanel/modekeys.ts`, `cpanel/camsnapshot.ts` |

## Lot and object dialogs

| Class | What it is | Status | Where |
|---|---|---|---|
| cTSObjectDialog, ObjectDialog | Object dialogs (prim 36): job offers, death / Grim Reaper, social worker, repo man, rumors, help system... | ported | `sim/objectdialog.ts`, `world/objectdialogshow.ts` |
| cWinPictureDialog | Picture dialog (text, picture, buttons, edit box) | ported | `ui/picturedialog.ts` |
| cWinRadioDialogBox | Radio choice dialog | ported | `ui/radiodialog.ts` |
| CWinPhoneBook | Phone book | ported | `ui/phonebook.ts` |
| cWinClothingChoiceDlg, cWinPetSelectDlg, cWinTransformMeDlg | Outfit, pet purchase, transform windows | ported | `ui/outfitdlg.ts` |
| CWinMagicBook, cPickSpellList, cPickSpellItem | Spell book / cookbook | ported | `ui/magicbook.ts` |
| cWinPictureInPicture | Event picture-in-picture, auto snapshot into the family album, BoboVision fade (cTSWin::AsyncShowHideWin, `ui/tswin.ts`) | ported | `world/winpictureinpicture.ts` |
| cTutorialIcon | Tutorial guide icon (top right of the lot view), its flight to / from the tutorial object's dialogs, minimize box, "show situation info" on click | ported | `ui/tutorialicon.ts`, `world/objectdialogshow.ts` |
| cTSWinTutorialHighlight | Tutorial arrow over a button or lot (neighborhood tutorial lots, prim 34 effect 0); Tut_CheckForEvents | ported | `ui/tutorialhighlight.ts` |
| cActionIcon | Queued action icons (frame, product / people picture, cancel cross, slides, StartUserAction) | ported | `world/actionicons.ts` |
| cColorSwatch, cGouraudSwatch, cMapTileSwatch | Terrain tool swatches | ported | `world/terrain*.ts` |

## Neighborhood, towns, Create-a-Sim

| Class | What it is | Status | Where |
|---|---|---|---|
| cWinNeighborhood, cWinNeighborhoodUL | Neighborhood screen (Unleashed layout) and the "Ask for Lot" destination picker (lot type filter toolbar, title, filter icons, residential lot message) | partial (import charset check, ReportMissingTextures, web pages export, move_lots and nessie cheats) | `nbhd/winneighborhoodul.ts` |
| cWinNeighborhoodVC | Pre-Unleashed neighborhood layout | n/a (only used without Unleashed) | - |
| cWinLotBtn | Lot button | ported | `nbhd/winlotbtn.ts` |
| cWinLotPopup (+ CleanupVacationBuffers) | Lot info popup (family / house) | ported | `nbhd/winlotpopup.ts` |
| cWinDowntown, cWinVacation, cWinStudiotown, cWinMagicland | Town screens of the expansions | ported (lot imports and Magic Town move in since 2026-10-30) | `nbhd/wintown.ts` |
| cWinEditDTLotDesc | Town lot name / description editor (save prompt of an empty town lot) | ported (Quit's "No clears dirty" step) | `nbhd/wineditdtlotdesc.ts`, `cpanel/options.ts` |
| cWinPickFamily, cPickFamilyList, cPickFamilyItem, cPickFamilyItemMember, cPickFamilyPersonInfo | Family bin (with the Shift smiley easter egg) | ported (Magic Town mode with the MagiCoins column and hints; the Magicland Move In flow that opens it is not) | `cas/winpickfamily.ts`, `cas/personinfo.ts` |
| cWinDesignFamily, cWinDesignFamPeopleBtn | Create-a-Family | ported | `cas/windesignfamily.ts` |
| cWinDesignCharacter | Create-a-Sim | ported | `cas/windesigncharacter.ts` |
| cWinPersonalityWidget | Personality bars of Create-a-Sim | ported | `cas/winpersonalitywidget.ts` |
| cWinVitaBtn, cWinVitaBtnSolo | 3D sim preview buttons | ported | `cas/winvitabtn.ts`, `cas/winvitabtnsolo.ts` |
| cWinPictureSplashDialog | Loading splash | ported | `nbhd/winpicturesplashdialog.ts` |
| cWinProgressPictureDialog | Progress dialog (townies) | ported | `nbhd/winprogresspicturedialog.ts` |
| cWinCredits | Credits | ported | `nbhd/wincredits.ts` |

## Cheats, debug and developer windows

| Class | What it is | Status | Where |
|---|---|---|---|
| cTSCheatCodeManager, cCheatCommandLine, SimsAppCheat | Cheat console (Ctrl+Shift+C): parsing, ";" / "!", error boxes, the shipped 27-name restriction (`?devcheats` lifts it); rosebud, move_objects, autonomy, sim_speed, rotation, route_balloons, bubble_tweak, interests, xyzzy, prepare_lot, history (FamilyHistory.txt as a download), grid, map_edit, sim_log, draw_floorable, draw_routes, genable; neighborhood load / show_zones / show_filter / nessie | partial: map_edit (cTileTool as the cheat tool, cMapTileSwatch overlay), sim_log (SimLog.txt as a download), draw_floorable, draw_routes (a flag nothing reads, as in the shipped build) and genable (terrain / floors / walls / objects / people switches, status box) ported; tile_info, w, damagelist, sweep, move_lots, edit_grass and ReportMissingTextures not ported (see the header of `ui/cheat.ts`) | `ui/cheat.ts`, `cheatflags.ts`, `world/tools/tiletool.ts`, `world/terrain_maptile.ts`, `sim/simlog.ts`, `nbhd/winneighborhoodul.ts`, `nbhd/nessie.ts` |
| cDDDSimsView's frame rate text (+0x18c) | "FPS: %3.1lf" in red at the view's bottom right, toggled by 't' | ported | `ui/framerate.ts`, `cpanel/modekeys.ts` |
| cStalkerCam | "w" cheat / F8: SimsWebCam.jpg written every 10 s | not ported (no web equivalent) | - |
| cTSWinCheatHelp | Cheat list window ("help", only registered unrestricted) | ported | `ui/cheat.ts` |
| cHeadTextRenderer, cHeadTextItem | Text over heads (debug action names, sound captions) | n/a (debug) | - |
| cWinMemView | Memory / heap viewer ("memview", not in the shipped cheat list) | n/a (debug, unreachable in the shipped build) | - |
| cWinSweepMeter | Frame-time sweep meter ("sweep on/off") | n/a (debug) | - |
| cWinTileInfo | Tile inspector ("tile_info on/off"; the shipped build never sizes it nor gives it a tile: nothing shows) | n/a (debug) | - |
| MTIcon | Empty helper (destructor only) | n/a | - |

## Game language (cSimsApp +100)

The language comes from the landing page or `?lang=` (`engine/language.ts`, `UI_LANGUAGE` in
`res/uires.ts`). Every read of cSimsApp +100 in the Mac build was checked against the port:

- Money and time: `res/langutil.ts` holds the only copy of cTSLanguageUtility::MakeMoneyString
  and cTSLanguageManager::MakeTimeString (`cpanel/viewcontrol.ts` and `nbhd/nghinterface.ts`
  re-export it). The game's utility has its currency flag (+0xc) at 0: "$" (drawn as the
  simoleon) before the amount, no space, in every language. Thousands separator (jump table
  lbl_105BCFD0, same in the Windows switch): "," for 1, 2, 12, 15, 17..20; "." for 3..9, 13,
  14; none for 10 (Norwegian), 11 (Finnish), 16. Negative amounts (lbl_105BCFD4): "-$1,234",
  but "$ -1.234" in Danish (8) and 12 and "$-1234" in Norwegian (10). The nbhd copy used to
  group with "." only in French. Time: "AM 10:05" in 1, 2 and 0x13, 24 h otherwise.
- The build / buy tools' price tips (dirt, floor, wallpaper, wall, pool, move) call the
  language manager's MakeMoneyString (vtable +0x84), as the catalog does: they used `§` and
  US English grouping.
- Layout values per language, all matching the original for the offered languages: subpanel
  titles size 10 in French, 11 otherwise (cWinSubpanelFame / Job; House always 11); House
  buttons 12 px wider and moved 6 px left, and button 8 in the size 7 font, in French;
  Create-a-Sim personality buttons size 12 in French / German, 14 otherwise; Options play
  labels (BuildPlayButtons table: 8 in 3, 5, 9; 7 in 4, 14, 16; 9 otherwise); the other
  per-language tables (Job, Fame, Pet skills, House positions, Help, Catalog popup, Options y
  offsets) only differ for 0x0f..0x14: the double-byte ones are ported with the double-byte
  layouts below (with their Thai entries); the Thai-only branches are all ported: Help,
  Options, cWinCatalogPopup's text width (w - 0x11), cWinLivePopup's text right edge without
  a right pane (0x212), cWinPersonality's caption 3 px higher, cWinPeople::Init's last
  personality trait (0x19 px right, its own text rect, then 3 px right), cWinSubpanelJob's
  friends button image at y 9 (2 otherwise), the Job summary table lbl_105BC598.
- cWinPeople::Init: the personality page title takes font table entry 9 in German and 10 in
  Dutch (11 otherwise); cWinScrapbook::Init: the page buttons take entry +0x30 (12) in Dutch
  instead of +0x38 (14). Both ported.
- Character sets and fonts (Windows build: cTSFontSys::TSAcquireFont, cTSDBFontKorean,
  cTSDBFontThai; the Mac build has neither). Strings are bytes of the language's code page;
  the port decodes them to Unicode when it reads them and encodes them back to draw or write
  (`res/codepage.ts`: STR# / CTSS / CATS, chunk labels, ReconBuffer strings, career and
  scrapbook text, the saved string sets). Code pages follow the fonts: 1250 Polish, 1251
  Russian, 1255 Hebrew, 932 Japanese, 936 (GB) Simplified Chinese (17), 950 (Big5)
  Traditional Chinese (18), 874 Thai, 949 Korean, 1252 otherwise (GetCharacterSetFromLanguage,
  only used to compare two languages, swaps 17 and 18 and gives Russian 1250, in the Windows
  build too; the UIText strings are GB for 17).
  Fonts (`res/fonts.ts`): Russian and Polish read `Fonts\Russian\` and `Fonts\Polish\`
  VariableSans; 15, 17, 18, 20 get cTSDBFontKorean (`res/dbfont.ts`), the 1-bit bitmap fonts
  `FONT12J/16J.FON`, `font16gb.fon`, `font16b5.fon`, `FONT12K/16K.FON` of UIGraphics.far
  (all shipped in this install): every instance is created at size 12 (FUN_006098ed), so
  Japanese and Korean always draw the 12 px file and the Chinese languages their only 16 px
  one; lead-byte tests, glyph index formulas, advances (glyph + 1 px for double-byte), margins,
  line height (height of "A"), baseline (line + 1), shadow (black pixel below and below-right
  of each pixel), word wrapping with the kinsoku tables (no line start / no line end lists
  dumped from Sims.exe) are the original's. No browser font is used.
  Big5 (`res/codepage.ts`): the browsers' Big5 decoder also maps the HKSCS rows (lead bytes
  0x81..0xA0), where some Big5 characters appear a second time (響 at 0x90F1 besides 0xC554);
  the encoding table took the first code, outside font16b5's table (glyph 0: the blank in the
  hunger popup's "會影響他們"); Big5 proper now goes first (as the WHATWG encoder), and
  U+2550, 255E, 2561, 256A, 5341, 5345 take their last code, as that encoder does.
  Offered: the 1252 languages, Polish (verified in the neighborhood dialogs), Japanese (日本語),
  Simplified Chinese (简体中文), Traditional Chinese (繁體中文), Korean (한국어) and Thai (ภาษาไทย), the last five
  with the double-byte layouts below (verified in a lot of a throwaway neighborhood: every
  Live page, the description popup, Buy and Build modes, the catalog, the neighborhood, the
  family dialogs and Create-a-Sim).
- Double-byte layouts (CPState::IsDoubleByteUI, `isDoubleByteUI` in `engine/language.ts`,
  `DOUBLE_BYTE_UI` in `res/uires.ts`; Mac call sites: cWinPeople 38, cWinCPanel 5, Fame 4,
  LivePopup / CatSkills / DogSkills / Job 3, House / Motive / DDDSimsView 2, Relationship,
  Interest, ReportCard, PictureInPicture, MagicBook 1), all ported but the paint
  optimisations:
  - cWinCPanel (`cpanel/cpanel.ts`): kTallSubpanel (TallSubPanel.TGA, alpha) pasted from its
    row 50 into a clone of kUniversalCPBkg at (0x118, 0), the clone handed to cWinPeople; its
    top (width - 500) x 50 (+0x104) drawn at (0x208, 0) while the Live panel shows (composed
    with its alpha with interface effects, else a Blt keyed on black); IsPointInWindow takes
    the top 50 px right of x 0x207 where that alpha is above 0x80 (read at byte x - 0x231 +
    y * pitch, as the original). InvalidateAgainstDDD's extra rect: not needed (full repaint).
  - cWinPeople (`cpanel/people.ts`): pages at lbl_105BC4EC (0, 0, 0x118, 0x96) moved to
    lbl_105BC4E4 (300, 0) (the needs, personality, job, fame, pet, report card, house,
    relationships, interests and gifts windows), titles at lbl_105BC4DC (10, 5); needs flow
    from y 0x28 (0x1c Thai), the first two motives' +0x220 capture flag (a background capture,
    no-op here); personality traits from (0xca - w, 0xf) 0x19 apart; interests 4 rows per
    column (BuildInterests); relationships from y 0x23 and their sort buttons 0x27 px lower;
    inventory sorts at font height + 0x28 / + 0x29 / + 0x2a; TSOnMouseMove's page rect;
    IsPointInWindow's alpha test (x - 0x155, as cWinCPanel's). PaintRect, Plot (the shown
    page's InvalidateSelf) and InvalidateAgainstDDD only drive the original's partial repaints.
  - cWinMotive: 25 px high (30 Thai), bar at h - 6, caption in (0, top, w, h - 5) with top 3
    Japanese, 2 Korean, 0 otherwise. cWinRelationship: 0x6e high.
  - Job (`live/job.ts`): kHouseSubpanelBars / kHouseSubBarsOff, skill labels by language
    (lbl_105BC5A4 Japanese, 5A8 Traditional Chinese, 5B4 Korean, 5AC Thai, 5A0 otherwise),
    bars lbl_105BC59C, summary lbl_105BC588 (598 Thai) / sizes lbl_105BC590, title at (0xd, 8)
    in entry 11. Fame (`live/fame.ts`): the same bars, labels lbl_105BCC84 Japanese, 8C
    Simplified Chinese, 90 Traditional Chinese, 80 Korean, 88 Thai, bars lbl_105BCCA4, friends
    lbl_105BCC9C / 94, title lbl_105BCCB4. House: positions lbl_105BC568 Traditional Chinese,
    558 Japanese, 554 Thai, 54C otherwise, sizes 560 (550 Thai), bars 548, title (0xd, 8). Pet
    skills: the house bars, labels (0x67, 0x2d + 0x14 i) in every double-byte language, bars
    lbl_105BCC48. Report card: title 5 px lower.
  - cWinLivePopup: the buffer 50 px taller and the right pane centred above that band. The
    popup is listed right behind the control panel (as cWinPeople::Init adds it while
    cWinCPanel is being added), which hides that band.
  - cWinPictureInPicture / cDDDSimsView::SetMiniUI: the window 0x9b above the panel instead of
    0x69 (SetMiniUI itself, called by CPState when the camera mode's mini UI changes, only
    re-places that window and the edge scroller: not ported); cDDDSimsView's frame rate text
    (`ui/framerate.ts`): its bottom 3 px above the panel's top (Simulate, asm 1020E3CC).
  - CWinMagicBook: the description in font table entry 10. Create-a-Sim: name capacity 16 in
    Japanese (cWinDesignCharacter::Init), counted in bytes (see below).
  - Object and UI string sets read through `sim/behavior.ts` (parseStringSet: careers, fame,
    object dialogs, catalog strings) are decoded with the game's code page, not Windows-1252.
  Not verified: the 800 x 600 page widths. The original picks its resolution at start (the
  largest mode up to 0x1400 x 0x5a0 the display offers, 1024 x 768 with `-r1024x768`), so
  800 x 600 only happens on a small display; the port always runs at 1024 x 768
  (`SCREEN_W` / `SCREEN_H` in `main.ts`): the 800-wide branches (people, gifts, interests,
  relationships, live popup) are kept but never taken, and the double-byte layouts at that
  size cannot be checked. Thai (19) draws with cTSDBFontThai (`res/thaifont.ts`): font20th.fon (256 glyphs of
  Windows-874, 12 x 20, 1 bit, a blank row above and below: line height 22, baseline 23),
  every instance whatever the size and style; text drawn by clusters (FUN_0060964c: a
  consonant with its vowel above or below and its tone mark, the tables DAT_006d98bc width,
  99bc anchor, 9abc class dumped from Sims.exe; a lone tone mark 3 rows lower, tho than's
  tail dropped over a vowel below (glyph 0x9F), ro / fo fa / fo fan move a vowel below 3 px
  right), one pixel after each cluster but spaces, "_" invisible and without width, no drop
  shadow (TSDrawText ignores the shadow flag; flag 4 underlines), word wrapping at space,
  hyphen, no-break space and "_" only (FUN_0060aefc). Verified: neighborhood lot popup, Live
  mode motives, personality page and its popup, fame and relationship pages, a tooltip, the
  catalog popup's wrapped description. IsDoubleByteUI is true for Thai, so the same window
  layouts as for the CJK languages apply. Not ported for Thai: the selection highlight and
  the clip rectangle of TSDrawText (as for cTSDBFontKorean); the Thai game has no IME windows
  and no Thai rule in cTSWinTextEdit2.
  Not offered: Hebrew (12) and Russian (13). The original takes them from the command line
  (-lHebrew, -lRussian) and has no code of its own for them (no right-to-left, no 0xc / 0xd
  branch); but this install has no Hebrew or Russian text at all: their STR# / CTSS entries
  (383 of UIText's 988, 388 in Live.iff, 104 in Behavior.iff...) are copies of the US English
  strings, the others missing; the Russian VariableSans (Fonts\Russian) has only the ASCII
  glyphs. Such a game is the US English one with a few glyphs missing (™), so it is not
  offered.
- Text fields (`ui/textedit.ts`): the capacity counts the bytes of the game's code page, as
  cTSWinTextEdit2::InsertText / ReplaceTextA do (Japanese name capacity 16 = 8 kanji);
  InsertText keeps whole characters; overwriting removes as many characters as the new text
  has bytes. Verified: capacity 5, "日本語" -> "日本", "ab" + "日本" -> "ab日".
- IME (Windows build: the window procedure FUN_005f1654, cTSWinIMEComposition,
  cTSWinIMECandidate; `ui/imecomposition.ts`, `ui/winmgr.ts`): the Japanese, Chinese and
  Korean games (0xf, 0x11, 0x12, 0x14) create a composition window (system font 0, at (0x14,
  0x14), 200 x char height + 8 while composing, black with a (0xa6, 0xb4, 0xb4) inside, the
  target clause on white) and a candidate list window (at (0x14, char height + 0x1e), numbered
  "1:" in Chinese). The result string is posted as WM_CHAR bytes to the focused field. Port:
  while a text field has the focus (desktop too), a hidden input holds the browser focus;
  compositionstart / update / end show, fill and hide the composition window; the composed
  text reaches the field at compositionend as typed characters (through TSOnCharacter, so the
  IsUnsupportedDBLeadByte "-" rule and the byte capacity apply); keys the input method takes
  (isComposing, keyCode 229) stay with it. The browser gives neither the clause attributes
  (no white target clause) nor the candidates: its own candidate list opens at the hidden
  input, placed where the original's list window is. Verified with Chrome's
  Input.imeSetComposition: "にほん" shown in the window, "日本" committed once, then typed
  letters.
- UI TGAs (nsSMResFac::LoadBuffer -> GIMEXFactory, Windows 0x4dea..): a 32-bit TGA gets an
  alpha buffer; with the flag lbl_105BA7EC / DAT_006c8c2c set (always, but around
  cMagiclandSprites::LoadClouds' three fog TGAs) alpha 0 takes the transparent colour, 0xff
  keeps the colour, any other alpha divides it back: colour * (255 / alpha) + 0.5, truncated,
  passed as a byte (a result above 255 wraps). Ported as `decodeImage(..., { unpremultiply })`
  (`res/bmp.ts` gimexUnpremultiply), set by `UIRes.imageByPath` (every `res.image()`);
  `res.rgba()` keeps the stored colours (the fog, flag clear, and cWinViewControl's own
  decoding of UniversalBack.tga). TallSubPanel.TGA and UniversalBack.tga are premultiplied;
  HotSpotPopupTiler.tga is not (0, 0, 82 under a varying alpha), so its low-alpha edge pixels
  take the original's wrapped blues (seen in the neighborhood lot popup). TallSubPanel.TGA
  (cWinCPanel, double-byte UI only) is not drawn by the port yet.
- BMPFactory(iResFile *, id) (every BMP_ the game shows: object dialogs, speech icons,
  catalog pictures, tutorial icon, gifts, thumbnails, portraits) asks GetByIDAndLanguage
  with cSimsApp +100: IFFResMap::GetNodeWithLanguage takes the first BMP_ of that id whose
  language (the chunk flags' high byte) is the game's, else the first with language 0.
  Ported in `ResFile.get("BMP_", id)` (`world/iffres.ts`, `findWithLanguage`). The shipped
  files that have such variants: Tutorial.iff BMP_ 5018 (SimsLogoTut US / FR 3 / DE 4 /
  SP 6 / JP 15, the JP one first in the file), Newspaper.iff BMP_ 2000 / 4000 / 6000
  (German, first), and the TrashPack download (language 0xff copies of BMP_ 2000). The
  object catalog's icon (`data/catalog.ts`, its own resource-map scan, which skips the flags)
  still takes the first BMP_ of the id (for the TrashPack cans, the 0xff copy if their
  catalog id is 2000; not checked).
- The EA intro movie (Windows cSimsApp::Init and FUN_004ef759): `screens/intro.ts`. It
  plays over the splash at every start unless the command line has "skip_intro"
  (`?skip_intro`); IntroMovieEnded then starts the load music and the load. Music/eag_<x>.avi
  by language (3 fr, 4 de, 5 it, 6 sp, 7 du, 8 dn, 9 sw, 0xb fi, 0xe br, 0x10 po, else us:
  Norwegian gets eag_us.avi although eag_no.avi ships), stretched to the game window,
  stopped by a click or a key (cTSMainWindowW95::TSOnMouseDownL / TSOnKeyDown ->
  cTSGraphicSystemW95::StopMovie). The AVIs are MS-MPEG4 v1 ("MPG4", 720 x 486, 3 s, PCM
  sound): `GET /api/movie/<name>` (`server/src/routes/movies.ts`) transcodes them once to
  WebM (VP8 + Vorbis) into `server/data/movies/` when the server has ffmpeg (`FFMPEG`, else
  `ffmpeg` on the PATH), else answers 404 and the client skips the movie (also with
  GAME_FILES=client and offline). A browser refusing sound before any input plays it muted.
- cDDDSimsView's pause text (`ui/pausetext.ts`): "Paused" (not translated, Mac lbl_105BC0E4 +
  0x102, Windows s_Paused), size 48 (12 in Finnish), red (0xff, 0, 0), centred at the top of the
  view (y 0x14), with the +0x17c child window over it. CPState::SetMode shows it for 3 s
  (+0x188 = 3000) entering build, buy and camera modes, for good in options, and in live mode
  while paused (CPState::Pause: shown or hidden, no timer). Verified: shown 1 s after entering
  buy mode, gone at 4.5 s, not shown in live mode unpaused.
