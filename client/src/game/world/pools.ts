/**
 * cPoolLayer / cPoolTile and cWaterLayer / cWaterTile: the pool and water
 * arrays of cFixedWorld (+0x60 pool, +0x64 water; house Arry 9 and 10), one
 * byte per world tile:
 *   0xff     nothing
 *   0..0x0f  pool (or water) tile; bits = which neighbors are pool too:
 *            1 (0, -1), 2 (-1, 0), 4 (0, +1), 8 (+1, 0) (world coordinates)
 *   0x10     pool deck (cPoolTool::AddDeck)
 *
 * HouseViewer draws a pool tile with the global floor renderer's sprite
 * 0x400 + (scale - 1) * 0x10 + bits (bits turned to the view rotation by
 * cPoolTile::Rotate), a deck tile with floor sprite 0x0c of the scale, and
 * the inner corners cPoolLayer::GetOverlappingSprite finds with sprites
 * 0x430 + (scale - 1) * 4 + corner. Water tiles are z-sprites 0x800 + bits
 * (frame 3 - scale).
 */

import { ARRAY_SIZE, DIRS, type FixedWorld } from "./world.js";

export const POOL_NONE = 0xff;
export const POOL_DECK = 0x10;

/**
 * lbl_105BA3B4 (VertexConfig::GenerateLookups): the four edge bits seen
 * through a view rotation of 1..3 quarter turns (bits 1/2/4/8 -> 8/1/2/4,
 * 4/8/1/2, 2/4/8/1).
 */
const EDGE_ROTATION: ReadonlyArray<readonly number[]> = [
  [1, 2, 4, 8],
  [8, 1, 2, 4],
  [4, 8, 1, 2],
  [2, 4, 8, 1],
];

/** cPoolTile::Rotate / cWaterTile::Rotate: the low nibble turned, the high one kept. */
export function rotateTileBits(v: number, rotation: number): number {
  if (rotation < 1) return v;
  const t = EDGE_ROTATION[rotation & 3]!;
  let out = 0;
  for (let b = 0; b < 4; b++) if (v & (1 << b)) out |= t[b]!;
  return out | (v & 0xf0);
}

/**
 * lbl_105BBB9C (__sinit_PoolLayer_cpp): for each inner corner, the tile's
 * required bits, a first neighbor (dx, dy) that must have `clear` bits off
 * and `set` bits on, a second one likewise, and the corner bit.
 */
const CORNERS: ReadonlyArray<readonly number[]> = [
  [3, -1, 0, 1, 8, 0, -1, 2, 4, 1],
  [6, -1, 0, 4, 8, 0, 1, 2, 1, 2],
  [9, 0, -1, 8, 4, 1, 0, 1, 2, 8],
  [0xc, 0, 1, 8, 1, 1, 0, 4, 2, 4],
];

/** AddPool / RemovePool neighbors: DIRS index and the bit the neighbor gets (lbl_105BBB90 / 8C). */
const POOL_DIRS = [2, 0, 3, 1];
const POOL_MASKS = [8, 4, 2, 1];

/** A pool or water array (c2DArray of bytes, world coordinates). */
export interface ByteLayer {
  u8(x: number, y: number): number;
  data: Uint8Array;
}

function at(layer: ByteLayer, x: number, y: number): number {
  return layer.data[x * ARRAY_SIZE + y]!;
}

function set(layer: ByteLayer, x: number, y: number, v: number): void {
  layer.data[x * ARRAY_SIZE + y] = v;
}

/**
 * cPoolLayer::GetOverlappingSprite(view tile, rotation): inner corner bits
 * (1, 2, 4, 8) of a pool tile, turned to the view.
 */
export function getOverlappingSprite(fixed: FixedWorld, layer: ByteLayer, wx: number, wy: number, rotation: number): number {
  const size = fixed.size;
  const out = (x: number, y: number): boolean => x < 0 || x >= size || y < 0 || y >= size;
  if (out(wx, wy)) return 0;
  const cur = at(layer, wx, wy);
  let r = 0;
  for (const e of CORNERS) {
    if ((e[0]! & cur) !== e[0]) continue;
    const x1 = wx + e[1]!;
    const y1 = wy + e[2]!;
    if (out(x1, y1)) continue;
    const b1 = at(layer, x1, y1);
    if ((b1 & e[3]!) !== 0 || (b1 & e[4]!) === 0) continue;
    const x2 = wx + e[5]!;
    const y2 = wy + e[6]!;
    if (out(x2, y2)) continue;
    const b2 = at(layer, x2, y2);
    if ((b2 & e[7]!) === 0 && (b2 & e[8]!) !== 0) r |= e[9]!;
  }
  for (let k = 0; k < rotation; k++) {
    const low = r & 1;
    r >>= 1;
    if (low) r |= 8;
  }
  return r;
}

/** cPoolLayer::AddPool(CTilePt) (also cWaterLayer::AddWater). */
export function addPool(layer: ByteLayer, x: number, y: number): void {
  if (at(layer, x, y) <= 0xf) return;
  set(layer, x, y, 0);
  for (let i = 0; i < 4; i++) {
    const [dx, dy] = DIRS[POOL_DIRS[i]!]!;
    const nx = x + dx;
    const ny = y + dy;
    const v = at(layer, nx, ny);
    if (v < 0x10) {
      set(layer, nx, ny, v | POOL_MASKS[i]!);
      set(layer, x, y, at(layer, x, y) | POOL_MASKS[(i + 2) & 3]!);
    }
  }
}

/** cPoolLayer::RemovePool(CTilePt) (also cWaterLayer::RemoveWater). */
export function removePool(layer: ByteLayer, x: number, y: number): void {
  if (at(layer, x, y) >= 0x10) return;
  set(layer, x, y, POOL_NONE);
  for (let i = 0; i < 4; i++) {
    const [dx, dy] = DIRS[POOL_DIRS[i]!]!;
    const nx = x + dx;
    const ny = y + dy;
    const v = at(layer, nx, ny);
    if (v < 0x10) set(layer, nx, ny, v & ~POOL_MASKS[i]!);
  }
}

/** cPoolLayer::ClearDeck: deck tiles of the whole lot become nothing. */
export function clearDeck(layer: ByteLayer, size: number): void {
  for (let x = 0; x < size; x++) for (let y = 0; y < size; y++) if (at(layer, x, y) === POOL_DECK) set(layer, x, y, POOL_NONE);
}

/** Sprite id of a pool byte (RenderStaticRow): pool tile or deck. */
export function poolSpriteId(v: number, scale: number): number {
  return v < 0x10 ? (scale - 1) * 0x10 + v + 0x400 : (scale - 1) * 0x100 + 0xc;
}

/** Sprite id of a pool inner corner (bit index 0..3). */
export function poolCornerSpriteId(corner: number, scale: number): number {
  return (scale - 1) * 4 + 0x430 + corner;
}
