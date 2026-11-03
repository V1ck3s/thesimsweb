/**
 * The control panel mode keys of the lot view (cDDDSimsView::TSOnKeyDown,
 * VK_F1..VK_F5). A collapsed panel (CP mode 1) is opened first.
 *  - F1: Live mode; in Live mode it collapses / opens the panel instead
 *    (unless live mode is disabled);
 *  - F2: Buy mode (ResetPreviousPages); in Buy mode it switches the catalog
 *    between the room and function sorts (jump table lbl_105BC0CC: 0 <-> 1,
 *    the other sorts stay), unless buy and build are disabled;
 *  - F3: Build mode, unless buy and build are disabled;
 *  - F4: Camera mode, unless live mode is disabled or Alt is down (Alt+F4);
 *  - F5: Options.
 */

import { soundPlayer, UI, UI_SOURCE } from "../audio/index.js";
import type { GameContext } from "../context.js";
import { CatalogSort, type CPState, Mode, WallState } from "../cpstate.js";
import { currentTaxiDialog } from "../nbhd/winpicturesplashdialog.js";
import type { Strings } from "../res/strings.js";
import { TSWinMsgBox } from "../ui/msgbox.js";
import { winMgr } from "../ui/winmgr.js";
import type { WinCPanel } from "./cpanel.js";

/** cDDDSimsView::TSOnKeyDown for F1..F5; true when `key` is one of them. */
export function modeKeyDown(state: CPState, key: string): boolean {
  const openPanel = (): void => {
    if (state.getCPMode() === 1) state.setCPMode(0);
  };
  switch (key) {
    case "F1":
      if (state.isLiveModeDisabled()) return true;
      if (state.getMode() === Mode.Live) state.setCPMode(state.getCPMode() === 1 ? 0 : 1);
      else state.setMode(Mode.Live);
      return true;
    case "F2":
      if (state.isBuyAndBuildDisabled()) return true;
      openPanel();
      if (state.getMode() === Mode.Buy) {
        const sort = state.shopGetSort();
        if (sort === CatalogSort.Room) state.shopSetSort(CatalogSort.Function);
        else if (sort === CatalogSort.Function) state.shopSetSort(CatalogSort.Room);
        else state.shopSetSort(sort);
      } else {
        state.setMode(Mode.Buy);
      }
      state.resetPreviousPages();
      return true;
    case "F3":
      if (state.isBuyAndBuildDisabled()) return true;
      openPanel();
      state.setMode(Mode.Build);
      return true;
    case "F4":
      if (state.isLiveModeDisabled() || winMgr.isKeyDown("Alt")) return true;
      openPanel();
      state.setMode(Mode.Camera);
      return true;
    case "F5":
      openPanel();
      state.setMode(Mode.Options);
      return true;
    default:
      return false;
  }
}

/** What {@link viewKeyDown} needs from the lot view. */
export interface ViewKeyHooks {
  /** cTSWinMgrW95::GetWindowFromPoint(cursor) is the lot view itself (Windows FUN_004d3d05). */
  cursorOverView(): boolean;
  /** HouseViewer +0x3c: the rendered lot view. */
  screenBuffer(): HTMLCanvasElement | OffscreenCanvas | null;
}

/** cSoundPlayer::PlayBySource("UI_error", -4): a refused view key. */
function refuse(): void {
  soundPlayer.playBySource(UI.error, UI_SOURCE);
}

/** The second level may be shown: in Build mode on a floorable lot, or once a sim has been up there. */
function canGoUp(state: CPState): boolean {
  return (state.getMode() === Mode.Build && state.is2ndLevelFloorable()) || state.hasBeenTo2ndLevel();
}

/**
 * cDDDSimsView::TSOnKeyDown (Windows 004d1450, Mac 0x1020E700), the view keys
 * besides F1..F5 (the developer stalker camera F8 is not ported):
 *  - Tab: level 1 -> 2 when {@link canGoUp} (else UI_error), level 2 -> 1;
 *  - Page Up: level 2 when below it and {@link canGoUp}, else UI_error;
 *    Page Down: level 1 from level 2, else UI_error;
 *  - End: walls up -> cutaway -> down (UI_error when already down), Home
 *    the other way (UI_error when already up); the roof view stays;
 *  - Shift + Left / Right rotate (CPState::RotateLeft / RotateRight), Ctrl +
 *    arrows in camera mode with the cursor over the view resize the camera
 *    frame by 4 pixels (CamSetSize(width +- 4, height +- 4), Up taller, Down
 *    shorter); arrows with Shift or Ctrl never scroll (EdgeDetectScroller::
 *    OnKeyDown takes the plain ones);
 *  - F10: the screen capture (FUN_004d2ffa): the rendered lot view saved as
 *    "%d%02d%02d_%02d%02d%02d.jpg" (local year, month, day, hour, minute,
 *    second; SaveGimex quality 0x5a) into the game folder; here a download.
 * True when the key is consumed. Tab, Home and End are not in the original
 * (they go on to the tool); Tab is consumed here so that the browser keeps
 * the focus.
 */
export function viewKeyDown(state: CPState, key: string, hooks: ViewKeyHooks): boolean {
  switch (key) {
    case "Tab":
      if (state.getLevel() !== 1) state.setLevel(1);
      else if (canGoUp(state)) state.setLevel(2);
      else refuse();
      return true;
    case "PageUp":
      if (state.getLevel() < 2 && canGoUp(state)) state.setLevel(2);
      else refuse();
      return true;
    case "PageDown":
      if (state.getLevel() < 2) refuse();
      else state.setLevel(1);
      return true;
    case "End": {
      const ws = state.getWallState();
      if (ws === WallState.Up) state.setWallState(WallState.Cutaway);
      else if (ws === WallState.Cutaway) state.setWallState(WallState.Down);
      else if (ws === WallState.Down) refuse();
      return false;
    }
    case "Home": {
      const ws = state.getWallState();
      if (ws === WallState.Up) refuse();
      else if (ws === WallState.Cutaway) state.setWallState(WallState.Up);
      else if (ws === WallState.Down) state.setWallState(WallState.Cutaway);
      return false;
    }
    case "ArrowLeft":
    case "ArrowRight":
    case "ArrowUp":
    case "ArrowDown": {
      const ctrl = winMgr.isKeyDown("Control");
      if (ctrl) {
        if (hooks.cursorOverView() && state.getMode() === Mode.Camera) {
          let w = state.camGetWidth();
          let h = state.camGetHeight();
          if (key === "ArrowLeft") w -= 4;
          else if (key === "ArrowUp") h += 4;
          else if (key === "ArrowRight") w += 4;
          else h -= 4;
          state.camSetCustomSize(w, h);
        }
        return true;
      }
      if (!winMgr.isKeyDown("Shift")) return false;
      if (key === "ArrowLeft") state.rotateLeft();
      else if (key === "ArrowRight") state.rotateRight();
      return true;
    }
    case "F10": {
      const view = hooks.screenBuffer();
      if (view) void saveScreenCapture(view);
      return true;
    }
    default:
      return false;
  }
}

/** FUN_004d2ffa: GetLocalTime -> "%d%02d%02d_%02d%02d%02d.jpg", SaveGimex(name, buffer, 0, 0x5a, 1, 0). */
async function saveScreenCapture(view: HTMLCanvasElement | OffscreenCanvas): Promise<void> {
  const t = new Date();
  const d2 = (n: number): string => String(n).padStart(2, "0");
  const name = `${t.getFullYear()}${d2(t.getMonth() + 1)}${d2(t.getDate())}_${d2(t.getHours())}${d2(t.getMinutes())}${d2(t.getSeconds())}.jpg`;
  const shot = new OffscreenCanvas(view.width, view.height);
  shot.getContext("2d")!.drawImage(view, 0, 0);
  const blob = await shot.convertToBlob({ type: "image/jpeg", quality: 0x5a / 100 });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
}

/** UIText STR# 0xa1 (161): the hotkeys, one per entry, localized. */
const STR_HOTKEYS = 0xa1;

/**
 * cDDDSimsView+0x11d0 (Windows 004d0c4d, Mac cDDDSimsView::Init): the
 * localized hotkey -> US hotkey pairs of STR# 0xa1, entries 1..0x14 and
 * 0x1a..0x1c (1-based) whose first character differs (French: 'z' -> '~',
 * 'o' -> 'y').
 */
let hotkeyMap: Array<[string, string]> | null = null;

function remapHotkey(strings: Strings, ch: string): string {
  if (!hotkeyMap) {
    hotkeyMap = [];
    for (let i = 1; i <= strings.list("UIText", STR_HOTKEYS).length; i++) {
      if ((i >= 0x15 && i <= 0x19) || i >= 0x1d) continue;
      const ours = strings.get("UIText", STR_HOTKEYS, i - 1);
      const us = strings.getUS("UIText", STR_HOTKEYS, i - 1);
      if (ours && us && ours[0] !== us[0]) hotkeyMap.push([ours[0]!, us[0]!]);
    }
  }
  return hotkeyMap.find(([from]) => from === ch)?.[1] ?? ch;
}

/**
 * cDDDSimsView::TSOnCharacter (Windows 004d108f), the characters handled
 * before the current tool's OnChar. `ch` is remapped through the hotkey table
 * first; returns the remapped character in `rest` for {@link characterAfterTool}.
 *  - '+' '=' zoom in, '-' '_' zoom out (CPState::ZoomIn / ZoomOut);
 *  - '1' '2' '3' press the speed buttons (cWinViewControl::SpoofSpeedChange);
 *  - '`' 'p' '~' press pause, unless a taxi splash is up (cSimsApp+0x7c);
 *  - 'x' / 'z' turn the build (mode 0) or buy (mode 1) catalog's page.
 * Top row and numpad digits both give the characters (WM_CHAR); there is no
 * '0' key.
 */
export function characterBeforeTool(state: CPState, strings: Strings, cpanel: WinCPanel | null, key: string): { done: boolean; ch: string } {
  if (key.length !== 1) return { done: false, ch: key };
  const ch = remapHotkey(strings, key);
  const vc = cpanel?.viewControl;
  switch (ch) {
    case "+":
    case "=":
      state.zoomIn();
      return { done: true, ch };
    case "-":
    case "_":
      state.zoomOut();
      return { done: true, ch };
    case "1":
    case "2":
    case "3":
      vc?.spoofSpeedChange(Number(ch));
      return { done: true, ch };
    case "`":
    case "p":
    case "~":
      if (!currentTaxiDialog()) vc?.spoofSpeedChange(0);
      return { done: true, ch };
    case "x":
      if (state.getMode() === Mode.Build) cpanel?.arch.pageRight();
      else if (state.getMode() === Mode.Buy) cpanel?.catalog.pageRight();
      return { done: true, ch };
    case "z":
      if (state.getMode() === Mode.Build) cpanel?.arch.pageLeft();
      else if (state.getMode() === Mode.Buy) cpanel?.catalog.pageLeft();
      return { done: true, ch };
    default:
      return { done: false, ch };
  }
}

/** UIText STR# 0x9a (154), 1-based: 0xb the product name, 0xc "Version". */
const STR_VERSION = 0x9a;
/** Windows 006c7b70: the build date (__DATE__ ", " __TIME__). */
const BUILD_DATE = "Sep 25 2003, 14:23:46";

/**
 * cDDDSimsView::TSOnCharacter after the tool's OnChar: ',' '<' rotate left,
 * '.' '>' rotate right, 'v' the version box: STR# 0x9a 0xb, "\n" and the build
 * date, titled STR# 0x9a 0xc ("Build Version" when the set is missing), OK
 * only. ('q' quit, 's' the shadow flag and 't' the frame rate window are not
 * ported.)
 */
export function characterAfterTool(ctx: GameContext, ch: string): boolean {
  const state = ctx.state;
  switch (ch) {
    case "v": {
      const name = ctx.strings.get("UIText", STR_VERSION, 0xb - 1);
      const title = ctx.strings.get("UIText", STR_VERSION, 0xc - 1) || "Build Version";
      void TSWinMsgBox.show(ctx, (name ? `${name}\n` : "") + BUILD_DATE, title);
      return true;
    }
    case ",":
    case "<":
      state.rotateLeft();
      return true;
    case ".":
    case ">":
      state.rotateRight();
      return true;
    default:
      return false;
  }
}
