/**
 * Character files (UserData<N>/Characters/User%05d.iff), write side.
 *
 *  - createCharacterFile: StubObject::CreateNew (called by
 *    Neighborhood::AddNewCharacter) copies every resource of the template
 *    person object (GameData/Objects/Objects.far "People\TemplatePerson.iff",
 *    the selector of the neighbor whose GUID is 0x7fd96b54) into the new
 *    file, in the template's resource order. The OBJD gets a new GUID
 *    (timeGetTime() << 16 ^ rand()), keeps the template GUID at +0x8c and its
 *    label gets the prefix "User%05d " (StubObject::SetPrefix).
 *  - saveCharacter: what PersonFinder::EndDesignAPerson(save) leaves in the
 *    file: PersonFinder::SetName / SetDescription (CatalogResource::Save into
 *    CTSS <OBJD+0x52> through StringSetMulti, a CATS chunk of that id removed;
 *    ObjSelector::SetObjectName "<short name> - <first name>" on the OBJD),
 *    BodyStrings::Save (STR# <OBJD+0x26> "bodystring", every entry in
 *    language 1) and the portraits of PersonFinder::GenerateBitmaps
 *    (save_image_to_file, BMP_ 2002..2007).
 *
 * The game edits these files in place through iResFile (replaced resources
 * leave "XXXX" holes); we rebuild the whole file with the resources in the
 * same order instead (data/iff.ts).
 */

import { assetFetch, readFarEntry } from "../../engine/assets.js";
import { LANG_FRENCH } from "../res/uires.js";
import { deleteGameFile, writeGameFile } from "./files.js";
import { buildIff, decodeStrSet, encodeStrSet, parseIffMapOrder, stringSetMultiSave, type IffChunk } from "./iff.js";

/** Neighborhood::AddNewCharacter: the template object per character type (adult, dog, cat). */
export const GUID_TEMPLATE_PERSON = 0x7fd96b54;
const TEMPLATE_FAR = "Sims/GameData/Objects/Objects.far";
const TEMPLATE_ENTRY = "People\\TemplatePerson.iff";

/** OBJD byte offsets (the in-memory OBJD of the game has the file layout). */
const OBJD_GUID = 0x1c;
const OBJD_BODY_STRINGS_ID = 0x26;
const OBJD_CATALOG_STRINGS_ID = 0x52;
const OBJD_ORIGINAL_GUID = 0x8c;

/** Flags of the OBJD chunks in character files the game wrote (CreateNew passes 0, SetObjectName rewrites it). */
const OBJD_FLAGS = 0x10;
/** Flags the game gives the resources it adds to character files (BMP_, CTSS, STR# 200). */
const ADDED_FLAGS = 0x10;

/** save_image_to_file labels (PersonFinder::GenerateBitmaps). */
export const PORTRAIT_LABELS: Record<number, string> = {
  2002: "faces",
  2003: "rel. images",
  2004: "newimage",
  2005: "speech_med",
  2006: "speech_large",
  2007: "web_image",
};

/** StringSetBase name of the body strings (BodyStrings). */
const BODY_STRINGS_LABEL = "bodystring";

/** The game's current language (cSimsApp +100), the slot StringSetMulti saves into. */
const CURRENT_LANG = LANG_FRENCH;

/** rand_override: the game's rand(), 15 bits. */
function rand(): number {
  return Math.floor(Math.random() * 0x8000);
}

/** StubObject::CreateNew: the new character file's resources. */
export async function createCharacterFile(dir: string, fileName: string, baseName: string): Promise<{ guid: number; bytes: Uint8Array }> {
  const template = parseIffMapOrder(await readFarEntry(TEMPLATE_FAR, TEMPLATE_ENTRY));
  return createCharacterFileFrom(dir, fileName, baseName, template);
}

/** OBJD object type (+0x12). */
const OBJD_TYPE = 0x12;

/**
 * StubObject::CreateNew of any person template (TemplatePerson, the
 * TemplateNPCs townies): the template's resources copied in map order, a new
 * GUID, the "User%05d " label prefix. `objectType`, when given, is written to
 * the OBJD (Neighborhood::AddNewTownie sets the new townie's type to 2,
 * person, then ObjSelector::ChangedDef saves it).
 */
export async function createCharacterFileFrom(
  dir: string,
  fileName: string,
  baseName: string,
  template: readonly IffChunk[],
  objectType?: number,
): Promise<{ guid: number; bytes: Uint8Array }> {
  // timeGetTime() << 16 ^ rand()
  const guid = (((Math.trunc(performance.now()) << 16) ^ rand()) >>> 0) || 1;
  // StubObject::SetPrefix("User%05d" + " ")
  const prefix = `${baseName} `;
  const chunks = template.map((c): IffChunk => {
    if (c.type !== "OBJD") return { ...c, data: c.data.slice() };
    const data = c.data.slice();
    const v = new DataView(data.buffer);
    v.setUint32(OBJD_ORIGINAL_GUID, v.getUint32(OBJD_GUID, true), true);
    v.setUint32(OBJD_GUID, guid, true);
    if (objectType !== undefined) v.setInt16(OBJD_TYPE, objectType, true);
    return { ...c, flags: OBJD_FLAGS, label: prefix + c.label, data };
  });
  const bytes = buildIff(chunks);
  await writeGameFile(`${dir}/Characters/${fileName}`, bytes);
  return { guid, bytes };
}

/** The resources of a character file, in resource-map order (read fresh, never cached). */
export async function readCharacterFile(dir: string, fileName: string): Promise<IffChunk[]> {
  const res = await assetFetch(`Sims/${dir}/Characters/${fileName}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`${dir}/Characters/${fileName}: ${res.status}`);
  return parseIffMapOrder(new Uint8Array(await res.arrayBuffer()));
}

/** PersonFinder::GetName from the file: CTSS <OBJD+0x52> entry 1 in the current language, else US English; "" without one. */
export async function readCharacterFirstName(dir: string, fileName: string): Promise<string> {
  const chunks = await readCharacterFile(dir, fileName).catch(() => null);
  const objd = chunks?.find((x) => x.type === "OBJD");
  if (!chunks || !objd) return "";
  const id = new DataView(objd.data.buffer, objd.data.byteOffset, objd.data.byteLength).getInt16(OBJD_CATALOG_STRINGS_ID, true);
  const ctss = chunks.find((x) => x.type === "CTSS" && x.id === id);
  if (!ctss) return "";
  const e = decodeStrSet(ctss.data);
  return (e.filter((x) => x.lang === CURRENT_LANG)[0] ?? e.filter((x) => x.lang === 1)[0] ?? e[0])?.value ?? "";
}

export async function deleteCharacterFile(dir: string, fileName: string): Promise<void> {
  await deleteGameFile(`${dir}/Characters/${fileName}`);
}

export interface CharacterSave {
  firstName: string;
  bio: string;
  /** STR# 200, entry 1 first. */
  bodyStrings: string[];
  /** BMP_ chunk id -> BMP bytes (data/bmpwrite.ts). */
  bitmaps?: Map<number, Uint8Array>;
}

function put(chunks: IffChunk[], c: IffChunk): void {
  const i = chunks.findIndex((x) => x.type === c.type && x.id === c.id);
  if (i >= 0) chunks[i] = c;
  else chunks.push(c);
}

/** PersonFinder::EndDesignAPerson(save = true): name, biography, body strings and portraits. */
export async function saveCharacter(dir: string, fileName: string, c: CharacterSave): Promise<void> {
  const chunks = await readCharacterFile(dir, fileName);
  const objd = chunks.find((x) => x.type === "OBJD");
  if (!objd) throw new Error(`${fileName}: no OBJD`);
  const ov = new DataView(objd.data.buffer, objd.data.byteOffset, objd.data.byteLength);
  const catalogId = ov.getInt16(OBJD_CATALOG_STRINGS_ID, true);
  const bodyId = ov.getInt16(OBJD_BODY_STRINGS_ID, true);

  // PersonFinder::SetName + SetDescription -> CatalogResource::Save.
  const old = chunks.find((x) => x.type === "CTSS" && x.id === catalogId);
  put(chunks, {
    type: "CTSS",
    id: catalogId,
    flags: old?.flags ?? ADDED_FLAGS,
    label: old?.label ?? "",
    data: stringSetMultiSave(old?.data ?? null, CURRENT_LANG, [c.firstName, c.bio]),
  });
  const cats = chunks.findIndex((x) => x.type === "CATS" && x.id === catalogId);
  if (cats >= 0) chunks.splice(cats, 1);
  // ObjSelector::SetObjectName(GetShortFilename + " - " + name)
  const shortName = fileName.replace(/\.iff$/i, "").toLowerCase();
  put(chunks, { ...objd, label: `${shortName} - ${c.firstName}` });

  // BodyStrings::Save (strings loaded with LoadOnlyEnglish: language 1).
  const oldBody = chunks.find((x) => x.type === "STR#" && x.id === bodyId);
  put(chunks, {
    type: "STR#",
    id: bodyId,
    flags: oldBody?.flags ?? ADDED_FLAGS,
    label: oldBody?.label || BODY_STRINGS_LABEL,
    data: encodeStrSet(c.bodyStrings.map((value) => ({ lang: 1, value, comment: "" }))),
  });

  for (const [id, bytes] of c.bitmaps ?? []) {
    put(chunks, { type: "BMP_", id, flags: ADDED_FLAGS, label: PORTRAIT_LABELS[id] ?? "", data: bytes });
  }
  await writeGameFile(`${dir}/Characters/${fileName}`, buildIff(chunks));
}

/**
 * PersonFinder::SetDescription alone (cWinEditBio's OK): CatalogResource::Save
 * of the catalog name and the new description into CTSS <OBJD+0x52>, a CATS
 * chunk of that id removed. The rest of the file is kept.
 */
export async function saveCharacterDescription(dir: string, fileName: string, name: string, bio: string): Promise<void> {
  const chunks = await readCharacterFile(dir, fileName);
  const objd = chunks.find((x) => x.type === "OBJD");
  if (!objd) throw new Error(`${fileName}: no OBJD`);
  const ov = new DataView(objd.data.buffer, objd.data.byteOffset, objd.data.byteLength);
  const catalogId = ov.getInt16(OBJD_CATALOG_STRINGS_ID, true);
  const old = chunks.find((x) => x.type === "CTSS" && x.id === catalogId);
  put(chunks, {
    type: "CTSS",
    id: catalogId,
    flags: old?.flags ?? ADDED_FLAGS,
    label: old?.label ?? "",
    data: stringSetMultiSave(old?.data ?? null, CURRENT_LANG, [name, bio]),
  });
  const cats = chunks.findIndex((x) => x.type === "CATS" && x.id === catalogId);
  if (cats >= 0) chunks.splice(cats, 1);
  await writeGameFile(`${dir}/Characters/${fileName}`, buildIff(chunks));
}

/** The body strings stored in a character file (STR# <OBJD+0x26>), entry 1 first. */
export function bodyStringsOf(chunks: IffChunk[]): string[] {
  const objd = chunks.find((x) => x.type === "OBJD");
  const id = objd ? new DataView(objd.data.buffer, objd.data.byteOffset, objd.data.byteLength).getInt16(OBJD_BODY_STRINGS_ID, true) : 200;
  const c = chunks.find((x) => x.type === "STR#" && x.id === id);
  return c ? decodeStrSet(c.data).filter((e) => e.lang === 1).map((e) => e.value) : [];
}

/** lbl_105BBB34: how many interests RandomizeAllInterests puts in each band (low, middle, high). */
const INTEREST_BANDS = [4, 3, 3];

/** One RandomizeAllInterests draw: a band with draws left, then a value in it (x 100). */
function drawInterest(left: number[]): number {
  let band: number;
  do band = rand() % 3;
  while (left[band]! < 1);
  left[band]!--;
  const v = band === 1 ? (rand() % 3) + 4 : band === 0 ? rand() % 4 : band === 2 ? (rand() % 4) + 7 : 10;
  return v * 100;
}

/**
 * cXPerson::RandomizeAllInterests on person data: interests 46..55 drawn
 * from the 4/3/3 bands, then the five later interests (13, 14, 16, 20, 26)
 * from 1/2/2 bands. cXPerson::Initialize runs it when every interest 46..53
 * is below 11 (a new person).
 */
export function randomizeAllInterests(pd: Int16Array): void {
  const left = [...INTEREST_BANDS];
  for (let i = 0; i < 10; i++) pd[46 + i] = drawInterest(left);
  const later = [1, 2, 2];
  for (const index of [13, 14, 16, 20, 26]) pd[index] = drawInterest(later);
}

/** cXPerson::Initialize's test before RandomizeAllInterests. */
export function needsInterests(pd: Int16Array): boolean {
  for (let i = 46; i <= 53; i++) if ((pd[i] ?? 0) >= 11) return false;
  return true;
}
