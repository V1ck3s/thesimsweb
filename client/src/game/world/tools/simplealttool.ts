/**
 * cSimpleAltTool: Raise Terrain (tool 0, +0x50 = 1) and Lower Terrain
 * (tool 1, +0x50 = -1). A click moves the corner under the mouse by one unit
 * (Shift reverses the direction; Ctrl smooths: seven random corners nearby
 * are pulled toward their neighbors' average). Holding the button repeats:
 * the first repeat 400 ms after the click, then every 100 ms of dragging.
 * Every change is paid at once (one altitude price per unit, ForceGrade's
 * pulls included); the drag's total is the TerrainUndoable's cost.
 *
 * Fields: +0x4c the arrow cursor (Terrain cursor graphic 0 raise / 1 lower),
 * +0x50 direction, +0x54 direction with Shift, +0x58 next repeat time,
 * +0x5c Shift, +0x5d Ctrl.
 */

import type { Compositor } from "../compositor.js";
import type { HouseViewer } from "../houseviewer.js";
import { sgsRand } from "../random.js";
import type { RenderParam } from "../renderparam.js";
import type { TilePt } from "../world.js";
import { DirtError, DirtTool, GRADE_NEIGHBORS, MAX_ALT, TerrainCursor, TerrainCursorGraphic } from "./dirttool.js";
import type { ToolEvent, ToolHost } from "./tool.js";

/** lbl_105BBE54 + 9 / + 0x1a: cSoundPlayer::PlayBySource events. */
const SOUND_RAISE = "Ui_terrain_raise";
const SOUND_LOWER = "Ui_terrain_lower";

export class SimpleAltTool extends DirtTool {
  /** +0x4c */
  private arrow: TerrainCursor | null = null;
  /** +0x54 */
  private delta = 0;
  /** +0x58 */
  private nextTime = 0;
  /** +0x5c / +0x5d */
  private shift = false;
  private ctrl = false;

  constructor(
    host: ToolHost,
    /** +0x50 */
    private readonly direction: number,
  ) {
    super(host);
  }

  /** RapidFire__14cSimpleAltToolFv: every mouse move while the button is down is a Drag. */
  override rapidFire(): boolean {
    return true;
  }

  /** cSimpleAltTool::Select */
  override select(): void {
    super.select();
    if (!this.arrow) this.arrow = new TerrainCursor(this.host, TerrainCursorGraphic.raise);
  }

  /** cSimpleAltTool::Deselect */
  override deselect(): void {
    this.arrow?.pickUp();
    this.arrow = null;
    super.deselect();
  }

  /** cSimpleAltTool::Float: the arrow follows the mouse and points the way a click would go. */
  override float(e: ToolEvent): void {
    super.float(e);
    this.setToolTip(null);
    this.readKeys(e);
    this.placeArrow(e);
  }

  /** cSimpleAltTool::Click */
  override click(e: ToolEvent): void {
    super.click(e);
    if (this.released) return;
    const x = e.fx >> 4;
    const y = e.fy >> 4;
    if (!this.inInterior(x, y)) return;
    this.readKeys(e);
    this.placeArrow(e);
    this.cost = 0;
    this.apply({ x, y, level: 1 });
    this.nextTime = performance.now() + 400;
  }

  /** cSimpleAltTool::Drag: repeats every 100 ms. */
  override drag(e: ToolEvent): void {
    if (this.released || performance.now() < this.nextTime) return;
    const x = e.fx >> 4;
    const y = e.fy >> 4;
    if (!this.inInterior(x, y)) return;
    DirtTool.lastFx = e.fx;
    DirtTool.lastFy = e.fy;
    this.readKeys(e);
    this.placeArrow(e);
    this.apply({ x, y, level: 1 });
    this.nextTime = performance.now() + 100;
  }

  /** cSimpleAltTool::Release: the red cursor goes, then cDirtTool::Release. */
  override release(e: ToolEvent): void {
    this.errorCursorPickUp();
    super.release(e);
  }

  override drawOverlay(viewer: HouseViewer, comp: Compositor, rp: RenderParam): void {
    this.arrow?.draw(viewer, comp, rp);
    super.drawOverlay(viewer, comp, rp);
  }

  /** _GetKeyState(VK_SHIFT / VK_CONTROL), the direction and the arrow's graphic (+ SetToolCursor(0)). */
  private readKeys(e: ToolEvent): void {
    this.shift = e.shift;
    this.ctrl = e.ctrl;
    this.delta = this.direction * (this.shift ? -1 : 1);
    this.arrow?.setGraphic(this.delta < 1 ? TerrainCursorGraphic.lower : TerrainCursorGraphic.raise);
  }

  private placeArrow(e: ToolEvent): void {
    DirtTool.placeTerrainCursor(this.host, this.arrow, e.fx >> 4, e.fy >> 4, this.currentLevel());
  }

  /** cSimpleAltTool::Apply(vertex) */
  private apply(pt: TilePt): void {
    const delta = this.delta;
    this.err = DirtError.none;
    const before = this.saveAltitudes();
    let ok = true;
    const saved = this.cost;
    if (!this.ctrl) {
      ok = this.pullAltitude(pt, delta);
    } else {
      for (let i = 0; i < 7 && ok; i++) {
        const r: TilePt = { x: pt.x + sgsRand(4), y: pt.y + sgsRand(4), level: 0 };
        if (!this.inInterior(r.x, r.y)) continue;
        for (const [dx, dy] of GRADE_NEIGHBORS) {
          const nx = r.x + dx;
          const ny = r.y + dy;
          if (this.inInterior(nx, ny) && !this.avgPullAltitude({ x: nx, y: ny, level: 0 }, delta)) {
            ok = false;
            break;
          }
        }
        ok = ok && this.avgPullAltitude(r, delta) && this.avgPullAltitude(r, delta);
      }
    }
    if (ok) {
      const n = this.cost - saved;
      if (!this.canAfford(n)) {
        this.setError(DirtError.noFunds, -1, -1, 1);
        ok = false;
      } else {
        this.purchase(n);
        this.finalizePurchase();
      }
    }
    if (!ok) {
      this.restoreAltitudes();
      this.cost = saved;
      this.doDeniedSound();
    } else {
      this.finalizeChanges(before);
      this.terrainChanged();
      this.host.playSound(this.delta < 1 ? SOUND_LOWER : SOUND_RAISE);
    }
    this.updateErrorMessage();
  }

  /**
   * cSimpleAltTool::PullAltitude(vertex, delta): moves the corner by delta
   * (clamped to 0..0x40), then ForceGrade around it. Errors: 1 the corner
   * may not move, 2 / 3 already at the top / bottom.
   */
  private pullAltitude(pt: TilePt, delta: number): boolean {
    if (!this.inInterior(pt.x, pt.y) || !this.mayModifyTerrain(pt, true)) {
      this.setError(DirtError.cannotModify, pt.x, pt.y, pt.level);
      return false;
    }
    const alt = this.topAlt(pt.x, pt.y);
    const target = Math.max(0, Math.min(MAX_ALT, alt + delta));
    const diff = Math.abs(alt - target);
    if (diff === 0) {
      this.setError(delta < 1 ? DirtError.tooLow : DirtError.tooHigh, pt.x, pt.y, pt.level);
      return false;
    }
    this.cost += diff * this.altPrice();
    this.setTopAlt(pt, target);
    return this.forceGrade(pt.x, pt.y, pt.x, pt.y);
  }

  /** cSimpleAltTool::AvgPullAltitude(vertex, delta): toward the average of the corner and its neighbors' mean, plus delta. */
  private avgPullAltitude(pt: TilePt, delta: number): boolean {
    if (!this.inInterior(pt.x, pt.y) || !this.mayModifyTerrain(pt, true)) {
      this.setError(DirtError.cannotModify, pt.x, pt.y, pt.level);
      return false;
    }
    let count = 0;
    let sum = 0;
    for (const [dx, dy] of GRADE_NEIGHBORS) {
      const nx = pt.x + dx;
      const ny = pt.y + dy;
      if (!this.inInterior(nx, ny)) continue;
      count++;
      sum += this.topAlt(nx, ny);
    }
    const cur = this.topAlt(pt.x, pt.y);
    const target = Math.max(0, Math.min(MAX_ALT, Math.trunc((cur + Math.trunc(sum / count)) / 2) + delta));
    if (cur === target) return true;
    return this.pullAltitude(pt, target - cur);
  }
}
