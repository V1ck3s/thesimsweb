#!/usr/bin/env node
// Production start: builds what is stale (WASM engine, client bundle, server),
// then runs the Fastify server, which serves the game at "/".
//
//   pnpm start                  # http://127.0.0.1:3000/
//   pnpm start --port 4000      # or PORT=4000 pnpm start
//   pnpm start --rebuild        # force every build step
//   pnpm start --no-build       # never build, just run
//
// HOST (default 127.0.0.1) and PORT are passed through to server/src/index.ts.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const opt = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const port = opt("--port") ?? process.env.PORT ?? "3000";
const host = opt("--host") ?? process.env.HOST ?? "127.0.0.1";
const force = has("--rebuild");
const skip = has("--no-build");

/** Newest mtime (ms) under the given files/directories; 0 when none exist. */
function newest(paths, skipDirs = new Set(["node_modules", "target", "pkg", "dist"])) {
  let max = 0;
  const walk = (p) => {
    let st;
    try {
      st = statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) if (!skipDirs.has(name)) walk(join(p, name));
    } else if (st.mtimeMs > max) max = st.mtimeMs;
  };
  for (const p of paths) walk(join(root, p));
  return max;
}

const mtime = (p) => (existsSync(join(root, p)) ? statSync(join(root, p)).mtimeMs : 0);

function run(label, cmd, cmdArgs) {
  console.log(`\n> ${label}: ${cmd} ${cmdArgs.join(" ")}`);
  const r = spawnSync(cmd, cmdArgs, { cwd: root, stdio: "inherit" });
  if (r.error) {
    console.error(`${label} failed: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (!skip) {
  // 1. The Rust engine (iff/far/sprite parsers, XA decoder) as WASM.
  const wasmOut = "crates/wasm-bindings/pkg/wasm_bindings_bg.wasm";
  const crateDirs = readdirSync(join(root, "crates")).map((d) => `crates/${d}`);
  if (force || mtime(wasmOut) < newest(["Cargo.toml", "Cargo.lock", ...crateDirs])) {
    run("wasm", "wasm-pack", ["build", "--target", "web", "--scope", "thesimsweb", "crates/wasm-bindings"]);
  }
  // 2. The client bundle (tsc --noEmit + vite build → client/dist).
  const clientOut = "client/dist/game.html";
  if (force || mtime(clientOut) < newest(["client/src", "client/game.html", "client/vite.config.ts", "client/package.json", wasmOut])) {
    run("client", "pnpm", ["--filter", "@thesimsweb/client", "run", "build"]);
  }
  // 3. The server (tsc → server/dist).
  const serverOut = "server/dist/index.js";
  if (force || mtime(serverOut) < newest(["server/src", "server/package.json", "server/tsconfig.json"])) {
    run("server", "pnpm", ["--filter", "@thesimsweb/server", "run", "build"]);
  }
}

if (!existsSync(join(root, "server/dist/index.js")) || !existsSync(join(root, "client/dist/game.html"))) {
  console.error("nothing built: run `pnpm build` (or `pnpm start` without --no-build)");
  process.exit(1);
}
if (!existsSync(join(root, "server/assets"))) {
  console.warn("warning: server/assets/ is missing; link the game folder first (see README.md)");
}

console.log(`\n> starting the server: http://${host === "0.0.0.0" ? "localhost" : host}:${port}/\n`);
const child = spawn(process.execPath, ["server/dist/index.js"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, PORT: port, HOST: host },
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
