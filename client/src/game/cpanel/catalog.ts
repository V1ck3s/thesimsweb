/**
 * cWinCatalog — the buy mode catalog: category ("book") buttons, then the
 * chosen book's sub-sort buttons and its products, a page of product
 * buttons at a time, and the product sheet popup (cWinCatalogPopup).
 *
 * Ported from the Mac build (cWinCatalog.c, the jump table cases in
 * WinCatalog.s and .__sinit__WinCatalog_cpp) with the Windows build's
 * recovered switch statements (cWinCatalog::Init / TSOnCommand, LoadBooks
 * 0x5067d2, UpdateViewFromCPState 0x5072f5, SetProduct 0x506635).
 *
 * The catalog state lives in CPState (sort, sort state, book and sub-sort
 * per sort, page, picked product). The view control's buy button picks the
 * sort (room or function on a house lot; the community sorts on community
 * lots); a book shows its products, filtered by the OBJD sort flags, sorted
 * by price then name (data/catalog.ts).
 *
 * Picking a product (SetProduct) stores it with CPState.shopSetCatalogItem
 * (dirty 0x200): the lot view reads shopGetCatalogItem() and starts placing
 * it, and calls shopSoldItem() once it is bought, which comes back here as
 * soldItem(). A product the family cannot afford is refused.
 *
 * Not ported: the placement tool switches (cGameTools tool 7), the wait
 * cursor while thumbnails render, UI sounds, red tooltips for unaffordable
 * products (cDefaultTTWindow::SetColor), and the build mode products.
 */

import { Mode, CatalogSortState, DIRTY_CATALOG, DIRTY_PERSON, DIRTY_SHOP_ITEM, type CPState } from "../cpstate.js";
import type { GameContext } from "../context.js";
import { loadCatalog, OBJD, type Catalog, type Product } from "../data/catalog.js";
import { BTN_TOGGLE, TSWinBtn } from "../ui/btn.js";
import { Gfx, TSWin } from "../ui/tswin.js";
import { winMgr } from "../ui/winmgr.js";
import { WinCatalogPopup } from "./buy/catalogpopup.js";
import { CMD_ASYNC, ProductButton } from "./buy/productbutton.js";
import {
  BACK_IDS,
  BOOK_IDS,
  BOOK_POS,
  BOOK_TIP_BASE,
  catalogMask,
  firstIndex,
  FUNCTION_MASKS,
  FUNCTION_MISC,
  FUNCTION_SUBSORT_BASE,
  GRID_BOTTOM,
  GRID_CELL,
  GRID_RIGHT_MARGIN,
  GRID_STEP,
  GRID_X,
  GRID_Y,
  NEXT_PAGE_FROM_RIGHT,
  NEXT_PAGE_Y,
  PAGE_BUTTON_IDS,
  POPUP_ZONE_X,
  PREV_PAGE_POS,
  ROOM_MASKS,
  subCatalogMask,
  subFunctionIndex,
  SUBSORT_ALL,
  SUBSORT_IDS,
  SUBSORT_MAGIC,
  SUBSORT_OTHER,
  SUBSORT_PETS,
  SUBSORT_POS,
  SUBSORT_TIP_BASE,
} from "./buy/tables.js";

/** Every button of the catalog sends command 1 (cTSWinBtn::SendButtonCommand). */
const CMD_BUTTON = 1;
/** UIText string sets (LoadUIStrings with GetStringConstant(9) = UIText). */
const STR_PAGES = 0x9a;
const STR_BOOKS = 0x96;
const STR_SUBSORTS = 200;
const STR_SUBSORT_EXTRA = 0xd2;
const SORTS = 7;

type Img = ImageBitmap | null;

export class WinCatalog extends TSWin {
  private background: Img = null;
  private template: Img = null;
  private template1: Img = null;
  private unknownItem: Img = null;
  /** +0xdc: previous and next page. */
  private pageBtns: TSWinBtn[] = [];
  /** +0x1c4: the chosen book's picture, a button back to the books. */
  private backBtn = new TSWinBtn(CMD_BUTTON);
  /** +0x3f8: the eight book / sub-sort buttons. */
  private bookBtns: TSWinBtn[] = [];
  private backImages: Img[][] = [];
  private bookImages: Img[][] = [];
  private subsortImages: Array<Img[] | null> = [];
  /** +0x368: four sub-sort pictures per function book. */
  private functionSubImages: Img[][] = [];
  private petsImage: Img = null;
  private magicImage: Img = null;
  private otherImage: Img = null;
  private allImage: Img = null;
  private bookTips: string[] = [];
  private subsortTips: string[][] = [];
  /** STR# 210: back, other, all, pets, magic. */
  private extraTips: string[] = [];
  private popup: WinCatalogPopup;
  private catalog: Catalog | null = null;
  private readonly buttons = new Map<Product, ProductButton>();
  /** +0x418: the products on the page, one per grid slot. */
  private slots: Array<Product | null> = [];
  /** "Has products" flags of the sub-sort buttons (Init): [book * 8 + sub-sort]. */
  private readonly roomHas = new Uint8Array(64);
  private readonly functionSubHas = new Uint8Array(64);
  private readonly communityHas = Array.from({ length: 5 }, () => new Uint8Array(64));

  constructor(readonly ctx: GameContext) {
    super();
    this.popup = new WinCatalogPopup(ctx);
  }

  override async init(): Promise<boolean> {
    const { ctx } = this;
    const img = (id: number): Promise<Img> => (id ? ctx.res.image(id).catch(() => null) : Promise.resolve(null));
    if (!(await this.popup.init())) return false;
    [this.background, this.template, this.template1, this.unknownItem] = await Promise.all([
      ctx.res.image("kUniversalCPBkg"),
      img(ctx.res.id("kCatalogTemplate")),
      img(ctx.res.id("kCatalogTemplate1Frame")),
      img(ctx.res.id("kItemUnknown")),
    ]);

    const tips = ctx.strings.list("UIText", STR_PAGES);
    for (let i = 0; i < 2; i++) {
      const b = new TSWinBtn(CMD_BUTTON);
      const im = await img(PAGE_BUTTON_IDS[i]!);
      if (im) b.setImage(im, 4, 1);
      b.tooltip = tips[i] ?? "";
      this.pageBtns.push(b);
      this.childAdd(b);
    }

    this.backImages = await Promise.all(BACK_IDS.map((row) => Promise.all(row.map(img))));
    const back = this.backImages[0]![0];
    if (back) this.backBtn.setImage(back, 4, 1);
    this.childAdd(this.backBtn);
    this.extraTips = ctx.strings.list("UIText", STR_SUBSORT_EXTRA);
    this.backBtn.tooltip = this.extraTips[0] ?? "";

    [this.otherImage, this.allImage, this.petsImage, this.magicImage] = await Promise.all([
      img(SUBSORT_OTHER),
      img(SUBSORT_ALL),
      img(SUBSORT_PETS),
      img(SUBSORT_MAGIC),
    ]);
    this.bookImages = await Promise.all(BOOK_IDS.map((row) => Promise.all(row.map(img))));
    this.subsortImages = await Promise.all(SUBSORT_IDS.map((row) => (row ? Promise.all(row.map(img)) : null)));
    this.functionSubImages = await Promise.all(
      Array.from({ length: 8 }, (_, fn) => Promise.all([0, 1, 2, 3].map((i) => img(FUNCTION_SUBSORT_BASE + fn * 10 + i)))),
    );
    for (let i = 0; i < 8; i++) {
      const b = new TSWinBtn(CMD_BUTTON);
      b.mode = BTN_TOGGLE;
      b.sendOnDown = true;
      this.bookBtns.push(b);
      this.childAdd(b);
    }

    this.bookTips = ctx.strings.list("UIText", STR_BOOKS);
    this.subsortTips = Array.from({ length: 8 }, (_, fn) => ctx.strings.list("UIText", STR_SUBSORTS + fn));

    this.loadBooks(ctx.state.shopGetSort());
    ctx.state.soldItemHandler = () => this.soldItem();
    // CPState::GetCatalog builds the catalog on first use; the panel shows once it is there.
    void loadCatalog().then((c) => {
      this.catalog = c;
      this.computeHasProducts(c);
      ctx.state.setDirty(DIRTY_CATALOG);
    });
    return true;
  }

  override shutdown(): void {
    this.popup.disablePopup();
    if (this.ctx.state.soldItemHandler) this.ctx.state.soldItemHandler = null;
    super.shutdown();
  }

  /** The "has products" tables of the sub-sort buttons (end of cWinCatalog::Init). */
  private computeHasProducts(c: Catalog): void {
    const communityBooks = [0, 1, 2, 3, 7];
    for (const p of c.products) {
      const fn = firstIndex(FUNCTION_MASKS, p.field(OBJD.functionSort));
      if (p.hasRoomSort()) {
        const room = firstIndex(ROOM_MASKS, p.field(OBJD.roomSort));
        if (room >= 0 && fn >= 0) this.roomHas[room * 8 + fn] = 1;
      }
      for (let s = 2; s < SORTS; s++) {
        if (!p.hasCommunitySort(s)) continue;
        for (const k of communityBooks) {
          if (p.testInCommunityRoom(s, 1 << k) && fn >= 0) this.communityHas[s - 2]![k * 8 + fn] = 1;
        }
      }
      if (p.hasFunctionSort() && p.hasFunctionSubsort()) {
        const sub = subFunctionIndex(p.field(OBJD.functionSubSort));
        if (fn >= 0 && sub >= 0) this.functionSubHas[fn * 8 + sub] = 1;
      }
    }
  }

  /** The catalog's x offset in the control panel (LoadBooks / UpdateViewFromCPState subtract it). */
  private panelOffset(): number {
    return this.area.left;
  }

  // --- books --------------------------------------------------------------------

  /** cWinCatalog::LoadBooks */
  private loadBooks(sort: number): void {
    const s = this.ctx.state;
    const items = s.shopGetSortState() !== CatalogSortState.Books;
    const xoff = this.panelOffset();
    const cat = s.shopGetCatalog();
    if (items) {
      this.backBtn.showWindow();
      const im = this.backImages[sort]?.[cat];
      if (im) this.backBtn.setImage(im, 4, 1);
    } else {
      this.backBtn.hideWindow();
    }
    for (let i = 0; i < 8; i++) {
      const b = this.bookBtns[i]!;
      b.showWindow();
      b.setEnabled(true);
      let image: Img = null;
      let tip = "";
      let enabled = true;
      let pos = items ? SUBSORT_POS[i] : BOOK_POS[sort]![i]!;
      if (!items) {
        image = this.bookImages[sort]![i] ?? null;
        tip = this.bookTips[BOOK_TIP_BASE[sort]! + i] ?? "";
        if (!BOOK_IDS[sort]![i]) image = null;
      } else if (sort === 1) {
        if (i < 4) {
          image = this.functionSubImages[cat]?.[i] ?? null;
          tip = this.subsortTips[cat]?.[i] ?? "";
          enabled = this.functionSubHas[cat * 8 + i] === 1;
        } else if (i === 4 || i === 5) {
          if (cat === FUNCTION_MISC) {
            image = i === 4 ? this.petsImage : this.magicImage;
            tip = this.extraTips[i === 4 ? 3 : 4] ?? "";
            enabled = this.functionSubHas[cat * 8 + i] === 1;
          }
        } else if (i === 6) {
          image = this.otherImage;
          tip = this.extraTips[1] ?? "";
          enabled = this.functionSubHas[cat * 8 + i] === 1;
        } else {
          image = this.allImage;
          tip = this.extraTips[2] ?? "";
        }
      } else {
        image = this.subsortImages[sort]?.[i] ?? null;
        tip = this.bookTips[SUBSORT_TIP_BASE + i] ?? "";
        const has = sort === 0 ? this.roomHas : this.communityHas[sort - 2]!;
        enabled = has[cat * 8 + i] === 1;
      }
      if (!image) {
        b.hideWindow();
        continue;
      }
      b.setImage(image, 4, 1);
      b.tooltip = tip;
      b.setEnabled(enabled);
      pos ??= [0, 0];
      b.moveTo(pos[0] - xoff, pos[1]);
    }
    const w = this.getW();
    this.pageBtns[0]!.moveTo(PREV_PAGE_POS[0] - xoff, PREV_PAGE_POS[1]);
    this.pageBtns[1]!.moveTo(w - NEXT_PAGE_FROM_RIGHT, NEXT_PAGE_Y);
    const bh = this.backBtn.getH();
    const top = Math.trunc((this.getH() - bh) / 2);
    this.backBtn.setArea(-2, top, this.backBtn.getW() - 2, top + bh);
  }

  // --- products -------------------------------------------------------------------

  /** Product::GetButton (created on first show, Product::CreateButton). */
  private buttonFor(p: Product): ProductButton {
    let b = this.buttons.get(p);
    if (!b) {
      const one = !p.hasAnySort();
      b = new ProductButton(p, (one ? this.template1 : this.template)!, one ? 1 : 4);
      b.id = CMD_BUTTON;
      if (this.unknownItem) b.setFallbackIcon(this.unknownItem);
      b.hideWindow();
      this.buttons.set(p, b);
    }
    return b;
  }

  /** The product filter of UpdateViewFromCPState for the current sort, book and sub-sort. */
  private matches(p: Product, sort: number, catMask: number, subMask: number): boolean {
    if (sort === 0) return p.hasRoomSort() && p.testInRoom(catMask) && p.testHasFunction(subMask);
    if (sort === 1) return p.hasRoomSort() && p.testHasFunctionSub(catMask, subMask);
    return p.hasCommunitySort(sort) && p.testInCommunityRoom(sort, catMask) && p.testHasFunction(subMask);
  }

  /** cWinCatalog::UpdateViewFromCPState */
  updateViewFromCPState(): void {
    const s: CPState = this.ctx.state;
    if ((s.dirty & DIRTY_CATALOG) === 0 && !((s.dirty & DIRTY_PERSON) !== 0 && s.getMode() === Mode.Buy)) return;
    const sort = s.shopGetSort();
    const items = s.shopGetSortState() !== CatalogSortState.Books;
    const catMask = catalogMask(sort, s.shopGetCatalog());
    const subMask = subCatalogMask(sort, s.shopGetSubCatalog());

    for (const p of this.slots) if (p) this.buttons.get(p)?.hideWindow();
    this.slots = [];

    // The grid: 45x45 cells from (0x19f, 5) in panel coordinates, row by row.
    const ox = GRID_X - this.panelOffset();
    const maxX = this.getW() - GRID_RIGHT_MARGIN;
    const fits = (x: number, y: number): boolean => x + GRID_CELL <= maxX && y + GRID_CELL <= GRID_BOTTOM;
    const cells: Array<[number, number]> = [];
    for (let x = ox, y = GRID_Y, row = 0; fits(x, y); ) {
      cells.push([x, y]);
      x += GRID_STEP;
      if (x + GRID_CELL > maxX) {
        row++;
        y = GRID_Y + row * GRID_STEP;
        x = ox;
      }
    }
    const perPage = cells.length;
    const page = s.shopGetCatalogPage();
    let more = false;
    if (items && this.catalog) {
      let seen = 0;
      for (const p of this.catalog.products) {
        if (!this.matches(p, sort, catMask, subMask)) continue;
        if (perPage * page <= seen) {
          if (perPage <= this.slots.length) {
            more = true;
            break;
          }
          this.slots.push(p);
          const b = this.buttonFor(p);
          if (b.parent !== this) this.childAdd(b);
          b.showWindow();
        }
        seen++;
      }
    }
    this.slots.forEach((p, i) => {
      const [x, y] = cells[i]!;
      if (p) this.buttons.get(p)!.moveTo(x, y);
    });

    for (const b of this.bookBtns) b.setState(0);
    const sub = s.shopGetSubCatalog();
    if (items && sub >= 0 && sub < 8) this.bookBtns[sub]!.setState(1);
    this.loadBooks(sort);

    const [prev, next] = this.pageBtns as [TSWinBtn, TSWinBtn];
    if (page !== 0) {
      prev.setEnabled(true);
      prev.showWindow();
    } else {
      prev.hideWindow();
    }
    if (more) {
      next.setEnabled(true);
      next.showWindow();
    } else {
      next.hideWindow();
    }
  }

  /** cWinCatalog::SoldItem: every product button up again. */
  soldItem(): void {
    for (const p of this.slots) if (p) this.buttons.get(p)?.setState(0);
  }

  /** cWinCatalog::SetProduct: picks `product` (null: none) if the family can afford it. */
  setProduct(product: Product | null): void {
    const s = this.ctx.state;
    let picked = false;
    this.slots.forEach((p, i) => {
      if (!p) return;
      const b = this.buttons.get(p)!;
      if (p !== product) {
        b.setState(0);
        return;
      }
      s.shopSetCatalogItem(i, p);
      s.setDirty(DIRTY_SHOP_ITEM);
      if (this.popup.shown) this.popup.enablePopup(p, this);
      if (p.canAfford(s.getFunds())) {
        picked = true;
        b.setState(1);
      } else {
        b.setState(0);
        // sound: denied (cTool::DoDeniedSound)
      }
    });
    if (!picked) {
      s.shopSetCatalogItem(-1, null);
      s.setDirty(DIRTY_SHOP_ITEM);
    }
  }

  /** cWinCatalog::LowerPopup */
  lowerPopup(): void {
    this.popup.disablePopup();
  }

  override tsOnCommand(cmd: number, src: TSWin): boolean {
    const s = this.ctx.state;
    if (cmd === CMD_ASYNC) {
      if (src instanceof ProductButton && this.slots.includes(src.product)) this.popup.enablePopup(src.product, this);
      return true;
    }
    if (cmd !== CMD_BUTTON) return true;
    const pageIdx = this.pageBtns.indexOf(src as TSWinBtn);
    if (pageIdx >= 0) {
      s.shopSetCatalogPage(s.shopGetCatalogPage() + (pageIdx === 1 ? 1 : -1));
      return true;
    }
    if (src === this.backBtn) {
      if (s.shopGetSortState() === CatalogSortState.Items) {
        s.shopSetSortState(CatalogSortState.Books);
        this.resetBookStates();
      }
      return true;
    }
    const book = this.bookBtns.indexOf(src as TSWinBtn);
    if (book >= 0) {
      if (s.shopGetSortState() === CatalogSortState.Books) {
        // A book opens on its first sub-sort.
        s.shopSetSortState(CatalogSortState.Items);
        s.shopSetCatalog(book);
        s.shopSetSubCatalog(0);
        this.resetBookStates(this.bookBtns[0]!);
      } else {
        s.shopSetSubCatalog(book);
        this.resetBookStates(this.bookBtns[book]!);
      }
      return true;
    }
    if (src instanceof ProductButton) this.setProduct(this.slots.includes(src.product) ? src.product : null);
    return true;
  }

  /** All eight book buttons up, then `down` down while a book is open. */
  private resetBookStates(down?: TSWinBtn): void {
    for (const b of this.bookBtns) b.setState(0);
    if (down && this.ctx.state.shopGetSortState() === CatalogSortState.Items) down.setState(1);
  }

  /** cWinCatalog::TSOnMouseDownL: a click on the panel itself drops the picked product. */
  override tsOnMouseDownL(): boolean {
    this.setProduct(null);
    return true;
  }

  /**
   * TSOnMouseMove / TSOnMouseExit(Child): the popup goes away when the mouse
   * leaves the catalog, or moves over the catalog itself outside
   * (0x18b, 5)-(width, 95).
   */
  override pump(nowMs: number): void {
    super.pump(nowMs);
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
      if (lx < POPUP_ZONE_X - this.panelOffset() || ly < GRID_Y || ly >= GRID_BOTTOM) this.popup.disablePopup();
    }
  }

  /** cWinCatalog::TSPaint: the control panel background from the catalog's origin. */
  override tsPaint(g: Gfx): void {
    if (this.background) g.blit(this.background, 0, 0);
  }
}
