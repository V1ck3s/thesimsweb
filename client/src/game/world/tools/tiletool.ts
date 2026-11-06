/**
 * cTileTool (cGameTools tool 8): the "map_edit on" cheat tool. It paints the
 * ground floor tiles' 0x20 flag, the one that keeps a tile out of the editable
 * lot (the build tools refuse it, the build-mode grid leaves it out).
 *
 * A click on a tile of the lot's interior lifts the flag layer (LiftGrid: a
 * 64 x 64 copy of every ground tile's flags & 0x20) and picks the value to
 * paint: set when the clicked tile's flag is clear, clear when it is set.
 * Dragging paints each tile met; with Shift held at the click the tile tool
 * paints the rectangle between the clicked tile and the mouse instead (the
 * lifted layer is put back first, DropGrid). Ctrl held at the release puts the
 * lifted layer back: the stroke is undone.
 *
 * DropGrid writes the lifted byte (flags & 0x20 only) over every tile whose
 * flags differ from it, so the tile's other flag bits are cleared on those
 * tiles; that is what the original does.
 *
 * Parameter (+0x2c): low 4 bits the mode (0 flags; 1 grass, set by the
 * "edit_grass n" cheat as n * 16 + 1), the rest (>> 4) the grass amount. In
 * grass mode Click and Drag call the global BumpGrass at the mouse's tile
 * (no interior check, unlike cGrassTool's): its target grass and grass become
 * target + amount, clamped to -128..127; Release does nothing. Fields: +0x30 the
 * tile under the mouse (Float) and the click's anchor, +0x33 the tile dragged
 * over, +0x38 the state (0 none, 1 a tile is under the mouse, 2 painting, 3
 * painting a rectangle), +0x3c the lifted layer, +0x40 the value painted.
 *
 * Float is the Windows build's (Float__9cTileTool); the rest is from the Mac
 * build. The Mac EventRecord's shiftKey (0x200) / controlKey (0x1000) are the
 * event's Shift / Ctrl.
 */

import type { TilePt } from "../world.js";
import { Tool, type ToolEvent } from "./tool.js";

/** The flag the tool paints (not part of the editable lot). */
const FLAG_NOT_EDITABLE = 0x20;
/** _c2DArray(1, 0x40, 0x40): the lifted layer's size. */
const GRID_SIZE = 0x40;

export class TileTool extends Tool {
  /** +0x2c */
  private param = 0;
  /** +0x30 */
  private tile: TilePt = { x: 0, y: 0, level: 0 };
  /** +0x33 */
  private dragTile: TilePt = { x: 0, y: 0, level: 0 };
  /** +0x38 */
  private state = 0;
  /** +0x3c: flags & 0x20 of each ground tile (world coordinates), [x * GRID_SIZE + y]. */
  private grid: Uint8Array | null = null;
  /** +0x40 */
  private value = 0;

  /** cTileTool::Select */
  override select(): void {
    this.state = 0;
    this.showCursor(0);
  }

  /** cTileTool::SetParameter (+ XViewer::IssueWorldDirty). */
  override setParameter(p: number): void {
    this.param = p << 16 >> 16;
    this.host.invalidate();
  }

  /** Float__9cTileTool: remembers the tile under the mouse when it is inside the lot. */
  override float(e: ToolEvent): void {
    const x = e.fx >> 4;
    const y = e.fy >> 4;
    if (this.state === 1) {
      if (x === this.tile.x && y === this.tile.y && this.tile.level === 1) return;
      this.state = 0;
    }
    if (this.host.world.inInterior(x, y)) {
      this.state = 1;
      this.tile = { x, y, level: 1 };
    }
  }

  /** cTileTool::Click */
  override click(e: ToolEvent): void {
    this.float(e);
    if ((this.param & 0xf) === 1) {
      this.bumpGrass(e, this.param >> 4);
      return;
    }
    if (this.state === 0) {
      this.doDeniedSound();
      return;
    }
    this.liftGrid();
    this.value = (this.host.world.getFlags(this.tile.x, this.tile.y, this.tile.level) & FLAG_NOT_EDITABLE) === 0 ? 1 : 0;
    this.state = (e.shift ? 1 : 0) + 2;
    this.dragTile = { ...this.tile };
    if ((this.param & 0xf) === 0) this.setBit(this.dragTile, this.value);
  }

  /** cTileTool::Drag */
  override drag(e: ToolEvent): void {
    if ((this.param & 0xf) === 1) {
      this.bumpGrass(e, this.param >> 4);
      return;
    }
    if (this.state !== 2 && this.state !== 3) return;
    const x = e.fx >> 4;
    const y = e.fy >> 4;
    if (x === this.dragTile.x && y === this.dragTile.y && this.dragTile.level === 1) return;
    if (!this.host.world.inInterior(x, y)) return;
    this.dragTile = { x, y, level: 1 };
    if (this.state === 3) {
      this.dropGrid();
      const x0 = Math.min(this.tile.x, x);
      const x1 = Math.max(this.tile.x, x);
      const y0 = Math.min(this.tile.y, y);
      const y1 = Math.max(this.tile.y, y);
      for (let i = x0; i <= x1; i++) for (let j = y0; j <= y1; j++) this.setBit({ x: i, y: j, level: 1 }, this.value);
    } else {
      this.setBit(this.dragTile, this.value);
    }
  }

  /** cTileTool::Release: Ctrl puts the lifted layer back. */
  override release(e: ToolEvent): void {
    if ((this.param & 0xf) === 1) return;
    if ((this.state === 2 || this.state === 3) && e.ctrl) this.dropGrid();
    this.state = 0;
  }

  /**
   * BumpGrass(FTilePt &, int): the ground tile under the mouse gets target
   * grass + amount (clamped to a signed char) as both its target grass and
   * its grass, then cTool::DirtyTile. Deviation: tiles outside the world's
   * arrays are skipped (the original writes without a check).
   */
  private bumpGrass(e: ToolEvent, amount: number): void {
    const w = this.host.world;
    const x = e.fx >> 4;
    const y = e.fy >> 4;
    const size = this.host.fixed.size;
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const v = Math.max(-0x80, Math.min(0x7f, w.getTargetGrass(x, y) + amount));
    w.setTargetGrass(x, y, v);
    w.setGrass(x, y, v);
    this.host.dirty.terrain();
  }

  /** cTileTool::LiftGrid: a copy of every ground tile's flag 0x20. */
  private liftGrid(): void {
    const flags = this.host.fixed.flags[0]!;
    const size = this.host.fixed.size;
    this.grid ??= new Uint8Array(GRID_SIZE * GRID_SIZE);
    if (size > GRID_SIZE) return;
    for (let i = 0; i < size; i++) for (let j = 0; j < size; j++) this.grid[i * GRID_SIZE + j] = flags.u8(i, j) & FLAG_NOT_EDITABLE;
  }

  /** cTileTool::DropGrid: the lifted bytes back over the tiles whose flags differ (cTool::DirtyTile each). */
  private dropGrid(): void {
    const grid = this.grid;
    const flags = this.host.fixed.flags[0]!;
    const size = this.host.fixed.size;
    if (!grid || size !== GRID_SIZE) return;
    let changed = false;
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        const v = grid[i * GRID_SIZE + j]!;
        const o = flags.offset(i, j);
        if (flags.data[o] === v) continue;
        flags.data[o] = v;
        changed = true;
      }
    }
    if (changed) this.host.invalidate();
  }

  /** cTileTool::SetBit(tile, on): the tile's flag 0x20 set or cleared (cTool::DirtyTile when it changed). */
  private setBit(t: TilePt, on: number): void {
    const f = this.host.world.getFlags(t.x, t.y, t.level);
    let v = f;
    if (on === 0) {
      if (f & FLAG_NOT_EDITABLE) v = f & 0xdf;
    } else if (!(f & FLAG_NOT_EDITABLE)) v = f | FLAG_NOT_EDITABLE;
    if (v === f) return;
    const [wx, wy] = this.host.world.toWorld(t.x, t.y);
    const flags = this.host.fixed.flags[t.level - 1]!;
    flags.data[flags.offset(wx, wy)] = v;
    this.host.invalidate();
  }
}
