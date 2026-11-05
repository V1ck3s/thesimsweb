/**
 * The wall blitters of the iconic mode (WallManager::DrawIconic): the same
 * cRenderer entry points as world/wallrender.ts, drawn straight into a 2D
 * RGBA buffer instead of the house view's compositor.
 *
 * SetupDrawIconic points the renderer's color and z surfaces at the target
 * buffer, and Wall::Draw / Vertex::Draw set RenderParam state (3, 1)
 * (iconic: depths from the RenderParam instead of the world's terrain). The
 * iconic wall is one uncut segment between two vertices drawn in that
 * order, so the z test never rejects a pixel here and is not kept: every
 * opaque pixel is written.
 *  - DrawWall (WallBlit): the style sprite's opaque pixels (index != 0xff)
 *    take the pattern sprite's pixel of the same frame, both read from their
 *    top-left corner at (x, y);
 *  - DrawThickWallPiece (FloorBlit): the wall top piece's opaque pixels.
 * Wall::Draw's iconic ambient is lbl_105BC690 (1.0); Vertex::Draw's is the
 * ambient of RoomManager::GetRoom(0), taken as full light (no room). At full
 * light PalWrap::ChooseBestCLUT is the sprite's own palette.
 */

import type { Renderer } from "./renderer.js";
import type { ClipRect } from "./wallrender.js";

/** The target of an iconic draw: a 2D RGBA buffer, its origin at (ox, oy). */
export class IconicWallBlitter {
  constructor(
    readonly target: ImageData,
    /** WallGraphicsMgr::GetGlobalRenderer (GameData/walls.iff). */
    readonly global: Renderer,
    /** Buffer position of the draw coordinates' (0, 0) (SetupDrawIconic's rectangle origin). */
    readonly ox = 0,
    readonly oy = 0,
  ) {}

  private put(clip: ClipRect, x: number, y: number, pal: Uint8Array, index: number): void {
    if (x < clip.left || x >= clip.right || y < clip.top || y >= clip.bottom) return;
    const bx = this.ox + x;
    const by = this.oy + y;
    const t = this.target;
    if (bx < 0 || by < 0 || bx >= t.width || by >= t.height) return;
    const q = (by * t.width + bx) * 4;
    const c = index * 3;
    t.data[q] = pal[c] ?? 0;
    t.data[q + 1] = pal[c + 1] ?? 0;
    t.data[q + 2] = pal[c + 2] ?? 0;
    t.data[q + 3] = 255;
  }

  /** cRenderer::DrawWall (WallBlit): style list `styleId` (global renderer when null) masks pattern list `patId`, frame `frame`, top-left at (x, y). */
  drawWall(clip: ClipRect, styleR: Renderer | null, styleId: number, patR: Renderer | null, patId: number, frame: number, x: number, y: number): void {
    const sr = styleR ?? this.global;
    const pr = patR ?? this.global;
    const sf = sr.getListInfo(styleId)?.frame(frame);
    const pf = pr.getListInfo(patId)?.frame(frame);
    if (!sf || !pf) return;
    const pal = pr.palette(pf.paletteId);
    for (let j = 0; j < sf.height; j++) {
      for (let i = 0; i < sf.width; i++) {
        if (sf.index[j * sf.width + i] === 0xff) continue;
        const index = i < pf.width && j < pf.height ? pf.index[j * pf.width + i]! : 0xff;
        this.put(clip, x + i, y + j, pal, index);
      }
    }
  }

  /** cRenderer::DrawThickWallPiece (FloorBlit) of the global renderer's list `id`. */
  drawThickWallPiece(clip: ClipRect, id: number, frame: number, x: number, y: number): void {
    const r = this.global;
    const f = r.getListInfo(id)?.frame(frame);
    if (!f) return;
    const pal = r.palette(f.paletteId);
    for (let j = 0; j < f.height; j++) {
      for (let i = 0; i < f.width; i++) {
        const index = f.index[j * f.width + i]!;
        if (index !== 0xff) this.put(clip, x + i, y + j, pal, index);
      }
    }
  }
}
