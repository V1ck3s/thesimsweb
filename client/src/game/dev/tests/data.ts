/** Dev test: decode the neighborhood and log families with their members. */

import type { GameContext } from "../../context.js";
import { familyInHouse, loadCharacter, loadNeighborhood, neighborByGuid, PD } from "../../data/neighborhood.js";
import type { WinMgr } from "../../ui/winmgr.js";

export async function mount(_ctx: GameContext, _mgr: WinMgr): Promise<void> {
  const n = await loadNeighborhood();
  console.log(`neighbors=${n.neighbors.length} families=${n.families.length}`);
  for (const f of n.families.filter((f) => f.houseNumber > 0)) {
    const members = [];
    for (const g of f.memberGuids) {
      const nb = neighborByGuid(n, g);
      if (!nb) continue;
      const c = await loadCharacter(n.dir, nb.name).catch(() => null);
      const pd = nb.personData;
      members.push(`${c?.firstName ?? nb.name}(age ${pd?.[PD.personAge]}, nice ${pd?.[PD.nicePersonality]}, cook ${pd?.[PD.cookingSkill]}, faces ${c?.bitmaps.size})`);
    }
    console.log(`house ${f.houseNumber} "${f.name}" budget=${f.budget} worth=${f.netWorth}: ${members.join(", ")}`);
  }
  console.log("house 1 family:", familyInHouse(n, 1)?.name);
}
