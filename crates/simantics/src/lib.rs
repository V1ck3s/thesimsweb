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

pub mod hit_vm;
pub mod hot;
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
    #[error("FWAV chunk is empty")]
    FwavEmpty,
    #[error("DGRP version {0} is not supported (need 20003 or 20004)")]
    DgrpUnsupportedVersion(u16),
    #[error("HIT bad magic (want \"HIT!\")")]
    HitBadMagic,
    #[error("HIT unsupported version {major}.{minor}")]
    HitUnsupportedVersion { major: u32, minor: u32 },
    #[error("HIT missing TRAX section header")]
    HitMissingTrax,
    #[error("HIT export table truncated")]
    HitExportTruncated,
    #[error("SLOT bad magic (want \"TOLS\", got 0x{0:08X})")]
    SlotBadMagic(u32),
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

    /// Multi-tile group ID (`0` for single-tile objects). When non-zero, every
    /// tile of the same multi-tile object shares this ID across separate OBJD
    /// chunks in the same IFF.
    #[must_use]
    pub fn master_id(&self) -> u16 {
        self.field(objd_field::MASTER_ID).unwrap_or(0)
    }

    /// `(x, y)` tile offset of this OBJD within its multi-tile master, or
    /// `None` for the master itself or for single-tile objects.
    ///
    /// Niotso encodes the sub-index as `(y << 8) | x`. The sentinel `0xFFFF`
    /// marks the master tile and returns `None`.
    #[must_use]
    pub fn sub_index_xy(&self) -> Option<(i8, i8)> {
        let raw = self.field(objd_field::SUB_INDEX)?;
        if raw == 0xFFFF || self.master_id() == 0 {
            return None;
        }
        let x = (raw & 0xFF) as i8;
        let y = ((raw >> 8) & 0xFF) as i8;
        Some((x, y))
    }
}

/// Multi-tile footprint resolved from a list of OBJD payloads.
///
/// Given the OBJD chunk-data slices in the same IFF and a `master_id`, scans
/// every OBJD sharing that ID and collects the `(x, y)` offsets of each
/// sub-tile. The master tile (sub_index = 0xFFFF) sits at offset `(0, 0)` by
/// convention; sub-tiles use the `(y << 8) | x` field directly.
///
/// Returns an empty vector for single-tile objects (`master_id == 0`). The
/// returned tiles are deduplicated and sorted lexicographically.
///
/// `simantics` is `no_std` and intentionally does not depend on the `iff`
/// crate at runtime — the caller is expected to enumerate the OBJD chunks
/// themselves and pass the raw payloads in.
#[must_use]
pub fn objd_footprint_from_chunks(objd_payloads: &[&[u8]], master_id: u16) -> alloc::vec::Vec<(i8, i8)> {
    use alloc::collections::BTreeSet;
    if master_id == 0 {
        return alloc::vec::Vec::new();
    }
    let mut tiles: BTreeSet<(i8, i8)> = BTreeSet::new();
    for payload in objd_payloads {
        let Ok(objd) = Objd::parse(payload) else { continue };
        if objd.master_id() != master_id {
            continue;
        }
        match objd.sub_index_xy() {
            Some(xy) => {
                tiles.insert(xy);
            }
            None => {
                tiles.insert((0, 0));
            }
        }
    }
    tiles.into_iter().collect()
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

/// Header-only view of a TTAB chunk, succeeds for *any* version including
/// the compressed v9+ which `Ttab::parse` rejects.
///
/// Used by callers (UI viewers, audits) that need to know "how many
/// interactions does this object expose" without paying the cost of
/// decoding each interaction's fields. Empirical reverse of v9's
/// "field encoding" remains incomplete — see [`docs/formats/SimAntics.md`](../../../docs/formats/SimAntics.md).
#[derive(Debug, Clone)]
pub struct TtabHeader {
    pub count: u16,
    pub version: u16,
    /// Bytes after the count + version u16s. For v5/v8 these are
    /// fixed-layout interaction records. For v9 the first byte is
    /// empirically `0x01` (likely a "field-encoded" flag), followed by
    /// variable-size per-interaction records of as little as 15 bytes.
    pub raw_payload: alloc::vec::Vec<u8>,
}

impl TtabHeader {
    /// Parse the count + version u16 prefix and return the rest of the
    /// chunk verbatim.
    ///
    /// # Errors
    /// Returns `TooShort` if fewer than 4 bytes are available.
    pub fn parse(data: &[u8]) -> Result<Self, SimAnticsError> {
        if data.len() < 4 {
            return Err(SimAnticsError::TooShort);
        }
        let count = read_u16_le(data, 0)?;
        let version = read_u16_le(data, 2)?;
        let raw_payload = data[4..].to_vec();
        Ok(Self { count, version, raw_payload })
    }
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

// ---- SLOT ----

/// `SLOT` chunk — describes the routing slots an object exposes (where a Sim
/// can stand to interact: in-front, behind, sit-here, sleep-here, …).
///
/// Two layouts coexist in TS1:
/// - **v6**: 58 bytes per slot, used by simple objects (e.g. `unsnacker.iff`).
/// - **v10**: 72 bytes per slot, used by interactive objects with richer
///   routing (e.g. `AlarmClock.iff`).
///
/// We don't decode individual slot fields here — empirical reverse of the
/// per-slot record is in [`docs/formats/SLOT.md`](../../../docs/formats/SLOT.md)
/// and was insufficient to drive routing without cross-referencing FreeSO/Simitone
/// (out of scope this session). What this parser *does* expose:
/// - the magic + version + slot count, for diagnostics and consistency checks;
/// - raw per-slot bytes, so downstream code can decode opportunistically.
#[derive(Debug, Clone)]
pub struct Slot {
    pub version: u32,
    /// Number of slot records (0..=N). Each record is `version`-sized.
    pub count: u32,
    /// Raw per-slot bytes (concatenated). Length = `count * record_size(version)`
    /// when the chunk is well-formed; we don't enforce that, the caller can.
    pub raw_records: alloc::vec::Vec<u8>,
}

impl Slot {
    /// Header bytes consumed before the per-slot records: 4 (reserved) + 4
    /// (version) + 4 (magic) + 4 (count) = 16.
    pub const HEADER_SIZE: usize = 16;

    /// Magic bytes — ASCII "TOLS" little-endian (i.e. "SLOT" reversed).
    pub const MAGIC_BYTES: &'static [u8; 4] = b"TOLS";

    /// Parse a `SLOT` chunk's data payload.
    ///
    /// Layout (empirical, confirmed against `AlarmClock.iff` v10 and
    /// `unsnacker.iff` v6):
    /// ```text
    ///   [0..4]   reserved (always 0)
    ///   [4..8]   version u32 LE (6 or 10)
    ///   [8..12]  magic "TOLS"
    ///   [12..16] count u32 LE
    ///   [16..]   per-slot records (58 B for v6, 72 B for v10)
    /// ```
    ///
    /// # Errors
    /// Returns `TooShort` if the buffer cannot hold the 16-byte header, or
    /// `SlotBadMagic` if the magic bytes don't match `"TOLS"`.
    pub fn parse(data: &[u8]) -> Result<Self, SimAnticsError> {
        if data.len() < Self::HEADER_SIZE {
            return Err(SimAnticsError::TooShort);
        }
        let version = read_u32_le(data, 4)?;
        if &data[8..12] != Self::MAGIC_BYTES {
            return Err(SimAnticsError::SlotBadMagic(read_u32_le(data, 8)?));
        }
        let count = read_u32_le(data, 12)?;
        let raw_records = data[Self::HEADER_SIZE..].to_vec();
        Ok(Self { version, count, raw_records })
    }
}

// ---- FWAV ----

/// `FWAV` (event name) chunk — a single null-terminated C string naming a
/// track/event pair. The SimAntics primitive 23 ("Play Sound Event") reads its
/// 8-byte operand, takes a 16-bit chunk ID, looks up the FWAV chunk with that
/// ID inside the same IFF, and dispatches the resulting name through the HOT
/// `EventMapping` table to the HIT VM.
///
/// In practice the entire payload is zero-padded up to ~80 bytes and the
/// string lives at the tail; we tolerate either layout (leading or trailing
/// nulls) by trimming both ends.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fwav {
    pub event_name: alloc::string::String,
}

impl Fwav {
    /// Parse a `FWAV` chunk's data payload.
    ///
    /// # Errors
    /// Returns `FwavEmpty` if the chunk holds no printable bytes.
    pub fn parse(data: &[u8]) -> Result<Self, SimAnticsError> {
        if data.is_empty() {
            return Err(SimAnticsError::FwavEmpty);
        }
        // Strip leading and trailing zero bytes; the actual string is whatever
        // printable run remains. Real chunks pad with NUL on the left.
        let start = data.iter().position(|&b| b != 0).unwrap_or(data.len());
        let tail = &data[start..];
        let end = tail.iter().position(|&b| b == 0).unwrap_or(tail.len());
        if end == 0 {
            return Err(SimAnticsError::FwavEmpty);
        }
        let event_name = alloc::string::String::from_utf8_lossy(&tail[..end]).into_owned();
        Ok(Self { event_name })
    }
}

// ---- DGRP ----

/// One sprite reference inside a `DgrpImage`.
///
/// Coordinates and offsets are signed integers / floats; the renderer composites
/// sprites at `(sprite_x_offset, sprite_y_offset)` relative to the image center,
/// then shifts by `(object_x_offset, object_y_offset, object_z_offset)` in grid
/// units. `flags` bit 0 mirrors the sprite, bit 2 marks it as cache-friendly.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DgrpSprite {
    /// Chunk ID of the SPR# or SPR2 this references.
    pub spr_chunk_id: u32,
    /// Frame index inside that SPR chunk.
    pub spr_frame_number: u32,
    pub sprite_x_offset: i32,
    pub sprite_y_offset: i32,
    pub object_z_offset: f32,
    pub flags: u32,
    /// `0.0` for v20003 (which lacks the field).
    pub object_x_offset: f32,
    /// `0.0` for v20003.
    pub object_y_offset: f32,
}

/// One of 12 images in a [`Dgrp`] — exactly one (direction, zoom) combination.
///
/// The 12 images are 4 directions (`0x01` right-rear, `0x04` right-front,
/// `0x10` left-front, `0x40` left-rear) × 3 zoom levels (1=far, 2=mid, 3=near).
#[derive(Debug, Clone)]
pub struct DgrpImage {
    pub direction_flags: u32,
    pub zoom_level: u32,
    pub sprites: Vec<DgrpSprite>,
}

/// `DGRP` (Drawing Group) chunk — the renderer's lookup table from
/// `(direction, zoom)` to a list of sprite references and offsets.
///
/// Supports versions **20003** and **20004** (TS1 / TSO production formats).
/// Older versions 20000/20001 use a different layout and are rejected.
#[derive(Debug, Clone)]
pub struct Dgrp {
    pub version: u16,
    pub images: Vec<DgrpImage>,
}

impl Dgrp {
    /// Parse a `DGRP` chunk's data payload.
    ///
    /// # Errors
    /// Returns `DgrpUnsupportedVersion` for v20000/20001/other, or `TooShort`
    /// if the buffer is truncated before all images / sprites are read.
    pub fn parse(data: &[u8]) -> Result<Self, SimAnticsError> {
        if data.len() < 6 {
            return Err(SimAnticsError::TooShort);
        }
        let version = read_u16_le(data, 0)?;
        let v20004 = match version {
            20003 => false,
            20004 => true,
            other => return Err(SimAnticsError::DgrpUnsupportedVersion(other)),
        };
        let image_count = read_u32_le(data, 2)? as usize;
        let mut cursor = 6usize;
        let mut images = Vec::with_capacity(image_count);
        for _ in 0..image_count {
            let direction_flags = read_u32_le(data, cursor)?;
            cursor += 4;
            let zoom_level = read_u32_le(data, cursor)?;
            cursor += 4;
            let sprite_count = read_u32_le(data, cursor)? as usize;
            cursor += 4;
            let mut sprites = Vec::with_capacity(sprite_count);
            for _ in 0..sprite_count {
                let spr_chunk_id = read_u32_le(data, cursor)?;
                cursor += 4;
                let spr_frame_number = read_u32_le(data, cursor)?;
                cursor += 4;
                let sprite_x_offset = read_i32_le(data, cursor)?;
                cursor += 4;
                let sprite_y_offset = read_i32_le(data, cursor)?;
                cursor += 4;
                let object_z_offset = f32::from_bits(read_u32_le(data, cursor)?);
                cursor += 4;
                let flags = read_u32_le(data, cursor)?;
                cursor += 4;
                let (object_x_offset, object_y_offset) = if v20004 {
                    let x = f32::from_bits(read_u32_le(data, cursor)?);
                    cursor += 4;
                    let y = f32::from_bits(read_u32_le(data, cursor)?);
                    cursor += 4;
                    (x, y)
                } else {
                    (0.0, 0.0)
                };
                sprites.push(DgrpSprite {
                    spr_chunk_id,
                    spr_frame_number,
                    sprite_x_offset,
                    sprite_y_offset,
                    object_z_offset,
                    flags,
                    object_x_offset,
                    object_y_offset,
                });
            }
            images.push(DgrpImage { direction_flags, zoom_level, sprites });
        }
        Ok(Self { version, images })
    }

    /// Look up the image for a specific `(direction_flag, zoom_level)` pair.
    /// `direction_flag` should be one of `0x01`, `0x04`, `0x10`, `0x40`;
    /// `zoom_level` should be 1, 2, or 3. Returns `None` when no image matches.
    #[must_use]
    pub fn image_for(&self, direction_flag: u32, zoom_level: u32) -> Option<&DgrpImage> {
        self.images
            .iter()
            .find(|i| i.direction_flags == direction_flag && i.zoom_level == zoom_level)
    }
}

// ---- HIT ----

/// One entry in a `HIT` export table (TSO addition; some TS1 files also have it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HitExport {
    pub track_id: u32,
    pub address: u32,
}

/// Parsed HIT (Hit Item Table) audio bytecode container.
///
/// Layout (little-endian):
/// - `00..04`: magic `HIT!`
/// - `04..08`: major version (1)
/// - `08..0C`: minor version (8 — only known value used by TS1 / TSO)
/// - `0C..10`: code section header `TRAX`
/// - `10..`  : raw bytecode. Contains an optional export table delimited by
///   `ENTP` … `EENT` (sentinel `0x544e4545` is therefore an illegal
///   track ID).
///
/// This parser only decodes the framing; executing the bytecode (a separate VM
/// with ~70 instructions) is out of scope for now.
#[derive(Debug, Clone)]
pub struct Hit {
    pub major: u32,
    pub minor: u32,
    /// Bytes after `TRAX` (offset 16 onward in the file). Includes the export
    /// table if any — keep them so the future HIT VM can `call`/`jump` into them.
    pub code: Vec<u8>,
    /// Decoded `ENTP`-delimited export table; empty when no `ENTP` header is present.
    pub exports: Vec<HitExport>,
}

impl Hit {
    /// Parse a `.hit` file (the whole on-disk bytes — there is no IFF wrapper).
    ///
    /// # Errors
    /// `HitBadMagic` if the file doesn't start with `HIT!`,
    /// `HitMissingTrax` if the `TRAX` header isn't where it's expected,
    /// `HitUnsupportedVersion` for non-(1, 8) versions,
    /// `HitExportTruncated` if `ENTP` is found but the table runs off the end.
    pub fn parse(data: &[u8]) -> Result<Self, SimAnticsError> {
        if data.len() < 16 {
            return Err(SimAnticsError::TooShort);
        }
        if &data[0..4] != b"HIT!" {
            return Err(SimAnticsError::HitBadMagic);
        }
        let major = read_u32_le(data, 4)?;
        let minor = read_u32_le(data, 8)?;
        if major != 1 || minor != 8 {
            return Err(SimAnticsError::HitUnsupportedVersion { major, minor });
        }
        if &data[12..16] != b"TRAX" {
            return Err(SimAnticsError::HitMissingTrax);
        }
        let code = data[16..].to_vec();

        // Search for the ENTP export table. Per Niotso the search starts at the
        // beginning of the file and the table may be unaligned.
        let mut exports = Vec::new();
        if let Some(entp_offset) = find_marker(&code, *b"ENTP") {
            let mut cursor = entp_offset + 4;
            loop {
                if cursor + 4 > code.len() {
                    return Err(SimAnticsError::HitExportTruncated);
                }
                if &code[cursor..cursor + 4] == b"EENT" {
                    break;
                }
                if cursor + 8 > code.len() {
                    return Err(SimAnticsError::HitExportTruncated);
                }
                let track_id = read_u32_le(&code, cursor)?;
                let address = read_u32_le(&code, cursor + 4)?;
                exports.push(HitExport { track_id, address });
                cursor += 8;
            }
        }

        Ok(Self {
            major,
            minor,
            code,
            exports,
        })
    }
}

/// One disassembled HIT instruction.
#[derive(Debug, Clone)]
pub struct HitInstr {
    /// Byte offset relative to the start of the code section.
    pub address: u32,
    pub opcode: u8,
    pub mnemonic: &'static str,
    /// Pretty-printed arguments (registers / immediates / addresses).
    pub args: alloc::string::String,
    /// Total length of this instruction in bytes (opcode + operands).
    pub byte_len: usize,
}

impl Hit {
    /// Linearly disassemble the bytecode after `TRAX`.
    ///
    /// Walks instruction-by-instruction using a fixed-length table for the ~60
    /// known TS1/TSO opcodes. Unknown opcodes emit `db <hex>` and advance one
    /// byte. The `jump` instruction (0x0D) uses Niotso's heuristic to pick
    /// between the 1-byte variable form and the 4-byte absolute address form.
    #[must_use]
    pub fn disasm(&self) -> Vec<HitInstr> {
        let mut out = Vec::new();
        let mut cursor = 0usize;
        while cursor < self.code.len() {
            let opcode = self.code[cursor];
            #[allow(clippy::cast_possible_truncation)]
            let address = cursor as u32;
            // Resolve the static (mnemonic, length) table; `jump` is special-cased.
            let (mnemonic, len, args) = self.decode_hit_at(cursor);
            out.push(HitInstr {
                address,
                opcode,
                mnemonic,
                args,
                byte_len: len,
            });
            if len == 0 {
                // Defensive: never advance zero. A zero would loop forever.
                cursor += 1;
            } else {
                cursor += len;
            }
            // If the table lied about length (e.g. truncated last instruction),
            // stop rather than read past the buffer.
            if cursor > self.code.len() {
                break;
            }
        }
        out
    }

    #[allow(clippy::too_many_lines)]
    fn decode_hit_at(&self, cursor: usize) -> (&'static str, usize, alloc::string::String) {
        use alloc::format;
        let code = &self.code;
        let opcode = code[cursor];
        let read_u8 = |offset: usize| -> Option<u8> { code.get(cursor + offset).copied() };
        let read_u32 = |offset: usize| -> Option<u32> {
            let bytes = code.get(cursor + offset..cursor + offset + 4)?;
            Some(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
        };
        let len_left = code.len() - cursor;
        match opcode {
            // 1-byte instructions (no operands).
            0x08 => ("return", 1, alloc::string::String::new()),
            0x0B => ("wait_samp", 1, alloc::string::String::new()),
            0x0C => ("end", 1, alloc::string::String::new()),
            0x0F => ("nop", 1, alloc::string::String::new()),
            0x20 => ("loop", 1, alloc::string::String::new()),
            0x21 => ("set_loop", 1, alloc::string::String::new()),
            0x3A => ("test1", 1, alloc::string::String::new()),
            0x3B => ("test2", 1, alloc::string::String::new()),
            0x3C => ("test3", 1, alloc::string::String::new()),
            0x3D => ("test4", 1, alloc::string::String::new()),
            0x53 => ("duck", 1, alloc::string::String::new()),
            0x54 => ("unduck", 1, alloc::string::String::new()),

            // 2-byte: opcode + 1 var
            0x02 => ("note_on", 2, fmt_one_var(read_u8(1))),
            0x03 => ("note_off", 2, fmt_one_var(read_u8(1))),
            0x09 => ("wait", 2, fmt_one_var(read_u8(1))),
            0x0E => ("test", 2, fmt_one_var(read_u8(1))),
            0x27 => ("smart_choose", 2, fmt_one_var(read_u8(1))),
            0x32 => ("play_trk", 2, fmt_one_var(read_u8(1))),
            0x33 => ("kill_trk", 2, fmt_one_var(read_u8(1))),
            0x44 => ("smart_setlist", 2, fmt_one_var(read_u8(1))),
            0x45 => ("seqgroup_kill", 2, fmt_one_var(read_u8(1))),
            0x47 => ("seqgroup_return", 2, fmt_one_var(read_u8(1))),
            0x5A => ("stop_trk", 2, fmt_one_var(read_u8(1))),
            0x60 => ("note_on_loop", 2, fmt_one_var(read_u8(1))),

            // 3-byte: opcode + 1 var + 1 immediate u8
            0x04 => ("loadb", 3, format!(
                "{} #{}", fmt_var(read_u8(1)), read_u8(2).map_or(0, u8::from)
            )),
            // 3-byte: opcode + 2 vars
            0x06 => ("set", 3, fmt_two_vars(read_u8(1), read_u8(2))),
            0x10 => ("add", 3, fmt_two_vars(read_u8(1), read_u8(2))),
            0x11 => ("sub", 3, fmt_two_vars(read_u8(1), read_u8(2))),
            0x12 => ("div", 3, fmt_two_vars(read_u8(1), read_u8(2))),
            0x13 => ("mul", 3, fmt_two_vars(read_u8(1), read_u8(2))),
            0x14 => ("cmp", 3, fmt_two_vars(read_u8(1), read_u8(2))),
            0x49 => ("seqgroup_trkid", 3, format!(
                "#{} #{}",
                read_u8(1).map_or(0, u8::from),
                read_u8(2).map_or(0, u8::from)
            )),
            0x4A => ("setll", 3, fmt_two_vars(read_u8(1), read_u8(2))),
            0x4B => ("setlt", 3, fmt_two_vars(read_u8(1), read_u8(2))),
            0x4D => ("waiteq", 3, fmt_two_vars(read_u8(1), read_u8(2))),
            0x4E => ("waitne", 3, fmt_two_vars(read_u8(1), read_u8(2))),
            0x4F => ("waitgt", 3, fmt_two_vars(read_u8(1), read_u8(2))),
            0x50 => ("waitlt", 3, fmt_two_vars(read_u8(1), read_u8(2))),
            0x51 => ("waitge", 3, fmt_two_vars(read_u8(1), read_u8(2))),
            0x52 => ("waitle", 3, fmt_two_vars(read_u8(1), read_u8(2))),
            0x5F => ("smart_index", 3, fmt_two_vars(read_u8(1), read_u8(2))),

            // 4-byte: opcode + 3 vars
            0x18 => ("rand", 4, format!(
                "{} {} {}",
                fmt_var(read_u8(1)), fmt_var(read_u8(2)), fmt_var(read_u8(3))
            )),
            0x48 => ("getsrcdatafield", 4, format!(
                "{} {} {}",
                fmt_var(read_u8(1)), fmt_var(read_u8(2)), fmt_var(read_u8(3))
            )),
            0x55 => ("testx", 4, format!(
                "{} {} {}",
                fmt_var(read_u8(1)), fmt_var(read_u8(2)), fmt_var(read_u8(3))
            )),
            0x59 => ("setsrcdatafield", 4, format!(
                "{} {} {}",
                fmt_var(read_u8(1)), fmt_var(read_u8(2)), fmt_var(read_u8(3))
            )),

            // 5-byte: opcode + 4-byte u32 (immediate or address)
            0x07 => ("call", 5, format!("#0x{:x}", read_u32(1).unwrap_or(0))),
            0x0A => ("callentrypoint", 5, format!("#0x{:x}", read_u32(1).unwrap_or(0))),
            0x3E => ("ifeq", 5, format!("#0x{:x}", read_u32(1).unwrap_or(0))),
            0x3F => ("ifne", 5, format!("#0x{:x}", read_u32(1).unwrap_or(0))),
            0x40 => ("ifgt", 5, format!("#0x{:x}", read_u32(1).unwrap_or(0))),
            0x41 => ("iflt", 5, format!("#0x{:x}", read_u32(1).unwrap_or(0))),
            0x42 => ("ifge", 5, format!("#0x{:x}", read_u32(1).unwrap_or(0))),
            0x43 => ("ifle", 5, format!("#0x{:x}", read_u32(1).unwrap_or(0))),

            // 6-byte: opcode + 1 var + 4-byte u32
            0x05 => ("loadl", 6, format!(
                "{} #0x{:x}", fmt_var(read_u8(1)), read_u32(2).unwrap_or(0)
            )),
            0x2D => ("max", 6, format!(
                "{} #{}", fmt_var(read_u8(1)), read_u32(2).unwrap_or(0)
            )),
            0x2E => ("min", 6, format!(
                "{} #{}", fmt_var(read_u8(1)), read_u32(2).unwrap_or(0)
            )),
            0x56 => ("setlg", 6, format!(
                "{} #0x{:x}", fmt_var(read_u8(1)), read_u32(2).unwrap_or(0)
            )),
            0x57 => ("setgl", 6, format!(
                "{} #0x{:x}", fmt_var(read_u8(1)), read_u32(2).unwrap_or(0)
            )),

            // jump (0x0D): Niotso 3-way heuristic.
            //   1. If next 4 bytes look like an absolute address (>= 16 and within
            //      the code section), it's `jump #addr` (5 bytes).
            //   2. Else if next byte is 0x05 or 0x06 (v1 or v2 register IDs), it's
            //      `jump var` in the compact 2-byte form.
            //   3. Else it's the wide 5-byte variable form `jump var32`.
            0x0D => {
                if len_left >= 5 {
                    let candidate = read_u32(1).unwrap_or(0);
                    let is_address = candidate >= 16
                        && (candidate as usize) < self.code.len() + 16;
                    if is_address {
                        return ("jump", 5, format!("#0x{candidate:x}"));
                    }
                }
                let first = read_u8(1).unwrap_or(0);
                if first == 0x05 || first == 0x06 {
                    if len_left >= 2 {
                        ("jump", 2, fmt_one_var(read_u8(1)))
                    } else {
                        ("jump", 1, alloc::string::String::new())
                    }
                } else if len_left >= 5 {
                    // Wide variable form — render the variable byte but skip the
                    // 3 zero-pad bytes.
                    ("jump", 5, fmt_one_var(read_u8(1)))
                } else {
                    ("jump", len_left.min(2), fmt_one_var(read_u8(1)))
                }
            }

            // Unknown opcode — emit as a single .db pseudo-op so disasm continues.
            _ => ("db", 1, format!("0x{opcode:02x}")),
        }
    }
}

/// Format a HIT variable byte. Track variables only — globals (>=0x64) and
/// object variables (>=0x2000) need a 4-byte form which is opcode-specific.
fn fmt_var(byte: Option<u8>) -> alloc::string::String {
    use alloc::format;
    let Some(b) = byte else { return alloc::string::String::from("?") };
    match b {
        0x0..=0x4 => format!("arg{b}"),
        0x5..=0xC => format!("v{}", b - 0x4),
        0xD..=0x10 => format!("h{}", b - 0xC),
        _ => format!("var{b:#x}"),
    }
}

fn fmt_one_var(byte: Option<u8>) -> alloc::string::String {
    fmt_var(byte)
}

fn fmt_two_vars(a: Option<u8>, b: Option<u8>) -> alloc::string::String {
    use alloc::format;
    format!("{} {}", fmt_var(a), fmt_var(b))
}

fn find_marker(data: &[u8], needle: [u8; 4]) -> Option<usize> {
    if data.len() < 4 {
        return None;
    }
    for i in 0..=data.len() - 4 {
        if data[i..i + 4] == needle {
            return Some(i);
        }
    }
    None
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

    #[test]
    fn fwav_pads_with_leading_nulls() {
        // Real shape from Stereos2.iff: 80 bytes of 0x00 padding then the
        // event name as a null-terminated C string.
        let mut data = vec![0u8; 80];
        data.extend_from_slice(b"stereo_classical_cheap\0");
        let f = Fwav::parse(&data).unwrap();
        assert_eq!(f.event_name, "stereo_classical_cheap");
    }

    #[test]
    fn fwav_handles_inline_string() {
        // Defensive: tolerate a chunk whose payload is just the C string.
        let f = Fwav::parse(b"radio_off\0").unwrap();
        assert_eq!(f.event_name, "radio_off");
    }

    #[test]
    fn fwav_rejects_empty_chunks() {
        assert!(matches!(Fwav::parse(&[]), Err(SimAnticsError::FwavEmpty)));
        // All zero bytes — no string at all.
        assert!(matches!(Fwav::parse(&[0u8; 16]), Err(SimAnticsError::FwavEmpty)));
    }

    #[test]
    fn slot_v6_round_trip() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&0u32.to_le_bytes()); // reserved
        buf.extend_from_slice(&6u32.to_le_bytes()); // version
        buf.extend_from_slice(b"TOLS");
        buf.extend_from_slice(&3u32.to_le_bytes()); // count
        buf.extend_from_slice(&[0xAA; 58 * 3]); // 3 records of 58 bytes
        let s = Slot::parse(&buf).unwrap();
        assert_eq!(s.version, 6);
        assert_eq!(s.count, 3);
        assert_eq!(s.raw_records.len(), 58 * 3);
    }

    #[test]
    fn slot_rejects_bad_magic() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&0u32.to_le_bytes());
        buf.extend_from_slice(&6u32.to_le_bytes());
        buf.extend_from_slice(b"WRNG");
        buf.extend_from_slice(&0u32.to_le_bytes());
        assert!(matches!(Slot::parse(&buf), Err(SimAnticsError::SlotBadMagic(_))));
    }

    #[test]
    fn slot_rejects_truncated_header() {
        assert!(matches!(Slot::parse(&[0u8; 12]), Err(SimAnticsError::TooShort)));
    }

    #[test]
    fn objd_master_id_and_sub_index_decoded() {
        // Build an OBJD with master_id=42, sub_index = 0x0203 (x=3, y=2).
        let mut fields = vec![0u16; 38];
        fields[objd_field::MASTER_ID] = 42;
        fields[objd_field::SUB_INDEX] = 0x0203;
        let mut buf = Vec::new();
        buf.extend_from_slice(&138u32.to_le_bytes());
        for f in &fields {
            buf.extend_from_slice(&f.to_le_bytes());
        }
        let o = Objd::parse(&buf).unwrap();
        assert_eq!(o.master_id(), 42);
        assert_eq!(o.sub_index_xy(), Some((3, 2)));

        // Master tile (sub_index = 0xFFFF) returns None even with master_id != 0.
        let mut fields2 = fields.clone();
        fields2[objd_field::SUB_INDEX] = 0xFFFF;
        let mut buf2 = Vec::new();
        buf2.extend_from_slice(&138u32.to_le_bytes());
        for f in &fields2 {
            buf2.extend_from_slice(&f.to_le_bytes());
        }
        let o2 = Objd::parse(&buf2).unwrap();
        assert_eq!(o2.master_id(), 42);
        assert_eq!(o2.sub_index_xy(), None);

        // Single-tile (master_id=0): always None.
        let mut fields3 = vec![0u16; 38];
        fields3[objd_field::SUB_INDEX] = 0x0203;
        let mut buf3 = Vec::new();
        buf3.extend_from_slice(&138u32.to_le_bytes());
        for f in &fields3 {
            buf3.extend_from_slice(&f.to_le_bytes());
        }
        let o3 = Objd::parse(&buf3).unwrap();
        assert_eq!(o3.master_id(), 0);
        assert_eq!(o3.sub_index_xy(), None);
    }

    #[test]
    fn dgrp_v20004_round_trip_one_image_one_sprite() {
        // Build a minimal v20004 DGRP: 1 image with 1 sprite.
        let mut buf = Vec::new();
        buf.extend_from_slice(&20004u16.to_le_bytes()); // version
        buf.extend_from_slice(&1u32.to_le_bytes()); // image_count = 1
        // image header
        buf.extend_from_slice(&0x01u32.to_le_bytes()); // direction = right-rear
        buf.extend_from_slice(&3u32.to_le_bytes()); // zoom = near
        buf.extend_from_slice(&1u32.to_le_bytes()); // sprite_count = 1
        // sprite
        buf.extend_from_slice(&128u32.to_le_bytes()); // spr_chunk_id
        buf.extend_from_slice(&5u32.to_le_bytes()); // spr_frame_number
        buf.extend_from_slice(&(-3i32).to_le_bytes()); // x_offset
        buf.extend_from_slice(&7i32.to_le_bytes()); // y_offset
        buf.extend_from_slice(&0.5f32.to_bits().to_le_bytes()); // z
        buf.extend_from_slice(&0u32.to_le_bytes()); // flags
        buf.extend_from_slice(&1.5f32.to_bits().to_le_bytes()); // x_obj
        buf.extend_from_slice(&(-2.5f32).to_bits().to_le_bytes()); // y_obj
        let dgrp = Dgrp::parse(&buf).unwrap();
        assert_eq!(dgrp.version, 20004);
        assert_eq!(dgrp.images.len(), 1);
        let img = &dgrp.images[0];
        assert_eq!(img.direction_flags, 0x01);
        assert_eq!(img.zoom_level, 3);
        assert_eq!(img.sprites.len(), 1);
        let sp = &img.sprites[0];
        assert_eq!(sp.spr_chunk_id, 128);
        assert_eq!(sp.spr_frame_number, 5);
        assert_eq!(sp.sprite_x_offset, -3);
        assert_eq!(sp.sprite_y_offset, 7);
        assert!((sp.object_z_offset - 0.5).abs() < f32::EPSILON);
        assert!((sp.object_x_offset - 1.5).abs() < f32::EPSILON);
        assert!((sp.object_y_offset - (-2.5)).abs() < f32::EPSILON);
        // image_for matches.
        assert!(dgrp.image_for(0x01, 3).is_some());
        assert!(dgrp.image_for(0x40, 3).is_none()); // wrong direction
    }

    #[test]
    fn dgrp_v20003_skips_object_xy_offsets() {
        // v20003 omits the trailing two floats per sprite.
        let mut buf = Vec::new();
        buf.extend_from_slice(&20003u16.to_le_bytes()); // version
        buf.extend_from_slice(&1u32.to_le_bytes()); // image_count = 1
        buf.extend_from_slice(&0x04u32.to_le_bytes()); // direction
        buf.extend_from_slice(&2u32.to_le_bytes()); // zoom
        buf.extend_from_slice(&1u32.to_le_bytes()); // sprite_count
        buf.extend_from_slice(&[0u8; 4 * 6]); // 6 fields × 4 bytes (no x_obj/y_obj)
        let dgrp = Dgrp::parse(&buf).unwrap();
        assert_eq!(dgrp.version, 20003);
        let sp = &dgrp.images[0].sprites[0];
        assert!(sp.object_x_offset.abs() < f32::EPSILON);
        assert!(sp.object_y_offset.abs() < f32::EPSILON);
    }

    #[test]
    fn dgrp_rejects_v20000() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&20000u16.to_le_bytes());
        buf.extend_from_slice(&[0u8; 4]);
        assert!(matches!(
            Dgrp::parse(&buf),
            Err(SimAnticsError::DgrpUnsupportedVersion(20000))
        ));
    }

    #[test]
    fn hit_parses_minimal_header() {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"HIT!");
        buf.extend_from_slice(&1u32.to_le_bytes());
        buf.extend_from_slice(&8u32.to_le_bytes());
        buf.extend_from_slice(b"TRAX");
        buf.extend_from_slice(&[0x0c]); // single `end` instruction
        let hit = Hit::parse(&buf).unwrap();
        assert_eq!(hit.major, 1);
        assert_eq!(hit.minor, 8);
        assert_eq!(hit.code, vec![0x0c]);
        assert!(hit.exports.is_empty());
    }

    #[test]
    fn hit_rejects_bad_magic() {
        let buf = b"FOO!\x01\x00\x00\x00\x08\x00\x00\x00TRAX".to_vec();
        assert!(matches!(Hit::parse(&buf), Err(SimAnticsError::HitBadMagic)));
    }

    #[test]
    fn hit_rejects_unsupported_version() {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"HIT!");
        buf.extend_from_slice(&2u32.to_le_bytes());
        buf.extend_from_slice(&0u32.to_le_bytes());
        buf.extend_from_slice(b"TRAX");
        assert!(matches!(
            Hit::parse(&buf),
            Err(SimAnticsError::HitUnsupportedVersion { major: 2, minor: 0 })
        ));
    }

    #[test]
    fn hit_disasm_walks_all_known_opcodes() {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"HIT!");
        buf.extend_from_slice(&1u32.to_le_bytes());
        buf.extend_from_slice(&8u32.to_le_bytes());
        buf.extend_from_slice(b"TRAX");
        // loadl v1 #0xDEADBEEF (1+1+4 = 6 bytes)
        buf.extend_from_slice(&[0x05, 0x05]);
        buf.extend_from_slice(&0xDEAD_BEEFu32.to_le_bytes());
        // play_trk v1 (2 bytes)
        buf.extend_from_slice(&[0x32, 0x05]);
        // wait v1 (2 bytes)
        buf.extend_from_slice(&[0x09, 0x05]);
        // end (1 byte)
        buf.extend_from_slice(&[0x0c]);
        let hit = Hit::parse(&buf).unwrap();
        let instrs = hit.disasm();
        assert_eq!(instrs.len(), 4);
        assert_eq!(instrs[0].mnemonic, "loadl");
        assert_eq!(instrs[0].args, "v1 #0xdeadbeef");
        assert_eq!(instrs[0].byte_len, 6);
        assert_eq!(instrs[1].mnemonic, "play_trk");
        assert_eq!(instrs[1].args, "v1");
        assert_eq!(instrs[2].mnemonic, "wait");
        assert_eq!(instrs[3].mnemonic, "end");
    }

    #[test]
    fn hit_parses_export_table() {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"HIT!");
        buf.extend_from_slice(&1u32.to_le_bytes());
        buf.extend_from_slice(&8u32.to_le_bytes());
        buf.extend_from_slice(b"TRAX");
        // Some prefix bytecode
        buf.extend_from_slice(&[0x0c]);
        // Export table
        buf.extend_from_slice(b"ENTP");
        buf.extend_from_slice(&100u32.to_le_bytes()); // track_id
        buf.extend_from_slice(&0x40u32.to_le_bytes()); // address
        buf.extend_from_slice(&200u32.to_le_bytes());
        buf.extend_from_slice(&0x80u32.to_le_bytes());
        buf.extend_from_slice(b"EENT");
        let hit = Hit::parse(&buf).unwrap();
        assert_eq!(hit.exports.len(), 2);
        assert_eq!(hit.exports[0], HitExport { track_id: 100, address: 0x40 });
        assert_eq!(hit.exports[1], HitExport { track_id: 200, address: 0x80 });
    }
}
