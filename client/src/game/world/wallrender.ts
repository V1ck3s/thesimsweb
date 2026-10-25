/**
 * The cRenderer entry points walls draw with, and their blitters:
 *  - DrawWall -> WallBlit: a wall style sprite (mask: pixels != 0xff) colored
 *    by a wall pattern sprite of the same frame, both read from their top-left
 *    corner. Depth per pixel = rp depth + vertical[rp row - y + (8 << s)] +
 *    column term: the ortho wall lookup from index (16 << s) + column offset
 *    for segments 0x01 / 0x02 (offset 8 << s for 0x02), zeros for the
 *    diagonals, and -300 more for segment 0x20. Test `newZ <= zbuf + 1`.
 *  - DrawThickWallPiece -> FloorBlit: a tile-sized wall top piece (sprite
 *    0x1000 + s - 1) at depth GetTerrainZ(tile) + level * (levelZ + 0x41) +
 *    floor[0] - floor[4 << s] + extra, then down the floor table row by row.
 *  - DrawThickWallCutawayPiece -> CutawayWallThickBlit: the cut wall top
 *    (colors 0x1400 + s - 1, zones 0x1800 + s - 1): each pixel's zone byte
 *    (lbl_105BBED0) picks a column lookup and a depth offset.
 *
 * Lighting is not ported: the lit variants (LitWallBlit, LitWallAddBlit,
 * ProcessWallLightEntry) and PalWrap::ChooseBestCLUT's darkened palettes
 * are replaced by the sprite's own palette at full brightness.
 */

import type { Compositor, SpriteTex } from "./compositor.js";
import type { HouseViewer } from "./houseviewer.js";
import type { Renderer } from "./renderer.js";
import type { RenderParam } from "./renderparam.js";
import { PX_COLOR, type SpriteFrame } from "./spr.js";
import { SEG_HORIZ, SEG_VERT } from "./tilewalls.js";

/** Clip rectangle (lbl_105BA5F4) in view pixels. */
export interface ClipRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** lbl_105BBED0: zone byte of the 0x1800 sprites -> column lookup / offset index. */
const ZONE = (() => {
  const t = new Uint8Array(256);
  const runs: ReadonlyArray<readonly [number, number]> = [
    [7, 63],
    [6, 26],
    [5, 25],
    [4, 26],
    [3, 25],
    [2, 26],
    [1, 25],
    [0, 39],
    [255, 1],
  ];
  let i = 0;
  for (const [v, n] of runs) for (let k = 0; k < n; k++) t[i++] = v;
  return t;
})();

function newFrame(width: number, height: number, paletteId: number): SpriteFrame {
  const n = width * height;
  return {
    width,
    height,
    yLoc: 0,
    xLoc: 0,
    index: new Uint8Array(n).fill(0xff),
    z: new Uint8Array(n),
    alpha: new Uint8Array(n),
    mode: new Uint8Array(n),
    paletteId,
    transparentIndex: -1,
  };
}

export class WallBlitter {
  private readonly textures = new Map<string, SpriteTex | null>();
  private readonly rendererIds = new Map<Renderer, number>();

  constructor(
    readonly comp: Compositor,
    /** WallGraphicsMgr::GetGlobalRenderer. */
    readonly global: Renderer,
  ) {}

  private rid(r: Renderer): number {
    let id = this.rendererIds.get(r);
    if (id === undefined) {
      id = this.rendererIds.size;
      this.rendererIds.set(r, id);
    }
    return id;
  }

  private cached(key: string, make: () => SpriteFrame | null, palette: () => Uint8Array): SpriteTex | null {
    let t = this.textures.get(key);
    if (t !== undefined) return t;
    const f = make();
    t = f && f.width > 0 && f.height > 0 ? this.comp.uploadSprite(f, palette()) : null;
    this.textures.set(key, t);
    return t;
  }

  /** Table indexes of the vertical, ortho wall and zero lookups for a scale. */
  private tables(viewer: HouseViewer, s: number): { vert: number; ortho: number; zero: number } {
    const zb = viewer.zbuf;
    return {
      vert: this.comp.table1D(`vert${s}`, zb.vertical.get(s)!),
      ortho: this.comp.table1D(`orthowall${s}`, zb.orthoWall.get(s)!),
      // ZBufferLookup+0x38: 0x200 bytes of zeros (diagonal walls).
      zero: this.comp.table1D("wallzero", new Float32Array(256)),
    };
  }

  private withClip(clip: ClipRect, draw: () => void): void {
    if (clip.right <= clip.left || clip.bottom <= clip.top) return;
    this.comp.setClip(clip);
    draw();
    this.comp.setClip(null);
  }

  /**
   * cRenderer::DrawWall (WallBlit path): style sprite (styleR/styleId, global
   * when null) masks pattern sprite (patR/patId) frame `frame`, top-left at (x, y).
   */
  drawWall(
    viewer: HouseViewer,
    rp: RenderParam,
    clip: ClipRect,
    styleR: Renderer | null,
    styleId: number,
    patR: Renderer | null,
    patId: number,
    frame: number,
    x: number,
    y: number,
    colOffset: number,
    seg: number,
  ): void {
    const sr = styleR ?? this.global;
    const pr = patR ?? this.global;
    const sl = sr.getListInfo(styleId);
    const pl = pr.getListInfo(patId);
    if (!sl || !pl) return;
    const key = `w${this.rid(sr)}:${styleId}:${this.rid(pr)}:${patId}:${frame}`;
    let palId = 0;
    const tex = this.cached(
      key,
      () => {
        const sf = sl.frame(frame);
        const pf = pl.frame(frame);
        if (!sf || !pf) return null;
        palId = pf.paletteId;
        const f = newFrame(sf.width, sf.height, pf.paletteId);
        for (let j = 0; j < sf.height; j++) {
          for (let i = 0; i < sf.width; i++) {
            const o = j * sf.width + i;
            if (sf.index[o] === 0xff) continue;
            f.mode[o] = PX_COLOR;
            f.index[o] = i < pf.width && j < pf.height ? pf.index[j * pf.width + i]! : 0xff;
          }
        }
        return f;
      },
      () => pr.palette(palId),
    );
    if (!tex) return;
    const s = viewer.scale;
    const t = this.tables(viewer, s);
    const diag = seg === SEG_HORIZ || seg === SEG_VERT;
    const col = diag ? t.zero : t.ortho + (16 << s) + colOffset;
    const extra = seg === SEG_VERT ? -300 : 0;
    this.withClip(clip, () => this.comp.drawWallSprite(tex, x, y, rp.depth + extra - 1, t.vert + rp.depthRow + (8 << s), [col], [0]));
  }

  /** cRenderer::DrawThickWallPiece (FloorBlit) of the global renderer's list `id`. */
  drawThickWallPiece(viewer: HouseViewer, rp: RenderParam, clip: ClipRect, tile: { x: number; y: number }, id: number, frame: number, x: number, y: number, extra: number): void {
    const r = this.global;
    const l = r.getListInfo(id);
    if (!l) return;
    let palId = 0;
    const tex = this.cached(
      `p${id}:${frame}`,
      () => {
        const sf = l.frame(frame);
        if (!sf) return null;
        palId = sf.paletteId;
        const f = newFrame(sf.width, sf.height, sf.paletteId);
        for (let o = 0; o < sf.index.length; o++) {
          if (sf.index[o] === 0xff) continue;
          f.mode[o] = PX_COLOR;
          f.index[o] = sf.index[o]!;
        }
        return f;
      },
      () => r.palette(palId),
    );
    if (!tex) return;
    const s = viewer.scale;
    const zb = viewer.zbuf;
    const oy = viewer.originY;
    let base = extra + viewer.getTerrainZ(tile.x, tile.y) + rp.level * (zb.levelZ.get(s)! + 0x41);
    base += zb.floorAt(s, 0, oy) - zb.floorAt(s, 4 << s, oy);
    if (base > 0xffff) base = 0xffff;
    this.withClip(clip, () => this.comp.drawFloorSprite(tex, x, y, false, base - zb.floorAt(s, y, oy), viewer.floorRowIndex(y)));
  }

  /** cRenderer::DrawThickWallCutawayPiece (CutawayWallThickBlit): colors `colorId`, zones `zoneId`. */
  drawThickWallCutawayPiece(viewer: HouseViewer, rp: RenderParam, clip: ClipRect, colorId: number, zoneId: number, frame: number, x: number, y: number): void {
    const r = this.global;
    const zl = r.getListInfo(zoneId);
    const cl = r.getListInfo(colorId);
    if (!zl || !cl) return;
    let palId = 0;
    const tex = this.cached(
      `c${colorId}:${zoneId}:${frame}`,
      () => {
        const zf = zl.frame(frame);
        const cf = cl.frame(frame);
        if (!zf || !cf) return null;
        palId = cf.paletteId;
        const f = newFrame(zf.width, zf.height, cf.paletteId);
        for (let j = 0; j < zf.height; j++) {
          for (let i = 0; i < zf.width; i++) {
            const o = j * zf.width + i;
            const zone = zf.index[o]!;
            if (zone === 0xff) continue;
            f.mode[o] = PX_COLOR;
            f.z[o] = ZONE[zone]!;
            f.index[o] = i < cf.width && j < cf.height ? cf.index[j * cf.width + i]! : 0xff;
          }
        }
        return f;
      },
      () => r.palette(palId),
    );
    if (!tex) return;
    const s = viewer.scale;
    const t = this.tables(viewer, s);
    const u = 8 << s;
    const l0 = t.ortho + (16 << s);
    const max = viewer.zbuf.orthoWallMax.get(s)!;
    const half = Math.trunc(max / 2);
    const cols = [l0 - u, l0 - u - 1, l0, l0, t.zero, t.zero, t.zero, t.zero];
    const offs = [max, max, 0, 0, half, max, half, max];
    this.withClip(clip, () => this.comp.drawWallSprite(tex, x, y, rp.depth - 1, t.vert + rp.depthRow + (8 << s), cols, offs));
  }
}
