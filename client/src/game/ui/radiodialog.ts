/**
 * Radio dialog (cWinRadioDialogBox, opened by cSimsApp::RadioDialog): a
 * message box whose body lists radio choices, with OK / Cancel.
 *
 * From the decompiled class:
 *  - title label (DefaultLabel), message label (alignment 3, multiline, no
 *    gutters), both sized like cTSWinMsgBox (at least 200 px, widened to 3/2
 *    then 4/3 when the message wraps);
 *  - buttons: +0xe8 = DefaultPushBtn id 2 with label 2 (SetButtonLabel(2) =
 *    UIText STR# 152 entry 0, "OK"), +0xec = id 1 with label 1 (entry 1,
 *    "Cancel"), both one-shot;
 *  - one cTSWinBtn per choice with kNewOptionRadio (4 frames), its caption a
 *    cTSWinText in the title's font; the first choice starts selected
 *    (kNewOptionRadioSelected, state 1). Clicking a choice gives every radio
 *    the plain image and state 0, the clicked one the selected image, state 1;
 *  - PositionButtons: the radios are centered as a block (x = (W - 8 -
 *    widest caption - radio width) / 2), one row of max(caption, radio)
 *    height each, the last row ending 0x20 + OK's height above the bottom;
 *    the caption 8 px right of its radio. OK / Cancel at the bottom 16 px in,
 *    spread like the message box (gap = max(16, (W - 32 - 2 * bw) / 3));
 *  - height = title + message + n * (row + 8) + OK + 0x40 (0x38 without
 *    choices);
 *  - TSOnCommand: OK ends with the index of the selected radio, Cancel with
 *    -1 (only the first press counts); Enter presses OK, Escape Cancel, the
 *    button shown down for 200 ms (TSOnTimerMsg).
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

const LABELS_STR = 152;
const MARGIN = 16;
const MIN_WIDTH = 200;
const PRESS_MS = 200;
const ID_OK = 2;
const ID_CANCEL = 1;

export class WinRadioDialogBox extends TSWinDlg {
  private titleLabel: TSWinText | null = null;
  private messageLabel: TSWinText | null = null;
  private ok: TSWinBtn | null = null;
  private cancel: TSWinBtn | null = null;
  private readonly radios: TSWinBtn[] = [];
  private readonly captions: TSWinText[] = [];
  private radioImage: ImageBitmap | null = null;
  private radioSelected: ImageBitmap | null = null;
  private background: ImageBitmap | null = null;
  private readonly fillColor = rgb(0xbc, 0xbc, 0xbc);
  private readonly lightColor = rgb(0xe4, 0xe4, 0xe4);
  private readonly darkColor = rgb(0x94, 0x94, 0x94);
  /** +0x130: presses counted (only the first one ends the dialog). */
  private presses = 0;
  private pressing: TSWinBtn | null = null;

  constructor(
    private readonly ctx: GameContext,
    private readonly message: string,
    private readonly title: string,
    private readonly choices: readonly string[],
  ) {
    super();
  }

  /** cSimsApp::RadioDialog: resolves with the chosen index, or -1 (Cancel). */
  static async show(ctx: GameContext, message: string, title: string, choices: readonly string[]): Promise<number> {
    const box = new WinRadioDialogBox(ctx, message, title, choices);
    if (!(await box.init())) return -1;
    return winMgr.doModalWin(box);
  }

  override async init(): Promise<boolean> {
    const mgr = await TSWinCtrlMgr.get(this.ctx);
    const label = (i: number): string => this.ctx.strings.get("UIText", LABELS_STR, i);
    this.background = mgr.systemBMP(SYS_POPUP_TILES);
    this.radioImage = await this.ctx.res.image("kNewOptionRadio");
    this.radioSelected = await this.ctx.res.image("kNewOptionRadioSelected");
    const font = mgr.systemFont(0);

    const defaultLabel = (text: string): TSWinText => {
      const t = new TSWinText();
      t.setCaption(text);
      t.setFont(font);
      t.setAlignment(1);
      t.setBackgroundOpaque(false);
      t.setWinTextFlag(WTF_MULTILINE, false);
      t.fitWindowToText();
      return t;
    };

    let minW = 0;
    if (this.title) {
      const t = defaultLabel(this.title);
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
    this.messageLabel = m;
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

    this.ok = TSSystemButton.defaultPushBtn(mgr, ID_OK, label(0));
    this.childAdd(this.ok);
    this.cancel = TSSystemButton.defaultPushBtn(mgr, ID_CANCEL, label(1));
    this.childAdd(this.cancel);

    this.choices.forEach((c, i) => {
      const r = new TSWinBtn(10 + i, this.radioImage, 4);
      this.childAdd(r);
      this.radios.push(r);
      const t = new TSWinText();
      t.setFont(font);
      t.setCaption(c);
      this.childAdd(t);
      t.setAlignment(2);
      t.setBackgroundOpaque(false);
      t.setWinTextFlag(WTF_MULTILINE, false);
      t.fitWindowToText();
      this.captions.push(t);
    });
    const first = this.radios[0];
    if (first && this.radioSelected) {
      first.setImage(this.radioSelected, 4);
      first.setState(1);
    }

    let w = this.positionButtons();
    const titleH = this.titleLabel ? this.titleLabel.getH() : 0;
    let h: number;
    if (this.radios.length === 0) {
      h = titleH + m.getH() + this.ok.getH() + 0x38;
    } else {
      const row = Math.max(this.captions[0]!.getH(), this.radios[0]!.getH());
      h = titleH + m.getH() + this.radios.length * (row + 8) + this.ok.getH() + 0x40;
    }
    if (this.titleLabel) w = Math.max(w, this.titleLabel.getW() + 2 * MARGIN);
    w = Math.max(w, m.getW() + 2 * MARGIN);
    this.setArea(0, 0, w, h);
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

  /** cWinRadioDialogBox::PositionButtons: returns the width the OK / Cancel row needs. */
  private positionButtons(): number {
    const W = this.getW();
    const H = this.getH();
    const ok = this.ok!;
    const cancel = this.cancel!;
    if (this.radios.length) {
      const maxText = Math.max(0, ...this.captions.map((t) => t.getW()));
      const row = Math.max(this.captions[0]!.getH(), this.radios[0]!.getH());
      const radioW = this.radios[0]!.getW();
      const x = Math.trunc((W - 8 - maxText - radioW) / 2);
      const n = this.radios.length;
      this.radios.forEach((r, i) => {
        const y = H - 0x20 - ok.getH() - row * (n - i);
        r.setArea(x, y, x + r.getW(), y + r.getH());
        const t = this.captions[i]!;
        const tx = x + r.getW() + 8;
        t.setArea(tx, y, tx + t.getW(), y + t.getH());
      });
    }
    const bw = Math.max(ok.getW(), cancel.getW());
    const gap = Math.max(MARGIN, Math.trunc((W - 2 * MARGIN - 2 * bw) / 3));
    let total = 2 * MARGIN;
    [ok, cancel].forEach((b, i) => {
      total += gap + bw;
      const x = MARGIN + gap * (i + 1) + bw * i;
      const y = H - b.getH() - MARGIN;
      b.setArea(x, y, x + bw, y + b.getH());
    });
    return total + gap;
  }

  private selected(): number {
    return this.radios.findIndex((r) => r.state !== 0);
  }

  override tsOnCommand(cmd: number, source: TSWin): boolean {
    // cTSWinBtn posts its id: 2 OK, 1 Cancel, 10 + i the radios.
    if (!(source instanceof TSWinBtn) || !this.children.includes(source)) return super.tsOnCommand(cmd, source);
    const ri = this.radios.indexOf(source);
    if (ri >= 0) {
      for (const r of this.radios) {
        if (this.radioImage) r.setImage(this.radioImage, 4);
        r.setState(0);
      }
      if (this.radioSelected) source.setImage(this.radioSelected, 4);
      source.setState(1);
      return true;
    }
    this.presses++;
    if (this.presses === 1) this.tsEndDialog(source === this.cancel ? -1 : this.selected());
    return true;
  }

  /** TSOnTimerMsg: a keyboard press shows the button down for 200 ms. */
  private press(b: TSWinBtn | null): boolean {
    if (!b || this.pressing) return false;
    this.pressing = b;
    b.entered = true;
    b.tsOnMouseDownL();
    window.setTimeout(() => {
      this.pressing = null;
      b.tsOnMouseUpL(0, 0);
    }, PRESS_MS);
    return true;
  }

  override tsOnKeyDown(key: string): boolean {
    if (key === "Escape") return this.press(this.cancel);
    if (key === "Enter") return this.press(this.ok);
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
