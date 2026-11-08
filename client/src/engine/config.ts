/**
 * The instance's settings (GET /api/config, server/src/index.ts), asked once
 * per page:
 *
 * - `saves`: where the saves live ("server" or "client", engine/saves.ts);
 * - `gameFiles`: where the game files come from: "server" (the game folder
 *   on the server, /assets/) or "client" (each player's own install folder,
 *   imported into this browser, engine/gamefiles.ts);
 * - `preload`: whether the game downloads the files nearly every session
 *   reads at start-up (game/preload.ts; the server's PRELOAD, off by default).
 *
 * A server that does not answer (offline without a kept answer, an older
 * server) counts as the defaults: both "server", no preload.
 */

export interface ServerConfig {
  saves: "server" | "client";
  gameFiles: "server" | "client";
  preload: boolean;
}

let config: Promise<ServerConfig> | null = null;

export function getServerConfig(): Promise<ServerConfig> {
  config ??= (async (): Promise<ServerConfig> => {
    try {
      const res = await fetch("/api/config", { cache: "no-store" });
      if (!res.ok) return { saves: "server", gameFiles: "server", preload: false };
      const cfg = (await res.json()) as { saves?: unknown; gameFiles?: unknown; preload?: unknown };
      const gameFiles = cfg.gameFiles === "client" ? "client" : "server";
      // (game files in the browser: the saves are too, whatever the server says)
      return { saves: cfg.saves === "client" || gameFiles === "client" ? "client" : "server", gameFiles, preload: cfg.preload === true && gameFiles === "server" };
    } catch {
      return { saves: "server", gameFiles: "server", preload: false };
    }
  })();
  return config;
}
