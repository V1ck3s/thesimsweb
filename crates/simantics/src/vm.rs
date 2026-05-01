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

use crate::{Bhav, Instruction, SimAnticsError};

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

/// World-level state. Today this is mostly a placeholder for what Phase 4 will fill in:
/// objects with attributes, motives, the lot grid, and the global temp registers.
#[derive(Debug, Default, Clone)]
pub struct World {
    /// Shared temp registers (scope 8). `SimAntics` ships ~32 temps; we allocate 32.
    pub temps: [i32; 32],
    /// Object ID → attributes (scope 0 / 1 keyed by object id and attribute index).
    pub object_attrs: BTreeMap<u32, Vec<i32>>,
}

impl World {
    /// Read attribute `index` of `object_id`. Returns 0 if either is unset (Niotso says
    /// attributes default to 0 when never written, which matches the binary on-disk
    /// representation in OBJD).
    #[must_use]
    pub fn read_object_attr(&self, object_id: u32, index: usize) -> i32 {
        self.object_attrs
            .get(&object_id)
            .and_then(|v| v.get(index).copied())
            .unwrap_or(0)
    }

    /// Write `value` to attribute `index` of `object_id`. Grows the attribute vector
    /// on demand (Sims allocates one slot per attribute used; we follow the same rule).
    pub fn write_object_attr(&mut self, object_id: u32, index: usize, value: i32) {
        let entry = self.object_attrs.entry(object_id).or_default();
        if entry.len() <= index {
            entry.resize(index + 1, 0);
        }
        #[allow(clippy::indexing_slicing)] // resize above
        {
            entry[index] = value;
        }
    }
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
            DispatchOutcome::SubCall { opcode } => self.subroutine_call(opcode),
        }
    }

    fn dispatch(&mut self, instr: Instruction) -> DispatchOutcome {
        if !instr.is_primitive() {
            return DispatchOutcome::SubCall { opcode: instr.opcode };
        }
        // Real primitives go here, indexed by `instr.opcode` in 0..=67. Anything we
        // haven't wired yet falls back to the conservative "return true" stub so the
        // BHAV continues forward — this keeps the runner useful for trace exploration
        // while we land primitives one by one.
        match instr.opcode {
            2 => self.exec_expression(instr.operand),
            _ => DispatchOutcome::Branch(true),
        }
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
        match owner {
            // 0 = my object's attributes
            0 => self.world.read_object_attr(frame.my_id, usize::from(data)),
            // 1 = stack object's attributes
            1 => self.world.read_object_attr(frame.stack_object_id, usize::from(data)),
            // 7 = literal
            7 => i32::from(i16::from_le_bytes(data.to_le_bytes())),
            // 8 = temp registers (shared across the call stack — TS1's "local temps"
            // are technically per-tree but most BHAVs we've inspected use the global
            // bank; see Niotso §Scopes 8 for the nuance).
            8 => {
                let i = usize::from(data);
                if i < self.world.temps.len() {
                    self.world.temps[i]
                } else {
                    0
                }
            }
            // 9 = parameters (the args vec for the current frame)
            9 => frame.params.get(usize::from(data)).copied().unwrap_or(0),
            // 10 = stack object id (data ignored)
            10 => i32::from_le_bytes(frame.stack_object_id.to_le_bytes()),
            // 25 = locals (per-frame)
            25 => frame.locals.get(usize::from(data)).copied().unwrap_or(0),
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
        match owner {
            0 => self.world.write_object_attr(my_id, usize::from(data), value),
            1 => self.world.write_object_attr(stack_object_id, usize::from(data), value),
            8 => {
                let i = usize::from(data);
                if i < self.world.temps.len() {
                    self.world.temps[i] = value;
                }
            }
            9 => {
                if let Some(frame) = self.call_stack.last_mut() {
                    if let Some(slot) = frame.params.get_mut(usize::from(data)) {
                        *slot = value;
                    }
                }
            }
            25 => {
                if let Some(frame) = self.call_stack.last_mut() {
                    if let Some(slot) = frame.locals.get_mut(usize::from(data)) {
                        *slot = value;
                    }
                }
            }
            // 7 = literal: writing to a literal is undefined; silently drop.
            // Other scopes: not yet wired (motives, person data, slots, etc.).
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

    fn subroutine_call(&mut self, opcode: u16) -> Result<StepOutcome, VmError> {
        if self.call_stack.len() >= self.max_depth {
            return Err(VmError::StackOverflow {
                depth: self.call_stack.len(),
            });
        }
        let bytes = self.source.lookup(opcode).ok_or(VmError::BhavNotFound(opcode))?;
        let callee = Bhav::parse(bytes)?;
        // Inherit my/stack-object pointers from the caller; arguments come from the
        // operand. For now we pass an empty params vec — operand decoding lands later.
        let parent = self.call_stack.last().ok_or(VmError::StackOverflow { depth: 0 })?;
        let frame = StackFrame::new(
            opcode,
            callee.header.locals,
            Vec::new(),
            parent.my_id,
            parent.stack_object_id,
        );
        self.call_stack.push(frame);
        Ok(StepOutcome::Continue)
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
    /// Subroutine call — `opcode` is the callee's chunk ID.
    SubCall { opcode: u16 },
}

#[derive(Debug, Clone, Copy)]
enum StepOutcome {
    Continue,
    Returned(bool),
    Error,
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
}
