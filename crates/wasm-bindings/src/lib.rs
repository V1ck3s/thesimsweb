//! Thin wasm-bindgen layer that re-exports the parser crates to TypeScript.
//! Built with `wasm-pack build --target web crates/wasm-bindings`.

use js_sys::{Array, Object, Reflect, Uint8Array};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
#[must_use]
pub fn engine_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[wasm_bindgen(js_name = checkFarMagic)]
#[must_use]
pub fn check_far_magic(data: &[u8]) -> bool {
    far::check_magic(data).is_ok()
}

/// Parse a FAR v1 manifest. Returns an array of plain JS objects:
/// `{ filename: string, sizeDecompressed: number, sizeCompressed: number, offset: number }`.
///
/// Filenames are decoded as UTF-8 lossy (Maxis archives are ASCII; non-ASCII bytes become U+FFFD).
///
/// # Errors
/// Returns a `JsError` if the buffer is not a valid FAR v1 archive.
#[wasm_bindgen(js_name = parseFarManifest)]
pub fn parse_far_manifest(data: &[u8]) -> Result<Array, JsError> {
    let archive = far::Far::parse(data).map_err(|e| JsError::new(&e.to_string()))?;
    let array = Array::new_with_length(archive.entry_count());
    for (i, entry) in archive.entries().enumerate() {
        let entry = entry.map_err(|e| JsError::new(&e.to_string()))?;
        let obj = Object::new();
        let filename = String::from_utf8_lossy(entry.filename);
        Reflect::set(&obj, &JsValue::from_str("filename"), &JsValue::from_str(&filename))
            .map_err(|_| JsError::new("set filename"))?;
        Reflect::set(&obj, &JsValue::from_str("sizeDecompressed"), &JsValue::from_f64(f64::from(entry.size_decompressed)))
            .map_err(|_| JsError::new("set sizeDecompressed"))?;
        Reflect::set(&obj, &JsValue::from_str("sizeCompressed"), &JsValue::from_f64(f64::from(entry.size_compressed)))
            .map_err(|_| JsError::new("set sizeCompressed"))?;
        Reflect::set(&obj, &JsValue::from_str("offset"), &JsValue::from_f64(f64::from(entry.offset)))
            .map_err(|_| JsError::new("set offset"))?;
        #[allow(clippy::cast_possible_truncation)]
        array.set(i as u32, obj.into());
    }
    Ok(array)
}

/// Extract the payload bytes for one entry. Caller passes the same buffer they parsed the
/// manifest from, plus the index they want.
///
/// # Errors
/// Returns a `JsError` if the buffer is malformed or the index is out of range.
#[wasm_bindgen(js_name = extractFarEntry)]
pub fn extract_far_entry(data: &[u8], index: u32) -> Result<Uint8Array, JsError> {
    let archive = far::Far::parse(data).map_err(|e| JsError::new(&e.to_string()))?;
    if index >= archive.entry_count() {
        return Err(JsError::new("entry index out of range"));
    }
    let entry = archive
        .entries()
        .nth(index as usize)
        .ok_or_else(|| JsError::new("entry index out of range"))?
        .map_err(|e| JsError::new(&e.to_string()))?;
    let payload = archive.payload(&entry).map_err(|e| JsError::new(&e.to_string()))?;
    Ok(Uint8Array::from(payload))
}

/// Returns the IFF version string (`"2.0"` or `"2.5"`).
///
/// # Errors
/// Returns a `JsError` if the header is too short or has an unknown magic.
#[wasm_bindgen(js_name = parseIffHeader)]
pub fn parse_iff_header(data: &[u8]) -> Result<JsValue, JsError> {
    let header = iff::parse_header(data).map_err(|e| JsError::new(&e.to_string()))?;
    let version = match header.version {
        iff::IffVersion::V2_0 => "2.0",
        iff::IffVersion::V2_5 => "2.5",
    };
    Ok(JsValue::from_str(version))
}

/// Enumerate IFF chunks. Returns an array of plain JS objects:
/// `{ kind: string, size: number, id: number, flags: number, offset: number, dataStart: number, dataLen: number }`.
///
/// `kind` is the 4-byte chunk type as a UTF-8 lossy string. `dataStart` is the absolute byte
/// offset of the chunk payload in the input buffer; `dataLen` is the payload length. The
/// caller can extract the payload as `data.subarray(dataStart, dataStart + dataLen)`.
///
/// # Errors
/// Returns a `JsError` if the buffer is not a valid IFF file or any chunk header is malformed.
#[wasm_bindgen(js_name = parseIffChunks)]
pub fn parse_iff_chunks(data: &[u8]) -> Result<Array, JsError> {
    let iff_file = iff::Iff::parse(data).map_err(|e| JsError::new(&e.to_string()))?;
    let array = Array::new();
    for chunk in iff_file.chunks() {
        let chunk = chunk.map_err(|e| JsError::new(&e.to_string()))?;
        let obj = Object::new();
        let kind = core::str::from_utf8(&chunk.kind).unwrap_or("????");
        let data_start = chunk.offset + iff::CHUNK_HEADER_LEN;
        let data_len = chunk.data.len();
        Reflect::set(&obj, &JsValue::from_str("kind"), &JsValue::from_str(kind))
            .map_err(|_| JsError::new("set kind"))?;
        Reflect::set(&obj, &JsValue::from_str("size"), &JsValue::from_f64(f64::from(chunk.size)))
            .map_err(|_| JsError::new("set size"))?;
        Reflect::set(&obj, &JsValue::from_str("id"), &JsValue::from_f64(f64::from(chunk.id)))
            .map_err(|_| JsError::new("set id"))?;
        Reflect::set(&obj, &JsValue::from_str("flags"), &JsValue::from_f64(f64::from(chunk.flags)))
            .map_err(|_| JsError::new("set flags"))?;
        #[allow(clippy::cast_precision_loss)]
        let offset_f = chunk.offset as f64;
        #[allow(clippy::cast_precision_loss)]
        let data_start_f = data_start as f64;
        #[allow(clippy::cast_precision_loss)]
        let data_len_f = data_len as f64;
        Reflect::set(&obj, &JsValue::from_str("offset"), &JsValue::from_f64(offset_f))
            .map_err(|_| JsError::new("set offset"))?;
        Reflect::set(&obj, &JsValue::from_str("dataStart"), &JsValue::from_f64(data_start_f))
            .map_err(|_| JsError::new("set dataStart"))?;
        Reflect::set(&obj, &JsValue::from_str("dataLen"), &JsValue::from_f64(data_len_f))
            .map_err(|_| JsError::new("set dataLen"))?;
        array.push(&obj);
    }
    Ok(array)
}
