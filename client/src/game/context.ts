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
  /** cSimsApp services the control panel calls into; the game shell fills it. */
  hooks?: GameHooks;
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
  /** cSimsApp::DoNbhdScreen(false): leave the lot for the neighborhood screen. */
  showNeighborhood?(): void;
  /** The framework's quit request (cSimsApp+0x48, vtable 0x28); resolves false when cancelled. */
  quit?(): Promise<boolean> | boolean;
  /** cSimsApp::ResetTutorial (Options > Play > Reset Tutorial). */
  resetTutorial?(): void;
  /** cWinScrapbook run modally (Camera > View Photo Album). */
  showScrapbook?(): Promise<void>;
}
