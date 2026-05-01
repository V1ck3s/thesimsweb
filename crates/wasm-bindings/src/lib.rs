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
