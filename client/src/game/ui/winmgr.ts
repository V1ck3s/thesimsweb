/**
 * Window manager (cTSWinMgrW95): owns the screen canvas and the main window,
 * routes mouse input (capture first, then the front-most window under the
 * cursor), tracks mouse enter/exit and drives the paint loop.
 *
 * The canvas has the game's logical resolution (800x600 or 1024x768) and is
 * scaled by CSS to fit the browser window with integer-free nearest scaling.
 */

import { getStandardCursor, HIDDEN_CURSOR } from "./cursor.js";
import { setFocusLostHook, TSWin, WF_GLOBAL_CURSOR, WF_HIDE_CURSOR, WF_MODAL, WF_NO_FOCUS, type Rect } from "./tswin.js";
import type { DefaultTTWindow } from "./ttwindow.js";

/** Tooltip states (cTSWinMgrW95+0x198). */
const TT_IDLE = 0;
const TT_WAITING = 1;
const TT_UNFURLING = 2;
const TT_SHOWN = 3;
/** A shown tooltip goes away after this long (SetupToolTipsWindow). */
const TT_SHOW_MS = 5000;

/** Touch mapping (not in the original): see WinMgr's touch section. */
const TOUCH_LONG_PRESS_MS = 500;
/** CSS pixels a finger may move and still tap. */
const TOUCH_SLOP = 10;
/** GetDoubleClickTime's default; the distance in game pixels (a finger is wider than SM_CXDOUBLECLK). */
const TOUCH_DOUBLE_MS = 500;
const TOUCH_DOUBLE_DIST = 16;
const TOUCH_SETTLE_FRAMES = 2;
/** Pinch ratio per zoom step, twist angle per rotation step. */
const TOUCH_PINCH = 1.4;
const TOUCH_TWIST = Math.PI / 4;
/** What the hidden text input holds between changes. */
const TEXT_SENTINEL = "~~";

/** A window taking typed text (cTSWinTextEdit2): the on-screen keyboard comes up over it. */
export interface TextInputWindow {
  acceptsTextInput(): boolean;
}

function isTextInput(w: TSWin | null): boolean {
  return !!w && (w as Partial<TextInputWindow>).acceptsTextInput?.() === true;
}

/** A tooltip window: placed and faded in by UnfurlToolTip(rect, t). */
export type ToolTipWindow = TSWin & { unfurlToolTip(rect: Rect, t: number): void };

/** A window with its own tooltip window (an override of cTSWin::GetToolTipsWindow). */
export interface ToolTipsWindowSource {
  getToolTipsWindow(): ToolTipWindow | null;
}

/**
 * A window whose GetToolTipsWindow override recolors the default tooltip
 * (cDefaultTTWindow::SetColor: 0 black, 1 red), e.g. ProductButton.
 */
export interface ToolTipColorSource {
  toolTipColor(): number;
}

/** A window with its own tooltip placement (an override of cTSWin::GetTTPosition). */
export interface TTPositionSource {
  getTTPosition(tt: TSWin, followCursor: boolean): { x: number; y: number };
}

/** The single window manager, like the game's global cTSWinMgrW95 pointer. */
export let winMgr: WinMgr;

export class WinMgr {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly main: TSWin;
  private capture: TSWin | null = null;
  private hover: TSWin | null = null;
  private mouseX = -1;
  private mouseY = -1;
  private buttons = 0;
  /** Keys held (GetKeyState). */
  private readonly keysDown = new Set<string>();
  /** Set by a key handler that consumes a key but lets the browser act on it (keepKeyDefault). */
  private keyDefaultKept = false;
  /** cTSWinMgrW95+0x34: the window keys go to. */
  private focus: TSWin | null = null;
  /** cTSWinMgrW95+0x38: the window of the innermost DoModalWin loop. */
  private modalWin: TSWin | null = null;
  private readonly modal = new Map<TSWin, (result: number) => void>();
  /** Input held while the screen is frozen (screens/frozen.ts: the original is busy, nothing reacts). */
  private inputBlocked = 0;
  /** cTSMainWindowW95::TSOnKeyDown: the main window's keys (the cheat widget shortcut). */
  mainKeyDown: ((key: string) => boolean) | null = null;
  // Tooltips (cTSWinMgrW95+0x194..0x1c1).
  private ttDefault: DefaultTTWindow | null = null;
  private ttTarget: TSWin | null = null;
  private ttState = TT_IDLE;
  private ttTime = 0;
  private ttUnfurlStart = 0;
  private ttPos = { x: 0, y: 0 };
  private ttWindow: ToolTipWindow | null = null;

  constructor(
    host: HTMLElement,
    readonly width: number,
    readonly height: number,
  ) {
    winMgr = this;
    this.canvas = document.createElement("canvas");
    this.canvas.width = width;
    this.canvas.height = height;
    this.canvas.style.imageRendering = "pixelated";
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d", { alpha: false })!;
    this.ctx.imageSmoothingEnabled = false;
    this.main = new TSWin();
    this.main.setArea(0, 0, width, height);
    // cTSMainWindowW95::Init: the main window starts with the focus.
    this.focus = this.main;
    this.fit();
    window.addEventListener("resize", () => this.fit());
    this.bindInput();
    setFocusLostHook((w, parent, hidden) => this.focusLost(w, parent, hidden));
  }

  setCapture(w: TSWin | null): void {
    this.capture = w;
  }

  getCapture(): TSWin | null {
    return this.capture;
  }

  releaseCapture(w: TSWin): void {
    if (this.capture === w) this.capture = null;
  }

  /** The cursor is over the game canvas (EdgeDetectScroller::PreDraw's GetCursorPos / ScreenToClient test). */
  cursorInside = false;

  cursorPosition(): { x: number; y: number } {
    return { x: this.mouseX, y: this.mouseY };
  }

  /** GetKeyState(VK_LBUTTON / VK_RBUTTON) < 0 */
  isMouseButtonDown(): boolean {
    return this.buttons !== 0;
  }

  /** GetKeyState(VK_LBUTTON) < 0 */
  isLeftButtonDown(): boolean {
    return (this.buttons & 1) !== 0;
  }

  /** GetKeyState(key) < 0, by KeyboardEvent.key ("Shift", "Control", ...). */
  /**
   * Called from a tsOnKeyDown that returns true: the key stays consumed but
   * its browser default runs (Ctrl+C / X / V raising the clipboard events).
   */
  keepKeyDefault(): void {
    this.keyDefaultKept = true;
  }

  isKeyDown(key: string): boolean {
    return this.keysDown.has(key);
  }

  /**
   * cTSWinMgrW95::TSSetFocus: the old focus gets message 0x14, the new one 0x15
   * (a button or check box hands the focus on to its parent there).
   */
  setFocus(w: TSWin | null): void {
    const prev = this.focus;
    prev?.tsOnKillFocus(w);
    this.focus = w;
    w?.tsOnSetFocus(prev);
  }

  /** The window would take the focus (cTSWin::GetAcceptFocus: no 0x2000 flag). */
  static acceptsFocus(w: TSWin): boolean {
    return !w.getFlag(WF_NO_FOCUS);
  }

  /** `setFocus(w)` when it accepts the focus, else nothing (the TSSetFocus / TSGetFocus pairs). */
  offerFocus(w: TSWin | null): void {
    if (w && WinMgr.acceptsFocus(w) && this.isAttached(w)) this.setFocus(w);
  }

  /** In the window tree (cTSWinMgrW95::IsWindowValid: not destroyed). */
  private isAttached(w: TSWin): boolean {
    let p: TSWin = w;
    while (p.parent) p = p.parent;
    return p === this.main;
  }

  /**
   * cTSWin::child_remove_absolute / HideWindow: a removed window holding the
   * focus gives it to its parent; a hidden one to its parent when it accepts
   * it (the main window without a parent). A focus inside a removed or hidden
   * subtree goes the same way (the original leaves it on a destroyed window).
   */
  private focusLost(w: TSWin, parent: TSWin | null, hidden: boolean): void {
    let f = this.focus;
    while (f && f !== w) f = f.parent;
    if (!f) return;
    if (!hidden) {
      this.setFocus(parent);
      return;
    }
    const to = parent ?? this.main;
    if (WinMgr.acceptsFocus(to)) this.setFocus(to);
  }

  /** Holds key input (whileFrozen); balanced by unblockInput. */
  blockInput(): void {
    this.inputBlocked++;
  }

  unblockInput(): void {
    this.inputBlocked = Math.max(0, this.inputBlocked - 1);
  }

  getFocus(): TSWin | null {
    return this.focus;
  }

  // --- modal windows (cTSWinMgrW95::DoModalWin, cTSWinDlg::TSEndDialog) -----

  /**
   * Adds `win` in front of `parent` and routes all input to it until
   * endDialog(win, result); resolves with that result.
   */
  doModalWin(win: TSWin, parent: TSWin = this.main): Promise<number> {
    this.hover?.tsOnMouseExit();
    this.hover = null;
    this.untriggerToolTips();
    parent.childAdd(win);
    win.setFlag(WF_MODAL, true);
    if (this.capture && this.capture !== win) this.capture = null;
    // DoModalWin: the global cursor (+0x1c4 / +0x1c8) is cleared for the loop and restored after.
    const global = this.globalCursor;
    const globalForced = this.globalForced;
    this.setGlobalCursor(null, true);
    // DoModalWin: the modal window becomes +0x38 and the focus (+0x34, set directly).
    const focus = this.focus;
    const outer = this.modalWin;
    this.modalWin = win;
    this.focus = win;
    win.tsBeginModal();
    return new Promise((resolve) => {
      this.modal.set(win, (result) => {
        // The outer loop's window comes back, and the old focus if it still exists.
        this.modalWin = outer;
        this.setGlobalCursor(global, globalForced);
        this.setFocus(focus && this.isAttached(focus) ? focus : outer);
        resolve(result);
      });
    });
  }

  /** Ends a doModalWin loop (the 0x10 "end dialog" message). */
  endDialog(win: TSWin, result: number): void {
    const done = this.modal.get(win);
    if (!done) return;
    this.modal.delete(win);
    win.tsEndModal();
    win.setFlag(WF_MODAL, false);
    this.releaseCapture(win);
    win.parent?.childRemove(win);
    done(result);
  }

  // --- tooltips (cTSWinMgrW95::HandleMouseEnterExit / SetupToolTipsWindow) ---

  /** Installs the tooltip window (GetDefaultTTWindow); tooltips stay off without it. */
  setDefaultTTWindow(w: DefaultTTWindow): void {
    this.ttDefault = w;
  }

  /** cTSWin::GetTTPosition: left edge and top of the tooltip for `w`. */
  getTTPosition(w: TSWin, tt: TSWin, followCursor: boolean): { x: number; y: number } {
    const custom = (w as Partial<TTPositionSource>).getTTPosition;
    if (custom) return custom.call(w, tt, followCursor);
    const o = w.absOrigin();
    const right = o.x + w.getW();
    const bottom = o.y + w.getH();
    const x = followCursor ? Math.min(Math.max(o.x, this.mouseX), right - 1) : Math.trunc((o.x + right) / 2);
    let y = o.y - tt.getH() - 1;
    if (y < 3) y = bottom + 2;
    return { x, y };
  }

  /**
   * cTSWin::GetToolTipsWindow: the default window showing `w`'s text, unless
   * the window overrides it (ToolTipsWindowSource, e.g. cPickFamilyItemMember).
   */
  private getToolTipsWindow(w: TSWin): ToolTipWindow | null {
    const custom = (w as Partial<ToolTipsWindowSource>).getToolTipsWindow?.();
    if (custom) return custom;
    this.ttDefault?.setToolTip(w.tooltip, (w as Partial<ToolTipColorSource>).toolTipColor?.() ?? 0);
    return this.ttDefault;
  }

  private hasToolTip(w: TSWin | null): boolean {
    return !!w && w.isVisible() && w.tooltip !== "";
  }

  /** cTSWinMgrW95::TriggerToolTips: advances the state machine (used by the lot view). */
  triggerToolTips(): void {
    const w = this.ttTarget;
    if (!w) return;
    const now = performance.now();
    if (this.ttState === TT_UNFURLING) {
      this.ttState = TT_SHOWN;
      this.ttTime = now;
    } else if (this.ttState === TT_IDLE) {
      this.ttState = TT_WAITING;
      this.ttTime = now;
    } else if (this.ttState === TT_SHOWN) {
      this.ttState = TT_UNFURLING;
      this.ttUnfurlStart = now;
    }
    this.openToolTip(w);
  }

  /** cTSWinMgrW95::UntriggerToolTips */
  untriggerToolTips(): void {
    this.ttState = TT_IDLE;
    this.ttWindow = null;
  }

  private openToolTip(w: TSWin): void {
    this.ttWindow = null;
    if (!this.hasToolTip(w)) return;
    this.ttWindow = this.getToolTipsWindow(w);
    if (this.ttWindow) this.ttPos = this.getTTPosition(w, this.ttWindow, false);
  }

  /** cTSWinMgrW95::HandleMouseEnterExit (the tooltip part). */
  private toolTipHover(w: TSWin | null): void {
    const now = performance.now();
    const tip = this.hasToolTip(w);
    if (this.ttState === TT_UNFURLING) {
      this.ttState = TT_SHOWN;
    } else if (this.ttState === TT_IDLE) {
      this.ttState = TT_WAITING;
    } else if (this.ttState === TT_SHOWN) {
      if (!tip) {
        if (!w || now - this.ttTime > w.tooltipDelay) this.ttState = TT_WAITING;
      } else {
        this.ttState = TT_UNFURLING;
        this.ttUnfurlStart = now;
      }
    }
    this.ttTarget = w;
    this.ttTime = now;
    this.ttWindow = null;
    if (w) this.openToolTip(w);
  }

  /** cTSWinMgrW95::SetupToolTipsWindow: per-frame timing; true when the tooltip shows. */
  private setupToolTipsWindow(now: number): boolean {
    const w = this.ttTarget;
    const tt = this.ttWindow;
    if (w && this.hasToolTip(w)) {
      if (this.ttState === TT_WAITING && w.tooltipDelay <= now - this.ttTime) {
        this.ttState = TT_UNFURLING;
        this.ttUnfurlStart = now;
        if (tt) this.ttPos = this.getTTPosition(w, tt, true);
      } else if (this.ttState === TT_SHOWN && now - this.ttTime > TT_SHOW_MS) {
        this.ttState = TT_IDLE;
      }
    } else if (w && this.ttState === TT_SHOWN && w.tooltipDelay <= now - this.ttTime) {
      this.ttState = TT_WAITING;
      this.ttTime = now;
    }
    if (!tt) return false;
    const h = tt.getH();
    const r: Rect = { left: 0, top: 0, right: tt.getW(), bottom: h };
    let t = 1;
    let visible = false;
    if (this.ttState === TT_UNFURLING && w) {
      const elapsed = now - this.ttUnfurlStart;
      if (elapsed < w.tooltipUnfurl && w.tooltipUnfurl !== 0) {
        t = elapsed / w.tooltipUnfurl;
        const shown = Math.trunc(h * t + 0.5);
        r.left += this.ttPos.x;
        r.right += this.ttPos.x;
        r.top = this.ttPos.y + h - shown;
        r.bottom = this.ttPos.y + h;
        visible = r.bottom - r.top > 0;
      } else {
        this.ttState = TT_SHOWN;
        this.ttTime = now;
      }
    }
    if (this.ttState === TT_SHOWN) {
      visible = true;
      t = 1;
      r.left = this.ttPos.x;
      r.right = this.ttPos.x + tt.getW();
      r.top = this.ttPos.y;
      r.bottom = this.ttPos.y + h;
    }
    if (!visible) return false;
    // Keep it on screen.
    let dx = 0;
    let dy = 0;
    if (r.left < 0) dx = -r.left;
    else if (this.width <= r.right) dx = this.width - r.right - 1;
    if (r.top < 0) dy = -r.top;
    else if (this.height <= r.bottom) dy = this.height - r.bottom - 1;
    r.left += dx;
    r.right += dx;
    r.top += dy;
    r.bottom += dy;
    tt.unfurlToolTip(r, t);
    return true;
  }

  start(): void {
    const frame = (t: number): void => {
      this.pumpTouch();
      this.main.pump(t);
      this.ctx.fillStyle = "#000";
      this.ctx.fillRect(0, 0, this.width, this.height);
      this.main.plot(this.ctx, 0, 0);
      // cTSWinMgrW95::Plot: the tooltip is drawn over everything.
      if (this.setupToolTipsWindow(t)) this.ttWindow?.plot(this.ctx, 0, 0);
      // cTSWin::SetCursor pumps a mouse move (PumpMouseMoveMsg): a window's new cursor shows at once.
      this.applyCursor();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  /**
   * The canvas keeps the game's resolution, scaled to the page with its
   * aspect ratio (black bars). With the on-screen keyboard up (touch), the
   * game fits the visible part of the page above it.
   */
  private fit(): void {
    const host = this.canvas.parentElement;
    const vv = this.textInput && document.activeElement === this.textInput ? window.visualViewport : null;
    if (host) {
      host.style.top = vv ? `${vv.offsetTop}px` : "";
      host.style.height = vv ? `${vv.height}px` : "";
      host.style.bottom = vv ? "auto" : "";
    }
    const w = vv?.width ?? window.innerWidth;
    const h = vv?.height ?? window.innerHeight;
    const scale = Math.min(w / this.width, h / this.height);
    this.canvas.style.width = `${Math.floor(this.width * scale)}px`;
    this.canvas.style.height = `${Math.floor(this.height * scale)}px`;
  }

  private toLogical(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: Math.floor(((e.clientX - r.left) * this.width) / r.width),
      y: Math.floor(((e.clientY - r.top) * this.height) / r.height),
    };
  }

  /** Target window and coordinates relative to it. */
  private route(x: number, y: number): { win: TSWin; x: number; y: number } | null {
    let win = this.capture;
    if (!win) {
      // A visible modal top-level window swallows input aimed elsewhere.
      const modal = this.main.children.find((c) => c.isVisible() && c.getFlag(WF_MODAL));
      const root = modal ?? this.main;
      const o = root.absOrigin();
      win = root.windowFromPoint(x - o.x, y - o.y) ?? (modal ? modal : null);
    }
    if (!win) return null;
    const o = win.absOrigin();
    return { win, x: x - o.x, y: y - o.y };
  }

  /** cTSWinMgrW95+0x1c4: the global cursor; +0x1c8: it was set forced. */
  private globalCursor: string | null = null;
  private globalForced = false;

  /**
   * cTSWinMgrW95::SetGlobalCursor(cursor, forced): a cursor over the windows'
   * own (null = theirs again). A forced one shows everywhere and can only be
   * replaced or cleared by another forced call; an unforced one only over
   * windows flagged WF_GLOBAL_CURSOR (the lot view).
   */
  getGlobalCursor(): string | null {
    return this.globalCursor;
  }

  setGlobalCursor(cursor: string | null, forced = true): void {
    if (!this.globalForced) {
      this.globalCursor = cursor;
      this.globalForced = cursor !== null && forced;
    } else if (forced) {
      this.globalCursor = cursor;
      if (cursor === null) this.globalForced = false;
    }
    this.applyCursor();
  }

  /**
   * cTSWin::UpdateCursor on the capture window, else on the window under the
   * mouse: the first cursor up the parent chain (cTSWin::SetCursor), the
   * main window's being the standard arrow; hidden (cTSWin::HideCursor,
   * flag 0x800) on the way; then cTSWinMgrW95::SetCursor puts the global
   * cursor over it when forced or when that window takes it (0x20000).
   */
  applyCursor(): void {
    let c: string | null = null;
    let owner: TSWin | null = null;
    for (let w = this.capture ?? this.hover; w; w = w.parent) {
      if (w.getFlag(WF_HIDE_CURSOR)) {
        c = HIDDEN_CURSOR;
        break;
      }
      if (w.winCursor) {
        c = w.winCursor;
        owner = w;
        break;
      }
    }
    if (c === null) c = getStandardCursor(0);
    const g = this.globalCursor;
    if (g && c !== HIDDEN_CURSOR && (this.globalForced || owner?.getFlag(WF_GLOBAL_CURSOR))) c = g;
    const v = c ?? "";
    if (this.canvas.style.cursor !== v) this.canvas.style.cursor = v;
  }

  private updateHover(x: number, y: number): void {
    const t = this.route(x, y);
    const under = this.capture ? this.main.windowFromPoint(x, y) : (t?.win ?? null);
    if (under !== this.hover) {
      this.hover?.tsOnMouseExit();
      this.hover = under;
      under?.tsOnMouseEnter();
      this.toolTipHover(under);
    }
    this.applyCursor();
  }

  /** Deliver to the window, bubbling to parents until someone handles it. */
  private dispatch(x: number, y: number, call: (w: TSWin, wx: number, wy: number) => boolean): void {
    const t = this.route(x, y);
    if (!t) return;
    let w: TSWin | null = t.win;
    let wx = t.x;
    let wy = t.y;
    while (w) {
      if (call(w, wx, wy)) return;
      wx += w.area.left;
      wy += w.area.top;
      w = this.capture ? null : w.parent;
    }
  }

  // --- pointer input (the mouse, and the touch mapping below) -----------------

  private pointerMove(x: number, y: number): void {
    this.cursorInside = true;
    this.mouseX = x;
    this.mouseY = y;
    this.updateHover(x, y);
    this.dispatch(x, y, (w, wx, wy) => w.tsOnMouseMove(wx, wy));
  }

  /**
   * A button press; `double` is the second press of a double click
   * (WM_LBUTTONDBLCLK / WM_RBUTTONDBLCLK: the game's window class has
   * CS_DBLCLKS, ConvertNativeMsgToTSMsg makes them messages 9 / 10).
   */
  private pointerDown(button: number, x: number, y: number, double: boolean): void {
    // cTSWin::ProcessCursorMessage (and the capture branch of ProcessSystemMessage):
    // a button press (7 / 8, not a double click) gives the focus to the window under it when it accepts it.
    if (!double && (button === 0 || button === 2)) this.offerFocus(this.route(x, y)?.win ?? null);
    if (button === 0) this.dispatch(x, y, (w, wx, wy) => (double ? w.tsOnMouseDoubleL(wx, wy) : w.tsOnMouseDownL(wx, wy)));
    if (button === 2) this.dispatch(x, y, (w, wx, wy) => (double ? w.tsOnMouseDoubleR(wx, wy) : w.tsOnMouseDownR(wx, wy)));
  }

  private pointerUp(button: number, x: number, y: number): void {
    if (button === 0) this.dispatch(x, y, (w, wx, wy) => w.tsOnMouseUpL(wx, wy));
    if (button === 2) this.dispatch(x, y, (w, wx, wy) => w.tsOnMouseUpR(wx, wy));
    this.updateHover(x, y);
  }

  private pointerLeave(): void {
    this.cursorInside = false;
    this.hover?.tsOnMouseExit();
    this.hover = null;
  }

  /** Key messages: to the focus, up its parents (see bindInput). True when consumed. */
  private keyDown(key: string): boolean {
    // cTSWinMgrW95::ProcessSystemMessage: key messages (4..6) go to the focus
    // only; cTSWin::TSOnKeyDown passes what a window leaves to its parent, up
    // to the main window (cTSMainWindowW95::TSOnKeyDown).
    for (let w = this.focus; w; w = w.parent) {
      if (w === this.main ? this.mainKeyDown?.(key) : w.tsOnKeyDown(key)) return true;
    }
    return false;
  }

  private keyUp(key: string): boolean {
    // cTSWinMgrW95::ProcessSystemMessage: key up messages go to the focus too, up its parents.
    for (let w = this.focus; w && w !== this.main; w = w.parent) if (w.tsOnKeyUp(key)) return true;
    return false;
  }

  private bindInput(): void {
    const c = this.canvas;
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener("mousemove", (e) => {
      const p = this.toLogical(e);
      this.pointerMove(p.x, p.y);
    });
    c.addEventListener("mousedown", (e) => {
      this.buttons = e.buttons;
      const p = this.toLogical(e);
      // The browser's click count: Windows follows a double click with a plain press.
      this.pointerDown(e.button, p.x, p.y, e.detail >= 2 && e.detail % 2 === 0);
    });
    window.addEventListener("mouseup", (e) => {
      this.buttons = e.buttons;
      const p = this.toLogical(e);
      this.pointerUp(e.button, p.x, p.y);
    });
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const p = this.toLogical(e);
        this.dispatch(p.x, p.y, (w, x, y) => w.tsOnMouseWheel(x, y, Math.sign(e.deltaY)));
      },
      { passive: false },
    );
    window.addEventListener("keydown", (e) => this.keysDown.add(e.key));
    window.addEventListener("keyup", (e) => this.keysDown.delete(e.key));
    window.addEventListener("blur", () => this.keysDown.clear());
    window.addEventListener("keydown", (e) => {
      if (this.inputBlocked) {
        e.preventDefault();
        return;
      }
      this.keyDefaultKept = false;
      if (this.keyDown(e.key)) {
        if (!this.keyDefaultKept) e.preventDefault();
        this.keyDefaultKept = false;
        return;
      }
      // Firefox opens its Quick Find bar on "/" and "'" (which then takes
      // every key); the game page has no text to search.
      if ((e.key === "/" || e.key === "'") && !e.ctrlKey && !e.altKey && !e.metaKey) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => {
      if (this.inputBlocked) return;
      if (this.keyUp(e.key)) e.preventDefault();
    });
    c.addEventListener("mouseleave", () => this.pointerLeave());
    this.bindTouch();
  }

  // --- touch screens -----------------------------------------------------------
  //
  // Not in the original (a mouse game): touches are turned into the mouse
  // and key messages above, so every window keeps its own behavior.
  //  - a finger down hovers (enter / exit, tooltips, live popups);
  //  - a tap is a left click, two quick taps a double click;
  //  - moving before the long press time is a left drag from the start point;
  //  - a long press on a window with a right button handler (the lot view,
  //    the pie menu, the people panel, ...) is a right press, dragging on is
  //    the right drag (the lot's explore scroll), lifting is the release;
  //    elsewhere it only hovers (tooltips) and lifting clicks nothing;
  //  - two fingers: the pan of the Alt key (the lot follows the fingers),
  //    pinching zooms one step per TOUCH_PINCH ratio ('+' / '-'), twisting
  //    rotates one step per TOUCH_TWIST ('.' clockwise / ',');
  //  - lifting the last finger is a mouse leave (no hover, no edge scroll).
  // Presses wait TOUCH_SETTLE_FRAMES after the hover move so the views pick
  // what is under the finger (the people's picking happens while drawing).
  // A hidden <input> brings up the on-screen keyboard over a text field.

  /** A touch was seen: the hidden text input and the keyboard viewport are in use. */
  private touchMode = false;
  private readonly touches = new Map<number, { x: number; y: number }>();
  private touchPrimary = -1;
  private touchState: "idle" | "pending" | "left" | "right" | "hover" | "gesture" | "done" = "idle";
  private touchStart = { x: 0, y: 0 };
  private touchLast = { x: 0, y: 0 };
  private touchTimer = 0;
  private lastTap = { t: -Infinity, x: 0, y: 0 };
  private gestureDist = 0;
  private gestureAngle = 0;
  private gestureKeys = false;
  private readonly touchQueue: Array<{ press: boolean; move: boolean; run: () => void }> = [];
  private frameCount = 0;
  private moveFrame = -Infinity;
  private textInput: HTMLInputElement | null = null;
  private textValue = "";
  private composing = false;

  private bindTouch(): void {
    const c = this.canvas;
    const opts = { passive: false };
    c.addEventListener("touchstart", (e) => this.onTouchStart(e), opts);
    c.addEventListener("touchmove", (e) => this.onTouchMove(e), opts);
    c.addEventListener("touchend", (e) => this.onTouchEnd(e, false), opts);
    c.addEventListener("touchcancel", (e) => this.onTouchEnd(e, true), opts);
  }

  private clientToLogical(p: { x: number; y: number }): { x: number; y: number } {
    return this.toLogical({ clientX: p.x, clientY: p.y });
  }

  /** Queues a synthesized message; presses wait for the hover move to be drawn. */
  private touchPost(run: () => void, kind: "press" | "move" | "other" = "other"): void {
    this.touchQueue.push({ press: kind === "press", move: kind === "move", run });
    this.flushTouch();
  }

  private flushTouch(): void {
    for (let e = this.touchQueue[0]; e; e = this.touchQueue[0]) {
      if (e.press && this.frameCount - this.moveFrame < TOUCH_SETTLE_FRAMES) return;
      this.touchQueue.shift();
      e.run();
      if (e.move) this.moveFrame = this.frameCount;
    }
  }

  private touchMoveTo(p: { x: number; y: number }): void {
    const l = this.clientToLogical(p);
    this.touchPost(() => this.pointerMove(l.x, l.y), "move");
  }

  private touchPress(button: number, p: { x: number; y: number }, double = false): void {
    const l = this.clientToLogical(p);
    this.touchPost(() => {
      this.buttons |= button === 0 ? 1 : 2;
      this.pointerDown(button, l.x, l.y, double);
    }, "press");
  }

  private touchRelease(button: number, p: { x: number; y: number }): void {
    const l = this.clientToLogical(p);
    this.touchPost(() => {
      this.buttons &= button === 0 ? ~1 : ~2;
      this.pointerUp(button, l.x, l.y);
    });
  }

  /** The end of a touch: the mouse leaves, the tooltip goes. */
  private touchLeave(): void {
    this.touchPost(() => {
      this.pointerLeave();
      this.untriggerToolTips();
      this.ttTarget = null;
    });
  }

  private onTouchStart(e: TouchEvent): void {
    e.preventDefault();
    this.touchMode = true;
    this.ensureTextInput();
    for (const t of Array.from(e.changedTouches)) this.touches.set(t.identifier, { x: t.clientX, y: t.clientY });
    if (this.touchState === "idle" && this.touches.size === 1) {
      const t = e.changedTouches[0]!;
      this.touchPrimary = t.identifier;
      this.touchStart = { x: t.clientX, y: t.clientY };
      this.touchLast = this.touchStart;
      this.touchState = "pending";
      this.touchMoveTo(this.touchStart);
      this.touchTimer = window.setTimeout(() => this.onLongPress(), TOUCH_LONG_PRESS_MS);
    } else if (this.touchState === "pending" && this.touches.size === 2) {
      clearTimeout(this.touchTimer);
      this.startGesture();
    }
  }

  private onLongPress(): void {
    if (this.touchState !== "pending") return;
    const l = this.clientToLogical(this.touchStart);
    const w = this.route(l.x, l.y)?.win ?? null;
    if (w && w.tsOnMouseDownR !== TSWin.prototype.tsOnMouseDownR) {
      this.touchState = "right";
      this.touchPress(2, this.touchStart);
    } else {
      this.touchState = "hover";
    }
  }

  private onTouchMove(e: TouchEvent): void {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) if (this.touches.has(t.identifier)) this.touches.set(t.identifier, { x: t.clientX, y: t.clientY });
    const p = this.touches.get(this.touchPrimary);
    if (this.touchState === "gesture") {
      this.updateGesture();
      return;
    }
    if (!p) return;
    this.touchLast = p;
    if (this.touchState === "pending") {
      if (Math.hypot(p.x - this.touchStart.x, p.y - this.touchStart.y) <= TOUCH_SLOP) return;
      clearTimeout(this.touchTimer);
      this.touchState = "left";
      this.touchPress(0, this.touchStart);
    }
    if (this.touchState === "left" || this.touchState === "right" || this.touchState === "hover") this.touchMoveTo(p);
  }

  private onTouchEnd(e: TouchEvent, cancel: boolean): void {
    e.preventDefault();
    let primaryUp = false;
    for (const t of Array.from(e.changedTouches)) {
      this.touches.delete(t.identifier);
      if (t.identifier === this.touchPrimary) primaryUp = true;
    }
    switch (this.touchState) {
      case "pending":
        if (!primaryUp) break;
        clearTimeout(this.touchTimer);
        if (!cancel) this.tap();
        this.touchLeave();
        this.touchState = "done";
        break;
      case "left":
      case "right":
        if (!primaryUp) break;
        this.touchRelease(this.touchState === "left" ? 0 : 2, this.touchLast);
        this.touchLeave();
        this.touchState = "done";
        break;
      case "hover":
        if (!primaryUp) break;
        this.touchLeave();
        this.touchState = "done";
        break;
      case "gesture":
        // One finger lifted: the gesture ends (the other finger alone would make the pan jump).
        this.endGesture();
        this.touchState = "done";
        break;
      default:
        break;
    }
    if (this.touches.size === 0) this.touchState = "idle";
  }

  private tap(): void {
    const p = this.touchStart;
    const l = this.clientToLogical(p);
    const now = performance.now();
    const double = now - this.lastTap.t <= TOUCH_DOUBLE_MS && Math.hypot(l.x - this.lastTap.x, l.y - this.lastTap.y) <= TOUCH_DOUBLE_DIST;
    // A double tap ends the click count (Windows: down, double, down, double...).
    this.lastTap = double ? { t: -Infinity, x: 0, y: 0 } : { t: now, x: l.x, y: l.y };
    // The on-screen keyboard only opens from the tap's own event handler.
    if (isTextInput(this.route(l.x, l.y)?.win ?? null)) this.focusTextInput();
    this.touchPress(0, p, double);
    this.touchRelease(0, p);
  }

  private gestureCenter(): { x: number; y: number; dist: number; angle: number } | null {
    const [a, b] = Array.from(this.touches.values());
    if (!a || !b) return null;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, dist: Math.hypot(b.x - a.x, b.y - a.y), angle: Math.atan2(b.y - a.y, b.x - a.x) };
  }

  private startGesture(): void {
    const g = this.gestureCenter();
    if (!g) return;
    this.touchState = "gesture";
    this.gestureDist = Math.max(1, g.dist);
    this.gestureAngle = g.angle;
    const l = this.clientToLogical(g);
    this.touchMoveTo(g);
    this.touchPost(() => {
      // Like a press there, the window under the fingers takes the focus (the
      // lot view gets the keys); none while a text field would type them.
      this.offerFocus(this.route(l.x, l.y)?.win ?? null);
      this.gestureKeys = !isTextInput(this.focus);
      if (this.gestureKeys) this.keyDown("Alt");
      // Queued as a press: the pan starts once the move to the fingers' center
      // has been drawn (EdgeDetectScroller::PreDraw measures from the last frame).
    }, "press");
  }

  private updateGesture(): void {
    const g = this.gestureCenter();
    if (!g) return;
    this.touchMoveTo(g);
    const key = (k: string): void => this.touchPost(() => void (this.gestureKeys && this.keyDown(k)));
    const ratio = g.dist / this.gestureDist;
    if (ratio >= TOUCH_PINCH || ratio <= 1 / TOUCH_PINCH) {
      key(ratio > 1 ? "+" : "-");
      this.gestureDist = Math.max(1, g.dist);
    }
    let turn = g.angle - this.gestureAngle;
    if (turn > Math.PI) turn -= 2 * Math.PI;
    if (turn < -Math.PI) turn += 2 * Math.PI;
    if (Math.abs(turn) >= TOUCH_TWIST) {
      key(turn > 0 ? "." : ",");
      this.gestureAngle = g.angle;
    }
  }

  private endGesture(): void {
    this.touchPost(() => {
      if (this.gestureKeys) this.keyUp("Alt");
      this.gestureKeys = false;
    });
    this.touchLeave();
  }

  // --- the on-screen keyboard ----------------------------------------------------

  /**
   * A hidden text input, focused when a tap lands on a text field: the
   * keyboard's characters (which often come as input events rather than
   * key events) reach the focus as keys. The input always holds a short
   * sentinel so Backspace has something to delete; each change is diffed
   * into Backspaces and characters.
   */
  private ensureTextInput(): void {
    if (this.textInput) return;
    const input = document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("autocorrect", "off");
    input.setAttribute("aria-hidden", "true");
    input.tabIndex = -1;
    // 16px: no zoom on focus (iOS); off screen to the left, nothing shows.
    Object.assign(input.style, { position: "fixed", left: "-1000px", top: "0", width: "1px", height: "1px", opacity: "0", fontSize: "16px", border: "0", padding: "0" });
    input.addEventListener("input", () => this.onTextInput());
    input.addEventListener("compositionstart", () => (this.composing = true));
    input.addEventListener("compositionend", () => {
      this.composing = false;
      this.onTextInput();
    });
    input.addEventListener("focus", () => this.fit());
    input.addEventListener("blur", () => this.fit());
    window.visualViewport?.addEventListener("resize", () => this.fit());
    this.canvas.parentElement?.appendChild(input);
    this.textInput = input;
    this.resetTextInput();
  }

  private resetTextInput(): void {
    const input = this.textInput;
    if (!input) return;
    input.value = TEXT_SENTINEL;
    this.textValue = TEXT_SENTINEL;
    input.setSelectionRange(TEXT_SENTINEL.length, TEXT_SENTINEL.length);
  }

  private focusTextInput(): void {
    const input = this.textInput;
    if (!input) return;
    // Refocusing brings the keyboard back after the system closed it.
    if (document.activeElement === input) input.blur();
    this.resetTextInput();
    input.focus({ preventScroll: true });
  }

  private onTextInput(): void {
    const input = this.textInput;
    if (!input) return;
    const v = input.value;
    const old = this.textValue;
    let same = 0;
    while (same < old.length && same < v.length && old[same] === v[same]) same++;
    this.textValue = v;
    if (!this.inputBlocked) {
      for (let i = same; i < old.length; i++) this.keyDown("Backspace");
      for (const ch of v.slice(same)) this.keyDown(ch === "\n" ? "Enter" : ch);
    }
    if (!this.composing && (v.length > 32 || !v.startsWith(TEXT_SENTINEL))) this.resetTextInput();
  }

  /** Each frame: the queued touch messages, and the keyboard goes when the focus leaves the text. */
  private pumpTouch(): void {
    this.frameCount++;
    if (!this.touchMode) return;
    this.flushTouch();
    const input = this.textInput;
    if (input && document.activeElement === input && !isTextInput(this.focus)) input.blur();
  }
}
