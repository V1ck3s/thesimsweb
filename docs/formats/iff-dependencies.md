# IFF chunk dependencies

A TS1 IFF file is a flat list of chunks but the runtime semantics are deeply
graph-shaped. Many chunks point to other chunks **by id**, and a few point
across IFF boundaries via `globals.iff`. This doc maps the references so we
know which parser fields need a lookup pipeline.

For wire-level layout of each chunk see the format-specific files
(`SimAntics.md`, `SPR2.md`, `Catalog.md`, `IFF.md`).

```
                                 (per object .iff)
   ┌────────────────────────────────────────────────────────────┐
   │  OBJD (id 0..N) — catalog metadata                          │
   │     ├── field 1   "base graphic id"  → DGRP id              │
   │     ├── field 5   "ttab id"          → TTAB / TTAs id       │
   │     ├── field 11  "anim table id"    → CTSS id              │
   │     ├── field 16  "price" (used by economy)                 │
   │     └── field 18  "slot id"          → SLOT id (footprint)  │
   │                                                             │
   │  OBJf (id matches OBJD)                                     │
   │     events 0..15  → BHAV id (action = 0 means unbound)      │
   │     events 0..15  → BHAV id (condition / guard)             │
   │                                                             │
   │  TTAB (id from OBJD field 5)                                │
   │     interaction.action_function  → BHAV id                  │
   │     interaction.guard_function   → BHAV id                  │
   │     interaction.ttas_index       → row in TTAs              │
   │                                                             │
   │  TTAs (same id as TTAB) — STR# v-3 multi-language strings   │
   │     ↑ index from TTAB.ttas_index                            │
   │                                                             │
   │  BHAV (private 0x1000..0x1FFF)                              │
   │     instr.opcode = 0..255      → primitive                  │
   │     instr.opcode = 0x100..0xFFF → semi-global BHAV          │
   │     instr.opcode = 0x1000..0x1FFF → another private BHAV    │
   │     instr.opcode = 0x2000+      → global BHAV (behavior.iff)│
   │     operand referencing BCON   → BCON id                    │
   │     operand referencing FWAV   → FWAV id (Play Sound)       │
   │                                                             │
   │  BCON (id referenced by BHAV operand) — constant pool        │
   │                                                             │
   │  DGRP (id from OBJD field 1, plus id+1, id+2 … per state)   │
   │     image.directionFlags × image.zoomLevel                  │
   │       sprite.spr_chunk_id  → SPR2 id                        │
   │       sprite.spr_frame_no  → frame within SPR2              │
   │                                                             │
   │  SPR2 (id from DGRP) — RLE bitmap frames                    │
   │     palette ref          → PALT id (almost always 0)        │
   │                                                             │
   │  PALT (id 0)             — 256-entry RGB palette            │
   │                                                             │
   │  FWAV (id referenced by BHAV PlaySound operand)             │
   │     contains a UTF-8 C-string event name                    │
   │       → HOT [EventMapping] event_name → track id            │
   │       → HOT [TrackData] track id → byte offset in HIT       │
   │       → HOT [Patch] patch ref → .xa file path               │
   │                                                             │
   │  GLOB (one per .iff or zero)                                │
   │     semi_global_name (C-string, e.g. "AlarmClock")          │
   │       → resolves at runtime to a .iff loaded from globals   │
   └────────────────────────────────────────────────────────────┘

   ┌─ globals.iff (semi-globals) ────────────────────────────────┐
   │  BHAV ids 0x100..0xFFF                                      │
   │  BCON, STR#, OBJf …                                         │
   │  Selected dynamically from the *caller's* GLOB chunk        │
   └─────────────────────────────────────────────────────────────┘

   ┌─ behavior.iff (globals) ────────────────────────────────────┐
   │  BHAV ids ≥ 0x2000 — generic motion / dialog primitives     │
   │  BCON, STR# — UI strings, error messages                    │
   └─────────────────────────────────────────────────────────────┘
```

## Resolution order at call time

When the VM dispatches a `BHAV` instruction whose opcode is itself a BHAV
reference (i.e. ≥ 256), it picks the source by range:

| Opcode range | Source | Loaded from |
|---|---|---|
| `0x0000..0x00FF` | primitive | engine code (no IFF lookup) |
| `0x0100..0x0FFF` | semi-global BHAV | the IFF named by this object's `GLOB` chunk |
| `0x1000..0x1FFF` | private BHAV | the *current* object IFF |
| `0x2000+`        | global BHAV | `behavior.iff` |

`crates/simantics::vm::LayeredBhavSource` implements exactly this priority
ordering. It accepts three `BhavSource` slots (private / semi-global / global)
and returns the appropriate one based on the opcode.

## Cross-object references

A few chunks point *across* lots:

- `OBJD.guid` is the canonical 32-bit identifier used by `Test Object Type`
  (#32) and `Set to Next` (#31) when walking the catalog.
- `Push Interaction` (#13) and `Run Tree by Name` (#28) reference an object
  by its instance id (assigned at lot load time, not stored in the IFF).
- `Create New Object Instance` (#42) takes a GUID and a tile coord — the new
  instance gets a fresh id and is appended to the lot's `world.objects`.

## Phase 1 close-out

- [x] FAR, IFF, SPR2, SimAntics, HIT, Catalog formats documented.
- [x] **This file** — chunk dependency map.
- [ ] HOUSE-format chunks (`FLRm`, `WALm`, `Arry`) still need empirical
  reverse to load `*.iff` lots from the install. Tracked under Phase 3.
