/**
 * cWinOptions — Options mode panel: Save / Neighborhood / Quit, and three
 * subpanels (graphics, sound, play) opened by their toggle buttons.
 *
 * Ported from the Mac build (cWinOptions.c, WinOptions.s for the TSOnCommand
 * and BuildPlayButtons jump tables), checked against the Windows build.
 *
 * Layout comes from UIText STR# 145 "optionstrs", read in order by
 * BuildButtons: "(x;y)" positions (StringPosToPoint) interleaved with
 * tooltips, labels, popup titles and descriptions. The six main buttons come
 * first; the subpanels start at the right edge of the widest of them and span
 * the rest of the panel; their positions in the table are relative to the
 * panel, the code converts them. Within a subpanel, widgets go down a column
 * (cell height from the table) and wrap to a new column after N rows.
 *
 * Every label is a captionless-image toggle button (cTSWinBtn, 4 frame
 * columns, no image) whose click (or hover, with quick tips on) opens the
 * cWinLivePopup with its title, description and illustration (lbl_105BC458).
 * The controls are cTSWinCheck (kOptCheckbox), cWinTriRadio (kOptRadio),
 * cTSWinSlider (kOptSliderOn / kOptSliderOff when at 0) and a cWinTriText
 * (Low / Medium / High) over the first tri-radio.
 *
 * Buttons are kept in one array, like cWinOptions+0xd8 (42 slots); the
 * commands identify them by index. The anti-aliasing label and check box are
 * always hidden (UpdateViewFromCPState / SetMode).
 *
 * Not ported: interface effects fades of the subpanels (AsyncShowHideWin; we
 * switch at once), downtown / vacation / studio / magic town lots (their save
 * dialogs, SaveDowntownDescription, the other "leave" screens), the tutorial
 * house's disabled quick tips, UI sounds, cWinPeople::SetQuickTips.
 */

import { CPState, DIRTY_OPTIONS, DIRTY_SAVE_DISABLED } from "../cpstate.js";
import type { GameContext } from "../context.js";
import { getOptionsMgr, type TriState } from "../optionsmgr.js";
import type { FfnFont } from "../res/ffn.js";
import { LANG_FRENCH } from "../res/uires.js";
import { BTN_PUSH, BTN_TOGGLE_ON_DOWN, TSWinBtn } from "../ui/btn.js";
import { CMD_CHECK_CHANGED, TSWinCheck } from "../ui/check.js";
import { TSWinCtrlMgr } from "../ui/ctrlmgr.js";
import { CMD_SLIDER_CHANGED, SLIDER_HORIZONTAL, TSWinSlider } from "../ui/slider.js";
import { TSWinText } from "../ui/text.js";
import { CMD_TRIRADIO_CHANGED, WinTriRadio } from "../ui/triradio.js";
import { Gfx, TSWin, WF_ENABLED } from "../ui/tswin.js";
import { winMgr } from "../ui/winmgr.js";
import type { WinCPanel } from "./cpanel.js";
import {
  ASYNC_ON_ENTER,
  AsyncBtn,
  CMD_ASYNC_TIMEOUT,
  CMD_CLICK,
  WinLivePopup,
  WinLivePopupClient,
} from "./livepopup.js";

/** UIText STR# 145 "optionstrs" (LoadUIStrings(0x91)). */
const STR_OPTIONS = 0x91;

/** cWinOptions+0xd8 slots. */
const enum B {
  Nbhd = 0,
  Save = 1,
  Quit = 2,
  Graphics = 3,
  Sound = 4,
  Play = 5,
  LblAntiAlias = 6,
  LblTerrain = 10,
  LblCharacter = 11,
  ChkAntiAlias = 12,
  ChkShadows = 13,
  ChkLighting = 14,
  ChkEffects = 15,
  TriTerrain = 16,
  TriCharacter = 17,
  TriText = 18,
  LblFX = 19,
  SldFX = 22,
  SldMusic = 23,
  SldVox = 24,
  LblAutoCenter = 25,
  LblFreeWill = 26,
  ChkAutoCenter = 29,
  ChkFreeWill = 30,
  ChkEdgeScroll = 31,
  ChkSimInBack = 32,
  Reset = 33,
  LblQuickTips = 34,
  ChkQuickTips = 38,
  ChkAutoSnap = 39,
  ChkLivePIP = 40,
  ChkExportHTML = 41,
  Count = 42,
}

/** cWinOptions::Mode: which subpanel is open. */
const enum Mode {
  None = 0,
  Graphics = 1,
  Sound = 2,
  Play = 3,
}

/** lbl_105BC450: main button images, in slot order. */
const MAIN_IMAGES = [
  "kOptionNbhd",
  "kOptionSave",
  "kOptionExit",
  "kOptionGraphics",
  "kOptionSound",
  "kOptionPlay",
];

/** lbl_105BC458: popup illustration per slot (-1 entries omitted). */
const POPUP_BITMAPS: Readonly<Record<number, string>> = {
  6: "kPopupOptAntiAlias",
  7: "kPopupOptShadows",
  8: "kPopupOptLighting",
  9: "kPopupOptTransUI",
  10: "kPopupOptTerrainDetail",
  11: "kPopupOptCharDetail",
  19: "kPopupOptSFX",
  20: "kPopupOptMusic",
  21: "kPopupOptVox",
  25: "kPopupOptAutoCenter",
  26: "kPopupOptFreeWill",
  27: "kPopupOptEdgeScroll",
  28: "kPopupOptSimInBack",
  33: "kPopupOptReset",
  34: "kPopupOptQuickTips",
  35: "kPopupOptAutoSnap",
  36: "kPopupOptLivePIP",
  37: "kPopupOptHtml",
};

/** The slots whose async timer opens the popup (TSOnCommand 0x13). */
const ASYNC_SLOTS = (i: number): boolean =>
  (i >= 6 && i < 12) || (i >= 19 && i < 22) || (i >= 25 && i < 29) || (i >= 33 && i < 38);

/** Language ids tested by the Build*Buttons functions (cGZApp+0x64). */
const LANG: number = LANG_FRENCH;
const LANG_0x11 = 0x11;
const LANG_0x13 = 0x13;

/**
 * BuildPlayButtons' jump table on (language - 3): the play labels use the size
 * 9 table font, 8 or 7 in some languages; size 7 also moves them down 5 px and
 * the second column 2 px instead of 4.
 */
const PLAY_FONT_BY_LANG = [8, 7, 8, 9, 9, 9, 8, 9, 9, 9, 9, 7, 9, 7];
function playFontSize(lang: number): number {
  return PLAY_FONT_BY_LANG[lang - 3] ?? 9;
}

/** Popup data of a label (cTSWinBtn+0xa4 in this panel: name, description, bitmap). */
interface PopupInfo {
  name: string;
  desc: string;
  bitmap: ImageBitmap | null;
}

/** StringPosToPoint: "(x;y)". */
function strPos(s: string): { x: number; y: number } {
  const m = /\(\s*(-?\d+)\s*;\s*(-?\d+)\s*\)/.exec(s);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : { x: 0, y: 0 };
}

/**
 * The column layout of the Build*Buttons functions (a cTSPoint walk over a
 * rect of `rows` cells): visible windows go down from (x, y) in steps of
 * `ch`, then to the next column `cw` to the right.
 */
function layoutColumn(
  wins: ReadonlyArray<TSWin | null>,
  x: number,
  y: number,
  cw: number,
  ch: number,
  rows: number,
): void {
  const limit = y + ch * rows;
  let px = x;
  let py = y;
  let col = 0;
  for (const w of wins) {
    if (!w || !w.isVisible()) continue;
    w.moveTo(px, py);
    py += ch;
    if (ch === 0 || limit < py + ch) {
      col++;
      px = x + col * cw;
      py = y;
    }
  }
}

/** C integer division. */
const idiv = (a: number, b: number): number => Math.trunc(a / b);

/** cWinTriText: three centered captions over a cWinTriRadio. */
class WinTriText extends TSWin {
  private readonly texts: TSWinText[] = [];

  constructor(private readonly font: FfnFont) {
    super();
  }

  /** cWinTriText::Init: SetFont, SetAlignment(2), transparent, no gutters. */
  override async init(): Promise<boolean> {
    for (let i = 0; i < 3; i++) {
      const t = new TSWinText();
      t.setFont(this.font);
      this.childAdd(t);
      t.setAlignment(2);
      t.setBackgroundOpaque(false);
      t.setGutters(0, 0);
      await t.init();
      this.texts.push(t);
    }
    return true;
  }

  setText(a: string, b: string, c: string): void {
    [a, b, c].forEach((s, i) => this.texts[i]?.setCaption(s));
  }

  /** cWinTriText::SetArea: three equal columns. */
  override setArea(left: number, top: number, right: number, bottom: number): void {
    super.setArea(left, top, right, bottom);
    const third = idiv(right - left, 3);
    const h = bottom - top;
    this.texts[0]?.setArea(0, 0, third, h);
    this.texts[1]?.setArea(third, 0, third * 2, h);
    this.texts[2]?.setArea(third * 2, 0, right - left, h);
  }
}

export class WinOptions extends TSWin {
  /** +0xd8: every button and control, by slot. */
  private readonly wins: Array<TSWin | null> = new Array<TSWin | null>(B.Count).fill(null);
  private readonly popupInfo = new Map<TSWin, PopupInfo>();
  /** +0x180 / +0x184 / +0x188 */
  private graphicsPanel: TSWin | null = null;
  private soundPanel: TSWin | null = null;
  private playPanel: TSWin | null = null;
  /** +0xd4 */
  private mode = Mode.None;
  /** +0xd0: the control panel background handed over by cWinCPanel (kUniversalCPBkg). */
  private background: ImageBitmap | null = null;
  /** +0x194..+0x1a8 */
  private radioImg: ImageBitmap | null = null;
  private checkImg: ImageBitmap | null = null;
  private sliderOn: ImageBitmap | null = null;
  private sliderOff: ImageBitmap | null = null;
  private toothPick1: ImageBitmap | null = null;
  private toothPick2: ImageBitmap | null = null;
  /** +0x18c / +0x190 */
  private popup: WinLivePopup | null = null;
  private client: WinLivePopupClient | null = null;
  private mouseInside = false;

  constructor(readonly ctx: GameContext) {
    super();
  }

  // --- init ----------------------------------------------------------------------

  /** cWinOptions::Init */
  override async init(): Promise<boolean> {
    const { res } = this.ctx;
    [
      this.background,
      this.radioImg,
      this.checkImg,
      this.sliderOn,
      this.sliderOff,
      this.toothPick1,
      this.toothPick2,
    ] = await Promise.all([
      res.image("kUniversalCPBkg"),
      res.image("kOptRadio"),
      res.image("kOptCheckbox"),
      res.image("kOptSliderOn"),
      res.image("kOptSliderOff"),
      res.image("kOptToothPick1"),
      res.image("kOptToothPick2"),
    ]);
    this.popup = new WinLivePopup(this.ctx);
    if (!(await this.popup.init())) return false;
    // cWinLivePopupClient("", "") tagged "options".
    this.client = new WinLivePopupClient();
    this.client.kind = "options";
    if (!(await this.buildButtons())) return false;
    this.setMode(Mode.None);
    return true;
  }

  /** cWinOptions::BuildButtons */
  private async buildButtons(): Promise<boolean> {
    const { res, strings } = this.ctx;
    const table = strings.list("UIText", STR_OPTIONS);
    let it = 0;
    const next = (): string => table[it++] ?? "";
    const mgr = await TSWinCtrlMgr.get(this.ctx);

    for (let i = 0; i < 6; i++) {
      // Hot over their whole rectangle (no tWinFlag 0x200), hence a CaptionBtn subclass.
      const b = new AsyncBtn(CMD_CLICK, await res.image(MAIN_IMAGES[i]!), 4, 1);
      // Save / Neighborhood / Quit are push buttons, the subpanel buttons toggle on press.
      b.mode = i < 3 ? BTN_PUSH : BTN_TOGGLE_ON_DOWN;
      b.font = mgr.tableFont(9);
      const p = strPos(next());
      b.moveTo(p.x, p.y);
      b.tooltip = next();
      this.childAdd(b);
      this.wins[i] = b;
    }
    let x0 = 0;
    for (let i = 0; i < 6; i++) x0 = Math.max(x0, this.wins[i]!.area.right);

    await this.buildGraphicsButtons(next, x0);
    await this.buildSoundButtons(next, x0);
    await this.buildPlayButtons(next, x0);
    return true;
  }

  /** A subpanel: the rest of the panel right of the main buttons, hidden. */
  private makeSubpanel(x0: number): TSWin {
    const w = new TSWin();
    this.childAdd(w);
    w.setArea(x0, 0, this.getW(), this.getH());
    w.hideWindow();
    return w;
  }

  /**
   * A label: a toggle cTSWinBtn without image (4 frame columns for the caption
   * colors), sized to its caption, with its popup data (caption, then title
   * and description from the table).
   */
  private async makeLabel(
    slot: number,
    panel: TSWin,
    font: FfnFont,
    next: () => string,
    align?: number,
  ): Promise<AsyncBtn> {
    const b = new AsyncBtn(CMD_CLICK);
    b.mode = BTN_TOGGLE_ON_DOWN;
    b.cols = 4;
    b.font = font;
    b.caption = next();
    if (align !== undefined) b.textAlignment = align;
    b.setArea(0, 0, font.stringWidth(b.caption), font.height);
    const bmp = POPUP_BITMAPS[slot];
    this.popupInfo.set(b, {
      name: next(),
      desc: next(),
      bitmap: bmp ? await this.ctx.res.image(bmp) : null,
    });
    panel.childAdd(b);
    this.wins[slot] = b;
    return b;
  }

  private makeCheck(slot: number, panel: TSWin): TSWinCheck {
    const c = new TSWinCheck();
    c.setImage(this.checkImg!);
    // SetCaptureBkg(1): the check box is drawn over the panel background.
    this.wins[slot] = c;
    panel.childAdd(c);
    return c;
  }

  /** cWinOptions::BuildGraphicsButtons */
  private async buildGraphicsButtons(next: () => string, x0: number): Promise<void> {
    const mgr = await TSWinCtrlMgr.get(this.ctx);
    const panel = this.makeSubpanel(x0);
    this.graphicsPanel = panel;
    const font = mgr.tableFont(9);

    // Anti-alias, shadows, lighting, interface effects: left-aligned labels.
    let o = strPos(next());
    let cell = strPos(next());
    let y = o.y;
    if (LANG === LANG_0x11) y += 4;
    else if (LANG === LANG_0x13) y -= 6;
    for (let i = 6; i < 10; i++) await this.makeLabel(i, panel, font, next, 0);
    layoutColumn(this.wins.slice(6, 10), o.x - x0, y, cell.x, cell.y, 4);

    // Terrain and character detail: right-aligned labels as wide as the wider one.
    o = strPos(next());
    cell = strPos(next());
    y = o.y;
    if (LANG === LANG_0x13) y -= 3;
    for (let i = 10; i < 12; i++) await this.makeLabel(i, panel, font, next, 2);
    const maxW = Math.max(0, this.wins[10]!.getW(), this.wins[11]!.getW());
    for (let i = 10; i < 12; i++) {
      const w = this.wins[i]!;
      w.setArea(w.area.left, w.area.top, w.area.left + maxW, w.area.bottom);
    }
    layoutColumn(this.wins.slice(10, 12), o.x - x0 - maxW, y, cell.x, cell.y, 2);

    // Their check boxes.
    o = strPos(next());
    cell = strPos(next());
    y = o.y;
    if (LANG === LANG_0x11) y += 4;
    for (let i = 12; i < 16; i++) this.makeCheck(i, panel);
    for (let i = 12; i < 16; i++) await this.wins[i]!.init();
    layoutColumn(this.wins.slice(12, 16), o.x - x0, y, cell.x, cell.y, 4);

    // Terrain and character detail tri-radios.
    const size = strPos(next());
    o = strPos(next());
    cell = strPos(next());
    for (let i = 16; i < 18; i++) {
      const r = new WinTriRadio(this.radioImg!);
      await r.init();
      r.setArea(0, 0, size.x, size.y);
      panel.childAdd(r);
      this.wins[i] = r;
    }
    layoutColumn(this.wins.slice(16, 18), o.x - x0, o.y, cell.x, cell.y, 3);

    // Low / Medium / High over the first tri-radio.
    const textFont = mgr.tableFont(8);
    const tri = new WinTriText(textFont);
    await tri.init();
    panel.childAdd(tri);
    tri.setText(next(), next(), next());
    this.wins[B.TriText] = tri;
    const r0 = this.wins[B.TriTerrain]!.area;
    const top = r0.top - 7 - textFont.height;
    tri.setArea(r0.left - 8, top, r0.left + (r0.right - r0.left) + 5, top + textFont.height - 2);
  }

  /** cWinOptions::BuildSoundButtons */
  private async buildSoundButtons(next: () => string, x0: number): Promise<void> {
    const mgr = await TSWinCtrlMgr.get(this.ctx);
    const panel = this.makeSubpanel(x0);
    this.soundPanel = panel;
    const font = mgr.tableFont(9);

    const o = strPos(next());
    const cell = strPos(next());
    let x = o.x - x0;
    let y = o.y;
    if (LANG === LANG_0x13) y -= 4;
    let maxW = 0;
    for (let i = 19; i < 22; i++)
      maxW = Math.max(maxW, (await this.makeLabel(i, panel, font, next)).getW());
    layoutColumn(this.wins.slice(19, 22), x, y, cell.x, cell.y, 3);
    if (LANG === LANG_0x13) y += 4;

    // Volume sliders, 15 px right of the widest label, centered on the label line.
    const on = this.sliderOn!;
    x += maxW + 0xf;
    y += idiv(this.wins[B.LblFX]!.getH() - on.height, 2);
    const len = strPos(next()).x;
    for (let i = 22; i < 25; i++) {
      const s = new TSWinSlider();
      s.setDirection(SLIDER_HORIZONTAL);
      s.setImage(on);
      s.setArea(0, 0, len, on.height);
      s.setMinimumValue(0);
      s.setMaximumValue(10);
      panel.childAdd(s);
      this.wins[i] = s;
    }
    layoutColumn(this.wins.slice(22, 25), x, y, cell.x, cell.y, 3);
  }

  /** cWinOptions::BuildPlayButtons */
  private async buildPlayButtons(next: () => string, x0: number): Promise<void> {
    const mgr = await TSWinCtrlMgr.get(this.ctx);
    const panel = this.makeSubpanel(x0);
    this.playPanel = panel;
    const fontSize = playFontSize(LANG);
    const font = mgr.tableFont(fontSize);
    const small = fontSize === 7 && LANG >= 3 && LANG <= 16;
    const checkW = this.checkImg!.width;
    const checkH = this.checkImg!.height;

    const o = strPos(next());
    const cell = strPos(next());
    let x = o.x - x0;
    let y = o.y;
    if (small) y += 5;
    if (LANG === LANG_0x13) y -= 4;
    let maxW = 0;
    // Auto-centering, free will, edge scrolling, sim in background.
    for (let i = 25; i < 29; i++)
      maxW = Math.max(maxW, (await this.makeLabel(i, panel, font, next)).getW());
    layoutColumn(this.wins.slice(25, 29), x, y, cell.x, cell.y, 4);
    if (LANG === LANG_0x13) y += 4;

    // Their check boxes: a quarter of the check image's width to the left, centered on the line.
    x += idiv(-checkW, 4);
    y += idiv(this.wins[B.LblAutoCenter]!.getH() - checkH, 2);
    for (let i = 29; i < 33; i++) {
      const c = this.makeCheck(i, panel);
      await c.init();
      // Free will cannot be changed on downtown lots (houses 21..30).
      if (
        i === B.ChkFreeWill &&
        this.ctx.state.houseNumber > 0x14 &&
        this.ctx.state.houseNumber < 0x1f
      ) {
        setEnabled(c, false);
      }
    }
    layoutColumn(this.wins.slice(29, 33), x, y, cell.x, cell.y, 4);

    // Reset Tutorial: top-right of the subpanel. Its position string is skipped.
    next();
    const reset = new AsyncBtn(CMD_CLICK, await this.ctx.res.image("kOptionTutorialReset"), 4, 1);
    reset.tooltip = next();
    reset.mode = BTN_PUSH;
    panel.childAdd(reset);
    const rx = panel.getW() - reset.getW() - 3;
    reset.moveTo(rx, 7);
    this.wins[B.Reset] = reset;
    this.popupInfo.set(reset, {
      name: next(),
      desc: next(),
      bitmap: await this.ctx.res.image(POPUP_BITMAPS[B.Reset]!),
    });

    // Second column: quick tips, auto snapshot, live PIP, export HTML.
    let y2 = y + (small ? 2 : 4);
    if (LANG === LANG_0x13) y2 = y - 4;
    let x2 = maxW + x + 0x46;
    for (let i = 34; i < 38; i++)
      maxW = Math.max(maxW, (await this.makeLabel(i, panel, font, next)).getW());
    layoutColumn(this.wins.slice(34, 38), x2, y2, cell.x, cell.y, 4);
    if (LANG === LANG_0x13) y2 += 4;

    x2 += idiv(-checkW, 4);
    y2 += idiv(this.wins[B.LblQuickTips]!.getH() - checkH, 2);
    for (let i = 38; i < 42; i++) await this.makeCheck(i, panel).init();
    layoutColumn(this.wins.slice(38, 42), x2, y2, cell.x, cell.y, 4);
  }

  // --- showing ---------------------------------------------------------------

  /** cWinOptions::ShowWindow: back to no subpanel, quick tips refreshed. */
  override showWindow(): void {
    super.showWindow();
    if (this.mode !== Mode.None) this.setMode(Mode.None);
    this.setQuickTips(getOptionsMgr().getQuickTips());
  }

  /** cWinOptions::SetQuickTips: labels open their popup on hover; Reset Tutorial always does. */
  setQuickTips(on: boolean): void {
    const timeout = getOptionsMgr().getDefaultAsyncTimeout();
    this.wins.forEach((w, i) => {
      if (!(w instanceof AsyncBtn)) return;
      if (i === B.Reset) w.setAsync(ASYNC_ON_ENTER, timeout);
      else w.setAsync(on ? ASYNC_ON_ENTER : 0, timeout);
    });
    // The original also forwards to cWinPeople::SetQuickTips (not ported) and the camera panel.
    (this.parent as Partial<WinCPanel> | null)?.camPanel?.setQuickTips(on);
  }

  /** cWinOptions::SetMode */
  private setMode(mode: Mode): void {
    const bobo = getOptionsMgr().getBoboVision();
    if (this.mode !== mode) {
      // With interface effects the old subpanel fades out (AsyncShowHideWin) and the
      // new one fades in after it (message 0x1b); both happen at once here.
      const old = this.panelFor(this.mode);
      old?.hideWindow();
      const btn = this.buttonFor(this.mode);
      btn?.setState(0);
      if (this.popup?.isEnabled()) this.popup.disablePopup();
    }
    this.mode = mode;
    if (this.playPanel) this.applyLotRules(false);
    const panel = this.panelFor(mode);
    panel?.showWindow();
    if (bobo) return;
    if (mode === Mode.Graphics) {
      this.wins[B.ChkAntiAlias]?.hideWindow();
      this.wins[B.LblAntiAlias]?.hideWindow();
    } else if (mode === Mode.Play) {
      this.applyLotRules(true);
    }
    setEnabled(this.wins[B.ChkFreeWill], true);
    setEnabled(this.wins[B.LblFreeWill], true);
  }

  /**
   * SetMode's lot rules for the play subpanel: Reset Tutorial only on
   * residential lots; free will locked on downtown, studio town and magic
   * town lots. The second pass (`showing`) does not touch Reset Tutorial on
   * residential lots and hides it everywhere else.
   */
  private applyLotRules(showing: boolean): void {
    const s = this.ctx.state;
    const house = s.houseNumber;
    const reset = this.wins[B.Reset];
    const check = this.wins[B.ChkFreeWill];
    const label = this.wins[B.LblFreeWill];
    const freeWill = (on: boolean): void => {
      setEnabled(label, on);
      setEnabled(check, on);
      if (on) {
        check?.showWindow();
        label?.showWindow();
      } else {
        check?.hideWindow();
        label?.hideWindow();
      }
    };
    if (s.zoningType === 1) {
      if (showing) {
        check?.showWindow();
        label?.showWindow();
        reset?.showWindow();
        setEnabled(label, true);
        setEnabled(check, true);
      } else {
        reset?.showWindow();
        freeWill(true);
      }
    } else if (
      (house > 0x14 && house < 0x1f) ||
      (house > 0x50 && house < 0x5a) ||
      (house > 0x5c && house < 99)
    ) {
      freeWill(false);
      reset?.hideWindow();
    } else if ((house > 0x27 && house < 0x32) || s.zoningType === 2) {
      reset?.hideWindow();
      freeWill(true);
    }
  }

  private panelFor(mode: Mode): TSWin | null {
    return mode === Mode.Graphics
      ? this.graphicsPanel
      : mode === Mode.Sound
        ? this.soundPanel
        : mode === Mode.Play
          ? this.playPanel
          : null;
  }

  private buttonFor(mode: Mode): TSWinBtn | null {
    const slot =
      mode === Mode.Graphics
        ? B.Graphics
        : mode === Mode.Sound
          ? B.Sound
          : mode === Mode.Play
            ? B.Play
            : -1;
    return (this.wins[slot] as TSWinBtn | undefined) ?? null;
  }

  // --- CPState -> view -------------------------------------------------------

  /** cWinOptions::UpdateViewFromCPState */
  updateViewFromCPState(): void {
    const s: CPState = this.ctx.state;
    if (!(s.dirty & DIRTY_OPTIONS)) return;
    const o = getOptionsMgr();
    const check = (slot: number, on: boolean): void =>
      (this.wins[slot] as TSWinCheck | null)?.setState(on);
    const tri = (slot: number, v: TriState): void =>
      (this.wins[slot] as WinTriRadio | null)?.setVal(v);
    const slider = (slot: number, v: number): void =>
      (this.wins[slot] as TSWinSlider | null)?.setValue(v);
    check(B.ChkAntiAlias, o.getAA());
    check(B.ChkShadows, o.getShadows());
    check(B.ChkLighting, o.getLighting());
    check(B.ChkEffects, o.getBoboVision());
    tri(B.TriTerrain, o.getTerrainDetail());
    tri(B.TriCharacter, o.getCharacterDetail());
    slider(B.SldFX, o.getFXVolume());
    slider(B.SldMusic, o.getMusicVolume());
    slider(B.SldVox, o.getVoxVolume());
    check(B.ChkAutoCenter, o.getAutoCentering());
    check(B.ChkFreeWill, o.getFreeWill());
    check(B.ChkEdgeScroll, o.getEdgeScrolling());
    check(B.ChkSimInBack, o.getSimInBackground());
    check(B.ChkQuickTips, o.getQuickTips());
    check(B.ChkAutoSnap, o.getAutoSnapshots());
    check(B.ChkLivePIP, o.getLivePIP());
    check(B.ChkExportHTML, o.getExportHTML());
    this.wins[B.LblAntiAlias]?.hideWindow();
    this.wins[B.ChkAntiAlias]?.hideWindow();
    if (s.dirty & DIRTY_SAVE_DISABLED) {
      if (s.isSaveDisabled()) this.wins[B.Save]?.hideWindow();
      else this.wins[B.Save]?.showWindow();
    }
  }

  // --- commands ----------------------------------------------------------------

  /** cWinOptions::TSOnCommand */
  override tsOnCommand(cmd: number, src: TSWin): boolean {
    const slot = this.wins.indexOf(src);
    switch (cmd) {
      case CMD_CLICK:
        if (slot === -1) return super.tsOnCommand(cmd, src);
        this.togglePopup(src);
        void this.onButton(slot);
        return true;
      case CMD_SLIDER_CHANGED:
        this.onSlider(src);
        return true;
      case CMD_ASYNC_TIMEOUT:
        // Same toggle as a click, for the labels and Reset Tutorial.
        if (ASYNC_SLOTS(slot)) this.togglePopup(src);
        return true;
      case CMD_CHECK_CHANGED:
        return this.onCheck(slot);
      case CMD_TRIRADIO_CHANGED:
        if (slot === B.TriTerrain)
          getOptionsMgr().setTerrainDetail((src as WinTriRadio).getVal() as TriState);
        else if (slot === B.TriCharacter)
          getOptionsMgr().setCharacterDetail((src as WinTriRadio).getVal() as TriState);
        return true;
      default:
        return true;
    }
  }

  /**
   * TSOnCommand(1 / 0x13) for a button with popup data: the popup shows its
   * title, description and picture, or closes when it already shows them.
   */
  private togglePopup(src: TSWin): void {
    const info = this.popupInfo.get(src);
    const popup = this.popup;
    const client = this.client;
    if (!info || !popup || !client) return;
    if (popup.isEnabled() && src === client.target) {
      popup.disablePopup();
      return;
    }
    client.target?.setState(0);
    client.setName(info.name);
    client.setDesc(info.desc);
    client.setBitmap(0, info.bitmap);
    client.target = src as TSWinBtn;
    popup.enablePopup(client, this);
  }

  /** TSOnCommand(1): the main buttons and Reset Tutorial. */
  private async onButton(slot: number): Promise<void> {
    const s = this.ctx.state;
    const hooks = this.ctx.hooks;
    switch (slot) {
      case B.Nbhd:
        // Downtown, vacation, studio and magic town lots have their own dialogs and
        // screens here; a residential lot asks to save (cSimsApp::DoSave) when dirty.
        if (!s.isSaveDisabled() && hooks?.isLotDirty?.()) {
          if (hooks.doSave && !(await hooks.doSave())) return;
        }
        hooks?.showNeighborhood?.();
        break;
      case B.Save:
        // SaveDowntownDescription(false) first: downtown lots only.
        await hooks?.saveGame?.();
        break;
      case B.Quit:
        // A dirty downtown lot asks about its description first (SaveDowntownDescription);
        // other lots go straight to the framework's quit request, which asks itself.
        await hooks?.quit?.();
        break;
      case B.Graphics:
        this.setMode(this.mode === Mode.Graphics ? Mode.None : Mode.Graphics);
        break;
      case B.Sound:
        this.setMode(this.mode === Mode.Sound ? Mode.None : Mode.Sound);
        break;
      case B.Play:
        this.setMode(this.mode === Mode.Play ? Mode.None : Mode.Play);
        break;
      case B.Reset:
        hooks?.resetTutorial?.();
        break;
    }
  }

  /** TSOnCommand(0xc): a volume slider moved; at 0 it shows the "off" image. */
  private onSlider(src: TSWin): void {
    const o = getOptionsMgr();
    const s = src as TSWinSlider;
    if (src === this.wins[B.SldFX]) o.setFXVolume(s.getValue());
    else if (src === this.wins[B.SldMusic]) o.setMusicVolume(s.getValue());
    else if (src === this.wins[B.SldVox]) o.setVoxVolume(s.getValue());
    else return;
    s.setImage(s.getValue() === 0 ? this.sliderOff! : this.sliderOn!);
  }

  /** TSOnCommand(0x1c): check boxes flip their option. */
  private onCheck(slot: number): boolean {
    const o = getOptionsMgr();
    switch (slot) {
      case B.ChkAntiAlias:
        o.setAA(!o.getAA());
        break;
      case B.ChkShadows:
        o.setShadows(!o.getShadows());
        break;
      case B.ChkLighting:
        o.setLighting(!o.getLighting());
        break;
      case B.ChkEffects:
        o.setBoboVision(!o.getBoboVision());
        break;
      case B.ChkAutoCenter:
        o.setAutoCentering(!o.getAutoCentering());
        break;
      case B.ChkFreeWill: {
        const s = this.ctx.state;
        const h = s.houseNumber;
        const allowed =
          s.zoningType === 1 ||
          (h >= 0x28 && h < 0x32) ||
          s.zoningType === 2 ||
          (h >= 0x51 && h <= 0x59) ||
          (h >= 0x5d && h <= 0x62);
        if (!allowed) {
          // sound: UI_error
          return false;
        }
        o.setFreeWill(!o.getFreeWill());
        break;
      }
      case B.ChkEdgeScroll:
        o.setEdgeScrolling(!o.getEdgeScrolling());
        break;
      case B.ChkSimInBack:
        o.setSimInBackground(!o.getSimInBackground());
        break;
      case B.ChkQuickTips:
        o.setQuickTips(!o.getQuickTips());
        this.setQuickTips(o.getQuickTips());
        break;
      case B.ChkAutoSnap:
        o.setAutoSnapshots(!o.getAutoSnapshots());
        break;
      case B.ChkLivePIP:
        o.setLivePIP(!o.getLivePIP());
        break;
      case B.ChkExportHTML:
        o.setExportHTML(!o.getExportHTML());
        break;
    }
    return true;
  }

  // --- painting and mouse ----------------------------------------------------

  /**
   * TSOnMouseExit / TSOnMouseExitChild: the popup closes when the cursor
   * leaves the panel for a window outside it. Our window manager only
   * notifies the hovered leaf, so the panel watches the cursor itself.
   */
  override pump(nowMs: number): void {
    super.pump(nowMs);
    const inside = this.isVisibleAndAllParentsVisible() && this.containsCursor();
    if (this.mouseInside && !inside && this.popup?.isEnabled()) this.popup.disablePopup();
    this.mouseInside = inside;
  }

  private containsCursor(): boolean {
    const { x, y } = winMgr.cursorPosition();
    const o = winMgr.main.absOrigin();
    for (let w = winMgr.main.windowFromPoint(x - o.x, y - o.y); w; w = w.parent)
      if (w === this) return true;
    return false;
  }

  /** cWinOptions::Plot: the anti-aliasing and shadows boxes follow the options every frame. */
  override plot(ctx: CanvasRenderingContext2D, ox: number, oy: number): void {
    const o = getOptionsMgr();
    const sync = (slot: number, on: boolean): void => {
      const c = this.wins[slot] as TSWinCheck | null;
      if (c && c.getState() !== on) c.setState(on);
    };
    sync(B.ChkAntiAlias, o.getAA());
    sync(B.ChkShadows, o.getShadows());
    super.plot(ctx, ox, oy);
  }

  /** cWinOptions::TSPaint: the panel background, then the two toothpick separators. */
  override tsPaint(g: Gfx): void {
    if (this.background) g.blitPart(this.background, 0, 0, this.getW(), this.getH(), 0, 0);
    if (this.toothPick1) g.blit(this.toothPick1, 0x10, 0x33);
    if (this.toothPick2) g.blit(this.toothPick2, 0xde, 6);
  }

  override shutdown(): void {
    if (this.popup) {
      this.popup.disablePopup();
      this.popup.parent?.childDelete(this.popup);
      this.popup = null;
    }
    super.shutdown();
  }
}

/** SetFlag(2, on): enabled flag; check boxes also gray their button. */
function setEnabled(w: TSWin | null | undefined, on: boolean): void {
  if (!w) return;
  w.setFlag(WF_ENABLED, on);
  if (w instanceof TSWinCheck) w.btn?.setEnabled(on);
  else if (w instanceof TSWinBtn) w.setEnabled(on);
}
