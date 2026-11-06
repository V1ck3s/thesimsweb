/**
 * Decoders for the image formats used by the game UI: Windows BMP (1/4/8 bpp
 * paletted, RLE4/RLE8, 16/24/32 bpp) and Truevision TGA (raw/RLE, 8/16/24/32 bpp).
 *
 * Output is always top-down RGBA. Maxis UI bitmaps use pure magenta
 * (255, 0, 255) as the transparent color; `colorKey` turns it into alpha 0.
 */

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}

export interface DecodeOptions {
  /** Treat (255, 0, 255) as fully transparent. */
  colorKey?: boolean;
  /**
   * A TGA's colours are premultiplied by its alpha: divide them back
   * (GIMEXFactory with its flag lbl_105BA7EC set, see gimexUnpremultiply).
   */
  unpremultiply?: boolean;
}

export function decodeImage(bytes: Uint8Array, name: string, opts: DecodeOptions = {}): RgbaImage {
  const tga = name.toLowerCase().endsWith(".tga");
  const img = tga ? decodeTga(bytes) : decodeBmp(bytes);
  if (tga && opts.unpremultiply) gimexUnpremultiply(img);
  if (opts.colorKey) applyColorKey(img);
  return img;
}

/**
 * GIMEXFactory (nsSMResFac::LoadBuffer of a TGA with an 8-bit alpha): the
 * shipped UI TGAs hold colours premultiplied by their alpha. With the flag
 * lbl_105BA7EC set (its value at start, cleared only around
 * cMagiclandSprites::LoadClouds' three Magic Town fog TGAs) a pixel of alpha
 * 0 takes the transparent colour, alpha 0xff keeps its colour, and any other
 * alpha gets its colour times 255 / alpha + 0.5, truncated (Windows build,
 * 0x4decd4: x87, the 255 / alpha quotient kept in the FPU) and passed as a
 * byte to the 16-bit conversion (FUN_005dfe3b), so a result above 255 wraps;
 * the alpha goes to the buffer's alpha buffer unchanged. With the flag clear
 * the colours are kept as they are.
 *
 * TallSubPanel.TGA and UniversalBack.tga are premultiplied (no colour above
 * its alpha); HotSpotPopupTiler.tga is not (a constant 0, 0, 82 under a
 * varying alpha), and the original's division wraps its low-alpha colours.
 */
export function gimexUnpremultiply(img: RgbaImage): void {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3]!;
    if (a === 0) {
      d[i] = 0xff;
      d[i + 1] = 0;
      d[i + 2] = 0xff;
    } else if (a !== 0xff) {
      const k = 255 / a;
      for (let c = i; c < i + 3; c++) d[c] = Math.trunc(d[c]! * k + 0.5) & 0xff;
    }
  }
}

export function applyColorKey(img: RgbaImage): void {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] === 255 && d[i + 1] === 0 && d[i + 2] === 255) d[i + 3] = 0;
  }
}

export function decodeBmp(bytes: Uint8Array): RgbaImage {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint16(0, true) !== 0x4d42) throw new Error("not a BMP");
  const dataOffset = v.getUint32(10, true);
  const headerSize = v.getUint32(14, true);
  const width = v.getInt32(18, true);
  const rawHeight = v.getInt32(22, true);
  const bpp = v.getUint16(28, true);
  const compression = headerSize >= 40 ? v.getUint32(30, true) : 0;
  const topDown = rawHeight < 0;
  const height = Math.abs(rawHeight);
  const out = new Uint8ClampedArray(width * height * 4);

  let palette: Uint8Array | null = null;
  if (bpp <= 8) {
    const count = (headerSize >= 40 ? v.getUint32(46, true) : 0) || 1 << bpp;
    palette = new Uint8Array(256 * 4);
    const base = 14 + headerSize;
    for (let i = 0; i < count && i < 256; i++) {
      palette[i * 4] = bytes[base + i * 4 + 2]!;
      palette[i * 4 + 1] = bytes[base + i * 4 + 1]!;
      palette[i * 4 + 2] = bytes[base + i * 4]!;
      palette[i * 4 + 3] = 255;
    }
  }

  const put = (x: number, row: number, r: number, g: number, b: number): void => {
    if (x >= width || row >= height) return;
    const y = topDown ? row : height - 1 - row;
    const o = (y * width + x) * 4;
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = 255;
  };
  const putIndex = (x: number, row: number, idx: number): void => {
    const p = palette!;
    put(x, row, p[idx * 4]!, p[idx * 4 + 1]!, p[idx * 4 + 2]!);
  };

  if (compression === 1 || compression === 2) {
    // RLE8 / RLE4. Pixels skipped by delta/end-of-line stay transparent.
    const rle4 = compression === 2;
    let p = dataOffset;
    let x = 0;
    let row = 0;
    while (p < bytes.length && row < height) {
      const count = bytes[p++]!;
      const val = bytes[p++]!;
      if (count > 0) {
        for (let i = 0; i < count; i++) {
          const idx = rle4 ? (i & 1 ? val & 15 : val >> 4) : val;
          putIndex(x++, row, idx);
        }
      } else if (val === 0) {
        x = 0;
        row++;
      } else if (val === 1) {
        break;
      } else if (val === 2) {
        x += bytes[p++]!;
        row += bytes[p++]!;
      } else {
        for (let i = 0; i < val; i++) {
          const idx = rle4 ? (i & 1 ? bytes[p + (i >> 1)]! & 15 : bytes[p + (i >> 1)]! >> 4) : bytes[p + i]!;
          putIndex(x++, row, idx);
        }
        const used = rle4 ? (val + 1) >> 1 : val;
        p += used + (used & 1);
      }
    }
    return { width, height, data: out };
  }

  const stride = (((width * bpp + 31) >> 5) << 2) >>> 0;
  let rMask = 0x7c00;
  let gMask = 0x03e0;
  let bMask = 0x001f;
  if (compression === 3 && headerSize >= 40) {
    rMask = v.getUint32(54, true);
    gMask = v.getUint32(58, true);
    bMask = v.getUint32(62, true);
  }
  const channel = (px: number, mask: number): number => {
    if (!mask) return 0;
    const shift = Math.clz32(mask & -mask) ^ 31;
    const max = mask >>> shift;
    return Math.round((((px & mask) >>> shift) * 255) / max);
  };

  for (let row = 0; row < height; row++) {
    const line = dataOffset + row * stride;
    for (let x = 0; x < width; x++) {
      switch (bpp) {
        case 1:
          putIndex(x, row, (bytes[line + (x >> 3)]! >> (7 - (x & 7))) & 1);
          break;
        case 4:
          putIndex(x, row, x & 1 ? bytes[line + (x >> 1)]! & 15 : bytes[line + (x >> 1)]! >> 4);
          break;
        case 8:
          putIndex(x, row, bytes[line + x]!);
          break;
        case 16: {
          const px = v.getUint16(line + x * 2, true);
          put(x, row, channel(px, rMask), channel(px, gMask), channel(px, bMask));
          break;
        }
        case 24:
          put(x, row, bytes[line + x * 3 + 2]!, bytes[line + x * 3 + 1]!, bytes[line + x * 3]!);
          break;
        case 32:
          put(x, row, bytes[line + x * 4 + 2]!, bytes[line + x * 4 + 1]!, bytes[line + x * 4]!);
          break;
        default:
          throw new Error(`unsupported BMP depth ${bpp}`);
      }
    }
  }
  return { width, height, data: out };
}

export function decodeTga(bytes: Uint8Array): RgbaImage {
  const idLength = bytes[0]!;
  const colorMapType = bytes[1]!;
  const type = bytes[2]!;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cmapFirst = v.getUint16(3, true);
  const cmapLength = v.getUint16(5, true);
  const cmapDepth = bytes[7]!;
  const width = v.getUint16(12, true);
  const height = v.getUint16(14, true);
  const bpp = bytes[16]!;
  const descriptor = bytes[17]!;
  const topDown = (descriptor & 0x20) !== 0;
  let p = 18 + idLength;

  const cmap: number[][] = [];
  if (colorMapType === 1) {
    const entry = Math.ceil(cmapDepth / 8);
    for (let i = 0; i < cmapLength; i++) {
      cmap[cmapFirst + i] = readPixel(bytes, p + i * entry, cmapDepth);
    }
    p += cmapLength * Math.ceil(cmapDepth / 8);
  }

  const pixelSize = Math.ceil(bpp / 8);
  const rle = type >= 9;
  const mapped = type === 1 || type === 9;
  const gray = type === 3 || type === 11;
  const total = width * height;
  const out = new Uint8ClampedArray(total * 4);
  const pixel = (offset: number): number[] => {
    if (mapped) return cmap[bytes[offset]!] ?? [0, 0, 0, 255];
    if (gray) return [bytes[offset]!, bytes[offset]!, bytes[offset]!, 255];
    return readPixel(bytes, offset, bpp);
  };
  const store = (i: number, px: number[]): void => {
    const x = i % width;
    const row = (i / width) | 0;
    const y = topDown ? row : height - 1 - row;
    out.set(px, (y * width + x) * 4);
  };

  let i = 0;
  while (i < total) {
    if (rle) {
      const header = bytes[p++]!;
      const count = (header & 0x7f) + 1;
      if (header & 0x80) {
        const px = pixel(p);
        p += pixelSize;
        for (let k = 0; k < count && i < total; k++) store(i++, px);
      } else {
        for (let k = 0; k < count && i < total; k++) {
          store(i++, pixel(p));
          p += pixelSize;
        }
      }
    } else {
      store(i++, pixel(p));
      p += pixelSize;
    }
  }
  return { width, height, data: out };
}

function readPixel(b: Uint8Array, o: number, bpp: number): number[] {
  switch (bpp) {
    case 32:
      return [b[o + 2]!, b[o + 1]!, b[o]!, b[o + 3]!];
    case 24:
      return [b[o + 2]!, b[o + 1]!, b[o]!, 255];
    case 16:
    case 15: {
      const px = b[o]! | (b[o + 1]! << 8);
      const c5 = (c: number): number => (c << 3) | (c >> 2);
      return [c5((px >> 10) & 31), c5((px >> 5) & 31), c5(px & 31), 255];
    }
    default:
      return [b[o]!, b[o]!, b[o]!, 255];
  }
}
