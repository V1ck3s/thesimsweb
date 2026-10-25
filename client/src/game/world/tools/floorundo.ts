/**
 * FloorUndoable: the floor tiles one cNewFloorTool gesture changed (a
 * vector of FloorChange, 0x3c bytes each), in world coordinates.
 *
 * The tool changes the world as it goes (the hover preview included) and
 * records each tile's previous state here first (AddChange, once per tile;
 * a tile changed again only adds to its cost). UndoOne swaps a change with
 * the world, so UndoSelf (reverse order, Refund) and RedoSelf (Purchase)
 * are the same walk. UndoSelf also takes the preview back off the world.
 * CommitSelf is Undoable's (nothing to do: the changes are in the world).
 */

import type { TileWalls } from "../tilewalls.js";
import { getWall } from "../tilewalls.js";
import type { RotatableWorld } from "../world.js";
import { UndoState, Undoable } from "./undo.js";
import { copyWalls, fixedSetWall, getPool, setFixedFloor, setPool, type RotWalls } from "./worldedit.js";

/** FloorChange. */
export interface FloorChange {
  /** +0x00: world tile and level. */
  x: number;
  y: number;
  level: number;
  /** +0x04: the tile's walls (diagonal floor halves) when +0x38. */
  walls: RotWalls | null;
  /** +0x30: what the change cost (refunded on undo). */
  cost: number;
  /** +0x34: the floor pattern. */
  pattern: number;
  /** +0x38: the walls are part of the change. */
  hasWalls: boolean;
  /** +0x39: the tile was pool deck (pool layer 0x10). */
  deck: boolean;
}

/** What FloorUndoable needs from its tool (+0x30). */
export interface FloorUndoTool {
  purchase(n: number): void;
  refund(n: number): void;
  finalizePurchase(): void;
  /** lbl_105BA4B8: floors changed since the last room recomputation. */
  floorsChanged: boolean;
  /** GViewer::DirtyFloor. */
  dirtyFloor(): void;
}

export class FloorUndoable extends Undoable {
  /** +0x24 */
  readonly changes: FloorChange[] = [];

  constructor(
    private readonly world: RotatableWorld,
    /** +0x30 */
    private readonly tool: FloorUndoTool,
  ) {
    super();
  }

  /** FloorUndoable::AddChange(CTilePt, FloorPattern, bool, int) (view tile). */
  addChange(x: number, y: number, level: number, pattern: number, deck: boolean, cost: number): void {
    const [wx, wy] = this.world.toWorld(x, y);
    const c = this.find(wx, wy, level);
    if (c) {
      c.cost += cost;
      return;
    }
    this.changes.push({ x: wx, y: wy, level, walls: null, cost, pattern, hasWalls: false, deck });
  }

  /** FloorUndoable::AddChange(CTilePt, FloorPattern, TileWalls const &, bool, int) (view tile). */
  addChangeWithWalls(x: number, y: number, level: number, pattern: number, walls: RotWalls, deck: boolean, cost: number): void {
    const [wx, wy] = this.world.toWorld(x, y);
    const w: RotWalls = { t: copyWalls(walls.t), rot: walls.rot };
    const c = this.find(wx, wy, level);
    if (c) {
      c.cost += cost;
      if (!c.hasWalls) {
        c.hasWalls = true;
        c.walls = w;
      }
      return;
    }
    this.changes.push({ x: wx, y: wy, level, walls: w, cost, pattern, hasWalls: true, deck });
  }

  private find(x: number, y: number, level: number): FloorChange | undefined {
    return this.changes.find((c) => c.x === x && c.y === y && c.level === level);
  }

  /** The vector's clear(). */
  clear(): void {
    this.changes.length = 0;
  }

  /** FloorUndoable::UndoOne: swap the change with the world. */
  private undoOne(c: FloorChange): void {
    const fixed = this.world.fixed;
    const floor = fixed.floors[c.level - 1]!.u16(c.x, c.y);
    let walls: TileWalls | null = null;
    if (c.hasWalls) walls = getWall(fixed, c.x, c.y, c.level);
    const deck = getPool(fixed, c.x, c.y) === 0x10;
    setFixedFloor(fixed, c.x, c.y, c.level, c.pattern);
    if (c.hasWalls && c.walls) fixedSetWall(fixed, c.x, c.y, c.level, c.walls);
    if (c.deck) setPool(fixed, c.x, c.y, 0x10);
    if (!fixed.outOfGrid(c.x, c.y)) this.tool.dirtyFloor();
    c.walls = walls ? { t: walls, rot: 0 } : null;
    c.pattern = floor;
    c.deck = deck;
  }

  /** FloorUndoable::RedoSelf. */
  protected override redoSelf(): number {
    for (const c of this.changes) {
      this.undoOne(c);
      this.tool.purchase(c.cost);
    }
    if (this.getState() !== UndoState.New) {
      this.tool.finalizePurchase();
      this.tool.floorsChanged = true;
    }
    return 0;
  }

  /** FloorUndoable::UndoSelf (also takes the tool's preview back). */
  override undoSelf(): number {
    for (let i = this.changes.length - 1; i >= 0; i--) {
      const c = this.changes[i]!;
      this.undoOne(c);
      this.tool.refund(c.cost);
    }
    if (this.getState() !== UndoState.New) {
      this.tool.finalizePurchase();
      this.tool.floorsChanged = true;
    }
    return 0;
  }

  /** Undoable::CommitSelf. */
  protected commitSelf(): number {
    return 0;
  }
}
