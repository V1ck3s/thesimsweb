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
  TurnOnTv: 30,
  TurnOffTv: 31,
  NotifyChange: 33,
  EnableSound: 34,
  EnableMusic: 35,
  SetMusicMode: 36,
  SetFXVolume: 37,
  SetMusicVolume: 38,
  SetVoxVolume: 39,
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
} as const;

/** Options volume 0..10 -> engine volume (table at 0x1059BAF8, also cSimsApp's 0x1059B478). */
export const VOLUME_TABLE = [0, 300, 390, 490, 590, 690, 790, 840, 895, 960, 1024];

/** Track ids used by cGameModeManager::SetMode (SimsSound.hot). */
const TRK_MAIN_MUSIC_LOOP = 515;
const TRK_SET_MAIN_SONG_AND_HITLIST = 516;
const TRK_SET_MAIN_AND_HITLIST_KILL_FIRST = 517;
const TRK_FADE_AND_KILL_SLOW = 519;
const TRK_RIVER_LOOP = 2957;
const TRK_MODE_KILLED_1 = 0x1bec2;
const TRK_FAMILY_STOPPED = 0x60f;

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

export class BoxX {
  readonly hm = new HitMan();
  private readonly events = new Map<string, MappedEvent>();
  /** +0xdc: source id -> tracks started for it (AddToInstanceMap). */
  private readonly instances = new Map<number, Set<number>>();
  /** +0xf0 */
  readonly modes = new GameModeManager(this);
  /** +0xe: sound enabled; +0xc: music enabled; +0xd: paused. */
  private soundEnabled = true;
  private musicEnabled = true;
  private paused = false;
  /** +0xf8, +0xfc, +0x100: option volumes 0..10. */
  private readonly volumes = { fx: 8, music: 8, vox: 8 };
  private timer: number | null = null;
  readonly loaded: { codes: string[]; tracks: number; patches: number; events: number; receivers: Record<string, number> } = {
    codes: [],
    tracks: 0,
    patches: 0,
    events: 0,
    receivers: {},
  };

  /** cBoxX::Init */
  async init(usVersion = false): Promise<void> {
    for (const dir of DATA_DIRS) await this.loadDataDirectory(dir);
    for (const r of receiverDefs(usVersion)) {
      const n = await initReceiver(this.hm, r.dir, r.hitList);
      if (n > 0) this.loaded.receivers[r.dir] = n;
    }
    this.timer = window.setInterval(() => this.update(), TICK_MS);
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

  /** cBoxX::Update (every TICK_MS). */
  update(): void {
    this.hm.timerCallback();
  }

  shutdown(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.hm.killAll();
  }

  /**
   * cBoxX::MappedEvent: look the name up (with the m/f/k gender variants of
   * GetEventObjectSound as a fallback) and send its event. Returns false when
   * the name is unknown.
   */
  playMappedEvent(name: string, source: number, a4 = 0, a5 = 0): boolean {
    const key = name.toLowerCase();
    const ev = this.events.get(key) ?? this.events.get(`${key}m`) ?? this.events.get(`${key}f`) ?? this.events.get(`${key}k`);
    if (!ev || ev.kind === 0) return false;
    this.event(ev.kind, ev.arg, ev.a3 || source, ev.a4 || a4, ev.a5 || a5);
    return true;
  }

  private track(id: number): TrackPlayer | null {
    const o = this.hm.soundObject(id);
    return o instanceof TrackPlayer ? o : null;
  }

  /** cBoxX::AddToInstanceMap */
  private addInstance(trackId: number, source: number): void {
    let s = this.instances.get(source);
    if (!s) this.instances.set(source, (s = new Set()));
    s.add(trackId);
  }

  /** cBoxX::KillSource: kill every track started for `source`. */
  killSource(source: number): void {
    const s = this.instances.get(source);
    if (!s) return;
    for (const id of s) this.track(id)?.kill();
    this.instances.delete(source);
  }

  /**
   * Positional volume/pan of a source (cBoxX::GetSndobVolPan). Objects on the
   * lot are not positioned yet: full volume, centred.
   */
  private sndobVolPan(_source: number): [number, number] {
    return [0x400, 0x200];
  }

  /** cBoxX::Event */
  event(kind: number, arg: number, source = 0, a4 = 0, a5 = 0): boolean {
    if (!this.soundEnabled && kind !== EV.EnableSound) return false;
    switch (kind) {
      case EV.SndobPlay:
      case EV.TurnOnTv: {
        const t = this.track(arg);
        if (!t) return false;
        if (kind === EV.TurnOnTv) this.killSource(source);
        if (kind === EV.TurnOnTv || (t.def.argsType === 2 && source !== 0)) this.addInstance(arg, source);
        let [vol, pan] = this.sndobVolPan(source);
        if (a4) vol = a4;
        if (a5) pan = a5;
        t.playPause(source, vol, pan);
        if (t.def.argsType === 2) {
          t.setRegister(R.extvol, vol);
          t.setRegister(R.pan, pan);
        }
        if (!this.paused) t.unpause();
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
        return true;
      case EV.Pause:
        this.paused = true;
        this.hm.pause();
        return true;
      case EV.Unpause:
        this.paused = false;
        this.hm.unpause();
        return true;
      case EV.KillInstance:
      case EV.TurnOffTv:
        this.killSource(arg || source);
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
        return true;
      case EV.SetFXVolume:
        this.volumes.fx = arg;
        this.hm.setGroupVolume(GROUP_SFX, VOLUME_TABLE[arg] ?? 0x400);
        return true;
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

  /** cGameModeManager::SetMode */
  setMode(mode: number): void {
    if (mode === this.mode) return;
    if (mode === MODE.Hood) this.started = true;
    if (!this.started) return;
    const prev = this.mode;
    this.mode = mode;
    if (mode !== MODE.Hood) this.obj(TRK_RIVER_LOOP)?.kill();
    if (mode !== 0xf) this.obj(TRK_MODE_KILLED_1)?.kill();
    const play = (id: number, arg = 0): void => this.obj(id)?.play(arg, 0, 0);
    switch (mode) {
      case MODE.Live:
      case MODE.FrontEnd:
      case MODE.Fade:
        // fade the mode music out (FadeAndKillTrackSlow on MainMusicLoop)
        play(TRK_FADE_AND_KILL_SLOW, TRK_MAIN_MUSIC_LOOP);
        break;
      case MODE.Buy:
        play(TRK_SET_MAIN_SONG_AND_HITLIST, 0xdd);
        break;
      case MODE.Build:
        play(TRK_SET_MAIN_SONG_AND_HITLIST, 0xde);
        break;
      case MODE.Hood:
        if (prev !== MODE.Family) {
          this.obj(TRK_FADE_AND_KILL_SLOW)?.kill();
          play(TRK_SET_MAIN_AND_HITLIST_KILL_FIRST, 0xdf);
        }
        play(TRK_RIVER_LOOP);
        break;
      case MODE.Credits:
        play(TRK_SET_MAIN_AND_HITLIST_KILL_FIRST, 0xdf);
        break;
      case MODE.Family:
        this.obj(TRK_RIVER_LOOP)?.stop();
        this.obj(TRK_MODE_KILLED_1)?.stop();
        this.obj(TRK_FAMILY_STOPPED)?.stop();
        break;
      case MODE.Downtown:
        this.obj(TRK_FADE_AND_KILL_SLOW)?.kill();
        play(TRK_SET_MAIN_AND_HITLIST_KILL_FIRST, 0x17d4);
        break;
      case MODE.Vacation:
        this.obj(TRK_FADE_AND_KILL_SLOW)?.kill();
        play(TRK_SET_MAIN_AND_HITLIST_KILL_FIRST, 0x370d);
        break;
      case MODE.Unleashed:
        this.obj(TRK_FADE_AND_KILL_SLOW)?.kill();
        play(TRK_SET_MAIN_AND_HITLIST_KILL_FIRST, 0x51a6);
        break;
      default:
        // Load, Options and the other expansion neighborhoods: no change.
        break;
    }
  }
}
