# docs/

Living documentation for the project. Everything more permanent than a
journal entry in `PLAN.md` lives here.

## Index

- [`DEVELOPMENT.md`](./DEVELOPMENT.md) — repo layout, build commands, conventions, how to add a new Rust function callable from TS.
- [`decision-A-vs-D.md`](./decision-A-vs-D.md) — record of the v86/Boxedwine emulation spike and why we rejected the in-browser emulation approach in favour of clean-room reimplementation.
- [`formats/`](./formats/) — Phase 1 work. One file per binary format we have to parse, **plus** [`formats/_niotso/`](./formats/_niotso/) holding clean-Markdown snapshots of the [Niotso wiki](http://wiki.niotso.org) (instable upstream). Re-snapshot with `python3 scripts/niotso-to-md.py <page.html> <out.md>`.

| Format | Our spec | Niotso snapshot | Status |
|---|---|---|---|
| FAR | [`formats/FAR.md`](./formats/FAR.md) | [`_niotso/FAR.md`](./formats/_niotso/FAR.md) | ✅ documented + parser + diff test |
| IFF | _todo_ | [`_niotso/IFF.md`](./formats/_niotso/IFF.md) | header-only parser |
| SPR2 | _todo_ | covered inside IFF | stub crate |
| SimAntics (BHAV/BCON) | _todo_ | [`_niotso/SimAntics.md`](./formats/_niotso/SimAntics.md) | not started |
| HIT | _todo_ | [`_niotso/HIT.md`](./formats/_niotso/HIT.md) | not started |
| RefPack | _todo (TSO only)_ | [`_niotso/RefPack.md`](./formats/_niotso/RefPack.md) | out of scope for v1 |

## Format-doc convention

When we start documenting a format, follow this template per file:

```markdown
# <FORMAT NAME>

> Source: <URL or "Niotso wiki snapshot 2026-MM-DD">

## Magic / signature

## Header

| Offset | Size | Endianness | Field | Notes |
|---|---|---|---|---|

## Chunks / sections

## Edge cases observed

## Differential test references

## Open questions
```

Keep it terse. The goal is a parser-friendly spec, not narrative.
