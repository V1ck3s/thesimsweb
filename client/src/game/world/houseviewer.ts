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

import type { Compositor } from "./compositor.js";
import { drawFloor, type FloorGraphicsMgr } from "./floors.js";
import { RenderParam } from "./renderparam.js";
import { DIRS, RotatableWorld } from "./world.js";
import { LEVEL_PX, makeZSpriteLookup, ZBufferLookup } from "./zbuffer.js";

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
  private target: TerrainTarget;
  terrain: TerrainDrawer | null = null;
  walls: WallDrawer | null = null;
  objects: ObjectDrawer | null = null;
  /** Room lighting (lighting.ts): RoomManager::GetRoomAmbientLight; null = full light. */
  lighting: { getRoomAmbientLight(fx: number, fy: number, level: number): number; clampAmbient(level: number): number } | null = null;
  /** HouseViewer's dynamic cutaway (cutaway.ts), told about scale / rotation / level changes. */
  cutawayCtl: { onScale(): void; onRotation(): void; onLevel(old: number): void } | null = null;
  /** People (3D meshes), drawn after the dynamic objects with the shared depth buffer. */
  people: { draw(viewer: HouseViewer): void } | null = null;
  /** HouseViewer::RenderCursorObject: the buy / build tool's cursor object, drawn after the dynamic objects. */
  cursor: { draw(viewer: HouseViewer, comp: Compositor, rp: RenderParam): void } | null = null;
  /** XSmoothScroller state. */
  private scroll: { fromX: number; fromY: number; toX: number; toY: number; start: number; dur: number } | null = null;
  dirty = true;

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

  /** HouseViewer::GetOffsetsMinMax: allowed origin range. */
  getOffsetsMinMax(): { minX: number; maxX: number; minY: number; maxY: number } {
    const s = this.scale;
    const w = this.world;
    const n = w.size - 2;
    const tileW = 16 << s;
    const span = tileW * n;
    let minX: number;
    let maxX: number;
    if (this.viewW < span) {
      minX = Math.trunc(-span / 2) + this.viewW - (8 << s);
      maxX = Math.trunc(span / 2) + tileW;
    } else {
      minX = maxX = Math.trunc(this.viewW / 2);
    }
    let top = 0;
    for (let k = 1, x = w.minX + 1, y = w.minY + 1; k < n + 1; k++, x++, y++) {
      top = Math.max(top, (this.maxAlts[x + y]! << (s + 1)) - (4 << s) * k);
    }
    let maxY = top + this.levelPx() * 2;
    let minY = this.viewH - (8 << s) * n - (8 << s) * 2;
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
    return { minX, maxX, minY, maxY };
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
    const c = CLEAR_COLOR;
    comp.clear((c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff);
    const rp = new RenderParam(this, this.zLookupIndex);
    // Terrain + ground floors (RenderStatic(level 1, terrain pass)).
    this.target.color.fill(0xff000000 | ((c & 0xff) << 16) | (c & 0xff00) | ((c >> 16) & 0xff));
    this.target.depth.fill(0xffff);
    this.renderStatic(1, true, rp);
    for (let l = 1; l <= this.level; l++) {
      this.walls?.drawWalls(this, comp, l, rp);
      this.renderStatic(l, false, rp);
    }
    this.objects?.drawDynamicObjects?.(this, comp, rp);
    comp.ambient = 1;
    this.cursor?.draw(this, comp, rp);
    this.people?.draw(this);
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
      for (const r of rows) {
        const top = this.tileToPoint(r.x, r.y, level, s, 0).v;
        if (top - margin > this.viewH || top + tileH < 0) continue;
        this.renderTerrainRow(r.x, r.y, r.count, step, level, rp);
      }
      this.comp.drawRaw(this.target.color, this.target.depth);
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
      if (floor === 0) continue;
      this.comp.ambient = this.ambientAtTile(x, y, 1);
      if (w.getWallStorage(x, y, 1).segs !== 0 && isDiagonal(w, x, y, 1)) continue; // diagonal floor halves: not ported
      const g = this.floors.getFloorGraphic(floor, s);
      if (g) drawFloor(this.comp, this, g.renderer, { x, y, level: 1 }, g.id, fx, fy);
    }
    void rp;
  }

  /** RenderStaticRow: upper-level floors and the objects standing on each tile. */
  private renderStaticRow(x0: number, y0: number, count: number, step: readonly [number, number], level: number, rp: RenderParam): void {
    const w = this.world;
    const s = this.scale;
    for (let k = 0; k < count; k++) {
      const x = x0 + step[0] * k;
      const y = y0 + step[1] * k;
      const base = this.tileToPoint(x, y, level, s, 0);
      const alt = w.getPackedAlt(x, y);
      rp.ambient = this.ambientAtTile(x, y, level);
      this.comp.ambient = rp.ambient;
      if (level >= 2) {
        const floor = w.getFloor(x, y, level);
        if (floor !== 0 && !(w.getWallStorage(x, y, level).segs !== 0 && isDiagonal(w, x, y, level))) {
          const g = this.floors.getFloorGraphic(floor, s);
          if (g) drawFloor(this.comp, this, g.renderer, { x, y, level }, g.id, base.h - (8 << s), base.v - (alt[1] << (s + 1)));
        }
      }
      if (this.objects && w.getTileObjectID(x, y, level) !== 0) this.objects.drawTileObjects(this, this.comp, x, y, level, rp);
    }
  }
}

/** World coordinates of a view tile. */
function w2(world: RotatableWorld, x: number, y: number): [number, number] {
  return world.toWorld(x, y);
}

/** TileWalls diagonal bits (0x10 / 0x20 of the first wall byte, cRotatableWorld::GetWall). */
function isDiagonal(world: RotatableWorld, x: number, y: number, level: number): boolean {
  return (world.getWallStorage(x, y, level).segs & 0x30) !== 0;
}
