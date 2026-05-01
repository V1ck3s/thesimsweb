//! Integration tests on real BHAV chunks extracted from a Sims install.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;

use iff::Iff;
use simantics::{BhavMagic, Bhav, Instruction};

fn sample_path(name: &str) -> PathBuf {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    PathBuf::from(manifest_dir).join("../..").join("samples/iff").join(name)
}

#[test]
fn unsnacker_iff_bhavs_decode() {
    let Ok(data) = std::fs::read(sample_path("unsnacker.iff")) else {
        eprintln!("skipping: samples/iff/unsnacker.iff missing");
        return;
    };

    let iff_file = Iff::parse(&data).expect("valid IFF");
    let chunks: Vec<_> = iff_file.chunks().collect::<Result<_, _>>().unwrap();
    let bhav_chunks: Vec<_> = chunks.iter().filter(|c| &c.kind == b"BHAV").collect();
    assert_eq!(bhav_chunks.len(), 2, "unsnacker.iff has 2 BHAVs");

    for bhav_chunk in &bhav_chunks {
        let bhav = Bhav::parse(bhav_chunk.data).expect("BHAV decodes");
        assert_eq!(bhav.header.magic, BhavMagic::V8002);
        assert_eq!(bhav.header.count, 8, "both BHAVs have 8 instructions");
        assert_eq!(bhav.instructions.len(), 8);

        // Every branch destination must either be a valid index or one of the return sentinels.
        for instr in &bhav.instructions {
            for &branch in &[instr.t_dest, instr.f_dest] {
                let valid_index = (branch as usize) < bhav.instructions.len();
                let is_return = Instruction::is_return(branch);
                assert!(
                    valid_index || is_return,
                    "branch 0x{branch:02X} is neither a valid index (<{}) nor a return sentinel",
                    bhav.instructions.len(),
                );
            }
        }
    }
}
