/**
 * EdgeDetectScroller (mouse half): pushing the cursor against a screen edge
 * scrolls the lot. Full screen: 5-pixel edge bands; speed -562.5 px/s
 * (lbl_105BC0EC[9]), diagonals x2 horizontally, ramping up over the first
 * 1500 ms; PreDraw moves the offsets by 0.5 + 0.001 * dt * v each frame
 * (dt capped at 100 ms).
 *
 * Right-button drag (OnMouseDownR / OnMouseMove / OnMouseUpR): once the
 * cursor is more than 8 pixels away from where the button went down on
 * either axis (+0x48), the anchor (cDDDSimsView::SetAnchorPoint,
 * kExploreAnchor) shows at that point and the view scrolls at 5 x (anchor -
 * cursor) pixels per second (+0x5c, lbl_105BC0EC[8]), without the edge
 * ramp or clamp; the cursor (Classify) points the way, DEADEXPL within 100
 * px/s. A right click that never dragged centers the view (CenterView).
 */

import type { HouseViewer } from "./houseviewer.js";

const EDGE = 5;
const SPEED = -562.5;
const RAMP_MS = 1500;
/** +0x48: the right-drag threshold, pixels on either axis. */
const DRAG_THRESHOLD = 8;
/** +0x5c (lbl_105BC0EC[8]): scroll velocity per pixel between the anchor and the cursor. */
const DRAG_FACTOR = 5;
/** Classify: below this speed the cursor is DEADEXPL (lbl_105BC0EC[1]). */
const DEAD_SPEED = 100;
/** Classify: sectors of +-15 degrees (lbl_105C02C8, pi lbl_105BA324, 180 lbl_105BC0EC[0]) around the axes. */
const TAN_SECTOR = Math.tan((15 * Math.fround(Math.PI)) / 180);
/** Classify: lbl_105BA648, the zero test. */
const EPSILON = 1e-6;

/** cTSCursorManager ids of the scroll cursors (cSimsApp::SetupWinCtrlMgr). */
export const enum ScrollCursor {
  Left = 0x11,
  Right = 0x12,
  Up = 0x13,
  Down = 0x14,
  UpRight = 0x15,
  UpLeft = 0x16,
  DownRight = 0x17,
  DownLeft = 0x18,
  Explore = 0x19,
  DeadExplore = 0x1a,
}

/**
 * EdgeDetectScroller::Classify: the cursor for a scroll velocity (positive x
 * moves the view's content right, i.e. scrolls left).
 */
export function classify(vx: number, vy: number): ScrollCursor {
  if (Math.hypot(vx, vy) < DEAD_SPEED) return ScrollCursor.DeadExplore;
  const h = vx >= 0 ? ScrollCursor.Left : ScrollCursor.Right;
  const v = vy >= 0 ? ScrollCursor.Up : ScrollCursor.Down;
  if (Math.abs(vx) <= EPSILON) return v;
  if (Math.abs(vy) <= EPSILON) return h;
  if (Math.abs(vy / vx) < TAN_SECTOR) return h;
  if (Math.abs(vx / vy) < TAN_SECTOR) return v;
  if (vx >= 0) return vy >= 0 ? ScrollCursor.UpLeft : ScrollCursor.DownLeft;
  return vy >= 0 ? ScrollCursor.UpRight : ScrollCursor.DownRight;
}

/** OnMouseMove: the cursor of each edge zone (+0x88: 1 top left .. 8 right). */
const EDGE_CURSORS: ReadonlyArray<ScrollCursor | null> = [
  null,
  ScrollCursor.UpLeft,
  ScrollCursor.Up,
  ScrollCursor.UpRight,
  ScrollCursor.Left,
  ScrollCursor.DownLeft,
  ScrollCursor.Down,
  ScrollCursor.DownRight,
  ScrollCursor.Right,
];

/** What the lot view does around the scroller: the anchor and the global cursor. */
export interface ScrollerHooks {
  /** cDDDSimsView::SetAnchorPoint (a point) / ReleaseAnchor (null). */
  setAnchor(p: { x: number; y: number } | null): void;
  /** cTSWinMgrW95::SetGlobalCursor(GetCursor(id)), or back to the windows' own (null). */
  setCursor(id: ScrollCursor | null): void;
}

export class EdgeDetectScroller {
  private vx = 0;
  private vy = 0;
  private zone = 0;
  private zoneStart = 0;
  private last = 0;
  private fx = 0;
  private fy = 0;

  /** +0x45: the right button went down, not dragged past the threshold yet. */
  private rightPending = false;
  /** +0x44: right-button drag scrolling. */
  private rightDrag = false;
  /** +0x4c / +0x50: where the right button went down (the anchor). */
  private downX = 0;
  private downY = 0;
  /** +4: 0 idle, 1 scrolling (StartScrolling), 2 the right press selected a person. */
  private state = 0;

  constructor(
    private readonly viewer: HouseViewer,
    private readonly width: number,
    private readonly height: number,
    private readonly hooks: ScrollerHooks | null = null,
  ) {}

  /** The right-button drag is scrolling (the anchor is up). */
  get dragging(): boolean {
    return this.rightDrag;
  }

  /**
   * EdgeDetectScroller::OnMouseDownR (after the capture): `selectPerson` is
   * the Live-mode part, true when the press selected a family member (state
   * 2: the release does nothing). Otherwise, without Shift, the press waits
   * for a drag.
   */
  onMouseDownR(x: number, y: number, shift: boolean, selectPerson: () => boolean): void {
    if (selectPerson()) {
      this.rightPending = false;
      this.rightDrag = false;
      this.state = 2;
      return;
    }
    if (shift) return;
    this.rightPending = true;
    this.downX = x;
    this.downY = y;
  }

  /**
   * EdgeDetectScroller::OnMouseUpR: ends a drag (StopScrolling); returns
   * true for a click to center on (state 0, never dragged, the left button
   * up: StopTracking, SetTrackedObject(0), CenterView).
   */
  onMouseUpR(leftDown: boolean): boolean {
    this.rightPending = false;
    if (this.rightDrag) {
      this.stopScrolling();
      this.rightDrag = false;
      return false;
    }
    if (this.state === 2) {
      this.state = 0;
      return false;
    }
    return this.state === 0 && !leftDown;
  }

  /** OnMouseMove: the right drag (threshold, velocity, cursor), else the edge zones. */
  onMouseMove(x: number, y: number, now = performance.now()): void {
    if (this.rightPending && (Math.abs(x - this.downX) > DRAG_THRESHOLD || Math.abs(y - this.downY) > DRAG_THRESHOLD)) {
      this.rightPending = false;
      this.rightDrag = true;
      this.hooks?.setAnchor({ x: this.downX, y: this.downY });
      this.hooks?.setCursor(ScrollCursor.Explore);
    }
    if (this.rightDrag) {
      this.vx = Math.trunc(DRAG_FACTOR * (this.downX - x));
      this.vy = Math.trunc(DRAG_FACTOR * (this.downY - y));
      this.hooks?.setCursor(classify(this.vx, this.vy));
      if (this.state === 0) {
        // StartScrolling (cWinPeople::StopTracking and Animator::SetTrackedObject(0) are not ported).
        this.state = 1;
        this.last = now;
        this.fx = this.fy = 0;
      }
      return;
    }
    this.edgeMove(x, y, now);
  }

  /** EdgeDetectScroller::StopScrolling (the right-drag part: anchor, cursor). */
  private stopScrolling(): void {
    if (this.state !== 1) return;
    this.state = 0;
    this.vx = this.vy = 0;
    this.hooks?.setAnchor(null);
    this.hooks?.setCursor(null);
  }

  /** The edge half of OnMouseMove: classify the cursor into one of the 8 edge zones (0 = none). */
  private edgeMove(x: number, y: number, now: number): void {
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
      // OnMouseMove: entering a zone sets its arrow (SetGlobalCursor unforced), leaving it clears it.
      this.hooks?.setCursor(zone ? (EDGE_CURSORS[zone] ?? null) : null);
    }
    this.vx = vx;
    this.vy = vy;
  }

  stop(): void {
    // A right drag holds the capture: leaving the view does not end it.
    if (this.rightDrag) return;
    if (this.zone) this.hooks?.setCursor(null);
    this.zone = 0;
    this.vx = this.vy = 0;
  }

  /** PreDraw: advance the view offsets. */
  pump(now: number): void {
    if (this.rightDrag) {
      if (this.state === 1) this.advance(now, this.vx, this.vy);
      return;
    }
    if (!this.zone) return;
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
    this.advance(now, vx, vy);
  }

  /** PreDraw's move: 0.5 + 0.001 x dt x v pixels (lbl_105BC0EC[4], [3]), dt capped at 100 ms. */
  private advance(now: number, vx: number, vy: number): void {
    const dt = Math.min(100, now - this.last);
    this.last = now;
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
