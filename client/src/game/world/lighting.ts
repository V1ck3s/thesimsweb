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
 * Not ported: the "overhead lights" flag (Room +0x73) and the score part of
 * ComputeRoom.
 */

import { LightLayer } from "./lightmaps.js";
import { OD, type PlacedObject } from "./objects.js";
import { OBJ_TYPE_PORTAL } from "./objselector.js";
import { ROOM_DEGENERATE, type Room, type RoomManager } from "./rooms.js";
import { getWall, SEG_HORIZ, SEG_VERT } from "./tilewalls.js";
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

interface RoomLight {
  /** +0x38 area (2 per square tile, 1 per diagonal half), +0x44 window light, +0x48 lamp light. */
  area: number;
  windowLight: number;
  lampLight: number;
  /** +0x75 */
  pool: boolean;
  /** +0x6c */
  ambient: number;
}

export class RoomLighting {
  private readonly lights = new Map<number, RoomLight>();
  /** RoomManager +0x50 + level * 4: ambient byte per world tile. */
  private readonly maps = [new Uint8Array(ARRAY_SIZE * ARRAY_SIZE), new Uint8Array(ARRAY_SIZE * ARRAY_SIZE)];
  phase = 0;
  /** cFixedWorld +0x68 / +0x6c: LightLayer per level. */
  readonly layers = [new LightLayer(), new LightLayer()];

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
    for (const r of this.rooms.inUseRooms()) {
      const l: RoomLight = { area: 0, windowLight: 0, lampLight: 0, pool: false, ambient: 0 };
      const first = r.tiles[0];
      if (first) l.pool = this.fixed.hasPool(first.x, first.y, first.level);
      for (const t of r.tiles) {
        this.collectTileStats(r, l, t.x, t.y, t.level);
        this.collectObjectStats(l, t.x, t.y, t.level);
      }
      this.computeRoom(r, l);
      this.lights.set(r.id, l);
    }
  }

  /** Room::CollectTileStats (area only). */
  private collectTileStats(r: Room, l: RoomLight, x: number, y: number, level: number): void {
    if (r.isOutside()) {
      l.area += 2;
      return;
    }
    const segs = getWall(this.fixed, x, y, level).segs;
    l.area += segs === 0 || (segs & (SEG_HORIZ | SEG_VERT)) === 0 ? 2 : 1;
  }

  /**
   * Room::CollectObjectStats (light part) over ObjectIterator(tile): the
   * tile's object and its hierarchy (slot 0 = next object on the tile, the
   * other slots = contained objects such as a lamp on a table).
   */
  private collectObjectStats(l: RoomLight, x: number, y: number, level: number): void {
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
      if ((d[OD_LIGHT_FLAGS]! & 0x400) === 0 || o.tileX < 0) continue;
      const c = d[OD_LIGHT]!;
      const layer = this.layers[o.level - 1];
      if (c === 0) {
        layer?.removeLight(this.fixed, o.tileX, o.tileY);
        continue;
      }
      if (o.selector.objd.objectType === OBJ_TYPE_PORTAL) l.windowLight += c;
      else l.lampLight += c;
      // Light source 1 (point light): LightLayer::RemoveLight, PositionLight.
      if (d[OD.lightSource] === 1 && layer) {
        layer.removeLight(this.fixed, o.tileX, o.tileY);
        layer.positionLight(this.fixed, this.rooms, o.tileX, o.tileY, o.level);
      }
    }
  }

  /** Room::ComputeRoom's lighting part and the tile byte map. */
  private computeRoom(r: Room, l: RoomLight): void {
    const k = outsideLight(this.phase);
    if (r.isOutside()) {
      l.ambient = k;
    } else {
      const half = Math.trunc(l.area / 2);
      const win = Math.min(k, (l.windowLight / 100 / half) * k * 30);
      let d = win + (l.lampLight / 100 / half) * 30;
      if (d < 0.01) d = 0;
      else if (d > 0.99) d = 1;
      l.ambient = d;
    }
    const byte = !r.isOutside() && l.pool ? 0xcc : Math.trunc(0.5 + 255 * l.ambient);
    const map = this.maps[r.level - 1]!;
    for (const t of r.tiles) map[t.x * ARRAY_SIZE + t.y] = byte;
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

  /** Room::GetAmbientLight. */
  roomAmbient(id: number): number {
    const l = this.lights.get(id);
    if (!l) return 1;
    return l.pool ? POOL_AMBIENT : l.ambient;
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

  /** Room::GetAmbientLight of the room id 0 of a level (the walls' outside face). */
  outsideAmbient(): number {
    return this.roomAmbient(0);
  }
}
