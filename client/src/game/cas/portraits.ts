/**
 * The portraits a character file stores (BMP_ 2002..2007), as
 * PersonFinder::GenerateBitmaps(person, all, save) makes them
 * (PeopleButtons.cpp):
 *
 *   2002 "faces"        MakePersonBtnImage        105x41: three 35x41 heads
 *                                                 (yaw 0 / +9 / -9 deg, turn 0 / -7 / +7 deg) on 565 color 0x000a
 *   2003 rel. images    MakeRelationshipBtnImage  200x40: five 40x40 heads (-5 / 18 deg)
 *                                                 on the colors of lbl_105BC1C4
 *   2004 newimage       DrawPersonThumbnail       kPeopleThumbnailBackground with a
 *                                                 (w-2)x(h-2) head on black at (1, 1)
 *   2005 / 2006         MakeSpeakingIcon(2 / 3)   kSpeechMediumBmp / kSpeechLargeBmp with a
 *                                                 16x16 / 32x32 shrink-wrapped head (-5 / 18 deg)
 *   2007 web_image      MakeWebBtn                kWebPeopleTemplate with a 35x41 head at (5, 2)
 *
 * MakePersonHeadImage(person, yaw, turn, w, h, margins, bgColor, out, crop):
 *  - only the skins bound to the "HEAD" bone (GetHeadBindings) are drawn,
 *    deformed in their own space (SkeletonBinding::Deform(true): identity
 *    bone transform, blends applied), with the model transform
 *      Scale(30 / (1 << scale)) * RotY(0.05 pi + yaw) * RotZ(0.5 pi)
 *      * RotY(-0.5 pi * (rotation - 0.5) + turn) * Translation(p)
 *    (lbl_105BC1D4 = {0, 180, 100, 1, 0.5, 30, 0.05, -0.5}), p being screen
 *    point (100, 100) at depth 32767 unprojected (cAnimDeviceSub+0xa4), into
 *    a 200x200 corner of the 3D render target filled with bgColor;
 *  - ambient light 1.0 plus a directional light (the white material
 *    saturates: texture colors come out unlit);
 *  - the crop is `crop` (every maker but the speaking icons passes
 *    {76, 45, 122, 125}) or the ShrinkWrap of the non-background pixels less
 *    the margins; it is widened (centered, then downward / rightward) to the
 *    w:h aspect and resampled to w x h (ScaleBitmap).
 *
 * Here the render target is an offscreen WebGL2 canvas drawn with the person
 * renderer (sims/renderer.ts renderSimModel) under the lot camera at
 * rotation 0 (scale and rotation cancel out in the formula above). The game's
 * buffers are 16-bit: every color is quantized to 565 and expanded back
 * (x << 3 / x << 2, as in the shipped files) when saved as 24-bit.
 *
 * Approximation: ScaleBitmap's filter (a separable weighted resample whose
 * support grows with the reduction) is a tent filter of radius 1 / scale.
 */

import { encodeBmp } from "../data/bmpwrite.js";
import { UIRes } from "../res/uires.js";
import { BodyStrings, BS } from "../sims/bodystrings.js";
import { VERTEX_FLOATS, type SkeletonBinding } from "../sims/deformablemesh.js";
import { mat4Mul, rotationTf, translationTf, type Mat4, type Vec3 } from "../sims/math3d.js";
import { AnimDeviceCamera, type SimView } from "../sims/camera.js";
import { SimRenderer } from "../sims/renderer.js";
import { VBAnimMgr } from "../sims/vbanimmgr.js";
import { VitaBoy, type DressingMesh } from "../sims/vitaboy.js";

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 200x200 scratch area of the render target. */
const AREA = 200;
/** The fixed crop every maker but MakeSpeakingIcon passes. */
const HEAD_CROP: Rect = { left: 0x4c, top: 0x2d, right: 0x7a, bottom: 0x7d };
const NO_MARGINS: Rect = { left: 0, top: 0, right: 0, bottom: 0 };
/** lbl_105C0688: depth of the head's anchor point. */
const ANCHOR_DEPTH = 32767;
/** lbl_105BC1D8: the face size; lbl_105BC1D0: where MakeWebBtn puts it. */
const FACE = { w: 0x23, h: 0x29 };
const WEB_FACE_ORIGIN = { x: 5, y: 2 };
/** lbl_105BC1C4: background of each relationship head (24-bit, made 565). */
const REL_COLORS = [0xd10000, 0x882d2f, 0x405d5f, 0x20934c, 0x00ca39];
/** MakePersonBtnImage's background (565). */
const FACES_BG = 0x000a;
/** Angles in degrees (lbl_105C0670..0694). */
const FACE_YAWS = [0, 9, -9];
const FACE_TURNS = [0, -7, 7];
const SIDE_YAW = -5;
const SIDE_TURN = 18;
/** The camera scale used (any: the model scale compensates). */
const ZOOM = 3;

const DEG = Math.PI / 180;
const fr = Math.fround;

type Pixels = { w: number; h: number; data: Uint8ClampedArray<ArrayBuffer> };

function rgb565(c24: number): number {
  return ((c24 >> 8) & 0xf800) | ((c24 >> 5) & 0x7e0) | ((c24 >> 3) & 0x1f);
}

function expand565(c: number): [number, number, number] {
  const r = (c >> 11) & 0x1f;
  const g = (c >> 5) & 0x3f;
  const b = c & 0x1f;
  return [r << 3, g << 2, b << 3];
}

/** Quantize to 565 and back, like a pixel of the game's 16-bit buffers. */
function quantize(p: Pixels): void {
  const d = p.data;
  for (let i = 0; i < d.length; i += 4) {
    const [r, g, b] = expand565(((d[i]! & 0xf8) << 8) | ((d[i + 1]! & 0xfc) << 3) | (d[i + 2]! >> 3));
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
    d[i + 3] = 255;
  }
}

function pixel565(p: Pixels, x: number, y: number): number {
  const i = (y * p.w + x) * 4;
  return ((p.data[i]! & 0xf8) << 8) | ((p.data[i + 1]! & 0xfc) << 3) | (p.data[i + 2]! >> 3);
}

function blit(dst: Pixels, src: Pixels, x0: number, y0: number): void {
  for (let y = 0; y < src.h; y++) {
    const dy = y0 + y;
    if (dy < 0 || dy >= dst.h) continue;
    for (let x = 0; x < src.w; x++) {
      const dx = x0 + x;
      if (dx < 0 || dx >= dst.w) continue;
      const s = (y * src.w + x) * 4;
      const d = (dy * dst.w + dx) * 4;
      for (let c = 0; c < 4; c++) dst.data[d + c] = src.data[s + c]!;
    }
  }
}

function solid(w: number, h: number, c565: number): Pixels {
  const data = new Uint8ClampedArray(w * h * 4);
  const [r, g, b] = expand565(c565);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  return { w, h, data };
}

/** A UI bitmap's raw pixels (the color key shows as magenta again). */
async function uiPixels(res: UIRes, id: number): Promise<Pixels> {
  const img = await res.image(id);
  const c = new OffscreenCanvas(img.width, img.height);
  const g = c.getContext("2d")!;
  g.fillStyle = "#ff00ff";
  g.fillRect(0, 0, img.width, img.height);
  g.drawImage(img, 0, 0);
  const data = g.getImageData(0, 0, img.width, img.height).data;
  const p = { w: img.width, h: img.height, data };
  quantize(p);
  return p;
}

/** SkeletonBinding::Deform(true): the mesh in its own space, then the blends. */
function deformIdentity(b: SkeletonBinding): void {
  const m = b.mesh;
  const src = m.vertices;
  const out = b.out;
  const real = m.realVertexCount;
  const copy = (first: number, count: number): void => {
    for (let i = first; i < first + count; i++) for (let c = 0; c < 6; c++) out[i * VERTEX_FLOATS + c] = src[i * 6 + c]!;
  };
  for (const bb of m.bindings) {
    copy(bb.firstVertex, bb.vertexCount);
    copy(real + bb.firstBlendVertex, bb.blendVertexCount);
  }
  const bl = m.blends;
  for (let k = 0; k < bl.length / 2; k++) {
    const w = bl[k * 2]!;
    if (w <= 0) continue;
    const d = bl[k * 2 + 1]! * VERTEX_FLOATS;
    const s = (real + k) * VERTEX_FLOATS;
    if (w < 0x8000) {
      const a = 32768 - w;
      for (let c = 0; c < 6; c++) out[d + c] = (1 / 32768) * (a * out[d + c]! + w * out[s + c]!);
      const l = Math.hypot(out[d + 3]!, out[d + 4]!, out[d + 5]!) || 1;
      for (let c = 3; c < 6; c++) out[d + c] = out[d + c]! / l;
    } else {
      for (let c = 0; c < 6; c++) out[d + c] = out[s + c]!;
    }
  }
}

/** GetHeadBindings: the skins of the worn suits bound to "HEAD", posed in their own space. */
async function headPerson(bodyStrings: readonly string[]): Promise<VitaBoy | null> {
  const mgr = await VBAnimMgr.get();
  const bs = new BodyStrings(bodyStrings);
  const skel = await mgr.findSkeleton(bs.get(BS.skeleton) || "adult");
  if (!skel) return null;
  const vb = new VitaBoy(mgr, skel.clone());
  const meshes: DressingMesh[] = [];
  // UpdateOutfitAndHands(1): head and body suits (hands bind to other bones).
  for (const index of [BS.head, BS.body]) {
    const { suit: name, texture } = bs.getSuitAndTexture(index);
    if (!name || name === "none") continue;
    const suit = await mgr.findSuit(name);
    if (!suit) continue;
    for (const skin of suit.skins) {
      if (skin.boneName !== "HEAD") continue;
      const mesh = await mgr.loadDeformableMesh(skin.meshName);
      const binding = mesh?.bind(vb.skeleton, texture || null);
      if (!binding) continue;
      deformIdentity(binding);
      meshes.push({ binding, image: await mgr.loadTexture(binding.texture) });
    }
  }
  if (!meshes.length) return null;
  vb.dressings.set("head", { suit: "", texture: "", meshes });
  vb.version++;
  return vb;
}

/** Row-vector 4x4 inverse (general). */
function invert(m: Mat4): Mat4 {
  const a = Array.from(m);
  const inv = new Float32Array(16);
  const r = Array.from({ length: 4 }, (_, i) => [...a.slice(i * 4, i * 4 + 4), ...[0, 1, 2, 3].map((j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let i = c + 1; i < 4; i++) if (Math.abs(r[i]![c]!) > Math.abs(r[p]![c]!)) p = i;
    [r[c], r[p]] = [r[p]!, r[c]!];
    const piv = r[c]![c]!;
    for (let j = 0; j < 8; j++) r[c]![j]! /= piv;
    for (let i = 0; i < 4; i++) {
      if (i === c) continue;
      const f = r[i]![c]!;
      for (let j = 0; j < 8; j++) r[i]![j]! -= f * r[c]![j]!;
    }
  }
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) inv[i * 4 + j] = r[i]![j + 4]!;
  return inv;
}

/** Screen point at a z-buffer depth back to world space (cAnimDeviceSub+0xa4). */
function unproject(cam: AnimDeviceCamera, x: number, y: number, depth: number): Vec3 {
  const w = cam.projection[15]!;
  const clip = [((2 * x) / cam.v.width - 1) * w, (1 - (2 * y) / cam.v.height) * w, (depth / 65535) * w, w];
  const inv = invert(cam.viewProjection);
  const o = [0, 0, 0, 0];
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) o[j]! += clip[i]! * inv[i * 4 + j]!;
  return [o[0]! / o[3]!, o[1]! / o[3]!, o[2]! / o[3]!];
}

function scaleTf(s: number): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = s;
  m[15] = 1;
  return m;
}

/** ShrinkWrap: insets that leave only the pixels differing from the background. */
function shrinkWrap(p: Pixels, r: Rect, bg: number): Rect | null {
  let l = r.right;
  let t = r.bottom;
  let rr = r.left - 1;
  let b = r.top - 1;
  for (let y = r.top; y < r.bottom; y++) {
    for (let x = r.left; x < r.right; x++) {
      if (pixel565(p, x, y) === bg) continue;
      l = Math.min(l, x);
      rr = Math.max(rr, x);
      t = Math.min(t, y);
      b = Math.max(b, y);
    }
  }
  if (rr < l) return null;
  return { left: l - r.left, top: t - r.top, right: r.right - 1 - rr, bottom: r.bottom - 1 - b };
}

/** ScaleBitmap(sx, sy, buffer, rect): separable tent-filtered resample of `r` to w x h. */
function scaleBitmap(p: Pixels, r: Rect, w: number, h: number): Pixels {
  const pass = (srcW: number, srcH: number, get: (x: number, y: number, c: number) => number, dstW: number, horizontal: boolean): Float32Array => {
    const outW = horizontal ? dstW : srcW;
    const outH = horizontal ? srcH : dstW;
    const n = horizontal ? srcW : srcH;
    const scale = dstW / n;
    const radius = Math.max(1, 1 / scale);
    const out = new Float32Array(outW * outH * 3);
    for (let o = 0; o < dstW; o++) {
      const center = (o + 0.5) / scale - 0.5;
      const lo = Math.max(0, Math.ceil(center - radius));
      const hi = Math.min(n - 1, Math.floor(center + radius));
      const taps: [number, number][] = [];
      let sum = 0;
      for (let s = lo; s <= hi; s++) {
        const wt = Math.max(0, 1 - Math.abs(s - center) / radius);
        if (wt > 0) {
          taps.push([s, wt]);
          sum += wt;
        }
      }
      if (!taps.length) taps.push([Math.min(n - 1, Math.max(0, Math.round(center))), (sum = 1)]);
      const other = horizontal ? srcH : srcW;
      for (let k = 0; k < other; k++) {
        for (let c = 0; c < 3; c++) {
          let v = 0;
          for (const [s, wt] of taps) v += wt * (horizontal ? get(s, k, c) : get(k, s, c));
          const idx = horizontal ? (k * outW + o) * 3 + c : (o * outW + k) * 3 + c;
          out[idx] = v / sum;
        }
      }
    }
    return out;
  };
  const cw = r.right - r.left;
  const ch = r.bottom - r.top;
  const h1 = pass(cw, ch, (x, y, c) => p.data[((r.top + y) * p.w + r.left + x) * 4 + c]!, w, true);
  const v = pass(w, ch, (x, y, c) => h1[(y * w + x) * 3 + c]!, h, false);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.round(v[i * 3 + c]!);
    data[i * 4 + 3] = 255;
  }
  const out = { w, h, data };
  quantize(out);
  return out;
}

class HeadCamera {
  private readonly canvas: OffscreenCanvas;
  private readonly gl: WebGL2RenderingContext;
  private renderer: SimRenderer | null = null;
  private readonly view: SimView = { zoom: ZOOM, rotation: 0, originX: 0, originY: 0, width: AREA, height: AREA };

  constructor() {
    this.canvas = new OffscreenCanvas(AREA, AREA);
    const gl = this.canvas.getContext("webgl2", { alpha: false, depth: true, antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL2 unavailable");
    this.gl = gl;
  }

  async init(): Promise<void> {
    this.renderer = await SimRenderer.create(this.gl);
  }

  /** The 200x200 area with the head drawn on `bg` (565). */
  render(vb: VitaBoy, yaw: number, turn: number, bg: number): Pixels {
    const gl = this.gl;
    const r = this.renderer!;
    const cam = r.cameraFor(this.view);
    const anchor = unproject(cam, AREA * 0.5, AREA * 0.5, ANCHOR_DEPTH);
    const rotation = this.view.rotation;
    let model = scaleTf(fr(30 / (1 << this.view.zoom)));
    model = mat4Mul(model, rotationTf(1, fr(0.05 * Math.PI + yaw)));
    model = mat4Mul(model, rotationTf(2, fr(0.5 * Math.PI)));
    model = mat4Mul(model, rotationTf(1, fr(-0.5 * Math.PI * (rotation - 0.5) + turn)));
    model = mat4Mul(model, translationTf(anchor));
    const [cr, cg, cb] = expand565(bg);
    gl.viewport(0, 0, AREA, AREA);
    gl.clearColor(cr / 255, cg / 255, cb / 255, 1);
    gl.clearDepth(1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    r.renderSimModel(vb, model, this.view, { ambient: 1 });
    const raw = new Uint8Array(AREA * AREA * 4);
    gl.readPixels(0, 0, AREA, AREA, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    const data = new Uint8ClampedArray(AREA * AREA * 4);
    for (let y = 0; y < AREA; y++) data.set(raw.subarray((AREA - 1 - y) * AREA * 4, (AREA - y) * AREA * 4), y * AREA * 4);
    const p = { w: AREA, h: AREA, data };
    quantize(p);
    return p;
  }

  /** MakePersonHeadImage */
  headImage(vb: VitaBoy, yaw: number, turn: number, w: number, h: number, margins: Rect, bg: number, crop: Rect | null): Pixels {
    const area = this.render(vb, yaw, turn, bg);
    let r: Rect;
    if (crop) {
      r = { ...crop };
    } else {
      const s = shrinkWrap(area, { left: 0, top: 0, right: AREA, bottom: AREA }, bg) ?? NO_MARGINS;
      // The margins are kept: an inset only shrinks past them.
      const left = margins.left <= s.left ? s.left - margins.left : s.left;
      const right = margins.right <= s.right ? s.right - margins.right : s.right;
      const top = margins.top <= s.top ? s.top - margins.top : s.top;
      const bottom = margins.bottom <= s.bottom ? s.bottom - margins.bottom : s.bottom;
      r = { left, top, right: AREA - right, bottom: AREA - bottom };
    }
    const want = fr(w / h);
    const have = fr((r.right - r.left) / (r.bottom - r.top));
    if (want < have) {
      let extra = Math.min(AREA, Math.trunc(fr(0.5 + fr((r.right - r.left) / want)))) - (r.bottom - r.top);
      for (; extra > 1 && r.top > 0 && r.bottom < AREA; r.bottom++) {
        extra -= 2;
        r.top--;
      }
      for (; extra > 0 && r.bottom < AREA; r.bottom++) extra--;
    } else if (have < want) {
      let extra = Math.min(AREA, Math.trunc(fr(want * (r.bottom - r.top) + 0.5))) - (r.right - r.left);
      for (; extra > 1 && r.left > 0 && r.right < AREA; r.right++) {
        extra -= 2;
        r.left--;
      }
      for (; extra > 0 && r.right < AREA; r.right++) extra--;
    }
    return scaleBitmap(area, r, w, h);
  }
}

/**
 * PersonFinder::GenerateBitmaps(all, save): BMP_ id -> 24-bit BMP bytes.
 * `res` supplies the template bitmaps (loaded when omitted).
 */
export async function generatePortraits(bodyStrings: readonly string[], res?: UIRes): Promise<Map<number, Uint8Array>> {
  const out = new Map<number, Uint8Array>();
  const vb = await headPerson(bodyStrings);
  if (!vb) return out;
  const ui = res ?? (await UIRes.load());
  const cam = new HeadCamera();
  await cam.init();
  const save = (id: number, p: Pixels): void => void out.set(id, encodeBmp(p.data, p.w, p.h, 24));

  // MakePersonBtnImage
  const faces = solid(FACE.w * 3, FACE.h, 0xf81f);
  for (let i = 0; i < 3; i++) {
    const head = cam.headImage(vb, FACE_YAWS[i]! * DEG, FACE_TURNS[i]! * DEG, FACE.w, FACE.h, NO_MARGINS, FACES_BG, HEAD_CROP);
    blit(faces, head, i * FACE.w, 0);
  }
  save(2002, faces);

  // MakeRelationshipBtnImage
  const rel = solid(200, 40, 0);
  REL_COLORS.forEach((c, i) => {
    blit(rel, cam.headImage(vb, SIDE_YAW * DEG, SIDE_TURN * DEG, 40, 40, NO_MARGINS, rgb565(c), HEAD_CROP), i * 40, 0);
  });
  save(2003, rel);

  // DrawPersonThumbnail (on a copy of kPeopleThumbnailBackground)
  const thumb = await uiPixels(ui, 0x6c);
  blit(thumb, cam.headImage(vb, 0, 0, thumb.w - 2, thumb.h - 2, NO_MARGINS, 0, HEAD_CROP), 1, 1);
  save(2004, thumb);

  // MakeSpeakingIcon(2) and (3): the head over the bubble, background = its top-left pixel.
  for (const [id, res, size] of [
    [2005, 9000, 16],
    [2006, 9001, 32],
  ] as const) {
    const bubble = await uiPixels(ui, res);
    const head = cam.headImage(vb, SIDE_YAW * DEG, SIDE_TURN * DEG, size, size, NO_MARGINS, pixel565(bubble, 0, 0), null);
    blit(bubble, head, 0, 0);
    save(id, bubble);
  }

  // MakeWebBtn
  const web = await uiPixels(ui, 0x11fa);
  blit(web, cam.headImage(vb, 0, 0, FACE.w, FACE.h, NO_MARGINS, pixel565(web, 0, 0), HEAD_CROP), WEB_FACE_ORIGIN.x, WEB_FACE_ORIGIN.y);
  save(2007, web);
  return out;
}
