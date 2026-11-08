/**
 * Startup splash screen (cTSWinSplashScreen + cSimsApp::SetSplashMessage).
 *
 * - Full-screen window; the frame bitmap (Splash.bmp, else kSimsLogo) is
 *   centered (TSPaint).
 * - The frame caption (UIText STR# 154 entry 6, the copyright line) is drawn
 *   white as a paragraph near the bottom: 5 lines up, or 3 when the screen is
 *   shorter than 701 px.
 * - Progress messages slide: the new one enters from the right edge to the
 *   center while the previous one leaves to the left, both over 1000 ms
 *   (RampGenerator constant-time ramps 1→0 and 0→-1). They sit on the line
 *   [height - 1.5 * fontHeight, height). Messages arriving during a slide are
 *   queued.
 * - Messages are looked up by four-character stage tag in UIText STR# 155;
 *   entries whose comment starts with "!" are not shown (SetSplashMessage).
 * - Not in the original: while the game files are preloaded (game/preload.ts),
 *   a progress bar under the frame bitmap (setProgress).
 */

import type { GameContext } from "../context.js";
import type { FfnFont } from "../res/ffn.js";
import { Gfx, TSWin, WF_HIDE_CURSOR } from "../ui/tswin.js";

/** cSimsApp splash stage tags, in STR# 155 order (entry index = position + 1). */
const STAGES = [
  "stap", "regr", "ctrl", "grph", "main", "lobj", "hous", "snds",
  "hvwr", "vtby", "fglb", "cpnl", "----", "----", "flrs", "char", "ocns",
] as const;
export type SplashStage = (typeof STAGES)[number];

const SLIDE_MS = 1000;

export class TSWinSplashScreen extends TSWin {
  private frame: ImageBitmap | null = null;
  private caption = "";
  private font: FfnFont | null = null;
  private current = "";
  private previous = "";
  private slideStart = -Infinity;
  private readonly queue: string[] = [];
  /** Fraction of the preload done (0..1), null when there is none to show. */
  private progress: number | null = null;

  constructor(readonly ctx: GameContext) {
    super();
  }

  override async init(): Promise<boolean> {
    const { ctx } = this;
    this.setArea(0, 0, ctx.width, ctx.height);
    // cTSWinSplashScreen::Init: cTSWin::HideCursor (Shutdown shows it again; the window goes away).
    this.setFlag(WF_HIDE_CURSOR, true);
    this.frame = await ctx.res.image("kSimsLogo");
    this.caption = ctx.strings.get("UIText", 154, 5);
    // The game passes a font from its global font table (index 18); its size is
    // not recovered yet, 12 pt matches the shipped screenshots.
    this.font = await ctx.fonts.acquire(12);
    return true;
  }

  /** cSimsApp::SetSplashMessage */
  setSplashMessage(stage: SplashStage): void {
    const i = STAGES.indexOf(stage);
    const text = this.ctx.strings.get("UIText", 155, i);
    if (!text || this.ctx.strings.comment("UIText", 155, i).startsWith("!")) return;
    this.setNextCaption(text);
  }

  /** cTSWinSplashScreen::SetNextCaption */
  setNextCaption(text: string): void {
    if (performance.now() < this.slideStart + SLIDE_MS) {
      this.queue.push(text);
      return;
    }
    this.startSlide(text);
  }

  /** The preload's progress bar: the fraction done (0..1), or null to hide it. */
  setProgress(fraction: number | null): void {
    this.progress = fraction === null ? null : Math.min(1, Math.max(0, fraction));
  }

  /** Resolves once every queued message has finished sliding in. */
  async finished(): Promise<void> {
    while (this.queue.length || performance.now() < this.slideStart + SLIDE_MS) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private startSlide(text: string): void {
    this.previous = this.current;
    this.current = text;
    this.slideStart = performance.now();
  }

  override pump(now: number): void {
    if (this.queue.length && now >= this.slideStart + SLIDE_MS) this.startSlide(this.queue.shift()!);
    super.pump(now);
  }

  override tsPaint(g: Gfx): void {
    const w = this.getW();
    const h = this.getH();
    g.fill(0, 0, w, h, "#000");
    if (this.frame) g.blit(this.frame, (w - this.frame.width) >> 1, (h - this.frame.height) >> 1);
    if (this.progress !== null) {
      // A white frame and fill between the bitmap and the progress messages.
      const fh = this.frame?.height ?? 0;
      const bw = Math.min(w - 32, 400);
      const bh = 8;
      const bx = (w - bw) >> 1;
      const by = Math.min(((h + fh) >> 1) + 16, h - 3 * (this.font?.height ?? 16) - bh);
      g.fill(bx, by, bw, 1, "#ffffff");
      g.fill(bx, by + bh - 1, bw, 1, "#ffffff");
      g.fill(bx, by, 1, bh, "#ffffff");
      g.fill(bx + bw - 1, by, 1, bh, "#ffffff");
      const fill = Math.round((bw - 4) * this.progress);
      if (fill > 0) g.fill(bx + 2, by + 2, fill, bh - 4, "#ffffff");
    }
    const font = this.font;
    if (!font) return;

    if (this.caption) {
      const lines = h < 701 ? 3 : 5;
      const top = h - font.height * lines;
      font.drawText(g.ctx, this.caption, g.ox + ((w - font.stringWidth(this.caption)) >> 1), g.oy + top, "#ffffff");
    }

    // RampGenerator::GetVal: linear from `from` to `to` over SLIDE_MS.
    const t = Math.min(1, (performance.now() - this.slideStart) / SLIDE_MS);
    const y = h - Math.trunc((font.height * 3) / 2);
    if (this.previous) {
      const tw = font.stringWidth(this.previous);
      const centered = (w - tw) * 0.5;
      const x = Math.trunc(-t * (centered + tw) + centered);
      font.drawText(g.ctx, this.previous, g.ox + x, g.oy + y, "#ffffff");
    }
    if (this.current) {
      const tw = font.stringWidth(this.current);
      const centered = (w - tw) * 0.5;
      const x = Math.trunc((1 - t) * (w - centered) + centered);
      font.drawText(g.ctx, this.current, g.ox + x, g.oy + y, "#ffffff");
    }
  }
}
