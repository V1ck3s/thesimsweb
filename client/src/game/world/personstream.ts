/**
 * cXPerson::ReconStream (read): what follows the cXObject part of a person
 * record in the house's ObjM stream. The person data and the animator's
 * dressing are used; the tail (saved routes, the interaction queue, object
 * records, motive increments) is only kept for saving (world/housesave.ts),
 * and ReadToNextMark skips whatever was not read.
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
  /** SAnimator +0xa4 / +0xa0 (v > 0xc), +0x188 state and the nine floats (+0x208.., +0x8c..) (v > 0x3c). */
  animInts?: [number, number];
  animState?: number;
  animFloats?: Float32Array;
  /** The record's tail (v > 0xc): saved routes, interactions, object records, motive increments. */
  tail?: PersonTail;
}

/** Interaction::DoStream fields (Interaction, 0x3c bytes). */
export interface SavedInteraction {
  /** +0 */
  i0: number;
  /** +0x34 (the game keeps the largest as the next unique id). */
  uid: number;
  /** +4 person, +8 / +0xc objects (ids). */
  person: number;
  object1: number;
  object2: number;
  /** +0x10 */
  i10: number;
  /** +0x14..+0x1a */
  shorts: Int16Array;
  /** +0x1c */
  i1c: number;
  /** +0x20 */
  s20: number;
  /** +0x24 */
  f24: number;
  /** +0x38 flags (v >= 0x3e; older streams' booleans folded in). */
  flags: number;
}

/** cXPerson::ReconStream after the person data. */
export interface PersonTail {
  /** +0xaa0 XRoute vector: only its size is saved. */
  routeCount: number;
  /** +0xa08 / +0xa44 (v > 0x2a). */
  current: SavedInteraction | null;
  last: SavedInteraction | null;
  /** +0x820 queue (v > 0x2a). */
  queue: SavedInteraction[];
  /** +0xab0 ObjectRecord vector: object id, int, bool. */
  objectRecords: Array<{ object: number; value: number; flag: boolean }>;
  /** +0xa80 MotiveInc vector (v > 0x2b): motive, delta, limit. */
  motiveIncs: Array<{ motive: number; delta: number; limit: number }>;
}

/** Interaction::DoStream (read). */
function readInteraction(buf: ReconBuffer, v: number): SavedInteraction {
  const i0 = buf.recon32();
  const uid = buf.recon32();
  const person = buf.recon16();
  const object1 = buf.recon16();
  const object2 = buf.recon16();
  const i10 = buf.recon32();
  const shorts = buf.recon16s(4);
  const i1c = buf.recon32();
  const s20 = buf.recon16();
  const f24 = buf.reconFloat();
  let flags = 0;
  if (v < 0x3e) {
    if (buf.reconBool()) flags |= 4;
    if (buf.reconBool()) flags |= 0x20;
    if (flags & 4) {
      if (buf.reconBool()) flags |= 8;
      if (buf.reconBool()) flags |= 0x10;
    }
    if (v > 0x3b && buf.reconBool()) flags |= 2;
  } else flags = buf.recon32();
  return { i0, uid, person, object1, object2, i10, shorts, i1c, s20, f24, flags };
}

/** The tail of cXPerson::ReconStream (read). */
function readPersonTail(buf: ReconBuffer, v: number): PersonTail {
  const t: PersonTail = { routeCount: 0, current: null, last: null, queue: [], objectRecords: [], motiveIncs: [] };
  if (v > 0xc) t.routeCount = buf.recon32();
  if (v > 0x2a) {
    t.current = readInteraction(buf, v);
    t.last = readInteraction(buf, v);
    const n = buf.recon32();
    for (let i = 0; i < n; i++) t.queue.push(readInteraction(buf, v));
    const m = buf.recon32();
    for (let i = 0; i < m; i++) t.objectRecords.push({ object: buf.recon16(), value: buf.recon32(), flag: buf.reconBool() });
  }
  if (v > 0x2b) {
    const n = buf.recon32();
    for (let i = 0; i < n; i++) t.motiveIncs.push({ motive: buf.recon32(), delta: buf.reconFloat(), limit: buf.reconFloat() });
  }
  return t;
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
    if (v > 0xc) r.animInts = [buf.recon32(), buf.recon32()];
    if (v >= 0x33) {
      for (let i = 0; i < 5; i++) r.dressing.push([buf.reconString(), buf.reconString()]);
      const n = buf.recon32();
      for (let i = 0; i < n; i++) r.accessories.push([buf.reconString(), buf.reconString()]);
    }
    if (v > 0x3a) for (let i = 0; i < 3; i++) r.practices.push(buf.reconString());
    if (v > 0x3c) {
      r.animState = buf.recon32();
      r.animFloats = new Float32Array(9);
      floats(buf, 9, r.animFloats);
    }
    if (v > 3) floats(buf, 0x10, r.motives);
    if (v >= 8) floats(buf, 0x10, r.motives2);
  }
  if (v > 10) {
    const n = v < 0x29 ? 0x40 : v < 0x47 ? 0x50 : 0x100;
    for (let i = 0; i < n; i++) r.personData[i] = buf.recon16();
  }
  // The tail is kept for saving; a stream it does not parse leaves it undefined.
  try {
    r.tail = readPersonTail(buf, v);
  } catch {
    delete r.tail;
  }
  return r;
}
