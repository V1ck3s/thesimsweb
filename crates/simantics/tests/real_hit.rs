//! Integration tests on real `.hit` files extracted from a Sims install.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

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
