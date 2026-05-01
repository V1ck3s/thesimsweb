//! Integration tests that run real BHAVs through the stub VM.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::path::PathBuf;

use iff::Iff;
use simantics::vm::{ExecResult, InMemoryBhavSource, Vm};

fn sample_path(name: &str) -> PathBuf {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    PathBuf::from(manifest_dir).join("../..").join("samples/iff").join(name)
}

fn load_bhavs(path: &PathBuf) -> Option<InMemoryBhavSource> {
    let data = std::fs::read(path).ok()?;
    let iff_file = Iff::parse(&data).ok()?;
    let mut bhavs: BTreeMap<u16, Vec<u8>> = BTreeMap::new();
    for chunk in iff_file.chunks() {
        let chunk = chunk.ok()?;
        if &chunk.kind == b"BHAV" {
            bhavs.insert(chunk.id, chunk.data.to_vec());
        }
    }
    Some(InMemoryBhavSource { bhavs })
}

#[test]
fn alarm_clock_set_alarm_runs_to_completion() {
    // BHAV 0x1001 = "Set Alarm" interaction action. With every primitive stubbed to
    // return true, the linear-ish flow should walk to a return sentinel within the
    // step budget. We don't assert the truth value (it depends on operand semantics
    // we haven't implemented yet) — just that the runner doesn't crash, doesn't loop
    // forever, and produces a finite trace.
    let Some(src) = load_bhavs(&sample_path("AlarmClock.iff")) else {
        eprintln!("skipping: samples/iff/AlarmClock.iff missing");
        return;
    };
    let mut vm = Vm::new(&src);
    vm.trace_enabled = true;
    vm.step_budget = 10_000;
    let result = vm.call(0x1001, Vec::new(), 0xA483_D725, 0).expect("VM didn't blow up");
    match result {
        // RET_ERROR sentinels are normal in stub mode — the operand semantics we
        // haven't implemented are what would have steered the BHAV away from them.
        ExecResult::Returned(_) | ExecResult::Error => {}
        ExecResult::BudgetExhausted => panic!("BHAV 0x1001 looped past 10k steps"),
    }
    assert!(!vm.trace.is_empty(), "trace should record at least one step");
    // Sanity: every traced opcode must be a valid SimAntics opcode (we don't assert
    // they're all known-named primitives — semi-globals like 0x0118 are common too).
    for entry in &vm.trace {
        assert!(entry.opcode != u16::MAX, "trace contains a sentinel opcode");
    }
}

#[test]
fn unsnacker_bhav_main_runs() {
    let Some(src) = load_bhavs(&sample_path("unsnacker.iff")) else {
        eprintln!("skipping: samples/iff/unsnacker.iff missing");
        return;
    };
    let mut vm = Vm::new(&src);
    vm.step_budget = 10_000;
    // BHAV 0x100A is one of the two BHAVs in unsnacker.iff. With stub primitives the
    // call instruction at index 1 (SEMI(0x016E)) targets a chunk we don't have →
    // BhavNotFound. That's fine; the runner reports the error cleanly rather than
    // silently no-op'ing it.
    let outcome = vm.call(0x100A, Vec::new(), 0, 0);
    match outcome {
        Ok(ExecResult::Returned(_) | ExecResult::Error) => {}
        Ok(ExecResult::BudgetExhausted) => panic!("budget exhausted unexpectedly"),
        Err(e) => {
            let msg = e.to_string();
            assert!(
                msg.contains("not found"),
                "unexpected VM error: {msg}",
            );
        }
    }
}
