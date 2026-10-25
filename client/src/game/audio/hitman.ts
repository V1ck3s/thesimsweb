/**
 * cHitMan (the HIT sound engine), cHitList and cHitControlGroup.
 *
 * cHitMan owns every sound object by id (tracks and patches), the label table
 * (HOT [TrackData] ids -> code address in a .hit file), global hitlists, the
 * global registers (0x5a..0x7f), the control groups (sfx / music / vox volume),
 * the sequence groups and the duck map. cBoxX::Update calls TimerCallback
 * every tick (cTSCallbackTimer, 20 ms); the tick count is the engine clock
 * used by HIT `wait` (so `wait 50` is one second).
 */

import type { HitCode } from "./hitdata.js";
import { GLOBAL_DEFAULTS, R } from "./registers.js";
import type { SoundObject } from "./samplepatch.js";
import type { TrackPlayer } from "./trackplayer.js";

/** Sound objects with Pause / Unpause (cTrackPlayer vtable 0x60 / 0x64). */
interface Pausable {
  pause(): void;
  unpause(): void;
}

/** cTSCallbackTimer period set by cBoxX::Init (Start(0x14)). */
export const TICK_MS = 20;

export const GROUP_SFX = 1;
export const GROUP_MUSIC = 2;
export const GROUP_VOX = 3;

/** cRZRandom::RandomUint32Uniform: [0, n). */
export function randomUniform(n: number): number {
  return n > 0 ? Math.floor(Math.random() * n) : 0;
}

/**
 * cHitList: ids not played yet (+4) and recently played ones (+0x10).
 * Choose() takes a random unplayed id and moves it to the played list; once
 * more than `crit` ids were played the oldest go back to the pool. With an
 * empty pool it cycles the played list.
 */
export class HitList {
  avail: number[] = [];
  used: number[] = [];
  crit = 0;
  critFixed = false;

  /** cHitList::Add (inserted at the front). */
  add(id: number): void {
    this.avail.unshift(id);
    if (!this.critFixed) this.crit = (this.avail.length + this.used.length) >> 1;
  }

  remove(id: number): void {
    this.avail = this.avail.filter((x) => x !== id);
    this.used = this.used.filter((x) => x !== id);
    if (!this.critFixed) this.crit = (this.avail.length + this.used.length) >> 1;
  }

  removeAll(): void {
    this.avail = [];
    this.used = [];
  }

  size(): number {
    return this.avail.length + this.used.length;
  }

  setCrit(c: number): void {
    this.crit = c;
    this.critFixed = true;
  }

  /** cHitList::Choose */
  choose(): number {
    if (this.avail.length === 0) {
      const id = this.used.shift() ?? 0;
      this.used.push(id);
      return id;
    }
    const i = randomUniform(this.avail.length);
    const id = this.avail[i]!;
    this.avail.splice(i, 1);
    this.used.push(id);
    while (this.used.length > this.crit) this.avail.push(this.used.shift()!);
    return id;
  }
}

/** cHitControlGroup: a volume (0..1024) applied to its tracks in UpdateVolPan. */
export class HitControlGroup {
  volume = 0x400;
  readonly tracks = new Set<number>();
  constructor(readonly id: number) {}
}

export class HitMan {
  /** cHitTimer elapsed ticks (+0x58). Starts at 1: 0 means "idle" for a player. */
  time = 1;
  private readonly objects = new Map<number, SoundObject>();
  private readonly labels = new Map<number, { code: HitCode; addr: number }>();
  private readonly hitLists = new Map<number, HitList>();
  private readonly globals = new Map<number, number>();
  private readonly groups = new Map<number, HitControlGroup>();
  private readonly updateList = new Set<TrackPlayer>();
  private readonly duckMap = new Map<TrackPlayer, number>();
  /** Sequence groups (+0x1b4): group -> track id that owns it. */
  readonly seqGroups = new Map<number, number>();
  /** RegisterSourceDataRequestHandler: object data for `getsrcdatafield`. */
  sourceDataHandler: ((source: number, field: number) => number | null) | null = null;
  /** Diagnostics (cHitMan vtable 0xd0 "track error"). */
  errors: string[] = [];

  constructor() {
    for (const [r, v] of GLOBAL_DEFAULTS) this.globals.set(r, v);
    for (const g of [GROUP_SFX, GROUP_MUSIC, GROUP_VOX]) this.groups.set(g, new HitControlGroup(g));
  }

  /** cHitMan::RegisterSoundObject */
  registerSoundObject(id: number, obj: SoundObject): void {
    this.objects.set(id, obj);
  }

  /** cHitMan::SoundObject */
  soundObject(id: number): SoundObject | null {
    return this.objects.get(id) ?? null;
  }

  allObjects(): IterableIterator<SoundObject> {
    return this.objects.values();
  }

  /**
   * cHitMan::NextAvailableSndobId. Receivers register one patch per music
   * file; we number them from 0x400000, above every id the .hot files use.
   */
  nextAvailableSndobId(): number {
    let id = 0x400000;
    while (this.objects.has(id)) id++;
    return id;
  }

  /** cHitMan::RegisterTrackDataAddress */
  registerTrackDataAddress(label: number, code: HitCode, addr: number): void {
    this.labels.set(label, { code, addr });
  }

  /** cHitMan::TrackDataAddr */
  trackDataAddr(label: number): { code: HitCode; addr: number } | null {
    return this.labels.get(label) ?? null;
  }

  /** cHitMan::GlobalHitList */
  globalHitList(id: number): HitList | null {
    return this.hitLists.get(id) ?? null;
  }

  /** cHitMan::CreateGlobalHitList */
  createGlobalHitList(id: number): HitList {
    const l = new HitList();
    this.hitLists.set(id, l);
    return l;
  }

  /** First unused hitlist id at or after 0x20000 (cBoxxReceiver). */
  freeHitListId(): number {
    let id = 0x20000;
    while (this.hitLists.has(id)) id++;
    return id;
  }

  /** cHitMan::ControlGroup */
  controlGroup(id: number): HitControlGroup | null {
    return this.groups.get(id) ?? null;
  }

  /** cHitControlGroup::SetVolume: store and refresh the group's playing tracks. */
  setGroupVolume(id: number, v: number): void {
    const g = this.groups.get(id);
    if (!g) return;
    g.volume = v;
    for (const p of this.updateList) if (g.tracks.has(p.trackId())) p.updateVolPan();
  }

  globalReg(r: number): number {
    return this.globals.get(r) ?? 0;
  }

  /** cHitMan::SetRegister (the global set). */
  setRegister(r: number, v: number): void {
    this.globals.set(r, v | 0);
  }

  addToUpdateList(p: TrackPlayer): void {
    this.updateList.add(p);
  }

  removeFromUpdateList(p: TrackPlayer): void {
    this.updateList.delete(p);
  }

  activePlayers(): TrackPlayer[] {
    return [...this.updateList];
  }

  /** cHitMan::DuckMapSetSndobPri */
  duckMapSetSndobPri(p: TrackPlayer, pri: number): void {
    if (pri === 0) this.duckMap.delete(p);
    else this.duckMap.set(p, pri);
    let max = 0;
    for (const v of this.duckMap.values()) max = Math.max(max, v);
    this.globals.set(R.main_duckpri, max);
    this.updateActiveTrackVolumes();
  }

  /** cHitMan::UpdateActiveTrackVolumes */
  updateActiveTrackVolumes(): void {
    for (const p of this.updateList) p.updateVolPan();
  }

  /** cHitMan::TimerCallback: one engine tick. */
  timerCallback(): void {
    this.time++;
    for (const p of [...this.updateList]) p.handleTimerCallback();
  }

  /** cHitMan::KillAll */
  killAll(): void {
    for (const p of [...this.updateList]) p.kill();
  }

  /** +0x28: set by Pause, cleared by Unpause (cBoxX kNotifyChange reads it). */
  paused = false;

  /** cHitMan::DuckMapRemoveAll */
  duckMapRemoveAll(): void {
    this.duckMap.clear();
    this.globals.set(R.main_duckpri, 0);
    this.updateActiveTrackVolumes();
  }

  /** cHitMan::Pause: every sound object pauses. */
  pause(): void {
    this.paused = true;
    for (const o of this.objects.values()) (o as Partial<Pausable>).pause?.();
    this.duckMapRemoveAll();
  }

  /** cHitMan::Unpause: every sound object unpauses (cBoxX::Unpause). */
  unpause(): void {
    this.paused = false;
    for (const o of this.objects.values()) (o as Partial<Pausable>).unpause?.();
  }

  error(who: string, msg: string): void {
    const line = `${who}: ${msg}`;
    this.errors.push(line);
    if (this.errors.length > 200) this.errors.shift();
    console.debug(`[hit] ${line}`);
  }
}
