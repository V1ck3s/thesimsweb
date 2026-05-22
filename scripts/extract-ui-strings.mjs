#!/usr/bin/env node
// Walk the TS1 GameData IFF files, parse every STR# (and CTSS) chunk, and
// emit per-source JSON files under server/assets/converted/strings/ so the
// client can hydrate authentic FR/EN labels at boot without bundling a WASM
// IFF parser.
//
// Output shape per source file:
//   {
//     source: "Live.iff",
//     sets: [
//       { id: 130, label: "Motives", version: -3,
//         langs: { "1": ["Hunger", ...], "3": ["Faim", ...] } },
//       ...
//     ]
//   }
//
// Each language is keyed by its 1-byte code (1=EN, 3=FR, 4=DE, 5=IT, 6=ES, ...).
//
// Usage:  node scripts/extract-ui-strings.mjs

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectStringSets } from "./lib/iff-strings.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const GAMEDATA = join(REPO, "server/assets/Sims/GameData");
const OUT_DIR = join(REPO, "server/assets/converted/strings");

const SOURCES = [
  "Live.iff",
  "Build.iff",
  "UIText.iff",
  "Behavior.iff",
  "fame.iff",
  "magic.iff",
];

mkdirSync(OUT_DIR, { recursive: true });

const summary = [];
for (const name of SOURCES) {
  const path = join(GAMEDATA, name);
  let buf;
  try {
    buf = readFileSync(path);
  } catch (e) {
    console.error(`skip ${name}: ${e.message}`);
    continue;
  }
  const sets = collectStringSets(buf).map((s) => {
    const langs = {};
    for (const [k, v] of Object.entries(s.byLang)) langs[k] = v;
    return { id: s.id, label: s.label, kind: s.kind, version: s.version, langs };
  });
  const outName = name.replace(/\.iff$/i, ".json");
  const outPath = join(OUT_DIR, outName);
  writeFileSync(outPath, JSON.stringify({ source: name, sets }, null, 2));
  const langCounts = new Map();
  for (const s of sets) {
    for (const [k, v] of Object.entries(s.langs)) {
      langCounts.set(k, (langCounts.get(k) ?? 0) + v.length);
    }
  }
  const sample = sets.find((s) => s.langs["3"]?.length)?.langs["3"]?.[0];
  console.log(
    `${name}: ${sets.length} sets → ${outName}` +
      `   langs: ${[...langCounts.entries()].map(([k, n]) => `${k}=${n}`).join(", ")}` +
      (sample ? `   FR sample: "${sample.slice(0, 40)}"` : ""),
  );
  summary.push({ source: name, sets: sets.length, file: outName });
}

writeFileSync(join(OUT_DIR, "index.json"), JSON.stringify({ generatedAt: new Date().toISOString(), sources: summary }, null, 2));
console.error(`wrote ${summary.length} JSONs + index.json to ${OUT_DIR}`);
