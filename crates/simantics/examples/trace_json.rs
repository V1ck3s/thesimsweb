//! Emit a deterministic JSON trace for a BHAV event run.
//!
//! Used as the "ours" side of the differential test against FreeSO/Simitone.
//! The output schema is documented in `docs/diff/vm-trace.md`.
//!
//! Usage:
//!   `cargo run -p simantics --example trace_json -- <object.iff> [--globals-far <path>] [--event N]`
//!
//! Output: one JSON object per line on stdout. The trailing line is an
//! `{ "kind": "outcome", ... }` object summarizing the tick result.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::print_stdout,
    clippy::panic,
    clippy::option_if_let_else,
    clippy::doc_markdown
)]

use std::collections::BTreeMap;

use far::Far;
use iff::Iff;
use simantics::{
    Glob, Objf,
    vm::{ExecResult, LayeredBhavSource, PendingInteraction, TickOutcome, TraceBranch, Vm},
};

struct Args {
    object_path: String,
    globals_far: Option<String>,
    event: usize,
}

fn parse_args() -> Args {
    let mut args = std::env::args().skip(1);
    let object_path = args.next().expect("usage: trace_json <object.iff> [--globals-far <path>] [--event N]");
    let mut globals_far = None;
    let mut event = 1usize;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--globals-far" => globals_far = args.next(),
            "--event" => event = args.next().expect("--event needs N").parse().expect("N must be an integer"),
            other => panic!("unknown flag: {other}"),
        }
    }
    Args { object_path, globals_far, event }
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

fn branch_to_str(b: TraceBranch) -> String {
    match b {
        TraceBranch::Continue(ip) => format!("\"continue:{ip}\""),
        TraceBranch::Returned(true) => "\"returned_true\"".to_string(),
        TraceBranch::Returned(false) => "\"returned_false\"".to_string(),
        TraceBranch::Error => "\"error\"".to_string(),
    }
}

fn main() {
    let args = parse_args();
    let object_bytes = std::fs::read(&args.object_path).expect("read object IFF");
    let object_iff = Iff::parse(&object_bytes).expect("parse object IFF");

    let mut source = LayeredBhavSource::default();
    let mut objf_data: Option<&[u8]> = None;
    let mut glob: Option<Glob> = None;
    for chunk in object_iff.chunks() {
        let chunk = chunk.expect("chunk");
        match &chunk.kind {
            b"BHAV" => {
                source.private.insert(chunk.id, chunk.data.to_vec());
            }
            b"OBJf" => objf_data = Some(chunk.data),
            b"GLOB" => glob = Some(Glob::parse(chunk.data).expect("GLOB")),
            _ => {}
        }
    }

    if let (Some(globals_far_path), Some(g)) = (&args.globals_far, &glob) {
        let bytes = std::fs::read(globals_far_path).expect("read globals FAR");
        let far = Far::parse(&bytes).expect("parse FAR");
        let target_name = format!("{}.iff", g.semi_global_name);
        let mut found = None;
        for entry in far.entries() {
            let entry = entry.expect("entry");
            if entry.filename.eq_ignore_ascii_case(target_name.as_bytes()) {
                found = Some(entry);
                break;
            }
        }
        if let Some(e) = found {
            let payload = far.payload(&e).expect("payload");
            let semi_iff = Iff::parse(payload).expect("parse semi");
            for chunk in semi_iff.chunks() {
                let chunk = chunk.expect("chunk");
                if &chunk.kind == b"BHAV" {
                    source.semi_global.insert(chunk.id, chunk.data.to_vec());
                }
            }
        }
    }

    let objf_data = objf_data.expect("no OBJf");
    let objf = Objf::parse(objf_data).expect("OBJf parse");
    let entry = objf.dispatch(args.event).expect("event has handler");

    let mut vm = Vm::new(&source);
    vm.trace_enabled = true;
    vm.world.push_interaction(PendingInteraction::new(
        0xAA,
        0xBB,
        entry.action,
        if entry.condition == 0 { -1 } else { i32::from(entry.condition) },
    ));
    let outcome = match vm.tick() {
        Ok(o) => o,
        Err(e) => {
            // Trace whatever we managed to record before the error, then
            // emit a sentinel outcome line and exit cleanly. This keeps the
            // diff format usable when the run hits an unresolved
            // semi-global / global BHAV.
            for entry in &vm.trace {
                println!(
                    "{{\"kind\":\"step\",\"depth\":{},\"bhavId\":{},\"ip\":{},\"opcode\":{},\"branch\":{}}}",
                    entry.depth,
                    entry.bhav_id,
                    entry.ip,
                    entry.opcode,
                    branch_to_str(entry.branch_taken)
                );
            }
            println!(
                "{{\"kind\":\"outcome\",\"outcome\":\"vm_error\",\"error\":\"{}\",\"steps\":{}}}",
                json_escape(&e.to_string()),
                vm.trace.len()
            );
            return;
        }
    };
    for entry in &vm.trace {
        println!(
            "{{\"kind\":\"step\",\"depth\":{},\"bhavId\":{},\"ip\":{},\"opcode\":{},\"branch\":{}}}",
            entry.depth,
            entry.bhav_id,
            entry.ip,
            entry.opcode,
            branch_to_str(entry.branch_taken)
        );
    }
    let mut effect_kinds: BTreeMap<&'static str, u32> = BTreeMap::new();
    for ef in &vm.effects {
        let key = match ef {
            simantics::vm::VmEffect::Sleep { .. } => "Sleep",
            simantics::vm::VmEffect::Idle { .. } => "Idle",
            simantics::vm::VmEffect::PlaySound { .. } => "PlaySound",
            simantics::vm::VmEffect::AnimateSim { .. } => "AnimateSim",
            simantics::vm::VmEffect::StopAllSounds => "StopAllSounds",
            simantics::vm::VmEffect::SetBalloon { .. } => "SetBalloon",
            simantics::vm::VmEffect::SetActionString { .. } => "SetActionString",
            simantics::vm::VmEffect::NotifyOutOfIdle { .. } => "NotifyOutOfIdle",
            simantics::vm::VmEffect::SpecialEffect { .. } => "SpecialEffect",
            simantics::vm::VmEffect::UiEffect { .. } => "UiEffect",
            simantics::vm::VmEffect::ShowString { .. } => "ShowString",
            simantics::vm::VmEffect::Dialog { .. } => "Dialog",
            simantics::vm::VmEffect::ChangeSuit { .. } => "ChangeSuit",
            simantics::vm::VmEffect::PushInteraction { .. } => "PushInteraction",
            simantics::vm::VmEffect::TransferFunds { .. } => "TransferFunds",
            simantics::vm::VmEffect::SpatialRequest { .. } => "SpatialRequest",
            simantics::vm::VmEffect::RunTreeByName { .. } => "RunTreeByName",
            simantics::vm::VmEffect::RemoveObjectInstance { .. } => "RemoveObjectInstance",
            simantics::vm::VmEffect::CreateObjectInstance { .. } => "CreateObjectInstance",
            simantics::vm::VmEffect::LookTowards { .. } => "LookTowards",
            simantics::vm::VmEffect::Breakpoint { .. } => "Breakpoint",
            simantics::vm::VmEffect::Syslog { .. } => "Syslog",
            simantics::vm::VmEffect::EngineHook { .. } => "EngineHook",
        };
        *effect_kinds.entry(key).or_insert(0) += 1;
    }
    let effects_json = effect_kinds
        .iter()
        .map(|(k, v)| format!("\"{}\":{}", json_escape(k), v))
        .collect::<Vec<_>>()
        .join(",");
    let outcome_str = match outcome {
        TickOutcome::Idle => String::from("\"idle\""),
        TickOutcome::Skipped(_) => String::from("\"skipped\""),
        TickOutcome::Ran(_, ExecResult::Returned(true)) => String::from("\"ran_true\""),
        TickOutcome::Ran(_, ExecResult::Returned(false)) => String::from("\"ran_false\""),
        TickOutcome::Ran(_, ExecResult::Error) => String::from("\"ran_error\""),
        TickOutcome::Ran(_, ExecResult::BudgetExhausted) => String::from("\"budget_exhausted\""),
    };
    println!(
        "{{\"kind\":\"outcome\",\"outcome\":{},\"steps\":{},\"effects\":{{{}}}}}",
        outcome_str,
        vm.trace.len(),
        effects_json
    );
}
