/**
 * cTSLanguageUtility / cTSLanguageManager formatting, per language id
 * (kRes_Language*, cSimsApp +100).
 *
 * The game's utility keeps its currency flag (+0xc) at 0, so GetCurrencySymbol
 * always returns "$" (the game fonts draw it as the simoleon sign);
 * DoesCurrencySymbolPrecedeAmount is true and IsSpaceBetweenCurrencySymbolAndAmount
 * false for every language. Only the thousands separator and the place of the
 * minus sign change.
 */

/** cTSLanguageUtility::GetThousandSeparator jump table (lbl_105BCFD0), by language id 0..20; "untranslated" for 0 and past 20. */
const THOUSAND_SEPARATOR = ["untranslated", ",", ",", ".", ".", ".", ".", ".", ".", ".", "", "", ",", ".", ".", ",", "", ",", ",", ",", ","];

/**
 * cTSLanguageUtility::MakeMoneyString((long long, cTSString &)): "$" then the
 * amount grouped by threes. A negative amount takes its minus sign from the
 * jump table at lbl_105BCFD4: "-$1,234" for most languages, "$ -1.234" for
 * Danish (8) and language 12, "$-1234" for Norwegian (10); language 0 (and
 * ids past 19) give an empty string.
 */
export function makeMoneyString(amount: number, lang: number): string {
  const value = Math.trunc(amount);
  const digits = String(Math.abs(value));
  const sep = lang >= 0 && lang <= 20 ? THOUSAND_SEPARATOR[lang]! : "untranslated";
  let grouped = "";
  let rest = digits.length;
  while (rest > 3) {
    const n = rest % 3 || 3;
    grouped += digits.slice(digits.length - rest, digits.length - rest + n) + sep;
    rest -= n;
  }
  grouped += digits.slice(digits.length - rest);
  if (value >= 0) return "$" + grouped;
  if (lang === 8 || lang === 12) return "$ -" + grouped;
  if (lang === 10) return "$-" + grouped;
  if (lang >= 1 && lang <= 19) return "-$" + grouped;
  return "";
}

/** cTSLanguageManager::MakeTimeString uses AM/PM for these language ids. */
const AMPM_LANGUAGES = [1, 2, 0x13];

/**
 * cTSLanguageManager::MakeTimeString(hour, minute, upperCase = true, prefix = true):
 * "AM 10:05" in the English languages (and 0x13), "10:05" (24 h) otherwise.
 */
export function makeTimeString(hour: number, minute: number, lang: number): string {
  const mm = String(minute).padStart(2, "0");
  if (!AMPM_LANGUAGES.includes(lang)) return `${String(hour).padStart(2, " ")}:${mm}`;
  const ampm = hour < 12 ? "AM" : "PM";
  const h = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${ampm} ${String(h).padStart(2, " ")}:${mm}`;
}
