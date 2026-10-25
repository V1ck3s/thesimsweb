/**
 * cSoundPlayer: the game's sound facade (cSimsApp+0x10), wrapping cBoxX.
 *
 * Usage (the shell calls `initialize` once at boot):
 *   soundPlayer.initialize(getOptionsMgr());
 *   soundPlayer.playBySource("UI_whoosh");          // UI event (source -4)
 *   soundPlayer.playBySource("dishw_sopen", objId); // object event
 *   soundPlayer.setMusicMode(MODE.Buy);             // = playBySource("bkground_buy1")
 *
 * Volumes follow cOptionsMgr (0..10, VOLUME_TABLE). Audio only starts after
 * the first user gesture (browser policy; see audiosys.installUnlock): sounds
 * requested before are kept waiting, music then starts where it should.
 * Requests made while the data still loads are replayed once it is ready.
 */

import type { OptionsMgr } from "../optionsmgr.js";
import { TSWinBtn } from "../ui/btn.js";
import { audioContext, installUnlock, looseUrl, masterOut, tsVolumeToGain, whenUnlocked } from "./audiosys.js";
import { BoxX, EV, VOLUME_TABLE } from "./boxx.js";
import { MUSIC, UI_SOURCE } from "./uisound.js";

/** "Music/modes/load/loadloop.wav" (cSimsApp::StartLoadMusic). */
const LOAD_MUSIC = "Music\\Modes\\Load\\loadloop.wav";

const MODE_EVENTS: Record<number, string> = {
  0: MUSIC.live,
  1: MUSIC.buy,
  2: MUSIC.build,
  3: MUSIC.hood,
  5: MUSIC.load,
  6: MUSIC.credits,
  7: MUSIC.options,
  8: MUSIC.family,
  9: MUSIC.fade,
};

export class SoundPlayer {
  /** +0xc */
  boxx: BoxX | null = null;
  /** +0x10: last source passed to PlayBySource (used for source -2). */
  private lastSource = 0;
  private ready: Promise<void> | null = null;
  private pending: Array<[string, number]> = [];
  private loadMusic: HTMLAudioElement | null = null;
  private loadGain: GainNode | null = null;

  /** cSoundPlayer::Initialize (+ the cOptionsMgr volumes). */
  initialize(options?: OptionsMgr, usVersion = false): Promise<void> {
    if (this.ready) return this.ready;
    installUnlock();
    TSWinBtn.uiSoundHook = (name) => {
      this.playBySource(name, UI_SOURCE);
    };
    const boxx = new BoxX();
    this.ready = boxx.init(usVersion).then(() => {
      this.boxx = boxx;
      if (options) {
        const apply = (o: OptionsMgr): void => {
          this.setFXVolume(o.getFXVolume());
          this.setMusicVolume(o.getMusicVolume());
          this.setVoxVolume(o.getVoxVolume());
          if (this.loadGain) this.loadGain.gain.value = tsVolumeToGain(VOLUME_TABLE[o.getMusicVolume()] ?? 0);
        };
        apply(options);
        options.onChange(apply);
      }
      for (const [name, src] of this.pending.splice(0)) this.playBySource(name, src);
    });
    return this.ready;
  }

  isReady(): boolean {
    return this.boxx !== null;
  }

  /**
   * cSoundPlayer::PlayBySource: play the event `name` for `source` (an object
   * id, -4 for the UI, -2 = the last source used). Returns false when the
   * event is unknown.
   */
  playBySource(name: string, source = UI_SOURCE): boolean {
    if (!this.boxx) {
      if (this.ready && this.pending.length < 32) this.pending.push([name, source]);
      return true;
    }
    if (!name.toLowerCase().startsWith("footstep") && source > 0) this.lastSource = source;
    if (source === -2) {
      if (this.lastSource === 0) return false;
      source = this.lastSource;
    }
    return this.boxx.playMappedEvent(name.toLowerCase(), source);
  }

  /** Shorthand for UI events (PlaySoundA). */
  playUISound(name: string): boolean {
    return this.playBySource(name, UI_SOURCE);
  }

  /** Music of a game mode (cGameModeManager mode, see boxx.MODE). */
  setMusicMode(mode: number): void {
    const ev = MODE_EVENTS[mode];
    if (ev) this.playBySource(ev);
    else this.boxx?.event(EV.SetMusicMode, mode);
  }

  /** cSoundPlayer::QuietBySourceID */
  quietBySourceID(source: number): void {
    this.boxx?.event(EV.KillInstance, source);
  }

  /** cSoundPlayer::QuietAll */
  quietAll(): void {
    this.boxx?.event(EV.KillAll, 0);
  }

  /** cSoundPlayer::PauseSounds / ResumeSounds */
  pauseSounds(): void {
    this.boxx?.event(EV.Pause, 0);
  }
  resumeSounds(): void {
    this.boxx?.event(EV.Unpause, 0);
  }

  /** cSoundPlayer::EnableSound / EnableMusic */
  enableSound(on: boolean): void {
    this.boxx?.event(EV.EnableSound, on ? 1 : 0);
  }
  enableMusic(on: boolean): void {
    this.boxx?.event(EV.EnableMusic, on ? 1 : 0);
  }

  /** cSoundPlayer::SetFXVolume / SetMusicVolume / SetVoxVolume (0..10). */
  setFXVolume(v: number): void {
    this.boxx?.event(EV.SetFXVolume, v);
  }
  setMusicVolume(v: number): void {
    this.boxx?.event(EV.SetMusicVolume, v);
  }
  setVoxVolume(v: number): void {
    this.boxx?.event(EV.SetVoxVolume, v);
  }

  /**
   * cSimsApp::StartLoadMusic: the looping loading theme, played directly
   * (not through the HIT engine) at the music volume.
   */
  async startLoadMusic(options?: OptionsMgr): Promise<void> {
    if (this.loadMusic) return;
    const url = await looseUrl(LOAD_MUSIC);
    if (!url) return;
    const vol = VOLUME_TABLE[options?.getMusicVolume() ?? 8] ?? 0;
    if (vol === 0) return;
    const el = new Audio(url);
    el.loop = true;
    this.loadMusic = el;
    const ctx = audioContext();
    this.loadGain = ctx.createGain();
    this.loadGain.gain.value = tsVolumeToGain(vol);
    ctx.createMediaElementSource(el).connect(this.loadGain).connect(masterOut());
    await whenUnlocked();
    if (this.loadMusic === el) await el.play();
  }

  /** cSimsApp::StopLoadMusic: fade the loading theme out. */
  stopLoadMusic(): void {
    const el = this.loadMusic;
    const g = this.loadGain;
    this.loadMusic = null;
    this.loadGain = null;
    if (!el || !g) return;
    const ctx = audioContext();
    g.gain.setValueAtTime(g.gain.value, ctx.currentTime);
    g.gain.linearRampToValueAtTime(0, ctx.currentTime + 1);
    window.setTimeout(() => {
      el.pause();
      g.disconnect();
    }, 1100);
  }
}

/** The game's single cSoundPlayer. */
export const soundPlayer = new SoundPlayer();
