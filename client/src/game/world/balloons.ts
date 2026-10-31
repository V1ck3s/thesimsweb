/**
 * Balloons and headlines: the icons cXObject::TrySetBalloon (primitive 41)
 * puts in an object's first SpriteSlot, drawn over the object by
 * cXObject::DrawSpriteSlot (for a person: over the head, cXPerson::DrawIso).
 *
 * The icons are SPR# lists of GameData/Sprites.iff, the renderer the
 * original keeps in lbl_105BA11C. Each list holds `count` animation frames
 * of 3 zooms, frame f of zoom z at index z + f * 3 (near first). The icon
 * groups (IconGroup, table lbl_105BB894: group -> base SPR#):
 *   0 motives (table lbl_105BB890), 1 balloons (100 thought, 101 scream,
 *   102 conversation, 103 "not" overlay), 2 talk topics (400..),
 *   3 motives (200..), 4 relationship (300 romance, 301 friends),
 *   5 headlines (500 hate, 501 stress, ...), 6 social interactions (600..),
 *   7 an object / person picture, 8 route failures (700..), 9 progress
 *   (800..), 10 magic (900..).
 *
 * DrawSpriteSlot draws nothing at the far zoom (scale 1). At scale s the
 * anchor is (h - (8 << s) / 2, v - z * (2 << s) + (4 << s)) from the
 * registration point's screen position (h, v) (the person's head "Top",
 * SAnimator::PrepReg slot 2); the balloon, the icon frame and the overlay
 * stand on it (top = anchor - height). A picture is centered at
 * (+0x20, -0x24) from it (+0x10, -0x12 at scale 2): the object's speech
 * image (Product::GetSpeechImage: its BMP_ catalog id + 2000 medium /
 * + 4000 large) or the person's (PersonFinder::GetSpeechIcon: character
 * BMP_ 2005 / 2006).
 *
 * The icons are drawn into the world, luminous (RenderParam::SetLuminous),
 * at the registration point's depth brought forward by RenderParam::
 * DepthTweak(lbl_105BA388 = -65) around DrawSpriteSlot (cXPerson::DrawIso),
 * so a wall in front of the head hides them. They use the world's depth
 * test as z-sprites with every pixel at z 0 (the SPR# frames have no z
 * channel). The lot view draws them after the people (HouseViewer.
 * spriteSlots), each rendered frame, so they follow the head.
 *
 * Deviation: when an object has no speech images, Product::RenderSpeechShot
 * is replaced by its catalog icon on the kSpeechMediumBmp / kSpeechLargeBmp
 * template.
 */

import { cheatFlags } from "../cheatflags.js";
import { ObjectIcon } from "../cpanel/buy/objecticon.js";
import type { Compositor, SpriteTex } from "./compositor.js";
import type { GameContext } from "../context.js";
import { personBitmap } from "../cas/personpictures.js";
import { decodeImage } from "../res/bmp.js";
import type { SimModule } from "../sim/simmodule.js";
import type { HouseViewer } from "./houseviewer.js";
import { ResFile } from "./iffres.js";
import type { LotPeople } from "./lotpeople.js";
import type { XObject } from "./objects.js";
import type { ObjSelector } from "./objselector.js";
import { Renderer } from "./renderer.js";
import { RenderParam } from "./renderparam.js";
import type { SpriteSlot } from "./slots.js";
import { PX_NONE, PX_OPAQUE } from "./spr.js";
import { makeZSpriteLookup } from "./zbuffer.js";


/** lbl_105BB894: IconGroup base SPR# per group (-1: none; group 0 uses lbl_105BB890). */
const GROUP_BASE = [-1, 100, 400, 200, 300, 500, 600, -1, 700, 800, 900];
/** lbl_105BB890: group 0 icons 0..18. */
const GROUP0 = [200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 400, 401, 402, 403, 404];

/** IconGroup::GetSpriteID: the SPR# of icon `index` of `group`, 0 when none. */
export function iconSpriteID(group: number, index: number): number {
  const base = GROUP_BASE[group] ?? -1;
  if (base !== -1) return (base + index) << 16 >> 16;
  if (group === 0 && index >= 0 && index < 0x13) return GROUP0[index]!;
  return 0;
}

/** IconGroup::GetBalloonSpriteID: 0 thought, 1 scream, 2 conversation (group 1's first three), else none. */
export function balloonSpriteID(type: number): number {
  return type >= 0 && type <= 2 ? GROUP_BASE[1]! + type : 0;
}

let sprites: Renderer | null = null;
let loading: Promise<void> | null = null;

/** The renderer of GameData/Sprites.iff (loaded once; the lot view waits for it). */
export function loadBalloonSprites(): Promise<void> {
  loading ??= ResFile.open("GameData/Sprites.iff")
    .then((res) => {
      sprites = new Renderer(res);
    })
    .catch(() => undefined);
  return loading;
}

/** cRenderer::CountSprites on the balloon renderer (0 until Sprites.iff is loaded). */
export function balloonSpriteCount(id: number): number {
  return sprites?.countSprites(id) ?? 0;
}

/** A frame of the balloon renderer as a bitmap (palette colors, transparent where no pixel). */
const frameCache = new Map<string, HTMLCanvasElement | null>();
function frameCanvas(id: number, i: number): HTMLCanvasElement | null {
  const key = `${id}:${i}`;
  const hit = frameCache.get(key);
  if (hit !== undefined) return hit;
  const f = sprites?.frame(id, i) ?? null;
  let c: HTMLCanvasElement | null = null;
  if (f && f.width > 0 && f.height > 0) {
    const pal = sprites!.palette(f.paletteId);
    const img = new ImageData(f.width, f.height);
    for (let p = 0; p < f.width * f.height; p++) {
      if (f.mode[p] === PX_NONE) continue;
      const ci = f.index[p]! * 3;
      img.data[p * 4] = pal[ci]!;
      img.data[p * 4 + 1] = pal[ci + 1]!;
      img.data[p * 4 + 2] = pal[ci + 2]!;
      img.data[p * 4 + 3] = 255;
    }
    c = document.createElement("canvas");
    c.width = f.width;
    c.height = f.height;
    c.getContext("2d")!.putImageData(img, 0, 0);
  }
  frameCache.set(key, c);
  return c;
}

/**
 * A compositor texture of a picture: its opaque pixels at sprite z 0 (the
 * z-sprite blit then puts every pixel at the base depth). Kept per
 * compositor and source.
 */
const textures = new WeakMap<Compositor, WeakMap<object, SpriteTex | null>>();
function zeroZTexture(comp: Compositor, src: HTMLCanvasElement | ImageBitmap): SpriteTex | null {
  let m = textures.get(comp);
  if (!m) {
    m = new WeakMap();
    textures.set(comp, m);
  }
  const hit = m.get(src);
  if (hit !== undefined) return hit;
  const w = src.width;
  const h = src.height;
  let tex: SpriteTex | null = null;
  if (w > 0 && h > 0) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const cx = c.getContext("2d", { willReadFrequently: true })!;
    cx.drawImage(src, 0, 0);
    const rgba = cx.getImageData(0, 0, w, h).data;
    const zm = new Uint8Array(w * h * 2);
    for (let p = 0; p < w * h; p++) {
      const on = rgba[p * 4 + 3]! !== 0;
      rgba[p * 4 + 3] = on ? 255 : 0;
      zm[p * 2 + 1] = on ? PX_OPAQUE * 64 : 0;
    }
    const gl = comp.gl;
    const upload = (format: number, internal: number, data: Uint8Array): WebGLTexture => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, gl.UNSIGNED_BYTE, data);
      return t;
    };
    const color = upload(gl.RGBA, gl.RGBA8, new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength));
    const zmode = upload(gl.RG, gl.RG8, zm);
    tex = { width: w, height: h, color, zmode, hasOpaque: true, hasAlpha: false };
  }
  m.set(src, tex);
  return tex;
}

/** cRenderer::DrawShape: a picture standing on (x, y) (GetShapeBounds' bottom) at the slot's depth. */
function blitAt(comp: Compositor, rp: RenderParam, src: HTMLCanvasElement | ImageBitmap, x: number, y: number): void {
  const tex = zeroZTexture(comp, src);
  if (!tex) return;
  const base = rp.depth + rp.zbuf.verticalAt(rp.scale, 8 << rp.scale);
  comp.drawZSprite(tex, x, y, false, base, rp.zLookupIndex);
}

function drawShape(comp: Compositor, rp: RenderParam, id: number, i: number, x: number, y: number): void {
  if (i < 0 || i >= balloonSpriteCount(id)) return;
  const c = frameCanvas(id, i);
  if (c) blitAt(comp, rp, c, x, y - c.height);
}

/** What the lot view needs to place and picture the icons. */
export interface BalloonScene {
  viewer: HouseViewer;
  people: LotPeople;
  module: SimModule;
  /** cXPerson::IsSelected (+0x114 bit 2). */
  isSelected(o: XObject): boolean;
}

export class BalloonPainter {
  /** Speech images by "<kind>:<key>:<scale>" (null: none; undefined: loading). */
  private readonly speech = new Map<string, ImageBitmap | null>();
  constructor(private readonly ctx: GameContext) {}

  /**
   * cXObject::DrawIso / cXPerson::DrawIso's sprite slot pass for every
   * object of the lot with an active slot, into the view's compositor.
   * Persons draw theirs at the head registration when the slot is "always
   * shown" or the person is selected.
   */
  draw(comp: Compositor, scene: BalloonScene): void {
    const v = scene.viewer;
    if (v.scale === 1 || !sprites) return;
    // The view's ZSpriteLookup table (registered by the HouseViewer under this key).
    const zLookup = comp.table1D("zsprite", makeZSpriteLookup());
    const ambient = comp.ambient;
    const light = comp.light;
    // RenderParam::SetLuminous(1): full light.
    comp.ambient = 1;
    comp.light = null;
    for (const so of scene.module.objects) {
      if (!so) continue;
      const o = so.obj;
      if (o.level > v.level || o.fx < 0 || o.fy < 0) continue;
      for (const slot of o.spriteSlots) {
        if (slot.activeTicks === 0) continue;
        const rp = new RenderParam(v, zLookup);
        if (so.isPerson) {
          if (!slot.always && !scene.isSelected(o)) continue;
          // SAnimator::PrepReg(rp, 2): the head's "Top", then RenderLoc::SetWorldCoord.
          const p = scene.people.registrationPoint(o, 1, v.world.rotation, v.world.fixed.getFAlt(o.fx, o.fy));
          if (!p) continue;
          rp.x = p[2] / 0.1875;
          rp.y = p[0] / 0.1875;
          rp.z = Math.fround((p[1] * 2 * Math.sqrt(6)) / 3);
          rp.level = o.level;
          rp.updateScreenCoords();
        } else {
          rp.setGridCoords(o.fx, o.fy, o.level);
        }
        rp.depth += cheatFlags.bubbleTweak;
        this.drawSpriteSlot(comp, rp, slot, scene);
      }
    }
    comp.ambient = ambient;
    comp.light = light;
  }

  /** cXObject::DrawSpriteSlot */
  private drawSpriteSlot(comp: Compositor, rp: RenderParam, slot: SpriteSlot, scene: BalloonScene): void {
    const s = rp.scale;
    const zoom = 3 - s;
    const x = Math.trunc(rp.sx) - ((8 << s) >> 1);
    const y = Math.trunc(rp.sy) - Math.trunc(slot.z * (2 << s)) + (4 << s);
    if (slot.balloon !== 0) drawShape(comp, rp, slot.balloon, zoom, x, y);
    if (slot.spriteId !== -1) {
      if (slot.spriteId !== 0) drawShape(comp, rp, slot.spriteId, zoom + slot.frame * 3, x, y);
    } else if (slot.selector) {
      const img = this.speechImage(slot.selector as ObjSelector, s);
      if (img) {
        const dx = s === 2 ? 0x10 : 0x20;
        const dy = s === 2 ? -0x12 : -0x24;
        blitAt(comp, rp, img, dx - Math.trunc(img.width / 2) + x, dy - Math.trunc(img.height / 2) + y);
      }
    }
    if (slot.overlay !== 0) drawShape(comp, rp, slot.overlay, zoom, x, y);
  }

  /** Product::GetSpeechImage / PersonFinder::GetSpeechIcon at scale 2 (medium) or 3 (large). */
  private speechImage(sel: ObjSelector, scale: number): ImageBitmap | null {
    const key = `${sel.guid}:${scale}`;
    if (this.speech.has(key)) return this.speech.get(key) ?? null;
    this.speech.set(key, null);
    void this.loadSpeechImage(sel, scale)
      .catch(() => null)
      .then((img) => this.speech.set(key, img));
    return null;
  }

  private async loadSpeechImage(sel: ObjSelector, scale: number): Promise<ImageBitmap | null> {
    const keyed = async (bytes: Uint8Array | null | undefined): Promise<ImageBitmap | null> => {
      if (!bytes) return null;
      const img = decodeImage(bytes, "speech.bmp", { colorKey: true });
      return createImageBitmap(new ImageData(img.data, img.width, img.height));
    };
    if (sel.getIsPerson()) {
      // PersonFinder::GetSpeechIcon: BMP_ 2005 (medium) / 2006 (large) of the person's own file
      // (a character file or an NPC of GameData/Objects/People), else rendered.
      return keyed(await personBitmap(sel, scale === 3 ? 2006 : 2005));
    }
    // Product::GenerateSpeechIcons: BMP_ catalog id + 2000 / + 4000 of the object file.
    const id = sel.objd.i16(0x52);
    const own = await keyed(sel.res.get("BMP_", id + (scale === 3 ? 4000 : 2000)));
    if (own) return own;
    // (RenderSpeechShot) the catalog icon on the speech template.
    const template = await this.ctx.res.image(scale === 3 ? 9001 : 9000).catch(() => null);
    const icon = await ObjectIcon.create(sel.res, sel.objdId).catch(() => null);
    if (!template || !icon) return template;
    const c = document.createElement("canvas");
    c.width = template.width;
    c.height = template.height;
    const cx = c.getContext("2d")!;
    cx.drawImage(template, 0, 0);
    const side = Math.min(c.width, c.height) - 8;
    icon.draw(cx, (c.width - side) >> 1, (c.height - side) >> 1, side, side);
    return createImageBitmap(c);
  }
}
