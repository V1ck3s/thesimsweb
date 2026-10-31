/**
 * The "Freshness" outdoor ambience engine (Freshness.cpp / FreshnessUtil.cpp):
 * cFreshScore (a .fsc score: a grid of cells, each a sample with its
 * volume, position, probability and group), cFreshPlayer (picks cells around
 * a position in the grid on the beat), cFreshCellPlayer (one cell's sound)
 * and cFreshTimer (the 100 ms clock driving the players).
 *
 * cBoxX owns four players (backyard, beach, park, magic town) and moves the
 * current one in the grid: Y = share of outside tiles in view, X = hour of
 * the day (cBoxX::Event kNotifyChange).
 *
 * Samples play through their own Web Audio nodes (cTSSnd3D: a 3D buffer at
 * (x, 0, z) * 100 with min / max distance 100 / 100000 around the listener),
 * not through the HIT engine.
 */

import { audioContext, fileSampleRate, loadBuffer, masterOut, readGameFile, tsVolumeToGain } from "./audiosys.js";

let randSeed = 1;

/** rand_override (MSLOverrides.cpp): the MSVC rand() LCG, seed lbl_105BD698 = 1. */
export function randOverride(): number {
  randSeed = (Math.imul(randSeed, 0x343fd) + 0x269ec3) | 0;
  return (randSeed >>> 16) & 0x7fff;
}

/** lbl_105BC824: chance numerators by cell probability (0..20), divided by the cells in the selection area. */
const PROB_TABLE = [
  0, 600, 1500, 3000, 7500, 12000, 15000, 18000, 21000, 25500, 32767, 36000, 45000, 58000, 67500, 90000, 120000, 210000, 300000,
  40000000, 40000000,
];

/** lbl_105BAC3C: frequency factor by semitone (2^(n/12)), divided for negative steps. */
const SEMITONES = [
  1.0, 1.059463094359, 1.122462048309, 1.189207115003, 1.259921049895, 1.33483985417, 1.414213562373, 1.498307076877, 1.587401051968,
  1.681792830507, 1.781797436281, 1.887748625363, 2.0, 100.0,
];

/** cFreshCell (0x54 bytes), one cell of a score. */
export interface FreshCell {
  /** +0x00 sample file, relative to the player's data folder. */
  name: string;
  /** +0x04 "fast?" */
  fast: boolean;
  /** +0x08 vol (0..1024). */
  vol: number;
  /** +0x0c LR / +0x10 FB position (512 = centre). */
  lr: number;
  fb: number;
  /** +0x14 random volume, +0x15 random position. */
  randVol: boolean;
  randPan: boolean;
  /** +0x18 fade in, +0x1c fade out (ms), +0x20 delay. */
  fadeIn: number;
  fadeOut: number;
  delay: number;
  /** +0x24 probability 0..20 (20 = always). */
  prob: number;
  /** +0x28 the third "rand?" column. */
  rand3: boolean;
  /** +0x2c loop count (beats), +0x34 looped. */
  loopCount: number;
  looped: boolean;
  /** +0x30 quant. */
  quant: number;
  /** +0x38 / +0x3c random pitch range in semitones. */
  pitchLo: number;
  pitchHi: number;
  /** +0x40 group: one cell of a group plays at a time. */
  group: number;
  /** +0x44 stereo? */
  stereo: boolean;
  /** +0x48 exclusion cells (x = column, y = row). */
  exclusions: Array<{ x: number; y: number }>;
}

/** cFreshScore */
export class FreshScore {
  /** +0x04 */
  vol = 0x400;
  /** +0x08: the header's "pri" column (quantizes the position to selection blocks, enables subtracting cells). */
  pri = 0;
  /** +0x0c / +0x10 */
  minCells = 0;
  maxCells = 4;
  /** +0x14 / +0x18 (DifX / DifY): extra minimum cells toward the right / bottom of the grid. */
  difX = 0;
  difY = 0;
  /** +0x1c SelY / +0x20 SelX: selection half-size in rows / columns. */
  selY = 2;
  selX = 2;
  /** +0x24 / +0x28 */
  rows = 4;
  cols = 4;
  /** +0x2c beats per minute, +0x30 beats per bar. */
  tempo = 0x78;
  bpb = 8;
  /** +0x34 / +0x38 */
  quanX = 1;
  quanY = 1;
  /** +0x3c / +0x40: position Play starts at (not in the file). */
  startX = 0;
  startY = 0;
  /** +0x44: cells[row][col] (64 x 64), null for "NONE". */
  readonly cells: Array<Array<FreshCell | null>> = Array.from({ length: 0x40 }, () => new Array<FreshCell | null>(0x40).fill(null));

  /**
   * cFreshScore::LoadScore: "version N", a comment line, the header
   * (vol pri min max rows cols tempo BPB SelX SelY QuanX QuanY DifX DifY),
   * a comment line, then rows x cols cell lines (version 7: 18 numbers and
   * the file name; versions 5 and 6: 17 numbers), each optionally followed
   * by "(x,y)" exclusion cells.
   */
  load(text: string): boolean {
    const lines = text.split("\n");
    let i = 0;
    const next = (): string => (lines[i++] ?? "").replace(/\r$/, "");
    const first = next();
    if (!first.startsWith("version")) return true;
    const version = Number.parseInt(first.slice(7).trim(), 10);
    if (version !== 7 && version !== 6 && version !== 5) return true;
    next();
    const h = next()
      .trim()
      .split(/\s+/)
      .map((s) => Number.parseInt(s, 10) | 0);
    // sscanf targets: +4 +8 +0xc +0x10 +0x24 +0x28 +0x2c +0x30 +0x20 +0x1c +0x34 +0x38 +0x14 +0x18
    [this.vol, this.pri, this.minCells, this.maxCells, this.rows, this.cols, this.tempo, this.bpb, this.selX, this.selY, this.quanX, this.quanY, this.difX, this.difY] =
      h.length >= 14 ? (h as [number, number, number, number, number, number, number, number, number, number, number, number, number, number]) : [this.vol, this.pri, this.minCells, this.maxCells, this.rows, this.cols, this.tempo, this.bpb, this.selX, this.selY, this.quanX, this.quanY, this.difX, this.difY];
    this.rows = Math.min(this.rows, 0x40);
    this.cols = Math.min(this.cols, 0x40);
    next();
    const nums = version === 7 ? 18 : 17;
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const line = next();
        const tok = line.trim().split(/\s+/);
        const n = tok.slice(0, nums).map((s) => Number.parseInt(s, 10) | 0);
        const name = tok[nums] ?? "";
        if (name.toUpperCase() === "NONE" || name === "") {
          this.cells[r]![c] = null;
          continue;
        }
        const exclusions: Array<{ x: number; y: number }> = [];
        for (const m of line.matchAll(/\((-?\d+),(-?\d+)\)/g)) exclusions.push({ x: Number(m[1]), y: Number(m[2]) });
        const v = (k: number): number => n[k] ?? 0;
        this.cells[r]![c] = {
          name,
          vol: v(0),
          randVol: v(1) !== 0,
          lr: v(2),
          fb: v(3),
          randPan: v(4) !== 0,
          fadeIn: v(5),
          fadeOut: v(6),
          delay: v(7),
          rand3: v(8) !== 0,
          loopCount: v(9),
          looped: v(10) !== 0,
          quant: v(11),
          prob: v(12),
          pitchLo: v(13),
          pitchHi: v(14),
          fast: v(15) !== 0,
          group: v(16),
          stereo: version === 7 && v(17) !== 0,
          exclusions,
        };
      }
    }
    return true;
  }
}

/**
 * cTSSnd3D, the part the fresh cells use: a whole sample with volume
 * (cTSSnd::SetVolume dB curve), FadeVolume, frequency and a 3D position.
 */
class FreshSnd {
  private buffer: AudioBuffer | null = null;
  private failed = false;
  private source: AudioBufferSourceNode | null = null;
  private readonly gain: GainNode;
  private readonly panner: PannerNode;
  private volume = 0x400;
  private rate = 1;
  private playing = false;
  private fadeTimer: number | null = null;

  constructor(readonly path: string) {
    const ctx = audioContext();
    this.gain = ctx.createGain();
    // cFreshCellPlayer::Update: SetMinDistance(100), SetMaxDistance(100000).
    this.panner = new PannerNode(ctx, { panningModel: "equalpower", distanceModel: "inverse", refDistance: 100, maxDistance: 100000, rolloffFactor: 1 });
    this.gain.connect(this.panner).connect(masterOut());
    loadBuffer(path).then(
      (b) => {
        this.buffer = b;
      },
      () => {
        this.failed = true;
      },
    );
  }

  /** null while loading, then whether cTSSnd::Load succeeded. */
  loaded(): boolean | null {
    if (this.failed) return false;
    return this.buffer ? true : null;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  getVolume(): number {
    return this.volume;
  }

  setVolume(v: number): void {
    this.volume = v;
    this.gain.gain.value = tsVolumeToGain(v);
  }

  /** cTSSnd::FadeVolume(from, to, ms, async, ...): ten steps on a 100 ms-period timer. */
  fadeVolume(from: number, to: number, ms: number): void {
    if (this.fadeTimer !== null) return;
    const step = Math.trunc((to - from) / 10);
    this.setVolume(from);
    let n = 0;
    this.fadeTimer = window.setInterval(
      () => {
        this.setVolume(++n >= 10 ? to : this.volume + step);
        if (n < 10) return;
        window.clearInterval(this.fadeTimer!);
        this.fadeTimer = null;
        if (to === 0) this.stop();
      },
      Math.max(1, Math.trunc(ms / 10)),
    );
  }

  /** cTSSnd::GetFrequency, in the file's Hz (not the context's resampled rate). */
  getFrequency(): number {
    return Math.trunc((this.buffer ? fileSampleRate(this.buffer) : 22050) * this.rate);
  }

  /** cTSSnd::SetFrequency: absolute Hz, clamped to 100..100000. */
  setFrequency(f: number): void {
    const hz = Math.max(100, Math.min(100000, Math.trunc(f)));
    this.rate = hz / (this.buffer ? fileSampleRate(this.buffer) : 22050);
    if (this.source) this.source.playbackRate.value = this.rate;
  }

  /** IDirectSound3DBuffer::SetPosition */
  setPosition(x: number, y: number, z: number): void {
    this.panner.positionX.value = x;
    this.panner.positionY.value = y;
    this.panner.positionZ.value = z;
  }

  play(looped: boolean): void {
    if (!this.buffer) return;
    this.stop();
    const src = audioContext().createBufferSource();
    src.buffer = this.buffer;
    src.loop = looped;
    src.playbackRate.value = this.rate;
    src.connect(this.gain);
    src.onended = () => {
      if (this.source === src) {
        this.playing = false;
        this.source = null;
      }
    };
    this.source = src;
    this.playing = true;
    src.start();
  }

  stop(): void {
    this.playing = false;
    const src = this.source;
    this.source = null;
    if (!src) return;
    src.onended = null;
    try {
      src.stop();
    } catch {
      /* never started */
    }
    src.disconnect();
  }

  /** cTSSnd::Unload + Release */
  release(): void {
    this.stop();
    if (this.fadeTimer !== null) window.clearInterval(this.fadeTimer);
    this.fadeTimer = null;
    this.gain.disconnect();
    this.panner.disconnect();
  }
}

const enum CellState {
  Idle = 0,
  Starting = 1,
  Ready = 2,
  ReadyNext = 3,
  Playing = 4,
  Fading = 5,
}

/** cFreshCellPlayer (0x18 bytes): the sound of one grid cell. */
class FreshCellPlayer {
  /** +0x04 */
  snd: FreshSnd | null = null;
  /** +0x08 */
  state: CellState = CellState.Idle;
  /** +0x0c the score cell being played. */
  cell: FreshCell | null = null;
  /** +0x10 beats left for a looped cell. */
  private loops = 0;
  /** +0x14 holds a cFreshTimer fast reference. */
  private fastRef = false;
  /** +0x15 marked for subtraction. */
  dying = false;
  /** +0x16 */
  disabled = false;

  constructor(private readonly player: FreshPlayer) {}

  /** cFreshCellPlayer::Start */
  start(cell: FreshCell): boolean {
    if (this.disabled || this.state !== CellState.Idle) return false;
    this.cell = cell;
    this.dying = false;
    if (cell.looped) this.loops = cell.loopCount;
    this.state = CellState.Starting;
    return true;
  }

  /** cFreshCellPlayer::Kill */
  kill(): boolean {
    if (!this.cell) return false;
    if (this.fastRef) {
      this.player.timer.subtractFastTimerRef();
      this.fastRef = false;
    }
    this.snd?.release();
    this.snd = null;
    this.cell = null;
    this.dying = false;
    this.state = CellState.Idle;
    return true;
  }

  /** cFreshCellPlayer::Stop */
  stop(): void {
    if (this.fastRef) {
      this.player.timer.subtractFastTimerRef();
      this.fastRef = false;
    }
    const s = this.state;
    if (s === CellState.ReadyNext || s === CellState.Fading || s === CellState.Idle) return;
    if (s !== CellState.Playing || !this.cell || this.cell.fadeOut === 0) {
      this.kill();
      return;
    }
    this.state = CellState.Fading;
    this.snd?.fadeVolume(this.snd.getVolume(), 0, this.cell.fadeOut);
  }

  /** cFreshCellPlayer::SetVol */
  setVol(): void {
    if (!this.snd || !this.cell) return;
    this.snd.setVolume((((this.cell.vol * this.player.vol) >> 10) * this.player.score.vol) >> 10);
  }

  /** cFreshCellPlayer::UpdatePan */
  private updatePan(): void {
    const cell = this.cell;
    if (!cell || !this.snd) return;
    let x = (cell.lr - 0x200) / 0x200;
    let z = (cell.fb - 0x200) / 0x200;
    if (!cell.randPan || cell.lr !== 0x200 || cell.fb !== 0x200) {
      if (cell.randPan && cell.lr === 0x200) x = (randOverride() & 1) * 2 - 1;
      if (cell.randPan && cell.fb === 0x200) z = (randOverride() & 1) * 2 - 1;
    } else {
      switch (randOverride() & 3) {
        case 0:
          [x, z] = [0, 1];
          break;
        case 1:
          [x, z] = [0, -1];
          break;
        case 2:
          [x, z] = [-1, 0];
          break;
        default:
          [x, z] = [1, 0];
          break;
      }
    }
    this.snd.setPosition(x * 100, 0, z * 100);
  }

  /** cFreshCellPlayer::Update(late, beat) */
  update(late: boolean, beat: number): void {
    const cell = this.cell;
    switch (this.state) {
      case CellState.ReadyNext:
        this.state = CellState.Ready;
        return;
      case CellState.Starting: {
        // Loads synchronously in the original; here the cell waits (busy) until the sample is decoded.
        if (!cell) return;
        this.snd ??= new FreshSnd(this.player.dataDir + cell.name);
        const ok = this.snd.loaded();
        if (ok === null) return;
        if (!ok) {
          this.kill();
          return;
        }
        this.state = CellState.Ready;
        return;
      }
      case CellState.Ready: {
        if (!cell || !this.snd) return;
        if (beat === this.player.score.bpb && cell.fast && !this.fastRef) {
          this.player.timer.addFastTimerRef();
          this.fastRef = true;
        }
        if (beat !== 1 || (cell.fast && late)) return;
        this.state = CellState.Playing;
        if ((cell.pitchLo !== 0 || cell.pitchHi !== 0) && cell.pitchLo <= cell.pitchHi) {
          const span = cell.pitchHi - cell.pitchLo + 1;
          const semis = cell.pitchLo + (randOverride() % span);
          const f = this.snd.getFrequency();
          this.snd.setFrequency(Math.trunc(semis < 0 ? f / SEMITONES[-semis]! : f * SEMITONES[semis]!));
        }
        let vol = (this.player.vol * cell.vol) >> 10;
        if (cell.randVol && vol > 3) vol -= randOverride() % Math.trunc(vol / 3);
        if (cell.fadeIn === 0) this.setVol();
        else this.snd.setVolume(0);
        this.snd.play(cell.looped);
        this.updatePan();
        if (cell.fadeIn !== 0) this.snd.fadeVolume(vol, 0, 2000);
        if (this.fastRef) {
          this.player.timer.subtractFastTimerRef();
          this.fastRef = false;
        }
        return;
      }
      case CellState.Fading:
        if (!this.snd?.isPlaying()) {
          this.kill();
          this.state = CellState.Idle;
        }
        return;
      case CellState.Playing: {
        if (!cell) return;
        if (!cell.looped) {
          if (!this.snd?.isPlaying()) {
            this.stop();
            this.state = CellState.Idle;
          }
          return;
        }
        this.loops--;
        if (this.dying) {
          if (this.loops === 0) return;
          if (!cell.fast || !late) {
            this.kill();
            return;
          }
        }
        if (this.loops === 1) {
          if (cell.fast && !this.fastRef) {
            this.player.timer.addFastTimerRef();
            this.fastRef = true;
          }
        } else if (this.loops === 0) {
          this.loops = cell.loopCount;
          if (!late && this.fastRef) {
            this.player.timer.subtractFastTimerRef();
            this.fastRef = false;
          }
        }
        return;
      }
      default:
        return;
    }
  }
}

/**
 * cFreshTimer: a 100 ms callback timer (lbl_105C1CDC / lbl_105C1CD8) that
 * runs while at least one player is started and calls each player's Update.
 * AddFastTimerRef is empty in this build; SubtractFastTimerRef puts the
 * period back to 100 ms.
 */
export class FreshTimer {
  private readonly players: FreshPlayer[] = [];
  private interval: number | null = null;

  /** cFreshTimer::Start */
  start(p: FreshPlayer): void {
    this.players.push(p);
    if (this.players.length === 1) this.interval = window.setInterval(() => this.update(), 100);
  }

  /** cFreshTimer::Stop */
  stop(p: FreshPlayer): void {
    const i = this.players.indexOf(p);
    if (i >= 0) this.players.splice(i, 1);
    if (this.players.length === 0 && this.interval !== null) {
      window.clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** cFreshTimer::Update */
  private update(): void {
    for (const p of [...this.players]) p.update();
  }

  addFastTimerRef(): void {
    // cFreshTimer::AddFastTimerRef: empty body.
  }

  subtractFastTimerRef(): void {
    // Back to the 100 ms period, which never changes here.
  }

  shutdown(): void {
    if (this.interval !== null) window.clearInterval(this.interval);
    this.interval = null;
    this.players.length = 0;
  }
}

/** cFreshPlayer (0x40b0 bytes). */
export class FreshPlayer {
  /** +0x04 */
  private inited = false;
  /** +0x24 player volume (cBoxX passes the options FX volume). */
  vol = 0x400;
  /** +0x2c: the cTSTimer start (performance.now()), null when stopped. */
  private clockStart: number | null = null;
  /** +0x30 */
  score = new FreshScore();
  /** +0x38 */
  private playing = false;
  /** +0x39 */
  private noAdd = false;
  /** +0x3c (word 0xf): beats per minute. */
  private tempo = 0;
  /** +0x40 row, +0x44 column of the selection centre. */
  private ypos = 1;
  private xpos = 1;
  /** +0x50: cells (non-null) in the selection area. */
  private areaCells = 0xf;
  /** +0x54 current beat in the bar, +0x58 next beat count, +0x5c beat count origin. */
  private beat = 0;
  private nextBeat = 1;
  private beatBase = 0;
  /** +0x6c: groups (group 0 counts each cell) in the selection area. */
  private areaGroups = 0;
  /** +0x70 column / +0x74 row selection half-sizes. */
  private selX = 3;
  private selY = 3;
  /** +0x78 / +0x7c last subtracted cell, +0x80 / +0x84 last added. */
  private lastSub = { row: -1, col: -1 };
  private lastAdd = { row: -1, col: -1 };
  /** +0x90: cell players[row][col]. */
  private readonly cellPlayers: FreshCellPlayer[][] = [];
  /** +0x4090 */
  dataDir = "";
  /** +0x4094 */
  private playPercent = 100;
  /** +0x4098 */
  private forceLate = false;
  /** +0x409c */
  private paused = false;

  constructor(readonly timer: FreshTimer) {}

  /**
   * cFreshPlayer::Init(dir, file, timer, cache): cFreshScore::LoadScore(dir + file),
   * then Init(score, dir, ...). Returns false when the score cannot be read.
   */
  async init(dir: string, file: string): Promise<boolean> {
    let text: string;
    try {
      text = new TextDecoder("latin1").decode(await readGameFile(dir + file));
    } catch {
      return false;
    }
    const score = new FreshScore();
    if (!score.load(text)) return false;
    this.score = score;
    this.dataDir = dir;
    this.lastSub = { row: -1, col: -1 };
    this.lastAdd = { row: -1, col: -1 };
    this.vol = score.vol;
    this.xpos = 1;
    this.ypos = 1;
    this.selX = score.selX;
    this.selY = score.selY;
    for (let r = 0; r < score.rows; r++) {
      const row: FreshCellPlayer[] = [];
      for (let c = 0; c < score.cols; c++) row.push(new FreshCellPlayer(this));
      this.cellPlayers.push(row);
    }
    this.areaCells = 0;
    for (let r = 0; r < score.rows; r++) for (let c = 0; c < score.cols; c++) if (this.cellIsInSelectionArea(r, c)) this.areaCells++;
    this.inited = true;
    return true;
  }

  private cp(row: number, col: number): FreshCellPlayer {
    return this.cellPlayers[row]![col]!;
  }

  private cell(row: number, col: number): FreshCell | null {
    return this.score.cells[row]![col]!;
  }

  private elapsed(): number {
    return this.clockStart === null ? 0 : Math.trunc(performance.now() - this.clockStart);
  }

  isPlaying(): boolean {
    return this.playing;
  }

  /** SetPause (+0x409c): Update does nothing while set; playing cells go on. */
  setPause(on: boolean): void {
    this.paused = on;
  }

  /** cFreshPlayer::UpdatePlayerInfo */
  private updatePlayerInfo(): void {
    this.areaCells = 0;
    this.areaGroups = 0;
    const seen = new Uint8Array(32);
    const s = this.score;
    for (let r = Math.max(0, this.ypos - this.selY); r <= Math.min(this.ypos + this.selY, s.rows - 1); r++) {
      for (let c = Math.max(0, this.xpos - this.selX); c <= Math.min(this.xpos + this.selX, s.cols - 1); c++) {
        const cell = this.cell(r, c);
        if (!cell) continue;
        if (cell.group === 0) this.areaGroups++;
        else if (!seen[cell.group & 31]) {
          seen[cell.group & 31] = 1;
          this.areaGroups++;
        }
        this.areaCells++;
      }
    }
  }

  /** cFreshPlayer::SetYPos(0..1000): the selection row. */
  setYPos(v: number): void {
    if (!this.inited) return;
    const n = this.score.rows;
    let y = Math.trunc((v * n) / 1000);
    if (this.score.pri !== 0) {
      const k = this.selY * 2 + 1;
      y = Math.trunc(y / k) * k + this.selY;
    }
    if (y >= n - this.selY) y = n - this.selY - 1;
    if (y < this.selY) y = this.selY;
    if (y > n - 1) y = n - 1;
    if (y < 0) y = 0;
    this.ypos = y;
    this.updatePlayerInfo();
  }

  /** cFreshPlayer::SetXPos(0..1000): the selection column. */
  setXPos(v: number): void {
    if (!this.inited) return;
    const n = this.score.cols;
    let x = Math.trunc((v * n) / 1000);
    if (this.score.pri !== 0) {
      const k = this.selX * 2 + 1;
      x = Math.trunc(x / k) * k + this.selX;
    }
    if (x >= n - this.selX) x = n - this.selX - 1;
    if (x < this.selX) x = this.selX;
    if (x < 0) x = 0;
    if (x >= n) x = n - 1;
    this.xpos = x;
    this.updatePlayerInfo();
  }

  /** cFreshPlayer::SetVolume (SetVolumeNoLock): playing cells follow. */
  setVolume(v: number): void {
    if (!this.inited) return;
    this.vol = v;
    for (const row of this.cellPlayers) for (const p of row) if (p.state === CellState.Playing) p.setVol();
  }

  /** GetMinCellsPlaying */
  private getMinCellsPlaying(): number {
    const s = this.score;
    let n = Math.trunc((s.minCells * this.playPercent) / 100);
    n += Math.trunc((s.difX * (this.xpos + 1)) / (s.cols - 1 || 1));
    n += Math.trunc((s.difY * (this.ypos + 1)) / (s.rows - 1 || 1));
    return Math.min(n, this.areaGroups);
  }

  /** GetMaxCellsPlaying */
  private getMaxCellsPlaying(): number {
    return Math.trunc((this.score.maxCells * this.playPercent) / 100);
  }

  private countCells(test: (p: FreshCellPlayer) => boolean): number {
    let n = 0;
    for (let r = 0; r < this.score.rows; r++) for (let c = 0; c < this.score.cols; c++) if (test(this.cp(r, c))) n++;
    return n;
  }

  /** NumCellsPlaying / NumCellsDying / NumCellsBusy */
  numCellsPlaying(): number {
    return this.countCells((p) => p.state === CellState.Playing);
  }
  private numCellsDying(): number {
    return this.countCells((p) => p.dying);
  }
  numCellsBusy(): number {
    return this.countCells((p) => p.state !== CellState.Idle);
  }

  /** cFreshPlayer::CellIsInSelectionArea */
  private cellIsInSelectionArea(row: number, col: number): boolean {
    return Math.abs(row - this.ypos) <= this.selY && Math.abs(col - this.xpos) <= this.selX;
  }

  /** cFreshPlayer::ProbOfCellStarting: 0 never, 1 by chance, 2 same group, 100 / 101 always. */
  private probOfCellStarting(row: number, col: number, group: number): number {
    const cell = this.cell(row, col);
    const me = this.cp(row, col);
    if (!cell || me.disabled || me.state !== CellState.Idle) return 0;
    if (!this.cellIsInSelectionArea(row, col)) return 0;
    if (row === this.lastSub.row && col === this.lastSub.col) return 0;
    if (cell.group !== 0) {
      for (const r of this.cellPlayers) for (const p of r) if (p.cell && p.cell.group === cell.group && p.state !== CellState.Idle && !p.dying) return 0;
    }
    for (const e of cell.exclusions) {
      if (e.y < this.score.rows && e.x < this.score.cols) {
        const p = this.cp(e.y, e.x);
        if (p.state !== CellState.Idle && !p.dying) return 0;
      }
    }
    cell.prob = Math.max(0, Math.min(0x14, cell.prob));
    if (cell.prob === 0) return 0;
    if (cell.prob === 0x14) return group !== 0 && cell.group === group ? 0x65 : 100;
    if (this.areaCells === 0) this.areaCells = 10;
    if (group !== 0 && cell.group === group) return 2;
    return Math.trunc(PROB_TABLE[cell.prob]! / this.areaCells) <= randOverride() ? 0 : 1;
  }

  /** cFreshPlayer::GetCellToAdd: the most likely cell, scanning the selection from a random cell. */
  private getCellToAdd(group: number): { row: number; col: number } | null {
    const r = randOverride();
    const s = this.score;
    const rowMin0 = this.ypos - this.selY;
    const colMin0 = this.xpos - this.selX;
    const rowMin = Math.max(0, rowMin0);
    const colMin = Math.max(0, colMin0);
    const rowMax = Math.min(this.ypos + this.selY, s.rows - 1);
    const colMax = Math.min(this.xpos + this.selX, s.cols - 1);
    let rowStart = (((r >> 8) & 0xff) % (this.selY * 2 + 1)) + rowMin0;
    let colStart = ((r & 0xff) % (this.selX * 2 + 1)) + colMin0;
    rowStart = Math.min(Math.max(rowStart, 0), s.rows - 1);
    colStart = Math.min(Math.max(colStart, 0), s.cols - 1);
    let best = 0;
    let out: { row: number; col: number } | null = null;
    const test = (row: number, col: number): void => {
      const p = this.probOfCellStarting(row, col, group);
      if (best < p) {
        best = p;
        out = { row, col };
      }
    };
    const scanRow = (row: number): void => {
      for (let c = colStart; c <= colMax; c++) test(row, c);
      for (let c = colMin; c < colStart; c++) test(row, c);
    };
    for (let row = rowStart; row <= rowMax; row++) scanRow(row);
    for (let row = rowMin; row < rowStart; row++) scanRow(row);
    return best !== 0 ? out : null;
  }

  /**
   * cFreshPlayer::GetCellToSubtract: a playing cell outside the selection
   * (from a random cell), else a random non-permanent playing cell inside it
   * (the original draws that one with the player's cRZRandom).
   */
  private getCellToSubtract(): { row: number; col: number } | null {
    const r = randOverride();
    const s = this.score;
    const rowStart = ((r >> 8) & 0xff) % s.rows;
    const colStart = (r & 0xff) % s.cols;
    const outside = (row: number, col: number): boolean => {
      const p = this.cp(row, col);
      return p.state === CellState.Playing && !this.cellIsInSelectionArea(row, col) && !p.dying;
    };
    const scanRow = (row: number): { row: number; col: number } | null => {
      for (let c = colStart; c < s.cols; c++) if (outside(row, c)) return { row, col: c };
      for (let c = 0; c < colStart; c++) if (outside(row, c)) return { row, col: c };
      return null;
    };
    for (let row = rowStart; row < s.rows; row++) {
      const f = scanRow(row);
      if (f) return f;
    }
    for (let row = 0; row < rowStart; row++) {
      const f = scanRow(row);
      if (f) return f;
    }
    const found: Array<{ row: number; col: number }> = [];
    for (let row = Math.max(0, this.ypos - this.selY); row <= Math.min(this.ypos + this.selY, s.rows - 1); row++) {
      for (let col = Math.max(0, this.xpos - this.selX); col <= Math.min(this.xpos + this.selX, s.cols - 1); col++) {
        const p = this.cp(row, col);
        if (p.state === CellState.Playing && p.cell?.prob !== 0x14 && !p.dying) found.push({ row, col });
      }
    }
    return found.length ? found[randOverride() % found.length]! : null;
  }

  private startCell(at: { row: number; col: number }): void {
    const cell = this.cell(at.row, at.col);
    if (cell) this.cp(at.row, at.col).start(cell);
    this.lastAdd = at;
  }

  /** cFreshPlayer::Update (cFreshTimer, every 100 ms): one beat when it is due. */
  update(): void {
    const min = this.getMinCellsPlaying();
    const max = this.getMaxCellsPlaying();
    if (!this.inited || !this.playing || this.paused) return;
    const s = this.score;
    const now = this.elapsed();
    const due = this.tempo === 0 ? Infinity : Math.trunc(((this.nextBeat - this.beatBase) * 60000) / this.tempo);
    if (due > now) return;
    if (now > 86400000) {
      this.beatBase = this.beat = this.nextBeat = s.bpb;
      this.clockStart = performance.now();
      return;
    }
    const late = now - due;
    let group = 0;
    let groupProb = 0;
    const barEnd = this.beat === s.bpb - 1 || this.beat === s.bpb - 6;
    if (barEnd && s.pri !== 0 && !this.noAdd && min <= this.numCellsPlaying()) {
      const sub = this.getCellToSubtract();
      if (sub) {
        const p = this.cp(sub.row, sub.col);
        p.dying = true;
        group = p.cell?.group ?? 0;
        if (group !== 0) groupProb = p.cell?.prob ?? 0;
      }
    }
    const busy = this.numCellsBusy() - this.numCellsDying();
    if (barEnd && !this.noAdd && busy < max && this.playPercent !== 0) {
      let at = this.getCellToAdd(group);
      if (!at && group !== 0 && groupProb === 0x13) at = this.getCellToAdd(group);
      if (!at && group !== 0 && groupProb === 0x13) at = this.getCellToAdd(group);
      if (!at && busy < min) at = this.getCellToAdd(group);
      if (at) this.startCell(at);
      if (busy < max) {
        at = this.getCellToAdd(0);
        if (!at && busy < min) at = this.getCellToAdd(0);
        if (at) this.startCell(at);
      }
    }
    const isLate = this.forceLate || late > 7;
    for (let r = 0; r < s.rows; r++) for (let c = 0; c < s.cols; c++) this.cp(r, c).update(isLate, this.beat);
    this.beat++;
    if (this.beat > s.bpb) this.beat = 1;
    this.nextBeat++;
  }

  /** cFreshPlayer::Play */
  play(): void {
    if (!this.inited || this.playing) return;
    this.noAdd = false;
    this.tempo = this.score.tempo;
    this.beatBase = this.score.bpb > 2 ? this.score.bpb - 1 : this.score.bpb;
    this.beat = this.nextBeat = this.beatBase;
    this.updatePlayerInfo();
    this.clockStart = performance.now();
    this.setXPos(this.score.startX);
    this.setYPos(this.score.startY);
    this.timer.start(this);
    this.playing = true;
  }

  /** cFreshPlayer::Stop (StopNoLock): every cell stops. */
  stop(): void {
    if (!this.inited || !this.playing) return;
    this.timer.stop(this);
    this.clockStart = null;
    for (const row of this.cellPlayers) for (const p of row) if (p.state !== CellState.Idle) p.stop();
    this.playing = false;
  }

  /** cFreshPlayer::Shutdown */
  shutdown(): void {
    for (const row of this.cellPlayers) for (const p of row) p.kill();
    this.stop();
    this.inited = false;
  }

  /** Dev view: selection centre and the cells sounding. */
  debugState(): { x: number; y: number; playing: boolean; paused: boolean; cells: string[] } {
    const cells: string[] = [];
    for (let r = 0; r < this.score.rows; r++) {
      for (let c = 0; c < this.score.cols; c++) {
        const p = this.cp(r, c);
        if (p.state !== CellState.Idle && p.cell) cells.push(`${r},${c}:${p.cell.name}:${p.state}`);
      }
    }
    return { x: this.xpos, y: this.ypos, playing: this.playing, paused: this.paused, cells };
  }
}
