/**
 * Minimal ZIP archives for the saves export / import (engine/saves.ts).
 *
 * Writing stores the files uncompressed (method 0): the save files are small
 * and the archive only has to round-trip. Reading takes stored and deflated
 * (method 8) entries, the latter through DecompressionStream("deflate-raw"),
 * so an archive repacked by an operating system's zip tool imports too.
 * No ZIP64, no encryption, no multi-disk archives.
 */

export interface ZipEntry {
  /** Path inside the archive, "/"-separated. */
  path: string;
  bytes: Uint8Array;
  /** Modification time (ms since the epoch). */
  mtime?: number;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time (local time, 2 s precision, 1980..2107). */
function dosDateTime(ms: number): { date: number; time: number } {
  const d = new Date(ms);
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  };
}

function fromDosDateTime(date: number, time: number): number {
  return new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2).getTime();
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
/** General purpose flag bit 11: names are UTF-8. */
const UTF8_FLAG = 0x0800;

/** A store-only ZIP archive of `entries`. */
export function zipStore(entries: readonly ZipEntry[]): Blob {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.path);
    const crc = crc32(e.bytes);
    const { date, time } = dosDateTime(e.mtime ?? Date.now());
    const size = e.bytes.length;
    if (size >= 0xffffffff || offset >= 0xffffffff) throw new Error("zip: archive too large (no ZIP64)");

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_SIG, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, UTF8_FLAG, true);
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);

    const cen = new Uint8Array(46 + name.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, CENTRAL_SIG, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, UTF8_FLAG, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    // extra, comment, disk, internal and external attributes: 0
    cv.setUint32(42, offset, true);
    cen.set(name, 46);

    parts.push(local, e.bytes);
    central.push(cen);
    offset += local.length + size;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  if (entries.length > 0xffff) throw new Error("zip: too many files (no ZIP64)");
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, END_SIG, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end].map((p) => p as Uint8Array<ArrayBuffer>), { type: "application/zip" });
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") throw new Error("zip: this browser cannot read compressed archives");
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The files of a ZIP archive (directories left out). Throws on anything it cannot read. */
export async function unzip(data: Uint8Array): Promise<ZipEntry[]> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // The end of central directory record: last 22 bytes plus an optional comment (< 64 KiB).
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === END_SIG) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("not a ZIP archive");
  const count = view.getUint16(end + 10, true);
  let p = view.getUint32(end + 16, true);
  if (p === 0xffffffff) throw new Error("ZIP64 archives are not supported");
  const utf8 = new TextDecoder("utf-8");
  const latin = new TextDecoder("latin1");
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > data.length || view.getUint32(p, true) !== CENTRAL_SIG) throw new Error("ZIP: damaged central directory");
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const time = view.getUint16(p + 12, true);
    const date = view.getUint16(p + 14, true);
    const crc = view.getUint32(p + 16, true);
    const compSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOff = view.getUint32(p + 42, true);
    const nameBytes = data.subarray(p + 46, p + 46 + nameLen);
    const path = (flags & UTF8_FLAG ? utf8 : latin).decode(nameBytes).replace(/\\/g, "/");
    p += 46 + nameLen + extraLen + commentLen;
    if (path.endsWith("/")) continue;
    if (flags & 1) throw new Error(`ZIP: ${path} is encrypted`);
    if (view.getUint32(localOff, true) !== LOCAL_SIG) throw new Error(`ZIP: ${path}: damaged local header`);
    const start = localOff + 30 + view.getUint16(localOff + 26, true) + view.getUint16(localOff + 28, true);
    const raw = data.subarray(start, start + compSize);
    if (raw.length !== compSize) throw new Error(`ZIP: ${path} is truncated`);
    let bytes: Uint8Array;
    if (method === 0) bytes = raw.slice();
    else if (method === 8) bytes = await inflateRaw(raw);
    else throw new Error(`ZIP: ${path}: compression method ${method} is not supported`);
    if (bytes.length !== size || crc32(bytes) !== crc) throw new Error(`ZIP: ${path} is damaged (checksum)`);
    out.push({ path, bytes, mtime: fromDosDateTime(date, time) });
  }
  return out;
}
