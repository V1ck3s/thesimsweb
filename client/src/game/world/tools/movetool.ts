/**
 * cMoveTool (cGameTools tool 7): the buy mode tool. Without a parameter it is
 * the hand: click an object to pick it up, move it, drop it, sell it with
 * Delete. With a catalog product (SetParameter) it buys new objects: the
 * product follows the mouse on a Tile Cursor (cursorobject.ts) until a click
 * places and pays for it.
 *
 * Driven by XViewer (winlotview.ts): mouse moves -> Float (Drag while the
 * button is down), button down -> Click, button up -> Release, plus
 * OnKeyDown / OnChar and OnEnterWorld / OnExitWorld.
 *
 * Stairs (mode 5): FixFloorForStairs floors (or unfloors) the tiles the
 * stairs need when they do not fit as they are; the change is the held
 * object undoable's post sub-undoable, taken back on the next Float
 * (FlushPostSubUndoables) and kept when the stairs are dropped.
 *
 * Not ported: the undo manager (ObjectUndoable; Esc restores a picked-up
 * object to where it was instead of undoing), object hilites (SetHilite),
 * the flip cursor of portals (+0x7a), the ctrl-delete branch of doors and
 * windows.
 */

import type { HouseViewer } from "../houseviewer.js";
import type { ResFile } from "../iffres.js";
import type { ObjectFolder } from "../objectfolder.js";
import { OD, type XObject } from "../objects.js";
import type { ObjSelector } from "../objselector.js";
import type { Renderer } from "../renderer.js";
import { RotatableWorld } from "../world.js";
import { getFrontDirection, XCursorObject } from "./cursorobject.js";
import { killObject, makeNewOutOfWorldObject } from "./objectfactory.js";
import { pointToObjectId, PickMode } from "./picking.js";
import { Placement, tileOf, type FPt, type PlacementSpec } from "./placement.js";
import { FloorUndoable, type FloorUndoTool } from "./floorundo.js";
import { tileIsFloorable, tileIsUnfloorable } from "./floortool.js";
import { setFloor } from "./worldedit.js";
import type { DisposeItem } from "../../cpstate.js";

/** cMoveTool+0x34. */
export const MoveMode = {
  Hand: 1,
  Buy: 2,
  /** Build mode lists (SetParameter / UpdateSelector), by OBJD build mode type + 2. */
  Door: 3,
  Window: 4,
  Stair: 5,
  Plant: 6,
  Fireplace: 7,
  Column: 8,
  PoolEquipment: 9,
} as const;

/** OBJD +0x8a build mode type -> cMoveTool mode (the lists lbl_105BBDDC .. lbl_105BBDC4), else 0. */
export function buildModeOf(sel: ObjSelector): number {
  const t = sel.objd.i16(0x8a);
  return t >= 1 && t <= 7 ? t + 2 : 0;
}

/** Placement error codes the tool sets itself (UIText STR# 137 "PlacementErrs", index code - 1). */
export const PlacementErr = {
  /** ShowPlacementTip(0x1a): the purchase total, formatted as money. */
  purchaseTotal: 0x1a,
  notEnoughMoney: 0x15,
  firstFloorOnly: 0x1f,
} as const;

/** cTool sound events (lbl_105BBE58) and cMoveTool's own (lbl_105BBDB0). */
export const ToolSound = {
  rotate: "UI_object_rotate",
  explode: "UI_archtool_delete",
  refund: "UI_moneyback",
  kaching: "UI_buy_moneyback",
  denied: "UI_error",
  place: "UI_object_place",
  movePlace: "UI_object_move_place",
  move: "UI_object_move",
} as const;

/** lbl_105BBDB8: UpdateCursor's rotate cursor by drag quadrant (+0x7c): NE, -, SE, -, SW, -, NW. */
const ROTATE_CURSORS = [0xe, 0xc, 0x10, 0xc, 0xf, 0xc, 0xd];

/** lbl_105BBDE4: refund = trunc(0.8 * value + 0.5) for build items. */
const BUILD_REFUND = Math.fround(0.8);

/** What the tool needs from the game (cSimulator, CPState, cDDDSimsView, cSoundPlayer). */
export interface MoveToolHost {
  readonly viewer: HouseViewer;
  readonly placement: Placement;
  readonly folder: ObjectFolder;
  /** ObjectFolder::GetSelectorByName("Tile Cursor"). */
  readonly cursorSelector: ObjSelector;
  renderer(res: ResFile): Renderer;
  /** A person's drawn rectangle (GViewer::PointToObjectID reaches people through it); none: people are not picked. */
  personRect?(o: XObject): [number, number, number, number] | null;
  /** Global 19 (the mode freeze: 0 Live, 1 Build, 2 Buy) PointToObjectID reads. */
  modeFreeze?(): number;
  /** cSimulator::GetFunds / Spend. */
  getFunds(): number;
  spend(amount: number, expense?: number): void;
  /** CPState::ShopSoldItem. */
  shopSoldItem(): void;
  /** cDDDSimsView::SetTip / ResetTip (screen position in view pixels). */
  setTip(x: number, y: number, text: string): void;
  resetTip(): void;
  /** The placement error strings (STR# 137, index code - 1); empty when missing. */
  placementErrorText(code: number): string;
  /** cSoundPlayer::PlayBySource(event). */
  playSound?(event: string): void;
  /** _GetKeyState(VK_SHIFT / VK_CONTROL). */
  shiftDown(): boolean;
  ctrlDown?(): boolean;
  /** CPState::StartDisposing / StopDisposing: the control panel's sell page (cWinDisposePopup). */
  startDisposing?(item: DisposeItem): void;
  stopDisposing?(): void;
  /** cDDDSimsView::SetToolCursor (ui/cursor.ts ids). */
  setToolCursor?(id: number): void;
  /** CPState::ArchGetCurrentFloorStyle (FixFloorForStairs' floor); 1 when missing. */
  currentFloorStyle?(): number;
  /** GlobalDispatch(0x91, 0): cFixedWorld::ComputeRooms on every level (floors changed). */
  computeRooms?(): void;
  /** The view needs repainting. */
  invalidate(): void;
}

/** Where a picked-up object came from (for Esc). */
interface OrigSite {
  obj: XObject;
  at: FPt;
  level: number;
  dir: number;
  container: XObject | null;
  slot: number;
}

export class MoveTool implements FloorUndoTool {
  /** +0x34 */
  mode: number = MoveMode.Hand;
  /** +0x3c */
  cursor: XCursorObject | null = null;
  /** +0x40: the direction new objects face. */
  private frontDir = 0;
  /** +0x44 / +0x48: the catalog selector, and the one the front direction was computed for. */
  selector: ObjSelector | null = null;
  private lastSelector: ObjSelector | null = null;
  /** +0x50 / +0x54: grab offset (v, h) from the object's tile top to the mouse. */
  private grabV = 0;
  private grabH = 0;
  /** +0x5c / +0x60: mouse down point; +0x64 / +0x68: last release point; +0x6c / +0x70: last float point. */
  private clickH = 0;
  private clickV = 0;
  private releaseH = 0;
  private releaseV = 0;
  private floatH = 0;
  private floatV = 0;
  /** +0x74: mouse button down (since Click). */
  private clicked = false;
  /** +0x75: placing a new purchase. */
  newPurchase = false;
  /** +0x76: keep buying after a placement (OBJD +0xc0 == 1). */
  private keepBuying = false;
  /** +0x77: build mode item (80 % refund); +0x78: refundable at all. */
  private buildItem = false;
  private refundable = true;
  /** +0xad: plants go on the ground floor only. */
  private firstFloorOnly = false;
  /** cTool +0x20: 6 furnishings, 7 build items (OBJD +0x8a). */
  expenseType = 6;
  /** cTool +0x24: doors and windows open the dynamic cutaway around the cursor. */
  adjustsCutaway = false;
  /** +0x7b: the button is down with an object (drag rotates); +0x7c: rotation quadrant. */
  private mouseRotate = false;
  private rotateDir = -1;
  /** +0x80: the grabbed object can't be placed (0x80 is never set by the ported paths). */
  private cantGrab = false;
  /** +0x81: the next release attempts a drop; +0x88 moved since the last release; +0x89 just grabbed. */
  private attemptDrop = false;
  private moved = false;
  private justGrabbed = false;
  /** +0x98: the control panel shows the sell page for the held object. */
  private disposing = false;
  /** +0x90: price of the held new object. */
  private price = 0;
  /** +0x95 / +0x96: placement valid (feedback). */
  private validFeedback = false;
  private lastValidFeedback = false;
  /** +0x97: the mouse is in the world. */
  private inWorld = true;
  /** cTool +0x1c: running total of this purchase. */
  private runningTotal = 0;
  /** lbl_105BA550 / lbl_105BA534: where the tip was shown (-1 = no tip). */
  private tipX = -1;
  private tipY = 0;
  /** Last mouse position given to the tool (GetCursorScreenPosition). */
  private mouseX = 0;
  private mouseY = 0;
  /** cTool +0..+0x18: time of the last play of each tool sound (400 ms apart). */
  private readonly soundTimes = new Map<string, number>();
  private orig: OrigSite | null = null;
  /** +0x4c: the hilited object (kept for the hand's hover; hilites are not drawn). */
  hiliteId = 0;
  /** FixFloorForStairs' FloorUndoable, the post sub-undoable of the held object's undoable (+0x30). */
  private stairFloor: FloorUndoable | null = null;
  /** lbl_105BA4B8: floors changed since the last room computation. */
  floorsChanged = false;

  constructor(private readonly host: MoveToolHost) {}

  private get p(): Placement {
    return this.host.placement;
  }

  /** cTool::GetCurrentLevel. */
  private level(): number {
    return this.host.viewer.level;
  }

  private play(event: string, rateLimited = true): void {
    const now = performance.now();
    if (rateLimited) {
      const last = this.soundTimes.get(event) ?? -1e9;
      if (now < last + 400) return;
      this.soundTimes.set(event, now);
    }
    this.host.playSound?.(event);
  }

  /** cTool::FinalizePurchase: cSimulator::Spend(running total). */
  finalizePurchase(): void {
    if (this.runningTotal !== 0) this.host.spend(this.runningTotal, this.expenseType);
    this.runningTotal = 0;
  }

  /** cTool::Purchase / Refund (FloorUndoable's tool). */
  purchase(n: number): void {
    this.runningTotal += n;
  }

  refund(n: number): void {
    this.runningTotal -= n;
  }

  /** GViewer::DirtyFloor. */
  dirtyFloor(): void {
    this.host.invalidate();
  }

  private cursorValid(): boolean {
    const c = this.cursor;
    return !!c && !!c.anchor && c.valid;
  }

  // --- parameter / selection --------------------------------------------------------

  /**
   * cMoveTool::SetParameter: a catalog selector (buy mode), or null for the
   * hand. Build mode's lists (modes 3..9) are not ported.
   */
  setParameter(sel: ObjSelector | null): void {
    this.cancel();
    this.buildItem = false;
    this.keepBuying = false;
    this.refundable = true;
    this.firstFloorOnly = false;
    this.adjustsCutaway = false;
    const build = sel ? buildModeOf(sel) : 0;
    if (sel && build !== 0) {
      // SetParameter's build lists: keep buying; plants are not refundable and first floor only.
      this.mode = build;
      this.newPurchase = true;
      this.keepBuying = true;
      this.buildItem = true;
      this.refundable = build !== MoveMode.Plant;
      this.firstFloorOnly = build === MoveMode.Plant;
      this.adjustsCutaway = build === MoveMode.Door || build === MoveMode.Window;
      this.selector = sel;
      this.expenseType = 7;
      this.grabV = 0;
      this.grabH = 0;
      return;
    }
    if (!sel) {
      this.mode = MoveMode.Hand;
      this.newPurchase = false;
    } else {
      this.mode = MoveMode.Buy;
      this.newPurchase = true;
    }
    if (sel !== this.selector) {
      this.selector = sel;
      this.expenseType = sel && sel.objd.i16(0x8a) !== 0 ? 7 : 6;
      // CPState +0x44 == 0: the simulator's "not in a community lot" check is assumed.
      if (sel && sel.objd.i16(0xc0) === 1) this.keepBuying = true;
    }
    this.grabV = 0;
    this.grabH = 0;
  }

  /** cMoveTool::Select: a new purchase gets its object and cursor. */
  select(): void {
    if (!this.newPurchase || !this.selector) return;
    this.deselect();
    if (this.selector !== this.lastSelector) this.frontDir = getFrontDirection(this.host.viewer.world.rotation);
    this.lastSelector = this.selector;
    const sel = this.selector;
    if (sel.objd.i16(0x24) > this.host.getFunds()) return;
    const obj = makeNewOutOfWorldObject(this.p, this.host.folder, sel);
    if (!obj) return;
    const c = XCursorObject.makeMouseObject(this.p, obj, this.host.cursorSelector, this.level(), () => this.host.getFunds() - this.runningTotal, true);
    if (!c) {
      killObject(this.p, obj);
      return;
    }
    this.cursor = c;
    c.faceDirection(this.frontDir);
    this.price = c.getFloaterPrice();
    this.inWorld = false;
    this.validFeedback = false;
    this.lastValidFeedback = false;
    this.host.invalidate();
    this.updateCursor();
  }

  /**
   * cMoveTool::UpdateCursor: Ctrl over a door or window (build item) is the
   * delete cursor; else rotate while +0x80, the hand (SimsMove) with nothing
   * held, the drag-rotation arrows, or the place cursor.
   */
  private updateCursor(): void {
    const set = this.host.setToolCursor;
    if (!set) return;
    const ctrlDelete = !!this.host.ctrlDown?.() && (this.mode === MoveMode.Door || this.mode === MoveMode.Window);
    let id: number;
    if (this.buildItem && ctrlDelete) id = 6;
    else if (this.cantGrab) id = 0xc;
    else if (!this.cursor) id = 10;
    else if (this.mouseRotate) id = ROTATE_CURSORS[this.rotateDir] ?? 0xc;
    else id = 0xb;
    set.call(this.host, id);
  }

  /**
   * cMoveTool::Deselect: the cursor goes away. A new purchase that was not
   * placed is destroyed; a picked-up object still held is deleted (the
   * original submits it as a delete undoable; the refund was already given).
   */
  deselect(): void {
    const c = this.cursor;
    // The held object's undoable goes with its stairs floors (they stay only with DropObject).
    this.flushStairFloor();
    if (c) {
      const f = c.floater;
      c.pickup(true);
      if (f) killObject(this.p, f);
      c.detachFloater();
    }
    this.cursor = null;
    this.orig = null;
    this.hiliteId = 0;
    this.stopDisposing();
    this.host.invalidate();
    this.updateCursor();
  }

  /** cMoveTool::Cancel (Esc): a picked-up object goes back where it was (UndoLastCommand). */
  cancel(): void {
    this.flushStairFloor();
    const c = this.cursor;
    if (!this.newPurchase && c?.anchor && this.orig) {
      const o = this.orig;
      c.pickup(true);
      c.detachFloater();
      const head = this.p.chain(o.obj)[0]!;
      for (let i = 0; i < 8 && o.obj.dir !== o.dir; i++) this.p.turnObject(head, 1);
      this.p.assignOffsets(head);
      for (const part of this.p.chain(head)) part.simFlags |= 1;
      this.p.userPlace(o.obj, o.at, o.level, o.container, o.slot);
      this.orig = null;
    }
    this.deselect();
    this.selector = null;
    this.mode = MoveMode.Hand;
    this.clicked = false;
    this.buildItem = false;
    this.refundable = false;
    this.keepBuying = false;
    this.mouseRotate = false;
    this.rotateDir = -1;
    this.attemptDrop = false;
    this.moved = false;
    this.justGrabbed = false;
    this.price = 0;
    this.newPurchase = false;
    this.validFeedback = false;
    this.lastValidFeedback = false;
    this.inWorld = true;
  }

  /** cMoveTool::OnEnterWorld. */
  onEnterWorld(): void {
    this.select();
    this.inWorld = true;
  }

  /** cMoveTool::OnExitWorld: the cursor leaves the lot with the mouse. */
  onExitWorld(): void {
    this.inWorld = false;
    this.cursor?.pickup(true);
    this.resetTip();
    this.host.invalidate();
  }

  // --- tips -----------------------------------------------------------------------

  /** cMoveTool::ShowPlacementTip. */
  private showPlacementTip(code: number, amount = 0): void {
    if (code === 0) {
      this.resetTip();
      return;
    }
    this.tipX = this.mouseX;
    this.tipY = this.mouseY;
    let text = "Can't place here!";
    if (code === PlacementErr.purchaseTotal) {
      // The control panel's money formatter (lbl_105BA104 vtable +0x84).
      text = `§${amount.toLocaleString("en-US")}`;
    } else {
      text = this.host.placementErrorText(code) || text;
    }
    this.host.setTip(this.mouseX + 0x11, this.mouseY - 5, text);
  }

  private resetTip(): void {
    this.host.resetTip();
    this.tipX = -1;
  }

  /** Float's tip check: the tip goes away once the mouse moved more than 4 pixels from it. */
  private expireTip(): void {
    if (this.tipX !== -1) {
      const dx = this.mouseX - this.tipX;
      const dy = this.mouseY - this.tipY;
      if (dx * dx + dy * dy > 0x10) this.tipX = -1;
    }
    if (this.tipX === -1) this.resetTip();
  }

  // --- mouse ------------------------------------------------------------------------

  /** The fixed-point view position under a screen point (GViewer::PointToTile(pt, true)). */
  private pointToTile(px: number, py: number): { fx: number; fy: number } {
    const v = this.host.viewer;
    const lvl = this.level();
    const t = v.pointToWholeTile(px, py, lvl);
    // Fraction inside the tile from its corners (TileToPoint of the tile and its +x / +y neighbors).
    const o = v.tileToPoint(t.x, t.y, lvl);
    const ax = v.tileToPoint(t.x + 1, t.y, lvl);
    const ay = v.tileToPoint(t.x, t.y + 1, lvl);
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
    const clamp = (f: number): number => Math.min(15, Math.max(0, Math.trunc(f * 16)));
    return { fx: (t.x << 4) + clamp(u), fy: (t.y << 4) + clamp(w) };
  }

  /** View fixed point -> world fixed point. */
  private toWorld(p: { fx: number; fy: number }): FPt {
    const rot = this.host.viewer.world.rotation;
    const [fx, fy] = RotatableWorld.rotateCoords(p.fx, p.fy, (4 - rot) & 3, 0x400);
    return { fx, fy };
  }

  /** XViewer::MouseTrack's PointToObjectID (mode 1). */
  objectUnder(px: number, py: number, mode: number = PickMode.Any): number {
    const h = this.host;
    return pointToObjectId(h.viewer, this.p, (r) => h.renderer(r), px, py, this.level(), mode, h.personRect ? (o) => h.personRect!(o) : null, h.modeFreeze?.() ?? 1);
  }

  /** cMoveTool::Float (and Drag, which is Float with the button down). */
  float(px: number, py: number): void {
    try {
      this.floatTool(px, py);
    } finally {
      this.updateCursor();
    }
  }

  private floatTool(px: number, py: number): void {
    this.mouseX = px;
    this.mouseY = py;
    const c = this.cursor;
    if (!c) {
      const id = this.objectUnder(px, py);
      if (id === 0) {
        this.hiliteId = 0;
        this.cantGrab = false;
        this.expireTip();
      } else {
        this.hiliteId = id;
      }
      return;
    }
    const spec = c.anchor ? this.p.getPlacementSpec(c.anchor) : null;
    const slot = spec?.container ? spec.slot : 0;
    this.expireTip();
    const last = c.lastAnchor;
    if (c.inWorld) c.pickup(true);
    if (!this.inWorld) {
      this.host.invalidate();
      return;
    }
    const level = this.level();
    this.floatH = px;
    this.floatV = py;
    // The previous Float's stairs floors go (FlushPostSubUndoables), then back where it was, maybe rotated by a drag.
    this.flushStairFloor();
    c.place(last, level, slot);
    if (this.mouseRotate) {
      const dh = this.floatH - this.clickH;
      const dv = this.floatV - this.clickV;
      if (dh * dh + dv * dv > 0x24) {
        this.cantGrab = false;
        this.rotateDir = dh < 0 ? (dv < 0 ? 6 : 4) : dv < 0 ? 0 : 2;
        const f = c.anchor;
        const want = (this.rotateDir - this.host.viewer.world.rotation * 2) & 7;
        if (f && want !== f.dir) {
          c.faceDirection((want - Placement.getFrontFaceDirection(f)) & 7);
          this.lastValidFeedback = true;
          this.play(ToolSound.rotate);
        }
        if (!this.cursorValid() && this.mode === MoveMode.Stair && this.fixFloorForStairs()) {
          if (c.canPlace(last, level, null)) c.place(last, level, 0);
          if (!this.cursorValid()) this.flushStairFloor();
        }
        if (c.canPlace(last, level, null)) c.place(last, level, slot);
        this.updatePlacementFeedback();
        if (this.cursorValid() || !this.clicked) this.resetTip();
        else this.showPlacementTip(this.p.error);
        this.host.invalidate();
        return;
      }
      this.rotateDir = -1;
    }
    const raw = this.toWorld(this.pointToTile(px - this.grabH, py - this.grabV));
    const at: FPt = { fx: (raw.fx & ~0xf) | 8, fy: (raw.fy & ~0xf) | 8 };
    this.validFeedback = false;
    if (c.inWorld) c.pickup(true);
    const f = c.anchor;
    if (f && f.objectId !== this.hiliteId) this.hiliteId = f.objectId;
    const tx = at.fx >> 4;
    const ty = at.fy >> 4;
    const size = this.p.world.size;
    if (tx < 1 || tx >= size - 1 || ty < 1 || ty >= size - 1) {
      this.host.invalidate();
      return;
    }
    let invalid = false;
    let error = 0;
    if (!c.canPlace(at, level, null)) invalid = true;
    else {
      c.place(at, level, slot);
      if (this.cursorValid()) {
        // Fits as it is.
      } else if (this.mode === MoveMode.Stair) {
        // Stairs get the floors they need, else they do not fit (the first placement's error stays).
        if (!this.fixFloorForStairs()) invalid = true;
        else {
          c.place(at, level, slot);
          if (!this.cursorValid()) {
            invalid = true;
            error = this.p.error;
            this.flushStairFloor();
          }
        }
      } else if (!this.turnToWall() && !this.cursorValid()) invalid = true;
    }
    if (invalid) {
      // The cursor shows where the mouse is, unsnapped.
      if (c.canPlace(raw, level, null)) c.place(raw, level, 0);
      else c.pickup(true);
      if (error !== 0) this.p.error = error;
    }
    this.updatePlacementFeedback();
    this.host.invalidate();
  }

  /** cMoveTool::TurnToWall: try every rotation, keep the first that fits. */
  private turnToWall(): boolean {
    const c = this.cursor;
    const f = c?.anchor;
    if (!c || !f || !this.p.shouldAutoRotate(f)) return false;
    const notches = Placement.od(f, 23) || 2;
    for (let i = 1; i < Math.trunc(8 / notches); i++) {
      c.turn(i);
      if (this.cursorValid()) return true;
      c.turn(-i);
    }
    return false;
  }

  /**
   * cMoveTool::FixFloorForStairs: the floors under the stairs' parts as the
   * parts want them. A part that can't stand on a floor (placement flags
   * bit 0 clear) has the floor under it taken away (the tile must be
   * unfloorable; refund trunc(0.8 * price + 0.5)); an upper level part not
   * in the air (bit 0x200 clear) gets a floor of the build panel's floor
   * style where there is none (the tile must be floorable, see
   * cFixedWorld::ComputeRooms, and the family afford it with the stairs).
   * True when nothing needs a change, or when every change was made: a
   * FloorUndoable the next Float takes back unless the stairs are dropped.
   * False (nothing changed) when a tile can't be fixed.
   */
  private fixFloorForStairs(): boolean {
    const c = this.cursor;
    if (!c) return false;
    const w = this.host.viewer.world;
    const fixed = w.fixed;
    const gfx = this.host.viewer.floors;
    const style = this.host.currentFloorStyle?.() || 1;
    const funds = this.host.getFunds();
    const size = this.p.world.size;
    const tiles: Array<{ x: number; y: number; level: number; flags: number }> = [];
    let count = 0;
    let total = 0;
    for (const part of c.parts()) {
      const x = tileOf(c.headFx + part.ox * 16);
      const y = tileOf(c.headFy + part.oy * 16);
      const level = c.level + part.ol;
      if (x < 1 || x >= size - 1 || y < 1 || y >= size - 1) return false;
      if (!part.obj || level < 1 || level > fixed.floors.length) return false;
      const flags = Placement.od(part.obj, OD.placementFlags) & 0xffff;
      const floor = fixed.floors[level - 1]!.u16(x, y);
      const [vx, vy] = w.toView(x, y);
      if (!(flags & 1) && floor !== 0) {
        count++;
        total += gfx.getFloorCost(floor);
        if (!tileIsUnfloorable(w, this.p, vx, vy, level)) return false;
      }
      if (!(flags & 0x200) && floor === 0 && level > 1) {
        count++;
        total += gfx.getFloorCost(style);
        if (funds < total + this.price || !tileIsFloorable(w, this.p, vx, vy, level)) return false;
      }
      tiles.push({ x: vx, y: vy, level, flags });
    }
    if (count === 0) return true;
    const undo = new FloorUndoable(w, this);
    for (const t of tiles) {
      const floor = w.getFloor(t.x, t.y, t.level);
      if (!(t.flags & 1) && floor !== 0) {
        const refund = -Math.trunc(Math.fround(BUILD_REFUND * gfx.getFloorCost(floor)) + 0.5);
        undo.addChange(t.x, t.y, t.level, floor, false, refund);
        setFloor(w, t.x, t.y, t.level, 0);
        this.floorsChanged = true;
        this.dirtyFloor();
        this.purchase(refund);
      }
      if (!(t.flags & 0x200) && w.getFloor(t.x, t.y, t.level) === 0 && t.level > 1) {
        const cost = gfx.getFloorCost(style);
        undo.addChange(t.x, t.y, t.level, 0, false, cost);
        setFloor(w, t.x, t.y, t.level, style);
        this.floorsChanged = true;
        this.dirtyFloor();
        this.purchase(cost);
      }
    }
    // AddPostSubUndoable on the held object's undoable.
    this.stairFloor = undo;
    return true;
  }

  /** The held object undoable's FlushPostSubUndoables: FixFloorForStairs' floors come back off. */
  private flushStairFloor(): void {
    const u = this.stairFloor;
    if (!u) return;
    this.stairFloor = null;
    u.undoSelf();
  }

  /** cMoveTool::UpdatePlacementFeedback. */
  private updatePlacementFeedback(): void {
    if (!this.cursor) return;
    this.validFeedback = this.cursorValid();
    this.lastValidFeedback = this.validFeedback;
  }

  /** cMoveTool::Click. */
  click(px: number, py: number): void {
    this.float(px, py);
    this.clicked = true;
    this.attemptDrop = false;
    this.justGrabbed = false;
    this.moved = false;
    this.clickH = px;
    this.clickV = py;
    this.mouseRotate = true;
    this.rotateDir = -1;
    const c = this.cursor;
    if (!c) {
      const id = this.objectUnder(px, py);
      const obj = this.p.get(id);
      if (!obj) {
        if (this.level() !== 1) {
          // The upper floor has no floor under the mouse: "needs a floor" (0x1f) when GetFloor is empty (not checked here).
        }
      } else if (!this.p.userCanPickup(obj)) {
        if (this.p.error !== 0) this.showPlacementTip(this.p.error);
      } else {
        this.grabObject(obj, px, py);
        this.releaseH = this.clickH;
        this.releaseV = this.clickV;
        if (this.cantGrab) {
          this.justGrabbed = false;
          this.attemptDrop = true;
        } else this.justGrabbed = true;
        this.mouseRotate = true;
        this.rotateDir = -1;
        this.inWorld = true;
        this.play(ToolSound.move, false);
        this.validFeedback = true;
        this.lastValidFeedback = true;
      }
    } else {
      this.play(this.p.error === 0 ? ToolSound.movePlace : ToolSound.denied, false);
      if (c.anchor) {
        this.attemptDrop = true;
        if (!(c.inWorld && this.cursorValid())) {
          if (this.firstFloorOnly && this.level() > 1) this.p.error = PlacementErr.firstFloorOnly;
          this.showPlacementTip(this.p.error);
        }
      }
    }
    this.host.invalidate();
    this.updateCursor();
  }

  /** cMoveTool::Drag. */
  drag(px: number, py: number): void {
    this.float(px, py);
  }

  /** cMoveTool::GrabObject: pick up an object of the lot. */
  private grabObject(obj: XObject, px: number, py: number): void {
    const head = this.p.chain(obj)[0]!;
    const spec: PlacementSpec = this.p.getPlacementSpec(head);
    const orig: OrigSite = { obj, at: { fx: obj.fx, fy: obj.fy }, level: obj.level, dir: obj.dir, container: spec.container, slot: spec.container ? spec.slot : 0 };
    const c = XCursorObject.makeMouseObject(this.p, obj, this.host.cursorSelector, obj.level, () => this.host.getFunds() - this.runningTotal, false);
    if (!c) return;
    this.cursor = c;
    this.orig = orig;
    // The grab offset: mouse minus the object's tile top on screen.
    const v = this.host.viewer;
    const [vx, vy] = RotatableWorld.rotateCoords(c.lastAnchor.fx, c.lastAnchor.fy, v.world.rotation, 0x400);
    const pt = v.tileToPoint(vx >> 4, vy >> 4, this.level());
    this.grabV = py - pt.v;
    this.grabH = px - pt.h;
    this.updateSelector(obj.selector);
    this.price = 0;
    this.runningTotal = 0;
    this.disposing = false;
    this.startDisposing(obj);
    this.updateCursor();
  }

  /**
   * cMoveTool::StartDisposing: a picked-up object (not a new purchase) is
   * offered for sale on the control panel; refund factor lbl_105BBDE4 +8 (0)
   * when not refundable, +0xc (1) for buy items, +4 (0.8) for build items.
   */
  private startDisposing(obj: XObject): void {
    if (this.newPurchase || !this.host.startDisposing) return;
    this.disposing = true;
    const master = obj.selector.getMasterSelector();
    const factor = !this.refundable ? 0 : !this.buildItem ? 1 : BUILD_REFUND;
    this.host.startDisposing({
      guid: master.guid,
      res: master.res,
      objdId: master.objdId,
      buildModeType: master.objd.i16(0x8a),
      currentValue: this.p.getCurrentValue(obj),
      canDelete: this.p.userCanDelete(obj),
      notNew: !this.newPurchase,
      refundable: this.refundable,
      factor,
    });
  }

  /** CPState::StopDisposing when the sell page is up (Deselect, DropObject, Release). */
  private stopDisposing(): void {
    if (!this.disposing) return;
    this.disposing = false;
    this.host.stopDisposing?.();
  }

  /** cMoveTool::UpdateSelector for a picked-up object: build items refund 80 %. */
  private updateSelector(sel: ObjSelector): void {
    const master = sel.getMasterSelector();
    this.expenseType = master.objd.i16(0x8a) !== 0 ? 7 : 6;
    this.adjustsCutaway = false;
    this.firstFloorOnly = false;
    const build = buildModeOf(master);
    this.mode = build || MoveMode.Hand;
    this.newPurchase = false;
    this.keepBuying = false;
    this.buildItem = build >= MoveMode.Door && build <= MoveMode.Column;
    this.refundable = build !== MoveMode.Plant;
    this.firstFloorOnly = build === MoveMode.Plant;
    this.adjustsCutaway = build === MoveMode.Door || build === MoveMode.Window;
  }

  /** cMoveTool::DropObject. */
  private dropObject(): boolean {
    const c = this.cursor;
    const f = c?.anchor ?? null;
    if (f) this.frontDir = f.dir;
    if (!c || !f || !c.dropObject()) {
      this.updateCursor();
      return false;
    }
    // SubmitUndoable: the stairs floors stay with the dropped object.
    this.stairFloor = null;
    this.orig = null;
    this.stopDisposing();
    this.updateCursor();
    return true;
  }

  /** cMoveTool::Release. */
  release(px: number, py: number): void {
    this.float(px, py);
    if (this.p.error === 0 && this.mode === MoveMode.Buy) this.play(ToolSound.place, false);
    const c = this.cursor;
    let shift = false;
    let placed = false;
    let price = 0;
    if (c) {
      shift = this.host.shiftDown();
      const dh = px - this.releaseH;
      const dv = py - this.releaseV;
      this.clicked = false;
      this.mouseRotate = false;
      this.moved = dh * dh + dv * dv >= 4;
      if (this.moved) this.attemptDrop = true;
      if (this.attemptDrop) {
        price = c.getFloaterPrice();
        const afford = this.runningTotal + this.price <= this.host.getFunds();
        if (afford && this.cursorValid()) {
          this.dropObject();
          this.deselect();
          this.runningTotal += this.price;
          if (this.runningTotal !== 0) {
            this.showPlacementTip(PlacementErr.purchaseTotal, this.runningTotal);
            this.play(ToolSound.kaching);
            this.finalizePurchase();
          }
          this.price = 0;
          placed = true;
          this.attemptDrop = false;
        } else {
          this.play(ToolSound.denied);
          const ch = px - this.clickH;
          const cv = py - this.clickV;
          if (ch * ch + cv * cv > 4) {
            // ResetGrabPoint: zero for everything but doors and windows.
            this.grabV = 0;
            this.grabH = 0;
          }
          this.resetTip();
          this.releaseH = px;
          this.releaseV = py;
          this.attemptDrop = true;
          this.cantGrab = false;
          if (!afford) {
            this.p.error = PlacementErr.notEnoughMoney;
            this.showPlacementTip(PlacementErr.notEnoughMoney);
          }
        }
      }
      if (placed && this.newPurchase) {
        if (shift || this.keepBuying) {
          if (this.host.getFunds() < price) {
            this.play(ToolSound.denied);
            this.host.shopSoldItem();
            this.newPurchase = false;
          } else {
            this.select();
            this.inWorld = true;
          }
        } else {
          this.host.shopSoldItem();
          this.newPurchase = false;
        }
      }
    }
    this.float(px, py);
    if (this.floorsChanged) {
      this.host.computeRooms?.();
      this.floorsChanged = false;
    }
    this.host.invalidate();
  }

  // --- keys ---------------------------------------------------------------------------

  /** cMoveTool::OnKeyDown (Windows virtual keys as DOM key names). */
  onKeyDown(key: string): boolean {
    switch (key) {
      case "Delete":
      case "Backspace":
        this.doDispose();
        return true;
      case "Escape":
        this.cancel();
        return true;
      case "Control":
      case "Shift":
        return true;
      default:
        return false;
    }
  }

  /** cMoveTool::OnChar (jump table lbl_105BBDB4 over ',' .. '?'): ',' '<' turn left, '.' '>' turn right. */
  onChar(ch: string): boolean {
    const c = this.cursor;
    switch (ch) {
      case ",":
      case "<":
        if (c?.anchor) {
          c.turn(-1);
          this.afterTurn();
        }
        return true;
      case ".":
      case ">":
        if (c?.anchor) {
          c.turn(1);
          this.afterTurn();
        }
        return true;
      default:
        return false;
    }
  }

  private afterTurn(): void {
    this.updatePlacementFeedback();
    this.play(ToolSound.rotate);
    this.host.invalidate();
  }

  /** cMoveTool::DoDispose (Delete): sell the held object, or drop a new purchase. */
  doDispose(): void {
    const c = this.cursor;
    if (!c) return;
    const f = c.anchor;
    if (!f || !this.p.userCanDelete(f)) {
      this.play(ToolSound.denied);
      return;
    }
    if (c.inWorld) c.pickup(true);
    if (!this.newPurchase) {
      let refund = this.p.getCurrentValue(f);
      if (!this.refundable) refund = 0;
      else if (this.buildItem) refund = Math.trunc(Math.fround(BUILD_REFUND * refund) + 0.5);
      this.runningTotal -= refund;
      this.finalizePurchase();
      this.play(refund === 0 ? ToolSound.explode : ToolSound.refund);
      // The object is gone (Deselect's delete undoable, not undone).
      this.orig = null;
      this.deselect();
      this.cancel();
    } else {
      this.cancel();
      this.deselect();
      this.cancel();
    }
  }
}
