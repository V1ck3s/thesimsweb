/**
 * Shared UI colors, as set up at boot by InitSimsColors (SimsColors.cpp) and
 * cSimsApp (cTSWinCtrlMgr::SetDefaultColor / SetDefaultColors).
 */

export function rgb(r: number, g: number, b: number): string {
  return `rgb(${r},${g},${b})`;
}

/** Color every font of the global font table is set to (InitSimsColors). */
export const UI_FONT_COLOR = rgb(0xc3, 0xcd, 0xcd);

/** Button caption colors per frame column (cTSWinBtn::GetHiliteColor, SetDefaultColors(4/6)). */
export const HILITE_COLORS_4 = [UI_FONT_COLOR, rgb(0, 0xff, 0xff), rgb(0xff, 0xff, 0xff), rgb(0x40, 0x5d, 0x5f)];
export const HILITE_COLORS_6 = [
  UI_FONT_COLOR,
  rgb(0, 0xff, 0xff),
  rgb(0xff, 0xff, 0xff),
  rgb(0, 0xff, 0xff),
  rgb(0x40, 0x5d, 0x5f),
  rgb(0x40, 0x5d, 0x5f),
];

/** cTSWinCtrlMgr::DefaultColor(i), set by cSimsApp. Index 3 is never set. */
export const DEFAULT_COLORS: Record<number, string> = {
  0: rgb(0xff, 0, 0xff),
  1: rgb(0xbd, 0xbc, 0xbc),
  2: rgb(0xff, 0xff, 0xff),
  4: rgb(0, 0, 0),
  5: rgb(0x80, 0, 0),
  6: rgb(0, 0x80, 0),
  7: rgb(0x80, 0x80, 0x40),
  8: rgb(0, 0, 0x80),
  9: rgb(0x80, 0, 0x80),
  10: rgb(0, 0x80, 0x80),
  11: rgb(0x80, 0x80, 0x80),
  12: rgb(0xc0, 0xc0, 0xc0),
  13: rgb(0xff, 0, 0),
  14: rgb(0, 0xff, 0),
  15: rgb(0xff, 0xff, 0),
  16: rgb(0, 0, 0xff),
  17: rgb(0, 0xff, 0xff),
  18: rgb(0xff, 0xff, 0xff),
};

/** cTSWinBtn::GetHiliteColor for a button with `cols` frames. */
export function hiliteColor(cols: number, col: number): string {
  const table = cols === 6 ? HILITE_COLORS_6 : HILITE_COLORS_4;
  return table[col] ?? UI_FONT_COLOR;
}
