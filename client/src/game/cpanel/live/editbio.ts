/**
 * cWinEditBio: the biography editor a Ctrl+click on a family portrait of the
 * Live panel opens (cWinPeople::TSOnCommand runs it modally).
 *
 * From the decompiled class (WinEditBio.cpp):
 *  - Init: kCatalogPopupBackTiles (+0xd8, the frame) and
 *    kDialogEditBioDisplay (+0xd4, the text box); OK (id 3) and Cancel
 *    (id 1) system buttons (cTSWinCtrlMgr, cTSWinMsgBox::GetButtonLabel);
 *    the window is the box plus 16 px on each side, plus 16 px and the OK
 *    button's height under it; the box is drawn at (+0xe4, +0xe8) = (16, 16);
 *    a cTSWinTextEdit2 (+0xd0) over the box inset by 4 px, then shifted by
 *    (16 + 4, 16 + 4) as the code computes it, font table entry 10, text and
 *    caret color lbl_105BA928 (white), transparent, any number of lines,
 *    capacity 0x800, focusable, no frame on focus or when empty, holding
 *    PersonFinder::GetDescription; the buttons split the width in three
 *    equal gaps, their bottom 16 px above the window's; the window and the
 *    buttons are not focusable (flag 0x2000);
 *  - TSBeginModal: the edit takes the focus;
 *  - TSPaint: the frame (cells a third of the bitmap, center filled), the
 *    box;
 *  - TSOnCommand: OK writes the text with PersonFinder::SetDescription and
 *    ends the dialog; Cancel, Escape (TSOnKeyDown) and the edit's Escape
 *    (0x18) end it unchanged.
 *
 * PersonFinder::SetDescription stores the text as the character object's
 * catalog description (CatalogResource::Save into its CTSS): the character
 * file of the person, written with data/character.ts.
 */

import type { PersonInfo } from "../../cpstate.js";
import type { GameContext } from "../../context.js";
import { saveCharacterDescription } from "../../data/character.js";
import { getLiveNeighborhood } from "../../data/nbhdstore.js";
import { TSWinCtrlMgr } from "../../ui/ctrlmgr.js";
import { bltEdge } from "../../ui/dlg.js";
import { rgb } from "../../ui/syscolors.js";
import { TSSystemButton } from "../../ui/systembutton.js";
import { TE_ESCAPE, TSWinTextEdit2 } from "../../ui/textedit.js";
import { Gfx, TSWin, WF_NO_FOCUS } from "../../ui/tswin.js";
import { winMgr } from "../../ui/winmgr.js";

/** cTSWinMsgBox::GetButtonLabel: UIText STR# 152 entries 0 (OK, id 3) and 1 (Cancel, id 1). */
const LABELS_STR = 152;
const ID_OK = 3;
const ID_CANCEL = 1;
const MARGIN = 0x10;
/** +0xe4 / +0xe8: where the box is drawn. */
const BOX_POS = { x: 0x10, y: 0x10 };
const EDIT_INSET = 4;
const EDIT_FONT = 10;
const EDIT_CAPACITY = 0x800;
/** lbl_105BA928 (InitSimsColors): white. */
const TEXT_COLOR = rgb(0xff, 0xff, 0xff);

export class WinEditBio extends TSWin {
  private frame: ImageBitmap | null = null;
  private box: ImageBitmap | null = null;
  /** +0xd0 */
  private edit: TSWinTextEdit2 | null = null;
  /** +0xdc / +0xe0 */
  private okBtn: TSWin | null = null;
  private cancelBtn: TSWin | null = null;

  constructor(
    readonly ctx: GameContext,
    /** +0xcc: the person (PersonFinder index). */
    private readonly person: PersonInfo,
  ) {
    super();
  }

  /** cWinEditBio::Init */
  override async init(): Promise<boolean> {
    const { ctx } = this;
    const [mgr, frame, box, font] = await Promise.all([
      TSWinCtrlMgr.get(ctx),
      ctx.res.image("kCatalogPopupBackTiles"),
      ctx.res.image("kDialogEditBioDisplay"),
      ctx.fonts.acquire(EDIT_FONT),
    ]);
    this.frame = frame;
    this.box = box;
    const label = (entry: number): string => ctx.strings.get("UIText", LABELS_STR, entry);
    const ok = TSSystemButton.defaultPushBtn(mgr, ID_OK, label(0));
    const cancel = TSSystemButton.defaultPushBtn(mgr, ID_CANCEL, label(1));
    this.childAdd(ok);
    this.childAdd(cancel);
    this.okBtn = ok;
    this.cancelBtn = cancel;
    const w = box.width + 2 * MARGIN;
    const h = box.height + MARGIN + ok.getH() + 2 * MARGIN;
    this.setArea(0, 0, w, h);

    const edit = new TSWinTextEdit2();
    edit.setFont(font);
    edit.setTextColor(TEXT_COLOR);
    edit.setColors(rgb(0, 0, 0), TEXT_COLOR, TEXT_COLOR);
    edit.setLinesAllowed(-1);
    edit.setTransparent(true);
    // The box inset by 4 px, moved by (+0xe4 + 4, +0xe8 + 4).
    const dx = BOX_POS.x + EDIT_INSET;
    const dy = BOX_POS.y + EDIT_INSET;
    edit.setArea(EDIT_INSET + dx, EDIT_INSET + dy, box.width - EDIT_INSET + dx, box.height - EDIT_INSET + dy);
    edit.setFlashFrameOnEmpty(false);
    edit.setFlag(WF_NO_FOCUS, false);
    edit.setDrawFrameOnFocus(false);
    edit.setCapacity(EDIT_CAPACITY);
    this.childAdd(edit);
    edit.setText(this.person.bio ?? "");
    this.edit = edit;

    const gap = Math.trunc((w - ok.getW() - cancel.getW()) / 3);
    ok.moveTo(gap, h - MARGIN - ok.getH());
    cancel.moveTo(gap * 2 + ok.getW(), h - MARGIN - cancel.getH());
    this.setFlag(WF_NO_FOCUS, true);
    ok.setFlag(WF_NO_FOCUS, true);
    cancel.setFlag(WF_NO_FOCUS, true);
    return super.init();
  }

  /** cWinEditBio::TSBeginModal */
  override tsBeginModal(): void {
    if (this.edit) winMgr.setFocus(this.edit);
  }

  /** cWinEditBio::TSOnKeyDown: Escape is Cancel. */
  override tsOnKeyDown(key: string): boolean {
    if (key === "Escape") {
      winMgr.endDialog(this, 0);
      return true;
    }
    // cTSWin::TSOnKeyDown: the other keys reach the focused edit (WinMgr routes them to the modal window).
    if (this.edit && winMgr.getFocus() === this.edit && this.edit.tsOnKeyDown(key)) return true;
    return super.tsOnKeyDown(key);
  }

  /** cWinEditBio::TSOnCommand */
  override tsOnCommand(cmd: number, source: TSWin): boolean {
    if (source === this.okBtn) {
      const text = this.edit?.getText() ?? "";
      void setDescription(this.person, text);
      winMgr.endDialog(this, 0);
      return true;
    }
    if (source === this.cancelBtn || cmd === TE_ESCAPE) {
      winMgr.endDialog(this, 0);
      return true;
    }
    return super.tsOnCommand(cmd, source);
  }

  /** cWinEditBio::TSPaint */
  override tsPaint(g: Gfx): void {
    const frame = this.frame;
    if (frame) bltEdge(g, frame, Math.trunc(frame.width / 3), Math.trunc(frame.height / 3), this.getW(), this.getH(), true);
    if (this.box) g.blit(this.box, BOX_POS.x, BOX_POS.y);
  }
}

/**
 * PersonFinder::SetDescription: the character's catalog description
 * (CatalogResource::Save), kept in the PersonInfo the panels read.
 */
async function setDescription(p: PersonInfo, text: string): Promise<void> {
  p.bio = text;
  const live = getLiveNeighborhood();
  const nb = live?.data.neighbors.find((n) => (n.guid | 0) === ((p.guid ?? 0) | 0));
  if (!live || !nb) return;
  const file = nb.name.charAt(0).toUpperCase() + nb.name.slice(1) + ".iff";
  await saveCharacterDescription(live.data.dir, file, p.firstName, text);
}
