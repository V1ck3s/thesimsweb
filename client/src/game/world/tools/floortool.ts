/**
 * cNewFloorTool (cGameTools tool 5): floors tiles with the pattern the build
 * panel sets (SetParameter), or takes floors away.
 *
 * Modes (ComputeMode, from the keys held): 0 floor, 1 delete (Ctrl), 2 room
 * (Shift), 3 delete room (Shift + Ctrl).
 *  - Hovering (Float) previews the change in the world: one tile (half a
 *    tile on a diagonal wall) or the whole room under the mouse. The
 *    pending FloorUndoable records it and takes it back on the next move.
 *  - Click takes the preview back and starts a gesture: Drag floors the
 *    rectangle from the clicked tile to the mouse (whole tiles, also on
 *    diagonals), or the half tile under the mouse when it did not leave the
 *    clicked tile, or adds the rooms the mouse crosses.
 *  - Release submits the gesture's FloorUndoable to the UndoManager and has
 *    the rooms of the level recomputed (GlobalDispatch(0x91, level), and
 *    the level above for the ground floor).
 * Prices: FloorGraphicsMgr::GetFloorCost per tile, half on a half tile
 * (whole-tile changes on diagonals pay full price); deleting refunds
 * trunc(0.8 * price + 0.5) of the old floor (lbl_105BBDEC / lbl_105BBDF0),
 * nothing on diagonal halves.
 * A tile takes a floor when it is flat, editable, has the "floorable" tile
 * flag, no pool, and every object on it allows floors (placement flags
 * bit 0); a floor can go away when every object allows it (bit 1, and bit
 * 0x200 upstairs).
 * The tool's tip is cDDDSimsView's for tools that do not control their
 * tool tips: the running total at the clicked tile, or "can't afford".
 *
 * Fields: +0x2c UndoManager, +0x30 the pending FloorUndoable, +0x34 mode,
 * +0x38 pattern, +0x3c preview shown, +0x3d button up, +0x3e cannot
 * afford, +0x3f room mode forced, +0x40 / +0x44 / +0x48 the last point and
 * event (OnKeyDown replays them), +0x60 in the world.
 */

import { RotatableWorld } from "../world.js";
import { SEG_HORIZ } from "../tilewalls.js";
import { Tool, type ToolEvent, type ToolHost } from "./tool.js";
import { FloorUndoable, type FloorUndoTool } from "./floorundo.js";
import {
  getDiagFloor,
  getPool,
  getViewWall,
  hasWalls,
  mayEditTile,
  resolveDiagonal,
  setDiagFloor,
  setFloor,
  setPool,
  setViewWall,
  viewSide,
} from "./worldedit.js";
import { Placement } from "./placement.js";
import { OD } from "../objects.js";
import { makeMoneyString } from "../../res/langutil.js";
import { UI_LANGUAGE } from "../../res/uires.js";

/** lbl_105BBDE8: the drag tool sounds. */
const SOUND_MOUSEUP = "UI_bld_dragtool_mouseup";
const SOUND_MOUSEDOWN = "UI_bld_dragtool_mousedown";

/** lbl_105BBDEC (0.8f) / lbl_105BBDF0 (-0.5): a deleted floor's refund. */
const REFUND = Math.fround(0.8);

/** cDDDSimsView's "can't afford" tip: UIText STR# 0x9a entry 3. */
const STR_VIEW_TIPS = 0x9a;

const enum FloorMode {
  Floor = 0,
  Delete = 1,
  Room = 2,
  DeleteRoom = 3,
}

/** cDDDSimsView::SetToolCursor ids the tool asks for. */
const CURSOR_NORMAL = 0;
const CURSOR_DELETE = 6;

/** A point of the tool: view fixed-point position (FTilePt). */
interface FPt {
  fx: number;
  fy: number;
}

/** cNewFloorTool::TileIsUnfloorable: every object on the (view) tile lets its floor go. */
export function tileIsUnfloorable(w: RotatableWorld, placement: Placement, x: number, y: number, level: number): boolean {
  const [wx, wy] = w.toWorld(x, y);
  for (const o of placement.tileObjects(wx, wy, level)) {
    const f = Placement.od(o, OD.placementFlags);
    if (!(f & 2) || (level > 1 && !(f & 0x200))) return false;
  }
  return true;
}

/** cNewFloorTool::TileIsFloorable: editable, no pool, flat, floorable flag, objects allow floors. */
export function tileIsFloorable(w: RotatableWorld, placement: Placement, x: number, y: number, level: number): boolean {
  const [wx, wy] = w.toWorld(x, y);
  const fixed = w.fixed;
  if (!placement.anywhere && fixed.flags[0]!.u8(wx, wy) & 0x20) return false;
  if (fixed.hasPool(wx, wy, level)) return false;
  const o = fixed.alt.offset(wx, wy);
  const a = fixed.alt.data;
  if (a[o] !== a[o + 2] || a[o] !== a[o + 1] || a[o] !== a[o + 3]) return false;
  if (!(w.getFlags(x, y, level) & 1)) return false;
  for (const obj of placement.tileObjects(wx, wy, level)) {
    if (!(Placement.od(obj, OD.placementFlags) & 1)) return false;
  }
  return true;
}

export class NewFloorTool extends Tool implements FloorUndoTool {
  /** +0x30 */
  private undoable: FloorUndoable;
  /** +0x34 */
  private mode: number = FloorMode.Floor;
  /** +0x38: the floor pattern (SetParameter). */
  private pattern = 0;
  /** +0x3c */
  private previewShown = false;
  /** +0x3d */
  private buttonUp = true;
  /** +0x3e */
  private cannotAffordFlag = false;
  /** +0x3f */
  private forceRoom = false;
  /** +0x40 / +0x44 / +0x48: the last point and event. */
  private last: ToolEvent | null = null;
  /** +0x60 */
  private inWorld = false;
  /** lbl_105BA520: where the gesture (or the hover) started. */
  private anchor: FPt = { fx: 0, fy: 0 };
  /** lbl_105BA4B8 */
  floorsChanged = false;
  /** cDDDSimsView::SetToolCursor's last id. */
  toolCursor = CURSOR_NORMAL;

  constructor(host: ToolHost) {
    super(host);
    this.undoable = new FloorUndoable(host.world, this);
  }

  // --- vtable -------------------------------------------------------------------

  override needsObject(): boolean {
    return false;
  }

  /** cNewFloorTool::Select */
  override select(): void {
    this.buttonUp = true;
    this.setToolCursor(CURSOR_NORMAL);
  }

  /** cNewFloorTool::Deselect */
  override deselect(): void {
    if (this.previewShown) this.revert();
    this.setToolCursor(CURSOR_NORMAL);
    this.viewToolTip();
  }

  /** cNewFloorTool::SetParameter */
  override setParameter(p: number): void {
    this.pattern = p;
  }

  /** cNewFloorTool::ResetParameter */
  resetParameter(): void {
    this.pattern = 0;
  }

  /** cNewFloorTool::SupportsUndo */
  supportsUndo(): boolean {
    return true;
  }

  /** cNewFloorTool::CannotAfford */
  cannotAfford(): boolean {
    return this.cannotAffordFlag;
  }

  /** cNewFloorTool::OnEnterWorld */
  override onEnterWorld(): void {
    this.inWorld = true;
  }

  /** cNewFloorTool::OnExitWorld */
  override onExitWorld(): void {
    this.inWorld = false;
    this.cannotAffordFlag = false;
    this.revert();
    // cMoveTool::ResetPlacementTip(true).
    this.host.resetTip();
  }

  /** cNewFloorTool::Cancel */
  override cancel(): void {
    this.inWorld = false;
  }

  /** cNewFloorTool::OnKeyDown: Shift / Control replay the last point (Float, or Drag while the button is down). */
  override onKeyDown(key: string): boolean {
    if (key !== "Shift" && key !== "Control") return false;
    const e = this.last;
    if (e) {
      if (!this.buttonUp) this.drag(e);
      else this.float(e);
    }
    return true;
  }

  /** cNewFloorTool::OnKeyUp (OnKeyDown). */
  override onKeyUp(key: string): boolean {
    return this.onKeyDown(key);
  }

  /** cNewFloorTool::Float: the hover preview. */
  override float(e: ToolEvent): void {
    if (!this.buttonUp) return;
    this.anchor = { fx: e.fx, fy: e.fy };
    this.last = e;
    const x = e.fx >> 4;
    const y = e.fy >> 4;
    if (!this.host.world.inInterior(x, y) || !mayEditTile(this.host.world, x, y, this.host.placement.anywhere)) {
      this.cannotAffordFlag = false;
      this.revert();
      this.finalizePurchase();
      this.viewToolTip();
      return;
    }
    this.mode = this.computeMode();
    this.updateCursor();
    this.cannotAffordFlag = false;
    this.revert();
    if (this.inWorld) {
      let ok: boolean;
      if (this.mode === FloorMode.Room || this.mode === FloorMode.DeleteRoom) {
        ok = this.doRoom(e, this.mode === FloorMode.Room ? this.pattern : 0, e.x, e.y);
      } else {
        ok = this.changeFloor(e, this.currentLevel(), this.mode === FloorMode.Floor ? this.pattern : 0, true, false);
      }
      if (ok) this.previewShown = true;
      else {
        this.revert();
        this.previewShown = false;
      }
    }
    this.viewToolTip();
  }

  /** cNewFloorTool::Click: the preview goes, the gesture starts. */
  override click(e: ToolEvent): void {
    this.forceRoom = false;
    this.anchor = { fx: e.fx, fy: e.fy };
    this.buttonUp = false;
    if (!this.host.world.inInterior(e.fx >> 4, e.fy >> 4)) return;
    this.last = e;
    this.mode = this.computeMode();
    this.updateCursor();
    if (this.mode !== FloorMode.Delete && this.mode !== FloorMode.DeleteRoom) {
      if (!this.previewShown || this.undoable.changes.length === 0) this.doDeniedSound();
      else this.host.playSound(SOUND_MOUSEDOWN);
    }
    this.revert();
    this.previewShown = false;
    this.viewToolTip();
  }

  /** cNewFloorTool::DoubleClick: nothing. */
  override doubleClick(_e: ToolEvent): void {}

  /** cNewFloorTool::Drag */
  override drag(e: ToolEvent): void {
    if (this.buttonUp) return;
    const x = e.fx >> 4;
    const y = e.fy >> 4;
    if (!this.host.world.inInterior(x, y)) return;
    this.last = e;
    const mode = this.computeMode();
    if (mode !== this.mode) {
      this.mode = mode;
      this.updateCursor();
      this.revert();
      this.cannotAffordFlag = false;
    }
    const level = this.currentLevel();
    if (this.mode === FloorMode.Floor || this.mode === FloorMode.Delete) {
      this.revert();
      const pattern = this.mode === FloorMode.Floor ? this.pattern : 0;
      if (x === this.anchor.fx >> 4 && y === this.anchor.fy >> 4) {
        if (!this.changeFloor(e, level, pattern, false, false)) this.revert();
      } else if (!this.doRectangle(this.anchor.fx >> 4, this.anchor.fy >> 4, x, y, pattern)) {
        this.revert();
      }
    } else if (!this.doRoom(e, this.mode === FloorMode.Room ? this.pattern : 0, e.x, e.y)) {
      this.revert();
    }
    this.viewToolTip();
  }

  /** cNewFloorTool::Release: the gesture goes to the UndoManager. */
  override release(e: ToolEvent): void {
    if (this.host.world.inInterior(e.fx >> 4, e.fy >> 4) && this.previewShown) {
      this.revert();
      this.previewShown = false;
    }
    const n = this.undoable.changes.length;
    if (n !== 0) {
      if (n > 1 && this.mode !== FloorMode.Delete && this.mode !== FloorMode.DeleteRoom && this.mode !== FloorMode.Room) {
        this.host.playSound(SOUND_MOUSEUP);
      }
      if (this.mode === FloorMode.Delete || this.mode === FloorMode.DeleteRoom) this.doExplodeSound();
      this.floorsChanged = true;
      this.host.undo.submitUndoable(this.undoable);
      this.undoable = new FloorUndoable(this.host.world, this);
    }
    this.buttonUp = true;
    this.forceRoom = false;
    if (this.floorsChanged) {
      // GlobalDispatch(0x91, level): cFixedWorld::ComputeRooms (and the level above the ground floor).
      const level = this.currentLevel();
      this.host.dirty.walls(level);
      if (level === 1) this.host.dirty.walls(level + 1);
      this.floorsChanged = false;
    }
    this.viewToolTip();
  }

  /** cTool::FinalizePurchase, then the view's tip follows the paid total (cDDDSimsView redraws it every frame). */
  override finalizePurchase(): void {
    super.finalizePurchase();
    this.viewToolTip();
  }

  // --- cNewFloorTool ------------------------------------------------------------

  /** The pending FloorUndoable's preview off the world and forgotten (UndoSelf + clear). */
  private revert(): void {
    this.undoable.undoSelf();
    this.undoable.clear();
  }

  /** cNewFloorTool::ComputeMode */
  private computeMode(): number {
    const k = this.host.keys();
    const shift = k.shift || this.forceRoom;
    if (shift && k.ctrl) return FloorMode.DeleteRoom;
    if (shift) return FloorMode.Room;
    return k.ctrl ? FloorMode.Delete : FloorMode.Floor;
  }

  private updateCursor(): void {
    this.setToolCursor(this.mode === FloorMode.Floor || this.mode === FloorMode.Room ? CURSOR_NORMAL : CURSOR_DELETE);
  }

  /** cDDDSimsView::SetToolCursor */
  private setToolCursor(id: number): void {
    this.toolCursor = id;
    this.showCursor(id);
  }

  /** GViewer::DirtyFloor */
  dirtyFloor(): void {
    this.host.dirty.floors();
  }

  /**
   * cDDDSimsView's tool tip for tools that do not control their tips
   * (ControlsOwnToolTips false): the running total at the top corner of the
   * gesture's first tile, or the "can't afford" string.
   */
  private viewToolTip(): void {
    if (this.cannotAffordFlag) {
      const p = this.host.viewer.tileToPoint(this.anchor.fx >> 4, this.anchor.fy >> 4, this.currentLevel());
      this.host.setTip(p.h, p.v, this.host.getString("UIText", STR_VIEW_TIPS, 2));
      return;
    }
    const total = this.runningTotal;
    if (total === 0) {
      this.host.resetTip();
      return;
    }
    const p = this.host.viewer.tileToPoint(this.anchor.fx >> 4, this.anchor.fy >> 4, this.currentLevel());
    // The control panel's money formatter (lbl_105BA104 vtable +0x84).
    this.host.setTip(p.h, p.v, makeMoneyString(total, UI_LANGUAGE));
  }

  /** GetQuadrant(FTilePt, level): 0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right of the tile. */
  private getQuadrant(p: FPt, level: number): number {
    const v = this.host.viewer;
    const t = v.tileToPoint(p.fx >> 4, p.fy >> 4, level);
    const vc = t.v + Math.trunc((8 << v.scale) / 2);
    const q = v.tileToPointF(p.fx, p.fy, level);
    if (q.h < t.h) return q.v >= vc ? 2 : 0;
    return q.v >= vc ? 3 : 1;
  }

  /** cNewFloorTool::DoRectangle: whole tiles from one corner tile to the other. */
  private doRectangle(x0: number, y0: number, x1: number, y1: number, pattern: number): boolean {
    const level = this.currentLevel();
    const xa = Math.min(x0, x1);
    const xb = Math.max(x0, x1);
    const ya = Math.min(y0, y1);
    const yb = Math.max(y0, y1);
    for (let x = xa; x <= xb; x++) {
      for (let y = ya; y <= yb; y++) this.changeFloor({ fx: (x << 4) | 8, fy: (y << 4) | 8 }, level, pattern, false, true);
    }
    return true;
  }

  /**
   * cNewFloorTool::DoRoom: every tile of the room under the mouse (on a
   * diagonal tile, the half the mouse is on; on the room's diagonal tiles,
   * the halves inside it). Fails as soon as one tile fails.
   */
  private doRoom(p: FPt, pattern: number, mx: number, _my: number): boolean {
    const w = this.host.world;
    const rooms = this.host.rooms;
    const level = this.currentLevel();
    const x = p.fx >> 4;
    const y = p.fy >> 4;
    const roomId = w.getRoom(x, y, level);
    if (!rooms) return false;
    const diag = roomId === 0xfffb || hasWalls(w, x, y, level, 0x10) || hasWalls(w, x, y, level, 0x20);
    let room;
    if (diag) {
      const [wx, wy] = w.toWorld(x, y);
      const d = resolveDiagonal(rooms, wx, wy, level);
      const s1 = viewSide(d.side1, w.rotation);
      const vw = getViewWall(w, x, y, level);
      if (vw.t.segs & 0x20) {
        const t = this.host.viewer.tileToPoint(x, y, level);
        if (mx < t.h) room = s1 === 1 ? d.room1 : d.room2;
        else room = s1 === 3 ? d.room1 : d.room2;
      } else {
        room = s1 === 2 ? d.room1 : d.room2;
      }
    } else {
      room = rooms.getRoom(roomId);
    }
    if ((roomId & 0x3ff) === 0) return false;
    // The original reads the room's id without a null check.
    if (!room) return false;
    const id = room.id;
    for (const t of room.tiles) {
      let [bc, c0] = RotatableWorld.rotateCoords((t.x << 4) | 8, (t.y << 4) | 8, w.rotation, 0x400);
      const pts: FPt[] = [];
      if (w.fixed.wallStorage(t.x, t.y, level).segs === 0) {
        pts.push({ fx: bc, fy: c0 });
      } else {
        const [vx, vy] = w.toView(t.x, t.y);
        const vw = getViewWall(w, vx, vy, level);
        const halves = (side: number, horiz: boolean): void => {
          if (horiz) {
            if (side === 2) {
              c0 = (c0 & ~0xf) | 0xf;
              bc = (bc & ~0xf) | 0xf;
              pts.push({ fx: bc, fy: c0 });
            } else if (side === 4) {
              c0 &= ~0xf;
              bc &= ~0xf;
              pts.push({ fx: bc, fy: c0 });
            } else {
              c0 &= ~0xf;
              bc &= ~0xf;
              pts.push({ fx: bc | 0xf, fy: c0 | 0xf });
              pts.push({ fx: bc, fy: c0 });
            }
          } else if (side === 1) {
            c0 = (c0 & ~0xf) | 0xf;
            bc &= ~0xf;
            pts.push({ fx: bc, fy: c0 });
          } else if (side === 3) {
            c0 &= ~0xf;
            bc = (bc & ~0xf) | 0xf;
            pts.push({ fx: bc, fy: c0 });
          } else {
            c0 &= ~0xf;
            bc &= ~0xf;
            pts.push({ fx: bc, fy: c0 | 0xf });
            bc |= 0xf;
            pts.push({ fx: bc, fy: c0 });
          }
        };
        if (vw.t.segs & 0x30) {
          const horiz = (vw.t.segs & SEG_HORIZ) !== 0;
          const d = resolveDiagonal(rooms, t.x, t.y, t.level);
          let r1 = d.room1;
          let r2 = d.room2;
          let s1 = 0;
          let s2 = 0;
          if (!d.found) {
            r1 = rooms.getRoom(w.getRoom(vx, vy, level));
            r2 = r1;
          } else {
            s1 = viewSide(d.side1, w.rotation);
            s2 = viewSide(d.side2, w.rotation);
          }
          if (r1 && id === r1.id) halves(s1, horiz);
          if (r2 && r2 !== r1 && id === r2.id) halves(s2, horiz);
        } else {
          pts.push({ fx: bc, fy: c0 });
        }
      }
      for (const q of pts) if (!this.changeFloor(q, level, pattern, false, false)) return false;
    }
    return true;
  }

  private tileIsUnfloorable(x: number, y: number, level: number): boolean {
    return tileIsUnfloorable(this.host.world, this.host.placement, x, y, level);
  }

  private tileIsFloorable(x: number, y: number, level: number): boolean {
    return tileIsFloorable(this.host.world, this.host.placement, x, y, level);
  }

  /** The refund of a deleted floor: -trunc(0.8 * price + 0.5). */
  private static refundOf(cost: number): number {
    return Math.trunc(-0.5 - Math.fround(REFUND * Math.fround(cost)));
  }

  /**
   * cNewFloorTool::ChangeFloor(FTilePt, level, pattern, bool, whole tile):
   * one tile, or on a diagonal wall the half under the point (the whole
   * tile when `wholeTile`). False when the tile cannot be changed.
   */
  private changeFloor(p: FPt, level: number, pattern: number, _hover: boolean, wholeTile: boolean): boolean {
    const w = this.host.world;
    const fixed = w.fixed;
    const x = p.fx >> 4;
    const y = p.fy >> 4;
    if (!w.inInterior(x, y)) return false;
    if (!this.tileIsFloorable(x, y, level)) return false;
    if (!mayEditTile(w, x, y, this.host.placement.anywhere)) return false;
    const [wx, wy] = w.toWorld(x, y);
    const old = w.getFloor(x, y, level);
    const vw = getViewWall(w, x, y, level);
    const deck = level === 1 && getPool(fixed, wx, wy) === 0x10;
    const gfx = this.host.viewer.floors;
    if ((vw.t.segs & 0x30) === 0) {
      if (old !== pattern || (this.mode === FloorMode.Delete && deck)) {
        const cost = pattern === 0 ? NewFloorTool.refundOf(gfx.getFloorCost(old)) : gfx.getFloorCost(pattern);
        if (!this.canAfford(cost)) {
          this.cannotAffordFlag = true;
          return false;
        }
        this.cannotAffordFlag = false;
        const ok = pattern === 0 ? this.tileIsUnfloorable(x, y, level) : this.tileIsFloorable(x, y, level);
        if (ok) {
          this.undoable.addChange(x, y, level, old, deck, cost);
          setFloor(w, x, y, level, pattern);
          if (deck) setPool(fixed, wx, wy, 0xff);
          this.dirtyFloor();
          this.purchase(cost);
        }
      }
    } else {
      const q = this.getQuadrant(p, this.currentLevel());
      let side: number;
      let other: number;
      if (vw.t.segs & SEG_HORIZ) [side, other] = q === 0 || q === 1 ? [2, 4] : [4, 2];
      else [side, other] = q === 0 || q === 2 ? [1, 3] : [3, 1];
      if (pattern !== getDiagFloor(vw.t, side)) {
        let cost = gfx.getFloorCost(pattern);
        if (!wholeTile) cost = Math.trunc(cost / 2);
        if (!this.canAfford(cost)) return false;
        this.undoable.addChangeWithWalls(x, y, level, old, vw, deck, cost);
        setDiagFloor(vw.t, side, pattern);
        if (!wholeTile) {
          if (old !== 0xff) setDiagFloor(vw.t, other, old);
        } else {
          setDiagFloor(vw.t, other, pattern);
        }
        setViewWall(w, x, y, level, vw);
        if (pattern === 0 && getDiagFloor(vw.t, other) === 0) setFloor(w, x, y, level, 0);
        else setFloor(w, x, y, level, 0xff);
        this.dirtyFloor();
        this.purchase(cost);
      }
    }
    this.floorsChanged = true;
    return true;
  }
}
