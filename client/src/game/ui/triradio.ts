/**
 * Three-way radio (cWinTriRadio), used by the options panel.
 *
 * From the decompiled class:
 *  - Init creates three cTSWinBtn sharing one 6-frame image;
 *  - SetArea puts button 0 at the left edge, button 1 centered and button 2
 *    at the right edge;
 *  - SetVal(v) selects button v (state 1) and clears the others; clicking a
 *    button selects it and notifies the owner with command 0x1e.
 */

import { TSWinBtn } from "./btn.js";
import { TSWin } from "./tswin.js";

export const CMD_TRIRADIO_CHANGED = 0x1e;

export class WinTriRadio extends TSWin {
  readonly btns: TSWinBtn[] = [];
  onChange: ((value: number, src: WinTriRadio) => void) | null = null;
  private val = 0;

  constructor(private readonly image: ImageBitmap) {
    super();
  }

  override async init(): Promise<boolean> {
    for (let i = 0; i < 3; i++) {
      const b = new TSWinBtn(0, this.image, 6, 1);
      this.btns.push(b);
      this.childAdd(b);
    }
    this.setArea(this.area.left, this.area.top, this.area.right, this.area.bottom);
    this.setVal(this.val);
    return true;
  }

  override setArea(left: number, top: number, right: number, bottom: number): void {
    super.setArea(left, top, right, bottom);
    const [b0, b1, b2] = this.btns;
    if (!b0 || !b1 || !b2) return;
    const w = this.getW();
    b0.setArea(0, 0, b0.getW(), b0.getH());
    const x1 = Math.trunc((w - b1.getW()) / 2);
    b1.setArea(x1, 0, x1 + b1.getW(), b1.getH());
    const x2 = w - b2.getW();
    b2.setArea(x2, 0, x2 + b2.getW(), b2.getH());
  }

  getVal(): number {
    return this.val;
  }

  setVal(v: number): void {
    this.val = v;
    this.btns.forEach((b, i) => b.setState(v === i ? 1 : 0));
  }

  override tsOnCommand(cmd: number, source: TSWin): boolean {
    const i = this.btns.indexOf(source as TSWinBtn);
    if (i === -1) return super.tsOnCommand(cmd, source);
    this.setVal(i);
    this.onChange?.(this.val, this);
    this.parent?.tsOnCommand(CMD_TRIRADIO_CHANGED, this);
    return true;
  }
}
