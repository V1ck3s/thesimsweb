/**
 * PersonFinder's picture part for any person selector: the family, the
 * neighbors and townies (<neighborhood>/Characters/), and the NPCs of
 * GameData/Objects/People (pizza dude, maid, ...), which have no file in
 * Characters/. PersonFinder::Init lists every OBJD type 2 selector of the
 * object folder, so they all have pictures.
 *
 * GetPictureBuffer (BMP_ 2002, Mac 1023bf50), GetRelPictureBuffer (2003) and
 * GetSpeechIcon (2005 medium / 2006 large, Mac 1023c1c0) read the BMP_ of the
 * selector's own resource file (ObjSelector +0); without one they call
 * GenerateBitmaps(i, type, 1): the person is rendered from its body strings
 * (MakePersonBtnImage / MakeRelationshipBtnImage / MakeSpeakingIcon). The
 * original then saves the BMP_ into the file (save_image_to_file); this port
 * keeps it in memory. A 2002 / 2003 with a blank head cell is re-rendered
 * too (see blankHeadIds in data/neighborhood.ts).
 */

import { blankHeadIds } from "../data/neighborhood.js";
import { loadStringSet } from "../sim/behavior.js";
import type { ObjSelector } from "../world/objselector.js";

/** Rendered pictures by person GUID (GenerateBitmaps' results). */
const rendered = new Map<number, Promise<Map<number, Uint8Array> | null>>();

async function render(sel: ObjSelector): Promise<Map<number, Uint8Array> | null> {
  try {
    // ObjSelector::GetBodyStrings: the STR# named by OBJD +0x26.
    const bodyStrings = loadStringSet(sel.res, sel.objd.i16(0x26));
    if (!bodyStrings?.length) return null;
    const { generatePortraits } = await import("./portraits.js");
    return await generatePortraits(bodyStrings);
  } catch {
    return null;
  }
}

/**
 * A person's picture (BMP_ 2002 faces, 2003 relationship heads, 2005 / 2006
 * speech icons) as 24-bit BMP bytes; null when the person cannot be drawn.
 */
export async function personBitmap(sel: ObjSelector, id: number): Promise<Uint8Array | null> {
  const own = sel.res.get("BMP_", id);
  if (own && !blankHeadIds(new Map([[id, own]])).length) return own;
  const key = sel.guid | 0;
  let done = rendered.get(key);
  if (!done) {
    done = render(sel);
    rendered.set(key, done);
  }
  return (await done)?.get(id) ?? own;
}

/** ObjectFolder::GetSelectorByGUID through the folder of `from` (opens the person's file when needed). */
export async function personSelector(from: ObjSelector, guid: number): Promise<ObjSelector | null> {
  const folder = from.folder as typeof from.folder & { getSelectorByGUID?(guid: number): Promise<ObjSelector | null> };
  if (folder.getSelectorByGUID) return folder.getSelectorByGUID(guid).catch(() => null);
  return folder.selectorByGUID?.(guid) ?? null;
}
