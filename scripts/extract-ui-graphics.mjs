#!/usr/bin/env node
// Extracts CPanel bitmaps from UIGraphics.far so the web client can use the
// authentic TS1 control-panel artwork. Outputs land under
// `server/assets/converted/ui/` (gitignored — never commit Maxis assets).
//
// FAR v1a format reminder (docs/formats/FAR.md):
//   header  : "FAR!byAZ" (8) + version u32 (=1) + file_table_offset u32
//   entry   : size_dec u32, size_comp u32, offset u32, name_len u32, name
//
// Usage:  node scripts/extract-ui-graphics.mjs [--list]

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

// Pull every CPanel/* entry — backgrounds, buttons, catalog icons, etc. They
// are standard Windows BMP files (with optional RLE4/RLE8 compression). The
// browser does NOT natively render RLE8 BMPs, but it handles uncompressed
// BMPs at 24/32-bit fine. So: if RLE-compressed, decode to an uncompressed
// 32-bit BMP before saving.

let written = 0;
let skipped = 0;
for (const e of entries) {
  const lower = e.name.toLowerCase();
  if (!lower.startsWith("cpanel\\") && !lower.startsWith("cpanel/")) {
    skipped += 1;
    continue;
  }
  const payload = buf.subarray(e.off, e.off + e.sizeDec);
  // Normalize backslashes for the filesystem.
  const portable = e.name.replaceAll("\\", "/");
  const outPath = join(OUT_DIR, portable);
  mkdirSync(dirname(outPath), { recursive: true });
  const expanded = maybeDecodeBmp(payload, portable);
  writeFileSync(outPath, expanded);
  written += 1;
}
console.error(`wrote ${written} CPanel bitmaps to ${OUT_DIR}, skipped ${skipped} non-CPanel entries`);

// ---------------------------------------------------------------------------
// BMP RLE8 decoder. Standard Windows DIB header:
//   offset 0   2  signature "BM"
//   offset 2   4  file size
//   offset 6   4  reserved
//   offset 10  4  pixel array offset (bfOffBits)
//   offset 14  4  DIB header size (40 = BITMAPINFOHEADER)
//   offset 18  4  width
//   offset 22  4  height
//   offset 26  2  planes (=1)
//   offset 28  2  bpp
//   offset 30  4  compression (0=BI_RGB, 1=BI_RLE8, 2=BI_RLE4)
//   offset 34  4  image size
//   offset 46  4  colors used
//   ... palette starts at offset 14 + DIB header size
// ---------------------------------------------------------------------------

function maybeDecodeBmp(src, debugName) {
  if (src.length < 54 || src[0] !== 0x42 || src[1] !== 0x4d) {
    return src; // not a BMP — leave as-is
  }
  const bfOffBits = src.readUInt32LE(10);
  const dibSize = src.readUInt32LE(14);
  const width = src.readInt32LE(18);
  const heightSigned = src.readInt32LE(22);
  const bpp = src.readUInt16LE(28);
  const compression = src.readUInt32LE(30);
  if (compression !== 1) return src; // BI_RGB or RLE4 — leave alone for now
  if (bpp !== 8) return src;
  const height = Math.abs(heightSigned);
  const topDown = heightSigned < 0;
  // Palette is between DIB header end and bfOffBits.
  const paletteStart = 14 + dibSize;
  const paletteEnd = bfOffBits;
  const palette = src.subarray(paletteStart, paletteEnd); // BGRA quads
  const rleStart = bfOffBits;
  // Decode RLE8 → 8-bit indexed grid, then expand to 32-bit BGRA pixels.
  // Track which pixels the stream actually wrote — anything left untouched
  // is considered transparent (the RLE delta escape skips pixels which
  // become "background" / "see-through" in the original game).
  const pixelGrid = new Uint8Array(width * height);
  const written = new Uint8Array(width * height);
  let i = rleStart;
  let x = 0;
  let y = topDown ? 0 : height - 1;
  const stepY = topDown ? 1 : -1;
  const writePixel = (px, py, val) => {
    if (px >= 0 && px < width && py >= 0 && py < height) {
      pixelGrid[py * width + px] = val;
      written[py * width + px] = 1;
    }
  };
  while (i < src.length - 1) {
    const n = src[i];
    const v = src[i + 1];
    i += 2;
    if (n > 0) {
      for (let k = 0; k < n; k += 1) {
        writePixel(x, y, v);
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
        writePixel(x, y, src[i + k]);
        x += 1;
      }
      i += v + (v & 1);
    }
    if (topDown ? y >= height : y < 0) break;
  }
  // Build an uncompressed BGRA BMP. Trick: BMPs are bottom-up unless height
  // is negative. Keep the original orientation by emitting top-down (negative
  // height) so we can write rows in natural order.
  const rowBytes = width * 4;
  const pad = (4 - (rowBytes & 3)) & 3;
  const stride = rowBytes + pad;
  const pixelDataSize = stride * height;
  const dibOut = 40;
  const headerSize = 14 + dibOut;
  const out = Buffer.alloc(headerSize + pixelDataSize);
  out.write("BM", 0, "ascii");
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(0, 6);
  out.writeUInt32LE(headerSize, 10);
  out.writeUInt32LE(dibOut, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(-height, 22); // top-down
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(32, 28);
  out.writeUInt32LE(0, 30); // BI_RGB
  out.writeUInt32LE(pixelDataSize, 34);
  out.writeInt32LE(2835, 38); // X pels/m
  out.writeInt32LE(2835, 42); // Y pels/m
  out.writeUInt32LE(0, 46);
  out.writeUInt32LE(0, 50);
  // RLE8 typically reserves palette index 0 as the transparent colour (the
  // "background" / unwritten pixel). Mark fully-transparent in the output so
  // the BMP can sit on top of the page background.
  for (let row = 0; row < height; row += 1) {
    const dstBase = topDown
      ? headerSize + row * stride
      : headerSize + (height - 1 - row) * stride;
    for (let col = 0; col < width; col += 1) {
      const idx = pixelGrid[row * width + col];
      const palBase = idx * 4;
      const b = palette[palBase] ?? 0;
      const g = palette[palBase + 1] ?? 0;
      const r = palette[palBase + 2] ?? 0;
      const o = dstBase + col * 4;
      out[o] = b;
      out[o + 1] = g;
      out[o + 2] = r;
      out[o + 3] = written[row * width + col] ? 255 : 0;
    }
  }
  if (debugName) {
    // Light log: width x height for the largest entries to sanity-check layout.
    if (width * height >= 10000) {
      console.error(`  decoded ${debugName}  ${width}x${height}`);
    }
  }
  return out;
}
