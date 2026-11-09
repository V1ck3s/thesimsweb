/**
 * Dynamic multi-tile objects (cXMTObject with an entry point 8 tree,
 * cXMTObject::IsDynamic): the flood puddles (flood.iff, "dynamic update").
 * Each puddle is a multi-tile object of one part; puddles of the same
 * selector that touch merge into one chain, and every part's graphic follows
 * which of its eight neighbours belong to its chain.
 *
 *  - MergeInPlace (Mac 10099160): the objects of my selector on the four
 *    tiles beside me (directions 0, 2, 4, 6) merge with me (MergeDynamic),
 *    then, when I am in the world, every part of my chain updates its
 *    adjacency. Run after TryCreateObject places a dynamic object, after
 *    UserPlace and at the end of cXMTObject::Reset (with an entry 8 tree);
 *  - MergeDynamic (Mac 10099690): the other chain joins mine (its parts take
 *    my lead and its direction). The parts' offsets (+0x194..+0x1a4) are
 *    not ported;
 *  - UpdateDynAdjacency (Mac 10099310): bit i of the mask is set when one of
 *    the objects on the tile in direction (my direction + i) is part of my
 *    chain (IsPartOfMe); entry 8 runs as a check tree with the mask as
 *    parameter 0 (the int's high half on the big-endian Mac);
 *  - RemoveFromDynamic (Mac 100994f0): I leave the chain (RemoveFromChain;
 *    the next part leads the rest), then the rest and I update our
 *    adjacency. Run before TryFindGoodLocation's pickup (mode 1) and before
 *    the kill queue kills me (ObjectModule::PostSim); AddToKillQueue queues
 *    the part itself, not its lead.
 */

import { EP } from "./objfntable.js";
import { DIR_VEC, tileObjects } from "./routing.js";
import type { SimModule } from "./simmodule.js";
import type { SimObject } from "./xobject.js";

/** cXMTObject::IsDynamic: a multi-tile object (OBJD +0x14) with an entry point 8 tree. */
export function isDynamic(o: SimObject): boolean {
  return o.obj.selector.objd.masterId !== 0 && o.fnTable.getTreeID(EP.dynamicMultiTileUpdate) !== 0;
}

function leadOf(m: SimModule, o: SimObject): SimObject {
  return o.obj.mtLeadId !== 0 ? (m.getObject(o.obj.mtLeadId) ?? o) : o;
}

/** The chain of `o`: its lead, then the parts that name it. */
function chainOf(m: SimModule, o: SimObject): SimObject[] {
  const lead = leadOf(m, o);
  // The parts in creation (id) order, as the +0x18c chain.
  return [lead, ...m.list.filter((x) => x !== lead && x.obj.mtLeadId === lead.id).sort((a, b) => a.id - b.id)];
}

/** cXObject::IsInWorld (GetPlacementSpec): on a tile of the lot. */
function inWorld(o: SimObject): boolean {
  return o.obj.tileX >= 0 && o.obj.tileY >= 0 && o.obj.level >= 1;
}

/** cXMTObject::MergeDynamic(other): `other`'s chain joins the chain of `me`. */
function mergeDynamic(m: SimModule, me: SimObject, other: SimObject): void {
  const lead = leadOf(m, me);
  const otherLead = leadOf(m, other);
  if (lead === otherLead) return;
  const dir = lead.obj.objectData[1]!;
  for (const p of chainOf(m, otherLead)) {
    p.obj.mtLeadId = lead.id;
    p.obj.objectData[1] = dir;
    m.dirty(p);
  }
  if (lead.obj.mtLeadId === 0) lead.obj.mtLeadId = lead.id;
}

/** cXMTObject::IsPartOfMe(other) */
function isPartOfMe(m: SimModule, me: SimObject, other: SimObject): boolean {
  return chainOf(m, me).includes(other);
}

/** cXMTObject::UpdateDynAdjacency */
function updateDynAdjacency(m: SimModule, o: SimObject): void {
  if (!inWorld(o)) return;
  let mask = 0;
  for (let i = 0; i < 8; i++) {
    const [dx, dy] = DIR_VEC[(i + o.obj.dir) & 7]!;
    for (const x of tileObjects(m, o.obj.tileX + dx, o.obj.tileY + dy, o.obj.level)) {
      if (isPartOfMe(m, o, x)) mask |= 1 << i;
    }
  }
  const tree = o.fnTable.getTreeID(EP.dynamicMultiTileUpdate);
  if (tree !== 0) o.runCheckTree(o.behavior, 0, tree, { src: [mask, 0], at: 0 });
  m.dirty(o);
}

/** cXMTObject::MergeInPlace */
export function mergeInPlace(m: SimModule, o: SimObject): void {
  for (let d = 0; d < 8; d += 2) {
    const [dx, dy] = DIR_VEC[d]!;
    for (const x of [...tileObjects(m, o.obj.tileX + dx, o.obj.tileY + dy, o.obj.level)]) {
      if (x.obj.selector === o.obj.selector) mergeDynamic(m, x, o);
    }
  }
  if (!inWorld(o)) return;
  for (const p of chainOf(m, o)) updateDynAdjacency(m, p);
}

/** cXMTObject::RemoveFromDynamic */
export function removeFromDynamic(m: SimModule, o: SimObject): void {
  const chain = chainOf(m, o);
  const rest = chain.filter((x) => x !== o);
  // RemoveFromChain: the next part leads the others.
  const next = rest[0];
  for (const p of rest) p.obj.mtLeadId = next!.id;
  o.obj.mtLeadId = o.id;
  if (next && inWorld(next)) for (const p of rest) updateDynAdjacency(m, p);
  if (inWorld(o)) updateDynAdjacency(m, o);
}
