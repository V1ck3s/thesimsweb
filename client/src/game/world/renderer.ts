/**
 * cRenderer + SpriteListInfo: a sprite file (an IFF with SPR#/SPR2 lists and
 * PALT palettes) and its draw entry points. Frames are decoded lazily and
 * uploaded once to the compositor.
 *
 * SpriteListInfo::SpriteListInfo keeps the list version: SPR2 lists are
 * version 1000/1001; SPR# lists of version 501/503 hold pixel shapes in their
 * first half and the matching z shapes in the second half (506 adds fringe
 * and alpha shapes, which this port draws as plain z-sprites).
 */

import type { Compositor, SpriteTex } from "./compositor.js";
import type { ResFile } from "./iffres.js";
import type { RenderParam } from "./renderparam.js";
import {
  combineZSprite,
  decodeSprFrame,
  decodeSpr2Frame,
  parsePalt,
  parseSpr2Header,
  parseSprHeader,
  type SpriteFrame,
  type Spr2Header,
  type SprHeader,
} from "./spr.js";

/** Default palette when a list names none (GlobalCLUT): grayscale ramp. */
const GRAY_PALETTE = (() => {
  const p = new Uint8Array(768);
  for (let i = 0; i < 256; i++) p.fill(i, i * 3, i * 3 + 3);
  return p;
})();

export class SpriteListInfo {
  /** Number of drawable sprites (pairs count once). */
  readonly count: number;
  private readonly frames = new Map<number, SpriteFrame | null>();

  constructor(
    readonly version: number,
    private readonly bytes: Uint8Array,
    private readonly spr2: Spr2Header | null,
    private readonly spr: SprHeader | null,
  ) {
    if (spr2) this.count = spr2.count;
    else if (version === 501 || version === 503) this.count = Math.floor(spr!.count / 2);
    else if (version === 506) this.count = Math.floor(spr!.count / 5);
    else this.count = spr!.count;
  }

  get isSpr2(): boolean {
    return this.spr2 !== null;
  }

  /** SpriteListInfo::GetPixelShape (+ z shape for z-sprite pairs). */
  frame(i: number): SpriteFrame | null {
    let f = this.frames.get(i);
    if (f !== undefined) return f;
    if (this.spr2) {
      f = decodeSpr2Frame(this.bytes, this.spr2, i);
    } else {
      const h = this.spr!;
      const px = decodeSprFrame(this.bytes, h, i);
      if (px && (this.version === 501 || this.version === 503 || this.version === 506)) {
        const zf = decodeSprFrame(this.bytes, h, i + this.count);
        f = zf ? combineZSprite(px, zf) : px;
      } else {
        f = px;
      }
    }
    this.frames.set(i, f);
    return f;
  }
}

export class Renderer {
  private readonly lists = new Map<number, SpriteListInfo | null>();
  private readonly palettes = new Map<number, Uint8Array>();
  private readonly textures = new Map<string, SpriteTex | null>();

  constructor(readonly res: ResFile) {}

  /** cRenderer::GetListInfo: SPR# first, then SPR2. */
  getListInfo(id: number): SpriteListInfo | null {
    let l = this.lists.get(id);
    if (l !== undefined) return l;
    const spr = this.res.get("SPR#", id);
    if (spr) {
      const h = parseSprHeader(spr);
      l = new SpriteListInfo(h.version, spr, null, h);
    } else {
      const spr2 = this.res.get("SPR2", id);
      if (spr2) {
        const h = parseSpr2Header(spr2);
        l = new SpriteListInfo(h.version, spr2, h, null);
      } else {
        l = null;
      }
    }
    this.lists.set(id, l);
    return l;
  }

  /** cRenderer::CountSprites (only lists of version >= 500 count). */
  countSprites(id: number): number {
    const l = this.getListInfo(id);
    return l && l.version > 499 ? l.count : 0;
  }

  /** cRenderer::GetShapeBounds: { width, height } of a frame. */
  getShapeBounds(id: number, i: number): { width: number; height: number } {
    const f = this.getListInfo(id)?.frame(i);
    return f ? { width: f.width, height: f.height } : { width: 0, height: 0 };
  }

  palette(id: number): Uint8Array {
    let p = this.palettes.get(id);
    if (!p) {
      const b = this.res.get("PALT", id);
      p = b ? parsePalt(b) : GRAY_PALETTE;
      this.palettes.set(id, p);
    }
    return p;
  }

  frame(id: number, i: number): SpriteFrame | null {
    return this.getListInfo(id)?.frame(i) ?? null;
  }

  /** Compositor texture of a frame (decoded and uploaded on first use). */
  texture(comp: Compositor, id: number, i: number): SpriteTex | null {
    const key = `${id}:${i}`;
    let t = this.textures.get(key);
    if (t !== undefined) return t;
    const f = this.frame(id, i);
    t = f && f.width > 0 && f.height > 0 ? comp.uploadSprite(f, this.palette(f.paletteId)) : null;
    this.textures.set(key, t);
    return t;
  }

  /**
   * cRenderer::DrawShape for z-sprites (SpriteListInfo::Render / ZSpriteBlit):
   * top-left at (x, y); depth = rp.depth + vertical[8 << scale] + zLookup[z].
   * `flags & 1` mirrors the sprite.
   */
  drawShape(comp: Compositor, rp: RenderParam, id: number, i: number, x: number, y: number, flags: number): void {
    const tex = this.texture(comp, id, i);
    if (!tex) return;
    const zb = rp.zbuf;
    const base = rp.depth + zb.verticalAt(rp.scale, rp.depthRow - rp.depthRow + (8 << rp.scale));
    comp.drawZSprite(tex, x, y, (flags & 1) !== 0, base, rp.zLookupIndex);
  }
}
