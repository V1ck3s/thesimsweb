/**
 * The landing page (client/index.html): the web wrapper around the game, not
 * part of it. Play button, the instance's save mode (GET /api/config), the
 * saves export / import (engine/saves.ts), the browser storage state and the
 * offline support (engine/pwa.ts). On an instance that serves no game file
 * (GAME_FILES=client), the import of the player's own install folder into
 * this browser (engine/gamefiles.ts); the game cannot start before it.
 * The game's language (engine/language.ts), its screen size, fullscreen and
 * centred HUD options (engine/display.ts) and links to the family web pages
 * the game wrote (served by /webpages/ with their compatibility script).
 *
 * The page speaks the game language chosen in its own selector (strings.ts)
 * and switches live: every text it shows is produced by a render function
 * that is run again on a change.
 */

import { exportSaves, getSaveMode, importSaves, listSaves, type SaveMode } from "../engine/saves.js";
import { registerServiceWorker } from "../engine/pwa.js";
import { LANGUAGES, readLanguage, storeLanguage } from "../engine/language.js";
import {
  readCentredHud,
  readFullscreen,
  readResolution,
  RESOLUTIONS,
  storeCentredHud,
  storeFullscreen,
  storeResolution,
  windowSize,
  DEFAULT_SCREEN,
  type ResolutionChoice,
} from "../engine/display.js";
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
import { formatBytes, type Key, LOCALES, localeTag, setLocale, t } from "./strings.js";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`landing: #${id} missing`);
  return el as T;
};

type Kind = "" | "ok" | "warn" | "err";
/** A text in the current language (run again when the language changes). */
type Text = () => string;

/** Re-renders run on a language change. */
const renders: Array<() => void> = [];

/** Shows `text` in `el` now and after every language change (replacing any earlier one for `el`). */
const bound = new WeakMap<HTMLElement, Text>();
function show(el: HTMLElement, text: Text): void {
  const first = !bound.has(el);
  bound.set(el, text);
  el.textContent = text();
  if (first) renders.push(() => (el.textContent = bound.get(el)!()));
}

function setStatus(text: Text | "", kind: Kind = ""): void {
  const el = $("saves-status");
  show(el, text === "" ? () => "" : text);
  el.className = `status ${kind}`;
}

let mode: SaveMode = "server";
let busy = false;

async function refreshSaves(): Promise<void> {
  try {
    const list = await listSaves();
    const total = list.reduce((n, f) => n + f.size, 0);
    show($("saves-count"), () => (list.length ? t("savesCount", { n: list.length, size: formatBytes(total) }) : t("savesNone")));
    $<HTMLButtonElement>("export").disabled = busy || !list.length;
    showWebPages(list.map((f) => f.path));
  } catch (e) {
    show($("saves-count"), () => t("unavailable", { error: (e as Error).message }));
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
  setStatus(() => t("exporting"));
  try {
    const { blob, count, bytes } = await exportSaves((done, total) => setStatus(() => t("exportingN", { done, total })));
    const stamp = new Date().toISOString().slice(0, 10);
    download(blob, `thesims-saves-${stamp}.zip`);
    setStatus(() => t("exported", { n: count, size: formatBytes(bytes) }), "ok");
  } catch (e) {
    setStatus(() => t("exportFailed", { error: (e as Error).message }), "err");
  } finally {
    setBusy(false);
    await refreshSaves();
  }
}

async function onImport(file: File): Promise<void> {
  const where = t(mode === "client" ? "whereClient" : "whereServer");
  if (!confirm(t("importConfirm", { where, file: file.name }))) return;
  setBusy(true);
  setStatus(() => t("importing"));
  try {
    const { count, ignored } = await importSaves(file, (done, total) => setStatus(() => t("importingN", { done, total })));
    setStatus(() => t("imported", { n: count }) + (ignored ? ` ${t("importedIgnored", { m: ignored })}` : ""), "ok");
  } catch (e) {
    setStatus(() => t("importFailed", { error: (e as Error).message }), "err");
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

function setGameStatus(text: Text | "", kind: Kind = ""): void {
  const el = $("gamefiles-status");
  show(el, text === "" ? () => "" : text);
  el.className = `status ${kind}`;
}

/** Play is offered once the game files are here. */
function setPlayable(ok: boolean): void {
  const play = $<HTMLAnchorElement>("play");
  play.setAttribute("aria-disabled", String(!ok));
  play.tabIndex = ok ? 0 : -1;
  show($("play-note"), () => t(ok ? "playNote" : "playNoteImport"));
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(localeTag());
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
    show(stateEl, () => t("unavailable", { error: (e as Error).message }));
    setPlayable(false);
    return;
  }
  if (st.state === "complete") {
    const s = st;
    show(stateEl, () => t("gfComplete", { source: s.source, n: s.fileCount, size: formatBytes(s.bytes), date: formatDate(s.finishedAt) }));
    stateEl.className = "ok";
    show(select, () => t("gfImportAgain"));
  } else if (st.state === "partial") {
    const s = st;
    show(stateEl, () => t("gfPartial", { done: formatBytes(s.storedBytes), size: formatBytes(s.bytes), source: s.source }));
    stateEl.className = "warn";
    show(select, () => t("gfSelect"));
  } else {
    show(stateEl, () => t("gfNone"));
    stateEl.className = "";
    show(select, () => t("gfSelect"));
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
  setGameStatus(() => t("gfReading"));
  try {
    const plan = planImport(await read());
    if (handle) await rememberFolder(handle);
    await importGameFiles(
      plan,
      (p) => {
        progress.value = p.totalBytes ? p.doneBytes / p.totalBytes : 0;
        setGameStatus(() =>
          t("gfCopying", { done: formatBytes(p.doneBytes), size: formatBytes(p.totalBytes), k: p.doneFiles, n: p.totalFiles }),
        );
      },
      signal,
    );
    setGameStatus(() => t("gfImported", { n: plan.files.length, size: formatBytes(plan.bytes) }), "ok");
  } catch (e) {
    if ((e as Error).name === "AbortError") setGameStatus(() => t("gfStopped"), "warn");
    else setGameStatus(() => t("gfFailed", { error: (e as Error).message }), "err");
  } finally {
    importing = null;
    await Promise.all([refreshGameFiles(), refreshStorage()]);
  }
}

const readingN = (n: number): void => setGameStatus(() => t("gfReadingN", { n }));

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
  await runImport(() => sourceFromHandle(handle, readingN), handle);
}

async function onResume(): Promise<void> {
  const handle = await rememberedFolder(true);
  if (!handle) {
    setGameStatus(() => t("gfNoAccess"), "warn");
    return;
  }
  await runImport(() => sourceFromHandle(handle, readingN), handle);
}

async function onRemoveGameFiles(): Promise<void> {
  if (!confirm(t("gfRemoveConfirm"))) return;
  try {
    await removeGameFiles();
    setGameStatus(() => t("gfRemoved"), "ok");
  } catch (e) {
    setGameStatus(() => t("gfRemoveFailed", { error: (e as Error).message }), "err");
  }
  await Promise.all([refreshGameFiles(), refreshStorage()]);
}

function initGameFiles(): void {
  $("gamefiles").hidden = false;
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

/** The game files paragraph: its text with the folder names as code. */
function renderGameFilesHelp(): void {
  const el = $("gamefiles-help");
  el.replaceChildren();
  for (const part of t("gamefilesHelp").split(/(\{\w+\})/)) {
    const m = /^\{(\w+)\}$/.exec(part);
    if (m) {
      const code = document.createElement("code");
      code.textContent = m[1]!;
      el.append(code);
    } else if (part) el.append(part);
  }
}

async function refreshStorage(): Promise<void> {
  const persistEl = $("storage-persist");
  const persistBtn = $<HTMLButtonElement>("persist");
  const storage = navigator.storage as StorageManager | undefined;
  if (!storage?.persisted) {
    show(persistEl, () => t("persistUnknown"));
  } else {
    const persisted = await storage.persisted().catch(() => false);
    show(persistEl, () => t(persisted ? "persistYes" : "persistNo"));
    persistEl.className = persisted ? "ok" : mode === "client" ? "warn" : "";
    persistBtn.hidden = persisted || !storage.persist;
  }
  const est = await storage?.estimate?.().catch(() => null);
  const usage = est?.usage;
  show($("storage-usage"), () => (usage !== undefined ? t(localGame ? "usageLocal" : "usageCache", { size: formatBytes(usage) }) : t("unknown")));
}

/** engine/pwa.ts offlineStatus, as a message key of this page. */
async function offlineKey(): Promise<Key> {
  if (import.meta.env.DEV) return "offDev";
  if (!("serviceWorker" in navigator)) return "offUnsupported";
  if (!window.isSecureContext) return "offInsecure";
  const reg = await registerServiceWorker();
  if (!reg) return "offFailed";
  return reg.active ? "offReady" : "offPreparing";
}

async function refreshOffline(): Promise<void> {
  const key = await offlineKey();
  show($("offline"), () => t(key));
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

// --- Language of the page ------------------------------------------------------------

/** Web fonts for the scripts the heading and body fonts do not cover (Google Fonts serves only the glyphs used). */
const SCRIPT_FONTS: Readonly<Record<string, string>> = {
  ja: "Noto+Sans+JP",
  "zh-CN": "Noto+Sans+SC",
  "zh-TW": "Noto+Sans+TC",
  ko: "Noto+Sans+KR",
  th: "Noto+Sans+Thai",
};
const loadedFonts = new Set<string>();

function loadScriptFont(tag: string): void {
  const family = SCRIPT_FONTS[tag];
  if (!family || loadedFonts.has(family)) return;
  loadedFonts.add(family);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${family}:wght@400;600;700&display=swap`;
  document.head.append(link);
}

/** Puts the page in the language `code`: the static texts, then every dynamic one. */
function applyLanguage(code: number): void {
  setLocale(code);
  const tag = localeTag();
  document.documentElement.lang = tag;
  loadScriptFont(tag);
  document.title = t("pageTitle");
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) el.textContent = t(el.dataset["i18n"] as Key);
  renderGameFilesHelp();
  for (const r of renders) r();
}

function initLanguage(): void {
  const select = $<HTMLSelectElement>("language");
  const current = readLanguage();
  for (const l of LANGUAGES) {
    const opt = document.createElement("option");
    opt.value = String(l.code);
    opt.textContent = l.name;
    opt.lang = LOCALES[l.code]?.tag ?? "";
    opt.selected = l.code === current;
    select.append(opt);
  }
  select.addEventListener("change", () => {
    if (!storeLanguage(Number(select.value))) select.value = String(readLanguage());
    applyLanguage(Number(select.value));
  });
  applyLanguage(current);
}

function initDisplay(): void {
  const select = $<HTMLSelectElement>("resolution");
  const current = readResolution();
  const add = (value: ResolutionChoice, text: Text): void => {
    const opt = document.createElement("option");
    opt.value = value;
    show(opt, text);
    opt.selected = value === current;
    select.append(opt);
  };
  const win = windowSize();
  add("window", () => t("resWindow"));
  add("auto", () => t("resAuto", { w: String(win.w), h: String(win.h) }));
  for (const [w, h] of RESOLUTIONS) {
    const original = w === DEFAULT_SCREEN.w && h === DEFAULT_SCREEN.h;
    add(`${w}x${h}`, () => (original ? t("resOriginal", { w: String(w), h: String(h) }) : `${w} × ${h}`));
  }
  // A size given by ?res= or stored by hand that the list does not hold.
  if (select.value !== current) add(current, () => current.replace("x", " × "));
  select.addEventListener("change", () => {
    if (!storeResolution(select.value as ResolutionChoice)) select.value = readResolution();
  });
  const hud = $<HTMLInputElement>("centred-hud");
  hud.checked = readCentredHud();
  hud.addEventListener("change", () => {
    if (!storeCentredHud(hud.checked)) hud.checked = readCentredHud();
  });
  const full = $<HTMLInputElement>("fullscreen");
  full.checked = readFullscreen();
  full.addEventListener("change", () => {
    if (!storeFullscreen(full.checked)) full.checked = readFullscreen();
  });
}

async function main(): Promise<void> {
  show($("lead"), () => t(localGame ? "leadLocal" : "lead"));
  show($("saves-mode"), () => t("savesChecking"));
  show($("play-note"), () => t("playNote"));
  initDisplay();
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
  show($("lead"), () => t(localGame ? "leadLocal" : "lead"));
  show($("saves-mode"), () => t(mode === "client" ? "savesClient" : "savesServer") + (online ? "" : ` ${t("savesOffline")}`));
  setBusy(false);
  navigator.serviceWorker?.addEventListener("controllerchange", () => void refreshOffline());
  await Promise.all([refreshSaves(), refreshStorage(), refreshGameFiles(), registerServiceWorker().then(refreshOffline, refreshOffline)]);
}

void main();
