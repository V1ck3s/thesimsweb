/**
 * Builds the CPState view of a family from the neighborhood save: members,
 * person data, faces and relationships, plus the neighbors they know (the
 * faces through PersonFinder's selector, cas/personpictures.ts).
 * Motives are live simulation state (stored with the lot), left neutral here.
 */

import { neighborSelector, personBitmap } from "../cas/personpictures.js";
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
  // PersonFinder's selector of the person: the NPCs of GameData/Objects/People have no file in Characters/.
  const [c, sel] = await Promise.all([loadCharacter(n.dir, nb.name).catch(() => null), neighborSelector(n.dir, nb.guid)]);
  const pd = nb.personData ?? new Int16Array(256);
  const age = pd[PD.personAge] ?? 0;
  return {
    id: nb.id,
    guid: nb.guid,
    // PersonFinder::GetName: the selector's catalog name.
    firstName: c?.firstName ?? sel?.getCatalogName() ?? nb.name,
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
    // PersonFinder::GetPictureBuffer / GetRelPictureBuffer.
    face: await bitmap((sel ? await personBitmap(sel, 2002) : null) ?? c?.bitmaps.get(2002)),
    relFace: await bitmap((sel ? await personBitmap(sel, 2003) : null) ?? c?.bitmaps.get(2003)),
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

/**
 * Once the lot's simulation runs, the panels read the neighborhood it plays
 * on (SimModule.nbhd), not the copy activateFamily read: the relationships
 * a sim makes or changes during play (the RelMatrix arrays the simulation
 * writes) show at once in the relationships panel, as in the original where
 * both are the one Neighborhood. People met during play join
 * `state.neighbors` when the panel asks for them (knowNeighbors).
 */
export function shareSimulationNeighborhood(state: CPState, n: NeighborhoodData): void {
  const byId = new Map(n.neighbors.map((nb) => [nb.id, nb]));
  for (const p of [...state.family, ...state.neighbors]) {
    const nb = p.neighborId !== undefined ? byId.get(p.neighborId) : undefined;
    if (nb) p.relationships = nb.relationships;
  }
  const loading = new Set<number>();
  // (looked up at each call: the simulation adds neighbors during play, the townies it makes)
  state.knowNeighbors = async (ids) => {
    const known = new Set([...state.family, ...state.neighbors].map((p) => p.neighborId));
    const add = ids.filter((id) => !known.has(id) && !loading.has(id)).flatMap((id) => n.neighbors.find((nb) => nb.id === id) ?? []);
    if (!add.length) return false;
    for (const nb of add) loading.add(nb.id);
    const people = await Promise.all(add.map((nb) => personFromNeighbor(n, nb, "")));
    for (const nb of add) loading.delete(nb.id);
    let added = false;
    for (const p of people) {
      if (state.neighbors.some((q) => q.neighborId === p.neighborId)) continue;
      state.neighbors.push(p);
      added = true;
    }
    return added;
  };
}
