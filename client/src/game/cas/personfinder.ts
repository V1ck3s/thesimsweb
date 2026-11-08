/**
 * The PersonFinder side of Create-a-Sim: the people being designed, by
 * handle, and the steps the design windows call.
 *
 *  - MakeNewPerson (cWinDesignCharacter::Init with no person):
 *    Neighborhood::AddNewCharacter copies People\TemplatePerson.iff to the
 *    first free Characters/User%05d.iff, adds its neighbor (data/
 *    nbhdstore.ts) and tells the ObjectFolder (NewFileAdded); the new person
 *    starts from the template's body strings and an empty person data. The
 *    file has no name yet (no CTSS): cWinDesignCharacter's Done names it;
 *  - BeginDesignAPerson: an EditPerson on the person's body strings; the
 *    person's instance lives in house 0 (cas/caslot.ts), which the
 *    neighborhood screen keeps loaded (Neighborhood::UnloadHouse);
 *  - SetName / SetDescription (cWinDesignCharacter's Done, before
 *    EndDesignAPerson): CatalogResource::Save of the name and the
 *    biography into the character file and the OBJD label, at once;
 *  - EndDesignAPerson(save, kill, saveNeighborhood): the body-string side
 *    (EditPerson.end), SAnimator::ResetSuits' person data (age PD[58] =
 *    atoi(body string 14), gender PD[65], skin PD[60] = index of the skin in
 *    PersonGlobals STR# 8192), interests for a new person
 *    (cXPerson::Initialize), Neighborhood::SavePersistentData then
 *    Neighborhood::Save when asked (the design dialogs ask, the townie
 *    makers do not), the portraits (GenerateBitmaps), the instance killed
 *    when asked, and the body strings saved (EditPerson::End);
 *  - DeletePerson: the neighbor and the character file go.
 *
 * The family itself is written when it is finished (cWinDesignFamily done /
 * cancel).
 */

import { bodyStringsOf, needsInterests, randomizeAllInterests, readCharacterFile, saveCharacter, saveCharacterName } from "../data/character.js";
import type { NeighborhoodStore } from "../data/nbhdstore.js";
import { PD, type Neighbor } from "../data/neighborhood.js";
import { decodeImage } from "../res/bmp.js";
import type { UIRes } from "../res/uires.js";
import { SAnimator } from "../sims/index.js";
import { ObjectFolder } from "../world/objectfolder.js";
import { CasLot } from "./caslot.js";
import { EditPerson } from "./editperson.js";
import { generatePortraits } from "./portraits.js";

/** SAnimator::ResetSuits: body string 13 -> person data 65. */
const GENDERS = ["male", "female", "dogmale", "dogfemale", "catmale", "catfemale"];

/** PersonGlobals.iff STR# 8192: unknown, lgt, drk, med. */
const SKIN_INDEX: Record<string, number> = { lgt: 1, drk: 2, med: 3 };

export interface CasPerson {
  guid: number;
  /** Characters/<fileName> */
  fileName: string;
  firstName: string;
  bio: string;
  bodyStrings: string[];
  personData: Int16Array;
  /** The portrait button face (BMP_ 2002), once generated. */
  face: ImageBitmap | null;
  edit: EditPerson | null;
}

export class CasSession {
  readonly people: CasPerson[] = [];
  private lotLoad: Promise<CasLot | null> | null = null;

  constructor(
    readonly store: NeighborhoodStore,
    private readonly res?: UIRes,
  ) {}

  /**
   * House 0 with its simulator: the one the neighborhood screen keeps loaded
   * (Neighborhood::UnloadHouse), else loaded now (a design screen opened
   * without the neighborhood screen, as the dev page does). `gameW` x
   * `gameH` is the game's screen. Null when it could not be loaded.
   */
  lot(gameW: number, gameH: number): Promise<CasLot | null> {
    this.lotLoad ??= (CasLot.current(this.dir) ?? CasLot.unloadHouse(this.dir, gameW, gameH)).then((lot) => {
      // The neighbors AddNewCharacter made before (the simulator reads the file).
      for (const p of this.people) {
        const nb = this.neighbor(p);
        if (nb) lot?.setNeighbor(nb);
      }
      return lot;
    });
    return this.lotLoad;
  }

  /** The person's neighbor as the simulator's Neighborhood holds it (Neighborhood::AddNewNeighbor / SavePersistentData). */
  neighbor(p: CasPerson): Neighbor | null {
    return this.store.neighborData(p.guid);
  }

  get dir(): string {
    return this.store.dir;
  }

  /** MakeNewPerson */
  async makeNewPerson(): Promise<CasPerson> {
    const c = await this.store.addNewCharacter();
    // Neighborhood::AddNewCharacter: ObjectFolder::NewFileAdded (the instance needs its selector).
    await (await ObjectFolder.get(this.dir)).newFileAdded(`${this.dir}/Characters/${c.fileName}`, 1).catch((e: unknown) => console.warn("[cas] NewFileAdded", e));
    const chunks = await readCharacterFile(this.dir, c.fileName);
    const p: CasPerson = {
      guid: c.guid,
      fileName: c.fileName,
      firstName: "",
      bio: "",
      bodyStrings: bodyStringsOf(chunks),
      personData: new Int16Array(this.store.getPersonData(c.guid)),
      face: null,
      edit: null,
    };
    this.people.push(p);
    // AddNewNeighbor: the Neighborhood the simulator reads has it.
    const nb = this.neighbor(p);
    if (nb && this.lotLoad) (await this.lotLoad)?.setNeighbor(nb);
    return p;
  }

  /** PersonFinder::BeginDesignAPerson */
  async beginDesignAPerson(p: CasPerson): Promise<EditPerson> {
    p.edit = await EditPerson.begin(p.bodyStrings, p.personData);
    return p.edit;
  }

  /** The person as the 3D preview shows it (rebuilt after every suit change). */
  animator(p: CasPerson): Promise<SAnimator | null> {
    return SAnimator.fromBodyStrings(p.edit ? p.edit.bodyStrings() : p.bodyStrings);
  }

  /**
   * PersonFinder::SetName + SetDescription (cWinDesignCharacter's Done):
   * CatalogResource::Save of `p`'s name and biography into its character
   * file, ObjSelector::SetObjectName on the OBJD.
   */
  async setName(p: CasPerson): Promise<void> {
    await saveCharacterName(this.dir, p.fileName, p.firstName, p.bio);
    await this.fileChanged(p);
  }

  /**
   * PersonFinder::EndDesignAPerson(person, save, kill, saveNeighborhood).
   * `isNew` stands for cXPerson::Initialize's interest test (the port has
   * no instance for the townies). The design dialogs pass kill = true
   * (cWinDesignFamily's SetPerson(person, false)) and saveNeighborhood =
   * true; the townie makers kill = true, saveNeighborhood = false.
   */
  async endDesignAPerson(p: CasPerson, save: boolean, isNew: boolean, kill = true, saveNeighborhood = false): Promise<void> {
    const edit = p.edit;
    p.edit = null;
    if (!edit) return;
    edit.end(save);
    const lot = this.lotLoad ? await this.lotLoad : null;
    if (save) {
      p.bodyStrings = edit.bodyStrings();
      const pd = p.personData;
      // SAnimator::ResetSuits
      pd[PD.personAge] = Number.parseInt(p.bodyStrings[13] ?? "", 10) || 0;
      const g = GENDERS.indexOf((p.bodyStrings[12] ?? "").toLowerCase());
      if (g >= 0) pd[PD.gender] = g;
      pd[PD.skinColor] = SKIN_INDEX[(p.bodyStrings[14] ?? "").toLowerCase()] ?? 0;
      if (isNew && needsInterests(pd)) randomizeAllInterests(pd);
      // Neighborhood::SavePersistentData (into the simulator's Neighborhood too), then Neighborhood::Save.
      this.store.savePersistentData(p.guid, pd);
      const nb = this.neighbor(p);
      if (nb) lot?.setNeighbor(nb);
      if (saveNeighborhood) await this.store.save();
    }
    // ObjectModule::KillObject of the instance.
    if (kill) lot?.killInstance(p.guid);
    if (!save) return;
    // GenerateBitmaps(person, 0x1f, save), then EditPerson::End's BodyStrings::Save.
    const bitmaps = await generatePortraits(p.bodyStrings, this.res).catch((e: unknown) => {
      console.warn(`[cas] portraits of ${p.fileName}`, e);
      return new Map<number, Uint8Array>();
    });
    await saveCharacter(this.dir, p.fileName, { firstName: p.firstName, bio: p.bio, bodyStrings: p.bodyStrings, bitmaps });
    await this.fileChanged(p);
    const face = bitmaps.get(2002);
    if (face) {
      const img = decodeImage(face, "face.bmp", { colorKey: true });
      p.face = await createImageBitmap(new ImageData(img.data, img.width, img.height));
    }
  }

  /** The person's selector follows its file (ObjectFolder.fileChanged). */
  private async fileChanged(p: CasPerson): Promise<void> {
    (await ObjectFolder.loaded(this.dir)?.catch(() => null))?.fileChanged(`${this.dir}/Characters/${p.fileName}`);
  }

  /** DeletePerson */
  async deletePerson(p: CasPerson): Promise<void> {
    const i = this.people.indexOf(p);
    if (i >= 0) this.people.splice(i, 1);
    // Neighborhood::RemoveNeighbor
    if (await this.store.deleteCharacter(p.guid)) (this.lotLoad ? await this.lotLoad : null)?.removeNeighbor(p.guid);
  }
}
