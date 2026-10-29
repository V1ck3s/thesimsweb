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
import { winMgr } from "../ui/winmgr.js";

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
