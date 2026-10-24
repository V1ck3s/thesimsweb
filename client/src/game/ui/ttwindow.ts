/**
 * The game's tooltip window (cDefaultTTWindow), owned by the window manager
 * (cTSWinMgrW95::GetDefaultTTWindow) and shown by its tooltip state machine.
 *
 * From the decompiled class:
 *  - font: size 7 table font (TSAcquireFont(1, 7, 0)), black, or red for
 *    tooltip color 1 (SetToolTip, Init);
 *  - the window is text width + 6 by font height + 2, filled with
 *    (255, 255, 224), outlined in black, text at (3, 1);
 *  - UnfurlToolTip(rect, t) places it at (rect.left, rect.bottom - height) and
 *    blends it with alpha 255 * t + 0.5 (lbl_105BC988).
 */

import type { FfnFont } from "../res/ffn.js";
import type { Fonts } from "../res/fonts.js";
import { rgb } from "./syscolors.js";
import { Gfx, TSWin, type Rect } from "./tswin.js";

const FILL = rgb(0xff, 0xff, 0xe0);
const OUTLINE = rgb(0, 0, 0);
const TEXT_COLORS = [rgb(0, 0, 0), rgb(0xff, 0, 0)];

export class DefaultTTWindow extends TSWin {
  text = "";
  private color = 0;
  private alpha = 255;
  private canvas: HTMLCanvasElement | null = null;

  constructor(private readonly font: FfnFont) {
    super();
  }

  /** The window manager's tooltip window, with the size 7 font loaded. */
  static async create(fonts: Fonts): Promise<DefaultTTWindow> {
    return new DefaultTTWindow(await fonts.acquire(7));
  }

  /** cDefaultTTWindow::SetToolTip */
  setToolTip(text: string, color = 0): void {
    this.text = text;
    this.color = color;
    this.setArea(0, 0, this.font.stringWidth(text) + 6, this.font.height + 2);
  }

  /** cDefaultTTWindow::UnfurlToolTip */
  unfurlToolTip(rect: Rect, t: number): void {
    const x = rect.left;
    const y = rect.bottom - this.getH();
    this.setArea(x, y, x + this.getW(), y + this.getH());
    this.alpha = Math.max(0, Math.min(255, Math.trunc(255 * t + 0.5)));
  }

  override tsPaint(g: Gfx): void {
    // The tooltip is drawn into its own buffer, then blended as a whole.
    const w = this.getW();
    const h = this.getH();
    const buf = this.buffer();
    const b = buf.getContext("2d")!;
    b.clearRect(0, 0, buf.width, buf.height);
    b.fillStyle = FILL;
    b.fillRect(0, 0, w, h);
    b.strokeStyle = OUTLINE;
    b.lineWidth = 1;
    b.strokeRect(0.5, 0.5, w - 1, h - 1);
    this.font.drawText(b, this.text, 3, 1, TEXT_COLORS[this.color] ?? TEXT_COLORS[0]!);
    g.ctx.save();
    g.ctx.globalAlpha = this.alpha / 255;
    g.blitPart(buf, 0, 0, w, h, 0, 0);
    g.ctx.restore();
  }


  private buffer(): HTMLCanvasElement {
    const c = (this.canvas ??= document.createElement("canvas"));
    if (c.width < this.getW() || c.height < this.getH()) {
      c.width = Math.max(c.width, this.getW());
      c.height = Math.max(c.height, this.getH());
    }
    return c;
  }
}
