/**
 * House.iff loader — bridges the Rust parsers (`parseHous`/`parseFlrm`/
 * `parseArry`) to the iso scene's existing `floorPaint` / `wallsN` / `wallsW`
 * containers.
 *
 * House.iff is a 64×64 lot save. We don't change the client's grid size
 * (still 16); instead we pull a 16×16 window from the lot centre — that's
 * where geometry is densest empirically (templates `TemplateMagictown/House9?`
 * pack the build inside a ~24..40 box on each axis).
 *
 * The mapping FLRm `id` → CSS preview color is hash-based until SPR2 inside
 * each referenced `.flr` is decoded (multi-day reverse, deferred).
 *
 * See `docs/formats/HOUS.md`.
 */

import { engine } from "./wasm.js";
import { readStandaloneIff, type IffChunkInfo } from "./assets.js";

/** Lot size in `Arry` chunks. TS1 standard lots are 64×64. */
const HOUSE_GRID = 64;
/** Cell size of the cropped window pulled into the 16×16 client lot. */
const WINDOW_CROP_OFFSET = 24;

export interface LoadedHouse {
  /** `HOUS.name` — the lot's display title. */
  name: string;
  /** Filename → preview color, in catalog order from `FLRm` chunk id=0. */
  floorPalette: Array<{ id: number; filename: string; color: string }>;
  /** `y * gridSize + x` → CSS color (matches the client's `floorPaint` Map). */
  floorPaint: Map<number, string>;
  /** Wall keys `y * (N+1) + x` for north-edge and west-edge walls. */
  wallsN: Set<number>;
  wallsW: Set<number>;
  /** Stats for the load summary HUD line. */
  stats: {
    floorPaintedTiles: number;
    walls: number;
    floorPaletteEntries: number;
  };
}

export interface TemplateEntry {
  name: string;
  path: string;
  size: number;
}

export async function fetchTemplates(): Promise<TemplateEntry[]> {
  const res = await fetch("/api/templates");
  if (!res.ok) throw new Error(`templates ${res.status}`);
  const json = (await res.json()) as { templates: TemplateEntry[] };
  return json.templates;
}

/** Hash a u8 id to a stable preview color. The colors are deliberately muted
 *  so they read as "floor materials" rather than the bright build-mode swatches. */
function colorForFlrmId(id: number): string {
  const h = (id * 137) % 360;
  return `hsl(${h}, 35%, 48%)`;
}

interface ArryView {
  width: number;
  height: number;
  kind: number;
  data: Uint8Array;
}

interface FlrmEntryRaw {
  filename: string;
  id: number;
}

interface FlrmView {
  entries: FlrmEntryRaw[];
}

function findChunks(chunks: IffChunkInfo[], kind: string): IffChunkInfo[] {
  return chunks.filter((c) => c.kind === kind);
}

/** Resolve the FLRm chunk used for the *ground* floor (chunk id 0). */
function findFlrmGround(chunks: IffChunkInfo[]): IffChunkInfo | null {
  const all = findChunks(chunks, "FLRm");
  return all.find((c) => c.id === 0) ?? all[0] ?? null;
}

/** Resolve the `Arry` chunk by ID. House layout uses well-known IDs per HOUS.md:
 *  id=1 → ground floor materials (1 byte/tile),
 *  id=2 → wall edges (8 bytes/tile, 4 edges × 2B). */
function findArry(chunks: IffChunkInfo[], id: number): IffChunkInfo | null {
  return findChunks(chunks, "Arry").find((c) => c.id === id) ?? null;
}

function slice(data: Uint8Array, c: IffChunkInfo): Uint8Array {
  return data.subarray(c.dataStart, c.dataStart + c.dataLen);
}

/** Pull a 16×16 window from a `Arry` byte stream. The window starts at
 *  `(cropX, cropY)` in the source 64×64 grid. */
function windowFromArry(
  arry: ArryView,
  cropX: number,
  cropY: number,
  outSize: number,
): Uint8Array {
  const stride = arry.kind; // bytes per tile
  const out = new Uint8Array(outSize * outSize * stride);
  for (let dy = 0; dy < outSize; dy += 1) {
    for (let dx = 0; dx < outSize; dx += 1) {
      const sx = cropX + dx;
      const sy = cropY + dy;
      if (sx < 0 || sy < 0 || sx >= arry.width || sy >= arry.height) continue;
      const srcOff = (sy * arry.width + sx) * stride;
      const dstOff = (dy * outSize + dx) * stride;
      out.set(arry.data.subarray(srcOff, srcOff + stride), dstOff);
    }
  }
  return out;
}

/** Pick the densest 16×16 window in the lot (max non-zero tiles in `arry`). */
function densestWindow(
  arry: ArryView,
  outSize: number,
): { x: number; y: number } {
  // Integral image of "tile has any non-zero byte" for O(1) box queries.
  const W = arry.width;
  const H = arry.height;
  const stride = arry.kind;
  const occ = new Uint8Array(W * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      let any = 0;
      const off = (y * W + x) * stride;
      for (let b = 0; b < stride; b += 1) {
        if (arry.data[off + b] !== 0) {
          any = 1;
          break;
        }
      }
      occ[y * W + x] = any;
    }
  }
  // Build summed-area table.
  const sat = new Int32Array((W + 1) * (H + 1));
  for (let y = 1; y <= H; y += 1) {
    for (let x = 1; x <= W; x += 1) {
      sat[y * (W + 1) + x] =
        (occ[(y - 1) * W + (x - 1)] ?? 0) +
        (sat[(y - 1) * (W + 1) + x] ?? 0) +
        (sat[y * (W + 1) + (x - 1)] ?? 0) -
        (sat[(y - 1) * (W + 1) + (x - 1)] ?? 0);
    }
  }
  let bestX = 0;
  let bestY = 0;
  let bestCount = -1;
  for (let y = 0; y + outSize <= H; y += 1) {
    for (let x = 0; x + outSize <= W; x += 1) {
      const c =
        (sat[(y + outSize) * (W + 1) + (x + outSize)] ?? 0) -
        (sat[y * (W + 1) + (x + outSize)] ?? 0) -
        (sat[(y + outSize) * (W + 1) + x] ?? 0) +
        (sat[y * (W + 1) + x] ?? 0);
      if (c > bestCount) {
        bestCount = c;
        bestX = x;
        bestY = y;
      }
    }
  }
  return { x: bestX, y: bestY };
}

export async function loadHouseTemplate(
  path: string,
  gridSize: number,
): Promise<LoadedHouse> {
  const wasm = await engine();
  const { data, chunks } = await readStandaloneIff(path);

  const housChunk = findChunks(chunks, "HOUS")[0];
  if (!housChunk) throw new Error(`${path}: missing HOUS chunk`);
  const flrmGround = findFlrmGround(chunks);
  if (!flrmGround) throw new Error(`${path}: missing FLRm chunk`);
  const arryFloor = findArry(chunks, 1);
  const arryWalls = findArry(chunks, 2);

  const hous = wasm.parseHous(slice(data, housChunk)) as { name: string };
  const flrm = wasm.parseFlrm(slice(data, flrmGround), flrmGround.id) as FlrmView;

  const palette = flrm.entries.map((e) => ({
    id: e.id,
    filename: e.filename,
    color: colorForFlrmId(e.id),
  }));
  const idToColor = new Map<number, string>();
  for (const e of palette) idToColor.set(e.id, e.color);

  const floorPaint = new Map<number, string>();
  const wallsN = new Set<number>();
  const wallsW = new Set<number>();

  // The Arry sub-arrays cover the full 64×64 grid; we crop to gridSize ×
  // gridSize. Use the densest window if the lot is bigger than the client
  // grid — otherwise the default 24,24 anchor.
  const cropSize = Math.min(gridSize, HOUSE_GRID);
  let cropX = WINDOW_CROP_OFFSET;
  let cropY = WINDOW_CROP_OFFSET;

  if (arryFloor) {
    const a = wasm.parseArry(slice(data, arryFloor)) as ArryView;
    if (a.width === HOUSE_GRID && a.height === HOUSE_GRID) {
      const pick = densestWindow(a, cropSize);
      cropX = pick.x;
      cropY = pick.y;
    }
    const cropped = windowFromArry(a, cropX, cropY, cropSize);
    for (let y = 0; y < cropSize; y += 1) {
      for (let x = 0; x < cropSize; x += 1) {
        const v = cropped[y * cropSize + x] ?? 0;
        if (v === 0) continue;
        const color = idToColor.get(v);
        if (color) floorPaint.set(y * gridSize + x, color);
      }
    }
  }

  if (arryWalls) {
    const a = wasm.parseArry(slice(data, arryWalls)) as ArryView;
    if (a.kind >= 8) {
      const cropped = windowFromArry(a, cropX, cropY, cropSize);
      for (let y = 0; y < cropSize; y += 1) {
        for (let x = 0; x < cropSize; x += 1) {
          const base = (y * cropSize + x) * a.kind;
          // Empirical guess: 4 edges × 2B in the order N, E, S, W; a non-zero
          // first byte signals "wall present". This will need cross-checking
          // when we have a screenshot oracle, but it suffices for an initial
          // visual.
          const nByte = cropped[base] ?? 0;
          const wByte = cropped[base + 6] ?? 0;
          if (nByte !== 0) wallsN.add(y * (gridSize + 1) + x);
          if (wByte !== 0) wallsW.add(y * (gridSize + 1) + x);
        }
      }
    }
  }

  return {
    name: hous.name,
    floorPalette: palette,
    floorPaint,
    wallsN,
    wallsW,
    stats: {
      floorPaintedTiles: floorPaint.size,
      walls: wallsN.size + wallsW.size,
      floorPaletteEntries: palette.length,
    },
  };
}
