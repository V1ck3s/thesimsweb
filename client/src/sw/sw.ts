/**
 * Service worker (built to /sw.js by the "service-worker" plugin of
 * vite.config.ts; registered by engine/pwa.ts in production builds only).
 *
 * What it keeps, so that a game already played on this device starts offline:
 *
 * - The app shell: the HTML pages, the hashed bundles (/static/*), the web
 *   manifest and icons, precached at install (cache "shell-<build>", the old
 *   builds' caches dropped on activation). Pages are network-first (an online
 *   start always gets the current build), bundles cache-first.
 * - The server answers the page does not keep itself, network-first with
 *   the last answer kept (cache "data"): /api/config, /api/manifest, and
 *   every whole-file read under /assets/ (no Range header, up to 8 MiB): the
 *   save files (Sims/UserData*: houses, characters, neighborhood; a 404 is
 *   kept too, the game probes for absent files) and the loose game files the
 *   game reads with plain requests (roof, wall and floor bitmaps, cursors).
 *   Offline, a Range request or a POST /api/ranges batch over a kept file is
 *   answered from it.
 *
 * Range reads of the game folder (FAR archives) are not touched: the page
 * keeps what it read in IndexedDB (engine/idb.ts). What was never read needs
 * the server (a lot never visited, catalog pages never opened, music tracks,
 * which are streamed).
 */

declare const self: ServiceWorkerGlobalScope;
/** Replaced at build time (vite.config.ts): the shell's URLs and a hash of the build. */
declare const __SW_SHELL__: string[];
declare const __SW_VERSION__: string;

const SHELL_CACHE = `shell-${__SW_VERSION__}`;
const DATA_CACHE = "data-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await cache.addAll(__SW_SHELL__.map((u) => new Request(u, { cache: "reload" })));
      // The first install takes over at once (no page runs an older shell);
      // a later one waits until the game's tabs are closed.
      if (!self.registration.active) await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith("shell-") && name !== SHELL_CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

/** The data cache key of a save file or API answer (the game folder is case-insensitive). */
function dataKey(path: string): string {
  return `${self.location.origin}/__offline__/${encodeURIComponent(path.toLowerCase())}`;
}

/** Bigger whole files (music tracks) are not kept. */
const KEEP_MAX_BYTES = 8 * 1024 * 1024;

async function networkFirstPage(request: Request, page: string): Promise<Response> {
  try {
    return await fetch(request);
  } catch (e) {
    const cached = await caches.match(page);
    if (cached) return cached;
    throw e;
  }
}

async function cacheFirst(request: Request): Promise<Response> {
  const cached = await caches.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok) {
    const copy = res.clone();
    void caches.open(SHELL_CACHE).then((c) => c.put(request, copy));
  }
  return res;
}

/** Network first; the answer (2xx or 404) is kept under `key` and served when the network fails. */
async function networkFirstData(request: Request, key: string): Promise<Response> {
  try {
    const res = await fetch(request);
    const size = Number(res.headers.get("content-length") ?? "0");
    if ((res.ok || res.status === 404) && size <= KEEP_MAX_BYTES) {
      const copy = res.clone();
      void caches.open(DATA_CACHE).then((c) => c.put(key, copy));
    }
    return res;
  } catch (e) {
    const cached = await caches.match(key, { cacheName: DATA_CACHE });
    if (cached) return cached;
    throw e;
  }
}

/** The kept bytes of a file under /assets/: null when kept as absent, undefined when not kept. */
async function keptFile(path: string): Promise<Uint8Array | null | undefined> {
  const cached = await caches.match(dataKey(path), { cacheName: DATA_CACHE });
  if (!cached) return undefined;
  if (cached.status === 404) return null;
  return new Uint8Array(await cached.arrayBuffer());
}

/** A Range request under /assets/: the network, else a slice of the kept copy. */
async function rangeRequest(request: Request, path: string, range: string): Promise<Response> {
  try {
    return await fetch(request);
  } catch (e) {
    const bytes = await keptFile(path);
    const m = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (bytes === undefined || !m) throw e;
    if (bytes === null) return new Response(null, { status: 404 });
    const start = Number(m[1]);
    const end = m[2] ? Math.min(Number(m[2]) + 1, bytes.length) : bytes.length;
    if (start >= bytes.length) return new Response(null, { status: 416, headers: { "content-range": `bytes */${bytes.length}` } });
    return new Response(bytes.slice(start, end), {
      status: 206,
      headers: { "content-range": `bytes ${start}-${end - 1}/${bytes.length}`, "content-length": String(end - start) },
    });
  }
}

/**
 * POST /api/ranges (server/src/routes/ranges.ts): the network, else, when
 * every range is over a kept file, the same answer built from them.
 */
async function ranges(request: Request): Promise<Response> {
  const body = request.clone();
  try {
    return await fetch(request);
  } catch (e) {
    const { ranges: list } = (await body.json()) as { ranges: Array<[string, number, number]> };
    const parts: Uint8Array[] = [];
    const lengths = new DataView(new ArrayBuffer(4 * list.length));
    for (const [i, [path, start, end]] of list.entries()) {
      const bytes = await keptFile(path);
      if (bytes === undefined) throw e;
      if (bytes === null || start >= bytes.length) {
        lengths.setUint32(4 * i, 0xffffffff, true);
        continue;
      }
      const part = bytes.slice(start, Math.min(end, bytes.length));
      lengths.setUint32(4 * i, part.length, true);
      parts.push(part);
    }
    return new Response(new Blob([lengths.buffer, ...parts.map((p) => p as Uint8Array<ArrayBuffer>)]), {
      headers: { "content-type": "application/octet-stream" },
    });
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;

  if (request.method === "POST") {
    if (path === "/api/ranges") event.respondWith(ranges(request));
    return;
  }
  if (request.method !== "GET") return;

  if (request.mode === "navigate") {
    // "/" with a query string starts the game (bookmarks: /?house=1), as on the server.
    if (path === "/game.html" || (path === "/" && url.search)) event.respondWith(networkFirstPage(request, "/game.html"));
    else if (path === "/" || path === "/index.html") event.respondWith(networkFirstPage(request, "/index.html"));
    return;
  }
  if (path.startsWith("/static/") || __SW_SHELL__.includes(path)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (path === "/api/config" || path === "/api/manifest") {
    event.respondWith(networkFirstData(request, dataKey(path)));
    return;
  }
  if (path.startsWith("/assets/")) {
    const file = decodeURIComponent(path.slice("/assets/".length));
    const range = request.headers.get("range");
    // Range reads of the game folder: IndexedDB's business (engine/idb.ts), straight to the network.
    if (range && !/^Sims\/UserData\d*\//i.test(file)) return;
    event.respondWith(range ? rangeRequest(request, file, range) : networkFirstData(request, dataKey(file)));
  }
});
