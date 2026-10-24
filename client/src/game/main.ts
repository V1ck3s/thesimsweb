/**
 * Entry point of the faithful client: boots the window manager at the game's
 * resolution and mounts the game shell.
 */

import { readFarEntry } from "../engine/assets.js";
import { FfnFont } from "./res/ffn.js";
import { UIRes } from "./res/uires.js";
import { Gfx, TSWin } from "./ui/tswin.js";
import { WinMgr } from "./ui/winmgr.js";

const SCREEN_W = 1024;
const SCREEN_H = 768;

async function boot(): Promise<void> {
  const mgr = new WinMgr(document.getElementById("screen")!, SCREEN_W, SCREEN_H);
  const res = await UIRes.load();
  const font = new FfnFont(await readFarEntry("Sims/UIGraphics/UIGraphics.far", "Fonts\\variablesans_12.ffn"));
  const bkg = await res.image("kUniversalCPBkg");
  const gauge = await res.image("kLiveModeGauge");

  class Probe extends TSWin {
    override tsPaint(g: Gfx): void {
      g.tileX(bkg, 0, SCREEN_H - bkg.height, SCREEN_W);
      g.blit(gauge, 0, SCREEN_H - gauge.height);
      font.drawText(g.ctx, "Appétit Énergie Confort — Les Sims", 20, 20, "#ffd700");
    }
  }
  const probe = new Probe();
  probe.setArea(0, 0, SCREEN_W, SCREEN_H);
  mgr.main.childAdd(probe);
  mgr.start();
}

boot().then(() => console.log("boot ok"), (e: unknown) => console.error("boot failed", e));
