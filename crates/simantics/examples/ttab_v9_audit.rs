//! Empirical audit of TTAB v9/v10 chunks: dump count, body length, and the
//! first ~20 bytes of the field-encoded body. Used to bisect the bit-stream
//! layout against Niotso's hint widths ({5, 8, 13, 16} for 2-byte fields,
//! {6, 11, 21, 32} for 4-byte fields).
//!
//! Usage: `cargo run -p simantics --example ttab_v9_audit -- <file.iff|file.far> [...]`

#![allow(clippy::unwrap_used, clippy::print_stdout, clippy::cast_lossless)]

use far::Far;
use iff::Iff;
use simantics::{Ttab, TtabHeader};

#[derive(Default)]
struct Tally {
    v9_chunks: u32,
    v9_decoded_ok: u32,
    v9_decoded_sus: u32,
    v9_decode_err: u32,
    sample_action: Vec<u16>,
    sample_motive_count: Vec<u32>,
    sample_atten_code: Vec<u32>,
}

fn looks_sensible(t: &Ttab) -> bool {
    for it in &t.interactions {
        // motive_entry_count is "always 16" per Niotso (or 0 for some special objects).
        if !(it.motive_entry_count == 0 || it.motive_entry_count == 16) {
            return false;
        }
        // attenuation_code 0..=4 per Niotso.
        if it.attenuation_code > 4 {
            return false;
        }
        // action_function should be a BHAV chunk id: 0x1000+ private, 0x2000+
        // global, 0x0100+ semi-global. Zero is valid (no interaction).
        if it.action_function != 0 && it.action_function < 0x0100 {
            return false;
        }
    }
    true
}

fn audit_iff(name: &str, data: &[u8], tally: &mut Tally) {
    let Ok(iff_file) = Iff::parse(data) else { return };
    for chunk in iff_file.chunks() {
        let Ok(chunk) = chunk else { continue };
        if &chunk.kind != b"TTAB" {
            continue;
        }
        let Ok(hdr) = TtabHeader::parse(chunk.data) else { continue };
        if hdr.version < 9 {
            continue;
        }
        tally.v9_chunks += 1;
        match Ttab::parse(chunk.data) {
            Ok(t) => {
                let sensible = looks_sensible(&t);
                if sensible {
                    tally.v9_decoded_ok += 1;
                } else {
                    tally.v9_decoded_sus += 1;
                }
                if let Some(it) = t.interactions.first() {
                    if tally.sample_action.len() < 8 {
                        tally.sample_action.push(it.action_function);
                        tally.sample_motive_count.push(it.motive_entry_count);
                        tally.sample_atten_code.push(it.attenuation_code);
                    }
                }
                println!(
                    "{}/{} v{} count={} body={}B  decoded={} {}{}",
                    name,
                    chunk.id,
                    hdr.version,
                    hdr.count,
                    hdr.raw_payload.len(),
                    t.interactions.len(),
                    if sensible { "OK" } else { "SUS" },
                    t.interactions
                        .first()
                        .map(|it| format!(
                            "  action=0x{:04x} guard=0x{:04x} mcount={} atten={} thr={} ttas={}",
                            it.action_function,
                            it.guard_function,
                            it.motive_entry_count,
                            it.attenuation_code,
                            it.autonomy_threshold,
                            it.ttas_index,
                        ))
                        .unwrap_or_default(),
                );
            }
            Err(e) => {
                tally.v9_decode_err += 1;
                println!(
                    "{}/{} v{} count={} body={}B  ERR: {}",
                    name,
                    chunk.id,
                    hdr.version,
                    hdr.count,
                    hdr.raw_payload.len(),
                    e,
                );
            }
        }
    }
}

fn main() {
    let paths: Vec<String> = std::env::args().skip(1).collect();
    if paths.is_empty() {
        eprintln!("usage: ttab_v9_audit <file.iff|file.far> [...]");
        return;
    }
    let mut tally = Tally::default();
    for path in &paths {
        let data = match std::fs::read(path) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("skip {path}: {e}");
                continue;
            }
        };
        let basename = std::path::Path::new(path)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone());
        if far::check_magic(&data).is_ok() {
            match Far::parse(&data) {
                Ok(archive) => {
                    for entry in archive.entries() {
                        let Ok(entry) = entry else { continue };
                        let Ok(payload) = archive.payload(&entry) else { continue };
                        let name = std::str::from_utf8(entry.filename).unwrap_or("?");
                        audit_iff(name, payload, &mut tally);
                    }
                }
                Err(e) => eprintln!("skip {path}: {e}"),
            }
        } else {
            audit_iff(&basename, &data, &mut tally);
        }
    }
    println!();
    println!(
        "Summary: {} v9/v10 chunks scanned. decoded OK = {}, SUS = {}, error = {}",
        tally.v9_chunks, tally.v9_decoded_ok, tally.v9_decoded_sus, tally.v9_decode_err
    );
    println!(
        "Sample (first 8) first-interaction action=0x{:04x?} mcount={:?} atten={:?}",
        tally.sample_action, tally.sample_motive_count, tally.sample_atten_code,
    );
}
