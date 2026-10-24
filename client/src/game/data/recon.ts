/**
 * Reader for the game's ReconBuffer serialization (uncompressed mode):
 * little-endian 16/32-bit values, NUL-terminated strings padded to an even
 * length (the pad byte may be garbage), booleans as one byte.
 */

const cp1252 = new TextDecoder("windows-1252");

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
