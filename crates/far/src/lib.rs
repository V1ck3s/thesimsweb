//! Parser for the Maxis FAR archive format ("FAR! by AZ", v1a) used by The Sims.
//!
//! Format reference: <http://wiki.niotso.org/FAR>.

#![no_std]

use thiserror::Error;

pub const MAGIC: &[u8; 8] = b"FAR!byAZ";

#[derive(Debug, Error)]
pub enum FarError {
    #[error("not a FAR archive: bad magic")]
    BadMagic,
    #[error("buffer too short")]
    TooShort,
}

/// Parse just enough of the FAR header to confirm the magic.
/// Full table-of-contents parsing lands in phase 2.
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
mod tests {
    use super::*;

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
}
