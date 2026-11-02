/**
 * cWinPictureInPicture: the small live view of an event that the user event
 * primitive (35, cXObject::TryUserEvent -> GViewer::DoPictureInPicture ->
 * cDDDSimsView::DoPictureInPicture) opens over the lot view, with its
 * caption.
 *
 * From the decompiled class:
 *  - Init: a private buffer, the standard cursor, the tooltip (UIText STR#
 *    0x9c entry 1), the close box (kSMSystemDlgCloseBox, 4 frames) as a
 *    child button;
 *  - Open(obj, live, ms, scale, size, onlyIfHidden, snapshot, caption):
 *    refused while a timed window shows another object, and for an object
 *    on the lot's border tiles (tile < 1 or >= size - 1) or, with
 *    onlyIfHidden, already inside the view (cXObject::GetLastDamage);
 *    size 0 / 1 / 2 = 100 / 200 / 300 pixels square (lbl_105BC500,
 *    __sinit_WinPictureInPicture); the close box at (w - bw - 4, 4); the
 *    window at the parent's bottom right, 5 pixels in, raised by 0x69 above
 *    the control panel (0x9b for a double-byte UI; 5 in control panel mode
 *    1); the timer (ms) closes it; Fade(true) shows it;
 *  - BuildImage: GetCenterOnPt (the object's position, the average of its
 *    multi-tile group, the lot center without an object), the vertical
 *    shift (a person: 2 sqrt(6) x 2 << scale / 2 with the view's scale; an
 *    object: its damage rectangle's height (GetLastDamage(3)) >> (view scale
 *    - picture scale + 3)), then
 *    HouseViewer::DrawPictureInPicture at the window's scale and the
 *    object's level; the caption (font table entry 12, DrawTextPara 5
 *    pixels in, bottom aligned) unless the picture goes to the scrapbook;
 *    a 2-pixel black outline;
 *  - TSPaint rebuilds the picture each paint for a live window with the
 *    Live PIP option (TryUserEvent only opens windows with that option on);
 *  - a click scrolls the lot view to the object (ScrollToTile, smooth) and
 *    closes; Escape, the timer and the close box close; Close(obj) closes
 *    the window showing obj.
 *
 * Not ported: the auto snapshot into the family's scrapbook (cScrapbook::
 * AddPhoto), GetBoboVision's animated show / hide, cWinPeople::StopTracking.
 */

import type { GameContext } from "../context.js";
import { TSWinCtrlMgr } from "../ui/ctrlmgr.js";
import { TSWinBtn } from "../ui/btn.js";
import { ALIGN_LEFT, type FfnFont } from "../res/ffn.js";
import { UI_FONT_COLOR } from "../ui/syscolors.js";
import { Gfx, TSWin } from "../ui/tswin.js";
import type { HouseViewer } from "./houseviewer.js";
import type { XObject } from "./objects.js";
import { RotatableWorld } from "./world.js";
import { getStandardCursor } from "../ui/cursor.js";

/** lbl_105BC500: the three window sizes. */
const SIZES: ReadonlyArray<[number, number]> = [
  [100, 100],
  [200, 200],
  [300, 300],
];
/** UIText STR# 0x9c (LoadUIStrings(0x9c, GetStringConstant(9))): entry 1 is the tooltip. */
const STR_TOOLTIP = 0x9c;
const ID_CLOSE = 1;
/** lbl_105BC508[0] x lbl_105C0D68 and lbl_105BC504 { 2.0, 6.0 }: a person's half height factor. */
const PERSON_HEIGHT = (1 / 3) * 6 * (2 * Math.sqrt(6));

export interface PipHost {
  viewer(): HouseViewer | null;
  /** The parts of a multi-tile group (cXMTObject +0x190 / +0x18c chain). */
  groupOf(o: XObject): XObject[];
  /** cXObject::GetLastDamage(3): the screen rectangle the object last drew into (null: none). */
  damageRect(o: XObject): [number, number, number, number] | null;
  /** CPState::GetCPMode */
  cpMode(): number;
  /** cOptionsMgr::GetLivePIP */
  livePIP(): boolean;
}

export class WinPictureInPicture extends TSWin {
  /** +0xd0 */
  private obj: XObject | null = null;
  /** +0xde: a live picture (rebuilt each paint with the Live PIP option). */
  private live = false;
  /** +0xd4: the close timer (ms), and when it fires. */
  private timerMs = 0;
  private timerEnd = 0;
  /** +0xd8: the picture's zoom. */
  private pipScale = 0;
  /** +0xe0 */
  private caption = "";
  /** +0xe8: the picture goes to the scrapbook (no caption). */
  private snapshot = false;
  /** +0xe4 */
  private closeBox: TSWinBtn | null = null;
  private buffer: HTMLCanvasElement | null = null;
  private font: FfnFont | null = null;

  constructor(
    private readonly ctx: GameContext,
    private readonly host: PipHost,
  ) {
    super();
    this.hideWindow();
    // cWinPictureInPicture::Init: SetCursor(GetStandardCursor(0)).
    this.winCursor = getStandardCursor(0);
  }

  /** cWinPictureInPicture::Init */
  override async init(): Promise<boolean> {
    const ctx = this.ctx;
    this.tooltip = ctx.strings.get("UIText", STR_TOOLTIP, 0);
    const [mgr, box] = await Promise.all([TSWinCtrlMgr.get(ctx), ctx.res.image("kSMSystemDlgCloseBox").catch(() => null)]);
    this.font = mgr.tableFont(12);
    if (box) {
      const b = new TSWinBtn(ID_CLOSE, box, 4, 1);
      this.childAdd(b);
      this.closeBox = b;
    }
    return true;
  }

  /** cWinPictureInPicture::Open; false when refused. */
  open(
    obj: XObject,
    live: boolean,
    ms: number,
    scale: number,
    size: number,
    onlyIfHidden: boolean,
    snapshot: boolean,
    caption: string,
  ): boolean {
    if (this.timerMs !== 0) {
      if (this.obj !== obj) return false;
      this.timerMs = 0;
    }
    const v = this.host.viewer();
    if (!v) return false;
    const n = v.world.fixed.size;
    const tx = obj.tileX;
    const ty = obj.tileY;
    if (tx < 1 || tx >= n - 1 || ty < 1 || ty >= n - 1) return false;
    this.obj = obj;
    this.live = live;
    this.timerMs = ms;
    this.pipScale = scale;
    this.snapshot = snapshot;
    this.caption = caption;
    if (onlyIfHidden && this.isOnScreen(v, obj)) return false;
    const [w, h] = SIZES[size < 1 ? 0 : size < 2 ? 1 : 2]!;
    this.setArea(this.area.left, this.area.top, this.area.left + w, this.area.top + h);
    const box = this.closeBox;
    if (box) box.moveTo(w - box.getW() - 4, 4);
    const parent = this.parent;
    if (parent) {
      // (a double-byte UI raises it by 0x9b)
      const up = this.host.cpMode() === 1 ? 5 : 0x69;
      this.moveTo(parent.getW() - w - 5, parent.getH() - h - up);
    }
    if (this.timerMs !== 0) this.timerEnd = performance.now() + this.timerMs;
    this.fade(true);
    return true;
  }

  /** cWinPictureInPicture::Close */
  close(obj: XObject): void {
    if (this.obj !== obj) return;
    this.obj = null;
    this.live = false;
    this.fade(false);
    this.timerMs = 0;
  }

  /** The onlyIfHidden test: the object's damage rectangle inside the view (here its position). */
  private isOnScreen(v: HouseViewer, o: XObject): boolean {
    const [fx, fy] = RotatableWorld.rotateCoords(o.fx, o.fy, v.world.rotation, 0x400);
    const p = v.tileToPointF(fx, fy, o.level);
    return p.h >= 0 && p.v >= 0 && p.h < v.viewW && p.v < v.viewH;
  }

  /** cWinPictureInPicture::Fade (without BoboVision). */
  private fade(show: boolean): void {
    if (!show) {
      this.hideWindow();
      return;
    }
    if (!this.live || !this.host.livePIP()) this.buildImage();
    this.showWindow();
  }

  /** cWinPictureInPicture::HideWindow: the timer goes too. */
  override hideWindow(): void {
    this.timerMs = 0;
    super.hideWindow();
  }

  /** cWinPictureInPicture::GetCenterOnPt (fixed point, world coordinates). */
  private getCenterOnPt(v: HouseViewer): [number, number] {
    const o = this.obj;
    const half = (v.world.fixed.size >> 1) << 4;
    if (!o) return [half, half];
    if (o.kind !== "multiTile" && o.kind !== "portal") return [o.fx, o.fy];
    const parts = this.host.groupOf(o);
    if (!parts.length) return [o.fx, o.fy];
    // The tile centers' average (x / 16, rounded away from 0.5), back to fixed point.
    const avg = (f: (p: XObject) => number): number => {
      const a = (16 * parts.reduce((s, p) => s + f(p) * 0.0625, 0)) / parts.length;
      return Math.trunc(a >= 0 ? a + 0.5 : a - 0.5);
    };
    return [avg((p) => p.fx), avg((p) => p.fy)];
  }

  /** cWinPictureInPicture::BuildImage */
  private buildImage(): void {
    const v = this.host.viewer();
    const w = this.getW();
    const h = this.getH();
    if (!v || w <= 0 || h <= 0) return;
    const [cx, cy] = this.getCenterOnPt(v);
    if (cx < 0 || cy < 0) return;
    const o = this.obj;
    let shift = 0;
    if (o?.isPerson) shift = -Math.trunc(Math.trunc(PERSON_HEIGHT * (2 << v.scale)) / 2);
    else if (o) {
      // The damage rectangle's height at the view's scale, brought to the picture's scale, / 8
      // (bottom - top >> (scale - picture scale + 3)); an empty rectangle gives 0.
      const r = this.host.damageRect(o);
      if (r) shift = -((r[3] - r[1]) >> (v.scale - this.pipScale + 3));
    }
    const level = o ? o.level : v.level;
    if (this.buffer?.width !== w || this.buffer.height !== h) {
      this.buffer = document.createElement("canvas");
      this.buffer.width = w;
      this.buffer.height = h;
    }
    const g = this.buffer.getContext("2d")!;
    drawPictureInPicture(v, g, w, h, cx, cy, shift, level, this.pipScale);
    if (this.caption && !this.snapshot && this.font) {
      const f = this.font;
      const lines = f.calculateNumberOfLines(this.caption, w - 10);
      const bottom = h - 5;
      f.drawTextPara(g, { left: 5, top: bottom - lines * f.height, right: w - 5, bottom }, this.caption, ALIGN_LEFT, UI_FONT_COLOR);
    }
    // cScrapbook::AddPhoto is not ported: the snapshot picture is dropped.
    if (this.snapshot) {
      this.caption = "";
      this.snapshot = false;
    }
    g.strokeStyle = "#000";
    g.lineWidth = 2;
    g.strokeRect(1, 1, w - 2, h - 2);
  }

  override pump(nowMs: number): void {
    // TSOnTimerMsg
    if (this.timerMs !== 0 && performance.now() >= this.timerEnd) {
      this.timerMs = 0;
      this.fade(false);
    }
    super.pump(nowMs);
  }

  /** cWinPictureInPicture::TSPaint */
  override tsPaint(g: Gfx): void {
    if (this.live && this.host.livePIP()) this.buildImage();
    if (this.buffer) g.blit(this.buffer, 0, 0);
  }

  /** cWinPictureInPicture::TSOnMouseDownL: the lot view scrolls to the event, the window closes. */
  override tsOnMouseDownL(): boolean {
    const v = this.host.viewer();
    if (v) {
      const [cx, cy] = this.getCenterOnPt(v);
      const [fx, fy] = RotatableWorld.rotateCoords(cx, cy, v.world.rotation, 0x400);
      v.scrollToTile(fx, fy, this.obj ? this.obj.level : v.level, true);
    }
    this.fade(false);
    return true;
  }

  override tsOnKeyDown(key: string): boolean {
    if (key !== "Escape") return super.tsOnKeyDown(key);
    this.fade(false);
    return true;
  }

  override tsOnCommand(cmd: number, source: TSWin): boolean {
    if (cmd !== ID_CLOSE || source !== this.closeBox) return super.tsOnCommand(cmd, source);
    this.obj = null;
    this.live = false;
    this.fade(false);
    return true;
  }
}

/**
 * HouseViewer::DrawPictureInPicture: the lot drawn at `scale` and `level`,
 * the fixed-point world position (cx, cy) at the center of a w x h picture,
 * moved down by -shift (SetOffsets(x, y - shift)), the tool cursor left out.
 *
 * The view's level is changed the way HouseViewer::SetLevel does when it
 * differs (WallManager::SetCutaway, cCutawaySet::clear, ResetDynamicCutaway,
 * RoomManager::ComputeCutaway for the new level, DoDynamicCutaway), and put
 * back the same way after; the roof is not drawn (+0x51 cleared, restored).
 *
 * Port: the lot view's own renderer draws the frame with its origin, scale
 * and level swapped, the picture is read from the middle of its canvas, then
 * the view is restored and drawn again for the screen.
 */
function drawPictureInPicture(
  v: HouseViewer,
  g: CanvasRenderingContext2D,
  w: number,
  h: number,
  cx: number,
  cy: number,
  shift: number,
  level: number,
  scale: number,
): void {
  const n = v.world.fixed.size;
  if (cx >> 4 >= n || cy >> 4 >= n) return;
  const saved = { originX: v.originX, originY: v.originY, scale: v.scale, level: v.level, cursor: v.cursor, drawRoof: v.drawRoof };
  // Animator::SetPickingObject(0) for the picture (the picked object is cleared), restored after.
  const people = v.people;
  const picking = people?.pickPoint ?? null;
  try {
    if (people) people.pickPoint = null;
    v.scale = scale;
    v.setLevel(level);
    v.drawRoof = false;
    v.cursor = null;
    const [fx, fy] = RotatableWorld.rotateCoords(cx, cy, v.world.rotation, 0x400);
    const p = v.tileToPointF(fx, fy, level);
    v.originX += Math.trunc(v.viewW / 2) - p.h;
    v.originY += Math.trunc(v.viewH / 2) - p.v - shift;
    v.render();
    g.clearRect(0, 0, w, h);
    g.drawImage(v.comp.canvas, Math.trunc((v.viewW - w) / 2), Math.trunc((v.viewH - h) / 2), w, h, 0, 0, w, h);
  } finally {
    if (people) people.pickPoint = picking;
    v.originX = saved.originX;
    v.originY = saved.originY;
    v.scale = saved.scale;
    v.setLevel(saved.level);
    v.drawRoof = saved.drawRoof;
    v.cursor = saved.cursor;
    v.dirty = true;
  }
}
