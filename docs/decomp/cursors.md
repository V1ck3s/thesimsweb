# Mouse cursors (audit of the Windows build, 2026-10-31)

Reference: `Sims.exe` (Complete Collection, no-CD) through `~/simsweb-build/decomp/win-pseudoc/`
(addresses below are Sims.exe virtual addresses), names from the Mac build
(`mac-pseudoc-annotated/`). Where the Windows function has no symbol, the Mac name is given after
matching the code. Port: `client/src/game/ui/cursor.ts` (cTSCursorManager), `ui/winmgr.ts`
(`applyCursor`, `setGlobalCursor`), `TSWin.winCursor` (cTSWin+0x68).

## 1. The cursor files

`cSimsApp::SetupWinCtrlMgr` (0x4efb69) builds `<data>/UIGraphics/shared/cursors/` (string
0x6ca530) and registers each file with `cTSCursorManager::AddCursor(new cTSCursor(path), id)`
(0x5e74f4); ids 0, 3 and 2 get a `RemoveCursor(id, true)` (0x5e753d) first. `cTSCursor`'s
constructor (0x5e7372) is `LoadCursorFromFileA`; `cTSCursor::SetCursor` (0x5e73da) is
`::SetCursor`. **Sims.exe has no cursor resources** (its `.rsrc` holds bitmaps, icons, menus,
dialogs, a version block only) and **no animated cursor** (.ani) is loaded. The window class
cursor is the system `IDC_ARROW` (`RegisterClass`, `LoadCursorA(0, 0x7f00)`), replaced by the
game's own arrow at the first mouse move.

`GetStandardCursor` (0x5e749a) and `GetCursor` (0x5e74ca) are the **same map lookup**: the
"standard" cursors are just ids 0, 2, 3, 4 of the table (4 is the finger, not a system cursor).

Every file is a 32 x 32 monochrome cursor (326 bytes). Hotspots are the files' own:

| Id | File | Hotspot | Shown by |
|---|---|---|---|
| 0 | Arrow.cur | 0, 0 | default of every window (root), panels, dialogs, pie menu, tools' "normal" cursor |
| 2 | edit.cur | 15, 15 | cTSWinTextEdit2 (I-beam; all its pixels are XOR / screen-inverting) |
| 3 | HOURGLASS.cur | 16, 15 | StartWatchCursor, progress / taxi splash dialogs, neighborhood busy handlers |
| 4 | finger.cur | 13, 4 | cActionIcon, neighborhood / town lots (regular mode), cWinLotBtn tutorial highlight |
| 5 | (none) | | ToolCursor "keep": cDDDSimsView::SetToolCursor ignores it |
| 6 | SimsDelete.cur | 16, 15 | wall / floor / wallpaper / pool delete (Ctrl), Ctrl over doors and windows |
| 7 | SimsLevel.cur | 16, 13 | registered, never set |
| 8 | SimsLower.cur | 15, 14 | registered, never set |
| 9 | SimsRaise.cur | 15, 20 | registered, never set |
| 0xa | SimsMove.cur | 16, 11 | cMoveTool, nothing held (the hand) |
| 0xb | SimsPlace.cur | 16, 11 | cMoveTool, an object held |
| 0xc | SimsRotate.cur | 16, 11 | cMoveTool +0x80 (grab refused / rotation not started) |
| 0xd..0x10 | SimsRotateNW / NE / SW / SE.cur | 16, 11 | cMoveTool drag rotation (+0x7c = 6, 0, 4, 2) |
| 0x11..0x18 | LEFT, RIGHT, UP, DOWN, UPRIGHT, UPLEFT, DOWNRIGHT, DOWNLEFT.cur | 6,15 / 24,15 / 15,9 / 15,21 / 25,8 / 5,9 / 25,22 / 5,22 | EdgeDetectScroller: edge zones and right-drag direction |
| 0x19 | EXPLORE.cur | 16, 16 | EdgeDetectScroller: right drag started |
| 0x1a | DEADEXPL.cur | 15, 15 | EdgeDetectScroller: right drag slower than 100 px/s |
| 0x1b | Pan.cur | 15, 15 | EdgeDetectScroller::OnKeyDown (0x4d503b): Alt (VK_MENU) held, the mouse pans the view (unforced global); OnKeyUp ends it |
| 0x1c | LiveNothing.cur | 15, 13 | cObjPickerTool::Float, nothing under the mouse |
| 0x1d | LivePerson.cur | 15, 13 | cObjPickerTool::Float, a person |
| 0x1e | LiveObjectAvail.cur | 15, 13 | cObjPickerTool::Float, an object with interactions |
| 0x1f | LiveObjectUnavail.cur | 15, 13 | cObjPickerTool::Float, no interaction / off the lot |
| 0x20 | ADDPTS.cur | 8, 11 | cWinPersonalityWidget, right of the lit LEDs |
| 0x21 | MOVEIN.cur | 0, 0 | neighborhood / town move-in mode (the file is an .ico: its hotspot fields read 0, 0) |
| 0x22 | BULLDOZE.cur | 17, 18 | neighborhood / town evict (bulldoze) mode |
| 0x23 | SimsFlip.cur | 16, 11 | cMoveTool +0x7a, never set to 1 (dead) |
| 0x24 | RemovePts.cur | 16, 15 | cWinPersonalityWidget, on the lit LEDs |
| 0x25 | taxi.cur | 0, 14 | registered (Downtown picker uses its own table, see below) |
| 0x26 | water.cur | 9, 19 | cWaterTool::Select |
| 0x27 | van.cur | 0, 16 | Vacation picker |
| 0x28 | Rezone2.cur | 3, 20 | neighborhood rezone mode |
| 0x29 | trolleybus.cur | 0, 16 | neighborhood visit mode / destination picker, Downtown picker |
| 0x2a | LivePet.cur | 7, 2 | Live, a pet under the mouse (not GUID 0xFC697613) |
| 0x2b | LiveNothingPet.cur | 15, 13 | Live, nothing under the mouse with a pet selected |
| 0x2c | limo.cur | 0, 16 | Studio Town picker (star asking) |
| 0x2d | tram.cur | 0, 15 | Studio Town picker |
| 0x2e | hole.cur | 2, 5 | Magic Town picker (global 34 == 0) |
| 0x2f | balloon.cur | 0, 10 | Magic Town picker (global 34 != 0) |

In the folder but never loaded: `hand.cur`, `HELP.CUR` (two images), `NODROP.CUR`, `Rezone.cur`,
`ship.cur` (strings for hand / help / nodrop exist at 0x6ca4e4.. but SetupWinCtrlMgr does not use
them).

## 2. How the cursor is chosen

| Step | Windows | What it does |
|---|---|---|
| `cTSWin::SetCursor(c)` | 0x5dde6d | stores +0x68; if it changed and the window is visible, `PumpMouseMoveMsg` (0x5db0b7: +0x1e1 = 1), so the cursor updates at once |
| `cTSWin::HideCursor` / `ShowCursor` | 0x5ddda7 / 0x5dddc1 | flag 0x800 on / off |
| `cTSWin::UpdateCursor` | 0x5ddddb | walk up from the window: a window with 0x800 hides the cursor (ShowCursor(0) loop 0x5e7426); the first window with a cursor wins; the root without one gets `GetStandardCursor(0)` stored. Then `cTSWinMgrW95::SetCursor(cursor, owner)` |
| `cTSWinMgrW95::SetCursor` | 0x5db182 | the global cursor (+0x1c4) replaces the window's when it is **forced** (+0x1c8) or the owner has flag **0x20000**; `::SetCursor` |
| `cTSWinMgrW95::SetGlobalCursor(c, forced)` | 0x5dadbc | a forced global cursor can only be replaced / cleared by another forced call; clearing it unforces |
| `cTSWin::ProcessCursorMessage` | 0x5dcbd1 | mouse move (0xd): `UpdateCursor` on the window under the mouse, before the window's own handler; 0xf (mouse leaves): standard arrow |
| `ProcessSystemMessage` (capture branch) | 0x5da854 | with a capture window, mouse moves update the cursor of **the capture window**, wherever the mouse is; with a modal window, only the modal window (and 0x10000 windows) get cursor updates; outside the main window the root's cursor is cleared (arrow) |
| `cTSWinMgrW95::DoModalWin` | 0x5daa44 | saves the global cursor, `SetGlobalCursor(0, true)` for the loop, restores it (with its forced bit) after |
| `cSimsApp::WindowSetup` | 0x4f4acc | `SetFlag(0x20000)` on cDDDSimsView: only the lot view (and its children without a cursor) takes unforced global cursors |

## 3. Who sets which cursor

| Class / function | Windows | Mac | Cursor | When it goes back |
|---|---|---|---|---|
| cDDDSimsView::SetToolCursor(id) | 0x4d25a5 | 0x1020cc20 | +0x16c = id; `SetCursor(GetCursor(id))` on the lot view unless id 5 | the next SetToolCursor |
| cTool::Select / cTool::SetCursor | 0x492beb / 0x492d30 | 0x10189520 / 0x10188e80 | 0 on every tool selection, before the tool's own | |
| cObjPickerTool::Float (Live) | 0x48ca6e | 0x1017ce90 | 0x1c / 0x2b nothing, 0x1f off the lot, 0x1d / 0x2a person, 0x1e / 0x1f object | each Float (mouse move) |
| cMoveTool::UpdateCursor (Buy, doors, windows, stairs...) | 0x486e21 | 0x1016db00 | Ctrl + door / window item: 6; +0x80: 0xc; nothing held: 0xa; +0x7a: 0x23; held: 0xb, dragging rotation: 0xe / 0x10 / 0xf / 0xd | each Float / Click / Release / key |
| cNewWallTool::SetCursor | 0x48b9f3 area | 0x10176ef0 | delete mode 6, else 0 | Ctrl up |
| cNewFloorTool Select / Deselect / Float / Click / Drag | 0x488d51 / 0x488d6e / 0x489b92 | 0x10172620.. | 0, delete (Ctrl) 6 | Deselect: 0 |
| cNewWallpaperTool Select / Float / Click / Drag | 0x48a9df | 0x101756d0.. | 0, delete 6 | |
| cPoolTool OnEnterWorld / OnKeyDown / OnKeyUp / Release / SetMode | 0x4905d0 | 0x10180b70.. | 0, Ctrl 6 | key up / release: 0 |
| cSimpleAltTool (raise / lower) Float / Click / Drag | 0x491e92 | 0x101837a0.. | 0 (both branches) | |
| cLevelDirtTool::Select, cGrassTool, cTileTool Select | 0x484d84 | 0x1016b060.. | 0 | |
| cWaterTool Select / Deselect | 0x4973b1 / 0x4974ce | 0x101968f0 / 0x101967d0 | 0x26 / 0 | Deselect |
| CPState::UpdateWorldFromCPState (mode change) | 0x4ce5de | 0x10208790 | SetToolCursor(0) entering options (3) or camera (4) mode | |
| cDDDSimsView::StartWatchCursor | 0x4d3125 | 0x1020b570 | saves the global (+0x11b4), `SetGlobalCursor(hourglass, true)`, +0x11b8 = 1 | cDDDSimsView::TSPaint (0x4d0e7d): `SetGlobalCursor(0, true)` then the saved one unforced |
| cSimsApp::SaveGame | 0x4f277c | 0x1024f010 | StartWatchCursor; at the end `SetGlobalCursor(arrow, true)` | next lot view paint |
| cSimsApp::LoadGame, the neighborhood lot handlers going to a lot | 0x4f1b96, 0x55cb93, 0x562616 | 0x1024f7f0 | StartWatchCursor | next lot view paint |
| EdgeDetectScroller::OnMouseMove (edge zones) | 0x4d4752 | 0x10212c80 | `SetGlobalCursor(GetCursor(0x11..0x18), false)` through 0x4d4d42 when entering a zone | leaving it: `SetGlobalCursor(0, false)` + UpdateCursor |
| EdgeDetectScroller right drag | 0x4d4752, Classify 0x4d5363 | | 0x19, then the direction (0x11..0x18) or 0x1a, unforced, with the capture | StopScrolling (0x4d52d5) |
| cActionIcon::cActionIcon | 0x4caa64 | 0x101fd5a0 | `GetStandardCursor(4)`: the **finger** | |
| cWinCPanel::Init | 0x509b69 | 0x102672e0 | arrow (the lot view's tool cursor stops at the panel) | |
| cWinViewControl::Init | 0x5382a4 | 0x102ad0a0 | arrow (it is a lot view child) | |
| cWinPictureInPicture::Init | 0x525055 | 0x10291330 | arrow | |
| cTSPieMenu::cTSPieMenu | 0x5ea0f3 | 0x10521660 | arrow | |
| cTSWinMsgBox::cTSWinMsgBox | 0x5e5157 | 0x1051bca0 | arrow | |
| cWinPictureDialog::Init | 0x523606 | 0x1028e930 | arrow | |
| CWinMagicBook::CWinMagicBook | 0x510867 | 0x10583250 | arrow | |
| cWinDesignFamily::cWinDesignFamily | (0x54866a, a GenDlg ctor: standard 0) | 0x102c92c0 | arrow | |
| cTSWinTextEdit2::Init / Rebuild | 0x5f1ad8 / 0x5f3a06 | 0x1052c070 / 0x10527820 | edit (2); its scrollbar child: arrow | |
| cWinPersonalityWidget::Init / TSOnMouseMove | 0x562d9f / 0x5632d6 | 0x102cfb50 / 0x102cf020 | 0x20 right of the lit part (or value 0), 0x24 on it (or value 10), none (inherit) when disabled | each move |
| cWinTileInfo::Init, cWinMemView::Init (debug) | 0x53575a, 0x5120af | | arrow | |
| cTutorialIcon::Init, cTSWinTutorialHighlight::Init, cTSWin::HiliteForTutorial | 0x4ff964, 0x5e963c, 0x5de04b | | arrow on the highlight | |
| cWinLotBtn::HiliteForTutorial | 0x54f420 | 0x102c9c50 | finger on the highlight | |
| cWinCatalog::TSPaint | 0x506193 | 0x10261e50 | `SetCursor(0)` (inherit: the panel's arrow); the hourglass branch (+0x478, set in 0x5072f5) is never armed | |
| cWinPictureSplashDialog::Init | 0x525baf | 0x10401bd0 | hourglass | |
| cWinProgressPictureDialog Init / TSBeginModal / TSPaint | 0x525e72 / 0x5260f9 / 0x526a9c | | hourglass | |
| cTSWinSplashScreen Init / Shutdown | | 0x10525b70 / 0x10525a60 | HideCursor / ShowCursor | Shutdown |
| cWinNeighborhoodUL::SetMode | 0x55b4e6 | 0x1045ce00 | regular: finger (main screen, +0x111) or trolley 0x29 (picker); move in 0x21; evict 0x22; rezone 0x28; visit 0x29; on the screen and every lot | next SetMode |
| cWinNeighborhoodUL Rezone / Evict lot handlers | 0x558a29 / 0x558d57 | 0x104602d0 / 0x104608d0 | hourglass during the work, then the saved cursor | end of the handler |
| cWinNeighborhoodVC / cWinDowntown / cWinVacation / cWinStudiotown / cWinMagicland SetMode | 0x561954 / 0x54c4af / 0x56b2f2 / 0x5666ee / 0x5547b8 | | finger, 0x21, 0x22, the picker cursor (0x29 / 0x27 / 0x2c..0x2d / 0x2e..0x2f) | |
| neighborhood / town Init, Shutdown, TSOnCommand, TSOnTimerMsg | e.g. 0x556bc9 / 0x557dfc / 0x558145 / 0x55824d | | `SetGlobalCursor(0, true)` | |

Buttons (cTSWinBtn), text, lists, scrollbars, sliders, check boxes, tooltips and the generic
dialogs set no cursor: they show their parent's.

## 4. Port status (after this audit)

| Topic | Before | Now |
|---|---|---|
| Cursor images | CSS `url(file.cur)`: the browser decoded the monochrome files itself (the XOR I-beam of edit.cur disappeared, hotspots up to the browser, MOVEIN is an .ico) | `loadCursors()` (boot) fetches the game's files and decodes them to PNG data URLs with their hotspots; XOR pixels drawn black with a white outline (a browser cannot invert the screen) |
| Standard cursor 4 | arrow (wrong table) | finger: the action queue icons (U36), neighborhood / town lots, the lot tutorial highlight |
| Default cursor | the browser's arrow | the game's arrow (root default) |
| Capture | cursor of the window under the mouse | cursor of the capture window (right-drag scroll over the panel keeps the arrows) |
| Global cursor | always on top | forced / unforced (0x20000 on the lot view), cleared during modal loops and restored after |
| Hidden cursor | no | WF_HIDE_CURSOR (splash screen) |
| Window cursors added | | pie menu, message box, view control, PIP, magic book, design family, text edit (I-beam), personality widget (add / remove points), progress dialog (hourglass) |
| Mode change | the tool cursor stayed in camera / options mode | arrow (CPState::UpdateWorldFromCPState) |
| Watch cursor | frozen-screen hourglass only | also cDDDSimsView::StartWatchCursor for SaveGame, ended by the first paint after the work |
| Edge scrolling | no cursor | edge-zone arrows (unforced global) |
| Neighborhood picker | finger in regular mode | trolley 0x29 in the picker (+0x111 clear) |

Not ported: the Alt pan mode of EdgeDetectScroller (Pan.cur, OnKeyDown / OnKeyUp, no pan mode in the port yet), and windows without a port: cTutorialIcon, cWinTileInfo / cWinMemView (debug), the text edit's
scrollbar. Firefox and Chrome honour the explicit hotspots; the cursors are drawn at 32 x 32 CSS
pixels whatever the canvas scale (the original is native 1024 x 768).

Verified in Chrome (`getComputedStyle(canvas).cursor` matched against the decoded table) on
`?house=1`: Live nothing 0x1c, object 0x1e / 0x1f, person 0x1d, action icon 0x4, panel / view
control 0, pie menu 0 (with its capture), edges 0x13 / 0x15; Buy hand 0xa, held 0xb, can't grab
0xc, drag rotation 0x10 / 0xf / 0xe, sold (Delete) 0xa, panel 0; Build terrain 0, pool / wall /
wallpaper / floor 0 and Ctrl 6, door / window / stairs / fireplace / tree 0xb (door and window
Ctrl 6), roof 0, hand 0xa; right drag 0x12 / 0x17 / 0x18 with the capture, still over the panel;
camera and options 0; splash none; neighborhood finger, bulldoze 0x22, rezone 0x28, Downtown
finger; dialogs 0.
