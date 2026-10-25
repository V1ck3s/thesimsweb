/**
 * cTerrain: draws the ground of one tile per call (HouseViewer::RenderTerrainRow
 * walks the screen rows top to bottom and calls draw for every tile). It owns
 * the grass renderer (cColorSwatch, +0x18), the grid overlay
 * (cOverlayRenderer, +0x10, only on tiles without a floor) and the map
 * overlay renderer (cMapTileSwatch, +0x14, not ported).
 */

import { ColorSwatch } from "./terrain_swatch.js";
import { TerrainRenderer, idiv, rgbaFrom16, type PackedAlt, type RenderParam, type TerrainTarget, type TileRect } from "./terrain_renderer.js";
import type { RotatableWorld } from "./world.js";

export type { TerrainTarget } from "./terrain_renderer.js";
export { timeOfDayForHour } from "./terrain_swatch.js";

/**
 * cLineRender16: dotted line along the tile's upper-left (edge bit 1) and
 * upper-right (edge bit 2) edges, written as color 0 (black) without z.
 */
class LineRender16 extends TerrainRenderer {
  /** +0x08: edge bits. */
  edges = 0;

  constructor(
    /** +0x04: pixel spacing of the dots. */
    readonly step: number,
  ) {
    super();
  }

  override init(): boolean {
    return true;
  }

  override draw(t: TerrainTarget, px: number, py: number, alt: PackedAlt, scale: number): void {
    this.lines(t, px, py, alt, scale, false);
  }

  override drawClipped(t: TerrainTarget, px: number, py: number, alt: PackedAlt, scale: number): void {
    this.lines(t, px, py, alt, scale, true);
  }

  private lines(t: TerrainTarget, px: number, py: number, alt: PackedAlt, scale: number, clipped: boolean): void {
    const half = 8 << scale;
    const s1 = scale + 1;
    const step = this.step;
    const yLeft = py - (alt[0]! << s1);
    const yTop = py - ((alt[1]! + 2) << s1);
    const black = rgbaFrom16(0);
    const put = (x: number, y: number): void => {
      if (clipped && (x < t.clip.left || t.clip.right <= x || y < t.clip.top || t.clip.bottom <= y)) return;
      if (x < 0 || y < 0 || x >= t.width || y >= t.height) return;
      t.color[y * t.width + x] = black;
    };
    // 16.16 fixed-point line from the left corner to the top corner.
    const slope = idiv((yTop - yLeft) * 0x10000, half);
    let acc = yLeft * 0x10000;
    let x = px + half;
    if (this.edges & 1) {
      for (x = px; x < px + half; x += step) {
        put(x, acc >> 16);
        acc += slope * step;
      }
    }
    // Then from the top corner to the right corner.
    const slope2 = idiv((py - (alt[2]! << s1) - yTop) * 0x10000, half);
    let acc2 = yTop * 0x10000;
    if (this.edges & 2) {
      for (; x < px + (16 << scale); x += step) {
        put(x, acc2 >> 16);
        acc2 += slope2 * step;
      }
    }
  }
}

/**
 * cOverlayRenderer: the build-mode grid. Tiles whose flags lack 0x20 get both
 * upper edges; flagged tiles only get the edges they share with unflagged
 * neighbours. Flat tiles use dots every 2 pixels, sloped ones every 4.
 */
class OverlayRenderer extends TerrainRenderer {
  private readonly sloped = new LineRender16(4);
  private readonly flat = new LineRender16(2);
  /** +0x0c: edge bits for the current tile. */
  private edges = 0;

  override init(): boolean {
    return true;
  }

  override predraw(_rp: RenderParam, world: RotatableWorld, x: number, y: number, _alt: PackedAlt): void {
    if ((world.getFlags(x, y, 1) & 0x20) === 0) {
      this.edges = 3;
    } else {
      this.edges = 0;
      if (0 < x && (world.getFlags(x - 1, y, 1) & 0x20) === 0) this.edges |= 1;
      if (0 < y && (world.getFlags(x, y - 1, 1) & 0x20) === 0) this.edges |= 2;
    }
  }

  private pick(alt: PackedAlt): LineRender16 {
    const a = alt[0];
    const r = a === alt[2] && a === alt[1] && a === alt[3] ? this.flat : this.sloped;
    r.edges = this.edges;
    return r;
  }

  override draw(t: TerrainTarget, px: number, py: number, alt: PackedAlt, scale: number): void {
    if (this.edges !== 0) this.pick(alt).draw(t, px, py, alt, scale);
  }

  override drawClipped(t: TerrainTarget, px: number, py: number, alt: PackedAlt, scale: number): void {
    if (this.edges !== 0) this.pick(alt).drawClipped(t, px, py, alt, scale);
  }
}

export class Terrain {
  /** +0x18: the grass renderer. */
  readonly swatch = new ColorSwatch();
  /** +0x10: the grid overlay. */
  private readonly overlay = new OverlayRenderer();
  /** +0x1c: grid overlay shown (CPState hides it in live mode, see ShowOverlay). */
  overlayVisible = true;
  /** +0x1d: skip the lot's border row of tiles. */
  interiorOnly = true;
  /** +0x1e: renderers need PreCompute before the next frame. */
  private dirty = true;
  /** +0x1f: debug toggle, draw only tiles whose corners differ by at most 5. */
  flatOnly = false;
  /**
   * ZBufferLookup::GetTerrainZ for a view tile (level 1) at a scale; the
   * renderer writes this + 0x50 as the depth of every terrain pixel of the
   * tile. Null writes 0xffff.
   */
  terrainZ: ((x: number, y: number, scale: number) => number) | null = null;

  private world: RotatableWorld | null = null;
  private rotation = -1;

  /** cTerrain::cTerrain: grass swatch at the default (high) quality, normal lot colors. */
  static create(): Terrain {
    return new Terrain();
  }

  /** ShowOverlay(bool). */
  showOverlay(on: boolean): void {
    this.overlayVisible = on;
  }

  /** SetHighQuality / SetMediumQuality / SetLowQuality: 2 / 1 / 0. */
  setQuality(level: number): void {
    this.swatch.setQualityLevel(level);
    this.dirty = true;
  }

  getQuality(): number {
    return this.swatch.getQualityLevel();
  }

  /**
   * cTerrain::SetColor: ground colors by house number (cSimulator+0x24) and
   * time of day (cSimulator+0x18, 0 = day).
   */
  setColor(houseNumber: number, timeOfDay: number): void {
    const n = houseNumber;
    const day = timeOfDay === 0;
    if ((0x1b < n && n < 0x1e) || (0x2d < n && n < 0x31)) this.swatch.makeSand(day);
    else if (0x27 < n && n < 0x2b) this.swatch.makeSnow(day);
    else if (((n - 0x5f) & 0xffff) < 2) this.swatch.makeLeaves();
    else if (0x59 < n && n < 0x5f) this.swatch.makeSoil();
    else if (n === 99) this.swatch.makeClouds();
    else this.swatch.makeDirt();
  }

  /** Command 0xdd (time of day changed): relight the terrain. */
  setLatitudeByTimeOfDay(timeOfDay: number): void {
    this.swatch.setLatitudeByTimeOfDay(timeOfDay);
  }

  /** Commands 0x84..0x86, 0x101, 0x105 (terrain, walls or view changed): PreCompute before the next draw. */
  markDirty(): void {
    this.dirty = true;
  }

  /** HouseViewer's per-frame check of +0x1e (also triggered by a new world or rotation). */
  private update(world: RotatableWorld): void {
    if (world !== this.world || world.rotation !== this.rotation) {
      this.world = world;
      this.rotation = world.rotation;
      this.dirty = true;
    }
    if (this.dirty || this.swatch.stale) {
      this.swatch.preCompute(world);
      this.overlay.preCompute(world);
      this.dirty = false;
    }
  }

  /**
   * cTerrain::Draw(RenderParam*, x, y, screenX, screenY, PackedAlt*, scale):
   * (x, y) view tile, (screenX, screenY) its top corner on screen at altitude
   * 0 of level 1, alt = getPackedAlt(x, y) ([left, top, right, bottom]).
   */
  draw(t: TerrainTarget, world: RotatableWorld, x: number, y: number, screenX: number, screenY: number, alt: readonly number[], scale: number): void {
    this.update(world);
    const rp: RenderParam = { scale, terrainZ: this.terrainZ };
    const withOverlay = this.overlayVisible && world.getFloor(x, y, 1) === 0;
    this.swatch.predraw(rp, world, x, y, alt);
    if (withOverlay) this.overlay.predraw(rp, world, x, y, alt);
    if (this.interiorOnly && !world.inInterior(x, y)) return;
    const [a0, a1, a2, a3] = [alt[0]!, alt[1]!, alt[2]!, alt[3]!];
    // Tiles whose bottom corner rises more than 5 above the top corner face away.
    if (a1 + 5 < a3) return;

    const s1 = scale + 1;
    const half = 8 << scale;
    const ys = [screenY - (a1 << s1), screenY - ((a2 - 2) << s1), screenY - ((a0 - 2) << s1), screenY - ((a3 - 4) << s1)];
    const r: TileRect = { left: screenX - half, top: Math.min(...ys), right: screenX + half, bottom: Math.max(...ys) };
    this.swatch.modifyTileRect(x, y, scale, r);
    if (withOverlay) {
      const o: TileRect = { left: screenX - half, top: Math.min(...ys), right: screenX + half, bottom: Math.max(...ys) };
      this.overlay.modifyTileRect(x, y, scale, o);
      r.left = Math.min(r.left, o.left);
      r.top = Math.min(r.top, o.top);
      r.right = Math.max(r.right, o.right);
      r.bottom = Math.max(r.bottom, o.bottom);
    }
    const clip = t.clip;
    if (!(clip.top < r.bottom && r.left < clip.right && clip.left < r.right && r.top < clip.bottom)) return;
    r.top -= ColorSwatch.grassHeight[scale - 1]!;
    const clipped = r.top < clip.top || clip.bottom < r.bottom || clip.right < r.right || r.left < clip.left;
    const px = screenX - half;
    const py = screenY + (4 << scale);
    if (this.flatOnly && (Math.abs(a1 - a0) > 5 || Math.abs(a1 - a2) > 5 || Math.abs(a3 - a0) > 5 || Math.abs(a3 - a2) > 5)) return;
    if (clipped) {
      this.swatch.drawClipped(t, px, py, alt, scale);
      if (withOverlay) this.overlay.drawClipped(t, px, py, alt, scale);
    } else {
      this.swatch.draw(t, px, py, alt, scale);
      if (withOverlay) this.overlay.draw(t, px, py, alt, scale);
    }
  }
}
