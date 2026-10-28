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

/** The dialog's picture as SetParams picks it (the world side draws it). */
export type DialogIcon =
  | { kind: "object"; selector: ObjSelector }
  | { kind: "neighbor"; neighborId: number }
  | { kind: "bmp"; selector: ObjSelector; id: number };

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
    if (mode === 0) {
      let s = parsed.selector;
      if (!s) s = o.module.getObject(this.stackObj)?.obj.selector.getMasterSelector() ?? null;
      if (s) this.icon = s.getIsPerson() ? this.personIcon(s) : { kind: "object", selector: s };
    } else if (mode === 2) {
      this.icon = { kind: "neighbor", neighborId: this.stackObj };
    } else if (mode === 3) {
      // ObjectFolder::GetSelectorByBehavior: the BMP_ 5000 + operand 1 of the frame's object file.
      const s = o.module.selectorOfBehavior(elem.behavior);
      if (s) this.icon = { kind: "bmp", selector: s, id: op[1]! + 5000 };
    }
    // Mode 4 (a "bmp" / "guid" / "rel" / "job" picture named by a string) is not ported.
  }

  private personIcon(s: ObjSelector): DialogIcon | null {
    const nb = this.obj.module.findNeighborByGUID(s.guid);
    return nb ? { kind: "neighbor", neighborId: nb.id } : null;
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
