/**
 * FloorGraphicsMgr: floor pattern -> (sprite file, sprite id) per scale,
 * price, name and FloorData (color + footstep sound).
 *
 * Patterns 1..29 are the built-in floors of GameData/floors.iff (the global
 * renderer, also used for pool and grid sprites): sprite ids p, p + 0x100,
 * p + 0x200 for scales 1, 2, 3, prices from GameData/Build.iff STR# 0x82
 * entry (p - 1) * 3 + 1. Initialize then numbers every plugin .flr file's
 * floors (one per SPR2 triple, sprites i, i + 0x100, i + 0x200) from a
 * number pool (0x1e..0xfe, 0x100..0xfffe), with the file's STR# 0 for
 * name, price and description (price default: STR# 0x86 entry 1).
 * A house's FLRm chunk (SpriteFileUsageTemplate<Us>, chunk id 1) lists, per
 * file name, the patterns the lot uses and their sprite index in the file;
 * LoadUsageMapAndUpdate renumbers them to the session's patterns.
 */

import { fetchManifest, readFarManifest } from "../../engine/assets.js";
import { Strings } from "../res/strings.js";
import type { Compositor } from "./compositor.js";
import type { HouseViewer } from "./houseviewer.js";
import { ResFile } from "./iffres.js";
import { Renderer } from "./renderer.js";
import { getWall } from "./tilewalls.js";
import { fixedSetWall } from "./tools/worldedit.js";
import type { FixedWorld } from "./world.js";

/** FloorIDNode (0x20 bytes). */
interface FloorNode {
  /** +0x00: plugin index (SpritePlugin vector, 0 = floors.iff). */
  plugin: number;
  renderer: Renderer;
  /** +0x04..+0x0c: sprite ids for scales 1, 2, 3. */
  ids: [number, number, number];
  /** +0x10: price of one tile. */
  cost: number;
  /** +0x14 / +0x18: plugin name and description (empty: the string set's defaults). */
  name: string;
  description: string;
  /** +0x1c: FloorData (RGB << 8 | footstep sound). */
  data: number;
}

const cp1252 = new TextDecoder("windows-1252");

/** ReconLoadVector<SpriteFileUsageTemplate<Us>> (FLRm / WALm chunk id 1). */
export function parseUsageMap(b: Uint8Array): Array<{ file: string; uses: Array<{ pattern: number; index: number; data: number }> }> {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 12;
  const n = v.getUint32(p, true);
  p += 4;
  const out: Array<{ file: string; uses: Array<{ pattern: number; index: number; data: number }> }> = [];
  for (let i = 0; i < n && p < b.length; i++) {
    let e = p;
    while (e < b.length && b[e] !== 0) e++;
    const file = cp1252.decode(b.subarray(p, e));
    p = e + 1;
    p += p & 1;
    const count = v.getUint32(p, true);
    p += 4;
    const uses: Array<{ pattern: number; index: number; data: number }> = [];
    for (let k = 0; k < count; k++) {
      uses.push({ pattern: v.getUint16(p, true), index: v.getUint16(p + 2, true), data: v.getUint32(p + 4, true) });
      p += 8;
    }
    out.push({ file, uses });
  }
  return out;
}

/** ReconLoadVector<SpriteFileUsageTemplate<Uc>> then ConvertUsageMap (old houses: chunk id 0, byte fields). */
export function parseUsageMapBytes(b: Uint8Array): Array<{ file: string; uses: Array<{ pattern: number; index: number; data: number }> }> {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 12;
  const n = v.getUint32(p, true);
  p += 4;
  const out: Array<{ file: string; uses: Array<{ pattern: number; index: number; data: number }> }> = [];
  for (let i = 0; i < n && p < b.length; i++) {
    let e = p;
    while (e < b.length && b[e] !== 0) e++;
    const file = cp1252.decode(b.subarray(p, e));
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

/** The string sets of GameData/Build.iff (StdResFile "build"), shared by the floor and wall managers. */
let buildStrings: Promise<Strings> | null = null;
export function getBuildStrings(): Promise<Strings> {
  buildStrings ??= (async () => {
    const s = new Strings();
    await s.load("GameData/Build.iff");
    return s;
  })();
  return buildStrings;
}

/** func_10595F30 (atoi): leading decimal digits, 0 when none. */
export function atoi(s: string): number {
  const m = /^\s*([+-]?\d+)/.exec(s);
  return m ? parseInt(m[1]!, 10) : 0;
}

/** One plugin file FolderScanner found: loose under the game folder or inside an expansion archive. */
export interface PluginFile {
  /** File name (ExtractFileName). */
  name: string;
  far: string | null;
  path: string;
}

/**
 * The plugin files (.flr / .wll) Initialize scans, in its order: every
 * expansion's "WallsAndFloors/" folder (ExpansionPack, 2, 3, 4, Deluxe, 5,
 * 6, 7, ExpansionShared; the expansion folders are FAR directory images),
 * then GameData/<local>/. Within a folder: the archive's entry order, or
 * file names in case-insensitive order on disk (FindFirstFile / FindNextFile).
 */
export async function scanPluginFiles(ext: string, local: string): Promise<PluginFile[]> {
  const m = await fetchManifest();
  const want = ext.toLowerCase();
  const dirs = ["ExpansionPack", "ExpansionPack2", "ExpansionPack3", "ExpansionPack4", "Deluxe", "ExpansionPack5", "ExpansionPack6", "ExpansionPack7", "ExpansionShared"];
  const out: PluginFile[] = [];
  const seen = new Set<string>();
  const add = (f: PluginFile): void => {
    const k = `${f.far ?? ""}|${f.path.toLowerCase()}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(f);
  };
  const loose = (prefix: string): void => {
    const files = m.files
      .map((f) => f.path)
      .filter((p) => p.toLowerCase().startsWith(`sims/${prefix.toLowerCase()}`) && p.toLowerCase().endsWith(want) && !p.slice(5 + prefix.length).includes("/"))
      .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
    for (const p of files) add({ name: p.slice(p.lastIndexOf("/") + 1), far: null, path: p.slice(5) });
  };
  for (const d of dirs) {
    loose(`${d}/WallsAndFloors/`);
    const fars = m.files.map((f) => f.path).filter((p) => p.toLowerCase().startsWith(`sims/${d.toLowerCase()}/`) && p.toLowerCase().endsWith(".far"));
    for (const far of fars) {
      const entries = await readFarManifest(far).catch(() => null);
      if (!entries) continue;
      for (const e of entries) {
        const n = e.filename.replace(/\//g, "\\");
        const lower = n.toLowerCase();
        if (!lower.startsWith("wallsandfloors\\") || !lower.endsWith(want) || lower.slice(15).includes("\\")) continue;
        add({ name: n.slice(n.lastIndexOf("\\") + 1), far: far.slice(5), path: e.filename });
      }
    }
  }
  loose(`GameData/${local}/`);
  return out;
}

/**
 * cRZNumPool<unsigned short>: free number ranges, handed out lowest first
 * (FloorGraphicsMgr: 0x1e..0xfe and 0x100..0xfffe).
 */
export class NumPool {
  private readonly ranges: Array<[number, number]>;
  constructor(ranges: Array<[number, number]>) {
    this.ranges = ranges.map(([a, b]) => [a, b]);
  }
  /** The next number, or 0xffff when the pool is empty. */
  take(): number {
    const r = this.ranges[0];
    if (!r) return 0xffff;
    const n = r[0];
    r[0]++;
    if (r[0] > r[1]) this.ranges.shift();
    return n;
  }
}

/** FloorData::FromResName: footstep sound from the label's first letter, color from "?R..G..B.." (RGB << 8 | sound). */
export function floorDataFromResName(label: string): number {
  let sound = 0;
  if (label.length > 0) {
    const c = label.charCodeAt(0);
    // Jump table lbl_105BBEF8 over 'C'..'S'.
    if (c === 0x43) sound = 3;
    else if (c === 0x4d) sound = 1;
    else if (c === 0x53) sound = 2;
  }
  if (label.length < 10) return sound;
  const hex = (i: number): number => {
    const c = label.charCodeAt(i);
    if (c >= 0x30 && c <= 0x39) return c - 0x30;
    if (c >= 0x41 && c <= 0x46) return c - 0x37;
    return 0;
  };
  const r = hex(2) * 16 + hex(3);
  const g = hex(5) * 16 + hex(6);
  const b = hex(8) * 16 + hex(9);
  return ((r << 24) | (g << 16) | (b << 8) | sound) >>> 0;
}

/** A plugin floor or wallpaper of GetNextFloor / GetNextWallPaper. */
export interface EnumEntry {
  pattern: number;
  name: string;
  description: string;
  cost: number;
}

/** FloorGraphicsMgr::GetNextFloor's plugin range test. */
export function isPluginFloor(p: number): boolean {
  return (p > 0x1d && p < 0xff) || (p > 0xff && p < 0xffff);
}

export class FloorGraphicsMgr {
  /** +0x00: FloorPattern -> FloorIDNode. */
  private readonly patterns = new Map<number, FloorNode>();
  /** +0x10: the plugin pattern numbers. */
  private readonly pool = new NumPool([
    [0x1e, 0xfe],
    [0x100, 0xfffe],
  ]);
  /** +0x28: SpritePlugin vector (file, renderer); 0 = floors.iff. */
  private readonly plugins: Array<{ file: string; renderer: Renderer }> = [];
  /** +0x120: plugin files that could not be used. */
  private readonly badFiles: string[] = [];
  /** +0x40 / +0xac: Build.iff STR# 0x82 (built-in floors) and 0x86 (plugin defaults). */
  private floorStrings: string[] = [];
  private pluginStrings: string[] = [];
  /** +0x118: the default plugin floor price (STR# 0x86 entry 1). */
  private defaultCost = 0;
  /** +0x14: BeginEnum's position (sorted pattern numbers). */
  private enumKeys: number[] = [];
  private enumPos = 0;
  /** Plugin 0: GameData/floors.iff (GetGlobalRenderer). */
  global!: Renderer;

  /** FloorGraphicsMgr::Initialize: floors.iff patterns 1..29, then every plugin floor file. */
  async initialize(): Promise<void> {
    const [res, strings] = await Promise.all([ResFile.open("GameData/floors.iff"), getBuildStrings()]);
    this.global = new Renderer(res);
    this.plugins.push({ file: "floors.iff", renderer: this.global });
    this.floorStrings = strings.list("Build", 0x82);
    this.pluginStrings = strings.list("Build", 0x86);
    this.defaultCost = this.pluginStrings[0] ? atoi(this.pluginStrings[0]) : 0;
    for (let p = 1; p < 0x1e; p++) {
      const costStr = this.floorStrings[(p - 1) * 3];
      const label = res.find("SPR2", p)?.label ?? null;
      this.patterns.set(p, {
        plugin: 0,
        renderer: this.global,
        ids: [p, p + 0x100, p + 0x200],
        cost: costStr ? atoi(costStr) : 0,
        name: "",
        description: "",
        data: label !== null ? floorDataFromResName(label) : 0,
      });
    }
    const files = await scanPluginFiles(".flr", "Floors").catch(() => []);
    const opened = await Promise.all(files.map((f) => (f.far ? ResFile.openInFar(f.far, f.path) : ResFile.open(f.path)).catch(() => null)));
    for (let i = 0; i < files.length; i++) await this.processPluginFile(files[i]!, opened[i] ?? null);
  }

  /** FloorGraphicsMgr::ProcessPluginFile. */
  private async processPluginFile(f: PluginFile, res: ResFile | null): Promise<void> {
    if (this.plugins.some((p) => p.file.toLowerCase() === f.name.toLowerCase())) return;
    const n = res ? Math.trunc(res.count("SPR2") / 3) : 0;
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
      const c = res.find("SPR2", i);
      if (!c) continue;
      const node: FloorNode = {
        plugin,
        renderer,
        ids: [i, i + 0x100, i + 0x200],
        cost: this.defaultCost,
        name: "",
        description: "",
        data: floorDataFromResName(c.label),
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
   * FloorGraphicsMgr::LoadUsageMapAndUpdate for the house's FLRm chunk: the
   * house's plugin patterns are renumbered to this session's (same file and
   * sprite, else the nearest color with the same sound, else pattern 1) and,
   * given the world, its floors (and diagonal floor halves) rewritten.
   * Without the world, the house numbers are aliased to the session's
   * patterns where they are free.
   */
  async loadUsageMap(house: ResFile, fixed?: FixedWorld): Promise<void> {
    const b1 = house.get("FLRm", 1);
    const b0 = b1 ? null : house.get("FLRm", 0);
    const map = b1 ? parseUsageMap(b1) : b0 ? parseUsageMapBytes(b0) : [];
    const xlat = new Uint16Array(0x10000).fill(0xffff);
    for (const f of map) {
      const plugin = this.plugins.findIndex((p) => p.file.toLowerCase() === f.file.toLowerCase());
      for (const u of f.uses) {
        if (plugin > 0) {
          let q = 0xffff;
          for (const [p, n] of this.sortedEntries()) {
            if (n.plugin === plugin && n.ids[0] === u.index) {
              q = p;
              break;
            }
          }
          xlat[u.pattern] = q;
        }
        if (xlat[u.pattern] === 0xffff) {
          xlat[u.pattern] = this.findNearestFit(u.data, false);
          if (xlat[u.pattern] === 0xffff) xlat[u.pattern] = 1;
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
      const a = fixed.floors[level - 1]!;
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const v = a.u16(x, y);
          if (isPluginFloor(v)) {
            if (xlat[v] !== v) {
              const o = a.offset(x, y);
              a.data[o] = xlat[v]! & 0xff;
              a.data[o + 1] = xlat[v]! >> 8;
            }
            continue;
          }
          if (v !== 0xff) continue;
          const t = getWall(fixed, x, y, level);
          if (!(t.segs & 0x30)) continue;
          let first = 1;
          while (first !== (first & t.segs)) first <<= 1;
          const sides = first === 0x20 ? [1, 3] : first === 0x10 ? [2, 4] : null;
          if (!sides) continue;
          let changed = false;
          for (const side of sides) {
            const u = side === 2 || side === 1 ? t.styles[0]! : t.patterns[0]!;
            if (!isPluginFloor(u) || xlat[u] === u) continue;
            if (side === 2 || side === 1) t.styles[0] = xlat[u]!;
            else t.patterns[0] = xlat[u]!;
            changed = true;
          }
          if (changed) fixedSetWall(fixed, x, y, level, { t, rot: 0 });
        }
      }
    }
  }

  private sortedEntries(): Array<[number, FloorNode]> {
    return [...this.patterns.entries()].sort((a, b) => a[0] - b[0]);
  }

  /** FloorGraphicsMgr::FindNearestFit: the pattern of nearest color with the same footstep sound (0xffff: none). */
  findNearestFit(data: number, builtinOnly: boolean): number {
    let best = 0xffffffff;
    let found = 0xffff;
    for (const [p, n] of this.sortedEntries()) {
      if (builtinOnly && p >= 0xff) continue;
      if ((data & 0xff) !== (n.data & 0xff)) continue;
      const dr = (n.data >>> 24) - (data >>> 24);
      const dg = ((n.data >>> 16) & 0xff) - ((data >>> 16) & 0xff);
      const db = ((n.data >>> 8) & 0xff) - ((data >>> 8) & 0xff);
      const d = (db * db + dr * dr + dg * dg) >>> 0;
      if (d < best) {
        found = p;
        best = d;
      }
    }
    return found;
  }

  /** FloorGraphicsMgr::GetFloorGraphic. */
  getFloorGraphic(pattern: number, scale: number): { renderer: Renderer; id: number } | null {
    const n = this.patterns.get(pattern);
    return n ? { renderer: n.renderer, id: n.ids[scale - 1]! } : null;
  }

  /** FloorGraphicsMgr::GetFloorCost: the price of one tile (0 for an unknown pattern). */
  getFloorCost(pattern: number): number {
    return this.patterns.get(pattern)?.cost ?? 0;
  }

  /** FloorGraphicsMgr::GetFloorSound (2 for an unknown pattern). */
  getFloorSound(pattern: number): number {
    const n = this.patterns.get(pattern);
    return n ? n.data & 0xff : 2;
  }

  /** FloorGraphicsMgr::IsLegalFloorPattern. */
  isLegalFloorPattern(pattern: number): boolean {
    return this.patterns.has(pattern);
  }

  /** FloorGraphicsMgr::BeginEnum. */
  beginEnum(): void {
    this.enumKeys = [...this.patterns.keys()].sort((a, b) => a - b);
    this.enumPos = 0;
  }

  /**
   * FloorGraphicsMgr::GetNextFloor: the next floor with its name,
   * description and price; null at the end, or when the strings run out.
   */
  getNextFloor(): EnumEntry | null {
    const pattern = this.enumKeys[this.enumPos];
    if (pattern === undefined) return null;
    const n = this.patterns.get(pattern)!;
    let name: string;
    let description: string;
    if (isPluginFloor(pattern)) {
      if (this.pluginStrings.length < 2) return null;
      name = n.name || this.pluginStrings[1]!;
      description = n.description || (this.pluginStrings[2] ?? "");
    } else {
      const i = (pattern - 1) * 3;
      if (this.floorStrings.length < i + 3) return null;
      name = this.floorStrings[i + 1]!;
      description = this.floorStrings[i + 2]!;
    }
    this.enumPos++;
    return { pattern, name, description, cost: n.cost };
  }

  /** FloorGraphicsMgr::EndEnum. */
  endEnum(): void {
    this.enumKeys = [];
    this.enumPos = 0;
  }
}

/**
 * cRenderer::DrawFloor: a color-only floor sprite whose depth follows the
 * floor table row by row, anchored at the tile's terrain depth
 * (GetTerrainZ + level offset + 0x41).
 */
export function drawFloor(
  comp: Compositor,
  viewer: HouseViewer,
  renderer: Renderer,
  tile: { x: number; y: number; level: number },
  spriteId: number,
  x: number,
  y: number,
  extraZ = 0,
): void {
  const f = renderer.frame(spriteId, 0);
  const tex = renderer.texture(comp, spriteId, 0);
  if (!f || !tex) return;
  const s = viewer.scale;
  const zb = viewer.zbuf;
  const oy = viewer.originY;
  let base = viewer.getTerrainZ(tile.x, tile.y) + (tile.level - 1) * zb.levelZ.get(s)! + 0x41 + extraZ;
  base -= zb.floorAt(s, y - f.yLoc, oy);
  comp.drawFloorSprite(tex, x, y, false, base, viewer.floorRowIndex(y));
}
