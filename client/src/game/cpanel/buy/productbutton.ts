/**
 * ProductButton: the catalog button of one product (Product::CreateButton).
 *
 *  - background: kCatalogTemplate (4 frames), or kCatalogTemplate1Frame for a
 *    product without room, function or build sort (Product::SetObject);
 *  - toggle button that sends its command on press (+0xec = 1, +0xf0 = 1);
 *  - async flags 6 (+0x14c): pressing or releasing arms a timer, and once the
 *    quick tips delay has passed (cTSWinBtn::GetDefaultAsyncTimeout, 250 ms by
 *    default) the button sends command 0x13 (cTSWinBtn::TSPaint); leaving it
 *    sends 0x14 (TSOnMouseExit);
 *  - tooltip: the price (lbl_105BA104 money string);
 *  - ProductButton::ForegroundBlt: the product's 74x37 icon, its left half
 *    normally, its right (highlighted) half when the button is down or
 *    hovered, centered on the button.
 */

import type { Product } from "../../data/catalog.js";
import { renderCatalogShot } from "./objecticon.js";
import { makeMoneyString } from "../../nbhd/nghinterface.js";
import { LANG_FRENCH } from "../../res/uires.js";
import { BTN_TOGGLE, TSWinBtn } from "../../ui/btn.js";
import type { Gfx } from "../../ui/tswin.js";

export const CMD_ASYNC = 0x13;
export const CMD_ASYNC_CANCEL = 0x14;
/** lbl_105BA774 (cOptionsMgr: quick tips on). */
const ASYNC_TIMEOUT_MS = 0xfa;

/** What a product button reads from its product (data/catalog Product, data/buildcatalog BuildProduct). */
export interface ButtonProduct {
  getPrice(): number;
  /** Product::GenerateGraphics: the 74x37 picture, null when there is none. */
  icon(): Promise<ImageBitmap | null>;
  /** The object product to render when the file has no picture (RenderCatalogShot). */
  catalogObject?(): Product | null;
}

/** Product +0x1c once RenderCatalogShot made it (the game writes it back into the object file). */
const renderedShots = new WeakMap<Product, Promise<ImageBitmap | null>>();

/** Product::GenerateGraphics' render path: RenderCatalogShot on the catalog template (lbl_105BA780). */
function renderedShot(p: Product, template: ImageBitmap): Promise<ImageBitmap | null> {
  let shot = renderedShots.get(p);
  if (!shot) {
    shot = p.hasGraphics()
      ? p.openFile().then((f) => renderCatalogShot(f, p.rec.objdId, template)).catch(() => null)
      : Promise.resolve(null);
    renderedShots.set(p, shot);
  }
  return shot;
}

export class ProductButton<P extends ButtonProduct = Product> extends TSWinBtn {
  private icon: ImageBitmap | null = null;
  private asyncPending = false;
  private asyncStart = 0;

  constructor(
    readonly product: P,
    template: ImageBitmap,
    cols: number,
  ) {
    super(0, template, cols, 1);
    this.mode = BTN_TOGGLE;
    this.sendOnDown = true;
    this.tooltip = makeMoneyString(product.getPrice(), LANG_FRENCH);
    void product.icon().then((img) => (this.icon = img));
  }

  /**
   * Product::GenerateGraphics without a picture in the file: an object with
   * graphics is rendered (RenderCatalogShot on `template`, the 4-frame
   * kCatalogTemplate), anything else shows kItemUnknown.
   */
  setFallbackIcon(img: ImageBitmap, template: ImageBitmap | null): void {
    void this.product.icon().then(async (icon) => {
      if (icon) return;
      const obj = this.product.catalogObject?.() ?? null;
      this.icon = (obj && template ? await renderedShot(obj, template) : null) ?? img;
    });
  }

  override tsOnMouseDownL(): boolean {
    const r = super.tsOnMouseDownL();
    this.armAsync();
    return r;
  }

  override tsOnMouseUpL(x: number, y: number): boolean {
    const r = super.tsOnMouseUpL(x, y);
    this.armAsync();
    return r;
  }

  override tsOnMouseExit(): void {
    super.tsOnMouseExit();
    if (this.asyncPending) {
      this.parent?.tsOnCommand(CMD_ASYNC_CANCEL, this);
      this.asyncPending = false;
    }
  }

  private armAsync(): void {
    this.asyncPending = true;
    this.asyncStart = performance.now();
  }

  override pump(nowMs: number): void {
    super.pump(nowMs);
    if (this.asyncPending && nowMs - this.asyncStart > ASYNC_TIMEOUT_MS) {
      this.asyncPending = false;
      this.parent?.tsOnCommand(CMD_ASYNC, this);
    }
  }

  override tsPaint(g: Gfx): void {
    super.tsPaint(g);
    const icon = this.icon;
    if (!icon) return;
    const half = this.cols > 1;
    const w = half ? icon.width >> 1 : icon.width;
    const sx = half && (this.state !== 0 || this.entered) ? w : 0;
    const x = (this.getW() - w) >> 1;
    const y = (this.getH() - icon.height) >> 1;
    g.blitPart(icon, sx, 0, w, icon.height, x, y);
  }
}
