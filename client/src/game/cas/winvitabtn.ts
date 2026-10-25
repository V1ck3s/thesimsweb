/**
 * cWinVitaBtn: the turning 3D person of Create-a-Sim.
 *
 * From the decompiled class:
 *  - the constructor takes the scale (Create-a-Sim: lbl_105BC6F4 = 5.0); Init
 *    starts a sine generator of amplitude pi * 0.25 (lbl_105BA324 *
 *    lbl_105BC77C[0]) and period 10 s;
 *  - UpdateTransform: RotationTf(Y, pi * 0.25 + sine) * ScaleTf(scale) *
 *    TranslationTf(p), where p is the screen point (horizontal center,
 *    bottom - 20) at depth 32767 taken back to world space through
 *    cAnimDeviceSub+0xa4 (the inverse of the view-projection);
 *  - TSPaint: clears the z-buffer, then renders the person's VitaBoy with
 *    the viewport's ambient light forced to white, over the window's
 *    captured background, and invalidates itself every frame.
 *
 * The house viewer is set to rotation 0 and scale 1 (far zoom) by
 * cWinDesignCharacter::Init before the button is made; the camera here is
 * that view, restricted to the button's rectangle.
 */

import { SimRenderer, type SAnimator, type SimView } from "../sims/index.js";
import { mat4Mul, rotationTf, translationTf, type Mat4, type Vec3 } from "../sims/math3d.js";
import { Gfx, TSWin } from "../ui/tswin.js";

/** lbl_105BC77C: [0.25, 32767, ...] (rotation base and amplitude in pi units, unprojected depth). */
const TURN = 0.25;
const DEPTH = 32767;
const PERIOD_MS = 10000;
/** Gap between the feet and the bottom of the button. */
const FEET = 20;

function scaleTf(s: number): Mat4 {
  const m = new Float32Array(16);
  m[0] = s;
  m[5] = s;
  m[10] = s;
  m[15] = 1;
  return m;
}

export class WinVitaBtn extends TSWin {
  private person: SAnimator | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private renderer: SimRenderer | null = null;
  private start = 0;

  constructor(readonly scale: number) {
    super();
  }

  override async init(): Promise<boolean> {
    this.start = performance.now();
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (gl) {
      this.canvas = canvas;
      this.renderer = await SimRenderer.create(gl);
    }
    return true;
  }

  /** cWinVitaBtn::SetPerson */
  setPerson(person: SAnimator | null): void {
    this.person = person;
  }

  private view(): SimView {
    return { zoom: 1, rotation: 0, originX: 0, originY: 0, width: this.getW(), height: this.getH() };
  }

  /** cWinVitaBtn::UpdateTransform */
  private updateTransform(now: number): Mat4 {
    const sine = TURN * Math.PI * Math.sin((2 * Math.PI * (now - this.start)) / PERIOD_MS);
    const rot = rotationTf(1, Math.fround(Math.PI * TURN + sine));
    const cam = this.renderer!.cameraFor(this.view());
    // cAnimDeviceSub+0xa4: screen (x, y, depth) back to world space (orthographic camera).
    const a = (this.getW() / 2 - (this.getW() >> 1)) * cam.upp;
    const b = ((this.getH() >> 1) - (this.getH() - FEET)) * cam.upp;
    const c = (DEPTH / 65535) * cam.projection[15]! / cam.projection[10]!;
    const p: Vec3 = [0, 1, 2].map((i) => cam.eye[i]! + a * cam.camX[i]! + b * cam.camY[i]! + c * cam.camZ[i]!) as Vec3;
    return mat4Mul(mat4Mul(rot, scaleTf(this.scale)), translationTf(p));
  }

  override tsPaint(g: Gfx): void {
    const person = this.person;
    const r = this.renderer;
    const canvas = this.canvas;
    if (!person || !r || !canvas) return;
    const w = this.getW();
    const h = this.getH();
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const now = performance.now();
    person.update(now);
    const gl = r.gl;
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    r.renderSimModel(person.vitaboy, this.updateTransform(now), this.view(), { ambient: 1 });
    g.ctx.drawImage(canvas, g.ox, g.oy);
  }
}
