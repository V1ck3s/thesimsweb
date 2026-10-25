/**
 * VBAnimMgr::LoadAnimationFromFile / LoadAnimationFromStream: one CMX file
 * (binary ".cmx.bcf" or text ".cmx") holds three counted lists:
 *
 *   skeletonCount, Skeleton[]   suitCount, Suit[]   skillCount, Skill[]
 *
 * Text files start with a "// Character File..." comment and a "version 300"
 * line, then the same fields one per line (names) or whitespace-separated
 * (numbers).
 */

import { CTGFile, TextStream } from "./ctgfile.js";
import { Skeleton } from "./skeleton.js";
import { Skill } from "./skill.js";
import { Suit } from "./suit.js";

export interface AnimFile {
  skeletons: Skeleton[];
  suits: Suit[];
  skills: Skill[];
}

export function loadAnimationFromFile(bytes: Uint8Array): AnimFile {
  const f = new CTGFile(bytes);
  const out: AnimFile = { skeletons: [], suits: [], skills: [] };
  let n = f.readInteger();
  for (let i = 0; i < n; i++) out.skeletons.push(Skeleton.read(f));
  n = f.readInteger();
  for (let i = 0; i < n; i++) out.suits.push(Suit.read(f));
  n = f.readInteger();
  for (let i = 0; i < n; i++) out.skills.push(Skill.read(f));
  return out;
}

export function loadAnimationFromStream(bytes: Uint8Array): AnimFile {
  const text = new TextDecoder("latin1").decode(bytes);
  // Drop the comment header and the version line.
  const body = text
    .split(/\r?\n/)
    .filter((l, i) => !(l.trimStart().startsWith("//") || (i < 3 && /^version\b/i.test(l.trim()))))
    .join("\n");
  const s = new TextStream(body);
  const out: AnimFile = { skeletons: [], suits: [], skills: [] };
  let n = s.int();
  for (let i = 0; i < n; i++) out.skeletons.push(Skeleton.scan(s));
  n = s.int();
  for (let i = 0; i < n; i++) out.suits.push(Suit.scan(s));
  n = s.int();
  for (let i = 0; i < n; i++) out.skills.push(Skill.scan(s));
  return out;
}

/**
 * The animation index (".ndx", VBAnimMgr::LoadIndexFromFile): three counted
 * lists of (name, cmx file) for skeletons, suits and skills.
 */
export interface AnimIndex {
  skeletons: Array<[string, string]>;
  suits: Array<[string, string]>;
  skills: Array<[string, string]>;
}

export function loadIndexFromFile(bytes: Uint8Array): AnimIndex {
  const f = new CTGFile(bytes);
  const list = (): Array<[string, string]> => {
    const n = f.readInteger();
    const l: Array<[string, string]> = [];
    for (let i = 0; i < n; i++) {
      const name = f.readString();
      l.push([name, f.readString()]);
    }
    return l;
  };
  const skeletons = list();
  const suits = list();
  return { skeletons, suits, skills: list() };
}
