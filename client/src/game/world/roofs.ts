/**
 * Roofs: cRoofLayer (the roof tiles of one level, generated from the rooms
 * at the end of cFixedWorld::ComputeRooms), the roof settings the game keeps
 * in its single cRoofMeshFactory (pitch and texture, lbl_105BABC4, saved by
 * HouseViewer::DoStream), the factory's meshes (BuildRamp / BuildCap,
 * GetRoofMesh) and cRoofUndoable. roofrender.ts draws them
 * (cRoofLayer::RenderRoofPolys).
 *
 * A roof layer is a c2DArray of 2 x 64 by 2 x 64 cRoofTile (2 bytes): one
 * cell per half tile, row = 2 * y + j, column = 2 * x + i (world tiles).
 *   byte 0: 0x01 roofed, 0x02 type (1 = ramp, 0 = cap, cRoofTile::GetType),
 *           0x04 eave, 0x08 blocked (a floor or stairs above), bits 4..7 style
 *   byte 1: altitude (roof steps above the eaves)
 * Layer 0 (cFixedWorld +0x58, "roof0") covers the rooms of level 1, layer 1
 * (+0x5c, "roof1") those of level 2.
 *
 * Tables (mac.bin): lbl_105BC790 / 794 ring walk, 798 ramp masks, 79C / 7A0
 * ComputeTypes neighbors (rows / columns), 7A4 ramp style masks, 7A8 / 7AC
 * ComputeStyles neighbors, 7B4 pitch table {0.5, 0 min, 2 max, 180, 3,
 * 0.6 default}, 7C0 / 7C4 ramp / cap meshes by style (__sinit_RoofMeshFactory
 * copies lbl_105C1558..97), 7D4 {3, 0.5, 1.5}, 7D0 {1.5, 1.5, 0.75}; the
 * mesh vertices are lbl_105C1A58.. (BuildRamp) and lbl_105C15B4.. (BuildCap).
 */

import type { ArchRoofHooks } from "../cpstate.js";
import { ReconBuffer } from "./reconbuffer.js";
import type { ResFile } from "./iffres.js";
import type { PlacedObject } from "./objects.js";
import type { Room, RoomManager } from "./rooms.js";
import { Undoable, type UndoManager } from "./tools/undo.js";
import { ARRAY_SIZE, type FixedWorld } from "./world.js";

export const ROOF_ROOFED = 0x01;
export const ROOF_RAMP = 0x02;
export const ROOF_EAVE = 0x04;
export const ROOF_BLOCKED = 0x08;

/** RoomManager's degenerate diagonal tile marker (two rooms, rooms.ts ROOM_DEGENERATE). */
const ROOM_DEGENERATE = 0xfffb;
/** OBJD +0x8a build mode type of stairs. */
const BUILD_TYPE_STAIRS = 3;

/** lbl_105BC794 / lbl_105BC790: column / row steps of the four sides of a ring. */
const RING_DCOL = [1, 0, -1, 0] as const;
const RING_DROW = [0, 1, 0, -1] as const;
/** lbl_105BC79C / lbl_105BC7A0: ComputeTypes' eight neighbors (row, column). */
const TYPE_DROW = [0, 1, 0, -1, -1, -1, 1, 1] as const;
const TYPE_DCOL = [-1, 0, 1, 0, -1, 1, 1, -1] as const;
/** lbl_105BC798: neighbor masks (bits of TYPE_D*) that make a ramp. */
const RAMP_MASKS = [0x2c, 0x46, 0x83, 0x19, 0x6e, 0xc7, 0x9b, 0x3d] as const;
/** lbl_105BC7A8 / lbl_105BC7AC: ComputeStyles' neighbors (row, column). */
const STYLE_DROW = [1, 0, 0, -1, -1, -1, 1, 1] as const;
const STYLE_DCOL = [0, 1, -1, 0, -1, 1, 1, -1] as const;
/** lbl_105BC7A4: a ramp's style bits kept when that neighbor is lower or not roofed. */
const STYLE_KEEP = [0xc, 0xa, 0x5, 0x3, 0x7, 0xb, 0xe, 0xd] as const;

// --- roof settings (the cRoofMeshFactory singleton) --------------------------------

/** lbl_105BC7B4: [1] lowest pitch, [2] highest, [5] default. */
const PITCH_MIN = 0;
const PITCH_MAX = 2;
export const DEFAULT_PITCH = 0.6;
/** lbl_105BC7B8 + 0x2f / lbl_105BC7BC: the default texture, and the one used when a texture is missing. */
export const DEFAULT_ROOF_PATTERN = "r1_";
/** lbl_105BA648 */
const PITCH_EPSILON = 1e-6;

/** The cRoofMeshFactory (lbl_105BABC4): +0x14 pitch, +0x18 texture name. */
const factory = { pitch: DEFAULT_PITCH, pattern: DEFAULT_ROOF_PATTERN, version: 0 };

/** cRoofLayer::GetPitch */
export function getRoofPitch(): number {
  return factory.pitch;
}

/** cRoofLayer::GetRoofPattern */
export function getRoofPattern(): string {
  return factory.pattern;
}

/** Bumped by every new factory (SetPitch / SetRoofPattern): the meshes and texture change. */
export function roofFactoryVersion(): number {
  return factory.version;
}

/** cRoofLayer::SetPitch: clamped to [0, 2]; false when it does not change. */
export function setRoofPitch(pitch: number): boolean {
  let p = PITCH_MIN;
  if (PITCH_MIN < pitch) p = Math.min(pitch, PITCH_MAX);
  p = Math.fround(p);
  if (Math.abs(p - factory.pitch) <= PITCH_EPSILON) return false;
  factory.pitch = p;
  factory.version++;
  return true;
}

/** cRoofLayer::SetRoofPattern: false when it is the current texture (strcmp). */
export function setRoofPattern(name: string): boolean {
  if (name === factory.pattern) return false;
  factory.pattern = name;
  factory.version++;
  return true;
}

/**
 * cRoofMeshFactory's constructor falls back to "r1_" when the texture does
 * not load (DDDTextureMgr::GetNewTexture fails).
 */
export function roofTextureMissing(name: string): void {
  if (factory.pattern === name && name !== DEFAULT_ROOF_PATTERN) {
    factory.pattern = DEFAULT_ROOF_PATTERN;
    factory.version++;
  }
}

/**
 * HouseViewer::DoStream (read), its roof part: stream version > 0x30 holds
 * the pitch (cRoofLayer::SetPitch) and the texture name (SetRoofPattern).
 * Older houses keep the current settings, like the game's single factory.
 */
export function loadRoofSettings(house: ResFile): void {
  const bytes = house.get("HOUS", 0);
  if (!bytes || bytes.length < 16) return;
  try {
    const { buf, version } = ReconBuffer.fromChunk(bytes);
    buf.recon32();
    buf.recon32();
    buf.recon32();
    buf.recon32();
    if (version > 8) buf.recon16();
    if (version >= 0x1d) buf.recon16();
    if (version > 0x29) buf.recon16();
    if (version <= 0x30) return;
    setRoofPitch(buf.reconFloat());
    setRoofPattern(buf.reconString());
  } catch {
    // a short chunk keeps the current settings
  }
}

/**
 * cRoofUndoable: holds the pattern and pitch from before a roof panel
 * change; UndoSelf swaps them with the current ones (RedoSelf is UndoSelf).
 */
export class RoofUndoable extends Undoable {
  /** +0x24 / +0x28 */
  private pattern = getRoofPattern();
  private pitch = getRoofPitch();

  constructor(private readonly invalidate: () => void) {
    super();
  }

  protected commitSelf(): number {
    return 0;
  }

  protected undoSelf(): number {
    const pattern = getRoofPattern();
    const pitch = getRoofPitch();
    setRoofPattern(this.pattern);
    setRoofPitch(this.pitch);
    this.pattern = pattern;
    this.pitch = pitch;
    this.invalidate();
    return 0;
  }

  protected override redoSelf(): number {
    return this.undoSelf();
  }
}

/**
 * The roof as cWinRoofPanel::TSOnCommand changes it: a cRoofUndoable made
 * before the change, submitted to cGameTools' UndoManager when
 * SetPitch / SetRoofPattern changed something (GViewer::DirtyAll).
 */
export function makeArchRoofHooks(undo: UndoManager, invalidate: () => void): ArchRoofHooks {
  const change = (apply: () => boolean): void => {
    const u = new RoofUndoable(invalidate);
    if (!apply()) return;
    invalidate();
    undo.submitUndoable(u);
  };
  return {
    getPitch: getRoofPitch,
    setPitch: (p) => change(() => setRoofPitch(p)),
    getPattern: getRoofPattern,
    setPattern: (name) => change(() => setRoofPattern(name)),
  };
}

// --- cRoofLayer -------------------------------------------------------------------

export class RoofLayer {
  /** c2DArray rows = columns (cRoofLayer(0x40): 2 x 0x40). */
  readonly n = ARRAY_SIZE * 2;
  readonly data = new Uint8Array(this.n * this.n * 2);

  private at(row: number, col: number): number {
    return (row * this.n + col) * 2;
  }

  flags(row: number, col: number): number {
    return this.data[this.at(row, col)]!;
  }

  alt(row: number, col: number): number {
    return this.data[this.at(row, col) + 1]!;
  }

  private roofed(row: number, col: number): boolean {
    return (this.data[this.at(row, col)]! & ROOF_ROOFED) !== 0;
  }

  /** Roofed and not an eave (the test ComputeEaves and GenerateRoof use). */
  private solid(row: number, col: number): boolean {
    return (this.data[this.at(row, col)]! & (ROOF_ROOFED | ROOF_EAVE)) === ROOF_ROOFED;
  }

  /**
   * cRoofLayer::GenerateRoof(level, upper): the cells of the rooms that want
   * a roof, minus those the upper layer roofs, plus the eaves; then up to
   * nine rounds of ComputeAltitudes / ComputeTypes / ComputeStyles until
   * ComputeTypes drops no eave.
   */
  generateRoof(fixed: FixedWorld, rooms: RoomManager, level: number, upper: RoofLayer | null, objects: RoofObjects | null): void {
    this.discoverTilesToRoof(fixed, rooms, level, objects);
    if (upper) {
      for (let r = 0; r < this.n; r++) {
        for (let c = 0; c < this.n; c++) if (upper.solid(r, c)) this.data[this.at(r, c)]! &= ~ROOF_ROOFED;
      }
    }
    this.computeEaves(upper);
    for (let i = 0; ; i++) {
      const ok = this.computeAltitudes() && this.computeTypes() && this.computeStyles();
      if (ok || i > 7) break;
    }
  }

  /**
   * cRoofLayer::DiscoverTilesToRoof: a cell is roofed when its tile's room
   * (either room of a degenerate diagonal tile) wants a roof
   * (Room::WantsRoof). On level 1 a floor above, or stairs on a tile with an
   * object above, block it (flag 0x08).
   */
  private discoverTilesToRoof(fixed: FixedWorld, rooms: RoomManager, level: number, objects: RoofObjects | null): void {
    this.data.fill(0);
    const wants = new Map<number, boolean>();
    const wantsRoof = (id: number): boolean => {
      let w = wants.get(id);
      if (w === undefined) {
        const room = rooms.getRoom(id);
        w = room ? roomWantsRoof(fixed, room) : false;
        wants.set(id, w);
      }
      return w;
    };
    const roomArr = fixed.rooms[level - 1]!;
    for (let r = 0; r < this.n; r++) {
      const y = r >> 1;
      for (let c = 0; c < this.n; c++) {
        const x = c >> 1;
        let roof = false;
        let blocked = false;
        const id = roomArr.u16(x, y);
        if (id === ROOM_DEGENERATE) {
          const d = rooms.resolveDiagonal(x, y, level);
          if (d.room1 !== 0) roof = wantsRoof(d.room1);
          if (!roof && d.room2 !== 0 && d.room1 !== d.room2) roof = wantsRoof(d.room2);
        } else if (id < ROOM_DEGENERATE) {
          roof = wantsRoof(id);
        }
        if (level === 1) {
          if (fixed.floors[1]!.u16(x, y) !== 0) {
            roof = false;
            blocked = true;
          }
          const above = fixed.outOfGrid(x, y) ? 0 : fixed.objects[1]!.s16(x, y);
          if (above !== 0 && objects && hasStairs(fixed, objects, x, y, level)) {
            roof = false;
            blocked = true;
          }
        }
        const o = this.at(r, c);
        this.data[o] = (this.data[o]! & ~(ROOF_ROOFED | ROOF_BLOCKED)) | (roof ? ROOF_ROOFED : 0) | (blocked ? ROOF_BLOCKED : 0);
      }
    }
  }

  /**
   * cRoofLayer::ComputeEaves: a free cell (neither roofed nor blocked) next
   * to a roofed non-eave cell becomes an eave (roofed + 0x04), unless the
   * upper layer roofs it.
   */
  private computeEaves(upper: RoofLayer | null): void {
    const m = this.n - 1;
    for (let r = 1; r < m; r++) {
      for (let c = 1; c < m; c++) {
        if (this.flags(r, c) & (ROOF_ROOFED | ROOF_BLOCKED)) continue;
        const near =
          this.solid(r - 1, c - 1) ||
          this.solid(r - 1, c) ||
          this.solid(r - 1, c + 1) ||
          this.solid(r, c - 1) ||
          this.solid(r, c + 1) ||
          this.solid(r + 1, c - 1) ||
          this.solid(r + 1, c) ||
          this.solid(r + 1, c + 1);
        if (!near || (upper && upper.solid(r, c))) continue;
        this.data[this.at(r, c)]! |= ROOF_ROOFED | ROOF_EAVE;
      }
    }
  }

  /**
   * cRoofLayer::ComputeAltitudes: a roofed cell's altitude is the number of
   * complete roofed rings around it (the square ring of half-width i is
   * walked from its top-left corner, side by side).
   */
  private computeAltitudes(): boolean {
    const n = this.n;
    for (let r = 1; r < n - 1; r++) {
      for (let c = 1; c < n - 1; c++) {
        if (!this.roofed(r, c)) continue;
        let i = 1;
        let side = 2;
        for (let done = false; !done; ) {
          let col = c - i;
          let row = r - i;
          for (let k = 0; k < 4 && !done; k++) {
            for (let s = 0; s < side; s++) {
              if (col < 0 || col >= n || row < 0 || row >= n || !this.roofed(row, col)) {
                done = true;
                break;
              }
              col += RING_DCOL[k]!;
              row += RING_DROW[k]!;
            }
          }
          if (!done) {
            side += 2;
            i++;
          }
        }
        this.data[this.at(r, c) + 1] = (i - 1) & 0xff;
      }
    }
    return true;
  }

  /**
   * cRoofLayer::ComputeTypes: a cell is a ramp when a neighbor is higher or
   * its same-altitude neighbors cover one of the ramp masks, else a cap. An
   * eave that would be a cap loses its roof and the pass stops (false).
   */
  private computeTypes(): boolean {
    const m = this.n - 1;
    for (let r = 1; r < m; r++) {
      for (let c = 1; c < m; c++) {
        if (!this.roofed(r, c)) continue;
        const a = this.alt(r, c);
        let ramp = false;
        let mask = 0;
        for (let k = 0; k < 8; k++) {
          const nr = r + TYPE_DROW[k]!;
          const nc = c + TYPE_DCOL[k]!;
          if (!this.roofed(nr, nc)) continue;
          const b = this.alt(nr, nc);
          if (a === b) mask |= 1 << k;
          else if (a < b) {
            ramp = true;
            break;
          }
        }
        if (mask !== 0 && !ramp) ramp = RAMP_MASKS.some((rm) => (rm & mask) === rm);
        const o = this.at(r, c);
        const f = this.data[o]!;
        if (ramp || (f & ROOF_EAVE) === 0) this.data[o] = ramp ? f | ROOF_RAMP : f & ~ROOF_RAMP;
        else this.data[o] = f & ~ROOF_ROOFED;
        if ((this.data[o]! & ROOF_ROOFED) === 0) return false;
      }
    }
    return true;
  }

  /**
   * cRoofLayer::ComputeStyles: a ramp keeps the style bits of STYLE_KEEP for
   * each lower or unroofed neighbor (from 0xf); a cap gets one bit per
   * same-altitude cap among its first four neighbors.
   */
  private computeStyles(): boolean {
    const m = this.n - 1;
    for (let r = 1; r < m; r++) {
      for (let c = 1; c < m; c++) {
        if (!this.roofed(r, c)) continue;
        const a = this.alt(r, c);
        const o = this.at(r, c);
        let style = 0;
        if (this.data[o]! & ROOF_RAMP) {
          style = 0xf;
          for (let k = 0; k < 8; k++) {
            const nr = r + STYLE_DROW[k]!;
            const nc = c + STYLE_DCOL[k]!;
            if (!this.roofed(nr, nc) || this.alt(nr, nc) < a) style &= STYLE_KEEP[k]!;
          }
        } else {
          for (let k = 0; k < 4; k++) {
            const nr = r + STYLE_DROW[k]!;
            const nc = c + STYLE_DCOL[k]!;
            const f = this.flags(nr, nc);
            if (f & ROOF_ROOFED && (f & ROOF_RAMP) === 0 && this.alt(nr, nc) === a) style |= 1 << k;
          }
        }
        this.data[o] = (this.data[o]! & 0xf) | (style << 4);
      }
    }
    return true;
  }
}

/**
 * Room::WantsRoof: every tile of the room is flat (its four corner
 * altitudes equal, cached in Room +0x76) and the room is not outside
 * (+0x74, the forced-roof flag, is never set).
 */
function roomWantsRoof(fixed: FixedWorld, room: Room): boolean {
  const alt = fixed.alt;
  for (const t of room.tiles) {
    const o = alt.offset(t.x, t.y);
    const d = alt.data;
    if (!(d[o] === d[o + 2] && d[o] === d[o + 1] && d[o] === d[o + 3])) return false;
  }
  return !room.isOutside();
}

/** What DiscoverTilesToRoof needs from the object module: the objects by id. */
export type RoofObjects = () => ReadonlyMap<number, PlacedObject> | null;

/**
 * DiscoverTilesToRoof's ObjectIterator over a tile (the tile's object and
 * its hierarchy: slot 0 = the next object on the tile, other slots =
 * contained objects): any object whose master selector has build mode type 3.
 */
function hasStairs(fixed: FixedWorld, objects: RoofObjects, x: number, y: number, level: number): boolean {
  const objs = objects();
  if (!objs) return false;
  const first = fixed.objects[level - 1]!.s16(x, y);
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
    if (o.selector.getMasterSelector().objd.buildModeType === BUILD_TYPE_STAIRS) return true;
  }
  return false;
}

/** cFixedWorld +0x58 / +0x5c (GetRoofLayer) and what generating them needs. */
export interface RoofLayers {
  readonly layers: readonly [RoofLayer, RoofLayer];
  /** Bumped by every GenerateRoof pass (the renderer rebuilds its meshes). */
  version: number;
  objects: RoofObjects | null;
}

const roofsByWorld = new WeakMap<FixedWorld, RoofLayers>();

/** cFixedWorld::GetRoofLayer for both levels (created with the world, cFixedWorld::SetSize). */
export function roofLayersOf(fixed: FixedWorld): RoofLayers {
  let r = roofsByWorld.get(fixed);
  if (!r) {
    r = { layers: [new RoofLayer(), new RoofLayer()], version: 0, objects: null };
    roofsByWorld.set(fixed, r);
  }
  return r;
}

/** The end of cFixedWorld::ComputeRooms: GenerateRoof(level 2), then GenerateRoof(level 1, layer 1). */
export function generateRoofs(fixed: FixedWorld, rooms: RoomManager): void {
  const r = roofLayersOf(fixed);
  r.layers[1].generateRoof(fixed, rooms, 2, null, r.objects);
  r.layers[0].generateRoof(fixed, rooms, 1, r.layers[1], r.objects);
  r.version++;
}

// --- cRoofMeshFactory ---------------------------------------------------------------

/**
 * One AddFace: three vertices (x, y / pitch, z) and their texture
 * coordinates. The y values are multiples of the pitch: BuildRamp's
 * lbl_105BC7D4[2] * pitch = 1.5 * pitch, BuildCap's [1] * [2] * pitch =
 * 0.75 * pitch; the cell is 1.5 x 1.5 world units.
 */
type Face = readonly [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];

const H = 1.5;
const C = 0.75;
/** BuildRamp(3 / 4 / 9 / other) (lbl_105C1A58..lbl_105C1BA0). */
const RAMPS: Readonly<Record<number, readonly Face[]>> = {
  3: [
    [0, 0, 0, 1, 1, 1.5, H, 1.5, 0, 0, 1.5, H, 0, 1, 0],
    [0, 0, 0, 1, 1, 0, 0, 1.5, 0, 1, 1.5, H, 1.5, 0, 0],
  ],
  4: [
    [0, 0, 0, 0, 1, 0, H, 1.5, 0, 0, 1.5, 0, 0, 1, 1],
    [1.5, 0, 0, 0, 1, 0, H, 1.5, 1, 0, 1.5, 0, 1.5, 1, 1],
  ],
  9: [
    [0, H, 0, 0, 1, 0, 0, 1.5, 1, 0.5, 1.5, H, 1.5, 0, 0],
    [0, H, 0, 0, 0, 1.5, H, 1.5, 0, 1, 1.5, 0, 0, 1, 0.5],
  ],
  13: [
    [0, H, 0, 0, 0, 0, H, 1.5, 1, 0, 1.5, 0, 0, 0, 1],
    [0, H, 1.5, 0, 0, 1.5, H, 1.5, 1, 0, 1.5, 0, 0, 1, 1],
  ],
};
/** BuildCap(0 / 9 / 8 / 10 / 14 / other) (lbl_105C15B4..). */
const CAPS: Readonly<Record<number, readonly Face[]>> = {
  0: [
    [0, 0, 0, 1, 1, 0, 0, 1.5, 1, 0, C, C, C, 0.5, 0.5],
    [0, 0, 0, 0, 1, C, C, C, 0.5, 0.5, 1.5, 0, 0, 1, 1],
    [1.5, 0, 0, 0, 1, C, C, C, 0.5, 0.5, 1.5, 0, 1.5, 1, 1],
    [0, 0, 1.5, 1, 1, 1.5, 0, 1.5, 0, 1, C, C, C, 0.5, 0.5],
  ],
  9: [
    [0, 0, 0, 0, 1, 0, C, C, 0, 0.5, 1.5, C, C, 1, 0.5],
    [0, 0, 0, 0, 1, 1.5, C, C, 1, 0.5, 1.5, 0, 0, 1, 1],
    [0, C, C, 1, 0.5, 0, 0, 1.5, 1, 1, 1.5, C, C, 0, 0.5],
    [0, 0, 1.5, 1, 1, 1.5, 0, 1.5, 0, 1, 1.5, C, C, 0, 0.5],
  ],
  8: [
    [0, 0, 0, 0, 1, 0, C, C, 0, 0.5, C, C, C, 0.5, 0.5],
    [0, 0, 0, 0, 1, C, C, C, 0.5, 0.5, 1.5, 0, 0, 1, 1],
    [1.5, 0, 0, 0, 1, C, C, C, 0.5, 0.5, 1.5, 0, 1.5, 1, 1],
    [0, 0, 1.5, 1, 1, C, C, C, 0.5, 0.5, 0, C, C, 1, 0.5],
    [0, 0, 1.5, 1, 1, 1.5, 0, 1.5, 0, 1, C, C, C, 0.5, 0.5],
  ],
  10: [
    [0, 0, 0, 0, 1, 0, C, C, 0, 0.5, 1.5, 0, 0, 1, 1],
    [1.5, 0, 0, 1, 1, 0, C, C, 0, 0.5, C, C, C, 0.5, 0.5],
    [1.5, 0, 0, 0, 1, C, C, C, 0.5, 0.5, 1.5, 0, 1.5, 1, 1],
    [C, C, C, 0.5, 0.5, 0, C, C, 1, 0.5, 0, 0, 1.5, 1, 1],
    [C, C, C, 0.5, 0.5, 0, 0, 1.5, 0, 1, C, C, 1.5, 0, 0.5],
    [C, C, C, 0.5, 0.5, C, C, 1.5, 1, 0.5, 1.5, 0, 1.5, 1, 1],
  ],
  14: [
    [0, 0, 0, 1, 1, C, C, C, 0.5, 0.5, C, C, 0, 1, 0.5],
    [0, 0, 0, 0, 1, 0, C, C, 0, 0.5, C, C, C, 0.5, 0.5],
    [0, C, C, 1, 0.5, 0, 0, 1.5, 1, 1, C, C, C, 0.5, 0.5],
    [0, 0, 1.5, 0, 1, C, C, 1.5, 0, 0.5, C, C, C, 0.5, 0.5],
    [C, C, 0, 0, 0.5, C, C, 1.5, 1, 0.5, 1.5, 0, 1.5, 1, 1],
    [C, C, 0, 0, 0.5, 1.5, 0, 1.5, 1, 1, 1.5, 0, 0, 0, 1],
  ],
  15: [
    [0, 0, 0, 0, 1, 0, C, C, 0, 0.5, C, C, C, 0.5, 0.5],
    [0, C, C, 1, 0.5, 0, 0, 1.5, 1, 1, C, C, C, 0.5, 0.5],
    [C, C, C, 0.5, 0.5, 0, 0, 1.5, 0, 1, C, C, 1.5, 0, 0.5],
    [C, C, C, 0.5, 0.5, C, C, 1.5, 1, 0.5, 1.5, 0, 1.5, 1, 1],
    [C, C, C, 0.5, 0.5, 1.5, 0, 1.5, 0, 1, 1.5, C, C, 0, 0.5],
    [C, C, C, 0.5, 0.5, 1.5, C, C, 1, 0.5, 1.5, 0, 0, 1, 1],
    [C, C, 0, 0, 0.5, C, C, C, 0.5, 0.5, 1.5, 0, 0, 0, 1],
    [0, 0, 0, 1, 1, C, C, C, 0.5, 0.5, C, C, 0, 1, 0.5],
  ],
};

/** lbl_105BC7C0: (BuildRamp mesh, quarter turns) by ramp style. */
const RAMP_BY_STYLE: ReadonlyArray<readonly [number, number]> = [
  [255, 255], [4, 1], [4, 2], [3, 0], [4, 0], [3, 3], [9, 1], [13, 1],
  [4, 3], [9, 0], [3, 1], [13, 2], [3, 2], [13, 0], [13, 3], [255, 255],
];
/** lbl_105BC7C4: (BuildCap mesh, quarter turns) by cap style. */
const CAP_BY_STYLE: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [8, 2], [8, 1], [10, 1], [8, 3], [10, 2], [9, 1], [14, 2],
  [8, 0], [9, 0], [10, 0], [14, 1], [10, 3], [14, 3], [14, 0], [15, 0],
];

/**
 * cRoofMeshFactory::GetRoofMesh: the faces of a roof tile and the quarter
 * turns RenderRoofPolys applies (cRoofTile::RotateRamp / RotateCap with 0
 * turns leave the style as is). Build: keys below 0x100 are BuildRamp (any
 * key other than 3, 4 and 9 builds mesh 13), the others BuildCap(key -
 * 0x100) (any other than 0, 8, 9, 10 and 14 builds mesh 15).
 */
export function getRoofMesh(flags: number): { faces: readonly Face[]; turns: number } {
  const style = flags >> 4;
  if (flags & ROOF_RAMP) {
    const [mesh, turns] = RAMP_BY_STYLE[style]!;
    return { faces: RAMPS[mesh] ?? RAMPS[13]!, turns };
  }
  const [mesh, turns] = CAP_BY_STYLE[style]!;
  return { faces: CAPS[mesh] ?? CAPS[15]!, turns };
}

/** cRoofMeshFactory::GetTileHeight: lbl_105BC7D4[0] * pitch * [1] = 1.5 * pitch per roof altitude step. */
export function roofTileHeight(pitch: number): number {
  return Math.fround(Math.fround(3 * pitch) * 0.5);
}
