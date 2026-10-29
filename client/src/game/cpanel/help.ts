/**
 * cWinHelp: the help window the view control's "?" button opens
 * (cWinViewControl::TSOnCommand runs it with cSimsApp::DoSimsModalDialog while
 * the simulation is blocked, and keeps the selected topic in +0x1c0 for the
 * next time: SetSelected before, GetSelected after).
 *
 * From the decompiled class (WinHelp.cpp; the static initializer sets the
 * positions):
 *  - constructor(font): a cTSWinGenDlg; the font is entry 12 of the global
 *    font table (lbl_105BA2E8 + 0x30), the topic list's;
 *  - Init: the popup tiles (kCatalogPopupBackTiles); area (0, 0, 625, 300)
 *    moved to (50, 50); an OK button (cTSWinCtrlMgr::DefaultPushBtn,
 *    cTSWinMsgBox::GetButtonLabel(3)); a DefaultLabel "<unknown>" sized
 *    340 x 210 (10 px narrower in language 0x13) at (270, 20); a
 *    cTSWinTextList of 12 rows, 250 x 12 font heights at (20, 20), filled
 *    with the tiles' center pixel; UIText STR# 166 holds title / text
 *    pairs: the titles go in the list, which is then as wide as the widest
 *    title + 25; the first topic is selected; the text goes 20 px right of
 *    the list, as high as it; the window is 20 px wider than the text and
 *    two button heights taller than the list; the button is centered,
 *    half a button height below the list; the window is centered in the
 *    main window. Every child and the window have tWinFlag 0x2000;
 *  - TSPaint: the tiles as a frame (cTSBuffer::BltEdge, cells of a third
 *    of the bitmap, center filled);
 *  - TSOnCommand 0x15 (the list's selection n): the label shows the text of
 *    topic n (STR# entry 2n + 1), "???" when there is none, left aligned;
 *    the OK button (command 1) ends the dialog (0x10);
 *  - TSOnKeyDown: Return and Escape press the OK button;
 *  - TSBeginModal: the list gets the keyboard focus.
 */

import type { GameContext } from "../context.js";
import { LANG_FRENCH } from "../res/uires.js";
import { bltEdge, TSWinDlg } from "../ui/dlg.js";
import { TSWinCtrlMgr } from "../ui/ctrlmgr.js";
import { TSSystemButton } from "../ui/systembutton.js";
import { TSWinText, WTF_MULTILINE } from "../ui/text.js";
import { CMD_LIST_SELECT, TSWinTextList } from "../ui/textlist.js";
import { Gfx, WF_NO_FOCUS, type TSWin } from "../ui/tswin.js";
import { winMgr } from "../ui/winmgr.js";
import { rgb } from "../ui/syscolors.js";

/** UIText STR# 166 (LoadUIStrings(0xa6)): title / text pairs. */
const STR_HELP = 0xa6;
/** UIText STR# 152 entry 0: cTSWinMsgBox::GetButtonLabel(3) ("OK"). */
const LABELS_STR = 152;
/** lbl_105BC424: the label's text before a topic is shown, and the text of a missing topic. */
const UNKNOWN_TEXT = "<unknown>";
const MISSING_TEXT = "???";
/** lbl_105BA2E8 + 0x30: the list font. */
const LIST_FONT_SIZE = 12;
/** ___sinit__WinHelp_cpp */
const DLG_POS = { x: 0x32, y: 0x32 };
const DLG_SIZE = { w: 0x271, h: 300 };
const LIST_POS = { x: 0x14, y: 0x14 };
const LIST_W = 0xfa;
const TEXT_POS = { x: 0x10e, y: 0x14 };
const TEXT_SIZE = { w: 0x154, h: 0xd2 };
/** cTSWinTextList +0xe0: rows shown. */
const LIST_ROWS = 0xc;
/** The list's width beyond its widest title, and the gaps around the text. */
const LIST_EXTRA_W = 0x19;
const GAP = 0x14;
/** cSimsApp+100: the UI language; 0x13 narrows the text by 10 px. */
const LANGUAGE_NARROW_TEXT = 0x13;
/** The game runs in French (cSimsApp+100). */
const UI_LANGUAGE: number = LANG_FRENCH;

export class WinHelp extends TSWinDlg {
  /** +0x110 */
  private tiles: ImageBitmap | null = null;
  /** +0x100 / +0x104 / +0x108 */
  private list: TSWinTextList | null = null;
  private ok: TSSystemButton | null = null;
  private label: TSWinText | null = null;
  /** +0x114: STR# 166 */
  private topics: string[] = [];

  constructor(private readonly ctx: GameContext) {
    super();
  }

  /** cWinHelp::Init */
  override async init(): Promise<boolean> {
    const { ctx } = this;
    const mgr = await TSWinCtrlMgr.get(ctx);
    const tiles = await ctx.res.image("kCatalogPopupBackTiles");
    this.tiles = tiles;
    this.setArea(0, 0, DLG_SIZE.w, DLG_SIZE.h);
    this.moveTo(DLG_POS.x, DLG_POS.y);

    const ok = TSSystemButton.defaultPushBtn(mgr, 0, ctx.strings.get("UIText", LABELS_STR, 0));
    ok.setFlag(WF_NO_FOCUS, true);
    ok.moveTo(Math.trunc((this.getW() - ok.getW()) / 2), this.getH() - Math.trunc((ok.getH() * 3) / 2));
    this.childAdd(ok);
    this.ok = ok;

    // cTSWinCtrlMgr::DefaultLabel(0, "<unknown>")
    const label = new TSWinText();
    label.setCaption(UNKNOWN_TEXT);
    label.setFont(mgr.systemFont(0));
    label.setAlignment(1);
    label.setBackgroundOpaque(false);
    label.setWinTextFlag(WTF_MULTILINE, false);
    label.fitWindowToText();
    label.setArea(0, 0, TEXT_SIZE.w - (UI_LANGUAGE === LANGUAGE_NARROW_TEXT ? 10 : 0), TEXT_SIZE.h);
    label.moveTo(TEXT_POS.x, TEXT_POS.y);
    label.setFlag(WF_NO_FOCUS, true);
    this.childAdd(label);
    this.label = label;

    const font = await ctx.fonts.acquire(LIST_FONT_SIZE);
    const list = new TSWinTextList(ctx);
    list.setFont(font);
    list.visibleRows = LIST_ROWS;
    list.setArea(0, 0, LIST_W, font.height * LIST_ROWS);
    list.moveTo(LIST_POS.x, LIST_POS.y);
    // The list's fill color (+0x64): the pixel at the center of the tiles.
    list.fillColor = centerPixel(tiles);

    this.topics = ctx.strings.list("UIText", STR_HELP);
    let widest = 0;
    for (let i = 0; i < this.topics.length; i += 2) widest = Math.max(widest, font.stringWidth(this.topics[i]!));
    if (widest !== 0) list.setArea(list.area.left, list.area.top, widest + list.area.left + LIST_EXTRA_W, list.area.bottom);
    this.childAdd(list);
    await list.init();
    this.list = list;
    for (let i = 0; i < this.topics.length; i += 2) list.insert(list.size(), this.topics[i]!);
    if (this.topics.length !== 0) list.select(0);

    label.setArea(list.area.right + GAP, list.area.top, list.area.right + TEXT_SIZE.w + GAP, list.area.bottom);
    const okH = ok.getH();
    this.setArea(this.area.left, this.area.top, label.area.right + this.area.left + GAP, this.area.top + list.area.bottom + okH * 2);
    const okTop = list.area.bottom + Math.trunc(okH / 2);
    ok.moveTo(Math.trunc((this.getW() - ok.getW()) / 2), okTop);
    this.centerWindowInRect(winMgr.main.area);
    this.setFlag(WF_NO_FOCUS, true);
    return true;
  }

  /** cWinHelp::SetSelected */
  setSelected(index: number): void {
    this.list?.select(index);
  }

  /** cWinHelp::GetSelected */
  getSelected(): number {
    return this.list?.getSelection() ?? 0;
  }

  /** cWinHelp::TSBeginModal */
  override tsBeginModal(): void {
    const list = this.list;
    if (list && !list.getFlag(WF_NO_FOCUS)) winMgr.setFocus(list);
  }

  /** cWinHelp::TSPaint */
  override tsPaint(g: Gfx): void {
    const t = this.tiles;
    if (t) bltEdge(g, t, Math.trunc(t.width / 3), Math.trunc(t.height / 3), this.getW(), this.getH(), true);
  }

  /** cWinHelp::TSOnCommand */
  override tsOnCommand(cmd: number, source: TSWin): boolean {
    if (source === this.ok) {
      this.tsEndDialog(0);
      return true;
    }
    if (cmd === CMD_LIST_SELECT && source === this.list) {
      // GetString(2n + 2) (1-based): the text of topic n.
      const i = this.list.getSelection() * 2 + 1;
      const label = this.label;
      if (label) {
        if (i > 0 && i < this.topics.length) {
          label.setCaption(this.topics[i]!);
          label.setAlignment(0);
        } else label.setCaption(MISSING_TEXT);
      }
      return true;
    }
    return super.tsOnCommand(cmd, source);
  }

  /** cWinHelp::TSOnKeyDown: Return and Escape press OK. */
  override tsOnKeyDown(key: string): boolean {
    // The list has the focus (TSBeginModal): it sees the keys first; the window manager
    // gives them to the modal window, which hands them down.
    if (this.list && winMgr.getFocus() === this.list && this.list.tsOnKeyDown(key)) return true;
    if (key === "Enter" || key === "Escape") {
      if (this.ok) this.tsEndDialog(0);
      return true;
    }
    return super.tsOnKeyDown(key);
  }
}

/** The color at the center of a bitmap (cTSBuffer::GetColorSurfaceBits at (w / 2, h / 2)). */
function centerPixel(img: ImageBitmap): string {
  const c = new OffscreenCanvas(1, 1);
  const cx = c.getContext("2d")!;
  cx.drawImage(img, Math.trunc(img.width / 2), Math.trunc(img.height / 2), 1, 1, 0, 0, 1, 1);
  const [r, g, b] = cx.getImageData(0, 0, 1, 1).data;
  return rgb(r!, g!, b!);
}
