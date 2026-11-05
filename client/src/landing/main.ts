/**
 * The landing page (client/index.html): the web wrapper around the game, not
 * part of it. Play button, the instance's save mode (GET /api/config), the
 * saves export / import (engine/saves.ts), the browser storage state and the
 * offline support (engine/pwa.ts).
 */

import { exportSaves, getSaveMode, importSaves, listSaves, type SaveMode } from "../engine/saves.js";
import { offlineStatus, registerServiceWorker } from "../engine/pwa.js";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`landing: #${id} missing`);
  return el as T;
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function setStatus(text: string, kind: "" | "ok" | "warn" | "err" = ""): void {
  const el = $("saves-status");
  el.textContent = text;
  el.className = `status ${kind}`;
}

let mode: SaveMode = "server";
let busy = false;

async function refreshSaves(): Promise<void> {
  try {
    const list = await listSaves();
    const total = list.reduce((n, f) => n + f.size, 0);
    $("saves-count").textContent = list.length
      ? `${list.length} file${list.length > 1 ? "s" : ""}, ${formatBytes(total)}`
      : "none yet (the game starts from the neighborhoods of the game folder)";
    $<HTMLButtonElement>("export").disabled = busy || !list.length;
  } catch (e) {
    $("saves-count").textContent = `unavailable (${(e as Error).message})`;
    $<HTMLButtonElement>("export").disabled = true;
  }
  $<HTMLButtonElement>("import").disabled = busy;
}

function setBusy(b: boolean): void {
  busy = b;
  $<HTMLButtonElement>("export").disabled = b;
  $<HTMLButtonElement>("import").disabled = b;
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function onExport(): Promise<void> {
  setBusy(true);
  setStatus("Exporting…");
  try {
    const { blob, count, bytes } = await exportSaves((done, total) => setStatus(`Exporting… ${done} / ${total}`));
    const stamp = new Date().toISOString().slice(0, 10);
    download(blob, `thesims-saves-${stamp}.zip`);
    setStatus(`Exported ${count} file${count > 1 ? "s" : ""} (${formatBytes(bytes)}).`, "ok");
  } catch (e) {
    setStatus(`Export failed: ${(e as Error).message}`, "err");
  } finally {
    setBusy(false);
    await refreshSaves();
  }
}

async function onImport(file: File): Promise<void> {
  const where = mode === "client" ? "this browser" : "the server (for everyone who plays on it)";
  const ok = confirm(
    `Replace every save of ${where} with the content of "${file.name}"?\n\n` +
      "Saves that are not in the archive are deleted. This cannot be undone: export the current saves first if in doubt. " +
      "Close the game's tabs before importing.",
  );
  if (!ok) return;
  setBusy(true);
  setStatus("Importing…");
  try {
    const { count, ignored } = await importSaves(file, (done, total) => setStatus(`Importing… ${done} / ${total}`));
    setStatus(
      `Imported ${count} file${count > 1 ? "s" : ""}` + (ignored ? ` (${ignored} other file${ignored > 1 ? "s" : ""} ignored)` : "") + ".",
      "ok",
    );
  } catch (e) {
    setStatus(`Import failed: ${(e as Error).message}`, "err");
  } finally {
    setBusy(false);
    await refreshSaves();
  }
}

async function refreshStorage(): Promise<void> {
  const persistEl = $("storage-persist");
  const persistBtn = $<HTMLButtonElement>("persist");
  const storage = navigator.storage as StorageManager | undefined;
  if (!storage?.persisted) {
    persistEl.textContent = "this browser does not say whether it may clear it";
  } else {
    const persisted = await storage.persisted().catch(() => false);
    persistEl.textContent = persisted
      ? "persistent: the browser keeps it until you clear it"
      : "best effort: the browser may clear it when the disk runs short";
    persistEl.className = persisted ? "ok" : mode === "client" ? "warn" : "";
    persistBtn.hidden = persisted || !storage.persist;
  }
  const est = await storage?.estimate?.().catch(() => null);
  $("storage-usage").textContent = est?.usage !== undefined ? `${formatBytes(est.usage)} (game files cache and saves)` : "unknown";
}

async function refreshOffline(): Promise<void> {
  $("offline").textContent = await offlineStatus();
}

async function main(): Promise<void> {
  $<HTMLButtonElement>("export").addEventListener("click", () => void onExport());
  const input = $<HTMLInputElement>("import-file");
  $<HTMLButtonElement>("import").addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.value = "";
    if (file) void onImport(file);
  });
  $<HTMLButtonElement>("persist").addEventListener("click", () => {
    void navigator.storage
      .persist()
      .catch(() => false)
      .then(() => refreshStorage());
  });

  // (not kept by the service worker: tells whether the server answers)
  const online = await fetch("/api/health", { cache: "no-store" }).then(
    (r) => r.ok,
    () => false,
  );
  mode = await getSaveMode();
  $("saves-mode").textContent =
    (mode === "client"
      ? "This server keeps no saves: they stay in this browser, on this device, for this address. Another browser or device starts from the game's original neighborhoods."
      : "Saves are kept on this server and shared by every browser that plays on it.") +
    (online ? "" : " The server cannot be reached: offline.");
  setBusy(false);
  navigator.serviceWorker?.addEventListener("controllerchange", () => void refreshOffline());
  await Promise.all([refreshSaves(), refreshStorage(), registerServiceWorker().then(refreshOffline, refreshOffline)]);
}

void main();
