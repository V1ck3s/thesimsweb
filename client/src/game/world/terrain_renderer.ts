/**
 * Shared pieces of the terrain renderers: the render target, the per-tile
 * render parameters, the cTerrainRenderer base class and the 16-bit color
 * conversions (GetColor16FromRGB / GetColorRGBFrom16).
 */

import type { RotatableWorld } from "./world.js";

export interface TerrainTarget {
  width: number;
  height: number;
  /** RGBA8 pixels packed little-endian: 0xAABBGGRR (alpha 255). */
  color: Uint32Array;
  /**
   * Not part of the original (perf, HouseViewer.scrollTerrain): when set, the
   * pixels as they would be with the other row parity (the swatches dither
   * by screen row), written along with `color`.
   */
  color2?: Uint32Array;
  /** 16-bit z-buffer, same units as the original (0xffff = cleared/far). */
  depth: Uint16Array;
  /** Clip rectangle in target pixels (the original's lbl_105BA5F4 rect). */
  clip: { left: number; top: number; right: number; bottom: number };
}

/** The parts of RenderParam the terrain uses. */
export interface RenderParam {
  /** RenderParam+0x20: zoom scale, 1 (far) .. 3 (near). */
  scale: number;
  /**
   * ZBufferLookup::GetTerrainZ(tile at level 1, scale, clamp = true): depth of
   * the tile's top corner, clamped to [0, 0xffff]. Null when no z-buffer
   * lookup is available (the terrain then writes 0xffff).
   */
  terrainZ: ((x: number, y: number, scale: number) => number) | null;
}

/** A Win32 RECT (left, top, right, bottom) as ModifyTileRect sees it. */
export interface TileRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Corner altitudes of a tile in view space: [left, top, right, bottom] (PackedAlt bytes 0..3). */
export type PackedAlt = readonly number[];

/** cTerrainRenderer: the do-nothing base of every terrain renderer. */
export class TerrainRenderer {
  /** Init: 0 = failure for the base class. */
  init(_world: RotatableWorld): boolean {
    return false;
  }

  cleanUp(): void {}

  preCompute(_world: RotatableWorld): void {}

  /** ModifyTileRect__16cTerrainRenderer: two extra pixels above and below the tile. */
  modifyTileRect(_x: number, _y: number, _scale: number, r: TileRect): void {
    r.top -= 2;
    r.bottom += 2;
  }

  predraw(_rp: RenderParam, _world: RotatableWorld, _x: number, _y: number, _alt: PackedAlt): void {}

  draw(_t: TerrainTarget, _x: number, _y: number, _alt: PackedAlt, _scale: number): void {}

  drawClipped(_t: TerrainTarget, _x: number, _y: number, _alt: PackedAlt, _scale: number): void {}

  setLatitudeByTimeOfDay(_timeOfDay: number): void {}

  countQualityLevels(): number {
    return 0;
  }

  getQualityLevel(): number {
    return 0;
  }

  setQualityLevel(_q: number): void {}
}

/**
 * Display pixel format (App+0x34) used by GetColor16FromRGB: 2 = RGB 565 (the
 * usual Windows 16-bit DirectDraw surface), 3 = 556, 4 = 655, anything else =
 * 555 (the Mac build).
 */
let displayFormat = 2;
/**
 * How 5/6-bit channels widen to 8 bits on screen. The game's own
 * GetColorRGBFrom16 shifts with zero low bits, and so do real screenshots
 * (ui.png: every grass channel is a multiple of 8 / 4); bit replication
 * ((v << 3) | (v >> 2)) is available as an option.
 */
let replicateLowBits = false;
let rgbaLutTable: Uint32Array | null = null;

export function setDisplayFormat(format: number, replicate = false): void {
  if (format !== displayFormat || replicate !== replicateLowBits) {
    displayFormat = format;
    replicateLowBits = replicate;
    rgbaLutTable = null;
  }
}

/** App+0x34: the display pixel format (see displayFormat). */
export function getDisplayFormat(): number {
  return displayFormat;
}

/** GetColor16FromRGB(0x00RRGGBB). */
export function getColor16FromRGB(c: number): number {
  switch (displayFormat) {
    case 3:
      return ((c >>> 2) & 0x3f) | ((c >>> 8) & 0xf800) | ((c >>> 5) & 0x7c0);
    case 2:
      return ((c >>> 3) & 0x1f) | ((c >>> 8) & 0xf800) | ((c >>> 5) & 0x7e0);
    case 4:
      return ((c >>> 3) & 0x1f) | ((c >>> 7) & 0xf800) | ((c >>> 5) & 0x7c0);
    default:
      return ((c >>> 3) & 0x1f) | ((c >>> 9) & 0x7c00) | ((c >>> 6) & 0x3e0);
  }
}

/** Channel bit widths [r, g, b] and shifts of the current display format. */
function layout(): [number, number, number, number, number, number] {
  switch (displayFormat) {
    case 3:
      return [5, 5, 6, 11, 6, 0];
    case 2:
      return [5, 6, 5, 11, 5, 0];
    case 4:
      return [6, 5, 5, 10, 5, 0];
    default:
      return [5, 5, 5, 10, 5, 0];
  }
}

/** Widen an n-bit channel to 8 bits (see replicateLowBits). */
function expand(v: number, bits: number): number {
  const hi = (v << (8 - bits)) & 0xff;
  return replicateLowBits ? hi | (v >> (2 * bits - 8)) : hi;
}

/** 16-bit framebuffer color -> RGBA8 (0xAABBGGRR) as it shows on screen. */
export function rgbaFrom16(c: number): number {
  return rgbaLut()[c & 0xffff]!;
}

/** rgbaFrom16 as a table of the 65536 colors. */
export function rgbaLut(): Uint32Array {
  if (!rgbaLutTable) {
    const [rb, gb, bb, rs, gs, bs] = layout();
    rgbaLutTable = new Uint32Array(0x10000);
    for (let i = 0; i < 0x10000; i++) {
      const r = expand((i >> rs) & ((1 << rb) - 1), rb);
      const g = expand((i >> gs) & ((1 << gb) - 1), gb);
      const b = expand((i >> bs) & ((1 << bb) - 1), bb);
      rgbaLutTable[i] = ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0;
    }
  }
  return rgbaLutTable;
}

/** Single-precision fused multiply-add (PPC fmadds): round(a * b + c) to float. */
export function fmadds(a: number, b: number, c: number): number {
  return Math.fround(a * b + c);
}

/** C integer division (truncates toward zero). */
export function idiv(a: number, b: number): number {
  return Math.trunc(a / b);
}
