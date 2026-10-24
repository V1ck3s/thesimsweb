/**
 * Entry point of the faithful client. Follows cSimsApp: splash screen while
 * the services load (Init), then the neighborhood screen (DoNbhdScreen), then
 * the lot with its control panel when a house is picked.
 *
 * `game.html?test=<name>` mounts a dev test from src/game/dev/tests/<name>.ts
 * instead (each exports `mount(ctx, mgr)`).
 */

import { CPState, DIRTY_ALL, Mode } from "./cpstate.js";
import type { GameContext } from "./context.js";
import { CPANEL_HEIGHT, WinCPanel } from "./cpanel/cpanel.js";
import { activateFamily } from "./data/family.js";
import { loadNeighborhood } from "./data/neighborhood.js";
import { Neighborhood } from "./nbhd/nghinterface.js";
import { WinNeighborhoodUL } from "./nbhd/winneighborhoodul.js";
import { Fonts } from "./res/fonts.js";
import { Strings } from "./res/strings.js";
import { UIRes } from "./res/uires.js";
import { TSWinSplashScreen } from "./screens/splash.js";
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

class Game {
  private nbhdDir = "UserData";

  constructor(
    private readonly ctx: GameContext,
    private readonly mgr: WinMgr,
  ) {}

  /** cSimsApp::DoNbhdScreen */
  async showNeighborhood(): Promise<void> {
    const { ctx, mgr } = this;
    const nb = await Neighborhood.load(this.nbhdDir);
    const screen: WinNeighborhoodUL = new WinNeighborhoodUL(ctx, nb, {
      onEnterLot: (house) => {
        mgr.main.childDelete(screen);
        void this.enterLot(house);
      },
      onEndModal: (result) => console.log(`neighborhood screen ended: ${result}`),
      onSwitchNeighborhood: (next) => {
        this.nbhdDir = next;
        mgr.main.childDelete(screen);
        void this.showNeighborhood();
      },
      onUnported: (what) => console.log(`not ported: ${what}`),
    });
    screen.setArea(0, 0, ctx.width, ctx.height);
    if (!(await screen.init())) throw new Error("neighborhood init failed");
    mgr.main.childAdd(screen);
  }

  /** Neighborhood::LoadHouse + cSimsApp control panel setup. */
  async enterLot(house: number): Promise<void> {
    const { ctx, mgr } = this;
    const state = ctx.state;
    await activateFamily(state, await loadNeighborhood(this.nbhdDir), house);
    const view = new LotView();
    view.setArea(0, 0, ctx.width, ctx.height);
    const cpanel = new WinCPanel(ctx);
    cpanel.setArea(0, ctx.height - CPANEL_HEIGHT, ctx.width, ctx.height);
    if (!(await cpanel.init())) throw new Error("control panel init failed");
    view.childAdd(cpanel);
    cpanel.postInit();
    mgr.main.childAdd(view);
    // The original starts collapsed (SetCPMode(1)) during init and opens the
    // panel in the lot; refresh everything once the windows listen.
    state.setMode(state.family.length ? Mode.Live : Mode.Buy, true);
    state.setCPMode(0);
    state.setSelectedPerson(0);
    state.dirty = DIRTY_ALL;
  }
}

async function boot(): Promise<void> {
  const mgr = new WinMgr(document.getElementById("screen")!, SCREEN_W, SCREEN_H);
  const ctx = await createContext();
  const tick = (): void => {
    ctx.state.update();
    requestAnimationFrame(tick);
  };
  tick();
  mgr.start();
  const test = new URLSearchParams(location.search).get("test");
  if (test) {
    const tests = import.meta.glob<{ mount: TestMount }>("./dev/tests/*.ts");
    const load = tests[`./dev/tests/${test}.ts`];
    if (!load) throw new Error(`no test "${test}"`);
    await (await load()).mount(ctx, mgr);
    return;
  }
  const splash = new TSWinSplashScreen(ctx);
  await splash.init();
  mgr.main.childAdd(splash);
  for (const stage of ["stap", "regr", "ctrl", "grph", "main", "cpnl", "char", "ocns"] as const) {
    splash.setSplashMessage(stage);
  }
  const game = new Game(ctx, mgr);
  await splash.finished();
  mgr.main.childDelete(splash);
  await game.showNeighborhood();
}

boot().then(
  () => console.log("boot ok"),
  (e: unknown) => console.error("boot failed", e),
);
