/**
 * Lot objects: ObjectModule::Load / DoStream (chunk "ObjM" 1 of a house file)
 * and the cXObject / cXMTObject / cXPortal / cXPerson record streams, as
 * called from House::LoadFile, followed by ObjectModule::CheckIntegrity and
 * the parts of cXObject::PostLoad that touch saved fields.
 *
 * ObjM layout (version > 0x2e): a compression flag, then the object headers
 * (object id, saved type index into "objt") up to a 0 id, a mark, then one
 * record per object in header order, each ended by a mark (ReadToNextMark
 * skips what a class does not read). Objects are kept in that order (the
 * module list, +0x30 / cXObject +0xe0).
 *
 * cXObject fields filled here (byte offsets of the original):
 *   +0x2c / +0x30  attributes            +0x34 / +0x38  dynamic sprite flags
 *   +0x3a          temps[8]              +0x4a          object data[0x48]
 *                  (Behavior.iff STR# 141 "Data labels", index = (offset - 0x4a) / 2)
 *   +0x4a graphic  +0x4c direction  +0x4e container id  +0x50 slot number
 *   +0x5a flags    +0x64 wall placement flags  +0x66 slot hier number
 *   +0x7e parent id  +0x8e hidden  +0xb0 lighting contribution  +0xd0 slot count
 *   +0xf0 object id  +0xf4 / +0xf8 FTilePt (y, x) in 1/16 tile, world coordinates
 *   +0xfc / +0xfd / +0xfe CTilePt (x, y, level)  +0x100..+0x10c footprint rect
 *   +0x110 level   +0x114 object flags   +0x118 OBJD   +0x11c ObjSelector
 *   +0x130 ObjectSlots (slot 0: next object on the tile)  +0x148 SpriteSlots
 *   +0x15c render layer (1 = dynamic)    +0x184 shadow id
 * cXMTObject: +0x18c next part, +0x190 lead part, +0x194 / +0x198 multi-tile
 * offsets, +0x19c level offset, +0x1a0..+0x1a8. cXPortal: +0x1ac floats.
 */

import { type PersonRecord, readPersonStream } from "./personstream.js";
import { ObjectFolder, GUID_CAT_PLACEHOLDER, GUID_DOG_PLACEHOLDER, GUID_PERSON_PLACEHOLDER, type MissingObject, type SaveTypeTable } from "./objectfolder.js";
import { OBJ_TYPE_PERSON, OBJ_TYPE_PORTAL, type ObjSelector } from "./objselector.js";
import { ReconBuffer } from "./reconbuffer.js";
import { emptyObjectSlot, type ObjectSlot, type SpriteSlot } from "./slots.js";
import type { ResFile } from "./iffres.js";

/** Object data indices (STR# 141). */
export const OD = {
  graphic: 0,
  direction: 1,
  containerId: 2,
  slotNumber: 3,
  allowedHeightFlags: 4,
  flags: 8,
  routePreference: 9,
  routePenalty: 10,
  wallPlacementFlags: 13,
  slotHierNumber: 14,
  lightSource: 16,
  walkStyle: 17,
  parentId: 26,
  hidden: 34,
  currentValue: 41,
  placementFlags: 42,
  movementFlags: 43,
  lightingContribution: 51,
  slotCount: 67,
} as const;

/** Object data "flags" (index 8, STR# 142) bit 10: hidden by the wall cutaway. */
export const FLAG_HIDE_FOR_CUTAWAY = 0x400;
/** OBJD +0xca render flags bit 0: never moved to the static render layer. */
const RENDER_ALWAYS_DYNAMIC = 1;

export type ObjectKind = "object" | "multiTile" | "portal" | "person";

/** What the lot renderer needs from a cXObject, filled from the save. */
export interface PlacedObject {
  /** +0xf0: the id stored in the "objects" Arry (3 / 103). */
  objectId: number;
  guid: number;
  /** +0x11c (its OBJD is +0x118). */
  selector: ObjSelector;
  /** Class ConstructObject chose: cXObject, cXMTObject, cXPortal or cXPerson. */
  kind: ObjectKind;
  isPerson: boolean;
  /** The saved type was not installed: the object uses a placeholder definition. */
  isPlaceholder: boolean;
  /** The saved type's record when `isPlaceholder`. */
  missing: MissingObject | null;
  /** +0xf8 / +0xf4: fixed-point world position (1/16 tile), unrotated. */
  fx: number;
  fy: number;
  /** +0xfc / +0xfd: tile (signed char of fx >> 4, fy >> 4; -1 = out of the world). */
  tileX: number;
  tileY: number;
  /** +0x110 (1 = ground floor). */
  level: number;
  /** +0x4c (0..7, even values on the grid). */
  dir: number;
  /** +0x4a: index of the draw group (DGRP base graphic + graphic). */
  graphic: number;
  /** +0x4e */
  containerId: number;
  /** +0x50 */
  slotNumber: number;
  /** +0x5a: STR# 142 flags (0x400 = hide for cutaway, 4 = zero extent). */
  flags: number;
  /** +0x64: wall placement flags (cXObject::GetRequiredSegment). */
  wallPlacementFlags: number;
  /** +0x66 */
  slotHierNumber: number;
  /** +0x7e: the object holding this one. */
  parentId: number;
  /** +0x8e: non-zero skips the draw group (DrawIso) and the tile shadow. */
  hidden: number;
  /** +0xb0: non-zero draws at full ambient light (except portals). */
  lightingContribution: number;
  /** +0x4a..+0xd8: all 0x48 object data fields. */
  objectData: Int16Array;
  /** +0x2c / +0x30 */
  attributes: Int16Array;
  /** +0x3a */
  temps: Int16Array;
  /** +0x114: 1 = selected look, 8 / 0x10 = draw modes read by DrawIso, 0x80 = loaded, 0x200 = new. */
  objFlags: number;
  /** +0x100, +0x104, +0x108, +0x10c: footprint rect (ComputeRect), fixed point. */
  rect: [number, number, number, number];
  /**
   * +0x34 / +0x38: one flag per dynamic sprite, sprite id - OBJD +0x80
   * (`selector.objd.dynamicSpritesBaseId`); DrawIso skips items whose flag is 0.
   */
  spriteVisibility: Int16Array;
  /** +0x130: slot 0 links the next object on the tile, slots 1.. hold contained objects. */
  objectSlots: ObjectSlot[];
  /** +0x148: drawn only while active (run time). */
  spriteSlots: SpriteSlot[];
  /** GetNextObjectSibling: objectSlots[0].containedId (0 = none). */
  nextSiblingId: number;
  /** +0x15c == 0. Objects load on the dynamic layer (+0x15c = 1). */
  isStatic: boolean;
  /**
   * HouseViewer::RenderDynamicObjects moves the object to the static layer
   * (SetRenderLayer 0, which also moves its contents) once it has been idle
   * for GetDynamicToStaticLatency: visible, with graphics, not held, OBJD
   * render flag 1 clear on it and on its contents.
   */
  staticWhenIdle: boolean;
  /** GetPlacementSpec's container: the object this one is held by (0 = on the floor). */
  placementContainerId: number;
  /** +0x184: ObjSelector::GetShadowID (-1 = none). */
  shadowId: number;
  /** cXMTObject +0x190: lead part's object id (0 = none / not multi-tile). */
  mtLeadId: number;
  /** cXMTObject +0x194 / +0x198 / +0x19c. */
  mtOffsetX: number;
  mtOffsetY: number;
  mtLevelOffset: number;
  /** cXPortal +0x1ac. */
  portalValues: number[];
  /** ObjectModule +0x2c entry of this object (sim flags), saved after the record. */
  simFlags: number;
  /** cXObject::ReconStream found more dynamic sprites than the definition: ObjectModule::AddToKillQueue. */
  killQueued: boolean;
}

/** An object of the lot (cXObject and its subclasses). */
export class XObject implements PlacedObject {
  objectId: number;
  readonly guid: number;
  readonly isPerson: boolean;
  fx = 0;
  fy = 0;
  level = 0;
  /** +0x3a temps then +0x4a object data, contiguous like the original (old streams overrun). */
  private readonly locals = new Int16Array(8 + 0x48);
  readonly temps = this.locals.subarray(0, 8);
  readonly objectData = this.locals.subarray(8);
  attributes: Int16Array;
  objFlags = 0x200;
  rect: [number, number, number, number] = [0, 0, 0, 0];
  spriteVisibility: Int16Array;
  objectSlots: ObjectSlot[] = [];
  spriteSlots: SpriteSlot[] = [];
  isStatic = false;
  staticWhenIdle = false;
  placementContainerId = 0;
  shadowId = -1;
  mtLeadId = 0;
  mtOffsetX = 0;
  mtOffsetY = 0;
  mtLevelOffset = 0;
  mt1a0 = 0;
  mt1a4 = 0;
  mt1a8 = 0;
  portalValues: number[] = [];
  simFlags = 0xffff;
  /**
   * ObjectSaveTypeTable: the init / main cumulative tree versions saved with
   * this object's type (null: none saved). cXObject::PostLoad compares them
   * with the installed trees (ObjSelector +0xb4 bit 1).
   */
  savedTreeVersions: { init: number; main: number } | null = null;
  /** TreeStack::ReconStream: the saved interpreter stack (null when not saved). */
  savedStack: SavedTreeStack | null = null;
  /** +0xe4 RelMatrix: other object id -> relationship values (RelInt). */
  readonly relations = new Map<number, number[]>();
  /** cXPerson record (motives, person data, animator state); null for objects or when it failed to parse. */
  personRecord: PersonRecord | null = null;
  killQueued = false;

  /** cXObject::cXObject (+ cXMTObject / cXPortal / cXPerson constructors). */
  constructor(
    readonly selector: ObjSelector,
    readonly kind: ObjectKind,
    readonly isPlaceholder: boolean,
    readonly missing: MissingObject | null,
  ) {
    this.objectId = 0;
    this.guid = selector.guid;
    this.isPerson = kind === "person";
    this.attributes = new Int16Array(Math.max(selector.objd.numAttributes, 8));
    this.spriteVisibility = new Int16Array(0);
  }

  get tileX(): number {
    return ((this.fx >> 4) << 24) >> 24;
  }
  get tileY(): number {
    return ((this.fy >> 4) << 24) >> 24;
  }
  get graphic(): number {
    return this.objectData[OD.graphic]!;
  }
  get dir(): number {
    return this.objectData[OD.direction]!;
  }
  get containerId(): number {
    return this.objectData[OD.containerId]!;
  }
  get slotNumber(): number {
    return this.objectData[OD.slotNumber]!;
  }
  get flags(): number {
    return this.objectData[OD.flags]! & 0xffff;
  }
  get wallPlacementFlags(): number {
    return this.objectData[OD.wallPlacementFlags]! & 0xffff;
  }
  get slotHierNumber(): number {
    return this.objectData[OD.slotHierNumber]!;
  }
  get parentId(): number {
    return this.objectData[OD.parentId]!;
  }
  get hidden(): number {
    return this.objectData[OD.hidden]!;
  }
  get lightingContribution(): number {
    return this.objectData[OD.lightingContribution]!;
  }
  get nextSiblingId(): number {
    return this.objectSlots[0]?.containedId ?? 0;
  }

  /** cXObject::Initialize (+ cXMTObject::Initialize). */
  initialize(): void {
    const objd = this.selector.objd;
    const { objectSlots, spriteSlots } = this.selector.loadSlots();
    this.objectSlots = [emptyObjectSlot(), ...objectSlots];
    this.spriteSlots = spriteSlots;
    if (this.kind === "person") {
      // cXPerson::Initialize: five more object slots (height 6; flag 2; height 1 x3).
      const mk = (height: number, f1c: number): ObjectSlot => ({ ...emptyObjectSlot(), height, f1c });
      this.objectSlots.push(mk(6, 0), mk(0, 2), mk(1, 0), mk(1, 0), mk(1, 0));
    }
    this.objectData[OD.slotHierNumber] = -1;
    this.objectData[OD.slotNumber] = -1;
    this.objectData[OD.slotCount] = this.objectSlots.length - 1;
    // SetLocation(FTilePt(-16, -16), level 1): out of the world.
    this.fx = -16;
    this.fy = -16;
    this.level = 1;
    this.spriteVisibility = new Int16Array(Math.max(0, objd.numDynamicSprites));
    this.shadowId = this.selector.getShadowID();
    if (this.kind === "multiTile" || this.kind === "portal") {
      [this.mtOffsetX, this.mtOffsetY] = objd.multiTileOffsets();
      this.mtLevelOffset = objd.levelOffset;
    }
  }

  /** cXObject::ReconHeader. */
  private reconHeader(buf: ReconBuffer, v: number): void {
    const r108 = buf.recon32();
    const r10c = buf.recon32();
    const r100 = buf.recon32();
    const r104 = buf.recon32();
    this.rect = [r100, r104, r108, r10c];
    this.fx = buf.recon32();
    this.fy = buf.recon32();
    if (v > 0x18) this.level = buf.recon32();
    if (v < 0x2f) this.objectId = buf.recon16();
    buf.recon16();
    if (v === 0x37) this.objFlags = buf.recon32();
  }

  /** Read `n` shorts into the +0x3a / +0x4a region starting at local index `at`. */
  private readLocals(buf: ReconBuffer, at: number, n: number): void {
    for (let i = 0; i < n; i++) {
      const v = buf.recon16();
      if (at + i < this.locals.length) this.locals[at + i] = v;
    }
  }

  private readAttributes(buf: ReconBuffer, n: number): void {
    if (n > this.attributes.length) this.attributes = new Int16Array(n);
    for (let i = 0; i < n; i++) this.attributes[i] = buf.recon16();
  }

  /** cXObject::ReconStream (read). */
  reconStream(buf: ReconBuffer, v: number, placeholder: boolean): void {
    this.reconHeader(buf, v);
    if (v < 1) {
      this.readAttributes(buf, 8);
      this.readLocals(buf, 0, 0x20);
      this.readLocals(buf, 8, 0x20);
    } else if (v < 0xb) {
      this.readAttributes(buf, 8);
      this.readLocals(buf, 0, 8);
      this.readLocals(buf, 8, 0x24);
    }
    if (v > 10) {
      this.readAttributes(buf, v < 0x18 ? 8 : buf.recon16());
      this.readLocals(buf, 0, 8);
      this.readLocals(buf, 8, 0x48);
    }
    buf.recon16();
    this.savedStack = skipTreeStack(buf, v);
    if (v > 4) skipRelMatrix(buf, v < 7 ? 0 : v, this.relations);
    if (v < 0xd) {
      this.objectData[OD.routePreference] = 0;
      this.objectData[OD.routePenalty] = 0;
    }
    if (v < 0x22) {
      this.objectData[OD.lightSource] = 0;
      this.objectData[OD.walkStyle] = 0;
    }
    this.reconSlots(buf, v);
    if (v < 0x34) this.objectData[OD.slotCount] = this.objectSlots.length - 1;
    if (v > 0x1a) {
      const n = buf.recon16();
      if (n > this.spriteVisibility.length) {
        if (!placeholder) this.killQueued = true;
        this.spriteVisibility = new Int16Array(n);
      }
      for (let i = 0; i < n; i++) this.spriteVisibility[i] = buf.recon16();
    }
    if (placeholder) this.objectData[OD.direction] = 0;
  }

  /** cXObject::ReconSlots: the contained object id of each slot. */
  private reconSlots(buf: ReconBuffer, v: number): void {
    if (v <= 4) return;
    const n = buf.recon16();
    for (let i = 0; i < n; i++) {
      while (this.objectSlots.length <= i) this.objectSlots.push(emptyObjectSlot());
      buf.recon16();
      this.objectSlots[i]!.containedId = buf.recon16();
    }
  }

  /** cXMTObject::ReconStream / cXPortal::ReconStream after the cXObject part. */
  reconSubclass(buf: ReconBuffer, v: number): void {
    if (this.kind !== "multiTile" && this.kind !== "portal") return;
    this.mt1a0 = buf.recon32();
    this.mt1a4 = buf.recon32();
    if (v > 0x39) this.mt1a8 = buf.recon32();
    if (v > 0x27) {
      this.mtOffsetX = buf.recon32();
      this.mtOffsetY = buf.recon32();
      this.mtLevelOffset = buf.recon32();
    }
    this.mtLeadId = buf.recon16();
    if (this.kind === "portal" && v > 0xe) {
      const n = buf.recon32();
      this.portalValues = [];
      for (let i = 0; i < n; i++) {
        if (v < 0x26) buf.recon32();
        else this.portalValues.push(buf.reconFloat());
      }
    }
  }

  /** The parts of cXObject::PostLoad that change saved fields (the rest runs SimAntics trees). */
  postLoad(v: number, module: ObjectModule): void {
    if (this.level === 0) this.level = 1;
    const d = this.objectData;
    if (v < 0x20) {
      let u = d[OD.placementFlags]! & 0xffff;
      if (!(u & 1)) u = u & 2 ? u & 0xfffe : u | 3;
      else u &= 0xfffd;
      if (u & 0x80) u &= 0xff7e;
      d[OD.placementFlags] = u;
      d[OD.movementFlags] = d[OD.movementFlags]! | 10;
    }
    if (v < 0x21) {
      const lead = this.mtLeadId !== 0 ? module.objects.get(this.mtLeadId) ?? this : this;
      if (this.selector.objd.masterId === 0 || lead === this) {
        const master = this.selector.getMasterSelector();
        if (master && d[OD.currentValue]! < master.objd.i16(0x4c)) d[OD.currentValue] = master.objd.i16(0x24);
      }
    }
    if (v < 0x23) d[OD.allowedHeightFlags] = 1;
  }
}

/** One saved TreeStack frame (sim/treestack.ts restores it). */
export interface SavedFrame {
  treeId: number;
  node: number;
  /** StackElem +4 (0 before version 0x1a). */
  stackObj: number;
  params: Int16Array;
  locals: Int16Array;
  /** StackElem +8 */
  state: number;
  /** ObjectFolder::ReconBehavior's saved type index (version >= 0x2f), resolved by ObjectModule::DoStream. */
  typeIndex: number;
  /** The selector whose Behavior the frame runs (null: none / not installed). */
  selector: ObjSelector | null;
}

/** A saved TreeStack: the frame memory size (bytes) and the frames. */
export interface SavedTreeStack {
  memBytes: number;
  frames: SavedFrame[];
}

/** TreeStack::ReconStream (read). Versions 0x0b..0x18 are skipped (null). */
function skipTreeStack(buf: ReconBuffer, v: number): SavedTreeStack | null {
  if (v <= 10) return null;
  const behavior = (): number => {
    // ObjectFolder::ReconBehavior: a GUID before 0x2f, then a saved type index.
    if (v < 0x2f) return buf.recon32();
    return buf.recon16();
  };
  if (v < 0x19) {
    const n = buf.recon16();
    for (let i = 0; i < n; i++) {
      buf.recon16();
      buf.recon16();
      buf.recon16();
      buf.recon32();
      buf.recon16();
      buf.recon16s(4);
      behavior();
    }
    return null;
  }
  const n = buf.recon32();
  const memBytes = buf.recon32();
  const frames: SavedFrame[] = [];
  for (let i = 0; i < n; i++) {
    const stackObj = v > 0x19 ? buf.recon16() : 0;
    const treeId = buf.recon16() & 0xffff;
    const node = buf.recon16();
    // +6 local count, +7 parameter count; the parameters (+0x10) come first.
    const nLocals = buf.recon8() & 0xff;
    const nParams = buf.recon8() & 0xff;
    const params = buf.recon16s(nParams);
    const locals = buf.recon16s(nLocals);
    const state = buf.recon32();
    const typeIndex = behavior();
    frames.push({ treeId, node, stackObj, params, locals, state, typeIndex, selector: null });
  }
  return { memBytes, frames };
}

/** RelMatrix::DoStream (read); the arrays go into `out` when given (key = RelArray +0xc, else the index). */
function skipRelMatrix(buf: ReconBuffer, v: number, out?: Map<number, number[]>): void {
  const relArray = (index: number): void => {
    const key = v > 0 ? buf.recon32() : index;
    const n = buf.recon32();
    const values: number[] = [];
    for (let i = 0; i < n; i++) values.push(buf.recon32());
    out?.set(key, values);
  };
  const count = buf.recon32();
  if (count < 0) {
    const n = buf.recon32();
    for (let i = 0; i < n; i++) if (buf.recon32() !== 0) relArray(i);
  } else {
    for (let i = 0; i < count; i++) relArray(i);
  }
}

/** Tile object array of cFixedWorld (c2DArray<short>, [x][y]). */
export interface TileObjectArray {
  data: Uint8Array;
  offset(x: number, y: number): number;
}

/** The part of cFixedWorld ObjectModule::CheckIntegrity uses. */
export interface IntegrityWorld {
  /** +0x10 lot size. */
  size: number;
  /** +0x3c / +0x40: tile object ids per level. */
  objects: TileObjectArray[];
}

export class ObjectModule {
  /** ObjM stream version. */
  version = 0;
  /** +0x18 / +0x20 by id, in module list order (+0x30 / +0xe0). */
  readonly objects = new Map<number, XObject>();
  /** +0xac: selected person. */
  selectedPersonId = 0;
  /** +0x38 object vector and the string ObjM ends with (v > 0x33), kept for saving. */
  trailerIds: number[] = [];
  trailerString = "";
  /** Object ids in the order the stream listed them (the module list at load). */
  loadOrder: number[] = [];

  /** ObjectModule::Load: ObjectFolder::PrepareForModuleLoad, then the "ObjM" chunk. */
  static async load(house: ResFile, folder: ObjectFolder): Promise<ObjectModule> {
    const m = new ObjectModule();
    const payload = house.get("ObjM", 1);
    if (!payload) return m;
    const table = await folder.prepareForModuleLoad(house);
    const placeholders = await folder.getPlaceholders();
    const { buf, version } = ReconBuffer.fromChunk(payload);
    m.version = version;
    // Older saves keep one "Rcon" chunk per object (ObjectModule::LoadAllObjects).
    if (version < 0x2f) throw new Error(`ObjM version ${version}: per-object Rcon saves are not supported`);
    m.doStream(buf, version, table, placeholders);
    return m;
  }

  /** ObjectModule::DoStream (read, version > 0x2e). */
  private doStream(
    buf: ReconBuffer,
    v: number,
    table: SaveTypeTable,
    ph: { standard: ObjSelector | null; person: ObjSelector | null; dog: ObjSelector | null; cat: ObjSelector | null },
  ): void {
    if (buf.reconBool()) buf.enableCompression();
    const placeholderSet = new Set([ph.standard, ph.person, ph.dog, ph.cat].filter((s): s is ObjSelector => s !== null));
    for (let id = buf.recon16(); id !== 0; id = buf.recon16()) {
      // ObjectFolder::ReconSelector (version >= 0x2f): a saved type index.
      const index = buf.recon16();
      const missing = table.missing.get(index) ?? null;
      let sel = table.selectors.get(index) ?? null;
      if (!sel) sel = this.placeholderFor(missing, ph);
      if (!sel) continue;
      const obj = constructObject(sel, placeholderSet.has(sel), missing);
      if (!obj || this.objects.has(id) || id < 1) continue;
      obj.objectId = id;
      obj.savedTreeVersions = table.treeVersions.get(index) ?? null;
      this.objects.set(id, obj);
      obj.initialize();
      obj.objFlags |= 0x80;
    }
    buf.reconMark();
    this.loadOrder = [...this.objects.keys()];
    for (const obj of this.objects.values()) {
      const placeholder = placeholderSet.has(obj.selector);
      obj.reconStream(buf, v, placeholder);
      // ObjectFolder::ReconBehavior: saved type index -> the installed selector (none when missing).
      for (const f of obj.savedStack?.frames ?? []) f.selector = table.selectors.get(f.typeIndex) ?? null;
      if (!obj.isPerson) {
        obj.reconSubclass(buf, v);
        if (v > 0x35) {
          if (!placeholder) obj.simFlags = buf.recon32();
          else obj.simFlags |= 0x10000;
          if (v < 0x39) obj.simFlags = (obj.simFlags & 0xffff) | 0x10000;
        }
      }
      // cXPerson::ReconStream continues after the cXObject part: read up to the person data, the mark skips the rest.
      if (obj.isPerson) {
        try {
          obj.personRecord = readPersonStream(buf, v);
          // Past a parsed tail the sim flags follow, as for other objects.
          if (obj.personRecord.tail && v > 0x35 && !placeholder) obj.simFlags = buf.recon32();
        } catch {
          obj.personRecord = null;
        }
      }
      buf.readToNextMark();
      buf.reconMark();
    }
    this.selectedPersonId = buf.recon16();
    if (v > 0x33) {
      try {
        const n = buf.recon32();
        const ids: number[] = [];
        for (let i = 0; i < n && i < 0x10000; i++) ids.push(buf.recon16());
        this.trailerIds = ids;
        this.trailerString = buf.reconString();
      } catch {
        this.trailerIds = [];
      }
    }
  }

  /** The placeholder ObjectModule::DoStream substitutes for a missing type. */
  private placeholderFor(
    missing: MissingObject | null,
    ph: { standard: ObjSelector | null; person: ObjSelector | null; dog: ObjSelector | null; cat: ObjSelector | null },
  ): ObjSelector | null {
    if (!missing || missing.objectType !== OBJ_TYPE_PERSON) return ph.standard;
    if (missing.originalGuid === GUID_PERSON_PLACEHOLDER) return ph.person;
    if (missing.originalGuid === GUID_DOG_PLACEHOLDER) return ph.dog;
    if (missing.originalGuid === GUID_CAT_PLACEHOLDER) return ph.cat;
    return ph.person;
  }

  /**
   * ObjectModule::CheckIntegrity: clears level-1 tile entries naming no object
   * or an object that is not on that tile of level 1 (stale ids left in saves).
   */
  checkIntegrity(world: IntegrityWorld): void {
    const tiles = world.objects[0];
    if (!tiles) return;
    for (let x = 0; x < world.size; x++) {
      for (let y = 0; y < world.size; y++) {
        const o = tiles.offset(x, y);
        const id = ((tiles.data[o]! | (tiles.data[o + 1]! << 8)) << 16) >> 16;
        if (id === 0) continue;
        const obj = this.objects.get(id);
        if (obj && obj.tileX === x && obj.tileY === y && obj.level === 1) continue;
        tiles.data[o] = 0;
        tiles.data[o + 1] = 0;
      }
    }
  }

  /** ObjectModule::PostLoad (saved-field fix-ups), then the render-layer state. */
  postLoad(): void {
    for (const obj of this.objects.values()) obj.postLoad(this.version, this);
    for (const obj of this.objects.values()) obj.placementContainerId = this.placementContainer(obj);
    for (const obj of this.objects.values()) {
      const root = obj.placementContainerId !== 0 ? this.objects.get(obj.placementContainerId) : undefined;
      obj.staticWhenIdle = this.settlesStatic(root ?? obj);
    }
  }

  /** cXObject::GetPlacementSpec's container: the parent of the top of the slot hierarchy. */
  private placementContainer(obj: XObject): number {
    let top = obj;
    for (let guard = 0; guard < 64 && top.slotHierNumber === 0; guard++) {
      const parent = this.objects.get(top.parentId);
      if (!parent) break;
      top = parent;
    }
    return this.objects.has(top.parentId) ? top.parentId : 0;
  }

  /**
   * The RenderDynamicObjects conditions for SetRenderLayer(static), plus a
   * finite GetDynamicToStaticLatency (people, and objects holding one, never
   * settle: cXPerson's latency is 0x7fffffff).
   */
  private settlesStatic(obj: XObject): boolean {
    if (obj.hidden !== 0 || !obj.selector.getHasGraphics() || obj.placementContainerId !== 0) return false;
    if (obj.selector.objd.renderFlags & RENDER_ALWAYS_DYNAMIC) return false;
    for (const slot of obj.objectSlots.slice(1)) {
      const held = this.objects.get(slot.containedId);
      if (held && held.selector.objd.renderFlags & RENDER_ALWAYS_DYNAMIC) return false;
    }
    return !this.neverSettles(obj, 0);
  }

  private neverSettles(obj: XObject, depth: number): boolean {
    if (obj.isPerson) return true;
    if (depth > 16) return false;
    return obj.objectSlots.slice(1).some((s) => {
      const held = this.objects.get(s.containedId);
      return held !== undefined && this.neverSettles(held, depth + 1);
    });
  }
}

/** ObjectModule::ConstructObject: the class follows the OBJD type and master id. */
function constructObject(sel: ObjSelector, placeholder: boolean, missing: MissingObject | null): XObject | null {
  const { masterId, objectType } = sel.objd;
  if (masterId === 0) {
    if (objectType === OBJ_TYPE_PERSON) return new XObject(sel, "person", placeholder, missing);
    // Single-tile definitions of type 8 (portal) or 9 are never constructed.
    if (objectType === 8 || objectType === 9) return null;
    return new XObject(sel, "object", placeholder, missing);
  }
  return new XObject(sel, objectType === OBJ_TYPE_PORTAL ? "portal" : "multiTile", placeholder, missing);
}

/** Neighborhood folder of a house file path ("UserData3/Houses/House01.iff" -> "UserData3"). */
function userDirOf(path: string): string {
  const first = path.split(/[\\/]/)[0] ?? "";
  return /^userdata\d*$/i.test(first) ? first : "UserData";
}

/**
 * House::LoadFile's object part: ObjectModule::Load (+ CheckIntegrity on
 * `world`'s tile object arrays when given) and ObjectModule::PostLoad.
 * Returns every object keyed by its id, in module order; people are included
 * (`isPerson`) with their cXObject fields only.
 */
export async function loadLotObjects(house: ResFile, world?: IntegrityWorld, folder?: ObjectFolder): Promise<Map<number, PlacedObject>> {
  return (await loadLotModule(house, world, folder)).module.objects;
}

/** loadLotObjects keeping the ObjectModule and the ObjectFolder (the buy tools create objects in them). */
export async function loadLotModule(house: ResFile, world?: IntegrityWorld, folder?: ObjectFolder): Promise<{ module: ObjectModule; folder: ObjectFolder }> {
  const f = folder ?? (await ObjectFolder.get(userDirOf(house.name)));
  const module = await ObjectModule.load(house, f);
  if (world) module.checkIntegrity(world);
  module.postLoad();
  return { module, folder: f };
}
