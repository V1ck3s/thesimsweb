/**
 * ReconBuffer, write side (ReconBuffer modes 2 "size" and 1 "write"), and
 * ReconBuilder::Compact, which saves a ReconObject as a chunk:
 *
 *   1. the object streams into a sizing buffer (mode 2): every call only
 *      advances the position;
 *   2. a handle of size + 12 is allocated, the 12-byte header written
 *      (u32 0, i32 version, the four-character tag, little-endian), and the
 *      object streams again in write mode (mode 1) after it.
 *
 * The sizing pass counts compressed bits differently from the write pass
 * (ReconBits mode 2 adds n >> 3 whole bytes first, then walks the remaining
 * bits from a fresh byte), so the measured size can exceed what is written;
 * the rest of the handle stays as allocated (zero here).
 *
 * Compressed integers (ReconCmprInt, write): a "non-zero" bit, then the
 * first precision index whose sign-extension mask the value matches (all
 * ones or all zeros above bit n - 1), then n bits. Bits fill each byte from
 * the MSB; a string or a mark restarts at the next whole byte.
 */

import { encodeCp1252 } from "../data/recon.js";

/** Precision schemes (bit counts per 2-bit index) for 8, 16 and 32-bit values. */
const SCHEME_8 = [2, 4, 6, 8] as const;
const SCHEME_16 = [5, 8, 13, 16] as const;
const SCHEME_32 = [6, 11, 21, 32] as const;

/** Sign-extension mask of an n-bit field (the Scheme's second word). */
function maskOf(n: number): number {
  return n >= 32 ? 0x80000000 | 0 : ~((1 << (n - 1)) - 1);
}

export interface ReconOut {
  readonly compressed: boolean;
  enableCompression(): void;
  recon8(v: number): void;
  reconBool(v: boolean): void;
  recon16(v: number): void;
  recon16s(values: ArrayLike<number>): void;
  recon32(v: number): void;
  reconFloat(v: number): void;
  reconString(s: string): void;
  reconMark(): void;
  /** Current position (bytes from the stream start). */
  readonly pos: number;
}

class ReconWriteBuffer implements ReconOut {
  pos = 0;
  compressed = false;
  /** +0x20: the next free bit of the byte before `pos` (0 = byte full). */
  private bit = 0;
  /** +0x24: where the last mark was written (0 = none yet). */
  private markAt = 0;
  private readonly view: DataView | null;

  constructor(
    /** null: sizing pass (mode 2). */
    private readonly out: Uint8Array | null,
  ) {
    this.view = out ? new DataView(out.buffer, out.byteOffset, out.byteLength) : null;
  }

  enableCompression(): void {
    this.compressed = true;
  }

  /** ReconBits(n, value). */
  private bits(n: number, value: number): void {
    if (!this.out) {
      let k = n;
      if (k > 7) {
        this.pos += k >> 3;
        k &= 7;
      }
      for (; k > 0; k--) {
        if (this.bit === 0) {
          this.pos++;
          this.bit = 0x80;
        }
        this.bit >>= 1;
      }
      return;
    }
    let p = this.pos - 1;
    let b = this.bit;
    for (let m = n - 1; m >= 0; m--) {
      if (b === 0) {
        p++;
        this.out[p] = 0;
        b = 0x80;
      }
      if ((value >>> m) & 1) this.out[p] = this.out[p]! | b;
      b >>= 1;
    }
    this.bit = b;
    this.pos = p + 1;
  }

  private cmprInt(v: number, scheme: readonly number[]): void {
    v |= 0;
    this.bits(1, v !== 0 ? 1 : 0);
    if (v === 0) return;
    let i = 0;
    for (; i < 3; i++) {
      const m = maskOf(scheme[i]!);
      const t = v & m;
      if (t === m || t === 0) break;
    }
    this.bits(2, i);
    this.bits(scheme[i]!, v >>> 0);
  }

  recon8(v: number): void {
    if (this.compressed) {
      this.cmprInt((v << 24) >> 24, SCHEME_8);
      return;
    }
    if (this.out) this.out[this.pos] = v & 0xff;
    this.pos += 1;
  }

  reconBool(v: boolean): void {
    this.recon8(v ? 1 : 0);
  }

  recon16(v: number): void {
    if (this.compressed) {
      this.cmprInt((v << 16) >> 16, SCHEME_16);
      return;
    }
    this.view?.setInt16(this.pos, v, true);
    this.pos += 2;
  }

  recon16s(values: ArrayLike<number>): void {
    for (let i = 0; i < values.length; i++) this.recon16(values[i]!);
  }

  recon32(v: number): void {
    if (this.compressed) {
      this.cmprInt(v, SCHEME_32);
      return;
    }
    this.view?.setInt32(this.pos, v | 0, true);
    this.pos += 4;
  }

  /** ReconFloat: the float's bit pattern, like Recon32. */
  reconFloat(v: number): void {
    const t = new DataView(new ArrayBuffer(4));
    t.setFloat32(0, v, true);
    this.recon32(t.getInt32(0, true));
  }

  /** ReconString (no string table): C string padded to an even offset (the pad byte is left as is). */
  reconString(s: string): void {
    if (this.compressed) this.bit = 0;
    const b = encodeCp1252(s);
    if (this.out) {
      this.out.set(b, this.pos);
      this.out[this.pos + b.length] = 0;
    }
    this.pos += b.length + 1;
    if (this.pos & 1) this.pos++;
  }

  /** ReconMark: the previous mark gets the current offset, this one 0 until the next. */
  reconMark(): void {
    if (this.compressed) this.bit = 0;
    if (this.view) {
      if (this.markAt !== 0) this.view.setInt32(this.markAt, this.pos, true);
      this.markAt = this.pos;
      this.view.setInt32(this.pos, 0, true);
    }
    this.pos += 4;
  }
}

/**
 * ReconBuilder::Compact: `stream` runs twice (sizing, then writing); returns
 * the chunk payload (12-byte header + stream).
 */
export function compactRecon(version: number, tag: string, stream: (w: ReconOut) => void): Uint8Array {
  const sizer = new ReconWriteBuffer(null);
  stream(sizer);
  const size = sizer.pos;
  const out = new Uint8Array(size + 12);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0, true);
  dv.setInt32(4, version, true);
  for (let i = 0; i < 4; i++) out[8 + i] = tag.charCodeAt(3 - i);
  const writer = new ReconWriteBuffer(out.subarray(12));
  stream(writer);
  if (writer.pos > size) throw new Error(`Recon ${tag}: wrote ${writer.pos} bytes, sized ${size}`);
  return out;
}
