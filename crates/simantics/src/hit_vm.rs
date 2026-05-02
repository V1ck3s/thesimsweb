//! Interpreter for HIT (Hit Item Table) audio bytecode.
//!
//! The VM is a small stack-and-register machine. It does not handle audio output,
//! timing, or the actual sound bus — instead it produces [`HitEffect`] values when
//! it hits an instruction the engine cannot resolve internally (notes, tracks,
//! waits, hitlist picks). The host (Web Audio routing, scheduler) consumes them.
//!
//! Variable layout (Niotso §4):
//! - `0x00..=0x04` arg0..arg4 (track arguments)
//! - `0x05..=0x0C` v1..v8 (track registers)
//! - `0x0D..=0x10` h1..h4 (track h-registers)
//! - `0x11..=0x42` Sims 1 track-variable aliases (priority, vol, …)
//! - `0x64+`       global variables
//! - `0x2000+`     object variables (need a `getsrcdatafield`/`setsrcdatafield`
//!                  pair against an explicit source ID)
//!
//! The Niotso heuristic for `jump 0x0D` (variable form vs absolute address) lives
//! in the disassembler in `lib.rs`; here we just reuse the decoder by tracking the
//! current `pc` cursor.

use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;

use crate::Hit;

/// Maximum value a track variable byte can hold; everything ≥ this address is
/// interpreted as a 4-byte global ID by the wide opcodes (`setlg`, `setgl`).
const TRACK_VAR_LIMIT: usize = 0x80;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HitVmError {
    /// Program counter ran past the end of the code section.
    PcOutOfRange { pc: u32, code_len: u32 },
    /// Truncated operand for the current opcode.
    TruncatedInstr { pc: u32, opcode: u8 },
    /// `return` underflowed the call stack with no implicit "kill thread" handling
    /// done (used internally; not actually surfaced — `return` from top frame ends).
    StackUnderflow,
    /// Step budget reached before a yield/return/end.
    BudgetExhausted { steps: u32 },
    /// Unknown opcode — we don't try to recover.
    UnknownOpcode { pc: u32, opcode: u8 },
    /// `jump` heuristic could not pick between variable and address form.
    AmbiguousJump { pc: u32 },
    /// Address used by a control-flow instruction is outside the code section.
    /// `target` is the absolute byte offset relative to the start of the file
    /// (i.e. it includes the 16-byte HIT header), which is the convention used by
    /// `call`, `jump` and the `if*` instructions.
    ///
    /// Real-world TS1 HIT files (notably `simssound.HIT`) emit `ifeq #N` with
    /// `N < 16`, which Niotso documents as illegal. The VM treats these as
    /// "branch not taken" instead of erroring out — we keep this variant for
    /// the unconditional control-flow opcodes (`call`, `jump`) where lenience
    /// would silently corrupt execution.
    BadJumpTarget { pc: u32, target: u32 },
}

/// One trace entry — useful for diffing against FreeSO/MakeTrax output.
#[derive(Debug, Clone)]
pub struct HitTraceEntry {
    pub pc: u32,
    pub opcode: u8,
    /// `(mnemonic, args)` reused from the disassembler for readability.
    pub mnemonic: &'static str,
    pub args: String,
    /// State of the flags after the instruction executed.
    pub zero: bool,
    pub sign: bool,
}

/// Effect surfaced when the VM hits an opcode the host should react to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HitEffect {
    /// `note_on src` — play the note with the value currently in `src`.
    PlayNote { note_id: i32 },
    /// `note_on_loop src` — play and immediately loop indefinitely.
    PlayNoteLoop { note_id: i32 },
    /// `note_off src` — stop the note in `src`.
    StopNote { note_id: i32 },
    /// `wait src` — yield for `ms` milliseconds.
    Wait { ms: i32 },
    /// `wait_samp` — yield until the previously selected note finishes.
    WaitSamp,
    /// `play_trk src` — fire `kSndobPlay` for the track ID held in `src`.
    PlayTrack { track_id: i32 },
    /// `kill_trk src` — fire `kSndobKill`.
    KillTrack { track_id: i32 },
    /// `stop_trk src` — fire `kSndobStop`.
    StopTrack { track_id: i32 },
    /// `seqgroup_kill group` — kill all sounds in the sequence group.
    SeqGroupKill { group: i32 },
    /// `duck` (engine-side ducking lever).
    Duck,
    /// `unduck`.
    Unduck,
    /// `smart_choose dest` — picked an entry from the current hitlist.
    /// `picked` is whatever the host chose (we record what we wrote).
    SmartChoose { dest_var: u8, hitlist: u32, picked: i32 },
    /// `waiteq`/`waitne` family — yield until two variables satisfy a predicate.
    WaitVarCmp { kind: WaitKind, var1: u8, var2: u8 },
    /// `seqgroup_return group` — semantics unknown per Niotso.
    SeqGroupReturn { group: i32 },
    /// `seqgroup_trkid #a #b` — semantics unknown per Niotso.
    SeqGroupTrkId { a: u8, b: u8 },
    /// `setll dest src` / `setlt dest src` — equivalent to `set` per Niotso, but
    /// we surface them so the host can attach extra semantics if it ever turns
    /// out they differ.
    SetLowLow { dest_var: u8, value: i32 },
    SetLowTime { dest_var: u8, value: i32 },
    /// `end` — thread killed explicitly.
    End,
    /// Top-level `return` (call stack empty) — also kills the thread.
    Return,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitKind {
    Eq,
    Ne,
    Gt,
    Lt,
    Ge,
    Le,
}

/// Hostable interface for the parts the VM cannot decide internally: random
/// numbers, hitlist picks, object data fields. The default implementation is
/// deterministic (xorshift RNG) and returns 0 for every external lookup, which
/// is enough for tests.
pub trait HitHost {
    /// Random number in `[low, high]` inclusive.
    fn rand(&mut self, low: i32, high: i32) -> i32;
    /// Pick an entry from the hitlist. Returning 0 is a safe default.
    fn smart_choose(&mut self, hitlist: u32) -> i32;
    /// Pick the n-th entry from the hitlist.
    fn smart_index(&mut self, hitlist: u32, index: i32) -> i32;
    /// Read an object data field. Returning 0 keeps the VM moving.
    fn read_object_field(&mut self, source: i32, field: u32) -> i32;
    /// Write an object data field. Default: no-op.
    fn write_object_field(&mut self, source: i32, field: u32, value: i32);
}

/// Default deterministic host: xorshift RNG, 0 for everything else. Useful for
/// unit tests and "static analysis" runs of the VM.
#[derive(Debug, Clone, Copy)]
pub struct DefaultHost {
    pub rng_state: u64,
}

impl DefaultHost {
    #[must_use]
    pub const fn new(seed: u64) -> Self {
        Self { rng_state: seed }
    }

    fn next_u32(&mut self) -> u32 {
        // xorshift64*; same as VM in vm.rs.
        let mut x = self.rng_state;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        if x == 0 {
            x = 0x9E37_79B9_7F4A_7C15;
        }
        self.rng_state = x;
        #[allow(clippy::cast_possible_truncation)]
        let truncated = x as u32;
        truncated
    }
}

impl HitHost for DefaultHost {
    fn rand(&mut self, low: i32, high: i32) -> i32 {
        if high <= low {
            return low;
        }
        let span = (high - low + 1) as u32;
        #[allow(clippy::cast_possible_wrap)]
        let r = (self.next_u32() % span) as i32;
        low + r
    }
    fn smart_choose(&mut self, _hitlist: u32) -> i32 { 0 }
    fn smart_index(&mut self, _hitlist: u32, _index: i32) -> i32 { 0 }
    fn read_object_field(&mut self, _source: i32, _field: u32) -> i32 { 0 }
    fn write_object_field(&mut self, _source: i32, _field: u32, _value: i32) {}
}

/// Result of a single `step` call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StepOutcome {
    /// Instruction executed; pc advanced. No engine yield.
    Continued,
    /// Instruction yielded an effect to the host. The thread is *suspended*; the
    /// host should call `resume()` (a thin wrapper) to continue once the effect
    /// has been processed.
    Yielded(HitEffect),
    /// Thread terminated cleanly (`end`, top-level `return`).
    Halted,
    Error(HitVmError),
}

/// Outcome of `run_until_yield` / `run_until_halt`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunOutcome {
    Yielded(HitEffect),
    Halted,
    BudgetExhausted,
    Error(HitVmError),
}

/// HIT VM state. One per logical "thread" of execution.
#[derive(Debug)]
pub struct HitVm<'code> {
    /// The bytecode (the `code` field of `Hit`, i.e. without the 16 B header).
    pub code: &'code [u8],
    /// Program counter expressed in *file-relative* offsets (so 0x10 means the
    /// very first instruction). This matches the conventions of `call` / `jump`
    /// / `if*` operands which are documented as "offset from the beginning of
    /// the file".
    pub pc: u32,
    /// Return-address stack (file-relative offsets).
    pub call_stack: Vec<u32>,
    /// Track variables (arg0..h4 + Sims 1 track-variable aliases priority/vol/…).
    /// Indexed directly by the variable byte from the bytecode.
    pub regs: [i32; TRACK_VAR_LIMIT],
    /// Sparse globals: id → value.
    pub globals: BTreeMap<u32, i32>,
    /// Sparse object data fields: (source_id, field_id) → value.
    pub object_data: BTreeMap<(i32, u32), i32>,
    pub zero_flag: bool,
    pub sign_flag: bool,
    /// `set_loop` records here; `loop` jumps to it.
    pub loop_point: u32,
    /// Currently selected hitlist (`smart_setlist`).
    pub current_hitlist: u32,
    pub steps_executed: u32,
    pub trace: Vec<HitTraceEntry>,
    pub trace_enabled: bool,
}

const HIT_HEADER_LEN: u32 = 16;

impl<'code> HitVm<'code> {
    /// Create a VM for `hit`, ready to execute starting at `entry_address`.
    /// `entry_address` is *file-relative* (i.e. ≥ 16). It is what the HOT
    /// TrackData section stores ("0x1=0x10" means "track 1 enters at offset 0x10").
    #[must_use]
    pub fn new(hit: &'code Hit, entry_address: u32) -> Self {
        Self {
            code: &hit.code,
            pc: entry_address,
            call_stack: Vec::new(),
            regs: [0; TRACK_VAR_LIMIT],
            globals: BTreeMap::new(),
            object_data: BTreeMap::new(),
            zero_flag: false,
            sign_flag: false,
            loop_point: entry_address,
            current_hitlist: 0,
            steps_executed: 0,
            trace: Vec::new(),
            trace_enabled: false,
        }
    }

    /// Set arg0..arg4 from a slice (call convention for entry-point invocation).
    /// Extras are ignored, missing slots stay zero.
    pub fn set_args(&mut self, args: &[i32]) {
        for (i, &v) in args.iter().take(5).enumerate() {
            self.regs[i] = v;
        }
    }

    /// Read a track variable by its bytecode ID.
    fn read_track_var(&mut self, id: u8) -> i32 {
        self.regs[id as usize]
    }

    /// Write a track variable by its bytecode ID.
    fn write_track_var(&mut self, id: u8, value: i32) {
        self.regs[id as usize] = value;
    }

    fn fetch_u8(&self, offset_from_pc: u32) -> Result<u8, HitVmError> {
        let p = self.code_offset(self.pc + offset_from_pc)?;
        self.code
            .get(p)
            .copied()
            .ok_or(HitVmError::TruncatedInstr {
                pc: self.pc,
                opcode: self.code[self.code_offset(self.pc).unwrap_or(0)],
            })
    }

    fn fetch_u32(&self, offset_from_pc: u32) -> Result<u32, HitVmError> {
        let p = self.code_offset(self.pc + offset_from_pc)?;
        let bytes = self.code.get(p..p + 4).ok_or(HitVmError::TruncatedInstr {
            pc: self.pc,
            opcode: self.code[self.code_offset(self.pc).unwrap_or(0)],
        })?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    fn code_offset(&self, file_relative: u32) -> Result<usize, HitVmError> {
        if file_relative < HIT_HEADER_LEN {
            return Err(HitVmError::PcOutOfRange {
                pc: file_relative,
                code_len: self.code.len() as u32 + HIT_HEADER_LEN,
            });
        }
        let idx = (file_relative - HIT_HEADER_LEN) as usize;
        if idx >= self.code.len() {
            return Err(HitVmError::PcOutOfRange {
                pc: file_relative,
                code_len: self.code.len() as u32 + HIT_HEADER_LEN,
            });
        }
        Ok(idx)
    }

    fn current_opcode(&self) -> Result<u8, HitVmError> {
        let idx = self.code_offset(self.pc)?;
        Ok(self.code[idx])
    }

    /// Run until an effect is yielded, the thread halts, or `max_steps` is reached.
    pub fn run_until_yield<H: HitHost>(
        &mut self,
        host: &mut H,
        max_steps: u32,
    ) -> RunOutcome {
        for _ in 0..max_steps {
            match self.step(host) {
                StepOutcome::Continued => {}
                StepOutcome::Yielded(eff) => return RunOutcome::Yielded(eff),
                StepOutcome::Halted => return RunOutcome::Halted,
                StepOutcome::Error(e) => return RunOutcome::Error(e),
            }
        }
        RunOutcome::BudgetExhausted
    }

    /// Run until the thread halts. Yielded effects are *recorded* and the thread
    /// is automatically resumed — useful for "evaluate the whole event handler"
    /// style invocations where the host doesn't actually need to wait.
    pub fn run_until_halt<H: HitHost>(
        &mut self,
        host: &mut H,
        max_steps: u32,
    ) -> (RunOutcome, Vec<HitEffect>) {
        let mut effects = Vec::new();
        for _ in 0..max_steps {
            match self.step(host) {
                StepOutcome::Continued => {}
                StepOutcome::Yielded(eff) => effects.push(eff),
                StepOutcome::Halted => return (RunOutcome::Halted, effects),
                StepOutcome::Error(e) => return (RunOutcome::Error(e), effects),
            }
        }
        (RunOutcome::BudgetExhausted, effects)
    }

    /// Execute exactly one instruction.
    #[allow(clippy::too_many_lines)]
    pub fn step<H: HitHost>(&mut self, host: &mut H) -> StepOutcome {
        self.steps_executed = self.steps_executed.saturating_add(1);
        let opcode = match self.current_opcode() {
            Ok(o) => o,
            Err(e) => return StepOutcome::Error(e),
        };
        let pc_before = self.pc;

        // The disassembler is the source of truth for instruction lengths; reuse it.
        // We compute (mnemonic, byte_len, args) for trace, but actually decode below.
        let (mnemonic, byte_len) = match self.disasm_one(self.pc) {
            Ok(t) => t,
            Err(e) => return StepOutcome::Error(e),
        };

        let result = self.execute_one(opcode, byte_len, host);

        if self.trace_enabled {
            let trace_args = String::new(); // keep trace cheap; full disasm in Hit::disasm.
            self.trace.push(HitTraceEntry {
                pc: pc_before,
                opcode,
                mnemonic,
                args: trace_args,
                zero: self.zero_flag,
                sign: self.sign_flag,
            });
        }

        result
    }

    /// Inner dispatch.
    #[allow(clippy::too_many_lines)]
    fn execute_one<H: HitHost>(
        &mut self,
        opcode: u8,
        byte_len: usize,
        host: &mut H,
    ) -> StepOutcome {
        let pc = self.pc;
        let advance = |pc: u32, n: usize| pc + n as u32;
        match opcode {
            // --- 1 byte, no operand ---
            0x08 => {
                // return: pop, jump; if empty, halt
                if let Some(ret_pc) = self.call_stack.pop() {
                    self.pc = ret_pc;
                    StepOutcome::Continued
                } else {
                    StepOutcome::Yielded(HitEffect::Return)
                }
            }
            0x0B => {
                self.pc = advance(pc, byte_len);
                StepOutcome::Yielded(HitEffect::WaitSamp)
            }
            0x0C => {
                // end — kill thread.
                self.pc = advance(pc, byte_len);
                StepOutcome::Yielded(HitEffect::End)
            }
            0x0F => { self.pc = advance(pc, byte_len); StepOutcome::Continued } // nop
            0x20 => {
                // loop — jump to set_loop point.
                self.pc = self.loop_point;
                StepOutcome::Continued
            }
            0x21 => {
                // set_loop — record current pc as the loop point. Niotso says
                // "current position" which we interpret as "after this instruction".
                self.loop_point = advance(pc, byte_len);
                self.pc = self.loop_point;
                StepOutcome::Continued
            }
            // test1/2/3/4 — semantics unknown. Treat as no-op. (Niotso: "Unknown".)
            0x3A | 0x3B | 0x3C | 0x3D => {
                self.pc = advance(pc, byte_len);
                StepOutcome::Continued
            }
            0x53 => {
                self.pc = advance(pc, byte_len);
                StepOutcome::Yielded(HitEffect::Duck)
            }
            0x54 => {
                self.pc = advance(pc, byte_len);
                StepOutcome::Yielded(HitEffect::Unduck)
            }

            // --- 2 byte: opcode + 1 var ---
            0x02 | 0x03 | 0x09 | 0x0E | 0x27 | 0x32 | 0x33
            | 0x44 | 0x45 | 0x47 | 0x5A | 0x60 => {
                let var = match self.fetch_u8(1) { Ok(v) => v, Err(e) => return StepOutcome::Error(e) };
                self.pc = advance(pc, byte_len);
                let value = self.read_track_var(var);
                match opcode {
                    0x02 => StepOutcome::Yielded(HitEffect::PlayNote { note_id: value }),
                    0x03 => StepOutcome::Yielded(HitEffect::StopNote { note_id: value }),
                    0x09 => StepOutcome::Yielded(HitEffect::Wait { ms: value }),
                    0x0E => {
                        // test arg1 — set zero flag from arg1.
                        self.zero_flag = value == 0;
                        self.sign_flag = value < 0;
                        StepOutcome::Continued
                    }
                    0x27 => {
                        let picked = host.smart_choose(self.current_hitlist);
                        self.write_track_var(var, picked);
                        StepOutcome::Yielded(HitEffect::SmartChoose {
                            dest_var: var,
                            hitlist: self.current_hitlist,
                            picked,
                        })
                    }
                    0x32 => StepOutcome::Yielded(HitEffect::PlayTrack { track_id: value }),
                    0x33 => StepOutcome::Yielded(HitEffect::KillTrack { track_id: value }),
                    0x44 => {
                        // smart_setlist src — host hitlist selection.
                        // Per Niotso: 0 = local hitlist, otherwise pick global.
                        #[allow(clippy::cast_sign_loss)]
                        let v = value as u32;
                        self.current_hitlist = v;
                        StepOutcome::Continued
                    }
                    0x45 => StepOutcome::Yielded(HitEffect::SeqGroupKill { group: value }),
                    0x47 => StepOutcome::Yielded(HitEffect::SeqGroupReturn { group: value }),
                    0x5A => StepOutcome::Yielded(HitEffect::StopTrack { track_id: value }),
                    0x60 => StepOutcome::Yielded(HitEffect::PlayNoteLoop { note_id: value }),
                    _ => unreachable!(),
                }
            }

            // --- 3 byte: opcode + 1 var + immediate u8 ---
            0x04 => {
                let dest = match self.fetch_u8(1) { Ok(v) => v, Err(e) => return StepOutcome::Error(e) };
                let imm = match self.fetch_u8(2) { Ok(v) => v, Err(e) => return StepOutcome::Error(e) };
                self.write_track_var(dest, i32::from(imm));
                self.pc = advance(pc, byte_len);
                StepOutcome::Continued
            }

            // --- 3 byte: opcode + 2 vars ---
            0x06 | 0x10 | 0x11 | 0x12 | 0x13 | 0x14
            | 0x4A | 0x4B | 0x4D | 0x4E | 0x4F | 0x50 | 0x51 | 0x52
            | 0x5F => {
                let a = match self.fetch_u8(1) { Ok(v) => v, Err(e) => return StepOutcome::Error(e) };
                let b = match self.fetch_u8(2) { Ok(v) => v, Err(e) => return StepOutcome::Error(e) };
                self.pc = advance(pc, byte_len);
                let av = self.read_track_var(a);
                let bv = self.read_track_var(b);
                match opcode {
                    0x06 => { self.write_track_var(a, bv); StepOutcome::Continued } // set
                    0x10 => { self.write_track_var(a, av.wrapping_add(bv)); StepOutcome::Continued }
                    0x11 => { self.write_track_var(a, av.wrapping_sub(bv)); StepOutcome::Continued }
                    0x12 => {
                        let r = if bv == 0 { 0 } else { av / bv };
                        self.write_track_var(a, r);
                        StepOutcome::Continued
                    }
                    0x13 => { self.write_track_var(a, av.wrapping_mul(bv)); StepOutcome::Continued }
                    0x14 => {
                        // cmp arg1 arg2 — flags as if (arg1 - arg2).
                        let diff = av.wrapping_sub(bv);
                        self.zero_flag = diff == 0;
                        self.sign_flag = diff < 0;
                        StepOutcome::Continued
                    }
                    0x4A => StepOutcome::Yielded(HitEffect::SetLowLow { dest_var: a, value: bv }),
                    0x4B => StepOutcome::Yielded(HitEffect::SetLowTime { dest_var: a, value: bv }),
                    0x4D => StepOutcome::Yielded(HitEffect::WaitVarCmp { kind: WaitKind::Eq, var1: a, var2: b }),
                    0x4E => StepOutcome::Yielded(HitEffect::WaitVarCmp { kind: WaitKind::Ne, var1: a, var2: b }),
                    0x4F => StepOutcome::Yielded(HitEffect::WaitVarCmp { kind: WaitKind::Gt, var1: a, var2: b }),
                    0x50 => StepOutcome::Yielded(HitEffect::WaitVarCmp { kind: WaitKind::Lt, var1: a, var2: b }),
                    0x51 => StepOutcome::Yielded(HitEffect::WaitVarCmp { kind: WaitKind::Ge, var1: a, var2: b }),
                    0x52 => StepOutcome::Yielded(HitEffect::WaitVarCmp { kind: WaitKind::Le, var1: a, var2: b }),
                    0x5F => {
                        // smart_index dest index
                        let picked = host.smart_index(self.current_hitlist, bv);
                        self.write_track_var(a, picked);
                        StepOutcome::Continued
                    }
                    _ => unreachable!(),
                }
            }

            // --- 3 byte: opcode + 2 immediate u8 ---
            0x49 => {
                let a = match self.fetch_u8(1) { Ok(v) => v, Err(e) => return StepOutcome::Error(e) };
                let b = match self.fetch_u8(2) { Ok(v) => v, Err(e) => return StepOutcome::Error(e) };
                self.pc = advance(pc, byte_len);
                StepOutcome::Yielded(HitEffect::SeqGroupTrkId { a, b })
            }

            // --- 4 byte: opcode + 3 vars ---
            0x18 => {
                // rand dest low high
                let dest = match self.fetch_u8(1) { Ok(v) => v, Err(e) => return StepOutcome::Error(e) };
                let lo = match self.fetch_u8(2) { Ok(v) => v, Err(e) => return StepOutcome::Error(e) };
                let hi = match self.fetch_u8(3) { Ok(v) => v, Err(e) => return StepOutcome::Error(e) };
                self.pc = advance(pc, byte_len);
                let lov = self.read_track_var(lo);
                let hiv = self.read_track_var(hi);
                let r = host.rand(lov, hiv);
                self.write_track_var(dest, r);
                StepOutcome::Continued
            }
            0x48 => {
                // getsrcdatafield dest source field
                let dest = match self.fetch_u8(1) { Ok(v) => v, Err(e) => return StepOutcome::Error(e) };
                let src = match self.fetch_u8(2) { Ok(v) => v, Err(e) => return StepOutcome::Error(e) };
                let field = match self.fetch_u8(3) { Ok(v) => v, Err(e) => return StepOutcome::Error(e) };
                self.pc = advance(pc, byte_len);
                let src_id = self.read_track_var(src);
                let field_id = u32::from(self.read_track_var(field) as u32);
                let value = host.read_object_field(src_id, field_id);
                self.write_track_var(dest, value);
                self.zero_flag = value == 0;
                self.sign_flag = value < 0;
                StepOutcome::Continued
            }
            0x55 => {
                // testx — semantics unknown per Niotso. Skip safely.
                self.pc = advance(pc, byte_len);
                StepOutcome::Continued
            }
            0x59 => {
                // setsrcdatafield value source field
                let value = match self.fetch_u8(1) { Ok(v) => v, Err(e) => return StepOutcome::Error(e) };
                let src = match self.fetch_u8(2) { Ok(v) => v, Err(e) => return StepOutcome::Error(e) };
                let field = match self.fetch_u8(3) { Ok(v) => v, Err(e) => return StepOutcome::Error(e) };
                self.pc = advance(pc, byte_len);
                let value_v = self.read_track_var(value);
                let src_id = self.read_track_var(src);
                let field_id = self.read_track_var(field) as u32;
                host.write_object_field(src_id, field_id, value_v);
                StepOutcome::Continued
            }

            // --- 5 byte: opcode + 4-byte u32 ---
            0x07 => {
                // call #addr — push next-pc, jump. If the target is invalid
                // (TS1 simssound.HIT does this with address values like 13 that
                // appear to encode an event/state ID rather than a code address),
                // skip the call and continue.
                let target = match self.fetch_u32(1) { Ok(v) => v, Err(e) => return StepOutcome::Error(e) };
                let next = advance(pc, byte_len);
                if self.code_offset(target).is_ok() {
                    self.call_stack.push(next);
                    self.pc = target;
                } else {
                    self.pc = next;
                }
                StepOutcome::Continued
            }
            0x0A => {
                // callentrypoint — unused in TS1/TSO; treat as nop with advance.
                self.pc = advance(pc, byte_len);
                StepOutcome::Continued
            }
            0x3E | 0x3F | 0x40 | 0x41 | 0x42 | 0x43 => {
                // Conditional jumps. All operand: 4-byte file-relative target.
                let target = match self.fetch_u32(1) { Ok(v) => v, Err(e) => return StepOutcome::Error(e) };
                let next = advance(pc, byte_len);
                let take = match opcode {
                    0x3E => self.zero_flag,                       // ifeq
                    0x3F => !self.zero_flag,                      // ifne
                    0x40 => !self.sign_flag && !self.zero_flag,   // ifgt
                    0x41 => self.sign_flag,                       // iflt
                    0x42 => !self.sign_flag,                      // ifge
                    0x43 => self.sign_flag || self.zero_flag,     // ifle
                    _ => unreachable!(),
                };
                // Real TS1 bytecode (e.g. simssound.HIT @ 0xCB) emits
                // `ifeq #0x0a` with target < 16. Niotso says that's illegal;
                // FreeSO/MakeTrax tolerate it. Treat invalid targets as
                // "branch not taken" rather than erroring.
                if take && self.code_offset(target).is_ok() {
                    self.pc = target;
                } else {
                    self.pc = next;
                }
                StepOutcome::Continued
            }

            // --- 6 byte: opcode + 1 var + 4-byte ---
            0x05 => {
                // loadl dest #imm
                let dest = match self.fetch_u8(1) { Ok(v) => v, Err(e) => return StepOutcome::Error(e) };
                let imm = match self.fetch_u32(2) { Ok(v) => v, Err(e) => return StepOutcome::Error(e) };
                #[allow(clippy::cast_possible_wrap)]
                let value = imm as i32;
                self.write_track_var(dest, value);
                self.pc = advance(pc, byte_len);
                StepOutcome::Continued
            }
            0x2D => {
                // max dest #src
                let dest = match self.fetch_u8(1) { Ok(v) => v, Err(e) => return StepOutcome::Error(e) };
                let imm = match self.fetch_u32(2) { Ok(v) => v, Err(e) => return StepOutcome::Error(e) };
                #[allow(clippy::cast_possible_wrap)]
                let imm_i = imm as i32;
                let cur = self.read_track_var(dest);
                self.write_track_var(dest, cur.max(imm_i));
                self.pc = advance(pc, byte_len);
                StepOutcome::Continued
            }
            0x2E => {
                let dest = match self.fetch_u8(1) { Ok(v) => v, Err(e) => return StepOutcome::Error(e) };
                let imm = match self.fetch_u32(2) { Ok(v) => v, Err(e) => return StepOutcome::Error(e) };
                #[allow(clippy::cast_possible_wrap)]
                let imm_i = imm as i32;
                let cur = self.read_track_var(dest);
                self.write_track_var(dest, cur.min(imm_i));
                self.pc = advance(pc, byte_len);
                StepOutcome::Continued
            }
            0x56 => {
                // setlg local #global  → write global from local.
                let local = match self.fetch_u8(1) { Ok(v) => v, Err(e) => return StepOutcome::Error(e) };
                let global = match self.fetch_u32(2) { Ok(v) => v, Err(e) => return StepOutcome::Error(e) };
                let value = self.read_track_var(local);
                self.globals.insert(global, value);
                self.pc = advance(pc, byte_len);
                StepOutcome::Continued
            }
            0x57 => {
                // setgl local #global  → read global, write local.
                let local = match self.fetch_u8(1) { Ok(v) => v, Err(e) => return StepOutcome::Error(e) };
                let global = match self.fetch_u32(2) { Ok(v) => v, Err(e) => return StepOutcome::Error(e) };
                let value = self.globals.get(&global).copied().unwrap_or(0);
                self.write_track_var(local, value);
                self.pc = advance(pc, byte_len);
                StepOutcome::Continued
            }

            // --- jump (0x0D): heuristic decided in disasm_one already ---
            // 5-byte form is either an absolute address (target ≥ 16) OR a
            // wide variable form (var byte + 3 zero pads). 2-byte form is the
            // compact variable form (only when next byte is 0x05/0x06).
            0x0D => {
                let next = advance(pc, byte_len);
                if byte_len == 5 {
                    let raw = match self.fetch_u32(1) { Ok(v) => v, Err(e) => return StepOutcome::Error(e) };
                    if raw >= 16 && (raw as usize) < self.code.len() + 16 {
                        self.pc = raw;
                    } else {
                        // Wide variable form. Read the variable, jump to it
                        // if valid, else fall through.
                        #[allow(clippy::cast_possible_truncation)]
                        let var = raw as u8;
                        let target_i = self.read_track_var(var);
                        #[allow(clippy::cast_sign_loss)]
                        let target_u = target_i as u32;
                        if self.code_offset(target_u).is_ok() {
                            self.pc = target_u;
                        } else {
                            self.pc = next;
                        }
                    }
                } else if byte_len == 2 {
                    let var = match self.fetch_u8(1) { Ok(v) => v, Err(e) => return StepOutcome::Error(e) };
                    let target = self.read_track_var(var);
                    #[allow(clippy::cast_sign_loss)]
                    let target_u = target as u32;
                    if self.code_offset(target_u).is_ok() {
                        self.pc = target_u;
                    } else {
                        self.pc = next;
                    }
                } else {
                    return StepOutcome::Error(HitVmError::AmbiguousJump { pc });
                }
                StepOutcome::Continued
            }

            other => StepOutcome::Error(HitVmError::UnknownOpcode { pc, opcode: other }),
        }
    }

    /// Reuse the disassembler to compute (mnemonic, byte_len) for the instruction
    /// at `pc`. We don't keep the args string here (cheap-trace path).
    fn disasm_one(&self, pc: u32) -> Result<(&'static str, usize), HitVmError> {
        let cursor = self.code_offset(pc)?;
        let opcode = self.code[cursor];
        let len_left = self.code.len() - cursor;
        let read_u32 = |offset: usize| -> Option<u32> {
            let bytes = self.code.get(cursor + offset..cursor + offset + 4)?;
            Some(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
        };
        let r = match opcode {
            0x08 => ("return", 1),
            0x0B => ("wait_samp", 1),
            0x0C => ("end", 1),
            0x0F => ("nop", 1),
            0x20 => ("loop", 1),
            0x21 => ("set_loop", 1),
            0x3A => ("test1", 1),
            0x3B => ("test2", 1),
            0x3C => ("test3", 1),
            0x3D => ("test4", 1),
            0x53 => ("duck", 1),
            0x54 => ("unduck", 1),
            0x02 => ("note_on", 2),
            0x03 => ("note_off", 2),
            0x09 => ("wait", 2),
            0x0E => ("test", 2),
            0x27 => ("smart_choose", 2),
            0x32 => ("play_trk", 2),
            0x33 => ("kill_trk", 2),
            0x44 => ("smart_setlist", 2),
            0x45 => ("seqgroup_kill", 2),
            0x47 => ("seqgroup_return", 2),
            0x5A => ("stop_trk", 2),
            0x60 => ("note_on_loop", 2),
            0x04 => ("loadb", 3),
            0x06 => ("set", 3),
            0x10 => ("add", 3),
            0x11 => ("sub", 3),
            0x12 => ("div", 3),
            0x13 => ("mul", 3),
            0x14 => ("cmp", 3),
            0x49 => ("seqgroup_trkid", 3),
            0x4A => ("setll", 3),
            0x4B => ("setlt", 3),
            0x4D => ("waiteq", 3),
            0x4E => ("waitne", 3),
            0x4F => ("waitgt", 3),
            0x50 => ("waitlt", 3),
            0x51 => ("waitge", 3),
            0x52 => ("waitle", 3),
            0x5F => ("smart_index", 3),
            0x18 => ("rand", 4),
            0x48 => ("getsrcdatafield", 4),
            0x55 => ("testx", 4),
            0x59 => ("setsrcdatafield", 4),
            0x07 => ("call", 5),
            0x0A => ("callentrypoint", 5),
            0x3E => ("ifeq", 5),
            0x3F => ("ifne", 5),
            0x40 => ("ifgt", 5),
            0x41 => ("iflt", 5),
            0x42 => ("ifge", 5),
            0x43 => ("ifle", 5),
            0x05 => ("loadl", 6),
            0x2D => ("max", 6),
            0x2E => ("min", 6),
            0x56 => ("setlg", 6),
            0x57 => ("setgl", 6),
            0x0D => {
                if len_left >= 5 {
                    let candidate = read_u32(1).unwrap_or(0);
                    let is_address = candidate >= 16
                        && (candidate as usize) < self.code.len() + 16;
                    if is_address {
                        return Ok(("jump", 5));
                    }
                }
                let first = self.code.get(cursor + 1).copied().unwrap_or(0);
                if first == 0x05 || first == 0x06 {
                    ("jump", 2)
                } else {
                    ("jump", 5)
                }
            }
            other => return Err(HitVmError::UnknownOpcode { pc, opcode: other }),
        };
        Ok(r)
    }

    /// Pretty-print the trace for debugging. Cheap — designed for small traces.
    #[must_use]
    pub fn format_trace(&self) -> String {
        let mut s = String::new();
        for (i, e) in self.trace.iter().enumerate() {
            s.push_str(&alloc::format!(
                "{:04}: 0x{:04x} {} (z={} s={})\n",
                i,
                e.pc,
                e.mnemonic,
                u8::from(e.zero),
                u8::from(e.sign),
            ));
            let _ = (i, &e.args); // args left empty for cheap-trace path.
        }
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Hit;
    use alloc::vec;

    fn build_hit(bytecode: Vec<u8>) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"HIT!");
        buf.extend_from_slice(&1u32.to_le_bytes());
        buf.extend_from_slice(&8u32.to_le_bytes());
        buf.extend_from_slice(b"TRAX");
        buf.extend_from_slice(&bytecode);
        buf
    }

    #[test]
    fn hitvm_loadl_set_add_yields_track() {
        // loadl v1 #5; loadl v2 #7; add v1 v2; play_trk v1; end
        let mut bc = Vec::new();
        bc.push(0x05); bc.push(0x05); bc.extend_from_slice(&5u32.to_le_bytes());
        bc.push(0x05); bc.push(0x06); bc.extend_from_slice(&7u32.to_le_bytes());
        bc.push(0x10); bc.push(0x05); bc.push(0x06);
        bc.push(0x32); bc.push(0x05);
        bc.push(0x0c);
        let buf = build_hit(bc);
        let hit = Hit::parse(&buf).unwrap();
        let mut vm = HitVm::new(&hit, 16);
        let mut host = DefaultHost::new(0xCAFE);
        let outcome = vm.run_until_yield(&mut host, 100);
        assert_eq!(outcome, RunOutcome::Yielded(HitEffect::PlayTrack { track_id: 12 }));
        assert_eq!(vm.regs[0x05], 12);
    }

    #[test]
    fn hitvm_cmp_ifeq_taken_branch() {
        // loadl v1 #3; cmp v1 v1; ifeq → end-target
        // Layout: instr 1 at 0x10 (6B), instr 2 at 0x16 (3B), ifeq at 0x19 (5B), end at 0x1E (1B), end at 0x1F (1B)
        let mut bc = Vec::new();
        bc.push(0x05); bc.push(0x05); bc.extend_from_slice(&3u32.to_le_bytes()); // 0x10 loadl
        bc.push(0x14); bc.push(0x05); bc.push(0x05);                              // 0x16 cmp
        // ifeq #0x1F (skip the next end and fall onto the end after it)
        bc.push(0x3E); bc.extend_from_slice(&0x1Fu32.to_le_bytes());              // 0x19 ifeq → 0x1F
        bc.push(0x0C);                                                            // 0x1E end (skipped)
        bc.push(0x0C);                                                            // 0x1F end
        let buf = build_hit(bc);
        let hit = Hit::parse(&buf).unwrap();
        let mut vm = HitVm::new(&hit, 16);
        let mut host = DefaultHost::new(0);
        let outcome = vm.run_until_yield(&mut host, 50);
        assert_eq!(outcome, RunOutcome::Yielded(HitEffect::End));
        assert_eq!(vm.pc, 0x1F + 1); // pc advanced past `end`
    }

    #[test]
    fn hitvm_cmp_ifeq_not_taken() {
        // loadl v1 #3; loadl v2 #4; cmp v1 v2; ifeq → 0x99 (would crash); end
        let mut bc = Vec::new();
        bc.push(0x05); bc.push(0x05); bc.extend_from_slice(&3u32.to_le_bytes()); // 0x10
        bc.push(0x05); bc.push(0x06); bc.extend_from_slice(&4u32.to_le_bytes()); // 0x16
        bc.push(0x14); bc.push(0x05); bc.push(0x06);                              // 0x1C cmp
        bc.push(0x3E); bc.extend_from_slice(&0x9999_9999u32.to_le_bytes());       // 0x1F ifeq
        bc.push(0x0C);                                                            // 0x24 end
        let buf = build_hit(bc);
        let hit = Hit::parse(&buf).unwrap();
        let mut vm = HitVm::new(&hit, 16);
        let mut host = DefaultHost::new(0);
        let outcome = vm.run_until_yield(&mut host, 50);
        assert_eq!(outcome, RunOutcome::Yielded(HitEffect::End));
    }

    #[test]
    fn hitvm_call_return() {
        // 0x10: call #0x18
        // 0x15: end
        // 0x16: <pad>  -> let's place something simple. Layout:
        //   0x10 call (5B) → next is 0x15
        //   0x15 end       (1B) → after subroutine returns
        //   0x16 (subroutine) play_trk arg0 (2B) ; return (1B)
        // Wait: we should call a subroutine that does play_trk then return; after return we hit end.
        // Use addr 0x16 as the call target.
        let mut bc = Vec::new();
        bc.push(0x07); bc.extend_from_slice(&0x16u32.to_le_bytes()); // 0x10 call #0x16
        bc.push(0x0C);                                                // 0x15 end
        bc.push(0x32); bc.push(0x00);                                 // 0x16 play_trk arg0
        bc.push(0x08);                                                // 0x18 return
        let buf = build_hit(bc);
        let hit = Hit::parse(&buf).unwrap();
        let mut vm = HitVm::new(&hit, 16);
        vm.regs[0] = 42; // arg0 = 42
        let mut host = DefaultHost::new(0);
        // Step 1: call → pushes 0x15, pc=0x16
        match vm.step(&mut host) { StepOutcome::Continued => {} other => panic!("{other:?}") }
        assert_eq!(vm.pc, 0x16);
        assert_eq!(vm.call_stack, vec![0x15]);
        // Step 2: play_trk arg0 → yield PlayTrack 42, pc=0x18
        match vm.step(&mut host) {
            StepOutcome::Yielded(HitEffect::PlayTrack { track_id }) => assert_eq!(track_id, 42),
            other => panic!("{other:?}"),
        }
        // Step 3: return → pops 0x15, pc=0x15
        match vm.step(&mut host) { StepOutcome::Continued => {} other => panic!("{other:?}") }
        assert_eq!(vm.pc, 0x15);
        assert!(vm.call_stack.is_empty());
        // Step 4: end → halts.
        match vm.step(&mut host) {
            StepOutcome::Yielded(HitEffect::End) => {}
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn hitvm_top_level_return_yields_return() {
        let mut bc = Vec::new();
        bc.push(0x08); // return at 0x10
        let buf = build_hit(bc);
        let hit = Hit::parse(&buf).unwrap();
        let mut vm = HitVm::new(&hit, 16);
        let mut host = DefaultHost::new(0);
        match vm.step(&mut host) {
            StepOutcome::Yielded(HitEffect::Return) => {}
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn hitvm_setlg_setgl_roundtrip() {
        // loadl v1 #1234; setlg v1 #0x64 (write global 0x64); setgl v2 #0x64 (read it)
        let mut bc = Vec::new();
        bc.push(0x05); bc.push(0x05); bc.extend_from_slice(&1234u32.to_le_bytes()); // 0x10
        bc.push(0x56); bc.push(0x05); bc.extend_from_slice(&0x64u32.to_le_bytes()); // 0x16 setlg v1 #0x64
        bc.push(0x57); bc.push(0x06); bc.extend_from_slice(&0x64u32.to_le_bytes()); // 0x1C setgl v2 #0x64
        bc.push(0x0C); // 0x22 end
        let buf = build_hit(bc);
        let hit = Hit::parse(&buf).unwrap();
        let mut vm = HitVm::new(&hit, 16);
        let mut host = DefaultHost::new(0);
        let _ = vm.run_until_yield(&mut host, 50);
        assert_eq!(vm.globals.get(&0x64).copied().unwrap_or(0), 1234);
        assert_eq!(vm.regs[0x06], 1234);
    }

    #[test]
    fn hitvm_rand_inclusive_range_via_default_host() {
        // loadl v1 #5; loadl v2 #5; rand v3 v1 v2; end
        let mut bc = Vec::new();
        bc.push(0x05); bc.push(0x05); bc.extend_from_slice(&5u32.to_le_bytes()); // 0x10
        bc.push(0x05); bc.push(0x06); bc.extend_from_slice(&5u32.to_le_bytes()); // 0x16
        bc.push(0x18); bc.push(0x07); bc.push(0x05); bc.push(0x06);              // 0x1C rand v3 v1 v2
        bc.push(0x0C);                                                            // 0x20 end
        let buf = build_hit(bc);
        let hit = Hit::parse(&buf).unwrap();
        let mut vm = HitVm::new(&hit, 16);
        let mut host = DefaultHost::new(0xDEAD_BEEF);
        let _ = vm.run_until_yield(&mut host, 50);
        assert_eq!(vm.regs[0x07], 5);
    }

    #[test]
    fn hitvm_loop_returns_to_set_loop_point() {
        // loadl v1 #0; set_loop; add v1 v1 (no-op since both 0); jump back via loop
        // Use cmp + ifne to break out after 2 iterations.
        // Plan: v1 = 0; set_loop; add v1 #1 (via loadl tmp, then add); cmp v1 #2; iflt loop; end
        // Simpler: just set_loop, end. The loop point gets recorded.
        let mut bc = Vec::new();
        bc.push(0x21);                                                      // 0x10 set_loop
        bc.push(0x05); bc.push(0x05); bc.extend_from_slice(&7u32.to_le_bytes()); // 0x11 loadl v1 #7
        bc.push(0x0C);                                                      // 0x17 end
        let buf = build_hit(bc);
        let hit = Hit::parse(&buf).unwrap();
        let mut vm = HitVm::new(&hit, 16);
        let mut host = DefaultHost::new(0);
        let _ = vm.run_until_yield(&mut host, 50);
        // loop_point should be the address right after set_loop = 0x11.
        assert_eq!(vm.loop_point, 0x11);
        assert_eq!(vm.regs[0x05], 7);
    }
}
