/**
 * The 3D camera the lot view uses for people and 3D objects:
 * cAnimDeviceSub::SetCameraPosition(scale, offsetX, offsetY, rotation),
 * MakeAxonometricProjection, and the person placement of
 * SAnimator::UpdateRootPos.
 *
 * World space (VitaBoy units): x/z is the floor, y is up; one tile is 3
 * units. A person at fixed tile coordinates (x, y) (1/16 tile units in the
 * game) stands at world (3 * y, height, 3 * x). The camera looks down 30
 * degrees, its yaw is 45 - 90 * rotation degrees, and for rotations 1..3 it
 * pivots around the far corners of the 64x64 tile grid (192 units).
 *
 * The projection is orthographic: a 3D point lands on the same pixel as the
 * isometric sprites. With (originX, originY) = HouseViewer's offsets, i.e.
 * the screen position of the top corner of view tile (0, 0) at level 1, a
 * world point p maps to
 *   screen = (originX + (p - pivot) . camX / upp, originY - (p - pivot) . camY / upp)
 * with upp = 3 * sqrt(2) / (16 << scale) world units per pixel, and its depth
 * in z-buffer units (0..65535, smaller = nearer) is
 *   65535 * ((p - pivot) . camZ + Q) / P
 * (P = far plane = camera distance scale, Q = P - 12.5 = eye distance), which
 * is what the lot's ZBufferLookup tables are built from.
 */

import {
  mat4Identity,
  mat4InvertRigid,
  mat4Mul,
  rotationTf,
  transformDir,
  transformPoint,
  translationTf,
  vec3Normalize,
  type Mat4,
  type Vec3,
} from "./math3d.js";

/** View parameters, as HouseViewer passes them to SetCameraPosition. */
export interface SimView {
  /** Zoom scale: 1 = far, 2 = medium, 3 = near (HouseViewer scale). */
  zoom: number;
  /** View rotation 0..3 (cRotatableWorld+0x84). */
  rotation: number;
  /** HouseViewer offsets: screen position of the top corner of view tile (0, 0). */
  originX: number;
  originY: number;
  /** 3D viewport size in pixels (the render target). */
  width: number;
  height: number;
}

const fr = Math.fround;
const DEG = Math.PI / 180;

/** cAnimDeviceSub+0x10[3 - scale] (the same for every scale): the far plane P. */
export const CAMERA_FAR = cameraFar();
/** cAnimDeviceSub+0x174[3 - scale] = P - 12.5: the eye's distance from the pivot. */
export const CAMERA_EYE = fr(CAMERA_FAR - 12.5);

function cameraFar(): number {
  // lbl_105BBEA8 = {0.5, 50, 18, 3, 64, 12.5, 180, 45, 90, 1, 192, ...},
  // lbl_105BBEA4 doubles = {1, 2, 6, 3, 0.5}, lbl_105BF560 = 255.
  const k = fr(1 / (2 * Math.sqrt(6)));
  const a = fr(50 + fr(18 + fr(3 * fr(255 * k))));
  const b = fr(3 * fr(64 * fr(Math.SQRT2)));
  return fr(b * Math.sqrt(3) * 0.5 + fr(a * 0.5));
}

/** World units per pixel at a scale. */
export function unitsPerPixel(zoom: number): number {
  return fr(fr(3 * fr(Math.SQRT2)) / (16 << zoom));
}

/** MakeAxonometricProjection(near, far, width, aspect): D3D orthographic, row vectors. */
export function makeAxonometricProjection(near: number, far: number, width: number, aspect: number): Mat4 {
  const s = fr(width * 0.5);
  const sx = fr(s / aspect);
  const m = new Float32Array(16);
  m[0] = sx;
  m[5] = s;
  m[10] = fr(fr(s * sx) / (far - near));
  m[14] = fr(fr(near * -s * sx) / (far - near));
  m[15] = fr(s * sx);
  return m;
}

/** The camera state SetCameraPosition leaves in cAnimDeviceSub / Camera / Viewport3D. */
export class AnimDeviceCamera {
  readonly upp: number;
  /** Camera::Position's eye and the resulting view transform. */
  readonly eye: Vec3;
  readonly view: Mat4;
  readonly projection: Mat4;
  /** view * projection (row vectors: world -> D3D clip, z in [0, w]). */
  readonly viewProjection: Mat4;
  /** Camera axes in world space (rows of the camera rotation). */
  readonly camX: Vec3;
  readonly camY: Vec3;
  readonly camZ: Vec3;
  /** cAnimDeviceSub+0x12c: RotationTf(Y, 90 * ((4 - rotation) & 3)); orients the light rig. */
  readonly lightRotation: Mat4;

  constructor(readonly v: SimView) {
    const zoom = v.zoom;
    const rot = v.rotation & 3;
    this.upp = unitsPerPixel(zoom);
    const width = fr(v.width * this.upp);
    const r0 = mat4Mul(rotationTf(0, fr(-30 * DEG)), rotationTf(1, fr((45 - 90 * rot) * DEG)));
    const back = transformPoint([0, 0, CAMERA_EYE], r0);
    const dir = vec3Normalize([-back[0], -back[1], -back[2]]);
    // Rotation pivots: the grid corner that ends up at the top of the screen.
    const pivot = ROTATION_PIVOT[rot]!;
    let eye: Vec3 = [back[0] + pivot[0], back[1] + pivot[1], back[2] + pivot[2]];
    // (R^-1)^T = R for a rotation: screen steps of one pixel along x and y.
    const t = mat4InvertRigid(r0);
    const tt = transpose3(t);
    const stepX = transformDir([-this.upp, 0, 0], tt);
    const stepY = transformDir([0, -this.upp, 0], tt);
    const kx = (v.width >> 1) - v.originX;
    const ky = (v.height >> 1) - v.originY;
    eye = [
      eye[0] + kx * stepX[0] + ky * stepY[0],
      eye[1] + kx * stepX[1] + ky * stepY[1],
      eye[2] + kx * stepX[2] + ky * stepY[2],
    ];
    this.eye = eye;
    // Camera::calcPolarCoords + setTfFromPolarCoords.
    const pitch = fr(Math.asin(-dir[1] / Math.hypot(dir[0], dir[1], dir[2])));
    const flat = vec3Normalize([dir[0], 0, dir[2]]);
    let yaw = fr(Math.acos(Math.max(-1, Math.min(1, flat[2]))));
    if (flat[0] < 0) yaw = -yaw;
    const camRot = mat4Mul(rotationTf(0, pitch), rotationTf(1, yaw));
    const camTf = mat4Mul(camRot, translationTf(eye));
    this.view = mat4InvertRigid(camTf);
    this.camX = [camRot[0]!, camRot[1]!, camRot[2]!];
    this.camY = [camRot[4]!, camRot[5]!, camRot[6]!];
    this.camZ = [camRot[8]!, camRot[9]!, camRot[10]!];
    this.projection = makeAxonometricProjection(0, CAMERA_FAR, width, v.width / v.height);
    this.viewProjection = mat4Mul(this.view, this.projection);
    this.lightRotation = rotationTf(1, fr(Math.PI * 0.5 * ((4 - rot) & 3)));
  }

  /** Screen pixel (D3D convention: pixel centers on integers) and z-buffer depth of a world point. */
  project(p: Vec3): { x: number; y: number; depth: number } {
    const c = transformPoint(p, this.viewProjection);
    const w = this.projection[15]!;
    return {
      x: ((c[0] / w + 1) * this.v.width) / 2,
      y: ((1 - c[1] / w) * this.v.height) / 2,
      depth: (c[2] / w) * 65535,
    };
  }
}

/** Eye offsets added per rotation in SetCameraPosition (lbl_105BBEA8[10] = 192). */
const ROTATION_PIVOT: ReadonlyArray<Vec3> = [
  [0, 0, 0],
  [192, 0, 0],
  [192, 0, 192],
  [0, 0, 192],
];

function transpose3(m: Mat4): Mat4 {
  const o = mat4Identity();
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 4 + c] = m[c * 4 + r]!;
  return o;
}

/** Where a person stands (cXObject location as UpdateRootPos reads it). */
export interface SimPlacement {
  /** Tile coordinates in world (unrotated) space; a tile's center is n + 0.5. */
  x: number;
  y: number;
  /** 1-based level. */
  level: number;
  /** cFixedWorld::GetFAlt at the spot (terrain altitude units), 0 on flat lots. */
  alt?: number;
  /** cXObject direction (+0x4c), in 45 degree steps. */
  direction: number;
}

/**
 * SAnimator::UpdateRootPos: the skeleton's root transform,
 * RotationTf(Y, 45 * (6 + direction)) * TranslationTf(position), with
 *   position = (0.1875 * y16, 3 * alt / (2 sqrt 6), 0.1875 * x16)
 *            + (level - 1) * (0.5, 9.3005, 0.5) * RotationTf(Y, -90 * rotation)
 * (the per-level vector is ZBufferLookup+0x94, the same at every scale).
 */
export function rootTransform(p: SimPlacement, rotation: number): Mat4 {
  const x16 = p.x * 16;
  const y16 = p.y * 16;
  const level = rotationTf(1, fr(0.5 * -(rotation & 3) * Math.PI));
  const lv = transformDir([0.5, fr(9.3 + 0.0005111772335393302), 0.5], level).map((c) => c * (p.level - 1)) as Vec3;
  const height = fr(3 * fr((p.alt ?? 0) * fr(1 / (2 * Math.sqrt(6)))));
  const pos: Vec3 = [fr(0.1875 * y16) + lv[0], height + lv[1], fr(0.1875 * x16) + lv[2]];
  const angle = fr((45 * (4 + 2 + p.direction) * Math.PI) / 180);
  return mat4Mul(rotationTf(1, angle), translationTf(pos));
}
