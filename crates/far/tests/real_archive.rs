//! Integration tests against real `.far` samples copied from a Sims install.
//! Samples live under `samples/far/` (gitignored). Tests skip cleanly if absent.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;

use far::{Far, FarError};

fn sample_path(name: &str) -> PathBuf {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    PathBuf::from(manifest_dir)
        .join("../..")
        .join("samples/far")
        .join(name)
}

fn load_sample(name: &str) -> Option<Vec<u8>> {
    std::fs::read(sample_path(name)).ok()
}

#[test]
fn unsnacker_far_has_two_entries() {
    let Some(data) = load_sample("UnSnacker.far") else {
        eprintln!("skipping: samples/far/UnSnacker.far missing (gitignored)");
        return;
    };

    let far = Far::parse(&data).expect("valid FAR");
    assert_eq!(far.entry_count(), 2);
    assert_eq!(far.manifest_offset(), 0x3E1C);

    let entries: Vec<_> = far.entries().collect::<Result<_, FarError>>().unwrap();
    assert_eq!(entries.len(), 2);

    assert_eq!(entries[0].filename, b"unsnacker.iff");
    assert_eq!(entries[0].size_decompressed, 0x3E00);
    assert_eq!(entries[0].size_compressed, 0x3E00);
    assert_eq!(entries[0].offset, 0x10);

    assert_eq!(entries[1].filename, b"UnSnacker.ndx");
    assert_eq!(entries[1].size_decompressed, 12);
    assert_eq!(entries[1].size_compressed, 12);
    assert_eq!(entries[1].offset, 0x3E10);

    let payload0 = far.payload(&entries[0]).unwrap();
    assert!(payload0.starts_with(b"IFF FILE 2.5:TYPE FOLLOWED BY SIZE"));
    let payload1 = far.payload(&entries[1]).unwrap();
    assert_eq!(payload1.len(), 12);
}

#[test]
fn global_far_in_install_is_v1_uncompressed() {
    let Some(data) = load_sample("Global.far") else {
        eprintln!("skipping: samples/far/Global.far missing (optional, large)");
        return;
    };

    let far = Far::parse(&data).expect("valid FAR");
    assert!(far.entry_count() > 0);
    for entry in far.entries() {
        let entry = entry.expect("valid entry");
        assert_eq!(
            entry.size_decompressed, entry.size_compressed,
            "FAR v1 must store uncompressed payloads (file {})",
            String::from_utf8_lossy(entry.filename)
        );
        let payload = far.payload(&entry).expect("payload in range");
        assert_eq!(payload.len(), entry.size_compressed as usize);
    }
}
