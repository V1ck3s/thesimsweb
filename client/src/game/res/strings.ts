/**
 * String tables (StringSet): STR# chunks from the game's IFF files, with the
 * per-language entries of format -3 resolved to the UI language.
 *
 *   await strings.load("GameData/UIText.iff");
 *   strings.get("UIText", 138, 0)   // chunk 138, entry 0
 */

import { readStandaloneIff } from "../../engine/assets.js";
import { engine } from "../../engine/wasm.js";
import { UI_LANGUAGE } from "./uires.js";

interface StrEntry {
  kind: "single" | "pair" | "lang";
  langCode?: number;
  data: Uint8Array;
  comment?: Uint8Array;
}

interface Str {
  text: string;
  comment: string;
}

const latin1 = new TextDecoder("windows-1252");

export class Strings {
  private readonly tables = new Map<string, Map<number, Str[]>>();
  /** The US English entries of the format -3 chunks (StringSetBase::GetString(index, 0)). */
  private readonly usTables = new Map<string, Map<number, Str[]>>();

  constructor(private readonly lang = UI_LANGUAGE) {}

  /** Load every STR# chunk of `Sims/<path>`; the table is named after the file. */
  async load(path: string): Promise<void> {
    const name = path.replace(/^.*\//, "").replace(/\.iff$/i, "");
    if (this.tables.has(name)) return;
    const wasm = await engine();
    const { data, chunks } = await readStandaloneIff(`Sims/${path}`);
    const table = new Map<number, Str[]>();
    const usTable = new Map<number, Str[]>();
    for (const c of chunks) {
      if (c.kind !== "STR#") continue;
      const parsed = wasm.parseStrTable(data.subarray(c.dataStart, c.dataStart + c.dataLen)) as {
        entries: StrEntry[];
      };
      table.set(c.id, this.pick(parsed.entries));
      usTable.set(c.id, this.pick(parsed.entries, 1));
    }
    this.tables.set(name, table);
    this.usTables.set(name, usTable);
  }

  /** Entry `index` of STR# `id` in table `name`, or "" when missing. */
  get(name: string, id: number, index: number): string {
    return this.tables.get(name)?.get(id)?.[index]?.text ?? "";
  }

  /** Entry `index` in US English (StringSetBase::GetString(index, 0)), or "" when missing. */
  getUS(name: string, id: number, index: number): string {
    return this.usTables.get(name)?.get(id)?.[index]?.text ?? "";
  }

  /** The entry's description (StringSetBase::GetDescription). */
  comment(name: string, id: number, index: number): string {
    return this.tables.get(name)?.get(id)?.[index]?.comment ?? "";
  }

  list(name: string, id: number): string[] {
    return (this.tables.get(name)?.get(id) ?? []).map((s) => s.text);
  }

  /** One STR# chunk's strings (0-based), languages resolved like `load` (plugin files' own string sets). */
  async parse(bytes: Uint8Array): Promise<string[]> {
    const wasm = await engine();
    const parsed = wasm.parseStrTable(bytes) as { entries: StrEntry[] };
    return this.pick(parsed.entries).map((s) => s.text);
  }

  private pick(entries: StrEntry[], lang = this.lang): Str[] {
    const str = (e: StrEntry): Str => ({
      text: latin1.decode(e.data),
      comment: e.comment ? latin1.decode(e.comment) : "",
    });
    if (!entries.some((e) => e.kind === "lang")) return entries.map(str);
    // Format -3 stores one entry per (string, language); keep ours, fall back to US English.
    const ours = entries.filter((e) => e.langCode === lang);
    const us = entries.filter((e) => e.langCode === 1);
    const n = Math.max(ours.length, us.length);
    const out: Str[] = [];
    for (let i = 0; i < n; i++) out.push(str((ours[i] ?? us[i])!));
    return out;
  }
}
