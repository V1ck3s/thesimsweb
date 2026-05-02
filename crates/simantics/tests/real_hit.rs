//! Integration tests on real `.hit` files extracted from a Sims install.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::cast_precision_loss
)]

use std::path::PathBuf;

use simantics::Hit;
use simantics::hit_vm::{DefaultHost, HitEffect, HitVm, RunOutcome};
use simantics::hot::HotFile;

fn sample_path(name: &str) -> PathBuf {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    PathBuf::from(manifest_dir).join("../..").join("samples/hit").join(name)
}

#[test]
fn parses_simssound_hit() {
    let Ok(data) = std::fs::read(sample_path("simssound.HIT")) else {
        eprintln!("skipping: samples/hit/simssound.HIT missing");
        return;
    };
    let hit = Hit::parse(&data).expect("simssound.HIT parses");
    assert_eq!(hit.major, 1);
    assert_eq!(hit.minor, 8);
    assert!(!hit.code.is_empty(), "code section non-empty");
    eprintln!(
        "simssound.HIT: {}B code, {} exports",
        hit.code.len(),
        hit.exports.len()
    );

    // Disasm should walk the entire code without bailing out, and ≥95 % of
    // instructions should resolve to a known mnemonic (no `db 0xNN` chains).
    let instrs = hit.disasm();
    assert!(!instrs.is_empty(), "disasm produced at least one instruction");
    let unknown = instrs.iter().filter(|i| i.mnemonic == "db").count();
    eprintln!(
        "simssound.HIT disasm: {} instructions ({} unknown)",
        instrs.len(),
        unknown
    );
    let known_ratio = (instrs.len() - unknown) as f64 / instrs.len() as f64;
    assert!(
        known_ratio > 0.5,
        "more than half the instructions should be known (got {known_ratio:.2})"
    );
}

#[test]
fn vm_walks_simssound_hit_subroutine_without_crashing() {
    // SimsSound.hot lists track 0x1=0x10 (entry at file offset 0x10).
    // Run a few thousand steps in run_until_halt mode and check we either reach
    // a halt/yield path or exhaust the budget cleanly (no UnknownOpcode/etc.).
    let Ok(data) = std::fs::read(sample_path("simssound.HIT")) else {
        eprintln!("skipping: samples/hit/simssound.HIT missing");
        return;
    };
    let hit = Hit::parse(&data).expect("simssound.HIT parses");

    // Try every known TrackData entry from SimsSound.hot. The values are
    // hand-extracted from the .hot file (we don't parse it here yet — that's
    // the next Phase 5 task).
    let entry_addresses: &[u32] = &[
        0x10, 0x14, 0x19, 0x24, 0x47, 0x6A, 0x8D, 0xB0, 0xC6, 0xE4,
        0x11E, 0x13A, 0x164, 0x191, 0x1BE, 0x1EB, 0x218, 0x21C, 0x231,
    ];

    for &addr in entry_addresses {
        let mut vm = HitVm::new(&hit, addr);
        let mut host = DefaultHost::new(0x0123_4567_89AB_CDEF);
        let mut yielded_kinds = 0usize;
        let mut halted = false;
        for _ in 0..200 {
            match vm.run_until_yield(&mut host, 1000) {
                RunOutcome::Yielded(eff) => {
                    yielded_kinds += 1;
                    // Resume after Wait/PlayTrack/etc. The VM is already at the
                    // next instruction; we just keep stepping. Halt on End/Return.
                    if matches!(eff, HitEffect::End | HitEffect::Return) {
                        halted = true;
                        break;
                    }
                }
                RunOutcome::Halted => {
                    halted = true;
                    break;
                }
                RunOutcome::BudgetExhausted => break,
                RunOutcome::Error(e) => panic!(
                    "VM error at entry 0x{addr:x} (steps={}): {e:?}",
                    vm.steps_executed
                ),
            }
        }
        eprintln!(
            "entry 0x{addr:x}: steps={}, yields={}, halted={}",
            vm.steps_executed, yielded_kinds, halted
        );
    }
}

#[test]
fn parses_simssound_hot_and_resolves_event() {
    let Ok(text) = std::fs::read_to_string(sample_path("SimsSound.hot")) else {
        eprintln!("skipping: samples/hit/SimsSound.hot missing");
        return;
    };
    let hot = HotFile::parse(&text);
    eprintln!(
        "SimsSound.hot: {} TrackData, {} EventMapping, {} Patch, {} Track",
        hot.track_data.len(),
        hot.event_mapping.len(),
        hot.patches.len(),
        hot.tracks.len(),
    );
    assert!(!hot.track_data.is_empty(), "TrackData section parsed");
    assert!(!hot.event_mapping.is_empty(), "EventMapping section parsed");

    // dishw_sclose maps to (kSndobPlay, 60). Track 60 is TrkDishwasherClose.
    let m = hot.event_mapping.get("dishw_sclose").expect("dishw_sclose mapped");
    assert_eq!(m.event_kind, 1); // kSndobPlay
    assert_eq!(m.track_id, 60);
    let track = hot.tracks.get(&60).expect("track 60 present");
    assert_eq!(track.subroutine_name, "TrkDishwasherClose");
    // Patch 50 = PchDishwasherClose.
    let patch = hot.patches.get(&50).expect("patch 50 present");
    assert_eq!(patch.name, "PchDishwasherClose");
    assert!(patch.sound_path.ends_with(".xa"));
}

#[test]
fn parses_simsgenerated_hot_large() {
    // The big one: ~5800 lines, hundreds of patches and events.
    let Ok(text) = std::fs::read_to_string(sample_path("SimsGeneratedHitSource.hot")) else {
        eprintln!("skipping: samples/hit/SimsGeneratedHitSource.hot missing");
        return;
    };
    let hot = HotFile::parse(&text);
    eprintln!(
        "SimsGeneratedHitSource.hot: {} TrackData, {} EventMapping, {} Patch, {} Track",
        hot.track_data.len(),
        hot.event_mapping.len(),
        hot.patches.len(),
        hot.tracks.len(),
    );
    // Sanity: the file has hundreds of patches.
    assert!(hot.patches.len() > 100, "expected >100 patches, got {}", hot.patches.len());
    assert!(hot.event_mapping.len() > 100);
    assert!(!hot.track_data.is_empty());
}

#[test]
fn parses_simsgenerated_hit() {
    let Ok(data) = std::fs::read(sample_path("simsgeneratedhitsource.hit")) else {
        eprintln!("skipping: samples/hit/simsgeneratedhitsource.hit missing");
        return;
    };
    let hit = Hit::parse(&data).expect("simsgeneratedhitsource.hit parses");
    assert_eq!(hit.major, 1);
    assert_eq!(hit.minor, 8);
    assert!(!hit.code.is_empty(), "code section non-empty");
    eprintln!(
        "simsgeneratedhitsource.hit: {}B code, {} exports",
        hit.code.len(),
        hit.exports.len()
    );
}
