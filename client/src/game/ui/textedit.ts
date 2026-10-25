/**
 * Editable text field (cTSWinTextEdit2), the subset the game's dialogs use:
 * single-line name fields and the multi-line biography of Create-a-Sim.
 *
 * From the decompiled class:
 *  - the text rectangle (+0x108..+0x114, SetArea) is (5, 0, w, h); with a
 *    line count (SetLinesAllowed) the lines are centered vertically
 *    ((h - lines * lineHeight) / 2, +0xf4);
 *  - SetColors(fill, caret, frame) (+0x138..+0x140); a transparent edit
 *    (SetTransparent) does not fill its background;
 *  - the caret blinks on a 500 ms timer (CaretTimerCallback), as does the
 *    flash-on-empty frame (+0x145): a 1 px outline of the whole window in the
 *    frame color while the text is empty;
 *  - TSOnCharacter: Return in a one-line edit posts 0x17 to the message
 *    target (+0x50) instead of inserting; characters below 0x20 are ignored;
 *    with SetFilterFileChars the characters of lbl_105BD108 are refused with
 *    the "UI_NHood_error" sound, as is any insertion past the capacity;
 *  - TSOnKeyDown: Backspace / Delete / arrows / Home / End edit and move,
 *    Tab posts 0x19 and Escape posts 0x18 to the target, Insert toggles
 *    insert / overwrite; every change posts 0x16 (DeleteText, InsertText,
 *    ReplaceTextA).
 *
 * Not ported: selection, clipboard, undo/redo, the scrollbar.
 */

import type { FfnFont } from "../res/ffn.js";
import { TSWinBtn } from "./btn.js";
import { Gfx, TSWin } from "./tswin.js";
import { winMgr } from "./winmgr.js";

/** Messages posted to the target (PostMessageToTarget(target, 3, msg, this)). */
export const TE_CHANGED = 0x16;
export const TE_RETURN = 0x17;
export const TE_ESCAPE = 0x18;
export const TE_TAB = 0x19;

/** lbl_105BD108: characters refused in file names. */
const FILE_CHARS = "\\/|*?:<>\"'%()&;@!#,.";
/** +0x18c / +400: the sounds of a refused insertion. */
const ERROR_SOUND = "UI_NHood_error";
const CARET_MS = 500;
/** SetArea: left edge of the text rectangle. */
const TEXT_LEFT = 5;

export class TSWinTextEdit2 extends TSWin {
  font: FfnFont | null = null;
  text = "";
  textColor = "#ffffff";
  fillColor = "#000000";
  caretColor = "#ffffff";
  frameColor = "#ffffff";
  transparent = false;
  capacity = 0x7fffffff;
  linesAllowed = 0;
  flashFrameOnEmpty = false;
  drawFrameOnFocus = true;
  filterFileChars = false;
  /** +0x50: the window that receives the notifications (the parent when null). */
  target: TSWin | null = null;
  private cursor = 0;
  private overwrite = false;
  private blink = true;
  private lastBlink = 0;
  private topLine = 0;

  setFont(font: FfnFont): void {
    this.font = font;
  }

  setTextColor(color: string): void {
    this.textColor = color;
  }

  setColors(fill: string, caret: string, frame: string): void {
    this.fillColor = fill;
    this.caretColor = caret;
    this.frameColor = frame;
  }

  setTransparent(on: boolean): void {
    this.transparent = on;
  }

  setCapacity(n: number): void {
    this.capacity = n;
  }

  setLinesAllowed(n: number): void {
    this.linesAllowed = n;
  }

  setFlashFrameOnEmpty(on: boolean): void {
    this.flashFrameOnEmpty = on;
  }

  setDrawFrameOnFocus(on: boolean): void {
    this.drawFrameOnFocus = on;
  }

  setFilterFileChars(on: boolean): void {
    this.filterFileChars = on;
  }

  /** cTSWinTextEdit2::SetText (the cursor goes to the end). */
  setText(text: string): void {
    this.text = text.slice(0, this.capacity);
    this.cursor = this.text.length;
    this.topLine = 0;
  }

  getText(): string {
    return this.text;
  }

  private post(msg: number): void {
    (this.target ?? this.parent)?.tsOnCommand(msg, this);
  }

  private get textWidth(): number {
    return Math.max(1, this.getW() - TEXT_LEFT);
  }

  /** Line starts (Rebuild): one line, or word-wrapped lines for a multi-line edit. */
  private lines(): { start: number; len: number }[] {
    const font = this.font;
    if (!font || this.linesAllowed === 1) return [{ start: 0, len: this.text.length }];
    const out: { start: number; len: number }[] = [];
    let pos = 0;
    while (pos < this.text.length) {
      const n = font.calculateWordsToFitInWidth(this.text, pos, this.text.length - pos, this.textWidth);
      out.push({ start: pos, len: n });
      pos += n;
    }
    const last = out[out.length - 1];
    if (!last || this.text.endsWith("\n")) out.push({ start: this.text.length, len: 0 });
    return out;
  }

  private get lineHeight(): number {
    return this.font?.height ?? 12;
  }

  private visibleLines(): number {
    return Math.max(1, Math.trunc(this.getH() / this.lineHeight));
  }

  private topOffset(): number {
    if (this.linesAllowed < 1) return 0;
    return Math.trunc((this.getH() - this.linesAllowed * this.lineHeight) / 2);
  }

  private cursorLine(lines: { start: number; len: number }[]): number {
    for (let i = lines.length - 1; i >= 0; i--) if (this.cursor >= lines[i]!.start) return i;
    return 0;
  }

  /** ExposeCursor: scroll so that the cursor line shows. */
  private exposeCursor(): void {
    const line = this.cursorLine(this.lines());
    const vis = this.visibleLines();
    if (line < this.topLine) this.topLine = line;
    else if (line >= this.topLine + vis) this.topLine = line - vis + 1;
  }

  private refused(): void {
    TSWinBtn.uiSoundHook?.(ERROR_SOUND);
  }

  private insertText(s: string): void {
    if (this.filterFileChars && [...s].some((c) => FILE_CHARS.includes(c))) {
      this.refused();
      return;
    }
    const removed = this.overwrite && this.cursor < this.text.length && this.text[this.cursor] !== "\n" ? 1 : 0;
    if (this.text.length - removed + s.length > this.capacity) {
      this.refused();
      return;
    }
    this.text = this.text.slice(0, this.cursor) + s + this.text.slice(this.cursor + removed);
    this.cursor += s.length;
    this.changed();
  }

  private deleteText(delta: number): void {
    const from = Math.max(0, Math.min(this.cursor, this.cursor + delta));
    const to = Math.min(this.text.length, Math.max(this.cursor, this.cursor + delta));
    if (from === to) return;
    this.text = this.text.slice(0, from) + this.text.slice(to);
    this.cursor = from;
    this.changed();
  }

  private changed(): void {
    this.exposeCursor();
    this.blink = true;
    this.post(TE_CHANGED);
  }

  private moveVertical(dir: number): void {
    const lines = this.lines();
    const i = this.cursorLine(lines);
    const to = lines[i + dir];
    const from = lines[i];
    if (!to || !from || !this.font) return;
    const x = this.font.stringWidth(this.text.slice(from.start, this.cursor));
    this.cursor = to.start + this.indexAtX(this.text.slice(to.start, to.start + to.len), x);
  }

  private indexAtX(line: string, x: number): number {
    const font = this.font;
    if (!font) return 0;
    let w = 0;
    let i = 0;
    for (const ch of line) {
      const cw = font.stringWidth(ch);
      if (ch === "\n" || w + cw / 2 > x) break;
      w += cw;
      i++;
    }
    return i;
  }

  override tsOnKeyDown(key: string): boolean {
    switch (key) {
      case "Backspace":
        this.deleteText(-1);
        break;
      case "Delete":
        this.deleteText(1);
        break;
      case "ArrowLeft":
        this.cursor = Math.max(0, this.cursor - 1);
        break;
      case "ArrowRight":
        this.cursor = Math.min(this.text.length, this.cursor + 1);
        break;
      case "ArrowUp":
        this.moveVertical(-1);
        break;
      case "ArrowDown":
        this.moveVertical(1);
        break;
      case "Home":
        this.cursor = this.lines()[this.cursorLine(this.lines())]?.start ?? 0;
        break;
      case "End": {
        const l = this.lines()[this.cursorLine(this.lines())];
        this.cursor = l ? l.start + l.len - (this.text[l.start + l.len - 1] === "\n" ? 1 : 0) : this.text.length;
        break;
      }
      case "Insert":
        this.overwrite = !this.overwrite;
        break;
      case "Tab":
        this.post(TE_TAB);
        break;
      case "Escape":
        this.post(TE_ESCAPE);
        break;
      case "Enter":
        if (this.linesAllowed === 1) this.post(TE_RETURN);
        else this.insertText("\n");
        break;
      default:
        // TSOnCharacter: printable characters only.
        if ([...key].length !== 1 || key < " ") return false;
        this.insertText(key);
    }
    this.exposeCursor();
    this.blink = true;
    return true;
  }

  override tsOnMouseDownL(x: number, y: number): boolean {
    if (winMgr.getFocus() !== this) winMgr.setFocus(this);
    const lines = this.lines();
    const row = Math.min(lines.length - 1, this.topLine + Math.max(0, Math.trunc((y - this.topOffset()) / this.lineHeight)));
    const line = lines[row];
    if (line) this.cursor = line.start + this.indexAtX(this.text.slice(line.start, line.start + line.len), x - TEXT_LEFT);
    this.blink = true;
    return true;
  }

  override pump(nowMs: number): void {
    if (nowMs - this.lastBlink >= CARET_MS) {
      this.lastBlink = nowMs;
      this.blink = !this.blink;
    }
    super.pump(nowMs);
  }

  override tsPaint(g: Gfx): void {
    const w = this.getW();
    const h = this.getH();
    if (!this.transparent) g.fill(0, 0, w, h, this.fillColor);
    const font = this.font;
    const focused = winMgr.getFocus() === this;
    if (font) {
      const lines = this.lines();
      const vis = this.visibleLines();
      const top = this.topOffset();
      for (let i = this.topLine; i < Math.min(lines.length, this.topLine + vis); i++) {
        const l = lines[i]!;
        const s = this.text.slice(l.start, l.start + l.len).replace(/\n$/, "");
        font.drawText(g.ctx, s, g.ox + TEXT_LEFT, g.oy + top + (i - this.topLine) * this.lineHeight, this.textColor);
      }
      // Caret: a vertical line one font height tall.
      const row = this.cursorLine(lines);
      if (focused && this.blink && row >= this.topLine && row < this.topLine + vis) {
        const l = lines[row]!;
        const cx = Math.min(w - 1, TEXT_LEFT + font.stringWidth(this.text.slice(l.start, this.cursor)));
        const cy = top + (row - this.topLine) * this.lineHeight;
        g.fill(cx, Math.max(0, cy), 1, Math.min(this.lineHeight, h - cy), this.caretColor);
      }
    }
    const frame = this.text.length === 0 && this.flashFrameOnEmpty ? this.blink : this.drawFrameOnFocus && focused;
    if (frame) g.frame(0, 0, w, h, this.frameColor);
  }
}
