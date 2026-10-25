/**
 * The PersonFinder side of Create-a-Sim: the people being designed, by
 * handle, and the steps the design windows call.
 *
 *  - MakeNewPerson (cWinDesignCharacter::Init with no person):
 *    Neighborhood::AddNewCharacter copies People\TemplatePerson.iff to the
 *    first free Characters/User%05d.iff and adds its neighbor
 *    (data/nbhdstore.ts); the new person starts from the template's body
 *    strings and an empty person data;
 *  - BeginDesignAPerson: an EditPerson on the person's body strings;
 *  - EndDesignAPerson(save): the body-string side (EditPerson.end), then
 *    SAnimator::ResetSuits' person data (age PD[58] = atoi(body string 14),
 *    gender PD[65], skin PD[60] = index of the skin in PersonGlobals STR#
 *    8192), interests for a new person (cXPerson::Initialize), the portraits
 *    (GenerateBitmaps), and the character file (name, biography, body
 *    strings, BMP_s) and the neighbor's persistent data are written;
 *  - DeletePerson: the neighbor and the character file go.
 *
 * The neighborhood file itself is written when the family is finished
 * (cWinDesignFamily done / cancel).
 */

import { bodyStringsOf, needsInterests, randomizeAllInterests, readCharacterFile, saveCharacter } from "../data/character.js";
import type { NeighborhoodStore } from "../data/nbhdstore.js";
import { PD } from "../data/neighborhood.js";
import { decodeImage } from "../res/bmp.js";
import type { UIRes } from "../res/uires.js";
import { SAnimator } from "../sims/index.js";
import { EditPerson } from "./editperson.js";
import { generatePortraits } from "./portraits.js";

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

  constructor(
    readonly store: NeighborhoodStore,
    private readonly res?: UIRes,
  ) {}

  get dir(): string {
    return this.store.dir;
  }

  /** MakeNewPerson */
  async makeNewPerson(): Promise<CasPerson> {
    const c = await this.store.addNewCharacter();
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

  /** PersonFinder::EndDesignAPerson */
  async endDesignAPerson(p: CasPerson, save: boolean, isNew: boolean): Promise<void> {
    const edit = p.edit;
    p.edit = null;
    if (!edit) return;
    edit.end(save);
    if (!save) return;
    p.bodyStrings = edit.bodyStrings();
    const pd = p.personData;
    // SAnimator::ResetSuits
    pd[PD.personAge] = Number.parseInt(p.bodyStrings[13] ?? "", 10) || 0;
    pd[PD.gender] = (p.bodyStrings[12] ?? "").toLowerCase() === "female" ? 1 : 0;
    pd[PD.skinColor] = SKIN_INDEX[(p.bodyStrings[14] ?? "").toLowerCase()] ?? 0;
    if (isNew && needsInterests(pd)) randomizeAllInterests(pd);
    this.store.savePersistentData(p.guid, pd);
    const bitmaps = await generatePortraits(p.bodyStrings, this.res);
    await saveCharacter(this.dir, p.fileName, { firstName: p.firstName, bio: p.bio, bodyStrings: p.bodyStrings, bitmaps });
    const face = bitmaps.get(2002);
    if (face) {
      const img = decodeImage(face, "face.bmp", { colorKey: true });
      p.face = await createImageBitmap(new ImageData(img.data, img.width, img.height));
    }
  }

  /** DeletePerson */
  async deletePerson(p: CasPerson): Promise<void> {
    const i = this.people.indexOf(p);
    if (i >= 0) this.people.splice(i, 1);
    await this.store.deleteCharacter(p.guid);
  }
}
