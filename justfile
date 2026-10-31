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

# build everything (WASM + client bundle + server)
build:
    pnpm build

# production: build what is stale, then serve the game on http://127.0.0.1:3000/
start *args:
    pnpm start {{args}}

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

# regression test: re-dump every sample IFF in samples/iff/ and diff against goldens.
diff-iff:
    ./scripts/diff/iff.sh

# differential test: compare our SimAntics VM trace against an oracle JSONL.
# See docs/diff/vm-trace.md for the schema. Needs a FreeSO/Simitone-emitted
# oracle file (not bundled).
diff-vm object oracle event="1" *globals_far="":
    ./scripts/diff/vm.sh --object {{object}} --oracle {{oracle}} --event {{event}} {{ if globals_far != "" { "--globals-far " + globals_far } else { "" } }}

# clean build artifacts (keeps node_modules and target caches)
clean:
    rm -rf client/dist server/dist
    cargo clean
