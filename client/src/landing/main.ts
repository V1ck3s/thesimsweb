/**
 * The landing page (client/index.html): the web wrapper around the game, not
 * part of it. Play button, the instance's save mode (GET /api/config), the
 * saves export / import (engine/saves.ts), the browser storage state and the
 * offline support (engine/pwa.ts). On an instance that serves no game file
 * (GAME_FILES=client), the import of the player's own install folder into
 * this browser (engine/gamefiles.ts); the game cannot start before it.
 * The game's language (engine/language.ts) and links to the family web pages
 * the game wrote (served by /webpages/ with their compatibility script).
 */

import { exportSaves, getSaveMode, importSaves, listSaves, type SaveMode } from "../engine/saves.js";
import { offlineStatus, registerServiceWorker } from "../engine/pwa.js";
import { LANGUAGES, readLanguage, storeLanguage } from "../engine/language.js";
import {
  gameFilesStatus,
  hasFolderPicker,
  hasRememberedFolder,
  importGameFiles,
  isGameFilesLocal,
  pickFolder,
  planImport,
  rememberedFolder,
  rememberFolder,
  removeGameFiles,
  sourceFromHandle,
  sourceFromInput,
  type SourceFile,
} from "../engine/gamefiles.js";

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
    showWebPages(list.map((f) => f.path));
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

// --- Game files (GAME_FILES=client) ------------------------------------------------

/** The instance serves no game file: this browser imports them. */
let localGame = false;
/** The import in progress (Stop aborts it). */
let importing: AbortController | null = null;

function setGameStatus(text: string, kind: "" | "ok" | "warn" | "err" = ""): void {
  const el = $("gamefiles-status");
  el.textContent = text;
  el.className = `status ${kind}`;
}

/** Play is offered once the game files are here. */
function setPlayable(ok: boolean): void {
  const play = $<HTMLAnchorElement>("play");
  play.setAttribute("aria-disabled", String(!ok));
  play.tabIndex = ok ? 0 : -1;
  $("play-note").textContent = ok
    ? "The game opens in this tab. Close other tabs of the game first."
    : "Import the game folder first (below).";
}

async function refreshGameFiles(): Promise<void> {
  if (!localGame) return;
  const stateEl = $("gamefiles-state");
  const select = $<HTMLButtonElement>("gamefiles-select");
  const resume = $<HTMLButtonElement>("gamefiles-resume");
  const remove = $<HTMLButtonElement>("gamefiles-remove");
  const busy = importing !== null;
  select.disabled = busy;
  remove.disabled = busy;
  $<HTMLButtonElement>("gamefiles-stop").hidden = !busy;
  $("gamefiles-progress").hidden = !busy;
  let st;
  try {
    st = await gameFilesStatus();
  } catch (e) {
    stateEl.textContent = `unavailable (${(e as Error).message})`;
    setPlayable(false);
    return;
  }
  if (st.state === "complete") {
    stateEl.textContent = `"${st.source}": ${st.fileCount} files, ${formatBytes(st.bytes)}, imported ${new Date(st.finishedAt).toLocaleString()}`;
    stateEl.className = "ok";
    select.textContent = "Import again…";
  } else if (st.state === "partial") {
    stateEl.textContent = `incomplete: ${formatBytes(st.storedBytes)} of ${formatBytes(st.bytes)} copied from "${st.source}". Select the folder again to resume.`;
    stateEl.className = "warn";
    select.textContent = "Select the game folder…";
  } else {
    stateEl.textContent = "nothing imported yet";
    stateEl.className = "";
    select.textContent = "Select the game folder…";
  }
  resume.hidden = busy || st.state !== "partial" || !(await hasRememberedFolder());
  remove.hidden = st.state === "none";
  setPlayable(st.state === "complete");
}

/** Reads the selected folder, checks it and copies it into this browser. */
async function runImport(read: () => Promise<SourceFile[]>, handle?: unknown): Promise<void> {
  if (importing) return;
  importing = new AbortController();
  const signal = importing.signal;
  const progress = $<HTMLProgressElement>("gamefiles-progress");
  progress.value = 0;
  await refreshGameFiles();
  setGameStatus("Reading the folder…");
  try {
    const plan = planImport(await read());
    if (handle) await rememberFolder(handle);
    await importGameFiles(
      plan,
      (p) => {
        progress.value = p.totalBytes ? p.doneBytes / p.totalBytes : 0;
        setGameStatus(`Copying into this browser… ${formatBytes(p.doneBytes)} of ${formatBytes(p.totalBytes)} (${p.doneFiles} / ${p.totalFiles} files)`);
      },
      signal,
    );
    setGameStatus(`Imported ${plan.files.length} files (${formatBytes(plan.bytes)}). Ready to play.`, "ok");
  } catch (e) {
    if ((e as Error).name === "AbortError") setGameStatus("Stopped. What was copied is kept: select the folder again to resume.", "warn");
    else setGameStatus(`Import failed: ${(e as Error).message}`, "err");
  } finally {
    importing = null;
    await Promise.all([refreshGameFiles(), refreshStorage()]);
  }
}

async function onSelectFolder(): Promise<void> {
  if (!hasFolderPicker()) {
    $<HTMLInputElement>("gamefiles-input").click();
    return;
  }
  let handle: unknown;
  try {
    handle = await pickFolder();
  } catch (e) {
    if ((e as Error).name === "AbortError") return; // (the player closed the picker)
    // Picker refused (a system folder, a policy): the plain folder input.
    $<HTMLInputElement>("gamefiles-input").click();
    return;
  }
  await runImport(() => sourceFromHandle(handle, (n) => setGameStatus(`Reading the folder… ${n} files`)), handle);
}

async function onResume(): Promise<void> {
  const handle = await rememberedFolder(true);
  if (!handle) {
    setGameStatus("The browser no longer allows reading that folder: select it again.", "warn");
    return;
  }
  await runImport(() => sourceFromHandle(handle, (n) => setGameStatus(`Reading the folder… ${n} files`)), handle);
}

async function onRemoveGameFiles(): Promise<void> {
  if (!confirm("Remove the game files from this browser? The saves are kept. Playing again needs a new import of the game folder.")) return;
  try {
    await removeGameFiles();
    setGameStatus("The game files were removed from this browser.", "ok");
  } catch (e) {
    setGameStatus(`Removal failed: ${(e as Error).message}`, "err");
  }
  await Promise.all([refreshGameFiles(), refreshStorage()]);
}

function initGameFiles(): void {
  $("gamefiles").hidden = false;
  $("lead").textContent = "A web port of The Sims (2000, Complete Collection), running on your own copy of the game, imported into this browser.";
  const input = $<HTMLInputElement>("gamefiles-input");
  input.addEventListener("change", () => {
    const list = input.files;
    if (!list?.length) return;
    const files = sourceFromInput(list);
    input.value = "";
    void runImport(() => Promise.resolve(files));
  });
  $<HTMLButtonElement>("gamefiles-select").addEventListener("click", () => void onSelectFolder());
  $<HTMLButtonElement>("gamefiles-resume").addEventListener("click", () => void onResume());
  $<HTMLButtonElement>("gamefiles-stop").addEventListener("click", () => importing?.abort());
  $<HTMLButtonElement>("gamefiles-remove").addEventListener("click", () => void onRemoveGameFiles());
  window.addEventListener("beforeunload", (e) => {
    // (what was copied is kept, but the player may not mean to stop)
    if (importing) e.preventDefault();
  });
  setPlayable(false);
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
  $("storage-usage").textContent = est?.usage !== undefined ? `${formatBytes(est.usage)} (${localGame ? "imported game files" : "game files cache"} and saves)` : "unknown";
}

async function refreshOffline(): Promise<void> {
  $("offline").textContent = await offlineStatus();
}

/** One link per neighborhood whose saves hold the game's web pages (its Web Pages/neighborhood.html). */
function showWebPages(paths: string[]): void {
  const dirs = new Set<string>();
  for (const p of paths) {
    const m = /^Sims\/(UserData\d*)\/Web Pages\/neighborhood\.html$/i.exec(p);
    if (m) dirs.add(m[1]!);
  }
  const links = $("webpages-links");
  links.replaceChildren();
  for (const dir of [...dirs].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    if (links.childNodes.length) links.append(", ");
    const a = document.createElement("a");
    a.href = `/webpages/Sims/${encodeURIComponent(dir)}/Web%20Pages/neighborhood.html`;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = dir;
    links.append(a);
  }
  $("webpages").hidden = dirs.size === 0;
}

function initLanguage(): void {
  const select = $<HTMLSelectElement>("language");
  const current = readLanguage();
  for (const l of LANGUAGES) {
    const opt = document.createElement("option");
    opt.value = String(l.code);
    opt.textContent = l.name;
    opt.selected = l.code === current;
    select.append(opt);
  }
  select.addEventListener("change", () => {
    if (!storeLanguage(Number(select.value))) select.value = String(readLanguage());
  });
}

async function main(): Promise<void> {
  initLanguage();
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
  localGame = await isGameFilesLocal();
  if (localGame) initGameFiles();
  $("saves-mode").textContent =
    (mode === "client"
      ? "This server keeps no saves: they stay in this browser, on this device, for this address. Another browser or device starts from the game's original neighborhoods."
      : "Saves are kept on this server and shared by every browser that plays on it.") +
    (online ? "" : " The server cannot be reached: offline.");
  setBusy(false);
  navigator.serviceWorker?.addEventListener("controllerchange", () => void refreshOffline());
  await Promise.all([refreshSaves(), refreshStorage(), refreshGameFiles(), registerServiceWorker().then(refreshOffline, refreshOffline)]);
}

void main();
