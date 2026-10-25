/**
 * cWinCatalog's static data, per catalog sort (CPState::NewCatalogSort: room,
 * function, downtown, vacation, community, studio town, magic town).
 *
 * Resource ids come from the tables cWinCatalog::Init loads (Windows .data
 * 0x6cc3d4..0x6cc65b, the Mac TOC entries lbl_105BA994..lbl_105BA9CC agree);
 * positions from .__sinit__WinCatalog_cpp (lbl_105BA9D0, lbl_105BAA04..
 * lbl_105BAA3C), in control panel coordinates: LoadBooks subtracts the
 * catalog's offset in the panel. The jump tables of cWinCatalog::LoadBooks
 * and UpdateViewFromCPState pick a table per sort; Windows' recovered switch
 * statements give the masks.
 */

type Point = readonly [number, number];
type Eight<T> = readonly [T, T, T, T, T, T, T, T];

/** kCatalogBuyModePrevPage, kCatalogNextPage (Init's page button table). */
export const PAGE_BUTTON_IDS = [102, 101] as const;
/** lbl_105BA9D0: the previous page button; the next one sits at (width - 24, 26) (Windows LoadBooks). */
export const PREV_PAGE_POS: Point = [0x194, 0x1a];
export const NEXT_PAGE_FROM_RIGHT = 0x18;
export const NEXT_PAGE_Y = 0x1a;

/** Category ("book") buttons, 0 where a sort has no such book (4..6 outside room and function). */
export const BOOK_IDS: readonly Eight<number>[] = [
  [158, 159, 160, 161, 162, 163, 164, 165], // kBuyRLiving..kBuyRMisc
  [150, 151, 152, 153, 154, 155, 156, 157], // kBuyFSeating..kBuyFMisc
  [200, 201, 202, 203, 0, 0, 0, 204], // kBuyDDining..kBuyDMisc
  [230, 231, 232, 233, 0, 0, 0, 234], // kBuyVOne..kBuyVMisc
  [250, 251, 252, 253, 0, 0, 0, 254], // kBuyCOne..kBuyCMisc
  [273, 274, 276, 275, 0, 0, 0, 277], // kBuySTfood, kBuySTshop, kBuySTstudio, kBuySTspa, kBuySTMisc
  [1705, 1706, 1708, 1707, 0, 0, 0, 1709], // kBuyMTfood, kBuyMTshop, kBuyMTmagic, kBuyMToutdoor, kBuyMTMisc
];

/** The big category picture of the back button (Init's 7x8 table at 0x6cc57c). */
export const BACK_IDS: readonly Eight<number>[] = [
  [180, 181, 182, 183, 184, 185, 186, 187], // kBuyBackR*
  [170, 171, 172, 173, 174, 175, 176, 177], // kBuyBackF*
  [190, 191, 192, 193, 0, 0, 0, 194], // kBuyBackD*
  [195, 196, 197, 198, 0, 0, 0, 199], // kBuyBackV*
  [255, 256, 257, 258, 0, 0, 0, 259], // kBuyBackC*
  [268, 269, 270, 271, 0, 0, 0, 272], // kBuyBackS*
  [1700, 1701, 1702, 1703, 0, 0, 0, 1704], // kBuyBackM*
];

/** Sub-sort buttons (by function) of the room and community sorts; the function sort computes its own. */
export const SUBSORT_IDS: readonly (Eight<number> | null)[] = [
  [210, 211, 212, 213, 214, 215, 216, 217], // kBuyRSubSort*
  null,
  [220, 221, 222, 223, 224, 225, 226, 227], // kBuyDSubSort*
  [240, 241, 242, 243, 244, 245, 246, 247], // kBuyVSubSort*
  [260, 261, 262, 263, 264, 265, 266, 267], // kBuyCSubSort*
  [220, 221, 222, 223, 224, 225, 226, 227], // studio town uses the downtown set
  [220, 221, 222, 223, 224, 225, 226, 227], // magic town too
];

/** Function sub-sorts: kBuyF<Function>SubSort<n> = 1500 + function * 10 + n ("computed by the code"). */
export const FUNCTION_SUBSORT_BASE = 1500;
export const SUBSORT_PETS = 1574; // kBuyFMiscSubSortPets
export const SUBSORT_MAGIC = 1575; // kBuyFMiscSubSortMagic
export const SUBSORT_OTHER = 1580; // kBuyFSubSortOther
export const SUBSORT_ALL = 1581; // kBuyFSubSortAll
/** The function book whose sub-sorts include pets and magic. */
export const FUNCTION_MISC = 7;

/** Book positions per sort (lbl_105BAA3C, AA30, AA28, AA20, AA18, AA10, AA08). */
export const BOOK_POS: readonly Eight<Point>[] = [
  [[242, 7], [281, 3], [323, 7], [361, 4], [239, 53], [284, 59], [322, 55], [364, 64]],
  [[242, 8], [279, 16], [322, 1], [369, 4], [241, 61], [285, 59], [322, 55], [364, 64]],
  [[242, 8], [284, 12], [318, 12], [369, 14], [241, 61], [285, 59], [322, 55], [364, 64]],
  [[242, 8], [284, 12], [318, 12], [369, 14], [241, 61], [285, 59], [322, 55], [364, 64]],
  [[242, 8], [284, 12], [318, 12], [369, 14], [241, 61], [285, 59], [322, 55], [364, 64]],
  [[242, 8], [284, 12], [318, 12], [358, 14], [241, 61], [285, 59], [322, 55], [364, 64]],
  [[242, 8], [284, 12], [318, 12], [369, 14], [241, 61], [285, 59], [322, 55], [364, 64]],
];

/** Sub-sort positions: a 4x2 grid, the same for every sort (lbl_105BAA34, AA2C, AA24, AA1C, AA14, AA0C, AA04). */
export const SUBSORT_POS: Eight<Point> = [
  [251, 10], [289, 10], [327, 10], [365, 10], [251, 58], [289, 58], [327, 58], [365, 58],
];

/** UIText STR# 150 holds the book names, eight per sort; the room sort's sub-sorts use the function names. */
export const BOOK_TIP_BASE = [0, 8, 16, 24, 32, 40, 48] as const;
export const SUBSORT_TIP_BASE = 8;

/** cWinCatalog::GetRoomMask etc.: book index -> OBJD flag, per sort. */
export const ROOM_MASKS: Eight<number> = [8, 0x20, 2, 0x80, 1, 4, 0x10, 0x40];
export const FUNCTION_MASKS: Eight<number> = [1, 2, 0x20, 8, 4, 0x10, 0x80, 0x40];
const COMMUNITY_MASKS: Eight<number> = [1, 2, 4, 8, 0x10, 0x20, 0x40, 0x80];
/** GetFunctionSubMask: 6 = "other" (0x10 | 0x80), 7 = all. */
const FUNCTION_SUB_MASKS: Eight<number> = [1, 2, 4, 8, 0x20, 0x40, 0x90, 0xff];

export function catalogMask(sort: number, cat: number): number {
  const t = sort === 0 ? ROOM_MASKS : sort === 1 ? FUNCTION_MASKS : COMMUNITY_MASKS;
  return t[cat] ?? 0;
}

export function subCatalogMask(sort: number, sub: number): number {
  return (sort === 1 ? FUNCTION_SUB_MASKS : FUNCTION_MASKS)[sub] ?? 0;
}

/** cWinCatalog::GetRoom / GetFunction: the first matching book (-1 when none). */
export function firstIndex(masks: Eight<number>, flags: number): number {
  return masks.findIndex((m) => (flags & m) !== 0);
}

/** cWinCatalog::GetSubFunction: bits 1, 2, 4, 8, 0x20, 0x40, then 0x10 or 0x80 -> 6. */
export function subFunctionIndex(flags: number): number {
  const order = [1, 2, 4, 8, 0x20, 0x40];
  const i = order.findIndex((m) => (flags & m) !== 0);
  if (i >= 0) return i;
  return flags & 0x90 ? 6 : -1;
}

/** Product grid (UpdateViewFromCPState): origin 0x19f, 5; 45x45 cells; ends at width - 12 and y 95. */
export const GRID_X = 0x19f;
export const GRID_Y = 5;
export const GRID_STEP = 0x2d;
export const GRID_CELL = 0x2d;
export const GRID_RIGHT_MARGIN = 0xc;
export const GRID_BOTTOM = 0x5f;
/** The popup stays up while the mouse is in (0x18b, 5)-(width, 95) (cWinCatalog+0x428). */
export const POPUP_ZONE_X = 0x18b;
