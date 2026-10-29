/**
 * cNewWallTool (cGameTools tool 2): draws walls and fences from vertex to
 * vertex, a rectangle of walls with Shift, deletes them with Ctrl. One
 * gesture is one WallUndoable (wallundo.ts), submitted to the UndoManager on
 * Release.
 *
 * The mouse position snaps to the nearest grid point (Float / Click / Drag:
 * f / 16 rounded with lbl_105BBE04 = { 1/16, 0.5, 0.25 }). The "Wall Cursor"
 * object (Cursors.iff, GUID 0x439) marks the vertex, its graphic telling the
 * mode (0 draw, 1 delete, 3 rectangle).
 *
 * Fields: +0x2c cursor object, +0x30 click vertex, +0x33 cursor vertex,
 * +0x38 / +0x3c last FTilePt, +0x50 / +0x54 click point (screen), +0x58 the
 * WallUndoable, +0x5c style, +0x60 pattern, +0x64 UndoManager, +0x68 mode,
 * +0x6c not dragging, +0x6d mouse in the world.
 *
 * SetParameter(style) (newwalltool.s): style 1 (wall) draws construction
 * walls (style / pattern 0xff, made plain walls by CleanupWallpaper), the
 * fences 2 / 0xc / 0xd / 0xe their own pattern 0xf8 / 0xf9 / 0xfa / 0xfb.
 */

import { loadBuildCatalog } from "../../data/buildcatalog.js";
import type { Compositor } from "../compositor.js";
import type { HouseViewer } from "../houseviewer.js";
import { drawIso } from "../objectdraw.js";
import type { ObjSelector } from "../objselector.js";
import { Renderer } from "../renderer.js";
import type { RenderParam } from "../renderparam.js";
import { RotatableWorld, type TilePt } from "../world.js";
import { CursorDrawable, getFrontDirection } from "./cursorobject.js";
import { Tool, type ToolEvent, type ToolHost } from "./tool.js";
import { fencePattern, WallMode, WallUndoable, type WallToolLink } from "./wallundo.js";
import { mayEditTile } from "./wallworld.js";

/** ObjectFolder::GetSelectorByName("Wall Cursor") (lbl_105BBDFC). */
export const GUID_WALL_CURSOR = 0x439;

/** lbl_105BBDFC + 0x24 / + 0xc */
const SOUND_MOUSEDOWN = "UI_bld_dragtool_mousedown";
const SOUND_MOUSEUP = "UI_bld_dragtool_mouseup";

/** cNewWallTool::SetCursor: the cursor graphic per mode. */
const CURSOR_GRAPHIC = [0, 1, 3];

/** Tip codes (UIText STR# 137). */
const TIP_CANNOT_EDIT = 1;
const TIP_NO_MONEY = 0x19;
const TIP_COST = 0x1a;
const TIP_NEED_FLOOR = 0x20;

/** Float / Click / Drag: a fixed-point coordinate to the nearest grid line. */
function snap(f: number): number {
  let v = f;
  if (0.5 <= f * 0.0625 - (f >> 4)) v += 0x10;
  return ((v & ~0xf) | 8) >> 4;
}

export class NewWallTool extends Tool {
  /** +0x2c: the Wall Cursor's definition, and whether it is placed (at the cursor vertex). */
  private cursorSel: ObjSelector | null = null;
  private cursorRenderer: Renderer | null = null;
  private cursorShown = false;
  /** +0x30 / +0x33 */
  private clickVertex: TilePt = { x: 0, y: 0, level: 0 };
  private cursorVertex: TilePt = { x: 0, y: 0, level: 0 };
  /** +0x38 .. +0x4e: the last event (OnKeyDown replays it). */
  private last: ToolEvent | null = null;
  /** +0x50 / +0x54 */
  private clickH = 0;
  private clickV = 0;
  /** +0x58 */
  private undoable: WallUndoable;
  /** +0x5c / +0x60 */
  private style = 1;
  private pattern = 1;
  /** +0x68 */
  private mode: number = WallMode.Draw;
  /** +0x6c / +0x6d */
  private notDragging = true;
  private inWorld = false;
  /** lbl_105BA4CC, filled by Catalog::Init. */
  private prices: ReadonlyMap<number, number> | null = null;
  private readonly link: WallToolLink;

  constructor(host: ToolHost) {
    super(host);
    this.link = {
      host,
      tool: this,
      price: (style) => this.prices?.get(style) ?? 0,
      cannotAfford: () => this.cannotAfford(),
    };
    this.undoable = new WallUndoable(this.link);
    void loadBuildCatalog(host.ctx).then((c) => {
      this.prices = c.prices.wallStyle;
    });
  }

  override autoScroll(): boolean {
    return true;
  }

  /** cNewWallTool::CannotAfford */
  cannotAfford(): boolean {
    return this.undoable.cannotAfford;
  }

  /** cNewWallTool::SetParameter: the wall style and its pattern. */
  override setParameter(style: number): void {
    this.style = style;
    this.pattern = style === 1 ? 0xff : fencePattern(style);
  }

  /** cNewWallTool::Select: the Wall Cursor object. */
  override select(): void {
    if (!this.cursorSel) {
      void this.host.lot.folder.getSelectorByGUID(GUID_WALL_CURSOR).then((sel) => {
        if (!sel) return;
        this.cursorSel = sel;
        this.cursorRenderer = new Renderer(sel.res);
        this.host.invalidate();
      });
    }
    this.cursorShown = false;
    this.setCursorVertex({ x: 0, y: 0, level: this.currentLevel() });
  }

  /** cNewWallTool::SetCursor(mode): the delete cursor while Ctrl deletes walls, else the arrow. */
  private setCursor(mode: number): void {
    this.showCursor(mode === WallMode.Delete ? 6 : 0);
  }

  /** cNewWallTool::Deselect: the cursor object is killed. */
  override deselect(): void {
    this.cursorShown = false;
    this.host.invalidate();
  }

  override onEnterWorld(): void {
    this.inWorld = true;
  }

  /** cNewWallTool::OnExitWorld */
  override onExitWorld(): void {
    this.inWorld = false;
    this.cursorShown = false;
    this.setToolTip(null);
    this.host.invalidate();
  }

  /** cNewWallTool::Cancel */
  override cancel(): void {
    this.cursorShown = false;
    this.undoable.resetAll();
    this.notDragging = true;
    this.host.dirty.wallsPreview(this.currentLevel());
    this.finalizePurchase();
    this.setToolTip(null);
    this.undoable.error = 0;
  }

  /** cNewWallTool::RotationChanged */
  override rotationChanged(): void {
    this.cancel();
  }

  /** cNewWallTool::OnKeyDown / OnKeyUp: Shift and Ctrl change the mode at once (the last event replayed). */
  override onKeyDown(key: string): boolean {
    if (key !== "Shift" && key !== "Control") return false;
    const e = this.last;
    if (e) {
      const k = this.host.keys();
      const ev = { ...e, shift: k.shift, ctrl: k.ctrl };
      if (this.notDragging) this.float(ev);
      else this.drag(ev, true);
    }
    return true;
  }

  override onKeyUp(key: string): boolean {
    return this.onKeyDown(key);
  }

  private static modeOf(e: ToolEvent): number {
    return e.shift ? WallMode.Rect : e.ctrl ? WallMode.Delete : WallMode.Draw;
  }

  private vertexOf(e: ToolEvent): TilePt {
    return { x: snap(e.fx), y: snap(e.fy), level: this.currentLevel() };
  }

  /** The tile under the event is on the lot and editable (Click / Drag). */
  private editableTile(e: ToolEvent): boolean {
    const w = this.host.world;
    const x = e.fx >> 4;
    const y = e.fy >> 4;
    return w.inInterior(x, y) && mayEditTile(w, x, y, this.currentLevel(), this.host.placement.anywhere);
  }

  private tip(code: number): void {
    if (code === 0) {
      this.setToolTip(null);
      return;
    }
    const text = code === TIP_COST ? `§${this.runningTotal.toLocaleString("en-US")}` : this.host.getString("UIText", 137, code - 1) || "Can't place here!";
    this.setToolTip(text);
  }

  /**
   * cNewWallTool::SetCursorVertex: the cursor moves to a vertex (hidden out of
   * the world); false when it cannot go there. A preview on screen is rebuilt.
   */
  private setCursorVertex(v: TilePt): boolean {
    if (!this.inWorld) {
      this.cursorShown = false;
      this.host.invalidate();
      return false;
    }
    if (v.x === this.cursorVertex.x && v.y === this.cursorVertex.y && v.level === this.cursorVertex.level) return true;
    this.cursorVertex = { ...v };
    const w = this.host.world;
    const ok = v.x >= w.minX && v.x <= w.maxX && v.y >= w.minY && v.y <= w.maxY;
    this.cursorShown = ok;
    if (ok && this.undoable.dirty) this.host.dirty.wallsPreview(this.currentLevel());
    this.host.invalidate();
    return ok;
  }

  /** cNewWallTool::Float */
  override float(e: ToolEvent): void {
    this.last = e;
    this.mode = NewWallTool.modeOf(e);
    this.setCursor(this.mode);
    const v = this.vertexOf(e);
    if (this.undoable.legalWallTile(v, 0)) this.setCursorVertex(v);
  }

  /** cNewWallTool::Click */
  override click(e: ToolEvent): void {
    if (!this.editableTile(e)) {
      this.undoable.error = 1;
      this.tip(TIP_CANNOT_EDIT);
      this.doDeniedSound();
      return;
    }
    this.notDragging = false;
    this.last = e;
    const v = this.vertexOf(e);
    this.mode = NewWallTool.modeOf(e);
    this.setCursor(this.mode);
    const w = this.host.world;
    const u = this.undoable;
    const denyFloor = (): void => {
      u.error = TIP_NEED_FLOOR;
      this.tip(TIP_NEED_FLOOR);
      this.doDeniedSound();
    };
    if (!u.legalWallTile(v, 0)) {
      if (v.level < 2 || this.mode === WallMode.Delete) return;
      if (w.getFlags(v.x, v.y, v.level) & 1) return;
      denyFloor();
      return;
    }
    if (v.level > 1 && this.mode !== WallMode.Delete) {
      // lbl_105BBDF8 = { 8, 0, 4, 2 }: the four tiles around the vertex need a floor.
      const around: Array<[number, number]> = [
        [0, 0],
        [0, -1],
        [-1, -1],
        [-1, 0],
      ];
      let bad = 0;
      for (const [dx, dy] of around) {
        const x = v.x + dx;
        const y = v.y + dy;
        if (!w.inInterior(x, y) || !mayEditTile(w, x, y, v.level, this.host.placement.anywhere) || !(w.getFlags(x, y, v.level) & 1)) bad++;
      }
      if (bad === 4) {
        denyFloor();
        return;
      }
    }
    u.setOriginVertex(v);
    if (this.style === 1) u.setWallType(0xff, 0xff);
    else u.setWallType(this.style, this.pattern);
    u.mode = this.mode;
    this.clickVertex = { ...v };
    this.setCursorVertex(v);
    this.clickH = e.x;
    this.clickV = e.y;
    if (this.mode !== WallMode.Delete) this.host.playSound(SOUND_MOUSEDOWN);
  }

  /** cNewWallTool::Drag (`force`: OnKeyDown's replay of the same point). */
  override drag(e: ToolEvent, force = false): void {
    if (this.notDragging) return;
    const u = this.undoable;
    if (!this.editableTile(e)) {
      u.error = 1;
      this.tip(TIP_CANNOT_EDIT);
      return;
    }
    const mode = NewWallTool.modeOf(e);
    if (mode === this.mode) {
      if (!force && this.last && e.fx === this.last.fx && e.fy === this.last.fy) return;
    } else {
      this.mode = mode;
      this.setCursor(mode);
      const o = { ...u.origin };
      u.resetAll();
      u.mode = mode;
      u.setOriginVertex(o);
    }
    this.last = e;
    // Beyond half a tile from the click, a drag still on the clicked vertex leans to the next one.
    const s = this.host.viewer.scale;
    const tw = 16 << s;
    const th = 8 << s;
    const threshold = Math.trunc(Math.fround(tw * tw * 0.25 + th * th * 0.25));
    const dh = e.x - this.clickH;
    const dv = e.y - this.clickV;
    const dist2 = dh * dh + dv * dv;
    u.resetAll();
    let v = this.vertexOf(e);
    const c = this.clickVertex;
    if (v.x === c.x && v.y === c.y && v.level === c.level && threshold < dist2) v = u.computeArtificialDragPoint(c, dh, dv);
    if (!u.legalWallTile(v, 0)) v = { ...this.cursorVertex };
    const prevEnd = { ...u.end };
    u.adjustEndpointVertex(v);
    if (!this.setCursorVertex(u.end)) {
      u.adjustEndpointVertex(prevEnd);
      this.setCursorVertex(u.end);
    } else {
      this.host.dirty.wallsPreview(this.currentLevel());
    }
    if (u.error !== 0) this.tip(u.error);
    else if (u.cannotAfford) this.tip(TIP_NO_MONEY);
    else if (u.cost !== 0) this.tip(TIP_COST);
  }

  /** cNewWallTool::Release: the gesture becomes an undoable command. */
  override release(_e: ToolEvent): void {
    this.setToolTip(null);
    const u = this.undoable;
    if (u.cannotAfford) {
      u.resetAll();
      this.host.dirty.wallsPreview(this.currentLevel());
    } else if (!u.dirty) {
      u.reset();
    } else {
      if (this.mode !== WallMode.Delete) this.host.playSound(SOUND_MOUSEUP);
      else this.doExplodeSound();
      u.cleanupWallpaper();
      this.host.undo.submitUndoable(u);
      this.undoable = new WallUndoable(this.link);
      // GlobalDispatch(0x91, level) (and the level above from the ground floor): rooms, cutaway, lighting.
      const level = this.currentLevel();
      this.host.dirty.walls(level);
      if (level === 1) this.host.dirty.walls(2);
    }
    this.notDragging = true;
  }

  /** HouseViewer::RenderCursorObject for the Wall Cursor (cXObject::DrawIso at the vertex, world fixed point). */
  override drawOverlay(viewer: HouseViewer, comp: Compositor, rp: RenderParam): void {
    const sel = this.cursorSel;
    const r = this.cursorRenderer;
    if (!sel || !r || !this.cursorShown || !this.inWorld) return;
    const v = this.cursorVertex;
    if (v.level > viewer.level) return;
    const rot = (4 - viewer.world.rotation) & 3;
    const [fx, fy] = RotatableWorld.rotateCoords((v.x << 4) | 1, (v.y << 4) | 1, rot, 0x400);
    rp.setGridCoords(fx, fy, v.level);
    drawIso(new CursorDrawable(sel, r, fx, fy, v.level, getFrontDirection(viewer.world.rotation), CURSOR_GRAPHIC[this.mode] ?? 0, null), viewer, comp, rp);
  }
}
