/**
 * cTSCursorManager: the game's cursors, by id, as CSS cursor values.
 *
 * cSimsApp::SetupWinCtrlMgr registers them from <data>/UIGraphics/shared/cursors/
 * (lbl_1060C958): ids 0 arrow, 3 hourglass, 2 edit, 4 finger (lbl_105BA8A8..89C),
 * then the tool cursors 6.. in the order of the table below. The .cur files
 * carry their own hotspots, which browsers honor.
 */

const CURSOR_DIR = "/assets/Sims/UIGraphics/Shared/cursors/";

/** cSimsApp::SetupWinCtrlMgr: AddCursor(file, id). */
const CURSOR_FILES: Record<number, string> = {
  0: "Arrow.cur",
  3: "HOURGLASS.cur",
  2: "edit.cur",
  4: "finger.cur",
  6: "SimsDelete.cur",
  7: "SimsLevel.cur",
  8: "SimsLower.cur",
  10: "SimsMove.cur",
  0xb: "SimsPlace.cur",
  9: "SimsRaise.cur",
  0xc: "SimsRotate.cur",
  0xd: "SimsRotateNW.cur",
  0xe: "SimsRotateNE.cur",
  0xf: "SimsRotateSW.cur",
  0x10: "SimsRotateSE.cur",
  0x11: "LEFT.cur",
  0x12: "RIGHT.cur",
  0x13: "UP.cur",
  0x14: "DOWN.cur",
  0x15: "UPRIGHT.cur",
  0x16: "UPLEFT.cur",
  0x17: "DOWNRIGHT.cur",
  0x18: "DOWNLEFT.cur",
  0x19: "EXPLORE.cur",
  0x1a: "DEADEXPL.cur",
  0x1b: "Pan.cur",
  0x1d: "LivePerson.cur",
  0x1c: "LiveNothing.cur",
  0x2a: "LivePet.cur",
  0x2b: "LiveNothingPet.cur",
  0x1e: "LiveObjectAvail.cur",
  0x1f: "LiveObjectUnavail.cur",
  0x20: "ADDPTS.cur",
  0x21: "MOVEIN.cur",
  0x22: "BULLDOZE.cur",
  0x23: "SimsFlip.cur",
  0x24: "RemovePts.cur",
  0x25: "taxi.cur",
  0x26: "water.cur",
  0x27: "van.cur",
  0x28: "Rezone2.cur",
  0x29: "trolleybus.cur",
  0x2c: "limo.cur",
};

/** Standard cursors (cTSCursor::StandardCursor): 3 = wait, 4 = arrow. */
const STANDARD: Record<number, string> = { 3: "HOURGLASS.cur", 4: "Arrow.cur" };

function css(file: string, fallback: string): string {
  return `url("${CURSOR_DIR}${file}"), ${fallback}`;
}

/** cTSCursorManager::GetCursor(id), or null when the id is not registered. */
export function getCursor(id: number): string | null {
  const f = CURSOR_FILES[id];
  return f ? css(f, id === 3 ? "wait" : "default") : null;
}

/** cTSCursorManager::GetStandardCursor */
export function getStandardCursor(which: number): string | null {
  const f = STANDARD[which];
  return f ? css(f, which === 3 ? "wait" : "default") : null;
}
