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
 *    titles / descriptions, 0xd / 9 kid charms, 0xe / 10 recipes; STR# 0xf
 *    and 0x10 the spell and kid charm ids in list order;
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
 * Simplifications: cPickSpellItem's ingredient pictures (catalog icons by
 * GUID) are replaced by the entry's title on the item background; the
 * cookbook's two "Has Made" filters (recipes 9 and 4) are not applied; the
 * expansion flags of the spell list (ids 0x16 and 10) are taken as set.
 */

import type { GameContext } from "../context.js";
import type { FfnFont } from "../res/ffn.js";
import type { Simulator } from "../sim/simulator.js";
import type { SimObject } from "../sim/xobject.js";
import { TSWinBtn } from "./btn.js";
import { TSWinCtrlMgr } from "./ctrlmgr.js";
import { bltEdge, TSWinDlg } from "./dlg.js";
import { TSSystemButton } from "./systembutton.js";
import { TSWinText, WTF_MULTILINE } from "./text.js";
import { Gfx, type TSWin } from "./tswin.js";
import { winMgr } from "./winmgr.js";

const MAGIC = "magic";
const STR_UI = 1;
const STR_SPELL_DESC = 8;
const STR_KID_DESC = 9;
const STR_COOK_DESC = 10;
const STR_SPELL_TITLE = 0xc;
const STR_KID_TITLE = 0xd;
const STR_COOK_TITLE = 0xe;
const STR_SPELL_IDS = 0xf;
const STR_KID_IDS = 0x10;
/** UIText STR# 152: cSimsApp's button labels (GetButtonLabel(1): entry 1). */
const LABELS_STR = 152;
const CLOSE_LABEL_ENTRY = 1;
const HAS_MADE_TREE = "Magic - Has Made Spell/Recipe?";
const PER_PAGE = 4;
const TIMEOUT_MS = 400000;
/** Pictures by UpdateDescription's index: kid, charm, spell, oven, nectar. */
const PICTURES = ["kMagicBookKid", "kMagicBookCharm", "kMagicBookSpell", "kMagicBookOven", "kMagicBookNectar"];
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
  private items: TSWinBtn[] = [];
  private frame: ImageBitmap | null = null;
  private pictures: Array<ImageBitmap | null> = [];
  private itemBkg: ImageBitmap | null = null;
  private itemFont: FfnFont | null = null;
  private timer = 0;

  constructor(
    private readonly ctx: GameContext,
    private readonly sim: Simulator,
    /** +0x100 */
    private readonly person: SimObject,
    cookbook: boolean,
  ) {
    super();
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
    const [mgr, frame, itemBkg, titleFont, descFont, ...pictures] = await Promise.all([
      TSWinCtrlMgr.get(ctx),
      ctx.res.image("kCatalogPopupBackTiles"),
      ctx.res.image("kPickSpellItemBkg").catch(() => null),
      ctx.fonts.acquire(12),
      ctx.fonts.acquire(8),
      ...PICTURES.map((p) => ctx.res.image(p).catch(() => null)),
    ]);
    this.frame = frame;
    this.itemBkg = itemBkg;
    this.itemFont = descFont;
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

    this.ids = this.listIds();
    this.tabDown();
    return true;
  }

  /** Family::GetName of the person's family (person data 61). */
  private familyName(): string {
    const n = this.person.person?.personData[61] ?? 0;
    return this.sim.module.nbhd?.families.find((f) => f.chunkId === n)?.name ?? "";
  }

  /** cPickSpellList::Init's id list. */
  private listIds(): number[] {
    const out: number[] = [];
    const count = this.mode === Mode.Spells ? 0x16 : 9;
    for (let i = 1; i <= count; i++) {
      if (this.mode === Mode.Spells) {
        if (i !== 0xc) out.push(Number.parseInt(this.str(STR_SPELL_IDS, i + 1), 10) || 0);
      } else if (this.mode === Mode.Kid) {
        out.push(Number.parseInt(this.str(STR_KID_IDS, i + 1), 10) || 0);
      } else {
        out.push(i);
      }
    }
    return out;
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
    this.items.forEach((b, i) => b.setState(i === this.selected ? 1 : 0));
  }

  /** cPickSpellList::RefreshList: the page's items, tiled down the list area. */
  private refreshList(): void {
    for (const b of this.items) this.childDelete(b);
    this.items = [];
    const img = this.itemBkg;
    const rowH = img ? Math.trunc(img.height / 3) : 0x43;
    const ids = this.ids.slice(this.page * PER_PAGE, (this.page + 1) * PER_PAGE);
    ids.forEach((id, i) => {
      const b = new TSWinBtn(0x100 + i, img, 1, 3);
      b.caption = this.entryText(id, false);
      if (this.itemFont) b.font = this.itemFont;
      b.moveTo(0x31, 0x36 + i * rowH);
      this.childAdd(b);
      this.items.push(b);
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
    const i = this.items.indexOf(source as TSWinBtn);
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
    const pic = this.pictures[this.picture];
    if (pic) g.blit(pic, W - 0xb4, H - 0x96);
  }
}
