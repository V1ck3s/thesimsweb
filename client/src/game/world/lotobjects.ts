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
import type { ObjectFolder } from "./objectfolder.js";
import { loadLotModule, type IntegrityWorld, type ObjectModule, type PlacedObject } from "./objects.js";
import { OBJ_TYPE_PORTAL } from "./objselector.js";
import { Renderer } from "./renderer.js";
import { SEG_ROTATION } from "./tilewalls.js";

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
  get fullBright(): boolean {
    return this.obj.lightingContribution !== 0 && this.obj.selector.objd.objectType !== OBJ_TYPE_PORTAL;
  }
  get flags(): number {
    return this.obj.flags;
  }
  /** cXObject::GetRequiredSegment: wall placement flags 1 -> segment 2, 4 -> 8, turned by the object direction. */
  get requiredSegment(): number {
    const p = this.obj.wallPlacementFlags & 5;
    const seg = p === 1 ? 2 : p === 4 ? 8 : 0;
    const d = this.obj.dir;
    return seg !== 0 && d !== 0 ? SEG_ROTATION[(d >> 1) & 3]![seg]! : seg;
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
  /** The module and folder behind `objects` (the buy tools add, move and delete objects). */
  module: ObjectModule;
  folder: ObjectFolder;
  /** The cRenderer of a sprite file (one per object IFF). */
  renderer(res: ResFile): Renderer;
}

/**
 * House::LoadFile's object part, ready for HouseViewer.objects. Drawables
 * follow the module live: objects created, moved or deleted at run time are
 * drawn from their current state.
 */
export async function loadLotObjectDrawer(house: ResFile, world: IntegrityWorld): Promise<LotObjects> {
  const { module, folder } = await loadLotModule(house, world);
  const objects = module.objects;
  const renderers = new Map<ResFile, Renderer>();
  const renderer = (res: ResFile): Renderer => {
    let r = renderers.get(res);
    if (!r) {
      r = new Renderer(res);
      renderers.set(res, r);
    }
    return r;
  };
  const drawables = new Map<PlacedObject, DrawableLotObject>();
  const drawableOf = (o: PlacedObject | undefined): DrawableLotObject | null => {
    if (!o || o.isPerson) return null;
    let d = drawables.get(o);
    if (!d) {
      d = new DrawableLotObject(o, renderer(o.selector.res));
      drawables.set(o, d);
      Object.defineProperty(d, "next", { get: () => drawableOf(objects.get(o.nextSiblingId)) });
    }
    return d;
  };
  for (const o of objects.values()) drawableOf(o);
  const drawer = new ObjectModuleDrawer(
    (id) => drawableOf(objects.get(id)),
    function* () {
      for (const o of objects.values()) {
        const d = drawableOf(o);
        // Out-of-world objects (picked up, or just bought) sit at negative coordinates.
        if (d?.isDynamic && o.fx >= 0 && o.fy >= 0) yield d;
      }
    },
  );
  return { objects, drawer, module, folder, renderer };
}
