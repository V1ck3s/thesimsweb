/**
 * cWinViewControl — the round gadget at the bottom-left of the lot view: mode
 * buttons (Live/Buy/Build/Options/Camera), floor level, wall state, zoom,
 * rotation, game speed and pause, help, the clock, funds and the family friend
 * count.
 *
 * Ported from the Mac build (cWinViewControl.c + WinViewControl.s), checked
 * against the Windows build. Positions come from ___sinit__WinViewControl_cpp,
 * fonts from the gFonts table filled by InitSimsColors (gFonts[size] =
 * VariableSans, plain), tooltips from STR# 138 "VCtlTips" of UIText.iff.
 *
 * The funds button opens cWinBudgetDlg on a residential lot, the friend count
 * a cWinPictureDialog (STR# 162 "FriendCountDlg"), the help button cWinHelp;
 * each runs modally with the simulation blocked (DoSimsModalDialog with
 * cDDDSimsView::SetBlockSimulator).
 *
 * SetMode with interface effects (BoboVision) fades the control panel in
 * and out (cTSWin::AsyncShowHideWin) instead of showing / hiding it, and the
 * mode patch fades with it (BlitPrivateBufferToParent blends it at the
 * panel's GetOpacity).
 *
 * The gadget paints into its private buffer (UniversalBack.tga, its children,
 * the clock), which BlitPrivateBufferToParent puts on the lot view: with
 * BoboVision through the TGA's 8-bit alpha (Compose, AlphaBlend_565_P5),
 * without it as a color-keyed Blt (see blitPrivateBufferToParent).
 */

import { Mode, WallState } from "../cpstate.js";
import { soundPlayer, speedTransitionSound, UI } from "../audio/index.js";
import type { GameContext } from "../context.js";
import type { FfnFont } from "../res/ffn.js";
import { makeMoneyString, makeTimeString } from "../res/langutil.js";
import { UI_LANGUAGE } from "../res/uires.js";
import { BTN_PUSH, BTN_TOGGLE, TSWinBtn } from "../ui/btn.js";
import { WinPictureDialog } from "../ui/picturedialog.js";
import { Gfx, TSWin } from "../ui/tswin.js";
import type { RgbaImage } from "../res/bmp.js";
import { winMgr } from "../ui/winmgr.js";
import { WinBudgetDlg } from "./budgetdlg.js";
import type { WinCPanel } from "./cpanel.js";
import { WinHelp } from "./help.js";
import { getCursor } from "../ui/cursor.js";
import { getOptionsMgr } from "../optionsmgr.js";
import { stopTracking } from "../world/tracking.js";

/** CPState dirty bits tested by UpdateViewFromCPState. */
const DIRTY_MODE = 0x2;
const DIRTY_SPEED_OR_MODE = 0x42;
const DIRTY_WALLS = 0x80;
const DIRTY_LEVEL = 0x100;
const DIRTY_ZOOM = 0x1000;
const DIRTY_TIME = 0x2000;
const DIRTY_FUNDS = 0x4000;
const DIRTY_CPMODE = 0x100000;
const DIRTY_PAUSE = 0x800000;
const DIRTY_BUY_BUILD = 0x1000000;
const DIRTY_LIVE_DISABLED = 0x8000000;

/** ___sinit__WinViewControl_cpp: top-left of each button in the gadget. */
const POS = {
  people: [10, 6],
  objects: [69, 20],
  arch: [117, 45],
  options: [193, 125],
  camera: [175, 95],
  level1: [5, 92],
  level2: [5, 77],
  levelRoof: [32, 78],
  noCut: [56, 80],
  dynaCut: [80, 85],
  noWall: [103, 95],
  rotRight: [9, 127],
  rotLeft: [43, 127],
  zoomIn: [26, 105],
  zoomOut: [26, 149],
  pause: [85, 135],
  speed1: [105, 135],
  speed2: [120, 135],
  speed3: [141, 135],
  help: [5, 164],
} as const;
/** Funds text: right edge x, top y (lbl_105BC60C.x, lbl_105BC610.y). */
const FUNDS_RIGHT = 178;
const FUNDS_TOP = 158;
/** Clock text rect (lbl_105BC664); the string is centered horizontally. */
const CLOCK_RECT = { left: 95, top: 118, right: 151 };
/** Strings sizing the funds and friend count buttons. */
const FUNDS_SIZER = "$9,999,999";
const FRIENDS_SIZER = "999";

/**
 * Caption colors of the funds/friend buttons and the clock (Init, 0x00RRGGBB):
 * normal, highlighted (funds change), hovered, disabled.
 */
const HILITE_COLORS = ["#29e65e", "#00feff", "#d5fef4", "#1a8b4a"];

/** Funds flash timings in ms (cWinViewControl+0x17c / +0x180, constructor). */
const FUNDS_FLASH_OLD_MS = 250;
const FUNDS_FLASH_NEW_MS = 200;

/** SubscribeTimerMsg period for the blinking pause / speed 3 buttons. */
const SPEED_TIMER_MS = 500;

/** BlitPrivateBufferToParent: mode patch linking the gadget to the panel, per mode. */
const PATCH_POS: Record<Mode, [number, number]> = {
  [Mode.Live]: [7, 30],
  [Mode.Buy]: [64, 35],
  [Mode.Build]: [113, 51],
  [Mode.Options]: [183, 83],
  [Mode.Camera]: [165, 83],
};

/** cWinViewControl::SpeedMode */
const enum SpeedMode {
  Normal = 0,
  /** Not in Live mode (or simulator blocked): pause button shows its second row. */
  Stopped = 1,
  /** Paused: the pause button blinks between its rows. */
  Paused = 2,
  /** Speed 3 requested but throttled: the speed 3 button blinks. */
  Throttled = 3,
}

/** cWinViewControl::SpeedEvent */
const enum SpeedEvent {
  Speed = 0,
  Pause = 1,
  Throttle = 2,
  Mode = 3,
}

/** UIText STR# 162 "FriendCountDlg": title, text, button (GetString 1..3). */
const STR_FRIEND_COUNT = 0xa2;

/** cWinViewControl::Mode: whether the control panel is shown (0) or collapsed (1). */
const enum VCMode {
  PanelShown = 0,
  PanelCollapsed = 1,
}

/** cTSLanguageUtility::MakeMoneyString (res/langutil.ts), kept here for its importers. */
export { makeMoneyString };

/** Modifier keys for the Live button (GetKeyState(VK_SHIFT / VK_CONTROL)). */
const keys = { shift: false, ctrl: false };
for (const type of ["keydown", "keyup"] as const) {
  window.addEventListener(type, (e) => {
    keys.shift = e.shiftKey;
    keys.ctrl = e.ctrlKey;
  });
}

export class WinViewControl extends TSWin {
  private background: ImageBitmap | null = null;
  /**
   * +0x124 as GIMEXFactory decodes it, RemoveTransparency'd: alpha 0 pixels
   * hold the transparent color (here alpha 0), the others are opaque with the
   * TGA's premultiplied colors divided back by their alpha.
   */
  private backKeyed: ImageBitmap | null = null;
  /** The same pixels all opaque: what the private buffer holds under the BoboVision mask. */
  private backOpaque: ImageBitmap | null = null;
  /** +0x124's alpha buffer (+0x60): the TGA's 8-bit alpha, one byte per pixel. */
  private backAlpha: Uint8Array | null = null;
  /** +0x58: the private buffer (PrivateBuffer(1, 0), color-keyed with the transparent color). */
  private privateBuffer: OffscreenCanvas | null = null;
  /** Compose's work buffer: the parent's pixels under the gadget, read back and blended. */
  private composeBuffer: OffscreenCanvasRenderingContext2D | null = null;
  private bgAlpha: Uint8ClampedArray | null = null;
  private clockFont: FfnFont | null = null;
  private patches = new Map<Mode, ImageBitmap>();

  rotRight!: TSWinBtn;
  rotLeft!: TSWinBtn;
  zoomIn!: TSWinBtn;
  zoomOut!: TSWinBtn;
  noCut!: TSWinBtn;
  dynaCut!: TSWinBtn;
  noWall!: TSWinBtn;
  people!: TSWinBtn;
  objects!: TSWinBtn;
  arch!: TSWinBtn;
  options!: TSWinBtn;
  camera!: TSWinBtn;
  funds!: TSWinBtn;
  level1!: TSWinBtn;
  level2!: TSWinBtn;
  levelRoof!: TSWinBtn;
  pauseBtn!: TSWinBtn;
  speed1!: TSWinBtn;
  speed2!: TSWinBtn;
  speed3!: TSWinBtn;
  help!: TSWinBtn;
  friends!: TSWinBtn;

  /** +0x168: clock string as last read from CPState. */
  private timeText = "";
  /** +0x16c..0x178, +0x184: funds change flash (0 idle, 1 old value lit, 2 new value lit). */
  private fundsFlash = 0;
  private fundsDeadline = -1;
  private fundsPending = "";
  /** +0x188 */
  private mode = VCMode.PanelShown;
  /** +0x1b0 / +0x1b4 */
  private speedTimerDue = -1;
  private speedMode = SpeedMode.Normal;
  /** +0x1bc: speed 3 throttled by the simulator (cSimsApp command 0x109). */
  speedThrottled = false;
  /** cDDDSimsView+0x111 (SetBlockSimulator): a modal dialog holds the simulation. */
  simulatorBlocked = false;
  /** cDDDSimsView::SetBlockSimulator(1) for the lot's simulator; returns the release (the lot view sets it). */
  static holdSimulator: (() => () => void) | null = null;
  /** Global 0x20 of the lot's simulator (visiting without sims): no budget or friend count dialog then. */
  static simulatorGlobal32: (() => number) | null = null;
  /** +0x1c0: the help topic selected last time (cWinHelp::GetSelected). */
  private helpTopic = 0;
  /** +0x1ac: family name copied on simulator sync (0x80000). */
  familyName = "";

  constructor(readonly ctx: GameContext) {
    super();
    // cWinViewControl::Init: SetCursor(GetCursor(0)), the arrow over the lot view's tool cursor.
    this.winCursor = getCursor(0);
  }

  override async init(): Promise<boolean> {
    const { res, fonts, strings } = this.ctx;
    this.background = await res.image("kUniversalBkgTGA");
    const back = gimexDecode(await res.rgba(res.id("kUniversalBkgTGA")));
    [this.backKeyed, this.backOpaque] = await Promise.all([createImageBitmap(back.keyed), createImageBitmap(back.opaque)]);
    this.backAlpha = back.alpha;
    // SetFlag(0x200): hit testing uses the background's alpha (IsPointInWindowWindowCoordinates).
    this.setArea(this.area.left, this.area.top, this.area.left + this.background.width, this.area.top + this.background.height);

    const btn = async (name: string, pos: readonly [number, number], mode: number, sendOnDown: boolean, rows = 1): Promise<TSWinBtn> => {
      const b = new TSWinBtn(0, await res.image(name), 4, rows);
      b.moveTo(pos[0], pos[1]);
      b.mode = mode;
      b.sendOnDown = sendOnDown;
      this.childAdd(b);
      return b;
    };
    // Order of ChildAdd in Init (the last added is the front-most).
    this.level1 = await btn("kLevel1", POS.level1, BTN_TOGGLE, true);
    this.level2 = await btn("kLevel2", POS.level2, BTN_TOGGLE, true);
    this.levelRoof = await btn("kLevelRoof", POS.levelRoof, BTN_TOGGLE, true);
    this.rotLeft = await btn("kRotLeft", POS.rotLeft, BTN_PUSH, true);
    this.rotRight = await btn("kRotRight", POS.rotRight, BTN_PUSH, true);
    this.zoomIn = await btn("kZoomIn", POS.zoomIn, BTN_PUSH, true);
    this.zoomOut = await btn("kZoomOut", POS.zoomOut, BTN_PUSH, true);
    this.noCut = await btn("kNoCut", POS.noCut, BTN_TOGGLE, true);
    this.dynaCut = await btn("kDynaCut", POS.dynaCut, BTN_TOGGLE, true);
    this.noWall = await btn("kNoWall", POS.noWall, BTN_TOGGLE, true);
    this.people = await btn("kPeople", POS.people, BTN_TOGGLE, true);
    this.objects = await btn("kObjects", POS.objects, BTN_TOGGLE, true);
    this.arch = await btn("kArch", POS.arch, BTN_TOGGLE, true);
    this.options = await btn("kOptions", POS.options, BTN_TOGGLE, true);
    this.camera = await btn("kCameraBtn", POS.camera, BTN_TOGGLE, true);
    this.pauseBtn = await btn("kPause", POS.pause, BTN_TOGGLE, false, 2);
    this.speed1 = await btn("kSpeed1", POS.speed1, BTN_TOGGLE, false);
    this.speed2 = await btn("kSpeed2", POS.speed2, BTN_TOGGLE, false);
    this.speed3 = await btn("kSpeed3", POS.speed3, BTN_TOGGLE, false);
    this.help = await btn("kHelpBtn", POS.help, BTN_TOGGLE, false);

    // Text buttons: gFonts[10] (or a 10 pt font for double-byte UIs, not supported here).
    const textFont = await fonts.acquire(10);
    this.clockFont = await fonts.acquire(8);

    this.funds = new TSWinBtn();
    this.funds.cols = 4;
    this.funds.font = textFont;
    const fw = textFont.stringWidth(FUNDS_SIZER);
    this.funds.setArea(FUNDS_RIGHT - fw, FUNDS_TOP, FUNDS_RIGHT, FUNDS_TOP + textFont.height);
    this.funds.mode = BTN_TOGGLE;
    this.funds.textAlignment = 2;
    this.funds.hiliteColors = HILITE_COLORS;
    this.childAdd(this.funds);

    // Friend count, right next to the funds (left of them).
    this.friends = new TSWinBtn();
    this.friends.cols = 4;
    this.friends.font = textFont;
    this.childAdd(this.friends);
    const nw = textFont.stringWidth(FRIENDS_SIZER);
    const { left, top } = this.funds.area;
    this.friends.setArea(left - nw, top, left, top + textFont.height);
    this.friends.hiliteColors = HILITE_COLORS;
    this.friends.textAlignment = 2;

    // An empty hidden child window (Init creates it; no other use found).
    const spare = new TSWin();
    this.childAdd(spare);
    spare.hideWindow();

    // Tooltips: STR# 138 "VCtlTips", consumed in this order (only for windows that exist).
    const tips = [
      this.level1, this.level2, this.levelRoof, this.rotLeft, this.rotRight, this.zoomIn, this.zoomOut,
      this.noCut, this.dynaCut, this.noWall, this.people, this.objects, this.arch, this.options,
      this.funds, this.pauseBtn, this.speed1, this.speed2, this.speed3, this.camera, this.friends,
    ];
    tips.forEach((w, i) => (w.tooltip = strings.get("UIText", 138, i)));
    // Entries 21 and 22 ("AM", "PM") are stored in +0x19c / +0x1a0; 23 is the help tooltip.
    this.help.tooltip = strings.get("UIText", 138, 23);

    // Patches drawn over the gadget next to the selected mode button.
    const patchIds: Array<[Mode, string]> = [
      [Mode.Live, "kLiveModePatch"],
      [Mode.Buy, "kBuyModePatch"],
      [Mode.Build, "kBuildModePatch"],
      [Mode.Options, "kOptionsModePatch"],
      [Mode.Camera, "kCameraPatch"],
    ];
    for (const [mode, id] of patchIds) this.patches.set(mode, await res.image(id));
    return true;
  }

  // --- CPState -> view -------------------------------------------------------

  updateViewFromCPState(): void {
    const s = this.ctx.state;
    const d = s.dirty;
    if (d & DIRTY_MODE) {
      this.updateSpeedMode(SpeedEvent.Mode);
      // The original also calls cWinCPanel::SetPanel here; WinCPanel does it itself.
      const mode = s.getMode();
      this.people.setState(mode === Mode.Live ? 1 : 0);
      this.objects.setState(mode === Mode.Buy ? 1 : 0);
      this.arch.setState(mode === Mode.Build ? 1 : 0);
      this.options.setState(mode === Mode.Options ? 1 : 0);
      this.camera.setState(mode === Mode.Camera ? 1 : 0);
    }
    if (d & DIRTY_LEVEL) {
      this.level1.setState(s.getLevel() === 1 ? 1 : 0);
      this.level2.setState(s.getLevel() === 2 ? 1 : 0);
      this.level1.setEnabled(true);
      if ((s.getMode() === Mode.Build && s.is2ndLevelFloorable()) || s.hasBeenTo2ndLevel()) {
        this.level2.setEnabled(true);
      } else {
        this.level2.setEnabled(false);
        if (s.getLevel() === 2) {
          s.setLevel(1);
          this.level1.setState(1);
        }
      }
    }
    if (d & DIRTY_WALLS) {
      const ws = s.getWallState();
      this.noCut.setState(ws === WallState.Up ? 1 : 0);
      this.dynaCut.setState(ws === WallState.Cutaway ? 1 : 0);
      this.noWall.setState(ws === WallState.Down ? 1 : 0);
      this.levelRoof.setState(ws === WallState.Roof ? 1 : 0);
      const flags = s.getWallButtonEnableFlags();
      this.noCut.setEnabled((flags & 1) !== 0);
      this.dynaCut.setEnabled((flags & 4) !== 0);
      this.noWall.setEnabled((flags & 2) !== 0);
    }
    if (d & DIRTY_ZOOM) {
      this.zoomIn.setEnabled(s.canZoomIn());
      this.zoomOut.setEnabled(s.canZoomOut());
    }
    if (d & DIRTY_FUNDS) this.updateFunds(performance.now());
    if (d & DIRTY_TIME) {
      const t = s.getTime();
      this.timeText = makeTimeString(t.hour, t.minute, UI_LANGUAGE);
    }
    // 0x80000 (simulator sync: speed, pause, family name) is the simulation's job.
    if (d & DIRTY_SPEED_OR_MODE) {
      this.updateSpeedMode(SpeedEvent.Speed);
      const speed = s.getSpeed();
      this.speed1.setState(speed === 1 ? 1 : 0);
      this.speed2.setState(speed === 2 ? 1 : 0);
      this.speed3.setState(speed === 3 ? 1 : 0);
    }
    if (d & DIRTY_PAUSE) this.updateSpeedMode(SpeedEvent.Pause);
    if (d & DIRTY_CPMODE) {
      if (s.getCPMode() === 0) this.setMode(VCMode.PanelShown);
      else if (s.getCPMode() === 1) this.setMode(VCMode.PanelCollapsed);
    }
    if (d & DIRTY_BUY_BUILD) {
      const on = !s.isBuyAndBuildDisabled();
      this.objects.setEnabled(on);
      this.arch.setEnabled(on);
    }
    if (d & DIRTY_LIVE_DISABLED) {
      const on = !s.isLiveModeDisabled();
      this.people.setEnabled(on);
      this.camera.setEnabled(on);
      if (s.isHideForLocation()) {
        this.funds.hideWindow();
        this.friends.hideWindow();
      } else {
        this.funds.showWindow();
        this.friends.showWindow();
      }
    }
  }

  /**
   * Funds part of UpdateViewFromCPState. A change lights the old value for
   * 250 ms, then the new value for 200 ms; the original keeps the funds dirty
   * bit set (CPState+0x10) until the flash ends, we re-run it from pump().
   */
  private updateFunds(now: number): void {
    const funds = makeMoneyString(Math.min(this.ctx.state.getFunds(), 9999999), UI_LANGUAGE);
    const btn = this.funds;
    if (funds.length === 0 || btn.caption.length === 0) {
      btn.caption = funds;
      this.fundsFlash = 0;
      return;
    }
    const changed = funds !== btn.caption;
    if (this.fundsFlash === 0) {
      if (!changed) return;
      this.fundsPending = funds;
      this.fundsFlash = 1;
      this.fundsDeadline = now + FUNDS_FLASH_OLD_MS;
      btn.setState(1);
      return;
    }
    if (this.fundsDeadline >= 0 && now >= this.fundsDeadline) {
      this.fundsDeadline = -1;
      if (this.fundsFlash === 2) {
        btn.setState(0);
        this.fundsFlash = 0;
      } else {
        btn.caption = this.fundsPending;
        this.fundsFlash = 2;
        this.fundsDeadline = now + FUNDS_FLASH_NEW_MS;
      }
    } else if (changed) {
      if (this.fundsFlash === 1) this.fundsPending = funds;
      else btn.caption = funds;
    }
  }

  /** cWinViewControl::SetMode: show or collapse the control panel, stay at the bottom-left. */
  private setMode(mode: VCMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    const cpanel = this.controlPanel();
    if (!cpanel) return;
    // Without Bobo vision: HouseViewer::SetViewportHeight to the lot view's
    // height less the panel's opaque part (its height - 0x32), or all of it
    // once the panel is hidden: the lot view then runs under the panel's area.
    // With it, the panel fades in (the viewport is left as it is) or out (the
    // viewport takes the whole view; SetOverlapsScrollArea(panel, true)).
    const parent = this.parent;
    const viewH = parent?.getH() ?? 0;
    if (!getOptionsMgr().getBoboVision()) {
      if (mode === VCMode.PanelShown) {
        cpanel.showWindow();
        if (parent) this.ctx.state.viewer?.setViewportHeight?.(viewH - (cpanel.getH() - 0x32));
      } else {
        cpanel.hideWindow();
        if (parent) this.ctx.state.viewer?.setViewportHeight?.(viewH);
      }
    } else if (mode === VCMode.PanelShown) {
      cpanel.asyncShowHideWin(true, false);
    } else {
      cpanel.asyncShowHideWin(false, false);
      if (parent) this.ctx.state.viewer?.setViewportHeight?.(viewH);
    }
    if (parent && this.background) {
      const top = parent.getH() - this.background.height;
      this.setArea(0, top, this.getW(), top + this.getH());
    }
  }

  /** The control panel that owns us (cSimsApp+0x84); we live in its parent, the lot view. */
  private controlPanel(): WinCPanel | null {
    const found = this.parent?.children.find((c) => (c as Partial<WinCPanel>).viewControl === this);
    return (found as WinCPanel | undefined) ?? null;
  }

  // --- speed / pause ---------------------------------------------------------

  /** cWinViewControl::UpdateSpeedMode */
  updateSpeedMode(ev: SpeedEvent): void {
    const s = this.ctx.state;
    const live = s.getMode() === Mode.Live && !this.simulatorBlocked;
    const throttledAway = this.speedThrottled && s.getSpeed() !== 3;
    switch (this.speedMode) {
      case SpeedMode.Normal:
        if (ev === SpeedEvent.Throttle) {
          if (this.speedThrottled) this.setSpeedMode(SpeedMode.Throttled);
        } else if (ev === SpeedEvent.Pause) {
          if (s.isPaused()) this.setSpeedMode(SpeedMode.Paused);
        } else if (ev === SpeedEvent.Mode && !live) {
          this.setSpeedMode(SpeedMode.Stopped);
        }
        break;
      case SpeedMode.Stopped:
        if (ev === SpeedEvent.Pause) {
          if (s.isPaused()) this.setSpeedMode(SpeedMode.Paused);
        } else if (ev === SpeedEvent.Mode && live) {
          if (s.isPaused()) this.setSpeedMode(SpeedMode.Paused);
          else this.setSpeedMode(throttledAway ? SpeedMode.Throttled : SpeedMode.Normal);
        }
        break;
      case SpeedMode.Paused:
        if (ev === SpeedEvent.Pause) {
          if (s.isPaused()) this.setSpeedMode(SpeedMode.Paused);
          else if (s.getMode() !== Mode.Live) this.setSpeedMode(SpeedMode.Stopped);
          else this.setSpeedMode(throttledAway ? SpeedMode.Throttled : SpeedMode.Normal);
        } else if (ev === SpeedEvent.Speed && s.getMode() === Mode.Live) {
          this.setSpeedMode(SpeedMode.Normal);
        }
        break;
      case SpeedMode.Throttled:
        if (ev === SpeedEvent.Throttle) {
          this.setSpeedMode(SpeedMode.Normal);
        } else if (ev === SpeedEvent.Speed) {
          if (!this.speedThrottled) this.setSpeedMode(SpeedMode.Normal);
        } else if (ev === SpeedEvent.Pause) {
          if (s.isPaused()) this.setSpeedMode(SpeedMode.Paused);
        } else if (!live) {
          this.setSpeedMode(SpeedMode.Stopped);
        }
        break;
    }
  }

  /** cWinViewControl::SetSpeedMode */
  private setSpeedMode(mode: SpeedMode): void {
    this.cleanupSpeedMode(this.speedMode);
    this.speedMode = mode;
    if (mode === SpeedMode.Stopped) {
      this.pauseBtn.row = 1;
      this.pauseBtn.setState(1);
    } else if (mode === SpeedMode.Paused) {
      if (this.speedTimerDue < 0) this.speedTimerDue = performance.now() + SPEED_TIMER_MS;
      this.pauseBtn.setState(1);
    } else if (mode === SpeedMode.Throttled) {
      if (this.speedTimerDue < 0) this.speedTimerDue = performance.now() + SPEED_TIMER_MS;
    }
  }

  /** cWinViewControl::CleanupSpeedMode */
  private cleanupSpeedMode(mode: SpeedMode): void {
    if (mode === SpeedMode.Stopped) {
      this.pauseBtn.row = 0;
      this.pauseBtn.setState(0);
    } else if (mode === SpeedMode.Paused || mode === SpeedMode.Throttled) {
      this.speedTimerDue = -1;
      if (mode === SpeedMode.Throttled) {
        if (this.ctx.state.getSpeed() !== 3) this.speed3.setState(0);
      } else {
        this.pauseBtn.setState(0);
        this.pauseBtn.row = 0;
      }
    }
  }

  /** cWinViewControl::TSOnTimerMsg: blink the pause or speed 3 button. */
  private tsOnTimerMsg(): void {
    if (this.speedMode === SpeedMode.Throttled) {
      if (this.ctx.state.getSpeed() !== 3) this.speed3.setState(this.speed3.state ? 0 : 1);
    } else if (this.speedMode === SpeedMode.Paused) {
      this.pauseBtn.row = this.pauseBtn.row === 0 ? 1 : 0;
    }
  }

  /**
   * cSimsApp::DoCommand(0x109, suspended), sent by cSimulator::Simulate when
   * the family leaves or comes back: +0x1bc, then UpdateSpeedMode(2) (the
   * speed 3 button blinks while the simulator runs at its suspended speed).
   */
  simulatorSuspended(on: boolean): void {
    this.speedThrottled = on;
    this.updateSpeedMode(SpeedEvent.Throttle);
  }

  /** cWinViewControl::SpoofSpeedChange: keyboard shortcuts P/1/2/3 press the buttons. */
  spoofSpeedChange(n: number): void {
    const b = [this.pauseBtn, this.speed1, this.speed2, this.speed3][n];
    if (b) this.tsOnCommand(1, b);
  }

  override pump(nowMs: number): void {
    super.pump(nowMs);
    if (this.speedTimerDue >= 0 && nowMs >= this.speedTimerDue) {
      this.speedTimerDue = nowMs + SPEED_TIMER_MS;
      this.tsOnTimerMsg();
    }
    if (this.fundsFlash !== 0) this.updateFunds(nowMs);
  }

  // --- commands --------------------------------------------------------------

  /** cWinViewControl::TSOnCommand: buttons are identified by pointer, like the original. */
  override tsOnCommand(cmd: number, src: TSWin): boolean {
    const s = this.ctx.state;
    const expand = (): void => {
      if (this.mode === VCMode.PanelCollapsed) s.setCPMode(0);
    };
    const speedClick = (speed: number): void => {
      if (s.getMode() === Mode.Live) this.speedThrottled = false;
      soundPlayer.playUISound(speedTransitionSound(s.isPaused() ? 0 : s.getSpeed(), speed));
      if (s.getMode() === Mode.Live) s.pause(false);
      s.setSpeed(speed);
    };
    switch (src) {
      case this.level1:
        // cWinPeople::StopTracking when the level changes.
        if (s.getLevel() !== 1) stopTracking();
        s.setLevel(1);
        break;
      case this.level2:
        if (s.getLevel() !== 2) stopTracking();
        s.setLevel(2);
        break;
      case this.levelRoof:
        s.setWallState(WallState.Roof);
        break;
      case this.rotRight:
        s.rotateRight();
        break;
      case this.rotLeft:
        s.rotateLeft();
        break;
      case this.zoomIn:
        s.zoomIn();
        break;
      case this.zoomOut:
        s.zoomOut();
        break;
      case this.noCut:
        s.setWallState(WallState.Up);
        break;
      case this.dynaCut:
        s.setWallState(WallState.Cutaway);
        break;
      case this.noWall:
        s.setWallState(WallState.Down);
        break;
      case this.people:
        if (keys.shift && keys.ctrl) break;
        if (s.getMode() === Mode.Live) {
          // Clicking Live again collapses or expands the control panel.
          s.setCPMode(this.mode === VCMode.PanelShown ? 1 : 0);
        } else {
          expand();
          s.setMode(Mode.Live);
        }
        break;
      case this.objects:
        expand();
        // In Buy mode the original also cycles the catalog sort (ShopSetSort) and
        // resets the catalog pages (ResetPreviousPages).
        s.setMode(Mode.Buy);
        break;
      case this.arch:
        expand();
        s.setMode(Mode.Build);
        break;
      case this.options:
        expand();
        s.setMode(Mode.Options);
        break;
      case this.camera:
        expand();
        s.setMode(Mode.Camera);
        break;
      case this.pauseBtn:
        soundPlayer.playUISound(s.isPaused() ? speedTransitionSound(0, s.getSpeed()) : speedTransitionSound(s.getSpeed(), 0));
        s.pause(!s.isPaused());
        break;
      case this.speed1:
        speedClick(1);
        break;
      case this.speed2:
        speedClick(2);
        break;
      case this.speed3:
        speedClick(3);
        break;
      case this.funds:
        void this.showBudget();
        break;
      case this.friends:
        void this.showFriendCount();
        break;
      case this.help:
        void this.showHelp();
        break;
      default:
        return super.tsOnCommand(cmd, src);
    }
    return true;
  }

  // --- dialogs (cWinViewControl::TSOnCommand) ----------------------------------

  /** DoSimsModalDialog between SetBlockSimulator(1) and (0). */
  private async runModal(win: TSWin): Promise<void> {
    const release = WinViewControl.holdSimulator?.() ?? null;
    this.simulatorBlocked = true;
    try {
      await winMgr.doModalWin(win);
    } finally {
      this.simulatorBlocked = false;
      release?.();
    }
  }

  /** The funds button: cWinBudgetDlg on a residential lot (global 0x20 clear), centered; the button is reset. */
  private async showBudget(): Promise<void> {
    if ((WinViewControl.simulatorGlobal32?.() ?? 0) === 0 && this.ctx.state.zoningType === 1) {
      soundPlayer.playUISound(UI.whoosh);
      const dlg = new WinBudgetDlg(this.ctx);
      if (await dlg.init()) {
        const main = winMgr.main;
        dlg.moveTo(Math.trunc((main.getW() - dlg.getW()) / 2), Math.trunc((main.getH() - dlg.getH()) / 2));
        await this.runModal(dlg);
      }
    }
    this.funds.setState(0);
  }

  /** The friend count: a cWinPictureDialog with UIText STR# 162 (title, text, button), centered. */
  private async showFriendCount(): Promise<void> {
    if ((WinViewControl.simulatorGlobal32?.() ?? 0) === 0) {
      const str = (i: number): string => this.ctx.strings.get("UIText", STR_FRIEND_COUNT, i - 1);
      const dlg = new WinPictureDialog(this.ctx);
      dlg.setTitle(str(1));
      dlg.addText(str(2));
      dlg.addButton(str(3), 0);
      if (await dlg.init()) await this.runModal(dlg);
    }
    this.friends.setState(0);
  }

  /** The help button: cWinHelp (font table entry 12) on the last topic; the topic is kept. */
  private async showHelp(): Promise<void> {
    const dlg = new WinHelp(this.ctx);
    await dlg.init();
    dlg.setSelected(this.helpTopic);
    await this.runModal(dlg);
    this.helpTopic = dlg.getSelected();
    this.help.setState(0);
  }

  // --- painting and hit testing ---------------------------------------------

  /** cWinViewControl::TSPaint: background, then the clock centered in its rect. */
  override tsPaint(g: Gfx): void {
    // Blt of +0x124 into the private buffer, flag 0: every pixel copied (its
    // transparency was removed), the transparent color where the alpha is 0.
    const back = getOptionsMgr().getBoboVision() ? this.backOpaque : this.backKeyed;
    if (back) g.blit(back, 0, 0);
    const font = this.clockFont;
    if (font && this.timeText) {
      const w = font.stringWidth(this.timeText);
      const x = CLOCK_RECT.left + ((CLOCK_RECT.right - CLOCK_RECT.left - w) >> 1);
      font.drawText(g.ctx, this.timeText, g.ox + x, g.oy + CLOCK_RECT.top, HILITE_COLORS[0]!);
    }
  }

  /** PostChildDraw: refreshes the friend count caption when it changed. */
  override postChildDraw(_g: Gfx): void {
    const count = String(this.ctx.state.getFamilyFriendCount());
    if (count !== this.friends.caption) this.friends.caption = count;
  }

  /**
   * cTSWin::Plot with a private buffer: the gadget, its children and
   * PostChildDraw are drawn into +0x58, then BlitPrivateBufferToParent.
   */
  override plot(ctx: CanvasRenderingContext2D, ox: number, oy: number): void {
    if (!this.isVisible()) return;
    const w = this.getW();
    const h = this.getH();
    if (w <= 0 || h <= 0) return;
    let buf = this.privateBuffer;
    if (buf?.width !== w || buf.height !== h) buf = this.privateBuffer = new OffscreenCanvas(w, h);
    // Read back by Compose every frame with BoboVision: kept in CPU memory.
    const bx = buf.getContext("2d", { willReadFrequently: true })!;
    bx.clearRect(0, 0, w, h);
    super.plot(bx as unknown as CanvasRenderingContext2D, -this.area.left, -this.area.top);
    this.blitPrivateBufferToParent(ctx, ox + this.area.left, oy + this.area.top);
  }

  /**
   * BlitPrivateBufferToParent. With BoboVision, Compose(parent, rect, +0x58,
   * +0x124's alpha buffer, (0, 0), 0): AlphaBlend_565_P5 keeps the parent
   * where the alpha is below 8, copies the private buffer above 0xf7 and in
   * between blends the two through its table, by the alpha's top 5 bits
   * (compose565). Without it, a Blt of +0x58 with its color key: the
   * parent shows where the private buffer holds the transparent color, which
   * is where UniversalBack.tga's alpha is 0 and no child drew. Then the
   * patch of the current mode, while the control panel is shown, at the
   * panel's opacity (opaque from 31 / 32, not drawn below 1 / 32).
   */
  private blitPrivateBufferToParent(ctx: CanvasRenderingContext2D, x: number, y: number): void {
    const buf = this.privateBuffer;
    if (buf) {
      if (getOptionsMgr().getBoboVision() && this.backAlpha) this.compose(ctx, buf, x, y);
      else ctx.drawImage(buf, x, y);
    }
    const cpanel = this.controlPanel();
    if (!cpanel?.isVisible()) return;
    const mode = this.ctx.state.getMode();
    const patch = this.patches.get(mode);
    if (!patch) return;
    const g = new Gfx(ctx, x, y);
    const opacity = cpanel.getOpacity();
    const level = (opacity >> 3) & 0x1f;
    if (level === 0x1f) {
      g.blit(patch, PATCH_POS[mode][0], PATCH_POS[mode][1]);
    } else if (level !== 0) {
      const a = ctx.globalAlpha;
      ctx.globalAlpha = a * (opacity / 255);
      g.blit(patch, PATCH_POS[mode][0], PATCH_POS[mode][1]);
      ctx.globalAlpha = a;
    }
  }

  /**
   * Compose(parent, rect, +0x58, +0x124's alpha buffer, (0, 0), 0) on the
   * gadget's rectangle only: the parent's pixels there are read back (through
   * a CPU-side canvas, as renderRoundShadow does), blended by compose565 and
   * put back.
   */
  private compose(ctx: CanvasRenderingContext2D, buf: OffscreenCanvas, x: number, y: number): void {
    const alpha = this.backAlpha!;
    const aw = this.background?.width ?? buf.width;
    // The rectangle clipped to the parent's surface.
    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    const left = Math.max(0, x);
    const top = Math.max(0, y);
    const w = Math.min(cw, x + buf.width, x + aw) - left;
    const h = Math.min(ch, y + buf.height, y + Math.trunc(alpha.length / aw)) - top;
    if (w <= 0 || h <= 0) return;
    let sc = this.composeBuffer;
    if (!sc || sc.canvas.width < w || sc.canvas.height < h) {
      sc = this.composeBuffer = new OffscreenCanvas(buf.width, buf.height).getContext("2d", { willReadFrequently: true });
      if (!sc) return;
    }
    sc.drawImage(ctx.canvas, left, top, w, h, 0, 0, w, h);
    const dst = sc.getImageData(0, 0, w, h);
    const src = buf.getContext("2d", { willReadFrequently: true })!.getImageData(left - x, top - y, w, h);
    compose565(dst.data, src.data, w, h, alpha, aw, left - x, top - y);
    sc.putImageData(dst, 0, 0);
    ctx.drawImage(sc.canvas, 0, 0, w, h, left, top, w, h);
  }

  /** Clicks only land where the background is at least half opaque. */
  override isPointInWindowWindowCoordinates(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.getW() || y >= this.getH()) return false;
    const bg = this.background;
    if (!bg) return true;
    if (!this.bgAlpha) {
      const c = new OffscreenCanvas(bg.width, bg.height);
      const cx = c.getContext("2d")!;
      cx.drawImage(bg, 0, 0);
      this.bgAlpha = cx.getImageData(0, 0, bg.width, bg.height).data;
    }
    return (this.bgAlpha[(y * bg.width + x) * 4 + 3] ?? 0) >= 0x80;
  }
}

/**
 * InitAlphaZSpriteBlit's table (lbl_105BA5E0, [alpha >> 3][src][dst] on 5-bit
 * channels): each entry is the mean, over the 8 sub-values of the level
 * (8 * level + k), of the source (8 * src + i) and of the destination
 * (8 * dst + j), of (int)(0.5 + (k' / 255) * (s - d) + d) (fmuls, fmadds,
 * fadds and fctiwz in single precision), rounded ((int)(0.5 + sum / 512)) and
 * shifted down to 5 bits. A level is built on its first use; the original
 * builds the 32 at startup, to the same values.
 */
const ALPHA_TABLE = new Uint8Array(32 * 32 * 32);
const alphaLevelBuilt = new Uint8Array(32);

function alphaTableLevel(level: number): void {
  if (alphaLevelBuilt[level]) return;
  alphaLevelBuilt[level] = 1;
  const f = Math.fround;
  const inv255 = f(1 / 255);
  const m: number[] = [];
  for (let k = 0; k < 8; k++) m.push(f(inv255 * f(8 * level + k)));
  for (let src = 0; src < 32; src++) {
    for (let dst = 0; dst < 32; dst++) {
      let sum = 0;
      for (let j = 0; j < 8; j++) {
        const d = 8 * dst + j;
        for (let i = 0; i < 8; i++) {
          const diff = 8 * src + i - d;
          for (let k = 0; k < 8; k++) sum += Math.trunc(f(0.5 + f(m[k]! * diff + d)));
        }
      }
      ALPHA_TABLE[(level << 10) | (src << 5) | dst] = Math.trunc(f(0.5 + sum / 512)) >> 3;
    }
  }
}

/**
 * AlphaBlend_565_565_P5 (Compose's 565 blit) on RGBA pixels: `dst` (w x h)
 * is the parent, `src` the private buffer, `alpha` the alpha buffer (`aw`
 * wide) read from (ax, ay). Below 8 the parent is kept, above 0xf7 the
 * source copied, otherwise each channel is the table entry for the level
 * alpha >> 3 and the 5-bit source and destination (the 565 green's top 5
 * bits; the result is written back to them, the low green bit cleared),
 * expanded with zero low bits like Cvt565toRGB.
 */
export function compose565(dst: Uint8ClampedArray, src: Uint8ClampedArray, w: number, h: number, alpha: Uint8Array, aw: number, ax: number, ay: number): void {
  const t = ALPHA_TABLE;
  for (let row = 0; row < h; row++) {
    let ai = (ay + row) * aw + ax;
    let i = row * w * 4;
    for (let col = 0; col < w; col++, ai++, i += 4) {
      const a = alpha[ai]!;
      if (a < 8) continue;
      if (a > 0xf7) {
        dst[i] = src[i]!;
        dst[i + 1] = src[i + 1]!;
        dst[i + 2] = src[i + 2]!;
        continue;
      }
      const level = a >> 3;
      if (!alphaLevelBuilt[level]) alphaTableLevel(level);
      const base = level << 10;
      dst[i] = t[base | ((src[i]! >> 3) << 5) | (dst[i]! >> 3)]! << 3;
      dst[i + 1] = t[base | ((src[i + 1]! >> 3) << 5) | (dst[i + 1]! >> 3)]! << 3;
      dst[i + 2] = t[base | ((src[i + 2]! >> 3) << 5) | (dst[i + 2]! >> 3)]! << 3;
    }
  }
}

/**
 * GIMEXFactory's decoding of a 32-bit TGA with an 8-bit alpha (the flag
 * lbl_105BA7EC set, as everywhere but the Magic Town fog): alpha 0 gives the
 * transparent color, 0xff the color, otherwise the premultiplied color times
 * 255 / alpha (float, + 0.5, truncated). Returns the keyed and opaque color
 * buffers and the alpha buffer.
 */
function gimexDecode(img: RgbaImage): { keyed: ImageData; opaque: ImageData; alpha: Uint8Array } {
  const { width, height, data } = img;
  const keyed = new ImageData(width, height);
  const opaque = new ImageData(width, height);
  const alpha = new Uint8Array(width * height);
  const f = Math.fround;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]!;
    let r = data[i]!;
    let g = data[i + 1]!;
    let b = data[i + 2]!;
    if (a === 0) {
      r = 0xff;
      g = 0;
      b = 0xff;
    } else if (a !== 0xff) {
      const k = f(255 / a);
      r = Math.trunc(f(f(r * k) + 0.5));
      g = Math.trunc(f(f(g * k) + 0.5));
      b = Math.trunc(f(f(b * k) + 0.5));
    }
    for (const out of [keyed.data, opaque.data]) {
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
    }
    keyed.data[i + 3] = a === 0 ? 0 : 0xff;
    opaque.data[i + 3] = 0xff;
    alpha[i >> 2] = a;
  }
  return { keyed, opaque, alpha };
}
