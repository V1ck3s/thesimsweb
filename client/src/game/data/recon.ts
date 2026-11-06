/**
 * Reader for the game's ReconBuffer serialization (uncompressed mode):
 * little-endian 16/32-bit values, NUL-terminated strings padded to an even
 * length (the pad byte may be garbage), booleans as one byte.
 */

import { encodeGameText, gameTextDecoder } from "../res/codepage.js";

/** The game's code page (res/codepage.ts; Windows-1252 for the western languages). */
const cp1252 = gameTextDecoder;

export class ReconReader {
  private readonly view: DataView;
  pos = 0;

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remaining(): number {
    return this.bytes.length - this.pos;
  }

  i32(): number {
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  u32(): number {
    return this.i32() >>> 0;
  }

  i16(): number {
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }

  i16s(n: number): Int16Array {
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) out[i] = this.i16();
    return out;
  }

  u8(): number {
    return this.bytes[this.pos++]!;
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  /** ReconString: C string, then skip to an even offset. */
  cstr(): string {
    let end = this.pos;
    while (end < this.bytes.length && this.bytes[end] !== 0) end++;
    const s = cp1252.decode(this.bytes.subarray(this.pos, end));
    this.pos = end + 1;
    if (this.pos & 1) this.pos++;
    return s;
  }

  /** Four ASCII characters stored as a little-endian u32 ("SRBN" for NBRS). */
  tag(): string {
    const s = String.fromCharCode(...this.bytes.subarray(this.pos, this.pos + 4));
    this.pos += 4;
    return s;
  }
}

/** Encodes a string as the game's bytes (res/codepage.ts; unmapped characters become "?"). */
export function encodeCp1252(s: string): Uint8Array {
  return encodeGameText(s);
}

/** Writer side of ReconBuffer (uncompressed mode), mirror of ReconReader. */
export class ReconWriter {
  private buf = new Uint8Array(256);
  private view = new DataView(this.buf.buffer);
  pos = 0;

  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  i32(v: number): void {
    this.ensure(4);
    this.view.setInt32(this.pos, v | 0, true);
    this.pos += 4;
  }

  i16(v: number): void {
    this.ensure(2);
    this.view.setInt16(this.pos, v, true);
    this.pos += 2;
  }

  i16s(values: ArrayLike<number>): void {
    for (let i = 0; i < values.length; i++) this.i16(values[i]!);
  }

  u8(v: number): void {
    this.ensure(1);
    this.buf[this.pos++] = v & 0xff;
  }

  bool(v: boolean): void {
    this.u8(v ? 1 : 0);
  }

  /** ReconString: C string padded to an even length with `pad` (the game leaves garbage there). */
  cstr(s: string, pad = 0): void {
    const b = encodeCp1252(s);
    this.ensure(b.length + 2);
    this.buf.set(b, this.pos);
    this.pos += b.length;
    this.buf[this.pos++] = 0;
    if (this.pos & 1) this.buf[this.pos++] = pad;
  }

  /** Four ASCII characters stored as a little-endian u32. */
  tag(t: string): void {
    for (let i = 0; i < 4; i++) this.u8(t.charCodeAt(i));
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}
