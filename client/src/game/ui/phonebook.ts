/**
 * CWinPhoneBook: the phone's "Call..." picker (ObjectModule::PostSim when the
 * Dialog primitive of kind 0xa left a negative caller id in ObjectModule
 * +0xec). Two lists: the families the caller knows someone in, and the
 * members of the selected family the caller knows.
 *
 * From the decompiled class:
 *  - constructor(font, callerNeighborId): the font is lbl_105BA2E8 + 0x30
 *    (font table entry 12); the neighborhood is the app's (+0x100);
 *  - Init: kCatalogPopupBackTiles (frame), kPhoneBookBkg, kPhoneBookIcon;
 *    UIText STR# 0xb4 (1 "Call", 2 "Call" button, 3 "doesn't know anyone.");
 *    the window 0x28c x 0x1aa (lbl_105BCC30 then resized), centered on the
 *    main window; the OK button (DefaultPushBtn id 0, string 2) 0x14 px from
 *    the left, Cancel (id 1, cTSWinMsgBox::GetButtonLabel(1)) 0x14 px from
 *    the right, both with their top 1.5 button heights above the bottom;
 *    a DefaultLabel "<caller> doesn't know anyone." resized to 0x21c x 0x19
 *    at lbl_105BCC28 = (0x4b, 0x10); the family list at lbl_105BCC20 =
 *    (0x22, 0x4d) and the member list at lbl_105BCC1C = (0x15f, 0x4d), both
 *    lbl_105BCC24.x (0x10e) + 10 wide, 10 rows, filled (0, 0, 0x39); the
 *    first family and its first member selected; no family: OK disabled;
 *  - IsFamilyAvailable: not the caller's own family; a family number below
 *    2000 must be non-zero and live in a house (+0x110 > 0); then one member
 *    with an object selector, gender < 2 (not a pet) and an entry in the
 *    caller's relationship matrix;
 *  - FillFamilyList / FillFamilyMembers: those families' names, those
 *    members' catalog names (an empty name is not listed);
 *    GetSelectedFamily / GetSelectedNeighborID map the selections back by
 *    counting the same way;
 *  - TSOnCommand: OK (or a double click, command 9) ends the dialog,
 *    Cancel ends it cancelled (+0x1a4); a list selection (0x15) refills the
 *    members when the family changed, else updates the face
 *    (SetIconToNeighbor); then the label reads "Call <member> <family>.";
 *  - TSOnKeyDown: Return = OK, Escape = Cancel;
 *  - TSBeginModal: focus on the family list, a 40 s timer that cancels
 *    (TSOnTimerMsg);
 *  - TSPaint: the frame (BltEdge, cells a third of the bitmap), the
 *    background at (0x11, 8), the phone icon centered at the bottom, the
 *    face (45 x 45) at (10, 10);
 *  - GetSelected: 0 when cancelled, else the selected neighbor id.
 *
 * Port: the object selector and PersonFinder lookups are the neighbor's
 * character file: its first name is the person's catalog name, and
 * PersonFinder::GetPictureBuffer's picture is BuildPersonBtn(BMP_ 2002,
 * kPeopleTemplate), of which TSPaint shows the first 45 x 45 cell.
 */

import type { GameContext } from "../context.js";
import { loadCharacter, PD, type Family, type Neighbor, type NeighborhoodData } from "../data/neighborhood.js";
import { buildPersonBtn } from "../cpanel/live/peoplebuttons.js";
import { decodeImage } from "../res/bmp.js";
import type { FfnFont } from "../res/ffn.js";
import type { TSWinBtn } from "./btn.js";
import { TSWinCtrlMgr } from "./ctrlmgr.js";
import { bltEdge, TSWinDlg } from "./dlg.js";
import { rgb } from "./syscolors.js";
import { TSSystemButton } from "./systembutton.js";
import { TSWinText, WTF_MULTILINE } from "./text.js";
import { CMD_LIST_DOUBLE_CLICK, CMD_LIST_SELECT, TSWinTextList } from "./textlist.js";
import { Gfx, type TSWin, WF_NO_FOCUS } from "./tswin.js";
import { winMgr } from "./winmgr.js";

/** LoadUIStrings(0xb4, GetStringConstant(9) = UIText). StringSetBase::GetString is 1-based. */
const STRINGS = 0xb4;
const STR_CALL = 1;
const STR_CALL_BUTTON = 2;
const STR_KNOWS_NOBODY = 3;
/** cTSWinMsgBox::GetButtonLabel(1): UIText STR# 152 entry 1. */
const LABELS_STR = 152;
const CANCEL_LABEL_ENTRY = 1;
/** lbl_105BCC34: " ", and "." two bytes further. */
const SPACE = " ";
const PERIOD = ".";

const ID_OK = 0;
const ID_CANCEL = 1;
/** lbl_105BA2E8 + 0x30: the font the ObjectModule passes. */
const FONT_SIZE = 12;
/** ___sinit__WinPhonebook_cpp */
const INITIAL_POS = { x: 0x32, y: 0x32 };
const INITIAL_SIZE = { w: 0x271, h: 300 };
const LABEL_POS = { x: 0x4b, y: 0x10 };
const LIST_SIZE = { w: 0x10e, h: 0x113 };
const FAMILY_LIST_POS = { x: 0x22, y: 0x4d };
const MEMBER_LIST_POS = { x: 0x15f, y: 0x4d };
/** Init's final SetArea. */
const WIDTH = 0x28c;
const HEIGHT = 0x1aa;
const LABEL_W = 0x21c;
const LABEL_H = 0x19;
const BUTTON_INSET = 0x14;
const LIST_ROWS = 10;
const LIST_FILL = rgb(0, 0, 0x39);
const BKG_POS = { x: 0x11, y: 8 };
const FACE_POS = 10;
const FACE_SIZE = 0x2d;
/** TSBeginModal: SubscribeTimerMsg(this, 40000). */
const TIMEOUT_MS = 40000;
/** Family numbers from 2000 up need no house. */
const HOUSELESS_FAMILY_BASE = 2000;
/** Person data gender values below 2 are people (pets are 2 and up). */
const PET_GENDER = 2;

/** What PersonFinder / ObjectFolder give for a neighbor: the catalog name and the picture. */
interface PersonEntry {
  name: string;
  picture: ImageBitmap | null;
}

/** PersonFinder::GetPictureBuffer: the person button image built from the faces (BMP_ 2002). */
async function loadPicture(bytes: Uint8Array | undefined, template: ImageBitmap): Promise<ImageBitmap> {
  let face: ImageBitmap | null = null;
  if (bytes) {
    const img = decodeImage(bytes, "face.bmp", { colorKey: true });
    face = await createImageBitmap(new ImageData(img.data, img.width, img.height));
  }
  return buildPersonBtn(face, template);
}

export class WinPhoneBook extends TSWinDlg {
  /** +0x108 / +0x10c */
  private familyList: TSWinTextList | null = null;
  private memberList: TSWinTextList | null = null;
  /** +0x110 / +0x114 */
  private okBtn: TSWinBtn | null = null;
  private cancelBtn: TSWinBtn | null = null;
  /** +0x118 */
  private label: TSWinText | null = null;
  /** +0x11c */
  private font: FfnFont | null = null;
  /** +0x120 / +0x124 / +0x128 */
  private frame: ImageBitmap | null = null;
  private background: ImageBitmap | null = null;
  private icon: ImageBitmap | null = null;
  /** +0x12c: the face shown. */
  private face: ImageBitmap | null = null;
  /** +0x130 / +0x134: the family and member rows last seen selected. */
  private familyIndex = 0;
  private memberIndex = 0;
  /** +0x1a4 */
  private cancelled = false;
  private timer = 0;
  private initialized = false;
  /** ObjectFolder::GetSelectorByGUID + PersonFinder, by GUID (absent: no selector). */
  private readonly people = new Map<number, PersonEntry>();

  constructor(
    private readonly ctx: GameContext,
    /** +0x100: the neighborhood. */
    private readonly nb: NeighborhoodData,
    /** +0x104 */
    private readonly callerNeighborId: number,
  ) {
    super();
  }

  /** cSimsApp::DoSimsModalDialog, then the window is destroyed; read getSelected() afterwards. */
  async run(): Promise<void> {
    if (!(await this.init())) return;
    await winMgr.doModalWin(this);
    this.shutdown();
  }

  private findNeighborByID(id: number): Neighbor | undefined {
    return this.nb.neighbors.find((n) => n.id === id);
  }

  private findNeighborByGUID(guid: number): Neighbor | undefined {
    return this.nb.neighbors.find((n) => (n.guid | 0) === (guid | 0));
  }

  private person(guid: number): PersonEntry | undefined {
    return this.people.get(guid >>> 0);
  }

  /** Loads the character file of every family member and of the caller (the selector / PersonFinder lookups). */
  private async loadPeople(): Promise<void> {
    const template = await this.ctx.res.image("kPeopleTemplate");
    const guids = new Set<number>();
    for (const f of this.nb.families) for (const g of f.memberGuids) guids.add(g >>> 0);
    const caller = this.findNeighborByID(this.callerNeighborId);
    if (caller) guids.add(caller.guid >>> 0);
    await Promise.all(
      [...guids].map(async (guid) => {
        const n = this.findNeighborByGUID(guid);
        if (!n) return;
        const c = await loadCharacter(this.nb.dir, n.name).catch(() => null);
        if (!c) return;
        this.people.set(guid, { name: c.firstName, picture: await loadPicture(c.bitmaps.get(2002), template).catch(() => null) });
      }),
    );
  }

  /** CWinPhoneBook::Init */
  override async init(): Promise<boolean> {
    if (this.initialized) return true;
    this.initialized = true;
    const ctx = this.ctx;
    const [mgr, frame, background, icon] = await Promise.all([
      TSWinCtrlMgr.get(ctx),
      ctx.res.image("kCatalogPopupBackTiles"),
      ctx.res.image("kPhoneBookBkg"),
      ctx.res.image("kPhoneBookIcon"),
      this.loadPeople(),
    ]);
    this.frame = frame;
    this.background = background;
    this.icon = icon;
    const font = mgr.tableFont(FONT_SIZE);
    this.font = font;
    const str = (i: number): string => ctx.strings.get("UIText", STRINGS, i - 1);

    this.setArea(0, 0, INITIAL_SIZE.w, INITIAL_SIZE.h);
    this.moveTo(INITIAL_POS.x, INITIAL_POS.y);
    this.setSize(WIDTH, HEIGHT);
    this.centerWindowInRect(winMgr.main.area);
    const W = this.getW();
    const H = this.getH();

    const ok = TSSystemButton.defaultPushBtn(mgr, ID_OK, str(STR_CALL_BUTTON));
    ok.setFlag(WF_NO_FOCUS, true);
    ok.moveTo(BUTTON_INSET, H - Math.trunc((ok.getH() * 3) / 2));
    this.childAdd(ok);
    this.okBtn = ok;

    const cancel = TSSystemButton.defaultPushBtn(mgr, ID_CANCEL, ctx.strings.get("UIText", LABELS_STR, CANCEL_LABEL_ENTRY));
    cancel.setFlag(WF_NO_FOCUS, true);
    cancel.moveTo(W - cancel.getW() - BUTTON_INSET, H - Math.trunc((cancel.getH() * 3) / 2));
    this.childAdd(cancel);
    this.cancelBtn = cancel;

    // "<caller's catalog name> doesn't know anyone." (a lone space when the caller is unknown).
    const caller = this.findNeighborByID(this.callerNeighborId);
    const callerName = caller ? (this.person(caller.guid)?.name ?? "") : SPACE;
    this.setIconToCaller();
    const label = this.defaultLabel(mgr, callerName + SPACE + str(STR_KNOWS_NOBODY));
    label.setArea(0, 0, LABEL_W, LABEL_H);
    label.moveTo(LABEL_POS.x, LABEL_POS.y);
    this.childAdd(label);
    this.label = label;

    this.familyList = await this.addList(font, FAMILY_LIST_POS);
    this.memberList = await this.addList(font, MEMBER_LIST_POS);

    this.fillFamilyList();
    if (this.familyList.size() !== 0) this.familyList.select(0);
    else ok.setEnabled(false);
    this.fillFamilyMembers();
    if (this.memberList.size() !== 0) this.memberList.select(0);
    this.setFlag(WF_NO_FOCUS, true);
    return true;
  }

  /** cTSWinCtrlMgr::DefaultLabel(0, text) */
  private defaultLabel(mgr: TSWinCtrlMgr, text: string): TSWinText {
    const t = new TSWinText();
    t.setCaption(text);
    t.setFont(mgr.systemFont(0));
    t.setAlignment(1);
    t.setBackgroundOpaque(false);
    t.setWinTextFlag(WTF_MULTILINE, false);
    t.fitWindowToText();
    return t;
  }

  private async addList(font: FfnFont, pos: { x: number; y: number }): Promise<TSWinTextList> {
    const list = new TSWinTextList(this.ctx);
    list.setFont(font);
    list.visibleRows = LIST_ROWS;
    list.setArea(0, 0, LIST_SIZE.w, font.height * LIST_ROWS);
    list.moveTo(pos.x, pos.y);
    list.fillColor = LIST_FILL;
    list.setArea(list.area.left, list.area.top, list.area.left + LIST_SIZE.w + 10, list.area.bottom);
    list.setArea(list.area.left, list.area.top, list.area.right, list.area.top + LIST_SIZE.h);
    this.childAdd(list);
    await list.init();
    return list;
  }

  /** CWinPhoneBook::Shutdown */
  override shutdown(): void {
    this.okBtn = null;
    this.cancelBtn = null;
    this.label = null;
    this.face = null;
    super.shutdown();
  }

  /** The members test shared by IsFamilyAvailable, FillFamilyMembers and GetSelectedNeighborID: a person the caller knows. */
  private callerKnows(member: Neighbor): boolean {
    if ((member.personData?.[PD.gender] ?? 0) >= PET_GENDER) return false;
    const caller = this.findNeighborByID(this.callerNeighborId);
    const rel = caller?.relationships.find((r) => r.other === member.id);
    return (rel?.values.length ?? 0) >= 1;
  }

  /** The members of `family` that are listed, in order (the selector, gender and relationship tests). */
  private knownMembers(family: Family): Neighbor[] {
    const out: Neighbor[] = [];
    for (const guid of family.memberGuids) {
      if (!this.person(guid)) continue;
      const n = this.findNeighborByGUID(guid);
      if (n && this.callerKnows(n)) out.push(n);
    }
    return out;
  }

  /** CWinPhoneBook::IsFamilyAvailable */
  private isFamilyAvailable(family: Family): boolean {
    const number = family.chunkId;
    const caller = this.findNeighborByID(this.callerNeighborId);
    if (number === (caller?.personData?.[PD.familyNumber] ?? 0)) return false;
    if (number < HOUSELESS_FAMILY_BASE && (number === 0 || family.houseNumber < 1)) return false;
    // The original does not test the selector here.
    return family.memberGuids.some((guid) => {
      const n = this.findNeighborByGUID(guid);
      return n !== undefined && this.callerKnows(n);
    });
  }

  /** CWinPhoneBook::FillFamilyList */
  private fillFamilyList(): void {
    const list = this.familyList!;
    for (const f of this.nb.families) if (this.isFamilyAvailable(f)) list.insert(list.size(), f.name);
  }

  /** CWinPhoneBook::FillFamilyMembers */
  private fillFamilyMembers(): void {
    const list = this.memberList!;
    while (list.size() !== 0) list.erase(list.size() - 1);
    const family = this.getSelectedFamily();
    if (!family) return;
    for (const n of this.knownMembers(family)) {
      const name = this.person(n.guid)?.name ?? "";
      if (name) list.insert(list.size(), name);
    }
  }

  /** CWinPhoneBook::GetSelectedFamily */
  private getSelectedFamily(): Family | null {
    const sel = this.familyList?.getSelection() ?? -1;
    if (sel < 0) return null;
    return this.nb.families.filter((f) => this.isFamilyAvailable(f))[sel] ?? null;
  }

  /** CWinPhoneBook::GetSelectedNeighborID: 0 when nothing is selected. */
  private getSelectedNeighborID(): number {
    const sel = this.memberList?.getSelection() ?? -1;
    if (sel < 0) return 0;
    const family = this.getSelectedFamily();
    if (!family) return 0;
    return this.knownMembers(family)[sel]?.id ?? 0;
  }

  /** CWinPhoneBook::GetSelected: the neighbor id picked, 0 when cancelled (or nothing picked). */
  getSelected(): number {
    if (this.cancelled || !this.memberList) return 0;
    return this.getSelectedNeighborID();
  }

  /** CWinPhoneBook::SetIconToCaller */
  private setIconToCaller(): void {
    this.face = null;
    const caller = this.callerNeighborId ? this.findNeighborByID(this.callerNeighborId) : undefined;
    if (caller) this.face = this.person(caller.guid)?.picture ?? null;
  }

  /** CWinPhoneBook::SetIconToNeighbor */
  private setIconToNeighbor(): void {
    if (!this.familyList || this.familyList.size() === 0) return;
    this.face = null;
    const id = this.getSelectedNeighborID();
    const n = id ? this.findNeighborByID(id) : undefined;
    if (n) this.face = this.person(n.guid)?.picture ?? null;
  }

  /** CWinPhoneBook::TSBeginModal */
  override tsBeginModal(): void {
    const list = this.familyList;
    if (list && !list.getFlag(WF_NO_FOCUS)) winMgr.setFocus(list);
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.tsOnTimerMsg(), TIMEOUT_MS);
  }

  /** CWinPhoneBook::TSEndModal */
  override tsEndModal(): void {
    window.clearTimeout(this.timer);
  }

  /** CWinPhoneBook::TSOnTimerMsg: nobody picked in time, the call is cancelled. */
  private tsOnTimerMsg(): void {
    window.clearTimeout(this.timer);
    this.tsEndDialog(0);
    this.cancelled = true;
  }

  /** CWinPhoneBook::TSOnKeyDown: Return presses OK, Escape Cancel; other keys go to the focused list. */
  override tsOnKeyDown(key: string): boolean {
    if (key === "Enter" || key === "Escape") {
      const b = key === "Enter" ? this.okBtn : this.cancelBtn;
      if (b) this.tsOnCommand(b.id, b);
      return true;
    }
    const focus = winMgr.getFocus();
    if (focus && focus !== this && (focus === this.familyList || focus === this.memberList)) return focus.tsOnKeyDown(key);
    return false;
  }

  /** CWinPhoneBook::TSOnCommand */
  override tsOnCommand(cmd: number, source: TSWin): boolean {
    if (cmd === CMD_LIST_DOUBLE_CLICK && (source === this.familyList || source === this.memberList)) {
      if (this.okBtn) this.tsOnCommand(this.okBtn.id, this.okBtn);
      return true;
    }
    if (source === this.okBtn) {
      this.tsEndDialog(0);
      return true;
    }
    if (source === this.cancelBtn) {
      this.tsEndDialog(0);
      this.cancelled = true;
      return true;
    }
    if (cmd === CMD_LIST_SELECT && (source === this.familyList || source === this.memberList)) {
      this.onListSelect();
      return true;
    }
    return super.tsOnCommand(cmd, source);
  }

  /** TSOnCommand's 0x15 branch. */
  private onListSelect(): void {
    const families = this.familyList!;
    const members = this.memberList!;
    const sel = families.getSelection();
    if (sel === this.familyIndex) {
      this.memberIndex = members.getSelection();
      this.setIconToNeighbor();
    } else {
      this.familyIndex = sel;
      this.fillFamilyMembers();
      if (members.size() !== 0) members.select(0);
    }
    if (this.familyIndex >= 0 && this.memberIndex >= 0 && this.label) {
      const text =
        this.ctx.strings.get("UIText", STRINGS, STR_CALL - 1) +
        SPACE +
        members.get(this.memberIndex) +
        SPACE +
        families.get(this.familyIndex) +
        PERIOD;
      this.label.setCaption(text);
      this.label.setAlignment(0);
    }
  }

  /** CWinPhoneBook::TSPaint */
  override tsPaint(g: Gfx): void {
    const W = this.getW();
    const H = this.getH();
    const frame = this.frame;
    if (frame) bltEdge(g, frame, Math.trunc(frame.width / 3), Math.trunc(frame.height / 3), W, H, true);
    if (this.background) g.blit(this.background, BKG_POS.x, BKG_POS.y);
    const icon = this.icon;
    const cancel = this.cancelBtn;
    if (icon && cancel) {
      const x = Math.trunc((W - 0x17) / 2);
      const y = H - Math.trunc((cancel.getH() * 3) / 2) + 5;
      g.blit(icon, x, y);
    }
    if (this.face) g.blitPart(this.face, 0, 0, FACE_SIZE, FACE_SIZE, FACE_POS, FACE_POS);
  }
}
