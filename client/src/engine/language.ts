/**
 * The game's language (cSimsApp +100, kRes_Language* of
 * UIGraphics/Res_Languages.h). The original takes it from its install; the
 * game files carry every language's strings (the format -3 STR# chunks of
 * UIText.iff and the objects), so the port lets the player choose it on the
 * landing page (client/src/landing/main.ts). It is read once when the game
 * starts: a change applies at the next start.
 *
 * Offered: the languages whose strings are complete and that use the 1252
 * character set the game's bitmap fonts draw (GetCharacterSetFromLanguage,
 * nbhd/imports.ts). Hebrew and Russian have a third of the strings; Polish,
 * Japanese, the Chinese languages, Thai and Korean need the double-byte or
 * other code page fonts the port does not draw.
 */

export interface UiLanguage {
  code: number;
  /** The language's own name. */
  name: string;
  /** BCP 47 tags matched against the browser's languages for the default. */
  tags: string[];
}

export const LANGUAGES: readonly UiLanguage[] = [
  { code: 1, name: "English (US)", tags: ["en-us", "en"] },
  { code: 2, name: "English (UK)", tags: ["en-gb", "en-ie", "en-au", "en-nz"] },
  { code: 3, name: "Français", tags: ["fr"] },
  { code: 4, name: "Deutsch", tags: ["de"] },
  { code: 5, name: "Italiano", tags: ["it"] },
  { code: 6, name: "Español", tags: ["es"] },
  { code: 7, name: "Nederlands", tags: ["nl"] },
  { code: 8, name: "Dansk", tags: ["da"] },
  { code: 9, name: "Svenska", tags: ["sv"] },
  { code: 10, name: "Norsk", tags: ["no", "nb", "nn"] },
  { code: 11, name: "Suomi", tags: ["fi"] },
  { code: 14, name: "Português", tags: ["pt"] },
];

const STORAGE_KEY = "thesimsweb.language";

/** The language the browser prefers among the offered ones (US English when none matches). */
export function defaultLanguage(): number {
  const prefs = typeof navigator === "undefined" ? [] : (navigator.languages ?? [navigator.language]);
  for (const pref of prefs) {
    const tag = pref.toLowerCase();
    // An exact region match first ("en-gb"), then the language alone ("fr-ca" -> "fr").
    const exact = LANGUAGES.find((l) => l.tags.includes(tag));
    if (exact) return exact.code;
    const base = LANGUAGES.find((l) => l.tags.includes(tag.split("-")[0]!));
    if (base) return base.code;
  }
  return 1;
}

/** The chosen language: `?lang=<code>` in the page's URL, else the stored choice, else the browser's. */
export function readLanguage(): number {
  const valid = (n: number): boolean => LANGUAGES.some((l) => l.code === n);
  try {
    const q = typeof location === "undefined" ? null : new URLSearchParams(location.search).get("lang");
    if (q !== null && valid(Number(q))) return Number(q);
  } catch {
    // (no URL: the default)
  }
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    if (valid(stored)) return stored;
  } catch {
    // (storage blocked: the default)
  }
  return defaultLanguage();
}

/** Keeps the player's choice for the next game start; false when the browser refuses to store it. */
export function storeLanguage(code: number): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, String(code));
    return true;
  } catch {
    return false;
  }
}
