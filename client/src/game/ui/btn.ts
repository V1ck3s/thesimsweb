/**
 * Bitmap button (cTSWinBtn).
 *
 * The image holds `cols` frames side by side (and optionally `rows` variants
 * stacked). The frame column comes from cTSWinBtn::CalcRowCol:
 *   1 col : always 0
 *   2 cols: 1 when enabled and (pressed or hovered), else 0
 *   4 cols: 0 normal, 1 pressed/selected, 2 hovered, 3 disabled
 *   6 cols: like 4, plus 3 = selected+hovered, 4/5 = disabled (unselected/selected)
 *   3/5   : bit 0 = pressed, bit 1 = hovered; disabled = 4/5 when cols > 4
 *
 * Modes (cTSWinBtn+0xf0): PUSH is momentary, TOGGLE flips on release,
 * TOGGLE_ON_DOWN flips on press. The command fires on release unless
 * `sendOnDown`, and only if the cursor is still over the button.
 */

import type { FfnFont } from "../res/ffn.js";
import { Gfx, TSWin } from "./tswin.js";
import { winMgr } from "./winmgr.js";

export const BTN_PUSH = 0;
export const BTN_TOGGLE = 1;
export const BTN_TOGGLE_ON_DOWN = 2;

export class TSWinBtn extends TSWin {
  image: ImageBitmap | null = null;
  cols = 1;
  rows = 1;
  row = 0;
  /** 0 = up, 1 = down/selected. */
  state = 0;
  enabled = true;
  entered = false;
  mode = BTN_PUSH;
  sendOnDown = false;
  caption = "";
  font: FfnFont | null = null;
  captionColor = "#ffffff";
  onClick: ((btn: TSWinBtn) => void) | null = null;
  private changedOnDown = false;

  constructor(id = 0, image: ImageBitmap | null = null, cols = 1, rows = 1) {
    super();
    this.id = id;
    if (image) this.setImage(image, cols, rows);
  }

  /** cTSWinBtn::SetImage: the window takes one frame's size. */
  setImage(image: ImageBitmap, cols: number, rows = 1): void {
    this.image = image;
    this.hitImage = null;
    this.cols = cols;
    this.rows = rows;
    const w = Math.floor(image.width / cols);
    const h = Math.floor(image.height / rows);
    this.setArea(this.area.left, this.area.top, this.area.left + w, this.area.top + h);
  }

  setState(s: number): void {
    this.state = s;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  frameColumn(): number {
    const s = this.state !== 0;
    const e = this.entered;
    switch (this.cols) {
      case 0:
      case 1:
        return 0;
      case 2:
        return this.enabled && (s || e) ? 1 : 0;
      case 4:
      case 6:
        if (!this.enabled) return this.cols === 4 ? 3 : s ? 5 : 4;
        if (!s) return e ? 2 : 0;
        return this.cols === 6 && e ? 3 : 1;
      default:
        if (!this.enabled) return this.cols > 4 ? (s ? 5 : 4) : 0;
        return (s ? 1 : 0) | (e ? 2 : 0);
    }
  }

  override tsPaint(g: Gfx): void {
    if (this.image) {
      const w = this.getW();
      const h = this.getH();
      g.blitPart(this.image, this.frameColumn() * w, this.row * h, w, h, 0, 0);
    }
    if (this.caption && this.font) {
      const tw = this.font.stringWidth(this.caption);
      const x = (this.getW() - tw) >> 1;
      const y = (this.getH() - this.font.height) >> 1;
      this.font.drawText(g.ctx, this.caption, g.ox + x, g.oy + y, this.captionColor);
    }
  }

  protected override isPointTransparent(x: number, y: number): boolean {
    if (!this.image) return false;
    // Test against the current frame of the button image.
    if (!this.hitImage) this.hitImage = this.image;
    return super.isPointTransparent(x + this.frameColumn() * this.getW(), y + this.row * this.getH());
  }

  override tsOnMouseEnter(): void {
    this.entered = true;
  }

  override tsOnMouseExit(): void {
    this.entered = false;
  }

  override tsOnMouseMove(x: number, y: number): boolean {
    if (winMgr.getCapture() === this) this.entered = this.isPointInWindowWindowCoordinates(x, y);
    return true;
  }

  override tsOnMouseDownL(): boolean {
    if (!this.enabled) return true;
    winMgr.setCapture(this);
    const before = this.state;
    if (this.mode === BTN_TOGGLE_ON_DOWN) this.state = this.state ? 0 : 1;
    else if (this.mode === BTN_PUSH || this.mode === BTN_TOGGLE) this.state = 1;
    this.changedOnDown = before !== this.state;
    if (this.sendOnDown) this.fire();
    return true;
  }

  override tsOnMouseUpL(x: number, y: number): boolean {
    if (winMgr.getCapture() !== this) return true;
    winMgr.releaseCapture(this);
    this.entered = this.isPointInWindowWindowCoordinates(x, y);
    if (this.mode === BTN_PUSH) {
      this.state = 0;
    } else if (this.mode === BTN_TOGGLE) {
      // Pressing showed the "down" frame; releasing outside cancels.
      if (!this.entered && this.changedOnDown) this.state = 0;
      else if (this.entered && !this.changedOnDown) this.state = 0;
    }
    if (!this.sendOnDown && this.entered) this.fire();
    return true;
  }

  private fire(): void {
    this.onClick?.(this);
    this.parent?.tsOnCommand(this.id, this);
  }
}
