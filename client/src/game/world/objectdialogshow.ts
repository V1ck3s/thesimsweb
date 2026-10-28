/**
 * ObjectDialog::Show / SetupDialog: the generic object dialog
 * (sim/objectdialog.ts) as a cWinPictureDialog (cTSObjectDialog), run by
 * DoSimsModalDialog (the simulation is held meanwhile).
 *
 * SetupDialog: title (unless the tutorial guide), picture, a button with
 * the first text (id 2) or a close box (id 2) when the dialog has no button
 * (+0x39 clear), button 3 for types 1 / 2, button 4 for type 2, the
 * message, an edit box (999) for type 3, a 40 s timeout on the last button
 * except for types 3 / 4, Enter = 2, Escape = the last button, Space = 2
 * when there is only one button.
 */

import type { GameContext } from "../context.js";
import { holdSimulator } from "../nbhd/transit.js";
import { decodeImage } from "../res/bmp.js";
import type { DialogHooks, DialogIcon, ObjectDialog } from "../sim/objectdialog.js";
import type { Simulator } from "../sim/simulator.js";
import { WinPhoneBook } from "../ui/phonebook.js";
import { WinPictureDialog } from "../ui/picturedialog.js";

async function iconImage(icon: DialogIcon | null): Promise<ImageBitmap | null> {
  if (!icon || icon.kind === "neighbor") return null; // PersonFinder::GetPictureBuffer: not ported
  // Product::DrawIcon: the catalog BMP_ (same id as the catalog strings); mode 3: BMP_ 5000 + n.
  const sel = icon.selector;
  const id = icon.kind === "bmp" ? icon.id : sel.objd.i16(0x52);
  const bytes = sel.res.get("BMP_", id);
  if (!bytes) return null;
  try {
    const img = decodeImage(bytes, "icon.bmp");
    return await createImageBitmap(new ImageData(img.data, img.width, img.height));
  } catch {
    return null;
  }
}

async function show(ctx: GameContext, d: ObjectDialog): Promise<void> {
  if (d.state !== 0) return; // aborted while waiting for its turn
  const w = new WinPictureDialog(ctx);
  d.state = 1;
  {
    w.setTitle(d.title);
    w.setImage(await iconImage(d.icon));
    let last = 2;
    let single = true;
    if (d.modal) w.addButton(d.buttons[0], 2);
    else w.addCloseBox(2);
    if (d.type === 1 || d.type === 2) {
      w.addButton(d.buttons[1], 3);
      last = 3;
      single = false;
    }
    if (d.type === 2) {
      w.addButton(d.buttons[2], 4);
      last = 4;
    }
    w.addText(d.message);
    if (d.type === 3) w.addEditBox("", 999);
    if (d.type !== 3 && d.type !== 4) w.setTimeout(last, 40000);
    w.setKey(2, 0x0d);
    w.setKey(last, 0x1b);
    if (single) w.setKey(2, 0x20);
    d.close = () => w.close();
    const id = await w.run();
    if (d.state === 1) d.btnPressed(id, w.getEditedText());
  }
}

/**
 * The SimModule's dialog hooks for a lot. PostSim shows the queued dialogs
 * one after the other, each run by DoSimsModalDialog before the next tick:
 * the simulation is held from the moment a dialog is queued until it is
 * closed, and the next one opens only then.
 */
export function objectDialogHooks(ctx: GameContext, sim: Simulator): DialogHooks {
  let chain: Promise<void> = Promise.resolve();
  const serial = (fn: () => Promise<void>): void => {
    const release = holdSimulator(sim);
    chain = chain
      .then(fn)
      .catch((e: unknown) => console.error("[dialog]", e))
      .finally(release);
  };
  return {
    uiString: (set, n) => (n >= 1 ? ctx.strings.get("UIText", set, n - 1) : ""),
    show: (d) => serial(() => show(ctx, d)),
    showPhoneBook: (caller) =>
      new Promise<number>((resolve) => {
        serial(async () => {
          const nb = sim.module.nbhd;
          if (!nb) {
            resolve(0);
            return;
          }
          let sel = 0;
          try {
            const w = new WinPhoneBook(ctx, nb, caller);
            await w.run();
            sel = w.getSelected();
          } finally {
            resolve(sel);
          }
        });
      }),
  };
}
