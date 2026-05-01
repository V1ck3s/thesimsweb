# thesimsweb — common dev commands. Install `just` once: `cargo install just`
# (or `apt install just` on recent Debian).

# default: list available recipes
default:
    @just --list

# install all JS deps (root + workspaces)
install:
    pnpm install

# run client + server together (Vite dev + Fastify dev)
dev:
    pnpm dev

# run only the client
dev-client:
    pnpm --filter @thesimsweb/client dev

# run only the server
dev-server:
    pnpm --filter @thesimsweb/server dev

# build everything (TS + WASM)
build: build-wasm build-ts

build-ts:
    pnpm build

build-wasm:
    wasm-pack build --target web --scope thesimsweb crates/wasm-bindings

# lint
lint:
    pnpm lint
    cargo clippy --workspace --all-targets

# format
fmt:
    pnpm exec prettier --write .
    cargo fmt --all

# typecheck (no emit)
typecheck:
    pnpm typecheck

# tests
test:
    pnpm test
    cargo test --workspace

# differential test: compare our FAR extraction against TS1-FAR-Unpack.
# Requires git + python3; clones the oracle on first run.
diff-far archive:
    ./scripts/diff/far.sh {{archive}}

# clean build artifacts (keeps node_modules and target caches)
clean:
    rm -rf client/dist server/dist
    cargo clean
