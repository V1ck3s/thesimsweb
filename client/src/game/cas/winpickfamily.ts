/**
 * cWinPickFamily: "Sélectionner une famille", the families without a house
 * (Move In from the neighborhood), with cPickFamilyList / cPickFamilyItem.
 *
 * From the decompiled classes (WinPickFamily.cpp, PickFamilyList.cpp,
 * PickFamilyItem.cpp):
 *  - cWinPickFamily::Init: kPickFamilyBkg centered, the dialog color
 *    around; the list at lbl_105BC768 = (0x29, 0x4c) (tooltip STR# 128
 *    entry 16); the title (entry 8, size 16 font); CreateButton for
 *    "new family" (5103), "move in" (5106), "delete" (5105) at
 *    lbl_105BC770 = (0x142, 0x212), (0x1fa, 0x212), (0x19e, 0x212)
 *    (tooltips entries 2..4) and Cancel, a kNghDefaultBtn cTSSystemButton
 *    200 px wide centered on (200, 0x211) (caption entry 5, tooltip 15);
 *    the column icons' tooltips (entries 10, 11) on 26 x 23 windows at
 *    (0x24a, 0x2a) and (0x296, 0x2a); move in / delete start disabled;
 *  - TSOnCommand: 1 = a button (HandleButton), 0x15 = selection changed
 *    (move in / delete enabled with a selection), 0x1a = double click on a
 *    family (move in), 0x1e = a family was created (AddNewFamily),
 *    0x21 = click on an empty row (new family);
 *  - HandleButton: 0 runs cWinDesignFamily modally in this window's area
 *    (this one hidden meanwhile); 1 posts {3, 0x20, family} to the owner
 *    (cWinNeighborhoodUL: Move In mode) and closes; 2 asks (entries 6 / 7,
 *    OK / Cancel) and deletes the family (RemoveFamily); 3 closes;
 *  - cPickFamilyList: one item per unhoused family (GetUnhousedFamilies),
 *    six rows shown, kPickScrollbar when there are more, the empty rows
 *    drawn with the item background's first frame; selecting posts 0x15;
 *    a new family is inserted first and selected;
 *  - cPickFamilyItem: kPickFamilyItemBkg (3 frames: normal, hover,
 *    selected), the family name (size 12 font at (0x14, 0)), net worth
 *    (budget + house value, size 10, at (0x20e, 0x15)) and friend count
 *    ("%d" at (0x26c, 0x15)), colored UI_FONT_COLOR / white (hover) /
 *    cyan (selected); up to 8 member portraits (45 px wide) from
 *    lbl_105BC6BC = (0x6e, 0xe) every 0x30 px.
 *
 *  - cPickFamilyItemMember::GetToolTipsWindow: one shared
 *    cPickFamilyPersonInfo (lbl_105BAB50) set to the member (cas/personinfo.ts);
 *  - cPickFamilyList::ScrollTo: a RampGenerator from the current (possibly
 *    fractional) row to the new one at 0.001 * clamp(5.0909 * rows - 1.0909,
 *    4, 60) rows per ms (lbl_105BC6D0); TSPaint takes the nearest row as the
 *    top row and offsets the items by the remainder (TileItems +0x100);
 *  - first-run hint: Init subscribes a 500 ms timer once per session when
 *    cOptionsMgr::GetRunCount() < 2; TSOnTimerMsg shows MessageDialog(entry
 *    14, title 13) ("Créer une famille ?").
 *
 *  - Shift smiley: cPickFamilyItem::Init loads kPickFamilySmiley into the
 *    shared lbl_105BAB68 when Shift is down (GetKeyState(VK_SHIFT) < 0) and
 *    clears it otherwise; TSPaint draws it at lbl_105BC6C8 = (0x291, 0x13).
 *
 *  - Magic Town move in (+0x141, set by cWinMagicland; copied to the list
 *    +0xcc and the items +0x1e4): background 0x13b3 instead of
 *    kPickFamilyBkg (0x13b1); the items show the family's MagiCoins
 *    (Family::GetMagiCoins: the members' SimInventory tokens of type 7, GUID
 *    0x99e81bec) as "%d" at lbl_105BC6B0 = (0x289, 0x15), net worth and
 *    friends move to lbl_105BC6B8 = (0x1ee, 0x15) and lbl_105BC6AC =
 *    (0x25e, 0x15); the column tips move left by 23 and 25 px and a third one
 *    (entry 18) sits at (0x2b2, 0x2a); its own hint (lbl_105C14A9, entries 19
 *    / 20) while GetRunPAFMagicCount() < 6.
 *
 *  - cPickFamilyList::GetTTPosition: the list's tooltip is placed at the
 *    cursor (cTSMainWindowW95 +0xd8 / +0xdc, stored on every mouse move), its
 *    bottom 2 px above it, whether or not it follows the cursor.
 *
 * Not ported: the preselection of +0x130 (Init calls
 * cPickFamilyList::SetSelected when it is not -1). cWinNeighborhoodUL,
 * cWinNeighborhoodVC and cWinMagicland copy their lot into it only when their
 * mode (+0xcc) is 1, but they test it right after SetMode(0) (asm
 * 0x1045FAF0..0x1045FB5C), so it stays -1 and the call never runs.
 */

import type { GameContext } from "../context.js";
import { buildPersonBtn } from "../cpanel/live/peoplebuttons.js";
import type { NeighborhoodStore } from "../data/nbhdstore.js";
import { loadCharacter, loadNeighborhood, type NeighborhoodData } from "../data/neighborhood.js";
import { makeMoneyString } from "../nbhd/nghinterface.js";
import { decodeImage } from "../res/bmp.js";
import { getOptionsMgr } from "../optionsmgr.js";
import type { FfnFont } from "../res/ffn.js";
import { UI_LANGUAGE } from "../res/uires.js";
import { TSWinBtn } from "../ui/btn.js";
import { TSWinCtrlMgr } from "../ui/ctrlmgr.js";
import { GENDLG_FILL, TSWinGenDlg } from "../ui/gendlg.js";
import { IDOK, MB_OK, MB_OKCANCEL, TSWinMsgBox } from "../ui/msgbox.js";
import { CMD_SLIDER_CHANGED, SLIDER_VERTICAL } from "../ui/slider.js";
import { rgb, UI_FONT_COLOR } from "../ui/syscolors.js";
import { TSSystemButton } from "../ui/systembutton.js";
import { TSWinScrollbar } from "../ui/scrollbar.js";
import { TSWinText } from "../ui/text.js";
import { Gfx, TSWin } from "../ui/tswin.js";
import { winMgr, type ToolTipWindow, type ToolTipsWindowSource, type TTPositionSource } from "../ui/winmgr.js";
import { CasSession } from "./personfinder.js";
import { PickFamilyPersonInfo, type PersonInfoData } from "./personinfo.js";
import { WinDesignFamily } from "./windesignfamily.js";

const STRINGS = 128;
const S = {
  firstButton: 2,
  deleteTitle: 6,
  deleteMessage: 7,
  title: 8,
  hintTitle: 13,
  hintMessage: 14,
  coinsTip: 17,
  magicHintTitle: 18,
  magicHintMessage: 19,
  netWorthTip: 10,
  friendsTip: 11,
  cancelTip: 15,
  listTip: 16,
} as const;

/** Commands (TSOnCommand jump table lbl_105BC774). */
const CMD_SELECTION = 0x15;
const CMD_DOUBLE_CLICK = 0x1a;
const CMD_EMPTY_ROW = 0x21;

/** lbl_105BC76C / lbl_105BC770 */
const BUTTONS = [
  { image: 5103, x: 0x142, y: 0x212 },
  { image: 5106, x: 0x1fa, y: 0x212 },
  { image: 5105, x: 0x19e, y: 0x212 },
  { image: 0, x: 200, y: 0x211 },
];
const B = { create: 0, moveIn: 1, delete: 2, cancel: 3 } as const;
const BUTTON_ID_BASE = 0x5200;
/** lbl_105BC768 */
const LIST = { x: 0x29, y: 0x4c };
const ROWS = 6;
/** lbl_105BC6BC / lbl_105BC6C0 / lbl_105BC6B4 / lbl_105BC6A8 */
const ITEM_MEMBERS = { x: 0x6e, y: 0xe, step: 0x30 };
const ITEM_NAME = { x: 0x14, y: 0 };
const ITEM_WORTH = { x: 0x20e, y: 0x15 };
const ITEM_FRIENDS = { x: 0x26c, y: 0x15 };
/** lbl_105BC6B8 / lbl_105BC6AC / lbl_105BC6B0: the Magic Town columns. */
const ITEM_WORTH_MAGIC = { x: 0x1ee, y: 0x15 };
const ITEM_FRIENDS_MAGIC = { x: 0x25e, y: 0x15 };
const ITEM_COINS = { x: 0x289, y: 0x15 };
/** Family::GetMagiCoins: SimInventory::FindToken(7, magicoin GUID). */
const MAGICOIN_TOKEN = { type: 7, guid: 0x99e81bec };
const MEMBER_W = 0x2d;
/** lbl_105BC6C8 */
const ITEM_SMILEY = { x: 0x291, y: 0x13 };
/** lbl_105BAB68: the smiley, shared by the items (set or cleared by each item's Init). */
let smiley: ImageBitmap | null = null;
/** lbl_105BA6F8 / lbl_105BA928 / lbl_105BA954 */
const TEXT_COLORS = [UI_FONT_COLOR, rgb(0xff, 0xff, 0xff), rgb(0, 0xff, 0xff)];
const DLG_FILL = rgb(0, 0x32, 0);
const DOUBLE_CLICK_MS = 500;
/** lbl_105BC6D0: ScrollTo speed (a, b, min, max, scale) and TSPaint rounding. */
const SCROLL = { a: -1.0909091, b: 5.090909, min: 4, max: 60, scale: 0.001, round: 0.5 };
/** Init: the first-run hint timer. */
const HINT_DELAY_MS = 500;
/** lbl_105C14AA: the hint was already scheduled this session; lbl_105C14A9: the Magic Town one. */
let hintScheduled = false;
let magicHintScheduled = false;

/** RampGenerator with SetupConstantSpeedRamp / GetVal. */
class RampGenerator {
  private target = 0;
  private speed = 0;
  private end = 0;

  constructor(value: number) {
    this.target = value;
  }

  setupConstantSpeedRamp(from: number, to: number, speed: number, now: number): void {
    this.target = to;
    const s = to - from <= 0 ? -Math.abs(speed) : Math.abs(speed);
    this.speed = s;
    this.end = now + (s === 0 ? 0 : (to - from) / s);
  }

  getVal(now: number): number {
    if (this.end <= now) return this.target;
    return this.target - (this.end - now) * this.speed;
  }

  isDone(now: number): boolean {
    return this.end <= now;
  }
}

/** Who is told which family moves in ({3, 0x20, family} to +0x12c). */
export interface PickFamilyOwner {
  moveIn(familyId: number): void;
}

interface FamilyRow {
  id: number;
  name: string;
  netWorth: number;
  friends: number;
  /** GetFamilyInfo +0x10: Family::GetMagiCoins. */
  magicoins: number;
  faces: Array<ImageBitmap | null>;
  /** PersonFinder data of each member, for the tooltip. */
  people: PersonInfoData[];
}

async function familyRow(store: NeighborhoodStore, n: NeighborhoodData, id: number): Promise<FamilyRow | null> {
  const f = store.family(id);
  if (!f) return null;
  const people: PersonInfoData[] = [];
  const faces = await Promise.all(
    f.memberGuids.map(async (guid, i) => {
      const nb = n.neighbors.find((x) => x.guid >>> 0 === guid >>> 0);
      const c = nb ? await loadCharacter(n.dir, nb.name).catch(() => null) : null;
      people[i] = { name: c?.firstName ?? nb?.name ?? "", bio: c?.bio ?? "", personData: store.getPersonData(guid) };
      const bytes = c?.bitmaps.get(2002);
      if (!bytes) return null;
      const img = decodeImage(bytes, "face.bmp", { colorKey: true });
      return createImageBitmap(new ImageData(img.data, img.width, img.height));
    }),
  );
  let magicoins = 0;
  for (const guid of f.memberGuids) {
    const nb = n.neighbors.find((x) => x.guid >>> 0 === guid >>> 0);
    const inv = nb ? n.inventories.find((v) => v.neighborId === nb.id) : undefined;
    const t = inv?.tokens.find((x) => x.type === MAGICOIN_TOKEN.type && x.guid >>> 0 === MAGICOIN_TOKEN.guid);
    magicoins += t?.count ?? 0;
  }
  // Family::GetMagiCoins adds them as shorts.
  magicoins = (magicoins << 16) >> 16;
  return { id, name: f.name, netWorth: f.budget + f.netWorth, friends: f.friends, magicoins, faces, people };
}

/** cPickFamilyItemMember: a portrait (4 x 3 cells of 45 px), drawn (rowH - 45) / 2 - 5 px down. */
class PickFamilyItemMember extends TSWinBtn implements ToolTipsWindowSource {
  constructor(
    image: ImageBitmap,
    private readonly rowH: number,
    private readonly person: PersonInfoData | undefined,
    private readonly info: PickFamilyPersonInfo | null,
  ) {
    super(0, image, 4, 3);
    this.setArea(0, 0, MEMBER_W, rowH);
    // Any text: the window manager only asks windows that have a tooltip.
    this.tooltip = person?.name || " ";
  }

  /** cPickFamilyItemMember::GetToolTipsWindow */
  getToolTipsWindow(): ToolTipWindow | null {
    if (!this.info || !this.person) return null;
    this.info.setPerson(this.person);
    return this.info;
  }

  override tsPaint(g: Gfx): void {
    const img = this.image;
    if (!img) return;
    const cw = Math.trunc(img.width / 4);
    const ch = Math.trunc(img.height / 3);
    g.blitPart(img, this.frameColumn() * cw, 0, cw, ch, 0, Math.trunc((this.rowH - MEMBER_W) / 2) - 5);
  }
}

/** cPickFamilyItem */
class PickFamilyItem extends TSWinBtn {
  private readonly members: PickFamilyItemMember[] = [];
  private lastClick = -Infinity;

  constructor(
    readonly family: FamilyRow,
    private readonly bkg: ImageBitmap,
    private readonly template: ImageBitmap,
    private readonly fonts: { f10: FfnFont; f12: FfnFont },
    info: PickFamilyPersonInfo | null,
    /** +0x1e4: Magic Town move in. */
    private readonly magic = false,
  ) {
    super(0, bkg, 1, 3);
    this.mode = 1;
    const rowH = Math.trunc(bkg.height / 3);
    this.setArea(0, 0, bkg.width, rowH);
    family.faces.slice(0, 8).forEach((face, i) => {
      const b = new PickFamilyItemMember(buildPersonBtn(face, template), rowH, family.people[i], info);
      this.members.push(b);
      this.childAdd(b);
      // One row from lbl_105BC6BC, every 0x30 px (8 portraits fit in 0x180).
      b.moveTo(ITEM_MEMBERS.x + i * ITEM_MEMBERS.step, ITEM_MEMBERS.y);
    });
  }

  /** CalcRowCol: 2 selected, 1 hovered, 0 normal. */
  private frameRow(): number {
    return this.state ? 2 : this.entered ? 1 : 0;
  }

  override windowFromPoint(x: number, y: number): TSWin | null {
    // The member portraits only take the mouse once the family is selected (SetFlag(2, selected)).
    if (!this.state) return this.isVisible() && this.isPointInWindowWindowCoordinates(x, y) ? this : null;
    return super.windowFromPoint(x, y);
  }

  override tsOnMouseDownL(): boolean {
    const now = performance.now();
    const double = now - this.lastClick < DOUBLE_CLICK_MS;
    this.lastClick = double ? -Infinity : now;
    if (double && this.state) {
      this.parent?.tsOnCommand(CMD_DOUBLE_CLICK, this);
      return true;
    }
    this.state = 1;
    this.parent?.tsOnCommand(1, this);
    return true;
  }

  override tsOnMouseUpL(): boolean {
    return true;
  }

  override tsPaint(g: Gfx): void {
    const rowH = this.getH();
    g.blitPart(this.bkg, 0, this.frameRow() * rowH, this.bkg.width, rowH, 0, 0);
    const color = TEXT_COLORS[this.frameRow()]!;
    const { f10, f12 } = this.fonts;
    f12.drawText(g.ctx, this.family.name, g.ox + ITEM_NAME.x, g.oy + ITEM_NAME.y, color);
    const worth = makeMoneyString(this.family.netWorth, UI_LANGUAGE);
    const worthAt = this.magic ? ITEM_WORTH_MAGIC : ITEM_WORTH;
    const friendsAt = this.magic ? ITEM_FRIENDS_MAGIC : ITEM_FRIENDS;
    // Alignment 3: right-aligned on the column position.
    f10.drawText(g.ctx, worth, g.ox + worthAt.x - f10.stringWidth(worth), g.oy + worthAt.y, color);
    const friends = String(this.family.friends);
    f10.drawText(g.ctx, friends, g.ox + friendsAt.x - f10.stringWidth(friends), g.oy + friendsAt.y, color);
    if (this.magic) {
      // +0x1dc: hidden outside Magic Town.
      const coins = String(this.family.magicoins);
      f10.drawText(g.ctx, coins, g.ox + ITEM_COINS.x - f10.stringWidth(coins), g.oy + ITEM_COINS.y, color);
    }
    if (smiley) g.blit(smiley, ITEM_SMILEY.x, ITEM_SMILEY.y);
  }
}

/** cPickFamilyList */
class PickFamilyList extends TSWin implements TTPositionSource {
  readonly items: PickFamilyItem[] = [];
  /** +0x104: selected row, -1 for none. */
  selected = -1;
  /** +0xf8: first row shown. */
  private top = 0;
  private scrollbar: TSWinScrollbar | null = null;
  private itemH = 0x4b;
  private itemW = 700;
  /** +0x108 / +0x118: the scroll ramp (rows) and whether it runs. */
  private readonly ramp = new RampGenerator(0);
  private ramping = false;
  /** +0x100: pixel offset of the rows while scrolling. */
  private offset = 0;

  constructor(private readonly bkg: ImageBitmap) {
    super();
  }

  /**
   * cPickFamilyList::GetTTPosition: the tooltip's left edge on the cursor and
   * its bottom 2 px above it (the main window's last mouse move, +0xd8 / +0xdc).
   */
  getTTPosition(tt: TSWin): { x: number; y: number } {
    const p = winMgr.cursorPosition();
    return { x: p.x, y: p.y - (tt.getH() + 2) };
  }

  async build(scrollImage: ImageBitmap, rows: PickFamilyItem[]): Promise<void> {
    for (const it of rows) {
      this.items.push(it);
      this.childAdd(it);
    }
    if (this.items.length) {
      this.itemW = this.items[0]!.getW();
      this.itemH = this.items[0]!.getH();
    }
    const sb = new TSWinScrollbar();
    sb.setDirection(SLIDER_VERTICAL);
    sb.setArea(0, 0, 1, this.itemH * ROWS);
    sb.setImage(scrollImage);
    sb.setArea(this.itemW + 0x20, 0, this.itemW + 0x20 + sb.getW(), sb.getH());
    this.childAdd(sb);
    this.scrollbar = sb;
    this.setArea(this.area.left, this.area.top, this.area.left + this.itemW + 0x20 + sb.getW(), this.area.top + this.itemH * ROWS);
    this.syncScrollbar();
    this.tileItems();
  }

  private syncScrollbar(): void {
    const sb = this.scrollbar;
    if (!sb) return;
    if (this.items.length < 7) {
      sb.hideWindow();
      return;
    }
    sb.showWindow();
    sb.setMinimumValue(0);
    sb.setMaximumValue(this.items.length - ROWS);
    sb.setValue(this.top);
    sb.setPageSize(ROWS);
  }

  /** TileItems: one item per row from the top row, shifted by the scroll offset. */
  private tileItems(): void {
    this.items.forEach((it, i) => {
      const y = (i - this.top) * this.itemH + this.offset;
      it.moveTo(0, y);
      // The list clips its children (Plot); rows wholly outside are hidden.
      if (y + this.itemH > 0 && y < ROWS * this.itemH) it.showWindow();
      else it.hideWindow();
    });
  }

  /** Immediate positioning (SetTopRow): stops a running scroll. */
  private setTopRow(row: number): void {
    this.ramping = false;
    this.offset = 0;
    this.top = row;
    this.tileItems();
  }

  /** cPickFamilyList::ScrollTo */
  private scrollTo(row: number): void {
    const now = performance.now();
    const cur = this.ramping ? this.ramp.getVal(now) : this.top;
    this.ramping = true;
    let speed = SCROLL.b * Math.abs(cur - row) + SCROLL.a;
    speed = Math.min(SCROLL.max, Math.max(SCROLL.min, speed));
    this.ramp.setupConstantSpeedRamp(cur, row, SCROLL.scale * speed, now);
  }

  /** The ramp part of cPickFamilyList::TSPaint, run once per frame. */
  override pump(nowMs: number): void {
    if (this.ramping) {
      const now = performance.now();
      const val = this.ramp.getVal(now);
      let row = Math.trunc(SCROLL.round + val);
      let off = Math.trunc((val - row) * this.itemH + SCROLL.round);
      if (this.itemH <= off) {
        off = 0;
        row++;
      }
      this.offset = -off;
      this.top = row;
      this.tileItems();
      if (this.ramp.isDone(now)) this.ramping = false;
    }
    super.pump(nowMs);
  }

  override plot(ctx: CanvasRenderingContext2D, ox: number, oy: number): void {
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox + this.area.left, oy + this.area.top, this.getW(), this.getH());
    ctx.clip();
    super.plot(ctx, ox, oy);
    ctx.restore();
  }

  override windowFromPoint(x: number, y: number): TSWin | null {
    if (x < 0 || y < 0 || x >= this.getW() || y >= this.getH()) return null;
    return super.windowFromPoint(x, y);
  }

  selectedId(): number {
    return this.items[this.selected]?.family.id ?? -1;
  }

  private notify(): void {
    this.parent?.tsOnCommand(CMD_SELECTION, this);
  }

  /** AddItem: inserted first and selected. */
  addItem(it: PickFamilyItem): void {
    const prev = this.items[this.selected];
    if (prev) prev.setState(0);
    this.items.unshift(it);
    this.childAdd(it);
    this.selected = 0;
    it.setState(1);
    this.syncScrollbar();
    this.setTopRow(0);
    this.notify();
  }

  /** DeleteSelection (RemoveFamily is done by the caller). */
  deleteSelection(): PickFamilyItem | null {
    const it = this.items[this.selected];
    if (!it) return null;
    this.items.splice(this.selected, 1);
    this.childRemove(it);
    this.selected = -1;
    this.notify();
    let top = this.top;
    if (this.items.length > 6 && this.items.length - 6 <= top) top--;
    if (this.items.length < 7) top = 0;
    this.top = top;
    this.syncScrollbar();
    this.setTopRow(top);
    return it;
  }

  override tsOnMouseDownL(): boolean {
    this.parent?.tsOnCommand(CMD_EMPTY_ROW, this);
    return true;
  }

  override tsOnCommand(cmd: number, source: TSWin): boolean {
    if (cmd === CMD_SLIDER_CHANGED && source === this.scrollbar) {
      this.scrollTo(this.scrollbar.getValue());
      return true;
    }
    if (cmd === 1 && source instanceof PickFamilyItem) {
      const i = this.items.indexOf(source);
      if (i >= 0 && i !== this.selected) {
        this.items[this.selected]?.setState(0);
        this.selected = i;
      }
      this.notify();
      return true;
    }
    return super.tsOnCommand(cmd, source);
  }

  override tsPaint(g: Gfx): void {
    // The empty rows below the last item: the background's first frame.
    const shown = this.items.length - this.top;
    if (shown >= ROWS) return;
    const rowH = Math.trunc(this.bkg.height / 3);
    const dy = this.ramping ? this.offset : 0;
    for (let r = Math.max(0, shown); r < ROWS; r++) g.blitPart(this.bkg, 0, 0, this.bkg.width, rowH, 0, r * rowH + dy);
  }
}

export class WinPickFamily extends TSWinGenDlg {
  private owner: PickFamilyOwner | null = null;
  private bkg: ImageBitmap | null = null;
  private offX = 0;
  private offY = 0;
  private list: PickFamilyList | null = null;
  private readonly buttons: TSWinBtn[] = [];
  private store: NeighborhoodStore | null = null;
  private itemBkg: ImageBitmap | null = null;
  /** kPickFamilySmiley (0x139d), loaded once; lbl_105BAB68 points to it while Shift is down. */
  private smileyImg: ImageBitmap | null = null;
  private template: ImageBitmap | null = null;
  private fonts: { f10: FfnFont; f12: FfnFont } | null = null;
  /** lbl_105BAB50: the members' tooltip window. */
  private personInfo: PickFamilyPersonInfo | null = null;
  private hintTimer = 0;
  /** +0x140: a button is being handled. */
  private busy = false;
  /** +0x141: Magic Town move in (set before init). */
  magicTown = false;

  constructor(
    ctx: GameContext,
    private readonly dir: string,
  ) {
    super(ctx, GENDLG_FILL);
  }

  setOwner(o: PickFamilyOwner): void {
    this.owner = o;
  }

  private str(i: number): string {
    return this.ctx.strings.get("UIText", STRINGS, i);
  }

  override async init(): Promise<boolean> {
    const { ctx } = this;
    const { NeighborhoodStore } = await import("../data/nbhdstore.js");
    this.store = await NeighborhoodStore.open(this.dir);
    this.fillColor = DLG_FILL;
    const sysImage = await ctx.res.image("kNghDefaultBtn");
    this.bkg = await ctx.res.image(this.magicTown ? 0x13b3 : "kPickFamilyBkg");
    this.offX = this.bkg.width < this.getW() ? (this.getW() - this.bkg.width) >> 1 : 0;
    this.offY = this.bkg.height < this.getH() ? (this.getH() - this.bkg.height) >> 1 : 0;
    await super.init();
    const ox = this.offX;
    const oy = this.offY;
    const mgr = await TSWinCtrlMgr.get(ctx);
    this.itemBkg = await ctx.res.image("kPickFamilyItemBkg");
    this.smileyImg = await ctx.res.image("kPickFamilySmiley").catch(() => null);
    this.template = await ctx.res.image("kPeopleTemplate");
    this.fonts = { f10: await ctx.fonts.acquire(10), f12: await ctx.fonts.acquire(12) };
    this.personInfo = await PickFamilyPersonInfo.create(ctx).catch(() => null);
    const f16 = await ctx.fonts.acquire(16);

    const list = new PickFamilyList(this.itemBkg);
    list.moveTo(LIST.x + ox, LIST.y + oy);
    list.tooltip = this.str(S.listTip);
    const n = await loadNeighborhood(this.dir);
    const rows = await Promise.all(this.store.unhousedFamilies().map((id) => familyRow(this.store!, n, id)));
    await list.build(
      await ctx.res.image("kPickScrollbar"),
      rows.filter((r): r is FamilyRow => !!r).map((r) => this.makeItem(r)),
    );
    this.childAdd(list);
    this.list = list;

    const title = new TSWinText();
    title.setFont(f16);
    title.setArea(0, oy + 6, this.getW(), f16.height + 6 + oy);
    title.setCaption(this.str(S.title));
    title.setAlignment(2);
    title.setBackgroundOpaque(false);
    this.childAdd(title);

    for (let i = 0; i < BUTTONS.length; i++) {
      const def = BUTTONS[i]!;
      const caption = this.str(S.firstButton + i);
      let b: TSWinBtn;
      if (i === B.cancel) {
        const s = new TSSystemButton(mgr, sysImage);
        s.setArea(s.area.left, s.area.top, s.area.left + 200, s.area.top + sysImage.height);
        const cx = def.x + ox;
        const cy = def.y + oy + (sysImage.height >> 1);
        const left = cx - (s.getW() >> 1);
        const top = cy - (s.getH() >> 1);
        s.setArea(left, top, left + s.getW(), top + s.getH());
        s.setCaption(caption);
        s.tooltip = this.str(S.cancelTip);
        b = s;
      } else {
        const img = await ctx.res.image(def.image);
        b = new TSWinBtn(0, img, 4, 1);
        b.setArea(0, 0, Math.trunc(img.width / 4), img.height);
        b.moveTo(def.x + ox, def.y + oy);
        b.tooltip = caption;
      }
      b.id = BUTTON_ID_BASE + i;
      this.childAdd(b);
      this.buttons.push(b);
    }
    const magic = this.magicTown;
    for (const [x, tip] of [
      [0x24a - (magic ? 23 : 0), S.netWorthTip],
      [0x296 - (magic ? 25 : 0), S.friendsTip],
      ...(magic ? ([[0x2b2, S.coinsTip]] as const) : []),
    ] as const) {
      const w = new TSWin();
      w.setArea(x + ox, 0x2a + oy, x + ox + 0x1a, 0x2a + oy + 0x17);
      w.tooltip = this.str(tip);
      this.childAdd(w);
    }
    this.buttons[B.moveIn]!.enabled = false;
    this.buttons[B.delete]!.enabled = false;
    if (!hintScheduled && !magic) {
      hintScheduled = true;
      if (getOptionsMgr().getRunCount() < 2) this.hintTimer = window.setTimeout(() => void this.tsOnTimerMsg(), HINT_DELAY_MS);
    }
    if (!magicHintScheduled && magic) {
      magicHintScheduled = true;
      if (getOptionsMgr().getRunPAFMagicCount() < 6) this.hintTimer = window.setTimeout(() => void this.tsOnTimerMsg(), HINT_DELAY_MS);
    }
    return true;
  }

  /** cWinPickFamily::TSOnTimerMsg: the first-run hint. */
  private async tsOnTimerMsg(): Promise<void> {
    this.hintTimer = 0;
    const [text, title] = this.magicTown ? [S.magicHintMessage, S.magicHintTitle] : [S.hintMessage, S.hintTitle];
    await TSWinMsgBox.show(this.ctx, this.str(text), this.str(title), MB_OK);
  }

  override tsEndDialog(result: number): void {
    // Shutdown: UnsubscribeTimerMsg.
    if (this.hintTimer) window.clearTimeout(this.hintTimer);
    this.hintTimer = 0;
    super.tsEndDialog(result);
  }

  private makeItem(r: FamilyRow): PickFamilyItem {
    // cPickFamilyItem::Init: the smiley only while Shift is held.
    smiley = winMgr.isKeyDown("Shift") ? this.smileyImg : null;
    return new PickFamilyItem(r, this.itemBkg!, this.template!, this.fonts!, this.personInfo, this.magicTown);
  }

  /** cWinPickFamily::HandleButton */
  private async handleButton(i: number): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const list = this.list;
      const store = this.store;
      if (!list || !store) return;
      if (i === B.delete) {
        const item = list.items[list.selected];
        if (!item) return;
        const r = await TSWinMsgBox.show(this.ctx, this.str(S.deleteMessage).replace("%s", item.family.name), this.str(S.deleteTitle), MB_OKCANCEL);
        if (r === IDOK) {
          list.deleteSelection();
          await store.removeFamily(item.family.id);
        }
      } else if (i === B.create) {
        // The design screens edit the same neighborhood file through their own store.
        const session = new CasSession(store, this.ctx.res);
        const dlg = new WinDesignFamily(this.ctx, session);
        this.hideWindow();
        dlg.setArea(this.area.left, this.area.top, this.area.right, this.area.bottom);
        dlg.setMessageTarget({ familyDesigned: (id) => void this.familyDesigned(id) });
        if (await dlg.init()) await winMgr.doModalWin(dlg, this.parent ?? undefined);
        this.showWindow();
        winMgr.setFocus(this);
      } else if (i === B.moveIn) {
        const id = list.selectedId();
        if (id === -1) return;
        this.owner?.moveIn(id);
        this.tsEndDialog(1);
      } else {
        this.tsEndDialog(0);
      }
    } finally {
      this.busy = false;
    }
  }

  /** Command 0x1e: AddNewFamily */
  private async familyDesigned(id: number): Promise<void> {
    if (!this.list || !this.store) return;
    const n = await loadNeighborhood(this.dir);
    const r = await familyRow(this.store, n, id);
    if (r) this.list.addItem(this.makeItem(r));
  }

  override tsOnCommand(cmd: number, source: TSWin): boolean {
    if (cmd === CMD_SELECTION) {
      const on = (this.list?.selected ?? -1) !== -1;
      this.buttons[B.moveIn]!.enabled = on;
      this.buttons[B.delete]!.enabled = on;
      return true;
    }
    if (cmd === CMD_DOUBLE_CLICK) {
      void this.handleButton(B.moveIn);
      return true;
    }
    if (cmd === CMD_EMPTY_ROW) {
      void this.handleButton(B.create);
      return true;
    }
    const i = this.buttons.indexOf(source as TSWinBtn);
    if (i >= 0) void this.handleButton(i);
    return true;
  }

  override tsOnKeyDown(key: string): boolean {
    if (key !== "Escape") return false;
    void this.handleButton(B.cancel);
    return true;
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
