# FAR — Maxis archive format

> Sources:
> - Niotso wiki, page [`FAR`](http://wiki.niotso.org/FAR) — canonical reference. Local snapshot in [`_niotso/FAR.md`](./_niotso/FAR.md) (2026-05-01).
> - Empirical hexdump of `samples/far/UnSnacker.far` (15 962 B, 2 entries), `samples/far/ColumnFrench.far` (3 entries), and `GameData/Global/Global.far` (24 entries) on the user's Complete Edition install.
> - Cross-checked byte-for-byte against [TS1-FAR-Unpack](https://github.com/samulated/TS1-FAR-Unpack) — see `scripts/diff/far.sh`.
>
> Format created by **Alex Zvenigorodsky** (Maxis). All numbers little-endian unless stated. ASCII filenames, no NUL terminator.

## Magic / signature

```
offset 0   8 bytes   "FAR!byAZ"   (0x46 0x41 0x52 0x21 0x62 0x79 0x41 0x5A)
```

The literal `byAZ` is part of the magic — Maxis crediting Alex Zvenigorodsky. Reject any file that does not start with this exact 8-byte sequence.

## Header (16 bytes)

| Offset | Size | Endianness | Field                | Notes                                         |
|--------|------|------------|----------------------|-----------------------------------------------|
| 0      | 8    | —          | `magic`              | `"FAR!byAZ"`                                  |
| 8      | 4    | LE         | `version`            | `1` for both v1a (TS1) and v1b (TSO). Disambiguated by entry layout, see "Versions" |
| 12     | 4    | LE         | `file_table_offset`  | Absolute byte offset of the file table        |

Payloads start at offset 16 immediately after the header. The manifest is at the end of the file.

## Manifest layout (at `manifest_offset`)

```
u32 LE       entry_count
entry[0]
entry[1]
…
entry[entry_count-1]
```

Each entry is variable-sized:

| Offset | Size | Endianness | Field               | Notes                                     |
|--------|------|------------|---------------------|-------------------------------------------|
| 0      | 4    | LE         | `size_decompressed` | Logical size after decompression          |
| 4      | 4    | LE         | `size_compressed`   | Bytes actually stored. **In v1 always equal to `size_decompressed`** (archive is uncompressed) |
| 8      | 4    | LE         | `offset`            | Absolute byte offset of the payload in the archive |
| 12     | 4    | LE         | `filename_length`   | Number of bytes in the name that follows  |
| 16     | n    | ASCII      | `filename`          | `filename_length` bytes, no NUL, slashes use `/` if subpaths exist |

Total entry size = `16 + filename_length` bytes. Entries are packed end-to-end with no padding.

## Versions (per Niotso)

| Niotso version | `version` field | Filename length width | Extra entry fields                                 | Used by      | Status                |
|----------------|-----------------|-----------------------|----------------------------------------------------|--------------|-----------------------|
| **1a**         | `1`             | u32                   | none                                               | The Sims 1   | **Implemented**       |
| **1b**         | `1`             | u16                   | none                                               | TSO          | Deferred (no samples) |
| **3**          | `3`             | u16                   | `flags: u16` after `data_offset`, `type_id: u32`, `file_id: u32` after filename_length | TSO        | Out of scope for v1   |

Both 1a and 1b advertise `version = 1` in the header — they are distinguished by entry layout, not by the header. Niotso speculates 1b "was intended to be version 2." Compression has been **supported since v1a but never used until TSO** — the spec leaves room for it (compressed != decompressed sizes), but TS1 archives always have them equal.

In v3 the `compressed_size` field's high bit is a flag: set ⇒ payload is wrapped in a little-endian `Stream` container (RefPack). See [`RefPack.md`](./_niotso/RefPack.md) and [`Stream`](http://wiki.niotso.org/Stream) for the compression scheme.

We have **only v1a** in the user's Complete Edition install (verified by reading `version` at offset 8 across `Downloads/`, `GameData/`, `ExpansionPack*/`, `Music/` FARs — all return `0x00000001`, with u32 filename_length confirmed by hexdump). A future encounter of v1b or v3 will require checking the entry layout and adding a version dispatch in the parser.

## Worked example — `samples/far/UnSnacker.far`

```
00000000  46 41 52 21 62 79 41 5A  01 00 00 00 1C 3E 00 00   FAR!byAZ.....>..
                                  └ version=1   └ manifest=0x3E1C
00000010  …payload of unsnacker.iff (15 872 bytes)…
00003E10  …payload of UnSnacker.ndx (12 bytes)…
00003E1C  02 00 00 00                                        entry_count=2
00003E20  00 3E 00 00  00 3E 00 00  10 00 00 00  0D 00 00 00  size_dec=0x3E00, size_cmp=0x3E00, off=0x10, fnlen=13
00003E30  "unsnacker.iff"
00003E3D  0C 00 00 00  0C 00 00 00  10 3E 00 00  0D 00 00 00  size=12, size=12, off=0x3E10, fnlen=13
00003E4D  "UnSnacker.ndx"
00003E5A  EOF
```

Total file size = 15 962 B; manifest spans `0x3E1C..0x3E5A` (62 B = 4 + 2 × (16 + 13)).

## Edge cases observed

- **`offset = 0x10` for the first entry** — payloads start immediately after the 16-byte header. There is no padding, no per-entry footer, no per-entry header in v1.
- **Filenames are case-mixed** (`unsnacker.iff` lowercase, `UnSnacker.ndx` PascalCase). We must do **case-insensitive lookup** (Sims runs on Windows; FAT/NTFS preserve case but compare insensitively).
- **Filenames may contain forward slashes** for subpaths inside the archive (verify when we open `Objects.far` — likely flat in v1, but we shouldn't crash if a slash appears).
- **`Sound.far` in `ExpansionPack4/`** is 37 B — too small for a valid header. Maxis ships an empty stub there. Our parser should return `Err(InvalidHeader)` cleanly, not panic.
- **No alignment requirements** between the header and the first payload, between payloads, or between the last payload and the manifest. Offsets are absolute and authoritative.

## Differential test references

- **TS1-FAR-Unpack**: extract a sample `.far` and compare each entry byte-for-byte against our extraction. See `scripts/diff/far.sh` (Phase 2).
- IFFSnooper does **not** unpack FAR; it operates on `.iff` directly. So FAR-level diff is TS1-FAR-Unpack only.

## Open questions

- Do any expansion FARs (Hot Date, Vacation, Superstar, Makin' Magic) sneak in compressed payloads despite advertising `version = 1`? — Niotso says "TS1 does not actually support any form of compression," but that's the engine, not the format. Verify by walking every `.far` in the install and asserting `size_compressed == size_decompressed`. Small smoke test, can be added to the differential script.
- Does the FAR loader inside `Sims.exe` enforce alignment on the file table, or accept any `file_table_offset`? — Not critical for read-only parsing; only matters if we ever rewrite an archive.
