# SPR2 + PALT — Maxis paletted sprites

> Sources:
> - Niotso wiki, page [`IFF`](http://wiki.niotso.org/IFF) §SPR2 / §PALT — canonical reference. Local snapshot in [`_niotso/IFF.md`](./_niotso/IFF.md).
> - Empirical hexdump of `samples/iff/FloorJapaneseTile.flr` (15 904 B, 3 SPR2 chunks + 1 PALT, the three zoom levels of a floor texture).
>
> SPR2 chunks live inside an IFF container. Both chunk content and the data inside SPR2 are **little-endian**. Sprite payloads are RLE-compressed paletted 8-bit indexed color, optionally with a z-buffer and alpha channel.

## PALT — colour palette

Carried in an IFF chunk of type `PALT`. Data follows immediately after the 76-byte chunk header.

| Offset | Size | Endian | Field         | Notes |
|--------|------|--------|---------------|-------|
| 0      | 4    | LE     | `version`     | Always `1` |
| 4      | 4    | LE     | `color_count` | Number of RGB entries. Must be ∈ [1, 256]. TS1/TSO always store 256. |
| 8      | 8    | —      | `reserved`    | All zero |
| 16     | 3·n  | RGB    | `entries`     | `color_count` triples of (R, G, B) bytes |

**Total chunk data length** = `16 + 3 · color_count`. For TS1, always `16 + 768 = 784` bytes.

The palette is shared between all SPR2 frames that reference it via their `palette_id`. Index `0` is *not* automatically transparent — transparency is signalled per-frame through the `transparent_color` field.

### Worked example — PALT in `FloorJapaneseTile.flr`

```
00001994  50 41 4C 54                          type "PALT"
00001998  00 00 03 5C                          size BE = 860
0000199C  00 01                                id = 1
0000199E  00 00                                flags = 0
000019A0  …64-byte zero label…
000019E0  01 00 00 00                          version = 1
000019E4  00 01 00 00                          color_count = 256
000019E8  00 00 00 00 00 00 00 00              reserved
000019F0  FF 00 FF                             palette[0] = magenta (transparent marker)
000019F3  77 79 7C                             palette[1]
…
```

## SPR2 — paletted sprite chunk

Carried in an IFF chunk of type `SPR2`. Two data layouts exist (v1000 and v1001).

### Header (v1000)

| Offset | Size | Endian | Field             | Notes |
|--------|------|--------|-------------------|-------|
| 0      | 4    | LE     | `version`         | `1000` |
| 4      | 4    | LE     | `sprite_count`    | Number of frames in this chunk |
| 8      | 4    | LE     | `default_palette` | Chunk ID of the PALT to use for color channels |
| 12     | 4·n  | LE     | `offset_table`    | `sprite_count` u32 offsets, each from the start of the SPR2 chunk **data** (i.e. relative to byte 0 of `version`) |

Frames follow the offset table at the offsets specified.

### Header (v1001)

v1001 reorders the first two scalars and drops the offset table. Each frame is self-describing.

| Offset | Size | Endian | Field             | Notes |
|--------|------|--------|-------------------|-------|
| 0      | 4    | LE     | `version`         | `1001` |
| 4      | 4    | LE     | `default_palette` | Chunk ID of PALT |
| 8      | 4    | LE     | `sprite_count`    | Number of frames |
| 12     | …    | —      | frames            | Each prefixed by `sprite_version: u32 = 1001` and `sprite_size: u32` (size of this frame in bytes, not counting the version+size pair) |

### Frame layout (both versions)

| Offset (in frame) | Size | Endian | Field               | Notes |
|-------------------|------|--------|---------------------|-------|
| 0                 | 2    | LE     | `width`             | pixels |
| 2                 | 2    | LE     | `height`            | pixels |
| 4                 | 4    | LE     | `flags`             | bit `0x01` = has color, `0x02` = has z-buffer, `0x04` = has alpha. Only `0x01`, `0x03`, `0x07` are valid (later channels imply earlier). |
| 8                 | 2    | LE     | `palette`           | Per-frame override of `default_palette`; `0xA3A3` = "use default" |
| 10                | 2    | LE     | `transparent_color` | Index in the palette that pixels with no alpha should be assigned to. |
| 12                | 2    | i16 LE | `y_location`        | Vertical offset in tiles for multi-tile object alignment |
| 14                | 2    | i16 LE | `x_location`        | Horizontal offset |
| 16                | …    | LE     | RLE row data        | See below. Terminated by a row command with `cmd = 5`. |

### RLE encoding

Each row begins with a 2-byte LE u16 split as: high 3 bits = command, low 13 bits = count.

```
let word = u16::from_le_bytes(pair);
let cmd  = (word >> 13) & 0x7;
let count =  word & 0x1FFF;
```

| `cmd` | Meaning | Count semantics |
|-------|---------|-----------------|
| `0`   | **Fill row** with pixel commands that follow | `count` = total bytes of this row block including the 2-byte row header itself |
| `4`   | Leave the next `count` rows transparent (color = transparent_color, z = 255, alpha = 0) | rows |
| `5`   | End-of-sprite marker. `count` is always `0`. | — |

Inside a `cmd = 0` block, pixel commands also use a 2-byte LE header with the same 3+13 bit split.

| Pixel `cmd` | Channels needed | Bytes per pixel | Behaviour |
|-------------|-----------------|-----------------|-----------|
| `1`         | color + z       | 2 (z, palette_idx) | Set the next `count` pixels: z = first byte, color = second byte. Alpha = 255 unless palette_idx == transparent_color. |
| `2`         | color + z + alpha | 3 (z, palette_idx, alpha) | As above plus 5-bit alpha (range 0..31, scale to 0..255). |
| `3`         | any             | 0                  | Leave next `count` pixels transparent (color = transparent_color, z = 255, alpha = 0). |
| `6`         | color only      | 1 (palette_idx)    | Set next `count` pixels' color; z = 0 if not transparent / 255 if transparent. |

After each pixel-data block, the data is padded to a 2-byte boundary (i.e. if a block emitted an odd number of payload bytes, one trailing pad byte is consumed).

The row counter advances by 1 for `cmd = 0` and by `count` for `cmd = 4`. A row that terminates before reaching `width` pixels — i.e. when `cmd = 0` block runs out before `width` pixels filled — leaves the remaining pixels transparent.

### Worked example — SPR2 in `FloorJapaneseTile.flr` (chunk @ 0x40, v1000)

```
0000008C  E8 03 00 00                          version = 1000
00000090  01 00 00 00                          sprite_count = 1
00000094  01 00 00 00                          default_palette = 1  (matches PALT id above)
00000098  10 00 00 00                          offset_table[0] = 0x10 (relative to 0x8C → frame at 0x9C)
0000009C  1F 00                                width = 31
0000009E  10 00                                height = 16
000000A0  01 00 00 00                          flags = 0x01 (color only)
000000A4  A3 A3                                palette = 0xA3A3 (use default)
000000A6  FE 00                                transparent_color = 0xFE  (palette index 254)
000000A8  00 00                                y_location = 0
000000AA  00 00                                x_location = 0
000000AC  …RLE data ending in row cmd 5…
```

## Edge cases

- **Endianness collision risk** (per Niotso, applies to SPR# but worth checking on SPR2 too): test the version field's high two bytes — if non-zero, the chunk might be big-endian. We have not yet seen a BE SPR2 in this install.
- **`palette = 0xA3A3`** — sentinel meaning "fall back to `default_palette`". TS1 always uses default in practice.
- **`transparent_color`** is an index into the palette, not a marker that means "magenta". The actual transparent palette entry is often `(255, 0, 255)` magenta but Maxis uses indices like `0xFE` (254).
- **Zero-sized row blocks**: a `cmd = 0` row whose `count` equals exactly `2` (just the header, no payload) emits a fully transparent row.
- **Off-by-one in `sprite_size`**: in v1001 frames, `sprite_size` excludes the version+size prefix (8 bytes), so the next frame is at `current + 8 + sprite_size`.

## Differential test references

- **IFFSnooper** can export PNG renderings of SPR2 frames. Hard to script (Windows-only GUI). Workaround: export each frame's RGBA8 from our decoder to a PNG, eyeball-compare side by side until automation is justified.
- **PALT self-check**: every byte of `entries` must be in 0..=255 (trivial), and `color_count` must satisfy `data_len == 16 + 3 * color_count`.
- **SPR2 self-check**: after decoding, the row counter must equal `height` exactly; if it overshoots, the file is malformed.

## Open questions

- Some SPR2 frames in `unsnacker.iff` could not be tested because that file uses `BMP_` chunks instead. Walls and floors do use SPR2 — `FloorJapaneseTile.flr` is our reference.
- Niotso documents 4 SPR# row/pixel commands; the SPR2 spec uses **different** numeric command values for the same conceptual operations. Don't share decoder code between SPR# and SPR2.
- The 5-bit alpha channel (`cmd = 2` pixel command) — does scaling 0..31 → 0..255 use `(a << 3) | (a >> 2)` (standard 5→8 bit upscaling) or simple `a * 8`? Niotso doesn't specify; we'll match what the original engine does once we have a side-by-side oracle.
