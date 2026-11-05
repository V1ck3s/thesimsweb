/**
 * cTutorialIcon — the tutorial guide's icon at the top right of the lot view
 * (cDDDSimsView +0x119c), and the box it flies along when a dialog of the
 * tutorial object opens or closes (ObjectDialog::SetupDialog / BtnPressed).
 *
 * From the decompiled class:
 *  - constructor: 6 rows, 1 column, a 45 x 45 cell, state 0, no last target
 *    area (-1s);
 *  - Init: the home area at (640 - cell width, 0)..(640, cell height), flag
 *    0x10 cleared, fill color (0x28, 0x28, 0x28), cursor 0;
 *  - SetIconTopRight(pt): the home area's top right corner (cSimsApp puts it
 *    at the lot view's right - 1, top + 1);
 *  - SetIcon(file, id): the BMP_ `id` of the object's file; a 45-pixel wide
 *    (tall) bitmap has 1 column (row); the cell is the bitmap / columns x
 *    rows (45 x 45 without a bitmap); the area keeps its top left;
 *  - ObjectChanged (GlobalDispatch 0x107 and 0xf6): no tutorial object hides
 *    it; else it shows the object's BMP_ 300 at its home area;
 *  - StartOpenAnimation(dialog): state 1 when the icon is at home, else 5
 *    (it first flies home from the last target area); StartCloseAnimation(
 *    dialog): it takes the dialog's area (also the last target area) and
 *    flies home (state 3);
 *  - Animate (cDDDSimsView::Draw, each frame): states 1 / 3 / 5 start
 *    500 ms ramps of the four edges (1: from where it is to the dialog's
 *    area; 3 and 5: from the last target area to home) and go to 2 / 4 / 6;
 *    at the end 2 hides the icon and shows the dialog, 4 puts it home (0),
 *    6 puts it home and goes on to 1; while running the area follows the
 *    ramps;
 *  - TSPaint: at rest its cell of the bitmap; while it flies a 3-pixel
 *    frame (black, white, black);
 *  - a left click at rest runs the tutorial object's "show situation info"
 *    tree (ObjectModule::ShowTutorialInfo); a right click does nothing.
 */

import { decodeImage } from "../res/bmp.js";
import type { ResFile } from "../world/iffres.js";
import { getCursor } from "./cursor.js";
import { Gfx, type Rect, TSWin } from "./tswin.js";

/** cTutorialIcon::ObjectChanged: SetIcon(object file, 300). */
const ICON_BMP = 300;
const CELL = 0x2d;
/** Init: the home area's right edge. */
const HOME_RIGHT = 0x280;
/** Animate: the ramps' duration. */
const FLY_MS = 500;

export class TutorialIcon extends TSWin {
  /** +0xcc */
  private icon: ImageBitmap | null = null;
  /** +0xd0..+0xdc: the home area. */
  private home: Rect = { left: 0, top: 0, right: 0, bottom: 0 };
  /** +0xe0 / +0xe4: rows and columns; +0xe8 / +0xec: the cell shown. */
  private rows = 6;
  private cols = 1;
  private row = 0;
  private col = 0;
  /** +0xf0 / +0xf4 */
  private cellW = CELL;
  private cellH = CELL;
  /** +0xf8 */
  private state = 0;
  /** +0x100: the dialog the icon flies to. */
  private target: TSWin | null = null;
  /** +0x104..+0x110 */
  private lastTarget: Rect = { left: -1, top: -1, right: -1, bottom: -1 };
  /** +0x114..+0x150: the four edge ramps and their end. */
  private ramp: { from: Rect; to: Rect; start: number; end: number } | null = null;
  /** Bumped by every SetIcon, so that a late load does not override a newer one. */
  private iconSerial = 0;

  constructor(
    /** ObjectModule::ShowTutorialInfo */
    private readonly showTutorialInfo: () => void,
  ) {
    super();
  }

  /** cTutorialIcon::Init */
  override async init(): Promise<boolean> {
    this.state = 0;
    this.home = { left: HOME_RIGHT - this.cellW, top: 0, right: HOME_RIGHT, bottom: this.cellH };
    this.setArea(this.home.left, this.home.top, this.home.right, this.home.bottom);
    this.winCursor = getCursor(0);
    return true;
  }

  /** cTutorialIcon::SetIconTopRight */
  setIconTopRight(x: number, y: number): void {
    this.state = 0;
    this.home = { left: x - this.cellW, top: y, right: x, bottom: y + this.cellH };
    this.setArea(this.home.left, this.home.top, this.home.right, this.home.bottom);
  }

  /** cTutorialIcon::SetIcon(file, id): the BMP_ chunk `id` of the object's file. */
  async setIcon(file: ResFile | null, id: number): Promise<void> {
    const serial = ++this.iconSerial;
    this.icon?.close();
    this.icon = null;
    const bytes = file?.get("BMP_", id) ?? null;
    let img: ImageBitmap | null = null;
    if (bytes) {
      try {
        const d = decodeImage(bytes, "icon.bmp", { colorKey: true });
        img = await createImageBitmap(new ImageData(d.data, d.width, d.height));
      } catch {
        img = null;
      }
    }
    if (serial !== this.iconSerial) {
      img?.close();
      return;
    }
    this.icon = img;
    if (!img) {
      this.cellW = CELL;
      this.cellH = CELL;
    } else {
      this.row = 0;
      this.col = 0;
      if (img.width === CELL) this.cols = 1;
      if (img.height === CELL) this.rows = 1;
      this.cellW = Math.trunc(img.width / this.cols);
      this.cellH = Math.trunc(img.height / this.rows);
    }
    const { left, top } = this.area;
    this.setArea(left, top, left + this.cellW, top + this.cellH);
  }

  /** cTutorialIcon::ObjectChanged: `file` is the tutorial object's file, null without one. */
  objectChanged(file: ResFile | null): void {
    this.state = 0;
    this.lastTarget = { left: -1, top: -1, right: -1, bottom: -1 };
    if (!file) {
      this.hideWindow();
      return;
    }
    this.showWindow();
    void this.setIcon(file, ICON_BMP).then(() => {
      if (this.state === 0) this.setArea(this.home.left, this.home.top, this.home.right, this.home.bottom);
    });
    this.setArea(this.home.left, this.home.top, this.home.right, this.home.bottom);
  }

  /** cTutorialIcon::StartOpenAnimation */
  startOpenAnimation(dlg: TSWin): void {
    this.target = dlg;
    const a = this.area;
    const h = this.home;
    this.state = a.left === h.left && a.right === h.right && a.top === h.top && a.bottom === h.bottom ? 1 : 5;
  }

  /** cTutorialIcon::StartCloseAnimation */
  startCloseAnimation(dlg: TSWin): void {
    const r = dlg.area;
    this.setArea(r.left, r.top, r.right, r.bottom);
    this.lastTarget = { ...r };
    this.state = 3;
  }

  /** cTutorialIcon::GetLastTargetArea: null when empty. */
  getLastTargetArea(): Rect | null {
    const r = this.lastTarget;
    return r.left < r.right && r.top < r.bottom ? { ...r } : null;
  }

  /** cTutorialIcon::SetLastTargetArea */
  setLastTargetArea(r: Rect): void {
    this.lastTarget = { ...r };
  }

  /** cTutorialIcon::Animate */
  animate(): void {
    if (this.state === 0) return;
    const now = performance.now();
    const fly = (from: Rect, to: Rect): void => {
      this.ramp = { from: { ...from }, to: { ...to }, start: now, end: now + FLY_MS };
    };
    if (this.state === 1) {
      if (this.target) fly(this.area, this.target.area);
      this.state = 2;
    } else if (this.state === 3) {
      fly(this.lastTarget, this.home);
      this.state = 4;
    } else if (this.state === 5) {
      fly(this.lastTarget, this.home);
      this.state = 6;
    }
    const done = this.ramp !== null && now >= this.ramp.end;
    if (this.state === 4 && done) {
      this.setArea(this.home.left, this.home.top, this.home.right, this.home.bottom);
      this.state = 0;
    } else if (this.state === 2 && done) {
      this.hideWindow();
      this.state = 0;
      this.target?.showWindow();
      this.target = null;
    } else if (this.state === 6 && done) {
      this.setArea(this.home.left, this.home.top, this.home.right, this.home.bottom);
      this.state = 1;
    }
    const r = this.ramp;
    if (this.state !== 0 && r) {
      const t = Math.min(1, Math.max(0, (now - r.start) / FLY_MS));
      const v = (a: number, b: number): number => Math.trunc(a + (b - a) * t);
      this.setArea(v(r.from.left, r.to.left), v(r.from.top, r.to.top), v(r.from.right, r.to.right), v(r.from.bottom, r.to.bottom));
    }
  }

  /** cTutorialIcon::TSPaint */
  override tsPaint(g: Gfx): void {
    const img = this.icon;
    if (img && this.state === 0) {
      const w = Math.trunc(img.width / this.cols);
      const h = Math.trunc(img.height / this.rows);
      g.blitPart(img, w * this.col, h * this.row, w, h, 0, 0);
      return;
    }
    // DrawRectangleOutline black, white, black, each one pixel further in.
    const w = this.getW();
    const h = this.getH();
    const colors = ["#000000", "#ffffff", "#000000"];
    colors.forEach((c, i) => {
      if (w - 2 * i > 0 && h - 2 * i > 0) g.frame(i, i, w - 2 * i, h - 2 * i, c);
    });
  }

  /** cTutorialIcon::TSOnMouseDownL */
  override tsOnMouseDownL(): boolean {
    if (this.state === 0) this.showTutorialInfo();
    return true;
  }

  /** cTutorialIcon::TSOnMouseDownR */
  override tsOnMouseDownR(): boolean {
    return true;
  }
}

/** cDDDSimsView +0x119c (cSimsApp+0x80's), null without a lot view. */
let current: TutorialIcon | null = null;

export function setTutorialIcon(icon: TutorialIcon | null): void {
  current = icon;
}

export function getTutorialIcon(): TutorialIcon | null {
  return current;
}
