/**
 * FloorGraphicsMgr: floor pattern -> (sprite file, sprite id) per scale.
 *
 * Patterns 1..29 are the built-in floors of GameData/floors.iff (the global
 * renderer, also used for pool and grid sprites): sprite ids p, p + 0x100,
 * p + 0x200 for scales 1, 2, 3. Patterns >= 0x1e come from plugin .flr files;
 * a house's FLRm chunk (SpriteFileUsageTemplate<Us>, chunk id 1) lists, per
 * file name, the patterns the lot uses and their sprite index in the file
 * (LoadUsageMapAndUpdate), whose sprites are again index, +0x100, +0x200.
 */

import { openPluginFile } from "./catalog.js";
import type { Compositor } from "./compositor.js";
import { ResFile } from "./iffres.js";
import { Renderer } from "./renderer.js";
import type { HouseViewer } from "./houseviewer.js";

interface FloorNode {
  renderer: Renderer;
  /** Sprite ids for scales 1, 2, 3. */
  ids: [number, number, number];
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

export class FloorGraphicsMgr {
  private readonly patterns = new Map<number, FloorNode>();
  /** Plugin 0: GameData/floors.iff (GetGlobalRenderer). */
  global!: Renderer;

  /** FloorGraphicsMgr::Initialize. */
  async initialize(): Promise<void> {
    this.global = new Renderer(await ResFile.open("GameData/floors.iff"));
    for (let p = 1; p < 0x1e; p++) this.patterns.set(p, { renderer: this.global, ids: [p, p + 0x100, p + 0x200] });
  }

  /** FloorGraphicsMgr::LoadUsageMapAndUpdate for the house's FLRm chunk. */
  async loadUsageMap(house: ResFile): Promise<void> {
    const b = house.get("FLRm", 1);
    if (!b) return;
    for (const f of parseUsageMap(b)) {
      const res = await openPluginFile(f.file);
      if (!res) continue;
      const r = new Renderer(res);
      for (const u of f.uses) this.patterns.set(u.pattern, { renderer: r, ids: [u.index, u.index + 0x100, u.index + 0x200] });
    }
  }

  /** FloorGraphicsMgr::GetFloorGraphic. */
  getFloorGraphic(pattern: number, scale: number): { renderer: Renderer; id: number } | null {
    const n = this.patterns.get(pattern);
    return n ? { renderer: n.renderer, id: n.ids[scale - 1]! } : null;
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
