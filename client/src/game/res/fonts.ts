/**
 * Font system (cTSFontSys::TSAcquireFont): VariableSans_<size><style>.ffn from
 * UIGraphics.far. Styles: "" plain, "_s" shadow, "_bs" bold shadow. Fonts must
 * be acquired (awaited) during init; painting uses the cached instances.
 *
 * The font depends on the game's language: Russian (13) and Polish (16) read
 * their own VariableSans from Fonts/Russian and Fonts/Polish; Japanese (15),
 * Simplified (17) and Traditional Chinese (18) and Korean (20) get a
 * double-byte font (res/dbfont.ts), one per language whatever the size;
 * Thai (19) gets cTSDBFontThai (res/thaifont.ts, font20th.fon), also one
 * whatever the size and style.
 */

import { readFarEntry } from "../../engine/assets.js";
import { DbFont, dbFontFile } from "./dbfont.js";
import { FntfFont, type FfnFont } from "./ffn.js";
import { ThaiFont } from "./thaifont.js";
import { UI_LANGUAGE } from "./uires.js";

const FAR = "Sims/UIGraphics/UIGraphics.far";
const SIZES = [7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 48];

export type FontStyle = "" | "_s" | "_bs";

/** TSAcquireFont: the folder of a language's VariableSans ("Russian\", "Polish\"). */
function fontFolder(lang: number): string {
  if (lang === 13) return "Fonts\\Russian\\";
  if (lang === 16) return "Fonts\\Polish\\";
  return "Fonts\\";
}

export class Fonts {
  private readonly cache = new Map<string, Promise<FfnFont>>();

  constructor(private readonly lang = UI_LANGUAGE) {}

  /** Closest shipped size at or below `size` (the game clamps the same way). */
  async acquire(size: number, style: FontStyle = ""): Promise<FfnFont> {
    if (this.lang === 19) {
      const file = "Fonts\\font20th.fon";
      let f = this.cache.get(file);
      if (!f) {
        f = readFarEntry(FAR, file).then((bytes) => new ThaiFont(bytes));
        this.cache.set(file, f);
      }
      return f;
    }
    const db = dbFontFile(this.lang);
    if (db) {
      const file = `Fonts\\${db.file}`;
      let f = this.cache.get(file);
      if (!f) {
        f = readFarEntry(FAR, file).then((bytes) => new DbFont(this.lang, db, bytes));
        this.cache.set(file, f);
      }
      return f;
    }
    const s = [...SIZES].reverse().find((v) => v <= size) ?? SIZES[0]!;
    const dir = fontFolder(this.lang);
    const file = `${dir}variablesans_${String(s).padStart(2, "0")}${style}.ffn`;
    let f = this.cache.get(file);
    if (!f) {
      f = readFarEntry(FAR, file)
        .catch(() => readFarEntry(FAR, `${dir}variablesans_${String(s).padStart(2, "0")}.ffn`))
        .then((bytes) => new FntfFont(bytes));
      this.cache.set(file, f);
    }
    return f;
  }
}
