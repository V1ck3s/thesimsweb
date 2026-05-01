//! Integration tests against real `.iff` samples copied from a Sims install.
//! Samples live under `samples/iff/` (gitignored). Tests skip cleanly if absent.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;

use iff::{Iff, IffError, IffVersion};

fn sample_path(name: &str) -> PathBuf {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    PathBuf::from(manifest_dir).join("../..").join("samples/iff").join(name)
}

fn load_sample(name: &str) -> Option<Vec<u8>> {
    std::fs::read(sample_path(name)).ok()
}

#[test]
fn options_iff_has_optn_and_rsmp() {
    let Some(data) = load_sample("Options.iff") else {
        eprintln!("skipping: samples/iff/Options.iff missing (gitignored)");
        return;
    };

    let iff = Iff::parse(&data).expect("valid IFF");
    assert_eq!(iff.version(), IffVersion::V2_5);
    assert_eq!(iff.rsmp_offset(), 0xB0);

    let chunks: Vec<_> = iff.chunks().collect::<Result<_, IffError>>().unwrap();
    assert_eq!(chunks.len(), 3, "Options.iff has Optn + rsmp + XXXX");

    assert_eq!(&chunks[0].kind, b"Optn");
    assert_eq!(chunks[0].size, 0x70);
    assert_eq!(chunks[0].id, 0x80);
    assert_eq!(chunks[0].flags, 0x0010);
    assert_eq!(chunks[0].data.len(), 0x70 - 76);
    assert_eq!(chunks[0].offset, 0x40);

    assert_eq!(&chunks[1].kind, b"rsmp");
    assert_eq!(chunks[1].offset, 0xB0);
    assert_eq!(chunks[1].size, 0x72);
    // rsmp data layout per Niotso: u32 reserved (0), u32 version (0 for TS1), u32 magic "pmsr".
    assert_eq!(&chunks[1].data[0..4], &[0, 0, 0, 0]);
    assert_eq!(&chunks[1].data[4..8], &[0, 0, 0, 0]);
    assert_eq!(&chunks[1].data[8..12], b"pmsr");

    assert_eq!(&chunks[2].kind, b"XXXX");
    assert_eq!(chunks[2].offset, 0x122);
    assert_eq!(chunks[2].size, 0x59);
}

#[test]
fn ranger_iff_has_at_least_two_chunks() {
    let Some(data) = load_sample("Ranger.iff") else {
        eprintln!("skipping: samples/iff/Ranger.iff missing (gitignored)");
        return;
    };

    let iff = Iff::parse(&data).expect("valid IFF");
    assert_eq!(iff.version(), IffVersion::V2_5);

    let chunks: Vec<_> = iff.chunks().collect::<Result<_, IffError>>().unwrap();
    assert!(chunks.len() >= 2, "Ranger.iff has multiple chunks");

    // Self-consistency: rsmp_offset must point to a real chunk of type "rsmp".
    let rsmp_offset = iff.rsmp_offset() as usize;
    let rsmp = chunks
        .iter()
        .find(|c| c.offset == rsmp_offset)
        .expect("rsmp chunk at advertised offset");
    assert_eq!(&rsmp.kind, b"rsmp");
}

#[test]
fn unsnacker_iff_self_consistency() {
    let Some(data) = load_sample("unsnacker.iff") else {
        eprintln!("skipping: samples/iff/unsnacker.iff missing (gitignored)");
        return;
    };

    let iff = Iff::parse(&data).expect("valid IFF");
    let chunks: Vec<_> = iff.chunks().collect::<Result<_, IffError>>().unwrap();
    assert!(!chunks.is_empty());

    // Every chunk's [offset, offset+size) must lie inside the file.
    for c in &chunks {
        assert!(c.offset + c.size as usize <= data.len(), "chunk fits in buffer");
        assert_eq!(c.label.len(), 64);
    }

    // Chunk types should be ASCII.
    for c in &chunks {
        for &b in &c.kind {
            assert!(b.is_ascii(), "chunk type byte {b:#x} not ASCII");
        }
    }
}
