/**
 * cLevelDirtTool: Level Terrain (tool 4). Click and drag a rectangle of
 * tiles: every corner in it is brought to the altitude of the anchor corner
 * (the click tile's corner away from the drag), then ForceGrade smooths the
 * surroundings. Dragging previews (the change is applied, checked, then
 * undone; the rectangle is highlighted green or red); the release applies it
 * for real. Escape cancels the drag.
 *
 * Fields: +0x4c anchor corner (view tile), +0x50 / +0x54 the anchor and
 * opposite corner cursors (Terrain cursor graphics 3 and 4).
 */

import type { Compositor } from "../compositor.js";
import type { HouseViewer } from "../houseviewer.js";
import { OD } from "../objects.js";
import type { RenderParam } from "../renderparam.js";
import type { TilePt } from "../world.js";
import { DirtError, DirtTool, TerrainCursor, TerrainCursorGraphic } from "./dirttool.js";
import { PF, Placement } from "./placement.js";
import type { ToolEvent } from "./tool.js";

/** lbl_105BBD8C + 9 */
const SOUND_LEVEL = "Ui_terrain_level";
/** Cost of each multi-tile object part found in the rectangle (Apply). */
const MULTI_TILE_COST = 5;

export class LevelDirtTool extends DirtTool {
  /** +0x4c */
  private anchor: TilePt = { x: 0, y: 0, level: 0 };
  /** +0x50 / +0x54 */
  private anchorCursor: TerrainCursor | null = null;
  private cornerCursor: TerrainCursor | null = null;

  /** cLevelDirtTool::Select */
  override select(): void {
    super.select();
    this.cost = 0;
    if (!this.anchorCursor) this.anchorCursor = new TerrainCursor(this.host, TerrainCursorGraphic.levelAnchor);
    if (!this.cornerCursor) this.cornerCursor = new TerrainCursor(this.host, TerrainCursorGraphic.levelCorner);
  }

  /** cLevelDirtTool::Deselect */
  override deselect(): void {
    this.anchorCursor?.pickUp();
    this.anchorCursor = null;
    this.cornerCursor?.pickUp();
    this.cornerCursor = null;
    this.setHiliteArea({ x: -1, y: -1, level: 1 }, { x: -1, y: -1, level: 1 }, true);
    super.deselect();
  }

  /** cLevelDirtTool::Float: the tile under the mouse is highlighted. */
  override float(e: ToolEvent): void {
    super.float(e);
    this.setToolTip(null);
    const t: TilePt = { x: e.fx >> 4, y: e.fy >> 4, level: 1 };
    this.setHiliteArea(t, t, true);
  }

  /** cLevelDirtTool::Click: on the lot, cDirtTool::Click, the anchor, then a first Drag. */
  override click(e: ToolEvent): void {
    if (!this.inInterior(e.fx >> 4, e.fy >> 4)) return;
    super.click(e);
    if (this.released) return;
    this.updateAnchor(true);
    this.drag(e);
  }

  /** cLevelDirtTool::Drag: preview the rectangle from the click to the mouse. */
  override drag(e: ToolEvent): void {
    if (this.released) return;
    if (DirtTool.lastFx === e.fx && DirtTool.lastFy === e.fy) return;
    if (!this.inInterior(e.fx >> 4, e.fy >> 4)) return;
    DirtTool.lastFx = e.fx;
    DirtTool.lastFy = e.fy;
    this.updateAnchor(false);
    this.saveAltitudes();
    const a: TilePt = { x: DirtTool.clickFx >> 4, y: DirtTool.clickFy >> 4, level: 1 };
    const b: TilePt = { x: DirtTool.lastFx >> 4, y: DirtTool.lastFy >> 4, level: 1 };
    this.cost = 0;
    this.err = DirtError.none;
    let ok = this.apply(a, b);
    if (ok && this.host.getFunds() < this.cost) {
      this.setError(DirtError.noFunds, -1, -1, 1);
      ok = false;
    }
    this.setHiliteArea(a, b, ok);
    this.updateErrorMessage();
    this.restoreAltitudes();
  }

  /** cLevelDirtTool::Release: apply the rectangle for real. */
  override release(e: ToolEvent): void {
    if (this.released) return;
    this.err = DirtError.none;
    const before = this.saveAltitudes();
    const a: TilePt = { x: DirtTool.clickFx >> 4, y: DirtTool.clickFy >> 4, level: 1 };
    const b: TilePt = { x: DirtTool.lastFx >> 4, y: DirtTool.lastFy >> 4, level: 1 };
    this.cost = 0;
    let ok = this.apply(a, b);
    if (ok) {
      if (!this.canAfford(this.cost)) {
        this.setError(DirtError.noFunds, -1, -1, 1);
        ok = false;
      } else {
        this.purchase(this.cost);
        this.finalizePurchase();
      }
    }
    if (!ok) {
      this.cost = 0;
      this.restoreAltitudes();
      this.doDeniedSound();
    } else {
      this.finalizeChanges(before);
      this.terrainChanged();
      this.host.playSound(SOUND_LEVEL);
    }
    this.anchorCursor?.pickUp();
    this.cornerCursor?.pickUp();
    super.release(e);
    this.updateErrorMessage();
  }

  /** cLevelDirtTool::OnKeyDown: Escape drops the drag. */
  override onKeyDown(key: string): boolean {
    if (key !== "Escape") return false;
    this.setHiliteArea({ x: -1, y: -1, level: 1 }, { x: -1, y: -1, level: 1 }, true);
    this.released = true;
    this.runningTotal = 0;
    this.err = DirtError.none;
    this.resetErrorShown();
    this.updateErrorMessage();
    this.anchorCursor?.pickUp();
    this.cornerCursor?.pickUp();
    return true;
  }

  override drawOverlay(viewer: HouseViewer, comp: Compositor, rp: RenderParam): void {
    this.anchorCursor?.draw(viewer, comp, rp);
    this.cornerCursor?.draw(viewer, comp, rp);
    super.drawOverlay(viewer, comp, rp);
  }

  /**
   * cLevelDirtTool::UpdateAnchor(atClick): the anchor is the click tile's
   * corner on the far side from the mouse (+1 on each axis the mouse went
   * below the click), the other cursor the opposite corner of the mouse tile.
   */
  private updateAnchor(atClick: boolean): void {
    let cx = DirtTool.lastFx;
    let cy = DirtTool.lastFy;
    const ax = DirtTool.clickFx;
    const ay = DirtTool.clickFy;
    const corner: TilePt = { x: cx >> 4, y: cy >> 4, level: 1 };
    if (atClick) {
      cx = ax;
      cy = ay;
    }
    this.anchor = { x: ax >> 4, y: ay >> 4, level: 1 };
    if (cx < ax) {
      this.anchor.x++;
      if (cy < ay) this.anchor.y++;
      else corner.y++;
    } else if (cy < ay) {
      this.anchor.y++;
      corner.x++;
    } else {
      corner.x++;
      corner.y++;
    }
    const level = this.currentLevel();
    DirtTool.placeTerrainCursor(this.host, this.anchorCursor, this.anchor.x, this.anchor.y, level);
    DirtTool.placeTerrainCursor(this.host, this.cornerCursor, corner.x, corner.y, level);
  }

  /**
   * cLevelDirtTool::Apply(a, b): every corner of the tiles from a to b takes
   * the anchor corner's altitude. A corner that moves must be free
   * (MayModifyTerrain without objects); the tiles just outside the
   * rectangle's low sides and the corners on its high sides must hold no
   * object needing flat ground (error 1); a multi-tile object inside must lie
   * wholly inside (error 5). Each unit moved costs the altitude price, each
   * multi-tile object part met 5.
   */
  private apply(a: TilePt, b: TilePt): boolean {
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    const target = this.topAlt(this.anchor.x, this.anchor.y);
    const price = this.altPrice();
    const w = this.world;
    const p = this.host.placement;
    let fail = false;
    const flatAt = (x: number, y: number): boolean => {
      if (!this.inInterior(x, y) || !this.hasFlatObjects({ x, y, level: 1 })) return true;
      this.setError(DirtError.cannotModify, x, y, 1);
      return false;
    };
    for (let x = x0; x <= x1 + 1 && !fail; x++) {
      for (let y = y0; y <= y1 + 1 && !fail; y++) {
        if (!this.inInterior(x, y)) continue;
        const alt = this.topAlt(x, y);
        if (alt === target) continue;
        if (!this.mayModifyTerrain({ x, y, level: 1 }, false)) {
          fail = true;
          continue;
        }
        if (x === x0 && !flatAt(x - 1, y)) fail = true;
        if (y === y0 && !flatAt(x, y - 1)) fail = true;
        if (y === y0 && x === x0 && !flatAt(x - 1, y - 1)) fail = true;
        if ((x === x1 + 1 || y === y1 + 1) && !flatAt(x, y)) fail = true;
        if (!fail && x < x1 + 1 && y < y1 + 1) {
          const [wx, wy] = w.toWorld(x, y);
          for (const o of p.tileObjects(wx, wy, 1)) {
            if (fail) break;
            if (!p.isMultiTile(o) || Placement.od(o, OD.placementFlags) & PF.onSlope) continue;
            this.cost += MULTI_TILE_COST;
            for (const part of p.chain(o)) {
              const [px, py] = w.toView(part.tileX, part.tileY);
              if (px < x0 || x1 + 1 <= px || py < y0 || y1 + 1 <= py) {
                this.setError(DirtError.multiTile, px, py, part.level);
                fail = true;
                break;
              }
            }
          }
        }
        if (!fail) {
          this.cost += price * Math.abs(alt - target);
          this.setTopAlt({ x, y, level: 1 }, target);
        }
      }
    }
    if (!fail && !this.forceGrade(x0, y0, x1 + 1, y1 + 1)) fail = true;
    return !fail;
  }
}
