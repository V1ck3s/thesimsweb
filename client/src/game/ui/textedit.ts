/**
 * Editable text field (cTSWinTextEdit2): the name fields, biographies and
 * descriptions of the game's dialogs.
 *
 * From the decompiled class (TSWinTextEdit2.cpp, Mac build; the key jump
 * table read from WinTextEdit2.s / lbl_105BD100):
 *  - Init: the text rectangle (+0x108..+0x114) is (5, 0, w, h) (SetArea
 *    resets it too); the visible line count (+0x120) is its height over the
 *    font height (at least 1); the lines are centered vertically in the
 *    window ((h - visible * lineHeight) / 2, +0xf4). A one-line edit
 *    (SetLinesAllowed(1), +0x124) does not wrap; the others wrap at the text
 *    rectangle's width - 5 (+0xf8);
 *  - Rebuild: the lines (cTELine: start, length, the cumulative width of
 *    each character, a soft-wrap flag +0x20 and a hard-return flag +0x21),
 *    one per font height from y 0, x 5. A line grows while its width stays
 *    within the wrap width + 2, then CalculateWordsToFitInWidth cuts it; a
 *    newline ends it (kept in it). With SetLinesAllowed(-1) a text ending in
 *    a newline gets an empty last line. When there are more lines than fit,
 *    a vertical cTSWinScrollbar (the control manager's bitmap 4, at the
 *    window's right edge, full height, no focus, arrow cursor) is created;
 *    SynchronizeScrollbar shows it (the text rectangle and the wrap width
 *    lose its width) with the range 0 .. lines - visible and the top line as
 *    value, or hides it and recenters when everything fits; its notification
 *    (0xc) sets the top line;
 *  - the cursor (+0xcc index, +0xd0 line, +0xd4 caret point: 2 px left of a
 *    line start, else the right edge of the previous character) moves with
 *    MoveCursor(delta, extendSelection), which walks line by line and grows
 *    or shrinks the selection (+0x130 .. +0x134) around the moving end;
 *    ExposeCursor scrolls a one-line edit sideways (+0xec) and a multi-line
 *    one by whole lines (SetTopVisibleLine: +0xf0 = +0xf4 - top * height);
 *  - keys (bit 0 of the key flags = Shift extends the selection, bit 1 =
 *    Ctrl): Backspace / Delete delete (the selection first); Left / Right
 *    move one character, by word with Ctrl (MoveWord); Up / Down move one
 *    line keeping the column index (VertLineScroll), with Ctrl (no Shift)
 *    scroll the view one line; Page Up / Down move a page (VertPageScroll),
 *    with Ctrl scroll a page; Home / End go to the line's ends, with Ctrl to
 *    the text's; Insert toggles insert / overwrite (+0x12c 0 / 1; 2 is read
 *    only); Tab posts 0x19 and Escape 0x18 to the target (+0x50);
 *  - cTSWin::DoMessage, with Ctrl down, maps X C V Z Y A (lbl_105BA8C0) to
 *    TSOnCut / TSOnCopy / TSOnPaste / TSOnUndo / TSOnRedo / TSOnSelectAll.
 *    The clipboard goes through the browser's cut / copy / paste events
 *    (cTSWinMgrW95::SetClipboard / GetClipboard). Paste into a one-visible-
 *    line edit drops the characters below 0x20 (the original's loop skips
 *    the one after each dropped character);
 *  - TSOnCharacter: Return becomes a newline, which in a one-line edit posts
 *    0x17 instead; other characters below 0x20 are ignored; with
 *    SetFilterFileChars the characters of lbl_105BD108 are refused with the
 *    +400 sound; a refused insertion (capacity, read only) plays the +0x18c
 *    sound (both "UI_Error" unless the owner sets them);
 *  - undo / redo: cTEState snapshots (text, cursor, scroll, top line,
 *    selection) on two stacks. Inserting or replacing snapshots first unless
 *    it is one character other than a space typed within 3 s of the last
 *    snapshot, or the text is full; deleting snapshots on Backspace, with a
 *    selection, before a space, or 3 s after the last snapshot. A new
 *    snapshot clears the redo stack; undo / redo do not notify the target;
 *  - mouse: a press captures and places the cursor (Shift extends the
 *    selection), dragging extends it, the release places it again. The hit
 *    test goes line by line: the character whose middle is past the point;
 *  - every change posts 0x16 to the target (DeleteText even when nothing
 *    was deleted, twice for Backspace);
 *  - TSPaint: the fill color (+0x138) unless transparent; the visible lines
 *    clipped 1 px left of the text; selected characters (only while focused)
 *    on a cell of the text color with the glyph cut out of it
 *    (cTSFont::TSDrawChar); the caret, a 1 px line one font height tall in
 *    the caret color, blinking on a 500 ms timer; the frame (+0x140) when
 *    focused (SetDrawFrameOnFocus) or flashing while empty
 *    (SetFlashFrameOnEmpty).
 *
 * Not ported: double-click word selection (TSOnMouseDoubleL: the window
 * manager has no double-click message), the double-byte font paths.
 */

import type { FfnFont } from "../res/ffn.js";
import { TSWinBtn } from "./btn.js";
import { SYS_SCROLLBAR, TSWinCtrlMgr } from "./ctrlmgr.js";
import { getStandardCursor } from "./cursor.js";
import { TSWinScrollbar } from "./scrollbar.js";
import { CMD_SLIDER_CHANGED, SLIDER_VERTICAL } from "./slider.js";
import { Gfx, TSWin, WF_NO_FOCUS, type Rect } from "./tswin.js";
import { winMgr } from "./winmgr.js";

/** Messages posted to the target (PostMessageToTarget(target, 3, msg, this)). */
export const TE_CHANGED = 0x16;
export const TE_RETURN = 0x17;
export const TE_ESCAPE = 0x18;
export const TE_TAB = 0x19;

/** lbl_105BD108: characters refused in file names. */
const FILE_CHARS = "\\/|*?:<>\"'%()&;@!#,.";
/** Constructor: +0x18c and +400, the sounds of a refused insertion / character. */
const DEFAULT_ERROR_SOUND = "UI_Error";
const CARET_MS = 500;
/** InsertText / ReplaceTextA / DeleteText: snapshots closer than this merge. */
const UNDO_MERGE_MS = 3000;
/** cTELine x and the text rectangle's left edge. */
const TEXT_LEFT = 5;
/** Init / SynchronizeScrollbar: the wrap width of a one-line edit. */
const NO_WRAP = 0x7fff;

/** cTSWinTextEdit2::Mode (+0x12c) */
const MODE_INSERT = 0;
const MODE_OVERWRITE = 1;
const MODE_READ_ONLY = 2;

/** cTELine */
interface TELine {
  start: number;
  len: number;
  /** +0x14: right edge of each character from the line's x. */
  widths: number[];
  /** +0x20: the line wraps into the next one. */
  soft: boolean;
  /** +0x21: the line ends with a newline. */
  hard: boolean;
  /** +0x10: top, from the text's origin. */
  y: number;
}

/** cTEState */
interface TEState {
  text: string;
  cursor: number;
  cursorLine: number;
  caretX: number;
  caretY: number;
  scrollX: number;
  scrollY: number;
  topLine: number;
  selStart: number;
  selEnd: number;
}

let clipboardInstalled = false;

/** The browser clipboard events go to the focused edit (cTSWin::DoMessage, Ctrl+X / C / V). */
function installClipboard(): void {
  if (clipboardInstalled) return;
  clipboardInstalled = true;
  const focused = (): TSWinTextEdit2 | null => {
    const w = winMgr.getFocus();
    return w instanceof TSWinTextEdit2 ? w : null;
  };
  document.addEventListener("copy", (e) => {
    const w = focused();
    if (w && w.tsOnCopy(e.clipboardData)) e.preventDefault();
  });
  document.addEventListener("cut", (e) => {
    const w = focused();
    if (w && w.tsOnCut(e.clipboardData)) e.preventDefault();
  });
  document.addEventListener("paste", (e) => {
    const w = focused();
    if (w && w.tsOnPaste(e.clipboardData?.getData("text/plain") ?? "")) e.preventDefault();
  });
}

export class TSWinTextEdit2 extends TSWin {
  font: FfnFont | null = null;
  text = "";
  textColor = "#ffffff";
  fillColor = "#000000";
  caretColor = "#ffffff";
  frameColor = "#ffffff";
  transparent = false;
  capacity = 0x7fffffff;
  /** +0x124 */
  linesAllowed = 0;
  flashFrameOnEmpty = false;
  drawFrameOnFocus = true;
  filterFileChars = false;
  /** +0x18c: played when an insertion is refused. */
  errorSound = DEFAULT_ERROR_SOUND;
  /** +400: played when SetFilterFileChars refuses a character. */
  filterSound = DEFAULT_ERROR_SOUND;
  /** +0x50: the window that receives the notifications (the parent when null). */
  target: TSWin | null = null;
  /** cTSWinTextEdit2::Init: SetCursor(GetStandardCursor(2)), the I-beam. */
  override winCursor: string | null = getStandardCursor(2);

  private inited = false;
  /** +0xcc / +0xd0 / +0xd4 */
  private cursor = 0;
  private cursorLine = 0;
  private caretX = 0;
  private caretY = 0;
  /** +0xe0 */
  private lines: TELine[] = [{ start: 0, len: 0, widths: [], soft: false, hard: false, y: 0 }];
  /** +0xec / +0xf0: the text's offset in the window (sideways scroll, vertical scroll). */
  private scrollX = 0;
  private scrollY = 0;
  /** +0xf4 */
  private centerOffset = 0;
  /** +0xf8 */
  private wrapWidth = 0;
  /** +0x100 */
  private scrollbar: TSWinScrollbar | null = null;
  /** +0x108..+0x114 */
  private textRect: Rect = { left: 0, top: 0, right: 0, bottom: 0 };
  /** +0x11c / +0x120 */
  private topLine = 0;
  private visibleLines = 0;
  /** +0x12c */
  private mode = MODE_INSERT;
  /** +0x130 / +0x134 */
  private selStart = 0;
  private selEnd = 0;
  /** +0x14c / +0x14d: caret and empty-frame blink phases. */
  private caretOn = true;
  private flashOn = false;
  private lastBlink = 0;
  /** +0x147 / +0x148: dragging, and where the press landed. */
  private dragging = false;
  private anchor = -1;
  /** +0x158 / +0x164 / +0x170 */
  private readonly undoStack: TEState[] = [];
  private readonly redoStack: TEState[] = [];
  private lastSnapshot = 0;

  constructor() {
    super();
    installClipboard();
  }

  // --- setup ---------------------------------------------------------------

  setFont(font: FfnFont): void {
    this.font = font;
    if (!this.inited) return;
    this.centerOffset = this.computeCenterOffset();
    this.rebuild();
  }

  setTextColor(color: string): void {
    this.textColor = color;
  }

  setColors(fill: string, caret: string, frame: string): void {
    this.fillColor = fill;
    this.caretColor = caret;
    this.frameColor = frame;
  }

  /** cTSWinTextEdit2::SetTransparent(bool): no background fill (not cTSWin::SetTransparent's blending). */
  override setTransparent(on: boolean): void {
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

  /** cTSWinTextEdit2::SetArea: the text rectangle back to (5, 0, w, h), the lines recentered. */
  override setArea(left: number, top: number, right: number, bottom: number): void {
    super.setArea(left, top, right, bottom);
    this.centerOffset = this.computeCenterOffset();
    this.textRect = { left: TEXT_LEFT, top: 0, right: this.getW(), bottom: this.getH() };
  }

  override async init(): Promise<boolean> {
    if (!(await super.init())) return false;
    this.ensureInit();
    return true;
  }

  /**
   * cTSWinTextEdit2::Init, run on first use (the dialogs add their edits
   * without initializing them).
   */
  private ensureInit(): boolean {
    if (this.inited) return true;
    if (!this.font) return false;
    this.inited = true;
    if (this.textRect.right === this.textRect.left)
      this.textRect = { left: TEXT_LEFT, top: 0, right: this.getW(), bottom: this.getH() };
    this.topLine = 0;
    this.visibleLines = Math.trunc((this.textRect.bottom - this.textRect.top) / this.lineHeight) || 1;
    this.wrapWidth = this.linesAllowed === 1 ? NO_WRAP : this.textRect.right - this.textRect.left - TEXT_LEFT;
    this.selStart = this.selEnd = 0;
    // A text set before: SetText's default placement, the cursor at the end.
    const end = this.text.length;
    this.cursor = this.cursorLine = 0;
    this.rebuild();
    this.centerOffset = this.computeCenterOffset();
    this.setTopVisibleLine(0);
    this.moveCursor(end, false, false);
    return true;
  }

  private computeCenterOffset(): number {
    const h = this.getH();
    if (h === 0 || this.visibleLines < 1 || !this.font) return 0;
    return Math.trunc((h - this.visibleLines * this.lineHeight) / 2);
  }

  private get lineHeight(): number {
    return this.font?.height ?? 12;
  }

  /** cTSWinTextEdit2::SetText(text, false, false): the cursor at the end, nothing selected. */
  setText(text: string): void {
    if (!this.inited) {
      this.text = text.slice(0, this.capacity);
      this.ensureInit();
      return;
    }
    this.cursor = this.cursorLine = 0;
    this.scrollX = this.scrollY = 0;
    this.topLine = 0;
    this.selStart = this.selEnd = 0;
    this.moveCursor(0, false, true);
    this.rebuild();
    this.setSelection(0, this.text.length);
    this.replaceText(text);
    this.setSelection(this.text.length, this.text.length);
  }

  getText(): string {
    return this.text;
  }

  override shutdown(): void {
    // FlushUndoBuffers
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.lastSnapshot = 0;
    super.shutdown();
  }

  private post(msg: number): void {
    (this.target ?? this.parent)?.tsOnCommand(msg, this);
  }

  private playSound(name: string): void {
    TSWinBtn.uiSoundHook?.(name);
  }

  // --- layout (Rebuild, SynchronizeScrollbar, SetTopVisibleLine) ----------------

  /** cTSWinTextEdit2::Rebuild (the whole text; the original restarts at a given line, same result). */
  private rebuild(): void {
    const font = this.font;
    if (!font) return;
    const h = this.lineHeight;
    const text = this.text;
    const lines: TELine[] = [];
    if (text.length === 0) {
      lines.push({ start: 0, len: 0, widths: [], soft: false, hard: false, y: 0 });
      this.lines = lines;
      this.cursor = this.cursorLine = 0;
      this.caretX = TEXT_LEFT - 2;
      this.caretY = 0;
    } else {
      // A line's width (from its x, 5) may reach x + wrap width - 3.
      const limit = TEXT_LEFT + this.wrapWidth - 3;
      let pos = 0;
      for (let i = 0; ; i++) {
        const line: TELine = { start: pos, len: 0, widths: [], soft: true, hard: false, y: i * h };
        for (;;) {
          const k = line.widths.length;
          const ch = text[pos + k];
          if (ch === undefined) {
            line.soft = false;
            break;
          }
          if (ch === "\n") {
            line.soft = false;
            line.hard = true;
            line.widths.push(line.widths[k - 1] ?? 0);
            break;
          }
          const w = font.stringWidth(text.slice(pos, pos + k + 1));
          line.widths.push(w);
          if (w > limit) {
            const n = font.calculateWordsToFitInWidth(text, pos, text.length - pos, limit);
            line.widths.length = Math.max(1, Math.min(n, line.widths.length));
            break;
          }
        }
        line.len = line.widths.length;
        lines.push(line);
        pos += line.len;
        if (pos >= text.length) break;
      }
      const last = lines[lines.length - 1]!;
      if (this.linesAllowed === -1 && last.hard)
        lines.push({ start: pos, len: 0, widths: [], soft: false, hard: false, y: lines.length * h });
      this.lines = lines;
      this.cursorLine = this.lineOfIndex(this.cursor);
    }
    if (this.visibleLines !== 0 && this.lines.length > this.visibleLines && !this.scrollbar) this.createScrollbar();
    this.synchronizeScrollbar();
  }

  /** Rebuild's cursor line: the line holding the index, the next one at a line's end. */
  private lineOfIndex(index: number): number {
    const n = this.lines.length;
    for (let i = 0; i < n; i++) {
      const l = this.lines[i]!;
      if (index >= l.start && index < l.start + l.len) return i;
      if (index === l.start + l.len) return i < n - 1 ? i + 1 : i;
    }
    return 0;
  }

  /** Rebuild: the scroll bar, hidden until needed. */
  private createScrollbar(): void {
    const mgr = TSWinCtrlMgr.current;
    if (!mgr) return;
    const sb = new TSWinScrollbar();
    sb.setArea(0, 0, 1, this.getH());
    sb.setDirection(SLIDER_VERTICAL);
    const img = mgr.systemBMP(SYS_SCROLLBAR);
    sb.setImage(img);
    const x = this.getW() - Math.trunc(img.width / 12);
    sb.setArea(x, 0, x + sb.getW(), sb.getH());
    sb.setFlag(WF_NO_FOCUS, true);
    sb.winCursor = getStandardCursor(0);
    sb.hideWindow();
    this.childAdd(sb);
    this.scrollbar = sb;
  }

  /** cTSWinTextEdit2::SynchronizeScrollbar */
  private synchronizeScrollbar(): void {
    const sb = this.scrollbar;
    if (!sb) return;
    if (this.visibleLines !== 0 && this.lines.length > this.visibleLines) {
      if (!sb.isVisible()) {
        sb.showWindow();
        this.textRect.right -= sb.getW();
        if (this.linesAllowed !== 1) this.wrapWidth = this.textRect.right - this.textRect.left - TEXT_LEFT;
        this.rebuild();
      }
      sb.setMinimumValue(0);
      sb.setMaximumValue(this.lines.length - this.visibleLines);
      sb.setValue(this.topLine);
      return;
    }
    this.scrollY = this.centerOffset;
    this.topLine = 0;
    if (sb.isVisible()) {
      sb.hideWindow();
      this.textRect.right += sb.getW();
      if (this.linesAllowed !== 1) this.wrapWidth = this.textRect.right - this.textRect.left - TEXT_LEFT;
      this.rebuild();
    }
  }

  /** cTSWinTextEdit2::SetTopVisibleLine */
  private setTopVisibleLine(n: number): void {
    if (n < 0) n = 0;
    if (this.lines.length !== 0 && n >= this.lines.length) n = this.lines.length - 1;
    this.scrollY = this.centerOffset - n * this.lineHeight;
    this.topLine = n;
    this.synchronizeScrollbar();
  }

  /** cTSWinTextEdit2::ExposeCursor */
  private exposeCursor(): void {
    const x = this.caretX + this.scrollX;
    const y = this.caretY + this.scrollY;
    const h = this.lineHeight;
    const r = this.textRect;
    let dx = 0;
    let dy = 0;
    if (this.linesAllowed === 1 && this.lines.length !== 0) {
      if (x < r.left) {
        dx = Math.min(x - r.left, Math.trunc(-this.getW() / 2));
        const l = this.lines[0]!;
        if (l.widths.length !== 0) {
          const i = Math.max(0, Math.min(this.cursor, l.widths.length - 1));
          const px = TEXT_LEFT + l.widths[i]!;
          if (px < r.right - r.left) dx = Math.min(dx, -px);
        }
      } else if (x >= r.right) {
        dx = x - r.right + 1;
      }
    }
    if (y < r.top) dy = y - r.top;
    else if (y + h >= r.bottom) dy = y + h - r.bottom + 1;
    if (dx !== 0) this.scrollX = Math.min(0, this.scrollX - dx);
    if (dy !== 0) {
      let top = this.cursorLine;
      if (this.topLine <= this.cursorLine) {
        top = this.topLine;
        if (this.topLine + this.visibleLines <= this.cursorLine) top = this.cursorLine - this.visibleLines + 1;
      }
      this.setTopVisibleLine(top);
    }
    this.flashOn = true;
  }

  // --- cursor and selection ------------------------------------------------------

  /** cTSWinTextEdit2::MoveCursor (AdjustDelta only matters for double-byte fonts). */
  private moveCursor(delta: number, select: boolean, _adjust: boolean): void {
    let d = delta;
    let lineIndex = this.cursorLine;
    let line = this.lines[lineIndex];
    if (!line) return;
    if (!select) {
      this.selStart = this.selEnd = 0;
    } else if (this.selStart < this.selEnd) {
      const c = this.cursor;
      if (c < this.selStart) this.selStart = c;
      else if (c === this.selStart && d > 0) {
        if (this.selEnd < d + this.selStart) {
          const s = this.selStart;
          this.selStart = this.selEnd;
          this.selEnd = d + s;
        } else this.selStart += d;
      }
      if (this.selEnd < c) this.selEnd = c;
      else if (c === this.selEnd) {
        if (d < 0) {
          if (d + this.selEnd < this.selStart) {
            const s = this.selStart;
            this.selStart = d + this.selEnd;
            this.selEnd = s;
          } else this.selEnd += d;
        } else if (d > 0) this.selEnd += d;
      }
    } else if (d < 0) {
      this.selStart = this.cursor + d;
      this.selEnd = this.cursor;
    } else if (d === 0) {
      this.selStart = this.selEnd = this.cursor;
    } else {
      this.selStart = this.cursor;
      this.selEnd = this.cursor + d;
    }
    for (;;) {
      let step = 0;
      if (d !== 0) {
        const c = this.cursor;
        const to = Math.max(0, c + d);
        const end = line.start + line.len;
        if (to >= line.start && to < end) {
          this.cursor = to;
        } else if (to < line.start) {
          const k = c - line.start;
          d += d >= 0 ? -k : k;
          step = -1;
          this.cursor = line.start;
        } else if (to === end) {
          this.cursor = end;
          d -= end - c;
          step = line.soft || line.hard ? 1 : 0;
        } else {
          step = 1;
          d -= end - c;
          this.cursor = end;
        }
      }
      if (step === 0) break;
      lineIndex += step;
      if (lineIndex >= this.lines.length) {
        lineIndex--;
        break;
      }
      line = this.lines[Math.max(0, lineIndex)]!;
    }
    this.cursorLine = Math.max(0, lineIndex);
    if (this.cursor === line.start) {
      this.caretX = TEXT_LEFT - 2;
    } else if (this.cursor > line.start && this.cursor < line.start + line.len) {
      this.caretX = TEXT_LEFT + line.widths[this.cursor - line.start - 1]!;
    } else {
      this.caretX = TEXT_LEFT + (line.widths[line.widths.length - 1] ?? 0);
    }
    this.caretY = line.y;
    if (select) {
      if (this.cursor < this.selStart) this.selStart = this.cursor;
      if (this.selEnd < this.cursor) this.selEnd = this.cursor;
    }
    this.exposeCursor();
  }

  /** cTSWinTextEdit2::SetSelection */
  setSelection(from: number, to: number): void {
    if (!this.ensureInit()) return;
    const len = this.text.length;
    if (from === to) {
      this.moveCursor(from - this.cursor, false, false);
      return;
    }
    if (from < to) {
      from = Math.max(0, from);
      to = Math.min(len, to);
    } else {
      to = Math.max(0, to);
      from = Math.min(len, from);
    }
    this.moveCursor(from - this.cursor, false, false);
    this.moveCursor(to - from, true, false);
  }

  /** cTSWinTextEdit2::MoveWord */
  private moveWord(dir: number, select: boolean): void {
    const t = this.text;
    const at = (i: number): string => t[i] ?? "\0";
    let i = this.cursor;
    if (dir !== 0) {
      if (dir < 0) {
        for (; i > 1; i--) {
          const ch = at(i - 1);
          if (ch !== " " && ch !== "\n") break;
        }
        const ch = at(i);
        if ((i > 0 && ch === " ") || ch === "\n") i--;
      }
      let space = false;
      for (let n = 0; n < Math.abs(dir) && i >= 0 && i <= t.length; ) {
        const ch = at(i);
        if (ch === " " || ch === "\n") {
          space = true;
          i++;
        } else if (space) {
          n++;
        } else {
          i += dir < 1 ? -1 : 1;
        }
      }
    }
    i = Math.max(0, Math.min(t.length, i));
    this.moveCursor(i - this.cursor, select, false);
  }

  /** cTSWinTextEdit2::VertLineScroll: the same index in the line, the line's end at most. */
  private vertLineScroll(d: number, select: boolean): void {
    const from = this.lines[this.cursorLine];
    if (!from) return;
    let off = this.cursor - from.start;
    const n = Math.max(0, Math.min(this.lines.length - 1, this.cursorLine + d));
    const to = this.lines[n]!;
    if (off > to.len) {
      if (to.soft) off = to.len - 1;
      else {
        off = to.len;
        if (to.hard) off = to.len - 1;
      }
    }
    this.moveCursor(to.start + off - this.cursor, select, true);
    this.exposeCursor();
  }

  /** cTSWinTextEdit2::VertPageScroll */
  private vertPageScroll(d: number, select: boolean): void {
    const vis = this.visibleLines;
    let top = this.topLine + d * vis;
    if (top < 0) top = 0;
    else if (this.lines.length - vis < top) top = this.lines.length - vis;
    this.vertLineScroll(d * vis, select);
    this.setTopVisibleLine(top);
  }

  // --- editing ---------------------------------------------------------------

  private snapshotState(): TEState {
    return {
      text: this.text,
      cursor: this.cursor,
      cursorLine: this.cursorLine,
      caretX: this.caretX,
      caretY: this.caretY,
      scrollX: this.scrollX,
      scrollY: this.scrollY,
      topLine: this.topLine,
      selStart: this.selStart,
      selEnd: this.selEnd,
    };
  }

  private restoreState(s: TEState): void {
    this.text = s.text;
    this.cursor = s.cursor;
    this.cursorLine = s.cursorLine;
    this.caretX = s.caretX;
    this.caretY = s.caretY;
    this.scrollX = s.scrollX;
    this.scrollY = s.scrollY;
    this.topLine = s.topLine;
    this.selStart = s.selStart;
    this.selEnd = s.selEnd;
    this.rebuild();
  }

  /** cTSWinTextEdit2::TakeUndoRedoSnapshot */
  private takeUndoRedoSnapshot(): void {
    this.undoStack.push(this.snapshotState());
    this.redoStack.length = 0;
    this.lastSnapshot = performance.now();
  }

  /** InsertText / ReplaceTextA: does inserting `s` start a new undo step? */
  private insertionSnapshots(s: string): boolean {
    if (this.selStart < this.selEnd) return true;
    const word = s === " " || s.length > 1;
    if (!word && this.undoStack.length !== 0 && performance.now() - this.lastSnapshot < UNDO_MERGE_MS) return false;
    return true;
  }

  /** cTSWinTextEdit2::InsertText: false when it did not all fit (or read only). */
  insertText(s: string): boolean {
    if (!this.ensureInit() || this.mode === MODE_READ_ONLY) return false;
    let ok = true;
    let snap = this.insertionSnapshots(s);
    if (this.capacity <= this.text.length) snap = false;
    if (snap) this.takeUndoRedoSnapshot();
    if (this.selStart < this.selEnd) {
      this.text = this.text.slice(0, this.selStart) + this.text.slice(this.selEnd);
      this.selEnd = this.selStart;
      if (this.selStart < this.cursor) this.cursor = this.selStart;
    }
    let n = s.length;
    if (this.capacity < n + this.text.length) {
      n = this.capacity - this.text.length;
      ok = false;
    }
    if (n > 0) this.text = this.text.slice(0, this.cursor) + s.slice(0, n) + this.text.slice(this.cursor);
    this.rebuild();
    this.moveCursor(n, false, false);
    this.post(TE_CHANGED);
    return ok;
  }

  /** cTSWinTextEdit2::ReplaceTextA: overwrites as many characters as it inserts. */
  private replaceText(s: string): boolean {
    if (this.insertionSnapshots(s)) this.takeUndoRedoSnapshot();
    if (this.selStart < this.selEnd) {
      this.text = this.text.slice(0, this.selStart) + this.text.slice(this.selEnd);
      if (this.selStart < this.cursor) this.cursor = this.selStart;
    }
    let n = s.length;
    if (n === 0) {
      this.rebuild();
      this.moveCursor(0, false, false);
      return true;
    }
    if (this.cursor + n <= this.text.length) this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + n);
    let ok = n + this.text.length <= this.capacity;
    if (!ok) n = this.capacity - this.text.length;
    if (n < 1) ok = false;
    else {
      this.text = this.text.slice(0, this.cursor) + s.slice(0, n) + this.text.slice(this.cursor);
      this.post(TE_CHANGED);
    }
    this.rebuild();
    this.moveCursor(n, false, false);
    return ok;
  }

  /** cTSWinTextEdit2::DeleteText(-1 backward, 0 forward); the selection goes first. */
  private deleteText(dir: number): void {
    if (this.mode === MODE_READ_ONLY) return;
    if (
      (dir === -1 && this.cursor !== 0) ||
      this.selStart < this.selEnd ||
      this.text[this.cursor] === " " ||
      performance.now() - this.lastSnapshot >= UNDO_MERGE_MS
    )
      this.takeUndoRedoSnapshot();
    if (this.selStart < this.selEnd) {
      const s = this.selStart;
      this.text = this.text.slice(0, s) + this.text.slice(this.selEnd);
      this.cursor = s;
      this.setSelection(s, s);
    } else if (dir === -1) {
      if (this.cursor > 0) {
        this.moveCursor(-1, false, true);
        this.deleteText(0);
      }
    } else if (dir === 0 && this.cursor < this.text.length) {
      this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1);
    }
    this.post(TE_CHANGED);
    this.rebuild();
    this.moveCursor(0, false, true);
    this.exposeCursor();
  }

  // --- clipboard, undo (cTSWin::DoMessage with Ctrl) -------------------------------------

  /** cTSWinTextEdit2::TSOnCopy: the selection to the clipboard. */
  tsOnCopy(data: DataTransfer | null): boolean {
    if (!this.ensureInit()) return false;
    if (this.selStart < this.selEnd) data?.setData("text/plain", this.text.slice(this.selStart, this.selEnd));
    return true;
  }

  /** cTSWinTextEdit2::TSOnCut */
  tsOnCut(data: DataTransfer | null): boolean {
    if (!this.tsOnCopy(data)) return false;
    this.insertText("");
    return true;
  }

  /** cTSWinTextEdit2::TSOnPaste */
  tsOnPaste(clip: string): boolean {
    if (!this.ensureInit()) return false;
    let s = clip;
    if (this.visibleLines === 1) {
      for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 0x20) s = s.slice(0, i) + s.slice(i + 1);
    }
    if (!this.insertText(s)) this.playSound(this.errorSound);
    return true;
  }

  /** cTSWinTextEdit2::TSOnUndo */
  tsOnUndo(): void {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(this.snapshotState());
    this.restoreState(s);
  }

  /** cTSWinTextEdit2::TSOnRedo */
  tsOnRedo(): void {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(this.snapshotState());
    this.restoreState(s);
  }

  /** cTSWinTextEdit2::TSOnSelectAll */
  tsOnSelectAll(): void {
    this.setSelection(0, this.text.length);
  }

  // --- keyboard --------------------------------------------------------------

  override tsOnKeyDown(key: string): boolean {
    if (!this.ensureInit()) return false;
    const shift = winMgr.isKeyDown("Shift");
    const ctrl = winMgr.isKeyDown("Control");
    const line = this.lines[this.cursorLine]!;
    switch (key) {
      case "Backspace":
        this.deleteText(-1);
        break;
      case "Delete":
        this.deleteText(0);
        break;
      case "ArrowUp":
        if (!ctrl) this.vertLineScroll(-1, shift);
        else if (!shift) this.setTopVisibleLine(this.topLine - 1);
        break;
      case "ArrowDown":
        if (!ctrl) this.vertLineScroll(1, shift);
        else if (!shift) this.setTopVisibleLine(this.topLine + 1);
        break;
      case "PageUp":
        if (!ctrl) this.vertPageScroll(-1, shift);
        else if (!shift) this.setTopVisibleLine(this.topLine - this.visibleLines);
        break;
      case "PageDown":
        if (!ctrl) this.vertPageScroll(1, shift);
        else if (!shift) this.setTopVisibleLine(this.topLine + this.visibleLines);
        break;
      case "ArrowLeft":
        if (ctrl) this.moveWord(-1, shift);
        else this.moveCursor(-1, shift, true);
        break;
      case "ArrowRight":
        if (ctrl) this.moveWord(1, shift);
        else this.moveCursor(1, shift, true);
        break;
      case "Home":
        this.moveCursor(ctrl ? -this.cursor : line.start - this.cursor, shift, false);
        break;
      case "End": {
        if (ctrl) {
          this.moveCursor(this.text.length - this.cursor, shift, false);
          break;
        }
        let d = line.start + line.len - this.cursor;
        if (line.hard || line.soft) d -= 1;
        this.moveCursor(d, shift, false);
        break;
      }
      case "Insert":
        if (this.mode === MODE_INSERT) this.mode = MODE_OVERWRITE;
        else if (this.mode === MODE_OVERWRITE) this.mode = MODE_INSERT;
        break;
      case "Tab":
        this.post(TE_TAB);
        break;
      case "Escape":
        this.post(TE_ESCAPE);
        break;
      case "Enter":
        this.tsOnCharacter("\n");
        break;
      default: {
        if ([...key].length !== 1) return false;
        if (ctrl) {
          // cTSWin::DoMessage: X C V reach the browser's clipboard events, Z Y A act here.
          const k = key.toUpperCase();
          if (k === "X" || k === "C" || k === "V") winMgr.keepKeyDefault();
          else if (k === "Z") this.tsOnUndo();
          else if (k === "Y") this.tsOnRedo();
          else if (k === "A") this.tsOnSelectAll();
          return true;
        }
        this.tsOnCharacter(key);
      }
    }
    return true;
  }

  /** cTSWinTextEdit2::TSOnCharacter */
  private tsOnCharacter(ch: string): void {
    if (ch === "\r") ch = "\n";
    if (ch === "\n" && this.linesAllowed === 1) {
      this.post(TE_RETURN);
      return;
    }
    if (ch < " " && ch !== "\n") return;
    if (this.filterFileChars && FILE_CHARS.includes(ch)) {
      this.playSound(this.filterSound);
      return;
    }
    let ok = false;
    if (this.mode === MODE_INSERT) ok = this.insertText(ch);
    else if (this.mode === MODE_OVERWRITE) ok = this.replaceText(ch);
    if (!ok) this.playSound(this.errorSound);
  }

  // --- mouse -------------------------------------------------------------------

  /**
   * The hit test shared by the mouse handlers: per line, an index, -1 below
   * the line or -3 above it. `x` / `y` are already offset by the scroll.
   */
  private hitLine(l: TELine, x: number, y: number): number {
    const h = this.lineHeight;
    if (y < l.y) return -3;
    if (y >= l.y + h) return -1;
    if (x < TEXT_LEFT || l.widths.length === 0) return l.start;
    if (x < TEXT_LEFT + Math.trunc(l.widths[0]! / 2)) return l.start;
    let i = 1;
    for (; i < l.widths.length; i++) if (x <= TEXT_LEFT + Math.trunc((l.widths[i]! + l.widths[i - 1]!) / 2)) break;
    if (i > 0 && i === l.len && (l.hard || l.soft)) i--;
    return l.start + i;
  }

  override tsOnMouseDownL(x: number, y: number): boolean {
    if (!this.ensureInit()) return true;
    if (winMgr.getFocus() !== this) winMgr.setFocus(this);
    winMgr.setCapture(this);
    this.dragging = true;
    this.anchor = -1;
    const px = x - this.scrollX;
    const py = y - this.scrollY;
    for (let i = 0; i < this.lines.length; i++) {
      const r = this.hitLine(this.lines[i]!, px, py);
      if (r >= 0) {
        this.anchor = r;
        break;
      }
      if (r === -1 && i === this.lines.length - 1) this.anchor = this.text.length;
    }
    if (this.anchor >= 0) this.moveCursor(this.anchor - this.cursor, winMgr.isKeyDown("Shift"), false);
    return true;
  }

  override tsOnMouseMove(x: number, y: number): boolean {
    if (!this.dragging) return true;
    const px = x - this.scrollX;
    const py = y - this.scrollY;
    let index = -1;
    for (let i = 0; i < this.lines.length; i++) {
      index = this.hitLine(this.lines[i]!, px, py);
      if (index >= 0) break;
      if (index === -1 && i === this.lines.length - 1) {
        index = this.text.length;
        break;
      }
      if (index === -3 && i === 0) {
        index = 0;
        break;
      }
    }
    this.moveCursor(index - this.cursor, true, false);
    return true;
  }

  override tsOnMouseUpL(x: number, y: number): boolean {
    this.dragging = false;
    if (winMgr.getCapture() !== this) return true;
    winMgr.releaseCapture(this);
    const px = x - this.scrollX;
    const py = y - this.scrollY;
    let index = -1;
    for (let i = 0; i < this.lines.length; i++) {
      const l = this.lines[i]!;
      index = this.hitLine(l, px, py);
      if (index >= 0) break;
      if (index === -1 && i === this.lines.length - 1) {
        index = l.start + l.len;
        break;
      }
      if (index === -3) {
        index = l.start;
        break;
      }
    }
    if (index !== this.cursor) this.moveCursor(index - this.cursor, this.anchor !== index, false);
    return true;
  }

  /** cTSWinTextEdit2::TSOnCommand: the scroll bar sets the top line. */
  override tsOnCommand(cmd: number, source: TSWin): boolean {
    if (cmd === CMD_SLIDER_CHANGED) {
      if (source === this.scrollbar) this.setTopVisibleLine(this.scrollbar.getValue());
      return true;
    }
    return super.tsOnCommand(cmd, source);
  }

  // --- painting ----------------------------------------------------------------

  /** CaretTimerCallback: both blink phases flip every 500 ms. */
  override pump(nowMs: number): void {
    if (nowMs - this.lastBlink >= CARET_MS) {
      this.lastBlink = nowMs;
      this.caretOn = !this.caretOn;
      this.flashOn = !this.flashOn;
    }
    super.pump(nowMs);
  }

  override tsPaint(g: Gfx): void {
    const w = this.getW();
    const h = this.getH();
    if (!this.transparent) g.fill(0, 0, w, h, this.fillColor);
    const font = this.font;
    const focused = winMgr.getFocus() === this;
    if (font && this.ensureInit()) {
      const ctx = g.ctx;
      const lh = this.lineHeight;
      const selFrom = this.selStart;
      const selTo = focused ? this.selEnd : this.selStart;
      ctx.save();
      ctx.beginPath();
      ctx.rect(g.ox + TEXT_LEFT - 1, g.oy, w - TEXT_LEFT + 1, h);
      ctx.clip();
      for (let i = this.topLine; i < this.topLine + this.visibleLines && i < this.lines.length; i++) {
        const l = this.lines[i]!;
        const x = g.ox + this.scrollX + TEXT_LEFT;
        const y = g.oy + this.scrollY + l.y;
        this.drawLine(ctx, l, x, y, Math.max(selFrom, l.start) - l.start, Math.min(selTo, l.start + l.len) - l.start, lh);
      }
      ctx.restore();
      // The caret.
      const visible = this.cursorLine >= this.topLine && this.cursorLine < this.topLine + this.visibleLines;
      if (this.caretOn && this.mode !== MODE_READ_ONLY && focused && visible) {
        const r = this.textRect;
        const cx = Math.min(r.right, Math.max(r.left, this.caretX + this.scrollX));
        let cy = this.caretY + this.scrollY;
        let ch = lh;
        if (cy < r.top) {
          const cut = r.top - cy;
          cy -= cut;
          ch -= cut;
        }
        if (cy + ch >= r.bottom) ch -= cy + ch - r.bottom + 1;
        const inside = (px: number, py: number): boolean => px >= 0 && py >= 0 && px < w && py < h;
        if (inside(cx, cy) && inside(cx, cy + ch - 1)) g.fill(cx, cy, 1, ch, this.caretColor);
      }
    }
    let frame = false;
    if (this.text.length === 0 && this.flashFrameOnEmpty) frame = this.flashOn;
    else if (this.drawFrameOnFocus && focused) frame = true;
    if (frame) g.frame(0, 0, w, h, this.frameColor);
  }

  /**
   * One line (cTSFont::TSDrawText with a selection): characters [a, b) of
   * the line are drawn selected, a cell of the text color (advance + 1 wide,
   * one font height) with the glyph cut out (TSDrawChar blends the glyph
   * from the text color to what is under it).
   */
  private drawLine(ctx: CanvasRenderingContext2D, l: TELine, x: number, y: number, a: number, b: number, lh: number): void {
    const font = this.font!;
    const s = this.text.slice(l.start, l.start + l.len).replace(/\n$/, "");
    const left = (i: number): number => (i <= 0 ? 0 : (l.widths[i - 1] ?? 0));
    if (a >= b || a >= s.length) {
      font.drawText(ctx, s, x, y, this.textColor);
      return;
    }
    b = Math.min(b, s.length);
    if (a > 0) font.drawText(ctx, s.slice(0, a), x, y, this.textColor);
    if (b < s.length) font.drawText(ctx, s.slice(b), x + left(b), y, this.textColor);
    const sx = left(a);
    const cw = left(b) - sx + 1;
    if (cw <= 0) return;
    const cell = document.createElement("canvas");
    cell.width = cw;
    cell.height = lh;
    const c = cell.getContext("2d")!;
    c.fillStyle = this.textColor;
    c.fillRect(0, 0, cw, lh);
    c.globalCompositeOperation = "destination-out";
    font.drawText(c, s.slice(a, b), 0, 0, "#000000");
    ctx.drawImage(cell, x + sx, y);
  }
}
