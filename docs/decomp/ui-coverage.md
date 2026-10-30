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
What is still missing is either debug-only or listed in the "partial" notes.

Status: **ported** (the class and the behaviour a player sees), **partial** (the class exists,
named parts missing), **missing**, **n/a** (OS / debug / IME plumbing replaced by the browser,
or developer-only tools).

## Framework and widgets

| Class | What it is | Status | Where |
|---|---|---|---|
| cTSWin | Window base: area, flags, children, plot, hit testing | ported | `ui/tswin.ts` |
| cTSWinMgrW95 | Window manager: input routing, capture, modal loop, paint | ported (focus / modal key routing, WF_NO_FOCUS, TSSetFocus kill / set messages) | `ui/winmgr.ts` |
| cTSWinCtrlMgr | System bitmaps and fonts of the controls | ported | `ui/ctrlmgr.ts`, `ui/syscolors.ts` |
| cTSWinBtn | Button (frame columns, push / toggle, async timers) | ported | `ui/btn.ts` |
| cTSWinCheck | Check box | ported | `ui/check.ts` |
| cTSWinText | Static text | ported | `ui/text.ts` |
| cTSWinTextEdit2 | Edit field | partial (no selection, clipboard, undo, scrollbar) | `ui/textedit.ts` |
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
| cWinViewControl | Clock, speed, zoom, rotation, levels, funds, help button, friend count dialog (STR# 162) | ported | `cpanel/viewcontrol.ts` |
| cWinBudgetDlg, cWinBudgetRow | Budget window (funds click on a residential lot): 3-day / today income and expenses by type, funds, net worth, days | ported (object / architecture values recomputed at opening) | `cpanel/budgetdlg.ts` |
| cWinHelp | Help window (view control "?" button): topic list and text | ported | `cpanel/help.ts` |
| cWinPeople | Live panel: portraits, mood, page buttons | partial (portrait pie menus, sim tracking, at-work overlays) | `cpanel/people.ts` |
| cWinMotive | Needs page, with its delta meters | ported | `cpanel/live/motive.ts` |
| cWinDeltaMeter, cAverageHistory | Up / down change arrows of the needs | ported (needs; the relationship page's meter is wired but, as in the original, its history is null so it never draws arrows) | `cpanel/live/deltameter.ts` |
| cWinPersonality | Personality page | ported | `cpanel/live/personality.ts` |
| cWinSubpanelJob, cFlashyBtn, cPerformanceBtn | Job page (adult) | ported | `cpanel/live/job.ts` |
| cWinSubpanelReportCard | Job page of a child: blinking grade ("Bulletin"), school popup | ported | `cpanel/live/reportcard.ts` |
| cWinSubpanelCatSkills, cWinSubpanelDogSkills | Job page of a cat / dog (pet skills and popups) | ported | `cpanel/live/petskills.ts` |
| cWinSubpanelFame | Job page of a celebrity (Superstar) | partial (skill panes as catalog objects) | `cpanel/live/fame.ts` |
| cWinSubpanelHouse | House page | ported | `cpanel/live/house.ts` |
| cWinRelationship | Relationships page | ported | `cpanel/live/relationship.ts` |
| cWinInterest (+ BufferCleanup) | Interests page | ported | `cpanel/live/interest.ts` |
| cWinGift | Gifts / inventory page | ported | `cpanel/live/gifts.ts` |
| cWinEditBio | Biography editor (Ctrl+click on a portrait), saved into the character's CTSS | ported | `cpanel/live/editbio.ts` |
| cWinLivePopup, cWinLivePopupClient | Description popup of the pages and options | partial (object icon panes) | `cpanel/livepopup.ts` |
| cWinCatalog, ProductButton | Buy mode catalog | ported | `cpanel/catalog.ts`, `cpanel/buy/` |
| cWinCatalogPopup | Catalog product popup | ported | `cpanel/buy/catalogpopup.ts` |
| cWinDisposePopup | Sell page of the control panel while a lot object is held in Buy / Build mode (picture, "click here to sell X for $", refund) | ported (its slide-in ramp is never started in either build) | `cpanel/disposepopup.ts` |
| cWinArch | Build mode panel | ported | `cpanel/arch.ts` |
| cWinRoofPanel | Roof sub-panel | ported | `cpanel/arch/roofpanel.ts` |
| cWinOptions | Options panel: save, neighborhood, quit, graphics / sound / play sub-panels (shadows, lighting, terrain and character detail, effects / music / voice volumes, scroll speed, screen size via play options) | partial (sub-panel fades, town lot save variants) | `cpanel/options.ts` |
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
| CWinMagicBook, cPickSpellList, cPickSpellItem | Spell book / cookbook | partial (expansion filters) | `ui/magicbook.ts` |
| cWinPictureInPicture | Event picture-in-picture | partial (scrapbook auto snapshot) | `world/winpictureinpicture.ts` |
| cTutorialIcon | Close box of the tutorial dialogs | partial | `ui/picturedialog.ts` |
| cTSWinTutorialHighlight | Tutorial arrow over a button or lot (neighborhood tutorial lots, prim 34 effect 0) | partial (Tut_CheckForEvents) | `ui/tutorialhighlight.ts` |
| cActionIcon | Queued action icons (frame, product / people picture, cancel cross, slides, StartUserAction) | ported | `world/actionicons.ts` |
| cColorSwatch, cGouraudSwatch, cMapTileSwatch | Terrain tool swatches | ported | `world/terrain*.ts` |

## Neighborhood, towns, Create-a-Sim

| Class | What it is | Status | Where |
|---|---|---|---|
| cWinNeighborhood, cWinNeighborhoodUL | Neighborhood screen (Unleashed layout) and the "Ask for Lot" destination picker (lot type filter toolbar, title, filter icons, residential lot message) | partial (Tutorial.FAM first-run import, import charset check, ReportMissingTextures, web pages export, move_lots and nessie cheats) | `nbhd/winneighborhoodul.ts` |
| cWinNeighborhoodVC | Pre-Unleashed neighborhood layout | n/a (only used without Unleashed) | - |
| cWinLotBtn | Lot button | ported | `nbhd/winlotbtn.ts` |
| cWinLotPopup (+ CleanupVacationBuffers) | Lot info popup (family / house) | ported | `nbhd/winlotpopup.ts` |
| cWinDowntown, cWinVacation, cWinStudiotown, cWinMagicland | Town screens of the expansions | partial (lot imports, Magic Town move in) | `nbhd/wintown.ts` |
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
| cTSCheatCodeManager, cCheatCommandLine, SimsAppCheat | Cheat console (Ctrl+Shift+C): parsing, ";" / "!", error boxes, the shipped 27-name restriction (`?devcheats` lifts it); rosebud, move_objects, autonomy, sim_speed, rotation, route_balloons, bubble_tweak, interests, xyzzy; neighborhood load / show_zones / show_filter | partial (map_edit, prepare_lot, sim_log, tile_info, history, w, graphics cheats, move_lots, nessie: not ported) | `ui/cheat.ts`, `cheatflags.ts`, `nbhd/winneighborhoodul.ts` |
| cTSWinCheatHelp | Cheat list window ("help", only registered unrestricted) | ported | `ui/cheat.ts` |
| cHeadTextRenderer, cHeadTextItem | Text over heads (debug action names, sound captions) | n/a (debug) | - |
| cWinMemView | Memory / heap viewer | n/a (debug) | - |
| cWinSweepMeter | Frame-time sweep meter | n/a (debug) | - |
| cWinTileInfo | Tile inspector | n/a (debug) | - |
| MTIcon | Empty helper (destructor only) | n/a | - |
