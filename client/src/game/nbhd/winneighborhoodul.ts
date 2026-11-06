/**
 * The neighborhood screen of the Unleashed-era game (cWinNeighborhoodUL),
 * created by cSimsApp::ShowNbhdDialog with "main screen" = true (the
 * alternative cWinNeighborhoodVC is only used when Unleashed is absent, which
 * the Complete Collection never is).
 *
 * Window tree, as built by Init:
 *   this (full screen)                      TSPaint: kLargeMask behind everything
 *    └ map button [99]                       the 800x600 background, centered
 *       └ waves button [100]                 kNghFrameDelta1..6 frame, cycled by TSPaint
 *          ├ lot buttons                     one per LotZoning entry below house 81
 *          ├ bar [0x60]                      kNghBarBkg at the map's top-left
 *          │  └ 13 buttons                   positions from the static table below
 *          └ credits button (index 4)        (195, 540) on the map
 *   PostChildDraw: the neighborhood number, centered in the kNghCurrent box.
 *
 * Destination picker (+0x111 cleared, TryDialog kind 8): the bar is
 * kFilterToolbar with the seven lot type filters (BuildFilterToolbar), the
 * credits button stays (disabled), the other twelve are not created; a random
 * title of UIText STR# 0xd4 is drawn at the top; PostChildDraw outlines every
 * community lot in blue and draws the filter's icon over the lots of its type.
 *
 * Buttons (index: resource, UIText STR# 151 tooltip entry):
 *   0 MoveIn  1 Bulldoze  2 Exit  3 Inet  4 Credits  5 Previous  6 Next
 *   7 Import  8 Downtown  9 Sims logo  10 Vacation  11 Rezone  12 Studio Town
 *   13 Magic Town.
 * Regular mode (RegularModeBtnHandler / RegularModeLotHandler): a lot click
 * loads that house; Exit and the town buttons end the screen with the codes
 * cSimsApp::ShowNbhdDialog reads (DoModalWin result 1001 -> -1, 1020 -> -20...).
 */

import { assetFetch, fetchManifest } from "../../engine/assets.js";
import { MUSIC, soundPlayer, UI } from "../audio/index.js";
import type { GameContext } from "../context.js";
import type { FfnFont } from "../res/ffn.js";
import { UI_LANGUAGE } from "../res/uires.js";
import { BTN_TOGGLE, TSWinBtn } from "../ui/btn.js";
import { winMgr } from "../ui/winmgr.js";
import { Gfx, TSWin, WF_ENABLED } from "../ui/tswin.js";
import { doInternetUpdate, exportFamilyHTML } from "./exporthtml.js";
import { getOptionsMgr } from "../optionsmgr.js";
import { listNeighborhoodDirs, neighborhoodNumber, type Neighborhood } from "./nghinterface.js";
import { WinLotBtn, type LotBtnOwner } from "./winlotbtn.js";
import { WinLotPopup } from "./winlotpopup.js";
import { WinPickFamily } from "../cas/winpickfamily.js";
import { NeighborhoodStore } from "../data/nbhdstore.js";
import { IDOK, IDYES, MB_OK, MB_OKCANCEL, MB_YESNO, TSWinMsgBox } from "../ui/msgbox.js";
import { getCursor, getStandardCursor } from "../ui/cursor.js";
import { WinRadioDialogBox } from "../ui/radiodialog.js";
import { deleteGameFile, writeGameFile } from "../data/files.js";
import { buildIff, parseIff, stringSetMultiSave } from "../data/iff.js";
import { makeMoneyString, Zone } from "./nghinterface.js";
import { WinCredits } from "./wincredits.js";
import { getImportInfoForFile, getLotImportInfo, hasImports, importFamily, importLotFile, isWrongCharacterSet, listImports, needsUnleashedImport, pickAndUploadImports, tryImportUnleashedFamilies, uploadImports, type ImportInfo, type LotImportInfo } from "./imports.js";
import { PD_AVOID_RECT, WinPictureDialog } from "../ui/picturedialog.js";
import { getCheatCodeManager, type CheatCommandLine } from "../ui/cheat.js";
import {
  doFirstTimeTouristFamilies,
  doFirstTimeTownies,
  refillNpcPools,
  refillTouristFamilies,
  refillTownies,
  TOURIST_FAMILY_COUNT,
  TOWNIE_COUNT,
} from "./townies.js";
import { importTutorialIfPresent } from "./tutorial.js";
import { NESSIE_BUSY, Nessie } from "./nessie.js";
import { getNextRandomNumber } from "../world/random.js";

/** cWinNeighborhood::Mode */
export const enum NbhdMode {
  Regular = 0,
  MoveIn = 1,
  Evict = 2,
  Rezone = 3,
  Visit = 4,
  MoveLots = 5,
}

/** Results posted with TSWinMsgPost(0x10, ...) by the regular mode buttons (after the 999 fold). */
export const NBHD_EXIT = -1;
export const NBHD_DOWNTOWN = -20;
export const NBHD_VACATION = -30;
export const NBHD_STUDIOTOWN = -40;
export const NBHD_MAGICTOWN = -50;

/** What cSimsApp::ShowNbhdDialog does with each end code (none of these screens is ported yet). */
export const NBHD_END_NOTES: Readonly<Record<number, string>> = {
  [NBHD_EXIT]: "cSimsApp::Quit after the confirmation (the browser page cannot close itself)",
  [NBHD_DOWNTOWN]: "cWinDowntown (Hot Date town screen, ShowNbhdDialog flag for -20)",
  [NBHD_VACATION]: "cWinVacation (Vacation island screen, ShowNbhdDialog flag for -30)",
  [NBHD_STUDIOTOWN]: "cWinStudiotown (Superstar Studio Town screen, ShowNbhdDialog flag for -40)",
  [NBHD_MAGICTOWN]: "cWinMagicland (Makin' Magic Magic Town screen, ShowNbhdDialog flag for -50)",
};

/** Button indices (cWinNeighborhoodUL+0x148 + 4 * index). */
const BTN_MOVE_IN = 0;
const BTN_BULLDOZE = 1;
const BTN_EXIT = 2;
const BTN_INET = 3;
const BTN_CREDITS = 4;
const BTN_PREVIOUS = 5;
const BTN_NEXT = 6;
const BTN_IMPORT = 7;
const BTN_DOWNTOWN = 8;
const BTN_LOGO = 9;
const BTN_VACATION = 10;
const BTN_REZONE = 11;
const BTN_STUDIOTOWN = 12;
const BTN_MAGICTOWN = 13;
const BTN_COUNT = 14;

/** lbl_105BCCE4: button bitmaps (Res_Nbhd ids); entries 4 and 9 are replaced per language. */
const BTN_IMAGES = [5200, 5201, 5202, 5306, 5307, 5204, 5205, 5207, 5208, 5210, 5213, 5215, 5216, 5221];

/** Init's two language switches: [credits button, Sims logo] for Res_Languages ids. */
function languageImages(lang: number): [number, number] {
  switch (lang) {
    case 1:
      return [5307, 5210]; // US English keeps the table
    case 3:
      return [0x14c0, 0x1534]; // kNghCreditsFr, kNghSimsLogo_FR
    case 4:
      return [0x14c1, 0x1535];
    case 6:
      return [0x14c2, 0x1533];
    case 15:
      return [0x14c4, 0x1536];
    default:
      return [0x14c3, 0x152d]; // kNghCreditsEn, kNghSimsLogoEn
  }
}

/** lbl_105BCCE0 (set by the file's static initializer): button positions; index 4 is on the map, the rest on the bar. */
const BTN_POS: ReadonlyArray<readonly [number, number]> = [
  [200, 0], [300, 0], [600, 0], [762, 0], [195, 540], [106, 0], [141, 0],
  [250, 0], [400, 0], [5, 0], [450, 0], [350, 0], [500, 0], [550, 0],
];

/** lbl_105C33E0: left of the neighborhood number box on the map (top is 3). */
const CURRENT_BOX_X = 124;
const CURRENT_BOX_Y = 3;

/** UIText STR# 151 "NghbBtnTips" */
const STR_BTN_TIPS = 151;

/** A lot type filter of the picker's toolbar (BuildFilterToolbar / ProcessFilterToolbar jump tables). */
interface Filter {
  /** Button bitmap (kFilter*Button, 4 frame columns). */
  button: number;
  /** HouseInfo +0x20 bit (cWinLotBtn +0x1ac). */
  bit: number;
  /** 1-based tooltip entry of UIText STR# 0xab. */
  tip: number;
  /** SetFilterMode: the icon drawn over the lots (kFilter*BMP, 3 frames side by side). */
  icon: number;
}

/** In button order (+0xd4..+0xec); positions lbl_105BCD54: (0xe1 + 0x32 i, 0x14) on the bar. */
const FILTERS: readonly Filter[] = [
  { button: 0x13c8, bit: 0x10, tip: 1, icon: 0x1346 }, // kFilterDogCatButton, kFilterPetBMP
  { button: 0x13c9, bit: 0x20, tip: 2, icon: 0x1347 }, // kFilterSmallAnimalButton, kFilterSmallAnimalBMP
  { button: 0x13c7, bit: 0x08, tip: 3, icon: 0x1345 }, // kFilterShoppingButton, kFilterShoppingBMP
  { button: 0x13c6, bit: 0x04, tip: 4, icon: 0x1344 }, // kFilterGardeningButton, kFilterGardeningBMP
  { button: 0x13c5, bit: 0x02, tip: 5, icon: 0x1343 }, // kFilterFoodButton, kFilterFoodBMP
  { button: 0x13ca, bit: 0x40, tip: 6, icon: 0x1348 }, // kFilterRecreationButton, kFilterParkBMP
  { button: 0x13c4, bit: 0x01, tip: 7, icon: 0x1342 }, // kFilterLodgingButton, kFilterLodgingBMP
];
const FILTER_X0 = 0xe1;
const FILTER_DX = 0x32;
const FILTER_Y = 0x14;
/** LoadCurrentFilter's value when its file cannot be read. */
const DEFAULT_FILTER = 2;
/** UIText STR# 0xab: the filter tooltips. */
const STR_FILTER_TIPS = 0xab;
/** UIText STR# 0xd4: the picker's titles (one of the first three at random). */
const STR_PICKER_TITLES = 0xd4;
/** UIText STR# 0x104: VisitModeLotHandler's residential lot message (entry 0 title, 1 text). */
const STR_VISIT_RESIDENTIAL = 0x104;
/** Init's cheats (main screen), with their usage texts (lbl_105BCD5C strings). */
const CHEATS: ReadonlyArray<readonly [string, string]> = [
  ["load", "Usage: load [house num], between 0 and 18"],
  ["move_lots", "Usage: move_lots to enter lot moving mode. Hit escape to exit it."],
  ["show_zones", "Usage: show_zones on/off to hide/disable the lot zoning outlines."],
  ["show_filter", "Usage: show_filter 0 - 7. 0 to hide filters 1-Lodging; 2-Food; 3-Gardening; 4-Shopping; 5-Dog/Cat; 6-Small Animals; 7-Recreation"],
  ["nessie", "Usage: nessie. Same as SimCity."],
  ["stream_fps", "Usage: stream_fps [max frames-per-sec of stream anim]"],
  ["reload_neighborhood", "Usage: reload_neighborhood"],
];
/** CheatCallback's show_filter argument -> filter bit (1 lodging ... 7 recreation). */
const CHEAT_FILTER_BITS = [0, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40] as const;

/** DrawFilterAt: the icon frame for each value of +0x1dc (the wave clock modulo 6). */
const FILTER_FRAMES = [0, 1, 2, 2, 1, 0] as const;

/** Lots past this house number belong to the expansion towns. */
const FIRST_TOWN_HOUSE = 0x51;

/** TSPaint's wave clock: a frame step whenever 1000 / elapsed <= 2 * pi. */
const WAVE_STEP_MS = 1000 / (2 * Math.PI);

/** cWinLotBtn::InitData: the lots' tooltip unfurl time (cTSWin+0xa0). */
const UNFURL_MS = 0x4b;

/** TSOnTimerMsg period; the first tick enables the lot rollovers. */
const TIMER_MS = 1000;

export interface NeighborhoodCallbacks {
  /** RegularModeLotHandler: cSimsApp::LoadGame(house) and close the screen. */
  onEnterLot(house: number): void;
  /** The screen ended with one of the NBHD_* codes. */
  onEndModal(result: number): void;
  /** Neighborhood::Previous / Next, then cSimsApp::DoNbhdScreen rebuilds the screen. */
  onSwitchNeighborhood(dir: string): void;
  /** A button whose target window is not ported (pick family, credits, web pages, evict, rezone). */
  onUnported(what: string): void;
  /**
   * MoveInModeLotHandler: cSimsApp::LoadGame(house, family), the family
   * moving into the lot (optional: without it the screen asks onEnterLot).
   */
  onMoveIn?(house: number, familyId: number, houseValue: number): void;
  /**
   * The house file side of Neighborhood::MoveOut(house, bulldoze): LoadHouse,
   * the objects with IsDeletedByEvict killed, on a bulldoze every object,
   * wall, floor and the pool off the 0x20 tiles, the characters whose
   * Neighbor +0xfa is this house deleted, funds and global 26 zeroed, the
   * history cleared, SaveHouse. Resolves false on failure (optional: without
   * it the screen only does the neighborhood side and reports onUnported).
   * `store` holds the family side already applied (saved after this
   * resolves); a bulldoze deletes the house's characters through it.
   */
  onMoveOutHouse?(house: number, bulldoze: boolean, store: NeighborhoodStore): Promise<boolean>;
}

/** UIText STR# 131 "BulldozeModeStrs" (title, text pairs; also the rezone eviction questions). */
const STR_BULLDOZE = 131;
/** UIText STR# 250: rezone dialog title and "currently zoned as a %s lot" text. */
const STR_REZONE = 250;
/** UIText STR# 251: zone names (Residential, Community), the radio choices. */
const STR_ZONE_NAMES = 251;
/** UIText STR# 153: cSimsApp::Quit (entry 1 title, 2 text). */
const STR_QUIT = 153;

const SND_BDOZE = "UI_Nhood_bdoze";
const SND_BDOZE_CANCEL = "UI_Nhood_bdoze_cancel";
const SND_DEMOLISH = "UI_Nhood_bdoze_demolish";
const SND_EVICT = "UI_Nhood_bdoze_evict";
const SND_CREDITS_MUSIC = MUSIC.credits;

/** lbl_105C3419 / lbl_105C3418: one family picker / credits window at a time. */
let pickFamilyOpen = false;
let creditsOpen = false;

/** UIText STR# 132 "MoveInModeStrs" (title, text pairs). */
const STR_MOVE_IN = 132;
/** UIText STR# 143: the family import dialog (lbl_105BCD34, loaded by LoadUIStrings). */
const STR_IMPORT_FAMILY = 0x8f;
/** UIText STR# 144 entry 5: "Delete" (the third button of the import dialogs). */
const STR_IMPORT_DELETE = 0x90;
/** UIText STR# 154: entries 0x12 / 0x13 confirm a file delete. */
const STR_IMPORT_MISC = 0x9a;
/** UIText STR# 172: the lot import dialog titles (1 residential, 2 community). */
const STR_IMPORT_LOT = 0xac;
/** lbl_105BCD5C +0x177 / +0x192: ImportFamily's error box (English literals in the code). */
const IMPORT_ERROR_TEXT = "Couldn't import the family";
const IMPORT_ERROR_TITLE = "Error";
/** cWinPictureDialog::SetKey codes of the import dialogs. */
const KEY_RETURN = 0x0d;
const KEY_ESCAPE = 0x1b;
const MOVE_IN = {
  buyHouse: 0,
  tooExpensive: 2,
  buyLot: 6,
  community: 12,
  occupied: 14,
  tutorial: 16,
} as const;

export class WinNeighborhoodUL extends TSWin implements LotBtnOwner {
  /** +0xcc */
  private mode = NbhdMode.Regular;
  /** +0x1b0: the family moving in (Move In mode). */
  private moveInFamily = -1;
  private largeMask: ImageBitmap | null = null;
  private waves: Array<ImageBitmap | null> = [];
  private currentBox: ImageBitmap | null = null;
  private font: FfnFont | null = null;
  /** +0x130 / +0x134: the map's offset in the window. */
  private offX = 0;
  private offY = 0;
  private waveBtn: TSWinBtn | null = null;
  private readonly buttons: TSWinBtn[] = [];
  /** +0x138: house number -> lot button, ordered by house number. */
  private lots = new Map<number, WinLotBtn>();
  private popup: WinLotPopup | null = null;
  private waveTick = -1;
  private lastWaveMs = 0;
  private openedMs = -1;
  /** +0x1d9: the first timer tick has not happened yet. */
  private firstTick = true;
  private lastTimerMs = 0;
  private hoveredLot: WinLotBtn | null = null;
  private popupShownMs = 0;
  private popupTargetH = 0;
  /** GetFamilyInfo(+0x1b0): the moving family's budget + lot value (roof rule in move in mode). */
  private moveInFunds: number | null = null;
  /** +0x1b4: an internet update is running (commands and keys ignored). */
  private busy = false;
  /** +0x20c: a handler is running. */
  private handling = false;
  /** +0xd4..+0xec: the picker's filter buttons. */
  private readonly filterBtns: TSWinBtn[] = [];
  /** +0x188: the current filter bit (0: none), +0x184 its icon. */
  private filterMode = 0;
  private filterIcon: ImageBitmap | null = null;
  /** +0x108: the show_zones cheat (HighlightLotsForMode outlines the zones in every mode). */
  private showZones = false;
  /** +0xd0: the picker's title. */
  private title = "";

  constructor(
    private readonly ctx: GameContext,
    private readonly nb: Neighborhood,
    private readonly callbacks: NeighborhoodCallbacks,
    /**
     * +0x111 cleared (cWinNeighborhoodUL(false), ObjectModule::PostSim for
     * TryDialog kind 8): the screen is a destination picker over a lot,
     * in visit mode; picking a community lot ends it with the house.
     */
    private readonly picker = false,
  ) {
    super();
    this.nessie = new Nessie(ctx);
  }

  /** +0xf0..+0x104: the Nessie easter egg (nessie.ts). */
  private readonly nessie: Nessie;

  /** cWinNeighborhoodUL::Init (main screen) */
  override async init(): Promise<boolean> {
    const { ctx } = this;
    const res = ctx.res;
    const lang: number = UI_LANGUAGE;
    const us = lang === 1;

    // The neighborhood may ship its own map (Neighborhood::GetDirectory + "neighborhoodul.jpg").
    const custom = await this.loadGimex("neighborhoodul.jpg");
    let background: ImageBitmap;
    if (custom) {
      background = custom;
      for (let i = 0; i < 6; i++) this.waves.push(await this.loadGimex(`neighborhoodul${i}.jpg`));
    } else {
      background = await res.image(us ? "kNbhdBck_UL" : "kNbhdBckNonUS_UL");
      const ids = us ? [6302, 6303, 6304, 6330, 6331, 6332] : [6309, 6310, 6311, 6336, 6337, 6338];
      this.waves = await Promise.all(ids.map((id) => res.image(id).catch(() => null)));
    }
    const [creditsId, logoId] = languageImages(lang);
    const bar = await res.image(this.picker ? 0x13b5 /* kFilterToolbar */ : "kNghBarBkg");
    if (this.getW() > 800) this.largeMask = await res.image("kLargeMask");
    // cTSFontSys acquire(1, 12, 0, 0), color MakeFillColor(255, 255, 255).
    this.font = await ctx.fonts.acquire(12);

    const w = this.getW();
    const h = this.getH();
    this.offX = background.width < w ? (w - background.width) >> 1 : 0;
    this.offY = background.height < h ? (h - background.height) >> 1 : 0;
    this.currentBox = await res.image("kNghCurrent");

    const map = new TSWinBtn(0, background, 1);
    map.moveTo(this.offX, this.offY);
    this.childAdd(map);
    const waveBtn = new TSWinBtn(0, this.waves[0] ?? background, 1);
    map.childAdd(waveBtn);
    this.waveBtn = waveBtn;

    // One lot per zoning entry, stopping at the first expansion-town house.
    for (const { house } of this.nb.zoning) {
      if (house >= FIRST_TOWN_HOUSE) break;
      const lot = new WinLotBtn(this, this.nb, true);
      lot.id = 1;
      if (!(await lot.init()) || !(await lot.loadHouseInfo(house))) continue;
      const p = lot.lotPoint();
      lot.centerOn(p.x, p.y);
      lot.clip = { left: 0, top: 0, right: 800, bottom: 600 };
      waveBtn.childAdd(lot);
      this.lots.set(house, lot);
    }
    this.lots = new Map([...this.lots].sort((a, b) => a[0] - b[0]));

    const barBtn = new TSWinBtn(0, bar, 1);
    waveBtn.childAdd(barBtn);

    for (let i = 0; i < BTN_COUNT; i++) {
      if (this.picker && i !== BTN_CREDITS) {
        // The picker only creates the credits button (+0x158), disabled; the slots stay empty.
        this.buttons.push(new TSWinBtn(1, null, 4));
        continue;
      }
      const id = i === BTN_CREDITS ? creditsId : i === BTN_LOGO ? logoId : BTN_IMAGES[i]!;
      const btn = new TSWinBtn(1, await res.image(id), i === BTN_LOGO ? 1 : 4);
      // Credits uses entry 9 (1-based); the others take the entries in order.
      const tip = i === BTN_CREDITS ? 8 : i < BTN_CREDITS ? i : i - 1;
      if (!this.picker) btn.tooltip = ctx.strings.get("UIText", STR_BTN_TIPS, tip);
      const [x, y] = BTN_POS[i]!;
      btn.moveTo(x, y);
      (i === BTN_CREDITS ? waveBtn : barBtn).childAdd(btn);
      this.buttons.push(btn);
    }
    for (const i of [BTN_MOVE_IN, BTN_BULLDOZE, BTN_REZONE]) {
      this.buttons[i]!.mode = BTN_TOGGLE;
      this.buttons[i]!.sendOnDown = true;
    }

    const popup = new WinLotPopup(ctx, this.nb, () => this.mode);
    if (!(await popup.init())) return false;
    this.childAdd(popup);
    this.popup = popup;

    // Every button of the screen clicks with the neighborhood sound (restored by shutdown).
    TSWinBtn.overrideDefaultUISound(null, UI.nhoodClick);
    if (this.picker) {
      // Init with +0x111 cleared: SetMode(4), then (twice in the original, the
      // second set over the first) BuildFilterToolbar and ProcessFilterToolbarByType
      // of the saved filter; a random title of the first three of STR# 0xd4.
      this.buttons[BTN_CREDITS]!.setEnabled(false);
      this.setMode(NbhdMode.Visit);
      const titles = ctx.strings.list("UIText", STR_PICKER_TITLES);
      this.title = titles[Math.floor(Math.random() * 3)] ?? "";
      this.buildFilterToolbar(barBtn, await Promise.all(FILTERS.map((f) => res.image(f.button))));
      await this.processFilterToolbarByType(this.loadCurrentFilter());
    } else {
      this.setMode(NbhdMode.Regular);
      soundPlayer.playBySource(MUSIC.hood, -1);
      const cheats = getCheatCodeManager();
      for (const [name, usage] of CHEATS) cheats?.registerCheat(name, (cmd) => this.cheatCallback(cmd), 0, usage);
    }
    // The screen takes the keyboard (Escape leaves the modes).
    winMgr.setFocus(this);
    if (!this.picker) {
      winMgr.canvas.addEventListener("dragover", this.onDragOver);
      winMgr.canvas.addEventListener("drop", this.onDrop);
    }
    return true;
  }

  /** Web: files dropped on the screen are copied into <neighborhood>/Import/ (uploadImports). */
  private readonly onDragOver = (e: DragEvent): void => {
    e.preventDefault();
  };

  private readonly onDrop = (e: DragEvent): void => {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (!files?.length || this.mode !== NbhdMode.Regular) return;
    void uploadImports(this.nb.dir, files).then((names) => {
      if (names.length) void this.checkForNewImports();
    });
  };

  /** LoadGimex(<neighborhood directory>/<name>), or null when the file is absent. */
  private async loadGimex(name: string): Promise<ImageBitmap | null> {
    const path = `Sims/${this.nb.dir}/${name}`.toLowerCase();
    const file = (await fetchManifest()).files.find((f) => f.path.toLowerCase() === path);
    if (!file) return null;
    const r = await assetFetch(file.path).catch(() => null);
    return r?.ok ? createImageBitmap(await r.blob()).catch(() => null) : null;
  }

  /**
   * cWinNeighborhoodUL::BuildFilterToolbar: one 4-column button per filter at
   * (0xe1 + 0x32 i, 0x14) on the bar, UIText STR# 0xab tooltip, the
   * neighborhood click sound, enabled when a community lot has that type.
   */
  private buildFilterToolbar(bar: TSWinBtn, images: readonly ImageBitmap[]): void {
    const community = [...this.lots.values()].filter((l) => this.nb.getZoningType(l.houseNumber) === Zone.Community);
    for (let i = 0; i < FILTERS.length; i++) {
      const f = FILTERS[i]!;
      const btn = new TSWinBtn(1, images[i]!, 4);
      btn.tooltip = this.ctx.strings.get("UIText", STR_FILTER_TIPS, f.tip - 1);
      btn.moveTo(FILTER_X0 + FILTER_DX * i, FILTER_Y);
      btn.setEnabled(community.some((l) => ((l.info?.lotTypeFlags ?? 0) & f.bit) !== 0));
      bar.childAdd(btn);
      this.filterBtns.push(btn);
    }
  }

  /**
   * cWinNeighborhoodUL::LoadCurrentFilter: entry 3 of STR# 6 in a runtime
   * file of the neighborhood (GetStringConstant(7) / (10)), 2 (food) when it
   * cannot be read. The browser keeps the value per neighborhood instead.
   */
  private loadCurrentFilter(): number {
    try {
      const v = Number(localStorage.getItem(`thesimsweb.nbhdFilter.${this.nb.dir}`));
      return v > 0 ? v : DEFAULT_FILTER;
    } catch {
      return DEFAULT_FILTER;
    }
  }

  /** cWinNeighborhoodUL::SaveCurrentFilter (Shutdown, when a filter is set). */
  private saveCurrentFilter(): void {
    if (this.filterMode === 0) return;
    try {
      localStorage.setItem(`thesimsweb.nbhdFilter.${this.nb.dir}`, String(this.filterMode));
    } catch {
      // not kept
    }
  }

  /** cWinNeighborhoodUL::ProcessFilterToolbarByType: the button of that bit (the first one otherwise). */
  private processFilterToolbarByType(bit: number): Promise<void> {
    const i = FILTERS.findIndex((f) => f.bit === bit);
    return this.processFilterToolbar(i < 0 ? 0 : i);
  }

  /** cWinNeighborhoodUL::ProcessFilterToolbar: the old filter's button up, SetFilterMode, the new one down. */
  private async processFilterToolbar(index: number): Promise<void> {
    const prev = FILTERS.findIndex((f) => f.bit === this.filterMode);
    if (prev >= 0) this.filterBtns[prev]?.setState(0);
    const f = FILTERS[index];
    if (!f) return;
    await this.setFilterMode(f.bit);
    this.filterBtns[index]?.setState(1);
  }

  /** cWinNeighborhoodUL::SetFilterMode: +0x188 and its icon (+0x184). */
  private async setFilterMode(bit: number): Promise<void> {
    this.filterMode = bit;
    const icon = FILTERS.find((f) => f.bit === bit)?.icon;
    this.filterIcon = icon ? await this.ctx.res.image(icon).catch(() => null) : null;
  }

  /**
   * cWinNeighborhoodUL::CheatCallback. load n (0..18): cSimsApp::LoadGame and
   * the screen ends with the house; show_zones on/off: +0x108 then
   * HighlightLotsForMode; show_filter n (0..7): the filter shown over the
   * community lots; nessie: the Nessie sprite (nessie.ts). move_lots (SetMode(5),
   * lots nudged with the arrows, LotLocations.iff rewritten on leaving),
   * stream_fps and reload_neighborhood (not in the shipped cheat list) are not ported.
   */
  private cheatCallback(cmd: CheatCommandLine): boolean {
    const [name, arg] = cmd.args;
    switch (name) {
      case "load": {
        if (cmd.args.length !== 2) {
          cmd.errMsg = "Usage: load [house num]";
          return false;
        }
        const house = parseInt(arg!, 10) || 0;
        if (house < 0 || house >= 0x13) {
          cmd.errMsg = "house num must be between 0 and 18";
          return false;
        }
        // cSimsApp::LoadGame + TSWinMsgPost(0x10, house): the callback loads the lot and closes the screen.
        this.callbacks.onEnterLot(house);
        return true;
      }
      case "show_zones":
        if (cmd.args.length < 2) break;
        this.showZones = arg === "on";
        this.highlightLotsForMode();
        return true;
      case "show_filter": {
        const n = cmd.args.length < 2 ? 0 : parseInt(arg!, 10) || 0;
        if (n < 0 || n > 7) {
          cmd.errMsg = "Filter number must be between 0 and 7.";
          void this.setFilterMode(0);
          return false;
        }
        void this.setFilterMode(CHEAT_FILTER_BITS[n]!);
        return true;
      }
      case "nessie":
        if (!this.nessie.start()) {
          cmd.errMsg = NESSIE_BUSY;
          return false;
        }
        return true;
      default:
        break;
    }
    console.log(`not ported: neighborhood cheat "${name ?? ""}"`);
    return false;
  }

  override shutdown(): void {
    // Shutdown unregisters the cheats (reload_neighborhood stays registered, as in the original).
    if (!this.picker) {
      for (const [name] of CHEATS) if (name !== "reload_neighborhood") getCheatCodeManager()?.unregisterCheat(name);
    }
    this.saveCurrentFilter();
    winMgr.canvas.removeEventListener("dragover", this.onDragOver);
    winMgr.canvas.removeEventListener("drop", this.onDrop);
    TSWinBtn.overrideDefaultUISound();
    winMgr.setGlobalCursor(null);
    super.shutdown();
  }

  /** cTSWin::SetCursor on the screen and every lot (SetMode). */
  private setCursor(cursor: string | null): void {
    this.winCursor = cursor;
    for (const lot of this.lots.values()) lot.winCursor = cursor;
    winMgr.applyCursor();
  }

  private setButtonsEnabled(indices: readonly number[], on: boolean): void {
    for (const i of indices) this.buttons[i]!.setEnabled(on);
  }

  /**
   * cWinNeighborhoodUL::SetMode. Leaving rezone or evict puts their button
   * up, the lots back in mode 0 and plays "UI_Nhood_bdoze_cancel"; leaving
   * move in puts its button up. Entering:
   *  - regular (main screen): every button enabled (the four town buttons when
   *    their pack is installed, cSimsApp +0x66 bits 4 / 8 / 0x40 / 0x80, all
   *    set in the Complete Collection), Import by CheckForNewImports, the
   *    standard arrow;
   *  - move in: cursor 0x21 (MOVEIN.cur), its button down;
   *  - evict: every button but Bulldoze and Import disabled, cursor 0x22
   *    (bulldoze.cur), Bulldoze down, lots in mode 1, "UI_Nhood_bdoze";
   *  - rezone: every button but Rezone and Import disabled, cursor 0x28
   *    (Rezone2.cur), Rezone down, lots in mode 1;
   *  - visit (the town screens only): cursor 0x29, lots in mode 2.
   * The per-mode handlers (+0x198 lot, +0x1a4 button member pointers):
   * regular = RegularModeLot/BtnHandler, move in = MoveInModeLotHandler +
   * RegularModeBtnHandler, evict / rezone = their own pair. Then the lots'
   * cursor and HighlightLotsForMode.
   */
  setMode(mode: NbhdMode): void {
    const old = this.mode;
    if (old === NbhdMode.Rezone || old === NbhdMode.Evict) {
      this.buttons[old === NbhdMode.Rezone ? BTN_REZONE : BTN_BULLDOZE]!.setState(0);
      for (const lot of this.lots.values()) lot.setMode(0);
      soundPlayer.playBySource(SND_BDOZE_CANCEL, -4);
    } else if (old === NbhdMode.MoveIn) {
      this.buttons[BTN_MOVE_IN]!.setState(0);
    }
    this.mode = mode;
    let cursor: string | null = null;
    switch (mode) {
      case NbhdMode.Regular:
        this.setButtonsEnabled(
          [BTN_CREDITS, BTN_LOGO, BTN_MOVE_IN, BTN_EXIT, BTN_INET, BTN_PREVIOUS, BTN_NEXT, BTN_BULLDOZE, BTN_REZONE],
          true,
        );
        this.setButtonsEnabled([BTN_DOWNTOWN, BTN_VACATION, BTN_STUDIOTOWN, BTN_MAGICTOWN], true);
        void this.checkForNewImports();
        // The finger on the main screen (+0x111), the trolley in the picker.
        cursor = this.picker ? getCursor(0x29) : getStandardCursor(4);
        break;
      case NbhdMode.MoveIn:
        cursor = getCursor(0x21);
        this.buttons[BTN_MOVE_IN]!.setState(1);
        break;
      case NbhdMode.Evict:
        this.setButtonsEnabled(
          [BTN_CREDITS, BTN_LOGO, BTN_MOVE_IN, BTN_EXIT, BTN_INET, BTN_PREVIOUS, BTN_NEXT, BTN_DOWNTOWN, BTN_VACATION, BTN_STUDIOTOWN, BTN_MAGICTOWN, BTN_REZONE],
          false,
        );
        cursor = getCursor(0x22);
        this.buttons[BTN_BULLDOZE]!.setState(1);
        for (const lot of this.lots.values()) lot.setMode(1);
        soundPlayer.playBySource(SND_BDOZE, -4);
        break;
      case NbhdMode.Rezone:
        this.setButtonsEnabled(
          [BTN_CREDITS, BTN_LOGO, BTN_MOVE_IN, BTN_EXIT, BTN_INET, BTN_PREVIOUS, BTN_NEXT, BTN_DOWNTOWN, BTN_VACATION, BTN_STUDIOTOWN, BTN_MAGICTOWN, BTN_BULLDOZE],
          false,
        );
        cursor = getCursor(0x28);
        this.buttons[BTN_REZONE]!.setState(1);
        for (const lot of this.lots.values()) lot.setMode(1);
        break;
      case NbhdMode.Visit:
        cursor = getCursor(0x29);
        for (const lot of this.lots.values()) lot.setMode(2);
        break;
      default:
        break;
    }
    if (cursor) this.setCursor(cursor);
    this.highlightLotsForMode();
  }

  /**
   * cWinNeighborhoodUL::HighlightLotsForMode (main screen): every import
   * hilite off; in rezone mode (or with the "show_zones" cheat) community
   * lots are outlined blue, empty residential lots green and occupied ones red.
   */
  private highlightLotsForMode(): void {
    for (const lot of this.lots.values()) {
      lot.hiliteForImport(false);
      if (this.mode !== NbhdMode.Rezone && !this.showZones) continue;
      const zone = this.nb.getZoningType(lot.houseNumber);
      if (zone === Zone.Community) lot.hiliteForCommunity(true);
      else if (zone === Zone.Residential) {
        if ((lot.info?.familyNumber ?? -1) === -1) lot.hiliteForResidential(true);
        else lot.hiliteForDisabled(true);
      }
    }
  }

  /**
   * cWinNeighborhoodUL::CheckForNewImports: Import is enabled when <dir>/Import
   * holds *.FAM, *.rdt or *.cmt (nbhd/imports.ts adds the exported families).
   * Web: the button stays enabled without files, since pressing it then opens
   * the file picker (the player's disk stands for the Import folder).
   * Then Import/Tutorial.FAM is imported at once (nbhd/tutorial.ts; on the
   * main screen only, +0x111, and not while one runs, +0x1d8); a family
   * coming onto a lot builds the screen again (DoNbhdScreen(1)).
   */
  private async checkForNewImports(): Promise<void> {
    await hasImports(this.nb.dir);
    this.buttons[BTN_IMPORT]!.setEnabled(true);
    if (this.picker || this.checkingImports) return;
    this.checkingImports = true;
    try {
      if (await importTutorialIfPresent(this.ctx, this.nb)) this.callbacks.onSwitchNeighborhood(this.nb.dir);
    } finally {
      this.checkingImports = false;
    }
  }

  /** +0x1d8: CheckForNewImports is running. */
  private checkingImports = false;

  /** cWinNeighborhoodUL::HiliteLot: the lot's import outline (community outline in the picker), 0 = all off. */
  private hiliteLot(house: number): void {
    if (house === 0) {
      for (const lot of this.lots.values()) lot.hiliteForImport(false);
      return;
    }
    const lot = this.lots.get(house);
    if (!lot) return;
    if (this.picker) lot.hiliteForCommunity(true);
    else lot.hiliteForImport(true);
  }

  /** A lot button's absolute area (cTSWin +0xc), the rect SetPositioning(2) keeps the dialog off. */
  private lotRect(house: number): { left: number; top: number; right: number; bottom: number } | undefined {
    const lot = this.lots.get(house);
    if (!lot) return undefined;
    const o = lot.absOrigin();
    return { left: o.x, top: o.y, right: o.x + lot.getW(), bottom: o.y + lot.getH() };
  }

  /** The "Delete" answer: the STR# 154 confirmation (Yes = 4), then CTGFileManager::DeleteFile. */
  private async confirmDeleteImport(path: string): Promise<void> {
    const r = await TSWinMsgBox.show(this.ctx, this.str(STR_IMPORT_MISC, 0x12), this.str(STR_IMPORT_MISC, 0x11), MB_YESNO);
    if (r === IDYES) await deleteGameFile(path).catch(() => console.warn(`[import] ${path} is read-only`));
  }

  /**
   * cWinNeighborhoodUL::CycleThroughImports: every family file once
   * (GetImportInfoForFile; files it refuses are skipped), each with the
   * STR# 143 dialog: "A family was found... $family", then where it goes
   * (no lot: the family bin; a lot: the family it displaces, the empty lot
   * or the vacant house of $lot, the lot outlined and the dialog kept off
   * it), the lot picture, Yes (Return) / No (Escape) / Delete. Yes refuses a
   * lot whose family is on vacation (STR# 131 entries 22 / 23), else zones
   * the lot residential and runs ImportFamily (the zoning comes back and
   * "Couldn't import the family" shows when it fails). Then the residential
   * and community lot files; DoNbhdScreen(1) when a lot changed.
   * A file of another character set (isWrongCharacterSet; not the tutorial
   * lot) gets the STR# 154 entries 20 / 21 box instead (OK / Delete).
   * Not ported: ReportMissingTextures.
   * Web: with nothing to import, the file picker opens first.
   */
  private async cycleThroughImports(): Promise<void> {
    let files = await listImports(this.nb.dir);
    if (!files.families.length && !files.residential.length && !files.community.length) {
      if (!(await pickAndUploadImports(this.nb.dir)).length) return;
      files = await listImports(this.nb.dir);
    }
    let reload = false;
    for (const path of files.families) {
      const info = await getImportInfoForFile(path);
      if (!info) continue;
      if (isWrongCharacterSet(info)) {
        await this.wrongCharacterSetDialog(path);
        continue;
      }
      const r = await this.importFamilyDialog(info);
      if (r === 1) {
        if (await this.runImportFamily(info)) reload ||= info.house !== 0;
      } else if (r === 2) {
        await this.confirmDeleteImport(path);
      }
    }
    if (await this.cycleLotImports(files.residential, Zone.Residential)) reload = true;
    if (await this.cycleLotImports(files.community, Zone.Community)) reload = true;
    if (reload) {
      this.callbacks.onSwitchNeighborhood(this.nb.dir);
      return;
    }
    await this.nb.reloadData();
    await this.checkForNewImports();
  }

  /**
   * CycleThroughImports' character set box: a cWinPictureDialog with STR# 154
   * entries 20 and 21 (1-based), OK (cTSWinMsgBox::GetButtonLabel(1), id 1)
   * and Delete (STR# 144 entry 5, id 2); Delete asks the STR# 154 question.
   */
  private async wrongCharacterSetDialog(path: string): Promise<void> {
    const dlg = new WinPictureDialog(this.ctx);
    dlg.addText(this.str(STR_IMPORT_MISC, 0x13));
    dlg.addText(this.str(STR_IMPORT_MISC, 0x14));
    dlg.addButton(TSWinMsgBox.getButtonLabel(this.ctx, IDOK), 1);
    dlg.addButton(this.str(STR_IMPORT_DELETE, 4), 2);
    if ((await dlg.run()) === 2) await this.confirmDeleteImport(path);
  }

  private async importFamilyDialog(info: ImportInfo): Promise<number> {
    const s = (i: number): string => this.str(STR_IMPORT_FAMILY, i - 1);
    const dlg = new WinPictureDialog(this.ctx);
    dlg.addText(s(1).replace("$family", info.familyName));
    let where = "";
    const house = info.house;
    if (house === 0) {
      where = s(2);
    } else {
      const lot = this.lots.get(house)?.info;
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
    dlg.addButton(this.str(STR_IMPORT_DELETE, 4), 2);
    if (info.image) dlg.setImage(info.image);
    dlg.setTitle(s(9));
    if (house !== 0) {
      this.hiliteLot(house);
      const rect = this.lotRect(house);
      if (rect) dlg.setPositioning(PD_AVOID_RECT, rect);
    }
    const r = await dlg.run();
    if (house !== 0) this.hiliteLot(0);
    return r;
  }

  /** The Yes branch of CycleThroughImports (true when the family came in). */
  private async runImportFamily(info: ImportInfo): Promise<boolean> {
    const house = info.house;
    const store = await NeighborhoodStore.open(this.nb.dir);
    const resident = store.familyOfHouse(house);
    if (house !== 0 && resident !== undefined && store.familyVacationLot(resident) !== 0) {
      await this.message(STR_BULLDOZE, 22, 21);
      return false;
    }
    const zone = this.nb.getZoningType(house);
    if (house !== 0) await this.nb.setZoningType(house, Zone.Residential);
    winMgr.setGlobalCursor(getCursor(3));
    let ok = false;
    try {
      ok = (await importFamily(this.nb.dir, info).catch((e: unknown) => (console.error("[import]", e), null))) !== null;
    } finally {
      winMgr.setGlobalCursor(null);
    }
    if (!ok) {
      if (house !== 0) await this.nb.setZoningType(house, zone);
      await TSWinMsgBox.show(this.ctx, IMPORT_ERROR_TEXT, IMPORT_ERROR_TITLE, MB_OK);
    }
    return ok;
  }

  /**
   * cWinNeighborhoodUL::CycleResidentialImports / CycleCommunityImports: each
   * lot file once: its STR# 2000 name and description, Yes (Return) / No
   * (Escape) / Delete, its picture (BMP_ 0x200), the STR# 172 title, its lot
   * (entry 3) outlined and kept clear. Yes replaces Houses/House%02d.iff by
   * the file, writes the name and description into
   * Houses\NeighborhoodDesc.iff STR# 2000 + house (when it has one) and
   * zones the lot. True when a lot was imported.
   */
  private async cycleLotImports(paths: readonly string[], zone: Zone): Promise<boolean> {
    let any = false;
    for (const path of paths) {
      const lot = await getLotImportInfo(path);
      if (!lot) continue;
      const r = await this.lotImportDialog(lot, zone);
      if (r === 1) {
        any = true;
        await importLotFile(this.nb.dir, lot);
        await this.setLotDescription(lot.house, lot.name, lot.description);
        await this.nb.setZoningType(lot.house, zone);
      } else if (r === 2) {
        await this.confirmDeleteImport(path);
      }
    }
    return any;
  }

  private async lotImportDialog(lot: LotImportInfo, zone: Zone): Promise<number> {
    const s = (i: number): string => this.str(STR_IMPORT_FAMILY, i - 1);
    const dlg = new WinPictureDialog(this.ctx);
    dlg.addText(lot.name);
    dlg.addText(lot.description);
    dlg.addButton(s(7), 1);
    dlg.setKey(1, KEY_RETURN);
    dlg.addButton(s(8), 0);
    dlg.setKey(0, KEY_ESCAPE);
    dlg.addButton(this.str(STR_IMPORT_DELETE, 4), 2);
    if (lot.image) dlg.setImage(lot.image);
    dlg.setTitle(this.str(STR_IMPORT_LOT, zone === Zone.Community ? 1 : 0));
    this.hiliteLot(lot.house);
    const rect = this.lotRect(lot.house);
    if (rect) dlg.setPositioning(PD_AVOID_RECT, rect);
    const r = await dlg.run();
    this.hiliteLot(0);
    return r;
  }

  /** cWinNeighborhoodUL::ShouldAllowRoofDissolve */
  shouldAllowRoofDissolve(btn: WinLotBtn): boolean {
    const info = btn.info;
    if (!info) return false;
    switch (this.mode) {
      case NbhdMode.MoveIn: {
        // GetFamilyInfo of the moving family: the roof lifts only on what it can buy.
        const funds = this.moveInFunds;
        if (funds === null) return true;
        if (funds < info.value) return false;
        if (!info.isEmpty) return false;
        return info.familyNumber === -1;
      }
      case NbhdMode.Evict:
      case NbhdMode.Rezone:
        if (info.familyNumber === -1 && !info.hasHouse) return false;
        return !info.isTutorial;
      case NbhdMode.Visit:
        return this.nb.getZoningType(btn.houseNumber) === Zone.Community;
      default:
        return info.familyNumber !== -1;
    }
  }

  /** cTSWinMgrW95::TriggerToolTips for a lot: its tooltip window is the shared popup. */
  lotEntered(btn: WinLotBtn): void {
    this.hoveredLot = btn;
    if (!this.firstTick) void this.showPopup(btn);
  }

  lotExited(btn: WinLotBtn): void {
    if (this.hoveredLot !== btn) return;
    this.hoveredLot = null;
    // cTSWinMgrW95::UntriggerToolTips
    this.popup?.hideWindow();
  }

  /** cWinLotBtn::GetToolTipsWindow + cTSWin::GetTTPosition + the unfurl of SetupToolTipsWindow. */
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
   * cWinNeighborhoodUL::TSOnCommand: 0x20 (from cWinPickFamily) starts Move
   * In mode for that family; 1 from a lot or a bar button goes to the current
   * mode's lot / button handler, guarded against re-entry (+0x20c) and
   * ignored while busy (+0x1b4).
   */
  override tsOnCommand(cmd: number, source: TSWin): boolean {
    if (this.busy) return false;
    if (cmd !== 1 || this.handling) return false;
    const f = this.filterBtns.indexOf(source as TSWinBtn);
    if (f >= 0) {
      this.handling = true;
      void this.processFilterToolbar(f).finally(() => (this.handling = false));
      return true;
    }
    if (source instanceof WinLotBtn) {
      this.handling = true;
      void this.lotHandler(source.houseNumber).finally(() => (this.handling = false));
      return true;
    }
    const index = this.buttons.indexOf(source as TSWinBtn);
    if (index < 0) return false;
    this.handling = true;
    void this.btnHandler(index).finally(() => (this.handling = false));
    return true;
  }

  /** The +0x198 member pointer: the lot handler of the current mode. */
  private lotHandler(house: number): Promise<void> {
    switch (this.mode) {
      case NbhdMode.Regular:
        return this.regularModeLotHandler(house);
      case NbhdMode.MoveIn:
        return this.moveInModeLotHandler(house);
      case NbhdMode.Evict:
        return this.evictModeLotHandler(house);
      case NbhdMode.Rezone:
        return this.rezoneModeLotHandler(house);
      case NbhdMode.Visit:
        return this.visitModeLotHandler(house);
      default:
        return Promise.resolve();
    }
  }

  /**
   * cWinNeighborhoodUL::VisitModeLotHandler: a community lot ends the
   * picker with its house number (TSWinMsgPost 0x10); a residential lot
   * shows cSimsApp::MessageDialog (vtable +0x114) with the two strings the
   * static initializer reads from UIText STR# 0x104 (lbl_105BCD28: text =
   * entry 1, title = entry 0).
   */
  private async visitModeLotHandler(house: number): Promise<void> {
    if (!this.lots.has(house)) return;
    const zoning = this.nb.getZoningType(house);
    if (zoning === Zone.Community) winMgr.endDialog(this, house);
    else if (zoning === Zone.Residential) await this.message(STR_VISIT_RESIDENTIAL, 1, 0);
  }

  /** The +0x1a4 member pointer: the button handler of the current mode. */
  private btnHandler(index: number): Promise<void> {
    switch (this.mode) {
      case NbhdMode.Regular:
      case NbhdMode.MoveIn:
        return this.regularModeBtnHandler(index);
      case NbhdMode.Evict:
        return this.evictModeBtnHandler(index);
      case NbhdMode.Rezone:
        return this.rezoneModeBtnHandler(index);
      default:
        return Promise.resolve();
    }
  }

  /**
   * cWinNeighborhoodUL::EvictModeBtnHandler (jump table lbl_105BCCF4):
   * Move In leaves the mode then opens the family picker, Bulldoze leaves
   * the mode, Exit / Inet / Credits / Import / Logo act as in regular mode,
   * the others do nothing (they are disabled anyway).
   */
  private async evictModeBtnHandler(index: number): Promise<void> {
    switch (index) {
      case BTN_MOVE_IN:
        this.setMode(NbhdMode.Regular);
        return this.regularModeBtnHandler(index);
      case BTN_BULLDOZE:
        this.setMode(NbhdMode.Regular);
        return;
      case BTN_EXIT:
      case BTN_INET:
      case BTN_CREDITS:
      case BTN_IMPORT:
      case BTN_LOGO:
        return this.regularModeBtnHandler(index);
      default:
        return;
    }
  }

  /** cWinNeighborhoodUL::RezoneModeBtnHandler (lbl_105BCCF8): as evict, Rezone leaving the mode. */
  private async rezoneModeBtnHandler(index: number): Promise<void> {
    switch (index) {
      case BTN_MOVE_IN:
        this.setMode(NbhdMode.Regular);
        return this.regularModeBtnHandler(index);
      case BTN_REZONE:
        this.setMode(NbhdMode.Regular);
        return;
      case BTN_EXIT:
      case BTN_INET:
      case BTN_CREDITS:
      case BTN_IMPORT:
      case BTN_LOGO:
        return this.regularModeBtnHandler(index);
      default:
        return;
    }
  }

  /** TSOnCommand 0x20 (posted by cWinPickFamily): Move In mode for that family. */
  private startMoveIn(familyId: number): void {
    this.setMode(NbhdMode.MoveIn);
    this.moveInFamily = familyId;
    void this.refreshMoveInFunds();
  }

  /** GetFamilyInfo(+0x1b0): the moving family's funds (budget + lot value), for the roof rule. */
  private async refreshMoveInFunds(): Promise<void> {
    const store = await NeighborhoodStore.open(this.nb.dir);
    const fam = store.family(this.moveInFamily);
    this.moveInFunds = fam ? fam.budget + fam.netWorth : null;
  }

  /**
   * RegularModeBtnHandler(Move In): cWinPickFamily over the screen's area
   * (only one at a time, lbl_105C3419), regular mode first, the lot popup
   * cleared, this screen hidden, "bkground_family" while it is up, then
   * "bkground_nhood1"; Move In's button goes up unless the picker started
   * Move In mode.
   */
  private async pickFamily(): Promise<void> {
    if (pickFamilyOpen) return;
    pickFamilyOpen = true;
    try {
      const dlg = new WinPickFamily(this.ctx, this.nb.dir);
      this.setMode(NbhdMode.Regular);
      this.popup?.hideWindow();
      this.hideWindow();
      dlg.setArea(this.area.left, this.area.top, this.area.right, this.area.bottom);
      dlg.setOwner({ moveIn: (id) => this.startMoveIn(id) });
      soundPlayer.playBySource(MUSIC.family, -1);
      if (await dlg.init()) await winMgr.doModalWin(dlg);
      soundPlayer.playBySource(MUSIC.hood, -1);
      this.showWindow();
      if (this.mode !== NbhdMode.MoveIn) this.buttons[BTN_MOVE_IN]!.setState(0);
      winMgr.setFocus(this);
    } finally {
      pickFamilyOpen = false;
    }
  }

  private str(set: number, index: number): string {
    return this.ctx.strings.get("UIText", set, index);
  }

  /** cSimsApp::MessageDialog(text, title, type) with entries of a string set. */
  private message(set: number, text: number, title: number, type = MB_OK): Promise<number> {
    return TSWinMsgBox.show(this.ctx, this.str(set, text), this.str(set, title), type);
  }

  private moveInMessage(index: number, type = MB_OK): Promise<number> {
    return this.message(STR_MOVE_IN, index + 1, index, type);
  }

  /** cWinNeighborhoodUL::MoveInModeLotHandler */
  private async moveInModeLotHandler(house: number): Promise<void> {
    const info = this.lots.get(house)?.info;
    if (!info) return;
    if (info.isTutorial) {
      await this.moveInMessage(MOVE_IN.tutorial);
      return;
    }
    if (this.nb.getZoningType(house) !== Zone.Residential) {
      await this.moveInMessage(MOVE_IN.community);
      return;
    }
    // GetFamilyInfo: the moving family's net worth (budget + house value).
    const store = await NeighborhoodStore.open(this.nb.dir);
    const fam = store.family(this.moveInFamily);
    if (!fam) {
      this.setMode(NbhdMode.Regular);
      return;
    }
    const funds = fam.budget + fam.netWorth;
    if (!info.isEmpty) {
      await this.moveInMessage(MOVE_IN.tooExpensive);
      return;
    }
    if (info.familyNumber !== -1) {
      await this.moveInMessage(MOVE_IN.occupied);
      return;
    }
    if (funds < info.value) {
      await this.moveInMessage(MOVE_IN.tooExpensive);
      return;
    }
    const r = await this.moveInMessage(info.hasHouse ? MOVE_IN.buyHouse : MOVE_IN.buyLot, MB_YESNO);
    if (r !== IDYES) return;
    this.setMode(NbhdMode.Regular);
    for (const lot of this.lots.values()) void lot.hiliteForTutorial(this.ctx, false);
    await this.refillNpcs();
    soundPlayer.playBySource(MUSIC.fade, -1);
    if (this.callbacks.onMoveIn) this.callbacks.onMoveIn(house, this.moveInFamily, info.value);
    else this.callbacks.onEnterLot(house);
  }

  /**
   * DoFirstTimeTownies, RefillTownies(30), DoFirstTimeTouristFamilies,
   * RefillTouristFamilies(10): run before a lot is loaded (regular lot click,
   * move in, Downtown).
   */
  private async refillNpcs(): Promise<void> {
    const store = await NeighborhoodStore.open(this.nb.dir);
    await doFirstTimeTownies(this.ctx, store);
    await refillTownies(this.ctx, store, TOWNIE_COUNT);
    await doFirstTimeTouristFamilies(this.ctx, store);
    await refillTouristFamilies(this.ctx, store, TOURIST_FAMILY_COUNT);
  }

  /** cWinNeighborhoodUL::RegularModeLotHandler (main screen) */
  private async regularModeLotHandler(house: number): Promise<void> {
    const info = this.lots.get(house)?.info;
    if (!info) return;
    soundPlayer.playBySource(MUSIC.fade, -1);
    for (const lot of this.lots.values()) void lot.hiliteForTutorial(this.ctx, false);
    await this.refillNpcs();
    // A family on vacation (Family +0x13c) is loaded on its vacation lot.
    if (info.familyNumber !== -1) {
      const store = await NeighborhoodStore.open(this.nb.dir);
      const id = store.familyOfHouse(house);
      const away = id !== undefined ? store.familyVacationLot(id) : 0;
      if (away) {
        this.callbacks.onEnterLot(away);
        return;
      }
    }
    this.callbacks.onEnterLot(house);
  }

  /**
   * EvictFamily(house, bulldoze): Neighborhood::MoveOut, then
   * Neighborhood::ExportFamily of the family that lived there
   * (Export/<name>_<id>.FAM; its result is ignored, as in the original)
   * and, when the "export HTML" option is on, ExportFamilyHTML
   * (nbhd/exporthtml.ts). The family side of MoveOut
   * is NeighborhoodStore.moveOutFamily; the house file side goes to the
   * onMoveOutHouse callback when the lot code provides it. A bulldoze also
   * clears the lot's name and description (Houses\NeighborhoodDesc.iff
   * STR# 2000 + house, entries 1 and 2 set to "").
   */
  private async evictFamily(house: number, bulldoze: boolean): Promise<boolean> {
    const store = await NeighborhoodStore.open(this.nb.dir);
    const fam = store.moveOutFamily(house);
    if (fam === -1 && !bulldoze) return false;
    if (this.callbacks.onMoveOutHouse && !(await this.callbacks.onMoveOutHouse(house, bulldoze, store))) return false;
    if (!this.callbacks.onMoveOutHouse) this.callbacks.onUnported(`Neighborhood::MoveOut house file side (house ${house}, bulldoze ${bulldoze})`);
    await store.save();
    if (bulldoze) await this.clearLotDescription(house);
    if (fam !== -1) {
      if (!(await store.exportFamily(fam))) console.warn(`[evict] ExportFamily ${fam} failed`);
      if (getOptionsMgr().getExportHTML()) await exportFamilyHTML(this.ctx, store, fam).catch((e: unknown) => console.warn(`[evict] ExportFamilyHTML ${fam} failed`, e));
    }
    await this.nb.reloadData();
    return true;
  }

  /** MoveOut(bulldoze): StringSetMulti 2000 + house of Houses\NeighborhoodDesc.iff, entries 1 and 2 emptied. */
  private clearLotDescription(house: number): Promise<void> {
    return this.setLotDescription(house, "", "");
  }

  /** Houses\NeighborhoodDesc.iff STR# 2000 + house, entries 1 and 2 (left alone when the file or the set is missing). */
  private async setLotDescription(house: number, name: string, description: string): Promise<void> {
    const path = `${this.nb.dir}/Houses/NeighborhoodDesc.iff`;
    const res = await assetFetch(`Sims/${path}`, { cache: "no-store" });
    if (!res.ok) return;
    const chunks = parseIff(new Uint8Array(await res.arrayBuffer()));
    const id = 2000 + house;
    const c = chunks.find((x): boolean => x.type === "STR#" && x.id === id);
    if (!c) return;
    c.data = stringSetMultiSave(c.data, UI_LANGUAGE, [name, description]);
    await writeGameFile(path, buildIff(chunks));
  }

  /** The wait cursor around EvictFamily, then the lot's thumbnail again (ReloadThumbnail). */
  private async runEvict(house: number, bulldoze: boolean): Promise<void> {
    winMgr.setGlobalCursor(getCursor(3));
    let ok = false;
    try {
      ok = await this.evictFamily(house, bulldoze);
    } finally {
      winMgr.setGlobalCursor(null);
    }
    if (!ok) {
      await this.message(STR_BULLDOZE, 11, 10);
      return;
    }
    await this.lots.get(house)?.reloadThumbnail();
  }

  /** cWinNeighborhoodUL::EvictModeLotHandler */
  private async evictModeLotHandler(house: number): Promise<void> {
    const info = this.lots.get(house)?.info;
    if (!info) return;
    const store = await NeighborhoodStore.open(this.nb.dir);
    if (store.familyOnVacationAt(house) !== undefined) {
      await this.message(STR_BULLDOZE, 16, 17);
      return;
    }
    if (info.familyNumber === -1) {
      if (!info.hasHouse) {
        soundPlayer.playBySource(SND_BDOZE_CANCEL, -4);
        await this.message(STR_BULLDOZE, 5, 4);
        soundPlayer.playBySource(SND_BDOZE, -4);
        return;
      }
      if ((await this.message(STR_BULLDOZE, 1, 0, MB_YESNO)) !== IDYES) return;
      soundPlayer.playBySource(SND_DEMOLISH, -4);
      await this.runEvict(house, true);
    } else {
      const text = this.str(STR_BULLDOZE, 3).replace("%s", info.familyName).replace("%s", makeMoneyString(info.netWorth, UI_LANGUAGE));
      if ((await TSWinMsgBox.show(this.ctx, text, this.str(STR_BULLDOZE, 2), MB_YESNO)) !== IDYES) return;
      const bulldoze = info.hasHouse && (await this.message(STR_BULLDOZE, 1, 0, MB_YESNO)) === IDYES;
      soundPlayer.playBySource(bulldoze ? SND_DEMOLISH : SND_EVICT, -4);
      await this.runEvict(house, bulldoze);
    }
  }

  /**
   * cWinNeighborhoodUL::RezoneModeLotHandler: cSimsApp::RadioDialog (STR#
   * 250: title, "currently zoned as a %s lot" with the zone's STR# 251
   * name; choices STR# 251 Residential / Community). A new zone: refused for
   * a family on vacation; an empty lot is rezoned at once; a house must be
   * bulldozed first (STR# 131 9 / 8, yes / no), an occupied lot evicted
   * first (7 / 6, then the bulldoze question when there is a house).
   */
  private async rezoneModeLotHandler(house: number): Promise<void> {
    const info = this.lots.get(house)?.info;
    if (!info) return;
    const zone = this.nb.getZoningType(house);
    const names = [this.str(STR_ZONE_NAMES, 0), this.str(STR_ZONE_NAMES, 1)];
    const msg = this.str(STR_REZONE, 1).replace("%s", zone === Zone.Community ? names[1]! : names[0]!);
    const choice = await WinRadioDialogBox.show(this.ctx, msg, this.str(STR_REZONE, 0), names);
    if (choice === -1) return;
    if (choice === 0 && zone === Zone.Residential) return;
    if (choice === 1 && zone === Zone.Community) return;
    const store = await NeighborhoodStore.open(this.nb.dir);
    if (store.familyOnVacationAt(house) !== undefined) {
      await this.message(STR_BULLDOZE, 16, 17);
      return;
    }
    const newZone = choice === 1 ? Zone.Community : Zone.Residential;
    if (info.familyNumber === -1) {
      if (info.hasHouse) {
        if ((await this.message(STR_BULLDOZE, 9, 8, MB_YESNO)) !== IDYES) return;
        soundPlayer.playBySource(SND_DEMOLISH, -4);
        winMgr.setGlobalCursor(getCursor(3));
        let ok = false;
        try {
          ok = await this.evictFamily(house, true);
        } finally {
          winMgr.setGlobalCursor(null);
        }
        if (!ok) {
          await this.message(STR_BULLDOZE, 11, 10);
          return;
        }
      }
      await this.nb.setZoningType(house, newZone);
    } else {
      const text = this.str(STR_BULLDOZE, 7).replace("%s", info.familyName).replace("%s", makeMoneyString(info.netWorth, UI_LANGUAGE));
      if ((await TSWinMsgBox.show(this.ctx, text, this.str(STR_BULLDOZE, 6), MB_YESNO)) !== IDYES) return;
      let bulldoze = false;
      if (info.hasHouse) {
        if ((await this.message(STR_BULLDOZE, 9, 8, MB_YESNO)) !== IDYES) return;
        bulldoze = true;
      }
      soundPlayer.playBySource(bulldoze ? SND_DEMOLISH : SND_EVICT, -4);
      winMgr.setGlobalCursor(getCursor(3));
      let ok = false;
      try {
        ok = await this.evictFamily(house, bulldoze);
      } finally {
        winMgr.setGlobalCursor(null);
      }
      if (!ok) {
        await this.message(STR_BULLDOZE, 11, 10);
        return;
      }
      await this.nb.setZoningType(house, newZone);
    }
    await this.lots.get(house)?.reloadThumbnail();
    this.highlightLotsForMode();
  }

  /**
   * cWinNeighborhoodUL::RegularModeBtnHandler (jump table lbl_105BCCF0):
   *  0 Move In: the family picker; 1 Bulldoze: evict mode; 11 Rezone: rezone mode;
   *  2 Exit: cSimsApp::Quit ("Quitter ?", STR# 153), then "bkground_fade" and
   *    the screen ends with 1001;
   *  3 Inet: DoInternetUpdate; 4 Credits / 9 logo: cWinCredits modally over
   *    the screen ("bkground_credits", then "bkground_nhood1");
   *  5 / 6 Previous / Next: Neighborhood::Previous / Next, the wait cursor,
   *    every button disabled, DoNbhdScreen (the screen is rebuilt);
   *  7 Import: CycleThroughImports;
   *  8 Downtown: the lots' tutorial hilites off, townies and tourists
   *    refilled, "bkground_fade", ends with 1020; 10 Vacation (1030),
   *    12 Studio Town (1040), 13 Magic Town (1050) without the refill.
   */
  private async regularModeBtnHandler(index: number): Promise<void> {
    switch (index) {
      case BTN_MOVE_IN:
        return this.pickFamily();
      case BTN_BULLDOZE:
        this.setMode(NbhdMode.Evict);
        return;
      case BTN_REZONE:
        this.setMode(NbhdMode.Rezone);
        return;
      case BTN_EXIT: {
        // cSimsApp::Quit outside a lot: UIText STR# 153 entries 2 / 3, OK / Cancel.
        const r = await this.message(STR_QUIT, 2, 1, MB_OKCANCEL);
        if (r !== IDOK) return;
        soundPlayer.playBySource(MUSIC.fade, -1);
        this.callbacks.onEndModal(NBHD_EXIT);
        return;
      }
      case BTN_INET:
        // cWinNeighborhoodUL::DoInternetUpdate (nbhd/exporthtml.ts), +0x1b4 while it runs.
        return doInternetUpdate({
          ctx: this.ctx,
          nbhdDir: this.nb.dir,
          setBusy: (on) => {
            this.busy = on;
          },
          setLotsActive: (on) => {
            for (const lot of this.lots.values()) {
              lot.setFlag(0x400, on);
              lot.setFlag(WF_ENABLED, on);
            }
          },
          // cDDDSimsView::StartWatchCursor; TSOnTimerMsg ends each tick with SetGlobalCursor(0, 1).
          watchCursor: (on) => winMgr.setGlobalCursor(on ? getCursor(3) : null),
        });
      case BTN_CREDITS:
      case BTN_LOGO:
        return this.showCredits();
      case BTN_PREVIOUS:
      case BTN_NEXT:
        return this.switchNeighborhood(index === BTN_NEXT ? 1 : -1);
      case BTN_IMPORT:
        return this.cycleThroughImports();
      case BTN_DOWNTOWN:
        await this.refillNpcs();
        soundPlayer.playBySource(MUSIC.fade, -1);
        this.callbacks.onEndModal(NBHD_DOWNTOWN);
        return;
      case BTN_VACATION:
        soundPlayer.playBySource(MUSIC.fade, -1);
        this.callbacks.onEndModal(NBHD_VACATION);
        return;
      case BTN_STUDIOTOWN:
        soundPlayer.playBySource(MUSIC.fade, -1);
        this.callbacks.onEndModal(NBHD_STUDIOTOWN);
        return;
      case BTN_MAGICTOWN:
        soundPlayer.playBySource(MUSIC.fade, -1);
        this.callbacks.onEndModal(NBHD_MAGICTOWN);
        return;
    }
  }

  /** RegularModeBtnHandler(Credits): one cWinCredits at a time (lbl_105C3418). */
  private async showCredits(): Promise<void> {
    if (creditsOpen) return;
    creditsOpen = true;
    try {
      const dlg = new WinCredits(this.ctx);
      this.hideWindow();
      soundPlayer.playBySource(SND_CREDITS_MUSIC, -1);
      dlg.setArea(this.area.left, this.area.top, this.area.right, this.area.bottom);
      if (await dlg.init()) await winMgr.doModalWin(dlg);
      soundPlayer.playBySource(MUSIC.hood, -1);
      this.showWindow();
      winMgr.setFocus(this);
    } finally {
      creditsOpen = false;
    }
  }

  /**
   * cWinNeighborhoodUL::TSOnKeyDown: Escape leaves move in (back to the
   * picker), evict and rezone; '1'..'7' (VK 0x31..0x37) set the filter
   * (SetFilterMode(1 << (n - 1))) in the picker (+0x111 cleared) and are
   * swallowed on the main screen.
   */
  override tsOnKeyDown(key: string): boolean {
    if (this.busy) return false;
    if (key.length === 1 && key >= "1" && key <= "7") {
      if (this.picker) void this.setFilterMode(1 << (key.charCodeAt(0) - 0x31));
      return true;
    }
    if (key === "Escape") {
      if (this.mode === NbhdMode.MoveIn) {
        this.setMode(NbhdMode.Regular);
        void this.regularModeBtnHandler(BTN_MOVE_IN);
      } else if (this.mode === NbhdMode.Evict || this.mode === NbhdMode.Rezone) {
        this.setMode(NbhdMode.Regular);
      } else if (this.picker) {
        // Deviation: the original picker has no way out but a community lot; Escape ends it with 0.
        winMgr.endDialog(this, 0);
      }
      return true;
    }
    return super.tsOnKeyDown(key);
  }

  /**
   * Neighborhood::Previous / Next (the UserData directories by number,
   * wrapping), then the wait cursor, every button disabled and
   * cSimsApp::DoNbhdScreen rebuilding the screen. SwitchToNewNeighborhood
   * also stores the choice in the registry (SIMS_CURRENT_NEIGHBORHOOD_NUM /
   * _PATH); the caller keeps it.
   */
  private async switchNeighborhood(step: number): Promise<void> {
    this.setCursor(getCursor(3));
    for (const b of this.buttons) b.setEnabled(false);
    const dirs = await listNeighborhoodDirs();
    const i = dirs.findIndex((d) => neighborhoodNumber(d) === this.nb.number);
    const next = dirs[(i + step + dirs.length) % dirs.length] ?? this.nb.dir;
    this.callbacks.onSwitchNeighborhood(next);
  }
  /** The first tick's Unleashed import (nbhd/imports.ts) and the NPC pool refills. */
  private async firstTickImportsAndPools(): Promise<void> {
    let store = await NeighborhoodStore.open(this.nb.dir);
    if (await needsUnleashedImport(store)) {
      await tryImportUnleashedFamilies(this.ctx, this.nb.dir);
      store = await NeighborhoodStore.open(this.nb.dir);
      await refillNpcPools(this.ctx, store);
      this.callbacks.onSwitchNeighborhood(this.nb.dir);
      return;
    }
    await refillNpcPools(this.ctx, store);
  }

  override pump(now: number): void {
    if (this.openedMs < 0) {
      this.openedMs = now;
      this.lastTimerMs = now;
      this.lastWaveMs = now;
    }
    // TSOnTimerMsg every second; the first tick turns the lot rollovers on.
    if (now - this.lastTimerMs >= TIMER_MS) {
      this.lastTimerMs = now;
      if (this.firstTick) {
        this.firstTick = false;
        if (this.hoveredLot) void this.showPopup(this.hoveredLot);
        // TSOnTimerMsg's first tick (not busy): NeedsUnleashedImport ->
        // TryImportUnleashedFamilies and DoNbhdScreen(1) (the screen is built
        // again); then DoFirstTimeCelebs, RefillCelebs(12), DoFirstTimeFans,
        // RefillFans(18), DoFirstTimeMagicSims, RefillMagicSims(30).
        if (!this.busy) void this.firstTickImportsAndPools();
        // TSOnTimerMsg's first tick: every lot's tutorial arrow off, then, on the
        // regular screen (+0x111) while Neighborhood +0x12e (data[3]) is 0, on over
        // the tutorial lots (cWinLotBtn +0x1a0 == 1).
        for (const lot of this.lots.values()) void lot.hiliteForTutorial(this.ctx, false);
        if (!this.picker && this.nb.data.data[3] === 0) {
          for (const lot of this.lots.values()) if (lot.info?.isTutorial) void lot.hiliteForTutorial(this.ctx, true);
        }
      }
      // TSOnTimerMsg (not busy): one chance in 1000 of a Nessie.
      if (!this.busy && !this.nessie.active && getNextRandomNumber() % 1000 === 1) this.nessie.start();
    }
    // Popup unfurl (lot buttons: cTSWin+0xa0 = 75 ms), growing upward from its bottom edge.
    const popup = this.popup;
    if (popup?.isVisible()) {
      const t = Math.min(1, (now - this.popupShownMs) / UNFURL_MS);
      const shown = Math.trunc(this.popupTargetH * t + 0.5);
      const bottom = popup.area.top + popup.getH();
      const full = popup.fullSize();
      if (popup.getH() !== shown) popup.setArea(popup.area.left, bottom - shown, popup.area.left + full.w, bottom);
    }
    super.pump(now);
  }

  /** cWinNeighborhoodUL::TSPaint: the large backdrop and the wave clock. */
  override tsPaint(g: Gfx): void {
    if (this.largeMask) g.blit(this.largeMask, 0, 0);
    const now = performance.now();
    if (now - this.lastWaveMs >= WAVE_STEP_MS) {
      this.lastWaveMs = now;
      this.waveTick = (this.waveTick + 1) % 12;
      const frame = this.waves[this.waveTick >> 1];
      if (frame) this.waveBtn?.setImage(frame, 1);
    }
  }

  /**
   * cWinNeighborhoodUL::PostChildDraw. Picker: the title (shadow (30, 30, 30)
   * centered on (0x192, 0xc), white on (400, 10)). Main screen: the current
   * neighborhood number. Then, with a filter set, every community lot is
   * outlined blue (HiliteForCommunity, picker only) and DrawFilterAt puts the
   * icon at (lot x - 0x18, lot y - 0x46) over the lots of the filter's type.
   */
  override postChildDraw(g: Gfx): void {
    if (this.picker) {
      const font = this.font;
      if (font && this.title) {
        const a = font.textArea(this.title);
        const x = g.ox + this.offX - Math.trunc(a.w / 2);
        const y = g.oy + this.offY - Math.trunc(a.h / 2);
        font.drawText(g.ctx, this.title, x + 0x192, y + 0xc, "rgb(30,30,30)");
        font.drawText(g.ctx, this.title, x + 400, y + 10, "#ffffff");
      }
    } else {
      this.drawNeighborhoodNumber(g);
    }
    this.nessie.doNessie(g, this.waveTick, this.offX, this.offY);
    this.drawFilters(g);
  }

  /** PostChildDraw's filter loop and cWinNeighborhoodUL::DrawFilterAt (frame from +0x1dc). */
  private drawFilters(g: Gfx): void {
    if (this.filterMode === 0) return;
    const icon = this.filterIcon;
    const fw = icon ? Math.trunc(icon.width / 3) : 0;
    const frame = FILTER_FRAMES[Math.max(0, this.waveTick) % 6]!;
    for (const lot of this.lots.values()) {
      if (this.nb.getZoningType(lot.houseNumber) !== Zone.Community) continue;
      if (this.picker) lot.hiliteForCommunity(true);
      const info = lot.info;
      if (!icon || !info || (info.lotTypeFlags & this.filterMode) === 0) continue;
      // cWinLotBtn +0x1f8 / +0x1fc: the HouseInfo lot location (+0x6c / +0x70).
      g.blitPart(icon, frame * fw, 0, fw, icon.height, this.offX + info.lotX - 0x18, this.offY + info.lotY - 0x46);
    }
  }

  /** The main screen's part of PostChildDraw: the current neighborhood number. */
  private drawNeighborhoodNumber(g: Gfx): void {
    const font = this.font;
    const box = this.currentBox;
    if (!font || !box) return;
    const text = String(this.nb.number);
    const tw = font.textArea(text).w;
    const x = CURRENT_BOX_X + this.offX + Math.trunc(box.width / 2) - 1 - Math.trunc(tw / 2);
    const y = CURRENT_BOX_Y + this.offY + Math.trunc(box.height / 2) - 1 - Math.trunc(font.height / 2);
    font.drawText(g.ctx, text, g.ox + x, g.oy + y, "#ffffff");
  }
}
