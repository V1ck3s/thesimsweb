/**
 * Entry point of the faithful client: boots the window manager at the game's
 * resolution, loads the shared services and mounts the game shell.
 *
 * `game.html?test=<name>` mounts a dev test from src/game/dev/tests/<name>.ts
 * instead (each exports `mount(ctx, mgr)`).
 */

import { CPState, DIRTY_ALL } from "./cpstate.js";
import type { GameContext } from "./context.js";
import { CPANEL_HEIGHT, WinCPanel } from "./cpanel/cpanel.js";
import { familyInHouse, loadCharacter, loadNeighborhood, neighborByGuid, PD } from "./data/neighborhood.js";
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

/** Fill CPState with the family living in `houseNumber` (Neighborhood::GetFamilyInHouse). */
async function loadFamily(ctx: GameContext, houseNumber: number): Promise<void> {
  const nbhd = await loadNeighborhood();
  const family = familyInHouse(nbhd, houseNumber);
  if (!family) return;
  const state = ctx.state;
  state.familyName = family.name;
  state.setFunds(family.budget);
  state.family = [];
  for (const guid of family.memberGuids) {
    const nb = neighborByGuid(nbhd, guid);
    if (!nb?.personData) continue;
    const pd = nb.personData;
    const ch = await loadCharacter(nbhd.dir, nb.name);
    state.family.push({
      id: nb.id,
      firstName: ch.firstName,
      lastName: family.name,
      motives: [],
      skills: [PD.cookingSkill, PD.mechanicalSkill, PD.charismaSkill, PD.bodySkill, PD.logicSkill, PD.creativitySkill].map(
        (i) => pd[i] ?? 0,
      ),
      personality: [PD.neatPersonality, PD.outgoingPersonality, PD.activePersonality, PD.playfulPersonality, PD.nicePersonality].map(
        (i) => pd[i] ?? 0,
      ),
      isChild: (pd[PD.personAge] ?? 27) < 18,
      isFemale: pd[PD.gender] === 1,
    });
  }
}

async function mountGame(ctx: GameContext, mgr: WinMgr, splash: TSWinSplashScreen): Promise<void> {
  splash.setSplashMessage("char");
  await loadFamily(ctx, 1);
  splash.setSplashMessage("main");
  const view = new LotView();
  view.setArea(0, 0, ctx.width, ctx.height);
  splash.setSplashMessage("cpnl");
  const cpanel = new WinCPanel(ctx);
  cpanel.setArea(0, ctx.height - CPANEL_HEIGHT, ctx.width, ctx.height);
  if (!(await cpanel.init())) throw new Error("control panel init failed");
  view.childAdd(cpanel);
  cpanel.postInit();
  // The original starts collapsed (SetCPMode(1)) during init and the panel opens
  // when the lot is entered; refresh everything once the windows listen.
  ctx.state.setCPMode(0);
  ctx.state.dirty = DIRTY_ALL;
  splash.setSplashMessage("ocns");
  await splash.finished();
  mgr.main.childRemove(splash);
  mgr.main.childAdd(view);
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
  } else {
    const splash = new TSWinSplashScreen(ctx);
    await splash.init();
    mgr.main.childAdd(splash);
    splash.setSplashMessage("stap");
    splash.setSplashMessage("regr");
    splash.setSplashMessage("ctrl");
    splash.setSplashMessage("grph");
    await mountGame(ctx, mgr, splash);
  }
}

boot().then(
  () => console.log("boot ok"),
  (e: unknown) => console.error("boot failed", e),
);
