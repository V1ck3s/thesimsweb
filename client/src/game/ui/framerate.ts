/**
 * cDDDSimsView's frame rate text (+0x18c, a cTSWinText made by
 * cDDDSimsView::Init), shown and hidden by the view's 't' key
 * (cDDDSimsView::TSOnCharacter).
 *
 * From the decompiled code:
 *  - Init: font table entry 8, no opaque background, single line, text
 *    color lbl_105BA7B8 (InitSimsColors' red), a hidden child of the view;
 *    PulseGenerator::SetAvgPeriod(+0x64, 1000).
 *  - 't': a hidden text is shown (SetOverlapsScrollArea(1)); a shown one is
 *    hidden (SetOverlapsScrollArea(0)) and its caption becomes "Unknown".
 *  - The view's idle step, once a second (the pulse) while the text is
 *    visible: "FPS: %3.1lf" of TBFrequencyProbe::AvgFrequency (+0x68, the
 *    view's frames), FitWindowToText, then the text goes 3 pixels inside the
 *    view's right edge, its bottom 3 pixels above the view's bottom when the
 *    control panel is collapsed (CP mode 1), else at the control panel's top
 *    + 0x2f (3 pixels above the panel's top with a double byte UI, which this
 *    port does not have).
 * The frame frequency here counts the browser's animation frames over the
 * last second (the game paints once per animation frame).
 */

import type { GameContext } from "../context.js";
import { rgb } from "./syscolors.js";
import { TSWinText, WTF_MULTILINE } from "./text.js";
import type { TSWin } from "./tswin.js";

/** lbl_105BA7B8 (InitSimsColors' red). */
const FPS_COLOR = rgb(0xd1, 0, 0);
/** lbl_105BC0E4 + 0x29 / + 0xaf. */
const UNKNOWN = "Unknown";
const FORMAT = (fps: number): string => `FPS: ${fps.toFixed(1)}`;
/** PulseGenerator::SetAvgPeriod(1000). */
const PULSE_MS = 1000;
/** cTSWinText::SetArea's offsets from the view's edges and the control panel's top. */
const EDGE = 3;
const PANEL_TOP_OFFSET = 0x2f;

export class FrameRateText extends TSWinText {
  private frames: number[] = [];
  private raf = 0;
  private lastPulse = 0;

  constructor(
    private readonly view: TSWin,
    /** The control panel window (CPState +0x44), when the view has one. */
    private readonly panel: () => TSWin | null,
    private readonly cpMode: () => number,
  ) {
    super();
  }

  /** cDDDSimsView::Init's part. */
  async create(ctx: GameContext): Promise<void> {
    this.setFont(await ctx.fonts.acquire(8));
    this.setBackgroundOpaque(false);
    this.setTextColor(FPS_COLOR);
    this.setWinTextFlag(WTF_MULTILINE, false);
    this.view.childAdd(this);
    this.hideWindow();
  }

  /** cDDDSimsView::TSOnCharacter('t'). */
  toggle(): void {
    if (!this.isVisible()) {
      this.showWindow();
      this.view.childToFront(this);
      this.lastPulse = performance.now();
      this.frames = [];
      this.raf = requestAnimationFrame(this.onFrame);
    } else {
      this.hideWindow();
      cancelAnimationFrame(this.raf);
      this.setCaption(UNKNOWN);
    }
  }

  override shutdown(): void {
    cancelAnimationFrame(this.raf);
    super.shutdown();
  }

  /** TBFrequencyProbe (one sample per frame) and the view idle step's pulse. */
  private readonly onFrame = (now: number): void => {
    if (!this.isVisible()) return;
    this.frames.push(now);
    while (this.frames.length && now - this.frames[0]! > PULSE_MS) this.frames.shift();
    if (now - this.lastPulse >= PULSE_MS) {
      this.lastPulse = now;
      const span = this.frames.length > 1 ? now - this.frames[0]! : 0;
      this.setCaption(FORMAT(span > 0 ? ((this.frames.length - 1) * 1000) / span : 0));
      this.fitWindowToText();
      this.place();
    }
    this.raf = requestAnimationFrame(this.onFrame);
  };

  private place(): void {
    const w = this.getW();
    const h = this.getH();
    const left = this.view.getW() - w - EDGE;
    const panel = this.panel();
    const top = this.cpMode() === 0 && panel ? panel.area.top + PANEL_TOP_OFFSET - h : this.view.getH() - EDGE - h;
    this.setArea(left, top, left + w, top + h);
  }
}
