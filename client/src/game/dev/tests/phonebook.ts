/**
 * Dev test: CWinPhoneBook (the phone's "Call..." picker).
 *
 *   game.html?test=phonebook                  UserData, the first family member who knows someone outside the family
 *   game.html?test=phonebook&caller=12        another caller (neighbor id)
 *   &dir=UserData2                            another neighborhood
 *
 * Each run's GetSelected() is pushed to window.__pb.results (0 = cancelled);
 * the dialog opens again after each run.
 */

import type { GameContext } from "../../context.js";
import { loadNeighborhood, PD } from "../../data/neighborhood.js";
import { WinPhoneBook } from "../../ui/phonebook.js";
import { rgb } from "../../ui/syscolors.js";
import { Gfx, TSWin } from "../../ui/tswin.js";
import type { WinMgr } from "../../ui/winmgr.js";

class Backdrop extends TSWin {
  override tsPaint(g: Gfx): void {
    g.fill(0, 0, this.getW(), this.getH(), rgb(0x30, 0x48, 0x60));
  }
}

export async function mount(ctx: GameContext, mgr: WinMgr): Promise<void> {
  const root = new Backdrop();
  root.setArea(0, 0, ctx.width, ctx.height);
  mgr.main.childAdd(root);
  const params = new URLSearchParams(location.search);
  const nb = await loadNeighborhood(params.get("dir") ?? "UserData");
  let caller = Number(params.get("caller") ?? 0);
  if (!caller) {
    // A member of a family who has relationships with people of other families.
    for (const f of nb.families) {
      for (const g of f.memberGuids) {
        const n = nb.neighbors.find((x) => x.guid === g);
        const fam = n?.personData?.[PD.familyNumber] ?? 0;
        const others = n?.relationships.filter((r) => {
          const o = nb.neighbors.find((x) => x.id === r.other);
          return (o?.personData?.[PD.familyNumber] ?? 0) !== fam;
        });
        if (n && others && others.length > 0) {
          caller = n.id;
          break;
        }
      }
      if (caller) break;
    }
  }
  const state: { caller: number; results: number[]; open: boolean } = { caller, results: [], open: false };
  (window as unknown as { __pb: unknown }).__pb = state;
  for (;;) {
    const pb = new WinPhoneBook(ctx, nb, caller);
    state.open = true;
    await pb.run();
    state.open = false;
    state.results.push(pb.getSelected());
  }
}
