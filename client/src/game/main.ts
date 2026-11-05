/**
 * Entry point of the faithful client. Follows cSimsApp: splash screen while
 * the services load (Init), then the neighborhood screen (DoNbhdScreen), then
 * the lot with its control panel when a house is picked.
 *
 * `game.html?house=N` skips the neighborhood screen and enters house N.
 * `game.html?test=<name>` mounts a dev test from src/game/dev/tests/<name>.ts
 * instead (each exports `mount(ctx, mgr)`).
 */

import { modeMusicEvent, soundPlayer, UI_SOURCE } from "./audio/index.js";
import { installLotAudio } from "./audio/lotaudio.js";
import { resetSaveFileCache } from "../engine/assets.js";
import { getSaveMode, requestPersistentStorage } from "../engine/saves.js";
import { CPState, DIRTY_ALL, Mode } from "./cpstate.js";
import type { GameContext } from "./context.js";
import { CPANEL_HEIGHT, WinCPanel } from "./cpanel/cpanel.js";
import { activateFamily } from "./data/family.js";
import { NeighborhoodStore, setLiveNeighborhood } from "./data/nbhdstore.js";
import { loadNeighborhood } from "./data/neighborhood.js";
import { currentNeighborhoodDir, Neighborhood, storeCurrentNeighborhoodDir, Zone } from "./nbhd/nghinterface.js";
import { saveDowntownDescription } from "./nbhd/wineditdtlotdesc.js";
import { getOptionsMgr } from "./optionsmgr.js";
import { NBHD_DOWNTOWN, NBHD_END_NOTES, NBHD_MAGICTOWN, NBHD_STUDIOTOWN, NBHD_VACATION, WinNeighborhoodUL } from "./nbhd/winneighborhoodul.js";
import { applyLoadGameLocation, arrivalFor, type ChangeLotTrigger, holdSimulator, type LotArrival, prepareArrival, Transit } from "./nbhd/transit.js";
import { objectDialogHooks } from "./world/objectdialogshow.js";
import { currentTaxiDialog } from "./nbhd/winpicturesplashdialog.js";
import { Town, WinTown } from "./nbhd/wintown.js";
import { Fonts } from "./res/fonts.js";
import { Strings } from "./res/strings.js";
import { UIRes } from "./res/uires.js";
import { whileFrozen } from "./screens/frozen.js";
import { G } from "./sim/simulator.js";
import { TSWinSplashScreen } from "./screens/splash.js";
import { loadCursors } from "./ui/cursor.js";
import { DefaultTTWindow } from "./ui/ttwindow.js";
import { WinMgr } from "./ui/winmgr.js";
import { ObjectFolder } from "./world/objectfolder.js";
import { WinLotView } from "./world/winlotview.js";
import { doSave, isLotDirty, markLotClean, saveGame } from "./world/savegame.js";
import { moveOutHouse } from "./world/moveout.js";
import { installCheatConsole } from "./ui/cheat.js";
import { firstRunTutorial, resetTutorial } from "./nbhd/tutorial.js";

const SCREEN_W = 1024;
const SCREEN_H = 768;

/**
 * cSimsApp::LoadGame's PlaySoundA after a successful load: the outdoor
 * ambience of the lot (kSetAmbienceMode: cBoxX switches its fresh player,
 * audio/fresh.ts).
 */
function lotAmbience(house: number): string {
  if (house - 0x1c >= 0 && house - 0x1c < 2) return "setambience_beach";
  if (house > 0x2d && house < 0x31) return "setambience_beach";
  if ((house >= 0x15 && house <= 0x1e) || (house >= 0x2b && house <= 0x2d)) return "setambience_park";
  if (house >= 0x5a && house <= 0x5c) return "setambience_magictown";
  return "setambience_backyard";
}

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

class Game {
  /** `?nbhd=UserData3` (dev): start in another neighborhood. */
  private nbhdDir = new URLSearchParams(location.search).get("nbhd") ?? currentNeighborhoodDir();
  private nbhd: Neighborhood | null = null;
  lotView: WinLotView | null = null;
  /** Mode whose music plays (null outside a lot). */
  private musicMode: Mode | null = null;
  /** Whether the sounds were last paused (CPState::UpdateWorldFromCPState's PauseSounds / ResumeSounds). */
  private soundsPaused: boolean | null = null;
  /** Teardown of audio/lotaudio.ts for the loaded lot. */
  private lotAudioOff: (() => void) | null = null;
  /** cSimsApp +0x108..+0x10a for the next LoadGame (set by switchLots). */
  private arrival: LotArrival | null = null;

  constructor(
    private readonly ctx: GameContext,
    private readonly mgr: WinMgr,
  ) {
    // The mode music follows CPState (cSimsApp::UpdateWorldFromCPState).
    ctx.state.onChange((st) => {
      if (!this.lotView) return;
      // Sounds run in live mode while not paused (mode change, or the pause button in live mode).
      const modeChanged = st.getMode() !== this.musicMode;
      const pause = st.getMode() !== Mode.Live || st.isPaused();
      if (modeChanged || (st.getMode() === Mode.Live && pause !== this.soundsPaused)) {
        this.soundsPaused = pause;
        if (pause) soundPlayer.pauseSounds();
        else soundPlayer.resumeSounds();
      }
      if (!modeChanged) return;
      // CPState::SetMode dirties the zoom too: HouseViewer::SetScale then NotifyViewChange, before the music.
      soundPlayer.notifyViewChange();
      this.musicMode = st.getMode();
      soundPlayer.quietBySourceID(-1);
      const house = this.lotView.sim?.globals[G.houseNumber] ?? 0;
      const music = modeMusicEvent(this.musicMode, {
        house,
        visiting: this.lotView.sim?.globals[G.freeFunds] === 1,
        community: this.nbhd?.getZoningType(house) === Zone.Community,
      });
      if (music) soundPlayer.playBySource(music, -1);
    });
    const blockReleases: Array<() => void> = [];
    ctx.hooks = {
      isLotDirty: () => isLotDirty(this.lotView),
      saveGame: async () => {
        await saveGame(ctx, this.lotView, this.nbhdDir);
      },
      doSave: () => doSave(ctx, this.lotView, this.nbhdDir),
      saveDowntownDescription: (prompt) => {
        const sim = this.lotView?.sim;
        const house = sim?.globals[G.houseNumber] ?? 0;
        const zoning = this.nbhd?.getZoningType(house) ?? Zone.None;
        return saveDowntownDescription(ctx, { visiting: sim?.globals[G.freeFunds] === 1, house, nbhdDir: this.nbhdDir, zoning }, prompt);
      },
      neighborhoodDir: () => this.nbhdDir,
      // cDDDSimsView::SetBlockSimulator: nested holds through holdSimulator's reference count.
      setBlockSimulator: (block) => {
        if (block) {
          const sim = this.lotView?.sim;
          if (sim) blockReleases.push(holdSimulator(sim));
        } else {
          blockReleases.pop()?.();
        }
      },
      // cSimsApp::ResetTutorial: Tutorial.FAM back into the import folder, then the neighborhood screen.
      resetTutorial: () => {
        void resetTutorial(ctx, this.nbhdDir, () => doSave(ctx, this.lotView, this.nbhdDir), () => ctx.hooks?.showNeighborhood?.());
      },
      // cSimsApp::ShowNbhdDialog: the lot is unloaded and the neighborhood
      // screen built while the last lot frame stays up (screens/frozen.ts).
      showNeighborhood: () => {
        void whileFrozen(mgr, false, async () => {
          this.leaveLot();
          await this.showNeighborhood();
        });
      },
    };
  }

  private leaveLot(): void {
    if (!this.lotView) return;
    // UnloadHouse: the next Neighborhood::Save no longer takes the lot's live data.
    setLiveNeighborhood(null);
    this.mgr.main.childDelete(this.lotView);
    this.lotAudioOff?.();
    this.lotAudioOff = null;
    this.lotView = null;
    this.musicMode = null;
    this.soundsPaused = null;
  }

  /** cSimsApp::DoNbhdScreen */
  async showNeighborhood(): Promise<void> {
    const { ctx, mgr } = this;
    // A new load: the save files are read again, once each (engine/assets.ts).
    resetSaveFileCache();
    // The installer's Tutorial.FAM, imported by the screen's CheckForNewImports (first run only).
    await firstRunTutorial(this.nbhdDir);
    const nb = await Neighborhood.load(this.nbhdDir);
    this.nbhd = nb;
    const screen: WinNeighborhoodUL = new WinNeighborhoodUL(ctx, nb, {
      // cSimsApp::LoadGame runs under the neighborhood screen (frozen, hourglass).
      onEnterLot: (house) => {
        void whileFrozen(mgr, true, async () => {
          await this.enterLot(house);
          mgr.main.childDelete(screen);
        });
      },
      onEndModal: (result) => {
        // cSimsApp::ShowNbhdDialog -> ShowDowntownDialog / ShowVacationDialog / ShowStudiotownDialog / ShowMagictownDialog.
        const towns: Readonly<Record<number, Town>> = {
          [NBHD_DOWNTOWN]: Town.Downtown,
          [NBHD_VACATION]: Town.Vacation,
          [NBHD_STUDIOTOWN]: Town.Studiotown,
          [NBHD_MAGICTOWN]: Town.Magictown,
        };
        const town = towns[result];
        if (town === undefined) {
          console.log(`not ported: ${NBHD_END_NOTES[result] ?? `neighborhood screen ended with ${result}`}`);
          return;
        }
        void whileFrozen(mgr, false, async () => {
          mgr.main.childDelete(screen);
          await this.showTown(town);
        });
      },
      onSwitchNeighborhood: (next) => {
        this.nbhdDir = next;
        storeCurrentNeighborhoodDir(next);
        void whileFrozen(mgr, false, async () => {
          mgr.main.childDelete(screen);
          await this.showNeighborhood();
        });
      },
      onUnported: (what) => console.log(`not ported: ${what}`),
      onMoveIn: (house, family, value) => {
        void whileFrozen(mgr, true, async () => {
          await this.moveIn(house, family, value);
          mgr.main.childDelete(screen);
        });
      },
      onMoveOutHouse: (house, bulldoze, store) => moveOutHouse(ctx, store, house, bulldoze),
    });
    screen.setArea(0, 0, ctx.width, ctx.height);
    if (!(await screen.init())) throw new Error("neighborhood init failed");
    mgr.main.childAdd(screen);
  }

  /** cSimsApp::ShowDowntownDialog (and the other towns): the town screen; -20 goes back to DoNbhdScreen, a house loads it. */
  async showTown(town: Town): Promise<void> {
    const { ctx, mgr } = this;
    resetSaveFileCache();
    const nb = this.nbhd ?? (await Neighborhood.load(this.nbhdDir));
    this.nbhd = nb;
    const screen: WinTown = new WinTown(ctx, nb, town, true, {
      onEnd: (result) => {
        if (result > 0) {
          void whileFrozen(mgr, true, async () => {
            await this.enterLot(result);
            mgr.main.childDelete(screen);
          });
        } else {
          void whileFrozen(mgr, false, async () => {
            mgr.main.childDelete(screen);
            await this.showNeighborhood();
          });
        }
      },
      onUnported: (what) => console.log(`not ported: ${what}`),
      onMoveOutHouse: (house, bulldoze, store) => moveOutHouse(ctx, store, house, bulldoze),
      // cWinMagicland::MoveInModeLotHandler: LoadGame(house, family) under the frozen screen.
      onMoveIn: (house, family, value) =>
        whileFrozen(mgr, true, async () => {
          await this.moveIn(house, family, value);
          mgr.main.childDelete(screen);
        }).then(() => true),
    });
    screen.setArea(0, 0, ctx.width, ctx.height);
    if (!(await screen.init())) throw new Error("town screen init failed");
    mgr.main.childAdd(screen);
  }

  /**
   * cSimsApp::SwitchLots (the change-lot trigger of cXPerson::TryChangeLots):
   * SaveGame, the arrival flags, UnloadHouse, LoadGame(house). The taxi
   * splash stays up over the next lot until generic sim call 3 removes it.
   */
  switchLots(trigger: ChangeLotTrigger): void {
    const { ctx, mgr } = this;
    void whileFrozen(mgr, true, async () => {
      await saveGame(ctx, this.lotView, this.nbhdDir);
      const nb = this.nbhd ?? (await Neighborhood.load(this.nbhdDir));
      this.arrival = arrivalFor(trigger, nb.getZoningType(trigger.house));
      const taxi = currentTaxiDialog();
      taxi?.parent?.childRemove(taxi);
      this.leaveLot();
      await this.enterLot(trigger.house);
      if (taxi && this.lotView) {
        this.lotView.childAdd(taxi);
        taxi.layout(this.lotView);
      }
    });
  }

  /** cSimsApp::LoadGame(house, family): Neighborhood::LoadHouse moves the family in first. */
  async moveIn(house: number, family: number, houseValue: number): Promise<void> {
    const store = await NeighborhoodStore.open(this.nbhdDir);
    store.setFamilyHouse(family, house, houseValue);
    // LoadHouse reads and clears the move-in bit before anything is saved.
    const moving = store.takeMoveInFlag(family);
    await store.save();
    await this.enterLot(house, moving ? family : 0);
  }

  /** Neighborhood::LoadHouse + cSimsApp control panel setup (`moveInFamily`: the family just moved in). */
  async enterLot(house: number, moveInFamily = 0): Promise<void> {
    const { ctx, mgr } = this;
    const state = ctx.state;
    resetSaveFileCache();
    const arrival = this.arrival;
    this.arrival = null;
    if (!(await prepareArrival(ctx, this.nbhdDir, arrival)) && !(await activateFamily(state, await loadNeighborhood(this.nbhdDir), house))) {
      // Nobody lives here (Neighborhood::LoadHouse leaves PersonFinder empty).
      state.family = [];
      state.familyName = "";
    }
    // Neighborhood::LoadHouse reads the neighborhood as it is now (a family may just have moved in).
    this.nbhd = await Neighborhood.load(this.nbhdDir);
    const view = new WinLotView(ctx, this.nbhd.getHousePath(house));
    // LoadGame: the members arriving (+0x108 / +0x109 / +0x10a) come through PersonFinder::CreateDowntownSim.
    view.arrivalOutOfWorld = !!(arrival && (arrival.member || arrival.family || arrival.studioMember));
    // Neighborhood::LoadHouse: the move in's clock and "reset lot" (WinLotView.resetLotForMoveIn).
    if (moveInFamily) view.moveIn = { family: moveInFamily, house };
    view.setArea(0, 0, ctx.width, ctx.height);
    const t0 = performance.now();
    if (!(await view.init())) throw new Error("lot view init failed");
    console.log(`lot ${house} loaded in ${Math.round(performance.now() - t0)} ms`);
    if (view.sim) {
      const nb = this.nbhd;
      view.sim.module.transitHooks = new Transit(
        { ctx, nb: () => nb, lotView: () => this.lotView, switchLots: (t) => this.switchLots(t) },
        view.sim,
      );
      view.sim.module.dialogHooks = objectDialogHooks(ctx, view.sim, view);
    }
    await applyLoadGameLocation(ctx, view, this.nbhd, house, arrival);
    state.houseNumber = house;
    this.lotAudioOff = installLotAudio(view);
    soundPlayer.playBySource(lotAmbience(house), UI_SOURCE);
    this.lotView = view;
    markLotClean(view);
    const cpanel = new WinCPanel(ctx);
    cpanel.setArea(0, ctx.height - CPANEL_HEIGHT, ctx.width, ctx.height);
    if (!(await cpanel.init())) throw new Error("control panel init failed");
    view.childAdd(cpanel);
    cpanel.postInit();
    mgr.main.childAdd(view);
    // cSimsApp: the game view takes the focus once the lot is loaded (the arrows, F1..F5, Space).
    mgr.offerFocus(view);
    // The original starts collapsed (SetCPMode(1)) during init and opens the
    // panel in the lot; refresh everything once the windows listen.
    state.setMode(state.family.length ? Mode.Live : Mode.Buy, true);
    state.setCPMode(0);
    state.setSelectedPerson(0);
    view.centerOnPerson(state.family[0]?.guid);
    state.dirty = DIRTY_ALL;
  }
}

async function boot(): Promise<void> {
  const mgr = new WinMgr(document.getElementById("screen")!, SCREEN_W, SCREEN_H);
  const ctx = await createContext();
  // Saves kept in this browser (SAVES=client): ask the browser not to evict them.
  if ((await getSaveMode()) === "client") void requestPersistentStorage();
  // cSimsApp::SetupWinCtrlMgr: the cursor files (UIGraphics/shared/cursors).
  await loadCursors();
  mgr.setDefaultTTWindow(await DefaultTTWindow.create(ctx.fonts));
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
  // cSimsApp::Init: the sound player, then the load loop under the splash
  // (audio starts with the first click or key: browser autoplay rules).
  await soundPlayer.initialize(getOptionsMgr());
  void soundPlayer.startLoadMusic(getOptionsMgr());
  const splash = new TSWinSplashScreen(ctx);
  await splash.init();
  mgr.main.childAdd(splash);
  for (const stage of ["stap", "regr", "ctrl", "grph", "main", "cpnl", "char"] as const) {
    splash.setSplashMessage(stage);
  }
  // "ocns": the object folder scan (ObjectFolder::ScanForNewFiles) runs under
  // the splash screen; the first run indexes every object file (cached after).
  splash.setSplashMessage("ocns");
  await ObjectFolder.get("UserData");
  const game = new Game(ctx, mgr);
  // cOptionsMgr::GetQuickTips reads the lot's simulator (tutorial house global).
  getOptionsMgr().simulatorGlobals = () => game.lotView?.sim?.globals ?? null;
  // cSimsApp::Init: RegisterCheats and the cheat widget (the shipped builds
  // restrict the cheats, IsFinalShip; `?devcheats` lifts it for development).
  await installCheatConsole(ctx, { lotView: () => game.lotView }, !new URLSearchParams(location.search).has("devcheats"));
  // Dev handle for the screenshot tooling (`eval:game.lotView...`).
  (window as unknown as { game: Game }).game = game;
  (window as unknown as { soundPlayer: typeof soundPlayer }).soundPlayer = soundPlayer;
  await splash.finished();
  mgr.main.childDelete(splash);
  soundPlayer.stopLoadMusic();
  // `?house=N` (dev): straight into a lot of the default neighborhood.
  const house = Number(new URLSearchParams(location.search).get("house"));
  if (house > 0) await game.enterLot(house);
  else await game.showNeighborhood();
}

// Offline support (engine/pwa.ts: production builds only).
void import("../engine/pwa.js").then((m) => m.registerServiceWorker());
boot().then(
  () => console.log("boot ok"),
  (e: unknown) => console.error("boot failed", e),
);
