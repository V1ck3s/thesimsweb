//! Parsers for `SimAntics` bytecode artifacts (BHAV, BCON) and the catalog chunks
//! that describe how objects expose themselves to the runtime: STR# (text tables),
//! TRCN (BCON labels), OBJD (object definition), TTAB (interaction table).
//!
//! The VM that *executes* BHAV bytecode lives in a future crate; this one only
//! decodes the on-disk layout.
//!
//! Format reference: [`docs/formats/SimAntics.md`] and [`docs/formats/Catalog.md`].
//!
//! Bytecode is little-endian throughout. Inputs are the data payload of an IFF chunk
//! (i.e. the bytes *after* the 76-byte chunk header — caller is responsible for slicing).

#![no_std]

extern crate alloc;

use alloc::vec::Vec;

use thiserror::Error;

pub mod vm;

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
    #[error("STR# version {0} is not supported (need 0, -1, -2, -3)")]
    StrUnsupportedVersion(i16),
    #[error("STR# truncated: ran out of bytes while reading entry {index}")]
    StrTruncated { index: u16 },
    #[error("TRCN version {0} is not supported (need 0 or 1)")]
    TrcnUnsupportedVersion(u32),
    #[error("TRCN truncated at entry {index}")]
    TrcnTruncated { index: u32 },
    #[error("OBJD payload size {got} not a multiple of 2 after the version u32")]
    ObjdMisalignedPayload { got: usize },
    #[error("TTAB version {0} is not supported (need 5 or 8 — v9+ is field-encoded)")]
    TtabUnsupportedVersion(u16),
    #[error("OBJf version {0} is not supported (need 0)")]
    ObjfUnsupportedVersion(u32),
    #[error("GLOB chunk is empty")]
    GlobEmpty,
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

// ---- Opcode + Scope tables ----

/// Human-readable name of a `SimAntics` primitive (opcode `< 256`).
///
/// Source: Niotso wiki, [`SimAntics`] page §Primitives. Returns `None` for opcodes
/// outside the documented `0..=67` range. Names are kept verbatim as Niotso labels
/// them — including the "(used in Sims 2.0)" tags on slots 51..=54 — so traces stay
/// faithful to the reference.
///
/// [`SimAntics`]: http://wiki.niotso.org/SimAntics
#[must_use]
pub const fn primitive_name(opcode: u16) -> Option<&'static str> {
    Some(match opcode {
        0 => "Sleep",
        1 => "Generic Sims Online Call",
        2 => "Expression",
        3 => "Report Metric",
        4 => "grab",
        5 => "drop",
        6 => "Change Suit/Accessory",
        7 => "Refresh",
        8 => "Random Number",
        9 => "burn",
        10 => "Sims1.0 tutorial",
        11 => "Get Distance To",
        12 => "Get Direction To",
        13 => "Push Interaction",
        14 => "Find Best Object for Function",
        15 => "Break Point",
        16 => "Find Location For",
        17 => "idle for input",
        18 => "Remove Object Instance",
        19 => "make new character",
        20 => "Run Functional Tree",
        21 => "show string",
        22 => "look towards",
        23 => "Play Sound Event",
        24 => "old relationship",
        25 => "Transfer Funds",
        26 => "Relationship",
        27 => "Go To Relative Position",
        28 => "Run Tree by Name",
        29 => "Set Motive Change",
        30 => "Syslog",
        31 => "Set to Next",
        32 => "Test Object Type",
        33 => "find 5 worst motives",
        34 => "ui effect",
        35 => "Special Effect",
        36 => "Dialog - Private Strings",
        37 => "Test Sim Interacting With",
        38 => "Dialog - Global Strings",
        39 => "Dialog - Semi-Global Strings",
        40 => "OnlineJobsCall",
        41 => "Set Balloon/Headline",
        42 => "Create New Object Instance",
        43 => "drop onto",
        44 => "Animate Sim",
        45 => "Go To Routing Slot",
        46 => "Snap",
        47 => "reach",
        48 => "Stop ALL Sounds",
        49 => "Notify the Stack Object out of Idle",
        50 => "Add/Change the Action String",
        51 => "prim 51 (Sims 2.0)",
        52 => "prim 52 (Sims 2.0)",
        53 => "prim 53 (Sims 2.0)",
        54 => "prim 54 (Sims 2.0)",
        55 => "Sync Field",
        56 => "Ownership",
        57 => "Start Persistant Dialog",
        58 => "End Persistant Dialog",
        59 => "Update Persistant Dialog",
        60 => "Poll Persistant Dialog",
        61 => "Send Maxis Letter",
        62 => "Invoke Plugin",
        63 => "Get Terrain Info",
        64 => "Leave Lot and Goto",
        65 => "Find Best Action",
        66 => "Set Dynamic Object Name",
        67 => "Inventory Operations",
        _ => return None,
    })
}

/// Classification of a BHAV instruction's `opcode` field.
///
/// The boundaries follow Niotso's §Primitives:
/// - `< 256`   — primitive (built-in)
/// - `< 4096`  — semi-global subroutine (`globals.iff` calls)
/// - `< 8192`  — private subroutine (this object's own BHAVs)
/// - `≥ 8192`  — global subroutine (`behavior.iff` calls)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstructionKind {
    Primitive,
    SemiGlobal,
    Private,
    Global,
}

#[must_use]
pub const fn classify_opcode(opcode: u16) -> InstructionKind {
    if opcode < 256 {
        InstructionKind::Primitive
    } else if opcode < 4096 {
        InstructionKind::SemiGlobal
    } else if opcode < 8192 {
        InstructionKind::Private
    } else {
        InstructionKind::Global
    }
}

/// Human-readable name of a variable scope (the "owner" half of a variable reference).
///
/// Source: Niotso wiki §Scopes. Scopes 0..=37 are documented; the parser returns the
/// label verbatim including "(DO NOT USE)" on the leftover slots 2 and 5.
#[must_use]
pub const fn scope_name(scope: u16) -> Option<&'static str> {
    Some(match scope {
        0 => "my objects attributes",
        1 => "stack objects attributes",
        2 => "targ obj attr (DO NOT USE)",
        3 => "my object",
        4 => "stack object",
        5 => "targ obj's (DO NOT USE)",
        6 => "Global (from avatar)",
        7 => "literal",
        8 => "temps",
        9 => "parameters",
        10 => "stack object id",
        11 => "Temp[temp]",
        12 => "check tree ad range",
        13 => "stack obj's temp",
        14 => "my motives",
        15 => "stack obj's motives",
        16 => "stack object's slot",
        17 => "stack obj's motive[temp]",
        18 => "my person data",
        19 => "stack obj's person data",
        20 => "my slot",
        21 => "stack objects definition",
        22 => "stack object's attr[stack param]",
        23 => "room[temp 0]",
        24 => "neighbor in stack object",
        25 => "local",
        26 => "stack object tuning",
        27 => "Dyn. Sprite Flag[temp] of Stack Object",
        28 => "check tree ad personality var",
        29 => "check tree ad min",
        30 => "my person data [temp]",
        31 => "stack obj's person data [temp]",
        32 => "neighbor's person data",
        33 => "job data [temp 0, 1]",
        34 => "neighborhood data",
        35 => "stack object's function",
        36 => "my type attr",
        37 => "stack obj's type attr",
        _ => return None,
    })
}

// ---- STR# ----

/// Encoding of a single entry inside an STR# chunk.
///
/// Bytes are kept opaque (caller decides which Windows-* code page to decode with based
/// on the `lang_code`); for the `Pair` variants, the *comment* is usually empty.
#[derive(Debug, Clone)]
pub enum StrEntry {
    /// Single string — STR# v0 (Pascal-length prefixed) or v-1 (NUL-terminated).
    Single { data: Vec<u8> },
    /// `(data, comment)` pair — STR# v-2.
    Pair { data: Vec<u8>, comment: Vec<u8> },
    /// `(lang_code, data, comment)` — STR# v-3.
    PairWithLang {
        lang_code: u8,
        data: Vec<u8>,
        comment: Vec<u8>,
    },
}

#[derive(Debug, Clone)]
pub struct StrTable {
    pub version: i16,
    pub entries: Vec<StrEntry>,
}

impl StrTable {
    /// Parse a STR# (or TTAs — same format) chunk's data payload.
    ///
    /// # Errors
    /// Returns `StrUnsupportedVersion` for v-4 / unknown values, `StrTruncated` if any
    /// entry runs off the end of the buffer, or `TooShort` if the version field itself
    /// can't be read.
    pub fn parse(data: &[u8]) -> Result<Self, SimAnticsError> {
        if data.is_empty() {
            return Ok(Self {
                version: 0,
                entries: Vec::new(),
            });
        }
        if data.len() < 2 {
            return Err(SimAnticsError::TooShort);
        }
        let version = i16::from_le_bytes([data[0], data[1]]);
        if !matches!(version, -3..=0) {
            return Err(SimAnticsError::StrUnsupportedVersion(version));
        }
        // Niotso: some STR# chunks are just the version with no body.
        if data.len() == 2 {
            return Ok(Self {
                version,
                entries: Vec::new(),
            });
        }
        let count = read_u16_le(data, 2)?;
        let mut cursor = 4usize;
        let mut entries = Vec::with_capacity(count as usize);
        for i in 0..count {
            match version {
                0 => {
                    let s = read_pascal_string(data, &mut cursor).ok_or(SimAnticsError::StrTruncated { index: i })?;
                    entries.push(StrEntry::Single { data: s });
                }
                -1 => {
                    let s = read_cstring(data, &mut cursor).ok_or(SimAnticsError::StrTruncated { index: i })?;
                    entries.push(StrEntry::Single { data: s });
                }
                -2 => {
                    let d = read_cstring(data, &mut cursor).ok_or(SimAnticsError::StrTruncated { index: i })?;
                    let c = read_cstring(data, &mut cursor).ok_or(SimAnticsError::StrTruncated { index: i })?;
                    entries.push(StrEntry::Pair { data: d, comment: c });
                }
                -3 => {
                    if cursor >= data.len() {
                        return Err(SimAnticsError::StrTruncated { index: i });
                    }
                    let lang_code = data[cursor];
                    cursor += 1;
                    let d = read_cstring(data, &mut cursor).ok_or(SimAnticsError::StrTruncated { index: i })?;
                    let c = read_cstring(data, &mut cursor).ok_or(SimAnticsError::StrTruncated { index: i })?;
                    entries.push(StrEntry::PairWithLang {
                        lang_code,
                        data: d,
                        comment: c,
                    });
                }
                v => return Err(SimAnticsError::StrUnsupportedVersion(v)),
            }
        }
        Ok(Self { version, entries })
    }
}

// ---- TRCN ----

#[derive(Debug, Clone)]
pub struct TrcnEntry {
    pub is_used: u32,
    pub default: u32,
    pub name: Vec<u8>,
    pub comment: Vec<u8>,
    /// `(enforced, range_min, range_max)` — only present in TRCN v1.
    pub range: Option<(u8, i16, i16)>,
}

#[derive(Debug, Clone)]
pub struct Trcn {
    pub version: u32,
    pub entries: Vec<TrcnEntry>,
}

impl Trcn {
    /// Parse a TRCN chunk's data payload.
    ///
    /// # Errors
    /// Returns `TrcnUnsupportedVersion` for v2 (TSO Pascal-like, not yet implemented),
    /// `TrcnTruncated` if an entry runs off the buffer, or `TooShort` if the prefix
    /// can't be read.
    pub fn parse(data: &[u8]) -> Result<Self, SimAnticsError> {
        if data.len() < 16 {
            return Err(SimAnticsError::TooShort);
        }
        // 0..4 reserved, 4..8 version, 8..12 magic, 12..16 count
        let version = read_u32_le(data, 4)?;
        let count = read_u32_le(data, 12)?;
        if !(version == 0 || version == 1) {
            return Err(SimAnticsError::TrcnUnsupportedVersion(version));
        }
        let mut cursor = 16usize;
        let mut entries = Vec::with_capacity(count as usize);
        for i in 0..count {
            let is_used = read_u32_le_or(data, cursor, i)?;
            cursor += 4;
            let default = read_u32_le_or(data, cursor, i)?;
            cursor += 4;
            let name = read_padded_cstring(data, &mut cursor).ok_or(SimAnticsError::TrcnTruncated { index: i })?;
            let comment =
                read_padded_cstring(data, &mut cursor).ok_or(SimAnticsError::TrcnTruncated { index: i })?;
            let range = if version == 1 {
                if cursor + 5 > data.len() {
                    return Err(SimAnticsError::TrcnTruncated { index: i });
                }
                let enforced = data[cursor];
                let min = i16::from_le_bytes([data[cursor + 1], data[cursor + 2]]);
                let max = i16::from_le_bytes([data[cursor + 3], data[cursor + 4]]);
                cursor += 5;
                Some((enforced, min, max))
            } else {
                None
            };
            entries.push(TrcnEntry {
                is_used,
                default,
                name,
                comment,
                range,
            });
        }
        Ok(Self { version, entries })
    }
}

// ---- OBJD ----

/// Catalog entry. We treat the chunk as `version: u32` followed by an array of u16
/// fields and surface the well-documented prefix through named accessors.
#[derive(Debug, Clone)]
pub struct Objd {
    pub version: u32,
    pub fields: Vec<u16>,
}

/// Convenience: indices into [`Objd::fields`] for the documented v138 prefix
/// (TS1 base game). All u16. See `docs/formats/Catalog.md`.
pub mod objd_field {
    pub const INITIAL_STACK_SIZE: usize = 0;
    pub const BASE_GRAPHIC_ID: usize = 1;
    pub const NUM_GRAPHICS: usize = 2;
    pub const MAIN_ID: usize = 3;
    pub const GARDENING_ID: usize = 4;
    pub const TTAB_ID: usize = 5;
    pub const INTERACTION_GROUP: usize = 6;
    pub const OBJECT_TYPE: usize = 7;
    pub const MASTER_ID: usize = 8;
    pub const SUB_INDEX: usize = 9;
    pub const WASH_HANDS_ID: usize = 10;
    pub const ANIM_TABLE_ID: usize = 11;
    pub const GUID_LO: usize = 12;
    pub const GUID_HI: usize = 13;
    pub const DISABLED: usize = 14;
    pub const PORTAL: usize = 15;
    pub const PRICE: usize = 16;
    pub const BODY_STRINGS_ID: usize = 17;
    pub const SLOT_ID: usize = 18;
    pub const ALLOW_INTERSECTION_ID: usize = 19;
    pub const SALE_PRICE: usize = 32;
    pub const INITIAL_DEPRECIATION: usize = 33;
    pub const DAILY_DEPRECIATION: usize = 34;
    pub const SELF_DEPRECIATING: usize = 35;
    pub const DEPRECIATION_LIMIT: usize = 36;
}

impl Objd {
    /// Parse an OBJD chunk's data payload.
    ///
    /// # Errors
    /// Returns `TooShort` if the version u32 can't be read, or `ObjdMisalignedPayload`
    /// if the remaining bytes aren't a multiple of 2.
    pub fn parse(data: &[u8]) -> Result<Self, SimAnticsError> {
        if data.len() < 4 {
            return Err(SimAnticsError::TooShort);
        }
        let version = read_u32_le(data, 0)?;
        let payload = &data[4..];
        if payload.len() % 2 != 0 {
            return Err(SimAnticsError::ObjdMisalignedPayload { got: payload.len() });
        }
        let mut fields = Vec::with_capacity(payload.len() / 2);
        let mut i = 0;
        while i + 2 <= payload.len() {
            fields.push(u16::from_le_bytes([payload[i], payload[i + 1]]));
            i += 2;
        }
        Ok(Self { version, fields })
    }

    #[must_use]
    pub fn field(&self, index: usize) -> Option<u16> {
        self.fields.get(index).copied()
    }

    /// 32-bit GUID assembled from the LO/HI u16 pair.
    #[must_use]
    pub fn guid(&self) -> u32 {
        let lo = u32::from(self.field(objd_field::GUID_LO).unwrap_or(0));
        let hi = u32::from(self.field(objd_field::GUID_HI).unwrap_or(0));
        (hi << 16) | lo
    }
}

// ---- TTAB ----

/// Per-motive advertisement broadcast by an interaction.
///
/// `effect_min` and `personality_modifier` are only meaningful in TTAB v7+; in v5 they
/// are reported as `0` / `0`.
#[derive(Debug, Clone, Copy)]
pub struct MotiveEntry {
    pub effect_min: i16,
    pub effect_max: i16,
    pub personality_modifier: u16,
}

#[derive(Debug, Clone)]
pub struct TtabInteraction {
    pub action_function: u16,
    pub guard_function: u16,
    pub motive_entry_count: u32,
    pub flags: u32,
    pub ttas_index: u32,
    pub attenuation_code: u32,
    pub attenuation_value: f32,
    pub autonomy_threshold: u32,
    pub joining_index: i32,
    pub motives: Vec<MotiveEntry>,
}

#[derive(Debug, Clone)]
pub struct Ttab {
    pub version: u16,
    pub interactions: Vec<TtabInteraction>,
}

impl Ttab {
    /// Parse a TTAB chunk's data payload. Supports v5 and v8 (uncompressed). v9+ uses
    /// field encoding compression we don't decode yet — caller should expect
    /// `TtabUnsupportedVersion` for those.
    ///
    /// # Errors
    /// Returns `TtabUnsupportedVersion` for v9..=v11 (compressed) or any other
    /// unrecognized version, and `TooShort` if the buffer is truncated.
    pub fn parse(data: &[u8]) -> Result<Self, SimAnticsError> {
        if data.len() < 4 {
            return Err(SimAnticsError::TooShort);
        }
        let count = read_u16_le(data, 0)?;
        let version = read_u16_le(data, 2)?;
        let v7_plus = match version {
            5 => false,
            8 => true,
            other => return Err(SimAnticsError::TtabUnsupportedVersion(other)),
        };
        let mut cursor = 4usize;
        let mut interactions = Vec::with_capacity(count as usize);
        for _ in 0..count {
            let action_function = read_u16_le(data, cursor)?;
            cursor += 2;
            let guard_function = read_u16_le(data, cursor)?;
            cursor += 2;
            let motive_entry_count = read_u32_le(data, cursor)?;
            cursor += 4;
            let flags = read_u32_le(data, cursor)?;
            cursor += 4;
            let ttas_index = read_u32_le(data, cursor)?;
            cursor += 4;
            let (attenuation_code, attenuation_value) = if v7_plus {
                let code = read_u32_le(data, cursor)?;
                cursor += 4;
                let raw = read_u32_le(data, cursor)?;
                cursor += 4;
                (code, f32::from_bits(raw))
            } else {
                (0, 0.0)
            };
            let autonomy_threshold = read_u32_le(data, cursor)?;
            cursor += 4;
            let joining_index = read_i32_le(data, cursor)?;
            cursor += 4;
            let mut motives = Vec::with_capacity(motive_entry_count as usize);
            for _ in 0..motive_entry_count {
                if v7_plus {
                    let emin = read_i16_le(data, cursor)?;
                    cursor += 2;
                    let emax = read_i16_le(data, cursor)?;
                    cursor += 2;
                    let pm = read_u16_le(data, cursor)?;
                    cursor += 2;
                    motives.push(MotiveEntry {
                        effect_min: emin,
                        effect_max: emax,
                        personality_modifier: pm,
                    });
                } else {
                    let emax = read_i16_le(data, cursor)?;
                    cursor += 2;
                    motives.push(MotiveEntry {
                        effect_min: 0,
                        effect_max: emax,
                        personality_modifier: 0,
                    });
                }
            }
            interactions.push(TtabInteraction {
                action_function,
                guard_function,
                motive_entry_count,
                flags,
                ttas_index,
                attenuation_code,
                attenuation_value,
                autonomy_threshold,
                joining_index,
                motives,
            });
        }
        Ok(Self { version, interactions })
    }
}

// ---- OBJf ----

/// One row of an [`Objf`] dispatch table.
///
/// Index in the parent's `entries` vector identifies the *event* (the meaning of
/// each event index is defined by `behavior.iff` chunk `0x00F5` per Niotso —
/// typically index 0 = "Init", 1 = "Main", etc.). `action` is the BHAV chunk ID
/// to invoke; `condition` (when non-zero) is the guard BHAV that must return
/// true first. A zero `action` means "no handler for this event".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ObjfEntry {
    pub condition: u16,
    pub action: u16,
}

/// `OBJf` (Object Functions) chunk — fixed dispatch table from event index → BHAV.
///
/// Layout (per Niotso): 4 reserved zero bytes, 4-byte version (must be 0),
/// 4-byte magic (`"fJBO"` or zero), 4-byte entry count, then `count × 4` bytes
/// of `(condition u16, action u16)` pairs.
#[derive(Debug, Clone)]
pub struct Objf {
    pub version: u32,
    pub entries: Vec<ObjfEntry>,
}

impl Objf {
    /// Parse an `OBJf` chunk's data payload.
    ///
    /// # Errors
    /// Returns `ObjfUnsupportedVersion` for any version other than 0,
    /// or `TooShort` if the buffer is truncated.
    pub fn parse(data: &[u8]) -> Result<Self, SimAnticsError> {
        if data.len() < 16 {
            return Err(SimAnticsError::TooShort);
        }
        // bytes 0..4 reserved zero, 4..8 version, 8..12 magic, 12..16 count
        let version = read_u32_le(data, 4)?;
        if version != 0 {
            return Err(SimAnticsError::ObjfUnsupportedVersion(version));
        }
        let count = read_u32_le(data, 12)? as usize;
        if 16 + count.saturating_mul(4) > data.len() {
            return Err(SimAnticsError::TooShort);
        }
        let mut entries = Vec::with_capacity(count);
        for i in 0..count {
            let off = 16 + i * 4;
            entries.push(ObjfEntry {
                condition: read_u16_le(data, off)?,
                action: read_u16_le(data, off + 2)?,
            });
        }
        Ok(Self { version, entries })
    }

    /// Lookup the (condition, action) BHAV pair for `event`. Returns `None` when
    /// `event` is past the end of the table or both fields are zero (no handler).
    #[must_use]
    pub fn dispatch(&self, event: usize) -> Option<ObjfEntry> {
        let entry = *self.entries.get(event)?;
        if entry.condition == 0 && entry.action == 0 {
            return None;
        }
        Some(entry)
    }
}

// ---- GLOB ----

/// `GLOB` chunk — points at a semi-global IFF file used to resolve sub-call
/// opcodes in the 0x0100..=0x0FFF range.
///
/// The chunk format is undocumented in Niotso beyond "C string or Pascal string,
/// optionally padded to 256 bytes with `0xA3`". Empirically (verified against
/// Objects.far in TS1):
/// - Short form: null-terminated C string in 11..=15 bytes, no padding.
///   Example: `"CarGlobals\0"` (11 B).
/// - Long form: 256 B chunk with a Pascal string prefix (length byte + chars,
///   length always < 0x20), garbage after the string, padded with `0xA3` bytes
///   to 256 B. Example: `[0x0b, 'D','o','o','r','G','l','o','b','a','l','s', …]`
///   resolves to `"DoorGlobals"`.
///
/// We disambiguate by the first byte: if `< 0x20` it's a Pascal length prefix,
/// otherwise it's the first ASCII char of a C string.
#[derive(Debug, Clone)]
pub struct Glob {
    /// The semi-global filename **without** the `.iff` extension (the engine
    /// adds it). Always ASCII in practice.
    pub semi_global_name: alloc::string::String,
}

impl Glob {
    /// Parse a `GLOB` chunk's data payload.
    ///
    /// # Errors
    /// Returns `GlobEmpty` for a zero-byte chunk; otherwise always succeeds
    /// (malformed strings are sanitised to ASCII via lossy conversion).
    pub fn parse(data: &[u8]) -> Result<Self, SimAnticsError> {
        if data.is_empty() {
            return Err(SimAnticsError::GlobEmpty);
        }
        let bytes: &[u8] = if data[0] < 0x20 {
            // Pascal string: length byte then ASCII.
            let len = usize::from(data[0]);
            let end = (1 + len).min(data.len());
            &data[1..end]
        } else {
            // C string: read until NUL or end of buffer.
            let end = data.iter().position(|&b| b == 0).unwrap_or(data.len());
            &data[..end]
        };
        // Strip a trailing `.iff` if present (some chunks include it, the engine
        // ignores the extension regardless).
        let trimmed = if bytes.len() >= 4 && bytes[bytes.len() - 4..].eq_ignore_ascii_case(b".iff") {
            &bytes[..bytes.len() - 4]
        } else {
            bytes
        };
        let semi_global_name = alloc::string::String::from_utf8_lossy(trimmed).into_owned();
        Ok(Self { semi_global_name })
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

fn read_i16_le(data: &[u8], offset: usize) -> Result<i16, SimAnticsError> {
    if offset + 2 > data.len() {
        return Err(SimAnticsError::TooShort);
    }
    Ok(i16::from_le_bytes([data[offset], data[offset + 1]]))
}

fn read_i32_le(data: &[u8], offset: usize) -> Result<i32, SimAnticsError> {
    if offset + 4 > data.len() {
        return Err(SimAnticsError::TooShort);
    }
    Ok(i32::from_le_bytes([
        data[offset],
        data[offset + 1],
        data[offset + 2],
        data[offset + 3],
    ]))
}

fn read_u32_le_or(data: &[u8], offset: usize, index: u32) -> Result<u32, SimAnticsError> {
    if offset + 4 > data.len() {
        return Err(SimAnticsError::TrcnTruncated { index });
    }
    Ok(u32::from_le_bytes([
        data[offset],
        data[offset + 1],
        data[offset + 2],
        data[offset + 3],
    ]))
}

/// STR# v0 Pascal string: 1-byte length, then `len` bytes.
fn read_pascal_string(data: &[u8], cursor: &mut usize) -> Option<Vec<u8>> {
    if *cursor >= data.len() {
        return None;
    }
    let len = data[*cursor] as usize;
    *cursor += 1;
    if *cursor + len > data.len() {
        return None;
    }
    let s = data[*cursor..*cursor + len].to_vec();
    *cursor += len;
    Some(s)
}

/// NUL-terminated C string. The terminator is consumed but not included.
fn read_cstring(data: &[u8], cursor: &mut usize) -> Option<Vec<u8>> {
    let start = *cursor;
    while *cursor < data.len() {
        if data[*cursor] == 0 {
            let s = data[start..*cursor].to_vec();
            *cursor += 1;
            return Some(s);
        }
        *cursor += 1;
    }
    None
}

/// TRCN v0/v1 string: NUL-terminated C string, padded to even total length with 0xA3
/// (we don't enforce the pad byte's value, only the parity).
fn read_padded_cstring(data: &[u8], cursor: &mut usize) -> Option<Vec<u8>> {
    let start = *cursor;
    let s = read_cstring(data, cursor)?;
    let consumed = *cursor - start;
    if consumed % 2 != 0 {
        if *cursor >= data.len() {
            return None;
        }
        *cursor += 1;
    }
    Some(s)
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

    #[test]
    fn str_v_minus_1_two_cstrings() {
        // version -1 (FF FF), count = 2, "hi\0there\0"
        let mut buf = Vec::new();
        buf.extend_from_slice(&(-1i16).to_le_bytes());
        buf.extend_from_slice(&2u16.to_le_bytes());
        buf.extend_from_slice(b"hi\0");
        buf.extend_from_slice(b"there\0");
        let s = StrTable::parse(&buf).unwrap();
        assert_eq!(s.version, -1);
        assert_eq!(s.entries.len(), 2);
        match &s.entries[0] {
            StrEntry::Single { data } => assert_eq!(data, b"hi"),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn str_v_minus_3_lang_pairs() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&(-3i16).to_le_bytes());
        buf.extend_from_slice(&2u16.to_le_bytes()); // count
        buf.push(1); // lang code = English (US)
        buf.extend_from_slice(b"Wake up\0\0");
        buf.push(3); // lang code = French
        buf.extend_from_slice(b"R\xe9veil\0comment\0");
        let s = StrTable::parse(&buf).unwrap();
        assert_eq!(s.entries.len(), 2);
        match &s.entries[0] {
            StrEntry::PairWithLang {
                lang_code,
                data,
                comment,
            } => {
                assert_eq!(*lang_code, 1);
                assert_eq!(data, b"Wake up");
                assert!(comment.is_empty());
            }
            _ => panic!("wrong variant"),
        }
        match &s.entries[1] {
            StrEntry::PairWithLang {
                lang_code, comment, ..
            } => {
                assert_eq!(*lang_code, 3);
                assert_eq!(comment, b"comment");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn str_handles_no_body() {
        let buf = [0u8, 0u8]; // version 0, no count, no strings
        let s = StrTable::parse(&buf).unwrap();
        assert_eq!(s.version, 0);
        assert!(s.entries.is_empty());
    }

    #[test]
    fn str_rejects_unsupported_version() {
        // version -4 (FC FF) — TSO grouped Pascal-like, not parsed
        let buf = [0xFCu8, 0xFF, 0u8, 0u8];
        assert!(matches!(
            StrTable::parse(&buf),
            Err(SimAnticsError::StrUnsupportedVersion(-4))
        ));
    }

    #[test]
    fn trcn_v1_round_trip() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&0u32.to_le_bytes()); // reserved
        buf.extend_from_slice(&1u32.to_le_bytes()); // version
        buf.extend_from_slice(b"NCRT"); // magic
        buf.extend_from_slice(&1u32.to_le_bytes()); // count
        // entry 0: is_used=1, default=42, name="speed"\0+pad, comment=""\0+pad
        buf.extend_from_slice(&1u32.to_le_bytes());
        buf.extend_from_slice(&42u32.to_le_bytes());
        buf.extend_from_slice(b"speed\0"); // 6 bytes — even, no pad
        buf.extend_from_slice(b"\0\xA3"); // empty comment + pad
        // range: enforced=1, min=0, max=100
        buf.push(1);
        buf.extend_from_slice(&0i16.to_le_bytes());
        buf.extend_from_slice(&100i16.to_le_bytes());
        let t = Trcn::parse(&buf).unwrap();
        assert_eq!(t.version, 1);
        assert_eq!(t.entries.len(), 1);
        let e = &t.entries[0];
        assert_eq!(e.is_used, 1);
        assert_eq!(e.default, 42);
        assert_eq!(e.name, b"speed");
        assert!(e.comment.is_empty());
        assert_eq!(e.range, Some((1, 0, 100)));
    }

    #[test]
    fn trcn_rejects_v2() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&0u32.to_le_bytes());
        buf.extend_from_slice(&2u32.to_le_bytes()); // version 2
        buf.extend_from_slice(&[0u8; 8]);
        assert!(matches!(
            Trcn::parse(&buf),
            Err(SimAnticsError::TrcnUnsupportedVersion(2))
        ));
    }

    #[test]
    fn objd_decodes_alarm_clock_prefix() {
        // First 22 u16 of AlarmClock.iff's OBJD chunk (verified empirically).
        let mut buf = Vec::new();
        buf.extend_from_slice(&138u32.to_le_bytes());
        let fields = [
            4u16, 128, 7, 0, 0, 129, 0, 4, 0, 0, 0, 129, 55077, 42115, 0, 0, 30, 0, 128, 0, 1, 0,
        ];
        for f in fields {
            buf.extend_from_slice(&f.to_le_bytes());
        }
        let o = Objd::parse(&buf).unwrap();
        assert_eq!(o.version, 138);
        assert_eq!(o.field(objd_field::TTAB_ID), Some(129));
        assert_eq!(o.field(objd_field::OBJECT_TYPE), Some(4));
        assert_eq!(o.field(objd_field::PRICE), Some(30));
        assert_eq!(o.guid(), 0xA483_D725);
    }

    fn build_v8_two_interactions() -> Vec<u8> {
        // Mimics the prefix of AlarmClock.iff's TTAB.
        let mut buf = Vec::new();
        buf.extend_from_slice(&2u16.to_le_bytes()); // count
        buf.extend_from_slice(&8u16.to_le_bytes()); // version
        for action in [0x1000u16, 0x1002] {
            buf.extend_from_slice(&action.to_le_bytes()); // action
            buf.extend_from_slice(&0x1002u16.to_le_bytes()); // guard
            buf.extend_from_slice(&16u32.to_le_bytes()); // motive_entry_count
            buf.extend_from_slice(&0u32.to_le_bytes()); // flags
            buf.extend_from_slice(&0u32.to_le_bytes()); // ttas_index
            buf.extend_from_slice(&3u32.to_le_bytes()); // attenuation_code = moderate
            buf.extend_from_slice(&0.02f32.to_bits().to_le_bytes()); // attenuation_value
            buf.extend_from_slice(&100u32.to_le_bytes()); // autonomy
            buf.extend_from_slice(&(-1i32).to_le_bytes()); // joining_index
            for _ in 0..16 {
                buf.extend_from_slice(&0i16.to_le_bytes()); // emin
                buf.extend_from_slice(&5i16.to_le_bytes()); // emax
                buf.extend_from_slice(&0u16.to_le_bytes()); // pm
            }
            // suppress unused warning when action would be re-read
            let _ = action;
        }
        buf
    }

    #[test]
    fn ttab_v8_two_interactions() {
        let buf = build_v8_two_interactions();
        let t = Ttab::parse(&buf).unwrap();
        assert_eq!(t.version, 8);
        assert_eq!(t.interactions.len(), 2);
        let first = &t.interactions[0];
        assert_eq!(first.action_function, 0x1000);
        assert_eq!(first.guard_function, 0x1002);
        assert_eq!(first.motives.len(), 16);
        assert_eq!(first.attenuation_code, 3);
        assert!((first.attenuation_value - 0.02).abs() < 1e-6);
        assert_eq!(first.autonomy_threshold, 100);
        assert_eq!(first.joining_index, -1);
        assert_eq!(first.motives[0].effect_max, 5);
    }

    #[test]
    fn primitive_names_cover_documented_range() {
        assert_eq!(primitive_name(0), Some("Sleep"));
        assert_eq!(primitive_name(2), Some("Expression"));
        assert_eq!(primitive_name(44), Some("Animate Sim"));
        assert_eq!(primitive_name(67), Some("Inventory Operations"));
        assert_eq!(primitive_name(68), None);
        assert_eq!(primitive_name(0xFFFF), None);
    }

    #[test]
    fn classify_matches_niotso_ranges() {
        assert_eq!(classify_opcode(0), InstructionKind::Primitive);
        assert_eq!(classify_opcode(255), InstructionKind::Primitive);
        assert_eq!(classify_opcode(256), InstructionKind::SemiGlobal);
        assert_eq!(classify_opcode(4095), InstructionKind::SemiGlobal);
        assert_eq!(classify_opcode(4096), InstructionKind::Private);
        assert_eq!(classify_opcode(8191), InstructionKind::Private);
        assert_eq!(classify_opcode(8192), InstructionKind::Global);
        assert_eq!(classify_opcode(0xFFFF), InstructionKind::Global);
    }

    #[test]
    fn scope_names_cover_documented_range() {
        assert_eq!(scope_name(0), Some("my objects attributes"));
        assert_eq!(scope_name(7), Some("literal"));
        assert_eq!(scope_name(37), Some("stack obj's type attr"));
        assert_eq!(scope_name(38), None);
    }

    #[test]
    fn ttab_rejects_v9_compressed() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&0u16.to_le_bytes()); // count = 0
        buf.extend_from_slice(&9u16.to_le_bytes()); // version 9
        assert!(matches!(
            Ttab::parse(&buf),
            Err(SimAnticsError::TtabUnsupportedVersion(9))
        ));
    }

    #[test]
    fn objf_parses_minimal_two_entry_table() {
        // 16 B header + 2 entries × 4 B
        let mut buf = Vec::new();
        buf.extend_from_slice(&0u32.to_le_bytes()); // reserved
        buf.extend_from_slice(&0u32.to_le_bytes()); // version
        buf.extend_from_slice(b"fJBO"); // magic
        buf.extend_from_slice(&2u32.to_le_bytes()); // count
        // entry 0: condition=0, action=0x1005
        buf.extend_from_slice(&0u16.to_le_bytes());
        buf.extend_from_slice(&0x1005u16.to_le_bytes());
        // entry 1: condition=0x1006, action=0x1007
        buf.extend_from_slice(&0x1006u16.to_le_bytes());
        buf.extend_from_slice(&0x1007u16.to_le_bytes());
        let objf = Objf::parse(&buf).unwrap();
        assert_eq!(objf.version, 0);
        assert_eq!(objf.entries.len(), 2);
        assert_eq!(objf.entries[0], ObjfEntry { condition: 0, action: 0x1005 });
        assert_eq!(objf.entries[1], ObjfEntry { condition: 0x1006, action: 0x1007 });
        // dispatch: index 0 has an action → returns it
        assert_eq!(objf.dispatch(0), Some(ObjfEntry { condition: 0, action: 0x1005 }));
        // out-of-range index → None
        assert_eq!(objf.dispatch(2), None);
    }

    #[test]
    fn objf_dispatch_skips_zero_pairs() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&[0u8; 8]); // reserved + version
        buf.extend_from_slice(b"fJBO");
        buf.extend_from_slice(&2u32.to_le_bytes()); // count = 2
        // Both entries are (0, 0) — meaning "no handler".
        buf.extend_from_slice(&[0u8; 8]);
        let objf = Objf::parse(&buf).unwrap();
        assert_eq!(objf.dispatch(0), None);
        assert_eq!(objf.dispatch(1), None);
    }

    #[test]
    fn objf_rejects_nonzero_version() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&0u32.to_le_bytes());
        buf.extend_from_slice(&1u32.to_le_bytes()); // version = 1, unsupported
        buf.extend_from_slice(&[0u8; 8]);
        assert!(matches!(
            Objf::parse(&buf),
            Err(SimAnticsError::ObjfUnsupportedVersion(1))
        ));
    }

    #[test]
    fn objf_rejects_truncated_buffer() {
        // Header claims 4 entries but only 1 entry's bytes are present.
        let mut buf = Vec::new();
        buf.extend_from_slice(&[0u8; 8]);
        buf.extend_from_slice(b"fJBO");
        buf.extend_from_slice(&4u32.to_le_bytes());
        buf.extend_from_slice(&[0u8; 4]); // only one entry
        assert!(matches!(Objf::parse(&buf), Err(SimAnticsError::TooShort)));
    }

    #[test]
    fn glob_short_form_is_c_string() {
        // Real chunk from CarBentley.iff: "CarGlobals\0" — 11 bytes.
        let data = b"CarGlobals\0";
        let glob = Glob::parse(data).unwrap();
        assert_eq!(glob.semi_global_name, "CarGlobals");
    }

    #[test]
    fn glob_long_form_is_pascal_string_with_padding() {
        // Real chunk from Doors.iff: 0x0b length, "DoorGlobals", garbage, 0xA3 padding to 256.
        let mut data = Vec::with_capacity(256);
        data.push(0x0b); // length = 11
        data.extend_from_slice(b"DoorGlobals");
        data.extend_from_slice(b".iff"); // garbage from a previous filename
        data.resize(256, 0xA3); // 0xA3 padding
        let glob = Glob::parse(&data).unwrap();
        // Pascal length is 11, so we read exactly "DoorGlobals" — the leftover
        // ".iff" bytes are not part of the name.
        assert_eq!(glob.semi_global_name, "DoorGlobals");
    }

    #[test]
    fn glob_strips_iff_extension_when_included() {
        // A C-string GLOB that mistakenly includes the .iff extension should
        // still resolve to the stem (the engine adds the extension itself).
        let data = b"FooGlobals.iff\0";
        let glob = Glob::parse(data).unwrap();
        assert_eq!(glob.semi_global_name, "FooGlobals");
    }

    #[test]
    fn glob_rejects_empty_chunk() {
        assert!(matches!(Glob::parse(&[]), Err(SimAnticsError::GlobEmpty)));
    }
}
