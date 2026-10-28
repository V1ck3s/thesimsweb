/**
 * cWinTextWrap: a word-wrapped text block whose first lines can leave room
 * for a picture at the top left (cWinPictureDialog's text).
 *
 * From the decompiled class:
 *  - the font is entry 12 of the global font table (lbl_105BA2E8 + 0x30),
 *    drawn in its own color (UI_FONT_COLOR) with DrawTextPara;
 *  - AddText appends "\n\n" (lbl_105BC5EC) before any new text, then DoLayout;
 *  - SetTopLeftImageSize(w, h): the indent (+0xcc) and its height (+0xd0)
 *    rounded to the nearest whole number of lines; the first block starts at
 *    (w, 0) (+0xd8 / +0xdc), the second at (0, rounded h) (+0xec / +0xf0);
 *  - DoLayout: the first block holds (indent height / line height) lines
 *    (+0xe8) of width - indent (+0xe0); when the text needs more lines, the
 *    first block keeps that many (+0xe4 = their characters) and the rest wraps
 *    under the picture at the full width (+0xf4, +0xf8 lines): the window is
 *    indent height + those lines tall; otherwise everything is in the first
 *    block and the window is the indent height tall. SetArea and SetCaption
 *    redo the layout;
 *  - TSPaint: the first block, then the rest. A rest of a single line that
 *    fits the indented width continues the indented column instead.
 */

import type { FfnFont } from "../res/ffn.js";
import { ALIGN_LEFT } from "../res/ffn.js";
import { UI_FONT_COLOR } from "./syscolors.js";
import { Gfx, TSWin } from "./tswin.js";

/** lbl_105BC5EC: the separator AddText puts between texts. */
const TEXT_SEPARATOR = "\n\n";

export class WinTextWrap extends TSWin {
  text = "";
  /** +0xd4 */
  font: FfnFont | null = null;
  /** +0xcc / +0xd0: picture indent (width, height rounded to lines). */
  private indentW = 0;
  private indentH = 0;
  /** +0xd8 / +0xdc: first block origin. */
  private firstX = 0;
  private firstY = 0;
  /** +0xe0: first block width. */
  firstWidth = 0;
  /** +0xe4: characters in the first block. */
  private firstChars = 0;
  /** +0xe8: first block lines. */
  private firstLines = 0;
  /** +0xec / +0xf0: second block origin. */
  private secondX = 0;
  private secondY = 0;
  /** +0xf4 / +0xf8: second block width and lines. */
  private secondWidth = 0;
  private secondLines = 0;

  setFont(font: FfnFont): void {
    this.font = font;
    this.doLayout();
  }

  /** cWinTextWrap::AddText */
  addText(s: string): void {
    if (this.text.length !== 0) this.text += TEXT_SEPARATOR;
    this.text += s;
    this.doLayout();
  }

  /** cWinTextWrap::SetCaption */
  setCaption(s: string): void {
    this.text = s;
    this.doLayout();
  }

  /** cWinTextWrap::SetTopLeftImageSize */
  setTopLeftImageSize(w: number, h: number): void {
    this.indentW = w;
    this.indentH = h;
    const font = this.font;
    if (font) {
      const lh = font.height;
      let n = Math.trunc(h / lh);
      if (lh * (n + 1) - h < h - lh * n) n++;
      this.indentH = n * lh;
    }
    this.firstX = this.indentW;
    this.firstY = 0;
    this.secondX = 0;
    this.secondY = this.indentH;
    this.doLayout();
  }

  /** cWinTextWrap::SetArea */
  override setArea(left: number, top: number, right: number, bottom: number): void {
    super.setArea(left, top, right, bottom);
    this.doLayout();
  }

  /** cWinTextWrap::DoLayout */
  private doLayout(): void {
    const font = this.font;
    if (!font) return;
    const lh = font.height;
    const width = this.getW();
    if (width <= 0) return;
    const { left, top } = this.area;
    this.firstLines = Math.trunc(this.indentH / lh);
    this.firstWidth = width - this.indentW;
    const text = this.text;
    const lines = font.calculateNumberOfLines(text, this.firstWidth);
    if (this.firstLines < lines) {
      let pos = 0;
      for (let i = 0; i < this.firstLines; i++) pos += font.calculateWordsToFitInWidth(text, pos, text.length - pos, this.firstWidth);
      this.firstChars = pos;
      this.secondWidth = width;
      this.secondLines = 0;
      while (pos < text.length) {
        pos += font.calculateWordsToFitInWidth(text, pos, text.length - pos, this.secondWidth);
        this.secondLines++;
      }
      super.setArea(left, top, left + width, top + this.secondLines * lh + this.indentH);
    } else {
      this.firstChars = text.length;
      this.firstLines = lines;
      this.secondWidth = 0;
      this.secondLines = 0;
      super.setArea(left, top, left + width, top + this.indentH);
    }
  }

  override tsPaint(g: Gfx): void {
    const font = this.font;
    if (!font) return;
    const lh = font.height;
    const para = (x: number, y: number, w: number, lines: number, s: string): void =>
      font.drawTextPara(g.ctx, { left: g.ox + x, top: g.oy + y, right: g.ox + x + w, bottom: g.oy + y + lines * lh }, s, ALIGN_LEFT, UI_FONT_COLOR);
    if (this.firstLines > 0) para(this.firstX, this.firstY, this.firstWidth, this.firstLines, this.text.slice(0, this.firstChars));
    if (this.secondLines <= 0) return;
    const rest = this.text.slice(this.firstChars);
    if (this.secondLines === 1 && font.stringWidth(rest) <= this.firstWidth) {
      para(this.firstX, this.firstY + this.firstLines * lh, this.firstWidth, 1, rest);
      return;
    }
    para(this.secondX, this.secondY, this.secondWidth, this.secondLines, rest);
  }
}
