/**
 * cWinDesignFamily: the "Create a Family" screen (family name, up to 8
 * members, add / delete / edit, Done / Cancel), and its member buttons
 * (cWinDesignFamPeopleBtn).
 *
 * From the decompiled class (WinDesignFamily.cpp):
 *  - Init: kDesignFamilyBkg centered (+0x104/+0x108), the dialog color
 *    around it; the family-name edit (size 10 font, white, one line, 24
 *    characters, file-name characters refused, flashing frame while empty,
 *    lbl_105BC72C + lbl_105BC730 = (0x112, 0x32) + (0, 0, 0xff, 0x19)) and
 *    its label (STR# 129 entry 12, size 12 font, 20 px left of it); eight
 *    85 x 105 member buttons (double clicks on) laid out from
 *    lbl_105BC724 = (0x6f, 0x79) every 0x78 px, wrapping inside
 *    lbl_105BC728 = (0, 0, 0x1b8, 0x168) every 0x8c px; add / delete / edit
 *    bitmaps (lbl_105BC720 = 5023..5025, 4 frames, at lbl_105BC71C,
 *    tooltips 0..2) and Done / Cancel cTSSystemButtons (kNghDefaultBtn,
 *    200 px, centered on (200, 0x211) / (600, 0x211), captions 3, 4); the
 *    title (entry 9, size 16 font, centered 6 px from the top);
 *  - PrepareButtons: each member button shows the person's portrait
 *    (PersonFinder::GetPictureBuffer: BuildPersonBtn of BMP_ 2002, 4 x 3
 *    cells, drawn at lbl_105BC73C = (15, 10)) and first name (size 10 font,
 *    bottom two lines); the unused buttons are hidden; Add needs a family
 *    name and fewer than 8 members, Done a member, Delete / Edit a
 *    selection;
 *  - TSOnCommand (jump table lbl_105BC734): 1 = buttons (below), 0x16 =
 *    name edited (PrepareButtons), 0x18 = Escape (Cancel), 0x1a = double
 *    click on a member (Edit), 0x1f = a new person was designed (appended);
 *    Add / Edit run a cWinDesignCharacter modally (the family name copied
 *    to its +0x1a0), Delete asks (entries 5 / 6, yes / no) then
 *    DeletePerson, Done asks (13 / 14, OK / Cancel) then MakeNewFamily,
 *    SetFamilyName, AddFamilyMember for each member, FinishFamily and posts
 *    {3, 0x1e, family} to the family picker; Cancel with members asks
 *    (7 / 8, OK / Cancel), deletes them and FinishFamily(-1).
 *
 *  - cWinDesignFamPeopleBtn::GetToolTipsWindow: the dialog's own
 *    cPickFamilyPersonInfo (+0x170, created in the constructor) set to the
 *    button's person (cas/personinfo.ts).
 *
 * FinishFamily(family): Neighborhood::Save, then (family != -1)
 * Neighborhood::ExportFamily into the neighborhood's Export folder
 * (NeighborhoodStore.exportFamily: <name>_<id>.FAM) and, when the "export
 * HTML" option is on, ExportFamilyHTML (nbhd/exporthtml.ts).
 */

import type { GameContext } from "../context.js";
import { buildPersonBtn } from "../cpanel/live/peoplebuttons.js";
import { exportFamilyHTML } from "../nbhd/exporthtml.js";
import { getOptionsMgr } from "../optionsmgr.js";
import { ALIGN_CENTER, type FfnFont } from "../res/ffn.js";
import { TSWinBtn } from "../ui/btn.js";
import { TSWinCtrlMgr } from "../ui/ctrlmgr.js";
import { GENDLG_FILL, TSWinGenDlg } from "../ui/gendlg.js";
import { IDOK, IDYES, MB_OKCANCEL, MB_YESNO, TSWinMsgBox } from "../ui/msgbox.js";
import { hiliteColor, rgb } from "../ui/syscolors.js";
import { TSSystemButton } from "../ui/systembutton.js";
import { TSWinText } from "../ui/text.js";
import { TE_CHANGED, TE_ESCAPE, TSWinTextEdit2 } from "../ui/textedit.js";
import { Gfx, TSWin } from "../ui/tswin.js";
import { winMgr, type ToolTipWindow, type ToolTipsWindowSource } from "../ui/winmgr.js";
import type { CasPerson, CasSession } from "./personfinder.js";
import { PickFamilyPersonInfo } from "./personinfo.js";
import { WinDesignCharacter } from "./windesigncharacter.js";
import { getStandardCursor } from "../ui/cursor.js";

const STRINGS = 129;
const S = {
  firstTooltip: 0,
  firstCaption: 3,
  deleteTitle: 5,
  deleteMessage: 6,
  cancelTitle: 7,
  cancelMessage: 8,
  title: 9,
  nameLabel: 12,
  doneTitle: 13,
  doneMessage: 14,
} as const;

const MAX_MEMBERS = 8;
/** lbl_105BC720 / lbl_105BC71C: add, delete, edit (top-left), then Done / Cancel (center). */
const BUTTONS = [
  { image: 5023, x: 0x251, y: 0x67 },
  { image: 5024, x: 0x252, y: 0xd0 },
  { image: 5025, x: 0x252, y: 0x137 },
  { image: 0, x: 200, y: 0x211 },
  { image: 0, x: 600, y: 0x211 },
];
const B = { add: 0, delete: 1, edit: 2, done: 3, cancel: 4 } as const;
const BUTTON_ID_BASE = 0x5100;
/** lbl_105BC72C + lbl_105BC730 */
const NAME_EDIT = { x: 0x112, y: 0x32, w: 0xff, h: 0x19 };
/** lbl_105BC724 / lbl_105BC728: member buttons flow. */
const MEMBERS = { x: 0x6f, y: 0x79, w: 0x1b8, h: 0x168, stepX: 0x78, stepY: 0x8c };
const MEMBER_W = 0x55;
const MEMBER_H = 0x69;
/** lbl_105BC73C: portrait position in a member button. */
const FACE = { x: 15, y: 10 };
const DLG_FILL = rgb(0, 0x32, 0);
const WHITE = rgb(0xff, 0xff, 0xff);
/** cTSWinBtn double-click time (GetDoubleClickTime). */
const DOUBLE_CLICK_MS = 500;

/** cWinDesignFamPeopleBtn: a member's portrait and first name. */
class WinDesignFamPeopleBtn extends TSWinBtn implements ToolTipsWindowSource {
  person: CasPerson | null = null;
  /** +0x18c: the owner's tooltip window. */
  info: PickFamilyPersonInfo | null = null;
  private lastClick = -Infinity;
  onDoubleClick: (() => void) | null = null;

  constructor(id: number) {
    super(id, null, 4, 3);
    // +0xf0 = 1: a toggle (the selection).
    this.mode = 1;
  }

  override tsOnMouseDownL(): boolean {
    const now = performance.now();
    const double = now - this.lastClick < DOUBLE_CLICK_MS;
    this.lastClick = double ? -Infinity : now;
    super.tsOnMouseDownL();
    if (double) this.onDoubleClick?.();
    return true;
  }

  /** cWinDesignFamPeopleBtn::GetToolTipsWindow */
  getToolTipsWindow(): ToolTipWindow | null {
    const p = this.person;
    if (!this.info || !p) return null;
    this.info.setPerson({ name: p.firstName, bio: p.bio, personData: p.personData });
    return this.info;
  }

  override tsPaint(g: Gfx): void {
    const img = this.image;
    if (img) {
      const cw = Math.trunc(img.width / 4);
      const ch = Math.trunc(img.height / 3);
      g.blitPart(img, this.frameColumn() * cw, 0, cw, ch, FACE.x, FACE.y);
    }
    const font = this.font;
    if (font && this.caption) {
      // Text rectangle (+0x114..+0x120): the bottom two lines.
      const top = MEMBER_H - (font.height * 2 + 2);
      const rect = { left: g.ox, top: g.oy + top, right: g.ox + MEMBER_W, bottom: g.oy + MEMBER_H };
      font.drawTextPara(g.ctx, rect, this.caption, ALIGN_CENTER, hiliteColor(4, this.frameColumn()));
    }
  }
}

/** Who hears about the finished family ({3, 0x1e, family} to +0x154). */
export interface DesignFamilyTarget {
  familyDesigned(familyId: number): void;
}

export class WinDesignFamily extends TSWinGenDlg {
  /** Made for one screen size: a live screen resize waits until it is gone (ui/screenresize.ts). */
  readonly holdsScreenSize = true;

  private target: DesignFamilyTarget | null = null;
  private bkg: ImageBitmap | null = null;
  private template: ImageBitmap | null = null;
  private offX = 0;
  private offY = 0;
  private nameEdit: TSWinTextEdit2 | null = null;
  private readonly buttons: TSWinBtn[] = [];
  private readonly memberBtns: WinDesignFamPeopleBtn[] = [];
  /** +0x110: the people designed so far. */
  private readonly members: CasPerson[] = [];
  /** +0x13c: selected member, -1 for none. */
  private selected = -1;
  private memberFont: FfnFont | null = null;
  private busy = false;

  constructor(
    ctx: GameContext,
    private readonly session: CasSession,
  ) {
    super(ctx, GENDLG_FILL);
    // cWinDesignFamily::cWinDesignFamily (Mac): SetCursor(GetStandardCursor(0)).
    this.winCursor = getStandardCursor(0);
  }

  setMessageTarget(t: DesignFamilyTarget): void {
    this.target = t;
  }

  private str(i: number): string {
    return this.ctx.strings.get("UIText", STRINGS, i);
  }

  override async init(): Promise<boolean> {
    const { ctx } = this;
    this.fillColor = DLG_FILL;
    const sysImage = await ctx.res.image("kNghDefaultBtn");
    this.bkg = await ctx.res.image("kDesignFamilyBkg");
    this.template = await ctx.res.image("kPeopleTemplate");
    const bw = this.bkg.width;
    const bh = this.bkg.height;
    this.offX = bw < this.getW() ? (this.getW() - bw) >> 1 : 0;
    this.offY = bh < this.getH() ? (this.getH() - bh) >> 1 : 0;
    await super.init();
    const ox = this.offX;
    const oy = this.offY;
    const mgr = await TSWinCtrlMgr.get(ctx);
    const f10 = await ctx.fonts.acquire(10);
    const f12 = await ctx.fonts.acquire(12);
    const f16 = await ctx.fonts.acquire(16);
    this.memberFont = f10;
    const info = await PickFamilyPersonInfo.create(ctx).catch(() => null);

    const name = new TSWinTextEdit2();
    name.setFont(f10);
    name.setTextColor(WHITE);
    name.setArea(NAME_EDIT.x + ox, NAME_EDIT.y + oy, NAME_EDIT.x + NAME_EDIT.w + ox, NAME_EDIT.y + NAME_EDIT.h + oy);
    name.target = this;
    name.setLinesAllowed(1);
    // +0x18c / +400: "UI_NHood_error" (lbl_105BC738 + 0xd) for a refused insertion or character.
    name.errorSound = "UI_NHood_error";
    name.filterSound = "UI_NHood_error";
    name.setTransparent(true);
    name.setColors(DLG_FILL, WHITE, WHITE);
    name.setCapacity(0x18);
    name.setFlashFrameOnEmpty(true);
    name.setDrawFrameOnFocus(false);
    name.setFilterFileChars(true);
    this.childAdd(name);
    this.nameEdit = name;

    const label = new TSWinText();
    label.setFont(f12);
    label.setWinTextFlag(2, false);
    label.setCaption(this.str(S.nameLabel));
    label.fitWindowToText();
    label.moveTo(NAME_EDIT.x + ox - label.getW() - 20, NAME_EDIT.y + oy);
    label.setBackgroundOpaque(false);
    this.childAdd(label);

    for (let i = 0; i < MAX_MEMBERS; i++) {
      const b = new WinDesignFamPeopleBtn(BUTTON_ID_BASE + 0x10 + i);
      b.setArea(0, 0, MEMBER_W, MEMBER_H);
      b.onDoubleClick = () => this.editSelected();
      b.info = info;
      this.childAdd(b);
      this.memberBtns.push(b);
    }
    // Flow layout, rows wrapping inside MEMBERS.w (each new row moves down by row * stepY).
    {
      const startX = MEMBERS.x + ox;
      const right = startX + MEMBERS.w;
      let x = startX;
      let y = MEMBERS.y + oy;
      let rows = 0;
      for (const b of this.memberBtns) {
        b.moveTo(x, y);
        x += MEMBERS.stepX;
        if (right < x) {
          x = startX;
          rows++;
          y += rows * MEMBERS.stepY;
        }
      }
    }

    for (let i = 0; i < BUTTONS.length; i++) {
      const def = BUTTONS[i]!;
      if (i < 3) {
        const img = await ctx.res.image(def.image);
        const b = new TSWinBtn(BUTTON_ID_BASE + i, img, 4, 1);
        b.setArea(0, 0, Math.trunc(img.width / 4), img.height);
        b.moveTo(def.x + ox, def.y + oy);
        this.childAdd(b);
        b.tooltip = this.str(S.firstTooltip + i);
        this.buttons.push(b);
      } else {
        const b = new TSSystemButton(mgr, sysImage);
        b.id = BUTTON_ID_BASE + i;
        b.setArea(b.area.left, b.area.top, b.area.left + 200, b.area.top + sysImage.height);
        const cx = def.x + ox;
        const cy = def.y + oy + (sysImage.height >> 1);
        const left = cx - (b.getW() >> 1);
        const top = cy - (b.getH() >> 1);
        b.setArea(left, top, left + b.getW(), top + b.getH());
        b.setCaption(this.str(S.firstCaption + i - 3));
        this.childAdd(b);
        this.buttons.push(b);
      }
    }

    const title = new TSWinText();
    title.setFont(f16);
    title.setArea(0, oy + 6, this.getW(), f16.height + 6 + oy);
    title.setCaption(this.str(S.title));
    title.setAlignment(2);
    title.setBackgroundOpaque(false);
    this.childAdd(title);

    this.prepareButtons();
    winMgr.setFocus(name);
    return true;
  }

  private get familyName(): string {
    return this.nameEdit?.getText() ?? "";
  }

  /** cWinDesignFamily::PrepareButtons */
  private prepareButtons(): void {
    this.members.forEach((p, i) => {
      const b = this.memberBtns[i];
      if (!b) return;
      b.person = p;
      if (this.template) b.setImage(buildPersonBtn(p.face, this.template), 4, 3);
      b.setArea(b.area.left, b.area.top, b.area.left + MEMBER_W, b.area.top + MEMBER_H);
      b.caption = p.firstName;
      // Any text: the window manager only asks windows that have a tooltip.
      b.tooltip = p.firstName || " ";
      b.font = this.memberFont;
      b.setState(0);
      b.showWindow();
    });
    for (let i = this.members.length; i < MAX_MEMBERS; i++) this.memberBtns[i]?.hideWindow();
    const b = this.buttons;
    b[B.add]!.enabled = this.members.length < MAX_MEMBERS && this.familyName.length > 0;
    b[B.done]!.enabled = this.members.length > 0;
    b[B.delete]!.enabled = this.selected !== -1;
    b[B.edit]!.enabled = this.selected !== -1;
    if (this.selected !== -1) this.memberBtns[this.selected]?.setState(1);
  }

  /** Add (+0x140) / Edit (+0x148): cWinDesignCharacter, modal, over this window. */
  private async designCharacter(p: CasPerson | null): Promise<void> {
    const dlg = new WinDesignCharacter(this.ctx, this.session);
    dlg.setArea(this.area.left, this.area.top, this.area.right, this.area.bottom);
    if (p) dlg.setPerson(p);
    dlg.setMessageTarget({ personDesigned: (q) => this.personDesigned(q) });
    dlg.familyName = this.familyName;
    if (!(await dlg.init())) return;
    this.nameEdit?.hideWindow();
    await winMgr.doModalWin(dlg);
    this.nameEdit?.showWindow();
    winMgr.setFocus(this.nameEdit);
    this.prepareButtons();
  }

  /** Command 0x1f: a new person joins the family. */
  private personDesigned(p: CasPerson): void {
    this.members.push(p);
    this.prepareButtons();
  }

  private editSelected(): void {
    const p = this.members[this.selected];
    if (p) void this.run(() => this.designCharacter(p));
  }

  private async deleteSelected(): Promise<void> {
    const p = this.members[this.selected];
    if (!p) return;
    const r = await TSWinMsgBox.show(this.ctx, this.str(S.deleteMessage), this.str(S.deleteTitle), MB_YESNO);
    if (r !== IDYES) return;
    await this.session.deletePerson(p);
    this.members.splice(this.selected, 1);
    this.selected = -1;
    this.prepareButtons();
  }

  /** Done: MakeNewFamily, SetFamilyName, AddFamilyMember, FinishFamily. */
  private async done(): Promise<void> {
    const r = await TSWinMsgBox.show(this.ctx, this.str(S.doneMessage), this.str(S.doneTitle), MB_OKCANCEL);
    if (r !== IDOK) return;
    const store = this.session.store;
    const family = store.makeNewFamily();
    store.setFamilyName(family, this.familyName);
    for (const p of this.members) store.addToFamily(p.guid, family);
    // FinishFamily: the neighborhood is saved, then the family exported (its result ignored)
    // and its web pages when the option is on.
    await store.save();
    if (!(await store.exportFamily(family))) console.warn(`[cas] ExportFamily ${family} failed`);
    if (getOptionsMgr().getExportHTML()) {
      await exportFamilyHTML(this.ctx, store, family).catch((e: unknown) => console.warn(`[cas] ExportFamilyHTML ${family} failed`, e));
    }
    this.target?.familyDesigned(family);
    this.tsEndDialog(1);
  }

  private async cancel(): Promise<void> {
    if (this.members.length > 0) {
      const r = await TSWinMsgBox.show(this.ctx, this.str(S.cancelMessage), this.str(S.cancelTitle), MB_OKCANCEL);
      if (r !== IDOK) return;
      for (const p of [...this.members]) await this.session.deletePerson(p);
      this.members.length = 0;
      // FinishFamily(-1)
      await this.session.store.save();
    }
    this.tsEndDialog(0);
  }

  /** One command at a time (the original runs them inside the message loop). */
  private async run(task: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await task();
    } finally {
      this.busy = false;
    }
  }

  override tsOnCommand(cmd: number, source: TSWin): boolean {
    if (cmd === TE_CHANGED) {
      if (source === this.nameEdit) this.prepareButtons();
      return true;
    }
    if (cmd === TE_ESCAPE) {
      void this.run(() => this.cancel());
      return true;
    }
    if (!(source instanceof TSWinBtn)) return true;
    const m = this.memberBtns.indexOf(source as WinDesignFamPeopleBtn);
    if (m >= 0) {
      // Selecting a member: the previous one pops up.
      if (this.selected !== -1 && this.selected !== m) this.memberBtns[this.selected]?.setState(0);
      this.selected = source.state ? m : -1;
      this.prepareButtons();
      return true;
    }
    switch (this.buttons.indexOf(source)) {
      case B.add:
        void this.run(() => this.designCharacter(null));
        break;
      case B.delete:
        void this.run(() => this.deleteSelected());
        break;
      case B.edit:
        this.editSelected();
        break;
      case B.done:
        void this.run(() => this.done());
        break;
      case B.cancel:
        void this.run(() => this.cancel());
        break;
    }
    return true;
  }

  override tsOnKeyDown(key: string): boolean {
    if (key === "Escape") {
      void this.run(() => this.cancel());
      return true;
    }
    return false;
  }

  /** The focus goes to the name edit once the dialog is up (DoModalWin focuses the dialog itself). */
  override tsBeginModal(): void {
    if (this.nameEdit) winMgr.setFocus(this.nameEdit);
  }

  override tsOnMouseDownL(x: number, y: number): boolean {
    if (this.nameEdit && this.nameEdit.getText().length === 0) winMgr.setFocus(this.nameEdit);
    return super.tsOnMouseDownL(x, y);
  }

  override tsPaint(g: Gfx): void {
    const bkg = this.bkg;
    if (!bkg) return;
    const w = this.getW();
    const h = this.getH();
    const ox = this.offX;
    const oy = this.offY;
    if (ox > 0 || oy > 0) {
      g.fill(0, 0, w, oy, DLG_FILL);
      g.fill(0, oy + bkg.height, w, h - oy - bkg.height, DLG_FILL);
      g.fill(0, oy, ox, bkg.height, DLG_FILL);
      g.fill(ox + bkg.width, oy, w - ox - bkg.width, bkg.height, DLG_FILL);
    }
    g.blit(bkg, ox, oy);
  }
}
