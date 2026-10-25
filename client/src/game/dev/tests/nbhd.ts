/**
 * Dev test: the neighborhood screen (cWinNeighborhoodUL) full screen.
 * `?test=nbhd&dir=UserData2` opens another neighborhood; Previous / Next rebuild
 * the screen like cSimsApp::DoNbhdScreen.
 */

import type { GameContext } from "../../context.js";
import { Neighborhood } from "../../nbhd/nghinterface.js";
import { WinNeighborhoodUL } from "../../nbhd/winneighborhoodul.js";
import type { WinMgr } from "../../ui/winmgr.js";

export async function mount(ctx: GameContext, mgr: WinMgr): Promise<void> {
  const show = async (dir: string): Promise<void> => {
    const nb = await Neighborhood.load(dir);
    const screen: WinNeighborhoodUL = new WinNeighborhoodUL(ctx, nb, {
      onEnterLot: (house) => console.log(`onEnterLot(${house})`),
      onEndModal: (result) => console.log(`neighborhood screen ended: ${result}`),
      onSwitchNeighborhood: (next) => {
        mgr.main.childDelete(screen);
        void show(next);
      },
      onUnported: (what) => console.log(`not ported: ${what}`),
    });
    screen.setArea(0, 0, ctx.width, ctx.height);
    if (!(await screen.init())) throw new Error("neighborhood init failed");
    mgr.main.childAdd(screen);
    (window as unknown as { nbhdScreen: WinNeighborhoodUL }).nbhdScreen = screen;
  };
  await show(new URLSearchParams(location.search).get("dir") ?? "UserData");
}
