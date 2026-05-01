//! Parser for the EA/Maxis IFF container used by The Sims.
//!
//! IFF in this codebase always means *the Maxis variant* (header begins with
//! `IFF FILE 2.5:TYP` or `IFF FILE 2.0:TYP`), not the generic Electronic Arts
//! IFF nor the original Amiga IFF.
//!
//! Format reference: <http://wiki.niotso.org/IFF> (the canonical doc — keep a
//! local copy in `docs/formats/IFF.md`).

#![no_std]

use thiserror::Error;

pub const HEADER_LEN: usize = 64;

#[derive(Debug, Error)]
pub enum IffError {
    #[error("buffer too short for header (got {got}, need {HEADER_LEN})")]
    HeaderTooShort { got: usize },
    #[error("not an IFF file: bad magic")]
    BadMagic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IffVersion {
    V2_0,
    V2_5,
}

#[derive(Debug, Clone, Copy)]
pub struct IffHeader {
    pub version: IffVersion,
}

/// Parse the 64-byte IFF header. Implementation lands in phase 1.
pub fn parse_header(data: &[u8]) -> Result<IffHeader, IffError> {
    if data.len() < HEADER_LEN {
        return Err(IffError::HeaderTooShort { got: data.len() });
    }
    // TODO(phase-1): full parse against the spec.
    let prefix = &data[..15];
    let version = if prefix == b"IFF FILE 2.5:TY" {
        IffVersion::V2_5
    } else if prefix == b"IFF FILE 2.0:TY" {
        IffVersion::V2_0
    } else {
        return Err(IffError::BadMagic);
    };
    Ok(IffHeader { version })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_v2_5() {
        let mut buf = [0u8; HEADER_LEN];
        buf[..15].copy_from_slice(b"IFF FILE 2.5:TY");
        let header = parse_header(&buf).expect("should parse");
        assert_eq!(header.version, IffVersion::V2_5);
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
}
