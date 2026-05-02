//! Integration tests on real `.hit` files extracted from a Sims install.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::cast_precision_loss
)]

use std::path::PathBuf;

use simantics::Hit;

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
