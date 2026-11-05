/**
 * The family web pages (exporthtml.cpp, Mac 10216510..10220d10, and the
 * parts of cSimsApp / cWinNeighborhoodUL / PersonFinder / HouseViewer that
 * feed them).
 *
 * ExportFamilyHTML(family) (Mac 102288e0):
 *  - nothing for the special families (numbers 2000, 4000, 5000, 5500,
 *    6000, 3000..3009);
 *  - a family without a house: UnloadHouse, ExportHTMLHomelessFamilies;
 *  - else the family's house (the lot shown when it is the current one, else
 *    Neighborhood::LoadHouse; no export when that fails): ExportHTML;
 *  - then Family +0x138 = (flags & ~0x18) | 0x18, also saved into
 *    Neighborhood.iff (Family::LoadFamily / SaveFamily of that one family).
 * Its callers: cSimsApp::SaveGame (after Neighborhood::ExportFamily, when
 * FreeMem() > 0xa00000 and cOptionsMgr::GetExportHTML), EvictFamily (after
 * ExportFamily, when the option is on), FinishFamily (Create-a-Family) and
 * cWinNeighborhoodUL::DoInternetUpdate.
 *
 * Paths: the templates are the runtime folder's "UserData\Web Templates\"
 * (ConstructRuntimePath(GetStringConstant(7), GetStringConstant(0x56)):
 * always UserData, whatever the neighborhood) plus the language folder
 * (Windows FUN_004dba5d on app +100; the Mac build knows french / german /
 * english only); the pages go to the neighborhood's "Web Pages\"
 * (ConstructUserDataPath(0x55)), the .pub to its "Export\" (0x57).
 *
 * ExportHTML(templates, web pages, family, CPState): 427 tags
 * (GenerateLookupTagsList) and their values (GenerateHouseData,
 * GenerateFamilyAndScrapbookData), then, with T = <templates><lang>/<house>_Sim_Lane/
 * and O = <web pages><name>_<house>_Sim_Lane/ (spaces in the name made "_"):
 *  1. every file of T/StockGFX/ copied to O/StockGFX/, O/FamilyGFX/ made;
 *  2. every file of T: .htm / .html through MakeWebPagesFromTemplate into O,
 *     the others copied;
 *  3. GenerateFamilyMemberJPEGs into O/FamilyGFX/;
 *  4. HouseViewer::MakeWebPageThumbnail into O/FamilyGFX/: house-thumb.jpg
 *     (level 0, real offsets, thumbnail on the neighborhood picture),
 *     house-exterior.jpg (level 0, centered), house-floor1.jpg (level 1),
 *     house-floor2.jpg (level 2, only when CPState::HasBeenTo2ndLevel), all on
 *     (0x77, 0xa5, 0x8b);
 *  5. MakePublishingInfo("<name>_<house>_Sim_Lane/", "<name>_<family number>").
 * ExportHTMLHomelessFamilies: T = <templates><lang>/0_Sim_Lane/, O = <web pages><name>/,
 * GenerateHomelessHouseData, no house picture, the .pub's WebPages "<name>/".
 * ExportHTMLNeighborhood (ExportNghHTML, at the end of DoInternetUpdate):
 * <templates><lang>/NeighborhoodGFX/* copied to <web pages>NeighborhoodGFX/,
 * lot<N>thumb.gif per zoning list entry (a copy of NeighborhoodGFX/StockGFX/
 * onestoryhouse.gif or emptylot.gif: the shipped templates have no StockGFX
 * folder there, so the original's copies fail too), then the templates' root
 * files (.htm / .html through MakeWebPagesFromTemplate with the 10
 * neighborhood tags, the others copied) into <web pages>.
 *
 * MakeWebPageX copies a template byte by byte, replacing each ^^^^tag^^^^
 * found in the tag list by its value (X in a tag name becomes the page
 * number when there is one), with the original's tokenizer (see makeWebPageX).
 * The page values are written as the game's 8-bit characters (cp1252).
 *
 * MakePublishingInfo: <neighborhood>/Export/<base>.pub, an ini text
 * ([Content], [FamilyHouse], [FamilyInfo] = tags 0..19 and the members' 25
 * tags each, [FamilyDescription], the body strings of the members, the
 * house's floors, walls and download objects) through htmlEncrypt /
 * simpleEncode (running XOR from 0xbf, then a 4-byte checksum). Checked
 * against the game's own UserData/Export/*.pub (they decode with the same
 * rule and checksum).
 *
 * Pictures: SaveGimex(file, buffer, rect, quality, logo) is the browser's
 * JPEG encoder here (canvas convertToBlob("image/jpeg", quality / 100):
 * same size and quality setting, other bytes). The family pictures are the
 * person's web picture (BMP_ 2007, PersonFinder::GetWebPictureBuffer) at
 * quality 100 and SAnimator::MakePersonBodyImage at quality 100; the house
 * pictures are rendered by the lot's HouseViewer as MakeThumbnail does
 * (world/thumbnail.ts) at quality 90 with ApplyLogo (kWebcamLogo /
 * kWebcamLogoAlpha in the bottom right corner).
 *
 * Not ported: cTSFile::SetAttribute (read-only bits), the
 * FreeMem() test (taken as true), cRZVersion::GetModuleVersion (the
 * shipped Sims.exe's FileVersion "1.91" is used), empty folders (the
 * overlay has none: StockGFX / FamilyGFX exist once a file is in them).
 */

import { fetchManifest, readAssetFile } from "../../engine/assets.js";
import { MUSIC, soundPlayer } from "../audio/index.js";
import { computeZodiacSign, getZodiacName } from "../cas/zodiac.js";
import { personBitmap } from "../cas/personpictures.js";
import { scaleTf } from "../cas/portraits.js";
import type { GameContext } from "../context.js";
import { Scrapbook } from "../cpanel/camscrapbook.js";
import { careerById, jobName, loadCareers, type Job } from "../cpanel/live/careers.js";
import { writeGameFile } from "../data/files.js";
import { NeighborhoodStore, type FamilyView } from "../data/nbhdstore.js";
import { loadCharacter, loadNeighborhood } from "../data/neighborhood.js";
import { encodeCp1252 } from "../data/recon.js";
import { getOptionsMgr } from "../optionsmgr.js";
import { decodeImage } from "../res/bmp.js";
import { UI_LANGUAGE, UIRes } from "../res/uires.js";
import { loadStringSet } from "../sim/behavior.js";
import { getGrade, loadJobGrades } from "../sim/careers.js";
import { getTitleFromLevel, loadFameTitles } from "../sim/fametrack.js";
import { SimResources } from "../sim/simmodule.js";
import { G } from "../sim/simulator.js";
import { BodyStrings } from "../sims/bodystrings.js";
import { unproject, type SimView } from "../sims/camera.js";
import { mat4Mul, rotationTf, translationTf } from "../sims/math3d.js";
import { SimRenderer } from "../sims/renderer.js";
import { SAnimator } from "../sims/sanimator.js";
import { IDYES, MB_YESNO, TSWinMsgBox } from "../ui/msgbox.js";
import { getCheatCodeManager } from "../ui/cheat.js";
import { WinPictureDialog } from "../ui/picturedialog.js";
import { WallState } from "../cpstate.js";
import { Compositor } from "../world/compositor.js";
import { FloorGraphicsMgr, parseUsageMap, parseUsageMapBytes } from "../world/floors.js";
import { moduleOrder } from "../world/housesave.js";
import { clearLayoutHistory, getHouseStats, piecewiseFromText, readLayoutHistory, STR_HOUSE_SCORE_CURVES, type HousePageStats } from "../world/housestats.js";
import { HouseViewer } from "../world/houseviewer.js";
import { ResFile } from "../world/iffres.js";
import { RoomLighting } from "../world/lighting.js";
import { customWallStyleOf, loadLotObjectDrawer } from "../world/lotobjects.js";
import { ObjectFolder } from "../world/objectfolder.js";
import type { ObjectModule } from "../world/objects.js";
import type { ObjSelector } from "../world/objselector.js";
import { loadRoofSettings, roofLayersOf } from "../world/roofs.js";
import { computeRooms, RoomManager } from "../world/rooms.js";
import { houseNumberOfPath, Terrain } from "../world/terrain.js";
import { WallManager } from "../world/walls.js";
import type { WinLotView } from "../world/winlotview.js";
import { readLotSize } from "../world/winlotview.js";
import { RotatableWorld, FixedWorld } from "../world/world.js";
import { getHouseInfo, Neighborhood, readSimi } from "./nghinterface.js";

// ---------------------------------------------------------------------------
// Constants (lbl_105BC140 strings, lbl_105BC13C, GetStringConstant)

/** app +100: the game's language (engine/language.ts). */
const LANG: number = UI_LANGUAGE;
/** GetStringConstant(7) + GetStringConstant(0x56): the templates (runtime path, always UserData). */
const TEMPLATES = "UserData/Web Templates/";
/** GetStringConstant(0x55) / (0x57): the neighborhood's folders. */
const WEB_PAGES = "Web Pages/";
const EXPORT_DIR = "Export/";
const STOCK_GFX = "StockGFX/";
const FAMILY_GFX = "FamilyGFX/";
const NEIGHBORHOOD_GFX = "NeighborhoodGFX/";
const SIM_LANE = "_Sim_Lane";
/** The special families ExportFamilyHTML and DoInternetUpdate skip (+0x10c). */
const SPECIAL_FAMILY_NUMBERS = new Set([2000, 4000, 5000, 5500, 6000]);
/** GetFamiliesNeedingHTMLExport's static (lbl_105C0590): the Unleashed re-export runs once per session. */
let unleashedReexportDone = false;
/** Family +0x138 bit 3: the family's web pages are up to date; ExportFamilyHTML sets 0x18. */
const FLAG_HTML_EXPORTED = 8;
const FLAGS_AFTER_EXPORT = 0x18;
/** app +0x66 bits: 0x20 Unleashed (the neighborhood's zoning list), 0x40 Superstar (fame), 0x80 Makin' Magic. */
const EDITION_UNLEASHED = 0x20;
const EDITION_SUPERSTAR = 0x40;
const EDITION_MAGIC = 0x80;
/** cRZVersion::GetModuleVersion: Sims.exe's VERSIONINFO FileVersion (the shipped .pub files say 1.91). */
const GAME_VERSION = "1.91";
/** htmlEncrypt's buffer (64000 bytes). */
const PUB_MAX = 64000;
/** The tag count of GenerateLookupTagsList. */
const TAG_COUNT = 0x1ab;
const MEMBER_TAGS = 0x19;
const MAX_MEMBERS = 8;
const MAX_CAPTIONS = 200;
/** Tag indices (GenerateLookupTagsList). */
const T = {
  houseValue: 0,
  houseAddress: 1,
  lotSize: 2,
  squareFeet: 3,
  bathrooms: 4,
  bedrooms: 5,
  floors: 6,
  sizeScore: 7,
  furnishingsScore: 8,
  yardScore: 9,
  upkeepScore: 10,
  layoutScore: 11,
  cash: 12,
  days: 13,
  members: 14,
  friends: 15,
  name: 16,
  cheats: 17,
  charset: 18,
  language: 19,
  caption: 20,
  snapshot: 21,
  pages: 22,
  page: 23,
  prev: 24,
  next: 25,
  magicTokens: 26,
  member0: 27,
  caption0: 27 + MEMBER_TAGS * MAX_MEMBERS,
} as const;
/** lbl_105BC140 + 0x682 ...: the first 27 tags, in list order. */
const FAMILY_TAGS = [
  "sims_house_value",
  "sims_house_address",
  "sims_house_lotsize",
  "sims_house_squarefeet",
  "sims_house_numbathrooms",
  "sims_house_numbedrooms",
  "sims_house_numfloors",
  "sims_house_ratings_size",
  "sims_house_ratings_furnishings",
  "sims_house_ratings_yard",
  "sims_house_ratings_upkeep",
  "sims_house_ratings_layout",
  "sims_family_cashbalance",
  "sims_family_daysexist",
  "sims_family_nummembers",
  "sims_family_numfriends",
  "sims_family_name",
  "sims_family_cheats",
  "sims_web_character_set",
  "sims_web_language_code",
  "sims_scrapbookX_caption",
  "sims_scrapbookX_snapshot",
  "sims_scrapbook_numpages",
  "sims_scrapbook_currpagenum",
  "sims_scrapbook_prevpage",
  "sims_scrapbook_nextpage",
  "sims_family_magic_token_count",
];
/** lbl_105BC140 + 0x9a6 ...: the member tag suffixes ("^^^^sims_familymember<n>" + suffix). */
const MEMBER_TAG_SUFFIXES = [
  "_name",
  "_number",
  "_gender",
  "_kidadult",
  "_career",
  "_job",
  "_performance",
  "_salary",
  "_description",
  "_guid",
  "_personality_neat",
  "_personality_outgoing",
  "_personality_active",
  "_personality_playful",
  "_personality_nice",
  "_skill_cooking",
  "_skill_mechanical",
  "_skill_charisma",
  "_skill_body",
  "_skill_logic",
  "_skill_creativity",
  "_zodiac",
  "_species",
  "_famescore",
  "_has_wand",
];
/** GenerateNeighborhoodLookupTagsList (lbl_105BC140 + 0x90 ...). */
const NEIGHBORHOOD_TAGS = [
  "sims_neighborhood_numfamilies",
  "sims_neighborhood_familyX_id",
  "sims_neighborhood_familyX_targetURL",
  "sims_neighborhood_familyX_lot",
  "sims_neighborhood_familyX_name",
  "sims_neighborhood_familyX_name_nospaces",
  "sims_neighborhood_familyX_nummembers",
  "sims_web_character_set",
  "sims_web_language_code",
  "sims_game_edition",
].map((t) => `^^^^${t}^^^^`);
const N = { count: 0, id: 1, url: 2, lot: 3, name: 4, nospaces: 5, members: 6, charset: 7, language: 8, edition: 9 } as const;
/** The person data fields GenerateFamilyMemberData reads (byte offset / 2). */
const PDX = {
  nice: 2,
  active: 3,
  playful: 5,
  outgoing: 6,
  neat: 7,
  cooking: 10,
  charisma: 11,
  mechanical: 12,
  creativity: 15,
  body: 17,
  logic: 18,
  jobType: 56,
  jobLevel: 57,
  age: 58,
  jobPerformance: 63,
  gender: 65,
  fameScore: 80,
  fameLevel: 81,
} as const;
/** UIText STR# 158 (InitLocalizedStrings, StringSetMulti): 0-based entries. */
const STR_WEB = 158;
const W = { unemployed: 0, male: 1, female: 2, small: 3, medium: 4, large: 5, adult: 6, kid: 7, human: 8, dog: 9, cat: 10, fame: 11, na: 12 } as const;
/** UIText STR# 154 entry 0x11 (1-based): "School". */
const STR_MISC = 154;
const SCHOOL_ENTRY = 0x10;
/** UIText STR# 167 (lbl_105BCD48): DoInternetUpdate's title, question and per-family text. */
const STR_INET = 167;
/** kNghInetUpdateIcon */
const INET_UPDATE_ICON = 0x14e6;
/** SimInventory: the wand tokens (type 7) PersonFinder::HasWand looks for. */
const WAND_GUIDS = [0x1fec6005, 0xc522329f];
/** PersonFinder::GenerateJPEGs (lbl_105BC1FC): the body picture's animation per species. */
const BODY_ANIM = { dog: "d2o-napfloor-sit-loop", cat: "k2o-sit-howl-start", human: "a2o-idle-transition-handships-armscrossed" } as const;

/** FUN_004dba5d: the language folder of the templates. */
function languageDir(lang: number): string {
  switch (lang) {
    case 2:
      return "english_UK/";
    case 3:
      return "french/";
    case 4:
      return "german/";
    case 5:
      return "italian/";
    case 6:
      return "spanish/";
    case 7:
      return "dutch/";
    case 8:
      return "danish/";
    case 9:
      return "swedish/";
    case 10:
      return "norwegian/";
    case 11:
      return "finnish/";
    case 14:
      return "portuguese/";
    case 15:
      return "japanese/";
    case 16:
      return "polish/";
    case 17:
      return "simplified_chinese/";
    case 18:
      return "traditional_chinese/";
    case 19:
      return "thai/";
    case 20:
      return "korean/";
    default:
      return "english/";
  }
}

/** GetWebCharacterSet */
function webCharacterSet(lang: number): string {
  if (lang <= 14) return "iso-8859-1";
  return ["Shift-JIS", "windows-1250", "gb2312", "big5", "windows-874", "ks_c_5601-1987"][lang - 15] ?? "iso-8859-1";
}

/** GetWebLanguageCode */
function webLanguageCode(lang: number): string {
  const codes: Record<number, string> = {
    2: "en-gb",
    3: "fr",
    4: "de",
    5: "it",
    6: "es",
    7: "nl",
    8: "dn",
    9: "sv",
    10: "nr",
    11: "fn",
    14: "pt",
    15: "ja",
    16: "pl",
    17: "zh-cn",
    18: "zh-tw",
    19: "th",
    20: "ko",
  };
  return codes[lang] ?? "en-us";
}

/** GenerateLookupTagsList: the 427 tags. */
function lookupTags(): string[] {
  const tags = FAMILY_TAGS.map((t) => `^^^^${t}^^^^`);
  for (let k = 0; k < MAX_MEMBERS; k++) for (const s of MEMBER_TAG_SUFFIXES) tags.push(`^^^^sims_familymember${k + 1}${s}^^^^`);
  for (let i = 0; i < MAX_CAPTIONS; i++) tags.push(`^^^^sims_scrapbook${i + 1}_caption^^^^`);
  return tags;
}

/** The family's name with its spaces made "_" (StringBuffer::find(" ") loop). */
function underscored(name: string): string {
  return name.replace(/ /g, "_");
}

// ---------------------------------------------------------------------------
// Files

/** The files directly in game folder `dir` (game-relative, with a trailing slash; case-insensitive), in NTFS name order. */
async function listDir(dir: string): Promise<string[]> {
  const prefix = `sims/${dir}`.toLowerCase();
  const out = (await fetchManifest()).files.map((f) => f.path).filter((p) => p.toLowerCase().startsWith(prefix) && !p.slice(prefix.length).includes("/"));
  // FindFirstFile on NTFS: the upper-cased names in code point order.
  return out.map((p) => p.slice("Sims/".length)).sort((a, b) => (a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0));
}

/** The actual spelling of game folder `dir` (case-insensitive match against the manifest), or `dir` itself. */
async function resolveDir(dir: string): Promise<string> {
  const prefix = `sims/${dir}`.toLowerCase();
  const hit = (await fetchManifest()).files.find((f) => f.path.toLowerCase().startsWith(prefix));
  return hit ? hit.path.slice("Sims/".length, "Sims/".length + dir.length) : dir;
}

/** remove_path: the name after the last slash. */
function removePath(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

function extensionOf(p: string): string {
  const name = removePath(p);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

async function readGameFile(path: string): Promise<Uint8Array | null> {
  return readAssetFile(`Sims/${path}`).catch(() => null);
}

/** cTSFile::Copy(src, dst): false when the source is missing or the write failed. */
async function copyGameFile(src: string, dst: string): Promise<boolean> {
  const bytes = await readGameFile(src);
  if (!bytes) return false;
  try {
    await writeGameFile(dst, bytes);
    return true;
  } catch (e) {
    console.warn(`[exporthtml] copy ${src} -> ${dst} failed`, e);
    return false;
  }
}

// ---------------------------------------------------------------------------
// MakeWebPageX and the templates

/**
 * MakeWebPageX(template, out, tags, values, n): the template's bytes with
 * every "^^^^" token looked up. After four carets the token takes the
 * characters [0-9A-Za-z^_] (an X becomes `n` when n is not -1); each "^"
 * read counts one of the four closing carets down, the fourth is kept and
 * ends the token. A token found in `tags` is written as its value, else as
 * read; the character that stopped an unfinished token follows it. A run of
 * one to three carets is written back with the character after it. At the
 * end of the file istream::get leaves the last character in place (the
 * original's loops see it again).
 */
function makeWebPageX(src: Uint8Array, tags: readonly string[], values: readonly string[], n: number): Uint8Array {
  const out: number[] = [];
  let pos = 0;
  let eof = false;
  let c = 0;
  const get = (): void => {
    if (pos < src.length) c = src[pos++]!;
    else eof = true;
  };
  const isTokenChar = (ch: number): boolean => (ch > 0x2f && ch < 0x3a) || (ch > 0x60 && ch < 0x7b) || ch === 0x5e || ch === 0x5f || (ch > 0x40 && ch < 0x5b);
  const put = (s: string): void => {
    for (const b of encodeCp1252(s)) out.push(b);
  };
  get();
  while (!eof) {
    let carets = 0;
    if (c === 0x5e) {
      carets = 1;
      get();
      if (c === 0x5e) {
        carets = 2;
        get();
        if (c === 0x5e) {
          carets = 3;
          get();
          if (c === 0x5e) carets = 4;
        }
      }
    }
    if (carets === 4) {
      let token = "^^^^";
      get();
      let k = 4;
      while (!eof && k !== 0 && isTokenChar(c)) {
        token += c === 0x58 && n !== -1 ? String(n) : String.fromCharCode(c);
        get();
        if (c === 0x5e) k--;
        if (k === 0) token += String.fromCharCode(c);
      }
      const i = tags.indexOf(token);
      put(i < 0 ? token : (values[i] ?? ""));
      if (k !== 0) out.push(c);
    } else {
      for (; carets > 0; carets--) out.push(0x5e);
      out.push(c);
    }
    get();
  }
  return Uint8Array.from(out);
}

/** GetTruncatedScrapbookCaption: 50 characters at most, the last three dots past 50; returns made spaces, quotes &quot;. */
function truncatedCaption(s: string): string {
  let out = "";
  for (let i = 0; i < s.length && i <= 0x31; i++) {
    const ch = s[i]!;
    if (s.length >= 0x33 && i >= 0x2f) out += ".";
    else if (ch === "\n") out += " ";
    else if (ch === '"') out += "&quot;";
    else out += ch;
  }
  return out;
}

/** ChangeReturnsToBrTags */
function returnsToBr(s: string): string {
  return s.replace(/\n/g, "<br>");
}

/** RemoveCarrotTokens */
function removeCarets(s: string): string {
  return s.replace(/\^/g, "");
}

/** What the family templates read from the family (Family::GetScrapbook, CountMembers). */
interface TemplateFamily {
  members: number;
  scrapbook: Scrapbook | null;
}

/** What familyX.html reads per family (the neighborhood context). */
interface TemplateNeighborhoodFamily {
  name: string;
  house: number;
  familyNumber: number;
  members: number;
}

async function writePage(src: Uint8Array, out: string, tags: readonly string[], values: readonly string[], n: number): Promise<void> {
  await writeGameFile(out, makeWebPageX(src, tags, values, n));
}

/**
 * MakeWebPagesFromTemplate(file, outDir, tags, values, family, neighborhood):
 * familymemberX.html, scrapbookX.html and scrapbook_popupX.html with a
 * family, familyX.html with a neighborhood; any other page once, under its
 * own name, with no page number.
 */
async function makeWebPagesFromTemplate(
  file: string,
  outDir: string,
  tags: readonly string[],
  values: string[],
  family: TemplateFamily | null,
  nbhd: readonly TemplateNeighborhoodFamily[] | null,
): Promise<boolean> {
  const src = await readGameFile(file);
  if (!src) return true;
  const name = removePath(file);
  if (family && name === "familymemberX.html") {
    for (let i = 1; i <= family.members; i++) await writePage(src, `${outDir}familymember${i}.html`, tags, values, i);
    return true;
  }
  if (family && name === "scrapbookX.html") {
    const book = family.scrapbook;
    const count = book?.getPageCount() ?? 0;
    values[T.pages] = String(count);
    for (let i = 0; i < count && i < MAX_CAPTIONS && book; i++) {
      book.setCurPage(i);
      await book.loadCurrent();
      values[T.caption0 + i] = truncatedCaption(book.getDescription() ?? "");
    }
    values[T.page] = "0";
    values[T.prev] = values[T.next] = "scrapbook_popup1.html";
    values[T.snapshot] = "No Image";
    await writePage(src, `${outDir}scrapbook1.html`, tags, values, -1);
    return true;
  }
  if (family && name === "scrapbook_popupX.html") {
    const book = family.scrapbook;
    const count = book?.getPageCount() ?? 0;
    values[T.pages] = String(count);
    if (count === 0 || !book) {
      values[T.page] = "0";
      values[T.prev] = values[T.next] = "scrapbook_popup1.html";
      values[T.snapshot] = "No Image";
      await writePage(src, `${outDir}scrapbook_popup1.html`, tags, values, -1);
    } else {
      for (let i = 0; i < count; i++) {
        values[T.page] = String(i + 1);
        book.setCurPage(i);
        await book.loadCurrent();
        values[T.caption] = returnsToBr(book.getDescription() ?? "");
        values[T.prev] = `scrapbook_popup${i === 0 ? count : i}.html`;
        values[T.next] = `scrapbook_popup${i + 1 === count ? 1 : i + 2}.html`;
        const photo = book.getFilename();
        const pic = `scrapbook${i + 1}.jpg`;
        if (photo) await copyGameFile(photo, `${outDir}${FAMILY_GFX}${pic}`);
        values[T.snapshot] = pic;
        // cScrapbook::GetThumbFilename; cScrapbook::MakeCurThumb when the file is missing.
        const thumb = book.getThumbFilename();
        if (thumb && ((await readGameFile(thumb)) !== null || (await book.makeCurThumb()))) {
          await copyGameFile(thumb, `${outDir}${FAMILY_GFX}scrapbook${i + 1}_thumb.jpg`);
        }
        await writePage(src, `${outDir}scrapbook_popup${i + 1}.html`, tags, values, -1);
      }
    }
    for (const t of [T.caption, T.snapshot, T.page, T.prev, T.next]) values[t] = "";
    return true;
  }
  if (name === "familyX.html") {
    if (!nbhd) return true;
    values[N.count] = String(nbhd.length);
    for (let i = 0; i < nbhd.length; i++) {
      const f = nbhd[i]!;
      values[N.name] = f.name;
      values[N.lot] = String(f.house);
      values[N.id] = String(f.familyNumber);
      values[N.members] = String(f.members);
      const plain = underscored(f.name);
      values[N.nospaces] = plain;
      values[N.url] = values[N.lot] !== "0" ? `${plain}_${f.house}${SIM_LANE}` : plain;
      await writePage(src, `${outDir}family${i + 1}.html`, tags, values, -1);
    }
    for (const t of [N.id, N.url, N.lot, N.name, N.nospaces, N.members]) values[t] = "";
    return true;
  }
  await writePage(src, `${outDir}${name}`, tags, values, -1);
  return true;
}

// ---------------------------------------------------------------------------
// The data

/** A family as the exporter reads it: the neighborhood's record and its members. */
interface ExportFamily {
  view: FamilyView;
  members: ExportMember[];
}

interface ExportMember {
  guid: number;
  pd: Int16Array;
  firstName: string;
  bio: string;
}

/** The game strings GenerateFamilyMemberData uses (InitLocalizedStrings, LoadCareers, cFameTrack). */
interface MemberStrings {
  web: (i: number) => string;
  webUS: (i: number) => string;
  school: string;
  careers: Awaited<ReturnType<typeof loadCareers>>;
  grades: string[];
  fameTitles: string[] | null;
}

async function memberStrings(ctx: GameContext): Promise<MemberStrings> {
  return {
    web: (i) => ctx.strings.get("UIText", STR_WEB, i),
    webUS: (i) => ctx.strings.getUS("UIText", STR_WEB, i),
    school: ctx.strings.get("UIText", STR_MISC, SCHOOL_ENTRY),
    careers: await loadCareers(ctx.strings),
    grades: await loadJobGrades(),
    fameTitles: await loadFameTitles(),
  };
}

/** The family's record and its members' person data (the neighborhood's), names and bios (character files). */
async function exportFamilyOf(store: NeighborhoodStore, familyId: number): Promise<ExportFamily | null> {
  const view = store.family(familyId);
  if (!view) return null;
  const data = await loadNeighborhood(store.dir);
  const members: ExportMember[] = [];
  for (const guid of view.memberGuids) {
    const n = data.neighbors.find((x) => x.guid >>> 0 === guid >>> 0);
    // PersonFinder::GetHandle == -1: the member is skipped.
    if (!n) continue;
    const ch = await loadCharacter(store.dir, n.name).catch(() => null);
    members.push({ guid, pd: store.getPersonData(guid), firstName: ch?.firstName ?? n.name, bio: ch?.bio ?? "" });
  }
  return { view, members };
}

/** GenerateHomelessHouseData */
function homelessHouseData(values: string[]): void {
  for (let i = T.houseValue; i <= T.layoutScore; i++) values[i] = "0";
  values[T.lotSize] = "";
  values[T.charset] = webCharacterSet(LANG);
  values[T.language] = webLanguageCode(LANG);
}

/** GenerateHouseData(values, family, CPState) with House::GetHouseStats' scores. */
function houseData(values: string[], ms: MemberStrings, family: FamilyView, stats: HousePageStats, beenTo2ndLevel: boolean): void {
  values[T.houseValue] = String(family.netWorth);
  values[T.houseAddress] = String(family.houseNumber);
  values[T.lotSize] = ms.web(stats.lotSize === 0 ? W.small : stats.lotSize === 1 ? W.medium : W.large);
  // Square feet as is in US / UK English, else in square meters ((int)(0.092903 * x), lbl_105BC134).
  values[T.squareFeet] = String(LANG === 1 || LANG === 2 ? stats.squareFeet : Math.trunc(0.092903 * stats.squareFeet));
  values[T.bathrooms] = String(stats.numBathrooms);
  values[T.bedrooms] = String(stats.numBedrooms);
  values[T.floors] = beenTo2ndLevel ? "2" : "1";
  values[T.sizeScore] = String(stats.sizeScore);
  values[T.furnishingsScore] = String(stats.furnishingsScore);
  values[T.yardScore] = String(stats.yardScore);
  values[T.upkeepScore] = String(stats.upkeepScore);
  values[T.layoutScore] = String(stats.layoutScore);
  values[T.charset] = webCharacterSet(LANG);
  values[T.language] = webLanguageCode(LANG);
}

/** PersonFinder::GetJobA: a child is on the school track (CARR -1), level 0. */
function jobOf(ms: MemberStrings, pd: Int16Array): Job | null {
  let type = pd[PDX.jobType] ?? 0;
  let level = pd[PDX.jobLevel] ?? 0;
  if ((pd[PDX.age] ?? 0) < 0x12) {
    type = -1;
    level = 0;
  }
  if (type === 0) return null;
  return careerById(ms.careers, type)?.jobs[level] ?? null;
}

/** GenerateFamilyMemberData(values, family, i) */
function familyMemberData(ctx: GameContext, values: string[], ms: MemberStrings, m: ExportMember, i: number, store: NeighborhoodStore, edition: number): void {
  const base = T.member0 + i * MEMBER_TAGS;
  const pd = m.pd;
  const v = (j: number, s: string): void => {
    values[base + j] = s;
  };
  v(0, m.firstName);
  v(1, String(i + 1));
  // PersonFinder::GetGender: person data 0x41 bit 0; GetAge: person data 0x3a < 18 is a child.
  const female = ((pd[PDX.gender] ?? 0) & 1) === 1;
  const child = (pd[PDX.age] ?? 0) < 0x12;
  v(2, ms.web(female ? W.female : W.male));
  v(3, ms.web(child ? W.kid : W.adult));
  const jobType = pd[PDX.jobType] ?? 0;
  const career = jobType !== 0 ? careerById(ms.careers, jobType) : null;
  const job = jobOf(ms, pd);
  if (!child) {
    if ((pd[PDX.fameScore] ?? 0) < 1 || career || (edition & EDITION_SUPERSTAR) === 0) {
      v(4, career ? career.name : ms.web(W.unemployed));
      v(5, job ? jobName(job, female) : ms.web(W.unemployed));
      v(6, String(pd[PDX.jobPerformance] ?? 0));
      v(7, String(job ? job.salary : 0));
    } else {
      v(4, ms.web(W.fame));
      v(5, ms.fameTitles ? getTitleFromLevel(ms.fameTitles, pd[PDX.fameLevel] ?? 0) : "");
      v(6, ms.web(W.na));
      v(7, ms.web(W.na));
    }
  } else {
    v(4, ms.school);
    v(5, ms.school);
    // cJob::GetGrade(PersonFinder::GetJobPerformance): a child's is person data 0x39.
    v(6, getGrade(ms.grades, pd[PDX.jobLevel] ?? 0));
    v(7, String(job ? job.salary : 0));
  }
  v(8, m.bio);
  v(9, String(m.guid | 0));
  const tenth = (x: number): string => String(Math.trunc((pd[x] ?? 0) / 100));
  v(10, tenth(PDX.neat));
  v(11, tenth(PDX.outgoing));
  v(12, tenth(PDX.active));
  v(13, tenth(PDX.playful));
  v(14, tenth(PDX.nice));
  v(15, tenth(PDX.cooking));
  v(16, tenth(PDX.mechanical));
  v(17, tenth(PDX.charisma));
  v(18, tenth(PDX.body));
  v(19, tenth(PDX.logic));
  v(20, tenth(PDX.creativity));
  v(21, getZodiacName(ctx, computeZodiacSign(pd)));
  // PersonFinder::GetSpecies: person data 0x41 bit 1 dog, bit 2 cat; the US English strings.
  const g = pd[PDX.gender] ?? 0;
  v(22, ms.webUS((g & 2) !== 0 ? W.dog : (g & 4) !== 0 ? W.cat : W.human));
  v(23, String(pd[PDX.fameScore] ?? 0));
  // PersonFinder::HasWand: a wand token (type 7) in the neighbor's inventory.
  const id = store.neighborIdOf(m.guid);
  const wands = id === undefined ? 0 : WAND_GUIDS.reduce((s, w) => s + store.findToken(id, 7, w), 0);
  v(24, wands !== 0 ? "1" : "0");
}

/** GenerateFamilyAndScrapbookData */
function familyAndScrapbookData(
  ctx: GameContext,
  values: string[],
  ms: MemberStrings,
  fam: ExportFamily,
  store: NeighborhoodStore,
  daysRunning: number,
  pages: number,
  edition: number,
): void {
  const f = fam.view;
  values[T.cash] = String(f.budget);
  values[T.magicTokens] = String(store.magiCoins(f.id));
  values[T.days] = String(daysRunning);
  values[T.members] = String(f.memberGuids.length);
  values[T.friends] = String(f.friends);
  values[T.name] = f.name;
  values[T.cheats] = getCheatCodeManager()?.anyCheatUsed() ? "1" : "0";
  values[T.caption] = "";
  values[T.snapshot] = "";
  values[T.pages] = String(pages);
  values[T.page] = "";
  values[T.prev] = "";
  values[T.next] = "";
  values[T.charset] = webCharacterSet(LANG);
  values[T.language] = webLanguageCode(LANG);
  fam.members.slice(0, MAX_MEMBERS).forEach((m, i) => familyMemberData(ctx, values, ms, m, i, store, edition));
  for (let i = 0; i < MAX_CAPTIONS; i++) values[T.caption0 + i] = "";
}

// ---------------------------------------------------------------------------
// MakePublishingInfo

/** What the [floors] / [walls] / [objects] sections list. */
interface HouseFiles {
  floors: string[];
  walls: string[];
  objects: string[];
}

/** The usage map files of a house file (FLRm / WALm, chunk 1 or the old chunk 0). */
function usageFiles(house: ResFile, type: string): string[] {
  const b1 = house.get(type, 1);
  const b0 = house.get(type, 0);
  const map = b1 ? parseUsageMap(b1) : b0 ? parseUsageMapBytes(b0) : [];
  return map.map((e) => e.file);
}

/** ObjSelector::GetShortFilename: the object file's name without folder and extension. */
function shortFilename(sel: ObjSelector): string {
  const name = sel.fileKey.slice(Math.max(sel.fileKey.lastIndexOf("/"), sel.fileKey.lastIndexOf("|"), sel.fileKey.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? name : name.slice(0, dot);
}

/**
 * The house's files for the .pub: the floor and wall usage maps, and the
 * folder's selectors from the download folders (+0xb4 source 2 or 3) that
 * have a save type index (+0xa4: the house holds instances), in folder order.
 */
function houseFiles(house: ResFile, module: ObjectModule): HouseFiles {
  const used = new Map<number, ObjSelector>();
  for (const o of module.objects.values()) used.set(o.selector.index, o.selector);
  const objects = [...used.values()]
    .filter((s) => s.source === 2 || s.source === 3)
    .sort((a, b) => a.index - b.index)
    // The Windows build's file names come out lowercase (its .pub files list
    // "sccontroller" for SCController.iff).
    .map((s) => shortFilename(s).toLowerCase());
  return { floors: usageFiles(house, "FLRm"), walls: usageFiles(house, "WALm"), objects };
}

/** simpleEncode: a running XOR from 0xbf, then the checksum of the plain bytes (little-endian). */
function simpleEncode(plain: Uint8Array): Uint8Array {
  const out = new Uint8Array(plain.length + 4);
  let prev = 0xbf;
  let chk = 0xbf;
  for (let i = 0; i < plain.length; i++) {
    const p = plain[i]!;
    prev ^= p;
    out[i] = prev;
    if (chk === 0) chk = 0xbf;
    chk = Math.imul(chk, (p << 24) >> 24) >>> 0;
  }
  new DataView(out.buffer).setUint32(plain.length, chk, true);
  return out;
}

/** MakeIniBodyStringSection(buffer, name, body string, family, texture) */
async function iniBodyStringSection(name: string, index: number, texture: boolean, guids: readonly number[], folderDir: string): Promise<string> {
  let s = `\r\n[${name}]\r\nnum=${guids.length}\r\n`;
  const folder = await ObjectFolder.get(folderDir);
  for (let i = 0; i < guids.length; i++) {
    s += `${name}${i + 1}="`;
    const sel = await folder.getSelectorByGUID(guids[i]!).catch(() => null);
    const strings = sel ? loadStringSet(sel.res, sel.objd.i16(0x26)) : null;
    if (strings) {
      const st = new BodyStrings(strings).getSuitAndTexture(index);
      s += texture ? st.texture : st.suit;
      s += '"\r\n';
    }
  }
  return s;
}

/**
 * MakePublishingInfo(webPagesPath, base, tags, values, family): the
 * encrypted <neighborhood>/Export/<base>.pub (the .ini path is built and
 * not used). False when the text is over 64000 bytes or the write failed.
 */
async function makePublishingInfo(
  nbhdDir: string,
  webPath: string,
  base: string,
  tags: readonly string[],
  values: readonly string[],
  family: FamilyView,
  edition: number,
  files: HouseFiles,
): Promise<boolean> {
  let s = "[Content]\r\nType=FamilyHouse\r\n\r\n[FamilyHouse]\r\n";
  s += `FamFile=${base}.fam\r\n`;
  s += "FamilyStats=FamilyInfo\r\n";
  s += `GameVersion=${GAME_VERSION}\r\n`;
  s += `GameEdition=${edition}\r\n`;
  s += "HouseStats=HouseInfo\r\nDescription=FamilyDescription\r\nDownloadPath=UserData\\Import\r\nNumDependencies=11\r\n";
  const deps = ["skin_tex", "skin_model", "head_tex", "head_model", "hand_open_left_tex", "hand_open_left_model", "hand_open_right_tex", "hand_open_right_model", "floors", "walls", "objects"];
  deps.forEach((d, i) => (s += `Dependency${i + 1}=${d}\r\n`));
  s += "\r\n[FamilyInfo]\r\n";
  for (let i = 0; i < 0x14; i++) s += `${removeCarets(tags[i]!)}=${values[i] ?? ""}\r\n`;
  const count = Math.min(family.memberGuids.length, MAX_MEMBERS);
  for (let k = 0; k < count; k++) {
    for (let j = 0; j < MEMBER_TAGS; j++) {
      const t = T.member0 + k * MEMBER_TAGS + j;
      s += `${removeCarets(tags[t]!)}=${values[t] ?? ""}\r\n`;
    }
  }
  s += `\r\n[FamilyDescription]\r\nWebPages=${webPath}\r\n`;
  for (const [name, index, tex] of [
    ["skin_tex", 2, true],
    ["skin_model", 2, false],
    ["head_tex", 3, true],
    ["head_model", 3, false],
    ["hand_open_left_tex", 0x12, true],
    ["hand_open_left_model", 0x12, false],
    ["hand_open_right_tex", 0x13, true],
    ["hand_open_right_model", 0x13, false],
  ] as const) {
    s += await iniBodyStringSection(name, index, tex, family.memberGuids, nbhdDir);
  }
  const list = (title: string, key: string, items: readonly string[]): string => {
    let t = `\r\n[${title}]\r\nnum=${items.length}\r\n`;
    items.forEach((x, i) => (t += `${key}${i + 1}="${x}"\r\n`));
    return t;
  };
  s += list("floors", "floors", files.floors);
  s += list("walls", "walls", files.walls);
  s += list("objects", "objects", files.objects);
  // StringBuffer(64000): what does not fit is dropped; htmlEncrypt takes up to 0xfa00 bytes.
  const plain = encodeCp1252(s).subarray(0, PUB_MAX - 1);
  if (plain.length > 0xfa00) return false;
  try {
    await writeGameFile(`${nbhdDir}/${EXPORT_DIR}${base}.pub`, simpleEncode(plain));
    return true;
  } catch (e) {
    console.warn(`[exporthtml] ${base}.pub`, e);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Pictures

/** A 16-bit picture (the game's buffers): 555 for the house views, 565 for the 3D target. */
interface Image16 {
  w: number;
  h: number;
  px: Uint16Array;
  fmt: 555 | 565;
}

/** lbl_105BA258: the transparent color (magenta) of a 555 buffer. */
const TRANSPARENT_555 = 0x7c1f;
/** ScaleBitmap's lbl_105BBFF8 [7]: below this much opaque weight a pixel stays transparent. */
const MIN_OPAQUE_WEIGHT = 0.46875;

function pack(fmt: 555 | 565, r: number, g: number, b: number): number {
  return fmt === 555 ? ((r & 0xf8) << 7) | ((g & 0xf8) << 2) | (b >> 3) : ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
}

function unpack(fmt: 555 | 565, p: number): [number, number, number] {
  return fmt === 555 ? [((p >> 10) & 0x1f) << 3, ((p >> 5) & 0x1f) << 3, (p & 0x1f) << 3] : [((p >> 11) & 0x1f) << 3, ((p >> 5) & 0x3f) << 2, (p & 0x1f) << 3];
}

function newImage(w: number, h: number, fmt: 555 | 565, fill: number): Image16 {
  const px = new Uint16Array(Math.max(0, w * h));
  px.fill(fill);
  return { w, h, px, fmt };
}

/** One axis of ScaleBitmap: a cubic kernel stretched by 1 / scale when shrinking, mirrored at the edges (world/thumbnail.ts). */
function contributors(srcLen: number, dstLen: number): Array<Array<[number, number]>> {
  const scale = Math.fround(dstLen / srcLen);
  const support = scale < 1 ? Math.fround(1 / scale) : 1;
  const inv = Math.fround(1 / support);
  const out: Array<Array<[number, number]>> = [];
  for (let i = 0; i < dstLen; i++) {
    const center = Math.fround(i / scale);
    const lo = Math.ceil(center - support);
    const hi = Math.floor(center + support);
    const list: Array<[number, number]> = [];
    let sum = 0;
    for (let j = lo; j <= hi; j++) {
      let t = Math.fround((center - j) * inv);
      if (t < 0) t = -t;
      const k = t >= 1 ? 0 : Math.fround(t * (2 * t - 3) * t + 1);
      const wgt = Math.fround(inv * k);
      sum += wgt;
      let s = j;
      for (;;) {
        while (s < 0) s = -s;
        if (s < srcLen) break;
        s = srcLen * 2 - s - 2;
      }
      list.push([s, wgt]);
    }
    if (sum > 1e-12) for (const c of list) c[1] = Math.fround(c[1] / sum);
    out.push(list);
  }
  return out;
}

function scalePass(src: Image16, dw: number, dh: number, horizontal: boolean, key: number | null): Image16 {
  const dst = newImage(dw, dh, src.fmt, 0);
  const cs = horizontal ? contributors(src.w, dw) : contributors(src.h, dh);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const list = horizontal ? cs[x]! : cs[y]!;
      let wsum = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (const [s, wgt] of list) {
        const p = horizontal ? src.px[y * src.w + s]! : src.px[s * src.w + x]!;
        if (p === key) continue;
        const [pr, pg, pb] = unpack(src.fmt, p);
        wsum += wgt;
        r += pr * wgt;
        g += pg * wgt;
        b += pb * wgt;
      }
      if (wsum >= MIN_OPAQUE_WEIGHT) {
        const k = 1 / wsum;
        dst.px[y * dw + x] = pack(src.fmt, Math.min(255, Math.trunc(0.5 + r * k)), Math.min(255, Math.trunc(0.5 + g * k)), Math.min(255, Math.trunc(0.5 + b * k)));
      } else {
        dst.px[y * dw + x] = key ?? 0;
      }
    }
  }
  return dst;
}

/** ScaleBitmap(fx, fy, buffer, null, false): x then y, each to ceil(size * f); `key` pixels (SetTransparency) carry no weight. */
function scaleBitmap(src: Image16, fx: number, fy: number, key: number | null): Image16 {
  const dw = Math.ceil(Math.fround(src.w * fx));
  const dh = Math.ceil(Math.fround(src.h * fy));
  return scalePass(scalePass(src, dw, src.h, true, key), dw, dh, false, key);
}

/** ShrinkWrap(buffer, rect, color): the margins made of `color` { left, top, right, bottom }, null when all of it is. */
function shrinkWrap(img: Image16, color: number): { left: number; top: number; right: number; bottom: number } | null {
  const { w, h, px } = img;
  const rowEmpty = (y: number): boolean => {
    for (let x = 0; x < w; x++) if (px[y * w + x] !== color) return false;
    return true;
  };
  let top = 0;
  while (top < h && rowEmpty(top)) top++;
  if (top === h) return null;
  let bottom = 0;
  while (rowEmpty(h - 1 - bottom)) bottom++;
  const colEmpty = (x: number): boolean => {
    for (let y = top; y < h - bottom; y++) if (px[y * w + x] !== color) return false;
    return true;
  };
  let left = 0;
  while (colEmpty(left)) left++;
  let right = 0;
  while (colEmpty(w - 1 - right)) right++;
  return { left, top, right, bottom };
}

function crop(img: Image16, x0: number, y0: number, w: number, h: number): Image16 {
  const out = newImage(w, h, img.fmt, 0);
  for (let y = 0; y < h; y++) out.px.set(img.px.subarray((y0 + y) * img.w + x0, (y0 + y) * img.w + x0 + w), y * w);
  return out;
}

/** Blt of `src` at (x0, y0), `key` pixels skipped when given (SetTransparency). */
function blit(dst: Image16, src: Image16, x0: number, y0: number, key: number | null): void {
  for (let y = 0; y < src.h; y++) {
    const dy = y0 + y;
    if (dy < 0 || dy >= dst.h) continue;
    for (let x = 0; x < src.w; x++) {
      const dx = x0 + x;
      if (dx < 0 || dx >= dst.w) continue;
      const p = src.px[y * src.w + x]!;
      if (p !== key) dst.px[dy * dst.w + dx] = p;
    }
  }
}

/** A decoded RGBA picture as a 16-bit buffer (cTSBuffer of the screen format). */
function fromRgba(data: Uint8ClampedArray, w: number, h: number, fmt: 555 | 565): Image16 {
  const img = newImage(w, h, fmt, 0);
  for (let i = 0; i < w * h; i++) img.px[i] = pack(fmt, data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!);
  return img;
}

/** SaveGimex(file, buffer, rect, quality): the buffer as a JPEG through the browser's encoder. */
async function saveJpeg(path: string, img: Image16, quality: number): Promise<boolean> {
  if (img.w <= 0 || img.h <= 0) return false;
  const c = new OffscreenCanvas(img.w, img.h);
  const g = c.getContext("2d")!;
  const data = new ImageData(img.w, img.h);
  for (let i = 0; i < img.w * img.h; i++) {
    const [r, gg, b] = unpack(img.fmt, img.px[i]!);
    data.data[i * 4] = r;
    data.data[i * 4 + 1] = gg;
    data.data[i * 4 + 2] = b;
    data.data[i * 4 + 3] = 255;
  }
  g.putImageData(data, 0, 0);
  const blob = await c.convertToBlob({ type: "image/jpeg", quality: quality / 100 });
  try {
    await writeGameFile(path, new Uint8Array(await blob.arrayBuffer()));
    return true;
  } catch (e) {
    console.warn(`[exporthtml] ${path}`, e);
    return false;
  }
}

/** kWebcamLogo / kWebcamLogoAlpha (InitLogo, lbl_105BFC64 / lbl_105BFC60). */
const WEBCAM_LOGO = 4400;
const WEBCAM_LOGO_ALPHA = 4401;
let logo: Promise<{ color: Image16; alpha: Uint8Array } | null> | null = null;

/**
 * ApplyLogo(buffer): the logo blended into the bottom right corner, 3 pixels
 * in: where the alpha bitmap's byte is above 7, each 5-bit channel moves
 * from the picture toward the logo by (alpha >> 3) / 31 (the blend table
 * lbl_105BA5E0).
 */
async function applyLogo(img: Image16): Promise<void> {
  logo ??= (async () => {
    const res = await UIRes.load();
    const c = await res.rgba(WEBCAM_LOGO).catch(() => null);
    const a = await res.rgba(WEBCAM_LOGO_ALPHA).catch(() => null);
    if (!c || !a) return null;
    const alpha = new Uint8Array(a.width * a.height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = a.data[i * 4]!;
    return { color: fromRgba(c.data, c.width, c.height, 555), alpha };
  })();
  const l = await logo;
  if (!l || img.fmt !== 555) return;
  const x0 = img.w - l.color.w - 3;
  const y0 = img.h - l.color.h - 3;
  for (let y = 0; y < l.color.h; y++) {
    for (let x = 0; x < l.color.w; x++) {
      const al = l.alpha[y * l.color.w + x] ?? 0;
      const dx = x0 + x;
      const dy = y0 + y;
      if (al <= 7 || dx < 0 || dy < 0 || dx >= img.w || dy >= img.h) continue;
      const a = al >> 3;
      const d = img.px[dy * img.w + dx]!;
      const s = l.color.px[y * l.color.w + x]!;
      const ch = (shift: number): number => {
        const dc = (d >> shift) & 0x1f;
        const sc = (s >> shift) & 0x1f;
        return Math.trunc(dc + ((sc - dc) * a) / 31) << shift;
      };
      img.px[dy * img.w + dx] = ch(10) | ch(5) | ch(0);
    }
  }
}

// --- The family pictures (PersonFinder::GenerateJPEGs)

/** The face: PersonFinder::GetWebPictureBuffer (BMP_ 2007, GenerateBitmaps when the file has none). */
async function makeFaceJpeg(path: string, sel: ObjSelector): Promise<void> {
  const bmp = await personBitmap(sel, 2007);
  if (!bmp) return;
  const img = decodeImage(bmp, "web.bmp");
  await saveJpeg(path, fromRgba(img.data, img.width, img.height, 565), 100);
}

/** The 3D target MakePersonBodyImage draws into (one WebGL context, kept). */
let bodyTarget: Promise<{ gl: WebGL2RenderingContext; renderer: SimRenderer }> | null = null;
/** MakePersonBodyImage's area (lbl: 200 x 0x1b8) and lbl_105BC8A8's constants. */
const BODY_W = 200;
const BODY_H = 0x1b8;
const BODY_K = { half: 0.5, tenth: 10, scale: 9, rot: -0.5, ambient: 1, ratio: 0.4545, outW: 100, outH: 220 } as const;
/** lbl_105C1FF8: the anchor's depth. */
const BODY_DEPTH = 32767;
/** The view MakePersonBodyImage renders with: the lot view's scale, rotation 0 (any scale: the model scale compensates). */
const BODY_ZOOM = 3;

/**
 * SAnimator::MakePersonBodyImage(t, outfit 0, skill, white): the person in
 * its day clothes with open hands, posed at `t` of the skill, drawn into a
 * 200 x 440 area filled with white (ambient light 1: the colors come out
 * unlit), the model being Scale(9 / (1 << (zoom - 1))) * RotY(-0.5 pi
 * (rotation - 0.5)) * Translation(the point (100, 396) at depth 32767);
 * then ShrinkWrap on white, the figure re-centered horizontally with its
 * bottom 40 pixels above the area's, and ScaleBitmap(100 / 200, 220 / 440).
 */
async function makeBodyJpeg(path: string, sel: ObjSelector): Promise<void> {
  const strings = loadStringSet(sel.res, sel.objd.i16(0x26));
  if (!strings?.length) return;
  const anim = await SAnimator.fromBodyStrings(strings);
  if (!anim) return;
  const skel = anim.skeletonName.toLowerCase();
  // PersonFinder::GenerateJPEGs: person +0x60e bit 1 (dog) / bit 2 (cat); t = clamp(n / 100, 0, 1).
  const [skill, t] = skel === "dog" ? [BODY_ANIM.dog, 0.01] : skel === "kat" ? [BODY_ANIM.cat, 0.01] : [BODY_ANIM.human, 0];
  if (!(await anim.startSkill(skill))) return;
  const p = anim.vitaboy.practices[0];
  if (p) p.position = t;
  anim.update(0);
  bodyTarget ??= (async () => {
    const canvas = new OffscreenCanvas(BODY_W, BODY_H);
    const gl = canvas.getContext("webgl2", { alpha: false, depth: true, antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL2 unavailable");
    return { gl, renderer: await SimRenderer.create(gl) };
  })();
  const { gl, renderer } = await bodyTarget;
  const view: SimView = { zoom: BODY_ZOOM, rotation: 0, originX: 0, originY: 0, width: BODY_W, height: BODY_H };
  const cam = renderer.cameraFor(view);
  const anchor = unproject(cam, BODY_W * BODY_K.half, (BODY_H * 9) / BODY_K.tenth, BODY_DEPTH);
  let model = scaleTf(Math.fround(BODY_K.scale / (1 << (BODY_ZOOM - 1))));
  model = mat4Mul(model, rotationTf(1, Math.fround(BODY_K.rot * Math.PI * (view.rotation - BODY_K.half))));
  model = mat4Mul(model, translationTf(anchor));
  gl.viewport(0, 0, BODY_W, BODY_H);
  gl.clearColor(1, 1, 1, 1);
  gl.clearDepth(1);
  gl.depthMask(true);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  renderer.renderSimModel(anim.vitaboy, model, view, { ambient: BODY_K.ambient });
  const raw = new Uint8Array(BODY_W * BODY_H * 4);
  gl.readPixels(0, 0, BODY_W, BODY_H, gl.RGBA, gl.UNSIGNED_BYTE, raw);
  const area = newImage(BODY_W, BODY_H, 565, 0);
  for (let y = 0; y < BODY_H; y++) {
    for (let x = 0; x < BODY_W; x++) {
      const s = ((BODY_H - 1 - y) * BODY_W + x) * 4;
      area.px[y * BODY_W + x] = pack(565, raw[s]!, raw[s + 1]!, raw[s + 2]!);
    }
  }
  const white = pack(565, 255, 255, 255);
  const m = shrinkWrap(area, white);
  let img = area;
  if (m) {
    const fig = crop(area, m.left, m.top, BODY_W - m.left - m.right, BODY_H - m.top - m.bottom);
    img = newImage(BODY_W, BODY_H, 565, white);
    blit(img, fig, Math.trunc((BODY_W - fig.w) / 2), BODY_H - fig.h - 0x28, null);
  }
  // The aspect test (200 / 440 against 0.4545) leaves the 200 x 440 area as it is.
  await saveJpeg(path, scaleBitmap(img, BODY_K.outW / BODY_W, BODY_K.outH / BODY_H, null), 100);
}

/**
 * GenerateFamilyMemberJPEGs(family, FamilyGFX path): per member, an empty
 * faminfo_<n>_<GUID> file, family<n>_face.jpg and family<n>_full.jpg.
 */
async function generateFamilyMemberJpegs(fam: ExportFamily, nbhdDir: string, gfxDir: string): Promise<void> {
  const folder = await ObjectFolder.get(nbhdDir);
  for (let i = 0; i < fam.members.length; i++) {
    const m = fam.members[i]!;
    const n = i + 1;
    await writeGameFile(`${gfxDir}faminfo_${n}_${m.guid | 0}`, new Uint8Array(0)).catch((e: unknown) => console.warn("[exporthtml] faminfo", e));
    const sel = await folder.getSelectorByGUID(m.guid).catch(() => null);
    if (!sel) continue;
    await makeFaceJpeg(`${gfxDir}family${n}_face.jpg`, sel).catch((e: unknown) => console.warn("[exporthtml] face", e));
    await makeBodyJpeg(`${gfxDir}family${n}_full.jpg`, sel).catch((e: unknown) => console.warn("[exporthtml] body", e));
  }
}

// --- The house pictures (HouseViewer::MakeWebPageThumbnail)

/** The lot as the exporter draws and measures it: the shown lot, or one loaded for the export. */
export interface ExportLot {
  houseNumber: number;
  /** The house file as saved (usage maps). */
  house: ResFile;
  viewer: HouseViewer;
  walls: WallManager | null;
  lighting: RoomLighting | null;
  terrain: Terrain | null;
  rooms: RoomManager | null;
  module: ObjectModule;
  stats: HousePageStats;
  beenTo2ndLevel: boolean;
  daysRunning: number;
}

/** lbl_105BBF58: MakeThumbnail's scales, [5] / [6] the neighborhood picture's. */
const THUMB_SCALE = [0.5, 0.25] as const;
const NBHD_SCALE = 1.0;
const NBHD_SCALE_UNLEASHED = 2.0;
/** MakeWebPageThumbnail's MakeThumbnail size. */
const THUMB_W = 0x1b0;
const THUMB_H = 0x120;
/** The background of the house pictures (r, g, b = 0x77, 0xa5, 0x8b). */
const HOUSE_BG = [0x77, 0xa5, 0x8b] as const;
/** Tile flag 0x20: outside the lot proper (MakeThumbnail's center average skips it). */
const TILE_LOCKED = 0x20;
/** The neighborhood pictures MakeWebPageThumbnail crops (kNghBkgnd*): English / others, Unleashed, Makin' Magic's 90..92. */
const NBHD_PICTURES = { en: 5000, other: 5308, unleashedEn: 6000, unleashedOther: 6308, magic: 5322 } as const;

/**
 * MakeThumbnail(f, w, h, rotation 0, zoom 1, offsets, level, roof pass
 * false, clear color, cutaway): a (w / f) x (h / f) buffer cleared to
 * `clear`, zoom 1, rotation 0, level (0 = 2), the roof drawn when the level
 * was 0, cutaway (+0x48) for the floor shots, dynamic cutaway off, no
 * people; offsets 0x7fffffff center the view on the lot's average tile
 * (ScrollToTile at level 1); ScaleBitmap(f) of the result.
 */
function makeThumbnail(lot: ExportLot, f: number, offX: number, offY: number, level: number, clear555: number): Image16 {
  const v = lot.viewer;
  const { walls, lighting, terrain, rooms } = lot;
  const world = v.world;
  const fixed = world.fixed;
  const bufW = Math.trunc(0.5 + THUMB_W / f);
  const bufH = Math.trunc(0.5 + THUMB_H / f);
  const viewLevel = level === 0 ? 2 : level;
  const roof = level === 0;
  const cutaway = level !== 0;
  const saved = {
    scale: v.scale,
    rotation: world.rotation,
    level: v.level,
    originX: v.originX,
    originY: v.originY,
    cutaway: v.cutaway,
    drawRoof: v.drawRoof,
    wallsRoof: walls?.drawRoof ?? false,
    wallsCutaway: walls?.cutaway ?? false,
    wallsDynamic: walls?.dynamicCutaway ?? false,
    people: v.people,
    cursor: v.cursor,
    phase: lighting?.phase ?? 0,
    overlay: terrain?.overlayVisible ?? false,
    quality: terrain?.getQuality() ?? 2,
  };
  const img = newImage(bufW, bufH, 555, clear555);
  try {
    // MakeWebPageThumbnail: cSimulator +0x18 = 0 (daytime), cTerrain::SetColor, AllRoomsLightingChanged, terrain detail 2.
    if (lighting && lighting.phase !== 0) lighting.compute(0);
    terrain?.setColor(lot.houseNumber, 0);
    terrain?.setLatitudeByTimeOfDay(0);
    if (terrain && saved.quality !== 2) terrain.setQuality(2);
    terrain?.showOverlay(false);
    v.people = null;
    v.cursor = null;
    v.setScale(1);
    v.setRotation(0);
    v.setLevel(viewLevel);
    v.cutaway = cutaway;
    v.drawRoof = roof;
    if (walls) {
      walls.cutaway = cutaway;
      walls.dynamicCutaway = false;
      walls.drawRoof = roof;
    }
    rooms?.computeCutaway(v, viewLevel);
    const m = v.getOffsetsMinMax(bufW, bufH);
    let ox: number;
    let oy: number;
    if (offX === 0x7fffffff && offY === 0x7fffffff) {
      // ScrollToTile(the average tile of the lot, level 1): its center in the middle of the buffer.
      let sx = 0;
      let sy = 0;
      let n = 0;
      const flags = fixed.flags[0]!;
      for (let y = 0; y < fixed.size; y++) {
        for (let x = 0; x < fixed.size; x++) {
          if ((flags.u8(x, y) & TILE_LOCKED) !== 0) continue;
          sx += x;
          sy += y;
          n++;
        }
      }
      if (n === 0) n = 1;
      const cx = Math.trunc(0.5 + sx / n);
      const cy = Math.trunc(0.5 + sy / n);
      v.originX = 0;
      v.originY = 0;
      // FTilePt (1/16 tile) of the tile's center; ScrollToTile's level 1.
      const p = v.tileToPointF((cx << 4) | 8, (cy << 4) | 8, 1);
      ox = Math.trunc(bufW / 2) - p.h;
      oy = Math.trunc(bufH / 2) - p.v;
    } else {
      ox = offX;
      oy = offY;
    }
    ox = (Math.min(Math.max(ox, m.minX), m.maxX) + 1) & ~3;
    oy = Math.min(Math.max(oy, m.minY), m.maxY);
    v.thumbnailClearColor = (() => {
      const [r, g, b] = unpack(555, clear555);
      return (r << 16) | (g << 8) | b;
    })();
    const comp = v.comp;
    const gl = comp.gl;
    const tw = comp.width;
    const th = comp.height;
    const rgba = new Uint8Array(tw * th * 4);
    for (let ty = 0; ty < bufH; ty += th) {
      for (let tx = 0; tx < bufW; tx += tw) {
        v.originX = ox - tx;
        v.originY = oy - ty;
        v.render();
        gl.readPixels(0, 0, tw, th, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
        const cw = Math.min(tw, bufW - tx);
        const ch = Math.min(th, bufH - ty);
        for (let y = 0; y < ch; y++) {
          const src = (th - 1 - y) * tw * 4;
          const dst = (ty + y) * bufW + tx;
          for (let x = 0; x < cw; x++) {
            const s = src + x * 4;
            img.px[dst + x] = pack(555, rgba[s]!, rgba[s + 1]!, rgba[s + 2]!);
          }
        }
      }
    }
  } finally {
    v.thumbnailClearColor = null;
    v.people = saved.people;
    v.cursor = saved.cursor;
    if (walls) {
      walls.cutaway = saved.wallsCutaway;
      walls.dynamicCutaway = saved.wallsDynamic;
      walls.drawRoof = saved.wallsRoof;
    }
    v.cutaway = saved.cutaway;
    v.drawRoof = saved.drawRoof;
    v.setLevel(saved.level);
    v.setRotation(saved.rotation);
    v.setScale(saved.scale);
    v.originX = saved.originX;
    v.originY = saved.originY;
    rooms?.computeCutaway(v, saved.level);
    if (lighting && lighting.phase !== saved.phase) lighting.compute(saved.phase);
    terrain?.setColor(lot.houseNumber, saved.phase);
    terrain?.setLatitudeByTimeOfDay(saved.phase);
    if (terrain && saved.quality !== 2) terrain.setQuality(saved.quality);
    terrain?.showOverlay(saved.overlay);
    v.dirty = true;
  }
  // The magenta clear color makes the buffer transparent for ScaleBitmap.
  return scaleBitmap(img, f, f, clear555 === TRANSPARENT_555 ? TRANSPARENT_555 : null);
}

/**
 * HouseViewer::MakeWebPageThumbnail(file, level, scale, thumbnail, r, g, b):
 * MakeThumbnail (scale 1: f 0.25 at the saved offsets; scale 0: f 0.5,
 * centered), ShrinkWrap on the clear color; a thumbnail is then put on its
 * part of the neighborhood picture (GetHouseInfo's lot position and
 * thumbnail offsets); SaveGimex quality 90 with the logo.
 */
async function makeWebPageThumbnail(path: string, lot: ExportLot, nb: Neighborhood | null, level: number, scale: number, thumb: boolean, edition: number): Promise<void> {
  const v = lot.viewer;
  let offX = 0x7fffffff;
  let offY = 0x7fffffff;
  if (scale !== 0) {
    const mm = v.getOffsetsMinMax();
    const div = 1 << (v.scale - 1);
    offX = Math.trunc(mm.maxX / div);
    offY = Math.trunc(mm.maxY / div);
  }
  const clear = thumb ? TRANSPARENT_555 : pack(555, HOUSE_BG[0], HOUSE_BG[1], HOUSE_BG[2]);
  await v.prepareRoof();
  const shot = makeThumbnail(lot, THUMB_SCALE[scale === 0 ? 0 : 1], offX, offY, level, clear);
  const r = shrinkWrap(shot, clear) ?? { left: 0, top: 0, right: 0, bottom: 0 };
  const house = crop(shot, r.left, r.top, THUMB_W - r.left - r.right, THUMB_H - r.top - r.bottom);
  let out = house;
  if (thumb && nb) {
    const info = await getHouseInfo(nb, lot.houseNumber).catch(() => null);
    if (info) {
      const magic = (edition & EDITION_MAGIC) !== 0 && lot.houseNumber > 0x59 && lot.houseNumber < 0x5d;
      let id: number;
      let factor: number;
      let unleashed = false;
      if (magic) {
        id = NBHD_PICTURES.magic;
        factor = NBHD_SCALE;
      } else if ((edition & EDITION_UNLEASHED) === 0) {
        id = LANG === 1 ? NBHD_PICTURES.en : NBHD_PICTURES.other;
        factor = NBHD_SCALE;
      } else {
        id = LANG === 1 ? NBHD_PICTURES.unleashedEn : NBHD_PICTURES.unleashedOther;
        factor = NBHD_SCALE_UNLEASHED;
        unleashed = true;
      }
      const bg = await UIRes.load()
        .then((res) => res.rgba(id))
        .catch(() => null);
      if (bg) {
        const bgImg = fromRgba(bg.data, bg.width, bg.height, 555);
        let w = house.w;
        let h = house.h;
        let left: number;
        let top: number;
        if (unleashed) {
          w = Math.trunc((w + (w & 1)) / 2);
          h = Math.trunc((h + (h & 1)) / 2);
          const t = info.thmbSmall ?? { x: 0, y: 0, z: 0, dx: 0, dy: 0 };
          left = info.lotX - t.x + Math.min(t.dx, 0);
          top = info.lotY - t.y - t.z + Math.min(t.dy, 0);
          h = Math.min(h, bgImg.h);
          w = Math.min(w, bgImg.w);
        } else {
          left = info.lotX - Math.trunc(w / 2);
          top = info.lotY - Math.trunc(h / 2) - 10;
        }
        let x1 = left + w;
        let y1 = top + h;
        if (left < 0) {
          x1 -= left;
          left = 0;
        }
        if (top < 0) {
          y1 -= top;
          top = 0;
        }
        if (x1 > bgImg.w) {
          left -= x1 - bgImg.w;
          x1 = bgImg.w;
        }
        if (y1 > bgImg.h) {
          top -= y1 - bgImg.h;
          y1 = bgImg.h;
        }
        const part = scaleBitmap(crop(bgImg, left, top, x1 - left, y1 - top), factor, factor, null);
        blit(part, house, 0, 0, TRANSPARENT_555);
        out = part;
      }
    }
  }
  await applyLogo(out);
  await saveJpeg(path, out, 0x5a);
}

/** The four house pictures of ExportHTML (MakeWebPageThumbnail's calls, then floor 2 when the house has one). */
async function makeHousePictures(gfxDir: string, lot: ExportLot, nb: Neighborhood | null, edition: number): Promise<void> {
  const shots: Array<[string, number, number, boolean]> = [
    ["house-thumb.jpg", 0, 1, true],
    ["house-exterior.jpg", 0, 0, false],
    ["house-floor1.jpg", 1, 0, false],
  ];
  if (lot.beenTo2ndLevel) shots.push(["house-floor2.jpg", 2, 0, false]);
  for (const [name, level, scale, thumb] of shots) {
    await makeWebPageThumbnail(`${gfxDir}${name}`, lot, nb, level, scale, thumb, edition).catch((e: unknown) => console.warn(`[exporthtml] ${name}`, e));
  }
}

// ---------------------------------------------------------------------------
// The lot

/** House +0x60 / +0x64: Global.iff STR# 505's size and furnishings curves. */
async function scoreCurves(): Promise<{ size: ReturnType<typeof piecewiseFromText>; furnishings: ReturnType<typeof piecewiseFromText> }> {
  const res = await SimResources.load();
  const curves = res.glob ? loadStringSet(res.glob, STR_HOUSE_SCORE_CURVES) : null;
  return { size: piecewiseFromText(curves?.[0]), furnishings: piecewiseFromText(curves?.[1]) };
}

/** The lot shown in the lot view (the family's house when cSimsApp::SaveGame exports it). */
export async function exportLotFromView(lv: WinLotView, members: number): Promise<ExportLot | null> {
  const viewer = lv.viewer;
  const lot = lv.lotObjects;
  const sim = lv.sim;
  if (!viewer || !lot || !sim) return null;
  // The house file as House::SaveFile just wrote it (the usage maps of the save).
  const house = await ResFile.open(lv.housePath).catch(() => lv.house);
  if (!house) return null;
  const fixed = viewer.world.fixed;
  const rooms = lv.rooms;
  const curves = await scoreCurves();
  const stats = getHouseStats({
    fixed,
    rooms: rooms ? rooms.inUseRooms() : [],
    objects: new Map(moduleOrder(lot.module).map((o) => [o.objectId, o])),
    members,
    objectValue: sim.objectValue,
    archValue: sim.archValue,
    layout: sim.layoutHistory ?? clearLayoutHistory(),
    sizeFn: curves.size,
    furnishingsFn: curves.furnishings,
  });
  return {
    houseNumber: houseNumberOfPath(lv.housePath),
    house,
    viewer,
    walls: lv.wallManager,
    lighting: lv.lighting,
    terrain: lv.terrain,
    rooms,
    module: lot.module,
    stats,
    beenTo2ndLevel: fixed.beenTo2ndLevel,
    daysRunning: sim.globals[G.daysRunning] ?? 0,
  };
}

/** The view size of a lot opened for the export (any: the pictures render in pieces of it). */
const HEADLESS_VIEW = { w: 800, h: 600 } as const;

/**
 * Neighborhood::LoadHouse for the export, from the neighborhood screen: the
 * house file opened as WinLotView::init does without the simulator and the
 * people (world/thumbnail.ts withHouseThumbnails): the world, the walls,
 * the objects, the roofs, the rooms and their light, a HouseViewer at the
 * saved zoom. The stats come from the saved simulator (SIMI: the values,
 * global 28) and HOUS 1 (the layout history). Call `dispose` when done.
 */
async function loadExportLot(path: string, members: number): Promise<{ lot: ExportLot; dispose: () => void } | null> {
  const house = await ResFile.open(path).catch(() => null);
  if (!house) return null;
  const world = new RotatableWorld(FixedWorld.load(house, readLotSize(house)));
  const floors = new FloorGraphicsMgr();
  await floors.initialize();
  await floors.loadUsageMap(house, world.fixed);
  const comp = new Compositor(HEADLESS_VIEW.w, HEADLESS_VIEW.h);
  const dispose = (): void => void comp.gl.getExtension("WEBGL_lose_context")?.loseContext();
  try {
    const v = new HouseViewer(world, comp, floors, HEADLESS_VIEW.w, HEADLESS_VIEW.h);
    const terrain = Terrain.create();
    terrain.terrainZ = (x, y) => Math.min(0xffff, Math.max(0, v.getTerrainZ(x, y)));
    v.terrain = terrain;
    const walls = await WallManager.create(house, world);
    walls.setWallState(WallState.Up);
    v.walls = walls;
    const objs = await loadLotObjectDrawer(house, world.fixed);
    v.objects = objs.drawer;
    objs.drawer.cutawayView = walls;
    walls.customWallStyle = customWallStyleOf(objs, world.fixed);
    loadRoofSettings(house);
    roofLayersOf(world.fixed).objects = () => objs.objects;
    const rooms = new RoomManager(world.fixed);
    computeRooms(world.fixed, rooms);
    rooms.computeCutaway(v, 0);
    const lighting = new RoomLighting(rooms, world, () => objs.objects);
    lighting.compute(0);
    v.lighting = lighting;
    const hous = house.get("HOUS", 0);
    const zoom = hous && hous.length >= 20 ? new DataView(hous.buffer, hous.byteOffset, hous.byteLength).getInt32(16, true) : 3;
    v.scale = zoom >= 1 && zoom <= 3 ? zoom : 3;
    const simi = house.get("SIMI", 1);
    const si = simi ? readSimi(simi) : null;
    const curves = await scoreCurves();
    const stats = getHouseStats({
      fixed: world.fixed,
      rooms: rooms.inUseRooms(),
      objects: new Map(moduleOrder(objs.module).map((o) => [o.objectId, o])),
      members,
      objectValue: si?.objectsValue ?? 0,
      archValue: si?.architectureValue ?? 0,
      layout: readLayoutHistory(house.get("HOUS", 1)),
      sizeFn: curves.size,
      furnishingsFn: curves.furnishings,
    });
    const lot: ExportLot = {
      houseNumber: houseNumberOfPath(path),
      house,
      viewer: v,
      walls,
      lighting,
      terrain,
      rooms,
      module: objs.module,
      stats,
      beenTo2ndLevel: world.fixed.beenTo2ndLevel,
      daysRunning: si?.globals[G.daysRunning] ?? 0,
    };
    return { lot, dispose };
  } catch (e) {
    dispose();
    throw e;
  }
}

// ---------------------------------------------------------------------------
// ExportHTML / ExportHTMLHomelessFamilies / ExportHTMLNeighborhood

/**
 * The language folder of the templates, spelled as on disk. An install has
 * its own language's folder and the English one; for another language chosen
 * on the landing page (engine/language.ts) the English templates are used.
 */
async function templatesDir(): Promise<string> {
  const dir = `${TEMPLATES}${languageDir(LANG)}`;
  const prefix = `sims/${dir}`.toLowerCase();
  if ((await fetchManifest()).files.some((f) => f.path.toLowerCase().startsWith(prefix))) return resolveDir(dir);
  return resolveDir(`${TEMPLATES}${languageDir(1)}`);
}

/** Steps 1 and 2 of ExportHTML / ExportHTMLHomelessFamilies: StockGFX, then the template's files. */
async function exportTemplateFiles(tmpl: string, out: string, tags: readonly string[], values: string[], family: TemplateFamily): Promise<boolean> {
  for (const f of await listDir(`${tmpl}${STOCK_GFX}`)) await copyGameFile(f, `${out}${STOCK_GFX}${removePath(f)}`);
  for (const f of await listDir(tmpl)) {
    const ext = extensionOf(f);
    if (ext === ".htm" || ext === ".html") {
      if (!(await makeWebPagesFromTemplate(f, out, tags, values, family, null))) return false;
    } else {
      await copyGameFile(f, `${out}${removePath(f)}`);
    }
  }
  return true;
}

/** The family's photo album (Family::GetScrapbook: <neighborhood>/PhotoAlbum/, "<name>_<number>"). */
async function scrapbookOf(ctx: GameContext, nbhdDir: string, f: FamilyView): Promise<Scrapbook | null> {
  return Scrapbook.load(ctx, nbhdDir, `${f.name}_${f.id}`).catch(() => null);
}

/** ExportHTML(templates, web pages, family, CPState) for a family whose house is `lot`. */
async function exportHTML(ctx: GameContext, store: NeighborhoodStore, fam: ExportFamily, lot: ExportLot, nb: Neighborhood | null): Promise<boolean> {
  const nbhdDir = store.dir;
  const f = fam.view;
  const edition = await editionOf(nbhdDir);
  const tags = lookupTags();
  const values = new Array<string>(TAG_COUNT).fill("");
  const ms = await memberStrings(ctx);
  const book = await scrapbookOf(ctx, nbhdDir, f);
  houseData(values, ms, f, lot.stats, lot.beenTo2ndLevel);
  familyAndScrapbookData(ctx, values, ms, fam, store, lot.daysRunning, book?.getPageCount() ?? 0, edition);
  const lang = await templatesDir();
  const tmpl = await resolveDir(`${lang}${f.houseNumber}_Sim_Lane/`);
  const name = underscored(f.name);
  const site = `${name}_${f.houseNumber}`;
  const out = `${nbhdDir}/${WEB_PAGES}${site}${SIM_LANE}/`;
  if (!(await exportTemplateFiles(tmpl, out, tags, values, { members: f.memberGuids.length, scrapbook: book }))) return false;
  const gfx = `${out}${FAMILY_GFX}`;
  await generateFamilyMemberJpegs(fam, nbhdDir, gfx);
  await makeHousePictures(gfx, lot, nb, edition);
  return makePublishingInfo(nbhdDir, `${site}${SIM_LANE}/`, `${name}_${f.id}`, tags, values, f, edition, houseFiles(lot.house, lot.module));
}

/** ExportHTMLHomelessFamilies(templates, web pages, family) */
async function exportHTMLHomelessFamilies(ctx: GameContext, store: NeighborhoodStore, fam: ExportFamily): Promise<boolean> {
  const nbhdDir = store.dir;
  const f = fam.view;
  const edition = await editionOf(nbhdDir);
  const tags = lookupTags();
  const values = new Array<string>(TAG_COUNT).fill("");
  const ms = await memberStrings(ctx);
  const book = await scrapbookOf(ctx, nbhdDir, f);
  homelessHouseData(values);
  // cSimulator::GetDaysRunning with the house unloaded.
  familyAndScrapbookData(ctx, values, ms, fam, store, 0, book?.getPageCount() ?? 0, edition);
  const lang = await templatesDir();
  const tmpl = await resolveDir(`${lang}0_Sim_Lane/`);
  const name = underscored(f.name);
  const out = `${nbhdDir}/${WEB_PAGES}${name}/`;
  if (!(await exportTemplateFiles(tmpl, out, tags, values, { members: f.memberGuids.length, scrapbook: book }))) return false;
  await generateFamilyMemberJpegs(fam, nbhdDir, `${out}${FAMILY_GFX}`);
  return makePublishingInfo(nbhdDir, `${name}/`, `${name}_${f.id}`, tags, values, f, edition, { floors: [], walls: [], objects: [] });
}

/** GenerateNeighborhoodData's families: the zoned residential lots' (houses 1..10 without Unleashed), then the unhoused. */
async function neighborhoodFamilies(store: NeighborhoodStore, nb: Neighborhood, edition: number, zoningOnly: boolean): Promise<TemplateNeighborhoodFamily[]> {
  const out: TemplateNeighborhoodFamily[] = [];
  const add = (f: FamilyView | undefined): void => {
    if (f) out.push({ name: f.name, house: f.houseNumber, familyNumber: f.id, members: f.memberGuids.length });
  };
  const inHouse = (house: number): FamilyView | undefined => {
    const id = store.familyOfHouse(house);
    return id === undefined ? undefined : store.family(id);
  };
  if (!zoningOnly && (edition & EDITION_UNLEASHED) === 0) {
    for (let h = 1; h <= 10; h++) add(inHouse(h));
  } else {
    for (const z of nb.zoning) if (z.zone === 1) add(inHouse(z.house));
  }
  for (const id of store.unhousedFamilies()) add(store.family(id));
  return out;
}

/** ExportHTMLNeighborhood(templates, web pages, neighborhood) */
async function exportHTMLNeighborhood(store: NeighborhoodStore, nb: Neighborhood): Promise<boolean> {
  const nbhdDir = store.dir;
  const edition = await editionOf(nbhdDir);
  const values = new Array<string>(NEIGHBORHOOD_TAGS.length).fill("");
  // GenerateNeighborhoodData
  values[N.count] = String((await neighborhoodFamilies(store, nb, edition, false)).length);
  values[N.charset] = webCharacterSet(LANG);
  values[N.language] = webLanguageCode(LANG);
  values[N.edition] = String((edition << 16) >> 16);
  const lang = await templatesDir();
  const web = `${nbhdDir}/${WEB_PAGES}`;
  const gfxIn = await resolveDir(`${lang}${NEIGHBORHOOD_GFX}`);
  const gfxOut = `${web}${NEIGHBORHOOD_GFX}`;
  for (const f of await listDir(gfxIn)) await copyGameFile(f, `${gfxOut}${removePath(f)}`);
  // The lot pictures: copies of NeighborhoodGFX/StockGFX/ (missing from the shipped templates: the copies fail).
  const stock = `${gfxIn}${STOCK_GFX}`;
  for (const z of nb.zoning) {
    const src = store.familyOfHouse(z.house) !== undefined ? "onestoryhouse.gif" : "emptylot.gif";
    await copyGameFile(`${stock}${src}`, `${gfxOut}lot${z.house}thumb.gif`);
  }
  // MakeWebPagesFromTemplate's familyX.html list (the zoning list, then the unhoused families).
  const families = await neighborhoodFamilies(store, nb, edition, true);
  for (const f of await listDir(lang)) {
    const ext = extensionOf(f);
    if (ext === ".htm" || ext === ".html") {
      if (!(await makeWebPagesFromTemplate(f, web, NEIGHBORHOOD_TAGS, values, null, families))) return false;
    } else {
      await copyGameFile(f, `${web}${removePath(f)}`);
    }
  }
  return true;
}

/** app +0x66: the installed packs (the object folder's). */
async function editionOf(nbhdDir: string): Promise<number> {
  return (await ObjectFolder.get(nbhdDir)).packs;
}

function isSpecialFamily(number: number): boolean {
  return SPECIAL_FAMILY_NUMBERS.has(number) || (number >= 3000 && number <= 3009);
}

/**
 * ExportFamilyHTML(family): the pages of family `familyId` (a family id of
 * `store`), its +0x138 flags set to 0x18 and saved. `lv` is the lot view
 * when its lot is the family's house (cSimsApp::SaveGame); without it a
 * housed family's lot is loaded for the export. Resolves whether the pages
 * were written.
 */
export async function exportFamilyHTML(ctx: GameContext, store: NeighborhoodStore, familyId: number, lv: WinLotView | null = null): Promise<boolean> {
  const view = store.family(familyId);
  if (!view || isSpecialFamily(view.id)) return false;
  const fam = await exportFamilyOf(store, familyId);
  if (!fam) return false;
  let ok = false;
  try {
    if (view.houseNumber === 0) {
      ok = await exportHTMLHomelessFamilies(ctx, store, fam);
    } else {
      const nb = await Neighborhood.load(store.dir).catch(() => null);
      const shown = lv && houseNumberOfPath(lv.housePath) === view.houseNumber ? await exportLotFromView(lv, view.memberGuids.length) : null;
      if (shown) {
        ok = await exportHTML(ctx, store, fam, shown, nb);
      } else {
        const path = nb ? nb.getHousePath(view.houseNumber) : `${store.dir}/Houses/House${String(view.houseNumber).padStart(2, "0")}.iff`;
        const loaded = await loadExportLot(path, view.memberGuids.length).catch((e: unknown) => {
          console.warn(`[exporthtml] LoadHouse ${path}`, e);
          return null;
        });
        if (loaded) {
          try {
            ok = await exportHTML(ctx, store, fam, loaded.lot, nb);
          } finally {
            loaded.dispose();
          }
        }
      }
    }
  } catch (e) {
    console.warn(`[exporthtml] family ${view.id}`, e);
  }
  // Family +0x138 = (flags & ~0x18) | 0x18, in memory and in Neighborhood.iff.
  const now = store.family(familyId);
  if (now) {
    store.setFamilyBudgetAndFlags(familyId, now.budget, (now.flags & ~FLAGS_AFTER_EXPORT) | FLAGS_AFTER_EXPORT);
    await store.save();
  }
  return ok;
}

/** ExportNghHTML: the neighborhood's pages (the house unloaded first). */
export async function exportNghHTML(store: NeighborhoodStore): Promise<boolean> {
  const nb = await Neighborhood.load(store.dir);
  return exportHTMLNeighborhood(store, nb);
}

/**
 * GetFamiliesNeedingHTMLExport: the family numbers whose +0x138 bit 3 is
 * clear; the first time with Unleashed while fewer than two runs counted
 * Makin' Magic (cOptionsMgr::GetRunPAFMagicCount), every family of houses
 * 1..9 too (its bit 3 cleared).
 */
export async function getFamiliesNeedingHTMLExport(store: NeighborhoodStore): Promise<number[]> {
  const out: number[] = [];
  const ids = store.familyIds();
  for (const id of ids) {
    const f = store.family(id);
    if (f && (f.flags & FLAG_HTML_EXPORTED) === 0 && f.id !== 0) out.push(f.id);
  }
  if (getOptionsMgr().getRunPAFMagicCount() < 2 && ((await editionOf(store.dir)) & EDITION_UNLEASHED) !== 0 && !unleashedReexportDone) {
    unleashedReexportDone = true;
    for (const id of ids) {
      const f = store.family(id);
      if (!f || f.id === 0 || f.houseNumber <= 0 || f.houseNumber >= 10) continue;
      store.setFamilyBudgetAndFlags(id, f.budget, f.flags & ~FLAG_HTML_EXPORTED);
      out.push(f.id);
    }
  }
  return out;
}

/** Neighborhood::GetFamily(number): Family +0x10c is the FAMI chunk id (the store's family id). */
function familyIdOfNumber(store: NeighborhoodStore, number: number): number | undefined {
  return store.family(number) ? number : undefined;
}

// ---------------------------------------------------------------------------
// cWinNeighborhoodUL::DoInternetUpdate

/** What DoInternetUpdate drives on the neighborhood screen. */
export interface InternetUpdateHost {
  ctx: GameContext;
  nbhdDir: string;
  /** +0x1b4 */
  setBusy(on: boolean): void;
  /** Every lot button's flags 0x400 and 2 (enabled) off / back on. */
  setLotsActive(on: boolean): void;
  /** cDDDSimsView::StartWatchCursor (on) / the cursor back (off). */
  watchCursor(on: boolean): void;
}

/** SubscribeTimerMsg(100): the state machine's tick. */
const TICK_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * cWinNeighborhoodUL::DoInternetUpdate as its timer runs it:
 *  - first call: GetFamiliesNeedingHTMLExport; with families to do,
 *    "bkground_fade" and the yes / no question (UIText STR# 167 entries 2 /
 *    1), anything but Yes playing "bkground_nhood1" and stopping; then busy
 *    (+0x1b4), the lots' rollover and enabled flags off, a 100 ms timer;
 *  - each tick: the next family (special ones skipped) gets a picture dialog
 *    (title entry 1, entry 3 with $family, kNghInetUpdateIcon) shown
 *    modally; the next tick runs StartWatchCursor and ExportFamilyHTML and
 *    closes it;
 *  - when none is left: not busy, ExportNghHTML, ShellExecute("open",
 *    <neighborhood>/Web Pages/neighborhood.html) (here a new browser tab on
 *    /webpages/, the saved copy with webpages-compat.js), the lots back, "bkground_nhood1".
 * SetBlockSimulator (the hidden lot view's simulator) has nothing to block here.
 */
export async function doInternetUpdate(host: InternetUpdateHost): Promise<void> {
  const { ctx, nbhdDir } = host;
  const str = (i: number): string => ctx.strings.get("UIText", STR_INET, i);
  const store = await NeighborhoodStore.open(nbhdDir);
  const pending = await getFamiliesNeedingHTMLExport(store);
  if (pending.length > 0) {
    soundPlayer.playBySource(MUSIC.fade, -1);
    const r = await TSWinMsgBox.show(ctx, str(1), str(0), MB_YESNO);
    if (r !== IDYES) {
      soundPlayer.playBySource(MUSIC.hood, -1);
      return;
    }
  }
  host.setBusy(true);
  host.setLotsActive(false);
  try {
    const icon = await ctx.res.image(INET_UPDATE_ICON).catch(() => null);
    while (pending.length > 0) {
      await sleep(TICK_MS);
      const number = pending.shift()!;
      const id = familyIdOfNumber(store, number);
      const f = id === undefined ? undefined : store.family(id);
      if (id === undefined || !f || isSpecialFamily(f.id)) continue;
      const dlg = new WinPictureDialog(ctx);
      dlg.setTitle(str(0));
      dlg.addText(str(2).replace("$family", f.name));
      dlg.setImage(icon);
      const shown = dlg.run();
      await sleep(TICK_MS);
      host.watchCursor(true);
      try {
        await exportFamilyHTML(ctx, store, id);
      } finally {
        host.watchCursor(false);
        dlg.close();
        await shown.catch(() => 0);
      }
    }
    await sleep(TICK_MS);
    await exportNghHTML(store).catch((e: unknown) => console.warn("[exporthtml] ExportNghHTML", e));
    // ShellExecute("open", <neighborhood>/Web Pages/neighborhood.html): /webpages/ serves the saved
    // page with the compatibility script its 2000 scripts need (server/src/routes/webpages.ts).
    const url = `/webpages/Sims/${[nbhdDir, "Web Pages", "neighborhood.html"].map(encodeURIComponent).join("/")}`;
    if (!window.open(url, "_blank")) console.warn(`[exporthtml] could not open ${url}`);
  } finally {
    host.setBusy(false);
    host.setLotsActive(true);
    soundPlayer.playBySource(MUSIC.hood, -1);
  }
}
