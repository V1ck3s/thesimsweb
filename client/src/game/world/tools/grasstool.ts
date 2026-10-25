/**
 * cGrassTool: Grass (tool 11, Hot Date). Click or drag over tiles to add
 * grass: the tile's target grass and grass both move by +0x2c (10; -50
 * while Ctrl is held, 50 once it is released), clamped to a signed char. Free
 * and not undoable.
 *
 * Fields: +0x2c amount, +0x30 the tile under the mouse, +0x38 1 when that
 * tile is set, +0x44 the cursor (Terrain cursor graphic 3).
 */

import type { Compositor } from "../compositor.js";
import type { HouseViewer } from "../houseviewer.js";
import type { RenderParam } from "../renderparam.js";
import type { TilePt } from "../world.js";
import { DirtTool, TerrainCursor, TerrainCursorGraphic } from "./dirttool.js";
import { Tool, type ToolEvent } from "./tool.js";

export class GrassTool extends Tool {
  /** +0x2c */
  private amount = 10;
  /** +0x30 / +0x38 */
  private tile: TilePt = { x: 0, y: 0, level: 0 };
  private hasTile = false;
  /** +0x44 */
  private cursor: TerrainCursor | null = null;

  /** cGrassTool::Select (+ cTool::SetCursor(0)). */
  override select(): void {
    this.hasTile = false;
    if (!this.cursor) this.cursor = new TerrainCursor(this.host, TerrainCursorGraphic.levelAnchor);
  }

  /** cGrassTool::Deselect */
  override deselect(): void {
    this.cursor?.pickUp();
    this.cursor = null;
  }

  /** cGrassTool::SetParameter (+ XViewer::IssueWorldDirty). */
  override setParameter(_p: number): void {
    this.amount = 10;
    this.host.invalidate();
  }

  /** cGrassTool::OnKeyDown: Ctrl removes grass. */
  override onKeyDown(key: string): boolean {
    if (key === "Control") this.amount = -50;
    return false;
  }

  /** cGrassTool::OnKeyUp */
  override onKeyUp(key: string): boolean {
    if (key === "Control") this.amount = 50;
    return false;
  }

  /** cGrassTool::Float: the cursor on the tile's corner; the tile is remembered. */
  override float(e: ToolEvent): void {
    const x = e.fx >> 4;
    const y = e.fy >> 4;
    if (this.cursor) DirtTool.placeTerrainCursor(this.host, this.cursor, x, y, this.currentLevel());
    if (this.hasTile) {
      if (x === this.tile.x && y === this.tile.y && this.tile.level === 1) return;
      this.hasTile = false;
    }
    if (this.host.world.inInterior(x, y)) {
      this.hasTile = true;
      this.tile = { x, y, level: 1 };
    }
  }

  /** cGrassTool::Click */
  override click(e: ToolEvent): void {
    this.float(e);
    this.bumpGrass(e, this.amount);
  }

  /** cGrassTool::Drag */
  override drag(e: ToolEvent): void {
    this.float(e);
    this.bumpGrass(e, this.amount);
  }

  override drawOverlay(viewer: HouseViewer, comp: Compositor, rp: RenderParam): void {
    this.cursor?.draw(viewer, comp, rp);
  }

  /** cGrassTool::BumpGrass(FTilePt, amount) */
  private bumpGrass(e: ToolEvent, amount: number): void {
    const w = this.host.world;
    const x = e.fx >> 4;
    const y = e.fy >> 4;
    if (!w.inInterior(x, y)) {
      this.doDeniedSound();
      return;
    }
    const v = Math.max(-0x80, Math.min(0x7f, w.getTargetGrass(x, y) + amount));
    w.setTargetGrass(x, y, v);
    w.setGrass(x, y, v);
    // cTool::DirtyTile
    this.host.dirty.terrain();
  }
}
