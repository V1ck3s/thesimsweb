/**
 * Port of the game's window base class (cTSWin, see docs/decomp/README.md).
 *
 * Kept from the original:
 *  - area is relative to the parent (cTSWin+0x74..0x80), set with setArea(l, t, r, b);
 *  - children list: index 0 is the front-most window; painting goes back to front
 *    (cTSWin::Plot), then postChildDraw;
 *  - tWinFlag bits (visible = 1, no-focus = 0x2000, ...);
 *  - TSOn* handlers receive window coordinates and return true when handled;
 *  - hit testing ignores pixels of the window's hit image that are transparent
 *    (cTSWin::is_point_transparent).
 *
 * Dropped: dirty rectangles and private buffers. The whole tree is repainted
 * every frame, which is visually identical on modern hardware.
 */

export const WF_VISIBLE = 0x1;
export const WF_ENABLED = 0x2;
/** Hit testing skips the transparent pixels of the window's image (cTSWinBtn, cWinViewControl). */
export const WF_HIT_ALPHA = 0x200;
/** cTSWin::HideCursor: no cursor over the window (cTSWin::UpdateCursor). */
export const WF_HIDE_CURSOR = 0x800;
export const WF_NO_FOCUS = 0x2000;
export const WF_MODAL = 0x10000;
/** An unforced global cursor shows over the window (cTSWinMgrW95::SetCursor; cSimsApp::WindowSetup sets it on cDDDSimsView). */
export const WF_GLOBAL_CURSOR = 0x20000;
/** cTSWin::SetTransparent: the window is blended at its +0xa8 opacity. */
export const WF_TRANSPARENT = 0x80000;

/**
 * Called when a window leaves the tree or hides (cTSWin::child_remove_absolute,
 * cTSWin::HideWindow): the window manager moves the focus off it. Set by WinMgr.
 */
let focusLost: ((w: TSWin, parent: TSWin | null, hidden: boolean) => void) | null = null;

export function setFocusLostHook(fn: (w: TSWin, parent: TSWin | null, hidden: boolean) => void): void {
  focusLost = fn;
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export class Gfx {
  constructor(
    readonly ctx: CanvasRenderingContext2D,
    /** Absolute position of the current window's origin. */
    readonly ox: number,
    readonly oy: number,
  ) {}

  blit(img: CanvasImageSource, x: number, y: number): void {
    this.ctx.drawImage(img, this.ox + x, this.oy + y);
  }

  blitPart(img: CanvasImageSource, sx: number, sy: number, w: number, h: number, x: number, y: number): void {
    if (w <= 0 || h <= 0) return;
    this.ctx.drawImage(img, sx, sy, w, h, this.ox + x, this.oy + y, w, h);
  }

  /** Repeat `img` horizontally to fill [x, x + w). */
  tileX(img: ImageBitmap, x: number, y: number, w: number): void {
    for (let px = 0; px < w; px += img.width) {
      this.blitPart(img, 0, 0, Math.min(img.width, w - px), img.height, x + px, y);
    }
  }

  fill(x: number, y: number, w: number, h: number, color: string): void {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(this.ox + x, this.oy + y, w, h);
  }

  frame(x: number, y: number, w: number, h: number, color: string): void {
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(this.ox + x + 0.5, this.oy + y + 0.5, w - 1, h - 1);
  }
}

export class TSWin {
  id = 0;
  parent: TSWin | null = null;
  readonly children: TSWin[] = [];
  area: Rect = { left: 0, top: 0, right: 0, bottom: 0 };
  flags = WF_VISIBLE | WF_ENABLED;
  tooltip = "";
  /** cTSWin+0x9c: hover time before the tooltip shows (the options' default, 750 ms). */
  tooltipDelay = 750;
  /** cTSWin+0xa0: tooltip fade-in time. */
  tooltipUnfurl = 150;
  /** cTSWin+0x68 (SetCursor): CSS cursor shown over this window and its children without one (ui/cursor.ts). */
  winCursor: string | null = null;
  /** Image whose transparent pixels let clicks fall through (optional). */
  hitImage: ImageBitmap | null = null;
  private hitAlpha: Uint8ClampedArray | null = null;

  // --- lifecycle (cTSWin::Init / Shutdown) ---------------------------------

  /** Async because resources stream in; returns false on failure like the original. */
  async init(): Promise<boolean> {
    return true;
  }

  shutdown(): void {
    for (const c of [...this.children]) c.shutdown();
  }

  // --- geometry ------------------------------------------------------------

  setArea(left: number, top: number, right: number, bottom: number): void {
    this.area = { left, top, right, bottom };
  }

  moveTo(x: number, y: number): void {
    this.setArea(x, y, x + this.getW(), y + this.getH());
  }

  setSize(w: number, h: number): void {
    this.setArea(this.area.left, this.area.top, this.area.left + w, this.area.top + h);
  }

  getW(): number {
    return this.area.right - this.area.left;
  }

  getH(): number {
    return this.area.bottom - this.area.top;
  }

  /** Absolute screen position of this window's origin (cTSWin::CalcAbsoluteArea). */
  absOrigin(): { x: number; y: number } {
    let x = this.area.left;
    let y = this.area.top;
    for (let p = this.parent; p; p = p.parent) {
      x += p.area.left;
      y += p.area.top;
    }
    return { x, y };
  }

  centerWindowInRect(r: Rect): void {
    const w = this.getW();
    const h = this.getH();
    const x = r.left + ((r.right - r.left - w) >> 1);
    const y = r.top + ((r.bottom - r.top - h) >> 1);
    this.setArea(x, y, x + w, y + h);
  }

  // --- flags ---------------------------------------------------------------

  getFlag(f: number): boolean {
    return (this.flags & f) !== 0;
  }

  setFlag(f: number, on: boolean): void {
    this.flags = on ? this.flags | f : this.flags & ~f;
  }

  showWindow(): void {
    this.setFlag(WF_VISIBLE, true);
  }

  /** cTSWin::HideWindow: a focused window gives the focus to its parent (the main window without one). */
  hideWindow(): void {
    this.setFlag(WF_VISIBLE, false);
    focusLost?.(this, this.parent, true);
  }

  isVisible(): boolean {
    return this.getFlag(WF_VISIBLE);
  }

  isVisibleAndAllParentsVisible(): boolean {
    for (let w: TSWin | null = this; w; w = w.parent) if (!w.isVisible()) return false;
    return true;
  }

  // --- children ------------------------------------------------------------

  /** Adds `w` in front of the existing children (cTSWin::ChildAdd). */
  childAdd(w: TSWin): void {
    w.parent?.detach(w);
    w.parent = this;
    this.children.unshift(w);
  }

  /** cTSWin::child_remove_absolute: the focus on the removed window goes to this one. */
  childRemove(w: TSWin): void {
    if (this.detach(w)) focusLost?.(w, this, false);
  }

  private detach(w: TSWin): boolean {
    const i = this.children.indexOf(w);
    if (i >= 0) this.children.splice(i, 1);
    if (w.parent === this) w.parent = null;
    return i >= 0;
  }

  childDelete(w: TSWin): void {
    this.childRemove(w);
    w.shutdown();
  }

  childToFront(w: TSWin): void {
    this.detach(w);
    this.childAdd(w);
  }

  childToBack(w: TSWin): void {
    this.detach(w);
    w.parent = this;
    this.children.push(w);
  }

  getChildWindowFromID(id: number): TSWin | null {
    for (const c of this.children) {
      if (c.id === id) return c;
      const d = c.getChildWindowFromID(id);
      if (d) return d;
    }
    return null;
  }

  // --- painting ------------------------------------------------------------

  /** Draw this window (not its children). Override in subclasses. */
  tsPaint(_g: Gfx): void {}

  /** Drawn over the children (cTSWin::PostChildDraw). */
  postChildDraw(_g: Gfx): void {}

  plot(ctx: CanvasRenderingContext2D, ox: number, oy: number): void {
    if (!this.isVisible()) return;
    let opacity = 0xff;
    if (this.getFlag(WF_TRANSPARENT)) {
      // cTSWin::Plot of a transparent window: always blended at its opacity.
      opacity = this.getOpacity();
    } else if (this.fadeDir !== 0) {
      // cTSWin::Plot of a fading window: the end of the ramp finishes it; in
      // between the window and its children are blended over what lies under
      // them at GetOpacity (31 / 32 and above: opaque, below 1 / 32: not drawn).
      if (performance.now() >= this.fadeRamp.end) this.endFade();
      if (!this.isVisible()) return;
      opacity = this.getOpacity();
      const level = (opacity >> 3) & 0x1f;
      if (level === 0) return;
      if (level === 0x1f) opacity = 0xff;
    }
    if (opacity === 0xff) {
      this.plotContent(ctx, ox, oy);
      return;
    }
    const w = this.getW();
    const h = this.getH();
    if (w <= 0 || h <= 0) return;
    let c = this.fadeBuffer;
    if (c?.width !== w || c.height !== h) c = this.fadeBuffer = new OffscreenCanvas(w, h);
    const cx = c.getContext("2d")!;
    cx.clearRect(0, 0, w, h);
    this.plotContent(cx as unknown as CanvasRenderingContext2D, -this.area.left, -this.area.top);
    const a = ctx.globalAlpha;
    ctx.globalAlpha = a * (opacity / 255);
    ctx.drawImage(c, ox + this.area.left, oy + this.area.top);
    ctx.globalAlpha = a;
  }

  /** +0xa8: SetTransparent's opacity. */
  private transparency = 0;

  /** cTSWin::SetTransparent(on, opacity) */
  setTransparent(on: boolean, opacity: number): void {
    this.setFlag(WF_TRANSPARENT, on);
    if (on) this.transparency = opacity & 0xff;
  }

  /** cTSWin::Plot's drawing: this window, its children back to front, then PostChildDraw. */
  private plotContent(ctx: CanvasRenderingContext2D, ox: number, oy: number): void {
    const x = ox + this.area.left;
    const y = oy + this.area.top;
    const g = new Gfx(ctx, x, y);
    this.tsPaint(g);
    for (let i = this.children.length - 1; i >= 0; i--) this.children[i]!.plot(ctx, x, y);
    this.postChildDraw(g);
  }

  // --- fades (cTSWin::AsyncShowHideWin, interface effects) --------------------

  /** +0xac: the running fade, 1 showing, -1 hiding, 0 none. */
  fadeDir = 0;
  /** +0xc5: the window keeps painting while it fades (else the original blends its last picture). */
  fadeLive = false;
  /** +0xb4 (RampGenerator) and +0xc0 (its end): the opacity ramp, 0..1. */
  private fadeRamp = { from: 0, to: 0, start: 0, end: 0 };
  private fadeBuffer: OffscreenCanvas | null = null;

  /**
   * cTSWin::AsyncShowHideWin(show, live, ms): fades the window in (shown
   * at once) or out (hidden at the end) over `ms` (0: 333 ms, 0x14d). A
   * fade the other way already running turns around from where it is, over
   * the part of `ms` left to cover; one the same way, or a window already
   * shown / hidden, is left alone. Starting a fade finishes the children's.
   * The end of the fade (BlitPrivateBufferToParent from cTSWin::Plot, the
   * next AsyncShowHideWin or FinishAsync) hides a hidden window and posts
   * message 0x1b to the parent (doAsyncShowHideMessage).
   */
  asyncShowHideWin(show: boolean, live: boolean, ms = 0): void {
    const now = performance.now();
    if (this.fadeDir !== 0 && now >= this.fadeRamp.end) this.endFade();
    const visible = this.isVisible();
    const d = this.fadeDir;
    if (!((show !== visible || (show && d < 0)) && (show || d >= 0) && (!show || d < 1))) return;
    if (ms === 0) ms = 0x14d;
    if (d === 0) {
      for (const c of this.children) c.finishAsync();
      this.fadeLive = live;
      if (show) {
        this.fadeDir = 1;
        this.fadeRamp = { from: 0, to: 1, start: now, end: now + ms };
        this.showWindow();
      } else {
        this.fadeDir = -1;
        this.fadeRamp = { from: 1, to: 0, start: now, end: now + ms };
      }
    } else if (d < 0) {
      const v = this.fadeValue(now);
      this.fadeRamp = { from: v, to: 1, start: now, end: now + Math.trunc(0.5 + ms * (1 - v)) };
      this.fadeDir = 1;
    } else {
      const v = this.fadeValue(now);
      this.fadeRamp = { from: v, to: 0, start: now, end: now + Math.trunc(0.5 + ms * v) };
      this.fadeDir = -1;
    }
  }

  /** cTSWin::FinishAsync: the running fade ends now (a hiding window hides), then the children's. */
  finishAsync(): void {
    if (this.fadeDir !== 0) this.endFade();
    for (const c of this.children) c.finishAsync();
  }

  /** cTSWin::GetOpacity: 0 hidden, SetTransparent's for a transparent window, else 255 (the ramp while fading). */
  getOpacity(): number {
    if (!this.isVisible()) return 0;
    if (this.getFlag(WF_TRANSPARENT)) return this.transparency;
    if (this.fadeDir === 0) return 0xff;
    return Math.trunc(255 * this.fadeValue(performance.now()) + 0.5) & 0xff;
  }

  private fadeValue(now: number): number {
    const r = this.fadeRamp;
    if (now >= r.end || r.end <= r.start) return r.to;
    return r.from + ((r.to - r.from) * (now - r.start)) / (r.end - r.start);
  }

  /**
   * The end of a fade: a hiding window hides, then PostMessageToTarget(parent,
   * 0x1b, this, direction). The message is posted: the parent handles it
   * after the current call (a microtask here).
   */
  private endFade(): void {
    const d = this.fadeDir;
    this.fadeDir = 0;
    if (d < 0) this.hideWindow();
    const parent = this.parent;
    if (parent) queueMicrotask(() => parent.doAsyncShowHideMessage(this, d));
  }

  /**
   * cTSWin::DoMessage for message 0x1b: the child `src` finished a fade, `dir`
   * 1 shown, -1 hidden. cTSWin's handles messages below 0x1b only (false).
   */
  doAsyncShowHideMessage(_src: TSWin, _dir: number): boolean {
    return false;
  }

  /** Called once per frame before plotting (timers, animation). */
  pump(nowMs: number): void {
    for (const c of this.children) c.pump(nowMs);
  }

  // --- hit testing ---------------------------------------------------------

  isPointInWindowWindowCoordinates(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.getW() || y >= this.getH()) return false;
    return !this.isPointTransparent(x, y);
  }

  protected isPointTransparent(x: number, y: number): boolean {
    const img = this.hitImage;
    if (!img) return false;
    if (!this.hitAlpha) {
      const c = new OffscreenCanvas(img.width, img.height);
      const cx = c.getContext("2d")!;
      cx.drawImage(img, 0, 0);
      this.hitAlpha = cx.getImageData(0, 0, img.width, img.height).data;
    }
    if (x >= img.width || y >= img.height) return true;
    return this.hitAlpha[(y * img.width + x) * 4 + 3] === 0;
  }

  /** Front-most visible descendant (or self) under (x, y) in window coordinates. */
  windowFromPoint(x: number, y: number): TSWin | null {
    if (!this.isVisible()) return null;
    // Children are tested even outside our bounds: control panel patches overhang it.
    for (const c of this.children) {
      const hit = c.windowFromPoint(x - c.area.left, y - c.area.top);
      if (hit) return hit;
    }
    return this.isPointInWindowWindowCoordinates(x, y) ? this : null;
  }

  // --- events (window coordinates; return true when handled) ---------------

  tsOnMouseDownL(_x: number, _y: number): boolean {
    return false;
  }
  tsOnMouseUpL(_x: number, _y: number): boolean {
    return false;
  }
  tsOnMouseDownR(_x: number, _y: number): boolean {
    return false;
  }
  tsOnMouseUpR(_x: number, _y: number): boolean {
    return false;
  }
  /** cTSWin::TSOnMouseDoubleL (message 9, WM_LBUTTONDBLCLK): a press like any other. */
  tsOnMouseDoubleL(x: number, y: number): boolean {
    return this.tsOnMouseDownL(x, y);
  }
  /** cTSWin::TSOnMouseDoubleR (message 10, WM_RBUTTONDBLCLK): a press like any other. */
  tsOnMouseDoubleR(x: number, y: number): boolean {
    return this.tsOnMouseDownR(x, y);
  }
  tsOnMouseMove(_x: number, _y: number): boolean {
    return false;
  }
  tsOnMouseWheel(_x: number, _y: number, _delta: number): boolean {
    return false;
  }
  tsOnMouseEnter(): void {}
  tsOnMouseExit(): void {}
  /**
   * Keys go to the focus (cTSWinMgrW95::ProcessSystemMessage); cTSWin::TSOnKeyDown
   * hands them to the parent: false here lets WinMgr try the parent next.
   */
  tsOnKeyDown(_key: string): boolean {
    return false;
  }
  /** cTSWin::TSOnKeyUp: like TSOnKeyDown, false lets WinMgr try the parent next. */
  tsOnKeyUp(_key: string): boolean {
    return false;
  }
  /** cTSWin::TSOnSetFocus (message 0x15, `prev` lost it). */
  tsOnSetFocus(_prev: TSWin | null): void {}
  /** Message 0x14: `next` takes the focus. */
  tsOnKillFocus(_next: TSWin | null): void {}
  /** Called by WinMgr.doModalWin / endDialog (cTSWin::TSBeginModal / TSEndModal). */
  tsBeginModal(): void {}
  tsEndModal(): void {}
  /** Button/command notifications bubble up to parents (cTSWin::TSOnCommand). */
  tsOnCommand(cmd: number, source: TSWin): boolean {
    return this.parent ? this.parent.tsOnCommand(cmd, source) : false;
  }
}
