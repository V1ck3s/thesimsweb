/**
 * Generic dialog (cTSWinGenDlg): a cTSWinDlg with a background and helpers to
 * add the default controls.
 *
 * From the decompiled class:
 *  - background style (constructor): 0 = frame from kSMSystemGenDlgEdge
 *    (3x3 cells of 10x10 px, the center left untouched, BltEdge) with the
 *    title centered in a 6 px band at the top (DrawTextPara, the size 10 font
 *    in white); 1 = a bitmap (SetBackground) copied at the origin; 2 = the
 *    fill color;
 *  - AddText: a cTSWinText in the title font, opaque (unless asked
 *    otherwise) and filled with DefaultColor(1), behind the other children; AddBtn / AddCheck /
 *    AddSlider / Scrollbar: the cTSWinCtrlMgr defaults placed at a rectangle;
 *  - TSOnCommand: a click on a child button whose id is 0 ends the dialog
 *    with 0; every other command goes to the callback set with setCallback.
 *    (AddBtn gives its buttons a unique non-zero id.)
 */

import type { GameContext } from "../context.js";
import { ALIGN_CENTER, type FfnFont } from "../res/ffn.js";
import { TSWinBtn } from "./btn.js";
import { bltEdge, TSWinDlg } from "./dlg.js";
import { TSWinCheck } from "./check.js";
import { SYS_GENDLG_EDGE, TSWinCtrlMgr } from "./ctrlmgr.js";
import { TSWinScrollbar } from "./scrollbar.js";
import { TSWinSlider } from "./slider.js";
import { DEFAULT_COLORS, rgb } from "./syscolors.js";
import { TSSystemButton } from "./systembutton.js";
import { TSWinText } from "./text.js";
import { Gfx, TSWin, type Rect } from "./tswin.js";

export const GENDLG_EDGE = 0;
export const GENDLG_BITMAP = 1;
export const GENDLG_FILL = 2;

/** lbl_105BD098: the title band height is entry 1. */
const TITLE_BAND = 6;
/** lbl_105BD09C: one cell of the edge bitmap. */
const EDGE_CELL = 10;
const TITLE_COLOR = rgb(0xff, 0xff, 0xff);

let nextControlId = 0x10000;

export class TSWinGenDlg extends TSWinDlg {
  title = "";
  fillColor = "#000000";
  private mgr: TSWinCtrlMgr | null = null;
  private titleFont: FfnFont | null = null;
  private background: ImageBitmap | null = null;
  private callback: ((cmd: number, src: TSWin) => void) | null = null;

  constructor(
    protected readonly ctx: GameContext,
    readonly backgroundStyle = GENDLG_EDGE,
  ) {
    super();
  }

  override async init(): Promise<boolean> {
    this.mgr = await TSWinCtrlMgr.get(this.ctx);
    if (this.backgroundStyle === GENDLG_EDGE && !this.background) this.background = this.mgr.systemBMP(SYS_GENDLG_EDGE);
    this.titleFont ??= await this.ctx.fonts.acquire(10);
    return true;
  }

  private get ctrl(): TSWinCtrlMgr {
    if (!this.mgr) throw new Error("TSWinGenDlg used before init()");
    return this.mgr;
  }

  setBackground(img: ImageBitmap): void {
    this.background = img;
  }

  setCallback(cb: (cmd: number, src: TSWin) => void): void {
    this.callback = cb;
  }

  private place<T extends TSWin>(w: T, r: Rect): T {
    w.setArea(r.left, r.top, r.right, r.bottom);
    this.childAdd(w);
    return w;
  }

  /** cTSWinGenDlg::AddText */
  addText(r: Rect, text: string, alignment: number, transparent = false): TSWinText {
    const t = new TSWinText();
    t.setArea(r.left, r.top, r.right, r.bottom);
    t.setCaption(text);
    if (this.titleFont) t.setFont(this.titleFont);
    t.setTextColor(TITLE_COLOR);
    t.setAlignment(alignment);
    t.setWinTextFlag(1, true);
    t.setBackgroundOpaque(!transparent);
    t.setFillColor(DEFAULT_COLORS[1]!);
    t.id = nextControlId++;
    this.childAdd(t);
    this.childToBack(t);
    return t;
  }

  /** cTSWinGenDlg::AddBtn */
  addBtn(r: Rect, caption: string): TSSystemButton {
    const b = TSSystemButton.defaultPushBtn(this.ctrl, 0, caption);
    b.id = nextControlId++;
    return this.place(b, r);
  }

  /** cTSWinGenDlg::AddCheck (init() it before use). */
  addCheck(r: Rect, caption: string): TSWinCheck {
    const c = TSWinCheck.defaultCheckBox(this.ctrl, 0, caption);
    c.id = nextControlId++;
    return this.place(c, r);
  }

  /** cTSWinGenDlg::AddSlider */
  addSlider(r: Rect, min: number, max: number, value: number, direction: number): TSWinSlider {
    const s = TSWinSlider.defaultSlider(this.ctrl, 0, direction);
    s.id = nextControlId++;
    this.place(s, r);
    s.setMinimumValue(min);
    s.setMaximumValue(max);
    s.setValue(value);
    return s;
  }

  /** cTSWinGenDlg::Scrollbar */
  addScrollbar(r: Rect, min: number, max: number, value: number, direction: number): TSWinScrollbar {
    const s = TSWinScrollbar.defaultScrollbar(this.ctrl, 0, direction);
    s.id = nextControlId++;
    this.place(s, r);
    s.setMinimumValue(min);
    s.setMaximumValue(max);
    s.setValue(value);
    return s;
  }

  override tsOnCommand(cmd: number, source: TSWin): boolean {
    // Button clicks arrive with the button id as command (SendButtonCommand(1) in the original).
    if (source instanceof TSWinBtn) {
      if (this.children.includes(source)) {
        if (source.id === 0) this.tsEndDialog(0);
        else this.callback?.(1, source);
      }
    } else {
      this.callback?.(cmd, source);
    }
    return false;
  }

  override tsPaint(g: Gfx): void {
    const w = this.getW();
    const h = this.getH();
    if (this.backgroundStyle === GENDLG_EDGE) {
      if (this.background) bltEdge(g, this.background, EDGE_CELL, EDGE_CELL, w, h, false);
      if (this.title && this.titleFont) {
        const top = g.oy + Math.trunc((TITLE_BAND - this.titleFont.height) / 2);
        const rect = { left: g.ox, top, right: g.ox + w, bottom: g.oy + TITLE_BAND };
        this.titleFont.drawTextPara(g.ctx, rect, this.title, ALIGN_CENTER, TITLE_COLOR);
      }
    } else if (this.backgroundStyle === GENDLG_BITMAP) {
      if (this.background) g.blitPart(this.background, 0, 0, w, h, 0, 0);
    } else {
      g.fill(0, 0, w, h, this.fillColor);
    }
  }
}
