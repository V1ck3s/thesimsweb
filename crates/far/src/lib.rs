//! Parser for the Maxis FAR v1 archive format ("FAR! by AZ"), as used by The Sims 1.
//!
//! Format reference: [`docs/formats/FAR.md`].
//!
//! Zero-copy: every entry borrows from the input slice. Suitable for streaming the
//! manifest tail of a remote archive once the header is known.

#![no_std]

use thiserror::Error;

pub const MAGIC: &[u8; 8] = b"FAR!byAZ";
pub const VERSION_1: u32 = 1;
pub const HEADER_SIZE: usize = 16;
pub const ENTRY_FIXED_SIZE: usize = 16;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum FarError {
    #[error("not a FAR archive: bad magic")]
    BadMagic,
    #[error("unsupported FAR version (got {0}, want 1)")]
    UnsupportedVersion(u32),
    #[error("buffer too short")]
    TooShort,
    #[error("manifest offset out of range")]
    BadManifestOffset,
    #[error("entry offset/size out of range")]
    BadEntryRange,
    #[error("filename length exceeds remaining manifest bytes")]
    BadFilename,
}

/// Parsed FAR archive view. Borrows from the input slice for zero-copy access.
#[derive(Clone, Copy)]
pub struct Far<'a> {
    data: &'a [u8],
    manifest_offset: u32,
    entry_count: u32,
}

/// One entry inside the manifest. Filenames are raw ASCII bytes, no NUL terminator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FarEntry<'a> {
    pub size_decompressed: u32,
    pub size_compressed: u32,
    pub offset: u32,
    pub filename: &'a [u8],
}

impl<'a> Far<'a> {
    /// Validate the magic, read the header, and seek the manifest.
    /// Does not iterate entries — call [`Self::entries`] for that.
    ///
    /// # Errors
    /// Returns `FarError::TooShort`, `BadMagic`, `UnsupportedVersion`, or `BadManifestOffset`
    /// if the buffer is malformed or not a v1 archive.
    pub fn parse(data: &'a [u8]) -> Result<Self, FarError> {
        if data.len() < HEADER_SIZE {
            return Err(FarError::TooShort);
        }
        if &data[..MAGIC.len()] != MAGIC {
            return Err(FarError::BadMagic);
        }
        let version = read_u32_le(data, 8)?;
        if version != VERSION_1 {
            return Err(FarError::UnsupportedVersion(version));
        }
        let manifest_offset = read_u32_le(data, 12)?;
        let manifest_start = manifest_offset as usize;
        if manifest_start.saturating_add(4) > data.len() {
            return Err(FarError::BadManifestOffset);
        }
        let entry_count = read_u32_le(data, manifest_start)?;
        Ok(Self {
            data,
            manifest_offset,
            entry_count,
        })
    }

    #[must_use]
    pub const fn entry_count(&self) -> u32 {
        self.entry_count
    }

    #[must_use]
    pub const fn manifest_offset(&self) -> u32 {
        self.manifest_offset
    }

    #[must_use]
    pub const fn entries(&self) -> Entries<'a> {
        Entries {
            data: self.data,
            cursor: self.manifest_offset as usize + 4,
            remaining: self.entry_count,
        }
    }

    /// Borrow the raw payload bytes for an entry. Validates offset+size lie inside `data`.
    ///
    /// # Errors
    /// Returns `FarError::BadEntryRange` if the entry's offset+size lies outside the buffer.
    pub fn payload(&self, entry: &FarEntry<'a>) -> Result<&'a [u8], FarError> {
        let start = entry.offset as usize;
        let end = start
            .checked_add(entry.size_compressed as usize)
            .ok_or(FarError::BadEntryRange)?;
        if end > self.data.len() {
            return Err(FarError::BadEntryRange);
        }
        Ok(&self.data[start..end])
    }
}

/// Iterator over manifest entries. Yields `Err` once on malformed entries and stops.
pub struct Entries<'a> {
    data: &'a [u8],
    cursor: usize,
    remaining: u32,
}

impl<'a> Iterator for Entries<'a> {
    type Item = Result<FarEntry<'a>, FarError>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.remaining == 0 {
            return None;
        }
        let result = parse_entry(self.data, self.cursor);
        match result {
            Ok((entry, next_cursor)) => {
                self.remaining -= 1;
                self.cursor = next_cursor;
                Some(Ok(entry))
            }
            Err(e) => {
                self.remaining = 0;
                Some(Err(e))
            }
        }
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        let n = self.remaining as usize;
        (n, Some(n))
    }
}

fn parse_entry(data: &[u8], cursor: usize) -> Result<(FarEntry<'_>, usize), FarError> {
    let header_end = cursor
        .checked_add(ENTRY_FIXED_SIZE)
        .ok_or(FarError::BadEntryRange)?;
    if header_end > data.len() {
        return Err(FarError::BadEntryRange);
    }
    let size_decompressed = read_u32_le(data, cursor)?;
    let size_compressed = read_u32_le(data, cursor + 4)?;
    let offset = read_u32_le(data, cursor + 8)?;
    let filename_length = read_u32_le(data, cursor + 12)? as usize;
    let filename_end = header_end
        .checked_add(filename_length)
        .ok_or(FarError::BadFilename)?;
    if filename_end > data.len() {
        return Err(FarError::BadFilename);
    }
    let filename = &data[header_end..filename_end];
    Ok((
        FarEntry {
            size_decompressed,
            size_compressed,
            offset,
            filename,
        },
        filename_end,
    ))
}

fn read_u32_le(data: &[u8], offset: usize) -> Result<u32, FarError> {
    let end = offset.checked_add(4).ok_or(FarError::TooShort)?;
    if end > data.len() {
        return Err(FarError::TooShort);
    }
    let bytes = &data[offset..end];
    Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

/// Quick magic-only check, useful before downloading the whole archive.
///
/// # Errors
/// Returns `FarError::TooShort` if `data` is shorter than the magic, or `BadMagic`
/// if the bytes don't match.
pub fn check_magic(data: &[u8]) -> Result<(), FarError> {
    if data.len() < MAGIC.len() {
        return Err(FarError::TooShort);
    }
    if &data[..MAGIC.len()] != MAGIC {
        return Err(FarError::BadMagic);
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    /// Build a minimal valid FAR with one entry "hi.txt" (6 bytes payload "HELLO!").
    fn synthetic_one_entry() -> [u8; 16 + 6 + 4 + 16 + 6] {
        let mut buf = [0u8; 16 + 6 + 4 + 16 + 6];
        buf[..8].copy_from_slice(MAGIC);
        buf[8..12].copy_from_slice(&1u32.to_le_bytes());
        let manifest_offset: u32 = 16 + 6;
        buf[12..16].copy_from_slice(&manifest_offset.to_le_bytes());
        buf[16..22].copy_from_slice(b"HELLO!");
        let m = manifest_offset as usize;
        buf[m..m + 4].copy_from_slice(&1u32.to_le_bytes());
        buf[m + 4..m + 8].copy_from_slice(&6u32.to_le_bytes());
        buf[m + 8..m + 12].copy_from_slice(&6u32.to_le_bytes());
        buf[m + 12..m + 16].copy_from_slice(&16u32.to_le_bytes());
        buf[m + 16..m + 20].copy_from_slice(&6u32.to_le_bytes());
        buf[m + 20..m + 26].copy_from_slice(b"hi.txt");
        buf
    }

    #[test]
    fn accepts_magic() {
        let mut buf = [0u8; 32];
        buf[..MAGIC.len()].copy_from_slice(MAGIC);
        assert!(check_magic(&buf).is_ok());
    }

    #[test]
    fn rejects_non_far() {
        assert!(matches!(check_magic(b"NOTAFAR\x00\x00"), Err(FarError::BadMagic)));
    }

    #[test]
    fn parses_synthetic_archive() {
        let buf = synthetic_one_entry();
        let far = Far::parse(&buf).unwrap();
        assert_eq!(far.entry_count(), 1);
        let mut iter = far.entries();
        let entry = iter.next().expect("one entry").expect("valid entry");
        assert!(iter.next().is_none());
        assert_eq!(entry.filename, b"hi.txt");
        assert_eq!(entry.size_decompressed, 6);
        assert_eq!(entry.size_compressed, 6);
        assert_eq!(entry.offset, 16);
        assert_eq!(far.payload(&entry).unwrap(), b"HELLO!");
    }

    #[test]
    fn rejects_unsupported_version() {
        let mut buf = [0u8; 16];
        buf[..8].copy_from_slice(MAGIC);
        buf[8..12].copy_from_slice(&3u32.to_le_bytes());
        assert!(matches!(
            Far::parse(&buf),
            Err(FarError::UnsupportedVersion(3))
        ));
    }

    #[test]
    fn rejects_bad_manifest_offset() {
        let mut buf = [0u8; 16];
        buf[..8].copy_from_slice(MAGIC);
        buf[8..12].copy_from_slice(&1u32.to_le_bytes());
        buf[12..16].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(matches!(Far::parse(&buf), Err(FarError::BadManifestOffset)));
    }

    #[test]
    fn rejects_truncated_payload() {
        let buf = synthetic_one_entry();
        let far = Far::parse(&buf).unwrap();
        let entry = far.entries().next().unwrap().unwrap();
        let truncated = &buf[..18];
        let far2 = Far {
            data: truncated,
            manifest_offset: far.manifest_offset(),
            entry_count: far.entry_count(),
        };
        assert!(matches!(far2.payload(&entry), Err(FarError::BadEntryRange)));
    }
}
