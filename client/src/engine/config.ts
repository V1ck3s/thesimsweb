/**
 * The instance's settings (GET /api/config, server/src/index.ts), asked once
 * per page:
 *
 * - `saves`: where the saves live ("server" or "client", engine/saves.ts);
 * - `gameFiles`: where the game files come from: "server" (the game folder
 *   on the server, /assets/) or "client" (each player's own install folder,
 *   imported into this browser, engine/gamefiles.ts).
 *
 * A server that does not answer (offline without a kept answer, an older
 * server) counts as the defaults: both "server".
 */

export interface ServerConfig {
  saves: "server" | "client";
  gameFiles: "server" | "client";
}

let config: Promise<ServerConfig> | null = null;

export function getServerConfig(): Promise<ServerConfig> {
  config ??= (async (): Promise<ServerConfig> => {
    try {
      const res = await fetch("/api/config", { cache: "no-store" });
      if (!res.ok) return { saves: "server", gameFiles: "server" };
      const cfg = (await res.json()) as { saves?: unknown; gameFiles?: unknown };
      const gameFiles = cfg.gameFiles === "client" ? "client" : "server";
      // (game files in the browser: the saves are too, whatever the server says)
      return { saves: cfg.saves === "client" || gameFiles === "client" ? "client" : "server", gameFiles };
    } catch {
      return { saves: "server", gameFiles: "server" };
    }
  })();
  return config;
}
