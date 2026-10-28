/**
 * Object slots: SlotDescriptor (SLOT chunk records), SlotLoader::Load and the
 * ObjectSlot / SpriteSlot records cXObject::Initialize builds from them.
 *
 * cXObject +0x130 is a vector of ObjectSlot (0x24 bytes): slot 0 is created
 * empty by Initialize and links the next object on the same tile
 * (GetNextObjectSibling); slots 1.. come from the SLOT records of type 0 and
 * hold the objects placed in this one (drawn by DrawObjectSlot). The saved
 * game only stores each slot's contained object id (cXObject::ReconSlots).
 * cXObject +0x148 is the vector of SpriteSlot (0x3c bytes, SLOT type 1),
 * activated at run time by SimAntics only.
 */

import { ReconBuffer } from "./reconbuffer.js";

/** SlotDescriptor (SLOT record), fields named after their offset. */
export interface SlotDescriptor {
  /** +0: 0 = object slot, 1 = sprite slot, 3 = routing slot. */
  type: number;
  /** +4 / +8 / +0xc: offsets from the object (tiles). */
  x: number;
  y: number;
  z: number;
  /** +0x10 / +0x14 (version > 4). */
  f10: number;
  f14: number;
  /** +0x18: standard height (version > 7). */
  height: number;
  /** +0x1c..+0x24 (version >= 3). */
  f1c: number;
  f20: number;
  f24: number;
  /** +0x28: flags. */
  flags: number;
  f2c: number;
  f30: number;
  f34: number;
  f38: number;
  f3c: number;
  f40: number;
  f44: number;
}

/** SlotDescriptor::DoStream (read). Defaults are SlotDescriptor::SlotDescriptor's. */
function readSlotDescriptor(buf: ReconBuffer, v: number): SlotDescriptor {
  const d: SlotDescriptor = {
    type: -1,
    x: 0,
    y: 0,
    z: 0,
    f10: 0,
    f14: 0,
    height: 0,
    f1c: 0,
    f20: 0,
    f24: 0,
    flags: 0,
    f2c: -1,
    f30: 0x10,
    f34: 0x10,
    f38: 0x10,
    f3c: 0.1875,
    f40: -2,
    f44: 0x10,
  };
  if (v < 3) {
    d.x = buf.reconFloat();
    d.y = buf.reconFloat();
    d.z = v < 1 ? buf.recon16() : buf.reconFloat();
    d.type = buf.recon16();
    if (v > 1) buf.recon16();
    d.f1c = d.f20 = d.f24 = d.flags = 0;
  } else {
    d.type = buf.recon16();
    d.x = buf.reconFloat();
    d.y = buf.reconFloat();
    d.z = buf.reconFloat();
    d.f1c = buf.recon32();
    d.f20 = buf.recon32();
    d.f24 = buf.recon32();
    d.flags = buf.recon32();
    if (v > 3) d.f2c = buf.recon32();
    if (v > 4) {
      d.f30 = buf.recon32();
      d.f34 = buf.recon32();
      d.f38 = buf.recon32();
      d.f10 = buf.recon32();
      d.f14 = buf.recon32();
    }
    if (v > 6) d.f3c = buf.reconFloat();
  }
  if (v > 7) d.height = buf.recon32();
  if (v < 9) {
    if (d.flags & 0x200) {
      d.f40 = -3;
      d.flags &= ~0x200;
    } else if (d.flags & 0x400) {
      d.f40 = -1;
      d.flags &= ~0x400;
    }
  } else {
    d.f40 = buf.recon32();
  }
  if (v < 10) {
    d.f30 <<= 4;
    d.f34 <<= 4;
    d.f38 <<= 4;
    d.f3c *= 1 / 16;
  } else {
    d.f44 = buf.recon32();
  }
  return d;
}

/** ReconLoadVector<SlotDescriptor> on a SLOT chunk payload. */
export function readSlotChunk(payload: Uint8Array): SlotDescriptor[] {
  const { buf, version } = ReconBuffer.fromChunk(payload);
  const n = buf.recon32();
  const out: SlotDescriptor[] = [];
  for (let i = 0; i < n; i++) out.push(readSlotDescriptor(buf, version));
  return out;
}

/** ObjectSlot (0x24 bytes). */
export interface ObjectSlot {
  /** +0 / +4 / +8: position relative to the object (tiles; z in height units). */
  x: number;
  y: number;
  z: number;
  /** +0xc: SLOT record index + 1 (-1 for slot 0). */
  descriptor: number;
  /** +0x10: id of the object held in the slot (slot 0: next object on the tile). */
  containedId: number;
  /** +0x14: standard height (ObjectSlot::SetHeight). */
  height: number;
  /** +0x18 / +0x1c: SlotDescriptor +0x10 / +0x14. */
  f18: number;
  f1c: number;
}

/** ObjectSlot::ObjectSlot. */
export function emptyObjectSlot(): ObjectSlot {
  return { x: 0, y: 0, z: 0, descriptor: -1, containedId: 0, height: 0, f18: 0x32, f1c: 0 };
}

/** ObjectSlot::SetHeight: some standard heights force the slot's z (jump table lbl_105BBC4C). */
function setHeight(s: ObjectSlot, h: number): void {
  s.height = h;
  switch (h) {
    case 0:
      s.height = s.z === 0 ? 1 : 5;
      break;
    case 1:
      s.z = 0;
      break;
    case 2:
      s.z = 2.5;
      break;
    case 3:
    case 8:
      s.z = 4;
      break;
    case 4:
      s.z = 4.05;
      break;
    default:
      break;
  }
}

/**
 * SpriteSlot (0x3c bytes): a balloon / headline cXObject::TrySetBalloon
 * shows over the object (DrawSpriteSlot). The icon is a sprite of the
 * world renderer (GameData/Sprites.iff SPR#, `spriteId`, `count` frames)
 * or, with `spriteId` -1, an object / person picture (`selector`).
 */
export interface SpriteSlot {
  x: number;
  y: number;
  /** +8: height of the icon above the registration point (altitude units). */
  z: number;
  /** +0xc: SLOT record index + 1 (-1 for the person's own slot). */
  descriptor: number;
  /** +0x10: remaining ticks (-1: forever); DrawIso only draws slots where this is non-zero. */
  activeTicks: number;
  /** +0x14: SPR# id of the icon, -1 for a picture. */
  spriteId: number;
  /** +0x18 with spriteId -1: the master selector whose picture is shown (ObjSelector). */
  selector: unknown;
  /** +0x1c: animation frames; +0x20 current frame; +0x24 step (1, or -1 reversed). */
  count: number;
  frame: number;
  step: number;
  /** +0x28: ticks since the last frame change (the frame advances every 12). */
  subTick: number;
  /** +0x2c: balloon SPR# drawn under the icon (0: none); +0x30: overlay SPR# drawn over it (the "not" cross). */
  balloon: number;
  overlay: number;
  /** +0x34: priority of the current icon (2 for group 4, else 1). */
  priority: number;
  /** +0x38: drawn even when the person is not selected. */
  always: boolean;
}

/** SpriteSlot::SpriteSlot (then the SlotLoader / cXPerson::Initialize fields). */
export function newSpriteSlot(x: number, y: number, z: number, descriptor: number): SpriteSlot {
  return { x, y, z, descriptor, activeTicks: 0, spriteId: 0, selector: null, count: 0, frame: 0, step: 0, subTick: 0, balloon: 0, overlay: 0, priority: 0, always: false };
}

/**
 * SpriteSlot::Tick: counts an active slot down; every 12 ticks the frame
 * advances by the step (modulo the count). True when the frame changed.
 */
export function tickSpriteSlot(s: SpriteSlot): boolean {
  if (s.activeTicks > 0) s.activeTicks--;
  if (s.activeTicks === 0) return false;
  if (++s.subTick !== 12) return false;
  s.frame += s.step;
  while (s.frame < 0) s.frame += s.count;
  s.frame %= s.count;
  s.subTick = 0;
  return true;
}

/** SlotLoader::Load: object slots (type 0) and sprite slots (type 1); routing slots are skipped. */
export function loadSlots(descriptors: readonly SlotDescriptor[], objectSlots: ObjectSlot[], spriteSlots: SpriteSlot[]): void {
  descriptors.forEach((d, i) => {
    if (d.type === 0) {
      const s: ObjectSlot = { x: d.x, y: d.y, z: d.z, descriptor: -1, containedId: 0, height: 0, f18: d.f10, f1c: d.f14 };
      setHeight(s, d.height);
      s.descriptor = i + 1;
      objectSlots.push(s);
    } else if (d.type === 1) {
      spriteSlots.push(newSpriteSlot(d.x, d.y, d.z, i + 1));
    }
  });
}
