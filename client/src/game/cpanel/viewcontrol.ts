/**
 * cWinViewControl — mode buttons, speed, clock and funds gadget at the bottom-left.
 *
 * Placeholder: replaced by the port of cWinViewControl (see docs/decomp/porting-guide.md).
 */

import type { GameContext } from "../context.js";
import { TSWin } from "../ui/tswin.js";

export class WinViewControl extends TSWin {
  constructor(readonly ctx: GameContext) {
    super();
  }

  updateViewFromCPState(): void {}
}
