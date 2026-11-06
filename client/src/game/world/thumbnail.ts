/**
 * The house thumbnails House::SaveFile writes (GlobalDispatch(0x92) on the
 * HouseViewer: HouseViewer::SaveThumbnail(file, 0x200) then
 * SaveUnleashedThumbnail(file, 0x400); +0x4f, set by the constructor, is
 * never cleared). The neighborhood screens show them (nbhd/nghinterface.ts):
 *
 *   BMP_ 512 / 513  the lot without / with its roof, at 1/4 of zoom 1
 *   THMB 512        ThumbnailInfo: the lot center in the bitmap (x, y), z, and
 *                   the roof bitmap's offset from the house bitmap (dx, dy)
 *   BMP_ 1024 / 1025, THMB 1024
 *                   the same at 1/8 (the Unleashed screen's half-size pair)
 *
 * SaveThumbnail (and SaveUnleashedThumbnail, at half the size and scale
 * 0.125):
 *   - the size: w = ((maxX - minX) + view width) >> (scale + 1), h likewise
 *     (GetOffsetsMinMax at the current scale), the offsets maxX / maxY scaled
 *     to zoom 1 (divided by 1 << (scale - 1));
 *   - daytime (cSimulator +0x18 = 0, cTerrain::SetColor, the terrain swatch's
 *     time of day, RoomManager::AllRoomsLightingChanged), terrain detail 2;
 *   - two MakeThumbnail passes into the same buffer: the lot (pass 0), then
 *     the roof drawn over it (pass 1, SetRoofDetail(2));
 *   - each pass: ShrinkWrap (the transparent margins), the cropped bitmap as
 *     a 24-bit BMP_ (MakeMemoryBMP) labelled "Thumbnail", id 512 + pass;
 *   - THMB 512 (label ""): ThumbnailInfo x / y minus pass 0's left / top
 *     margins, z, pass 1's margins minus pass 0's (ThumbnailInfo::Swizzle).
 * SaveLowMemoryThumbnail (BMP_ 612 / 613 copied from the application's
 * BMP_ 1000 resource) writes nothing on the PC build (no such resource).
 *
 * MakeThumbnail(scale f, w, h, rotation 0, zoom 1, offsets, ThumbnailInfo,
 * level 2, roof pass, transparent color, &buffer): a buffer of
 * (0.5 + w / f) x (0.5 + h / f) cleared to the transparent color (thumbnail
 * mode: GetClearColor returns it), the view rect set to it, zoom 1,
 * rotation 0, level 2, cutaway (+0x48) and dynamic cutaway (+0x49) off,
 * SetOffsets(offsets), the terrain grid overlay hidden; ThumbnailInfo from
 * the average tile of the lot (tiles without flag 0x20): TileToPoint at
 * level 1, altitude 0, shifted right by 1 / 2 / 3 for f = 0.5 / 0.25 / 0.125,
 * z = +0x1f4 (GetOffsetsMinMax's lowest row) shifted the same; pass 0 runs
 * UpdateStaticLayer and RenderDynamicObjects, then (both passes, when +0x51
 * is set: always in pass 1) the roof polygons; then ScaleBitmap(f) and the
 * view restored.
 *
 * Port: the buffer is rendered by the lot's HouseViewer in pieces of its
 * own size (its WebGL target), the origin moved for each piece, and read
 * back. Pixels are 16-bit in the display format (App+0x34) as in the
 * original's buffers: ScaleBitmap reads and writes them with Cvt565toRGB /
 * CvtRGBto565 (format 2, the Windows 16-bit display the port assumes) or
 * Cvt555toRGB / CvtRGBto555 (format 1), and MakeMemoryBMP(..., true) turns
 * 565 into 555 (pixel >> 1, the green's low bit dropped) only when writing
 * the BMP_ (the shipped BMP_s' colors are multiples of 8): the green keeps
 * its 6 bits through the filtering. Pass 1 renders the view again with
 * +0x51 (HouseViewer.drawRoof / the walls' drawRoof) set; the roof texture
 * is loaded beforehand (prepareHouseThumbnails), the render being
 * synchronous.
 *
 * No people: MakeThumbnail (101b8ad0, Windows 004b2d29) renders
 * UpdateStaticLayer and RenderDynamicObjects only. The 3D objects (the
 * people's meshes and the 3D objects they carry, HouseViewer +0x1d8 /
 * +0x1e4) are drawn by Render3DObject, which only UpdateStaticDynamic,
 * GenerateSnapshot and DrawPictureInPicture call. A person in the dynamic
 * list still gets cXPerson::DrawIso: the sprite object in its hand
 * (SAnimator::PrepReg, `placeHeld`) and its sprite slots, which draw nothing
 * at scale 1 (balloons.ts). So `viewer.people` (the meshes) is off during
 * the render. The game's own saves agree (House01, saved with Kyle and Jada
 * on the lot: no person in BMP_ 512 / 513).
 */

import { WallState } from "../cpstate.js";
import { buildIff, parseIff, type IffChunk } from "../data/iff.js";
import { encodeBmp } from "../data/bmpwrite.js";
import { engine } from "../../engine/wasm.js";
import { Compositor } from "./compositor.js";
import { FloorGraphicsMgr } from "./floors.js";
import { HouseViewer } from "./houseviewer.js";
import { ResFile } from "./iffres.js";
import { RoomLighting } from "./lighting.js";
import { customWallStyleOf, loadLotObjectDrawer } from "./lotobjects.js";
import { loadRoofSettings, roofLayersOf } from "./roofs.js";
import { computeRooms, RoomManager } from "./rooms.js";
import { houseNumberOfPath, Terrain } from "./terrain.js";
import { getDisplayFormat } from "./terrain_renderer.js";
import { WallManager } from "./walls.js";
import { readLotSize } from "./winlotview.js";
import { FixedWorld, RotatableWorld } from "./world.js";

/** lbl_105BBF58 [1] / [2]: SaveThumbnail's and SaveUnleashedThumbnail's scales. */
const SCALE_THUMBNAIL = 0.25;
const SCALE_UNLEASHED = 0.125;
/** lbl_105BBF50: the BMP_ label (the THMB label is the empty string after it). */
const BMP_LABEL = "Thumbnail";
/** Tile flag 0x20: outside the lot proper (MakeThumbnail's center average skips it). */
const TILE_LOCKED = 0x20;
/** MakeThumbnail's zoom and level. */
const THUMB_ZOOM = 1;
const THUMB_LEVEL = 2;
/** lbl_105BBFF8 [7]: ScaleBitmap leaves a pixel transparent below this much opaque weight. */
const MIN_OPAQUE_WEIGHT = 0.46875;

/** What the lot view hands over: its viewer and the parts SaveThumbnail switches to daytime. */
export interface ThumbnailScene {
  viewer: HouseViewer;
  walls: WallManager | null;
  lighting: RoomLighting | null;
  terrain: Terrain | null;
  /** cSimulator global 10 (the lot's house number), read by cTerrain::SetColor. */
  houseNumber: number;
}

/** A 16-bit image in the display format (565 or 555). */
interface Image16 {
  w: number;
  h: number;
  px: Uint16Array;
}

/** ThumbnailInfo (THMB): x, y, z, dx, dy. */
interface ThumbnailInfo {
  x: number;
  y: number;
  z: number;
}

/** ScaleBitmap's choice by App+0x34: the 565 converters for format 2, the 555 ones otherwise. */
function is565(): boolean {
  return getDisplayFormat() === 2;
}

/** CvtRGBto565 / CvtRGBto555. */
function cvtRGBto16(r: number, g: number, b: number): number {
  return is565() ? ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3) : ((r & 0xf8) << 7) | ((g & 0xf8) << 2) | (b >> 3);
}

/** Cvt565toRGB / Cvt555toRGB: 8-bit channels with zero low bits. */
function cvt16toRGB(p: number): [number, number, number] {
  return is565() ? [((p >> 11) & 0x1f) << 3, ((p >> 5) & 0x3f) << 2, (p & 0x1f) << 3] : [((p >> 10) & 0x1f) << 3, ((p >> 5) & 0x1f) << 3, (p & 0x1f) << 3];
}

/** lbl_105BA258: the transparent color (magenta) in the buffers' format. */
function transparent16(): number {
  return cvtRGBto16(0xf8, 0, 0xf8);
}

/**
 * MakeThumbnail's render: zoom 1, rotation 0, level 2, walls up, daytime, no
 * grid, offsets (offX, offY) clamped for a bufW x bufH view, into a 555
 * buffer cleared to the transparent color. Returns the buffer and the
 * ThumbnailInfo for scale `f`.
 */
function renderLot(scene: ThumbnailScene, f: number, bufW: number, bufH: number, offX: number, offY: number, roof: boolean): { img: Image16; info: ThumbnailInfo } {
  const { viewer: v, walls, lighting, terrain, houseNumber } = scene;
  const world = v.world;
  const fixed = world.fixed;
  // The average tile of the lot (x / y rounded with + 0.5, as chars).
  let sx = 0;
  let sy = 0;
  let n = 0;
  const flags = fixed.flags[0]!;
  for (let y = 0; y < fixed.size; y++) {
    for (let x = 0; x < fixed.size; x++) {
      if ((flags.u8(x, y) & TILE_LOCKED) !== 0) continue;
      sx += x;
      sy += y;
      n++;
    }
  }
  if (n === 0) n = 1;
  const cx = Math.trunc(0.5 + sx / n);
  const cy = Math.trunc(0.5 + sy / n);

  const saved = {
    scale: v.scale,
    rotation: world.rotation,
    level: v.level,
    originX: v.originX,
    originY: v.originY,
    cutaway: v.cutaway,
    drawRoof: v.drawRoof,
    wallsRoof: walls?.drawRoof ?? false,
    wallsCutaway: walls?.cutaway ?? false,
    wallsDynamic: walls?.dynamicCutaway ?? false,
    people: v.people,
    cursor: v.cursor,
    phase: lighting?.phase ?? 0,
    overlay: terrain?.overlayVisible ?? false,
    quality: terrain?.getQuality() ?? 2,
  };
  const img: Image16 = { w: bufW, h: bufH, px: new Uint16Array(bufW * bufH) };
  let info: ThumbnailInfo;
  try {
    // cSimulator +0x18 = 0, cTerrain::SetColor, AllRoomsLightingChanged; SetTerrainDetail(2).
    if (lighting && lighting.phase !== 0) lighting.compute(0);
    terrain?.setColor(houseNumber, 0);
    terrain?.setLatitudeByTimeOfDay(0);
    if (terrain && saved.quality !== 2) terrain.setQuality(2);
    terrain?.showOverlay(false);
    v.people = null;
    v.cursor = null;
    // SetScale, SetRotation, the level, cutaway (+0x48) and dynamic cutaway (+0x49) off.
    v.setScale(THUMB_ZOOM);
    v.setRotation(0);
    v.setLevel(THUMB_LEVEL);
    v.cutaway = false;
    if (walls) {
      walls.cutaway = false;
      walls.dynamicCutaway = false;
    }
    // The roof pass sets +0x51.
    if (roof) {
      v.drawRoof = true;
      if (walls) walls.drawRoof = true;
    }
    // SetOffsets with the buffer as the view rect.
    const m = v.getOffsetsMinMax(bufW, bufH);
    const ox = (Math.min(Math.max(offX, m.minX), m.maxX) + 1) & ~3;
    const oy = Math.min(Math.max(offY, m.minY), m.maxY);
    const shift = f === 0.5 ? 1 : f === 0.25 ? 2 : f === 0.125 ? 3 : 0;
    info = {
      x: (ox + (8 << THUMB_ZOOM) * (cx - cy)) >> shift,
      y: (oy + (4 << THUMB_ZOOM) * (cx + cy)) >> shift,
      z: m.low >> shift,
    };
    // UpdateStaticLayer + RenderDynamicObjects in pieces of the viewer's target.
    v.thumbnailClearColor = 0xf800f8;
    const comp = v.comp;
    const gl = comp.gl;
    const tw = comp.width;
    const th = comp.height;
    const rgba = new Uint8Array(tw * th * 4);
    for (let ty = 0; ty < bufH; ty += th) {
      for (let tx = 0; tx < bufW; tx += tw) {
        v.originX = ox - tx;
        v.originY = oy - ty;
        v.render();
        gl.readPixels(0, 0, tw, th, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
        const cw = Math.min(tw, bufW - tx);
        const ch = Math.min(th, bufH - ty);
        for (let y = 0; y < ch; y++) {
          const src = (th - 1 - y) * tw * 4;
          const dst = (ty + y) * bufW + tx;
          for (let x = 0; x < cw; x++) {
            const s = src + x * 4;
            img.px[dst + x] = cvtRGBto16(rgba[s]!, rgba[s + 1]!, rgba[s + 2]!);
          }
        }
      }
    }
  } finally {
    v.thumbnailClearColor = null;
    v.people = saved.people;
    v.cursor = saved.cursor;
    if (walls) {
      walls.cutaway = saved.wallsCutaway;
      walls.dynamicCutaway = saved.wallsDynamic;
      walls.drawRoof = saved.wallsRoof;
    }
    v.cutaway = saved.cutaway;
    v.drawRoof = saved.drawRoof;
    v.setLevel(saved.level);
    v.setRotation(saved.rotation);
    v.setScale(saved.scale);
    v.originX = saved.originX;
    v.originY = saved.originY;
    if (lighting && lighting.phase !== saved.phase) lighting.compute(saved.phase);
    terrain?.setColor(houseNumber, saved.phase);
    terrain?.setLatitudeByTimeOfDay(saved.phase);
    if (terrain && saved.quality !== 2) terrain.setQuality(saved.quality);
    terrain?.showOverlay(saved.overlay);
    v.dirty = true;
  }
  return { img, info };
}

/**
 * One axis of ScaleBitmap(float, float, cTSBuffer *, cTSRect *, bool): the
 * contributors of each destination pixel. A cubic kernel
 * 2|t|^3 - 3|t|^2 + 1 over |t| < 1, stretched by 1 / scale when shrinking,
 * centered on dst / scale, mirrored at the edges, normalized.
 */
function contributors(srcLen: number, dstLen: number): Array<Array<[index: number, weight: number]>> {
  const scale = Math.fround(dstLen / srcLen);
  const support = scale < 1 ? Math.fround(1 / scale) : 1;
  const inv = Math.fround(1 / support);
  const out: Array<Array<[number, number]>> = [];
  for (let i = 0; i < dstLen; i++) {
    const center = Math.fround(i / scale);
    const lo = Math.ceil(center - support);
    const hi = Math.floor(center + support);
    const list: Array<[number, number]> = [];
    let sum = 0;
    for (let j = lo; j <= hi; j++) {
      let t = Math.fround((center - j) * inv);
      if (t < 0) t = -t;
      const k = t >= 1 ? 0 : Math.fround(t * (2 * t - 3) * t + 1);
      const wgt = Math.fround(inv * k);
      sum += wgt;
      let s = j;
      for (;;) {
        while (s < 0) s = -s;
        if (s < srcLen) break;
        s = srcLen * 2 - s - 2;
      }
      list.push([s, wgt]);
    }
    if (sum > 1e-12) for (const c of list) c[1] = Math.fround(c[1] / sum);
    out.push(list);
  }
  return out;
}

/** One ScaleBitmap pass along x (`horizontal`) or y; transparent pixels carry no weight. */
function scalePass(src: Image16, dw: number, dh: number, horizontal: boolean): Image16 {
  const dst: Image16 = { w: dw, h: dh, px: new Uint16Array(dw * dh) };
  const transparent = transparent16();
  const cs = horizontal ? contributors(src.w, dw) : contributors(src.h, dh);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const list = horizontal ? cs[x]! : cs[y]!;
      let wsum = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (const [s, wgt] of list) {
        const p = horizontal ? src.px[y * src.w + s]! : src.px[s * src.w + x]!;
        if (p === transparent) continue;
        const [pr, pg, pb] = cvt16toRGB(p);
        wsum += wgt;
        r += pr * wgt;
        g += pg * wgt;
        b += pb * wgt;
      }
      if (wsum >= MIN_OPAQUE_WEIGHT) {
        const k = 1 / wsum;
        dst.px[y * dw + x] = cvtRGBto16(Math.trunc(0.5 + r * k), Math.trunc(0.5 + g * k), Math.trunc(0.5 + b * k));
      } else {
        dst.px[y * dw + x] = transparent;
      }
    }
  }
  return dst;
}

/** ScaleBitmap(f, buffer, null, false): x then y, each to ceil(size * f). */
function scaleBitmap(src: Image16, f: number): Image16 {
  const dw = Math.ceil(Math.fround(src.w * f));
  const dh = Math.ceil(Math.fround(src.h * f));
  return scalePass(scalePass(src, dw, src.h, true), dw, dh, false);
}

/** ShrinkWrap: the transparent margins { left, top, right, bottom }. */
function shrinkWrap(img: Image16): { left: number; top: number; right: number; bottom: number } {
  const { w, h, px } = img;
  const clear = transparent16();
  const rowEmpty = (y: number): boolean => {
    for (let x = 0; x < w; x++) if (px[y * w + x] !== clear) return false;
    return true;
  };
  let top = 0;
  while (top < h && rowEmpty(top)) top++;
  let bottom = 0;
  while (bottom < h - top && rowEmpty(h - 1 - bottom)) bottom++;
  const colEmpty = (x: number): boolean => {
    for (let y = top; y < h - bottom; y++) if (px[y * w + x] !== clear) return false;
    return true;
  };
  let left = 0;
  while (left < w && colEmpty(left)) left++;
  let right = 0;
  while (right < w - left && colEmpty(w - 1 - right)) right++;
  return { left, top, right, bottom };
}

/**
 * MakeMemoryBMP(bits + crop origin, stride, w, h, 24-bit, true): the cropped
 * image as a BMP, a 565 pixel read as 555 after >> 1 (blue from the unshifted
 * pixel).
 */
function makeMemoryBmp(img: Image16, x0: number, y0: number, w: number, h: number): Uint8Array {
  const rgba = new Uint8ClampedArray(Math.max(0, w * h * 4));
  const from565 = is565();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = img.px[(y0 + y) * img.w + x0 + x]!;
      const q = from565 ? p >> 1 : p;
      const r = ((q >> 10) & 0x1f) << 3;
      const g = ((q >> 5) & 0x1f) << 3;
      const b = (p & 0x1f) << 3;
      const d = (y * w + x) * 4;
      rgba[d] = r;
      rgba[d + 1] = g;
      rgba[d + 2] = b;
      rgba[d + 3] = 255;
    }
  }
  return encodeBmp(rgba, w, h, 24);
}

/** ThumbnailInfo::Swizzle: five little-endian ints. */
function thmbBytes(v: readonly number[]): Uint8Array {
  const out = new Uint8Array(20);
  const dv = new DataView(out.buffer);
  v.forEach((x, i) => dv.setInt32(i * 4, x, true));
  return out;
}

/**
 * HouseViewer::SaveThumbnail(file, id) (f = 0.25, `half` false) or
 * SaveUnleashedThumbnail(file, id) (f = 0.125, size halved): the THMB and
 * the two BMP_s, in the order they sit in the game's files.
 */
function saveThumbnail(scene: ThumbnailScene, id: number, f: number, half: boolean): IffChunk[] {
  const v = scene.viewer;
  const m = v.getOffsetsMinMax();
  const s = v.scale;
  let w = (m.maxX - m.minX + v.viewW) >> (s + 1);
  let h = (m.maxY - m.minY + v.viewH) >> (s + 1);
  if (half) {
    w = Math.trunc(w / 2);
    h = Math.trunc(h / 2);
  }
  const div = 1 << (s - 1);
  const offX = Math.trunc(m.maxX / div);
  const offY = Math.trunc(m.maxY / div);
  const bufW = Math.trunc(0.5 + w / f);
  const bufH = Math.trunc(0.5 + h / f);
  // Pass 0: the lot; pass 1: the lot with +0x51 set (the roof; the port renders the whole
  // view again where the original adds the roof polygons to pass 0's buffer).
  const bmps: IffChunk[] = [];
  const thmb = [0, 0, 0, 0, 0];
  let first = { left: 0, top: 0 };
  for (let pass = 0; pass < 2; pass++) {
    const { img, info } = renderLot(scene, f, bufW, bufH, offX, offY, pass === 1);
    const scaled = scaleBitmap(img, f);
    const r = shrinkWrap(scaled);
    if (pass === 0) {
      first = r;
      thmb[0] = info.x - r.left;
      thmb[1] = info.y - r.top;
      thmb[2] = info.z;
    } else {
      thmb[3] = r.left - first.left;
      thmb[4] = r.top - first.top;
    }
    bmps.push({ type: "BMP_", id: id + pass, flags: 0, label: BMP_LABEL, data: makeMemoryBmp(scaled, r.left, r.top, w - r.left - r.right, h - r.top - r.bottom) });
  }
  return [{ type: "THMB", id, flags: 0, label: "", data: thmbBytes(thmb) }, bmps[1]!, bmps[0]!];
}

/** What saveHouseThumbnails needs loaded first: the roof texture of the roof pass. */
export async function prepareHouseThumbnails(viewer: HouseViewer): Promise<void> {
  await viewer.prepareRoof();
}

/**
 * GlobalDispatch(0x92)'s thumbnails: SaveThumbnail(0x200), then
 * SaveUnleashedThumbnail(0x400). Call prepareHouseThumbnails first.
 */
export function saveHouseThumbnails(scene: ThumbnailScene): IffChunk[] {
  return [...saveThumbnail(scene, 0x200, SCALE_THUMBNAIL, false), ...saveThumbnail(scene, 0x400, SCALE_UNLEASHED, true)];
}

/** The thumbnail chunks a house file holds (replaced as a whole). */
const THUMB_KEYS = new Set(["THMB:512", "BMP_:512", "BMP_:513", "THMB:1024", "BMP_:1024", "BMP_:1025"]);

/**
 * Neighborhood::MoveOut saves the lot through the same House::SaveFile, the
 * game's single HouseViewer (hidden behind the neighborhood screen) holding
 * the lot LoadHouse loaded, at the zoom HouseViewer::DoStream read from
 * HOUS 0. The port's MoveOut has no view: this opens one on the saved file
 * (the state SaveFile streamed), as WinLotView::init does without the
 * simulator and the people, renders the thumbnails and puts them in place of
 * the file's (after HOUS 0). The view is `viewW` x `viewH` like the lot view's.
 */
export async function withHouseThumbnails(name: string, bytes: Uint8Array, viewW: number, viewH: number): Promise<Uint8Array> {
  const wasm = await engine();
  const house = new ResFile(name, bytes, wasm.parseIffChunks(bytes) as ResFile["chunks"]);
  const world = new RotatableWorld(FixedWorld.load(house, readLotSize(house)));
  const floors = new FloorGraphicsMgr();
  await floors.initialize();
  await floors.loadUsageMap(house, world.fixed);
  const comp = new Compositor(viewW, viewH);
  try {
    const v = new HouseViewer(world, comp, floors, viewW, viewH);
    const terrain = Terrain.create();
    terrain.terrainZ = (x, y) => Math.min(0xffff, Math.max(0, v.getTerrainZ(x, y)));
    v.terrain = terrain;
    const walls = await WallManager.create(house, world);
    walls.setWallState(WallState.Up);
    v.walls = walls;
    const lot = await loadLotObjectDrawer(house, world.fixed);
    v.objects = lot.drawer;
    lot.drawer.cutawayView = walls;
    walls.customWallStyle = customWallStyleOf(lot, world.fixed);
    // HouseViewer::DoStream's roof settings; DiscoverTilesToRoof's stairs test (in ComputeRooms) reads the objects.
    loadRoofSettings(house);
    roofLayersOf(world.fixed).objects = () => lot.objects;
    const rooms = new RoomManager(world.fixed);
    computeRooms(world.fixed, rooms);
    rooms.computeCutaway(v, 0);
    const lighting = new RoomLighting(rooms, world, () => lot.objects);
    lighting.compute(0);
    v.lighting = lighting;
    // HouseViewer::DoStream: the saved zoom (HOUS 0 +0x10).
    const hous = house.get("HOUS", 0);
    const zoom = hous && hous.length >= 20 ? new DataView(hous.buffer, hous.byteOffset, hous.byteLength).getInt32(16, true) : 3;
    v.scale = zoom >= 1 && zoom <= 3 ? zoom : 3;
    await prepareHouseThumbnails(v);
    const thumbs = saveHouseThumbnails({ viewer: v, walls, lighting, terrain, houseNumber: houseNumberOfPath(name) });
    const chunks = parseIff(bytes).filter((c) => !THUMB_KEYS.has(`${c.type}:${c.id}`));
    const at = chunks.findIndex((c) => c.type === "HOUS" && c.id === 0);
    chunks.splice(at < 0 ? chunks.length : at + 1, 0, ...thumbs);
    return buildIff(chunks);
  } finally {
    comp.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
