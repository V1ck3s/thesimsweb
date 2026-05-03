# Catalog chunks — STR#, TRCN, OBJD, TTAB, TTAs

> Sources:
> - Niotso wiki, [`IFF`](http://wiki.niotso.org/IFF) page §STR# / §TRCN / §OBJD / §TTAB / §TTAs. Local snapshot in [`_niotso/IFF.md`](./_niotso/IFF.md).
> - Empirical hexdumps of `Objects.far/AlarmClock.iff` and a 60-IFF survey of the TS1 base game `Objects.far`.
>
> All multi-byte fields are **little-endian** unless noted. Inputs to every parser below are the **data payload** of an IFF chunk (i.e. bytes after the 76-byte chunk header — caller slices).

## Survey of the TS1 install

Across 60 IFFs in `Objects.far` (≈half of the archive):

| Chunk | Versions seen (count)                       | Notes                                             |
|-------|---------------------------------------------|---------------------------------------------------|
| `OBJD`| 138 (409), 136 (1)                          | TS1 base game = v138 almost universally.          |
| `TTAB`| 9 (64), 8 (11), 5 (2), 3 (1), 2 (1)         | v9+ uses *field encoding* compression — see below.|
| `STR#`| -3 (189), -2 (41), -1 (7), 0 (2), other (13)| TS1 base = v-3 (language-coded string pairs).     |
| `TRCN`| 1 (3)                                       | Few constant tables have labels in TS1.           |

This crate parses **STR# v0/-1/-2/-3, TRCN v0/v1, OBJD v138, TTAB v5/v8 (uncompressed)** in full. v9+ TTAB returns `UnsupportedVariant` until we reverse-engineer the field-encoding scheme (the Niotso page only documents widths "5, 8, 13, 16" for u16 / "6, 11, 21, 32" for i32 — not the bit layout). v2 TRCN (TSO Pascal-like) and v-4 STR# (TSO language-grouped) are likewise out of scope today.

## STR# — string table

Holds Pascal or C strings in 5 distinct on-disk layouts, distinguished by a leading `i16` *version*.

| Version (LE i16) | Bytes      | Layout                                             | Origin       |
|------------------|------------|----------------------------------------------------|--------------|
| `0`              | `00 00`    | `count: u16`, then `count` Pascal strings (`u8 len`, bytes). | Original    |
| `-1`             | `FF FF`    | `count: u16`, then `count` C-strings (NUL-terminated).        | TS1          |
| `-2`             | `FE FF`    | `count: u16`, then `count` *pairs* of C-strings (data, comment). | TS1       |
| `-3`             | `FD FF`    | `count: u16`, then `count` `(lang_code: u8, data: cstr, comment: cstr)`. | TS1 multi-language |
| `-4`             | `FC FF`    | TSO grouped-by-language Pascal-like strings. **Not parsed.**   | TSO          |

**Edge case** (Niotso): some STR# chunks consist of just the version field and no body; treat that as zero strings.

A pair's *comment* is usually empty in shipping games — a `data\0` followed by a single `\0` is the common encoding for "no comment".

### Language codes (v-3, v-4)

| Code | Language               | Encoding (Niotso)               |
|------|------------------------|---------------------------------|
| 0    | unused / default       | Windows-1252                    |
| 1    | English (US)           | Windows-1252                    |
| 2    | English (Intl.)        | Windows-1252                    |
| 3    | French                 | Windows-1252                    |
| 4    | German                 | Windows-1252                    |
| 5    | Italian                | Windows-1252                    |
| 6    | Spanish                | Windows-1252                    |
| 7    | Dutch                  | Windows-1252                    |
| 8    | Danish                 | Windows-1252                    |
| 9    | Swedish                | Windows-1252                    |
| 10   | Norwegian              | Windows-1252                    |
| 11   | Finnish                | Windows-1252                    |
| 12   | Hebrew                 | n/a (TS1 has the slot, not the strings) |
| 13   | Russian                | n/a                             |
| 14   | Portuguese             | Windows-1252                    |
| 15   | Japanese               | Windows-932 (Shift-JIS variant) |
| 16   | Polish                 | Windows-1250                    |
| 17   | Simplified Chinese     | Windows-936                     |
| 18   | Traditional Chinese    | Windows-950 (Big5 variant)      |
| 19   | Thai                   | Windows-874                     |
| 20   | Korean                 | Windows-949                     |

The parser stores raw bytes; rendering the right code page is the caller's responsibility (`TextDecoder` in the browser handles `windows-1252` and friends).

## TRCN — labels for BCON

Provides a name + comment for each value in a same-ID BCON chunk. Used by Edith (the editor) but ignored at runtime — useful for our **debugger** UI later.

| Offset | Size | Field           | Notes                                            |
|--------|------|-----------------|--------------------------------------------------|
| 0      | 4    | reserved        | always `0`                                       |
| 4      | 4    | version         | u32. `0`, `1`, or `2`. We support 0/1.           |
| 8      | 4    | magic           | ASCII `"NCRT"` or zero (defensive: don't enforce)|
| 12     | 4    | count           | u32, must equal the BCON's count                 |
| 16     | …    | entries         | repeated `count` times                           |

Each entry, in v0/v1:

```
is_used:   u32          // 0 = unused, !=0 = used
default:   u32          // suggested default
name:      pad2(cstr)   // NUL-terminated, padded to even length with 0xA3
comment:   pad2(cstr)   // same
// v1 only — range fields:
enforced:  u8
range_min: i16
range_max: i16
```

The padding byte is `0xA3` (Niotso). We don't enforce its value, only the even-length invariant.

v2 TRCN (TSO) uses the FCFF Pascal-like variable-length-coded strings; see STR# v-4. **Not parsed.**

## OBJD — object definition (catalog)

The catalog entry for an in-game object: GUID, price, type, and a long list of BHAV/STR# IDs the runtime hooks into. Multiple OBJDs in the same IFF describe a multi-tile object.

In TS1 the only common version is **138**. Layout = `version: u32` then `N × u16` fields, where N depends on the version (the chunk is just an array of u16 packed after the version u32).

For TS1 v138 we observed **216 bytes total = 4 + 106 × u16**. The Niotso page nominally splits v138 into "138a (95 fields)" and "138b (108 fields)" but observed TS1 sizes don't always match either; the safest approach is to **stash all fields in a `Vec<u16>` and accept any version**, then expose **named accessors** for the well-documented prefix.

### Named fields (TS1 v138)

The first 37 indices are documented in the Niotso wiki and confirmed against `AlarmClock.iff` (price = 30, type = 4 buyable, TTAB ID = 129 matches the file's lone TTAB). All u16 unless noted.

| Index | Name (Niotso)                | Notes                                                              |
|-------|------------------------------|--------------------------------------------------------------------|
| 0     | initial_stack_size           | Stack frames pre-allocated for this object's BHAVs.                |
| 1     | base_graphic_id              | First DGRP chunk ID, may be 0.                                     |
| 2     | num_graphics                 | Count of DGRP states.                                              |
| 3     | main_id                      | BHAV ID for the object's main loop.                                |
| 4     | gardening_id                 | BHAV ID, plant care.                                               |
| 5     | ttab_id                      | TTAB chunk ID (pie menu).                                          |
| 6     | interaction_group            | Unclear (Niotso).                                                  |
| 7     | object_type                  | `0` unknown, `2` person, `4` buyable, `7` controller, `8` portal, `9` cursor, `10` prize, `11` temp, `34` food. |
| 8     | master_id                    | Multi-tile object grouping ID; `0` ⇒ single tile.                  |
| 9     | sub_index                    | Within a multi-tile group: `0xFFFF` ⇒ master; else `(y<<8)|x`.    |
| 10    | wash_hands_id                | BHAV ID.                                                           |
| 11    | anim_table_id                | STR# ID listing animation names (a2o + a2a).                       |
| 12–13 | guid_lo / guid_hi            | u32 GUID, lo first.                                                |
| 14    | disabled                     | Hide from catalog.                                                 |
| 15    | portal                       | Portal flag (staircase-like routing).                              |
| 16    | price                        | Catalog price in §.                                                |
| 17    | body_strings_id              | STR# ID for character body/dressing strings.                       |
| 18    | slot_id                      | SLOT chunk ID.                                                     |
| 19    | allow_intersection_id        | BHAV ID.                                                           |
| 20–21 | unknown_4b                   | 4 unknown bytes.                                                   |
| 22–30 | prepare_food_id … stand_id   | BHAV IDs for sim food/sit/stand handlers (only meaningful on Sims).|
| 32    | sale_price                   | Current price after depreciation.                                  |
| 33    | initial_depreciation         |                                                                    |
| 34    | daily_depreciation           |                                                                    |
| 35    | self_depreciating            | If 1, object computes its own price.                               |
| 36    | depreciation_limit           | Floor for daily depreciation.                                      |

Indices ≥ 37 vary by version; we keep them as raw u16 for now and fill in semantics opportunistically.

### Worked example — `AlarmClock.iff`

Chunk: `OBJD id=16807, len=216 (after IFF header)`. Decoded:

```
version              = 138
[ 0] init_stack_size = 4
[ 1] base_graphic    = 128
[ 2] num_graphics    = 7
[ 5] ttab_id         = 129    # matches the only TTAB in this IFF
[ 7] object_type     = 4      # buyable object
[11] anim_table_id   = 129    # matches STR# id=129
[12..13] guid        = 0xA483_D725
[16] price           = 30§    # plausible alarm-clock price
[18] slot_id         = 128
```

## TTAB — tree table (interactions)

Lists all *interactions* (pie-menu entries) on this object and pairs each with an *action* BHAV and an optional *guard* BHAV. Pie-menu **labels** are in a same-ID `TTAs` chunk.

### v5 / v8 layout (parsed)

```
interaction_count: u16
version:           u16             // 5 or 8
interactions:      [Interaction; interaction_count]
```

Each interaction (v8 — adds attenuation_code/value from v7, no v10 unknown field):

| Offset | Size | Field                | Notes                                          |
|--------|------|----------------------|------------------------------------------------|
| 0      | 2    | action_function      | BHAV chunk ID.                                 |
| 2      | 2    | guard_function       | BHAV chunk ID; `0` ⇒ always allowed.           |
| 4      | 4    | motive_entry_count   | Always 16 in TS1.                              |
| 8      | 4    | flags                | Bit field (Niotso doesn't enumerate fully).    |
| 12     | 4    | ttas_index           | Index into the same-ID TTAs chunk.             |
| 16     | 4    | attenuation_code     | v7+. 0=custom, 1=none, 2=low, 3=mod, 4=high.   |
| 20     | 4    | attenuation_value    | IEEE-754 float; meaningful only when code=0.   |
| 24     | 4    | autonomy_threshold   | u32, ~50 or 100.                               |
| 28     | 4    | joining_index        | i32, `-1` if not joinable.                     |
| 32     | …    | motive_entries       | `motive_entry_count` × 6 bytes (v7+).          |

Each motive entry in v7+:

```
effect_min:           i16     // 0 ⇒ same as effect_max
effect_max:           i16
personality_modifier: u16     // 1..=22, indexed into behaviour.iff chunk 0x00E8
```

Per-interaction size in v8 (16 motives) = `4 + 28 + 96 = 128` bytes. AlarmClock.iff: `2` interactions × 128 + 4 header = 260 bytes ✓.

### v5 layout

Same as v8 but **without** `attenuation_code`, `attenuation_value`, and the motive `effect_min` and `personality_modifier` (those were added in v7). Each motive in v5 is just `effect_max: i16` (2 bytes), and the per-interaction prefix omits 8 bytes.

Per-interaction size in v5 = `4 + 20 + 32 = 56` bytes.

### v9+ — partially parsed (header only)

v9, v10, v11 introduce a **field encoding** compression: a leading
`compression_code: u8 = 1`, then each fixed-width field is replaced by a
variable-width bit stream (Niotso: u16 widths ∈ `{5,8,13,16}`, i32 widths ∈
`{6,11,21,32}`). The actual bit layout is **not** documented in the Niotso
wiki and we have no first-party reference; reversing it requires running TS1
under Wine and capturing pie-menu labels per object as an oracle (multi-day
empirical work).

What we **do** decode today (`TtabHeader::parse`):

- `count: u16`, `version: u16` — works for any version.
- `compression_code: u8 = 1` — the byte right after the header in v9
  samples. Confirmed on every v9 chunk we audited.

What's still **unknown** (per-interaction bit stream):

- Empirical record sizes from a 124-IFF audit of `Objects.far`:
  - `count=0` → 1 byte (just the compression flag).
  - `count=1` → 15..20 bytes per interaction (varies by sample).
  - `count=8` → ~22 bytes per interaction average.
- The first byte of each record varies (`e2`, `e4`, `e0`, `bc`, …) which is
  consistent with a **field-presence bitmask** preceding the values.
- Without a TS1-running oracle to cross-check decoded `action_function` IDs
  against pie-menu labels, we can't bisect bit widths confidently.

Coverage today (v9 catalog audit, 124 objects):

| TTAB version | Count | Decoded? |
|--------------|-------|----------|
| v5           | 3     | yes (interactions list) |
| v8           | 24    | yes (interactions list) |
| v9           | 72    | header only (count, version) |
| v2 (HelpSystem) | 1 | rejected — non-game version |

Until v9 is reversed, the catalog viewer falls back to *"this object exposes
N interactions, decoding deferred"* for ~58% of TS1 objects.

## TTAs — pie-menu labels

> Pie menu text strings; **equivalent in format to STR#** (Niotso, verbatim).

We reuse the STR# parser. By convention TS1 ships them as v-3 pairs `(label, comment)` keyed by language code.

## Open questions

- **TTAB v9+ field encoding** — most TS1 base-game TTABs are v9, so we can't read interactions for ~85% of catalog objects yet. Pivot point for the catalog viewer.
- **OBJD versions other than 138** — exactly one v136 chunk seen in the survey; needs hexdump when we hit it.
- **TRCN v2 / STR# v-4** — TSO-only, low priority.
