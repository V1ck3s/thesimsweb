/**
 * The expansion town screens, one class per pack in the original:
 *   cWinDowntown   (Hot Date, houses 21..30, WinDowntown.cpp)
 *   cWinVacation   (Vacation, houses 40..48, WinVacation.cpp)
 *   cWinStudiotown (Superstar, houses 81..89, WinStudiotown.cpp)
 *   cWinMagicland  (Makin' Magic, houses 90..98, WinMagicland.cpp)
 * The four classes are copies of one template (same members at shifted
 * offsets, same Init / SetMode / TSOnCommand / TSPaint / PostChildDraw); the
 * differences are data, kept in TOWNS below. `WinTown` is that template.
 *
 * Each class is built two ways (constructor bool, +0x118 in cWinDowntown):
 *  - main screen (true): cSimsApp::ShowDowntownDialog / ShowVacationDialog /
 *    ... after the neighborhood screen ended with -20 / -30 / -40 / -50.
 *    Bar kDTBarBkg with Exit (back to the neighborhood), Inet (placed at
 *    x 30000: never visible), the Sims logo (credits), Import and Bulldoze;
 *    a lot click is cSimsApp::LoadGame(house) and ends the screen with the
 *    house number.
 *  - destination picker (false): ObjectModule::PostSim, when a Dialog
 *    primitive of kind 5 / 7 / 0xb / 0xd asked for it (nbhd/transit.ts).
 *    Bar kFilterToolbar(ST) with the lot type filters, a random "where to?"
 *    title, the kDTDlgBkg2 frame; a lot click ends the screen with the house
 *    number, nothing is loaded.
 *
 * Window tree (Init):
 *   this (full screen)        TSPaint: kLargeMask(SS) when wider than 800 (a button in the original)
 *    ├ map button [0x5f]      the 800x600 background, centered (+0x134 / +0x138)
 *    │  ├ lot buttons         one per MapIndexToHouseNum, full-size thumbnails, clipped to the map
 *    │  └ bar [0x5e]          at the map's top-left
 *    │     └ buttons          main: 5 (6 in Magic Town); picker: the filters
 *    ├ water layer            PostChildDraw's animated frame (and Vacation's port / trees)
 *    └ lot popup              cWinLotPopup
 *   PostChildDraw (picker): filter icons over the matching lots, the title, the frame.
 */

import { assetFetch, fetchManifest } from "../../engine/assets.js";
import { MUSIC, soundPlayer, UI } from "../audio/index.js";
import type { GameContext } from "../context.js";
import { writeGameFile } from "../data/files.js";
import { NeighborhoodStore } from "../data/nbhdstore.js";
import { getOptionsMgr, TriState } from "../optionsmgr.js";
import type { FfnFont } from "../res/ffn.js";
import { UI_LANGUAGE } from "../res/uires.js";
import { BTN_TOGGLE, TSWinBtn } from "../ui/btn.js";
import { getCursor, getStandardCursor } from "../ui/cursor.js";
import { WinPickFamily } from "../cas/winpickfamily.js";
import { IDOK, IDYES, MB_OK, MB_YESNO, TSWinMsgBox } from "../ui/msgbox.js";
import { PD_AVOID_RECT, WinPictureDialog } from "../ui/picturedialog.js";
import { deleteGameFile } from "../data/files.js";
import { getImportInfoForFile, getLotImportInfo, importFamily, importLotFile, isWrongCharacterSet, listTownImports, pickAndUploadImports, setLotDescription } from "./imports.js";
import { Gfx, TSWin } from "../ui/tswin.js";
import { winMgr } from "../ui/winmgr.js";
import { Zone, type Neighborhood } from "./nghinterface.js";
import { WinCredits } from "./wincredits.js";
import { WinLotBtn, type LotBtnOwner } from "./winlotbtn.js";
import { WinLotPopup, type MagicPopupSource } from "./winlotpopup.js";
import { MagiclandSprites, StudiotownCars } from "./townsprites.js";

export const enum Town {
  Downtown = 0,
  Vacation = 1,
  Studiotown = 2,
  Magictown = 3,
}

/**
 * cWinDowntown::Mode (+0x19c): 0 regular, 1 move in (cWinMagicland only), 2
 * bulldoze (evict), 3 lot moving (cheat, not ported).
 */
const enum TownMode {
  Regular = 0,
  MoveIn = 1,
  Evict = 2,
}

/** Main-screen bar buttons (TSOnCommand's +0x164.. order). */
const BTN_EXIT = 0;
const BTN_INET = 1;
const BTN_LOGO = 2;
const BTN_IMPORT = 3;
const BTN_BULLDOZE = 4;
const BTN_MOVE_IN = 5;

/** A lot type filter of the picker's toolbar (BuildFilterToolbar / SetFilterMode). */
interface Filter {
  /** Button bitmap (kFilter*Button, 4 columns). */
  button: number;
  /** HouseInfo +0x20 bit (simulator global 37 of the house). */
  bit: number;
  /** 1-based tooltip entry of UIText STR# 171. */
  tip: number;
}

/** The Downtown / Vacation filters, in button order (lbl_105BCB10 jump table). */
const FILTERS_DV: readonly Filter[] = [
  { button: 5064, bit: 0x10, tip: 1 }, // kFilterDogCatButton
  { button: 5065, bit: 0x20, tip: 2 }, // kFilterSmallAnimalButton
  { button: 5063, bit: 0x08, tip: 3 }, // kFilterShoppingButton
  { button: 5062, bit: 0x04, tip: 4 }, // kFilterGardeningButton
  { button: 5061, bit: 0x02, tip: 5 }, // kFilterFoodButton
  { button: 5066, bit: 0x40, tip: 6 }, // kFilterRecreationButton
  { button: 5060, bit: 0x01, tip: 7 }, // kFilterLodgingButton
];

/** SetFilterMode: the icon drawn over the lots of the current filter (kFilter*BMP, 3 frames side by side). */
const FILTER_ICONS: Readonly<Record<number, number>> = {
  0x01: 4930, // kFilterLodgingBMP
  0x02: 4931, // kFilterFoodBMP
  0x04: 4932, // kFilterGardeningBMP
  0x08: 4933, // kFilterShoppingBMP
  0x10: 4934, // kFilterPetBMP
  0x20: 4935, // kFilterSmallAnimalBMP
  0x40: 4936, // kFilterParkBMP
  0x80: 4937, // kFilterSpaBMP
  0x100: 4939, // kFilterMovieBMP
  0x200: 4940, // kFilterModelBMP
  0x400: 4938, // kFilterMusicBMP
  0x800: 4942, // kFilterMagicBMP
  0x1000: 4941, // kFilterRidesBMP
};

interface TownDef {
  /** The original class. */
  cls: string;
  /** MapIndexToHouseNum, in creation order (also the drawing order). */
  houses: readonly number[];
  /** Neighborhood-provided art (Init's LoadGimex of <neighborhood>/<name>), tried first. */
  gimexBackground: string | null;
  gimexWater: readonly string[];
  gimexOverlays: readonly string[];
  background: number;
  water: readonly number[];
  /**
   * Magic Town's water (cMagiclandSprites::DoWater / DrawWater): the frames
   * cycle 0..5, one step every 5 paint ticks, drawn at (0, 0x3e) on the
   * map. null: the other towns' ping-pong over ticks 0..9 at (0, 0).
   */
  waterCycle: { x: number; y: number } | null;
  /** Vacation's kNghVacationPort / kNghVacationTrees, drawn before the water frame. */
  overlays: readonly number[];
  largeMask: number;
  pickerBar: number;
  /** lbl_105BCAD4 and friends; entry 2 is replaced by the language's Sims logo. */
  buttons: readonly number[];
  /** lbl_105BCAD0 (static initializer), on the bar. */
  buttonPos: ReadonlyArray<readonly [number, number]>;
  /** UIText STR# of the bar tooltips. */
  tipsStr: number;
  /** UIText STR# of the picker titles (three entries, one picked at random). */
  titlesStr: number;
  /** Init's PlayBySource (music station, ambience). */
  initSounds: readonly string[];
  /** Init copies the template lots when the first house file is missing. */
  template: { dir: string; desc: string; first: number; end: number };
  filters: readonly Filter[];
  /** lbl_105BCB14: filter button positions on the picker bar. */
  filterX0: number;
  /** LoadCurrentFilter's default. */
  defaultFilter: number;
  /** DrawFilters: houses whose icon sits 10 px above the lot point instead of 0x46. */
  lowIconHouses: readonly number[];
  /** RegularModeLotHandler plays this first (Studio Town: main screen only; Magic Town: always). */
  lotSound: string | null;
  /** RegularModeBtnHandler(logo): the credits music (cWinMagicland: "music_magictown_credits"). */
  credits: string;
  /** RegularModeBtnHandler(logo): the music played again after the credits. */
  music: string;
  /**
   * SetMode's picker cursor: [vehicle flag clear, set]. The flag is
   * cWinStudiotown +0xd0 (a star asks: limo 0x2c, else tram 0x2d) and
   * cWinMagicland +0xdc (balloon 0x2f, else hole 0x2e).
   */
  pickerCursor: readonly [number, number];
  /** CycleThroughImports' pattern (*.dtl / *.vil / *.stl; Magic Town: CycleCommunityImports' *.mtl). */
  importExt: string;
  /**
   * The lot import dialog's title: entry 4 (1-based) of this UIText STR#
   * (cWinVacation reads Downtown's 169 too).
   */
  importTitleStr: number;
}

const BAR_POS_5: ReadonlyArray<readonly [number, number]> = [
  [0x143, 0], [30000, 0], [5, 0], [0x1a6, 0], [0x175, 0],
];

export const TOWNS: Readonly<Record<Town, TownDef>> = {
  [Town.Downtown]: {
    cls: "cWinDowntown",
    houses: [23, 22, 21, 27, 26, 25, 24, 30, 29, 28],
    gimexBackground: "downtown.jpg",
    gimexWater: ["downtown0.jpg", "downtown1.jpg", "downtown2.jpg", "downtown3.jpg", "downtown4.jpg", "downtown5.jpg"],
    gimexOverlays: [],
    background: 0x14c8, // kDowntownBackground
    water: [0x1518, 0x1519, 0x151a, 0x151b, 0x151c, 0x151d], // kDowntownWater0..5
    waterCycle: null,
    overlays: [],
    largeMask: 0x1389, // kLargeMask
    pickerBar: 0x13b5, // kFilterToolbar
    buttons: [5209, 5306, 5210, 5212, 5211], // kDowntownExitToNgh, kNghInet, kDowntownCredits, kDowntownImport, kDowntownBulldoze
    buttonPos: BAR_POS_5,
    tipsStr: 169,
    titlesStr: 212,
    initSounds: ["station_dtnhood", "setambience_downtown"],
    template: { dir: "TemplateDowntown", desc: "DTDesc.iff", first: 21, end: 31 },
    filters: FILTERS_DV,
    filterX0: 0xe1,
    defaultFilter: 2,
    lowIconHouses: [0x17],
    lotSound: null,
    credits: MUSIC.credits,
    music: "station_dtnhood",
    pickerCursor: [0x25, 0x25],
    importExt: "dtl",
    importTitleStr: 169,
  },
  [Town.Vacation]: {
    cls: "cWinVacation",
    houses: [42, 41, 40, 46, 45, 44, 43, 48, 47],
    gimexBackground: "island.jpg",
    gimexWater: ["island0.jpg", "island1.jpg", "island2.jpg", "island3.jpg", "island4.jpg", "island5.jpg"],
    gimexOverlays: ["islandPort.jpg", "islandTrees.jpg"],
    background: 0x1540, // kVacationIsland
    water: [0x1522, 0x1523, 0x1524, 0x1525, 0x1526], // kVIWater0..4
    waterCycle: null,
    overlays: [0x1542, 0x1543], // kNghVacationPort, kNghVacationTrees
    largeMask: 0x1389,
    pickerBar: 0x13b5,
    buttons: [5209, 5306, 5210, 5214, 5211], // ..., kVacationImport, ...
    buttonPos: BAR_POS_5,
    tipsStr: 170,
    titlesStr: 213,
    initSounds: ["station_vacation", "setambience_beach"],
    template: { dir: "TemplateVacation", desc: "VIDesc.iff", first: 40, end: 49 },
    filters: FILTERS_DV,
    filterX0: 0xe1,
    defaultFilter: 2,
    lowIconHouses: [0x2a, 0x28],
    lotSound: null,
    credits: MUSIC.credits,
    music: "station_vacation",
    pickerCursor: [0x27, 0x27],
    importExt: "vil",
    importTitleStr: 169,
  },
  [Town.Studiotown]: {
    cls: "cWinStudiotown",
    houses: [81, 82, 83, 84, 85, 86, 87, 88, 89],
    gimexBackground: null,
    gimexWater: [],
    gimexOverlays: [],
    background: 0x14c9, // kStudiotownBackground
    water: [],
    waterCycle: null,
    overlays: [],
    largeMask: 0x138a, // kLargeMaskSS
    pickerBar: 0x13b6, // kFilterToolbarST
    buttons: [5209, 5306, 5210, 5218, 5211], // ..., kStudiotownImport, ...
    buttonPos: BAR_POS_5,
    tipsStr: 173,
    titlesStr: 212,
    initSounds: ["music_superstar_transition"],
    template: { dir: "TemplateStudiotown", desc: "STDesc.iff", first: 0x51, end: 0x5a },
    filters: [
      { button: 5065, bit: 0x20, tip: 2 },
      { button: 5063, bit: 0x08, tip: 3 },
      { button: 5062, bit: 0x04, tip: 4 },
      { button: 5061, bit: 0x02, tip: 5 },
      { button: 5066, bit: 0x40, tip: 6 },
      { button: 5067, bit: 0x80, tip: 8 }, // kFilterSpaButton
      { button: 5068, bit: 0x100, tip: 9 }, // kFilterMovieButton
      { button: 5069, bit: 0x200, tip: 10 }, // kFilterModelButton
      { button: 5072, bit: 0x400, tip: 11 }, // kFilterMusicButton
    ],
    filterX0: 0xaf,
    defaultFilter: 0x400,
    lowIconHouses: [0x53],
    lotSound: MUSIC.fade,
    credits: MUSIC.credits,
    music: "station_superstar",
    pickerCursor: [0x2d, 0x2c],
    importExt: "stl",
    importTitleStr: 173,
  },
  [Town.Magictown]: {
    cls: "cWinMagicland",
    houses: [90, 91, 92, 93, 94, 95, 96, 97, 98],
    gimexBackground: null,
    gimexWater: [],
    gimexOverlays: [],
    background: 0x14ca, // kMagiclandBackground
    water: [0x1658, 0x1659, 0x165a, 0x165b, 0x165c, 0x165d], // cMagiclandSprites::LoadWater
    waterCycle: { x: 0, y: 0x3e },
    overlays: [],
    largeMask: 0x138a,
    pickerBar: 0x13b5,
    buttons: [5209, 5306, 5210, 5222, 5211, 5200], // ..., kMagictownImport, kDowntownBulldoze, kNghMoveIn
    buttonPos: [...BAR_POS_5, [200, 0]],
    tipsStr: 174,
    titlesStr: 212,
    initSounds: ["music_magictown"],
    template: { dir: "TemplateMagictown", desc: "MTDesc.iff", first: 0x5a, end: 0x63 },
    filters: [
      { button: 5076, bit: 0x1000, tip: 13 }, // kFilterRidesButton
      { button: 5065, bit: 0x20, tip: 2 },
      { button: 5063, bit: 0x08, tip: 3 },
      { button: 5062, bit: 0x04, tip: 4 },
      { button: 5061, bit: 0x02, tip: 5 },
      { button: 5066, bit: 0x40, tip: 6 },
      { button: 5075, bit: 0x800, tip: 12 }, // kFilterMagicButton
    ],
    filterX0: 0xe1,
    defaultFilter: 0x400,
    lowIconHouses: [],
    lotSound: MUSIC.fade,
    credits: "music_magictown_credits",
    music: "music_magictown",
    pickerCursor: [0x2e, 0x2f],
    importExt: "mtl",
    importTitleStr: 174,
  },
};

/** The town whose lots include `house` (the LoadGame / popup ranges), or null. */
export function townOfHouse(house: number): Town | null {
  if (house >= 0x15 && house <= 0x1e) return Town.Downtown;
  if (house >= 0x28 && house <= 0x31) return Town.Vacation;
  if (house >= 0x51 && house <= 0x59) return Town.Studiotown;
  if (house >= 0x5a && house <= 0x63) return Town.Magictown;
  return null;
}

/** Init's language switch for the logo button (entry 2): same table as the neighborhood screen. */
function logoImage(lang: number): number {
  switch (lang) {
    case 1:
      return 5210;
    case 3:
      return 0x1534; // kNghSimsLogo_FR
    case 4:
      return 0x1535;
    case 6:
      return 0x1533;
    case 15:
      return 0x1536;
    default:
      return 0x152d; // kNghSimsLogoEn
  }
}

/** TSPaint's frame clock: a step when 1000 / elapsed <= 2 * pi (lbl_105BCADC 1000, lbl_105BA324 pi * 2). */
const WATER_STEP_MS = 1000 / (2 * Math.PI);
/** cWinMagicland::TSPaint's: 1000 / elapsed <= 26. */
const MAGIC_STEP_MS = 1000 / 26;
/** cWinStudiotown::TSPaint's: 1000 / elapsed <= 20 (lbl_105BCDF8 1000, 20; +0x454). */
const STUDIO_STEP_MS = 1000 / 20;
/** TSOnTimerMsg period; the first tick enables the lot rollovers. */
const TIMER_MS = 1000;
/** cWinLotBtn::InitData: the lots' tooltip unfurl time. */
const UNFURL_MS = 0x4b;

/** UIText STR# 131 "BulldozeModeStrs" (title, text pairs) and STR# 132 "MoveInModeStrs". */
const STR_BULLDOZE = 131;
const STR_MOVE_IN = 132;
/** UIText STR# 171: the filter tooltips. */
const STR_FILTER_TIPS = 171;
/** UIText STR# 143 (the family import dialog), 144 (entry 5: "Delete"), 154 (entries 0x12 / 0x13: delete the file?; 0x14 / 0x15: wrong character set). */
const STR_IMPORT_FAMILY = 0x8f;
const STR_IMPORT_DELETE = 0x90;
const STR_IMPORT_MISC = 0x9a;
/** cWinPictureDialog::SetKey codes. */
const KEY_RETURN = 0x0d;
const KEY_ESCAPE = 0x1b;
/** lbl_105BD254 +0x199 / +0x1b4: ImportFamily's error box (English literals in the code). */
const IMPORT_ERROR_TEXT = "Couldn't import the family";
const IMPORT_ERROR_TITLE = "Error";

/** One credits window at a time (lbl_105C2EF0); one family picker at a time (cWinMagicland, lbl_105C4559). */
let creditsOpen = false;
let pickFamilyOpen = false;

/** UIText STR# 133 "RegularModeStrs" (lbl_105BD240) and STR# 261 "Visit Mode Magictown Strings" (lbl_105BD25C). */
const STR_REGULAR = 133;
const STR_VISIT_MAGIC = 261;
/** UIText STR# 134 "NghRollover": entries 32 / 33 are cWinMagicland +0xe0 / +0xe4 (Init, GetString(0x21 / 0x22)). */
const STR_ROLLOVER = 134;
/** kNghNoOneLivesHereIcon */
const NO_ONE_LIVES_HERE_ICON = 0x14b9;

export interface TownCallbacks {
  /**
   * The screen ended (DoModalWin result after the 999 fold): a house number
   * (a lot was picked; on the main screen cSimsApp::LoadGame is the caller's
   * job, done before the screen goes), or -20 (Exit: back to the
   * neighborhood, cSimsApp::DoNbhdScreen).
   */
  onEnd(result: number): void;
  /** A feature that is not ported (Import, Move In, ...). */
  onUnported(what: string): void;
  /** The house file side of Neighborhood::MoveOut (bulldoze), as on the neighborhood screen. */
  onMoveOutHouse?(house: number, bulldoze: boolean, store: NeighborhoodStore): Promise<boolean>;
  /**
   * cWinMagicland::MoveInModeLotHandler: cSimsApp::LoadGame(house, family),
   * the family moving into the lot; resolves whether the lot loaded (the
   * screen ends with the house number afterwards).
   */
  onMoveIn?(house: number, familyId: number, houseValue: number): Promise<boolean>;
}

/**
 * The water frames are keyed with (255, 1, 255) and JPEG-like speckles of
 * it; cTSBuffer's 16-bit (5:6:5) pixels make them equal to the magenta key,
 * so the key is matched at that precision here.
 */
async function keyMagenta565(bmp: ImageBitmap | null): Promise<ImageBitmap | null> {
  if (!bmp) return null;
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext("2d");
  if (!g) return bmp;
  g.drawImage(bmp, 0, 0);
  const img = g.getImageData(0, 0, bmp.width, bmp.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i]! >> 3 === 31 && d[i + 1]! >> 2 === 0 && d[i + 2]! >> 3 === 31) d[i + 3] = 0;
  }
  return createImageBitmap(img);
}

/** The water / overlay frame drawn over the map (the original's PostChildDraw part), under the popup. */
class WaterLayer extends TSWin {
  frame: ImageBitmap | null = null;
  overlays: ImageBitmap[] = [];
  ox = 0;
  oy = 0;

  override windowFromPoint(): TSWin | null {
    return null;
  }

  /** Magic Town's (0, 0x3e). */
  frameX = 0;
  frameY = 0;
  /** Magic Town's clouds and balloon, Studio Town's cars (drawn after the water). */
  sprites: MagiclandSprites | StudiotownCars | null = null;

  override tsPaint(g: Gfx): void {
    for (const o of this.overlays) g.blit(o, this.ox, this.oy);
    if (this.frame) g.blit(this.frame, this.ox + this.frameX, this.oy + this.frameY);
    if (this.sprites) {
      // The original draws into the 800 x 600 screen; above that resolution
      // the map's rectangle stands for the screen edges.
      g.ctx.save();
      g.ctx.beginPath();
      g.ctx.rect(g.ox + this.ox, g.oy + this.oy, 800, 600);
      g.ctx.clip();
      this.sprites.draw(g, this.ox, this.oy);
      g.ctx.restore();
    }
  }
}

export class WinTown extends TSWin implements LotBtnOwner {
  private readonly def: TownDef;
  /** +0x19c */
  private mode = TownMode.Regular;
  private largeMask: ImageBitmap | null = null;
  private background: ImageBitmap | null = null;
  private water: Array<ImageBitmap | null> = [];
  private dlgFrame: ImageBitmap | null = null;
  private font: FfnFont | null = null;
  /** +0x134 / +0x138 */
  private offX = 0;
  private offY = 0;
  private readonly lots = new Map<number, WinLotBtn>();
  private readonly buttons: TSWinBtn[] = [];
  private readonly filterBtns: TSWinBtn[] = [];
  private popup: WinLotPopup | null = null;
  private waterLayer: WaterLayer | null = null;
  /** +0x1c8: the water tick (0..9), +0x1e8 the last step. */
  private waterTick = -1;
  private lastWaterMs = 0;
  /** +0xf0: the current filter bit, +0xec its icon, +0xf8 the icon frame counter (0..5), +0xf4 the tick it followed. */
  private filterMode = 0;
  private filterIcon: ImageBitmap | null = null;
  private filterFrame = 0;
  private filterTickSeen = -1;
  /** +0xcc: the picker title. */
  private title = "";
  private openedMs = -1;
  private lastTimerMs = 0;
  /** Studio Town's car clock (cWinStudiotown::TSPaint's +0x454 / +0x358). */
  private lastSpritesMs = 0;
  private firstTick = true;
  private hoveredLot: WinLotBtn | null = null;
  private popupShownMs = 0;
  private popupTargetH = 0;
  /** +0x1f4: a command is being handled. */
  private handling = false;
  /** cWinMagicland +0xd4: the family moving in (TSOnCommand 0x20 from cWinPickFamily). */
  private moveInFamily = -1;
  /** cWinMagicland +0xd8: the fee Move In charges, written by the lot popup (GetMagicPopupIndex). */
  private moveInFee = 0;
  /** cWinMagicland +0xe0 / +0xe4: the magicoin cost of house 91 / of the other residential lots. */
  private costs = { house91: 0, other: 0 };

  constructor(
    private readonly ctx: GameContext,
    private readonly nb: Neighborhood,
    readonly town: Town,
    /** +0x118: the main screen (true) or the destination picker (false). */
    readonly mainScreen: boolean,
    private readonly callbacks: TownCallbacks,
    /**
     * cWinStudiotown +0xd0 / cWinMagicland +0xdc, set by ObjectModule::PostSim
     * before the picker shows: the picker cursor (see TownDef.pickerCursor).
     */
    readonly vehicleFlag = false,
  ) {
    super();
    this.def = TOWNS[town];
  }

  /** cWinDowntown::Init (and its three copies) */
  override async init(): Promise<boolean> {
    const { ctx, def } = this;
    const res = ctx.res;
    await this.copyTemplateLots();
    for (const s of def.initSounds) soundPlayer.playBySource(s, -1);
    // Every button clicks with the neighborhood sound (restored by shutdown).
    TSWinBtn.overrideDefaultUISound(null, UI.nhoodClick);

    const custom = def.gimexBackground ? await this.loadGimex(def.gimexBackground) : null;
    let overlays: Array<ImageBitmap | null>;
    if (custom) {
      this.background = custom;
      this.water = await Promise.all(def.gimexWater.map(async (n) => keyMagenta565(await this.loadGimex(n))));
      overlays = await Promise.all(def.gimexOverlays.map((n) => this.loadGimex(n)));
    } else {
      this.background = await res.image(def.background);
      this.water = await Promise.all(def.water.map(async (id) => keyMagenta565(await res.image(id).catch(() => null))));
      overlays = await Promise.all(def.overlays.map((id) => res.image(id).catch(() => null)));
    }
    const bar = await res.image(this.mainScreen ? 0x152e /* kDTBarBkg */ : def.pickerBar);
    if (!this.mainScreen) this.dlgFrame = await res.image(0x1538 /* kDTDlgBkg2 */);
    if (this.getW() > 800) this.largeMask = await res.image(def.largeMask).catch(() => null);
    // cTSFontSys acquire(1, 12, 0, 0), color MakeFillColor(255, 255, 255).
    this.font = await ctx.fonts.acquire(12);

    const w = this.getW();
    const h = this.getH();
    const bg = this.background;
    this.offX = bg.width < w ? (w - bg.width) >> 1 : 0;
    this.offY = bg.height < h ? (h - bg.height) >> 1 : 0;

    const map = new TSWinBtn(0, bg, 1);
    map.moveTo(this.offX, this.offY);
    this.childAdd(map);

    for (const house of def.houses) {
      const lot = new WinLotBtn(this, this.nb, false);
      lot.id = 1;
      if (!(await lot.init()) || !(await lot.loadHouseInfo(house))) continue;
      const p = lot.lotPoint();
      lot.centerOn(p.x, p.y);
      lot.clip = { left: 0, top: 0, right: 800, bottom: 600 };
      map.childAdd(lot);
      this.lots.set(house, lot);
    }

    const barBtn = new TSWinBtn(0, bar, 1);
    map.childAdd(barBtn);
    if (this.mainScreen) {
      for (let i = 0; i < def.buttons.length; i++) {
        const id = i === BTN_LOGO ? logoImage(UI_LANGUAGE) : def.buttons[i]!;
        const btn = new TSWinBtn(1, await res.image(id), i === BTN_LOGO ? 1 : 4);
        btn.tooltip = ctx.strings.get("UIText", def.tipsStr, i);
        const [x, y] = def.buttonPos[i]!;
        btn.moveTo(x, y);
        barBtn.childAdd(btn);
        this.buttons.push(btn);
      }
      this.buttons[BTN_BULLDOZE]!.mode = BTN_TOGGLE;
      this.buttons[BTN_BULLDOZE]!.sendOnDown = true;
    } else {
      // A random title of the three (StringSetBase::GetString(rand % 3 + 1)).
      const titles = ctx.strings.list("UIText", def.titlesStr);
      this.title = titles[Math.floor(Math.random() * 3)] ?? "Choose Destination...";
      await this.buildFilterToolbar(barBtn);
      await this.processFilterToolbarByType(this.loadCurrentFilter());
    }

    const water = new WaterLayer();
    water.setArea(0, 0, w, h);
    water.ox = this.offX;
    water.oy = this.offY;
    water.overlays = overlays.filter((o): o is ImageBitmap => o !== null);
    water.frameX = def.waterCycle?.x ?? 0;
    water.frameY = def.waterCycle?.y ?? 0;
    if (this.town === Town.Magictown) {
      // cWinMagicland +0x38c: the clouds only above the Low terrain detail.
      const sprites = new MagiclandSprites(getOptionsMgr().getTerrainDetail() !== TriState.Low);
      await sprites.load(res);
      water.sprites = sprites;
    } else if (this.town === Town.Studiotown) {
      const cars = new StudiotownCars();
      await cars.load(res);
      water.sprites = cars;
    }
    this.childAdd(water);
    this.waterLayer = water;

    if (this.town === Town.Magictown) {
      // Init: GetString(0x21) / GetString(0x22) of STR# 134, through atoi.
      this.costs = {
        house91: Number.parseInt(ctx.strings.get("UIText", STR_ROLLOVER, 0x20), 10) || 0,
        other: Number.parseInt(ctx.strings.get("UIText", STR_ROLLOVER, 0x21), 10) || 0,
      };
    }
    const popup = new WinLotPopup(ctx, this.nb, () => this.mode, this.town === Town.Magictown ? this.magicPopupSource() : null);
    if (!(await popup.init())) return false;
    this.childAdd(popup);
    this.popup = popup;

    this.setMode(TownMode.Regular);
    winMgr.setGlobalCursor(null);
    winMgr.setFocus(this);
    return true;
  }

  /**
   * Init: when <neighborhood>/Houses/House<first>.iff is missing, the
   * template lots (<template>/House%d.iff) and the description file are
   * copied into the neighborhood (cTSFile::Copy; here into the overlay).
   */
  private async copyTemplateLots(): Promise<void> {
    const { template } = this.def;
    const { files } = await fetchManifest();
    const has = (p: string): boolean => files.some((f) => f.path.toLowerCase() === `sims/${p}`.toLowerCase());
    if (has(this.nb.getHousePath(template.first))) return;
    const copy = async (from: string, to: string): Promise<void> => {
      const r = await assetFetch(`Sims/${from}`).catch(() => null);
      if (r?.ok) await writeGameFile(to, new Uint8Array(await r.arrayBuffer()));
    };
    for (let h = template.first; h < template.end; h++) {
      await copy(`${template.dir}/House${String(h).padStart(2, "0")}.iff`, this.nb.getHousePath(h));
    }
    await copy(`${template.dir}/${template.desc}`, `${this.nb.dir}/Houses/${template.desc}`);
  }

  /** LoadGimex(<neighborhood directory>/<name>), or null when the file is absent. */
  private async loadGimex(name: string): Promise<ImageBitmap | null> {
    const path = `Sims/${this.nb.dir}/${name}`.toLowerCase();
    const file = (await fetchManifest()).files.find((f) => f.path.toLowerCase() === path);
    if (!file) return null;
    const r = await assetFetch(file.path).catch(() => null);
    return r?.ok ? createImageBitmap(await r.blob()).catch(() => null) : null;
  }

  /**
   * BuildFilterToolbar: one 4-column button per filter at
   * (filterX0 + 0x32 i, 0x14) on the bar, tooltip UIText STR# 171, enabled
   * when one of the lots has that type.
   */
  private async buildFilterToolbar(bar: TSWinBtn): Promise<void> {
    const { def, ctx } = this;
    for (let i = 0; i < def.filters.length; i++) {
      const f = def.filters[i]!;
      const btn = new TSWinBtn(1, await ctx.res.image(f.button), 4);
      btn.tooltip = ctx.strings.get("UIText", STR_FILTER_TIPS, f.tip - 1);
      btn.moveTo(def.filterX0 + 0x32 * i, 0x14);
      btn.setEnabled([...this.lots.values()].some((l) => ((l.info?.lotTypeFlags ?? 0) & f.bit) !== 0));
      bar.childAdd(btn);
      this.filterBtns.push(btn);
    }
  }

  /**
   * LoadCurrentFilter: entry 1 of a string set in the neighborhood's
   * runtime file (GetStringConstant(10)), the default otherwise. The file is
   * not identified; the browser keeps the value per town instead.
   */
  private loadCurrentFilter(): number {
    try {
      const v = Number(localStorage.getItem(`thesimsweb.townFilter.${this.town}`));
      return v > 0 ? v : this.def.defaultFilter;
    } catch {
      return this.def.defaultFilter;
    }
  }

  /** SaveCurrentFilter (Shutdown) */
  private saveCurrentFilter(): void {
    try {
      localStorage.setItem(`thesimsweb.townFilter.${this.town}`, String(this.filterMode));
    } catch {
      // not kept
    }
  }

  /** ProcessFilterToolbarByType: the button of that bit (the first one for an unknown bit). */
  private processFilterToolbarByType(bit: number): Promise<void> {
    const i = this.def.filters.findIndex((f) => f.bit === bit);
    return this.processFilterToolbar(i < 0 ? 0 : i);
  }

  /** ProcessFilterToolbar: the previous filter's button up, SetFilterMode(bit), its button down. */
  private async processFilterToolbar(index: number): Promise<void> {
    const prev = this.def.filters.findIndex((f) => f.bit === this.filterMode);
    if (prev >= 0) this.filterBtns[prev]?.setState(0);
    const f = this.def.filters[index];
    if (!f) return;
    await this.setFilterMode(f.bit);
    this.filterBtns[index]?.setState(1);
  }

  /** SetFilterMode: the icon of the filter (kFilter*BMP). */
  private async setFilterMode(bit: number): Promise<void> {
    this.filterMode = bit;
    const icon = FILTER_ICONS[bit];
    this.filterIcon = icon ? await this.ctx.res.image(icon).catch(() => null) : null;
  }

  override shutdown(): void {
    if (!this.mainScreen) this.saveCurrentFilter();
    // cSoundPlayer::QuietBySourceID(-1): the town music stops.
    soundPlayer.quietBySourceID(-1);
    TSWinBtn.overrideDefaultUISound();
    winMgr.setGlobalCursor(null);
    super.shutdown();
  }

  private setCursor(cursor: string | null): void {
    this.winCursor = cursor;
    for (const lot of this.lots.values()) lot.winCursor = cursor;
    winMgr.applyCursor();
  }

  /**
   * cWinDowntown::SetMode. Leaving bulldoze mode: its button up, the lots
   * back in mode 0, "UI_Nhood_bdoze_cancel". Regular: Exit and the logo
   * enabled, Inet disabled, Import enabled when <data>/<town import dir>
   * holds a lot (not ported: disabled); the standard arrow on the main
   * screen, the town's picker cursor (TownDef.pickerCursor) in the picker.
   * Bulldoze: every bar button but Bulldoze disabled, cursor 0x22,
   * Bulldoze down, lots in mode 1, "UI_Nhood_bdoze".
   */
  private setMode(mode: TownMode): void {
    if (this.mode === TownMode.Evict) {
      this.buttons[BTN_BULLDOZE]?.setState(0);
      for (const lot of this.lots.values()) lot.setMode(0);
      soundPlayer.playBySource("UI_Nhood_bdoze_cancel", -4);
    } else if (this.mode === TownMode.MoveIn) {
      this.buttons[BTN_MOVE_IN]?.setState(0);
    }
    this.mode = mode;
    let cursor: string | null = null;
    if (mode === TownMode.MoveIn) {
      // cWinMagicland::SetMode(1): MoveInModeLotHandler / RegularModeBtnHandler, cursor 0x21, Move In down.
      cursor = getCursor(0x21);
      this.buttons[BTN_MOVE_IN]?.setState(1);
    } else if (mode === TownMode.Evict) {
      for (const i of [BTN_EXIT, BTN_INET, BTN_LOGO, BTN_IMPORT, BTN_MOVE_IN]) this.buttons[i]?.setEnabled(false);
      cursor = getCursor(0x22);
      this.buttons[BTN_BULLDOZE]?.setState(1);
      for (const lot of this.lots.values()) lot.setMode(1);
      soundPlayer.playBySource("UI_Nhood_bdoze", -4);
    } else {
      if (this.mainScreen) {
        this.buttons[BTN_EXIT]?.setEnabled(true);
        this.buttons[BTN_INET]?.setEnabled(false);
        this.buttons[BTN_LOGO]?.setEnabled(true);
        // CheckForNewImports: enabled when the import folder holds a lot.
        // Web: always enabled, the file picker opens when it is empty (as on
        // the neighborhood screen).
        this.buttons[BTN_IMPORT]?.setEnabled(true);
        this.buttons[BTN_MOVE_IN]?.setEnabled(true);
      }
      cursor = this.mainScreen ? getStandardCursor(4) : getCursor(this.def.pickerCursor[this.vehicleFlag ? 1 : 0]);
    }
    if (cursor) this.setCursor(cursor);
  }

  /**
   * cWinLotBtn::CalcRowCol with a town owner: the roof always dissolves,
   * except on Magic Town (cWinMagicland::ShouldAllowRoofDissolve): in move in
   * only on what the moving family can buy (GetFamilyInfo: true without one;
   * funds >= value, HouseInfo +0x10 set, nobody living there); in bulldoze not
   * on an empty lot without a house nor on the tutorial lot; in regular mode
   * not on an empty residential lot (90..92).
   */
  shouldAllowRoofDissolve(btn: WinLotBtn): boolean {
    if (this.town !== Town.Magictown) return true;
    const info = btn.info;
    if (!info) return false;
    switch (this.mode) {
      case TownMode.MoveIn: {
        const funds = this.moveInFunds;
        if (funds === null) return true;
        if (funds < info.value) return false;
        if (!info.isEmpty) return false;
        return info.familyNumber === -1;
      }
      case TownMode.Evict:
        if (info.familyNumber === -1 && !info.hasHouse) return false;
        return !info.isTutorial;
      default:
        if (info.houseNumber > 0x5c) return true;
        return info.familyNumber !== -1;
    }
  }

  /** GetFamilyInfo(+0xd4)'s funds (budget + net worth) for the roof rule, null without a family. */
  private moveInFunds: number | null = null;

  /** cWinLotPopup's view of this screen (+0xf8): mode, costs, the moving family. */
  private magicPopupSource(): MagicPopupSource {
    return {
      mode: () => this.mode,
      cost: (house) => (house === 0x5b ? this.costs.house91 : this.costs.other),
      setFee: (cost) => {
        this.moveInFee = cost;
      },
      movingFamily: async () => {
        if (this.moveInFamily === -1) return null;
        const store = await NeighborhoodStore.open(this.nb.dir);
        const f = store.family(this.moveInFamily);
        return f ? { name: f.name, funds: f.budget + f.netWorth, coins: store.magiCoins(f.id) } : null;
      },
      familyCoins: async (family) => (family === -1 ? 0 : (await NeighborhoodStore.open(this.nb.dir)).magiCoins(family)),
    };
  }

  lotEntered(btn: WinLotBtn): void {
    this.hoveredLot = btn;
    if (!this.firstTick) void this.showPopup(btn);
  }

  lotExited(btn: WinLotBtn): void {
    if (this.hoveredLot !== btn) return;
    this.hoveredLot = null;
    this.popup?.hideWindow();
  }

  /** cWinLotBtn::GetToolTipsWindow + cTSWin::GetTTPosition (as on the neighborhood screen). */
  private async showPopup(btn: WinLotBtn): Promise<void> {
    const popup = this.popup;
    if (!popup || !btn.info) return;
    await popup.setHouseInfo(btn.info);
    if (this.hoveredLot !== btn) return;
    const { w, h } = popup.fullSize();
    const o = btn.absOrigin();
    const me = this.absOrigin();
    const cursor = winMgr.cursorPosition();
    const left = o.x - me.x;
    const top = o.y - me.y;
    const right = left + btn.getW();
    const bottom = top + btn.getH();
    let x = Math.min(Math.max(cursor.x - me.x, left), right - 1);
    let y = top - h - 1;
    if (y < 3) y = bottom + 2;
    if (x < 0) x = 0;
    else if (x + w >= this.getW()) x = this.getW() - w - 1;
    if (y < 0) y = 0;
    else if (y + h >= this.getH()) y = this.getH() - h - 1;
    popup.setArea(x, y, x + w, y + h);
    this.popupTargetH = h;
    this.popupShownMs = performance.now();
    this.childToFront(popup);
    popup.showWindow();
  }

  /**
   * cWinDowntown::TSOnCommand: command 1 from a lot goes to the lot handler
   * of the mode, from a bar button to the button handler, from a filter
   * button to ProcessFilterToolbar; guarded by +0x1f4.
   */
  override tsOnCommand(cmd: number, source: TSWin): boolean {
    if (cmd !== 1 || this.handling) return false;
    const run = (p: Promise<void>): void => {
      this.handling = true;
      void p.finally(() => {
        this.handling = false;
        winMgr.setGlobalCursor(null);
      });
    };
    if (source instanceof WinLotBtn) {
      const house = source.houseNumber;
      run(
        this.mode === TownMode.Evict
          ? this.evictModeLotHandler(house)
          : this.mode === TownMode.MoveIn
            ? this.moveInModeLotHandler(house)
            : this.regularModeLotHandler(house),
      );
      return true;
    }
    const b = this.buttons.indexOf(source as TSWinBtn);
    if (b >= 0) {
      run(this.mode === TownMode.Evict ? this.evictModeBtnHandler(b) : this.regularModeBtnHandler(b));
      return true;
    }
    const f = this.filterBtns.indexOf(source as TSWinBtn);
    if (f >= 0) {
      run(this.processFilterToolbar(f));
      return true;
    }
    return false;
  }

  /**
   * cWinDowntown::RegularModeLotHandler: the main screen loads the lot
   * (cSimsApp::LoadGame) and posts the house number; the picker only posts
   * it. Studio and Magic Town play "bkground_fade" first. Magic Town's
   * residential lots (90..92) refuse an empty lot ("Personne ne vit ici !"
   * picture dialog) and load a family on vacation where it is (+0x13c).
   */
  private async regularModeLotHandler(house: number): Promise<void> {
    const lot = this.lots.get(house);
    if (!lot?.info) return;
    let target = house;
    if (this.town === Town.Magictown && house <= 0x5c) {
      if (!this.mainScreen || lot.info.familyNumber === -1) {
        // cWinPictureDialog with kNghNoOneLivesHereIcon, the title and text of
        // STR# 261 (the picker: a private lot) or STR# 133 (nobody lives here).
        await this.noOneLivesHere(this.mainScreen ? STR_REGULAR : STR_VISIT_MAGIC);
        return;
      }
      const store = await NeighborhoodStore.open(this.nb.dir);
      const id = store.familyOfHouse(house);
      const away = id !== undefined ? store.familyVacationLot(id) : 0;
      if (away) target = away;
    }
    if (this.def.lotSound && (this.mainScreen || this.town === Town.Magictown)) soundPlayer.playBySource(this.def.lotSound, -1);
    this.callbacks.onEnd(target);
  }

  /**
   * cWinDowntown::RegularModeBtnHandler: 0 Exit ("bkground_fade", ends with
   * 1020 -> -20, back to the neighborhood); 2 logo: cWinCredits over the
   * screen ("bkground_credits", then the town music again); 3 Import:
   * CycleThroughImports; 4 Bulldoze: bulldoze mode; Magic Town 5 Move In:
   * the family picker.
   */
  private async regularModeBtnHandler(index: number): Promise<void> {
    switch (index) {
      case BTN_EXIT:
        soundPlayer.playBySource(MUSIC.fade, -1);
        this.callbacks.onEnd(-20);
        return;
      case BTN_LOGO:
        return this.showCredits();
      case BTN_IMPORT:
        return this.cycleThroughImports();
      case BTN_BULLDOZE:
        this.setMode(TownMode.Evict);
        return;
      case BTN_MOVE_IN:
        return this.pickFamily();
      default:
        return;
    }
  }

  /**
   * The picture dialog of cWinMagicland::RegularModeLotHandler: the strings'
   * entry 0 as the title, entry 1 as the text, kNghNoOneLivesHereIcon, one
   * button with cTSWinMsgBox::GetButtonLabel(3) (OK), DoSimsModalDialog.
   */
  private async noOneLivesHere(set: number): Promise<void> {
    const dlg = new WinPictureDialog(this.ctx);
    const icon = await this.ctx.res.image(NO_ONE_LIVES_HERE_ICON).catch(() => null);
    if (icon) dlg.setImage(icon);
    dlg.setTitle(this.ctx.strings.get("UIText", set, 0));
    dlg.addText(this.ctx.strings.get("UIText", set, 1));
    dlg.addButton(TSWinMsgBox.getButtonLabel(this.ctx, IDOK), IDOK);
    await dlg.run();
  }

  /**
   * cWinMagicland::RegularModeBtnHandler(5): cWinPickFamily in Magic Town
   * mode (+0x141) over the screen's area, owned by this screen (+0x12c), one
   * at a time (lbl_105C4559). SetMode(0) runs first, so the picker's
   * preselection of +0xd4 (mode 1) and the bulldoze cancel sound (mode 2)
   * that follow it never happen. The lot popup is cleared, the screen hidden,
   * "bkground_family" plays while the picker is up, then "music_magictown";
   * Move In's button goes up unless the picker started Move In mode.
   */
  private async pickFamily(): Promise<void> {
    if (pickFamilyOpen) return;
    pickFamilyOpen = true;
    try {
      const dlg = new WinPickFamily(this.ctx, this.nb.dir);
      this.setMode(TownMode.Regular);
      this.popup?.hideWindow();
      this.hideWindow();
      dlg.setArea(this.area.left, this.area.top, this.area.right, this.area.bottom);
      dlg.setOwner({ moveIn: (id) => this.startMoveIn(id) });
      dlg.magicTown = true;
      soundPlayer.playBySource(MUSIC.family, -1);
      if (await dlg.init()) await winMgr.doModalWin(dlg);
      soundPlayer.playBySource(this.def.music, -1);
      this.showWindow();
      if (this.mode !== TownMode.MoveIn) this.buttons[BTN_MOVE_IN]?.setState(0);
      winMgr.setFocus(this);
    } finally {
      pickFamilyOpen = false;
    }
  }

  /** cWinMagicland::TSOnCommand(0x20): Move In mode for the family the picker sent (+0xd4). */
  private startMoveIn(familyId: number): void {
    this.setMode(TownMode.MoveIn);
    this.moveInFamily = familyId;
    void NeighborhoodStore.open(this.nb.dir).then((store) => {
      const f = store.family(familyId);
      this.moveInFunds = f ? f.budget + f.netWorth : null;
    });
  }

  /**
   * cWinMagicland::MoveInModeLotHandler. Only the residential lots 90..92
   * (else STR# 132 entries 22 / 23); the magicoin cost is +0xe0 for house 91,
   * +0xe4 otherwise. The tutorial lot: entries 16 / 17. Without the moving
   * family (GetFamilyInfo fails): back to regular mode. HouseInfo +0x10
   * clear: "too expensive" (2 / 3). An empty lot without a house: occupied
   * (14 / 15) when a family lives there, "too expensive" when the funds are
   * short, else "buy this lot?" (6 / 7, yes / no) and LoadGame(house, family),
   * no magicoins taken. A lot with a house, nobody living there, funds and
   * magicoins enough: "buy this house?" (0 / 1); yes: SetMode(0), every lot's
   * tutorial arrow off, LoadGame, then ChargeMagicCoinsFee(family, +0xd8).
   * Otherwise "too expensive" or occupied.
   * The magicoins are taken before the load here (the store is written
   * before Neighborhood::LoadHouse reads it); the original takes them from the
   * Neighborhood in memory right after a successful LoadGame.
   */
  private async moveInModeLotHandler(house: number): Promise<void> {
    const str = (i: number): string => this.ctx.strings.get("UIText", STR_MOVE_IN, i);
    const message = (title: number, type = MB_OK): Promise<number> => TSWinMsgBox.show(this.ctx, str(title + 1), str(title), type);
    if (house < 0x5a || house > 0x5c) {
      await message(22);
      return;
    }
    const cost = house === 0x5b ? this.costs.house91 : this.costs.other;
    const info = this.lots.get(house)?.info;
    if (!info) return;
    if (info.isTutorial) {
      await message(16);
      return;
    }
    const store = await NeighborhoodStore.open(this.nb.dir);
    const fam = store.family(this.moveInFamily);
    if (!fam) {
      this.setMode(TownMode.Regular);
      return;
    }
    const funds = fam.budget + fam.netWorth;
    if (!info.isEmpty) {
      await message(2);
      return;
    }
    if (!info.hasHouse) {
      if (info.familyNumber !== -1) {
        await message(14);
        return;
      }
      if (funds < info.value) {
        await message(2);
        return;
      }
      if ((await message(6, MB_YESNO)) !== IDYES) return;
      await this.loadMovingIn(house, fam.id, info.value, 0, store);
      return;
    }
    if (info.familyNumber !== -1) {
      await message(14);
      return;
    }
    if (info.value > funds || cost > store.magiCoins(fam.id)) {
      await message(2);
      return;
    }
    if ((await message(0, MB_YESNO)) !== IDYES) return;
    this.setMode(TownMode.Regular);
    for (const lot of this.lots.values()) void lot.hiliteForTutorial(this.ctx, false);
    await this.loadMovingIn(house, fam.id, info.value, this.moveInFee, store);
  }

  /**
   * cSimsApp::LoadGame(house, family) and the screen's end (TSWinMsgPost
   * 0x10 with the house), after cWinMagicland::ChargeMagicCoinsFee(family,
   * fee): the members in order give their magicoin tokens
   * (SimInventory::RemoveCountTokens) until the fee is paid.
   */
  private async loadMovingIn(house: number, familyId: number, value: number, fee: number, store: NeighborhoodStore): Promise<void> {
    if (!this.callbacks.onMoveIn) {
      this.callbacks.onUnported(`${this.def.cls}::MoveInModeLotHandler without a LoadGame callback`);
      return;
    }
    let left = fee;
    for (const guid of store.family(familyId)?.memberGuids ?? []) {
      if (left === 0) break;
      const id = store.neighborIdOf(guid);
      if (id === undefined) continue;
      const take = Math.min(store.findToken(id, 7, 0x99e81bec), left);
      store.removeCountTokens(id, 7, 0x99e81bec, take);
      left -= take;
    }
    if (fee !== 0) await store.save();
    await this.callbacks.onMoveIn(house, familyId, value);
  }

  /**
   * RegularModeBtnHandler(3). cWinDowntown / cWinVacation /
   * cWinStudiotown::CycleThroughImports: every *.dtl / *.vil / *.stl lot file
   * of the import folder once; cWinMagicland: CycleResidentialImports (the
   * *.mtf families) then CycleCommunityImports (*.mtl). When a lot changed
   * the screen is built again (DoDowntownScreen(1) and friends: here the lots
   * reload their house info and thumbnails).
   * Web: with nothing to import, the file picker opens first.
   */
  private async cycleThroughImports(): Promise<void> {
    const dir = this.nb.dir;
    const magic = this.town === Town.Magictown;
    let families = magic ? await listTownImports(dir, "mtf") : [];
    let lots = await listTownImports(dir, this.def.importExt);
    if (!families.length && !lots.length) {
      if (!(await pickAndUploadImports(dir)).length) return;
      families = magic ? await listTownImports(dir, "mtf") : [];
      lots = await listTownImports(dir, this.def.importExt);
    }
    const changed: number[] = [];
    for (const path of families) {
      const house = await this.residentialImport(path);
      if (house) changed.push(house);
    }
    for (const path of lots) {
      const house = await this.lotImport(path);
      if (house) changed.push(house);
    }
    if (!changed.length) return;
    await this.nb.reloadData();
    for (const house of changed) await this.lots.get(house)?.reloadThumbnail();
  }

  private importStr(set: number, i: number): string {
    return this.ctx.strings.get("UIText", set, i);
  }

  /** The "Delete" answer: the STR# 154 confirmation (title entry 0x12, text 0x13, 1-based), then CTGFileManager::DeleteFile. */
  private async confirmDeleteImport(path: string): Promise<void> {
    const r = await TSWinMsgBox.show(this.ctx, this.importStr(STR_IMPORT_MISC, 0x12), this.importStr(STR_IMPORT_MISC, 0x11), MB_YESNO);
    if (r === IDYES) await deleteGameFile(path).catch(() => console.warn(`[import] ${path} is read-only`));
  }

  /** HiliteForImport on the lot of `house` (0: every lot off). */
  private hiliteLot(house: number): void {
    if (house === 0) for (const lot of this.lots.values()) lot.hiliteForImport(false);
    else this.lots.get(house)?.hiliteForImport(true);
  }

  /** A lot button's absolute area (the rect SetPositioning(2) keeps the dialog off). */
  private lotRect(house: number): { left: number; top: number; right: number; bottom: number } | undefined {
    const lot = this.lots.get(house);
    if (!lot) return undefined;
    const o = lot.absOrigin();
    return { left: o.x, top: o.y, right: o.x + lot.getW(), bottom: o.y + lot.getH() };
  }

  /**
   * One lot file of CycleThroughImports / CycleCommunityImports: its STR#
   * 2000 name, description and house (entries 1..3), a cWinPictureDialog
   * with both texts, Yes (STR# 143 entry 7, Return) / No (8, Escape) /
   * Delete (STR# 144 entry 5), the lot picture (BMP_ 0x200), the title
   * (entry 4 of TownDef.importTitleStr), the lot outlined and kept clear
   * (Downtown, Vacation and Studio Town leave the outline on). cWinVacation
   * refuses a lot a family is on vacation on (STR# 131 entries 22 / 23)
   * before acting on the answer. Yes: the house file replaced by the lot file
   * (deleted after), the name and description written into the town's
   * description file. Resolves with the house when a lot came in.
   */
  private async lotImport(path: string): Promise<number> {
    const lot = await getLotImportInfo(path);
    if (!lot) return 0;
    const house = lot.house;
    const dlg = new WinPictureDialog(this.ctx);
    dlg.addText(lot.name);
    dlg.addText(lot.description);
    dlg.addButton(this.importStr(STR_IMPORT_FAMILY, 6), 1);
    dlg.setKey(1, KEY_RETURN);
    dlg.addButton(this.importStr(STR_IMPORT_FAMILY, 7), 0);
    dlg.setKey(0, KEY_ESCAPE);
    dlg.addButton(this.importStr(STR_IMPORT_DELETE, 4), 2);
    if (lot.image) dlg.setImage(lot.image);
    dlg.setTitle(this.importStr(this.def.importTitleStr, 3));
    this.hiliteLot(house);
    const rect = this.lotRect(house);
    if (rect) dlg.setPositioning(PD_AVOID_RECT, rect);
    const r = await dlg.run();
    if (this.town === Town.Magictown && r === 0) this.hiliteLot(0);
    if (r === 0) return 0;
    if (this.town === Town.Vacation) {
      const store = await NeighborhoodStore.open(this.nb.dir);
      if (store.familyIds().some((id) => store.familyVacationLot(id) === house)) {
        await TSWinMsgBox.show(this.ctx, this.importStr(STR_BULLDOZE, 22), this.importStr(STR_BULLDOZE, 21));
        return 0;
      }
    }
    if (r === 2) {
      await this.confirmDeleteImport(path);
      return 0;
    }
    await importLotFile(this.nb.dir, lot);
    await setLotDescription(this.nb.dir, this.def.template.desc, house, lot.name, lot.description);
    return house;
  }

  /**
   * One family file of cWinMagicland::CycleResidentialImports (*.mtf):
   * GetImportInfoForFile, the STR# 143 dialog ("$family" in entry 1; no lot:
   * entry 2; a lot of 90..98: entry 3 with the family living there, 4 empty,
   * 5 vacant house, "$lot" the house number), Yes / No / Delete, the lot
   * picture, title entry 9, the lot outlined. A lot whose family is on
   * vacation: STR# 131 entries 22 / 23. Yes: the lot zoned residential,
   * ImportFamily (failure: the zoning back, "Couldn't import the family").
   * A file of another character set (isWrongCharacterSet; not the tutorial
   * lot) gets the STR# 154 entries 20 / 21 box instead: OK
   * (cTSWinMsgBox::GetButtonLabel(1)) / Delete (STR# 144 entry 5, then the
   * STR# 154 question). Resolves with the house when a family came onto one.
   */
  private async residentialImport(path: string): Promise<number> {
    const info = await getImportInfoForFile(path);
    if (!info) return 0;
    if (isWrongCharacterSet(info)) {
      const box = new WinPictureDialog(this.ctx);
      box.addText(this.importStr(STR_IMPORT_MISC, 0x13));
      box.addText(this.importStr(STR_IMPORT_MISC, 0x14));
      box.addButton(TSWinMsgBox.getButtonLabel(this.ctx, IDOK), 1);
      box.addButton(this.importStr(STR_IMPORT_DELETE, 4), 2);
      if ((await box.run()) === 2) await this.confirmDeleteImport(path);
      return 0;
    }
    const house = info.house;
    const s = (i: number): string => this.importStr(STR_IMPORT_FAMILY, i - 1);
    const dlg = new WinPictureDialog(this.ctx);
    dlg.addText(s(1).replace("$family", info.familyName));
    let where = "";
    if (house === 0) {
      where = s(2);
    } else {
      const lot = house >= 0x5a && house <= 0x62 ? this.lots.get(house)?.info : undefined;
      if (lot) {
        if (lot.familyNumber === -1) where = lot.hasHouse ? s(5) : s(4);
        else where = s(3).replace("$family", lot.familyName);
        where = where.replace("$lot", String(house));
      }
    }
    dlg.addText(where);
    dlg.addButton(s(7), 1);
    dlg.setKey(1, KEY_RETURN);
    dlg.addButton(s(8), 0);
    dlg.setKey(0, KEY_ESCAPE);
    dlg.addButton(this.importStr(STR_IMPORT_DELETE, 4), 2);
    if (info.image) dlg.setImage(info.image);
    dlg.setTitle(s(9));
    if (house !== 0) {
      this.hiliteLot(house);
      const rect = this.lotRect(house);
      if (rect) dlg.setPositioning(PD_AVOID_RECT, rect);
    }
    const r = await dlg.run();
    if (house !== 0) this.hiliteLot(0);
    if (r === 0) return 0;
    const store = await NeighborhoodStore.open(this.nb.dir);
    const resident = store.familyOfHouse(house);
    if (house !== 0 && resident !== undefined && store.familyVacationLot(resident) !== 0) {
      await TSWinMsgBox.show(this.ctx, this.importStr(STR_BULLDOZE, 22), this.importStr(STR_BULLDOZE, 21));
      return 0;
    }
    if (r === 2) {
      await this.confirmDeleteImport(path);
      return 0;
    }
    const zone = this.nb.getZoningType(house);
    await this.nb.setZoningType(house, Zone.Residential);
    winMgr.setGlobalCursor(getCursor(3));
    let ok = false;
    try {
      ok = (await importFamily(this.nb.dir, info).catch((e: unknown) => (console.error("[import]", e), null))) !== null;
    } finally {
      winMgr.setGlobalCursor(null);
    }
    if (!ok) {
      await this.nb.setZoningType(house, zone);
      await TSWinMsgBox.show(this.ctx, IMPORT_ERROR_TEXT, IMPORT_ERROR_TITLE, MB_OK);
      return 0;
    }
    return house;
  }

  /** cWinDowntown::EvictModeBtnHandler: Bulldoze leaves the mode, Exit leaves it and acts, the others act. */
  private async evictModeBtnHandler(index: number): Promise<void> {
    if (index === BTN_BULLDOZE) {
      this.setMode(TownMode.Regular);
      return;
    }
    if (index === BTN_EXIT) {
      soundPlayer.playBySource("UI_Nhood_bdoze_cancel", -4);
      return this.regularModeBtnHandler(index);
    }
    return this.regularModeBtnHandler(index);
  }

  /**
   * cWinDowntown::EvictModeLotHandler: no house -> cancel sound, STR# 132
   * entries 5 / 4, bulldoze sound again; a house -> yes / no STR# 131
   * entries 1 / 0, "UI_Nhood_bdoze_demolish", the wait cursor around
   * EvictFamily(house, bulldoze), failure STR# 131 entries 11 / 10, then
   * ReloadThumbnail.
   */
  private async evictModeLotHandler(house: number): Promise<void> {
    const lot = this.lots.get(house);
    const info = lot?.info;
    if (!lot || !info) return;
    const str = (set: number, i: number): string => this.ctx.strings.get("UIText", set, i);
    if (info.familyNumber !== -1) return;
    if (!info.hasHouse) {
      soundPlayer.playBySource("UI_Nhood_bdoze_cancel", -4);
      await TSWinMsgBox.show(this.ctx, str(STR_MOVE_IN, 5), str(STR_MOVE_IN, 4));
      soundPlayer.playBySource("UI_Nhood_bdoze", -4);
      return;
    }
    if ((await TSWinMsgBox.show(this.ctx, str(STR_BULLDOZE, 1), str(STR_BULLDOZE, 0), MB_YESNO)) !== IDYES) return;
    soundPlayer.playBySource("UI_Nhood_bdoze_demolish", -4);
    winMgr.setGlobalCursor(getCursor(3));
    let ok = false;
    try {
      const store = await NeighborhoodStore.open(this.nb.dir);
      store.moveOutFamily(house);
      ok = this.callbacks.onMoveOutHouse ? await this.callbacks.onMoveOutHouse(house, true, store) : false;
      if (ok) await store.save();
      else if (!this.callbacks.onMoveOutHouse) this.callbacks.onUnported(`Neighborhood::MoveOut house file side (house ${house})`);
    } finally {
      winMgr.setGlobalCursor(null);
    }
    if (!ok) {
      await TSWinMsgBox.show(this.ctx, str(STR_BULLDOZE, 11), str(STR_BULLDOZE, 10));
      return;
    }
    await lot.reloadThumbnail();
  }

  /** RegularModeBtnHandler(logo): one cWinCredits at a time over the hidden screen. */
  private async showCredits(): Promise<void> {
    if (creditsOpen) return;
    creditsOpen = true;
    try {
      const dlg = new WinCredits(this.ctx);
      this.hideWindow();
      soundPlayer.playBySource(this.def.credits, -1);
      dlg.setArea(this.area.left, this.area.top, this.area.right, this.area.bottom);
      if (await dlg.init()) await winMgr.doModalWin(dlg);
      soundPlayer.playBySource(this.def.music, -1);
      this.showWindow();
      winMgr.setFocus(this);
    } finally {
      creditsOpen = false;
    }
  }

  /** cWinDowntown::TSOnKeyDown: Escape leaves bulldoze mode (cWinMagicland: and Move In mode). */
  override tsOnKeyDown(key: string): boolean {
    if (key === "Escape") {
      if (this.mode !== TownMode.Regular) this.setMode(TownMode.Regular);
      return true;
    }
    return super.tsOnKeyDown(key);
  }

  override pump(now: number): void {
    if (this.openedMs < 0) {
      this.openedMs = now;
      this.lastTimerMs = now;
      this.lastWaterMs = now;
    }
    // TSOnTimerMsg every second; the first tick turns the lot rollovers on
    // (CheckNeighborhoodFileLocked and the Nessie easter egg are not ported).
    if (now - this.lastTimerMs >= TIMER_MS) {
      this.lastTimerMs = now;
      if (this.firstTick) {
        this.firstTick = false;
        if (this.hoveredLot) void this.showPopup(this.hoveredLot);
      }
    }
    const popup = this.popup;
    if (popup?.isVisible()) {
      const t = Math.min(1, (now - this.popupShownMs) / UNFURL_MS);
      const shown = Math.trunc(this.popupTargetH * t + 0.5);
      const bottom = popup.area.top + popup.getH();
      const full = popup.fullSize();
      if (popup.getH() !== shown) popup.setArea(popup.area.left, bottom - shown, popup.area.left + full.w, bottom);
    }
    if (this.def.waterCycle) {
      // cWinMagicland::TSPaint's clock (1000 / elapsed <= 26, lbl_1059C508)
      // and cMagiclandSprites::DoWater: a frame every 5 steps, 0..5.
      if (now - this.lastWaterMs >= MAGIC_STEP_MS) {
        this.lastWaterMs = now;
        this.waterTick = (this.waterTick + 1) % (5 * this.water.length);
        if (this.waterLayer) this.waterLayer.frame = this.water[Math.trunc(this.waterTick / 5)] ?? null;
        this.waterLayer?.sprites?.step();
      }
    } else {
      if (now - this.lastWaterMs >= WATER_STEP_MS) {
        // TSPaint's clock: ticks 0..9, frame = tick for 0..4, 9 - tick after.
        this.lastWaterMs = now;
        this.waterTick = (this.waterTick + 1) % 10;
        const i = this.waterTick > 4 ? 9 - this.waterTick : this.waterTick;
        if (this.waterLayer) this.waterLayer.frame = this.water[i] ?? null;
      }
      // Studio Town's cars: cWinStudiotown::TSPaint's own clock (+0x358).
      if (this.waterLayer?.sprites && now - this.lastSpritesMs >= STUDIO_STEP_MS) {
        this.lastSpritesMs = now;
        this.waterLayer.sprites.step();
      }
    }
    super.pump(now);
  }

  override tsPaint(g: Gfx): void {
    if (this.largeMask) g.blit(this.largeMask, 0, 0);
  }

  /**
   * cWinDowntown::PostChildDraw (picker): DrawFilters (the icon over each
   * lot of the filter's type, frames 0 1 2 2 1 0 advanced with the water
   * clock), the title (shadow (30, 30, 30) at (0x192, 0xc), white at
   * (400, 10), both centered), then the kDTDlgBkg2 frame over everything.
   */
  override postChildDraw(g: Gfx): void {
    if (this.mainScreen) return;
    this.drawFilters(g);
    const font = this.font;
    if (font && this.title) {
      const a = font.textArea(this.title);
      font.drawText(g.ctx, this.title, g.ox + this.offX + 0x192 - Math.trunc(a.w / 2), g.oy + this.offY + 0xc - Math.trunc(a.h / 2), "rgb(30,30,30)");
      font.drawText(g.ctx, this.title, g.ox + this.offX + 400 - Math.trunc(a.w / 2), g.oy + this.offY + 10 - Math.trunc(a.h / 2), "#ffffff");
    }
    if (this.dlgFrame) g.blit(this.dlgFrame, this.offX, this.offY);
  }

  /** cWinDowntown::DrawFilters / DrawFilterAt */
  private drawFilters(g: Gfx): void {
    if (this.filterTickSeen !== this.waterTick) {
      this.filterTickSeen = this.waterTick;
      this.filterFrame = (this.filterFrame + 1) % 6;
    }
    const icon = this.filterIcon;
    if (!icon || this.filterMode === 0) return;
    const fw = Math.trunc(icon.width / 3);
    const frame = [0, 1, 2, 2, 1, 0][this.filterFrame]!;
    for (const lot of this.lots.values()) {
      const info = lot.info;
      if (!info || (info.lotTypeFlags & this.filterMode) === 0) continue;
      if (this.town === Town.Magictown && info.houseNumber <= 0x5c) continue;
      const dy = this.def.lowIconHouses.includes(info.houseNumber) ? -10 : -0x46;
      g.blitPart(icon, frame * fw, 0, fw, icon.height, this.offX + info.lotX - 0x18, this.offY + info.lotY + dy);
    }
  }
}
