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
 *  - a snapshot picture (the auto snapshots option, user event flag
 *    0x10) is a copy of the private buffer, without the caption and before
 *    the outline, added to the family's scrapbook (Family::GetScrapbook of
 *    the house's family, cScrapbook::AddPhoto with CPState::
 *    CamGetQualityValue) with the caption as its description when there is
 *    one (cScrapbook::SetDescription); the caption is then dropped;
 *  - TSPaint rebuilds the picture each paint for a live window with the
 *    Live PIP option (TryUserEvent only opens windows with that option on);
 *  - Fade: with interface effects (cOptionsMgr::GetBoboVision) the window
 *    fades in and out (cTSWin::AsyncShowHideWin(show, live)), else it is
 *    shown / hidden at once;
 *  - a click scrolls the lot view to the object (ScrollToTile, smooth),
 *    starts the fade out (AsyncShowHideWin, whatever the option) and
 *    closes; Escape, the timer and the close box close; Close(obj) closes
 *    the window showing obj.
 */

import type { GameContext } from "../context.js";
import { TSWinCtrlMgr } from "../ui/ctrlmgr.js";
import { TSWinBtn } from "../ui/btn.js";
import { ALIGN_LEFT, type FfnFont } from "../res/ffn.js";
import { DOUBLE_BYTE_UI } from "../res/uires.js";
import { UI_FONT_COLOR } from "../ui/syscolors.js";
import { Gfx, TSWin } from "../ui/tswin.js";
import type { HouseViewer, TerrainPassState } from "./houseviewer.js";
import type { XObject } from "./objects.js";
import { RotatableWorld } from "./world.js";
import { stopTracking } from "./tracking.js";
import { getStandardCursor } from "../ui/cursor.js";
import { getOptionsMgr } from "../optionsmgr.js";
import { currentScrapbook } from "../cpanel/camscrapbook.js";

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
  /**
   * Not part of the original (perf): this frame's live picture, drawn by
   * renderLive into the compositor's strip, as the lot view copied it with
   * its frame (src at (x, y)); tsPaint takes it instead of drawing again.
   */
  strip: { src: CanvasImageSource; x: number; y: number } | null = null;
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
      const up = this.host.cpMode() === 1 ? 5 : DOUBLE_BYTE_UI ? 0x9b : 0x69;
      // The lot view's right edge (the port's centred HUD: its band's, ctx.hud).
      const right = Math.min(parent.getW(), this.ctx.hud?.right ?? parent.getW());
      this.moveTo(right - w - 5, parent.getH() - h - up);
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

  /** cWinPictureInPicture::Fade */
  private fade(show: boolean): void {
    const bobo = getOptionsMgr().getBoboVision();
    if (!show) {
      if (bobo) this.asyncShowHideWin(false, this.live);
      else this.hideWindow();
      return;
    }
    if (!this.live || !this.host.livePIP()) this.buildImage();
    if (bobo) this.asyncShowHideWin(true, this.live);
    else this.showWindow();
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

  /** Not part of the original (perf): whether the lot view's frame should carry the live picture (renderLive). */
  wantsLive(): boolean {
    return this.live && this.host.livePIP() && this.isVisible() && this.getW() > 0 && this.getH() > 0;
  }

  /**
   * Not part of the original (perf): the live picture of this frame, drawn
   * by the lot view's paint after its own render and copied to the
   * compositor's strip (Compositor.presentStrip); false when not drawn.
   */
  renderLive(): boolean {
    const p = this.wantsLive() ? this.pictureParams() : null;
    if (!p) return false;
    return drawPictureInPicture(p.v, p.w, p.h, p.cx, p.cy, p.shift, p.level, this.pipScale, (left, top) =>
      p.v.comp.presentStrip(left, top, p.w, p.h),
    );
  }

  /** BuildImage's view of the picture: its size, centre, shift and level. */
  private pictureParams(): { v: HouseViewer; w: number; h: number; cx: number; cy: number; shift: number; level: number } | null {
    const v = this.host.viewer();
    const w = this.getW();
    const h = this.getH();
    if (!v || w <= 0 || h <= 0) return null;
    const [cx, cy] = this.getCenterOnPt(v);
    if (cx < 0 || cy < 0) return null;
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
    return { v, w, h, cx, cy, shift, level };
  }

  /** cWinPictureInPicture::BuildImage */
  private buildImage(): void {
    const p = this.pictureParams();
    if (!p) return;
    const { v, w, h, cx, cy, shift, level } = p;
    if (this.buffer?.width !== w || this.buffer.height !== h) {
      this.buffer = document.createElement("canvas");
      this.buffer.width = w;
      this.buffer.height = h;
    }
    const g = this.buffer.getContext("2d")!;
    // Not part of the original (perf): the live picture the lot view's frame carries (renderLive),
    // else drawn and read back here (the square of the frame, not the whole canvas).
    const strip = this.snapshot || !this.live || !this.host.livePIP() ? null : this.strip;
    this.strip = null;
    if (strip) g.drawImage(strip.src, strip.x, strip.y, w, h, 0, 0, w, h);
    else if (!drawPictureInPicture(v, w, h, cx, cy, shift, level, this.pipScale, (left, top) => {
      g.putImageData(v.comp.readColor(left, top, w, h), 0, 0);
      return true;
    }))
      return;
    if (this.caption && !this.snapshot && this.font) {
      const f = this.font;
      const lines = f.calculateNumberOfLines(this.caption, w - 10);
      const bottom = h - 5;
      f.drawTextPara(g, { left: 5, top: bottom - lines * f.height, right: w - 5, bottom }, this.caption, ALIGN_LEFT, UI_FONT_COLOR);
    }
    if (this.snapshot) {
      // cTSBuffer::Clone of the private buffer, into the family's album.
      const photo = new OffscreenCanvas(w, h);
      photo.getContext("2d")!.drawImage(this.buffer, 0, 0);
      const caption = this.caption;
      const ctx = this.ctx;
      void currentScrapbook(ctx)
        .then(async (book) => {
          if (!book || !(await book.addPhoto(photo, ctx.state.camGetQualityValue()))) return;
          if (caption) book.setDescription(caption);
        })
        .catch((e: unknown) => console.warn("pip: snapshot failed", e));
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
      stopTracking();
      v.scrollToTile(fx, fy, this.obj ? this.obj.level : v.level, true);
    }
    this.asyncShowHideWin(false, this.live);
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
/** The picture's own terrain pass (HouseViewer.swapTerrainState), kept between frames, by viewer. */
const pipTerrain = new WeakMap<HouseViewer, TerrainPassState>();

function drawPictureInPicture(
  v: HouseViewer,
  w: number,
  h: number,
  cx: number,
  cy: number,
  shift: number,
  level: number,
  scale: number,
  /** Takes the drawn square (its top left corner in the frame). */
  take: (left: number, top: number) => boolean,
): boolean {
  const n = v.world.fixed.size;
  if (cx >> 4 >= n || cy >> 4 >= n) return false;
  let drawn = false;
  const saved = { originX: v.originX, originY: v.originY, scale: v.scale, level: v.level, cursor: v.cursor, drawRoof: v.drawRoof };
  // Animator::SetPickingObject(0) for the picture (the picked object is cleared), restored after.
  const people = v.people;
  const picking = people?.pickPoint ?? null;
  // Not part of the original (perf): the picture keeps its own terrain, so that neither it nor
  // the lot view draws its whole terrain again each frame.
  const lotTerrain = v.swapTerrainState(pipTerrain.get(v) ?? null);
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
    const left = Math.trunc((v.viewW - w) / 2);
    const top = Math.trunc((v.viewH - h) / 2);
    // Not part of the original (perf): only the picture's square of the frame is drawn.
    const clip = { left, top, right: left + w, bottom: top + h };
    v.comp.setFrameClip(clip);
    v.pictureCull = clip;
    try {
      v.render(false);
    } finally {
      v.comp.setFrameClip(null);
      v.pictureCull = null;
    }
    drawn = take(left, top);
  } finally {
    pipTerrain.set(v, v.swapTerrainState(lotTerrain));
    if (people) people.pickPoint = picking;
    v.originX = saved.originX;
    v.originY = saved.originY;
    v.scale = saved.scale;
    v.setLevel(saved.level);
    v.drawRoof = saved.drawRoof;
    v.cursor = saved.cursor;
    v.dirty = true;
  }
  return drawn;
}
