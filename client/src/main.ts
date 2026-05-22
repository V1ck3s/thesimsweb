import { engine } from "./engine/wasm.js";
import { fetchManifest, readFarManifest, readIffFromFar, readStandaloneIff } from "./engine/assets.js";
import { fetchTemplates, loadHouseTemplate, type TemplateEntry } from "./engine/house.js";
import { fetchNeighborhoodMap, type NeighborhoodLot } from "./engine/neighborhood.js";
import {
  deleteSave,
  getSave,
  listSaves,
  putSave,
  slugifySaveId,
  type SaveDescriptor,
} from "./engine/save.js";
import {
  renderIso,
  projectTileToScreen,
  screenToTile,
  type IsoScene,
  type IsoSceneSprite,
  type IsoEntity,
} from "./renderer/iso.js";
import { loadStrings, s as tStr, ss as tStrArr, getLocale } from "./ui/i18n.js";
import { mountCpanel, setCpanelMode } from "./ui/cpanel.js";
import { UI_BASE } from "./ui/bmp.js";

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

/** Viewer state hoisted to the top of the module so any function reached
 *  during top-level evaluation (key listeners, render path) can safely
 *  reference `viewerState.wasm` etc. without hitting the TDZ. TypeScript
 *  interfaces are hoisted at the type level, so `LoadedObject` resolves
 *  even though its declaration is below. */
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

// ============================================================================
// Debug-panel toggle. The static panels in index.html (sprite overlay, BHAV /
// HIT disassemblers, HIT sandbox, manifest HUD) are gated behind `.debug-only`
// CSS and only revealed when the user presses F9 / Ctrl+Shift+D or clicks the
// small "D" button bottom-right. Also respects `?debug=1` in the URL.
// ============================================================================

function setDebugMode(on: boolean): void {
  document.body.classList.toggle("debug-mode", on);
  try {
    localStorage.setItem("thesimsweb:debug", on ? "1" : "0");
  } catch {
    // localStorage may be unavailable in private mode — best-effort only.
  }
}

(function initDebugToggle(): void {
  const params = new URLSearchParams(window.location.search);
  let stored: string | null = null;
  try {
    stored = localStorage.getItem("thesimsweb:debug");
  } catch {
    // ignored
  }
  if (params.get("debug") === "1" || stored === "1") setDebugMode(true);
  const btn = document.getElementById("debug-toggle");
  btn?.addEventListener("click", () => {
    setDebugMode(!document.body.classList.contains("debug-mode"));
  });
  window.addEventListener("keydown", (ev) => {
    if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement) return;
    if (ev.key === "F9" || (ev.key === "D" && ev.ctrlKey && ev.shiftKey)) {
      setDebugMode(!document.body.classList.contains("debug-mode"));
      ev.preventDefault();
    }
  });
})();

function dismissBootSplash(): void {
  const splash = document.getElementById("boot-splash");
  if (!splash) return;
  splash.classList.add("hidden");
  setTimeout(() => splash.remove(), 500);
}

// ============================================================================
// Sim placeholder — a single tracked entity rendered as a procedural capsule.
// Walks between tiles via a fractional position interpolated over time.
// ============================================================================

/** TS1 personality has 5 axes; each is 0..10 with 5 = neutral. The pair labels
 *  match the in-game Create-A-Sim mapping (low end → high end).
 *  Index → (low, high):
 *    0: Sloppy  ↔ Neat
 *    1: Shy     ↔ Outgoing
 *    2: Lazy    ↔ Active
 *    3: Serious ↔ Playful
 *    4: Grouchy ↔ Nice
 *  Total points are capped at 25 in the original CAS but we don't enforce that
 *  client-side — the UI keeps the sum visible so the user can self-cap. */
export type Traits = readonly [number, number, number, number, number];

interface SimState {
  /** Stable id assigned at creation. Used as IsoEntity id and save key. */
  id: number;
  name: string;
  gender: "F" | "M";
  /** TS1 ships adult-only Sims for the base game. We expose the axis so neighborhood
   *  ageing makes sense, but mechanically only "Adult" has full behaviour today. */
  age: "Child" | "Adult" | "Elder";
  /** Optional free-text biography surfaced in the Sim selector. */
  bio: string;
  /** Personality 0..10 per axis. */
  traits: Traits;
  /** CSS color used for the head dot in the iso renderer. */
  headColor: string;
  /** CSS color used for the body bar in the iso renderer. */
  bodyColor: string;
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
  /** Per-Sim motive bars [-100, +100] in TS1 order (Hunger/Comfort/.../Room). */
  motives: number[];
  /** Cardinal facing in tile-space: 0 = +x, 1 = -y, 2 = -x, 3 = +y. Updated at
   *  the start of every walk segment so the renderer can spin a face dot. */
  facing: 0 | 1 | 2 | 3;
  /** Sim is napping on the floor — no decay, energy ticks up, can't be walked
   *  by autonomy. Toggled when energy hits a critical floor with no bed in
   *  reach. */
  sleeping: boolean;
}

const SIM_PALETTE = [
  { name: "Bella", color: "#7ab8ff", body: "#3a78c0" },
  { name: "Mortimer", color: "#d8a13a", body: "#9a6a1e" },
  { name: "Cassandra", color: "#cf6dd1", body: "#8a3f8c" },
  { name: "Don", color: "#5fb86b", body: "#3a8048" },
  { name: "Jeff", color: "#d8533a", body: "#9a3520" },
] as const;

function defaultTraits(): Traits {
  return [5, 5, 5, 5, 5];
}

function defaultMotives(): number[] {
  return [60, 60, 60, 60, 60, 50, 50, 50];
}

let nextSimId = 1;
function allocSimId(): number {
  const id = nextSimId;
  nextSimId += 1;
  return id;
}

const sims: SimState[] = [
  {
    id: allocSimId(),
    name: SIM_PALETTE[0]!.name,
    gender: "F",
    age: "Adult",
    bio: "Founding Sim — created at boot.",
    traits: defaultTraits(),
    headColor: SIM_PALETTE[0]!.color,
    bodyColor: SIM_PALETTE[0]!.body,
    fx: 8,
    fy: 8,
    walk: null,
    onArrive: null,
    bubble: null,
    motives: defaultMotives(),
    facing: 3,
    sleeping: false,
  },
];
let selectedSimIdx = 0;
const simColorOf = (i: number): string => SIM_PALETTE[i % SIM_PALETTE.length]!.color;

/** Proxy that always reads/writes the currently-selected Sim. Lets all the
 *  pre-existing `simState.X` references keep working without a rename. */
const simState = new Proxy({} as SimState, {
  get: (_, prop) => Reflect.get(sims[selectedSimIdx]!, prop),
  set: (_, prop, value) => Reflect.set(sims[selectedSimIdx]!, prop, value),
}) as SimState;

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

// STR# index inside Live.iff chunk 130 ("Motives") for each motive *label*.
// The chunk is [header, label, desc, label, desc, ...] so labels live at the
// odd indices. The TS1 order is Hunger, Energy, Comfort, Fun, Hygiene, Social,
// Bladder, Room — our internal order is different, so we map here.
const MOTIVE_STR_IDX = [
  1, // Hunger    → Appétit
  5, // Comfort   → Confort
  9, // Hygiene   → Hygiène
  13, // Bladder   → Petits besoins
  3, // Energy    → Energie
  7, // Fun       → Distractions
  11, // Social    → Vie sociale
  15, // Room      → Espace
] as const;

/** Localised motive name, falling back to the English code default. */
function motiveLabel(i: number): string {
  const idx = MOTIVE_STR_IDX[i];
  if (idx === undefined) return MOTIVE_NAMES[i] ?? "";
  return tStr("Live", 130, idx, MOTIVE_NAMES[i] ?? "");
}

const MOTIVE_DECAY_PER_S = 0.4; // ~24 pts / minute, brisker than TS1 for demo.

function clampMotive(v: number): number {
  return Math.max(-100, Math.min(100, v));
}

const MOTIVE_ENERGY_IDX = 4;
const MOTIVE_SOCIAL_IDX = 6;
const MOTIVE_ROOM_IDX = 7;

/** Compute a target value for the Room motive from the current lot's quality.
 *  Walls give the strongest signal — an unwalled lot is "open camping" and
 *  caps Room around 0; full enclosure with floor/objects pushes toward +80. */
function computeRoomTarget(): number {
  const N = lotScene.gridSize;
  const wallCount = wallsN.size + wallsW.size;
  const floorCount = floorPaint.size;
  const objCount = lotInstances.length;
  // Normalize: an enclosed 10×10 needs ≈ 40 wall edges, 100 floor tiles,
  // and 6+ objects to feel "homey". Each component contributes up to ~25.
  const wallScore = Math.min(1, wallCount / 40) * 30;
  const floorScore = Math.min(1, floorCount / (N * N * 0.4)) * 25;
  const objScore = Math.min(1, objCount / 8) * 25;
  // Penalty for visible litter: > 0.6 of motives critical drags everyone down.
  const tired = sims.filter((s) => (s.motives[MOTIVE_ENERGY_IDX] ?? 0) < -30).length;
  const penalty = Math.min(20, tired * 5);
  return Math.max(-50, Math.min(80, wallScore + floorScore + objScore - penalty - 10));
}

/** Per-motive decay multiplier driven by personality traits.
 *  Each axis (0..10, 5 = neutral) tilts a specific motive ±20% at the extremes.
 *  Mapping (intentionally simple, matches the original CAS "feel" loosely):
 *    Neat (axis 0 high)     → Hygiene/Bladder decay slower
 *    Active (axis 2 high)   → Energy decay faster but Fun decay slower
 *    Playful (axis 3 high)  → Fun decay faster, Comfort decay faster
 *    Outgoing (axis 1 high) → Social decay faster (they crave interaction)
 *    Nice (axis 4 high)     → Room decay slower (they're easy to please)
 *  These factors are deliberately mild; they nudge autonomy priority without
 *  making "Active" Sims unplayable. */
function traitDecayMultiplier(traits: Traits, motiveIdx: number): number {
  const tilt = (t: number): number => (t - 5) / 5; // -1..+1
  switch (motiveIdx) {
    case 2: // Hygiene
    case 3: // Bladder
      return 1 - 0.2 * tilt(traits[0] ?? 5);
    case 4: // Energy
      return 1 + 0.2 * tilt(traits[2] ?? 5);
    case 5: // Fun
      return 1 + 0.2 * tilt(traits[3] ?? 5) - 0.1 * tilt(traits[2] ?? 5);
    case 6: // Social
      return 1 + 0.25 * tilt(traits[1] ?? 5);
    case 7: // Room
      return 1 - 0.15 * tilt(traits[4] ?? 5);
    default:
      return 1;
  }
}

function tickMotives(deltaMs: number): void {
  const dec = MOTIVE_DECAY_PER_S * (deltaMs / 1000);
  const roomTarget = computeRoomTarget();
  // Decay every Sim's motives, not just the selected one — they all live on
  // the lot and get hungry/tired in parallel. Sleeping Sims don't decay and
  // their Energy regenerates at +2 / s; they wake when Energy crosses +20.
  for (const sim of sims) {
    if (sim.sleeping) {
      const e = sim.motives[MOTIVE_ENERGY_IDX] ?? 0;
      sim.motives[MOTIVE_ENERGY_IDX] = clampMotive(e + 2 * (deltaMs / 1000));
      if ((sim.motives[MOTIVE_ENERGY_IDX] ?? 0) >= 20) {
        sim.sleeping = false;
        sim.bubble = null;
      }
      continue;
    }
    for (let i = 0; i < sim.motives.length; i += 1) {
      if (i === MOTIVE_ROOM_IDX) {
        // Room drifts toward the lot's quality target at ~3 pts/s, biased by
        // the Nice trait (axis 4: nicer Sims forgive a messy lot faster).
        const current = sim.motives[i] ?? 0;
        const traitTilt = ((sim.traits[4] ?? 5) - 5) / 5; // -1..+1
        const driftRate = 3 * (1 + 0.3 * traitTilt) * (deltaMs / 1000);
        const diff = roomTarget - current;
        const step = Math.sign(diff) * Math.min(Math.abs(diff), driftRate);
        sim.motives[i] = clampMotive(current + step);
        continue;
      }
      const mult = traitDecayMultiplier(sim.traits, i);
      sim.motives[i] = clampMotive((sim.motives[i] ?? 0) - dec * mult);
    }
  }
  renderMotivesHud();
}

function applyMotiveEffects(
  ttabMotives: Array<{ effectMin: number; effectMax: number; personalityModifier: number }>,
  targetSim?: SimState,
): void {
  const target = targetSim ?? sims[selectedSimIdx];
  if (!target) return;
  const flashes: Array<{ idx: number; delta: number }> = [];
  for (let i = 0; i < ttabMotives.length && i < target.motives.length; i += 1) {
    const m = ttabMotives[i];
    if (!m) continue;
    if (m.effectMin === 0 && m.effectMax === 0) continue;
    const avg = (m.effectMin + m.effectMax) / 2;
    target.motives[i] = clampMotive((target.motives[i] ?? 0) + avg);
    flashes.push({ idx: i, delta: avg });
  }
  renderMotivesHud();
  if (target === sims[selectedSimIdx]) {
    for (const f of flashes) flashMotiveRow(f.idx, f.delta);
  }
}

function flashMotiveRow(idx: number, delta: number): void {
  const root = motivesHudEl;
  if (!root) return;
  const row = root.querySelector<HTMLDivElement>(`div[data-motive-idx="${idx}"]`);
  if (!row) return;
  const flash = document.createElement("span");
  flash.textContent = `${delta > 0 ? "+" : ""}${Math.round(delta)}`;
  flash.style.cssText =
    `position:absolute;right:34px;font-weight:600;color:${delta >= 0 ? "#9be08a" : "#ff8a78"};` +
    "pointer-events:none;opacity:1;transition:opacity .8s linear,transform .8s ease-out;";
  row.style.position = "relative";
  row.appendChild(flash);
  // Kick off the transition next frame.
  requestAnimationFrame(() => {
    flash.style.opacity = "0";
    flash.style.transform = "translateY(-10px)";
  });
  setTimeout(() => flash.remove(), 850);
}

let motivesHudEl: HTMLDivElement | null = null;
function ensureMotivesHud(): HTMLDivElement {
  const slot = document.querySelector<HTMLDivElement>("#ts1-panel [data-slot-body='motives']");
  if (motivesHudEl?.isConnected && motivesHudEl.parentElement === (slot ?? document.body)) {
    return motivesHudEl;
  }
  const el = motivesHudEl ?? document.createElement("div");
  el.id = "motives-hud";
  if (slot) {
    el.style.cssText = "display:flex;flex-direction:column;gap:3px;font:11px/1.35 ui-sans-serif,system-ui,sans-serif;color:#cde;";
    slot.appendChild(el);
  } else {
    el.style.cssText =
      "position:fixed;top:8px;left:8px;background:linear-gradient(180deg,#1a2840 0%,#0f1a2d 100%);border:1px solid #3a4a66;box-shadow:0 2px 8px rgba(0,0,0,.4);padding:8px 10px;border-radius:6px;font:11px/1.4 ui-sans-serif,system-ui,sans-serif;color:#cde;width:200px;display:flex;flex-direction:column;gap:3px;";
    document.body.appendChild(el);
  }
  motivesHudEl = el;
  return el;
}

function motiveColor(value: number): string {
  // Red below 0, amber 0..40, green above.
  if (value < 0) return "#d8533a";
  if (value < 40) return "#d8a13a";
  return "#5fb86b";
}

/** Overall mood for a Sim — average of the 8 motives, in [-100..100]. */
function computeMood(sim: { motives: number[] }): number {
  if (sim.motives.length === 0) return 0;
  let sum = 0;
  for (const v of sim.motives) sum += v;
  return sum / sim.motives.length;
}

/** Mix from red (-100) → amber (0) → green (+100). Returns rgb(). */
function moodColor(value: number): string {
  // Map [-100..100] to a 3-stop ramp.
  const t = Math.max(-100, Math.min(100, value)) / 100; // -1..1
  if (t < 0) {
    const k = -t; // 0..1 toward red
    const r = Math.round(216 + (216 - 216) * 0);
    const g = Math.round(161 - (161 - 83) * k);
    const b = Math.round(58 - (58 - 58) * k);
    return `rgb(${r},${g},${b})`;
  }
  // 0..1 toward green
  const r = Math.round(216 - (216 - 95) * t);
  const g = Math.round(161 + (184 - 161) * t);
  const b = Math.round(58 + (107 - 58) * t);
  return `rgb(${r},${g},${b})`;
}

function renderMotivesHud(): void {
  const root = ensureMotivesHud();
  // Authentic TS1 motive strip: 8 stacked rows, FR label on the left, a
  // HouseSubBarsOff.BMP-backed bar in the middle, value on the right. No mood
  // block (the LiveGadget portrait carries the mood ring instead).
  if (root.childElementCount !== MOTIVE_NAMES.length) {
    root.innerHTML = "";
    // No padding between rows so 8 × 10px fits in the ~80px slot.
    root.style.gap = "1px";
    for (let i = 0; i < MOTIVE_NAMES.length; i += 1) {
      const row = document.createElement("div");
      row.dataset["motiveIdx"] = String(i);
      row.style.cssText =
        "display:grid;grid-template-columns:90px 1fr 24px;gap:6px;align-items:center;height:9px;color:#ffdf80;font:9px/1 \"MS Sans Serif\",sans-serif;";
      const lbl = document.createElement("span");
      lbl.textContent = motiveLabel(i);
      lbl.dataset["lbl"] = "1";
      lbl.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      const track = document.createElement("div");
      track.style.cssText = [
        "position:relative",
        "height:8px",
        // Centre marker only — the bar fill renders as an inset coloured rect.
        `background:url("${UI_BASE}/Backgrounds/HouseSubBarsOff.BMP") no-repeat center center / 100% 100%`,
        "image-rendering:pixelated",
      ].join(";");
      const fill = document.createElement("div");
      fill.dataset["fill"] = "1";
      fill.style.cssText =
        "position:absolute;left:50%;top:1px;bottom:1px;width:0;background:#5fb86b;transition:width .15s linear,background-color .25s;";
      track.appendChild(fill);
      const num = document.createElement("span");
      num.dataset["num"] = "1";
      num.style.cssText =
        "text-align:right;font-variant-numeric:tabular-nums;font:9px/1 \"MS Sans Serif\",sans-serif;color:#ffdf80;";
      row.append(lbl, track, num);
      root.appendChild(row);
    }
  }
  const sim = sims[selectedSimIdx];
  if (!sim) return;
  // Refresh labels in case the locale changed since last build.
  for (const lbl of root.querySelectorAll<HTMLSpanElement>("span[data-lbl]")) {
    const row = lbl.parentElement;
    const idx = parseInt(row?.dataset["motiveIdx"] ?? "-1", 10);
    if (idx >= 0) lbl.textContent = motiveLabel(idx);
  }
  const rows = root.querySelectorAll<HTMLDivElement>("div[data-motive-idx]");
  for (const row of rows) {
    const idx = parseInt(row.dataset["motiveIdx"] ?? "-1", 10);
    const v = sim.motives[idx] ?? 0;
    const fill = row.querySelector<HTMLDivElement>("div[data-fill]");
    const num = row.querySelector<HTMLSpanElement>("span[data-num]");
    if (fill) {
      const half = Math.abs(v) / 100 / 2;
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
    if (document.hidden || gameSpeed === 0) {
      // Skip the elapsed window so motives don't snap-decay on tab refocus
      // or after a long pause.
      lastMotiveTick = now;
      return;
    }
    tickMotives((now - lastMotiveTick) * gameSpeed);
    lastMotiveTick = now;
  }, 1000);
}

// ============================================================================
// Game-clock + funds HUD — gives a real "Sims" feel of time passing.
// One real second = TIME_SCALE in-game minutes. Day starts at 08:00 Mon.
// ============================================================================

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const DAYS_FR = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"] as const;
const DAYS_BY_LOCALE = { 1: DAYS, 3: DAYS_FR } as const;
const TIME_SCALE = 1; // 1 in-game minute per real second @ 1×
let gameMinutes = 8 * 60; // 08:00 day 0
let gameDayIdx = 0;
let funds = 20000;
// TS1-style speed: 0 = paused, 1× / 2× / 3× scale every game loop (motives,
// clock, autonomy, walk duration). Default 1×.
type GameSpeed = 0 | 1 | 2 | 3;
let gameSpeed: GameSpeed = 1;
// `gamePaused` is kept as a derived alias for legacy code paths that still
// branch on it. New code should read `gameSpeed === 0`.
let gamePaused = false;
function setGameSpeed(s: GameSpeed): void {
  gameSpeed = s;
  gamePaused = s === 0;
  renderTimeFundsHud();
}
const TIME_HUD_ID = "time-funds-hud";

let timeHudEl: HTMLDivElement | null = null;
function ensureTimeFundsHud(): HTMLDivElement {
  const slot = document.querySelector<HTMLDivElement>("#ts1-panel [data-slot-body='time']");
  if (timeHudEl?.isConnected && timeHudEl.parentElement === (slot ?? document.body)) {
    return timeHudEl;
  }
  const el = timeHudEl ?? document.createElement("div");
  el.id = TIME_HUD_ID;
  const inPanel = slot !== null;
  el.style.cssText = inPanel
    ? "display:flex;flex-direction:column;gap:6px;font:12px/1.3 ui-sans-serif,system-ui,sans-serif;color:#cde;"
    : "position:fixed;top:8px;left:50%;transform:translateX(-50%);background:linear-gradient(180deg,#1a2840 0%,#0f1a2d 100%);border:1px solid #3a4a66;box-shadow:0 2px 8px rgba(0,0,0,.4);padding:6px 14px;border-radius:6px;font:12px/1.3 ui-sans-serif,system-ui,sans-serif;color:#cde;display:flex;gap:14px;align-items:center;";
  // Stacked layout when in the panel, inline when standalone. Inside the
  // panel: day + clock in the iconic TS1 yellow at the top, funds in green
  // underneath, then a row of 4 BMP-backed speed buttons (Pause + 1× + 2× + 3×).
  const SPEED_TOOLTIPS_VCTL_IDX = { 0: 15, 1: 16, 2: 17, 3: 18 } as const;
  el.innerHTML = inPanel
    ? `
      <div style="font:bold 12px/1.1 \"MS Sans Serif\",sans-serif;color:#ffdf80;text-shadow:0 1px 0 rgba(0,0,0,0.5);"><span data-th-day>Mon</span> <span data-th-time style="font-variant-numeric:tabular-nums;">08:00</span></div>
      <div style="font:bold 14px/1.1 \"MS Sans Serif\",sans-serif;color:#9be67a;text-shadow:0 1px 0 rgba(0,0,0,0.5);"><span style="color:#9be67a;">§</span><span data-th-funds style="font-variant-numeric:tabular-nums;">20000</span></div>
      <div data-th-speed-group style="display:flex;gap:2px;margin-top:auto;">
        <button data-th-speed="0" title="Pause" style="background:transparent;border:1px solid #000;border-radius:2px;padding:1px;cursor:pointer;line-height:0;"><img src="${UI_BASE}/Buttons/pause.bmp" alt="Pause" style="display:block;height:14px;image-rendering:pixelated;"/></button>
        <button data-th-speed="1" title="Normal" style="background:transparent;border:1px solid #000;border-radius:2px;padding:1px;cursor:pointer;line-height:0;"><img src="${UI_BASE}/Buttons/Speed1.bmp" alt="1×" style="display:block;height:14px;image-rendering:pixelated;"/></button>
        <button data-th-speed="2" title="Fast" style="background:transparent;border:1px solid #000;border-radius:2px;padding:1px;cursor:pointer;line-height:0;"><img src="${UI_BASE}/Buttons/Speed2.bmp" alt="2×" style="display:block;height:14px;image-rendering:pixelated;"/></button>
        <button data-th-speed="3" title="Ultra" style="background:transparent;border:1px solid #000;border-radius:2px;padding:1px;cursor:pointer;line-height:0;"><img src="${UI_BASE}/Buttons/Speed3.bmp" alt="3×" style="display:block;height:14px;image-rendering:pixelated;"/></button>
      </div>
    `
    : `
      <span style="display:flex;gap:3px;align-items:center;" data-th-speed-group>
        <button data-th-speed="0" title="Pause (space)" style="background:transparent;border:1px solid #345;color:#cde;border-radius:3px;padding:2px 7px;cursor:pointer;font:inherit;">⏸</button>
        <button data-th-speed="1" title="Normal speed (1)" style="background:transparent;border:1px solid #345;color:#cde;border-radius:3px;padding:2px 7px;cursor:pointer;font:inherit;">1×</button>
        <button data-th-speed="2" title="Fast (2)" style="background:transparent;border:1px solid #345;color:#cde;border-radius:3px;padding:2px 7px;cursor:pointer;font:inherit;">2×</button>
        <button data-th-speed="3" title="Ultra (3)" style="background:transparent;border:1px solid #345;color:#cde;border-radius:3px;padding:2px 7px;cursor:pointer;font:inherit;">3×</button>
      </span>
      <span style="opacity:.4;">·</span>
      <span><span data-th-day style="color:#9ad;">Mon</span> <span data-th-time>08:00</span></span>
      <span style="opacity:.4;">·</span>
      <span><span style="color:#cfa;">§</span><span data-th-funds style="font-variant-numeric:tabular-nums;">20000</span></span>
    `;
  // Refresh speed tooltips to the FR strings once the i18n bundle lands.
  if (inPanel) {
    for (const [k, idx] of Object.entries(SPEED_TOOLTIPS_VCTL_IDX)) {
      const btn = el.querySelector<HTMLButtonElement>(`button[data-th-speed="${k}"]`);
      if (btn) btn.title = tStr("UIText", 138, idx, btn.title);
    }
  }
  el.querySelector("[data-th-speed-group]")?.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLButtonElement)) return;
    const raw = t.dataset["thSpeed"];
    if (raw === undefined) return;
    const s = parseInt(raw, 10);
    if (s === 0 || s === 1 || s === 2 || s === 3) setGameSpeed(s);
  });
  if (slot) slot.appendChild(el);
  else document.body.appendChild(el);
  timeHudEl = el;
  return el;
}

function renderTimeFundsHud(): void {
  const root = ensureTimeFundsHud();
  const locale = getLocale();
  const daysTable = DAYS_BY_LOCALE[locale] ?? DAYS;
  const day = daysTable[gameDayIdx % daysTable.length] ?? "?";
  const hh = Math.floor(gameMinutes / 60).toString().padStart(2, "0");
  const mm = Math.floor(gameMinutes % 60).toString().padStart(2, "0");
  const dEl = root.querySelector<HTMLSpanElement>("span[data-th-day]");
  const tEl = root.querySelector<HTMLSpanElement>("span[data-th-time]");
  const fEl = root.querySelector<HTMLSpanElement>("span[data-th-funds]");
  if (dEl) dEl.textContent = day;
  if (tEl) tEl.textContent = `${hh}:${mm}`;
  if (fEl) fEl.textContent = funds.toLocaleString(locale === 3 ? "fr-FR" : "en-US");
  // Highlight the active speed button — the BMPs already have their own
  // active/inactive states baked in, but a coloured ring around the active
  // button still helps it pop on the dark panel.
  for (const btn of root.querySelectorAll<HTMLButtonElement>("button[data-th-speed]")) {
    const active = parseInt(btn.dataset["thSpeed"] ?? "1", 10) === gameSpeed;
    btn.style.borderColor = active ? "#ffdf80" : "#000";
    btn.style.background = active ? "rgba(255,223,128,0.20)" : "transparent";
  }
}

function togglePause(): void {
  setGameSpeed(gameSpeed === 0 ? 1 : 0);
}

function startGameClock(): void {
  setInterval(() => {
    if (document.hidden || gameSpeed === 0) return; // pause when the tab is in the background
    gameMinutes += TIME_SCALE * gameSpeed;
    if (gameMinutes >= 24 * 60) {
      gameMinutes -= 24 * 60;
      gameDayIdx += 1;
    }
    renderTimeFundsHud();
    // Sky tint depends on gameMinutes — keep it in sync without recomposing
    // sprites (which would re-decode every instance for nothing).
    lotScene.timeMinutes = gameMinutes;
    renderLot();
  }, 1000);
}

function adjustFunds(delta: number): void {
  funds = Math.max(0, funds + delta);
  renderTimeFundsHud();
}

/** "Play" lets clicks walk the Sim and trigger interactions; "Build" lets the
 *  user place new objects on empty tiles. Build is the legacy default for the
 *  dev viewer; Play is the new game-feel default. */
type LotMode = "play" | "buy" | "build";
let lotMode: LotMode = "play";

/** Build-mode tool ("place" lives in Buy mode now; the others stay in Build). */
type BuildTool =
  | "place"
  | "paint"
  | "paint-rect"
  | "wall"
  | "wall-line"
  | "wall-rect"
  | "door"
  | "window";
let buildTool: BuildTool = "wall";

/** Tools allowed in each mode. Used by the click-handler to gate behaviour. */
const BUILD_TOOLS_FOR_BUILD: ReadonlySet<BuildTool> = new Set([
  "paint",
  "paint-rect",
  "wall",
  "wall-line",
  "wall-rect",
  "door",
  "window",
]);
const BUILD_TOOLS_FOR_BUY: ReadonlySet<BuildTool> = new Set(["place"]);

function defaultToolForMode(m: LotMode): BuildTool {
  if (m === "buy") return "place";
  if (m === "build") return "wall";
  return buildTool; // play mode keeps whatever was last selected, doesn't use it
}

/** Walls live on tile *edges*. North / west edge sets are keyed by
 *  `y * (gridSize + 1) + x` — same convention the renderer expects. */
const wallsN: Set<number> = new Set();
const wallsW: Set<number> = new Set();
/** Doors share the wall key scheme; a door at edge K is passable to A* even
 *  if a wall is also present at K, and the renderer draws a doorframe. */
const doorsN: Set<number> = new Set();
const doorsW: Set<number> = new Set();
/** Windows share the wall key scheme. A window at K does NOT make the edge
 *  passable (still blocks A*), but renders as a wall with a glass cutout. */
const windowsN: Set<number> = new Set();
const windowsW: Set<number> = new Set();

const FLOOR_PAINT_PRESETS = [
  { id: "grass", color: "#3b6e3b", label: "grass" },
  { id: "tile", color: "#cfd8dc", label: "tile" },
  { id: "wood", color: "#8d6c4f", label: "wood" },
  { id: "water", color: "#3a78c2", label: "water" },
] as const;
let activePaintId: (typeof FLOOR_PAINT_PRESETS)[number]["id"] = "tile";

/** Initialise the floor-paint map only once; reused across scene composes. */
const floorPaint: Map<number, string> = new Map();

/** Wall edge keys are `y * (N + 1) + x`. The wall *between* two adjacent tiles
 *  can be either side's edge depending on direction. This helper tests whether
 *  a 4-neighbour move from (x1, y1) to (x2, y2) crosses a wall in either set. */
function wallBetween(x1: number, y1: number, x2: number, y2: number): boolean {
  const N = lotScene.gridSize;
  let key = -1;
  let nSet = false;
  if (x1 === x2 && y2 === y1 - 1) { key = y1 * (N + 1) + x1; nSet = true; }
  else if (x1 === x2 && y2 === y1 + 1) { key = y2 * (N + 1) + x1; nSet = true; }
  else if (y1 === y2 && x2 === x1 - 1) { key = y1 * (N + 1) + x1; nSet = false; }
  else if (y1 === y2 && x2 === x1 + 1) { key = y1 * (N + 1) + x2; nSet = false; }
  else return false;
  // Doors override walls — even if a wall is present, a door at the same edge
  // makes the move legal.
  if (nSet) return wallsN.has(key) && !doorsN.has(key);
  return wallsW.has(key) && !doorsW.has(key);
}

/** Snap a fractional tile-space cursor to the nearest tile edge. Returns the
 *  edge identity in the canonical (orientation, x, y) form used by `wallsN` /
 *  `wallsW` (where the wall belongs to the *south/east* tile of the pair). */
function nearestEdge(
  fx: number,
  fy: number,
): { orientation: "n" | "w"; x: number; y: number } | null {
  const N = lotScene.gridSize;
  const tx = Math.round(fx);
  const ty = Math.round(fy);
  if (tx < 0 || ty < 0 || tx >= N || ty >= N) return null;
  const dx = fx - tx;
  const dy = fy - ty;
  // Pick the dominant axis. If horizontal offset is bigger, snap to a vertical
  // edge (west/east); otherwise snap to a horizontal edge (north/south). The
  // "south/east" pair-mate is folded into the canonical (n, x, y+1) /
  // (w, x+1, y) so we never need a third sign bit at storage time.
  if (Math.abs(dx) > Math.abs(dy)) {
    if (dx >= 0) return { orientation: "w", x: tx + 1, y: ty };
    return { orientation: "w", x: tx, y: ty };
  } else {
    if (dy >= 0) return { orientation: "n", x: tx, y: ty + 1 };
    return { orientation: "n", x: tx, y: ty };
  }
}

/** A* on the 16x16 grid, routing around placed instances. Returns a list of
 *  tile coordinates from the start tile to the goal (inclusive of both).
 *  Returns null if unreachable; falls back to a straight line if start==goal. */
function findPath(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): Array<{ x: number; y: number }> | null {
  const N = lotScene.gridSize;
  if (toX < 0 || toY < 0 || toX >= N || toY >= N) return null;
  if (fromX === toX && fromY === toY) return [{ x: toX, y: toY }];
  const blocked = new Set<number>();
  for (const inst of lotInstances) {
    for (const cell of inst.obj.footprint) {
      const tx = inst.worldX + cell.x;
      const ty = inst.worldY + cell.y;
      // Don't block the goal tile (the user clicked an object => stand there)
      // nor the start tile (Sim starts on it).
      if (tx === toX && ty === toY) continue;
      if (tx === fromX && ty === fromY) continue;
      if (tx < 0 || ty < 0 || tx >= N || ty >= N) continue;
      blocked.add(ty * N + tx);
    }
  }
  const heuristic = (x: number, y: number): number =>
    Math.abs(x - toX) + Math.abs(y - toY);
  const startKey = fromY * N + fromX;
  const open = new Map<number, { g: number; f: number; x: number; y: number }>();
  open.set(startKey, { g: 0, f: heuristic(fromX, fromY), x: fromX, y: fromY });
  const came: Map<number, number> = new Map();
  const closed = new Set<number>();
  while (open.size > 0) {
    let bestKey = -1;
    let best: { g: number; f: number; x: number; y: number } | null = null;
    for (const [k, v] of open) {
      if (best === null || v.f < best.f) {
        best = v;
        bestKey = k;
      }
    }
    if (best === null) break;
    open.delete(bestKey);
    closed.add(bestKey);
    if (best.x === toX && best.y === toY) {
      const path: Array<{ x: number; y: number }> = [];
      let curK = bestKey;
      let curX = best.x;
      let curY = best.y;
      path.push({ x: curX, y: curY });
      while (came.has(curK)) {
        const prev = came.get(curK)!;
        curX = prev % N;
        curY = Math.floor(prev / N);
        path.push({ x: curX, y: curY });
        curK = prev;
      }
      path.reverse();
      return path;
    }
    const neighbours: Array<[number, number]> = [
      [best.x - 1, best.y],
      [best.x + 1, best.y],
      [best.x, best.y - 1],
      [best.x, best.y + 1],
    ];
    for (const [nx, ny] of neighbours) {
      if (nx === undefined || ny === undefined) continue;
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
      const nk = ny * N + nx;
      if (closed.has(nk)) continue;
      if (blocked.has(nk)) continue;
      if (wallBetween(best.x, best.y, nx, ny)) continue;
      const tentativeG = best.g + 1;
      const existing = open.get(nk);
      if (existing && existing.g <= tentativeG) continue;
      came.set(nk, bestKey);
      open.set(nk, { g: tentativeG, f: tentativeG + heuristic(nx, ny), x: nx, y: ny });
    }
  }
  return null;
}

function startWalkForSim(
  sim: SimState,
  toX: number,
  toY: number,
  onArrive: (() => void) | null = null,
): void {
  const startX = Math.round(sim.fx);
  const startY = Math.round(sim.fy);
  const path = findPath(startX, startY, toX, toY);
  if (!path || path.length === 0) {
    // Unreachable — don't teleport through walls. Surface a "can't reach"
    // bubble on the targeted Sim instead. Skip if start == goal already.
    if (startX !== toX || startY !== toY) {
      sim.bubble = { text: "🚫 can't reach", expiresAtMs: performance.now() + 1500 };
      ensureRenderLoop();
    } else {
      onArrive?.();
    }
    return;
  }
  let i = path[0]!.x === startX && path[0]!.y === startY ? 1 : 0;
  const next = (): void => {
    if (i >= path.length) {
      onArrive?.();
      return;
    }
    const node = path[i++]!;
    walkSegmentForSim(sim, node.x, node.y, next);
  };
  next();
}

function walkSegmentForSim(
  sim: SimState,
  toX: number,
  toY: number,
  onArrive: (() => void) | null,
): void {
  const dist = Math.hypot(toX - sim.fx, toY - sim.fy);
  // Walk speed scales with game speed so 2×/3× make Sims visibly faster.
  // At paused state (gameSpeed=0) we keep durMs as-is — the render loop will
  // freeze it anyway via the lastIdleRender gate.
  const speedMult = gameSpeed === 0 ? 1 : gameSpeed;
  const durMs = Math.max(140, Math.min(700, dist * 280)) / speedMult;
  sim.walk = {
    fromX: sim.fx,
    fromY: sim.fy,
    toX,
    toY,
    startMs: performance.now(),
    durMs,
  };
  // Snap facing to whichever cardinal axis dominates this segment. Stays put
  // if the move is degenerate (zero-length walk arrives instantly).
  const dx = toX - sim.fx;
  const dy = toY - sim.fy;
  if (Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6) {
    if (Math.abs(dx) >= Math.abs(dy)) sim.facing = dx >= 0 ? 0 : 2;
    else sim.facing = dy >= 0 ? 3 : 1;
  }
  sim.onArrive = onArrive;
  ensureRenderLoop();
}

/** Backwards-compatible shims targeting the currently-selected Sim. */
function startWalk(toX: number, toY: number, onArrive: (() => void) | null = null): void {
  const sim = sims[selectedSimIdx];
  if (!sim) return;
  startWalkForSim(sim, toX, toY, onArrive);
}

/** Look across every placed instance for an interaction whose TTAB row bumps
 *  the requested motive index by a positive avg of effectMin/effectMax. The
 *  best (largest delta) match wins. Returns null if no instance helps. */
interface AutonomyTarget {
  inst: LotInstance;
  row: InteractionMenuRow;
  bestDelta: number;
}
function findBestInteractionForMotive(motiveIdx: number): AutonomyTarget | null {
  if (!viewerState.wasm) return null;
  let best: AutonomyTarget | null = null;
  for (const inst of lotInstances) {
    let rows: InteractionMenuRow[];
    try {
      rows = buildInteractionRows(viewerState.wasm, inst);
    } catch {
      continue;
    }
    for (const row of rows) {
      const m = row.ttabMotives;
      if (!m) continue;
      const slot = m[motiveIdx];
      if (!slot) continue;
      const avg = (slot.effectMin + slot.effectMax) / 2;
      if (avg <= 0) continue;
      if (!best || avg > best.bestDelta) best = { inst, row, bestDelta: avg };
    }
  }
  return best;
}

/** Walk a Sim to an instance and run the chosen interaction on arrival. The
 *  motive bump uses the *target* Sim, not the selected one, so auto-walking
 *  Sims actually feed themselves. Audio + bubbles are skipped to avoid
 *  cluttering the UI when several Sims act simultaneously. */
function runAutonomousInteraction(sim: SimState, target: AutonomyTarget): void {
  if (target.row.ttabMotives) {
    applyMotiveEffects(target.row.ttabMotives, sim);
  }
}

/** Map sim.id → last greet timestamp, used to cool down social interactions
 *  so two idle Sims don't trade +22 bumps every 2.5 s autonomy tick. */
const lastGreetByIdMs = new Map<number, number>();
const GREET_COOLDOWN_MS = 25_000;

/** Find a Sim-Sim "Greet" target: another non-sleeping Sim within reach that
 *  also has low-ish Social and isn't on cooldown with us. Returns null if
 *  nobody qualifies. */
function findSocialPartner(self: SimState): SimState | null {
  const now = performance.now();
  const selfLast = lastGreetByIdMs.get(self.id) ?? 0;
  if (now - selfLast < GREET_COOLDOWN_MS) return null;
  let best: SimState | null = null;
  let bestScore = Infinity; // lower social = better candidate
  for (const other of sims) {
    if (other === self) continue;
    if (other.sleeping || other.walk) continue;
    const otherLast = lastGreetByIdMs.get(other.id) ?? 0;
    if (now - otherLast < GREET_COOLDOWN_MS) continue;
    const dist = Math.hypot(other.fx - self.fx, other.fy - self.fy);
    if (dist > 10) continue;
    const otherSocial = other.motives[MOTIVE_SOCIAL_IDX] ?? 0;
    if (otherSocial < bestScore) {
      bestScore = otherSocial;
      best = other;
    }
  }
  return best;
}

/** Drop a Social bump on both Sims when they meet up. Emits matching bubbles
 *  so the user sees the interaction and records a cooldown so they don't loop. */
function runSocialGreeting(initiator: SimState, partner: SimState): void {
  const bump = 22;
  initiator.motives[MOTIVE_SOCIAL_IDX] = clampMotive(
    (initiator.motives[MOTIVE_SOCIAL_IDX] ?? 0) + bump,
  );
  partner.motives[MOTIVE_SOCIAL_IDX] = clampMotive(
    (partner.motives[MOTIVE_SOCIAL_IDX] ?? 0) + bump,
  );
  // Show a chat bubble on both so the social interaction is visible.
  const now = performance.now();
  initiator.bubble = { text: `💬 hi ${partner.name}!`, expiresAtMs: now + 1500 };
  partner.bubble = { text: `💬 hi ${initiator.name}!`, expiresAtMs: now + 1500 };
  lastGreetByIdMs.set(initiator.id, now);
  lastGreetByIdMs.set(partner.id, now);
  renderMotivesHud();
  ensureRenderLoop();
}

/** Pick a random reachable tile within `radius` of `sim` and walk it there.
 *  Used by the auto-wander loop so non-selected Sims aren't statues. */
function autoWanderSim(sim: SimState): void {
  if (sim.walk) return; // already moving
  if (sim.sleeping) return; // napping; tickMotives handles wake-up
  // Social need: if low and another Sim is around, walk to them and greet on
  // arrival. Cheaper than searching every TTAB and gives multi-Sim lots life.
  const socialVal = sim.motives[MOTIVE_SOCIAL_IDX] ?? 0;
  if (socialVal < -20) {
    const partner = findSocialPartner(sim);
    if (partner) {
      const targetX = Math.round(partner.fx);
      const targetY = Math.round(partner.fy);
      // Stop one tile short so we don't overlap.
      const dest = adjacentTileFor(targetX, targetY);
      const path = findPath(Math.round(sim.fx), Math.round(sim.fy), dest.x, dest.y);
      if (path && path.length > 0) {
        startWalkForSim(sim, dest.x, dest.y, () => runSocialGreeting(sim, partner));
        return;
      }
    }
  }
  // Need-driven: any motive < -40 → walk to the best instance that boosts it
  // and run that interaction on arrival.
  for (let i = 0; i < sim.motives.length; i += 1) {
    const v = sim.motives[i] ?? 0;
    if (v >= -40) continue;
    const target = findBestInteractionForMotive(i);
    if (!target) continue;
    const dest = adjacentTileFor(target.inst.worldX, target.inst.worldY);
    const path = findPath(Math.round(sim.fx), Math.round(sim.fy), dest.x, dest.y);
    if (!path || path.length === 0) continue;
    startWalkForSim(sim, dest.x, dest.y, () => runAutonomousInteraction(sim, target));
    return;
  }
  // Energy critically low + no bed reachable → nap on floor right where we
  // are. tickMotives will tick energy back up and clear `sleeping` automatically.
  const energy = sim.motives[MOTIVE_ENERGY_IDX] ?? 0;
  if (energy < -60) {
    sim.sleeping = true;
    sim.bubble = { text: "💤 sleeping…", expiresAtMs: performance.now() + 60000 };
    return;
  }
  // Hunger critical with no fridge target → flash a thought-bubble so the user
  // knows the Sim is starving. Doesn't change behaviour beyond random wander.
  const hunger = sim.motives[0] ?? 0;
  if (hunger < -60 && (!sim.bubble || sim.bubble.expiresAtMs < performance.now())) {
    sim.bubble = { text: "🍽 hungry…", expiresAtMs: performance.now() + 1500 };
  }
  const N = lotScene.gridSize;
  const startX = Math.round(sim.fx);
  const startY = Math.round(sim.fy);
  const radius = 4;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const dx = Math.floor(Math.random() * (radius * 2 + 1)) - radius;
    const dy = Math.floor(Math.random() * (radius * 2 + 1)) - radius;
    const tx = startX + dx;
    const ty = startY + dy;
    if (tx === startX && ty === startY) continue;
    if (tx < 0 || ty < 0 || tx >= N || ty >= N) continue;
    if (lotInstances.some((i) => i.worldX === tx && i.worldY === ty)) continue;
    const path = findPath(startX, startY, tx, ty);
    if (path && path.length > 1) {
      startWalkForSim(sim, tx, ty);
      return;
    }
  }
}

function startAutoWanderLoop(): void {
  setInterval(() => {
    if (gameSpeed === 0) return;
    for (let i = 0; i < sims.length; i += 1) {
      if (i === selectedSimIdx) continue;
      const sim = sims[i];
      if (!sim) continue;
      // ~50% chance per tick to wander, so they don't all march in lockstep.
      // Scales with gameSpeed so 3× makes Sims act ~3× more often.
      if (Math.random() < 0.5 * gameSpeed) autoWanderSim(sim);
    }
  }, 2500);
}

let renderLoopHandle: number | null = null;
let lastIdleRender = 0;
function ensureRenderLoop(): void {
  if (renderLoopHandle !== null) return;
  const tick = (now: number): void => {
    let walkAlive = false;
    // Advance every Sim's walk independently so multi-Sim lots all animate.
    for (const sim of sims) {
      if (!sim.walk) continue;
      const w = sim.walk;
      const t = Math.min(1, (now - w.startMs) / w.durMs);
      const eased = t * t * (3 - 2 * t);
      sim.fx = w.fromX + (w.toX - w.fromX) * eased;
      sim.fy = w.fromY + (w.toY - w.fromY) * eased;
      if (t >= 1) {
        sim.walk = null;
        const cb = sim.onArrive;
        sim.onArrive = null;
        cb?.();
      } else {
        walkAlive = true;
      }
    }
    if (walkAlive) {
      composeLotScene();
      lastIdleRender = now;
    } else if (now - lastIdleRender > 100) {
      // Idle frame — drive breath animation at ~10 fps so the loop is cheap.
      composeLotScene();
      lastIdleRender = now;
    }
    // Loop forever as long as there's at least one Sim, so idle breath keeps
    // animating. Pauses when the tab is hidden (rAF naturally throttles).
    renderLoopHandle = requestAnimationFrame(tick);
  };
  renderLoopHandle = requestAnimationFrame(tick);
}

function allSimEntities(): IsoEntity[] {
  const out: IsoEntity[] = [];
  const now = performance.now();
  for (let i = 0; i < sims.length; i += 1) {
    const sim = sims[i]!;
    const isSelected = i === selectedSimIdx;
    const label =
      sim.bubble && sim.bubble.expiresAtMs > now
        ? sim.bubble.text
        : sim.name;
    // Walk bob — sinusoid on segment progress, ~2 steps per tile (2 full
    // cycles of "down-up-down" per tile of travel). Negative = up on screen.
    // Idle breath — slow ~3 s sin wave with a per-Sim phase offset so a row of
    // Sims doesn't breathe in lockstep. Tiny amplitude (1px) so it reads as
    // "alive" instead of "rocking".
    let bob = 0;
    if (sim.walk) {
      const t = Math.min(1, (now - sim.walk.startMs) / sim.walk.durMs);
      const dist = Math.hypot(sim.walk.toX - sim.walk.fromX, sim.walk.toY - sim.walk.fromY);
      const cycles = Math.max(1, dist * 2);
      bob = -Math.abs(Math.sin(t * Math.PI * cycles)) * 3;
    } else {
      const phase = i * 0.7;
      bob = Math.sin((now / 1000) * (2 * Math.PI / 3) + phase) * 1;
    }
    out.push({
      worldX: sim.fx,
      worldY: sim.fy,
      kind: "sim",
      color: sim.bodyColor || simColorOf(i),
      // Mark selected with a small chevron prefix so the user always knows
      // which Sim a click controls.
      label: isSelected ? `▸ ${label}` : label,
      facing: sim.facing,
      verticalOffset: bob,
    });
  }
  return out;
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

/** Wall visibility cycle: full → low (peek inside) → off. A* pathing always
 *  obeys the actual wall sets regardless of this display mode. */
const WALL_MODES = ["full", "low", "off"] as const;
let wallModeIdx = 0;
function cycleWallMode(): void {
  wallModeIdx = (wallModeIdx + 1) % WALL_MODES.length;
  lotScene.wallMode = WALL_MODES[wallModeIdx] ?? "full";
  renderLot();
  updateCameraButtonHighlights();
}

// Opt-in WebGL2 renderer via `?webgl` URL flag. The WebGL2 path now owns the
// sky, floor, and batched sprite atlas (per-pixel `gl_FragDepth` Z-buffer).
// Walls / entities / hover / ghosts continue to render on the 2D overlay
// above this layer.
const WEBGL_ENABLED = new URLSearchParams(globalThis.location?.search ?? "").has("webgl");
let webglCanvas: HTMLCanvasElement | null = null;
let webglRenderer: ((c: HTMLCanvasElement, s: typeof lotScene) => void) | null = null;
if (WEBGL_ENABLED) {
  webglCanvas = document.createElement("canvas");
  webglCanvas.id = "lot-canvas-webgl";
  webglCanvas.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:0";
  webglCanvas.width = canvas.width;
  webglCanvas.height = canvas.height;
  canvas.parentElement?.insertBefore(webglCanvas, canvas);
  // Make the foreground canvas transparent over the WebGL one.
  canvas.style.background = "transparent";
  void import("./renderer/iso_webgl.js").then((mod) => {
    webglRenderer = mod.renderIsoWebGL;
    renderLot();
    console.info("[render] WebGL2 renderer enabled — floor + sprites with per-pixel Z-buffer on GPU; walls/entities on 2D overlay");
  }).catch((err) => {
    console.warn("[render] WebGL2 init failed; staying on Canvas2D:", err);
  });
}

function renderLot(): void {
  let webglOk = false;
  if (webglCanvas && webglRenderer) {
    if (webglCanvas.width !== canvas.width || webglCanvas.height !== canvas.height) {
      webglCanvas.width = canvas.width;
      webglCanvas.height = canvas.height;
    }
    try {
      webglRenderer(webglCanvas, lotScene);
      webglOk = true;
    } catch (err) {
      console.warn("[render] WebGL2 frame failed, switching back to Canvas2D:", err);
      webglRenderer = null;
    }
  }
  // When the WebGL2 path drew floor + sprites, tell the 2D path to skip them
  // and clear to transparent so the WebGL canvas behind shows through. Walls /
  // entities / hover / ghosts always render on the 2D overlay.
  renderIso(canvas, lotScene, webglOk ? { skipSkyAndFloor: true, skipSprites: true } : {});
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

/** Pan keeps the world in view by clamping center to a generous overshoot
 *  band — enough to peek at corners during rotation but not so much the lot
 *  scrolls completely off-screen. */
function panCamera(dx: number, dy: number): void {
  const cam = lotScene.camera;
  const N = lotScene.gridSize;
  const limit = N; // half-lot of slack on each side
  cam.centerX = Math.max(-limit / 2, Math.min(N + limit / 2, cam.centerX + dx));
  cam.centerY = Math.max(-limit / 2, Math.min(N + limit / 2, cam.centerY + dy));
  renderLot();
}

function recenterCamera(): void {
  const N = lotScene.gridSize;
  lotScene.camera.centerX = N / 2;
  lotScene.camera.centerY = N / 2;
  renderLot();
}

let minimapCanvas: HTMLCanvasElement | null = null;
const MINIMAP_SIZE = 128;
function mountMinimap(): void {
  const existing = document.getElementById("minimap");
  existing?.remove();
  const wrap = document.createElement("div");
  wrap.id = "minimap";
  wrap.style.cssText =
    "position:fixed;top:200px;right:8px;background:linear-gradient(180deg,#1a2840 0%,#0f1a2d 100%);border:1px solid #3a4a66;box-shadow:0 2px 8px rgba(0,0,0,.4);padding:6px;border-radius:6px;display:flex;flex-direction:column;gap:4px;align-items:center;font:10px/1.2 ui-monospace,monospace;color:#9ad;";
  wrap.innerHTML = `<canvas id="minimap-canvas" width="${MINIMAP_SIZE}" height="${MINIMAP_SIZE}" style="image-rendering:pixelated;cursor:crosshair;border:1px solid #345;"></canvas><span style="opacity:.7;">click to pan</span>`;
  document.body.appendChild(wrap);
  const c = wrap.querySelector<HTMLCanvasElement>("#minimap-canvas");
  if (!c) return;
  minimapCanvas = c;
  c.addEventListener("click", (ev) => {
    const rect = c.getBoundingClientRect();
    const N = lotScene.gridSize;
    const cellPx = MINIMAP_SIZE / N;
    const tx = (ev.clientX - rect.left) / cellPx;
    const ty = (ev.clientY - rect.top) / cellPx;
    lotScene.camera.centerX = Math.max(0, Math.min(N, tx));
    lotScene.camera.centerY = Math.max(0, Math.min(N, ty));
    renderLot();
    drawMinimap();
  });
}

function drawMinimap(): void {
  if (!minimapCanvas) return;
  const ctx = minimapCanvas.getContext("2d");
  if (!ctx) return;
  const N = lotScene.gridSize;
  const cell = MINIMAP_SIZE / N;
  // Dark background.
  ctx.fillStyle = "#0a1422";
  ctx.fillRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);
  // Floor checker (mute).
  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) {
      const painted = floorPaint.get(y * N + x);
      if (painted) {
        ctx.fillStyle = painted;
        ctx.fillRect(x * cell, y * cell, cell, cell);
      } else if ((x + y) % 2 === 0) {
        ctx.fillStyle = "#1a2a18";
        ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }
  }
  // Walls — north & west edges as dark lines.
  ctx.strokeStyle = "#5a3e2c";
  ctx.lineWidth = 1.5;
  for (const k of wallsN) {
    const x = k % (N + 1);
    const y = Math.floor(k / (N + 1));
    ctx.beginPath();
    ctx.moveTo(x * cell, y * cell);
    ctx.lineTo((x + 1) * cell, y * cell);
    ctx.stroke();
  }
  for (const k of wallsW) {
    const x = k % (N + 1);
    const y = Math.floor(k / (N + 1));
    ctx.beginPath();
    ctx.moveTo(x * cell, y * cell);
    ctx.lineTo(x * cell, (y + 1) * cell);
    ctx.stroke();
  }
  // Doors — same edges in green.
  ctx.strokeStyle = "#5dbc4d";
  ctx.lineWidth = 2;
  for (const k of doorsN) {
    const x = k % (N + 1);
    const y = Math.floor(k / (N + 1));
    ctx.beginPath();
    ctx.moveTo(x * cell + cell * 0.25, y * cell);
    ctx.lineTo(x * cell + cell * 0.75, y * cell);
    ctx.stroke();
  }
  for (const k of doorsW) {
    const x = k % (N + 1);
    const y = Math.floor(k / (N + 1));
    ctx.beginPath();
    ctx.moveTo(x * cell, y * cell + cell * 0.25);
    ctx.lineTo(x * cell, y * cell + cell * 0.75);
    ctx.stroke();
  }
  // Placed objects as small white squares.
  ctx.fillStyle = "#cdd";
  for (const inst of lotInstances) {
    ctx.fillRect(inst.worldX * cell + 1, inst.worldY * cell + 1, cell - 2, cell - 2);
  }
  // Sims as palette-coloured dots, selected one bigger.
  for (let i = 0; i < sims.length; i += 1) {
    const sim = sims[i]!;
    const cx = sim.fx * cell + cell / 2;
    const cy = sim.fy * cell + cell / 2;
    const r = i === selectedSimIdx ? Math.max(2.5, cell * 0.5) : Math.max(1.5, cell * 0.35);
    ctx.fillStyle = simColorOf(i);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  // Camera viewport rectangle (approximate — just a marker at the rotated
  // centre, since the iso projection doesn't map cleanly to a rect).
  const cam = lotScene.camera;
  ctx.strokeStyle = "rgba(255,255,255,.8)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cam.centerX * cell, cam.centerY * cell, 4, 0, Math.PI * 2);
  ctx.stroke();
}

// ============================================================================
// TS1 Control Panel — the iconic full-width bar that hosts every gameplay HUD.
// 5 slots: Family · Motives · Center (mode catalog) · Time/Funds · Mode Tabs.
// Built once at boot; renderers attach into the slots via getSlotBody().
// ============================================================================

function mountTs1Panel(): void {
  // Real layout lives in client/src/ui/cpanel.ts — uses authentic Maxis BMPs
  // (PanelBack, LiveGadget, mode patches) instead of fabricated chrome.
  mountCpanel();
}

function getSlotBody(name: "family" | "motives" | "center" | "time" | "tabs"): HTMLDivElement | null {
  return document.querySelector<HTMLDivElement>(`#ts1-panel [data-slot-body="${name}"]`);
}

// ----------------------------------------------------------------------------
// Camera mini-bar — small floating row at the top-right of the viewport with
// rotation / zoom / walls toggles. The mode tabs and build tools used to live
// here too; both moved into the TS1 panel.
// ----------------------------------------------------------------------------

function mountCameraMiniBar(): void {
  const existing = document.getElementById("camera-controls");
  existing?.remove();
  const bar = document.createElement("div");
  bar.id = "camera-controls";
  bar.style.cssText =
    "position:fixed;top:8px;right:8px;display:flex;gap:4px;align-items:center;" +
    "background:linear-gradient(180deg,#1a2840 0%,#0f1a2d 100%);" +
    "border:1px solid #3a4a66;box-shadow:0 2px 8px rgba(0,0,0,.4);" +
    "padding:4px 6px;border-radius:4px;font:11px/1.3 ui-monospace,monospace;color:#9ad;z-index:70;";
  bar.innerHTML = `
    <button data-cam="rot-l" title="Rotate left (Q)" style="background:rgba(255,255,255,.05);border:1px solid #345;color:#cde;padding:2px 6px;cursor:pointer;border-radius:3px;font:inherit;">⟲</button>
    <button data-cam="rot-r" title="Rotate right (E)" style="background:rgba(255,255,255,.05);border:1px solid #345;color:#cde;padding:2px 6px;cursor:pointer;border-radius:3px;font:inherit;">⟳</button>
    <span style="opacity:.4;">·</span>
    <button data-cam-zoom="0" title="Far">−</button>
    <button data-cam-zoom="1" title="Medium">=</button>
    <button data-cam-zoom="2" title="Near">+</button>
    <span style="opacity:.4;">·</span>
    <button data-cam-action="walls" title="Cycle wall visibility (full / low / off)">walls</button>
  `;
  for (const b of bar.querySelectorAll<HTMLButtonElement>("button")) {
    if (!b.style.cssText) {
      b.style.cssText = "background:rgba(255,255,255,.05);border:1px solid #345;color:#cde;padding:2px 6px;cursor:pointer;border-radius:3px;font:inherit;";
    }
  }
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
    if (action === "walls") cycleWallMode();
  });
}

// ----------------------------------------------------------------------------
// Center slot — rebuilt every time the mode changes. Holds the catalog (Buy),
// the tool palette (Build), or the interaction queue / skills tabs (Live).
// ----------------------------------------------------------------------------

function renderTs1CenterSlot(): void {
  const slot = getSlotBody("center");
  if (!slot) return;
  slot.innerHTML = "";
  const title = document.querySelector<HTMLDivElement>("#ts1-slot-center [data-center-title]");
  if (title) title.textContent = lotMode === "buy" ? "Buy" : lotMode === "build" ? "Build" : "Live";
  if (lotMode === "play") {
    mountLiveCenter(slot);
  } else if (lotMode === "buy") {
    mountBuyCenter(slot);
  } else {
    mountBuildCenter(slot);
  }
  updateBuildToolHighlights();
}

// ----------------------------------------------------------------------------
// Buy mode TS1 category strip — the 8 base-game catalog categories. Only
// "all" (no filter) is wired today; the per-category filter needs FUNCTION GUID
// extraction from each object's OBJD chunk (Phase 4 territory). The disabled
// buttons keep the visual reference to TS1 without faking behaviour.
// ----------------------------------------------------------------------------

// Real TS1 catalog icons extracted from UIGraphics.far (cpanel/Catalog/Buy*).
// Two flavours: Function (BuyF*) groups objects by what they do, Room (BuyR*)
// groups them by where they live. The user toggles between the two with the
// Function/Room buttons; only Function is the default in the original game.
const UI_BMP_BASE = "/assets/converted/ui/cpanel";
const TS1_BUY_CATEGORIES_F = [
  { id: "all", label: "Toutes", bmp: null, enabled: true },
  { id: "seating", label: "Sièges", bmp: `${UI_BMP_BASE}/Catalog/BuyFSeating.BMP`, enabled: false },
  { id: "surfaces", label: "Surfaces", bmp: `${UI_BMP_BASE}/Catalog/BuyFSurfaces.bmp`, enabled: false },
  { id: "decor", label: "Décoration", bmp: `${UI_BMP_BASE}/Catalog/BuyFDecorative.bmp`, enabled: false },
  { id: "electronics", label: "Électronique", bmp: `${UI_BMP_BASE}/Catalog/BuyFElectronics.bmp`, enabled: false },
  { id: "appliances", label: "Électroménager", bmp: `${UI_BMP_BASE}/Catalog/BuyFAppliances.bmp`, enabled: false },
  { id: "plumbing", label: "Plomberie", bmp: `${UI_BMP_BASE}/Catalog/BuyFPlumbing.bmp`, enabled: false },
  { id: "lighting", label: "Éclairage", bmp: `${UI_BMP_BASE}/Catalog/BuyFLighting.bmp`, enabled: false },
  { id: "misc", label: "Divers", bmp: `${UI_BMP_BASE}/Catalog/BuyFMisc.bmp`, enabled: false },
] as const;
const TS1_BUY_CATEGORIES_R = [
  { id: "all-r", label: "Toutes", bmp: null, enabled: true },
  { id: "living", label: "Salon", bmp: `${UI_BMP_BASE}/Catalog/BuyRLiving.BMP`, enabled: false },
  { id: "dining", label: "Salle à manger", bmp: `${UI_BMP_BASE}/Catalog/BuyRDining.bmp`, enabled: false },
  { id: "kitchen", label: "Cuisine", bmp: `${UI_BMP_BASE}/Catalog/BuyRKitchen.bmp`, enabled: false },
  { id: "bedroom", label: "Chambre", bmp: `${UI_BMP_BASE}/Catalog/BuyRBedroom.bmp`, enabled: false },
  { id: "bathroom", label: "Salle de bains", bmp: `${UI_BMP_BASE}/Catalog/BuyRBathroom.bmp`, enabled: false },
  { id: "study", label: "Bureau", bmp: `${UI_BMP_BASE}/Catalog/BuyRStudy.bmp`, enabled: false },
  { id: "outside", label: "Extérieur", bmp: `${UI_BMP_BASE}/Catalog/BuyROutside.bmp`, enabled: false },
  { id: "misc-r", label: "Divers", bmp: `${UI_BMP_BASE}/Catalog/BuyRMisc.bmp`, enabled: false },
] as const;
let buyCatalogScope: "function" | "room" = "function";

function mountBuyCenter(slot: HTMLDivElement): void {
  // Function/Room toggle — two compact pills at the top, the active one
  // highlighted in TS1 yellow.
  const scopeRow = document.createElement("div");
  scopeRow.style.cssText = "display:flex;gap:2px;margin-bottom:3px;justify-content:center;";
  for (const scope of ["function", "room"] as const) {
    const b = document.createElement("button");
    b.textContent = scope === "function" ? "Fonction" : "Pièce";
    b.dataset["buyScope"] = scope;
    const active = scope === buyCatalogScope;
    b.style.cssText = [
      "flex:1",
      "padding:1px 4px",
      `background:${active ? "rgba(255,223,128,0.22)" : "transparent"}`,
      `border:1px solid ${active ? "#ffdf80" : "#000"}`,
      "border-radius:2px",
      "color:#ffdf80",
      "font:bold 9px/1.2 \"MS Sans Serif\",sans-serif",
      "cursor:pointer",
    ].join(";");
    b.addEventListener("click", () => {
      buyCatalogScope = scope;
      renderTs1CenterSlot();
    });
    scopeRow.appendChild(b);
  }
  slot.appendChild(scopeRow);
  // Categories grid — 8 BuyF*/BuyR* icons in a 2×4 grid (fits the BuyPatch
  // overlay). The "all" entry is the default no-filter view.
  const cats = buyCatalogScope === "function" ? TS1_BUY_CATEGORIES_F : TS1_BUY_CATEGORIES_R;
  const strip = document.createElement("div");
  strip.style.cssText = "display:grid;grid-template-columns:repeat(4,1fr);gap:1px;margin-bottom:3px;";
  for (const cat of cats) {
    const b = document.createElement("button");
    b.dataset["buyCat"] = cat.id;
    b.title = cat.enabled ? cat.label : `${cat.label} — filtre OBJD à implémenter`;
    if (cat.bmp) {
      b.innerHTML = `<img src="${cat.bmp}" alt="${cat.label}" style="display:block;width:100%;max-width:34px;height:auto;image-rendering:pixelated;margin:0 auto;"/>`;
    } else {
      b.innerHTML = `<div style="font:9px/1.2 \"MS Sans Serif\",sans-serif;color:#ffdf80;padding:6px 2px;">${cat.label}</div>`;
    }
    b.disabled = !cat.enabled;
    b.style.cssText = [
      "padding:1px",
      "border-radius:2px",
      `cursor:${cat.enabled ? "pointer" : "not-allowed"}`,
      "background:transparent",
      "border:1px solid #000",
      "min-height:24px",
      "overflow:hidden",
      cat.enabled ? "" : "opacity:0.45;filter:grayscale(0.5);",
    ].join(";");
    strip.appendChild(b);
  }
  slot.appendChild(strip);
  // Existing place-object + selected-info bar.
  mountBuildToolsCenter(slot);
}

// ----------------------------------------------------------------------------
// Build mode TS1 tool palette — full TS1 toolbox. Wall/Door/Window/Floor-paint
// and the Sledgehammer (clear) are wired; Stairs/Pool/Roof/Plants/Hand-tool
// remain visible-but-disabled until their gameplay logic lands.
// ----------------------------------------------------------------------------

// Each toolBtn*.bmp in cpanel/Buttons/ contains 4 stacked horizontal frames
// (normal/hover/active/disabled). We only need the first one — cropped via
// CSS background-position. Frame width = BMP width / 4.
type Ts1BuildTool = {
  id: string;
  label: string;
  bmp: string | null; // path under cpanel/Buttons/ — null falls back to icon
  bmpFullW?: number;
  bmpFullH?: number;
  icon?: string;
  enabled: boolean;
};
const TS1_BUILD_TOOLS: readonly Ts1BuildTool[] = [
  { id: "hand", label: "Main", bmp: "toolBtnHand.bmp", bmpFullW: 120, bmpFullH: 35, enabled: false },
  { id: "wall", label: "Mur", bmp: "toolBtnWall.bmp", bmpFullW: 124, bmpFullH: 40, enabled: true },
  { id: "wall-line", label: "Mur (ligne)", bmp: "toolBtnWall.bmp", bmpFullW: 124, bmpFullH: 40, enabled: true },
  { id: "wall-rect", label: "Pièce", bmp: "toolBtnWall.bmp", bmpFullW: 124, bmpFullH: 40, enabled: true },
  { id: "door", label: "Porte", bmp: "toolBtnDoor.bmp", bmpFullW: 108, bmpFullH: 41, enabled: true },
  { id: "window", label: "Fenêtre", bmp: "toolBtnWindow.bmp", bmpFullW: 116, bmpFullH: 39, enabled: true },
  { id: "paint", label: "Sol", bmp: null, icon: "▪", enabled: true },
  { id: "paint-rect", label: "Sol (zone)", bmp: null, icon: "◫", enabled: true },
  { id: "wallpaper", label: "Papier peint", bmp: "toolBtnWallpaper.bmp", bmpFullW: 128, bmpFullH: 40, enabled: false },
  { id: "stairs", label: "Escalier", bmp: "toolBtnStairs.bmp", bmpFullW: 128, bmpFullH: 38, enabled: false },
  { id: "fireplace", label: "Cheminée", bmp: "toolBtnFireplace.bmp", bmpFullW: 116, bmpFullH: 35, enabled: false },
  { id: "tree", label: "Jardin", bmp: "toolBtnTree.bmp", bmpFullW: 140, bmpFullH: 39, enabled: false },
  { id: "pool", label: "Piscine", bmp: null, icon: "🌊", enabled: false },
  { id: "roof", label: "Toit", bmp: null, icon: "▲", enabled: false },
] as const;

function mountBuildCenter(slot: HTMLDivElement): void {
  // TS1 tool palette — 14 tools laid out in a 2×7 grid. Each entry uses its
  // real toolBtn*.bmp icon (1st frame cropped) where extracted, falling back
  // to a glyph for items whose authentic art lives in a not-yet-extracted FAR.
  const palette = document.createElement("div");
  palette.style.cssText = "display:grid;grid-template-columns:repeat(7,1fr);gap:1px;margin-bottom:3px;";
  for (const tool of TS1_BUILD_TOOLS) {
    const b = document.createElement("button");
    b.title = tool.enabled ? tool.label : `${tool.label} — non implémenté`;
    b.dataset["buildToolPalette"] = tool.id;
    if (tool.bmp && tool.bmpFullW && tool.bmpFullH) {
      const frameW = Math.round(tool.bmpFullW / 4);
      b.innerHTML = `<div style="width:${frameW}px;height:${tool.bmpFullH}px;background:url('${UI_BASE}/Buttons/${tool.bmp}') no-repeat 0 0;image-rendering:pixelated;margin:0 auto;transform:scale(0.7);transform-origin:top center;"></div>`;
    } else {
      b.innerHTML = `<div style="font-size:14px;line-height:1;">${tool.icon ?? "?"}</div>`;
    }
    b.disabled = !tool.enabled;
    b.style.cssText = [
      "padding:1px",
      "border-radius:2px",
      `cursor:${tool.enabled ? "pointer" : "not-allowed"}`,
      "background:transparent",
      "border:1px solid #000",
      "color:#ffdf80",
      "font:9px/1 \"MS Sans Serif\",sans-serif",
      tool.enabled ? "" : "opacity:0.45;filter:grayscale(0.5);",
      "min-height:18px",
      "overflow:hidden",
    ].join(";");
    palette.appendChild(b);
  }
  palette.addEventListener("click", (ev) => {
    const t = ev.target;
    const btn = t instanceof HTMLElement ? t.closest("button") : null;
    if (!(btn instanceof HTMLButtonElement)) return;
    if (btn.disabled) return;
    const id = btn.dataset["buildToolPalette"];
    if (id === "wall" || id === "wall-line" || id === "wall-rect" || id === "door" || id === "window" || id === "paint" || id === "paint-rect") {
      buildTool = id;
      updateBuildToolHighlights();
    }
  });
  slot.appendChild(palette);
  // Then the existing build sub-tool bar (paint swatches, clear, house picker).
  mountBuildToolsCenter(slot);
}

// ----------------------------------------------------------------------------
// Live center — TS1 layout: portrait + name + Job/Skills/Friends/Personality
// tabs. Tab content renders inline; portrait and tabs are stable across
// re-renders, only the inner content swaps. Mirrors the real game's right-side
// panel structure.
// ----------------------------------------------------------------------------

const SKILL_NAMES = ["Cooking", "Mechanical", "Charisma", "Body", "Logic", "Creativity", "Cleaning"] as const;
type LiveTab = "job" | "skills" | "friends" | "traits";
let activeLiveTab: LiveTab = "job";

function mountLiveCenter(slot: HTMLDivElement): void {
  const sim = sims[selectedSimIdx];
  const wrap = document.createElement("div");
  wrap.style.cssText =
    "display:grid;grid-template-rows:auto 1fr;gap:3px;height:100%;font:11px/1.3 \"MS Sans Serif\",sans-serif;color:#ffdf80;";
  // Authentic TS1 sub-tabs row — 4 buttons using the real House / Job /
  // Interest / Gift BMPs (108×30 each). They scale down inside the LivePatch
  // area; the active tab gets a brighter border.
  const tabs = document.createElement("div");
  tabs.style.cssText = "display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:2px;";
  // Friends/Personality don't have dedicated TS1 base-game BMPs in cpanel/
  // (those live in Buttons/ via FameIconMultiButton etc.), so for Friends we
  // reuse Interest.bmp (closest semantically) and for Personality we use Gift
  // as a placeholder until the real bitmap is identified.
  const tabBmps: Array<[LiveTab, string, string]> = [
    ["job", "Job.bmp", "Job"],
    ["skills", "House.bmp", "House / Skills"],
    ["friends", "Interest.bmp", "Friends / Interests"],
    ["traits", "Gift.bmp", "Personality"],
  ];
  for (const [key, bmp, alt] of tabBmps) {
    const b = document.createElement("button");
    b.dataset["liveTab"] = key;
    b.title = alt;
    const active = key === activeLiveTab;
    b.style.cssText = [
      `background:${active ? "rgba(255,223,128,0.18)" : "transparent"}`,
      `border:1px solid ${active ? "#ffdf80" : "#000"}`,
      "padding:1px",
      "cursor:pointer",
      "border-radius:2px",
      "line-height:0",
      "min-height:18px",
    ].join(";");
    b.innerHTML = `<img src="${UI_BASE}/Buttons/${bmp}" alt="${alt}" style="display:block;width:100%;height:auto;image-rendering:pixelated;"/>`;
    tabs.appendChild(b);
  }
  wrap.appendChild(tabs);
  // Content area.
  const content = document.createElement("div");
  content.dataset["liveContent"] = "1";
  content.style.cssText = "overflow:auto;min-height:0;font:10px/1.2 \"MS Sans Serif\",sans-serif;color:#ffdf80;";
  wrap.appendChild(content);
  renderLiveTabContent(content, sim);
  // Wire tab clicks.
  tabs.addEventListener("click", (ev) => {
    const t = ev.target;
    const btn = t instanceof HTMLElement ? t.closest("button") : null;
    if (!(btn instanceof HTMLButtonElement)) return;
    const tab = btn.dataset["liveTab"];
    if (tab === "job" || tab === "skills" || tab === "friends" || tab === "traits") {
      activeLiveTab = tab;
      renderTs1CenterSlot();
    }
  });
  slot.appendChild(wrap);
}

function renderLiveTabContent(host: HTMLDivElement, sim: SimState | undefined): void {
  if (!sim) {
    host.innerHTML = `<div style="opacity:.5;font-style:italic;">no Sim selected</div>`;
    return;
  }
  if (activeLiveTab === "job") {
    host.innerHTML = `
      <div style="opacity:.85;">Career: <span style="color:#fff;">Unemployed</span></div>
      <div style="opacity:.85;margin-top:3px;">Level: <span style="color:#fff;">—</span></div>
      <div style="opacity:.85;margin-top:3px;">Salary: <span style="color:#cfa;">§0</span> /hr</div>
      <div style="opacity:.7;font-size:10px;margin-top:6px;">Read the newspaper or use the computer to find a job.</div>
    `;
  } else if (activeLiveTab === "skills") {
    let html = "";
    for (let i = 0; i < SKILL_NAMES.length; i += 1) {
      const v = 0; // skills not yet tracked per-Sim; placeholder for compat with TS1 panel.
      html += `<div style="display:grid;grid-template-columns:70px 1fr 18px;gap:5px;align-items:center;margin-bottom:2px;">
        <span style="opacity:.85;">${SKILL_NAMES[i]}</span>
        <div style="position:relative;height:7px;background:#1a2030;border:1px solid #2a3a52;border-radius:2px;overflow:hidden;">
          <div style="position:absolute;left:0;top:0;bottom:0;width:${v * 10}%;background:#5fb86b;"></div>
        </div>
        <span style="font-variant-numeric:tabular-nums;opacity:.8;text-align:right;">${v}</span>
      </div>`;
    }
    host.innerHTML = html;
  } else if (activeLiveTab === "friends") {
    const others = sims.filter((s) => s.id !== sim.id);
    if (others.length === 0) {
      host.innerHTML = `<div style="opacity:.5;font-style:italic;">no other Sims in the household</div>`;
      return;
    }
    let html = "";
    for (const other of others) {
      html += `<div style="display:grid;grid-template-columns:14px 1fr 70px;gap:5px;align-items:center;margin-bottom:3px;">
        <span style="width:12px;height:12px;border-radius:50%;background:${other.headColor};border:1px solid #345;"></span>
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(other.name)}</span>
        <span style="opacity:.6;font-size:10px;font-variant-numeric:tabular-nums;">D:0 L:0</span>
      </div>`;
    }
    host.innerHTML = html;
  } else {
    // Personality (traits 0-10 along 5 axes).
    let html = "";
    for (let i = 0; i < TRAIT_PAIRS.length; i += 1) {
      const [low, high] = TRAIT_PAIRS[i] ?? ["", ""];
      const v = sim.traits[i] ?? 5;
      html += `<div style="margin-bottom:4px;">
        <div style="display:flex;justify-content:space-between;font-size:10px;opacity:.75;">
          <span>${low}</span><span>${high}</span>
        </div>
        <div style="position:relative;height:7px;background:#1a2030;border:1px solid #2a3a52;border-radius:2px;overflow:hidden;">
          <div style="position:absolute;left:0;top:0;bottom:0;width:${v * 10}%;background:#7ab8ff;"></div>
        </div>
      </div>`;
    }
    host.innerHTML = html;
  }
  // Click handlers for Job tab buttons.
  host.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLButtonElement)) return;
    const action = t.dataset["liveAction"];
    if (action === "add-sim") openCasModal();
    else if (action === "neighborhood") void openNeighborhoodModal();
  });
}

function mountBuildToolsCenter(slot: HTMLDivElement): void {
  // Secondary actions row — paint swatches, clear, house picker, selected
  // object info. The main tool selection lives in the palette/strip above.
  // Keeps id="build-tools" so updateBuildToolHighlights() finds it.
  const buildBar = document.createElement("div");
  buildBar.id = "build-tools";
  buildBar.style.cssText =
    "display:flex;flex-wrap:wrap;gap:4px;align-items:center;font:11px/1.3 ui-sans-serif,system-ui,sans-serif;color:#cde;";
  const swatches = FLOOR_PAINT_PRESETS.map(
    (p) =>
      `<button data-paint-id="${p.id}" title="${p.label}" style="width:20px;height:20px;background:${p.color};border:1px solid #345;border-radius:3px;cursor:pointer;"></button>`,
  ).join("");
  buildBar.innerHTML = `
    <span data-mode-buy style="opacity:.7;">action</span>
    <button data-mode-buy data-build-tool="place" title="Place the selected catalog object on an empty tile">place</button>
    <span data-build-selected style="opacity:.85;color:#cde;border-left:1px solid #345;padding-left:6px;display:none;"></span>
    <span data-mode-build style="opacity:.7;">color</span>
    <span data-mode-build style="display:contents;">${swatches}</span>
    <button data-mode-build data-paint-action="clear" title="Erase all painted tiles">clear floor</button>
    <button data-mode-build data-wall-action="clear" title="Remove all walls">clear walls</button>
    <span data-mode-build style="opacity:.5;">·</span>
    <span data-mode-build style="opacity:.7;">house</span>
    <select data-mode-build data-template-picker style="background:#1a2230;color:#cde;border:1px solid #345;border-radius:3px;padding:2px 4px;font:11px ui-monospace,monospace;max-width:130px;"><option value="">(loading…)</option></select>
    <button data-mode-build data-house-action="load" title="Replace floor & walls with the chosen Magictown house">load</button>
    <span data-mode-build data-house-status style="opacity:.7;color:#9bd09b;font-size:10px;"></span>
  `;
  slot.appendChild(buildBar);
  void mountTemplatePicker(buildBar);
  buildBar.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLButtonElement)) return;
    const tool = t.dataset["buildTool"];
    if (
      tool === "place" ||
      tool === "paint" ||
      tool === "paint-rect" ||
      tool === "wall" ||
      tool === "wall-line" ||
      tool === "wall-rect" ||
      tool === "door" ||
      tool === "window"
    ) {
      buildTool = tool;
      updateBuildToolHighlights();
    }
    const paintId = t.dataset["paintId"];
    if (paintId) {
      activePaintId = paintId as typeof activePaintId;
      buildTool = "paint";
      updateBuildToolHighlights();
    }
    if (t.dataset["paintAction"] === "clear") {
      floorPaint.clear();
      composeLotScene();
    }
    if (t.dataset["wallAction"] === "clear") {
      wallsN.clear();
      wallsW.clear();
      doorsN.clear();
      doorsW.clear();
      windowsN.clear();
      windowsW.clear();
      composeLotScene();
    }
    if (t.dataset["houseAction"] === "load") {
      const picker = buildBar.querySelector<HTMLSelectElement>("select[data-template-picker]");
      const path = picker?.value;
      if (path) void loadAndApplyHouse(path, buildBar);
    }
  });
  // The visibility gating of [data-mode-buy] / [data-mode-build] is applied by
  // updateModeButtonHighlights() — call it now so the sub-tools match the mode.
  updateModeButtonHighlights();
}

function mountCameraControls(): void {
  mountTs1Panel();
  setCpanelMode(lotMode);
  mountCameraMiniBar();
  mountMinimap();
  mountBottomModeBar();
  renderTs1CenterSlot();
  updateCameraButtonHighlights();
}

// Options modal entry point — body defined later in the file. Stored on a
// holder so the bottom-bar click handler picks up the real impl whenever the
// Options section installs it.
const optionsModalHook: { open: (() => void) | null } = { open: null };
function openOptionsModal(): void {
  optionsModalHook.open?.();
}

// ============================================================================
// Bottom mode bar — TS1's iconic Live / Buy / Build / Options tabs along the
// bottom of the screen. Single source of truth for mode switching.
// ============================================================================

function mountBottomModeBar(): void {
  const existing = document.getElementById("bottom-mode-bar");
  existing?.remove();
  const slot = document.querySelector<HTMLDivElement>("#ts1-panel [data-slot-body='tabs']");
  const bar = document.createElement("div");
  bar.id = "bottom-mode-bar";
  // TS1 modes: Live / Buy / Build / Options. Use FR labels from UIText
  // chunk 138 (VCtlTips) entries 10 / 11 / 12 / 13 as tooltips and short
  // single-glyph labels on the buttons themselves, matching the cramped
  // right-edge real estate of the original panel.
  if (slot) {
    bar.style.cssText =
      "display:flex;flex-direction:column;gap:2px;padding:4px 4px 4px 0;font:10px/1.1 \"MS Sans Serif\",sans-serif;color:#ffdf80;height:100%;justify-content:center;";
  } else {
    bar.style.cssText =
      "position:fixed;bottom:10px;left:50%;transform:translateX(-50%);display:flex;gap:4px;align-items:stretch;" +
      "background:linear-gradient(180deg,#1a2840 0%,#0f1a2d 100%);border:1px solid #3a4a66;box-shadow:0 4px 14px rgba(0,0,0,.45);" +
      "padding:6px 8px;border-radius:8px;z-index:60;font:13px/1.2 ui-sans-serif,system-ui,sans-serif;color:#cde;";
  }
  bar.innerHTML = `
    <style>
      #bottom-mode-bar button.mode-tab {
        background: transparent;
        border: 1px solid #000;
        color: #ffdf80;
        padding: 2px 8px;
        border-radius: 2px;
        cursor: pointer;
        font: inherit;
        font-weight: 600;
        display: flex;
        align-items: center;
        gap: 4px;
        text-shadow: 0 1px 0 rgba(0,0,0,0.5);
      }
      #bottom-mode-bar button.mode-tab:hover { background: rgba(255,255,255,.05); }
      #bottom-mode-bar button.mode-tab.mode-active {
        background: rgba(255,223,128,0.22);
        border-color: #ffdf80;
        color: #ffffff;
        box-shadow: inset 0 0 4px rgba(0,0,0,0.4);
      }
      #bottom-mode-bar .mode-glyph { font-size: 13px; line-height: 1; opacity: .9; width: 14px; text-align: center; }
      #bottom-mode-bar .mode-label { font-size: 10px; letter-spacing: 0.03em; }
    </style>
    <button class="mode-tab" data-mode-tab="play" data-vctl="10">
      <span class="mode-glyph">▶</span><span class="mode-label" data-mode-text="play">Live</span>
    </button>
    <button class="mode-tab" data-mode-tab="buy" data-vctl="11">
      <span class="mode-glyph">§</span><span class="mode-label" data-mode-text="buy">Buy</span>
    </button>
    <button class="mode-tab" data-mode-tab="build" data-vctl="12">
      <span class="mode-glyph">⚒</span><span class="mode-label" data-mode-text="build">Build</span>
    </button>
    <button class="mode-tab" data-mode-tab="options" data-vctl="13">
      <span class="mode-glyph">⚙</span><span class="mode-label" data-mode-text="options">Options</span>
    </button>
  `;
  // Replace English labels + tooltip with FR localised UIText 138 entries
  // (Mode Vie / Mode Achat / Mode Construction / Mode Options). The labels
  // include keyboard shortcuts ("- F1") which we strip from the visible
  // text but keep in the title for completeness.
  const modeKeyToText: Record<string, string> = { play: "Mode Vie", buy: "Achat", build: "Construction", options: "Options" };
  for (const btn of bar.querySelectorAll<HTMLButtonElement>("button.mode-tab")) {
    const idx = parseInt(btn.dataset["vctl"] ?? "-1", 10);
    if (idx >= 0) {
      const full = tStr("UIText", 138, idx, "");
      if (full) btn.title = full;
    }
    const key = btn.dataset["modeTab"] ?? "";
    const label = btn.querySelector<HTMLSpanElement>("span[data-mode-text]");
    if (label && modeKeyToText[key]) {
      // Use short FR labels in-button; tooltip carries the long form.
      label.textContent = modeKeyToText[key];
    }
  }
  bar.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    const btn = t.closest("button.mode-tab");
    if (!(btn instanceof HTMLButtonElement)) return;
    const tab = btn.dataset["modeTab"];
    if (tab === "play" || tab === "buy" || tab === "build") setLotMode(tab);
    else if (tab === "options") openOptionsModal();
  });
  (slot ?? document.body).appendChild(bar);
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

function setLotMode(m: LotMode): void {
  lotMode = m;
  // Auto-pick a sensible default sub-tool when entering Buy/Build.
  if (m === "buy") buildTool = "place";
  else if (m === "build" && !BUILD_TOOLS_FOR_BUILD.has(buildTool)) buildTool = "wall";
  // Swap the mode patch chrome (LivePatch / BuyPatch / BuildPatch) under the
  // center slot so the rounded overlay matches the active mode.
  setCpanelMode(m);
  // Rebuild the center slot so it shows the right tools / queue.
  renderTs1CenterSlot();
  updateModeButtonHighlights();
  // Repaint so the ghost preview attaches/detaches with mode changes.
  composeLotScene();
}

function updateModeButtonHighlights(): void {
  const bar = document.getElementById("camera-controls");
  if (bar) {
    for (const btn of bar.querySelectorAll<HTMLButtonElement>("button[data-cam-action]")) {
      const action = btn.dataset["camAction"];
      if (action === "walls") {
        btn.textContent = `walls: ${WALL_MODES[wallModeIdx]}`;
        btn.style.cssText = controlButtonStyle(wallModeIdx !== 0);
      }
    }
  }
  const bottomBar = document.getElementById("bottom-mode-bar");
  if (bottomBar) {
    for (const btn of bottomBar.querySelectorAll<HTMLButtonElement>("button[data-mode-tab]")) {
      const tab = btn.dataset["modeTab"];
      btn.classList.toggle("mode-active", tab === lotMode);
    }
  }
  const buildBar = document.getElementById("build-tools");
  if (buildBar instanceof HTMLDivElement) {
    buildBar.style.display = lotMode === "buy" || lotMode === "build" ? "flex" : "none";
    // Show/hide sub-tool buttons based on which mode is active.
    for (const el of buildBar.querySelectorAll<HTMLElement>("[data-mode-buy], [data-mode-build]")) {
      const buyOnly = el.hasAttribute("data-mode-buy");
      const buildOnly = el.hasAttribute("data-mode-build");
      const show =
        (buyOnly && lotMode === "buy") || (buildOnly && lotMode === "build");
      el.style.display = show ? "" : "none";
    }
  }
  updateBuildToolHighlights();
}

function updateBuildToolHighlights(): void {
  const bar = document.getElementById("build-tools");
  if (!bar) return;
  for (const btn of bar.querySelectorAll<HTMLButtonElement>("button[data-build-tool]")) {
    const tool = btn.dataset["buildTool"];
    btn.style.cssText = controlButtonStyle(tool === buildTool);
  }
  for (const btn of bar.querySelectorAll<HTMLButtonElement>("button[data-paint-id]")) {
    const id = btn.dataset["paintId"];
    btn.style.outline = id === activePaintId ? "2px solid #cde" : "none";
  }
  const sel = bar.querySelector<HTMLSpanElement>("span[data-build-selected]");
  if (sel) {
    const obj = viewerState.current;
    if (buildTool === "place" && obj) {
      const tag = obj.price > 0 ? `§${obj.price}` : "—";
      sel.textContent = `→ ${obj.objectName}  ${tag}`;
      sel.style.display = "inline";
    } else {
      sel.style.display = "none";
    }
  }
}

window.addEventListener("keydown", (ev) => {
  if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement) return;
  // Pan in *screen* directions (the user expects ↑ to move the visible world
  // up regardless of camera rotation). The (1, 1) / (-1, -1) screen axes map
  // to the iso (+x, +y) / (-x, -y) tile diagonals; rotation is folded back in
  // by panCamera via the camera transform applied at render time.
  const PAN_STEP = 1.5;
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
    case "ArrowUp":
      panCamera(...rotatedPan(0, -PAN_STEP));
      break;
    case "ArrowDown":
      panCamera(...rotatedPan(0, PAN_STEP));
      break;
    case "ArrowLeft":
      panCamera(...rotatedPan(-PAN_STEP, 0));
      break;
    case "ArrowRight":
      panCamera(...rotatedPan(PAN_STEP, 0));
      break;
    case "r":
    case "R":
      recenterCamera();
      break;
    case " ":
    case "Spacebar":
      togglePause();
      break;
    case "1":
      setGameSpeed(1);
      break;
    case "2":
      setGameSpeed(2);
      break;
    case "3":
      setGameSpeed(3);
      break;
    case "Escape":
      // Cancel an active stroke (wall-line / wall-rect / paint-rect).
      if (strokeAnchor) {
        strokeAnchor = null;
        lotScene.strokeAnchorTile = null;
        composeLotScene();
      }
      break;
    default:
      return;
  }
  ev.preventDefault();
});

/** Convert a screen-space pan vector (where (1, 0) is "right on screen" and
 *  (0, 1) is "down on screen") into a tile-space pan that survives rotation.
 *  Pre-rotation: screen (sx, sy) ≈ tile (sx + sy, -sx + sy) / 2 in iso. Post-
 *  rotation we undo the camera spin so the user's "up" stays up regardless of
 *  the current `cam.rotation`. */
function rotatedPan(screenDX: number, screenDY: number): [number, number] {
  // Inverse iso projection at unit scale: tile (lx, ly) = (sdx + 2*sdy, -sdx + 2*sdy)/2.
  let lx = (screenDX + 2 * screenDY) / 2;
  let ly = (-screenDX + 2 * screenDY) / 2;
  switch (lotScene.camera.rotation ?? 0) {
    case 1: { const t = lx; lx = ly; ly = -t; break; }
    case 2: lx = -lx; ly = -ly; break;
    case 3: { const t = lx; lx = -ly; ly = t; break; }
    default: break;
  }
  return [lx, ly];
}

mountCameraControls();
// Load authentic Maxis STR# strings (FR by default, EN fallback). The first
// renderMotivesHud()/renderTs1CenterSlot() will use English placeholders;
// once the JSONs land we re-render so the panel switches to FR live.
void loadStrings().then(() => {
  renderMotivesHud();
  renderFamilyHud();
  renderTs1CenterSlot();
});
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
  dismissBootSplash();
  void runRealAssetSmokeTest(wasm);
}).catch((err) => {
  console.error("[engine] init failed:", err);
  dismissBootSplash();
});

// Safety net: if neither the success nor the failure path of engine init fires
// within 8 s, drop the splash anyway so the user isn't stuck staring at it.
setTimeout(dismissBootSplash, 8000);

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
  /** OBJD §price (field 16). 0 = free / not for sale. */
  price: number;
  /** OBJD initial depreciation (field 33). Newly-bought objects lose this on
   *  first placement; current sell value floors at `priceLimit`. */
  initialDepreciation: number;
  /** Multi-tile master ID (OBJD field 8). 0 = single-tile. */
  masterId: number;
  /** Tile offsets (relative to anchor) blocked by this object. `[(0, 0)]` for
   *  single-tile; multi-tile objects expand from OBJD master_id + sub_index. */
  footprint: Array<{ x: number; y: number }>;
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
    case "Syslog":
      return `Syslog str=${ef["stringIndex"]}`;
    case "EngineHook":
      return `EngineHook #${ef["primitive"]} ${ef["name"] ?? ""}`;
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
  // OBJD prices are stored as u16; treat 0 / -1 as "no price".
  const rawPrice = objd.fields[16] ?? 0;
  const price = rawPrice > 0 && rawPrice < 0xffff ? rawPrice : 0;
  const initialDepreciation = objd.fields[33] ?? 0;
  const masterId = objd.fields[8] ?? 0;
  let footprint: Array<{ x: number; y: number }> = [{ x: 0, y: 0 }];
  if (masterId !== 0) {
    try {
      const tiles = wasm.objdFootprint(data, masterId) as Array<{ x: number; y: number }>;
      if (tiles.length > 0) footprint = tiles;
    } catch (err) {
      console.warn(`[viewer] objdFootprint(${masterId}) failed for ${iffName}:`, err);
    }
  }
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
  return { iffName, objectName, data, chunks, paltChunk, baseGraphicId, dgrps, semiGlobalName, objfEntries, price, initialDepreciation, masterId, footprint };
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

/** True when every tile of `obj`'s footprint anchored at `(ax, ay)` is in-bounds
 *  and free of other instances. `ignoreInstanceId` lets the move-drag handler
 *  exclude the instance currently being moved from the occupancy check. */
function canPlaceFootprintAt(
  obj: LoadedObject,
  ax: number,
  ay: number,
  ignoreInstanceId: number | null = null,
): boolean {
  const N = lotScene.gridSize;
  for (const cell of obj.footprint) {
    const tx = ax + cell.x;
    const ty = ay + cell.y;
    if (tx < 0 || ty < 0 || tx >= N || ty >= N) return false;
    for (const inst of lotInstances) {
      if (inst.id === ignoreInstanceId) continue;
      for (const c of inst.obj.footprint) {
        if (inst.worldX + c.x === tx && inst.worldY + c.y === ty) return false;
      }
    }
  }
  return true;
}

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
  // Viewer's current selection — anchored to the hover tile when the user is
  // about to place it (so they see exactly where it lands), or to the lot
  // centre as a passive preview otherwise.
  const viewerObj = viewerState.current;
  if (viewerObj) {
    let anchorX = 8;
    let anchorY = 8;
    if (
      lotMode === "buy" &&
      buildTool === "place" &&
      lotScene.hoverTile &&
      !lotInstances.some(
        (i) => i.worldX === lotScene.hoverTile!.worldX && i.worldY === lotScene.hoverTile!.worldY,
      )
    ) {
      anchorX = lotScene.hoverTile.worldX;
      anchorY = lotScene.hoverTile.worldY;
    }
    const transient: LotInstance = {
      id: 0,
      obj: viewerObj,
      worldX: anchorX,
      worldY: anchorY,
      direction: viewerState.direction,
      zoom: viewerState.zoom,
      dgrpId: viewerState.dgrpId,
      decoded: null,
    };
    for (const d of decodeInstanceSprites(wasm, transient)) {
      sprites.push({ bmp: d.bmp, sp: d.sp, worldX: anchorX, worldY: anchorY });
    }
  }
  lotScene.sprites = sprites;
  lotScene.entities = allSimEntities();
  lotScene.floorPaint = floorPaint;
  lotScene.wallsN = wallsN;
  lotScene.wallsW = wallsW;
  lotScene.doorsN = doorsN;
  lotScene.doorsW = doorsW;
  lotScene.windowsN = windowsN;
  lotScene.windowsW = windowsW;
  lotScene.timeMinutes = gameMinutes;
  renderLot();
  drawMinimap();
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

function pickSimIndex(canvasX: number, canvasY: number): number | null {
  const cam = lotScene.camera;
  const radius = cam.tileWidth / 2;
  let bestIdx: number | null = null;
  let bestDist = Infinity;
  for (let i = 0; i < sims.length; i += 1) {
    const sim = sims[i]!;
    const { sx, sy } = projectTileToScreen(sim.fx, sim.fy, cam, canvas);
    // Hit area centred slightly above the projected tile centre (Sim head).
    const dx = sx - canvasX;
    const dy = sy - cam.tileWidth / 4 - canvasY;
    const d = Math.hypot(dx, dy);
    if (d < radius && d < bestDist) {
      bestIdx = i;
      bestDist = d;
    }
  }
  return bestIdx;
}

function onLotCanvasClick(ev: MouseEvent): void {
  if (suppressNextLotClick) {
    suppressNextLotClick = false;
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const cx = (ev.clientX - rect.left) * (canvas.width / rect.width);
  const cy = (ev.clientY - rect.top) * (canvas.height / rect.height);
  // Wall sub-tool is fully handled by mousedown/move/up so the user can drag
  // out a multi-edge segment in one stroke. The click event still fires after
  // the drag, but we ignore it here.
  if (lotMode === "build" && buildTool === "wall") {
    closeInteractionMenuImpl();
    return;
  }
  // Door / window sub-tools are single-click; toggle at the nearest edge.
  if (lotMode === "build" && (buildTool === "door" || buildTool === "window")) {
    const tile = screenToTile(cx, cy, lotScene.camera, canvas);
    const edge = nearestEdge(tile.fx, tile.fy);
    if (edge) {
      const N = lotScene.gridSize;
      const k = edge.y * (N + 1) + edge.x;
      const set =
        buildTool === "door"
          ? edge.orientation === "n" ? doorsN : doorsW
          : edge.orientation === "n" ? windowsN : windowsW;
      if (ev.shiftKey || set.has(k)) set.delete(k);
      else set.add(k);
      composeLotScene();
    }
    closeInteractionMenuImpl();
    return;
  }
  // Sim hit-test wins over instance hit-test so the user can grab a Sim
  // even when it's standing on top of an object.
  const simIdx = pickSimIndex(cx, cy);
  if (simIdx !== null && simIdx !== selectedSimIdx) {
    selectedSimIdx = simIdx;
    renderMotivesHud();
    composeLotScene();
    closeInteractionMenuImpl();
    return;
  }
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
    if (buildTool === "paint") {
      const preset = FLOOR_PAINT_PRESETS.find((p) => p.id === activePaintId);
      if (preset) {
        floorPaint.set(tile.worldY * lotScene.gridSize + tile.worldX, preset.color);
        composeLotScene();
      }
    }
    // (wall sub-tool is handled at the top of this function so it bypasses
    //  the instance/sim hit-tests entirely; paint-rect/wall-line/wall-rect are
    //  also handled via the stroke anchor pathway.)
    closeInteractionMenuImpl();
    return;
  }
  if (lotMode === "buy") {
    // Buy mode: place the catalog-selected object on the empty tile.
    const obj = viewerState.current;
    if (!obj) {
      showBubble("pick an object from the catalog first");
      closeInteractionMenuImpl();
      return;
    }
    if (!canPlaceFootprintAt(obj, tile.worldX, tile.worldY)) {
      showBubble("can't place — tiles occupied or off-grid");
      closeInteractionMenuImpl();
      return;
    }
    if (obj.price > 0 && funds < obj.price) {
      showBubble(`§${obj.price} — not enough funds`);
      closeInteractionMenuImpl();
      return;
    }
    placeOnLot(obj, tile.worldX, tile.worldY, viewerState.direction, viewerState.zoom);
    if (obj.price > 0) {
      adjustFunds(-obj.price);
      showBubble(`-§${obj.price} ${obj.objectName}`);
    }
    composeLotScene();
    closeInteractionMenuImpl();
    return;
  }
  // Play mode: walk the Sim to the clicked tile.
  closeInteractionMenuImpl();
  startWalk(tile.worldX, tile.worldY);
}

canvas.addEventListener("click", onLotCanvasClick);

// Wall drag — left-button drag in build/wall mode paints every edge the
// cursor crosses. `lastKey` deduplicates so we don't recompose the scene per
// pixel of motion.
let wallDrag: { erase: boolean; lastKey: string | null } | null = null;

// Anchor for the two-click stroke tools (wall-line, wall-rect, paint-rect).
// Captured on mousedown, committed on mouseup. No live preview yet —
// commit-on-release is simple and fast enough for 16×16 lots.
type StrokeKind = "wall-line" | "wall-rect" | "paint-rect";
let strokeAnchor: {
  kind: StrokeKind;
  worldX: number;
  worldY: number;
  erase: boolean;
} | null = null;

/** Add (or remove if erase) one north-edge wall at edge-key (x, y). */
function applyWallN(x: number, y: number, erase: boolean): void {
  const N = lotScene.gridSize;
  if (x < 0 || y < 0 || x >= N || y > N) return;
  const k = y * (N + 1) + x;
  if (erase) wallsN.delete(k);
  else wallsN.add(k);
}
function applyWallW(x: number, y: number, erase: boolean): void {
  const N = lotScene.gridSize;
  if (x < 0 || y < 0 || x > N || y >= N) return;
  const k = y * (N + 1) + x;
  if (erase) wallsW.delete(k);
  else wallsW.add(k);
}

/** Commit a straight wall between (x1, y1) and (x2, y2). The longer-axis wins —
 *  if `|dx| >= |dy|` we lay a horizontal run on row y1 (north edges of row y1),
 *  otherwise a vertical run on column x1 (west edges of column x1). */
function applyWallLine(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  erase: boolean,
): void {
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);
  if (dx >= dy) {
    const lo = Math.min(x1, x2);
    const hi = Math.max(x1, x2);
    for (let x = lo; x <= hi; x += 1) applyWallN(x, y1, erase);
  } else {
    const lo = Math.min(y1, y2);
    const hi = Math.max(y1, y2);
    for (let y = lo; y <= hi; y += 1) applyWallW(x1, y, erase);
  }
}

/** Lay the perimeter walls of the bounding rectangle of (x1, y1) and (x2, y2). */
function applyWallRect(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  erase: boolean,
): void {
  const xa = Math.min(x1, x2);
  const xb = Math.max(x1, x2);
  const ya = Math.min(y1, y2);
  const yb = Math.max(y1, y2);
  for (let x = xa; x <= xb; x += 1) {
    applyWallN(x, ya, erase);
    applyWallN(x, yb + 1, erase);
  }
  for (let y = ya; y <= yb; y += 1) {
    applyWallW(xa, y, erase);
    applyWallW(xb + 1, y, erase);
  }
}

/** Fill the floor-paint rectangle [(x1,y1) ; (x2,y2)] with `color`, or
 *  erase if `erase` is true. */
function applyPaintRect(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  erase: boolean,
): void {
  const N = lotScene.gridSize;
  const xa = Math.max(0, Math.min(x1, x2));
  const xb = Math.min(N - 1, Math.max(x1, x2));
  const ya = Math.max(0, Math.min(y1, y2));
  const yb = Math.min(N - 1, Math.max(y1, y2));
  for (let y = ya; y <= yb; y += 1) {
    for (let x = xa; x <= xb; x += 1) {
      const k = y * N + x;
      if (erase) floorPaint.delete(k);
      else floorPaint.set(k, color);
    }
  }
}

/** Get the tile under a client (mouse) position, clamped to the lot. */
function tileFromClient(clientX: number, clientY: number): { x: number; y: number } | null {
  const rect = canvas.getBoundingClientRect();
  const cx = (clientX - rect.left) * (canvas.width / rect.width);
  const cy = (clientY - rect.top) * (canvas.height / rect.height);
  const tile = screenToTile(cx, cy, lotScene.camera, canvas);
  const N = lotScene.gridSize;
  if (tile.worldX < 0 || tile.worldY < 0 || tile.worldX >= N || tile.worldY >= N) return null;
  return { x: tile.worldX, y: tile.worldY };
}

/** Commit the active stroke at release. */
function commitStroke(endX: number, endY: number): void {
  if (!strokeAnchor) return;
  const a = strokeAnchor;
  if (a.kind === "wall-line") {
    applyWallLine(a.worldX, a.worldY, endX, endY, a.erase);
  } else if (a.kind === "wall-rect") {
    applyWallRect(a.worldX, a.worldY, endX, endY, a.erase);
  } else if (a.kind === "paint-rect") {
    const preset = FLOOR_PAINT_PRESETS.find((p) => p.id === activePaintId);
    if (preset) applyPaintRect(a.worldX, a.worldY, endX, endY, preset.color, a.erase);
  }
  strokeAnchor = null;
  lotScene.strokeAnchorTile = null;
  composeLotScene();
}

function paintWallEdgeAtClient(clientX: number, clientY: number, erase: boolean): void {
  if (!wallDrag) return;
  const rect = canvas.getBoundingClientRect();
  const cx = (clientX - rect.left) * (canvas.width / rect.width);
  const cy = (clientY - rect.top) * (canvas.height / rect.height);
  const tile = screenToTile(cx, cy, lotScene.camera, canvas);
  const N = lotScene.gridSize;
  if (tile.worldX < 0 || tile.worldY < 0 || tile.worldX >= N || tile.worldY >= N) return;
  const edge = nearestEdge(tile.fx, tile.fy);
  if (!edge) return;
  const key = `${edge.orientation}:${edge.x},${edge.y}`;
  if (wallDrag.lastKey === key) return;
  wallDrag.lastKey = key;
  const k = edge.y * (N + 1) + edge.x;
  const set = edge.orientation === "n" ? wallsN : wallsW;
  if (erase) set.delete(k);
  else set.add(k);
  composeLotScene();
}

// Move drag — in build/place mode, mousedown on an existing instance starts
// a relocation; the click handler is suppressed so we don't double-place.
let moveDrag: { instId: number; origX: number; origY: number } | null = null;
let suppressNextLotClick = false;

canvas.addEventListener("mousedown", (ev) => {
  if (ev.button !== 0) return;
  if (lotMode !== "build") return;
  if (buildTool === "wall") {
    ev.preventDefault();
    wallDrag = { erase: ev.shiftKey, lastKey: null };
    paintWallEdgeAtClient(ev.clientX, ev.clientY, wallDrag.erase);
    return;
  }
  if (buildTool === "wall-line" || buildTool === "wall-rect" || buildTool === "paint-rect") {
    const t = tileFromClient(ev.clientX, ev.clientY);
    if (!t) return;
    ev.preventDefault();
    strokeAnchor = { kind: buildTool, worldX: t.x, worldY: t.y, erase: ev.shiftKey };
    lotScene.strokeAnchorTile = { worldX: t.x, worldY: t.y };
    composeLotScene();
    suppressNextLotClick = true;
    return;
  }
  if (buildTool === "place") {
    const rect = canvas.getBoundingClientRect();
    const cx = (ev.clientX - rect.left) * (canvas.width / rect.width);
    const cy = (ev.clientY - rect.top) * (canvas.height / rect.height);
    const inst = pickInstance(cx, cy);
    if (inst && !ev.shiftKey) {
      ev.preventDefault();
      moveDrag = { instId: inst.id, origX: inst.worldX, origY: inst.worldY };
    }
  }
});
window.addEventListener("mousemove", (ev) => {
  if (!wallDrag && !moveDrag) return;
  if (wallDrag) paintWallEdgeAtClient(ev.clientX, ev.clientY, wallDrag.erase);
  if (moveDrag) {
    const rect = canvas.getBoundingClientRect();
    const cx = (ev.clientX - rect.left) * (canvas.width / rect.width);
    const cy = (ev.clientY - rect.top) * (canvas.height / rect.height);
    const tile = screenToTile(cx, cy, lotScene.camera, canvas);
    const N = lotScene.gridSize;
    if (tile.worldX < 0 || tile.worldY < 0 || tile.worldX >= N || tile.worldY >= N) return;
    const inst = lotInstances.find((i) => i.id === moveDrag!.instId);
    if (!inst) return;
    if (inst.worldX === tile.worldX && inst.worldY === tile.worldY) return;
    inst.worldX = tile.worldX;
    inst.worldY = tile.worldY;
    composeLotScene();
  }
});
window.addEventListener("mouseup", (ev) => {
  if (ev.button !== 0) return;
  wallDrag = null;
  if (strokeAnchor) {
    const t = tileFromClient(ev.clientX, ev.clientY);
    if (t) commitStroke(t.x, t.y);
    else {
      strokeAnchor = null;
      lotScene.strokeAnchorTile = null;
      composeLotScene();
    }
  }
  if (moveDrag) {
    const inst = lotInstances.find((i) => i.id === moveDrag!.instId);
    if (inst) {
      // Drop on tiles already occupied by another instance → revert. Uses the
      // full footprint so multi-tile objects can't drop onto a partial cover.
      if (!canPlaceFootprintAt(inst.obj, inst.worldX, inst.worldY, inst.id)) {
        inst.worldX = moveDrag.origX;
        inst.worldY = moveDrag.origY;
        composeLotScene();
      }
    }
    // Suppress the click event that follows mouseup so the placement handler
    // doesn't drop a duplicate on the destination tile.
    if (
      moveDrag &&
      lotInstances.some(
        (i) => i.id === moveDrag!.instId && (i.worldX !== moveDrag!.origX || i.worldY !== moveDrag!.origY),
      )
    ) {
      suppressNextLotClick = true;
    }
    moveDrag = null;
  }
});

// Middle-mouse drag pans the camera. We track the last cursor pos and convert
// pixel deltas to tile-space deltas via `rotatedPan` (already takes care of
// the inverse iso projection + camera rotation). `auxclick` would fire on
// release but we want continuous pan, so we use mousedown/move/up directly.
let panDrag: { lastX: number; lastY: number } | null = null;
canvas.addEventListener("mousedown", (ev) => {
  if (ev.button !== 1) return;
  ev.preventDefault();
  panDrag = { lastX: ev.clientX, lastY: ev.clientY };
});
window.addEventListener("mousemove", (ev) => {
  if (!panDrag) return;
  const dx = ev.clientX - panDrag.lastX;
  const dy = ev.clientY - panDrag.lastY;
  panDrag.lastX = ev.clientX;
  panDrag.lastY = ev.clientY;
  // Drag should *follow* the cursor (drag right → world scrolls right under
  // the cursor → camera centre moves left). Negate the delta and scale by
  // tileWidth so a 1-tile drag yields a 1-tile pan at any zoom.
  const tw = lotScene.camera.tileWidth;
  const [lx, ly] = rotatedPan(-dx / (tw / 2), -dy / (tw / 4));
  panCamera(lx, ly);
});
window.addEventListener("mouseup", (ev) => {
  if (ev.button === 1) panDrag = null;
});
canvas.addEventListener("auxclick", (ev) => {
  if (ev.button === 1) ev.preventDefault();
});

// Wheel zoom — wheel up = zoom in (closer), wheel down = zoom out. We swallow
// the page-scroll default whenever the cursor is over the lot canvas.
canvas.addEventListener(
  "wheel",
  (ev) => {
    ev.preventDefault();
    if (ev.deltaY < 0) setCameraZoom(cameraZoomIdx + 1);
    else if (ev.deltaY > 0) setCameraZoom(cameraZoomIdx - 1);
  },
  { passive: false },
);
canvas.addEventListener("mousemove", (ev) => {
  const rect = canvas.getBoundingClientRect();
  const cx = (ev.clientX - rect.left) * (canvas.width / rect.width);
  const cy = (ev.clientY - rect.top) * (canvas.height / rect.height);
  // Object hover tooltip — show name + price if cursor is over a placed
  // instance. Cheap because pickInstance is already O(N) and the tooltip is
  // a single DOM mutation.
  showInstanceTooltip(cx, cy, ev.clientX, ev.clientY);
  const tile = screenToTile(cx, cy, lotScene.camera, canvas);
  const N = lotScene.gridSize;
  const inBounds = tile.worldX >= 0 && tile.worldY >= 0 && tile.worldX < N && tile.worldY < N;
  let dirty = false;
  if (!inBounds) {
    if (lotScene.hoverTile) { lotScene.hoverTile = null; dirty = true; }
  } else if (
    !lotScene.hoverTile ||
    lotScene.hoverTile.worldX !== tile.worldX ||
    lotScene.hoverTile.worldY !== tile.worldY
  ) {
    lotScene.hoverTile = { worldX: tile.worldX, worldY: tile.worldY };
    dirty = true;
  }
  // Ghost wall preview when wall tool is active.
  const wantGhost = inBounds && lotMode === "build" && buildTool === "wall";
  const newGhost = wantGhost ? nearestEdge(tile.fx, tile.fy) : null;
  const oldGhost = lotScene.ghostWall ?? null;
  const ghostsDiffer =
    (newGhost === null) !== (oldGhost === null) ||
    (newGhost !== null && oldGhost !== null &&
      (newGhost.orientation !== oldGhost.orientation ||
        newGhost.x !== oldGhost.tileX ||
        newGhost.y !== oldGhost.tileY));
  if (ghostsDiffer) {
    lotScene.ghostWall = newGhost
      ? { orientation: newGhost.orientation, tileX: newGhost.x, tileY: newGhost.y }
      : null;
    dirty = true;
  }
  if (dirty) {
    // In buy mode the viewer-current sprite follows the cursor, so we have
    // to recompose (cheap — sprites are cached per instance) instead of just
    // re-rendering. Other modes only need the hover outline updated.
    if (lotMode === "buy" && buildTool === "place" && viewerState.current) {
      composeLotScene();
    } else {
      renderLot();
    }
  }
});
let instanceTooltipEl: HTMLDivElement | null = null;
function showInstanceTooltip(cx: number, cy: number, screenX: number, screenY: number): void {
  if (!instanceTooltipEl) {
    const el = document.createElement("div");
    el.id = "instance-tooltip";
    el.style.cssText =
      "position:fixed;display:none;z-index:120;background:rgba(20,28,40,.95);border:1px solid #345;border-radius:4px;padding:4px 8px;font:11px/1.4 ui-sans-serif,system-ui,sans-serif;color:#cde;pointer-events:none;white-space:nowrap;";
    document.body.appendChild(el);
    instanceTooltipEl = el;
  }
  const inst = pickInstance(cx, cy);
  if (!inst) {
    instanceTooltipEl.style.display = "none";
    return;
  }
  const tag = inst.obj.price > 0 ? `  ·  §${inst.obj.price}` : "";
  instanceTooltipEl.textContent = `${inst.obj.objectName}${tag}`;
  instanceTooltipEl.style.left = `${screenX + 14}px`;
  instanceTooltipEl.style.top = `${screenY + 14}px`;
  instanceTooltipEl.style.display = "block";
}

canvas.addEventListener("mouseleave", () => {
  if (instanceTooltipEl) instanceTooltipEl.style.display = "none";
  let dirty = false;
  if (lotScene.hoverTile) { lotScene.hoverTile = null; dirty = true; }
  if (lotScene.ghostWall) { lotScene.ghostWall = null; dirty = true; }
  if (dirty) {
    if (lotMode === "buy" && buildTool === "place" && viewerState.current) {
      composeLotScene();
    } else {
      renderLot();
    }
  }
});

// Right-click on a placed instance cycles through the 4 DGRP directions so
// the user can re-orient an object after it's been placed. The browser's own
// context menu is suppressed only when the right-click hits an instance.
canvas.addEventListener("contextmenu", (ev) => {
  // Right-click during a stroke (wall-line / wall-rect / paint-rect) cancels
  // it. Otherwise the anchor would leak and commit to whatever tile the next
  // left-click mouseup happens on.
  if (strokeAnchor) {
    ev.preventDefault();
    strokeAnchor = null;
    lotScene.strokeAnchorTile = null;
    composeLotScene();
    return;
  }
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
    const inst = lotInstances[idx]!;
    // Sell value = price minus initial depreciation (as if bought new and
    // sold immediately). Maxis later applies daily depreciation; we don't
    // track the in-lot age yet so this is the floor.
    const sellValue = Math.max(0, inst.obj.price - inst.obj.initialDepreciation);
    lotInstances.splice(idx, 1);
    if (selectedInstanceId === instanceId) selectedInstanceId = null;
    if (sellValue > 0) {
      adjustFunds(sellValue);
      showBubble(`+§${sellValue} sold ${inst.obj.objectName}`);
    }
    composeLotScene();
    closeInteractionMenuImpl();
  }
}

function clearLot(): void {
  lotInstances.length = 0;
  wallsN.clear();
  wallsW.clear();
  doorsN.clear();
  doorsW.clear();
  windowsN.clear();
  windowsW.clear();
  selectedInstanceId = null;
  composeLotScene();
  closeInteractionMenuImpl();
}

let templateCache: TemplateEntry[] | null = null;

async function mountTemplatePicker(buildBar: HTMLElement): Promise<void> {
  const sel = buildBar.querySelector<HTMLSelectElement>("select[data-template-picker]");
  if (!sel) return;
  try {
    if (!templateCache) templateCache = await fetchTemplates();
    sel.innerHTML = "";
    if (templateCache.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "(none found)";
      sel.appendChild(opt);
      sel.disabled = true;
      return;
    }
    for (const t of templateCache) {
      const opt = document.createElement("option");
      opt.value = t.path;
      opt.textContent = t.name;
      sel.appendChild(opt);
    }
  } catch (err) {
    sel.innerHTML = "";
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = `(error: ${err instanceof Error ? err.message : "?"})`;
    sel.appendChild(opt);
    sel.disabled = true;
  }
}

/** Path of the currently-loaded House.iff, so the active save knows which
 *  lot to point to on reload. Null = the user's hand-built lot (no template). */
let currentLotPath: string | null = null;

async function loadAndApplyHouse(path: string, buildBar: HTMLElement): Promise<void> {
  const statusEl = buildBar.querySelector<HTMLSpanElement>("span[data-house-status]");
  if (statusEl) {
    statusEl.style.color = "#cde";
    statusEl.textContent = "loading…";
  }
  try {
    const loaded = await loadHouseTemplate(path, lotScene.gridSize);
    floorPaint.clear();
    for (const [k, v] of loaded.floorPaint) floorPaint.set(k, v);
    wallsN.clear();
    for (const k of loaded.wallsN) wallsN.add(k);
    wallsW.clear();
    for (const k of loaded.wallsW) wallsW.add(k);
    // Doors/windows live in custom-edit sets and shouldn't carry over from a
    // previous house, but we never imported them — just wipe.
    doorsN.clear();
    doorsW.clear();
    windowsN.clear();
    windowsW.clear();
    currentLotPath = path;
    composeLotScene();
    if (statusEl) {
      statusEl.style.color = "#9bd09b";
      statusEl.textContent =
        `“${loaded.name}” · ${loaded.stats.floorPaintedTiles} tiles · ` +
        `${loaded.stats.walls} walls · ${loaded.stats.floorPaletteEntries} mats`;
    }
    console.info(
      `[house] loaded "${loaded.name}" — ${loaded.stats.floorPaintedTiles} painted, ${loaded.stats.walls} walls, palette:`,
      loaded.floorPalette,
    );
  } catch (err) {
    if (statusEl) {
      statusEl.style.color = "#d8a13a";
      statusEl.textContent = `error: ${err instanceof Error ? err.message : "?"}`;
    }
    console.error("[house] load failed", err);
  }
}

// ============================================================================
// Neighborhood modal — picks one of the 10 Magictown lots and "moves" the
// family in. The Sim list and motives carry over; placed instances are wiped
// (TS1 wouldn't physically port your sofas either when you moved house).
// ============================================================================

let neighborhoodCache: NeighborhoodLot[] | null = null;
let neighborhoodModalEl: HTMLDivElement | null = null;

async function openNeighborhoodModal(): Promise<void> {
  if (neighborhoodModalEl) return;
  const overlay = document.createElement("div");
  overlay.id = "neighborhood-modal";
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:1000;display:flex;align-items:center;justify-content:center;font:13px/1.4 ui-sans-serif,system-ui,sans-serif;color:#cde;";
  const panel = document.createElement("div");
  panel.style.cssText =
    "background:#181c24;border:1px solid #345;border-radius:8px;padding:18px 22px;width:640px;max-width:94vw;max-height:88vh;overflow:auto;display:flex;flex-direction:column;gap:12px;box-shadow:0 8px 32px rgba(0,0,0,.5);";
  panel.innerHTML = `
    <div style="font-size:15px;color:#9ad;font-weight:600;display:flex;align-items:center;gap:10px;">
      <span>Neighborhood — Magic Town</span>
      <span data-nb-current style="opacity:.6;font-size:12px;font-weight:normal;"></span>
    </div>
    <div data-nb-grid style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;"></div>
    <div data-nb-status style="opacity:.6;font-size:11px;min-height:1em;"></div>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:4px;">
      <button data-nb-close style="background:#222;color:#cde;border:1px solid #345;font:inherit;padding:6px 14px;border-radius:3px;cursor:pointer;">Close</button>
    </div>
  `;
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  neighborhoodModalEl = overlay;

  const close = (): void => {
    overlay.remove();
    neighborhoodModalEl = null;
  };
  panel.querySelector<HTMLButtonElement>("button[data-nb-close]")!.addEventListener("click", close);
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) close();
  });

  const grid = panel.querySelector<HTMLDivElement>("div[data-nb-grid]")!;
  const status = panel.querySelector<HTMLDivElement>("div[data-nb-status]")!;
  const current = panel.querySelector<HTMLSpanElement>("span[data-nb-current]")!;
  current.textContent = currentLotPath ? `· current: ${currentLotPath.split("/").pop()}` : "";

  grid.innerHTML = "<div style='opacity:.6;'>loading lots…</div>";
  try {
    if (!neighborhoodCache) neighborhoodCache = await fetchNeighborhoodMap();
    grid.innerHTML = "";
    for (const lot of neighborhoodCache) {
      const tile = document.createElement("button");
      const isCurrent = lot.path === currentLotPath;
      tile.style.cssText =
        `background:${isCurrent ? "rgba(120,170,230,.18)" : "#111"};color:#cde;border:1px solid ${isCurrent ? "#69f" : "#345"};` +
        `border-radius:4px;padding:10px;display:flex;flex-direction:column;gap:6px;cursor:pointer;font:inherit;text-align:left;` +
        `transition:transform .1s;`;
      tile.addEventListener("mouseenter", () => (tile.style.transform = "scale(1.03)"));
      tile.addEventListener("mouseleave", () => (tile.style.transform = "scale(1)"));
      tile.title = `${lot.path}\n${(lot.size / 1024).toFixed(1)} KiB`;
      // ASCII isometric house icon — cheap, no asset needed.
      tile.innerHTML = `
        <div style="font-family:ui-monospace,monospace;font-size:13px;color:${isCurrent ? "#9be08a" : "#9ad"};text-align:center;line-height:1.05;">
          <pre style="margin:0;">▟▙
██</pre>
        </div>
        <div style="font-weight:600;font-size:12px;">${escapeHtml(lot.name)}</div>
        <div style="opacity:.55;font-size:10px;">${escapeHtml(lot.path.split("/").slice(-2).join("/"))}</div>
      `;
      tile.addEventListener("click", async () => {
        if (lot.path === currentLotPath) {
          status.textContent = `${lot.name} is already the active lot.`;
          status.style.color = "#9ad";
          return;
        }
        const ok = confirm(
          `Move family (${sims.length} Sim${sims.length === 1 ? "" : "s"}) into "${lot.name}"?\n` +
            `The current house contents (furniture/walls) will be replaced.`,
        );
        if (!ok) return;
        status.textContent = "moving family…";
        status.style.color = "#cde";
        try {
          // Wipe placed instances — the new lot's geometry takes over.
          lotInstances.length = 0;
          // loadAndApplyHouse will wipe walls/floor/doors/windows and set
          // currentLotPath. The Sim list survives.
          const buildBar =
            document.getElementById("build-tools") ?? document.createElement("div");
          await loadAndApplyHouse(lot.path, buildBar);
          // Re-spawn each Sim at a fresh empty tile so they don't end up
          // inside a wall in the new lot.
          for (const sim of sims) {
            const { x, y } = findEmptyLotTile();
            sim.fx = x;
            sim.fy = y;
            sim.walk = null;
            sim.onArrive = null;
          }
          composeLotScene();
          status.textContent = `moved in: ${lot.name}.`;
          status.style.color = "#9bd09b";
          current.textContent = `· current: ${lot.path.split("/").pop()}`;
          // Refresh tile highlights.
          for (const t of grid.querySelectorAll<HTMLButtonElement>("button")) {
            t.style.background = "#111";
            t.style.borderColor = "#345";
          }
          tile.style.background = "rgba(120,170,230,.18)";
          tile.style.borderColor = "#69f";
        } catch (err) {
          status.textContent = `error: ${err instanceof Error ? err.message : "?"}`;
          status.style.color = "#d8a13a";
        }
      });
      grid.appendChild(tile);
    }
  } catch (err) {
    grid.innerHTML = `<div style='color:#d8a13a;'>error: ${escapeHtml(err instanceof Error ? err.message : "?")}</div>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

interface CasInput {
  name: string;
  gender: "F" | "M";
  age: "Child" | "Adult" | "Elder";
  bio: string;
  traits: Traits;
  headColor: string;
  bodyColor: string;
}

function findEmptyLotTile(): { x: number; y: number } {
  const N = lotScene.gridSize;
  for (let iy = 1; iy < N - 1; iy += 1) {
    for (let ix = 1; ix < N - 1; ix += 1) {
      const occupiedByObj = lotInstances.some((i) => i.worldX === ix && i.worldY === iy);
      const occupiedBySim = sims.some((s) => Math.round(s.fx) === ix && Math.round(s.fy) === iy);
      if (!occupiedByObj && !occupiedBySim) return { x: ix, y: iy };
    }
  }
  return { x: 4, y: 4 };
}

/** Add a Sim using the palette defaults (legacy quick-spawn). */
function spawnSim(): void {
  const idx = sims.length;
  const palette = SIM_PALETTE[idx % SIM_PALETTE.length]!;
  addSimFromCas({
    name: palette.name,
    gender: idx % 2 === 0 ? "F" : "M",
    age: "Adult",
    bio: `Auto-spawned via "+Sim" button.`,
    traits: defaultTraits(),
    headColor: palette.color,
    bodyColor: palette.body,
  });
}

/** Add a Sim from the Create-A-Sim form. Returns the new Sim's index. */
function addSimFromCas(cas: CasInput): number {
  const { x, y } = findEmptyLotTile();
  const idx = sims.length;
  sims.push({
    id: allocSimId(),
    name: cas.name,
    gender: cas.gender,
    age: cas.age,
    bio: cas.bio,
    traits: cas.traits,
    headColor: cas.headColor,
    bodyColor: cas.bodyColor,
    fx: x,
    fy: y,
    walk: null,
    onArrive: null,
    bubble: null,
    motives: defaultMotives(),
    facing: 3,
    sleeping: false,
  });
  selectedSimIdx = idx;
  renderMotivesHud();
  renderFamilyHud();
  composeLotScene();
  return idx;
}

// ============================================================================
// Family HUD — lists the lot's Sims with avatars, lets the user switch the
// selected Sim and open Create-A-Sim. Mounted left side, under the motives HUD.
// ============================================================================

const TRAIT_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["Sloppy", "Neat"],
  ["Shy", "Outgoing"],
  ["Lazy", "Active"],
  ["Serious", "Playful"],
  ["Grouchy", "Nice"],
];

let familyHudEl: HTMLDivElement | null = null;
function ensureFamilyHud(): HTMLDivElement {
  const slot = document.querySelector<HTMLDivElement>("#ts1-panel [data-slot-body='family']");
  if (familyHudEl?.isConnected && familyHudEl.parentElement === (slot ?? document.body)) {
    return familyHudEl;
  }
  const el = familyHudEl ?? document.createElement("div");
  el.id = "family-hud";
  if (slot) {
    el.style.cssText = "display:flex;flex-direction:column;gap:4px;font:11px/1.35 ui-sans-serif,system-ui,sans-serif;color:#cde;";
    slot.appendChild(el);
  } else {
    el.style.cssText =
      "position:fixed;top:240px;left:8px;width:200px;background:linear-gradient(180deg,#1a2840 0%,#0f1a2d 100%);border:1px solid #3a4a66;box-shadow:0 2px 8px rgba(0,0,0,.4);padding:8px 10px;border-radius:6px;font:11px/1.4 ui-sans-serif,system-ui,sans-serif;color:#cde;display:flex;flex-direction:column;gap:4px;";
    document.body.appendChild(el);
  }
  familyHudEl = el;
  return el;
}

function renderFamilyHud(): void {
  const root = ensureFamilyHud();
  // Authentic TS1 LiveGadget: a single big portrait + the active Sim's name,
  // with the rest of the household as small clickable swatches underneath.
  // CAS / Neighborhood / Remove live in the Options modal (right-side patch).
  root.innerHTML = "";
  const sim = sims[selectedSimIdx];
  if (!sim) return;
  const mood = computeMood(sim);
  // Top: portrait disc with mood-coloured halo.
  const portrait = document.createElement("button");
  portrait.dataset["familyPortrait"] = "1";
  portrait.title = `${sim.name} — click to cycle to next Sim`;
  portrait.style.cssText = [
    "width:46px",
    "height:46px",
    "border-radius:50%",
    `background:${sim.headColor}`,
    `border:3px solid ${moodColor(mood)}`,
    "box-shadow:0 0 6px rgba(0,0,0,0.4),inset 0 -6px 8px rgba(0,0,0,0.25)",
    "position:relative",
    "padding:0",
    "cursor:pointer",
    "flex-shrink:0",
  ].join(";");
  // Tiny body dot under the head — mirrors the headColor/bodyColor split used
  // elsewhere in the renderer.
  const body = document.createElement("span");
  body.style.cssText = `position:absolute;bottom:-3px;left:50%;transform:translateX(-50%);width:24px;height:10px;background:${sim.bodyColor};border-radius:0 0 6px 6px;`;
  portrait.appendChild(body);
  portrait.addEventListener("click", () => {
    if (sims.length < 2) return;
    selectedSimIdx = (selectedSimIdx + 1) % sims.length;
    renderMotivesHud();
    renderFamilyHud();
    if (lotMode === "play") renderTs1CenterSlot();
    composeLotScene();
  });
  root.appendChild(portrait);
  // Name in the iconic TS1 yellow, fitted under the portrait.
  const name = document.createElement("div");
  name.textContent = sim.name;
  name.style.cssText =
    "color:#ffdf80;font:bold 10px/1.1 \"MS Sans Serif\",sans-serif;text-align:center;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-shadow:0 1px 0 rgba(0,0,0,0.5);";
  root.appendChild(name);
  // Mini swatches for the other household members.
  if (sims.length > 1) {
    const swatches = document.createElement("div");
    swatches.style.cssText =
      "display:flex;gap:2px;justify-content:center;flex-wrap:wrap;max-width:100%;margin-top:1px;";
    for (let i = 0; i < sims.length; i += 1) {
      if (i === selectedSimIdx) continue;
      const other = sims[i]!;
      const dot = document.createElement("button");
      dot.title = other.name;
      dot.style.cssText = [
        "width:11px",
        "height:11px",
        "border-radius:50%",
        `background:${other.headColor}`,
        "border:1px solid rgba(0,0,0,0.4)",
        "padding:0",
        "cursor:pointer",
      ].join(";");
      dot.addEventListener("click", () => {
        selectedSimIdx = i;
        renderMotivesHud();
        renderFamilyHud();
        if (lotMode === "play") renderTs1CenterSlot();
        composeLotScene();
      });
      swatches.appendChild(dot);
    }
    if (swatches.childElementCount > 0) root.appendChild(swatches);
  }
}

function removeSelectedSim(): void {
  if (sims.length <= 1) return;
  sims.splice(selectedSimIdx, 1);
  selectedSimIdx = Math.max(0, Math.min(sims.length - 1, selectedSimIdx));
  renderMotivesHud();
  renderFamilyHud();
  composeLotScene();
}

// ============================================================================
// Create-A-Sim modal — full form with name/gender/age/traits/bio + colors.
// Resolves on submit; cancel closes without adding.
// ============================================================================

const CAS_HEAD_PRESETS = [
  "#f0c8a8",
  "#d8a982",
  "#b0825a",
  "#7a543a",
  "#4e3624",
  "#7ab8ff",
  "#cf6dd1",
  "#5fb86b",
] as const;

const CAS_BODY_PRESETS = [
  "#3a78c0",
  "#9a6a1e",
  "#8a3f8c",
  "#3a8048",
  "#9a3520",
  "#444",
  "#cdb",
  "#ddd",
] as const;

let casModalEl: HTMLDivElement | null = null;

function openCasModal(): void {
  if (casModalEl) return;
  const draft: CasInput = {
    name: `Sim ${sims.length + 1}`,
    gender: sims.length % 2 === 0 ? "F" : "M",
    age: "Adult",
    bio: "",
    traits: defaultTraits(),
    headColor: CAS_HEAD_PRESETS[0]!,
    bodyColor: CAS_BODY_PRESETS[0]!,
  };
  const overlay = document.createElement("div");
  overlay.id = "cas-modal";
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:1000;display:flex;align-items:center;justify-content:center;font:13px/1.4 ui-sans-serif,system-ui,sans-serif;color:#cde;";
  const panel = document.createElement("div");
  panel.style.cssText =
    "background:#181c24;border:1px solid #345;border-radius:8px;padding:18px 22px;width:420px;max-width:92vw;max-height:88vh;overflow:auto;display:flex;flex-direction:column;gap:10px;box-shadow:0 8px 32px rgba(0,0,0,.5);";

  panel.innerHTML = `
    <div style="font-size:15px;color:#9ad;font-weight:600;">Create-A-Sim</div>
    <label style="display:grid;grid-template-columns:80px 1fr;gap:8px;align-items:center;">
      <span style="opacity:.8;">Name</span>
      <input data-cas-name type="text" maxlength="32" style="background:#111;color:#cde;border:1px solid #345;font:inherit;padding:4px 6px;border-radius:3px;" />
    </label>
    <div style="display:grid;grid-template-columns:80px 1fr;gap:8px;align-items:center;">
      <span style="opacity:.8;">Gender</span>
      <div data-cas-gender style="display:flex;gap:6px;"></div>
    </div>
    <div style="display:grid;grid-template-columns:80px 1fr;gap:8px;align-items:center;">
      <span style="opacity:.8;">Age</span>
      <div data-cas-age style="display:flex;gap:6px;"></div>
    </div>
    <div style="display:grid;grid-template-columns:80px 1fr;gap:8px;align-items:center;">
      <span style="opacity:.8;">Skin</span>
      <div data-cas-head style="display:flex;gap:5px;flex-wrap:wrap;"></div>
    </div>
    <div style="display:grid;grid-template-columns:80px 1fr;gap:8px;align-items:center;">
      <span style="opacity:.8;">Outfit</span>
      <div data-cas-body style="display:flex;gap:5px;flex-wrap:wrap;"></div>
    </div>
    <div style="margin-top:4px;border-top:1px solid #2a3144;padding-top:8px;">
      <div style="opacity:.8;margin-bottom:6px;">Personality <span data-cas-points style="opacity:.6;float:right;font-variant-numeric:tabular-nums;"></span></div>
      <div data-cas-traits style="display:flex;flex-direction:column;gap:4px;"></div>
    </div>
    <label style="display:grid;grid-template-columns:80px 1fr;gap:8px;align-items:start;">
      <span style="opacity:.8;padding-top:4px;">Bio</span>
      <textarea data-cas-bio rows="2" maxlength="240" style="background:#111;color:#cde;border:1px solid #345;font:inherit;padding:4px 6px;border-radius:3px;resize:vertical;"></textarea>
    </label>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:6px;">
      <button data-cas-cancel style="background:#222;color:#cde;border:1px solid #345;font:inherit;padding:6px 14px;border-radius:3px;cursor:pointer;">Cancel</button>
      <button data-cas-submit style="background:#3b6;color:#000;border:1px solid #2a4;font:inherit;padding:6px 14px;border-radius:3px;cursor:pointer;font-weight:600;">Add to family</button>
    </div>
  `;
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  casModalEl = overlay;

  const nameInput = panel.querySelector<HTMLInputElement>("input[data-cas-name]")!;
  const bioInput = panel.querySelector<HTMLTextAreaElement>("textarea[data-cas-bio]")!;
  const genderHost = panel.querySelector<HTMLDivElement>("div[data-cas-gender]")!;
  const ageHost = panel.querySelector<HTMLDivElement>("div[data-cas-age]")!;
  const headHost = panel.querySelector<HTMLDivElement>("div[data-cas-head]")!;
  const bodyHost = panel.querySelector<HTMLDivElement>("div[data-cas-body]")!;
  const traitsHost = panel.querySelector<HTMLDivElement>("div[data-cas-traits]")!;
  const pointsEl = panel.querySelector<HTMLSpanElement>("span[data-cas-points]")!;

  nameInput.value = draft.name;
  bioInput.value = draft.bio;
  nameInput.addEventListener("input", () => (draft.name = nameInput.value.trim() || "Sim"));
  bioInput.addEventListener("input", () => (draft.bio = bioInput.value));

  const segButton = (label: string, active: boolean): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.style.cssText =
      `background:${active ? "rgba(120,170,230,.18)" : "#111"};color:#cde;border:1px solid ${active ? "#69f" : "#345"};font:inherit;padding:4px 10px;border-radius:3px;cursor:pointer;`;
    return b;
  };

  const refreshGender = (): void => {
    genderHost.innerHTML = "";
    for (const g of ["F", "M"] as const) {
      const b = segButton(g === "F" ? "Female" : "Male", draft.gender === g);
      b.addEventListener("click", () => {
        draft.gender = g;
        refreshGender();
      });
      genderHost.appendChild(b);
    }
  };
  const refreshAge = (): void => {
    ageHost.innerHTML = "";
    for (const a of ["Child", "Adult", "Elder"] as const) {
      const b = segButton(a, draft.age === a);
      b.addEventListener("click", () => {
        draft.age = a;
        refreshAge();
      });
      ageHost.appendChild(b);
    }
  };
  const refreshSwatches = (host: HTMLDivElement, options: readonly string[], key: "headColor" | "bodyColor"): void => {
    host.innerHTML = "";
    for (const c of options) {
      const s = document.createElement("button");
      s.type = "button";
      const active = draft[key] === c;
      s.style.cssText =
        `width:22px;height:22px;border-radius:50%;background:${c};border:2px solid ${active ? "#fff" : "rgba(255,255,255,.2)"};cursor:pointer;padding:0;`;
      s.addEventListener("click", () => {
        draft[key] = c;
        refreshSwatches(host, options, key);
      });
      host.appendChild(s);
    }
  };

  const refreshTraits = (): void => {
    traitsHost.innerHTML = "";
    for (let i = 0; i < TRAIT_PAIRS.length; i += 1) {
      const [low, high] = TRAIT_PAIRS[i]!;
      const row = document.createElement("div");
      row.style.cssText = "display:grid;grid-template-columns:62px 1fr 62px 38px;gap:6px;align-items:center;";
      const lowEl = document.createElement("span");
      lowEl.textContent = low;
      lowEl.style.cssText = "opacity:.7;text-align:right;font-size:11px;";
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = "0";
      slider.max = "10";
      slider.step = "1";
      slider.value = String(draft.traits[i] ?? 5);
      slider.style.cssText = "width:100%;";
      const highEl = document.createElement("span");
      highEl.textContent = high;
      highEl.style.cssText = "opacity:.7;font-size:11px;";
      const valEl = document.createElement("span");
      valEl.textContent = slider.value;
      valEl.style.cssText = "text-align:center;font-variant-numeric:tabular-nums;opacity:.85;";
      slider.addEventListener("input", () => {
        const arr = [...draft.traits] as [number, number, number, number, number];
        arr[i] = Number(slider.value);
        draft.traits = arr as unknown as Traits;
        valEl.textContent = slider.value;
        refreshPoints();
      });
      row.append(lowEl, slider, highEl, valEl);
      traitsHost.appendChild(row);
    }
  };
  const refreshPoints = (): void => {
    const sum = draft.traits.reduce((a, b) => a + b, 0);
    const submitBtn = panel.querySelector<HTMLButtonElement>("button[data-cas-submit]");
    if (sum > 25) {
      pointsEl.textContent = `Σ ${sum} (over budget — max 25)`;
      pointsEl.style.color = "#d8533a";
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.style.opacity = "0.4";
        submitBtn.style.cursor = "not-allowed";
      }
    } else {
      const remaining = 25 - sum;
      pointsEl.textContent = `Σ ${sum} / 25${remaining > 0 ? ` · ${remaining} left` : " · maxed"}`;
      pointsEl.style.color = sum < 15 ? "#d8a13a" : "#5fb86b";
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.style.opacity = "1";
        submitBtn.style.cursor = "pointer";
      }
    }
  };

  refreshGender();
  refreshAge();
  refreshSwatches(headHost, CAS_HEAD_PRESETS, "headColor");
  refreshSwatches(bodyHost, CAS_BODY_PRESETS, "bodyColor");
  refreshTraits();
  refreshPoints();

  const close = (): void => {
    overlay.remove();
    casModalEl = null;
  };
  panel.querySelector<HTMLButtonElement>("button[data-cas-cancel]")!.addEventListener("click", close);
  panel.querySelector<HTMLButtonElement>("button[data-cas-submit]")!.addEventListener("click", () => {
    // Belt-and-suspenders: re-check the budget here in case a handler bypassed
    // the disabled state via the keyboard or accessibility tools.
    const sum = draft.traits.reduce((a, b) => a + b, 0);
    if (sum > 25) return;
    addSimFromCas(draft);
    close();
  });
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) close();
  });
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") {
      close();
      window.removeEventListener("keydown", onKey, true);
    }
  };
  window.addEventListener("keydown", onKey, true);
  nameInput.focus();
}

// ============================================================================
// Options modal — bundled "Options" tab on the bottom bar. Save / Save As /
// Load list / Delete save / Reset lot / Help / Debug. Wired up via
// optionsModalHook so the bottom-bar handler (defined earlier in the file)
// can call it without a forward reference.
// ============================================================================

let optionsModalEl: HTMLDivElement | null = null;

function openOptionsModalImpl(): void {
  if (optionsModalEl) return;
  const overlay = document.createElement("div");
  overlay.id = "options-modal";
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:1000;display:flex;align-items:center;justify-content:center;font:13px/1.4 ui-sans-serif,system-ui,sans-serif;color:#cde;";
  const panel = document.createElement("div");
  panel.style.cssText =
    "background:linear-gradient(180deg,#1a2230 0%,#0f1620 100%);border:1px solid #3a4a66;border-radius:10px;padding:18px 22px;width:520px;max-width:94vw;max-height:88vh;overflow:auto;display:flex;flex-direction:column;gap:14px;box-shadow:0 8px 32px rgba(0,0,0,.5);";
  panel.innerHTML = `
    <div style="font-size:15px;color:#d9b76a;font-weight:600;display:flex;align-items:center;gap:10px;">
      <span style="font-size:18px;">⚙</span><span>Options</span>
    </div>
    <section data-section="saves" style="display:flex;flex-direction:column;gap:8px;">
      <div style="color:#9ad;font-weight:600;font-size:12px;letter-spacing:.05em;text-transform:uppercase;">Game</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button data-opt="save" style="flex:1;min-width:120px;background:#3b6;color:#000;border:1px solid #2a4;font:inherit;padding:7px 10px;cursor:pointer;border-radius:4px;font-weight:600;">💾 Save</button>
        <button data-opt="saveas" style="flex:1;min-width:120px;background:#3a78c0;color:#fff;border:1px solid #2a4d7a;font:inherit;padding:7px 10px;cursor:pointer;border-radius:4px;font-weight:600;">💾 Save As…</button>
      </div>
      <div data-options-saves-list style="display:flex;flex-direction:column;gap:4px;max-height:240px;overflow-y:auto;padding:4px;background:rgba(0,0,0,.25);border:1px solid #2a3a52;border-radius:4px;"></div>
    </section>
    <section style="display:flex;flex-direction:column;gap:8px;">
      <div style="color:#9ad;font-weight:600;font-size:12px;letter-spacing:.05em;text-transform:uppercase;">Lot</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button data-opt="neighborhood" style="flex:1;min-width:130px;background:#2a3a52;color:#cde;border:1px solid #3a4a66;font:inherit;padding:7px 10px;cursor:pointer;border-radius:4px;">🌳 Neighborhood…</button>
        <button data-opt="cas" style="flex:1;min-width:130px;background:#2a3a52;color:#cde;border:1px solid #3a4a66;font:inherit;padding:7px 10px;cursor:pointer;border-radius:4px;">👤 New Sim…</button>
        <button data-opt="reset" style="flex:1;min-width:130px;background:#3a2a2a;color:#d88;border:1px solid #533;font:inherit;padding:7px 10px;cursor:pointer;border-radius:4px;">🗑 Reset Lot</button>
      </div>
    </section>
    <section style="display:flex;flex-direction:column;gap:8px;">
      <div style="color:#9ad;font-weight:600;font-size:12px;letter-spacing:.05em;text-transform:uppercase;">Help & Debug</div>
      <div style="background:rgba(0,0,0,.25);border:1px solid #2a3a52;border-radius:4px;padding:8px 10px;font:11px/1.55 ui-monospace,monospace;color:#9bb;">
        <b style="color:#cde;">Hotkeys</b> · Space pause · 1/2/3 speed · Q/E rotate · +/- zoom · ↑↓←→ pan · R recenter · F9 debug · Esc close
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button data-opt="debug" style="flex:1;min-width:130px;background:#2a3a52;color:#cde;border:1px solid #3a4a66;font:inherit;padding:7px 10px;cursor:pointer;border-radius:4px;">🔧 Toggle Debug Panels</button>
      </div>
    </section>
    <div style="display:flex;justify-content:flex-end;gap:8px;border-top:1px solid #2a3a52;padding-top:12px;">
      <button data-opt="close" style="background:#3a78c0;color:#fff;border:1px solid #2a4d7a;font:inherit;padding:7px 18px;cursor:pointer;border-radius:4px;font-weight:600;">Close</button>
    </div>
  `;
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  optionsModalEl = overlay;

  const close = (): void => {
    overlay.remove();
    optionsModalEl = null;
    window.removeEventListener("keydown", onKey, true);
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") close();
  };
  window.addEventListener("keydown", onKey, true);
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) close();
  });

  // Action wiring.
  panel.querySelector<HTMLButtonElement>("button[data-opt=\"save\"]")?.addEventListener("click", () => {
    void saveLot();
  });
  panel.querySelector<HTMLButtonElement>("button[data-opt=\"saveas\"]")?.addEventListener("click", () => {
    const name = prompt("Save name:", activeSaveName === "Current Lot" ? "My Lot" : activeSaveName);
    if (name && name.trim()) void saveLotAs(name.trim());
  });
  panel.querySelector<HTMLButtonElement>("button[data-opt=\"neighborhood\"]")?.addEventListener("click", () => {
    close();
    void openNeighborhoodModal();
  });
  panel.querySelector<HTMLButtonElement>("button[data-opt=\"cas\"]")?.addEventListener("click", () => {
    close();
    openCasModal();
  });
  panel.querySelector<HTMLButtonElement>("button[data-opt=\"reset\"]")?.addEventListener("click", () => {
    if (confirm("Reset the lot? All placed objects, walls, and floors will be erased.")) {
      clearLot();
      close();
    }
  });
  panel.querySelector<HTMLButtonElement>("button[data-opt=\"debug\"]")?.addEventListener("click", () => {
    setDebugMode(!document.body.classList.contains("debug-mode"));
  });
  panel.querySelector<HTMLButtonElement>("button[data-opt=\"close\"]")?.addEventListener("click", close);

  // Populate saves list.
  void renderOptionsSavesList(panel);
}

async function renderOptionsSavesList(panel: HTMLElement): Promise<void> {
  const list = panel.querySelector<HTMLDivElement>("div[data-options-saves-list]");
  if (!list) return;
  list.innerHTML = "<div style=\"opacity:.5;font-style:italic;padding:6px;\">Loading saves…</div>";
  let descriptors: SaveDescriptor[];
  try {
    descriptors = await listSaves();
  } catch {
    descriptors = [];
  }
  list.innerHTML = "";
  if (descriptors.length === 0) {
    const empty = document.createElement("div");
    empty.textContent = "No saves yet — use Save As to create one.";
    empty.style.cssText = "opacity:.5;font-style:italic;padding:6px;";
    list.appendChild(empty);
    return;
  }
  for (const d of descriptors) {
    const row = document.createElement("div");
    const isActive = d.id === activeSaveId;
    row.style.cssText =
      `display:grid;grid-template-columns:1fr auto auto;gap:6px;align-items:center;padding:6px 8px;` +
      `background:${isActive ? "rgba(120,170,230,.18)" : "rgba(255,255,255,.03)"};border:1px solid ${isActive ? "#69f" : "transparent"};border-radius:3px;`;
    const label = document.createElement("button");
    label.style.cssText =
      "background:transparent;border:none;color:#cde;font:inherit;text-align:left;cursor:pointer;padding:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    const srcTag = d.source === "both" ? "↕" : d.source === "local" ? "L" : "S";
    label.innerHTML = `<strong>${escapeHtml(d.name)}</strong> <span style="opacity:.5;">${srcTag}</span><br><span style="opacity:.5;font-size:10px;">${timeAgo(d.updatedAt)} · ${(d.size / 1024).toFixed(1)} KiB</span>`;
    label.title = `${d.id} — ${d.source}`;
    label.addEventListener("click", () => {
      void loadLot(true, d.id).then(() => {
        // Refresh active highlight inside the modal.
        if (optionsModalEl) void renderOptionsSavesList(optionsModalEl);
      });
    });
    const del = document.createElement("button");
    del.textContent = "✕";
    del.title = "Delete this save";
    del.style.cssText =
      "background:#222;color:#d88;border:1px solid #533;font:inherit;padding:2px 8px;cursor:pointer;border-radius:3px;line-height:1.2;";
    del.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (!confirm(`Delete save "${d.name}"?`)) return;
      await deleteSave(d.id);
      if (d.id === activeSaveId) {
        activeSaveId = LOT_SAVE_ID;
        activeSaveName = "Current Lot";
      }
      void renderSavesHud();
      if (optionsModalEl) void renderOptionsSavesList(optionsModalEl);
    });
    row.append(label, del);
    list.appendChild(row);
  }
}

// Install the hook so the bottom-bar's Options button reaches us.
optionsModalHook.open = openOptionsModalImpl;

// ============================================================================
// Saves panel — lists local + server saves, lets the user Save / Save As /
// Load / Delete and shows which save is currently active.
// ============================================================================

let savesHudEl: HTMLDivElement | null = null;

function ensureSavesHud(): HTMLDivElement {
  // The saves list moved into the Options modal — keep a detached div so the
  // existing renderSavesHud() call sites stay valid but nothing shows on the
  // viewport. The modal opens its own copy via renderOptionsSavesList().
  if (savesHudEl) return savesHudEl;
  const el = document.createElement("div");
  el.id = "saves-hud";
  el.style.display = "none";
  savesHudEl = el;
  return el;
}

function timeAgo(ts: number): string {
  if (!ts) return "—";
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

let savesRenderToken = 0;
async function renderSavesHud(): Promise<void> {
  const root = ensureSavesHud();
  const myToken = ++savesRenderToken;
  // Render the static frame immediately so the panel never blinks.
  if (root.childElementCount === 0) {
    root.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;">
        <span style="color:#9ad;font-weight:600;">Saves</span>
        <span data-saves-active style="opacity:.6;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;"></span>
      </div>
      <div style="display:flex;gap:4px;">
        <button data-saves-save style="flex:1;background:#3b6;color:#000;border:1px solid #444;font:inherit;padding:3px 6px;cursor:pointer;border-radius:2px;">Save</button>
        <button data-saves-saveas style="flex:1;background:#3a78c0;color:#fff;border:1px solid #444;font:inherit;padding:3px 6px;cursor:pointer;border-radius:2px;">Save As…</button>
      </div>
      <div data-saves-list style="overflow-y:auto;display:flex;flex-direction:column;gap:3px;max-height:30vh;"></div>
    `;
    root.querySelector<HTMLButtonElement>("button[data-saves-save]")!.addEventListener("click", () => void saveLot());
    root.querySelector<HTMLButtonElement>("button[data-saves-saveas]")!.addEventListener("click", () => {
      const name = prompt("Save name:", activeSaveName === "Current Lot" ? "My Lot" : activeSaveName);
      if (name && name.trim()) void saveLotAs(name.trim());
    });
  }
  const activeLabel = root.querySelector<HTMLSpanElement>("span[data-saves-active]");
  if (activeLabel) activeLabel.textContent = `${activeSaveName} (${activeSaveId})`;
  const list = root.querySelector<HTMLDivElement>("div[data-saves-list]");
  if (!list) return;
  let descriptors: SaveDescriptor[];
  try {
    descriptors = await listSaves();
  } catch {
    descriptors = [];
  }
  if (myToken !== savesRenderToken) return; // newer render took over
  list.innerHTML = "";
  if (descriptors.length === 0) {
    const empty = document.createElement("div");
    empty.textContent = "no saves yet";
    empty.style.cssText = "opacity:.5;font-style:italic;padding:4px 2px;";
    list.appendChild(empty);
    return;
  }
  for (const d of descriptors) {
    const row = document.createElement("div");
    const isActive = d.id === activeSaveId;
    row.style.cssText =
      `display:grid;grid-template-columns:1fr auto auto;gap:5px;align-items:center;padding:4px 6px;` +
      `background:${isActive ? "rgba(120,170,230,.18)" : "rgba(255,255,255,.03)"};border:1px solid ${isActive ? "#69f" : "transparent"};border-radius:3px;`;
    const label = document.createElement("button");
    label.style.cssText =
      "background:transparent;border:none;color:#cde;font:inherit;text-align:left;cursor:pointer;padding:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    const srcTag = d.source === "both" ? "↕" : d.source === "local" ? "L" : "S";
    label.innerHTML = `<strong>${escapeHtml(d.name)}</strong> <span style="opacity:.5;">${srcTag}</span><br><span style="opacity:.5;font-size:10px;">${timeAgo(d.updatedAt)} · ${(d.size / 1024).toFixed(1)} KiB</span>`;
    label.title = `${d.id} — ${d.source}`;
    label.addEventListener("click", () => void loadLot(true, d.id));
    const del = document.createElement("button");
    del.textContent = "✕";
    del.title = "Delete this save";
    del.style.cssText =
      "background:#222;color:#d88;border:1px solid #533;font:inherit;padding:1px 6px;cursor:pointer;border-radius:2px;line-height:1.2;";
    del.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (!confirm(`Delete save "${d.name}"?`)) return;
      await deleteSave(d.id);
      if (d.id === activeSaveId) {
        activeSaveId = LOT_SAVE_ID;
        activeSaveName = "Current Lot";
      }
      void renderSavesHud();
    });
    row.append(label, del);
    list.appendChild(row);
  }
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

interface SerializedSim {
  name: string;
  fx: number;
  fy: number;
  motives: number[];
  /** Added in Phase 7 — CAS data. Optional so old saves keep loading. */
  id?: number;
  gender?: "F" | "M";
  age?: "Child" | "Adult" | "Elder";
  bio?: string;
  traits?: number[];
  headColor?: string;
  bodyColor?: string;
}

interface SerializedLot {
  instances: SerializedLotInstance[];
  floorPaint: Array<{ key: number; color: string }>;
  sims?: SerializedSim[];
  selectedSim?: number;
  funds?: number;
  gameMinutes?: number;
  gameDayIdx?: number;
  wallsN?: number[];
  wallsW?: number[];
  doorsN?: number[];
  doorsW?: number[];
  windowsN?: number[];
  windowsW?: number[];
  /** Path of the active House.iff template — null/missing for hand-built lots. */
  lotPath?: string | null;
}

function serializeLot(): SerializedLot {
  const inst = lotInstances.map((i) => ({
    iffName: i.obj.iffName,
    worldX: i.worldX,
    worldY: i.worldY,
    direction: i.direction,
    zoom: i.zoom,
    dgrpId: i.dgrpId,
  }));
  const floor: Array<{ key: number; color: string }> = [];
  for (const [k, c] of floorPaint) floor.push({ key: k, color: c });
  const serSims: SerializedSim[] = sims.map((s) => ({
    name: s.name,
    fx: s.fx,
    fy: s.fy,
    motives: [...s.motives],
    id: s.id,
    gender: s.gender,
    age: s.age,
    bio: s.bio,
    traits: [...s.traits],
    headColor: s.headColor,
    bodyColor: s.bodyColor,
  }));
  return {
    instances: inst,
    floorPaint: floor,
    sims: serSims,
    selectedSim: selectedSimIdx,
    funds,
    gameMinutes,
    gameDayIdx,
    wallsN: [...wallsN],
    wallsW: [...wallsW],
    doorsN: [...doorsN],
    doorsW: [...doorsW],
    windowsN: [...windowsN],
    windowsW: [...windowsW],
    lotPath: currentLotPath,
  };
}

/** Current named save the user is editing — null = the auto "current-lot"
 *  slot. When the user opens a save from the Saves panel we point this at it
 *  so subsequent ⌘S writes back to the same slot. */
let activeSaveId: string = LOT_SAVE_ID;
let activeSaveName: string = "Current Lot";

async function saveLot(): Promise<void> {
  const payload = JSON.stringify(serializeLot());
  const result = await putSave(activeSaveId, activeSaveName, payload);
  if (result.idb || result.server) {
    console.info(
      `[lot] saved "${activeSaveName}" (${payload.length}B) — idb:${result.idb ? "ok" : "no"} server:${result.server ? "ok" : "no"}`,
    );
  } else {
    console.warn(`[lot] save failed: neither idb nor server accepted the payload`);
  }
  renderSavesHud();
}

async function saveLotAs(name: string): Promise<void> {
  const id = await slugifySaveId(name);
  activeSaveId = id;
  activeSaveName = name;
  await saveLot();
}

async function loadLot(replace: boolean = true, saveId: string = activeSaveId): Promise<void> {
  const wasm = viewerState.wasm;
  if (!wasm || !objectsFarPathCache) return;
  try {
    const fetched = await getSave(saveId);
    if (!fetched) return; // 404 first time; that's fine.
    activeSaveId = saveId;
    activeSaveName = fetched.name;
    const parsed = JSON.parse(fetched.payload) as unknown;
    // Accept either the new SerializedLot shape or the legacy bare-array shape
    // so existing user saves keep loading.
    let instances: SerializedLotInstance[] = [];
    let floors: Array<{ key: number; color: string }> = [];
    if (Array.isArray(parsed)) {
      instances = parsed as SerializedLotInstance[];
    } else if (parsed && typeof parsed === "object") {
      const obj = parsed as Partial<SerializedLot>;
      if (Array.isArray(obj.instances)) instances = obj.instances;
      if (Array.isArray(obj.floorPaint)) floors = obj.floorPaint;
    }
    if (replace) {
      lotInstances.length = 0;
      floorPaint.clear();
      wallsN.clear();
      wallsW.clear();
      doorsN.clear();
      doorsW.clear();
      windowsN.clear();
      windowsW.clear();
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as SerializedLot;
      if (Array.isArray(obj.sims) && obj.sims.length > 0) {
        // Replace the family — also wipe the greet cooldown map so we don't
        // hold references to deleted sim ids forever.
        lastGreetByIdMs.clear();
        sims.length = 0;
        for (const s of obj.sims) {
          const fallback = SIM_PALETTE[sims.length % SIM_PALETTE.length]!;
          const traitsArr =
            Array.isArray(s.traits) && s.traits.length === 5
              ? (s.traits.map((t) => (typeof t === "number" ? t : 5)) as unknown as Traits)
              : defaultTraits();
          const id = typeof s.id === "number" ? s.id : allocSimId();
          if (typeof s.id === "number" && s.id >= nextSimId) nextSimId = s.id + 1;
          sims.push({
            id,
            name: s.name ?? "Sim",
            gender: s.gender === "M" ? "M" : "F",
            age: s.age === "Child" || s.age === "Elder" ? s.age : "Adult",
            bio: typeof s.bio === "string" ? s.bio : "",
            traits: traitsArr,
            headColor: typeof s.headColor === "string" ? s.headColor : fallback.color,
            bodyColor: typeof s.bodyColor === "string" ? s.bodyColor : fallback.body,
            fx: s.fx ?? 8,
            fy: s.fy ?? 8,
            walk: null,
            onArrive: null,
            bubble: null,
            motives:
              Array.isArray(s.motives) && s.motives.length === 8 ? [...s.motives] : defaultMotives(),
            facing: 3,
            sleeping: false,
          });
        }
        selectedSimIdx = Math.max(0, Math.min(sims.length - 1, obj.selectedSim ?? 0));
        renderFamilyHud();
      }
      if (typeof obj.funds === "number") funds = obj.funds;
      if (typeof obj.gameMinutes === "number") gameMinutes = obj.gameMinutes;
      if (typeof obj.gameDayIdx === "number") gameDayIdx = obj.gameDayIdx;
      // Re-apply the House.iff template *first* so its floor palette/walls
      // become the base; user edits saved below then overlay on top.
      if (typeof obj.lotPath === "string" && obj.lotPath.length > 0) {
        try {
          const loaded = await loadHouseTemplate(obj.lotPath, lotScene.gridSize);
          for (const [k, v] of loaded.floorPaint) floorPaint.set(k, v);
          for (const k of loaded.wallsN) wallsN.add(k);
          for (const k of loaded.wallsW) wallsW.add(k);
          currentLotPath = obj.lotPath;
        } catch (err) {
          console.warn(`[lot] re-apply template ${obj.lotPath} failed:`, err);
        }
      }
      if (Array.isArray(obj.wallsN)) for (const k of obj.wallsN) if (typeof k === "number") wallsN.add(k);
      if (Array.isArray(obj.wallsW)) for (const k of obj.wallsW) if (typeof k === "number") wallsW.add(k);
      if (Array.isArray(obj.doorsN)) for (const k of obj.doorsN) if (typeof k === "number") doorsN.add(k);
      if (Array.isArray(obj.doorsW)) for (const k of obj.doorsW) if (typeof k === "number") doorsW.add(k);
      if (Array.isArray(obj.windowsN)) for (const k of obj.windowsN) if (typeof k === "number") windowsN.add(k);
      if (Array.isArray(obj.windowsW)) for (const k of obj.windowsW) if (typeof k === "number") windowsW.add(k);
      renderTimeFundsHud();
    }
    for (const s of instances) {
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
    for (const f of floors) {
      if (typeof f.key === "number" && typeof f.color === "string") floorPaint.set(f.key, f.color);
    }
    composeLotScene();
    renderSavesHud();
    console.info(
      `[lot] loaded "${activeSaveName}" — ${lotInstances.length} instance(s) + ${floorPaint.size} painted tile(s) + ${wallsN.size + wallsW.size} wall(s)`,
    );
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
    // v5 / v8 / v9 / v10 are all supported by the Rust decoder. Anything that
    // still fails is a v11 chunk (TSO-only, not present in TS1) or a corrupt
    // payload. Fall back to header-only so the pie menu shows the count
    // instead of nothing.
    try {
      const header = wasm.parseTtabHeader(
        inst.obj.data.subarray(ttabChunk.dataStart, ttabChunk.dataStart + ttabChunk.dataLen),
      ) as { count: number; version: number };
      console.info(`[pie] TTAB v${header.version} on ${inst.obj.iffName}: ${header.count} interactions (decoder unsupported)`);
      if (header.count > 0) {
        return [
          {
            label: `${header.count} v${header.version} interactions — decoder unsupported`,
            actionFunction: 0,
            joiningIndex: -1,
            guardFunction: 0,
            ttabMotives: [],
          },
        ];
      }
    } catch (err2) {
      console.info(`[pie] TTAB header parse failed on ${inst.obj.iffName}: ${(err2 as Error).message}`);
    }
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
    "position:fixed;display:none;z-index:120;min-width:200px;max-width:320px;background:rgba(20,28,40,.96);border:1px solid #345;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.5);padding:6px 0;font:12px/1.4 ui-sans-serif,system-ui,sans-serif;color:#cde;";
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
  const priceTag = inst.obj.price > 0 ? `  ·  §${inst.obj.price}` : "";
  header.textContent = `${inst.obj.objectName}${priceTag}  ·  ${rows.length} interaction${rows.length === 1 ? "" : "s"}`;
  header.style.cssText = "padding:4px 10px;border-bottom:1px solid #345;color:#9ad;opacity:.8;";
  menu.appendChild(header);
  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.textContent = "(no interactions defined for this object)";
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
        } else if (ef.kind === "TransferFunds") {
          const delta = Number(ef["delta"] ?? 0);
          adjustFunds(delta);
          showBubble(delta >= 0 ? `+§${delta}` : `§${delta}`);
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
    updateBuildToolHighlights();
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
  renderFamilyHud();
  startMotivesLoop();
  renderTimeFundsHud();
  startGameClock();
  startAutoWanderLoop();
  // Kick the render loop so idle breath animates from the start.
  ensureRenderLoop();
  // Try to restore the user's last lot first; if there is none, fall back to
  // the bundled demo placements so the page is never empty on boot. The save
  // module checks IDB first so the page comes up fast even offline.
  try {
    const stored = await getSave(LOT_SAVE_ID);
    if (stored) {
      await loadLot(true);
    } else {
      void mountLotDemo(wasm, objectsFar.path);
    }
  } catch {
    void mountLotDemo(wasm, objectsFar.path);
  }
  // Render the saves panel after the boot load so the active label is right.
  renderSavesHud();
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
