/**
 * Bitmap button (cTSWinBtn).
 *
 * The image holds `cols` frames side by side (and optionally `rows` variants
 * stacked). The frame column comes from cTSWinBtn::CalcRowCol:
 *   1 col : always 0
 *   2 cols: 1 when enabled and (pressed or hovered), else 0
 *   4 cols: 0 normal, 1 pressed/selected, 2 hovered, 3 disabled
 *   6 cols: like 4, plus 3 = selected+hovered, 4/5 = disabled (unselected/selected)
 *   3/5   : bit 0 = pressed, bit 1 = hovered; disabled = 4/5 when cols > 4
 *
 * Modes (cTSWinBtn+0xf0): PUSH is momentary, TOGGLE flips on release,
 * TOGGLE_ON_DOWN flips on press. The command fires on release unless
 * `sendOnDown`, and only if the cursor is still over the button.
 */

import type { FfnFont } from "../res/ffn.js";
import { Gfx, TSWin, WF_HIT_ALPHA, type Rect } from "./tswin.js";
import { winMgr } from "./winmgr.js";

export const BTN_PUSH = 0;
export const BTN_TOGGLE = 1;
export const BTN_TOGGLE_ON_DOWN = 2;

/** cTSWinBtn::Action: when a button plays its UI sound (bit mask, +0x148). */
export const UISOUND_DOWN = 1;
export const UISOUND_UP = 2;
export const UISOUND_ENTER = 4;
export const UISOUND_DISABLED = 8;

/** cTSWinBtn::SendButtonCommand ids besides the click: the async timer expired / the cursor left an armed button. */
export const CMD_ASYNC_TIMEOUT = 0x13;
export const CMD_ASYNC_EXIT = 0x14;

/** cTSWinBtn+0x14c: what arms the async timer (enter, press, release). */
export const ASYNC_ON_ENTER = 1;
export const ASYNC_ON_DOWN = 2;
export const ASYNC_ON_UP = 4;

/** Defaults of cTSWinBtn::OverrideDefaultUISound(0, 0, 0, 0) (lbl_105BB350..5C). */
const DEFAULT_UI_SOUNDS = { enter: "", down: "UI_click", up: "", disabled: "UI_error" };

export class TSWinBtn extends TSWin {
  /**
   * PlaySoundA: how a button plays its sound event (cSoundPlayer::PlayBySource
   * with source -4). Installed by the sound player; buttons stay silent without it.
   */
  static uiSoundHook: ((event: string) => void) | null = null;
  private static defaultUISounds = { ...DEFAULT_UI_SOUNDS };

  /** cTSWinBtn::OverrideDefaultUISound: a null/empty argument restores that default. */
  static overrideDefaultUISound(enter?: string | null, down?: string | null, up?: string | null, disabled?: string | null): void {
    TSWinBtn.defaultUISounds = {
      enter: enter || DEFAULT_UI_SOUNDS.enter,
      down: down || DEFAULT_UI_SOUNDS.down,
      up: up || DEFAULT_UI_SOUNDS.up,
      disabled: disabled || DEFAULT_UI_SOUNDS.disabled,
    };
  }

  /** +0x148: actions that play a sound (constructor default 9 = down | disabled). */
  uiSoundActions = UISOUND_DOWN | UISOUND_DISABLED;
  /** +0x178..0x184: per-button sound events (OverrideUISound); null = the default. */
  private uiSounds: { enter: string | null; down: string | null; up: string | null; disabled: string | null } = {
    enter: null,
    down: null,
    up: null,
    disabled: null,
  };

  image: ImageBitmap | null = null;
  cols = 1;
  rows = 1;
  row = 0;
  /** 0 = up, 1 = down/selected. */
  state = 0;
  enabled = true;
  entered = false;
  mode = BTN_PUSH;
  sendOnDown = false;
  caption = "";
  font: FfnFont | null = null;
  captionColor = "#ffffff";
  /** cTSWinBtn::SetCustomHiliteColors: caption color per frame column (overrides captionColor). */
  hiliteColors: string[] | null = null;
  /** cTSWinBtn::SetTextAlignment (+0x15c): 0 left, 1 centered, 2 right. */
  textAlignment = 1;
  onClick: ((btn: TSWinBtn) => void) | null = null;
  private changedOnDown = false;
  /**
   * The async timer (+0x14c flags, +0x150 timeout, +0x154 start, +0x164
   * armed): entering (ASYNC_ON_ENTER), pressing (ON_DOWN | ON_UP) or
   * releasing (ON_UP) arms it; once `asyncTimeout` ms have passed the button
   * sends CMD_ASYNC_TIMEOUT to its parent (cTSWinBtn::TSPaint), and leaving
   * it sends CMD_ASYNC_EXIT (TSOnMouseExit). The panels' SetQuickTips set it
   * from the quick tips option (cTSWinBtn::GetDefaultAsyncTimeout).
   */
  asyncFlags = 0;
  asyncTimeout = 0;
  private asyncTimerArmed = false;
  private asyncTimerStart = 0;

  constructor(id = 0, image: ImageBitmap | null = null, cols = 1, rows = 1) {
    super();
    this.id = id;
    if (image) this.setImage(image, cols, rows);
  }

  /** cTSWinBtn::SetImage: the window takes one frame's size. */
  setImage(image: ImageBitmap, cols: number, rows = 1): void {
    this.image = image;
    this.hitImage = null;
    this.cols = cols;
    this.rows = rows;
    const w = Math.floor(image.width / cols);
    const h = Math.floor(image.height / rows);
    this.setArea(this.area.left, this.area.top, this.area.left + w, this.area.top + h);
  }

  /** +0xd4 foreground bitmap, +0x124 its offset, +0x12c..+0x138 its source rectangle (all of it by default). */
  private foreground: { image: ImageBitmap; x: number; y: number; src: Rect } | null = null;

  /**
   * cTSWinBtn::SetForeground(buffer, point): a bitmap drawn over the frame at
   * `point` (ForegroundBlt, after the image and the caption); null removes it.
   * `src` is the part shown (the caller's +0x12c..+0x138), the whole bitmap by default.
   */
  setForeground(image: ImageBitmap | null, x = 0, y = 0, src: Rect | null = null): void {
    this.foreground = image ? { image, x, y, src: src ?? { left: 0, top: 0, right: image.width, bottom: image.height } } : null;
  }

  /** cTSWinBtn::OverrideUISound (enter, down, up, disabled). */
  overrideUISound(enter?: string | null, down?: string | null, up?: string | null, disabled?: string | null): void {
    this.uiSounds = { enter: enter ?? null, down: down ?? null, up: up ?? null, disabled: disabled ?? null };
  }

  /** cTSWinBtn::PlayUISound */
  playUISound(action: number): void {
    if ((action & this.uiSoundActions) === 0) return;
    const key = action === UISOUND_ENTER ? "enter" : action === UISOUND_DOWN ? "down" : action === UISOUND_UP ? "up" : action === UISOUND_DISABLED ? "disabled" : null;
    if (!key) return;
    const name = this.uiSounds[key] ?? TSWinBtn.defaultUISounds[key];
    if (name) TSWinBtn.uiSoundHook?.(name);
  }

  /** The panels' SetQuickTips pattern: flags only when a timeout is set; the timer is disarmed. */
  setAsync(flags: number, timeout: number): void {
    this.asyncFlags = timeout === 0 ? 0 : flags;
    this.asyncTimeout = timeout;
    this.asyncTimerArmed = false;
  }

  private armAsyncTimer(): void {
    this.asyncTimerArmed = true;
    this.asyncTimerStart = performance.now();
  }

  setState(s: number): void {
    this.state = s;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  frameColumn(): number {
    const s = this.state !== 0;
    const e = this.entered;
    switch (this.cols) {
      case 0:
      case 1:
        return 0;
      case 2:
        return this.enabled && (s || e) ? 1 : 0;
      case 4:
      case 6:
        if (!this.enabled) return this.cols === 4 ? 3 : s ? 5 : 4;
        if (!s) return e ? 2 : 0;
        return this.cols === 6 && e ? 3 : 1;
      default:
        if (!this.enabled) return this.cols > 4 ? (s ? 5 : 4) : 0;
        return (s ? 1 : 0) | (e ? 2 : 0);
    }
  }

  override tsPaint(g: Gfx): void {
    if (this.image) {
      const w = this.getW();
      const h = this.getH();
      g.blitPart(this.image, this.frameColumn() * w, this.row * h, w, h, 0, 0);
    }
    if (this.caption && this.font) {
      const tw = this.font.stringWidth(this.caption);
      const x = this.textAlignment === 0 ? 0 : this.textAlignment === 2 ? this.getW() - tw : (this.getW() - tw) >> 1;
      const y = (this.getH() - this.font.height) >> 1;
      const color = this.hiliteColors?.[this.frameColumn()] ?? this.captionColor;
      this.font.drawText(g.ctx, this.caption, g.ox + x, g.oy + y, color);
    }
    // cTSWinBtn::ForegroundBlt
    const fg = this.foreground;
    if (fg) {
      const { src } = fg;
      g.blitPart(fg.image, src.left, src.top, src.right - src.left, src.bottom - src.top, fg.x, fg.y);
    }
  }

  /** cTSWinBtn::IsPointInWindowWindowCoordinates: the image is only tested with tWinFlag 0x200. */
  protected override isPointTransparent(x: number, y: number): boolean {
    if (!this.image || !this.getFlag(WF_HIT_ALPHA)) return false;
    // Test against the current frame of the button image.
    if (!this.hitImage) this.hitImage = this.image;
    return super.isPointTransparent(x + this.frameColumn() * this.getW(), y + this.row * this.getH());
  }

  override tsOnMouseEnter(): void {
    this.entered = true;
    if (this.enabled) this.playUISound(UISOUND_ENTER);
    // cTSWinBtn::TSOnMouseEnter: back over the button it holds, toggle-on-down flips
    // again, push and toggle show "down".
    if (winMgr.getCapture() === this) {
      if (this.mode === BTN_TOGGLE_ON_DOWN) this.state = this.state ? 0 : 1;
      else if (this.mode === BTN_PUSH || this.mode === BTN_TOGGLE) this.state = 1;
    }
    if (this.asyncFlags & ASYNC_ON_ENTER && !this.asyncTimerArmed) this.armAsyncTimer();
  }

  override tsOnMouseExit(): void {
    this.entered = false;
    // cTSWinBtn::TSOnMouseExit: dragged off the button it holds (unless it fires on
    // press), toggle-on-down flips back, push goes up, toggle flips back when the
    // press changed it.
    if (winMgr.getCapture() === this && !this.sendOnDown) {
      if (this.mode === BTN_TOGGLE_ON_DOWN) this.state = this.state ? 0 : 1;
      else if (this.mode === BTN_PUSH) this.state = 0;
      else if (this.mode === BTN_TOGGLE && this.changedOnDown) this.state = this.state ? 0 : 1;
    }
    if (this.asyncTimerArmed || this.asyncFlags & ASYNC_ON_ENTER) {
      this.asyncTimerArmed = false;
      this.parent?.tsOnCommand(CMD_ASYNC_EXIT, this);
    }
  }

  override tsOnMouseMove(x: number, y: number): boolean {
    if (winMgr.getCapture() === this) this.entered = this.isPointInWindowWindowCoordinates(x, y);
    return true;
  }

  /** cTSWinBtn::TSOnSetFocus: the focus goes on to the parent when it accepts it. */
  override tsOnSetFocus(): void {
    winMgr.offerFocus(this.parent);
  }

  override tsOnMouseDownL(): boolean {
    if (!this.enabled) {
      this.playUISound(UISOUND_DISABLED);
      return true;
    }
    this.playUISound(UISOUND_DOWN);
    winMgr.setCapture(this);
    const before = this.state;
    if (this.mode === BTN_TOGGLE_ON_DOWN) this.state = this.state ? 0 : 1;
    else if (this.mode === BTN_PUSH || this.mode === BTN_TOGGLE) this.state = 1;
    this.changedOnDown = before !== this.state;
    if (this.sendOnDown) this.fire();
    if (this.asyncFlags & (ASYNC_ON_DOWN | ASYNC_ON_UP)) this.armAsyncTimer();
    else this.asyncTimerArmed = false;
    return true;
  }

  override tsOnMouseUpL(x: number, y: number): boolean {
    if (this.asyncFlags & ASYNC_ON_UP) this.armAsyncTimer();
    else this.asyncTimerArmed = false;
    if (winMgr.getCapture() !== this) return true;
    winMgr.releaseCapture(this);
    this.entered = this.isPointInWindowWindowCoordinates(x, y);
    if (this.mode === BTN_PUSH) {
      this.state = 0;
    } else if (this.mode === BTN_TOGGLE && !this.sendOnDown) {
      // cTSWinBtn::TSOnMouseUpL, mode 1: a press that changed the state is undone on
      // release (the command handler sets it); an already selected button stays as it is.
      // Buttons that fire on press keep their state (cTSWinBtn+0xec == 1).
      if (this.changedOnDown) this.state = this.state === 0 ? 1 : 0;
    }
    if (!this.sendOnDown && this.entered) {
      this.fire();
      this.playUISound(UISOUND_UP);
    }
    return true;
  }

  /** The async part of cTSWinBtn::TSPaint (only while the button is shown). */
  override pump(nowMs: number): void {
    super.pump(nowMs);
    if (this.asyncTimerArmed && nowMs - this.asyncTimerStart > this.asyncTimeout && this.isVisibleAndAllParentsVisible()) {
      this.asyncTimerArmed = false;
      this.parent?.tsOnCommand(CMD_ASYNC_TIMEOUT, this);
    }
  }

  /** lbl_105BA498: the last button that sent its command on a click (Tut_CheckForEvents reads it). */
  static lastPressed: TSWinBtn | null = null;

  private fire(): void {
    TSWinBtn.lastPressed = this;
    this.onClick?.(this);
    this.parent?.tsOnCommand(this.id, this);
  }
}
