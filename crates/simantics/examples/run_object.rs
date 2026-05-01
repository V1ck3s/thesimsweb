//! Run an object's OBJf event handler through the scheduler.
//!
//! Demonstrates the full data-layer chain: IFF parsing → OBJf event lookup →
//! GLOB-aware `LayeredBhavSource` routing → interaction queue scheduler.
//!
//! Usage:
//!   `cargo run -p simantics --example run_object -- <object.iff> [--globals-far <path>] [--event N]`
//!
//! When `--globals-far` is supplied (typically `Global.far` from the install),
//! the object's `GLOB` chunk picks the matching semi-global IFF; semi-global
//! sub-calls in the BHAV resolve through it. Without `--globals-far`, semi-
//! global calls bail out cleanly with `BhavNotFound`.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::print_stdout,
    clippy::panic,
    clippy::option_if_let_else,
    clippy::field_reassign_with_default,
    clippy::doc_markdown,
    clippy::trivially_copy_pass_by_ref
)]

use std::collections::BTreeMap;

use far::Far;
use iff::Iff;
use simantics::{
    Glob, Objf,
    vm::{ExecResult, LayeredBhavSource, PendingInteraction, TickOutcome, Vm, fmt_trace_entry},
};

struct Args {
    object_path: String,
    globals_far: Option<String>,
    event: usize,
}

fn parse_args() -> Args {
    let mut args = std::env::args().skip(1);
    let object_path = args.next().expect("usage: run_object <object.iff> [--globals-far <path>] [--event N]");
    let mut globals_far = None;
    let mut event = 1usize; // default = Main
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--globals-far" => globals_far = args.next(),
            "--event" => event = args.next().expect("--event needs N").parse().expect("N must be an integer"),
            other => panic!("unknown flag: {other}"),
        }
    }
    Args { object_path, globals_far, event }
}

fn load_bhavs_from_iff(data: &[u8]) -> BTreeMap<u16, Vec<u8>> {
    let mut bhavs = BTreeMap::new();
    let Ok(iff) = Iff::parse(data) else { return bhavs };
    for chunk in iff.chunks() {
        let Ok(chunk) = chunk else { continue };
        if &chunk.kind == b"BHAV" {
            bhavs.insert(chunk.id, chunk.data.to_vec());
        }
    }
    bhavs
}

fn find_chunk<'a>(iff: &'a Iff<'a>, kind: &[u8; 4]) -> Option<&'a [u8]> {
    for chunk in iff.chunks() {
        let Ok(chunk) = chunk else { continue };
        if &chunk.kind == kind {
            return Some(chunk.data);
        }
    }
    None
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = parse_args();

    let object_bytes = std::fs::read(&args.object_path)?;
    let object_iff = Iff::parse(&object_bytes)?;
    println!("=== {} ===", args.object_path);

    let mut source = LayeredBhavSource::default();
    source.private = load_bhavs_from_iff(&object_bytes);
    println!("private BHAVs: {}", source.private.len());

    // Resolve GLOB → semi-global IFF (best effort).
    let glob_name = match find_chunk(&object_iff, b"GLOB") {
        Some(data) => match Glob::parse(data) {
            Ok(g) => Some(g.semi_global_name),
            Err(_) => None,
        },
        None => None,
    };
    if let Some(name) = &glob_name {
        println!("GLOB → {name}");
    } else {
        println!("GLOB: (none — semi-global calls will bail out)");
    }

    // If a globals FAR was provided, load the matching entry into `semi_global`.
    if let Some(far_path) = &args.globals_far {
        let far_bytes = std::fs::read(far_path)?;
        let archive = Far::parse(&far_bytes)?;
        let target_name = glob_name
            .as_deref()
            .map_or_else(|| "Global".to_string(), str::to_string);
        let mut found = false;
        for entry in archive.entries() {
            let entry = entry?;
            let name_bytes = &entry.filename;
            let name = String::from_utf8_lossy(name_bytes);
            // Match on the file stem, case-insensitive.
            let stem = name.strip_suffix(".iff").or_else(|| name.strip_suffix(".IFF")).unwrap_or(&name);
            if stem.eq_ignore_ascii_case(&target_name) {
                let payload = archive.payload(&entry)?;
                source.semi_global = load_bhavs_from_iff(payload);
                println!(
                    "semi-global BHAVs from {name}: {}",
                    source.semi_global.len()
                );
                found = true;
                break;
            }
        }
        if !found {
            println!("(no semi-global IFF matching '{target_name}' found in FAR)");
        }
    }

    // Parse OBJf and dispatch the requested event.
    let objf_data = find_chunk(&object_iff, b"OBJf").ok_or("no OBJf chunk in object IFF")?;
    let objf = Objf::parse(objf_data)?;
    let entry = objf.dispatch(args.event).ok_or_else(|| {
        format!(
            "OBJf event {} has no handler (table size {})",
            args.event,
            objf.entries.len()
        )
    })?;
    println!(
        "OBJf event {} → action 0x{:04X}{}",
        args.event,
        entry.action,
        if entry.condition == 0 { String::new() } else { format!(" (guard 0x{:04X})", entry.condition) },
    );

    // Push as a pending interaction and run the scheduler.
    let mut vm = Vm::new(&source);
    vm.trace_enabled = true;
    vm.world.interaction_queue.push(PendingInteraction {
        sim_id: 0xAA,
        stack_object_id: 0xBB,
        action_function: entry.action,
        joining_index: if entry.condition == 0 { -1 } else { i32::from(entry.condition) },
    });

    println!();
    let outcome = vm.tick()?;
    match outcome {
        TickOutcome::Idle => println!("(scheduler idle — queue was empty?)"),
        TickOutcome::Skipped(p) => println!("guard 0x{:04X} returned false; skipped action 0x{:04X}", p.joining_index, p.action_function),
        TickOutcome::Ran(p, result) => {
            print!("ran action 0x{:04X} → ", p.action_function);
            match result {
                ExecResult::Returned(v) => println!("Returned({v})"),
                ExecResult::Error => println!("RET_ERROR"),
                ExecResult::BudgetExhausted => println!("BudgetExhausted"),
            }
        }
    }

    println!("\ntrace ({} steps):", vm.trace.len());
    for entry in &vm.trace {
        println!("  {}", fmt_trace_entry(entry));
    }
    if !vm.effects.is_empty() {
        println!("\neffects ({}):", vm.effects.len());
        for effect in &vm.effects {
            println!("  {effect:?}");
        }
    }
    Ok(())
}
