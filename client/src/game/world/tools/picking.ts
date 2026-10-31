/**
 * HouseViewer::PointToObjectID(Point, level, PointToObjectMode): the object
 * under a screen point, from the screen rectangles the objects were last
 * drawn into (cXObject::GetLastDamage).
 *
 * The original keeps each object's last damage rectangle from its DrawIso;
 * this port recomputes it the same way drawIso places the draw group's
 * sprites (objectdraw.ts). People stand in the tile links too; their
 * rectangle (the 3D mesh's, cXPerson::Draw3D) comes from `personRect`
 * (without it they are skipped).
 *
 * Each tile is walked like ObjectIterator: its object, then the hierarchy
 * through the object slots (slot 0 is the next object on the tile), the last
 * object whose rectangle holds the point winning. An object in a slot of a
 * non-person container (a phone on a table, a sink in a counter) is drawn by
 * the container's DrawIso at the slot's offset, so its rectangle is taken
 * there, with its own sprites (DrawObjectSlot).
 *
 * The walk starts at the tile of the surface visible at the point
 * (HouseViewer::PointToTile, z-buffer unprojected), not the floor under it.
 * The mode 1 fallback (an object of the first tile whose rectangle misses the
 * point) takes any object without the 0x4000 / 0x8000 flags outside Live
 * mode; in Live mode (House +0x36, global 19 = 0) only an object whose
 * definition has +0xb6 bit 0. So the invisible parts of a big multi-tile
 * object (the Studio Town movie set draws from its 0,0 / 1,0 tiles) are not
 * picked: the walk goes on to the part drawn at the point.
 */

import type { HouseViewer } from "../houseviewer.js";
import type { ResFile } from "../iffres.js";
import type { XObject } from "../objects.js";
import type { Renderer } from "../renderer.js";
import { RenderParam } from "../renderparam.js";
import { RotatableWorld } from "../world.js";
import { ODX, type Placement } from "./placement.js";

/** PointToObjectMode values used by the tools. */
export const PickMode = {
  /** XViewer::MouseTrack: anything, else an object of the first tile without the 0x4000 / 0x8000 flags. */
  Any: 1,
  /** Flag field 2 bit 0x8000 only (door tool). */
  Flag8000: 2,
  /** Flag field 2 bit 0x4000 only (build items, ctrl-delete). */
  Flag4000: 3,
} as const;

/** The object's draw rectangle [left, top, right, bottom] at its position, or null when nothing is drawn. */
export function objectScreenRect(obj: XObject, viewer: HouseViewer, renderer: Renderer, rp0: RenderParam): [number, number, number, number] | null {
  if (obj.hidden !== 0 || obj.fx < 0 || obj.fy < 0) return null;
  const rp = rp0.clone();
  rp.setGridCoords(obj.fx, obj.fy, obj.level);
  return drawnRect(obj, viewer, renderer, rp);
}

/** The draw group's rectangle with the RenderParam already at the drawing position (DrawIso). */
function drawnRect(obj: XObject, viewer: HouseViewer, renderer: Renderer, rp: RenderParam): [number, number, number, number] | null {
  if (obj.hidden !== 0) return null;
  const list = obj.selector.getDrawGroup(obj.graphic)?.getItemList((rp.rotation2 + obj.dir) & 7, viewer.scale)?.items;
  if (!list) return null;
  const mask = obj.spriteVisibility;
  const base = obj.selector.objd.dynamicSpritesBaseId;
  let r: [number, number, number, number] | null = null;
  for (const it of list) {
    if (mask.length) {
      const k = it.sprId - base;
      if (k >= 0 && k < mask.length && mask[k] === 0) continue;
    }
    if (it.frame >= renderer.countSprites(it.sprId)) continue;
    const b = renderer.getShapeBounds(it.sprId, it.frame);
    let q = rp;
    if (it.objX !== 0 || it.objY !== 0 || it.objZ !== 0) {
      q = rp.clone();
      const d = obj.dir & 7;
      const [dx, dy] = d === 2 ? [-it.objY, it.objX] : d === 4 ? [-it.objX, -it.objY] : d === 6 ? [it.objY, -it.objX] : d === 0 ? [it.objX, it.objY] : [0, 0];
      q.x += dx;
      q.y += dy;
      q.z += it.objZ;
      q.updateScreenCoords();
    }
    const x = q.sx + it.xOff;
    const y = q.sy + it.yOff - b.height;
    if (!r) r = [x, y, x + b.width, y + b.height];
    else {
      r[0] = Math.min(r[0], x);
      r[1] = Math.min(r[1], y);
      r[2] = Math.max(r[2], x + b.width);
      r[3] = Math.max(r[3], y + b.height);
    }
  }
  return r;
}

/**
 * ObjectIterator over a tile (House, CTilePt): the tile's object, then the
 * hierarchy depth first through the object slots (slot 0 is the next object
 * on the tile). Each comes with the RenderParam it was drawn with, what its
 * GetLastDamage rectangle keeps: an object in a slot 1.. of a non-person
 * container is drawn by the container's DrawIso (cXObject::DrawObjectSlot:
 * the container's position moved by the slot offset, turned by the
 * container's direction, raised by the slot's z) with its own sprites;
 * anything else at its own location (null off the lot).
 */
function* tileObjectsDrawn(p: Placement, head: XObject, rp0: RenderParam): Generator<{ o: XObject; rp: RenderParam | null }> {
  const own = (o: XObject): RenderParam | null => {
    if (o.fx < 0 || o.fy < 0) return null;
    const q = rp0.clone();
    q.setGridCoords(o.fx, o.fy, o.level);
    return q;
  };
  function* walk(o: XObject, rp: RenderParam | null, depth: number): Generator<{ o: XObject; rp: RenderParam | null }> {
    yield { o, rp };
    if (depth > 64) return;
    for (let i = 0; i < o.objectSlots.length; i++) {
      const s = o.objectSlots[i]!;
      const c = p.get(s.containedId);
      if (!c) continue;
      let q: RenderParam | null;
      if (i === 0 || o.isPerson || !rp) q = own(c);
      else {
        q = rp.clone();
        const d = o.dir & 7;
        const [dx, dy] = d === 2 ? [-s.y, s.x] : d === 4 ? [-s.x, -s.y] : d === 6 ? [s.y, -s.x] : d === 0 ? [s.x, s.y] : [0, 0];
        q.x += dx;
        q.y += dy;
        q.z += s.z;
        q.updateScreenCoords();
      }
      yield* walk(c, q, depth + 1);
    }
  }
  yield* walk(head, own(head), 0);
}

/** HouseViewer::PointToObjectID: returns the object id (0 = none). */
export function pointToObjectId(
  viewer: HouseViewer,
  p: Placement,
  renderer: (res: ResFile) => Renderer,
  px: number,
  py: number,
  level: number,
  mode: number,
  personRect: ((o: XObject) => [number, number, number, number] | null) | null = null,
  /** Global 19 (the mode: 0 Live, 1 Build, 2 Buy). */
  modeFreeze = 1,
): number {
  const w = viewer.world;
  // The walk starts at PointToTile's tile: the surface drawn at the point
  // (z-buffer), so a person in front of furniture is reached before it.
  const t = viewer.pointToTile(px, py);
  let vx = t.x;
  let vy = t.y;
  const outside = (x: number, y: number): boolean => x < w.minX + 1 || x > w.maxX - 1 || y < w.minY + 1 || y > w.maxY - 1;
  if (outside(vx, vy)) return 0;
  const rp = new RenderParam(viewer, 0);
  let hit: XObject | null = null;
  let fallback: XObject | null = null;
  for (let i = 0; ; i++) {
    const [wx, wy] = RotatableWorld.rotateCoords(vx, vy, (4 - w.rotation) & 3, 0x40);
    const head = p.get(p.tileObjectId(wx, wy, level));
    for (const { o, rp: at } of head ? tileObjectsDrawn(p, head, rp) : []) {
      if (o.isPerson && !personRect) continue;
      const f = o.objectData[ODX.flagField2]! & 0xffff;
      // cXObject::GetLastDamage: the last object of the walk whose rectangle holds the point wins.
      const r = o.isPerson ? personRect!(o) : at ? drawnRect(o, viewer, renderer(o.selector.res), at) : null;
      const inside = r !== null && px >= r[0] && px < r[2] && py >= r[1] && py < r[3];
      const accepts = mode === PickMode.Flag8000 ? (f & 0x8000) !== 0 : mode === PickMode.Flag4000 ? (f & 0x4000) !== 0 : true;
      if (inside) {
        if (accepts) hit = o;
      } else if (i === 0) {
        if (mode === PickMode.Any) {
          if (!(f & 0x4000) && !(f & 0x8000) && (modeFreeze !== 0 || o.selector.objd.i16(0xb6) & 1)) fallback = o;
        } else if (accepts) {
          fallback = o;
        }
      }
    }
    if (hit || i >= 0x14) break;
    // The tiles drawn in front: (x + 1, y), (x, y + 1), (x + 1, y + 1) and on down the screen.
    const k = i % 3;
    if (k === 0) vx++;
    else if (k === 1) {
      vx--;
      vy++;
    } else vx++;
    if (outside(vx, vy)) break;
  }
  return (hit ?? fallback)?.objectId ?? 0;
}
