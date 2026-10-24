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
 */

interface Glyph {
  x: number;
  y: number;
  w: number;
  h: number;
  bearing: number;
  top: number;
  advance: number;
}

export class FfnFont {
  readonly height: number;
  private readonly glyphs = new Map<number, Glyph>();
  private readonly extraWidth: number;
  private readonly atlasW: number;
  private readonly atlasH: number;
  private readonly coverage: Uint8Array;
  private readonly tinted = new Map<string, HTMLCanvasElement>();

  constructor(bytes: Uint8Array) {
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

  charWidth(code: number): number {
    return this.glyphs.get(code)?.advance ?? 0;
  }

  stringWidth(text: string): number {
    let w = 0;
    for (const ch of text) w += this.charWidth(toCp1252(ch));
    return w + this.extraWidth;
  }

  /** Draw `text` with its top-left at (x, y). */
  drawText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void {
    const atlas = this.atlasFor(color);
    let pen = x;
    for (const ch of text) {
      const g = this.glyphs.get(toCp1252(ch));
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

const CP1252: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x2c6: 0x88, 0x2030: 0x89, 0x160: 0x8a, 0x2039: 0x8b, 0x152: 0x8c, 0x17d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x2dc: 0x98,
  0x2122: 0x99, 0x161: 0x9a, 0x203a: 0x9b, 0x153: 0x9c, 0x17e: 0x9e, 0x178: 0x9f,
};

/** Game strings are Windows-1252; glyph codes are those bytes. */
function toCp1252(ch: string): number {
  const cp = ch.codePointAt(0)!;
  return cp < 0x100 ? cp : (CP1252[cp] ?? 0x3f);
}
