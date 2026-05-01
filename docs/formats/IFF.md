# IFF — Maxis chunk container

> Sources:
> - Niotso wiki, page [`IFF`](http://wiki.niotso.org/IFF) — canonical reference. Local snapshot in [`_niotso/IFF.md`](./_niotso/IFF.md) (2026-05-01).
> - Empirical hexdump of `samples/iff/Options.iff` (379 B, 2 chunks: Optn + rsmp), `samples/iff/Ranger.iff` (643 B), `samples/iff/unsnacker.iff` (15 872 B, extracted from `UnSnacker.far`).
> - Cross-checks against the FAR-extracted IFF (the same byte stream produced by both our parser and TS1-FAR-Unpack).
>
> Format created by **Jamie Doornbos** (Maxis, 1996), based on EA's IFF (1985). Chunk headers **big-endian**. Chunk content **little-endian**. ASCII labels, no NUL terminator on the type field.

## Magic / signature

The first 64 bytes are the file header. Two versions exist; both start with `IFF FILE`.

```
v2.0 (House00.iff in some UserData/ folders):
  64 bytes: "IFF FILE 2.0:TYPE FOLLOWED BY SI" "ZE\0 JAMIE DOORNBOS & MAXIS 1996\0"

v2.5 (everything else in this install):
  60 bytes: "IFF FILE 2.5:TYPE FOLLOWED BY SI" "ZE\0 JAMIE DOORNBOS & MAXIS 1"
   4 bytes: rsmp_offset (u32 BE) — absolute offset of the resource-map chunk
```

In v2.0 the trailing `1996\0` is a fixed signature byte sequence. In v2.5 those four bytes are repurposed as the `rsmp` offset (so the version string is truncated from `1996` → `1`).

The repo install uses **v2.5 exclusively** across `GameData/`, `UserData*/`, and the IFFs extracted from `.far` archives.

## Header (64 bytes)

| Offset | Size | Endian | Field         | Notes |
|--------|------|--------|---------------|-------|
| 0      | 60   | ASCII  | `signature`   | `"IFF FILE 2.5:TYPE FOLLOWED BY SIZE\0 JAMIE DOORNBOS & MAXIS 1"` (or v2.0 form, 64 bytes consuming the next field) |
| 60     | 4    | BE     | `rsmp_offset` | v2.5 only. Absolute byte offset of the `rsmp` chunk, or `0` if no resource map |

## Chunks

Chunks are concatenated end-to-end starting at offset 64, with no padding between them. Each chunk has a 76-byte header.

| Offset (in chunk) | Size | Endian | Field      | Notes |
|-------------------|------|--------|------------|-------|
| 0                 | 4    | ASCII  | `type`     | 4-byte tag, **case-sensitive**, e.g. `BHAV`, `BCON`, `SPR2`, `STR#`, `Optn`, `rsmp`, `uChr`. May contain non-letter bytes (`#`, `_`). No NUL terminator. |
| 4                 | 4    | BE     | `size`     | Total chunk size in bytes, **including the 76-byte header**. Data length = `size − 76`. |
| 8                 | 2    | BE     | `id`       | Numeric ID, unique per (file, chunk-type) — referenced by other chunks (e.g. BHAV → BCON) |
| 10                | 2    | BE     | `flags`    | Observed values: `0x0000`, `0x0010`, `0x0014`. Niotso documents the first two and notes the meaning is unknown. We treat the field as opaque and pass it through. |
| 12                | 64   | ASCII  | `label`    | Human-readable label, ignored by the game engine. Often all-zero. |
| 76                | n    | LE     | `data`     | Chunk payload. `n = size − 76`. |

If a chunk's stated `size` is `< 76`, the file is malformed (header would overrun the chunk).

## Worked example — `samples/iff/Options.iff` (379 B)

```
00000000  49 46 46 20 46 49 4C 45 …             v2.5 signature (60 bytes)
0000003C  00 00 00 B0                          rsmp_offset = 0xB0 = 176
00000040  4F 70 74 6E                          chunk[0] type = "Optn"
00000044  00 00 00 70                          size = 0x70 = 112 → ends at 0xB0
00000048  00 80                                id = 0x80
0000004A  00 10                                flags = 0x0010
0000004C  …64-byte label, all zero…
0000008C  …36 bytes of Optn data (LE)…
000000B0  72 73 6D 70                          chunk[1] type = "rsmp"
000000B4  00 00 00 72                          size = 0x72 = 114 → ends at 0x122
000000B8  00 00                                id = 0
000000BA  00 10                                flags = 0x0010
000000BC  …64-byte label, all zero…
000000FC  00 00 00 00 00 00 00 00 70 6D 73 72  reserved + version + "pmsr" magic
…
00000122  58 58 58 58                          chunk[2] type = "XXXX"
00000126  00 00 00 59                          size = 0x59 = 89 → ends at 0x17B (EOF)
0000012A  83 5C                                id = 0x835C
0000012C  00 04                                flags = 0x0004 (third unknown flag value)
0000017B  EOF
```

Three chunks: Optn + rsmp + XXXX. Note that in this file `rsmp` is *not* the last chunk — Niotso says it usually is, but here it's middle. The parser does a plain linear walk; it doesn't depend on rsmp position.

## Resource map (`rsmp`)

The `rsmp` chunk is an index of all other chunks in the file, deliberately mirroring the on-disk order so the game can quickly find a chunk by `(type, id)` without walking the whole file. Its `id` is always 0 and its `label` is all-zero. Data layout (per Niotso, **little-endian** like all chunk content):

```
u32  reserved (always 0)
u32  version (0 for TS1, 1 for TSO)
u32  magic    "pmsr" (= "rsmp" byte-swapped) or 0
… (per-type table follows; documented in Niotso)
```

Verified empirically in `Options.iff`: data bytes 0..12 read `00 00 00 00  00 00 00 00  70 6D 73 72`.

The `rsmp` chunk is **redundant with a linear walk** of the file: anything we can learn from `rsmp` we can learn by enumerating chunks ourselves. We use linear walk by default and may use `rsmp` later for O(1) lookup if profiling demands it.

## Known chunk types in TS1 (subset)

Beyond enumeration, the parser treats chunks as opaque bytes. Decoders for individual types live in their own crates:

| Type   | Purpose                                           | Decoder owner        |
|--------|---------------------------------------------------|----------------------|
| `BHAV` | SimAntics behavior bytecode                       | `crates/simantics` (Phase 4) |
| `BCON` | Constants table referenced by BHAV                | `crates/simantics` |
| `TRCN` | Labels for BCON constants                         | `crates/simantics` |
| `STR#` | Wide string table (Pascal-length-prefixed)        | `crates/iff` strings module |
| `CTSS` | Catalog text strings (same format as `STR#`)      | `crates/iff` |
| `CST`  | Caret-separated text? Same format as `STR#`       | `crates/iff` |
| `OBJD` | Object definition (catalog metadata)              | `crates/iff` |
| `OBJf` | Object function dispatch table                    | `crates/iff` |
| `TTAB` | Pie-menu interaction table                        | `crates/iff` |
| `TTAs` | Pie-menu strings                                  | `crates/iff` |
| `SPR#` | Old (TS1) sprite chunk                            | `crates/sprite` |
| `SPR2` | New (TS1/TSO) sprite chunk, RLE 8-bit             | `crates/sprite` |
| `PALT` | Palette (256-entry RGBA, fixed 1040 bytes)        | `crates/sprite` |
| `DGRP` | Drawing group, organises sprites by camera angle  | `crates/sprite` |
| `Optn` | User options (`Options.iff`)                      | `crates/iff` |
| `rsmp` | Resource map (index of all other chunks)          | `crates/iff` (parser-internal) |

The full Niotso list — Arry, BMP_, CARR, CATS, EXPi, FAMh/FAMI/FAMs, FBMP, FCNS, FLRm, FWAV, GLOB, HOUS, NBRS, NGBH, ObjM, objt, POSI, Rcon, SIMI, SLOT, TATT, THMB, TMPL, TPRP, TREE, uChr, WALm — lives in [`_niotso/IFF.md`](./_niotso/IFF.md).

## Edge cases observed

- **Trailing bytes after the last chunk** (`Options.iff` has 89 unaccounted bytes). Behaviour: stop walking when `cursor + 8 > buffer.len()`, ignore tail.
- **Chunks with `size > buffer.len() - cursor`** — malformed. Treat as a hard error, return `IffError::ChunkOverrun`.
- **Type bytes can be non-printable** in theory; in practice TS1 uses ASCII-letter+digit+`_`+`#`. We do **not** restrict the type field — store as `[u8; 4]` and let callers interpret.
- **`flags` may have bits beyond `0x0010`** (saw `0x0014` in `Ranger.iff`). Pass through as `u16`; never reject on flag value.
- **v2.0 detection**: matches when bytes 32..36 are `00 20 4A` (NUL + space + `J`) and bytes 60..64 are the literal "1996" + NUL — only seen in `House00.iff` of certain UserData folders, per Niotso. Our install: not encountered yet. Parser dispatches on the version digits at offset 9..12.

## Differential test references

- **IFFSnooper** is the canonical TS1 IFF tool, but Windows-only GUI — hard to script. Plan: dump a chunk inventory by hand once, save as a YAML golden in `samples/iff/golden/<file>.yaml`, then have our parser regenerate the same YAML and `diff` it. Implementation deferred until we hit a parser bug.
- **Self-consistency**: every chunk we enumerate must satisfy `cursor + 8 ≤ buffer.len()` (room for type + size) and `cursor + size ≤ buffer.len()` (full payload). If `rsmp_offset` is non-zero, our linear walk must encounter a chunk of type `rsmp` at exactly that offset.

## Open questions

- What does the `flags` value `0x0014` mean? Niotso documents only `0x0000` and `0x0010`.
- Can a chunk's `id` collide across types? Niotso says IDs are unique within the file; we should test this on the wider asset set.
- Is the trailing region after the last enumerated chunk part of the format (e.g. an unindexed chunk) or genuine slack? Walk a wide sample and see if it's always 0-padded vs structured.
