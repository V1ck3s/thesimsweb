# docs/

Living documentation for the project. Everything more permanent than a
journal entry in `PLAN.md` lives here.

## Index

- [`DEVELOPMENT.md`](./DEVELOPMENT.md) — repo layout, build commands, conventions, how to add a new Rust function callable from TS.
- [`decision-A-vs-D.md`](./decision-A-vs-D.md) — record of the v86/Boxedwine emulation spike and why we rejected the in-browser emulation approach in favour of clean-room reimplementation.
- `formats/` — _to be filled in Phase 1._ One file per binary format we have to parse (IFF, FAR, SPR2, BHAV/SimAntics, HIT). Local copies of the [Niotso wiki](http://wiki.niotso.org) so we don't depend on an unstable upstream.

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
