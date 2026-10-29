/**
 * Test page for the Live mode inventory page (cpanel/live/gifts.ts): the
 * house `?house=` family (default 1) of the neighborhood, its inventories
 * read from Neighborhood.iff. Logs every neighbor's token types.
 *
 * Keys: 1..8 select a family member, G / M / O pick a sort, [ / ] change pages.
 */

import type { GameContext } from "../../context.js";
import { WinLivePopupClient } from "../../cpanel/livepopup.js";
import { GiftsPanel } from "../../cpanel/live/gifts.js";
import { activateFamily } from "../../data/family.js";
import { loadNeighborhood } from "../../data/neighborhood.js";
import { Gfx, TSWin } from "../../ui/tswin.js";
import type { WinMgr } from "../../ui/winmgr.js";
import { ObjectFolder } from "../../world/objectfolder.js";

export async function mount(ctx: GameContext, mgr: WinMgr): Promise<void> {
  const house = Number(new URLSearchParams(location.search).get("house") ?? 1);
  const nbhd = await loadNeighborhood();
  for (const inv of nbhd.inventories) {
    const nb = nbhd.neighbors.find((n) => n.id === inv.neighborId);
    if (inv.tokens.length) console.log("inventory", inv.neighborId, nb?.name, JSON.stringify(inv.tokens.map((t) => [t.type, t.guid >>> 0, t.count])));
  }
  await activateFamily(ctx.state, nbhd, house);
  const folder = await ObjectFolder.get("UserData");
  GiftsPanel.source = {
    inventory: (guid) => {
      const nb = nbhd.neighbors.find((n) => (n.guid | 0) === (guid | 0));
      return nb ? (nbhd.inventories.find((x) => x.neighborId === nb.id) ?? null) : null;
    },
    selector: (guid) => folder.getSelectorByGUID(guid),
  };

  const bkg = await ctx.res.image("kUniversalCPBkg");
  const host = new (class extends TSWin {
    override tsPaint(g: Gfx): void {
      g.blitPart(bkg, 0, 0, this.getW(), 100, 0, 50);
    }
  })();
  host.setArea(220, ctx.height - 150, ctx.width, ctx.height);
  mgr.main.childAdd(host);
  const panel = new GiftsPanel(ctx, new WinLivePopupClient());
  if (!(await panel.init())) throw new Error("gifts init failed");
  host.childAdd(panel);
  let person = 0;
  const rebuild = (): void => panel.buildGifts(person);
  rebuild();
  // Gifts open their files asynchronously: repaint the list once they are in.
  setTimeout(rebuild, 3000);
  host.tsOnCommand = (_cmd, src): boolean => {
    if (src === panel.prevPage) panel.prev(person);
    else if (src === panel.nextPage) panel.next(person);
    else panel.sortPressed(src, person);
    return true;
  };
  window.addEventListener("keydown", (e) => {
    const n = Number(e.key);
    if (n >= 1 && n <= ctx.state.family.length) person = n - 1;
    const sort = { g: panel.giftSort, m: panel.magicSort, o: panel.otherSort }[e.key.toLowerCase()];
    if (sort) {
      sort.setState(1);
      panel.sortPressed(sort, person);
      return;
    }
    if (e.key === "[") panel.prev(person);
    else if (e.key === "]") panel.next(person);
    else rebuild();
  });
  (window as unknown as { gifts: GiftsPanel }).gifts = panel;
}
