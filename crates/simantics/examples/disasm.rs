//! Disassemble all BHAV chunks of an IFF file in human-readable form.
//!
//! Usage: `cargo run -p simantics --example disasm -- <file.iff> [chunk-id]`
//!
//! Prints each instruction as `<index>: <opcode#hex> <name?> t=<dest> f=<dest> operand=<8B hex>`.
//! Branch destinations are rendered as `→<idx>`, `RET_TRUE`, `RET_FALSE`, or `RET_ERR`.
//!
//! Operand bytes are intentionally left as raw hex — we don't yet interpret per-primitive
//! operand schemas. The `name` column comes from [`simantics::primitive_name`] for primitives
//! and is the call-target opcode (`SUB(0x1234)`, `GLOBAL(0x2010)`, …) for subroutines.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout)]

use iff::Iff;
use simantics::{
    Bhav, Instruction, InstructionKind, classify_opcode, primitive_name,
    vm::format_primitive_operand,
};

fn render_branch(branch: u8, count: u16) -> String {
    if branch == Instruction::RETURN_TRUE {
        "RET_TRUE".to_string()
    } else if branch == Instruction::RETURN_FALSE {
        "RET_FALSE".to_string()
    } else if branch == Instruction::RETURN_ERROR {
        "RET_ERR".to_string()
    } else if u16::from(branch) < count {
        format!("→{branch}")
    } else {
        format!("→{branch}?")
    }
}

fn render_opcode(opcode: u16) -> String {
    match classify_opcode(opcode) {
        InstructionKind::Primitive => primitive_name(opcode)
            .map_or_else(
                || format!("PRIM(0x{opcode:04X}) <unknown>"),
                |name| format!("PRIM(0x{opcode:04X}) {name}"),
            ),
        InstructionKind::SemiGlobal => format!("SEMI(0x{opcode:04X})"),
        InstructionKind::Private => format!("PRIV(0x{opcode:04X})"),
        InstructionKind::Global => format!("GLOB(0x{opcode:04X})"),
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let path = args.next().ok_or("usage: disasm <file.iff> [chunk-id]")?;
    let filter_id: Option<u16> = match args.next() {
        Some(s) => Some(s.parse()?),
        None => None,
    };
    let bytes = std::fs::read(&path)?;
    let iff_file = Iff::parse(&bytes)?;
    let mut count = 0;
    for chunk in iff_file.chunks() {
        let chunk = chunk?;
        if &chunk.kind != b"BHAV" {
            continue;
        }
        if let Some(id) = filter_id {
            if chunk.id != id {
                continue;
            }
        }
        let bhav = match Bhav::parse(chunk.data) {
            Ok(b) => b,
            Err(e) => {
                println!("BHAV id=0x{:04X} ({}): parse error: {e}", chunk.id, chunk.id);
                continue;
            }
        };
        println!(
            "BHAV id=0x{:04X} ({}) magic=0x{:04X} count={} args={} locals={} flags=0x{:02X}",
            chunk.id,
            chunk.id,
            bhav.header.magic.raw(),
            bhav.header.count,
            bhav.header.args,
            bhav.header.locals,
            bhav.header.flags,
        );
        for (i, instr) in bhav.instructions.iter().enumerate() {
            let raw_operand = instr
                .operand
                .iter()
                .map(|b| format!("{b:02X}"))
                .collect::<Vec<_>>()
                .join(" ");
            let decoded = format_primitive_operand(instr.opcode, instr.operand)
                .map(|s| format!(" | {s}"))
                .unwrap_or_default();
            println!(
                "  {:3}: {:30}  t={:8}  f={:8}  operand={raw_operand}{decoded}",
                i,
                render_opcode(instr.opcode),
                render_branch(instr.t_dest, bhav.header.count),
                render_branch(instr.f_dest, bhav.header.count),
            );
        }
        count += 1;
    }
    if count == 0 {
        println!("(no matching BHAV chunks)");
    }
    Ok(())
}
