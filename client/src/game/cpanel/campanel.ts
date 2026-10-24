/**
 * cWinCamPanel — Camera/scrapbook panel.
 *
 * Placeholder: replaced by the port of cWinCamPanel (see docs/decomp/porting-guide.md).
 */

import type { GameContext } from "../context.js";
import { TSWin } from "../ui/tswin.js";

export class WinCamPanel extends TSWin {
  constructor(readonly ctx: GameContext) {
    super();
  }

  updateViewFromCPState(): void {}
}
