/**
 * cXPerson::ReconStream (read): what follows the cXObject part of a person
 * record in the house's ObjM stream, up to the person data. The rest (saved
 * routes, the interaction queue, object records, motive increments) is left
 * to ReadToNextMark.
 *
 *   v < 0xb   0x1c floats (old motives, discarded)
 *   v > 2     SAnimator::ReconStream (below)
 *   v > 3     +0x78c motives[16] (floats)
 *   v >= 8    +0x7cc 16 more floats (Motives' second block)
 *   v > 10    +0x58c person data: 0x40 shorts (v < 0x29), 0x50 (v < 0x47), else 0x100
 *
 * SAnimator::ReconStream:
 *   v < 0x2f  3 floats, a short (current animation), a short count + count
 *             pairs of ints (an old path)
 *   v > 0xc   two ints (+0xa4, +0xa0)
 *   v >= 0x33 five dressing records (two strings each: body, texture), then
 *             an int count + that many accessory records
 *   v > 0x3a  three practices saved as strings (main, carry, background)
 *   v > 0x3c  an int (animation state), nine floats
 */

import type { ReconBuffer } from "./reconbuffer.js";

export interface PersonRecord {
  /** +0x78c */
  motives: Float32Array;
  /** +0x7cc */
  motives2: Float32Array;
  /** +0x58c (0x100 shorts, the shorter old blocks zero-padded). */
  personData: Int16Array;
  /** SAnimator dressing records (body / texture names). */
  dressing: Array<[string, string]>;
  accessories: Array<[string, string]>;
  /** SAnimator practices saved as strings: main, carry, background. */
  practices: string[];
}

function floats(buf: ReconBuffer, n: number, out?: Float32Array): void {
  for (let i = 0; i < n; i++) {
    const f = buf.reconFloat();
    if (out && i < out.length) out[i] = f;
  }
}

export function readPersonStream(buf: ReconBuffer, v: number): PersonRecord {
  const r: PersonRecord = {
    motives: new Float32Array(16),
    motives2: new Float32Array(16),
    personData: new Int16Array(0x100),
    dressing: [],
    accessories: [],
    practices: [],
  };
  if (v < 0xb) floats(buf, 0x1c);
  if (v > 2) {
    // SAnimator::ReconStream
    if (v < 0x2f) {
      floats(buf, 3);
      buf.recon16();
      const n = buf.recon16();
      for (let i = 0; i < n; i++) {
        buf.recon32();
        buf.recon32();
      }
    }
    if (v > 0xc) {
      buf.recon32();
      buf.recon32();
    }
    if (v >= 0x33) {
      for (let i = 0; i < 5; i++) r.dressing.push([buf.reconString(), buf.reconString()]);
      const n = buf.recon32();
      for (let i = 0; i < n; i++) r.accessories.push([buf.reconString(), buf.reconString()]);
    }
    if (v > 0x3a) for (let i = 0; i < 3; i++) r.practices.push(buf.reconString());
    if (v > 0x3c) {
      buf.recon32();
      floats(buf, 9);
    }
    if (v > 3) floats(buf, 0x10, r.motives);
    if (v >= 8) floats(buf, 0x10, r.motives2);
  }
  if (v > 10) {
    const n = v < 0x29 ? 0x40 : v < 0x47 ? 0x50 : 0x100;
    for (let i = 0; i < n; i++) r.personData[i] = buf.recon16();
  }
  return r;
}
