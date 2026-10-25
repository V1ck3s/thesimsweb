/**
 * Creating and destroying lot objects at run time: ObjectModule::AddObject,
 * ObjectModule::MakeNewOutOfWorldObject (+ ConstructObject, cXObject::JustBorn,
 * the currentValue / sim flag setup) and ObjectModule::KillObject.
 *
 * Shortcut until the SimAntics VM runs init trees: MakeNewOutOfWorldObject
 * calls Reset(1), which zeroes the object data and runs the object's init
 * tree; that tree sets the placement-relevant fields (placement flags,
 * allowed heights, rotation notches, wall placement flags, movement flags,
 * flags...). `hooks.runInitTree` is called when present; otherwise the data
 * is seeded from another instance of the same definition on the lot, or
 * from defaults (on floor or terrain, floor height, quarter-turn rotation,
 * players can move and delete it).
 */

import { OD, XObject, type ObjectKind } from "../objects.js";
import type { ObjectFolder } from "../objectfolder.js";
import { OBJ_TYPE_PERSON, OBJ_TYPE_PORTAL, type ObjSelector } from "../objselector.js";
import { ODX, PF, type Placement } from "./placement.js";

/** Simulation clock for cXObject::JustBorn (birth date fields); the simulation fills it. */
export interface BirthDate {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** Object data the init tree sets per instance state rather than per definition: not copied from a sibling. */
const INSTANCE_FIELDS = new Set<number>([
  OD.direction,
  OD.containerId,
  OD.slotNumber,
  ODX.wallAdjacency,
  11, // object id
  12, // target id
  OD.slotHierNumber,
  ODX.repairState,
  18, // sim age
  ODX.birthMinute,
  ODX.birthHour,
  25, // lockout count
  OD.parentId,
  29, // room
  35, // temperature
  39, // dirty level
  OD.currentValue,
  ODX.birthYear,
  ODX.birthMonth,
  ODX.birthDay,
  48, // age in months
  52, // primitive result
  54, // primitive result id
  ODX.useCount,
  OD.slotCount,
]);

/** ObjectModule::AddObject: the lowest free id. */
export function addObject(p: Placement, obj: XObject): number {
  let id = 1;
  while (p.module.objects.has(id)) id++;
  obj.objectId = id;
  p.module.objects.set(id, obj);
  obj.simFlags = 0xffff;
  return id;
}

/** ObjectModule::KillObject (every part of a multi-tile object; contained objects are left on the floor). */
export function killObject(p: Placement, obj: XObject): void {
  const parts = p.chain(obj);
  if (p.isInWorld(parts[0]!)) p.pickup(parts[0]!, true);
  for (const part of parts) {
    for (const s of part.objectSlots.slice(1)) s.containedId = 0;
    p.module.objects.delete(part.objectId);
    p.hooks.onKill?.(part);
  }
}

/** ObjectModule::ConstructObject: the class follows the OBJD type and master id. */
function kindOf(sel: ObjSelector): ObjectKind | null {
  const { masterId, objectType } = sel.objd;
  if (masterId !== 0) return objectType === OBJ_TYPE_PORTAL ? "portal" : "multiTile";
  if (objectType === OBJ_TYPE_PERSON) return "person";
  if (objectType === 8 || objectType === 9) return null;
  return "object";
}

/** cXObject::JustBorn. */
function justBorn(obj: XObject, d: BirthDate | null): void {
  if (!d) return;
  obj.objectData[ODX.birthYear] = d.year;
  obj.objectData[ODX.birthMonth] = d.month;
  obj.objectData[ODX.birthDay] = d.day;
  obj.objectData[ODX.birthHour] = d.hour;
  obj.objectData[ODX.birthMinute] = d.minute;
}

/** The init tree's results: from the VM, else a sibling instance, else defaults (see the file comment). */
function seedObjectData(p: Placement, obj: XObject): void {
  if (p.hooks.runInitTree?.(obj)) return;
  const twin = [...p.module.objects.values()].find((o) => o !== obj && o.selector === obj.selector && !o.isPlaceholder);
  if (twin) {
    for (let i = 0; i < obj.objectData.length; i++) {
      if (!INSTANCE_FIELDS.has(i)) obj.objectData[i] = twin.objectData[i]!;
    }
    obj.objectData[OD.flags] = obj.objectData[OD.flags]! & ~(0x20 | 0x100 | 0x200);
    obj.objectData[OD.hidden] = 0;
    if (twin.spriteVisibility.length === obj.spriteVisibility.length) obj.spriteVisibility.set(twin.spriteVisibility);
    return;
  }
  obj.objectData[OD.allowedHeightFlags] = 1;
  obj.objectData[OD.placementFlags] = PF.onFloor | PF.onTerrain;
  obj.objectData[ODX.rotationNotches] = 2;
  obj.objectData[OD.movementFlags] = 0x0a;
}

/**
 * ObjectModule::MakeNewOutOfWorldObject(selector): a new object (every part
 * of a multi-tile one, lead first) out of the world. Returns the lead.
 */
export function makeNewOutOfWorldObject(p: Placement, folder: ObjectFolder, sel: ObjSelector, birth: BirthDate | null = null): XObject | null {
  const objd = sel.objd;
  const made: XObject[] = [];
  const build = (s: ObjSelector, head: XObject | null): XObject | null => {
    const kind = kindOf(s);
    if (!kind) return null;
    const o = new XObject(s, kind, false, null);
    addObject(p, o);
    o.initialize();
    if (head) o.mtLeadId = head.objectId;
    justBorn(o, birth);
    made.push(o);
    return o;
  };
  let head: XObject | null;
  if (objd.masterId === 0) {
    head = build(sel, null);
  } else {
    if (objd.subIndex !== -1) return null;
    const lead = folder.getLeadSelector(sel);
    if (!lead) return null;
    head = build(lead, null);
    for (let i = 0; head; i++) {
      const s = folder.getNthSubSelector(sel, i);
      if (!s) break;
      if (s !== head.selector && !build(s, head)) head = null;
    }
    if (!head) {
      for (const o of made) p.module.objects.delete(o.objectId);
      return null;
    }
  }
  if (!head) return null;
  for (const o of made) {
    seedObjectData(p, o);
    o.objFlags = (o.objFlags & ~0x80) | 0x80;
    o.simFlags = (o.simFlags & ~0x10000) | 0x10000;
  }
  // Reset keeps the direction; the value is the master's price.
  head.objectData[OD.currentValue] = objd.i16(0x24);
  p.assignOffsets(head);
  return head;
}
