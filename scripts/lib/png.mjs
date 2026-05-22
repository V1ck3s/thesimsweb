// Tiny PNG encoder for RGBA grids — zlib-compressed IDAT with no filtering.
// Just enough to convert our decoded TS1 bitmaps into a transparency-aware
// format the browser supports natively. Avoids pulling pngjs/sharp.

import { deflateSync } from "node:zlib";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// IEEE 802.3 CRC-32 (the one PNG uses) — precompute the lookup table once.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** Encode RGBA pixel data (Uint8Array of length 4*w*h, row-major top-down) into a PNG. */
export function encodePngRgba(width, height, rgba) {
  // IHDR: width, height, bit_depth=8, color_type=6 (RGBA), filter=0, compression=0, interlace=0.
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);
  // IDAT: each scanline prefixed with a 1-byte filter (0 = none) then raw RGBA.
  const rowLen = width * 4;
  const raw = Buffer.alloc(height * (rowLen + 1));
  for (let y = 0; y < height; y += 1) {
    const dstBase = y * (rowLen + 1);
    raw[dstBase] = 0;
    for (let x = 0; x < rowLen; x += 1) {
      raw[dstBase + 1 + x] = rgba[y * rowLen + x] ?? 0;
    }
  }
  const idat = deflateSync(raw);
  return Buffer.concat([PNG_SIG, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}
