/**
 * Window manager (cTSWinMgrW95): owns the screen canvas and the main window,
 * routes mouse input (capture first, then the front-most window under the
 * cursor), tracks mouse enter/exit and drives the paint loop.
 *
 * The canvas has the game's logical resolution (800x600 or 1024x768) and is
 * scaled by CSS to fit the browser window with integer-free nearest scaling.
 */

import { setFocusLostHook, TSWin, WF_MODAL, WF_NO_FOCUS, type Rect } from "./tswin.js";
import type { DefaultTTWindow } from "./ttwindow.js";

/** Tooltip states (cTSWinMgrW95+0x198). */
const TT_IDLE = 0;
const TT_WAITING = 1;
const TT_UNFURLING = 2;
const TT_SHOWN = 3;
/** A shown tooltip goes away after this long (SetupToolTipsWindow). */
const TT_SHOW_MS = 5000;

/** A tooltip window: placed and faded in by UnfurlToolTip(rect, t). */
export type ToolTipWindow = TSWin & { unfurlToolTip(rect: Rect, t: number): void };

/** A window with its own tooltip window (an override of cTSWin::GetToolTipsWindow). */
export interface ToolTipsWindowSource {
  getToolTipsWindow(): ToolTipWindow | null;
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

  cursorPosition(): { x: number; y: number } {
    return { x: this.mouseX, y: this.mouseY };
  }

  /** GetKeyState(VK_LBUTTON / VK_RBUTTON) < 0 */
  isMouseButtonDown(): boolean {
    return this.buttons !== 0;
  }

  /** GetKeyState(key) < 0, by KeyboardEvent.key ("Shift", "Control", ...). */
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
    this.ttDefault?.setToolTip(w.tooltip, 0);
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
      this.main.pump(t);
      this.ctx.fillStyle = "#000";
      this.ctx.fillRect(0, 0, this.width, this.height);
      this.main.plot(this.ctx, 0, 0);
      // cTSWinMgrW95::Plot: the tooltip is drawn over everything.
      if (this.setupToolTipsWindow(t)) this.ttWindow?.plot(this.ctx, 0, 0);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  private fit(): void {
    const scale = Math.min(window.innerWidth / this.width, window.innerHeight / this.height);
    this.canvas.style.width = `${Math.floor(this.width * scale)}px`;
    this.canvas.style.height = `${Math.floor(this.height * scale)}px`;
  }

  private toLogical(e: MouseEvent): { x: number; y: number } {
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

  /** cTSWinMgrW95::SetGlobalCursor: a cursor shown everywhere (null = the windows' own). */
  private globalCursor: string | null = null;

  setGlobalCursor(cursor: string | null): void {
    this.globalCursor = cursor;
    this.applyCursor();
  }

  /** The hovered window's cursor (cTSWin::SetCursor, inherited from the parents), or the global one. */
  applyCursor(): void {
    let c = this.globalCursor;
    for (let w = this.hover; !c && w; w = w.parent) c = w.winCursor;
    const v = c ?? "";
    if (this.canvas.style.cursor !== v) this.canvas.style.cursor = v;
  }

  private updateHover(x: number, y: number): void {
    const t = this.route(x, y);
    const under = this.capture ? this.main.windowFromPoint(x, y) : (t?.win ?? null);
    this.applyCursorFor(under);
    if (under === this.hover) return;
    this.hover?.tsOnMouseExit();
    this.hover = under;
    under?.tsOnMouseEnter();
    this.toolTipHover(under);
  }

  private applyCursorFor(under: TSWin | null): void {
    let c = this.globalCursor;
    for (let w = under; !c && w; w = w.parent) c = w.winCursor;
    const v = c ?? "";
    if (this.canvas.style.cursor !== v) this.canvas.style.cursor = v;
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

  private bindInput(): void {
    const c = this.canvas;
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener("mousemove", (e) => {
      const p = this.toLogical(e);
      this.mouseX = p.x;
      this.mouseY = p.y;
      this.updateHover(p.x, p.y);
      this.dispatch(p.x, p.y, (w, x, y) => w.tsOnMouseMove(x, y));
    });
    c.addEventListener("mousedown", (e) => {
      this.buttons = e.buttons;
      const p = this.toLogical(e);
      // cTSWin::ProcessCursorMessage (and the capture branch of ProcessSystemMessage):
      // a button press gives the focus to the window under it when it accepts it.
      if (e.button === 0 || e.button === 2) this.offerFocus(this.route(p.x, p.y)?.win ?? null);
      if (e.button === 0) this.dispatch(p.x, p.y, (w, x, y) => w.tsOnMouseDownL(x, y));
      if (e.button === 2) this.dispatch(p.x, p.y, (w, x, y) => w.tsOnMouseDownR(x, y));
    });
    window.addEventListener("mouseup", (e) => {
      this.buttons = e.buttons;
      const p = this.toLogical(e);
      if (e.button === 0) this.dispatch(p.x, p.y, (w, x, y) => w.tsOnMouseUpL(x, y));
      if (e.button === 2) this.dispatch(p.x, p.y, (w, x, y) => w.tsOnMouseUpR(x, y));
      this.updateHover(p.x, p.y);
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
      // cTSWinMgrW95::ProcessSystemMessage: key messages (4..6) go to the focus
      // only; cTSWin::TSOnKeyDown passes what a window leaves to its parent, up
      // to the main window (cTSMainWindowW95::TSOnKeyDown).
      for (let w = this.focus; w; w = w.parent) {
        if (w === this.main ? this.mainKeyDown?.(e.key) : w.tsOnKeyDown(e.key)) {
          e.preventDefault();
          return;
        }
      }
      // Firefox opens its Quick Find bar on "/" and "'" (which then takes
      // every key); the game page has no text to search.
      if ((e.key === "/" || e.key === "'") && !e.ctrlKey && !e.altKey && !e.metaKey) e.preventDefault();
    });
    c.addEventListener("mouseleave", () => {
      this.hover?.tsOnMouseExit();
      this.hover = null;
    });
  }
}
