/**
 * Test page for WinPeople (Live mode panel): mounts the full control panel like
 * the game shell does, in Live mode, with the house 1 family of the
 * neighborhood (Fez: Kyle, Jada, Max) as the active family. Person data,
 * faces and relationships come from the save; motives are made up.
 *
 * Keys: 1..3 select a family member, M randomizes motives.
 */

import { CPANEL_HEIGHT, WinCPanel } from "../../cpanel/cpanel.js";
import { DIRTY_ALL, Mode } from "../../cpstate.js";
import type { GameContext } from "../../context.js";
import { activateFamily } from "../../data/family.js";
import { loadNeighborhood } from "../../data/neighborhood.js";
import { TSWin } from "../../ui/tswin.js";
import type { WinMgr } from "../../ui/winmgr.js";

/** Motives by game motive number: 3 = mood, then the eight needs. */
function makeMotives(seed: number): number[] {
  const m = new Array<number>(16).fill(0);
  const needs = [5, 6, 7, 8, 9, 13, 14, 15];
  needs.forEach((k, i) => {
    m[k] = Math.round(100 * Math.sin(seed * 2.3 + i * 1.7));
  });
  m[3] = Math.round(needs.reduce((s, k) => s + m[k]!, 0) / needs.length);
  return m;
}

export async function mount(ctx: GameContext, mgr: WinMgr): Promise<void> {
  const s = ctx.state;
  const fam = await activateFamily(s, await loadNeighborhood(), 1);
  s.family.forEach((p, i) => (p.motives = makeMotives(i + 1)));

  const view = new TSWin();
  view.setArea(0, 0, ctx.width, ctx.height);
  mgr.main.childAdd(view);
  const cpanel = new WinCPanel(ctx);
  cpanel.setArea(0, ctx.height - CPANEL_HEIGHT, ctx.width, ctx.height);
  if (!(await cpanel.init())) throw new Error("control panel init failed");
  view.childAdd(cpanel);
  cpanel.postInit();

  s.setMode(Mode.Live, true);
  s.setCPMode(0);
  s.setSelectedPerson(0);
  s.dirty = DIRTY_ALL;
  s.setFunds(fam?.budget ?? 20000);
  // No source in the neighborhood file for these yet (house scores, friends).
  s.familyFriendCount = 3;
  s.houseFamilyFriendCount = 3;
  s.houseStats = {
    sizeScore: 55,
    furnishingsScore: 100,
    yardScore: 5,
    upkeepScore: 80,
    layoutScore: 33,
    squareFeet: 1500,
    numBedrooms: 2,
    numBathrooms: 1,
    lotSize: 1,
  };

  let seed = 1;
  window.addEventListener("keydown", (e) => {
    if (e.key >= "1" && e.key <= "8") s.setSelectedPerson(Number(e.key) - 1);
    if (e.key === "m") {
      seed++;
      s.family.forEach((p, i) => (p.motives = makeMotives(seed + i)));
      s.setDirty(0x1);
    }
  });
}
