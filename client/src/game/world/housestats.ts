/**
 * House statistics: ObjectModule::ComputeStats (object values and the
 * per-category flags) and cFixedWorld::ComputeArchValue (walls, wallpaper,
 * floors and pool tiles), plus the way House::EnterLiveMode /
 * PrepareForBudgetWindow / DoCommand combine them.
 *
 * House::EnterLiveMode (and the two others, identically):
 *   ComputeStats(&objectValue, &otherValue, &c1, &c9, &houseObject, &bits)
 *   arch = ComputeArchValue(&hasArch)
 *   Family +0x138 bit 0 = c1, bit 1 = c9 (when the family +0x10c is set)
 *   cSimulator +0xa0 = objectValue, +0xa4 = arch + otherValue
 *   global 0x16 ("Lot Has House") = hasArch || houseObject
 *   global 0x25 ("Filter Flags for Transit Screen") = (short) bits
 *
 * Object data indices (cXObject +0x4a + 2 * i, Behavior.iff STR# 141) used here:
 *   15 repair state (+0x68)  41 current value (+0x9c)  43 movement flags (+0xa0)
 *   59 category (+0xc0)
 * OBJD fields (+0x118, byte offsets): +0x12 object type, +0x14 master id,
 *   +0x4e room sort flags, +0x50 function sort flags, +0x8a build mode type.
 */

import { OD, type XObject } from "./objects.js";
import { getWall, patternIndex } from "./tilewalls.js";
import type { FixedWorld } from "./world.js";

/** Object data index 15: repair state (+0x68). */
const OD_REPAIR_STATE = 15;
/** Object data index 59: category (+0xc0). */
const OD_CATEGORY = 59;
/** Movement flags (OD 43, STR# 203) bit 4. */
const MV_NOT_DELETED_BY_EVICT = 0x10;
/** Movement flags bit 3: tested by IsDeletedByEvict on a path that cannot reach it (bit 4 is clear there). */
const MV_EVICT_BIT3 = 0x8;
/** OBJD +0x12 object types. */
const TYPE_PERSON = 2;
const TYPE_SKIPPED_BY_STATS = 7;
/** World tile flag 0x20 (cFixedWorld +0x30 + level * 4): tile outside the editable lot. */
const TILE_NOT_EDITABLE = 0x20;

/** Pool tile values (cFixedWorld +0x60): < 0x10 pool, 0x10 deck. */
const POOL_DECK = 0x10;

/**
 * ComputeStats' jump table lbl_105BBA2C, indexed by the object's category
 * (object data 59, 0..0x61; others and unlisted values only take the common
 * path sub_100D9B10). Kinds:
 *   "c1"  case 0x100D9A24: IsInWorld -> *param_4 = 1
 *   "c9"  case 0x100D9A40: *param_5 = 1
 *   number: case ori into *param_7
 *   "r23".."r27": register flags folded into *param_7 after the loop.
 */
type CategoryEffect = "c1" | "c9" | "r23" | "r24" | "r25" | "r26" | "r27" | number;
const CATEGORY_EFFECTS: ReadonlyMap<number, CategoryEffect> = new Map<number, CategoryEffect>([
  [1, "c1"],
  // 0x100D9A4C: |= 1
  [4, 0x1],
  [46, 0x1],
  [47, 0x1],
  [48, 0x1],
  [71, 0x1],
  [9, "c9"],
  // 0x100D9A7C: r23 = 1
  [10, "r23"],
  // 0x100D9A84: r26 = 1
  [17, "r26"],
  [21, "r26"],
  [22, "r26"],
  [23, "r26"],
  [24, "r26"],
  [30, "r26"],
  [39, "r26"],
  [40, "r26"],
  [58, "r26"],
  [59, "r26"],
  [74, "r26"],
  // 0x100D9A5C: |= 2
  [25, 0x2],
  [26, 0x2],
  [50, 0x2],
  [72, 0x2],
  // 0x100D9A6C: |= 4
  [73, 0x4],
  // 0x100D9A9C: |= 0x40
  [43, 0x40],
  [49, 0x40],
  [51, 0x40],
  [77, 0x40],
  // 0x100D9A8C: r24 = 1
  [75, "r24"],
  // 0x100D9A94: r25 = 1
  [76, "r25"],
  // 0x100D9ABC: |= 0x80
  [80, 0x80],
  // 0x100D9AEC: |= 0x400
  [83, 0x400],
  // 0x100D9ACC: |= 0x100
  [84, 0x100],
  // 0x100D9ADC: |= 0x200
  [85, 0x200],
  // 0x100D9AAC: |= 0x1000
  [93, 0x1000],
  [94, 0x1000],
  // 0x100D9AFC: |= 0x800
  [95, 0x800],
  // 0x100D9B0C: r27 = 1
  [97, "r27"],
]);

/** ObjectModule::ComputeStats' six outputs. */
export interface HouseStats {
  /** *param_2: sum of GetCurrentValue of in-world objects IsDeletedByEvict accepts (-> cSimulator +0xa0). */
  objectValue: number;
  /** *param_3: sum of GetCurrentValue of the others whose master OBJD +0x8a (build mode type) is neither 0 nor 4 (-> +0xa4 with the arch value). */
  otherValue: number;
  /** *param_4: an object of category 1 is in the world (-> Family +0x138 bit 0). */
  category1InWorld: boolean;
  /** *param_5: an object of category 9 exists (in the world or not) (-> Family +0x138 bit 1). */
  category9: boolean;
  /** *param_6: an in-world object with OBJD +0x4e / +0x50 / +0x8a set stands on an editable tile (-> global 0x16). */
  houseObject: boolean;
  /** *param_7: category bits (-> global 0x25, as a short). */
  bits: number;
}

/** What GetCurrentValue / ComputeStats need from the module: objects by id, in module order (+0x30 / +0xe0). */
export type ObjectList = ReadonlyMap<number, XObject>;

/** Signed char of a fixed-point coordinate's tile (`(char)(f >> 4)`). */
function tileOf(f: number): number {
  return ((f >> 4) << 24) >> 24;
}

/**
 * cXObject::IsInWorld: GetPlacementSpec's first byte, i.e. the object's tile
 * is inside 1 .. size - 2 (cFixedWorld +0x10 = size). GetPlacementSpec's
 * side effect (a top-of-hierarchy slot hier number 0 becomes -1) is not
 * reproduced: this stays pure (tools/placement.ts' getPlacementSpec does it).
 */
export function isInWorld(obj: XObject, fixed: FixedWorld): boolean {
  const last = fixed.size - 1;
  const x = tileOf(obj.fx);
  if (x < 1 || last <= x) return false;
  const y = tileOf(obj.fy);
  return !(y < 1 || last <= y);
}

/**
 * func_105883A0(obj, 0x28, lbl_105BA064, lbl_105BA060, 0): the dynamic cast
 * to cXMTObject. ConstructObject builds a cXMTObject (or cXPortal, derived
 * from it) for every definition with a master id.
 */
function asMultiTile(obj: XObject): XObject | null {
  return obj.kind === "multiTile" || obj.kind === "portal" ? obj : null;
}

/** cXMTObject +0x190: the lead part (null when the object is itself the lead). */
function leadOf(obj: XObject, objects: ObjectList): XObject | null {
  return obj.mtLeadId !== 0 ? (objects.get(obj.mtLeadId) ?? null) : null;
}

/** The lead's part chain (+0x18c next part): the lead, then the parts naming it, in module order. */
function partsOf(lead: XObject, objects: ObjectList): XObject[] {
  const parts = [lead];
  for (const o of objects.values()) if (o !== lead && o.mtLeadId !== 0 && o.mtLeadId === lead.objectId) parts.push(o);
  return parts;
}

/**
 * cXObject::IsDeletedByEvict (0x100BAC80): the object goes away with the
 * family when evicted (it counts in the family's object value).
 */
export function isDeletedByEvict(obj: XObject): boolean {
  const mv = obj.objectData[OD.movementFlags]!;
  if (mv & MV_NOT_DELETED_BY_EVICT) return false;
  if (obj.selector.objd.objectType === TYPE_PERSON) return true;
  if (obj.selector.getMasterSelector().objd.i16(0x8a) !== 0) return false;
  if ((mv & MV_EVICT_BIT3) === 0) return true;
  return (((mv >> 4) & 1) ^ 1) !== 0;
}

/**
 * cXObject::GetCurrentValue (0x100C0F30): object data 41 (+0x9c), halved
 * (C division) when the repair state (+0x68) is non-zero. Multi-tile
 * objects: the lead's value, halved when any part of the chain is broken;
 * 0 when the cast to cXMTObject fails.
 */
export function getCurrentValue(obj: XObject, objects: ObjectList): number {
  let value: number;
  let broken: boolean;
  if (obj.selector.objd.masterId === 0) {
    value = obj.objectData[OD.currentValue]!;
    broken = obj.objectData[OD_REPAIR_STATE]! !== 0;
  } else {
    const mt = asMultiTile(obj);
    if (!mt) return 0;
    const lead = leadOf(mt, objects) ?? mt;
    broken = false;
    for (const part of partsOf(lead, objects)) broken = broken || part.objectData[OD_REPAIR_STATE]! !== 0;
    value = lead.objectData[OD.currentValue]!;
  }
  // Short arithmetic: (short) / 2 truncates toward zero.
  return broken ? Math.trunc(value / 2) : value;
}

/**
 * ObjectModule::ComputeStats (0x100D9990), from the assembly (the pseudo-C
 * lost the category jump table).
 */
export function computeStats(objects: ObjectList, fixed: FixedWorld): HouseStats {
  const s: HouseStats = { objectValue: 0, otherValue: 0, category1InWorld: false, category9: false, houseObject: false, bits: 0 };
  // r23..r27
  let r23 = false;
  let r24 = false;
  let r25 = false;
  let r26 = false;
  let r27 = false;

  for (const obj of objects.values()) {
    // lha +0xc0; cmplwi 0x61 (a negative category takes the default path).
    const category = obj.objectData[OD_CATEGORY]!;
    const effect = category >= 0 && category <= 0x61 ? CATEGORY_EFFECTS.get(category) : undefined;
    if (effect !== undefined) {
      if (effect === "c1") {
        if (isInWorld(obj, fixed)) s.category1InWorld = true;
      } else if (effect === "c9") s.category9 = true;
      else if (effect === "r23") r23 = true;
      else if (effect === "r24") r24 = true;
      else if (effect === "r25") r25 = true;
      else if (effect === "r26") r26 = true;
      else if (effect === "r27") r27 = true;
      else s.bits |= effect;
    }

    // sub_100D9B10: multi-tile parts other than the lead are skipped.
    const objd = obj.selector.objd;
    if (objd.masterId !== 0) {
      const mt = asMultiTile(obj);
      if (mt && mt !== (leadOf(mt, objects) ?? mt)) continue;
    }
    if (objd.objectType === TYPE_SKIPPED_BY_STATS) continue;

    if (isInWorld(obj, fixed)) {
      const counts = objd.i16(0x4e) !== 0 || objd.i16(0x50) !== 0 || objd.i16(0x8a) !== 0;
      // CTilePt +0xfc / +0xfd / +0xfe: tile x, y, level.
      if (counts && (tileFlags(fixed, obj.tileX, obj.tileY, obj.level) & TILE_NOT_EDITABLE) === 0) s.houseObject = true;
    }

    if (isInWorld(obj, fixed) && isDeletedByEvict(obj)) {
      s.objectValue += getCurrentValue(obj, objects);
    } else {
      const bmt = obj.selector.getMasterSelector().objd.i16(0x8a);
      if (bmt !== 4 && bmt !== 0) s.otherValue += getCurrentValue(obj, objects);
    }
  }

  // 0x100D9C8C: r24 / r25 / r26 only count with r23.
  if (r24 && !r23) r24 = false;
  if (r25 && !r23) r25 = false;
  if (r26 && !r23) r26 = false;
  if (r26) s.bits |= 0x8;
  if (r24) s.bits |= 0x10;
  if (r25 || r27) s.bits |= 0x20;
  return s;
}

/** cFixedWorld +0x30 + level * 4 (flags array), byte at [x][y]; 0 outside the arrays. */
function tileFlags(fixed: FixedWorld, x: number, y: number, level: number): number {
  const a = fixed.flags[level - 1];
  if (!a || x < 0 || y < 0 || x >= a.size || y >= a.size) return 0;
  return a.u8(x, y);
}

/** What ComputeArchValue reads from WallGraphicsMgr (lbl_105BA118). */
export interface WallPatternCosts {
  getWallPatternCost(pattern: number): number;
}

/** What ComputeArchValue reads from FloorGraphicsMgr (lbl_105BA114). */
export interface FloorCosts {
  getFloorCost(pattern: number): number;
}

/** The two price globals ComputeArchValue reads (Catalog::Init fills them; see data/buildcatalog.ts BuildPrices). */
export interface ArchPrices {
  /**
   * lbl_105BA4CC -> lbl_1063F3E8: 256 ints in BSS, indexed by wall style.
   * Catalog::Init only writes styles 1 and 0xff (same price), 2, 0xc, 0xd
   * and 0xe from Build.iff's wall strings; every other style costs 0.
   */
  wallStyle: ReadonlyMap<number, number>;
  /** lbl_105BA4C8 -> lbl_106060E0 (static 100, Catalog::Init overwrites it): one pool tile. */
  pool: number;
}

/** Wall styles whose sides carry wallpaper (the `style == 1 || style - 7 <= 1 || style == 9` test). */
function takesWallpaper(style: number): boolean {
  return style === 1 || (style - 7 >>> 0) < 2 || style === 9;
}

/**
 * cFixedWorld::ComputeArchValue (0x10155BE0): walls (style price, halved at
 * the end since both tiles of a wall count it), the wallpaper facing each
 * tile, floors (half of each side of a diagonally split tile) and pool
 * tiles, over both levels, skipping tiles with flag 0x20. `hasArch` is
 * true when any counted tile has a wall, a floor, a pool or a deck.
 */
export function computeArchValue(fixed: FixedWorld, walls: WallPatternCosts, floors: FloorCosts, prices: ArchPrices): { value: number; hasArch: boolean } {
  let total = 0; // r28
  let stylePrices = 0; // r29
  let hasArch = false;
  const size = fixed.size; // +0x10
  for (let level = 1; level <= 2; level++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (tileFlags(fixed, x, y, level) & TILE_NOT_EDITABLE) continue;
        const t = getWall(fixed, x, y, level);
        const segs = t.segs;
        hasArch = hasArch || segs !== 0;

        // Lowest set segment bit, then the next ones; the walk to the next bit
        // stops at 0x20, so the 0x20 diagonal only counts when it is the lowest bit.
        let seg = 0;
        if (segs !== 0) {
          seg = 1;
          while (seg !== (seg & segs)) seg <<= 1;
        }
        while (seg !== 0) {
          let i = 0;
          for (let v = seg; (v & 1) === 0; v >>= 1) i++;
          const style = t.styles[i]!;
          stylePrices = (stylePrices + (prices.wallStyle.get(style) ?? 0)) | 0;
          if (takesWallpaper(style)) {
            // Pattern slot: the side facing this tile (patternIndex with side 0).
            total = (total + walls.getWallPatternCost(t.patterns[patternIndex(seg, 0)]!)) | 0;
          }
          do {
            seg <<= 1;
            if (seg === (seg & segs)) break;
          } while (seg < 0x20);
          if (seg >= 0x20) seg = 0;
        }

        // cFixedWorld +0x20 + level * 4: floors (u16).
        let floor = fixed.floors[level - 1]!.u16(x, y);
        if (floor !== 0) {
          if (floor !== 0xff) {
            total = (total + floors.getFloorCost(floor)) | 0;
          } else if ((segs & 0x10) === 0x10 || (segs & 0x20) === 0x20) {
            // Diagonal tile: the two floors are kept in TileWalls +0x08 and +0x14.
            if (t.styles[0]! !== 0) total = (total + Math.trunc(floors.getFloorCost(t.styles[0]!) / 2)) | 0;
            floor = t.patterns[0]!;
            if (floor !== 0) total = (total + Math.trunc(floors.getFloorCost(floor) / 2)) | 0;
          }
        }
        hasArch = hasArch || floor !== 0;

        if (level === 1) {
          // cFixedWorld +0x60: pool.
          const p = fixed.pool.u8(x, y);
          if (p < POOL_DECK) {
            total = (total + prices.pool) | 0;
            hasArch = true;
          }
          if (p === POOL_DECK) hasArch = true;
        }
      }
    }
  }
  return { value: (total + Math.trunc(stylePrices / 2)) | 0, hasArch };
}

/** The values House::EnterLiveMode (and PrepareForBudgetWindow, DoCommand) derive from the two computations. */
export interface HouseStatsSummary {
  stats: HouseStats;
  arch: { value: number; hasArch: boolean };
  /** cSimulator +0xa0 */
  simA0: number;
  /** cSimulator +0xa4: arch value + otherValue. */
  simA4: number;
  /** Global 0x16 "Lot Has House". */
  lotHasHouse: number;
  /** Global 0x25 "Filter Flags for Transit Screen": (short) bits. */
  transitFilterFlags: number;
  /** Family +0x138 bits 0 / 1 (applied only when the family's +0x10c is set). */
  familyFlags: number;
}

/** House::EnterLiveMode's use of ComputeStats and ComputeArchValue. */
export function summarizeHouseStats(objects: ObjectList, fixed: FixedWorld, walls: WallPatternCosts, floors: FloorCosts, prices: ArchPrices): HouseStatsSummary {
  const stats = computeStats(objects, fixed);
  const arch = computeArchValue(fixed, walls, floors, prices);
  return {
    stats,
    arch,
    simA0: stats.objectValue,
    simA4: (arch.value + stats.otherValue) | 0,
    lotHasHouse: arch.hasArch || stats.houseObject ? 1 : 0,
    transitFilterFlags: (stats.bits << 16) >> 16,
    familyFlags: (stats.category1InWorld ? 1 : 0) | (stats.category9 ? 2 : 0),
  };
}
