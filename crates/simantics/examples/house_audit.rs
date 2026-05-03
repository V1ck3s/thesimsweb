//! Audit a House.iff: parse HOUS, FLRm, WALm, Arry chunks and print a
//! summary so we can spot decode errors against the FreeSO algorithm.
//!
//! Usage: `cargo run -p simantics --example house_audit -- <House.iff>`

#![allow(clippy::unwrap_used, clippy::print_stdout)]

use iff::Iff;
use simantics::{Arry, Flrm, Hous};

fn main() {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("usage: house_audit <House.iff>");
        return;
    };
    let data = std::fs::read(&path).expect("read");
    let iff = Iff::parse(&data).expect("iff parse");
    println!("== {path} ==");
    for chunk in iff.chunks() {
        let chunk = chunk.expect("chunk");
        match &chunk.kind {
            b"HOUS" => match Hous::parse(chunk.data) {
                Ok(h) => println!(
                    "  HOUS id={} v{} name=\"{}\" trailing={}B",
                    chunk.id, h.version, h.name, h.trailing.len()
                ),
                Err(e) => println!("  HOUS id={} ERR: {e}", chunk.id),
            },
            b"FLRm" | b"WALm" => match Flrm::parse(chunk.data, u32::from(chunk.id)) {
                Ok(f) => {
                    let kind = std::str::from_utf8(&chunk.kind).unwrap_or("?");
                    println!(
                        "  {} id={} v{} count={} entries:",
                        kind,
                        chunk.id,
                        f.version,
                        f.entries.len()
                    );
                    for e in &f.entries {
                        println!(
                            "    {:36}  unknown1={:#x} id={} trailing={}B",
                            e.filename,
                            e.unknown1,
                            e.id,
                            e.trailing.len()
                        );
                    }
                }
                Err(e) => {
                    let kind = std::str::from_utf8(&chunk.kind).unwrap_or("?");
                    println!("  {} id={} ERR: {e}", kind, chunk.id);
                }
            },
            b"Arry" => match Arry::parse(chunk.data) {
                Ok(a) => {
                    let nonzero = a.data.iter().filter(|&&b| b != 0).count();
                    println!(
                        "  Arry id={} {}x{} kind={:?} unknown={:#x} data={}B nonzero={}",
                        chunk.id, a.width, a.height, a.kind, a.unknown, a.data.len(), nonzero,
                    );
                }
                Err(e) => println!("  Arry id={} ERR: {e}", chunk.id),
            },
            _ => {}
        }
    }
}
