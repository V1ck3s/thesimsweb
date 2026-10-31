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

import { CatalogSort, type CPState, Mode } from "../cpstate.js";
import { currentTaxiDialog } from "../nbhd/winpicturesplashdialog.js";
import type { Strings } from "../res/strings.js";
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

/**
 * cDDDSimsView::TSOnCharacter after the tool's OnChar: ',' '<' rotate left,
 * '.' '>' rotate right. ('q' quit, 's' shadows, 't' frame rate and 'v'
 * version are not ported.)
 */
export function characterAfterTool(state: CPState, ch: string): boolean {
  switch (ch) {
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
