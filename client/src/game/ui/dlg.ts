/**
 * Dialog base (cTSWinDlg): a window run with WinMgr.doModalWin that ends its
 * modal loop with TSEndDialog(result) (posts the 0x10 message).
 */

import { Gfx, TSWin } from "./tswin.js";
import { winMgr } from "./winmgr.js";

/**
 * cTSBuffer::BltEdge: draws a frame from a 3x3 grid of `cw` x `ch` cells:
 * corners copied, edges tiled, the center tiled only when `fillCenter`.
 */
export function bltEdge(g: Gfx, img: CanvasImageSource, cw: number, ch: number, w: number, h: number, fillCenter: boolean): void {
  const tile = (sx: number, sy: number, x0: number, y0: number, x1: number, y1: number): void => {
    for (let y = y0; y < y1; y += ch) {
      for (let x = x0; x < x1; x += cw) g.blitPart(img, sx, sy, Math.min(cw, x1 - x), Math.min(ch, y1 - y), x, y);
    }
  };
  const right = w - cw;
  const bottom = h - ch;
  g.blitPart(img, 0, 0, cw, ch, 0, 0);
  tile(cw, 0, cw, 0, right, ch);
  g.blitPart(img, 2 * cw, 0, cw, ch, right, 0);
  tile(0, ch, 0, ch, cw, bottom);
  if (fillCenter) tile(cw, ch, cw, ch, right, bottom);
  tile(2 * cw, ch, right, ch, w, bottom);
  g.blitPart(img, 0, 2 * ch, cw, ch, 0, bottom);
  tile(cw, 2 * ch, cw, bottom, right, h);
  g.blitPart(img, 2 * cw, 2 * ch, cw, ch, right, bottom);
}

export class TSWinDlg extends TSWin {
  /** cTSWinDlg::TSEndDialog */
  tsEndDialog(result: number): void {
    winMgr.endDialog(this, result);
  }

  /** Runs the dialog modally over the main window (DoModalWin). */
  doModal(): Promise<number> {
    return winMgr.doModalWin(this);
  }
}
