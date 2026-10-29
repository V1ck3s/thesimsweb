/**
 * Message box (cTSWinMsgBox).
 *
 * From the decompiled class:
 *  - a title label (DefaultLabel, single line) and a message label
 *    (DefaultLabel, centered, word-wrapped, no gutters). The box is at least
 *    200 px wide (title + 32); a message that needs several lines widens the
 *    box to 3/2 of that, then 4/3 of the new width (Init);
 *  - buttons are cTSSystemButtons (DefaultPushBtn) whose id is the result:
 *    MB_OK [OK=3], MB_OKCANCEL [OK=3, Cancel=1], MB_YESNO [Yes=4, No=2],
 *    MB_YESNOCANCEL [Yes=4, No=2, Cancel=1]; captions are UIText STR# 152
 *    entries (cSimsApp: OK, Cancel, Yes, No);
 *  - PositionButtons spreads them evenly along the bottom, 16 px from the edges;
 *    the box is centered on the main window;
 *  - layout: title at (16, 16), message 8 px under it, width - 32 wide;
 *    height = title + message + buttons + 0x38;
 *  - background: kCatalogPopupBackTiles as a 3x3 frame (BltEdge, center
 *    filled); without it a (0xbc, 0xbc, 0xbc) fill with a light/dark bevel;
 *  - Enter presses the first button, Escape the second (cancel), the yes/no
 *    shortcut letters (UIText STR# 161 entries 7 and 8) the yes/no buttons; a
 *    keyboard or timeout press shows the button down for 200 ms (TSOnTimerMsg);
 *    with a default button and a timeout, the default button is pressed after
 *    the timeout (TSBeginModal).
 */

import type { GameContext } from "../context.js";
import { TSWinBtn } from "./btn.js";
import { SYS_POPUP_TILES, TSWinCtrlMgr } from "./ctrlmgr.js";
import { bltEdge, TSWinDlg } from "./dlg.js";
import { rgb } from "./syscolors.js";
import { TSSystemButton } from "./systembutton.js";
import { TSWinText, WTF_MULTILINE, WTF_PARENT_MOUSE } from "./text.js";
import { Gfx, TSWin } from "./tswin.js";
import { winMgr } from "./winmgr.js";

export const MB_OK = 0;
export const MB_OKCANCEL = 1;
export const MB_YESNO = 2;
export const MB_YESNOCANCEL = 3;

export const IDCANCEL = 1;
export const IDNO = 2;
export const IDOK = 3;
export const IDYES = 4;

/** cSimsApp: SetButtonLabel(id, UIText STR# 152 entry). */
const BUTTON_LABEL_ENTRY: Record<number, number> = { [IDOK]: 0, [IDCANCEL]: 1, [IDYES]: 2, [IDNO]: 3 };
const LABELS_STR = 152;
const SHORTCUTS_STR = 161;

const MARGIN = 16;
const MIN_WIDTH = 200;
const PRESS_MS = 200;

export class TSWinMsgBox extends TSWinDlg {
  private titleLabel: TSWinText | null = null;
  /** +0xe8 / +0xec / +0xf0: first, second (cancel) and third buttons. */
  private btn1: TSWinBtn | null = null;
  private btn2: TSWinBtn | null = null;
  private btn3: TSWinBtn | null = null;
  private defaultBtn: TSWinBtn | null = null;
  private background: ImageBitmap | null = null;
  private fillColor = rgb(0xbc, 0xbc, 0xbc);
  private lightColor = rgb(0xe4, 0xe4, 0xe4);
  private darkColor = rgb(0x94, 0x94, 0x94);
  private pressing = false;
  private pressTimer = 0;
  private ended = false;
  private yesKey = "";
  private noKey = "";

  constructor(
    private readonly ctx: GameContext,
    private readonly message: string,
    private readonly title: string,
    private readonly type = MB_OK,
    /** 1-based index of the default button (0: none). */
    private readonly defaultIndex = 0,
    private readonly timeoutMs = 0,
  ) {
    super();
  }

  /** cTSWinMsgBox::GetButtonLabel(id): UIText STR# 152 (OK, Cancel, Yes, No). */
  static getButtonLabel(ctx: GameContext, id: number): string {
    return ctx.strings.get("UIText", LABELS_STR, BUTTON_LABEL_ENTRY[id] ?? 0);
  }

  /** Shows a message box modally; resolves with the id of the button pressed. */
  static async show(
    ctx: GameContext,
    message: string,
    title: string,
    type = MB_OK,
    defaultIndex = 0,
    timeoutMs = 0,
  ): Promise<number> {
    const box = new TSWinMsgBox(ctx, message, title, type, defaultIndex, timeoutMs);
    if (!(await box.init())) return 0;
    return winMgr.doModalWin(box);
  }

  /** cTSWinMsgBox::SetMainFillColor: the fill and its +-40 bevel colors. */
  setMainFillColor(r: number, g: number, b: number): void {
    const c = (v: number): number => Math.max(0, Math.min(255, v));
    this.lightColor = rgb(c(r + 0x28), c(g + 0x28), c(b + 0x28));
    this.darkColor = rgb(c(r - 0x28), c(g - 0x28), c(b - 0x28));
    this.fillColor = rgb(r, g, b);
  }

  override async init(): Promise<boolean> {
    const mgr = await TSWinCtrlMgr.get(this.ctx);
    const strings = this.ctx.strings;
    const label = (id: number): string => strings.get("UIText", LABELS_STR, BUTTON_LABEL_ENTRY[id]!);
    this.yesKey = strings.get("UIText", SHORTCUTS_STR, 6).charAt(0).toLowerCase();
    this.noKey = strings.get("UIText", SHORTCUTS_STR, 7).charAt(0).toLowerCase();
    this.background = mgr.systemBMP(SYS_POPUP_TILES);

    const defaultLabel = (text: string): TSWinText => {
      const t = new TSWinText();
      t.setCaption(text);
      t.setFont(mgr.systemFont(0));
      t.setAlignment(1);
      t.setBackgroundOpaque(false);
      t.setWinTextFlag(WTF_MULTILINE, false);
      t.fitWindowToText();
      return t;
    };

    let minW = 0;
    if (this.title) {
      const t = defaultLabel(this.title);
      t.setBackgroundOpaque(false);
      t.setFillColor(this.fillColor);
      t.setWinTextFlag(WTF_PARENT_MOUSE, true);
      this.childAdd(t);
      t.fitWindowToText();
      this.titleLabel = t;
      minW = t.getW() + 2 * MARGIN;
    }
    let width = Math.max(MIN_WIDTH, minW);

    const m = defaultLabel(this.message);
    m.setAlignment(3);
    m.setWinTextFlag(WTF_MULTILINE, true);
    m.setGutters(0, 0);
    this.childAdd(m);
    const font = mgr.systemFont(0);
    const fitWidth = (w: number): void => {
      m.setArea(m.area.left, m.area.top, m.area.left + w, m.area.bottom);
      m.fitWindowToText();
    };
    fitWidth(width - 2 * MARGIN);
    if (font.calculateNumberOfLines(this.message, width - 2 * MARGIN) > 1) {
      width = Math.trunc(((width - 2 * MARGIN) * 3) / 2) + 2 * MARGIN;
      fitWidth(width - 2 * MARGIN);
    }
    if (font.calculateNumberOfLines(this.message, width - 2 * MARGIN) > 1) {
      fitWidth(Math.trunc(((width - 2 * MARGIN) * 4) / 3));
    }

    const add = (id: number): TSWinBtn => {
      const b = TSSystemButton.defaultPushBtn(mgr, id, label(id));
      this.childAdd(b);
      return b;
    };
    if (this.type === MB_OK) {
      this.btn1 = this.btn2 = add(IDOK);
      if (this.defaultIndex === 1) this.defaultBtn = this.btn1;
    } else if (this.type === MB_OKCANCEL || this.type === MB_YESNO) {
      const yesNo = this.type === MB_YESNO;
      this.btn1 = add(yesNo ? IDYES : IDOK);
      this.btn2 = add(yesNo ? IDNO : IDCANCEL);
      if (this.defaultIndex === 1) this.defaultBtn = this.btn1;
      else if (this.defaultIndex === 2) this.defaultBtn = this.btn2;
    } else {
      this.btn1 = add(IDYES);
      const no = add(IDNO);
      this.btn2 = add(IDCANCEL);
      this.btn3 = no;
      if (this.defaultIndex === 1) this.defaultBtn = this.btn1;
      else if (this.defaultIndex === 2) this.defaultBtn = no;
      else if (this.defaultIndex === 3) this.defaultBtn = this.btn2;
    }

    const titleW = this.titleLabel ? this.titleLabel.getW() : 0;
    const titleH = this.titleLabel ? this.titleLabel.getH() : 0;
    const w = Math.max(this.positionButtons(), titleW + 2 * MARGIN, m.getW() + 2 * MARGIN);
    this.setArea(0, 0, w, titleH + m.getH() + this.btn1!.getH() + 0x38);
    this.positionButtons();
    if (this.titleLabel) {
      const t = this.titleLabel;
      t.setArea(MARGIN, MARGIN, MARGIN + w - 2 * MARGIN, MARGIN + t.getH());
    }
    const top = this.titleLabel ? this.titleLabel.area.bottom + 8 : MARGIN;
    m.setArea(MARGIN, top, MARGIN + w - 2 * MARGIN, top + m.getH());
    this.centerWindowInRect(winMgr.main.area);
    return true;
  }

  /** cTSWinMsgBox::PositionButtons: returns the width the buttons need. */
  private positionButtons(): number {
    const all = [this.btn1, this.btn2, this.btn3];
    const maxW = Math.max(0, ...all.map((b) => (b ? b.getW() : 0)));
    const order =
      this.type === MB_YESNOCANCEL
        ? [this.btn1, this.btn3, this.btn2]
        : this.type === MB_OK
          ? [this.btn1]
          : [this.btn1, this.btn2];
    const n = order.length;
    let total = 2 * MARGIN;
    const gap = Math.max(MARGIN, Math.trunc((this.getW() - 2 * MARGIN - n * maxW) / (n + 1)));
    order.forEach((b, i) => {
      if (!b) return;
      total += gap + maxW;
      b.setArea(b.area.left, b.area.top, b.area.left + maxW, b.area.bottom);
      const x = MARGIN + gap * (i + 1) + maxW * i;
      const y = this.getH() - b.getH() - MARGIN;
      b.setArea(x, y, x + b.getW(), y + b.getH());
    });
    return total + gap;
  }

  override tsBeginModal(): void {
    this.ended = false;
    if (this.defaultBtn && this.timeoutMs > 0) {
      this.pressTimer = window.setTimeout(() => this.tsOnTimerMsg(), this.timeoutMs);
    }
  }

  override tsEndModal(): void {
    window.clearTimeout(this.pressTimer);
  }

  /** cTSWinMsgBox::TSOnTimerMsg: presses the default button, releases it 200 ms later. */
  private tsOnTimerMsg(): void {
    const b = this.defaultBtn;
    if (!b) {
      this.pressing = false;
      return;
    }
    if (!this.pressing) {
      this.pressing = true;
      b.entered = true;
      b.tsOnMouseDownL();
      this.pressTimer = window.setTimeout(() => this.tsOnTimerMsg(), PRESS_MS);
    } else {
      this.pressing = false;
      b.tsOnMouseUpL(0, 0);
    }
  }

  private pressKey(b: TSWinBtn | null): boolean {
    if (this.pressing) return false;
    this.defaultBtn = b;
    this.tsOnTimerMsg();
    return true;
  }

  override tsOnKeyDown(key: string): boolean {
    if (key === "Escape") return this.pressKey(this.btn2);
    if (key === "Enter") return this.pressKey(this.btn1);
    const c = key.toLowerCase();
    if (this.type === MB_YESNO || this.type === MB_YESNOCANCEL) {
      if (c === this.yesKey) return this.pressKey(this.btn1);
      if (c === this.noKey) return this.pressKey(this.type === MB_YESNOCANCEL ? this.btn3 : this.btn2);
    }
    return true;
  }

  override tsOnCommand(cmd: number, source: TSWin): boolean {
    if (!(source instanceof TSWinBtn) || !this.children.includes(source) || this.ended) return super.tsOnCommand(cmd, source);
    this.ended = true;
    this.tsEndDialog(source.id);
    return true;
  }

  override tsPaint(g: Gfx): void {
    const w = this.getW();
    const h = this.getH();
    const img = this.background;
    if (img) {
      bltEdge(g, img, Math.trunc(img.width / 3), Math.trunc(img.height / 3), w, h, true);
      return;
    }
    g.fill(0, 0, w, h, this.fillColor);
    g.fill(0, 0, w - 1, 1, this.lightColor);
    g.fill(0, 0, 1, h - 1, this.lightColor);
    g.fill(w - 1, 0, 1, h - 1, this.darkColor);
    g.fill(0, h - 1, w - 1, 1, this.darkColor);
  }
}
