/**
 * Family and lot imports of the neighborhood screen (NghInterface.cpp:
 * GetImportInfoForFile, ImportFamily; Neighborhood::ImportFamily is
 * NeighborhoodStore.importFamily). The screen's dialogs are in
 * winneighborhoodul.ts (CycleThroughImports, CycleResidentialImports,
 * CycleCommunityImports).
 *
 * The original reads <neighborhood>/Import/ (*.FAM, *.rdt, *.cmt), which the
 * player fills from the Explorer. A page cannot browse the disk, so:
 *  - the files come from the server manifest (the game folder plus the
 *    writable overlay), like every other game file;
 *  - the families the other neighborhoods exported (UserData<N>/Export/*.FAM,
 *    written by Neighborhood::ExportFamily on a save, an eviction, a new
 *    family or an import) are offered after the Import/ ones, standing for
 *    the copy into Import/ the player did by hand. The original lists only
 *    Import/ (CycleThroughImports, CheckForNewImports: cTSDirectory on
 *    <dir>/Import with the pattern, GetImportInfoForFile only checks EXPi and
 *    FAMI), so it never offers a neighborhood's own exports: the current
 *    neighborhood's Export/ is left out here for the same reason (each
 *    SaveGame re-exports the family it saved);
 *  - files from the player's computer are uploaded into the overlay's
 *    <neighborhood>/Import/ (`uploadImports`, file input or drop).
 * Only overlay files can be deleted: a family imported from a read-only
 * Export/ file stays offered.
 */

import { assetFetch, fetchManifest, readFarEntry } from "../../engine/assets.js";
import type { GameContext } from "../context.js";
import { saveCharacter } from "../data/character.js";
import { deleteGameFile, writeGameFile } from "../data/files.js";
import { buildIff, decodeStrSet, parseIff, parseIffMapOrder, stringSetMultiSave, type IffChunk } from "../data/iff.js";
import { NeighborhoodStore } from "../data/nbhdstore.js";
import { decodeImage } from "../res/bmp.js";
import { UI_LANGUAGE } from "../res/uires.js";
import { ObjectFolder } from "../world/objectfolder.js";
import { readSimi } from "./nghinterface.js";
import { WinProgressPictureDialog } from "./winprogresspicturedialog.js";

/** cSimsApp::FindDataDirectory + GetStringConstant(0x58): the import folder of a neighborhood. */
export function importDir(nbhdDir: string): string {
  return `${nbhdDir}/Import`;
}

/** A lower-cased manifest path ("sims/userdata2/export/...") in the neighborhood's own Export folder. */
function isOwnExport(nbhdDir: string, lowerPath: string): boolean {
  return lowerPath.startsWith(`sims/${nbhdDir.toLowerCase()}/export/`);
}

/** The import kinds CycleThroughImports walks: "*.FAM", then "*.rdt" and "*.cmt" (lbl_105BCD5C +0x158 / +0x15e / +0x164). */
export interface ImportFiles {
  families: string[];
  residential: string[];
  community: string[];
}

/**
 * The files of <dir>/Import/ by kind (cTSDirectory with the pattern), then the
 * exported families of the other neighborhoods (see the file comment). Paths are
 * relative to the game folder.
 */
export async function listImports(nbhdDir: string): Promise<ImportFiles> {
  const { files } = await fetchManifest();
  const prefix = `Sims/${importDir(nbhdDir)}/`.toLowerCase();
  const out: ImportFiles = { families: [], residential: [], community: [] };
  const exported: string[] = [];
  for (const f of files) {
    const p = f.path.toLowerCase();
    if (p.startsWith(prefix) && !p.slice(prefix.length).includes("/")) {
      if (p.endsWith(".fam")) out.families.push(f.path.slice(5));
      else if (p.endsWith(".rdt")) out.residential.push(f.path.slice(5));
      else if (p.endsWith(".cmt")) out.community.push(f.path.slice(5));
    } else if (/^sims\/userdata\d*\/export\/[^/]+\.fam$/.test(p) && !isOwnExport(nbhdDir, p)) {
      exported.push(f.path.slice(5));
    }
  }
  out.families.push(...exported.sort());
  return out;
}

/**
 * The town screens' import files (cWinDowntown / cWinVacation /
 * cWinStudiotown::CycleThroughImports, cWinMagicland::CycleCommunityImports
 * and CycleResidentialImports): <dir>/Import/*.<ext> (dtl, vil, stl, mtl,
 * mtf). For the Magic Town families (mtf), the .MTF files the other
 * neighborhoods exported follow, as the .FAM ones do on the neighborhood
 * screen.
 */
export async function listTownImports(nbhdDir: string, ext: string): Promise<string[]> {
  const { files } = await fetchManifest();
  const prefix = `Sims/${importDir(nbhdDir)}/`.toLowerCase();
  const suffix = `.${ext.toLowerCase()}`;
  const out: string[] = [];
  const exported: string[] = [];
  for (const f of files) {
    const p = f.path.toLowerCase();
    if (!p.endsWith(suffix)) continue;
    if (p.startsWith(prefix) && !p.slice(prefix.length).includes("/")) out.push(f.path.slice(5));
    else if (ext.toLowerCase() === "mtf" && /^sims\/userdata\d*\/export\/[^/]+$/.test(p) && !isOwnExport(nbhdDir, p)) exported.push(f.path.slice(5));
  }
  out.push(...exported.sort());
  return out;
}

/**
 * The lot description a lot import writes: StringSetBase::Load of STR# 2000 +
 * house in <dir>/Houses/<file> (NeighborhoodDesc.iff, DTDesc.iff, ...),
 * SetString(1 / 2, current language), Save; nothing when the file or the set
 * is missing.
 */
export async function setLotDescription(nbhdDir: string, file: string, house: number, name: string, description: string): Promise<void> {
  const path = `${nbhdDir}/Houses/${file}`;
  const res = await assetFetch(`Sims/${path}`, { cache: "no-store" });
  if (!res.ok) return;
  const chunks = parseIff(new Uint8Array(await res.arrayBuffer()));
  const c = chunks.find((x): boolean => x.type === "STR#" && x.id === 2000 + house);
  if (!c) return;
  c.data = stringSetMultiSave(c.data, UI_LANGUAGE, [name, description]);
  await writeGameFile(path, buildIff(chunks));
}

/** cWinNeighborhoodUL::CheckForNewImports: any file to import. */
export async function hasImports(nbhdDir: string): Promise<boolean> {
  const l = await listImports(nbhdDir);
  return l.families.length + l.residential.length + l.community.length > 0;
}

async function readFile(path: string): Promise<Uint8Array | null> {
  const res = await assetFetch(`Sims/${path}`, { cache: "no-store" });
  return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
}

/** IFFResFile2::Open + ValidFile: the file's resources, null when it is not an IFF. */
export async function readImportFile(path: string): Promise<IffChunk[] | null> {
  const bytes = await readFile(path);
  if (!bytes) return null;
  try {
    return parseIff(bytes);
  } catch {
    return null;
  }
}

/** A BMP_ resource with the magenta color key (nsSMResFac::LoadBuffer + SetTransparency). */
async function bitmapOf(chunks: readonly IffChunk[], ...ids: number[]): Promise<ImageBitmap | null> {
  for (const id of ids) {
    const c = chunks.find((x) => x.type === "BMP_" && x.id === id);
    if (!c) continue;
    const img = decodeImage(c.data, "import.bmp");
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) if (d[i]! >> 3 === 31 && d[i + 1]! >> 3 === 0 && d[i + 2]! >> 3 === 31) d[i + 3] = 0;
    return createImageBitmap(new ImageData(d, img.width, img.height));
  }
  return null;
}

/** StringSetBase entry `i` (0-based) in US English, the language the imports read. */
function strEntry(chunks: readonly IffChunk[], type: string, id: number, i: number): string {
  const c = chunks.find((x) => x.type === type && x.id === id);
  if (!c) return "";
  const e = decodeStrSet(c.data);
  return (e.filter((x) => x.lang === 1)[i] ?? e[i])?.value ?? "";
}

/** ImportInfo: what the import dialog shows of a family file. */
export interface ImportInfo {
  path: string;
  chunks: IffChunk[];
  familyName: string;
  /** The house in the file (FAMI +0x110), 0 for none. */
  house: number;
  /** The lot's thumbnail (GetHouseInfo with images: BMP_ 0x400 / 0x464, else 0x200 / 0x264 halved). */
  image: ImageBitmap | null;
  /** ImportInfo +0x188: ExpFamilyInfo's language byte (streamed from version 0x3f on, else the game's language). */
  language: number;
  /**
   * ImportInfo +0x110 and HouseInfo +0x14 (+0x128): the file holds a SIMI
   * and its global 26 (Neighborhood::GetHouseFileInfo, cSimulator +0x44),
   * the tutorial lot. CycleThroughImports skips the character set test and the
   * dialog for it.
   */
  tutorial: boolean;
}

/**
 * cTSLanguageUtility::GetCharacterSetFromLanguage: the Windows code page of a
 * language. DoesLanguageUseWesternCharacterSet (1..11, 14) gives 1252,
 * DoesLanguageUseEasternCharacterSet (13, 16) 1250, then the jump table
 * lbl_105BCEB8 for 12..20 (mac.bin 0x1062a308), else 1252. The Windows
 * build (0x5fe3e1) is the same: its 13 -> 1251 case follows the Eastern test,
 * which already answered 1250 for Russian, so it is never reached (the only
 * vtable holding these methods, 0x6768e0, overrides neither test).
 */
export function getCharacterSetFromLanguage(lang: number): number {
  if (lang - 1 >= 0 && lang - 1 <= 0xd && ((1 << (lang - 1)) & 0x27ff) !== 0) return 1252;
  if (lang === 0x10 || lang === 0xd) return 1250;
  switch (lang) {
    case 12:
      return 1255;
    case 15:
      return 932;
    case 17:
      return 950;
    case 18:
      return 936;
    case 19:
      return 874;
    case 20:
      return 949;
    default:
      return 1252;
  }
}

/**
 * The test CycleThroughImports (cWinNeighborhoodUL, cWinMagicland
 * CycleResidentialImports) makes before the family dialog: the family file was
 * written in a language of another character set than the game's (cSimsApp
 * +100), and it is not the tutorial lot. The screen then shows STR# 154
 * entries 20 / 21 (OK / Delete) instead.
 */
export function isWrongCharacterSet(info: ImportInfo): boolean {
  return getCharacterSetFromLanguage(UI_LANGUAGE) !== getCharacterSetFromLanguage(info.language) && !info.tutorial;
}

/**
 * GetImportInfoForFile(path, info, 1): the file must hold EXPi 0 and the
 * family it names (Family::LoadFamily); name from CTSS 1000, else FAMs.
 */
export async function getImportInfoForFile(path: string): Promise<ImportInfo | null> {
  const chunks = await readImportFile(path);
  const expi = chunks?.find((c) => c.type === "EXPi" && c.id === 0);
  if (!chunks || !expi || expi.data.length < 14) return null;
  const ev = new DataView(expi.data.buffer, expi.data.byteOffset, expi.data.byteLength);
  const id = ev.getInt16(12, true);
  // SimpleReconObject<ExpFamilyInfo>::DoStream: id, 8 member ids, then (version > 0x3e) the language byte.
  const language = ev.getInt32(4, true) > 0x3e && expi.data.length > 30 ? expi.data[30]! : UI_LANGUAGE;
  const fami = chunks.find((c) => c.type === "FAMI" && c.id === id);
  if (!fami || fami.data.length < 16) return null;
  const house = new DataView(fami.data.buffer, fami.data.byteOffset, fami.data.byteLength).getInt32(12, true);
  const familyName = strEntry(chunks, "CTSS", 1000, 0) || strEntry(chunks, "FAMs", id, 0);
  let image: ImageBitmap | null = null;
  // GetHouseInfo succeeds (ImportInfo +0x110) when the file holds a SIMI; HouseInfo +0x14 is its global 26.
  const simi = chunks.find((c) => c.type === "SIMI");
  const tutorial = simi ? (readSimi(simi.data).globals[26] ?? 0) !== 0 : false;
  if (house !== 0) {
    image = await bitmapOf(chunks, 0x400, 0x464);
    if (!image) {
      const big = await bitmapOf(chunks, 0x200, 0x264);
      if (big) {
        const c = new OffscreenCanvas(Math.max(1, big.width >> 1), Math.max(1, big.height >> 1));
        c.getContext("2d")!.drawImage(big, 0, 0, c.width, c.height);
        image = await createImageBitmap(c);
      }
    }
  }
  return { path, chunks, familyName, house, image, language, tutorial };
}

/** Neighborhood::AddNewCharacter's templates: 0 TemplatePerson 0x7fd96b54, 1 the dog 0x4a70df92, 2 the cat 0x7bea0977. */
const CHARACTER_TEMPLATES = [0x7fd96b54, 0x4a70df92, 0x7bea0977] as const;

/** The resources of a template object, in map order (StubObject::CreateNew copies them). */
async function templateChunks(nbhdDir: string, kind: number): Promise<IffChunk[] | null> {
  const folder = await ObjectFolder.get(nbhdDir);
  const sel = await folder.getSelectorByGUID(CHARACTER_TEMPLATES[kind] ?? CHARACTER_TEMPLATES[0]);
  if (!sel) return null;
  const key = sel.fileKey;
  const bar = key.indexOf("|");
  const bytes = bar < 0 ? await readFile(key) : await readFarEntry(`Sims/${key.slice(0, bar)}`, key.slice(bar + 1));
  return bytes ? parseIffMapOrder(bytes) : null;
}

/**
 * ImportFamily(ImportInfo*, int*): Neighborhood::ImportFamily, then
 * PersonFinder::GenerateBitmaps(0x1f, save) of every member (here with their
 * strings: the new character files get the body strings, the catalog name and
 * description and the portraits) and Neighborhood::ExportFamily of the new
 * family (unless 4000) and of the family it displaced.
 *
 * Neighborhood::ImportFamily's file part: without a house the .FAM is deleted;
 * with one it becomes Houses/House%02d.iff (MoveFile through ".tmp"), with
 * the GUID translation saved into it. Then Neighborhood::Save.
 * Resolves with the house number (0 for none), or null on failure.
 */
export async function importFamily(nbhdDir: string, info: ImportInfo): Promise<number | null> {
  const store = await NeighborhoodStore.open(nbhdDir);
  const simi = info.chunks.find((c) => c.type === "SIMI");
  const tutorial = simi ? (readSimi(simi.data).globals[26] ?? 0) !== 0 : false;
  const done = await store.importFamily(info.chunks, (kind) => templateChunks(nbhdDir, kind), tutorial);
  if (!done) return null;
  if (done.house !== 0) {
    const chunks = info.chunks.filter((c) => !(c.type === "Gtab" && c.id === 1));
    if (done.gtab) chunks.push(done.gtab);
    await writeGameFile(`${nbhdDir}/Houses/House${String(done.house).padStart(2, "0")}.iff`, buildIff(chunks));
  }
  await deleteGameFile(info.path).catch(() => undefined);
  await store.save();
  const { generatePortraits } = await import("../cas/portraits.js");
  for (const m of done.members) {
    const bitmaps = await generatePortraits(m.bodyStrings).catch(() => new Map<number, Uint8Array>());
    await saveCharacter(nbhdDir, m.fileName, { firstName: m.firstName, bio: m.bio, bodyStrings: m.bodyStrings, bitmaps });
  }
  if (done.familyId !== 4000) await store.exportFamily(done.familyId);
  if (done.displaced > 0) await store.exportFamily(done.displaced);
  return done.house;
}

/** A lot file (.rdt / .cmt): STR# 2000 entries 1..3 (name, description, house number) and its picture (BMP_ 0x200). */
export interface LotImportInfo {
  path: string;
  bytes: Uint8Array;
  name: string;
  description: string;
  house: number;
  image: ImageBitmap | null;
}

export async function getLotImportInfo(path: string): Promise<LotImportInfo | null> {
  const bytes = await readFile(path);
  if (!bytes) return null;
  let chunks: IffChunk[] = [];
  try {
    chunks = parseIff(bytes);
  } catch {
    // IFFResFile2::Open failed: empty strings, house 0 (atoi of "").
  }
  return {
    path,
    bytes,
    name: strEntry(chunks, "STR#", 2000, 0),
    description: strEntry(chunks, "STR#", 2000, 1),
    house: Number.parseInt(strEntry(chunks, "STR#", 2000, 2), 10) || 0,
    image: await bitmapOf(chunks, 0x200),
  };
}

/**
 * The file part of an accepted lot import: IFFResFile2::Delete of the house
 * file, CopyFile of the lot file onto it, IFFResFile2::Delete of the lot file.
 */
export async function importLotFile(nbhdDir: string, lot: LotImportInfo): Promise<void> {
  await writeGameFile(`${nbhdDir}/Houses/House${String(lot.house).padStart(2, "0")}.iff`, lot.bytes);
  await deleteGameFile(lot.path).catch(() => undefined);
}

/**
 * The web side of the Explorer copy into Import/: files from the player's
 * computer go to the overlay's <neighborhood>/Import/. .FAM, .MTF (Magic
 * Town families, imported from the Magic Town screen only), .rdt, .cmt and
 * the town lots (.dtl, .vil, .stl, .mtl) keep their names; an .iff becomes
 * a family when it holds EXPi 0 (an exported family), else a residential lot
 * (.rdt). Resolves with the names written.
 */
export async function uploadImports(nbhdDir: string, files: Iterable<File>): Promise<string[]> {
  const written: string[] = [];
  for (const f of files) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const dot = f.name.lastIndexOf(".");
    const base = dot < 0 ? f.name : f.name.slice(0, dot);
    const ext = dot < 0 ? "" : f.name.slice(dot + 1).toLowerCase();
    let name: string;
    if (ext === "fam") name = `${base}.FAM`;
    else if (ext === "mtf") name = `${base}.MTF`;
    else if (TOWN_LOT_EXTS.includes(ext) || ext === "rdt" || ext === "cmt") name = `${base}.${ext}`;
    else if (ext === "iff") {
      let family = false;
      try {
        family = parseIff(bytes).some((c) => c.type === "EXPi" && c.id === 0);
      } catch {
        continue;
      }
      name = `${base}.${family ? "FAM" : "rdt"}`;
    } else continue;
    await writeGameFile(`${importDir(nbhdDir)}/${name}`, bytes);
    written.push(name);
  }
  return written;
}

/** The town lot files (Downtown, Vacation, Studio Town, Magic Town). */
const TOWN_LOT_EXTS = ["dtl", "vil", "stl", "mtl"];

/** Opens the browser's file picker (works in Firefox: no File System Access API) and uploads the choice. */
export function pickAndUploadImports(nbhdDir: string): Promise<string[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = ".fam,.FAM,.mtf,.MTF,.iff,.IFF,.rdt,.cmt,.dtl,.vil,.stl,.mtl";
    input.style.display = "none";
    document.body.appendChild(input);
    const finish = (names: string[]): void => {
      input.remove();
      resolve(names);
    };
    input.addEventListener("change", () => void uploadImports(nbhdDir, input.files ?? []).then(finish, () => finish([])));
    input.addEventListener("cancel", () => finish([]));
    input.click();
  });
}

// ---------------------------------------------------------------------------
// Unleashed import (Neighborhood::NeedsUnleashedImport / TryImportUnleashedFamilies)

/** cSimsApp +0x66 bit 5: Unleashed installed. */
const PACK_UNLEASHED = 0x20;
/** The family number the Unleashed strays take (Strays_4000.FAM). */
const STRAYS_FAMILY = 4000;
/** UIText STR# 270: the progress dialog's title and text. */
const STR_UNLEASHED_IMPORT = 0x10e;
/** cWinProgressPictureDialog::SetTotal in ImportUnleashedFamilies. */
const UNLEASHED_IMPORT_TOTAL = 7;

/**
 * GetStringConstant(0x59) after ExtractDirectory of the neighborhood file:
 * <neighborhood>/Patch/, which CopyMissingUnleashedFilesIntoUserData fills
 * from TemplateUserData/Patch/.
 */
function patchDir(nbhdDir: string): string {
  return `${nbhdDir}/Patch`;
}

/** Neighborhood::NeedsUnleashedImport: Unleashed is installed and NGBH +0x1a6 is set (DoStream sets it for files older than version 0x45). */
export async function needsUnleashedImport(store: NeighborhoodStore): Promise<boolean> {
  if (((await ObjectFolder.get(store.dir)).packs & PACK_UNLEASHED) === 0) return false;
  return store.ngbh().b1a6;
}

/** The *.FAM files of <dir>/Patch/ (cTSDirectory with SetNewDirectoryEntryFilter("*.FAM")), in NTFS name order. */
async function listPatchFamilies(nbhdDir: string): Promise<string[]> {
  const prefix = `Sims/${patchDir(nbhdDir)}/`.toLowerCase();
  const out = (await fetchManifest()).files
    .map((f) => f.path)
    .filter((p) => p.toLowerCase().startsWith(prefix) && !p.slice(prefix.length).includes("/") && p.toLowerCase().endsWith(".fam"))
    .map((p) => p.slice("Sims/".length));
  return out.sort((a, b) => (a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0));
}

/**
 * Neighborhood::ImportUnleashedFamilies: a cWinProgressPictureDialog (UIText
 * STR# 270 entries 1 / 2, kNghPic, total 7), then every <dir>/Patch/*.FAM
 * once (the directory is read again after each one, the files already seen
 * kept in a set): its read-only attribute cleared, GetImportInfoForFile(path,
 * info, 0) and, when it accepts the file, ImportFamily (no dialog, no zoning
 * change); TickOnce after each file.
 * Not ported: the string set language calls made before ImportFamily (a
 * vtable chain on lbl_105BA104 given the game's language and the info's).
 */
async function importUnleashedFamilies(ctx: GameContext, nbhdDir: string): Promise<void> {
  const str = (i: number): string => ctx.strings.get("UIText", STR_UNLEASHED_IMPORT, i - 1);
  const dlg = new WinProgressPictureDialog(ctx);
  await dlg.init();
  await dlg.setTitle(str(1));
  dlg.addText(str(2));
  dlg.setImage(await ctx.res.image(0x13ce /* kNghPic */).catch(() => null));
  dlg.setTotal(UNLEASHED_IMPORT_TOTAL);
  await dlg.show();
  try {
    const seen = new Set<string>();
    for (;;) {
      const path = (await listPatchFamilies(nbhdDir)).find((p) => !seen.has(p));
      if (path === undefined) break;
      seen.add(path);
      const info = await getImportInfoForFile(path);
      if (info) await importFamily(nbhdDir, info).catch((e: unknown) => console.warn(`[import] ${path}`, e));
      await dlg.tickOnce();
    }
  } finally {
    dlg.close();
  }
}

/**
 * Neighborhood::TryImportUnleashedFamilies (Unleashed installed): when NGBH
 * +0x1a6 is set, a family numbered 4000 moves to the largest number + 1,
 * ImportUnleashedFamilies runs and +0x1a6 is cleared; then the neighborhood
 * is saved. (The store is saved before the imports here: each ImportFamily
 * reads and saves the neighborhood file, as Neighborhood::ImportFamily saves
 * the in-memory one with the renumbering.)
 */
export async function tryImportUnleashedFamilies(ctx: GameContext, nbhdDir: string): Promise<void> {
  let store = await NeighborhoodStore.open(nbhdDir);
  if (((await ObjectFolder.get(nbhdDir)).packs & PACK_UNLEASHED) === 0) return;
  if (store.ngbh().b1a6) {
    const ids = store.familyIds();
    if (ids.includes(STRAYS_FAMILY)) {
      store.renumberFamily(STRAYS_FAMILY, Math.max(0, ...ids) + 1);
      await store.save();
    }
    await importUnleashedFamilies(ctx, nbhdDir);
    store = await NeighborhoodStore.open(nbhdDir);
    store.ngbh().b1a6 = false;
    store.touchNgbh();
  }
  await store.save();
}
