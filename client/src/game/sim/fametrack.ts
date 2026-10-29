/**
 * cFameTrack (Superstar's fame track), the part the simulation reads:
 * GetFameTrackData (lbl_105BA050) and cFameTrack::GetTitleFromLevel.
 *
 * cFameTrack::LoadUpFameTrackScoring reads GameData/fame.iff with
 * LoadUIStrings (the UI language): STR# 4 and 5 (11 numbers each), STR# 6
 * (11 lines "%d,%d,%d,%d,%d,%d") and STR# 1, whose entries 1..11 are the
 * titles of fame levels 0..10 (+0x60, entry 0 is skipped). Only the titles
 * are ported here.
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
