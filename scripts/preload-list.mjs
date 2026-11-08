#!/usr/bin/env node
// Writes the list of game files every lot load reads (client/src/game/preload-lots.json),
// for the start-up preloader (client/src/game/preload.ts): the FAR entries and loose
// files that each recorded lot load downloaded, whatever the lot (the people, cars,
// NPCs, doors, windows, stairs... a lot creates or holds). Names only, no content.
//
//   node scripts/preload-list.mjs <game folder> <reads.json>...
//
// Each reads.json is one lot load recorded cold (a fresh browser profile) by
// scripts/record-reads.mjs: [phase, "range" | "get", path, start, end] per read,
// the lot's phase being the one whose URL has "house=". A FAR entry counts when a
// read covers it exactly (whole-entry reads: readFarEntry); the save folders
// (UserData*) are left out.

import { openSync, readFileSync, readSync, fstatSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [game, ...recordings] = process.argv.slice(2);
if (!game || !recordings.length) {
  console.error("usage: node scripts/preload-list.mjs <game folder> <reads.json>...");
  process.exit(2);
}

const fars = new Map();
/** A FAR (version 1) archive's entries by offset+size. */
function farEntries(path) {
  let m = fars.get(path);
  if (m) return m;
  m = new Map();
  try {
    const fd = openSync(join(game, path.replace(/^Sims\//, "")), "r");
    const size = fstatSync(fd).size;
    const h = Buffer.alloc(16);
    readSync(fd, h, 0, 16, 0);
    const at = h.readUInt32LE(12);
    const b = Buffer.alloc(size - at);
    readSync(fd, b, 0, b.length, at);
    let p = 4;
    for (let i = b.readUInt32LE(0); i > 0; i--) {
      const len = b.readUInt32LE(p + 12);
      m.set(`${b.readUInt32LE(p + 8)}+${b.readUInt32LE(p)}`, b.toString("latin1", p + 16, p + 16 + len));
      p += 16 + len;
    }
  } catch {
    // not in this install
  }
  fars.set(path, m);
  return m;
}

// The save folders, and the music (streamed by an <audio> element, not kept in the cache).
const save = /^Sims\/(UserData\d*|Music)\//i;
/** A loose file's size in the install (-1 when absent). */
function sizeOf(path) {
  try {
    return statSync(join(game, path.replace(/^Sims\//, ""))).size;
  } catch {
    return -1;
  }
}
let common = null;
for (const file of recordings) {
  const keys = new Set();
  for (const [phase, kind, path, start, end] of JSON.parse(readFileSync(file, "utf8"))) {
    if (!phase.includes("house=") || save.test(path)) continue;
    if (/\.far$/i.test(path)) {
      if (kind !== "range") continue;
      const entry = farEntries(path).get(`${start}+${end - start}`);
      if (entry) keys.add(`${path}|${entry}`);
    } else if (kind === "get" || (kind === "range" && start === 0 && end === sizeOf(path))) keys.add(path);
  }
  common = common ? new Set([...common].filter((k) => keys.has(k))) : keys;
  console.log(`${relative(root, resolve(file))}: ${keys.size} files`);
}
const files = [...common].sort((a, b) => a.localeCompare(b, "en")).map((k) => {
  const bar = k.indexOf("|");
  return bar < 0 ? [k] : [k.slice(0, bar), k.slice(bar + 1)];
});
const out = join(root, "client", "src", "game", "preload-lots.json");
writeFileSync(
  out,
  `${JSON.stringify({ about: "Game files every recorded lot load read: [far, entry] or [loose path]. Written by scripts/preload-list.mjs.", files })}\n`,
);
console.log(`${files.length} files common to ${recordings.length} lot loads -> ${relative(root, out)}`);
