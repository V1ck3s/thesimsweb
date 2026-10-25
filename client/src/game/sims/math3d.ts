/**
 * The small slice of the game's math library VitaBoy uses (vec3, Quaternion,
 * Transform, RotationTf, TranslationTf, quattom3), with the same conventions:
 *
 * - Transforms are Direct3D style: row-major 4x4, row vectors (`v * M`), so
 *   `a * b` applies `a` first. RotationTf builds the D3D rotation matrices
 *   (left-handed): Y: [c 0 -s; 0 1 0; s 0 c], X: [1 0 0; 0 c s; 0 -s c].
 * - Quaternions are (x, y, z, w); `quatMul` is the Hamilton product
 *   (Quaternion::operator*).
 *
 * Everything is computed in float32 where the original stores floats.
 */

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
/** Row-major 4x4 (index = row * 4 + col). */
export type Mat4 = Float32Array;

const f = Math.fround;

export function mat4Identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** a * b (row vectors: a applied first). */
export function mat4Mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[r * 4 + k]! * b[k * 4 + c]!;
      o[r * 4 + c] = s;
    }
  }
  return o;
}

/** RotationTf(axis, angle): 0 = X, 1 = Y, 2 = Z. */
export function rotationTf(axis: 0 | 1 | 2, angle: number): Mat4 {
  const c = f(Math.cos(angle));
  const s = f(Math.sin(angle));
  const m = mat4Identity();
  if (axis === 0) {
    m[5] = c;
    m[6] = s;
    m[9] = -s;
    m[10] = c;
  } else if (axis === 1) {
    m[0] = c;
    m[2] = -s;
    m[8] = s;
    m[10] = c;
  } else {
    m[0] = c;
    m[1] = s;
    m[4] = -s;
    m[5] = c;
  }
  return m;
}

export function translationTf(t: Vec3): Mat4 {
  const m = mat4Identity();
  m[12] = t[0];
  m[13] = t[1];
  m[14] = t[2];
  return m;
}

/** Inverse of a rigid transform (rotation + translation), Transform::Invert for our uses. */
export function mat4InvertRigid(m: Mat4): Mat4 {
  const o = mat4Identity();
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 4 + c] = m[c * 4 + r]!;
  const tx = m[12]!;
  const ty = m[13]!;
  const tz = m[14]!;
  o[12] = -(tx * o[0]! + ty * o[4]! + tz * o[8]!);
  o[13] = -(tx * o[1]! + ty * o[5]! + tz * o[9]!);
  o[14] = -(tx * o[2]! + ty * o[6]! + tz * o[10]!);
  return o;
}

/** vec3 * Transform (point: w = 1). */
export function transformPoint(v: Vec3, m: Mat4): Vec3 {
  return [
    v[0] * m[0]! + v[1] * m[4]! + v[2] * m[8]! + m[12]!,
    v[0] * m[1]! + v[1] * m[5]! + v[2] * m[9]! + m[13]!,
    v[0] * m[2]! + v[1] * m[6]! + v[2] * m[10]! + m[14]!,
  ];
}

/** vec3 * Transform (direction: w = 0). */
export function transformDir(v: Vec3, m: Mat4): Vec3 {
  return [
    v[0] * m[0]! + v[1] * m[4]! + v[2] * m[8]!,
    v[0] * m[1]! + v[1] * m[5]! + v[2] * m[9]!,
    v[0] * m[2]! + v[1] * m[6]! + v[2] * m[10]!,
  ];
}

export function vec3Length(v: Vec3): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

export function vec3Normalize(v: Vec3, len = 1): Vec3 {
  const l = vec3Length(v);
  if (l === 0) return [0, 0, 0];
  const k = len / l;
  return [v[0] * k, v[1] * k, v[2] * k];
}

/** Quaternion::operator* (Hamilton product a * b). */
export function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    f(ay * bz + aw * bx + ax * bw - az * by),
    f(az * bx + ay * bw + aw * by - ax * bz),
    f(az * bw - ay * bx + aw * bz + ax * by),
    f(aw * bw - ax * bx - ay * by - az * bz),
  ];
}

/** Rotate v by q (the inline expansion in Bone::UpdateTransform): R(q) v. */
export function quatRotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const xy2 = 2 * x * y;
  const wz2 = 2 * w * z;
  const wx2 = 2 * w * x;
  const yz2 = 2 * y * z;
  const wy2 = 2 * w * y;
  const xz2 = 2 * x * z;
  const yy = y * y;
  const zz = z * z;
  const ww_xx = w * w - x * x;
  return [
    f((w * w + x * x - yy - zz) * v[0] + (xy2 - wz2) * v[1] + (wy2 + xz2) * v[2]),
    f((xy2 + wz2) * v[0] + (yy + ww_xx - zz) * v[1] + (yz2 - wx2) * v[2]),
    f((xz2 - wy2) * v[0] + (wx2 + yz2) * v[1] + (zz + (ww_xx - yy)) * v[2]),
  ];
}

/** quattom3: 3x3 rotation matrix, row-major. */
export function quatToM3(q: Quat, out: Float32Array, o = 0): void {
  const [x, y, z, w] = q;
  out[o] = 1 - 2 * y * y - 2 * z * z;
  out[o + 1] = 2 * x * y - 2 * z * w;
  out[o + 2] = 2 * x * z + 2 * y * w;
  out[o + 3] = 2 * x * y + 2 * z * w;
  out[o + 4] = 1 - 2 * x * x - 2 * z * z;
  out[o + 5] = 2 * y * z - 2 * x * w;
  out[o + 6] = 2 * x * z - 2 * y * w;
  out[o + 7] = 2 * y * z + 2 * x * w;
  out[o + 8] = 1 - 2 * x * x - 2 * y * y;
}

/**
 * BlendQuats1(w, a, b, out): normalized lerp w*a + (1-w)*b, taking the short
 * way round; w near 0 or 1 snaps to b or a.
 */
export function blendQuats1(w: number, a: Quat, b: Quat): Quat {
  if (w >= 0.99 || w <= 0.01) {
    // lbl_105C20CC..D8: |w - 1| <= eps -> a, |w| <= eps -> b; otherwise out is left alone.
    return w >= 0.5 ? [...a] : [...b];
  }
  let k = 1 - w;
  if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0) k = -k;
  const o: Quat = [w * a[0] + k * b[0], w * a[1] + k * b[1], w * a[2] + k * b[2], w * a[3] + k * b[3]];
  const m2 = o[0] * o[0] + o[1] * o[1] + o[2] * o[2] + o[3] * o[3];
  if (m2 === 0) return [0, 0, 0, 1];
  const inv = 1 / Math.sqrt(m2);
  return [o[0] * inv, o[1] * inv, o[2] * inv, o[3] * inv];
}
