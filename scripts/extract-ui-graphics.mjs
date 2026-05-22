#!/usr/bin/env node
// Extract CPanel bitmaps from UIGraphics.far and convert them to PNGs with
// authentic TS1 transparency (magenta keying + RLE8 "untouched" pixels).
//
// Why PNG: the original Maxis BMPs lean on two transparency conventions —
//   1. RLE8 streams may leave pixels untouched; those should be transparent.
//   2. Uncompressed BMPs use #FF00FF (magenta) as the chroma-key colour.
// Neither survives a round-trip through a 32-bit BMP that the browser will
// decode as opaque (browsers ignore the alpha channel of BI_RGB 32-bit BMPs).
// Re-emitting as PNG (with proper RGBA) lets the browser composite the panel
// chrome correctly over the canvas.
//
// FAR v1a format reminder (docs/formats/FAR.md):
//   header  : "FAR!byAZ" (8) + version u32 (=1) + file_table_offset u32
//   entry   : size_dec u32, size_comp u32, offset u32, name_len u32, name
//
// Usage:  node scripts/extract-ui-graphics.mjs [--list]

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodePngRgba } from "./lib/png.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAR_PATH = join(REPO, "server/assets/Sims/UIGraphics/UIGraphics.far");
const OUT_DIR = join(REPO, "server/assets/converted/ui");

const listOnly = process.argv.includes("--list");

const buf = readFileSync(FAR_PATH);
if (buf.subarray(0, 8).toString("ascii") !== "FAR!byAZ") {
  throw new Error("Not a FAR archive (bad magic)");
}
const version = buf.readUInt32LE(8);
const manifestOff = buf.readUInt32LE(12);
console.error(`FAR v${version}  manifest@${manifestOff}  total ${buf.length} bytes`);

let p = manifestOff;
const count = buf.readUInt32LE(p);
p += 4;
const entries = [];
for (let i = 0; i < count; i += 1) {
  const sizeDec = buf.readUInt32LE(p);
  const sizeCmp = buf.readUInt32LE(p + 4);
  const off = buf.readUInt32LE(p + 8);
  const nameLen = buf.readUInt32LE(p + 12);
  const name = buf.subarray(p + 16, p + 16 + nameLen).toString("ascii");
  entries.push({ name, off, sizeDec, sizeCmp });
  p += 16 + nameLen;
}
console.error(`${entries.length} entries`);

if (listOnly) {
  for (const e of entries) console.log(`${e.sizeDec.toString().padStart(8)}  ${e.name}`);
  process.exit(0);
}

// Extract every CPanel/* and Nbhd/* entry. Each BMP becomes a .png at the same
// relative path so we can swap the asset suffix in the client without
// restructuring any directories.
const EXTRACT_PREFIXES = ["cpanel\\", "cpanel/", "nbhd\\", "nbhd/"];
let written = 0;
let skipped = 0;
for (const e of entries) {
  const lower = e.name.toLowerCase();
  if (!EXTRACT_PREFIXES.some((pfx) => lower.startsWith(pfx))) {
    skipped += 1;
    continue;
  }
  const payload = buf.subarray(e.off, e.off + e.sizeDec);
  const portable = e.name.replaceAll("\\", "/");
  // Some FAR entries are not BMPs (TGA, etc.) — pass them through unchanged.
  const isBmp = payload.length >= 2 && payload[0] === 0x42 && payload[1] === 0x4d;
  let outPath;
  let outBuf;
  if (isBmp) {
    const png = decodeBmpToPng(payload, portable);
    if (png) {
      outPath = join(OUT_DIR, portable.replace(/\.bmp$/i, ".png"));
      outBuf = png;
    } else {
      outPath = join(OUT_DIR, portable);
      outBuf = payload;
    }
  } else {
    outPath = join(OUT_DIR, portable);
    outBuf = payload;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, outBuf);
  written += 1;
}
console.error(`wrote ${written} CPanel+Nbhd assets to ${OUT_DIR}, skipped ${skipped} other entries`);

// ---------------------------------------------------------------------------
// BMP → RGBA decoder + PNG encoder. Handles BI_RGB 24-bit, BI_RGB 8-bit
// (paletted), and BI_RLE8 (paletted with run-length compression). Other
// flavours fall through to a raw copy.
// ---------------------------------------------------------------------------

/** Returns a Buffer with the PNG bytes, or null if the BMP couldn't be decoded. */
function decodeBmpToPng(src, debugName) {
  if (src.length < 54) return null;
  const bfOffBits = src.readUInt32LE(10);
  const dibSize = src.readUInt32LE(14);
  const width = src.readInt32LE(18);
  const heightSigned = src.readInt32LE(22);
  const bpp = src.readUInt16LE(28);
  const compression = src.readUInt32LE(30);
  const colorsUsed = src.readUInt32LE(46);
  const height = Math.abs(heightSigned);
  const topDown = heightSigned < 0;
  if (width <= 0 || height <= 0 || width > 4096 || height > 4096) return null;

  const paletteStart = 14 + dibSize;
  const paletteEnd = bfOffBits;
  const palette = src.subarray(paletteStart, paletteEnd); // BGRA quads

  // Output buffer, top-down RGBA.
  const rgba = new Uint8Array(width * height * 4);

  if (compression === 1 && bpp === 8) {
    decodeRle8(src, bfOffBits, width, height, topDown, palette, rgba);
  } else if (compression === 0 && bpp === 8) {
    decodeIndexed8(src, bfOffBits, width, height, topDown, palette, rgba);
  } else if (compression === 0 && bpp === 24) {
    decodeRgb24(src, bfOffBits, width, height, topDown, rgba);
  } else if (compression === 0 && bpp === 32) {
    decodeRgb32(src, bfOffBits, width, height, topDown, rgba);
  } else if (compression === 0 && bpp === 4) {
    decodeIndexed4(src, bfOffBits, width, height, topDown, palette, rgba);
  } else {
    return null;
  }

  // Magenta keying — TS1 BMPs use #FF00FF as the canonical chroma-key colour
  // for backgrounds and dropshadow holes. Replace any opaque magenta pixel
  // with full transparency so the panel chrome composites cleanly.
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue;
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    // Slight tolerance for off-by-one encoders that wrote #FE00FE / #FF00FE.
    if (r >= 0xfe && g <= 0x02 && b >= 0xfe) {
      rgba[i + 3] = 0;
      rgba[i] = 0;
      rgba[i + 1] = 0;
      rgba[i + 2] = 0;
    }
  }

  if (debugName && width * height >= 10000) {
    console.error(`  decoded ${debugName}  ${width}x${height} bpp=${bpp} compr=${compression}`);
  }
  return encodePngRgba(width, height, rgba);
}

function writeRgba(dst, x, y, w, r, g, b, a) {
  const o = (y * w + x) * 4;
  dst[o] = r;
  dst[o + 1] = g;
  dst[o + 2] = b;
  dst[o + 3] = a;
}

function paletteRgb(palette, idx) {
  const o = idx * 4;
  return {
    r: palette[o + 2] ?? 0,
    g: palette[o + 1] ?? 0,
    b: palette[o] ?? 0,
  };
}

function decodeRle8(src, bfOff, w, h, topDown, palette, dst) {
  // RLE8 escapes:
  //   00 00 = end of line, 00 01 = end of bitmap, 00 02 dx dy = delta,
  //   00 n (n>=3) followed by n indexes (padded to word) = absolute mode,
  //   n v (n>=1) = run of n pixels of index v.
  // Untouched pixels stay alpha 0.
  let i = bfOff;
  let x = 0;
  let y = topDown ? 0 : h - 1;
  const stepY = topDown ? 1 : -1;
  while (i < src.length - 1) {
    const n = src[i];
    const v = src[i + 1];
    i += 2;
    if (n > 0) {
      const { r, g, b } = paletteRgb(palette, v);
      for (let k = 0; k < n; k += 1) {
        if (x < w && y >= 0 && y < h) writeRgba(dst, x, y, w, r, g, b, 255);
        x += 1;
      }
    } else if (v === 0) {
      x = 0;
      y += stepY;
    } else if (v === 1) {
      break;
    } else if (v === 2) {
      const dx = src[i];
      const dy = src[i + 1];
      i += 2;
      x += dx;
      y += stepY * dy;
    } else {
      for (let k = 0; k < v; k += 1) {
        const { r, g, b } = paletteRgb(palette, src[i + k]);
        if (x < w && y >= 0 && y < h) writeRgba(dst, x, y, w, r, g, b, 255);
        x += 1;
      }
      i += v + (v & 1);
    }
    if (topDown ? y >= h : y < 0) break;
  }
}

function decodeIndexed8(src, bfOff, w, h, topDown, palette, dst) {
  // Each row is padded to a multiple of 4 bytes.
  const stride = (w + 3) & ~3;
  for (let row = 0; row < h; row += 1) {
    const srcY = topDown ? row : h - 1 - row;
    const base = bfOff + srcY * stride;
    for (let x = 0; x < w; x += 1) {
      const idx = src[base + x] ?? 0;
      const { r, g, b } = paletteRgb(palette, idx);
      writeRgba(dst, x, row, w, r, g, b, 255);
    }
  }
}

function decodeIndexed4(src, bfOff, w, h, topDown, palette, dst) {
  const stride = ((w + 1) >> 1) + 3;
  const padded = stride & ~3;
  for (let row = 0; row < h; row += 1) {
    const srcY = topDown ? row : h - 1 - row;
    const base = bfOff + srcY * padded;
    for (let x = 0; x < w; x += 1) {
      const byte = src[base + (x >> 1)] ?? 0;
      const idx = (x & 1) === 0 ? (byte >> 4) & 0x0f : byte & 0x0f;
      const { r, g, b } = paletteRgb(palette, idx);
      writeRgba(dst, x, row, w, r, g, b, 255);
    }
  }
}

function decodeRgb24(src, bfOff, w, h, topDown, dst) {
  const rowBytes = w * 3;
  const pad = (4 - (rowBytes & 3)) & 3;
  const stride = rowBytes + pad;
  for (let row = 0; row < h; row += 1) {
    const srcY = topDown ? row : h - 1 - row;
    const base = bfOff + srcY * stride;
    for (let x = 0; x < w; x += 1) {
      const o = base + x * 3;
      const b = src[o] ?? 0;
      const g = src[o + 1] ?? 0;
      const r = src[o + 2] ?? 0;
      writeRgba(dst, x, row, w, r, g, b, 255);
    }
  }
}

function decodeRgb32(src, bfOff, w, h, topDown, dst) {
  const stride = w * 4;
  for (let row = 0; row < h; row += 1) {
    const srcY = topDown ? row : h - 1 - row;
    const base = bfOff + srcY * stride;
    for (let x = 0; x < w; x += 1) {
      const o = base + x * 4;
      const b = src[o] ?? 0;
      const g = src[o + 1] ?? 0;
      const r = src[o + 2] ?? 0;
      // Alpha channel in 32-bit BI_RGB is usually unused — force opaque so
      // the magenta keying step (later) controls transparency.
      writeRgba(dst, x, row, w, r, g, b, 255);
    }
  }
}
