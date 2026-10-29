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
 * The walk starts at the tile of the surface visible at the point
 * (HouseViewer::PointToTile, z-buffer unprojected), not the floor under it.
 * Not ported: the mode 1 fallback's extra test when the app's +0x1c / +0x36
 * short is 0 (the object definition's +0xb6 bit 0).
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
  const list = obj.selector.getDrawGroup(obj.graphic)?.getItemList((rp0.rotation2 + obj.dir) & 7, viewer.scale)?.items;
  if (!list) return null;
  const rp = rp0.clone();
  rp.setGridCoords(obj.fx, obj.fy, obj.level);
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
    for (const o of p.tileObjects(wx, wy, level)) {
      if (o.isPerson && !personRect) continue;
      const f = o.objectData[ODX.flagField2]! & 0xffff;
      const r = o.isPerson ? personRect!(o) : objectScreenRect(o, viewer, renderer(o.selector.res), rp);
      const inside = r !== null && px >= r[0] && px < r[2] && py >= r[1] && py < r[3];
      const accepts = mode === PickMode.Flag8000 ? (f & 0x8000) !== 0 : mode === PickMode.Flag4000 ? (f & 0x4000) !== 0 : true;
      if (inside) {
        if (accepts) hit = o;
      } else if (i === 0) {
        if (mode === PickMode.Any) {
          if (!(f & 0x4000) && !(f & 0x8000)) fallback = o;
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
