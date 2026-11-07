/**
 * The port's live screen resize: with the "window" resolution
 * (engine/display.ts) the game follows the browser window's size while it
 * runs. The original never changes its display mode once started, so its
 * windows only place themselves at Init; here the windows already on screen
 * are moved to where they would have placed themselves at the new size
 * (game/main.ts Game.resizeScreen calls resizeTopLevel).
 *
 * - A full-screen top-level window (neighborhood, town, lot view, splash)
 *   takes the new size; its screenResized lays out its contents, else its
 *   children keep their place relative to the centre.
 * - Any other top-level window (message boxes, dialogs: centred by their
 *   Init) keeps its place relative to the centre.
 * - A window with `holdsScreenSize` (Create a Sim's lot, the frozen screen)
 *   was made for one size: the resize waits until it is gone.
 */

import type { TSWin } from "./tswin.js";

export interface ScreenResizable {
  /** Called with the window's previous size, its area already set to the new one. */
  screenResized(oldW: number, oldH: number): void;
}

function isResizable(w: TSWin): w is TSWin & ScreenResizable {
  return typeof (w as Partial<ScreenResizable>).screenResized === "function";
}

/** Some window under `root` (itself included) cannot be laid out again now. */
export function holdsScreenSize(root: TSWin): boolean {
  if ((root as { holdsScreenSize?: boolean }).holdsScreenSize) return true;
  return root.children.some((c) => holdsScreenSize(c));
}

/** Moves every child of `win` by (dx, dy). */
export function shiftChildren(win: TSWin, dx: number, dy: number): void {
  if (dx === 0 && dy === 0) return;
  for (const c of win.children) c.moveTo(c.area.left + dx, c.area.top + dy);
}

/** The top-level windows of `main` (already at its new size) after a resize from oldW x oldH. */
export function resizeTopLevel(main: TSWin, oldW: number, oldH: number): void {
  const w = main.getW();
  const h = main.getH();
  const dx = (w - oldW) >> 1;
  const dy = (h - oldH) >> 1;
  for (const c of [...main.children]) {
    const full = c.area.left === 0 && c.area.top === 0 && c.getW() === oldW && c.getH() === oldH;
    if (!full) {
      c.moveTo(c.area.left + dx, c.area.top + dy);
      continue;
    }
    c.setArea(0, 0, w, h);
    if (isResizable(c)) c.screenResized(oldW, oldH);
    else shiftChildren(c, dx, dy);
  }
}
