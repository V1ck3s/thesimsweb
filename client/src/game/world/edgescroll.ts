/**
 * EdgeDetectScroller (mouse half): pushing the cursor against a screen edge
 * scrolls the lot. Full screen: 5-pixel edge bands; speed -562.5 px/s
 * (lbl_105BC0EC[9]), diagonals x2 horizontally, ramping up over the first
 * 1500 ms; PreDraw moves the offsets by 0.5 + 0.001 * dt * v each frame
 * (dt capped at 100 ms).
 */

import type { HouseViewer } from "./houseviewer.js";

const EDGE = 5;
const SPEED = -562.5;
const RAMP_MS = 1500;

export class EdgeDetectScroller {
  private vx = 0;
  private vy = 0;
  private zone = 0;
  private zoneStart = 0;
  private last = 0;
  private fx = 0;
  private fy = 0;

  constructor(
    private readonly viewer: HouseViewer,
    private readonly width: number,
    private readonly height: number,
  ) {}

  /** OnMouseMove: classify the cursor into one of the 8 edge zones (0 = none). */
  onMouseMove(x: number, y: number, now = performance.now()): void {
    let zone = 0;
    let vx = 0;
    let vy = 0;
    const top = y < EDGE;
    const bottom = y >= this.height - EDGE;
    const left = x < EDGE;
    const right = x >= this.width - EDGE;
    if (top) {
      vy = -SPEED;
      if (left) [zone, vx] = [1, -2 * SPEED];
      else if (right) [zone, vx] = [3, 2 * SPEED];
      else zone = 2;
    } else if (bottom) {
      vy = SPEED;
      if (left) [zone, vx] = [5, -2 * SPEED];
      else if (right) [zone, vx] = [7, 2 * SPEED];
      else zone = 6;
    } else if (left) {
      [zone, vx] = [4, -SPEED];
    } else if (right) {
      [zone, vx] = [8, SPEED];
    }
    if (zone !== this.zone) {
      this.zone = zone;
      this.zoneStart = now;
      this.last = now;
    }
    this.vx = vx;
    this.vy = vy;
  }

  stop(): void {
    this.zone = 0;
    this.vx = this.vy = 0;
  }

  /** PreDraw: advance the view offsets. */
  pump(now: number): void {
    if (!this.zone) return;
    const dt = Math.min(100, now - this.last);
    this.last = now;
    let vx = this.vx;
    let vy = this.vy;
    const held = now - this.zoneStart;
    if (held < RAMP_MS) {
      vx = Math.trunc(vx * (held / RAMP_MS));
      vy = Math.trunc(vy * (held / RAMP_MS));
    }
    const len = Math.hypot(vx, vy);
    if (len > Math.abs(SPEED)) {
      vx = Math.trunc((vx * Math.abs(SPEED)) / len);
      vy = Math.trunc((vy * Math.abs(SPEED)) / len);
    }
    // Sub-pixel remainders are dropped by the original's int conversion;
    // keep them so slow ramps still move.
    this.fx += 0.001 * dt * vx;
    this.fy += 0.001 * dt * vy;
    const dx = Math.trunc(this.fx + 0.5 * Math.sign(this.fx));
    const dy = Math.trunc(this.fy + 0.5 * Math.sign(this.fy));
    this.fx -= dx;
    this.fy -= dy;
    if (dx || dy) this.viewer.setOffsets(this.viewer.originX + dx, this.viewer.originY + dy);
  }
}
