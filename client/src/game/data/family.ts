/**
 * Builds the CPState view of a family from the neighborhood save: members,
 * person data, faces and relationships, plus the neighbors they know.
 * Motives are live simulation state (stored with the lot), left neutral here.
 */

import type { CPState, PersonInfo } from "../cpstate.js";
import { decodeImage } from "../res/bmp.js";
import {
  familyInHouse,
  loadCharacter,
  neighborByGuid,
  PD,
  type Family,
  type Neighbor,
  type NeighborhoodData,
} from "./neighborhood.js";

async function bitmap(bytes: Uint8Array | undefined): Promise<ImageBitmap | null> {
  if (!bytes) return null;
  const img = decodeImage(bytes, "face.bmp", { colorKey: true });
  return createImageBitmap(new ImageData(img.data, img.width, img.height));
}

export async function personFromNeighbor(n: NeighborhoodData, nb: Neighbor, lastName: string): Promise<PersonInfo> {
  const c = await loadCharacter(n.dir, nb.name).catch(() => null);
  const pd = nb.personData ?? new Int16Array(256);
  const age = pd[PD.personAge] ?? 0;
  return {
    id: nb.id,
    guid: nb.guid,
    firstName: c?.firstName ?? nb.name,
    lastName,
    motives: new Array<number>(16).fill(0),
    skills: [PD.cookingSkill, PD.mechanicalSkill, PD.charismaSkill, PD.bodySkill, PD.logicSkill, PD.creativitySkill].map(
      (k) => pd[k] ?? 0,
    ),
    personality: [2, 3, 4, 5, 6, 7].map((k) => pd[k] ?? 0),
    isChild: age !== 0 && age < 18,
    isFemale: pd[PD.gender] === 1,
    personData: pd,
    neighborId: nb.id,
    face: await bitmap(c?.bitmaps.get(2002)),
    relFace: await bitmap(c?.bitmaps.get(2003)),
    relationships: nb.relationships,
    bio: c?.bio ?? "",
  };
}

/** Make the family living in `houseNumber` the active family. */
export async function activateFamily(state: CPState, n: NeighborhoodData, houseNumber: number): Promise<Family | null> {
  const fam = familyInHouse(n, houseNumber);
  if (!fam) return null;
  state.familyName = fam.name;
  const members = fam.memberGuids.map((g) => neighborByGuid(n, g)).filter((x): x is Neighbor => !!x);
  state.family = await Promise.all(members.map((nb) => personFromNeighbor(n, nb, fam.name)));
  const known = new Set(members.flatMap((m) => m.relationships.map((r) => r.other)));
  state.neighbors = await Promise.all(n.neighbors.filter((x) => known.has(x.id)).map((nb) => personFromNeighbor(n, nb, "")));
  state.setFunds(fam.budget);
  return fam;
}
