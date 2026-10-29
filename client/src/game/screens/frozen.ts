/**
 * The screen while cSimsApp works synchronously between the neighborhood and
 * a lot.
 *
 * The original has no loading screen or progress dialog for a lot:
 * - Entering (cWinNeighborhoodUL::RegularModeLotHandler / MoveInModeLotHandler
 *   -> cSimsApp::LoadGame): the neighborhood screen stays as it is, the music
 *   fades (bkground_fade, played by the screen), cDDDSimsView::
 *   StartWatchCursor sets the global hourglass (standard cursor 3) and
 *   Neighborhood::LoadHouse runs to completion without a frame being drawn.
 *   The screen then ends its modal loop, the lot view is shown, and the
 *   hourglass goes away at the end of the view's next draw (cDDDSimsView
 *   +0x11a8, the cursor saved at +0x11a4 is restored).
 * - Leaving (cSimsApp::ShowNbhdDialog): CPState::LeavingHouse, Neighborhood::
 *   UnloadHouse, the neighborhood screen is built, the lot view hidden and
 *   the screen run modally: the last lot frame stays up until the
 *   neighborhood screen draws. No cursor change.
 *
 * Loading is asynchronous here, so the frame on screen when the work starts
 * is kept by a front-most modal window that paints it and swallows input
 * (nothing reacts while the original is busy), and the windows behind it can
 * be swapped freely.
 */

import { getStandardCursor } from "../ui/cursor.js";
import { Gfx, TSWin, WF_MODAL } from "../ui/tswin.js";
import type { WinMgr } from "../ui/winmgr.js";

/** cTSCursorManager standard cursor 3: the hourglass of StartWatchCursor. */
const WATCH_CURSOR = 3;

class FrozenScreen extends TSWin {
  constructor(private readonly image: HTMLCanvasElement) {
    super();
    this.setFlag(WF_MODAL, true);
  }

  override tsPaint(g: Gfx): void {
    g.blit(this.image, 0, 0);
  }

  override tsOnMouseDownL(): boolean {
    return true;
  }
  override tsOnMouseUpL(): boolean {
    return true;
  }
  override tsOnMouseDownR(): boolean {
    return true;
  }
  override tsOnMouseUpR(): boolean {
    return true;
  }
  override tsOnMouseMove(): boolean {
    return true;
  }
}

/**
 * Runs `work` with the current frame frozen on screen (and the hourglass when
 * `watchCursor`, StartWatchCursor). The frozen frame goes away when `work`
 * settles; the hourglass one frame later, once the windows `work` put up
 * have drawn.
 */
export async function whileFrozen<T>(mgr: WinMgr, watchCursor: boolean, work: () => Promise<T>): Promise<T> {
  const copy = document.createElement("canvas");
  copy.width = mgr.canvas.width;
  copy.height = mgr.canvas.height;
  copy.getContext("2d")?.drawImage(mgr.canvas, 0, 0);
  const frozen = new FrozenScreen(copy);
  frozen.setArea(0, 0, copy.width, copy.height);
  mgr.main.childAdd(frozen);
  mgr.blockInput();
  if (watchCursor) mgr.setGlobalCursor(getStandardCursor(WATCH_CURSOR));
  try {
    return await work();
  } finally {
    mgr.main.childDelete(frozen);
    mgr.unblockInput();
    if (watchCursor) requestAnimationFrame(() => requestAnimationFrame(() => mgr.setGlobalCursor(null)));
  }
}
