import { defineConfig } from "vite";

export default defineConfig({
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
    sourcemap: true,
  },
});
