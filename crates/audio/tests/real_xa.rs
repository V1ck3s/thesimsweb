//! Integration test on real `.XA` files extracted from a Sims install.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;

use audio::Xa;

fn sample_path(name: &str) -> PathBuf {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    PathBuf::from(manifest_dir).join("../..").join("samples/audio").join(name)
}

#[test]
fn decodes_tv_comm_beer_xa() {
    let Ok(data) = std::fs::read(sample_path("TV_COMM_BEER.XA")) else {
        eprintln!("skipping: samples/audio/TV_COMM_BEER.XA missing");
        return;
    };
    let header = Xa::parse_header(&data).expect("XA header");
    eprintln!(
        "TV_COMM_BEER.XA: magic={:?} pcm_size={} ch={} sr={} bps={}",
        std::str::from_utf8(&header.magic).unwrap_or("?"),
        header.pcm_size_bytes,
        header.channels,
        header.sample_rate,
        header.bits_per_sample,
    );
    assert_eq!(header.bits_per_sample, 16);
    assert!(matches!(header.channels, 1 | 2));
    assert!(header.sample_rate >= 8000 && header.sample_rate <= 48000);

    let pcm = Xa::decode(&data).expect("XA decodes");
    eprintln!("decoded {} samples ({} bytes)", pcm.samples.len(), pcm.samples.len() * 2);
    // Reasonable sanity: at least 1 second of audio.
    assert!(pcm.samples.len() as u32 >= header.sample_rate);
    // PCM size from header should be in the same ballpark (some XA files
    // pad/truncate vs the declared count). Accept ±10% slack.
    let declared = header.pcm_size_bytes as i64;
    let actual = (pcm.samples.len() * 2) as i64;
    let slack = declared / 10;
    assert!(
        (actual - declared).abs() <= slack.max(1),
        "pcm size mismatch: declared={declared}, actual={actual}"
    );

    // The decoded signal must not be all-zero (there should be real audio).
    let nonzero = pcm.samples.iter().filter(|&&s| s != 0).count();
    assert!(nonzero > pcm.samples.len() / 10, "decoded PCM is mostly silent ({nonzero}/{})", pcm.samples.len());

    // Wrap into WAV — the result should start with RIFF…WAVE…fmt ….
    let wav = pcm.to_wav();
    assert_eq!(&wav[0..4], b"RIFF");
    assert_eq!(&wav[8..12], b"WAVE");
}
