/**
 * Slider (cTSWinSlider).
 *
 * From the decompiled class:
 *  - direction (+0xcc): 1 horizontal, 2 vertical (default); range 0..32;
 *  - the image holds 4 frames (side by side when horizontal, stacked when
 *    vertical): start cap, track (tiled), end cap, thumb (TSPaint). SetImage
 *    sizes the window's thickness to the image;
 *  - the track runs from `margin` to length - thumb - margin; a vertical
 *    slider grows upward (CalculateAllMetrics). The thumb is centered across
 *    the track (CalculateThumbPosition);
 *  - dragging maps the cursor (thumb-centered) linearly over (max - min + 1)
 *    steps (ConvertCursorPositionToValue);
 *  - every value change notifies the owner with command 0xc (SetValue).
 * Without an image it paints flat: fill color, a line and an inverted thumb.
 */

import { Gfx, TSWin, type Rect } from "./tswin.js";
import { SYS_SLIDER_H, SYS_SLIDER_V, type TSWinCtrlMgr } from "./ctrlmgr.js";
import { winMgr } from "./winmgr.js";

export const SLIDER_HORIZONTAL = 1;
export const SLIDER_VERTICAL = 2;

/** Command sent to the owner when the value changes (cTSWinSlider::SetValue). */
export const CMD_SLIDER_CHANGED = 0xc;

export class TSWinSlider extends TSWin {
  direction = SLIDER_VERTICAL;
  protected minValue = 0;
  protected maxValue = 0x20;
  protected value = 0;
  protected trackStart = 0;
  protected thumbPos = 0;
  protected trackEnd = 0;
  /** +0xe8: space kept at both ends of the track. */
  margin = 0;
  protected thumb: Rect = { left: 0, top: 0, right: 0, bottom: 0 };
  protected image: ImageBitmap | null = null;
  /** Source rectangle of frame 0 in the image. */
  protected src: Rect = { left: 0, top: 0, right: 0, bottom: 0 };
  enabled = true;
  fillColor = "#000000";
  onChange: ((value: number, src: TSWinSlider) => void) | null = null;
  private inSetValue = false;

  constructor() {
    super();
    this.setArea(0, 0, 0x20, 0x60);
  }

  /** cTSWinCtrlMgr::DefaultSliderHorizontal / DefaultSliderVertical */
  static defaultSlider(mgr: TSWinCtrlMgr, id: number, direction: number): TSWinSlider {
    const s = new TSWinSlider();
    s.id = id;
    s.setDirection(direction);
    s.setImage(mgr.systemBMP(direction === SLIDER_HORIZONTAL ? SYS_SLIDER_H : SYS_SLIDER_V));
    return s;
  }

  override async init(): Promise<boolean> {
    this.calculateAllMetrics();
    return true;
  }

  getValue(): number {
    return this.value;
  }
  getMinValue(): number {
    return this.minValue;
  }
  getMaxValue(): number {
    return this.maxValue;
  }

  setDirection(d: number): void {
    this.direction = d;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  getThumbWidth(): number {
    return this.src.right - this.src.left;
  }

  getThumbHeight(): number {
    return this.src.bottom - this.src.top;
  }

  override setArea(left: number, top: number, right: number, bottom: number): void {
    super.setArea(left, top, right, bottom);
    this.calculateAllMetrics();
  }

  /** cTSWinSlider::SetImage: 4 frames along the slider's direction. */
  setImage(img: ImageBitmap): boolean {
    this.image = img;
    if (this.direction === SLIDER_VERTICAL) {
      this.src = { left: 0, top: 0, right: img.width, bottom: img.height >> 2 };
      this.setArea(this.area.left, this.area.top, this.area.left + img.width, this.area.bottom);
    } else {
      this.src = { left: 0, top: 0, right: img.width >> 2, bottom: img.height };
      this.setArea(this.area.left, this.area.top, this.area.right, this.area.top + img.height);
    }
    return true;
  }

  setMaximumValue(v: number): void {
    this.maxValue = v;
    if (v < this.value) this.value = v;
    this.calculateAllMetrics();
  }

  setMinimumValue(v: number): void {
    this.minValue = v;
    if (this.value < v) this.value = v;
    this.calculateAllMetrics();
  }

  setValue(v: number): void {
    if (this.inSetValue || v === this.value) return;
    this.inSetValue = true;
    this.value = Math.max(this.minValue, Math.min(this.maxValue, v));
    this.calculateThumbPosition();
    this.onChange?.(this.value, this);
    this.parent?.tsOnCommand(CMD_SLIDER_CHANGED, this);
    this.inSetValue = false;
  }

  protected calculateThumbPosition(): void {
    const range = this.maxValue - this.minValue;
    this.thumbPos =
      range === 0
        ? this.trackStart
        : Math.trunc(((this.trackEnd - this.trackStart) * (this.value - this.minValue)) / range) + this.trackStart;
    const tw = this.getThumbWidth();
    const th = this.getThumbHeight();
    if (this.direction === SLIDER_HORIZONTAL) {
      const top = Math.trunc(this.getH() / 2) - Math.trunc(th / 2);
      this.thumb = { left: this.thumbPos, top, right: this.thumbPos + tw, bottom: top + th };
    } else {
      const left = Math.trunc(this.getW() / 2) - Math.trunc(tw / 2);
      this.thumb = { left, top: this.thumbPos, right: left + tw, bottom: this.thumbPos + th };
    }
  }

  protected calculateAllMetrics(): void {
    if (this.direction === SLIDER_HORIZONTAL) {
      this.trackStart = this.margin;
      this.trackEnd = this.getW() - this.getThumbWidth() - this.margin;
    } else {
      this.trackStart = this.getH() - this.getThumbHeight() - this.margin;
      this.trackEnd = this.margin;
    }
    this.calculateThumbPosition();
  }

  /** cTSWinSlider::ConvertCursorPositionToValue */
  protected convertCursorPositionToValue(x: number, y: number): number {
    let p: number;
    if (this.direction === SLIDER_HORIZONTAL) {
      p = x - Math.trunc(this.getThumbWidth() / 2);
      p = Math.min(Math.max(p, this.margin), this.getW() - this.margin);
    } else {
      p = y - Math.trunc(this.getThumbHeight() / 2);
      p = Math.min(Math.max(p, this.margin), this.getH() - this.margin);
    }
    const steps = this.maxValue - this.minValue + 1;
    return Math.trunc((steps * (p - this.trackStart)) / (this.trackEnd - this.trackStart)) + this.minValue;
  }

  override tsOnMouseDownL(x: number, y: number): boolean {
    if (!this.enabled) return true;
    winMgr.setCapture(this);
    this.setValue(this.convertCursorPositionToValue(x, y));
    return true;
  }

  override tsOnMouseMove(x: number, y: number): boolean {
    if (!this.enabled) return true;
    if (winMgr.getCapture() !== this) return false;
    this.setValue(this.convertCursorPositionToValue(x, y));
    return true;
  }

  override tsOnMouseUpL(x: number, y: number): boolean {
    if (!this.enabled) return true;
    if (winMgr.getCapture() !== this) return false;
    winMgr.releaseCapture(this);
    this.setValue(this.convertCursorPositionToValue(x, y));
    return true;
  }

  override tsPaint(g: Gfx): void {
    const img = this.image;
    const w = this.getW();
    const h = this.getH();
    if (!img) {
      const inv = invertColor(this.fillColor);
      g.fill(0, 0, w, h, this.fillColor);
      g.ctx.fillStyle = inv;
      if (this.direction === SLIDER_HORIZONTAL) {
        g.ctx.fillRect(g.ox + this.margin, g.oy + (h >> 1), w - 2 * this.margin, 1);
      } else {
        g.ctx.fillRect(g.ox + (w >> 1), g.oy + this.margin, 1, h - 2 * this.margin - 1);
      }
      const t = this.thumb;
      g.fill(t.left, t.top, t.right - t.left, t.bottom - t.top, inv);
      return;
    }
    const fw = this.src.right - this.src.left;
    const fh = this.src.bottom - this.src.top;
    const sx = this.src.left;
    const sy = this.src.top;
    g.blitPart(img, sx, sy, fw, fh, 0, 0);
    if (this.direction === SLIDER_VERTICAL) {
      for (let y = fh; y < h - fh; y += fh) g.blitPart(img, sx, sy + fh, fw, Math.min(fh, h - fh - y), 0, y);
      g.blitPart(img, sx, sy + 2 * fh, fw, fh, 0, h - fh);
      g.blitPart(img, sx, sy + 3 * fh, fw, fh, this.thumb.left, this.thumb.top);
    } else {
      for (let x = fw; x < w - fw; x += fw) g.blitPart(img, sx + fw, sy, Math.min(fw, w - fw - x), fh, x, 0);
      g.blitPart(img, sx + 2 * fw, sy, fw, fh, w - fw, 0);
      g.blitPart(img, sx + 3 * fw, sy, fw, fh, this.thumb.left, this.thumb.top);
    }
  }
}

/** The flat look draws with the bitwise complement of the fill color. */
function invertColor(color: string): string {
  const c = new OffscreenCanvas(1, 1).getContext("2d")!;
  c.fillStyle = color;
  c.fillRect(0, 0, 1, 1);
  const [r, g, b] = c.getImageData(0, 0, 1, 1).data;
  return `rgb(${255 - r!},${255 - g!},${255 - b!})`;
}
