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
  /** The screen size (engine/display.ts): the main window's area, as the original's display mode. */
  width: number;
  height: number;
  /**
   * The horizontal band the control panel, the view control and the
   * picture-in-picture are placed in (engine/display.ts hudBand): the whole
   * width as in the original, or a centred band with the port's centred HUD.
   */
  hud?: { left: number; right: number };
  /** cSimsApp services the control panel calls into; the game shell fills it. */
  hooks?: GameHooks;
}

/**
 * The screen width the control panel's pages choose their layout by (the
 * original's GetScreenWidth tests: the wide Live pages at exactly 1024, the
 * roof panel's small layout at 800): the screen's, or with the port's
 * centred HUD the band's, which is the 1024 x 768 interface.
 */
export function hudLayoutWidth(ctx: GameContext): number {
  return ctx.hud ? ctx.hud.right - ctx.hud.left : ctx.width;
}

/**
 * cSimsApp entry points used by the options and camera panels. Every hook is
 * optional: a panel does nothing (beyond its own UI) when one is missing.
 */
export interface GameHooks {
  /** cSimsApp+0xbf (Mac) / +0xf7 (PC): the lot changed since it was last saved. */
  isLotDirty?(): boolean;
  /** cSimsApp::SaveGame: save the current lot and family now (Options > Save). */
  saveGame?(): Promise<void> | void;
  /**
   * cSimsApp::DoSave: asks whether to save before leaving the lot (and saves
   * on yes). Resolves false when the player cancels.
   */
  doSave?(): Promise<boolean>;
  /**
   * cWinOptions::SaveDowntownDescription(prompt): the lot name / description
   * editor (cWinEditDTLotDesc) on a lot visited without sims. 1 save the
   * game, 0 don't, -1 cancelled, -2 not such a lot.
   */
  saveDowntownDescription?(prompt: boolean): Promise<number>;
  /** cSimsApp::DoNbhdScreen(false): leave the lot for the neighborhood screen. */
  showNeighborhood?(): void;
  /** The framework's quit request (cSimsApp+0x48, vtable 0x28); resolves false when cancelled. */
  quit?(): Promise<boolean> | boolean;
  /** cSimsApp::ResetTutorial (Options > Play > Reset Tutorial). */
  resetTutorial?(): void;
  /** cWinScrapbook run modally (Camera > View Photo Album). */
  showScrapbook?(): Promise<void>;
  /** Neighborhood::GetDirectory: the current neighborhood folder (e.g. "UserData"). */
  neighborhoodDir?(): string;
  /** cDDDSimsView::SetBlockSimulator: hold / release the simulation while a modal window is up. */
  setBlockSimulator?(block: boolean): void;
}
