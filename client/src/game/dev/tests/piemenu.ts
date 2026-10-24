/**
 * Dev test: the Live mode pie menu. Left click: 8 items (with 2 stacked
 * extras), right click: 3 items; Shift+click opens a submenu-style pie with a
 * title (also forced by `&title`). The pick is logged and shown at the bottom.
 */

import type { GameContext } from "../../context.js";
import { TSWinCtrlMgr } from "../../ui/ctrlmgr.js";
import { TSPieMenu } from "../../ui/piemenu.js";
import { rgb } from "../../ui/syscolors.js";
import { TSWinText, WTF_MULTILINE } from "../../ui/text.js";
import { Gfx, TSWin } from "../../ui/tswin.js";
import type { WinMgr } from "../../ui/winmgr.js";

const MANY = ["Parler", "Embrasser", "Chatouiller", "Câliner", "Complimenter", "Taquiner", "Danser", "Serrer la main", "Raconter une blague", "Se vanter"];
const FEW = ["Aller ici", "Courir ici", "Appeler ici"];
const SUB = ["Météo", "Sport", "Argent"];

class Lot extends TSWin {
  constructor(private readonly onClick: (x: number, y: number, right: boolean) => void) {
    super();
  }

  override tsPaint(g: Gfx): void {
    g.fill(0, 0, this.getW(), this.getH(), rgb(0x3a, 0x6a, 0x3a));
  }

  override tsOnMouseDownL(x: number, y: number): boolean {
    this.onClick(x, y, false);
    return true;
  }

  override tsOnMouseDownR(x: number, y: number): boolean {
    this.onClick(x, y, true);
    return true;
  }
}

export async function mount(ctx: GameContext, mgr: WinMgr): Promise<void> {
  const cm = await TSWinCtrlMgr.get(ctx);
  const pie = await TSPieMenu.forLiveMode(ctx);
  const status = new TSWinText();
  status.setFont(cm.systemFont(0));
  status.setBackgroundOpaque(false);
  status.setWinTextFlag(WTF_MULTILINE, false);
  status.setArea(20, 740, 600, 762);
  status.setCaption("click: 10 items, right click: 3 items");

  const forceTitle = new URLSearchParams(location.search).has("title");
  let shift = forceTitle;
  window.addEventListener("keydown", (e) => (shift = forceTitle || e.shiftKey));
  window.addEventListener("keyup", (e) => (shift = forceTitle || e.shiftKey));

  const lot = new Lot((x, y, right) => {
    const items = shift ? SUB : right ? FEW : MANY;
    pie.title = shift ? "Parler" : "";
    pie.show(x, y, items, (i) => {
      const s = i < 0 ? "cancelled" : `picked ${i}: ${items[i]}`;
      status.setCaption(s);
      console.log(s);
    });
  });
  lot.setArea(0, 0, ctx.width, ctx.height);
  mgr.main.childAdd(lot);
  lot.childAdd(status);
}
