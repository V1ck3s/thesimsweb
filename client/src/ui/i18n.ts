// Authentic TS1 strings, hydrated at boot from
// /assets/converted/strings/*.json (produced by scripts/extract-ui-strings.mjs).
//
// Each STR# chunk is identified by its source file and its 2-byte IFF chunk ID;
// we expose `s(source, id, idx)` to look up a single entry in the active
// locale (with EN as the universal fallback). The active locale defaults to FR
// — the user's installed edition — and can be flipped via setLocale() (Phase 11).

export type Locale = 1 | 3; // 1 = English (US), 3 = French. Other codes exist
// in the data files but the UI only exposes these two for now.

type Source = "Live" | "Build" | "UIText" | "Behavior" | "fame" | "magic";

interface StrSet {
  id: number;
  label: string;
  kind: string;
  version: number;
  langs: Record<string, string[]>;
}

interface Bundle {
  source: string;
  sets: StrSet[];
}

const SOURCES: Source[] = ["Live", "Build", "UIText", "Behavior", "fame", "magic"];

const bundles = new Map<Source, Bundle>();
let activeLocale: Locale = 3;
const LOCALE_STORAGE_KEY = "tsw.locale";

function readStoredLocale(): Locale {
  try {
    const raw = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (raw === "1" || raw === "3") return Number(raw) as Locale;
  } catch {
    // localStorage may be unavailable in private mode; ignore.
  }
  return 3;
}

export async function loadStrings(): Promise<void> {
  activeLocale = readStoredLocale();
  const fetches = SOURCES.map(async (src) => {
    const r = await fetch(`/assets/converted/strings/${src}.json`);
    if (!r.ok) throw new Error(`failed to load strings/${src}.json: ${r.status}`);
    const b = (await r.json()) as Bundle;
    bundles.set(src, b);
  });
  await Promise.all(fetches);
}

export function getLocale(): Locale {
  return activeLocale;
}

export function setLocale(loc: Locale): void {
  activeLocale = loc;
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, String(loc));
  } catch {
    // ignore
  }
  for (const cb of localeListeners) cb(loc);
}

const localeListeners = new Set<(loc: Locale) => void>();

export function onLocaleChange(cb: (loc: Locale) => void): () => void {
  localeListeners.add(cb);
  return () => {
    localeListeners.delete(cb);
  };
}

/** Look up a single string entry by source file + chunk ID + index. */
export function s(source: Source, id: number, idx: number, fallback: string = ""): string {
  const b = bundles.get(source);
  if (!b) return fallback;
  const set = b.sets.find((x) => x.id === id);
  if (!set) return fallback;
  const arr = set.langs[String(activeLocale)] ?? set.langs["1"] ?? [];
  return arr[idx] ?? set.langs["1"]?.[idx] ?? fallback;
}

/** Return the entire entries array for a (source, id) chunk in the current
 * locale (or English fallback). */
export function ss(source: Source, id: number): string[] {
  const b = bundles.get(source);
  if (!b) return [];
  const set = b.sets.find((x) => x.id === id);
  if (!set) return [];
  return set.langs[String(activeLocale)] ?? set.langs["1"] ?? [];
}

/** Convenience: return whatever's available across locales (FR > EN > 0). */
export function sAny(source: Source, id: number, idx: number, fallback: string = ""): string {
  return s(source, id, idx, fallback);
}
