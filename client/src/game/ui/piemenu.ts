/**
 * Pie menu (cTSPieMenu), the Live mode interaction menu around the sim's head.
 *
 * From the decompiled class:
 *  - items (PieMenuItem: string, optional button, enabled, angle, rectangle)
 *    are laid out around the center (Layout): with 1-2 items on 2 spokes,
 *    3-4 on 4, more on 8. Spoke directions run clockwise from straight up
 *    (+ SetFirstDirection). Up/down labels sit `spokeY` (+0x174) above/below
 *    the center, left/right ones `spokeY` beside it, diagonal ones offset by
 *    `spokeX` (+0x178) on both axes; items past the 8th stack above the top
 *    label (even) or below the bottom label (odd);
 *  - the window spans the labels, the background (+0xe4, the head backdrop
 *    kPieFaceBkg in Live mode) and the title, plus `spokeRadius` (8) and 4 px;
 *    it is centered on the click point and clamped to the screen
 *    (BeginPopupWindow);
 *  - a label is a rounded box: fill (cTSWin+0x64) inset 2 px, with two 1 px
 *    rings cut by 1 and 3 px at the corners (DrawLabelFrame), text at (3, 3)
 *    (DrawFramedLabel). Text color: lowlight, highlight for the item under the
 *    cursor, `selected` color while a mouse button is held (TSPaint);
 *  - hit testing (CalcItem): a label rectangle wins; otherwise, past the
 *    inactive radius (and inside the max radius, if any), the item of the
 *    spoke nearest the cursor direction;
 *  - releasing the button outside the inactive radius picks; releasing near
 *    the center keeps the menu open and the next click picks (TSOnMouseUpL,
 *    TSOnMouseDownL); Escape cancels (TSOnKeyDown);
 *  - SetSelection(i, true) notifies the owner (0xf pick / 0x10 cancel) and,
 *    when the popup ends on selection, ends the modal loop with i.
 *  - a popup ends on selection when its end mode (+0x170) is not 0, and
 *    takes its window down (EndPopupWindow) at PopupEnd only when it is not
 *    negative: cObjPickerTool::DoMenu pops the people pie with -1 (it stays
 *    up, re-added to the main window, while a sub pie runs) and the sub pie
 *    with 0 (MenuItemSelected ends it);
 *  - notifications go to the owner (+0x50, `onCommand`): 0xd move, 0xe
 *    highlight, 0xf pick, 0x10 cancel, 0x11 character (TSOnCharacter).
 * The 3D head (PopupHead) and the round shadow under the pie are drawn by
 * the lot view (sims/popuphead.ts); the Live mode background kPieFaceBkg is
 * fully transparent.
 */

import { soundPlayer, UI } from "../audio/index.js";
import type { GameContext } from "../context.js";
import type { FfnFont } from "../res/ffn.js";
import { TSWinBtn } from "./btn.js";
import { TSWinCtrlMgr, SYS_PIE_BKG } from "./ctrlmgr.js";
import { rgb } from "./syscolors.js";
import { Gfx, TSWin } from "./tswin.js";
import { winMgr } from "./winmgr.js";
import { getStandardCursor } from "./cursor.js";

/** Commands sent to the owner (cTSPieMenu::SetSelection / TSOnMouseMove / TSOnKeyDown). */
export const CMD_PIE_MOVE = 0xd;
export const CMD_PIE_HILITE = 0xe;
export const CMD_PIE_PICK = 0xf;
export const CMD_PIE_CANCEL = 0x10;
export const CMD_PIE_CHAR = 0x11;

/** lbl_105BD0E4 */
const MIN_DISTANCE = 1;
const QUARTER_PI = Math.PI / 4;
const TWO_PI = 2 * Math.PI;
/** Angles stored for stacked items (below / above). */
const STACK_BELOW_ANGLE = Math.PI;
const STACK_ABOVE_ANGLE = 3 * Math.PI;
/** Margin added around the layout bounds. */
const BOUNDS_MARGIN = 4;
/** Text inset inside a label, and label padding around the text. */
const LABEL_PAD = 3;

interface PieMenuItem {
  text: string;
  btn: TSWinBtn | null;
  enabled: boolean;
  angle: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export class TSPieMenu extends TSWin {
  /** cTSPieMenu+0xcc: item under the cursor, -1 for none. */
  private current = -1;
  lowlightColor = rgb(0xb9, 0xb9, 0xd0);
  highlightColor = rgb(0, 0xff, 0xff);
  selectedColor = rgb(0xff, 0xff, 0xff);
  /** cTSWin+0x64: label boxes. */
  fillColor = rgb(0x76, 0x76, 0x76);
  font: FfnFont | null = null;
  title = "";
  /** +0xe4: drawn centered (the head backdrop). */
  background: ImageBitmap | null = null;
  /** +0x50: the window notified (cmd, pie, argument); the parent when null. */
  onCommand: ((cmd: number, pie: TSPieMenu, arg: number) => boolean) | null = null;
  /** +0x14c */
  firstDirection = 0;
  /** +0x150: no spoke is picked closer than this to the center. */
  inactiveRadius = 0;
  /** +0x15c: margin around the background in the layout bounds. */
  spokeRadius = 8;
  /** +0x164: 0 = unlimited. */
  maxRadius = 0;
  /** +0x168: leaving maxRadius with nothing selected cancels. */
  autoCancel = false;
  /** +0x16c */
  clickSounds = true;
  /** +0x174 / +0x178: distance of the straight and diagonal labels. */
  spokeY = 40;
  spokeX = 20;
  /** +0x160 (SetAbbreviated): once the menu stays open, a press already picks. */
  abbreviated = true;
  onPick: ((index: number) => void) | null = null;

  private readonly items: PieMenuItem[] = [];
  private distance = 0;
  private direction = 0;
  private slots = 8;
  private bgX = 0;
  private bgY = 0;
  private bgW = 0;
  private bgH = 0;
  private titleX = 0;
  private titleY = 0;
  private titleW = 0;
  private titleH = 0;
  private popupX = 0;
  private popupY = 0;
  private centerX = 0;
  private centerY = 0;
  private winW = 0;
  private winH = 0;
  /** +0x13d / +0x13e / +0x144 */
  private tracking = false;
  private clickMode = false;
  private clamped = false;
  /** +0x170 (see the header). */
  private endMode = 1;
  /** +0x13c (GetPoppedUp) */
  private poppedUp = false;
  /** SetSubMenu / GetSubMenu */
  private subMenu: TSPieMenu | null = null;
  private inEventLoop = false;

  constructor(private readonly ctx: GameContext) {
    super();
    // cTSPieMenu::cTSPieMenu: SetCursor(GetStandardCursor(0)), the arrow over the lot view's tool cursor.
    this.winCursor = getStandardCursor(0);
  }

  /** The Live mode pie as cWinPeople::Init configures it. */
  static async forLiveMode(ctx: GameContext): Promise<TSPieMenu> {
    const mgr = await TSWinCtrlMgr.get(ctx);
    const pie = new TSPieMenu(ctx);
    pie.font = mgr.systemFont(1);
    pie.fillColor = rgb(0, 0x28, 0x8c);
    pie.highlightColor = rgb(0xff, 0xff, 0xff);
    pie.lowlightColor = rgb(0xa5, 0xc3, 0xd6);
    pie.selectedColor = rgb(0, 0xff, 0xff);
    pie.maxRadius = 150;
    pie.inactiveRadius = 35;
    pie.spokeY = 60;
    pie.spokeX = 30;
    pie.abbreviated = false;
    pie.background = await ctx.res.image("kPieFaceBkg");
    await pie.init();
    return pie;
  }

  /** cTSPieMenu::Init: default font (size 10), colors and background. */
  override async init(): Promise<boolean> {
    this.font ??= await this.ctx.fonts.acquire(10);
    if (!this.background) this.background = (await TSWinCtrlMgr.get(this.ctx)).systemBMP(SYS_PIE_BKG);
    return true;
  }

  getSelection(): number {
    return this.current;
  }

  getItemCount(): number {
    return this.items.length;
  }

  getDistance(): number {
    return this.distance;
  }

  getDirection(): number {
    return this.direction;
  }

  getInactiveRadius(): number {
    return this.inactiveRadius;
  }

  getPoppedUp(): boolean {
    return this.poppedUp;
  }

  /** +0x12c / +0x130: the window's top-left corner. */
  getPopupX(): number {
    return this.area.left;
  }

  getPopupY(): number {
    return this.area.top;
  }

  /** +0x11c / +0x120: where it was asked to pop up. */
  getPopupDownX(): number {
    return this.popupX;
  }

  getPopupDownY(): number {
    return this.popupY;
  }

  /** +0x124 / +0x128: the center, in window coordinates. */
  getPopupCenterX(): number {
    return this.centerX;
  }

  getPopupCenterY(): number {
    return this.centerY;
  }

  /** cTSPieMenu::GetCurItemCenterX: the highlighted label's center (window coordinates), 0 for none. */
  getCurItemCenterX(): number {
    const it = this.current >= 0 ? this.items[this.current] : undefined;
    return it ? it.x + Math.trunc(it.w / 2) : 0;
  }

  getCurItemCenterY(): number {
    const it = this.current >= 0 ? this.items[this.current] : undefined;
    return it ? it.y + Math.trunc(it.h / 2) : 0;
  }

  /** The label of item `i`. */
  getItemText(i: number): string {
    return this.items[i]?.text ?? "";
  }

  setSubMenu(sub: TSPieMenu | null): void {
    this.subMenu = sub;
  }

  getSubMenu(): TSPieMenu | null {
    return this.subMenu;
  }

  /** cTSPieMenu::InsertString; a button replaces the framed label. */
  insertString(text: string, btn: TSWinBtn | null = null): void {
    this.items.push({ text, btn, enabled: true, angle: 0, x: 0, y: 0, w: 0, h: 0 });
  }

  clear(): void {
    this.items.length = 0;
    this.current = -1;
  }

  enableItem(i: number, on: boolean): void {
    const it = this.items[i];
    if (it) it.enabled = on;
  }

  /** Pops up at (x, y) with `items`; `onPick` gets the item index or -1. */
  show(x: number, y: number, items: string[], onPick: (index: number) => void): void {
    this.clear();
    for (const s of items) this.insertString(s);
    this.onPick = onPick;
    this.popupBegin(x, y, !winMgr.isMouseButtonDown(), 1);
    void this.popupEventLoop().then((sel) => {
      this.popupEnd();
      this.onPick?.(sel);
    });
  }

  private textBox(text: string): { w: number; h: number } {
    const a = this.font ? this.font.textArea(text) : { w: 0, h: 0 };
    return { w: a.w + 2 * LABEL_PAD, h: a.h + 2 * LABEL_PAD };
  }

  /** cTSPieMenu::Layout: item rectangles, window size and center. */
  layout(): void {
    this.bgW = this.background?.width ?? 0;
    this.bgH = this.background?.height ?? 0;
    this.bgX = -Math.trunc(this.bgW / 2);
    this.bgY = -Math.trunc(this.bgH / 2);
    if (this.inactiveRadius === 0) {
      this.inactiveRadius = this.background ? Math.max(1, Math.trunc(Math.max(this.bgW, this.bgH) / 2)) : 8;
    }
    let minX = this.bgX - this.spokeRadius;
    let maxX = this.bgX + this.bgW + this.spokeRadius;
    let minY = this.bgY - this.spokeRadius;
    let maxY = this.bgY + this.bgH + this.spokeRadius;
    const tb = this.textBox(this.title);
    this.titleW = tb.w;
    this.titleH = tb.h;
    this.titleX = -Math.trunc(tb.w / 2);
    this.titleY = -Math.trunc(tb.h / 2);
    minX = Math.min(minX, this.titleX);
    minY = Math.min(minY, this.titleY);
    maxX = Math.max(maxX, this.titleX + tb.w);
    maxY = Math.max(maxY, this.titleY + tb.h);

    const n = this.items.length;
    this.slots = n === 0 ? 1 : n < 3 ? 2 : n < 5 ? 4 : 8;
    const A = this.spokeY;
    const B = this.spokeX;
    this.items.forEach((it, i) => {
      let w: number;
      let h: number;
      if (it.btn) {
        w = it.btn.getW();
        h = it.btn.getH();
      } else {
        const b = this.textBox(it.text);
        w = b.w;
        h = b.h;
      }
      let x = 0;
      let y = 0;
      let angle: number;
      if (i >= this.slots) {
        const k = i - this.slots;
        if (k & 1) {
          const j = k === 1 ? (this.firstDirection + 4) & 7 : i - 2;
          const ref = this.items[j]!;
          x = -Math.trunc(w / 2);
          y = ref.y + ref.h;
          angle = STACK_BELOW_ANGLE;
        } else {
          const j = k === 0 ? this.firstDirection & 7 : i - 2;
          const ref = this.items[j]!;
          x = -Math.trunc(w / 2);
          y = ref.y - h;
          angle = STACK_ABOVE_ANGLE;
        }
      } else {
        const s = this.slots === 1 ? 0 : this.slots === 2 ? i * 4 : this.slots === 4 ? i * 2 : i;
        const dir = (s + this.firstDirection) & 7;
        angle = QUARTER_PI * (2 - dir);
        while (angle < 0) angle += TWO_PI;
        switch (dir) {
          case 0:
            x = -Math.trunc(w / 2);
            y = -(A + h);
            break;
          case 1:
            x = B;
            y = -(B + h);
            break;
          case 2:
            x = A;
            y = -Math.trunc(h / 2);
            break;
          case 3:
            x = B;
            y = B;
            break;
          case 4:
            x = -Math.trunc(w / 2);
            y = A;
            break;
          case 5:
            x = -(B + w);
            y = B;
            break;
          case 6:
            x = -(A + w);
            y = -Math.trunc(h / 2);
            break;
          default:
            x = -(B + w);
            y = -(B + h);
        }
      }
      Object.assign(it, { x, y, w, h, angle });
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w);
      maxY = Math.max(maxY, y + h);
    });

    this.centerX = -(minX - BOUNDS_MARGIN);
    this.centerY = -(minY - BOUNDS_MARGIN);
    this.winW = maxX + BOUNDS_MARGIN - (minX - BOUNDS_MARGIN);
    this.winH = maxY + BOUNDS_MARGIN - (minY - BOUNDS_MARGIN);
    this.bgX += this.centerX;
    this.bgY += this.centerY;
    this.titleX += this.centerX;
    this.titleY += this.centerY;
    for (const it of this.items) {
      it.x += this.centerX;
      it.y += this.centerY;
    }
  }

  /**
   * cTSPieMenu::SetBackground + SetTitle (vtable 0x230 / 0x228) and the
   * relayout that follows (0x1c0; the whole tree is repainted every frame)
   * while popped up: the window is laid out
   * again around the same center (cObjPickerTool::MenuItemChanged swaps a
   * sub pie's backdrop for a neighbor's picture).
   */
  setBackgroundAndTitle(bg: ImageBitmap | null, title: string): void {
    if (bg === this.background && title === this.title) return;
    this.background = bg;
    this.title = title;
    this.layout();
    if (!this.poppedUp) return;
    const left = this.popupX - this.centerX;
    const top = this.popupY - this.centerY;
    this.setArea(left, top, left + this.winW, top + this.winH);
  }

  /**
   * cTSPieMenu::PopupBegin + BeginPopupWindow. `clickMode`: the button is
   * already up, so the menu stays open until a click; `endMode`: see the
   * header.
   */
  popupBegin(x: number, y: number, clickMode: boolean, endMode: number): void {
    this.inEventLoop = false;
    soundPlayer.playUISound(UI.pieAppear);
    winMgr.setCapture(this);
    this.poppedUp = true;
    this.popupX = x;
    this.popupY = y;
    this.clickMode = clickMode;
    this.endMode = endMode;
    this.tracking = true;
    this.clamped = false;
    this.layout();
    this.showWindow();
    const sw = winMgr.main.getW();
    const sh = winMgr.main.getH();
    let left = this.popupX - this.centerX;
    let top = this.popupY - this.centerY;
    if (left < 0) {
      left = 0;
      this.clamped = true;
    } else if (sw <= left + this.winW) {
      left = sw - this.winW;
      this.clamped = true;
    }
    if (top < 0) {
      top = 0;
      this.clamped = true;
    } else if (sh <= top + this.winH) {
      top = sh - this.winH;
      this.clamped = true;
    }
    // The original also warps the cursor to the moved center (SetCursorPos);
    // browsers cannot, so the cursor keeps its place.
    if (this.clamped) {
      this.popupX = left + this.centerX;
      this.popupY = top + this.centerY;
    }
    this.setArea(left, top, left + this.winW, top + this.winH);
    for (const it of this.items) {
      const b = it.btn;
      if (!b) continue;
      b.setArea(left + it.x, top + it.y, left + it.x + b.getW(), top + it.y + b.getH());
      b.setEnabled(it.enabled);
      winMgr.main.childAdd(b);
    }
    this.current = -1;
    const c = winMgr.cursorPosition();
    this.tsOnMouseMove(c.x - left, c.y - top);
    this.setSelection(this.current, false);
  }

  /** cTSPieMenu::PopupEventLoop: runs until the popup ends; resolves with the selection. */
  popupEventLoop(): Promise<number> {
    this.inEventLoop = true;
    return winMgr.doModalWin(this);
  }

  /** cTSPieMenu::PopupEnd */
  popupEnd(): void {
    winMgr.releaseCapture(this);
    if (this.endMode >= 0) this.endPopupWindow();
  }

  /** cTSPieMenu::EndPopupWindow */
  endPopupWindow(): void {
    for (const it of this.items) if (it.btn) winMgr.main.childRemove(it.btn);
    this.poppedUp = false;
  }

  /** cTSPieMenu::EndPopup: the event loop returns `sel`. */
  endPopup(sel = this.current): void {
    if (!this.inEventLoop) {
      this.popupEnd();
      return;
    }
    winMgr.endDialog(this, sel);
    this.poppedUp = false;
    this.tracking = false;
  }

  /** Sends `cmd` to the owner (cTSPieMenu+0x50), else to the parent. */
  private notify(cmd: number, arg = 0): boolean {
    if (this.onCommand) return this.onCommand(cmd, this, arg);
    return this.parent?.tsOnCommand(cmd, this) ?? false;
  }

  /** cTSPieMenu::SetSelection */
  setSelection(sel: number, pick: boolean): void {
    if (sel !== -1 && (sel < 0 || sel >= this.items.length)) sel = Math.max(0, Math.min(this.items.length - 1, sel));
    this.current = sel;
    this.notify(CMD_PIE_HILITE);
    if (!pick) return;
    this.notify(this.current === -1 ? CMD_PIE_CANCEL : CMD_PIE_PICK);
    if (this.endMode !== 0) this.endPopup();
  }

  /** cTSPieMenu::CalcItem: item under (x, y) in window coordinates, or -1. */
  calcItem(x: number, y: number): number {
    const n = this.items.length;
    if (n === 0) return -1;
    const dx = x + this.area.left - this.popupX;
    const dy = y + this.area.top - this.popupY;
    this.distance = Math.sqrt(dx * dx + dy * dy);
    if (this.distance < MIN_DISTANCE) return -1;
    this.direction = Math.atan2(dx, -dy);
    for (let i = 0; i < n; i++) {
      const it = this.items[i]!;
      if (it.enabled && it.x <= x && x < it.x + it.w && it.y <= y && y < it.y + it.h) return i;
    }
    if (this.distance <= this.inactiveRadius) {
      this.direction = 0;
      return -1;
    }
    if (this.maxRadius !== 0 && this.distance > this.maxRadius) return -1;
    let f = 0.5 + (this.direction - QUARTER_PI * this.firstDirection) * (this.slots / TWO_PI);
    while (f >= this.slots) f -= this.slots;
    while (f < 0) f += this.slots;
    let i = Math.trunc(f);
    if (i >= n) i = -1;
    if (i !== -1 && !this.items[i]!.enabled) i = -1;
    return i;
  }

  override tsOnMouseMove(x: number, y: number): boolean {
    if (!this.tracking) return true;
    if (this.clamped) {
      const c = winMgr.cursorPosition();
      x = c.x - this.area.left;
      y = c.y - this.area.top;
    }
    const prev = this.current;
    this.current = this.calcItem(x, y);
    if (this.current !== prev) {
      if (prev !== -1) this.items[prev]?.btn?.setState(0);
      if (this.current >= 0) {
        this.items[this.current]?.btn?.setState(1);
        soundPlayer.playUISound(UI.pieHighlight);
      }
      this.setSelection(this.current, false);
    }
    if (this.autoCancel && this.maxRadius && this.current === -1 && this.maxRadius < this.distance) {
      this.setSelection(-1, true);
    }
    this.notify(CMD_PIE_MOVE);
    return true;
  }

  override tsOnMouseUpL(x: number, y: number): boolean {
    this.tsOnMouseMove(x, y);
    if (this.tracking) {
      if (!this.clickMode && !this.clamped && this.distance <= this.inactiveRadius) {
        this.clickMode = true;
      } else if (!this.clickMode && this.clamped) {
        this.clickMode = true;
      } else {
        const sel = this.current;
        this.setSelection(sel, true);
        if (sel >= 0) this.items[sel]?.btn?.setState(0);
      }
    }
    this.clamped = false;
    return true;
  }

  override tsOnMouseDownL(x: number, y: number): boolean {
    if (this.clickMode && this.abbreviated) this.tsOnMouseUpL(x, y);
    else this.tsOnMouseMove(x, y);
    if (this.current >= 0) soundPlayer.playUISound(UI.pieSelect);
    return true;
  }

  override tsOnMouseDownR(x: number, y: number): boolean {
    return this.tsOnMouseDownL(x, y);
  }

  override tsOnMouseUpR(x: number, y: number): boolean {
    return this.tsOnMouseUpL(x, y);
  }

  /** cTSPieMenu::TSOnKeyDown (Escape cancels) and TSOnCharacter (0x11 to the owner). */
  override tsOnKeyDown(key: string): boolean {
    if (key === "Escape") {
      this.current = -1;
      this.notify(CMD_PIE_CANCEL);
      this.endPopup();
      return true;
    }
    const c = key === "Tab" ? 9 : key.length === 1 ? key.charCodeAt(0) : -1;
    return c >= 0 && this.notify(CMD_PIE_CHAR, c);
  }

  /** cTSPieMenu::DrawLabelFrame: a box with two 1 px rings rounded at the corners. */
  private drawLabelFrame(g: Gfx, color: string, x: number, y: number, w: number, h: number): void {
    const l = x + 2;
    const t = y + 2;
    const r = x + w - 2;
    const b = y + h - 2;
    g.fill(l, t, r - l, b - t, color);
    for (let i = 1; i <= 2; i++) {
      const k = i === 1 ? 1 : 3;
      g.fill(l + k, t - i, r - l - 2 * k, 1, color);
      g.fill(l + k, b + i - 1, r - l - 2 * k, 1, color);
      g.fill(l - i, t + k, 1, b - t - 2 * k, color);
      g.fill(r + i - 1, t + k, 1, b - t - 2 * k, color);
    }
  }

  /** cTSPieMenu::DrawFramedLabel */
  private drawFramedLabel(g: Gfx, text: string, color: string, x: number, y: number, w: number, h: number): void {
    this.drawLabelFrame(g, this.fillColor, x, y, w, h);
    this.font?.drawText(g.ctx, text, g.ox + x + LABEL_PAD, g.oy + y + LABEL_PAD, color);
  }

  override tsPaint(g: Gfx): void {
    if (this.background) g.blit(this.background, this.bgX, this.bgY);
    if (this.title) {
      this.drawFramedLabel(g, this.title, this.selectedColor, this.titleX, this.titleY, this.titleW, this.titleH);
    }
    const down = winMgr.isMouseButtonDown();
    this.items.forEach((it, i) => {
      if (it.btn || !it.enabled) return;
      const color = this.current === i ? (down ? this.selectedColor : this.highlightColor) : this.lowlightColor;
      this.drawFramedLabel(g, it.text, color, it.x, it.y, it.w, it.h);
    });
  }
}
