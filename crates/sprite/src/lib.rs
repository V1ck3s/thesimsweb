//! Decoders for The Sims paletted sprites (`SPR2`) and palette chunks (`PALT`).
//!
//! Output: RGBA8 pixel buffers ready for GPU upload via WebGL `texImage2D`.
//!
//! Format reference: [`docs/formats/SPR2.md`] + the Niotso wiki snapshot.
//!
//! `#![no_std]` library. Decoded frames need allocation; we use `alloc::vec::Vec`.

#![no_std]
#![allow(clippy::module_name_repetitions)]

extern crate alloc;

use alloc::vec;
use alloc::vec::Vec;

use thiserror::Error;

pub const PALT_HEADER_LEN: usize = 16;
pub const PALT_ENTRY_BYTES: usize = 3;
pub const PALT_MAX_ENTRIES: u32 = 256;
pub const SPR2_VERSION_1000: u32 = 1000;
pub const SPR2_VERSION_1001: u32 = 1001;
pub const SPR2_PALETTE_DEFAULT_SENTINEL: u16 = 0xA3A3;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SpriteError {
    #[error("buffer too short")]
    TooShort,
    #[error("PALT version {0} unsupported (want 1)")]
    PaltUnsupportedVersion(u32),
    #[error("PALT color count {0} out of range 1..=256")]
    PaltCountOutOfRange(u32),
    #[error("PALT data length mismatch (got {got}, expected {expected})")]
    PaltLengthMismatch { got: usize, expected: usize },
    #[error("SPR2 version {0} unsupported (want 1000 or 1001)")]
    Spr2UnsupportedVersion(u32),
    #[error("SPR2 frame index {0} out of range")]
    Spr2FrameOutOfRange(u32),
    #[error("SPR2 frame offset {0} out of range")]
    Spr2OffsetOutOfRange(u32),
    #[error("SPR2 unsupported sprite version {0} (expected 1001)")]
    Spr2UnsupportedFrameVersion(u32),
    #[error("SPR2 RLE: unknown row command {cmd} at row {row}")]
    Spr2RleBadRowCmd { cmd: u16, row: u16 },
    #[error("SPR2 RLE: unknown pixel command {cmd} at row {row}")]
    Spr2RleBadPixelCmd { cmd: u16, row: u16 },
    #[error("SPR2 RLE: row block at row {row} overruns its declared length")]
    Spr2RleRowOverrun { row: u16 },
    #[error("SPR2 RLE: pixel run at row {row} overflows row width {width}")]
    Spr2RlePixelOverflow { row: u16, width: u16 },
    #[error("SPR2 RLE: missing end-of-sprite marker (row counter at {rows}/{height})")]
    Spr2RleMissingEnd { rows: u16, height: u16 },
}

// ---- PALT ----

#[derive(Debug, Clone)]
pub struct Palette {
    pub entries: Vec<[u8; 3]>,
}

impl Palette {
    /// Decode a PALT chunk's data payload (the bytes *after* the 76-byte IFF chunk header).
    ///
    /// # Errors
    /// `PaltUnsupportedVersion`, `PaltCountOutOfRange`, or `PaltLengthMismatch`.
    pub fn parse(data: &[u8]) -> Result<Self, SpriteError> {
        if data.len() < PALT_HEADER_LEN {
            return Err(SpriteError::TooShort);
        }
        let version = read_u32_le(data, 0)?;
        if version != 1 {
            return Err(SpriteError::PaltUnsupportedVersion(version));
        }
        let color_count = read_u32_le(data, 4)?;
        if color_count == 0 || color_count > PALT_MAX_ENTRIES {
            return Err(SpriteError::PaltCountOutOfRange(color_count));
        }
        let expected = PALT_HEADER_LEN + (color_count as usize) * PALT_ENTRY_BYTES;
        if data.len() != expected {
            return Err(SpriteError::PaltLengthMismatch {
                got: data.len(),
                expected,
            });
        }
        let mut entries = Vec::with_capacity(color_count as usize);
        let mut cursor = PALT_HEADER_LEN;
        for _ in 0..color_count {
            entries.push([data[cursor], data[cursor + 1], data[cursor + 2]]);
            cursor += PALT_ENTRY_BYTES;
        }
        Ok(Self { entries })
    }

    /// Look up an RGB triple by index. Returns `[0,0,0]` if the index is out of range —
    /// caller is expected to validate ahead of time.
    #[must_use]
    pub fn rgb(&self, index: u8) -> [u8; 3] {
        self.entries
            .get(index as usize)
            .copied()
            .unwrap_or([0, 0, 0])
    }
}

// ---- SPR2 frame metadata ----

#[derive(Debug, Clone, Copy)]
pub struct Spr2Header {
    pub version: u32,
    pub default_palette: u32,
    pub sprite_count: u32,
}

#[derive(Debug, Clone, Copy)]
pub struct Spr2FrameMeta {
    pub width: u16,
    pub height: u16,
    pub flags: u32,
    pub palette: u16,
    pub transparent_color: u16,
    pub y_location: i16,
    pub x_location: i16,
    /// Byte offset (within the SPR2 chunk data) where the RLE row data starts.
    pub rle_offset: usize,
}

impl Spr2FrameMeta {
    pub const FLAG_HAS_COLOR: u32 = 0x01;
    pub const FLAG_HAS_Z: u32 = 0x02;
    pub const FLAG_HAS_ALPHA: u32 = 0x04;

    #[must_use]
    pub const fn has_color(&self) -> bool {
        self.flags & Self::FLAG_HAS_COLOR != 0
    }
    #[must_use]
    pub const fn has_z(&self) -> bool {
        self.flags & Self::FLAG_HAS_Z != 0
    }
    #[must_use]
    pub const fn has_alpha(&self) -> bool {
        self.flags & Self::FLAG_HAS_ALPHA != 0
    }
}

#[derive(Debug, Clone)]
pub struct Spr2 {
    pub header: Spr2Header,
    pub frames: Vec<Spr2FrameMeta>,
    /// Owned copy of the chunk data, so the SPR2 view is self-contained.
    data: Vec<u8>,
}

impl Spr2 {
    /// Parse the SPR2 chunk header + frame headers (lazy: doesn't decode RLE).
    ///
    /// # Errors
    /// `TooShort`, `Spr2UnsupportedVersion`, `Spr2OffsetOutOfRange`, or
    /// `Spr2UnsupportedFrameVersion`.
    pub fn parse(data: &[u8]) -> Result<Self, SpriteError> {
        if data.len() < 12 {
            return Err(SpriteError::TooShort);
        }
        let version = read_u32_le(data, 0)?;
        match version {
            SPR2_VERSION_1000 => Self::parse_v1000(data),
            SPR2_VERSION_1001 => Self::parse_v1001(data),
            v => Err(SpriteError::Spr2UnsupportedVersion(v)),
        }
    }

    fn parse_v1000(data: &[u8]) -> Result<Self, SpriteError> {
        let sprite_count = read_u32_le(data, 4)?;
        let default_palette = read_u32_le(data, 8)?;
        let table_end = 12 + (sprite_count as usize) * 4;
        if data.len() < table_end {
            return Err(SpriteError::TooShort);
        }
        let mut frames = Vec::with_capacity(sprite_count as usize);
        for i in 0..sprite_count {
            let off = read_u32_le(data, 12 + (i as usize) * 4)?;
            let frame = parse_frame_meta(data, off as usize)?;
            frames.push(frame);
        }
        Ok(Self {
            header: Spr2Header {
                version: SPR2_VERSION_1000,
                default_palette,
                sprite_count,
            },
            frames,
            data: data.to_vec(),
        })
    }

    fn parse_v1001(data: &[u8]) -> Result<Self, SpriteError> {
        let default_palette = read_u32_le(data, 4)?;
        let sprite_count = read_u32_le(data, 8)?;
        let mut frames = Vec::with_capacity(sprite_count as usize);
        let mut cursor = 12usize;
        for _ in 0..sprite_count {
            if cursor + 8 > data.len() {
                return Err(SpriteError::TooShort);
            }
            let frame_version = read_u32_le(data, cursor)?;
            if frame_version != SPR2_VERSION_1001 {
                return Err(SpriteError::Spr2UnsupportedFrameVersion(frame_version));
            }
            let frame_size = read_u32_le(data, cursor + 4)? as usize;
            let frame_start = cursor + 8;
            let frame_end = frame_start
                .checked_add(frame_size)
                .ok_or(SpriteError::TooShort)?;
            if frame_end > data.len() {
                return Err(SpriteError::TooShort);
            }
            let frame = parse_frame_meta(data, frame_start)?;
            frames.push(frame);
            cursor = frame_end;
        }
        Ok(Self {
            header: Spr2Header {
                version: SPR2_VERSION_1001,
                default_palette,
                sprite_count,
            },
            frames,
            data: data.to_vec(),
        })
    }

    /// Borrow the raw SPR2 data buffer (used internally by [`Self::decode_frame`]).
    #[must_use]
    pub fn data(&self) -> &[u8] {
        &self.data
    }
}

fn parse_frame_meta(data: &[u8], at: usize) -> Result<Spr2FrameMeta, SpriteError> {
    if at.saturating_add(16) > data.len() {
        return Err(SpriteError::Spr2OffsetOutOfRange(
            u32::try_from(at).unwrap_or(u32::MAX),
        ));
    }
    Ok(Spr2FrameMeta {
        width: read_u16_le(data, at)?,
        height: read_u16_le(data, at + 2)?,
        flags: read_u32_le(data, at + 4)?,
        palette: read_u16_le(data, at + 8)?,
        transparent_color: read_u16_le(data, at + 10)?,
        y_location: read_i16_le(data, at + 12)?,
        x_location: read_i16_le(data, at + 14)?,
        rle_offset: at + 16,
    })
}

// ---- SPR2 RLE decoder ----

/// One decoded frame: RGBA8 pixel buffer plus optional z-buffer (8-bit, 1 byte/pixel).
#[derive(Debug, Clone)]
pub struct DecodedFrame {
    pub width: u16,
    pub height: u16,
    pub rgba: Vec<u8>,
    pub z: Option<Vec<u8>>,
}

impl Spr2 {
    /// Decode one frame's RLE payload to RGBA8 (and optional z-buffer).
    ///
    /// `palette` is the palette referenced by the frame (or chunk default). The caller is
    /// responsible for resolving `frame.palette` / `Spr2::header.default_palette` into a
    /// concrete [`Palette`] value.
    ///
    /// # Errors
    /// Any `Spr2Rle*` variant for malformed RLE input.
    pub fn decode_frame(&self, frame_index: u32, palette: &Palette) -> Result<DecodedFrame, SpriteError> {
        let frame = self
            .frames
            .get(frame_index as usize)
            .copied()
            .ok_or(SpriteError::Spr2FrameOutOfRange(frame_index))?;
        decode_rle(&self.data, frame, palette)
    }
}

fn decode_rle(
    data: &[u8],
    frame: Spr2FrameMeta,
    palette: &Palette,
) -> Result<DecodedFrame, SpriteError> {
    let w = frame.width;
    let h = frame.height;
    let pixels = (w as usize) * (h as usize);
    let mut rgba = vec![0u8; pixels * 4];
    let mut z = if frame.has_z() {
        Some(vec![0xFFu8; pixels])
    } else {
        None
    };
    // Palette indices are 8-bit; the field is widened to u16 for layout reasons.
    let transparent_idx = u8::try_from(frame.transparent_color & 0xFF).unwrap_or(0);

    // Pre-fill: the format defines transparency as (transparent_color, z=255, alpha=0).
    let trans_rgb = palette.rgb(transparent_idx);
    for i in 0..pixels {
        rgba[i * 4] = trans_rgb[0];
        rgba[i * 4 + 1] = trans_rgb[1];
        rgba[i * 4 + 2] = trans_rgb[2];
        rgba[i * 4 + 3] = 0;
    }

    let mut cursor = frame.rle_offset;
    let mut row: u16 = 0;
    loop {
        if cursor + 2 > data.len() {
            return Err(SpriteError::Spr2RleMissingEnd { rows: row, height: h });
        }
        let word = u16::from_le_bytes([data[cursor], data[cursor + 1]]);
        let cmd = word >> 13;
        let count = word & 0x1FFF;
        cursor += 2;
        match cmd {
            0 => {
                // Fill row: count = total bytes of the row block including the 2-byte header.
                if count < 2 {
                    return Err(SpriteError::Spr2RleRowOverrun { row });
                }
                let block_payload_len = (count - 2) as usize;
                let block_end = cursor + block_payload_len;
                if block_end > data.len() {
                    return Err(SpriteError::Spr2RleRowOverrun { row });
                }
                decode_pixel_row(
                    &data[cursor..block_end],
                    row,
                    &mut rgba,
                    z.as_deref_mut(),
                    palette,
                    frame,
                )?;
                cursor = block_end;
                row = row.saturating_add(1);
            }
            4 => {
                // Skip `count` rows: they remain transparent (already set by pre-fill).
                row = row.saturating_add(count);
            }
            5 => {
                // End of sprite.
                break;
            }
            other => return Err(SpriteError::Spr2RleBadRowCmd { cmd: other, row }),
        }
        if row >= h {
            // Read until end marker even if we filled the frame.
            // Many encoders emit the end marker right after.
            if cursor + 2 > data.len() {
                return Err(SpriteError::Spr2RleMissingEnd { rows: row, height: h });
            }
            let final_word = u16::from_le_bytes([data[cursor], data[cursor + 1]]);
            if final_word >> 13 == 5 {
                break;
            }
            // Otherwise keep going (defensive — Niotso doesn't forbid it).
        }
    }
    // Rows beyond `row` (if any) stay transparent thanks to the pre-fill.

    Ok(DecodedFrame {
        width: w,
        height: h,
        rgba,
        z,
    })
}

fn decode_pixel_row(
    block: &[u8],
    row: u16,
    rgba: &mut [u8],
    mut z: Option<&mut [u8]>,
    palette: &Palette,
    frame: Spr2FrameMeta,
) -> Result<(), SpriteError> {
    let w = frame.width;
    let row_off = (row as usize) * (w as usize) * 4;
    let z_row_off = (row as usize) * (w as usize);
    let mut cursor = 0usize;
    let mut col: u16 = 0;

    while cursor + 2 <= block.len() {
        let word = u16::from_le_bytes([block[cursor], block[cursor + 1]]);
        let cmd = word >> 13;
        let count = word & 0x1FFF;
        cursor += 2;
        match cmd {
            1 => {
                // 2 bytes per pixel: z, color
                let needed = (count as usize) * 2;
                if cursor + needed > block.len() {
                    return Err(SpriteError::Spr2RleRowOverrun { row });
                }
                if col + count > w {
                    return Err(SpriteError::Spr2RlePixelOverflow { row, width: w });
                }
                for i in 0..count as usize {
                    let zi = block[cursor + i * 2];
                    let ci = block[cursor + i * 2 + 1];
                    write_pixel(rgba, row_off, col as usize + i, palette, ci, frame.transparent_color, 255);
                    if let Some(zbuf) = z.as_deref_mut() {
                        zbuf[z_row_off + col as usize + i] = zi;
                    }
                }
                col += count;
                cursor += needed;
                cursor += needed & 1; // pad to even
            }
            2 => {
                // 3 bytes per pixel: z, color, alpha (5-bit alpha 0..31)
                let needed = (count as usize) * 3;
                if cursor + needed > block.len() {
                    return Err(SpriteError::Spr2RleRowOverrun { row });
                }
                if col + count > w {
                    return Err(SpriteError::Spr2RlePixelOverflow { row, width: w });
                }
                for i in 0..count as usize {
                    let zi = block[cursor + i * 3];
                    let ci = block[cursor + i * 3 + 1];
                    let ai = block[cursor + i * 3 + 2] & 0x1F; // 5-bit alpha
                    let alpha = (ai << 3) | (ai >> 2); // 5→8 bit upscale
                    write_pixel(rgba, row_off, col as usize + i, palette, ci, frame.transparent_color, alpha);
                    if let Some(zbuf) = z.as_deref_mut() {
                        zbuf[z_row_off + col as usize + i] = zi;
                    }
                }
                col += count;
                cursor += needed;
                cursor += needed & 1; // pad to even
            }
            3 => {
                // Leave next `count` pixels transparent. No data.
                if col + count > w {
                    return Err(SpriteError::Spr2RlePixelOverflow { row, width: w });
                }
                col += count;
            }
            6 => {
                // 1 byte per pixel: color only.
                let needed = count as usize;
                if cursor + needed > block.len() {
                    return Err(SpriteError::Spr2RleRowOverrun { row });
                }
                if col + count > w {
                    return Err(SpriteError::Spr2RlePixelOverflow { row, width: w });
                }
                for i in 0..count as usize {
                    let ci = block[cursor + i];
                    let alpha = if u16::from(ci) == frame.transparent_color { 0 } else { 255 };
                    let z_val = if alpha == 0 { 255 } else { 0 };
                    write_pixel(rgba, row_off, col as usize + i, palette, ci, frame.transparent_color, alpha);
                    if let Some(zbuf) = z.as_deref_mut() {
                        zbuf[z_row_off + col as usize + i] = z_val;
                    }
                }
                col += count;
                cursor += needed;
                cursor += needed & 1; // pad to even
            }
            other => return Err(SpriteError::Spr2RleBadPixelCmd { cmd: other, row }),
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn write_pixel(
    rgba: &mut [u8],
    row_off: usize,
    col: usize,
    palette: &Palette,
    color_idx: u8,
    transparent_color: u16,
    alpha: u8,
) {
    let i = row_off + col * 4;
    let rgb = palette.rgb(color_idx);
    rgba[i] = rgb[0];
    rgba[i + 1] = rgb[1];
    rgba[i + 2] = rgb[2];
    rgba[i + 3] = if u16::from(color_idx) == transparent_color { 0 } else { alpha };
}

// ---- helpers ----

fn read_u16_le(data: &[u8], offset: usize) -> Result<u16, SpriteError> {
    if offset + 2 > data.len() {
        return Err(SpriteError::TooShort);
    }
    Ok(u16::from_le_bytes([data[offset], data[offset + 1]]))
}

fn read_i16_le(data: &[u8], offset: usize) -> Result<i16, SpriteError> {
    if offset + 2 > data.len() {
        return Err(SpriteError::TooShort);
    }
    Ok(i16::from_le_bytes([data[offset], data[offset + 1]]))
}

fn read_u32_le(data: &[u8], offset: usize) -> Result<u32, SpriteError> {
    if offset + 4 > data.len() {
        return Err(SpriteError::TooShort);
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

    #[test]
    fn palt_decodes_minimal() {
        let mut buf = vec![0u8; PALT_HEADER_LEN + 3 * 4];
        buf[..4].copy_from_slice(&1u32.to_le_bytes());
        buf[4..8].copy_from_slice(&4u32.to_le_bytes());
        buf[16..28].copy_from_slice(&[1, 2, 3, 10, 20, 30, 100, 110, 120, 200, 210, 220]);
        let palt = Palette::parse(&buf).unwrap();
        assert_eq!(palt.entries.len(), 4);
        assert_eq!(palt.entries[0], [1, 2, 3]);
        assert_eq!(palt.entries[3], [200, 210, 220]);
    }

    #[test]
    fn palt_rejects_bad_version() {
        let mut buf = vec![0u8; PALT_HEADER_LEN + 3];
        buf[..4].copy_from_slice(&7u32.to_le_bytes());
        buf[4..8].copy_from_slice(&1u32.to_le_bytes());
        assert!(matches!(
            Palette::parse(&buf),
            Err(SpriteError::PaltUnsupportedVersion(7))
        ));
    }

    #[test]
    fn palt_rejects_length_mismatch() {
        let mut buf = vec![0u8; PALT_HEADER_LEN + 3 * 4 + 1];
        buf[..4].copy_from_slice(&1u32.to_le_bytes());
        buf[4..8].copy_from_slice(&4u32.to_le_bytes());
        assert!(matches!(
            Palette::parse(&buf),
            Err(SpriteError::PaltLengthMismatch { .. })
        ));
    }

    #[test]
    fn spr2_v1000_parses_minimal_frame_header() {
        // SPR2 v1000 with one 1×1 frame, color-only flag, that emits one row of one pixel
        // and ends. Frame at offset 0x10 from start of SPR2 data.
        let mut buf = Vec::new();
        // SPR2 header
        buf.extend_from_slice(&1000u32.to_le_bytes());
        buf.extend_from_slice(&1u32.to_le_bytes()); // sprite_count
        buf.extend_from_slice(&1u32.to_le_bytes()); // default_palette
        buf.extend_from_slice(&16u32.to_le_bytes()); // offset_table[0] = 0x10
        // Frame at 0x10
        buf.extend_from_slice(&1u16.to_le_bytes()); // width = 1
        buf.extend_from_slice(&1u16.to_le_bytes()); // height = 1
        buf.extend_from_slice(&Spr2FrameMeta::FLAG_HAS_COLOR.to_le_bytes()); // flags
        buf.extend_from_slice(&0xA3A3u16.to_le_bytes()); // palette
        buf.extend_from_slice(&0u16.to_le_bytes()); // transparent_color
        buf.extend_from_slice(&0i16.to_le_bytes()); // y_loc
        buf.extend_from_slice(&0i16.to_le_bytes()); // x_loc
        // Row block: cmd=0 (fill row), count=6 bytes total (2 row hdr + 4 pixel block)
        buf.extend_from_slice(&6u16.to_le_bytes());
        // Pixel cmd 6 (color only), count=1, 1 byte color + 1 pad
        buf.extend_from_slice(&((6u16 << 13) | 1u16).to_le_bytes());
        buf.extend_from_slice(&[0x05, 0x00]); // color idx 5 + pad
        // End marker (cmd=5, count=0)
        buf.extend_from_slice(&(5u16 << 13).to_le_bytes());

        let spr2 = Spr2::parse(&buf).unwrap();
        assert_eq!(spr2.header.version, 1000);
        assert_eq!(spr2.frames.len(), 1);
        assert_eq!(spr2.frames[0].width, 1);
        assert_eq!(spr2.frames[0].height, 1);
        assert_eq!(spr2.frames[0].flags, 0x01);

        // Build a 6-color palette where index 5 is bright green.
        let mut palt_data = vec![0u8; PALT_HEADER_LEN + 3 * 6];
        palt_data[..4].copy_from_slice(&1u32.to_le_bytes());
        palt_data[4..8].copy_from_slice(&6u32.to_le_bytes());
        palt_data[16 + 5 * 3..16 + 6 * 3].copy_from_slice(&[0x00, 0xFF, 0x00]);
        let palt = Palette::parse(&palt_data).unwrap();

        let frame = spr2.decode_frame(0, &palt).unwrap();
        assert_eq!(frame.width, 1);
        assert_eq!(frame.height, 1);
        assert_eq!(frame.rgba, vec![0x00, 0xFF, 0x00, 0xFF]);
    }
}
