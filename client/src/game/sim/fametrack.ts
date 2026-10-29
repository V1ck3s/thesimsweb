/**
 * cFameTrack (Superstar's fame track), the part the simulation reads:
 * GetFameTrackData (lbl_105BA050) and cFameTrack::GetTitleFromLevel.
 *
 * cFameTrack::LoadUpFameTrackScoring reads GameData/fame.iff with
 * LoadUIStrings (the UI language): STR# 4 and 5 (11 numbers each), STR# 6
 * (11 lines "%d,%d,%d,%d,%d,%d") and STR# 1, whose entries 1..11 are the
 * titles of fame levels 0..10 (+0x60, entry 0 is skipped).
 *
 * cFameTrack::PromoteIfNeeded runs from generic sim call 34. A person's fame
 * lives in its person data: 0x50 the star points (PersonFinder::GetData
 * +0xa0), 0x51 the fame level (+0xa2), 0x52 the highest level reached (+0xa4).
 */

import { ResFile } from "../world/iffres.js";
import { loadUIStringSet } from "./behavior.js";

const LEVELS = 11;

/** The fame titles by level (cFameTrack +0x60), null when GameData/fame.iff is missing (no fame track). */
export async function loadFameTitles(): Promise<string[] | null> {
  const file = await ResFile.open("GameData/fame.iff").catch(() => null);
  const set = file ? loadUIStringSet(file, 1) : null;
  if (!set) return null;
  return Array.from({ length: LEVELS }, (_, i) => set[i + 1] ?? "");
}

/** cFameTrack::GetTitleFromLevel: "" outside 0..10 (lbl_105BB800 + 0x86). */
export function getTitleFromLevel(titles: readonly string[], level: number): string {
  return level >= 0 && level <= 10 ? (titles[level] ?? "") : "";
}

/** cFameTrack's scoring tables, by fame level 0..10. */
export interface FameScoring {
  /** +0 (STR# 5): the star points a level needs. */
  points: number[];
  /** +0xc (STR# 4): the famous friends a level needs. */
  friends: number[];
  /** +0x18 + k * 0xc (STR# 6, column k): skill k's level a level needs. */
  skills: number[][];
}

/** lbl_105BB7FC: the person data of the six skills of the fame track (cooking, mechanical, charisma, body, logic, creativity). */
const FAME_SKILLS = [10, 12, 11, 17, 18, 15];
/** lbl_105BB808: a famous friend counts half. */
const FRIEND_WEIGHT = 0.5;

/** The scoring part of cFameTrack::LoadUpFameTrackScoring (null without GameData/fame.iff). */
export async function loadFameScoring(): Promise<FameScoring | null> {
  const file = await ResFile.open("GameData/fame.iff").catch(() => null);
  if (!file) return null;
  const nums = (id: number): number[] => Array.from({ length: LEVELS }, (_, i) => parseInt(loadUIStringSet(file, id)?.[i] ?? "0", 10) || 0);
  const lines = loadUIStringSet(file, 6) ?? [];
  const skills = FAME_SKILLS.map((_, k) => Array.from({ length: LEVELS }, (_, i) => parseInt((lines[i] ?? "").split(",")[k] ?? "0", 10) || 0));
  return { points: nums(5), friends: nums(4), skills };
}

/**
 * cFameTrack::PromoteIfNeeded(person): one fame level more (and the highest
 * level raised) when the person is below level 10 and has the level's star
 * points, the skills (each skill's level, skill / 100 capped to 0..10, at
 * least the table's unless the raw skill already reaches it) and half its
 * famous friends (PersonFinder::GetFamousFriendCount) reaching the friends
 * needed. Returns whether it was promoted.
 */
export function promoteIfNeeded(t: FameScoring, pd: Int16Array, famousFriends: number): boolean {
  const level = pd[0x51]!;
  if (level >= 10) return false;
  const points = pd[0x50]!;
  const highest = pd[0x52]!;
  const need = t.points[level] ?? 0;
  let skillsOk = true;
  for (let k = 0; k < FAME_SKILLS.length; k++) {
    const skill = pd[FAME_SKILLS[k]!]!;
    let req = level >= 0 && level < 12 ? (t.skills[k]![level] ?? 0) : 0;
    if (req * 100 <= skill) req = 0;
    const have = Math.max(0, Math.min(10, Math.trunc(skill / 100)));
    if (have < req) {
      skillsOk = false;
      break;
    }
  }
  const friends = level >= 0 && level < 12 ? (t.friends[level] ?? 0) : 0;
  if (Math.fround(famousFriends * FRIEND_WEIGHT) < friends || !skillsOk || points < need) return false;
  pd[0x51] = level + 1;
  if (highest < level + 1) pd[0x52] = level + 1;
  return true;
}

/**
 * cFameTrack::DemoteIfNeeded(person): one fame level less when the person
 * is above level 0 and its star points (person data 0x50) fell below the
 * points of the level under it. Returns whether it was demoted.
 */
export function demoteIfNeeded(t: FameScoring, pd: Int16Array): boolean {
  const level = pd[0x51]!;
  if (level <= 0) return false;
  if (pd[0x50]! >= (t.points[level - 1] ?? 0)) return false;
  pd[0x51] = level - 1;
  return true;
}
