/**
 * cWinDeltaMeter and cAverageHistory: the arrows beside a need's bar in the
 * Live panel, showing which way the need is moving and how fast.
 *
 * cAverageHistory (AverageHistory.cpp), built (10, 5) by cWinMotive:
 *  - AddSample: keeps the last 10 samples (+4) and their running sum
 *    (+0x1c); every sample also pushes the rounded mean of the kept samples
 *    on the averages (+0x10), which drop their oldest entry with the
 *    samples;
 *  - GetAverageDelta: newest average - oldest one, rounded half away from
 *    zero, clamped to -5..5 (+0x24).
 *
 * cWinDeltaMeter (WinDeltaMeter.cpp), a child covering its cWinMotive:
 *  - five arrows (5 x 3 px triangles, DrawArrow), each with a cColorFader
 *    (+0xec + 0x34 i: start color, end color, their difference and a
 *    RampGenerator from 0 to 1, colors as (r, g, b) floats);
 *  - the constants lbl_105BC3E4 = 82, 0, 1, 255, 209, 57, 202: the resting
 *    color (0, 0, 82); green 0x00ff00 settling to (0, 202, 57), red 0xff0000
 *    settling to (209, 0, 0); ramps of 500 ms (0 ms for an instant reset);
 *  - SetTopLefts: the falling arrows start at the first point + 16 (meter
 *    width 20 - 4) and go left 4 px at a time; the rising arrows start at the
 *    second point and go right; cWinMotive gives (bar.x - 20, bar.y) and
 *    (bar.x + 61, bar.y);
 *  - SetAverageHistory: the history (+0xe8), every fader reset to the
 *    resting color at once, the meter off (+0xd4 = 0, +0xd6 = 0, +0xd5 =
 *    no history);
 *  - TriggerDeltas (cWinMotive::Pump, after a sample): d = GetAverageDelta;
 *    0 asks the meter to go out once its fades end (+0xd5), anything else
 *    turns it on (+0xd4) and becomes the shown delta (+0xd6). When the arrow
 *    count |d| or the sign changes: a sign change (or a zero on either side)
 *    fades the first |d| arrows from the resting color to green (d > 0) or
 *    red (d < 0) and puts the others at rest at once; more arrows fade the
 *    arrows from the last lit one up to |d| from their color to green / red;
 *    fewer arrows fade the ones above |d| from their color to rest;
 *  - TSPaint (while on): each arrow's color is start + ramp x difference,
 *    rounded; an arrow that reached pure red or pure green starts its 500 ms
 *    settle; once every ramp is done a meter asked to go out turns off.
 */

import { rgb } from "../../ui/syscolors.js";
import { Gfx, TSWin } from "../../ui/tswin.js";

/** cAverageHistory */
export class AverageHistory {
  /** +4: the samples; +0x10: the running averages; +0x1c: the samples' sum. */
  private readonly samples: number[] = [];
  private readonly averages: number[] = [];
  private sum = 0;

  constructor(
    /** +0x20 */
    private readonly size: number,
    /** +0x24 */
    private readonly maxDelta: number,
  ) {}

  /** cAverageHistory::AddSample */
  addSample(v: number): void {
    if (this.samples.length === this.size) {
      this.sum -= this.samples.shift()!;
      this.averages.shift();
    }
    this.samples.push(v);
    this.sum += v;
    this.averages.push(this.getAverage());
  }

  /** cAverageHistory::GetAverage */
  getAverage(): number {
    if (!this.samples.length) return 0;
    const avg = this.sum / this.samples.length;
    return avg < 0 ? Math.trunc(avg - 0.5) : Math.trunc(avg + 0.5);
  }

  /** cAverageHistory::GetAverageDelta */
  getAverageDelta(): number {
    const d = (this.averages[this.averages.length - 1] ?? 0) - (this.averages[0] ?? 0);
    const r = d >= 0 ? Math.trunc(d + 0.5) : Math.trunc(d - 0.5);
    return Math.min(this.maxDelta, Math.max(-this.maxDelta, r));
  }

  /** cAverageHistory::Reset */
  reset(): void {
    this.samples.length = 0;
    this.averages.length = 0;
    this.sum = 0;
  }
}

type Vec3 = [number, number, number];

/** cColorFader: start + RampGenerator(0 -> 1) x (end - start). */
interface ColorFader {
  start: Vec3;
  diff: Vec3;
  /** RampGenerator::SetupConstantTimeRamp(0, 1, duration, now): the end time and slope. */
  rampEnd: number;
  slope: number;
}

const ARROWS = 5;
/** lbl_105BC3E4 */
const REST: Vec3 = [0, 0, 82];
const RED_SETTLE: Vec3 = [209, 0, 0];
const GREEN_SETTLE: Vec3 = [0, 202, 57];
const FADE_MS = 500;
/** GetMeterWidth */
const METER_W = 0x14;
const RED = 0xff0000;
const GREEN = 0x00ff00;

function vec(c: number): Vec3 {
  return [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff];
}

/** RampGenerator::GetVal */
function rampVal(f: ColorFader, now: number): number {
  return now >= f.rampEnd ? 1 : 1 - (f.rampEnd - now) * f.slope;
}

/** cColorFader::GetColor: 0xRRGGBB, channels rounded. */
function faderColor(f: ColorFader, now: number): number {
  const t = rampVal(f, now);
  const ch = (i: number): number => Math.trunc(0.5 + f.start[i]! + t * f.diff[i]!) & 0xff;
  return (ch(0) << 16) | (ch(1) << 8) | ch(2);
}

function setFader(f: ColorFader, from: Vec3, to: Vec3, ms: number, now: number): void {
  f.start = from;
  f.diff = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  f.rampEnd = now + ms;
  f.slope = ms > 0 ? 1 / ms : 0;
}

export class WinDeltaMeter extends TSWin {
  /** +0xec: the five faders. */
  private readonly faders: ColorFader[] = Array.from({ length: ARROWS }, () => ({
    start: REST,
    diff: [0, 0, 0],
    rampEnd: 0,
    slope: 0,
  }));
  /** +0xd4: on; +0xd5: go out when the fades end; +0xd6: the shown delta. */
  private active = false;
  private fadeOut = false;
  private delta = 0;
  /** +0xd8 / +0xe0 */
  private left = { x: 0, y: 0 };
  private right = { x: 0, y: 0 };
  /** +0xe8 */
  private history: AverageHistory | null = null;

  /** The meter has no input handlers: clicks go to the cWinMotive under it. */
  protected override isPointTransparent(): boolean {
    return true;
  }

  /** cWinDeltaMeter::SetTopLefts */
  setTopLefts(left: { x: number; y: number }, right: { x: number; y: number }): void {
    this.left = left;
    this.right = right;
  }

  /** cWinDeltaMeter::SetAverageHistory */
  setAverageHistory(h: AverageHistory | null): void {
    this.history = h;
    this.fadeOut = h === null;
    this.active = false;
    this.delta = 0;
    const now = performance.now();
    for (const f of this.faders) setFader(f, REST, REST, 0, now);
  }

  /** cWinDeltaMeter::ResetHistory: the history reset, the meter off, every fader at rest at once. */
  resetHistory(): void {
    this.history?.reset();
    this.active = false;
    this.delta = 0;
    this.fadeOut = false;
    const now = performance.now();
    for (const f of this.faders) setFader(f, REST, REST, 0, now);
  }

  /** cWinDeltaMeter::PumpSample: a sample into the history (none: nothing), then TriggerDeltas while visible. */
  pumpSample(v: number): void {
    if (!this.history) return;
    this.history.addSample(v);
    if (this.isVisible()) this.triggerDeltas();
  }

  /** cWinDeltaMeter::TriggerDeltas */
  triggerDeltas(): void {
    if (!this.history) return;
    const d = this.history.getAverageDelta();
    const prev = this.delta;
    if (d === 0) this.fadeOut = true;
    else {
      this.active = true;
      this.delta = d;
    }
    const n = Math.abs(d);
    const nPrev = Math.abs(prev);
    const signChange = d === 0 || prev === 0 || d * prev < 0;
    if (n === nPrev && !signChange) return;
    const now = performance.now();
    const target = vec(this.delta < 0 ? RED : GREEN);
    if (signChange) {
      for (let i = 0; i < ARROWS; i++) {
        if (i < n) setFader(this.faders[i]!, REST, target, FADE_MS, now);
        else setFader(this.faders[i]!, REST, REST, 0, now);
      }
    } else if (n > nPrev) {
      for (let i = nPrev > 0 ? nPrev - 1 : 0; i < n; i++) {
        const f = this.faders[i]!;
        setFader(f, vec(faderColor(f, now)), target, FADE_MS, now);
      }
    } else {
      for (let i = nPrev - 1; i >= n; i--) {
        const f = this.faders[i]!;
        setFader(f, vec(faderColor(f, now)), REST, FADE_MS, now);
      }
    }
  }

  /** cWinDeltaMeter::DrawArrow: a 3 x 5 triangle pointing right, or left when `left`. */
  private drawArrow(g: Gfx, x: number, y: number, left: boolean, color: string): void {
    const rows = left ? [[2], [1, 2], [0, 1, 2], [1, 2], [2]] : [[0], [0, 1], [0, 1, 2], [0, 1], [0]];
    rows.forEach((cols, r) => {
      for (const c of cols) g.fill(x + c, y + r, 1, 1, color);
    });
  }

  /** cWinDeltaMeter::TSPaint */
  override tsPaint(g: Gfx): void {
    if (!this.active) return;
    const falling = this.delta < 0;
    let x = falling ? this.left.x + METER_W - 4 : this.right.x;
    const y = falling ? this.left.y : this.right.y;
    const step = falling ? -4 : 4;
    const now = performance.now();
    let done = 0;
    for (const f of this.faders) {
      const c = faderColor(f, now);
      if (c === RED) setFader(f, vec(RED), RED_SETTLE, FADE_MS, now);
      else if (c === GREEN) setFader(f, vec(GREEN), GREEN_SETTLE, FADE_MS, now);
      this.drawArrow(g, x, y, falling, rgb((c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff));
      x += step;
      if (now >= f.rampEnd) done++;
    }
    if (done === ARROWS && this.fadeOut) {
      this.active = false;
      this.delta = 0;
      this.fadeOut = false;
    }
  }
}
