//! Integration tests on real `.flr` / `.iff` samples that contain SPR2 + PALT chunks.
//! Skips cleanly if `samples/iff/FloorJapaneseTile.flr` is absent.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;

use iff::Iff;
use sprite::{Palette, Spr2};

fn sample_path(name: &str) -> PathBuf {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    PathBuf::from(manifest_dir).join("../..").join("samples/iff").join(name)
}

fn load_sample(name: &str) -> Option<Vec<u8>> {
    std::fs::read(sample_path(name)).ok()
}

#[test]
fn floor_japanese_tile_decodes() {
    let Some(data) = load_sample("FloorJapaneseTile.flr") else {
        eprintln!("skipping: samples/iff/FloorJapaneseTile.flr missing");
        return;
    };

    let iff_file = Iff::parse(&data).expect("valid IFF");
    let chunks: Vec<_> = iff_file.chunks().collect::<Result<_, _>>().unwrap();

    // Find PALT (id=1) and SPR2 chunks.
    let palt_chunk = chunks
        .iter()
        .find(|c| &c.kind == b"PALT" && c.id == 1)
        .expect("PALT id=1 present");
    let spr2_chunks: Vec<_> = chunks.iter().filter(|c| &c.kind == b"SPR2").collect();
    assert_eq!(spr2_chunks.len(), 3, "FloorJapaneseTile has 3 zoom levels");

    let palt = Palette::parse(palt_chunk.data).expect("PALT parses");
    assert_eq!(palt.entries.len(), 256);
    // First palette entry on Maxis floors is canonically magenta (the transparent marker).
    assert_eq!(palt.entries[0], [0xFF, 0x00, 0xFF]);

    for spr2_chunk in &spr2_chunks {
        let spr2 = Spr2::parse(spr2_chunk.data).expect("SPR2 parses");
        assert_eq!(spr2.header.version, 1000);
        assert_eq!(spr2.header.default_palette, 1);
        assert_eq!(spr2.header.sprite_count as usize, spr2.frames.len());
        for i in 0..spr2.header.sprite_count {
            let frame = spr2.decode_frame(i, &palt).expect("RLE decodes");
            assert!(frame.width > 0 && frame.height > 0);
            assert_eq!(
                frame.rgba.len(),
                (frame.width as usize) * (frame.height as usize) * 4
            );
            // At least one pixel should be opaque (palette index != transparent_color).
            let any_opaque = frame.rgba.chunks_exact(4).any(|p| p[3] == 255);
            assert!(any_opaque, "frame should contain opaque pixels");
        }
    }
}
