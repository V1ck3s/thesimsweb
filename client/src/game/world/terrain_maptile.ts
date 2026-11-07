/**
 * cMapTileSwatch (cTerrain +0x14): the map overlay the "map_edit on" cheat
 * shows over the ground (HouseViewer::RenderStaticRow calls
 * cTerrain::DrawMapOverlay on every ground tile while lbl_105BA68C is set;
 * DrawMapOverlay is cTerrain::Draw with this swatch in place of the grass and
 * no grid overlay).
 *
 * Draw (Mac asm, MapTileSwatch.s): columns 4 pixels apart across the tile,
 * from the left corner to the middle, then from the right corner back to the
 * middle. Each column starts with 4 black pixels (a dashed outline), then
 * every 4th row (rows 2, 6, 10... of the column) gets a pink pixel (0xff8080)
 * at its x and, 2 pixels to the right, a white one when the tile's flags have
 * 0x20 (not editable) or a black one when they do not. The column heights and
 * steps use the altitudes unscaled (as the original does: the pattern is laid
 * for zoom 1). DrawClipped is the same pattern cut to the clip rectangle.
 */

import { getColor16FromRGB, rgbaFrom16, TerrainRenderer, type PackedAlt, type RenderParam, type TerrainTarget } from "./terrain_renderer.js";
import type { RotatableWorld } from "./world.js";

export class MapTileSwatch extends TerrainRenderer {
  /** +4 pink, +6 black, +8 white (Init). */
  private pink = 0;
  private black = 0;
  private white = 0;
  /** +0x14: the tile's flags & 0x20 (Predraw). */
  private flag = 0;

  /** cMapTileSwatch::Init */
  override init(): boolean {
    this.pink = getColor16FromRGB(0xff8080);
    this.black = getColor16FromRGB(0);
    this.white = getColor16FromRGB(0xffffff);
    return true;
  }

  /** cMapTileSwatch::Predraw */
  override predraw(_rp: RenderParam, world: RotatableWorld, x: number, y: number, _alt: PackedAlt): void {
    this.flag = world.getFlags(x, y, 1) & 0x20;
  }

  override draw(t: TerrainTarget, px: number, py: number, alt: PackedAlt, scale: number): void {
    this.columns(t, px, py, alt, scale, false);
  }

  override drawClipped(t: TerrainTarget, px: number, py: number, alt: PackedAlt, scale: number): void {
    this.columns(t, px, py, alt, scale, true);
  }

  private columns(t: TerrainTarget, px: number, py: number, alt: PackedAlt, scale: number, clipped: boolean): void {
    const [a0, a1, a2, a3] = [alt[0]!, alt[1]!, alt[2]!, alt[3]!];
    const pink = rgbaFrom16(this.pink);
    const black = rgbaFrom16(this.black);
    const mark = rgbaFrom16(this.flag !== 0 ? this.white : this.black);
    const put = (x: number, y: number, c: number): void => {
      if (clipped && (x < t.clip.left || t.clip.right <= x || y < t.clip.top || t.clip.bottom <= y)) return;
      if (x < 0 || y < 0 || x >= t.width || y >= t.height) return;
      t.color[y * t.width + x] = c;
      if (t.color2) t.color2[y * t.width + x] = c;
    };
    const column = (x: number, y: number, count: number): void => {
      let row = 0;
      let n = count;
      if (n > 0) {
        for (let k = 0; k < 4; k++) put(x + k, y, black);
        n--;
        row = 1;
        y++;
      }
      for (; n > 0; n--, row++, y++) {
        if ((row & 3) !== 2) continue;
        put(x, y, pink);
        put(x + 2, y, mark);
      }
    };
    const half = 8 << scale;
    const s1 = scale + 1;
    const grow = a1 - a3 + 4;
    let y = py - (a0 << s1);
    let count = a0 - a3 + 2;
    for (let i = 0; i < half; i += 4) {
      column(px + i, y, count);
      y -= a1 - a0 + 2;
      count += grow;
    }
    y = py - (a2 << s1);
    count = a2 - a3 + 2;
    for (let i = (16 << scale) - 4; i >= half; i -= 4) {
      column(px + i, y, count);
      y -= a1 - a2 + 2;
      count += grow;
    }
  }
}
