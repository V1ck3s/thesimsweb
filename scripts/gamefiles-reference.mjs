#!/usr/bin/env node
// Writes the reference list of the game's files (client/public/gamefiles-reference.json)
// from a complete install of The Sims (Complete Collection): each file's path and size,
// nothing of its content. The installation check (pnpm check-game, the landing page,
// client/src/engine/gamecheck.ts) compares a game folder with it.
//
//   node scripts/gamefiles-reference.mjs "/path/to/The Sims" "Complete Collection, French"
//
// Left out: the files at the top of the install (the program, its libraries, logs),
// support/ (help, registration), Downloads/ and GameData/UserObjects/ (the player's
// additions) and the UserData* folders (the saves), except UserData/Neighborhood.iff,
// listed without a size (it changes as the game saves). Also left out, the loose files
// under UIGraphics/ that replace an entry of UIGraphics.far with another size: mods do
// that (the widescreen patch's backgrounds and load screens); the original's own loose
// copies (cursors, Res_*.RT / .h) have the archive's size.

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [dir, source = "Complete Collection"] = process.argv.slice(2);
if (!dir) {
  console.error('usage: node scripts/gamefiles-reference.mjs <install folder> ["description"]');
  process.exit(2);
}

/** The entries of a FAR (version 1) archive: lower-cased "/"-separated name -> size. */
async function farSizes(path) {
  const b = await readFile(path).catch(() => null);
  const sizes = new Map();
  if (!b || b.toString("latin1", 0, 8) !== "FAR!byAZ") return sizes;
  const at = b.readUInt32LE(12);
  const n = b.readUInt32LE(at);
  let p = at + 4;
  for (let i = 0; i < n; i++) {
    const size = b.readUInt32LE(p);
    const len = b.readUInt32LE(p + 12);
    sizes.set(b.toString("latin1", p + 16, p + 16 + len).split("\\").join("/").toLowerCase(), size);
    p += 16 + len;
  }
  return sizes;
}

const uiFar = await farSizes(join(resolve(dir), "UIGraphics", "UIGraphics.far"));
/** A loose UIGraphics/ file that replaces the archive's entry with another one (a mod). */
function replacesUi(rel, size) {
  const m = /^uigraphics\/(.+)$/i.exec(rel);
  if (!m) return false;
  const far = uiFar.get(m[1].toLowerCase());
  return far !== undefined && far !== size;
}

const SKIPPED_EXT = new Set(["exe", "dll", "log", "cab", "jar", "tmp", "bak"]);
const SKIPPED_NAME = new Set(["thumbs.db", "desktop.ini", ".ds_store"]);

function listed(rel) {
  const parts = rel.toLowerCase().split("/");
  if (parts.length < 2) return false;
  if (parts[0] === "support" || parts[0] === "downloads" || /^userdata\d*$/.test(parts[0])) return false;
  if (parts[0] === "gamedata" && parts[1] === "userobjects") return false;
  const name = parts[parts.length - 1];
  if (SKIPPED_NAME.has(name)) return false;
  const dot = name.lastIndexOf(".");
  return dot < 0 || !SKIPPED_EXT.has(name.slice(dot + 1));
}

async function walk(d) {
  const entries = await readdir(d, { withFileTypes: true });
  const parts = await Promise.all(
    entries.map(async (e) => {
      const full = join(d, e.name);
      if (e.isDirectory()) return walk(full);
      if (!e.isFile()) return [];
      const rel = relative(dir, full).split("\\").join("/");
      if (!listed(rel)) return [];
      const size = (await stat(full)).size;
      if (replacesUi(rel, size)) {
        replaced.push(rel);
        return [];
      }
      return [[rel, size]];
    }),
  );
  return parts.flat();
}

const replaced = [];
const files = (await walk(resolve(dir))).sort((a, b) => a[0].localeCompare(b[0], "en"));
files.push(["UserData/Neighborhood.iff", -1]);
const out = join(root, "client", "public", "gamefiles-reference.json");
const body = {
  about: "The files of a complete install of The Sims, as paths and sizes (-1: any size). Written by scripts/gamefiles-reference.mjs.",
  source,
  files,
};
await writeFile(out, `${JSON.stringify(body)}\n`);
console.log(`${files.length} files -> ${relative(root, out)}`);
if (replaced.length) console.log(`left out, replacing an entry of UIGraphics.far (a mod): ${replaced.sort().join(", ")}`);
