//! List all chunks in an IFF file: type, id, flags, offset, size.
//!
//! Usage:
//!   cargo run -p iff --example dump -- <file.iff>

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::print_stdout)]

use std::env;
use std::fs;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    let Some(path) = args.first() else {
        eprintln!("usage: dump <file.iff>");
        return ExitCode::from(2);
    };
    let data = match fs::read(path) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("read {path}: {e}");
            return ExitCode::FAILURE;
        }
    };
    let iff_file = match iff::Iff::parse(&data) {
        Ok(i) => i,
        Err(e) => {
            eprintln!("parse: {e}");
            return ExitCode::FAILURE;
        }
    };
    println!(
        "version: {:?}  rsmp_offset: 0x{:x}  size: {} B",
        iff_file.version(),
        iff_file.rsmp_offset(),
        data.len()
    );
    println!("{:<10} {:<6} {:<6} {:<6} {:<10} kind", "offset", "size", "id", "flags", "data_len");
    let mut count = 0usize;
    for chunk in iff_file.chunks() {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                eprintln!("chunk: {e}");
                return ExitCode::FAILURE;
            }
        };
        let kind = std::str::from_utf8(&chunk.kind).unwrap_or("????");
        println!(
            "0x{:08x} {:<6} {:<6} 0x{:04x} {:<10} {}",
            chunk.offset,
            chunk.size,
            chunk.id,
            chunk.flags,
            chunk.data.len(),
            kind
        );
        count += 1;
    }
    println!("{count} chunks");
    ExitCode::SUCCESS
}
