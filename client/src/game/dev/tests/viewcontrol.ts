/**
 * Test page for WinViewControl: mounts the full control panel like the game
 * shell does, with the panel expanded (CPMode 0), a running clock and funds
 * that change every few seconds to show the funds flash.
 */

import { CPANEL_HEIGHT, WinCPanel } from "../../cpanel/cpanel.js";
import { DIRTY_ALL } from "../../cpstate.js";
import type { GameContext } from "../../context.js";
import { TSWin } from "../../ui/tswin.js";
import type { WinMgr } from "../../ui/winmgr.js";

export async function mount(ctx: GameContext, mgr: WinMgr): Promise<void> {
  const view = new TSWin();
  view.setArea(0, 0, ctx.width, ctx.height);
  mgr.main.childAdd(view);
  const cpanel = new WinCPanel(ctx);
  cpanel.setArea(0, ctx.height - CPANEL_HEIGHT, ctx.width, ctx.height);
  if (!(await cpanel.init())) throw new Error("control panel init failed");
  view.childAdd(cpanel);
  cpanel.postInit();

  const s = ctx.state;
  // main.ts starts the CPState tick before mounting: request a full refresh.
  s.dirty = DIRTY_ALL;
  s.setCPMode(0);
  s.setTime(0, 13 * 60 + 32);
  s.setFunds(9144);
  s.familyFriendCount = 3;
  let minutes = 13 * 60 + 32;
  setInterval(() => {
    if (s.isPaused()) return;
    minutes = (minutes + s.getSpeed()) % (24 * 60);
    s.setTime(0, minutes);
  }, 1000);
  setInterval(() => s.setFunds(s.getFunds() + 125), 4000);
  // F: spend money now (to watch the funds flash).
  window.addEventListener("keydown", (e) => {
    if (e.key === "f") s.setFunds(s.getFunds() - 500);
  });
}
