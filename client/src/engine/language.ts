/**
 * The game's language (cSimsApp +100, kRes_Language* of
 * UIGraphics/Res_Languages.h). The original takes it from its install; the
 * game files carry every language's strings (the format -3 STR# chunks of
 * UIText.iff and the objects), so the port lets the player choose it on the
 * landing page (client/src/landing/main.ts). It is read once when the game
 * starts: a change applies at the next start.
 *
 * Offered: the languages whose strings are complete and whose fonts the port
 * draws: the Windows-1252 ones, Polish (Windows-1250, its own VariableSans;
 * res/codepage.ts, res/fonts.ts), and Japanese, Simplified and Traditional
 * Chinese and Korean (res/dbfont.ts, with the control panel's double-byte
 * layouts, isDoubleByteUI below). Hebrew and Russian have a third of the
 * strings (the rest falls back to US English), and this install's Russian
 * VariableSans only holds ASCII. Thai (res/thaifont.ts) draws (see
 * PREVIEW_LANGUAGES).
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
  { code: 15, name: "日本語", tags: ["ja"] },
  { code: 16, name: "Polski", tags: ["pl"] },
  { code: 17, name: "简体中文", tags: ["zh-cn", "zh-sg", "zh-hans", "zh"] },
  { code: 18, name: "繁體中文", tags: ["zh-tw", "zh-hk", "zh-mo", "zh-hant"] },
  { code: 20, name: "한국어", tags: ["ko"] },
];

/**
 * Languages the port draws (res/thaifont.ts) but does not offer yet (Thai:
 * its double-byte layouts are ported with the others but not verified).
 * `?lang=<code>` still selects them.
 */
export const PREVIEW_LANGUAGES: readonly number[] = [19];

/**
 * CPState::IsDoubleByteUI: Japanese, the Chinese languages, Thai and Korean
 * (15, 17..20). The control panel's layouts that test it read DOUBLE_BYTE_UI
 * (res/uires.ts): cWinCPanel, cWinPeople and its pages, cWinMotive,
 * cWinRelationship, cWinLivePopup, cWinPictureInPicture, CWinMagicBook.
 */
export function isDoubleByteUI(lang: number): boolean {
  const i = lang - 15;
  return i >= 0 && i <= 5 && ((1 << i) & 0x3d) !== 0;
}

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
    if (q !== null && (valid(Number(q)) || PREVIEW_LANGUAGES.includes(Number(q)))) return Number(q);
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
