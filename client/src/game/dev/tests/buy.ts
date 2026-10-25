/**
 * Test page for WinCatalog (buy mode): mounts the full control panel like the
 * game shell does, with the house 1 family of the neighborhood, in Buy mode.
 *
 * Keys: R / F sort by room / by function, D / V / C / T / M the downtown,
 * vacation, community, studio town and magic town sorts, B back to the books,
 * 0..7 open a book, L sets the funds to $50, S "sells" the picked product
 * (CPState.shopSoldItem, what the lot view calls after placing it). The picked
 * product is logged.
 */

import { CPANEL_HEIGHT, WinCPanel } from "../../cpanel/cpanel.js";
import { CatalogSort, CatalogSortState, DIRTY_ALL, DIRTY_SHOP_ITEM, Mode } from "../../cpstate.js";
import type { GameContext } from "../../context.js";
import { loadCatalog } from "../../data/catalog.js";
import { activateFamily } from "../../data/family.js";
import { loadNeighborhood } from "../../data/neighborhood.js";
import { TSWin } from "../../ui/tswin.js";
import type { WinMgr } from "../../ui/winmgr.js";

export async function mount(ctx: GameContext, mgr: WinMgr): Promise<void> {
  const s = ctx.state;
  const fam = await activateFamily(s, await loadNeighborhood(), 1);

  const view = new TSWin();
  view.setArea(0, 0, ctx.width, ctx.height);
  mgr.main.childAdd(view);
  const cpanel = new WinCPanel(ctx);
  cpanel.setArea(0, ctx.height - CPANEL_HEIGHT, ctx.width, ctx.height);
  if (!(await cpanel.init())) throw new Error("control panel init failed");
  view.childAdd(cpanel);
  cpanel.postInit();

  s.setMode(Mode.Buy, true);
  s.setCPMode(0);
  s.dirty = DIRTY_ALL;
  s.setFunds(fam?.budget ?? 20000);

  const t0 = performance.now();
  void loadCatalog().then((c) => console.log(`catalog: ${c.products.length} products in ${Math.round(performance.now() - t0)} ms`));

  s.onChange((st) => {
    if (st.dirty & DIRTY_SHOP_ITEM) {
      const p = st.shopGetCatalogItem();
      console.log("shop item", st.shopGetCatalogItemIndex(), p ? `${p.getProductName()} ${p.getPrice()} guid ${p.guid.toString(16)}` : null);
    }
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "r") s.shopSetSort(CatalogSort.Room);
    if (e.key === "f") s.shopSetSort(CatalogSort.Function);
    if (e.key === "d") s.shopSetSort(CatalogSort.Downtown);
    if (e.key === "v") s.shopSetSort(CatalogSort.Vacation);
    if (e.key === "c") s.shopSetSort(CatalogSort.Community);
    if (e.key === "t") s.shopSetSort(CatalogSort.Studiotown);
    if (e.key === "m") s.shopSetSort(CatalogSort.Magictown);
    if (e.key === "l") s.setFunds(50);
    if (e.key === "b") s.shopSetSortState(CatalogSortState.Books);
    if (e.key >= "0" && e.key <= "7") {
      s.shopSetSortState(CatalogSortState.Items);
      s.shopSetCatalog(Number(e.key));
    }
    if (e.key === "s") s.shopSoldItem();
  });
}
