/**
 * ReconBuffer (read mode): the game's serialization stream, with the bit-packed
 * "compressed" integer encoding (ReconBuffer::EnableCompression) and the
 * marks (ReconMark / ReadToNextMark) object streams use to delimit records.
 *
 * Plain mode reads little-endian 8/16/32-bit values. Compressed mode reads
 * every integer with ReconCmprInt: one "non-zero" bit, then a 2-bit precision
 * index into the type's scheme (lbl_105BBBF4/F8/FC, set by __sinit_Recon_cpp),
 * then that many bits, sign-extended. Bits are consumed MSB first; strings and
 * marks restart at the next whole byte.
 */

const cp1252 = new TextDecoder("windows-1252");

/** Precision schemes (bit counts per 2-bit index) for 8, 16 and 32-bit values. */
const SCHEME_8 = [2, 4, 6, 8] as const;
const SCHEME_16 = [5, 8, 13, 16] as const;
const SCHEME_32 = [6, 11, 21, 32] as const;

export class ReconBuffer {
  /** Read position (+8), relative to the buffer start. */
  pos = 0;
  /** +0x12: compressed integers. */
  compressed = false;
  /** +0x20: current bit within the byte before `pos` (0 = byte exhausted). */
  private bit = 0;
  /** +0x24: offset of the next record, read by ReconMark. */
  private mark = 0;
  private readonly view: DataView;

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /**
   * ReconBuilder::Reconstitute: a Recon chunk starts with a 12-byte header
   * (byte-order flag, stream version, four-character tag); the stream proper
   * starts after it.
   */
  static fromChunk(payload: Uint8Array): { buf: ReconBuffer; version: number; tag: string } {
    if (payload.length < 12) throw new Error("Recon chunk: short header");
    const version = new DataView(payload.buffer, payload.byteOffset, 12).getInt32(4, true);
    const tag = String.fromCharCode(...payload.subarray(8, 12));
    return { buf: new ReconBuffer(payload.subarray(12)), version, tag };
  }

  enableCompression(): void {
    this.compressed = true;
  }

  private bits(n: number): number {
    let v = 0;
    let p = this.pos - 1;
    for (let b = n - 1; b >= 0; b--) {
      if (this.bit === 0) {
        this.bit = 0x80;
        p++;
      }
      if (this.bytes[p]! & this.bit) v |= 1 << b;
      this.bit >>= 1;
    }
    this.pos = p + 1;
    return v >>> 0;
  }

  /** ReconCmprInt (read): returns the sign-extended 32-bit value. */
  private cmprInt(scheme: readonly number[]): number {
    if (this.bits(1) === 0) return 0;
    const n = scheme[this.bits(2)]!;
    const v = this.bits(n);
    if (n >= 32) return v | 0;
    return v & (1 << (n - 1)) ? v | (-1 << (n - 1)) : v;
  }

  /** Recon8: signed byte. */
  recon8(): number {
    if (this.compressed) return (this.cmprInt(SCHEME_8) << 24) >> 24;
    return (this.bytes[this.pos++]! << 24) >> 24;
  }

  /** ReconBool: one Recon8, any non-zero value is true. */
  reconBool(): boolean {
    return this.recon8() !== 0;
  }

  /** Recon16: signed 16-bit value. */
  recon16(): number {
    if (this.compressed) return (this.cmprInt(SCHEME_16) << 16) >> 16;
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }

  recon16s(n: number): Int16Array {
    const out = new Int16Array(Math.max(0, n));
    for (let i = 0; i < out.length; i++) out[i] = this.recon16();
    return out;
  }

  /** Recon32 / ReconInt: signed 32-bit value. */
  recon32(): number {
    if (this.compressed) return this.cmprInt(SCHEME_32);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  /** ReconFloat: the 32-bit pattern of a float, read like Recon32. */
  reconFloat(): number {
    const tmp = new DataView(new ArrayBuffer(4));
    tmp.setInt32(0, this.recon32(), true);
    return tmp.getFloat32(0, true);
  }

  /** ReconString (no string table): C string padded to an even offset. */
  reconString(): string {
    if (this.compressed) this.bit = 0;
    let end = this.pos;
    while (end < this.bytes.length && this.bytes[end] !== 0) end++;
    const s = cp1252.decode(this.bytes.subarray(this.pos, end));
    this.pos = end + 1;
    if (this.pos & 1) this.pos++;
    return s;
  }

  /** ReconMark: a raw 32-bit offset of the next record. */
  reconMark(): void {
    if (this.compressed) this.bit = 0;
    this.mark = this.view.getInt32(this.pos, true);
    this.pos += 4;
  }

  /** ReadToNextMark: skip the rest of the current record. */
  readToNextMark(): void {
    if (this.compressed) this.bit = 0;
    this.pos = this.mark;
  }

  /** Offset the last ReconMark points to (for consistency checks). */
  get nextMark(): number {
    return this.mark;
  }
}
