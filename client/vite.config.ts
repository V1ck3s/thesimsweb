import { fileURLToPath } from "node:url";
import { defineConfig, type Connect, type Plugin } from "vite";

/**
 * The game (game.html, src/game/) is the page served at "/".
 */
function gameAsRoot(): Plugin {
  const rewrite: Connect.NextHandleFunction = (req, _res, next) => {
    const url = req.url ?? "/";
    const q = url.indexOf("?");
    const path = q < 0 ? url : url.slice(0, q);
    if (path === "/" || path === "/index.html") req.url = `/game.html${q < 0 ? "" : url.slice(q)}`;
    next();
  };
  return {
    name: "game-as-root",
    configureServer(server) {
      server.middlewares.use(rewrite);
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewrite);
    },
  };
}

export default defineConfig({
  plugins: [gameAsRoot()],
  server: {
    port: 5173,
    strictPort: true,
    // File events do not cross the WSL2 /mnt/c boundary reliably.
    watch: { usePolling: true, interval: 300 },
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/assets": "http://127.0.0.1:3000",
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
        game: fileURLToPath(new URL("game.html", import.meta.url)),
      },
    },
  },
});
