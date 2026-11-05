/**
 * Dev test: Neighborhood::DoFirstTimeTownies / RefillTownies with their
 * cWinProgressPictureDialog, outside the neighborhood screen.
 *
 *   game.html?test=townies                 DoFirstTimeTownies on UserData3
 *   game.html?test=townies&refill=40       RefillTownies(40) instead
 *   game.html?test=townies&pools=1         the celebrity / fan / Makin' Magic pools (refillNpcPools)
 *   &dir=UserData2                         another neighborhood
 *
 * Writes through the save overlay (server/data/overlay).
 */

import type { GameContext } from "../../context.js";
import { NeighborhoodStore } from "../../data/nbhdstore.js";
import { doFirstTimeTownies, refillNpcPools, refillTownies, TOWNIE_FAMILY_ID } from "../../nbhd/townies.js";
import { DefaultTTWindow } from "../../ui/ttwindow.js";
import type { WinMgr } from "../../ui/winmgr.js";

export async function mount(ctx: GameContext, mgr: WinMgr): Promise<void> {
  mgr.setDefaultTTWindow(await DefaultTTWindow.create(ctx.fonts));
  const params = new URLSearchParams(location.search);
  const dir = params.get("dir") ?? "UserData3";
  const refill = Number(params.get("refill") ?? 0);
  const log: string[] = [];
  const state = { log, dir, done: false };
  (window as unknown as { __townies: unknown }).__townies = state;
  const store = await NeighborhoodStore.open(dir);
  log.push(`ngbh v${store.ngbh().version} townies ${store.ngbh().townies.join(",")}`);
  const t0 = performance.now();
  if (params.get("pools")) {
    await refillNpcPools(ctx, store);
    for (const id of [5000, 0x157c, 6000]) log.push(`family ${id}: ${store.familyMemberCount(id)} members ${(await store.familyMemberNames(id)).join(",")}`);
    log.push(`ngbh b1a0 ${store.ngbh().b1a0.join(",")} b1a4 ${store.ngbh().b1a4.join(",")}`);
    state.done = true;
    return;
  }
  if (refill) await refillTownies(ctx, store, refill);
  else await doFirstTimeTownies(ctx, store);
  log.push(`done in ${Math.round(performance.now() - t0)} ms`);
  log.push(`family ${TOWNIE_FAMILY_ID}: ${store.familyMemberCount(TOWNIE_FAMILY_ID)} members`);
  log.push(`ngbh townies ${store.ngbh().townies.join(",")}`);
  state.done = true;
}
