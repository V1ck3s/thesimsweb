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

import { audioContext, audioUnlocked, fileSampleRate, loadBuffer, looseUrl, masterOut, tsVolumeToGain, whenUnlocked } from "./audiosys.js";
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

/**
 * cSampleChannel::SetPitch: the base frequency (lbl_105BC85C + 8) and the
 * semitone ratio (+0x10); the pitch is in cents, 3600 = 22050 Hz.
 */
const PITCH_BASE_HZ = 22050;
const SEMITONE = 1.0594630943592953;

export class SamplePatch extends SoundObject {
  /** cSoundObject +0x14: references taken by cTrackPlayer::SetPatch (AddRef / Release). */
  private refs = 0;
  /**
   * The cTSSnd made by cSamplePatch::CreateSnd has its DirectSound buffer
   * (cTSSnd +0x70, Windows +0x80): created by cTSSnd::Load, which runs on
   * the first Play (or at CreateSnd for a Preload patch), and dropped with
   * the cTSSnd by FreeSnd when the last reference goes.
   */
  sndLoaded = false;
  /** Frequency set on that buffer by cTSSnd::SetFrequency; null = the file's own rate. */
  sndFrequency: number | null = null;

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

  /** cSamplePatch::AddRef: the first reference creates the sound (CreateSnd). */
  addRef(): void {
    if (this.refs++ === 0) {
      // cSamplePatch::CreateSnd: a new cTSSnd, loaded at once when Preload.
      this.sndLoaded = this.registerVal(R.Preload) !== 0 && !this.isStreamedFile();
      this.sndFrequency = null;
    }
  }

  /** cSamplePatch::Release: the last reference frees the sound (FreeSnd). */
  release(): void {
    if (this.refs > 0 && --this.refs === 0) {
      this.sndLoaded = false;
      this.sndFrequency = null;
    }
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

  /**
   * cSampleChannel::SetPitch (cTrackPlayer passes trackPitch + patchPitch -
   * 3600): an **absolute** frequency, 22050 * 1.0594631^((p - 3600) / 100) Hz,
   * given to cTSSnd::SetFrequency (clamped to 100..100000), which does
   * nothing while the sound has no DirectSound buffer yet (not played since
   * CreateSnd) and nothing for the streamed MP3s (cTSSndDShow). So pitch
   * 3600 is 22050 Hz, and the TV stations' 2400 is 11025 Hz, the rate of
   * their 11025 Hz clips.
   */
  setPitch(p: number): void {
    const patch = this.patch;
    if (patch.isStreamedFile() || !patch.sndLoaded) return;
    const hz = p === 0xe10 ? PITCH_BASE_HZ : PITCH_BASE_HZ * Math.pow(SEMITONE, (p - 0xe10) / 100);
    patch.sndFrequency = Math.max(100, Math.min(100000, Math.trunc(hz)));
    this.applyFrequency();
  }

  /** Playback rate of the buffer source: the sound's frequency over the file's own rate. */
  private applyFrequency(): void {
    const src = this.source;
    if (!src?.buffer) return;
    const native = fileSampleRate(src.buffer);
    src.playbackRate.value = (this.patch.sndFrequency ?? native) / native;
  }

  /** Start the sample from the beginning. */
  play(): void {
    SampleChannel.playLog.push({ path: this.patch.path, at: performance.now() });
    if (SampleChannel.playLog.length > 100) SampleChannel.playLog.shift();
    this.stop();
    this.playing = true;
    // cTSSnd::Play loads the sound first (cTSSnd::Load creates the buffer at
    // the file's own frequency); later SetFrequency calls then apply.
    if (!this.patch.isStreamedFile() && !this.patch.sndLoaded) {
      this.patch.sndLoaded = true;
      this.patch.sndFrequency = null;
    }
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
    src.connect(this.gain);
    src.onended = () => {
      if (gen === this.generation && this.source === src) {
        this.playing = false;
        this.source = null;
      }
    };
    this.source = src;
    this.applyFrequency();
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
