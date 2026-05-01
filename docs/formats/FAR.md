# FAR — Maxis archive format

> Sources:
> - Niotso wiki (offline 2026-05-01, no archive.org mirror reachable from WSL).
> - Empirical hexdump of `samples/far/UnSnacker.far` (15 962 B, 2 entries) and `GameData/Global/Global.far` (~2 MiB, 24 entries) on the user's Complete Edition install.
> - Cross-checked against the format implemented by [TS1-FAR-Unpack](https://github.com/samulated/TS1-FAR-Unpack) (reference parser used for differential tests).
> - All numbers little-endian unless stated. ASCII filenames, no NUL terminator.

## Magic / signature

```
offset 0   8 bytes   "FAR!byAZ"   (0x46 0x41 0x52 0x21 0x62 0x79 0x41 0x5A)
```

The literal `byAZ` is part of the magic — Maxis credit to Andrew Zarudnyy. Reject any file that does not start with this exact 8-byte sequence.

## Header (16 bytes)

| Offset | Size | Endianness | Field             | Notes                                         |
|--------|------|------------|-------------------|-----------------------------------------------|
| 0      | 8    | —          | `magic`           | `"FAR!byAZ"`                                  |
| 8      | 4    | LE         | `version`         | `1` for TS1 (all observed). Other values exist (see "Versions") |
| 12     | 4    | LE         | `manifest_offset` | Absolute byte offset of the manifest          |

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

## Versions

| Version | Compression | Where seen                               | Status                  |
|---------|-------------|------------------------------------------|-------------------------|
| 1       | None        | The Sims 1 (all observed FARs)           | **Implemented** (Phase 2) |
| 1a      | None, with extra `type: u32` per entry | Some TS1 / TS Online expansion content | Planned, deferred       |
| 3       | RefPack (per-entry flag)                | The Sims Online                          | Out of scope for v1     |

We have **only v1** in the user's Complete Edition install (verified by reading `version` at offset 8 across `Downloads/`, `GameData/`, `ExpansionPack*/`, `Music/` FARs — all return `0x00000001`). A future encounter of v1a or v3 will require re-checking the entry layout against TS1-FAR-Unpack and adding a version dispatch in the parser.

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

- Does v1a use a `type: u32` field after `filename_length` (16-byte filename header) or before it (different ordering)? — Answer requires a v1a sample, which we don't have. Deferred until we encounter one.
- Do any v1 archives in TS Online / Hot Date / Vacation / Superstar / Makin' Magic use compressed payloads despite advertising `version = 1`? — Verify by walking every `.far` in the install and asserting `size_compressed == size_decompressed`. Small smoke test, can be added to the differential script.
