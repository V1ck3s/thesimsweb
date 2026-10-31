/**
 * DrawDefaultObjectIcon (ObjectIcon.cpp) -> cXObject::DrawIconic / DoIconic:
 * the object picture of the catalog popup, drawn from the object's sprites.
 *
 *  - the object faces the viewer: direction (OBJD FrontDirection + 4) & 7;
 *  - the draw group is the thumbnail graphic (OBJD +0x96, ObjSelector::
 *    GetDrawGroup: base graphic + index, index 0 when out of range); its item
 *    list for that direction bit and the scale (DrawGroup::GetItemList);
 *  - DrawIconic tries scales 3, 2, 1 and keeps the first whose bounds leave
 *    more than 2 px on each side of the rectangle, then centers the bounds;
 *  - DoIconic draws each item at (x + item x, y + item y - frame height -
 *    z * 2^(scale + 1)) with cRenderer::DrawShape (z-sprites, mirrored with
 *    flag bit 0); a multi-tile object draws each part at its tile offset
 *    (BuildIconMTDrawOrder), back to front.
 *
 * Simplifications: no shadow (IconProps are null for the catalog), depth only
 * orders the sprites of one part, the tile
 * offsets of multi-tile parts use the standard 2:1 projection with the parts'
 * GetMultiTileOffsets (x = sub index >> 8, y = sub index & 0xff) turned with the
 * object's direction.
 */

import { OBJD, readObjdTable } from "../../data/catalog.js";
import type { ResFile } from "../../world/iffres.js";
import { Renderer } from "../../world/renderer.js";
import { PX_ALPHA, PX_NONE } from "../../world/spr.js";
import { engine } from "../../../engine/wasm.js";
import { decodeImage } from "../../res/bmp.js";

interface DrawItem {
  spr: number;
  frame: number;
  x: number;
  y: number;
  z: number;
  flags: number;
}

interface DgrpImage {
  directionFlags: number;
  zoomLevel: number;
  sprites: Array<{
    sprChunkId: number;
    sprFrameNumber: number;
    spriteXOffset: number;
    spriteYOffset: number;
    objectZOffset: number;
    flags: number;
  }>;
}

interface Part {
  fields: number[];
  /** Tile offset of the part, in tiles. */
  tx: number;
  ty: number;
}

interface Placed {
  part: number;
  item: DrawItem;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The item list of a draw group for a direction and scale (DrawGroup::GetItemList). */
function itemList(images: DgrpImage[], dir: number, scale: number): DrawItem[] {
  const img = images.find((i) => (i.directionFlags & (1 << dir)) !== 0 && i.zoomLevel === scale);
  if (!img) return [];
  return img.sprites.map((s) => ({
    spr: s.sprChunkId,
    frame: s.sprFrameNumber,
    x: s.spriteXOffset,
    y: s.spriteYOffset,
    z: s.objectZOffset,
    flags: s.flags,
  }));
}

export class ObjectIcon {
  private readonly renderer: Renderer;
  /** The rectangle DrawIconic returns: the bounds of the last draw, in the target's coordinates. */
  bounds: { left: number; top: number; right: number; bottom: number } | null = null;

  private constructor(
    private readonly file: ResFile,
    private readonly parts: Part[],
    private readonly dir: number,
    private readonly dgrps: Map<number, DgrpImage[]>,
  ) {
    this.renderer = new Renderer(file);
  }

  /** The object `objdId` of `file` (a master object draws all its parts). */
  static async create(file: ResFile, objdId: number): Promise<ObjectIcon | null> {
    const table = await readObjdTable(file);
    const self = table.find((o) => o.id === objdId);
    if (!self) return null;
    const f = (o: { fields: number[] }, i: number): number => o.fields[i] ?? 0;
    const dir = (f(self, OBJD.frontDirection) + 4) & 7;
    const master = f(self, OBJD.masterId);
    const parts: Part[] = [];
    if (master !== 0) {
      for (const o of table) {
        const sub = f(o, OBJD.subIndex);
        if (f(o, OBJD.masterId) !== master || sub === -1) continue;
        const x = sub >> 8;
        const y = sub & 0xff;
        // Turn the layout with the object (dir 0: as is; 2, 4, 6: quarter turns).
        const [tx, ty] = [[x, y], [-y, x], [-x, -y], [y, -x]][(dir >> 1) & 3]!;
        parts.push({ fields: o.fields, tx: tx!, ty: ty! });
      }
      parts.sort((a, b) => a.tx + a.ty - (b.tx + b.ty));
    } else {
      parts.push({ fields: self.fields, tx: 0, ty: 0 });
    }
    const wasm = await engine();
    const dgrps = new Map<number, DgrpImage[]>();
    for (const c of file.list("DGRP")) {
      try {
        dgrps.set(c.id, (wasm.parseDgrp(file.payload(c)) as { images: DgrpImage[] }).images);
      } catch {
        // A draw group the parser does not know draws nothing.
      }
    }
    return new ObjectIcon(file, parts, dir, dgrps);
  }

  /** ObjSelector::GetDrawGroup(thumbnail graphic) of a part. */
  private drawGroup(p: Part): DgrpImage[] {
    const f = (i: number): number => p.fields[i] ?? 0;
    let idx = f(OBJD.thumbnailGraphic);
    if (f(OBJD.numGraphics) <= idx) idx = 0;
    return this.dgrps.get(f(OBJD.baseGraphic) + idx) ?? [];
  }

  /** DoIconic: the sprites of every part at `scale`, positioned around (0, 0). */
  private layout(scale: number): Placed[] {
    const out: Placed[] = [];
    const halfW = 8 << scale;
    const halfH = 4 << scale;
    for (const [k, p] of this.parts.entries()) {
      const ox = (p.tx - p.ty) * halfW;
      const oy = (p.tx + p.ty) * halfH;
      for (const it of itemList(this.drawGroup(p), this.dir, scale)) {
        if (it.frame >= this.renderer.countSprites(it.spr)) continue;
        const b = this.renderer.getShapeBounds(it.spr, it.frame);
        if (b.width <= 0 || b.height <= 0) continue;
        let y = oy + it.y - b.height;
        if (it.z !== 0) y -= Math.trunc(it.z * (1 << (scale + 1)));
        out.push({ part: k, item: it, x: ox + it.x, y, w: b.width, h: b.height });
      }
    }
    return out;
  }

  /** cXObject::DrawIconic into `ctx` inside (x, y, w, h); returns the scale used. */
  draw(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, x: number, y: number, w: number, h: number): number {
    let scale = 3;
    let placed: Placed[] = [];
    let dx = 0;
    let dy = 0;
    for (; scale > 0; scale--) {
      placed = this.layout(scale);
      if (!placed.length) continue;
      const left = Math.min(...placed.map((p) => p.x));
      const top = Math.min(...placed.map((p) => p.y));
      const right = Math.max(...placed.map((p) => p.x + p.w));
      const bottom = Math.max(...placed.map((p) => p.y + p.h));
      const cx = Math.trunc((w - (right - left)) / 2);
      const cy = Math.trunc((h - (bottom - top)) / 2);
      dx = cx - left;
      dy = cy - top;
      if (cx > 2 && cy > 2) break;
    }
    if (scale < 1) scale = 1;
    this.bounds = null;
    if (!placed.length) return scale;
    this.bounds = {
      left: x + dx + Math.min(...placed.map((p) => p.x)),
      top: y + dy + Math.min(...placed.map((p) => p.y)),
      right: x + dx + Math.max(...placed.map((p) => p.x + p.w)),
      bottom: y + dy + Math.max(...placed.map((p) => p.y + p.h)),
    };
    const img = ctx.getImageData(x, y, w, h);
    const zbuf = new Uint16Array(w * h);
    let part = -1;
    for (const p of placed) {
      // Parts are drawn back to front; depth only sorts the sprites of one part.
      if (p.part !== part) zbuf.fill(0xffff);
      part = p.part;
      this.blit(img.data, zbuf, w, h, p, p.x + dx, p.y + dy);
    }
    ctx.putImageData(img, x, y);
    return scale;
  }

  /** cRenderer::DrawShape for one z-sprite (depth = sprite z; alpha pixels are not depth-written). */
  private blit(px: Uint8ClampedArray, zbuf: Uint16Array, w: number, h: number, p: Placed, x0: number, y0: number): void {
    const f = this.renderer.frame(p.item.spr, p.item.frame);
    if (!f) return;
    const pal = this.renderer.palette(f.paletteId);
    const mirror = (p.item.flags & 1) !== 0;
    for (let sy = 0; sy < f.height; sy++) {
      const dy = y0 + sy;
      if (dy < 0 || dy >= h) continue;
      for (let sx = 0; sx < f.width; sx++) {
        const i = sy * f.width + sx;
        const mode = f.mode[i]!;
        if (mode === PX_NONE) continue;
        const dx = x0 + (mirror ? f.width - 1 - sx : sx);
        if (dx < 0 || dx >= w) continue;
        const o = dy * w + dx;
        const z = f.z[i]!;
        if (z > zbuf[o]!) continue;
        const c = f.index[i]! * 3;
        const a = mode === PX_ALPHA ? f.alpha[i]! / 31 : 1;
        const q = o * 4;
        px[q] = px[q]! * (1 - a) + pal[c]! * a;
        px[q + 1] = px[q + 1]! * (1 - a) + pal[c + 1]! * a;
        px[q + 2] = px[q + 2]! * (1 - a) + pal[c + 2]! * a;
        px[q + 3] = 255;
        if (mode !== PX_ALPHA) zbuf[o] = z;
      }
    }
  }
}

/** RenderCatalogShot's work buffer (lbl_105BA834: a 200x200 buffer with a z-buffer). */
const SHOT_BUFFER = 200;
/** SquareOffAndShrink's largest ratio (lbl_105BC1B0). */
const SHOT_MAX_RATIO = 1;

/**
 * SquareOffAndShrink: the drawn rectangle grown to at least `size` and squared
 * off (centered, the odd pixel on the right / bottom), clamped to the buffer;
 * the ratio that brings it to `size` (at most 1).
 */
function squareOffAndShrink(
  b: { left: number; top: number; right: number; bottom: number },
  size: number,
): { left: number; top: number; right: number; bottom: number; ratio: number } | null {
  let { left, top, right, bottom } = b;
  const w = right - left;
  const h = bottom - top;
  const grow = (n: number): [number, number] => [Math.trunc((size - n) / 2), (size - n) % 2];
  if (h < w) {
    if (w < size) {
      const [half, odd] = grow(w);
      right += half + Math.max(odd, 0);
      left -= half;
    }
  } else if (w < h) {
    if (h < size) {
      const [half, odd] = grow(h);
      bottom += half + Math.max(odd, 0);
      top -= half;
    }
  } else if (w < size) {
    const [half, odd] = grow(w);
    right += half + Math.max(odd, 0);
    bottom += half + Math.max(odd, 0);
    left -= half;
    top -= half;
  }
  const d = right - left - (bottom - top);
  if (d > 0) {
    bottom += Math.trunc(d / 2) + (d & 1);
    top -= Math.trunc(d / 2);
  } else if (d < 0) {
    left += Math.trunc(d / 2);
    right -= Math.trunc(d / 2);
    if (d & 1) right += 1;
  }
  left = Math.max(left, 0);
  top = Math.max(top, 0);
  right = Math.min(right, SHOT_BUFFER - 1);
  bottom = Math.min(bottom, SHOT_BUFFER - 1);
  if (left >= right || top >= bottom) return null;
  return { left, top, right, bottom, ratio: Math.min(size / (right - left), SHOT_MAX_RATIO) };
}

/**
 * Product::GenerateGraphics for an object file without a 74x37 BMP_ catalog
 * picture: RenderCatalogShot makes two shots, each on the color found at the
 * center of frames 0 and 1 (lbl_105BC0A4) of the catalog button template
 * (kCatalogTemplate, lbl_105BA780), size template height - 8:
 *
 *  - the 200x200 buffer is filled with that color, SetupDrawIconic, then
 *    cXObject::DrawIconic(thumbnail graphic) into the whole buffer;
 *  - SquareOffAndShrink crops the drawn rectangle and ScaleBitmap scales it
 *    down to the shot size;
 *  - the two shots are put side by side (normal, highlighted).
 *
 * The game then writes the picture back into the object file (BMP_ with the
 * catalog strings id); the web client keeps it in memory. Not ported: the
 * thumbnail shadow (ObjSelector::GetThumbnailHasShadow); ScaleBitmap's filter
 * is the canvas' smoothing.
 */
export async function renderCatalogShot(file: ResFile, objdId: number, template: ImageBitmap): Promise<ImageBitmap | null> {
  const icon = await ObjectIcon.create(file, objdId);
  if (!icon) return null;
  const th = template.height;
  const size = th - 8;
  const tpl = new OffscreenCanvas(template.width, th).getContext("2d", { willReadFrequently: true })!;
  tpl.drawImage(template, 0, 0);
  const work = new OffscreenCanvas(SHOT_BUFFER, SHOT_BUFFER);
  const wg = work.getContext("2d", { willReadFrequently: true })!;
  const out = new OffscreenCanvas(size * 2, size);
  const og = out.getContext("2d")!;
  og.imageSmoothingQuality = "high";
  let x = 0;
  for (const frame of [0, 1]) {
    const [r, g, b] = tpl.getImageData(Math.min(template.width - 1, (th >> 1) + th * frame), th >> 1, 1, 1).data;
    wg.fillStyle = `rgb(${r},${g},${b})`;
    wg.fillRect(0, 0, SHOT_BUFFER, SHOT_BUFFER);
    icon.draw(wg, 0, 0, SHOT_BUFFER, SHOT_BUFFER);
    const rect = icon.bounds && squareOffAndShrink(icon.bounds, size);
    if (!rect) return null;
    const sw = Math.round((rect.right - rect.left) * rect.ratio);
    const sh = Math.round((rect.bottom - rect.top) * rect.ratio);
    og.drawImage(work, rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top, x, 0, sw, sh);
    x += sw;
  }
  return createImageBitmap(out);
}

/** Product::GenerateGraphics' picture size (a 74x37 BMP_: normal and highlighted halves). */
const CATALOG_ICON_W = 0x4a;
const CATALOG_ICON_H = 0x25;

/**
 * Product::GenerateGraphics for any object selector (the catalog keeps a
 * Product for every selector Catalog::Init accepts, even one no sort shows):
 * the object file's BMP_ with the catalog strings id (OBJD +0x52; dropped
 * unless 74x37 when the object has graphics), else RenderCatalogShot when
 * the object has graphics; null means kItemUnknown.
 */
export async function generateGraphics(
  file: ResFile,
  objdId: number,
  catalogStringsId: number,
  hasGraphics: boolean,
  template: ImageBitmap,
): Promise<ImageBitmap | null> {
  const bytes = file.get("BMP_", catalogStringsId);
  if (bytes) {
    try {
      const img = decodeImage(bytes, "catalog.bmp");
      // The 74x37 size is only checked for an object with graphics (Windows
      // FUN_004cbf52, Mac 102011F0): a graphics-less one keeps any BMP_ (the Go
      // Here destination's 45x45 DestinationIcon.bmp).
      if (!hasGraphics || (img.width === CATALOG_ICON_W && img.height === CATALOG_ICON_H)) {
        return await createImageBitmap(new ImageData(img.data, img.width, img.height));
      }
    } catch {
      // An unreadable picture is rendered like a missing one.
    }
  }
  return hasGraphics ? renderCatalogShot(file, objdId, template).catch(() => null) : null;
}

/** ComposeBtnImage's buffer (0x2d x 0x2d). */
const COMPOSED = 0x2d;

/**
 * Product::ComposeBtnImage: a 45x45 picture made of the catalog template's
 * first frame (lbl_105BA780) with the product picture (its left half when
 * wider than 45) centered on it.
 */
export async function composeBtnImage(template: ImageBitmap, picture: ImageBitmap | null): Promise<ImageBitmap> {
  const c = new OffscreenCanvas(COMPOSED, COMPOSED);
  const g = c.getContext("2d")!;
  g.drawImage(template, 0, 0, COMPOSED, COMPOSED, 0, 0, COMPOSED, COMPOSED);
  if (picture) {
    const w = picture.width > COMPOSED ? Math.trunc(picture.width / 2) : picture.width;
    const h = picture.height;
    g.drawImage(picture, 0, 0, w, h, Math.trunc((COMPOSED - w) / 2), Math.trunc((COMPOSED - h) / 2), w, h);
  }
  return createImageBitmap(c);
}
