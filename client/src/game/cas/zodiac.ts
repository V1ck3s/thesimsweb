/**
 * Zodiac.cpp: the star sign of a personality.
 *
 *  - lbl_105BBD74: the five person-data fields compared (outgoing, nice,
 *    playful, neat, active); lbl_105BBD78: each sign's ideal values (0..10);
 *    lbl_105BBD70 = [0.5, 100, 0.01, 1e38, 0];
 *  - ComputeZodiacSign: the sign (1..12) whose ideal is nearest (squared
 *    distance, first wins) to the person's traits divided by 100;
 *  - SetZodiacSign: writes a sign's ideal values (x 100, + 0.5) into the traits;
 *  - GetZodiacName / GetSignFromName: STR# 164 of UIText, entries 1..12 (InitZodiac).
 */

import type { GameContext } from "../context.js";

/** Person data field of the sign (PersonData +0x8c). */
export const PD_ZODIAC = 70;
const FIELDS = [6, 2, 5, 7, 3];
const IDEALS = [
  [8, 3, 3, 5, 6],
  [5, 4, 8, 5, 3],
  [7, 3, 3, 4, 8],
  [3, 6, 4, 6, 6],
  [10, 3, 4, 4, 4],
  [2, 5, 3, 9, 6],
  [8, 7, 6, 2, 2],
  [5, 3, 3, 6, 8],
  [3, 4, 7, 2, 9],
  [4, 5, 8, 7, 1],
  [4, 6, 7, 4, 4],
  [3, 7, 3, 5, 7],
];
const ZODIAC_STRINGS = 164;

export function computeZodiacSign(pd: Int16Array): number {
  const v = FIELDS.map((f) => Math.fround(0.01 * (pd[f] ?? 0)));
  let best = -1;
  let bestD = 1e38;
  IDEALS.forEach((ideal, i) => {
    let d = 0;
    for (let k = 4; k >= 0; k--) d += (v[k]! - ideal[k]!) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i + 1;
    }
  });
  return best < 1 || best > 12 ? 1 : best;
}

export function setZodiacSign(pd: Int16Array, sign: number): void {
  if (sign < 0 || sign > 12) return;
  const ideal = IDEALS[sign - 1];
  if (!ideal) return;
  FIELDS.forEach((f, k) => (pd[f] = Math.trunc(100 * ideal[k]! + 0.5)));
}

export function getZodiacName(ctx: GameContext, sign: number): string {
  return ctx.strings.get("UIText", ZODIAC_STRINGS, Math.min(12, Math.max(1, sign)) - 1);
}

export function getSignFromName(ctx: GameContext, name: string): number {
  for (let i = 1; i < 13; i++) if (ctx.strings.get("UIText", ZODIAC_STRINGS, i - 1) === name) return i;
  return 0;
}
