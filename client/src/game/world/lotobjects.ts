/**
 * Glue between the loaded lot objects (ObjectModule, objects.ts) and the
 * HouseViewer's object drawing (DrawIso, objectdraw.ts): each cXObject is
 * drawn with its selector's sprite file (ObjSelector +8, one cRenderer per
 * object IFF) and draw groups.
 *
 * People are not drawn here: they are VitaBoy meshes (sims/).
 */

import type { ResFile } from "./iffres.js";
import { ObjectModuleDrawer, type DrawableObject, type SlotContent } from "./objectdraw.js";
import type { ObjectFolder } from "./objectfolder.js";
import { loadLotModule, type IntegrityWorld, type ObjectModule, type PlacedObject } from "./objects.js";
import { OBJ_TYPE_PERSON, OBJ_TYPE_PORTAL } from "./objselector.js";
import { Renderer } from "./renderer.js";
import { SEG_ROTATION } from "./tilewalls.js";
import type { CustomWallStyleFn } from "./walls.js";

/** cXObject::GetRequiredSegment: wall placement flags 1 -> segment 2, 4 -> 8, turned by the object direction. */
function requiredSegment(o: PlacedObject): number {
  const p = o.wallPlacementFlags & 5;
  const seg = p === 1 ? 2 : p === 4 ? 8 : 0;
  const d = o.dir;
  return seg !== 0 && d !== 0 ? SEG_ROTATION[(d >> 1) & 3]![seg]! : seg;
}

class DrawableLotObject implements DrawableObject {
  next: DrawableObject | null = null;
  slotContents?: () => Iterable<SlotContent>;

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
  get cutawayHidden(): boolean {
    return this.obj.cutawayHidden;
  }
  set cutawayHidden(v: boolean) {
    this.obj.cutawayHidden = v;
  }
  get hiliteFlags(): number {
    return this.obj.objFlags & 0x1f;
  }
  get fullBright(): boolean {
    return this.obj.lightingContribution !== 0 && this.obj.selector.objd.objectType !== OBJ_TYPE_PORTAL;
  }
  get flags(): number {
    return this.obj.flags;
  }
  /** cXObject::GetRequiredSegment: wall placement flags 1 -> segment 2, 4 -> 8, turned by the object direction. */
  get requiredSegment(): number {
    return requiredSegment(this.obj);
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
  // Weak: a deleted object (gone from `objects`) must not stay alive through its drawable.
  const drawables = new WeakMap<PlacedObject, DrawableLotObject>();
  // People stand in the tile links too (cXObject::Place) but are drawn by LotPeople: a tile's
  // chain skips them. So are the 3D objects (OBJD +0xcc bit 0, the plumb bobs: cXObject::DrawIso
  // goes to Draw3D, LotPeople draws them with their carrier).
  const notSprite = (o: PlacedObject): boolean => o.isPerson || (o.selector.objd.i16(0xcc) & 1) !== 0;
  const skipPeople = (o: PlacedObject | undefined): PlacedObject | undefined => {
    for (let guard = 0; o && notSprite(o) && guard < 64; guard++) o = objects.get(o.nextSiblingId);
    return o;
  };
  const drawableOf = (o: PlacedObject | undefined): DrawableLotObject | null => {
    if (!o || notSprite(o)) return null;
    let d = drawables.get(o);
    if (!d) {
      d = new DrawableLotObject(o, renderer(o.selector.res));
      drawables.set(o, d);
      Object.defineProperty(d, "next", { get: () => drawableOf(skipPeople(objects.get(o.nextSiblingId))) });
      // cXObject::DrawIso's DrawObjectSlot pass (not for people: OBJD type 2).
      if (o.selector.objd.objectType !== OBJ_TYPE_PERSON) d.slotContents = () => slotContents(o);
    }
    return d;
  };
  function* slotContents(o: PlacedObject): Generator<SlotContent> {
    for (let i = 1; i < o.objectSlots.length; i++) {
      const s = o.objectSlots[i]!;
      const held = s.containedId > 0 ? drawableOf(objects.get(s.containedId)) : null;
      if (held) yield { obj: held, x: s.x, y: s.y, z: s.z };
    }
  }
  /**
   * In an object slot (1..) of a non-person: drawn by its container's
   * DrawIso, never on its own (HouseViewer::DoStaticToDynamicObjectTransitions
   * leaves objects with a PlacementSpec container out of the dynamic list).
   * Objects people hold are drawn at their hand (placeHeld).
   */
  const inObjectSlot = (o: PlacedObject): boolean => {
    const p = objects.get(o.parentId);
    if (!p || p.isPerson) return false;
    for (let i = 1; i < p.objectSlots.length; i++) if (p.objectSlots[i]!.containedId === o.objectId) return true;
    return false;
  };
  for (const o of objects.values()) drawableOf(o);
  const drawer = new ObjectModuleDrawer(
    (id) => drawableOf(skipPeople(objects.get(id))),
    function* () {
      for (const o of objects.values()) {
        const d = drawableOf(o);
        // Out-of-world objects (picked up, or just bought) sit at negative coordinates.
        if (d?.isDynamic && o.fx >= 0 && o.fy >= 0 && !inObjectSlot(o)) yield d;
      }
    },
  );
  return { objects, drawer, module, folder, renderer };
}

/**
 * GetCustomWallStyleID(cRenderer **, CTilePt const &, TileWalls::Segment)
 * (world tile and segment): ObjectIterator over the tile, the first cXPortal
 * whose required segment is `seg` gives its sprite file (ObjSelector +8) and
 * cXPortal::GetCustomWallStyleID, the wall style sprite id of its definition
 * (OBJD +0xa2). GETCUSTOMSTYLE then adds the scale and the cut offset
 * (ids id .. id + 2 full height, id + 3 .. id + 5 cut). 0 (or no portal)
 * falls back to the plain wall.
 */
export function customWallStyleOf(lot: LotObjects, world: IntegrityWorld): CustomWallStyleFn {
  return (x, y, level, seg) => {
    const tiles = world.objects[level - 1];
    if (!tiles || x < 0 || y < 0 || x >= world.size || y >= world.size) return null;
    const o = tiles.offset(x, y);
    const first = ((tiles.data[o]! | (tiles.data[o + 1]! << 8)) << 16) >> 16;
    const stack = first > 0 ? [first] : [];
    const seen = new Set<number>();
    for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
      if (seen.has(id)) continue;
      seen.add(id);
      const obj = lot.objects.get(id);
      if (!obj) continue;
      for (let i = obj.objectSlots.length - 1; i >= 0; i--) {
        const c = obj.objectSlots[i]!.containedId;
        if (c > 0) stack.push(c);
      }
      if (obj.kind !== "portal" || requiredSegment(obj) !== seg) continue;
      const styleId = obj.selector.objd.i16(0xa2);
      return styleId === 0 ? null : { renderer: lot.renderer(obj.selector.res), id: styleId };
    }
    return null;
  };
}
