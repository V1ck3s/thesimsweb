/**
 * The sound side of SAnimator::HandleVitaBoyAnimEvent: the "sound",
 * "selectedsound", "deselectedsound" and "footstep" time props of the
 * person's animations, and SAnimator::GetFootSound. They play through
 * cSoundPlayer::PlayBySource (cBoxX event mapping, then the HIT tracks of
 * cHitMan) with the person's object id as the source, so they are placed
 * on the lot like the objects' sounds.
 */

import { soundPlayer } from "../audio/soundplayer.js";
import { UI_SOURCE } from "../audio/uisound.js";
import type { PersonSim } from "./person.js";
import { placementContainer, tileObjects } from "./routing.js";

/** What the sound events read from the lot view: FloorGraphicsMgr::GetFloorSound (set by the lot view). */
export const animSoundEnv: { floorSound: ((pattern: number) => number) | null } = { floorSound: null };

/** HandleVitaBoyAnimEvent's footstep events by GetFootSound kind 1..11 ([shoes, barefoot]). */
const FOOTSTEPS: ReadonlyArray<readonly [string, string]> = [
  ["", ""],
  ["footstep_hard", "footstep_hard_noshoe"],
  ["footstep_hard", "footstep_hard_noshoe"],
  ["footstep_medium", "footstep_medium_noshoe"],
  ["footstep_soft", "footstep_soft_noshoe"],
  ["footstep_medium", "footstep_medium_noshoe"],
  ["footstep_plant", "footstep_plant"],
  ["footstep_trash", "footstep_trash"],
  ["footstep_ash", "footstep_ash"],
  ["footstep_roach", "footstep_roach"],
  ["footstep_puddle", "footstep_puddle"],
  ["footstep_pool_swim_stroke", "footstep_pool_swim_stroke"],
];

/** GetFootSound's objects (by GUID) and the kind they make a tile: plants 6, trash 7, ashes 8, roaches 9, puddles 10. */
const FOOT_OBJECTS = new Map<number, number>([
  [0xa2daa08c | 0, 6],
  [0x96e3398d | 0, 6],
  [0xc02b406a | 0, 6],
  [0x65274a4f, 6],
  [0xbf62f653 | 0, 7],
  [0x7f907075, 7],
  [0x63416ba1, 8],
  [99999999, 9],
  [0x9be030b9 | 0, 10],
  [0x5c67fc8f, 10],
  [0x3e7470f6, 10],
]);

/**
 * SAnimator::GetFootSound(n, tile): what the tile under a foot is made of.
 * The highest kind among the objects standing on it (not in a container),
 * else a pool deck 1 (hard), the pool 11 (swimming), no floor 0 (terrain),
 * floor 0xff 2 (hard), or the floor pattern's sound: 0 medium (3),
 * 1 hard (2), 2 soft (4), 3 hard (1). (Its water test reads level 0,
 * which no person is on.)
 */
export function getFootSound(p: PersonSim, x: number, y: number, level: number): number {
  const m = p.module;
  const fixed = m.sim.world;
  if (!fixed || level < 1 || level > 2 || fixed.outOfGrid(x, y)) return 0;
  let kind = 0;
  for (const o of tileObjects(m, x, y, level)) {
    if (placementContainer(m, o) !== null) continue;
    const k = FOOT_OBJECTS.get(o.obj.selector.guid | 0) ?? 0;
    if (kind < k) kind = k;
  }
  if (kind !== 0) return kind;
  const deck = fixed.hasPoolOrDeck(x, y, level);
  const pool = fixed.hasPool(x, y, level);
  if (deck && !pool) return 1;
  if (pool) return 11;
  const floor = fixed.floors[level - 1]!.u16(x, y);
  if (floor === 0xff) return 2;
  if (floor === 0) return 0;
  const s = animSoundEnv.floorSound?.(floor) ?? 2;
  return s === 2 ? 4 : s === 0 ? 3 : s === 1 ? 2 : s === 3 ? 1 : 0;
}

/** cXPerson::IsSelected (+0x114 bit 1): the control panel's selected family member. */
function isSelected(p: PersonSim): boolean {
  const info = p.module.sim.state?.personGetSelected();
  return !!info && info.guid !== undefined && (info.guid | 0) === (p.obj.selector.guid | 0);
}

/** cXObject::IsInWorld: on a tile of the lot. */
function isInWorld(p: PersonSim): boolean {
  const fixed = p.module.sim.world;
  if (!fixed) return false;
  const x = p.obj.fx >> 4;
  const y = p.obj.fy >> 4;
  return x >= 1 && y >= 1 && x < fixed.size - 1 && y < fixed.size - 1;
}

/**
 * HandleVitaBoyAnimEvent's sound props (`forward`: the practice plays
 * forward). "sound" plays on the person (out of the world: pets only, as a
 * UI sound); "selectedsound" / "deselectedsound" only when the person is /
 * is not selected; "footstep" n (1, 2 forward; -1, -2 backward) plays the
 * tile's footstep (barefoot in outfits 1, 2, 5, 6 and 14; snow on houses
 * 40..42, soft on house 99) unless the person walks through a portal
 * (person data 84 / 68 bit 0) or person data 74 has bit 3.
 */
export function handleAnimSound(p: PersonSim, key: string, value: string, forward: boolean): void {
  const pd = p.pd;
  const n = Number.parseInt(value, 10) || 0;
  switch (key) {
    case "sound":
      if (isInWorld(p)) soundPlayer.playBySource(value, p.id);
      else if (pd[0x41]! > 1) soundPlayer.playBySource(value, UI_SOURCE);
      break;
    case "selectedsound":
      if (isSelected(p)) soundPlayer.playBySource(value, p.id);
      break;
    case "deselectedsound":
      if (!isSelected(p)) soundPlayer.playBySource(value, p.id);
      break;
    case "footstep": {
      const a = p.animator;
      if (!(Math.abs(a.gridX + 999) > 1e-6)) break;
      if (a.gridX < 0 || a.gridY < 0) break;
      const kind = getFootSound(p, Math.trunc(0.5 + a.gridX) >> 4, Math.trunc(0.5 + a.gridY) >> 4, p.obj.level);
      const suit = pd[8]! - 1;
      const noshoe = suit >= 0 && suit < 0xe && ((1 << suit) & 0x2013) !== 0;
      let name: string;
      if (kind >= 1 && kind <= 11) name = FOOTSTEPS[kind]![noshoe ? 1 : 0];
      else {
        const house = p.module.sim.globals[10]!;
        if (house >= 0x28 && house <= 0x2a) name = "footstep_snow";
        else if (house === 99) name = noshoe ? "footstep_soft_noshoe" : "footstep_soft";
        else name = noshoe ? "footstep_terrain_noshoe" : "footstep_terrain";
      }
      if ((pd[84]! & 1) === 1 || (pd[68]! & 1) === 1 || pd[74]! & 8) break;
      if (forward ? n === 1 || n === 2 : n === -1 || n === -2) soundPlayer.playBySource(name, p.id);
      break;
    }
    default:
      break;
  }
}
