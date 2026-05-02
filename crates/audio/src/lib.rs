//! Audio decoders for The Sims (Maxis) — currently EA-XA ADPCM.
//!
//! `XA` is a Maxis container around the EA-XA 4-predictor ADPCM codec used in
//! several EA games of that era. Layout:
//!
//! ```text
//! Offset  Size  Field
//! ------  ----  --------------------------------------------------------
//! 0x00    4     magic ("XA\0\0" or "XAJ\0")
//! 0x04    4     pcm_size_bytes (decompressed size in bytes)
//! 0x08    2     channels (1 = mono, 2 = stereo)
//! 0x0A    2     unknown (often 1; possibly version)
//! 0x0C    4     sample_rate (Hz)
//! 0x10    4     avg_bytes_per_sec
//! 0x14    2     block_align (often 2 for 16-bit mono)
//! 0x16    2     bits_per_sample (always 16 in TS1)
//! 0x18    …     ADPCM data (15-byte blocks each producing 28 samples)
//! ```
//!
//! Each ADPCM block:
//! - Byte 0: high-nibble = predictor index (0..3 / 0..5 depending on variant),
//!           low-nibble  = shift factor
//! - Bytes 1..15: 14 bytes of nibble pairs → 28 4-bit signed samples
//!
//! Sample reconstruction (per nibble):
//! ```text
//! decoded = (nibble << 12) >> shift
//! sample  = decoded + (coef0 * prev1 + coef1 * prev2) / 256
//! sample  = clamp(sample, -32768, 32767)
//! prev2   = prev1
//! prev1   = sample
//! ```
//!
//! Stereo files have left/right blocks interleaved on a per-block basis.
//! We currently only test against mono TS1 files.

#![no_std]

extern crate alloc;

use alloc::vec::Vec;
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AudioError {
    #[error("XA file too short: need at least {need} bytes, got {got}")]
    XaTooShort { need: usize, got: usize },
    #[error("XA bad magic (want \"XA\\0\\0\" or \"XAJ\\0\")")]
    XaBadMagic,
    #[error("XA channel count {0} unsupported (need 1 or 2)")]
    XaBadChannels(u16),
    #[error("XA bits_per_sample {0} unsupported (need 16)")]
    XaBadBitDepth(u16),
}

/// Decoded PCM produced by [`Xa::decode`].
#[derive(Debug, Clone)]
pub struct DecodedPcm {
    pub sample_rate: u32,
    pub channels: u16,
    /// Interleaved 16-bit signed PCM samples. Length is `samples_per_channel × channels`.
    pub samples: Vec<i16>,
}

impl DecodedPcm {
    /// Pack the PCM into a minimal RIFF/WAV container so the browser's
    /// `AudioContext.decodeAudioData` can ingest it directly.
    #[must_use]
    pub fn to_wav(&self) -> Vec<u8> {
        let mut out = Vec::new();
        let pcm_len = self.samples.len() * 2;
        let bytes_per_sec = u32::from(self.channels) * self.sample_rate * 2;
        let block_align: u16 = self.channels * 2;

        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&u32::try_from(36 + pcm_len).unwrap_or(0).to_le_bytes());
        out.extend_from_slice(b"WAVE");
        out.extend_from_slice(b"fmt ");
        out.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
        out.extend_from_slice(&1u16.to_le_bytes());  // format: PCM
        out.extend_from_slice(&self.channels.to_le_bytes());
        out.extend_from_slice(&self.sample_rate.to_le_bytes());
        out.extend_from_slice(&bytes_per_sec.to_le_bytes());
        out.extend_from_slice(&block_align.to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes()); // bits/sample
        out.extend_from_slice(b"data");
        out.extend_from_slice(&u32::try_from(pcm_len).unwrap_or(0).to_le_bytes());
        for &s in &self.samples {
            out.extend_from_slice(&s.to_le_bytes());
        }
        out
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct XaHeader {
    pub pcm_size_bytes: u32,
    pub channels: u16,
    pub sample_rate: u32,
    pub avg_bytes_per_sec: u32,
    pub block_align: u16,
    pub bits_per_sample: u16,
    pub magic: [u8; 4],
    /// Where the ADPCM data starts (0x18 in all TS1 files seen so far).
    pub data_offset: usize,
}

/// EA-XA ADPCM decoder for The Sims `.xa`/`.XA` files.
pub struct Xa;

impl Xa {
    /// Parse the XA header without decoding the body. Useful for previewing
    /// metadata.
    ///
    /// # Errors
    /// `XaTooShort` if the buffer is < 24 bytes; `XaBadMagic` for non-XA files;
    /// `XaBadChannels` / `XaBadBitDepth` for unsupported configurations.
    pub fn parse_header(data: &[u8]) -> Result<XaHeader, AudioError> {
        if data.len() < 0x18 {
            return Err(AudioError::XaTooShort { need: 0x18, got: data.len() });
        }
        let magic = [data[0], data[1], data[2], data[3]];
        if &magic != b"XA\0\0" && &magic != b"XAJ\0" && &magic != b"XAI\0" {
            return Err(AudioError::XaBadMagic);
        }
        let pcm_size_bytes = u32_le(data, 4);
        let channels = u16_le(data, 8);
        let sample_rate = u32_le(data, 0x0C);
        let avg_bytes_per_sec = u32_le(data, 0x10);
        let block_align = u16_le(data, 0x14);
        let bits_per_sample = u16_le(data, 0x16);
        if channels != 1 && channels != 2 {
            return Err(AudioError::XaBadChannels(channels));
        }
        if bits_per_sample != 16 {
            return Err(AudioError::XaBadBitDepth(bits_per_sample));
        }
        Ok(XaHeader {
            pcm_size_bytes,
            channels,
            sample_rate,
            avg_bytes_per_sec,
            block_align,
            bits_per_sample,
            magic,
            data_offset: 0x18,
        })
    }

    /// Parse the header and decode the ADPCM stream into 16-bit PCM samples.
    ///
    /// # Errors
    /// Same as [`Self::parse_header`].
    pub fn decode(data: &[u8]) -> Result<DecodedPcm, AudioError> {
        let header = Self::parse_header(data)?;
        let body = &data[header.data_offset..];
        let samples = match header.channels {
            1 => decode_mono(body),
            2 => decode_stereo(body),
            other => return Err(AudioError::XaBadChannels(other)),
        };
        Ok(DecodedPcm {
            sample_rate: header.sample_rate,
            channels: header.channels,
            samples,
        })
    }
}

/// Predictor coefficients for EA-XA ADPCM (4-predictor variant). Each pair
/// is `(coef0, coef1)`; the divisor is 256.
const COEF: [(i32, i32); 4] = [
    (0,   0),
    (240, 0),
    (460, -208),
    (392, -220),
];

#[inline]
fn predict(predictor: usize, prev1: i32, prev2: i32) -> i32 {
    let p = predictor.min(COEF.len() - 1);
    let (c0, c1) = COEF[p];
    (c0 * prev1 + c1 * prev2) >> 8
}

fn decode_mono(body: &[u8]) -> Vec<i16> {
    let mut out = Vec::with_capacity(body.len() / 15 * 28);
    let mut prev1: i32 = 0;
    let mut prev2: i32 = 0;
    for block in body.chunks_exact(15) {
        let header = block[0];
        let predictor = (header >> 4) as usize;
        let shift = header & 0x0F;
        // Each of bytes 1..15 holds two 4-bit nibbles (low first per EA-XA).
        for &byte in &block[1..15] {
            let nibbles = [byte & 0x0F, byte >> 4];
            for n in nibbles {
                let mut s = i32::from(sign_extend4(n)) << 12;
                s >>= shift;
                s += predict(predictor, prev1, prev2);
                let clipped = s.clamp(i32::from(i16::MIN), i32::from(i16::MAX));
                #[allow(clippy::cast_possible_truncation)]
                let s16 = clipped as i16;
                out.push(s16);
                prev2 = prev1;
                prev1 = i32::from(s16);
            }
        }
    }
    out
}

fn decode_stereo(body: &[u8]) -> Vec<i16> {
    // Stereo XA interleaves left/right blocks (15 bytes each).
    let mut out = Vec::with_capacity(body.len() / 15 * 28);
    let mut prev1_l: i32 = 0;
    let mut prev2_l: i32 = 0;
    let mut prev1_r: i32 = 0;
    let mut prev2_r: i32 = 0;
    let mut left_buf: Vec<i16> = Vec::with_capacity(28);
    let mut right_buf: Vec<i16> = Vec::with_capacity(28);
    let mut is_right = false;
    for block in body.chunks_exact(15) {
        let header = block[0];
        let predictor = (header >> 4) as usize;
        let shift = header & 0x0F;
        let buf = if is_right { &mut right_buf } else { &mut left_buf };
        let (prev1, prev2) = if is_right {
            (&mut prev1_r, &mut prev2_r)
        } else {
            (&mut prev1_l, &mut prev2_l)
        };
        buf.clear();
        for &byte in &block[1..15] {
            let nibbles = [byte & 0x0F, byte >> 4];
            for n in nibbles {
                let mut s = i32::from(sign_extend4(n)) << 12;
                s >>= shift;
                s += predict(predictor, *prev1, *prev2);
                let clipped = s.clamp(i32::from(i16::MIN), i32::from(i16::MAX));
                #[allow(clippy::cast_possible_truncation)]
                let s16 = clipped as i16;
                buf.push(s16);
                *prev2 = *prev1;
                *prev1 = i32::from(s16);
            }
        }
        if is_right {
            for i in 0..28 {
                out.push(left_buf[i]);
                out.push(right_buf[i]);
            }
        }
        is_right = !is_right;
    }
    out
}

#[inline]
fn sign_extend4(n: u8) -> i8 {
    let n = n & 0x0F;
    if n & 0x08 != 0 {
        #[allow(clippy::cast_possible_wrap)]
        let s = (n | 0xF0) as i8;
        s
    } else {
        #[allow(clippy::cast_possible_wrap)]
        let s = n as i8;
        s
    }
}

#[inline]
fn u16_le(data: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([data[offset], data[offset + 1]])
}

#[inline]
fn u32_le(data: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        data[offset], data[offset + 1], data[offset + 2], data[offset + 3],
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn build_silent_xa(blocks: usize) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"XAJ\0");
        let pcm_size = (blocks * 28 * 2) as u32; // 28 samples × 2 bytes per block
        buf.extend_from_slice(&pcm_size.to_le_bytes()); // pcm size
        buf.extend_from_slice(&1u16.to_le_bytes()); // channels
        buf.extend_from_slice(&1u16.to_le_bytes()); // unknown
        buf.extend_from_slice(&11025u32.to_le_bytes()); // sample rate
        buf.extend_from_slice(&22050u32.to_le_bytes()); // bytes/sec
        buf.extend_from_slice(&2u16.to_le_bytes()); // block_align
        buf.extend_from_slice(&16u16.to_le_bytes()); // bits/sample
        for _ in 0..blocks {
            // header: predictor=0, shift=12 → completely silent block
            buf.push(0x0C);
            buf.extend_from_slice(&[0u8; 14]);
        }
        buf
    }

    #[test]
    fn xa_header_parses_and_decodes_silent_mono() {
        let xa = build_silent_xa(2);
        let header = Xa::parse_header(&xa).unwrap();
        assert_eq!(header.channels, 1);
        assert_eq!(header.sample_rate, 11025);
        assert_eq!(header.bits_per_sample, 16);
        assert_eq!(header.data_offset, 0x18);

        let pcm = Xa::decode(&xa).unwrap();
        assert_eq!(pcm.channels, 1);
        assert_eq!(pcm.samples.len(), 2 * 28);
        assert!(pcm.samples.iter().all(|&s| s == 0));
    }

    #[test]
    fn xa_rejects_bad_magic() {
        let mut xa = build_silent_xa(1);
        xa[0] = b'B';
        assert_eq!(Xa::parse_header(&xa), Err(AudioError::XaBadMagic));
    }

    #[test]
    fn xa_rejects_too_short() {
        let xa = vec![0u8; 4];
        assert!(matches!(Xa::parse_header(&xa), Err(AudioError::XaTooShort { .. })));
    }

    #[test]
    fn xa_rejects_bad_bit_depth() {
        let mut xa = build_silent_xa(1);
        xa[0x16] = 8; // 8 bits
        xa[0x17] = 0;
        assert_eq!(Xa::parse_header(&xa), Err(AudioError::XaBadBitDepth(8)));
    }

    #[test]
    fn xa_decode_predictor1_ramp() {
        // Build a 1-block XA with predictor=1 (240, 0), shift=0, all nibbles=1.
        // Decoded: each sample = (1<<12) + (240*prev1)/256 = 4096 + ~prev1
        let mut xa = Vec::new();
        xa.extend_from_slice(b"XAJ\0");
        xa.extend_from_slice(&56u32.to_le_bytes());
        xa.extend_from_slice(&1u16.to_le_bytes());
        xa.extend_from_slice(&1u16.to_le_bytes());
        xa.extend_from_slice(&11025u32.to_le_bytes());
        xa.extend_from_slice(&22050u32.to_le_bytes());
        xa.extend_from_slice(&2u16.to_le_bytes());
        xa.extend_from_slice(&16u16.to_le_bytes());
        xa.push(0x10); // predictor=1, shift=0
        xa.extend_from_slice(&[0x11u8; 14]); // all nibbles = 1

        let pcm = Xa::decode(&xa).unwrap();
        assert_eq!(pcm.samples.len(), 28);
        // First sample: (1<<12) + 0 = 4096
        assert_eq!(pcm.samples[0], 4096);
        // Second: 4096 + (240 * 4096) >> 8 = 4096 + 3840 = 7936
        assert_eq!(pcm.samples[1], 7936);
        // Successive samples grow until clamping; verify they ramp upward.
        for i in 1..pcm.samples.len() {
            assert!(pcm.samples[i] >= pcm.samples[i - 1]);
        }
    }

    #[test]
    fn xa_to_wav_round_trips_header_size() {
        let xa = build_silent_xa(2);
        let pcm = Xa::decode(&xa).unwrap();
        let wav = pcm.to_wav();
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        // PCM chunk: 16 bytes fmt + 8 bytes header + data
        // data_chunk_size = num_samples * 2
        let data_size_offset = 12 + 8 + 16 + 4;
        let data_size = u32::from_le_bytes([
            wav[data_size_offset],
            wav[data_size_offset + 1],
            wav[data_size_offset + 2],
            wav[data_size_offset + 3],
        ]);
        assert_eq!(data_size as usize, 2 * 28 * 2);
    }

    #[test]
    fn sign_extend4_handles_negative() {
        assert_eq!(sign_extend4(0x0F), -1);
        assert_eq!(sign_extend4(0x08), -8);
        assert_eq!(sign_extend4(0x07), 7);
        assert_eq!(sign_extend4(0x00), 0);
    }
}
