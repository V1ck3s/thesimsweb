/**
 * cWinArch — Build mode tools.
 *
 * Placeholder: replaced by the port of cWinArch (see docs/decomp/porting-guide.md).
 */

import type { GameContext } from "../context.js";
import { TSWin } from "../ui/tswin.js";

export class WinArch extends TSWin {
  constructor(readonly ctx: GameContext) {
    super();
  }

  updateViewFromCPState(): void {}
}
