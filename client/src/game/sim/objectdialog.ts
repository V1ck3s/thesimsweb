/**
 * ObjectDialog: the generic dialog of the Dialog primitive (cXObject::
 * TryDialog kinds 0..4), queued on the ObjectModule (+0x64,
 * EnqueueObjectDialog / GetCurrentDialog) and shown after the tick by
 * ObjectModule::PostSim (ObjectDialog::Show -> cWinPictureDialog through
 * the module's dialog hooks).
 *
 * Layout of the original (0x48 bytes):
 *   +0 object, +4 selector, +8 title, +0xc / +0x10 / +0x14 buttons 1..3
 *   (ids 2, 3, 4), +0x18 message, +0x1c edited text, +0x20 type,
 *   +0x24 image, +0x28 image rect, +0x38 "result ignored" (operand byte 7
 *   bit 0), +0x39 modal with a button (byte 7 bit 7 clear; a close box
 *   otherwise), +0x3a stack object, +0x3c tutorial object, +0x3d no title
 *   (the tutorial guide GUID), +0x3e operand byte 5 bit 7, +0x40 window,
 *   +0x44 state: 0 queued, 1 shown, 2..4 the button pressed, 5 done.
 */

import type { ObjSelector } from "../world/objselector.js";
import { loadUIStringSet } from "./behavior.js";
import type { StackElem } from "./treestack.js";
import type { SimObject } from "./xobject.js";

/**
 * The dialog's picture as SetParams picks it (the world side draws it):
 * an object's catalog icon (Product::DrawIcon, 120 x 120), a person's
 * button picture (PersonFinder::GetPictureBuffer, its first 45 x 45 cell),
 * a BMP_ of an object file (mode 3, "my n"), a UI graphic ("gz n": the
 * first quarter of a 4-state button, "gzi n": all of it) or a catalog
 * button (Product::ComposeBtnImage, "guid n", 45 x 45).
 */
export type DialogIcon =
  | { kind: "object"; selector: ObjSelector }
  | { kind: "person"; guid: number }
  | { kind: "bmp"; selector: ObjSelector; id: number }
  | { kind: "ui"; id: number; quarter: boolean }
  | { kind: "product"; selector: ObjSelector }
  | { kind: "rel"; guid: number }
  | { kind: "job"; row: number };

/** ObjectDialog::SetParams: the Tutorial object (Objects.far Tutorial.iff). */
const GUID_TUTORIAL_GUIDE = 0xc3249a1d;

/** UIText STR# 0x8e (ObjectDialog::GetString): 1 OK, 2 cancel, 3 yes, 4 no. */
export const DLG_STRINGS = 0x8e;

export interface DialogHooks {
  /** UIText string `n` (1-based) of STR# `set`. */
  uiString(set: number, n: number): string;
  /** ObjectModule::PostSim: show the queued dialog (ObjectDialog::Show). */
  show(d: ObjectDialog): void;
  /**
   * ObjectModule::PostSim's phone book part: CWinPhoneBook for the caller
   * (a neighbor id) run modally; resolves with GetSelected (< 1: cancelled).
   */
  showPhoneBook?(callerNeighborId: number): Promise<number>;
  /**
   * ObjectModule::PostSim's person pickers, run modally: kind 6
   * cWinClothingChoiceDlg(type, person), 0xe cWinTransformMeDlg(person),
   * 9 cWinPetSelectDlg(pet); resolves with the result word
   * ((index << 16) | 0xfffe for OK, | 0xffff for Cancel).
   */
  showPersonPicker?(kind: 6 | 9 | 0xe, person: SimObject, type: number): Promise<number>;
  /** cXObject::TryDialog kinds 0xc / 0xf: CWinMagicBook(person, cookbook) run modally. */
  showMagicBook?(person: SimObject, cookbook: boolean): Promise<void>;
}

export class ObjectDialog {
  title = "";
  /** +0xc, +0x10, +0x14: the texts of buttons 2, 3, 4. */
  readonly buttons: [string, string, string] = ["", "", ""];
  message = "";
  edited = "";
  type = 0;
  /** +0x38 */
  resultIgnored = false;
  /** +0x39 */
  modal = true;
  /** +0x3a */
  stackObj = 0;
  /** +0x3c: the object is the tutorial object (ObjectModule::GetTutorialObject). */
  tutorial = false;
  /** +0x3d: the object is the tutorial guide (GUID 0xc3249a1d): no title, a see-through window. */
  noTitle = false;
  /** +0x3e */
  flag3e = false;
  icon: DialogIcon | null = null;
  /** +0x44 */
  state = 0;
  /** +0x40: closes the shown window (ObjectDialog::Abort's DestroyWindow). */
  close: (() => void) | null = null;

  constructor(
    /** +0 */
    readonly obj: SimObject,
  ) {}

  /**
   * ObjectDialog::SetParams(stack frame, operand). Strings come from the
   * private STR# 0x12d of the frame's behavior (AssignString: entry index,
   * 0 / empty = the default), then go through cXObject::ParseUIString.
   * Operand: [0] cancel string, [1] icon argument, [2] message, [3] yes /
   * OK, [4] no, [5] type (bit 7: +0x3e), [6] title, [7] flags (bit 0
   * result ignored, bits 1-3 icon mode, bits 4-6 temp for the answer,
   * bit 7 close box).
   */
  setParams(elem: StackElem, op: Uint8Array, hooks: DialogHooks | null): void {
    const o = this.obj;
    const sel = o.obj.selector;
    this.tutorial = o.module.tutorialObject === o;
    this.noTitle = (sel.guid | 0) === (GUID_TUTORIAL_GUIDE | 0);
    this.type = op[5]! & 0x7f;
    this.flag3e = (op[5]! & 0x80) !== 0;
    this.resultIgnored = (op[7]! & 1) !== 0;
    this.modal = (op[7]! & 0x80) === 0;
    this.stackObj = elem.stackObj;
    const file = elem.behavior?.priv ?? null;
    const set = file ? loadUIStringSet(file, 0x12d) : null;
    const def = (n: number): string => hooks?.uiString(DLG_STRINGS, n) ?? "";
    const assign = (index: number, fallback: string): string => (index >= 1 ? set?.[index - 1] : undefined) || fallback;
    this.message = assign(op[2]!, "");
    this.title = assign(op[6]!, sel.getCatalogName());
    if (this.type === 2) {
      this.buttons[2] = assign(op[0]!, def(2));
      this.buttons[1] = assign(op[4]!, def(4));
      this.buttons[0] = assign(op[3]!, def(3));
    } else if (this.type === 1) {
      this.buttons[1] = assign(op[4]!, def(4));
      this.buttons[0] = assign(op[3]!, def(3));
    } else if (this.type === 0 || this.type < 5) {
      this.buttons[0] = assign(op[3]!, def(1));
    }
    const parsed: { selector: ObjSelector | null } = { selector: null };
    this.buttons[0] = o.parseUIString(this.buttons[0], elem, null, parsed);
    this.buttons[1] = o.parseUIString(this.buttons[1], elem, null, parsed);
    this.buttons[2] = o.parseUIString(this.buttons[2], elem, null, parsed);
    this.title = o.parseUIString(this.title, elem, null, parsed);
    this.message = o.parseUIString(this.message, elem, null, parsed);
    // The picture: (byte 7 >> 1) & 7.
    const mode = (op[7]! >> 1) & 7;
    const m = o.module;
    let pic: ObjSelector | null = null;
    if (mode === 0) {
      pic = parsed.selector ?? m.getObject(this.stackObj)?.obj.selector.getMasterSelector() ?? null;
    } else if (mode === 2) {
      // Neighborhood::GetNeighborSelector(stack object as a neighbor id)
      const nb = m.findNeighborByID(this.stackObj);
      if (nb) this.icon = { kind: "person", guid: nb.guid };
    } else if (mode === 3) {
      // ObjectFolder::GetSelectorByBehavior: the BMP_ 5000 + operand 1 of the frame's object file.
      const s = m.selectorOfBehavior(elem.behavior);
      if (s) this.icon = { kind: "bmp", selector: s, id: op[1]! + 5000 };
    } else if (mode === 4) {
      this.icon = this.namedPicture(o.parseUIString(assign(op[1]!, ""), elem, null));
    }
    if (pic) this.icon = pic.getIsPerson() ? { kind: "person", guid: pic.guid } : { kind: "object", selector: pic };
  }

  /**
   * SetParams' mode 4: a picture named by a string, "<kind> <number>"
   * (split at the first space): "gz" / "gzi" a UI graphic by resource id,
   * "my" a BMP_ of the object's file, "guid" the catalog button of an
   * object definition, "rel" the relationship picture of the selected
   * person's first related person (PersonFinder::GetRelatedPeople(selected,
   * 3) then GetRelPictureBuffer; the middle fifth is shown), "job n" row n
   * of the job popup composite (cWinSubpanelJob::GetJobPopupComposite, 22
   * rows; -1 is row 0xb). No game string uses the last two.
   */
  private namedPicture(text: string): DialogIcon | null {
    const sp = text.indexOf(" ");
    const word = (sp < 0 ? text : text.slice(0, sp)).toLowerCase();
    const n = Number.parseInt(sp < 0 ? "" : text.slice(sp + 1).replace(/ /g, ""), 10) || 0;
    const m = this.obj.module;
    if (word === "gz" || word === "gzi") return n !== 0 ? { kind: "ui", id: n, quarter: word === "gz" } : null;
    if (word === "my") return n !== 0 ? { kind: "bmp", selector: this.obj.obj.selector, id: n } : null;
    if (word === "guid") {
      const s = m.worldHooks?.selector(n);
      return s ? { kind: "product", selector: s } : null;
    }
    if (word === "rel") {
      const guid = this.firstRelatedPerson();
      return guid !== null ? { kind: "rel", guid } : null;
    }
    if (word === "job") {
      const row = n === -1 ? 0xb : n;
      return row >= 0 && row <= 0x15 ? { kind: "job", row } : null;
    }
    return null;
  }

  /**
   * PersonFinder::GetSelected then GetRelatedPeople(selected, list, 3):
   * everyone the selected person has a relationship entry for, the lot's
   * family first, then by daily relationship (highest first), then in
   * neighbor order (PersonFinder::RelCompare). The first one's GUID.
   */
  private firstRelatedPerson(): number | null {
    const m = this.obj.module;
    const info = m.sim.state?.personGetSelected();
    const me = info?.guid !== undefined ? m.findNeighborByGUID(info.guid) : null;
    if (!me || !m.nbhd) return null;
    const family = new Set((m.sim.state?.family ?? []).map((p) => (p.guid ?? 0) | 0));
    const related = m.nbhd.neighbors
      .map((n, i) => ({ n, i, row: n.id !== me.id ? me.relationships.find((r) => r.other === n.id)?.values : undefined }))
      .filter((e) => e.row !== undefined)
      .map((e) => ({ ...e, fam: family.has(e.n.guid | 0), value: e.row![0] ?? 0 }))
      .sort((a, b) => Number(b.fam) - Number(a.fam) || b.value - a.value || a.i - b.i);
    return related[0]?.n.guid ?? null;
  }

  /** ObjectDialog::ResultProcessed */
  resultProcessed(): void {
    if (this.state >= 2 && this.state <= 4) this.state = 5;
  }

  /** ObjectDialog::BtnPressed (cTSObjectDialog::TSOnCommand); type 3 keeps the edited text. */
  btnPressed(id: number, edited: string): void {
    if (id > 1 && id < 5) this.state = this.resultIgnored ? 5 : id;
    if (this.type === 3) this.edited = edited;
    this.close = null;
  }

  /** ObjectDialog::Abort */
  abort(): void {
    this.state = 5;
    const c = this.close;
    this.close = null;
    c?.();
  }
}
