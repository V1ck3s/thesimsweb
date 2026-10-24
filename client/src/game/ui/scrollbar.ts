/**
 * Scroll bar (cTSWinScrollbar), a cTSWinSlider with arrow buttons.
 *
 * From the decompiled class:
 *  - the image (kSMSystemScrollbar) holds 12 frames side by side: 0..5 for a
 *    horizontal bar, 6..11 for a vertical one. Within a set: 0 previous arrow,
 *    1 previous arrow pressed, 2 thumb, 3 track (tiled), 4 next arrow,
 *    5 next arrow pressed (SetImage, scrollbar_paint_bmp);
 *  - the arrows are thumb-sized; the track runs between them
 *    (CalculateAllMetrics); a vertical bar grows downward;
 *  - pressing an arrow moves one line, pressing the track one page
 *    (SetPageSize); holding repeats every 200 ms while the cursor stays on the
 *    pressed part (TSPaint). The thumb is dragged with
 *    ConvertCursorPositionToValue (nearest step).
 */

import { SYS_SCROLLBAR, type TSWinCtrlMgr } from "./ctrlmgr.js";
import { SLIDER_HORIZONTAL, SLIDER_VERTICAL, TSWinSlider } from "./slider.js";
import type { Gfx } from "./tswin.js";
import { winMgr } from "./winmgr.js";

/** cTSWinScrollbar::ScrollHitTestResult */
const HIT_NONE = 0;
const HIT_PREV = 1;
const HIT_NEXT = 2;
const HIT_PAGE_PREV = 3;
const HIT_PAGE_NEXT = 4;
const HIT_THUMB = 5;

const REPEAT_MS = 200;

export class TSWinScrollbar extends TSWinSlider {
  /** +0x120: SetPageSize */
  pageSize = 0;
  private pressed = HIT_NONE;
  private pressedInside = true;
  private repeatStart = 0;

  /** cTSWinCtrlMgr::DefaultScrollbarHorizontal / DefaultScrollbarVertical */
  static defaultScrollbar(mgr: TSWinCtrlMgr, id: number, direction: number): TSWinScrollbar {
    const s = new TSWinScrollbar();
    s.id = id;
    s.setDirection(direction);
    s.setImage(mgr.systemBMP(SYS_SCROLLBAR));
    return s;
  }

  setPageSize(n: number): void {
    this.pageSize = n;
  }

  override setImage(img: ImageBitmap): boolean {
    this.image = img;
    const fw = Math.trunc(img.width / 12);
    this.src = { left: 0, top: 0, right: fw, bottom: img.height };
    if (this.direction === SLIDER_VERTICAL) {
      this.setArea(this.area.left, this.area.top, this.area.left + fw, this.area.bottom);
      this.src.left += fw * 6;
      this.src.right += fw * 6;
    } else {
      this.setArea(this.area.left, this.area.top, this.area.right, this.area.top + img.height);
    }
    return true;
  }

  getPrevNextButtonWidth(): number {
    return this.getThumbWidth();
  }

  getPrevNextButtonHeight(): number {
    return this.getThumbHeight();
  }

  protected override calculateAllMetrics(): void {
    if (this.direction === SLIDER_HORIZONTAL) {
      this.trackStart = this.getPrevNextButtonWidth();
      this.trackEnd = this.getW() - this.getPrevNextButtonWidth() - this.getThumbWidth();
    } else {
      this.trackStart = this.getPrevNextButtonHeight();
      this.trackEnd = this.getH() - this.getPrevNextButtonHeight() - this.getThumbHeight();
    }
    this.calculateThumbPosition();
  }

  /** cTSWinScrollbar::ConvertCursorPositionToValue: nearest step to the thumb center. */
  protected override convertCursorPositionToValue(x: number, y: number): number {
    if (this.maxValue === this.minValue) return 0;
    const pos =
      this.direction === SLIDER_HORIZONTAL
        ? x - this.trackStart - Math.trunc(this.getThumbWidth() / 2)
        : y - this.trackStart - Math.trunc(this.getThumbHeight() / 2);
    const step = (this.trackEnd - this.trackStart) / (this.maxValue - this.minValue);
    for (let v = this.minValue; v <= this.maxValue; v++) {
      if (pos < step * (0.5 + (v - this.minValue))) return v;
    }
    return this.maxValue;
  }

  moveLinePrevious(): void {
    if (this.minValue < this.value) this.setValue(Math.max(this.minValue, this.value - 1));
  }

  moveLineNext(): void {
    if (this.value < this.maxValue) this.setValue(Math.min(this.maxValue, this.value + 1));
  }

  movePagePrevious(): void {
    if (this.minValue < this.value) this.setValue(Math.max(this.minValue, this.value - this.pageSize));
  }

  movePageNext(): void {
    if (this.value < this.maxValue) this.setValue(Math.min(this.maxValue, this.value + this.pageSize));
  }

  /** cTSWinScrollbar::DoCursorPositionHitTest */
  private hitTest(x: number, y: number): number {
    if (!this.isPointInWindowWindowCoordinates(x, y)) return HIT_NONE;
    const horiz = this.direction === SLIDER_HORIZONTAL;
    const p = horiz ? x : y;
    const btn = horiz ? this.getPrevNextButtonWidth() : this.getPrevNextButtonHeight();
    const thumb = horiz ? this.getThumbWidth() : this.getThumbHeight();
    const len = horiz ? this.getW() : this.getH();
    if (p < btn) return HIT_PREV;
    if (p < this.thumbPos) return HIT_PAGE_PREV;
    if (p < this.thumbPos + thumb) return HIT_THUMB;
    if (p < len - btn) return HIT_PAGE_NEXT;
    return HIT_NEXT;
  }

  private doPart(part: number): void {
    if (part === HIT_PREV) this.moveLinePrevious();
    else if (part === HIT_NEXT) this.moveLineNext();
    else if (part === HIT_PAGE_PREV) this.movePagePrevious();
    else if (part === HIT_PAGE_NEXT) this.movePageNext();
  }

  override tsOnMouseDownL(x: number, y: number): boolean {
    const part = this.hitTest(x, y);
    if (part === HIT_NONE) return true;
    this.pressed = part;
    this.pressedInside = true;
    winMgr.setCapture(this);
    this.repeatStart = performance.now();
    this.doPart(part);
    return true;
  }

  override tsOnMouseMove(x: number, y: number): boolean {
    if (winMgr.getCapture() !== this) return true;
    if (this.pressed === HIT_THUMB) this.setValue(this.convertCursorPositionToValue(x, y));
    else this.pressedInside = this.hitTest(x, y) === this.pressed;
    return true;
  }

  override tsOnMouseUpL(x: number, y: number): boolean {
    if (winMgr.getCapture() !== this) return true;
    winMgr.releaseCapture(this);
    if (this.pressed === HIT_THUMB) this.setValue(this.convertCursorPositionToValue(x, y));
    this.pressed = HIT_NONE;
    return true;
  }

  /** The auto-repeat of TSPaint. */
  override pump(nowMs: number): void {
    super.pump(nowMs);
    if (winMgr.getCapture() !== this || !this.pressedInside) return;
    if (this.pressed < HIT_PREV || this.pressed > HIT_PAGE_NEXT) return;
    if (nowMs - this.repeatStart > REPEAT_MS) {
      this.doPart(this.pressed);
      this.repeatStart = nowMs;
    }
  }

  /** cTSWinScrollbar::scrollbar_paint_bmp */
  override tsPaint(g: Gfx): void {
    const img = this.image;
    if (!img) {
      super.tsPaint(g);
      return;
    }
    const fw = this.src.right - this.src.left;
    const fh = this.src.bottom - this.src.top;
    const sx = this.src.left;
    const prev = this.pressed === HIT_PREV ? 1 : 0;
    const next = this.pressed === HIT_NEXT ? 5 : 4;
    const w = this.getW();
    const h = this.getH();
    g.blitPart(img, sx + prev * fw, 0, fw, fh, 0, 0);
    if (this.direction === SLIDER_HORIZONTAL) {
      for (let x = fw; x < w - fw; x += fw) g.blitPart(img, sx + 3 * fw, 0, Math.min(fw, w - fw - x), fh, x, 0);
      g.blitPart(img, sx + next * fw, 0, fw, fh, w - fw, 0);
      g.blitPart(img, sx + 2 * fw, 0, fw, fh, this.thumb.left, 0);
    } else {
      for (let y = fh; y < h - fh; y += fh) g.blitPart(img, sx + 3 * fw, 0, fw, Math.min(fh, h - fh - y), 0, y);
      g.blitPart(img, sx + next * fw, 0, fw, fh, 0, h - fh);
      g.blitPart(img, sx + 2 * fw, 0, fw, fh, 0, this.thumb.top);
    }
  }
}
