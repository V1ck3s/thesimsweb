/**
 * Sprite decoding for SPR2 (z-buffered sprites: objects, floors) and SPR#
 * (old paletted sprites: walls, old-style z-sprite pairs).
 *
 * Decoding follows the game's blitters rather than a generic RGBA decode:
 *  - SPR2 (Spr2Decoder555/565): row command 0 starts a row, 4 skips rows,
 *    5 ends; pixel command 1 = (z, color) pairs written with a depth test and
 *    a depth write (no transparent-color test), 2 = (z, color, alpha) blended
 *    with the destination by the 5-bit alpha, depth tested but not written,
 *    3 = skip, 6 = color only (floor sprites, FloorBlit).
 *  - SPR# (Decompressor): rows of (cmd, count) bytes; pixels 1 = skip,
 *    2 = run of one index, 3 = literal indices; row 4 = row, 9 = skip rows,
 *    5 = end. Transparent pixels decode to 0xff, which is also what the
 *    z-sprite half of a 501/503 pair uses for "no pixel" (ZSpriteBlit).
 */

/** How a decoded pixel is drawn. */
export const PX_NONE = 0;
/** Color + z: depth tested and written (SPR2 cmd 1, SPR# z-sprite pairs). */
export const PX_OPAQUE = 1;
/** Color + z + alpha: blended, depth tested, no depth write (SPR2 cmd 2). */
export const PX_ALPHA = 2;
/** Color only (SPR2 cmd 6, SPR# pixels): drawn by the floor/wall blitters. */
export const PX_COLOR = 3;

export interface SpriteFrame {
  width: number;
  height: number;
  /** SPR2 frame header y/x location (multi-tile alignment). */
  yLoc: number;
  xLoc: number;
  /** Palette indices (one byte per pixel). */
  index: Uint8Array;
  /** Z channel (0 = nearest; 0xff where the sprite has none). */
  z: Uint8Array;
  /** 5-bit alpha (0..31) for PX_ALPHA pixels. */
  alpha: Uint8Array;
  /** PX_* per pixel. */
  mode: Uint8Array;
  /** PALT chunk id used by this frame. */
  paletteId: number;
  transparentIndex: number;
}

function newFrame(width: number, height: number): SpriteFrame {
  const n = width * height;
  const z = new Uint8Array(n);
  z.fill(0xff);
  return {
    width,
    height,
    yLoc: 0,
    xLoc: 0,
    index: new Uint8Array(n),
    z,
    alpha: new Uint8Array(n),
    mode: new Uint8Array(n),
    paletteId: 0,
    transparentIndex: -1,
  };
}

// --- SPR2 --------------------------------------------------------------------

export interface Spr2Header {
  version: number;
  count: number;
  defaultPalette: number;
  /** Byte offset of each frame (start of its width field). */
  offsets: number[];
}

export function parseSpr2Header(b: Uint8Array): Spr2Header {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const version = v.getUint32(0, true);
  const offsets: number[] = [];
  if (version === 1000) {
    const count = v.getUint32(4, true);
    const defaultPalette = v.getUint32(8, true);
    for (let i = 0; i < count; i++) offsets.push(v.getUint32(12 + i * 4, true));
    return { version, count, defaultPalette, offsets };
  }
  // 1001: frames are self-describing (version, size, then the frame).
  const defaultPalette = v.getUint32(4, true);
  const count = v.getUint32(8, true);
  let p = 12;
  for (let i = 0; i < count && p + 8 <= b.length; i++) {
    const size = v.getUint32(p + 4, true);
    offsets.push(p + 8);
    p += 8 + size;
  }
  return { version, count: offsets.length, defaultPalette, offsets };
}

export function decodeSpr2Frame(b: Uint8Array, hdr: Spr2Header, frameIndex: number): SpriteFrame | null {
  const off = hdr.offsets[frameIndex];
  if (off === undefined || off + 16 > b.length) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const width = v.getUint16(off, true);
  const height = v.getUint16(off + 2, true);
  const f = newFrame(width, height);
  // SpriteListInfo::SpriteListInfo (SPR2 branch) binds the list's palette
  // (header +8) to every frame: the frame's own palette field (+8, often 0xa3a3
  // but also stale ids such as 0xfefe or another PALT) is never read.
  f.paletteId = hdr.defaultPalette;
  f.transparentIndex = v.getUint16(off + 10, true);
  f.yLoc = v.getInt16(off + 12, true);
  f.xLoc = v.getInt16(off + 14, true);
  let p = off + 16;
  let row = -1;
  while (p + 2 <= b.length) {
    const w = v.getUint16(p, true);
    p += 2;
    const cmd = w >> 13;
    const count = w & 0x1fff;
    if (cmd === 5) break;
    if (cmd === 4) {
      row += count;
      continue;
    }
    if (cmd !== 0) continue;
    row++;
    // Pixel commands until the row block (count bytes incl. its header) ends.
    const end = p - 2 + count;
    let x = 0;
    while (p + 2 <= end) {
      const pw = v.getUint16(p, true);
      p += 2;
      const pc = pw >> 13;
      const n = pw & 0x1fff;
      const base = row * width;
      if (pc === 1) {
        for (let i = 0; i < n; i++, x++) {
          if (x < width && row < height) {
            f.z[base + x] = b[p]!;
            f.index[base + x] = b[p + 1]!;
            f.mode[base + x] = PX_OPAQUE;
          }
          p += 2;
        }
      } else if (pc === 2) {
        for (let i = 0; i < n; i++, x++) {
          if (x < width && row < height) {
            f.z[base + x] = b[p]!;
            f.index[base + x] = b[p + 1]!;
            f.alpha[base + x] = b[p + 2]!;
            f.mode[base + x] = PX_ALPHA;
          }
          p += 3;
        }
        p += p & 1;
      } else if (pc === 3) {
        x += n;
      } else if (pc === 6) {
        for (let i = 0; i < n; i++, x++) {
          if (x < width && row < height) {
            const idx = b[p]!;
            f.index[base + x] = idx;
            if (idx !== f.transparentIndex) {
              f.mode[base + x] = PX_COLOR;
              f.z[base + x] = 0;
            }
          }
          p += 1;
        }
        p += p & 1;
      } else {
        break;
      }
    }
    p = end;
  }
  return f;
}

// --- SPR# --------------------------------------------------------------------

export interface SprHeader {
  version: number;
  count: number;
  palette: number;
  offsets: number[];
}

export function parseSprHeader(b: Uint8Array): SprHeader {
  const le = b[0] !== 0 || b[1] !== 0;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const version = v.getUint32(0, le);
  const offsets: number[] = [];
  if (version === 1001) {
    const palette = v.getInt32(8, le);
    let p = 12;
    while (p + 8 <= b.length) {
      const size = v.getUint32(p + 4, le);
      offsets.push(p + 8);
      p += 8 + size;
    }
    return { version, count: offsets.length, palette, offsets };
  }
  const count = v.getUint32(4, le);
  const palette = v.getInt32(8, le);
  for (let i = 0; i < count; i++) offsets.push(v.getUint32(12 + i * 4, le));
  return { version, count, palette, offsets };
}

/**
 * Decode one SPR# frame to palette indices; transparent pixels get index 0xff
 * and mode PX_NONE, others PX_COLOR.
 */
export function decodeSprFrame(b: Uint8Array, hdr: SprHeader, frameIndex: number): SpriteFrame | null {
  const off = hdr.offsets[frameIndex];
  if (off === undefined || off + 8 > b.length) return null;
  const le = b[0] !== 0 || b[1] !== 0;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const height = v.getUint16(off + 4, le);
  const width = v.getUint16(off + 6, le);
  const f = newFrame(width, height);
  f.index.fill(0xff);
  f.paletteId = hdr.palette;
  let p = off + 8;
  let row = 0;
  while (p + 2 <= b.length && row <= height) {
    const cmd = b[p]!;
    const count = b[p + 1]!;
    p += 2;
    if (cmd === 5) break;
    if (cmd === 9) {
      row += count;
      continue;
    }
    if (cmd === 0 || cmd === 0x10) continue;
    if (cmd !== 4) break;
    const end = p - 2 + count;
    let x = 0;
    const base = row * width;
    while (p + 2 <= end) {
      const pc = b[p]!;
      const n = b[p + 1]!;
      p += 2;
      if (pc === 1) {
        x += n;
      } else if (pc === 2) {
        const idx = b[p]!;
        for (let i = 0; i < n; i++, x++) {
          if (x < width && row < height) {
            f.index[base + x] = idx;
            f.mode[base + x] = PX_COLOR;
          }
        }
        p += 2;
      } else if (pc === 3) {
        for (let i = 0; i < n; i++, x++) {
          if (x < width && row < height) {
            f.index[base + x] = b[p + i]!;
            f.mode[base + x] = PX_COLOR;
          }
        }
        p += n + (n & 1);
      } else {
        break;
      }
    }
    p = end;
    row++;
  }
  return f;
}

/**
 * Combine a pixel frame and its z frame (SPR# versions 501/503 keep pixel
 * shapes in the first half of the list and z shapes in the second half):
 * pixels whose z is 0xff are not drawn (ZSpriteBlit).
 */
export function combineZSprite(pixels: SpriteFrame, zf: SpriteFrame): SpriteFrame {
  const f = newFrame(pixels.width, pixels.height);
  f.paletteId = pixels.paletteId;
  f.index.set(pixels.index);
  for (let y = 0; y < f.height; y++) {
    for (let x = 0; x < f.width; x++) {
      const i = y * f.width + x;
      const z = y < zf.height && x < zf.width ? zf.index[y * zf.width + x]! : 0xff;
      f.z[i] = z;
      f.mode[i] = z === 0xff ? PX_NONE : PX_OPAQUE;
    }
  }
  return f;
}

/** PALT chunk -> 256 RGB triplets. */
export function parsePalt(b: Uint8Array): Uint8Array {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const n = Math.min(256, v.getUint32(4, true));
  const out = new Uint8Array(768);
  out.set(b.subarray(16, 16 + n * 3));
  return out;
}
