/**
 * The parts of cTSWinBtn painting the Live subpanels rely on and ui/btn.ts
 * does not reproduce: cTSWinBtn::DefaultPaint (one image frame drawn at an
 * offset, +0x13c/+0x140, instead of filling the window) and
 * cTSWinBtn::CaptionDraw (text rectangle +0x114 when +0x158 is set, else the
 * whole window with the "A" glyph centered vertically; DrawTextPara when
 * +0x16b is set, else one TSDrawText line; underline font flag from +0x168).
 */

import { ALIGN_CENTER, ALIGN_LEFT, ALIGN_RIGHT } from "../../res/ffn.js";
import { TSWinBtn } from "../../ui/btn.js";
import { hiliteColor } from "../../ui/syscolors.js";
import type { Gfx, Rect } from "../../ui/tswin.js";

export class CaptionBtn extends TSWinBtn {
  /** cTSWinBtn+0x114..0x120, used when set (+0x158). */
  textRect: Rect | null = null;
  /** cTSWinBtn+0x16b: word-wrapped DrawTextPara (default) or a single TSDrawText line. */
  paraText = true;
  /** cTSWinBtn+0x168 (SetUnderlineText). */
  underline = false;
  /** cTSWinBtn+0x13c/+0x140: where the image frame is drawn in the window. */
  imageX = 0;
  imageY = 0;

  /** cTSWinBtn::SetImage without resizing the window (the callers SetArea afterwards). */
  setImageKeepArea(image: ImageBitmap | null, cols: number, rows: number): void {
    this.image = image;
    this.hitImage = null;
    this.cols = cols;
    this.rows = rows;
  }

  frameW(): number {
    return this.image ? Math.floor(this.image.width / Math.max(1, this.cols)) : 0;
  }

  frameH(): number {
    return this.image ? Math.floor(this.image.height / Math.max(1, this.rows)) : 0;
  }

  captionColorNow(): string {
    return this.hiliteColors?.[this.frameColumn()] ?? hiliteColor(this.cols, this.frameColumn());
  }

  /** The whole window is hot (the image frame does not cover it). */
  protected override isPointTransparent(): boolean {
    return false;
  }

  override tsPaint(g: Gfx): void {
    this.defaultPaint(g);
    if (this.caption) this.captionDraw(g);
  }

  /** cTSWinBtn::DefaultPaint */
  protected defaultPaint(g: Gfx): void {
    if (!this.image) return;
    const w = this.frameW();
    const h = this.frameH();
    g.blitPart(this.image, this.frameColumn() * w, this.row * h, w, h, this.imageX, this.imageY);
  }

  /** cTSWinBtn::CaptionDraw */
  protected captionDraw(g: Gfx): void {
    const font = this.font;
    if (!font) return;
    let r: Rect;
    if (!this.textRect) {
      const a = font.charDims(0x41);
      const top = ((this.getH() - (a.bottom - a.top)) / 2 - a.top) | 0;
      r = { left: 0, top, right: this.getW(), bottom: this.getH() };
    } else {
      r = this.textRect;
    }
    const color = this.captionColorNow();
    const abs = { left: g.ox + r.left, top: g.oy + r.top, right: g.ox + r.right, bottom: g.oy + r.bottom };
    if (!this.paraText) {
      const w = font.stringWidth(this.caption);
      let x = abs.left;
      if (this.textAlignment === 1) x += ((abs.right - abs.left - w) / 2) | 0;
      else if (this.textAlignment === 2) x = abs.right - w;
      font.drawText(g.ctx, this.caption, x, abs.top, color);
      if (this.underline) this.drawUnderline(g, x, abs.top, font.textArea(this.caption).w);
      return;
    }
    const align = this.textAlignment === 1 ? ALIGN_CENTER : this.textAlignment === 2 ? ALIGN_RIGHT : ALIGN_LEFT;
    font.drawTextPara(g.ctx, abs, this.caption, align, color);
    if (this.underline) {
      // Single-line captions only in the Live panels.
      const w = font.textArea(this.caption).w;
      const x = align === ALIGN_CENTER ? abs.left + ((abs.right - abs.left) >>> 1) - Math.trunc(font.stringWidth(this.caption) / 2) : align === ALIGN_RIGHT ? abs.right - font.stringWidth(this.caption) : abs.left;
      this.drawUnderline(g, x, abs.top, w);
    }
  }

  /** cTSFont::TSDrawChar with the underline flag: a line at the baseline height. */
  private drawUnderline(g: Gfx, x: number, y: number, w: number): void {
    const font = this.font!;
    g.ctx.fillStyle = this.captionColorNow();
    g.ctx.fillRect(x, y + font.baselineHeight(), w + 1, 1);
  }
}
