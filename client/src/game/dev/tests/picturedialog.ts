/**
 * Dev test: cWinPictureDialog.
 *
 *   game.html?test=picturedialog            title, picture, long text, Yes / No
 *   game.html?test=picturedialog&edit=1     plus an edit box, a close box and a 10 s timeout
 *
 * The pressed button id is shown in window.__pd.
 */

import type { GameContext } from "../../context.js";
import { IDNO, IDYES } from "../../ui/msgbox.js";
import { WinPictureDialog } from "../../ui/picturedialog.js";
import { rgb } from "../../ui/syscolors.js";
import { Gfx, TSWin } from "../../ui/tswin.js";
import type { WinMgr } from "../../ui/winmgr.js";

class Backdrop extends TSWin {
  override tsPaint(g: Gfx): void {
    g.fill(0, 0, this.getW(), this.getH(), rgb(0x30, 0x48, 0x60));
  }
}

const TEXT =
  "Bonjour ! Je suis votre nouveau voisin. Je passais simplement par là pour vous souhaiter la bienvenue dans le quartier. " +
  "Voulez-vous que je vous présente aux autres habitants de la rue ? Ils sont tous très sympathiques, enfin presque tous.";

export async function mount(ctx: GameContext, mgr: WinMgr): Promise<void> {
  const root = new Backdrop();
  root.setArea(0, 0, ctx.width, ctx.height);
  mgr.main.childAdd(root);
  const params = new URLSearchParams(location.search);
  const state: { results: number[]; edited: string[] } = { results: [], edited: [] };
  (window as unknown as { __pd: unknown }).__pd = state;

  const picture = await ctx.res.image(Number(params.get("pic") ?? 5305)).catch(() => null);
  for (;;) {
    const d = new WinPictureDialog(ctx);
    d.setTitle("Visite d'un voisin");
    d.setImage(picture);
    d.addText(TEXT);
    d.addButton(ctx.strings.get("UIText", 152, 2), IDYES);
    d.addButton(ctx.strings.get("UIText", 152, 3), IDNO);
    d.setKey(IDYES, 0x0d);
    d.setKey(IDNO, 0x1b);
    if (params.get("edit")) {
      d.addEditBox("Bob Pataterre", 999);
      d.addCloseBox(IDNO);
      d.setTimeout(IDNO, 10000);
    }
    d.onButton = (id) => console.log(`button ${id}`);
    const id = await d.run();
    state.results.push(id);
    state.edited.push(d.getEditedText());
  }
}
