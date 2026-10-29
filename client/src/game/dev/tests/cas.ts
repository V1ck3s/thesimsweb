/**
 * Dev test: Create-a-Sim / family screens without going through the
 * neighborhood.
 *
 *   game.html?test=cas                    cWinPickFamily (UserData3)
 *   game.html?test=cas&screen=family      cWinDesignFamily
 *   game.html?test=cas&screen=char        cWinDesignCharacter (a new person, saved on Done)
 *   game.html?test=cas&screen=credits     cWinCredits
 *   &dir=UserData2                        another neighborhood
 *
 * The screens write through the save overlay (server/data/overlay).
 */

import { CasSession } from "../../cas/personfinder.js";
import { WinDesignCharacter } from "../../cas/windesigncharacter.js";
import { WinDesignFamily } from "../../cas/windesignfamily.js";
import { WinPickFamily } from "../../cas/winpickfamily.js";
import { WinCredits } from "../../nbhd/wincredits.js";
import type { GameContext } from "../../context.js";
import { NeighborhoodStore } from "../../data/nbhdstore.js";
import { DefaultTTWindow } from "../../ui/ttwindow.js";
import type { TSWin } from "../../ui/tswin.js";
import type { WinMgr } from "../../ui/winmgr.js";

export async function mount(ctx: GameContext, mgr: WinMgr): Promise<void> {
  mgr.setDefaultTTWindow(await DefaultTTWindow.create(ctx.fonts));
  const params = new URLSearchParams(location.search);
  const dir = params.get("dir") ?? "UserData3";
  const screen = params.get("screen") ?? "pick";
  const log: string[] = [];
  const probe: { log: string[]; dir: string; dlg?: TSWin } = { log, dir };
  (window as unknown as { __cas: unknown }).__cas = probe;

  let dlg: TSWin;
  if (screen === "credits") {
    dlg = new WinCredits(ctx);
  } else if (screen === "pick") {
    const pick = new WinPickFamily(ctx, dir);
    pick.magicTown = params.has("magic");
    pick.setOwner({ moveIn: (id) => log.push(`move in ${id}`) });
    dlg = pick;
  } else {
    const session = new CasSession(await NeighborhoodStore.open(dir), ctx.res);
    if (screen === "family") {
      const fam = new WinDesignFamily(ctx, session);
      fam.setMessageTarget({ familyDesigned: (id) => log.push(`family ${id}`) });
      dlg = fam;
    } else {
      const ch = new WinDesignCharacter(ctx, session);
      ch.setMessageTarget({
        personDesigned: (p) => {
          log.push(`person ${p.fileName} ${p.firstName}`);
          void session.store.save();
        },
      });
      dlg = ch;
    }
  }
  probe.dlg = dlg;
  dlg.setArea(0, 0, ctx.width, ctx.height);
  if (!(await dlg.init())) throw new Error(`${screen} init failed`);
  log.push("ready");
  const result = await mgr.doModalWin(dlg);
  log.push(`closed ${result}`);
}
