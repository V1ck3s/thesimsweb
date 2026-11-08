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
import { EditPerson } from "../cas/editperson.js";
import { bodyStringsOf, readCharacterFile } from "../data/character.js";
import { NeighborhoodStore } from "../data/nbhdstore.js";
import type { UIRes } from "../res/uires.js";
import { loadStringSet } from "../sim/behavior.js";
import type { CharacterHooks, MakeCharacterRequest, MakeCharacterResult } from "../sim/simmodule.js";
import type { Simulator } from "../sim/simulator.js";
import { ObjectFolder } from "../world/objectfolder.js";
import { templateChunks } from "./imports.js";

/** STR# 0x2000 of the semi-global file: the colours (PersonGlobals: unknown, lgt, drk, med). */
const STR_COLORS = 0x2000;
/** The simulation error for a missing colour. */
const ERR_NO_COLOR = 0x3b;

export function characterHooks(nbhdDir: string, sim: Simulator, res?: UIRes): CharacterHooks {
  return { makeNewCharacter: (req) => makeNewCharacter(nbhdDir, sim, req, res) };
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
