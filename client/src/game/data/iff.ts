/**
 * Raw IFF ("IFF FILE 2.5") read/write, for the files the game itself writes:
 * character files (StubObject::CreateNew, PersonFinder saves) and
 * Neighborhood.iff (Neighborhood::Save).
 *
 * Layout: a 60-byte signature, at 60 a big-endian u32 offset of the resource
 * map, then chunks of { type[4], size u32 BE (header included), id i16 BE,
 * flags u16 BE, label[64] } + payload. The resource map ("rsmp", id 0) lists
 * every chunk; its payload (little-endian) is
 *   u32 0, u32 version 0, "pmsr", u32 size, u32 type count,
 *   per type: the type code reversed, u32 count,
 *     per chunk: u32 offset, u16 id, u16 flags, label C-string padded to an even length.
 * Deleted chunks keep their bytes under the type "XXXX" (iResFile frees space
 * that way); they are not resources and are dropped here.
 *
 * Strings sets (STR#, CTSS, FAMs) are written in format -3 (0xFFFD) by
 * StringSetBase::Save / StringSetMulti::Save: u16 0xFFFD, u16 count, then per
 * string a language byte (language index + 1), the string and its comment as
 * C strings (Windows-1252). Both size the buffer as 4 + sum(len + comment + 4)
 * (one byte more per string than they fill); that slack is kept, zeroed.
 */

import { gameTextDecoder } from "../res/codepage.js";
import { encodeCp1252 } from "./recon.js";

export interface IffChunk {
  type: string;
  id: number;
  flags: number;
  label: string;
  data: Uint8Array;
}

const SIGNATURE = "IFF FILE 2.5:TYPE FOLLOWED BY SIZE\0 JAMIE DOORNBOS & MAXIS 1";
const HEADER = 64;
const CHUNK_HEADER = 76;
const cp1252 = gameTextDecoder;

function cstrAt(b: Uint8Array, start: number, end: number): string {
  let e = start;
  while (e < end && b[e] !== 0) e++;
  return cp1252.decode(b.subarray(start, e));
}

/** Every resource chunk of an IFF file, in file order (XXXX and rsmp skipped). */
export function parseIff(bytes: Uint8Array): IffChunk[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: IffChunk[] = [];
  let p = HEADER;
  while (p + CHUNK_HEADER <= bytes.length) {
    const type = String.fromCharCode(...bytes.subarray(p, p + 4));
    const size = v.getUint32(p + 4, false);
    if (size < CHUNK_HEADER || p + size > bytes.length) break;
    if (type !== "XXXX" && type !== "rsmp") {
      out.push({
        type,
        id: v.getInt16(p + 8, false),
        flags: v.getUint16(p + 10, false),
        label: cstrAt(bytes, p + 12, p + CHUNK_HEADER),
        data: bytes.slice(p + CHUNK_HEADER, p + size),
      });
    }
    p += size;
  }
  return out;
}

/**
 * Resource order of the file's map: types in map order, chunks in map order
 * (the order iResFile::CountTypes / GetIndType enumerate them). Falls back
 * to file order when there is no map.
 */
export function parseIffMapOrder(bytes: Uint8Array): IffChunk[] {
  const chunks = parseIff(bytes);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const map = bytes.length >= HEADER ? v.getUint32(60, false) : 0;
  if (map === 0 || map + CHUNK_HEADER > bytes.length || String.fromCharCode(...bytes.subarray(map, map + 4)) !== "rsmp") return chunks;
  const b = bytes.subarray(map + CHUNK_HEADER, map + v.getUint32(map + 4, false));
  const mv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const byOffset = new Map<number, IffChunk>();
  {
    let p = HEADER;
    let i = 0;
    while (p + CHUNK_HEADER <= bytes.length) {
      const type = String.fromCharCode(...bytes.subarray(p, p + 4));
      const size = v.getUint32(p + 4, false);
      if (size < CHUNK_HEADER) break;
      if (type !== "XXXX" && type !== "rsmp") byOffset.set(p, chunks[i++]!);
      p += size;
    }
  }
  const out: IffChunk[] = [];
  let p = 20;
  const nTypes = mv.getUint32(16, true);
  for (let t = 0; t < nTypes && p + 8 <= b.length; t++) {
    const n = mv.getUint32(p + 4, true);
    p += 8;
    for (let i = 0; i < n; i++) {
      const c = byOffset.get(mv.getUint32(p, true));
      if (c) out.push(c);
      p += 8;
      while (b[p] !== 0) p++;
      p++;
      if (p & 1) p++;
    }
  }
  return out.length === chunks.length ? out : chunks;
}

function labelBytes(label: string): Uint8Array {
  const out = new Uint8Array(64);
  out.set(encodeCp1252(label).subarray(0, 63));
  return out;
}

/** The rsmp payload for chunks placed at `offsets` (types in first-seen order). */
function buildRsmp(chunks: IffChunk[], offsets: number[]): Uint8Array {
  const types: string[] = [];
  for (const c of chunks) if (!types.includes(c.type)) types.push(c.type);
  const parts: number[] = [];
  const u32 = (x: number): void => {
    parts.push(x & 0xff, (x >>> 8) & 0xff, (x >>> 16) & 0xff, (x >>> 24) & 0xff);
  };
  const u16 = (x: number): void => {
    parts.push(x & 0xff, (x >>> 8) & 0xff);
  };
  u32(0);
  u32(0);
  parts.push(..."pmsr".split("").map((c) => c.charCodeAt(0)));
  u32(0); // size, patched below
  u32(types.length);
  for (const t of types) {
    for (let i = 3; i >= 0; i--) parts.push(t.charCodeAt(i));
    const list = chunks.map((c, i) => ({ c, off: offsets[i]! })).filter((x) => x.c.type === t);
    u32(list.length);
    for (const { c, off } of list) {
      u32(off);
      u16(c.id & 0xffff);
      u16(c.flags);
      parts.push(...encodeCp1252(c.label), 0);
      if (parts.length & 1) parts.push(0);
    }
  }
  const out = new Uint8Array(parts);
  // The game stores the map chunk's full size there when it writes a fresh map.
  new DataView(out.buffer).setUint32(12, out.length + CHUNK_HEADER, true);
  return out;
}

/** Writes an IFF with the chunks in order and the resource map at the end. */
export function buildIff(chunks: IffChunk[]): Uint8Array {
  const offsets: number[] = [];
  let p = HEADER;
  for (const c of chunks) {
    offsets.push(p);
    p += CHUNK_HEADER + c.data.length;
  }
  const rsmp = buildRsmp(chunks, offsets);
  const all = [...chunks, { type: "rsmp", id: 0, flags: 0x10, label: "", data: rsmp }];
  const total = p + CHUNK_HEADER + rsmp.length;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  out.set(encodeCp1252(SIGNATURE));
  v.setUint32(60, p, false);
  let q = HEADER;
  for (const c of all) {
    for (let i = 0; i < 4; i++) out[q + i] = c.type.charCodeAt(i);
    v.setUint32(q + 4, CHUNK_HEADER + c.data.length, false);
    v.setInt16(q + 8, c.id, false);
    v.setUint16(q + 10, c.flags, false);
    out.set(labelBytes(c.label), q + 12);
    out.set(c.data, q + CHUNK_HEADER);
    q += CHUNK_HEADER + c.data.length;
  }
  return out;
}

export interface StrEntry {
  /** Language code (index + 1; 1 = US English). */
  lang: number;
  value: string;
  comment: string;
}

/** Format -3 string set, sized like StringSetBase/StringSetMulti::Save. */
export function encodeStrSet(entries: StrEntry[]): Uint8Array {
  const enc = entries.map((e) => ({ lang: e.lang, v: encodeCp1252(e.value), c: encodeCp1252(e.comment) }));
  const size = 4 + enc.reduce((n, e) => n + e.v.length + e.c.length + 4, 0);
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 0xfffd, true);
  dv.setUint16(2, entries.length, true);
  let p = 4;
  for (const e of enc) {
    out[p++] = e.lang;
    out.set(e.v, p);
    p += e.v.length + 1;
    out.set(e.c, p);
    p += e.c.length + 1;
  }
  return out;
}

/** Decodes format -3 / -2 string sets with their language codes (others: no entries). */
export function decodeStrSet(b: Uint8Array): StrEntry[] {
  if (b.length < 4) return [];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const fmt = dv.getInt16(0, true);
  const n = dv.getUint16(2, true);
  const out: StrEntry[] = [];
  let p = 4;
  const str = (): string => {
    const s = cstrAt(b, p, b.length);
    while (p < b.length && b[p] !== 0) p++;
    p++;
    return s;
  };
  if (fmt !== -3 && fmt !== -2) return out;
  for (let i = 0; i < n && p < b.length; i++) {
    const lang = fmt === -3 ? b[p++]! : 1;
    const value = str();
    const comment = str();
    out.push({ lang, value, comment });
  }
  return out;
}

/** Number of language slots StringSetMulti keeps (cProductionStrings vector). */
const LANG_SLOTS = 20;

/**
 * StringSetMulti::SetString(i, s) for the current language followed by
 * StringSetMulti::Save: the existing chunk is merged in, every language that
 * has native strings gets the US English strings it lacks (marked copied),
 * languages left with no native string are dropped, comments propagate from
 * US English.
 */
export function stringSetMultiSave(existing: Uint8Array | null, lang: number, values: string[]): Uint8Array {
  type Prod = { value: string; comment: string; native: boolean };
  const slots: Prod[][] = Array.from({ length: LANG_SLOTS }, () => []);
  for (const e of existing ? decodeStrSet(existing) : []) {
    const s = slots[e.lang - 1];
    if (s) s.push({ value: e.value, comment: e.comment, native: true });
  }
  const cur = slots[lang - 1]!;
  values.forEach((v, i) => {
    const prev = cur[i];
    cur[i] = { value: v, comment: prev?.comment ?? "", native: true };
  });
  const english = slots[0]!;
  for (let i = 0; i < english.length; i++) {
    const desc = english[i]!.comment;
    if (!desc) continue;
    for (let l = 1; l < LANG_SLOTS; l++) {
      const p = slots[l]![i];
      if (p) p.comment = desc;
    }
  }
  for (let l = 1; l < LANG_SLOTS; l++) {
    const s = slots[l]!;
    for (let i = s.length; i < english.length; i++) s.push({ value: english[i]!.value, comment: english[i]!.comment, native: false });
    if (!s.some((p) => p.native)) slots[l] = [];
  }
  const entries: StrEntry[] = [];
  slots.forEach((s, l) => s.forEach((p) => entries.push({ lang: l + 1, value: p.value, comment: p.comment })));
  return encodeStrSet(entries);
}

/**
 * StringSetMulti::Load followed by StringSetMulti::SaveLocal: every one of
 * the language slots is written, a slot the chunk lacks holding the US
 * English strings (as Neighborhood::ExportFamily's CTSS 2000 + id copies).
 */
export function stringSetMultiSaveLocal(existing: Uint8Array): Uint8Array {
  const slots: StrEntry[][] = Array.from({ length: LANG_SLOTS }, () => []);
  for (const e of decodeStrSet(existing)) slots[e.lang - 1]?.push(e);
  const english = slots[0]!;
  const entries: StrEntry[] = [];
  slots.forEach((s, l) => {
    for (const e of s.length ? s : english) entries.push({ lang: l + 1, value: e.value, comment: e.comment });
  });
  return encodeStrSet(entries);
}

/**
 * StringSetBase::Load then Save into another file (single language): the
 * current language's entries (else US English's, else all) re-tagged with
 * the current language.
 */
export function stringSetBaseResave(existing: Uint8Array, lang: number): Uint8Array {
  const all = decodeStrSet(existing);
  const pick = all.some((e) => e.lang === lang) ? all.filter((e) => e.lang === lang) : all.some((e) => e.lang === 1) ? all.filter((e) => e.lang === 1) : all;
  return encodeStrSet(pick.map((e) => ({ ...e, lang })));
}
