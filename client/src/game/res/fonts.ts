/**
 * Font system (cTSFontSys::TSAcquireFont): VariableSans_<size><style>.ffn from
 * UIGraphics.far. Styles: "" plain, "_s" shadow, "_bs" bold shadow. Fonts must
 * be acquired (awaited) during init; painting uses the cached instances.
 */

import { readFarEntry } from "../../engine/assets.js";
import { FfnFont } from "./ffn.js";

const FAR = "Sims/UIGraphics/UIGraphics.far";
const SIZES = [7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 48];

export type FontStyle = "" | "_s" | "_bs";

export class Fonts {
  private readonly cache = new Map<string, Promise<FfnFont>>();

  /** Closest shipped size at or below `size` (the game clamps the same way). */
  async acquire(size: number, style: FontStyle = ""): Promise<FfnFont> {
    const s = [...SIZES].reverse().find((v) => v <= size) ?? SIZES[0]!;
    const file = `Fonts\\variablesans_${String(s).padStart(2, "0")}${style}.ffn`;
    let f = this.cache.get(file);
    if (!f) {
      f = readFarEntry(FAR, file)
        .catch(() => readFarEntry(FAR, `Fonts\\variablesans_${String(s).padStart(2, "0")}.ffn`))
        .then((bytes) => new FfnFont(bytes));
      this.cache.set(file, f);
    }
    return f;
  }
}
