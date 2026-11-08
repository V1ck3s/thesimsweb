/**
 * The neighborhood side of primitive 19, Make New Character
 * (cXObject::TryMakeNewCharacter, Mac 100f1690; the primitive itself is in
 * sim/xobject.ts): the baby becoming a child (Baby.iff "create child"), the
 * litter of PetMaternityBox, the bought pets, the clones and the toad prince.
 *
 *  - Neighborhood::AddNewCharacter(type, -1): the template neighbor of the
 *    type (0 TemplatePerson 0x7fd96b54, 1 the dog 0x4a70df92, 2 the cat
 *    0x7bea0977) is copied to the first free Characters/User%05d.iff
 *    (StubObject::CreateNew), ObjectFolder::NewFileAdded, AddNewNeighbor;
 *  - the colour: entry colorIndex + 1 (1-based) of STR# 0x2000 in the new
 *    character's semi-global file (Behavior::GetMiddleFile), error 0x3b when
 *    it is empty (the character stays, as when the original throws);
 *  - EditPerson: SetAge, SetColor, SetGender (person: 0 / 1; dog 2 / 3;
 *    cat 4 / 5). A person needs body and head suits (random head, then
 *    random body); a pet a body suit (the picked coat, else random) and gets
 *    its portraits (GenerateBitmaps). Without the suits the edit is dropped
 *    and the character deleted (Neighborhood::DeleteCharacter);
 *  - the catalog name (CatalogResource::Save): the request's name.
 *
 * The port's EndDesignAPerson (cas/personfinder.ts) does the EditPerson::End
 * and CatalogResource::Save steps, and also writes the person data and the
 * portraits of a person (the port's panels need them; the original makes a
 * person's later). The neighborhood file is saved at once: the port's lot
 * save only carries relationships, families and person data back.
 */

import { CasSession, type CasPerson } from "../cas/personfinder.js";
import type { PersonColor } from "../cas/editperson.js";
import { EditPerson, PERSON_AGE_ADULT } from "../cas/editperson.js";
import { bodyStringsOf, readCharacterFile } from "../data/character.js";
import { NeighborhoodStore } from "../data/nbhdstore.js";
import type { UIRes } from "../res/uires.js";
import { loadStringSet } from "../sim/behavior.js";
import type { CharacterHooks, DesignedPerson, MakeCharacterRequest, MakeCharacterResult } from "../sim/simmodule.js";
import type { Simulator } from "../sim/simulator.js";
import { ObjectFolder } from "../world/objectfolder.js";
import { templateChunks } from "./imports.js";

/** STR# 0x2000 of the semi-global file: the colours (PersonGlobals: unknown, lgt, drk, med). */
const STR_COLORS = 0x2000;
/** The simulation error for a missing colour. */
const ERR_NO_COLOR = 0x3b;

export function characterHooks(nbhdDir: string, sim: Simulator, res: UIRes | undefined, saveGame: () => void): CharacterHooks {
  return {
    makeNewCharacter: (req) => makeNewCharacter(nbhdDir, sim, req, res),
    saveDesignedPerson: (p) => saveDesignedPerson(nbhdDir, p, res),
    saveGame,
    changeSimBaseType: (req) => changeSimBaseTypeToAdult(nbhdDir, sim, req, res),
  };
}

/** ChangeSimBaseType's skins by person data 60 (lbl_105BA09C / 94 / 98). */
const SKIN_BY_PD: Record<number, PersonColor> = { 1: "lgt", 2: "drk", 3: "med" };

/**
 * Neighborhood::ChangeSimBaseType(neighbor, person, 0x1b), its neighborhood
 * and file part (the sim part is sim/transforms.ts): the person's persistent
 * data into its neighbor, the family's flag 8 cleared, the person template
 * copied to a new character file with the same GUID (the old file deleted),
 * then the design steps on it (gender, skin, adult, random body and head
 * suits, SetupNewHDSkins, the old name and description,
 * EndDesignAPerson(save)) and the old persistent data back with the skin,
 * gender, age 0x1b and no job. The neighborhood is saved.
 */
async function changeSimBaseTypeToAdult(dir: string, sim: Simulator, req: { guid: number; personData: Int16Array; name: string; bio: string }, res?: UIRes): Promise<boolean> {
  const store = await NeighborhoodStore.open(dir);
  const guid = req.guid >>> 0;
  store.savePersistentData(guid, req.personData);
  const old = store.getPersonData(guid).slice();
  const gender = (old[65] ?? 0) & 1;
  let skin = old[60] ?? 0;
  if (skin < 1 || skin > 3) skin = 1 + Math.floor(Math.random() * 3);
  store.clearMemberFamilyFlags(guid, 8);
  const template = await templateChunks(dir, 0);
  if (!template) return false;
  const c = await store.changeCharacterFile(guid, template);
  if (!c) return false;
  await (await ObjectFolder.get(dir)).newFileAdded(`${dir}/Characters/${c.fileName}`, 1);
  const chunks = await readCharacterFile(dir, c.fileName);
  const p: CasPerson = { guid, fileName: c.fileName, firstName: req.name, bio: req.bio, bodyStrings: bodyStringsOf(chunks), personData: new Int16Array(256), face: null, edit: null };
  const edit = await EditPerson.begin(p.bodyStrings, p.personData);
  p.edit = edit;
  edit.setGender(gender);
  const color = SKIN_BY_PD[skin];
  if (color) edit.setColor(color);
  edit.setAge(PERSON_AGE_ADULT);
  const bodies = edit.countAvailableBodySuits();
  const heads = edit.countAvailableHeadSuits();
  if (bodies > 0) edit.setBodySuit(Math.floor(Math.random() * bodies));
  if (heads > 0) edit.setHeadSuit(Math.floor(Math.random() * heads));
  edit.setupNewHDSkins();
  await new CasSession(store, res).endDesignAPerson(p, true, false, false);
  const pd = old.slice();
  pd[60] = skin;
  pd[65] = gender;
  pd[58] = 0x1b;
  pd[0x38] = 0;
  pd[0x39] = 0;
  store.savePersistentData(guid, pd);
  await store.save();
  // The simulator's Neighborhood: the same neighbor (relationships kept) names the new file.
  const live = sim.module.nbhd?.neighbors.find((n) => n.guid >>> 0 === guid);
  const nd = store.neighborData(guid);
  if (live && nd) {
    live.name = nd.name;
    live.personData = nd.personData;
    if (nd.version !== undefined) live.version = nd.version;
  }
  return true;
}

/**
 * Neighborhood::ChildToAdult's EndDesignAPerson(save) and the family's flag 8
 * (sim/transforms.ts): the body strings, name and portraits go into the
 * character file, the person data into the neighbor.
 */
async function saveDesignedPerson(dir: string, d: DesignedPerson, res?: UIRes): Promise<void> {
  const store = await NeighborhoodStore.open(dir);
  const fileName = d.fileKey.split(/[\\/|]/).pop() ?? "";
  const p: CasPerson = { guid: d.guid >>> 0, fileName, firstName: d.name, bio: d.bio, bodyStrings: d.bodyStrings, personData: d.personData, face: null, edit: null };
  p.edit = await EditPerson.begin(d.bodyStrings, d.personData);
  await new CasSession(store, res).endDesignAPerson(p, true, false, false);
  store.clearMemberFamilyFlags(d.guid, 8);
  await store.save();
}

async function makeNewCharacter(dir: string, sim: Simulator, req: MakeCharacterRequest, res?: UIRes): Promise<MakeCharacterResult> {
  // MakeNewCharacterParam::eCharacterTypes beyond the cat leave the gender unset in the original.
  if (req.type < 0 || req.type > 2) return { neighborId: 0 };
  const store = await NeighborhoodStore.open(dir);
  let c: Awaited<ReturnType<NeighborhoodStore["addNewCharacter"]>>;
  try {
    if (req.type === 0) {
      c = await store.addNewCharacter();
    } else {
      const template = await templateChunks(dir, req.type);
      if (!template) return { neighborId: 0 };
      c = await store.addNewCharacterFrom(template);
    }
  } catch (e) {
    console.warn("[sim] AddNewCharacter failed", e);
    return { neighborId: 0 };
  }
  const folder = await ObjectFolder.get(dir);
  const sels = await folder.newFileAdded(`${dir}/Characters/${c.fileName}`, 1);
  const sel = sels.find((s) => s.objd.guid >>> 0 === c.guid >>> 0) ?? folder.selectorByGUID(c.guid);
  // The simulator's Neighborhood has the new neighbor (AddNewNeighbor).
  const live = sim.module.nbhd;
  const addLive = (): void => {
    const nb = store.neighborData(c.guid);
    if (!live || !nb) return;
    const i = live.neighbors.findIndex((x) => x.guid >>> 0 === c.guid >>> 0);
    if (i >= 0) live.neighbors[i] = nb;
    else live.neighbors.push(nb);
  };
  const middle = sel?.semiGlobalName ? sim.module.res.semiGlobal(sel.semiGlobalName) : null;
  const color = (middle ? loadStringSet(middle, STR_COLORS) : null)?.[req.colorIndex] ?? "";
  if (!color) {
    await store.save();
    addLive();
    return { neighborId: 0, error: ERR_NO_COLOR };
  }
  const chunks = await readCharacterFile(dir, c.fileName);
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
  edit.setAge(req.age);
  edit.setColor(color.toLowerCase() as PersonColor);
  const female = req.gender !== 0 ? 1 : 0;
  edit.setGender(req.type === 0 ? female : req.type === 1 ? 2 + female : 4 + female);
  const bodies = edit.countAvailableBodySuits();
  const heads = req.type === 0 ? edit.countAvailableHeadSuits() : 0;
  const gender = edit.getGender();
  const fail = async (): Promise<MakeCharacterResult> => {
    edit.end(false);
    p.edit = null;
    await store.deleteCharacter(c.guid);
    return { neighborId: 0 };
  };
  if (gender >= 0 && gender < 2) {
    if (bodies === 0 || heads === 0) return fail();
    edit.setHeadSuit((req.head >>> 0) % heads);
    edit.setBodySuit((req.body >>> 0) % bodies);
  } else if (gender >= 2 && gender < 6) {
    if (bodies === 0) return fail();
    edit.setBodySuit(req.petBody === -1 ? (req.body >>> 0) % bodies : req.petBody);
  } else {
    edit.end(false);
    return { neighborId: 0 };
  }
  p.firstName = req.name;
  await new CasSession(store, res).endDesignAPerson(p, true, true, false);
  await store.save();
  addLive();
  return { neighborId: c.neighborId };
}
