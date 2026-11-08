/**
 * cGameTools (the 12 lot tools and the UndoManager), XViewer's mouse
 * dispatch to the current tool, and CPState::ArchSetCurrentTool's mapping of
 * the build panel's tool + product to a tool and its parameter.
 *
 * Tool ids (cGameTools::cGameTools):
 *   0 cDirtTool +1 (raise)   1 cDirtTool -1 (lower)   2 cNewWallTool
 *   3 cNewWallpaperTool      4 cLevelDirtTool         5 cNewFloorTool
 *   6 cObjPickerTool         7 cMoveTool              8 cTileTool
 *   9 cPoolTool              10 cWaterTool            11 cGrassTool
 *
 * ArchSetCurrentTool (jump table lbl_105BC0B8), per CPState::ArchTools:
 *   Terrain: product button 0 -> tool 0, 1 -> 1, 2 -> 4, 3 -> 11 (param 0)
 *   Water: button 0 -> tool 9, 1 -> 10, else the object product -> tool 7
 *   Wall: product kind 3 -> tool 2 (param = wall style +0x30), else object -> 7
 *   Wallpaper: tool 3 (param = wallpaper +0x2c)
 *   Floor: tool 5 (param = floor style +0x34)
 *   Stair / Fireplace / Plant / Door / Window: the object product -> tool 7
 *   Roof: no tool (the roof panel)        Hand: tool 7, param -1
 */

import { ArchTool, type ArchProduct } from "../../cpstate.js";
import type { Compositor } from "../compositor.js";
import type { HouseViewer } from "../houseviewer.js";
import type { ObjSelector } from "../objselector.js";
import type { RenderParam } from "../renderparam.js";
import type { MoveTool } from "./movetool.js";
import { PickMode, pointToObjectId } from "./picking.js";
import { Tool, type ToolEvent, type ToolHost } from "./tool.js";
import { UndoManager } from "./undo.js";

export const ToolId = {
  DirtRaise: 0,
  DirtLower: 1,
  Wall: 2,
  Wallpaper: 3,
  LevelDirt: 4,
  Floor: 5,
  ObjPicker: 6,
  Move: 7,
  Tile: 8,
  Pool: 9,
  Water: 10,
  Grass: 11,
} as const;

/** GViewer::PointToTile(pt, true): the view fixed-point position under a screen point. */
export function pointToFTile(viewer: HouseViewer, px: number, py: number, level: number): { fx: number; fy: number } {
  const t = viewer.pointToWholeTile(px, py, level);
  const o = viewer.tileToPoint(t.x, t.y, level);
  const ax = viewer.tileToPoint(t.x + 1, t.y, level);
  const ay = viewer.tileToPoint(t.x, t.y + 1, level);
  const a = ax.h - o.h;
  const b = ay.h - o.h;
  const c = ax.v - o.v;
  const d = ay.v - o.v;
  const det = a * d - b * c;
  let u = 0.5;
  let w = 0.5;
  if (det !== 0) {
    const dh = px - o.h;
    const dv = py - o.v;
    u = (dh * d - b * dv) / det;
    w = (a * dv - c * dh) / det;
  }
  const f = (v: number): number => Math.min(15, Math.max(0, Math.trunc(v * 16)));
  return { fx: (t.x << 4) + f(u), fy: (t.y << 4) + f(w) };
}

/** cMoveTool as a cGameTools tool (it keeps its own screen-point interface). */
export class MoveToolAdapter extends Tool {
  constructor(
    host: ToolHost,
    readonly move: MoveTool,
  ) {
    super(host);
    this.expenseType = 6;
  }
  override needsObject(): boolean {
    return true;
  }
  override rapidFire(): boolean {
    return true;
  }
  override resetGrabPoint(): void {
    this.move.resetGrabPoint();
  }
  override select(): void {
    this.move.select();
  }
  override deselect(): void {
    this.move.deselect();
  }
  override float(e: ToolEvent): void {
    this.move.float(e.x, e.y);
  }
  override click(e: ToolEvent): void {
    this.move.click(e.x, e.y);
  }
  override drag(e: ToolEvent): void {
    this.move.drag(e.x, e.y);
  }
  override release(e: ToolEvent): void {
    this.move.release(e.x, e.y);
  }
  override onKeyDown(key: string): boolean {
    return this.move.onKeyDown(key);
  }
  override onKeyUp(key: string): boolean {
    return this.move.onKeyUp(key);
  }
  override onChar(ch: string): boolean {
    return this.move.onChar(ch);
  }
  override onEnterWorld(): void {
    this.move.onEnterWorld();
  }
  override onExitWorld(): void {
    this.move.onExitWorld();
  }
  override cancel(): void {
    this.move.cancel();
  }
}

/** What the tool slots hold; the build tools fill them as they are ported. */
export type ToolFactory = (host: ToolHost) => Tool;

export class GameTools {
  /** +8 */
  readonly undo: UndoManager;
  /** cGameTools' tool array (null = not ported). */
  readonly tools: Array<Tool | null> = Array.from({ length: 12 }, () => null);
  /** XViewer's current tool (lbl_105BA4A8) and its parameter (CPState +0x3c / +0x40). */
  current: Tool | null = null;
  param = 0;
  /** Last point given to Drag (XViewer skips drags on the same point unless RapidFire). */
  private lastFx = -1;
  private lastFy = -1;
  private buttonDown = false;
  private mouseInWorld = false;
  /** Bumped by every ArchSetCurrentTool (async object lookups check it). */
  private archTicket = 0;

  constructor(
    readonly host: ToolHost,
    readonly moveTool: MoveToolAdapter,
    /** ObjectFolder::GetSelectorByGUID (+ the simulator's semi-globals). */
    private readonly selectorByGUID: (guid: number) => Promise<ObjSelector | null>,
  ) {
    this.undo = host.undo;
    this.tools[ToolId.Move] = moveTool;
  }

  getToolByID(id: number): Tool | null {
    return id >= 0 && id < 12 ? this.tools[id]! : null;
  }

  /** XViewer::IssueToolSelection: Deselect the old tool, Select the new one. */
  issueToolSelection(t: Tool | null): void {
    if (this.current === t) return;
    this.current?.deselect();
    this.current = t;
    // cTool::Select: the arrow, before the tool's own cursor.
    this.host.setToolCursor?.(0);
    t?.select();
    if (t && this.mouseInWorld) t.onEnterWorld();
    this.host.invalidate();
  }

  /** CPState::SetCurrentToolByID: cancel the current tool, SetParameter on the new one. */
  setCurrentToolByID(id: number, param: number): void {
    const t = this.getToolByID(id);
    this.current?.cancel();
    t?.setParameter(param);
    this.param = param;
    this.issueToolSelection(t);
  }

  /** CPState::ArchSetCurrentTool's tool part. */
  archSetCurrentTool(tool: ArchTool, product: ArchProduct | null): void {
    const ticket = ++this.archTicket;
    const byButton = (ids: readonly number[]): boolean => {
      const id = product ? ids[product.toolIndex] : undefined;
      if (id === undefined) return false;
      this.setCurrentToolByID(id, 0);
      return true;
    };
    const objectProduct = (): void => {
      if (!product || !product.guid) {
        this.setCurrentToolByID(ToolId.Move, -1);
        this.moveTool.move.setParameter(null);
        return;
      }
      void this.selectorByGUID(product.guid).then((sel) => {
        if (ticket !== this.archTicket) return;
        this.setCurrentToolByID(ToolId.Move, -1);
        this.moveTool.move.setParameter(sel);
        if (this.mouseInWorld) this.moveTool.onEnterWorld();
      });
    };
    switch (tool) {
      case ArchTool.Terrain:
        if (!byButton([ToolId.DirtRaise, ToolId.DirtLower, ToolId.LevelDirt, ToolId.Grass])) this.issueToolSelection(null);
        return;
      case ArchTool.Water:
        if (!byButton([ToolId.Pool, ToolId.Water])) objectProduct();
        return;
      case ArchTool.Wall:
        if (product && product.kind === 3) this.setCurrentToolByID(ToolId.Wall, product.wallStyle);
        else objectProduct();
        return;
      case ArchTool.Wallpaper:
        if (product) this.setCurrentToolByID(ToolId.Wallpaper, product.wallpaper);
        return;
      case ArchTool.Floor:
        if (product) this.setCurrentToolByID(ToolId.Floor, product.floorStyle);
        return;
      case ArchTool.Stair:
      case ArchTool.Fireplace:
      case ArchTool.Plant:
      case ArchTool.Door:
      case ArchTool.Window:
        objectProduct();
        return;
      case ArchTool.Roof:
        this.current?.cancel();
        this.issueToolSelection(null);
        return;
      case ArchTool.Hand:
        this.setCurrentToolByID(ToolId.Move, -1);
        this.moveTool.move.setParameter(null);
        return;
    }
  }

  private event(x: number, y: number, needsObject: boolean): ToolEvent {
    const v = this.host.viewer;
    const level = v.level || 1;
    const t = pointToFTile(v, x, y, level);
    // cMoveTool runs its own PointToObjectID on the screen point.
    const objectId =
      needsObject && this.current !== this.moveTool
        ? pointToObjectId(v, this.host.placement, (r) => this.host.lot.renderer(r), x, y, level, PickMode.Any)
        : 0;
    const k = this.host.keys();
    return { x, y, fx: t.fx, fy: t.fy, objectId, shift: k.shift, ctrl: k.ctrl };
  }

  /** XViewer::MouseTrack. */
  mouseTrack(x: number, y: number): void {
    const t = this.current;
    if (!t) return;
    const e = this.event(x, y, t.needsObject());
    if (this.buttonDown) {
      // The last point a Drag saw (lbl_105BA4A4), compared whole (fixed point).
      if (!t.rapidFire() && e.fx === this.lastFx && e.fy === this.lastFy) return;
      this.lastFx = e.fx;
      this.lastFy = e.fy;
      t.drag(e);
    } else {
      t.float(e);
    }
  }

  /** XViewer::MouseDown (single clicks; DoubleClick is not distinguished). */
  mouseDown(x: number, y: number): void {
    const t = this.current;
    if (!t) return;
    this.buttonDown = true;
    const e = this.event(x, y, t.needsObject());
    // No Drag seen yet: the MouseTrack after the Click drags at the click point.
    this.lastFx = -1;
    this.lastFy = -1;
    t.click(e);
    this.mouseTrack(x, y);
  }

  /** XViewer::MouseUp: Release, then the running total is paid. */
  mouseUp(x: number, y: number): void {
    const t = this.current;
    this.buttonDown = false;
    if (!t) return;
    t.release(this.event(x, y, t.needsObject()));
    if (t.runningTotal !== 0) {
      t.doKachingSound();
      t.finalizePurchase();
    }
  }

  enterWorld(): void {
    this.mouseInWorld = true;
    this.current?.onEnterWorld();
  }

  exitWorld(): void {
    this.mouseInWorld = false;
    this.buttonDown = false;
    this.current?.onExitWorld();
  }

  keyDown(key: string): boolean {
    const t = this.current;
    if (!t) return false;
    return t.onKeyDown(key) || t.onChar(key);
  }

  keyUp(key: string): boolean {
    return this.current?.onKeyUp(key) ?? false;
  }

  /** The current tool's overlay (HouseViewer::RenderCursorObject's place in the frame). */
  drawOverlay(viewer: HouseViewer, comp: Compositor, rp: RenderParam): void {
    this.current?.drawOverlay?.(viewer, comp, rp);
  }
}
