/**
 * cWinProgressPictureDialog: the "please wait" box Neighborhood::RefillTownies
 * (and the other NPC refills) shows while it creates characters: a title, a
 * picture, a word-wrapped text and a progress bar, no button.
 *
 * From the decompiled class:
 *  - Init: SetFlag(0x10000), the frame is cTSWinCtrlMgr system bitmap 5
 *    (popup tiles, 3x3 cells: GetClientTopLeft = cell size), the wait cursor,
 *    kPictureDialogStub loaded (drawn under a 45 x 45 picture);
 *  - SetTitle: a cTSWinText, font lbl_105BA2E8 + 0x38 (size 14), one line,
 *    transparent, no gutters, fitted to the text;
 *  - AddText: the cWinTextWrap (+0xe8) text; SetImage: the picture (+0xf8);
 *  - DoLayout: the text width is searched so that the box's width / height
 *    comes closest to lbl_105BCB24 = 2.0 (TryLayout: width = 2 * (cell + 9)
 *    + text width, height = cell + text bottom + 0x12 + 0x1e). With a
 *    picture and a title, the title is centered over the text column at
 *    (cell + 9) from the top, the text starts 0x12 under it and wraps around
 *    the picture (SetTopLeftImageSize: picture width + 0x12); the text
 *    window is at least title width + picture width + 0x12 wide;
 *  - TSBeginModal (mode +0x118 = 0): centered on the main window;
 *  - TSPaint: frame (BltEdge, center filled), picture at (9, 9) + cell, then
 *    the bar: (20, h - 35, w - 20, h - 15) in color 0x32, the done part
 *    (20, h - 34, 20 + (w - 40) * done / total, h - 16) in color 0x98 (native
 *    16-bit colors: 565 (0, 4, 144) and (0, 16, 192));
 *  - TickOnce: done + 1, repaint (the caller keeps working synchronously).
 */

import type { GameContext } from "../context.js";
import type { FfnFont } from "../res/ffn.js";
import { SYS_POPUP_TILES, TSWinCtrlMgr } from "../ui/ctrlmgr.js";
import { bltEdge } from "../ui/dlg.js";
import { rgb, UI_FONT_COLOR } from "../ui/syscolors.js";
import { TSWinText, WTF_MULTILINE } from "../ui/text.js";
import { Gfx, TSWin } from "../ui/tswin.js";
import { winMgr } from "../ui/winmgr.js";

/** lbl_105BCB24: the width / height ratio DoLayout aims at. */
const TARGET_RATIO = 2.0;
/** The 45 x 45 picture size that gets the kPictureDialogStub frame. */
const STUB_SIZE = 0x2d;
const BAR_COLOR = rgb(0, 4, 144);
const BAR_DONE_COLOR = rgb(0, 16, 192);

export class WinProgressPictureDialog extends TSWin {
  private frame: ImageBitmap | null = null;
  private stub: ImageBitmap | null = null;
  private image: ImageBitmap | null = null;
  private title: TSWinText | null = null;
  private text = "";
  private font: FfnFont | null = null;
  /** +0xd0 / +0xd4 */
  private done = 0;
  private total = 1;
  /** Text column (window coordinates) and the picture's indent. */
  private textLeft = 0;
  private textTop = 0;
  private textWidth = 0;
  private indentW = 0;
  private indentBottom = 0;

  constructor(private readonly ctx: GameContext) {
    super();
  }

  override async init(): Promise<boolean> {
    const mgr = await TSWinCtrlMgr.get(this.ctx);
    this.frame = mgr.systemBMP(SYS_POPUP_TILES);
    this.font = mgr.systemFont(0);
    this.stub = await this.ctx.res.image("kPictureDialogStub").catch(() => null);
    return true;
  }

  async setTitle(s: string): Promise<void> {
    const t = new TSWinText();
    t.setFont(await this.ctx.fonts.acquire(14));
    t.setCaption(s);
    t.setBackgroundOpaque(false);
    t.setWinTextFlag(WTF_MULTILINE, false);
    t.setAlignment(2);
    t.setGutters(0, 0);
    t.fitWindowToText();
    this.childAdd(t);
    this.title = t;
  }

  addText(s: string): void {
    this.text += s;
  }

  setImage(img: ImageBitmap | null): void {
    this.image = img;
  }

  setTotal(n: number): void {
    this.total = n;
  }

  /** TickOnce: one more step done; resolves after the next frame was painted. */
  tickOnce(): Promise<void> {
    this.done++;
    return nextFrame();
  }

  private cell(): { w: number; h: number } {
    return this.frame ? { w: Math.trunc(this.frame.width / 3), h: Math.trunc(this.frame.height / 3) } : { w: 0, h: 0 };
  }

  /** Picture size as the layout sees it (a 45 x 45 picture takes the stub's size). */
  private pictureSize(): { w: number; h: number } {
    const img = this.image;
    if (!img) return { w: 0, h: 0 };
    if (img.width === STUB_SIZE && img.height === STUB_SIZE && this.stub) return { w: this.stub.width, h: this.stub.height };
    return { w: img.width, h: img.height };
  }

  /** Number of text lines for a column `width` wide, the first lines narrowed by the picture. */
  private textHeight(width: number, top: number): number {
    const font = this.font!;
    let y = top;
    for (let pos = 0; pos < this.text.length; y += font.height) {
      const w = y < this.indentBottom ? width - this.indentW : width;
      pos += Math.max(1, font.calculateWordsToFitInWidth(this.text, pos, this.text.length - pos, Math.max(1, w)));
    }
    return y - top;
  }

  /** TryLayout for a text column `width` wide: sets the area, returns width / height. */
  private tryLayout(width: number): number {
    const c = this.cell();
    const pic = this.pictureSize();
    const titleH = this.title ? this.title.getH() : 0;
    // The text window is widened to hold the title beside the picture.
    if (this.title) width = Math.max(width, this.title.getW() + (pic.w ? pic.w + 0x12 : 0));
    this.textWidth = width;
    this.textLeft = c.w + 9;
    this.textTop = this.title ? c.h + 9 + titleH + 0x12 : c.h + 9;
    this.indentW = pic.w ? pic.w + 0x12 : 0;
    this.indentBottom = pic.h + c.h + 0x1b;
    const bottom = this.textTop + this.textHeight(width, this.textTop);
    const w = 2 * (c.w + 9) + width;
    const h = c.h + bottom + 0x12 + 0x1e;
    this.setArea(this.area.left, this.area.top, this.area.left + w, this.area.top + h);
    if (this.title) {
      const t = this.title;
      // Centered over the text wrap's indented line width (+0xe0).
      const x = pic.w + c.w + Math.trunc((width - this.indentW - t.getW()) / 2) + 0x12;
      t.setArea(x, c.h + 9, x + t.getW(), c.h + 9 + t.getH());
    }
    return w / h;
  }

  /** DoLayout: the column width whose box ratio is closest to 2. */
  private doLayout(): void {
    let best = 300;
    let bestErr = Infinity;
    for (let width = 120; width <= 700; width += 2) {
      const err = Math.abs(this.tryLayout(width) - TARGET_RATIO);
      if (err < bestErr) {
        bestErr = err;
        best = width;
      }
    }
    this.tryLayout(best);
  }

  /** TSBeginModal + ChildAdd to the main window + ShowWindow + PullToFront (RefillTownies). */
  show(): Promise<void> {
    this.doLayout();
    winMgr.main.childAdd(this);
    this.centerWindowInRect(winMgr.main.area);
    this.showWindow();
    return nextFrame();
  }

  /** cTSWinMgrW95::DestroyWindow */
  close(): void {
    winMgr.main.childDelete(this);
  }

  override tsPaint(g: Gfx): void {
    const w = this.getW();
    const h = this.getH();
    const c = this.cell();
    if (this.frame) bltEdge(g, this.frame, c.w, c.h, w, h, true);
    const img = this.image;
    if (img) {
      const x = 9 + c.w;
      const y = 9 + c.h;
      if (img.width === STUB_SIZE && img.height === STUB_SIZE && this.stub) {
        g.blit(this.stub, x, y);
        g.blit(img, x + Math.trunc((this.stub.width - STUB_SIZE) / 2), y + Math.trunc((this.stub.height - STUB_SIZE) / 2));
      } else {
        g.blit(img, x, y);
      }
    }
    const font = this.font;
    if (font) {
      let y = this.textTop;
      for (let pos = 0; pos < this.text.length; y += font.height) {
        const indent = y < this.indentBottom ? this.indentW : 0;
        const n = Math.max(1, font.calculateWordsToFitInWidth(this.text, pos, this.text.length - pos, Math.max(1, this.textWidth - indent)));
        font.drawText(g.ctx, this.text.slice(pos, pos + n), g.ox + this.textLeft + indent, g.oy + y, UI_FONT_COLOR);
        pos += n;
      }
    }
    g.fill(0x14, h - 0x23, w - 0x28, 0x14, BAR_COLOR);
    const done = Math.trunc(((w - 0x28) * Math.min(this.done, this.total)) / Math.max(1, this.total));
    g.fill(0x14, h - 0x22, done, 0x12, BAR_DONE_COLOR);
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}
