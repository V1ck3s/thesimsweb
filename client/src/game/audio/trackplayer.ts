/**
 * cTrackPlayer (the HIT bytecode interpreter) and cTrack (a track defined in
 * a .hot file; in the game cTrack derives from cTrackPlayer, so each track
 * is a single playing instance and playing it again restarts it).
 *
 * Ported from the Mac build: cTrackPlayer::DoCommand (jump table at
 * 0x10618514, 0x54 opcodes, names from SimsSound.hsm and the TRACK ERROR
 * strings), PlayPause, Stop, Kill, SetLocalRegister, UpdateVolPan,
 * HandleTimerCallback, SetPatch.
 *
 * Execution model (HandleTimerCallback): on every engine tick the player runs
 * DoCommand while `nextTime` (+0x198) is due. Instructions leave it alone;
 * `wait` pushes it forward, the polling waits (`wait_samp`, `waitXX`,
 * sequence-group fades) re-run themselves 2 ticks later, Kill sets it to 0.
 * Every register write sets the comparison flags (SetLocalRegister), and
 * jump / call / if targets are label ids looked up in cHitMan.
 */

import type { HitCode, HotTrack } from "./hitdata.js";
import { HitList, randomUniform, type HitMan } from "./hitman.js";
import { GLOBAL_FIRST, PATCH_ATTR_DEFAULTS, R, TRACK_DEFAULTS } from "./registers.js";
import { CLASS_TRACK, SamplePatch, SoundObject, type SampleChannel } from "./samplepatch.js";

const ARGS_VOLPAN = 1;
const ARGS_IDVOLPAN = 2;

export class TrackPlayer extends SoundObject {
  private code: HitCode | null = null;
  private pc = 0;
  private instrPc = 0;
  private loopPc = 0;
  private readonly callStack: number[] = [];
  /** +0x198: tick of the next DoCommand, 0 when idle. */
  private nextTime = 0;
  /** +0x194: tick at which a timed `note` stops. */
  private noteStopTime = 0;
  /** +0x1dc: started by PlayPause. */
  private active = false;
  /** +0x1e0 */
  private pausedFlag = false;
  /** +0x1e7: Stop() is fading the track out. */
  private stopping = false;
  private zero = false;
  private gt = false;
  private lt = false;
  /** +0xc8 (register 0x35 "target"): register reads/writes go to this object. */
  private target: SoundObject | null = null;
  private patchObj: SamplePatch | null = null;
  private channel: SampleChannel | null = null;
  private readonly localHitList = new HitList();
  private hitList: HitList = this.localHitList;
  private chained = 0;
  /** Track definition registers (cTrack's own set: vol, duckpri, patch, Spl). */
  protected readonly defs = new Map<number, number>();

  constructor(
    protected readonly hm: HitMan,
    readonly def: HotTrack,
  ) {
    super(def.id, CLASS_TRACK);
  }

  trackId(): number {
    return this.def.id;
  }

  isActive(): boolean {
    return this.active;
  }

  currentPatch(): SamplePatch | null {
    return this.patchObj;
  }

  channelPlaying(): boolean {
    return this.channel?.isPlaying() ?? false;
  }

  // ---- registers ------------------------------------------------------------

  /** cTrackPlayer::RegisterVal: through the target unless reading `target`. */
  override registerVal(r: number): number {
    const t = this.target;
    if (t && t !== this && r !== R.target) return t.registerVal(r);
    return this.localRegisterVal(r);
  }

  /** cTrackPlayer::LocalRegisterVal (player set -> track definition -> defaults). */
  localRegisterVal(r: number): number {
    if (r >= GLOBAL_FIRST) return this.hm.globalReg(r);
    return this.regs.get(r) ?? this.defs.get(r) ?? TRACK_DEFAULTS.get(r) ?? PATCH_ATTR_DEFAULTS.get(r) ?? 0;
  }

  /** cTrackPlayer::SetRegister */
  override setRegister(r: number, v: number): boolean {
    const t = this.target;
    if (t && t !== this && r !== R.target) return t.setRegister(r, v);
    return this.setLocalRegister(r, v);
  }

  /** cTrackPlayer::SetLocalRegister: store, set the flags, apply side effects. */
  setLocalRegister(r: number, v: number): boolean {
    v |= 0;
    this.zero = v === 0;
    this.gt = v > 0;
    this.lt = v < 0;
    if (r === R.main_duckpri) {
      this.hm.duckMapSetSndobPri(this, v);
      return true;
    }
    if (r >= GLOBAL_FIRST) this.hm.setRegister(r, v);
    else this.regs.set(r, v);
    switch (r) {
      case R.priority:
      case R.vol:
      case R.extvol:
      case R.pan:
      case R.IsHeadRelative:
      case 0x38:
      case 0x39:
        this.updateVolPan();
        break;
      case R.pitch:
        this.updatePitch();
        break;
      case R.fade_on:
        // Fading is only meaningful while the track plays.
        if (!this.active) this.regs.set(R.fade_on, 0);
        break;
      case R.patch:
        if (!this.setPatch(this.localRegisterVal(R.patch))) return false;
        this.updateVolPan();
        this.updatePitch();
        break;
      case R.target:
        this.target = v ? this.hm.soundObject(v) : this;
        break;
      default:
        break;
    }
    return true;
  }

  // ---- channel ----------------------------------------------------------------

  /** cTrackPlayer::SetPatch: drop the channel, take the patch's new one. */
  setPatch(id: number): boolean {
    if (this.channel) {
      this.channel.release();
      this.channel = null;
    }
    this.patchObj?.release();
    this.patchObj = null;
    this.regs.set(R.patch, id);
    if (id === 0) return true;
    const obj = this.hm.soundObject(id);
    if (!(obj instanceof SamplePatch)) {
      this.hm.error(this.def.name, `patch ${id} is not a sample patch`);
      return false;
    }
    this.patchObj = obj;
    obj.addRef();
    this.channel = obj.createChannel();
    this.updateVolPan();
    this.updatePitch();
    this.setRegister(R.Is3d, obj.registerVal(R.Is3d));
    return true;
  }

  /** cTrackPlayer::UpdateVolPan */
  updateVolPan(): void {
    const ch = this.channel;
    if (!ch) return;
    let vol = this.registerVal(R.extvol);
    const base = this.registerVal(R.vol);
    const group = this.hm.controlGroup(this.def.controlGroup);
    if (group && group.volume !== 0x400) vol = Math.trunc((vol * group.volume) / 1024);
    vol = Math.trunc((vol * base) / 1024);
    const duck = this.registerVal(R.main_duckpri);
    if (duck !== 0 && this.registerVal(R.duckpri) < duck) vol = Math.trunc(vol / 2);
    ch.setVolume(vol);
    ch.setPan(this.localRegisterVal(R.pan));
  }

  private updatePitch(): void {
    if (!this.channel || !this.patchObj) return;
    this.channel.setPitch(this.localRegisterVal(R.pitch) + this.patchObj.registerVal(R.pitch) - 0xe10);
  }

  private playNote(): void {
    if (!this.channel) return this.hm.error(this.def.name, "Attempt to play note with no channel");
    if (!this.patchObj) return this.hm.error(this.def.name, "Attempt to play note with no patch");
    this.channel.setLooped(this.registerVal(R.IsLooped) !== 0 || this.patchObj.registerVal(R.IsLooped) !== 0);
    this.channel.play();
    // cTrackPlayer::DoCommand note / note_on: only a streamed patch (register
    // 0x26) gets UpdateVolPan and SetPitch again after cSampleChannel::NoteOn.
    // Others keep what SetPatch set, so a pitch written before the first Play
    // (the TV stations' 2400) never reaches the not yet loaded sound.
    if (this.patchObj.registerVal(R.IsStreamed) !== 0) {
      this.updateVolPan();
      this.updatePitch();
    }
  }

  /** cTrackPlayer::ChainPatch: play `id` now, or right after the current sample. */
  private chainPatch(id: number): boolean {
    if (this.channel?.isPlaying()) {
      this.chained = id;
      return true;
    }
    if (!this.setRegister(R.patch, id)) return false;
    this.playNote();
    return true;
  }

  // ---- control ------------------------------------------------------------------

  /** cTrackPlayer::Play = PlayPause + Unpause. */
  play(a1 = 0, a2 = 0, a3 = 0): void {
    this.playPause(a1, a2, a3);
    this.unpause();
  }

  /** cTrackPlayer::PlayPause: (re)start the track paused at its entry point. */
  playPause(a1: number, a2: number, a3: number): void {
    const group = this.hm.controlGroup(this.def.controlGroup);
    if (group && group.volume === 0) return;
    this.regs.set(R.fade_on, 0);
    this.stopping = false;
    this.target = this;
    this.setRegister(R.arg1, a1);
    this.setRegister(R.arg2, a2);
    this.setRegister(R.arg3, a3);
    if (this.active && this.pausedFlag) {
      this.pausedFlag = true;
      return;
    }
    this.pausedFlag = false;
    // A playing track restarts only when its `interrupt` register allows it.
    if (this.active && this.registerVal(R.interrupt) === 0) return;
    for (const r of [...this.regs.keys()]) if (r >= 0x11) this.regs.delete(r);
    if (this.def.argsType === ARGS_IDVOLPAN) {
      this.regs.set(R.extvol, a2);
      this.regs.set(R.pan, a3);
    } else if (this.def.argsType === ARGS_VOLPAN) {
      this.regs.set(R.extvol, a1);
      this.regs.set(R.pan, a2);
    }
    this.setPatch(this.defs.get(R.patch) ?? 0);
    const entry = this.hm.trackDataAddr(this.def.trackData);
    if (!entry) {
      this.hm.error(this.def.name, `no track data ${this.def.trackData}`);
      return;
    }
    this.code = entry.code;
    this.pc = entry.addr;
    this.loopPc = entry.addr;
    this.callStack.length = 0;
    this.localHitList.removeAll();
    this.hitList = this.localHitList;
    this.nextTime = this.hm.time;
    this.noteStopTime = 0;
    this.setLocalRegister(R.isplaying, 1);
    this.active = true;
    this.pause();
  }

  /** cTrackPlayer::Pause */
  pause(): void {
    this.pausedFlag = true;
    if (!this.active) return;
    this.channel?.pause();
    this.hm.removeFromUpdateList(this);
  }

  /** cTrackPlayer::Unpause */
  unpause(): void {
    this.pausedFlag = false;
    if (!this.active) return;
    this.channel?.unpause();
    this.nextTime = this.hm.time;
    this.hm.addToUpdateList(this);
  }

  /** cTrackPlayer::Stop: fade a sounding track out, kill a silent one. */
  stop(): void {
    if (!this.active) return;
    if (this.channel?.isPlaying()) {
      this.setRegister(R.fade_dest, 0);
      this.setRegister(R.fade_var, R.extvol);
      this.setRegister(R.fade_speed, 100);
      this.stopping = true;
      this.setRegister(R.fade_on, 1);
    } else {
      this.kill();
    }
  }

  /** cTrackPlayer::Kill */
  kill(): void {
    this.active = false;
    this.channel?.stop();
    this.setPatch(0);
    this.regs.set(R.fade_on, 0);
    this.stopping = false;
    this.setLocalRegister(R.isplaying, 0);
    this.target = null;
    const entry = this.hm.trackDataAddr(this.def.trackData);
    this.pc = entry?.addr ?? 0;
    this.nextTime = 0;
    this.chained = 0;
    this.hm.removeFromUpdateList(this);
    this.callStack.length = 0;
    this.hm.duckMapSetSndobPri(this, 0);
  }

  /** cTrackPlayer::CancelNote */
  cancelNote(): void {
    if (this.channel?.isPlaying()) this.channel.stop();
  }

  /** cTrackPlayer::HandleTimerCallback: fades, then the due commands. */
  handleTimerCallback(): void {
    if (!this.active || this.pausedFlag) return;
    if (this.localRegisterVal(R.fade_on) !== 0) {
      const varReg = this.localRegisterVal(R.fade_var);
      let v = this.registerVal(varReg);
      let speed = this.localRegisterVal(R.fade_speed);
      const dest = this.localRegisterVal(R.fade_dest);
      if (speed === 0) this.regs.set(R.fade_on, 0);
      if (speed > 0 !== dest > v) speed = -speed;
      v += speed;
      if ((speed > 0 && v > dest) || (speed < 0 && v < dest)) {
        this.regs.set(R.fade_on, 0);
        v = dest;
      }
      this.setRegister(varReg, v);
    }
    if (this.stopping && this.localRegisterVal(R.fade_on) === 0) {
      this.kill();
      return;
    }
    const now = this.hm.time;
    let guard = 0;
    // A stopping track only fades (the game keeps stepping, which would run
    // past `end` into the next track's code).
    while (!this.stopping && this.nextTime !== 0 && this.nextTime <= now) {
      this.doCommand();
      if (++guard > 100) {
        this.hm.error(this.def.name, "too many commands in one tick");
        break;
      }
    }
    if (this.noteStopTime !== 0 && this.noteStopTime <= now) {
      this.channel?.stop();
      this.noteStopTime = 0;
    }
    if (this.chained && this.channel && !this.channel.isPlaying()) {
      const id = this.chained;
      this.chained = 0;
      this.chainPatch(id);
    }
  }

  // ---- interpreter ------------------------------------------------------------

  private byte(): number {
    return this.code!.bytes[this.pc++] ?? 0;
  }

  /** cTrackPlayer::ReadLongVal (little-endian). */
  private long(): number {
    const b = this.code!.bytes;
    const v = (b[this.pc] ?? 0) | ((b[this.pc + 1] ?? 0) << 8) | ((b[this.pc + 2] ?? 0) << 16) | ((b[this.pc + 3] ?? 0) << 24);
    this.pc += 4;
    return v;
  }

  /** ReadByteVal + CheckedRegId */
  private reg(): number {
    const r = this.byte();
    if (r > 0x7f) {
      this.hm.error(this.def.name, `bad register ${r}`);
      return 1;
    }
    return r;
  }

  private jumpTo(label: number): void {
    const t = this.hm.trackDataAddr(label);
    if (!t) {
      this.hm.error(this.def.name, `unknown label ${label}`);
      this.kill();
      return;
    }
    this.code = t.code;
    this.pc = t.addr;
  }

  /** Re-run the current instruction 2 ticks from now (the polling waits). */
  private retry(): void {
    this.pc = this.instrPc;
    this.nextTime = this.hm.time + 2;
  }

  private set(r: number, v: number): void {
    if (!this.setRegister(r, v)) this.hm.error(this.def.name, "Could not set register");
  }

  /** cTrackPlayer::DoCommand: one instruction. */
  private doCommand(): void {
    if (!this.code) {
      this.kill();
      return;
    }
    this.instrPc = this.pc;
    const op = this.byte();
    const val = (r: number): number => this.registerVal(r);
    switch (op) {
      case 0x01: {
        // note: play, stop after the given number of ticks
        this.reg(); // note number (unused by sample channels)
        const dur = val(this.reg());
        this.noteStopTime = this.hm.time + dur;
        this.playNote();
        break;
      }
      case 0x02: // note_on
        this.byte();
        this.playNote();
        break;
      case 0x03: // note_off
        this.byte();
        this.channel?.stop();
        break;
      case 0x04: {
        // loadb
        const d = this.reg();
        const b = this.byte();
        if (d === 0) this.hm.error(this.def.name, "kTrackCmdLoadb");
        else this.set(d, b);
        break;
      }
      case 0x05: {
        // loadl
        const d = this.reg();
        const l = this.long();
        if (d === 0) this.hm.error(this.def.name, "kTrackCmdLoadl");
        else this.set(d, l);
        break;
      }
      case 0x06: {
        // set
        const d = this.reg();
        const s = this.reg();
        this.set(d, val(s));
        break;
      }
      case 0x07: {
        // call
        const label = this.long();
        this.callStack.push(this.pc);
        this.jumpTo(label);
        break;
      }
      case 0x08: // return
      case 0x0c: // end
        if (this.callStack.length > 0) this.pc = this.callStack.pop()!;
        else this.stop();
        break;
      case 0x09: // wait
        this.nextTime = this.hm.time + val(this.reg());
        break;
      case 0x0b: // wait_samp
        if (this.channel?.isPlaying()) {
          this.pc = this.instrPc;
          this.nextTime = this.hm.time + 2;
        }
        break;
      case 0x0d: // jump
        this.jumpTo(this.long());
        break;
      case 0x0e: {
        // test
        const v = val(this.reg());
        this.zero = v === 0;
        this.gt = v > 0;
        this.lt = v < 0;
        break;
      }
      case 0x10:
      case 0x11:
      case 0x12:
      case 0x13:
      case 0x15:
      case 0x16:
      case 0x28:
      case 0x29:
      case 0x2a:
      case 0x2b:
      case 0x2c: {
        const d = this.reg();
        const s = this.reg();
        const a = val(d);
        const b = val(s);
        let r = 0;
        if (op === 0x10) r = a + b;
        else if (op === 0x11) r = a - b;
        else if (op === 0x12) r = b === 0 ? 0 : Math.trunc(a / b);
        else if (op === 0x13) r = Math.imul(a, b);
        else if (op === 0x15) r = a < b ? 1 : 0;
        else if (op === 0x16) r = a > b ? 1 : 0;
        else if (op === 0x28) r = a & b;
        else if (op === 0x29) r = ~(a & b);
        else if (op === 0x2a) r = a | b;
        else if (op === 0x2b) r = ~(a | b);
        else r = a ^ b;
        this.set(d, r);
        break;
      }
      case 0x14: {
        // cmp
        const a = val(this.reg());
        const b = val(this.reg());
        this.zero = a === b;
        this.gt = a > b;
        this.lt = a < b;
        break;
      }
      case 0x17: {
        // not
        const d = this.reg();
        this.set(d, val(d) === 0 ? 1 : 0);
        break;
      }
      case 0x18: {
        // rand dest min max: min + [0, max - min)
        const d = this.reg();
        const lo = val(this.reg());
        const hi = val(this.reg());
        this.set(d, lo + randomUniform(hi - lo));
        break;
      }
      case 0x19: {
        // abs
        const d = this.reg();
        this.set(d, Math.abs(val(d)));
        break;
      }
      case 0x1b: // error
        this.stop();
        break;
      case 0x1c: // assert
        if (val(this.reg()) === 0) this.stop();
        break;
      case 0x1f: {
        // get_var: dest = reg[reg[src]]
        const d = this.reg();
        const s = this.reg();
        this.set(d, val(val(s) & 0x7f));
        break;
      }
      case 0x20: // loop
        this.pc = this.loopPc;
        break;
      case 0x21: // set_loop
        this.loopPc = this.pc;
        break;
      case 0x22: // callback (no-op in the shipping build)
        this.reg();
        this.reg();
        break;
      case 0x23: // smart_add
        this.hitList.add(val(this.reg()));
        break;
      case 0x24: // smart_remove
        this.hitList.remove(val(this.reg()));
        break;
      case 0x25: // smart_removeall
        this.hitList.removeAll();
        break;
      case 0x26: // smart_setcrit
        this.hitList.setCrit(val(this.reg()));
        break;
      case 0x27: {
        // smart_choose
        const d = this.reg();
        if (this.hitList.size() === 0) this.hm.error(this.def.name, "Attempt to choose from empty track list");
        else this.set(d, this.hitList.choose());
        break;
      }
      case 0x2d:
      case 0x2e: {
        // 0x2d caps a register at a maximum (min), 0x2e at a minimum (max)
        const d = this.reg();
        const l = this.long();
        const v = val(d);
        this.set(d, op === 0x2d ? Math.min(v, l) : Math.max(v, l));
        break;
      }
      case 0x2f: {
        const d = this.reg();
        this.set(d, val(d) + 1);
        break;
      }
      case 0x30: {
        const d = this.reg();
        this.set(d, val(d) - 1);
        break;
      }
      case 0x31: // printreg
        this.reg();
        break;
      case 0x32: {
        // play_trk: with this player's own arg1..arg3
        const obj = this.hm.soundObject(val(this.reg()));
        if (obj instanceof TrackPlayer) {
          obj.play(this.localRegisterVal(R.arg1), this.localRegisterVal(R.arg2), this.localRegisterVal(R.arg3));
          obj.setRegister(R.source, this.registerVal(R.source));
        } else this.hm.error(this.def.name, "kTrackCmdPlayTrack Src");
        break;
      }
      case 0x33: {
        // kill_trk
        const obj = this.hm.soundObject(val(this.reg()));
        if (obj instanceof TrackPlayer) obj.kill();
        break;
      }
      case 0x3e:
      case 0x3f:
      case 0x40:
      case 0x41:
      case 0x42:
      case 0x43: {
        const label = this.long();
        const take =
          op === 0x3e
            ? this.zero
            : op === 0x3f
              ? !this.zero
              : op === 0x40
                ? this.gt && !this.zero
                : op === 0x41
                  ? this.lt && !this.zero
                  : op === 0x42
                    ? this.gt || this.zero
                    : this.lt || this.zero;
        if (take) this.jumpTo(label);
        break;
      }
      case 0x44: {
        // smart_setlist
        const id = val(this.reg());
        const list = id === 0 ? this.localHitList : this.hm.globalHitList(id);
        if (list) this.hitList = list;
        else this.hm.error(this.def.name, `Undefined Hit List ${id}`);
        break;
      }
      case 0x45: // seqgroup_kill
        this.seqGroup(val(this.reg()), true);
        break;
      case 0x47: // seqgroup_return
        this.seqGroup(val(this.reg()), false);
        break;
      case 0x48: {
        // getsrcdatafield dest source field
        const d = this.reg();
        const src = val(this.reg());
        const field = val(this.reg());
        const v = this.hm.sourceDataHandler?.(src, field) ?? null;
        if (v === null) this.hm.error(this.def.name, "Illegal source parameter request");
        else this.set(d, v);
        break;
      }
      case 0x49: {
        // seqgroup_trkid
        const d = this.reg();
        this.set(d, this.hm.seqGroups.get(val(this.reg())) ?? 0);
        break;
      }
      case 0x4a: {
        // setll
        const d = this.reg();
        this.setLocalRegister(d, this.localRegisterVal(this.reg()));
        break;
      }
      case 0x4b: {
        // setlt
        const d = this.reg();
        this.set(d, this.localRegisterVal(this.reg()));
        break;
      }
      case 0x4c: {
        // settl
        const d = this.reg();
        this.setLocalRegister(d, val(this.reg()));
        break;
      }
      case 0x4d:
      case 0x4e:
      case 0x4f:
      case 0x50:
      case 0x51:
      case 0x52: {
        // waiteq/ne/gt/lt/ge/le a b: poll until the condition holds
        const a = val(this.reg());
        const b = val(this.reg());
        const ok =
          op === 0x4d ? a === b : op === 0x4e ? a !== b : op === 0x4f ? a > b : op === 0x50 ? a < b : op === 0x51 ? a >= b : a <= b;
        if (!ok) this.retry();
        break;
      }
      case 0x53: // chain_patch
        if (!this.chainPatch(val(this.reg()))) this.hm.error(this.def.name, "Could not chain patch");
        break;
      case 0x0f: // nop
      case 0x1d: // add_to_group
      case 0x1e: // remove_from_group
      case 0x46: // seqgroup_wait
      case 0x3a: // test1..4: debug tones
      case 0x3b:
      case 0x3c:
      case 0x3d:
        break;
      default:
        this.hm.error(this.def.name, `Illegal Instruction 0x${op.toString(16)} at 0x${this.instrPc.toString(16)}`);
        this.kill();
        break;
    }
  }

  /**
   * kTrackCmdSeqGroupKill / Return: take over sequence group `g`. The previous
   * owner is killed (return) or faded out at speed 200 while this instruction
   * polls (kill); a silent owner is killed outright.
   */
  private seqGroup(g: number, fade: boolean): void {
    if (g > 0x800) return;
    const prev = this.hm.seqGroups.get(g) ?? 0;
    const cur = this.def.id;
    if (prev !== 0 && prev !== cur) {
      const obj = this.hm.soundObject(prev);
      if (obj instanceof TrackPlayer) {
        if (!fade) obj.kill();
        else if (obj.registerVal(R.extvol) === 0) obj.kill();
        else {
          if (!(obj.registerVal(R.fade_on) !== 0 && obj.registerVal(R.fade_var) === R.extvol)) {
            obj.setRegister(R.fade_speed, 200);
            obj.setRegister(R.fade_var, R.extvol);
            obj.setRegister(R.fade_on, 1);
          }
          this.retry();
        }
      }
    }
    this.hm.seqGroups.set(g, cur);
  }
}

/** cTrack: a [Track] entry of a .hot file. */
export class Track extends TrackPlayer {
  constructor(hm: HitMan, def: HotTrack) {
    super(hm, def);
    this.defs.set(R.duckpri, def.duckPri);
    this.defs.set(R.vol, def.volume);
    this.defs.set(R.patch, def.patch);
    this.defs.set(R.Spl, def.spl);
    hm.controlGroup(def.controlGroup)?.tracks.add(def.id);
  }
}
