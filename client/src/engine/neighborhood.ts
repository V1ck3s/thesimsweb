/**
 * Neighborhood loader — turns the flat `/api/templates` list into a
 * neighborhood map by harvesting each lot's `HOUS.name`.
 *
 * Magictown's real lot layout lives in `LotLocations.iff`, which has no
 * Niotso oracle yet; until that chunk is reverse-engineered we lay the lots
 * out in a 5×2 grid and label them with their canonical `HOUS` name.
 * The displayed grid is a stylized neighborhood map, not the original Magic
 * Town topology.
 */

import { engine } from "./wasm.js";
import { readStandaloneIff } from "./assets.js";
import { fetchTemplates, type TemplateEntry } from "./house.js";

export interface NeighborhoodLot {
  /** Display name pulled from `HOUS.name` (falls back to filename). */
  name: string;
  /** Asset path — feed straight to `loadHouseTemplate`. */
  path: string;
  /** Size in bytes; surfaced as tooltip. */
  size: number;
  /** Grid column on the synthetic neighborhood map. */
  gx: number;
  /** Grid row on the synthetic neighborhood map. */
  gy: number;
}

const NEIGHBORHOOD_COLS = 5;

async function readHousName(path: string): Promise<string | null> {
  try {
    const wasm = await engine();
    const { data, chunks } = await readStandaloneIff(path);
    const housChunk = chunks.find((c) => c.kind === "HOUS");
    if (!housChunk) return null;
    const bytes = data.subarray(housChunk.dataStart, housChunk.dataStart + housChunk.dataLen);
    const hous = wasm.parseHous(bytes) as { name?: string };
    return typeof hous.name === "string" && hous.name.length > 0 ? hous.name : null;
  } catch {
    return null;
  }
}

export async function fetchNeighborhoodMap(): Promise<NeighborhoodLot[]> {
  const templates: TemplateEntry[] = await fetchTemplates();
  const lots: NeighborhoodLot[] = [];
  // Resolve HOUS names in parallel — readStandaloneIff hits IDB cache after
  // the first warm-up, so this stays fast on repeat visits.
  const names = await Promise.all(templates.map((t) => readHousName(t.path)));
  for (let i = 0; i < templates.length; i += 1) {
    const t = templates[i]!;
    const housName = names[i];
    lots.push({
      name: housName ?? t.name,
      path: t.path,
      size: t.size,
      gx: i % NEIGHBORHOOD_COLS,
      gy: Math.floor(i / NEIGHBORHOOD_COLS),
    });
  }
  return lots;
}
