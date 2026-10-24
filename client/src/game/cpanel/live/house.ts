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
 */

import type { HouseStats } from "../../cpstate.js";
import type { GameContext } from "../../context.js";
import type { FfnFont } from "../../res/ffn.js";
import { LANG_FRENCH } from "../../res/uires.js";
import { BTN_TOGGLE } from "../../ui/btn.js";
import { UI_FONT_COLOR } from "../../ui/syscolors.js";
import { Gfx, TSWin } from "../../ui/tswin.js";
import { CaptionBtn } from "./captionbtn.js";

/** cSimsApp language (+100); the client runs the French install. */
const UI_LANGUAGE = LANG_FRENCH;

const LIVE = "Live";
const STR_LABELS = 0x85;
const STR_POPUP = 0x87;
const STR_LOT_SIZES = 0x8a;

/** lbl_105BC55C / lbl_105BC564 / lbl_105BC578 (WinSubpanelHouse.cpp static init). */
const BTN_SIZE = [
  [61, 16], [61, 16], [61, 16], [61, 16], [61, 16],
  [80, 16], [80, 16], [80, 16], [80, 16],
] as const;
const BTN_POS = [
  [85, 7], [85, 25], [85, 43], [85, 61], [85, 79],
  [0, 18], [0, 38], [0, 58], [0, 78],
] as const;
const BAR_POS = [
  [157, 6], [157, 24], [157, 42], [157, 60], [157, 79],
] as const;
const TITLE_POS = { x: 5, y: 0 };

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
    // popup: cWinLivePopupClient(popupNames[0], popupDescs[0]) with the "house" help id.
    return super.init();
  }

  /** The panel repaints from CPState every frame. */
  updateViewFromCPState(): void {
    this.updateCaptions(this.ctx.state.houseStats);
  }

  /** cWinSubpanelHouse::TSOnCommand: one label at a time shows its popup. */
  override tsOnCommand(cmd: number, source: TSWin): boolean {
    const index = this.buttons.indexOf(source as CaptionBtn);
    if (index < 0) return super.tsOnCommand(cmd, source);
    // The second click on the open label closes its popup, which releases the label.
    const closing = (source as CaptionBtn).state === 0;
    this.buttons.forEach((b, i) => b.setState(i === index && !closing ? 1 : 0));
    // popup: EnablePopup / SetClient with popupNames[index], popupDescs[index].
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
