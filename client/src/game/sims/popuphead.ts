/**
 * PopupHead (PopupHead.cpp) and its SAnimator entry points: the selected
 * sim's 3D head at the center of the Live mode pie menu, and the round
 * shadow under the pie.
 *
 * SAnimator keeps one PopupHead (lbl_105BADA8):
 *  - Start(pie, animator) (cObjPickerTool::DoMenu, once the people pie is
 *    up): the head is anchored at the people pie's center (GetPopupX +
 *    GetPopupCenterX, set on the first Render / GetLocation) and scales in
 *    over lbl_105BA3D0 = 400 ms;
 *  - GetLocation (HouseViewer::UpdateStaticDynamic, before the 3D pass): the
 *    round shadow's center and radius, sliding over 400 ms from where it was
 *    to the current pie's center (radius lbl_105BA3D4 = 100);
 *    StartSubmenu / StopSubmenu retarget it to the sub pie and back (the head
 *    itself stays at the people pie's center);
 *  - Render (after the 3D pass): the person's "HEAD" skins, deformed in their
 *    own space, with
 *      Scale(12 / (1 << zoom) * 1.75) * RotY(0.05 pi + tilt) * RotZ(0.5 pi)
 *      * RotY(-0.5 pi * (rotation - 0.5) + turn) * Translation(p)
 *    p being the anchor (14 px lower) unprojected at the overlay depth.
 *    tilt / turn = 0.3 / 60 plus sqrt(distance / 2000) * (cos, -sin) of the
 *    cursor's direction from the people pie's center, plus 0.6 toward the
 *    spoke of the highlighted item (0.4 on both for diagonals), eased in over
 *    lbl_105BA3C4 = 400 ms (sqrt(0.9 t + 0.1)) when the spoke changes.
 *    Ambient light 1.0 while an item is highlighted, 0.8 otherwise;
 *  - SetAttitude (cObjPickerTool::MenuItemChanged) and Nod
 *    (MenuItemSelected with Shift): the attitude is kept and smoothed
 *    (0.75 / 0.25) but nothing draws with it, the score argument is not read
 *    (both builds), and the nod's length and attitude (lbl_105BA3D8 /
 *    lbl_105BA3DC, DAT_006e5278 / DAT_006e527c on Windows) are BSS nothing
 *    writes: a nod faces the viewer for the current millisecond only.
 *
 * Here the head is drawn by the person renderer into a small offscreen WebGL
 * target under a camera at rotation 0 (the rotation and zoom terms cancel
 * out, as in cas/portraits.ts), then blitted at the anchor. The overlay depth
 * (HouseViewer::GetMin/MaxOverlayZ) does not change an axonometric image.
 */

import { headPerson, scaleTf, unproject } from "../cas/portraits.js";
import type { SimView } from "./camera.js";
import { mat4Mul, rotationTf, translationTf } from "./math3d.js";
import { SimRenderer } from "./renderer.js";
import type { VitaBoy } from "./vitaboy.js";

/** What PopupHead reads from a cTSPieMenu. */
export interface PopupHeadPie {
  getPopupX(): number;
  getPopupY(): number;
  getPopupCenterX(): number;
  getPopupCenterY(): number;
  getSelection(): number;
  getItemCount(): number;
  getDirection(): number;
  getDistance(): number;
  getInactiveRadius(): number;
  setSubMenu(sub: PopupHeadPie | null): void;
}

/** lbl_105BA3D0: scale-in / shadow slide time (ms). */
const ZOOM_TIME = 400;
/** lbl_105BA3C4: easing time toward a new spoke (ms). */
const TURN_TIME = 400;
/** lbl_105BA3D4: the round shadow's radius. */
const SHADOW_RADIUS = 100;
/** lbl_105BA3CC: head scale factor; lbl_105BBBE0+0x1c: base scale. */
const HEAD_SCALE = 1.75;
const BASE_SCALE = 12;
/** lbl_105BBBE0+0x20: the anchor sits this much below the pie center. */
const ANCHOR_DROP = 14;
/** lbl_105BA3C8 * 1000 / 60000: the resting tilt / turn. */
const REST_ANGLE = (0.3 * 1000) / 60000;
/** lbl_105BBBE0+0x10: distance divisor of the cursor term. */
const CURSOR_RANGE = 2000;
/** lbl_105BBBE0+0x2c / +0x30: spoke offsets (straight / diagonal). */
const SPOKE_STRAIGHT = 0.6;
const SPOKE_DIAGONAL = 0.4;
/** lbl_105BBBE0+0x14: attitude target past the inactive radius. */
const AWAY_ATTITUDE = -0.15;
/** lbl_105BA3D8 / lbl_105BA3DC (never written). */
const NOD_TIME = 0;
const NOD_ATTITUDE = 0;
/** lbl_105BA3E8 / lbl_105BA3E4 / lbl_105BA3E0 and lbl_105BBBE0[0]: SetAttitude. */
const ATTITUDE_DECAY = 0.2;
const ATTITUDE_MIN = 0.5;
const ATTITUDE_TARGET = 0.25;
const ATTITUDE_KEY_STEP = 0.5;
/** Offscreen target; the camera zoom (any: the model scale compensates). */
const AREA = 128;
const ZOOM = 3;
/** Any depth inside the clip range (axonometric projection). */
const ANCHOR_DEPTH = 32767;

/** lbl_105BA230: the millisecond clock. */
function now(): number {
  return Math.trunc(performance.now());
}

class PopupHead {
  /** +0x00 the people pie, +0x04 the current pie. */
  private pie: PopupHeadPie | null = null;
  private cur: PopupHeadPie | null = null;
  /** +0x08 / +0x0c: the person (its body strings and head). */
  private key = "";
  private head: VitaBoy | null = null;
  /** +0x10: scaling in. */
  private zooming = false;
  /** +0x14 / +0x18: the head's anchor (screen). */
  private startX = 0;
  private startY = 0;
  /** +0x1c..0x24: shadow location; +0x28..0x30 from, +0x34..0x3c to. */
  private locX = 0;
  private locY = 0;
  private locZ = 0;
  private fromX = 0;
  private fromY = 0;
  private fromZ = 0;
  private toX = 0;
  private toY = 0;
  private toZ = 0;
  /** +0x40 / +0x44: nod start / end. */
  private nodStart = 0;
  private nodEnd = 0;
  /** +0x48: start of the scale-in / shadow slide. */
  private moveStart = 0;
  /** +0x4c / +0x50: start of the easing toward `lastSpoke`. */
  private turnStart = 0;
  private lastSpoke = -2;
  /** +0x54 / +0x58 */
  private attitude = 0;
  private attitudeTarget = 0;
  /** +0x5c / +0x60, and their values when the spoke changed (+0x70 / +0x6c). */
  private tilt = 0;
  private turn = 0;
  private turnFromTilt = 0;
  private turnFromTurn = 0;

  private gl: WebGL2RenderingContext | null = null;
  private canvas: OffscreenCanvas | null = null;
  private renderer: SimRenderer | null = null;
  private readonly heads = new Map<string, Promise<VitaBoy | null>>();

  isActive(): boolean {
    return this.pie !== null;
  }

  /** PopupHead::Start */
  start(pie: PopupHeadPie, bodyStrings: readonly string[], worn?: readonly { suit: string; texture: string }[]): void {
    this.startX = -1;
    this.startY = -1;
    this.locX = -1;
    this.locY = -1;
    this.nodStart = 0;
    this.nodEnd = 0;
    this.moveStart = 0;
    this.turnStart = 0;
    this.lastSpoke = -2;
    this.attitude = this.attitudeTarget = 0;
    this.tilt = this.turn = this.turnFromTilt = this.turnFromTurn = 0;
    this.zooming = true;
    this.pie = pie;
    this.cur = pie;
    this.moveStart = now();
    // GetHeadBindings reads the live person's dressing records; the head is loaded once per outfit.
    const key = `${bodyStrings.join("|")}#${(worn ?? []).map((w) => `${w.suit},${w.texture}`).join("|")}`;
    this.key = key;
    this.head = null;
    let p = this.heads.get(key);
    if (!p) {
      p = headPerson(bodyStrings, worn).catch(() => null);
      this.heads.set(key, p);
    }
    void p.then((vb) => {
      if (this.key === key) this.head = vb;
    });
    void this.initRenderer();
  }

  /** PopupHead::Stop */
  stop(): void {
    this.pie = null;
    this.cur = null;
    this.key = "";
    this.head = null;
  }

  /** PopupHead::StartSubmenu */
  startSubmenu(sub: PopupHeadPie): void {
    this.cur = sub;
    this.moveStart = now();
    this.zooming = false;
    this.pie?.setSubMenu(sub);
    this.fromX = this.locX;
    this.fromY = this.locY;
    this.fromZ = this.locZ;
  }

  /** PopupHead::StopSubmenu */
  stopSubmenu(): void {
    this.pie?.setSubMenu(null);
    this.cur = this.pie;
    this.moveStart = now();
    this.fromX = this.locX;
    this.fromY = this.locY;
    this.fromZ = this.locZ;
  }

  /** PopupHead::SetAttitude (the score is not read; Shift / Ctrl nudge it). */
  setAttitude(_score: number, shift: boolean, ctrl: boolean): void {
    if (ctrl) this.attitude -= ATTITUDE_KEY_STEP;
    if (shift) this.attitude += ATTITUDE_KEY_STEP;
    let a = this.attitude - ATTITUDE_DECAY;
    if (a < -1) a = -1;
    else if (a > 1) a = 1;
    else if (a < 0 && a > -ATTITUDE_MIN) a = -ATTITUDE_MIN;
    else if (a >= 0 && a < ATTITUDE_MIN) a = ATTITUDE_MIN;
    this.attitude = a;
    this.attitudeTarget = a * ATTITUDE_TARGET;
  }

  /** PopupHead::Nod */
  nod(): void {
    this.attitudeTarget = NOD_ATTITUDE;
    this.nodStart = now();
    this.nodEnd = this.nodStart + NOD_TIME;
  }

  /** The anchor and shadow targets once the people pie is placed (first GetLocation / Render). */
  private anchor(): void {
    if (this.startX !== -1 || !this.pie) return;
    this.startX = this.pie.getPopupCenterX() + this.pie.getPopupX();
    this.startY = this.pie.getPopupCenterY() + this.pie.getPopupY();
    this.fromX = this.startX;
    this.fromY = this.startY;
    this.fromZ = 0;
  }

  /** PopupHead::GetLocation: the round shadow's center and radius. */
  getLocation(): { x: number; y: number; z: number } {
    if (this.startX === -1) {
      this.anchor();
      this.toX = this.startX;
      this.toY = this.startY;
      this.toZ = SHADOW_RADIUS;
    }
    const f = (now() - this.moveStart) / ZOOM_TIME;
    if (f < 1) {
      this.locX = Math.trunc(this.fromX * (1 - f) + this.toX * f);
      this.locY = Math.trunc(this.fromY * (1 - f) + this.toY * f);
      this.locZ = Math.trunc(this.fromZ * (1 - f) + this.toZ * f);
    } else {
      this.locX = this.toX;
      this.locY = this.toY;
      this.locZ = this.toZ;
      this.zooming = false;
    }
    return { x: this.locX, y: this.locY, z: this.locZ };
  }

  private async initRenderer(): Promise<void> {
    if (this.canvas) return;
    this.canvas = new OffscreenCanvas(AREA, AREA);
    const gl = this.canvas.getContext("webgl2", { alpha: true, depth: true, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) return;
    this.gl = gl;
    this.renderer = await SimRenderer.create(gl);
  }

  /**
   * PopupHead::Render: draws the head on `ctx` (screen coordinates), clipped
   * to `clip` (the lot view).
   */
  render(ctx: CanvasRenderingContext2D, clip: { left: number; top: number; right: number; bottom: number }): void {
    const pie = this.pie;
    const cur = this.cur;
    if (!pie || !cur) return;
    const t = now();
    this.anchor();
    this.toX = cur.getPopupCenterX() + cur.getPopupX();
    this.toY = cur.getPopupCenterY() + cur.getPopupY();
    this.toZ = SHADOW_RADIUS;
    // The spoke (0 = up, clockwise) of the people pie's highlighted item.
    let spoke = pie.getSelection();
    const n = pie.getItemCount();
    if (this.nodEnd !== 0) spoke = -1;
    if (spoke >= 0) {
      if (n === 2) spoke <<= 2;
      else if (n >= 0 && n < 2) spoke = 0;
      else if (n > 2 && n < 8) {
        if (n < 5) spoke <<= 1;
      } else if (spoke > 7) spoke = spoke & 1 ? 4 : 0;
    }
    const dir = pie.getDirection();
    const reach = Math.sqrt(pie.getDistance() / CURSOR_RANGE);
    let turnOff = reach * -Math.sin(dir);
    let tiltOff = reach * Math.cos(dir);
    if (this.nodEnd !== 0) turnOff = tiltOff = 0;

    const vb = this.head;
    const gl = this.gl;
    const r = this.renderer;
    if (vb && gl && r && this.canvas) {
      const ambient = spoke === -1 ? 0.8 : 1;
      let scale = BASE_SCALE / (1 << ZOOM);
      let drop = ANCHOR_DROP;
      const since = t - this.moveStart;
      if (this.zooming && since < ZOOM_TIME) {
        const f = since / ZOOM_TIME;
        scale *= f;
        drop = Math.trunc(ANCHOR_DROP * f);
      }
      scale *= HEAD_SCALE;
      this.tilt = REST_ANGLE + tiltOff;
      this.turn = REST_ANGLE + turnOff;
      if (spoke !== this.lastSpoke) {
        this.lastSpoke = spoke;
        this.turnStart = t;
        this.turnFromTurn = this.turn;
        this.turnFromTilt = this.tilt;
        this.nodStart = 0;
      }
      switch (spoke) {
        case 0:
          this.tilt += SPOKE_STRAIGHT;
          break;
        case 1:
          this.tilt += SPOKE_DIAGONAL;
          this.turn -= SPOKE_DIAGONAL;
          break;
        case 2:
          this.turn -= SPOKE_STRAIGHT;
          break;
        case 3:
          this.tilt -= SPOKE_DIAGONAL;
          this.turn -= SPOKE_DIAGONAL;
          break;
        case 4:
          this.tilt -= SPOKE_STRAIGHT;
          break;
        case 5:
          this.tilt -= SPOKE_DIAGONAL;
          this.turn += SPOKE_DIAGONAL;
          break;
        case 6:
          this.turn += SPOKE_STRAIGHT;
          break;
        case 7:
          this.turn += SPOKE_DIAGONAL;
          this.tilt += SPOKE_DIAGONAL;
          break;
      }
      if (this.turnStart !== 0) {
        const e = t - this.turnStart;
        if (e < TURN_TIME) {
          const f = Math.sqrt(0.9 * (e / TURN_TIME) + 0.1);
          this.turn = this.turnFromTurn * (1 - f) + this.turn * f;
          this.tilt = this.turnFromTilt * (1 - f) + this.tilt * f;
        } else if (e < 2 * TURN_TIME) {
          if (spoke === -1) this.attitudeTarget = pie.getInactiveRadius() <= pie.getDistance() ? AWAY_ATTITUDE : 0;
        } else {
          this.turnStart = 0;
        }
      }
      const view: SimView = { zoom: ZOOM, rotation: 0, originX: 0, originY: 0, width: AREA, height: AREA };
      const cam = r.cameraFor(view);
      const p = unproject(cam, AREA / 2, AREA / 2, ANCHOR_DEPTH);
      let model = scaleTf(scale);
      model = mat4Mul(model, rotationTf(1, 0.05 * Math.PI + this.tilt));
      model = mat4Mul(model, rotationTf(2, 0.5 * Math.PI));
      model = mat4Mul(model, rotationTf(1, -0.5 * Math.PI * (view.rotation - 0.5) + this.turn));
      model = mat4Mul(model, translationTf(p));
      gl.viewport(0, 0, AREA, AREA);
      gl.clearColor(0, 0, 0, 0);
      gl.clearDepth(1);
      gl.depthMask(true);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      r.renderSimModel(vb, model, view, { ambient });
      ctx.save();
      ctx.beginPath();
      ctx.rect(clip.left, clip.top, clip.right - clip.left, clip.bottom - clip.top);
      ctx.clip();
      ctx.drawImage(this.canvas, this.startX - AREA / 2, this.startY + drop - AREA / 2);
      ctx.restore();
    }
    if (this.nodEnd !== 0 && this.nodEnd < t) this.nodEnd = 0;
    this.attitude = 0.75 * this.attitude + 0.25 * this.attitudeTarget;
  }
}

/** SAnimator's PopupHead (lbl_105BADA8). */
const popupHead = new PopupHead();

/** SAnimator::StartPopupHead */
export function startPopupHead(pie: PopupHeadPie, bodyStrings: readonly string[], worn?: readonly { suit: string; texture: string }[]): void {
  popupHead.start(pie, bodyStrings, worn);
}

/** SAnimator::StopPopupHead */
export function stopPopupHead(): void {
  popupHead.stop();
}

/** SAnimator::StartPopupHeadSubmenu */
export function startPopupHeadSubmenu(sub: PopupHeadPie): void {
  if (popupHead.isActive()) popupHead.startSubmenu(sub);
}

/** SAnimator::StopPopupHeadSubmenu */
export function stopPopupHeadSubmenu(): void {
  if (popupHead.isActive()) popupHead.stopSubmenu();
}

/** SAnimator::SetPopupHeadAttitude */
export function setPopupHeadAttitude(score: number, shift: boolean, ctrl: boolean): void {
  if (popupHead.isActive()) popupHead.setAttitude(score, shift, ctrl);
}

/** SAnimator::NodPopupHead */
export function nodPopupHead(): void {
  if (popupHead.isActive()) popupHead.nod();
}

/** SAnimator::GetPopupHeadLocation: null while no pie is up. */
export function getPopupHeadLocation(): { x: number; y: number; z: number } | null {
  return popupHead.isActive() ? popupHead.getLocation() : null;
}

/** SAnimator::RenderPopupHead */
export function renderPopupHead(ctx: CanvasRenderingContext2D, clip: { left: number; top: number; right: number; bottom: number }): void {
  if (popupHead.isActive()) popupHead.render(ctx, clip);
}

let shadowScratch: OffscreenCanvasRenderingContext2D | null = null;

/**
 * HouseViewer::RenderRoundShadow over the 16-bit back buffer: inside the
 * circle of radius `r` around (x, y) (clipped to `clip`) every pixel turns
 * gray, (r + g + b) / 6 + 8, fading back to its color over the outer third
 * of the radius ((d^2 - ri^2) * 256 / (r^2 - ri^2)); the result is stored
 * as 565. The z-buffer test (depth > 0) passes for every drawn lot pixel.
 */
export function renderRoundShadow(ctx: CanvasRenderingContext2D, clip: { left: number; top: number; right: number; bottom: number }, x: number, y: number, r: number): void {
  let left = x - r;
  let top = y - r;
  let right = x + r;
  let bottom = y + r;
  let skipX = 0;
  let skipY = 0;
  if (clip.left - left > 0) {
    skipX = clip.left - left;
    left = clip.left;
  }
  if (clip.top - top > 0) {
    skipY = clip.top - top;
    top = clip.top;
  }
  if (right > clip.right) right = clip.right;
  if (bottom > clip.bottom) bottom = clip.bottom;
  const w = right - left;
  const h = bottom - top;
  if (w <= 0 || h <= 0) return;
  // read back through a CPU-side scratch canvas
  if (!shadowScratch || shadowScratch.canvas.width < w || shadowScratch.canvas.height < h) {
    shadowScratch = new OffscreenCanvas(Math.max(w, 2 * SHADOW_RADIUS), Math.max(h, 2 * SHADOW_RADIUS)).getContext("2d", { willReadFrequently: true });
    if (!shadowScratch) return;
  }
  const sc = shadowScratch;
  sc.clearRect(0, 0, w, h);
  sc.drawImage(ctx.canvas, left, top, w, h, 0, 0, w, h);
  const img = sc.getImageData(0, 0, w, h);
  const d = img.data;
  const ri = r - Math.trunc(r / 3);
  const ri2 = ri * ri;
  for (let row = 0; row < h; row++) {
    const dy = row + skipY - r;
    for (let col = 0; col < w; col++) {
      const dx = col + skipX - r;
      const d2 = dx * dx + dy * dy;
      if (d2 >= r * r) continue;
      const i = (row * w + col) * 4;
      // the buffer's 565 pixel expanded to 24 bits
      const cr = d[i]! & 0xf8;
      const cg = d[i + 1]! & 0xfc;
      const cb = d[i + 2]! & 0xf8;
      let gray = Math.trunc((cg + cr + cb) / 6) + 8;
      let or = gray;
      let og = gray;
      let ob = gray;
      const k = d2 - ri2;
      if (k > 0) {
        const a = Math.max(0, Math.min(0xff, Math.trunc((k * 0x100) / (r * r - ri2))));
        gray *= 0xff - a;
        or = (gray + a * cr) >> 8;
        og = (gray + a * cg) >> 8;
        ob = (gray + a * cb) >> 8;
      }
      d[i] = or & 0xf8;
      d[i + 1] = og & 0xfc;
      d[i + 2] = ob & 0xf8;
    }
  }
  sc.putImageData(img, 0, 0);
  ctx.drawImage(sc.canvas, 0, 0, w, h, left, top, w, h);
}
