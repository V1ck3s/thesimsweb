/**
 * The person motive engine: Motives::Sim (the periodic decay), the motive
 * increments of Set Motive Change (cXPerson +0xa80, applied every tick by
 * cXPerson::Simulate), cXPerson::CalcHappy (mood) and PiecewiseFn (the
 * curves of Global.iff STR# 0x1f5..0x1f8).
 *
 * Motive indexes (Behavior.iff STR# 134): 3 mood, 5 energy, 6 comfort,
 * 7 hunger, 8 hygiene, 9 bladder, 11 sleep state (< 0 asleep), 13 room,
 * 14 social, 15 fun. Motives::Sim also copies motives 0..15 into 16..31
 * (the previous values; 23 is the last hunger).
 *
 * MotiveConstantsClient::UpdateConstants derives the decay rates from
 * named float constants (FloatConstants, defaults at lbl_1059A174), three
 * variants: 0 normal, 1 / 2 selected by person data 0x41 bits 2 / 4.
 * The values come from FCNS 1 / 5 / 6 of Global.iff (setMotiveConstants,
 * called by SimModule.initPeople), defaults otherwise.
 */

export const MOTIVE = {
  mood: 3,
  energy: 5,
  comfort: 6,
  hunger: 7,
  hygiene: 8,
  bladder: 9,
  sleepState: 11,
  room: 13,
  social: 14,
  fun: 15,
} as const;

const MOTIVE_MAX = 100;
const MOTIVE_MIN = -100;

import { fc, type FloatConstants } from "./floatconstants.js";

interface MotiveConstants {
  energyAsleep: number;
  energyAwake: number;
  wakeHour: number;
  wakeEnd: number;
  energyDrift: number;
  hungerToBladder: number;
  comfortSlope: number;
  comfortBase: number;
  hungerRatio: number;
  socialBase: number;
  socialMult: number;
  funAwake: number;
  funAsleepMult: number;
  hygAwake: number;
  hygAsleep: number;
  bladderAwake: number;
  bladderAsleep: number;
}

/** MotiveConstantsClient::UpdateConstants for one variant (defaults: lbl_1059A174). */
export function motiveConstants(variant: number, c: FloatConstants): MotiveConstants {
  const span = fc(c, "energy span", 180);
  const wakeHours = Math.trunc(fc(c, "wake hours", 16));
  const wakeHour = Math.trunc(fc(c, "wake hour", 7));
  const sleepHours = 24 - wakeHours;
  const active = fc(c, "comfort decrement active", 0.4);
  const lazy = fc(c, "comfort decrement lazy", 0.6);
  const energyAsleep = variant === 0 ? span / sleepHours / 30 : wakeHours / 30;
  const energyAwake = variant === 0 ? -(span / wakeHours) / 30 : -span / 30;
  return {
    energyAsleep,
    energyAwake,
    wakeHour,
    wakeEnd: wakeHour + wakeHours,
    energyDrift: fc(c, "energy drift", 0.01),
    hungerToBladder: fc(c, "hunger to bladder multiplier", 0.25),
    comfortSlope: (active - lazy) / 1000,
    comfortBase: lazy,
    hungerRatio: fc(c, "hunger decrement ratio", 0.0014285714),
    socialBase: fc(c, "social decrement base", 0.1),
    socialMult: fc(c, "social decrement multiplier", 0.0004),
    funAwake: fc(c, "ent decrement, awake", 0.25),
    funAsleepMult: fc(c, "ent multiplier, asleep", 0.5),
    hygAwake: fc(c, "hyg decrement, awake", 0.15),
    hygAsleep: fc(c, "hyg decrement, asleep", 0.1),
    bladderAwake: fc(c, "bladder decrement, awake", 0.3),
    bladderAsleep: fc(c, "bladder decrement, asleep", 0.2),
  };
}

/** The three variants (FCNS 1, 5, 6 of Global.iff; defaults until setMotiveConstants). */
let CONSTANTS: readonly MotiveConstants[] = [0, 1, 2].map((v) => motiveConstants(v, new Map()));

export function setMotiveConstants(variants: readonly FloatConstants[]): void {
  CONSTANTS = variants.map((c, v) => motiveConstants(v, c));
}

/** PiecewiseFn: up to 8 points sorted by x, linear between them, flat outside. */
export class PiecewiseFn {
  readonly xs: number[] = [];
  readonly ys: number[] = [];

  /** PiecewiseFn::AddPointsFromText: "(x;y)" pairs (integers); a repeated x is ignored. */
  static fromText(text: string, maxPoints = 8): PiecewiseFn {
    const f = new PiecewiseFn();
    for (const m of text.matchAll(/\(\s*(-?\d+)\s*;\s*(-?\d+)\s*\)/g)) {
      if (f.xs.length >= maxPoints) break;
      f.addPoint(Number(m[1]), Number(m[2]));
    }
    return f;
  }

  addPoint(x: number, y: number): void {
    let i = 0;
    while (i < this.xs.length && this.xs[i]! < x) i++;
    if (this.xs[i] === x) return;
    this.xs.splice(i, 0, x);
    this.ys.splice(i, 0, y);
  }

  get count(): number {
    return this.xs.length;
  }

  eval(x: number): number {
    const n = this.xs.length;
    if (n === 0) return 0;
    let i = n - 1;
    while (i >= 0 && x - this.xs[i]! <= 0) i--;
    if (i === n - 1) return this.ys[n - 1]!;
    if (i === -1) return this.ys[0]!;
    const t = (x - this.xs[i]!) / (this.xs[i + 1]! - this.xs[i]!);
    return t * (this.ys[i + 1]! - this.ys[i]!) + this.ys[i]!;
  }
}

/** A curve of a MotiveCurveSet with the motive it reads (lbl_10602320 for the happiness curves). */
export interface MotiveCurve {
  motive: number;
  fn: PiecewiseFn;
}

/** The happiness weight curves (STR# 0x1f6 adult / 0x1f8 child) read motives 7, 6, 8, 9, 15, 13, 14. */
export const HAPPY_CURVE_MOTIVES = [7, 6, 8, 9, 15, 13, 14] as const;

export function curvesFromStrings(strings: readonly string[], motives: readonly number[], maxPoints = 8): MotiveCurve[] {
  return motives.map((motive, i) => ({ motive, fn: PiecewiseFn.fromText(strings[i] ?? "", maxPoints) }));
}

/** cXPerson::CalcHappy: mood = sum(motive * weight(motive)) / sum(weights). */
export function calcHappy(m: Float32Array, curves: readonly MotiveCurve[]): void {
  let sum = 0;
  let weights = 0;
  for (const c of curves) {
    const v = m[c.motive]!;
    const w = c.fn.count === 0 ? 0 : c.fn.eval(v);
    sum += v * w;
    weights += w;
  }
  if (weights !== 0) m[MOTIVE.mood] = sum / weights;
}

/**
 * Motives::Sim: one decay step (cXPerson::Simulate runs it every 60 ticks
 * unless "motives static" (person data 0x1d) or the person is hidden).
 * `m` has 32 floats (current + previous), `pd` the person data.
 */
export function motivesSim(m: Float32Array, pd: Int16Array, hour: number): void {
  const flags = pd[0x41]!;
  const v = flags & 2 ? 1 : flags & 4 ? 2 : 0;
  const c = CONSTANTS[v]!;
  const asleep = m[MOTIVE.sleepState]! < 0;
  if (asleep) {
    m[MOTIVE.energy] = m[MOTIVE.energy]! + c.energyAsleep;
    if (c.wakeHour < hour && hour < c.wakeEnd) m[MOTIVE.energy] = m[MOTIVE.energy]! - c.energyDrift;
  } else {
    m[MOTIVE.energy] = m[MOTIVE.energy]! + c.energyAwake;
  }
  const ate = m[MOTIVE.hunger]! - m[16 + MOTIVE.hunger]!;
  if (ate > 0) m[MOTIVE.bladder] = m[MOTIVE.bladder]! - ate * c.hungerToBladder;
  m[MOTIVE.comfort] = m[MOTIVE.comfort]! - (c.comfortSlope * pd[3]! + c.comfortBase);
  m[MOTIVE.hunger] = m[MOTIVE.hunger]! - (MOTIVE_MAX + m[MOTIVE.hunger]!) * c.hungerRatio;
  if (!asleep) m[MOTIVE.social] = m[MOTIVE.social]! - (c.socialMult * pd[6]! + c.socialBase);
  if (asleep) {
    m[MOTIVE.fun] = m[MOTIVE.fun]! * c.funAsleepMult;
    m[MOTIVE.hygiene] = m[MOTIVE.hygiene]! - c.hygAsleep;
    m[MOTIVE.bladder] = m[MOTIVE.bladder]! - c.bladderAsleep;
  } else {
    m[MOTIVE.fun] = m[MOTIVE.fun]! - c.funAwake;
    m[MOTIVE.hygiene] = m[MOTIVE.hygiene]! - c.hygAwake;
    m[MOTIVE.bladder] = m[MOTIVE.bladder]! - c.bladderAwake;
  }
  for (let i = 0; i < 16; i++) {
    let x = m[i]!;
    if (x > MOTIVE_MAX) x = MOTIVE_MAX;
    if (x < MOTIVE_MIN) x = MOTIVE_MIN;
    m[i] = x;
    m[16 + i] = x;
  }
}

/** A Set Motive Change entry (MotiveInc, 12 bytes): motive, delta per tick, stop value. */
export interface MotiveInc {
  motive: number;
  delta: number;
  limit: number;
}

/** cXPerson::Simulate's motive increment pass. */
export function applyMotiveIncs(m: Float32Array, incs: readonly MotiveInc[]): void {
  for (const inc of incs) {
    const cur = m[inc.motive]!;
    if (inc.delta >= 0) {
      if (cur < inc.limit) m[inc.motive] = Math.min(cur + inc.delta, inc.limit);
    } else if (cur > inc.limit) {
      m[inc.motive] = Math.max(cur + inc.delta, inc.limit);
    }
  }
}
