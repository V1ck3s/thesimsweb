/**
 * The text shown over a person's head (cHeadTextRenderer, one cHeadTextItem
 * per object; drawn by world/balloons.ts).
 *
 *  - GViewer::SetHeadFee (Mac 101b5e30), run by cXPerson::Simulate when
 *    person data 1 is not 0 (then cleared): below -20000 the magic tokens
 *    (-(v + 20000), cDDDSimsView::DrawHeadMagicTokens: black on the colour
 *    key, i.e. no box), below -10000 the tickets (-(v + 10000),
 *    DrawHeadTickets: black on (0xff, 0xcb, 0x17), with the
 *    "sting_char_winner" sound on the person), else the amount as money
 *    (cTSLanguageUtility::MakeMoneyString, DrawHeadText: the InitSimsColors
 *    colours lbl_105BA7C4 (0, 0xca, 0x39) on lbl_105BA25C (0, 0, 0x52));
 *  - DrawHeadTextItem (Mac 1020ad20): the text in font gFonts[7] at (2, 2)
 *    of a box 4 pixels larger than its TSTextArea. An item is redrawn only
 *    when it was never drawn or its last text is more than 100 ticks old
 *    (cSimulator +0x98);
 *  - cXObject's draw (Mac 100c7xxx) blits a person's item for 100 ticks,
 *    centred 0xaf >> (3 - scale) pixels above its position (4 more at the
 *    small zoom), then retires it.
 */

import { soundPlayer } from "../audio/soundplayer.js";
import { makeMoneyString } from "../res/langutil.js";
import { UI_LANGUAGE } from "../res/uires.js";
import type { SimModule } from "./simmodule.js";
import type { SimObject } from "./xobject.js";

export interface HeadTextItem {
  text: string;
  /** Box colour, null for the colour key (no box). */
  fill: string | null;
  color: string;
  /** cSimulator +0x98 when it was drawn. */
  tick: number;
}

/** How long an item shows (ticks). */
export const HEAD_TEXT_TICKS = 100;
/** gFonts[7] (lbl_105BA2E8 + 0x1c). */
export const HEAD_TEXT_FONT_SIZE = 7;

const SOUND_TICKETS = "sting_char_winner";

/** DrawHeadTextItem's update rule: a new text replaces the item only once the last one is done. */
function setItem(m: SimModule, o: SimObject, item: Omit<HeadTextItem, "tick">): void {
  const now = m.sim.tickCount;
  const cur = m.headTexts.get(o.id);
  if (cur && cur.tick + HEAD_TEXT_TICKS >= now) return;
  m.headTexts.set(o.id, { ...item, tick: now });
  m.dirty(o);
}

/** GViewer::SetHeadFee */
export function setHeadFee(m: SimModule, o: SimObject, value: number): void {
  let v = value;
  if (v < -20000) {
    v = -(v + 20000);
    setItem(m, o, { text: String(v), fill: null, color: "rgb(0,0,0)" });
  } else if (v < -10000) {
    v = -(v + 10000);
    soundPlayer.playBySource(SOUND_TICKETS, o.id);
    setItem(m, o, { text: String(v), fill: "rgb(255,203,23)", color: "rgb(0,0,0)" });
  } else {
    setItem(m, o, { text: makeMoneyString(v, UI_LANGUAGE), fill: "rgb(0,0,82)", color: "rgb(0,202,57)" });
  }
}
