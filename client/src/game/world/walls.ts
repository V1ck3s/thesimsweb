/**
 * Walls: WallManager (the per-level wall graph, cutaway, drawing), Wall (a
 * straight run of wall segments between two vertices), WallSegment (one tile
 * of a wall: cutaway flags, style, a pattern per side) and Vertex (a grid
 * point where walls end, turn or branch; draws the wall tops and end caps).
 *
 * Graph (WallManager::BuildGraphFromMap): every grid point whose vertex
 * configuration (AnalyzeWallVertex) is a joint or an end becomes a Vertex;
 * each Vertex then builds the walls leaving it toward +y / (+1,+1) and
 * +x / (+1,-1) (Vertex::BuildWalls -> Wall::BuildFromVertex), walking the
 * grid until the next vertex. Walls and vertices are built in world
 * coordinates at rotation 0 and rotated in place (SetRotation) so that every
 * coordinate they hold is a view coordinate; a rotated wall is re-oriented
 * so it runs from its iso-first vertex (directions 1, 3, 5, 6 only).
 *
 * WallSegment.flags (byte 0):
 *   0x01 cut down (short wall), 0x02 / 0x04 cut piece next to a full wall on
 *   the screen-left / screen-right end, 0x08 two-pass style (styles 3, 5, 6,
 *   0xf, 0x17 and 0x16 when cut).
 * Styles: 0xff no wall, 2 / 0xc / 0xd / 0xe fences (never cut), 0x16 / 0x17
 * walls whose sprite comes from a door/window object (GETCUSTOMSTYLE).
 *
 * Cutaway (HouseViewer::PrepareWorldForUpdate): levels below the current one
 * (and every level while the roof is drawn) have full walls; the current
 * level is all cut (walls down, Wall::SetCutaway(true)), cut along a tile
 * mask (cutaway, Wall::ComputeCutaway(BitMatrix64)) or full (walls up).
 * Vertex::ComputeCutaway / ComputeCutawaySecondPass then decide which wall
 * tops are drawn full height, cut, or as end caps.
 *
 * Wall states (CPState::SetWallState): Up -> SetCutaway(false),
 * SetDynamicCutaway(false); Down -> SetCutaway(true); Cutaway ->
 * SetDynamicCutaway(true); Roof -> SetDrawRoof(true).
 */

import { Mode, WallState } from "../cpstate.js";
import type { Compositor } from "./compositor.js";
import type { HouseViewer, WallDrawer } from "./houseviewer.js";
import type { ResFile } from "./iffres.js";
import type { Renderer } from "./renderer.js";
import type { RenderParam } from "./renderparam.js";
import {
  analyzeWallVertex,
  dirToWallSeg,
  getAdjacentTile,
  getOppositeSegment,
  getWall,
  patternIndex,
  rotateConfig,
  SEG_BL,
  SEG_BR,
  SEG_HORIZ,
  SEG_ROTATION,
  SEG_TL,
  SEG_TR,
  SEG_VERT,
  segIndex,
  VERTEX_END,
  VERTEX_JOINT,
} from "./tilewalls.js";
import { WallGraphicsMgr } from "./wallgraphics.js";
import type { IconicWallBlitter } from "./wallicon.js";
import { WallBlitter, type ClipRect } from "./wallrender.js";
import { LEVEL_PX } from "./zbuffer.js";
import { ARRAY_SIZE, DIRS, rotateTile, type FixedWorld, type RotatableWorld } from "./world.js";

/** CTilePt (x, y, level). */
interface Pt {
  x: number;
  y: number;
  level: number;
}

/** WallSegment: 6 bytes in the original. */
export interface WallSegment {
  flags: number;
  style: number;
  /** Pattern per side; Wall.side selects the one drawn. */
  pattern: [number, number];
}

/** Style tests used throughout Wall / Vertex. */
const isFence = (s: number): boolean => s === 2 || s === 0xc || s === 0xd || s === 0xe;
const isUncuttable = (s: number): boolean => s === 0xff || isFence(s);
const isTwoPass = (s: number): boolean => s === 3 || s === 5 || s === 6 || s === 0xf || s === 0x17;

/** lbl_105BAB34: thick wall piece frame (+1) for a mask of half-walls around a vertex. */
const PIECE = (() => {
  const t = new Uint8Array(256).fill(0xff);
  const m: ReadonlyArray<readonly [number, number]> = [
    [20, 17], [24, 18], [28, 19], [32, 20], [33, 21], [40, 22], [41, 23], [48, 24], [56, 25], [64, 26], [65, 27], [66, 28], [67, 29],
    [80, 30], [96, 31], [97, 32], [112, 33], [128, 34], [130, 35], [132, 36], [134, 37], [144, 38], [148, 39], [160, 40], [176, 41],
    [192, 42], [194, 43], [208, 44], [224, 45], [240, 46],
  ];
  for (let i = 0; i <= 16; i++) t[i] = i;
  for (const [k, v] of m) t[k] = v;
  return t;
})();

/** ZBufferLookup+0x78: height of a cut wall in pixels by scale. */
const CUT_PX: Readonly<Record<number, number>> = { 3: 0x17, 2: 0xc, 1: 6 };

/** CTilePt::BuildRotationLookup table (lbl_105BA07C): -1 outside the 64x64 grid. */
function rotTab(x: number, y: number, rot: number): [number, number] {
  if (rot === 0) return [x, y];
  if (x < 0 || y < 0 || x >= ARRAY_SIZE || y >= ARRAY_SIZE) return [-1, -1];
  return rotateTile(x, y, rot);
}

/** Offset added after rotating a vertex (grid point) like a tile: DIRS[3], DIRS[5], DIRS[1]. */
const VERTEX_ROT_OFFSET: ReadonlyArray<readonly [number, number]> = [[0, 0], DIRS[3]!, DIRS[5]!, DIRS[1]!];

/** Wall::VertexToTile: the tile holding the segment that leaves vertex v in direction dir. */
function vertexToTile(v: Pt, dir: number): Pt {
  const d = dir === 0 ? [0, -1] : dir === 2 ? [-1, 0] : dir === 4 ? [-1, -1] : dir === 6 ? [0, -1] : dir === 7 ? [-1, 0] : [0, 0];
  return { x: v.x + d[0]!, y: v.y + d[1]!, level: v.level };
}

/** Wall::TileToVertex (inverse of VertexToTile). */
function tileToVertex(t: Pt, dir: number): Pt {
  let d: readonly [number, number] = [0, 0];
  if (dir === 0 || dir === 2 || dir === 4) d = DIRS[dir]!;
  else if (dir === 6) d = DIRS[0]!;
  else if (dir === 7) d = DIRS[2]!;
  return { x: t.x - d[0], y: t.y - d[1], level: t.level };
}

/** Wall::ComputeDirection. */
function computeDirection(a: Pt, b: Pt): number {
  if (a.x === b.x && a.y === b.y && a.level === b.level) return 8;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const i3 = Math.abs(dx);
  const i4 = Math.abs(dy);
  const i5 = Math.trunc(Math.abs(dx - dy) / 2);
  const i6 = Math.trunc(Math.abs(dx + dy) / 2);
  if (i3 < i4 && i3 <= i5 && i3 <= i6) return dy < 0 ? 0 : 1;
  if (i4 < i3 && i4 <= i5 && i4 <= i6) return dx < 0 ? 2 : 3;
  if (i5 < i3 && i5 < i4 && i5 < i6) return b.x + b.y < a.x + a.y ? 4 : 5;
  return b.x - b.y < a.x - a.y ? 7 : 6;
}

/** IsoCompare (VertexPtr / WallPtr): screen row (x + y), then x - y. */
function isoLess(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  const sa = a.x + a.y;
  const sb = b.x + b.y;
  return sa === sb ? a.x - a.y < b.x - b.y : sa < sb;
}

function isoCompare(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return isoLess(a, b) ? -1 : isoLess(b, a) ? 1 : 0;
}

/** HouseViewer::GetWallBounds: a wall sprite's rectangle relative to its tile's top corner. */
function getWallBounds(viewer: HouseViewer, seg: number, s: number): ClipRect {
  return wallBounds(viewer.levelPx(s), seg, s);
}

/** GetWallBounds for a level height `lp` (ZBufferLookup +0x6c, LEVEL_PX). */
function wallBounds(lp: number, seg: number, s: number): ClipRect {
  let r: ClipRect;
  if (seg === SEG_HORIZ) r = { left: -1 - (8 << s), right: (8 << s) - 1, top: (4 << s) - lp, bottom: 4 << s };
  else if (seg === SEG_TR) r = { left: -1, right: (8 << s) - 1, top: -lp, bottom: 8 << s };
  else if (seg === SEG_TL) r = { left: -1 - (8 << s), right: -1, top: 1 - lp, bottom: (8 << s) + 1 };
  else if (seg === SEG_VERT) r = { left: -(8 >> (3 - s)), right: 8 >> (3 - s), top: -lp, bottom: 8 << s };
  else r = { left: 0, right: 0, top: 0, bottom: 0 };
  r.top -= 1 << s;
  return r;
}

function offsetRect(r: ClipRect, dx: number, dy: number): void {
  r.left += dx;
  r.right += dx;
  r.top += dy;
  r.bottom += dy;
}

/** Frame of a wall sprite list for a segment (1, 2, 0x10, 0x20 -> 0..3), -1 otherwise. */
function segFrame(seg: number): number {
  return seg === SEG_TL ? 0 : seg === SEG_TR ? 1 : seg === SEG_HORIZ ? 2 : seg === SEG_VERT ? 3 : -1;
}

/** Door / window wall sprite: GetCustomWallStyleID for a world tile and world segment. */
export type CustomWallStyleFn = (x: number, y: number, level: number, seg: number) => { renderer: Renderer; id: number } | null;

/** State shared by one DrawWalls call. */
interface DrawCtx {
  viewer: HouseViewer;
  world: RotatableWorld;
  rp: RenderParam;
  blit: WallBlitter;
  gfx: WallGraphicsMgr;
  /** lbl_105BA5F4 (narrowed and restored around some draws). */
  clip: ClipRect;
  mgr: WallManager;
}

/** State shared by one WallManager::DrawIconic call (RenderParam state (3, 1): pixel positions from the iconic fields, no world). */
interface IconicCtx {
  blit: IconicWallBlitter;
  gfx: WallGraphicsMgr;
  /** lbl_105BA5F4, set to (-800, -600, 800, 600) by DrawIconic. */
  clip: ClipRect;
}

/** Iconic fields of a Wall (+0x48 flag, +0x4c / +0x50 pixel position, +0x54 scale) or Vertex (+0x50, +0x58 / +0x5c, +0x54). */
interface Iconic {
  x: number;
  y: number;
  scale: number;
}

/** Vertex::SetIconic jump tables (lbl_105BC684 first vertex, lbl_105BC680 last) by wall direction: [wall slot, configuration bit]. */
const ICONIC_FIRST: ReadonlyArray<readonly [number, number]> = [[0, 0x01], [2, 0x04], [1, 0x02], [3, 0x08], [0, 0x10], [2, 0x40], [3, 0x80], [1, 0x20]];
const ICONIC_LAST: ReadonlyArray<readonly [number, number]> = [[2, 0x04], [0, 0x01], [3, 0x08], [1, 0x02], [2, 0x40], [0, 0x10], [1, 0x20], [3, 0x80]];

/** Wall::BuildIconic jump table lbl_105BC6A0 by direction: [side, bit at v0, bit at v1]. */
const BUILD_ICONIC: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0x01, 0x04],
  [1, 0x04, 0x01],
  [1, 0x02, 0x08],
  [0, 0x08, 0x02],
  [0, 0x10, 0x40],
  [0, 0x40, 0x10],
  [0, 0x80, 0x20],
  [1, 0x20, 0x80],
];

/** World fixed-point center of a view tile. */
function centerOfView(world: RotatableWorld, x: number, y: number): [number, number] {
  const [wx, wy] = rotTab(x, y, (4 - world.rotation) & 3);
  return [(wx << 4) | 8, (wy << 4) | 8];
}

/** VertexEndcap (0x14 bytes): where to draw a wall's end face. */
interface Endcap {
  /** +0: tile offset from the vertex. */
  dx: number;
  dy: number;
  /** +4: clip width in units of 1 << (scale - 1). */
  width: number;
  /** +8: wall slot. */
  slot: number;
  /** +0xc: segment drawn. */
  seg: number;
  /** +0x10: clip to the right of the vertex (else to the left). */
  right: boolean;
}

/** Vertex::PrecomputeEndcapState. */
function precomputeEndcapState(cfgIn: number, b: number, c: number): Endcap | null {
  if (cfgIn === 0) return null;
  let cfg = cfgIn & ~b;
  if (cfg === 0) return null;
  cfg |= c;
  const n = DIRS[0]!;
  const w = DIRS[2]!;
  const e = (d: readonly [number, number], width: number, slot: number, right: boolean, seg: number): Endcap => ({ dx: d[0], dy: d[1], width, slot, seg, right });
  switch (cfg) {
    case 9:
      return e(w, 3, 3, false, SEG_TR);
    case 0x30:
      return e(n, 2, 1, true, SEG_HORIZ);
    case 0x90:
      return e(w, 2, 3, false, SEG_HORIZ);
    case 0x18:
      return e(w, 2, 3, false, SEG_TR);
    case 0x14:
      return e(n, 2, 2, true, SEG_TL);
    case 4:
      return e(n, 3, 2, true, SEG_TL);
    case 6:
      return e(n, 3, 2, true, SEG_TL);
    case 8:
      return e(w, 3, 3, false, SEG_TR);
    case 2:
      return e(n, 3, 1, true, SEG_TL);
    case 1:
      return e(w, 3, 0, false, SEG_TR);
    default:
      return null;
  }
}

export class Vertex {
  /** +4: rotation the coordinates are in. */
  rot = 0;
  /** +8: configuration (rotated with the vertex). */
  config = 0;
  /** +9: half-walls drawn as cut tops. */
  cut = 0;
  /** +0xa: half-walls drawn as full-height tops. */
  full = 0;
  /** +0xb / +0xc: half-walls without a top / with an end piece instead. */
  b = 0;
  c = 0;
  /** +0x10..+0x1c: walls by quadrant (view): 0 toward -y / (-1,-1), 1 -x / (-1,+1), 2 +y / (+1,+1), 3 +x / (+1,-1). */
  walls: [Wall | null, Wall | null, Wall | null, Wall | null] = [null, null, null, null];
  /** +0x24/+0x28 and +0x25/+0x3c. */
  endcaps: [Endcap | null, Endcap | null] = [null, null];
  /** +0x50 / +0x54 / +0x58 / +0x5c: drawn at a pixel position (WallManager::DrawIconic) instead of its tile. */
  iconic: Iconic | null = null;

  constructor(public x: number, public y: number, readonly level: number) {}

  /** Vertex::AddWallEnterVertex. */
  addWallEnterVertex(wall: Wall, dir: number): void {
    if (dir === 1 || dir === 5) this.walls[0] = wall;
    else if (dir === 3 || dir === 6) this.walls[1] = wall;
  }

  /** Vertex::BuildWalls. */
  buildWalls(mgr: WallManager): void {
    if (this.config & (0x04 | 0x40)) {
      const w = new Wall();
      this.walls[2] = w;
      w.buildFromVertex(mgr, this, this.config & 0x04 ? 1 : 5);
      mgr.addWall(w, this.level);
    }
    if (this.config & (0x08 | 0x80)) {
      const w = new Wall();
      this.walls[3] = w;
      w.buildFromVertex(mgr, this, this.config & 0x08 ? 3 : 6);
      mgr.addWall(w, this.level);
    }
  }

  /** The segment of `wall` that touches this vertex. */
  private segAt(wall: Wall): WallSegment {
    return wall.start === this ? wall.segs[0]! : wall.segs[wall.segs.length - 1]!;
  }

  /** Wall::GetMyConfigContribution. */
  private contribution(wall: Wall): number {
    return wall.start === this ? wall.c0 : wall.c1;
  }

  /** Vertex::ComputeCutaway (first pass). */
  computeCutaway(): void {
    this.cut = 0;
    this.full = this.config;
    this.b = 0;
    this.c = 0;
    const cut = [0, 0, 0, 0];
    const cuttable = [false, false, false, false];
    for (let k = 0; k < 4; k++) {
      const w = this.walls[k];
      if (!w) continue;
      const s = this.segAt(w);
      cut[k] = s.flags & 1;
      cuttable[k] = !isUncuttable(s.style);
    }
    for (let k = 0; k < 4; k++) {
      if (!cut[k]) continue;
      const w = this.walls[k]!;
      const contrib = this.contribution(w);
      let alone = true;
      for (let j = 1; j < 4; j++) {
        const o = (k + j) & 3;
        if (this.walls[o] !== null && !cut[o] && cuttable[o]) alone = false;
      }
      if (alone) {
        if (this.full & contrib) {
          this.cut |= contrib;
          this.full &= ~contrib;
        }
        continue;
      }
      const s = this.segAt(w);
      const f = s.flags;
      if ((f & 6) !== 0) continue;
      if (k !== 0 && k !== 3) {
        if ((f & 1) === 0) {
          if ((f & 4) === 0) s.flags |= 2;
        } else if ((f & 2) === 0) s.flags |= 4;
      } else if ((f & 1) === 0) {
        if ((f & 2) === 0) s.flags |= 4;
      } else if ((f & 4) === 0) s.flags |= 2;
    }
  }

  /** Vertex::ComputeCutawaySecondPass. */
  computeCutawaySecondPass(): void {
    for (const w of this.walls) {
      if (!w) continue;
      const s = this.segAt(w);
      const contrib = this.contribution(w);
      const f = s.flags;
      if ((f & 6) === 0) {
        if (isFence(s.style)) this.b |= contrib;
      } else {
        const d = w.dir;
        if (d >= 0 && d <= 3) this.c |= contrib;
        else if (d === 7) {
          if (f & 4) this.c |= contrib;
          else this.b |= contrib;
        } else if (d === 6) {
          if (f & 2) this.c |= contrib;
          else this.b |= contrib;
        }
      }
      if (s.flags & 1 && isTwoPass(s.style)) this.b |= contrib;
    }
    this.endcaps[0] = precomputeEndcapState(this.full, this.b, this.c);
    this.endcaps[1] = precomputeEndcapState(this.cut, this.b, 0);
  }

  /** Vertex::SetRotation. */
  setRotation(rot: number): void {
    const d = (4 - this.rot + rot) & 3;
    if (d !== 0) {
      [this.x, this.y] = rotTab(this.x, this.y, d);
      const o = VERTEX_ROT_OFFSET[d]!;
      this.x += o[0];
      this.y += o[1];
      this.config = rotateConfig(this.config, d);
      this.cut = rotateConfig(this.cut, d);
      this.full = rotateConfig(this.full, d);
      this.b = rotateConfig(this.b, d);
      this.c = rotateConfig(this.c, d);
      const w = this.walls;
      this.walls = [w[d & 3]!, w[(d + 1) & 3]!, w[(d + 2) & 3]!, w[(d + 3) & 3]!];
    }
    this.endcaps[0] = precomputeEndcapState(this.full, this.b, this.c);
    this.endcaps[1] = precomputeEndcapState(this.cut, this.b, this.c);
    this.rot = rot;
  }

  /**
   * Vertex::SetIconic: the vertex of an iconic wall, drawn at pixel (x, y)
   * (its top corner) at `scale`: its configuration is the wall's bit only
   * (jump tables by the wall's direction), a full-height top unless the wall
   * is a fence.
   */
  setIconic(x: number, y: number, scale: number, wall: Wall, first: boolean): void {
    this.iconic = { x, y, scale };
    this.config = 0;
    this.cut = 0;
    this.full = 0;
    this.b = 0;
    this.c = 0;
    this.walls[2] = null;
    this.walls[3] = null;
    const e = (first ? ICONIC_FIRST : ICONIC_LAST)[wall.dir];
    if (e) {
      this.walls[e[0]] = wall;
      this.config |= e[1];
    }
    if (isFence(this.segAt(wall).style)) this.b = this.config;
    else this.full = this.config;
    this.endcaps[0] = precomputeEndcapState(this.full, this.b, this.c);
    this.endcaps[1] = precomputeEndcapState(this.cut, this.b, this.c);
  }

  /**
   * Vertex::Draw in iconic mode (+0x50): the top corner is the iconic pixel
   * position, the altitude 0, and the end cap's neighbor tile is placed at
   * (8 << s) * (dx - dy), (4 << s) * (dx + dy) from it. SetIconic leaves no
   * cut half-walls, so only the full-height top piece and the end cap can
   * be drawn.
   */
  drawIconic(ctx: IconicCtx): void {
    const { blit, gfx, clip } = ctx;
    const { x: th, y: tv, scale: s } = this.iconic!;
    const u = 8 << s;
    const h4 = 4 << s;
    const lp = LEVEL_PX[s]!;
    if (this.full !== 0) {
      const m = this.full & ~this.b & ~this.c;
      if (m !== 0) blit.drawThickWallPiece(clip, 0xfff + s, PIECE[m]! - 1, th - u - 1, tv - h4 - lp);
    }
    const ec = this.endcaps[0] ?? this.endcaps[1];
    if (!ec) return;
    const wall = this.walls[ec.slot];
    if (!wall) return;
    const seg = this.segAt(wall);
    // The iconic segment has no cut flags: the cut style is the cut end cap's.
    const cutStyle = this.endcaps[1] ? 1 : 0;
    const saved = { ...clip };
    const w = ec.width << (s - 1);
    clip.left = Math.max(clip.left, ec.right ? th - 1 : th - w);
    clip.right = Math.min(clip.right, ec.right ? th + w - 1 : th);
    const r = wallBounds(lp, ec.seg, s);
    offsetRect(r, th + u * (ec.dx - ec.dy), tv + h4 * (ec.dx + ec.dy));
    const g = gfx.getWallPatternGraphic(seg.pattern[wall.side]!, s) ?? { renderer: null, id: (s - 1) * 0x100 + 0x6ff };
    const st = seg.style === 0xff ? 0xff : 1;
    blit.drawWall(clip, null, st * 2 + (s - 1) * 0x200 + cutStyle, g.renderer, g.id, segFrame(ec.seg), r.left, r.top);
    Object.assign(clip, saved);
  }

  /** Vertex::Draw: wall tops (thick pieces) and the end cap. */
  draw(ctx: DrawCtx): void {
    const { viewer, world, rp, blit, clip } = ctx;
    const s = viewer.scale;
    const u = 8 << s;
    const h4 = 4 << s;
    const alt = world.getPackedAlt(this.x, this.y)[1];
    const top = viewer.tileToPoint(this.x, this.y, this.level, s, 0);
    rp.setGridCoords(...centerOfView(world, this.x, this.y), this.level, -1);
    const tile = { x: this.x, y: this.y };
    if (this.cut !== 0 || this.full !== 0) {
      const x19 = top.h - u - 1;
      const y20 = top.v - h4 - (alt << (s + 1));
      const cutH = CUT_PX[s]!;
      if (this.cut !== 0) {
        const m = this.cut & ~this.b & ~this.c;
        if (m !== 0) {
          const frame = PIECE[m]! - 1;
          if (m & 0x10 || m & 0x40) {
            let extra = 900;
            const yoff = m === 0x10 ? (s === 3 ? -5 : s === 2 ? -2 : 0) : 0;
            if (m & 0x40) extra = this.level === 2 ? 700 : 770;
            blit.drawThickWallPiece(viewer, rp, clip, tile, 0xfff + s, frame, x19, yoff + y20 - cutH, extra);
            if (m & 0x10) {
              if (m & 8) {
                const saved = { ...clip };
                clip.left = Math.max(clip.left, x19 + u + (8 >> (3 - s)));
                blit.drawThickWallCutawayPiece(viewer, rp, clip, 0x13ff + s, 0x17ff + s, frame, x19, y20 - cutH);
                Object.assign(clip, saved);
              }
              if (m & 4) {
                const saved = { ...clip };
                clip.right = Math.min(clip.right, x19 + u - (8 >> (3 - s)));
                blit.drawThickWallCutawayPiece(viewer, rp, clip, 0x13ff + s, 0x17ff + s, frame, x19, y20 - cutH);
                Object.assign(clip, saved);
              }
            }
          } else {
            blit.drawThickWallCutawayPiece(viewer, rp, clip, 0x13ff + s, 0x17ff + s, frame, x19, y20 - cutH);
          }
        }
      }
      if (this.full !== 0) {
        const m = this.full & ~this.b & ~this.c;
        if (m !== 0) {
          const extra = m & 0x40 && this.level === 2 ? -100 : 0;
          blit.drawThickWallPiece(viewer, rp, clip, tile, 0xfff + s, PIECE[m]! - 1, x19, y20 - viewer.levelPx(s), extra);
        }
      }
    }
    const ec = this.endcaps[0] ?? this.endcaps[1];
    if (!ec) return;
    const wall = this.walls[ec.slot];
    if (!wall) return;
    const seg = this.segAt(wall);
    const pattern = seg.pattern[wall.side]!;
    let cutStyle = this.endcaps[1] ? 1 : 0;
    if (seg.flags & 1 && seg.flags & 6) {
      if (ec.slot === 0 || ec.slot === 3) cutStyle = (seg.flags >> 2) & 1;
      else if (ec.slot === 1 || ec.slot === 2) cutStyle = (seg.flags >> 1) & 1;
    }
    const saved = { ...clip };
    const w = ec.width << (s - 1);
    const lo = ec.right ? top.h - 1 : top.h - w;
    const hi = ec.right ? top.h + w - 1 : top.h;
    clip.left = Math.max(clip.left, lo);
    clip.right = Math.min(clip.right, hi);
    const r = getWallBounds(viewer, ec.seg, s);
    const nx = this.x + ec.dx;
    const ny = this.y + ec.dy;
    const ntop = viewer.tileToPoint(nx, ny, this.level, s, 0);
    const colOff = ec.seg === SEG_TR ? u : 0;
    offsetRect(r, ntop.h, ntop.v - (alt << (s + 1)));
    const g = ctx.gfx.getWallPatternGraphic(pattern, s) ?? { renderer: null, id: (s - 1) * 0x100 + 0x6ff };
    const st = seg.style === 0xff ? 0xff : 1;
    const styleId = st * 2 + (s - 1) * 0x200 + (cutStyle ? 1 : 0);
    rp.setGridCoords(...centerOfView(world, nx, ny), this.level, alt);
    blit.drawWall(viewer, rp, clip, null, styleId, g.renderer, g.id, segFrame(ec.seg), r.left, r.top, colOff, ec.seg);
    Object.assign(clip, saved);
  }
}

const NO_SEGMENT: WallSegment = { flags: 0, style: 0, pattern: [0, 0] };

export class Wall {
  /** +4 / +7: first and last vertex position. */
  v0: Pt = { x: -1, y: -1, level: 0 };
  v1: Pt = { x: -1, y: -1, level: 0 };
  /** +0x10: direction (index into DIRS) from v0 to v1. */
  dir = 8;
  /** +0xa / +0xb: DIRS[dir]. */
  dx = -1;
  dy = -1;
  /** +0x14: rotation the coordinates are in. */
  rot = -1;
  /** +0x18: which pattern of the segments faces the camera. */
  side = -1;
  /** +0x1c / +0x1d: configuration bit this wall adds at v0 / v1. */
  c0 = 0;
  c1 = 0;
  /** +0x20 / +0x24. */
  start: Vertex | null = null;
  end: Vertex | null = null;
  /** +0x30. */
  segs: WallSegment[] = [];
  /** +0x48 / +0x4c / +0x50 / +0x54: drawn at a pixel position (WallManager::DrawIconic) instead of its tiles. */
  iconic: Iconic | null = null;

  /** Wall::BuildIconic: a one-segment wall (style 1, pattern 0) from v0 to v1. */
  buildIconic(v0: Vertex, v1: Vertex): void {
    this.v0 = { x: v0.x, y: v0.y, level: v0.level };
    this.v1 = { x: v1.x, y: v1.y, level: v1.level };
    this.dir = computeDirection(this.v0, this.v1);
    [this.dx, this.dy] = DIRS[this.dir] ?? [-1, -1];
    this.start = v0;
    this.end = v1;
    this.rot = 0;
    const e = BUILD_ICONIC[this.dir];
    if (e) {
      this.side = e[0];
      this.c0 |= e[1];
      this.c1 |= e[2];
    }
    this.segs.push({ flags: 0, style: 1, pattern: [0, 0] });
  }

  /** Wall::SetWallStyle */
  setWallStyle(style: number): void {
    for (const s of this.segs) s.style = style;
  }

  /** Wall::SetWallPattern: both sides. */
  setWallPattern(pattern: number): void {
    for (const s of this.segs) s.pattern = [pattern, pattern];
  }

  /**
   * Wall::SetIconic: the wall's first tile top corner at pixel (x, y), and
   * its vertices placed from it (direction 6: one tile to the left and to
   * the right, half a tile down).
   */
  setIconic(x: number, y: number, scale: number): void {
    this.iconic = { x, y, scale };
    const t0 = vertexToTile(this.v0, this.dir);
    const t1 = vertexToTile(this.v1, this.dir);
    const dx = t1.x - t0.x;
    const dy = t1.y - t0.y;
    const u = 8 << scale;
    const h4 = 4 << scale;
    if (this.dir === 6) {
      this.start!.setIconic(x - u, y + h4, scale, this, true);
      this.end!.setIconic(x + u, y + h4, scale, this, false);
    } else {
      this.start!.setIconic(x, y, scale, this, true);
      this.end!.setIconic(x + u * (dx + dy), y + h4 * (dx - dy), scale, this, false);
    }
  }

  /**
   * Wall::Draw in iconic mode (+0x48): every segment's top corner is the
   * iconic pixel position at altitude 0, at full ambient (lbl_105BC690),
   * without light entry. BuildIconic's segment is never cut (flags 0) and
   * the first segment has no joint, so each segment is one WallBlit of its
   * style over its pattern. (Styles 0x16 / 0x17 would need a door / window
   * object's sprite; no iconic caller uses them.)
   */
  drawIconic(ctx: IconicCtx): void {
    const { blit, gfx, clip } = ctx;
    const { x, y, scale: s } = this.iconic!;
    const u = 8 << s;
    const seg = dirToWallSeg(this.dir);
    const frame = segFrame(seg);
    if (frame < 0) return;
    for (const cur of this.segs) {
      const r = wallBounds(LEVEL_PX[s]!, seg, s);
      if (seg === SEG_VERT) offsetRect(r, x - 1, y + u + (4 >> (3 - s)));
      else offsetRect(r, x, y);
      const g = gfx.getWallPatternGraphic(cur.pattern[this.side]!, s);
      if (!g) continue;
      blit.drawWall(clip, null, cur.style * 2 + (s - 1) * 0x200, g.renderer, g.id, frame, r.left, r.top);
    }
  }

  /** Wall::BuildFromVertex (world coordinates, rotation 0). */
  buildFromVertex(mgr: WallManager, v: Vertex, dir: number): void {
    const fixed = mgr.fixed;
    this.start = v;
    this.v0 = { x: v.x, y: v.y, level: v.level };
    this.dir = dir;
    [this.dx, this.dy] = DIRS[dir]!;
    this.rot = 0;
    this.c0 = 0;
    this.c1 = 0;
    // Jump table lbl_105BC69C.
    let r19 = 0;
    let r20 = 0;
    if (dir === 1) {
      this.side = 1;
      this.c0 |= 0x04;
      this.c1 |= 0x01;
    } else if (dir === 3) {
      this.side = 0;
      this.c0 |= 0x08;
      this.c1 |= 0x02;
    } else if (dir === 5) {
      this.side = 0;
      r19 = 1;
      r20 = 3;
      this.c0 |= 0x40;
      this.c1 |= 0x10;
    } else if (dir === 6) {
      this.side = 0;
      r19 = 4;
      r20 = 2;
      this.c0 |= 0x80;
      this.c1 |= 0x20;
    }
    const tile = vertexToTile(this.v0, dir);
    const seg = dirToWallSeg(dir);
    const [ax, ay] = getAdjacentTile(seg, tile.x, tile.y);
    const adx = ax - tile.x;
    const ady = ay - tile.y;
    const opp = getOppositeSegment(seg);
    const vp = { ...this.v0 };
    let cfg = 0;
    do {
      const tw = getWall(fixed, tile.x, tile.y, tile.level);
      const tw2 = adx === 0 && ady === 0 ? tw : getWall(fixed, tile.x + adx, tile.y + ady, tile.level);
      const pattern: [number, number] = [0, 0];
      pattern[this.side] = tw.patterns[patternIndex(seg, r19)]!;
      pattern[1 - this.side] = tw2.patterns[patternIndex(opp, r20)]!;
      this.segs.push({ flags: 0, style: tw.styles[segIndex(seg)]! & 0xff, pattern });
      tile.x += this.dx;
      tile.y += this.dy;
      vp.x += this.dx;
      vp.y += this.dy;
      cfg = mgr.vertexConfig(vp.x, vp.y, vp.level);
    } while (cfg !== 0 && !VERTEX_JOINT[cfg] && !VERTEX_END[cfg]);
    this.v1 = tileToVertex(tile, dir);
    this.end = mgr.getVertex(this.v1);
    this.end?.addWallEnterVertex(this, dir);
  }

  /** Wall::SetRotation. */
  setRotation(rot: number): void {
    const d = (4 - this.rot + rot) & 3;
    if (d === 0) return;
    [this.v0.x, this.v0.y] = rotTab(this.v0.x, this.v0.y, d);
    [this.v1.x, this.v1.y] = rotTab(this.v1.x, this.v1.y, d);
    const o = VERTEX_ROT_OFFSET[d]!;
    this.v0.x += o[0];
    this.v0.y += o[1];
    this.v1.x += o[0];
    this.v1.y += o[1];
    this.c0 = rotateConfig(this.c0, d);
    this.c1 = rotateConfig(this.c1, d);
    if (isoLess(this.v1, this.v0)) {
      [this.v0, this.v1] = [this.v1, this.v0];
      [this.start, this.end] = [this.end, this.start];
      [this.c0, this.c1] = [this.c1, this.c0];
      this.segs.reverse();
      for (const sg of this.segs) sg.pattern = [sg.pattern[1], sg.pattern[0]];
    }
    this.dir = computeDirection(this.v0, this.v1);
    [this.dx, this.dy] = DIRS[this.dir] ?? [-1, -1];
    const dd = this.dir;
    if (dd === 0 || dd === 3 || dd === 4 || dd === 5 || dd === 6) this.side = 0;
    else if (dd === 1 || dd === 2 || dd === 7) this.side = 1;
    this.rot = rot;
  }

  /** Wall::SetCutaway. */
  setCutaway(cut: boolean): void {
    for (const s of this.segs) {
      s.flags = 0;
      if (cut && !isUncuttable(s.style)) s.flags |= 1;
      if (cut && (isTwoPass(s.style) || s.style === 0x16)) s.flags |= 8;
    }
  }

  /** Wall::ComputeCutaway: cut the segments whose tiles are in `mask` (view x, y). */
  computeCutaway(mask: CutawayMask): void {
    const seg = dirToWallSeg(this.dir);
    const p = { ...this.v0 };
    for (const s of this.segs) {
      s.flags = 0;
      if (mask.has(p.x, p.y) && !isUncuttable(s.style)) {
        s.flags |= 1;
        // Diagonals (102b4fb0): the tile + lbl_105BA078[3] or + [0] for 0x10,
        // + 2 x [0] and + 2 x [3] for 0x20.
        if (seg === SEG_HORIZ) {
          const t = vertexToTile(p, this.dir);
          if (!mask.has(t.x + DIRS[3]![0], t.y + DIRS[3]![1]) && !mask.has(t.x + DIRS[0]![0], t.y + DIRS[0]![1])) s.flags &= ~1;
        } else if (seg === SEG_VERT) {
          const t = vertexToTile(p, this.dir);
          const keep = mask.has(t.x + 2 * DIRS[0]![0], t.y + 2 * DIRS[0]![1]) && mask.has(t.x + 2 * DIRS[3]![0], t.y + 2 * DIRS[3]![1]);
          if (!keep) s.flags &= ~1;
        } else {
          const [ax, ay] = getAdjacentTile(seg, p.x, p.y);
          if (!mask.has(ax, ay)) s.flags &= ~1;
        }
      }
      if (s.flags & 1 && (isTwoPass(s.style) || s.style === 0x16)) s.flags |= 8;
      p.x += this.dx;
      p.y += this.dy;
    }
    const [bit7, bit5] = this.dir === 3 || this.dir === 6 ? [4, 2] : [2, 4];
    for (let i = 0; i + 1 < this.segs.length; i++) {
      const cur = this.segs[i]!;
      const next = this.segs[i + 1]!;
      if ((cur.flags & 1) === (next.flags & 1)) continue;
      if ((cur.flags & 1) === 0) {
        if (!isUncuttable(cur.style)) next.flags |= bit5;
      } else if (!isUncuttable(next.style)) cur.flags |= bit7;
    }
  }

  /** GETCUSTOMSTYLE: style sprite id (and renderer for door / window walls). */
  private customStyle(ctx: DrawCtx, style: number, tile: Pt, seg: number, cut: number): { renderer: Renderer | null; id: number } {
    const s = ctx.viewer.scale;
    if (style === 0x16 || style === 0x17) {
      const rot = ctx.world.rotation;
      const [wx, wy] = rotTab(tile.x, tile.y, (4 - rot) & 3);
      const wseg = rot !== 0 ? SEG_ROTATION[(4 - rot) & 3]![seg]! : seg;
      const c = ctx.mgr.customWallStyle?.(wx, wy, tile.level, wseg) ?? null;
      if (!c) return { renderer: null, id: (s - 1) * 0x200 + (cut ? 1 : 0) + 2 };
      return { renderer: c.renderer, id: cut * 3 + s + c.id - 1 };
    }
    return { renderer: null, id: style * 2 + (s - 1) * 0x200 + (cut ? 1 : 0) };
  }

  /** Wall::Draw. */
  draw(ctx: DrawCtx): void {
    const { viewer, world, rp, blit, gfx, clip, mgr } = ctx;
    const s = viewer.scale;
    const u = 8 << s;
    const r26 = 3 << (s - 1);
    const r29 = 0x5c >> (3 - s);
    const seg = dirToWallSeg(this.dir);
    const buildTool = mgr.mode === Mode.Build && mgr.wallToolActive;
    const tile = vertexToTile(this.v0, this.dir);
    const vp = { ...this.v0 };
    const n = this.segs.length;
    for (let i = 0; i < n; i++, tile.x += this.dx, tile.y += this.dy, vp.x += this.dx, vp.y += this.dy) {
      const cur = this.segs[i]!;
      const prev = i === 0 ? NO_SEGMENT : this.segs[i - 1]!;
      const next = i + 1 < n ? this.segs[i + 1]! : null;
      const top = viewer.tileToPoint(tile.x, tile.y, tile.level, s, 0);
      const alt = world.getPackedAlt(tile.x, tile.y);
      // 0x1f4: altitude the sprite stands on; 0x1f5: altitude of the joint piece.
      let altMin = alt[1];
      let altJoint = alt[1];
      if (this.dir === 1) altMin = Math.min(alt[0], alt[1]);
      else if (this.dir === 3) altMin = Math.min(alt[2], alt[1]);
      else if (this.dir === 5) altMin = Math.min(alt[3], alt[1]);
      else if (this.dir === 6) {
        altMin = Math.min(alt[2], alt[0]);
        altJoint = alt[0];
      }
      let cut = !isUncuttable(cur.style) ? cur.flags & 1 : !isUncuttable(prev.style) ? prev.flags & 1 : 0;
      const prevNF = !isFence(prev.style);
      const curNF = !isFence(cur.style);
      const nextCut = next ? next.flags & 1 : 1;
      const nextNF = next ? !isFence(next.style) : true;
      const trim = next !== null && !curNF && nextNF && !nextCut;
      if (!(vp.x === this.v0.x && vp.y === this.v0.y && vp.level === this.v0.level)) {
        this.drawJoint(ctx, cur, prev, seg, tile, vp, top, alt[1], altJoint, cut, prevNF, curNF);
      }
      // The segment itself.
      if (seg === SEG_VERT && next && !cut && !nextCut && curNF && nextNF) continue;
      const frame = segFrame(seg);
      if (frame < 0) continue;
      const r = getWallBounds(viewer, seg, s);
      const colOff = seg === SEG_TR ? u : 0;
      if (seg === SEG_VERT) offsetRect(r, top.h - 1, top.v - (altMin << (s + 1)) + u + (4 >> (3 - s)));
      else offsetRect(r, top.h, top.v - (altMin << (s + 1)));
      rp.setGridCoords(...centerOfView(world, tile.x, tile.y), this.v0.level, alt[1]);
      // Room::GetAmbientLight of the room the visible face belongs to (approximated by the segment's tile).
      viewer.comp.ambient = viewer.ambientAtTile(tile.x, tile.y, this.v0.level);
      let passes = cur.flags & 8 || cur.flags & 6 ? 2 : 1;
      if (isUncuttable(cur.style)) cut = 0;
      if (cut && isTwoPass(cur.style) && buildTool) passes = 0;
      if (passes === 2 && cut && mgr.mode !== Mode.Build) {
        if (cur.style === 0x16 && (cur.flags & 6) === 0) passes = 1;
        else if (isTwoPass(cur.style)) passes = 0;
      }
      let endPiece = false;
      let r22 = 1;
      for (let pass = 0; pass < passes; pass++) {
        let styleR: Renderer | null = null;
        let patR: Renderer | null = null;
        let styleId: number;
        let patId: number;
        if (pass === 0) {
          endPiece = (cur.flags & 6) !== 0 && !isTwoPass(cur.style);
          if (endPiece) r22 = cur.flags & 2 ? 8 : 7;
          const g = gfx.getWallPatternGraphic(cur.pattern[this.side]!, s);
          if (!g) continue;
          patR = g.renderer;
          patId = g.id;
          if (endPiece) styleId = r22 * 2 + (s - 1) * 0x200;
          else {
            const cs = this.customStyle(ctx, cut && cur.style === 0x16 ? 1 : cur.style, tile, seg, cut);
            styleR = cs.renderer;
            styleId = cs.id;
          }
        } else if (endPiece) {
          if (seg === SEG_VERT || r22 === 7) {
            patId = (s - 1) * 0x100 + 0x6fc;
            styleId = (s - 1) * 0x200 + 0x12;
          } else {
            patId = (s - 1) * 0x100 + 0x6fd;
            styleId = (s - 1) * 0x200 + 0x14;
          }
        } else {
          if (cut && cur.style === 0x16 && buildTool) continue;
          patId = (s - 1) * 0x100 + 0x6fe;
          const cs = this.customStyle(ctx, cur.style, tile, seg, cut);
          styleR = cs.renderer;
          styleId = cs.id;
        }
        if (pass === 1 && seg === SEG_VERT && (r22 === 7 || r22 === 8)) offsetRect(r, 0, -(r29 + (s === 3 ? 1 : 0) + 1));
        const saved = { ...clip };
        if (trim) {
          if (seg === SEG_TL || seg === SEG_BR) clip.left = Math.max(clip.left, r.left + r26);
          else if (seg === SEG_TR || seg === SEG_BL) clip.right = Math.min(clip.right, r.right - r26);
        }
        // Wall::Draw: the tile's cRotatableWorld::GetLightEntry, except on the second pass.
        const light = pass !== 1 ? viewer.lightEntry(tile.x, tile.y, this.v0.level) : null;
        blit.drawWall(viewer, rp, clip, styleR, styleId, patR, patId, frame, r.left, r.top, colOff, seg, light);
        Object.assign(clip, saved);
      }
    }
  }

  /**
   * Wall::Draw's joint between the previous segment and this one: the wall
   * top piece around the vertex (mask of half-walls `m`, jump table
   * lbl_105BC68C) and, where a cut wall meets a full one or a fence, a slice
   * of full-height wall showing the end face.
   */
  private drawJoint(
    ctx: DrawCtx,
    cur: WallSegment,
    prev: WallSegment,
    seg: number,
    tile: Pt,
    vp: Pt,
    top: { h: number; v: number },
    altTop: number,
    altJoint: number,
    cut: number,
    prevNF: boolean,
    curNF: boolean,
  ): void {
    const { viewer, world, rp, blit, gfx, clip } = ctx;
    const s = viewer.scale;
    const u = 8 << s;
    let m = 0;
    let endFace = false;
    const sCur = isTwoPass(cur.style);
    const sPrev = isTwoPass(prev.style);
    if (seg === SEG_TL || seg === SEG_BR || seg === SEG_TR || seg === SEG_BL) {
      // Masks per segment: 1 / 4 (0x01, 0x04) or 2 / 8 (0x02, 0x08).
      const first = seg === SEG_TL || seg === SEG_BR;
      const lo = first ? 1 : 2;
      const hi = first ? 4 : 8;
      const curEnd = first ? 4 : 2;
      const prevEnd = first ? 2 : 4;
      m |= lo | hi;
      if (cut) {
        if (sCur) {
          m &= ~hi;
          if (!sPrev) endFace = true;
        }
        if (sPrev) {
          if ((cur.flags & curEnd) === 0) m &= ~lo;
          if (!sCur) endFace = true;
        }
      } else if (sPrev && prev.flags & 1) endFace = true;
      if (prevNF !== curNF) {
        m &= curNF ? ~lo : ~hi;
        endFace = true;
      } else if (!prevNF) m &= ~lo & ~hi;
      if (cur.flags & curEnd) m &= ~hi;
      if (prev.flags & prevEnd) m &= ~lo;
    } else if (seg === SEG_VERT) {
      m |= 0x50;
      if (cur.flags & 6) m &= ~0x40;
      if (!curNF) m &= ~0x40;
      if (!prevNF) m &= ~0x10;
    } else if (seg === SEG_HORIZ) {
      m |= 0xa0;
      if (cur.flags & 6) m &= ~0x80;
      if (prev.flags & 6) m &= ~0x20;
      if (!curNF) m &= ~0x80;
      if (!prevNF) m &= ~0x20;
    }
    let pieceCut = cut;
    if (cur.flags & 6) {
      if (this.dir === 1) {
        if (cur.flags & 4) pieceCut = 0;
      } else if (this.dir === 3 || this.dir === 6) {
        if (cur.flags & 2) pieceCut = 0;
      }
    }
    if (m !== 0) {
      let x = top.h - 1 - u;
      let y = top.v - (altJoint << (s + 1));
      if (seg !== SEG_HORIZ) {
        y -= 4 << s;
        rp.setGridCoords(...centerOfView(world, tile.x, tile.y), vp.level, -1);
      } else {
        x -= u;
        let tx = tile.x;
        let ty = tile.y;
        if (this.dir === 7) {
          tx += DIRS[3]![0];
          ty += DIRS[3]![1];
        } else if (this.dir === 6) {
          tx += DIRS[1]![0];
          ty += DIRS[1]![1];
        }
        rp.setGridCoords(...centerOfView(world, tx, ty), vp.level, altJoint);
      }
      if (pieceCut && seg === SEG_VERT) y -= 2 >> (3 - s);
      const frame = PIECE[m]! - 1;
      if (pieceCut) blit.drawThickWallCutawayPiece(viewer, rp, clip, 0x13ff + s, 0x17ff + s, frame, x, y - CUT_PX[s]!);
      else blit.drawThickWallPiece(viewer, rp, clip, tile, 0xfff + s, frame, x, y - viewer.levelPx(s), 0);
    }
    if (!endFace || m === 0) return;
    // The end face: one tile of full-height wall next to the joint, clipped to 3 << (s - 1) pixels.
    let faceCut = cut;
    if (sCur && (prev.flags & 1) === 0) faceCut = 0;
    let d: readonly [number, number];
    let eseg: number;
    let pattern: number;
    let right: boolean;
    if (m === 1) [d, eseg, pattern, right] = [DIRS[2]!, SEG_TR, prev.pattern[this.side]!, false];
    else if (m === 2) [d, eseg, pattern, right] = [DIRS[0]!, SEG_TL, prev.pattern[this.side]!, true];
    else if (m === 4) [d, eseg, pattern, right] = [DIRS[0]!, SEG_TL, cur.pattern[this.side]!, true];
    else if (m === 8) [d, eseg, pattern, right] = [DIRS[2]!, SEG_TR, cur.pattern[this.side]!, false];
    else return; // the original reuses stale stack values here
    const r26 = 3 << (s - 1);
    const saved = { ...clip };
    const lo = right ? top.h - 1 : top.h - r26;
    const hi = right ? top.h + r26 - 1 : top.h;
    clip.left = Math.max(clip.left, lo);
    clip.right = Math.min(clip.right, hi);
    const r = getWallBounds(viewer, eseg, s);
    const nx = tile.x + d[0];
    const ny = tile.y + d[1];
    const ntop = viewer.tileToPoint(nx, ny, tile.level, s, 0);
    const colOff = eseg === SEG_TR ? u : 0;
    offsetRect(r, ntop.h, ntop.v - (altJoint << (s + 1)));
    const g = gfx.getWallPatternGraphic(pattern, s);
    if (g) {
      const styleId = (s - 1) * 0x200 + 2 + (faceCut ? 1 : 0);
      rp.setGridCoords(...centerOfView(world, nx, ny), tile.level, altTop);
      blit.drawWall(viewer, rp, clip, null, styleId, g.renderer, g.id, segFrame(eseg), r.left, r.top, colOff, eseg);
    }
    Object.assign(clip, saved);
  }
}

/** BitMatrix64: tiles (view coordinates) whose walls the dynamic cutaway cuts. */
export class CutawayMask {
  readonly bits = new Uint8Array(64 * 64);

  has(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < 64 && y < 64 && this.bits[y * 64 + x] !== 0;
  }

  set(x: number, y: number): void {
    if (x >= 0 && y >= 0 && x < 64 && y < 64) this.bits[y * 64 + x] = 1;
  }

  clear(): void {
    this.bits.fill(0);
  }
}

export class WallManager implements WallDrawer {
  /** +4: rotation of the graph. */
  private rotation = 0;
  /** +8 / +0xc: vertices per level; +0x10 / +0x14: walls per level (sorted by IsoCompare). */
  private readonly vertices: Vertex[][] = [[], []];
  private readonly walls: Wall[][] = [[], []];
  /** cFixedWorld+0x48: vertex configurations per level (world coordinates). */
  private readonly configs: Uint8Array[] = [];
  /** HouseViewer +0x48 (walls down), +0x49 (dynamic cutaway), +0x51 (draw roof). */
  cutaway = false;
  dynamicCutaway = true;
  drawRoof = false;
  /** HouseViewer+0x204: tiles cut by the dynamic cutaway (filled by DoDynamicCutaway). */
  readonly cutawayMask = new CutawayMask();
  /** Bumped whenever cutawayMask changes. */
  maskVersion = 0;
  /** CPState mode, and the door / window tool in build mode (CPState::ShouldAlwaysShowWallStuff, Wall::Draw's build-mode tests). */
  mode: Mode = Mode.Live;
  wallToolActive = false;
  /** GetCustomWallStyleID hook (door / window objects). */
  customWallStyle: CustomWallStyleFn | null = null;
  private blitter: WallBlitter | null = null;
  private preparedKey = "";

  private constructor(
    readonly fixed: FixedWorld,
    readonly world: RotatableWorld,
    readonly gfx: WallGraphicsMgr,
  ) {
    for (let l = 1; l <= 2; l++) {
      const c = new Uint8Array(ARRAY_SIZE * ARRAY_SIZE);
      for (let x = 0; x < ARRAY_SIZE; x++) for (let y = 0; y < ARRAY_SIZE; y++) c[x * ARRAY_SIZE + y] = analyzeWallVertex(fixed, x, y, l);
      this.configs.push(c);
    }
  }

  /** WallGraphicsMgr::Initialize + LoadUsageMapAndUpdate, then BuildGraphFromMap(0). */
  static async create(house: ResFile, world: RotatableWorld): Promise<WallManager> {
    const gfx = new WallGraphicsMgr();
    await gfx.initialize();
    await gfx.loadUsageMap(house, world.fixed);
    const m = new WallManager(world.fixed, world, gfx);
    m.buildGraphFromMap();
    return m;
  }

  /** cFixedWorld::GetVertexConfig (world coordinates). */
  vertexConfig(x: number, y: number, level: number): number {
    if (x < 0 || y < 0 || x >= ARRAY_SIZE || y >= ARRAY_SIZE || level < 1 || level > 2) return 0;
    return this.configs[level - 1]![x * ARRAY_SIZE + y]!;
  }

  /** WallManager::GetVertex: lower_bound in the level's vertex list (no equality check, like the original). */
  getVertex(p: Pt): Vertex | null {
    const list = this.vertices[p.level - 1];
    if (!list) return null;
    return list[lowerBound(list, p)] ?? null;
  }

  /** WallManager::AddWall. */
  addWall(w: Wall, level: number): void {
    const list = this.walls[level - 1]!;
    list.splice(lowerBoundBy(list, w.v0, (x) => x.v0), 0, w);
  }

  /** WallManager::BuildGraphFromMap(0). */
  private buildGraphFromMap(): void {
    const size = this.fixed.size;
    for (let l = 0; l < 2; l++) {
      const list: Vertex[] = [];
      this.walls[l] = [];
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const c = this.vertexConfig(x, y, l + 1);
          if (c === 0 || !(VERTEX_JOINT[c] || VERTEX_END[c])) continue;
          const v = new Vertex(x, y, l + 1);
          v.config = c;
          list.splice(lowerBound(list, v), 0, v);
        }
      }
      list.sort(isoCompare);
      this.vertices[l] = list;
    }
    for (let l = 0; l < 2; l++) {
      this.walls[l]!.sort((a, b) => isoCompare(a.v0, b.v0));
      for (const v of this.vertices[l]!) v.buildWalls(this);
    }
    this.rotation = 0;
  }

  /**
   * WallManager::AsynchronousRebuild + HandleDirty (+ cFixedWorld::SetWall's
   * vertex configurations): the walls of `level` (0 = both) changed in the
   * world arrays; the graph is rebuilt from the map and the cutaway redone.
   * Pattern / style only changes (AsynchronousRefresh -> Wall::RefreshFromMap)
   * take the same path.
   */
  rebuildFromMap(level = 0): void {
    for (let l = 1; l <= 2; l++) {
      if (level !== 0 && l !== level) continue;
      const c = this.configs[l - 1]!;
      for (let x = 0; x < ARRAY_SIZE; x++) for (let y = 0; y < ARRAY_SIZE; y++) c[x * ARRAY_SIZE + y] = analyzeWallVertex(this.fixed, x, y, l);
    }
    this.buildGraphFromMap();
    const rot = this.world.rotation;
    if (rot !== 0) this.setRotation(rot);
    this.preparedKey = "";
  }

  /** WallManager::SetRotation. */
  setRotation(rot: number): void {
    this.rotation = rot;
    for (let l = 0; l < 2; l++) {
      for (const w of this.walls[l]!) w.setRotation(rot);
      for (const v of this.vertices[l]!) v.setRotation(rot);
    }
    for (let l = 0; l < 2; l++) {
      this.vertices[l]!.sort(isoCompare);
      this.walls[l]!.sort((a, b) => isoCompare(a.v0, b.v0));
    }
  }

  /** WallManager::SetCutaway(cut, level). */
  setCutaway(cut: boolean, level: number): void {
    const l = level - 1;
    for (const w of this.walls[l]!) w.setCutaway(cut);
    for (const v of this.vertices[l]!) v.computeCutaway();
    for (const v of this.vertices[l]!) v.computeCutawaySecondPass();
  }

  /** WallManager::ComputeCutaway(mask, level). */
  computeCutaway(mask: CutawayMask, level: number): void {
    const l = level - 1;
    for (const w of this.walls[l]!) w.computeCutaway(mask);
    for (const v of this.vertices[l]!) v.computeCutaway();
    for (const v of this.vertices[l]!) v.computeCutawaySecondPass();
  }

  /** CPState::SetWallState's calls on the HouseViewer (SetCutaway / SetDynamicCutaway / SetDrawRoof). */
  setWallState(state: WallState): void {
    if (state === WallState.Up) {
      this.cutaway = false;
      this.dynamicCutaway = false;
      this.drawRoof = false;
    } else if (state === WallState.Down) {
      this.cutaway = true;
      this.dynamicCutaway = false;
      this.drawRoof = false;
    } else if (state === WallState.Roof) {
      this.drawRoof = true;
    } else {
      this.cutaway = false;
      this.dynamicCutaway = true;
      this.drawRoof = false;
    }
  }

  /** HouseViewer::PrepareWorldForUpdate's wall part (rotation, then the cutaway of each level). */
  private prepare(viewer: HouseViewer): void {
    if (this.world.rotation !== this.rotation) this.setRotation(this.world.rotation);
    const key = `${viewer.level}|${this.cutaway}|${this.dynamicCutaway}|${this.drawRoof}|${this.rotation}|${this.maskVersion}`;
    if (key === this.preparedKey) return;
    this.preparedKey = key;
    const cur = viewer.level;
    for (let l = 1; l <= cur; l++) {
      if (l < cur || this.drawRoof) this.setCutaway(false, l);
      else if (this.cutaway) this.setCutaway(true, cur);
      else if (this.dynamicCutaway) this.computeCutaway(this.cutawayMask, cur);
      else this.setCutaway(false, cur);
    }
  }

  /**
   * WallManager::DrawIconic(x, y, scale, style, pattern, dir, rect): one
   * wall segment of `style` / `pattern` whose first tile's top corner is at
   * pixel (x, y) of `blit`'s buffer. The two vertices (at the middle of the
   * lot, level 1, and one step in `dir`) and the wall are built on the
   * first call and kept (WallManager +0x2c / +0x30 / +0x34). Wall::Draw then
   * both Vertex::Draw, clipped to (-800, -600, 800, 600). Returns the drawn
   * rectangle: x -/+ (8 << s), bottom y + (4 << s), height that of the
   * style's sprite (scale s, frame 2).
   */
  static drawIconic(blit: IconicWallBlitter, gfx: WallGraphicsMgr, x: number, y: number, scale: number, style: number, pattern: number, dir: number): ClipRect {
    if (!iconicParts) {
      // cFixedWorld size / 2 (the position only matters for depths, which the 2D blitter does not keep).
      const c = ARRAY_SIZE / 2;
      const d = DIRS[dir] ?? [0, 0];
      const v0 = new Vertex(c, c, 1);
      const v1 = new Vertex(c + d[0], c + d[1], 1);
      const wall = new Wall();
      wall.buildIconic(v0, v1);
      iconicParts = { v0, v1, wall };
    }
    const { v0, v1, wall } = iconicParts;
    wall.setWallStyle(style);
    wall.setWallPattern(pattern);
    wall.setIconic(x, y, scale);
    const ctx: IconicCtx = { blit, gfx, clip: { left: -800, top: -600, right: 800, bottom: 600 } };
    wall.drawIconic(ctx);
    v0.drawIconic(ctx);
    v1.drawIconic(ctx);
    const h = gfx.global.getListInfo(style * 2 + (scale - 1) * 0x200)?.frame(2)?.height ?? 0;
    const u = 8 << scale;
    const bottom = y + (4 << scale);
    return { left: x - u, top: bottom - h, right: x + u, bottom };
  }

  /** WallManager::DrawWalls: walls, then vertices (tops and end caps), in iso order. */
  drawWalls(viewer: HouseViewer, comp: Compositor, level: number, rp: RenderParam): void {
    if (level === 1) this.prepare(viewer);
    if (!this.blitter || this.blitter.comp !== comp) this.blitter = new WallBlitter(comp, this.gfx.global);
    const ctx: DrawCtx = {
      viewer,
      world: this.world,
      rp,
      blit: this.blitter,
      gfx: this.gfx,
      clip: { left: 0, top: 0, right: comp.width, bottom: comp.height },
      mgr: this,
    };
    for (const w of this.walls[level - 1] ?? []) w.draw(ctx);
    for (const v of this.vertices[level - 1] ?? []) {
      comp.ambient = viewer.ambientAtTile(v.x, v.y, level);
      v.draw(ctx);
    }
    comp.ambient = 1;
  }
}

/** WallManager +0x2c / +0x30 / +0x34: the iconic wall and its vertices. */
let iconicParts: { v0: Vertex; v1: Vertex; wall: Wall } | null = null;

/** std::lower_bound with IsoCompare on `pos(element)`. */
function lowerBoundBy<T>(list: readonly T[], key: { x: number; y: number }, pos: (t: T) => { x: number; y: number }): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (isoLess(pos(list[mid]!), key)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function lowerBound(list: readonly Vertex[], key: { x: number; y: number }): number {
  return lowerBoundBy(list, key, (v) => v);
}

