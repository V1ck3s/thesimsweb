import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, transformWithEsbuild, type Connect, type Plugin } from "vite";

/**
 * "/" is the landing page (index.html, src/landing/); the game is game.html
 * (src/game/). "/" with a query string (bookmarks from before the landing
 * page: /?house=1, /?nbhd=UserData2, /?test=lot) still starts the game, like
 * the server's route (server/src/routes/client.ts).
 */
function gameWithQuery(): Plugin {
  const rewrite: Connect.NextHandleFunction = (req, _res, next) => {
    const url = req.url ?? "/";
    const q = url.indexOf("?");
    const path = q < 0 ? url : url.slice(0, q);
    if (q >= 0 && q < url.length - 1 && (path === "/" || path === "/index.html")) req.url = `/game.html${url.slice(q)}`;
    next();
  };
  return {
    name: "game-with-query",
    configureServer(server) {
      server.middlewares.use(rewrite);
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewrite);
    },
  };
}

/** Files of public/ the service worker precaches with the bundles. */
const PUBLIC_SHELL = ["/manifest.webmanifest", "/webpages-compat.js", "/icons/icon.svg", "/icons/icon-192.png", "/icons/icon-512.png"];

/**
 * Builds the service worker (src/sw/sw.ts) to /sw.js, with the list of the
 * build's files to precache (pages, bundles, WASM; not the source maps) and a
 * hash of their content as its version. Build only: the dev server has none.
 */
function serviceWorker(): Plugin {
  return {
    name: "service-worker",
    apply: "build",
    enforce: "post",
    async generateBundle(_options, bundle) {
      const hash = createHash("sha256");
      const files: string[] = [];
      for (const [name, out] of Object.entries(bundle).sort(([a], [b]) => a.localeCompare(b))) {
        if (name.endsWith(".map")) continue;
        files.push(`/${name}`);
        hash.update(name).update(out.type === "chunk" ? out.code : out.source);
      }
      const shell = [...new Set(["/index.html", "/game.html", ...files, ...PUBLIC_SHELL])];
      const source = readFileSync(fileURLToPath(new URL("src/sw/sw.ts", import.meta.url)), "utf8");
      const { code } = await transformWithEsbuild(source, "sw.ts", { loader: "ts", target: "es2022", format: "esm" });
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: code
          .replaceAll("__SW_SHELL__", JSON.stringify(shell))
          .replaceAll("__SW_VERSION__", JSON.stringify(hash.digest("hex").slice(0, 16))),
      });
    },
  };
}

export default defineConfig({
  plugins: [gameWithQuery(), serviceWorker()],
  server: {
    port: 5173,
    strictPort: true,
    // File events do not cross the WSL2 /mnt/c boundary reliably.
    // VITE_POLL_INTERVAL (ms) slows the polling when several dev servers share the disk.
    watch: { usePolling: true, interval: Number(process.env["VITE_POLL_INTERVAL"] ?? 300) },
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/assets": "http://127.0.0.1:3000",
      "/webpages": "http://127.0.0.1:3000",
    },
  },
  build: {
    target: "es2022",
    // The server owns `/assets/` (the game folder): hashed bundle files go to
    // `/static/` instead, served with an immutable cache by server/src/routes/client.ts.
    assetsDir: "static",
    // The game is one ~1 MB chunk (plus lazy dev tests); nothing to split.
    chunkSizeWarningLimit: 2048,
    sourcemap: true,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("index.html", import.meta.url)),
        game: fileURLToPath(new URL("game.html", import.meta.url)),
      },
    },
  },
});
