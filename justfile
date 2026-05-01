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
    @echo "TODO: wasm-pack builds for crates/wasm-bindings — phase 0bis"

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

# clean build artifacts (keeps node_modules and target caches)
clean:
    rm -rf client/dist server/dist
    cargo clean
