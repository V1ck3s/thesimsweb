/**
 * Animator: the VitaBoy animator of a 3D object (cXObject::Initialize3D
 * makes one when OBJD +0xcc bit 0 is set; the plumb bobs are the only such
 * objects of the game). Ported here: what the plumb bobs use.
 *
 * - Animator::Initialize -> ResetSuits (ObjSelector::GetObjectStrings: the
 *   object's STR# OBJD +0x26) -> StartVitaBoy: VitaBoy::InitializeAll with
 *   object string 1 as the skeleton ("root" when empty). "root" is no
 *   skeleton file: InitializeAll makes a skeleton "root" of one bone "ROOT"
 *   at the origin.
 * - Animator::UpdateStyle dresses object string 2 (suit, texture) and picks
 *   the self-lit style from the suit (lbl_105BCE50 + 0xbf / 0xca / 0xda):
 *   "head-arrow" 1 (the plumb bob), "head-arrow-date" 2 (the date bob),
 *   "head-star" 3 (the star bob); +0xf8 = 1 (own light), +0xf7 = 0 (no
 *   room light rig).
 * - SAnimator::UpdatePose (the person carrying it in its "HEAD" slot) sets
 *   the root transform (SetRootTransform: the HEAD bone's position times
 *   the person's root transform) and the value +0x100 (the carrier's mood,
 *   cXPerson::GetMotive(3), truncated).
 * - Animator::Render, self-lit branch: a directional light (Device3D::
 *   CreateDirectionalLight, intensity 1) along the camera direction
 *   (cAnimDeviceSub +0x180) turned by lbl_105BCE40 = RotationTf(Y, 80 deg) *
 *   RotationTf(X, 30 deg) (.__sinit__Animator_cpp), colored by the style:
 *     f = clamp(1.2 * value / 100, -1, 1)
 *     style 3: (1, 1, 0)
 *     style 2: f >= 0: (1 - f, 1 - f - max(0, 0.4 - f), 1)
 *              f <  0: (1, 1 - f^2 - max(0, 0.4 + f), 1 - f^2)
 *     style 1: f >= 0: (1 - f, 1, 1 - f - max(0, 0.4 - f))
 *              f <  0: (1, 1 - f^2, 1 - f^2 - max(0, 0.4 + f))
 *   (green / blue at a high mood, red at a low one), the viewport ambient
 *   0.25 * color + 0.05; the root bone turns with the real-time clock
 *   (lbl_105BA230, ms): Quaternion::SetFromEuler(pi / 2, 0,
 *   0.5 * 0.001 * t * 2 pi), one turn every 2 s, and stands at (0, 3, 0).
 *   Styles 2 and 3 are not drawn when the carrier is hidden (object data
 *   34) or person data 74 bit 0 is set (VitaBoy::SetRenderFlags' hide flag).
 *
 * Not ported: the lit (+0xf7) branch with the room LightingRig, practices
 * (the bobs never animate) and the ghost / data 74 bit 1 render flags.
 */

import { BodyStrings } from "./bodystrings.js";
import type { SimView } from "./camera.js";
import { mat4Identity, mat4Mul, rotationTf, transformDir, vec3Normalize, type Mat4, type Quat, type Vec3 } from "./math3d.js";
import type { ObjectLighting, SimRenderer } from "./renderer.js";
import { Bone, Skeleton } from "./skeleton.js";
import { VBAnimMgr } from "./vbanimmgr.js";
import { VitaBoy } from "./vitaboy.js";

const fr = Math.fround;

/** Animator +0xfc: the self-lit styles UpdateStyle recognizes. */
export const AnimStyle = { none: 0, plumbBob: 1, dateBob: 2, starBob: 3 } as const;

/** lbl_105BCE50 + 0xbf / 0xca / 0xda. */
const STYLE_SUITS: ReadonlyArray<[string, number]> = [
  ["head-arrow", AnimStyle.plumbBob],
  ["head-arrow-date", AnimStyle.dateBob],
  ["head-star", AnimStyle.starBob],
];

/** lbl_105BCE40: the light's turn from the camera direction. */
const LIGHT_TURN = mat4Mul(rotationTf(1, fr((80 * 2 * Math.PI) / 360)), rotationTf(0, fr((30 * 2 * Math.PI) / 360)));

/** Quaternion::SetFromEuler(a, b, c) (arguments halved by lbl_105BCA74 = 0.5). */
function setFromEuler(a: number, b: number, c: number): Quat {
  const ca = fr(Math.cos(fr(0.5 * a)));
  const sa = fr(Math.sin(fr(0.5 * a)));
  const cb = fr(Math.cos(fr(0.5 * b)));
  const sb = fr(Math.sin(fr(0.5 * b)));
  const cc = fr(Math.cos(fr(0.5 * c)));
  const sc = fr(Math.sin(fr(0.5 * c)));
  return [fr(cb * sa * cc - sb * ca * sc), fr(cb * sa * sc + sb * ca * cc), fr(cb * ca * sc - sb * sa * cc), fr(cb * ca * cc + sb * sa * sc)];
}

/** VitaBoy::InitializeAll's skeleton "root": one bone "ROOT" at the origin. */
function rootSkeleton(): Skeleton {
  const s = new Skeleton();
  s.name = "root";
  const b = new Bone();
  b.name = "ROOT";
  s.addBone(b);
  return s;
}

export class Animator {
  /** +0xfc (0: not self-lit). */
  style: number = AnimStyle.none;
  /** +0x100: the value the style colors (the carrier's mood). */
  value = 0;
  /** +0x38: SetRootTransform. */
  root: Mat4 = mat4Identity();

  private constructor(readonly vitaboy: VitaBoy) {}

  /** Animator::Initialize over the object's strings (STR# OBJD +0x26). */
  static async create(strings: readonly string[]): Promise<Animator | null> {
    const mgr = await VBAnimMgr.get();
    const bs = new BodyStrings(strings);
    const name = bs.get(1) || "root";
    let skel: Skeleton | null;
    if (name.toLowerCase() === "root") skel = rootSkeleton();
    else skel = (await mgr.findSkeleton(name))?.clone() ?? null;
    if (!skel) return null;
    const a = new Animator(new VitaBoy(mgr, skel));
    await a.updateStyle(bs);
    return a;
  }

  /** Animator::UpdateStyle: object string 2 dressed, the self-lit style from its suit. */
  private async updateStyle(bs: BodyStrings): Promise<void> {
    const { suit, texture } = bs.getSuitAndTexture(2);
    if (suit) await this.vitaboy.dress("body", suit, texture);
    for (const [name, style] of STYLE_SUITS) if (suit === name) this.style = style;
  }

  /** Animator::Render's light color for the style and value. */
  lightColor(): Vec3 {
    const c: Vec3 = [1, 1, 1];
    if (this.style === AnimStyle.starBob) {
      c[2] = 0;
      return c;
    }
    let f = fr(fr(1.2 * this.value) / 100);
    if (f < -1) f = -1;
    if (f > 1) f = 1;
    // The component dimmed further near 0: green for the date bob (blue stays), blue for the others (green stays).
    const k = this.style === AnimStyle.dateBob ? 1 : 2;
    if (f < 0) {
      const sq = fr(f * f);
      c[1] = fr(c[1] - sq);
      c[2] = fr(c[2] - sq);
      if (f > -0.4) c[k] = fr(c[k] - fr(0.4 + f));
    } else {
      c[0] = fr(c[0] - f);
      c[k] = fr(c[k] - f);
      if (f < 0.4) c[k] = fr(c[k] - fr(0.4 - f));
    }
    return c;
  }

  /**
   * Animator::Render (self-lit): poses the root bone for the real-time
   * clock `nowMs` and draws the object with its own light.
   */
  render(renderer: SimRenderer, view: SimView, nowMs: number): void {
    const root = this.vitaboy.skeleton.root;
    if (!root) return;
    if (this.style !== AnimStyle.none) {
      const spin = fr(0.5 * fr(fr(fr(0.001 * nowMs) * fr(2 * Math.PI))));
      root.rotation = setFromEuler(fr(0.5 * Math.PI), 0, spin);
      root.translation = [0, 3, 0];
    }
    this.vitaboy.update(nowMs);
    const cam = renderer.cameraFor(view);
    const color = this.lightColor();
    const lighting: ObjectLighting = {
      direction: vec3Normalize(transformDir(cam.camZ, LIGHT_TURN)),
      color,
      ambient: [fr(0.25 * color[0] + 0.05), fr(0.25 * color[1] + 0.05), fr(0.25 * color[2] + 0.05)],
    };
    renderer.renderSimModel(this.vitaboy, this.root, view, { lighting });
  }
}
