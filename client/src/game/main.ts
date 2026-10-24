/**
 * Entry point of the faithful client: boots the window manager at the game's
 * resolution, loads the shared services and mounts the game shell.
 *
 * `game.html?test=<name>` mounts a dev test from src/game/dev/tests/<name>.ts
 * instead (each exports `mount(ctx, mgr)`).
 */

import { CPState } from "./cpstate.js";
import type { GameContext } from "./context.js";
import { CPANEL_HEIGHT, WinCPanel } from "./cpanel/cpanel.js";
import { Fonts } from "./res/fonts.js";
import { Strings } from "./res/strings.js";
import { UIRes } from "./res/uires.js";
import { TSWin } from "./ui/tswin.js";
import { WinMgr } from "./ui/winmgr.js";

const SCREEN_W = 1024;
const SCREEN_H = 768;

export type TestMount = (ctx: GameContext, mgr: WinMgr) => Promise<void>;

async function createContext(): Promise<GameContext> {
  const strings = new Strings();
  await Promise.all(["GameData/UIText.iff", "GameData/Live.iff", "GameData/Build.iff"].map((p) => strings.load(p)));
  return {
    res: await UIRes.load(),
    fonts: new Fonts(),
    strings,
    state: new CPState(),
    width: SCREEN_W,
    height: SCREEN_H,
  };
}

/** Lot view placeholder (cDDDSimsView): full screen, hosts the control panel. */
class LotView extends TSWin {}

async function mountGame(ctx: GameContext, mgr: WinMgr): Promise<void> {
  const view = new LotView();
  view.setArea(0, 0, ctx.width, ctx.height);
  mgr.main.childAdd(view);
  const cpanel = new WinCPanel(ctx);
  cpanel.setArea(0, ctx.height - CPANEL_HEIGHT, ctx.width, ctx.height);
  if (!(await cpanel.init())) throw new Error("control panel init failed");
  view.childAdd(cpanel);
  cpanel.postInit();
}

async function boot(): Promise<void> {
  const mgr = new WinMgr(document.getElementById("screen")!, SCREEN_W, SCREEN_H);
  const ctx = await createContext();
  const test = new URLSearchParams(location.search).get("test");
  if (test) {
    const tests = import.meta.glob<{ mount: TestMount }>("./dev/tests/*.ts");
    const load = tests[`./dev/tests/${test}.ts`];
    if (!load) throw new Error(`no test "${test}"`);
    await (await load()).mount(ctx, mgr);
  } else {
    await mountGame(ctx, mgr);
  }
  const tick = (): void => {
    ctx.state.update();
    requestAnimationFrame(tick);
  };
  tick();
  mgr.start();
}

boot().then(
  () => console.log("boot ok"),
  (e: unknown) => console.error("boot failed", e),
);
