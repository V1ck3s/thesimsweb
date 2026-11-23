# HOUS / FLRm / WALm / Arry — house file chunks

> Sources:
> - Empirical hexdump of `<game folder>/TemplateMagictown/House90.iff`
>   (255 396 B — full lot save).
> - Niotso wiki page [`IFF`](http://wiki.niotso.org/IFF) — listed in the
>   chunk-type table but layout is **not** documented.
> - FreeSO/Simitone has decoders we have not copied (read-only reference).

A **House.iff** holds an entire lot save: lot metadata (`HOUS`),
floor/wall material refs (`FLRm` / `WALm`), tile arrays (`Arry`), placed
objects (`ObjM`/`objt`), embedded thumbnails (`THMB`/`BMP_`), and a Sims-
side metadata table (`SIMI`).

This is a multi-day reverse target. The current decoder lands the cheap
parts (`HOUS` lot name) and stops short of geometry.

## HOUS — lot metadata

Single chunk per house file (`id=1`).

```
[0..4]    reserved (always 0)
[4..8]    version u32 LE (e.g. 0x49 = 73 in TemplateMagictown samples)
[8..12]   magic "SUOH" (= "HOUS" reversed)
[12..]    NUL-terminated C-string with the lot's display name
[after \0] opaque trailing bytes — likely room temperatures, occupant
          counts, simoleons, time of day. Empirically ~50 bytes of
          `00000000 c8000000 …` patterns (10 × 0xC8 = 200 = "100% room
          temperature"?). Multi-day reverse to confirm.
```

Parser: `simantics::Hous::parse(data) -> Result<Hous, _>`. WASM:
`parseHous(chunkData)` → `{ version, name, trailingLen }`.

## FLRm — floor material assignments

Layout (parsed by `simantics::Flrm`, algorithm cross-checked against
FreeSO's `WALm.cs`):

```
[0..4]    reserved zero
[4..8]    version u32 LE (= 0)
[8..12]   "mRLF" magic (= "FLRm" reversed)
[12..16]  entry count u32 LE
[16..]    entries (variable size):
            NUL-terminated C-string (filename, e.g. "floormagictuscantileceramic.flr")
            optional 1 pad byte if filename length (excluding NUL) is even
              (16-bit alignment after the NUL)
            u32 unknown1 (= 1 in samples)
            u8 id  (sub-index, e.g. 21, 23, 28 for distinct floors)
            (5 + chunk_id * 2) trailing bytes (chunk_id is the IFF chunk's id)
```

A House lot has 2 FLRm chunks (`id=0` ground floor, `id=1` second story).
On `House90.iff`: 6 entries each, mapping ids 21, 23, 28, 30, 31, 34 to the
six distinct `.flr` filenames the lot references.

## WALm — wall material assignments

Identical layout to `FLRm` (FreeSO models them as the same class). Filenames
are `.wll` instead of `.flr`. House90.iff exposes 9 unique walls per
chunk, mapping ids 3, 5, 6, 7, 12, 16, 19, 31, 37 to filenames like
`wallmagictuscanstuccowoodwainscoting.wll`.

Same parser: `simantics::Flrm::parse(data, chunk_id)` (the magic check
accepts both `mRLF` and `mLAW`).

## Arry — tile arrays (the actual geometry)

64×64 RLE-compressed grids. Header layout (parsed by `simantics::Arry`):

```
[0..4]    reserved zero
[4..8]    width u32 LE  (= 64 for TS1 standard lots)
[8..12]   height u32 LE (= 64)
[12..16]  type u32 LE — bytes per tile
            1 = floor material id   (well-known)
            2 = object reference    (well-known)
            4 = altitude            (well-known)
            8 = walls (4 edge × 2B) (well-known)
            14 = rich tile data     (TS1-only, content TBD)
[16..20]  unknown u32 LE (= 1)
[20..]    RLE bit-stream
```

RLE algorithm (copied from FreeSO `ARRY.cs`, BSD):
- Read u16 `flre`. Stop on 0.
- High bit clear → raw fill: copy `flre` bytes to the output. If `flre` is
  odd, skip 1 pad byte (16-bit alignment).
- High bit set → run-fill: skip `flre & 0x7FFF` positions, fill them with
  the next byte, then 1 alignment byte, then a u16 size and copy `size`
  raw bytes. Negative size signals end.

Result: a row-major byte buffer of length `width * height * type`.

Per-Arry-id meaning empirically observed on House90.iff (64×64 lot, all
chunks decode without error):

| chunk id | type | bytes/tile | nonzero | guess                            |
| -------- | ---- | ---------- | ------- | -------------------------------- |
| 0        | 4    | altitude   | 9007    | terrain heightmap                |
| 1        | 1    | floor id   | 180     | ground floor materials           |
| 2        | 8    | walls      | 4213    | wall edges per tile (4×2B)       |
| 3        | 2    | objects    | 416     | objects placed (ground level)    |
| 4        | 1    | floor id   | 0       | second-floor materials (empty)   |
| 6, 7     | 1    | floor id   | 4069    | base ground / room flags         |
| 8        | 1    | floor id   | 2426    | grass / pool / water flags       |
| 11       | 2    | objects    | 358     | objects (alt level?)             |
| 12       | 14   | unknown    | 13276   | rich per-tile (room id + flags?) |
| 101..112 | mix  | mix        | varies  | second-story copies of 1..12     |

The well-known types (1/2/4/8) are documented; type 14 needs further reverse.

## ObjM / objt — placed objects

`ObjM` likely holds per-object metadata (name, owner, motive contributions),
`objt` the placement records (GUID, tile, rotation). **Not parsed.**

## THMB / BMP_ — thumbnails

The lot preview shown in the neighborhood selector. `THMB` is probably a
header pointing into one or more `BMP_` chunks. **Not parsed** — not
required to render the lot.

## SIMI — Sim metadata

One per lot, lists the Sims living there (32-bit instance ids, names,
needs, current activity). **Not parsed.**

## Path to actually rendering a House.iff

A self-honest plan:

1. **HOUS lot name** — DONE.
2. **FLRm / WALm material list decode** — DONE.
3. **Arry (well-known types 1/2/4/8)** — DONE (RLE decoder ported from
   FreeSO).
4. **Arry type 14** — TODO (multi-day, oracle TS1 sous Wine).
5. **ObjM / objt** — TODO (objects list with GUID + tile + rotation).
6. **Wire client renderer** — TODO. The Rust + WASM side now exposes
   `parseHous`, `parseFlrm`, `parseArry`. The client must:
   - Add `/api/templates` endpoint listing `.iff` files in
     `TemplateMagictown/` (server-side).
   - Add a "Load House" button that fetches the IFF, parses HOUS + FLRm[0]
     + Arry[id=1] (floor materials) + Arry[id=2] (walls), and populates the
     existing `floorPaint` Map / `wallsN` / `wallsW` sets so the iso
     renderer picks them up automatically.
   - Map FLRm `id` field → `.flr` filename → some preview color (until the
     SPR2 inside each `.flr` is decoded too).

## ObjM / objt — placed objects

`ObjM` likely holds per-object metadata (name, owner, motive contributions),
`objt` the placement records (GUID, tile, rotation). **Not parsed.**

## THMB / BMP_ — thumbnails

The lot preview shown in the neighborhood selector. `THMB` is probably a
header pointing into one or more `BMP_` chunks. **Not parsed** — not
required to render the lot.

## SIMI — Sim metadata

One per lot, lists the Sims living there (32-bit instance ids, names,
needs, current activity). **Not parsed.**

## Path to actually rendering a House.iff

A self-honest plan:

1. **HOUS lot name** — DONE.
2. **`Arry` floor tile array reverse** — multi-day. Needs:
   - One simple lot (e.g. an empty starter lot from `Template/`) used as
     the "minimal" sample.
   - Cross-reference with a tile-by-tile screenshot taken under Wine.
   - Bisection on the byte-stream until we recognize the floor material
     ids referenced from `FLRm`.
3. **`Arry` wall edge array reverse** — same workflow, after #2.
4. **`FLRm` / `WALm` material list decode** — needed to map tile-array
   material indices to actual `.flr` / `.wll` filenames.
5. Wire up the client renderer with the decoded grid.

Each step is bisection-heavy and needs an oracle (running TS1 under Wine
and reading the raw IFF after a known edit). Out of scope for this
session.
