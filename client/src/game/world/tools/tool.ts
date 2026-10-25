/**
 * cTool: the base of the lot tools (cGameTools' 12 tools) and what they need
 * from the game (ToolHost). XViewer (gametools.ts) drives them:
 *
 *   mouse move, button up  -> Float(FTilePt, object id, event)
 *   mouse move, button down-> Drag (only when the tile changed, unless RapidFire)
 *   button down            -> Click
 *   button up              -> Release, then the running total is paid
 *                             (DoKachingSound + FinalizePurchase)
 *
 * FTilePt is the view fixed-point position under the mouse
 * (GViewer::PointToTile(pt, true)); the object id is PointToObjectID's when
 * the tool NeedsObject.
 *
 * cTool fields: +0 .. +0x18 last play time of each tool sound (400 ms apart),
 * +0x1c running total, +0x20 expense type (7 = cSimulator's build
 * expenses), +0x24 adjusts the dynamic cutaway around the cursor.
 */

import type { GameContext } from "../../context.js";
import type { CPState } from "../../cpstate.js";
import type { Compositor } from "../compositor.js";
import type { HouseViewer } from "../houseviewer.js";
import type { LotObjects } from "../lotobjects.js";
import type { RenderParam } from "../renderparam.js";
import type { RoomManager } from "../rooms.js";
import type { WallManager } from "../walls.js";
import type { FixedWorld, RotatableWorld } from "../world.js";
import type { Placement } from "./placement.js";
import type { UndoManager } from "./undo.js";

/** What XViewer hands a tool with each mouse event. */
export interface ToolEvent {
  /** Screen point (view pixels). */
  x: number;
  y: number;
  /** View fixed-point tile position (1/16 tile) under the point, at the current level. */
  fx: number;
  fy: number;
  /** PointToObjectID (tools that need an object), else 0. */
  objectId: number;
  /** EventRecord modifiers (_GetKeyState(VK_SHIFT / VK_CONTROL)). */
  shift: boolean;
  ctrl: boolean;
}

/** World change notifications (what the original does through IssueWorldDirty / HandleDirty). */
export interface WorldDirty {
  /** Walls changed on a level: wall graph, rooms, cutaway, lighting. */
  walls(level: number): void;
  /** A wall preview changed (WallManager::AsynchronousRebuild only; rooms wait for the release). */
  wallsPreview(level: number): void;
  /** Floor patterns changed. */
  floors(): void;
  /** Altitudes / grass / water changed: terrain and the max altitude table. */
  terrain(): void;
}

/** The game around the tools. */
export interface ToolHost {
  readonly ctx: GameContext;
  readonly state: CPState;
  readonly viewer: HouseViewer;
  readonly world: RotatableWorld;
  readonly fixed: FixedWorld;
  readonly walls: WallManager | null;
  readonly rooms: RoomManager | null;
  readonly lot: LotObjects;
  readonly placement: Placement;
  readonly undo: UndoManager;
  readonly dirty: WorldDirty;
  /** cSimulator::GetFunds / Spend(expense type, amount). */
  getFunds(): number;
  spend(expense: number, amount: number): void;
  /** cSoundPlayer::PlayBySource(event, -4). */
  playSound(event: string): void;
  /** cDDDSimsView::SetTip / ResetTip (view pixels). */
  setTip(x: number, y: number, text: string): void;
  resetTip(): void;
  /** String sets (UIText etc.). */
  getString(file: string, id: number, index: number): string;
  /** Modifier keys held (_GetKeyState). */
  keys(): { shift: boolean; ctrl: boolean };
  /** The last mouse position over the view (cTSWinMgrW95::GetCursorScreenPosition). */
  mouse(): { x: number; y: number };
  /** The view needs repainting. */
  invalidate(): void;
}

/** cTool sound events (lbl_105BBE58). */
export const ToolSounds = {
  slide: "UI_object_rotate",
  explode: "UI_archtool_delete",
  refund: "UI_moneyback",
  kaching: "UI_buy_moneyback",
  denied: "UI_error",
} as const;

export abstract class Tool {
  /** +0x1c */
  runningTotal = 0;
  /** +0x20: expense type for cSimulator::Spend. */
  expenseType = 7;
  /** +0x24 */
  adjustsCutaway = false;
  private readonly soundTimes = new Map<string, number>();

  constructor(protected readonly host: ToolHost) {}

  // --- vtable ------------------------------------------------------------------

  /** +0xc: Drag on every mouse move, not only tile changes. */
  rapidFire(): boolean {
    return false;
  }
  /** +0x10 */
  autoScroll(): boolean {
    return false;
  }
  /** +0x18: XViewer looks up the object under the mouse. */
  needsObject(): boolean {
    return false;
  }
  /** +0x1c */
  select(): void {}
  /** +0x20 */
  deselect(): void {}
  /** +0x24 */
  float(_e: ToolEvent): void {}
  /** +0x28 */
  click(_e: ToolEvent): void {}
  /** +0x2c */
  doubleClick(e: ToolEvent): void {
    this.click(e);
  }
  /** +0x30 */
  drag(_e: ToolEvent): void {}
  /** +0x34 */
  release(_e: ToolEvent): void {}
  /** +0x38 */
  setParameter(_p: number): void {}
  /** +0x50 / +0x54 (DOM key names); true when handled. */
  onKeyDown(_key: string): boolean {
    return false;
  }
  onKeyUp(_key: string): boolean {
    return false;
  }
  /** +0x58 */
  onChar(_ch: string): boolean {
    return false;
  }
  /** +0x60 / +0x64 */
  onEnterWorld(): void {}
  onExitWorld(): void {}
  /** +0x68 */
  cancel(): void {}
  /** +0x7c */
  rotationChanged(): void {}
  /** The tool's own drawing over the lot (cursor, wall preview, selection), after the dynamic objects. */
  drawOverlay?(viewer: HouseViewer, comp: Compositor, rp: RenderParam): void;

  // --- cTool helpers -----------------------------------------------------------

  /** cTool::GetCurrentLevel */
  protected currentLevel(): number {
    return this.host.viewer.level || 1;
  }

  protected playLimited(event: string): void {
    const now = performance.now();
    const last = this.soundTimes.get(event) ?? -1e9;
    if (now < last + 400) return;
    this.soundTimes.set(event, now);
    this.host.playSound(event);
  }

  doSlideSound(): void {
    this.playLimited(ToolSounds.slide);
  }
  doExplodeSound(): void {
    this.playLimited(ToolSounds.explode);
  }
  doRefundSound(): void {
    this.playLimited(ToolSounds.refund);
  }
  doKachingSound(): void {
    this.playLimited(ToolSounds.kaching);
  }
  doDeniedSound(): void {
    this.playLimited(ToolSounds.denied);
  }

  /** cTool::FinalizePurchase: cSimulator::Spend(expense type, running total). */
  finalizePurchase(): void {
    if (this.runningTotal !== 0) this.host.spend(this.expenseType, this.runningTotal);
    this.runningTotal = 0;
  }

  /** cTool::Refund */
  refund(n: number): void {
    this.runningTotal -= n;
  }

  /** cTool::Purchase */
  purchase(n: number): void {
    this.runningTotal += n;
  }

  /** cTool::CanAfford */
  canAfford(n: number): boolean {
    if (n < 1) return true;
    return this.runningTotal + n <= this.host.getFunds();
  }

  /** cTool::SetToolTip: a tip next to the mouse, or none. */
  setToolTip(text: string | null): void {
    if (!text) {
      this.host.resetTip();
      return;
    }
    const m = this.host.mouse();
    this.host.setTip(m.x + 0x11, m.y - 5, text);
  }
}
