/**
 * Maxis bitmap fonts (`UIGraphics/Fonts/VariableSans_NN[_s|_bs].ffn`).
 *
 * The container is EA's GIMEX "FNTF" format (decoded from MacGIMEX_open/info/read):
 *
 *   header (LE)  +0 "FNTF"  +4 u32 size  +10 u16 glyphCount  +20 u32 glyphTableOffset
 *                +28 u32 atlasOffset
 *   glyph (11 B) +0 u16 char  +2 u8 w  +3 u8 h  +4 u16 atlasX  +6 u16 atlasY
 *                +8 u8 ?  +9 s8 left bearing  +10 s8 top offset
 *   atlas        +4 u16 width  +6 u16 height  +16 4-bit pixels, high nibble first
 *
 * Metrics follow cTSFont::InitBitmapped: advance = w + bearing, top offsets are
 * rebased so the smallest is 0, line height = max(top + h), the space advance
 * is round(0.5 * average glyph width) and every string gets the rounded
 * average bearing added once (cTSFont::GetStringWidth).
 *
 * Pixels are 16 coverage levels; text is drawn as `color` with alpha level/15.
 *
 * Glyph codes are the bytes of the game's code page (res/codepage.ts): the
 * Polish VariableSans (Fonts/Polish) holds the Windows-1250 letters at the
 * places of the Windows-1252 ones.
 *
 * FfnFont is the font interface every window uses (cITSFont); FntfFont is
 * cTSFont (these bitmap fonts), DbFont (res/dbfont.ts) cTSDBFontKorean, the
 * double-byte fonts of the Japanese, Chinese and Korean games.
 */

import { gameCharCode } from "./codepage.js";

interface Glyph {
  x: number;
  y: number;
  w: number;
  h: number;
  bearing: number;
  top: number;
  advance: number;
}

/** cITSFontSys::tFontStyleFlags: software drop shadow (cTSFont::TSDrawText). */
export const FONT_SHADOW = 0x10;

/** cITSFontSys::tOutputStyleType, as passed to DrawTextPara. */
export const ALIGN_LEFT = 0;
export const ALIGN_CENTER = 1;
export const ALIGN_RIGHT = 2;

export abstract class FfnFont {
  /** Line height (cITSFont::GetFontHeight). */
  abstract readonly height: number;
  /** Style flags (cTSFont+0xc); see withFlags(). */
  flags = 0;

  /** Advance of one character code (TSCharNextCharOffset). */
  abstract charWidth(code: number): number;
  /** cITSFont::GetStringWidth. */
  abstract stringWidth(text: string): number;
  /** cITSFont::GetBaselineHeight. */
  abstract baselineHeight(): number;
  /** cITSFont::GetCharDims: a glyph's box, top/bottom relative to the line top. */
  abstract charDims(code: number): { left: number; top: number; right: number; bottom: number };
  /** cITSFont::TSTextArea: the width and height of one line of text. */
  abstract textArea(text: string): { w: number; h: number };
  /** cITSFont::CalculateWordsToFitInWidth: how many characters of text[start .. start + len) fit on a line. */
  abstract calculateWordsToFitInWidth(text: string, start: number, len: number, width: number): number;
  /** cITSFont::CalculateNumberOfLines. */
  abstract calculateNumberOfLines(text: string, width: number): number;
  /** Draw `text` with its top-left at (x, y) (cITSFont::TSDrawText). */
  abstract drawText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void;

  /**
   * The same font with other style flags (the font system caches one font
   * per (size, flags); glyph data is shared here).
   */
  withFlags(flags: number): this {
    if (flags === this.flags) return this;
    const f = Object.create(this) as this;
    f.flags = flags;
    return f;
  }

  /**
   * cITSFont::DrawTextPara: word-wrapped text inside an absolute rectangle,
   * one line per font height, stopping at the rectangle's bottom (the same
   * loop in cTSFont and cTSDBFontKorean).
   */
  drawTextPara(
    ctx: CanvasRenderingContext2D,
    rect: { left: number; top: number; right: number; bottom: number },
    text: string,
    align: number,
    color: string,
  ): void {
    const width = rect.right - rect.left;
    let y = rect.top;
    for (let pos = 0; y < rect.bottom && pos < text.length; y += this.height) {
      const n = this.calculateWordsToFitInWidth(text, pos, text.length - pos, width);
      const line = text.slice(pos, pos + n);
      let x = rect.left;
      if (align === ALIGN_CENTER) x = rect.left + (width >>> 1) - Math.trunc(this.stringWidth(line) / 2);
      else if (align === ALIGN_RIGHT) x = rect.right - this.stringWidth(line);
      this.drawText(ctx, line, x, y, color);
      pos += n;
    }
  }
}

/** cTSFont: the VariableSans bitmap fonts. */
export class FntfFont extends FfnFont {
  override readonly height: number;
  private readonly glyphs = new Map<number, Glyph>();
  private readonly extraWidth: number;
  private readonly atlasW: number;
  private readonly atlasH: number;
  private readonly coverage: Uint8Array;
  private readonly tinted = new Map<string, HTMLCanvasElement>();

  constructor(bytes: Uint8Array) {
    super();
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (v.getUint32(0, false) !== 0x464e5446) throw new Error("not an FNTF font");
    const count = v.getUint16(10, true);
    const table = v.getUint32(20, true);
    const atlas = v.getUint32(28, true);
    this.atlasW = v.getUint16(atlas + 4, true);
    this.atlasH = v.getUint16(atlas + 6, true);
    const stride = this.atlasW >> 1;
    this.coverage = new Uint8Array(this.atlasW * this.atlasH);
    for (let y = 0; y < this.atlasH; y++) {
      for (let x = 0; x < this.atlasW; x++) {
        const b = bytes[atlas + 16 + y * stride + (x >> 1)]!;
        this.coverage[y * this.atlasW + x] = x & 1 ? b & 15 : b >> 4;
      }
    }

    let minTop = 0;
    let bearingSum = 0;
    for (let i = 0; i < count; i++) {
      const o = table + i * 11;
      const code = v.getUint16(o, true);
      const g: Glyph = {
        w: bytes[o + 2]!,
        h: bytes[o + 3]!,
        x: v.getUint16(o + 4, true),
        y: v.getUint16(o + 6, true),
        bearing: v.getInt8(o + 9),
        top: v.getInt8(o + 10),
        advance: 0,
      };
      g.advance = g.w + g.bearing;
      bearingSum += g.bearing;
      minTop = Math.min(minTop, g.top);
      this.glyphs.set(code, g);
    }
    this.extraWidth = Math.trunc(0.5 + bearingSum / Math.max(1, count));

    let height = 0;
    let widthSum = 0;
    let n = 0;
    for (const [code, g] of this.glyphs) {
      g.top -= minTop;
      if (code === 0xa0 || g.w <= 0 || g.h <= 0) continue;
      height = Math.max(height, g.top + g.h);
      widthSum += g.w;
      n++;
    }
    this.height = height;
    const space = this.glyphs.get(0x20);
    if (space) {
      space.advance = Math.trunc(0.5 + (0.5 * widthSum) / Math.max(1, n));
      space.w = space.h = 0;
    }
  }

  override charWidth(code: number): number {
    return this.glyphs.get(code)?.advance ?? 0;
  }

  override stringWidth(text: string): number {
    let w = 0;
    for (const ch of text) w += this.charWidth(gameCharCode(ch));
    return w + this.extraWidth;
  }

  /** cTSFont::GetBaselineHeight: bottom of the "A" glyph (top offset + height). */
  override baselineHeight(): number {
    const a = this.glyphs.get(0x41);
    return a ? a.top + a.h : this.height;
  }

  /** cTSFont::GetCharDims: a glyph's box, top/bottom relative to the line top. */
  override charDims(code: number): { left: number; top: number; right: number; bottom: number } {
    const g = this.glyphs.get(code);
    if (!g) return { left: 0, top: 0, right: 0, bottom: 0 };
    return { left: g.bearing, top: g.top, right: g.bearing + g.w, bottom: g.top + g.h };
  }

  /** Bitmap width of a glyph (FontRect::Width), used by word wrapping. */
  glyphWidth(code: number): number {
    return this.glyphs.get(code)?.w ?? 0;
  }

  /** cTSFont::TSTextArea: sum of the advances, one line high (no extra width). */
  override textArea(text: string): { w: number; h: number } {
    let w = 0;
    for (const ch of text) w += this.charWidth(gameCharCode(ch));
    return { w, h: this.height };
  }

  /**
   * cTSFont::CalculateWordsToFitInWidth: how many characters of
   * text[start .. start + len) go on a line `width` pixels wide. Breaks after
   * spaces and hyphens, keeps a newline in the line, swallows trailing spaces;
   * a single word wider than the line is not split.
   */
  override calculateWordsToFitInWidth(text: string, start: number, len: number, width: number): number {
    if (len < 1) return 0;
    const code = (i: number): number => (start + i < text.length ? gameCharCode(text[start + i]!) : 0);
    let lastBreak = 0;
    let returnBreak = false;
    let fit = 0;
    let w = this.glyphWidth(code(0));
    let i = 0;
    let n: number;
    for (;;) {
      if (w > width) {
        n = lastBreak;
        break;
      }
      fit = i + 1;
      if (fit >= len) return fit;
      const c = code(i);
      if (c === 10) {
        returnBreak = true;
        n = fit;
        break;
      }
      if (c === 0x20 || c === 0x2d) lastBreak = fit;
      w = w - this.glyphWidth(c) + this.charWidth(c);
      if (i < len) {
        w += this.glyphWidth(code(i + 1));
        i++;
      }
    }
    if (n === 0) {
      if (fit < 2) {
        while (n < len && start + n < text.length) {
          const c = code(n);
          if (c === 0 || c === 10 || c === 0x20) break;
          n++;
        }
      } else {
        n = fit - 1;
      }
    }
    if (!returnBreak) while (n < len && code(n) === 0x20) n++;
    if (n === 0 && len > 0) n = 1;
    return n;
  }

  /** cTSFont::CalculateNumberOfLines (width 0 means one line). */
  override calculateNumberOfLines(text: string, width: number): number {
    if (width === 0) return 1;
    let lines = 0;
    for (let pos = 0; pos < text.length; lines++) {
      pos += this.calculateWordsToFitInWidth(text, pos, text.length - pos, width);
    }
    return lines;
  }

  /** Draw `text` with its top-left at (x, y). */
  override drawText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void {
    if (this.flags & FONT_SHADOW) this.drawGlyphs(ctx, text, x + 2, y + 2, "#000000");
    this.drawGlyphs(ctx, text, x, y, color);
  }

  private drawGlyphs(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void {
    const atlas = this.atlasFor(color);
    let pen = x;
    for (const ch of text) {
      const g = this.glyphs.get(gameCharCode(ch));
      if (!g) continue;
      if (g.w > 0 && g.h > 0) {
        ctx.drawImage(atlas, g.x, g.y, g.w, g.h, pen + g.bearing, y + g.top, g.w, g.h);
      }
      pen += g.advance;
    }
  }

  private atlasFor(color: string): HTMLCanvasElement {
    let c = this.tinted.get(color);
    if (c) return c;
    c = document.createElement("canvas");
    c.width = this.atlasW;
    c.height = this.atlasH;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    const img = ctx.createImageData(this.atlasW, this.atlasH);
    for (let i = 0; i < this.coverage.length; i++) {
      img.data[i * 4] = r!;
      img.data[i * 4 + 1] = g!;
      img.data[i * 4 + 2] = b!;
      img.data[i * 4 + 3] = Math.round((this.coverage[i]! * 255) / 15);
    }
    ctx.putImageData(img, 0, 0);
    this.tinted.set(color, c);
    return c;
  }
}
