//! Parser for the EA/Maxis IFF container used by The Sims 1 and TSO.
//!
//! IFF in this codebase always means *the Maxis variant* (header begins with
//! `IFF FILE 2.5:TYPE` or `IFF FILE 2.0:TYPE`), not the generic Electronic Arts
//! IFF nor the original Amiga IFF.
//!
//! Format reference: [`docs/formats/IFF.md`] + the Niotso wiki snapshot.
//!
//! Chunk *headers* are big-endian; chunk *data* is little-endian. We expose chunks
//! zero-copy as borrowed slices and leave LE decoding of the data to per-chunk
//! decoders that live in their own crates.

#![no_std]

use thiserror::Error;

pub const HEADER_LEN: usize = 64;
pub const CHUNK_HEADER_LEN: usize = 76;
const V25_RSMP_OFFSET: usize = 60;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum IffError {
    #[error("buffer too short for header (got {got}, need {HEADER_LEN})")]
    HeaderTooShort { got: usize },
    #[error("not an IFF file: bad magic")]
    BadMagic,
    #[error("chunk header truncated at offset {offset}")]
    ChunkHeaderTruncated { offset: usize },
    #[error("chunk size {size} too small (header is {CHUNK_HEADER_LEN})")]
    ChunkTooSmall { size: u32 },
    #[error("chunk at {offset} would overrun buffer (size {size}, buffer {buffer})")]
    ChunkOverrun {
        offset: usize,
        size: usize,
        buffer: usize,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IffVersion {
    V2_0,
    V2_5,
}

#[derive(Debug, Clone, Copy)]
pub struct Iff<'a> {
    data: &'a [u8],
    version: IffVersion,
    rsmp_offset: u32,
}

#[derive(Debug, Clone, Copy)]
pub struct IffHeader {
    pub version: IffVersion,
    /// Offset of the `rsmp` chunk for v2.5 files; `0` for v2.0 (no resource map).
    pub rsmp_offset: u32,
}

#[derive(Debug, Clone, Copy)]
pub struct IffChunk<'a> {
    pub kind: [u8; 4],
    pub size: u32,
    pub id: u16,
    pub flags: u16,
    pub label: &'a [u8],
    pub data: &'a [u8],
    /// Byte offset of this chunk's start (the `kind` field) inside the input buffer.
    pub offset: usize,
}

impl<'a> Iff<'a> {
    /// Validate the magic and read the header.
    ///
    /// # Errors
    /// Returns `IffError::HeaderTooShort` or `BadMagic` if the buffer doesn't begin
    /// with a recognised Maxis IFF v2.0 / v2.5 header.
    pub fn parse(data: &'a [u8]) -> Result<Self, IffError> {
        if data.len() < HEADER_LEN {
            return Err(IffError::HeaderTooShort { got: data.len() });
        }
        let prefix = &data[..15];
        let version = if prefix == b"IFF FILE 2.5:TY" {
            IffVersion::V2_5
        } else if prefix == b"IFF FILE 2.0:TY" {
            IffVersion::V2_0
        } else {
            return Err(IffError::BadMagic);
        };
        let rsmp_offset = match version {
            IffVersion::V2_5 => read_u32_be(data, V25_RSMP_OFFSET)?,
            IffVersion::V2_0 => 0,
        };
        Ok(Self {
            data,
            version,
            rsmp_offset,
        })
    }

    #[must_use]
    pub const fn version(&self) -> IffVersion {
        self.version
    }

    #[must_use]
    pub const fn rsmp_offset(&self) -> u32 {
        self.rsmp_offset
    }

    #[must_use]
    pub const fn header(&self) -> IffHeader {
        IffHeader {
            version: self.version,
            rsmp_offset: self.rsmp_offset,
        }
    }

    /// Iterate chunks starting right after the 64-byte file header.
    /// Stops cleanly at end-of-buffer; yields `Err` once if the next header is malformed.
    #[must_use]
    pub const fn chunks(&self) -> Chunks<'a> {
        Chunks {
            data: self.data,
            cursor: HEADER_LEN,
            done: false,
        }
    }
}

/// Convenience: parse only the 64-byte header. Useful for cheap version sniffing.
///
/// # Errors
/// Same as [`Iff::parse`].
pub fn parse_header(data: &[u8]) -> Result<IffHeader, IffError> {
    Iff::parse(data).map(|i| i.header())
}

pub struct Chunks<'a> {
    data: &'a [u8],
    cursor: usize,
    done: bool,
}

impl<'a> Iterator for Chunks<'a> {
    type Item = Result<IffChunk<'a>, IffError>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.done {
            return None;
        }
        // No room for another chunk header — stop cleanly. Trailing bytes are tolerated
        // (Options.iff has 89 trailing bytes the engine ignores).
        if self.cursor + CHUNK_HEADER_LEN > self.data.len() {
            self.done = true;
            return None;
        }
        match parse_chunk(self.data, self.cursor) {
            Ok((chunk, next_cursor)) => {
                self.cursor = next_cursor;
                Some(Ok(chunk))
            }
            Err(e) => {
                self.done = true;
                Some(Err(e))
            }
        }
    }
}

fn parse_chunk(data: &[u8], cursor: usize) -> Result<(IffChunk<'_>, usize), IffError> {
    if cursor + CHUNK_HEADER_LEN > data.len() {
        return Err(IffError::ChunkHeaderTruncated { offset: cursor });
    }
    let kind = [
        data[cursor],
        data[cursor + 1],
        data[cursor + 2],
        data[cursor + 3],
    ];
    let size = read_u32_be(data, cursor + 4)?;
    if (size as usize) < CHUNK_HEADER_LEN {
        return Err(IffError::ChunkTooSmall { size });
    }
    let id = read_u16_be(data, cursor + 8)?;
    let flags = read_u16_be(data, cursor + 10)?;
    let label = &data[cursor + 12..cursor + 76];
    let chunk_end = cursor
        .checked_add(size as usize)
        .ok_or(IffError::ChunkOverrun {
            offset: cursor,
            size: size as usize,
            buffer: data.len(),
        })?;
    if chunk_end > data.len() {
        return Err(IffError::ChunkOverrun {
            offset: cursor,
            size: size as usize,
            buffer: data.len(),
        });
    }
    let data_slice = &data[cursor + CHUNK_HEADER_LEN..chunk_end];
    Ok((
        IffChunk {
            kind,
            size,
            id,
            flags,
            label,
            data: data_slice,
            offset: cursor,
        },
        chunk_end,
    ))
}

fn read_u32_be(data: &[u8], offset: usize) -> Result<u32, IffError> {
    let end = offset.checked_add(4).ok_or(IffError::HeaderTooShort {
        got: data.len(),
    })?;
    if end > data.len() {
        return Err(IffError::HeaderTooShort { got: data.len() });
    }
    Ok(u32::from_be_bytes([
        data[offset],
        data[offset + 1],
        data[offset + 2],
        data[offset + 3],
    ]))
}

fn read_u16_be(data: &[u8], offset: usize) -> Result<u16, IffError> {
    let end = offset.checked_add(2).ok_or(IffError::HeaderTooShort {
        got: data.len(),
    })?;
    if end > data.len() {
        return Err(IffError::HeaderTooShort { got: data.len() });
    }
    Ok(u16::from_be_bytes([data[offset], data[offset + 1]]))
}

#[cfg(test)]
extern crate std;

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use std::vec;
    use std::vec::Vec;

    fn make_v25_header(rsmp_offset: u32) -> [u8; HEADER_LEN] {
        let mut buf = [0u8; HEADER_LEN];
        buf[..60].copy_from_slice(b"IFF FILE 2.5:TYPE FOLLOWED BY SIZE\0 JAMIE DOORNBOS & MAXIS 1");
        buf[V25_RSMP_OFFSET..V25_RSMP_OFFSET + 4].copy_from_slice(&rsmp_offset.to_be_bytes());
        buf
    }

    fn write_chunk_header(buf: &mut [u8], at: usize, kind: [u8; 4], size: u32, id: u16, flags: u16) {
        buf[at..at + 4].copy_from_slice(&kind);
        buf[at + 4..at + 8].copy_from_slice(&size.to_be_bytes());
        buf[at + 8..at + 10].copy_from_slice(&id.to_be_bytes());
        buf[at + 10..at + 12].copy_from_slice(&flags.to_be_bytes());
        // label (64 bytes) left zero
    }

    #[test]
    fn detects_v2_5() {
        let buf = make_v25_header(0);
        let header = parse_header(&buf).expect("should parse");
        assert_eq!(header.version, IffVersion::V2_5);
        assert_eq!(header.rsmp_offset, 0);
    }

    #[test]
    fn detects_v2_0() {
        let mut buf = [0u8; HEADER_LEN];
        buf[..15].copy_from_slice(b"IFF FILE 2.0:TY");
        let header = parse_header(&buf).expect("v2.0 ok");
        assert_eq!(header.version, IffVersion::V2_0);
        assert_eq!(header.rsmp_offset, 0);
    }

    #[test]
    fn rejects_garbage() {
        let buf = [0u8; HEADER_LEN];
        assert!(matches!(parse_header(&buf), Err(IffError::BadMagic)));
    }

    #[test]
    fn rejects_short_buffer() {
        assert!(matches!(
            parse_header(&[0u8; 10]),
            Err(IffError::HeaderTooShort { got: 10 })
        ));
    }

    #[test]
    fn enumerates_two_synthetic_chunks() {
        // 64-byte header + chunk(BHAV, size=80, data 4 bytes) + chunk(BCON, size=78, data 2 bytes)
        let mut buf = vec![0u8; HEADER_LEN + 80 + 78];
        buf[..HEADER_LEN].copy_from_slice(&make_v25_header(0));
        write_chunk_header(&mut buf, HEADER_LEN, *b"BHAV", 80, 1, 0x0010);
        buf[HEADER_LEN + CHUNK_HEADER_LEN..HEADER_LEN + 80].copy_from_slice(&[0xDE, 0xAD, 0xBE, 0xEF]);
        write_chunk_header(&mut buf, HEADER_LEN + 80, *b"BCON", 78, 2, 0x0014);
        let bcon_data_at = HEADER_LEN + 80 + CHUNK_HEADER_LEN;
        buf[bcon_data_at..bcon_data_at + 2].copy_from_slice(&[0x42, 0x01]);

        let iff = Iff::parse(&buf).unwrap();
        let chunks: Result<Vec<_>, _> = iff.chunks().collect();
        let chunks = chunks.unwrap();
        assert_eq!(chunks.len(), 2);
        assert_eq!(&chunks[0].kind, b"BHAV");
        assert_eq!(chunks[0].size, 80);
        assert_eq!(chunks[0].id, 1);
        assert_eq!(chunks[0].flags, 0x0010);
        assert_eq!(chunks[0].data, &[0xDE, 0xAD, 0xBE, 0xEF]);
        assert_eq!(chunks[0].offset, HEADER_LEN);
        assert_eq!(&chunks[1].kind, b"BCON");
        assert_eq!(chunks[1].flags, 0x0014);
        assert_eq!(chunks[1].data, &[0x42, 0x01]);
    }

    #[test]
    fn tolerates_trailing_bytes() {
        // Header + chunk(80) + 5 trailing bytes — not enough room for another chunk header.
        let mut buf = vec![0u8; HEADER_LEN + 80 + 5];
        buf[..HEADER_LEN].copy_from_slice(&make_v25_header(0));
        write_chunk_header(&mut buf, HEADER_LEN, *b"Optn", 80, 0x80, 0x0010);
        let iff = Iff::parse(&buf).unwrap();
        let chunks: Vec<_> = iff.chunks().collect::<Result<_, _>>().unwrap();
        assert_eq!(chunks.len(), 1);
    }

    #[test]
    fn rejects_oversized_chunk() {
        let mut buf = vec![0u8; HEADER_LEN + CHUNK_HEADER_LEN];
        buf[..HEADER_LEN].copy_from_slice(&make_v25_header(0));
        // Claim size = 1 MiB but buffer is tiny.
        write_chunk_header(&mut buf, HEADER_LEN, *b"BHAV", 1024 * 1024, 1, 0);
        let iff = Iff::parse(&buf).unwrap();
        let mut iter = iff.chunks();
        let first = iter.next().expect("one error item");
        assert!(matches!(first, Err(IffError::ChunkOverrun { .. })));
        assert!(iter.next().is_none());
    }

    #[test]
    fn rejects_subheader_chunk() {
        let mut buf = vec![0u8; HEADER_LEN + CHUNK_HEADER_LEN];
        buf[..HEADER_LEN].copy_from_slice(&make_v25_header(0));
        write_chunk_header(&mut buf, HEADER_LEN, *b"BHAV", 12, 1, 0);
        let iff = Iff::parse(&buf).unwrap();
        let first = iff.chunks().next().unwrap();
        assert!(matches!(first, Err(IffError::ChunkTooSmall { size: 12 })));
    }
}
