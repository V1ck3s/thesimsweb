/**
 * The font of the Thai game (cTSDBFontThai, Windows build; the Mac build has
 * no such class).
 *
 * cTSFontSys::TSAcquireFont gives language 19 a cTSDBFontThai whatever the
 * size and style asked for. Its glyphs come from font20th.fon of
 * UIGraphics/Fonts (FUN_00609062, record 4): 256 single-byte glyphs of
 * Windows-874, each a 12 x 20 1-bit bitmap, rows padded to 2 bytes, high bit
 * first (40 bytes a glyph, 0x2800 bytes in all), with a blank row above and
 * below. The instance is created at size 12 (FUN_0060a5a2) and FUN_0060902d
 * then takes the only font loaded (FUN_0060858c / FUN_00609062 load font20th
 * alone for Thai).
 *
 * Every character is one byte; Thai text is drawn by clusters
 * (FUN_0060964c): a consonant with the vowels and tone marks written above or
 * below it, positioned with two tables of Sims.exe indexed by the byte:
 * DAT_006d98bc (the glyph's width, also its advance minus 1) and DAT_006d99bc
 * (its anchor: where the following marks attach on a base, how far left of
 * the anchor a mark is drawn), and classed by DAT_006d9abc. The tables below
 * are dumped from Sims.exe.
 *
 * Widths (GetStringWidth, TSTextArea, TSDrawText) add the clusters' widths
 * plus one pixel after each cluster that is not a space, the last one
 * excepted; "_" draws nothing and takes no room. Lines wrap at spaces and
 * hyphens only (FUN_0060aefc), so a run of Thai is one word. The font has no
 * drop shadow (TSDrawText ignores the shadow flag it stores).
 *
 * Strings are Unicode in the port: each call encodes them to Windows-874
 * (res/codepage.ts), one byte per character.
 */

import { gameCharCode } from "./codepage.js";
import { FfnFont } from "./ffn.js";

/** FUN_00609062, record 4: font20th.fon's metrics. */
const GLYPH_W = 12;
const GLYPH_H = 20;
const GLYPH_BYTES = 40;
/** [4]: the spacing added to a glyph's width (FUN_006092f4). */
const SPACING = 1;
/** [11], [12]: blank rows above and below the glyphs. */
const TOP = 1;
const BOTTOM = 1;

/** cITSFontSys::tFontStyleFlags 4: TSDrawText underlines (FUN_0060a98a). */
const FONT_UNDERLINE = 4;

const table = (rows: string): Int8Array => Int8Array.from(rows.trim().split(/\s+/).map(Number));

/** DAT_006d98bc: each byte's glyph width. */
const WIDTH = table(`
  12 12  4  5  5  5 12 12 12 12 12  5 12 12 12 12
  12 12 12 12 12 12 12 12 12 12 12 12 12 12  0  1
   5  2  3  5  5  5  5  1  2  2  5  5  2  5  2  5
   5  3  5  5  5  5  5  5  5  5  2  2  4  5  4  5
   5  5  5  5  5  5  5  5  5  3  5  5  5  5  5  5
   5  5  5  5  5  5  5  5  5  5  5  3  5  3  5  5
   3  5  5  5  5  5  5  5  5  3  5  5  2  5  5  5
   5  5  5  5  5  5  5  5  5  5  5  3  1  3  5  4
   0  0  0  0  0  0  0  0  0  0  0  0  0  0  0  0
   0  0  0  0  0  0  0  0  0  0  0  0  0  0  0 10
   0  8  8  8  7  7  9  6  7  9  8  9 10 10  8  8
   7 10 11 12  7  7  8  8  7  9  8  8  7  7  9  9
   8  7  6  7  8  6  8  7  8 10  6  8 11  6  7  6
   6  6  6 11  7  6  7  6  3  5  2  0  0  0  0  8
   3  7  6  6  7  6  6  6  1  5  6  3  5  3  3  8
   7  7  9  8 10 10  7  9  8  8 11 11  0  0  9  0
`);

/** DAT_006d99bc: each byte's anchor. */
const ANCHOR = table(`
  12 12  4  5  5  5 12 12 12 12 12  5 12 12 12 12
  12 12 12 12 12 12 12 12 12 12 12 12 12 12  0  1
   5  2  5  5  5  5  5  2  2  2  5  5  2  5  2  5
   5  3  5  5  5  5  5  5  5  5  2  2  4  5  4  5
   5  5  5  5  5  5  5  5  5  3  5  5  5  5  5  5
   5  5  5  5  5  5  5  5  5  5  5  3  5  3  5  5
   3  5  5  5  5  5  5  5  5  3  5  5  2  5  5  5
   5  5  5  5  5  5  5  5  5  5  5  3  1  3  5  4
   0  0  0  0  0  0  0  0  0  0  0  0  0  0  0  0
   0  0  0  0  0  0  0  0  0  0  0  0  0  0  0  9
   0  7  7  7  6  6  8  5  6  7  6  7  9  9  7  7
   5  9  9  9  6  6  7  7  5  7  7  4  6  3  8  5
   7  6  5  5  8  5  8  6  6  7  5  7  8  5  5  6
   6  3  6  1  6  5  6  5  2  4  1  0  0  0  0  8
   3  7  6  6  7  6  6  6  0  3  3  1  2  1  1  8
   7  7  9  8 10 10  7  9  8  8 11 11  0  0  9  0
`);

/**
 * DAT_006d9abc: each byte's class. 1 stands alone, 2 consonant, 3 leading
 * vowel, 4 other spacing letter, 5 vowel below, 6 vowel above, 7 tone mark,
 * 8 other mark above, 9 phinthu, 10 sara am, 11 thanthakhat.
 */
const CLASS = table(`
   1  1  1  1  1  1  1  1  1  1  1  1  1  1  1  1
   1  1  1  1  1  1  1  1  1  1  1  1  1  1  1  1
   1  1  1  1  1  1  1  1  1  1  1  1  1  1  1  1
   1  1  1  1  1  1  1  1  1  1  1  1  1  1  1  1
   1  1  1  1  1  1  1  1  1  1  1  1  1  1  1  1
   1  1  1  1  1  1  1  1  1  1  1  1  1  1  1  1
   1  1  1  1  1  1  1  1  1  1  1  1  1  1  1  1
   1  1  1  1  1  1  1  1  1  1  1  1  1  1  1  1
   1  1  1  1  1  1  1  1  1  1  1  1  1  1  1  1
   1  1  1  1  1  1  1  1  1  1  1  1  1  1  1  1
   1  2  2  2  2  2  2  2  2  2  2  2  2  2  2  2
   2  2  2  2  2  2  2  2  2  2  2  2  2  2  2  2
   2  2  2  2  4  2  4  2  2  2  2  2  2  2  2  1
   4  6  4 10  6  6  6  6  5  5  9  1  1  1  1  1
   3  3  3  3  3  4  1  8  7  7  7  7 11  8  8  1
   1  1  1  1  1  1  1  1  1  1  1  1  1  1  1  1
`);

/** FUN_006092f4: a byte's advance ("_", codes above 0xff and empty glyphs take none). */
function charAdvance(c: number): number {
  if (c === 0x5f || c > 0xff || WIDTH[c] === 0) return 0;
  return SPACING + WIDTH[c]!;
}

/** FUN_0060931d: a glyph's height, margins included. */
const CHAR_HEIGHT = TOP + BOTTOM + GLYPH_H;

/** IsCharBreakingChar (cTSDBFontThai): space, hyphen, no-break space and "_". */
const isBreaking = (c: number): boolean => c === 0x20 || c === 0x2d || c === 0xa0 || c === 0x5f;
/** IsCharWhitespace (cTSDBFontThai): space and no-break space. */
const isWhitespace = (c: number): boolean => c === 0x20 || c === 0xa0;
/** IsCharReturnChar. */
const isReturn = (c: number): boolean => c === 10;

/** A cluster (FUN_0060964c's record): up to three glyphs drawn as one. */
interface Cluster {
  /** Glyphs, also the bytes the cluster takes (0 at the end of the text). */
  count: number;
  width: number;
  chars: number[];
  /** Each glyph's x and y offset. */
  x: number[];
  y: number[];
}

/** FUN_006097b8: adds a mark anchored at `pos`; returns the anchor, moved right when the mark would start left of 0. */
function addGlyph(cl: Cluster, c: number, pos: number, y: number): number {
  const anchor = ANCHOR[c]!;
  const right = WIDTH[c]! - anchor + pos;
  if (cl.width < right) cl.width = right;
  if (pos < anchor) {
    cl.width += anchor - pos;
    pos = anchor;
  }
  cl.chars.push(c);
  cl.x.push(pos - anchor);
  cl.y.push(y);
  cl.count++;
  return pos;
}

/** FUN_0060964c: the cluster at `start` among `n` bytes. */
function composeCluster(b: Uint8Array, start: number, n: number): Cluster {
  const cl: Cluster = { count: 0, width: 0, chars: [], x: [], y: [] };
  if (n === 0) return cl;
  const c0 = b[start]!;
  cl.chars.push(c0);
  cl.x.push(0);
  cl.y.push(1);
  cl.width = WIDTH[c0]!;
  let pos = ANCHOR[c0]!;
  cl.count = 1;
  // Only a consonant takes marks; anything else stands alone.
  if (n === 1 || CLASS[c0] !== 2) return cl;
  const c1 = b[start + 1]!;
  const k1 = CLASS[c1]!;
  if (k1 === 5 || k1 === 9) {
    // A vowel below: tho than drops its tail (glyph 0x9F), a following tone mark sits 3 rows lower.
    if (c0 === 0xad) cl.chars[0] = 0x9f;
    pos = addGlyph(cl, c1, pos, 1);
    if (n === 2) return cl;
    const c2 = b[start + 2]!;
    const k2 = CLASS[c2]!;
    if (k2 === 8) addGlyph(cl, c2, pos, 1);
    else if (k2 === 7 || k2 === 11) addGlyph(cl, c2, pos, 4);
    return cl;
  }
  if (k1 === 6) {
    // A vowel above, then a tone mark above it.
    pos = addGlyph(cl, c1, pos, 1);
    if (n === 2) return cl;
    const c2 = b[start + 2]!;
    const k2 = CLASS[c2]!;
    if (k2 === 7 || k2 === 11) addGlyph(cl, c2, pos, 1);
    return cl;
  }
  if (k1 === 8 || k1 === 10) {
    addGlyph(cl, c1, pos, 1);
    return cl;
  }
  if (k1 === 7 || k1 === 11) {
    // A tone mark alone sits 3 rows lower, unless sara am follows.
    pos = addGlyph(cl, c1, pos, 4);
    if (n === 2) return cl;
    const c2 = b[start + 2]!;
    if (CLASS[c2] !== 10) return cl;
    cl.y[1] = 1;
    addGlyph(cl, c2, pos, 1);
  }
  return cl;
}

/** A string as the bytes the original walks, with the Unicode character each byte belongs to. */
interface Encoded {
  bytes: Uint8Array;
  /** charAt[i]: the index of the character of byte i; charAt[length] = the text's length. */
  charAt: Int32Array;
}

function encode(text: string): Encoded {
  const out: number[] = [];
  const owner: number[] = [];
  let index = 0;
  for (const ch of text) {
    out.push(gameCharCode(ch, 19) & 0xff);
    owner.push(index);
    index += ch.length;
  }
  owner.push(index);
  return { bytes: Uint8Array.from(out), charAt: Int32Array.from(owner) };
}

const MAX_CACHED_TEXTS = 512;

/** cTSDBFontThai. */
export class ThaiFont extends FfnFont {
  override readonly height: number;
  private readonly rendered = new Map<string, HTMLCanvasElement>();
  private readonly rgb = new Map<string, number>();

  constructor(private readonly data: Uint8Array) {
    super();
    // Init: the size and the line height are the height of "A" (plus the bold bit, 0 here).
    this.height = CHAR_HEIGHT;
  }

  /** GetStringWidth over bytes: the clusters' widths, one pixel after each but a space, not after the last. */
  private bytesWidth(b: Uint8Array, start: number, n: number): number {
    let w = 0;
    let sep = 0;
    for (let i = start; n !== 0; ) {
      const cl = composeCluster(b, i, n);
      if (cl.count === 0) break;
      i += cl.count;
      n -= cl.count;
      sep = isWhitespace(cl.chars[0]!) ? 0 : 1;
      if (cl.count === 1 && cl.chars[0] === 0x5f) sep = 0;
      else w += cl.width + sep;
    }
    return w - sep;
  }

  /** GetStringVisibleWidth: the width without the trailing spaces. */
  private bytesVisibleWidth(b: Uint8Array, start: number, n: number): number {
    while (n > 0 && isWhitespace(b[start + n - 1]!)) n--;
    return n === 0 ? 0 : this.bytesWidth(b, start, n);
  }

  /** FUN_0060aefc: the length of the word at `start`, at most `max` bytes, its break character included. */
  private wordLength(b: Uint8Array, start: number, max: number): number {
    let n = 0;
    while (n < max) {
      const c = b[start + n]!;
      n++;
      if (c < 0x20 || (b[start + n] ?? 0) < 0x20 || isBreaking(c)) break;
    }
    return n;
  }

  /** cTSDBFontThai::CalculateWordsToFitInWidth over bytes. */
  private fitBytes(b: Uint8Array, start: number, len: number, width: number): number {
    let i = 0;
    let used = 0;
    if (width > 0) {
      for (;;) {
        if (i >= len || b[start + i] === 0) break;
        if (isReturn(b[start + i]!)) {
          i++;
          break;
        }
        const n = this.wordLength(b, start + i, len - i);
        if (len < i + n || width < this.bytesVisibleWidth(b, start + i, n) + used) break;
        used += this.bytesWidth(b, start + i, n);
        i += n;
        if (width <= used) break;
      }
    }
    if (i === 0) {
      if (len < 1) return 0;
      while (i < len) {
        const c = b[start + i]!;
        if (c === 0 || isReturn(c) || isWhitespace(c)) break;
        i++;
      }
    }
    while (i < len && isWhitespace(b[start + i]!)) i++;
    if (i === 0 && len > 0) i = 1;
    return i;
  }

  /** TSCharNextCharOffset (plus the bold bit, 0 here). */
  override charWidth(code: number): number {
    return charAdvance(code);
  }

  override stringWidth(text: string): number {
    const { bytes } = encode(text);
    return this.bytesWidth(bytes, 0, bytes.length);
  }

  /** GetBaselineHeight: the size (the height of "A") + 1. */
  override baselineHeight(): number {
    return this.height + 1;
  }

  /** GetCharDims: TSCharWidth wide, the glyph height high. */
  override charDims(code: number): { left: number; top: number; right: number; bottom: number } {
    return { left: 0, top: 0, right: charAdvance(code), bottom: CHAR_HEIGHT };
  }

  /** TSTextArea: GetStringWidth without the "_" case, one line high. */
  override textArea(text: string): { w: number; h: number } {
    const { bytes } = encode(text);
    let w = 0;
    let sep = 0;
    for (let i = 0, n = bytes.length; n !== 0; ) {
      const cl = composeCluster(bytes, i, n);
      if (cl.count === 0) break;
      i += cl.count;
      n -= cl.count;
      sep = isWhitespace(cl.chars[0]!) ? 0 : 1;
      w += cl.width + sep;
    }
    return { w: w - sep, h: this.height };
  }

  override calculateWordsToFitInWidth(text: string, start: number, len: number, width: number): number {
    // The original reads the byte after a word, which may lie past `len`: encode the rest of the text.
    const e = encode(text.slice(start));
    const n = encode(text.slice(start, start + len)).bytes.length;
    const fit = this.fitBytes(e.bytes, 0, n, width);
    return e.charAt[fit]!;
  }

  /** CalculateNumberOfLines: no single-line case for width 0. */
  override calculateNumberOfLines(text: string, width: number): number {
    const { bytes } = encode(text);
    const len = bytes.length;
    let lines = 0;
    for (let pos = 0; pos < len; lines++) pos += this.fitBytes(bytes, pos, len - pos, width);
    return lines;
  }

  /** TSDrawText (no clip rectangle, no selection). */
  override drawText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void {
    if (text.length === 0) return;
    const key = `${this.flags}|${color}|${text}`;
    let c = this.rendered.get(key);
    if (c) {
      // Most recently used last.
      this.rendered.delete(key);
    } else {
      c = this.render(text, color);
      if (this.rendered.size >= MAX_CACHED_TEXTS) this.rendered.delete(this.rendered.keys().next().value!);
    }
    this.rendered.set(key, c);
    if (c.width > 0 && c.height > 0) ctx.drawImage(c, x, y);
  }

  /**
   * TSDrawText into a bitmap: the clusters one after the other (a newline's
   * is skipped), each drawn by FUN_0060a98a.
   */
  private render(text: string, color: string): HTMLCanvasElement {
    const { bytes } = encode(text);
    const clusters: Array<{ cl: Cluster; x: number }> = [];
    let pen = 0;
    let right = 0;
    let bottom = 0;
    const underline = (this.flags & FONT_UNDERLINE) !== 0;
    for (let i = 0, n = bytes.length; n !== 0; ) {
      const cl = composeCluster(bytes, i, n);
      if (cl.count === 0) break;
      i += cl.count;
      n -= cl.count;
      if (cl.chars[0] === 10) continue;
      clusters.push({ cl, x: pen });
      if (cl.chars[0] === 0x5f) continue;
      // FUN_0060a98a: ro, fo fa and fo fan move a vowel below 3 pixels right.
      const c0 = cl.chars[0]!;
      const c1 = cl.chars[1] ?? 0;
      if (cl.count > 1 && (c0 === 0xbb || c0 === 0xbd || c0 === 0xbf) && (c1 === 0xd8 || c1 === 0xd9 || c1 === 0xda)) {
        cl.x[1] = cl.x[1]! + 3;
      }
      for (let g = 0; g < cl.count; g++) {
        right = Math.max(right, pen + cl.x[g]! + charAdvance(cl.chars[g]!));
        bottom = Math.max(bottom, cl.y[g]! + CHAR_HEIGHT);
      }
      if (underline) right = Math.max(right, pen + cl.width + 1);
      pen += cl.width + (isWhitespace(c0) ? 0 : 1);
    }
    if (underline) bottom = Math.max(bottom, this.height - 2);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(0, right);
    canvas.height = bottom;
    if (canvas.width === 0 || bottom === 0) return canvas;
    const w = canvas.width;
    const px = new Uint32Array(w * bottom);
    const fg = this.color(color);
    for (const { cl, x } of clusters) {
      if (cl.chars[0] === 0x5f) continue;
      for (let g = 0; g < cl.count; g++) {
        const c = cl.chars[g]!;
        const gw = charAdvance(c);
        for (let col = 0; col < gw; col++) {
          const X = x + cl.x[g]! + col;
          if (X < 0 || X >= w) continue;
          for (let row = 0; row < CHAR_HEIGHT; row++) {
            if (this.pixel(c, col, row)) px[(cl.y[g]! + row) * w + X] = fg;
          }
        }
      }
      if (underline) {
        // GetFontFlag(4): a line at the line height - 3, the cluster's width + 1 long.
        const Y = this.height - 3;
        for (let col = 0; col <= cl.width; col++) if (x + col < w) px[Y * w + x + col] = fg;
      }
    }
    const ctx = canvas.getContext("2d")!;
    const img = ctx.createImageData(w, bottom);
    new Uint32Array(img.data.buffer).set(px);
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /** FUN_006094eb: is the glyph's pixel (x, y) set (y counted from the top margin's top)? */
  private pixel(c: number, x: number, y: number): boolean {
    if (y < TOP) return false;
    y -= TOP;
    if (x < 0 || x >= GLYPH_W || y < 0 || y >= GLYPH_H) return false;
    // FUN_00609342: the glyph's bitmap.
    const b = this.data[GLYPH_BYTES * c + ((GLYPH_W + 7) >> 3) * y + (x >> 3)] ?? 0;
    return (b & (1 << (7 - (x % 8)))) !== 0;
  }

  /** A CSS color as little-endian RGBA. */
  private color(css: string): number {
    let v = this.rgb.get(css);
    if (v !== undefined) return v;
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    v = (0xff000000 | (b! << 16) | (g! << 8) | r!) >>> 0;
    this.rgb.set(css, v);
    return v;
  }
}
