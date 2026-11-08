#!/usr/bin/env node
// Writes the reference list of the game's files (client/public/gamefiles-reference.json)
// from a complete install of The Sims (Complete Collection): each file's path and size,
// nothing of its content. The installation check (pnpm check-game, the landing page,
// client/src/engine/gamecheck.ts) compares a game folder with it.
//
//   node scripts/gamefiles-reference.mjs "/mnt/c/Program Files (x86)/Maxis/Les Sims" "Complete Collection, French"
//
// Left out: the files at the top of the install (the program, its libraries, logs),
// support/ (help, registration), Downloads/ and GameData/UserObjects/ (the player's
// additions) and the UserData* folders (the saves), except UserData/Neighborhood.iff,
// listed without a size (it changes as the game saves).

import { readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [dir, source = "Complete Collection"] = process.argv.slice(2);
if (!dir) {
  console.error('usage: node scripts/gamefiles-reference.mjs <install folder> ["description"]');
  process.exit(2);
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
      return listed(rel) ? [[rel, (await stat(full)).size]] : [];
    }),
  );
  return parts.flat();
}

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
