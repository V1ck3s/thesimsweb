/**
 * Object drawing: cXObject::DrawIso (DGRP draw groups of z-sprites) as
 * called by HouseViewer::RenderStaticRow for the objects standing on each
 * tile (GetTileObjectID + GetNextObjectSibling) and by RenderDynamicObjects.
 *
 * DrawIso picks the draw group of the object's current graphic (+0x4a), the
 * item list whose direction bit is (view rotation * 2 + object direction) & 7
 * and whose zoom is the current scale, then draws every item with
 * cRenderer::DrawShape at (screen x + x offset, screen y + y offset - frame
 * height) at the object's base depth (RenderParam +0x28). Items with object
 * offsets move the RenderLoc first: by (y, x), (-y, x)... depending on the
 * object direction (jump table lbl_105BB9C8: 0 -> (+ox, +oy), 2 -> (-oy, +ox),
 * 4 -> (-ox, -oy), 6 -> (+oy, -ox), odd -> none) plus z, then
 * RenderLoc::UpdateScreenCoords.
 */

import { Mode } from "../cpstate.js";
import type { Compositor } from "./compositor.js";
import { rotateShadowID } from "./floorshadow.js";
import type { HouseViewer, ObjectDrawer } from "./houseviewer.js";
import type { Renderer } from "./renderer.js";
import type { RenderParam } from "./renderparam.js";
import { getAdjacentTile, SEG_ROTATION } from "./tilewalls.js";

/** Object data flags (+0x5a) bit 10: hidden where the wall cutaway cuts its wall. */
const FLAG_HIDE_FOR_CUTAWAY = 0x400;

/** The HouseViewer wall state RenderStaticRow reads to hide wall objects (WallManager). */
export interface CutawayView {
  /** +0x48 walls down, +0x49 dynamic cutaway, +0x51 draw roof. */
  cutaway: boolean;
  dynamicCutaway: boolean;
  drawRoof: boolean;
  /** +0x204 (view tiles). */
  cutawayMask: { has(x: number, y: number): boolean };
  /** CPState mode and the wall / door tool (CPState::ShouldAlwaysShowWallStuff). */
  mode: Mode;
  wallToolActive: boolean;
}

/** DrawGroupItem: one sprite of a draw group image. */
export interface DrawGroupItem {
  /** [0] SPR# / SPR2 chunk id. */
  sprId: number;
  /** [1] frame. */
  frame: number;
  /** [2] / [3] pixel offsets. */
  xOff: number;
  yOff: number;
  /** [4] z, [5] x, [6] y object offsets. */
  objZ: number;
  objX: number;
  objY: number;
  /** [7] flags (bit 0 = mirrored). */
  flags: number;
}

/** What DrawIso needs from a cXObject. */
export interface DrawableObject {
  /** +0xf8 / +0xf4: fixed-point world position (1/16 tile). */
  fx: number;
  fy: number;
  /** +0x110 */
  level: number;
  /** +0x4c */
  dir: number;
  /** +0x4a */
  graphic: number;
  /** +0x8e: non-zero hides the draw group. */
  hidden: number;
  /** The wall cutaway set +0x8e for the last draw (its last damage is empty: not picked). */
  cutawayHidden?: boolean;
  /** +0x15c: 0 = drawn by the static rows, 1 = dynamic. */
  isDynamic: boolean;
  /** +0x34 / +0x38: per-sprite visibility (relative to OBJD +0x80), or null. */
  spriteMask: ArrayLike<number> | null;
  spriteMaskBase: number;
  /** +0x5a object data flags (absent = 0). */
  readonly flags?: number;
  /** cXObject::GetRequiredSegment: the wall segment the object needs (world space, absent / 0 = none). */
  readonly requiredSegment?: number;
  /** +0x114 & 0x1f (cXObject::SetHilite): bit 1 = hilited (absent = 0). */
  readonly hiliteFlags?: number;
  /** Lighting contribution (+0xb0) on a non-portal: DrawIso draws it at full light (SetMaxAmbient). */
  readonly fullBright?: boolean;
  /** ObjSelector +8: the object's sprite file. */
  renderer: Renderer;
  /** DrawGroup::GetItemList(graphic draw group, direction bit, scale). */
  items(graphic: number, dirIndex: number, scale: number): readonly DrawGroupItem[] | null;
  /** GetNextObjectSibling. */
  next: DrawableObject | null;
  /** +0x184: ObjSelector::GetShadowID (-1 / absent = no floor shadow). */
  readonly shadowId?: number;
  /** ObjSelector::GetShadowBrightness (OBJD +0x9e). */
  readonly shadowBrightness?: number;
  /** OBJD +0x12: the object type (2 = person). */
  readonly objectType?: number;
  /**
   * The objects in the object slots 1.. (cXObject +0x130) with each slot's
   * offset, for DrawIso's DrawObjectSlot pass; absent or empty for a person
   * (OBJD type 2: cXPerson draws what it holds).
   */
  slotContents?(): Iterable<SlotContent>;
}

/** An object in a slot of another: ObjectSlot +0 / +4 / +8 (1/16 tile, altitude units) and +0x10. */
export interface SlotContent {
  obj: DrawableObject;
  x: number;
  y: number;
  z: number;
}

/**
 * The jump tables lbl_105BB9C8 (draw group item offsets) and lbl_105BB9D0
 * (slot offsets): an offset (x, y) turned by the object direction
 * (0 -> (+x, +y), 2 -> (-y, +x), 4 -> (-x, -y), 6 -> (+y, -x), odd -> none).
 */
function objectOffset(dir: number, x: number, y: number): [number, number] {
  switch (dir & 7) {
    case 0:
      return [x, y];
    case 2:
      return [-y, x];
    case 4:
      return [-x, -y];
    case 6:
      return [y, -x];
    default:
      return [0, 0];
  }
}

/**
 * cXObject::DrawIso: the draw group unless hidden (+0x8e), then (OBJD type
 * != 2) DrawObjectSlot for every object slot, hidden or not. Sprite slots
 * and head text are drawn elsewhere.
 */
export function drawIso(obj: DrawableObject, viewer: HouseViewer, comp: Compositor, rp: RenderParam, hidden = obj.hidden): void {
  if (hidden === 0) drawGroup(obj, viewer, comp, rp);
  const slots = obj.slotContents?.();
  if (slots) for (const s of slots) drawObjectSlot(obj, s, viewer, comp, rp);
}

/**
 * cXObject::DrawObjectSlot: the contained object's DrawIso (vtable +0x38)
 * with the container's RenderParam moved by the slot offset, turned by the
 * container's direction (lbl_105BB9D0), and raised by the slot's z, then
 * RenderLoc::UpdateScreenCoords. The contained object's own location (the
 * container's) is not used.
 */
function drawObjectSlot(container: DrawableObject, s: SlotContent, viewer: HouseViewer, comp: Compositor, rp: RenderParam): void {
  const q = rp.clone();
  const [dx, dy] = objectOffset(container.dir, s.x, s.y);
  q.x += dx;
  q.y += dy;
  q.z += s.z;
  q.updateScreenCoords();
  drawIso(s.obj, viewer, comp, q);
}

/**
 * DrawIso's draw group part. Around each item, RenderParam +0x35 (Hilite)
 * is set from the object's +0x114 bit 1 (the hilite cXObject::SetHilite
 * keeps there), then restored.
 */
function drawGroup(obj: DrawableObject, viewer: HouseViewer, comp: Compositor, rp: RenderParam): void {
  const s = viewer.scale;
  const list = obj.items(obj.graphic, (rp.rotation2 + obj.dir) & 7, s);
  if (!list) return;
  const r = obj.renderer;
  const ambient = comp.ambient;
  const hilite = rp.hilite;
  rp.hilite = ((obj.hiliteFlags ?? 0) & 1) !== 0;
  if (obj.fullBright) comp.ambient = 1;
  for (const it of list) {
    const m = obj.spriteMask;
    if (m && m.length) {
      const k = it.sprId - obj.spriteMaskBase;
      if (k >= 0 && k < m.length && m[k] === 0) continue;
    }
    if (it.frame >= r.countSprites(it.sprId)) continue;
    const b = r.getShapeBounds(it.sprId, it.frame);
    if (it.objX === 0 && it.objY === 0 && it.objZ === 0) {
      r.drawShape(comp, rp, it.sprId, it.frame, rp.sx + it.xOff, rp.sy + it.yOff - b.height, it.flags & 0xff);
      continue;
    }
    const q = rp.clone();
    const [dx, dy] = objectOffset(obj.dir, it.objX, it.objY);
    q.x += dx;
    q.y += dy;
    q.z += it.objZ;
    q.updateScreenCoords();
    r.drawShape(comp, q, it.sprId, it.frame, q.sx + it.xOff, q.sy + it.yOff - b.height, it.flags & 0xff);
  }
  comp.ambient = ambient;
  rp.hilite = hilite;
}

/**
 * ObjectDrawer over a lot's objects: `byId` maps the tile object ids of the
 * "objects" arrays to drawable objects.
 */
export class ObjectModuleDrawer implements ObjectDrawer {
  constructor(
    private readonly byId: (id: number) => DrawableObject | null,
    private readonly dynamic: () => Iterable<DrawableObject>,
  ) {}

  /**
   * cXPerson::DrawIso's held objects: positions `rp` for an object a person
   * carries (SAnimator::PrepReg) and returns true; false draws the object
   * at its own location.
   */
  placeHeld: ((o: DrawableObject, rp: RenderParam) => boolean) | null = null;

  /** Wall state for hiding wall objects (doors, windows) in cut walls; null = never hidden. */
  cutawayView: CutawayView | null = null;

  /**
   * RenderStaticRow: a wall object (flag 0x400) on a cut tile is drawn with
   * +0x8e set (no draw group) when its wall is cut: with walls down, always;
   * with the dynamic cutaway, when the tile across its required segment is
   * in the cutaway mask too. The cut wall itself draws the object's opening
   * (custom wall style). Not while the wall / door tool shows wall stuff,
   * nor (RenderStaticRow only, `dynamic` false) while the roof is drawn.
   * RenderDynamicObjects (101c9bc0) applies the same rule at the object's
   * view tile, without the roof test.
   */
  private hiddenByCutaway(o: DrawableObject, viewer: HouseViewer, x: number, y: number, dynamic = false): boolean {
    const c = this.cutawayView;
    if (!c || (!dynamic && c.drawRoof) || (c.mode === Mode.Build && c.wallToolActive)) return false;
    if (!(c.cutaway || (c.dynamicCutaway && c.cutawayMask.has(x, y)))) return false;
    if (((o.flags ?? 0) & FLAG_HIDE_FOR_CUTAWAY) === 0) return false;
    let ax = x;
    let ay = y;
    const req = o.requiredSegment ?? 0;
    if (!c.cutaway && req !== 0) {
      const seg = SEG_ROTATION[viewer.world.rotation]![req]!;
      if (seg !== 0) [ax, ay] = getAdjacentTile(seg, x, y);
    }
    return viewer.level === o.level && (c.cutaway || c.cutawayMask.has(ax, ay));
  }

  /** RenderStaticRow's object loop for one view tile. */
  drawTileObjects(viewer: HouseViewer, comp: Compositor, x: number, y: number, level: number, rp: RenderParam): void {
    const w = viewer.world;
    if (!w.inInterior(x, y)) return;
    for (let o = this.byId(w.getTileObjectID(x, y, level)); o; o = o.next) {
      if (o.isDynamic) continue;
      rp.setGridCoords(o.fx, o.fy, level);
      const cut = this.hiddenByCutaway(o, viewer, x, y);
      o.cutawayHidden = cut;
      drawIso(o, viewer, comp, rp, cut ? 1 : o.hidden);
    }
  }

  /**
   * cXObject::GetTileShadow from the tile's first object (GetTileObjectID):
   * the first object along the sibling chain that is not hidden (+0x8e), has
   * no flag 4 (+0x5a), is neither of type 2 (a person) nor 9 and has a
   * shadow id; its id turned by its direction / 2 (lbl_105BA23C) and its
   * ObjSelector::GetShadowBrightness. Null when there is none (id -1).
   */
  getTileShadow(viewer: HouseViewer, x: number, y: number, level: number): { id: number; brightness: number } | null {
    for (let o = this.byId(viewer.world.getTileObjectID(x, y, level)); o; o = o.next) {
      const id = o.shadowId ?? -1;
      if (o.hidden !== 0 || ((o.flags ?? 0) & 4) !== 0 || o.objectType === 2 || o.objectType === 9 || id === -1) continue;
      const turns = Math.trunc(o.dir / 2);
      return { id: turns > 0 ? rotateShadowID(id & 0xff, turns) : id & 0xff, brightness: o.shadowBrightness ?? 0 };
    }
    return null;
  }

  /** HouseViewer::RenderDynamicObjects. */
  drawDynamicObjects(viewer: HouseViewer, comp: Compositor, rp: RenderParam): void {
    const n = viewer.world.size;
    for (const o of this.dynamic()) {
      if (o.level > viewer.level) continue;
      const tx = o.fx >> 4;
      const ty = o.fy >> 4;
      if (tx < 1 || ty < 1 || tx >= n - 1 || ty >= n - 1) continue;
      if (viewer.isThumbnailHidden(tx, ty)) continue;
      if (!this.placeHeld?.(o, rp)) rp.setGridCoords(o.fx, o.fy, o.level);
      const [vx, vy] = viewer.world.toView(tx, ty);
      comp.ambient = viewer.ambientAtTile(vx, vy, o.level);
      const cut = this.hiddenByCutaway(o, viewer, vx, vy, true);
      o.cutawayHidden = cut;
      drawIso(o, viewer, comp, rp, cut ? 1 : o.hidden);
    }
  }
}
