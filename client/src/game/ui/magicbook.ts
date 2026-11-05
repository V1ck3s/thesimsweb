/**
 * CWinMagicBook: the Makin' Magic spell book ("Read", TryDialog kind 0xc)
 * and cookbook (kind 0xf), run modally for a person.
 *
 * From the decompiled class (and its cPickSpellList):
 *  - the mode (lbl_105BB578): 2 cookbook, 0 a child's book (person data 58
 *    in 1..17), 1 an adult's spell book; the list holds 0x16 entries for
 *    spells, 9 otherwise;
 *  - strings of GameData/magic.iff: STR# 1 (1 "%s family spell book", 2
 *    "%s cookbook", 3 Back, 4 Next, 5 "Page %d of %d"), 0xc / 8 spell
 *    titles / descriptions, 0xd / 9 kid charms, 0xe / 10 recipes;
 *  - strings of the Magic Controller's file (LoadMagicStrings, GUID
 *    0xb6c90029, LoadOnlyEnglish): STR# 0xf and 0x10 the spell and kid
 *    charm ids in list order, 3 / 4 / 5 the ingredients, 7 their GUIDs;
 *  - Init: 600 x 0x17e, centered on the main window raised by 100 px; Close
 *    (DefaultPushBtn, cTSWinMsgBox::GetButtonLabel(1)) at (W - w - 20,
 *    H - 1.5 h); Back at (0x31, same), Next at (3 w, same), the page label
 *    (as wide as Next, one line of font 12) at (2 w, same); the header
 *    ("%s family ..." with the family's name, two lines, 0xf0 wide) at
 *    (0x31, 8); the list (fill 0x79 0x70 0x6e) at (0x31, 0x36), 0xf0 x
 *    0x10e; the entry title (0xf0 wide, one line) at (0x14b, 8) and its
 *    description (cTSWinTextEdit2, font table entry 8, read-only) at
 *    (0x14b, 0x36), 0xf0 x 0x10e (lbl_105BD26C .. 280, __sinit_WinMagicbook);
 *  - cPickSpellList::Init: the ids (spells: atoi of STR# 0xf entries,
 *    entry 12 skipped; kids: STR# 0x10; cookbook: 1..9), four per page
 *    (cPickSpellItem buttons on kPickSpellItemBkg), the first selected;
 *    TabDown / TabUp change page (Back / Next), a click selects;
 *  - UpdateDescription: the selected entry's title and description; a
 *    spell or charm the family has not made yet ("Magic - Has Made
 *    Spell/Recipe?" run on the person with (kind, id) is false) shows the
 *    mystery texts (entry 1, or 0x19 for ids >= 0xc); then the page label;
 *    the picture (kMagicBookKid / Charm / Spell / Oven / Nectar: kid,
 *    spells < 0xc, others, recipes >= 5, < 5) is drawn at (W - 0xb4,
 *    H - 0x96);
 *  - TSOnKeyDown: Escape closes; a 400 s timer closes the book.
 *
 *  - cPickSpellItem (one per row, a cTSWinBtn on kPickSpellItemBkg, 1
 *    column x 3 rows; Init: +0xec = 1 (the command on press), +0xf0 = 1
 *    (toggle); Windows 004ebd1d, Mac 10580680): CalcRowCol picks row 2 when
 *    selected, 1 while the mouse is over it (the white outline), else 0, and
 *    enables the ingredient buttons only on the selected row (SetFlag(2)).
 *    SetSpellID reads the entry's three ingredients ("%d,%d,%d", entry id + 1
 *    of STR# 3 spells / 4 kid charms / 5 recipes of the Magic Controller's
 *    file, GUID 0xb6c90029, LoadMagicStrings / LoadOnlyEnglish) and each
 *    ingredient's GUID (STR# 7, "%x"); each ingredient is a 45-wide button,
 *    as high as a row, tiled from (0x20, 6) (lbl_105BD264, Windows
 *    DAT_006f26a0 = 0x20 / 6) every 0x44 px, image offset (0, (row height -
 *    0x2d) / 2 - 5), showing Product::ComposeBtnImage of the ingredient's
 *    product, or kCatalogTemplate1Frame without one, with the catalog name as
 *    tooltip ("ingredient ?" when the GUID is unknown). The ingredient
 *    buttons do not select their row (cPickSpellItem::TSOnCommand only
 *    forwards 0x1a).
 *  - cPickSpellList::TSPaint (Windows 004ecbce): with fewer than 4 items on
 *    the page, kMagicBookBkg (the book's +0x120) cut at the list's area is
 *    drawn at (3, 10) in the list, then frame 0 of kPickSpellItemBkg in each
 *    empty row; the list's private buffer is transparent elsewhere.
 *
 *  - the list's filters (cPickSpellList::Init, flags of cSimsApp +0x66 =
 *    the installed-pack mask, ObjectFolder.packs): spell id 0x16 only with
 *    bit 0x20 (Unleashed), spell id 10 only with bit 0x40 (Superstar),
 *    recipe 7 only with bit 0x20; recipe 9 is dropped when the list's +0xe4
 *    is set and recipe 4 when +0xe5 is set. CWinMagicBook::Init sets them
 *    before the list is added: +0xe4 = "Has Made" run on the person with
 *    (3, 5) is false, +0xe5 = the same with (4, 4) is false.
 */

import { composeBtnImage, generateGraphics } from "../cpanel/buy/objecticon.js";
import type { GameContext } from "../context.js";
import { loadStringSet } from "../sim/behavior.js";
import { ObjectFolder } from "../world/objectfolder.js";
import type { FfnFont } from "../res/ffn.js";
import type { Simulator } from "../sim/simulator.js";
import type { SimObject } from "../sim/xobject.js";
import { BTN_TOGGLE, TSWinBtn } from "./btn.js";
import { TSWinCtrlMgr } from "./ctrlmgr.js";
import { bltEdge, TSWinDlg } from "./dlg.js";
import { TSSystemButton } from "./systembutton.js";
import { TSWinText, WTF_MULTILINE } from "./text.js";
import { Gfx, type TSWin } from "./tswin.js";
import { winMgr } from "./winmgr.js";
import { getCursor } from "./cursor.js";

const MAGIC = "magic";
const STR_UI = 1;
const STR_SPELL_DESC = 8;
const STR_KID_DESC = 9;
const STR_COOK_DESC = 10;
const STR_SPELL_TITLE = 0xc;
const STR_KID_TITLE = 0xd;
const STR_COOK_TITLE = 0xe;
/** UIText STR# 152: cSimsApp's button labels (GetButtonLabel(1): entry 1). */
const LABELS_STR = 152;
const CLOSE_LABEL_ENTRY = 1;
const HAS_MADE_TREE = "Magic - Has Made Spell/Recipe?";
const PER_PAGE = 4;
const TIMEOUT_MS = 400000;
/** Pictures by UpdateDescription's index: kid, charm, spell, oven, nectar. */
const PICTURES = ["kMagicBookKid", "kMagicBookCharm", "kMagicBookSpell", "kMagicBookOven", "kMagicBookNectar"];
/** LoadMagicStrings: the Magic Controller (MagicMasterSpells.iff) holds the ingredient tables. */
const GUID_MAGIC_CONTROLLER = 0xb6c90029;
const STR_SPELL_INGREDIENTS = 3;
const STR_KID_INGREDIENTS = 4;
const STR_COOK_INGREDIENTS = 5;
const STR_INGREDIENT_GUIDS = 7;
const STR_SPELL_IDS = 0xf;
const STR_KID_IDS = 0x10;
/** lbl_105BD268: the tooltip of an unknown ingredient. */
const UNKNOWN_INGREDIENT = "ingredient ?";
/** cPickSpellItem::Init: ingredient button width and step; lbl_105BD264: the first one's position. */
const INGREDIENT_W = 0x2d;
const INGREDIENT_STEP = 0x44;
const INGREDIENT_ORIGIN = { x: 0x20, y: 6 };
/** CWinMagicBook::Init: the list's position (lbl_105BD26C); cPickSpellList::TSPaint's background offset. */
const LIST_POS = { x: 0x31, y: 0x36 };
const LIST_BKG_OFFSET = { x: 3, y: 10 };
const INGREDIENTS = 3;
/** cSimsApp +0x66 bits tested by cPickSpellList::Init (ObjectFolder.packs: ExpansionPack5 / ExpansionPack6). */
const PACK_UNLEASHED = 0x20;
const PACK_SUPERSTAR = 0x40;
const ID_CLOSE = 1;
const ID_BACK = 2;
const ID_NEXT = 3;

enum Mode {
  Kid = 0,
  Spells = 1,
  Cook = 2,
}

export class CWinMagicBook extends TSWinDlg {
  private readonly mode: Mode;
  /** cPickSpellList +0xd8: the ids listed. */
  private ids: number[] = [];
  /** +0xcc page, +0x114 the selected item of the page. */
  private page = 0;
  private selected = 0;
  /** +0x134: UpdateDescription's picture index. */
  private picture = 0;
  private closeBtn: TSSystemButton | null = null;
  private backBtn: TSSystemButton | null = null;
  private nextBtn: TSSystemButton | null = null;
  private pageLabel: TSWinText | null = null;
  private entryTitle: TSWinText | null = null;
  private description: TSWinText | null = null;
  private items: PickSpellItem[] = [];
  /** The ingredient buttons of each item (cPickSpellItem +0x18c). */
  private ingredientBtns: IngredientBtn[] = [];
  /** cPickSpellItem +0x1b8 / +0x224 / +0x290 / +0x2fc and cPickSpellList +0x118 / +0x184: STR# 3, 4, 5, 7, 0xf and 0x10 of the Magic Controller. */
  private magicStrings = new Map<number, string[]>();
  /** Ingredient GUID -> [ComposeBtnImage or kCatalogTemplate1Frame, tooltip]. */
  private readonly ingredientCache = new Map<number, Promise<[ImageBitmap | null, string]>>();
  private template: ImageBitmap | null = null;
  private template1: ImageBitmap | null = null;
  private frame: ImageBitmap | null = null;
  private pictures: Array<ImageBitmap | null> = [];
  private itemBkg: ImageBitmap | null = null;
  /** +0x120 (kMagicBookBkg), handed to the list (+0xf4). */
  private listBkg: ImageBitmap | null = null;
  private timer = 0;

  constructor(
    private readonly ctx: GameContext,
    private readonly sim: Simulator,
    /** +0x100 */
    private readonly person: SimObject,
    cookbook: boolean,
  ) {
    super();
    // CWinMagicBook::CWinMagicBook: SetCursor(GetCursor(0)).
    this.winCursor = getCursor(0);
    const age = person.person?.personData[58] ?? 0;
    this.mode = cookbook ? Mode.Cook : age !== 0 && age < 0x12 ? Mode.Kid : Mode.Spells;
  }

  private str(set: number, n: number): string {
    return this.ctx.strings.get(MAGIC, set, n - 1);
  }

  /** cSimsApp::DoSimsModalDialog, then the window is destroyed. */
  async run(): Promise<void> {
    if (!(await this.init())) return;
    this.timer = window.setTimeout(() => this.tsEndDialog(0), TIMEOUT_MS);
    try {
      await winMgr.doModalWin(this);
    } finally {
      window.clearTimeout(this.timer);
      this.shutdown();
    }
  }

  /** CWinMagicBook::Init */
  override async init(): Promise<boolean> {
    const ctx = this.ctx;
    await ctx.strings.load("GameData/magic.iff");
    const [mgr, frame, itemBkg, listBkg, titleFont, descFont, template, template1, ...pictures] = await Promise.all([
      TSWinCtrlMgr.get(ctx),
      ctx.res.image("kCatalogPopupBackTiles"),
      ctx.res.image("kPickSpellItemBkg").catch(() => null),
      ctx.res.image("kMagicBookBkg").catch(() => null),
      ctx.fonts.acquire(12),
      ctx.fonts.acquire(8),
      ctx.res.image("kCatalogTemplate").catch(() => null),
      ctx.res.image("kCatalogTemplate1Frame").catch(() => null),
      ...PICTURES.map((p) => ctx.res.image(p).catch(() => null)),
    ]);
    this.template = template;
    this.template1 = template1;
    await this.loadMagicStrings();
    this.frame = frame;
    this.itemBkg = itemBkg;
    this.listBkg = listBkg;
    this.pictures = pictures;
    const main = winMgr.main.area;
    this.setArea(0, 0, 600, 0x17e);
    this.centerWindowInRect({ left: main.left, top: main.top - 100, right: main.right, bottom: main.bottom - 100 });
    const W = this.getW();
    const H = this.getH();

    const close = TSSystemButton.defaultPushBtn(mgr, ID_CLOSE, ctx.strings.get("UIText", LABELS_STR, CLOSE_LABEL_ENTRY));
    close.moveTo(W - close.getW() - 20, H - Math.trunc((close.getH() * 3) / 2));
    this.childAdd(close);
    this.closeBtn = close;
    const next = TSSystemButton.defaultPushBtn(mgr, ID_NEXT, this.str(STR_UI, 4));
    next.moveTo(next.getW() * 3, H - Math.trunc((next.getH() * 3) / 2));
    this.childAdd(next);
    this.nextBtn = next;
    const back = TSSystemButton.defaultPushBtn(mgr, ID_BACK, this.str(STR_UI, 3));
    back.moveTo(0x31, H - Math.trunc((back.getH() * 3) / 2));
    this.childAdd(back);
    this.backBtn = back;
    const label = (font: FfnFont, x: number, y: number, w: number, h: number, multiline: boolean): TSWinText => {
      const t = new TSWinText();
      t.setFont(font);
      t.setBackgroundOpaque(false);
      t.setWinTextFlag(WTF_MULTILINE, multiline);
      t.setArea(x, y, x + w, y + h);
      this.childAdd(t);
      return t;
    };
    this.pageLabel = label(titleFont, next.getW() * 2, back.area.top, next.getW(), titleFont.height, false);
    this.pageLabel.setAlignment(1);

    // The header: "%s family spell book" / "%s cookbook" with the family's name.
    const fam = this.familyName();
    const header = this.str(STR_UI, this.mode === Mode.Cook ? 2 : 1).replace("%s", fam);
    label(titleFont, 0x31, 8, 0xf0, titleFont.height * 2, true).setCaption(header);
    this.entryTitle = label(titleFont, 0x14b, 8, 0xf0, titleFont.height, false);
    this.description = label(descFont, 0x14b, 0x36, 0xf0, 0x10e, true);

    // CWinMagicBook::Init: the two "Has Made" runs handed to the list (+0xe4 / +0xe5).
    const hide9 = !this.hasMade(3, 5);
    const hide4 = !this.hasMade(4, 4);
    const packs = this.installedPacks();
    this.ids = this.listIds(packs, hide9, hide4);
    this.tabDown();
    return true;
  }

  /** Family::GetName of the person's family (person data 61). */
  private familyName(): string {
    const n = this.person.person?.personData[61] ?? 0;
    return this.sim.module.nbhd?.families.find((f) => f.chunkId === n)?.name ?? "";
  }

  /** cSimsApp +0x66: the installed-pack mask (ObjectFolder.packs). */
  private installedPacks(): number {
    const folder = this.person.obj.selector.folder;
    return folder instanceof ObjectFolder ? folder.packs : 0;
  }

  /** cPickSpellList::Init's id list (`hide9` / `hide4`: the list's +0xe4 / +0xe5). */
  private listIds(packs: number, hide9: boolean, hide4: boolean): number[] {
    const out: number[] = [];
    const count = this.mode === Mode.Spells ? 0x16 : 9;
    for (let i = 1; i <= count; i++) {
      if (this.mode === Mode.Spells) {
        const id = this.magicId(STR_SPELL_IDS, i);
        if (i !== 0xc && (packs & PACK_UNLEASHED || id !== 0x16) && (packs & PACK_SUPERSTAR || id !== 10)) out.push(id);
      } else if (this.mode === Mode.Kid) {
        out.push(this.magicId(STR_KID_IDS, i));
      } else if ((packs & PACK_UNLEASHED || i !== 7) && (!hide9 || i !== 9) && (!hide4 || i !== 4)) {
        out.push(i);
      }
    }
    return out;
  }

  /** atoi of GetString(set, i + 1) on the Magic Controller's strings. */
  private magicId(set: number, i: number): number {
    return Number.parseInt(this.magicStrings.get(set)?.[i] ?? "", 10) || 0;
  }

  private get pages(): number {
    return Math.ceil(this.ids.length / PER_PAGE);
  }

  /** cPickSpellList::GetSelectedSpellID */
  private selectedId(): number {
    return this.ids[this.page * PER_PAGE + this.selected] ?? 1;
  }

  /** "Magic - Has Made Spell/Recipe?" run on the person with (kind, id) (cXObject::RunTree). */
  private hasMade(kind: number, id: number): boolean {
    const o = this.person;
    const tree = o.behavior.getTreeID(HAS_MADE_TREE);
    if (tree === 0) return false;
    try {
      return o.runCheckTree(o.behavior, o.id, tree, { src: [kind, id], at: 0 });
    } catch {
      return false;
    }
  }

  /** GetSpellTitle / GetKidCharmTitle / GetCookTitle and the matching descriptions. */
  private entryText(id: number, description: boolean): string {
    const set =
      this.mode === Mode.Spells
        ? description
          ? STR_SPELL_DESC
          : STR_SPELL_TITLE
        : this.mode === Mode.Kid
          ? description
            ? STR_KID_DESC
            : STR_KID_TITLE
          : description
            ? STR_COOK_DESC
            : STR_COOK_TITLE;
    const s = this.str(set, id + 1);
    const fallback = this.str(set, 1);
    if (this.mode !== Mode.Cook && !this.hasMade(this.mode === Mode.Kid ? 1 : 0, id)) {
      return this.mode === Mode.Spells && id >= 0xc ? this.str(set, 0x19) : fallback;
    }
    return s === "" ? fallback : s;
  }

  /** CWinMagicBook::UpdateDescription */
  private updateDescription(): void {
    const id = this.selectedId();
    this.entryTitle?.setCaption(this.entryText(id, false));
    this.description?.setCaption(this.entryText(id, true));
    if (this.mode === Mode.Spells) this.picture = id < 0xc ? 1 : 2;
    else if (this.mode === Mode.Kid) this.picture = 0;
    else this.picture = id < 5 ? 4 : 3;
    this.pageLabel?.setCaption(this.str(STR_UI, 5).replace("%d", String(this.page + 1)).replace("%d", String(this.pages)));
    this.items.forEach((b, i) => b.setSelected(i === this.selected));
  }

  /** LoadMagicStrings(3, 4, 5, 7, 0xf, 0x10): StringSetBase::LoadOnlyEnglish on the Magic Controller's file. */
  private async loadMagicStrings(): Promise<void> {
    const folder = this.person.obj.selector.folder;
    const sel = folder instanceof ObjectFolder ? await folder.getSelectorByGUID(GUID_MAGIC_CONTROLLER).catch(() => null) : null;
    if (!sel) return;
    for (const id of [STR_SPELL_INGREDIENTS, STR_KID_INGREDIENTS, STR_COOK_INGREDIENTS, STR_INGREDIENT_GUIDS, STR_SPELL_IDS, STR_KID_IDS]) {
      this.magicStrings.set(id, loadStringSet(sel.res, id) ?? []);
    }
  }

  /** GetSpellIngredients / GetKidIngredients / GetCookingIngredients: "%d,%d,%d" of entry id + 1. */
  private ingredients(id: number): number[] {
    const set = this.mode === Mode.Spells ? STR_SPELL_INGREDIENTS : this.mode === Mode.Kid ? STR_KID_INGREDIENTS : STR_COOK_INGREDIENTS;
    const s = this.magicStrings.get(set)?.[id] ?? "";
    return s.split(",", INGREDIENTS).map((v) => Number.parseInt(v, 10) || 0);
  }

  /** cPickSpellItem::GetIngredientGuid: "%x" of STR# 7 entry n + 1. */
  private ingredientGuid(n: number): number {
    return Number.parseInt(this.magicStrings.get(STR_INGREDIENT_GUIDS)?.[n] ?? "", 16) >>> 0 || 0;
  }

  /**
   * SetSpellID's picture and GetCatalogName's tooltip of one ingredient:
   * ObjectFolder::GetSelectorByGUID, then the selector's Product
   * (ComposeBtnImage, which runs GenerateGraphics) or kCatalogTemplate1Frame.
   */
  private ingredient(guid: number): Promise<[ImageBitmap | null, string]> {
    let p = this.ingredientCache.get(guid);
    if (!p) {
      p = (async (): Promise<[ImageBitmap | null, string]> => {
        const folder = this.person.obj.selector.folder;
        const sel = guid !== 0 && folder instanceof ObjectFolder ? await folder.getSelectorByGUID(guid).catch(() => null) : null;
        if (!sel) return [this.template1, UNKNOWN_INGREDIENT];
        // Catalog::Init makes a Product for every selector that is not a multi-tile part or a person.
        const hasProduct = !sel.getIsMultiTileSubObject() && !sel.getIsPerson();
        if (!hasProduct || !this.template) return [this.template1, sel.getCatalogName()];
        const picture = await generateGraphics(sel.res, sel.objdId, sel.objd.i16(0x52), sel.getHasGraphics(), this.template);
        // ComposeBtnImage fails without a product picture: SetSpellID then shows kCatalogTemplate1Frame.
        return [picture ? await composeBtnImage(this.template, picture) : this.template1, sel.getCatalogName()];
      })();
      this.ingredientCache.set(guid, p);
    }
    return p;
  }

  /** cPickSpellList::RefreshList: the page's items, tiled down the list area. */
  private refreshList(): void {
    for (const b of this.items) this.childDelete(b);
    this.items = [];
    this.ingredientBtns = [];
    const img = this.itemBkg;
    const rowH = this.rowHeight();
    const ids = this.ids.slice(this.page * PER_PAGE, (this.page + 1) * PER_PAGE);
    ids.forEach((id, i) => {
      const b = new PickSpellItem(0x100 + i, img);
      b.moveTo(LIST_POS.x, LIST_POS.y + i * rowH);
      this.childAdd(b);
      this.items.push(b);
      this.setSpellID(b, id, rowH);
    });
  }

  /** cPickSpellList +0x10c: kPickSpellItemBkg's height / 3. */
  private rowHeight(): number {
    return this.itemBkg ? Math.trunc(this.itemBkg.height / 3) : 0x44;
  }

  /** cPickSpellItem::Init's ingredient buttons (tiled from lbl_105BD264) + SetSpellID's pictures. */
  private setSpellID(item: PickSpellItem, id: number, rowH: number): void {
    this.ingredients(id).forEach((n, k) => {
      const btn = new IngredientBtn(Math.trunc((rowH - INGREDIENT_W) / 2) - 5);
      const x = INGREDIENT_ORIGIN.x + k * INGREDIENT_STEP;
      btn.setArea(x, INGREDIENT_ORIGIN.y, x + INGREDIENT_W, INGREDIENT_ORIGIN.y + rowH);
      item.childAdd(btn);
      item.ingredients.push(btn);
      this.ingredientBtns.push(btn);
      void this.ingredient(this.ingredientGuid(n)).then(([pic, tip]) => {
        btn.picture = pic;
        btn.tooltip = tip;
      });
    });
  }

  /** cPickSpellList::TabDown */
  private tabDown(): void {
    this.selected = 0;
    this.page = Math.max(0, this.page - 1);
    this.refreshList();
    this.updateDescription();
    this.nextBtn?.setEnabled(this.page + 1 < this.pages);
    this.backBtn?.setEnabled(this.page > 0);
  }

  /** cPickSpellList::TabUp */
  private tabUp(): void {
    this.selected = 0;
    this.page = Math.min(this.pages - 1, this.page + 1);
    this.refreshList();
    this.updateDescription();
    this.backBtn?.setEnabled(this.page > 0);
    this.nextBtn?.setEnabled(this.page + 1 < this.pages);
  }

  /** CWinMagicBook::TSOnCommand (+ cPickSpellList::TSOnCommand's 0x15 to the book). */
  override tsOnCommand(cmd: number, source: TSWin): boolean {
    if (source === this.closeBtn) {
      this.tsEndDialog(0);
      return true;
    }
    if (source === this.nextBtn) {
      this.tabUp();
      return true;
    }
    if (source === this.backBtn) {
      this.tabDown();
      return true;
    }
    // cPickSpellItem::TSOnCommand: the ingredient buttons' commands go no further.
    if (this.ingredientBtns.includes(source as IngredientBtn)) return true;
    const i = this.items.indexOf(source as PickSpellItem);
    if (i >= 0) {
      this.selected = i;
      this.updateDescription();
      return true;
    }
    return super.tsOnCommand(cmd, source);
  }

  /** CWinMagicBook::TSOnKeyDown: Escape (and Return) press Close. */
  override tsOnKeyDown(key: string): boolean {
    if (key === "Escape" || key === "Enter") {
      this.tsEndDialog(0);
      return true;
    }
    return false;
  }

  /** CWinMagicBook::TSPaint */
  override tsPaint(g: Gfx): void {
    const W = this.getW();
    const H = this.getH();
    const f = this.frame;
    if (f) bltEdge(g, f, Math.trunc(f.width / 3), Math.trunc(f.height / 3), W, H, true);
    this.paintList(g);
    const pic = this.pictures[this.picture];
    if (pic) g.blit(pic, W - 0xb4, H - 0x96);
  }

  /** cPickSpellList::TSPaint (the list's own drawing, under its items) on a page of fewer than 4 items. */
  private paintList(g: Gfx): void {
    const n = this.items.length;
    if (n >= PER_PAGE) return;
    const img = this.itemBkg;
    const rowH = this.rowHeight();
    const listW = img ? img.width : 0;
    const listH = rowH * PER_PAGE;
    const bkg = this.listBkg;
    if (bkg) {
      g.blitPart(bkg, LIST_POS.x, LIST_POS.y, listW - LIST_BKG_OFFSET.x, listH - LIST_BKG_OFFSET.y, LIST_POS.x + LIST_BKG_OFFSET.x, LIST_POS.y + LIST_BKG_OFFSET.y);
    }
    if (img) for (let row = n; row < PER_PAGE; row++) g.blitPart(img, 0, 0, img.width, rowH, LIST_POS.x, LIST_POS.y + row * rowH);
  }
}

/** cPickSpellItem: a row of the list, kPickSpellItemBkg (1 column x 3 rows), toggled on press. */
class PickSpellItem extends TSWinBtn {
  /** +0x18c: the ingredient buttons. */
  readonly ingredients: IngredientBtn[] = [];

  constructor(id: number, image: ImageBitmap | null) {
    super(id, image, 1, 3);
    this.sendOnDown = true;
    this.mode = BTN_TOGGLE;
  }

  /** The list's selection (SetState), then CalcRowCol's enabling of the ingredient buttons. */
  setSelected(on: boolean): void {
    this.setState(on ? 1 : 0);
    for (const b of this.ingredients) b.setEnabled(on);
  }

  /** cPickSpellItem::CalcRowCol: row 2 selected, 1 under the mouse, else 0; column 0. */
  override tsPaint(g: Gfx): void {
    this.row = this.state !== 0 ? 2 : this.entered ? 1 : 0;
    for (const b of this.ingredients) b.setEnabled(this.state !== 0);
    super.tsPaint(g);
  }
}

/** An ingredient button of cPickSpellItem: a cTSWinBtn whose image is drawn at (+0x13c, +0x140). */
class IngredientBtn extends TSWinBtn {
  picture: ImageBitmap | null = null;

  constructor(private readonly imageY: number) {
    super();
  }

  /** cTSWinBtn::DefaultPaint with the image offset. */
  override tsPaint(g: Gfx): void {
    const p = this.picture;
    if (p) g.blitPart(p, 0, 0, Math.min(p.width, INGREDIENT_W), p.height, 0, this.imageY);
  }
}
