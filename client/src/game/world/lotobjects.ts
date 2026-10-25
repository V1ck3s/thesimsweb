/**
 * Glue between the loaded lot objects (ObjectModule, objects.ts) and the
 * HouseViewer's object drawing (DrawIso, objectdraw.ts): each cXObject is
 * drawn with its selector's sprite file (ObjSelector +8, one cRenderer per
 * object IFF) and draw groups.
 *
 * People are not drawn here: they are VitaBoy meshes (sims/).
 */

import type { ResFile } from "./iffres.js";
import { ObjectModuleDrawer, type DrawableObject } from "./objectdraw.js";
import { loadLotObjects, type IntegrityWorld, type PlacedObject } from "./objects.js";
import { Renderer } from "./renderer.js";

class DrawableLotObject implements DrawableObject {
  next: DrawableObject | null = null;

  constructor(
    readonly obj: PlacedObject,
    readonly renderer: Renderer,
  ) {}

  get fx(): number {
    return this.obj.fx;
  }
  get fy(): number {
    return this.obj.fy;
  }
  get level(): number {
    return this.obj.level;
  }
  get dir(): number {
    return this.obj.dir;
  }
  get graphic(): number {
    return this.obj.graphic;
  }
  get hidden(): number {
    return this.obj.hidden;
  }
  /** Objects load dynamic and settle on the static layer once idle (RenderDynamicObjects). */
  get isDynamic(): boolean {
    return !(this.obj.isStatic || this.obj.staticWhenIdle);
  }
  get spriteMask(): ArrayLike<number> | null {
    return this.obj.spriteVisibility.length ? this.obj.spriteVisibility : null;
  }
  get spriteMaskBase(): number {
    return this.obj.selector.objd.dynamicSpritesBaseId;
  }

  items(graphic: number, dirIndex: number, scale: number) {
    return this.obj.selector.getDrawGroup(graphic)?.getItemList(dirIndex, scale)?.items ?? null;
  }
}

export interface LotObjects {
  objects: Map<number, PlacedObject>;
  drawer: ObjectModuleDrawer;
}

/** House::LoadFile's object part, ready for HouseViewer.objects. */
export async function loadLotObjectDrawer(house: ResFile, world: IntegrityWorld): Promise<LotObjects> {
  const objects = await loadLotObjects(house, world);
  const renderers = new Map<ResFile, Renderer>();
  const drawables = new Map<number, DrawableLotObject>();
  for (const [id, o] of objects) {
    if (o.isPerson) continue;
    const res = o.selector.res;
    let r = renderers.get(res);
    if (!r) {
      r = new Renderer(res);
      renderers.set(res, r);
    }
    drawables.set(id, new DrawableLotObject(o, r));
  }
  for (const d of drawables.values()) d.next = drawables.get(d.obj.nextSiblingId) ?? null;
  const dynamic = [...drawables.values()].filter((d) => d.isDynamic);
  const drawer = new ObjectModuleDrawer(
    (id) => drawables.get(id) ?? null,
    () => dynamic,
  );
  return { objects, drawer };
}
