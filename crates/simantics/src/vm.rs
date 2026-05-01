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
    /// Shared u32 temp registers (scope 8). `SimAntics` ships ~32 temps; we allocate 32.
    pub temps: [i32; 32],
    /// Object ID → attributes. Empty in the stub VM.
    pub object_attrs: BTreeMap<u32, Vec<i32>>,
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
        let result = Self::dispatch(instr);
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

    const fn dispatch(instr: Instruction) -> DispatchOutcome {
        if instr.is_primitive() {
            // Stub: every primitive returns true. Real implementations live here,
            // dispatched by `instr.opcode` in 0..=67.
            DispatchOutcome::Branch(true)
        } else {
            DispatchOutcome::SubCall { opcode: instr.opcode }
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

    #[test]
    fn linear_walk_returns_true() {
        // Two primitives, both fall through their t_dest into the next instruction;
        // the second returns true.
        let body = bhav(&[
            (0x0002, 1, Instruction::RETURN_ERROR),
            (0x0002, Instruction::RETURN_TRUE, Instruction::RETURN_ERROR),
        ]);
        let src = source(&[(0x1000, body)]);
        let mut vm = Vm::new(&src);
        let result = vm.call(0x1000, Vec::new(), 0, 0).unwrap();
        assert_eq!(result, ExecResult::Returned(true));
    }

    #[test]
    fn return_false_sentinel() {
        let body = bhav(&[(0x0002, Instruction::RETURN_FALSE, Instruction::RETURN_ERROR)]);
        let src = source(&[(0x1000, body)]);
        let mut vm = Vm::new(&src);
        // Stub primitives always return true → t_dest is taken → RET_FALSE.
        assert_eq!(vm.call(0x1000, Vec::new(), 0, 0).unwrap(), ExecResult::Returned(false));
    }

    #[test]
    fn subroutine_call_then_return() {
        // Caller calls 0x1001, then returns whatever the callee returned via t_dest.
        let caller = bhav(&[(0x1001, Instruction::RETURN_TRUE, Instruction::RETURN_FALSE)]);
        let callee = bhav(&[(0x0002, Instruction::RETURN_TRUE, Instruction::RETURN_ERROR)]);
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
        let body = bhav(&[(0x0002, 0, Instruction::RETURN_ERROR)]);
        let src = source(&[(0x1000, body)]);
        let mut vm = Vm::new(&src);
        vm.step_budget = 1000;
        assert_eq!(vm.call(0x1000, Vec::new(), 0, 0).unwrap(), ExecResult::BudgetExhausted);
    }

    #[test]
    fn trace_records_each_step() {
        let body = bhav(&[
            (0x0002, 1, Instruction::RETURN_ERROR),
            (0x0002, Instruction::RETURN_TRUE, Instruction::RETURN_ERROR),
        ]);
        let src = source(&[(0x1000, body)]);
        let mut vm = Vm::new(&src);
        vm.trace_enabled = true;
        vm.call(0x1000, Vec::new(), 0, 0).unwrap();
        assert_eq!(vm.trace.len(), 2);
        assert_eq!(vm.trace[0].opcode, 0x0002);
        assert_eq!(vm.trace[1].opcode, 0x0002);
    }
}
