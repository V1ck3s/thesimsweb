//! Run a BHAV through the stub VM and print the execution trace.
//!
//! Usage: `cargo run -p simantics --example run_bhav -- <file.iff> <chunk-id>`
//!
//! All primitives are stubbed to return `true`, so the trace shows which `t_dest`
//! path the VM walks (and where it bails out at unresolved subroutine calls or
//! `RET_ERR` sentinels). Useful as a sanity check for the call-frame plumbing
//! before real primitive semantics land.

#![allow(clippy::unwrap_used, clippy::print_stdout)]

use std::collections::BTreeMap;

use iff::Iff;
use simantics::vm::{ExecResult, InMemoryBhavSource, Vm, VmEffect, fmt_trace_entry};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let path = args.next().ok_or("usage: run_bhav <file.iff> <chunk-id>")?;
    let chunk_id: u16 = args.next().ok_or("missing chunk-id")?.parse()?;

    let bytes = std::fs::read(&path)?;
    let iff_file = Iff::parse(&bytes)?;
    let mut bhavs: BTreeMap<u16, Vec<u8>> = BTreeMap::new();
    for chunk in iff_file.chunks() {
        let chunk = chunk?;
        if &chunk.kind == b"BHAV" {
            bhavs.insert(chunk.id, chunk.data.to_vec());
        }
    }
    if !bhavs.contains_key(&chunk_id) {
        println!("BHAV 0x{chunk_id:04X} not in {path}");
        return Ok(());
    }

    let src = InMemoryBhavSource { bhavs };
    let mut vm = Vm::new(&src);
    vm.trace_enabled = true;
    vm.step_budget = 100_000;

    let result = vm.call(chunk_id, Vec::new(), 0, 0);
    println!("trace ({} steps):", vm.trace.len());
    for entry in &vm.trace {
        println!("  {}", fmt_trace_entry(entry));
    }
    if !vm.effects.is_empty() {
        println!("effects ({}):", vm.effects.len());
        for effect in &vm.effects {
            match effect {
                VmEffect::Sleep { ticks, .. } => println!("  Sleep ticks={ticks}"),
                VmEffect::Idle { ticks, interruptable, .. } => {
                    println!("  Idle ticks={ticks} interruptable={interruptable}");
                }
                VmEffect::PlaySound { event_id, .. } => {
                    println!("  PlaySound event_id=0x{event_id:04X}");
                }
                VmEffect::AnimateSim { anim_id, .. } => {
                    println!("  AnimateSim anim_id=0x{anim_id:04X}");
                }
            }
        }
    }
    match result {
        Ok(ExecResult::Returned(v)) => println!("=> Returned({v})"),
        Ok(ExecResult::Error) => println!("=> RET_ERROR"),
        Ok(ExecResult::BudgetExhausted) => println!("=> BudgetExhausted"),
        Err(e) => println!("=> VmError: {e}"),
    }
    Ok(())
}
