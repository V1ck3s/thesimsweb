import { engine } from "./engine/wasm.js";
import { fetchManifest, readFarManifest, readIffFromFar, readStandaloneIff } from "./engine/assets.js";
import {
  renderIso,
  projectTileToScreen,
  screenToTile,
  type IsoScene,
  type IsoSceneSprite,
  type IsoEntity,
} from "./renderer/iso.js";

function findCanvas(): HTMLCanvasElement {
  const el = document.getElementById("game");
  if (!(el instanceof HTMLCanvasElement)) {
    throw new Error("canvas#game not found");
  }
  return el;
}

const canvas = findCanvas();

/** Lot scene state — populated as objects load. */
const lotScene: IsoScene = {
  gridSize: 16,
  sprites: [],
  entities: [],
  camera: { tileWidth: 64, centerX: 8, centerY: 8, rotation: 0 },
};

// ============================================================================
// Sim placeholder — a single tracked entity rendered as a procedural capsule.
// Walks between tiles via a fractional position interpolated over time.
// ============================================================================

interface SimState {
  name: string;
  /** Current rendered position (fractional tile coords). */
  fx: number;
  fy: number;
  /** Active walk animation, or null if idle. */
  walk: {
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    startMs: number;
    durMs: number;
  } | null;
  /** Optional hook fired when the Sim arrives at the walk target. */
  onArrive: (() => void) | null;
  /** Transient speech bubble shown above the Sim — replaces the name label
   *  for `expiresAtMs - now` ms. Used to surface VM effects (Dialog,
   *  ShowString, AnimateSim, PlaySound) during an interaction. */
  bubble: { text: string; expiresAtMs: number } | null;
}

const simState: SimState = {
  name: "Sim",
  fx: 8,
  fy: 8,
  walk: null,
  onArrive: null,
  bubble: null,
};

/** Queue of upcoming speech bubbles shown above the Sim, paced ~1.4 s each
 *  so multi-effect interactions don't collapse into one flash. */
const bubbleQueue: string[] = [];
let bubbleTimer: number | null = null;

function showBubble(text: string, durMs: number = 1400): void {
  bubbleQueue.push(text);
  if (bubbleTimer !== null) return;
  const advance = (): void => {
    const next = bubbleQueue.shift();
    if (next === undefined) {
      simState.bubble = null;
      bubbleTimer = null;
      ensureRenderLoop();
      return;
    }
    simState.bubble = { text: next, expiresAtMs: performance.now() + durMs };
    ensureRenderLoop();
    bubbleTimer = window.setTimeout(advance, durMs);
  };
  advance();
}

function clearBubbles(): void {
  bubbleQueue.length = 0;
  if (bubbleTimer !== null) {
    clearTimeout(bubbleTimer);
    bubbleTimer = null;
  }
  simState.bubble = null;
}

// TS1 motive index → label, in the order TTAB writes them. The 8th slot is
// nominally "Room" in TS1 (replaced or repurposed in TSO/expansions); we keep
// the canonical TS1 ordering.
const MOTIVE_NAMES = [
  "Hunger",
  "Comfort",
  "Hygiene",
  "Bladder",
  "Energy",
  "Fun",
  "Social",
  "Room",
] as const;

/** Motive values are stored in TS1's native range [-100, +100]. Bars start at
 *  comfortable defaults and decay slowly while idle. */
const motives: number[] = [60, 60, 60, 60, 60, 50, 50, 50];

const MOTIVE_DECAY_PER_S = 0.4; // ~24 pts / minute, brisker than TS1 for demo.

function clampMotive(v: number): number {
  return Math.max(-100, Math.min(100, v));
}

function tickMotives(deltaMs: number): void {
  const dec = MOTIVE_DECAY_PER_S * (deltaMs / 1000);
  for (let i = 0; i < motives.length; i += 1) {
    motives[i] = clampMotive((motives[i] ?? 0) - dec);
  }
  renderMotivesHud();
}

function applyMotiveEffects(
  ttabMotives: Array<{ effectMin: number; effectMax: number; personalityModifier: number }>,
): void {
  // TTAB stores up to 8 motive effects per interaction, in motive order.
  // effect_min..effect_max gives a bump range; we average them and let the
  // personality_modifier nudge if non-zero (we don't model personalities yet).
  for (let i = 0; i < ttabMotives.length && i < motives.length; i += 1) {
    const m = ttabMotives[i];
    if (!m) continue;
    if (m.effectMin === 0 && m.effectMax === 0) continue;
    const avg = (m.effectMin + m.effectMax) / 2;
    motives[i] = clampMotive((motives[i] ?? 0) + avg);
  }
  renderMotivesHud();
}

let motivesHudEl: HTMLDivElement | null = null;
function ensureMotivesHud(): HTMLDivElement {
  if (motivesHudEl) return motivesHudEl;
  const el = document.createElement("div");
  el.id = "motives-hud";
  el.style.cssText =
    "position:fixed;top:8px;left:8px;background:rgba(0,0,0,.55);padding:8px 10px;border-radius:6px;font:11px/1.4 ui-sans-serif,system-ui,sans-serif;color:#cde;width:200px;display:flex;flex-direction:column;gap:3px;";
  document.body.appendChild(el);
  motivesHudEl = el;
  return el;
}

function motiveColor(value: number): string {
  // Red below 0, amber 0..40, green above.
  if (value < 0) return "#d8533a";
  if (value < 40) return "#d8a13a";
  return "#5fb86b";
}

function renderMotivesHud(): void {
  const root = ensureMotivesHud();
  if (root.childElementCount !== MOTIVE_NAMES.length + 1) {
    root.innerHTML = "";
    const title = document.createElement("div");
    title.textContent = `${simState.name} · motives`;
    title.style.cssText = "color:#9ad;opacity:.85;margin-bottom:3px;";
    root.appendChild(title);
    for (let i = 0; i < MOTIVE_NAMES.length; i += 1) {
      const row = document.createElement("div");
      row.dataset["motiveIdx"] = String(i);
      row.style.cssText = "display:grid;grid-template-columns:60px 1fr 32px;gap:6px;align-items:center;";
      const lbl = document.createElement("span");
      lbl.textContent = MOTIVE_NAMES[i] ?? "";
      lbl.style.opacity = "0.85";
      const track = document.createElement("div");
      track.style.cssText = "position:relative;height:8px;background:#222;border-radius:3px;overflow:hidden;";
      const fill = document.createElement("div");
      fill.dataset["fill"] = "1";
      fill.style.cssText = "position:absolute;left:50%;top:0;bottom:0;width:0;background:#5fb86b;transition:width .15s linear,background-color .25s;";
      track.appendChild(fill);
      const num = document.createElement("span");
      num.dataset["num"] = "1";
      num.style.cssText = "text-align:right;font-variant-numeric:tabular-nums;";
      row.append(lbl, track, num);
      root.appendChild(row);
    }
  }
  const rows = root.querySelectorAll<HTMLDivElement>("div[data-motive-idx]");
  for (const row of rows) {
    const idx = parseInt(row.dataset["motiveIdx"] ?? "-1", 10);
    const v = motives[idx] ?? 0;
    const fill = row.querySelector<HTMLDivElement>("div[data-fill]");
    const num = row.querySelector<HTMLSpanElement>("span[data-num]");
    if (fill) {
      const half = Math.abs(v) / 100 / 2; // 0..0.5 of track width
      const widthPct = half * 100;
      if (v >= 0) {
        fill.style.left = "50%";
        fill.style.width = `${widthPct}%`;
      } else {
        fill.style.left = `${50 - widthPct}%`;
        fill.style.width = `${widthPct}%`;
      }
      fill.style.backgroundColor = motiveColor(v);
    }
    if (num) num.textContent = Math.round(v).toString().padStart(3, " ");
  }
}

let lastMotiveTick = performance.now();
function startMotivesLoop(): void {
  setInterval(() => {
    const now = performance.now();
    tickMotives(now - lastMotiveTick);
    lastMotiveTick = now;
  }, 1000);
}

/** "Play" lets clicks walk the Sim and trigger interactions; "Build" lets the
 *  user place new objects on empty tiles. Build is the legacy default for the
 *  dev viewer; Play is the new game-feel default. */
type LotMode = "play" | "build";
let lotMode: LotMode = "play";

function startWalk(toX: number, toY: number, onArrive: (() => void) | null = null): void {
  // Manhattan-ish duration: 350 ms per tile travelled, capped to keep responsiveness.
  const dist = Math.hypot(toX - simState.fx, toY - simState.fy);
  const durMs = Math.max(180, Math.min(2000, dist * 350));
  simState.walk = {
    fromX: simState.fx,
    fromY: simState.fy,
    toX,
    toY,
    startMs: performance.now(),
    durMs,
  };
  simState.onArrive = onArrive;
  ensureRenderLoop();
}

let renderLoopHandle: number | null = null;
function ensureRenderLoop(): void {
  if (renderLoopHandle !== null) return;
  const tick = (now: number): void => {
    let alive = false;
    if (simState.walk) {
      const w = simState.walk;
      const t = Math.min(1, (now - w.startMs) / w.durMs);
      // Smoothstep ease so the Sim doesn't jerk on start/stop.
      const eased = t * t * (3 - 2 * t);
      simState.fx = w.fromX + (w.toX - w.fromX) * eased;
      simState.fy = w.fromY + (w.toY - w.fromY) * eased;
      if (t >= 1) {
        simState.walk = null;
        const cb = simState.onArrive;
        simState.onArrive = null;
        cb?.();
      } else {
        alive = true;
      }
    }
    composeLotScene();
    if (alive) {
      renderLoopHandle = requestAnimationFrame(tick);
    } else {
      renderLoopHandle = null;
    }
  };
  renderLoopHandle = requestAnimationFrame(tick);
}

function simEntity(): IsoEntity {
  const label =
    simState.bubble && simState.bubble.expiresAtMs > performance.now()
      ? simState.bubble.text
      : simState.name;
  return {
    worldX: simState.fx,
    worldY: simState.fy,
    kind: "sim",
    color: "#7ab8ff",
    label,
  };
}

/** Find an empty tile adjacent to (objX, objY) the Sim can stand on. Returns
 *  the closest such tile to the Sim's current position; falls back to the
 *  object tile itself if every neighbour is occupied or off-grid. */
function adjacentTileFor(objX: number, objY: number): { x: number; y: number } {
  const N = lotScene.gridSize;
  const candidates = [
    [objX - 1, objY],
    [objX + 1, objY],
    [objX, objY - 1],
    [objX, objY + 1],
  ].filter(([x, y]) => {
    if (x === undefined || y === undefined) return false;
    if (x < 0 || y < 0 || x >= N || y >= N) return false;
    return !lotInstances.some((i) => i.worldX === x && i.worldY === y);
  });
  if (candidates.length === 0) return { x: objX, y: objY };
  candidates.sort(([ax, ay], [bx, by]) => {
    const da = Math.hypot((ax ?? 0) - simState.fx, (ay ?? 0) - simState.fy);
    const db = Math.hypot((bx ?? 0) - simState.fx, (by ?? 0) - simState.fy);
    return da - db;
  });
  const [x, y] = candidates[0]!;
  return { x: x ?? objX, y: y ?? objY };
}

/** Camera controls. tileWidth presets matching TS1's three zoom levels. */
const CAMERA_TILE_WIDTHS = [32, 64, 128] as const;
let cameraZoomIdx = 1;

function renderLot(): void {
  renderIso(canvas, lotScene);
}

function rotateCamera(deltaQuarters: 1 | -1): void {
  const r = lotScene.camera.rotation ?? 0;
  lotScene.camera.rotation = (((r + deltaQuarters) % 4 + 4) % 4) as 0 | 1 | 2 | 3;
  renderLot();
  updateCameraButtonHighlights();
}

function setCameraZoom(idx: number): void {
  cameraZoomIdx = Math.max(0, Math.min(CAMERA_TILE_WIDTHS.length - 1, idx));
  const tw = CAMERA_TILE_WIDTHS[cameraZoomIdx];
  if (typeof tw === "number") lotScene.camera.tileWidth = tw;
  renderLot();
  updateCameraButtonHighlights();
}

function mountCameraControls(): void {
  // Render a small bar in the top-right of the canvas with rotation + zoom buttons.
  const existing = document.getElementById("camera-controls");
  existing?.remove();
  const bar = document.createElement("div");
  bar.id = "camera-controls";
  bar.style.cssText =
    "position:fixed;top:8px;right:8px;display:flex;gap:6px;align-items:center;background:rgba(0,0,0,.55);padding:6px 8px;border-radius:4px;font:12px/1.3 ui-monospace,monospace;color:#9ad;";
  bar.innerHTML = `
    <span style="opacity:.7;">camera</span>
    <button data-cam="rot-l" title="Rotate left (Q)">⟲</button>
    <button data-cam="rot-r" title="Rotate right (E)">⟳</button>
    <span style="opacity:.5;">·</span>
    <span style="opacity:.7;">zoom</span>
    <button data-cam-zoom="0">far</button>
    <button data-cam-zoom="1">mid</button>
    <button data-cam-zoom="2">near</button>
    <span style="opacity:.5;">·</span>
    <span style="opacity:.7;">mode</span>
    <button data-cam-action="mode-play" title="Click walks the Sim & triggers interactions">play</button>
    <button data-cam-action="mode-build" title="Click places the viewer object on empty tiles">build</button>
    <span style="opacity:.5;">·</span>
    <button data-cam-action="save" title="Save current lot to server">save</button>
    <button data-cam-action="load" title="Reload lot from server">load</button>
    <button data-cam-action="reset" title="Clear all placed objects">reset</button>
  `;
  document.body.appendChild(bar);
  bar.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLButtonElement)) return;
    const cam = t.dataset["cam"];
    if (cam === "rot-l") rotateCamera(-1);
    else if (cam === "rot-r") rotateCamera(1);
    const zoomStr = t.dataset["camZoom"];
    if (zoomStr !== undefined) setCameraZoom(parseInt(zoomStr, 10));
    const action = t.dataset["camAction"];
    if (action === "reset") clearLot();
    else if (action === "save") void saveLot();
    else if (action === "load") void loadLot(true);
    else if (action === "mode-play") {
      lotMode = "play";
      updateModeButtonHighlights();
    } else if (action === "mode-build") {
      lotMode = "build";
      updateModeButtonHighlights();
    }
  });
  // Help blurb directly under the camera bar.
  const help = document.createElement("div");
  help.id = "lot-help";
  help.style.cssText =
    "position:fixed;top:46px;right:8px;background:rgba(0,0,0,.55);padding:4px 8px;border-radius:4px;font:11px/1.4 ui-monospace,monospace;color:#9ad;max-width:220px;text-align:right;";
  help.innerHTML =
    "<b>play</b>: click ground = walk Sim · click obj = walk + interact<br/><b>build</b>: click ground = place viewer obj<br/>right-click: rotate · shift+click: remove<br/>Q/E rotate camera · +/- zoom";
  document.body.appendChild(help);
  updateCameraButtonHighlights();
}

function updateCameraButtonHighlights(): void {
  const bar = document.getElementById("camera-controls");
  if (!bar) return;
  for (const btn of bar.querySelectorAll("button")) {
    if (!(btn instanceof HTMLButtonElement)) continue;
    const z = btn.dataset["camZoom"];
    if (z !== undefined) {
      btn.style.cssText = controlButtonStyle(parseInt(z, 10) === cameraZoomIdx);
    } else if (btn.dataset["cam"]) {
      btn.style.cssText = controlButtonStyle(false);
    }
  }
  updateModeButtonHighlights();
}

function updateModeButtonHighlights(): void {
  const bar = document.getElementById("camera-controls");
  if (!bar) return;
  for (const btn of bar.querySelectorAll<HTMLButtonElement>("button[data-cam-action]")) {
    const action = btn.dataset["camAction"];
    if (action === "mode-play") btn.style.cssText = controlButtonStyle(lotMode === "play");
    else if (action === "mode-build") btn.style.cssText = controlButtonStyle(lotMode === "build");
  }
}

window.addEventListener("keydown", (ev) => {
  if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement) return;
  switch (ev.key) {
    case "q":
    case "Q":
      rotateCamera(-1);
      break;
    case "e":
    case "E":
      rotateCamera(1);
      break;
    case "+":
    case "=":
      setCameraZoom(cameraZoomIdx + 1);
      break;
    case "-":
    case "_":
      setCameraZoom(cameraZoomIdx - 1);
      break;
    default:
      return;
  }
  ev.preventDefault();
});

mountCameraControls();
// Initial render: empty lot.
renderLot();

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
  // Update the lot scene: re-decode every placed instance + the transient
  // viewer overlay at the centre tile (8, 8). Camera rotation pivots around
  // (8, 8) so the viewer overlay stays put while placed instances orbit.
  composeLotScene();
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

// ============================================================================
// Multi-object lot — placed instances + click selection
// ============================================================================

interface LotInstance {
  id: number;
  obj: LoadedObject;
  worldX: number;
  worldY: number;
  direction: number;
  zoom: number;
  dgrpId: number;
  /** Lazy decoded sprites; null until first render of this instance. */
  decoded: Array<{ sp: DgrpSprite; bmp: DecodedSprite }> | null;
}

const lotInstances: LotInstance[] = [];
let nextLotInstanceId = 1;
let selectedInstanceId: number | null = null;

function placeOnLot(
  obj: LoadedObject,
  worldX: number,
  worldY: number,
  direction: number = 0x10,
  zoom: number = 3,
): LotInstance {
  let dgrpId = obj.baseGraphicId;
  if (!obj.dgrps.some((d) => d.id === dgrpId)) {
    dgrpId = obj.dgrps[0]?.id ?? 0;
  }
  const inst: LotInstance = {
    id: nextLotInstanceId++,
    obj,
    worldX,
    worldY,
    direction,
    zoom,
    dgrpId,
    decoded: null,
  };
  lotInstances.push(inst);
  return inst;
}

function decodeInstanceSprites(
  wasm: Awaited<ReturnType<typeof engine>>,
  inst: LotInstance,
): Array<{ sp: DgrpSprite; bmp: DecodedSprite }> {
  if (inst.decoded !== null) return inst.decoded;
  const out: Array<{ sp: DgrpSprite; bmp: DecodedSprite }> = [];
  if (!inst.obj.paltChunk) {
    inst.decoded = out;
    return out;
  }
  const dgrp = inst.obj.dgrps.find((d) => d.id === inst.dgrpId) ?? inst.obj.dgrps[0];
  if (!dgrp) {
    inst.decoded = out;
    return out;
  }
  // Try (direction, zoom); fall back to (any direction, zoom); fall back to first image.
  const image =
    dgrp.images.find(
      (i) => i.directionFlags === inst.direction && i.zoomLevel === inst.zoom,
    ) ??
    dgrp.images.find((i) => i.zoomLevel === inst.zoom) ??
    dgrp.images[0];
  if (!image) {
    inst.decoded = out;
    return out;
  }
  const palt = inst.obj.data.subarray(
    inst.obj.paltChunk.dataStart,
    inst.obj.paltChunk.dataStart + inst.obj.paltChunk.dataLen,
  );
  for (const sp of image.sprites) {
    const c = inst.obj.chunks.find((c) => c.kind === "SPR2" && c.id === sp.sprChunkId);
    if (!c) continue;
    try {
      const bmp = wasm.decodeSpr2Frame(
        inst.obj.data.subarray(c.dataStart, c.dataStart + c.dataLen),
        palt,
        sp.sprFrameNumber,
      ) as DecodedSprite;
      out.push({ sp, bmp });
    } catch (err) {
      console.warn(
        `[lot] SPR2 ${sp.sprChunkId}#${sp.sprFrameNumber} of ${inst.obj.iffName} decode failed:`,
        err,
      );
    }
  }
  inst.decoded = out;
  return out;
}

/** Rebuild `lotScene.sprites` from every placed instance + the transient viewer
 *  overlay (the side-panel-selected object, mirrored at the lot centre). */
function composeLotScene(): void {
  const wasm = viewerState.wasm;
  if (!wasm) return;
  const sprites: IsoSceneSprite[] = [];
  for (const inst of lotInstances) {
    const dec = decodeInstanceSprites(wasm, inst);
    for (const d of dec) {
      sprites.push({ bmp: d.bmp, sp: d.sp, worldX: inst.worldX, worldY: inst.worldY });
    }
  }
  // Viewer's current selection at the centre tile, as a one-off (no entry in
  // `lotInstances` so it doesn't pollute click hit-tests).
  const viewerObj = viewerState.current;
  if (viewerObj) {
    const transient: LotInstance = {
      id: 0,
      obj: viewerObj,
      worldX: 8,
      worldY: 8,
      direction: viewerState.direction,
      zoom: viewerState.zoom,
      dgrpId: viewerState.dgrpId,
      decoded: null,
    };
    for (const d of decodeInstanceSprites(wasm, transient)) {
      sprites.push({ bmp: d.bmp, sp: d.sp, worldX: 8, worldY: 8 });
    }
  }
  lotScene.sprites = sprites;
  lotScene.entities = [simEntity()];
  renderLot();
}

/** Hit-test a click on the main canvas against every placed instance.
 *  Returns the topmost (closest by depth, i.e. greatest sorted index) within
 *  half a tile of the click. */
function pickInstance(canvasX: number, canvasY: number): LotInstance | null {
  const cam = lotScene.camera;
  // Walk in painter's order (back-to-front, same sort as the renderer) so the
  // *front* sprite wins when several stack up under the cursor.
  const candidates = [...lotInstances].sort((a, b) => {
    const da = projectedDepth(a);
    const db = projectedDepth(b);
    return da - db;
  });
  let hit: LotInstance | null = null;
  const radius = cam.tileWidth / 2;
  for (const inst of candidates) {
    const { sx, sy } = projectTileToScreen(inst.worldX, inst.worldY, cam, canvas);
    const dx = sx - canvasX;
    const dy = sy - canvasY;
    if (Math.hypot(dx, dy) < radius) hit = inst;
  }
  return hit;
}

function projectedDepth(inst: LotInstance): number {
  const cam = lotScene.camera;
  let lx = inst.worldX - cam.centerX;
  let ly = inst.worldY - cam.centerY;
  switch (cam.rotation ?? 0) {
    case 1: { const t = lx; lx = -ly; ly = t; break; }
    case 2: lx = -lx; ly = -ly; break;
    case 3: { const t = lx; lx = ly; ly = -t; break; }
    default: break;
  }
  return lx + ly;
}

function onLotCanvasClick(ev: MouseEvent): void {
  const rect = canvas.getBoundingClientRect();
  const cx = (ev.clientX - rect.left) * (canvas.width / rect.width);
  const cy = (ev.clientY - rect.top) * (canvas.height / rect.height);
  const inst = pickInstance(cx, cy);
  if (inst) {
    if (ev.shiftKey) {
      // Shift-click on an existing instance removes it from the lot.
      removeFromLot(inst.id);
      return;
    }
    selectedInstanceId = inst.id;
    if (lotMode === "play") {
      // Walk the Sim to an adjacent tile, then open the pie menu.
      const dest = adjacentTileFor(inst.worldX, inst.worldY);
      startWalk(dest.x, dest.y, () => {
        const projected = projectTileToScreen(inst.worldX, inst.worldY, lotScene.camera, canvas);
        onLotInstanceSelected(inst, projected.sx, projected.sy);
      });
    } else {
      onLotInstanceSelected(inst, cx, cy);
    }
    return;
  }
  // Empty tile.
  const tile = screenToTile(cx, cy, lotScene.camera, canvas);
  if (
    tile.worldX < 0 ||
    tile.worldY < 0 ||
    tile.worldX >= lotScene.gridSize ||
    tile.worldY >= lotScene.gridSize
  ) {
    closeInteractionMenuImpl();
    return;
  }
  if (lotMode === "build") {
    // Place the viewer's currently-selected object on the empty tile.
    const obj = viewerState.current;
    if (!obj) {
      closeInteractionMenuImpl();
      return;
    }
    if (lotInstances.some((i) => i.worldX === tile.worldX && i.worldY === tile.worldY)) {
      closeInteractionMenuImpl();
      return;
    }
    placeOnLot(obj, tile.worldX, tile.worldY, viewerState.direction, viewerState.zoom);
    composeLotScene();
    closeInteractionMenuImpl();
    return;
  }
  // Play mode: walk the Sim to the clicked tile.
  closeInteractionMenuImpl();
  startWalk(tile.worldX, tile.worldY);
}

canvas.addEventListener("click", onLotCanvasClick);

// Right-click on a placed instance cycles through the 4 DGRP directions so
// the user can re-orient an object after it's been placed. The browser's own
// context menu is suppressed only when the right-click hits an instance.
canvas.addEventListener("contextmenu", (ev) => {
  const rect = canvas.getBoundingClientRect();
  const cx = (ev.clientX - rect.left) * (canvas.width / rect.width);
  const cy = (ev.clientY - rect.top) * (canvas.height / rect.height);
  const inst = pickInstance(cx, cy);
  if (!inst) return;
  ev.preventDefault();
  rotateInstance(inst);
});

const DIRECTION_CYCLE = [0x10, 0x40, 0x01, 0x04] as const;
function rotateInstance(inst: LotInstance): void {
  const idx = DIRECTION_CYCLE.indexOf(inst.direction as (typeof DIRECTION_CYCLE)[number]);
  inst.direction = DIRECTION_CYCLE[(idx + 1) % DIRECTION_CYCLE.length] ?? 0x10;
  inst.decoded = null;
  composeLotScene();
}

function removeFromLot(instanceId: number): void {
  const idx = lotInstances.findIndex((i) => i.id === instanceId);
  if (idx >= 0) {
    lotInstances.splice(idx, 1);
    if (selectedInstanceId === instanceId) selectedInstanceId = null;
    composeLotScene();
    closeInteractionMenuImpl();
  }
}

function clearLot(): void {
  lotInstances.length = 0;
  selectedInstanceId = null;
  composeLotScene();
  closeInteractionMenuImpl();
}

// ============================================================================
// Lot persistence — serializes the placed instances to /api/saves/current-lot.
// ============================================================================

interface SerializedLotInstance {
  iffName: string;
  worldX: number;
  worldY: number;
  direction: number;
  zoom: number;
  dgrpId: number;
}

const LOT_SAVE_ID = "current-lot";

let objectsFarPathCache: string | null = null;

function serializeLot(): SerializedLotInstance[] {
  return lotInstances.map((i) => ({
    iffName: i.obj.iffName,
    worldX: i.worldX,
    worldY: i.worldY,
    direction: i.direction,
    zoom: i.zoom,
    dgrpId: i.dgrpId,
  }));
}

async function saveLot(): Promise<void> {
  const payload = JSON.stringify(serializeLot());
  try {
    const res = await fetch(`/api/saves/${LOT_SAVE_ID}?name=Current%20Lot`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
    if (res.ok) console.info(`[lot] saved ${lotInstances.length} instance(s) (${payload.length}B)`);
    else console.warn(`[lot] save failed: ${res.status}`);
  } catch (err) {
    console.warn("[lot] save error:", err);
  }
}

async function loadLot(replace: boolean = true): Promise<void> {
  const wasm = viewerState.wasm;
  if (!wasm || !objectsFarPathCache) return;
  try {
    const res = await fetch(`/api/saves/${LOT_SAVE_ID}`);
    if (!res.ok) return; // 404 first time; that's fine.
    const text = await res.text();
    const data: SerializedLotInstance[] = JSON.parse(text);
    if (!Array.isArray(data)) return;
    if (replace) lotInstances.length = 0;
    for (const s of data) {
      try {
        const { data: iffBytes, chunks } = await readIffFromFar(objectsFarPathCache, s.iffName);
        const loaded = buildLoadedObject(wasm, s.iffName, iffBytes, chunks as IffChunkRef[]);
        if (loaded && loaded.dgrps.length > 0) {
          const inst = placeOnLot(loaded, s.worldX, s.worldY, s.direction, s.zoom);
          if (loaded.dgrps.some((d) => d.id === s.dgrpId)) inst.dgrpId = s.dgrpId;
          inst.decoded = null; // re-decode at next render in case dgrpId changed
        }
      } catch (err) {
        console.warn(`[lot] re-load ${s.iffName} failed:`, err);
      }
    }
    composeLotScene();
    console.info(`[lot] loaded ${lotInstances.length} instance(s) from save`);
  } catch (err) {
    console.warn("[lot] load error:", err);
  }
}

/** Hook for the pie-menu task: shows the interactions of the selected instance. */
function onLotInstanceSelected(inst: LotInstance | null, cx: number, cy: number): void {
  if (!inst) {
    closeInteractionMenuImpl();
    return;
  }
  console.info(
    `[lot] selected #${inst.id} ${inst.obj.objectName} @ (${inst.worldX}, ${inst.worldY})`,
  );
  showInteractionMenuImpl(inst, cx, cy);
}

/** Pre-populate the lot with a handful of objects so the user can immediately
 *  see multiple sprites + click-to-select. Best-effort: any IFF that fails to
 *  load is skipped silently. */
const DEMO_PLACEMENTS: ReadonlyArray<{ iff: string; x: number; y: number }> = [
  { iff: "AlarmClock.iff", x: 5, y: 5 },
  { iff: "BurglarAlarm.iff", x: 11, y: 5 },
  { iff: "FireAlarm.iff", x: 5, y: 11 },
  { iff: "CoffeeM.iff", x: 11, y: 11 },
  { iff: "CoffeeEsp.iff", x: 8, y: 13 },
];

async function mountLotDemo(
  wasm: Awaited<ReturnType<typeof engine>>,
  objectsFarPath: string,
): Promise<void> {
  for (const p of DEMO_PLACEMENTS) {
    try {
      const { data, chunks } = await readIffFromFar(objectsFarPath, p.iff);
      const loaded = buildLoadedObject(wasm, p.iff, data, chunks as IffChunkRef[]);
      if (loaded && loaded.dgrps.length > 0) {
        placeOnLot(loaded, p.x, p.y);
      }
    } catch (err) {
      console.warn(`[lot] demo placement ${p.iff} failed:`, err);
    }
  }
  composeLotScene();
}

// ============================================================================
// Pie / interaction menu — surfaces an object's TTAB rows when it's clicked.
// ============================================================================

interface TtabInteraction {
  actionFunction: number;
  guardFunction: number;
  motiveEntryCount: number;
  flags: number;
  ttasIndex: number;
  attenuationCode: number;
  attenuationValue: number;
  autonomyThreshold: number;
  joiningIndex: number;
  motives: Array<{ effectMin: number; effectMax: number; personalityModifier: number }>;
}

interface TtasEntry {
  kind: "single" | "pair" | "lang";
  data: Uint8Array;
  comment?: Uint8Array;
  langCode?: number;
}

interface InteractionMenuRow {
  label: string;
  actionFunction: number;
  joiningIndex: number;
  guardFunction: number;
  ttabMotives?: Array<{ effectMin: number; effectMax: number; personalityModifier: number }>;
}

let interactionMenuEl: HTMLDivElement | null = null;
let lastInteractionInst: LotInstance | null = null;
const TEXT_DECODER = new TextDecoder("latin1");

function trimNullTerminated(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return TEXT_DECODER.decode(end < 0 ? bytes : bytes.subarray(0, end));
}

function ttasLabelAt(entries: TtasEntry[], index: number, fallback: string): string {
  // STR# v-3 (kind="lang") interleaves the same labels in every language —
  // pick the first language present and re-index within that group so the
  // ttab index lines up with the right entry.
  let target: TtasEntry | undefined;
  if (entries.length > 0 && entries[0]?.kind === "lang") {
    const firstLang = entries[0].langCode ?? 0;
    let count = 0;
    for (const e of entries) {
      if (e.langCode !== firstLang) continue;
      if (count === index) {
        target = e;
        break;
      }
      count++;
    }
  } else {
    target = entries[index];
  }
  if (!target) return fallback;
  const text = trimNullTerminated(target.data).trim();
  return text.length > 0 ? text : fallback;
}

function buildInteractionRows(
  wasm: Awaited<ReturnType<typeof engine>>,
  inst: LotInstance,
): InteractionMenuRow[] {
  const ttabChunk = inst.obj.chunks.find((c) => c.kind === "TTAB");
  const ttasChunk = inst.obj.chunks.find((c) => c.kind === "TTAs");
  if (!ttabChunk) return [];
  let ttab: { interactions: TtabInteraction[] };
  try {
    ttab = wasm.parseTtab(
      inst.obj.data.subarray(ttabChunk.dataStart, ttabChunk.dataStart + ttabChunk.dataLen),
    ) as { interactions: TtabInteraction[] };
  } catch (err) {
    // TTAB v9+ uses field-encoded compression we don't decode yet.
    console.info(`[pie] TTAB v9+ on ${inst.obj.iffName} (${(err as Error).message})`);
    return [];
  }
  let ttas: { entries: TtasEntry[] } = { entries: [] };
  if (ttasChunk) {
    try {
      ttas = wasm.parseStrTable(
        inst.obj.data.subarray(ttasChunk.dataStart, ttasChunk.dataStart + ttasChunk.dataLen),
      ) as { entries: TtasEntry[] };
    } catch (err) {
      console.warn(`[pie] TTAs parse failed for ${inst.obj.iffName}:`, err);
    }
  }
  return ttab.interactions.map((it, idx) => ({
    label: ttasLabelAt(ttas.entries, it.ttasIndex, `Interaction ${idx}`),
    actionFunction: it.actionFunction,
    joiningIndex: it.joiningIndex,
    guardFunction: it.guardFunction,
    ttabMotives: it.motives,
  }));
}

function ensureMenuEl(): HTMLDivElement {
  if (interactionMenuEl) return interactionMenuEl;
  const el = document.createElement("div");
  el.id = "pie-menu";
  el.style.cssText =
    "position:fixed;display:none;z-index:50;min-width:200px;max-width:320px;background:rgba(20,28,40,.96);border:1px solid #345;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.5);padding:6px 0;font:12px/1.4 ui-sans-serif,system-ui,sans-serif;color:#cde;";
  document.body.appendChild(el);
  document.addEventListener("click", (ev) => {
    // Close on outside click. The canvas-click handler runs first and reopens
    // the menu, so this only fires when the click is *outside* the menu and
    // off the canvas.
    if (!(ev.target instanceof Node)) return;
    if (interactionMenuEl?.contains(ev.target)) return;
    if (ev.target === canvas) return;
    closeInteractionMenuImpl();
  });
  interactionMenuEl = el;
  return el;
}

function closeInteractionMenuImpl(): void {
  if (interactionMenuEl) interactionMenuEl.style.display = "none";
  lastInteractionInst = null;
}

function showInteractionMenuImpl(inst: LotInstance, cx: number, cy: number): void {
  const wasm = viewerState.wasm;
  if (!wasm) return;
  const rows = buildInteractionRows(wasm, inst);
  const menu = ensureMenuEl();
  menu.innerHTML = "";
  const header = document.createElement("div");
  header.textContent = `${inst.obj.objectName}  ·  ${rows.length} interaction${rows.length === 1 ? "" : "s"}`;
  header.style.cssText = "padding:4px 10px;border-bottom:1px solid #345;color:#9ad;opacity:.8;";
  menu.appendChild(header);
  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.textContent = "(TTAB v9 not yet decoded — try a vanilla TS1 object)";
    empty.style.cssText = "padding:6px 10px;opacity:.6;";
    menu.appendChild(empty);
  } else {
    for (const r of rows) {
      const btn = document.createElement("button");
      btn.textContent = r.label;
      btn.style.cssText =
        "display:block;width:100%;text-align:left;background:transparent;border:none;color:#cde;padding:6px 10px;font:inherit;cursor:pointer;";
      btn.addEventListener("mouseenter", () => {
        btn.style.background = "rgba(80,140,200,.18)";
      });
      btn.addEventListener("mouseleave", () => {
        btn.style.background = "transparent";
      });
      btn.addEventListener("click", () => {
        closeInteractionMenuImpl();
        void runInteractionFromMenu(inst, r);
      });
      menu.appendChild(btn);
    }
  }
  // Position: anchor near the click but keep on-screen.
  const pad = 8;
  const rect = canvas.getBoundingClientRect();
  const left = Math.min(window.innerWidth - 340, rect.left + (cx / canvas.width) * rect.width + pad);
  const top = Math.min(window.innerHeight - 320, rect.top + (cy / canvas.height) * rect.height + pad);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.display = "block";
  lastInteractionInst = inst;
}

let lotGlobalsFarPath: string | null = null;
async function runInteractionFromMenu(
  inst: LotInstance,
  row: InteractionMenuRow,
): Promise<void> {
  // Bump motives based on this interaction's TTAB row before running, so the
  // user sees feedback immediately even if the BHAV is short.
  if (row.ttabMotives) {
    applyMotiveEffects(row.ttabMotives);
  }
  const wasm = viewerState.wasm;
  if (!wasm) return;
  let globalsBytes: Uint8Array = new Uint8Array(0);
  const targetName = inst.obj.semiGlobalName ?? "Global";
  if (lotGlobalsFarPath) {
    const loaded = await loadSemiGlobalIff(wasm, lotGlobalsFarPath, targetName);
    if (loaded) globalsBytes = loaded;
  }
  try {
    const out = wasm.runInteraction(
      inst.obj.data,
      globalsBytes,
      row.actionFunction,
      row.joiningIndex,
      32,
    ) as RunOutput;
    const lines: string[] = [];
    lines.push(
      `[${inst.obj.objectName}] ${row.label}  ·  action=0x${row.actionFunction.toString(16).padStart(4, "0")}  ·  ${out.outcome}${out.exec ? ` (${out.exec})` : ""}  ·  ticks=${out.ticksRan}`,
    );
    lines.push(`trace (${out.trace.length} steps):`);
    const limit = Math.min(out.trace.length, 60);
    for (let i = 0; i < limit; i++) {
      const e = out.trace[i];
      if (e) lines.push("  " + formatTraceEntry(wasm, e));
    }
    if (out.trace.length > limit) lines.push(`  … +${out.trace.length - limit}`);
    clearBubbles();
    showBubble(`▶ ${row.label}`);
    if (out.effects.length > 0) {
      lines.push(`effects (${out.effects.length}):`);
      const playable: string[] = [];
      for (const ef of out.effects) {
        let line = "  " + formatEffect(ef);
        if (ef.kind === "PlaySound") {
          const eventId = Number(ef["eventId"]);
          const r = resolvePlaySound(wasm, inst.obj.data, eventId);
          if (r) {
            const tail: string[] = [r.eventName];
            if (r.patchPath) tail.push(r.patchPath);
            line += `  → ${tail.join(" · ")}`;
            if (r.patchPath?.toLowerCase().endsWith(".xa")) playable.push(r.patchPath);
            showBubble(`♪ ${r.eventName}`);
            // Auto-play the resolved patch through Web Audio so the user hears
            // the sound without having to click the manual ▶ button.
            if (r.patchPath?.toLowerCase().endsWith(".xa") && hitAudioManifest) {
              void playXaPath(wasm, hitAudioManifest, r.patchPath).catch(() => {});
            }
          }
        } else if (ef.kind === "AnimateSim") {
          showBubble(`anim 0x${Number(ef["animId"]).toString(16)}`);
        } else if (ef.kind === "Dialog") {
          showBubble(`💬 dialog ${ef["flavour"]} #${ef["stringIndex"]}`);
        } else if (ef.kind === "ShowString") {
          showBubble(`"${String(ef["stringKind"] ?? "")}"`);
        } else if (ef.kind === "SetBalloon") {
          showBubble(`(balloon ${ef["balloonKind"]})`);
        } else if (ef.kind === "SetActionString") {
          showBubble(`action #${ef["stringIndex"]}`);
        }
        lines.push(line);
      }
      if (playable.length > 0) setHitAudioControls(wasm, playable);
    }
    setRunOutput(lines.join("\n"));
  } catch (err) {
    setRunOutput(`interaction failed: ${(err as Error).message}`);
    showBubble("⚠ failed");
  }
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
      const playablePatches: string[] = [];
      for (const ef of out.effects) {
        let line = "  " + formatEffect(ef);
        if (ef.kind === "PlaySound") {
          const eventId = Number(ef["eventId"]);
          const resolved = resolvePlaySound(wasm, obj.data, eventId);
          if (resolved) {
            const tail: string[] = [];
            tail.push(resolved.eventName);
            if (typeof resolved.trackId === "number") {
              tail.push(`track=0x${resolved.trackId.toString(16)}`);
            }
            if (resolved.patchPath) {
              tail.push(resolved.patchPath);
            }
            line += `  → ${tail.join(" · ")}`;
            if (resolved.patchPath?.toLowerCase().endsWith(".xa")) {
              playablePatches.push(resolved.patchPath);
            }
          }
        }
        lines.push(line);
      }
      // Surface a Play button strip in the HIT-sandbox audio controls so the
      // user can immediately hear sounds the BHAV would have triggered.
      if (playablePatches.length > 0) {
        setHitAudioControls(wasm, playablePatches);
      }
    }
    setRunOutput(lines.join("\n"));
  } catch (err) {
    setRunOutput(`run failed: ${(err as Error).message}`);
  }
}

interface ResolvedSoundEvent {
  eventId: number;
  eventName: string;
  eventKind?: number;
  trackId?: number;
  entryAddress?: number;
  patchName?: string;
  patchPath?: string;
}

/** Best-effort: try every loaded HOT pair (SimsSound, SimsGeneratedHitSource) until
 *  one resolves the given FWAV chunk id to an event. Returns the first hit. */
function resolvePlaySound(
  wasm: Awaited<ReturnType<typeof engine>>,
  iffData: Uint8Array,
  eventId: number,
): ResolvedSoundEvent | null {
  for (const f of hitSandboxState.files) {
    const r = wasm.resolveSoundEvent(iffData, f.hotText, eventId) as ResolvedSoundEvent | null;
    if (r && r.eventName) return r;
  }
  return null;
}

/** Fetch and disassemble simssound.HIT into the side panel. Also mounts the
 *  HIT Sandbox (event picker + Run button) using the matching SimsSound.hot. */
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
    // Wire the HIT Sandbox (event picker + Run) using SimsSound.hot.
    const hotPath = hitFile.path.replace(/simssound\.hit$/i, "SimsSound.hot");
    void mountHitSandbox(wasm, data, hotPath, manifest);
  } catch (err) {
    target.textContent = `disasm failed: ${(err as Error).message}`;
  }
}

interface HotEventMapping {
  name: string;
  eventKind: number;
  trackId: number;
  extraArgs: number[];
}
interface HotPatch {
  id: number;
  name: string;
  soundPath: string;
  looped: boolean;
  piano: boolean;
}
interface HotTrack {
  id: number;
  subroutineName: string;
  volume: number;
  argsKind: string;
  duckingPriority: string;
  controlGroup: string;
  spl: string;
  hitlistId: string;
  patchId: string;
}
interface HotFile {
  trackData: Array<{ trackId: number; address: number }>;
  eventMapping: HotEventMapping[];
  patches: HotPatch[];
  tracks: HotTrack[];
  equates: Array<{ name: string; value: number }>;
}

interface HitSandboxFile {
  label: string;
  hot: HotFile;
  hotText: string;
  hitData: Uint8Array;
}
interface HitSandboxState {
  files: HitSandboxFile[];
  selected: number;
}
const hitSandboxState: HitSandboxState = { files: [], selected: 0 };

async function mountHitSandbox(
  wasm: Awaited<ReturnType<typeof engine>>,
  hitData: Uint8Array,
  hotPath: string,
  manifest: Awaited<ReturnType<typeof fetchManifest>>,
): Promise<void> {
  hitAudioManifest = manifest;
  const fileSelect = document.getElementById("hit-file-select");
  const eventSelect = document.getElementById("hit-event-select");
  const runBtn = document.getElementById("hit-run-btn");
  const output = document.getElementById("hit-sandbox-output");
  if (
    !(fileSelect instanceof HTMLSelectElement) ||
    !(eventSelect instanceof HTMLSelectElement) ||
    !runBtn ||
    !output
  ) {
    return;
  }

  // Load the small (SimsSound) pair already passed in.
  const baseHotRes = await fetch(`/assets/${hotPath}`);
  if (baseHotRes.ok) {
    const baseHotText = await baseHotRes.text();
    const baseHot = wasm.parseHot(baseHotText) as HotFile;
    hitSandboxState.files.push({
      label: "SimsSound",
      hot: baseHot,
      hotText: baseHotText,
      hitData,
    });
  }

  // Try to also load the bigger SimsGeneratedHitSource pair (mostly voice .xa).
  const dir = hotPath.replace(/[^/]+$/, "");
  const bigHitFile = manifest.files.find((f) =>
    f.path.toLowerCase().endsWith("sounddata/simsgeneratedhitsource.hit"),
  );
  if (bigHitFile) {
    try {
      const [hitRes, hotRes] = await Promise.all([
        fetch(`/assets/${bigHitFile.path}`),
        fetch(`/assets/${dir}SimsGeneratedHitSource.hot`),
      ]);
      if (hitRes.ok && hotRes.ok) {
        const data = new Uint8Array(await hitRes.arrayBuffer());
        const hotText = await hotRes.text();
        const hot = wasm.parseHot(hotText) as HotFile;
        hitSandboxState.files.push({
          label: "SimsGeneratedHitSource",
          hot,
          hotText,
          hitData: data,
        });
      }
    } catch (err) {
      console.warn("optional SimsGeneratedHitSource load failed", err);
    }
  }

  if (hitSandboxState.files.length === 0) {
    output.textContent = "no HIT/HOT pair available";
    return;
  }

  fileSelect.replaceChildren();
  for (const [idx, f] of hitSandboxState.files.entries()) {
    const opt = document.createElement("option");
    opt.value = String(idx);
    opt.textContent = `${f.label} (${f.hot.eventMapping.length} events · ${f.hot.patches.length} patches)`;
    fileSelect.appendChild(opt);
  }
  fileSelect.addEventListener("change", () => {
    hitSandboxState.selected = parseInt(fileSelect.value, 10) || 0;
    refreshHitEventSelect();
  });
  refreshHitEventSelect();

  output.textContent = `${hitSandboxState.files.length} HIT pair(s) loaded — pick an event and Run`;

  runBtn.addEventListener("click", () => {
    runHitSandbox(wasm);
  });
}

function refreshHitEventSelect(): void {
  const select = document.getElementById("hit-event-select");
  if (!(select instanceof HTMLSelectElement)) return;
  const file = hitSandboxState.files[hitSandboxState.selected];
  if (!file) return;
  const trackAddr = new Map<number, number>();
  for (const td of file.hot.trackData) trackAddr.set(td.trackId, td.address);
  select.replaceChildren();
  const sortedEvents = [...file.hot.eventMapping].sort((a, b) => a.name.localeCompare(b.name));
  for (const ev of sortedEvents) {
    const addr = trackAddr.get(ev.trackId);
    if (addr === undefined) continue;
    const opt = document.createElement("option");
    opt.value = ev.name;
    opt.textContent = `${ev.name} (track 0x${ev.trackId.toString(16)} → 0x${addr.toString(16)})`;
    select.appendChild(opt);
  }
}

function mountRadio(manifest: Awaited<ReturnType<typeof fetchManifest>>): void {
  const stationSel = document.getElementById("radio-station-select");
  const trackSel = document.getElementById("radio-track-select");
  const audio = document.getElementById("radio-audio");
  if (
    !(stationSel instanceof HTMLSelectElement) ||
    !(trackSel instanceof HTMLSelectElement) ||
    !(audio instanceof HTMLAudioElement)
  ) {
    return;
  }
  const stations = new Map<string, Array<{ path: string; name: string }>>();
  for (const f of manifest.files) {
    const lower = f.path.toLowerCase();
    if (!lower.endsWith(".mp3")) continue;
    const m = lower.match(/music\/stations\/([^/]+)\//);
    if (!m) continue;
    const stationName = m[1];
    if (!stationName) continue;
    if (!stations.has(stationName)) stations.set(stationName, []);
    const fileName = f.path.split("/").pop() ?? f.path;
    stations.get(stationName)!.push({ path: f.path, name: fileName });
  }
  if (stations.size === 0) {
    stationSel.disabled = true;
    return;
  }
  const sorted = [...stations.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  stationSel.replaceChildren();
  for (const [name] of sorted) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    stationSel.appendChild(opt);
  }
  const refreshTracks = (): void => {
    const tracks = stations.get(stationSel.value);
    if (!tracks) return;
    trackSel.replaceChildren();
    for (const t of tracks) {
      const opt = document.createElement("option");
      opt.value = t.path;
      opt.textContent = t.name;
      trackSel.appendChild(opt);
    }
    if (tracks.length > 0 && tracks[0]) {
      audio.src = `/assets/${tracks[0].path}`;
    }
  };
  stationSel.addEventListener("change", refreshTracks);
  trackSel.addEventListener("change", () => {
    audio.src = `/assets/${trackSel.value}`;
    void audio.play().catch(() => {
      /* user interaction needed */
    });
  });
  refreshTracks();
}

// ---- Web Audio routing ----
let sharedAudioContext: AudioContext | null = null;
function getAudioContext(): AudioContext {
  if (sharedAudioContext === null) {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) throw new Error("Web Audio API not supported");
    sharedAudioContext = new Ctx();
  }
  return sharedAudioContext;
}

async function playXaPath(
  wasm: Awaited<ReturnType<typeof engine>>,
  manifest: Awaited<ReturnType<typeof fetchManifest>>,
  patchPath: string,
): Promise<void> {
  // patchPath is the Maxis-relative path like "SoundData\Sfx\foo.xa".
  // Convert backslashes and find the matching manifest entry.
  const normalized = patchPath.replace(/\\/g, "/").toLowerCase();
  const file = manifest.files.find((f) => f.path.toLowerCase().endsWith(normalized));
  if (!file) {
    throw new Error(`patch not in manifest: ${patchPath}`);
  }
  const res = await fetch(`/assets/${file.path}`);
  if (!res.ok) throw new Error(`fetch ${file.path}: ${res.status}`);
  const data = new Uint8Array(await res.arrayBuffer());
  const decoded = wasm.decodeXa(data) as { wav: Uint8Array };
  const ctx = getAudioContext();
  if (ctx.state === "suspended") await ctx.resume();
  const wavBuf = new ArrayBuffer(decoded.wav.byteLength);
  new Uint8Array(wavBuf).set(decoded.wav);
  const buf = await ctx.decodeAudioData(wavBuf);
  const source = ctx.createBufferSource();
  source.buffer = buf;
  source.connect(ctx.destination);
  source.start();
}

let hitAudioManifest: Awaited<ReturnType<typeof fetchManifest>> | null = null;

function setHitAudioControls(
  wasm: Awaited<ReturnType<typeof engine>>,
  patchPaths: string[],
): void {
  const host = document.getElementById("hit-audio-controls");
  if (!host) return;
  host.replaceChildren();
  if (patchPaths.length === 0) return;
  for (const path of patchPaths) {
    const btn = document.createElement("button");
    btn.textContent = `▶ ${path.split(/[\\\/]/).pop() ?? path}`;
    btn.style.cssText =
      "background:#246;color:#cef;border:1px solid #444;font:inherit;padding:3px 6px;cursor:pointer;border-radius:2px;";
    btn.title = path;
    btn.addEventListener("click", () => {
      const manifest = hitAudioManifest;
      if (!manifest) return;
      void playXaPath(wasm, manifest, path).catch((err: unknown) => {
        console.error("XA play failed", err);
        const out = document.getElementById("hit-sandbox-output");
        if (out) {
          out.textContent +=
            "\n[playback failed: " + (err instanceof Error ? err.message : String(err)) + "]";
        }
      });
    });
    host.appendChild(btn);
  }
}

function runHitSandbox(wasm: Awaited<ReturnType<typeof engine>>): void {
  const select = document.getElementById("hit-event-select");
  const stepsInput = document.getElementById("hit-max-steps");
  const output = document.getElementById("hit-sandbox-output");
  if (!(select instanceof HTMLSelectElement) || !output) return;
  const file = hitSandboxState.files[hitSandboxState.selected];
  if (!file) {
    output.textContent = "sandbox not initialised";
    return;
  }
  const hot = file.hot;
  const hitData = file.hitData;
  const eventName = select.value;
  const event = hot.eventMapping.find((e) => e.name === eventName);
  if (!event) {
    output.textContent = `no event named ${eventName}`;
    return;
  }
  const trackEntry = hot.trackData.find((t) => t.trackId === event.trackId);
  if (!trackEntry) {
    output.textContent = `track 0x${event.trackId.toString(16)} has no entry in TrackData`;
    return;
  }
  const maxSteps =
    stepsInput instanceof HTMLInputElement ? parseInt(stepsInput.value, 10) || 500 : 500;
  const args = new Int32Array([0, 0, 0, 0, 0]);
  try {
    const result = wasm.runHitTrack(hitData, trackEntry.address, args, maxSteps) as {
      steps: number;
      halted: boolean;
      exhausted: boolean;
      finalPc: number;
      error?: string;
      effects: Array<Record<string, unknown> & { kind: string }>;
      finalRegs: Record<string, number>;
    };
    const lines: string[] = [];
    const track = hot.tracks.find((t) => t.id === event.trackId);
    const subroutine = track?.subroutineName ?? "?";
    const patchName = track?.patchId ?? "";
    const patch =
      patchName && /^\d+$/.test(patchName)
        ? hot.patches.find((p) => p.id === parseInt(patchName, 10))
        : hot.patches.find((p) => p.name === patchName);
    lines.push(
      `event=${event.name} eventKind=${event.eventKind} track=0x${event.trackId.toString(16)} (${subroutine})`,
    );
    if (patch) {
      lines.push(`patch ${patch.name} → ${patch.soundPath}`);
    }
    lines.push(
      `entry=0x${trackEntry.address.toString(16)} steps=${result.steps} pc=0x${result.finalPc.toString(16)} halted=${result.halted} exhausted=${result.exhausted}`,
    );
    if (result.error) lines.push(`error: ${result.error}`);
    if (result.effects.length === 0) {
      lines.push("(no effects)");
    } else {
      lines.push(`effects (${result.effects.length}):`);
      for (const ef of result.effects.slice(0, 50)) {
        lines.push("  " + formatHitEffect(ef));
      }
      if (result.effects.length > 50) {
        lines.push(`  … ${result.effects.length - 50} more`);
      }
    }
    output.textContent = lines.join("\n");
    // Surface a Play button when the patch resolves to a known XA path.
    const patchPaths: string[] = [];
    if (patch && patch.soundPath.toLowerCase().endsWith(".xa")) {
      patchPaths.push(patch.soundPath);
    }
    setHitAudioControls(wasm, patchPaths);
  } catch (err) {
    output.textContent = `run failed: ${(err as Error).message}`;
    setHitAudioControls(wasm, []);
  }
}

function formatHitEffect(ef: Record<string, unknown> & { kind: string }): string {
  const kind = ef.kind;
  switch (kind) {
    case "PlayNote":
    case "PlayNoteLoop":
    case "StopNote":
      return `${kind} note=${String(ef["noteId"])}`;
    case "Wait":
      return `Wait ms=${String(ef["ms"])}`;
    case "WaitSamp":
      return "WaitSamp";
    case "PlayTrack":
    case "KillTrack":
    case "StopTrack":
      return `${kind} track=0x${Number(ef["trackId"]).toString(16)}`;
    case "SeqGroupKill":
    case "SeqGroupReturn":
      return `${kind} group=${String(ef["group"])}`;
    case "SeqGroupTrkId":
      return `SeqGroupTrkId a=${String(ef["a"])} b=${String(ef["b"])}`;
    case "Duck":
    case "Unduck":
    case "End":
    case "Return":
      return kind;
    case "SmartChoose":
      return `SmartChoose dest=${String(ef["destVar"])} hitlist=0x${Number(ef["hitlist"]).toString(16)} picked=${String(ef["picked"])}`;
    case "WaitVarCmp":
      return `Wait${String(ef["waitKind"])} v${String(ef["var1"])} v${String(ef["var2"])}`;
    case "SetLowLow":
    case "SetLowTime":
      return `${kind} dest=${String(ef["destVar"])} value=${String(ef["value"])}`;
    default:
      return kind;
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
  mountRadio(manifest);
  await loadObjectByName(wasm, objectsFar.path, "AlarmClock.iff");
  lotGlobalsFarPath = globalsFar ? globalsFar.path : null;
  objectsFarPathCache = objectsFar.path;
  renderMotivesHud();
  startMotivesLoop();
  // Try to restore the user's last lot first; if there is none, fall back to
  // the bundled demo placements so the page is never empty on boot.
  try {
    const saveRes = await fetch(`/api/saves/${LOT_SAVE_ID}`, { method: "HEAD" });
    if (saveRes.ok) {
      await loadLot(true);
    } else {
      void mountLotDemo(wasm, objectsFar.path);
    }
  } catch {
    void mountLotDemo(wasm, objectsFar.path);
  }
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
    renderLot();
  }
}

window.addEventListener("resize", resize);
queueMicrotask(resize);
