/**
 * Live mode "Interests" page.
 *
 * WinInterest is cWinInterest (WinInterest.cpp): a 125 x 25 tile with the
 * interest's icon (kInterestTravel + index) and a bar (kInterestBars over
 * kInterestBarsBackground, 4 px per point, 0..10). The tooltip is the
 * interest's name (Live.iff STR# 140, entry index + 1).
 *
 * InterestsPanel is the window cWinPeople::BuildInterestWindow builds at
 * cWinPeople+0x250 (caption, page buttons, the 19 tiles), with
 * cWinPeople::BuildInterests (paging, adult / child lists) and the clicks
 * cWinPeople::TSOnCommand handles for Panel 6.
 *
 * The tiles share one popup client (cWinInterest +0x194): SetupClient puts
 * the interest's name (STR# 140 entry index + 1) and description (STR# 142
 * entry index + 1) in it.
 */

import { hudLayoutWidth, type GameContext } from "../../context.js";
import type { PersonInfo } from "../../cpstate.js";
import { DOUBLE_BYTE_UI } from "../../res/uires.js";
import { BTN_TOGGLE, CMD_ASYNC_EXIT, TSWinBtn } from "../../ui/btn.js";
import { TSWinText, WTF_MULTILINE } from "../../ui/text.js";
import { type Gfx, TSWin } from "../../ui/tswin.js";
import { popupClick, type WinLivePopup, WinLivePopupClient } from "../livepopup.js";

/**
 * cWinInterest::SetInterest: person data index of each interest (cXPerson+0x58c
 * is the person data; the value shown is data / 100). Interests 8..11 are the
 * children's names for the same four values as 0..3.
 */
const INTEREST_DATA = [46, 47, 48, 49, 50, 51, 52, 53, 46, 47, 48, 49, 13, 14, 16, 20, 26, 54, 55];
export const INTEREST_COUNT = INTEREST_DATA.length;

/**
 * BuildInterestWindow stores the tiles in two lists (cWinPeople+0x2c0, 15
 * adult interests; +0x2fc, 8 child interests) read by BuildInterests.
 */
const ADULT_INTERESTS = [0, 1, 2, 3, 4, 5, 6, 7, 12, 13, 14, 15, 16, 17, 18];
const CHILD_INTERESTS = [8, 9, 10, 11, 4, 5, 6, 7];

/** Person data: age (cXPerson+0x600); a child is 1..17. */
const PD_AGE = 58;

function isChild(p: PersonInfo): boolean {
  const age = p.personData?.[PD_AGE];
  return age === undefined ? p.isChild : age !== 0 && age < 18;
}

/** Bar bitmaps shared by every tile (cWinInterest statics). */
interface Bars {
  bars: ImageBitmap;
  background: ImageBitmap;
}
let interestBars: Promise<Bars> | null = null;

export class WinInterest extends TSWinBtn {
  /** +0x190: 0..10. */
  private value = 0;
  private icon: ImageBitmap | null = null;
  private bars: Bars | null = null;

  constructor(
    readonly ctx: GameContext,
    /** +0x194: the interests' shared popup client. */
    readonly client: WinLivePopupClient,
    /** +0x18c: interest number, 0..18. */
    readonly index: number,
  ) {
    super();
    // SetImage(0, 4, 1); +0xf0 = 1, +0xec = 1.
    this.cols = 4;
    this.mode = BTN_TOGGLE;
    this.sendOnDown = true;
  }

  override async init(): Promise<boolean> {
    const { res, strings } = this.ctx;
    this.setArea(this.area.left, this.area.top, this.area.left + 0x7d, this.area.top + 0x19);
    await strings.load("GameData/Live.iff");
    this.tooltip = strings.get("Live", 0x8c, this.index + 1);
    this.icon = await res.image(res.id("kInterestTravel") + this.index);
    interestBars ??= (async () => ({
      bars: await res.image("kInterestBars"),
      background: await res.image("kInterestBarsBackground"),
    }))();
    this.bars = await interestBars;
    return true;
  }

  /** cWinInterest::SetupClient: name STR# 0x8c, description STR# 0x8e (entry index + 1). */
  setupClient(): void {
    this.client.setName(this.ctx.strings.get("Live", 0x8c, this.index + 1));
    this.client.setDesc(this.ctx.strings.get("Live", 0x8e, this.index + 1));
  }

  /** cWinInterest::SetInterest. */
  setInterest(p: PersonInfo): void {
    this.value = Math.min(10, Math.trunc((p.personData?.[INTEREST_DATA[this.index]!] ?? 0) / 100));
  }

  override tsPaint(g: Gfx): void {
    if (!this.icon || !this.bars) return;
    g.blit(this.icon, 0, 0);
    const { bars, background } = this.bars;
    const x = this.icon.width + 5;
    g.blit(background, x, 5);
    if (this.value !== 0) g.blitPart(bars, 0, 0, this.value * 4, background.height, x, 5);
  }
}

export class InterestsPanel extends TSWin {
  /** cWinPeople+0x258 / +0x25c. */
  private prevPage!: TSWinBtn;
  private nextPage!: TSWinBtn;
  /** cWinPeople+0x274: one tile per interest. */
  readonly tiles: WinInterest[] = [];
  /** cWinPeople+0x150: the Live panel's popup (set by WinPeople); +0x26c its client for the tiles. */
  livePopup: WinLivePopup | null = null;
  /** cWinPeople::BuildInterestWindow's client, tagged "int" (+0x18). */
  private readonly client = Object.assign(new WinLivePopupClient(), { kind: "int" });
  /** cWinPeople+0x260 / +0x264: top-left of the tile grid. */
  private gridLeft = 0;
  private gridTop = 0;
  /** cWinPeople+0x31c: tile columns per page (3 at 1024 x 768, else 2); 3 rows (4 in a double-byte UI, BuildInterests). */
  private readonly columns: number;
  private readonly rows = DOUBLE_BYTE_UI ? 4 : 3;
  /** cWinPeople+0x320 / +0x324: current page and page count. */
  private page = 0;
  private pages = 0;

  constructor(readonly ctx: GameContext) {
    super();
    this.columns = hudLayoutWidth(ctx) === 1024 ? 3 : 2;
  }

  /** cWinPeople::BuildInterestWindow. */
  override async init(): Promise<boolean> {
    const { ctx } = this;
    const { res, strings } = ctx;
    // The subpanel rect (0, 50, 280, 150), 224 px wider at 1024 x 768, moved to (300, 50);
    // (0, 0, 280, 150) moved to (300, 0) in a double-byte UI (lbl_105BC4EC / lbl_105BC4E4).
    const top = DOUBLE_BYTE_UI ? 0 : 50;
    this.setArea(0, top, 280 + (hudLayoutWidth(ctx) === 1024 ? 0xe0 : 0), 150);
    this.moveTo(300, top);

    // Caption (STR# 140 entry 0) in the small font at (5, 0) (lbl_105BC4D8; (10, 5), lbl_105BC4DC, double-byte).
    await strings.load("GameData/Live.iff");
    const text = new TSWinText();
    text.setFont(await ctx.fonts.acquire(6));
    const titlePos = DOUBLE_BYTE_UI ? { x: 10, y: 5 } : { x: 5, y: 0 };
    text.moveTo(titlePos.x, titlePos.y);
    text.setBackgroundOpaque(false);
    text.setCaption(strings.get("Live", 0x8c, 0));
    this.childAdd(text);
    text.setWinTextFlag(WTF_MULTILINE, false);
    text.fitWindowToText();
    this.gridTop = titlePos.y + text.getH() + 5;

    const pageButton = async (name: string): Promise<TSWinBtn> => {
      const b = new TSWinBtn(0, await res.image(name), 4, 1);
      b.sendOnDown = true;
      b.hideWindow();
      this.childAdd(b);
      return b;
    };
    this.prevPage = await pageButton("kCatalogPrevPage");
    this.nextPage = await pageButton("kCatalogNextPage");
    // Both centered in the space under the caption, against the side edges.
    const py = this.gridTop + ((this.getH() - this.gridTop - this.prevPage.getH()) >> 1);
    this.prevPage.moveTo(2, py);
    this.nextPage.moveTo(this.getW() - this.nextPage.getW() - 2, py);
    this.gridLeft = this.prevPage.getW() + 4;
    await strings.load("GameData/UIText.iff");
    this.prevPage.tooltip = strings.get("UIText", 0x9a, 0);
    this.nextPage.tooltip = strings.get("UIText", 0x9a, 1);

    for (let i = 0; i < INTEREST_COUNT; i++) {
      const tile = new WinInterest(ctx, this.client, i);
      if (!(await tile.init())) return false;
      this.childAdd(tile);
      tile.hideWindow();
      this.tiles.push(tile);
    }
    this.page = 0;
    return true;
  }

  /** cWinPeople::BuildInterests. */
  buildInterests(): void {
    const p = this.ctx.state.personGetSelected();
    if (!p) return;
    const child = isChild(p);
    const list = child ? CHILD_INTERESTS : ADULT_INTERESTS;
    const perPage = this.rows * this.columns;
    this.pages = Math.ceil(list.length / perPage);
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
    for (const t of this.tiles) t.hideWindow();
    for (let c = 0; c < this.columns; c++) {
      for (let r = 0; r < this.rows; r++) {
        const k = this.page * perPage + c * this.rows + r;
        if (k === list.length) return;
        const tile = this.tiles[list[k]!]!;
        tile.setInterest(p);
        tile.moveTo(this.gridLeft + c * (tile.getW() + 3), this.gridTop + r * (tile.getH() + 2));
        tile.showWindow();
      }
    }
  }

  /** cWinPeople::TSOnCommand, Panel 6 part (0x13, the async timeout, is a click). */
  override tsOnCommand(cmd: number, source: TSWin): boolean {
    if (cmd === CMD_ASYNC_EXIT) return true;
    const tile = this.tiles.find((t) => t === source);
    if (tile) {
      // The popup follows the clicked tile; clicking it again closes it.
      if (this.livePopup) popupClick(this.livePopup, this.client, this.parent ?? this, tile, () => tile.setupClient());
      return true;
    }
    if (source === this.prevPage) {
      this.page = Math.max(0, this.page - 1);
      this.buildInterests();
      return true;
    }
    if (source === this.nextPage) {
      this.page = Math.min(this.page + 1, this.pages);
      this.buildInterests();
      return true;
    }
    return super.tsOnCommand(cmd, source);
  }
}
