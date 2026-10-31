/**
 * Control panel state (CPState): the model shared by every control panel
 * window and the lot view. Method names, enum values and dirty bits follow the
 * decompiled class so ported UI code reads like the original.
 *
 * Dirty bits (CPState+0xc) tell the panels what to refresh in
 * updateViewFromCPState(); the panels clear them after a refresh.
 */

import type { ResFile } from "./world/iffres.js";

export const enum Mode {
  Build = 0,
  Buy = 1,
  Live = 2,
  Options = 3,
  Camera = 4,
}

/** CPState::WallState values as tested in SetWallState. */
export const enum WallState {
  Up = 1,
  Down = 2,
  Cutaway = 4,
  Roof = 8,
}

export const DIRTY_PERSON = 0x2;
export const DIRTY_SPEED = 0x40;
export const DIRTY_WALLS = 0x80;
export const DIRTY_LEVEL = 0x100;
export const DIRTY_ROTATION = 0x800;
export const DIRTY_ZOOM = 0x1000;
export const DIRTY_FUNDS = 0x4000;
/** UpdateCPStateFromWorld and cWinViewControl::UpdateViewFromCPState use 0x2000 for the clock. */
export const DIRTY_TIME = 0x2000;
export const DIRTY_CPMODE = 0x100000;
export const DIRTY_PAUSE = 0x800000;
/** CPState::SetSelectedPerson sets bit 3 (cWinPeople refreshes the person on it). */
export const DIRTY_SELECTED_PERSON = 0x8;
/** CPState::CamSetSize marks the camera panel dirty. */
export const DIRTY_CAMERA = 0x200000;
/** cWinOptions::UpdateViewFromCPState refreshes its controls on this bit (set by SetMode). */
export const DIRTY_OPTIONS = 0x400000;
/** CPState::DisableSave */
export const DIRTY_SAVE_DISABLED = 0x10000000;
/** cWinCatalog::SetProduct marks the shop item (CPState+0xd4/+0xd8) dirty. */
export const DIRTY_SHOP_ITEM = 0x200;
/** The Shop* setters mark the catalog page dirty (cWinCatalog refreshes on it). */
export const DIRTY_CATALOG = 0x400;

/** CPState::ArchUndo / ArchRedo mark bit 2 (cWinArch refreshes its undo / redo buttons). */
export const DIRTY_ARCH_UNDO = 0x4;
/** CPState::ArchSetCurrentTool */
export const DIRTY_ARCH_TOOL = 0x10;
/** CPState::ArchSetCurrentSubtool */
export const DIRTY_ARCH_SUBTOOL = 0x20;

/** CPState::ArchTools (CPState+0x58), in cWinArch's button order (UIText STR# 139 "BldTips"). */
export const enum ArchTool {
  Terrain = 0,
  Water = 1,
  Wall = 2,
  Wallpaper = 3,
  Stair = 4,
  Fireplace = 5,
  Plant = 6,
  Floor = 7,
  Door = 8,
  Window = 9,
  Roof = 10,
  Hand = 11,
}

/**
 * A build mode product (Product) as CPState::ArchSetCurrentTool reads it:
 * tool products (terrain / water tool buttons) by their button index, wall
 * styles (+0x14 kind 3, +0x30), wallpapers (+0x2c), floors (+0x34), and
 * objects by GUID (doors, windows, stairs, fireplaces, plants, columns, pool
 * equipment: cMoveTool modes 3..9).
 */
export interface ArchProduct {
  /** Product +0x14 (3 = wall style). */
  readonly kind: number;
  /** ProductButton +8: the tool a tool product stands for (terrain: raise, lower, level, grass; water: pool, water), else -1. */
  readonly toolIndex: number;
  /** Object products' GUID, else 0. */
  readonly guid: number;
  /** +0x2c wallpaper id, +0x30 wall style, +0x34 floor style. */
  readonly wallpaper: number;
  readonly wallStyle: number;
  readonly floorStyle: number;
  getPrice(): number;
  getProductName(): string;
}

/** cGameTools' UndoManager as CPState::ArchUndo / ArchRedo / ArchCanUndo / ArchCanRedo reach it; the lot view installs it. */
export interface ArchUndoHooks {
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
}

/**
 * cRoofLayer as cWinRoofPanel reaches it: the roof pitch (0 flat, 0.4
 * shallow, 0.6 medium, 1 steep) and pattern (a GameData/Roofs bitmap name
 * without extension); each change is one cRoofUndoable. The lot view installs it.
 */
export interface ArchRoofHooks {
  getPitch(): number;
  setPitch(pitch: number): void;
  getPattern(): string;
  setPattern(name: string): void;
}

/** CPState::NewCatalogSort (CPState+0x90). */
export const enum CatalogSort {
  Room = 0,
  Function = 1,
  Downtown = 2,
  Vacation = 3,
  Community = 4,
  Studiotown = 5,
  Magictown = 6,
}

/** CPState::eWinCatalogSortState (CPState+0x94): the category books, or one category's items. */
export const enum CatalogSortState {
  Books = 0,
  Items = 1,
}

/** What the shop item (the product being placed) is, from the lot view's side. */
export interface ShopProduct {
  readonly guid: number;
  getPrice(): number;
  getProductName(): string;
}

/** CPState::CameraSize */
export const enum CameraSize {
  Small = 0,
  Medium = 1,
  Large = 2,
  Custom = 3,
}

/** CPState::CameraQuality */
export const enum CameraQuality {
  Low = 0,
  Medium = 1,
  High = 2,
}

/** ___sinit__CPState_cpp: snapshot sizes (small, medium, large). */
const CAMERA_SIZES: ReadonlyArray<readonly [number, number]> = [
  [200, 150],
  [400, 300],
  [600, 400],
];
export const DIRTY_ALL = 0xffffffff;

/** A member of the active family, as the panels need it. */
export interface PersonInfo {
  id: number;
  firstName: string;
  lastName: string;
  /** -100..100 per motive, in the game's motive order. */
  motives: number[];
  /** 0..1000 per skill. */
  skills: number[];
  /** 0..1000 per personality trait. */
  personality: number[];
  isChild: boolean;
  isFemale: boolean;
  // Live mode panel data (cWinPeople and its subpanels), optional: absent = neutral.
  // `motives` above is indexed by the game's motive number (3 = overall mood,
  // 5 energy, 6 comfort, 7 hunger, 8 hygiene, 9 bladder, 13 room, 14 social, 15 fun).
  /** Person data (Int16[256], Behavior.iff STR# 200 indices, see data/neighborhood.ts PD). */
  personData?: Int16Array;
  /** Neighbor id (relationship matrix key). */
  neighborId?: number;
  /** The character's OBJD GUID (the person object on the lot). */
  guid?: number;
  /** BMP_ 2002 of the character file: three faces (normal, happy, sad) side by side. */
  face?: ImageBitmap | null;
  /** BMP_ 2003 of the character file: the relationship picture. */
  relFace?: ImageBitmap | null;
  /** Relationship matrix row: other neighbor id -> [daily, flags, lifetime, ...]. */
  relationships?: Array<{ other: number; values: number[] }>;
  /** PersonFinder::GetDescription: the character's catalog description (CTSS string 1). */
  bio?: string;
}

/**
 * Person data 65 (gender, also read as cXPerson+0x60e): 0 male, 1 female,
 * bit 1 dog, bit 2 cat. Values above 1 are pets.
 */
export function personGender(p: PersonInfo): number {
  return p.personData?.[65] ?? (p.isFemale ? 1 : 0);
}

/**
 * HouseStats as the house subpanel reads it (House::GetHouseStats then the
 * HouseStats getters). The lot fills it; a default-constructed HouseStats is
 * all zeros.
 */
export interface HouseStats {
  /** Scores, 0..100. */
  sizeScore: number;
  furnishingsScore: number;
  yardScore: number;
  upkeepScore: number;
  layoutScore: number;
  squareFeet: number;
  numBedrooms: number;
  numBathrooms: number;
  /** 0 small, 1 medium, 2 large (other values print "**Unknown**"). */
  lotSize: number;
}

/**
 * What the state needs from the lot view (HouseViewer in the original).
 * The renderer implements it; tests can leave it out.
 */
export interface HouseViewerHooks {
  setScale(zoom: number): void;
  setRotation(rotation: number): void;
  setLevel(level: number): void;
  setWallState(state: WallState): void;
  /** cXObject::CenterHouseViewOnMe(selected person, smooth). */
  centerOnSelected?(): void;
  /**
   * PersonFinder::GetInstance / CreateInstance: the family member with this
   * GUID gets a person on the lot when it has none; true when it had none.
   */
  createPersonInstance?(guid: number): boolean;
  /** HouseViewer::SetViewportHeight (cWinViewControl::SetMode). */
  setViewportHeight?(height: number): void;
}

/**
 * The object of CPState::StartDisposing (cMoveTool::StartDisposing), as
 * cWinDisposePopup::BuildMyBuffer reads it.
 */
export interface DisposeItem {
  /** ObjSelector::GetMasterSelector: GUID (Catalog::FindProduct), object file and OBJD id (DrawDefaultObjectIcon). */
  readonly guid: number;
  readonly res: ResFile;
  readonly objdId: number;
  /** The master OBJD +0x8a: non-zero for build mode items (the second half of STR# 0x88). */
  readonly buildModeType: number;
  /** cXObject::GetCurrentValue */
  readonly currentValue: number;
  /** cXObject::UserCanDelete (vtable +0x78) */
  readonly canDelete: boolean;
  /** +0x1e8: not a new purchase; +0x1e9: refundable; +0x1ec: refund factor (0, 0.8 or 1). */
  readonly notNew: boolean;
  readonly refundable: boolean;
  readonly factor: number;
}

/** cWinViewControl speed buttons (lbl_1059B8D8): the simulator speed is 1000 x k. */
const MOTIVE_PULSE_SPEED_K = [0.7602, 0.924, 0.99415] as const;

export class CPState {
  dirty = DIRTY_ALL;
  private mode = Mode.Live;
  private cpMode = 1;
  private speed = 1;
  private paused = false;
  private zoom = 3;
  private rotation = 0;
  private level = 1;
  private wallState = WallState.Cutaway;
  private funds = 20000;
  /** Minutes since midnight, and day index (0 = first day). */
  private timeMinutes = 8 * 60;
  private day = 0;
  private selected = 0;
  family: PersonInfo[] = [];
  /** Everyone the family may know (relationships panel), looked up by neighborId. */
  neighbors: PersonInfo[] = [];
  familyName = "";
  viewer: HouseViewerHooks | null = null;
  private listeners: Array<(s: CPState) => void> = [];

  /** Panels subscribe to refresh after a change (cWinCPanel::UpdateViewFromCPState). */
  onChange(fn: (s: CPState) => void): void {
    this.listeners.push(fn);
  }

  offChange(fn: (s: CPState) => void): void {
    this.listeners = this.listeners.filter((f) => f !== fn);
  }

  update(): void {
    this.advanceMotivePulse(performance.now());
    if (!this.dirty) return;
    for (const fn of this.listeners) fn(this);
    this.dirty = 0;
  }

  private touch(bits: number): void {
    this.dirty |= bits;
  }

  /** CPState::SetDirty. */
  setDirty(bits: number): void {
    this.touch(bits);
  }

  // --- modes -----------------------------------------------------------------

  getMode(): Mode {
    return this.mode;
  }

  setMode(mode: Mode, force = false): void {
    if (this.mode === mode && !force) return;
    this.mode = mode;
    // CPState::SetMode marks everything but two bits dirty.
    this.touch(0xfff7ffbf);
  }

  getCPMode(): number {
    return this.cpMode;
  }

  setCPMode(mode: number, force = false): void {
    if (this.cpMode === mode && !force) return;
    this.cpMode = mode;
    this.touch(DIRTY_CPMODE);
  }

  // --- clock -----------------------------------------------------------------

  getSpeed(): number {
    return this.speed;
  }

  /** Bumped by every setSpeed (dirty 0x40): the simulator applies the speed only then (UpdateWorldFromCPState). */
  speedSerial = 0;

  setSpeed(speed: number): void {
    this.speed = speed;
    this.speedSerial++;
    this.touch(DIRTY_SPEED);
    this.updateMotivePulsePeriod();
  }

  // --- motive pulse (CPState+0x1f0) --------------------------------------------

  /** PulseGenerator at +0x1f0: accumulated time (+0), period (+4, 100 at construction), last time (+8). */
  private motivePulseAccum = 0;
  private motivePulsePeriod = 100;
  private motivePulseLast = 0;
  /** Second PulseGenerator at +0x200 (period 100 at construction, three times the first one's after UpdateSpeed). */
  private slowPulseAccum = 0;
  private slowPulsePeriod = 100;

  /**
   * The +0x1f0 part of CPState::UpdateSpeed (dirty 0x40): the simulator's
   * tick period trunc(0.5 + 172 - speed / 1000 x 171) ms (speed = 1000 x the
   * speed button's k, lbl_1059B8D8), the pulse period trunc(0.5 + 1000 x
   * tick period / 42) ms (lbl_105BC0B0): one second at speed 1.
   */
  private updateMotivePulsePeriod(): void {
    const k = MOTIVE_PULSE_SPEED_K[this.speed - 1];
    if (k === undefined) return;
    const tick = Math.trunc(0.5 + 172 - ((Math.trunc(0.5 + 1000 * k) / 1000) * 171));
    this.motivePulsePeriod = Math.trunc(0.5 + (1000 * tick) / 42);
    // +0x200: trunc(0.5 + 3000 x tick period / 42) (lbl_105BC0B0[5]).
    this.slowPulsePeriod = Math.trunc(0.5 + (3000 * tick) / 42);
  }

  /** CPState::Update: PulseGenerator::AdvanceTime then ShouldPulse sets dirty 1 (the motives). */
  private advanceMotivePulse(now: number): void {
    if (this.motivePulseLast === 0) {
      // CPState::Init's first UpdateSpeed (everything dirty).
      this.updateMotivePulsePeriod();
      this.motivePulseAccum = this.motivePulsePeriod;
      this.slowPulseAccum = this.slowPulsePeriod;
    }
    else {
      this.motivePulseAccum += now - this.motivePulseLast;
      this.slowPulseAccum += now - this.motivePulseLast;
    }
    this.motivePulseLast = now;
    if (this.shouldPulseMotives()) this.touch(1);
    // CPState::Update, +0x200: ShouldPulse sets dirty |= 0x6078000 (the
    // panels' periodic refresh bits 0x8000..0x40000, 0x2000000, 0x4000000).
    if (this.slowPulseAccum >= this.slowPulsePeriod) {
      this.slowPulseAccum -= this.slowPulsePeriod;
      this.touch(0x6078000);
    }
  }

  /** PulseGenerator::ShouldPulse on +0x1f0 (cWinPeople pumps the motives once per pulse). */
  shouldPulseMotives(): boolean {
    if (this.motivePulseAccum < this.motivePulsePeriod) return false;
    this.motivePulseAccum -= this.motivePulsePeriod;
    return true;
  }

  isPaused(): boolean {
    return this.paused;
  }

  pause(on: boolean): void {
    this.paused = on;
    this.touch(DIRTY_SPEED | DIRTY_PAUSE);
  }

  getTime(): { day: number; hour: number; minute: number } {
    return { day: this.day, hour: Math.floor(this.timeMinutes / 60), minute: this.timeMinutes % 60 };
  }

  setTime(day: number, minutes: number): void {
    this.day = day;
    this.timeMinutes = minutes;
    this.touch(DIRTY_TIME);
  }

  getFunds(): number {
    return this.funds;
  }

  setFunds(funds: number): void {
    this.funds = funds;
    this.touch(DIRTY_FUNDS);
  }

  // --- view ------------------------------------------------------------------

  getZoom(): number {
    return this.zoom;
  }

  canZoomIn(): boolean {
    return this.zoom !== 3;
  }

  canZoomOut(): boolean {
    return this.zoom !== 1;
  }

  zoomIn(): void {
    if (this.zoom < 3) this.setZoom(this.zoom + 1);
  }

  zoomOut(): void {
    if (this.zoom > 1) this.setZoom(this.zoom - 1);
  }

  setZoom(zoom: number): void {
    this.zoom = zoom;
    this.touch(DIRTY_ZOOM);
    this.viewer?.setScale(zoom);
  }

  getRotation(): number {
    return this.rotation;
  }

  rotateLeft(): void {
    this.setRotation((this.rotation + 3) & 3);
  }

  rotateRight(): void {
    this.setRotation((this.rotation + 1) & 3);
  }

  setRotation(r: number): void {
    this.rotation = r & 3;
    this.touch(DIRTY_ROTATION);
    this.viewer?.setRotation(this.rotation);
  }

  getLevel(): number {
    return this.level;
  }

  setLevel(level: number): void {
    this.level = level || 1;
    this.touch(DIRTY_LEVEL);
    this.viewer?.setLevel(this.level);
  }

  getWallState(): WallState {
    return this.wallState;
  }

  setWallState(state: WallState): void {
    if (state === this.wallState) return;
    this.wallState = state;
    this.touch(DIRTY_WALLS);
    this.viewer?.setWallState(state);
  }

  // --- people ----------------------------------------------------------------

  personGetSelected(): PersonInfo | null {
    return this.family[this.selected] ?? null;
  }

  selectedIndex(): number {
    return this.selected;
  }

  /**
   * Neighborhood::RemoveFromFamily's UI side: the member leaves the family
   * (PersonFinder's house index follows Family::GetIndexedMember) and
   * GlobalDispatch(0xe8) makes cSimsApp SetDirty(0xffffffff). The selection
   * stays on the same person.
   */
  removeFamilyMember(guid: number): void {
    const i = this.family.findIndex((p) => ((p.guid ?? 0) | 0) === (guid | 0));
    if (i < 0) return;
    this.family.splice(i, 1);
    if (this.selected > i || this.selected >= this.family.length) this.selected = Math.max(0, this.selected - 1);
    this.touch(0xffffffff);
  }

  /**
   * CPState::SetSelectedPerson: a member with no person on the lot gets one
   * (PersonFinder::GetInstance == 0 -> CreateInstance). Selecting the person
   * already selected (PersonFinder::GetSelected: -1 when the selected
   * member had no person) centers the house view on them
   * (cXObject::CenterHouseViewOnMe(p, 1), smooth; its click sound is not
   * played).
   */
  setSelectedPerson(index: number): void {
    if (index < 0 || index >= this.family.length) return;
    const guid = this.family[index]!.guid;
    const created = guid !== undefined && (this.viewer?.createPersonInstance?.(guid) ?? false);
    if (index === this.selected && !created) {
      this.viewer?.centerOnSelected?.();
      return;
    }
    this.selected = index;
    this.touch(DIRTY_PERSON | DIRTY_SELECTED_PERSON);
  }

  /** Neighborhood::GetZoningType of the current lot (1 = residential); the lot fills it. */
  zoningType = 1;

  getFamilyName(): string {
    return this.familyName;
  }

  // --- view control gadget (cWinViewControl) ---------------------------------

  /** Friends of the active family (CPState::GetFamilyFriendCount); the simulation fills it. */
  familyFriendCount = 0;
  /** Statistics of the current house (House::GetHouseStats); the lot fills it. */
  houseStats: HouseStats = {
    sizeScore: 0,
    furnishingsScore: 0,
    yardScore: 0,
    upkeepScore: 0,
    layoutScore: 0,
    squareFeet: 0,
    numBedrooms: 0,
    numBathrooms: 0,
    lotSize: 0,
  };
  /** CPState+0x54 (dirty 0x1000000): Buy and Build modes unavailable. */
  buyAndBuildDisabled = false;
  /** Dirty 0x8000000: Live and Camera modes unavailable. */
  liveModeDisabled = false;
  /** CPState+0 (HideButtonsForLocation): hides funds and friend count. */
  hideForLocation = false;
  /** Globals read by Is2ndLevelFloorable / HasBeenTo2ndLevel; the lot fills them. */
  secondLevelFloorable = false;
  beenTo2ndLevel = false;

  getFamilyFriendCount(): number {
    return this.familyFriendCount;
  }

  isBuyAndBuildDisabled(): boolean {
    return this.buyAndBuildDisabled;
  }

  isLiveModeDisabled(): boolean {
    return this.liveModeDisabled;
  }

  isHideForLocation(): boolean {
    return this.hideForLocation;
  }

  is2ndLevelFloorable(): boolean {
    return this.secondLevelFloorable;
  }

  hasBeenTo2ndLevel(): boolean {
    return this.beenTo2ndLevel;
  }

  /** CPState::GetWallButtonEnableFlags: bit 0 walls up, bit 1 walls down, bit 2 cutaway. */
  getWallButtonEnableFlags(): number {
    return this.level !== 1 && this.level !== 2 ? 1 : 7;
  }

  // --- buy mode shop (CPState+0x8c..0x1db) -----------------------------------

  /** CPState::ShoppingState (+0x8c); 3 once an item is picked (ShopSetCatalogItem). */
  shopState = 3;
  private shopSort = CatalogSort.Function;
  private shopSortState = CatalogSortState.Books;
  /** Current catalog and sub-catalog per sort (+0x98..+0xcc, two ints per sort). */
  private readonly shopCatalogs: Array<[number, number]> = Array.from({ length: 7 }, () => [0, 0]);
  private shopPage = 0;
  private shopProduct: ShopProduct | null = null;
  private shopItem = -1;
  /** Page last seen per catalog * 8 + sub-catalog (+0xdc), shared by every sort. */
  private readonly previousPages = new Int32Array(64);
  /**
   * cWinCPanel::SoldItem as reached from CPState::ShopSoldItem (CPState+0x44 is
   * the control panel); the catalog installs it.
   */
  soldItemHandler: (() => void) | null = null;

  shopGetSort(): CatalogSort {
    return this.shopSort;
  }

  shopGetSortState(): CatalogSortState {
    return this.shopSortState;
  }

  /** The current catalog (book) of the current sort. */
  shopGetCatalog(): number {
    return this.shopCatalogs[this.shopSort]![0];
  }

  shopGetSubCatalog(): number {
    return this.shopCatalogs[this.shopSort]![1];
  }

  /** CPState::ShopSetSort: back to the books. */
  shopSetSort(sort: CatalogSort): void {
    this.shopSort = sort;
    this.shopSortState = CatalogSortState.Books;
    this.updateShopItem();
  }

  /** CPState::ShopSetSortState */
  shopSetSortState(s: CatalogSortState): void {
    this.shopSortState = s;
    this.updateShopItem();
  }

  /**
   * CPState::ShopSet{Room,Function,Downtown,Vacation,Community,Studiotown,Magictown}Catalog
   * for the current sort: a new book starts at its first sub-catalog. (The
   * original also resets the placement tool, cGameTools tool 7.)
   */
  shopSetCatalog(cat: number): void {
    const c = this.shopCatalogs[this.shopSort]!;
    if (c[0] === cat) return;
    c[0] = cat;
    c[1] = 0;
    this.updateShopItem();
  }

  /** CPState::ShopSet...SubCatalog: remembers the page of the sub-catalog it leaves. */
  shopSetSubCatalog(sub: number): void {
    const c = this.shopCatalogs[this.shopSort]!;
    if (c[1] === sub) return;
    this.previousPages[c[0] * 8 + c[1]] = this.shopPage;
    c[1] = sub;
    this.updateShopItem();
  }

  /** CPState::UpdateShopItem: no item; the page comes back from previousPages. */
  private updateShopItem(): void {
    this.shopItem = 0;
    this.shopProduct = null;
    if (this.shopSortState === CatalogSortState.Books) {
      this.shopPage = 0;
    } else {
      const [cat, sub] = this.shopCatalogs[this.shopSort]!;
      this.shopPage = this.previousPages[cat * 8 + sub] ?? 0;
    }
    this.touch(DIRTY_CATALOG);
  }

  shopGetCatalogPage(): number {
    return this.shopPage;
  }

  /** CPState::ShopSetCatalogPage */
  shopSetCatalogPage(page: number): void {
    const [cat, sub] = this.shopCatalogs[this.shopSort]!;
    this.previousPages[cat * 8 + sub] = this.shopPage;
    this.touch(DIRTY_CATALOG);
    this.shopPage = page;
  }

  /** CPState::ResetPreviousPages */
  resetPreviousPages(): void {
    this.previousPages.fill(0);
  }

  /**
   * CPState::ShopSetCatalogItem: the product picked in the catalog (slot index
   * on the page, -1 and null when none). The lot view places
   * shopGetCatalogItem() and calls shopSoldItem() once it is bought.
   */
  shopSetCatalogItem(index: number, product: ShopProduct | null): void {
    this.shopItem = index;
    this.shopProduct = product;
    this.shopState = 3;
  }

  shopGetCatalogItem(): ShopProduct | null {
    return this.shopProduct;
  }

  shopGetCatalogItemIndex(): number {
    return this.shopItem;
  }

  /** CPState::ShopSoldItem (only in buy mode). */
  shopSoldItem(): void {
    if (this.mode !== Mode.Buy) return;
    this.shopSetCatalogItem(-1, null);
    this.soldItemHandler?.();
  }

  // --- disposing (CPState+0x1e4..+0x1ec) ---------------------------------------

  /** +0x1e4: the object held by the buy tool, offered for sale (null when none). */
  private disposing: DisposeItem | null = null;
  /** cWinCPanel::EnableDisposePopup / DisableDisposePopup (CPState+0x44 is the control panel). */
  disposeHandler: { enable(item: DisposeItem): void; disable(): void } | null = null;
  /** cMoveTool::DoDispose when the current tool (CPState+0x3c) is the buy tool; the lot view installs it. */
  disposeTool: (() => void) | null = null;

  /** CPState::StartDisposing(obj, notNewPurchase, refundable, refund factor). */
  startDisposing(item: DisposeItem): void {
    this.stopDisposing();
    this.disposing = item;
    this.disposeHandler?.enable(item);
  }

  /** CPState::StopDisposing */
  stopDisposing(): void {
    this.disposing = null;
    this.disposeHandler?.disable();
  }

  /** CPState::DoDispose: the dispose popup was clicked. */
  doDispose(): void {
    this.disposeTool?.();
  }

  // --- build mode (CPState+0x58..+0x88) ---------------------------------------

  /** +0x58 */
  private archTool = ArchTool.Hand;
  /** +0x5c: the sub-tool (product) picked per arch tool. */
  private readonly archSubtools: Array<ArchProduct | null> = Array.from({ length: 12 }, () => null);
  /** The lot view's undo manager (cGameTools +8). */
  archUndoHooks: ArchUndoHooks | null = null;

  /** CPState::ArchGetCurrentTool */
  archGetCurrentTool(): ArchTool {
    return this.archTool;
  }

  /** CPState::ArchSetCurrentTool (the lot view maps it to a cGameTools tool on DIRTY_ARCH_TOOL). */
  archSetCurrentTool(tool: ArchTool): void {
    const doorsOrWindows = tool === ArchTool.Door || tool === ArchTool.Window;
    // Doors and windows need to see walls: the roof view goes back to walls up.
    if (doorsOrWindows && this.getWallState() === WallState.Roof) this.setWallState(WallState.Up);
    this.archTool = tool;
    this.touch(DIRTY_ARCH_TOOL);
  }

  /** CPState::ArchGetCurrentSubtool */
  archGetCurrentSubtool(): ArchProduct | null {
    return this.archSubtools[this.archTool] ?? null;
  }

  /** CPState::ArchSetCurrentSubtool */
  archSetCurrentSubtool(p: ArchProduct | null): void {
    this.archSubtools[this.archTool] = p;
    this.archSetCurrentTool(this.archTool);
    this.touch(DIRTY_ARCH_SUBTOOL);
  }

  /** CPState::ArchGetCurrentFloorStyle: the floor product's style, else 1. */
  archGetCurrentFloorStyle(): number {
    return this.archSubtools[ArchTool.Floor]?.floorStyle ?? 1;
  }

  /** CPState::ArchUndo */
  archUndo(): void {
    this.archUndoHooks?.undo();
    this.touch(DIRTY_ARCH_UNDO);
  }

  /** CPState::ArchRedo */
  archRedo(): void {
    this.archUndoHooks?.redo();
    this.touch(DIRTY_ARCH_UNDO);
  }

  archCanUndo(): boolean {
    return this.archUndoHooks?.canUndo() ?? false;
  }

  archCanRedo(): boolean {
    return this.archUndoHooks?.canRedo() ?? false;
  }

  /** The lot's roof (cRoofLayer) for the roof panel; null until the lot view installs it. */
  archRoofHooks: ArchRoofHooks | null = null;

  /** CPState::UpdateWorldFromCPState: the lot view applies `bits` now instead of on its next update (it installs the hook). */
  worldUpdateHook: ((bits: number) => void) | null = null;

  updateWorldFromCPState(bits: number): void {
    this.worldUpdateHook?.(bits);
  }

  // --- options and camera panels ---------------------------------------------

  /** Neighborhood house number of the current lot (cSimsApp+0x1c, +0x24); the lot fills it. */
  houseNumber = 0;
  /** CPState+0x56 */
  private saveDisabled = false;
  /** CPState+0x210..0x21c (constructor: medium size, medium quality). */
  private camSize = CameraSize.Medium;
  private camQuality = CameraQuality.Medium;
  private camWidth = CAMERA_SIZES[CameraSize.Medium]![0];
  private camHeight = CAMERA_SIZES[CameraSize.Medium]![1];

  isSaveDisabled(): boolean {
    return this.saveDisabled;
  }

  disableSave(on: boolean): void {
    this.saveDisabled = on;
    this.touch(DIRTY_SAVE_DISABLED);
  }

  camGetSize(): CameraSize {
    return this.camSize;
  }

  camGetWidth(): number {
    return this.camWidth;
  }

  camGetHeight(): number {
    return this.camHeight;
  }

  /** CPState::CamSetSize(CameraSize) */
  camSetSize(size: CameraSize): void {
    this.camSize = size;
    const wh = CAMERA_SIZES[size];
    if (wh) [this.camWidth, this.camHeight] = wh;
    this.touch(DIRTY_CAMERA);
  }

  /** CPState::CamSetSize(int, int): clamped to small..large, matched against the presets. */
  camSetCustomSize(w: number, h: number): void {
    const [minW, minH] = CAMERA_SIZES[CameraSize.Small]!;
    const [maxW, maxH] = CAMERA_SIZES[CameraSize.Large]!;
    const cw = Math.min(maxW, Math.max(minW, w));
    const ch = Math.min(maxH, Math.max(minH, h));
    const preset = CAMERA_SIZES.findIndex(([pw, ph]) => pw === cw && ph === ch);
    this.camSize = preset === -1 ? CameraSize.Custom : (preset as CameraSize);
    this.camWidth = cw;
    this.camHeight = ch;
    this.touch(DIRTY_CAMERA);
  }

  camGetQuality(): CameraQuality {
    return this.camQuality;
  }

  /** CPState::CamSetQuality (no dirty bit, like the original). */
  camSetQuality(q: CameraQuality): void {
    this.camQuality = q;
  }

  /** CPState::CamGetQualityValue: JPEG quality of a snapshot. */
  camGetQualityValue(): number {
    return this.camQuality === CameraQuality.Low ? 0x14 : this.camQuality === CameraQuality.High ? 0x5a : 0x32;
  }
}
