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
 * The person data of a premade townie is not filled from its template here
 * (the game's PersonFinder reads the object's attributes when the person is
 * first designed); like a Create-a-Sim person it gets RandomizeAllInterests.
 */

import { fetchManifest } from "../../engine/assets.js";
import { CasSession, type CasPerson } from "../cas/personfinder.js";
import { EditPerson, PERSON_GENDER_MALE, type PersonColor } from "../cas/editperson.js";
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
      const res = await fetch(`/assets/${encodeURI(path)}`);
      if (!res.ok) continue;
      const chunks = parseIffMapOrder(new Uint8Array(await res.arrayBuffer()));
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
