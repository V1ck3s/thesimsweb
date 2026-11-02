/**
 * cXCursorObject: the "Tile Cursor" object (Cursors.iff, GUID 0x437) the buy
 * tool moves around, carrying the object being placed (its "floater",
 * cXCursorObject +0x1ac). The original builds one cursor per part of the
 * floater (a cXMTObject chain mirroring the floater's); this port keeps one
 * XCursorObject per floater with the part offsets read from the floater.
 *
 * Positions given to the cursor are those of its anchor: the part that was
 * grabbed (or the lead of a new object); cXCursorObject::Place on a part
 * delegates to the chain head minus the part's offsets, so the grabbed part
 * stays under the mouse.
 *
 * Shortcut: the cursor objects are not put in the tile object arrays (the
 * original places them like any object, with the Tile Cursor's own placement
 * data set by its init tree); cXCursorObject::CanPlace is reduced to "every
 * part on the lot". They are drawn by HouseViewer::RenderCursorObject's
 * equivalent, `CursorDrawer`.
 */

import type { Compositor } from "../compositor.js";
import type { HouseViewer } from "../houseviewer.js";
import type { ResFile } from "../iffres.js";
import { OD, type XObject } from "../objects.js";
import { drawIso, type DrawableObject, type DrawGroupItem } from "../objectdraw.js";
import type { ObjSelector } from "../objselector.js";
import { Renderer } from "../renderer.js";
import type { RenderParam } from "../renderparam.js";
import { killObject } from "./objectfactory.js";
import { Placement, tileOf, type FPt } from "./placement.js";

/** GUID of the "Tile Cursor" definition (ObjectFolder::GetSelectorByName("Tile Cursor")). */
export const GUID_TILE_CURSOR = 0x437;

/** lbl_105BB944: GetFrontDirection per view rotation. */
const FRONT_DIRECTION = [2, 0, 6, 4];
/** lbl_105BB940: standard heights tried for an object that cannot stand on the floor. */
const HEIGHT_ORDER = [2, 3, 4, 8];
/** ObjectSlot::SetHeight's z for those heights. */
const HEIGHT_Z: Readonly<Record<number, number>> = { 2: 2.5, 3: 4, 4: 4.05, 8: 4 };
/** Jump table lbl_105BB938 (AttemptFloaterPlacement): the tile next to a container on a side (direction), (dx, dy). */
const SIDE_STEP: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

/** cXCursorObject::GetFrontDirection: the direction new objects face for a view rotation. */
export function getFrontDirection(rotation: number): number {
  return FRONT_DIRECTION[rotation & 3] ?? 0;
}

export class XCursorObject {
  /** +0x1ac of the tool's cursor: the part under the mouse. */
  anchor: XObject | null;
  /** +0x1b0: the floater sits at the cursor (placement valid). */
  valid = false;
  /** +0x1b1: a new object from the catalog (funds are checked). */
  isPurchase = false;
  /** +0x1b4 / +0x1b8 / +0x1bc of the chain head (fixed point). */
  headFx = -16;
  headFy = -16;
  level = 1;
  /** The anchor's own +0x1b4 / +0x1b8 at the last placement. */
  lastAnchor: FPt = { fx: -16, fy: -16 };
  /** +0x1c4 / +0x1c6: the container and slot the floater is placed in. */
  containerId = 0;
  slot = 0;
  /** +0x1c8 / +0x1ca: where it came from. */
  readonly origContainerId: number;
  readonly origSlot: number;
  /** The cursor is placed (cXObject::IsInWorld on the cursor). */
  inWorld = false;
  /** +0x4c of a cursor without floater. */
  private ownDir = 0;

  constructor(
    private readonly p: Placement,
    readonly cursorSel: ObjSelector,
    anchor: XObject | null,
    /** cSimulator::GetFunds */
    private readonly funds: () => number,
  ) {
    this.anchor = anchor;
    if (anchor) {
      const spec = p.getPlacementSpec(anchor);
      this.origContainerId = spec.container?.objectId ?? 0;
      this.origSlot = spec.container ? spec.slot : 0;
    } else {
      this.origContainerId = 0;
      this.origSlot = 0;
    }
    this.containerId = this.origContainerId;
    this.slot = this.origSlot;
  }

  /** The floater's lead (cXMTObject chain head), or null. */
  get floater(): XObject | null {
    return this.anchor ? this.p.chain(this.anchor)[0]! : null;
  }

  /** The anchor's offsets from the head. */
  private anchorOffsets(): [number, number, number] {
    const a = this.anchor;
    return a && this.p.isMultiTile(a) ? [a.mt1a0, a.mt1a4, a.mt1a8] : [0, 0, 0];
  }

  /** The anchor's position for a head position. */
  anchorPos(): FPt {
    const [ox, oy] = this.anchorOffsets();
    return { fx: this.headFx + ox * 16, fy: this.headFy + oy * 16 };
  }

  /** The cursor parts: [floater part or null, x, y, level offset] (one part without floater). */
  parts(): Array<{ obj: XObject | null; ox: number; oy: number; ol: number }> {
    const f = this.floater;
    if (!f) return [{ obj: null, ox: 0, oy: 0, ol: 0 }];
    if (!this.p.isMultiTile(f)) return [{ obj: f, ox: 0, oy: 0, ol: 0 }];
    return this.p.chain(f).map((o) => ({ obj: o, ox: o.mt1a0, oy: o.mt1a4, ol: o.mt1a8 }));
  }

  get dir(): number {
    return this.anchor ? this.anchor.dir : this.ownDir;
  }

  /** cXCursorObject::CanPlace (see the file comment). */
  canPlace(at: FPt, level: number, container: XObject | null): boolean {
    if (container) return false;
    const [ax, ay] = this.anchorOffsets();
    const hx = at.fx - ax * 16;
    const hy = at.fy - ay * 16;
    if (level < 1 || level > 3) return false;
    for (const part of this.parts()) {
      if (this.p.outOfBounds(tileOf(hx + part.ox * 16), tileOf(hy + part.oy * 16))) {
        this.p.error = 1;
        return false;
      }
    }
    return true;
  }

  /** cXCursorObject::Place (`at` is the anchor's position). */
  place(at: FPt, level: number, slot: number): void {
    const [ax, ay, al] = this.anchorOffsets();
    const hx = at.fx - ax * 16;
    const hy = at.fy - ay * 16;
    const hl = level - al;
    if (hx !== this.headFx || hy !== this.headFy || hl !== this.level) {
      this.containerId = 0;
      this.slot = 0;
    } else {
      this.slot = slot;
    }
    this.valid = !this.anchor;
    const head = { fx: hx, fy: hy };
    if (this.attemptFloaterPlacement(head, hl)) {
      const price = this.getFloaterPrice();
      if (this.funds() < price && price !== 0 && this.isPurchase) this.p.error = 0x15;
      else this.valid = true;
      this.p.place(this.floater!, head, hl, this.p.get(this.containerId), this.slot, true);
    }
    this.headFx = hx;
    this.headFy = hy;
    this.level = hl;
    this.lastAnchor = { fx: at.fx, fy: at.fy };
    this.inWorld = true;
  }

  /** cXCursorObject::Pickup (the floater comes out of the world with the cursor). */
  pickup(notify: boolean): void {
    this.inWorld = false;
    const f = this.floater;
    if (f) this.p.pickup(f, notify);
  }

  /**
   * cXCursorObject::AttemptFloaterPlacement (10097a70): where the cursor is,
   * else (an object in the way, single-tile floater) in a slot of an object
   * on that tile whose height the floater accepts, facing like it. A
   * multi-tile container's object faces the first side, from the
   * container's direction on by quarter turns, whose next tile has no
   * obstacle (cXObject::GetObstacleAtLocation); its own direction when all
   * four have one.
   */
  private attemptFloaterPlacement(head: FPt, level: number): boolean {
    const f = this.floater;
    if (!f) return false;
    if (this.p.userCanPlace(f, head, level, this.p.get(this.containerId), this.slot)) return true;
    if (this.p.error !== 0xb || this.p.isMultiTile(f)) return false;
    const heights = Placement.od(f, OD.allowedHeightFlags) & 0xffff;
    for (const o of this.p.tileObjects(tileOf(head.fx), tileOf(head.fy), level)) {
      for (let i = 0; i < o.objectSlots.length - 1; i++) {
        const s = o.objectSlots[i + 1]!;
        if (!(heights & (1 << ((s.height - 1) & 0x3f)))) continue;
        if (!this.p.userCanPlace(f, head, level, o, i)) continue;
        this.containerId = o.objectId;
        this.slot = i;
        let want = o.dir;
        if (this.p.isMultiTile(o)) {
          let side = 0;
          for (; side < 4; side++, want += 2) {
            const [dx, dy] = SIDE_STEP[want & 7]!;
            if (!this.p.obstacleAtLocation({ fx: o.fx + dx * 16, fy: o.fy + dy * 16 }, level)) break;
          }
          if (side === 4) want = f.dir;
        }
        // The cursor's Turn (vtable +0x54); the floater is placed by Place afterwards.
        const notches = Placement.od(f, 23);
        this.turnFloater(notches !== 0 ? Math.trunc((want - f.dir) / notches) : 0);
        return true;
      }
    }
    this.p.error = heights !== 0 && (heights & 0xfff7) === 0 ? 0x24 : 0xb;
    return false;
  }

  /** cXCursorObject::GetFloaterPrice: the master definition's price. */
  getFloaterPrice(): number {
    const f = this.floater;
    return f ? f.selector.getMasterSelector().objd.i16(0x24) : 0;
  }

  /** cXCursorObject::Turn (the floater, its contained objects that turn with it, then placed again). */
  turn(n: number): void {
    const f = this.floater;
    if (!f) {
      this.ownDir = (this.ownDir + 2 * n) & 7;
      return;
    }
    const was = this.lastAnchor;
    const level = this.level + this.anchorOffsets()[2];
    this.pickup(true);
    this.turnFloater(n);
    if (this.canPlace(was, level, null)) this.place(was, level, this.slot);
    else this.valid = false;
  }

  /** cXCursorObject::Turn's floater part: the floater, then the single-tile contents with 2 rotation notches (every part's). */
  private turnFloater(n: number): void {
    const f = this.floater;
    if (!f) return;
    this.p.turnObject(f, n);
    for (const part of this.p.chain(f)) {
      for (const s of part.objectSlots.slice(1)) {
        const c = this.p.get(s.containedId);
        if (c && !this.p.isMultiTile(c) && Placement.od(c, 23) === 2) this.p.turnObject(c, n);
      }
    }
    this.p.assignOffsets(f);
  }

  /** cXCursorObject::FaceDirection. */
  faceDirection(dir: number): void {
    const a = this.anchor;
    if (!a) {
      this.ownDir = dir & 7;
      return;
    }
    if (a.dir === dir) return;
    const was = this.lastAnchor;
    const level = this.level + this.anchorOffsets()[2];
    this.pickup(true);
    for (let i = 0; i < 8 && a.dir !== dir; i++) this.turn(1);
    if (this.canPlace(was, level, null)) this.place(was, level, 0);
  }

  /** cXCursorObject::DropObject: the floater stays where it is (UserPlace) and the cursor lets go of it. */
  dropObject(): boolean {
    const a = this.anchor;
    if (!a || !this.valid) return false;
    const at = this.lastAnchor;
    const level = this.level + this.anchorOffsets()[2];
    const container = this.p.get(this.containerId);
    const slot = this.slot;
    this.pickup(true);
    for (const part of this.p.chain(a)) part.simFlags |= 1;
    this.anchor = null;
    this.p.userPlace(a, at, level, container, slot);
    return true;
  }

  /** cXCursorObject::DetachFloater. */
  detachFloater(): void {
    this.anchor = null;
  }

  /** cXCursorObject::KillFloater. */
  killFloater(): void {
    const f = this.floater;
    if (!f) return;
    const was = this.lastAnchor;
    const level = this.level;
    this.pickup(true);
    killObject(this.p, f);
    this.anchor = null;
    if (this.canPlace(was, level, null)) this.place(was, level, 0);
  }

  /**
   * cXCursorObject::MakeMouseObject(module, object id, cursor selector, level):
   * a cursor carrying object `obj` (picked up), placed where the object was.
   */
  static makeMouseObject(p: Placement, obj: XObject, cursorSel: ObjSelector, level: number, funds: () => number, purchase: boolean): XCursorObject | null {
    const head = p.chain(obj)[0]!;
    if (!purchase && !p.userCanPickup(head)) return null;
    const at = p.isInWorld(obj) ? { fx: obj.fx, fy: obj.fy } : { fx: 0x80, fy: 0x80 };
    const c = new XCursorObject(p, cursorSel, obj, funds);
    c.isPurchase = purchase;
    if (p.isInWorld(head)) p.userPickup(head);
    p.assignOffsets(head);
    if (c.canPlace(at, level || 1, null)) c.place(at, level || 1, 0);
    return c;
  }
}

/** A sprite file whose palettes are PalWrap's monochrome dim CLUT (BuildMonochromeClut with 0.9). */
class DimRenderer extends Renderer {
  private readonly dimmed = new Map<number, Uint8Array>();

  override palette(id: number): Uint8Array {
    let d = this.dimmed.get(id);
    if (!d) {
      const src = super.palette(id);
      d = new Uint8Array(src.length);
      for (let i = 0; i + 2 < src.length; i += 3) {
        // Monochromize(color, 0.9): gray = 0.5 + 0.9 * (r + g + b) / 3, red channel + 0x30.
        const v = Math.min(255, Math.max(0, Math.trunc(0.5 + (0.9 * (src[i]! + src[i + 1]! + src[i + 2]!)) / 3)));
        d[i] = Math.min(255, v + 0x30);
        d[i + 1] = v;
        d[i + 2] = v;
      }
      this.dimmed.set(id, d);
    }
    return d;
  }
}

/** DrawIso adapter for a cursor part or a floater drawn at the cursor. */
export class CursorDrawable implements DrawableObject {
  next: DrawableObject | null = null;
  isDynamic = true;
  hidden = 0;

  constructor(
    readonly sel: ObjSelector,
    readonly renderer: Renderer,
    readonly fx: number,
    readonly fy: number,
    readonly level: number,
    readonly dir: number,
    readonly graphic: number,
    readonly spriteMask: ArrayLike<number> | null,
  ) {}

  get spriteMaskBase(): number {
    return this.sel.objd.dynamicSpritesBaseId;
  }

  items(graphic: number, dirIndex: number, scale: number): readonly DrawGroupItem[] | null {
    return this.sel.getDrawGroup(graphic)?.getItemList(dirIndex, scale)?.items ?? null;
  }
}

/** HouseViewer::RenderCursorObject: the tool's cursor (cXCursorObject::DrawIso on every part). */
export class CursorDrawer {
  cursor: XCursorObject | null = null;
  private readonly renderers = new Map<ResFile, Renderer>();
  private readonly dimRenderers = new Map<ResFile, DimRenderer>();

  constructor(private readonly p: Placement) {}

  private renderer(res: ResFile): Renderer {
    let r = this.renderers.get(res);
    if (!r) {
      r = new Renderer(res);
      this.renderers.set(res, r);
    }
    return r;
  }

  private dimRenderer(res: ResFile): DimRenderer {
    let r = this.dimRenderers.get(res);
    if (!r) {
      r = new DimRenderer(res);
      this.dimRenderers.set(res, r);
    }
    return r;
  }

  draw(viewer: HouseViewer, comp: Compositor, rp: RenderParam): void {
    const c = this.cursor;
    if (!c || !c.inWorld) return;
    for (const part of c.parts()) {
      const fx = c.headFx + part.ox * 16;
      const fy = c.headFy + part.oy * 16;
      const level = c.level + part.ol || 1;
      if (this.p.outOfBounds(tileOf(fx), tileOf(fy)) || level > viewer.level) continue;
      const dir = part.obj ? part.obj.dir : c.dir;
      // cXObject::DrawIso of the cursor itself: graphic 0 (UpdatePlacementFeedback keeps it there).
      rp.setGridCoords(fx, fy, level);
      drawIso(new CursorDrawable(c.cursorSel, this.renderer(c.cursorSel.res), fx, fy, level, dir, 0, null), viewer, comp, rp);
      const f = part.obj;
      if (c.valid || !f || f.hidden !== 0) continue;
      // The floater where the cursor is, monochrome dim, raised to the first standard height it accepts.
      const q = rp.clone();
      q.setGridCoords(fx, fy, level);
      const heights = Placement.od(f, OD.allowedHeightFlags);
      if (!(heights & 1)) {
        const h = HEIGHT_ORDER.find((t) => heights & (1 << (t - 1)));
        if (h !== undefined) {
          q.z += HEIGHT_Z[h]!;
          q.updateScreenCoords();
        }
      }
      const mask = f.spriteVisibility.length ? f.spriteVisibility : null;
      drawIso(new CursorDrawable(f.selector, this.dimRenderer(f.selector.res), fx, fy, level, f.dir, f.graphic, mask), viewer, comp, q);
    }
  }
}
