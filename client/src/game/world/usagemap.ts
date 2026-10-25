/**
 * The write side of the FLRm / WALm chunks (FloorGraphicsMgr /
 * WallGraphicsMgr::SaveUsageMap): which plugin patterns the lot uses, per
 * plugin file.
 *
 * Both managers mark the patterns the lot's arrays use, then walk the
 * pattern numbers upwards (floors from 0x1e, skipping 0xff; walls from 0x1f,
 * skipping 0xf8..0xff); every used pattern the manager knows adds, under its
 * plugin file's entry (created at first use, named after the renderer's file),
 * a SpriteUsageTemplate {pattern, sprite index (ids[0]), node data}.
 *
 * The vector is saved twice with ReconSaveVector (stream version 0): chunk 0
 * with byte pattern and index fields (ConvertUsageMap<Uc, Us> truncates them),
 * chunk 1 with 16-bit ones. Each: ReconInt file count, then per file
 * ReconString name, ReconInt use count, then per use the pattern and index
 * (Recon8 or Recon16) and Recon32 data.
 */

import { compactRecon } from "./reconwriter.js";

export interface UsageFile {
  /** SpritePlugin index (+0x00, not saved). */
  plugin: number;
  file: string;
  uses: Array<{ pattern: number; index: number; data: number }>;
}

/** The pattern walk shared by both managers. */
export function buildUsageMap(
  used: Uint8Array,
  first: number,
  skipFrom: number,
  lookup: (pattern: number) => { plugin: number; index: number; data: number } | null,
  fileOf: (plugin: number) => string,
): UsageFile[] {
  const out: UsageFile[] = [];
  for (let p = first; p < 0xffff; p++) {
    if (p === skipFrom) p = 0x100;
    if (!used[p]) continue;
    const n = lookup(p);
    if (!n) continue;
    let f = out.find((e) => e.plugin === n.plugin);
    if (!f) {
      // The plugin renderer's path, lower case as the game's file manager keeps paths.
      f = { plugin: n.plugin, file: fileOf(n.plugin).toLowerCase(), uses: [] };
      out.push(f);
    }
    f.uses.push({ pattern: p, index: n.index & 0xffff, data: n.data >>> 0 });
  }
  return out;
}

/** ReconSaveVector<SpriteFileUsageTemplate<Uc | Us>>: the chunk payload. */
export function encodeUsageMap(map: readonly UsageFile[], tag: string, wide: boolean): Uint8Array {
  return compactRecon(0, tag, (w) => {
    w.recon32(map.length);
    for (const f of map) {
      w.reconString(f.file);
      w.recon32(f.uses.length);
      for (const u of f.uses) {
        if (wide) {
          w.recon16(u.pattern);
          w.recon16(u.index);
        } else {
          w.recon8(u.pattern);
          w.recon8(u.index);
        }
        w.recon32(u.data | 0);
      }
    }
  });
}
