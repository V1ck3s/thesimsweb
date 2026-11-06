/**
 * cNewWallpaperTool (cGameTools tool 3): paints wall sides with the
 * wallpaper the build panel sets (SetParameter; 0xff means 1), or takes
 * wallpaper off.
 *
 * Modes (from the keys held): 0 paint, 1 delete (Ctrl), 2 room (Shift),
 * 3 delete room (Shift + Ctrl).
 *  - The mouse point is moved down 100 >> (3 - scale) pixels first
 *    (ModifyCursorPos): the tile looked up is the one whose back walls the
 *    pointer is on. FindNearestWallSegment picks that tile's top-left (1) or
 *    top-right (2) wall (by the side of the tile the pointer is on when it
 *    has both), else its horizontal diagonal (0x10).
 *  - A "Wall Cursor" object (Cursors.iff) marks the wall: at the tile
 *    center facing the wall, at the tile's bottom corner for a diagonal;
 *    graphic 2.
 *  - Hovering (Float) previews the change (the pending WallpaperUndoable
 *    paints, Reset takes it back on the next move) with the running total
 *    as tip; room modes paint every wall side facing the room.
 *  - Click paints the side under the mouse (denied sound and a tip when
 *    there is no wall); Drag keeps painting the sides the mouse crosses;
 *    Release submits the WallpaperUndoable to the UndoManager.
 *  - Tips (cMoveTool::ShowPlacementTip): 6 / 0x22 no wall here (ground
 *    floor / upstairs), 0x2e fences take no wallpaper, 0x1a the total.
 *
 * Fields: +0x2c the cursor, +0x30 the pending WallpaperUndoable, +0x34
 * UndoManager, +0x38 wallpaper, +0x3c mode, +0x40 / +0x44 / +0x48 the last
 * point and event, +0x58 button up, +0x59 in the world, +0x5c tip code.
 */

import type { Compositor } from "../compositor.js";
import type { HouseViewer } from "../houseviewer.js";
import { drawIso, type DrawableObject, type DrawGroupItem } from "../objectdraw.js";
import type { ObjSelector } from "../objselector.js";
import { Renderer } from "../renderer.js";
import type { RenderParam } from "../renderparam.js";
import { getWall, SEG_HORIZ, SEG_ROTATION, SEG_VERT } from "../tilewalls.js";
import { RotatableWorld } from "../world.js";
import { XCursorObject } from "./cursorobject.js";
import { pointToFTile } from "./gametools.js";
import { Tool, type ToolEvent, type ToolHost } from "./tool.js";
import { WallpaperMode, WallpaperUndoable, type WallpaperUndoTool } from "./wallpaperundo.js";
import { DIAG_SIDE_ROTATION, getViewWall, mayEditTile, resolveDiagonal, viewSide } from "./worldedit.js";
import { makeMoneyString } from "../../res/langutil.js";
import { UI_LANGUAGE } from "../../res/uires.js";

/** GUID of the "Wall Cursor" definition (ObjectFolder::GetSelectorByName(lbl_105BBDF4 "Wall Cursor")). */
export const GUID_WALL_CURSOR = 0x439;

/** lbl_105BBDF4 + 0xc / + 0x24 / + 0x2d. */
const SOUND_MOUSEUP = "UI_bld_dragtool_mouseup";
const SOUND_ERROR = "UI_error";
const SOUND_MOUSEDOWN = "UI_bld_dragtool_mousedown";

/** cMoveTool::ShowPlacementTip codes (UIText STR# 137 "PlacementErrs", entry code). */
const TIP_TOTAL = 0x1a;
const TIP_NO_WALL = 6;
const TIP_NO_WALL_UP = 0x22;
const STR_PLACEMENT_ERRS = 137;
/** lbl_105BBDB0 + 0x1c: ShowPlacementTip's default text. */
const TIP_DEFAULT = "Can't place here!";

/** cDDDSimsView::SetToolCursor ids. */
const CURSOR_NORMAL = 0;
const CURSOR_DELETE = 6;

/** The Wall Cursor's graphic (+0x4a), set at every move. */
const CURSOR_GRAPHIC = 2;

interface FPt {
  fx: number;
  fy: number;
}

/** A tool event after ModifyCursorPos (the point and the EventRecord's `where`). */
interface WEvent extends FPt {
  x: number;
  y: number;
}

/** DrawIso adapter for the Wall Cursor (the cursor object is not in the tile object arrays). */
class WallCursorDrawable implements DrawableObject {
  next: DrawableObject | null = null;
  isDynamic = true;
  hidden = 0;
  spriteMask = null;

  constructor(
    readonly sel: ObjSelector,
    readonly renderer: Renderer,
    readonly fx: number,
    readonly fy: number,
    readonly level: number,
    readonly dir: number,
    readonly graphic: number,
  ) {}

  get spriteMaskBase(): number {
    return this.sel.objd.dynamicSpritesBaseId;
  }

  items(graphic: number, dirIndex: number, scale: number): readonly DrawGroupItem[] | null {
    return this.sel.getDrawGroup(graphic)?.getItemList(dirIndex, scale)?.items ?? null;
  }
}

export class NewWallpaperTool extends Tool implements WallpaperUndoTool {
  /** +0x2c */
  private cursor: XCursorObject | null = null;
  /** +0x30 */
  private undoable: WallpaperUndoable;
  /** +0x38 */
  private wallpaper = 1;
  /** +0x3c */
  private mode: number = WallpaperMode.Paint;
  /** +0x40 / +0x44 / +0x48 */
  private last: ToolEvent | null = null;
  /** +0x58 */
  private buttonUp = true;
  /** +0x59 */
  private inWorld = false;
  /** +0x5c: the tip shown (cMoveTool::ShowPlacementTip code). */
  private tipCode = 0;
  /** cDDDSimsView::SetToolCursor's last id. */
  toolCursor = CURSOR_NORMAL;
  private cursorSel: ObjSelector | null = null;
  private cursorRenderer: Renderer | null = null;
  private readonly cursorLoad: Promise<void>;

  constructor(host: ToolHost) {
    super(host);
    this.undoable = new WallpaperUndoable(host.world, this);
    this.undoable.setWallpaper(this.wallpaper);
    this.adjustsCutaway = true;
    this.cursorLoad = host.lot.folder.getSelectorByGUID(GUID_WALL_CURSOR).then((sel) => {
      this.cursorSel = sel;
      this.cursorRenderer = sel ? new Renderer(sel.res) : null;
    });
  }

  // --- WallpaperUndoTool ----------------------------------------------------------

  level(): number {
    return this.currentLevel();
  }

  /** WallManager::AsynchronousRefresh */
  refreshWalls(level: number): void {
    this.host.walls?.rebuildFromMap(level);
    this.host.invalidate();
  }

  /** cTool::DirtyTile */
  dirtyTile(): void {
    this.host.invalidate();
  }

  wallPatternCost(pattern: number): number {
    return this.host.walls?.gfx.getWallPatternCost(pattern) ?? 0;
  }

  // --- vtable ---------------------------------------------------------------------

  override needsObject(): boolean {
    return true;
  }

  override autoScroll(): boolean {
    return false;
  }

  /** cNewWallpaperTool::SupportsUndo */
  supportsUndo(): boolean {
    return true;
  }

  /** cNewWallpaperTool::ControlsOwnToolTips */
  controlsOwnToolTips(): boolean {
    return true;
  }

  /** cNewWallpaperTool::CannotAfford */
  cannotAfford(): boolean {
    return this.undoable.cannotAfford();
  }

  /** cNewWallpaperTool::Select: the Wall Cursor (cXCursorObject::MakeMouseObject), then OnExitWorld. */
  override select(): void {
    if (!this.cursor) {
      if (this.cursorSel) this.makeCursor(this.cursorSel);
      else void this.cursorLoad.then(() => this.cursorSel && !this.cursor && this.makeCursor(this.cursorSel));
    }
    this.onExitWorld();
    this.buttonUp = true;
  }

  private makeCursor(sel: ObjSelector): void {
    this.cursor = new XCursorObject(this.host.placement, sel, null, () => this.host.getFunds());
    this.updateCursor();
  }

  /** cNewWallpaperTool::Deselect: the cursor object is killed. */
  override deselect(): void {
    this.cursor = null;
    this.host.invalidate();
  }

  /** cNewWallpaperTool::SetParameter */
  override setParameter(p: number): void {
    this.wallpaper = p === 0xff ? 1 : p;
    this.undoable.setWallpaper(this.wallpaper);
  }

  /** cNewWallpaperTool::ResetParameter */
  resetParameter(): void {
    this.wallpaper = 1;
    this.undoable.setWallpaper(this.wallpaper);
  }

  /** cNewWallpaperTool::OnEnterWorld */
  override onEnterWorld(): void {
    this.inWorld = true;
  }

  /** cNewWallpaperTool::OnExitWorld: the cursor and the preview go. */
  override onExitWorld(): void {
    this.inWorld = false;
    this.cursor?.pickup(true);
    if (this.buttonUp) this.undoable.reset();
    // cMoveTool::ResetPlacementTip(true).
    this.host.resetTip();
    this.host.invalidate();
  }

  /** cNewWallpaperTool::Cancel (OnExitWorld). */
  override cancel(): void {
    this.onExitWorld();
  }

  /** cNewWallpaperTool::OnKeyDown: Shift / Control replay the last point. */
  override onKeyDown(key: string): boolean {
    if (key !== "Shift" && key !== "Control") return false;
    const e = this.last;
    if (e) {
      if (this.buttonUp) this.float(e);
      else this.drag(e);
    }
    return true;
  }

  /** cNewWallpaperTool::OnKeyUp (OnKeyDown). */
  override onKeyUp(key: string): boolean {
    return this.onKeyDown(key);
  }

  /**
   * cNewWallpaperTool::ModifyCursorPos (vtable +0x4c): the point moves down
   * 100 >> (3 - scale) pixels. XViewer applies it to the mouse events'
   * point, DoDynamicCutaway to the cursor before cutting the tile 4 tiles
   * back from it (world/cutaway.ts).
   */
  modifyCursorPos(p: { x: number; y: number }): void {
    p.y += 100 >> (3 - this.host.viewer.scale);
  }

  /** A mouse event after ModifyCursorPos, with the tile under the moved point. */
  private modifiedEvent(e: ToolEvent): WEvent {
    const p = { x: e.x, y: e.y };
    this.modifyCursorPos(p);
    const t = pointToFTile(this.host.viewer, p.x, p.y, this.currentLevel());
    return { x: p.x, y: p.y, fx: t.fx, fy: t.fy };
  }

  /** cNewWallpaperTool::Float: the hover preview. */
  override float(ev: ToolEvent): void {
    const e = this.modifiedEvent(ev);
    const x = e.fx >> 4;
    const y = e.fy >> 4;
    if (!this.host.world.inInterior(x, y)) return;
    this.tipCode = 0;
    this.showPlacementTip(0);
    this.last = ev;
    this.mode = this.keyMode();
    this.updateCursor();
    const seg = this.findNearestWallSegment(e, e);
    const level = this.currentLevel();
    this.setCursorVertex(e, level, seg);
    this.undoable.reset();
    if (this.mode === WallpaperMode.Room || this.mode === WallpaperMode.DeleteRoom) {
      if (!this.doRoom(e, level, seg, e, this.mode)) this.undoable.reset();
    } else if (this.undoable.canChangeTile(x, y, level, this.mode, seg, 0, null)) {
      this.undoable.changeTile(x, y, level, this.mode, seg, 0);
    }
    this.refreshWalls(this.currentLevel());
    if (this.runningTotal !== 0) {
      this.tipCode = TIP_TOTAL;
      this.showPlacementTip(TIP_TOTAL, this.runningTotal);
    }
  }

  /** cNewWallpaperTool::Click: paints the side under the mouse. */
  override click(ev: ToolEvent): void {
    const e = this.modifiedEvent(ev);
    const x = e.fx >> 4;
    const y = e.fy >> 4;
    if (!this.host.world.inInterior(x, y)) return;
    this.last = ev;
    this.buttonUp = false;
    const seg = this.findNearestWallSegment(e, e);
    const level = this.currentLevel();
    this.mode = this.keyMode();
    this.updateCursor();
    this.setCursorVertex(e, level, seg);
    if (seg === 0) {
      this.tipCode = this.currentLevel() < 2 ? TIP_NO_WALL : TIP_NO_WALL_UP;
      this.showPlacementTip(this.tipCode);
      this.doDeniedSound();
      return;
    }
    this.tipCode = 0;
    this.showPlacementTip(0);
    this.undoable.reset();
    if (this.mode === WallpaperMode.Room || this.mode === WallpaperMode.DeleteRoom) {
      if (!this.doRoom(e, level, seg, e, this.mode)) {
        this.undoable.reset();
      } else {
        if (this.mode === WallpaperMode.DeleteRoom) this.doExplodeSound();
        this.refreshWalls(this.currentLevel());
      }
    } else {
      const err = { code: 0 };
      if (!this.undoable.canChangeTile(x, y, level, this.mode, seg, 0, err)) {
        if (err.code !== 0) {
          this.tipCode = err.code;
          this.showPlacementTip(err.code);
        }
      } else {
        this.undoable.changeTile(x, y, level, this.mode, seg, 0);
        if (this.mode === WallpaperMode.Delete) this.doExplodeSound();
        this.refreshWalls(this.currentLevel());
      }
    }
    if (this.undoable.changes.length === 0) this.doDeniedSound();
    else if (this.mode !== WallpaperMode.Delete && this.mode !== WallpaperMode.DeleteRoom) this.host.playSound(SOUND_MOUSEDOWN);
  }

  /** cNewWallpaperTool::Drag: keeps painting. */
  override drag(ev: ToolEvent): void {
    if (this.buttonUp) return;
    const e = this.modifiedEvent(ev);
    const x = e.fx >> 4;
    const y = e.fy >> 4;
    if (!this.host.world.inInterior(x, y)) {
      this.host.playSound(SOUND_ERROR);
      return;
    }
    const mode = this.keyMode();
    if (mode !== this.mode) {
      this.mode = mode;
      this.undoable.reset();
      this.updateCursor();
    }
    this.last = ev;
    const seg = this.findNearestWallSegment(e, e);
    const level = this.currentLevel();
    this.setCursorVertex(e, level, seg);
    let tipShown = false;
    if (this.mode === WallpaperMode.Room || this.mode === WallpaperMode.DeleteRoom) {
      if (!this.doRoom(e, level, seg, e, this.mode)) {
        this.undoable.reset();
      } else {
        if (this.mode === WallpaperMode.DeleteRoom) this.doExplodeSound();
        this.refreshWalls(this.currentLevel());
      }
    } else {
      const err = { code: 0 };
      if (!this.undoable.canChangeTile(x, y, level, this.mode, seg, 0, err)) {
        if (err.code !== 0) {
          tipShown = true;
          this.tipCode = err.code;
          this.showPlacementTip(err.code);
        }
      } else {
        this.undoable.changeTile(x, y, level, this.mode, seg, 0);
        if (this.mode === WallpaperMode.Delete) this.doExplodeSound();
        this.refreshWalls(this.currentLevel());
      }
    }
    if (!tipShown && this.tipCode === 0) this.showPlacementTip(TIP_TOTAL, this.runningTotal);
  }

  /** cNewWallpaperTool::Release: the last side, then the gesture goes to the UndoManager. */
  override release(ev: ToolEvent): void {
    const e = this.modifiedEvent(ev);
    const x = e.fx >> 4;
    const y = e.fy >> 4;
    if (this.host.world.inInterior(x, y) && mayEditTile(this.host.world, x, y)) {
      const seg = this.findNearestWallSegment(e, e);
      const level = this.currentLevel();
      this.setCursorVertex(e, level, seg);
      if (this.undoable.canChangeTile(x, y, level, this.mode, seg, 0, null)) {
        this.undoable.changeTile(x, y, level, this.mode, seg, 0);
        this.refreshWalls(this.currentLevel());
      }
    }
    const n = this.undoable.changes.length;
    if (n !== 0) {
      if (n > 1 && this.mode !== WallpaperMode.Delete && this.mode !== WallpaperMode.DeleteRoom && this.mode !== WallpaperMode.Room) {
        this.host.playSound(SOUND_MOUSEUP);
      }
      this.host.undo.submitUndoable(this.undoable);
      this.undoable = new WallpaperUndoable(this.host.world, this);
      this.undoable.setWallpaper(this.wallpaper);
    }
    this.buttonUp = true;
  }

  // --- cNewWallpaperTool ------------------------------------------------------------

  /** The mode the keys held ask for (_GetKeyState(VK_SHIFT / VK_CONTROL)). */
  private keyMode(): number {
    const k = this.host.keys();
    if (k.shift && k.ctrl) return WallpaperMode.DeleteRoom;
    if (k.shift) return WallpaperMode.Room;
    return k.ctrl ? WallpaperMode.Delete : WallpaperMode.Paint;
  }

  /** The cursor's graphic (+0x4a = 2) and the view's tool cursor for the mode. */
  private updateCursor(): void {
    if (!this.cursor) return;
    const m = this.mode;
    if (m === WallpaperMode.Paint || m === WallpaperMode.Room) this.toolCursor = CURSOR_NORMAL;
    else if (m === WallpaperMode.Delete || m === WallpaperMode.DeleteRoom) this.toolCursor = CURSOR_DELETE;
    this.showCursor(this.toolCursor);
  }

  /** cMoveTool::ShowPlacementTip(code, amount): next to the mouse, 0 takes it away. */
  private showPlacementTip(code: number, amount = 0): void {
    if (code === 0) {
      this.host.resetTip();
      return;
    }
    let text = TIP_DEFAULT;
    if (code === TIP_TOTAL) {
      // The control panel's money formatter (lbl_105BA104 vtable +0x84).
      text = makeMoneyString(amount, UI_LANGUAGE);
    } else {
      text = this.host.getString("UIText", STR_PLACEMENT_ERRS, code - 1) || text;
    }
    const m = this.host.mouse();
    this.host.setTip(m.x + 0x11, m.y - 5, text);
  }

  /**
   * cNewWallpaperTool::FindNearestWallSegment: the view tile's top-left (1)
   * or top-right (2) wall, the one on the pointer's side when it has both;
   * else its horizontal diagonal (0x10); else 0.
   */
  private findNearestWallSegment(p: FPt, where: { x: number; y: number }): number {
    const level = this.currentLevel();
    const x = p.fx >> 4;
    const y = p.fy >> 4;
    const segs = getViewWall(this.host.world, x, y, level).t.segs;
    const has2 = (segs & 2) !== 0;
    const has1 = (segs & 1) !== 0;
    if (!has2 && !has1 && !(segs & SEG_HORIZ)) return 0;
    if (has2 || has1) {
      if (has2 && has1) return this.host.viewer.tileToPoint(x, y, level).h < where.x ? 2 : 1;
      return has2 ? 2 : 1;
    }
    return SEG_HORIZ;
  }

  /**
   * cNewWallpaperTool::SetCursorVertex: the Wall Cursor at the tile center
   * facing the wall (top-right wall: direction 0, top-left: 3, in view
   * quarter turns), at the bottom corner for the diagonal; picked up when
   * out of the world or where it cannot go.
   */
  private setCursorVertex(p: FPt, level: number, seg: number): void {
    const c = this.cursor;
    if (!this.inWorld) {
      c?.pickup(true);
      this.host.invalidate();
      return;
    }
    let cy = (p.fy & ~0xf) | 8;
    let cx = (p.fx & ~0xf) | 8;
    let face = -1;
    if (seg === 2) face = 0;
    else if (seg === 1) face = 3;
    else if (seg === SEG_HORIZ) {
      cy = (p.fy & ~0xf) | 0xf;
      cx = (p.fx & ~0xf) | 0xf;
    }
    const rot = this.host.world.rotation;
    const [wx, wy] = RotatableWorld.rotateCoords(cx, cy, (4 - rot) & 3, 0x400);
    if (!c || !c.canPlace({ fx: wx, fy: wy }, level, null)) {
      c?.pickup(true);
    } else {
      c.place({ fx: wx, fy: wy }, level, 0);
      if (face !== -1) c.faceDirection(((face + ((4 - rot) & 3)) & 3) * 2);
    }
    this.host.invalidate();
  }

  /**
   * cNewWallpaperTool::DoRoom: every wall side facing the room under the
   * mouse (on a diagonal tile shared by two rooms, the room on the
   * pointer's side). False when one side failed for money.
   */
  private doRoom(p: FPt, level: number, seg: number, where: { x: number; y: number }, mode: number): boolean {
    if (seg === 0) return true;
    const w = this.host.world;
    const rooms = this.host.rooms;
    if (!rooms) return true;
    const x = p.fx >> 4;
    const y = p.fy >> 4;
    let roomId = w.getRoom(x, y, level);
    const cur = this.currentLevel();
    if (roomId === 0xfffb) {
      const [wx, wy] = w.toWorld(x, y);
      const d = resolveDiagonal(rooms, wx, wy, cur);
      const s1 = viewSide(d.side1, w.rotation);
      const vw = getViewWall(w, x, y, cur);
      let r;
      if (vw.t.segs & SEG_VERT) {
        const q = this.host.viewer.tileToPointF(p.fx, p.fy, cur);
        if (where.x < q.h) r = s1 === 1 ? d.room1 : d.room2;
        else r = s1 === 3 ? d.room1 : d.room2;
      } else {
        r = s1 === 2 ? d.room1 : d.room2;
      }
      // The original reads the id through the Room pointer without a null check.
      if (!r) return true;
      roomId = r.id;
    }
    const room = rooms.getRoom(roomId);
    if (!room) return true;
    const rot = w.rotation;
    for (const t of room.tiles) {
      if (w.fixed.wallStorage(t.x, t.y, t.level).segs === 0) continue;
      const tw = getWall(w.fixed, t.x, t.y, t.level);
      const [vx, vy] = w.toView(t.x, t.y);
      let sides: number[] = [0];
      for (let b = 1; b < 0x40; b <<= 1) {
        if (!(tw.segs & b)) continue;
        if (b === SEG_HORIZ || b === SEG_VERT) {
          const d = resolveDiagonal(rooms, t.x, t.y, t.level);
          sides = [];
          if (!d.found) {
            sides.push(...(b === SEG_HORIZ ? [2, 4] : [1, 3]));
          } else {
            const flip = (s: number): number | null => (s === 1 ? 1 : s === 3 ? 3 : s === 4 ? 2 : s === 2 ? 4 : null);
            if (d.room1 && roomId === d.room1.id) {
              const s = flip(d.side1);
              sides.push(...(s !== null ? [s] : b === SEG_HORIZ ? [2, 4] : [1, 3]));
            }
            if (d.room2 && d.room2 !== d.room1 && roomId === d.room2.id) {
              const s = flip(d.side2);
              if (s !== null) sides.push(s);
            }
          }
        } else {
          sides = [sides[0] ?? 0];
        }
        const vseg = SEG_ROTATION[rot]![b]!;
        for (let i = 0; i < sides.length; i++) {
          if (sides[i] !== 0) sides[i] = DIAG_SIDE_ROTATION[rot]![sides[i]!]!;
          const s = sides[i]!;
          if (!this.undoable.canChangeTile(vx, vy, t.level, mode, vseg, s, null)) {
            if (this.undoable.cannotAfford()) return false;
          } else {
            this.undoable.changeTile(vx, vy, t.level, mode, vseg, s);
          }
        }
      }
    }
    return true;
  }

  /** HouseViewer::RenderCursorObject for the Wall Cursor (cXObject::DrawIso, graphic 2). */
  override drawOverlay(viewer: HouseViewer, comp: Compositor, rp: RenderParam): void {
    const c = this.cursor;
    const sel = this.cursorSel;
    const r = this.cursorRenderer;
    if (!c || !c.inWorld || !sel || !r) return;
    if (c.level > viewer.level) return;
    rp.setGridCoords(c.headFx, c.headFy, c.level);
    drawIso(new WallCursorDrawable(sel, r, c.headFx, c.headFy, c.level, c.dir, CURSOR_GRAPHIC), viewer, comp, rp);
  }
}
