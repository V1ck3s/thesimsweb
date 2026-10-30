//! Audio decoders for The Sims (Maxis) — currently Maxis XA (EA-XA ADPCM).
//!
//! `XA` is a Maxis container around the EA-XA 4-predictor ADPCM codec. Layout
//! (a `WAVEFORMATEX` after the output size):
//!
//! ```text
//! Offset  Size  Field
//! ------  ----  --------------------------------------------------------
//! 0x00    4     magic: "XA" + 2 tag bytes ("XA\0\0", "XAJ\0", "XA\x12\0", "XAI\0")
//! 0x04    4     pcm_size_bytes (decompressed size in bytes)
//! 0x08    2     wFormatTag (1 = PCM)
//! 0x0A    2     nChannels (1 = mono, 2 = stereo)
//! 0x0C    4     nSamplesPerSec
//! 0x10    4     nAvgBytesPerSec
//! 0x14    2     nBlockAlign
//! 0x16    2     wBitsPerSample (always 16)
//! 0x18    …     ADPCM blocks of 15 × channels bytes, 28 samples per channel
//! ```
//!
//! Each block starts with one header byte per channel (high nibble =
//! predictor index into the coefficient table, low nibble = shift), followed
//! by 14 rows of one byte per channel. Each byte holds two samples, the
//! **high nibble first**:
//!
//! ```text
//! sample = ((nibble << (20 - shift)) + c1 * prev1 + c2 * prev2 + 0x80) >> 8
//! sample = clamp(sample, -32768, 32767)
//! ```
//!
//! This matches `ffmpeg -c:a adpcm_ea_maxis_xa` sample for sample (checked
//! on the game's own files, see `docs/decomp/audio-port.md`).

#![no_std]

extern crate alloc;

use alloc::vec::Vec;
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AudioError {
    #[error("XA file too short: need at least {need} bytes, got {got}")]
    XaTooShort { need: usize, got: usize },
    #[error("XA bad magic (want \"XA\" + 2 tag bytes)")]
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
        // The tag bytes after "XA" vary ("\0\0", "J\0", "\x12\0", "I\0") and
        // do not change the layout.
        if &magic[..2] != b"XA" {
            return Err(AudioError::XaBadMagic);
        }
        let pcm_size_bytes = u32_le(data, 4);
        // 0x08 is wFormatTag; the channel count is the WAVEFORMATEX nChannels.
        let channels = u16_le(data, 0x0A);
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
        let mut samples = decode_blocks(body, usize::from(header.channels));
        // The last block is padded to 28 samples; keep the declared length
        // (it matters for looped samples).
        let declared = (header.pcm_size_bytes / 2) as usize;
        if declared > 0 && declared < samples.len() {
            samples.truncate(declared);
        }
        Ok(DecodedPcm {
            sample_rate: header.sample_rate,
            channels: header.channels,
            samples,
        })
    }
}

/// EA-XA predictor coefficients: `c1 = TABLE[p]`, `c2 = TABLE[p + 4]`
/// (fixed point, divisor 256).
const COEF: [i32; 8] = [0, 240, 460, 392, 0, 0, -208, -220];

/// Decode interleaved EA-XA blocks (15 × `channels` bytes each) into
/// interleaved 16-bit PCM.
fn decode_blocks(body: &[u8], channels: usize) -> Vec<i16> {
    let block_len = 15 * channels;
    let mut out = Vec::with_capacity(body.len() / 15 * 28);
    let mut prev1 = [0i32; 2];
    let mut prev2 = [0i32; 2];
    let mut c1 = [0i32; 2];
    let mut c2 = [0i32; 2];
    let mut shift = [0u32; 2];
    for block in body.chunks_exact(block_len) {
        for ch in 0..channels {
            let h = block[ch];
            let p = usize::from(h >> 4) & 3;
            c1[ch] = COEF[p];
            c2[ch] = COEF[p + 4];
            shift[ch] = 20 - u32::from(h & 0x0F);
        }
        for row in block[channels..].chunks_exact(channels) {
            for nibble_shift in [4u8, 0] {
                for (ch, &byte) in row.iter().enumerate() {
                    let n = i32::from(sign_extend4(byte >> nibble_shift));
                    let s = ((n << shift[ch]) + c1[ch] * prev1[ch] + c2[ch] * prev2[ch] + 0x80) >> 8;
                    let s = s.clamp(i32::from(i16::MIN), i32::from(i16::MAX));
                    prev2[ch] = prev1[ch];
                    prev1[ch] = s;
                    #[allow(clippy::cast_possible_truncation)]
                    out.push(s as i16);
                }
            }
        }
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
        xa.push(0x1C); // predictor=1, shift=12
        xa.extend_from_slice(&[0x11u8; 14]); // all nibbles = 1

        let pcm = Xa::decode(&xa).unwrap();
        assert_eq!(pcm.samples.len(), 28);
        // First sample: ((1 << 8) + 0 + 0x80) >> 8 = 1
        assert_eq!(pcm.samples[0], 1);
        // Second: ((1 << 8) + 240 * 1 + 0x80) >> 8 = 2
        assert_eq!(pcm.samples[1], 2);
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
    fn xa_high_nibble_first() {
        // predictor 0, shift 0 (<< 20): nibble 7 -> 0x70000 >> 8 = 28672,
        // nibble -8 -> -32768. Byte 0x78: 28672 then -32768.
        let mut xa = build_silent_xa(1);
        xa[0x18] = 0x00;
        xa[0x19] = 0x78;
        let pcm = Xa::decode(&xa).unwrap();
        assert_eq!(pcm.samples[0], 28672);
        assert_eq!(pcm.samples[1], -32768);
    }

    #[test]
    fn xa_stereo_interleaves_per_byte() {
        let mut xa = build_silent_xa(2);
        xa[0x0A] = 2; // nChannels
        xa[0x18] = 0x00; // left header
        xa[0x19] = 0x00; // right header
        xa[0x1A] = 0x10; // left row 0: 1, 0
        xa[0x1B] = 0x20; // right row 0: 2, 0
        let pcm = Xa::decode(&xa).unwrap();
        assert_eq!(pcm.channels, 2);
        assert_eq!(&pcm.samples[..4], &[4096, 8192, 0, 0]);
    }

    #[test]
    fn sign_extend4_handles_negative() {
        assert_eq!(sign_extend4(0x0F), -1);
        assert_eq!(sign_extend4(0x08), -8);
        assert_eq!(sign_extend4(0x07), 7);
        assert_eq!(sign_extend4(0x00), 0);
    }
}
