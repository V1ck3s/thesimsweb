/**
 * Writing game files. The game saves into its own folder (UserData<N>/...);
 * here those writes go to the dev server's overlay (PUT /api/files/Sims/<path>,
 * see server/src/routes/userdata.ts), which then serves them under
 * /assets/Sims/<path> and lists them in the manifest. Only UserData* paths
 * are writable.
 *
 * After a write the in-memory caches that hold game files are dropped and the
 * listeners are told (onGameFilesChanged), so the next read sees the new file.
 * Standalone IFFs under UserData* are never kept in the IndexedDB asset cache
 * (engine/assets.ts), so a reload sees them too.
 *
 * When the instance keeps saves in the browser (engine/saves.ts, "client"
 * mode) the writes go to this browser's saves database instead of the server.
 */

import { invalidateManifest } from "../../engine/assets.js";
import { getSaveMode, localSaveDelete, localSaveWrite } from "../../engine/saves.js";
import { clearIffFileCache } from "../nbhd/nghinterface.js";

type Listener = (path: string) => void;
const listeners = new Set<Listener>();

function url(path: string): string {
  return `/api/files/Sims/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function changed(path: string): void {
  // The manifest is fetched once per page (engine/assets.ts): it lists the new file from now on.
  invalidateManifest();
  clearIffFileCache();
  for (const l of [...listeners]) l(path);
}

/** Writes `bytes` to <game folder>/<path> (through the overlay). */
export async function writeGameFile(path: string, bytes: Uint8Array): Promise<void> {
  if ((await getSaveMode()) === "client") {
    if (!/^UserData\d*\//i.test(path)) throw new Error(`write ${path}: only UserData*/ is writable`);
    await localSaveWrite(`Sims/${path}`, bytes);
    changed(path);
    return;
  }
  const res = await fetch(url(path), {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Blob([bytes as Uint8Array<ArrayBuffer>]),
  });
  if (!res.ok) throw new Error(`write ${path}: ${res.status} ${await res.text()}`);
  changed(path);
}

/** Deletes <game folder>/<path> (only files the overlay holds can go away). */
export async function deleteGameFile(path: string): Promise<void> {
  if ((await getSaveMode()) === "client") {
    await localSaveDelete(`Sims/${path}`);
    changed(path);
    return;
  }
  const res = await fetch(url(path), { method: "DELETE" });
  if (!res.ok) throw new Error(`delete ${path}: ${res.status} ${await res.text()}`);
  changed(path);
}

/** Called with the game-relative path after every write or delete; returns an unsubscribe function. */
export function onGameFilesChanged(cb: (path: string) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
