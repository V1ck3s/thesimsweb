# SLOT — routing slot table

> Sources:
> - Empirical hexdump of `samples/iff/AlarmClock.iff` (v10, count=2) and
>   `samples/iff/unsnacker.iff` (v6, count=1).
> - Niotso wiki page [`IFF`](http://wiki.niotso.org/IFF) lists `SLOT` in the
>   chunk-type table but does not document its internal layout.
> - FreeSO/Simitone source has a v10 decoder; we do **not** copy from it,
>   only use it as a reference oracle when our reverse stalls.

A `SLOT` chunk describes the *routing slots* an object exposes — i.e. the
tile-relative positions and headings a Sim must reach to perform an
interaction. For an alarm clock the slot is "in front of the table"; for a
chair it's "sit on the cushion"; for a bed it's "lie down here".

The `OBJD.slot_id` field (index 18) names which `SLOT` chunk applies to a
given object. A single `SLOT` chunk can hold multiple slots (see
`AlarmClock` v10 with 2 slots).

## Header (16 bytes)

The chunk data starts with a fixed 16-byte header. Bytes are little-endian.

| Offset | Size | Field      | Notes                                        |
|--------|------|------------|----------------------------------------------|
| 0      | 4    | reserved   | Always `0` in the samples we've inspected.   |
| 4      | 4    | version    | `6` (older) or `10` (newer / interactive).    |
| 8      | 4    | magic      | ASCII `"TOLS"` (= `"SLOT"` reversed).        |
| 12     | 4    | count      | Number of per-slot records that follow.      |

The reserved zero word at offset 0 means a naive reader that starts at
offset 0 sees `0x00000000` for "version", which is why a leading scan must
land on the `"TOLS"` magic before trusting the version.

## Per-slot records

Empirical record sizes from real samples:

| Version | Record size | Total expected               | Sample             |
|---------|-------------|------------------------------|--------------------|
| 6       | 58 bytes    | `16 + count * 58`            | `unsnacker.iff`    |
| 10      | 72 bytes    | `16 + count * 72`            | `AlarmClock.iff`   |

The internal layout of each record is **not yet decoded by this crate**.
What we know empirically (from the AlarmClock v10 records):

```
v10 record 0 (slot 0, "in front of clock"):
  10 00 00 00     unknown — possibly a slot type/ID
  10 00 00 00     unknown
  10 00 00 00     unknown
  0a 00 00 00     unknown — maybe distance bound (10 fixed-point?)
  00 00 00 00     padding/reserved
  00 00 40 3e     IEEE-754 float — likely heading or scale (≈ 0.1875)
  03 00 00 00     unknown
  fe ff ff ff     -2 (LE i32) — possibly a slot kind enum
  10 00 00 00     unknown
  01 00 00 00     unknown
  00 00 00 00 00 00 00 00 00 00 00 00 00 00 80 3f     ≈ 1.0 float at the tail
                  …36 bytes total trailing zeros + a single 1.0f
```

Without cross-referencing FreeSO/Simitone the field names remain conjectural;
we keep the records as raw bytes (`Slot::raw_records`) until the multi-tile
placement work needs them to drive routing.

## What our parser exposes

`simantics::Slot::parse(data: &[u8]) -> Result<Slot, SimAnticsError>` returns:

```rust
pub struct Slot {
    pub version: u32,         // 6 or 10
    pub count: u32,
    pub raw_records: Vec<u8>, // count * record_size bytes
}
```

Tests:
- `tests::slot_v6_round_trip` — synthetic v6 with 3 records, parses cleanly.
- `tests::slot_rejects_bad_magic` / `tests::slot_rejects_truncated_header`.
- `tests/real_catalog.rs::alarm_clock_slot_is_v10_with_two_routing_slots` —
  parses the real AlarmClock SLOT (140 bytes of records).
- `tests/real_catalog.rs::unsnacker_slot_is_v6_with_one_routing_slot` —
  parses the real unsnacker SLOT (54 bytes of records).

WASM binding: `parseSlot(chunkData) → { version, count, rawRecordsLen }`.

## Multi-tile footprint (separate from SLOT)

Multi-tile object footprints (a 2×2 sofa, a 1×4 wall shelf) come from
`OBJD.master_id` + `OBJD.sub_index` — **not** from SLOT. SLOT only models
*where Sims stand to interact*, not *what tiles the object occupies*.

The footprint helper lives at `simantics::objd_footprint_from_chunks(payloads, master_id)`
and is exposed via WASM as `objdFootprint(iffBytes, masterId) → [{x, y}, …]`.
