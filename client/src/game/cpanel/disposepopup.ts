/**
 * cWinDisposePopup — the control panel page shown while the buy tool holds an
 * object picked up from the lot (cWinCPanel::PanelID 4): the object's
 * picture and "Press Delete or click here to sell % for $.". A click sells
 * it (TSOnMouseUpL -> CPState::DoDispose -> cMoveTool::DoDispose).
 *
 * cWinCPanel::Init places it like the other subpanels: (0xdc, 0x32) to the
 * panel's right edge, 100 high. cWinCPanel::EnableDisposePopup ->
 * EnablePopup + ShowDisposePopup(true) (SetPanel(4)); DisableDisposePopup ->
 * ShowDisposePopup(false), back to the mode's panel.
 *
 * BuildMyBuffer (16-bit buffer of the window's size):
 *  - the control panel background kUniversalCPBkg (cWinCPanel+0xfc) at (0, 0);
 *  - the buffer's Z-buffer (CreateZBuffer, +0x5c) filled with 0xffff in
 *    (0, 0)-(0xa8, 100) (lbl_105BC404; Windows 0050cca5, DAT_006f3648), then
 *    the master selector's DrawDefaultObjectIcon there: the picture is drawn
 *    over the panel background (the fill is the depth, not a white color);
 *  - UIText STR# 0x88 (six entries, else no text): entries 1 / 2 / 3 for buy
 *    mode objects, 4 / 5 / 6 when the master OBJD +0x8a is set: "dispose of
 *    %" when the refund is 0, "sell % for $" otherwise, "% cannot be deleted"
 *    when cXObject::UserCanDelete fails; '%' is Catalog::FindProduct's
 *    product name ("<Unknown>" without a product), '$' the money string;
 *    refund = (int)(factor * GetCurrentValue + 0.5) when not a new purchase
 *    and refundable (+0x108 / +0x109), else 0;
 *  - the text in (0xb2, 0xc)-(0x238, 0x34) (lbl_105BC3F8), font
 *    lbl_105BA2E8 + 0x28 (size 10, cWinDisposePopup+0xd0).
 *
 * TSPaint blits the buffer; its RampGenerator (+0xdc) slide is never started
 * (EnablePopup does not touch it, Mac and Windows), so the page shows at once.
 */

import type { GameContext } from "../context.js";
import type { DisposeItem } from "../cpstate.js";
import { loadCatalog, type Product } from "../data/catalog.js";
import { makeMoneyString } from "../nbhd/nghinterface.js";
import { ALIGN_LEFT, type FfnFont } from "../res/ffn.js";
import { UI_LANGUAGE } from "../res/uires.js";
import { TSWinCtrlMgr } from "../ui/ctrlmgr.js";
import { UI_FONT_COLOR } from "../ui/syscolors.js";
import { Gfx, TSWin } from "../ui/tswin.js";
import { ObjectIcon } from "./buy/objecticon.js";

/** UIText STR# 0x88 (LoadUIStrings(0x88)). */
const STR_DISPOSE = 0x88;
/** lbl_105BC404: the picture rectangle. */
const ICON_RECT = { left: 0, top: 0, right: 0xa8, bottom: 100 };
/** lbl_105BC3F8: the text rectangle. */
const TEXT_RECT = { left: 0xb2, top: 0xc, right: 0x238, bottom: 0x34 };
/** lbl_105BC400 / lbl_105BC408: the rounding added to factor * value. */
const ROUND = 0.5;
/** The literal at lbl_105BC3FC: placeholders and the missing product name. */
const NAME_TOKEN = "%";
const UNKNOWN = "<Unknown>";
const MONEY_TOKEN = "$";

export class WinDisposePopup extends TSWin {
  /** +0xfc: the control panel background. */
  private background: ImageBitmap | null = null;
  /** +0xd0 */
  private font: FfnFont | null = null;
  /** +0x100 */
  private buffer: OffscreenCanvas | null = null;
  private serial = 0;

  constructor(private readonly ctx: GameContext) {
    super();
  }

  /** cWinDisposePopup::Init */
  override async init(): Promise<boolean> {
    const mgr = await TSWinCtrlMgr.get(this.ctx);
    this.font = mgr.tableFont(10);
    this.background = await this.ctx.res.image("kUniversalCPBkg");
    return true;
  }

  /** cWinDisposePopup::EnablePopup(obj, notNew, refundable, factor) */
  enablePopup(item: DisposeItem): void {
    void this.buildMyBuffer(item);
  }

  /** cWinDisposePopup::TSOnMouseUpL */
  override tsOnMouseUpL(): boolean {
    this.ctx.state.doDispose();
    return true;
  }

  /** TSOnMouseDownL__16cWinDisposePopupFllUl: swallowed. */
  override tsOnMouseDownL(): boolean {
    return true;
  }

  /**
   * cWinDisposePopup::BuildMyBuffer. The background and the picture are
   * drawn as soon as the picture is ready; the text needs the product's name
   * (Catalog::FindProduct), and the catalog is built on first use (all the
   * object files read, a long wait the first time in a browser): the text
   * joins once it is there, the page is not left blank meanwhile.
   */
  private async buildMyBuffer(item: DisposeItem): Promise<void> {
    const serial = ++this.serial;
    const catalogRead = loadCatalog().catch(() => null);
    const icon = await ObjectIcon.create(item.res, item.objdId).catch(() => null);
    if (serial !== this.serial) return;
    this.buffer = this.compose(item, icon, undefined);
    const catalog = await catalogRead;
    if (serial !== this.serial || !catalog) return;
    this.buffer = this.compose(item, icon, catalog.products.find((p) => p.guid === item.guid) ?? null);
  }

  /** The page: background, picture, and the text when the catalog is known (`product` undefined: not yet). */
  private compose(item: DisposeItem, icon: ObjectIcon | null, product: Product | null | undefined): OffscreenCanvas {
    const w = this.getW();
    const h = this.getH();
    const c = new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
    const g = c.getContext("2d") as unknown as CanvasRenderingContext2D;
    if (this.background) g.drawImage(this.background, 0, 0);
    icon?.draw(g, ICON_RECT.left, ICON_RECT.top, ICON_RECT.right - ICON_RECT.left, ICON_RECT.bottom - ICON_RECT.top);
    if (product === undefined) return c;

    const refund = item.notNew && item.refundable ? Math.trunc(Math.fround(item.factor * item.currentValue) + ROUND) : 0;
    const strings = this.ctx.strings.list("UIText", STR_DISPOSE);
    if (strings.length === 6) {
      const build = item.buildModeType !== 0;
      const entry = !item.canDelete ? (build ? 6 : 3) : refund === 0 ? (build ? 4 : 1) : build ? 5 : 2;
      let text = strings[entry - 1] ?? "";
      const at = text.indexOf(NAME_TOKEN);
      if (at >= 0) text = text.slice(0, at) + (product ? product.getProductName() : UNKNOWN) + text.slice(at + 1);
      const money = text.indexOf(MONEY_TOKEN);
      if (money >= 0) text = text.slice(0, money) + makeMoneyString(refund, UI_LANGUAGE) + text.slice(money + 1);
      this.font?.drawTextPara(g, TEXT_RECT, text, ALIGN_LEFT, UI_FONT_COLOR);
    }
    return c;
  }

  override tsPaint(g: Gfx): void {
    if (this.buffer) g.blit(this.buffer, 0, 0);
  }
}
