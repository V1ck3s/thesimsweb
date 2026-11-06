/**
 * House subpanel of the Live panel (cWinSubpanelHouse): five score bars (size,
 * furnishings, yard, upkeep, layout) with their labels, and the area, bedroom,
 * bathroom and lot size lines, all from the house statistics.
 *
 * Layout from the decompiled code (single-byte UI):
 *  - labels and lines are cTSWinBtn captions (STR# 133 "HouseSubpanelLabels"
 *    of Live.iff, entry 0 is the title); sizes and positions from
 *    WinSubpanelHouse.cpp static init; the French UI widens them by 12 px and
 *    moves them 6 px left (cWinSubpanelHouse::Init, language 3);
 *  - the five labels are then shrunk to their text and right-aligned 3 px
 *    left of their bar;
 *  - bars at (157, 6/24/42/60/79): kHouseSubBarsOff, then kHouseSubpanelBars
 *    clipped to 4 px per 10 points (cWinSubpanelHouse::TSPaint);
 *  - title in the 11 pt font at (5, 0) (cWinPeople::DrawSubpanelTitle).
 *
 * A double-byte UI (CPState::IsDoubleByteUI) copies its tables over these
 * (Init): positions lbl_105BC568 in Traditional Chinese (0x12), lbl_105BC558
 * in Japanese (0x0f), lbl_105BC554 in Thai (0x13), else lbl_105BC54C; sizes
 * lbl_105BC550 in Thai, else lbl_105BC560; bars lbl_105BC548. The title is
 * drawn at (0xd, 8) (TSPaint).
 */

import type { HouseStats } from "../../cpstate.js";
import type { GameContext } from "../../context.js";
import type { FfnFont } from "../../res/ffn.js";
import { DOUBLE_BYTE_UI, LANG_FRENCH, UI_LANGUAGE } from "../../res/uires.js";
import { getOptionsMgr } from "../../optionsmgr.js";
import { ASYNC_ON_ENTER, BTN_TOGGLE, CMD_ASYNC_EXIT } from "../../ui/btn.js";
import { UI_FONT_COLOR } from "../../ui/syscolors.js";
import { Gfx, TSWin } from "../../ui/tswin.js";
import { CaptionBtn } from "./captionbtn.js";
import { popupClick, type WinLivePopup, WinLivePopupClient } from "../livepopup.js";


const LIVE = "Live";
const STR_LABELS = 0x85;
const STR_POPUP = 0x87;
const STR_LOT_SIZES = 0x8a;

type Pt = readonly [number, number];
/** Five label points at x 85, then four line points at x `lineX`. */
function table(labelYs: number[], lineX: number, lineYs: number[]): Pt[] {
  return [...labelYs.map((y): Pt => [85, y]), ...lineYs.map((y): Pt => [lineX, y])];
}
const LANG_JAPANESE = 0x0f;
const LANG_TRADITIONAL_CHINESE = 0x12;
const LANG_THAI = 0x13;
/** lbl_105BC55C / lbl_105BC564 / lbl_105BC578 (WinSubpanelHouse.cpp static init), double-byte tables above. */
const BTN_SIZE: readonly Pt[] = !DOUBLE_BYTE_UI
  ? [[61, 16], [61, 16], [61, 16], [61, 16], [61, 16], [80, 16], [80, 16], [80, 16], [80, 16]]
  : UI_LANGUAGE === LANG_THAI
    ? [[62, 20], [62, 20], [62, 20], [62, 20], [62, 20], [70, 20], [70, 20], [70, 20], [70, 20]]
    : [[62, 20], [62, 20], [62, 20], [62, 20], [62, 20], [80, 20], [80, 20], [80, 20], [80, 20]];
const BTN_POS: readonly Pt[] = !DOUBLE_BYTE_UI
  ? table([7, 25, 43, 61, 79], 0, [18, 38, 58, 78])
  : UI_LANGUAGE === LANG_TRADITIONAL_CHINESE
    ? table([0x10, 0x29, 0x42, 0x5b, 0x74], 0x1c, [0x22, 0x3b, 0x54, 0x6d])
    : UI_LANGUAGE === LANG_JAPANESE
      ? table([0x12, 0x2b, 0x44, 0x5d, 0x76], 0xe, [0x24, 0x3d, 0x56, 0x6f])
      : UI_LANGUAGE === LANG_THAI
        ? table([0xb, 0x24, 0x3d, 0x56, 0x6f], 0, [0x22, 0x3b, 0x54, 0x6d])
        : table([0x10, 0x29, 0x42, 0x5b, 0x74], 0xe, [0x22, 0x3b, 0x54, 0x6d]);
const BAR_POS: readonly Pt[] = (DOUBLE_BYTE_UI ? [0x11, 0x2a, 0x43, 0x5c, 0x75] : [6, 24, 42, 60, 79]).map((y): Pt => [157, y]);
const TITLE_POS = DOUBLE_BYTE_UI ? { x: 0xd, y: 8 } : { x: 5, y: 0 };

/** HouseStats::GetSquareFeet is converted when the language is metric (float 0x3DBE5DF3). */
const SQUARE_METERS_PER_FOOT = 0.09295263141393661;
const UNKNOWN = "**Unknown**";

export class WinSubpanelHouse extends TSWin {
  private bars: ImageBitmap | null = null;
  private barsOff: ImageBitmap | null = null;
  private titleFont: FfnFont | null = null;
  private title = "";
  private readonly buttons: CaptionBtn[] = [];
  /** Format strings of the four info lines (+0x114..+0x120). */
  private readonly formats: string[] = [];
  /** cWinPeople+0x150: the Live panel's popup (set by WinPeople); +0x10c this page's client. */
  livePopup: WinLivePopup | null = null;
  private readonly client = new WinLivePopupClient();
  /** Popup texts (+0xe8 names, +0xf4 descriptions) for the hover popups. */
  private readonly popupNames: string[] = [];
  private readonly popupDescs: string[] = [];
  private readonly lotSizes: string[] = [];

  constructor(readonly ctx: GameContext) {
    super();
  }

  /** cWinSubpanelHouse::Init */
  override async init(): Promise<boolean> {
    const { ctx } = this;
    [this.bars, this.barsOff, this.titleFont] = await Promise.all([
      ctx.res.image("kHouseSubpanelBars"),
      ctx.res.image("kHouseSubBarsOff"),
      ctx.fonts.acquire(11),
    ]);
    const [font8, font7] = await Promise.all([ctx.fonts.acquire(8), ctx.fonts.acquire(7)]);
    this.setArea(0, 0, 0x1ab, 100);

    const labels = ctx.strings.list(LIVE, STR_LABELS);
    if (!labels.length) return super.init();
    this.title = labels[0]!;
    const french = UI_LANGUAGE === LANG_FRENCH;
    for (let i = 0; i + 1 < labels.length && i < BTN_SIZE.length; i++) {
      const btn = new CaptionBtn();
      if (i < 5) {
        btn.caption = labels[i + 1]!;
      } else {
        this.formats.push(labels[i + 1]!);
        btn.paraText = false;
      }
      const [w, h] = BTN_SIZE[i]!;
      const [x, y] = BTN_POS[i]!;
      if (french) btn.setArea(x - 6, y, x - 6 + w + 0xc, y + h);
      else btn.setArea(x, y, x + w, y + h);
      btn.mode = BTN_TOGGLE;
      btn.textAlignment = 2;
      btn.setImageKeepArea(null, 4, 0);
      btn.font = i === 8 && french ? font7 : font8;
      this.childAdd(btn);
      this.buttons.push(btn);
    }
    for (let i = 0; i < 5 && i < this.buttons.length; i++) {
      const btn = this.buttons[i]!;
      const w = btn.font!.stringWidth(btn.caption);
      const h = btn.font!.height;
      const left = BAR_POS[i]![0] - w - 3;
      btn.setArea(left, btn.area.top, left + w, btn.area.top + h);
    }
    const popup = ctx.strings.list(LIVE, STR_POPUP);
    for (let i = 0; i + 1 < popup.length; i += 2) {
      this.popupNames.push(popup[i]!);
      this.popupDescs.push(popup[i + 1]!);
    }
    this.lotSizes.push(...ctx.strings.list(LIVE, STR_LOT_SIZES));
    this.client.setName(this.popupNames[0] ?? "");
    this.client.setDesc(this.popupDescs[0] ?? "");
    return super.init();
  }

  /** The panel repaints from CPState every frame. */
  updateViewFromCPState(): void {
    this.updateCaptions(this.ctx.state.houseStats);
  }

  /** cWinSubpanelHouse::SetQuickTips: every label opens its popup on hover. */
  setQuickTips(on: boolean): void {
    const timeout = getOptionsMgr().getDefaultAsyncTimeout();
    for (const b of this.buttons) b.setAsync(on ? ASYNC_ON_ENTER : 0, timeout);
  }

  /**
   * cWinSubpanelHouse::TSOnCommand: one label at a time shows its popup
   * (0x13, the async timeout, is a click). The second click on the open
   * label closes it, which releases the label.
   */
  override tsOnCommand(cmd: number, source: TSWin): boolean {
    if (cmd === CMD_ASYNC_EXIT) return true;
    const index = this.buttons.indexOf(source as CaptionBtn);
    if (index < 0) return super.tsOnCommand(cmd, source);
    this.buttons.forEach((b, i) => b.setState(i === index ? 1 : 0));
    if (this.livePopup) {
      popupClick(this.livePopup, this.client, this, this.buttons[index]!, () => {
        this.client.setName(this.popupNames[index] ?? "");
        this.client.setDesc(this.popupDescs[index] ?? "");
      });
    }
    return true;
  }

  /** The four info lines (cWinSubpanelHouse::TSPaint, items 5..8). */
  private updateCaptions(stats: HouseStats): void {
    const lines = [
      format(this.formats[0], Math.trunc(0.5 + SQUARE_METERS_PER_FOOT * stats.squareFeet)),
      format(this.formats[1], stats.numBedrooms),
      format(this.formats[2], stats.numBathrooms),
      stats.lotSize >= 0 && stats.lotSize <= 2
        ? format(this.formats[3], this.lotSizes[stats.lotSize] ?? "")
        : UNKNOWN,
    ];
    lines.forEach((text, i) => {
      const btn = this.buttons[5 + i];
      if (btn) btn.caption = text;
    });
  }

  /** cWinSubpanelHouse::TSPaint */
  override tsPaint(g: Gfx): void {
    const stats = this.ctx.state.houseStats;
    const scores = [stats.sizeScore, stats.furnishingsScore, stats.yardScore, stats.upkeepScore, stats.layoutScore];
    if (this.bars && this.barsOff) {
      scores.forEach((score, i) => {
        const [x, y] = BAR_POS[i]!;
        const n = Math.trunc(Math.min(100, Math.max(0, score)) / 10);
        g.blit(this.barsOff!, x, y);
        if (n > 0) g.blitPart(this.bars!, 0, 0, Math.min(n * 4, this.bars!.width), this.bars!.height, x, y);
      });
    }
    this.updateCaptions(stats);
    // cWinPeople::PaintRect restores the background under the title; the whole panel repaints here.
    this.titleFont?.drawText(g.ctx, this.title, g.ox + TITLE_POS.x, g.oy + TITLE_POS.y, UI_FONT_COLOR);
  }
}

/** wsprintf with the one %d / %s the house strings use. */
function format(fmt: string | undefined, value: number | string): string {
  return (fmt ?? "").replace(/%[ds]/, String(value));
}
