/**
 * ObjSelector: one object definition (OBJD chunk) of an object file, as built
 * by ObjectFolder::AddSelector, and ObjDefinition, the OBJD record itself.
 *
 * The in-memory OBJD is the chunk payload, zero-padded to 0xd8 bytes
 * (ObjDefinition::ConvertObjDef), read as little-endian 16-bit fields at
 * byte offset 2 * index (labels: Behavior.iff STR# 204 "definition labels").
 *
 * ObjSelector fields (word offsets of the original):
 *   [0]  +0x00 the object's IFF (ResFile)           -> `res`
 *   [1]  +0x04 semi-global file (GLOB chunk name)    -> `semiGlobalName`
 *   [2]  +0x08 cRenderer over the IFF's sprites       (renderer side, from `res`)
 *   +0x14 name: the OBJD chunk label                 -> `name`
 *   [0x18] +0x60 ObjDefinition                       -> `objd`
 *   [0x20] +0x80 ObjectFolder                        -> `folder`
 *   [0x23] +0x8c cached master selector              -> getMasterSelector()
 *   [0x25..0x27] +0x94 DrawGroups (base graphic ..)  -> getDrawGroup()
 *   [0x2a] +0xa8 index in the folder                 -> `index`
 *   [0x2d] +0xb4 OBJD chunk id << 16 | source << 2   -> `objdId`, `source`
 */

import { DrawGroup } from "./drawgroup.js";
import type { ResFile } from "./iffres.js";
import { loadSlots, readSlotChunk, type ObjectSlot, type SpriteSlot } from "./slots.js";

/** OBJD object types (+0x12, Behavior.iff STR# 246). */
export const OBJ_TYPE_PERSON = 2;
export const OBJ_TYPE_PORTAL = 8;

/** Size of the in-memory OBJD record. */
const OBJD_SIZE = 0xd8;

export class ObjDefinition {
  private readonly view: DataView;

  constructor(payload: Uint8Array) {
    const b = new Uint8Array(OBJD_SIZE);
    b.set(payload.subarray(0, OBJD_SIZE));
    this.view = new DataView(b.buffer);
  }

  /** Signed 16-bit field at a byte offset. */
  i16(offset: number): number {
    return this.view.getInt16(offset, true);
  }

  /** Unsigned 32-bit field at a byte offset. */
  u32(offset: number): number {
    return this.view.getUint32(offset, true);
  }

  /** +0x00 */
  get version(): number {
    return this.u32(0);
  }
  /** +0x04 */
  get initialStackSize(): number {
    return this.i16(0x04);
  }
  /** +0x06: DGRP chunk id of graphic 0. */
  get baseGraphic(): number {
    return this.i16(0x06);
  }
  /** +0x08 */
  get numGraphics(): number {
    return this.i16(0x08);
  }
  /** +0x12 */
  get objectType(): number {
    return this.i16(0x12);
  }
  /** +0x14: non-zero for the tiles of a multi-tile object. */
  get masterId(): number {
    return this.i16(0x14);
  }
  /** +0x16: (x << 8 | y) tile of a multi-tile part, -1 for the lead definition. */
  get subIndex(): number {
    return this.i16(0x16);
  }
  /** +0x1c */
  get guid(): number {
    return this.u32(0x1c);
  }
  /** +0x20 */
  get disabled(): number {
    return this.i16(0x20);
  }
  /** +0x28: SLOT chunk id (0 = none). */
  get slotsId(): number {
    return this.i16(0x28);
  }
  /** +0x70 */
  get levelOffset(): number {
    return this.i16(0x70);
  }
  /** +0x72: shadow (-1 = none). */
  get shadow(): number {
    return this.i16(0x72);
  }
  /** +0x74 */
  get numAttributes(): number {
    return this.i16(0x74);
  }
  /** +0x7e */
  get mtLeadObject(): number {
    return this.i16(0x7e);
  }
  /** +0x80: SPR2 id of the first sprite whose visibility cXObject +0x34 controls. */
  get dynamicSpritesBaseId(): number {
    return this.i16(0x80);
  }
  /** +0x82 */
  get numDynamicSprites(): number {
    return this.i16(0x82);
  }
  /** +0x8a: build mode type (DrawIso: 7 forces the ambient light level). */
  get buildModeType(): number {
    return this.i16(0x8a);
  }
  /** +0x8c */
  get originalGuid(): number {
    return this.u32(0x8c);
  }
  /** +0x96 */
  get thumbnailGraphic(): number {
    return this.i16(0x96);
  }
  /** +0x9e */
  get shadowBrightness(): number {
    return this.i16(0x9e);
  }
  /** +0xb4 */
  get numTypeAttributes(): number {
    return this.i16(0xb4);
  }
  /** +0xca: render flags (bit 0: never becomes static). */
  get renderFlags(): number {
    return this.i16(0xca);
  }

  /** ObjDefinition::GetMultiTileOffsets. */
  multiTileOffsets(): [number, number] {
    return [this.subIndex >> 8, this.subIndex & 0xff];
  }
}

/** ObjDefinition::GetSubIndex. */
export function getSubIndex(x: number, y: number): number {
  return (((x << 8) | (y & 0xff)) << 16) >> 16;
}

/**
 * ShadowID::GenerateLookups (lbl_105BA340): a neighbour mask is a valid
 * multi-tile shadow id unless one of its four corners is a 2, 4 or 6 pattern.
 */
const SHADOW_VALID = (() => {
  const t = new Uint8Array(256);
  for (let u = 0; u < 256; u++) {
    const c0 = ((u >> 2) & 4) + (u & 1) + (u & 0x80 ? 2 : 0);
    const c1 = ((u >> 2) & 4) + ((u >> 1) & 1) + (u & 0x20 ? 2 : 0);
    const c2 = (u & 0x20 ? 4 : 0) + ((u >> 2) & 1) + ((u >> 5) & 2);
    const c3 = (u & 0x80 ? 4 : 0) + ((u >> 3) & 1) + ((u >> 5) & 2);
    t[u] = [c0, c1, c2, c3].some((c) => c === 2 || c === 4 || c === 6) ? 0 : 1;
  }
  return t;
})();

/** What an ObjSelector needs from its ObjectFolder. */
export interface SelectorFolder {
  getMasterSelector(sel: ObjSelector): ObjSelector | null;
  getSubTileSelector(sel: ObjSelector, x: number, y: number, level: number): ObjSelector | null;
}

export class ObjSelector {
  private master: ObjSelector | null = null;
  private drawGroups: DrawGroup[] | null = null;

  constructor(
    /** +0x80 */
    readonly folder: SelectorFolder,
    /** [0]: the object's IFF. */
    readonly res: ResFile,
    /** Path of the IFF ("GameData/Objects/Objects.far|chair.iff" or a plain path). */
    readonly fileKey: string,
    /** +0xb4 >> 16: OBJD chunk id. */
    readonly objdId: number,
    /** +0x60 */
    readonly objd: ObjDefinition,
    /** +0x14: OBJD chunk label. */
    readonly name: string,
    /** +0xa8: index in the folder. */
    readonly index: number,
    /** +0xb4 bits 2-3: source folder flag & 3 (0 objects, 1 characters, 2 downloads, 3 user objects). */
    readonly source: number,
    /** [1]: GLOB chunk string (semi-global file name), or "" when the object has none. */
    readonly semiGlobalName: string,
  ) {}

  /** ObjSelector::GetGUID */
  get guid(): number {
    return this.objd.guid;
  }

  /** ObjSelector::GetIsPerson */
  getIsPerson(): boolean {
    return this.objd.objectType === OBJ_TYPE_PERSON;
  }

  /** ObjSelector::GetIsMultiTileSubObject */
  getIsMultiTileSubObject(): boolean {
    return this.objd.masterId !== 0 && this.objd.subIndex !== -1;
  }

  /** ObjSelector::GetHasGraphics */
  getHasGraphics(): boolean {
    return this.objd.masterId !== 0 || this.objd.numGraphics !== 0;
  }

  /** ObjSelector::GetShadowBrightness */
  getShadowBrightness(): number {
    return this.objd.shadowBrightness;
  }

  /** ObjSelector::GetThumbnailGraphicIndex */
  getThumbnailGraphicIndex(): number {
    return this.objd.thumbnailGraphic;
  }

  /** ObjSelector::GetMasterSelector: the lead definition of a multi-tile object (itself otherwise). */
  getMasterSelector(): ObjSelector {
    this.master ??= this.folder.getMasterSelector(this) ?? this;
    return this.master;
  }

  /**
   * ObjSelector::GetDrawGroup: the DGRPs base graphic .. base + count - 1 are
   * loaded on first use (a missing chunk loads as an empty group); `graphic`
   * indexes them (null when out of range).
   */
  getDrawGroup(graphic: number): DrawGroup | null {
    if (!this.drawGroups) {
      this.drawGroups = [];
      const base = this.objd.baseGraphic;
      for (let i = 0; i < this.objd.numGraphics; i++) {
        const id = ((base + i) << 16) >> 16;
        const payload = this.res.get("DGRP", id);
        this.drawGroups.push(payload ? DrawGroup.load(id, payload) : new DrawGroup(id, 0, []));
      }
    }
    return this.drawGroups[graphic] ?? null;
  }

  /** ObjSelector::GetShadowID (ComputeShadowID for multi-tile parts). */
  getShadowID(): number {
    if (this.objd.masterId === 0) return this.objd.shadow;
    return this.computeShadowID();
  }

  /** ObjSelector::ComputeShadowID: mask of the neighbouring parts that cast a shadow. */
  private computeShadowID(): number {
    if (this.objd.shadow === -1) return -1;
    const [x, y] = this.objd.multiTileOffsets();
    const casts = (dx: number, dy: number): boolean => {
      const s = this.folder.getSubTileSelector(this, x + dx, y + dy, 0);
      return s !== null && s.objd.shadow !== -1;
    };
    let id = 0;
    if (casts(0, -1)) id |= 1;
    if (casts(-1, 0)) id |= 2;
    if (casts(0, 1)) id |= 4;
    if (casts(1, 0)) id |= 8;
    if (casts(-1, -1)) id |= 0x10;
    if (casts(-1, 1)) id |= 0x20;
    if (casts(1, 1)) id |= 0x40;
    if (casts(1, -1)) id |= 0x80;
    return SHADOW_VALID[id] === 1 ? id : 0;
  }

  /**
   * cXObject::Initialize's SlotLoader::Load on the OBJD's SLOT chunk: the
   * object slots (appended after the object's slot 0) and the sprite slots.
   */
  loadSlots(): { objectSlots: ObjectSlot[]; spriteSlots: SpriteSlot[] } {
    const objectSlots: ObjectSlot[] = [];
    const spriteSlots: SpriteSlot[] = [];
    const id = this.objd.slotsId;
    const payload = id !== 0 ? this.res.get("SLOT", id) : null;
    if (payload) loadSlots(readSlotChunk(payload), objectSlots, spriteSlots);
    return { objectSlots, spriteSlots };
  }
}
