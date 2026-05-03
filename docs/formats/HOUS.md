# HOUS / FLRm / WALm / Arry — house file chunks

> Sources:
> - Empirical hexdump of `/mnt/c/Program Files (x86)/Maxis/Les Sims/TemplateMagictown/House90.iff`
>   (255 396 B — full lot save).
> - Niotso wiki page [`IFF`](http://wiki.niotso.org/IFF) — listed in the
>   chunk-type table but layout is **not** documented.
> - FreeSO/Simitone has decoders we have not copied (lecture-référence only).

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

Variable-length list of records. **Not parsed**.

Empirical structure (`House90.iff/FLRm[id=0]`, 232 data bytes):

```
[0..8]    8 zero bytes (reserved?)
[8..12]   "mRLF" magic (= "FLRm" reversed)
[12..16]  version u32 LE = 6
[16..]    repeating records, each:
            C-string (floor IFF filename, e.g. "floormagictuscantileceramic.flr\0")
            ~10 bytes of metadata (count? id? hash?)
```

A House lot has 2 FLRm chunks (id=0 and id=1, possibly two floor levels —
ground and second story). The records list every distinct floor material
referenced by the lot's tile array.

## WALm — wall material assignments

Same shape as `FLRm` but for wall textures (e.g. `wallpaperflowery.wll`).
Two WALm chunks (id=0 / id=1) per house, 402 + 420 data bytes in
House90.iff. **Not parsed**.

## Arry — tile arrays (the actual geometry)

The big payload chunks (3 374 + 24 + 474 + … + 40 516 bytes in House90.iff).
**Not parsed — this is the heart of the reverse work.**

Niotso doesn't document the layout. Plausible interpretation given the
sizes:
- `id=0` (3 374 B) = the **floor tile array**: a 2D grid of (material id,
  flags) tuples. For a 64×64 lot at 1 byte each that's 4 096 B — close.
- `id=12` (40 516 B) = the **wall edge array**: tile-edge keyed list of
  (material id, flags, segment kind) — fits a 64×64 grid with 2 edges per
  tile and ~4 bytes per edge.
- Other Arry IDs likely cover roofs, lights, water, plants, doors,
  windows.

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
