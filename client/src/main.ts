import { createRenderer } from "./renderer/webgl.js";
import { drawHelloSims } from "./renderer/hello.js";
import { engine } from "./engine/wasm.js";
import { fetchManifest, readFarManifest, readIffFromFar, readStandaloneIff } from "./engine/assets.js";

function findCanvas(): HTMLCanvasElement {
  const el = document.getElementById("game");
  if (!(el instanceof HTMLCanvasElement)) {
    throw new Error("canvas#game not found");
  }
  return el;
}

const canvas = findCanvas();
const renderer = createRenderer(canvas);
drawHelloSims(renderer);

// Smoke-test the WASM bridge: load the engine, log version, run the parsers
// against a synthetic FAR + IFF. If any of this throws the page surfaces it.
void engine().then((wasm) => {
  const fakeFar = buildSyntheticFar();
  const fakeIff = buildSyntheticIff();
  const manifest = wasm.parseFarManifest(fakeFar) as Array<{
    filename: string;
    sizeDecompressed: number;
    sizeCompressed: number;
    offset: number;
  }>;
  const payload = wasm.extractFarEntry(fakeFar, 0);
  const chunks = wasm.parseIffChunks(fakeIff) as Array<{
    kind: string;
    size: number;
    id: number;
    flags: number;
    dataStart: number;
    dataLen: number;
  }>;
  const { palt, spr2 } = buildSyntheticSpr2();
  const sprite = wasm.decodeSpr2Frame(spr2, palt, 0) as {
    width: number;
    height: number;
    rgba: Uint8Array;
  };
  console.info(
    `[engine] v${wasm.engine_version()} · far ${manifest.length} entries (${manifest[0]?.filename}, ${payload.length}B) · iff v${wasm.parseIffHeader(fakeIff)}, ${chunks.length} chunks (${chunks.map((c) => c.kind).join(",")}) · spr2 ${sprite.width}x${sprite.height} (${sprite.rgba.length}B RGBA)`,
  );
  void runRealAssetSmokeTest(wasm);
});

const HUD = document.getElementById("hud");
const SPRITE_CANVAS = document.getElementById("sprite-overlay") as HTMLCanvasElement | null;

function setHud(text: string): void {
  if (HUD) HUD.textContent = text;
}

async function runRealAssetSmokeTest(wasm: Awaited<ReturnType<typeof engine>>): Promise<void> {
  try {
    const manifest = await fetchManifest();
    const fars = manifest.files.filter((f) => f.kind === "far").length;
    const iffs = manifest.files.filter((f) => f.kind === "iff").length;
    setHud(`manifest: ${manifest.files.length} files · ${fars} FAR · ${iffs} IFF`);

    const floor = manifest.files.find((f) =>
      f.path.toLowerCase().endsWith("floors/floorjapanesetile.flr"),
    );
    if (!floor) {
      setHud(`manifest OK (${manifest.files.length} files) — no FloorJapaneseTile in install`);
      return;
    }

    const { data, chunks } = await readStandaloneIff(floor.path);
    const palt = chunks.find((c) => c.kind === "PALT" && c.id === 1);
    const spr2 = chunks.find((c) => c.kind === "SPR2");
    if (!palt || !spr2) {
      setHud(`${floor.path}: missing PALT(1) or SPR2`);
      return;
    }
    const paltData = data.subarray(palt.dataStart, palt.dataStart + palt.dataLen);
    const spr2Data = data.subarray(spr2.dataStart, spr2.dataStart + spr2.dataLen);
    const decoded = wasm.decodeSpr2Frame(spr2Data, paltData, 0) as {
      width: number;
      height: number;
      rgba: Uint8Array;
    };
    drawSpriteToOverlay(decoded);
    const catalogLine = await tryDecodeAlarmClock(wasm, manifest);
    const viewerLine = await tryRenderAlarmClockObject(wasm, manifest);
    setHud(
      `${floor.path} · ${chunks.length} chunks · sprite ${decoded.width}×${decoded.height} (${decoded.rgba.length}B RGBA)` +
        (catalogLine ? ` · ${catalogLine}` : "") +
        (viewerLine ? ` · ${viewerLine}` : ""),
    );
  } catch (err) {
    setHud(`real-asset smoke test failed: ${(err as Error).message}`);
    console.error(err);
  }
}

interface AlarmClockSummary {
  price: number;
  ttabId: number;
  type: number;
  guid: number;
  interactions: number;
  pieMenuLabels: number;
}

async function tryDecodeAlarmClock(
  wasm: Awaited<ReturnType<typeof engine>>,
  manifest: Awaited<ReturnType<typeof fetchManifest>>,
): Promise<string | null> {
  const objectsFar = manifest.files.find((f) =>
    f.path.toLowerCase().endsWith("objects/objects.far"),
  );
  if (!objectsFar) return null;
  try {
    const { data, chunks } = await readIffFromFar(objectsFar.path, "AlarmClock.iff");
    const objdChunk = chunks.find((c) => c.kind === "OBJD");
    const ttabChunk = chunks.find((c) => c.kind === "TTAB");
    const ttasChunk = chunks.find((c) => c.kind === "TTAs");
    if (!objdChunk || !ttabChunk || !ttasChunk) return null;
    const objd = wasm.parseObjd(
      data.subarray(objdChunk.dataStart, objdChunk.dataStart + objdChunk.dataLen),
    ) as { version: number; fields: number[]; guid: number };
    const ttab = wasm.parseTtab(
      data.subarray(ttabChunk.dataStart, ttabChunk.dataStart + ttabChunk.dataLen),
    ) as { version: number; interactions: unknown[] };
    const ttas = wasm.parseStrTable(
      data.subarray(ttasChunk.dataStart, ttasChunk.dataStart + ttasChunk.dataLen),
    ) as { version: number; entries: unknown[] };
    const summary: AlarmClockSummary = {
      price: objd.fields[16] ?? -1,
      ttabId: objd.fields[5] ?? -1,
      type: objd.fields[7] ?? -1,
      guid: objd.guid,
      interactions: ttab.interactions.length,
      pieMenuLabels: ttas.entries.length,
    };
    return `AlarmClock OBJDv${objd.version} guid=0x${summary.guid.toString(16)} price=${summary.price}§ TTABv${ttab.version}/${summary.interactions} interactions · TTAsv${ttas.version}/${summary.pieMenuLabels} labels`;
  } catch (err) {
    console.warn("[catalog] AlarmClock decode failed:", err);
    return null;
  }
}

interface DgrpSprite {
  sprChunkId: number;
  sprFrameNumber: number;
  spriteXOffset: number;
  spriteYOffset: number;
  objectZOffset: number;
  flags: number;
  objectXOffset: number;
  objectYOffset: number;
}

interface DgrpImage {
  directionFlags: number;
  zoomLevel: number;
  sprites: DgrpSprite[];
}

interface DecodedSprite {
  width: number;
  height: number;
  rgba: Uint8Array;
}

interface IffChunkRef {
  kind: string;
  size: number;
  id: number;
  flags: number;
  label: string;
  dataStart: number;
  dataLen: number;
}

interface DgrpChunk {
  id: number;
  version: number;
  images: DgrpImage[];
}

interface LoadedObject {
  iffName: string;
  objectName: string;
  data: Uint8Array;
  chunks: IffChunkRef[];
  paltChunk: IffChunkRef | null;
  baseGraphicId: number;
  dgrps: DgrpChunk[];
  semiGlobalName: string | null;
  objfEntries: Array<{ condition: number; action: number }>;
}

/** Conventional event-index names. Defined by `behavior.iff` chunk 0x00F5; this is
 *  the de facto base game order. Indexing past this just shows "Event N". */
const EVENT_NAMES = [
  "Init",
  "Main",
  "Load",
  "Cleanup",
  "User Placement",
  "Auto Placement",
  "Wall Adjacency Changed",
  "Room Changed",
  "Disaster Started",
  "Disaster Ended",
  "Reset",
  "Pickup",
  "User Pickup",
  "Level Info Request",
  "Service Pickup",
  "Lot Lockdown",
];

interface RunOutput {
  outcome: string;
  actionId: number;
  exec: string;
  ticksRan: number;
  trace: Array<{ depth: number; bhavId: number; ip: number; opcode: number; branch: string; operand?: string }>;
  effects: VmEffectObject[];
}

interface VmEffectObject {
  kind: string;
  [field: string]: unknown;
}

function formatEffect(ef: VmEffectObject): string {
  switch (ef.kind) {
    case "Sleep":
      return `Sleep ticks=${ef["ticks"]}`;
    case "Idle":
      return `Idle ticks=${ef["ticks"]} interruptable=${ef["interruptable"]}`;
    case "PlaySound":
      return `PlaySound 0x${Number(ef["eventId"]).toString(16)}`;
    case "AnimateSim":
      return `AnimateSim 0x${Number(ef["animId"]).toString(16)}`;
    case "Dialog":
      return `Dialog ${ef["flavour"]} str=${ef["stringIndex"]}`;
    case "PushInteraction":
      return `PushInteraction action=0x${Number(ef["actionFunction"]).toString(16)} joining=${ef["joiningIndex"]}`;
    case "TransferFunds":
      return `TransferFunds Δ=${ef["delta"]}§`;
    case "CreateObjectInstance":
      return `CreateObjectInstance guid=0x${Number(ef["guid"]).toString(16)} id=${ef["newObjectId"]}`;
    case "Breakpoint":
      return `Breakpoint @0x${Number(ef["bhavId"]).toString(16)}#${ef["ip"]}`;
    default: {
      const fields = Object.entries(ef)
        .filter(([k]) => k !== "kind")
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(" ");
      return fields ? `${ef.kind} ${fields}` : ef.kind;
    }
  }
}

const DIRECTION_FLAGS: Array<{ flag: number; label: string }> = [
  { flag: 0x10, label: "S" },
  { flag: 0x40, label: "E" },
  { flag: 0x01, label: "N" },
  { flag: 0x04, label: "W" },
];
const ZOOM_LEVELS = [1, 2, 3];

const viewerState: {
  current: LoadedObject | null;
  direction: number;
  zoom: number;
  dgrpId: number;
  wasm: Awaited<ReturnType<typeof engine>> | null;
  onObjectLoaded: (() => void) | null;
} = {
  current: null,
  direction: 0x10,
  zoom: 3,
  dgrpId: 0,
  wasm: null,
  onObjectLoaded: null,
};

/** Build a `LoadedObject` snapshot for an IFF: parse OBJD + every DGRP once. */
function buildLoadedObject(
  wasm: Awaited<ReturnType<typeof engine>>,
  iffName: string,
  data: Uint8Array,
  chunks: IffChunkRef[],
): LoadedObject | null {
  const objdChunk = chunks.find((c) => c.kind === "OBJD");
  if (!objdChunk) return null;
  const objd = wasm.parseObjd(
    data.subarray(objdChunk.dataStart, objdChunk.dataStart + objdChunk.dataLen),
  ) as { fields: number[] };
  const baseGraphicId = objd.fields[1] ?? 0;
  // Prefer the OBJD chunk's 64-byte label (Maxis stores the human-readable name there);
  // fall back to humanizing the IFF filename.
  const labelTrimmed = objdChunk.label.trim();
  const objectName = labelTrimmed.length > 0 ? labelTrimmed : humanizeIffName(iffName);
  const paltChunk = chunks.find((c) => c.kind === "PALT" && c.id === 0) ?? null;
  const globChunk = chunks.find((c) => c.kind === "GLOB");
  let semiGlobalName: string | null = null;
  if (globChunk) {
    try {
      const glob = wasm.parseGlob(
        data.subarray(globChunk.dataStart, globChunk.dataStart + globChunk.dataLen),
      ) as { semiGlobalName: string };
      semiGlobalName = glob.semiGlobalName;
    } catch (err) {
      console.warn(`[viewer] GLOB parse failed for ${iffName}:`, err);
    }
  }
  const objfChunk = chunks.find((c) => c.kind === "OBJf");
  let objfEntries: Array<{ condition: number; action: number }> = [];
  if (objfChunk) {
    try {
      const parsed = wasm.parseObjf(
        data.subarray(objfChunk.dataStart, objfChunk.dataStart + objfChunk.dataLen),
      ) as { entries: Array<{ condition: number; action: number }> };
      objfEntries = parsed.entries;
    } catch (err) {
      console.warn(`[viewer] OBJf parse failed for ${iffName}:`, err);
    }
  }
  const dgrps: DgrpChunk[] = [];
  for (const c of chunks) {
    if (c.kind !== "DGRP") continue;
    try {
      const parsed = wasm.parseDgrp(data.subarray(c.dataStart, c.dataStart + c.dataLen)) as {
        version: number;
        images: DgrpImage[];
      };
      dgrps.push({ id: c.id, version: parsed.version, images: parsed.images });
    } catch (err) {
      console.warn(`[viewer] DGRP ${c.id} parse failed:`, err);
    }
  }
  return { iffName, objectName, data, chunks, paltChunk, baseGraphicId, dgrps, semiGlobalName, objfEntries };
}

/** Refresh the event-select <option>s with this object's wired (non-zero) events. */
function refreshEventSelector(): void {
  const select = document.getElementById("event-select");
  if (!(select instanceof HTMLSelectElement)) return;
  const obj = viewerState.current;
  select.innerHTML = "";
  if (!obj) return;
  let hasMain = false;
  obj.objfEntries.forEach((entry, idx) => {
    if (entry.action === 0 && entry.condition === 0) return;
    const opt = document.createElement("option");
    opt.value = String(idx);
    const name = EVENT_NAMES[idx] ?? `Event ${idx}`;
    opt.textContent = `${idx}: ${name} → 0x${entry.action.toString(16).padStart(4, "0")}`;
    if (idx === 1) {
      opt.selected = true;
      hasMain = true;
    }
    select.appendChild(opt);
  });
  if (!hasMain && select.options.length > 0) {
    select.options[0]!.selected = true;
  }
}

/** "AlarmClock.iff" → "Alarm Clock". CamelCase → space-separated. */
function humanizeIffName(iffName: string): string {
  const stem = iffName.replace(/\.iff$/i, "");
  return stem.replace(/([a-z0-9])([A-Z])/gu, "$1 $2");
}

/** Render the currently selected (object, direction, zoom, dgrpId) tuple. */
function renderViewer(): void {
  const wasm = viewerState.wasm;
  const obj = viewerState.current;
  if (!wasm || !obj) return;
  const dgrp = obj.dgrps.find((d) => d.id === viewerState.dgrpId) ?? obj.dgrps[0];
  if (!dgrp) {
    setObjectLabel(`${obj.objectName} · no DGRP`);
    return;
  }
  const image =
    dgrp.images.find(
      (i) => i.directionFlags === viewerState.direction && i.zoomLevel === viewerState.zoom,
    ) ?? dgrp.images[0];
  if (!image || !obj.paltChunk) {
    setObjectLabel(`${obj.objectName} · DGRP ${dgrp.id} · no image for that view`);
    clearObjectViewer();
    return;
  }
  const palt = obj.data.subarray(
    obj.paltChunk.dataStart,
    obj.paltChunk.dataStart + obj.paltChunk.dataLen,
  );
  const decoded: Array<{ sp: DgrpSprite; bmp: DecodedSprite }> = [];
  for (const sp of image.sprites) {
    const spr2Chunk = obj.chunks.find((c) => c.kind === "SPR2" && c.id === sp.sprChunkId);
    if (!spr2Chunk) continue;
    try {
      const bmp = wasm.decodeSpr2Frame(
        obj.data.subarray(spr2Chunk.dataStart, spr2Chunk.dataStart + spr2Chunk.dataLen),
        palt,
        sp.sprFrameNumber,
      ) as DecodedSprite;
      decoded.push({ sp, bmp });
    } catch (err) {
      console.warn(`[viewer] SPR2 ${sp.sprChunkId}#${sp.sprFrameNumber} decode failed:`, err);
    }
  }
  if (decoded.length === 0) {
    setObjectLabel(`${obj.objectName} · DGRP ${dgrp.id} · no decodable sprites`);
    clearObjectViewer();
    return;
  }
  composeObjectViewer(decoded);
  const dirLabel = DIRECTION_FLAGS.find((d) => d.flag === viewerState.direction)?.label ?? "?";
  // Show the sprite refs as `id#frame` so the user can spot when adjacent directions
  // reuse the same compiled sprite (TS1 stores e.g. only N+W and flips at render time).
  const spriteRefs = image.sprites
    .map((s) => `${s.sprChunkId}#${s.sprFrameNumber}`)
    .join(", ");
  setObjectLabel(
    `${obj.objectName} · DGRP ${dgrp.id}${dgrp.id === obj.baseGraphicId ? " (base)" : ""} · ${dirLabel} z${viewerState.zoom} · spr=[${spriteRefs}]`,
  );
  refreshStateButtons();
}

/** Show all DGRP IDs as buttons; highlight the current one. */
function refreshStateButtons(): void {
  const obj = viewerState.current;
  const root = document.getElementById("state-buttons");
  if (!root || !obj) return;
  root.innerHTML = "";
  for (const d of obj.dgrps) {
    const btn = document.createElement("button");
    btn.textContent = String(d.id);
    btn.style.cssText = controlButtonStyle(d.id === viewerState.dgrpId);
    btn.addEventListener("click", () => {
      viewerState.dgrpId = d.id;
      renderViewer();
    });
    root.appendChild(btn);
  }
}

/** Mount direction/zoom buttons (static; only their highlight changes per render). */
function mountStaticControls(): void {
  const dirRoot = document.getElementById("dir-buttons");
  if (dirRoot) {
    dirRoot.innerHTML = "";
    for (const d of DIRECTION_FLAGS) {
      const btn = document.createElement("button");
      btn.textContent = d.label;
      btn.dataset["flag"] = String(d.flag);
      btn.addEventListener("click", () => {
        viewerState.direction = d.flag;
        updateButtonHighlights();
        renderViewer();
      });
      dirRoot.appendChild(btn);
    }
  }
  const zoomRoot = document.getElementById("zoom-buttons");
  if (zoomRoot) {
    zoomRoot.innerHTML = "";
    for (const z of ZOOM_LEVELS) {
      const btn = document.createElement("button");
      btn.textContent = String(z);
      btn.dataset["zoom"] = String(z);
      btn.addEventListener("click", () => {
        viewerState.zoom = z;
        updateButtonHighlights();
        renderViewer();
      });
      zoomRoot.appendChild(btn);
    }
  }
  updateButtonHighlights();
}

function updateButtonHighlights(): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>("#dir-buttons button")) {
    const flag = Number(btn.dataset["flag"] ?? "0");
    btn.style.cssText = controlButtonStyle(flag === viewerState.direction);
  }
  for (const btn of document.querySelectorAll<HTMLButtonElement>("#zoom-buttons button")) {
    const z = Number(btn.dataset["zoom"] ?? "0");
    btn.style.cssText = controlButtonStyle(z === viewerState.zoom);
  }
}

function controlButtonStyle(active: boolean): string {
  return `background:${active ? "#3b6" : "#222"};color:${active ? "#000" : "#cde"};border:1px solid #444;font:inherit;padding:1px 6px;cursor:pointer;border-radius:2px;min-width:22px;`;
}

function clearObjectViewer(): void {
  if (!OBJECT_VIEWER_CANVAS) return;
  const ctx = OBJECT_VIEWER_CANVAS.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, OBJECT_VIEWER_CANVAS.width, OBJECT_VIEWER_CANVAS.height);
}

/** Populate the obj <select> with every IFF in Objects.far. */
async function mountObjectSelector(
  wasm: Awaited<ReturnType<typeof engine>>,
  objectsFarPath: string,
): Promise<void> {
  const select = document.getElementById("object-select");
  if (!(select instanceof HTMLSelectElement)) return;

  const farManifest = await readFarManifest(objectsFarPath);
  const candidates = farManifest
    .map((e) => e.filename)
    .filter((n) => n.toLowerCase().endsWith(".iff"))
    .sort((a, b) => a.localeCompare(b));

  select.innerHTML = "";
  for (const name of candidates) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = humanizeIffName(name);
    if (name === "AlarmClock.iff") opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => {
    void loadObjectByName(wasm, objectsFarPath, select.value);
  });

  // Background walker: fetch each IFF, find its OBJD chunk's 64-byte label, and patch
  // the corresponding <option>. Concurrency-capped so we don't slam the dev server.
  void enrichDropdownLabels(wasm, objectsFarPath, candidates, select);
}

const OBJD_LABEL_CONCURRENCY = 6;

async function enrichDropdownLabels(
  wasm: Awaited<ReturnType<typeof engine>>,
  objectsFarPath: string,
  names: string[],
  select: HTMLSelectElement,
): Promise<void> {
  let cursor = 0;
  let done = 0;
  const total = names.length;
  const start = performance.now();
  const worker = async (): Promise<void> => {
    while (cursor < names.length) {
      const i = cursor;
      cursor += 1;
      const name = names[i];
      if (!name) continue;
      try {
        const { chunks } = await readIffFromFar(objectsFarPath, name);
        const objd = chunks.find((c) => c.kind === "OBJD");
        const label = objd?.label.trim();
        if (label && select.options[i]) {
          select.options[i].textContent = label;
        }
      } catch {
        // Leave the humanized fallback in place.
      }
      done += 1;
    }
  };
  const workers = Array.from({ length: OBJD_LABEL_CONCURRENCY }, worker);
  await Promise.allSettled(workers);
  console.info(
    `[viewer] dropdown labels enriched: ${done}/${total} in ${Math.round(performance.now() - start)}ms`,
  );
}

async function loadObjectByName(
  wasm: Awaited<ReturnType<typeof engine>>,
  objectsFarPath: string,
  iffName: string,
): Promise<void> {
  try {
    const { data, chunks } = await readIffFromFar(objectsFarPath, iffName);
    const loaded = buildLoadedObject(wasm, iffName, data, chunks as IffChunkRef[]);
    if (!loaded || loaded.dgrps.length === 0) {
      setObjectLabel(`${iffName} · no DGRP`);
      clearObjectViewer();
      return;
    }
    viewerState.current = loaded;
    viewerState.dgrpId = loaded.baseGraphicId;
    if (!loaded.dgrps.some((d) => d.id === viewerState.dgrpId)) {
      viewerState.dgrpId = loaded.dgrps[0]?.id ?? 0;
    }
    renderViewer();
    refreshEventSelector();
    setRunOutput("");
    viewerState.onObjectLoaded?.();
  } catch (err) {
    console.warn(`[viewer] load ${iffName} failed:`, err);
    setObjectLabel(`${iffName} · load failed`);
  }
}

/** Per-name cache of semi-global IFF bytes loaded from `Global.far`. */
const globalsCache = new Map<string, Uint8Array | null>();

async function loadSemiGlobalIff(
  wasm: Awaited<ReturnType<typeof engine>>,
  globalsFarPath: string,
  name: string,
): Promise<Uint8Array | null> {
  const key = name.toLowerCase();
  if (globalsCache.has(key)) return globalsCache.get(key) ?? null;
  try {
    const farManifest = await readFarManifest(globalsFarPath);
    const target = farManifest.find((e) => {
      const stem = e.filename.replace(/\.iff$/i, "");
      return stem.toLowerCase() === key;
    });
    if (!target) {
      globalsCache.set(key, null);
      return null;
    }
    const { data } = await readIffFromFar(globalsFarPath, target.filename);
    globalsCache.set(key, data);
    return data;
  } catch (err) {
    console.warn(`[viewer] semi-global ${name} load failed:`, err);
    globalsCache.set(key, null);
    return null;
  }
}

const RUN_OUTPUT_EL = document.getElementById("run-output");
const DISASM_OUTPUT_EL = document.getElementById("disasm-output");

function setRunOutput(text: string): void {
  if (!RUN_OUTPUT_EL) return;
  RUN_OUTPUT_EL.textContent = text;
  RUN_OUTPUT_EL.style.display = text ? "block" : "none";
}

function setDisasmOutput(text: string): void {
  if (DISASM_OUTPUT_EL) DISASM_OUTPUT_EL.textContent = text;
}

/** Render disasm with anchor-id'd lines so t/f dest clicks scroll to the target. */
function setDisasmStructured(headerLine: string, instrs: DisasmLine[]): void {
  if (!DISASM_OUTPUT_EL) return;
  DISASM_OUTPUT_EL.innerHTML = "";
  const headerEl = document.createElement("div");
  headerEl.textContent = headerLine;
  DISASM_OUTPUT_EL.appendChild(headerEl);
  for (const line of instrs) {
    const lineEl = document.createElement("div");
    lineEl.id = `bhav-ip-${line.ip}`;
    lineEl.style.cssText = "scroll-margin-top:4px;";
    const prefix = document.createElement("span");
    prefix.textContent = `  ${String(line.ip).padStart(2)}: ${line.opLabel}${line.operandPart}  `;
    lineEl.appendChild(prefix);
    lineEl.appendChild(makeDestSpan("t", line.tDest));
    lineEl.appendChild(document.createTextNode(" "));
    lineEl.appendChild(makeDestSpan("f", line.fDest));
    DISASM_OUTPUT_EL.appendChild(lineEl);
  }
}

interface DisasmLine {
  ip: number;
  opLabel: string;
  operandPart: string;
  tDest: number;
  fDest: number;
}

function makeDestSpan(kind: "t" | "f", dest: number): HTMLElement {
  const span = document.createElement("span");
  span.textContent = `${kind}=${formatDest(dest)}`;
  if (dest < 0xfd) {
    span.style.cssText = "color:#7df;cursor:pointer;text-decoration:underline dotted;";
    span.addEventListener("click", () => {
      const target = document.getElementById(`bhav-ip-${dest}`);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  } else {
    // ret_true / ret_false / ret_error — color them differently, no jump.
    span.style.cssText =
      dest === 0xff ? "color:#9f8;" : dest === 0xfe ? "color:#fb8;" : "color:#f88;";
  }
  return span;
}

interface BhavInstruction {
  opcode: number;
  tDest: number;
  fDest: number;
  operand: Uint8Array;
}

interface BhavParsed {
  magic: number;
  count: number;
  args: number;
  locals: number;
  instructions: BhavInstruction[];
}

/** Find a BHAV chunk by ID inside arbitrary IFF data and return its parsed body. */
function findAndParseBhav(
  wasm: Awaited<ReturnType<typeof engine>>,
  data: Uint8Array,
  chunks: IffChunkRef[],
  bhavId: number,
): BhavParsed | null {
  const chunk = chunks.find((c) => c.kind === "BHAV" && c.id === bhavId);
  if (!chunk) return null;
  try {
    return wasm.parseBhav(
      data.subarray(chunk.dataStart, chunk.dataStart + chunk.dataLen),
    ) as BhavParsed;
  } catch {
    return null;
  }
}

/** Return a printable destination — sentinel returns or numeric IP. */
function formatDest(dest: number): string {
  if (dest === 0xff) return "ret_true";
  if (dest === 0xfe) return "ret_false";
  if (dest === 0xfd) return "ret_error";
  return `→${dest}`;
}

async function refreshDisasmForCurrentEvent(globalsFarPath: string | null): Promise<void> {
  const wasm = viewerState.wasm;
  const obj = viewerState.current;
  if (!wasm || !obj) {
    setDisasmOutput("");
    return;
  }
  const eventSelect = document.getElementById("event-select");
  if (!(eventSelect instanceof HTMLSelectElement) || eventSelect.value === "") {
    setDisasmOutput("");
    return;
  }
  const eventIdx = Number(eventSelect.value);
  const entry = obj.objfEntries[eventIdx];
  if (!entry || entry.action === 0) {
    setDisasmOutput("");
    return;
  }
  const actionId = entry.action;
  // Look up the action BHAV: private (object IFF) first, then semi-global (globals IFF).
  let bhav = findAndParseBhav(wasm, obj.data, obj.chunks, actionId);
  let source = "private";
  if (!bhav && globalsFarPath) {
    const targetName = obj.semiGlobalName ?? "Global";
    const globalsBytes = await loadSemiGlobalIff(wasm, globalsFarPath, targetName);
    if (globalsBytes) {
      const globalsChunks = wasm.parseIffChunks(globalsBytes) as IffChunkRef[];
      bhav = findAndParseBhav(wasm, globalsBytes, globalsChunks, actionId);
      source = "semi-global";
    }
  }
  if (!bhav) {
    setDisasmOutput(`BHAV 0x${actionId.toString(16).padStart(4, "0")}: not found`);
    return;
  }
  const header = `BHAV 0x${actionId.toString(16).padStart(4, "0")} (${source}) · ${bhav.instructions.length} instr · args=${bhav.args} locals=${bhav.locals}`;
  const lines: DisasmLine[] = bhav.instructions.map((ins, ip) => {
    const opLabel =
      ins.opcode < 256
        ? ((wasm.primitiveName(ins.opcode) as string | null) ?? `prim ${ins.opcode}`)
        : `call 0x${ins.opcode.toString(16).padStart(4, "0")}`;
    const decoded = wasm.formatPrimitiveOperand(ins.opcode, ins.operand) as string | null;
    const operandPart = decoded ? `  ${decoded}` : "";
    return { ip, opLabel, operandPart, tDest: ins.tDest, fDest: ins.fDest };
  });
  setDisasmStructured(header, lines);
}

function formatTraceEntry(
  wasm: Awaited<ReturnType<typeof engine>>,
  e: { depth: number; bhavId: number; ip: number; opcode: number; branch: string; operand?: string },
): string {
  const indent = "  ".repeat(e.depth);
  const bhavLabel = `0x${e.bhavId.toString(16).padStart(4, "0")}`;
  // <256 = primitive, ≥256 = sub-call into another BHAV (semi/private/global per range).
  const opLabel =
    e.opcode < 256
      ? ((wasm.primitiveName(e.opcode) as string | null) ?? `prim ${e.opcode}`)
      : `call 0x${e.opcode.toString(16).padStart(4, "0")}`;
  const operandPart = e.operand ? `  ${e.operand}` : "";
  return `${indent}${bhavLabel}#${e.ip} ${opLabel}${operandPart} → ${e.branch}`;
}

async function runMain(globalsFarPath: string | null): Promise<void> {
  const wasm = viewerState.wasm;
  const obj = viewerState.current;
  if (!wasm || !obj) {
    setRunOutput("(no object loaded)");
    return;
  }
  const eventSelect = document.getElementById("event-select");
  const eventIdx =
    eventSelect instanceof HTMLSelectElement && eventSelect.value !== ""
      ? Number(eventSelect.value)
      : 1;
  const eventName = EVENT_NAMES[eventIdx] ?? `Event ${eventIdx}`;
  const maxTicksInput = document.getElementById("max-ticks");
  const maxTicks =
    maxTicksInput instanceof HTMLInputElement
      ? Math.max(1, Math.min(1000, Number(maxTicksInput.value) || 1))
      : 1;
  setRunOutput("running…");
  let globalsBytes: Uint8Array = new Uint8Array(0);
  // When the object has no GLOB chunk, the engine falls back to `Global.iff` itself
  // (same convention as `examples/run_object.rs`).
  const targetName = obj.semiGlobalName ?? "Global";
  if (globalsFarPath) {
    const loaded = await loadSemiGlobalIff(wasm, globalsFarPath, targetName);
    if (loaded) globalsBytes = loaded;
  }
  try {
    const out = wasm.runObjectEvent(obj.data, globalsBytes, eventIdx, maxTicks) as RunOutput;
    const lines: string[] = [];
    lines.push(
      `event=${eventIdx} (${eventName}) action=0x${out.actionId.toString(16).padStart(4, "0")} outcome=${out.outcome}${out.exec ? ` (${out.exec})` : ""} · ticks=${out.ticksRan}/${maxTicks}`,
    );
    if (obj.semiGlobalName) lines.push(`semi-global: ${obj.semiGlobalName} (${globalsBytes.length}B)`);
    lines.push(`trace (${out.trace.length} steps):`);
    const limit = Math.min(out.trace.length, 80);
    for (let i = 0; i < limit; i++) {
      const entry = out.trace[i];
      if (entry) lines.push("  " + formatTraceEntry(wasm, entry));
    }
    if (out.trace.length > limit) lines.push(`  … +${out.trace.length - limit} more`);
    if (out.effects.length > 0) {
      lines.push(`effects (${out.effects.length}):`);
      for (const ef of out.effects) lines.push("  " + formatEffect(ef));
    }
    setRunOutput(lines.join("\n"));
  } catch (err) {
    setRunOutput(`run failed: ${(err as Error).message}`);
  }
}

/** Fetch and disassemble simssound.HIT into the side panel. */
async function tryDisasmHit(
  wasm: Awaited<ReturnType<typeof engine>>,
  manifest: Awaited<ReturnType<typeof fetchManifest>>,
): Promise<void> {
  const hitFile = manifest.files.find((f) =>
    f.path.toLowerCase().endsWith("sounddata/simssound.hit"),
  );
  const target = document.getElementById("hit-output");
  if (!target) return;
  if (!hitFile) {
    target.textContent = "(simssound.HIT not in manifest)";
    return;
  }
  try {
    const res = await fetch(`/assets/${hitFile.path}`);
    if (!res.ok) {
      target.textContent = `fetch failed: ${res.status}`;
      return;
    }
    const data = new Uint8Array(await res.arrayBuffer());
    const meta = wasm.parseHit(data) as { major: number; minor: number; codeLen: number };
    const instrs = wasm.disasmHit(data) as Array<{
      address: number;
      opcode: number;
      mnemonic: string;
      args: string;
      byteLen: number;
    }>;
    const lines: string[] = [];
    lines.push(`HIT v${meta.major}.${meta.minor} · ${meta.codeLen}B code · ${instrs.length} instr`);
    for (const ins of instrs) {
      const addr = ins.address.toString(16).padStart(4, "0");
      lines.push(`  ${addr}: ${ins.mnemonic.padEnd(15)} ${ins.args}`);
    }
    target.textContent = lines.join("\n");
  } catch (err) {
    target.textContent = `disasm failed: ${(err as Error).message}`;
  }
}

/**
 * Initial viewer bootstrap: AlarmClock at south/zoom-3/base-graphic, plus catalog dropdown.
 * Returns a one-line summary for the HUD.
 */
async function tryRenderAlarmClockObject(
  wasm: Awaited<ReturnType<typeof engine>>,
  manifest: Awaited<ReturnType<typeof fetchManifest>>,
): Promise<string | null> {
  const objectsFar = manifest.files.find((f) =>
    f.path.toLowerCase().endsWith("objects/objects.far"),
  );
  if (!objectsFar) return null;
  const globalsFar = manifest.files.find((f) => f.path.toLowerCase().endsWith("global.far"));
  viewerState.wasm = wasm;
  mountStaticControls();
  void mountObjectSelector(wasm, objectsFar.path);
  void tryDisasmHit(wasm, manifest);
  await loadObjectByName(wasm, objectsFar.path, "AlarmClock.iff");
  const globalsFarPath = globalsFar ? globalsFar.path : null;
  const runBtn = document.getElementById("run-main-btn");
  if (runBtn instanceof HTMLButtonElement) {
    runBtn.addEventListener("click", () => {
      void runMain(globalsFarPath);
    });
  }
  const eventSelect = document.getElementById("event-select");
  if (eventSelect instanceof HTMLSelectElement) {
    eventSelect.addEventListener("change", () => {
      void refreshDisasmForCurrentEvent(globalsFarPath);
    });
  }
  // Wire `loadObjectByName` to also refresh the disasm panel for the new object's
  // currently-selected event (defaults to Main on each load).
  viewerState.onObjectLoaded = () => {
    void refreshDisasmForCurrentEvent(globalsFarPath);
  };
  // Trigger once for the initial object.
  void refreshDisasmForCurrentEvent(globalsFarPath);
  const obj = viewerState.current;
  return obj ? `viewer ${obj.objectName} (${obj.dgrps.length} DGRP)` : null;
}

const OBJECT_VIEWER_CANVAS = document.getElementById("object-viewer") as HTMLCanvasElement | null;
const OBJECT_LABEL = document.getElementById("object-label");

function setObjectLabel(text: string): void {
  if (OBJECT_LABEL) OBJECT_LABEL.textContent = text;
}

/** Composite decoded sprites onto the viewer canvas with their DGRP offsets. */
function composeObjectViewer(decoded: Array<{ sp: DgrpSprite; bmp: DecodedSprite }>): void {
  if (!OBJECT_VIEWER_CANVAS) return;
  const ctx = OBJECT_VIEWER_CANVAS.getContext("2d");
  if (!ctx) return;

  // Compute the bounding box of every sprite once positioned at its offset.
  // SPR2 offsets reference the centre of the compiled image; the viewer canvas
  // uses (W/2, H/2) as that centre. We size the canvas to fit, then clear.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { sp, bmp } of decoded) {
    const x0 = sp.spriteXOffset;
    const y0 = sp.spriteYOffset;
    if (x0 < minX) minX = x0;
    if (y0 < minY) minY = y0;
    if (x0 + bmp.width > maxX) maxX = x0 + bmp.width;
    if (y0 + bmp.height > maxY) maxY = y0 + bmp.height;
  }
  if (!Number.isFinite(minX)) return;

  const w = Math.max(64, Math.ceil(maxX - minX));
  const h = Math.max(64, Math.ceil(maxY - minY));
  OBJECT_VIEWER_CANVAS.width = w;
  OBJECT_VIEWER_CANVAS.height = h;
  ctx.clearRect(0, 0, w, h);
  // Z-order: paint by DGRP order (later sprites on top — matches the original engine).
  for (const { sp, bmp } of decoded) {
    const img = ctx.createImageData(bmp.width, bmp.height);
    img.data.set(bmp.rgba);
    const dx = sp.spriteXOffset - minX;
    const dy = sp.spriteYOffset - minY;
    ctx.putImageData(img, dx, dy);
  }
}

function drawSpriteToOverlay(decoded: { width: number; height: number; rgba: Uint8Array }): void {
  if (!SPRITE_CANVAS) return;
  SPRITE_CANVAS.width = decoded.width;
  SPRITE_CANVAS.height = decoded.height;
  const ctx = SPRITE_CANVAS.getContext("2d");
  if (!ctx) return;
  const img = ctx.createImageData(decoded.width, decoded.height);
  img.data.set(decoded.rgba);
  ctx.putImageData(img, 0, 0);
}

/** Synthetic FAR v1 with one entry "hi.txt" → "HELLO!". Mirrors the unit-test fixture. */
function buildSyntheticFar(): Uint8Array {
  const buf = new Uint8Array(16 + 6 + 4 + 16 + 6);
  const view = new DataView(buf.buffer);
  buf.set(new TextEncoder().encode("FAR!byAZ"), 0);
  view.setUint32(8, 1, true);
  view.setUint32(12, 22, true); // manifest after 16B header + 6B payload
  buf.set(new TextEncoder().encode("HELLO!"), 16);
  view.setUint32(22, 1, true); // entry_count
  view.setUint32(26, 6, true); // size_decompressed
  view.setUint32(30, 6, true); // size_compressed
  view.setUint32(34, 16, true); // offset
  view.setUint32(38, 6, true); // filename_length
  buf.set(new TextEncoder().encode("hi.txt"), 42);
  return buf;
}

/**
 * Synthetic PALT (6 colors, index 5 = green) + SPR2 v1000 (1×1 frame, color-only,
 * single pixel using palette index 5). Mirrors the Rust integration test fixture.
 */
function buildSyntheticSpr2(): { palt: Uint8Array; spr2: Uint8Array } {
  const palt = new Uint8Array(16 + 3 * 6);
  const paltView = new DataView(palt.buffer);
  paltView.setUint32(0, 1, true); // version
  paltView.setUint32(4, 6, true); // count
  palt.set([0x00, 0xff, 0x00], 16 + 5 * 3); // index 5 = green

  const spr2 = new Uint8Array(12 + 4 + 16 + 2 + 2 + 2 + 2);
  const v = new DataView(spr2.buffer);
  v.setUint32(0, 1000, true); // SPR2 v1000
  v.setUint32(4, 1, true); // sprite_count = 1
  v.setUint32(8, 1, true); // default_palette = 1
  v.setUint32(12, 16, true); // offset_table[0] = 16 (relative to start of SPR2 data)
  // Frame at offset 16
  v.setUint16(16, 1, true); // width
  v.setUint16(18, 1, true); // height
  v.setUint32(20, 0x01, true); // flags = color only
  v.setUint16(24, 0xa3a3, true); // palette = use default
  v.setUint16(26, 0, true); // transparent_color = 0 (palette[0] = (0,0,0))
  v.setInt16(28, 0, true); // y_loc
  v.setInt16(30, 0, true); // x_loc
  // RLE: row cmd 0 (fill), block size = 6
  v.setUint16(32, 6, true);
  // Pixel cmd 6 (color only), count=1
  v.setUint16(34, (6 << 13) | 1, true);
  spr2.set([0x05, 0x00], 36); // color idx 5 + pad
  // End marker (cmd=5)
  v.setUint16(38, 5 << 13, true);
  return { palt, spr2 };
}

/** Synthetic IFF v2.5 with one BHAV chunk (size 80, 4 bytes of payload). */
function buildSyntheticIff(): Uint8Array {
  const headerLen = 64;
  const chunkHeaderLen = 76;
  const chunkSize = 80;
  const buf = new Uint8Array(headerLen + chunkSize);
  const view = new DataView(buf.buffer);
  buf.set(new TextEncoder().encode("IFF FILE 2.5:TYPE FOLLOWED BY SIZE\0 JAMIE DOORNBOS & MAXIS 1"), 0);
  view.setUint32(60, 0, false); // rsmp_offset = 0 (BE)
  buf.set(new TextEncoder().encode("BHAV"), headerLen); // chunk type
  view.setUint32(headerLen + 4, chunkSize, false); // size BE
  view.setUint16(headerLen + 8, 1, false); // id BE
  view.setUint16(headerLen + 10, 0x0010, false); // flags BE
  buf.set([0xde, 0xad, 0xbe, 0xef], headerLen + chunkHeaderLen); // payload
  return buf;
}

// Keep the canvas crisp at any DPR. The CSS already constrains layout.
function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.floor(canvas.clientWidth * dpr);
  const h = Math.floor(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    renderer.gl.viewport(0, 0, w, h);
    drawHelloSims(renderer);
  }
}

window.addEventListener("resize", resize);
queueMicrotask(resize);
