//! Tiny CLI to list or extract entries of a FAR v1 archive.
//!
//! Usage:
//!   cargo run -p far --example dump -- list   <archive.far>
//!   cargo run -p far --example dump -- extract <archive.far> <out-dir>

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::print_stdout)]

use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    match args.as_slice() {
        [cmd, archive] if cmd == "list" => cmd_list(archive),
        [cmd, archive, out] if cmd == "extract" => cmd_extract(archive, out),
        _ => {
            eprintln!("usage: dump list <archive.far>");
            eprintln!("       dump extract <archive.far> <out-dir>");
            ExitCode::from(2)
        }
    }
}

fn cmd_list(archive: &str) -> ExitCode {
    let data = match fs::read(archive) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("read {archive}: {e}");
            return ExitCode::FAILURE;
        }
    };
    let far = match far::Far::parse(&data) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("parse: {e}");
            return ExitCode::FAILURE;
        }
    };
    println!("entries: {}", far.entry_count());
    println!("manifest_offset: 0x{:x}", far.manifest_offset());
    println!("{:<10} {:<10} {:<10} filename", "offset", "size_dec", "size_cmp");
    for entry in far.entries() {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                eprintln!("entry: {e}");
                return ExitCode::FAILURE;
            }
        };
        let name = String::from_utf8_lossy(entry.filename);
        println!(
            "0x{:08x} {:<10} {:<10} {}",
            entry.offset, entry.size_decompressed, entry.size_compressed, name
        );
    }
    ExitCode::SUCCESS
}

fn cmd_extract(archive: &str, out: &str) -> ExitCode {
    let data = match fs::read(archive) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("read {archive}: {e}");
            return ExitCode::FAILURE;
        }
    };
    let far = match far::Far::parse(&data) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("parse: {e}");
            return ExitCode::FAILURE;
        }
    };
    let out_dir = PathBuf::from(out);
    if let Err(e) = fs::create_dir_all(&out_dir) {
        eprintln!("mkdir {out}: {e}");
        return ExitCode::FAILURE;
    }
    let mut count = 0usize;
    for entry in far.entries() {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                eprintln!("entry: {e}");
                return ExitCode::FAILURE;
            }
        };
        let payload = match far.payload(&entry) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("payload: {e}");
                return ExitCode::FAILURE;
            }
        };
        let name = String::from_utf8_lossy(entry.filename);
        let safe_name = name.replace(['/', '\\'], "_");
        let path = out_dir.join(&safe_name);
        if let Err(e) = fs::write(&path, payload) {
            eprintln!("write {}: {e}", path.display());
            return ExitCode::FAILURE;
        }
        count += 1;
    }
    println!("extracted {count} entries to {out}");
    ExitCode::SUCCESS
}
