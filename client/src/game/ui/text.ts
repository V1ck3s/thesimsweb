/**
 * Static text window (cTSWinText).
 *
 * From the decompiled class:
 *  - gutters (+0xd4/+0xd8) default to 2 px; the text rectangle (+0xdc..+0xe8)
 *    is recomputed by calc_text_pos whenever the caption, alignment or size
 *    changes;
 *  - alignment (+0xf8, SetAlignment) 0/1 = left, 2/3 = centered, 4/5 = right;
 *    odd values also center the text block vertically. It maps to the
 *    DrawTextPara output style (+0x104);
 *  - tWinTextFlag (+0xec) defaults to 7: 1 = mouse messages go to the parent
 *    (our dispatcher already bubbles unhandled events), 2 = multi-line (word
 *    wrap; otherwise the text area is one TSTextArea line), 4 = opaque
 *    background filled with the fill color (cTSWin+0x64, black by default);
 *  - the text color is the font's (InitSimsColors sets every table font to
 *    UI_FONT_COLOR) unless SetTextColor was called.
 */

import { ALIGN_CENTER, ALIGN_LEFT, ALIGN_RIGHT, type FfnFont } from "../res/ffn.js";
import { UI_FONT_COLOR } from "./syscolors.js";
import { Gfx, TSWin, type Rect } from "./tswin.js";

/** cITSWinText::tWinTextFlag */
export const WTF_PARENT_MOUSE = 0x1;
export const WTF_MULTILINE = 0x2;
export const WTF_OPAQUE = 0x4;

export class TSWinText extends TSWin {
  font: FfnFont | null = null;
  caption = "";
  textColor = UI_FONT_COLOR;
  /** cTSWin+0x64, used when WTF_OPAQUE is set. */
  fillColor = "#000000";
  /** DrawTextPara output style (+0x104), derived from the alignment. */
  align = ALIGN_LEFT;
  winTextFlags = WTF_PARENT_MOUSE | WTF_MULTILINE | WTF_OPAQUE;
  private alignment = 0;
  private gutterX = 2;
  private gutterY = 2;
  private textRect: Rect = { left: 0, top: 0, right: 8, bottom: 8 };

  override async init(): Promise<boolean> {
    this.calcTextPos();
    return true;
  }

  setFont(font: FfnFont): void {
    this.font = font;
    // The original only invalidates; recomputing keeps a later SetFont from
    // leaving a vertically-centered text block measured without a font.
    this.calcTextPos();
  }

  setCaption(text: string): void {
    this.caption = text;
    this.calcTextPos();
  }

  setTextColor(color: string): void {
    this.textColor = color;
  }

  setFillColor(color: string): void {
    this.fillColor = color;
  }

  setGutters(x: number, y: number): void {
    this.gutterX = x;
    this.gutterY = y;
  }

  /** SetAlignment: 0..5, see the file comment. */
  setAlignment(a: number): void {
    if (a === this.alignment || a < 0 || a > 5) return;
    this.align = a < 2 ? ALIGN_LEFT : a < 4 ? ALIGN_CENTER : ALIGN_RIGHT;
    this.alignment = a;
    this.calcTextPos();
  }

  getWinTextFlag(f: number): boolean {
    return (this.winTextFlags & f) !== 0;
  }

  setWinTextFlag(f: number, on: boolean): void {
    this.winTextFlags = on ? this.winTextFlags | f : this.winTextFlags & ~f;
    if (f === WTF_MULTILINE) this.calcTextPos();
  }

  setBackgroundOpaque(on: boolean): void {
    this.setWinTextFlag(WTF_OPAQUE, on);
  }

  override setArea(left: number, top: number, right: number, bottom: number): void {
    const resized = right - left !== this.getW() || bottom - top !== this.getH();
    super.setArea(left, top, right, bottom);
    if (resized) this.calcTextPos();
  }

  /** cTSWinText::get_min_text_area */
  getMinTextArea(): Rect {
    if (!this.font) return { left: 0, top: 0, right: 0, bottom: 0 };
    if (!this.getWinTextFlag(WTF_MULTILINE)) {
      const a = this.font.textArea(this.caption);
      return { left: 0, top: 0, right: a.w, bottom: a.h };
    }
    const width = Math.max(0, this.getW() - this.gutterX * 2);
    const lines = this.font.calculateNumberOfLines(this.caption, width);
    return { left: 0, top: 0, right: width, bottom: lines * this.font.height };
  }

  /** cTSWinText::calc_text_pos: text rectangle in window coordinates. */
  private calcTextPos(): void {
    if (!this.caption) return;
    if (this.alignment & 1) {
      const r = this.getMinTextArea();
      const h = r.bottom - r.top;
      const top = ((this.getH() - h) / 2) | 0;
      this.textRect = { left: this.gutterX, top, right: this.getW(), bottom: top + h };
    } else {
      this.textRect = {
        left: this.gutterX,
        top: this.gutterY,
        right: this.getW() - this.gutterX,
        bottom: this.getH() - this.gutterY,
      };
    }
  }

  /** cTSWinText::FitWindowToText: the minimal text area plus the gutters. */
  fitWindowToText(): void {
    const r = this.getMinTextArea();
    const w = r.right - r.left + this.gutterX * 2;
    const h = r.bottom - r.top + this.gutterY * 2;
    this.setArea(this.area.left, this.area.top, this.area.left + w, this.area.top + h);
  }

  /** cTSWinText::ResizeWindowForExactLineHeights */
  resizeWindowForExactLineHeights(): void {
    if (!this.font) return;
    const lh = this.font.height;
    const h = Math.trunc(this.getH() / lh) * lh;
    if (h !== this.getH()) this.setSize(this.getW(), h);
  }

  override tsPaint(g: Gfx): void {
    if (!this.font) return;
    if (this.getWinTextFlag(WTF_OPAQUE)) g.fill(0, 0, this.getW(), this.getH(), this.fillColor);
    const r = this.textRect;
    const rect = { left: g.ox + r.left, top: g.oy + r.top, right: g.ox + r.right, bottom: g.oy + r.bottom };
    this.font.drawTextPara(g.ctx, rect, this.caption, this.align, this.textColor);
  }
}
