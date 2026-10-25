/**
 * Windows BMP encoder for the portraits the game stores in character files
 * (BMP_ 2002..2007). Those are 24-bit, bottom-up, uncompressed, rows padded
 * to 4 bytes, with a 54-byte header whose file size and image size fields are
 * left at 0 (as in the shipped User*.iff files). The 8-bit form writes a
 * 256-entry palette built from the image's colors (at most 256).
 */

export function encodeBmp(rgba: Uint8ClampedArray, w: number, h: number, bpp: 8 | 24): Uint8Array {
  const paletteSize = bpp === 8 ? 256 * 4 : 0;
  const stride = (((w * bpp) / 8 + 3) & ~3) >>> 0;
  const offBits = 54 + paletteSize;
  const out = new Uint8Array(offBits + stride * h);
  const v = new DataView(out.buffer);
  out[0] = 0x42;
  out[1] = 0x4d;
  v.setUint32(10, offBits, true);
  v.setUint32(14, 40, true);
  v.setInt32(18, w, true);
  v.setInt32(22, h, true);
  v.setUint16(26, 1, true);
  v.setUint16(28, bpp, true);
  if (bpp === 24) {
    for (let y = 0; y < h; y++) {
      const row = offBits + (h - 1 - y) * stride;
      for (let x = 0; x < w; x++) {
        const s = (y * w + x) * 4;
        out[row + x * 3] = rgba[s + 2]!;
        out[row + x * 3 + 1] = rgba[s + 1]!;
        out[row + x * 3 + 2] = rgba[s]!;
      }
    }
    return out;
  }
  const index = new Map<number, number>();
  for (let y = 0; y < h; y++) {
    const row = offBits + (h - 1 - y) * stride;
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      const key = (rgba[s]! << 16) | (rgba[s + 1]! << 8) | rgba[s + 2]!;
      let i = index.get(key);
      if (i === undefined) {
        if (index.size >= 256) throw new Error("encodeBmp: more than 256 colors for an 8-bit bitmap");
        i = index.size;
        index.set(key, i);
        out[54 + i * 4] = rgba[s + 2]!;
        out[54 + i * 4 + 1] = rgba[s + 1]!;
        out[54 + i * 4 + 2] = rgba[s]!;
      }
      out[row + x] = i;
    }
  }
  v.setUint32(46, 256, true);
  return out;
}
