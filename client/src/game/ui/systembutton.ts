/**
 * Stretchable text push button (cTSSystemButton), the button of message boxes
 * and generic dialogs (cTSWinCtrlMgr::DefaultPushBtn).
 *
 * From the decompiled class:
 *  - the image (kSMSystemBtn, 4 frames) is drawn in three slices: an edge of
 *    (frameW - 1) / 2 pixels on each side and the middle column tiled
 *    (cTSSystemButton::ImageBlt);
 *  - the caption box runs from edge - 10 to width - edge + 10; the caption uses
 *    the size 12 table font, shrunk down to 8 until it fits (SetArea), is
 *    centered, colored per frame (cTSWinBtn::GetHiliteColor) and offset by
 *    (2, 2) when pressed (SetCustomTextOffsets); a caption that still does not
 *    fit is cut at a word and followed by "..." (CaptionDraw);
 *  - SetCaption resizes the button around its center to fit the caption;
 *    DefaultPushBtn then enforces a 100 px minimum width.
 */

import type { FfnFont } from "../res/ffn.js";
import { TSWinBtn } from "./btn.js";
import { SYS_BTN, type TSWinCtrlMgr } from "./ctrlmgr.js";
import { hiliteColor } from "./syscolors.js";
import type { Gfx } from "./tswin.js";

const TEXT_OFFSETS: [number, number][] = [
  [0, 0],
  [2, 2],
  [0, 0],
  [0, 0],
];
const ELLIPSIS = "...";

export class TSSystemButton extends TSWinBtn {
  private fontSize = 12;
  private textWidth = 0;
  private textLeft = 0;
  private textTop = 0;
  private textRight = 0;

  constructor(
    private readonly mgr: TSWinCtrlMgr,
    image: ImageBitmap,
  ) {
    super(0, image, 4, 1);
  }

  /** cTSWinCtrlMgr::DefaultPushBtn */
  static defaultPushBtn(mgr: TSWinCtrlMgr, id: number, caption: string): TSSystemButton {
    const b = new TSSystemButton(mgr, mgr.systemBMP(SYS_BTN));
    b.id = id;
    b.setCaption(caption);
    if (b.getW() < 100) b.setArea(b.area.left, b.area.top, b.area.left + 100, b.area.bottom);
    return b;
  }

  private get edge(): number {
    const frameW = this.image ? Math.trunc(this.image.width / 4) : 0;
    return Math.trunc((frameW - 1) / 2);
  }

  private get textFont(): FfnFont {
    return this.mgr.tableFont(this.fontSize);
  }

  override setArea(left: number, top: number, right: number, bottom: number): void {
    const oldW = this.getW();
    super.setArea(left, top, right, bottom);
    const edge = this.edge;
    this.textLeft = edge - 10;
    this.textRight = this.getW() - edge + 10;
    if (oldW !== this.getW() && this.caption) {
      this.fontSize = 12;
      this.textWidth = this.textFont.stringWidth(this.caption);
      while (this.textRight - this.textLeft < this.textWidth && this.fontSize > 8) {
        this.fontSize--;
        this.textWidth = this.textFont.stringWidth(this.caption);
      }
    }
  }

  setCaption(text: string): void {
    this.caption = text;
    this.fontSize = 12;
    const edge = this.edge;
    const font = this.textFont;
    this.textWidth = font.stringWidth(text);
    this.textLeft = edge - 10;
    this.textRight = this.textWidth + edge - 10;
    this.textTop = Math.max(0, Math.trunc((this.getH() - font.height) / 2));
    const w = edge * 2 + this.textWidth - 20;
    if (w !== this.getW()) {
      const shift = Math.trunc((this.getW() - w) / 2);
      this.setArea(this.area.left + shift, this.area.top, this.area.right + shift, this.area.bottom);
      this.setArea(this.area.left, this.area.top, this.area.left + w, this.area.bottom);
    }
  }

  /** The three slices are opaque: hit testing is the plain rectangle. */
  protected override isPointTransparent(): boolean {
    return false;
  }

  override tsPaint(g: Gfx): void {
    this.imageBlt(g);
    if (this.caption) this.captionDraw(g);
  }

  /** cTSSystemButton::ImageBlt */
  private imageBlt(g: Gfx): void {
    const img = this.image;
    if (!img) return;
    const frameW = Math.trunc(img.width / 4);
    const h = this.getH();
    const sx = this.frameColumn() * frameW;
    const edge = this.edge;
    const w = this.getW();
    g.blitPart(img, sx, 0, edge, h, 0, 0);
    const mid = frameW - 2 * edge;
    for (let x = edge; x < w - edge; x += mid) {
      g.blitPart(img, sx + edge, 0, Math.min(mid, w - edge - x), h, x, 0);
    }
    g.blitPart(img, sx + frameW - edge, 0, edge, h, w - edge, 0);
  }

  /** cTSSystemButton::CaptionDraw */
  private captionDraw(g: Gfx): void {
    const font = this.textFont;
    const col = this.frameColumn();
    const color = hiliteColor(4, col);
    const [ox, oy] = TEXT_OFFSETS[col] ?? [0, 0];
    const avail = this.textRight - this.textLeft;
    const x = g.ox + this.textLeft + ox;
    const y = g.oy + this.textTop + oy;
    if (avail < this.textWidth) {
      const n = font.calculateWordsToFitInWidth(
        this.caption,
        0,
        this.caption.length,
        avail - font.stringWidth(ELLIPSIS),
      );
      const part = this.caption.slice(0, n);
      font.drawText(g.ctx, part, x, y, color);
      const drawn = font.textArea(part).w;
      font.drawText(g.ctx, ELLIPSIS, x + Math.trunc((avail - drawn) / 2), y, color);
    } else {
      font.drawText(g.ctx, this.caption, x + Math.trunc((avail - this.textWidth) / 2), y, color);
    }
  }
}
