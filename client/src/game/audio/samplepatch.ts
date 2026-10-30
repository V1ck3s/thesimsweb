/**
 * cSoundObject, cSamplePatch and cSampleChannel.
 *
 * Every playable thing registered in cHitMan is a sound object with an id and
 * a register set (cSndobAttrRegisterSet). A cSamplePatch is one sample file;
 * a track plays it through a cSampleChannel created by
 * cSamplePatch::CreateChannel (one channel per playing track).
 *
 * cSamplePatch::CreateSnd picks the sound class from the file: names ending
 * in ".MP?" are streamed (cTSSndDShow, here an <audio> element), the rest are
 * loaded whole (cTSSnd, here an AudioBuffer).
 */

import { audioContext, audioUnlocked, loadBuffer, looseUrl, masterOut, tsVolumeToGain, whenUnlocked } from "./audiosys.js";
import { R } from "./registers.js";

export const CLASS_TRACK = 0xa3cd96cf;
export const CLASS_SAMPLE_PATCH = 0xa3cd96b7;

/** Register defaults of a sound object (the patch-attribute set, hitman init). */
const PATCH_DEFAULTS = new Map<number, number>([
  [R.pitch, 0xe10],
  [R.vol, 0x400],
  [R.extvol, 0x400],
  [R.pan, 0x200],
]);

export abstract class SoundObject {
  readonly regs = new Map<number, number>();
  constructor(
    readonly id: number,
    readonly classId: number,
  ) {}
  /** cSoundObject::RegisterVal */
  registerVal(r: number): number {
    return this.regs.get(r) ?? PATCH_DEFAULTS.get(r) ?? 0;
  }
  /** cSoundObject::SetRegister */
  setRegister(r: number, v: number): boolean {
    this.regs.set(r, v | 0);
    return true;
  }
}

export class SamplePatch extends SoundObject {
  constructor(
    id: number,
    readonly name: string,
    /** Game-relative file path. */
    readonly path: string,
    flags: { looped?: boolean; streamed?: boolean; preload?: boolean; is3d?: boolean; headRelative?: boolean } = {},
  ) {
    super(id, CLASS_SAMPLE_PATCH);
    this.setRegister(R.IsLooped, flags.looped ? 1 : 0);
    this.setRegister(R.IsStreamed, flags.streamed ? 1 : 0);
    this.setRegister(R.Preload, flags.preload ? 1 : 0);
    this.setRegister(R.Is3d, flags.is3d ? 1 : 0);
    this.setRegister(R.IsHeadRelative, flags.headRelative ? 1 : 0);
  }

  /** cSamplePatch::CreateSnd: ".MP3" files stream, the rest load whole. */
  isStreamedFile(): boolean {
    return this.path.slice(-4).toUpperCase().startsWith(".MP");
  }

  /** cSamplePatch::CreateChannel */
  createChannel(): SampleChannel {
    return new SampleChannel(this);
  }
}

/**
 * cSampleChannel: plays a patch with volume (0..1024, cTSSnd::SetVolume
 * mapping), pan (0..1024, 512 = centre) and pitch.
 */
export class SampleChannel {
  /** Recent play() calls (dev diagnostics: which file an event ended up playing). */
  static readonly playLog: Array<{ path: string; at: number }> = [];

  private readonly gain: GainNode;
  /** cTSSnd::SetPan: a DirectSound pan (per-side attenuation, no centre dip). */
  private readonly panner: DSPanner;
  private source: AudioBufferSourceNode | null = null;
  private element: HTMLAudioElement | null = null;
  private elementNode: MediaElementAudioSourceNode | null = null;
  /** Set by play(), cleared when the sample ends or is stopped. */
  private playing = false;
  private paused = false;
  private generation = 0;
  private looped = false;
  private rate = 1;

  constructor(readonly patch: SamplePatch) {
    const ctx = audioContext();
    this.gain = ctx.createGain();
    this.panner = new DSPanner(ctx);
    this.gain.connect(this.panner.input);
    this.panner.output.connect(masterOut());
  }

  /** IsPlaying: true from play() (including while loading) until the end. */
  isPlaying(): boolean {
    return this.playing;
  }

  setLooped(on: boolean): void {
    this.looped = on;
    if (this.source) this.source.loop = on;
    if (this.element) this.element.loop = on;
  }

  /** Channel volume 0..1024. */
  setVolume(v: number): void {
    this.gain.gain.value = tsVolumeToGain(v);
  }

  /** Pan 0..1024 (512 centre). */
  setPan(p: number): void {
    this.panner.setPan(p);
  }

  /** Pitch in cents around 3600 (cTrackPlayer passes trackPitch + patchPitch - 3600). */
  setPitch(p: number): void {
    this.rate = Math.pow(2, (p - 0xe10) / 1200);
    if (this.source) this.source.playbackRate.value = this.rate;
    if (this.element) this.element.playbackRate = this.rate;
  }

  /** Start the sample from the beginning. */
  play(): void {
    SampleChannel.playLog.push({ path: this.patch.path, at: performance.now() });
    if (SampleChannel.playLog.length > 100) SampleChannel.playLog.shift();
    this.stop();
    this.playing = true;
    const gen = ++this.generation;
    void this.start(gen).catch((err: unknown) => {
      if (gen !== this.generation) return;
      console.warn(`sound: ${this.patch.path}:`, err);
      this.playing = false;
    });
  }

  private async start(gen: number): Promise<void> {
    if (this.patch.isStreamedFile()) {
      const url = await looseUrl(this.patch.path);
      if (!url) throw new Error("file not found");
      if (!audioUnlocked()) await whenUnlocked();
      if (gen !== this.generation) return;
      const el = new Audio(url);
      el.loop = this.looped;
      el.playbackRate = this.rate;
      el.addEventListener("ended", () => {
        if (gen === this.generation) this.playing = false;
      });
      this.element = el;
      this.elementNode = audioContext().createMediaElementSource(el);
      this.elementNode.connect(this.gain);
      if (!this.paused) await el.play();
      return;
    }
    const buf = await loadBuffer(this.patch.path);
    if (!audioUnlocked()) await whenUnlocked();
    if (gen !== this.generation) return;
    const src = audioContext().createBufferSource();
    src.buffer = buf;
    src.loop = this.looped;
    src.playbackRate.value = this.rate;
    src.connect(this.gain);
    src.onended = () => {
      if (gen === this.generation && this.source === src) {
        this.playing = false;
        this.source = null;
      }
    };
    this.source = src;
    src.start();
  }

  stop(): void {
    this.generation++;
    this.playing = false;
    if (this.source) {
      this.source.onended = null;
      try {
        this.source.stop();
      } catch {
        /* never started */
      }
      this.source.disconnect();
      this.source = null;
    }
    if (this.element) {
      this.element.pause();
      this.elementNode?.disconnect();
      this.element.removeAttribute("src");
      this.element = null;
      this.elementNode = null;
    }
  }

  /** cTSSnd::Pause: streamed music pauses in place; samples go silent. */
  pause(): void {
    this.paused = true;
    if (this.element) this.element.pause();
    this.gain.disconnect();
  }

  unpause(): void {
    if (!this.paused) return;
    this.paused = false;
    this.gain.connect(this.panner.input);
    if (this.element && this.playing) void this.element.play();
  }

  /** Release the Web Audio nodes (cTrackPlayer::SetPatch drops the channel). */
  release(): void {
    this.stop();
    this.gain.disconnect();
    this.panner.disconnect();
  }
}

/**
 * IDirectSoundBuffer::SetPan as cTSSnd::SetPan drives it: 0..1024 becomes
 * -10000..10000 (1/100 dB); a positive pan attenuates the left side by that
 * many dB, a negative one the right side; the centre plays both sides at full
 * volume. (A StereoPannerNode is equal-power: -3 dB at the centre and a much
 * gentler curve.) Mono input is upmixed to both sides first.
 */
export class DSPanner {
  /** Upmixes to 2 channels ("explicit" 2, "speakers": mono -> L = R). */
  readonly input: GainNode;
  readonly output: ChannelMergerNode;
  private readonly split: ChannelSplitterNode;
  private readonly left: GainNode;
  private readonly right: GainNode;

  constructor(ctx: BaseAudioContext) {
    this.input = new GainNode(ctx, { channelCount: 2, channelCountMode: "explicit", channelInterpretation: "speakers" });
    this.split = ctx.createChannelSplitter(2);
    this.left = ctx.createGain();
    this.right = ctx.createGain();
    this.output = ctx.createChannelMerger(2);
    this.input.connect(this.split);
    this.split.connect(this.left, 0).connect(this.output, 0, 0);
    this.split.connect(this.right, 1).connect(this.output, 0, 1);
  }

  /** cTSSnd::SetPan(0..1024, 512 = centre). */
  setPan(p: number): void {
    const c = Math.max(0, Math.min(0x400, p | 0));
    const mb = Math.trunc((c * 20000) / 1024) - 10000;
    this.left.gain.value = mb > 0 ? Math.pow(10, -mb / 2000) : 1;
    this.right.gain.value = mb < 0 ? Math.pow(10, mb / 2000) : 1;
  }

  disconnect(): void {
    this.input.disconnect();
    this.split.disconnect();
    this.left.disconnect();
    this.right.disconnect();
    this.output.disconnect();
  }
}
