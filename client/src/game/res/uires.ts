/**
 * UI resource manager, modelled on the game's nsSMResFac / cGZResMgrRTParser.
 *
 * The game ships its UI bitmap tables as text: `Res_*.h` declares the numeric
 * ids (`const Sint32 kUniversalCPBkg = 4910;`) and `Res_*.RT` maps each id to
 * a bitmap path, optionally per language:
 *
 *   {RLEBMP,kCatalogPrevPage,"CPanel/Buttons/ScrollLeft.bmp"}
 *   {BITMAP,kWebcamLogo,"CPanel/SimsLogoFr.bmp",kRes_LanguageFrench}
 *
 * Code asks for a bitmap by id (e.g. `LoadBuffer(0x132e)`), exactly like the
 * decompiled game does. Bitmaps come from loose files under UIGraphics/ when
 * present, otherwise from UIGraphics.far.
 */

import { fetchManifest, readAssetFile, readFarEntry } from "../../engine/assets.js";
import { decodeImage, type RgbaImage } from "./bmp.js";

const ROOT = "Sims/UIGraphics/";
const FAR = `${ROOT}UIGraphics.far`;
const TABLES = ["Res_CPanel", "Res_Nbhd", "Res_Other", "SMCtrlMgrRes"];

export const LANG_DEFAULT = 0;
export const LANG_FRENCH = 3;

interface RtEntry {
  kind: string;
  path: string;
  lang: number;
}

export class UIRes {
  private readonly consts = new Map<string, number>();
  private readonly entries = new Map<number, RtEntry[]>();
  private readonly looseFiles = new Map<string, string>();
  private readonly cache = new Map<string, Promise<ImageBitmap>>();

  private constructor(private readonly lang: number) {}

  private static readonly loaded = new Map<number, Promise<UIRes>>();

  /** The tables of a language, read once (later calls share the instance). */
  static load(lang = LANG_FRENCH): Promise<UIRes> {
    let p = UIRes.loaded.get(lang);
    if (!p) {
      p = UIRes.read(lang);
      UIRes.loaded.set(lang, p);
      p.catch(() => UIRes.loaded.delete(lang));
    }
    return p;
  }

  private static async read(lang: number): Promise<UIRes> {
    const res = new UIRes(lang);
    const manifest = await fetchManifest();
    for (const f of manifest.files) {
      if (f.path.startsWith(ROOT)) res.looseFiles.set(f.path.toLowerCase(), f.path);
    }
    for (const table of TABLES) {
      const rt = await res.readText(`${table}.RT`);
      await res.parseRt(rt);
    }
    return res;
  }

  /** Numeric value of a `k...` constant from the Res_*.h headers. */
  id(name: string): number {
    const v = this.consts.get(name);
    if (v === undefined) throw new Error(`unknown UI resource constant ${name}`);
    return v;
  }

  has(id: number): boolean {
    return this.entries.has(id);
  }

  path(id: number): string | undefined {
    const list = this.entries.get(id);
    if (!list) return undefined;
    return (list.find((e) => e.lang === this.lang) ?? list.find((e) => e.lang === LANG_DEFAULT) ?? list[0])!.path;
  }

  /** Bitmap for a resource id (or constant name), magenta keyed out. */
  image(idOrName: number | string): Promise<ImageBitmap> {
    const id = typeof idOrName === "string" ? this.id(idOrName) : idOrName;
    const p = this.path(id);
    if (!p) return Promise.reject(new Error(`no UI bitmap for id ${id}`));
    return this.imageByPath(p).then((img) => {
      if (!this.ids.has(img)) this.ids.set(img, id);
      return img;
    });
  }

  /** cTSBuffer +0x30: the resource id a bitmap was first loaded by (image(id)), undefined for others. */
  idOf(img: ImageBitmap): number | undefined {
    return this.ids.get(img);
  }

  private readonly ids = new WeakMap<ImageBitmap, number>();

  /** The decoded pixels of a resource id, unkeyed (a TGA's own alpha kept: the Compose2 masks). */
  async rgba(id: number): Promise<RgbaImage> {
    const p = this.path(id);
    if (!p) throw new Error(`no UI bitmap for id ${id}`);
    return decodeImage(await this.readBytes(p), p);
  }

  /** Bitmap by its RT-style path ("CPanel/Buttons/ScrollLeft.bmp"). */
  imageByPath(p: string): Promise<ImageBitmap> {
    let cached = this.cache.get(p.toLowerCase());
    if (!cached) {
      cached = (async () => {
        const bytes = await this.readBytes(p);
        const img = decodeImage(bytes, p, { colorKey: true });
        return createImageBitmap(new ImageData(img.data, img.width, img.height));
      })();
      this.cache.set(p.toLowerCase(), cached);
    }
    return cached;
  }

  private async readBytes(rel: string): Promise<Uint8Array> {
    const loose = this.looseFiles.get((ROOT + rel.replace(/\\/g, "/")).toLowerCase());
    if (loose) {
      const bytes = await readAssetFile(loose).catch(() => null);
      if (bytes) return bytes;
    }
    return readFarEntry(FAR, rel.replace(/\//g, "\\"));
  }

  private async readText(rel: string): Promise<string> {
    const bytes = await this.readBytes(rel);
    return new TextDecoder("latin1").decode(bytes);
  }

  private async parseRt(text: string): Promise<void> {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line.startsWith("{")) continue;
      const fields = line.slice(1, line.lastIndexOf("}")).split(",").map((f) => f.trim());
      const kind = fields[0]!;
      if (kind === "INCLUDE") {
        this.parseHeader(await this.readText(fields[1]!));
        continue;
      }
      // The shipped tables reference a few undeclared names (kStudiownBulldoze);
      // the game ignores them, so do we.
      const id = this.constValueOrNull(fields[1]!);
      if (id === null) continue;
      const path = fields[2]!.replace(/^"|"$/g, "");
      const lang = fields[3] ? this.constValue(fields[3]) : LANG_DEFAULT;
      const list = this.entries.get(id) ?? [];
      list.push({ kind, path, lang });
      this.entries.set(id, list);
    }
  }

  private parseHeader(text: string): void {
    const re = /const\s+Sint32\s+(\w+)\s*=\s*(-?(?:0x[0-9a-fA-F]+|\d+))\s*;/g;
    for (const m of text.matchAll(re)) this.consts.set(m[1]!, Number(m[2]));
  }

  private constValueOrNull(token: string): number | null {
    if (/^-?(0x[0-9a-f]+|\d+)$/i.test(token)) return Number(token);
    return this.consts.get(token) ?? null;
  }

  private constValue(token: string): number {
    if (/^-?(0x[0-9a-f]+|\d+)$/i.test(token)) return Number(token);
    return this.id(token);
  }
}
