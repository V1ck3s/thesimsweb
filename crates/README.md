# Rust crates

Workspace for the parser/decoder hot paths. Compiled to WebAssembly via
`wasm-bindings/` and consumed by `client/`.

| Crate | Role |
|---|---|
| `iff` | Maxis IFF container parser (header + chunk enumeration). |
| `far` | FAR! archive parser (table of contents, lazy entry extraction). |
| `sprite` | SPR2 / RLE decoder + PALT palette resolution → RGBA8. |
| `wasm-bindings` | `cdylib` exposing the above to JS via `wasm-bindgen`. |

All three core crates are `#![no_std]` and free of `unsafe`.

## Build

```bash
# All native tests
cargo test --workspace

# WASM module consumed by the client
wasm-pack build --target web crates/wasm-bindings
# → crates/wasm-bindings/pkg/
```

## Why `no_std`

These run inside WebAssembly. Avoiding `std` keeps the binary small and the
allocations explicit. We pull in `alloc` only where genuinely needed (none yet).
