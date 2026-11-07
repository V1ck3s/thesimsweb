/**
 * cDDDSimsView's pause text: "Paused" centred at the top of the lot view
 * (cDDDSimsView::DrawPause, drawn by cDDDSimsView::TSPaint). Mac and Windows
 * builds agree:
 *  - constructor: the string +0x184 = "Paused" (lbl_105BC0E4 + 0x102, Windows
 *    s_Paused), the display time +0x188 = 3000 ms; Init then replaces both
 *    from UIText STR# 148 (LoadUIStrings(0x94)): entry 0 the text in the
 *    game's language ("Pause" in French), entry 1 the time (sscanf "%d");
 *  - Init: font +0x178 = TSAcquireFont(1, 0x30) (size 48; 12 in Finnish), its
 *    color (0xff, 0, 0); a plain hidden child window +0x17c
 *    (SetOverlapsScrollArea(1));
 *  - DrawPause(show, timed): drops a pending timer, sets the flag +0x180,
 *    subscribes a timer of +0x188 ms when both are set (TSOnTimerMsg clears
 *    the flag and hides the window), shows or hides the window;
 *  - TSPaint, while the flag is set: TSTextArea of the string, centred in
 *    the view's width at y 0x14; the window takes that rectangle; the text is
 *    drawn over the rendered world with the font's own flags.
 * Callers (CPState): SetMode build (0), buy (1), camera (4): DrawPause(1, 1);
 * live (2): DrawPause(paused, 0); options and the others: DrawPause(1, 0);
 * Pause(on) in live mode: DrawPause(on, 0).
 *
 * This window is the +0x17c child and paints the text itself (the view's
 * children are plotted after the world).
 */

import type { GameContext } from "../context.js";
import { Mode, type CPState } from "../cpstate.js";
import type { FfnFont } from "../res/ffn.js";
import { UI_LANGUAGE } from "../res/uires.js";
import { rgb } from "./syscolors.js";
import { type Gfx, TSWin } from "./tswin.js";

/** The constructor's defaults, kept when STR# 148 cannot be read. */
const DEFAULT_TEXT = "Paused";
const DEFAULT_SHOW_MS = 3000;
/** UIText STR# 148: the pause text and its display time. */
const STR_PAUSE = 148;
const TOP = 0x14;
const COLOR = rgb(0xff, 0, 0);
const LANG_FINNISH = 0x0b;

export class PauseText extends TSWin {
  private hideAt = Infinity;
  /** +0x184 / +0x188 */
  private readonly text: string;
  private readonly showMs: number;
  private lastMode: Mode | null = null;
  private lastPaused: boolean | null = null;
  private readonly onState = (s: CPState): void => this.update(s);

  private constructor(
    private readonly ctx: GameContext,
    private readonly view: TSWin,
    private readonly font: FfnFont,
  ) {
    super();
    // cDDDSimsView::Init: LoadUIStrings(0x94), entry 0 the text, entry 1 the time.
    this.text = ctx.strings.get("UIText", STR_PAUSE, 0) || DEFAULT_TEXT;
    const ms = Number.parseInt(ctx.strings.get("UIText", STR_PAUSE, 1), 10);
    this.showMs = Number.isFinite(ms) ? ms : DEFAULT_SHOW_MS;
  }

  /** cDDDSimsView::Init's part: a hidden child of the view, driven by CPState. */
  static async attach(ctx: GameContext, view: TSWin): Promise<PauseText> {
    const t = new PauseText(ctx, view, await ctx.fonts.acquire(UI_LANGUAGE === LANG_FINNISH ? 0xc : 0x30));
    view.childAdd(t);
    t.hideWindow();
    ctx.state.onChange(t.onState);
    t.update(ctx.state);
    return t;
  }

  override shutdown(): void {
    this.ctx.state.offChange(this.onState);
    super.shutdown();
  }

  /** The CPState::SetMode / Pause calls of DrawPause. */
  private update(s: CPState): void {
    const mode = s.getMode();
    const paused = s.isPaused();
    if (mode !== this.lastMode) {
      if (mode === Mode.Build || mode === Mode.Buy || mode === Mode.Camera) this.drawPause(true, true);
      else if (mode === Mode.Live) this.drawPause(paused, false);
      else this.drawPause(true, false);
    } else if (paused !== this.lastPaused && mode === Mode.Live) {
      this.drawPause(paused, false);
    }
    this.lastMode = mode;
    this.lastPaused = paused;
  }

  /** cDDDSimsView::DrawPause */
  private drawPause(show: boolean, timed: boolean): void {
    this.hideAt = show && timed ? performance.now() + this.showMs : Infinity;
    if (show) {
      this.place();
      this.showWindow();
      this.view.childToFront(this);
    } else {
      this.hideWindow();
    }
  }

  /** TSPaint's TSTextArea, centred in the view's width at y 0x14. */
  private place(): void {
    const { w, h } = this.font.textArea(this.text);
    const left = Math.trunc((this.view.getW() - w) / 2);
    this.setArea(left, TOP, left + w, TOP + h);
  }

  /** cDDDSimsView::TSOnTimerMsg */
  override pump(nowMs: number): void {
    if (nowMs >= this.hideAt) {
      this.hideAt = Infinity;
      this.hideWindow();
    }
    super.pump(nowMs);
  }

  override tsPaint(g: Gfx): void {
    this.font.drawText(g.ctx, this.text, g.ox, g.oy, COLOR);
  }
}
