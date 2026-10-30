/**
 * cWinPictureDialog: the game's generic dialog (object dialogs of SimAntics,
 * neighborhood notices...): a title, an optional picture at the top left, a
 * word-wrapped text, an optional one-line edit box, buttons along the bottom
 * and an optional close box.
 *
 * From the decompiled class:
 *  - constructor: the cWinTextWrap (+0xe0) is created right away; the target
 *    width / height ratio (+0x138) is lbl_105BC4F8 = 2.0;
 *  - Init: the frame is cTSWinCtrlMgr system bitmap 5 (popup tiles, 3x3 cells,
 *    GetClientTopLeft = one cell), cursor 0, kPictureDialogStub loaded (+0x110,
 *    drawn under a 45 x 45 picture);
 *  - SetTitle: a cTSWinText, font lbl_105BA2E8 + 0x38 (size 14), one line,
 *    transparent, no gutters, id -1;
 *  - SetImage(buffer [, rect]): the picture and its source rectangle;
 *  - AddButton: cTSWinCtrlMgr::DefaultPushBtn, at least 100 wide; a "Yes" /
 *    "No" label (cTSWinMsgBox::GetButtonLabel(4 / 2)) also gets the message
 *    box's shortcut character (GetKeyboardShortcut);
 *  - AddEditBox(text, id): a cTSWinTextEdit2, system font 0, one line,
 *    capacity 0x40, colors (fill lbl_105BA25C = (0, 0, 0x52), caret and frame
 *    in the font color), 0x24 tall and as wide as the text;
 *  - AddCloseBox(id [, res = kSMSystemDlgCloseBox]): a 4-frame button,
 *    5 px from the top right corner;
 *  - DoLayout / TryLayout: the text width is searched (doubling, halving, then
 *    bisecting down to 20 px) so that the box's width / height ratio comes
 *    closest to 2. Layout: frame cell + 9 margins, title on top, the text 0x12
 *    under it wrapping around the picture (indent picture width + 0x12), the
 *    edit box 9 under the text, buttons spread evenly 0x12 under that;
 *  - TSBeginModal: buttons one-shot, DoLayout, then the positioning
 *    (SetPositioning: 0 centered on the main window, 1 in the corner of a
 *    given rectangle, 2 centered but moved off a given rectangle), the timeout
 *    armed, the edit box focused;
 *  - keys (SetKey, virtual-key codes) and characters (SetCharacter) press a
 *    button: shown down for 200 ms (TSOnTimerMsg), then released, which
 *    fires it; the timeout (SetTimeout) does the same with its button. A
 *    mouse press on the dialog stops the timeout, the release restarts it;
 *  - TSOnCommand: the edit box's Return (0x17) is a key Enter; the first
 *    button press ends the dialog with the button's id (message 0x10).
 *    cTSObjectDialog::TSOnCommand forwards the press to its owner first
 *    (ObjectDialog::BtnPressed): `onButton` here.
 *
 * A modeless dialog (runModeless) lives in the lot view without a modal loop.
 *
 * Not ported: BoboVision transparent drag, the cTutorialIcon close box
 * variant, the window flag 0x20 cleared for a modeless dialog (+0x121).
 */

import type { GameContext } from "../context.js";
import type { FfnFont } from "../res/ffn.js";
import { TSWinBtn } from "./btn.js";
import { SYS_POPUP_TILES, TSWinCtrlMgr } from "./ctrlmgr.js";
import { getCursor } from "./cursor.js";
import { bltEdge, TSWinDlg } from "./dlg.js";
import { rgb, UI_FONT_COLOR } from "./syscolors.js";
import { TSSystemButton } from "./systembutton.js";
import { TSWinText, WTF_MULTILINE } from "./text.js";
import { TE_RETURN, TSWinTextEdit2 } from "./textedit.js";
import { WinTextWrap } from "./textwrap.js";
import { Gfx, type Rect, TSWin, WF_NO_FOCUS } from "./tswin.js";
import { winMgr } from "./winmgr.js";

/** cWinPictureDialog::Positioning */
export const PD_CENTER = 0;
export const PD_CORNER_OF_RECT = 1;
export const PD_AVOID_RECT = 2;

/** lbl_105BC4F8: the width / height ratio DoLayout aims at. */
const TARGET_RATIO = 2.0;
/** lbl_105C0D30: ratios this close to the target are kept as they are. */
const RATIO_TOLERANCE = 0.05;
/** The 45 x 45 picture size that gets the kPictureDialogStub frame. */
const STUB_SIZE = 0x2d;
const MARGIN = 9;
const GAP = 0x12;
const PRESS_MS = 200;
const VK_RETURN = 0x0d;
const VK_ESCAPE = 0x1b;
/** cTSWinMsgBox::SetButtonLabel(id, UIText STR# 152 entry) and the shortcuts (STR# 161). */
const LABELS_STR = 152;
const SHORTCUTS_STR = 161;
const YES_LABEL_ENTRY = 2;
const NO_LABEL_ENTRY = 3;
const YES_SHORTCUT_ENTRY = 6;
const NO_SHORTCUT_ENTRY = 7;
/** lbl_105BA25C (InitSimsColors): the edit box fill. */
const EDIT_FILL = rgb(0, 0, 0x52);
const EDIT_HEIGHT = 0x24;
const EDIT_CAPACITY = 0x40;
const TITLE_FONT_SIZE = 14;
const TEXT_FONT_SIZE = 12;
const CLOSE_BOX = "kSMSystemDlgCloseBox";

/** ButtonKeyData: a key (SetKey) or a character (SetCharacter) for a button id. */
interface ButtonKeyData {
  id: number;
  key: number;
  char: string;
}

/** KeyboardEvent.key → Windows virtual-key code (0 when not mapped). */
function virtualKey(key: string): number {
  switch (key) {
    case "Enter":
      return VK_RETURN;
    case "Escape":
      return VK_ESCAPE;
    case " ":
      return 0x20;
    case "Backspace":
      return 0x08;
    case "Tab":
      return 0x09;
  }
  if (key.length === 1 && /[a-z0-9]/i.test(key)) return key.toUpperCase().charCodeAt(0);
  return 0;
}

export class WinPictureDialog extends TSWinDlg {
  /** cTSObjectDialog::TSOnCommand → ObjectDialog::BtnPressed(id): called when a button fires. */
  onButton: ((id: number) => void) | null = null;

  /** +0xd0 */
  private readonly keys: ButtonKeyData[] = [];
  /** +0xdc */
  private title: TSWinText | null = null;
  /** +0xe0 */
  private readonly text = new WinTextWrap();
  /** +0xe4 */
  private closeBox: TSWinBtn | null = null;
  /** +0xe8 */
  private editBox: TSWinTextEdit2 | null = null;
  private editInitial = "";
  /** +0xec */
  private readonly buttons: TSWinBtn[] = [];
  /** +0xf8 / +0xfc: the picture and its source rectangle. */
  private image: ImageBitmap | null = null;
  private imageRect: Rect = { left: 0, top: 0, right: 0, bottom: 0 };
  /** +0x10c */
  private frame: ImageBitmap | null = null;
  /** +0x110 */
  private stub: ImageBitmap | null = null;
  /** +0x114 / +0x118: timeout (ms) and the button it presses. */
  private timeoutMs = 0;
  private timeoutButton = 0;
  /** +0x11c: a button is shown down. */
  private pressing = false;
  /** +0x124 / +0x128 */
  private positioning = PD_CENTER;
  private positionRect: Rect = { left: 0, top: 0, right: 0, bottom: 0 };
  /** +0x13c: button presses seen (only the first ends the dialog). */
  private presses = 0;
  private timer = 0;
  private mgr: TSWinCtrlMgr | null = null;
  private titleFont: FfnFont | null = null;
  private closeBoxImage: ImageBitmap | null = null;
  private wantsCloseBox = false;
  /** Setters called before Init run once its resources are loaded. */
  private pending: (() => void)[] | null = [];

  constructor(private readonly ctx: GameContext) {
    super();
  }

  private later(fn: () => void): void {
    if (this.pending) this.pending.push(fn);
    else fn();
  }

  /** cWinPictureDialog::Init */
  override async init(): Promise<boolean> {
    if (!this.pending) return true;
    const mgr = await TSWinCtrlMgr.get(this.ctx);
    this.mgr = mgr;
    this.frame = mgr.systemBMP(SYS_POPUP_TILES);
    this.winCursor = getCursor(0);
    const [titleFont, stub] = await Promise.all([
      this.ctx.fonts.acquire(TITLE_FONT_SIZE),
      this.ctx.res.image("kPictureDialogStub").catch(() => null),
    ]);
    this.titleFont = titleFont;
    this.stub = stub;
    this.text.setFont(mgr.tableFont(TEXT_FONT_SIZE));
    this.childAdd(this.text);
    if (this.wantsCloseBox) this.closeBoxImage = await this.ctx.res.image(CLOSE_BOX).catch(() => null);
    const pending = this.pending;
    this.pending = null;
    for (const fn of pending) fn();
    return true;
  }

  /** cWinPictureDialog::SetTitle */
  setTitle(s: string): void {
    this.later(() => {
      const t = new TSWinText();
      t.id = -1;
      t.setCaption(s);
      t.setFont(this.titleFont!);
      t.setBackgroundOpaque(false);
      t.setWinTextFlag(WTF_MULTILINE, false);
      t.setAlignment(2);
      t.setGutters(0, 0);
      t.fitWindowToText();
      if (this.title) this.childDelete(this.title);
      this.title = t;
      this.childAdd(t);
    });
  }

  /** cWinPictureDialog::SetImage(buffer [, rect]): `rect` is the part of `img` shown (default: all of it). */
  setImage(img: ImageBitmap | null, rect?: Rect): void {
    this.image = img;
    this.imageRect = rect ? { ...rect } : { left: 0, top: 0, right: img?.width ?? 0, bottom: img?.height ?? 0 };
  }

  /** cWinPictureDialog::AddText */
  addText(s: string): void {
    this.text.addText(s);
  }

  /** cWinPictureDialog::AddButton */
  addButton(label: string, id: number): void {
    const strings = this.ctx.strings;
    if (label === strings.get("UIText", LABELS_STR, YES_LABEL_ENTRY)) {
      this.setCharacter(id, strings.get("UIText", SHORTCUTS_STR, YES_SHORTCUT_ENTRY).charAt(0));
    } else if (label === strings.get("UIText", LABELS_STR, NO_LABEL_ENTRY)) {
      this.setCharacter(id, strings.get("UIText", SHORTCUTS_STR, NO_SHORTCUT_ENTRY).charAt(0));
    }
    this.later(() => {
      // DefaultPushBtn, at least 100 wide (done by TSSystemButton.defaultPushBtn).
      const b = TSSystemButton.defaultPushBtn(this.mgr!, id, label);
      this.childAdd(b);
      this.buttons.push(b);
    });
  }

  /** cWinPictureDialog::AddEditBox(text, id): `id` is the edit window's id (ObjectDialog uses 999). */
  addEditBox(initial: string, id: number): void {
    this.editInitial = initial;
    this.later(() => {
      if (this.editBox) return;
      const e = new TSWinTextEdit2();
      e.id = id;
      const font = this.mgr!.systemFont(0);
      e.setFont(font);
      e.setTextColor(UI_FONT_COLOR);
      e.setText(initial);
      e.setLinesAllowed(1);
      e.setCapacity(EDIT_CAPACITY);
      e.setArea(0, 0, 100, 100);
      e.setColors(EDIT_FILL, UI_FONT_COLOR, UI_FONT_COLOR);
      this.editBox = e;
      this.childAdd(e);
    });
  }

  /** cWinPictureDialog::GetEditedText */
  getEditedText(): string {
    return this.editBox ? this.editBox.getText() : this.editInitial;
  }

  /** cWinPictureDialog::AddCloseBox(id): kSMSystemDlgCloseBox, 4 frames (call before init / run). */
  addCloseBox(id: number): void {
    this.wantsCloseBox = true;
    this.later(() => {
      const img = this.closeBoxImage;
      if (this.closeBox || !img) return;
      const b = new TSWinBtn(id, img, 4, 1);
      this.closeBox = b;
      this.childAdd(b);
    });
  }

  /** cWinPictureDialog::SetTimeout(button, ms) */
  setTimeout(buttonId: number, ms: number): void {
    this.timeoutMs = ms;
    this.timeoutButton = buttonId;
  }

  /** cWinPictureDialog::SetKey(button, virtual-key code) */
  setKey(buttonId: number, key: number): void {
    this.keys.push({ id: buttonId, key, char: "" });
  }

  /** cWinPictureDialog::SetCharacter(button, character) */
  setCharacter(buttonId: number, char: string): void {
    this.keys.push({ id: buttonId, key: 0, char });
  }

  /** cWinPictureDialog::SetPositioning: modes 1 and 2 need a rectangle (main window coordinates), else 0. */
  setPositioning(mode: number, rect?: Rect): void {
    this.positioning = mode;
    if (rect) this.positionRect = { ...rect };
    if ((mode === PD_CORNER_OF_RECT || mode === PD_AVOID_RECT) && !rect) this.positioning = PD_CENTER;
  }

  /** cSimsApp::DoSimsModalDialog: shows the dialog modally; resolves with the id of the button pressed. */
  async run(): Promise<number> {
    await this.init();
    return winMgr.doModalWin(this);
  }

  /** Set while the dialog runs modeless (runModeless): ends it. */
  private modelessDone: ((result: number) => void) | null = null;

  /**
   * cSimsApp::DoSimsModalDialog(win, modal = false): the dialog is added to
   * the lot view (cDDDSimsView, ChildAdd) and TSBeginModal lays it out; no
   * modal loop, the focus and the simulation are left alone. Resolves with
   * the button that ended it (TSEndDialog), 0 when destroyed.
   */
  async runModeless(parent: TSWin): Promise<number> {
    await this.init();
    parent.childAdd(this);
    this.tsBeginModal();
    return new Promise((resolve) => {
      this.modelessDone = resolve;
    });
  }

  override tsEndDialog(result: number): void {
    const done = this.modelessDone;
    if (!done) {
      super.tsEndDialog(result);
      return;
    }
    this.modelessDone = null;
    this.tsEndModal();
    winMgr.releaseCapture(this);
    this.parent?.childRemove(this);
    done(result);
  }

  /** cTSWinMgrW95::DestroyWindow (ObjectDialog::Abort): ends the dialog with 0 if it is still up. */
  close(): void {
    this.tsEndDialog(0);
  }

  /** cWinPictureDialog::GetClientTopLeft: one frame cell. */
  private cell(): { w: number; h: number } {
    const f = this.frame;
    return f ? { w: Math.trunc(f.width / 3), h: Math.trunc(f.height / 3) } : { w: 0, h: 0 };
  }

  private isStubbed(): boolean {
    const r = this.imageRect;
    return r.right - r.left === STUB_SIZE && r.bottom - r.top === STUB_SIZE;
  }

  /** Picture size as the layout sees it (a 45 x 45 picture takes the stub's size). */
  private pictureSize(): { w: number; h: number } {
    const r = this.imageRect;
    if (this.isStubbed() && this.stub) return { w: this.stub.width, h: this.stub.height };
    return { w: r.right - r.left, h: r.bottom - r.top };
  }

  private hasTitle(): boolean {
    return this.title !== null && this.title.caption.length !== 0;
  }

  private static setPos(w: TSWin, x: number, y: number): void {
    w.setArea(x, y, x + w.getW(), y + w.getH());
  }

  private setTextWidth(width: number): void {
    const t = this.text;
    t.setArea(t.area.left, t.area.top, t.area.left + width, t.area.bottom);
  }

  /** cWinPictureDialog::TryLayout: places the children for the current text width; returns width / height. */
  private tryLayout(): number {
    const pic = this.pictureSize();
    let minW: number;
    if (!this.hasTitle()) {
      minW = pic.w || 100;
    } else {
      minW = this.title!.getW() + pic.w + GAP;
    }
    let buttonsW = 0;
    for (const b of this.buttons) buttonsW += b.getW() + 0x1e;
    minW = Math.max(minW, buttonsW);
    const c = this.cell();
    const text = this.text;
    if (text.getW() < minW) this.setTextWidth(minW);

    if (this.hasTitle()) {
      const t = this.title!;
      t.showWindow();
      t.setArea(t.area.left, t.area.top, t.area.right, t.area.top + t.font!.height);
      const x = this.image
        ? pic.w + c.w + Math.trunc((text.firstWidth - t.getW()) / 2) + GAP
        : Math.trunc((this.getW() - t.getW()) / 2);
      WinPictureDialog.setPos(t, x, c.h + MARGIN);
      WinPictureDialog.setPos(text, c.w + MARGIN, t.area.bottom + GAP);
    } else {
      WinPictureDialog.setPos(text, c.w + MARGIN, c.h + MARGIN);
    }

    let y = text.area.bottom + GAP;
    const edit = this.editBox;
    if (edit) {
      edit.setArea(edit.area.left, edit.area.top, edit.area.left + text.getW(), edit.area.top + EDIT_HEIGHT);
      WinPictureDialog.setPos(edit, text.area.left, text.area.bottom + MARGIN);
      y += edit.getH() + GAP;
    }

    if (this.buttons.length) {
      let total = 0;
      for (const b of this.buttons) total += b.getW();
      let gap = Math.trunc((text.getW() - total) / (this.buttons.length + 1));
      if (gap < 0) gap = MARGIN;
      let x = c.w + MARGIN;
      for (const b of this.buttons) {
        x += gap;
        WinPictureDialog.setPos(b, x, y);
        x += b.getW();
      }
      y += this.buttons[0]!.getH() + MARGIN;
    }

    const { left, top } = this.area;
    this.setArea(left, top, left + (c.w + MARGIN) * 2 + text.getW(), top + y + c.h);
    return this.getW() / this.getH();
  }

  /** cWinPictureDialog::DoLayout: the text width whose box ratio is closest to 2. */
  private doLayout(): void {
    const c = this.cell();
    const { left, top } = this.area;
    this.setArea(left, top, left + 300, top + 0xb9);
    const text = this.text;
    if (!this.hasTitle()) WinPictureDialog.setPos(text, c.w + MARGIN, c.h + MARGIN);
    else WinPictureDialog.setPos(text, c.w + MARGIN, this.title!.getH() + c.h + 0x1b);
    if (this.image) {
      const pic = this.pictureSize();
      text.setTopLeftImageSize(pic.w + GAP, pic.h + c.h + 0x1b - text.area.top);
    }

    let low = this.tryLayout();
    let lowW = text.getW();
    let highW = lowW;
    let high = low;
    if (Math.abs(low - TARGET_RATIO) > RATIO_TOLERANCE) {
      // Widen until the box is at least as wide as the target...
      while ((high = this.tryLayout()) < TARGET_RATIO) {
        this.setTextWidth(text.getW() * 2);
        highW = text.getW();
      }
      // ...narrow from the start until it is at most as wide...
      this.setTextWidth(lowW);
      for (let i = 1; i < 10 && (low = this.tryLayout()) > TARGET_RATIO; i++) {
        this.setTextWidth(Math.trunc(text.getW() / 2));
        lowW = text.getW();
      }
      // ...then bisect down to 20 px.
      for (let i = 1; i < 10 && Math.abs(highW - lowW) > 0x14; i++) {
        this.setTextWidth(Math.trunc((highW + lowW) / 2));
        const r = this.tryLayout();
        if (r >= TARGET_RATIO) {
          highW = text.getW();
          high = r;
        } else {
          lowW = text.getW();
          low = r;
        }
      }
    }
    const best = Math.abs(high - TARGET_RATIO) <= Math.abs(low - TARGET_RATIO) ? highW : lowW;
    if (best !== text.getW()) this.setTextWidth(best);
    this.tryLayout();

    const cb = this.closeBox;
    if (cb) WinPictureDialog.setPos(cb, this.getW() - cb.getW() - 5, 5);
  }

  /** cWinPictureDialog::TSBeginModal */
  override tsBeginModal(): void {
    // sound / view: cSimsApp::StopScrolling
    this.presses = 0;
    this.doLayout();
    const main = winMgr.main.area;
    const r = this.positionRect;
    if (this.positioning === PD_CORNER_OF_RECT) {
      this.placeInCornerOfRect(main, r);
    } else if (this.positioning === PD_CENTER) {
      this.centerWindowInRect(main);
    } else if (this.positioning === PD_AVOID_RECT) {
      this.centerWindowInRect(main);
      this.moveOffRect(main, r);
    }
    if (this.timeoutMs) this.subscribeTimer(this.timeoutMs);
    const edit = this.editBox;
    if (edit) {
      if (!edit.getFlag(WF_NO_FOCUS)) winMgr.setFocus(edit);
      for (const b of this.buttons) b.setFlag(WF_NO_FOCUS, true);
      this.title?.setFlag(WF_NO_FOCUS, true);
      this.closeBox?.setFlag(WF_NO_FOCUS, true);
      this.text.setFlag(WF_NO_FOCUS, true);
      this.setFlag(WF_NO_FOCUS, true);
    }
  }

  /** Positioning 1: the quadrant of the main window the rectangle overlaps most; the dialog goes in that corner of the rectangle. */
  private placeInCornerOfRect(main: Rect, r: Rect): void {
    const cx = Math.trunc((main.left + main.right) / 2);
    const cy = Math.trunc((main.top + main.bottom) / 2);
    const quads: Rect[] = [
      { left: 0, top: 0, right: cx, bottom: cy },
      { left: cx, top: 0, right: main.right, bottom: cy },
      { left: 0, top: cy, right: cx, bottom: main.bottom },
      { left: cx, top: cy, right: main.right, bottom: main.bottom },
    ];
    let best = -1;
    let bestArea = 0;
    quads.forEach((q, i) => {
      const w = Math.min(q.right, r.right) - Math.max(q.left, r.left);
      const h = Math.min(q.bottom, r.bottom) - Math.max(q.top, r.top);
      if (w <= 0 || h <= 0) return;
      if (best === -1 || bestArea < w * h) {
        best = i;
        bestArea = w * h;
      }
    });
    const w = this.getW();
    const h = this.getH();
    const x = best === 1 || best === 3 ? r.right - w : r.left;
    const y = best === 2 || best === 3 ? r.bottom - h : r.top;
    this.setArea(x, y, x + w, y + h);
  }

  /** Positioning 2: when the centered dialog (+5 px) overlaps the rectangle, above it, else below, else the larger side. */
  private moveOffRect(main: Rect, r: Rect): void {
    const a = this.area;
    if (!(a.left - 5 < r.right && r.left < a.right + 5 && a.top - 5 < r.bottom && r.top < a.bottom + 5)) return;
    const w = this.getW();
    const h = this.getH();
    let top: number;
    if (r.top - h - 10 >= 0) {
      top = r.top - 5 - h;
    } else if (h + r.bottom + 10 < main.bottom) {
      top = r.bottom + 5;
    } else {
      const above = Math.max(r.top, h + 5) - 5;
      const below = main.bottom - 5 - Math.max(main.bottom - 5 - h, r.bottom);
      top = w * above <= w * below ? main.bottom - 5 - h : 5;
    }
    this.setArea(a.left, top, a.right, top + h);
  }

  /** cWinPictureDialog::TSEndModal */
  override tsEndModal(): void {
    window.clearTimeout(this.timer);
  }

  private subscribeTimer(ms: number): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.tsOnTimerMsg(), ms);
  }

  /** cWinPictureDialog::TSOnTimerMsg: presses the timeout button, releases it 200 ms later. */
  private tsOnTimerMsg(): void {
    const b = this.getChildWindowFromID(this.timeoutButton);
    if (!(b instanceof TSWinBtn)) {
      this.pressing = false;
      return;
    }
    if (!this.pressing) {
      this.pressing = true;
      b.entered = true;
      b.tsOnMouseDownL();
      this.subscribeTimer(PRESS_MS);
    } else {
      this.pressing = false;
      window.clearTimeout(this.timer);
      b.tsOnMouseUpL(0, 0);
    }
  }

  /** The key / character path of TSOnKeyDown and TSOnCharacter. */
  private pressButton(id: number): boolean {
    if (!(this.getChildWindowFromID(id) instanceof TSWinBtn) || this.pressing) return false;
    this.timeoutButton = id;
    this.timeoutMs = 1;
    this.tsOnTimerMsg();
    return true;
  }

  /**
   * cWinPictureDialog::TSOnKeyDown and TSOnCharacter. A focused edit box saw the
   * key first (its Return comes back as command 0x17).
   */
  override tsOnKeyDown(key: string): boolean {
    const vk = virtualKey(key);
    // With the focus on a child (the edit box), only Return and Escape are looked up; the rest stops here.
    if (winMgr.getFocus() !== this && vk !== VK_RETURN && vk !== VK_ESCAPE) return true;
    if (this.pressKey(vk)) return true;
    if (key.length === 1) {
      const k = this.keys.find((e) => e.char !== "" && e.char === key);
      if (k) return this.pressButton(k.id);
    }
    // No button for the key: it ends here (the original returns 0 without cTSWin::TSOnKeyDown).
    return true;
  }

  /** SetKey lookup of TSOnKeyDown. */
  private pressKey(vk: number): boolean {
    const k = this.keys.find((e) => e.key !== 0 && e.key === vk);
    return k ? this.pressButton(k.id) : false;
  }

  /** cWinPictureDialog::TSOnMouseDownL: the timeout waits while the mouse is down. */
  override tsOnMouseDownL(): boolean {
    if (this.timeoutMs) window.clearTimeout(this.timer);
    return true;
  }

  /** cWinPictureDialog::TSOnMouseUpL: and starts over on release. */
  override tsOnMouseUpL(): boolean {
    if (this.timeoutMs) this.subscribeTimer(this.timeoutMs);
    return true;
  }

  /** cTSObjectDialog::TSOnCommand + cWinPictureDialog::TSOnCommand */
  override tsOnCommand(cmd: number, source: TSWin): boolean {
    if (source === this.editBox) {
      if (cmd === TE_RETURN) this.pressKey(VK_RETURN);
      return true;
    }
    if (!(source instanceof TSWinBtn) || !this.children.includes(source)) return super.tsOnCommand(cmd, source);
    this.onButton?.(source.id);
    if (++this.presses === 1) this.tsEndDialog(source.id);
    return true;
  }

  /** cWinPictureDialog::TSPaint: the frame, then the picture (on the stub when 45 x 45). */
  override tsPaint(g: Gfx): void {
    const c = this.cell();
    if (this.frame) bltEdge(g, this.frame, c.w, c.h, this.getW(), this.getH(), true);
    const img = this.image;
    if (!img) return;
    const r = this.imageRect;
    const x = MARGIN + c.w;
    const y = MARGIN + c.h;
    const w = r.right - r.left;
    const h = r.bottom - r.top;
    if (this.isStubbed() && this.stub) {
      const stub = this.stub;
      g.blit(stub, x, y);
      g.blitPart(img, r.left, r.top, w, h, x + Math.trunc((stub.width - STUB_SIZE) / 2), y + Math.trunc((stub.height - STUB_SIZE) / 2));
    } else {
      g.blitPart(img, r.left, r.top, w, h, x, y);
    }
  }
}
