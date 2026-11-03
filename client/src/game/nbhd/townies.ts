/**
 * The neighborhood's townies (Hot Date): Neighborhood::DoFirstTimeTownies,
 * RefillTownies and AddNewTownie, run by the neighborhood screen (move in,
 * Downtown) through cWinProgressPictureDialog.
 *
 *  - DoFirstTimeTownies: only with Hot Date (cSimsApp +0x66 & 4) and the NGBH
 *    flag +0x19d ("townies needed": DoStream defaults it to 1 for files older
 *    than version 0x42). A family that already has id 2000 moves to the
 *    largest id + 1, then RefillTownies(30), +0x19c = 1, +0x19d = 0, the
 *    families are sorted (customsort, lbl_105BB988) and the neighborhood saved.
 *  - RefillTownies(n): the template selectors are the ObjectFolder objects
 *    whose OBJD type (+0x12) is 0x400 (TemplateNPCs/HDT_*_<sex><skin>.iff,
 *    the "premade" townies) and the first one of type 0x200
 *    (HDT_Generic.iff). The townie family is the family with id 2000. When it
 *    does not exist it is created (Family(module, 2000), name = UIText STR#
 *    211 entry 1, "Townie" without it), a progress dialog is shown (STR# 211
 *    entries 2 / 3, kSocialPopupIcon, total n) and up to 10 premade townies
 *    are drawn at random (each template at most once). Otherwise, when it has
 *    fewer than n members, the dialog shows STR# 211 entries 4 / 5 with total
 *    n - members. Then until the family has n members: no premade left ->
 *    generic; else one chance in five (RandomUint32Uniform(5) == 3) for a
 *    premade, the generic otherwise. The neighborhood is saved at the end.
 *  - AddNewTownie(template GUID, GenNPCInfo): StubObject::CreateNew of the
 *    template into the first free Characters/User%05d.iff (label prefix
 *    "User%05d "), AddNewNeighbor for the new file, its OBJD type set to 2
 *    (person, ChangedDef). From the generic template: gender = rand(500) & 1
 *    ^ 1, skin by rand(500) % 3 (0 lgt, 1 med, 2 drk), a random body suit and
 *    head suit (recorded in GenNPCInfo, which the game never re-draws on a
 *    collision), SetupNewHDSkins. Both kinds then get a first name from
 *    Live.iff STR# 150 (male) / 151 (female): entry RandomUint32Uniform(size
 *    - 1) + 1, up to 10 draws avoiding the names already given (GenNPCInfo
 *    +0x1c male / +0x28 female lists; a female checks the male list while
 *    the female one is empty). EndDesignAPerson(save) writes the person data,
 *    the portraits and the character file (cas/personfinder.ts).
 *
 * A premade townie takes nothing from its template in code: AddNewTownie
 * only runs BeginDesignAPerson (PersonFinder::CreateInstance, whose Init
 * tree is the template's), the first name and EndDesignAPerson, and
 * Neighbor::Neighbor zeroes the person data. The template's personality,
 * interests and job are set by its own trees, copied into the character
 * file with the rest of its resources: "init tree" (BHAV 4097) runs "init
 * traits" (interests) and sets job 15 level 3 only when person data 61 (the
 * family number) is 2000 and there is no job yet, which is not the case
 * while the person is created (Family::AddMember comes after AddNewTownie);
 * "Main" (4096) runs "Clear Personality" and writes the five traits when the
 * townie runs on a lot. Like a Create-a-Sim person it gets
 * RandomizeAllInterests (cXPerson::Initialize of the CAS instance).
 *
 * Tourist families (Vacation), families 3000..3009:
 *  - DoFirstTimeTouristFamilies (Mac 100a1c20): only with Vacation (cSimsApp
 *    +0x66 & 8) and the NGBH flag +0x19f ("tourists needed", 1 for files
 *    older than version 0x44). Every family already using an id of
 *    3000..3009 moves to the largest id + 1, then RefillTouristFamilies(10),
 *    +0x19e = 1, +0x19f = 0, the families are sorted (lbl_105BB988) and the
 *    neighborhood saved.
 *  - RefillTouristFamilies(n) (Mac 100a1db0): the template is the first
 *    ObjectFolder object of type 0x200 (HDT_Generic.iff). n drops by one per
 *    existing family of 3000..3009; when some are missing a progress dialog
 *    (UIText STR# 230 entries 2 / 3, kDialogVILogo, total n) is shown and
 *    each missing id becomes a new family, appended to the family vector and
 *    ticked: its name is entry rand(1000) % count of Live.iff STR# 160 (then
 *    removed from the set for this refill); adults are a couple (60 %), a man
 *    alone (20 %) or a woman alone (20 %); children are 1 (25 %), 2 (45 %),
 *    1 (15 %) or 2 (15 %). The family skin is lgt / med / drk (33 / 33 / 34
 *    %), a second skin is the same 70 % of the time, else drawn again. The
 *    man takes the first skin, the woman the first (75 %) or the second; a
 *    child the first (45 %), the second (45 %) or a fresh draw (10 %), and is
 *    a boy or a girl (50 %). First names: Live.iff STR# 161 men, 162 women,
 *    163 boys, 164 girls (sets reloaded per family, an entry used once per
 *    family). The neighborhood is saved at the end.
 *  - AddNewTourist(template, age, gender, names, skin) (Mac 100a9830): the
 *    AddNewTownie file part (Characters/User%05d.iff, OBJD type 2), then
 *    BeginDesignAPerson, SetAge, SetGender, SetColor, a random body suit and
 *    head suit (RandomUint32Uniform(max(1000, 2 count)) % count),
 *    SetupNewHDSkins, the first name (rand(1000) % count, removed from the
 *    set) and EndDesignAPerson(save).
 */

import { fetchManifest, readAssetFile } from "../../engine/assets.js";
import { CasSession, type CasPerson } from "../cas/personfinder.js";
import {
  EditPerson,
  PERSON_AGE_ADULT,
  PERSON_AGE_CHILD,
  PERSON_GENDER_FEMALE,
  PERSON_GENDER_MALE,
  type PersonColor,
} from "../cas/editperson.js";
import type { GameContext } from "../context.js";
import { bodyStringsOf, readCharacterFile } from "../data/character.js";
import { parseIffMapOrder, type IffChunk } from "../data/iff.js";
import type { NeighborhoodStore } from "../data/nbhdstore.js";
import { WinProgressPictureDialog } from "./winprogresspicturedialog.js";

/** Family id of the townies. */
export const TOWNIE_FAMILY_ID = 2000;
/** cWinNeighborhoodUL / DoFirstTimeTownies: the townie count kept in the neighborhood. */
export const TOWNIE_COUNT = 0x1e;
/** OBJD types of the townie templates. */
const OBJ_TYPE_GENERIC_TOWNIE = 0x200;
const OBJ_TYPE_PREMADE_TOWNIE = 0x400;
/** UIText STR# 211: townie family name, then the two dialog title / text pairs. */
const STR_TOWNIES = 211;
/** Live.iff STR# 150 / 151: male / female first names. */
const STR_MALE_NAMES = 150;
const STR_FEMALE_NAMES = 151;
/** lbl_105BB990 + 0x57: the family name without STR# 211. */
const DEFAULT_TOWNIE_FAMILY_NAME = "Townie";
/** Premade townies drawn while the family is created. */
const PREMADE_ON_CREATE = 10;

interface Template {
  guid: number;
  type: number;
  chunks: IffChunk[];
}

/** GenNPCInfo: what RefillTownies' AddNewTownie calls already handed out. */
interface GenNPCInfo {
  bodies: number[];
  /** sGenderSkin (the two raw draws) -> head suits given. */
  heads: Map<string, number[]>;
  maleNames: number[];
  femaleNames: number[];
}

/** cRZRandom::RandomUint32Uniform(n) */
function random(n: number): number {
  return Math.floor(Math.random() * n);
}

let templatesPromise: Promise<Template[]> | null = null;

/** The TemplateNPCs objects of type 0x200 / 0x400, in folder (file name) order. */
function townieTemplates(): Promise<Template[]> {
  templatesPromise ??= (async () => {
    const files = (await fetchManifest()).files
      .map((f) => f.path)
      .filter((p) => /^sims\/templatenpcs\/[^/]+\.iff$/i.test(p))
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    const out: Template[] = [];
    for (const path of files) {
      const bytes = await readAssetFile(path).catch(() => null);
      if (!bytes) continue;
      const chunks = parseIffMapOrder(bytes);
      const objd = chunks.find((c) => c.type === "OBJD");
      if (!objd) continue;
      const v = new DataView(objd.data.buffer, objd.data.byteOffset, objd.data.byteLength);
      const type = v.getInt16(0x12, true);
      if (type !== OBJ_TYPE_GENERIC_TOWNIE && type !== OBJ_TYPE_PREMADE_TOWNIE) continue;
      out.push({ guid: v.getUint32(0x1c, true), type, chunks });
    }
    return out;
  })();
  return templatesPromise;
}

/** cSimsApp +0x66 & 4 (Hot Date installed): the townie templates are present. */
async function hotDateInstalled(): Promise<boolean> {
  return (await townieTemplates()).some((t) => t.type === OBJ_TYPE_GENERIC_TOWNIE);
}

/** Neighborhood::DoFirstTimeTownies */
export async function doFirstTimeTownies(ctx: GameContext, store: NeighborhoodStore): Promise<void> {
  if (!(await hotDateInstalled())) return;
  const ngbh = store.ngbh();
  if (!ngbh.townies[1]) return;
  const ids = store.familyIds();
  if (ids.includes(TOWNIE_FAMILY_ID)) store.renumberFamily(TOWNIE_FAMILY_ID, Math.max(0, ...ids) + 1);
  await refillTownies(ctx, store, TOWNIE_COUNT, false);
  ngbh.townies = [true, false];
  store.touchNgbh();
  await store.save();
}

/** Neighborhood::RefillTownies(n); `save` false lets DoFirstTimeTownies save once at its end. */
export async function refillTownies(ctx: GameContext, store: NeighborhoodStore, n: number, save = true): Promise<void> {
  const templates = await townieTemplates();
  const generic = templates.find((t) => t.type === OBJ_TYPE_GENERIC_TOWNIE);
  if (!generic) return;
  const premade = templates.filter((t) => t.type === OBJ_TYPE_PREMADE_TOWNIE).map((t) => t.guid);
  await ctx.strings.load("GameData/Live.iff");
  const str = (i: number): string => ctx.strings.get("UIText", STR_TOWNIES, i - 1);
  const gen: GenNPCInfo = { bodies: [], heads: new Map(), maleNames: [], femaleNames: [] };
  const session = new CasSession(store, ctx.res);
  const byGuid = new Map(templates.map((t) => [t.guid, t]));
  const add = (guid: number): Promise<number> => addNewTownie(ctx, store, session, byGuid.get(guid)!, gen);

  let dlg: WinProgressPictureDialog | null = null;
  const openDialog = async (title: string, text: string, total: number): Promise<void> => {
    const d = new WinProgressPictureDialog(ctx);
    await d.init();
    await d.setTitle(title);
    d.addText(text);
    d.setImage(await ctx.res.image("kSocialPopupIcon").catch(() => null));
    d.setTotal(total);
    await d.show();
    dlg = d;
  };

  if (!store.familyIds().includes(TOWNIE_FAMILY_ID)) {
    store.newFamily(TOWNIE_FAMILY_ID, str(1) || DEFAULT_TOWNIE_FAMILY_NAME);
    await openDialog(str(2), str(3), n);
    while (store.familyMemberCount(TOWNIE_FAMILY_ID) < PREMADE_ON_CREATE && premade.length) {
      const i = random(premade.length);
      const guid = await add(premade[i]!);
      if (guid !== 0) {
        premade.splice(i, 1);
        store.addFamilyMember(TOWNIE_FAMILY_ID, guid);
        await (dlg as WinProgressPictureDialog | null)?.tickOnce();
      }
    }
  } else {
    const members = store.familyMemberCount(TOWNIE_FAMILY_ID);
    if (members >= n) return;
    await openDialog(str(4), str(5), n - members);
  }

  // A failing AddNewTownie would loop forever in the game; stop after as many failures as wanted townies.
  let failures = 0;
  while (store.familyMemberCount(TOWNIE_FAMILY_ID) < n && failures < n) {
    await (dlg as WinProgressPictureDialog | null)?.tickOnce();
    let guid = 0;
    if (premade.length === 0) {
      guid = await add(generic.guid);
    } else if (random(5) === 3) {
      const i = random(premade.length);
      guid = await add(premade[i]!);
      if (guid !== 0) premade.splice(i, 1);
    } else {
      guid = await add(generic.guid);
    }
    if (guid !== 0) store.addFamilyMember(TOWNIE_FAMILY_ID, guid);
    else failures++;
  }
  (dlg as WinProgressPictureDialog | null)?.close();
  if (save) await store.save();
}

/** RandomUint32Uniform(size - 1) + 1, up to 10 draws avoiding the names already given; "" when none. */
function pickName(ctx: GameContext, gender: number, gen: GenNPCInfo): string {
  const names = ctx.strings.list("Live", gender === PERSON_GENDER_MALE ? STR_MALE_NAMES : STR_FEMALE_NAMES);
  for (let tries = 0; tries < 10 && names.length > 1; tries++) {
    const index = random(names.length - 1) + 1;
    const used = gender === PERSON_GENDER_MALE || gen.femaleNames.length === 0 ? gen.maleNames : gen.femaleNames;
    if (used.includes(index)) continue;
    const name = names[index - 1] ?? "";
    if (!name) continue;
    (gender === PERSON_GENDER_MALE ? gen.maleNames : gen.femaleNames).push(index);
    return name;
  }
  return "";
}

/** Skin by draw % 3 (lbl_105BA09C / 98 / 94). */
const SKINS: readonly PersonColor[] = ["lgt", "med", "drk"];

/** Neighborhood::AddNewTownie: the new neighbor's GUID, 0 on failure. */
async function addNewTownie(
  ctx: GameContext,
  store: NeighborhoodStore,
  session: CasSession,
  template: Template,
  gen: GenNPCInfo,
): Promise<number> {
  let c: Awaited<ReturnType<NeighborhoodStore["addNewCharacterFrom"]>>;
  try {
    c = await store.addNewCharacterFrom(template.chunks);
  } catch (e) {
    console.warn("AddNewTownie failed", e);
    return 0;
  }
  const chunks = await readCharacterFile(store.dir, c.fileName);
  const p: CasPerson = {
    guid: c.guid,
    fileName: c.fileName,
    firstName: "",
    bio: "",
    bodyStrings: bodyStringsOf(chunks),
    personData: new Int16Array(store.getPersonData(c.guid)),
    face: null,
    edit: null,
  };
  const edit = await EditPerson.begin(p.bodyStrings, p.personData);
  p.edit = edit;
  if (template.type === OBJ_TYPE_GENERIC_TOWNIE) {
    const r1 = random(500);
    const r2 = random(500);
    edit.setGender((r1 & 1) ^ 1);
    edit.setColor(SKINS[r2 % 3]!);
    const bodies = edit.countAvailableBodySuits();
    const heads = edit.countAvailableHeadSuits();
    let body = 0;
    let head = 0;
    if (bodies > 0) {
      body = random(bodies);
      if (!gen.bodies.includes(body)) gen.bodies.push(body);
    }
    if (heads > 0) {
      head = random(heads);
      const key = `${r1},${r2}`;
      const used = gen.heads.get(key);
      if (!used) gen.heads.set(key, [head]);
      else if (!used.includes(head)) used.push(head);
    }
    edit.setBodySuit(body);
    edit.setHeadSuit(head);
    edit.setupNewHDSkins();
  }
  p.firstName = pickName(ctx, edit.getGender(), gen);
  await session.endDesignAPerson(p, true, true);
  return c.guid;
}

/** Tourist family ids: 3000 up to (not including) 0xbc2. */
const TOURIST_FAMILY_FIRST = 3000;
const TOURIST_FAMILY_END = 0xbc2;
/** cWinNeighborhoodUL / DoFirstTimeTouristFamilies: the tourist family count kept in the neighborhood. */
export const TOURIST_FAMILY_COUNT = 10;
/** UIText STR# 230: the tourist dialog title / text (entries 2 / 3). */
const STR_TOURISTS = 230;
/** Live.iff STR# 160: family names; 161..164: men, women, boys, girls first names. */
const STR_TOURIST_FAMILY_NAMES = 160;
const STR_TOURIST_MEN = 161;
const STR_TOURIST_WOMEN = 162;
const STR_TOURIST_BOYS = 163;
const STR_TOURIST_GIRLS = 164;
/** ObjectFolder's pack mask bit 8 (cSimsApp +0x66 & 8): the ExpansionPack4 folder. */
const VACATION_DIR = "sims/expansionpack4/";

/** cSimsApp +0x66 & 8 (Vacation installed). */
async function vacationInstalled(): Promise<boolean> {
  return (await fetchManifest()).files.some((f) => f.path.toLowerCase().startsWith(VACATION_DIR));
}

function touristFamilyIds(store: NeighborhoodStore): number[] {
  return store.familyIds().filter((id) => id >= TOURIST_FAMILY_FIRST && id < TOURIST_FAMILY_END);
}

/** Neighborhood::DoFirstTimeTouristFamilies (Mac 100a1c20) */
export async function doFirstTimeTouristFamilies(ctx: GameContext, store: NeighborhoodStore): Promise<void> {
  if (!(await vacationInstalled())) return;
  const ngbh = store.ngbh();
  if (!ngbh.b19e[1]) return;
  for (let id = TOURIST_FAMILY_FIRST; id < TOURIST_FAMILY_END; id++) {
    const ids = store.familyIds();
    if (ids.includes(id)) store.renumberFamily(id, Math.max(0, ...ids) + 1);
  }
  await refillTouristFamilies(ctx, store, TOURIST_FAMILY_COUNT, false);
  ngbh.b19e = [true, false];
  store.touchNgbh();
  await store.save();
}

/** rand(1000) % 100 against 33 / 66: lgt, med, drk (lbl_105BA09C / 98 / 94). */
function touristSkin(): PersonColor {
  const r = random(1000) % 100;
  return r < 0x21 ? "lgt" : r < 0x42 ? "med" : "drk";
}

/** StringSetBase::GetString(rand(1000) % Count + 1) then RemoveString; "" for an empty set. */
function takeString(set: string[]): string {
  if (set.length === 0) return "";
  const i = random(1000) % set.length;
  return set.splice(i, 1)[0] ?? "";
}

/**
 * Neighborhood::RefillTouristFamilies(n) (Mac 100a1db0); `save` false lets
 * DoFirstTimeTouristFamilies save once at its end.
 */
export async function refillTouristFamilies(ctx: GameContext, store: NeighborhoodStore, n: number, save = true): Promise<void> {
  if (!(await vacationInstalled())) return;
  const generic = (await townieTemplates()).find((t) => t.type === OBJ_TYPE_GENERIC_TOWNIE);
  let total = n - touristFamilyIds(store).length;
  await ctx.strings.load("GameData/Live.iff");
  const familyNames = ctx.strings.list("Live", STR_TOURIST_FAMILY_NAMES);
  if (total <= 0) return;
  const dlg = new WinProgressPictureDialog(ctx);
  await dlg.init();
  await dlg.setTitle(ctx.strings.get("UIText", STR_TOURISTS, 1));
  dlg.addText(ctx.strings.get("UIText", STR_TOURISTS, 2));
  dlg.setImage(await ctx.res.image("kDialogVILogo").catch(() => null));
  dlg.setTotal(total);
  await dlg.show();
  const session = new CasSession(store, ctx.res);
  for (let id = TOURIST_FAMILY_FIRST; id < TOURIST_FAMILY_END && total > 0; id++) {
    if (store.familyIds().includes(id)) continue;
    const names = [STR_TOURIST_MEN, STR_TOURIST_WOMEN, STR_TOURIST_BOYS, STR_TOURIST_GIRLS].map((s) => ctx.strings.list("Live", s));
    const [men, women, boys, girls] = names as [string[], string[], string[], string[]];
    store.newFamily(id, takeString(familyNames));
    let r = random(1000) % 100;
    // A couple (< 60), a man (< 80), else a woman.
    let man = r < 0x50 ? 1 : 0;
    let woman = r < 0x3c || r >= 0x50 ? 1 : 0;
    r = random(1000) % 100;
    let children = r < 0x19 ? 1 : r < 0x46 ? 2 : r < 0x55 ? 1 : 2;
    const skin1 = touristSkin();
    const skin2 = random(1000) % 100 < 0x46 ? skin1 : touristSkin();
    while (man !== 0 || woman !== 0 || children !== 0) {
      let guid = 0;
      if (man !== 0) {
        guid = await addNewTourist(store, session, generic, PERSON_AGE_ADULT, PERSON_GENDER_MALE, men, skin1);
        man--;
      } else if (woman !== 0) {
        guid = await addNewTourist(store, session, generic, PERSON_AGE_ADULT, PERSON_GENDER_FEMALE, women, random(1000) % 100 < 0x4b ? skin1 : skin2);
        woman--;
      } else {
        r = random(1000) % 100;
        const skin = r < 0x2d ? skin1 : r < 0x5a ? skin2 : null;
        const boy = random(1000) % 100 < 0x32;
        guid = await addNewTourist(
          store,
          session,
          generic,
          PERSON_AGE_CHILD,
          boy ? PERSON_GENDER_MALE : PERSON_GENDER_FEMALE,
          boy ? boys : girls,
          skin ?? touristSkin(),
        );
        children--;
      }
      if (guid !== 0) store.addFamilyMember(id, guid);
    }
    await dlg.tickOnce();
  }
  dlg.close();
  if (save) await store.save();
}

/** Neighborhood::AddNewTourist (Mac 100a9830): the new neighbor's GUID, 0 on failure. */
async function addNewTourist(
  store: NeighborhoodStore,
  session: CasSession,
  template: Template | undefined,
  age: number,
  gender: number,
  names: string[],
  skin: PersonColor,
): Promise<number> {
  if (!template) return 0;
  let c: Awaited<ReturnType<NeighborhoodStore["addNewCharacterFrom"]>>;
  try {
    c = await store.addNewCharacterFrom(template.chunks);
  } catch (e) {
    console.warn("AddNewTourist failed", e);
    return 0;
  }
  const chunks = await readCharacterFile(store.dir, c.fileName);
  const p: CasPerson = {
    guid: c.guid,
    fileName: c.fileName,
    firstName: "",
    bio: "",
    bodyStrings: bodyStringsOf(chunks),
    personData: new Int16Array(store.getPersonData(c.guid)),
    face: null,
    edit: null,
  };
  const edit = await EditPerson.begin(p.bodyStrings, p.personData);
  p.edit = edit;
  edit.setAge(age);
  edit.setGender(gender);
  edit.setColor(skin);
  const bodies = edit.countAvailableBodySuits();
  const heads = edit.countAvailableHeadSuits();
  const draw = (count: number): number => (count > 0 ? random(count > 999 ? count * 2 : 1000) % count : 0);
  edit.setBodySuit(draw(bodies));
  edit.setHeadSuit(draw(heads));
  edit.setupNewHDSkins();
  p.firstName = takeString(names);
  await session.endDesignAPerson(p, true, true);
  return c.guid;
}
