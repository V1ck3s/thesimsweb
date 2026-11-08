#!/usr/bin/env node
// Checks that a game folder holds every file of a complete install of The Sims
// (Complete Collection): compares it with client/public/gamefiles-reference.json
// (paths and sizes, see scripts/gamefiles-reference.mjs). The same check as the
// landing page's (client/src/engine/gamecheck.ts, kept in step with this one).
//
//   pnpm check-game                       # the server's game folder (server/assets/Sims)
//   pnpm check-game "/path/to/The Sims"   # or SIMS_DIR=...
//   pnpm check-game --all                 # list every missing file, not only the first per folder
//
// Exit code: 0 complete (sizes may differ), 1 game files missing, 2 usage or unreadable folder.

import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const all = args.includes("--all");
const dir = resolve(args.find((a) => !a.startsWith("--")) ?? process.env.SIMS_DIR ?? join(root, "server", "assets", "Sims"));

/** Skins, music and the TV / radio / ambient sounds: the game runs without them. */
const isContent = (p) => {
  const l = p.toLowerCase();
  return l.startsWith("music/") || /(^|\/)(skins|skinsbuy|tvstations)\//.test(l);
};

async function walk(d) {
  let entries;
  try {
    entries = await readdir(d, { withFileTypes: true });
  } catch {
    return [];
  }
  const parts = await Promise.all(
    entries.map(async (e) => {
      const full = join(d, e.name);
      let s = null;
      if (e.isSymbolicLink()) s = await stat(full).catch(() => null);
      if (e.isDirectory() || s?.isDirectory()) return walk(full);
      if (!e.isFile() && !s?.isFile()) return [];
      const size = s?.size ?? (await stat(full).catch(() => null))?.size;
      return size === undefined ? [] : [[relative(dir, full).split("\\").join("/").toLowerCase(), size]];
    }),
  );
  return parts.flat();
}

const ref = JSON.parse(await readFile(join(root, "client", "public", "gamefiles-reference.json"), "utf8"));
const top = await readdir(dir).catch(() => null);
if (!top) {
  console.error(`cannot read the game folder ${dir}`);
  process.exit(2);
}
console.log(`Checking ${dir}`);
console.log(`against ${ref.files.length} files of the reference install (${ref.source})…`);
const sizes = new Map(await walk(dir));

const missingGame = [];
const missingContent = [];
const otherSize = [];
for (const [path, size] of ref.files) {
  const have = sizes.get(path.toLowerCase());
  if (have === undefined) (isContent(path) ? missingContent : missingGame).push(path);
  else if (size >= 0 && have !== size) otherSize.push(`${path} (${have} bytes, reference ${size})`);
}

function report(title, paths) {
  if (!paths.length) return;
  console.log(`\n${title}: ${paths.length}`);
  const groups = new Map();
  for (const p of paths) {
    const i = p.lastIndexOf("/");
    const folder = i < 0 ? "." : p.slice(0, i);
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(p.slice(i + 1));
  }
  for (const [folder, names] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    const shown = all ? names : names.slice(0, 5);
    console.log(`  ${folder}/ (${names.length}): ${shown.join(", ")}${shown.length < names.length ? ", …" : ""}`);
  }
}

const present = ref.files.length - missingGame.length - missingContent.length;
report("Missing game files (the game may not start or may lack parts)", missingGame);
report("Missing skins, music and sounds (the game runs, with less)", missingContent);
if (otherSize.length) {
  console.log(`\nOther size than the reference (another language or version, or a damaged copy): ${otherSize.length}`);
  for (const line of all ? otherSize : otherSize.slice(0, 10)) console.log(`  ${line}`);
  if (!all && otherSize.length > 10) console.log("  … (--all lists them all)");
}
console.log(`\n${present} of ${ref.files.length} files present.`);
if (!missingGame.length && !missingContent.length) console.log("The installation is complete.");
process.exit(missingGame.length ? 1 : 0);
