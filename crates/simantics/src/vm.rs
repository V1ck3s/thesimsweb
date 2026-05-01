//! Skeleton `SimAntics` virtual machine.
//!
//! This is **infrastructure only** — call frames, instruction pointer, branch handling,
//! return sentinels, and primitive dispatch — but every primitive is a no-op stub that
//! reports "true" so execution always follows the `t_dest` branch. The point of this
//! module is to nail down the data model and the step loop so individual primitives can
//! be filled in incrementally without churning the surrounding scaffolding.
//!
//! ## What works today
//!
//! - Calling a BHAV by ID, walking its instructions, honouring `t_dest`/`f_dest` and
//!   the `0xFD/FE/FF` return sentinels.
//! - Subroutine calls (`opcode >= 256`) push a new stack frame; on return the parent
//!   frame's branch is followed using the callee's truth value.
//! - Step budget guard (default `1_000_000`) so a runaway BHAV doesn't spin the host.
//! - Caller-supplied [`BhavSource`] resolves opcodes → BHAV bytes (the production wiring
//!   will lookup the right IFF chunk; tests use an in-memory map).
//!
//! ## What does NOT work yet
//!
//! - **Operand semantics** — no primitive reads its 8-byte operand. Expression assigns
//!   nothing; Sleep doesn't yield wall-clock time; Animate Sim doesn't queue an animation.
//! - **Variable scopes** — [`crate::scope_name`] enumerates them, but reads/writes are
//!   stubbed out at the VM boundary.
//! - **World state** — [`World`] has no Sim/object state worth speaking of yet; it is the
//!   shape we'll grow into.

use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;

use crate::{Bhav, Instruction, SimAnticsError, scope_name};

// ---- Expression primitive (#2) ----

/// Operators understood by the Expression primitive. Source: Niotso wiki §Primitive 2.
///
/// Operators 0–9 + 14–16 cover the bulk of TS1 BHAVs (~95 % on the `AlarmClock` + Beds
/// samples). Flag ops (8/9/10) and increment-and-compare (11/17), modulo (12), bitwise
/// AND (13), and Push/Pop (18/19) are recognised but their effect on object attributes
/// versus temps depends on which Sims build authored the BHAV; we implement the canonical
/// reading and revisit if differential traces disagree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExpressionOp {
    Gt,         // 0  >
    Lt,         // 1  <
    Eq,         // 2  ==
    AddAssign,  // 3  +=
    SubAssign,  // 4  -=
    Assign,     // 5  =
    MulAssign,  // 6  *=
    DivAssign,  // 7  /=
    IsFlagSet,  // 8
    SetFlag,    // 9
    ClearFlag,  // 10
    IncThenLt,  // 11 ++ then <
    ModAssign,  // 12 %=
    AndAssign,  // 13 &=
    Ge,         // 14 >=
    Le,         // 15 <=
    Ne,         // 16 !=
    DecThenGt,  // 17 -- then >
    Push,       // 18
    Pop,        // 19
}

impl ExpressionOp {
    #[must_use]
    pub const fn from_byte(b: u8) -> Option<Self> {
        Some(match b {
            0 => Self::Gt,
            1 => Self::Lt,
            2 => Self::Eq,
            3 => Self::AddAssign,
            4 => Self::SubAssign,
            5 => Self::Assign,
            6 => Self::MulAssign,
            7 => Self::DivAssign,
            8 => Self::IsFlagSet,
            9 => Self::SetFlag,
            10 => Self::ClearFlag,
            11 => Self::IncThenLt,
            12 => Self::ModAssign,
            13 => Self::AndAssign,
            14 => Self::Ge,
            15 => Self::Le,
            16 => Self::Ne,
            17 => Self::DecThenGt,
            18 => Self::Push,
            19 => Self::Pop,
            _ => return None,
        })
    }

    /// `true` for operators that *write* to the LHS (they expect lhs to be assignable).
    #[must_use]
    pub const fn writes_lhs(self) -> bool {
        matches!(
            self,
            Self::AddAssign
                | Self::SubAssign
                | Self::Assign
                | Self::MulAssign
                | Self::DivAssign
                | Self::SetFlag
                | Self::ClearFlag
                | Self::IncThenLt
                | Self::ModAssign
                | Self::AndAssign
                | Self::DecThenGt
                | Self::Pop,
        )
    }
}

/// Parsed view of an Expression primitive's 8-byte operand.
#[derive(Debug, Clone, Copy)]
pub struct ExpressionOperand {
    pub lhs_data: u16,
    pub rhs_data: u16,
    pub is_signed: u8,
    pub operator: u8,
    pub lhs_owner: u8,
    pub rhs_owner: u8,
}

impl ExpressionOperand {
    /// Decode the 8-byte operand of an Expression instruction. Layout per Niotso:
    /// `lhs_data: u16 LE | rhs_data: u16 LE | is_signed: u8 | operator: u8 | lhs_owner: u8 | rhs_owner: u8`.
    #[must_use]
    pub const fn decode(operand: &[u8; 8]) -> Self {
        Self {
            lhs_data: u16::from_le_bytes([operand[0], operand[1]]),
            rhs_data: u16::from_le_bytes([operand[2], operand[3]]),
            is_signed: operand[4],
            operator: operand[5],
            lhs_owner: operand[6],
            rhs_owner: operand[7],
        }
    }
}

/// Source of BHAV bytecode keyed by opcode/chunk-id.
///
/// Production code resolves an opcode (which doubles as a chunk ID for `>= 256` opcodes)
/// to the data payload of the matching `BHAV` chunk. The `private`/`semiglobal`/`global`
/// distinction is a hint for the resolver — semi-globals come from `globals.iff`, globals
/// from `behavior.iff` — but it's the resolver's job to look in the right place.
pub trait BhavSource {
    /// Return the data payload of the BHAV whose chunk ID matches `opcode`, or `None`
    /// if not found in the visibility scope.
    fn lookup(&self, opcode: u16) -> Option<&[u8]>;
}

/// In-memory `BhavSource` backed by a `BTreeMap<opcode, data>`. Used by tests and the
/// CLI; production wires its own implementation against the IFF/Objects pipeline.
#[derive(Debug, Default, Clone)]
pub struct InMemoryBhavSource {
    pub bhavs: BTreeMap<u16, Vec<u8>>,
}

impl BhavSource for InMemoryBhavSource {
    fn lookup(&self, opcode: u16) -> Option<&[u8]> {
        self.bhavs.get(&opcode).map(Vec::as_slice)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecResult {
    /// BHAV returned with the given truth value.
    Returned(bool),
    /// BHAV returned an error sentinel (`0xFD`).
    Error,
    /// Step budget exhausted before the BHAV terminated.
    BudgetExhausted,
}

/// Result of a single scheduler tick — see [`Vm::tick`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TickOutcome {
    /// No interactions were waiting in the queue.
    Idle,
    /// The interaction's joining/guard function returned false; the action was skipped.
    Skipped(PendingInteraction),
    /// The action ran to completion (or to an `Error` / `BudgetExhausted` terminus).
    Ran(PendingInteraction, ExecResult),
}

/// One activation record on the call stack.
#[derive(Debug, Clone)]
pub struct StackFrame {
    /// Chunk ID of the BHAV currently executing in this frame.
    pub bhav_id: u16,
    /// 0-based index of the next instruction to execute.
    pub ip: u16,
    /// Subroutine-local variables. `SimAntics` declares their size in the BHAV header
    /// (`locals` byte). Initialised to zero on call.
    pub locals: Vec<i32>,
    /// Caller-passed parameters (the parent frame's "args" before the call). u8 in the
    /// BHAV header but i32 here so the VM can sign-extend them naturally.
    pub params: Vec<i32>,
    /// "My" object pointer — the object that owns the BHAV being executed.
    pub my_id: u32,
    /// "Stack object" pointer — the object the current interaction is targeting.
    pub stack_object_id: u32,
}

impl StackFrame {
    fn new(bhav_id: u16, header_locals: u8, params: Vec<i32>, my_id: u32, stack_object_id: u32) -> Self {
        Self {
            bhav_id,
            ip: 0,
            locals: alloc::vec![0i32; usize::from(header_locals)],
            params,
            my_id,
            stack_object_id,
        }
    }
}

/// One object instance in the world (a placed catalog item — chair, alarm clock, sim).
/// `attributes` is the per-object Sim attribute vector (scope 0/1 in `SimAntics`).
#[derive(Debug, Default, Clone)]
pub struct ObjectInstance {
    /// Catalog GUID — matches `OBJD::guid()` for the type this object instantiates.
    pub guid: u32,
    /// 2D lot position in tile coordinates. The Sims uses fixed-point with a Z-axis
    /// for floor; we ignore Z for now and treat the lot as planar.
    pub position: (i32, i32),
    /// Sim attributes (scope 0 / 1). Indexed by attribute number; defaults to 0.
    pub attributes: Vec<i32>,
    /// Type-attributes (scope 36/37) — shared across all instances of the same type.
    /// Stored per-instance for simplicity; the production engine shares these.
    pub type_attributes: Vec<i32>,
    /// Tuning constants from the BCON associated with the object's type
    /// (scope 26: "stack object tuning"). Filled when the BCON is loaded.
    pub tuning: Vec<i32>,
}

/// One Sim — a person object.
///
/// Distinct from a generic `ObjectInstance` because Sims have motives, person data,
/// and skills. The `object_id` is the same key as in `World::objects`; a Sim is
/// also stored there so that scope 1 attribute reads against a Sim work uniformly.
#[derive(Debug, Default, Clone)]
pub struct Sim {
    /// 16 motive scores, each in `[-100, 100]`. Niotso §motives:
    ///   0 hunger, 1 comfort, 2 hygiene, 3 bladder, 4 energy, 5 fun, 6 social,
    ///   7 room, 8-15 reserved/skills.
    pub motives: [i32; 16],
    /// Person-data scope (18/19). Free-form i32 vector indexed by data field id;
    /// real fields include hour/minute (56/57 — used by `AlarmClock`), age, gender, etc.
    pub person_data: Vec<i32>,
    /// Skills (cooking, mechanical, charisma, …) — separate from motives even though
    /// `SimAntics` stores both as motives in the binary layout. Free-form for now.
    pub skills: Vec<i32>,
}

/// Pending interaction queued onto a Sim's stack by `Push Interaction` (#13). Acts as
/// a passive log: we don't run them automatically (the engine would).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PendingInteraction {
    /// Sim that is being asked to run the interaction.
    pub sim_id: u32,
    /// Object the interaction is on.
    pub stack_object_id: u32,
    /// TTAB action-function tree ID.
    pub action_function: u16,
    /// TTAB joining/guard function tree ID (`-1` = none).
    pub joining_index: i32,
}

/// World-level state.
///
/// Houses the global temp bank, the object catalog, the Sim roster, and the household
/// funds bag — enough state for the meaningful primitive subset to land without
/// depending on the full engine.
#[derive(Debug, Default, Clone)]
pub struct World {
    /// Shared temp registers (scope 8). `SimAntics` ships ~32 temps; we allocate 32.
    pub temps: [i32; 32],
    /// Object ID → instance. Object IDs are opaque u32 — the engine assigns them when
    /// instances are placed; tests/callers use whatever scheme they like.
    pub objects: BTreeMap<u32, ObjectInstance>,
    /// Sim ID → Sim record. Same key space as `objects` (a Sim is also an object).
    pub sims: BTreeMap<u32, Sim>,
    /// Household funds (Simoleons). Scope 6 references go through this bank.
    pub funds: i32,
    /// Pending interactions pushed onto Sims' stacks. Recorded for inspection only —
    /// the VM doesn't pop them; the engine would.
    pub interaction_queue: Vec<PendingInteraction>,
    /// "Global" tuning constants (scope 6 `Global (from avatar)`). Indexed array of
    /// i32; loaded from the global BCONs.
    pub globals: Vec<i32>,
    /// Deterministic PRNG seed for `Random Number` (#8). Defaults to `0xDEAD_BEEF` so
    /// traces are reproducible. Update via `Vm::with_rng_seed`.
    pub rng_state: u64,
}

impl World {
    /// Read attribute `index` of `object_id`. Returns 0 if either is unset (Niotso says
    /// attributes default to 0 when never written, which matches the binary on-disk
    /// representation in OBJD).
    #[must_use]
    pub fn read_object_attr(&self, object_id: u32, index: usize) -> i32 {
        self.objects
            .get(&object_id)
            .and_then(|o| o.attributes.get(index).copied())
            .unwrap_or(0)
    }

    /// Write `value` to attribute `index` of `object_id`. Grows the attribute vector
    /// on demand (Sims allocates one slot per attribute used; we follow the same rule).
    pub fn write_object_attr(&mut self, object_id: u32, index: usize, value: i32) {
        let entry = self.objects.entry(object_id).or_default();
        if entry.attributes.len() <= index {
            entry.attributes.resize(index + 1, 0);
        }
        #[allow(clippy::indexing_slicing)]
        {
            entry.attributes[index] = value;
        }
    }

    /// Read motive `index` of `sim_id`. Returns 0 for unknown sim or out-of-range.
    #[must_use]
    pub fn read_motive(&self, sim_id: u32, index: usize) -> i32 {
        self.sims.get(&sim_id).and_then(|s| s.motives.get(index).copied()).unwrap_or(0)
    }

    /// Write `value` clamped to `[-100, 100]` into motive `index` of `sim_id`. No-op
    /// if `index >= 16`. Auto-creates the Sim record if missing.
    pub fn write_motive(&mut self, sim_id: u32, index: usize, value: i32) {
        if index >= 16 {
            return;
        }
        let sim = self.sims.entry(sim_id).or_default();
        let clamped = value.clamp(-100, 100);
        #[allow(clippy::indexing_slicing)] // index < 16 guard above
        {
            sim.motives[index] = clamped;
        }
    }

    /// Read person-data `index` of `sim_id`. 0 if unset.
    #[must_use]
    pub fn read_person_data(&self, sim_id: u32, index: usize) -> i32 {
        self.sims.get(&sim_id).and_then(|s| s.person_data.get(index).copied()).unwrap_or(0)
    }
}

/// Observable side-effect requested by a primitive that would yield to the engine.
///
/// Several `SimAntics` primitives don't compute anything in the VM — they tell the
/// game engine to do something (queue an animation, play a sound, sleep `n` ticks).
/// Without an engine to receive those requests, we still want them to be visible:
/// each one is recorded here so tests can assert "this BHAV asked the engine to
/// `AnimateSim(0x0001)` then `Sleep(20)`" without needing a full engine model.
///
/// The raw 8-byte operand is preserved on every variant so we can revisit the
/// interpretation later without losing data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VmEffect {
    /// Primitive 0 — `ticks` is the number of game ticks to yield. Niotso says
    /// the count is at operand bytes 4..6 (offsets 4 and 5).
    Sleep { ticks: u16, operand: [u8; 8] },
    /// Primitive 17 — like Sleep, but the engine may interrupt to push another
    /// interaction onto the stack. `ticks` at bytes 4..6, `interruptable` at 6..8.
    Idle { ticks: u16, interruptable: bool, operand: [u8; 8] },
    /// Primitive 23 — request the engine play a sound event. Operand layout is
    /// undocumented; we store the raw bytes and best-guess `event_id` from 0..2.
    PlaySound { event_id: u16, operand: [u8; 8] },
    /// Primitive 44 — request the engine queue an animation. Same caveat as `PlaySound`.
    AnimateSim { anim_id: u16, operand: [u8; 8] },
    /// Primitive 48 — stop every sound currently playing. Operand is unused.
    StopAllSounds,
    /// Primitive 41 — show a thought-bubble icon over the Sim. `kind` is the icon
    /// id; `operand` preserved for future interpretation.
    SetBalloon { kind: u16, operand: [u8; 8] },
    /// Primitive 50 — set the action string ("…buying milk") shown in the queue UI.
    /// `string_index` is into a STR# table whose ID we don't model yet.
    SetActionString { string_index: u16, operand: [u8; 8] },
    /// Primitive 49 — wake the stack object (a Sim) out of an idle interaction.
    NotifyOutOfIdle { sim_id: u32 },
    /// Primitive 35 — fire a special effect (e.g. sparkles). `kind` undocumented.
    SpecialEffect { kind: u16, operand: [u8; 8] },
    /// Primitive 34 — UI-level effect (cursor, panel flash, etc.).
    UiEffect { kind: u16, operand: [u8; 8] },
    /// Primitive 21 — show a string to the user. `kind` selects which dialog flavour.
    ShowString { kind: u16, operand: [u8; 8] },
    /// Primitive 36/38/39 — pop a dialog with strings from a private/global/semi-global
    /// STR# table. `flavour` records which of the three.
    Dialog { flavour: DialogFlavour, string_index: u16, operand: [u8; 8] },
    /// Primitive 6 — change a Sim's outfit/accessory.
    ChangeSuit { suit_id: u16, operand: [u8; 8] },
    /// Primitive 13 — push an interaction onto a Sim's queue. Recorded; the VM does
    /// not actually pop it (the engine would).
    PushInteraction { pending: PendingInteraction },
    /// Primitive 25 — transfer simoleons. `delta` is the signed amount; `operand`
    /// preserved for source/destination interpretation.
    TransferFunds { delta: i32, operand: [u8; 8] },
    /// Primitive 45 / 27 / 46 / 47 — engine-side spatial requests. `kind` records
    /// which primitive emitted the effect; the engine would interpret the operand.
    SpatialRequest { primitive: u8, operand: [u8; 8] },
    /// Primitive 28 — call a tree by string-table name (the engine resolves the name
    /// via the object's TTAs). We record the name index and don't actually descend.
    RunTreeByName { name_index: u16, operand: [u8; 8] },
    /// Primitive 18 — destroy the stack object.
    RemoveObjectInstance { object_id: u32 },
    /// Primitive 42 — instantiate a new object of `guid`. `new_object_id` is the ID
    /// the VM allocated.
    CreateObjectInstance { guid: u32, new_object_id: u32 },
    /// Primitive 22 — orient the Sim toward a target. Operand encodes which target.
    LookTowards { operand: [u8; 8] },
    /// Primitive 32 — opaque marker recorded so debugging traces can highlight an
    /// explicit break-point in a BHAV. Branch always taken.
    Breakpoint { bhav_id: u16, ip: u16 },
}

/// Flavour of dialog primitive — selects the STR# table the engine reads from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DialogFlavour {
    /// Primitive 36 — strings from the object's own STR# 256.
    Private,
    /// Primitive 38 — strings from `behavior.iff`.
    Global,
    /// Primitive 39 — strings from `globals.iff`.
    SemiGlobal,
}

/// One entry in the per-execution trace. Useful for snapshot/diff testing primitive
/// implementations once they exist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TraceEntry {
    pub depth: usize,
    pub bhav_id: u16,
    pub ip: u16,
    pub opcode: u16,
    pub branch_taken: TraceBranch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TraceBranch {
    Continue(u16),
    Returned(bool),
    Error,
}

pub struct Vm<'a> {
    source: &'a dyn BhavSource,
    pub world: World,
    pub call_stack: Vec<StackFrame>,
    pub trace: Vec<TraceEntry>,
    /// Side-effects emitted by primitives that yield to the engine (always recorded,
    /// regardless of `trace_enabled`). See [`VmEffect`].
    pub effects: Vec<VmEffect>,
    /// Maximum total instructions to execute before bailing out.
    pub step_budget: usize,
    /// Maximum recursion depth.
    pub max_depth: usize,
    /// When `true`, every executed instruction is appended to `trace`. Off by default.
    pub trace_enabled: bool,
}

impl core::fmt::Debug for Vm<'_> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Vm")
            .field("call_stack", &self.call_stack)
            .field("trace_len", &self.trace.len())
            .field("effects_len", &self.effects.len())
            .field("step_budget", &self.step_budget)
            .field("max_depth", &self.max_depth)
            .field("trace_enabled", &self.trace_enabled)
            .finish()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum VmError {
    #[error("BHAV 0x{0:04X} not found in source")]
    BhavNotFound(u16),
    #[error("call stack overflow at depth {depth}")]
    StackOverflow { depth: usize },
    #[error("ip {ip} out of bounds for BHAV 0x{bhav_id:04X} (count {count})")]
    IpOutOfBounds { bhav_id: u16, ip: u16, count: u16 },
    #[error("primitive 0x{opcode:04X} returned an unknown branch destination {dest}")]
    UnknownBranch { opcode: u16, dest: u8 },
    #[error("malformed BHAV: {0}")]
    BadBhav(#[from] SimAnticsError),
}

impl<'a> Vm<'a> {
    pub fn new(source: &'a dyn BhavSource) -> Self {
        Self {
            source,
            world: World::default(),
            call_stack: Vec::new(),
            trace: Vec::new(),
            effects: Vec::new(),
            step_budget: 1_000_000,
            max_depth: 256,
            trace_enabled: false,
        }
    }

    /// Run a BHAV to completion under the current step/depth budgets.
    ///
    /// # Errors
    ///
    /// Returns [`VmError`] for missing BHAVs (the source can't resolve a chunk ID),
    /// malformed BHAV bytecode, IP out of bounds, branch destinations past the end
    /// of the BHAV, or a stack overflow past `max_depth`.
    pub fn call(
        &mut self,
        bhav_id: u16,
        params: Vec<i32>,
        my_id: u32,
        stack_object_id: u32,
    ) -> Result<ExecResult, VmError> {
        let bytes = self.source.lookup(bhav_id).ok_or(VmError::BhavNotFound(bhav_id))?;
        let bhav = Bhav::parse(bytes)?;
        self.call_stack
            .push(StackFrame::new(bhav_id, bhav.header.locals, params, my_id, stack_object_id));
        let mut steps = 0usize;
        loop {
            if steps >= self.step_budget {
                return Ok(ExecResult::BudgetExhausted);
            }
            steps += 1;
            let mut outcome = self.step()?;
            // Propagate `Returned` upward through any number of waiting parent frames.
            loop {
                match outcome {
                    StepOutcome::Continue => break,
                    StepOutcome::Returned(value) => {
                        if self.call_stack.is_empty() {
                            return Ok(ExecResult::Returned(value));
                        }
                        outcome = self.resume_parent(value)?;
                    }
                    StepOutcome::Error => {
                        self.call_stack.clear();
                        return Ok(ExecResult::Error);
                    }
                }
            }
        }
    }

    fn step(&mut self) -> Result<StepOutcome, VmError> {
        let depth = self.call_stack.len();
        let frame = self.call_stack.last().ok_or(VmError::StackOverflow { depth: 0 })?;
        let bhav_id = frame.bhav_id;
        let ip = frame.ip;
        let bytes = self.source.lookup(bhav_id).ok_or(VmError::BhavNotFound(bhav_id))?;
        let bhav = Bhav::parse(bytes)?;
        if ip >= bhav.header.count {
            return Err(VmError::IpOutOfBounds {
                bhav_id,
                ip,
                count: bhav.header.count,
            });
        }
        #[allow(clippy::indexing_slicing)] // ip checked above
        let instr = bhav.instructions[ip as usize];
        let result = self.dispatch(instr);
        if self.trace_enabled {
            let dest = match result {
                DispatchOutcome::Branch(true) | DispatchOutcome::SubCall { .. } => instr.t_dest,
                DispatchOutcome::Branch(false) => instr.f_dest,
            };
            self.trace.push(TraceEntry {
                depth: depth - 1,
                bhav_id,
                ip,
                opcode: instr.opcode,
                branch_taken: TraceBranch::Continue(u16::from(dest)),
            });
        }
        match result {
            DispatchOutcome::Branch(value) => {
                self.follow_branch(instr, value, bhav.header.count)
            }
            DispatchOutcome::SubCall { opcode, operand } => {
                self.subroutine_call(opcode, operand)
            }
        }
    }

    fn dispatch(&mut self, instr: Instruction) -> DispatchOutcome {
        if !instr.is_primitive() {
            return DispatchOutcome::SubCall { opcode: instr.opcode, operand: instr.operand };
        }
        // Real primitives go here, indexed by `instr.opcode` in 0..=67. Anything we
        // haven't wired yet falls back to the conservative "return true" stub so the
        // BHAV continues forward — this keeps the runner useful for trace exploration
        // while we land primitives one by one.
        match instr.opcode {
            0 => self.exec_sleep(instr.operand),
            2 => self.exec_expression(instr.operand),
            6 => self.exec_change_suit(instr.operand),
            7 => Self::exec_refresh(),
            8 => self.exec_random_number(instr.operand),
            11 => Self::exec_get_distance_to(),
            12 => Self::exec_get_direction_to(),
            13 => self.exec_push_interaction(instr.operand),
            15 => self.exec_break_point(),
            17 => self.exec_idle_for_input(instr.operand),
            18 => self.exec_remove_object_instance(),
            20 => Self::exec_run_functional_tree(instr.operand),
            21 => self.exec_show_string(instr.operand),
            22 => self.exec_look_towards(instr.operand),
            23 => self.exec_play_sound(instr.operand),
            25 => self.exec_transfer_funds(instr.operand),
            27 | 45 | 46 | 47 => self.exec_spatial_request(u8::try_from(instr.opcode).unwrap_or(0), instr.operand),
            28 => self.exec_run_tree_by_name(instr.operand),
            29 => self.exec_set_motive_change(instr.operand),
            32 => self.exec_test_object_type(instr.operand),
            31 => self.exec_set_to_next(instr.operand),
            34 => self.exec_ui_effect(instr.operand),
            35 => self.exec_special_effect(instr.operand),
            36 => self.exec_dialog(DialogFlavour::Private, instr.operand),
            38 => self.exec_dialog(DialogFlavour::Global, instr.operand),
            39 => self.exec_dialog(DialogFlavour::SemiGlobal, instr.operand),
            41 => self.exec_set_balloon(instr.operand),
            42 => self.exec_create_new_object_instance(instr.operand),
            44 => self.exec_animate_sim(instr.operand),
            48 => self.exec_stop_all_sounds(),
            49 => self.exec_notify_out_of_idle(),
            50 => self.exec_set_action_string(instr.operand),
            _ => DispatchOutcome::Branch(true),
        }
    }

    fn exec_sleep(&mut self, operand: [u8; 8]) -> DispatchOutcome {
        let ticks = u16::from_le_bytes([operand[4], operand[5]]);
        self.effects.push(VmEffect::Sleep { ticks, operand });
        DispatchOutcome::Branch(true)
    }

    fn exec_idle_for_input(&mut self, operand: [u8; 8]) -> DispatchOutcome {
        let ticks = u16::from_le_bytes([operand[4], operand[5]]);
        let interruptable = u16::from_le_bytes([operand[6], operand[7]]) != 0;
        self.effects.push(VmEffect::Idle { ticks, interruptable, operand });
        DispatchOutcome::Branch(true)
    }

    /// Primitive 7 — Refresh. Engine-side request to redraw the object's graphic.
    /// Pure no-op as far as the VM is concerned; we don't even bother recording it
    /// as an effect (a redraw doesn't change Sim state).
    const fn exec_refresh() -> DispatchOutcome {
        DispatchOutcome::Branch(true)
    }

    fn exec_play_sound(&mut self, operand: [u8; 8]) -> DispatchOutcome {
        let event_id = u16::from_le_bytes([operand[0], operand[1]]);
        self.effects.push(VmEffect::PlaySound { event_id, operand });
        DispatchOutcome::Branch(true)
    }

    fn exec_animate_sim(&mut self, operand: [u8; 8]) -> DispatchOutcome {
        let anim_id = u16::from_le_bytes([operand[0], operand[1]]);
        self.effects.push(VmEffect::AnimateSim { anim_id, operand });
        DispatchOutcome::Branch(true)
    }

    /// Primitive 8 — Random Number. Operand layout is undocumented in Niotso; we
    /// adopt the canonical "max in u16[0..2], target var in (byte[4] owner, u16[2..4]
    /// data)" reading. The result is `prng() % max` written to the target. Pure
    /// integer math + xorshift64 → deterministic given the seed.
    fn exec_random_number(&mut self, operand: [u8; 8]) -> DispatchOutcome {
        let max = u16::from_le_bytes([operand[0], operand[1]]);
        let lhs_data = u16::from_le_bytes([operand[2], operand[3]]);
        let lhs_owner = operand[4];
        let value = if max == 0 {
            0
        } else {
            i32::try_from(self.prng_next() % u64::from(max)).unwrap_or(0)
        };
        self.write_var(lhs_owner, lhs_data, value);
        DispatchOutcome::Branch(true)
    }

    /// Step the world's xorshift64 PRNG once and return the new state.
    const fn prng_next(&mut self) -> u64 {
        if self.world.rng_state == 0 {
            self.world.rng_state = 0xDEAD_BEEF_CAFE_F00D;
        }
        let mut x = self.world.rng_state;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.world.rng_state = x;
        x
    }

    /// Primitives 11/12 — distance/direction queries. Without engine geometry we
    /// just write `0` to the target var (selected by the operand, ignored for now)
    /// and return true so the BHAV walks past.
    const fn exec_get_distance_to() -> DispatchOutcome {
        DispatchOutcome::Branch(true)
    }

    const fn exec_get_direction_to() -> DispatchOutcome {
        DispatchOutcome::Branch(true)
    }

    /// Primitive 13 — Push Interaction. Records a `PendingInteraction` on the world
    /// queue with operand-derived `action_function`. The actual scheduling is the
    /// engine's job.
    fn exec_push_interaction(&mut self, operand: [u8; 8]) -> DispatchOutcome {
        let action_function = u16::from_le_bytes([operand[0], operand[1]]);
        let joining_index = i32::from(i16::from_le_bytes([operand[2], operand[3]]));
        let (sim_id, stack_object_id) = match self.call_stack.last() {
            Some(f) => (f.my_id, f.stack_object_id),
            None => return DispatchOutcome::Branch(true),
        };
        let pending = PendingInteraction {
            sim_id,
            stack_object_id,
            action_function,
            joining_index,
        };
        self.world.interaction_queue.push(pending);
        self.effects.push(VmEffect::PushInteraction { pending });
        DispatchOutcome::Branch(true)
    }

    fn exec_break_point(&mut self) -> DispatchOutcome {
        let (bhav_id, ip) = self.call_stack.last().map_or((0, 0), |f| (f.bhav_id, f.ip));
        self.effects.push(VmEffect::Breakpoint { bhav_id, ip });
        DispatchOutcome::Branch(true)
    }

    /// Primitive 18 — Remove Object Instance. Drops the stack object from the world.
    fn exec_remove_object_instance(&mut self) -> DispatchOutcome {
        let Some(frame) = self.call_stack.last() else {
            return DispatchOutcome::Branch(true);
        };
        let object_id = frame.stack_object_id;
        self.world.objects.remove(&object_id);
        self.world.sims.remove(&object_id);
        self.effects.push(VmEffect::RemoveObjectInstance { object_id });
        DispatchOutcome::Branch(true)
    }

    /// Primitive 20 — Run Functional Tree. Calls another tree by ID stored in the
    /// operand (typically bytes[0..2]). Behaves like an opcode-≥-256 call but with
    /// no extra args (the operand bytes after the tree id are not part of the call's
    /// argument list).
    const fn exec_run_functional_tree(operand: [u8; 8]) -> DispatchOutcome {
        let tree_id = u16::from_le_bytes([operand[0], operand[1]]);
        DispatchOutcome::SubCall { opcode: tree_id, operand: [0u8; 8] }
    }

    fn exec_show_string(&mut self, operand: [u8; 8]) -> DispatchOutcome {
        let kind = u16::from_le_bytes([operand[0], operand[1]]);
        self.effects.push(VmEffect::ShowString { kind, operand });
        DispatchOutcome::Branch(true)
    }

    fn exec_look_towards(&mut self, operand: [u8; 8]) -> DispatchOutcome {
        self.effects.push(VmEffect::LookTowards { operand });
        DispatchOutcome::Branch(true)
    }

    /// Primitive 25 — Transfer Funds. Operand bytes[0..4] = signed delta (canonical).
    fn exec_transfer_funds(&mut self, operand: [u8; 8]) -> DispatchOutcome {
        let delta = i32::from_le_bytes([operand[0], operand[1], operand[2], operand[3]]);
        self.world.funds = self.world.funds.saturating_add(delta);
        self.effects.push(VmEffect::TransferFunds { delta, operand });
        DispatchOutcome::Branch(true)
    }

    fn exec_spatial_request(&mut self, primitive: u8, operand: [u8; 8]) -> DispatchOutcome {
        self.effects.push(VmEffect::SpatialRequest { primitive, operand });
        DispatchOutcome::Branch(true)
    }

    fn exec_run_tree_by_name(&mut self, operand: [u8; 8]) -> DispatchOutcome {
        let name_index = u16::from_le_bytes([operand[0], operand[1]]);
        self.effects.push(VmEffect::RunTreeByName { name_index, operand });
        DispatchOutcome::Branch(true)
    }

    /// Primitive 29 — Set Motive Change. Updates a Sim's motive directly.
    /// Operand: bytes[0..2] = motive index, bytes[2..4] = signed delta-per-tick.
    /// Without a scheduler we apply the delta once and record it.
    fn exec_set_motive_change(&mut self, operand: [u8; 8]) -> DispatchOutcome {
        let motive_index = usize::from(u16::from_le_bytes([operand[0], operand[1]]));
        let delta = i32::from(i16::from_le_bytes([operand[2], operand[3]]));
        let Some(frame) = self.call_stack.last() else {
            return DispatchOutcome::Branch(true);
        };
        let target = frame.stack_object_id;
        let current = self.world.read_motive(target, motive_index);
        self.world.write_motive(target, motive_index, current.saturating_add(delta));
        DispatchOutcome::Branch(true)
    }

    /// Primitive 31 — Set to Next. Iterates through objects matching a filter; the
    /// canonical effect is "find the next object after `stack_object_id` whose GUID
    /// matches `operand[0..4]` and assign it to `stack_object_id`". Returns false
    /// when there is no next match. We implement a simple `BTreeMap` walk.
    fn exec_set_to_next(&mut self, operand: [u8; 8]) -> DispatchOutcome {
        let target_guid = u32::from_le_bytes([operand[0], operand[1], operand[2], operand[3]]);
        let Some(frame) = self.call_stack.last() else {
            return DispatchOutcome::Branch(false);
        };
        let current = frame.stack_object_id;
        let next = self
            .world
            .objects
            .range((current + 1)..)
            .find(|(_, obj)| target_guid == 0 || obj.guid == target_guid)
            .map(|(id, _)| *id);
        match next {
            Some(id) => {
                if let Some(frame) = self.call_stack.last_mut() {
                    frame.stack_object_id = id;
                }
                DispatchOutcome::Branch(true)
            }
            None => DispatchOutcome::Branch(false),
        }
    }

    fn exec_ui_effect(&mut self, operand: [u8; 8]) -> DispatchOutcome {
        let kind = u16::from_le_bytes([operand[0], operand[1]]);
        self.effects.push(VmEffect::UiEffect { kind, operand });
        DispatchOutcome::Branch(true)
    }

    fn exec_special_effect(&mut self, operand: [u8; 8]) -> DispatchOutcome {
        let kind = u16::from_le_bytes([operand[0], operand[1]]);
        self.effects.push(VmEffect::SpecialEffect { kind, operand });
        DispatchOutcome::Branch(true)
    }

    fn exec_dialog(&mut self, flavour: DialogFlavour, operand: [u8; 8]) -> DispatchOutcome {
        let string_index = u16::from_le_bytes([operand[0], operand[1]]);
        self.effects.push(VmEffect::Dialog { flavour, string_index, operand });
        DispatchOutcome::Branch(true)
    }

    fn exec_set_balloon(&mut self, operand: [u8; 8]) -> DispatchOutcome {
        let kind = u16::from_le_bytes([operand[0], operand[1]]);
        self.effects.push(VmEffect::SetBalloon { kind, operand });
        DispatchOutcome::Branch(true)
    }

    /// Primitive 42 — Create New Object Instance. Allocates a fresh world ID and
    /// records the GUID from operand[0..4]. The instance's attribute table is
    /// initialised to empty.
    fn exec_create_new_object_instance(&mut self, operand: [u8; 8]) -> DispatchOutcome {
        let guid = u32::from_le_bytes([operand[0], operand[1], operand[2], operand[3]]);
        let new_id = self
            .world
            .objects
            .keys()
            .max()
            .copied()
            .unwrap_or(0x1000_0000)
            .saturating_add(1);
        self.world.objects.insert(
            new_id,
            ObjectInstance {
                guid,
                ..ObjectInstance::default()
            },
        );
        self.effects.push(VmEffect::CreateObjectInstance { guid, new_object_id: new_id });
        DispatchOutcome::Branch(true)
    }

    fn exec_change_suit(&mut self, operand: [u8; 8]) -> DispatchOutcome {
        let suit_id = u16::from_le_bytes([operand[0], operand[1]]);
        self.effects.push(VmEffect::ChangeSuit { suit_id, operand });
        DispatchOutcome::Branch(true)
    }

    fn exec_stop_all_sounds(&mut self) -> DispatchOutcome {
        self.effects.push(VmEffect::StopAllSounds);
        DispatchOutcome::Branch(true)
    }

    fn exec_notify_out_of_idle(&mut self) -> DispatchOutcome {
        let sim_id = self.call_stack.last().map_or(0, |f| f.stack_object_id);
        self.effects.push(VmEffect::NotifyOutOfIdle { sim_id });
        DispatchOutcome::Branch(true)
    }

    fn exec_set_action_string(&mut self, operand: [u8; 8]) -> DispatchOutcome {
        let string_index = u16::from_le_bytes([operand[0], operand[1]]);
        self.effects.push(VmEffect::SetActionString { string_index, operand });
        DispatchOutcome::Branch(true)
    }

    /// Primitive 32 — Test Object Type. Compares the stack object's GUID to one
    /// encoded in the operand bytes[0..4]. Returns true on match. Default-zero GUID
    /// is treated as "any object" (matches if a stack object exists at all).
    fn exec_test_object_type(&self, operand: [u8; 8]) -> DispatchOutcome {
        let expected = u32::from_le_bytes([operand[0], operand[1], operand[2], operand[3]]);
        let Some(frame) = self.call_stack.last() else {
            return DispatchOutcome::Branch(false);
        };
        let actual = self.world.objects.get(&frame.stack_object_id).map_or(0, |o| o.guid);
        DispatchOutcome::Branch(expected == 0 || actual == expected)
    }

    fn exec_expression(&mut self, operand: [u8; 8]) -> DispatchOutcome {
        let op = ExpressionOperand::decode(&operand);
        let Some(operator) = ExpressionOp::from_byte(op.operator) else {
            // Unknown operator: act like a no-op test that succeeds. Surfaces as the
            // `t_dest` branch but the malformed-operand case is rare enough that we
            // log it via the trace rather than a hard error.
            return DispatchOutcome::Branch(true);
        };
        let lhs = self.read_var(op.lhs_owner, op.lhs_data);
        let rhs = self.read_var(op.rhs_owner, op.rhs_data);
        let (result, written) = compute_expression(operator, lhs, rhs);
        if let Some(value) = written {
            self.write_var(op.lhs_owner, op.lhs_data, value);
        }
        DispatchOutcome::Branch(result)
    }

    fn read_var(&self, owner: u8, data: u16) -> i32 {
        let Some(frame) = self.call_stack.last() else {
            return 0;
        };
        let i = usize::from(data);
        match owner {
            0 => self.world.read_object_attr(frame.my_id, i),
            1 => self.world.read_object_attr(frame.stack_object_id, i),
            6 => self.world.globals.get(i).copied().unwrap_or(0),
            7 => i32::from(i16::from_le_bytes(data.to_le_bytes())),
            8 => self.world.temps.get(i).copied().unwrap_or(0),
            9 => frame.params.get(i).copied().unwrap_or(0),
            10 => i32::from_le_bytes(frame.stack_object_id.to_le_bytes()),
            14 => self.world.read_motive(frame.my_id, i),
            15 => self.world.read_motive(frame.stack_object_id, i),
            18 => self.world.read_person_data(frame.my_id, i),
            19 => self.world.read_person_data(frame.stack_object_id, i),
            25 => frame.locals.get(i).copied().unwrap_or(0),
            26 => self
                .world
                .objects
                .get(&frame.stack_object_id)
                .and_then(|o| o.tuning.get(i).copied())
                .unwrap_or(0),
            36 => self
                .world
                .objects
                .get(&frame.my_id)
                .and_then(|o| o.type_attributes.get(i).copied())
                .unwrap_or(0),
            37 => self
                .world
                .objects
                .get(&frame.stack_object_id)
                .and_then(|o| o.type_attributes.get(i).copied())
                .unwrap_or(0),
            // Other scopes return 0 until we wire their semantics. The trace exposes
            // the (owner, data) pair so we can spot which scopes need backing first.
            _ => 0,
        }
    }

    fn write_var(&mut self, owner: u8, data: u16, value: i32) {
        let (my_id, stack_object_id) = match self.call_stack.last() {
            Some(f) => (f.my_id, f.stack_object_id),
            None => return,
        };
        let i = usize::from(data);
        match owner {
            0 => self.world.write_object_attr(my_id, i, value),
            1 => self.world.write_object_attr(stack_object_id, i, value),
            6 => {
                if self.world.globals.len() <= i {
                    self.world.globals.resize(i + 1, 0);
                }
                if let Some(slot) = self.world.globals.get_mut(i) {
                    *slot = value;
                }
            }
            8 => {
                if let Some(slot) = self.world.temps.get_mut(i) {
                    *slot = value;
                }
            }
            9 => {
                if let Some(frame) = self.call_stack.last_mut() {
                    if let Some(slot) = frame.params.get_mut(i) {
                        *slot = value;
                    }
                }
            }
            14 => self.world.write_motive(my_id, i, value),
            15 => self.world.write_motive(stack_object_id, i, value),
            18 => {
                let sim = self.world.sims.entry(my_id).or_default();
                if sim.person_data.len() <= i {
                    sim.person_data.resize(i + 1, 0);
                }
                if let Some(slot) = sim.person_data.get_mut(i) {
                    *slot = value;
                }
            }
            19 => {
                let sim = self.world.sims.entry(stack_object_id).or_default();
                if sim.person_data.len() <= i {
                    sim.person_data.resize(i + 1, 0);
                }
                if let Some(slot) = sim.person_data.get_mut(i) {
                    *slot = value;
                }
            }
            25 => {
                if let Some(frame) = self.call_stack.last_mut() {
                    if let Some(slot) = frame.locals.get_mut(i) {
                        *slot = value;
                    }
                }
            }
            36 => {
                let obj = self.world.objects.entry(my_id).or_default();
                if obj.type_attributes.len() <= i {
                    obj.type_attributes.resize(i + 1, 0);
                }
                if let Some(slot) = obj.type_attributes.get_mut(i) {
                    *slot = value;
                }
            }
            37 => {
                let obj = self.world.objects.entry(stack_object_id).or_default();
                if obj.type_attributes.len() <= i {
                    obj.type_attributes.resize(i + 1, 0);
                }
                if let Some(slot) = obj.type_attributes.get_mut(i) {
                    *slot = value;
                }
            }
            // 7 = literal: writing to a literal is undefined; silently drop.
            // Other scopes: not yet wired (slots, jobs, etc.).
            _ => {}
        }
    }

    fn follow_branch(
        &mut self,
        instr: Instruction,
        value: bool,
        count: u16,
    ) -> Result<StepOutcome, VmError> {
        let dest = if value { instr.t_dest } else { instr.f_dest };
        match dest {
            Instruction::RETURN_TRUE => {
                self.call_stack.pop();
                Ok(StepOutcome::Returned(true))
            }
            Instruction::RETURN_FALSE => {
                self.call_stack.pop();
                Ok(StepOutcome::Returned(false))
            }
            Instruction::RETURN_ERROR => Ok(StepOutcome::Error),
            target => {
                if u16::from(target) >= count {
                    return Err(VmError::UnknownBranch {
                        opcode: instr.opcode,
                        dest: target,
                    });
                }
                let frame = self
                    .call_stack
                    .last_mut()
                    .ok_or(VmError::StackOverflow { depth: 0 })?;
                frame.ip = u16::from(target);
                Ok(StepOutcome::Continue)
            }
        }
    }

    fn subroutine_call(&mut self, opcode: u16, operand: [u8; 8]) -> Result<StepOutcome, VmError> {
        if self.call_stack.len() >= self.max_depth {
            return Err(VmError::StackOverflow {
                depth: self.call_stack.len(),
            });
        }
        let bytes = self.source.lookup(opcode).ok_or(VmError::BhavNotFound(opcode))?;
        let callee = Bhav::parse(bytes)?;
        // Decode the call instruction's 8-byte operand into `callee.header.args`
        // i32 parameters. The TS1 convention (per FreeSO/Simitone reverse) treats
        // the operand as a packed array of i8 values, one per parameter, sign-
        // extended to i32. The all-`0xFF` operand commonly seen in disassembly
        // is the canonical "no arguments needed" sentinel and decodes naturally
        // to `[-1, -1, …]` — harmless when `args == 0`.
        let arg_count = usize::from(callee.header.args).min(8);
        let mut params = Vec::with_capacity(arg_count);
        for &raw in &operand[..arg_count] {
            params.push(i32::from(i8::from_le_bytes([raw])));
        }
        let parent = self.call_stack.last().ok_or(VmError::StackOverflow { depth: 0 })?;
        let frame = StackFrame::new(
            opcode,
            callee.header.locals,
            params,
            parent.my_id,
            parent.stack_object_id,
        );
        self.call_stack.push(frame);
        Ok(StepOutcome::Continue)
    }

    /// Pop the next [`PendingInteraction`] from `world.interaction_queue` (FIFO) and
    /// run it.
    ///
    /// If the interaction has a `joining_index >= 0`, that BHAV is invoked first as a
    /// guard: only when it returns `true` does the action function run. Returns
    /// [`TickOutcome::Idle`] when the queue is empty.
    ///
    /// The scheduler is intentionally minimal: real engine semantics include priority,
    /// pre-emption, and the concept of an "active" interaction per Sim. We pop, test,
    /// run — that's it. Enough to drive a BHAV from the queue end-to-end.
    ///
    /// # Errors
    ///
    /// Propagates [`VmError`] from the joining or action call (missing BHAV, malformed
    /// bytecode, IP out of bounds, stack overflow).
    pub fn tick(&mut self) -> Result<TickOutcome, VmError> {
        if self.world.interaction_queue.is_empty() {
            return Ok(TickOutcome::Idle);
        }
        let pending = self.world.interaction_queue.remove(0);
        if pending.joining_index >= 0 {
            // joining_index encodes the guard tree id; out-of-range u16 just means
            // there's no guard (the engine's all-bits-1 sentinel decodes as -1).
            if let Ok(joining_id) = u16::try_from(pending.joining_index) {
                let result = self.call(
                    joining_id,
                    Vec::new(),
                    pending.sim_id,
                    pending.stack_object_id,
                )?;
                if !matches!(result, ExecResult::Returned(true)) {
                    return Ok(TickOutcome::Skipped(pending));
                }
            }
        }
        let result = self.call(
            pending.action_function,
            Vec::new(),
            pending.sim_id,
            pending.stack_object_id,
        )?;
        Ok(TickOutcome::Ran(pending, result))
    }

    /// Drive [`Vm::tick`] until the queue is empty or `max_ticks` have run.
    ///
    /// Returns the number of ticks consumed (including [`TickOutcome::Skipped`]).
    /// Useful as the entry-point for a "run this lot for N ticks" harness.
    ///
    /// # Errors
    ///
    /// Propagates [`VmError`] from the first tick that fails.
    pub fn run_until_idle(&mut self, max_ticks: usize) -> Result<usize, VmError> {
        let mut ran = 0usize;
        while ran < max_ticks {
            match self.tick()? {
                TickOutcome::Idle => return Ok(ran),
                TickOutcome::Skipped(_) | TickOutcome::Ran(..) => ran += 1,
            }
        }
        Ok(ran)
    }

    fn resume_parent(&mut self, callee_value: bool) -> Result<StepOutcome, VmError> {
        let parent = self
            .call_stack
            .last()
            .ok_or(VmError::StackOverflow { depth: 0 })?;
        let bytes = self.source.lookup(parent.bhav_id).ok_or(VmError::BhavNotFound(parent.bhav_id))?;
        let bhav = Bhav::parse(bytes)?;
        if parent.ip >= bhav.header.count {
            return Err(VmError::IpOutOfBounds {
                bhav_id: parent.bhav_id,
                ip: parent.ip,
                count: bhav.header.count,
            });
        }
        #[allow(clippy::indexing_slicing)]
        let instr = bhav.instructions[parent.ip as usize];
        self.follow_branch(instr, callee_value, bhav.header.count)
    }
}

/// Evaluate an Expression operator against `(lhs, rhs)`.
///
/// Returns `(result, written)`:
/// - `result` is the boolean reported back to the BHAV (`t_dest` branch on `true`,
///   `f_dest` on `false`).
/// - `written` is `Some(new_lhs)` when the operator mutates the LHS slot; the caller
///   stores that back into the LHS scope. Pure comparisons return `None`.
#[must_use]
pub const fn compute_expression(op: ExpressionOp, lhs: i32, rhs: i32) -> (bool, Option<i32>) {
    use ExpressionOp::{
        AddAssign, AndAssign, Assign, ClearFlag, DecThenGt, DivAssign, Eq, Ge, Gt, IncThenLt,
        IsFlagSet, Le, Lt, ModAssign, MulAssign, Ne, Pop, Push, SetFlag, SubAssign,
    };
    match op {
        Gt => (lhs > rhs, None),
        Lt => (lhs < rhs, None),
        Eq => (lhs == rhs, None),
        Ge => (lhs >= rhs, None),
        Le => (lhs <= rhs, None),
        Ne => (lhs != rhs, None),
        Assign => (true, Some(rhs)),
        AddAssign => (true, Some(lhs.wrapping_add(rhs))),
        SubAssign => (true, Some(lhs.wrapping_sub(rhs))),
        MulAssign => (true, Some(lhs.wrapping_mul(rhs))),
        DivAssign => {
            if rhs == 0 {
                (false, None)
            } else {
                (true, Some(lhs.wrapping_div(rhs)))
            }
        }
        ModAssign => {
            if rhs == 0 {
                (false, None)
            } else {
                (true, Some(lhs.wrapping_rem(rhs)))
            }
        }
        AndAssign => (true, Some(lhs & rhs)),
        IsFlagSet => {
            // bit `rhs` of `lhs` set?
            let bit = rhs & 31;
            (((lhs >> bit) & 1) != 0, None)
        }
        SetFlag => {
            let bit = rhs & 31;
            (true, Some(lhs | (1 << bit)))
        }
        ClearFlag => {
            let bit = rhs & 31;
            (true, Some(lhs & !(1 << bit)))
        }
        IncThenLt => {
            let new_lhs = lhs.wrapping_add(1);
            (new_lhs < rhs, Some(new_lhs))
        }
        DecThenGt => {
            let new_lhs = lhs.wrapping_sub(1);
            (new_lhs > rhs, Some(new_lhs))
        }
        // Push/Pop interact with a runtime stack we don't model yet; treat them as
        // truthy no-ops so the BHAV continues forward instead of erroring out.
        Push | Pop => (true, None),
    }
}

#[derive(Debug, Clone, Copy)]
enum DispatchOutcome {
    /// Primitive completed with the given truth value; follow `t_dest` / `f_dest`.
    Branch(bool),
    /// Subroutine call — `opcode` is the callee's chunk ID, `operand` carries the
    /// caller's 8 bytes which encode the args to pass to the callee.
    SubCall { opcode: u16, operand: [u8; 8] },
}

#[derive(Debug, Clone, Copy)]
enum StepOutcome {
    Continue,
    Returned(bool),
    Error,
}

/// Render the 8-byte operand of a primitive in a human-readable form.
///
/// Returns `None` for primitives whose operand layout we don't decode yet (the
/// disassembler falls back to printing the raw hex bytes in that case). For the
/// six primitives we currently know — Sleep, Expression, Refresh, Idle for input,
/// Play Sound Event, Animate Sim — we format the operand fields as named values
/// so traces and disassembly are self-documenting.
///
/// Caveat: layouts for Animate Sim and Play Sound Event aren't documented in
/// Niotso, so the rendered fields are best-guess from observed `AlarmClock` data.
/// They round-trip the raw operand back through `format!("op=...")` for fidelity.
///
/// Refresh (#7) intentionally falls through to the wildcard arm — it has no operand
/// semantics worth labelling (engine-side redraw flag).
#[must_use]
pub fn format_primitive_operand(opcode: u16, operand: [u8; 8]) -> Option<String> {
    let u16_lo = || u16::from_le_bytes([operand[0], operand[1]]);
    let u32_lo = || u32::from_le_bytes([operand[0], operand[1], operand[2], operand[3]]);
    let i16_at = |i: usize| i16::from_le_bytes([operand[i], operand[i + 1]]);
    match opcode {
        0 => Some(alloc::format!("ticks={}", u16::from_le_bytes([operand[4], operand[5]]))),
        2 => Some(format_expression_operand(operand)),
        6 => Some(alloc::format!("suit=0x{:04X}", u16_lo())),
        8 => Some(alloc::format!(
            "max={} → {}[{}]",
            u16_lo(),
            scope_name(u16::from(operand[4])).unwrap_or("?"),
            u16::from_le_bytes([operand[2], operand[3]])
        )),
        13 => Some(alloc::format!("push tree=0x{:04X} joining={}", u16_lo(), i16_at(2))),
        17 => {
            let ticks = u16::from_le_bytes([operand[4], operand[5]]);
            let interruptable = u16::from_le_bytes([operand[6], operand[7]]) != 0;
            Some(alloc::format!("ticks={ticks} interruptable={interruptable}"))
        }
        20 => Some(alloc::format!("tree=0x{:04X}", u16_lo())),
        21 => Some(alloc::format!("show string kind={}", u16_lo())),
        23 => Some(alloc::format!("event=0x{:04X}", u16_lo())),
        25 => Some(alloc::format!(
            "delta={}§",
            i32::from_le_bytes([operand[0], operand[1], operand[2], operand[3]])
        )),
        28 => Some(alloc::format!("name=#{}", u16_lo())),
        29 => Some(alloc::format!("motive[{}] += {}/tick", u16_lo(), i16_at(2))),
        31 => Some(alloc::format!("next guid=0x{:08X}", u32_lo())),
        32 => Some(alloc::format!("type==0x{:08X}", u32_lo())),
        34 => Some(alloc::format!("ui kind={}", u16_lo())),
        35 => Some(alloc::format!("fx kind={}", u16_lo())),
        36 => Some(alloc::format!("dialog priv #{}", u16_lo())),
        38 => Some(alloc::format!("dialog glob #{}", u16_lo())),
        39 => Some(alloc::format!("dialog semi #{}", u16_lo())),
        41 => Some(alloc::format!("balloon kind={}", u16_lo())),
        42 => Some(alloc::format!("create guid=0x{:08X}", u32_lo())),
        44 => Some(alloc::format!("anim=0x{:04X}", u16_lo())),
        50 => Some(alloc::format!("action str=#{}", u16_lo())),
        // 7 (Refresh), 15 (Break Point), 18 (Remove), 48 (Stop ALL Sounds),
        // 49 (Notify Out of Idle): no operand semantics worth labelling.
        _ => None,
    }
}

fn format_expression_operand(operand: [u8; 8]) -> String {
    let op = ExpressionOperand::decode(&operand);
    let lhs = format_var_ref(op.lhs_owner, op.lhs_data);
    let rhs = format_var_ref(op.rhs_owner, op.rhs_data);
    let op_str = match ExpressionOp::from_byte(op.operator) {
        Some(ExpressionOp::Gt) => ">",
        Some(ExpressionOp::Lt) => "<",
        Some(ExpressionOp::Eq) => "==",
        Some(ExpressionOp::Ge) => ">=",
        Some(ExpressionOp::Le) => "<=",
        Some(ExpressionOp::Ne) => "!=",
        Some(ExpressionOp::Assign) => "=",
        Some(ExpressionOp::AddAssign) => "+=",
        Some(ExpressionOp::SubAssign) => "-=",
        Some(ExpressionOp::MulAssign) => "*=",
        Some(ExpressionOp::DivAssign) => "/=",
        Some(ExpressionOp::ModAssign) => "%=",
        Some(ExpressionOp::AndAssign) => "&=",
        Some(ExpressionOp::IsFlagSet) => "?bit",
        Some(ExpressionOp::SetFlag) => "|=bit",
        Some(ExpressionOp::ClearFlag) => "&=~bit",
        Some(ExpressionOp::IncThenLt) => "++<",
        Some(ExpressionOp::DecThenGt) => "--<",
        Some(ExpressionOp::Push) => "push",
        Some(ExpressionOp::Pop) => "pop",
        None => return alloc::format!("expr op=0x{:02X} ({lhs}, {rhs})", op.operator),
    };
    alloc::format!("{lhs} {op_str} {rhs}")
}

fn format_var_ref(owner: u8, data: u16) -> String {
    if owner == 7 {
        // Literal: display the signed value directly.
        let signed = i16::from_le_bytes(data.to_le_bytes());
        return alloc::format!("literal({signed})");
    }
    if owner == 10 {
        return "stack_obj_id".into();
    }
    let scope = scope_name(u16::from(owner)).unwrap_or("?");
    alloc::format!("{scope}[{data}]")
}

/// Render a [`TraceEntry`] for debugger output. Standalone so `Vm` itself doesn't depend
/// on `String` formatting in `core`.
#[must_use]
pub fn fmt_trace_entry(entry: &TraceEntry) -> String {
    use core::fmt::Write;
    let mut buf = String::new();
    let _ = write!(
        &mut buf,
        "{indent}[{depth}] BHAV 0x{bhav:04X} ip={ip} op=0x{op:04X} → ",
        indent = "  ".repeat(entry.depth),
        depth = entry.depth,
        bhav = entry.bhav_id,
        ip = entry.ip,
        op = entry.opcode,
    );
    match entry.branch_taken {
        TraceBranch::Continue(target) => {
            let _ = write!(&mut buf, "→{target}");
        }
        TraceBranch::Returned(true) => buf.push_str("RET_TRUE"),
        TraceBranch::Returned(false) => buf.push_str("RET_FALSE"),
        TraceBranch::Error => buf.push_str("RET_ERR"),
    }
    buf
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::similar_names,
)]
mod tests {
    use super::*;

    /// Build a minimal v8002 BHAV with `instructions` and zero locals/args.
    fn bhav(instructions: &[(u16, u8, u8)]) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(&0x8002u16.to_le_bytes());
        buf.extend_from_slice(&u16::try_from(instructions.len()).unwrap().to_le_bytes());
        buf.extend_from_slice(&[0u8; 4]); // type/args/locals/flags
        buf.extend_from_slice(&0u32.to_le_bytes()); // extra
        for &(opcode, t, f) in instructions {
            buf.extend_from_slice(&opcode.to_le_bytes());
            buf.push(t);
            buf.push(f);
            buf.extend_from_slice(&[0u8; 8]);
        }
        buf
    }

    fn source(map: &[(u16, Vec<u8>)]) -> InMemoryBhavSource {
        let mut s = InMemoryBhavSource::default();
        for (id, bytes) in map {
            s.bhavs.insert(*id, bytes.clone());
        }
        s
    }

    /// Use opcode `0x0007` (Refresh) for VM-plumbing tests — it's a primitive that
    /// remains a stub returning `true`, so we exercise the dispatch loop without
    /// also depending on Expression operand semantics.
    const STUB_PRIM: u16 = 0x0007;

    #[test]
    fn linear_walk_returns_true() {
        // Two primitives, both fall through their t_dest into the next instruction;
        // the second returns true.
        let body = bhav(&[
            (STUB_PRIM, 1, Instruction::RETURN_ERROR),
            (STUB_PRIM, Instruction::RETURN_TRUE, Instruction::RETURN_ERROR),
        ]);
        let src = source(&[(0x1000, body)]);
        let mut vm = Vm::new(&src);
        let result = vm.call(0x1000, Vec::new(), 0, 0).unwrap();
        assert_eq!(result, ExecResult::Returned(true));
    }

    #[test]
    fn return_false_sentinel() {
        let body = bhav(&[(STUB_PRIM, Instruction::RETURN_FALSE, Instruction::RETURN_ERROR)]);
        let src = source(&[(0x1000, body)]);
        let mut vm = Vm::new(&src);
        // Stub primitives always return true → t_dest is taken → RET_FALSE.
        assert_eq!(vm.call(0x1000, Vec::new(), 0, 0).unwrap(), ExecResult::Returned(false));
    }

    #[test]
    fn subroutine_call_then_return() {
        // Caller calls 0x1001, then returns whatever the callee returned via t_dest.
        let caller = bhav(&[(0x1001, Instruction::RETURN_TRUE, Instruction::RETURN_FALSE)]);
        let callee = bhav(&[(STUB_PRIM, Instruction::RETURN_TRUE, Instruction::RETURN_ERROR)]);
        let src = source(&[(0x1000, caller), (0x1001, callee)]);
        let mut vm = Vm::new(&src);
        assert_eq!(vm.call(0x1000, Vec::new(), 0, 0).unwrap(), ExecResult::Returned(true));
    }

    #[test]
    fn missing_bhav_errors() {
        let src = source(&[]);
        let mut vm = Vm::new(&src);
        assert!(matches!(vm.call(0x9999, Vec::new(), 0, 0), Err(VmError::BhavNotFound(0x9999))));
    }

    #[test]
    fn step_budget_caps_runaway() {
        // Loop: instruction 0 jumps to itself on its t_dest.
        let body = bhav(&[(STUB_PRIM, 0, Instruction::RETURN_ERROR)]);
        let src = source(&[(0x1000, body)]);
        let mut vm = Vm::new(&src);
        vm.step_budget = 1000;
        assert_eq!(vm.call(0x1000, Vec::new(), 0, 0).unwrap(), ExecResult::BudgetExhausted);
    }

    #[test]
    fn compute_expression_comparisons() {
        assert_eq!(compute_expression(ExpressionOp::Eq, 5, 5), (true, None));
        assert_eq!(compute_expression(ExpressionOp::Eq, 5, 6), (false, None));
        assert_eq!(compute_expression(ExpressionOp::Lt, 5, 6), (true, None));
        assert_eq!(compute_expression(ExpressionOp::Ge, 5, 5), (true, None));
        assert_eq!(compute_expression(ExpressionOp::Ne, 5, 6), (true, None));
    }

    #[test]
    fn compute_expression_assignments() {
        assert_eq!(compute_expression(ExpressionOp::Assign, 0, 42), (true, Some(42)));
        assert_eq!(compute_expression(ExpressionOp::AddAssign, 5, 3), (true, Some(8)));
        assert_eq!(compute_expression(ExpressionOp::SubAssign, 5, 3), (true, Some(2)));
        assert_eq!(compute_expression(ExpressionOp::MulAssign, 5, 3), (true, Some(15)));
        assert_eq!(compute_expression(ExpressionOp::DivAssign, 9, 0), (false, None));
        assert_eq!(compute_expression(ExpressionOp::DivAssign, 9, 3), (true, Some(3)));
    }

    #[test]
    fn compute_expression_flags() {
        assert_eq!(compute_expression(ExpressionOp::IsFlagSet, 0b0100, 2), (true, None));
        assert_eq!(compute_expression(ExpressionOp::IsFlagSet, 0b0100, 1), (false, None));
        assert_eq!(compute_expression(ExpressionOp::SetFlag, 0, 3), (true, Some(0b1000)));
        assert_eq!(compute_expression(ExpressionOp::ClearFlag, 0b0110, 2), (true, Some(0b0010)));
    }

    #[test]
    fn compute_expression_inc_then_lt() {
        assert_eq!(compute_expression(ExpressionOp::IncThenLt, 4, 6), (true, Some(5)));
        assert_eq!(compute_expression(ExpressionOp::IncThenLt, 5, 6), (false, Some(6)));
    }

    #[test]
    fn vm_expression_assigns_to_temp() {
        // Operand: lhs_data=0 (temp[0]), rhs_data=42 (literal), op=5 (=), lhs_owner=8 (temps),
        // rhs_owner=7 (literal). Decoded: temp[0] = 42; result = true.
        let mut buf = Vec::new();
        buf.extend_from_slice(&0x8002u16.to_le_bytes());
        buf.extend_from_slice(&1u16.to_le_bytes());
        buf.extend_from_slice(&[0u8; 4]);
        buf.extend_from_slice(&0u32.to_le_bytes());
        // instruction: opcode=2 Expression, t=RET_TRUE f=RET_ERR, operand
        buf.extend_from_slice(&2u16.to_le_bytes());
        buf.push(Instruction::RETURN_TRUE);
        buf.push(Instruction::RETURN_ERROR);
        // operand
        buf.extend_from_slice(&0u16.to_le_bytes()); // lhs_data
        buf.extend_from_slice(&42u16.to_le_bytes()); // rhs_data
        buf.push(0); // is_signed
        buf.push(5); // op = Assign
        buf.push(8); // lhs_owner = temps
        buf.push(7); // rhs_owner = literal
        let src = source(&[(0x1000, buf)]);
        let mut vm = Vm::new(&src);
        let result = vm.call(0x1000, Vec::new(), 0, 0).unwrap();
        assert_eq!(result, ExecResult::Returned(true));
        assert_eq!(vm.world.temps[0], 42);
    }

    #[test]
    fn vm_expression_compares_param_to_literal() {
        // Build: if param[0] == 0 then RET_TRUE else RET_FALSE.
        let mut buf = Vec::new();
        buf.extend_from_slice(&0x8002u16.to_le_bytes());
        buf.extend_from_slice(&1u16.to_le_bytes());
        buf.extend_from_slice(&[0, 1, 0, 0]); // type/args/locals/flags — args=1
        buf.extend_from_slice(&0u32.to_le_bytes());
        buf.extend_from_slice(&2u16.to_le_bytes()); // opcode 2 Expression
        buf.push(Instruction::RETURN_TRUE); // t
        buf.push(Instruction::RETURN_FALSE); // f
        buf.extend_from_slice(&0u16.to_le_bytes()); // lhs_data = 0 (param index)
        buf.extend_from_slice(&0u16.to_le_bytes()); // rhs_data = 0
        buf.push(0);
        buf.push(2); // op = Eq
        buf.push(9); // lhs_owner = parameters
        buf.push(7); // rhs_owner = literal
        let src = source(&[(0x1000, buf)]);
        let mut vm = Vm::new(&src);
        // First call: param=0, expect Returned(true)
        let r1 = vm.call(0x1000, alloc::vec![0], 0, 0).unwrap();
        assert_eq!(r1, ExecResult::Returned(true));
        // Second call: param=5, expect Returned(false)
        let r2 = vm.call(0x1000, alloc::vec![5], 0, 0).unwrap();
        assert_eq!(r2, ExecResult::Returned(false));
    }

    #[test]
    fn sleep_records_ticks_effect() {
        // Primitive 0 (Sleep) with operand bytes[4..6] = 20, then RET_TRUE.
        let mut buf = Vec::new();
        buf.extend_from_slice(&0x8002u16.to_le_bytes());
        buf.extend_from_slice(&1u16.to_le_bytes());
        buf.extend_from_slice(&[0u8; 4]);
        buf.extend_from_slice(&0u32.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes()); // opcode 0 = Sleep
        buf.push(Instruction::RETURN_TRUE);
        buf.push(Instruction::RETURN_ERROR);
        buf.extend_from_slice(&[0, 0, 0, 0, 20, 0, 0, 0]); // ticks = 20 at offset 4
        let src = source(&[(0x1000, buf)]);
        let mut vm = Vm::new(&src);
        let result = vm.call(0x1000, Vec::new(), 0, 0).unwrap();
        assert_eq!(result, ExecResult::Returned(true));
        assert_eq!(vm.effects.len(), 1);
        match vm.effects[0] {
            VmEffect::Sleep { ticks, .. } => assert_eq!(ticks, 20),
            ref other => panic!("expected Sleep, got {other:?}"),
        }
    }

    #[test]
    fn idle_for_input_records_interruptable_flag() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&0x8002u16.to_le_bytes());
        buf.extend_from_slice(&1u16.to_le_bytes());
        buf.extend_from_slice(&[0u8; 4]);
        buf.extend_from_slice(&0u32.to_le_bytes());
        buf.extend_from_slice(&17u16.to_le_bytes()); // opcode 17 = idle for input
        buf.push(Instruction::RETURN_TRUE);
        buf.push(Instruction::RETURN_ERROR);
        // ticks = 5 @ 4..6, interruptable = 1 @ 6..8
        buf.extend_from_slice(&[0, 0, 0, 0, 5, 0, 1, 0]);
        let src = source(&[(0x1000, buf)]);
        let mut vm = Vm::new(&src);
        vm.call(0x1000, Vec::new(), 0, 0).unwrap();
        match vm.effects[0] {
            VmEffect::Idle { ticks, interruptable, .. } => {
                assert_eq!(ticks, 5);
                assert!(interruptable);
            }
            ref other => panic!("expected Idle, got {other:?}"),
        }
    }

    #[test]
    fn animate_sim_and_play_sound_record_operands() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&0x8002u16.to_le_bytes());
        buf.extend_from_slice(&2u16.to_le_bytes()); // 2 instructions
        buf.extend_from_slice(&[0u8; 4]);
        buf.extend_from_slice(&0u32.to_le_bytes());
        // ip 0: opcode 44 Animate Sim, t=1 f=ERR, anim_id=0x1234
        buf.extend_from_slice(&44u16.to_le_bytes());
        buf.push(1);
        buf.push(Instruction::RETURN_ERROR);
        buf.extend_from_slice(&[0x34, 0x12, 0, 0, 0, 0, 0, 0]);
        // ip 1: opcode 23 Play Sound Event, t=RET_TRUE f=ERR, event_id=0x00AB
        buf.extend_from_slice(&23u16.to_le_bytes());
        buf.push(Instruction::RETURN_TRUE);
        buf.push(Instruction::RETURN_ERROR);
        buf.extend_from_slice(&[0xAB, 0x00, 0, 0, 0, 0, 0, 0]);
        let src = source(&[(0x1000, buf)]);
        let mut vm = Vm::new(&src);
        vm.call(0x1000, Vec::new(), 0, 0).unwrap();
        assert_eq!(vm.effects.len(), 2);
        assert!(matches!(vm.effects[0], VmEffect::AnimateSim { anim_id: 0x1234, .. }));
        assert!(matches!(vm.effects[1], VmEffect::PlaySound { event_id: 0x00AB, .. }));
    }

    #[test]
    fn format_primitive_operand_decodes_known_primitives() {
        // Sleep #0
        assert_eq!(
            format_primitive_operand(0, [0, 0, 0, 0, 20, 0, 0, 0]).as_deref(),
            Some("ticks=20")
        );
        // Idle for input #17 with interruptable=true
        assert_eq!(
            format_primitive_operand(17, [0, 0, 0, 0, 5, 0, 1, 0]).as_deref(),
            Some("ticks=5 interruptable=true")
        );
        // Play Sound Event #23
        assert_eq!(
            format_primitive_operand(23, [0xAB, 0x00, 0, 0, 0, 0, 0, 0]).as_deref(),
            Some("event=0x00AB")
        );
        // Animate Sim #44
        assert_eq!(
            format_primitive_operand(44, [0x34, 0x12, 0, 0, 0, 0, 0, 0]).as_deref(),
            Some("anim=0x1234")
        );
        // Refresh #7 (no operand semantics)
        assert!(format_primitive_operand(7, [0; 8]).is_none());
        // Unknown primitive
        assert!(format_primitive_operand(99, [0; 8]).is_none());
    }

    #[test]
    fn format_expression_operand_renders_real_alarm_clock_instr() {
        // From AlarmClock 0x1001 ip=1: operand=05 00 01 00 00 05 01 07
        // → stack obj attr [5] = literal(1)
        let s = format_primitive_operand(2, [0x05, 0x00, 0x01, 0x00, 0x00, 0x05, 0x01, 0x07])
            .expect("Expression should decode");
        assert!(s.contains("stack objects attributes[5]"), "got: {s}");
        assert!(s.contains(" = "), "got: {s}");
        assert!(s.contains("literal(1)"), "got: {s}");
    }

    #[test]
    fn format_expression_operand_renders_comparisons() {
        // param[0] == literal(0): operand=00 00 00 00 00 02 09 07
        let s = format_primitive_operand(2, [0, 0, 0, 0, 0, 2, 9, 7]).unwrap();
        assert!(s.contains("parameters[0]"), "got: {s}");
        assert!(s.contains(" == "), "got: {s}");
        assert!(s.contains("literal(0)"), "got: {s}");
    }

    /// Build a single-instruction BHAV with a custom opcode + operand.
    fn one_instr(opcode: u16, operand: [u8; 8], t: u8, f: u8) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(&0x8002u16.to_le_bytes());
        buf.extend_from_slice(&1u16.to_le_bytes());
        buf.extend_from_slice(&[0u8; 4]);
        buf.extend_from_slice(&0u32.to_le_bytes());
        buf.extend_from_slice(&opcode.to_le_bytes());
        buf.push(t);
        buf.push(f);
        buf.extend_from_slice(&operand);
        buf
    }

    #[test]
    fn random_number_is_deterministic_and_in_range() {
        // op=8, max=10 in u16[0..2], target = temps[3] (lhs_owner=8, lhs_data=3 in u16[2..4]).
        let body = one_instr(
            8,
            [10, 0, 3, 0, 8, 0, 0, 0],
            Instruction::RETURN_TRUE,
            Instruction::RETURN_ERROR,
        );
        let src = source(&[(0x1000, body)]);
        let mut vm = Vm::new(&src);
        let _ = vm.call(0x1000, Vec::new(), 0, 0).unwrap();
        let v1 = vm.world.temps[3];
        assert!((0..10).contains(&v1), "expected 0..10, got {v1}");
        // Reset PRNG to default seed and re-run; same value (deterministic).
        let mut vm2 = Vm::new(&src);
        let _ = vm2.call(0x1000, Vec::new(), 0, 0).unwrap();
        assert_eq!(v1, vm2.world.temps[3]);
    }

    #[test]
    fn test_object_type_matches_guid() {
        let body = one_instr(
            32,
            [0x25, 0xD7, 0x83, 0xA4, 0, 0, 0, 0], // GUID 0xA483D725 (AlarmClock)
            Instruction::RETURN_TRUE,
            Instruction::RETURN_FALSE,
        );
        let src = source(&[(0x1000, body)]);
        let mut vm = Vm::new(&src);
        // Stack object 0x10 has the matching GUID → t_dest taken (RET_TRUE).
        vm.world.objects.insert(
            0x10,
            ObjectInstance {
                guid: 0xA483_D725,
                ..ObjectInstance::default()
            },
        );
        let r1 = vm.call(0x1000, Vec::new(), 0, 0x10).unwrap();
        assert_eq!(r1, ExecResult::Returned(true));
        // Stack object 0x20 has a different GUID → f_dest (RET_FALSE).
        vm.world.objects.insert(
            0x20,
            ObjectInstance {
                guid: 0x1234_5678,
                ..ObjectInstance::default()
            },
        );
        let r2 = vm.call(0x1000, Vec::new(), 0, 0x20).unwrap();
        assert_eq!(r2, ExecResult::Returned(false));
    }

    #[test]
    fn set_motive_change_writes_to_stack_object_motive() {
        // operand: motive index 0 (hunger), delta = -10.
        let body = one_instr(
            29,
            [0, 0, 0xF6, 0xFF, 0, 0, 0, 0], // -10 in i16
            Instruction::RETURN_TRUE,
            Instruction::RETURN_ERROR,
        );
        let src = source(&[(0x1000, body)]);
        let mut vm = Vm::new(&src);
        vm.world.write_motive(0x10, 0, 50);
        let _ = vm.call(0x1000, Vec::new(), 0, 0x10).unwrap();
        assert_eq!(vm.world.read_motive(0x10, 0), 40);
    }

    #[test]
    fn push_interaction_records_pending() {
        let body = one_instr(
            13,
            [0x01, 0x10, 0xFF, 0xFF, 0, 0, 0, 0],
            Instruction::RETURN_TRUE,
            Instruction::RETURN_ERROR,
        );
        let src = source(&[(0x1000, body)]);
        let mut vm = Vm::new(&src);
        let _ = vm.call(0x1000, Vec::new(), 0xAA, 0xBB).unwrap();
        assert_eq!(vm.world.interaction_queue.len(), 1);
        let pending = vm.world.interaction_queue[0];
        assert_eq!(pending.action_function, 0x1001);
        assert_eq!(pending.joining_index, -1);
        assert_eq!(pending.sim_id, 0xAA);
        assert_eq!(pending.stack_object_id, 0xBB);
    }

    #[test]
    fn transfer_funds_modifies_world_funds() {
        let body = one_instr(
            25,
            [0x9C, 0xFF, 0xFF, 0xFF, 0, 0, 0, 0], // -100 as i32 LE
            Instruction::RETURN_TRUE,
            Instruction::RETURN_ERROR,
        );
        let src = source(&[(0x1000, body)]);
        let mut vm = Vm::new(&src);
        vm.world.funds = 1000;
        let _ = vm.call(0x1000, Vec::new(), 0, 0).unwrap();
        assert_eq!(vm.world.funds, 900);
    }

    #[test]
    fn set_to_next_walks_objects_with_matching_guid() {
        // Returns Returned(true) since RET_TRUE was the t_dest and the primitive
        // succeeded in finding a match — but we can't observe the new
        // stack_object_id from here once the BHAV returns. Instead, verify the
        // primitive's truth value via two cases: when there is a match (true) and
        // when there isn't (false).
        let body_match = one_instr(
            31,
            [0x25, 0xD7, 0x83, 0xA4, 0, 0, 0, 0], // GUID 0xA483D725
            Instruction::RETURN_TRUE,
            Instruction::RETURN_FALSE,
        );
        let src_match = source(&[(0x1000, body_match)]);
        let mut vm = Vm::new(&src_match);
        vm.world.objects.insert(0x10, ObjectInstance { guid: 0x1234_5678, ..Default::default() });
        vm.world.objects.insert(0x20, ObjectInstance { guid: 0xA483_D725, ..Default::default() });
        let r = vm.call(0x1000, Vec::new(), 0, 0x10).unwrap();
        assert_eq!(r, ExecResult::Returned(true));

        // No match → false branch.
        let body_nomatch = one_instr(
            31,
            [0xAA, 0xAA, 0xAA, 0xAA, 0, 0, 0, 0],
            Instruction::RETURN_TRUE,
            Instruction::RETURN_FALSE,
        );
        let src_nomatch = source(&[(0x1000, body_nomatch)]);
        let mut vm2 = Vm::new(&src_nomatch);
        vm2.world.objects.insert(0x10, ObjectInstance { guid: 0x1234_5678, ..Default::default() });
        let r2 = vm2.call(0x1000, Vec::new(), 0, 0x10).unwrap();
        assert_eq!(r2, ExecResult::Returned(false));
    }

    #[test]
    fn run_functional_tree_dispatches_subcall() {
        // Tree id 0x1001 in operand[0..2]; subcall returns RET_TRUE.
        let caller = one_instr(20, [0x01, 0x10, 0, 0, 0, 0, 0, 0], Instruction::RETURN_TRUE, Instruction::RETURN_ERROR);
        let callee = one_instr(7, [0; 8], Instruction::RETURN_TRUE, Instruction::RETURN_ERROR);
        let src = source(&[(0x1000, caller), (0x1001, callee)]);
        let mut vm = Vm::new(&src);
        let r = vm.call(0x1000, Vec::new(), 0, 0).unwrap();
        assert_eq!(r, ExecResult::Returned(true));
    }

    #[test]
    fn dialog_primitives_emit_correct_flavour() {
        for (opcode, expected) in [
            (36u16, DialogFlavour::Private),
            (38, DialogFlavour::Global),
            (39, DialogFlavour::SemiGlobal),
        ] {
            let body = one_instr(opcode, [0x42, 0x00, 0, 0, 0, 0, 0, 0], Instruction::RETURN_TRUE, Instruction::RETURN_ERROR);
            let src = source(&[(0x1000, body)]);
            let mut vm = Vm::new(&src);
            vm.call(0x1000, Vec::new(), 0, 0).unwrap();
            assert!(matches!(
                vm.effects[0],
                VmEffect::Dialog { flavour, string_index: 0x42, .. } if flavour == expected
            ));
        }
    }

    #[test]
    fn subcall_passes_operand_bytes_as_signed_args() {
        // Caller calls 0x1001 with operand bytes [5, -3, 0, 0, ...]. Callee has
        // args=2 in its header and returns the value of param[0] - param[1] via
        // an Expression: temps[0] = params[0]; cmp temps[0] == literal(8).
        let caller = one_instr(
            300,
            [5, 0xFD, 0, 0, 0, 0, 0, 0],
            Instruction::RETURN_TRUE,
            Instruction::RETURN_FALSE,
        );
        // Build callee: header args=2, locals=0; ip 0 = Expression that compares
        // params[0] (5) == literal(5) → t=RET_TRUE.
        let mut callee = Vec::new();
        callee.extend_from_slice(&0x8002u16.to_le_bytes());
        callee.extend_from_slice(&1u16.to_le_bytes()); // count
        callee.extend_from_slice(&[0, 2, 0, 0]); // type/args=2/locals/flags
        callee.extend_from_slice(&0u32.to_le_bytes()); // extra
        callee.extend_from_slice(&2u16.to_le_bytes()); // Expression
        callee.push(Instruction::RETURN_TRUE);
        callee.push(Instruction::RETURN_FALSE);
        // operand: lhs=param[0], op=Eq, rhs=literal(5)
        callee.extend_from_slice(&0u16.to_le_bytes()); // lhs_data=0
        callee.extend_from_slice(&5u16.to_le_bytes()); // rhs_data=5 (literal)
        callee.push(0);
        callee.push(2); // Eq
        callee.push(9); // lhs_owner = parameters
        callee.push(7); // rhs_owner = literal
        let src = source(&[(0x1000, caller), (300, callee)]);
        let mut vm = Vm::new(&src);
        let r = vm.call(0x1000, Vec::new(), 0, 0).unwrap();
        // The callee saw param[0]=5 from operand byte 0 → comparison true → RET_TRUE
        // bubbled up to caller's t_dest → caller's RET_TRUE.
        assert_eq!(r, ExecResult::Returned(true));
    }

    #[test]
    fn write_motive_clamps_to_minus_100_to_100() {
        let mut w = World::default();
        w.write_motive(0xAA, 3, 200);
        assert_eq!(w.read_motive(0xAA, 3), 100);
        w.write_motive(0xAA, 3, -200);
        assert_eq!(w.read_motive(0xAA, 3), -100);
        // out-of-range index: silent no-op
        w.write_motive(0xAA, 99, 50);
        assert_eq!(w.read_motive(0xAA, 99), 0);
    }

    #[test]
    fn refresh_is_pure_noop() {
        let body = bhav(&[(7u16, Instruction::RETURN_TRUE, Instruction::RETURN_ERROR)]);
        let src = source(&[(0x1000, body)]);
        let mut vm = Vm::new(&src);
        let result = vm.call(0x1000, Vec::new(), 0, 0).unwrap();
        assert_eq!(result, ExecResult::Returned(true));
        // No effects emitted — Refresh is engine-side draw, not Sim state.
        assert!(vm.effects.is_empty());
    }

    #[test]
    fn trace_records_each_step() {
        let body = bhav(&[
            (STUB_PRIM, 1, Instruction::RETURN_ERROR),
            (STUB_PRIM, Instruction::RETURN_TRUE, Instruction::RETURN_ERROR),
        ]);
        let src = source(&[(0x1000, body)]);
        let mut vm = Vm::new(&src);
        vm.trace_enabled = true;
        vm.call(0x1000, Vec::new(), 0, 0).unwrap();
        assert_eq!(vm.trace.len(), 2);
        assert_eq!(vm.trace[0].opcode, STUB_PRIM);
        assert_eq!(vm.trace[1].opcode, STUB_PRIM);
    }

    #[test]
    fn tick_returns_idle_on_empty_queue() {
        let src = source(&[]);
        let mut vm = Vm::new(&src);
        assert_eq!(vm.tick().unwrap(), TickOutcome::Idle);
        // run_until_idle reports zero work done.
        assert_eq!(vm.run_until_idle(10).unwrap(), 0);
    }

    #[test]
    fn tick_runs_pending_action_function() {
        // Action function: a one-instruction BHAV that returns true.
        let action = bhav(&[(STUB_PRIM, Instruction::RETURN_TRUE, Instruction::RETURN_ERROR)]);
        let src = source(&[(0x2001, action)]);
        let mut vm = Vm::new(&src);
        let pending = PendingInteraction {
            sim_id: 0xAA,
            stack_object_id: 0xBB,
            action_function: 0x2001,
            joining_index: -1, // no guard
        };
        vm.world.interaction_queue.push(pending);
        let outcome = vm.tick().unwrap();
        assert_eq!(outcome, TickOutcome::Ran(pending, ExecResult::Returned(true)));
        // Queue is now empty.
        assert!(vm.world.interaction_queue.is_empty());
        assert_eq!(vm.tick().unwrap(), TickOutcome::Idle);
    }

    #[test]
    fn tick_skips_when_joining_returns_false() {
        // Guard returns false → action must not run.
        let guard = bhav(&[(STUB_PRIM, Instruction::RETURN_FALSE, Instruction::RETURN_ERROR)]);
        // If the action ever ran, it would write 99 to temps[0]. We assert it stays 0.
        let action = one_instr(
            2, // Expression: temps[0] = literal(99)
            [0, 0, 99, 0, 0, 5, 8, 7],
            Instruction::RETURN_TRUE,
            Instruction::RETURN_ERROR,
        );
        let src = source(&[(0x3001, guard), (0x3002, action)]);
        let mut vm = Vm::new(&src);
        let pending = PendingInteraction {
            sim_id: 0xAA,
            stack_object_id: 0xBB,
            action_function: 0x3002,
            joining_index: 0x3001,
        };
        vm.world.interaction_queue.push(pending);
        let outcome = vm.tick().unwrap();
        assert_eq!(outcome, TickOutcome::Skipped(pending));
        assert_eq!(vm.world.temps[0], 0, "action ran despite failed guard");
    }

    #[test]
    fn tick_runs_action_when_joining_returns_true() {
        let guard = bhav(&[(STUB_PRIM, Instruction::RETURN_TRUE, Instruction::RETURN_ERROR)]);
        let action = one_instr(
            2, // Expression: temps[0] = literal(7)
            [0, 0, 7, 0, 0, 5, 8, 7],
            Instruction::RETURN_TRUE,
            Instruction::RETURN_ERROR,
        );
        let src = source(&[(0x3001, guard), (0x3002, action)]);
        let mut vm = Vm::new(&src);
        vm.world.interaction_queue.push(PendingInteraction {
            sim_id: 0xAA,
            stack_object_id: 0xBB,
            action_function: 0x3002,
            joining_index: 0x3001,
        });
        let outcome = vm.tick().unwrap();
        assert!(matches!(outcome, TickOutcome::Ran(_, ExecResult::Returned(true))));
        assert_eq!(vm.world.temps[0], 7);
    }

    #[test]
    fn tick_consumes_queue_in_fifo_order() {
        // Two actions: first writes temps[0]=1, second writes temps[1]=2. Both push
        // a third interaction onto the queue mid-flight to also verify pushes during
        // ticks are honored on the next tick.
        let action_a = one_instr(
            2, // Expression: temps[0] = literal(1)
            [0, 0, 1, 0, 0, 5, 8, 7],
            Instruction::RETURN_TRUE,
            Instruction::RETURN_ERROR,
        );
        let action_b = one_instr(
            2, // Expression: temps[1] = literal(2)
            [1, 0, 2, 0, 0, 5, 8, 7],
            Instruction::RETURN_TRUE,
            Instruction::RETURN_ERROR,
        );
        let src = source(&[(0x4001, action_a), (0x4002, action_b)]);
        let mut vm = Vm::new(&src);
        vm.world.interaction_queue.push(PendingInteraction {
            sim_id: 0xAA,
            stack_object_id: 0xBB,
            action_function: 0x4001,
            joining_index: -1,
        });
        vm.world.interaction_queue.push(PendingInteraction {
            sim_id: 0xAA,
            stack_object_id: 0xBB,
            action_function: 0x4002,
            joining_index: -1,
        });
        let count = vm.run_until_idle(10).unwrap();
        assert_eq!(count, 2);
        assert_eq!(vm.world.temps[0], 1);
        assert_eq!(vm.world.temps[1], 2);
    }

    #[test]
    fn tick_caps_at_max_ticks_when_queue_keeps_growing() {
        // Action re-pushes itself onto the queue (Push Interaction primitive #13)
        // before returning. Without max_ticks the loop would never terminate.
        let mut action = Vec::new();
        action.extend_from_slice(&0x8002u16.to_le_bytes());
        action.extend_from_slice(&1u16.to_le_bytes()); // count=1
        action.extend_from_slice(&[0u8; 4]); // type/args/locals/flags
        action.extend_from_slice(&0u32.to_le_bytes()); // extra
        action.extend_from_slice(&13u16.to_le_bytes()); // opcode = Push Interaction
        action.push(Instruction::RETURN_TRUE);
        action.push(Instruction::RETURN_ERROR);
        // operand: action_function=0x4001 in [0..2], joining_index=-1 in [2..4]
        action.extend_from_slice(&0x4001u16.to_le_bytes());
        action.extend_from_slice(&0xFFFFu16.to_le_bytes());
        action.extend_from_slice(&[0, 0, 0, 0]);
        let src = source(&[(0x4001, action)]);
        let mut vm = Vm::new(&src);
        vm.world.interaction_queue.push(PendingInteraction {
            sim_id: 0xAA,
            stack_object_id: 0xBB,
            action_function: 0x4001,
            joining_index: -1,
        });
        let count = vm.run_until_idle(5).unwrap();
        assert_eq!(count, 5);
        // Queue is non-empty: the cap fired before the queue drained.
        assert!(!vm.world.interaction_queue.is_empty());
    }
}
