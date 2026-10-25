/**
 * cOptionsMgr — the player's settings (Options panel), a singleton reached
 * through GetOptionsMgr().
 *
 * Fields and defaults from the decompiled class (Mac build):
 *  - its own bytes: +1 interface effects (BoboVision), +2 quick tips,
 *    +3 auto snapshots, +4 live PIP, +5 export HTML, +0xc edge scrolling,
 *    +0x14/+0x18/+0x1c sound effects / music / voice volumes (0..10);
 *  - settings that live in other systems and are only read and written
 *    through it: anti-aliasing, shadows and lighting (the sprite decoder
 *    globals, lbl_105BA240[0x39/0x38/0x3a]), terrain detail (cTerrain
 *    quality), character detail (RenderMesh default quality), auto-centering
 *    (lbl_105BA84C), free will (cXObject::SetFreeWill) and sim in background
 *    (lbl_105BA844, stored inverted).
 * RestoreFactorySettings gives the defaults below. cOptionsMgr::Load lowers a
 * few of them on the very first run (terrain medium, character low, live PIP
 * off); that is a slow-machine guess, not reproduced here.
 *
 * The game saves the settings to a resource file (cOptionsMgr::Save, chunk
 * 'Optn'); we keep them in localStorage. Systems that apply a setting
 * (renderer, sound, simulation) subscribe with onChange.
 */

/** cOptionsMgr::TriState */
export const enum TriState {
  Low = 0,
  Medium = 1,
  High = 2,
}

export interface OptionsData {
  antiAlias: boolean;
  shadows: boolean;
  lighting: boolean;
  /** "Interface effects": alpha-blended fades of panels and popups. */
  boboVision: boolean;
  terrainDetail: TriState;
  characterDetail: TriState;
  fxVolume: number;
  musicVolume: number;
  voxVolume: number;
  autoCentering: boolean;
  freeWill: boolean;
  edgeScrolling: boolean;
  simInBackground: boolean;
  quickTips: boolean;
  autoSnapshots: boolean;
  livePIP: boolean;
  exportHTML: boolean;
}

/** cOptionsMgr::RestoreFactorySettings */
const FACTORY: OptionsData = {
  antiAlias: true,
  shadows: true,
  lighting: true,
  boboVision: true,
  terrainDetail: TriState.High,
  characterDetail: TriState.High,
  fxVolume: 8,
  musicVolume: 8,
  voxVolume: 8,
  autoCentering: true,
  freeWill: true,
  edgeScrolling: true,
  // lbl_105BA844 = 1, which GetSimInBackground reads as false.
  simInBackground: false,
  quickTips: true,
  autoSnapshots: true,
  livePIP: true,
  exportHTML: true,
};

/** cOptionsMgr::SetQuickTips: tooltip delay (lbl_105BA848) and button async timeout (lbl_105BA774). */
const QUICK_TIPS_TIMINGS = { toolTipDelay: 0, asyncTimeout: 0xfa };
const NORMAL_TIMINGS = { toolTipDelay: 0x2ee, asyncTimeout: 0x14d };

const STORAGE_KEY = "thesimsweb.options";

export class OptionsMgr {
  private data: OptionsData = { ...FACTORY };
  private listeners: Array<(o: OptionsMgr) => void> = [];

  constructor() {
    this.load();
  }

  onChange(fn: (o: OptionsMgr) => void): void {
    this.listeners.push(fn);
  }

  offChange(fn: (o: OptionsMgr) => void): void {
    this.listeners = this.listeners.filter((f) => f !== fn);
  }

  /** cOptionsMgr::RestoreFactorySettings */
  restoreFactorySettings(): void {
    this.data = { ...FACTORY };
    this.changed();
  }

  // --- graphics --------------------------------------------------------------

  getAA(): boolean {
    return this.data.antiAlias;
  }
  setAA(on: boolean): void {
    this.set("antiAlias", on);
  }
  getShadows(): boolean {
    return this.data.shadows;
  }
  setShadows(on: boolean): void {
    this.set("shadows", on);
  }
  getLighting(): boolean {
    return this.data.lighting;
  }
  setLighting(on: boolean): void {
    this.set("lighting", on);
  }
  getBoboVision(): boolean {
    return this.data.boboVision;
  }
  setBoboVision(on: boolean): void {
    this.set("boboVision", on);
  }
  getTerrainDetail(): TriState {
    return this.data.terrainDetail;
  }
  setTerrainDetail(v: TriState): void {
    this.set("terrainDetail", v);
  }
  getCharacterDetail(): TriState {
    return this.data.characterDetail;
  }
  setCharacterDetail(v: TriState): void {
    this.set("characterDetail", v);
  }

  // --- sound (0..10, the sliders' range) --------------------------------------

  getFXVolume(): number {
    return this.data.fxVolume;
  }
  setFXVolume(v: number): void {
    this.set("fxVolume", v);
  }
  getMusicVolume(): number {
    return this.data.musicVolume;
  }
  setMusicVolume(v: number): void {
    this.set("musicVolume", v);
  }
  getVoxVolume(): number {
    return this.data.voxVolume;
  }
  setVoxVolume(v: number): void {
    this.set("voxVolume", v);
  }

  // --- play --------------------------------------------------------------------

  getAutoCentering(): boolean {
    return this.data.autoCentering;
  }
  setAutoCentering(on: boolean): void {
    this.set("autoCentering", on);
  }
  getFreeWill(): boolean {
    return this.data.freeWill;
  }
  setFreeWill(on: boolean): void {
    this.set("freeWill", on);
  }
  getEdgeScrolling(): boolean {
    return this.data.edgeScrolling;
  }
  setEdgeScrolling(on: boolean): void {
    this.set("edgeScrolling", on);
  }
  getSimInBackground(): boolean {
    return this.data.simInBackground;
  }
  setSimInBackground(on: boolean): void {
    this.set("simInBackground", on);
  }
  /** The original also answers false in the tutorial house (house +0x44); no tutorial yet. */
  getQuickTips(): boolean {
    return this.data.quickTips;
  }
  setQuickTips(on: boolean): void {
    this.set("quickTips", on);
  }
  getAutoSnapshots(): boolean {
    return this.data.autoSnapshots;
  }
  setAutoSnapshots(on: boolean): void {
    this.set("autoSnapshots", on);
  }
  getLivePIP(): boolean {
    return this.data.livePIP;
  }
  setLivePIP(on: boolean): void {
    this.set("livePIP", on);
  }
  getExportHTML(): boolean {
    return this.data.exportHTML;
  }
  setExportHTML(on: boolean): void {
    this.set("exportHTML", on);
  }

  /** cTSWinBtn::GetDefaultAsyncTimeout: hover time before a button's quick tip (ms). */
  getDefaultAsyncTimeout(): number {
    return (this.data.quickTips ? QUICK_TIPS_TIMINGS : NORMAL_TIMINGS).asyncTimeout;
  }

  /** Tooltip delay set alongside it (lbl_105BA848, ms). */
  getToolTipDelay(): number {
    return (this.data.quickTips ? QUICK_TIPS_TIMINGS : NORMAL_TIMINGS).toolTipDelay;
  }

  // --- persistence -------------------------------------------------------------

  private set<K extends keyof OptionsData>(key: K, value: OptionsData[K]): void {
    if (this.data[key] === value) return;
    this.data[key] = value;
    this.changed();
  }

  private changed(): void {
    this.save();
    for (const fn of this.listeners) fn(this);
  }

  /** cOptionsMgr::Save */
  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch {
      // Storage unavailable (private mode): the settings last for the session.
    }
  }

  /** cOptionsMgr::Load: stored values over the factory settings. */
  private load(): void {
    let stored: Partial<OptionsData> = {};
    try {
      stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<OptionsData>;
    } catch {
      stored = {};
    }
    for (const key of Object.keys(FACTORY) as Array<keyof OptionsData>) {
      const v = stored[key];
      if (typeof v === typeof FACTORY[key])
        (this.data as unknown as Record<string, unknown>)[key] = v;
    }
  }
}

let instance: OptionsMgr | null = null;

/** cOptionsMgr::GetOptionsMgr */
export function getOptionsMgr(): OptionsMgr {
  instance ??= new OptionsMgr();
  return instance;
}
