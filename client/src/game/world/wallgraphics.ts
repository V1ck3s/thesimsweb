/**
 * WallGraphicsMgr: wall pattern (wallpaper) -> (sprite file, sprite id) per
 * scale, plus the global renderer (GameData/walls.iff) that also holds the
 * wall style masks and the thick wall pieces.
 *
 * WallGraphicsMgr::Initialize registers patterns 0..30 and 0xf8..0xff of
 * walls.iff with sprite ids p + 0x600 / 0x700 / 0x800 for scales 1 / 2 / 3
 * (WallPattNode +4/+8/+0xc), and every plugin .wll file's SPR# i (1..n/3)
 * as ids i, i + 0x700, i + 0x800. A house's WALm chunk (id 1, or id 0 with
 * byte fields for old houses; SpriteFileUsageTemplate) lists per plugin file
 * the house patterns and their sprite index in that file
 * (LoadUsageMapAndUpdate). Patterns the house names but no installed file
 * provides fall back to the registered pattern of nearest color (node
 * +0x1c, parsed from the sprite label "HRRGGBB"), then to pattern 1.
 *
 * The original renumbers plugin patterns into its runtime map and rewrites
 * the walls; mapping the house's numbers directly is equivalent here.
 */

import { openPluginFile } from "./catalog.js";
import { parseUsageMap } from "./floors.js";
import { ResFile } from "./iffres.js";
import { Renderer } from "./renderer.js";

interface WallPattNode {
  renderer: Renderer;
  /** Sprite ids for scales 1, 2, 3. */
  ids: [number, number, number];
  /** +0x1c: RGB << 8 from the sprite label (nearest-color fallback). */
  color: number;
}

/** "HRRGGBB" sprite label -> RGB << 8 (Initialize's hex parse; bad digits count as 0). */
function labelColor(label: string): number {
  if (label.length !== 7) return 0;
  const hex = (c: string): number => {
    const v = parseInt(c, 16);
    return Number.isNaN(v) ? 0 : v;
  };
  const r = hex(label[1]!) * 16 + hex(label[2]!);
  const g = hex(label[3]!) * 16 + hex(label[4]!);
  const b = hex(label[5]!) * 16 + hex(label[6]!);
  return ((r << 24) | (g << 16) | (b << 8)) >>> 0;
}

/** WALm id 0 (byte fields): ReconLoadVector<SpriteFileUsageTemplate<Uc>> then ConvertUsageMap. */
function parseUsageMapBytes(b: Uint8Array): Array<{ file: string; uses: Array<{ pattern: number; index: number; data: number }> }> {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const dec = new TextDecoder("windows-1252");
  let p = 12;
  const n = v.getUint32(p, true);
  p += 4;
  const out: Array<{ file: string; uses: Array<{ pattern: number; index: number; data: number }> }> = [];
  for (let i = 0; i < n && p < b.length; i++) {
    let e = p;
    while (e < b.length && b[e] !== 0) e++;
    const file = dec.decode(b.subarray(p, e));
    p = e + 1;
    p += p & 1;
    const count = v.getUint32(p, true);
    p += 4;
    const uses: Array<{ pattern: number; index: number; data: number }> = [];
    for (let k = 0; k < count; k++) {
      uses.push({ pattern: b[p]!, index: b[p + 1]!, data: v.getUint32(p + 2, true) });
      p += 6;
    }
    out.push({ file, uses });
  }
  return out;
}

export class WallGraphicsMgr {
  private readonly patterns = new Map<number, WallPattNode>();
  /** Plugin 0: GameData/walls.iff (GetGlobalRenderer). */
  global!: Renderer;

  /** WallGraphicsMgr::Initialize (built-in patterns). */
  async initialize(): Promise<void> {
    const res = await ResFile.open("GameData/walls.iff");
    this.global = new Renderer(res);
    for (let p = 0; p < 0x100; p++) {
      if (p === 0x1f) p = 0xf8;
      const label = res.find("SPR#", p + 0x600)?.label ?? "";
      this.patterns.set(p, { renderer: this.global, ids: [p + 0x600, p + 0x700, p + 0x800], color: labelColor(label) });
    }
  }

  /** WallGraphicsMgr::LoadUsageMapAndUpdate for the house's WALm chunk. */
  async loadUsageMap(house: ResFile): Promise<void> {
    const b1 = house.get("WALm", 1);
    const b0 = b1 ? null : house.get("WALm", 0);
    const map = b1 ? parseUsageMap(b1) : b0 ? parseUsageMapBytes(b0) : [];
    for (const f of map) {
      const res = await openPluginFile(f.file);
      const r = res ? new Renderer(res) : null;
      for (const u of f.uses) {
        if (!((u.pattern > 0x1e && u.pattern < 0xf8) || (u.pattern > 0xff && u.pattern < 0xffff))) continue;
        if (r && res!.find("SPR#", u.index)) {
          const label = res!.find("SPR#", u.index)?.label ?? "";
          this.patterns.set(u.pattern, { renderer: r, ids: [u.index, u.index + 0x700, u.index + 0x800], color: labelColor(label) });
          continue;
        }
        this.patterns.set(u.pattern, this.nearest(u.data) ?? this.patterns.get(1)!);
      }
    }
  }

  /** Registered pattern whose color is nearest to `data` (RGB << 8). */
  private nearest(data: number): WallPattNode | null {
    let best: WallPattNode | null = null;
    let bestD = 0xffffffff;
    for (const n of this.patterns.values()) {
      const dr = (n.color >>> 24) - (data >>> 24);
      const dg = ((n.color >>> 16) & 0xff) - ((data >>> 16) & 0xff);
      const db = ((n.color >>> 8) & 0xff) - ((data >>> 8) & 0xff);
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  /** WallGraphicsMgr::GetWallPatternGraphic: null when the pattern is unknown. */
  getWallPatternGraphic(pattern: number, scale: number): { renderer: Renderer; id: number } | null {
    const n = this.patterns.get(pattern);
    return n ? { renderer: n.renderer, id: n.ids[scale - 1]! } : null;
  }
}
