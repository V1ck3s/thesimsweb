/**
 * The game's global random generator (srand.cpp): a 32-bit linear
 * congruential generator, seed' = seed * 0x41C64E6D + 0x3039, whose outputs
 * are bits 16..47 of the 64-bit product (seed * 0x41C64E6D + 0x3039).
 *
 * There is a single global seed (lbl_105BEBC0, 0 at startup). Renderers that
 * need reproducible noise (terrain shading jitter, grass blades) save it with
 * getSRandSeed, set their own seed, and restore it afterwards.
 */

const MUL = 0x41c64e6d;
const ADD = 0x3039;

let seed = 0;

/** Next seed of the LCG. */
function step(s: number): number {
  return (Math.imul(s, MUL) + ADD) >>> 0;
}

/** Bits 16..47 of s * MUL + ADD, computed the way the original splits it in 16-bit halves. */
function output(s: number): number {
  const hi = s >>> 16;
  const lo = s & 0xffff;
  return (Math.imul(hi, MUL) + ((lo * 0x4e6d + ADD) >>> 16) + lo * 0x41c6) >>> 0;
}

/** GetNextRandomNumber(): unsigned 32-bit output, advances the seed once. */
export function getNextRandomNumber(): number {
  const r = output(seed);
  seed = step(seed);
  return r;
}

/** SetSRandSeed(ulong). */
export function setSRandSeed(s: number): void {
  seed = s >>> 0;
}

/** GetSRandSeed(). */
export function getSRandSeed(): number {
  return seed;
}

/**
 * SGSRand(uint n): signed noise in (-n, n), biased toward 0. Takes the smaller
 * of two outputs modulo n and negates it when a third output is odd; the seed
 * advances three times.
 */
export function sgsRand(n: number): number {
  const s0 = seed;
  const s1 = step(s0);
  const s2 = step(s1);
  const m = n >>> 0;
  let r = output(s1) % m;
  const r0 = output(s0) % m;
  if (r0 < r) r = r0;
  seed = step(s2);
  if ((Math.imul(s2 >>> 16, 0x4e6d) + (((s2 & 0xffff) * 0x4e6d + ADD) >>> 16)) & 1) r = -r;
  return r;
}
