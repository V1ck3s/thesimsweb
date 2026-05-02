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
/// `{ kind, size, id, flags, label, offset, dataStart, dataLen }`.
///
/// `kind` is the 4-byte chunk type as a UTF-8 lossy string. `label` is the 64-byte chunk
/// label (commonly the human-readable name) trimmed at the first null byte, decoded
/// lossily as UTF-8. `dataStart` is the absolute byte offset of the chunk payload in the
/// input buffer; `dataLen` is the payload length.
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
        let label_end = chunk.label.iter().position(|&b| b == 0).unwrap_or(chunk.label.len());
        let label = String::from_utf8_lossy(&chunk.label[..label_end]);
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
        Reflect::set(&obj, &JsValue::from_str("label"), &JsValue::from_str(&label))
            .map_err(|_| JsError::new("set label"))?;
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

/// Decode an SPR2 frame to RGBA8.
///
/// Inputs:
/// - `spr2_data`: the **chunk data** (post 76-byte IFF header) of an SPR2 chunk.
/// - `palt_data`: the **chunk data** of the PALT chunk it references.
/// - `frame_index`: which frame in the SPR2 chunk to decode.
///
/// Returns a JS object: `{ width, height, rgba: Uint8Array }`.
///
/// # Errors
/// Returns a `JsError` if either chunk is malformed, the frame index is out of range,
/// or the RLE stream is invalid.
#[wasm_bindgen(js_name = decodeSpr2Frame)]
pub fn decode_spr2_frame(
    spr2_data: &[u8],
    palt_data: &[u8],
    frame_index: u32,
) -> Result<Object, JsError> {
    let palt = sprite::Palette::parse(palt_data).map_err(|e| JsError::new(&e.to_string()))?;
    let spr2 = sprite::Spr2::parse(spr2_data).map_err(|e| JsError::new(&e.to_string()))?;
    let frame = spr2
        .decode_frame(frame_index, &palt)
        .map_err(|e| JsError::new(&e.to_string()))?;
    let obj = Object::new();
    Reflect::set(&obj, &JsValue::from_str("width"), &JsValue::from_f64(f64::from(frame.width)))
        .map_err(|_| JsError::new("set width"))?;
    Reflect::set(&obj, &JsValue::from_str("height"), &JsValue::from_f64(f64::from(frame.height)))
        .map_err(|_| JsError::new("set height"))?;
    Reflect::set(&obj, &JsValue::from_str("rgba"), &Uint8Array::from(frame.rgba.as_slice()).into())
        .map_err(|_| JsError::new("set rgba"))?;
    Ok(obj)
}

/// Parse a BHAV chunk's data payload into a JS object:
/// `{ magic, count, kind, args, locals, flags, extra, instructions: [{ opcode, tDest, fDest, operand: Uint8Array }] }`.
///
/// `magic` is one of `0x8000`, `0x8001`, `0x8002`, `0x8003`. `tDest`/`fDest` are
/// 0-based indices into `instructions`, or one of the sentinel values `0xFD` (return
/// error), `0xFE` (return false), `0xFF` (return true).
///
/// # Errors
/// Returns a `JsError` if the buffer doesn't decode as a valid BHAV.
#[wasm_bindgen(js_name = parseBhav)]
pub fn parse_bhav(data: &[u8]) -> Result<Object, JsError> {
    let bhav = simantics::Bhav::parse(data).map_err(|e| JsError::new(&e.to_string()))?;
    let obj = Object::new();
    set_f64(&obj, "magic", f64::from(bhav.header.magic.raw()))?;
    set_f64(&obj, "count", f64::from(bhav.header.count))?;
    set_f64(&obj, "kind", f64::from(bhav.header.kind))?;
    set_f64(&obj, "args", f64::from(bhav.header.args))?;
    set_f64(&obj, "locals", f64::from(bhav.header.locals))?;
    set_f64(&obj, "flags", f64::from(bhav.header.flags))?;
    set_f64(&obj, "extra", f64::from(bhav.header.extra))?;
    let instructions = Array::new();
    for instr in &bhav.instructions {
        let i = Object::new();
        set_f64(&i, "opcode", f64::from(instr.opcode))?;
        set_f64(&i, "tDest", f64::from(instr.t_dest))?;
        set_f64(&i, "fDest", f64::from(instr.f_dest))?;
        Reflect::set(&i, &JsValue::from_str("operand"), &Uint8Array::from(&instr.operand[..]).into())
            .map_err(|_| JsError::new("set operand"))?;
        instructions.push(&i);
    }
    Reflect::set(&obj, &JsValue::from_str("instructions"), &instructions.into())
        .map_err(|_| JsError::new("set instructions"))?;
    Ok(obj)
}

/// Parse a BCON chunk's data payload into `{ flags, constants: number[] }`.
///
/// # Errors
/// Returns a `JsError` if the buffer is malformed.
#[wasm_bindgen(js_name = parseBcon)]
pub fn parse_bcon(data: &[u8]) -> Result<Object, JsError> {
    let bcon = simantics::Bcon::parse(data).map_err(|e| JsError::new(&e.to_string()))?;
    let obj = Object::new();
    set_f64(&obj, "flags", f64::from(bcon.flags))?;
    let constants = Array::new();
    for c in &bcon.constants {
        constants.push(&JsValue::from_f64(f64::from(*c)));
    }
    Reflect::set(&obj, &JsValue::from_str("constants"), &constants.into())
        .map_err(|_| JsError::new("set constants"))?;
    Ok(obj)
}

/// Parse a STR# (or TTAs) chunk's data payload into
/// `{ version: number, entries: Array<{kind, langCode?, data, comment?}> }`.
///
/// `data` and `comment` are exposed as `Uint8Array` — the caller decides which Windows-*
/// code page to decode with based on `langCode`.
///
/// # Errors
/// Returns a `JsError` if the buffer is malformed or the version is unsupported.
#[wasm_bindgen(js_name = parseStrTable)]
pub fn parse_str_table(data: &[u8]) -> Result<Object, JsError> {
    let table = simantics::StrTable::parse(data).map_err(|e| JsError::new(&e.to_string()))?;
    let obj = Object::new();
    set_f64(&obj, "version", f64::from(table.version))?;
    let entries = Array::new();
    for e in &table.entries {
        let entry_obj = Object::new();
        match e {
            simantics::StrEntry::Single { data } => {
                Reflect::set(&entry_obj, &JsValue::from_str("kind"), &JsValue::from_str("single"))
                    .map_err(|_| JsError::new("set kind"))?;
                Reflect::set(
                    &entry_obj,
                    &JsValue::from_str("data"),
                    &Uint8Array::from(&data[..]).into(),
                )
                .map_err(|_| JsError::new("set data"))?;
            }
            simantics::StrEntry::Pair { data, comment } => {
                Reflect::set(&entry_obj, &JsValue::from_str("kind"), &JsValue::from_str("pair"))
                    .map_err(|_| JsError::new("set kind"))?;
                Reflect::set(
                    &entry_obj,
                    &JsValue::from_str("data"),
                    &Uint8Array::from(&data[..]).into(),
                )
                .map_err(|_| JsError::new("set data"))?;
                Reflect::set(
                    &entry_obj,
                    &JsValue::from_str("comment"),
                    &Uint8Array::from(&comment[..]).into(),
                )
                .map_err(|_| JsError::new("set comment"))?;
            }
            simantics::StrEntry::PairWithLang {
                lang_code,
                data,
                comment,
            } => {
                Reflect::set(&entry_obj, &JsValue::from_str("kind"), &JsValue::from_str("lang"))
                    .map_err(|_| JsError::new("set kind"))?;
                set_f64(&entry_obj, "langCode", f64::from(*lang_code))?;
                Reflect::set(
                    &entry_obj,
                    &JsValue::from_str("data"),
                    &Uint8Array::from(&data[..]).into(),
                )
                .map_err(|_| JsError::new("set data"))?;
                Reflect::set(
                    &entry_obj,
                    &JsValue::from_str("comment"),
                    &Uint8Array::from(&comment[..]).into(),
                )
                .map_err(|_| JsError::new("set comment"))?;
            }
        }
        entries.push(&entry_obj);
    }
    Reflect::set(&obj, &JsValue::from_str("entries"), &entries.into())
        .map_err(|_| JsError::new("set entries"))?;
    Ok(obj)
}

/// Parse a TRCN chunk's data payload into
/// `{ version, entries: Array<{isUsed, default, name, comment, range?: {enforced, min, max}}> }`.
///
/// # Errors
/// Returns a `JsError` if the buffer is malformed or the version is unsupported.
#[wasm_bindgen(js_name = parseTrcn)]
pub fn parse_trcn(data: &[u8]) -> Result<Object, JsError> {
    let trcn = simantics::Trcn::parse(data).map_err(|e| JsError::new(&e.to_string()))?;
    let obj = Object::new();
    set_f64(&obj, "version", f64::from(trcn.version))?;
    let entries = Array::new();
    for e in &trcn.entries {
        let entry_obj = Object::new();
        set_f64(&entry_obj, "isUsed", f64::from(e.is_used))?;
        set_f64(&entry_obj, "default", f64::from(e.default))?;
        Reflect::set(
            &entry_obj,
            &JsValue::from_str("name"),
            &Uint8Array::from(&e.name[..]).into(),
        )
        .map_err(|_| JsError::new("set name"))?;
        Reflect::set(
            &entry_obj,
            &JsValue::from_str("comment"),
            &Uint8Array::from(&e.comment[..]).into(),
        )
        .map_err(|_| JsError::new("set comment"))?;
        if let Some((enforced, min, max)) = e.range {
            let range_obj = Object::new();
            set_f64(&range_obj, "enforced", f64::from(enforced))?;
            set_f64(&range_obj, "min", f64::from(min))?;
            set_f64(&range_obj, "max", f64::from(max))?;
            Reflect::set(&entry_obj, &JsValue::from_str("range"), &range_obj.into())
                .map_err(|_| JsError::new("set range"))?;
        }
        entries.push(&entry_obj);
    }
    Reflect::set(&obj, &JsValue::from_str("entries"), &entries.into())
        .map_err(|_| JsError::new("set entries"))?;
    Ok(obj)
}

/// Parse an OBJD chunk's data payload into `{ version, fields: number[], guid }`.
///
/// `fields` is the raw u16 array; named accessors live on the JS side. The 32-bit `guid`
/// is pre-assembled from `fields[12]` (lo) and `fields[13]` (hi).
///
/// # Errors
/// Returns a `JsError` if the buffer is malformed.
#[wasm_bindgen(js_name = parseObjd)]
pub fn parse_objd(data: &[u8]) -> Result<Object, JsError> {
    let objd = simantics::Objd::parse(data).map_err(|e| JsError::new(&e.to_string()))?;
    let obj = Object::new();
    set_f64(&obj, "version", f64::from(objd.version))?;
    set_f64(&obj, "guid", f64::from(objd.guid()))?;
    let fields = Array::new();
    for f in &objd.fields {
        fields.push(&JsValue::from_f64(f64::from(*f)));
    }
    Reflect::set(&obj, &JsValue::from_str("fields"), &fields.into())
        .map_err(|_| JsError::new("set fields"))?;
    Ok(obj)
}

/// Parse an `OBJf` chunk's data payload.
///
/// Returns `{ version, entries: Array<{ condition, action }> }`. Each entry's
/// position in the array is the event index — the meaning is defined by
/// `behavior.iff` chunk `0x00F5` (typically 0 = Init, 1 = Main, …).
///
/// # Errors
/// Returns a `JsError` if the buffer is malformed or the version is unsupported.
#[wasm_bindgen(js_name = parseObjf)]
pub fn parse_objf(data: &[u8]) -> Result<Object, JsError> {
    let objf = simantics::Objf::parse(data).map_err(|e| JsError::new(&e.to_string()))?;
    let obj = Object::new();
    set_f64(&obj, "version", f64::from(objf.version))?;
    let entries = Array::new();
    for e in &objf.entries {
        let row = Object::new();
        set_f64(&row, "condition", f64::from(e.condition))?;
        set_f64(&row, "action", f64::from(e.action))?;
        entries.push(&row);
    }
    Reflect::set(&obj, &JsValue::from_str("entries"), &entries.into())
        .map_err(|_| JsError::new("set entries"))?;
    Ok(obj)
}

/// Parse a `DGRP` (Drawing Group) chunk's data payload.
///
/// Returns `{ version, images: Array<{ directionFlags, zoomLevel, sprites:
/// Array<{ sprChunkId, sprFrameNumber, spriteXOffset, spriteYOffset,
/// objectZOffset, flags, objectXOffset, objectYOffset }> }> }`. Each image
/// is one (direction, zoom) view; sprite refs point at SPR2 chunks in the
/// same IFF.
///
/// # Errors
/// Returns a `JsError` if the buffer is malformed or the version is
/// unsupported (v20000/v20001 are TSO-only and not parsed yet).
#[wasm_bindgen(js_name = parseDgrp)]
pub fn parse_dgrp(data: &[u8]) -> Result<Object, JsError> {
    let dgrp = simantics::Dgrp::parse(data).map_err(|e| JsError::new(&e.to_string()))?;
    let obj = Object::new();
    set_f64(&obj, "version", f64::from(dgrp.version))?;
    let images = Array::new();
    for img in &dgrp.images {
        let row = Object::new();
        set_f64(&row, "directionFlags", f64::from(img.direction_flags))?;
        set_f64(&row, "zoomLevel", f64::from(img.zoom_level))?;
        let sprites = Array::new();
        for sp in &img.sprites {
            let s = Object::new();
            set_f64(&s, "sprChunkId", f64::from(sp.spr_chunk_id))?;
            set_f64(&s, "sprFrameNumber", f64::from(sp.spr_frame_number))?;
            set_f64(&s, "spriteXOffset", f64::from(sp.sprite_x_offset))?;
            set_f64(&s, "spriteYOffset", f64::from(sp.sprite_y_offset))?;
            set_f64(&s, "objectZOffset", f64::from(sp.object_z_offset))?;
            set_f64(&s, "flags", f64::from(sp.flags))?;
            set_f64(&s, "objectXOffset", f64::from(sp.object_x_offset))?;
            set_f64(&s, "objectYOffset", f64::from(sp.object_y_offset))?;
            sprites.push(&s);
        }
        Reflect::set(&row, &JsValue::from_str("sprites"), &sprites.into())
            .map_err(|_| JsError::new("set sprites"))?;
        images.push(&row);
    }
    Reflect::set(&obj, &JsValue::from_str("images"), &images.into())
        .map_err(|_| JsError::new("set images"))?;
    Ok(obj)
}

/// Parse a `GLOB` chunk's data payload.
///
/// Returns `{ semiGlobalName }` — the filename (without `.iff` extension) of
/// the semi-global IFF the object's sub-calls in `0x0100..=0x0FFF` resolve to.
///
/// # Errors
/// Returns a `JsError` for an empty chunk.
#[wasm_bindgen(js_name = parseGlob)]
pub fn parse_glob(data: &[u8]) -> Result<Object, JsError> {
    let glob = simantics::Glob::parse(data).map_err(|e| JsError::new(&e.to_string()))?;
    let obj = Object::new();
    Reflect::set(
        &obj,
        &JsValue::from_str("semiGlobalName"),
        &JsValue::from_str(&glob.semi_global_name),
    )
    .map_err(|_| JsError::new("set semiGlobalName"))?;
    Ok(obj)
}

/// Look up the human-readable name of a `SimAntics` primitive opcode.
/// Returns `null` (an empty `JsValue`) for opcodes outside the documented `0..=67` range.
#[wasm_bindgen(js_name = primitiveName)]
#[must_use]
pub fn primitive_name(opcode: u16) -> JsValue {
    simantics::primitive_name(opcode).map_or(JsValue::NULL, JsValue::from_str)
}

/// Look up the human-readable name of a `SimAntics` variable scope.
/// Returns `null` for scopes outside the documented `0..=37` range.
#[wasm_bindgen(js_name = scopeName)]
#[must_use]
pub fn scope_name(scope: u16) -> JsValue {
    simantics::scope_name(scope).map_or(JsValue::NULL, JsValue::from_str)
}

/// Render a primitive's 8-byte operand in human-readable form.
///
/// Examples: `"ticks=20"` for Sleep, `"stack objects attributes[5] = literal(1)"`
/// for Expression. Returns `null` for opcodes whose operand layout is not yet
/// decoded — callers fall back to raw hex.
#[wasm_bindgen(js_name = formatPrimitiveOperand)]
#[must_use]
pub fn format_primitive_operand(opcode: u16, operand: &[u8]) -> JsValue {
    let mut bytes = [0u8; 8];
    if operand.len() < 8 {
        return JsValue::NULL;
    }
    bytes.copy_from_slice(&operand[..8]);
    simantics::vm::format_primitive_operand(opcode, bytes)
        .map_or(JsValue::NULL, |s| JsValue::from_str(&s))
}

/// Classify a BHAV `opcode`: returns one of `"primitive"`, `"semiglobal"`, `"private"`, `"global"`.
#[wasm_bindgen(js_name = classifyOpcode)]
#[must_use]
pub fn classify_opcode(opcode: u16) -> JsValue {
    let kind = match simantics::classify_opcode(opcode) {
        simantics::InstructionKind::Primitive => "primitive",
        simantics::InstructionKind::SemiGlobal => "semiglobal",
        simantics::InstructionKind::Private => "private",
        simantics::InstructionKind::Global => "global",
    };
    JsValue::from_str(kind)
}

/// Parse a TTAB chunk's data payload.
///
/// Returns `{ version, interactions: Array<{ actionFunction, guardFunction,
/// motiveEntryCount, flags, ttasIndex, attenuationCode, attenuationValue,
/// autonomyThreshold, joiningIndex, motives: Array<{effectMin, effectMax,
/// personalityModifier}> }> }`.
///
/// # Errors
/// Returns a `JsError` if the buffer is malformed or the version is unsupported (v9+
/// uses field encoding compression, not yet implemented).
#[wasm_bindgen(js_name = parseTtab)]
pub fn parse_ttab(data: &[u8]) -> Result<Object, JsError> {
    let ttab = simantics::Ttab::parse(data).map_err(|e| JsError::new(&e.to_string()))?;
    let obj = Object::new();
    set_f64(&obj, "version", f64::from(ttab.version))?;
    let interactions = Array::new();
    for i in &ttab.interactions {
        let inter = Object::new();
        set_f64(&inter, "actionFunction", f64::from(i.action_function))?;
        set_f64(&inter, "guardFunction", f64::from(i.guard_function))?;
        set_f64(&inter, "motiveEntryCount", f64::from(i.motive_entry_count))?;
        set_f64(&inter, "flags", f64::from(i.flags))?;
        set_f64(&inter, "ttasIndex", f64::from(i.ttas_index))?;
        set_f64(&inter, "attenuationCode", f64::from(i.attenuation_code))?;
        set_f64(&inter, "attenuationValue", f64::from(i.attenuation_value))?;
        set_f64(&inter, "autonomyThreshold", f64::from(i.autonomy_threshold))?;
        set_f64(&inter, "joiningIndex", f64::from(i.joining_index))?;
        let motives = Array::new();
        for m in &i.motives {
            let mo = Object::new();
            set_f64(&mo, "effectMin", f64::from(m.effect_min))?;
            set_f64(&mo, "effectMax", f64::from(m.effect_max))?;
            set_f64(&mo, "personalityModifier", f64::from(m.personality_modifier))?;
            motives.push(&mo);
        }
        Reflect::set(&inter, &JsValue::from_str("motives"), &motives.into())
            .map_err(|_| JsError::new("set motives"))?;
        interactions.push(&inter);
    }
    Reflect::set(&obj, &JsValue::from_str("interactions"), &interactions.into())
        .map_err(|_| JsError::new("set interactions"))?;
    Ok(obj)
}

fn set_f64(obj: &Object, key: &str, value: f64) -> Result<(), JsError> {
    Reflect::set(obj, &JsValue::from_str(key), &JsValue::from_f64(value))
        .map_err(|_| JsError::new("set"))?;
    Ok(())
}

/// Run an `OBJf` event handler through the `SimAntics` VM.
///
/// Mirrors `crates/simantics/examples/run_object.rs`: parses both IFFs, builds a
/// `LayeredBhavSource` (object IFF → private, globals IFF → semi-global), parses
/// the `OBJf` table, looks up the requested event, pushes the action onto the
/// interaction queue, and ticks. With `max_ticks=1` only the user's action runs
/// (single tick); with `max_ticks>1` the scheduler keeps draining until the
/// queue is empty or the cap is hit (run-until-idle). Returns
/// `{ outcome, actionId, exec, ticksRan, trace, effects }`. Effects are
/// returned as their `Debug` representation to keep the binding compact.
///
/// `globals_iff` may be empty (`new Uint8Array()`); semi-global sub-calls then
/// bail out cleanly with `BhavNotFound`.
///
/// # Errors
/// Returns a `JsError` if either IFF is malformed, `OBJf` is missing, the event
/// has no handler, or the VM step-budget is exhausted.
#[allow(clippy::too_many_lines)]
#[wasm_bindgen(js_name = runObjectEvent)]
pub fn run_object_event(
    object_iff: &[u8],
    globals_iff: &[u8],
    event: u32,
    max_ticks: u32,
) -> Result<Object, JsError> {
    let object_parsed = iff::Iff::parse(object_iff).map_err(|e| JsError::new(&e.to_string()))?;
    let mut source = simantics::vm::LayeredBhavSource::default();
    for chunk in object_parsed.chunks() {
        let chunk = chunk.map_err(|e| JsError::new(&e.to_string()))?;
        if &chunk.kind == b"BHAV" {
            source.private.insert(chunk.id, chunk.data.to_vec());
        }
    }
    if !globals_iff.is_empty() {
        let globals_parsed = iff::Iff::parse(globals_iff).map_err(|e| JsError::new(&e.to_string()))?;
        for chunk in globals_parsed.chunks() {
            let chunk = chunk.map_err(|e| JsError::new(&e.to_string()))?;
            if &chunk.kind == b"BHAV" {
                source.semi_global.insert(chunk.id, chunk.data.to_vec());
            }
        }
    }
    let mut objf_data: Option<&[u8]> = None;
    for chunk in object_parsed.chunks() {
        let chunk = chunk.map_err(|e| JsError::new(&e.to_string()))?;
        if &chunk.kind == b"OBJf" {
            objf_data = Some(chunk.data);
            break;
        }
    }
    let objf_data = objf_data.ok_or_else(|| JsError::new("no OBJf chunk in object IFF"))?;
    let objf = simantics::Objf::parse(objf_data).map_err(|e| JsError::new(&e.to_string()))?;
    let entry = objf
        .dispatch(event as usize)
        .ok_or_else(|| JsError::new("OBJf event has no handler (or pair is (0,0))"))?;

    let mut vm = simantics::vm::Vm::new(&source);
    vm.trace_enabled = true;
    vm.world.interaction_queue.push(simantics::vm::PendingInteraction {
        sim_id: 0xAA,
        stack_object_id: 0xBB,
        action_function: entry.action,
        joining_index: if entry.condition == 0 {
            -1
        } else {
            i32::from(entry.condition)
        },
    });
    // Tick once for the headline outcome (action_id, exec). If max_ticks > 1, drain
    // the rest of the queue via run_until_idle.
    let first = vm.tick().map_err(|e| JsError::new(&e.to_string()))?;
    let mut ticks_ran: u32 = match &first {
        simantics::vm::TickOutcome::Idle => 0,
        _ => 1,
    };
    if max_ticks > 1 {
        let extra = vm
            .run_until_idle((max_ticks - 1) as usize)
            .map_err(|e| JsError::new(&e.to_string()))?;
        ticks_ran += u32::try_from(extra).unwrap_or(u32::MAX);
    }

    let result = Object::new();
    let (outcome_str, action_id, exec_str) = match &first {
        simantics::vm::TickOutcome::Idle => ("idle", 0u16, String::new()),
        simantics::vm::TickOutcome::Skipped(p) => ("skipped", p.action_function, String::new()),
        simantics::vm::TickOutcome::Ran(p, exec) => {
            let s = match exec {
                simantics::vm::ExecResult::Returned(true) => "returned_true".to_string(),
                simantics::vm::ExecResult::Returned(false) => "returned_false".to_string(),
                simantics::vm::ExecResult::Error => "ret_error".to_string(),
                simantics::vm::ExecResult::BudgetExhausted => "budget_exhausted".to_string(),
            };
            ("ran", p.action_function, s)
        }
    };
    Reflect::set(&result, &JsValue::from_str("outcome"), &JsValue::from_str(outcome_str))
        .map_err(|_| JsError::new("set outcome"))?;
    set_f64(&result, "actionId", f64::from(action_id))?;
    Reflect::set(&result, &JsValue::from_str("exec"), &JsValue::from_str(&exec_str))
        .map_err(|_| JsError::new("set exec"))?;
    set_f64(&result, "ticksRan", f64::from(ticks_ran))?;

    // Cache parsed BHAVs by id so we can look up the operand for each trace entry
    // without re-parsing for every step. Avoids O(N²) on long traces.
    let mut bhav_cache: std::collections::BTreeMap<u16, simantics::Bhav> =
        std::collections::BTreeMap::new();
    let mut lookup_operand = |bhav_id: u16, ip: u16| -> Option<[u8; 8]> {
        if let std::collections::btree_map::Entry::Vacant(slot) = bhav_cache.entry(bhav_id) {
            let bytes = source
                .private
                .get(&bhav_id)
                .or_else(|| source.semi_global.get(&bhav_id))
                .or_else(|| source.global.get(&bhav_id))?;
            slot.insert(simantics::Bhav::parse(bytes).ok()?);
        }
        let bhav = bhav_cache.get(&bhav_id)?;
        let instr = bhav.instructions.get(ip as usize)?;
        Some(instr.operand)
    };

    let trace = Array::new();
    for entry in &vm.trace {
        let e = Object::new();
        #[allow(clippy::cast_precision_loss)]
        let depth_f = entry.depth as f64;
        set_f64(&e, "depth", depth_f)?;
        set_f64(&e, "bhavId", f64::from(entry.bhav_id))?;
        set_f64(&e, "ip", f64::from(entry.ip))?;
        set_f64(&e, "opcode", f64::from(entry.opcode))?;
        let branch = match entry.branch_taken {
            simantics::vm::TraceBranch::Continue(ip) => format!("→{ip}"),
            simantics::vm::TraceBranch::Returned(true) => "ret_true".to_string(),
            simantics::vm::TraceBranch::Returned(false) => "ret_false".to_string(),
            simantics::vm::TraceBranch::Error => "ret_error".to_string(),
        };
        Reflect::set(&e, &JsValue::from_str("branch"), &JsValue::from_str(&branch))
            .map_err(|_| JsError::new("set branch"))?;
        if let Some(operand) = lookup_operand(entry.bhav_id, entry.ip) {
            if let Some(decoded) = simantics::vm::format_primitive_operand(entry.opcode, operand) {
                Reflect::set(&e, &JsValue::from_str("operand"), &JsValue::from_str(&decoded))
                    .map_err(|_| JsError::new("set operand"))?;
            }
        }
        trace.push(&e);
    }
    Reflect::set(&result, &JsValue::from_str("trace"), &trace)
        .map_err(|_| JsError::new("set trace"))?;

    let effects = Array::new();
    for ef in &vm.effects {
        effects.push(&effect_to_object(ef)?);
    }
    Reflect::set(&result, &JsValue::from_str("effects"), &effects)
        .map_err(|_| JsError::new("set effects"))?;

    Ok(result)
}

/// Serialize a `VmEffect` as a plain JS object `{ kind: <variant>, …fields }`.
/// Avoids pulling in the heavy `Debug` formatter (saves ~50 KB on the WASM bundle).
#[allow(clippy::too_many_lines)]
fn effect_to_object(ef: &simantics::vm::VmEffect) -> Result<JsValue, JsError> {
    use simantics::vm::{DialogFlavour, VmEffect};
    let obj = Object::new();
    let set_kind = |k: &str| -> Result<(), JsError> {
        Reflect::set(&obj, &JsValue::from_str("kind"), &JsValue::from_str(k))
            .map_err(|_| JsError::new("set kind"))?;
        Ok(())
    };
    match ef {
        VmEffect::Sleep { ticks, .. } => {
            set_kind("Sleep")?;
            set_f64(&obj, "ticks", f64::from(*ticks))?;
        }
        VmEffect::Idle { ticks, interruptable, .. } => {
            set_kind("Idle")?;
            set_f64(&obj, "ticks", f64::from(*ticks))?;
            Reflect::set(
                &obj,
                &JsValue::from_str("interruptable"),
                &JsValue::from_bool(*interruptable),
            )
            .map_err(|_| JsError::new("set interruptable"))?;
        }
        VmEffect::PlaySound { event_id, .. } => {
            set_kind("PlaySound")?;
            set_f64(&obj, "eventId", f64::from(*event_id))?;
        }
        VmEffect::AnimateSim { anim_id, .. } => {
            set_kind("AnimateSim")?;
            set_f64(&obj, "animId", f64::from(*anim_id))?;
        }
        VmEffect::StopAllSounds => {
            set_kind("StopAllSounds")?;
        }
        VmEffect::SetBalloon { kind, .. } => {
            set_kind("SetBalloon")?;
            set_f64(&obj, "balloonKind", f64::from(*kind))?;
        }
        VmEffect::SetActionString { string_index, .. } => {
            set_kind("SetActionString")?;
            set_f64(&obj, "stringIndex", f64::from(*string_index))?;
        }
        VmEffect::NotifyOutOfIdle { sim_id } => {
            set_kind("NotifyOutOfIdle")?;
            set_f64(&obj, "simId", f64::from(*sim_id))?;
        }
        VmEffect::SpecialEffect { kind, .. } => {
            set_kind("SpecialEffect")?;
            set_f64(&obj, "effectKind", f64::from(*kind))?;
        }
        VmEffect::UiEffect { kind, .. } => {
            set_kind("UiEffect")?;
            set_f64(&obj, "effectKind", f64::from(*kind))?;
        }
        VmEffect::ShowString { kind, .. } => {
            set_kind("ShowString")?;
            set_f64(&obj, "stringKind", f64::from(*kind))?;
        }
        VmEffect::Dialog { flavour, string_index, .. } => {
            set_kind("Dialog")?;
            let flav = match flavour {
                DialogFlavour::Private => "private",
                DialogFlavour::Global => "global",
                DialogFlavour::SemiGlobal => "semiGlobal",
            };
            Reflect::set(&obj, &JsValue::from_str("flavour"), &JsValue::from_str(flav))
                .map_err(|_| JsError::new("set flavour"))?;
            set_f64(&obj, "stringIndex", f64::from(*string_index))?;
        }
        VmEffect::ChangeSuit { suit_id, .. } => {
            set_kind("ChangeSuit")?;
            set_f64(&obj, "suitId", f64::from(*suit_id))?;
        }
        VmEffect::PushInteraction { pending } => {
            set_kind("PushInteraction")?;
            set_f64(&obj, "actionFunction", f64::from(pending.action_function))?;
            set_f64(&obj, "joiningIndex", f64::from(pending.joining_index))?;
        }
        VmEffect::TransferFunds { delta, .. } => {
            set_kind("TransferFunds")?;
            set_f64(&obj, "delta", f64::from(*delta))?;
        }
        VmEffect::SpatialRequest { primitive, .. } => {
            set_kind("SpatialRequest")?;
            set_f64(&obj, "primitive", f64::from(*primitive))?;
        }
        VmEffect::RunTreeByName { name_index, .. } => {
            set_kind("RunTreeByName")?;
            set_f64(&obj, "nameIndex", f64::from(*name_index))?;
        }
        VmEffect::RemoveObjectInstance { object_id } => {
            set_kind("RemoveObjectInstance")?;
            set_f64(&obj, "objectId", f64::from(*object_id))?;
        }
        VmEffect::CreateObjectInstance { guid, new_object_id } => {
            set_kind("CreateObjectInstance")?;
            set_f64(&obj, "guid", f64::from(*guid))?;
            set_f64(&obj, "newObjectId", f64::from(*new_object_id))?;
        }
        VmEffect::LookTowards { .. } => {
            set_kind("LookTowards")?;
        }
        VmEffect::Breakpoint { bhav_id, ip } => {
            set_kind("Breakpoint")?;
            set_f64(&obj, "bhavId", f64::from(*bhav_id))?;
            set_f64(&obj, "ip", f64::from(*ip))?;
        }
    }
    Ok(obj.into())
}
