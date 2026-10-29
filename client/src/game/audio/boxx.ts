/**
 * cBoxX (the game's sound front end, owned by cSoundPlayer), cBoxxReceiver
 * (a music folder turned into hitlists) and cGameModeManager (mode music).
 *
 * cBoxX::Init loads every HIT data directory (SoundData\ then the expansion
 * folders), registers the music receivers and starts the 20 ms update timer.
 * Sounds are requested by event name (MappedEvent: the .hot [EventMapping]
 * table) or by event code (Event, a switch on the kSndob... and k... codes).
 */

import { listDir, looseUrl } from "./audiosys.js";
import { getAudioInfo } from "./audioinfo.js";
import { FreshPlayer, FreshTimer } from "./fresh.js";
import { checkHit, parseHot, parseHsm, type HitCode, type MappedEvent } from "./hitdata.js";
import { GROUP_MUSIC, GROUP_SFX, GROUP_VOX, HitMan, TICK_MS } from "./hitman.js";
import { R } from "./registers.js";
import { SamplePatch } from "./samplepatch.js";
import { Track, TrackPlayer } from "./trackplayer.js";

/** cBoxX::Event codes (the .hot [EventMappingEquate] names). */
export const EV = {
  SndobPlay: 1,
  SndobStop: 2,
  SndobKill: 3,
  SndobUpdate: 4,
  SndobSetVolume: 5,
  SndobSetPan: 7,
  SndobPause: 11,
  SndobUnpause: 12,
  SndobCancelNote: 19,
  KillAll: 20,
  Pause: 21,
  Unpause: 22,
  KillInstance: 23,
  /** cSimsApp::ActivateApp (+0xc). */
  ActivateApp: 25,
  TurnOnTv: 30,
  TurnOffTv: 31,
  UpdateSourceVolPan: 32,
  /** cSoundPlayer::NotifyHourChange / NotifyViewChange. */
  NotifyChange: 33,
  EnableSound: 34,
  EnableMusic: 35,
  SetMusicMode: 36,
  SetFXVolume: 37,
  SetMusicVolume: 38,
  SetVoxVolume: 39,
  SetAmbienceMode: 52,
} as const;

/** cGameModeManager modes (kSetMusicMode arguments, SimsSound.hot bkground_*). */
export const MODE = {
  Live: 0,
  Buy: 1,
  Build: 2,
  Hood: 3,
  FrontEnd: 4,
  Load: 5,
  Credits: 6,
  Options: 7,
  Family: 8,
  Fade: 9,
  Downtown: 0xa,
  Vacation: 0xb,
  Unleashed: 0xc,
  /** station_superstar (Studio Town credits return, Superstar community lots in Buy mode). */
  Superstar: 0xd,
  /** music_superstar_transition (cWinStudiotown::Init). */
  SuperstarTransition: 0xe,
  /** music_magictown (cWinMagicland::Init, Magic Town community lots in Buy mode). */
  Magictown: 0xf,
  MagictownCredits: 0x10,
  MagictownBuild: 0x11,
  MagictownBuy: 0x12,
} as const;

/** Options volume 0..10 -> engine volume (table at 0x1059BAF8, also cSimsApp's 0x1059B478). */
export const VOLUME_TABLE = [0, 300, 390, 490, 590, 690, 790, 840, 895, 960, 1024];

/** Track ids used by cGameModeManager::SetMode (SimsSound.hot). */
const TRK_MAIN_MUSIC_LOOP = 515;
const TRK_SET_MAIN_SONG_AND_HITLIST = 516;
const TRK_SET_MAIN_AND_HITLIST_KILL_FIRST = 517;
const TRK_FADE_AND_KILL_SLOW = 519;
const TRK_RIVER_LOOP = 2957;
/** mt_river_loop (sep7snds.hot): the Magic Town screen's river, started by mode 0xf. */
const TRK_MT_RIVER_LOOP = 0x1bec2;
const TRK_FAMILY_STOPPED = 0x60f;
/** Grimreaper_loop (xpack.hot), killed when the neighborhood shows. */
const TRK_GRIMREAPER_LOOP = 0x14cb;

/** Mode music hitlists (cBoxX::Init receivers below). */
const HL_BUY = 0xdd;
const HL_BUILD = 0xde;
const HL_NHOOD = 0xdf;
const HL_DT_NHOOD = 0x17d4;
const HL_VACATION = 0x370d;
const HL_UNLEASHED = 0x51a6;
const HL_DISCO = 0x635;
const HL_SUPERSTAR = 0x18706;
const HL_SUPERSTAR_STATION = 0x18705;
const HL_MAGICTOWN = 0x192bc;
const HL_MM_CREDITS = 0x192bd;
const HL_MM_BUILD = 0x192be;
const HL_MM_BUY = 0x192c0;

/**
 * cSimsApp +0x66, the installed expansion packs: 1 Livin' Large, 2 House
 * Party, 4 Hot Date, 8 Vacation, 0x20 Unleashed, 0x40 Superstar, 0x80
 * Makin' Magic. All present in the Complete Collection.
 */
const EXPANSION_FLAGS = 0xef;

/** onTimer: ticks run at most per timer callback (1 s; a hidden tab gets one callback a second). */
const MAX_CATCHUP_TICKS = 50;

/**
 * cBoxX::Init receivers: folder, receiver id (the radio track using it, 0 for
 * modes) and the hitlist the HIT code selects with smart_setlist.
 * Groups follow the expansion flags tested at +0x66 (all present in the
 * Complete Collection; a missing folder is just skipped).
 */
interface ReceiverDef {
  dir: string;
  hitList: number;
}

function receiverDefs(usVersion: boolean): ReceiverDef[] {
  return [
    { dir: "Music\\Stations\\Country", hitList: 0xe8 },
    { dir: "Music\\Stations\\Rock", hitList: 0xe9 },
    { dir: "Music\\Stations\\Latin", hitList: 0xea },
    { dir: "Music\\Stations\\Classica", hitList: 0xeb },
    { dir: "Music\\Modes\\Buy", hitList: 0xdd },
    { dir: "Music\\Modes\\Build", hitList: 0xde },
    // lbl_105B9CD4+100: the US build uses NhoodUS.
    { dir: usVersion ? "Music\\Modes\\NhoodUS" : "Music\\Modes\\Nhood", hitList: 0xdf },
    { dir: "Music\\Modes\\MakinMagic", hitList: 0x192bc },
    { dir: "Music\\Modes\\MM_Credits", hitList: 0x192bd },
    { dir: "Music\\Modes\\MM_Build", hitList: 0x192be },
    { dir: "Music\\Modes\\MM_Buy", hitList: 0x192c0 },
    { dir: "ExpansionPack6\\Sound\\TVStations\\Animal", hitList: 0x19258 },
    { dir: "ExpansionPack6\\Sound\\TVStations\\Entertainment", hitList: 0x19259 },
    { dir: "ExpansionPack6\\Sound\\TVStations\\News", hitList: 0x1925a },
    { dir: "ExpansionPack6\\Sound\\TVStations\\Sports", hitList: 0x1925b },
    { dir: "Music\\Stations\\Superstar", hitList: 0x18704 },
    { dir: "Music\\Modes\\SuperStar", hitList: 0x18706 },
    { dir: "Music\\Stations\\Superstar", hitList: 0x18705 },
    { dir: "Music\\Stations\\UnlCheap", hitList: 0x51a4 },
    { dir: "Music\\Stations\\UnlSpeak", hitList: 0x51a5 },
    { dir: "Music\\Stations\\UnlSpeak", hitList: 0x51a6 },
    { dir: "Music\\Modes\\Vacation", hitList: 0x370d },
    { dir: "Music\\Modes\\dt_nhood", hitList: 0x17d4 },
    { dir: "Music\\Stations\\EZ", hitList: 0x10000 },
    { dir: "Music\\Stations\\EZExp", hitList: 0x10001 },
    { dir: "SoundData\\TVStations\\TV_Action", hitList: 0x211 },
    { dir: "SoundData\\TVStations\\TV_Comedy_Cartoon", hitList: 0x212 },
    { dir: "SoundData\\TVStations\\TV_Romance", hitList: 0x210 },
    { dir: "SoundData\\TVStations\\TV_Mystery", hitList: 0x213 },
    { dir: "Music\\Stations\\CountryD", hitList: 0x632 },
    { dir: "Music\\Stations\\Rap", hitList: 0x633 },
    { dir: "Music\\Stations\\Rave", hitList: 0x634 },
    { dir: "Music\\Stations\\Disco", hitList: 0x635 },
    { dir: "Music\\Stations\\Beach", hitList: 0x636 },
  ];
}

/** HIT data directories: SoundData\ first, then the plug-in (expansion) folders. */
const DATA_DIRS = [
  "SoundData",
  "ExpansionPack",
  "ExpansionShared\\Sound",
  "ExpansionPack2\\Sound",
  "ExpansionPack3\\Sound",
  "ExpansionPack4\\Sound",
  "ExpansionPack5\\Sound",
  "ExpansionPack6\\Sound",
  "ExpansionPack7\\Sound",
];

async function fetchText(path: string): Promise<string | null> {
  const url = await looseUrl(path);
  if (!url) return null;
  const res = await fetch(url);
  return res.ok ? res.text() : null;
}

async function fetchBytes(path: string): Promise<Uint8Array | null> {
  const url = await looseUrl(path);
  if (!url) return null;
  const res = await fetch(url);
  return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
}

/**
 * cBoxxReceiver::Init / AddDirHitlist: every sub-folder of `dir` (or `dir`
 * itself when it has none) becomes a hitlist of one patch per file, and
 * hitlist `id` lists those folder hitlists. The music tracks choose a folder,
 * then a song in it.
 */
async function initReceiver(hm: HitMan, dir: string, id: number): Promise<number> {
  const top = await listDir(dir);
  const folders = top.dirs.length > 0 ? top.dirs : top.files.length > 0 ? [dir.replace(/\\/g, "/")] : [];
  if (folders.length === 0) return 0;
  const main = hm.globalHitList(id) ?? hm.createGlobalHitList(id);
  main.setCrit(1000000);
  for (const folder of folders) {
    const { files } = folder === dir.replace(/\\/g, "/") ? top : await listDir(folder);
    if (files.length === 0) continue;
    const listId = hm.freeHitListId();
    const list = hm.createGlobalHitList(listId);
    for (const f of files) {
      const pid = hm.nextAvailableSndobId();
      const name = f.slice(f.lastIndexOf("/") + 1);
      hm.registerSoundObject(pid, new SamplePatch(pid, name, f.replace(/\//g, "\\")));
      list.add(pid);
    }
    main.add(listId);
  }
  return main.size();
}

/** cBoxX::Event kSetAmbienceMode arguments (.hot kAmbienceMode*): the players at +0x10c..+0x118. */
export const AMBIENCE = { Backyard: 0, Beach: 1, Park: 2, Magictown: 3 } as const;

/**
 * cBoxX::Init's ambience scores (lbl_105BC818 + 0x404..0x491): backyard
 * always, beach and park with Hot Date (expansion flags 4 / 8), magic town
 * with Makin' Magic (0x80).
 */
const AMBIENCE_SCORES: ReadonlyArray<[dir: string, file: string]> = [
  ["SoundData\\Outdoors\\", "sim_amb.fsc"],
  ["ExpansionShared\\Sound\\Beach\\", "beach.fsc"],
  ["ExpansionShared\\Sound\\Park\\", "hotdatepark_amb.fsc"],
  ["SoundData\\MTOutdoors\\", "magic_amb.fsc"],
];

/** UpdateAmbienceLoop's tracks: lbl_105C1C3C BeachLoop (HotDate.hot), lbl_105C1C38 nite_loop. */
const TRK_BEACH_LOOP = 0x10aa3;
const TRK_NITE_LOOP = 0xba9;

/** cBoxX::Pause leaves these playing: ui_click and ui_speed_{1,2,3}top. */
const PAUSE_EXEMPT = new Set([0x605, 0xaa7, 0xaad, 0xab3]);

/** lbl_106171D8: hour (0..23) -> fresh X column step (x 1000 / 13 in kNotifyChange). */
const HOUR_TO_X = [12, 12, 12, 12, 12, 1, 2, 3, 4, 4, 5, 6, 6, 7, 8, 9, 10, 11, 11, 11, 12, 12, 12, 12];

/** kArgsIdVolPan: the track plays for an instance (object) and takes its volume / pan. */
const ARGS_IDVOLPAN = 2;

export class BoxX {
  readonly hm = new HitMan();
  private readonly events = new Map<string, MappedEvent>();
  /** +0xdc: sound object id -> the instance (source) ids it plays for (AddToInstanceMap). */
  private readonly instances = new Map<number, Set<number>>();
  /** +0xf0 */
  readonly modes = new GameModeManager(this);
  /** +0xc: the application is active (kActivateApp, 25). */
  private active = true;
  /** +0xd: paused (kPause / kUnpause). */
  private paused = false;
  /** +0xe: sound enabled; +0xf: music enabled. */
  private soundEnabled = true;
  private musicEnabled = true;
  /** +0xf8, +0xfc, +0x100: option volumes 0..10. */
  private readonly volumes = { fx: 10, music: 10, vox: 10 };
  /** +0x104 */
  private readonly freshTimer = new FreshTimer();
  /** +0x10c backyard, +0x110 beach, +0x114 park, +0x118 magic town. */
  readonly ambience: Array<FreshPlayer | null> = [null, null, null, null];
  /** +0x108: the current ambience player. */
  private ambienceCur: FreshPlayer | null = null;
  /** +0x11c: kActivateApp's volume refresh countdown (cBoxX::Update). */
  private volPanCountdown = 0;
  /** lbl_105C1C8C: the outdoor loop UpdateAmbienceLoop plays (0 = none). */
  private ambienceLoop = 0;
  /** lbl_105C1C40: last simulator speed sent to register 100. */
  private lastSimSpeed = -1;
  private timer: number | null = null;
  /** Time (performance.now) the last tick was due at. */
  private lastTick = 0;
  readonly loaded: { codes: string[]; tracks: number; patches: number; events: number; receivers: Record<string, number>; ambience: string[] } = {
    codes: [],
    tracks: 0,
    patches: 0,
    events: 0,
    receivers: {},
    ambience: [],
  };

  /** cBoxX::Init */
  async init(usVersion = false): Promise<void> {
    for (const dir of DATA_DIRS) await this.loadDataDirectory(dir);
    for (const r of receiverDefs(usVersion)) {
      const n = await initReceiver(this.hm, r.dir, r.hitList);
      if (n > 0) this.loaded.receivers[r.dir] = n;
    }
    for (let i = 0; i < AMBIENCE_SCORES.length; i++) {
      const [dir, file] = AMBIENCE_SCORES[i]!;
      const p = new FreshPlayer(this.freshTimer);
      if (await p.init(dir, file)) {
        this.ambience[i] = p;
        this.loaded.ambience.push(dir + file);
      }
    }
    // cHitMan::RegisterSourceDataRequestHandler(BoxxGlobalGetSourceParamValue): fields 0..0x15 -> cAudioInfo::GetObjectData.
    this.hm.sourceDataHandler = (source, field) => (field > 0x15 || field < 0 ? null : (getAudioInfo()?.objectData(source, field) ?? 0));
    this.updateAmbienceLoop();
    this.lastTick = performance.now();
    this.timer = window.setInterval(() => this.onTimer(), TICK_MS);
  }

  /** cBoxX::LoadDataDirectory: every .hsm/.hit/.hot triple in the folder. */
  private async loadDataDirectory(dir: string): Promise<void> {
    const { files } = await listDir(dir);
    for (const hotPath of files.filter((f) => f.toLowerCase().endsWith(".hot"))) {
      const base = hotPath.slice(0, -4);
      const find = (ext: string): string | undefined => files.find((f) => f.toLowerCase() === `${base}${ext}`.toLowerCase());
      const hitPath = find(".hit");
      const hsmPath = find(".hsm");
      if (!hitPath) continue;
      const [hotText, hitBytes, hsmText] = await Promise.all([fetchText(hotPath), fetchBytes(hitPath), hsmPath ? fetchText(hsmPath) : Promise.resolve("")]);
      if (!hotText || !hitBytes || !checkHit(hitBytes)) continue;
      const hot = parseHot(hotText, parseHsm(hsmText ?? ""));
      const code: HitCode = { name: hitPath, bytes: hitBytes };
      for (const [label, addr] of hot.trackData) this.hm.registerTrackDataAddress(label, code, addr);
      for (const p of hot.patches) this.hm.registerSoundObject(p.id, new SamplePatch(p.id, p.name, p.path, p));
      for (const t of hot.tracks) this.hm.registerSoundObject(t.id, new Track(this.hm, t));
      for (const [id, ids] of hot.hitLists) {
        const l = this.hm.globalHitList(id) ?? this.hm.createGlobalHitList(id);
        for (const x of ids) l.add(x);
      }
      for (const [name, ev] of hot.events) this.events.set(name, ev);
      this.loaded.codes.push(hitPath);
      this.loaded.tracks += hot.tracks.length;
      this.loaded.patches += hot.patches.length;
      this.loaded.events += hot.events.size;
    }
  }

  eventNames(): string[] {
    return [...this.events.keys()];
  }

  mappedEvent(name: string): MappedEvent | null {
    return this.events.get(name.toLowerCase()) ?? null;
  }

  /**
   * The cTSCallbackTimer (0x14 ms) runs on its own thread and never misses a
   * tick; a page interval is late whenever the main thread is busy (lot
   * rendering), which would stretch every HIT wait and fade. The ticks due
   * since the last one run here, at most one second's worth.
   */
  private onTimer(): void {
    const now = performance.now();
    let n = Math.floor((now - this.lastTick) / TICK_MS);
    if (n > MAX_CATCHUP_TICKS) {
      n = MAX_CATCHUP_TICKS;
      this.lastTick = now;
    } else {
      this.lastTick += n * TICK_MS;
    }
    for (let i = 0; i < n; i++) this.update();
  }

  /** cBoxX::Update (every TICK_MS). */
  update(): void {
    const n = this.volPanCountdown;
    if (n !== 0) {
      this.updateAllSndobVolPan();
      this.volPanCountdown = 0;
      this.updateAllSndobVolPan();
      this.volPanCountdown = n - 1;
    }
    this.hm.timerCallback();
  }

  shutdown(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.hm.killAll();
    for (const p of this.ambience) p?.shutdown();
    this.freshTimer.shutdown();
  }

  /** cBoxX::GetEventObjectSound: a kSndobPlay event whose track takes (id, vol, pan). */
  private getEventObjectSound(name: string): TrackPlayer | null {
    const ev = this.events.get(name);
    if (!ev || ev.kind !== EV.SndobPlay) return null;
    const t = this.track(ev.arg);
    return t && t.def.argsType === ARGS_IDVOLPAN ? t : null;
  }

  /**
   * cBoxX::MappedEvent: look the name up and send its event. A "vox" event
   * is dropped for a source whose voice is 1000 (cAudioInfo::GetObjectData 0);
   * an unknown name is retried with the source's m / f / k (kid) suffix when
   * such per-voice variants exist. Returns false when nothing was sent.
   */
  playMappedEvent(name: string, source: number, a4 = 0, a5 = 0): boolean {
    let key = name.toLowerCase();
    const voice = (): number => getAudioInfo()?.objectData(source, 0) ?? 0;
    if ((key.endsWith("vox") || key.startsWith("vox")) && voice() === 1000) return false;
    if (!this.events.has(key)) {
      const [m, f, k] = [`${key}m`, `${key}f`, `${key}k`];
      if (this.getEventObjectSound(m) ?? this.getEventObjectSound(f) ?? this.getEventObjectSound(k)) {
        const v = voice();
        if (v === 1000) return false;
        if (v === 0) key = m;
        else if (v === 1) key = f;
        else if (v === 2) key = k;
        if (!this.events.has(key)) return false;
      }
    }
    const ev = this.events.get(key);
    if (!ev || ev.kind === 0) return false;
    this.event(ev.kind, ev.arg, ev.a3 || source, ev.a4 || a4, ev.a5 || a5);
    return true;
  }

  private track(id: number): TrackPlayer | null {
    const o = this.hm.soundObject(id);
    return o instanceof TrackPlayer ? o : null;
  }

  /** cBoxX::AddToInstanceMap(sndob, instance) */
  private addToInstanceMap(sndob: number, instance: number): void {
    let s = this.instances.get(sndob);
    if (!s) this.instances.set(sndob, (s = new Set()));
    s.add(instance);
  }

  /**
   * cBoxX::KillSource: forget `source` in every sound's instances; a sound
   * left without instances stops (cTrackPlayer::Stop fades it), the others
   * are re-positioned (UpdateSndobVolPan).
   */
  killSource(source: number): void {
    for (const [sndob, set] of [...this.instances]) {
      if (!set.delete(source)) continue;
      if (set.size === 0) this.instances.delete(sndob);
      this.updateSndobVolPan(sndob);
    }
  }

  /**
   * cBoxX::GetInstanceVolPan: an object's volume and pan from where it is on
   * screen. Pan follows the screen x (a small swing: +-0xc00 / (width * 50)
   * around 0x200); volume drops with the zoom ((3 - scale) * Spl * 14) toward
   * a floor (800 for kSplStereo, else 0), fades out over 600 pixels outside
   * the central screen area (20 % margins left / right, 30 % top, the bottom
   * edge), and is 3/5 on another level. Spl is the sound's register 0x39
   * (kSplLoud 10 .. kSplQuiet 100; 0 = infinite: no attenuation).
   */
  private getInstanceVolPan(instance: number, obj: TrackPlayer | null): { ok: boolean; vol: number; pan: number } {
    if (instance < 1) return { ok: false, vol: 0x400, pan: 0x200 };
    const info = getAudioInfo();
    const pos = info?.objectPosition(instance) ?? null;
    if (!info || !pos || pos.x === 0 || pos.y === 0) return { ok: false, vol: 0, pan: 0x200 };
    const sc = info.worldToScreen(pos);
    const br = info.screenBottomRight();
    const viewerLevel = info.viewerLevel();
    const spl = obj ? obj.registerVal(R.Spl) : 0x14;
    let pan = 0x200;
    if (spl !== 0) {
      pan = Math.trunc(((sc.h - Math.trunc(br.h / 2)) * 0xc00) / Math.trunc((br.h * 100) / 2)) + 0x200;
      pan = Math.max(0, Math.min(0x400, pan));
    }
    const zoom = info.zoomLevel();
    const floor = spl === 0x2711 ? 800 : 0;
    let vol = Math.max(floor, Math.max(0, 0x400 - (3 - zoom) * spl * 0xe));
    const mx = Math.trunc((br.h * 0x14) / 100);
    const dx = sc.h < mx ? mx - sc.h : sc.h - (br.h - mx);
    let dy = Math.max(0, sc.v - br.v);
    if (dy === 0) dy = Math.max(0, Math.trunc((br.v * 0x1e) / 100) - sc.v);
    const d = Math.max(dx, dy);
    if (d !== 0 && spl !== 0) {
      if (d < 600) vol = Math.min(0x400, Math.max(floor, Math.trunc(((vol - floor) * (600 - d)) / 600) + floor));
      else vol = floor;
    }
    if (pos.level !== viewerLevel && spl !== 0) vol = Math.trunc((vol * 3) / 5);
    return { ok: true, vol, pan };
  }

  /**
   * cBoxX::GetSndobVolPan: over the sound's instances, the loudest volume
   * and the volume-weighted pan; full volume, centred when it has none.
   */
  private getSndobVolPan(sndob: number): { vol: number; pan: number } {
    const set = this.instances.get(sndob);
    if (!set || set.size === 0) return { vol: 0, pan: 0x200 };
    const obj = this.track(sndob);
    if (!obj) return { vol: 0, pan: 0x200 };
    let max = 0;
    let sum = 0;
    let weighted = 0;
    for (const inst of set) {
      const r = this.getInstanceVolPan(inst, obj);
      max = Math.max(max, r.vol);
      sum += r.vol;
      weighted += r.vol * (r.pan - 0x200);
    }
    return { vol: max, pan: (sum !== 0 ? Math.trunc(weighted / sum) : 0) + 0x200 };
  }

  /** cBoxX::UpdateSndobVolPan(long): re-position a sound, stop it when it has no instance left. */
  private updateSndobVolPan(sndob: number): void {
    const t = this.track(sndob);
    if (!t) return;
    if (!this.instances.get(sndob)?.size) {
      t.stop();
      return;
    }
    let { vol, pan } = this.getSndobVolPan(sndob);
    if (this.volPanCountdown !== 0) {
      vol -= 1;
      if (vol < 0) vol = 1;
    }
    t.setRegister(R.extvol, vol);
    t.setRegister(R.pan, pan);
  }

  /** cBoxX::UpdateAllSndobVolPan */
  private updateAllSndobVolPan(): void {
    for (const sndob of [...this.instances.keys()]) this.updateSndobVolPan(sndob);
  }

  /**
   * cBoxX::UpdateAmbienceLoop: in live mode, unpaused and active, the
   * outdoor loop: the beach waves with the beach ambience, else the night
   * crickets (nite_loop) out of 6:00..18:59 on a lot outside 0x14..0x1d.
   * It fades in (fade_dest = the FX volume, speed 5000).
   */
  private updateAmbienceLoop(): void {
    let cur = this.ambienceLoop !== 0 ? this.track(this.ambienceLoop) : null;
    const prev = this.ambienceLoop;
    if (!this.paused && this.active && this.modes.mode === MODE.Live) {
      let id = TRK_BEACH_LOOP;
      if (this.ambienceCur !== this.ambience[AMBIENCE.Beach]) {
        const info = getAudioInfo();
        const lot = info?.lotNumber() ?? 0;
        if (lot < 0x14 || lot > 0x1d) {
          const hour = info?.objectData(0, 4) ?? 0;
          id = hour < 0x13 && hour > 5 ? 0 : TRK_NITE_LOOP;
        } else {
          id = 0;
        }
      }
      this.ambienceLoop = id;
      if (id !== prev && cur) cur.stop();
      cur = id !== 0 ? this.track(id) : null;
      if (cur && !cur.isActive()) {
        const vol = VOLUME_TABLE[this.volumes.fx] ?? 0x400;
        cur.playPause(0, 0, 0);
        cur.setRegister(R.extvol, 0);
        cur.setRegister(R.fade_dest, vol);
        cur.setRegister(R.fade_var, R.extvol);
        cur.setRegister(R.fade_speed, 5000);
        cur.setRegister(R.fade_on, 1);
        cur.unpause();
      }
    } else if (cur?.isActive()) {
      cur.stop();
    }
  }

  /** cBoxX::Pause: pause every running track but the UI click / speed sounds. */
  private pauseTracks(): void {
    this.paused = true;
    this.hm.duckMapRemoveAll();
    this.updateAmbienceLoop();
    for (const p of this.hm.activePlayers()) if (!PAUSE_EXEMPT.has(p.trackId())) p.pause();
  }

  /** cBoxX::Unpause */
  private unpauseTracks(): void {
    this.paused = false;
    this.hm.unpause();
    this.updateAmbienceLoop();
    this.modes.unpause();
  }

  /** The kSndobPlay / kTurnOnTv body: play `t` for `source`, positioned from its instances. */
  private playPositioned(t: TrackPlayer, sndob: number, source: number, a4: number, a5: number): void {
    this.addToInstanceMap(sndob, source);
    const { vol, pan } = this.getSndobVolPan(sndob);
    t.playPause(source, a4, a5);
    t.setRegister(R.extvol, vol);
    t.setRegister(R.pan, pan);
  }

  /** cBoxX::Event (jump table lbl_106172A0). */
  event(kind: number, arg: number, source = 0, a4 = 0, a5 = 0): boolean {
    if (!this.soundEnabled && kind !== EV.EnableSound) return false;
    const info = getAudioInfo();
    if (this.modes.mode !== MODE.Load && info) {
      const speed = info.simSpeed();
      if (speed !== this.lastSimSpeed) {
        this.lastSimSpeed = speed;
        this.hm.setRegister(R.SimSpeed, speed > 0x3c0 ? 2 : speed > 800 ? 1 : 0);
      }
    }
    if (kind === EV.KillInstance) {
      if (arg !== 0) this.killSource(arg);
      return true;
    }
    switch (kind) {
      case EV.SndobPlay: {
        if (!this.active) return false;
        const t = this.track(arg);
        if (!t) return false;
        if (!t.isActive()) this.instances.delete(arg);
        if (t.def.argsType === ARGS_IDVOLPAN) {
          if (source === 0) return false;
          this.playPositioned(t, arg, source, a4, a5);
        } else {
          t.playPause(source, a4, a5);
        }
        t.unpause();
        return true;
      }
      case EV.TurnOnTv: {
        this.killSource(source);
        const t = this.track(arg);
        if (!t) return false;
        this.playPositioned(t, arg, source, a4, a5);
        if (!this.paused && this.active) t.unpause();
        return true;
      }
      case EV.TurnOffTv:
        return true;
      case EV.UpdateSourceVolPan:
        for (const [sndob, set] of [...this.instances]) if (set.has(arg)) this.updateSndobVolPan(sndob);
        return true;
      case EV.NotifyChange: {
        this.updateAllSndobVolPan();
        let ratio = info?.outdoorTileRatio() ?? 0;
        if (this.hm.paused || ratio < 30) ratio = 0;
        if (this.ambienceCur) {
          this.ambienceCur.setYPos(ratio * 10);
          this.ambienceCur.setXPos(Math.trunc(((HOUR_TO_X[info?.objectData(0, 4) ?? 0] ?? 12) * 1000) / 13));
        }
        this.updateAmbienceLoop();
        return true;
      }
      case EV.SndobStop:
        this.track(arg)?.stop();
        return true;
      case EV.SndobKill:
        this.track(arg)?.kill();
        return true;
      case EV.SndobCancelNote:
        this.track(arg)?.cancelNote();
        return true;
      case EV.SndobPause:
        this.track(arg)?.pause();
        return true;
      case EV.SndobUnpause:
        this.track(arg)?.unpause();
        return true;
      case EV.KillAll:
        this.hm.killAll();
        this.instances.clear();
        this.ambienceCur?.stop();
        for (const p of this.ambience) p?.stop();
        return true;
      case EV.Pause:
        this.pauseTracks();
        if (this.modes.mode === MODE.Live) this.ambienceCur?.setPause(true);
        return true;
      case EV.Unpause:
        this.paused = false;
        if (!this.active) return true;
        this.unpauseTracks();
        this.ambienceCur?.setPause(false);
        return true;
      case EV.ActivateApp:
        this.active = arg !== 0;
        if (this.active) {
          this.volPanCountdown = 100;
          this.updateAllSndobVolPan();
          this.volPanCountdown = 0;
          this.updateAllSndobVolPan();
          this.volPanCountdown = 100;
          if (!this.paused) {
            this.unpauseTracks();
            this.ambienceCur?.setPause(false);
          }
          if (this.modes.mode === MODE.Hood) this.unpauseTracks();
          this.modes.unpause();
        } else if (this.modes.mode === MODE.Live) {
          for (const p of this.ambience) p?.setPause(true);
        }
        return true;
      case EV.EnableSound:
        this.soundEnabled = arg !== 0;
        if (!this.soundEnabled) this.hm.killAll();
        return true;
      case EV.EnableMusic:
        this.musicEnabled = arg !== 0;
        this.hm.setGroupVolume(GROUP_MUSIC, this.musicEnabled ? (VOLUME_TABLE[this.volumes.music] ?? 0x400) : 0);
        return true;
      case EV.SetMusicMode:
        this.modes.setMode(arg);
        if (this.modes.mode === MODE.Live) {
          if (this.ambienceCur) {
            this.ambienceCur.play();
            this.ambienceCur.setPause(this.paused);
          }
        } else if (this.modes.mode === MODE.Hood) {
          const backyard = this.ambience[AMBIENCE.Backyard] ?? null;
          if (this.ambienceCur !== backyard) this.ambienceCur?.stop();
          this.ambienceCur = backyard;
          if (backyard) {
            backyard.setYPos(1000);
            backyard.setXPos(500);
            backyard.play();
            backyard.setPause(false);
          }
        } else {
          this.ambienceCur?.stop();
        }
        this.updateAmbienceLoop();
        return true;
      case EV.SetAmbienceMode: {
        const next = arg >= 0 && arg < 4 ? (this.ambience[arg] ?? null) : null;
        if (next === this.ambienceCur) return true;
        this.ambienceCur?.stop();
        this.ambienceCur = next;
        if (next) {
          next.play();
          next.setPause(this.paused);
        }
        return true;
      }
      case EV.SetFXVolume: {
        this.volumes.fx = arg;
        const v = VOLUME_TABLE[arg] ?? 0x400;
        this.hm.setGroupVolume(GROUP_SFX, v);
        for (const p of this.ambience) p?.setVolume(v);
        this.updateAmbienceLoop();
        return true;
      }
      case EV.SetMusicVolume:
        this.volumes.music = arg;
        this.hm.setGroupVolume(GROUP_MUSIC, this.musicEnabled ? (VOLUME_TABLE[arg] ?? 0x400) : 0);
        return true;
      case EV.SetVoxVolume:
        this.volumes.vox = arg;
        this.hm.setGroupVolume(GROUP_VOX, VOLUME_TABLE[arg] ?? 0x400);
        return true;
      default:
        return false;
    }
  }

  getVolumes(): { fx: number; music: number; vox: number } {
    return { ...this.volumes };
  }

  /** Dev view of the ambience (current player, its grid position and cells, the outdoor loop). */
  ambienceState(): { current: number; loop: number; ratio: number; hour: number; lot: number; player: ReturnType<FreshPlayer["debugState"]> | null } {
    const info = getAudioInfo();
    return {
      ratio: info?.outdoorTileRatio() ?? -1,
      hour: info?.objectData(0, 4) ?? -1,
      lot: info?.lotNumber() ?? -1,
      current: this.ambienceCur ? this.ambience.indexOf(this.ambienceCur) : -1,
      loop: this.ambienceLoop,
      player: this.ambienceCur?.debugState() ?? null,
    };
  }
}

/** cGameModeManager: the music of the current game mode. */
export class GameModeManager {
  mode = -1;
  /** lbl_105C1C80: mode changes are ignored until the neighborhood was shown once. */
  private started = false;

  constructor(private readonly boxx: BoxX) {}

  private obj(id: number): TrackPlayer | null {
    const o = this.boxx.hm.soundObject(id);
    return o instanceof TrackPlayer ? o : null;
  }

  /** cGameModeManager::Unpause: MainMusicLoop goes on. */
  unpause(): void {
    this.obj(TRK_MAIN_MUSIC_LOOP)?.unpause();
  }

  /**
   * cGameModeManager::SetMode (Windows build FUN_005752c4, same as the Mac
   * 0x102d8fb0 apart from the credits hitlist). The music tracks: 515
   * MainMusicLoop, 516 SetMainMusicSongAndHitList (keeps the song that plays
   * and changes the hitlist of the next one), 517 SetMainAndHitListKillFirst,
   * 519 FadeAndKillTrackSlow (6.8 s). The Sleep(100) between the calls are
   * left out.
   */
  setMode(mode: number): void {
    if (mode === this.mode) return;
    if (mode === MODE.Hood) this.started = true;
    if (!this.started) return;
    const prev = this.mode;
    this.mode = mode;
    if (mode === MODE.Hood) {
      if (EXPANSION_FLAGS & 1) this.obj(TRK_GRIMREAPER_LOOP)?.kill();
      this.obj(TRK_MT_RIVER_LOOP)?.kill();
    } else {
      this.obj(TRK_RIVER_LOOP)?.kill();
      if (mode !== MODE.Magictown) this.obj(TRK_MT_RIVER_LOOP)?.kill();
    }
    const play = (id: number, arg = 0): void => this.obj(id)?.play(arg, 0, 0);
    /** Fade the mode music out, then start a hitlist from a new song. */
    const switchTo = (hitList: number): void => {
      this.obj(TRK_FADE_AND_KILL_SLOW)?.kill();
      play(TRK_SET_MAIN_AND_HITLIST_KILL_FIRST, hitList);
    };
    switch (mode) {
      case MODE.Live:
      case MODE.FrontEnd:
      case MODE.Fade:
        // Leaving Buy / Build stops the music at once, anything else fades it out.
        if (prev === MODE.Buy || prev === MODE.Build || prev === MODE.MagictownBuild || prev === MODE.MagictownBuy) {
          this.obj(TRK_MAIN_MUSIC_LOOP)?.kill();
        } else {
          play(TRK_FADE_AND_KILL_SLOW, TRK_MAIN_MUSIC_LOOP);
        }
        break;
      case MODE.Buy:
        play(TRK_SET_MAIN_SONG_AND_HITLIST, HL_BUY);
        break;
      case MODE.Build:
        play(TRK_SET_MAIN_SONG_AND_HITLIST, HL_BUILD);
        break;
      case MODE.Hood:
        if (prev !== MODE.Family) switchTo(HL_NHOOD);
        play(TRK_RIVER_LOOP);
        break;
      case MODE.Credits: {
        // The newest pack's credits music (the Mac build predates Makin' Magic: 0x80 -> Superstar).
        const f = EXPANSION_FLAGS;
        const hl = f & 0x80 ? HL_MM_CREDITS : f & 0x40 ? HL_SUPERSTAR : f & 0x20 ? HL_UNLEASHED : f & 8 ? HL_VACATION : f & 2 ? HL_DISCO : f & 4 ? HL_DT_NHOOD : HL_NHOOD;
        play(TRK_SET_MAIN_AND_HITLIST_KILL_FIRST, hl);
        break;
      }
      case MODE.Family:
        this.obj(TRK_RIVER_LOOP)?.stop();
        this.obj(TRK_MT_RIVER_LOOP)?.stop();
        this.obj(TRK_FAMILY_STOPPED)?.stop();
        break;
      case MODE.Downtown:
        switchTo(HL_DT_NHOOD);
        break;
      case MODE.Vacation:
        switchTo(HL_VACATION);
        break;
      case MODE.Unleashed:
        switchTo(HL_UNLEASHED);
        break;
      case MODE.Superstar:
        switchTo(HL_SUPERSTAR);
        break;
      case MODE.SuperstarTransition:
        switchTo(HL_SUPERSTAR_STATION);
        break;
      case MODE.Magictown:
        switchTo(HL_MAGICTOWN);
        play(TRK_MT_RIVER_LOOP);
        break;
      case MODE.MagictownCredits:
        switchTo(HL_MM_CREDITS);
        break;
      case MODE.MagictownBuild:
      case MODE.MagictownBuy:
        // Magic Town Buy <-> Build keeps the song.
        if (prev === MODE.MagictownBuild || prev === MODE.MagictownBuy) break;
        switchTo(mode === MODE.MagictownBuild ? HL_MM_BUILD : HL_MM_BUY);
        break;
      default:
        // Load, Options: no change.
        break;
    }
  }
}
