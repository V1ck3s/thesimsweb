/**
 * cWinPersonalityWidget: one personality trait of Create-a-Sim, a caption
 * on each side of a 10-step LED bar (kDesignCharPersLED).
 *
 * From the decompiled class:
 *  - ComputeLayout: the LED's top-left (SetLEDTopLeft) stays put; the window
 *    spans from (led.x - (minCaptionWidth + 10) - 4) to (led.x + ledWidth +
 *    maxCaptionWidth + 4), height max(ledHeight, captionHeight) + 4. The min
 *    caption is drawn at (2, 0), the max caption at (led.x + ledWidth + 2, 0)
 *    (window coordinates);
 *  - TSPaint: both captions in the button font, colored with the hilite
 *    color of the current frame (cTSFrameWork_CtrlMgr hilite table), then
 *    the first value * 6 pixels of the LED bitmap;
 *  - TSOnMouseDownL: a click left of the lit part (TSOnMouseMove keeps the
 *    side, +0x1c0) takes a point back (value - 1, owner's points + 1), a
 *    click right of it spends one (refused with "UI_nhood_error" when no
 *    point is left); both play "UI_CAC_personpts" and call the owner's
 *    PrepareButtons. A double click is a click.
 */

import type { GameContext } from "../context.js";
import type { FfnFont } from "../res/ffn.js";
import { TSWinBtn } from "../ui/btn.js";
import { hiliteColor } from "../ui/syscolors.js";
import type { Gfx } from "../ui/tswin.js";

/** lbl_105BC75C */
const SOUND_POINTS = "UI_CAC_personpts";
const SOUND_ERROR = "UI_nhood_error";
/** Pixels of LED per point. */
const LED_STEP = 6;

/** What the widget needs from cWinDesignCharacter. */
export interface PersonalityOwner {
  /** cWinDesignCharacter+0x11c: points left to spend. */
  pointsLeft: number;
  prepareButtons(): void;
}

export class WinPersonalityWidget extends TSWinBtn {
  private value = 0;
  private led: ImageBitmap | null = null;
  private minCaption = "";
  private maxCaption = "";
  private ledX = 0;
  private ledY = 0;
  private minPos = { x: 0, y: 0 };
  private maxPos = { x: 0, y: 0 };
  /** +0x1c0: the cursor is right of the lit part (a click adds a point). */
  private increase = true;

  constructor(
    private readonly ctx: GameContext,
    private readonly owner: PersonalityOwner,
  ) {
    // SetImage(0, 4, 0): no bitmap, four frame columns for the caption colors.
    super(0, null, 4, 1);
  }

  override async init(): Promise<boolean> {
    this.led = await this.ctx.res.image("kDesignCharPersLED");
    return true;
  }

  setFont(font: FfnFont): void {
    this.font = font;
  }

  setMinCaption(s: string): void {
    this.minCaption = s;
    this.computeLayout();
  }

  setMaxCaption(s: string): void {
    this.maxCaption = s;
    this.computeLayout();
  }

  setLEDTopLeft(x: number, y: number): void {
    this.ledX = x;
    this.ledY = y;
    this.computeLayout();
  }

  getValue(): number {
    return this.value;
  }

  setValue(v: number): void {
    this.value = Math.max(0, Math.min(10, v));
  }

  /** cWinPersonalityWidget::ComputeLayout */
  private computeLayout(): void {
    const font = this.font;
    if (!font) return;
    const minW = font.textArea(this.minCaption).w;
    const maxW = font.textArea(this.maxCaption).w;
    const ledW = this.led?.width ?? 0;
    const ledH = this.led?.height ?? 0;
    const left = this.ledX - (minW + 10) - 4;
    const right = maxW + this.ledX + ledW + 4;
    const top = this.area.top;
    const bottom = top + Math.max(ledH + 4, font.height + 4);
    this.minPos = { x: 2, y: 0 };
    this.maxPos = { x: this.ledX + ledW + 2 - left, y: 0 };
    this.setArea(left, top, right, bottom);
  }

  override tsOnMouseMove(x: number, y: number): boolean {
    const ledW = this.led?.width ?? 0;
    if (this.value === 0) this.increase = true;
    else if (this.value === 10) this.increase = false;
    else this.increase = this.ledX - this.area.left + this.value * Math.trunc(ledW / 10) < x;
    return super.tsOnMouseMove(x, y);
  }

  override tsOnMouseDownL(x = 0, y = 0): boolean {
    this.tsOnMouseMove(x, y);
    super.tsOnMouseDownL();
    if (!this.enabled) return true;
    if (!this.increase) {
      if (this.value > 0) {
        this.setValue(this.value - 1);
        this.owner.pointsLeft++;
        this.owner.prepareButtons();
        TSWinBtn.uiSoundHook?.(SOUND_POINTS);
      }
    } else if (this.value < 10) {
      if (this.owner.pointsLeft === 0) {
        TSWinBtn.uiSoundHook?.(SOUND_ERROR);
      } else {
        this.setValue(this.value + 1);
        this.owner.pointsLeft--;
        this.owner.prepareButtons();
        TSWinBtn.uiSoundHook?.(SOUND_POINTS);
      }
    }
    return true;
  }

  override tsPaint(g: Gfx): void {
    const font = this.font;
    if (font) {
      const color = hiliteColor(4, this.frameColumn());
      font.drawText(g.ctx, this.minCaption, g.ox + this.minPos.x, g.oy + this.minPos.y, color);
      font.drawText(g.ctx, this.maxCaption, g.ox + this.maxPos.x, g.oy + this.maxPos.y, color);
    }
    const led = this.led;
    if (led && this.value > 0) {
      const w = Math.min(led.width, this.value * LED_STEP);
      g.blitPart(led, 0, 0, w, led.height, this.ledX - this.area.left, this.ledY - this.area.top);
    }
  }
}
