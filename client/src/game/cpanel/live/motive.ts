/**
 * cWinMotive — one need of the Live mode "Needs" page: the need's name above a
 * 60 x 5 bar, green on the left (how full the need is), red/grey on the right.
 *
 * From the decompiled code (WinMotive.cpp):
 *  - a cTSWinBtn without image (SetImage(0, 4, 1)), 100 x 20 (Init), font
 *    lbl_105BA2E8[8], toggled on press and firing on press (+0xf0 = 2, +0xec = 1);
 *  - caption = first string of its STR# pair, centered in (0, (10 - charHeight) / 2, w, h);
 *  - the bar's top-left is (20, 12) (sinit); its green width is
 *    round(60 * (value + 100) / 200), clamped to 0..60 (TSPaint);
 *  - bar colors are recomputed in SetVal from t = clamp((value + 50) / 100, 0, 1):
 *      green = (64 - 64t, 93 + 109t, 95 - 38t),  red = (64 + 145u, 93 - 93u, 95 - 95u), u = 1 - t
 *    (t and u quantized to 1/255); the ramps between old and new color have
 *    equal ends, so the color switches at once;
 *  - a 1 px black divider ends the green part when the red part is wider than 1 px.
 *
 * Not ported: the hover popup (cWinLivePopupClient, the need's description) and
 * the delta meter arrows (cWinDeltaMeter, fed by the per-person cAverageHistory).
 */

import type { GameContext } from "../../context.js";
import type { FfnFont } from "../../res/ffn.js";
import { ALIGN_CENTER } from "../../res/ffn.js";
import { BTN_TOGGLE_ON_DOWN, TSWinBtn } from "../../ui/btn.js";
import { hiliteColor, rgb } from "../../ui/syscolors.js";
import type { Gfx } from "../../ui/tswin.js";

/** lbl_105BC444 (sinit WinMotive.cpp): bar top-left in the window. */
const BAR_ORIGIN = { x: 20, y: 12 };
const BAR_W = 60;
const BAR_H = 5;

/** int(0.5 + x) truncated toward zero, then & 0xff, as the PPC code converts colors. */
function channel(x: number): number {
  return Math.trunc(0.5 + x) & 0xff;
}

export class WinMotive extends TSWinBtn {
  /** cWinMotive+0x18c: displayed value, -100..100. */
  private val = 0;
  /** cWinMotive+0x190: person handle (family index here), -1 = none. */
  private person = -1;
  private green = "";
  private red = "";
  private captionFont: FfnFont | null = null;

  /**
   * cWinMotive(iter, motive, guid, guid, scale, scale): `name` and `desc` are
   * the two strings the constructor takes from the STR# iterator.
   */
  constructor(
    readonly ctx: GameContext,
    readonly name: string,
    readonly desc: string,
    /** cWinMotive+0x194: index into the person's motives. */
    readonly motive: number,
  ) {
    super();
    this.caption = name;
    this.resetHistory();
  }

  override async init(): Promise<boolean> {
    this.captionFont = await this.ctx.fonts.acquire(8);
    this.font = this.captionFont;
    this.cols = 4;
    this.setArea(this.area.left, this.area.top, this.area.left + 100, this.area.top + 0x14);
    this.mode = BTN_TOGGLE_ON_DOWN;
    this.sendOnDown = true;
    // cWinDeltaMeter(10) at (bar.x - 20, bar.y) / (bar.x + 61, bar.y): not ported.
    return true;
  }

  /** cWinMotive::SetPerson. */
  setPerson(person: number): void {
    this.person = person;
  }

  /**
   * cWinMotive::Pump: reads the person's motive (rounded half away from zero).
   * Renamed: TSWin.pump is the per-frame tick.
   */
  pumpMotive(): void {
    if (this.person === -1) return;
    const v = this.ctx.state.family[this.person]?.motives[this.motive] ?? 0;
    this.setVal(v < 0 ? Math.trunc(v - 0.5) : Math.trunc(v + 0.5));
  }

  /** cWinMotive::GetGreenMagnitude. */
  private greenMagnitude(): number {
    return Math.min(1, Math.max(0, (this.val + 50) / 100));
  }

  /** cWinMotive::ResetHistory / the color part of SetVal. */
  private resetHistory(): void {
    const t = this.greenMagnitude();
    const u = channel(255 * (1 - t)) / 255;
    this.red = rgb(channel(u * 145 + 64), channel(u * -93 + 93), channel(u * -95 + 95));
    const g = channel(255 * t) / 255;
    this.green = rgb(channel(g * -64 + 64), channel(g * 109 + 93), channel(g * -38 + 95));
  }

  /** cWinMotive::SetVal. */
  setVal(v: number): void {
    if (v === this.val) return;
    this.val = v;
    this.resetHistory();
  }

  override tsPaint(g: Gfx): void {
    const font = this.captionFont;
    if (font && this.caption) {
      const top = Math.trunc((10 - font.height) / 2);
      const rect = { left: g.ox, top: g.oy + top, right: g.ox + this.getW(), bottom: g.oy + this.getH() };
      font.drawTextPara(g.ctx, rect, this.caption, ALIGN_CENTER, hiliteColor(this.cols, this.frameColumn()));
    }
    let w = Math.trunc(0.5 + (BAR_W * (this.val + 100)) / 200);
    w = Math.min(BAR_W, Math.max(0, w));
    const { x, y } = BAR_ORIGIN;
    g.fill(x, y, w, BAR_H, this.green);
    g.fill(x + w, y, BAR_W - w, BAR_H, this.red);
    if (BAR_W - w > 1) g.fill(x + w - 1, y, 1, BAR_H, "#000000");
  }
}
