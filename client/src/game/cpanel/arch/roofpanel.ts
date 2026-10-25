/**
 * cWinRoofPanel — the roof tool's panel inside cWinArch (area (0x13e, 5) to
 * (width, 100) of the arch panel): four pitch buttons, the roof pattern
 * buttons a page at a time, and previous / next page buttons.
 *
 * Ported from the Mac build (cWinRoofPanel.c, WinRoofPanel.s):
 *  - BuildButtons: UIText STR# 147 alternates "(x;y)" positions and
 *    tooltips. Buttons lbl_105BC534: shallow, medium, steep (kBldSbTlRoof*),
 *    previous page, next page (kCatalogPrevPage / NextPage), flat; position
 *    x - 4 (previous page, flat too), the next page button x - 3 with the
 *    800-wide lot view and 8 patterns a page, otherwise the next position,
 *    x - 0x1b, and 16 patterns a page. Pitch buttons toggle, fire on press
 *    and show the popup after the quick tips delay; the page buttons are
 *    push buttons firing on press. Then the pattern origin (position - (4, 2))
 *    and the two popup products (Product::SetBitmap, tool 10, price 0):
 *    "Roof Pitch" with kBldPopupRoofPitch, "Roof Patterns" with
 *    kBldPopupRoofPattern;
 *  - TraverseRoofDirectory: every .bmp of GameData/Roofs (FileIter order,
 *    here sorted by name);
 *  - BuildPatternButtons: textures whose sides are equal powers of two
 *    (IsAllowableRoofTexture); a copy of kRoofPatternTemplate (4 frames
 *    of 0x2d) with the texture's top-left 36x36 (or the texture centered
 *    when smaller) at (4, 4) of each frame; the name keeps the file name
 *    without folder and extension;
 *  - SetCurPage / UpdateViewFromCPState: patterns in two rows from the
 *    origin, button-sized steps; the button of the current pitch (0.4
 *    shallow, 0.6 medium, at least 0.1 steep, else flat) and pattern down;
 *  - TSOnCommand: a pitch or pattern sets the roof (cRoofLayer, one
 *    cRoofUndoable) and the roof view (CPState::SetWallState(8)); hovering
 *    shows the pitch product or the pattern product with the texture tiled
 *    inside a 16 px margin (Product::SetPopupBitmap).
 */

import { fetchManifest } from "../../../engine/assets.js";
import { WallState } from "../../cpstate.js";
import type { GameContext } from "../../context.js";
import { decodeImage } from "../../res/bmp.js";
import { BTN_TOGGLE, TSWinBtn } from "../../ui/btn.js";
import { TSWin } from "../../ui/tswin.js";
import type { PopupProduct, WinCatalogPopup } from "../buy/catalogpopup.js";
import { CMD_ASYNC, CMD_ASYNC_CANCEL } from "../buy/productbutton.js";

const CMD_BUTTON = 1;
/** UIText STR# 147 */
const STR_ROOF = 0x93;
/** lbl_105BC534 */
const BUTTON_IMAGES = ["kBldSbTlRoofShallow", "kBldSbTlRoofMedium", "kBldSbTlRoofSteep", "kCatalogPrevPage", "kCatalogNextPage", "kBldSbTlRoofFlat"];
const enum Btn {
  Shallow = 0,
  Medium = 1,
  Steep = 2,
  Prev = 3,
  Next = 4,
  Flat = 5,
}
/** lbl_105BC53C: steep threshold, then the pitches of flat, shallow, medium, steep. */
const STEEP_MIN = 0.1;
const PITCH: Record<number, number> = { [Btn.Flat]: 0, [Btn.Shallow]: 0.4, [Btn.Medium]: 0.6, [Btn.Steep]: 1 };
/** lbl_105BA648 */
const EPSILON = 1e-6;
const ROOFS = "Sims/GameData/Roofs/";
const CELL = 0x24;
const FRAME = 0x2d;
/** Lot view width with 8 patterns a page (cSimsApp lot view +0x3c). */
const SMALL_VIEW_W = 800;
/** Product::SetPopupBitmap margin of the pattern picture. */
const POPUP_MARGIN = 0x10;

/** lbl_105BA774 (cOptionsMgr: quick tips on): the async delay of the popup buttons. */
const ASYNC_TIMEOUT_MS = 0xfa;

/**
 * A button with async flags 6 (+0x14c): pressing or releasing arms a timer
 * that sends command 0x13 once the quick tips delay has passed; leaving it
 * sends 0x14 (see buy/productbutton.ts).
 */
class AsyncBtn extends TSWinBtn {
  private pending = false;
  private start = 0;

  override tsOnMouseDownL(): boolean {
    const r = super.tsOnMouseDownL();
    this.arm();
    return r;
  }

  override tsOnMouseUpL(x: number, y: number): boolean {
    const r = super.tsOnMouseUpL(x, y);
    this.arm();
    return r;
  }

  override tsOnMouseExit(): void {
    super.tsOnMouseExit();
    if (!this.pending) return;
    this.pending = false;
    this.parent?.tsOnCommand(CMD_ASYNC_CANCEL, this);
  }

  private arm(): void {
    this.pending = true;
    this.start = performance.now();
  }

  override pump(nowMs: number): void {
    super.pump(nowMs);
    if (this.pending && nowMs - this.start > ASYNC_TIMEOUT_MS) {
      this.pending = false;
      this.parent?.tsOnCommand(CMD_ASYNC, this);
    }
  }
}

/** "(x;y)" (StringPosToPoint). */
function stringPosToPoint(s: string): [number, number] {
  const m = /\((-?\d+)\s*;\s*(-?\d+)\)/.exec(s);
  return m ? [parseInt(m[1]!, 10), parseInt(m[2]!, 10)] : [0, 0];
}

/** The roof popups' products (Product::SetBitmap: kind 5, tool 10, price 0). */
class RoofProduct implements PopupProduct {
  /** +0x38, +0x3c: the picture, tiled inside the margin. */
  picture: ImageBitmap | null;
  tiled = false;

  constructor(
    private readonly name: string,
    private readonly description: string,
    picture: ImageBitmap | null,
  ) {
    this.picture = picture;
  }

  getProductName(): string {
    return this.name;
  }

  getPrice(): number {
    return 0;
  }

  getDescription(): string {
    return this.description;
  }

  getCatalogRating(): number {
    return 0;
  }

  canAfford(funds: number): boolean {
    return funds >= 0;
  }

  /** Product::DrawIcon, kind 5. */
  async drawPopupIcon(_ctx: GameContext, g: CanvasRenderingContext2D, w: number, h: number): Promise<void> {
    const img = this.picture;
    if (!img) return;
    if (!this.tiled) {
      const x = img.width < w ? Math.trunc((w - img.width) / 2) : 0;
      const y = img.height < h ? Math.trunc((h - img.height) / 2) : 0;
      g.drawImage(img, x, y);
      return;
    }
    const m = POPUP_MARGIN;
    g.save();
    g.beginPath();
    g.rect(m, m, w - 2 * m, h - 2 * m);
    g.clip();
    for (let y = m; y < h - m; y += img.height) for (let x = m; x < w - m; x += img.width) g.drawImage(img, x, y);
    g.restore();
  }
}

export class WinRoofPanel extends TSWin {
  /** +0xcc: shallow, medium, steep, previous, next, flat. */
  private readonly btns: TSWinBtn[] = [];
  /** +0xe4, +0xf0, +0xfc: pattern buttons, names, textures. */
  private readonly patternBtns: TSWinBtn[] = [];
  private readonly patterns: string[] = [];
  private readonly textures: ImageBitmap[] = [];
  /** +0x108, +0x10c */
  private page = 0;
  private perPage = 0;
  /** +0x114 */
  private origin: [number, number] = [0, 0];
  /** +0x120, +0x124 */
  private pitchProduct: RoofProduct | null = null;
  private patternProduct: RoofProduct | null = null;

  constructor(
    private readonly ctx: GameContext,
    /** +0x11c: cWinArch's popup. */
    private readonly popup: WinCatalogPopup,
  ) {
    super();
  }

  override async init(): Promise<boolean> {
    await this.buildButtons();
    return true;
  }

  /** cWinRoofPanel::BuildButtons */
  private async buildButtons(): Promise<void> {
    const { ctx } = this;
    const strs = ctx.strings.list("UIText", STR_ROOF);
    if (!strs.length) return;
    let k = 0;
    const next = (): string => strs[k++] ?? "";
    const images = await Promise.all(BUTTON_IMAGES.map((n) => ctx.res.image(n).catch(() => null)));
    for (let i = 0; i < 6; i++) {
      let x: number;
      let y: number;
      if (i === Btn.Next) {
        if (ctx.width === SMALL_VIEW_W) {
          [x, y] = stringPosToPoint(next());
          k++;
          x -= 3;
          this.perPage = 8;
        } else {
          k++;
          [x, y] = stringPosToPoint(next());
          x -= 0x1b;
          this.perPage = 0x10;
        }
      } else {
        [x, y] = stringPosToPoint(next());
        x -= 4;
      }
      // Pitch buttons toggle and show the popup; the page buttons are push buttons.
      const b = i < Btn.Prev || i > Btn.Next ? new AsyncBtn(CMD_BUTTON) : new TSWinBtn(CMD_BUTTON);
      const im = images[i];
      if (im) b.setImage(im, 4, 1);
      b.sendOnDown = true;
      if (b instanceof AsyncBtn) b.mode = BTN_TOGGLE;
      b.moveTo(x, y);
      b.tooltip = next();
      this.childAdd(b);
      this.btns.push(b);
    }
    const [ox, oy] = stringPosToPoint(next());
    this.origin = [ox - 4, oy - 2];
    await this.traverseRoofDirectory();
    await this.buildPatternButtons();
    const [pitchImg, patternImg] = await Promise.all([
      ctx.res.image("kBldPopupRoofPitch").catch(() => null),
      ctx.res.image("kBldPopupRoofPattern").catch(() => null),
    ]);
    this.pitchProduct = new RoofProduct(next(), next(), pitchImg);
    this.patternProduct = new RoofProduct(next(), next(), patternImg);
  }

  /** cWinRoofPanel::TraverseRoofDirectory: the GameData/Roofs bitmaps. */
  private async traverseRoofDirectory(): Promise<void> {
    const m = await fetchManifest().catch(() => null);
    if (!m) return;
    const files = m.files
      .map((f) => f.path)
      .filter((p) => p.toLowerCase().startsWith(ROOFS.toLowerCase()) && p.toLowerCase().endsWith(".bmp") && !p.slice(ROOFS.length).includes("/"))
      .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
    this.patterns.push(...files);
  }

  /** cWinRoofPanel::BuildPatternButtons */
  private async buildPatternButtons(): Promise<void> {
    const template = await this.ctx.res.image("kRoofPatternTemplate").catch(() => null);
    if (!template) return;
    const kept: string[] = [];
    for (const path of this.patterns) {
      const tex = await loadTexture(path);
      if (!tex) continue;
      const c = new OffscreenCanvas(template.width, template.height);
      const g = c.getContext("2d")!;
      g.drawImage(template, 0, 0);
      let src: [number, number, number, number];
      let dx = 4;
      let dy = 4;
      if (tex.width < CELL) {
        src = [0, 0, tex.width, tex.height];
        dx = Math.trunc((CELL - tex.width) / 2) + 4;
        dy = Math.trunc((CELL - tex.height) / 2) + 4;
      } else {
        src = [0, 0, CELL, CELL];
      }
      for (let f = 0; f < 4; f++) g.drawImage(tex, src[0], src[1], src[2], src[3], dx + f * FRAME, dy, src[2], src[3]);
      this.textures.push(tex);
      const b = new AsyncBtn(CMD_BUTTON);
      b.setImage(await createImageBitmap(c), 4, 1);
      b.mode = BTN_TOGGLE;
      b.sendOnDown = true;
      this.childAdd(b);
      this.patternBtns.push(b);
      kept.push(path.slice(path.lastIndexOf("/") + 1).replace(/\.[^.]*$/, ""));
    }
    this.patterns.length = 0;
    this.patterns.push(...kept);
  }

  /** cWinRoofPanel::SetCurPage */
  setCurPage(page: number): void {
    if (this.perPage === 0) this.perPage = 8;
    const n = this.patternBtns.length;
    const last = Math.trunc(n / this.perPage);
    if (page < 0) page = 0;
    else if (last + 1 <= page) page = last;
    this.page = page;
    const first = this.page * this.perPage;
    this.patternBtns.forEach((b, i) => {
      if (i < first || i >= first + this.perPage) b.hideWindow();
      else b.showWindow();
    });
    if (n === 0) return;
    const w = this.patternBtns[0]!.getW();
    const h = this.patternBtns[0]!.getH();
    const [ox, oy] = this.origin;
    const maxX = Math.trunc(this.perPage / 2) * w + ox;
    let x = ox;
    let y = oy;
    let row = 0;
    for (const b of this.patternBtns.slice(first, first + this.perPage)) {
      if (!b.isVisible()) continue;
      b.moveTo(x, y);
      x += w;
      if (w === 0 || maxX < x + w) {
        x = ox;
        row++;
        y = oy + row * h;
      }
    }
  }

  /** cWinRoofPanel::UpdateViewFromCPState */
  updateViewFromCPState(): void {
    const roof = this.ctx.state.archRoofHooks;
    const set = (down: Btn | -1): void => {
      for (const i of [Btn.Shallow, Btn.Medium, Btn.Steep, Btn.Flat]) this.btns[i]?.setState(i === down ? 1 : 0);
    };
    if (roof) {
      const pitch = roof.getPitch();
      if (Math.abs(pitch - PITCH[Btn.Shallow]!) <= EPSILON) set(Btn.Shallow);
      else if (Math.abs(pitch - PITCH[Btn.Medium]!) <= EPSILON) set(Btn.Medium);
      else if (pitch >= STEEP_MIN) set(Btn.Steep);
      else set(Btn.Flat);
    } else {
      set(-1);
    }
    const current = roof?.getPattern().toLowerCase() ?? null;
    this.patternBtns.forEach((b, i) => b.setState(current !== null && this.patterns[i]!.toLowerCase() === current ? 1 : 0));
    const prev = this.btns[Btn.Prev];
    const nextBtn = this.btns[Btn.Next];
    if (this.page === 0) prev?.hideWindow();
    else prev?.showWindow();
    if ((this.page + 1) * this.perPage < this.patternBtns.length) nextBtn?.showWindow();
    else nextBtn?.hideWindow();
  }

  override tsOnCommand(cmd: number, src: TSWin): boolean {
    const s = this.ctx.state;
    const btn = this.btns.indexOf(src as TSWinBtn);
    const pattern = this.patternBtns.indexOf(src as TSWinBtn);
    const owner = this.parent ?? this;
    if (cmd === CMD_ASYNC_CANCEL) return true;
    if (cmd === CMD_ASYNC) {
      if (btn < 0 && pattern >= 0 && this.patternProduct) {
        this.showPatternPicture(pattern);
        this.popup.enablePopup(this.patternProduct, owner);
      } else if ((btn >= 0 && btn < Btn.Prev) || btn === Btn.Flat) {
        if (this.pitchProduct) this.popup.enablePopup(this.pitchProduct, owner);
      }
      return true;
    }
    if (cmd !== CMD_BUTTON) return super.tsOnCommand(cmd, src);
    if (btn < 0) {
      if (pattern < 0) return true;
      s.setWallState(WallState.Roof);
      s.archRoofHooks?.setPattern(this.patterns[pattern]!);
      this.updateViewFromCPState();
      if (this.popup.shown && this.patternProduct) {
        this.showPatternPicture(pattern);
        this.popup.enablePopup(this.patternProduct, owner);
      }
      return true;
    }
    if (btn === Btn.Prev || btn === Btn.Next) {
      this.setCurPage(this.page + (btn === Btn.Prev ? -1 : 1));
      this.updateViewFromCPState();
      return true;
    }
    s.archRoofHooks?.setPitch(PITCH[btn]!);
    s.setWallState(WallState.Roof);
    this.updateViewFromCPState();
    if (this.popup.shown && this.pitchProduct) this.popup.enablePopup(this.pitchProduct, owner);
    return true;
  }

  /** Product::SetPopupBitmap(texture, tiled, 16 px margins). */
  private showPatternPicture(i: number): void {
    const p = this.patternProduct;
    const tex = this.textures[i];
    if (!p || !tex) return;
    p.picture = tex;
    p.tiled = true;
  }
}

/** BMPFactory + IsAllowableRoofTexture: square power-of-two textures only. */
async function loadTexture(path: string): Promise<ImageBitmap | null> {
  try {
    const r = await fetch(`/assets/${path}`);
    if (!r.ok) return null;
    const img = decodeImage(new Uint8Array(await r.arrayBuffer()), path);
    const pow2 = (v: number): boolean => v >= 1 && v <= 0x100 && (v & (v - 1)) === 0;
    if (!pow2(img.width) || !pow2(img.height) || img.width !== img.height) return null;
    return await createImageBitmap(new ImageData(img.data, img.width, img.height));
  } catch {
    return null;
  }
}
