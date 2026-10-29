/**
 * HouseViewer: the lot view. Projection (TileToPoint / PointToTile /
 * ComputePixelTopOfTile), scrolling (offsets, min/max, AsyncScroll,
 * ScrollToTile), zoom/rotation/level and the static layer render
 * (UpdateStaticLayer -> RenderStatic -> RenderTerrainRow / RenderStaticRow,
 * WallManager::DrawWalls per level).
 *
 * The global view origin lbl_105BA418 = { x, y, scale, rotation } lives here
 * as originX / originY / scale. Screen position of tile (x, y) (view
 * coordinates) at level l with top-corner altitude a:
 *   h = originX + (8 << scale) * (x - y)
 *   v = originY + (4 << scale) * (x + y) - (l - 1) * levelPx - (a << (scale + 1))
 *
 * Dropped from the original: dirty rectangles, the static/dynamic layer
 * split and the scroll blits (the whole view is re-rendered on change).
 */

import type { Compositor, SpriteTex } from "./compositor.js";
import { drawFloor, type FloorGraphicsMgr } from "./floors.js";
import { RenderParam } from "./renderparam.js";
import { getOverlappingSprite, poolCornerSpriteId, poolSpriteId, rotateTileBits, type ByteLayer } from "./pools.js";
import { LIGHT_POOLS_ENABLED, lightMapSet, NO_LIGHT, processFloorLightEntry } from "./lightmaps.js";
import { RoofRenderer } from "./roofrender.js";
import { getViewWall } from "./tools/wallworld.js";
import { DIRS, RotatableWorld } from "./world.js";
import { LEVEL_PX, makeZSpriteLookup, ZBufferLookup } from "./zbuffer.js";
import { AnimDeviceCamera, unproject } from "../sims/camera.js";
import { rotationTf, transformDir, type Vec3 } from "../sims/math3d.js";

/** HouseViewer+0x150: a level's height in 3D world units (the y of ZBufferLookup+0x94). */
const LEVEL_HEIGHT_3D = Math.fround(9.3 + 0.0005111772335393302);

/** The (float) world -> fixed rounding of PointToTile / WorldToLevel: floor(v + 0.5), or ceil(v - 0.5) below 0. */
function roundAway(v: number): number {
  return v >= 0 ? Math.floor(v + 0.5) : Math.ceil(v - 0.5);
}

/** Software target the terrain swatches draw into (see terrain.ts). */
export interface TerrainTarget {
  width: number;
  height: number;
  color: Uint32Array;
  depth: Uint16Array;
  clip: { left: number; top: number; right: number; bottom: number };
}

/** cTerrain::Draw. */
export interface TerrainDrawer {
  draw(target: TerrainTarget, world: RotatableWorld, x: number, y: number, sx: number, sy: number, alt: readonly number[], scale: number): void;
  /** Identity of the drawer's own state for TerrainCache (null: do not reuse a frame). */
  cacheKey?(): string | null;
}

/**
 * Not part of the original (perf): the software terrain pass of the last
 * frame, reused while nothing it reads changed. Its inputs are the view
 * (origin, scale, rotation, bounds), the drawer's own state (cacheKey) and
 * the fixed world arrays RenderTerrainRow and the swatches read, compared
 * byte for byte with a copy taken when the frame was drawn.
 */
class TerrainCache {
  private key: string | null = null;
  private snap: Uint8Array[] = [];
  /** RenderParam fields left by the last RenderTerrainRow (later draws read the level). */
  private rp: Partial<RenderParam> = {};

  private static arrays(w: RotatableWorld): Uint8Array[] {
    const f = w.fixed;
    return [f.alt.data, f.ground.data, f.grass.data, f.targetGrass.data, f.pool.data, f.water.data, ...f.floors.map((a) => a.data), ...f.walls.map((a) => a.data), ...f.flags.map((a) => a.data)];
  }

  private static keyOf(v: HouseViewer): string | null {
    const t = v.terrain?.cacheKey?.() ?? null;
    if (t === null || v.thumbnailClearColor !== null) return null;
    const w = v.world;
    return `${t}|${v.originX},${v.originY},${v.scale},${w.rotation},${w.size},${w.minX},${w.maxX},${w.minY},${w.maxY}`;
  }

  /** Whether the target still holds the terrain pass for the viewer's current state. */
  valid(v: HouseViewer): boolean {
    const key = TerrainCache.keyOf(v);
    if (key === null || key !== this.key) return false;
    const now = TerrainCache.arrays(v.world);
    if (now.length !== this.snap.length) return false;
    for (let i = 0; i < now.length; i++) if (!sameBytes(now[i]!, this.snap[i]!)) return false;
    return true;
  }

  /** Record the state the target was just drawn for. */
  store(v: HouseViewer, rp: RenderParam): void {
    this.key = TerrainCache.keyOf(v);
    this.snap = this.key === null ? [] : TerrainCache.arrays(v.world).map((a, i) => {
      const old = this.snap[i];
      if (old && old.length === a.length) {
        old.set(a);
        return old;
      }
      return a.slice();
    });
    const { x, y, z, level, sx, sy, depthRow, depth, ambient } = rp;
    this.rp = { x, y, z, level, sx, sy, depthRow, depth, ambient };
  }

  restore(rp: RenderParam): void {
    Object.assign(rp, this.rp);
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  if ((a.byteOffset & 3) === 0 && (b.byteOffset & 3) === 0 && (a.length & 3) === 0) {
    const a32 = new Int32Array(a.buffer, a.byteOffset, a.length >> 2);
    const b32 = new Int32Array(b.buffer, b.byteOffset, b.length >> 2);
    for (let i = 0; i < a32.length; i++) if (a32[i] !== b32[i]) return false;
    return true;
  }
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** WallManager::DrawWalls for one level. */
export interface WallDrawer {
  drawWalls(viewer: HouseViewer, comp: Compositor, level: number, rp: RenderParam): void;
}

/** Objects standing on a tile (RenderStaticRow's object loop) and dynamic objects. */
export interface ObjectDrawer {
  drawTileObjects(viewer: HouseViewer, comp: Compositor, x: number, y: number, level: number, rp: RenderParam): void;
  drawDynamicObjects?(viewer: HouseViewer, comp: Compositor, rp: RenderParam): void;
}

const NO_ENTRY: readonly number[] = [NO_LIGHT, NO_LIGHT, NO_LIGHT, NO_LIGHT];

/** HouseViewer::GetClearColor for daytime (0x737373). */
const CLEAR_COLOR = 0x737373;

export class HouseViewer {
  /** lbl_105BA418. */
  originX = 0;
  originY = 0;
  scale = 3;
  /** +0x18: current level. */
  level = 1;
  /** +0x48 cutaway, +0x51 draw roof. */
  cutaway = true;
  drawRoof = false;
  /** +0x1ec / +0x1f0: max / min corner altitude per diagonal (x + y). */
  private readonly maxAlts = new Uint8Array(0x80);
  private readonly minAlts = new Uint8Array(0x80).fill(0x40);
  readonly zbuf: ZBufferLookup;
  private readonly zLookupIndex: number;
  private readonly floorIndex = new Map<number, number>();
  /** Water sprites with their transparent color keyed out, by (id << 2) | frame. */
  private readonly waterTex = new Map<number, SpriteTex | null>();
  private target: TerrainTarget;
  private readonly terrainCache = new TerrainCache();
  terrain: TerrainDrawer | null = null;
  walls: WallDrawer | null = null;
  objects: ObjectDrawer | null = null;
  /** Room lighting (lighting.ts): RoomManager::GetRoomAmbientLight; null = full light. */
  lighting: {
    getRoomAmbientLight(fx: number, fy: number, level: number): number;
    clampAmbient(level: number): number;
    /** cRotatableWorld::GetLightEntry of a view tile (lightmaps.ts). */
    getLightEntry?(x: number, y: number, level: number): readonly number[];
    /** Room::GetAmbientLight of a room id. */
    roomAmbient?(id: number): number;
    /** RoomManager::ResolveDiagonal (world tile): the two rooms of a diagonal tile and their sides. */
    resolveDiagonal?(x: number, y: number, level: number): { room1: number; side1: number; room2: number; side2: number };
  } | null = null;
  /** HouseViewer's dynamic cutaway (cutaway.ts), told about scale / rotation / level changes. */
  cutawayCtl: { onScale(): void; onRotation(): void; onLevel(old: number): void } | null = null;
  /** People (3D meshes), drawn after the dynamic objects with the shared depth buffer. */
  people: { draw(viewer: HouseViewer): void } | null = null;
  /** pointToTile's 3D camera (cAnimDeviceSub), rebuilt when the view moves. */
  private pickCamera: AnimDeviceCamera | null = null;
  private pickCameraKey = "";
  /** cXPerson::DrawIso's sprite slot pass (balloons.ts): balloons and headlines, drawn after the people. */
  spriteSlots: { draw(viewer: HouseViewer, comp: Compositor): void } | null = null;
  /** HouseViewer::RenderCursorObject: the buy / build tool's cursor object, drawn after the dynamic objects. */
  cursor: { draw(viewer: HouseViewer, comp: Compositor, rp: RenderParam): void } | null = null;
  /** cRoofLayer::RenderRoofPolys (created with the first roof drawn). */
  private roofRenderer: RoofRenderer | null = null;
  /** XSmoothScroller state. */
  private scroll: { fromX: number; fromY: number; toX: number; toY: number; start: number; dur: number } | null = null;
  dirty = true;
  /** +0x17c / +0x182: while MakeThumbnail renders, GetClearColor returns the buffer's transparent color (24-bit here). */
  thumbnailClearColor: number | null = null;

  /**
   * +0x50 (set by MakeThumbnail): RenderTerrainRow, RenderStaticRow and
   * RenderDynamicObjects skip the tiles with flag 0x20 (world coordinates).
   */
  isThumbnailHidden(wx: number, wy: number): boolean {
    if (this.thumbnailClearColor === null) return false;
    const f = this.world.fixed;
    return wx >= 0 && wy >= 0 && wx < f.size && wy < f.size && (f.flags[0]!.u8(wx, wy) & 0x20) !== 0;
  }

  constructor(
    readonly world: RotatableWorld,
    readonly comp: Compositor,
    readonly floors: FloorGraphicsMgr,
    /** View rectangle (HouseViewer+0x28): the 3D viewport, width x (height - 100). */
    readonly viewW: number,
    readonly viewH: number,
  ) {
    this.zbuf = new ZBufferLookup(viewW, viewH);
    this.zLookupIndex = comp.table1D("zsprite", makeZSpriteLookup());
    this.target = {
      width: comp.width,
      height: comp.height,
      color: new Uint32Array(comp.width * comp.height),
      depth: new Uint16Array(comp.width * comp.height),
      clip: { left: 0, top: 0, right: comp.width, bottom: comp.height },
    };
    this.buildMaxAltsTable();
  }

  // --- projection -------------------------------------------------------------

  levelPx(scale = this.scale): number {
    return LEVEL_PX[scale]!;
  }

  /** HouseViewer::TileToPoint(TilePt, level, scale, alt*): top corner of a view tile. */
  tileToPoint(x: number, y: number, level: number, scale = this.scale, alt: number | null = null): { h: number; v: number } {
    let a = 0;
    if (alt !== null) a = alt;
    else if (this.world.inInterior(x, y)) a = this.world.getPackedAlt(x, y)[1];
    const ox = scale === this.scale ? this.originX : this.originAt(scale).x;
    const oy = scale === this.scale ? this.originY : this.originAt(scale).y;
    return {
      h: ox + (8 << scale) * (x - y),
      v: oy + (4 << scale) * (x + y) - (level - 1) * this.levelPx(scale) - (a << (scale + 1)),
    };
  }

  /**
   * HouseViewer::GetTheoreticalWallExtent: screen rectangle a full-height
   * wall standing on view tile (x, y) would cover.
   */
  getTheoreticalWallExtent(x: number, y: number, level: number): { left: number; top: number; right: number; bottom: number } {
    const s = this.scale;
    const lp = this.levelPx(s);
    const a = this.world.getPackedAlt(x, y)[1];
    const h = this.originX + (8 << s) * (x - y);
    const v = this.originY + (4 << s) * (x + y) - (level - 1) * lp - (a << (s + 1));
    return { left: h - (8 << s) - 1, top: v - lp, right: h + (8 << s) - 1, bottom: v + (8 << s) };
  }

  /**
   * RoomManager::GetRoomAmbientLight at a fixed-point view position (1/16
   * tile), through RenderParam::SetAmbientLightLevel's clamp.
   */
  ambientAt(fx: number, fy: number, level: number): number {
    const l = this.lighting;
    return l ? l.clampAmbient(l.getRoomAmbientLight(fx, fy, level)) : 1;
  }

  /** Ambient at a view tile's center (FTilePt(x + 1/2, y + 1/2), as RenderStaticRow asks). */
  ambientAtTile(x: number, y: number, level: number): number {
    return this.ambientAt((x << 4) | 8, (y << 4) | 8, level);
  }

  /**
   * cRotatableWorld::GetLightEntry of a view tile, or no light ([0x7f] * 4)
   * when lighting is off.
   */
  lightEntry(x: number, y: number, level: number): readonly number[] {
    return this.lighting?.getLightEntry?.(x, y, level) ?? NO_ENTRY;
  }

  /**
   * cRenderer::DrawFloor's choice between FloorBlit and the lit blitters for
   * a floor sprite whose top-left corner is at (sx, sy): LitFloorBlit /
   * LitFloorAddBlit when the tile's light entry has lights within the floor
   * maps' range (ProcessFloorLightEntry) and the ambient level is not 1.
   * Sets Compositor.light for the draw; clearFloorLight resets it.
   */
  setFloorLight(x: number, y: number, level: number, sx: number, sy: number, entry: readonly number[] | null = null): void {
    this.comp.light = null;
    if (!LIGHT_POOLS_ENABLED) return;
    const a = this.comp.ambient;
    if (Math.abs(a - 1) <= 1e-6) return;
    const s = this.scale;
    const lights = processFloorLightEntry(entry ?? this.lightEntry(x, y, level), lightMapSet.floorRange(s));
    if (lights.length === 0) return;
    const tex = this.comp.lightMapTexture(lightMapSet.floor(s));
    const maps = lights.map(([dx, dy]) => {
      const o = lightMapSet.floorOrigin(s, dx, dy);
      return { tex, x: sx - o.col, y: sy - o.row };
    });
    this.comp.light = { base: Math.trunc(255 * a + 0.5), maps };
  }

  /** Origin rescaled to another scale (the TileToPoint branch for scale != current). */
  private originAt(scale: number): { x: number; y: number } {
    const d = this.scale - scale;
    return d < 1 ? { x: this.originX * (1 << -d), y: this.originY * (1 << -d) } : { x: Math.trunc(this.originX / (1 << d)), y: Math.trunc(this.originY / (1 << d)) };
  }

  /**
   * HouseViewer::TileToPoint(FTilePt, ...): fixed-point view position (1/16
   * tile), interpolating over the tile's corner altitudes (or a flat `alt`).
   */
  tileToPointF(fx: number, fy: number, level: number, scale = this.scale, alt: number | null = null): { h: number; v: number } {
    const tx = fx >> 4;
    const ty = fy >> 4;
    const u5 = fx & 0xf;
    const u2 = fy & 0xf;
    const base = this.tileToPoint(tx, ty, level, scale, alt);
    let a0: number;
    let a1: number;
    let a2: number;
    let a3: number;
    if (alt !== null) {
      a0 = a1 = a2 = a3 = alt;
    } else if (this.world.inInterior(tx, ty)) {
      [a0, a1, a2, a3] = this.world.getPackedAlt(tx, ty);
    } else {
      a0 = a1 = a2 = a3 = 0;
    }
    const sh = scale + 1;
    const div16 = (n: number): number => Math.trunc(n / 16);
    const half = 8 << scale;
    if (u5 === u2) {
      return { h: base.h, v: base.v + div16(u5 * ((a1 - a3 + 4) << sh)) };
    }
    if (u2 < u5) {
      const iv9 = div16(u5 * ((a1 - a2 + 2) << sh));
      const iv7 = div16(half * u5);
      const full = div16(u5 * ((a1 - a3 + 4) << sh));
      return { h: base.h + (iv7 - Math.trunc((iv7 * u2) / u5)), v: base.v + iv9 + Math.trunc((u2 * (full - iv9)) / u5) };
    }
    const iv9 = div16(u2 * ((a1 - a0 + 2) << sh));
    const iv7 = div16(-half * u2);
    const full = div16(u2 * ((a1 - a3 + 4) << sh));
    return { h: base.h + (iv7 - Math.trunc((iv7 * u5) / u2)), v: base.v + iv9 + Math.trunc((u5 * (full - iv9)) / u2) };
  }

  /** HouseViewer::ComputePixelTopOfTile (no altitude): screen y of the tile's top corner. */
  computePixelTopOfTile(x: number, y: number, level: number): number {
    let v = this.originY + (4 << this.scale) * (x + y);
    if (level !== 0) v -= (level - 1) * this.levelPx();
    return v;
  }

  /** ZBufferLookup::GetTerrainZ: depth of the ground at a view tile's top corner. */
  getTerrainZ(x: number, y: number): number {
    const s = this.scale;
    const top = this.computePixelTopOfTile(x, y, 1);
    const alt = this.world.inBounds(x, y) ? this.world.getPackedAlt(x, y)[1] : 0;
    return this.zbuf.floorAt(s, top, this.originY) + this.zbuf.altitude(s, alt);
  }

  /** Compositor table index of the floor-table entry for screen row `row`. */
  floorRowIndex(row: number): number {
    const s = this.scale;
    let base = this.floorIndex.get(s);
    if (base === undefined) {
      base = this.comp.table1D(`floor${s}`, this.zbuf.floor.get(s)!);
      this.floorIndex.set(s, base);
    }
    return base + this.zbuf.floorBase.get(s)! + row - this.originY;
  }

  /**
   * HouseViewer::WorldToLevel: the level a 3D world point lies on, from its
   * height above the tile's mean altitude (4 corners x 3 / 4 x 1 / (2 sqrt 6))
   * against the level height (HouseViewer+0x150, the y of the per-level vector).
   */
  worldToLevel(p: Vec3): number {
    const f = this.world.fixed;
    const tx = roundAway(p[2] * (16 / 3)) >> 4;
    const ty = roundAway(p[0] * (16 / 3)) >> 4;
    let alt = 0;
    if (tx > 0 && tx < f.size - 1 && ty > 0 && ty < f.size - 1) {
      const o = f.alt.offset(tx, ty);
      const a = f.alt.data;
      const sum = a[o]! + a[o + 1]! + a[o + 2]! + a[o + 3]!;
      alt = 3 * 0.25 * sum * (1 / (2 * Math.sqrt(6)));
    }
    const h = p[1] - alt;
    if (h < 2 * LEVEL_HEIGHT_3D) return h < LEVEL_HEIGHT_3D ? 1 : 2;
    return 3;
  }

  /**
   * HouseViewer::PointToTile(pt, false): the view fixed-point position under a
   * screen point. Where something was drawn, the z-buffer value there is
   * unprojected through the 3D camera (cAnimDeviceSub+0xa4) and, when it lies
   * on the viewed level and inside the lot, that surface's position is the
   * answer (so a person standing in front of a sofa gives the person's tile);
   * otherwise the floor under the point (PointToWholeTile).
   */
  pointToTile(px: number, py: number): { x: number; y: number } {
    const z = this.comp.readDepth(px, py);
    if (z !== null) {
      const view = { zoom: this.scale, rotation: this.world.rotation, originX: this.originX, originY: this.originY, width: this.viewW, height: this.viewH };
      const key = `${view.zoom}|${view.rotation}|${view.originX}|${view.originY}`;
      if (this.pickCameraKey !== key || !this.pickCamera) {
        this.pickCamera = new AnimDeviceCamera(view);
        this.pickCameraKey = key;
      }
      const p = unproject(this.pickCamera, px, py, z);
      const level = this.worldToLevel(p);
      if (level === 2) {
        // The level offset (0.5, 0, 0.5) turned by -90 degrees x rotation (SAnimator::UpdateRootPos's).
        const d = transformDir([0.5, 0, 0.5], rotationTf(1, 0.5 * -(this.world.rotation & 3) * Math.PI));
        p[0] -= d[0];
        p[2] -= d[2];
      }
      const fx = roundAway(p[2] * (16 / 3));
      const fy = roundAway(p[0] * (16 / 3));
      const n = this.world.size - 1;
      if (level === this.level && fx >> 4 >= 1 && fx >> 4 < n && fy >> 4 >= 1 && fy >> 4 < n) {
        const [vx, vy] = RotatableWorld.rotateCoords(fx, fy, this.world.rotation, 0x400);
        return { x: vx >> 4, y: vy >> 4 };
      }
    }
    return this.pointToWholeTile(px, py, this.level);
  }

  /** HouseViewer::PointToWholeTile: view tile under a screen point. */
  pointToWholeTile(px: number, py: number, level = this.level): { x: number; y: number } {
    const s = this.scale;
    const hx = Math.trunc((px - this.originX) / 2);
    const vy = py - this.originY;
    let x = (hx + vy) >> (s + 3);
    let y = (vy - hx) >> (s + 3);
    let tx = x;
    let ty = y;
    let flip = this.tileToPoint(tx, ty, level).h >= px;
    while (tx < 0 || ty < 0) {
      if (flip) ty++;
      else tx++;
      flip = !flip;
    }
    const maxX = this.world.maxX + 1;
    const maxY = this.world.maxY + 1;
    while (tx < maxX && ty < maxY) {
      const next = !flip;
      if (flip) {
        ty++;
        if (ty >= maxY) break;
      } else {
        tx++;
        if (tx >= maxX) break;
      }
      if (this.tileToPoint(tx, ty, level).v < py) {
        x = tx;
        y = ty;
      }
      flip = next;
    }
    // Walk back while the point lies outside the tile's left/right edges (slopes dv/dh).
    for (let guard = 0; guard < 256; guard++) {
      const p = this.tileToPoint(x, y, level);
      if (px < p.h) {
        const q = this.tileToPoint(x, y + 1, level);
        if (Math.trunc(((p.v - q.v) * 0x10000) / (p.h - q.h)) < Math.trunc(((p.v - py) * 0x10000) / (p.h - px))) {
          x--;
          continue;
        }
      } else if (px !== p.h) {
        const q = this.tileToPoint(x + 1, y, level);
        if (Math.trunc(((p.v - py) * 0x10000) / (p.h - px)) < Math.trunc(((p.v - q.v) * 0x10000) / (p.h - q.h))) {
          y--;
          continue;
        }
      }
      break;
    }
    return { x, y };
  }

  // --- scrolling --------------------------------------------------------------

  /** HouseViewer::BuildMaxAltsTable. */
  buildMaxAltsTable(): void {
    this.maxAlts.fill(0);
    this.minAlts.fill(0x40);
    const w = this.world;
    for (let j = 0; j < 0x40; j++) {
      for (let i = 0; i < 0x40; i++) {
        if (i >= w.size || j >= w.size) continue;
        const x = i + w.minX;
        const y = j + w.minY;
        const a = w.getPackedAlt(x, y);
        const k = x + y;
        for (const c of a) {
          if (c > this.maxAlts[k]!) this.maxAlts[k] = c;
          if (c < this.minAlts[k]!) this.minAlts[k] = c;
        }
      }
    }
  }

  /**
   * HouseViewer::GetOffsetsMinMax: allowed origin range for a view of
   * viewW x viewH (MakeThumbnail asks for its buffer's size). `low` is what
   * the original keeps at +0x1f4 (the thumbnail's z).
   */
  getOffsetsMinMax(viewW = this.viewW, viewH = this.viewH): { minX: number; maxX: number; minY: number; maxY: number; low: number } {
    const s = this.scale;
    const w = this.world;
    const n = w.size - 2;
    const tileW = 16 << s;
    const span = tileW * n;
    let minX: number;
    let maxX: number;
    if (viewW < span) {
      minX = Math.trunc(-span / 2) + viewW - (8 << s);
      maxX = Math.trunc(span / 2) + tileW;
    } else {
      minX = maxX = Math.trunc(viewW / 2);
    }
    let top = 0;
    for (let k = 1, x = w.minX + 1, y = w.minY + 1; k < n + 1; k++, x++, y++) {
      top = Math.max(top, (this.maxAlts[x + y]! << (s + 1)) - (4 << s) * k);
    }
    let maxY = top + this.levelPx() * 2;
    let minY = viewH - (8 << s) * n - (8 << s) * 2;
    let low = 0x7fffffff;
    for (let k = 1, x = n + w.minX, y = n + w.minY; k < n + 1; k++, x--, y--) {
      low = Math.min(low, (4 << s) * k - (this.minAlts[x + y]! << (s + 1)));
    }
    minY -= low;
    const dx = (8 << s) * (w.minX - w.minY);
    const dy = (4 << s) * (w.minX + w.minY);
    minX -= dx;
    maxX -= dx;
    maxY -= dy;
    minY -= dy;
    return { minX, maxX, minY, maxY, low };
  }

  /** HouseViewer::SetOffsets: clamp, align x to 4 pixels, move the origin. */
  setOffsets(x: number, y: number): void {
    const m = this.getOffsetsMinMax();
    const cx = (Math.min(Math.max(x, m.minX), m.maxX) + 1) & ~3;
    const cy = Math.min(Math.max(y, m.minY), m.maxY);
    if (cx === this.originX && cy === this.originY) return;
    this.originX = cx;
    this.originY = cy;
    this.dirty = true;
  }

  /** HouseViewer::ScrollToTile(FTilePt, level, smooth=false): center a fixed-point view position. */
  scrollToTile(fx: number, fy: number, level: number, smooth: boolean, now = performance.now()): void {
    if (level !== this.level) this.setLevel(level);
    const p = this.tileToPointF(fx, fy, this.level);
    const tx = this.originX - (p.h - Math.trunc(this.viewW / 2));
    const ty = this.originY - (p.v - Math.trunc(this.viewH / 2));
    if (smooth) this.startScroll(tx, ty, 250, now);
    else this.setOffsets(tx, ty);
  }

  /** HouseViewer::AsyncScroll: smooth scroll by (dx, dy), clamped like SetOffsets. */
  asyncScroll(dx: number, dy: number, now = performance.now()): void {
    const fromX = this.scroll ? this.scroll.toX : this.originX;
    const fromY = this.scroll ? this.scroll.toY : this.originY;
    const m = this.getOffsetsMinMax();
    const x = (Math.min(Math.max(fromX + dx, m.minX), m.maxX) + 1) & ~3;
    const y = Math.min(Math.max(fromY + dy, m.minY), m.maxY);
    // Duration lbl_105BA680 (250) * 0.5 + 0.5.
    this.startScroll(x, y, Math.trunc(250 * 0.5 + 0.5), now);
  }

  private startScroll(toX: number, toY: number, dur: number, now: number): void {
    this.scroll = { fromX: this.originX, fromY: this.originY, toX, toY, start: now, dur };
  }

  isScrolling(): boolean {
    return this.scroll !== null;
  }

  /** XSmoothScroller tick. */
  pump(now: number): void {
    const s = this.scroll;
    if (!s) return;
    const t = Math.min(1, (now - s.start) / s.dur);
    this.setOffsets(Math.round(s.fromX + (s.toX - s.fromX) * t), Math.round(s.fromY + (s.toY - s.fromY) * t));
    if (t >= 1) this.scroll = null;
  }

  /** View position at the screen center, fixed point (ComputeCentermostTile + the out-of-bounds fallback). */
  private centerFixed(): { fx: number; fy: number } {
    const t = this.pointToWholeTile(Math.trunc(this.viewW / 2), Math.trunc(this.viewH / 2), this.level);
    const w = this.world;
    if (!w.inInterior(t.x, t.y)) {
      const q = Math.trunc(w.size / 4);
      return { fx: ((q + w.minX) << 4) | 8, fy: ((q + w.minY) << 4) | 8 };
    }
    return { fx: (t.x << 4) | 8, fy: (t.y << 4) | 8 };
  }

  /** HouseViewer::SetScale: keep the centermost tile centered. */
  setScale(scale: number): void {
    if (scale === this.scale) return;
    const c = this.centerFixed();
    this.scale = scale;
    this.scroll = null;
    this.scrollToTile(c.fx, c.fy, this.level, false);
    this.dirty = true;
    this.cutawayCtl?.onScale();
  }

  /** HouseViewer::SetRotation: rotate around the centermost tile. */
  setRotation(rot: number): void {
    if ((rot & 3) === this.world.rotation) return;
    const c = this.centerFixed();
    let [wx, wy] = RotatableWorld.rotateCoords(c.fx, c.fy, (4 - this.world.rotation) & 3, 0x400);
    const old = this.world.rotation;
    this.world.setRotation(rot);
    this.buildMaxAltsTable();
    // Road tiles (floor patterns 10 / 11) have a direction: an odd rotation swaps them.
    if (((old - this.world.rotation) & 1) !== 0) {
      const f = this.world.fixed.floors[0]!.data;
      for (let i = 0; i < f.length; i += 2) {
        const v = f[i]! | (f[i + 1]! << 8);
        if (v === 10 || v === 11) f[i] = v ^ 1;
      }
    }
    [wx, wy] = RotatableWorld.rotateCoords(wx, wy, this.world.rotation, 0x400);
    this.scroll = null;
    this.scrollToTile(wx, wy, this.level, false);
    this.dirty = true;
    this.cutawayCtl?.onRotation();
  }

  /** HouseViewer::SetLevel. */
  setLevel(level: number): void {
    if (level === this.level) return;
    const old = this.level;
    this.level = level;
    this.dirty = true;
    this.cutawayCtl?.onLevel(old);
  }

  // --- rendering --------------------------------------------------------------

  /** HouseViewer::UpdateStaticLayer for the whole view. */
  render(): void {
    const comp = this.comp;
    const c = this.thumbnailClearColor ?? CLEAR_COLOR;
    comp.clear((c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff);
    const rp = new RenderParam(this, this.zLookupIndex);
    // Terrain + ground floors (RenderStatic(level 1, terrain pass)).
    this.renderStatic(1, true, rp);
    for (let l = 1; l <= this.level; l++) {
      this.walls?.drawWalls(this, comp, l, rp);
      this.renderStatic(l, false, rp);
    }
    // UpdateStaticLayer: with the roof shown (+0x51), RenderRoofPolys of the roof layers below the level.
    if (this.drawRoof) (this.roofRenderer ??= new RoofRenderer(comp.gl)).draw(this);
    this.objects?.drawDynamicObjects?.(this, comp, rp);
    comp.ambient = 1;
    this.cursor?.draw(this, comp, rp);
    this.people?.draw(this);
    this.spriteSlots?.draw(this, comp);
    comp.present();
    this.dirty = false;
  }

  /** HouseViewer::RenderStatic: rows of tiles of equal x + y, top to bottom. */
  private renderStatic(level: number, terrainPass: boolean, rp: RenderParam): void {
    const w = this.world;
    const s = this.scale;
    const n = w.size;
    const step = DIRS[6]!;
    const rows: Array<{ x: number; y: number; count: number }> = [];
    for (let i = 0; i < n; i++) rows.push({ x: w.minX, y: w.minY + i, count: i + 1 });
    for (let i = 1; i < n; i++) rows.push({ x: w.minX + i, y: w.minY + n - 1, count: n - i });
    const tileH = 8 << s;
    const margin = this.levelPx() * 2 + (0x40 << (s + 1));
    if (terrainPass) {
      const reuse = this.terrainCache.valid(this);
      if (reuse) {
        this.terrainCache.restore(rp);
      } else {
        const c = this.thumbnailClearColor ?? CLEAR_COLOR;
        this.target.color.fill(0xff000000 | ((c & 0xff) << 16) | (c & 0xff00) | ((c >> 16) & 0xff));
        this.target.depth.fill(0xffff);
        for (const r of rows) {
          const top = this.tileToPoint(r.x, r.y, level, s, 0).v;
          if (top - margin > this.viewH || top + tileH < 0) continue;
          this.renderTerrainRow(r.x, r.y, r.count, step, level, rp);
        }
        this.terrainCache.store(this, rp);
      }
      this.comp.drawRaw(this.target.color, this.target.depth, !reuse);
      for (const r of rows) {
        const top = this.tileToPoint(r.x, r.y, level, s, 0).v;
        if (top - margin > this.viewH || top + tileH < 0) continue;
        this.renderTerrainFloors(r.x, r.y, r.count, step, rp);
      }
      return;
    }
    for (const r of rows) {
      const top = this.tileToPoint(r.x, r.y, level, s, 0).v;
      if (top - margin - 512 > this.viewH || top + tileH + 512 < 0) continue;
      this.renderStaticRow(r.x, r.y, r.count, step, level, rp);
    }
  }

  private tileVisible(sx: number, sy: number): boolean {
    const s = this.scale;
    return sx + (8 << s) >= 0 && sx - (8 << s) < this.viewW && sy + (8 << s) >= 0 && sy - (0x40 << (s + 1)) < this.viewH;
  }

  /** RenderTerrainRow, terrain half: cTerrain::Draw per tile into the software target. */
  private renderTerrainRow(x0: number, y0: number, count: number, step: readonly [number, number], level: number, rp: RenderParam): void {
    const terrain = this.terrain;
    if (!terrain) return;
    const w = this.world;
    for (let k = 0; k < count; k++) {
      const x = x0 + step[0] * k;
      const y = y0 + step[1] * k;
      const p = this.tileToPoint(x, y, level, this.scale, 0);
      if (!this.tileVisible(p.h, p.v)) continue;
      if (!this.terrainVisible(x, y)) continue;
      if (this.isThumbnailHidden(...w2(w, x, y))) continue;
      const alt = w.getPackedAlt(x, y);
      rp.setGridCoords(...this.fixedCenter(x, y), 1);
      terrain.draw(this.target, w, x, y, p.h, p.v, alt, this.scale);
    }
  }

  /** World fixed-point center of a view tile. */
  private fixedCenter(x: number, y: number): [number, number] {
    const [wx, wy] = w2(this.world, x, y);
    return [(wx << 4) | 8, (wy << 4) | 8];
  }

  /**
   * RenderTerrainRow's test for drawing terrain under a tile: skipped only
   * when the tile and its four neighbors are floored and the neighbors have
   * water entries (cFixedWorld::HasWater).
   */
  private terrainVisible(x: number, y: number): boolean {
    const w = this.world;
    if (w.getFloor(x, y, 1) === 0) return true;
    const n = w.size;
    const xm = Math.max(x - 1, 0);
    const xp = Math.min(x + 1, n);
    const ym = Math.max(y - 1, 0);
    const yp = Math.min(y + 1, n);
    const floored = (a: number, b: number): boolean => w.inBounds(a, b) && w.getFloor(a, b, 1) !== 0;
    const water = (a: number, b: number): boolean => w.inBounds(a, b) && w.hasWater(a, b, 1);
    if (!floored(xm, y) || !floored(xp, y) || !floored(x, ym) || !floored(x, yp)) return true;
    return !(water(xm, y) && water(xp, y) && water(x, ym) && water(x, yp));
  }

  /** RenderTerrainRow, floor half: pool deck edge and ground floors. */
  private renderTerrainFloors(x0: number, y0: number, count: number, step: readonly [number, number], rp: RenderParam): void {
    const w = this.world;
    const s = this.scale;
    for (let k = 0; k < count; k++) {
      const x = x0 + step[0] * k;
      const y = y0 + step[1] * k;
      const base = this.tileToPoint(x, y, 1, s, 0);
      if (!this.tileVisible(base.h, base.v)) continue;
      if (this.isThumbnailHidden(...w2(w, x, y))) continue;
      const alt = w.getPackedAlt(x, y);
      const fx = base.h - (8 << s);
      const fy = base.v - (alt[1] << (s + 1));
      if (this.terrainVisible(x, y) && !w.hasPool(x, y, 1)) {
        // Deck around pools: floor pattern 1 when a neighbor (dirs 0, 2, 4) has a pool.
        const nearPool = [DIRS[0]!, DIRS[2]!, DIRS[4]!].some(([dx, dy]) => w.inBounds(x + dx, y + dy) && w.hasPool(x + dx, y + dy, 1));
        if (nearPool) {
          const g = this.floors.getFloorGraphic(1, s);
          if (g) drawFloor(this.comp, this, g.renderer, { x, y, level: 1 }, g.id, fx, fy);
        }
      }
      const floor = w.getFloor(x, y, 1);
      if (floor !== 0) this.drawTerrainFloor(x, y, floor, fx, fy);
      this.drawWaterTile(x, y, alt[1]);
    }
  }

  /** RenderTerrainRow's ground floor tile. */
  private drawTerrainFloor(x: number, y: number, floor: number, fx: number, fy: number): void {
    this.comp.ambient = this.ambientAtTile(x, y, 1);
    this.drawTileFloor(x, y, 1, floor, fx, fy);
  }

  /**
   * RenderTerrainRow's floor of a view tile whose floor pattern is not 0,
   * with its top-left corner at (fx, fy). A tile with a diagonal wall draws
   * its two half floors (TileWalls +0x08 for sides 1 / 2, +0x14 for sides
   * 3 / 4; both the tile's pattern when both are 0), each clipped (the
   * lbl_105BA5F4 clip rectangle) to its side of the tile's center:
   *   0x10: the +0x14 half below the center row, then the +0x08 half above;
   *   0x20: the +0x08 half left of the center column, then the +0x14 half right.
   * On a degenerate tile (two rooms) each half takes the ambient light of
   * its room, and the lights of the other room are taken out of its light
   * entry.
   */
  private drawTileFloor(x: number, y: number, level: number, floor: number, fx: number, fy: number): void {
    const w = this.world;
    const s = this.scale;
    const draw = (pattern: number, entry: readonly number[] | null): void => {
      const g = this.floors.getFloorGraphic(pattern, s);
      if (!g) return;
      this.setFloorLight(x, y, level, fx, fy, entry);
      drawFloor(this.comp, this, g.renderer, { x, y, level }, g.id, fx, fy);
      this.comp.light = null;
    };
    const segs = w.getWallStorage(x, y, level).segs;
    const t = segs !== 0 ? getViewWall(w, x, y, level) : null;
    if (!t || (t.segs & 0x30) === 0) {
      draw(floor, null);
      return;
    }
    let first = t.styles[0]!;
    let second = t.patterns[0]!;
    if (first === 0 && second === 0) first = second = floor;
    const [wx, wy] = w.toWorld(x, y);
    const l = this.lighting;
    const d = l?.resolveDiagonal?.(wx, wy, level) ?? null;
    const rot = w.rotation;
    const side1 = d && d.side1 !== 0 ? ((d.side1 + ((4 - rot) & 3) - 1) & 3) + 1 : 0;
    const degenerate = w.fixed.rooms[level - 1]!.u16(wx, wy) === 0xfffb;
    const entry = this.lightEntry(x, y, level);
    // `own`: the diagonal side the half lies on (0x10: 2 below, 4 above; 0x20: 1 left, 3 right).
    const half = (pattern: number, own: number, clip: { left: number; top: number; right: number; bottom: number }): void => {
      if (pattern === 0) return;
      let e: readonly number[] = entry;
      if (d && d.room1 !== d.room2) {
        const other = ((own + 1) & 3) + 1;
        const match = side1 === own || side1 === 0 ? d.room1 : side1 === other ? d.room2 : -1;
        e = this.filterHalfLights(entry, x, y, level, match);
      }
      if (degenerate && d && l?.roomAmbient) this.comp.ambient = l.clampAmbient(l.roomAmbient(side1 === own ? d.room1 : d.room2));
      this.comp.setClip(clip);
      draw(pattern, e);
      this.comp.setClip(null);
    };
    const full = { left: 0, top: 0, right: this.viewW, bottom: this.viewH };
    if (t.segs & 0x10) {
      const cy = fy + (4 << s);
      half(second, 2, { ...full, top: Math.max(full.top, cy) });
      half(first, 4, { ...full, bottom: Math.min(full.bottom, cy) });
    } else {
      const cx = fx + (8 << s);
      half(first, 1, { ...full, right: Math.min(full.right, cx) });
      half(second, 3, { ...full, left: Math.max(full.left, cx) });
    }
  }

  /**
   * RenderTerrainRow's light entry of one half floor: a light (at the tile
   * minus its offset, view coordinates) whose room is not the half's room
   * (`room`; -1 = no test) leaves the entry (LightEntry::Count, slot 1 moves
   * to slot 0 when slot 0 goes).
   */
  private filterHalfLights(entry: readonly number[], x: number, y: number, level: number, room: number): number[] {
    const e = [...entry];
    const count = (): number => (e[0] !== NO_LIGHT ? 1 : 0) + (e[2] !== NO_LIGHT ? 1 : 0);
    const n = count();
    if (n === 0 || room < 0) return e;
    const roomAt = (vx: number, vy: number): number => {
      const [wx, wy] = this.world.toWorld(vx, vy);
      return this.world.fixed.outOfGrid(wx, wy) ? -1 : this.world.fixed.rooms[level - 1]!.u16(wx, wy);
    };
    const r0 = roomAt(x - e[0]!, y - e[1]!);
    const r1 = n === 2 ? roomAt(x - e[2]!, y - e[3]!) : -1;
    if (r0 !== room) {
      const c = count();
      if (c === 1) e[0] = e[1] = NO_LIGHT;
      else if (c === 2) {
        e[0] = e[2]!;
        e[1] = e[3]!;
        e[2] = e[3] = NO_LIGHT;
      }
    }
    if (n === 2 && r1 !== room) {
      const c = count();
      if (c === 1) e[0] = e[1] = NO_LIGHT;
      else if (c === 2) e[2] = e[3] = NO_LIGHT;
    }
    return e;
  }

  /**
   * RenderTerrainRow's water: an interior tile with a cWaterLayer entry
   * draws sprite 0x800 + its edge bits (cWaterTile::Rotate) of the water
   * renderer (floors.iff), frame 3 - scale, one pixel left and 4 (scale 3) or
   * 1 pixels up (cRenderer::DrawWaterTile -> SpriteListInfo::Render with the
   * floor flag: the frame's transparent color is skipped, depth from the
   * floor table at GetTerrainZ + 0x50).
   */
  private drawWaterTile(x: number, y: number, altTop: number): void {
    const w = this.world;
    if (!w.inInterior(x, y)) return;
    const [wx, wy] = w.toWorld(x, y);
    // cWaterTool's preview replaces the (then empty) world layer.
    const raw = (this.dynamicWaterLayer ?? w.fixed.water).u8(wx, wy);
    if (raw === 0xff) return;
    const s = this.scale;
    const id = rotateTileBits(raw, w.rotation) + 0x800;
    const frame = 3 - s;
    const key = (id << 2) | frame;
    let tex = this.waterTex.get(key);
    if (tex === undefined) {
      const f = this.floors.global.frame(id, frame);
      tex = null;
      if (f && f.width > 0 && f.height > 0) {
        const keyed = { ...f, mode: f.mode.map((m, i) => (f.index[i] === f.transparentIndex ? 0 : m)) };
        tex = this.comp.uploadSprite(keyed, this.floors.global.palette(f.paletteId));
      }
      this.waterTex.set(key, tex);
    }
    if (!tex) return;
    this.comp.ambient = this.ambientAtTile(x, y, 1);
    const top = this.tileToPoint(x, y, 1, s, 0);
    const sx = top.h - (8 << s) - 1;
    const sy = top.v - (altTop << (s + 1)) - (s === 3 ? 4 : 1);
    const zb = this.zbuf;
    const base = this.getTerrainZ(x, y) + 0x50 - zb.floorAt(s, sy, this.originY);
    this.comp.drawFloorSprite(tex, sx, sy, false, base, this.floorRowIndex(sy));
  }

  /** +0x4b4: cPoolTool's preview layer (HouseViewer::ApplyDynamicPoolLayer). */
  dynamicPoolLayer: ByteLayer | null = null;

  /** HouseViewer::ApplyDynamicPoolLayer */
  applyDynamicPoolLayer(layer: ByteLayer): void {
    this.dynamicPoolLayer = layer;
  }

  /** HouseViewer::RemoveDynamicPoolLayer */
  removeDynamicPoolLayer(): void {
    this.dynamicPoolLayer = null;
  }

  /** cWaterTool's preview layer (HouseViewer::ApplyDynamicWaterLayer). */
  dynamicWaterLayer: ByteLayer | null = null;

  /** HouseViewer::ApplyDynamicWaterLayer */
  applyDynamicWaterLayer(layer: ByteLayer): void {
    this.dynamicWaterLayer = layer;
  }

  /** HouseViewer::RemoveDynamicWaterLayer */
  removeDynamicWaterLayer(): void {
    this.dynamicWaterLayer = null;
  }

  /**
   * RenderStaticRow, level 1: the tile's pool layer entry. A pool tile draws
   * floor sprite 0x400 + its rotated edge bits, a deck tile floor 0x0c, then
   * the inner corners (cPoolLayer::GetOverlappingSprite), all with the
   * global floor renderer, at the tile center's RenderParam position minus
   * half a tile, without light pools.
   */
  private drawPoolTile(x: number, y: number, rp: RenderParam): void {
    const w = this.world;
    const [wx, wy] = w.toWorld(x, y);
    // While cPoolTool is selected the world layer is empty and its preview is
    // drawn instead (the original draws it in RenderDynamicPoolLayer).
    const layer = this.dynamicPoolLayer ?? w.fixed.pool;
    const raw = layer.u8(wx, wy);
    if (raw > 0x10) return;
    const s = this.scale;
    const g = this.floors.global;
    rp.setGridCoords((wx << 4) | 8, (wy << 4) | 8, 1);
    const sx = rp.sx - (8 << s);
    const sy = rp.sy - (4 << s);
    const tile = { x, y, level: 1 };
    drawFloor(this.comp, this, g, tile, poolSpriteId(rotateTileBits(raw, w.rotation), s), sx, sy);
    const corners = getOverlappingSprite(w.fixed, layer, wx, wy, w.rotation);
    for (let k = 0; k < 4; k++) if (corners & (1 << k)) drawFloor(this.comp, this, g, tile, poolCornerSpriteId(k, s), sx, sy);
  }

  /** RenderStaticRow: upper-level floors and the objects standing on each tile. */
  private renderStaticRow(x0: number, y0: number, count: number, step: readonly [number, number], level: number, rp: RenderParam): void {
    const w = this.world;
    const s = this.scale;
    for (let k = 0; k < count; k++) {
      const x = x0 + step[0] * k;
      const y = y0 + step[1] * k;
      const base = this.tileToPoint(x, y, level, s, 0);
      if (this.isThumbnailHidden(...w2(w, x, y))) continue;
      const alt = w.getPackedAlt(x, y);
      rp.ambient = this.ambientAtTile(x, y, level);
      this.comp.ambient = rp.ambient;
      if (level >= 2) {
        const floor = w.getFloor(x, y, level);
        if (floor !== 0) this.drawTileFloor(x, y, level, floor, base.h - (8 << s), base.v - (alt[1] << (s + 1)));
      }
      if (level === 1) this.drawPoolTile(x, y, rp);
      if (this.objects && w.getTileObjectID(x, y, level) !== 0) this.objects.drawTileObjects(this, this.comp, x, y, level, rp);
    }
  }
}

/** World coordinates of a view tile. */
function w2(world: RotatableWorld, x: number, y: number): [number, number] {
  return world.toWorld(x, y);
}
