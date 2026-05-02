//! Decode an EA-XA file to a standard RIFF WAV. Useful for verifying the
//! decoder output in a media player.
//!
//! Usage: `cargo run -p audio --example xa_to_wav -- <input.xa> <output.wav>`

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: xa_to_wav <input.xa> <output.wav>");
        return ExitCode::from(2);
    }
    let input = PathBuf::from(&args[1]);
    let output = PathBuf::from(&args[2]);
    let xa = match fs::read(&input) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("read {}: {e}", input.display());
            return ExitCode::FAILURE;
        }
    };
    let pcm = match audio::Xa::decode(&xa) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("decode: {e}");
            return ExitCode::FAILURE;
        }
    };
    eprintln!(
        "decoded {} samples · {} ch · {} Hz · {:.2}s",
        pcm.samples.len(),
        pcm.channels,
        pcm.sample_rate,
        pcm.samples.len() as f64 / f64::from(pcm.sample_rate) / f64::from(pcm.channels),
    );
    if let Err(e) = fs::write(&output, pcm.to_wav()) {
        eprintln!("write {}: {e}", output.display());
        return ExitCode::FAILURE;
    }
    eprintln!("wrote {}", output.display());
    ExitCode::SUCCESS
}
