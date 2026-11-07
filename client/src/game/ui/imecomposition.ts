/**
 * cTSWinIMEComposition: the window showing the text being composed with an
 * input method (Windows build only; the Mac build has no IME code).
 *
 * The game's startup (Windows FUN_0050xxxx, the end of cSimsApp's window
 * setup) creates it for the Japanese, Chinese and Korean games only (language
 * 0xf, 0x11, 0x12, 0x14): font = the control manager's system font 0, area
 * (0x14, 0x14, 0x1a4, char height + 0x1a), margins (4, 4), hidden, a child of
 * the main window. The window procedure (FUN_005f1654) shows it on
 * WM_IME_STARTCOMPOSITION (FUN_005f0f07: size 200 x char height + 2 * 4,
 * shown, to the front), reads the composition string and its attributes on
 * WM_IME_COMPOSITION (GCS_COMPSTR, GCS_COMPATTR; FUN_005f0f59) and repaints,
 * hides it on WM_IME_ENDCOMPOSITION, and posts the result string's bytes as
 * WM_CHAR (GCS_RESULTSTR), which cTSWinTextEdit2::TSOnCharacter collects.
 *
 * TSPaint: the window filled black, the inside (margins off) (0xa6, 0xb4,
 * 0xb4); the string drawn from the inside's top-left without the font's flags
 * (no shadow), cut in runs of equal attribute, a run whose attribute has bit
 * 0 set (the target clause) on white.
 *
 * The browser hands the composition string (compositionupdate) but not its
 * attributes, so every run is drawn as attribute 0. The candidate list
 * (cTSWinIMECandidate, at (0x14, char height + 0x1e)) is the browser's own
 * window: the hidden input it follows sits at that point (ui/winmgr.ts).
 */

import type { GameContext } from "../context.js";
import type { FfnFont } from "../res/ffn.js";
import { UI_LANGUAGE } from "../res/uires.js";
import { TSWinCtrlMgr } from "./ctrlmgr.js";
import { rgb, UI_FONT_COLOR } from "./syscolors.js";
import { Gfx, TSWin, WF_NO_FOCUS } from "./tswin.js";
import type { WinMgr } from "./winmgr.js";

/** The languages whose games create the IME windows. */
export function hasImeWindows(lang = UI_LANGUAGE): boolean {
  return lang === 0x0f || lang === 0x11 || lang === 0x12 || lang === 0x14;
}

const MARGIN = 4;
const LEFT = 0x14;
const TOP = 0x14;
/** FUN_005f0f07: the width while composing. */
const SHOWN_W = 200;
const FRAME = rgb(0, 0, 0);
const BACK = rgb(0xa6, 0xb4, 0xb4);

export class TSWinIMEComposition extends TSWin {
  private text = "";

  constructor(private readonly font: FfnFont) {
    super();
    this.setFlag(WF_NO_FOCUS, true);
  }

  override async init(): Promise<boolean> {
    this.setArea(LEFT, TOP, 0x1a4, this.font.height + 0x1a);
    this.hideWindow();
    return true;
  }

  /** WM_IME_STARTCOMPOSITION */
  startComposition(): void {
    this.text = "";
    this.setSize(SHOWN_W, this.font.height + MARGIN * 2);
    this.showWindow();
    this.parent?.childToFront(this);
  }

  /** WM_IME_COMPOSITION (GCS_COMPSTR) */
  setComposition(text: string): void {
    this.text = text;
  }

  /** WM_IME_ENDCOMPOSITION */
  endComposition(): void {
    this.text = "";
    this.hideWindow();
  }

  override tsPaint(g: Gfx): void {
    const w = this.getW();
    const h = this.getH();
    g.fill(0, 0, w, h, FRAME);
    g.fill(MARGIN, MARGIN, w - MARGIN * 2, h - MARGIN * 2, BACK);
    if (!this.text) return;
    const ctx = g.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(g.ox, g.oy, w, h);
    ctx.clip();
    this.font.drawText(ctx, this.text, g.ox + MARGIN, g.oy + MARGIN, UI_FONT_COLOR);
    ctx.restore();
  }
}

/** The startup's part: creates the composition window and hands it to the window manager. */
export async function installImeComposition(ctx: GameContext, mgr: WinMgr): Promise<void> {
  if (!hasImeWindows()) return;
  const ctrl = await TSWinCtrlMgr.get(ctx);
  const win = new TSWinIMEComposition(ctrl.systemFont(0));
  await win.init();
  mgr.main.childAdd(win);
  mgr.setImeListener({
    start: () => win.startComposition(),
    update: (text) => win.setComposition(text),
    end: () => win.endComposition(),
    candidatePoint: () => ({ x: LEFT, y: ctrl.systemFont(0).height + 0x1e }),
  });
}
