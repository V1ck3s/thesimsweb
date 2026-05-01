//! Parsers for `SimAntics` bytecode artifacts: BHAV (behavior subroutines) and BCON
//! (constants table). The VM that *executes* BHAV bytecode lives in a future crate;
//! this one only decodes the on-disk layout.
//!
//! Format reference: [`docs/formats/SimAntics.md`].
//!
//! Bytecode is little-endian throughout. Inputs are the data payload of an IFF chunk
//! (i.e. the bytes *after* the 76-byte chunk header — caller is responsible for slicing).

#![no_std]

extern crate alloc;

use alloc::vec::Vec;

use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SimAnticsError {
    #[error("buffer too short")]
    TooShort,
    #[error("unsupported BHAV magic 0x{0:04X} (want 0x8000..=0x8003)")]
    BhavBadMagic(u16),
    #[error("BHAV {kind} 0x{magic:04X} not supported by this parser yet")]
    BhavUnsupportedVariant { kind: &'static str, magic: u16 },
    #[error("BHAV instruction count {count} doesn't match data length (header {header} + 12·{count} > {got})")]
    BhavLengthMismatch { count: u16, header: usize, got: usize },
    #[error("BCON length mismatch (expected {expected}, got {got})")]
    BconLengthMismatch { expected: usize, got: usize },
}

// ---- BHAV ----

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BhavMagic {
    V8000,
    V8001,
    V8002,
    V8003,
}

impl BhavMagic {
    #[must_use]
    pub const fn raw(self) -> u16 {
        match self {
            Self::V8000 => 0x8000,
            Self::V8001 => 0x8001,
            Self::V8002 => 0x8002,
            Self::V8003 => 0x8003,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct BhavHeader {
    pub magic: BhavMagic,
    pub count: u16,
    /// `0x8002` only; `0` for older variants.
    pub kind: u8,
    pub args: u8,
    pub locals: u8,
    pub flags: u8,
    /// `0x8002`-only opaque tail field. Niotso labels it "Zero" but real samples have non-zero values.
    pub extra: u32,
}

#[derive(Debug, Clone, Copy)]
pub struct Instruction {
    pub opcode: u16,
    pub t_dest: u8,
    pub f_dest: u8,
    pub operand: [u8; 8],
}

impl Instruction {
    pub const RETURN_TRUE: u8 = 0xFF;
    pub const RETURN_FALSE: u8 = 0xFE;
    pub const RETURN_ERROR: u8 = 0xFD;

    #[must_use]
    pub const fn is_primitive(&self) -> bool {
        self.opcode < 256
    }

    #[must_use]
    pub const fn is_return(branch: u8) -> bool {
        branch >= Self::RETURN_ERROR
    }
}

pub const INSTRUCTION_BYTES: usize = 12;

#[derive(Debug, Clone)]
pub struct Bhav {
    pub header: BhavHeader,
    pub instructions: Vec<Instruction>,
}

impl Bhav {
    /// Parse a BHAV chunk's data payload.
    ///
    /// # Errors
    /// Returns `BhavBadMagic`, `BhavUnsupportedVariant`, or `BhavLengthMismatch`
    /// if the buffer doesn't decode cleanly.
    pub fn parse(data: &[u8]) -> Result<Self, SimAnticsError> {
        if data.len() < 4 {
            return Err(SimAnticsError::TooShort);
        }
        let magic_raw = read_u16_le(data, 0)?;
        let magic = match magic_raw {
            0x8000 => BhavMagic::V8000,
            0x8001 => BhavMagic::V8001,
            0x8002 => BhavMagic::V8002,
            0x8003 => BhavMagic::V8003,
            other => return Err(SimAnticsError::BhavBadMagic(other)),
        };
        let (header, header_len): (BhavHeader, usize) = match magic {
            BhavMagic::V8000 | BhavMagic::V8001 => {
                let count = read_u16_le(data, 2)?;
                (
                    BhavHeader {
                        magic,
                        count,
                        kind: 0,
                        args: 0,
                        locals: 0,
                        flags: 0,
                        extra: 0,
                    },
                    4,
                )
            }
            BhavMagic::V8002 => {
                if data.len() < 12 {
                    return Err(SimAnticsError::TooShort);
                }
                let count = read_u16_le(data, 2)?;
                let kind = data[4];
                let args = data[5];
                let locals = data[6];
                let flags = data[7];
                let extra = read_u32_le(data, 8)?;
                (
                    BhavHeader {
                        magic,
                        count,
                        kind,
                        args,
                        locals,
                        flags,
                        extra,
                    },
                    12,
                )
            }
            BhavMagic::V8003 => {
                return Err(SimAnticsError::BhavUnsupportedVariant {
                    kind: "v8003 layout",
                    magic: magic_raw,
                });
            }
        };
        let payload_end = header_len
            .checked_add((header.count as usize) * INSTRUCTION_BYTES)
            .ok_or(SimAnticsError::TooShort)?;
        if payload_end > data.len() {
            return Err(SimAnticsError::BhavLengthMismatch {
                count: header.count,
                header: header_len,
                got: data.len(),
            });
        }
        let mut instructions = Vec::with_capacity(header.count as usize);
        let mut cursor = header_len;
        for _ in 0..header.count {
            let opcode = read_u16_le(data, cursor)?;
            let t_dest = data[cursor + 2];
            let f_dest = data[cursor + 3];
            let mut operand = [0u8; 8];
            operand.copy_from_slice(&data[cursor + 4..cursor + 12]);
            instructions.push(Instruction {
                opcode,
                t_dest,
                f_dest,
                operand,
            });
            cursor += INSTRUCTION_BYTES;
        }
        Ok(Self {
            header,
            instructions,
        })
    }
}

// ---- BCON ----

#[derive(Debug, Clone)]
pub struct Bcon {
    pub flags: u8,
    pub constants: Vec<u16>,
}

impl Bcon {
    /// Parse a BCON chunk's data payload.
    ///
    /// # Errors
    /// Returns `TooShort` if the buffer can't fit the count+flags header, or
    /// `BconLengthMismatch` if the declared count doesn't fit the payload.
    pub fn parse(data: &[u8]) -> Result<Self, SimAnticsError> {
        if data.len() < 2 {
            return Err(SimAnticsError::TooShort);
        }
        let count = data[0] as usize;
        let flags = data[1];
        let expected = 2 + count * 2;
        if data.len() != expected {
            return Err(SimAnticsError::BconLengthMismatch {
                expected,
                got: data.len(),
            });
        }
        let mut constants = Vec::with_capacity(count);
        for i in 0..count {
            constants.push(read_u16_le(data, 2 + i * 2)?);
        }
        Ok(Self { flags, constants })
    }
}

// ---- helpers ----

fn read_u16_le(data: &[u8], offset: usize) -> Result<u16, SimAnticsError> {
    if offset + 2 > data.len() {
        return Err(SimAnticsError::TooShort);
    }
    Ok(u16::from_le_bytes([data[offset], data[offset + 1]]))
}

fn read_u32_le(data: &[u8], offset: usize) -> Result<u32, SimAnticsError> {
    if offset + 4 > data.len() {
        return Err(SimAnticsError::TooShort);
    }
    Ok(u32::from_le_bytes([
        data[offset],
        data[offset + 1],
        data[offset + 2],
        data[offset + 3],
    ]))
}

#[cfg(test)]
extern crate std;

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use std::vec;

    fn build_v8002_one_instruction() -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(&0x8002u16.to_le_bytes());
        buf.extend_from_slice(&1u16.to_le_bytes()); // count
        buf.extend_from_slice(&[0, 0, 0, 0]); // type/args/locals/flags
        buf.extend_from_slice(&0u32.to_le_bytes()); // extra
        // Instruction: opcode 2 (Expression), t_dest 0xFF (return true), f_dest 0xFD (error), 8 bytes operand
        buf.extend_from_slice(&2u16.to_le_bytes());
        buf.push(0xFF);
        buf.push(0xFD);
        buf.extend_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8]);
        buf
    }

    #[test]
    fn bhav_v8002_one_instruction() {
        let buf = build_v8002_one_instruction();
        let bhav = Bhav::parse(&buf).unwrap();
        assert_eq!(bhav.header.magic, BhavMagic::V8002);
        assert_eq!(bhav.header.count, 1);
        assert_eq!(bhav.instructions.len(), 1);
        let i = &bhav.instructions[0];
        assert_eq!(i.opcode, 2);
        assert_eq!(i.t_dest, 0xFF);
        assert_eq!(i.f_dest, 0xFD);
        assert_eq!(i.operand, [1, 2, 3, 4, 5, 6, 7, 8]);
        assert!(i.is_primitive());
        assert!(Instruction::is_return(i.t_dest));
        assert!(Instruction::is_return(i.f_dest));
    }

    #[test]
    fn bhav_v8000_short_header() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&0x8000u16.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes()); // count = 0
        let bhav = Bhav::parse(&buf).unwrap();
        assert_eq!(bhav.header.magic, BhavMagic::V8000);
        assert_eq!(bhav.header.count, 0);
        assert!(bhav.instructions.is_empty());
    }

    #[test]
    fn bhav_rejects_bad_magic() {
        let buf = vec![0x00, 0x00, 0x00, 0x00];
        assert!(matches!(Bhav::parse(&buf), Err(SimAnticsError::BhavBadMagic(0))));
    }

    #[test]
    fn bhav_rejects_truncated_payload() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&0x8002u16.to_le_bytes());
        buf.extend_from_slice(&5u16.to_le_bytes()); // claim 5 instructions
        buf.extend_from_slice(&[0, 0, 0, 0]); // type/args/locals/flags
        buf.extend_from_slice(&0u32.to_le_bytes()); // extra
        // …no instructions — buffer too short.
        assert!(matches!(
            Bhav::parse(&buf),
            Err(SimAnticsError::BhavLengthMismatch { count: 5, .. })
        ));
    }

    #[test]
    fn bcon_round_trip() {
        let mut buf = Vec::new();
        buf.push(3); // count
        buf.push(0x80); // flags
        for c in [10u16, 20, 30] {
            buf.extend_from_slice(&c.to_le_bytes());
        }
        let bcon = Bcon::parse(&buf).unwrap();
        assert_eq!(bcon.flags, 0x80);
        assert_eq!(bcon.constants, vec![10, 20, 30]);
    }

    #[test]
    fn bcon_rejects_length_mismatch() {
        let buf = [3u8, 0, 1, 0, 2, 0]; // claim 3, supply 2
        assert!(matches!(
            Bcon::parse(&buf),
            Err(SimAnticsError::BconLengthMismatch { .. })
        ));
    }
}
