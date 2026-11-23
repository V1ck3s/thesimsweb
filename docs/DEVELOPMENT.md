# Development guide

## Prerequisites

- Node 22+ with `corepack` enabled (provides `pnpm`).
- Rust stable 1.85+ with `wasm32-unknown-unknown` target.
- `wasm-pack` 0.14+.

Bootstrap: install the tools above, then `pnpm install` and `wasm-pack build --target web --scope thesimsweb crates/wasm-bindings`.

## Layout

| Path | Role |
|---|---|
| `client/` | Vite + TS strict frontend: `game.html` / `src/game/` (the game ported from the decompilation) + WASM bridge. |
| `server/` | Fastify dev backend. Streams `server/assets/*` with Range, writes saves to the overlay `server/data/overlay/`, serves the built client. |
| `crates/iff` | Maxis IFF parser, `#![no_std]`. |
| `crates/far` | FAR! archive parser, `#![no_std]`. |
| `crates/sprite` | SPR2 / RLE / palette decoder, `#![no_std]`. |
| `crates/wasm-bindings` | `cdylib` re-exporting the parsers via `wasm-bindgen`. Built with `wasm-pack`. |
| `docs/` | Format specs and design decisions. |
| `samples/` | Local-only fixtures from the user's game install. **Gitignored.** |

## Common commands

The `justfile` at the repo root wraps everything. If `just` isn't installed (`apt install just`), copy each recipe by hand.

```bash
just install       # pnpm install (first run)
just build-wasm    # wasm-pack build for the engine — needed before client dev
just dev           # client (5173) + server (3000) in parallel
just test          # vitest + cargo test --workspace
just typecheck     # tsc --noEmit on every TS package
just lint          # eslint (TODO config) + cargo clippy
just fmt           # prettier + cargo fmt
just build         # production build (TS + WASM)
```

## TypeScript

The repo uses an aggressive strict mode (see `tsconfig.base.json`):

- `noUncheckedIndexedAccess` — array/object access returns `T | undefined`.
- `exactOptionalPropertyTypes` — `{ x?: T }` ≠ `{ x: T | undefined }`.
- `verbatimModuleSyntax` — explicit `import type` is mandatory.

Type narrowing through callbacks/closures is fragile in TS. Prefer
`function findX(): NonNullable<T>` helpers that do the assertion once.

## Rust crates

- All `#![no_std]` and `unsafe_code = "forbid"` at the workspace level.
- `clippy::pedantic` + `clippy::nursery` enabled. Use `#[allow(clippy::xxx)]` sparingly with a justification comment.
- Big-endian helpers when parsing Maxis IFF chunk headers; little-endian inside chunk payloads.
- Tests live alongside `lib.rs` in `mod tests`. Run with `cargo test --workspace`.

## WASM bridge

```text
crates/wasm-bindings/  →  wasm-pack build --target web --scope thesimsweb
                       ↓
            crates/wasm-bindings/pkg/   (gitignored, regenerated)
                       ↓
   @thesimsweb/wasm-bindings (npm name, pnpm workspace package)
                       ↓
            client/src/engine/wasm.ts (typed lazy initialiser)
```

Vite finds the `.wasm` file through the workspace import and emits it as a
hashed asset (`dist/assets/wasm_bindings_bg-<hash>.wasm`). Production build
weighs ~25 KB total at present (HTML + JS + WASM, gzipped JS ≈ 3 KB).

## Server endpoints

- `GET /api/health` → `{ ok: true }`.
- `GET /api/manifest` → `{ version, assetsRoot, files: [{ path, size, kind }] }` walked from `server/assets/`.
- `GET /assets/<path>` → static file with `Range`, `ETag`, `Cache-Control: public, max-age=3600`.
- `POST /api/ranges` → batched byte-range reads.
- `PUT` / `DELETE /api/files/Sims/UserData*/<path>` → save files in the overlay `server/data/overlay/`.

## Adding a new Rust function callable from TS

1. Implement and unit-test the function in the relevant crate (`iff`, `far`, `sprite`).
2. Re-export through `crates/wasm-bindings/src/lib.rs` with a `#[wasm_bindgen]` wrapper. Convert errors to `JsError`.
3. `wasm-pack build --target web --scope thesimsweb crates/wasm-bindings`.
4. Use it in TS via `import { yourFn } from "@thesimsweb/wasm-bindings"` and `await engine()` to ensure init.

## Differential testing strategy

For every parser we ship, we keep a regression suite that compares our
output against an external oracle. Examples:

- FAR extraction: compare bytes-per-entry against
  [TS1-FAR-Unpack](https://github.com/samulated/TS1-FAR-Unpack) on a held
  set of `.far` from the local install.
- IFF chunk enumeration: compare against IFFSnooper exports on the same
  files.
- SPR2 decoding: compare RGBA8 outputs (PNG) against IFFSnooper.

These tests live in `samples/` (gitignored — fixtures come from the user's
install, never committed).
