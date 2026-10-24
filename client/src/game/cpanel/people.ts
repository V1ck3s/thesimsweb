/**
 * cWinPeople — Live mode panel (family, motives, job, personality, relationships).
 *
 * Placeholder: replaced by the port of cWinPeople (see docs/decomp/porting-guide.md).
 */

import type { GameContext } from "../context.js";
import { TSWin } from "../ui/tswin.js";

export class WinPeople extends TSWin {
  constructor(readonly ctx: GameContext) {
    super();
  }

  updateViewFromCPState(): void {}
}
