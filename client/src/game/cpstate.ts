/**
 * Control panel state (CPState): the model shared by every control panel
 * window and the lot view. Method names, enum values and dirty bits follow the
 * decompiled class so ported UI code reads like the original.
 *
 * Dirty bits (CPState+0xc) tell the panels what to refresh in
 * updateViewFromCPState(); the panels clear them after a refresh.
 */

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
  /** BMP_ 2002 of the character file: three faces (normal, happy, sad) side by side. */
  face?: ImageBitmap | null;
  /** BMP_ 2003 of the character file: the relationship picture. */
  relFace?: ImageBitmap | null;
  /** Relationship matrix row: other neighbor id -> [daily, flags, lifetime, ...]. */
  relationships?: Array<{ other: number; values: number[] }>;
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
}

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

  setSpeed(speed: number): void {
    this.speed = speed;
    this.touch(DIRTY_SPEED);
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

  setSelectedPerson(index: number): void {
    if (index < 0 || index >= this.family.length) return;
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
}
