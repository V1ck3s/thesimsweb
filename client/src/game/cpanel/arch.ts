/**
 * cWinArch — the build mode control panel: twelve tool buttons, undo and
 * redo, and the current tool's products, a page of product buttons at a
 * time, with the product sheet popup (cWinCatalogPopup); the roof tool shows
 * the roof panel (cWinRoofPanel) instead of products.
 *
 * Ported from the Mac build (cWinArch.c, WinArch.s jump tables and
 * .__sinit__WinArch_cpp for the positions):
 *  - tool buttons: resource ids lbl_105BA96C (kToolBtnTerrain...), 4 frames,
 *    toggle and fire on press, tooltips UIText STR# 139 ("BldTips") 0..11;
 *    positions lbl_105BA974 in control panel coordinates (the panel x is
 *    subtracted, cWinArch::TSPaint);
 *  - undo (0xe7, 0x15) and redo (0xe7, 0x35), kToolBtnUndo / Redo, fire on
 *    press, enabled from CPState::ArchCanUndo / ArchCanRedo, tooltips 12, 13;
 *  - previous page (0x222 - panel x, 0x1a) and next page (width - 0xe, 0x1a),
 *    kCatalogPrevPage / NextPage, tooltips 14, 15;
 *  - products: 45x45 cells from (0x152, 5), step 0x2d, up to (width - 4, 100);
 *  - the popup goes away when the mouse leaves the panel or moves over it
 *    outside (0x13e, 5)-(width, 100);
 *  - kBuildToothPick1 at (0x31, 6) and kBuildToothPick2 at (0x13f, 6) over
 *    the control panel background.
 *
 * UpdateViewFromCPState (dirty 0x10 / 0x100): the tool's products are the
 * catalog products Product::TestArchTool takes, sorted with
 * ArchObjectSortPredicate for the object tools and floors; the current
 * sub-tool's page is shown, and a tool without sub-tool gets its first
 * product (CPState::ArchSetCurrentSubtool).
 *
 * Not ported: UI sounds.
 */

import { ArchTool, DIRTY_ARCH_UNDO, type CPState } from "../cpstate.js";
import type { GameContext } from "../context.js";
import { archObjectSort, ARCH_SORT_TYPE, BuildProduct, loadBuildCatalog, ProductKind } from "../data/buildcatalog.js";
import { BTN_TOGGLE, TSWinBtn } from "../ui/btn.js";
import { Gfx, TSWin } from "../ui/tswin.js";
import { winMgr } from "../ui/winmgr.js";
import { WinRoofPanel } from "./arch/roofpanel.js";
import { WinCatalogPopup } from "./buy/catalogpopup.js";
import { CMD_ASYNC, ProductButton } from "./buy/productbutton.js";

/** Every button sends command 1 (cTSWinBtn::SendButtonCommand). */
const CMD_BUTTON = 1;
/** UIText STR# 139 "BldTips": 12 tools, undo, redo, previous and next page. */
const STR_TIPS = 0x8b;
const TOOLS = 12;
/** CPState dirty bits UpdateViewFromCPState refreshes the products on (0x100: floors). */
const DIRTY_TOOLS = 0x110;
const DIRTY_FLOORS = 0x100;

/** lbl_105BA96C: tool button bitmaps, in ArchTool order. */
const TOOL_IMAGES = [
  "kToolBtnTerrain",
  "kToolBtnPool",
  "kToolBtnWall",
  "kToolBtnWallpaper",
  0x4a,
  0x4b,
  "kToolBtnTree",
  "kToolBtnFloor",
  "kToolBtnDoor",
  "kToolBtnWindow",
  0x4c,
  0x4d,
];
/** lbl_105BA974 (.__sinit__WinArch_cpp): tool button positions, control panel coordinates. */
const TOOL_POS: Array<[number, number]> = [
  [0x116, 4],
  [0x145, 6],
  [0x16c, 4],
  [0x198, 3],
  [0x1c2, 4],
  [0x1f6, 8],
  [0x117, 0x39],
  [0x13d, 0x40],
  [0x16f, 0x37],
  [0x199, 0x37],
  [0x1c1, 0x37],
  [0x1f6, 0x37],
];
/** lbl_105BC338 / lbl_105BC334 */
const UNDO_POS: [number, number] = [0xe7, 0x15];
const REDO_POS: [number, number] = [0xe7, 0x35];
const PREV_PAGE_POS: [number, number] = [0x222, 0x1a];
const NEXT_PAGE_FROM_RIGHT = 0xe;
const PAGE_Y = 0x1a;
/** The product grid (cWinArch +0x128..+0x148). */
const GRID_X = 0x152;
const GRID_Y = 5;
const GRID_STEP = 0x2d;
const GRID_CELL = 0x2d;
const GRID_RIGHT_MARGIN = 4;
const GRID_BOTTOM = 100;
/** +0x158: the popup zone (and the roof panel's area). */
const POPUP_ZONE_X = 0x13e;
const POPUP_ZONE_Y = 5;
const TOOTHPICK1_POS: [number, number] = [0x31, 6];
const TOOTHPICK2_POS: [number, number] = [0x13f, 6];

type Img = ImageBitmap | null;

export class WinArch extends TSWin {
  private background: Img = null;
  private template: Img = null;
  private template1: Img = null;
  private unknownItem: Img = null;
  /** +0x174, +0x178 */
  private toothPick1: Img = null;
  private toothPick2: Img = null;
  /** +0xd0 */
  private tool = ArchTool.Terrain;
  /** +0xdc, +0xe0, +0xe4, +0xe8 */
  private undoBtn = new TSWinBtn(CMD_BUTTON);
  private redoBtn = new TSWinBtn(CMD_BUTTON);
  private prevBtn = new TSWinBtn(CMD_BUTTON);
  private nextBtn = new TSWinBtn(CMD_BUTTON);
  /** +0xec */
  private readonly toolBtns: TSWinBtn[] = [];
  /** +0x11c: the products on the page. */
  private products: BuildProduct[] = [];
  /** +0x14c */
  private page = 0;
  /** +0x150 */
  private perPage = 0;
  /** +0x154 */
  private readonly popup: WinCatalogPopup;
  /** +0x16c, +0x170 */
  private roofPanel: WinRoofPanel | null = null;
  private roofMode = false;
  /** +0xd8: TSPaint lays the buttons out once. */
  private needLayout = true;
  private all: BuildProduct[] | null = null;
  private readonly buttons = new Map<BuildProduct, ProductButton<BuildProduct>>();
  /** cTSWinMgrW95::PostMessageToTarget(this, command 1, button): delivered on the next pump. */
  private posted: TSWin | null = null;
  /** lbl_105C09B8: UpdateViewFromCPState is not reentrant. */
  private updating = false;

  constructor(readonly ctx: GameContext) {
    super();
    this.popup = new WinCatalogPopup(ctx);
  }

  override async init(): Promise<boolean> {
    const { ctx } = this;
    const img = (id: number | string): Promise<Img> => ctx.res.image(id).catch(() => null);
    if (!(await this.popup.init())) return false;
    let toolImages: Img[];
    let undo: Img, redo: Img, prev: Img, next: Img;
    [this.background, this.template, this.template1, this.unknownItem, this.toothPick1, this.toothPick2, undo, redo, prev, next, ...toolImages] = await Promise.all([
      img("kUniversalCPBkg"),
      img("kCatalogTemplate"),
      img("kCatalogTemplate1Frame"),
      img("kItemUnknown"),
      img("kBuildToothPick1"),
      img("kBuildToothPick2"),
      img("kToolBtnUndo"),
      img("kToolBtnRedo"),
      img("kCatalogPrevPage"),
      img("kCatalogNextPage"),
      ...TOOL_IMAGES.map(img),
    ]);
    const tips = ctx.strings.list("UIText", STR_TIPS);

    // Undo, redo and next page fire on press (+0xec = 1); previous page on release.
    const small: Array<[TSWinBtn, Img, boolean]> = [
      [this.undoBtn, undo, true],
      [this.redoBtn, redo, true],
      [this.prevBtn, prev, false],
      [this.nextBtn, next, true],
    ];
    small.forEach(([b, im, onDown], i) => {
      if (im) b.setImage(im, 4, 1);
      b.sendOnDown = onDown;
      b.tooltip = tips[TOOLS + i] ?? "";
      this.childAdd(b);
    });

    for (let i = 0; i < TOOLS; i++) {
      const b = new TSWinBtn(CMD_BUTTON);
      const im = toolImages[i];
      if (im) b.setImage(im, 4, 1);
      b.mode = BTN_TOGGLE;
      b.sendOnDown = true;
      b.tooltip = tips[i] ?? "";
      this.childAdd(b);
      this.toolBtns.push(b);
    }

    this.perPage = this.cells().length;

    const roof = new WinRoofPanel(ctx, this.popup);
    roof.setArea(POPUP_ZONE_X, POPUP_ZONE_Y, this.getW(), GRID_BOTTOM);
    if (await roof.init()) {
      this.childAdd(roof);
      roof.hideWindow();
      roof.setCurPage(0);
      this.roofPanel = roof;
    }

    // CPState::GetCatalog builds the catalog on first use; the products show once it is there.
    void loadBuildCatalog(ctx).then(async (c) => {
      await this.loadToolImages(c.products);
      this.all = c.products;
      ctx.state.setDirty(DIRTY_TOOLS);
    });
    return true;
  }

  override shutdown(): void {
    this.popup.disablePopup();
    super.shutdown();
  }

  /** The grid cells (Init / UpdateViewFromCPState count them row by row). */
  private cells(): Array<[number, number]> {
    const maxX = this.getW() - GRID_RIGHT_MARGIN;
    const out: Array<[number, number]> = [];
    for (let x = GRID_X, y = GRID_Y, row = 0; x + GRID_CELL <= maxX && y + GRID_CELL <= GRID_BOTTOM; ) {
      out.push([x, y]);
      x += GRID_STEP;
      if (x + GRID_CELL > maxX) {
        row++;
        y = GRID_Y + row * GRID_STEP;
        x = GRID_X;
      }
    }
    return out;
  }

  /** The panel's x in the control panel (TSPaint subtracts it from the button positions). */
  private panelOffset(): number {
    return this.area.left;
  }

  // --- products -----------------------------------------------------------------

  /** Product::GetButton (Product::CreateButton). */
  private buttonFor(p: BuildProduct): ProductButton<BuildProduct> | null {
    let b = this.buttons.get(p);
    if (b) return b;
    let image: Img;
    let cols = 4;
    if (p.kind === ProductKind.Tool) {
      // The tool's own 4-frame bitmap, no foreground.
      image = this.toolImage(p);
    } else {
      const one = p.object !== null && !p.object.hasAnySort();
      image = one ? this.template1 : this.template;
      cols = one ? 1 : 4;
    }
    if (!image) return null;
    b = new ProductButton(p, image, cols);
    b.id = CMD_BUTTON;
    b.funds = () => this.ctx.state.getFunds();
    if (p.kind !== ProductKind.Tool && this.unknownItem) b.setFallbackIcon(this.unknownItem, this.template);
    b.hideWindow();
    this.buttons.set(p, b);
    return b;
  }

  private readonly toolImages = new Map<number, Img>();

  private toolImage(p: BuildProduct): Img {
    return this.toolImages.get(p.buttonImage) ?? null;
  }

  /** The tool products' bitmaps (Catalog::Init loads them with the products). */
  private async loadToolImages(list: BuildProduct[]): Promise<void> {
    const ids = list.filter((p) => p.kind === ProductKind.Tool && !this.toolImages.has(p.buttonImage)).map((p) => p.buttonImage);
    await Promise.all(ids.map(async (id) => this.toolImages.set(id, await this.ctx.res.image(id).catch(() => null))));
  }

  /** cWinArch::SetRoofMode */
  private setRoofMode(on: boolean): void {
    this.roofMode = on;
    if (!on) {
      for (const p of this.products) this.buttons.get(p)?.showWindow();
      this.roofPanel?.hideWindow();
      return;
    }
    for (const p of this.products) this.buttons.get(p)?.hideWindow();
    this.prevBtn.hideWindow();
    this.nextBtn.hideWindow();
    this.roofPanel?.showWindow();
    this.roofPanel?.updateViewFromCPState();
  }

  /** cWinArch::UpdateViewFromCPState */
  updateViewFromCPState(): void {
    if (this.updating) return;
    this.updating = true;
    try {
      this.update(this.ctx.state);
    } finally {
      this.updating = false;
    }
  }

  private update(s: CPState): void {
    const old = this.tool;
    this.tool = s.archGetCurrentTool();
    if ((s.dirty & DIRTY_TOOLS) !== 0) this.updateTools(s, old);
    if ((s.dirty & DIRTY_ARCH_UNDO) !== 0) {
      this.undoBtn.setEnabled(s.archCanUndo());
      this.redoBtn.setEnabled(s.archCanRedo());
    }
  }

  private updateTools(s: CPState, old: ArchTool): void {
    const tool = this.tool;
    this.toolBtns[old]?.setState(0);
    this.toolBtns[tool]?.setState(1);
    if (tool === ArchTool.Roof) {
      this.setRoofMode(true);
      return;
    }
    if (old === ArchTool.Roof) this.setRoofMode(false);
    for (const p of this.products) {
      const b = this.buttons.get(p);
      if (!b) continue;
      b.setState(0);
      b.hideWindow();
    }
    this.products = [];
    const changed = tool !== old || (tool === ArchTool.Floor && (s.dirty & DIRTY_FLOORS) !== 0);

    let list = (this.all ?? []).filter((p) => p.testArchTool(tool));
    const perPage = this.perPage;
    if (this.page < 0 || list.length === 0) this.page = 0;
    else if (Math.trunc(list.length / perPage) <= this.page) this.page = Math.trunc((list.length - 1) / perPage);

    let prevVisible = false;
    let nextVisible = false;
    if (list.length !== 0) {
      if (list.length > 1) {
        const type = ARCH_SORT_TYPE[tool] ?? 0;
        if (type !== 0 || tool === ArchTool.Floor) list = list.sort(archObjectSort(type));
        list.forEach((p, i) => {
          if (p.object) p.toolIndex = i;
        });
      }
      let current = s.archGetCurrentSubtool();
      let found = false;
      let slot = -1;
      if (changed) {
        let idx = list.indexOf(current as BuildProduct);
        if (idx < 0) {
          s.archSetCurrentSubtool(list[0]!);
          current = list[0]!;
          idx = 0;
        }
        this.page = Math.trunc(idx / perPage);
        found = true;
        slot = idx - this.page * perPage;
      } else {
        const idx = list.indexOf(current as BuildProduct);
        if (idx >= 0 && Math.trunc(idx / perPage) === this.page) {
          found = true;
          slot = idx - this.page * perPage;
        }
      }
      prevVisible = this.page * perPage > 0;
      list = list.slice(this.page * perPage);
      nextVisible = list.length - perPage > 0;
      list = list.slice(0, perPage);
      this.showProducts(list, slot, found, tool !== old);
    }
    if (prevVisible) this.prevBtn.showWindow();
    else this.prevBtn.hideWindow();
    if (nextVisible) this.nextBtn.showWindow();
    else this.nextBtn.hideWindow();
  }

  /** The page's buttons: shown, the sub-tool's one down, laid out in the grid. */
  private showProducts(list: BuildProduct[], slot: number, found: boolean, toolChanged: boolean): void {
    this.products = list;
    const s = this.ctx.state;
    list.forEach((p, i) => {
      const b = this.buttonFor(p);
      if (!b) return;
      if (b.parent !== this) this.childAdd(b);
      b.showWindow();
      if (i !== slot) return;
      if (toolChanged) {
        this.posted = b;
        s.updateWorldFromCPState(0x10);
      }
      b.setState(found ? 1 : 0);
    });
    this.layoutProducts();
  }

  private layoutProducts(): void {
    const cells = this.cells();
    let k = 0;
    for (const p of this.products) {
      const b = this.buttons.get(p);
      if (!b || !b.isVisible()) continue;
      const cell = cells[k++];
      if (cell) b.moveTo(cell[0], cell[1]);
    }
  }

  /** cWinArch::PageLeft */
  pageLeft(): void {
    if (this.prevBtn.isVisible()) this.tsOnCommand(CMD_BUTTON, this.prevBtn);
  }

  /** cWinArch::PageRight */
  pageRight(): void {
    if (this.nextBtn.isVisible()) this.tsOnCommand(CMD_BUTTON, this.nextBtn);
  }

  /** cWinArch::LowerPopup */
  lowerPopup(): void {
    this.popup.disablePopup();
  }

  override tsOnCommand(cmd: number, src: TSWin): boolean {
    const s = this.ctx.state;
    if (cmd === CMD_ASYNC) {
      for (const p of this.products) if (this.buttons.get(p) === src) this.popup.enablePopup(p.object ?? p, this);
      return true;
    }
    if (cmd !== CMD_BUTTON) return false;
    if (src === this.undoBtn) {
      if (s.archCanUndo()) s.archUndo();
      return true;
    }
    if (src === this.redoBtn) {
      if (s.archCanRedo()) s.archRedo();
      return true;
    }
    if (src === this.prevBtn) {
      if (this.page > 0) {
        this.page--;
        s.setDirty(0x10);
      }
      return false;
    }
    if (src === this.nextBtn) {
      this.page++;
      s.setDirty(0x10);
      return false;
    }
    const tool = this.toolBtns.indexOf(src as TSWinBtn);
    for (let i = 0; i < TOOLS; i++) {
      if (i !== tool && i !== s.archGetCurrentTool()) this.toolBtns[i]!.setState(0);
    }
    if (tool >= 0) {
      this.toolBtns.forEach((b, i) => b.setState(i === tool ? 1 : 0));
      s.archSetCurrentTool(tool as ArchTool);
      return true;
    }
    for (const p of this.products) {
      if (this.buttons.get(p) !== src) continue;
      s.archSetCurrentSubtool(p);
      if (this.popup.shown) this.popup.enablePopup(p.object ?? p, this);
      return true;
    }
    return false;
  }

  /**
   * TSOnMouseMove / TSOnMouseExit(Child): the popup goes away when the mouse
   * leaves the panel, or moves over the panel itself outside the popup zone.
   */
  override pump(nowMs: number): void {
    super.pump(nowMs);
    const posted = this.posted;
    if (posted) {
      this.posted = null;
      this.tsOnCommand(CMD_BUTTON, posted);
    }
    if (!this.popup.shown) return;
    const { x, y } = winMgr.cursorPosition();
    let root: TSWin = this;
    while (root.parent) root = root.parent;
    const o = root.absOrigin();
    const under = root.windowFromPoint(x - o.x, y - o.y);
    let inside = false;
    for (let w = under; w; w = w.parent) if (w === this) inside = true;
    if (!inside) {
      this.popup.disablePopup();
      return;
    }
    if (under === this) {
      const me = this.absOrigin();
      const lx = x - me.x;
      const ly = y - me.y;
      if (lx < POPUP_ZONE_X || ly < POPUP_ZONE_Y || lx >= this.getW() || ly >= GRID_BOTTOM) this.popup.disablePopup();
    }
  }

  /** cWinArch::TSPaint: the first paint lays the buttons out; then the background and the toothpicks. */
  override tsPaint(g: Gfx): void {
    if (this.needLayout) {
      const xoff = this.panelOffset();
      const place = (b: TSWin, x: number, y: number): void => b.setArea(x, y, x + b.getW(), y + b.getH());
      place(this.undoBtn, UNDO_POS[0] - xoff, UNDO_POS[1]);
      place(this.redoBtn, REDO_POS[0] - xoff, REDO_POS[1]);
      this.toolBtns.forEach((b, i) => place(b, TOOL_POS[i]![0] - xoff, TOOL_POS[i]![1]));
      this.layoutProducts();
      place(this.prevBtn, PREV_PAGE_POS[0] - xoff, PREV_PAGE_POS[1]);
      place(this.nextBtn, this.getW() - NEXT_PAGE_FROM_RIGHT, PAGE_Y);
      this.needLayout = false;
    }
    if (this.background) g.blit(this.background, 0, 0);
    if (this.toothPick1) g.blit(this.toothPick1, TOOTHPICK1_POS[0], TOOTHPICK1_POS[1]);
    if (this.toothPick2) g.blit(this.toothPick2, TOOTHPICK2_POS[0], TOOTHPICK2_POS[1]);
  }
}
