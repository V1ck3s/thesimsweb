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
 *  - IconProps (RenderCatalogShot): +0 = 1 sets RenderParam::Hilite, so the
 *    sprites take PalWrap's sprite brite CLUT; +4 (has shadow) with a
 *    shadow id (ObjSelector::GetShadowID, not -1) first adds the part's tile
 *    rectangle (+-8 << scale, +-4 << scale around its point) to the bounds
 *    and draws its floor shadow there (FloorShadowMgr::GetShadow of the id
 *    turned by the direction (lbl_105BA23C), DrawShadow at 0x28).
 *
 * Simplifications: depth only orders the sprites of one part, the tile
 * offsets of multi-tile parts use the standard 2:1 projection with the parts'
 * GetMultiTileOffsets (x = sub index >> 8, y = sub index & 0xff) turned with the
 * object's direction.
 */

import { OBJD, readObjdTable } from "../../data/catalog.js";
import { DrawGroup } from "../../world/drawgroup.js";
import { drawShadow, FloorShadowMgr, rotateShadowID } from "../../world/floorshadow.js";
import { ResFile } from "../../world/iffres.js";
import { SHADOW_VALID } from "../../world/objselector.js";
import { Renderer } from "../../world/renderer.js";
import { PX_ALPHA, PX_NONE } from "../../world/spr.js";
import { decodeImage } from "../../res/bmp.js";

interface DrawItem {
  spr: number;
  frame: number;
  x: number;
  y: number;
  z: number;
  flags: number;
}

interface Part {
  fields: number[];
  /** Tile offset of the part, in tiles. */
  tx: number;
  ty: number;
  /** ObjSelector::GetShadowID (-1 = none). */
  shadowId: number;
}

/** OBJD +0x72 (shadow) and +0x70 (level offset), as readObjdTable field indexes. */
const OBJD_SHADOW = 55;
const OBJD_LEVEL_OFFSET = 54;

/** IconProps: +0 hilite (1), +4 has shadow. */
export interface IconProps {
  hilite: boolean;
  shadow: boolean;
}

/** FloorGraphicsMgr::GetFloorShadowMgr(scale), over GetGlobalRenderer (GameData/floors.iff). */
let shadowMgrs: Promise<FloorShadowMgr[]> | null = null;
function floorShadowMgrs(): Promise<FloorShadowMgr[]> {
  shadowMgrs ??= ResFile.open("GameData/floors.iff").then((res) => {
    const global = new Renderer(res);
    return [1, 2, 3].map((s) => new FloorShadowMgr(global, s));
  });
  return shadowMgrs;
}

interface Placed {
  part: number;
  /** null: the part's floor shadow. */
  item: DrawItem | null;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The item list of a draw group for a direction and scale (DrawGroup::GetItemList). */
function itemList(group: DrawGroup | undefined, dir: number, scale: number): DrawItem[] {
  const list = group?.getItemList(dir, scale);
  if (!list) return [];
  return list.items.map((s) => ({ spr: s.sprId, frame: s.frame, x: s.xOff, y: s.yOff, z: s.objZ, flags: s.flags }));
}

export class ObjectIcon {
  private readonly renderer: Renderer;
  /** The rectangle DrawIconic returns: the bounds of the last draw, in the target's coordinates. */
  bounds: { left: number; top: number; right: number; bottom: number } | null = null;

  private constructor(
    private readonly file: ResFile,
    private readonly parts: Part[],
    private readonly dir: number,
    private readonly dgrps: Map<number, DrawGroup>,
    private readonly shadows: FloorShadowMgr[],
    /** ObjSelector::GetThumbnailHasShadow: the master's OBJD +0x98 bit 0 clear. */
    readonly thumbnailHasShadow: boolean,
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
      const subs = table.filter((o) => f(o, OBJD.masterId) === master && f(o, OBJD.subIndex) !== -1);
      // ObjectFolder::GetSubTileSelector(x, y, level 0) for ComputeShadowID.
      const at = (x: number, y: number): { fields: number[] } | undefined =>
        x < 0 || y < 0 ? undefined : subs.find((o) => f(o, OBJD.subIndex) === ((((x << 8) | (y & 0xff)) << 16) >> 16) && f(o, OBJD_LEVEL_OFFSET) === 0);
      for (const o of subs) {
        const sub = f(o, OBJD.subIndex);
        const x = sub >> 8;
        const y = sub & 0xff;
        // Turn the layout with the object (dir 0: as is; 2, 4, 6: quarter turns).
        const [tx, ty] = [[x, y], [-y, x], [-x, -y], [y, -x]][(dir >> 1) & 3]!;
        // ObjSelector::ComputeShadowID: the mask of the neighbouring parts that cast a shadow.
        let shadowId = -1;
        if (f(o, OBJD_SHADOW) !== -1) {
          const casts = (dx: number, dy: number): boolean => {
            const n = at(x + dx, y + dy);
            return n !== undefined && f(n, OBJD_SHADOW) !== -1;
          };
          let id = 0;
          if (casts(0, -1)) id |= 1;
          if (casts(-1, 0)) id |= 2;
          if (casts(0, 1)) id |= 4;
          if (casts(1, 0)) id |= 8;
          if (casts(-1, -1)) id |= 0x10;
          if (casts(-1, 1)) id |= 0x20;
          if (casts(1, 1)) id |= 0x40;
          if (casts(1, -1)) id |= 0x80;
          shadowId = SHADOW_VALID[id] === 1 ? id : 0;
        }
        parts.push({ fields: o.fields, tx: tx!, ty: ty!, shadowId });
      }
      parts.sort((a, b) => a.tx + a.ty - (b.tx + b.ty));
    } else {
      parts.push({ fields: self.fields, tx: 0, ty: 0, shadowId: f(self, OBJD_SHADOW) });
    }
    // DrawGroup::Load (every version: the old record lists of the original objects too).
    const dgrps = new Map<number, DrawGroup>();
    for (const c of file.list("DGRP")) {
      try {
        dgrps.set(c.id, DrawGroup.load(c.id, file.payload(c)));
      } catch {
        // An unreadable draw group draws nothing.
      }
    }
    return new ObjectIcon(file, parts, dir, dgrps, await floorShadowMgrs(), (f(self, OBJD.shadowFlags) & 1) === 0);
  }

  /** ObjSelector::GetDrawGroup(graphic) of a part: its thumbnail graphic unless DrawIconic was given one. */
  private drawGroup(p: Part, graphic: number | null): DrawGroup | undefined {
    const f = (i: number): number => p.fields[i] ?? 0;
    let idx = graphic ?? f(OBJD.thumbnailGraphic);
    if (f(OBJD.numGraphics) <= idx) idx = 0;
    return this.dgrps.get(f(OBJD.baseGraphic) + idx);
  }

  /** DoIconic: the sprites of every part at `scale`, positioned around (0, 0), each part's shadow first. */
  private layout(scale: number, props: IconProps | null, graphic: number | null): Placed[] {
    const out: Placed[] = [];
    const halfW = 8 << scale;
    const halfH = 4 << scale;
    for (const [k, p] of this.parts.entries()) {
      const ox = (p.tx - p.ty) * halfW;
      const oy = (p.tx + p.ty) * halfH;
      const items = itemList(this.drawGroup(p, graphic), this.dir, scale);
      if (!items.length) continue;
      if (props?.shadow && p.shadowId !== -1) out.push({ part: k, item: null, x: ox - halfW, y: oy - halfH, w: 2 * halfW, h: 2 * halfH });
      for (const it of items) {
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

  /**
   * cXObject::DrawIconic into `ctx` inside (x, y, w, h) with IconProps `props`;
   * returns the scale used. `graphic` is the draw group index (null: each
   * part's thumbnail graphic); `fixedScale` (the int const * argument) skips
   * the 3, 2, 1 search and draws at that scale, centered.
   */
  draw(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    props: IconProps | null = null,
    graphic: number | null = null,
    fixedScale: number | null = null,
  ): number {
    let scale = fixedScale ?? 3;
    let placed: Placed[] = [];
    let dx = 0;
    let dy = 0;
    for (; scale > 0; scale--) {
      placed = this.layout(scale, props, graphic);
      if (placed.length) {
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
      if (fixedScale !== null) break;
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
    // Pixels whose z left 0xffff (DrawShadow only darkens the others).
    const drawn = new Uint8Array(w * h);
    const mgr = this.shadows[scale - 1];
    let part = -1;
    for (const p of placed) {
      // Parts are drawn back to front; depth only sorts the sprites of one part.
      if (p.part !== part) zbuf.fill(0xffff);
      part = p.part;
      if (!p.item) {
        // ShadowID turned by the direction: lbl_105BA23C[id + (dir / 2) * 0x100 - 0x100].
        const s = mgr?.getShadow(rotateShadowID(this.parts[p.part]!.shadowId, this.dir >> 1));
        if (mgr && s) drawShadow(img.data, drawn, w, h, p.x + dx, p.y + dy, s, mgr.width, mgr.height);
        continue;
      }
      this.blit(img.data, zbuf, drawn, w, h, p, p.item, p.x + dx, p.y + dy, props?.hilite ?? false);
    }
    ctx.putImageData(img, x, y);
    return scale;
  }

  /**
   * cRenderer::DrawShape for one z-sprite (depth = sprite z; alpha pixels are
   * not depth-written), with the sprite brite CLUT when hilited.
   */
  private blit(px: Uint8ClampedArray, zbuf: Uint16Array, drawn: Uint8Array, w: number, h: number, p: Placed, item: DrawItem, x0: number, y0: number, hilite: boolean): void {
    const f = this.renderer.frame(item.spr, item.frame);
    if (!f) return;
    const pal = hilite ? this.renderer.britePalette(f.paletteId) : this.renderer.palette(f.paletteId);
    const mirror = (item.flags & 1) !== 0;
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
        if (mode !== PX_ALPHA) {
          zbuf[o] = z;
          drawn[o] = 1;
        }
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

/** ScaleBitmap's contributions for one axis: per output pixel, (source index, weight) pairs. */
function scaleContributions(n: number, nOut: number): Array<Array<[number, number]>> {
  // fVar2 = new size / old size; the support is 1 / f source pixels when shrinking (fVar5), 1 otherwise.
  const f = Math.fround(nOut / n);
  const radius = f < 1 ? Math.fround(1 / f) : 1;
  const k = Math.fround(1 / radius);
  const out: Array<Array<[number, number]>> = [];
  for (let i = 0; i < nOut; i++) {
    const center = Math.fround(i / f);
    const lo = Math.ceil(Math.fround(center - radius));
    const hi = Math.floor(Math.fround(center + radius));
    const list: Array<[number, number]> = [];
    let sum = 0;
    for (let j = lo; j <= hi; j++) {
      let t = Math.fround((center - j) * k);
      if (t < 0) t = -t;
      // 2t^3 - 3t^2 + 1 inside the support (lbl_105BBFF8 +0x10 / +0x14), times 1 / radius.
      const w = Math.fround(k * (t >= 1 ? 0 : Math.fround(t * (2 * t - 3) * t + 1)));
      sum += w;
      // Out-of-range indexes are mirrored at both edges.
      let m = j;
      for (;;) {
        if (m < 0) m = -m;
        if (m < n) break;
        m = n * 2 - m - 2;
      }
      list.push([m, w]);
    }
    const norm = sum > 1e-12 ? 1 / sum : sum;
    for (const c of list) c[1] = Math.fround(norm * c[1]);
    out.push(list);
  }
  return out;
}

/** cTSBuffer's 16-bit (5:6:5) pixels: what the work buffer keeps of a color. */
function to565(px: Uint8ClampedArray): void {
  for (let i = 0; i < px.length; i += 4) {
    px[i] = px[i]! & 0xf8;
    px[i + 1] = px[i + 1]! & 0xfc;
    px[i + 2] = px[i + 2]! & 0xf8;
  }
}

/**
 * ScaleBitmap(ratio, ratio, buffer, rect, false): the rectangle resampled to
 * ceil(size * ratio) pixels per axis, first along x, then along y, each
 * output pixel the normalized sum of the source pixels within 1 / ratio of
 * i / ratio, weighted by 2t^3 - 3t^2 + 1 of their distance in output pixels
 * (edges mirrored); a weight sum below 0.46875 would give the transparent
 * color (the work buffer has none). Results go back to 16 bits.
 */
function scaleBitmap(src: ImageData, r: { left: number; top: number; right: number; bottom: number }, ratio: number): ImageData | null {
  const w = r.right - r.left;
  const h = r.bottom - r.top;
  const nw = Math.trunc(0.5 + Math.ceil(Math.fround(w * ratio)));
  const nh = Math.trunc(0.5 + Math.ceil(Math.fround(h * ratio)));
  if (w <= 0 || h <= 0 || nw <= 0 || nh <= 0) return null;
  const sp = src.data;
  const sw = src.width;
  const xs = scaleContributions(w, nw);
  const ys = scaleContributions(h, nh);
  const pass = (get: (j: number, ch: number) => number, contrib: Array<[number, number]>): [number, number, number] | null => {
    let ws = 0;
    let a = 0;
    let b = 0;
    let c = 0;
    for (const [j, wt] of contrib) {
      ws += wt;
      a += get(j, 0) * wt;
      b += get(j, 1) * wt;
      c += get(j, 2) * wt;
    }
    if (ws < 0.46875) return null;
    const inv = 1 / ws;
    return [Math.trunc(0.5 + a * inv) & 0xf8, Math.trunc(0.5 + b * inv) & 0xfc, Math.trunc(0.5 + c * inv) & 0xf8];
  };
  // The x pass into an nw x h buffer.
  const mid = new Uint8ClampedArray(nw * h * 4);
  for (let y = 0; y < h; y++) {
    const row = (r.top + y) * sw + r.left;
    for (let x = 0; x < nw; x++) {
      const o = (y * nw + x) * 4;
      const v = pass((j, ch) => sp[(row + j) * 4 + ch]!, xs[x]!) ?? [0, 0, 0];
      mid[o] = v[0];
      mid[o + 1] = v[1];
      mid[o + 2] = v[2];
      mid[o + 3] = 255;
    }
  }
  // The y pass.
  const out = new ImageData(nw, nh);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const o = (y * nw + x) * 4;
      const v = pass((j, ch) => mid[(j * nw + x) * 4 + ch]!, ys[y]!) ?? [0, 0, 0];
      out.data[o] = v[0];
      out.data[o + 1] = v[1];
      out.data[o + 2] = v[2];
      out.data[o + 3] = 255;
    }
  }
  return out;
}

/**
 * Product::GenerateGraphics for an object file without a 74x37 BMP_ catalog
 * picture: RenderCatalogShot makes two shots, each on the color found at the
 * center of frames 0 and 1 (lbl_105BC0A4) of the catalog button template
 * (kCatalogTemplate, lbl_105BA780), size template height - 8:
 *
 *  - the 200x200 16-bit buffer is filled with that color, SetupDrawIconic, then
 *    cXObject::DrawIconic(thumbnail graphic) into the whole buffer with the
 *    IconProps { hilite: second shot, shadow: GetThumbnailHasShadow };
 *  - SquareOffAndShrink crops the drawn rectangle and ScaleBitmap scales it
 *    down to the shot size;
 *  - the two shots are put side by side (normal, highlighted).
 *
 * The game then writes the picture back into the object file (BMP_ with the
 * catalog strings id); the web client keeps it in memory. The 16-bit
 * buffer is matched by keeping 5:6:5 of the drawn picture.
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
  let x = 0;
  for (const frame of [0, 1]) {
    const [r, g, b] = tpl.getImageData(Math.min(template.width - 1, (th >> 1) + th * frame), th >> 1, 1, 1).data;
    wg.fillStyle = `rgb(${r},${g},${b})`;
    wg.fillRect(0, 0, SHOT_BUFFER, SHOT_BUFFER);
    icon.draw(wg, 0, 0, SHOT_BUFFER, SHOT_BUFFER, { hilite: frame === 1, shadow: icon.thumbnailHasShadow });
    const rect = icon.bounds && squareOffAndShrink(icon.bounds, size);
    if (!rect) return null;
    const drawn = wg.getImageData(0, 0, SHOT_BUFFER, SHOT_BUFFER);
    to565(drawn.data);
    const shot = scaleBitmap(drawn, rect, rect.ratio);
    if (!shot) return null;
    og.putImageData(shot, x, 0, 0, 0, Math.min(shot.width, size * 2 - x), Math.min(shot.height, size));
    x += shot.width;
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
