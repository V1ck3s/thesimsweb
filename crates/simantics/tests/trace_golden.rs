//! Self-regression test for the `trace_json` emit format.
//!
//! Compares fresh `trace_json` output for two BHAVs against checked-in
//! goldens under `tests/golden/vm/`. Catches accidental changes to the
//! JSONL schema or the VM's deterministic step ordering.
//!
//! This is *not* the FreeSO/Simitone diff; that requires building FreeSO
//! (.NET Framework 4.5 + MonoGame XNA, ~2 days of toolchain wrangling) and
//! is tracked separately in `docs/diff/vm-trace.md`.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout)]

use std::path::PathBuf;
use std::process::Command;

fn repo_root() -> PathBuf {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    PathBuf::from(manifest_dir).join("..").join("..").canonicalize().unwrap()
}

fn run_trace(object_iff: &str, event: usize) -> String {
    let root = repo_root();
    let output = Command::new("cargo")
        .arg("run")
        .arg("--release")
        .arg("--quiet")
        .arg("-p")
        .arg("simantics")
        .arg("--example")
        .arg("trace_json")
        .arg("--")
        .arg(root.join("samples/iff").join(object_iff))
        .arg("--event")
        .arg(event.to_string())
        .current_dir(&root)
        .output()
        .expect("cargo run trace_json");
    if !output.status.success() {
        panic!(
            "trace_json failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    String::from_utf8(output.stdout).expect("utf8 stdout")
}

fn read_golden(name: &str) -> Option<String> {
    let path = repo_root().join("tests/golden/vm").join(name);
    std::fs::read_to_string(path).ok()
}

#[test]
fn alarmclock_event1_matches_golden() {
    let Some(expected) = read_golden("alarmclock_event1.jsonl") else {
        eprintln!("skipping: tests/golden/vm/alarmclock_event1.jsonl missing");
        return;
    };
    let actual = run_trace("AlarmClock.iff", 1);
    if actual != expected {
        eprintln!("=== expected ===\n{expected}");
        eprintln!("=== actual ===\n{actual}");
        panic!("trace_json output for AlarmClock event 1 diverged from golden");
    }
}

#[test]
fn unsnacker_event1_matches_golden() {
    let Some(expected) = read_golden("unsnacker_event1.jsonl") else {
        eprintln!("skipping: tests/golden/vm/unsnacker_event1.jsonl missing");
        return;
    };
    let actual = run_trace("unsnacker.iff", 1);
    if actual != expected {
        eprintln!("=== expected ===\n{expected}");
        eprintln!("=== actual ===\n{actual}");
        panic!("trace_json output for unsnacker event 1 diverged from golden");
    }
}
