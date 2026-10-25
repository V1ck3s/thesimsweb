/**
 * Test page for WinOptions and WinCamPanel: mounts the full control panel like
 * the game shell does, in Options mode, with logging GameHooks.
 *
 * Keys: O options mode, C camera mode, X custom snapshot size (520x340),
 * D toggle "save disabled".
 */

import { CPANEL_HEIGHT, WinCPanel } from "../../cpanel/cpanel.js";
import { DIRTY_ALL, Mode } from "../../cpstate.js";
import type { GameContext } from "../../context.js";
import { TSWin } from "../../ui/tswin.js";
import type { WinMgr } from "../../ui/winmgr.js";

export async function mount(ctx: GameContext, mgr: WinMgr): Promise<void> {
  const log = (what: string) => (): void => console.log(`hook: ${what}`);
  ctx.hooks = {
    isLotDirty: () => true,
    saveGame: log("saveGame"),
    doSave: async () => {
      console.log("hook: doSave");
      return true;
    },
    showNeighborhood: log("showNeighborhood"),
    quit: () => {
      console.log("hook: quit");
      return false;
    },
    resetTutorial: log("resetTutorial"),
    showScrapbook: async () => console.log("hook: showScrapbook"),
  };

  const view = new TSWin();
  view.setArea(0, 0, ctx.width, ctx.height);
  mgr.main.childAdd(view);
  const cpanel = new WinCPanel(ctx);
  cpanel.setArea(0, ctx.height - CPANEL_HEIGHT, ctx.width, ctx.height);
  if (!(await cpanel.init())) throw new Error("control panel init failed");
  view.childAdd(cpanel);
  cpanel.postInit();

  const s = ctx.state;
  s.dirty = DIRTY_ALL;
  s.setCPMode(0);
  s.setTime(0, 9 * 60);
  s.setFunds(20000);
  s.houseNumber = 1;
  s.setMode(Mode.Options, true);

  window.addEventListener("keydown", (e) => {
    if (e.key === "o") s.setMode(Mode.Options);
    if (e.key === "c") s.setMode(Mode.Camera);
    if (e.key === "x") s.camSetCustomSize(520, 340);
    if (e.key === "d") s.disableSave(!s.isSaveDisabled());
  });
}
