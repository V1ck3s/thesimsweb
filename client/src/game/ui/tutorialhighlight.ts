/**
 * cTSWinTutorialHighlight — the animated arrow the tutorial shows over a
 * window (cTSWin::HiliteForTutorial), and the window manager's single
 * instance (cTSWinMgrW95::SetTutorialHighlighter, +0x20c).
 *
 * cDDDSimsView's init creates it in the main window, hidden, with
 * kTutorialHighlightBMP (three frames side by side, transparent) at 6
 * frames per second (lbl_105BC0C8); the window is one frame wide
 * (SetBuffer). ShowWindow restarts the animation at frame 0 going forward;
 * each timer message (1000 / fps + 0.5 ms, lbl_105BD118) steps it and
 * reverses at both ends (0 1 2 1 0 ...).
 *
 * cTSWin::HiliteForTutorial(on): hidden when off or when the window is
 * hidden; else moved centered above the window (3 px gap), shown, pulled
 * to the front, with the standard cursor 0. cWinLotBtn::HiliteForTutorial
 * moves it 0x32 lower and gives it the arrow (standard cursor 4).
 *
 * Deviation: the original also sets window flag 0x10000 on it; that bit is
 * the modal flag of the web window manager (keys go to the front-most modal
 * window), so it is left clear.
 */

import type { GameContext } from "../context.js";
import { TSWinBtn } from "./btn.js";
import { getStandardCursor } from "./cursor.js";
import { Gfx, TSWin } from "./tswin.js";
import { winMgr } from "./winmgr.js";

/** lbl_105BC0C8: frames per second. */
const FPS = 6;
/** The bitmap's frame count (SetBuffer(..., 3, fps)). */
const FRAMES = 3;
/** lbl_105BD118: timer period = 1000 * (1 / fps) + 0.5. */
const PERIOD_MS = Math.trunc(1000 * (1 / FPS) + 0.5);

export class TSWinTutorialHighlight extends TSWin {
  /** +0xcc / +0xd0 / +0xd4 */
  private buffer: ImageBitmap | null = null;
  private frames = 0;
  private fps = 0;
  /** +0xd8: step (1 / -1); +0xdc: current frame; +0xe0: timer subscribed. */
  private step = 0;
  private frame = 0;
  private timerOn = false;
  private lastStepMs = 0;

  /** cTSWinTutorialHighlight::Init */
  override async init(): Promise<boolean> {
    this.winCursor = getStandardCursor(0);
    return true;
  }

  /** cTSWinTutorialHighlight::SetBuffer(buffer, frames, fps): one frame wide, the bitmap's height. */
  setBuffer(buffer: ImageBitmap | null, frames: number, fps: number): void {
    this.buffer = buffer;
    this.frames = frames;
    this.fps = fps;
    if (!buffer) return;
    const w = frames === 0 ? buffer.width : Math.trunc(buffer.width / frames);
    this.setArea(this.area.left, this.area.top, this.area.left + w, this.area.top + buffer.height);
  }

  /** cTSWinTutorialHighlight::ShowWindow */
  override showWindow(): void {
    if (!this.isVisible()) {
      this.frame = 0;
      this.step = 1;
      if (!this.timerOn && this.fps > 0) {
        this.timerOn = true;
        this.lastStepMs = performance.now();
      }
    }
    super.showWindow();
  }

  /** cTSWinTutorialHighlight::HideWindow */
  override hideWindow(): void {
    if (this.isVisible()) this.timerOn = false;
    super.hideWindow();
  }

  /** cTSWinTutorialHighlight::TSOnTimerMsg (driven by the pump at the subscribed period). */
  override pump(nowMs: number): void {
    if (this.timerOn && nowMs - this.lastStepMs >= PERIOD_MS) {
      this.lastStepMs = nowMs;
      if (this.step > 0) {
        if (this.frame === this.frames - 1) this.step = -1;
      } else if (this.step < 0 && this.frame === 0) {
        this.step = 1;
      }
      this.frame += this.step;
    }
    super.pump(nowMs);
  }

  /** cTSWinTutorialHighlight::TSPaint: frame `frame` of the strip. */
  override tsPaint(g: Gfx): void {
    const b = this.buffer;
    if (!b || this.frames === 0) return;
    const w = Math.trunc(b.width / this.frames);
    g.blitPart(b, this.frame * w, 0, w, b.height, 0, 0);
  }
}

/** cTSWinMgrW95 +0x20c */
let highlighter: TSWinTutorialHighlight | null = null;
let creating: Promise<TSWinTutorialHighlight> | null = null;

/**
 * The tutorial highlighter, made on first use as cDDDSimsView's init makes
 * it: in the main window, hidden, kTutorialHighlightBMP, 3 frames at 6 fps
 * (cTSWinMgrW95::SetTutorialHighlighter).
 */
export function getTutorialHighlighter(ctx: GameContext): Promise<TSWinTutorialHighlight> {
  creating ??= (async () => {
    const h = new TSWinTutorialHighlight();
    await h.init();
    winMgr.main.childAdd(h);
    h.hideWindow();
    h.setBuffer(await ctx.res.image("kTutorialHighlightBMP"), FRAMES, FPS);
    highlighter = h;
    return h;
  })();
  return creating;
}

/**
 * cTSWin::HiliteForTutorial(on) (vtable +0x168) for `win`; `lotBtn` adds
 * cWinLotBtn's override (0x32 lower, arrow cursor).
 */
export async function hiliteForTutorial(ctx: GameContext, win: TSWin, on: boolean, lotBtn = false): Promise<void> {
  const h = highlighter ?? (on ? await getTutorialHighlighter(ctx) : null);
  if (!h) return;
  if (!on || !win.isVisible()) {
    h.hideWindow();
    return;
  }
  const o = win.absOrigin();
  const x = o.x + Math.trunc((win.getW() - h.getW()) / 2);
  const y = o.y - (h.getH() + 3);
  h.setArea(x, y, x + h.getW(), y + h.getH());
  h.showWindow();
  h.parent?.childToFront(h);
  h.winCursor = getStandardCursor(0);
  if (lotBtn) {
    h.setArea(h.area.left, h.area.top + 0x32, h.area.right, h.area.bottom + 0x32);
    h.winCursor = getStandardCursor(4);
  }
}

/** FindButton(cTSWin *, int): depth first, the first button whose bitmap is resource `image`. */
function findButton(win: TSWin, image: ImageBitmap): TSWinBtn | null {
  for (const c of win.children) {
    if (c instanceof TSWinBtn && c.image === image) return c;
    const found = findButton(c, image);
    if (found) return found;
  }
  return null;
}

/**
 * The end of Tut_FlashPersonPanelButton / Tut_FlashRelButton: HiliteForTutorial
 * on the window the caller found (FindButton on the person's picture buffer,
 * FindRelButton), nothing when there is none.
 */
export async function tutFlashWindow(ctx: GameContext, win: TSWin | null, on: boolean): Promise<void> {
  if (win) await hiliteForTutorial(ctx, win, on);
}

/** Tut_FlashButtonByImageID(id, on): the arrow over the main window's button showing bitmap `id`. */
export async function tutFlashButtonByImageID(ctx: GameContext, id: number, on: boolean): Promise<void> {
  const image = await ctx.res.image(id).catch(() => null);
  const btn = image ? findButton(winMgr.main, image) : null;
  if (btn) await hiliteForTutorial(ctx, btn, on);
}
