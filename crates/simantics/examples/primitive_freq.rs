//! Tally primitive opcodes across every BHAV chunk in one or more IFF files
//! (or FAR archives — the analyzer auto-detects the magic and walks them).
//!
//! Usage: `cargo run -p simantics --example primitive_freq -- <file.iff|file.far> [...]`
//!
//! Prints a frequency-sorted table (opcode count) covering only opcodes < 256,
//! plus a separate count of subroutine calls (semi-global, private, global). Useful
//! for deciding which primitives to implement next.

#![allow(clippy::unwrap_used, clippy::print_stdout)]

use std::collections::BTreeMap;

use far::Far;
use iff::Iff;
use simantics::{Bhav, InstructionKind, classify_opcode, primitive_name};

struct Stats {
    prim_counts: BTreeMap<u16, u32>,
    semi: u32,
    priv_: u32,
    glob: u32,
    total_instructions: u32,
    bhav_count: u32,
}

impl Stats {
    const fn new() -> Self {
        Self {
            prim_counts: BTreeMap::new(),
            semi: 0,
            priv_: 0,
            glob: 0,
            total_instructions: 0,
            bhav_count: 0,
        }
    }

    fn ingest_iff(&mut self, data: &[u8]) {
        let Ok(iff_file) = Iff::parse(data) else { return };
        for chunk in iff_file.chunks() {
            let Ok(chunk) = chunk else { continue };
            if &chunk.kind != b"BHAV" {
                continue;
            }
            let Ok(bhav) = Bhav::parse(chunk.data) else { continue };
            self.bhav_count += 1;
            for instr in &bhav.instructions {
                self.total_instructions += 1;
                match classify_opcode(instr.opcode) {
                    InstructionKind::Primitive => {
                        *self.prim_counts.entry(instr.opcode).or_insert(0) += 1;
                    }
                    InstructionKind::SemiGlobal => self.semi += 1,
                    InstructionKind::Private => self.priv_ += 1,
                    InstructionKind::Global => self.glob += 1,
                }
            }
        }
    }
}

fn main() {
    let paths: Vec<String> = std::env::args().skip(1).collect();
    if paths.is_empty() {
        eprintln!("usage: primitive_freq <file.iff|file.far> [...]");
        return;
    }
    let mut stats = Stats::new();
    for path in &paths {
        let data = match std::fs::read(path) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("skip {path}: {e}");
                continue;
            }
        };
        if far::check_magic(&data).is_ok() {
            // FAR archive: walk every entry that looks like an IFF.
            match Far::parse(&data) {
                Ok(archive) => {
                    for entry in archive.entries() {
                        let Ok(entry) = entry else { continue };
                        let Ok(payload) = archive.payload(&entry) else { continue };
                        stats.ingest_iff(payload);
                    }
                }
                Err(e) => eprintln!("skip {path}: {e}"),
            }
        } else {
            stats.ingest_iff(&data);
        }
    }
    println!(
        "Scanned {} BHAVs, {} instructions across {} files.",
        stats.bhav_count, stats.total_instructions, paths.len()
    );
    println!();
    println!(
        "Sub-routine calls: semi-global={}  private={}  global={}",
        stats.semi, stats.priv_, stats.glob
    );
    println!();
    println!("Primitive frequency (opcode < 256):");
    let mut sorted: Vec<(u16, u32)> = stats.prim_counts.into_iter().collect();
    sorted.sort_by_key(|kv| std::cmp::Reverse(kv.1));
    let prim_total: u32 = sorted.iter().map(|(_, c)| *c).sum();
    for (opcode, count) in &sorted {
        let name = primitive_name(*opcode).unwrap_or("<unknown>");
        let pct = if prim_total > 0 {
            (f64::from(*count) / f64::from(prim_total)) * 100.0
        } else {
            0.0
        };
        println!("  0x{opcode:04X} {name:38}  {count:6}  ({pct:5.1}%)");
    }
}
