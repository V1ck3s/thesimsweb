/**
 * Window manager (cTSWinMgrW95): owns the screen canvas and the main window,
 * routes mouse input (capture first, then the front-most window under the
 * cursor), tracks mouse enter/exit and drives the paint loop.
 *
 * The canvas has the game's logical resolution (800x600 or 1024x768) and is
 * scaled by CSS to fit the browser window with integer-free nearest scaling.
 */

import { TSWin, WF_MODAL } from "./tswin.js";

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
    this.fit();
    window.addEventListener("resize", () => this.fit());
    this.bindInput();
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

  start(): void {
    const frame = (t: number): void => {
      this.main.pump(t);
      this.ctx.fillStyle = "#000";
      this.ctx.fillRect(0, 0, this.width, this.height);
      this.main.plot(this.ctx, 0, 0);
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

  private updateHover(x: number, y: number): void {
    const t = this.route(x, y);
    const under = this.capture ? this.main.windowFromPoint(x, y) : (t?.win ?? null);
    if (under === this.hover) return;
    this.hover?.tsOnMouseExit();
    this.hover = under;
    under?.tsOnMouseEnter();
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
      const p = this.toLogical(e);
      if (e.button === 0) this.dispatch(p.x, p.y, (w, x, y) => w.tsOnMouseDownL(x, y));
      if (e.button === 2) this.dispatch(p.x, p.y, (w, x, y) => w.tsOnMouseDownR(x, y));
    });
    window.addEventListener("mouseup", (e) => {
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
    c.addEventListener("mouseleave", () => {
      this.hover?.tsOnMouseExit();
      this.hover = null;
    });
  }
}
