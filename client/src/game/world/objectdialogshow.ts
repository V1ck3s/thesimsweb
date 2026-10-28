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
import { loadPicture, WinPhoneBook } from "../ui/phonebook.js";
import { WinPictureDialog } from "../ui/picturedialog.js";
import type { Rect } from "../ui/tswin.js";
import { ObjectIcon } from "../cpanel/buy/objecticon.js";
import { loadCharacter } from "../data/neighborhood.js";
import { preloadEditPersonCatalog } from "../cas/editperson.js";
import { loadStringSet } from "../sim/behavior.js";
import type { SimObject } from "../sim/xobject.js";
import { WinClothingChoiceDlg, WinPetSelectDlg, WinTransformMeDlg, type PickedPerson } from "../ui/outfitdlg.js";
import { CWinMagicBook } from "../ui/magicbook.js";

/** PersonFinder's picture cell (45 x 45). */
const PERSON_CELL = 0x2d;

/** The picture SetParams made (ImageHandle +0x24) and its shown part (+0x28). */
interface DialogPicture {
  image: ImageBitmap;
  rect: Rect;
}

async function bitmapOf(bytes: Uint8Array | null | undefined): Promise<ImageBitmap | null> {
  if (!bytes) return null;
  try {
    const img = decodeImage(bytes, "icon.bmp");
    return await createImageBitmap(new ImageData(img.data, img.width, img.height));
  } catch {
    return null;
  }
}

const whole = (image: ImageBitmap, w = image.width, h = image.height): DialogPicture => ({ image, rect: { left: 0, top: 0, right: w, bottom: h } });

/** ObjectDialog::SetParams' picture part (the image making). */
async function iconImage(ctx: GameContext, sim: Simulator, icon: DialogIcon | null): Promise<DialogPicture | null> {
  if (!icon) return null;
  switch (icon.kind) {
    case "object": {
      // Product::DrawIcon: the catalog BMP_ (same id as the catalog strings).
      const img = await bitmapOf(icon.selector.res.get("BMP_", icon.selector.objd.i16(0x52)));
      return img ? whole(img) : null;
    }
    case "bmp": {
      // nsSMResFac::LoadBuffer(object file, id): mode 3 (BMP_ 5000 + n) and "my n".
      const img = await bitmapOf(icon.selector.res.get("BMP_", icon.id));
      return img ? whole(img) : null;
    }
    case "ui": {
      // nsSMResFac::LoadBuffer(id) with the color key; "gz": a quarter of the width.
      const img = await ctx.res.image(icon.id).catch(() => null);
      return img ? whole(img, icon.quarter ? img.width >> 2 : img.width) : null;
    }
    case "product": {
      // Product::ComposeBtnImage, 45 x 45 (drawn here with the catalog's object icon).
      const ic = await ObjectIcon.create(icon.selector.res, icon.selector.objdId).catch(() => null);
      if (!ic) return null;
      const c = document.createElement("canvas");
      c.width = PERSON_CELL;
      c.height = PERSON_CELL;
      ic.draw(c.getContext("2d")!, 0, 0, PERSON_CELL, PERSON_CELL);
      return whole(await createImageBitmap(c));
    }
    case "rel": {
      // PersonFinder::GetRelPictureBuffer: the relationship picture (BMP_ 2003, five heads), its middle fifth.
      const nb = sim.module.nbhd;
      const n = sim.module.findNeighborByGUID(icon.guid);
      if (!nb || !n) return null;
      const c = await loadCharacter(nb.dir, n.name).catch(() => null);
      const bytes = c?.bitmaps.get(2003);
      if (!bytes) return null;
      const img = decodeImage(bytes, "rel.bmp", { colorKey: true });
      const bmp = await createImageBitmap(new ImageData(img.data, img.width, img.height));
      const fifth = Math.trunc(bmp.width / 5);
      return { image: bmp, rect: { left: fifth * 2, top: 0, right: fifth * 3, bottom: bmp.height } };
    }
    case "job": {
      // cWinSubpanelJob::GetJobPopupComposite: kJobPopupComposite (+0x16c), 22 rows.
      const img = await ctx.res.image("kJobPopupComposite").catch(() => null);
      if (!img) return null;
      const rowH = Math.trunc(img.height / 0x16);
      return { image: img, rect: { left: 0, top: icon.row * rowH, right: img.width, bottom: (icon.row + 1) * rowH } };
    }
    case "person": {
      // PersonFinder::GetHandle(guid) + GetPictureBuffer: the person button picture, its first 45 x 45 cell.
      const nb = sim.module.nbhd;
      const n = sim.module.findNeighborByGUID(icon.guid);
      if (!nb || !n) return null;
      const c = await loadCharacter(nb.dir, n.name).catch(() => null);
      if (!c) return null;
      const template = await ctx.res.image("kPeopleTemplate");
      const img = await loadPicture(c.bitmaps.get(2002), template).catch(() => null);
      return img ? whole(img, PERSON_CELL, PERSON_CELL) : null;
    }
  }
}

async function show(ctx: GameContext, sim: Simulator, d: ObjectDialog): Promise<void> {
  if (d.state !== 0) return; // aborted while waiting for its turn
  const w = new WinPictureDialog(ctx);
  d.state = 1;
  {
    w.setTitle(d.title);
    const pic = await iconImage(ctx, sim, d.icon);
    if (pic) w.setImage(pic.image, pic.rect);
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
/** ObjSelector::GetBodyStrings of a person (with the run's edits) and its person data. */
function pickedPerson(sim: Simulator, o: SimObject): PickedPerson | null {
  if (!o.person) return null;
  const sel = o.obj.selector;
  const strings = sim.module.bodyStringEdits.get(sel.guid | 0) ?? loadStringSet(sel.res, sel.objd.i16(0x26));
  return strings ? { bodyStrings: strings, personData: o.person.personData } : null;
}

/** ObjectModule::PostSim: cWinClothingChoiceDlg / cWinTransformMeDlg / cWinPetSelectDlg, run modally. */
async function showPersonPicker(ctx: GameContext, sim: Simulator, kind: 6 | 9 | 0xe, o: SimObject, type: number): Promise<number> {
  const person = pickedPerson(sim, o);
  if (!person) return 0xffff;
  // sound: the dialog's two PlaySoundA (PostSim)
  const w = kind === 6 ? new WinClothingChoiceDlg(ctx, type, person) : kind === 0xe ? new WinTransformMeDlg(ctx, person) : new WinPetSelectDlg(ctx, person);
  return w.run();
}

export function objectDialogHooks(ctx: GameContext, sim: Simulator): DialogHooks {
  // TryGenericSimCall 24 (set a suit) needs the suit catalog synchronously.
  void preloadEditPersonCatalog().catch(() => undefined);
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
    show: (d) => serial(() => show(ctx, sim, d)),
    showPersonPicker: (kind, person, type) =>
      new Promise<number>((resolve) => {
        serial(async () => {
          let r = 0xffff;
          try {
            r = await showPersonPicker(ctx, sim, kind, person, type);
          } finally {
            resolve(r);
          }
        });
      }),
    showMagicBook: (person, cookbook) =>
      new Promise<void>((resolve) => {
        serial(async () => {
          try {
            await new CWinMagicBook(ctx, sim, person, cookbook).run();
          } finally {
            resolve();
          }
        });
      }),
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
