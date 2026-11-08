/**
 * Entry point of the faithful client. Follows cSimsApp: splash screen while
 * the services load (Init), then the neighborhood screen (DoNbhdScreen), then
 * the lot with its control panel when a house is picked.
 *
 * `game.html?house=N` skips the neighborhood screen and enters house N.
 * `game.html?test=<name>` mounts a dev test from src/game/dev/tests/<name>.ts
 * instead (each exports `mount(ctx, mgr)`).
 */

import { characterHooks } from "./nbhd/makecharacter.js";
import { installImeComposition } from "./ui/imecomposition.js";
import { modeMusicEvent, soundPlayer, UI_SOURCE } from "./audio/index.js";
import { installLotAudio } from "./audio/lotaudio.js";
import { resetSaveFileCache } from "../engine/assets.js";
import { hudBand, readCentredHud, readFullscreen, readResolution, screenSize, storeFullscreen } from "../engine/display.js";
import { holdsScreenSize, resizeTopLevel } from "./ui/screenresize.js";
import { getSaveMode, requestPersistentStorage } from "../engine/saves.js";
import { isGameFilesLocal, localGameIndex } from "../engine/gamefiles.js";
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
import { loadGlobalConstants } from "./sim/simmodule.js";
import { currentTaxiDialog } from "./nbhd/winpicturesplashdialog.js";
import { Town, WinTown } from "./nbhd/wintown.js";
import { Fonts } from "./res/fonts.js";
import { Strings } from "./res/strings.js";
import { UIRes } from "./res/uires.js";
import { whileFrozen } from "./screens/frozen.js";
import { G, Simulator } from "./sim/simulator.js";
import { TSWinSplashScreen } from "./screens/splash.js";
import { preloadGameFiles } from "./preload.js";
import { playIntroMovie } from "./screens/intro.js";
import { loadCursors } from "./ui/cursor.js";
import { DefaultTTWindow } from "./ui/ttwindow.js";
import { WinMgr } from "./ui/winmgr.js";
import { ObjectFolder } from "./world/objectfolder.js";
import { WinLotView } from "./world/winlotview.js";
import { doSave, isLotDirty, markLotClean, saveGame } from "./world/savegame.js";
import { moveOutHouse, removeFromVacationHouse } from "./world/moveout.js";
import { installCheatConsole } from "./ui/cheat.js";
import { firstRunTutorial, resetTutorial } from "./nbhd/tutorial.js";
import { IDNO, IDOK, IDYES, MB_OKCANCEL, MB_YESNOCANCEL, TSWinMsgBox } from "./ui/msgbox.js";

/** The screen size for this start (engine/display.ts: cSimsApp::PreFrameWorkInit's display mode). */
const { w: SCREEN_W, h: SCREEN_H } = screenSize();

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
  await Promise.all([...["GameData/UIText.iff", "GameData/Live.iff", "GameData/Build.iff"].map((p) => strings.load(p)), loadGlobalConstants()]);
  return {
    res: await UIRes.load(),
    fonts: new Fonts(),
    strings,
    state: new CPState(),
    width: SCREEN_W,
    height: SCREEN_H,
    hud: hudBand(SCREEN_W, SCREEN_H, readCentredHud()),
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
  /** lbl_105C0807: a Quit is asking. */
  private quitting = false;
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
      // cSimsApp::Quit: on a changed lot with a house (and saving allowed) "Do you want to save
      // before quitting?" (STR# 153 entries 6 / 5, Yes saves, No quits, Cancel stays), else
      // "Are you sure you want to quit?" (entries 2 / 1). The browser cannot close the game:
      // quitting goes back to the landing page.
      quit: async () => {
        if (this.quitting) return false;
        this.quitting = true;
        try {
          const str = (i: number): string => ctx.strings.get("UIText", 153, i);
          const house = this.lotView?.sim?.globals[G.houseNumber] ?? 0;
          let ok: boolean;
          if (!ctx.state.isSaveDisabled() && isLotDirty(this.lotView) && house !== 0) {
            const r = await TSWinMsgBox.show(ctx, str(6), str(5), MB_YESNOCANCEL);
            ok = r === IDNO || (r === IDYES && (await saveGame(ctx, this.lotView, this.nbhdDir)));
          } else {
            ok = (await TSWinMsgBox.show(ctx, str(2), str(1), MB_OKCANCEL)) === IDOK;
          }
          if (ok) location.href = "/";
          return ok;
        } finally {
          this.quitting = false;
        }
      },
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

  /** cSimsApp::WindowSetup's control panel, made for the lot view (not added yet). */
  private async makeControlPanel(): Promise<WinCPanel> {
    const { ctx } = this;
    const cpanel = new WinCPanel(ctx);
    // cSimsApp::WindowSetup: SetArea(view.left, view.bottom - 150, view.right, view.bottom)
    // (the port's centred HUD narrows it to ctx.hud).
    cpanel.setArea(ctx.hud?.left ?? 0, ctx.height - CPANEL_HEIGHT, ctx.hud?.right ?? ctx.width, ctx.height);
    if (!(await cpanel.init())) throw new Error("control panel init failed");
    return cpanel;
  }

  private addControlPanel(view: WinLotView, cpanel: WinCPanel): void {
    view.childAdd(cpanel);
    cpanel.postInit();
    this.cpanel = cpanel;
    this.cpanelSize = { w: this.ctx.width, h: this.ctx.height };
  }

  /** The screen size the control panel was made for. */
  private cpanelSize = { w: 0, h: 0 };

  /** The control panel of the loaded lot. */
  private cpanel: WinCPanel | null = null;
  /** A live screen resize is running or waiting (resizeScreen). */
  private resizing = false;
  private resizeAgain = false;

  /**
   * The port's live screen resize ("window" resolution, engine/display.ts):
   * the game takes the window's new size. The windows on screen are moved
   * (ui/screenresize.ts) and the control panel, whose pages pick their
   * layout from the screen width at Init, is made again, as a lot load
   * makes it. Waits while Create a Sim or a frozen screen is up.
   */
  async resizeScreen(): Promise<void> {
    if (this.resizing) {
      this.resizeAgain = true;
      return;
    }
    const { ctx, mgr } = this;
    this.resizing = true;
    try {
      do {
        this.resizeAgain = false;
        const { w, h } = screenSize("window");
        if (w !== ctx.width || h !== ctx.height) {
          if (holdsScreenSize(mgr.main)) {
            // Checked again shortly (a resize event may not come back).
            setTimeout(() => void this.resizeScreen(), 500);
            break;
          }
          const oldW = ctx.width;
          const oldH = ctx.height;
          mgr.resize(w, h);
          ctx.width = w;
          ctx.height = h;
          ctx.hud = hudBand(w, h, readCentredHud());
          resizeTopLevel(mgr.main, oldW, oldH);
        }
        // A control panel made for another size is made again; the old one
        // stays (moved with the screen's bottom) until the new one is ready.
        const view = this.lotView;
        const old = this.cpanel;
        if (view && old && old.parent === view && (this.cpanelSize.w !== ctx.width || this.cpanelSize.h !== ctx.height)) {
          const fresh = await this.makeControlPanel();
          if (this.resizeAgain || this.lotView !== view || this.cpanel !== old) {
            fresh.shutdown();
            continue;
          }
          view.childDelete(old);
          this.addControlPanel(view, fresh);
          // The new panel shows the current mode and panel state (as after a lot load).
          const st = ctx.state;
          st.setMode(st.getMode(), true);
          st.setCPMode(st.getCPMode(), true);
          st.dirty = DIRTY_ALL;
        }
      } while (this.resizeAgain);
    } finally {
      this.resizing = false;
    }
  }

  private leaveLot(): void {
    if (!this.lotView) return;
    // UnloadHouse: the next Neighborhood::Save no longer takes the lot's live data.
    setLiveNeighborhood(null);
    this.mgr.main.childDelete(this.lotView);
    this.lotAudioOff?.();
    this.lotAudioOff = null;
    this.lotView = null;
    this.cpanel = null;
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
      onMoveOutHouse: (house, bulldoze, store, family) => moveOutHouse(ctx, store, house, bulldoze, family),
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
      onMoveOutHouse: (house, bulldoze, store, family) => moveOutHouse(ctx, store, house, bulldoze, family),
      onRemoveFromVacation: (house, bulldoze, store) => removeFromVacationHouse(ctx, store, house, bulldoze),
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
    const { ctx } = this;
    resetSaveFileCache();
    // The control panel's bitmaps, read while the lot loads (its windows read them one by one).
    ctx.res.prefetchTable("Res_CPanel");
    try {
      await this.enterLotLoaded(house, moveInFamily);
    } finally {
      ctx.res.endPrefetch();
    }
  }

  private async enterLotLoaded(house: number, moveInFamily: number): Promise<void> {
    const { ctx, mgr } = this;
    const state = ctx.state;
    const arrival = this.arrival;
    this.arrival = null;
    if (!(await prepareArrival(ctx, this.nbhdDir, arrival)) && !(await activateFamily(state, await loadNeighborhood(this.nbhdDir), house))) {
      // Nobody lives here (Neighborhood::LoadHouse leaves PersonFinder empty).
      state.family = [];
      state.familyName = "";
    }
    // Neighborhood::LoadHouse reads the neighborhood as it is now (a family may just have moved in).
    this.nbhd = await Neighborhood.load(this.nbhdDir);
    // Neighborhood::GetZoningType(house), which the original asks each time (CPState::SetMode, the panels).
    state.zoningType = this.nbhd.getZoningType(house);
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
      // EnteringHouse -> CPState::UpdateCPStateFromWorld: the lot's saved speed and pause.
      const sim = view.sim;
      const button = [1, 2, 3].find((b) => Simulator.speedForButton(b) === sim.globals[G.speed]);
      if (button !== undefined) state.setSpeed(button);
      state.pause(sim.isPaused());
    }
    if (view.sim) {
      const nb = this.nbhd;
      view.sim.module.transitHooks = new Transit(
        { ctx, nb: () => nb, lotView: () => this.lotView, switchLots: (t) => this.switchLots(t) },
        view.sim,
      );
      view.sim.module.dialogHooks = objectDialogHooks(ctx, view.sim, view);
      view.sim.module.characterHooks = characterHooks(this.nbhdDir, view.sim, ctx.res, () => void saveGame(ctx, this.lotView, this.nbhdDir));
    }
    await applyLoadGameLocation(ctx, view, this.nbhd, house, arrival);
    state.houseNumber = house;
    this.lotAudioOff = installLotAudio(view);
    soundPlayer.playBySource(lotAmbience(house), UI_SOURCE);
    this.lotView = view;
    markLotClean(view);
    this.addControlPanel(view, await this.makeControlPanel());
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

/**
 * The fullscreen option (engine/display.ts readFullscreen, a port setting):
 * the page asks for fullscreen at the first click or key (browsers only grant
 * it on a user gesture), and again at the next one after the player left it.
 * In fullscreen the browser's bar does not slide in at the top of the screen
 * as it does with F11. Chrome also lets the game keep Escape (Keyboard Lock:
 * holding Escape leaves fullscreen).
 *
 * Alt+Enter (a port shortcut, not in the original, which ran fullscreen
 * only) switches fullscreen on or off at any time and keeps the choice as
 * the option: leaving with it stops the page from asking again at the next
 * click. The key does not reach the game.
 */
function installFullscreen(): void {
  type KeyboardLock = { lock?(keys?: string[]): Promise<void>; unlock?(): void };
  const keyboard = (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;
  let wanted = readFullscreen();
  let enterHeld = false;
  const enter = (): void => {
    if (document.fullscreenElement || !document.fullscreenEnabled) return;
    document.documentElement
      .requestFullscreen({ navigationUI: "hide" })
      .then(() => keyboard?.lock?.(["Escape"]))
      .catch(() => {
        // (refused: asked again at the next click)
      });
  };
  const leave = (): void => {
    keyboard?.unlock?.();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  };
  window.addEventListener(
    "pointerdown",
    () => {
      if (wanted) enter();
    },
    true,
  );
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Enter" && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        enterHeld = true;
        if (e.repeat) return;
        wanted = !document.fullscreenElement;
        storeFullscreen(wanted);
        if (wanted) enter();
        else leave();
        return;
      }
      if (wanted) enter();
    },
    true,
  );
  // (its key up stays out of the game too)
  window.addEventListener(
    "keyup",
    (e) => {
      if (e.key !== "Enter" || !enterHeld) return;
      enterHeld = false;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true,
  );
}

/**
 * cSimsApp::ActivateApp: the window losing the focus (blur, or the tab
 * hidden) pauses the live game unless "sim in background" is on, keeping
 * whether it was paused (+0xcc) to restore when it comes back; scrolling
 * stops both ways. (+0xcd: only real changes count.)
 */
function installActivateApp(ctx: GameContext, game: Game): void {
  let active = true;
  let wasPaused = false;
  const set = (on: boolean): void => {
    if (on === active) return;
    active = on;
    const st = ctx.state;
    if (st.getMode() === Mode.Live && !getOptionsMgr().getSimInBackground()) {
      if (!on) {
        wasPaused = st.isPaused();
        st.pause(true);
      } else {
        st.pause(wasPaused);
      }
    }
    game.lotView?.activateApp(on);
  };
  window.addEventListener("blur", () => set(false));
  window.addEventListener("focus", () => set(true));
  document.addEventListener("visibilitychange", () => set(document.visibilityState === "visible" && document.hasFocus()));
}

async function boot(): Promise<void> {
  // GAME_FILES=client: the game files come from this browser's import (engine/gamefiles.ts);
  // without one, back to the landing page, which imports them.
  if ((await isGameFilesLocal()) && !(await localGameIndex())) {
    location.replace("/");
    return;
  }
  const mgr = new WinMgr(document.getElementById("screen")!, SCREEN_W, SCREEN_H);
  installFullscreen();
  const ctx = await createContext();
  // Saves kept in this browser (SAVES=client): ask the browser not to evict them.
  if ((await getSaveMode()) === "client") void requestPersistentStorage();
  // cSimsApp::SetupWinCtrlMgr: the cursor files (UIGraphics/shared/cursors).
  await loadCursors();
  mgr.setDefaultTTWindow(await DefaultTTWindow.create(ctx.fonts));
  // cSimsApp's window setup: the Japanese, Chinese and Korean games' IME composition window.
  await installImeComposition(ctx, mgr);
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
  // cSimsApp::Init: the sound player, the splash, the EA intro movie over it
  // (screens/intro.ts); IntroMovieEnded starts the load music and the load
  // loop under the splash (audio starts with the first click or key: browser
  // autoplay rules).
  await soundPlayer.initialize(getOptionsMgr());
  const splash = new TSWinSplashScreen(ctx);
  await splash.init();
  mgr.main.childAdd(splash);
  await playIntroMovie(mgr.canvas);
  void soundPlayer.startLoadMusic(getOptionsMgr());
  for (const stage of ["stap", "regr", "ctrl", "grph", "main", "cpnl", "char"] as const) {
    splash.setSplashMessage(stage);
  }
  // "ocns": the object folder scan (ObjectFolder::ScanForNewFiles) runs under
  // the splash screen; the first run indexes every object file (cached after).
  splash.setSplashMessage("ocns");
  const folder = await ObjectFolder.get("UserData");
  // Not in the original: the files nearly every session reads, downloaded
  // now (once; the browser keeps them) with a progress bar (game/preload.ts).
  await preloadGameFiles(folder, (done) => splash.setProgress(done));
  splash.setProgress(null);
  const game = new Game(ctx, mgr);
  installActivateApp(ctx, game);
  // The "window" resolution: the game follows the window's size (Game.resizeScreen),
  // once the resizing has settled.
  if (readResolution() === "window") {
    let timer = 0;
    const later = (): void => {
      clearTimeout(timer);
      timer = window.setTimeout(() => void game.resizeScreen(), 150);
    };
    window.addEventListener("resize", later);
    later();
  }
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
