/**
 * cWinEditDTLotDesc — the town lot name / description editor that
 * cWinOptions::SaveDowntownDescription runs modally when a lot visited
 * without sims (simulator global 32, edit mode) is saved or left.
 *
 * cWinEditDTLotDesc(house, prompt):
 *  - the lot's name and description default to the literals at
 *    lbl_105BCB48 by house range (21..30 downtown, 40..48 vacation, 81..89
 *    Studio Town, 90..99 Magic Town, else a zoned neighborhood lot);
 *  - GetLotInfo replaces them with STR# 2000 + house entries 1 / 2 of
 *    <neighborhood>/Houses/DTDesc.iff (VIDesc, STDesc, MTDesc,
 *    NeighborhoodDesc) when the file and the set exist (StringSetMulti).
 *
 * Init:
 *  - kCatalogPopupBackTiles (edge tiles of the frame) and
 *    kDialogEditDTDescription (W x H, drawn at (0x10, 0x10));
 *  - without prompt one OK button (id 3, GetButtonLabel(3)) centered 0x10
 *    above the bottom; with prompt Yes (id 3, label 4) at (5, h - 5 - bh),
 *    Cancel (id 1) at the right edge - 5, No (id 2) centered;
 *  - the window is (W + 0x20) x (H + 0x10 + button height + 0x20);
 *  - name: cTSWinTextEdit2, font lbl_105BA2E8 + 0x28 (size 10), white
 *    (lbl_105BA928), one line, transparent, (0x18, 0x19)-(W + 0x10, 0x2d),
 *    capacity 0x31; description: same font, any number of lines,
 *    (0x18, 0x36)-(W + 0x10, H - 0xe), capacity 0xfe; Tab in the name goes
 *    to the description;
 *  - with prompt, the title UIText STR# 0x99 entry 5 ("Do you want to save
 *    the game?").
 *
 * TSPaint: the edge tiles over the whole window, the dialog image, and with
 * prompt the title in font (1, 12) centered, its bottom 9 + button height
 * above the window's bottom.
 *
 * TSOnCommand: OK / Yes -> SetLotInfo (StringSetMulti::SetString 1 / 2 and
 * Save into the same file) and end with 3; Cancel ends with 1, No with 2.
 */

import type { GameContext } from "../context.js";
import { writeGameFile } from "../data/files.js";
import { buildIff, parseIff, stringSetMultiSave } from "../data/iff.js";
import type { FfnFont } from "../res/ffn.js";
import { LANG_FRENCH } from "../res/uires.js";
import { bltEdge } from "../cpanel/buy/catalogpopup.js";
import { TSWinCtrlMgr } from "../ui/ctrlmgr.js";
import { IDCANCEL, IDNO, IDOK, IDYES, TSWinMsgBox } from "../ui/msgbox.js";
import { TSSystemButton } from "../ui/systembutton.js";
import { TE_TAB, TSWinTextEdit2 } from "../ui/textedit.js";
import { Gfx, TSWin, WF_NO_FOCUS } from "../ui/tswin.js";
import { winMgr } from "../ui/winmgr.js";
import { loadStrSet, Zone } from "./nghinterface.js";

/** lbl_105BA928 (InitSimsColors): white. */
const WHITE = "#ffffff";
/** cTSFont's default color. */
const TITLE_COLOR = "#ffffff";
/** UIText STR# 0x99 (cSimsApp dialogs), entry 5: the save question. */
const STR_APP_DIALOGS = 0x99;
const PROMPT_ENTRY = 5;
const NAME_CAPACITY = 0x31;
const DESC_CAPACITY = 0xfe;
/** +0xf0 / +0xf4: the dialog image's offset. */
const IMAGE_X = 0x10;
const IMAGE_Y = 0x10;
/** First STR# id of the lot descriptions (StringSetMulti::Load(2000 + house)). */
const DESC_SET_BASE = 2000;

/** The lot's description file and default texts (lbl_105BCB48). */
function lotKind(house: number, zoned: boolean): { file: string; name: string; desc: string } | null {
  if (house >= 0x15 && house <= 0x1e) return { file: "Houses/DTDesc.iff", name: "A Downtown Lot", desc: "A nice place to visit in beautiful SimCity." };
  if (house >= 0x28 && house <= 0x30) return { file: "Houses/VIDesc.iff", name: "A Vacation Lot", desc: "A nice place to visit for a great time." };
  if (house >= 0x51 && house <= 0x59) return { file: "Houses/STDesc.iff", name: "A Studiotown Lot", desc: "A nice place to visit for a great time." };
  if (house >= 0x5a && house <= 99) return { file: "Houses/MTDesc.iff", name: "A Magicland Lot", desc: "A magic place to visit for a great time." };
  if (zoned) return { file: "Houses/NeighborhoodDesc.iff", name: "A Neighborhood Lot", desc: "" };
  return null;
}

export class WinEditDTLotDesc extends TSWin {
  /** +0xcc: the prompt's title. */
  private title = "";
  /** +0xd4 / +0xd8 */
  private descEdit: TSWinTextEdit2 | null = null;
  private nameEdit: TSWinTextEdit2 | null = null;
  /** +0xdc / +0xe0 */
  private image: ImageBitmap | null = null;
  private tiles: ImageBitmap | null = null;
  /** +0xe4 (OK / Yes), +0xe8 (No), +0xec (Cancel) */
  private okBtn: TSSystemButton | null = null;
  private noBtn: TSSystemButton | null = null;
  private cancelBtn: TSSystemButton | null = null;
  private titleFont: FfnFont | null = null;
  /** The edge tiles blitted over the window's size (TSPaint's BltEdge, cached). */
  private frame: OffscreenCanvas | null = null;
  /** +0xf8 / +0xfc */
  private lotName = "";
  private lotDesc = "";
  private readonly kind: { file: string; name: string; desc: string } | null;

  /**
   * cWinEditDTLotDesc(house, prompt). `nbhdDir` and `zoning` stand for
   * Neighborhood::GetDirectory / GetZoningType of the current neighborhood.
   */
  constructor(
    private readonly ctx: GameContext,
    private readonly nbhdDir: string,
    /** +0x100 */
    private readonly house: number,
    /** +0xd0 */
    private readonly prompt: boolean,
    zoning: Zone,
  ) {
    super();
    this.kind = lotKind(house, zoning !== Zone.None);
    this.lotName = this.kind?.name ?? "";
    this.lotDesc = this.kind?.desc ?? "";
  }

  private get path(): string | null {
    return this.kind ? `${this.nbhdDir}/${this.kind.file}` : null;
  }

  /** cWinEditDTLotDesc::GetLotInfo */
  private async getLotInfo(): Promise<void> {
    const path = this.path;
    if (!path) return;
    const set = await loadStrSet(path, DESC_SET_BASE + this.house, LANG_FRENCH);
    if (!set) return;
    if (set[0] !== undefined) this.lotName = set[0];
    if (set[1] !== undefined) this.lotDesc = set[1];
  }

  /** cWinEditDTLotDesc::SetLotInfo: StringSetMulti::SetString(1 / 2) then Save (the file must exist). */
  private async setLotInfo(): Promise<void> {
    this.lotName = this.nameEdit?.getText() ?? this.lotName;
    this.lotDesc = this.descEdit?.getText() ?? this.lotDesc;
    const path = this.path;
    if (!path) return;
    const res = await fetch(`/assets/Sims/${path}`, { cache: "no-store" });
    if (!res.ok) return;
    const chunks = parseIff(new Uint8Array(await res.arrayBuffer()));
    const id = DESC_SET_BASE + this.house;
    let c = chunks.find((x) => x.type === "STR#" && x.id === id);
    if (!c) {
      c = { type: "STR#", id, flags: 0, label: "", data: new Uint8Array(0) };
      chunks.push(c);
    }
    c.data = stringSetMultiSave(c.data.length ? c.data : null, LANG_FRENCH, [this.lotName, this.lotDesc]);
    await writeGameFile(path, buildIff(chunks));
  }

  /** cWinEditDTLotDesc::Init */
  override async init(): Promise<boolean> {
    const ctx = this.ctx;
    const mgr = await TSWinCtrlMgr.get(ctx);
    [this.tiles, this.image, this.titleFont] = await Promise.all([
      ctx.res.image("kCatalogPopupBackTiles"),
      ctx.res.image("kDialogEditDTDescription"),
      ctx.fonts.acquire(12),
    ]);
    const img = this.image;
    if (!img) return true;
    const label = (id: number): string => TSWinMsgBox.getButtonLabel(ctx, id);
    const ok = TSSystemButton.defaultPushBtn(mgr, IDOK, label(this.prompt ? IDYES : IDOK));
    this.okBtn = ok;
    this.childAdd(ok);
    if (this.prompt) {
      this.cancelBtn = TSSystemButton.defaultPushBtn(mgr, IDCANCEL, label(IDCANCEL));
      this.childAdd(this.cancelBtn);
      this.noBtn = TSSystemButton.defaultPushBtn(mgr, IDNO, label(IDNO));
      this.childAdd(this.noBtn);
    }
    const w = img.width + 0x20;
    const h = img.height + 0x10 + ok.getH() + 0x20;
    this.setArea(0, 0, w, h);
    if (this.tiles) {
      this.frame = new OffscreenCanvas(w, h);
      bltEdge(this.frame.getContext("2d") as unknown as CanvasRenderingContext2D, this.tiles, w, h);
    }

    await this.getLotInfo();
    const font = mgr.tableFont(10);
    const edit = (lines: number, capacity: number, top: number, bottom: number, text: string): TSWinTextEdit2 => {
      const e = new TSWinTextEdit2();
      e.setFont(font);
      e.setTextColor(WHITE);
      e.setColors("#000000", WHITE, WHITE);
      e.setLinesAllowed(lines);
      e.setTransparent(true);
      e.setArea(4 + IMAGE_X + 4, top, img.width - 4 + IMAGE_X + 4, bottom);
      e.setFlashFrameOnEmpty(false);
      e.setDrawFrameOnFocus(false);
      e.setCapacity(capacity);
      this.childAdd(e);
      e.setText(text);
      return e;
    };
    this.nameEdit = edit(1, NAME_CAPACITY, 0x19, 0x2d, this.lotName);
    this.descEdit = edit(-1, DESC_CAPACITY, IMAGE_Y + 4 + 0x22, img.height + IMAGE_Y + 4 - 0x22, this.lotDesc);
    if (this.prompt) this.title = ctx.strings.get("UIText", STR_APP_DIALOGS, PROMPT_ENTRY - 1);

    const place = (b: TSWin, x: number, y: number): void => b.setArea(x, y, x + b.getW(), y + b.getH());
    if (!this.prompt) {
      place(ok, Math.trunc((w - ok.getW()) / 2), h - 0x10 - ok.getH());
    } else {
      place(ok, 5, h - 5 - ok.getH());
      const cancel = this.cancelBtn!;
      place(cancel, w - 5 - cancel.getW(), h - 5 - cancel.getH());
      const no = this.noBtn!;
      place(no, Math.trunc((w - no.getW()) / 2), h - 5 - cancel.getH());
    }
    // SetFlag(0x2000): the dialog and its buttons never take the focus (the edits do).
    this.setFlag(WF_NO_FOCUS, true);
    for (const b of [this.okBtn, this.cancelBtn, this.noBtn]) b?.setFlag(WF_NO_FOCUS, true);
    return true;
  }

  /** cWinEditDTLotDesc::TSBeginModal: the description edit takes the focus. */
  override tsBeginModal(): void {
    if (this.descEdit && !this.descEdit.getFlag(WF_NO_FOCUS)) winMgr.setFocus(this.descEdit);
  }

  /** cWinEditDTLotDesc::TSOnKeyDown -> cTSWin::TSOnKeyDown: keys go to the focused edit. */
  override tsOnKeyDown(key: string): boolean {
    const focus = winMgr.getFocus();
    if (focus && (focus === this.nameEdit || focus === this.descEdit)) return focus.tsOnKeyDown(key);
    return true;
  }

  /** cWinEditDTLotDesc::TSOnCommand */
  override tsOnCommand(cmd: number, source: TSWin): boolean {
    if (cmd === TE_TAB) {
      // The name edit's next window (+8) is the description.
      if (source === this.nameEdit && this.descEdit) winMgr.setFocus(this.descEdit);
      return true;
    }
    if (source === this.okBtn) {
      void this.setLotInfo().finally(() => winMgr.endDialog(this, IDOK));
    } else if (source === this.cancelBtn) {
      winMgr.endDialog(this, IDCANCEL);
    } else if (source === this.noBtn) {
      winMgr.endDialog(this, IDNO);
    }
    return true;
  }

  /** cWinEditDTLotDesc::TSPaint */
  override tsPaint(g: Gfx): void {
    const w = this.getW();
    const h = this.getH();
    if (this.frame) g.blit(this.frame, 0, 0);
    if (this.image) g.blit(this.image, IMAGE_X, IMAGE_Y);
    const font = this.titleFont;
    if (this.prompt && font && this.title && this.okBtn) {
      const tw = font.stringWidth(this.title);
      const x = Math.trunc(w / 2) - Math.trunc(tw / 2);
      const y = h - 9 - this.okBtn.getH() - font.height;
      font.drawText(g.ctx, this.title, g.ox + x, g.oy + y, TITLE_COLOR);
    }
  }
}

/**
 * cWinOptions::SaveDowntownDescription(prompt): on a lot visited without
 * sims (global 32 = 1) the editor runs modally, centered, the simulator
 * blocked. Returns 1 (save the game: OK / Yes), 0 (No), -1 (Cancel), or -2
 * when the lot is not visited that way (the caller saves as usual).
 */
export async function saveDowntownDescription(
  ctx: GameContext,
  opts: { visiting: boolean; house: number; nbhdDir: string; zoning: Zone },
  prompt: boolean,
): Promise<number> {
  if (!opts.visiting) return -2;
  const win = new WinEditDTLotDesc(ctx, opts.nbhdDir, opts.house, prompt, opts.zoning);
  if (!(await win.init())) return -2;
  const main = winMgr.main;
  const x = Math.trunc((main.getW() - win.getW()) / 2);
  const y = Math.trunc((main.getH() - win.getH()) / 2);
  win.setArea(x, y, x + win.getW(), y + win.getH());
  ctx.hooks?.setBlockSimulator?.(true);
  const r = await winMgr.doModalWin(win);
  ctx.hooks?.setBlockSimulator?.(false);
  if (r === IDOK) return 1;
  return r === IDCANCEL ? -1 : 0;
}
