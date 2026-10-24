/**
 * String tables (StringSet): STR# chunks from the game's IFF files, with the
 * per-language entries of format -3 resolved to the UI language.
 *
 *   await strings.load("GameData/UIText.iff");
 *   strings.get("UIText", 138, 0)   // chunk 138, entry 0
 */

import { readStandaloneIff } from "../../engine/assets.js";
import { engine } from "../../engine/wasm.js";
import { LANG_FRENCH } from "./uires.js";

interface StrEntry {
  kind: "single" | "pair" | "lang";
  langCode?: number;
  data: Uint8Array;
}

const latin1 = new TextDecoder("windows-1252");

export class Strings {
  private readonly tables = new Map<string, Map<number, string[]>>();

  constructor(private readonly lang = LANG_FRENCH) {}

  /** Load every STR# chunk of `Sims/<path>`; the table is named after the file. */
  async load(path: string): Promise<void> {
    const name = path.replace(/^.*\//, "").replace(/\.iff$/i, "");
    if (this.tables.has(name)) return;
    const wasm = await engine();
    const { data, chunks } = await readStandaloneIff(`Sims/${path}`);
    const table = new Map<number, string[]>();
    for (const c of chunks) {
      if (c.kind !== "STR#") continue;
      const parsed = wasm.parseStrTable(data.subarray(c.dataStart, c.dataStart + c.dataLen)) as {
        entries: StrEntry[];
      };
      table.set(c.id, this.pick(parsed.entries));
    }
    this.tables.set(name, table);
  }

  /** Entry `index` of STR# `id` in table `name`, or "" when missing. */
  get(name: string, id: number, index: number): string {
    return this.tables.get(name)?.get(id)?.[index] ?? "";
  }

  list(name: string, id: number): string[] {
    return this.tables.get(name)?.get(id) ?? [];
  }

  private pick(entries: StrEntry[]): string[] {
    if (!entries.some((e) => e.kind === "lang")) return entries.map((e) => latin1.decode(e.data));
    // Format -3 stores one entry per (string, language); keep ours, fall back to US English.
    const ours = entries.filter((e) => e.langCode === this.lang);
    const us = entries.filter((e) => e.langCode === 1);
    const n = Math.max(ours.length, us.length);
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(latin1.decode((ours[i] ?? us[i])!.data));
    return out;
  }
}
