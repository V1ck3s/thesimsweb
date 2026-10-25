/**
 * The neighborhood screen of the Unleashed-era game (cWinNeighborhoodUL),
 * created by cSimsApp::ShowNbhdDialog with "main screen" = true (the
 * alternative cWinNeighborhoodVC is only used when Unleashed is absent, which
 * the Complete Collection never is).
 *
 * Window tree, as built by Init:
 *   this (full screen)                      TSPaint: kLargeMask behind everything
 *    └ map button [99]                       the 800x600 background, centered
 *       └ waves button [100]                 kNghFrameDelta1..6 frame, cycled by TSPaint
 *          ├ lot buttons                     one per LotZoning entry below house 81
 *          ├ bar [0x60]                      kNghBarBkg at the map's top-left
 *          │  └ 13 buttons                   positions from the static table below
 *          └ credits button (index 4)        (195, 540) on the map
 *   PostChildDraw: the neighborhood number, centered in the kNghCurrent box.
 *
 * Buttons (index: resource, UIText STR# 151 tooltip entry):
 *   0 MoveIn  1 Bulldoze  2 Exit  3 Inet  4 Credits  5 Previous  6 Next
 *   7 Import  8 Downtown  9 Sims logo  10 Vacation  11 Rezone  12 Studio Town
 *   13 Magic Town.
 * Regular mode (RegularModeBtnHandler / RegularModeLotHandler): a lot click
 * loads that house; Exit and the town buttons end the screen with the codes
 * cSimsApp::ShowNbhdDialog reads (DoModalWin result 1001 -> -1, 1020 -> -20...).
 */

import { fetchManifest } from "../../engine/assets.js";
import { MUSIC, soundPlayer, UI } from "../audio/index.js";
import type { GameContext } from "../context.js";
import type { FfnFont } from "../res/ffn.js";
import { LANG_FRENCH } from "../res/uires.js";
import { BTN_TOGGLE, TSWinBtn } from "../ui/btn.js";
import { winMgr } from "../ui/winmgr.js";
import { Gfx, TSWin } from "../ui/tswin.js";
import { listNeighborhoodDirs, neighborhoodNumber, type Neighborhood } from "./nghinterface.js";
import { WinLotBtn, type LotBtnOwner } from "./winlotbtn.js";
import { WinLotPopup } from "./winlotpopup.js";

/** cWinNeighborhood::Mode */
export const enum NbhdMode {
  Regular = 0,
  MoveIn = 1,
  Evict = 2,
  Rezone = 3,
  Visit = 4,
  MoveLots = 5,
}

/** Results posted with TSWinMsgPost(0x10, ...) by the regular mode buttons (after the 999 fold). */
export const NBHD_EXIT = -1;
export const NBHD_DOWNTOWN = -20;
export const NBHD_VACATION = -30;
export const NBHD_STUDIOTOWN = -40;
export const NBHD_MAGICTOWN = -50;

/** Button indices (cWinNeighborhoodUL+0x148 + 4 * index). */
const BTN_MOVE_IN = 0;
const BTN_BULLDOZE = 1;
const BTN_EXIT = 2;
const BTN_INET = 3;
const BTN_CREDITS = 4;
const BTN_PREVIOUS = 5;
const BTN_NEXT = 6;
const BTN_IMPORT = 7;
const BTN_DOWNTOWN = 8;
const BTN_LOGO = 9;
const BTN_VACATION = 10;
const BTN_REZONE = 11;
const BTN_STUDIOTOWN = 12;
const BTN_MAGICTOWN = 13;
const BTN_COUNT = 14;

/** lbl_105BCCE4: button bitmaps (Res_Nbhd ids); entries 4 and 9 are replaced per language. */
const BTN_IMAGES = [5200, 5201, 5202, 5306, 5307, 5204, 5205, 5207, 5208, 5210, 5213, 5215, 5216, 5221];

/** Init's two language switches: [credits button, Sims logo] for Res_Languages ids. */
function languageImages(lang: number): [number, number] {
  switch (lang) {
    case 1:
      return [5307, 5210]; // US English keeps the table
    case 3:
      return [0x14c0, 0x1534]; // kNghCreditsFr, kNghSimsLogo_FR
    case 4:
      return [0x14c1, 0x1535];
    case 6:
      return [0x14c2, 0x1533];
    case 15:
      return [0x14c4, 0x1536];
    default:
      return [0x14c3, 0x152d]; // kNghCreditsEn, kNghSimsLogoEn
  }
}

/** lbl_105BCCE0 (set by the file's static initializer): button positions; index 4 is on the map, the rest on the bar. */
const BTN_POS: ReadonlyArray<readonly [number, number]> = [
  [200, 0], [300, 0], [600, 0], [762, 0], [195, 540], [106, 0], [141, 0],
  [250, 0], [400, 0], [5, 0], [450, 0], [350, 0], [500, 0], [550, 0],
];

/** lbl_105C33E0: left of the neighborhood number box on the map (top is 3). */
const CURRENT_BOX_X = 124;
const CURRENT_BOX_Y = 3;

/** UIText STR# 151 "NghbBtnTips" */
const STR_BTN_TIPS = 151;

/** Lots past this house number belong to the expansion towns. */
const FIRST_TOWN_HOUSE = 0x51;

/** TSPaint's wave clock: a frame step whenever 1000 / elapsed <= 2 * pi. */
const WAVE_STEP_MS = 1000 / (2 * Math.PI);

/** cWinLotBtn::InitData: the lots' tooltip unfurl time (cTSWin+0xa0). */
const UNFURL_MS = 0x4b;

/** TSOnTimerMsg period; the first tick enables the lot rollovers. */
const TIMER_MS = 1000;

export interface NeighborhoodCallbacks {
  /** RegularModeLotHandler: cSimsApp::LoadGame(house) and close the screen. */
  onEnterLot(house: number): void;
  /** The screen ended with one of the NBHD_* codes. */
  onEndModal(result: number): void;
  /** Neighborhood::Previous / Next, then cSimsApp::DoNbhdScreen rebuilds the screen. */
  onSwitchNeighborhood(dir: string): void;
  /** A button whose target window is not ported (pick family, credits, web pages, evict, rezone). */
  onUnported(what: string): void;
}

export class WinNeighborhoodUL extends TSWin implements LotBtnOwner {
  /** +0xcc */
  private mode = NbhdMode.Regular;
  private largeMask: ImageBitmap | null = null;
  private waves: Array<ImageBitmap | null> = [];
  private currentBox: ImageBitmap | null = null;
  private font: FfnFont | null = null;
  /** +0x130 / +0x134: the map's offset in the window. */
  private offX = 0;
  private offY = 0;
  private waveBtn: TSWinBtn | null = null;
  private readonly buttons: TSWinBtn[] = [];
  /** +0x138: house number -> lot button, ordered by house number. */
  private lots = new Map<number, WinLotBtn>();
  private popup: WinLotPopup | null = null;
  private waveTick = -1;
  private lastWaveMs = 0;
  private openedMs = -1;
  /** +0x1d9: the first timer tick has not happened yet. */
  private firstTick = true;
  private lastTimerMs = 0;
  private hoveredLot: WinLotBtn | null = null;
  private popupShownMs = 0;
  private popupTargetH = 0;

  constructor(
    private readonly ctx: GameContext,
    private readonly nb: Neighborhood,
    private readonly callbacks: NeighborhoodCallbacks,
  ) {
    super();
  }

  /** cWinNeighborhoodUL::Init (main screen) */
  override async init(): Promise<boolean> {
    const { ctx } = this;
    const res = ctx.res;
    const lang: number = LANG_FRENCH;
    const us = lang === 1;

    // The neighborhood may ship its own map (Neighborhood::GetDirectory + "neighborhoodul.jpg").
    const custom = await this.loadGimex("neighborhoodul.jpg");
    let background: ImageBitmap;
    if (custom) {
      background = custom;
      for (let i = 0; i < 6; i++) this.waves.push(await this.loadGimex(`neighborhoodul${i}.jpg`));
    } else {
      background = await res.image(us ? "kNbhdBck_UL" : "kNbhdBckNonUS_UL");
      const ids = us ? [6302, 6303, 6304, 6330, 6331, 6332] : [6309, 6310, 6311, 6336, 6337, 6338];
      this.waves = await Promise.all(ids.map((id) => res.image(id).catch(() => null)));
    }
    const [creditsId, logoId] = languageImages(lang);
    const bar = await res.image("kNghBarBkg");
    if (this.getW() > 800) this.largeMask = await res.image("kLargeMask");
    // cTSFontSys acquire(1, 12, 0, 0), color MakeFillColor(255, 255, 255).
    this.font = await ctx.fonts.acquire(12);

    const w = this.getW();
    const h = this.getH();
    this.offX = background.width < w ? (w - background.width) >> 1 : 0;
    this.offY = background.height < h ? (h - background.height) >> 1 : 0;
    this.currentBox = await res.image("kNghCurrent");

    const map = new TSWinBtn(0, background, 1);
    map.moveTo(this.offX, this.offY);
    this.childAdd(map);
    const waveBtn = new TSWinBtn(0, this.waves[0] ?? background, 1);
    map.childAdd(waveBtn);
    this.waveBtn = waveBtn;

    // One lot per zoning entry, stopping at the first expansion-town house.
    for (const { house } of this.nb.zoning) {
      if (house >= FIRST_TOWN_HOUSE) break;
      const lot = new WinLotBtn(this, this.nb, true);
      lot.id = 1;
      if (!(await lot.init()) || !(await lot.loadHouseInfo(house))) continue;
      const p = lot.lotPoint();
      lot.centerOn(p.x, p.y);
      lot.clip = { left: 0, top: 0, right: 800, bottom: 600 };
      waveBtn.childAdd(lot);
      this.lots.set(house, lot);
    }
    this.lots = new Map([...this.lots].sort((a, b) => a[0] - b[0]));

    const barBtn = new TSWinBtn(0, bar, 1);
    waveBtn.childAdd(barBtn);

    for (let i = 0; i < BTN_COUNT; i++) {
      const id = i === BTN_CREDITS ? creditsId : i === BTN_LOGO ? logoId : BTN_IMAGES[i]!;
      const btn = new TSWinBtn(1, await res.image(id), i === BTN_LOGO ? 1 : 4);
      // Credits uses entry 9 (1-based); the others take the entries in order.
      const tip = i === BTN_CREDITS ? 8 : i < BTN_CREDITS ? i : i - 1;
      btn.tooltip = ctx.strings.get("UIText", STR_BTN_TIPS, tip);
      const [x, y] = BTN_POS[i]!;
      btn.moveTo(x, y);
      (i === BTN_CREDITS ? waveBtn : barBtn).childAdd(btn);
      this.buttons.push(btn);
    }
    for (const i of [BTN_MOVE_IN, BTN_BULLDOZE, BTN_REZONE]) {
      this.buttons[i]!.mode = BTN_TOGGLE;
      this.buttons[i]!.sendOnDown = true;
    }

    const popup = new WinLotPopup(ctx, this.nb, () => this.mode);
    if (!(await popup.init())) return false;
    this.childAdd(popup);
    this.popup = popup;

    // Every button of the screen clicks with the neighborhood sound (restored by shutdown).
    TSWinBtn.overrideDefaultUISound(null, UI.nhoodClick);
    this.setMode(NbhdMode.Regular);
    soundPlayer.playBySource(MUSIC.hood, -1);
    return true;
  }

  /** LoadGimex(<neighborhood directory>/<name>), or null when the file is absent. */
  private async loadGimex(name: string): Promise<ImageBitmap | null> {
    const path = `Sims/${this.nb.dir}/${name}`.toLowerCase();
    const file = (await fetchManifest()).files.find((f) => f.path.toLowerCase() === path);
    if (!file) return null;
    const r = await fetch(`/assets/${file.path}`).catch(() => null);
    return r?.ok ? createImageBitmap(await r.blob()).catch(() => null) : null;
  }

  /** cWinNeighborhoodUL::SetMode */
  override shutdown(): void {
    TSWinBtn.overrideDefaultUISound();
    super.shutdown();
  }

  setMode(mode: NbhdMode): void {
    if (this.mode === NbhdMode.Rezone) this.buttons[BTN_REZONE]!.setState(0);
    if (this.mode === NbhdMode.MoveIn) this.buttons[BTN_MOVE_IN]!.setState(0);
    if (this.mode === NbhdMode.Evict) this.buttons[BTN_BULLDOZE]!.setState(0);
    this.mode = mode;
    if (mode === NbhdMode.Regular) {
      // Every button is enabled; Import only when an import file waits (CheckForNewImports).
      for (let i = 0; i < BTN_COUNT; i++) if (i !== BTN_IMPORT) this.buttons[i]!.setEnabled(true);
      void this.checkForNewImports();
    }
  }

  /** cWinNeighborhoodUL::CheckForNewImports: Import is enabled when <dir>/Import holds *.FAM, *.rdt or *.cmt. */
  private async checkForNewImports(): Promise<void> {
    const { files } = await fetchManifest();
    const prefix = `Sims/${this.nb.dir}/Import/`.toLowerCase();
    const any = files.some((f) => {
      const p = f.path.toLowerCase();
      return p.startsWith(prefix) && /\.(fam|rdt|cmt)$/.test(p);
    });
    this.buttons[BTN_IMPORT]!.setEnabled(any);
  }

  /** cWinNeighborhoodUL::ShouldAllowRoofDissolve */
  shouldAllowRoofDissolve(btn: WinLotBtn): boolean {
    const info = btn.info;
    if (!info) return false;
    switch (this.mode) {
      case NbhdMode.Visit:
        return this.nb.getZoningType(btn.houseNumber) === 2;
      case NbhdMode.Regular:
        return info.familyNumber !== -1;
      default:
        return true;
    }
  }

  /** cTSWinMgrW95::TriggerToolTips for a lot: its tooltip window is the shared popup. */
  lotEntered(btn: WinLotBtn): void {
    this.hoveredLot = btn;
    if (!this.firstTick) void this.showPopup(btn);
  }

  lotExited(btn: WinLotBtn): void {
    if (this.hoveredLot !== btn) return;
    this.hoveredLot = null;
    // cTSWinMgrW95::UntriggerToolTips
    this.popup?.hideWindow();
  }

  /** cWinLotBtn::GetToolTipsWindow + cTSWin::GetTTPosition + the unfurl of SetupToolTipsWindow. */
  private async showPopup(btn: WinLotBtn): Promise<void> {
    const popup = this.popup;
    if (!popup || !btn.info) return;
    await popup.setHouseInfo(btn.info);
    if (this.hoveredLot !== btn) return;
    const { w, h } = popup.fullSize();
    const o = btn.absOrigin();
    const me = this.absOrigin();
    const cursor = winMgr.cursorPosition();
    const left = o.x - me.x;
    const top = o.y - me.y;
    const right = left + btn.getW();
    const bottom = top + btn.getH();
    let x = Math.min(Math.max(cursor.x - me.x, left), right - 1);
    let y = top - h - 1;
    if (y < 3) y = bottom + 2;
    if (x < 0) x = 0;
    else if (x + w >= this.getW()) x = this.getW() - w - 1;
    if (y < 0) y = 0;
    else if (y + h >= this.getH()) y = this.getH() - h - 1;
    popup.setArea(x, y, x + w, y + h);
    this.popupTargetH = h;
    this.popupShownMs = performance.now();
    this.childToFront(popup);
    popup.showWindow();
  }

  override tsOnCommand(cmd: number, source: TSWin): boolean {
    if (cmd !== 1) return false;
    if (source instanceof WinLotBtn) {
      if (this.mode === NbhdMode.Regular) this.regularModeLotHandler(source.houseNumber);
      else this.callbacks.onUnported(`lot click in mode ${this.mode}`);
      return true;
    }
    const index = this.buttons.indexOf(source as TSWinBtn);
    if (index < 0) return false;
    if (this.mode === NbhdMode.Regular) this.regularModeBtnHandler(index);
    return true;
  }

  /** cWinNeighborhoodUL::RegularModeLotHandler (main screen) */
  private regularModeLotHandler(house: number): void {
    if (!this.lots.has(house)) return;
    soundPlayer.playBySource(MUSIC.fade, -1);
    // The game also refills townies and tourist families here (simulation, not ported).
    this.callbacks.onEnterLot(house);
  }

  /** cWinNeighborhoodUL::RegularModeBtnHandler */
  private regularModeBtnHandler(index: number): void {
    switch (index) {
      case BTN_MOVE_IN:
        // Opens cWinPickFamily modally, then returns to regular mode.
        this.callbacks.onUnported("cWinPickFamily");
        this.buttons[BTN_MOVE_IN]!.setState(0);
        break;
      case BTN_BULLDOZE:
      case BTN_REZONE:
        // SetMode(Evict / Rezone): those modes' handlers are not ported.
        this.callbacks.onUnported(index === BTN_BULLDOZE ? "evict mode" : "rezone mode");
        this.buttons[index]!.setState(0);
        break;
      case BTN_EXIT:
        soundPlayer.playBySource(MUSIC.fade, -1);
        this.callbacks.onEndModal(NBHD_EXIT);
        break;
      case BTN_INET:
        this.callbacks.onUnported("DoInternetUpdate");
        break;
      case BTN_CREDITS:
      case BTN_LOGO:
        this.callbacks.onUnported("cWinCredits");
        break;
      case BTN_PREVIOUS:
      case BTN_NEXT:
        void this.switchNeighborhood(index === BTN_NEXT ? 1 : -1);
        break;
      case BTN_IMPORT:
        this.callbacks.onUnported("CycleThroughImports");
        break;
      case BTN_DOWNTOWN:
        this.callbacks.onEndModal(NBHD_DOWNTOWN);
        break;
      case BTN_VACATION:
        this.callbacks.onEndModal(NBHD_VACATION);
        break;
      case BTN_STUDIOTOWN:
        this.callbacks.onEndModal(NBHD_STUDIOTOWN);
        break;
      case BTN_MAGICTOWN:
        this.callbacks.onEndModal(NBHD_MAGICTOWN);
        break;
    }
  }

  /** Neighborhood::Previous / Next: cycle through the UserData directories, wrapping around. */
  private async switchNeighborhood(step: number): Promise<void> {
    // All buttons are disabled until the screen is rebuilt.
    for (const b of this.buttons) b.setEnabled(false);
    const dirs = await listNeighborhoodDirs();
    const i = dirs.findIndex((d) => neighborhoodNumber(d) === this.nb.number);
    const next = dirs[(i + step + dirs.length) % dirs.length] ?? this.nb.dir;
    this.callbacks.onSwitchNeighborhood(next);
  }

  override pump(now: number): void {
    if (this.openedMs < 0) {
      this.openedMs = now;
      this.lastTimerMs = now;
      this.lastWaveMs = now;
    }
    // TSOnTimerMsg every second; the first tick turns the lot rollovers on.
    if (now - this.lastTimerMs >= TIMER_MS) {
      this.lastTimerMs = now;
      if (this.firstTick) {
        this.firstTick = false;
        if (this.hoveredLot) void this.showPopup(this.hoveredLot);
      }
    }
    // Popup unfurl (lot buttons: cTSWin+0xa0 = 75 ms), growing upward from its bottom edge.
    const popup = this.popup;
    if (popup?.isVisible()) {
      const t = Math.min(1, (now - this.popupShownMs) / UNFURL_MS);
      const shown = Math.trunc(this.popupTargetH * t + 0.5);
      const bottom = popup.area.top + popup.getH();
      const full = popup.fullSize();
      if (popup.getH() !== shown) popup.setArea(popup.area.left, bottom - shown, popup.area.left + full.w, bottom);
    }
    super.pump(now);
  }

  /** cWinNeighborhoodUL::TSPaint: the large backdrop and the wave clock. */
  override tsPaint(g: Gfx): void {
    if (this.largeMask) g.blit(this.largeMask, 0, 0);
    const now = performance.now();
    if (now - this.lastWaveMs >= WAVE_STEP_MS) {
      this.lastWaveMs = now;
      this.waveTick = (this.waveTick + 1) % 12;
      const frame = this.waves[this.waveTick >> 1];
      if (frame) this.waveBtn?.setImage(frame, 1);
    }
  }

  /** cWinNeighborhoodUL::PostChildDraw (main screen): the current neighborhood number. */
  override postChildDraw(g: Gfx): void {
    const font = this.font;
    const box = this.currentBox;
    if (!font || !box) return;
    const text = String(this.nb.number);
    const tw = font.textArea(text).w;
    const x = CURRENT_BOX_X + this.offX + Math.trunc(box.width / 2) - 1 - Math.trunc(tw / 2);
    const y = CURRENT_BOX_Y + this.offY + Math.trunc(box.height / 2) - 1 - Math.trunc(font.height / 2);
    font.drawText(g.ctx, text, g.ox + x, g.oy + y, "#ffffff");
  }
}
