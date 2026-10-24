/**
 * Scrolling text list (cTSWinTextList).
 *
 * From the decompiled class:
 *  - every row is a cTSWinBtn without image (4 frame columns, toggle mode,
 *    fires on press) whose caption is drawn left-aligned by DrawTextPara in a
 *    (0, 0, width, rowHeight) box, colored by cTSWinBtn::GetHiliteColor: normal,
 *    selected (cyan), hovered (white) (insert);
 *  - row height = font height + 3; the list is `visibleRows` rows high (Init);
 *  - a vertical cTSWinScrollbar (kSMSystemScrollbar) sits at
 *    x = width - scrollbarImage.height and only shows when there are more rows
 *    than fit; rows are that much narrower;
 *  - scrolling is animated at constant speed: rows/ms =
 *    clamp(k * |distance| + 4 - k, 4, 60) / 1000 with k = 56 / (2 * visibleRows - 1)
 *    (ScrollTo), the top row and a sub-row pixel offset follow the ramp
 *    (TSPaint, TileItems);
 *  - PageUp/PageDown/End/Home/arrows move the selection (TSOnKeyDown), typing a
 *    letter selects the first row starting with it or the closest before
 *    (TSOnCharacter);
 *  - selecting notifies the parent with command 0x15 (the row index is
 *    `getSelection()`).
 * The list draws into a private buffer in the original: rows are clipped to it.
 */

import type { FfnFont } from "../res/ffn.js";
import { ALIGN_LEFT } from "../res/ffn.js";
import { BTN_TOGGLE, TSWinBtn } from "./btn.js";
import { SYS_SCROLLBAR, TSWinCtrlMgr } from "./ctrlmgr.js";
import type { GameContext } from "../context.js";
import { TSWinScrollbar } from "./scrollbar.js";
import { CMD_SLIDER_CHANGED, SLIDER_VERTICAL } from "./slider.js";
import { hiliteColor } from "./syscolors.js";
import { Gfx, TSWin } from "./tswin.js";

/** Command sent to the parent when the selection changes. */
export const CMD_LIST_SELECT = 0x15;

/** cTSWinTextList::ScrollTo constants (lbl_105BD110). */
const SPEED_SPAN = 56;
const SPEED_MIN = 4;
const SPEED_MAX = 60;
const SPEED_UNIT = 0.001;

/** A row: cTSWinBtn with the custom text rectangle set by insert. */
class TextListItem extends TSWinBtn {
  constructor(
    caption: string,
    font: FfnFont,
    private readonly rowHeight: number,
  ) {
    super();
    this.caption = caption;
    this.font = font;
    this.cols = 4;
    this.mode = BTN_TOGGLE;
    this.sendOnDown = true;
  }

  override tsPaint(g: Gfx): void {
    if (!this.font) return;
    const rect = { left: g.ox, top: g.oy, right: g.ox + this.getW(), bottom: g.oy + this.rowHeight };
    this.font.drawTextPara(g.ctx, rect, this.caption, ALIGN_LEFT, hiliteColor(4, this.frameColumn()));
  }
}

export class TSWinTextList extends TSWin {
  /** +0xe0: rows shown; set before init(). */
  visibleRows = 0;
  fillColor = "#000000";
  onSelect: ((index: number, list: TSWinTextList) => void) | null = null;
  private readonly items: TextListItem[] = [];
  private scrollbar: TSWinScrollbar | null = null;
  private scrollImage: ImageBitmap | null = null;
  private font: FfnFont | null = null;
  private topRow = 0;
  private rowHeight = 0;
  private pixelOffset = 0;
  private selected = -1;
  private animating = false;
  private rampFrom = 0;
  private rampTo = 0;
  private rampStart = 0;
  private rampEnd = 0;

  constructor(private readonly ctx: GameContext) {
    super();
  }

  setFont(font: FfnFont): void {
    this.font = font;
    this.rowHeight = font.height + 3;
  }

  override async init(): Promise<boolean> {
    if (!this.font) return false;
    const mgr = await TSWinCtrlMgr.get(this.ctx);
    this.scrollImage = mgr.systemBMP(SYS_SCROLLBAR);
    this.rowHeight = this.font.height + 3;
    const sb = new TSWinScrollbar();
    sb.setArea(0, 0, 1, this.rowHeight * this.visibleRows);
    sb.setDirection(SLIDER_VERTICAL);
    sb.setImage(this.scrollImage);
    const x = this.getW() - this.scrollImage.height;
    sb.setArea(x, 0, x + sb.getW(), sb.getH());
    this.scrollbar = sb;
    this.childAdd(sb);
    this.updateScrollbar();
    this.setArea(this.area.left, this.area.top, this.area.right, this.area.top + this.rowHeight * this.visibleRows);
    this.setTopRow(0);
    return true;
  }

  size(): number {
    return this.items.length;
  }

  get(i: number): string {
    return this.items[i]?.caption ?? "";
  }

  getSelection(): number {
    return this.selected;
  }

  push(text: string): void {
    this.insert(this.items.length, text);
  }

  /** cTSWinTextList::insert */
  insert(index: number, text: string): void {
    if (!this.font || !this.scrollImage) throw new Error("TSWinTextList.insert before init");
    const item = new TextListItem(text, this.font, this.rowHeight);
    const w = this.getW() - this.scrollImage.height;
    item.setArea(0, 0, w, this.rowHeight);
    this.childAdd(item);
    this.items.splice(index, 0, item);
    if (this.selected !== -1 && index <= this.selected) this.selected++;
    this.updateScrollbar();
    this.tileItems();
  }

  /** cTSWinTextList::erase */
  erase(index: number): void {
    const item = this.items[index];
    if (!item) return;
    if (this.selected === index) {
      this.selected = -1;
      this.notifySelect();
    }
    this.items.splice(index, 1);
    this.childDelete(item);
    this.updateScrollbar();
    const n = this.items.length;
    if (this.visibleRows < n && n - this.visibleRows <= this.topRow) this.topRow--;
    if (n <= this.visibleRows) this.topRow = 0;
    this.setTopRow(this.topRow);
  }

  clear(): void {
    this.selected = -1;
    while (this.items.length) this.erase(0);
  }

  /** cTSWinTextList::select: selects, scrolls it into view and notifies. */
  select(index: number): void {
    if (this.selected !== -1) this.items[this.selected]?.setState(0);
    this.selected = index < 0 || index >= this.items.length ? -1 : index;
    const s = this.selected;
    if (s !== -1) {
      if (s < this.topRow) {
        this.scrollTo(s);
        this.scrollbar?.setValue(s);
      } else if (this.topRow + this.visibleRows <= s) {
        this.scrollTo(s - this.visibleRows + 1);
        this.scrollbar?.setValue(s - this.visibleRows + 1);
      }
      this.items[s]!.setState(1);
      this.notifySelect();
    }
  }

  setTopRow(row: number): void {
    this.topRow = row;
    this.tileItems();
  }

  private notifySelect(): void {
    this.onSelect?.(this.selected, this);
    this.parent?.tsOnCommand(CMD_LIST_SELECT, this);
  }

  private updateScrollbar(): void {
    const sb = this.scrollbar;
    if (!sb) return;
    if (this.visibleRows < this.items.length) {
      sb.showWindow();
      sb.setMinimumValue(0);
      sb.setMaximumValue(this.items.length - this.visibleRows);
      sb.setValue(this.topRow);
      sb.setPageSize(this.visibleRows);
    } else {
      sb.hideWindow();
    }
  }

  /** cTSWinTextList::ScrollTo: start a constant-speed ramp toward `row`. */
  scrollTo(row: number): void {
    const now = performance.now();
    const k = SPEED_SPAN / (this.visibleRows * 2 - 1);
    let from: number;
    if (!this.animating) {
      this.animating = true;
      from = this.topRow;
    } else {
      from = this.rampValue(now);
    }
    const speed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, k * Math.abs(from - row) + (SPEED_MIN - k))) * SPEED_UNIT;
    this.rampFrom = from;
    this.rampTo = row;
    this.rampStart = now;
    this.rampEnd = now + Math.abs(row - from) / speed;
  }

  private rampValue(now: number): number {
    if (now >= this.rampEnd) return this.rampTo;
    return this.rampFrom + ((this.rampTo - this.rampFrom) * (now - this.rampStart)) / (this.rampEnd - this.rampStart);
  }

  /** cTSWinTextList::TileItems: rows stacked from the (fractional) top row. */
  private tileItems(): void {
    let y = -this.topRow * this.rowHeight + this.pixelOffset;
    for (const item of this.items) {
      if (!item.isVisible()) continue;
      item.moveTo(0, y);
      y += this.rowHeight;
    }
  }

  override pump(nowMs: number): void {
    super.pump(nowMs);
    if (!this.animating) return;
    const v = this.rampValue(nowMs);
    let row = Math.trunc(v + 0.5);
    let off = Math.trunc((v - row) * this.rowHeight + 0.5);
    if (this.rowHeight <= off) {
      off = 0;
      row++;
    }
    this.pixelOffset = -off;
    this.setTopRow(row);
    if (nowMs >= this.rampEnd) this.animating = false;
  }

  override tsPaint(g: Gfx): void {
    g.fill(0, 0, this.getW(), this.getH(), this.fillColor);
  }

  override plot(ctx: CanvasRenderingContext2D, ox: number, oy: number): void {
    if (!this.isVisible()) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox + this.area.left, oy + this.area.top, this.getW(), this.getH());
    ctx.clip();
    super.plot(ctx, ox, oy);
    ctx.restore();
  }

  /** Rows scrolled out of the private buffer cannot be hit. */
  override windowFromPoint(x: number, y: number): TSWin | null {
    if (x < 0 || y < 0 || x >= this.getW() || y >= this.getH()) return null;
    return super.windowFromPoint(x, y);
  }

  override tsOnCommand(cmd: number, source: TSWin): boolean {
    if (cmd === CMD_SLIDER_CHANGED && source === this.scrollbar) {
      this.scrollTo(this.scrollbar.getValue());
      return true;
    }
    const i = this.items.indexOf(source as TextListItem);
    if (i !== -1) {
      if (i !== this.selected) {
        if (this.selected !== -1) this.items[this.selected]?.setState(0);
        this.selected = i;
        this.items[i]!.setState(1);
      }
      this.notifySelect();
      return true;
    }
    return super.tsOnCommand(cmd, source);
  }

  /** cTSWinTextList::TSOnKeyDown (VK_PRIOR..VK_DOWN) and TSOnCharacter. */
  override tsOnKeyDown(key: string): boolean {
    const n = this.items.length;
    const s = this.selected;
    switch (key) {
      case "ArrowUp":
      case "ArrowLeft":
        if (n && s > 0) this.select(s - 1);
        return true;
      case "ArrowDown":
      case "ArrowRight":
        if (s < n - 1) this.select(s + 1);
        return true;
      case "PageUp":
        if (n) this.select(s - this.visibleRows >= 0 ? s - this.visibleRows : 0);
        return true;
      case "PageDown":
        if (n) this.select(s + this.visibleRows < n ? s + this.visibleRows : n - 1);
        return true;
      case "Home":
        if (n) this.select(0);
        return true;
      case "End":
        if (n) this.select(n - 1);
        return true;
    }
    if (key.length !== 1) return false;
    const c = key.toLowerCase();
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < n; i++) {
      const first = this.items[i]!.caption.charAt(0).toLowerCase();
      if (!first) continue;
      if (first === c) {
        this.select(i);
        return true;
      }
      const d = c.charCodeAt(0) - first.charCodeAt(0);
      if (d > 0 && d <= bestDist) {
        bestDist = d;
        best = i;
      }
    }
    if (best === -1) return false;
    this.select(best);
    return true;
  }
}
