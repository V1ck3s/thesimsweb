/**
 * Locates plugin files (floors .flr, wallpapers .wll) by file name the way
 * the game's FolderScanner + CTGFileManager do: loose files under the game
 * folder first, then the expansion archives (ExpansionPack*.far etc.), whose
 * entries sit under sub-folders like "WallsAndFloors\".
 */

import { fetchManifest, readFarManifest } from "../../engine/assets.js";
import { ResFile } from "./iffres.js";

interface Located {
  far: string | null;
  /** Loose: path relative to the game folder; FAR: entry name. */
  path: string;
}

let index: Promise<Map<string, Located>> | null = null;

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return p.slice(i + 1).toLowerCase();
}

async function build(): Promise<Map<string, Located>> {
  const map = new Map<string, Located>();
  const m = await fetchManifest();
  const fars: string[] = [];
  for (const f of m.files) {
    if (!f.path.startsWith("Sims/")) continue;
    const rel = f.path.slice(5);
    const lower = rel.toLowerCase();
    if (lower.endsWith(".flr") || lower.endsWith(".wll")) {
      if (!map.has(baseName(rel))) map.set(baseName(rel), { far: null, path: rel });
    } else if (lower.endsWith(".far") && /^(expansionpack\d*|expansionshared|deluxe|downloads)\//.test(lower)) {
      fars.push(rel);
    }
  }
  const lists = await Promise.all(fars.map((far) => readFarManifest(`Sims/${far}`).then((e) => ({ far, e })).catch(() => null)));
  for (const l of lists) {
    if (!l) continue;
    for (const e of l.e) {
      const n = baseName(e.filename);
      if ((n.endsWith(".flr") || n.endsWith(".wll")) && !map.has(n)) map.set(n, { far: l.far, path: e.filename });
    }
  }
  return map;
}

const opened = new Map<string, Promise<ResFile | null>>();

/** Open a plugin file by name (case-insensitive), or null when absent. */
export function openPluginFile(name: string): Promise<ResFile | null> {
  const key = name.toLowerCase();
  let p = opened.get(key);
  if (!p) {
    p = (async () => {
      index ??= build();
      const loc = (await index).get(key);
      if (!loc) return null;
      return loc.far ? ResFile.openInFar(loc.far, loc.path) : ResFile.open(loc.path);
    })();
    opened.set(key, p);
  }
  return p;
}
