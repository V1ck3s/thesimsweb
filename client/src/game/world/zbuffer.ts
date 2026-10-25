/**
 * ZBufferLookup: the depth tables HouseViewer uses for its 16-bit z-buffer
 * (smaller = nearer). Everything that writes depth (floors, walls, z-sprites)
 * derives its values from these tables, so the relative depths match the
 * original exactly where the formulas are ported.
 *
 * Inputs come from cAnimDeviceSub::SetCameraPosition (P = camera depth
 * scale, Q = P - 12.5) and the 3D viewport, which NewWorld sizes to the view
 * width by (view height - 100).
 */

/** cAnimDeviceSub+0x10[3 - scale], computed by SetCameraPosition (same for every scale). */
export const CAMERA_P = cameraP();
/** cAnimDeviceSub+0x174[3 - scale] = P - 12.5. */
export const CAMERA_Q = CAMERA_P - 12.5;

function cameraP(): number {
  // lbl_105BBEA8 = {0.5, 50, 18, 3, 64, ...}, lbl_105BBEA4 doubles = {1, 2, 6, 3, 0.5},
  // lbl_105BF560 = 255.
  const f = Math.fround;
  const k = f(1 / (2 * Math.sqrt(6)));
  const a = f(50 + f(18 + f(3 * f(255 * k))));
  const b = f(3 * f(64 * f(Math.SQRT2)));
  return f(b * Math.sqrt(3) * 0.5 + f(a * 0.5));
}

/** Level heights in pixels by scale (ZBufferLookup+0x6c[3 - scale]). */
export const LEVEL_PX: Readonly<Record<number, number>> = { 3: 0xe8, 2: 0x74, 1: 0x3a };

export class ZBufferLookup {
  /** +0x04: vertical lookup (depth vs pixels up a vertical surface), index 0 = 8<<scale below the anchor. */
  readonly vertical = new Map<number, Int16Array>();
  /** +0x10: floor depth per screen row relative to the view origin; index offset in floorBase. */
  readonly floor = new Map<number, Int32Array>();
  readonly floorBase = new Map<number, number>();
  /** +0x2c: ortho wall lookup. */
  readonly orthoWall = new Map<number, Int16Array>();
  /** +0x3c: ortho wall depth amplitude. */
  readonly orthoWallMax = new Map<number, number>();
  /** +0x84: depth delta of one level up. */
  readonly levelZ = new Map<number, number>();
  /** +0x54 / +0x60 per scale. */
  private readonly a54 = new Map<number, number>();
  private readonly a60 = new Map<number, number>();
  /** Depth change per alt unit (see altitude()). */
  private readonly altPerUnit = new Map<number, number>();

  /**
   * GenerateLookupTables for all three scales.
   * @param viewW 3D viewport width, @param viewH 3D viewport height.
   */
  constructor(
    readonly viewW: number,
    readonly viewH: number,
  ) {
    for (const s of [1, 2, 3]) this.generate(s);
  }

  private generate(s: number): void {
    const f = Math.fround;
    const a54 = f(this.viewW * f(Math.SQRT2 / (16 << s)) * 3);
    this.a54.set(s, a54);
    this.a60.set(s, f(a54 / (this.viewW / this.viewH)));
    this.generateVertical(s);
    this.generateFloor(s);
    this.generateOrthoWall(s);
    const v = this.vertical.get(s)!;
    const lp = LEVEL_PX[s]!;
    this.levelZ.set(s, v[lp]! - v[0]! - 0x41);
    // GenerateAltitudeLookup projects a pure height through the 3D camera; a
    // height of one alt unit is 2<<scale pixels, so its depth follows the
    // vertical table's slope (the camera matrix itself is not ported).
    const n = v.length;
    const slope = (v[n - 1]! - v[8 << s]!) / (n - 1 - (8 << s));
    this.altPerUnit.set(s, slope * (2 << s));
  }

  private generateVertical(s: number): void {
    const f = Math.fround;
    const n = 2 * (0x194 >> (3 - s));
    const anchor = 8 << s;
    const out = new Int16Array(n);
    const a60 = this.a60.get(s)!;
    const denom = n - 1 - anchor;
    const k = -f(f(65535 * 0.5 * f(f(f(2 * a60) / f(Math.sqrt(3))) / this.viewH)) / CAMERA_P) * denom;
    for (let i = 0; i < n; i++) out[i] = Math.trunc(f(0.5 + f(f(k * (i - anchor)) / denom)));
    out[0] = out[0]! + 0x41;
    this.vertical.set(s, out);
  }

  private generateFloor(s: number): void {
    const f = Math.fround;
    const u = 8 << s;
    const before = u * 256 + 1;
    const after = this.viewH * 12;
    const out = new Int32Array(before + after);
    const k = f(f(3 * Math.SQRT2) / u);
    for (let i = -before; i < after; i++) {
      out[i + before] = Math.trunc(f(f(65535 * -f(f(f(i * k) * 0.5) * f(Math.sqrt(3)) - CAMERA_Q)) / CAMERA_P));
    }
    this.floor.set(s, out);
    this.floorBase.set(s, before);
  }

  private generateOrthoWall(s: number): void {
    const f = Math.fround;
    const w = 16 << s;
    const u = 8 << s;
    const out = new Int16Array(w * 2 + 2);
    // lbl_105BC064[4] = 6, lbl_105BC060: [2] = 6, [5] = 0.5.
    const amp = f(f(f(6 / f(Math.sqrt(6))) / CAMERA_P) * 65535);
    this.orthoWallMax.set(s, Math.trunc(0.5 + amp));
    for (let i = 0; i <= u; i++) {
      const val = Math.trunc(amp * f((u - i) / u));
      out[u - i] = val;
      out[u + i] = val;
    }
    // The second half repeats the first (memcpy), then two guard entries.
    out.copyWithin(w, 0, w);
    out[w * 2] = out[w * 2 - 1]!;
    out[w * 2 + 1] = out[w * 2 - 1]!;
    if (s === 2) {
      out[0x3f] = out[0x3f]! + 1;
      out[0x7f] = out[0x7f]! + 1;
    } else if (s === 3) {
      out[u * 2 - 2] = out[u * 2 - 2]! + 1;
      out[u * 2 - 1] = out[u * 2 - 1]! + 1;
      out[u * 2 + w - 2] = out[u * 2 + w - 2]! + 1;
      out[u * 2 + w - 1] = out[u * 2 + w - 1]! + 1;
    }
    this.orthoWall.set(s, out);
  }

  /** Floor table value for screen row `row` (absolute) given the view origin y. */
  floorAt(scale: number, row: number, originY: number): number {
    const t = this.floor.get(scale)!;
    const i = row - originY + this.floorBase.get(scale)!;
    return t[Math.max(0, Math.min(t.length - 1, i))]!;
  }

  /** Depth delta of an altitude (GenerateAltitudeLookup, see note in generate()). */
  altitude(scale: number, alt: number): number {
    return Math.trunc(0.5 + alt * this.altPerUnit.get(scale)!);
  }

  /** Vertical lookup at index i (clamped). */
  verticalAt(scale: number, i: number): number {
    const t = this.vertical.get(scale)!;
    return t[Math.max(0, Math.min(t.length - 1, i))]!;
  }
}

/**
 * ZSpriteLookup (InitZSpriteBlit with cAnimDeviceSub's P): depth offset of a
 * sprite z value, added to the object's base depth.
 */
export function makeZSpriteLookup(p = CAMERA_P): Int16Array {
  const f = Math.fround;
  // lbl_105BC06C = {1, 12, 16383.75, sqrt 3, 4.2426, 1/127, -16383.75}.
  const f1 = f(12 * f(1 / p));
  let f2 = f(16383.75 * f(f(f(Math.fround(Math.sqrt(3)) * f(4.242640495300293)) * f(1 / p)) + f1));
  const f3 = f(f(1 / 127) * f2);
  f2 = f(f(-16383.75 * f1) - f2);
  const out = new Int16Array(256);
  // The init loop fills entries 0..254; entry 255 is never written (stays 0).
  for (let z = 0; z < 255; z++) out[z] = Math.trunc(0.5 + f(f(z * f3) + f2));
  return out;
}
