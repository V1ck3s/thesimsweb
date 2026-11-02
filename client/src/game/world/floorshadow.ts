/**
 * FloorShadowMgr (one per scale, cRenderer::SetupShadowMgrs): the floor
 * shadows of objects, 8-bit surfaces the size of a floor tile whose bytes
 * are darkness offsets (0xff = no shadow), keyed by ShadowID (the mask of
 * the neighbouring multi-tile parts that cast a shadow, ObjSelector::
 * GetShadowID).
 *
 *  - SetupShadowMgrs: the tile mask is the floor tile sprite (floors.iff
 *    SPR2 (scale - 1) * 0x100, frame 0) decompressed over 0xff; ids 0 and
 *    0x10 are the floors.iff SPR2 0x300 / 0x310 + (scale - 1) * 0x20
 *    (decompressed over their transparent index, then CleanupShadow);
 *  - FloorShadowMgr::GetShadow makes the other ids with Generate: each tile
 *    corner gets a profile from the id's bits (shadow_min / blob / stepr /
 *    stepl / max), blended over the tile in its diamond coordinates;
 *  - DrawShadow darkens the pixels nothing was drawn on (z still 0xffff)
 *    by PalWrap's dark map at row (0x28 + byte) >> 3.
 *
 * Only the catalog pictures use it so far (cXObject::DoIconic).
 */

import type { Renderer } from "./renderer.js";
import { PX_NONE, type SpriteFrame } from "./spr.js";

/** A Surface8: bytes and pitch. */
export interface Surface8 {
  data: Uint8Array;
  pitch: number;
}

/**
 * lbl_105BA23C (ShadowID::GenerateLookups: lbl_105BA3B4, VertexConfig::
 * GenerateLookups, with id 0x10 kept): a shadow id seen from 1..3 quarter
 * turns of the object (bits 1/2/4/8 and 0x10/0x20/0x40/0x80 turn like the
 * tile edges and corners).
 */
const ROTATE_BITS: ReadonlyArray<readonly number[]> = [
  [8, 1, 2, 4, 0x80, 0x10, 0x20, 0x40],
  [4, 8, 1, 2, 0x40, 0x80, 0x10, 0x20],
  [2, 4, 8, 1, 0x20, 0x40, 0x80, 0x10],
];

/** lbl_105BA23C[id + turns * 0x100 - 0x100]. */
export function rotateShadowID(id: number, turns: number): number {
  if (turns < 1 || turns > 3) return id;
  if (id === 0x10) return 0x10;
  const t = ROTATE_BITS[turns - 1]!;
  let out = 0;
  for (let b = 0; b < 8; b++) if (id & (1 << b)) out |= t[b]!;
  return out;
}

/** lbl_105BBF0C [5] (0.6) and lbl_105BA324 (pi): the profiles' exponent and angle. */
const PROFILE_POW = 0.6;
const PI_F = Math.fround(Math.PI);

/** shadow_stepl / shadow_stepr / shadow_blob: sin profiles clamped at 0, to the power 0.6. */
function profile(s: number): number {
  return Math.fround(Math.fround(s) < 0 ? 0 : Math.fround(Math.fround(s) ** PROFILE_POW));
}

/** FloorShadowMgr +0x1c: the corner profile of each pattern (2, 4 and 6 are never valid). */
const PROFILES: ReadonlyArray<(t: number) => number> = [
  () => 0, // shadow_min
  (t) => profile(Math.sin(Math.fround(t * PI_F))), // shadow_blob
  () => 0,
  (t) => profile(Math.sin(Math.fround(t * PI_F) * 0.5)), // shadow_stepr
  () => 0,
  (t) => profile(Math.sin(Math.fround((1 - t) * PI_F) * 0.5)), // shadow_stepl
  () => 0,
  () => 1, // shadow_max
];

/** Generate's corner patterns of an id (the ShadowID::GenerateLookups corners). */
function cornerPatterns(b: number): [number, number, number, number] {
  return [
    ((b >> 2) & 4) + (b & 1) + ((b >> 6) & 2),
    ((b >> 2) & 4) + ((b >> 1) & 1) + ((b >> 4) & 2),
    ((b >> 3) & 4) + ((b >> 2) & 1) + ((b >> 5) & 2),
    ((b >> 5) & 4) + ((b >> 3) & 1) + ((b >> 5) & 2),
  ];
}

/** DecompressSpr2(sprite, Surface8) over a surface filled with `fill`. */
function decompress(f: SpriteFrame, fill: number): Surface8 {
  const data = new Uint8Array(f.width * f.height).fill(fill);
  for (let i = 0; i < data.length; i++) if (f.mode[i] !== PX_NONE) data[i] = f.index[i]!;
  return { data, pitch: f.width };
}

/** CleanupShadow: on each row, the runs of the transparent index at both ends become 0xff. */
function cleanupShadow(f: SpriteFrame, s: Surface8): void {
  const key = f.transparentIndex & 0xff;
  for (let y = 0; y < f.height; y++) {
    const row = y * s.pitch;
    for (let x = 0; x < f.width && s.data[row + x] === key; x++) s.data[row + x] = 0xff;
    for (let x = f.width - 1; x >= 0 && s.data[row + x] === key; x--) s.data[row + x] = 0xff;
  }
}

export class FloorShadowMgr {
  /** +0x04: the shadows made so far. */
  private readonly shadows = new Map<number, Surface8>();
  /** +0x3c / +0x40: the floor tile size. */
  readonly width: number;
  readonly height: number;
  /** +0x44 / +0x48: the floor tile mask. */
  private readonly mask: Surface8 | null;

  /** FloorShadowMgr::FloorShadowMgr(global renderer, scale) and cRenderer::SetupShadowMgrs' part for it. */
  constructor(
    global: Renderer,
    readonly scale: number,
  ) {
    const tile = global.frame((scale - 1) * 0x100, 0);
    this.width = tile?.width ?? 0;
    this.height = tile?.height ?? 0;
    this.mask = tile ? decompress(tile, 0xff) : null;
    for (const [id, list] of [
      [0, 0x300],
      [0x10, 0x310],
    ] as const) {
      const f = global.frame((scale - 1) * 0x20 + list, 0);
      if (!f) continue;
      const s = decompress(f, f.transparentIndex & 0xff);
      cleanupShadow(f, s);
      this.shadows.set(id, s);
    }
  }

  /** FloorShadowMgr::GetShadow(id, 0): a made shadow, else Generate's (kept). */
  getShadow(id: number): Surface8 | null {
    let s = this.shadows.get(id & 0xff);
    if (!s && this.mask) {
      s = this.generate(id & 0xff, this.mask);
      this.shadows.set(id & 0xff, s);
    }
    return s ?? null;
  }

  /**
   * FloorShadowMgr::Generate: for each pixel of the tile mask (0xff stays
   * 0xff), u / v are its diamond coordinates (2 / even width, the tile
   * centered), clamped to [0, 1]; the value is
   *   1 - (c1(v) (1 - u) + c0(u) (1 - v) + c2(u) v + c3(v) u) / 2
   * clamped to [0, 1], stored as (int)(0.5 + 255 value).
   */
  private generate(id: number, mask: Surface8): Surface8 {
    const [p0, p1, p2, p3] = cornerPatterns(id).map((p) => PROFILES[p]!);
    const w = this.width;
    const h = this.height;
    const we = w & 1 ? w + 1 : w;
    const k = 2 / we;
    const data = new Uint8Array(w * h);
    const clamp = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (mask.data[y * mask.pitch + x] === 0xff) {
          data[y * w + x] = 0xff;
          continue;
        }
        const dy = y - 0.5 * h;
        const dx = x - 0.5 * we;
        const u = clamp(Math.fround(k * (0.5 * dx + dy) + 0.5));
        const v = clamp(Math.fround(k * (-0.5 * dx + dy) + 0.5));
        const sum = Math.fround(u * p3!(v) + Math.fround(v * p2!(u) + Math.fround(Math.fround((1 - v) * p0!(u)) + Math.fround((1 - u) * p1!(v)))));
        const val = clamp(Math.fround(-(0.5 * sum - 1)));
        data[y * w + x] = Math.trunc(0.5 + 255 * val);
      }
    }
    return { data, pitch: w };
  }
}

/**
 * DrawShadow(x, y, shadow, 0x28, width, height) into an RGBA target: where
 * nothing was drawn (`drawn` 0), a byte b with 0x28 + b < 0xff darkens the
 * pixel by PalWrap's dark map at row (0x28 + b) >> 3 (per 5-bit channel,
 * n + c (max(n, L) - n) / 31 with the night color n = (0, 0, 1)).
 */
export function drawShadow(px: Uint8ClampedArray, drawn: Uint8Array, tw: number, th: number, x0: number, y0: number, s: Surface8, w: number, h: number): void {
  const night = [0, 0, 1];
  for (let y = 0; y < h; y++) {
    const ty = y0 + y;
    if (ty < 0 || ty >= th) continue;
    for (let x = 0; x < w; x++) {
      const tx = x0 + x;
      if (tx < 0 || tx >= tw) continue;
      const o = ty * tw + tx;
      if (drawn[o]) continue;
      const lvl = 0x28 + s.data[y * s.pitch + x]!;
      if (lvl >= 0xff) continue;
      const l = lvl >> 3;
      const q = o * 4;
      for (let c = 0; c < 3; c++) {
        const n = night[c]!;
        const c5 = px[q + c]! >> 3;
        px[q + c] = Math.floor(0.5 + n + (c5 * (Math.max(n, l) - n)) / 31) * 8;
      }
    }
  }
}
