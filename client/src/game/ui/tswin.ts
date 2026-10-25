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
export const WF_NO_FOCUS = 0x2000;
export const WF_MODAL = 0x10000;

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

  hideWindow(): void {
    this.setFlag(WF_VISIBLE, false);
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
    w.parent?.childRemove(w);
    w.parent = this;
    this.children.unshift(w);
  }

  childRemove(w: TSWin): void {
    const i = this.children.indexOf(w);
    if (i >= 0) this.children.splice(i, 1);
    if (w.parent === this) w.parent = null;
  }

  childDelete(w: TSWin): void {
    this.childRemove(w);
    w.shutdown();
  }

  childToFront(w: TSWin): void {
    this.childRemove(w);
    this.childAdd(w);
  }

  childToBack(w: TSWin): void {
    this.childRemove(w);
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
    const x = ox + this.area.left;
    const y = oy + this.area.top;
    const g = new Gfx(ctx, x, y);
    this.tsPaint(g);
    for (let i = this.children.length - 1; i >= 0; i--) this.children[i]!.plot(ctx, x, y);
    this.postChildDraw(g);
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
  tsOnMouseMove(_x: number, _y: number): boolean {
    return false;
  }
  tsOnMouseWheel(_x: number, _y: number, _delta: number): boolean {
    return false;
  }
  tsOnMouseEnter(): void {}
  tsOnMouseExit(): void {}
  tsOnKeyDown(_key: string): boolean {
    return false;
  }
  /** Called by WinMgr.doModalWin / endDialog (cTSWin::TSBeginModal / TSEndModal). */
  tsBeginModal(): void {}
  tsEndModal(): void {}
  /** Button/command notifications bubble up to parents (cTSWin::TSOnCommand). */
  tsOnCommand(cmd: number, source: TSWin): boolean {
    return this.parent ? this.parent.tsOnCommand(cmd, source) : false;
  }
}
