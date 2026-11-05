/**
 * Control manager (cTSWinCtrlMgr): the system bitmaps, system fonts and
 * default controls shared by generic widgets.
 *
 * cSimsApp registers the bitmaps at boot (SetSystemBMP):
 *   0 kSMSystemBtn   1 kSMSystemCheck   2 kSMSystemSliderH   3 kSMSystemSliderV
 *   4 kSMSystemScrollbar   5 kCatalogPopupBackTiles   9 kSMSystemGenDlgEdge
 *   0xb kSMSystemComboDown   0xd kSMSystemListLineItemBackground
 *   0xe kSMSystemListBackground   0xf kSMSystemPieButton   0x10 kSMSystemPieBackground
 * and the fonts (SetSystemFont): 0 = the size 11 table font, 1 = size 12 with
 * the drop shadow flag (InitSimsColors' font table, every font colored
 * UI_FONT_COLOR).
 */

import type { GameContext } from "../context.js";
import { FONT_SHADOW, type FfnFont } from "../res/ffn.js";

export const SYS_BTN = 0;
export const SYS_CHECK = 1;
export const SYS_SLIDER_H = 2;
export const SYS_SLIDER_V = 3;
export const SYS_SCROLLBAR = 4;
export const SYS_POPUP_TILES = 5;
export const SYS_GENDLG_EDGE = 9;
export const SYS_COMBO_DOWN = 0xb;
export const SYS_LIST_LINE_BKG = 0xd;
export const SYS_LIST_BKG = 0xe;
export const SYS_PIE_BUTTON = 0xf;
export const SYS_PIE_BKG = 0x10;

const SYSTEM_BMPS: [number, string][] = [
  [SYS_BTN, "kSMSystemBtn"],
  [SYS_CHECK, "kSMSystemCheck"],
  [SYS_SLIDER_H, "kSMSystemSliderH"],
  [SYS_SLIDER_V, "kSMSystemSliderV"],
  [SYS_SCROLLBAR, "kSMSystemScrollbar"],
  [SYS_POPUP_TILES, "kCatalogPopupBackTiles"],
  [SYS_GENDLG_EDGE, "kSMSystemGenDlgEdge"],
  [SYS_COMBO_DOWN, "kSMSystemComboDown"],
  [SYS_LIST_LINE_BKG, "kSMSystemListLineItemBackground"],
  [SYS_LIST_BKG, "kSMSystemListBackground"],
  [SYS_PIE_BUTTON, "kSMSystemPieButton"],
  [SYS_PIE_BKG, "kSMSystemPieBackground"],
];

/** Sizes of the global font table the widgets index directly (cTSSystemButton uses 8..12). */
const TABLE_SIZES = [7, 8, 9, 10, 11, 12];

const instances = new WeakMap<GameContext, Promise<TSWinCtrlMgr>>();

export class TSWinCtrlMgr {
  private readonly bmps = new Map<number, ImageBitmap>();
  private readonly fonts = new Map<number, FfnFont>();
  private readonly table = new Map<number, FfnFont>();

  /** The last loaded control manager, for windows built without a context (cTSFrameWork_CtrlMgr()). */
  static current: TSWinCtrlMgr | null = null;

  private constructor() {}

  /** The context's control manager, loaded once (cTSFrameWork_CtrlMgr()). */
  static get(ctx: GameContext): Promise<TSWinCtrlMgr> {
    let p = instances.get(ctx);
    if (!p) {
      p = TSWinCtrlMgr.load(ctx);
      instances.set(ctx, p);
    }
    return p;
  }

  private static async load(ctx: GameContext): Promise<TSWinCtrlMgr> {
    const m = new TSWinCtrlMgr();
    await Promise.all([
      ...SYSTEM_BMPS.map(async ([slot, name]) => {
        m.bmps.set(slot, await ctx.res.image(name));
      }),
      ...TABLE_SIZES.map(async (size) => {
        m.table.set(size, await ctx.fonts.acquire(size));
      }),
    ]);
    m.fonts.set(0, m.table.get(11)!);
    m.fonts.set(1, m.table.get(12)!.withFlags(FONT_SHADOW));
    TSWinCtrlMgr.current = m;
    return m;
  }

  /** cTSWinCtrlMgr::SystemFont */
  systemFont(i: 0 | 1): FfnFont {
    return this.fonts.get(i)!;
  }

  /** cTSWinCtrlMgr::SystemBMP */
  systemBMP(slot: number): ImageBitmap {
    const b = this.bmps.get(slot);
    if (!b) throw new Error(`no system bitmap ${slot}`);
    return b;
  }

  /** Entry `size` of the global font table (lbl_105BA2E8), sizes 7..12. */
  tableFont(size: number): FfnFont {
    return this.table.get(Math.min(12, Math.max(7, size)))!;
  }
}
