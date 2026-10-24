/**
 * Check box (cTSWinCheck): a toggle button followed by its caption.
 *
 * From the decompiled class:
 *  - Init creates a cTSWinBtn with the 6-frame image (kSMSystemCheck for
 *    cTSWinCtrlMgr::DefaultCheckBox) that toggles on press;
 *  - the window is the button's width + caption width + 6 wide and as high as
 *    the taller of the button and the font;
 *  - the caption is drawn at x = button width + 6, vertically centered, in the
 *    font's color (TSPaint);
 *  - a click notifies the owner with command 0x1c (TSOnCommand).
 */

import type { FfnFont } from "../res/ffn.js";
import { BTN_TOGGLE_ON_DOWN, TSWinBtn } from "./btn.js";
import { SYS_CHECK, type TSWinCtrlMgr } from "./ctrlmgr.js";
import { UI_FONT_COLOR } from "./syscolors.js";
import { Gfx, TSWin } from "./tswin.js";

export const CMD_CHECK_CHANGED = 0x1c;

const CAPTION_GAP = 6;

export class TSWinCheck extends TSWin {
  caption = "";
  font: FfnFont | null = null;
  textColor = UI_FONT_COLOR;
  image: ImageBitmap | null = null;
  btn: TSWinBtn | null = null;
  onChange: ((checked: boolean, src: TSWinCheck) => void) | null = null;
  private initialState = false;

  /** cTSWinCtrlMgr::DefaultCheckBox */
  static defaultCheckBox(mgr: TSWinCtrlMgr, id: number, caption: string): TSWinCheck {
    const c = new TSWinCheck();
    c.id = id;
    c.caption = caption;
    c.setFont(mgr.systemFont(0));
    c.setImage(mgr.systemBMP(SYS_CHECK));
    return c;
  }

  setFont(font: FfnFont): void {
    this.font = font;
  }

  setImage(img: ImageBitmap): void {
    this.image = img;
  }

  override async init(): Promise<boolean> {
    const btn = new TSWinBtn(0, this.image, 6, 1);
    btn.mode = BTN_TOGGLE_ON_DOWN;
    btn.setState(this.initialState ? 1 : 0);
    this.btn = btn;
    this.childAdd(btn);
    const bh = btn.getH();
    let th = 0;
    let tw = 0;
    if (this.caption && this.font) {
      th = this.font.height;
      tw = this.font.stringWidth(this.caption);
      if (tw > 0) tw += CAPTION_GAP;
    }
    const h = th < bh ? bh : th;
    this.setArea(this.area.left, this.area.top, this.area.left + tw + btn.getW(), this.area.top + h);
    return true;
  }

  getState(): boolean {
    return this.btn ? this.btn.state !== 0 : false;
  }

  setState(on: boolean): void {
    if (this.btn) this.btn.setState(on ? 1 : 0);
    else this.initialState = on;
  }

  override tsPaint(g: Gfx): void {
    if (!this.caption || !this.font || !this.btn) return;
    const x = this.btn.getW() + CAPTION_GAP;
    const y = Math.trunc((this.getH() - this.font.height) / 2);
    this.font.drawText(g.ctx, this.caption, g.ox + x, g.oy + y, this.textColor);
  }

  override tsOnCommand(cmd: number, source: TSWin): boolean {
    // A click of the button (cTSWinBtn::SendButtonCommand(1); here the command is the button id).
    if (source === this.btn) {
      this.onChange?.(this.getState(), this);
      this.parent?.tsOnCommand(CMD_CHECK_CHANGED, this);
      return true;
    }
    return super.tsOnCommand(cmd, source);
  }
}
