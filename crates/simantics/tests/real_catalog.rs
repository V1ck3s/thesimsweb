//! Integration tests on real OBJD/TTAB/TTAs/STR# chunks extracted from a Sims install.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::similar_names,
)]

use std::path::PathBuf;

use iff::Iff;
use simantics::{Dgrp, Objd, Objf, StrEntry, StrTable, Ttab, objd_field};

fn sample_path(name: &str) -> PathBuf {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    PathBuf::from(manifest_dir).join("../..").join("samples/iff").join(name)
}

#[test]
fn alarm_clock_objd_ttab_ttas() {
    let Ok(data) = std::fs::read(sample_path("AlarmClock.iff")) else {
        eprintln!("skipping: samples/iff/AlarmClock.iff missing");
        return;
    };
    let iff_file = Iff::parse(&data).expect("valid IFF");
    let chunks: Vec<_> = iff_file.chunks().collect::<Result<_, _>>().unwrap();

    // Exactly one OBJD with id 16807 (the alarm clock's GUID-derived chunk id).
    let objd_chunks: Vec<_> = chunks.iter().filter(|c| &c.kind == b"OBJD").collect();
    assert_eq!(objd_chunks.len(), 1);
    let objd = Objd::parse(objd_chunks[0].data).expect("OBJD decodes");
    assert_eq!(objd.version, 138);
    assert_eq!(objd.field(objd_field::OBJECT_TYPE), Some(4), "buyable");
    assert_eq!(objd.field(objd_field::PRICE), Some(30));
    assert_eq!(objd.field(objd_field::TTAB_ID), Some(129));
    assert_eq!(objd.field(objd_field::ANIM_TABLE_ID), Some(129));
    assert_eq!(objd.guid(), 0xA483_D725);

    // The TTAB is v8 with 2 interactions (Niotso wiki + AlarmClock observed).
    let ttab_chunks: Vec<_> = chunks.iter().filter(|c| &c.kind == b"TTAB").collect();
    assert_eq!(ttab_chunks.len(), 1);
    let ttab = Ttab::parse(ttab_chunks[0].data).expect("TTAB decodes");
    assert_eq!(ttab.version, 8);
    assert_eq!(ttab.interactions.len(), 2);
    for inter in &ttab.interactions {
        assert_eq!(inter.motive_entry_count, 16);
        assert_eq!(inter.motives.len(), 16);
        assert!(
            inter.attenuation_code <= 4,
            "attenuation_code {} out of range",
            inter.attenuation_code,
        );
    }

    // TTAs is a STR# variant. The chunk has the same id as the TTAB (129).
    let ttas_chunks: Vec<_> = chunks
        .iter()
        .filter(|c| &c.kind == b"TTAs" && c.id == 129)
        .collect();
    assert_eq!(ttas_chunks.len(), 1);
    let ttas = StrTable::parse(ttas_chunks[0].data).expect("TTAs decodes");
    // TS1 ships TTAs in v-3 (language-coded pairs) for multi-language UI.
    assert_eq!(ttas.version, -3);
    // At minimum we should have 2 (or more) entries — one English label per interaction.
    assert!(
        !ttas.entries.is_empty(),
        "TTAs should yield at least one label",
    );
    // First entry should at least be a PairWithLang with non-empty data when language code matches an interaction.
    let any_with_label = ttas.entries.iter().any(|e| match e {
        StrEntry::PairWithLang { data, .. } => !data.is_empty(),
        _ => false,
    });
    assert!(any_with_label);
}

#[test]
fn alarm_clock_objf_dispatch_table() {
    let Ok(data) = std::fs::read(sample_path("AlarmClock.iff")) else {
        eprintln!("skipping: samples/iff/AlarmClock.iff missing");
        return;
    };
    let iff_file = Iff::parse(&data).expect("valid IFF");
    let chunks: Vec<_> = iff_file.chunks().collect::<Result<_, _>>().unwrap();

    let objf_chunks: Vec<_> = chunks.iter().filter(|c| &c.kind == b"OBJf").collect();
    assert_eq!(objf_chunks.len(), 1);
    let objf = Objf::parse(objf_chunks[0].data).expect("OBJf decodes");
    assert_eq!(objf.version, 0);
    // AlarmClock declares 31 events in its OBJf (verified via xxd).
    assert_eq!(objf.entries.len(), 31);
    // Event 0 dispatches to action BHAV 0x1005 with no condition (verified via xxd).
    assert_eq!(
        objf.dispatch(0),
        Some(simantics::ObjfEntry { condition: 0, action: 0x1005 })
    );
    // Event 1 dispatches to action BHAV 0x1000 with no condition.
    assert_eq!(
        objf.dispatch(1),
        Some(simantics::ObjfEntry { condition: 0, action: 0x1000 })
    );
    // The remaining events are unset; dispatch returns None for those.
    assert_eq!(objf.dispatch(30), None);
}

#[test]
fn alarm_clock_dgrp_v20004_has_12_images() {
    let Ok(data) = std::fs::read(sample_path("AlarmClock.iff")) else {
        eprintln!("skipping: samples/iff/AlarmClock.iff missing");
        return;
    };
    let iff_file = Iff::parse(&data).expect("valid IFF");
    let chunks: Vec<_> = iff_file.chunks().collect::<Result<_, _>>().unwrap();
    let dgrp_chunks: Vec<_> = chunks.iter().filter(|c| &c.kind == b"DGRP").collect();
    // AlarmClock has 7 DGRP chunks (one per object state, IDs 128..=134).
    assert_eq!(dgrp_chunks.len(), 7);
    for chunk in &dgrp_chunks {
        let dgrp = Dgrp::parse(chunk.data).expect("DGRP decodes");
        assert_eq!(dgrp.version, 20004);
        // Always 4 directions × 3 zooms = 12 images (per Niotso).
        assert_eq!(dgrp.images.len(), 12);
        let directions: std::collections::BTreeSet<_> =
            dgrp.images.iter().map(|i| i.direction_flags).collect();
        let zooms: std::collections::BTreeSet<_> =
            dgrp.images.iter().map(|i| i.zoom_level).collect();
        assert_eq!(directions, [0x01u32, 0x04, 0x10, 0x40].into_iter().collect());
        assert_eq!(zooms, [1u32, 2, 3].into_iter().collect());
    }
    // Every image of DGRP[128] points to at least one valid SPR2 chunk.
    let dgrp = Dgrp::parse(dgrp_chunks[0].data).unwrap();
    let spr2_ids: std::collections::BTreeSet<u16> = chunks
        .iter()
        .filter(|c| &c.kind == b"SPR2")
        .map(|c| c.id)
        .collect();
    for img in &dgrp.images {
        for sp in &img.sprites {
            let id = u16::try_from(sp.spr_chunk_id).expect("chunk id fits in u16");
            assert!(
                spr2_ids.contains(&id),
                "DGRP references missing SPR2 id {id}"
            );
        }
    }
}
