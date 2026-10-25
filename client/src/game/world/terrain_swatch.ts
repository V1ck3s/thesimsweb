/**
 * The grass renderer: cGouraudSwatch (per-corner lighting from the terrain
 * slopes, shade-table columns) and cColorSwatch (dithered dirt-to-grass color
 * table indexed by grass value and shade, plus blade grass), with their
 * helpers Gradient, WideColorChunk, FixRamp<8>, GrassVector and
 * cTerrainLightSource.
 *
 * A tile is drawn as vertical columns 4 pixels wide, from its left corner to
 * the middle (left half) and from its right corner back to the middle (right
 * half). Each column interpolates the shade and color indices between the
 * tile's top and bottom edges with 8.8 fixed-point ramps.
 *
 * Fields keep their original names (from cColorSwatch::DumpParams) and byte
 * offsets in comments.
 */

import { getNextRandomNumber, getSRandSeed, setSRandSeed, sgsRand } from "./random.js";
import {
  TerrainRenderer,
  fmadds,
  getColor16FromRGB,
  idiv,
  rgbaFrom16,
  type PackedAlt,
  type RenderParam,
  type TerrainTarget,
  type TileRect,
} from "./terrain_renderer.js";
import type { RotatableWorld } from "./world.js";

const f = Math.fround;

/** Light source latitudes (lbl_105BBF18, floats). */
const GOURAUD_LATITUDE = f(0.39269909262657166);
const LATITUDE_DAY = f(0.3141592741012573);
const LATITUDE_TWILIGHT = f(0.6283185482025146);
const LATITUDE_NIGHT = f(0.942477822303772);

/** Soil / cloud lots latitudes and cColorSwatch defaults (lbl_105BBECC, floats). */
const ECC = [0, f(0.6283185482025146), f(0.471238911151886), f(0.3141592741012573), f(0.31415900588035583)] as const;

/**
 * cSimulator+0x18, set by SetCurrentHour: hour < 6 -> 2, 6 -> 3, 7..17 -> 0,
 * 18 -> 1, >= 19 -> 2.
 */
export function timeOfDayForHour(hour: number): number {
  if (hour < 6) return 2;
  if (hour < 7) return 3;
  if (hour < 18) return 0;
  if (hour < 19) return 1;
  return 2;
}

/** Gradient: linear RGB ramp between two 0x00RRGGBB colors. */
export class Gradient {
  private readonly c: readonly number[];

  constructor(from: number, to: number) {
    this.c = [(from >>> 16) & 0xff, (from >>> 8) & 0xff, from & 0xff, (to >>> 16) & 0xff, (to >>> 8) & 0xff, to & 0xff];
  }

  /** GetColor16(float t): channels truncated and clamped to [0, 255]. */
  getColor16(t: number): number {
    const c = this.c;
    const ch = (i: number): number => {
      const v = Math.trunc(fmadds(t, f(c[i + 3]! - c[i]!), f(c[i]!)));
      return v < 0 ? 0 : v > 0xff ? 0xff : v;
    };
    const r = ch(0);
    const g = ch(1);
    const b = ch(2);
    return getColor16FromRGB(b | (r << 16) | (g << 8));
  }
}

/** WideColorChunk::SetColor16: entry i of row 0 and the mirrored entry 3 - i of row 1 (two rows of 4 pixels). */
function setWideColor16(chunk: Uint16Array, at: number, i: number, c: number): void {
  chunk[at + i] = c;
  chunk[at + 4 + (3 - i)] = c;
}

/** One channel of a color interpolated between two 0x00RRGGBB colors (PreCompute's fmadds + clamp). */
function lerpChannel(t: number, from: number, to: number, shift: number): number {
  const a = (from >>> shift) & 0xff;
  const b = (to >>> shift) & 0xff;
  const v = Math.trunc(fmadds(t, f(b - a), f(a)));
  return v < 0 ? 0 : v > 0xff ? 0xff : v;
}

function lerpColor(t: number, from: number, to: number): number {
  return lerpChannel(t, from, to, 0) | (lerpChannel(t, from, to, 16) << 16) | (lerpChannel(t, from, to, 8) << 8);
}

/** FixRamp<8>: 8.8 fixed-point value and per-row step. */
export class FixRamp {
  v = 0;
  d = 0;

  peekNth(n: number): number {
    return (this.v + Math.imul(n, this.d)) >> 8;
  }
}

/** Unpacked ColorChunk (4 x 16-bit) used for the z values. */
type ZChunk = Uint16Array;

/** Write one 4-pixel row of 16-bit colors (chunk[at..at+3]) and z values. */
function putRow4(t: TerrainTarget, x: number, y: number, colors: Uint16Array, at: number, z: ZChunk): void {
  if (y < 0 || y >= t.height) return;
  const row = y * t.width;
  for (let i = 0; i < 4; i++) {
    const px = x + i;
    if (px < 0 || px >= t.width) continue;
    t.color[row + px] = rgbaFrom16(colors[at + i]!);
    t.depth[row + px] = z[i]!;
  }
}

/** Write one pixel with color and z (grass blades). */
function putPixel(t: TerrainTarget, x: number, y: number, c: number, z: number): void {
  if (x < 0 || y < 0 || x >= t.width || y >= t.height) return;
  const i = y * t.width + x;
  t.color[i] = rgbaFrom16(c);
  t.depth[i] = z;
}

/**
 * ColorSwatchColumnBlit (lbl_105BBEC0) and ColorSwatchColumnBlitHighlighted
 * (lbl_105BBEC4; byte-identical code, only the table differs): `n` rows of
 * 4 pixels from (x, y) down. Each row reads the WideColorChunk at
 * [color >> 8][shade >> 8], alternating its two rows by screen parity, and
 * writes the tile's 4 z values.
 */
export function colorSwatchColumnBlit(
  t: TerrainTarget,
  x: number,
  y: number,
  n: number,
  table: Uint16Array,
  numShades: number,
  shade: FixRamp,
  color: FixRamp,
  z: ZChunk,
): void {
  if (n <= 0) return;
  let parity = (n + y) & 1;
  const rows = table.length / (numShades * 8);
  for (let i = 0; i < n; i++) {
    let s = shade.v >> 8;
    shade.v = (shade.v + shade.d) | 0;
    let c = color.v >> 8;
    color.v = (color.v + color.d) | 0;
    // The ramps stay inside the table; clamp only to keep reads in bounds.
    s = s < 0 ? 0 : s >= numShades ? numShades - 1 : s;
    c = c < 0 ? 0 : c >= rows ? rows - 1 : c;
    putRow4(t, x, y + i, table, (c * numShades + s) * 8 + parity * 4, z);
    parity ^= 1;
  }
}

export const colorSwatchColumnBlitHighlighted = colorSwatchColumnBlit;

/**
 * cTerrainLightSource: an 11x11 table of squared cosines between the light
 * vector and the normal of a slope, indexed by the two altitude differences
 * (clamped to [-5, 5]) along a tile's edges.
 */
export class TerrainLightSource {
  private readonly table = new Float32Array(121);
  private ready = false;
  /** +0x1e8: normalized light vector. */
  private readonly light = [0, 0, 0];

  /** InitTable(vec3 const *). */
  initTable(v: readonly [number, number, number]): void {
    let [x, y, z] = v;
    let len = f(y * y);
    len = fmadds(x, x, len);
    len = fmadds(z, z, len);
    const k = f(1 / f(Math.sqrt(len)));
    x = f(x * k);
    y = f(y * k);
    z = f(z * k);
    this.light[0] = x;
    this.light[1] = y;
    this.light[2] = z;
    // lbl_105BA234 = 2 * sqrt(6) (lbl_105BC01C), times lbl_105BFFC0 = 1.
    const h = f(1 * f(2 * Math.sqrt(6)));
    for (let i = 0; i <= 10; i++) {
      const a = i - 5;
      for (let j = 0; j <= 10; j++) {
        const b = j - 5;
        let num = f(b * y);
        num = fmadds(a, x, num);
        num = fmadds(h, z, num);
        const den = f(Math.sqrt(fmadds(h, h, f(a * a + b * b))));
        const c = f(num / den);
        this.table[i * 11 + j] = f(c * c);
      }
    }
    this.ready = true;
  }

  private at(row: number, col: number): number {
    const r = row < 0 ? 0 : row > 10 ? 10 : row;
    const c = col < 0 ? 0 : col > 10 ? 10 : col;
    return this.table[r * 11 + c]!;
  }

  /** GetRightShading(PackedAlt): the right-hand triangle (top, right, bottom corners). */
  getRightShading(p: PackedAlt): number {
    if (!this.ready) return 0.5;
    return this.at(p[1]! - p[2]! + 5, p[3]! - p[2]! + 5);
  }

  /** GetLeftShading(PackedAlt): the left-hand triangle (left, top, bottom corners). */
  getLeftShading(p: PackedAlt): number {
    if (!this.ready) return 0.5;
    return this.at(p[0]! - p[3]! + 5, p[1]! - p[0]! + 5);
  }
}

/** Wall segments of a view tile in view orientation (cRotatableWorld::GetWall's TileWalls word 0). */
export function viewWallSegs(world: RotatableWorld, x: number, y: number): number {
  const segs = world.getWallStorage(x, y, 1).segs;
  const rot = world.rotation & 3;
  // TileWalls::Rotate with the GenerateRotationLookups tables: edge bits
  // 1, 2, 4, 8 rotate left (8 wraps to 1); the two diagonals swap on odd turns.
  let out = 0;
  for (let bit = 1; bit <= 8; bit <<= 1) {
    if (!(segs & bit)) continue;
    let b = bit;
    for (let k = 0; k < rot; k++) {
      b <<= 1;
      if (b > 8) b = 1;
    }
    out |= b;
  }
  if (segs & 0x10) out |= rot & 1 ? 0x20 : 0x10;
  if (segs & 0x20) out |= rot & 1 ? 0x10 : 0x20;
  return out;
}

/**
 * cGouraudSwatch: Gouraud-shaded terrain. PreCompute lights every mesh point
 * (shade grid, 4 corner bytes per tile); Predraw picks the tile's corners and
 * its z value.
 */
export class GouraudSwatch extends TerrainRenderer {
  /** +0x04/+0x08: per tile [left, top, right, bottom] shade indices, size x size, indexed [x - minX][y - minY]. */
  protected shadeGrid: Uint8Array | null = null;
  protected gridSize = 0;
  /** +0x0c..+0x0f: current tile's corner shades [left, top, right, bottom]. */
  readonly corner = new Uint8Array(4);
  /** +0x10: ColorChunk per shade (4 dithered 16-bit colors). */
  protected shadeTable = new Uint16Array(0);
  /** +0x14: ColorChunk of z values written with every pixel of the tile. */
  readonly z = new Uint16Array(4);
  /** +0x1c: fDitherOffsets. */
  fDitherOffsets = [0, 10, 0, 6];
  /** +0x2c */
  fJitterEnvelope = 0;
  /** +0x30 */
  fJitterRandSeed = 0x40de9;
  /** +0x34 / +0x38 (set by PreCompute). */
  fMinColorIndex = 0;
  fMaxColorIndex = 0;
  /** +0x3c / +0x40 (floats, radians). */
  fLightSourceLongitude = 0;
  fLightSourceLatitude = GOURAUD_LATITUDE;
  /** +0x44: blend between the green (< 1) and brown/second pair (>= 1) shade gradients. */
  fColor = 0;
  /** +0x48 */
  fNumShades = 0x100;
  /** +0x4c..+0x60 */
  fLightGreen = 0x609022;
  fDarkGreen = 0x0e1405;
  fLightBrown = 0x896235;
  fDarkBrown = 0x22180d;
  protected color5c = 0xff;
  protected color60 = 0;

  /** Set when a parameter change needs PreCompute (the original calls it immediately). */
  stale = true;

  override init(world: RotatableWorld): boolean {
    this.allocGrid(world.size);
    this.preCompute(world);
    return true;
  }

  private allocGrid(size: number): void {
    if (!this.shadeGrid || this.gridSize !== size) {
      this.shadeGrid = new Uint8Array(size * size * 4);
      this.gridSize = size;
    }
  }

  override cleanUp(): void {
    this.shadeGrid = null;
    this.gridSize = 0;
    this.shadeTable = new Uint16Array(0);
  }

  override preCompute(world: RotatableWorld): void {
    this.allocGrid(world.size);
    this.fMinColorIndex = 0;
    this.fMaxColorIndex = this.fNumShades - 1;
    this.buildShadeTable();
    this.buildShadeGrid(world);
    this.stale = false;
  }

  /** BuildShadeTable: the plain Gouraud shade ramp, one rotated ColorChunk per shade. */
  private buildShadeTable(): void {
    const n = this.fNumShades;
    const table = new Uint16Array(n * 4);
    let from: number;
    let to: number;
    if (1 <= this.fColor) {
      const t = f(this.fColor - 1);
      from = lerpColor(t, this.fLightBrown, this.color5c);
      to = lerpColor(t, this.fDarkBrown, this.color60);
    } else {
      // Double-precision blend in the original; identical at the default fColor = 0.
      const t = this.fColor;
      const mix = (a: number, b: number, s: number): number => {
        const v = Math.trunc(t * ((((b >>> s) & 0xff) - ((a >>> s) & 0xff))) + ((a >>> s) & 0xff));
        return v < 0 ? 0 : v > 0xff ? 0xff : v;
      };
      from = mix(this.fLightGreen, this.fLightBrown, 0) | (mix(this.fLightGreen, this.fLightBrown, 16) << 16) | (mix(this.fLightGreen, this.fLightBrown, 8) << 8);
      to = mix(this.fDarkGreen, this.fDarkBrown, 0) | (mix(this.fDarkGreen, this.fDarkBrown, 16) << 16) | (mix(this.fDarkGreen, this.fDarkBrown, 8) << 8);
    }
    const g = new Gradient(from, to);
    for (let s = 0; s < n; s++) {
      const c = g.getColor16(f(s / n));
      for (let i = 0; i < 4; i++) table[s * 4 + i] = c;
      for (let i = 0; i < 4; i++) {
        const d = this.fDitherOffsets[i]!;
        if (d !== 0) table[s * 4 + i] = g.getColor16(f((s - d) / n));
      }
    }
    // Rotate each chunk left by (shade mod 4) so neighbouring shades dither out of phase.
    for (let s = 0; s < n; s++) {
      for (let k = 0; k < s % 4; k++) {
        const o = s * 4;
        const c0 = table[o]!;
        table[o] = table[o + 1]!;
        table[o + 1] = table[o + 2]!;
        table[o + 2] = table[o + 3]!;
        table[o + 3] = c0;
      }
    }
    this.shadeTable = table;
  }

  /** BuildShadeGrid: light every mesh point, spread to the tiles' corners, darken next to walls. */
  private buildShadeGrid(world: RotatableWorld): void {
    const grid = this.shadeGrid!;
    const size = this.gridSize;
    const light = new TerrainLightSource();
    const lat = this.fLightSourceLatitude;
    const lon = this.fLightSourceLongitude;
    const sinLat = f(Math.sin(lat));
    light.initTable([f(f(Math.cos(lon)) * sinLat), f(-f(Math.sin(lon)) * sinLat), f(Math.cos(lat))]);

    const saved = getSRandSeed();
    setSRandSeed(this.fJitterRandSeed);
    for (let x = 1; x < size; x++) {
      for (let y = 1; y < size; y++) {
        let v = this.findColorValueForMeshPoint(world, light, x, y);
        if (v < this.fMinColorIndex || this.fMaxColorIndex < v) v = 0;
        const o = (x * size + y) * 4;
        // Bytes 0, 2, 3 receive stale registers here; the second pass below
        // overwrites them for every tile that can be drawn.
        grid[o] = 0;
        grid[o + 1] = v;
        grid[o + 2] = 0;
        grid[o + 3] = 0;
      }
    }
    setSRandSeed(saved);

    // Each tile's top corner is its own mesh point; left = (x, y+1), right = (x+1, y), bottom = (x+1, y+1).
    for (let x = 1; x < size - 1; x++) {
      for (let y = 1; y < size - 1; y++) {
        const o = (x * size + y) * 4;
        grid[o] = grid[(x * size + y + 1) * 4 + 1]!;
        grid[o + 2] = grid[((x + 1) * size + y) * 4 + 1]!;
        grid[o + 3] = grid[((x + 1) * size + y + 1) * 4 + 1]!;
      }
    }

    // Wall segment 2 darkens the top and right corners (wall shadow).
    const max = this.fMaxColorIndex;
    for (let x = 0; x < size; x++) {
      for (let y = 0; y < size; y++) {
        if ((viewWallSegs(world, x + world.minX, y + world.minY) & 2) !== 2) continue;
        const o = (x * size + y) * 4;
        const top = grid[o + 1]! + 0x40;
        const right = grid[o + 2]! + 0x40;
        grid[o + 1] = max < top ? max : top;
        grid[o + 2] = max < right ? max : right;
      }
    }
  }

  /** FindColorValueForMeshPoint: average lighting of the six triangles around a mesh point. */
  private findColorValueForMeshPoint(world: RotatableWorld, light: TerrainLightSource, gx: number, gy: number): number {
    const x = gx + world.minX;
    const y = gy + world.minY;
    const a = world.getPackedAlt(x, y);
    const b = world.getPackedAlt(x - 1, y);
    const c = world.getPackedAlt(x - 1, y - 1);
    const d = world.getPackedAlt(x, y - 1);
    let s = light.getRightShading(a);
    s = f(light.getLeftShading(a) + s);
    s = f(light.getLeftShading(c) + s);
    s = f(light.getRightShading(c) + s);
    s = f(light.getLeftShading(d) + s);
    s = f(light.getRightShading(b) + s);
    // lbl_105BBF18[0] = 6.
    let v = Math.trunc(f(f(s / 6) * f(this.fMinColorIndex - this.fMaxColorIndex))) + this.fMaxColorIndex;
    if (this.fJitterEnvelope !== 0) v += sgsRand(this.fJitterEnvelope);
    if (v < this.fMinColorIndex) v = this.fMinColorIndex;
    if (this.fMaxColorIndex < v) v = this.fMaxColorIndex;
    return v & 0xff;
  }

  /** Predraw: corner shades from the grid and the tile's z (GetTerrainZ + 0x50). */
  override predraw(rp: RenderParam, world: RotatableWorld, x: number, y: number, _alt: PackedAlt): void {
    const z = rp.terrainZ ? (rp.terrainZ(x, y, rp.scale) + 0x50) & 0xffff : 0xffff;
    const gx = ((x - world.minX) << 24) >> 24;
    const gy = ((y - world.minY) << 24) >> 24;
    const grid = this.shadeGrid;
    const o = (gx * this.gridSize + gy) * 4;
    for (let i = 0; i < 4; i++) this.corner[i] = grid ? (grid[o + i] ?? 0) : 0;
    this.z.fill(z);
  }

  /** SetLatitudeByTimeOfDay: day 0, dusk 1 / dawn 3, night 2. */
  override setLatitudeByTimeOfDay(timeOfDay: number): void {
    let lat = 0;
    if (timeOfDay === 2) lat = LATITUDE_NIGHT;
    else if (timeOfDay === 0) lat = LATITUDE_DAY;
    else if (timeOfDay === 1 || timeOfDay === 3) lat = LATITUDE_TWILIGHT;
    this.fLightSourceLatitude = lat;
    this.stale = true;
  }

  /** Column of plain Gouraud shading (Draw/DrawClipped share it). */
  private gouraudColumn(t: TerrainTarget, x: number, y: number, n: number, v: number, step: number): void {
    for (let i = 0; i < n; i++) {
      let s = v >> 8;
      s = s < 0 ? 0 : s >= this.fNumShades ? this.fNumShades - 1 : s;
      putRow4(t, x, y + i, this.shadeTable, s * 4, this.z);
      v = (v + step) | 0;
    }
  }

  /** Draw__14cGouraudSwatch. */
  override draw(t: TerrainTarget, px: number, py: number, alt: PackedAlt, scale: number): void {
    const s1 = scale + 1;
    const half = 8 << scale;
    const [a0, a1, a2, a3] = [alt[0]!, alt[1]!, alt[2]!, alt[3]!];
    const [c0, c1, c2, c3] = this.corner;
    const dh = a1 - a3 + 4;
    let h = a0 - a3 + 2;
    let y = py - (a0 << s1);
    let top = c0! << 8;
    let bot = top;
    for (let col = 0; col < half; col += 4) {
      const step = h === 0 ? 0 : idiv(bot - top, h);
      this.gouraudColumn(t, px + col, y, h, top, step);
      y -= a1 - a0 + 2;
      h += dh;
      top += ((c1! - c0!) * 0x100) >> s1;
      bot += ((c3! - c0!) * 0x100) >> s1;
    }
    h = a2 - a3 + 2;
    y = py - (a2 << s1);
    top = c2! << 8;
    bot = top;
    for (let col = (16 << scale) - 4; col >= half; col -= 4) {
      top += ((c1! - c2!) * 0x100) >> s1;
      bot += ((c3! - c2!) * 0x100) >> s1;
      const step = h === 0 ? 0 : idiv(bot - top, h);
      this.gouraudColumn(t, px + col, y, h, top, step);
      y -= a1 - a2 + 2;
      h += dh;
    }
  }

  /** DrawClipped__14cGouraudSwatch. */
  override drawClipped(t: TerrainTarget, px: number, py: number, alt: PackedAlt, scale: number): void {
    const clip = t.clip;
    const s1 = scale + 1;
    const half = 8 << scale;
    const full = 16 << scale;
    const [a0, a1, a2, a3] = [alt[0]!, alt[1]!, alt[2]!, alt[3]!];
    const [c0, c1, c2, c3] = this.corner;
    let end = full;
    if (clip.right < px + full) end = (clip.right - px) & 0xfffc;
    const start = px < clip.left ? (clip.left - px + 3) & 0xfffc : 0;
    const dh = a1 - a3 + 4;
    const dyL = a1 - a0 + 2;
    const st = ((c1! - c0!) * 0x100) >> s1;
    const sb = ((c3! - c0!) * 0x100) >> s1;
    let top = c0! * 0x100 + ((st * start) >> 2);
    let bot = c0! * 0x100 + ((sb * start) >> 2);
    let h = a0 - a3 + (start >> 2) * dh + 2;
    let y = py - (a0 << s1) - (start >> 2) * dyL;
    for (let col = start; col < end && col < half; col += 4) {
      const step = h === 0 ? 0 : idiv(bot - top, h);
      this.clippedColumn(t, px + col, y, h, top, step);
      h += dh;
      y -= dyL;
      top += st;
      bot += sb;
    }
    const cut = full - end;
    const kR = idiv(cut, 4);
    const st2 = ((c1! - c2!) * 0x100) >> s1;
    const sb2 = ((c3! - c2!) * 0x100) >> s1;
    const dyR = a1 - a2 + 2;
    top = c2! * 0x100 + idiv(st2 * cut, 4);
    bot = c2! * 0x100 + idiv(sb2 * cut, 4);
    h = a2 - a3 + dh * kR + 2;
    y = py - (a2 << s1) - dyR * kR;
    for (let col = end - 4; col >= half && col >= start; col -= 4) {
      top += st2;
      bot += sb2;
      const step = h === 0 ? 0 : idiv(bot - top, h);
      this.clippedColumn(t, px + col, y, h, top, step);
      y -= dyR;
      h += dh;
    }
  }

  private clippedColumn(t: TerrainTarget, x: number, y: number, h: number, v: number, step: number): void {
    const clip = t.clip;
    if (y < clip.top) {
      v += step * (clip.top - y);
      h -= clip.top - y;
      y = clip.top;
    }
    if (clip.bottom < y + h) h = clip.bottom - y;
    this.gouraudColumn(t, x, y, h, v, step);
  }
}

/** GrassBlitParams (0x28 bytes). */
interface GrassBlade {
  /** +0x00: column the blade lives in. */
  column: number;
  /** +0x04: blade number; each tile draws a contiguous window of these. */
  index: number;
  /** +0x08: height in pixels. */
  height: number;
  /** +0x0c: x offset inside the 4-pixel column. */
  xOff: number;
  /** +0x10: position down the column, [0, 1). */
  frac: number;
  /** +0x14: shade offset (darker blades). */
  shadeOff: number;
  /** +0x18 / +0x1c: screen position of the blade's foot (per tile). */
  y: number;
  x: number;
  /** +0x20: 16-bit color. */
  color: number;
  /** +0x24: drawn length. */
  len: number;
}

/** GrassVector: vector<GrassBlitParams> of one column with a [begin, end) window. */
export class GrassVector {
  readonly data: GrassBlade[] = [];
  limBegin = 0;
  limEnd = 0;

  /**
   * SetLimits(lo, hi): galloping searches for the last blade with index < lo
   * (begin) and, from there, the last with index < hi (end). The begin blade
   * itself is below `lo` unless it is the first one, and the vector's last
   * blade is never inside the window: the original behaves this way.
   */
  setLimits(lo: number, hi: number): void {
    const n = this.data.length;
    let i = 0;
    let step = n >> 1;
    while (step !== 0) {
      const j = i + step;
      if (j < n && this.data[j]!.index < lo) i = j;
      else step >>>= 1;
    }
    this.limBegin = i;
    let k = i;
    step = n >> 1;
    while (step !== 0) {
      const j = k + step;
      if (j < n && this.data[j]!.index < hi) k = j;
      else step >>>= 1;
    }
    this.limEnd = k;
  }

  clearLimits(): void {
    this.limBegin = this.data.length;
    this.limEnd = this.data.length;
  }
}

/** Number of GrassVectors (columns of the widest tile, 128 / 4). */
const GRASS_COLUMNS = 0x20;

/**
 * cColorSwatch: the terrain renderer the game uses. Every pixel is
 * colorTable[grass color index][shade] where the color index comes from the
 * grass values around each corner (dirt = 0 .. green = fNumColors - 1) and
 * the shade from cGouraudSwatch's lighting; blade grass is sprinkled on top.
 */
export class ColorSwatch extends GouraudSwatch {
  /**
   * lbl_105BA604: blade height per scale (index scale - 1); a global that
   * Make* copy from lbl_105BA600 = {1, 1, 4} (normal lots) or
   * lbl_105BA5FC = {1, 1, 1} (snow, clouds).
   */
  static grassHeight = [1, 1, 4];

  /** +0x4c..+0x58 (overriding cGouraudSwatch's). */
  override fLightGreen = 0x50743b;
  override fDarkGreen = 0x0e3508;
  override fLightBrown = 0x9d7541;
  override fDarkBrown = 0x513c12;
  /** +0x64: per tile random u16 (grass window start), indexed [x - minX][y - minY]. */
  private tileRand: Uint16Array | null = null;
  private tileRandSize = 0;
  /** +0x68/+0x6c: WideColorChunk[fNumColors][fNumShades] (8 x u16 each). */
  private colorTable = new Uint16Array(0);
  /** +0x70/+0x74: WideColorChunk[2][fNumShades]: green and red highlight. */
  private hiliteTable = new Uint16Array(0);
  /** +0x78 */
  fNumColors = 0x20;
  /** +0x7c / +0x7d / +0x7e */
  fEnableBladeGrass = true;
  fEnableSpriteGrass = false;
  fDrawSmallGrass = true;
  /** +0x80 / +0x84 */
  fColorRandSeed = 0x3ef40de9;
  fGrassRandSeed = 0x4aa47b44;
  /** +0x88: soil lot, +0x89: clouds lot (latitude and mesh color rules). */
  private soil = false;
  private clouds = false;
  /** +0x8c / +0x90 / +0x94 */
  fShadeDispMin = 0x1e;
  fShadeDispMax = 0x3c;
  fShadeDispInvertible = true;
  /** +0x98 / +0x9c */
  fGrassLowDensityValue = -0x49;
  fGrassHighDensityValue = 0x55;
  /** +0xa0..+0xb4: blades per tile by quality level. */
  fQ0MaxGrassBladesPerTile = 0;
  fQ0MinGrassBladesPerTile = 0;
  fQ1MaxGrassBladesPerTile = 800;
  fQ1MinGrassBladesPerTile = 300;
  fQ2MaxGrassBladesPerTile = 1200;
  fQ2MinGrassBladesPerTile = 500;
  /** +0xb8..+0xc4 */
  fHiliteLightGreen = 0x14d525;
  fHiliteDarkGreen = 0x001400;
  fHiliteLightRed = 0xfe242e;
  fHiliteDarkRed = 0x140000;
  /** +0xc8: quality level, +0xcc / +0xd0: min / max blades per tile for it. */
  private quality = -1;
  private minBlades = 0;
  private maxBlades = 0;
  /** +0xd4: scale the blades were generated for, +0xd8: total blades. */
  private grassScale = -1;
  private totalBlades = 0;
  /** +0xdc: one GrassVector per column. */
  private readonly grass: GrassVector[] = Array.from({ length: GRASS_COLUMNS }, () => new GrassVector());
  /** +0x35c..+0x35f: corner color indices [left, top, right, bottom]. */
  readonly mesh = new Uint8Array(4);
  /** +0x360: tile random, +0x364: tile grass value. */
  private tileRandom = 0;
  private tileGrass = 0;
  /** +0x36c: blades in this tile, +0x370: first blade, +0x374: short blades. */
  private bladeCount = 0;
  private bladeStart = 0;
  private shortBlades = false;
  /** +0x378: 0, or 1 / 2 for the green / red highlight table. */
  private highlight = 0;
  /**
   * lbl_105BA58C: the terrain tools' highlight map (bit 0 = green, bit 1 =
   * red) at a view tile; null when no tool shows one.
   */
  highlightAt: ((x: number, y: number) => number) | null = null;

  private readonly shadeRamp = new FixRamp();
  private readonly colorRamp = new FixRamp();

  constructor() {
    super();
    this.fDitherOffsets = [0, 8, 0, 6];
    this.fJitterEnvelope = 3;
    this.fJitterRandSeed = 0x40de9;
    this.fNumShades = 0x80;
    this.fMinColorIndex = 0;
    this.fMaxColorIndex = 0x7f;
    this.fLightSourceLongitude = ECC[0];
    this.fLightSourceLatitude = ECC[4];
    this.setQualityLevel(2);
  }

  override countQualityLevels(): number {
    return 3;
  }

  override getQualityLevel(): number {
    return this.quality;
  }

  /** SetQualityLevel: 0 = no blades, 1 = 300..800, 2 = 500..1200 blades per tile. */
  override setQualityLevel(q: number): void {
    if (q === 1) {
      this.fEnableBladeGrass = true;
      this.minBlades = this.fQ1MinGrassBladesPerTile;
      this.maxBlades = this.fQ1MaxGrassBladesPerTile;
    } else if (q < 1 || 2 < q) {
      this.fEnableBladeGrass = false;
      q = 0;
      this.minBlades = this.fQ0MinGrassBladesPerTile;
      this.maxBlades = this.fQ0MaxGrassBladesPerTile;
    } else {
      this.fEnableBladeGrass = true;
      this.minBlades = this.fQ2MinGrassBladesPerTile;
      this.maxBlades = this.fQ2MaxGrassBladesPerTile;
    }
    this.quality = q;
  }

  override setLatitudeByTimeOfDay(timeOfDay: number): void {
    if (!this.soil && !this.clouds) {
      super.setLatitudeByTimeOfDay(timeOfDay);
      return;
    }
    let lat: number = ECC[0];
    if (!this.soil) lat = ECC[3];
    else if (timeOfDay === 2) lat = ECC[1];
    else if (timeOfDay === 0) lat = ECC[3];
    else if (timeOfDay === 1 || timeOfDay === 3) lat = ECC[2];
    this.fLightSourceLatitude = lat;
    this.stale = true;
  }

  private setColors(
    heights: readonly number[],
    lightGreen: number,
    darkGreen: number,
    lightBrown: number,
    darkBrown: number,
    hiliteLightGreen: number,
    hiliteDarkGreen: number,
  ): void {
    ColorSwatch.grassHeight = [...heights];
    this.fLightGreen = lightGreen;
    this.fDarkGreen = darkGreen;
    this.fLightBrown = lightBrown;
    this.fDarkBrown = darkBrown;
    this.fHiliteLightGreen = hiliteLightGreen;
    this.fHiliteDarkGreen = hiliteDarkGreen;
    this.fHiliteLightRed = 0xfe242e;
    this.fHiliteDarkRed = 0x140000;
    this.stale = true;
  }

  /** MakeDirt: the normal lot colors. */
  makeDirt(): void {
    this.setColors([1, 1, 4], 0x50743b, 0x0e3508, 0x9d7541, 0x513c12, 0x14d525, 0x001400);
    this.soil = false;
    this.clouds = false;
  }

  /** MakeSand(bool day). */
  makeSand(day: boolean): void {
    if (day) this.setColors([1, 1, 4], 0x50743b, 0x0e3508, 0xdcd2aa, 0xbdb38b, 0x14d525, 0x001400);
    else this.setColors([1, 1, 4], 0x50743b, 0x0e3508, 0x786e46, 0x594f27, 0x14d525, 0x001400);
    this.soil = false;
    this.clouds = false;
  }

  /** MakeSnow(bool day). */
  makeSnow(day: boolean): void {
    if (day) this.setColors([1, 1, 1], 0xe6f0ff, 0xa1b4d2, 0x9d7541, 0x513c12, 0, 0);
    else this.setColors([1, 1, 1], 0x828c9b, 0x6e6e82, 0x9d7541, 0x513c12, 0, 0);
    this.soil = false;
    this.clouds = false;
  }

  /** MakeLeaves. */
  makeLeaves(): void {
    this.setColors([1, 1, 4], 0x907a38, 0x683c20, 0x754b28, 0x3a260e, 0xb47832, 0x502819);
    this.soil = false;
    this.clouds = false;
  }

  /** MakeSoil. */
  makeSoil(): void {
    this.setColors([1, 1, 4], 0x505c48, 0x0e180a, 0x5a482b, 0x47460f, 0x5a645a, 0x181a18);
    this.fHiliteLightRed = 0x2e3030;
    this.fHiliteDarkRed = 0x141614;
    this.soil = true;
    this.clouds = false;
  }

  /** MakeClouds. */
  makeClouds(): void {
    this.setColors([1, 1, 1], 0xe6f0ff, 0xa1b4d2, 0x14148c, 0x14148c, 0xffffff, 0xffffff);
    this.soil = false;
    this.clouds = true;
  }

  override cleanUp(): void {
    super.cleanUp();
    this.colorTable = new Uint16Array(0);
    this.hiliteTable = new Uint16Array(0);
    this.tileRand = null;
    this.tileRandSize = 0;
  }

  /** PreCompute: lighting, the per-tile random array and the color tables. */
  override preCompute(world: RotatableWorld): void {
    super.preCompute(world);
    this.grassScale = -1;
    const size = world.size;
    if (this.tileRand && this.tileRandSize !== size) this.tileRand = null;
    if (!this.tileRand) {
      const arr = new Uint16Array(size * size);
      const saved = getSRandSeed();
      setSRandSeed(this.fGrassRandSeed);
      for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
          const r = getNextRandomNumber();
          arr[x * size + y] = r + Math.floor(r / 0xffff);
        }
      }
      setSRandSeed(saved);
      this.tileRand = arr;
      this.tileRandSize = size;
    }

    const shades = this.fNumShades;
    const colors = this.fNumColors;
    const table = new Uint16Array(colors * shades * 8);
    for (let r = 0; r < colors; r++) {
      const t = f(f(r) / f(colors - 1));
      const g = new Gradient(lerpColor(t, this.fLightBrown, this.fLightGreen), lerpColor(t, this.fDarkBrown, this.fDarkGreen));
      this.fillGradientRow(table, r * shades * 8, g);
    }
    this.colorTable = table;

    const hilite = new Uint16Array(2 * shades * 8);
    this.fillGradientRow(hilite, 0, new Gradient(this.fHiliteLightGreen, this.fHiliteDarkGreen));
    this.fillGradientRow(hilite, shades * 8, new Gradient(this.fHiliteLightRed, this.fHiliteDarkRed));
    this.hiliteTable = hilite;
  }

  /** One row of WideColorChunks: shade s gets g(s / n), entries with a dither offset d get g((s - d) / n). */
  private fillGradientRow(table: Uint16Array, at: number, g: Gradient): void {
    const n = this.fNumShades;
    for (let s = 0; s < n; s++) {
      const o = at + s * 8;
      const c = g.getColor16(f(f(s) / f(n)));
      for (let i = 0; i < 4; i++) setWideColor16(table, o, i, c);
      for (let i = 0; i < 4; i++) {
        const d = this.fDitherOffsets[i]!;
        if (d !== 0) setWideColor16(table, o, i, g.getColor16(f(f(s - d) / f(n))));
      }
    }
  }

  /** InitGrass(scale): scatter the blades over the columns of a tile at this scale. */
  private initGrass(scale: number): void {
    if (scale === this.grassScale) return;
    this.grassScale = scale;
    const saved = getSRandSeed();
    if (this.fGrassRandSeed === 0) this.fGrassRandSeed = getSRandSeed();
    setSRandSeed(this.fGrassRandSeed);
    for (const v of this.grass) v.data.length = 0;
    const cols = idiv(8 << scale, 4);
    this.totalBlades = this.maxBlades << 2;
    // Pixel area of one half tile: columns of height 2, 6, 10, ... (8 + 16k pixels each).
    const area = (cols * 8 + idiv(cols * (cols - 1) * 0x10, 2)) >>> 0;
    if (this.totalBlades < 500) this.totalBlades = 500;
    for (let i = 0; i < this.totalBlades; i++) {
      const r = getNextRandomNumber() % ((area * 2) >>> 0);
      let rem = r % area;
      let col = 0;
      for (let k = 8; 0 < rem && k <= rem; k += 0x10) {
        rem -= k;
        col++;
      }
      // The second half of the range mirrors into the right half of the tile.
      if (r >= area) col = cols * 2 - col - 1;
      const xr = getNextRandomNumber();
      const fr = getNextRandomNumber() % 0xfa1;
      const span = (this.fShadeDispMax - this.fShadeDispMin + 1) >>> 0;
      let disp = getNextRandomNumber() % span;
      if (this.fShadeDispInvertible && getNextRandomNumber() & 1) disp = -disp;
      let height = this.fDrawSmallGrass ? ColorSwatch.grassHeight[scale - 1]! : 0;
      if (1 < height) height -= getNextRandomNumber() % (height >> 1);
      this.grass[col]!.data.push({
        column: col,
        index: i,
        height,
        xOff: xr & 3,
        frac: f(f(fr) / 4001),
        shadeOff: this.fShadeDispMin + disp,
        y: 0,
        x: 0,
        color: 0,
        len: 0,
      });
    }
    setSRandSeed(saved);
  }

  /** ComputeMeshPointColorIndex: average grass of the four tiles around a mesh point -> color row. */
  private computeMeshPointColorIndex(world: RotatableWorld, x: number, y: number): number {
    const sum = world.getGrass(x, y) + world.getGrass(x - 1, y) + world.getGrass(x - 1, y - 1) + world.getGrass(x, y - 1);
    const n = this.fNumColors;
    let i = idiv((idiv(sum, 4) + 0x80) * n, 256);
    if (i < 0) i = 0;
    if (n <= i) i = n - 1;
    return i;
  }

  override predraw(rp: RenderParam, world: RotatableWorld, x: number, y: number, alt: PackedAlt): void {
    super.predraw(rp, world, x, y, alt);
    this.highlight = 0;
    if (this.highlightAt) {
      const b = this.highlightAt(x, y);
      if (b & 1) this.highlight = 1;
      else if (b & 2) this.highlight = 2;
    }
    const rx = ((x - world.minX) << 24) >> 24;
    const ry = ((y - world.minY) << 24) >> 24;
    this.initGrass(rp.scale);
    if (!world.inInterior(x, y)) return;

    const m = this.mesh;
    if (this.highlight !== 0) {
      m.fill(this.highlight - 1);
    } else {
      const size = world.size;
      if (this.clouds && (rx < 2 || ry < 2 || size - 2 <= rx || size - 2 <= ry)) {
        m.fill(0);
      } else {
        m[1] = this.computeMeshPointColorIndex(world, x, y);
        m[0] = this.computeMeshPointColorIndex(world, x, y + 1);
        m[3] = this.computeMeshPointColorIndex(world, x + 1, y + 1);
        m[2] = this.computeMeshPointColorIndex(world, x + 1, y);
      }
    }
    this.tileGrass = world.getGrass(x, y);
    this.tileRandom = this.tileRand ? (this.tileRand[rx * this.tileRandSize + ry] ?? 0) : 0;
    // +0x368 (sprite grass kind) is only computed when fEnableSpriteGrass,
    // which is off, and nothing draws it.

    if (!this.fEnableBladeGrass) {
      this.bladeCount = 0;
    } else {
      const h = this.fDrawSmallGrass ? ColorSwatch.grassHeight[rp.scale - 1]! : 0;
      if (h === 0) {
        this.bladeCount = 0;
      } else if (world.getFloor(x, y, 1) === 0) {
        if (world.hasPoolOrDeck(x, y, 1)) {
          this.bladeCount = 0;
        } else {
          const g = this.tileGrass;
          const lo = this.fGrassLowDensityValue;
          const hi = this.fGrassHighDensityValue;
          if (g < hi) {
            if (lo < g) {
              this.shortBlades = false;
              const d = hi - lo;
              this.bladeCount = d < 1 ? 0 : this.minBlades + idiv((g - lo) * (this.maxBlades - this.minBlades), d);
            } else {
              this.bladeCount = this.minBlades;
              this.shortBlades = true;
            }
          } else {
            this.bladeCount = this.maxBlades;
            this.shortBlades = false;
          }
          if (rp.scale === 1) this.bladeCount = idiv(this.bladeCount, 4);
        }
      } else if ((viewWallSegs(world, x, y) & 0x30) === 0) {
        // Floored tile: no blades. With a diagonal wall the tile keeps the
        // previous tile's blade count (the original leaves it untouched).
        this.bladeCount = 0;
      }
    }
    if (this.bladeCount !== 0) {
      const span = (this.totalBlades - this.bladeCount) >>> 0;
      this.bladeStart = span === 0 ? 0 : (this.tileRandom >>> 0) % span;
    }
  }

  /** Lay out the column's blades for this tile: position, length and color (Draw / DrawClipped). */
  private placeBlades(vec: GrassVector, colX: number, top: number, h: number): void {
    if (h < 1 || this.bladeCount === 0) {
      vec.clearLimits();
      return;
    }
    vec.setLimits(this.bladeStart, this.bladeStart + this.bladeCount);
    const shades = this.fNumShades;
    const colors = this.fNumColors;
    for (let i = vec.limBegin; i !== vec.limEnd; i++) {
      const b = vec.data[i]!;
      b.x = colX + b.xOff;
      b.y = top + Math.trunc(f(b.frac * f(h)));
      b.len = b.height;
      if (this.shortBlades && --b.len === 0) b.len = 1;
      let s = this.shadeRamp.peekNth(b.y - top) + b.shadeOff;
      if (s < 0) s = 0;
      if (shades <= s) s = shades - 1;
      let c = this.colorRamp.peekNth(b.y - top);
      if (c < 0) c = 0;
      if (colors <= c) c = colors - 1;
      b.color = this.colorTable[(c * shades + s) * 8]!;
    }
  }

  /** Blades drawn upward from their foot, writing the tile's z (Draw: no clipping). */
  private drawBlades(t: TerrainTarget, vec: GrassVector): void {
    const z = this.z[0]!;
    for (let i = vec.limBegin; i !== vec.limEnd; i++) {
      const b = vec.data[i]!;
      for (let k = 0; k < b.len; k++) putPixel(t, b.x, b.y - k, b.color, z);
    }
  }

  /** Blades clipped to the clip rect (DrawClipped; the left test is x >= 0, not clip.left). */
  private drawBladesClipped(t: TerrainTarget, vec: GrassVector): void {
    const clip = t.clip;
    const z = this.z[0]!;
    for (let i = vec.limBegin; i !== vec.limEnd; i++) {
      const b = vec.data[i]!;
      let bottom = b.y;
      let top = bottom - b.len + 1;
      if (b.x < 0 || clip.right <= b.x || bottom < clip.top || clip.bottom <= top) continue;
      if (top < clip.top) top = clip.top;
      if (clip.bottom <= bottom) bottom = clip.bottom - 1;
      for (let yy = bottom; yy >= top; yy--) putPixel(t, b.x, yy, b.color, z);
    }
  }

  private setRamps(h: number, shadeTop: number, shadeBot: number, colorTop: number, colorBot: number): void {
    if (h === 0) return;
    this.shadeRamp.v = shadeTop;
    this.shadeRamp.d = idiv(shadeBot - shadeTop, h);
    this.colorRamp.v = colorTop;
    this.colorRamp.d = idiv(colorBot - colorTop, h);
  }

  private blit(t: TerrainTarget, x: number, y: number, n: number): void {
    if (this.highlight === 0) {
      colorSwatchColumnBlit(t, x, y, n, this.colorTable, this.fNumShades, this.shadeRamp, this.colorRamp, this.z);
    } else {
      colorSwatchColumnBlitHighlighted(t, x, y, n, this.hiliteTable, this.fNumShades, this.shadeRamp, this.colorRamp, this.z);
    }
  }

  /** cColorSwatch::Draw: whole tile inside the clip rect. */
  override draw(t: TerrainTarget, px: number, py: number, alt: PackedAlt, scale: number): void {
    const s1 = scale + 1;
    const half = 8 << scale;
    const [a0, a1, a2, a3] = [alt[0]!, alt[1]!, alt[2]!, alt[3]!];
    const [c0, c1, c2, c3] = this.corner;
    const [m0, m1, m2, m3] = this.mesh;
    const dh = a1 - a3 + 4;

    // Left half: from the left corner to the middle.
    const dyL = a1 - a0 + 2;
    let h = a0 - a3 + 2;
    let y = py - (a0 << s1);
    let sTop = c0! << 8;
    let sBot = sTop;
    let cTop = m0! << 8;
    let cBot = cTop;
    const sdT = ((c1! - c0!) * 0x100) >> s1;
    const sdB = ((c3! - c0!) * 0x100) >> s1;
    const cdT = ((m1! - m0!) * 0x100) >> s1;
    const cdB = ((m3! - m0!) * 0x100) >> s1;
    for (let col = 0, v = 0; col < half; col += 4, v++) {
      this.setRamps(h, sTop, sBot, cTop, cBot);
      const vec = this.grass[v]!;
      this.placeBlades(vec, px + col, y, h);
      this.blit(t, px + col, y, h);
      if (this.highlight === 0) this.drawBlades(t, vec);
      y -= dyL;
      h += dh;
      sTop += sdT;
      sBot += sdB;
      cTop += cdT;
      cBot += cdB;
    }

    // Right half: from the right corner back to the middle; the ramps step before each column.
    const dyR = a1 - a2 + 2;
    h = a2 - a3 + 2;
    y = py - (a2 << s1);
    sTop = c2! << 8;
    sBot = sTop;
    cTop = m2! << 8;
    cBot = cTop;
    const sdT2 = ((c1! - c2!) * 0x100) >> s1;
    const sdB2 = ((c3! - c2!) * 0x100) >> s1;
    const cdT2 = ((m1! - m2!) * 0x100) >> s1;
    const cdB2 = ((m3! - m2!) * 0x100) >> s1;
    for (let col = (16 << scale) - 4; half <= col; col -= 4) {
      sTop += sdT2;
      sBot += sdB2;
      cTop += cdT2;
      cBot += cdB2;
      this.setRamps(h, sTop, sBot, cTop, cBot);
      const vec = this.grass[col >> 2]!;
      this.placeBlades(vec, px + col, y, h);
      this.blit(t, px + col, y, h);
      if (this.highlight === 0) this.drawBlades(t, vec);
      y -= dyR;
      h += dh;
    }
  }

  /** cColorSwatch::DrawClipped: same as Draw, restricted to the clip rect. */
  override drawClipped(t: TerrainTarget, px: number, py: number, alt: PackedAlt, scale: number): void {
    const clip = t.clip;
    const s1 = scale + 1;
    const half = 8 << scale;
    const full = 16 << scale;
    const [a0, a1, a2, a3] = [alt[0]!, alt[1]!, alt[2]!, alt[3]!];
    const [c0, c1, c2, c3] = this.corner;
    const [m0, m1, m2, m3] = this.mesh;
    const dh = a1 - a3 + 4;

    let end = full;
    if (clip.right < px + full) end = (clip.right - px) & 0xfffc;
    const start = px < clip.left ? (clip.left - px + 3) & 0xfffc : 0;

    // Left half, starting at the first visible column.
    let k = start >> 2;
    const dyL = a1 - a0 + 2;
    const sdT = ((c1! - c0!) * 0x100) >> s1;
    const sdB = ((c3! - c0!) * 0x100) >> s1;
    const cdT = ((m1! - m0!) * 0x100) >> s1;
    const cdB = ((m3! - m0!) * 0x100) >> s1;
    let h = a0 - a3 + k * dh + 2;
    let y = py - (a0 << s1) - k * dyL;
    let sTop = c0! * 0x100 + sdT * k;
    let sBot = c0! * 0x100 + sdB * k;
    let cTop = m0! * 0x100 + cdT * k;
    let cBot = m0! * 0x100 + cdB * k;
    const endL = half < end ? half : end;
    for (let col = start; col < endL; col += 4, k++) {
      this.setRamps(h, sTop, sBot, cTop, cBot);
      const vec = this.grass[k]!;
      this.placeBlades(vec, px + col, y, h);
      this.clippedBlit(t, px + col, y, h);
      if (this.highlight === 0) this.drawBladesClipped(t, vec);
      y -= dyL;
      h += dh;
      sTop += sdT;
      sBot += sdB;
      cTop += cdT;
      cBot += cdB;
    }

    // Right half, starting at the last visible column.
    const cut = full - end;
    const kR = idiv(cut, 4);
    const dyR = a1 - a2 + 2;
    const sdT2 = ((c1! - c2!) * 0x100) >> s1;
    const sdB2 = ((c3! - c2!) * 0x100) >> s1;
    const cdT2 = ((m1! - m2!) * 0x100) >> s1;
    const cdB2 = ((m3! - m2!) * 0x100) >> s1;
    h = a2 - a3 + dh * kR + 2;
    y = py - (a2 << s1) - dyR * kR;
    sTop = c2! * 0x100 + sdT2 * kR;
    sBot = c2! * 0x100 + sdB2 * kR;
    cTop = m2! * 0x100 + cdT2 * kR;
    cBot = m2! * 0x100 + cdB2 * kR;
    const limR = start < half ? half : start;
    for (let col = end - 4; limR <= col; col -= 4) {
      sTop += sdT2;
      sBot += sdB2;
      cTop += cdT2;
      cBot += cdB2;
      this.setRamps(h, sTop, sBot, cTop, cBot);
      const vec = this.grass[idiv(col, 4)]!;
      this.placeBlades(vec, px + col, y, h);
      this.clippedBlit(t, px + col, y, h);
      if (this.highlight === 0) this.drawBladesClipped(t, vec);
      y -= dyR;
      h += dh;
    }
  }

  /** Vertical clip of one column: skipped rows advance the ramps. */
  private clippedBlit(t: TerrainTarget, x: number, y: number, h: number): void {
    const clip = t.clip;
    if (y < clip.top) {
      const skip = clip.top - y;
      this.shadeRamp.v += this.shadeRamp.d * skip;
      this.colorRamp.v += this.colorRamp.d * skip;
      h -= skip;
      y = clip.top;
    }
    if (clip.bottom < y + h) h = clip.bottom - y;
    this.blit(t, x, y, h);
  }

  /** ModifyTileRect__12cColorSwatch: room for the blades above the tile. */
  override modifyTileRect(_x: number, _y: number, scale: number, r: TileRect): void {
    r.top -= 2;
    r.bottom += 2;
    if (!this.fEnableBladeGrass) return;
    r.top -= this.fDrawSmallGrass ? ColorSwatch.grassHeight[scale - 1]! : 0;
  }
}
