/**
 * TerrainUndoable: the terrain tools' undo record. TakeSnapshot (at the
 * click) copies the whole altitude (PackedAlt) and grass arrays; Undo and
 * Redo swap the tiles that differ between the snapshot and the world, so the
 * snapshot always holds the other state. The cost (SetCost, the drag's
 * total) is refunded on undo and charged again on redo through the tool.
 *
 * Fields: +0x24 cost, +0x28 the tool, +0x2c PackedAlt[64][64],
 * +0x402c grass (one int per tile).
 */

import type { FixedWorld } from "../world.js";
import type { Tool, ToolHost } from "./tool.js";
import { Undoable } from "./undo.js";

export class TerrainUndoable extends Undoable {
  /** +0x24 */
  private cost = 0;
  /** +0x2c (4 bytes per world tile) and +0x402c (grass, signed). */
  private readonly alt: Uint8Array;
  private readonly grass: Int8Array;

  constructor(
    /** +0x28 */
    private readonly tool: Tool,
    private readonly host: ToolHost,
  ) {
    super();
    const n = host.fixed.size;
    this.alt = new Uint8Array(n * n * 4);
    this.grass = new Int8Array(n * n);
  }

  private get fixed(): FixedWorld {
    return this.host.fixed;
  }

  /** TerrainUndoable::SetCost */
  setCost(n: number): void {
    this.cost = n;
  }

  /** TerrainUndoable::TakeSnapshot */
  takeSnapshot(): void {
    const f = this.fixed;
    const n = f.size;
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) {
        const o = f.alt.offset(x, y);
        this.alt.set(f.alt.data.subarray(o, o + 4), (x * n + y) * 4);
        this.grass[x * n + y] = f.grass.s8(x, y);
      }
    }
    this.cost = 0;
  }

  /** CommitSelf__8UndoableFv: the change is already made. */
  protected commitSelf(): number {
    return 0;
  }

  /** TerrainUndoable::RedoSelf */
  protected override redoSelf(): number {
    this.undoRedo();
    this.tool.purchase(this.cost);
    if (this.getState() !== 0) this.tool.finalizePurchase();
    return 0;
  }

  /** TerrainUndoable::UndoSelf */
  protected undoSelf(): number {
    this.undoRedo();
    this.tool.refund(this.cost);
    if (this.getState() !== 0) this.tool.finalizePurchase();
    return 0;
  }

  /** TerrainUndoable::UndoRedo: swap every tile that differs, then GlobalDispatch(0x85). */
  private undoRedo(): void {
    const f = this.fixed;
    const n = f.size;
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) {
        const o = f.alt.offset(x, y);
        const s = (x * n + y) * 4;
        let diff = false;
        for (let k = 0; k < 4; k++) if (f.alt.data[o + k] !== this.alt[s + k]) diff = true;
        if (diff) {
          for (let k = 0; k < 4; k++) {
            const t = f.alt.data[o + k]!;
            f.alt.data[o + k] = this.alt[s + k]!;
            this.alt[s + k] = t;
          }
        }
        const g = f.grass.s8(x, y);
        if (g !== this.grass[x * n + y]) {
          f.grass.data[f.grass.offset(x, y)] = this.grass[x * n + y]! & 0xff;
          this.grass[x * n + y] = g;
        }
      }
    }
    // DirtyTileNeighborhood on each changed tile, then GlobalDispatch(0x85) (terrain changed).
    this.host.dirty.terrain();
  }
}
