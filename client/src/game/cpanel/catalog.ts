/**
 * cWinCatalog — Buy mode catalog.
 *
 * Placeholder: replaced by the port of cWinCatalog (see docs/decomp/porting-guide.md).
 */

import type { GameContext } from "../context.js";
import { TSWin } from "../ui/tswin.js";

export class WinCatalog extends TSWin {
  constructor(readonly ctx: GameContext) {
    super();
  }

  updateViewFromCPState(): void {}
}
