/**
 * Live mode "Inventory" page (Panel 7, the gift icon).
 *
 * WinGift is cWinGift (WinGift.cpp): a 42 x 60 toggle button for one
 * inventory GUID. cWinGift::cWinGift looks the GUID up
 * (ObjectFolder::GetSelectorByGUID): name = ObjSelector::GetCatalogName,
 * description = GetCatalogDescription, picture = the object file's catalog
 * BMP_ (OBJD +0x52, magenta keyed); an unknown GUID is "Unknown Item: %d"
 * with an empty description and kItemUnknown. Init: SetImage(0, 4, 1), font
 * lbl_105BA2E8[7], toggled and firing on press (+0xf0 = 1, +0xec = 1),
 * tooltip = the name. TSPaint: the left half of the picture centered at the
 * top, then the token count ("%d") centered in (0, h + 3, 42, h + 3 +
 * charHeight) over a (0, 0, 0x4a) fill, in the 50 % blend of the UI font
 * color and (0x40, 0x5d, 0x5f). SetupClient: the shared popup client
 * (cWinPeople+0x348) gets the name and description.
 *
 * GiftsPanel is the window cWinPeople::BuildGiftPanel builds at
 * cWinPeople+0x328 (title STR# 0x8d of Live.iff, page buttons, the three
 * sort buttons of cWinPeople::InitInventorySorts), with
 * cWinPeople::BuildGifts (one button per token GUID of the selected sim's
 * SimInventory, sorted by GUID, one row per page) and the Panel 7 clicks of
 * cWinPeople::TSOnCommand (pages and sorts; the gift clicks open the popup,
 * which WinPeople handles).
 *
 * Sorts (BuildGifts): gifts = token types 0, 4 and 5, magic = type 7,
 * other = type 8.
 */

import type { GameContext } from "../../context.js";
import type { SimInventory } from "../../data/neighborhood.js";
import { ALIGN_CENTER, type FfnFont } from "../../res/ffn.js";
import { decodeImage } from "../../res/bmp.js";
import { setToNextToken, countTokensOfType } from "../../sim/inventory.js";
import { BTN_TOGGLE, TSWinBtn } from "../../ui/btn.js";
import { DOUBLE_BYTE_UI } from "../../res/uires.js";
import { rgb } from "../../ui/syscolors.js";
import { TSWinText, WTF_MULTILINE } from "../../ui/text.js";
import { type Gfx, TSWin } from "../../ui/tswin.js";
import type { ObjSelector } from "../../world/objselector.js";
import type { WinLivePopupClient } from "../livepopup.js";

/** lbl_105BCB4C: the count format, then the unknown item's name and (empty) description. */
const COUNT_FORMAT = "%d";
const UNKNOWN_NAME = "Unknown Item: %d";
/** cWinGift::Init: button size. */
const GIFT_W = 0x2a;
const GIFT_H = 0x3c;
/** lbl_105BA950 (InitSimsColors (0, 0, 0x4a)): the count's background. */
const COUNT_FILL = rgb(0, 0, 0x4a);
/**
 * lbl_105C2FFC: the blend table lbl_105BA5E0 (+0x7c00, 50 %) of
 * lbl_105BA6F8 (0xc3, 0xcd, 0xcd) and lbl_105BA924 (0x40, 0x5d, 0x5f) in
 * 15-bit color: (24 + 8) / 2, (25 + 11) / 2, (25 + 11) / 2 in 5 bits.
 */
const COUNT_COLOR = rgb(16 << 3, 18 << 3, 18 << 3);

/** Token types each sort shows (BuildGifts). */
const GIFT_TYPES = [0, 4, 5];
const MAGIC_TYPES = [7];
const OTHER_TYPES = [8];

/**
 * What the page reads from the simulation, installed by the lot view
 * (the original reaches the Neighborhood and the ObjectFolder through
 * globals): the inventory of a person by its OBJD GUID
 * (Neighborhood::FindNeighborByGUID + GetInventoryByNeighbourID) and
 * ObjectFolder::GetSelectorByGUID.
 */
export interface GiftsSource {
  inventory(personGuid: number): SimInventory | null;
  selector(guid: number): Promise<ObjSelector | null>;
}

export class WinGift extends TSWinBtn {
  /** +0x190: the token count shown under the picture. */
  count = 0;
  /** +0x194 / +0x198: catalog name and description. */
  private name = "";
  private desc = "";
  /** +0x1a0: the catalog picture (two halves side by side), or kItemUnknown. */
  private picture: ImageBitmap | null = null;
  private countFont: FfnFont | null = null;

  constructor(
    readonly ctx: GameContext,
    /** +0x19c: the page's shared popup client (cWinPeople+0x348). */
    readonly client: WinLivePopupClient,
    /** +0x18c: the token GUID. */
    readonly guid: number,
  ) {
    super();
    // cWinGift::Init's sizes are set here: BuildGifts lays new buttons out at once.
    // SetImage(0, 4, 1); 42 x 60; +0xf0 = 1, +0xec = 1.
    this.cols = 4;
    this.setArea(0, 0, GIFT_W, GIFT_H);
    this.mode = BTN_TOGGLE;
    this.sendOnDown = true;
  }

  /** cWinGift::cWinGift (the lookups) and the rest of cWinGift::Init. */
  override async init(): Promise<boolean> {
    this.countFont = await this.ctx.fonts.acquire(7);
    this.font = this.countFont;
    const sel = (await GiftsPanel.source?.selector(this.guid)) ?? null;
    if (!sel) {
      this.name = UNKNOWN_NAME.replace("%d", String(this.guid | 0));
      this.desc = "";
    } else {
      this.name = sel.getCatalogName();
      this.desc = sel.getCatalogDescription();
      this.picture = await catalogPicture(sel);
    }
    this.picture ??= await this.ctx.res.image("kItemUnknown");
    this.tooltip = this.name;
    return true;
  }

  /** cWinGift::SetupClient */
  setupClient(): void {
    this.client.setName(this.name);
    this.client.setDesc(this.desc);
  }

  /** cWinGift::TSPaint */
  override tsPaint(g: Gfx): void {
    const pic = this.picture;
    if (!pic) return;
    const half = Math.trunc(pic.width / 2);
    g.blitPart(pic, 0, 0, half, pic.height, Math.trunc((this.getW() - half) / 2), 0);
    const font = this.countFont;
    if (!font) return;
    const top = pic.height + 3;
    g.fill(0, top, GIFT_W, font.height, COUNT_FILL);
    const rect = { left: g.ox, top: g.oy + top, right: g.ox + GIFT_W, bottom: g.oy + top + font.height };
    font.drawTextPara(g.ctx, rect, COUNT_FORMAT.replace("%d", String(this.count)), ALIGN_CENTER, COUNT_COLOR);
  }
}

/** nsSMResFac::LoadBuffer(selector file, OBJD +0x52): the catalog BMP_, magenta keyed. */
async function catalogPicture(sel: ObjSelector): Promise<ImageBitmap | null> {
  const bytes = sel.res.get("BMP_", sel.objd.i16(0x52));
  if (!bytes) return null;
  try {
    const img = decodeImage(bytes, "gift.bmp", { colorKey: true });
    return await createImageBitmap(new ImageData(img.data, img.width, img.height));
  } catch {
    return null;
  }
}

export class GiftsPanel extends TSWin {
  /** Installed by the lot view; the page stays empty without it. */
  static source: GiftsSource | null = null;

  /** cWinPeople+0x330 / +0x334. */
  prevPage!: TSWinBtn;
  nextPage!: TSWinBtn;
  /** cWinPeople+0x1a8 / +0x1a4 / +0x1ac (InitInventorySorts). */
  giftSort!: TSWinBtn;
  magicSort!: TSWinBtn;
  otherSort!: TSWinBtn;
  /** cWinPeople+0x358: one button per GUID ever shown (reused). */
  readonly gifts: WinGift[] = [];
  /** cWinPeople+0x34c: the buttons of the current list, in order. */
  private shown: WinGift[] = [];
  /** cWinPeople+0x338 / +0x33c: left and top of the gift row. */
  private gridLeft = 0;
  private gridTop = 0;
  /** cWinPeople+0x368 - 1: gifts per page (9 at 1024 x 768, else 5). */
  private readonly perPage: number;
  /** cWinPeople+0x36c / +0x370: current page and page count. */
  private page = 0;
  private pages = 1;

  constructor(
    readonly ctx: GameContext,
    /** cWinPeople+0x348: the gifts' popup client. */
    readonly client: WinLivePopupClient,
  ) {
    super();
    this.perPage = (ctx.width === 1024 ? 10 : 6) - 1;
  }

  /** cWinPeople::BuildGiftPanel, then cWinPeople::InitInventorySorts. */
  override async init(): Promise<boolean> {
    const { ctx } = this;
    const { res, strings } = ctx;
    // The subpanel rect (0, 50, 280, 150), 224 px wider at 1024 x 768, moved to (300, 50);
    // (0, 0, 280, 150) moved to (300, 0) in a double-byte UI (lbl_105BC4EC / lbl_105BC4E4).
    const top = DOUBLE_BYTE_UI ? 0 : 50;
    this.setArea(0, top, 280 + (ctx.width === 1024 ? 0xe0 : 0), 150);
    this.moveTo(300, top);

    // Title: STR# 0x8d entry 0 in lbl_105BA2E8[6] at (5, 0) (lbl_105BC4D8; (10, 5), lbl_105BC4DC,
    // double-byte), one line, fitted.
    await strings.load("GameData/Live.iff");
    const smallFont = await ctx.fonts.acquire(6);
    const title = new TSWinText();
    title.setFont(smallFont);
    const titlePos = DOUBLE_BYTE_UI ? { x: 10, y: 5 } : { x: 5, y: 0 };
    title.moveTo(titlePos.x, titlePos.y);
    title.setBackgroundOpaque(false);
    title.setCaption(strings.get("Live", 0x8d, 0));
    this.childAdd(title);
    title.setWinTextFlag(WTF_MULTILINE, false);
    title.fitWindowToText();
    this.gridTop = titlePos.y + title.getH() + 5;

    const button = async (name: string): Promise<TSWinBtn> => {
      const b = new TSWinBtn(0, await res.image(name), 4, 1);
      b.sendOnDown = true;
      this.childAdd(b);
      return b;
    };
    this.prevPage = await button("kCatalogPrevPage");
    this.nextPage = await button("kCatalogNextPage");
    this.prevPage.hideWindow();
    this.nextPage.hideWindow();
    // Centered in the space under the title: prev at x 0x22, next 2 px from the right edge.
    const py = this.gridTop + ((this.getH() - this.gridTop - this.prevPage.getH()) >> 1);
    this.prevPage.moveTo(0x22, py);
    this.nextPage.moveTo(this.getW() - this.nextPage.getW() - 2, py);
    this.gridLeft = this.prevPage.getW() + 0x24;
    await strings.load("GameData/UIText.iff");
    this.prevPage.tooltip = strings.get("UIText", 0x9a, 0);
    this.nextPage.tooltip = strings.get("UIText", 0x9a, 1);

    // InitInventorySorts: three toggles at x 2, magic, other then gifts from the top
    // (font height + 0x14, one px apart; + 0x28 double-byte); gifts starts down. Tooltips UIText STR# 0xf1.
    this.giftSort = await button("kInventoryGiftSort");
    this.magicSort = await button("kInventoryMagicSort");
    this.otherSort = await button("kInventoryOtherSort");
    for (const b of [this.giftSort, this.magicSort, this.otherSort]) b.mode = BTN_TOGGLE;
    this.giftSort.setState(1);
    this.giftSort.tooltip = strings.get("UIText", 0xf1, 0);
    this.magicSort.tooltip = strings.get("UIText", 0xf1, 1);
    this.otherSort.tooltip = strings.get("UIText", 0xf1, 2);
    const fh = smallFont.height;
    if (!DOUBLE_BYTE_UI) {
      this.magicSort.moveTo(2, fh + 0x14);
      this.otherSort.moveTo(2, fh + this.giftSort.getH() + 0x15);
      this.giftSort.moveTo(2, fh + this.magicSort.getH() * 2 + 0x16);
    } else {
      this.magicSort.moveTo(2, fh + 0x28);
      this.otherSort.moveTo(2, fh + this.giftSort.getH() + 0x29);
      this.giftSort.moveTo(2, fh + this.otherSort.getH() + this.magicSort.getH() + 0x2a);
    }
    this.page = 0;
    this.pages = 1;
    return true;
  }

  /** The token types the sort that is down shows (the head of BuildGifts). */
  private sortTypes(): number[] {
    if (this.giftSort.state === 1) return GIFT_TYPES;
    if (this.otherSort.state === 1) return OTHER_TYPES;
    if (this.magicSort.state === 1) return MAGIC_TYPES;
    return [];
  }

  /** The gift button of a GUID, made (hidden) on first use. */
  private giftFor(guid: number): WinGift {
    let g = this.gifts.find((x) => x.guid === guid);
    if (!g) {
      g = new WinGift(this.ctx, this.client, guid);
      this.gifts.push(g);
      this.childAdd(g);
      g.hideWindow();
      void g.init();
    }
    return g;
  }

  /** cWinPeople::BuildGifts: `personIndex` is the selected family index. */
  buildGifts(personIndex: number): void {
    const p = this.ctx.state.family[personIndex];
    const inv = p?.guid !== undefined ? (GiftsPanel.source?.inventory(p.guid) ?? null) : null;
    if (!inv) return;
    const types = this.sortTypes();
    this.shown = [];
    for (const g of this.gifts) {
      g.count = 0;
      g.hideWindow();
    }
    let total = 0;
    for (const type of types) {
      const n = countTokensOfType(inv, type);
      total += n;
      let index = -1;
      for (let i = 0; i < n; i++) {
        // SetToNextToken + GetTokenAtIndex: (guid, count) of the next token of the type.
        index = setToNextToken(inv, type, index, 0).index;
        const t = inv.tokens[index];
        if (!t) break;
        const g = this.giftFor(t.guid);
        this.shown.push(g);
        g.count = t.count;
      }
    }
    // cWinGift_LessThan: by GUID, unsigned.
    this.shown.sort((a, b) => (a.guid >>> 0) - (b.guid >>> 0));
    this.pages = Math.ceil(total / this.perPage);
    if (total === 0) {
      this.nextPage.hideWindow();
      this.prevPage.hideWindow();
      return;
    }
    if (this.pages <= this.page) this.page = this.pages - 1;
    if (this.page === 0) {
      this.prevPage.hideWindow();
      if (this.pages === 1) this.nextPage.hideWindow();
      else this.nextPage.showWindow();
    } else if (this.page === this.pages - 1) {
      this.prevPage.showWindow();
      this.nextPage.hideWindow();
    } else {
      this.prevPage.showWindow();
      this.nextPage.showWindow();
    }
    for (let i = this.page * this.perPage; i < (this.page + 1) * this.perPage && i !== this.shown.length; i++) {
      const g = this.shown[i]!;
      const col = i - Math.trunc(i / this.perPage) * this.perPage;
      const top = this.gridTop + Math.trunc((this.getH() - this.gridTop - g.getH()) / 2);
      g.moveTo(this.gridLeft + col * g.getW(), top);
      g.showWindow();
    }
  }

  /** cWinPeople::TSOnCommand, Panel 7: previous page. */
  prev(personIndex: number): void {
    this.page = Math.max(0, this.page - 1);
    this.buildGifts(personIndex);
  }

  /** cWinPeople::TSOnCommand, Panel 7: next page (clamped to the page count, as the original). */
  next(personIndex: number): void {
    this.page = Math.min(this.page + 1, this.pages);
    this.buildGifts(personIndex);
  }

  /**
   * cWinPeople::TSOnCommand, Panel 7: a sort button pressed (it toggled
   * itself) puts the two others up. The original then sets CPState dirty
   * 0x4000000, whose UpdateViewFromCPState rebuilds the list; here it is
   * rebuilt directly. Returns false for other sources.
   */
  sortPressed(source: TSWin, personIndex: number): boolean {
    const sorts = [this.giftSort, this.magicSort, this.otherSort];
    if (!sorts.includes(source as TSWinBtn)) return false;
    for (const b of sorts) if (b !== source) b.setState(0);
    this.buildGifts(personIndex);
    return true;
  }
}
