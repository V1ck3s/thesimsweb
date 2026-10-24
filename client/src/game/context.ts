/**
 * Services shared by every game window, created once at boot (the original
 * reaches them through globals such as nsSMResFac and cTSFontSys).
 */

import type { CPState } from "./cpstate.js";
import type { Fonts } from "./res/fonts.js";
import type { Strings } from "./res/strings.js";
import type { UIRes } from "./res/uires.js";

export interface GameContext {
  res: UIRes;
  fonts: Fonts;
  strings: Strings;
  state: CPState;
  width: number;
  height: number;
}
