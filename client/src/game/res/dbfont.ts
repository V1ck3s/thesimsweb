/**
 * The double-byte fonts of the Japanese, Chinese and Korean games
 * (cTSDBFontKorean, Windows build; the Mac build has no such class).
 *
 * cTSFontSys::TSAcquireFont gives those languages a cTSDBFontKorean instead of
 * a VariableSans cTSFont. Its glyphs come from the 1-bit bitmap fonts of
 * UIGraphics/Fonts (FUN_0060858c loads them once per language through
 * FUN_00608775):
 *
 *   language 15 (Japanese)       FONT12J.FON and FONT16J.FON (Shift-JIS)
 *   language 17 (Simplified Ch.) font16gb.fon (GB)
 *   language 18 (Traditional)    font16b5.fon (Big5)
 *   language 20 (Korean)         FONT12K.FON and FONT16K.FON (KS X 1001 hangul)
 *
 * A file is 256 single-byte glyphs then the double-byte glyphs, each glyph a
 * 1-bit bitmap, rows padded to bytes, high bit first (a 56-byte trailer
 * repeats the metrics; the code sets them itself, table FONTS below). The
 * constructor (FUN_006098ed) gives every instance the size 12 whatever size
 * is asked for, so the font picked (FUN_00608744: the last one of the
 * language at most 12 high, else the first) is FONT12J, FONT12K, font16gb or
 * font16b5: the requested size, the shipped _s / _bs styles and the bold flag
 * do not apply (Init reads the bold bit from flags that are still 0).
 *
 * Metrics (FUN_00608a15 / FUN_00608a37): a character is single- or
 * double-byte by its first byte (FUN_00608ca3, IsDBLeadByte); its advance is
 * the glyph width plus a spacing, its height the glyph height plus a top and a
 * bottom margin; the line height is the height of "A". Word wrapping
 * (CalculateWordsToFitInWidth, word lengths FUN_0060a2ba) never breaks inside a
 * run of single-byte letters, breaks between double-byte characters, and keeps
 * the punctuation that cannot start a line (FUN_00608d3f) or end one
 * (FUN_00608dcd) with its neighbour.
 *
 * Strings are Unicode in the port: each call encodes them to the language's
 * code page (res/codepage.ts) and walks the bytes as the original does; the
 * character counts it returns are the counts of the Unicode characters those
 * bytes encode.
 */

import { gameCharCode } from "./codepage.js";
import { FfnFont, FONT_SHADOW } from "./ffn.js";
import { UI_LANGUAGE } from "./uires.js";

/** FUN_00608775: one font file and its metrics (the 0x34-byte font record). */
interface DbFontFile {
  file: string;
  /** [0] the font's size, compared with the requested one. */
  size: number;
  /** [2], [3]: single-byte glyph width and height. */
  sbW: number;
  sbH: number;
  /** [4]: spacing after a single-byte glyph. */
  sbSpace: number;
  /** [5], [6]: double-byte glyph width and height. */
  dbW: number;
  dbH: number;
  /** [7]: spacing after a double-byte glyph. */
  dbSpace: number;
  /** [8], [9]: bytes per single- and double-byte glyph. */
  sbBytes: number;
  dbBytes: number;
  /** [10]: double-byte glyph count (FUN_00608a5c draws glyph 0 for an index past it). */
  dbCount: number;
  /** [11], [12]: blank rows above and below the glyphs. */
  top: number;
  bottom: number;
}

const FONT_12J: DbFontFile = {
  file: "font12j.fon", size: 12, sbW: 6, sbH: 12, sbSpace: 0, dbW: 12, dbH: 12, dbSpace: 1,
  sbBytes: 12, dbBytes: 24, dbCount: 0x2284, top: 1, bottom: 1,
};
const FONT_16J: DbFontFile = {
  file: "font16j.fon", size: 16, sbW: 8, sbH: 16, sbSpace: 0, dbW: 16, dbH: 16, dbSpace: 1,
  sbBytes: 16, dbBytes: 32, dbCount: 0x2284, top: 1, bottom: 1,
};
const FONT_16B5: DbFontFile = {
  file: "font16b5.fon", size: 16, sbW: 8, sbH: 16, sbSpace: 0, dbW: 16, dbH: 16, dbSpace: 1,
  sbBytes: 16, dbBytes: 32, dbCount: 0x366c, top: 1, bottom: 1,
};
const FONT_16GB: DbFontFile = {
  file: "font16gb.fon", size: 16, sbW: 8, sbH: 16, sbSpace: 0, dbW: 16, dbH: 16, dbSpace: 1,
  sbBytes: 16, dbBytes: 32, dbCount: 0x2179, top: 1, bottom: 1,
};
const FONT_12K: DbFontFile = {
  file: "font12k.fon", size: 12, sbW: 6, sbH: 12, sbSpace: 0, dbW: 12, dbH: 13, dbSpace: 1,
  sbBytes: 12, dbBytes: 26, dbCount: 0xa2e, top: 1, bottom: 1,
};
const FONT_16K: DbFontFile = {
  file: "font16k.fon", size: 16, sbW: 8, sbH: 16, sbSpace: 0, dbW: 16, dbH: 16, dbSpace: 1,
  sbBytes: 16, dbBytes: 32, dbCount: 0xa2e, top: 1, bottom: 1,
};

/** FUN_0060858c: the fonts loaded for each double-byte language. */
const FONTS: Record<number, DbFontFile[]> = {
  15: [FONT_12J, FONT_16J],
  17: [FONT_16GB],
  18: [FONT_16B5],
  20: [FONT_12K, FONT_16K],
};

/** The size FUN_006098ed gives every cTSDBFontKorean. */
const INSTANCE_SIZE = 12;

/** The languages drawn with cTSDBFontKorean. */
export function isDoubleByteLanguage(lang: number): boolean {
  return lang in FONTS;
}

/** FUN_00608744: the last font at most `size` high, else the first. */
export function dbFontFile(lang: number): DbFontFile | null {
  const list = FONTS[lang];
  if (!list) return null;
  for (let i = list.length - 1; i >= 0; i--) if (list[i]!.size <= INSTANCE_SIZE) return list[i]!;
  return list[0]!;
}

/** FUN_00608ca3: a double-byte character's first byte (or a code above 0xff). */
function isLeadByte(lang: number, c: number): boolean {
  if (c > 0xff) return lang === 15 || lang === 17 || lang === 18 || lang === 20;
  switch (lang) {
    case 15:
      return (c > 0x80 && c < 0xa0) || (c >= 0xe0 && c <= 0xfc);
    case 17:
      return c >= 0xa1 && c <= 0xfc;
    case 18:
      return c >= 0x81 && c <= 0xfe;
    case 20:
      return c >= 0xb0 && c <= 0xc8;
    default:
      return false;
  }
}

/** FUN_00608aa7: a double-byte character's glyph index (0 when outside the font's table). */
function glyphIndex(lang: number, code: number): number {
  const lead = code >> 8;
  const trail = code & 0xff;
  switch (lang) {
    case 15:
      if (
        ((lead > 0x80 && lead < 0xa0) || (lead > 0xdf && lead < 0xfd)) &&
        ((trail > 0x3f && trail < 0x7f) || (trail > 0x7f && trail < 0xfd))
      ) {
        return (lead - (lead < 0xe0 ? 0x81 : 0xc1)) * 0xbc + trail - (trail < 0x80 ? 0x40 : 0x41);
      }
      return 0;
    case 17:
      if (lead > 0xa0 && lead < 0xfd && trail > 0xa0 && trail < 0xff) return lead * 0x5e - 0x3bbf + trail;
      return 0;
    case 18:
      if (lead > 0xa0 && lead < 0xfa && ((trail > 0x3f && trail < 0x7f) || (trail > 0xa0 && trail < 0xff))) {
        return lead * 0x9d - 0x62bd + trail - (trail < 0x80 ? 0x40 : 0x62);
      }
      return 0;
    case 20:
      if (lead > 0xaf && lead < 0xc9 && trail > 0xa0 && trail < 0xff) return lead * 0x5e - 0x4141 + trail;
      return 0;
    default:
      return 0;
  }
}

/** FUN_00608d3f: single-byte characters that cannot start a line (DAT_006d9670, 10 bytes). */
const NO_START_SB = [0x2c, 0x2e, 0x3a, 0x3b, 0x3f, 0x21, 0x29, 0x5d, 0x7d, 0x00];
/** FUN_00608dcd: single-byte characters that cannot end a line (DAT_006d96dc, 3 bytes). */
const NO_END_SB = [0x28, 0x24, 0x00];

const pairs = (hex: string): Set<number> => new Set(hex.split(" ").map((h) => parseInt(h, 16)));

/** FUN_00608d3f: the double-byte characters that cannot start a line, per language. */
const NO_START_DB: Record<number, Set<number>> = {
  // PTR_DAT_006d95f0 -> 0x6d9804
  15: pairs(
    "8191 818b 8166 8168 81f1 818c 818d 818e 8141 8142 8158 8172 8174 8176 8178 817a 816c 829f 82a1 82a3 " +
      "82a5 82a7 82c1 82e1 82e3 82e5 82ec 814a 814b 8154 8155 8340 8342 8344 8346 8348 8362 8383 8385 8387 " +
      "838e 8395 8396 8145 815b 8152 8153 8149 8193 816a 8143 8144 8146 8147 8148 816e 8170",
  ),
  // DAT_006d95f4
  17: pairs(
    "a1a2 a1a3 a1a4 a1a5 a1a6 a1a7 a1a8 a1a9 a1ac a1ad a1af a1b1 a1b3 a1b5 a1b7 a1b9 a1bb a1bd a1bf a1c3 " +
      "a3a1 a3a2 a3a7 a3a9 a3ac a3ae a3ba a3bb a3bf a3dd a3e0 a3fc a844",
  ),
  // PTR_DAT_006d9638 -> 0x6d96e0
  18: pairs(
    "a1e3 a1ca a15b a24e a2b1 a1cc a2b2 a243 a24c a1ec a24d a2b4 a173 a16f a34e f9de a273 f9f0 a2b5 a1cd " +
      "a2b6 a1b0 a1b8 a2b7 a15d a15f a1b3 a1b4 a2b8 a15e a160 a2af a1c5 a1de a1f0 a1f1 a1f2 a1d3 a271 a2a6 " +
      "f9e1 f9ea f9f3 a157 a159 a278 f9f8 a279 a149 a249 a1ad a243 a248 a1f4 a1ae a1af a17d a17e a1c4 a1cf " +
      "a1fc a161 a163 a1a1 a162 a164 a1a2 a1a7 a1a8 a1a9 a1b2 a146 a151 a3b5 a141 a14d a142 a14e a3ae a1d5 " +
      "a1e0 a171 a1d8 a1f6 a1e7 a16d a16f a173 a1f8 a2a9 a2ab a347 a27a a27e f9dd f9e6 f9ef f9fa a1e8 a1fa " +
      "a27c a2a2 f9e3 f9ec f9f5 f9fc a144 a143 a14f a145 a150 a3b2 a1d2 a1dc a1ee a1ef a1f3 a14b a14c a1d6 " +
      "a1e1 a172 a1d9 a1f7 a16e a170 a27d a2a3 f9e5 f9ee f9f7 a1fb a1f9 a174 a1e9 a274 a2a7 f9e2 f9eb f9f4 " +
      "a2a8 a2aa a148 a153",
  ),
  // DAT_006d9640
  20: pairs(
    "a1a2 a1a3 a1a4 a1a5 a1a6 a1a7 a1a8 a1af a1b1 a1b3 a1b5 a1b7 a1b9 a1bb a1bd a3a9 a3dd a3fd baa3 bdba " +
      "c0cc c6ae c6f9",
  ),
};

/** FUN_00608dcd: the double-byte characters that cannot end a line, per language. */
const NO_END_DB: Record<number, Set<number>> = {
  // DAT_006d967c
  15: pairs("8192 8165 8167 8171 8173 8175 8177 8179 816b 8190 8169 816d 816f 8192 818f"),
  // DAT_006d96b4
  17: pairs("a1ae a1b0 a1b2 a1b4 a1b6 a1b8 a1ba a1bc a1be a3a8 a3da"),
  // DAT_006d96cc
  18: pairs("a1a1 a1a3 a1a5 a1a7 a1a9 a1ab"),
  // DAT_006d969c
  20: pairs("a1ae a1b0 a1b2 a1b4 a1b6 a1b8 a1ba a1bc a3a8 a3db a3fb"),
};

/** IsCharBreakingChar: space and hyphen. */
const isBreaking = (c: number): boolean => c === 0x20 || c === 0x2d;
/** IsCharWhitespace. */
const isWhitespace = (c: number): boolean => c === 0x20;
/** IsCharReturnChar. */
const isReturn = (c: number): boolean => c === 10;

/** A string as the bytes the original walks, with the Unicode character each byte belongs to. */
interface Encoded {
  bytes: Uint8Array;
  /** charAt[i]: the index of the character byte i belongs to; charAt[length] = the character count. */
  charAt: Int32Array;
}

const MAX_CACHED_TEXTS = 512;

/** cTSDBFontKorean. */
export class DbFont extends FfnFont {
  override readonly height: number;
  private readonly rendered = new Map<string, HTMLCanvasElement>();
  private readonly rgb = new Map<string, number>();

  constructor(
    private readonly lang: number,
    private readonly f: DbFontFile,
    private readonly data: Uint8Array,
  ) {
    super();
    // Init: the line height is the height of "A" (plus the bold bit, 0 here).
    this.height = this.glyphHeight(0x41);
  }

  /** FUN_00608a15: a character's advance, by its code or its first byte. */
  private width(code: number): number {
    return isLeadByte(this.lang, code) ? this.f.dbSpace + this.f.dbW : this.f.sbSpace + this.f.sbW;
  }

  /** FUN_00608a37: a character's height, margins included. */
  private glyphHeight(code: number): number {
    return this.f.bottom + this.f.top + (isLeadByte(this.lang, code) ? this.f.dbH : this.f.sbH);
  }

  /** FUN_00609af3: 0 at the end of the string, else 1 or 2 bytes. */
  private charLen(b: Uint8Array, i: number): number {
    const c = b[i] ?? 0;
    if (c === 0) return 0;
    return isLeadByte(this.lang, c) ? 2 : 1;
  }

  private codeAt(b: Uint8Array, i: number, n: number): number {
    let c = 0;
    for (let k = 0; k < n; k++) c = (c << 8) | (b[i + k] ?? 0);
    return c;
  }

  private encode(text: string): Encoded {
    const out: number[] = [];
    const owner: number[] = [];
    let index = 0;
    for (const ch of text) {
      const c = gameCharCode(ch, this.lang);
      if (c > 0xff) {
        out.push(c >> 8, c & 0xff);
        owner.push(index, index);
      } else {
        out.push(c);
        owner.push(index);
      }
      index += ch.length;
    }
    owner.push(index);
    return { bytes: Uint8Array.from(out), charAt: Int32Array.from(owner) };
  }

  /** Byte count -> character count (a count ending inside a character takes it whole). */
  private chars(e: Encoded, bytes: number): number {
    if (bytes <= 0) return 0;
    if (bytes >= e.bytes.length) return e.charAt[e.bytes.length]!;
    const next = e.charAt[bytes]!;
    return e.charAt[bytes - 1] === next ? next + 1 : next;
  }

  /** cTSDBFontKorean::GetStringWidth: the advances of the whole characters among n bytes. */
  private bytesWidth(b: Uint8Array, start: number, n: number): number {
    let w = 0;
    let i = start;
    for (;;) {
      if (n === 0) break;
      const len = this.charLen(b, i);
      if (len === 0 || len > n) break;
      // TSCharNextCharOffset of the first byte (plus the bold bit, 0 here).
      w += this.width(b[i]!);
      i += len;
      n -= len;
    }
    return w;
  }

  /** FUN_0060a2ba: the length of the word at `start`, at most `max` bytes. */
  private wordLength(b: Uint8Array, start: number, max: number): number {
    let total = max < 1 ? 0 : this.charLen(b, start);
    if (total === 0) return 0;
    let prev = this.codeAt(b, start, total);
    let p = start + total;
    let prevNoEnd = this.cannotEnd(prev);
    let prevDouble = total > 1;
    let prevControl = prev < 0x20;
    if (total < max) {
      for (;;) {
        const prevMayEnd = !prevNoEnd;
        const n = this.charLen(b, p);
        if (n === 0) break;
        const c = this.codeAt(b, p, n);
        p += n;
        const noStart = this.cannotStart(c);
        prevNoEnd = this.cannotEnd(c);
        if (prevControl || c < 0x20) break;
        if (!noStart && prevMayEnd) {
          if (prevDouble || n > 1) break;
          if (isBreaking(prev & 0xff) && !isBreaking(c & 0xff)) break;
        }
        total += n;
        prevControl = false;
        prev = c;
        prevDouble = n > 1;
        if (total >= max) break;
      }
    }
    return Math.min(total, max);
  }

  private cannotStart(c: number): boolean {
    return c < 0x100 ? NO_START_SB.includes(c) : (NO_START_DB[this.lang]?.has(c) ?? false);
  }

  private cannotEnd(c: number): boolean {
    return c < 0x100 ? NO_END_SB.includes(c) : (NO_END_DB[this.lang]?.has(c) ?? false);
  }

  /** cTSDBFontKorean::CalculateWordsToFitInWidth over bytes. */
  private fitBytes(b: Uint8Array, len: number, width: number): number {
    let i = 0;
    let used = 0;
    if (width > 0) {
      for (;;) {
        if (i >= len || b[i] === 0) break;
        if (isReturn(b[i]!)) {
          i++;
          break;
        }
        const n = this.wordLength(b, i, len - i);
        if (len < i + n || width < this.bytesWidth(b, i, n) + used) break;
        used += this.bytesWidth(b, i, n);
        i += n;
        if (width <= used) break;
      }
    }
    if (i === 0) {
      if (len < 1) return 0;
      while (i < len) {
        const c = b[i]!;
        if (c === 0 || isReturn(c) || isWhitespace(c)) break;
        i++;
      }
    }
    while (i < len && isWhitespace(b[i]!)) i++;
    if (i === 0 && len > 0) i = 1;
    return i;
  }

  override charWidth(code: number): number {
    return this.width(code > 0xff ? code >> 8 : code);
  }

  override stringWidth(text: string): number {
    const e = this.encode(text);
    return this.bytesWidth(e.bytes, 0, e.bytes.length);
  }

  /** GetBaselineHeight (cTSDBFontThai's, shared): the line height + 1. */
  override baselineHeight(): number {
    return this.height + 1;
  }

  override charDims(code: number): { left: number; top: number; right: number; bottom: number } {
    return { left: 0, top: 0, right: this.charWidth(code), bottom: this.glyphHeight(code) };
  }

  /** cTSDBFontKorean::TSTextArea: the advances of the whole characters, one line high. */
  override textArea(text: string): { w: number; h: number } {
    return { w: this.stringWidth(text), h: this.height };
  }

  override calculateWordsToFitInWidth(text: string, start: number, len: number, width: number): number {
    const e = this.encode(text.slice(start, start + len));
    return this.chars(e, this.fitBytes(e.bytes, e.bytes.length, width));
  }

  /** CalculateNumberOfLines (cTSDBFontThai's, shared): no single-line case for width 0. */
  override calculateNumberOfLines(text: string, width: number): number {
    const e = this.encode(text);
    const len = e.bytes.length;
    let lines = 0;
    for (let pos = 0; pos < len; lines++) pos += this.fitBytes(e.bytes.subarray(pos), len - pos, width);
    return lines;
  }

  /** cTSDBFontKorean::TSDrawText (no clip rectangle, no selection). */
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
   * TSDrawText into a bitmap: each glyph (FUN_00609cb9) sets its pixels to the
   * font color, the shadow flag then blacks the pixel below and the one below
   * right, which the next rows' pixels may cover again.
   */
  private render(text: string, color: string): HTMLCanvasElement {
    const { bytes } = this.encode(text);
    const glyphs: Array<{ code: number; x: number }> = [];
    let pen = 0;
    let h = 0;
    for (let i = 0; i < bytes.length; ) {
      const c = bytes[i]!;
      if (c === 0) break;
      if (isLeadByte(this.lang, c)) {
        const code = (c << 8) | (bytes[i + 1] ?? 0);
        glyphs.push({ code, x: pen });
        pen += this.width(code);
        h = Math.max(h, this.glyphHeight(code));
        i += 2;
      } else {
        if (c !== 10) {
          glyphs.push({ code: c, x: pen });
          pen += this.width(c);
          h = Math.max(h, this.glyphHeight(c));
        }
        i++;
      }
    }
    const shadow = (this.flags & FONT_SHADOW) !== 0;
    const w = pen + (shadow ? 1 : 0);
    const bh = h + (shadow ? 1 : 0);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = bh;
    if (w === 0 || bh === 0) return canvas;
    const px = new Uint32Array(w * bh);
    const fg = this.color(color);
    const black = 0xff000000;
    for (const g of glyphs) {
      const gw = this.width(g.code);
      const gh = this.glyphHeight(g.code);
      for (let row = 0; row < gh; row++) {
        for (let col = 0; col < gw; col++) {
          if (!this.pixel(g.code, col, row)) continue;
          const X = g.x + col;
          px[row * w + X] = fg;
          if (shadow && row + 1 < bh) {
            px[(row + 1) * w + X] = black;
            if (X + 1 < w) px[(row + 1) * w + X + 1] = black;
          }
        }
      }
    }
    const ctx = canvas.getContext("2d")!;
    const img = ctx.createImageData(w, bh);
    new Uint32Array(img.data.buffer).set(px);
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /** FUN_00608c05: is the glyph's pixel (x, y) set (y counted from the top margin's top)? */
  private pixel(code: number, x: number, y: number): boolean {
    const f = this.f;
    if (y < f.top) return false;
    y -= f.top;
    const double = isLeadByte(this.lang, code);
    const gw = double ? f.dbW : f.sbW;
    const gh = double ? f.dbH : f.sbH;
    if (x < 0 || x >= gw || y < 0 || y >= gh) return false;
    // FUN_00608a5c: the glyph's bitmap.
    let offset: number;
    if (double) {
      let index = glyphIndex(this.lang, code);
      if (index >= f.dbCount) index = 0;
      offset = f.dbBytes * index + f.sbBytes * 0x100;
    } else {
      offset = f.sbBytes * code;
    }
    const b = this.data[offset + ((gw + 7) >> 3) * y + (x >> 3)] ?? 0;
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

/**
 * cTSWinTextEdit2::TSOnCharacter with cTSDBFontKorean::IsUnsupportedDBLeadByte:
 * a typed character whose first byte leads a double-byte character the font
 * has no glyphs for (Korean: 0x81..0xAF and from 0xC9, outside the hangul
 * rows; Simplified Chinese: 0x81..0xA0 and from 0xFD, outside GB 2312) is
 * entered as "-" and its second byte dropped.
 */
export function dbInputChar(ch: string, lang = UI_LANGUAGE): string {
  const code = gameCharCode(ch, lang);
  if (code <= 0xff) return ch;
  const lead = code >> 8;
  if (lang === 20 && ((lead >= 0x81 && lead <= 0xaf) || lead >= 0xc9)) return "-";
  if (lang === 17 && ((lead >= 0x81 && lead <= 0xa0) || lead >= 0xfd)) return "-";
  return ch;
}
