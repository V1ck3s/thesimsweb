# Production image: the built game (client/dist) served by the Fastify server.
# The game files are NOT in the image: mount the install folder of The Sims at
# /app/server/assets/Sims (read-only). Saves go to /app/server/data/overlay.
# See docker-compose.yml and docs/docker.md.

# --- 1. WASM engine (Rust crates -> crates/wasm-bindings/pkg) -----------------
FROM rust:1.95-slim-bookworm AS wasm
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && rustup target add wasm32-unknown-unknown \
 && curl -sSfL https://github.com/rustwasm/wasm-pack/releases/download/v0.14.0/wasm-pack-v0.14.0-x86_64-unknown-linux-musl.tar.gz \
    | tar -xz --strip-components=1 -C /usr/local/bin wasm-pack-v0.14.0-x86_64-unknown-linux-musl/wasm-pack
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN wasm-pack build --target web --scope thesimsweb crates/wasm-bindings

# --- 2. Client bundle and server (pnpm workspace) -----------------------------
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY client/package.json client/
COPY server/package.json server/
COPY --from=wasm /src/crates/wasm-bindings/pkg crates/wasm-bindings/pkg
RUN pnpm install --frozen-lockfile
COPY client client
COPY server server
RUN pnpm --filter @thesimsweb/client --filter @thesimsweb/server run build \
 && pnpm --filter @thesimsweb/server deploy --prod --legacy /out/server \
 && cp -r server/dist /out/server/dist

# --- 3. Runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build /out/server server
COPY --from=build /src/client/dist client/dist
# Mount points: the game folder (read-only) and the saves overlay (writable).
RUN mkdir -p server/assets/Sims server/data/overlay && chown -R node:node server/data
USER node
EXPOSE 3000
VOLUME ["/app/server/data/overlay"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
