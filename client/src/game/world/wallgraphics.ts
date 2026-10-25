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
 * Prices come from GameData/Build.iff STR# 0x83 entry (p - 1) * 3 + 1
 * (plugins: their STR# 0 entry 2, default STR# 0x87 entry 1). Plugin
 * patterns are numbered from a pool (0x1f..0xf7, 0x100..0xfffe) in scan
 * order; LoadUsageMapAndUpdate renumbers the house's to them.
 */

import { atoi, getBuildStrings, NumPool, parseUsageMap, parseUsageMapBytes, scanPluginFiles, type EnumEntry, type PluginFile } from "./floors.js";
import { ResFile } from "./iffres.js";
import { Renderer } from "./renderer.js";
import { Strings } from "../res/strings.js";
import { getWall, SEG_HORIZ, SEG_VERT } from "./tilewalls.js";
import { fixedSetWall, patternSlot } from "./tools/worldedit.js";
import type { FixedWorld } from "./world.js";
import { buildUsageMap, encodeUsageMap } from "./usagemap.js";

/** WallPattNode (0x20 bytes). */
interface WallPattNode {
  /** +0x00: plugin index (SpritePlugin vector, 0 = walls.iff). */
  plugin: number;
  renderer: Renderer;
  /** +0x04..+0x0c: sprite ids for scales 1, 2, 3. */
  ids: [number, number, number];
  /** +0x10: price of one wall side. */
  cost: number;
  /** +0x14 / +0x18: plugin name and description (empty: the string set's defaults). */
  name: string;
  description: string;
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

/**
 * ProcessPluginFile's parse of a 9-character plugin sprite label: red from
 * characters 1-2, green from character 4 twice, blue from characters 7-8.
 */
function pluginLabelColor(label: string): number {
  if (label.length !== 9) return 0;
  const hex = (i: number): number => {
    const c = label.charCodeAt(i);
    if (c >= 0x30 && c <= 0x39) return c - 0x30;
    if (c >= 0x41 && c <= 0x46) return c - 0x37;
    return 0;
  };
  const r = hex(1) * 16 + hex(2);
  const g = hex(4) * 16 + hex(4);
  const b = hex(7) * 16 + hex(8);
  return ((r << 24) | (g << 16) | (b << 8)) >>> 0;
}

/** GetNextWallPaper's plugin range test. */
function isPluginWallpaper(p: number): boolean {
  return (p > 0x1e && p < 0xf8) || (p > 0xff && p < 0xffff);
}

export class WallGraphicsMgr {
  /** +0x00: WallPattern -> WallPattNode. */
  private readonly patterns = new Map<number, WallPattNode>();
  /** +0x10: the plugin pattern numbers. */
  private readonly pool = new NumPool([
    [0x1f, 0xf7],
    [0x100, 0xfffe],
  ]);
  /** +0x28: SpritePlugin vector (file, renderer); 0 = walls.iff. */
  private readonly plugins: Array<{ file: string; renderer: Renderer }> = [];
  /** +0x114: plugin files that could not be used. */
  private readonly badFiles: string[] = [];
  /** +0x34 / +0xa0: Build.iff STR# 0x83 (built-in wallpapers) and 0x87 (plugin defaults). */
  private paperStrings: string[] = [];
  private pluginStrings: string[] = [];
  /** +0x10c: the default plugin wallpaper price (STR# 0x87 entry 1). */
  private defaultCost = 0;
  /** +0x14: BeginEnum's position (sorted pattern numbers). */
  private enumKeys: number[] = [];
  private enumPos = 0;
  /** Plugin 0: GameData/walls.iff (GetGlobalRenderer). */
  global!: Renderer;

  /** WallGraphicsMgr::Initialize: walls.iff patterns 0..30 and 0xf8..0xff, then every plugin wallpaper file. */
  async initialize(): Promise<void> {
    const [res, strings] = await Promise.all([ResFile.open("GameData/walls.iff"), getBuildStrings()]);
    this.global = new Renderer(res);
    this.plugins.push({ file: "walls.iff", renderer: this.global });
    this.paperStrings = strings.list("Build", 0x83);
    this.pluginStrings = strings.list("Build", 0x87);
    this.defaultCost = this.pluginStrings[0] ? atoi(this.pluginStrings[0]) : 0;
    for (let p = 0; p < 0x100; p++) {
      if (p === 0x1f) p = 0xf8;
      const label = res.find("SPR#", p + 0x600)?.label ?? "";
      const costStr = this.paperStrings[(p - 1) * 3];
      this.patterns.set(p, {
        plugin: 0,
        renderer: this.global,
        ids: [p + 0x600, p + 0x700, p + 0x800],
        cost: costStr ? atoi(costStr) : 0,
        name: "",
        description: "",
        color: labelColor(label),
      });
    }
    const files = await scanPluginFiles(".wll", "Walls").catch(() => []);
    const opened = await Promise.all(files.map((f) => (f.far ? ResFile.openInFar(f.far, f.path) : ResFile.open(f.path)).catch(() => null)));
    for (let i = 0; i < files.length; i++) await this.processPluginFile(files[i]!, opened[i] ?? null);
  }

  /** WallGraphicsMgr::ProcessPluginFile. */
  private async processPluginFile(f: PluginFile, res: ResFile | null): Promise<void> {
    if (this.plugins.some((p) => p.file.toLowerCase() === f.name.toLowerCase())) return;
    const n = res ? Math.trunc(res.count("SPR#") / 3) : 0;
    if (!res || n < 1) {
      if (!this.badFiles.includes(f.name)) this.badFiles.push(f.name);
      return;
    }
    const renderer = new Renderer(res);
    const plugin = this.plugins.length;
    const str = res.get("STR#", 0);
    const strs = str ? await new Strings().parse(str) : null;
    for (let i = 1; i <= n; i++) {
      const pattern = this.pool.take();
      if (pattern === 0xffff) break;
      const c = res.find("SPR#", i);
      if (!c) continue;
      const node: WallPattNode = {
        plugin,
        renderer,
        ids: [i, i + 0x700, i + 0x800],
        cost: this.defaultCost,
        name: "",
        description: "",
        color: pluginLabelColor(c.label),
      };
      if (strs) {
        node.name = strs[0] ?? "";
        if (strs[1]) node.cost = atoi(strs[1]);
        node.description = strs[2] ?? "";
      }
      this.patterns.set(pattern, node);
    }
    this.plugins.push({ file: f.name, renderer });
  }

  /**
   * WallGraphicsMgr::LoadUsageMapAndUpdate for the house's WALm chunk (id 1,
   * or id 0 with byte fields for old houses): the house's plugin patterns
   * are renumbered to this session's (same file and sprite, else the
   * registered pattern of nearest color, else 1) and, given the world, its
   * walls rewritten. Without the world, the house numbers are aliased to
   * the session's patterns where they are free.
   */
  async loadUsageMap(house: ResFile, fixed?: FixedWorld): Promise<void> {
    const b1 = house.get("WALm", 1);
    const b0 = b1 ? null : house.get("WALm", 0);
    const map = b1 ? parseUsageMap(b1) : b0 ? parseUsageMapBytes(b0) : [];
    const xlat = new Uint16Array(0x10000).fill(0xffff);
    const sorted = [...this.patterns.entries()].sort((a, b) => a[0] - b[0]);
    for (const f of map) {
      const plugin = this.plugins.findIndex((p) => p.file.toLowerCase() === f.file.toLowerCase());
      for (const u of f.uses) {
        if (plugin > 0) {
          const hit = sorted.find(([, n]) => n.plugin === plugin && n.ids[0] === u.index);
          xlat[u.pattern] = hit ? hit[0] : 0xffff;
        }
        if (xlat[u.pattern] === 0xffff) {
          let best = 0xffffffff;
          let q = 0xffff;
          for (const [p, n] of sorted) {
            const dg = ((n.color >>> 16) & 0xff) - ((u.data >>> 16) & 0xff);
            const dr = (n.color >>> 24) - (u.data >>> 24);
            const db = ((n.color >>> 8) & 0xff) - ((u.data >>> 8) & 0xff);
            const d = (db * db + dr * dr + dg * dg) >>> 0;
            if (d < best) {
              q = p;
              best = d;
            }
          }
          xlat[u.pattern] = q === 0xffff ? 1 : q;
        }
      }
    }
    if (!fixed) {
      for (const f of map) {
        for (const u of f.uses) {
          const node = this.patterns.get(xlat[u.pattern]!);
          if (node && !this.patterns.has(u.pattern)) this.patterns.set(u.pattern, node);
        }
      }
      return;
    }
    const n = fixed.size;
    for (let level = 1; level <= 2; level++) {
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const t = getWall(fixed, x, y, level);
          let changed = false;
          for (let seg = 1; seg < 0x40; seg <<= 1) {
            if (!(t.segs & seg)) continue;
            const sides = seg === SEG_VERT ? [1, 3] : seg === SEG_HORIZ ? [2, 4] : [0];
            for (const side of sides) {
              const slot = patternSlot(seg, side);
              const v = t.patterns[slot]!;
              if (!isPluginWallpaper(v) || xlat[v] === v) continue;
              t.patterns[slot] = xlat[v]!;
              changed = true;
            }
          }
          if (changed) fixedSetWall(fixed, x, y, level, { t, rot: 0 });
        }
      }
    }
  }

  /**
   * WallGraphicsMgr::SaveUsageMap: the WALm payloads (chunk 0: byte fields,
   * chunk 1: 16-bit fields) for the plugin wallpapers on the lot's walls
   * (world/usagemap.ts). The segment walk is the original's: from the first
   * segment bit up, stopping before 0x20 unless it is the first one.
   */
  saveUsageMap(fixed: FixedWorld): [Uint8Array, Uint8Array] {
    const used = new Uint8Array(0x10000);
    const n = fixed.size;
    for (let level = 1; level <= 2; level++) {
      for (let x = 0; x < n; x++) {
        for (let y = 0; y < n; y++) {
          const t = getWall(fixed, y, x, level);
          let seg = 0;
          if (t.segs !== 0) for (seg = 1; seg !== (seg & t.segs); seg <<= 1);
          while (seg !== 0) {
            const sides = seg === 0x20 ? [1, 3] : seg === 0x10 ? [2, 4] : [0];
            for (const side of sides) {
              let i = 31 - Math.clz32(seg);
              if (side === 1 || side === 4) i += 1;
              else if (side === 3) i += 2;
              used[t.patterns[i]!] = 1;
            }
            do {
              seg <<= 1;
              if (seg === (seg & t.segs)) break;
            } while (seg < 0x20);
            if (seg > 0x1f) seg = 0;
          }
        }
      }
    }
    const map = buildUsageMap(
      used,
      0x1f,
      0xf8,
      (p) => {
        const node = this.patterns.get(p);
        return node ? { plugin: node.plugin, index: node.ids[0], data: node.color } : null;
      },
      (plugin) => this.plugins[plugin]?.file ?? "",
    );
    return [encodeUsageMap(map, "WALm", false), encodeUsageMap(map, "WALm", true)];
  }

  /** WallGraphicsMgr::GetWallPatternGraphic: null when the pattern is unknown. */
  getWallPatternGraphic(pattern: number, scale: number): { renderer: Renderer; id: number } | null {
    const n = this.patterns.get(pattern);
    return n ? { renderer: n.renderer, id: n.ids[scale - 1]! } : null;
  }

  /** WallGraphicsMgr::GetWallPatternCost: the price of one wall side (0 for an unknown pattern). */
  getWallPatternCost(pattern: number): number {
    return this.patterns.get(pattern)?.cost ?? 0;
  }

  /** WallGraphicsMgr::BeginEnum (the first pattern, 0, is skipped). */
  beginEnum(): void {
    this.enumKeys = [...this.patterns.keys()].sort((a, b) => a - b).slice(1);
    this.enumPos = 0;
  }

  /**
   * WallGraphicsMgr::GetNextWallPaper: the next wallpaper (0xf8..0xff are
   * skipped) with its name, description and price; null at the end, or when
   * the strings run out.
   */
  getNextWallPaper(): EnumEntry | null {
    for (;;) {
      const pattern = this.enumKeys[this.enumPos];
      if (pattern === undefined) return null;
      this.enumPos++;
      if (pattern > 0xf7 && pattern < 0x100) continue;
      const n = this.patterns.get(pattern)!;
      if (isPluginWallpaper(pattern)) {
        return {
          pattern,
          name: n.name || (this.pluginStrings[1] ?? ""),
          description: n.description || (this.pluginStrings[2] ?? ""),
          cost: n.cost,
        };
      }
      const i = (pattern - 1) * 3;
      if (this.paperStrings.length < i + 3) return null;
      return { pattern, name: this.paperStrings[i + 1]!, description: this.paperStrings[i + 2]!, cost: n.cost };
    }
  }

  /** WallGraphicsMgr::EndEnum. */
  endEnum(): void {
    this.enumKeys = [];
    this.enumPos = 0;
  }
}
