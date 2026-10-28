/**
 * The 3D person pickers ObjectModule::PostSim runs for the Dialog
 * primitive: cWinClothingChoiceDlg (kind 6: clothing racks "Buy" / "Try
 * On", dressers "Change Normal Outfit"), cWinTransformMeDlg (kind 0xe:
 * charms "Transform") and cWinPetSelectDlg (kind 9: the pet pen "Buy a
 * Pet"). Each shows a cWinVitaBtnSolo between a previous and a next
 * button, a title and OK / Cancel.
 *
 * From the decompiled classes (the three Init are the same code but for
 * the strings, the person preview and the pet layout):
 *  - UIText STR# 0xdc (clothing), 0x111 (transform), 0xdd (pets): 1 next
 *    tooltip, 2 previous tooltip, 3 (unused), 4 Cancel caption, 5 title;
 *  - the title: a cTSWinText in font lbl_105BA2E8 + 0x40 (size 16), as
 *    wide as its text + 5, centered, 9 px from the top; OK (DefaultPushBtn,
 *    cTSWinMsgBox::GetButtonLabel(IDOK)) and Cancel, one-shot, 9 px above
 *    the bottom, splitting the width in thirds; the window widens (centered
 *    on the main window) when the title or the buttons + 15 do not fit;
 *  - the previous / next buttons: kClothingDialogPrevious (300) /
 *    kClothingDialogNext (0x12d), 4 frames; clothing / transform: the
 *    200 x 300 preview centered between 9 px margins and between the title
 *    + 0x12 and the buttons - 0x12, the arrows just outside it, vertically
 *    centered; pets: the arrows at 9 px from the sides, centered between
 *    the title + 0x12 and the buttons - 0x24, the preview between them;
 *  - (the frame cells are read from the system bitmap 5 that Init only
 *    fetches at its end: 0 while laying out);
 *  - TSOnCommand: previous / next step the preview's suit (the transform
 *    dialog cycles its 8 costumes, LookupCostume); OK posts
 *    (index << 16) | 0xfffe, Cancel (index << 16) | 0xffff, index being
 *    GetCurrentSuitIndex (the costume outfit for the transform dialog);
 *  - TSPaint: the frame (system bitmap 5, BltEdge with a third-size cell);
 *  - PostSim places them centered on the main window, 300 x 400 (pets
 *    300 x 300).
 */

import { WinVitaBtnSolo } from "../cas/winvitabtnsolo.js";
import type { GameContext } from "../context.js";
import { TSWinBtn } from "./btn.js";
import { SYS_POPUP_TILES, TSWinCtrlMgr } from "./ctrlmgr.js";
import { bltEdge, TSWinDlg } from "./dlg.js";
import { TSSystemButton } from "./systembutton.js";
import { TSWinText, WTF_MULTILINE } from "./text.js";
import { Gfx, type TSWin } from "./tswin.js";
import { winMgr } from "./winmgr.js";

/** UIText STR# 152 (cSimsApp's button labels): entry of IDOK. */
const LABELS_STR = 152;
const OK_LABEL_ENTRY = 0;
/** lbl_105BA2E8 + 0x40: the title font. */
const TITLE_FONT_SIZE = 16;
const MARGIN = 9;
const ID_OK = 1;
const ID_CANCEL = 2;
const ID_PREV = 3;
const ID_NEXT = 4;
/** The window PostSim makes (centered on the main window). */
export const OUTFIT_DLG_SIZE = { w: 300, h: 400 };
export const PET_DLG_SIZE = { w: 300, h: 300 };

/** The dialog's result word: index << 16 | 0xfffe (OK) or 0xffff (Cancel); PostSim splits it. */
export function splitDialogResult(r: number): { hi: number; lo: number } {
  return { hi: (r >> 16) << 16 >> 16, lo: (r << 16) >> 16 };
}

abstract class PersonPickDlg extends TSWinDlg {
  protected title: TSWinText | null = null;
  protected okBtn: TSSystemButton | null = null;
  protected cancelBtn: TSSystemButton | null = null;
  protected prevBtn: TSWinBtn | null = null;
  protected nextBtn: TSWinBtn | null = null;
  protected preview: WinVitaBtnSolo | null = null;
  private frame: ImageBitmap | null = null;
  private initialized = false;

  constructor(
    protected readonly ctx: GameContext,
    /** The UIText STR# of the strings. */
    private readonly strings: number,
    private readonly previewScale: number,
    private readonly petLayout: boolean,
  ) {
    super();
  }

  /** SetPerson (+ SetOutfit) on the preview. */
  protected abstract dress(preview: WinVitaBtnSolo): Promise<void>;
  /** The index the result word carries. */
  protected abstract resultIndex(): number;

  /** cSimsApp::DoSimsModalDialog, then the window is destroyed; resolves with the result word. */
  async run(): Promise<number> {
    const size = this.petLayout ? PET_DLG_SIZE : OUTFIT_DLG_SIZE;
    const main = winMgr.main.area;
    const x = main.left + Math.trunc((main.right - main.left - size.w) / 2);
    const y = main.top + Math.trunc((main.bottom - main.top - size.h) / 2);
    this.setArea(x, y, x + size.w, y + size.h);
    if (!(await this.init())) return 0xffff;
    const r = await winMgr.doModalWin(this);
    this.shutdown();
    return r;
  }

  /** <Class>::Init */
  override async init(): Promise<boolean> {
    if (this.initialized) return true;
    this.initialized = true;
    const ctx = this.ctx;
    const str = (i: number): string => ctx.strings.get("UIText", this.strings, i - 1);
    const [mgr, font, prevImg, nextImg] = await Promise.all([
      TSWinCtrlMgr.get(ctx),
      ctx.fonts.acquire(TITLE_FONT_SIZE),
      ctx.res.image(300),
      ctx.res.image(0x12d),
    ]);
    const caption = str(5);
    const title = new TSWinText();
    title.setArea(0, 0, font.stringWidth(caption) + 5, font.height);
    title.setFont(font);
    title.setCaption(caption);
    title.setWinTextFlag(WTF_MULTILINE, false);
    title.setAlignment(2);
    title.setBackgroundOpaque(false);
    this.childAdd(title);
    this.title = title;

    const ok = TSSystemButton.defaultPushBtn(mgr, ID_OK, ctx.strings.get("UIText", LABELS_STR, OK_LABEL_ENTRY));
    this.childAdd(ok);
    this.okBtn = ok;
    const cancel = TSSystemButton.defaultPushBtn(mgr, ID_CANCEL, str(4));
    this.childAdd(cancel);
    this.cancelBtn = cancel;

    // Wider when the title or the buttons do not fit.
    const W0 = this.getW();
    const need = Math.max(W0, title.getW(), ok.getW() + cancel.getW() + 15);
    if (W0 < need) {
      const main = winMgr.main.area;
      const x = Math.trunc((main.right - main.left - (need + 10)) / 2);
      const y = Math.trunc((main.bottom - main.top - this.getH()) / 2);
      this.setArea(x, y, x + need + 10, y + this.getH());
    }
    const W = this.getW();
    const H = this.getH();
    title.moveTo(Math.trunc((W - title.getW()) / 2), MARGIN);
    const btnTop = H - MARGIN - ok.getH();
    const third = Math.trunc((W - (ok.getW() + cancel.getW())) / 3);
    ok.moveTo(third, btnTop);
    cancel.moveTo(ok.getW() + third * 2, btnTop);

    const left = MARGIN;
    const right = W - MARGIN;
    const top = title.getH() + 0x12;
    const prev = new TSWinBtn(ID_PREV, prevImg, 4, 1);
    prev.tooltip = str(2);
    this.childAdd(prev);
    this.prevBtn = prev;
    const next = new TSWinBtn(ID_NEXT, nextImg, 4, 1);
    next.tooltip = str(1);
    this.childAdd(next);
    this.nextBtn = next;

    let preview: WinVitaBtnSolo;
    if (!this.petLayout) {
      const bottom = H - 0x12;
      const inner = right - left;
      const side = Math.trunc((inner - 200) / 2);
      const span = bottom - ok.getH() - top;
      const y = top + Math.trunc((span - prev.getH()) / 2);
      prev.moveTo(side + left - MARGIN - prev.getW(), y);
      next.moveTo(right - side + MARGIN, y);
      preview = new WinVitaBtnSolo(this.previewScale);
      preview.setArea(0, 0, 200, 300);
      preview.moveTo(left + Math.trunc((inner - 200) / 2), top + Math.trunc((span - 300) / 2));
    } else {
      const span = H - 0x24 - ok.getH() - top;
      const y = top + Math.trunc((span - prev.getH()) / 2);
      prev.moveTo(MARGIN, y);
      next.moveTo(W - MARGIN - next.getW(), y);
      preview = new WinVitaBtnSolo(this.previewScale);
      const pw = right - prev.getW() - (next.getW() + MARGIN) - MARGIN;
      preview.setArea(0, 0, pw, span);
      preview.moveTo(prev.area.right, top);
    }
    this.childAdd(preview);
    await preview.init();
    this.preview = preview;
    await this.dress(preview);
    this.frame = mgr.systemBMP(SYS_POPUP_TILES);
    return true;
  }

  /** <Class>::TSOnCommand */
  override tsOnCommand(cmd: number, source: TSWin): boolean {
    const p = this.preview;
    if (source === this.prevBtn && p) {
      this.previous(p);
      return true;
    }
    if (source === this.nextBtn && p) {
      this.next(p);
      return true;
    }
    if (source === this.okBtn) {
      this.tsEndDialog(((this.resultIndex() << 16) | 0xfffe) >>> 0);
      return true;
    }
    if (source === this.cancelBtn) {
      this.tsEndDialog(((this.resultIndex() << 16) | 0xffff) >>> 0);
      return true;
    }
    return super.tsOnCommand(cmd, source);
  }

  protected previous(p: WinVitaBtnSolo): void {
    p.previousSuit();
  }

  protected next(p: WinVitaBtnSolo): void {
    p.nextSuit();
  }

  /** <Class>::TSOnKeyDown passes Return and Escape on to the dialog: the default buttons. */
  override tsOnKeyDown(key: string): boolean {
    if (key === "Enter" || key === "Escape") {
      const b = key === "Enter" ? this.okBtn : this.cancelBtn;
      if (b) this.tsOnCommand(b.id, b);
      return true;
    }
    return false;
  }

  /** <Class>::TSPaint */
  override tsPaint(g: Gfx): void {
    const img = this.frame;
    if (img) bltEdge(g, img, Math.trunc(img.width / 3), Math.trunc(img.height / 3), this.getW(), this.getH(), true);
  }
}

/** The person a picker shows: its body strings and person data. */
export interface PickedPerson {
  bodyStrings: readonly string[];
  personData: Int16Array;
}

/** cWinClothingChoiceDlg::eClothingType -> SAnimator::Outfit (Init's switch). */
const CLOTHING_OUTFIT = [0, 4, 2, 5, 0x11, 0x12];

/** cWinClothingChoiceDlg (kind 6): the outfits of one type (temp 0: 0 normal, 1 formal, 2 swimwear, 3 PJs, 4 winter, 5 high fashion). */
export class WinClothingChoiceDlg extends PersonPickDlg {
  constructor(
    ctx: GameContext,
    /** +0xd0 */
    private readonly clothingType: number,
    /** +0xd4 */
    private readonly person: PickedPerson,
  ) {
    super(ctx, 0xdc, 3.25, false);
  }

  protected async dress(p: WinVitaBtnSolo): Promise<void> {
    await p.setPerson(this.person.bodyStrings, this.person.personData, CLOTHING_OUTFIT[this.clothingType] ?? 0);
  }

  protected resultIndex(): number {
    return this.preview?.getCurrentSuitIndex() ?? -1;
  }
}

/** cWinPetSelectDlg (kind 9): the coats of the pet in the pen. */
export class WinPetSelectDlg extends PersonPickDlg {
  constructor(
    ctx: GameContext,
    /** +0xd0 */
    private readonly pet: PickedPerson,
  ) {
    super(ctx, 0xdd, 5.0, true);
  }

  protected async dress(p: WinVitaBtnSolo): Promise<void> {
    await p.setPerson(this.pet.bodyStrings, this.pet.personData, 0);
  }

  protected resultIndex(): number {
    return this.preview?.getCurrentSuitIndex() ?? -1;
  }
}

/** cWinTransformMeDlg::LookupCostume's tables (lbl_105BD1D0 male, lbl_105BD1CC female). */
const COSTUMES_MALE = [0x30, 0x3a, 0x2c, 0x2d, 0x27, 0x2e, 0x2f, 0x28];
const COSTUMES_FEMALE = [0x30, 0x2b, 0x2c, 0x31, 0x27, 0x32, 0x33, 0x34];

/** cWinTransformMeDlg (kind 0xe): the charm's 8 costumes. */
export class WinTransformMeDlg extends PersonPickDlg {
  /** +0x108: the costume shown (0..7). */
  private costume = 0;

  constructor(
    ctx: GameContext,
    /** +0xd4 */
    private readonly person: PickedPerson,
  ) {
    super(ctx, 0x111, 3.25, false);
  }

  /** cWinTransformMeDlg::LookupCostume: children have two costumes (even / odd), adults eight by gender. */
  private lookupCostume(i: number): number {
    const pd = this.person.personData;
    const male = pd[65] !== 1;
    const age = pd[58]!;
    if (age !== 0 && age < 0x12) return i % 2 === 0 ? (male ? 0x35 : 0x36) : 0x3c;
    return (male ? COSTUMES_MALE : COSTUMES_FEMALE)[i] ?? 0;
  }

  protected async dress(p: WinVitaBtnSolo): Promise<void> {
    await p.setPerson(this.person.bodyStrings, this.person.personData, 0);
    await p.setOutfit(this.lookupCostume(this.costume));
  }

  protected override previous(p: WinVitaBtnSolo): void {
    this.costume = this.costume < 1 ? 7 : this.costume - 1;
    void p.setOutfit(this.lookupCostume(this.costume));
  }

  protected override next(p: WinVitaBtnSolo): void {
    this.costume = this.costume < 7 ? this.costume + 1 : 0;
    void p.setOutfit(this.lookupCostume(this.costume));
  }

  /** The outfit of the preview (cWinVitaBtnSolo +0x1a0). */
  protected resultIndex(): number {
    return this.preview?.outfit ?? 0;
  }
}
