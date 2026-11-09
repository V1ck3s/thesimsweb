/**
 * Room lighting: the ambient light level of each room (Room::ComputeRoom's
 * lighting part, fed by Room::CollectTileStats / CollectObjectStats as
 * RoomManager::ComputeRooms calls them), the per-tile ambient byte maps
 * (RoomManager +0x50 per level) and RoomManager::GetRoomAmbientLight.
 *
 * Constants (lbl_105BBC24): outside ambient by time of day (cSimulator
 * global 4: 0 day 1.0, 1 / 3 dusk / dawn 0.5, 2 night 0.0) times
 * LightingParameters +0xc (1.0). A room inside gets
 *   min(k, window light / 100 / (area / 2) * k * 30) + lamp light / 100 / (area / 2) * 30
 * clamped to 0 below 0.01 and to 1 above 0.99, where window light is the
 * lighting contribution (+0xb0) of portals and lamp light that of the other
 * light objects on its tiles. Pools light their room at 0.8.
 *
 * Sprites use the level through PalWrap::ChooseBestCLUT (the compositor's
 * ambient, see Compositor.ambient); people through
 * HouseViewer::Render3DObject -> RenderParam::SetAmbientLightLevel.
 *
 * Point lights (light source 1) are positioned on the LightLayer of their
 * level here too (lightmaps.ts); the floors and walls draw their pools.
 *
 * A room marked by RoomLightingChanged / RoomScoreChanged (a lamp switched
 * by its tree: Refresh "lighting", GlobalDispatch 0xf2 -> 0xf1) is computed
 * again by the next RoomManager::UpdateRooms (updateRooms).
 *
 * The score part of Room::ComputeRoom (Room +0x68, the room motive of the
 * people in it, cXPerson::Simulate) uses the RoomScoreConstants (FCNS 3 of
 * Global.iff): inside, the share of wallpapered walls, of floored area, the
 * room impact of the objects over the area (clipped to 10..45), the area
 * (clipped to 60) and the ambient light, each mapped linearly between its
 * two constants, summed and clamped to -100..100; outside, room impact x 2
 * plus the good objects and pool tiles. RoomManager +0x48 (the score of
 * the outside room 0) is the outside rooms' sum / 3 plus a time of day
 * bonus. The overhead lights (Room +0x73, Room::SetOverheadLights from
 * cXPerson::UpdateCurrentRoom) light a lampless room with people in it at
 * the pool level (0.8).
 */

import { fc, loadFloatConstants, type FloatConstants } from "../sim/floatconstants.js";
import type { ResFile } from "./iffres.js";
import { LightLayer } from "./lightmaps.js";
import { OD, type PlacedObject } from "./objects.js";
import { OBJ_TYPE_PERSON, OBJ_TYPE_PORTAL } from "./objselector.js";
import { ROOM_DEGENERATE, type Room, type RoomManager } from "./rooms.js";
import { getWall, patternIndex, SEG_HORIZ, SEG_VERT, segIndex } from "./tilewalls.js";
import { ARRAY_SIZE, type FixedWorld, type RotatableWorld } from "./world.js";

/** lbl_105BBC24 [0]: pool / overhead light level. */
const POOL_AMBIENT = 0.8;
/** lbl_105BA6A8: the lowest ambient level RenderParam accepts. */
const MIN_AMBIENT = 0.5;
/** LightingParameters +0xc. */
const AMBIENT_SCALE = 1;
/** Object data index 40 (+0x9a): bit 0x400 marks objects that light their room. */
const OD_LIGHT_FLAGS = 40;
/** Object data index 29 (+0x84): negative = not counted. */
const OD_ROOM_COUNTED = 29;
/** Object data index 51 (+0xb0): lighting contribution. */
const OD_LIGHT = 51;
/** Object data 7 (+0x58) room impact, 39 (+0x98) dirtiness, 59 (+0xc0) category. */
const OD_ROOM_IMPACT = 7;
const OD_DIRTY = 39;
const OD_CATEGORY = 59;
/** Category 4: a bed (Room +0x58); 5..7: bathroom objects (Room +0x5c). */
const CATEGORY_BED = 4;
/** Wall styles Room::CollectTileStats counts as walls (Room +0x60); the others are fences. */
const COUNTED_WALL_STYLES: ReadonlySet<number> = new Set([1, 3, 5, 6, 7, 8, 9, 0xf, 0x16, 0x17]);
/** lbl_105BBC14: the two diagonal segments with the sides of their halves. */
const DIAGONAL_SIDES = [
  { seg: SEG_HORIZ, sides: [2, 4] },
  { seg: SEG_VERT, sides: [1, 3] },
] as const;
/** lbl_105BBC24 +0x28 / +0x20: a room score's bounds. */
const SCORE_MIN = -100;
const SCORE_MAX = 100;

/**
 * RoomScoreConstants::UpdateConstants: FCNS 3 of Global.iff
 * (GlobalConstantsClient 3), defaults from lbl_105BBC24. The "... for 0" /
 * "... for 100%" pairs are kept as the low value and the slope (high - low).
 */
interface RoomScoreConstants {
  /** lbl_105BE9E0 */ lightFactor: number;
  /** lbl_105BEA60 */ areaClip: number;
  /** lbl_105BEA5C / lbl_105BEA58 */ area0: number;
  areaSlope: number;
  /** lbl_105BEA54 / lbl_105BEA50 */ light0: number;
  lightSlope: number;
  /** lbl_105BEA4C / lbl_105BEA48 / lbl_105BEA44 */ impactAreaMin: number;
  impactAreaMax: number;
  impactMultiplier: number;
  /** lbl_105BEA40 / lbl_105BEA3C / lbl_105BEA38 */ outdoorImpact: number;
  outdoorGood: number;
  outdoorDivisor: number;
  /** lbl_105BEA34 / lbl_105BEA30 / lbl_105BEA2C */ outdoorDay: number;
  outdoorDawnDusk: number;
  outdoorNight: number;
  /** lbl_105BEA24 / lbl_105BEA28 */ floor0: number;
  floorSlope: number;
  /** lbl_105BEA1C / lbl_105BEA20 */ wall0: number;
  wallSlope: number;
}

function roomScoreConstants(c: FloatConstants): RoomScoreConstants {
  const f = (name: string, def: number): number => Math.fround(fc(c, name, def));
  const area0 = f("area score for zero tiles", -30);
  const light0 = f("light score for 0.0", -20);
  const floor0 = f("floor score for 0%", -40);
  const wall0 = f("wall score for 0%", -40);
  return {
    lightFactor: f("object light contribution factor", 30),
    areaClip: f("area clip to score", 60),
    area0,
    areaSlope: Math.fround(f("area score for clip tile", 30) - area0),
    light0,
    lightSlope: Math.fround(f("light score for 1.0", 20) - light0),
    impactAreaMin: f("room impact effective area min", 10),
    impactAreaMax: f("room impact effective area max", 45),
    impactMultiplier: f("room impact multiplier", 10),
    outdoorImpact: f("outdoor room impact factor", 2),
    outdoorGood: f("outdoor good object count factor", 1),
    outdoorDivisor: f("outdoor object divisor", 3),
    outdoorDay: f("outdoor daylight bonus", 0),
    outdoorDawnDusk: f("outdoor dawn/dusk bonus", -20),
    outdoorNight: f("outdoor nighttime bonus", -50),
    floor0,
    floorSlope: Math.fround(f("floor score for 100%", 0) - floor0),
    wall0,
    wallSlope: Math.fround(f("wall score for 100%", 0) - wall0),
  };
}

let scoreK = roomScoreConstants(new Map());
/** lbl_105BEA18: the constants are read once, by the first ComputeRooms that has them. */
let scoreKLoaded = false;

/** RoomManager::ComputeRooms' first call: RoomScoreConstants::UpdateConstants (FCNS 3 of Global.iff). */
export function loadRoomScoreConstants(glob: ResFile | null): void {
  if (scoreKLoaded || !glob) return;
  scoreK = roomScoreConstants(loadFloatConstants(glob, 3));
  scoreKLoaded = true;
}

/** cSimulator::UpdateTimeOfDay (global 4) from the hour. */
export function timeOfDay(hour: number): number {
  if (hour < 6) return 2;
  if (hour < 7) return 3;
  if (hour < 18) return 0;
  if (hour < 19) return 1;
  return 2;
}

/** Outside light for a time of day (ComputeRoom's switch). */
function outsideLight(phase: number): number {
  const k = phase === 2 ? 0 : phase === 1 || phase === 3 ? 0.5 : 1;
  return AMBIENT_SCALE * k;
}

/**
 * Room::ComputeRoom's inside score: wallpapered walls / walls (0 without
 * walls), floored area / area, room impact x multiplier / the area clipped
 * to the effective range, the area clipped to "area clip to score" over
 * that clip, and the ambient light, each through its constants; clamped to
 * -100..100.
 */
function insideScore(l: RoomLight, k: RoomScoreConstants): number {
  const f = Math.fround;
  const area = Math.trunc(l.area / 2);
  const clipped = Math.min(area, k.areaClip);
  const effective = area < k.impactAreaMin ? k.impactAreaMin : area > k.impactAreaMax ? k.impactAreaMax : area;
  const walls = l.walls === 0 ? 0 : f(l.papered / l.walls);
  let s = f(f(walls * k.wallSlope) + k.wall0);
  s = f(s + f(f(l.floorArea / l.area) * k.floorSlope));
  s = f(s + k.floor0);
  s = f(s + f(f(l.impact * k.impactMultiplier) / effective));
  s = f(s + f(f(clipped / k.areaClip) * k.areaSlope));
  s = f(s + k.area0);
  s = f(s + f(l.ambient * k.lightSlope));
  s = f(s + k.light0);
  // NaN gives SCORE_MIN (the original tests -100 <= s).
  return !(s >= SCORE_MIN) ? SCORE_MIN : s > SCORE_MAX ? SCORE_MAX : s;
}

/** Room's statistics (Room::Clear zeroes them, CollectTileStats / CollectObjectStats count them). */
interface RoomLight {
  /** +0x38 area (2 per square tile, 1 per diagonal half), +0x3c floored area (same units). */
  area: number;
  floorArea: number;
  /** +0x40 objects counted. */
  objects: number;
  /** +0x44 window light, +0x48 lamp light. */
  windowLight: number;
  lampLight: number;
  /** +0x4c dirtiness, +0x50 room impact, +0x54 good objects and pool tiles. */
  dirt: number;
  impact: number;
  good: number;
  /** +0x58 beds, +0x5c bathroom objects. */
  beds: number;
  baths: number;
  /** +0x60 walls, +0x64 wallpapered walls. */
  walls: number;
  papered: number;
  /** +0x68 */
  score: number;
  /** +0x6c */
  ambient: number;
  /** +0x75 */
  pool: boolean;
  /** +0x27c lights that are not portals, +0x280 people. */
  lamps: number;
  people: number;
}

function newRoomLight(): RoomLight {
  return { area: 0, floorArea: 0, objects: 0, windowLight: 0, lampLight: 0, dirt: 0, impact: 0, good: 0, beds: 0, baths: 0, walls: 0, papered: 0, score: 0, ambient: 0, pool: false, lamps: 0, people: 0 };
}

/** The ceiling lights are on in a lampless, occupied room darker than them (GetAmbientLight / ComputeRoom's test). */
function overheadLit(r: Room, l: RoomLight): boolean {
  return r.overheadLights && l.lamps === 0 && l.people > 0 && l.ambient < POOL_AMBIENT;
}

export class RoomLighting {
  private readonly lights = new Map<number, RoomLight>();
  /** RoomManager +0x50 + level * 4: ambient byte per world tile. */
  private readonly maps = [new Uint8Array(ARRAY_SIZE * ARRAY_SIZE), new Uint8Array(ARRAY_SIZE * ARRAY_SIZE)];
  phase = 0;
  /** cFixedWorld +0x68 / +0x6c: LightLayer per level. */
  readonly layers = [new LightLayer(), new LightLayer()];
  /** RoomManager +0x4c: the outside rooms' scores; +0x48: the outside score (room motive outside). */
  outsideTotal = 0;
  outsideScore = 0;
  /** ComputeRooms' SetGlobal(0x1b, the inside rooms' area). */
  onInsideArea: ((area: number) => void) | null = null;

  constructor(
    private readonly rooms: RoomManager,
    private readonly world: RotatableWorld,
    private readonly objects: () => ReadonlyMap<number, PlacedObject> | null,
  ) {}

  private get fixed(): FixedWorld {
    return this.world.fixed;
  }

  /** RoomManager::ComputeRooms' room loop: stats, then Room::ComputeRoom, for every room in use. */
  compute(phase: number): void {
    this.phase = phase;
    this.lights.clear();
    // Every light is removed then positioned again below; starting from empty
    // also drops lights of objects that left (cXObject's RemoveLight).
    for (const l of this.layers) l.clear();
    for (const r of this.rooms.inUseRooms()) this.computeRoomStats(r);
    this.dirtyRooms.clear();
    this.dirtyLevels = 0;
    this.computeTotals();
  }

  /** ComputeRooms for one room: Room::Clear, the pool flag (+0x75), the tile and object stats, Room::ComputeRoom. */
  private computeRoomStats(r: Room): void {
    const l = newRoomLight();
    const first = r.tiles[0];
    if (first) l.pool = this.fixed.hasPool(first.x, first.y, first.level);
    for (const t of r.tiles) {
      this.collectTileStats(r, l, t.x, t.y, t.level);
      this.collectObjectStats(r, l, t.x, t.y, t.level);
    }
    this.computeRoom(r, l);
    this.lights.set(r.id, l);
  }

  /**
   * The end of RoomManager::ComputeRooms, over every room in use: global
   * 0x1b = the inside rooms' area (Room::GetArea), +0x4c = the outside
   * rooms' scores, +0x48 = +0x4c / "outdoor object divisor" plus the
   * daylight (time of day 0), dawn / dusk (1, 3) or nighttime (2) bonus,
   * clamped to -100..100.
   */
  private computeTotals(): void {
    let inside = 0;
    let total = 0;
    for (const r of this.rooms.inUseRooms()) {
      const l = this.lights.get(r.id);
      if (!l) continue;
      if (r.isOutside()) total = Math.fround(total + l.score);
      else inside += Math.trunc(l.area / 2);
    }
    this.outsideTotal = total;
    const k = scoreK;
    let s = Math.fround(total / k.outdoorDivisor);
    const p = this.phase;
    if (p === 2) s = Math.fround(s + k.outdoorNight);
    else if (p === 0) s = Math.fround(s + k.outdoorDay);
    else if (p === 1 || p === 3) s = Math.fround(s + k.outdoorDawnDusk);
    this.outsideScore = s < SCORE_MIN ? SCORE_MIN : s > SCORE_MAX ? SCORE_MAX : s;
    this.onInsideArea?.((inside << 16) >> 16);
  }

  /** Room +0x70: the rooms the next ComputeRooms takes again. */
  private readonly dirtyRooms = new Set<number>();
  /** RoomManager +0x40: bit 0 = rooms of level 1 are dirty, bit 1 = level 2. */
  private dirtyLevels = 0;

  /**
   * RoomManager::RoomLightingChanged (House::DoCommand 0xf1: a lamp's
   * "set object lighting" Refresh) and RoomScoreChanged (Refresh "room
   * score"), same body: the room is marked (+0x70) and its level's bit set
   * in +0x40 (1 for level 1, 2 for level 2).
   */
  roomChanged(id: number): void {
    const r = this.rooms.getRoom(id);
    if (!r) return;
    this.dirtyRooms.add(id);
    this.dirtyLevels |= r.level === 2 ? 2 : 1;
  }

  /**
   * RoomManager::UpdateRooms (HouseViewer::PrepareWorldForUpdate, every
   * frame): +0x40 = 1 / 2 runs ComputeRooms on that level, 3 on all. Its
   * room loop takes again only the marked rooms in use of the level and
   * clears their mark; the level's bits are cleared. True when a room's
   * light (Room::GetAmbientLight) changed, which ComputeRooms signals with
   * GlobalDispatch(0xf1, room): the view is drawn again.
   */
  updateRooms(): boolean {
    const d = this.dirtyLevels;
    if (d === 0) return false;
    const level = d === 3 ? 0 : d;
    this.dirtyLevels = level === 0 ? 0 : d & ~level;
    let changed = false;
    for (const r of this.rooms.inUseRooms()) {
      if ((level !== 0 && r.level !== level) || !this.dirtyRooms.has(r.id)) continue;
      this.dirtyRooms.delete(r.id);
      const before = this.roomAmbient(r.id);
      this.computeRoomStats(r);
      if (this.roomAmbient(r.id) !== before) changed = true;
    }
    this.computeTotals();
    return changed;
  }

  /**
   * Room::CollectTileStats: a pool tile counts as a good object (+0x54).
   * Outside, the area only. Inside, a tile without a diagonal wall adds 2
   * to the area (and the floored area when it has a floor) and, for each of
   * its wall segments that is a wall (not a fence), a wall (+0x60), a
   * wallpapered one (+0x64) when its pattern on this side is set. A tile
   * the diagonal wall halves adds 1, its diagonal wall (both halves' sides
   * looked at for a pattern) and 1 floored when a half has a floor (the
   * half floors are TileWalls +0x08 for sides 1 / 2, +0x14 for 3 / 4).
   */
  private collectTileStats(r: Room, l: RoomLight, x: number, y: number, level: number): void {
    if (this.fixed.pool.u8(x, y) < 0x10) l.good++;
    if (r.isOutside()) {
      l.area += 2;
      return;
    }
    const t = getWall(this.fixed, x, y, level);
    const floored = this.fixed.floors[level - 1]!.u16(x, y) !== 0;
    if (t.segs === 0) {
      l.area += 2;
      if (floored) l.floorArea += 2;
      return;
    }
    if ((t.segs & (SEG_HORIZ | SEG_VERT)) === 0) {
      l.area += 2;
      if (floored) l.floorArea += 2;
      for (let seg = 1; seg < SEG_VERT; seg <<= 1) {
        if ((t.segs & seg) === 0) continue;
        const i = segIndex(seg);
        if (!COUNTED_WALL_STYLES.has(t.styles[i]!)) continue;
        l.walls++;
        if (t.patterns[patternIndex(seg, 0)] !== 0) l.papered++;
      }
      return;
    }
    l.area += 1;
    const d = (t.segs & SEG_HORIZ) !== 0 ? DIAGONAL_SIDES[0] : DIAGONAL_SIDES[1];
    const style = t.styles[segIndex(d.seg)]!;
    let papered = false;
    let halfFloor = false;
    for (const side of d.sides) {
      if (t.patterns[patternIndex(d.seg, side)] !== 0) papered = true;
      if ((side === 2 || side === 1 ? t.styles[0] : t.patterns[0]) !== 0) halfFloor = true;
    }
    if (COUNTED_WALL_STYLES.has(style)) {
      l.walls++;
      if (papered) l.papered++;
    }
    if (halfFloor) l.floorArea += 1;
  }

  /**
   * Room::CollectObjectStats over ObjectIterator(tile): the tile's object
   * and its hierarchy (slot 0 = next object on the tile, the other slots =
   * contained objects such as a lamp on a table). Objects not hidden and
   * counted in a room (object data 29 >= 0): the count, beds and bathroom
   * objects (category), people (OBJD type 2), lights (object data 40 bit
   * 0x400, in the world: those that are not portals in +0x27c, their
   * contribution in the window or lamp light; point lights positioned),
   * dirtiness, room impact (outside only the negative ones) and the good
   * objects (room impact >= 0).
   */
  private collectObjectStats(r: Room, l: RoomLight, x: number, y: number, level: number): void {
    const objs = this.objects();
    if (!objs) return;
    const first = this.fixed.objects[level - 1]!.s16(x, y);
    const stack = first > 0 ? [first] : [];
    const seen = new Set<number>();
    for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
      if (seen.has(id)) continue;
      seen.add(id);
      const o = objs.get(id);
      if (!o) continue;
      for (let i = o.objectSlots.length - 1; i >= 0; i--) {
        const c = o.objectSlots[i]!.containedId;
        if (c > 0) stack.push(c);
      }
      const d = o.objectData;
      if (o.hidden !== 0 || d[OD_ROOM_COUNTED]! < 0) continue;
      l.objects++;
      const category = d[OD_CATEGORY]!;
      if (category === CATEGORY_BED) l.beds++;
      else if (category > CATEGORY_BED && category < 8) l.baths++;
      const type = o.selector.objd.objectType;
      if (type === OBJ_TYPE_PERSON) l.people++;
      if ((d[OD_LIGHT_FLAGS]! & 0x400) !== 0 && o.tileX >= 0) this.collectLight(l, o, type);
      l.dirt += d[OD_DIRTY]!;
      const impact = d[OD_ROOM_IMPACT]!;
      if (!r.isOutside() || impact < 0) l.impact += impact;
      if (impact >= 0) l.good++;
    }
  }

  /** CollectObjectStats' light part. */
  private collectLight(l: RoomLight, o: PlacedObject, type: number): void {
    if (type !== OBJ_TYPE_PORTAL) l.lamps++;
    const c = o.objectData[OD_LIGHT]!;
    const layer = this.layers[o.level - 1];
    if (c === 0) {
      layer?.removeLight(this.fixed, o.tileX, o.tileY);
      return;
    }
    if (type === OBJ_TYPE_PORTAL) l.windowLight += c;
    else l.lampLight += c;
    // Light source 1 (point light): LightLayer::RemoveLight, PositionLight.
    if (o.objectData[OD.lightSource] === 1 && layer) {
      layer.removeLight(this.fixed, o.tileX, o.tileY);
      layer.positionLight(this.fixed, this.rooms, o.tileX, o.tileY, o.level);
    }
  }

  /**
   * Room::ComputeRoom: the ambient light (+0x6c), the score (+0x68) and
   * the tile byte map (0xcc for a pool room or one the overhead lights
   * light).
   */
  private computeRoom(r: Room, l: RoomLight): void {
    const k = outsideLight(this.phase);
    const sk = scoreK;
    const outside = r.isOutside();
    if (outside) {
      l.ambient = k;
    } else {
      const half = Math.trunc(l.area / 2);
      const win = Math.min(k, (l.windowLight / 100 / half) * k * sk.lightFactor);
      let d = win + (l.lampLight / 100 / half) * sk.lightFactor;
      // NaN (a room of half-area 0) gives 0, as the original's comparisons do.
      if (!(d >= 0.01)) d = 0;
      else if (d > 0.99) d = 1;
      l.ambient = d;
    }
    l.score = outside ? Math.fround(Math.fround(l.impact * sk.outdoorImpact) + Math.fround(l.good * sk.outdoorGood)) : insideScore(l, sk);
    const byte = !outside && (l.pool || overheadLit(r, l)) ? 0xcc : Math.trunc(0.5 + 255 * l.ambient);
    this.fillMap(r, byte);
  }

  /** The room's tiles in the ambient byte map. */
  private fillMap(r: Room, byte: number): void {
    const map = this.maps[r.level - 1]!;
    for (const t of r.tiles) map[t.x * ARRAY_SIZE + t.y] = byte;
  }

  /**
   * Room::SetOverheadLights: an inside room without a pool takes the flag;
   * when it changed, the room has no lamp and is darker than the overhead
   * light, GlobalDispatch(0xf1, room) (House::DoCommand: RoomLightingChanged,
   * the next UpdateRooms counts its people again) and its tiles take 0xcc
   * (on) or their ambient byte (off).
   */
  setOverheadLights(id: number, on: boolean): void {
    const r = this.rooms.getRoom(id);
    const l = this.lights.get(id);
    if (!r || r.isOutside() || r.overheadLights === on || l?.pool) return;
    r.overheadLights = on;
    if (!l || l.lamps !== 0 || l.ambient >= POOL_AMBIENT) return;
    this.roomChanged(id);
    this.fillMap(r, on ? 0xcc : Math.trunc(0.5 + 255 * l.ambient));
  }

  /**
   * RenderParam::SetAmbientLightLevel's clamp: at least lbl_105BA6A8 (0.5),
   * at most lbl_105BA40C, which RoomManager::AllRoomsLightingChanged sets to
   * 1.0 by day and 0.8 otherwise.
   */
  clampAmbient(level: number): number {
    const max = this.phase === 0 ? 1 : POOL_AMBIENT;
    return Math.min(Math.max(level, MIN_AMBIENT), max);
  }

  /**
   * RoomManager::GetRoom(id) as cXObject::InterpValue's scope 23 reads it:
   * Room::GetAmbientLight, IsOutside, GetLevel and GetArea (+0x38 / 2).
   * Null when the room does not exist.
   */
  roomInfo(id: number): { ambient: number; outside: boolean; level: number; area: number; objects: number } | null {
    const r = this.rooms.getRoom(id);
    if (!r) return null;
    const l = this.lights.get(id);
    return { ambient: this.roomAmbient(id), outside: r.isOutside(), level: r.level, area: Math.trunc((l?.area ?? 0) / 2), objects: l?.objects ?? 0 };
  }

  /**
   * cXPerson::Simulate's room motive source: null without the room, the
   * outside score (RoomManager +0x48) for an outside room, else Room +0x68.
   */
  roomScore(id: number): number | null {
    const r = this.rooms.getRoom(id);
    if (!r) return null;
    if (r.isOutside()) return this.outsideScore;
    return this.lights.get(id)?.score ?? 0;
  }

  /** The statistics of a room (debugging). */
  roomStats(id: number): Readonly<RoomLight> | null {
    return this.lights.get(id) ?? null;
  }

  /** Room::GetAmbientLight: the pool level for a pool room or one its overhead lights light. */
  roomAmbient(id: number): number {
    const l = this.lights.get(id);
    if (!l) return 1;
    const r = this.rooms.getRoom(id);
    return l.pool || (r !== null && overheadLit(r, l)) ? POOL_AMBIENT : l.ambient;
  }

  /**
   * RoomManager::GetRoomAmbientLight: ambient at a fixed-point view position
   * (1/16 tile). Degenerate diagonal tiles take the room of the half the
   * point lies in.
   */
  getRoomAmbientLight(fx: number, fy: number, level: number): number {
    const w = this.world;
    const vx = fx >> 4;
    const vy = fy >> 4;
    const [x, y] = w.toWorld(vx, vy);
    if (x < 0 || y < 0 || x >= ARRAY_SIZE || y >= ARRAY_SIZE || level < 1 || level > 2) return 1;
    if (this.fixed.rooms[level - 1]!.u16(x, y) !== ROOM_DEGENERATE) return this.maps[level - 1]![x * ARRAY_SIZE + y]! / 255;
    const d = this.rooms.resolveDiagonal(x, y, level);
    const rot = w.rotation;
    const side1 = d.side1 !== 0 ? ((d.side1 + ((4 - rot) & 3) - 1) & 3) + 1 : 0;
    const worldSegs = this.fixed.wallStorage(x, y, level).segs;
    const viewHoriz = (worldSegs & (rot & 1 ? SEG_VERT : SEG_HORIZ)) !== 0;
    const ux = (fx & 0xf) / 16;
    const uy = (fy & 0xf) / 16;
    let id = d.room1;
    if (viewHoriz) {
      if (1 < ux + uy) {
        if (side1 !== 2 && side1 !== 0) id = d.room2;
      } else if (side1 !== 4 && side1 !== 0) id = d.room2;
    } else if (0 < ux - uy) {
      if (side1 !== 3 && side1 !== 0) id = d.room2;
    } else if (side1 !== 1 && side1 !== 0) id = d.room2;
    return this.rooms.getRoom(id) ? this.roomAmbient(id) : 1;
  }

  /** Ambient of a view tile's center (RenderStaticRow: FTilePt(x + 1/2, y + 1/2)). */
  tileAmbient(x: number, y: number, level: number): number {
    return this.getRoomAmbientLight((x << 4) | 8, (y << 4) | 8, level);
  }

  /** cRotatableWorld::GetLightEntry of a view tile. */
  getLightEntry(x: number, y: number, level: number): readonly number[] {
    const [wx, wy] = this.world.toWorld(x, y);
    const layer = this.layers[level - 1];
    if (!layer || wx < 0 || wy < 0 || wx >= ARRAY_SIZE || wy >= ARRAY_SIZE) return [0x7f, 0x7f, 0x7f, 0x7f];
    return layer.getEntry(wx, wy, this.world.rotation);
  }

  /** RoomManager::ResolveDiagonal (world tile): the half floors of diagonal tiles take their rooms' light. */
  resolveDiagonal(x: number, y: number, level: number): { room1: number; side1: number; room2: number; side2: number } {
    return this.rooms.resolveDiagonal(x, y, level);
  }

  /** Room::GetAmbientLight of the room id 0 of a level (the walls' outside face). */
  outsideAmbient(): number {
    return this.roomAmbient(0);
  }
}
