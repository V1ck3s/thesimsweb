/**
 * DynamicCutaway: the HouseViewer's dynamic cutaway (the "cutaway" wall
 * state). The rooms under the mouse cursor are remembered in a small MRU set
 * (cCutawaySet, 3 rooms); DoDynamicCutaway ORs their cutaway matrices
 * (Room::ComputeCutawayMatrix) with the selected sim's room into the
 * HouseViewer+0x204 BitMatrix64, which WallManager::ComputeCutaway then uses
 * to cut the walls of the current level. When a cut room is outside, a 4x4
 * block of tiles in front of the cursor (and of an outside sim) is cut
 * instead.
 *
 * The mask lives in WallManager.cutawayMask; every change bumps maskVersion.
 *
 * Not ported: the held object hook (lbl_105BA4A8, buy-mode placement) and
 * ScrollingStrategy::IsWaitingForClick (assumed false). PointToTile(Point,
 * true) is approximated by HouseViewer.pointToWholeTile.
 */

import { Mode, WallState } from "../cpstate.js";
import type { HouseViewer } from "./houseviewer.js";
import type { RoomManager } from "./rooms.js";
import { ROOM_DEGENERATE } from "./rooms.js";
import type { WallManager } from "./walls.js";
import { DIRS } from "./world.js";

/** A person the cutaway follows: world tile and level (cXObject +0xfc..+0xfe). */
export interface CutawayPerson {
  x: number;
  y: number;
  level: number;
}

export interface CutawayHooks {
  /** CPState::GetMode. */
  mode(): Mode;
  /** ObjectModule::GetSelectedPerson. */
  selectedPerson(): CutawayPerson | null;
  /** Last mouse position in view coordinates, null when the cursor is not over the window. */
  cursor(): { x: number; y: number } | null;
}

/** cCutawaySet capacity (HouseViewer constructor). */
const CUTAWAY_SET_SIZE = 3;

export class DynamicCutaway {
  /** +0x1f8: the last DoDynamicCutaway rebuilt the mask from the cutaway set. */
  private valid = false;
  /** +0x1fc cCutawaySet: room ids, most recent first. */
  private readonly set: number[] = [];

  constructor(
    private readonly viewer: HouseViewer,
    private readonly walls: WallManager,
    private readonly rooms: RoomManager,
    private readonly hooks: CutawayHooks,
  ) {}

  /** cCutawaySet::insert: move-to-front, dropping the oldest room when full. */
  private insert(id: number): void {
    if (this.set.includes(id)) return;
    if (this.set.length === CUTAWAY_SET_SIZE) this.set.pop();
    this.set.unshift(id);
  }

  private markChanged(): void {
    this.walls.maskVersion++;
    this.viewer.dirty = true;
  }

  /** HouseViewer::DoDynamicCutaway(rebuild). */
  doDynamicCutaway(rebuild: boolean): void {
    if (!this.walls.dynamicCutaway) return;
    const v = this.viewer;
    const w = v.world;
    const mask = this.walls.cutawayMask;
    const old = mask.bits.slice();
    let outside = false;
    if (rebuild) {
      mask.clear();
      for (const id of this.set) {
        const room = this.rooms.getRoom(id & 0xffff);
        if (!room) continue;
        or(mask.bits, room.cutaway.bits);
        if (room.isOutside()) outside = true;
      }
    }
    const size = w.size;
    if (this.hooks.mode() === Mode.Live) {
      const p = this.hooks.selectedPerson();
      const id = p ? w.fixed.rooms[p.level - 1]?.u16(p.x, p.y) : undefined;
      if (p && id !== undefined && p.level === v.level && id < ROOM_DEGENERATE) {
        const room = this.rooms.getRoom(id);
        if (room) {
          or(mask.bits, room.cutaway.bits);
          if (room.isOutside()) {
            outside = true;
            if (p.x >= 1 && p.x < size - 1 && p.y >= 1 && p.y < size - 1) {
              const [px, py] = w.toView(p.x, p.y);
              // The largest k <= 4 with (p + (k, k)) in bounds, then the k x k block from p.
              let k = 4;
              for (let n = 5; n > 0 && !w.inBounds(px + k, py + k); n--) k--;
              this.cutRect(px, py, px + k, py + k);
            }
          }
        }
      }
    }
    const c = this.hooks.cursor();
    if (c && c.x >= 0 && c.y >= 0) {
      const s = v.scale;
      const t = v.pointToWholeTile(c.x, c.y + (8 << s) * 4, v.level);
      let tx = t.x;
      let ty = t.y;
      let ax = tx - 4;
      let ay = ty - 4;
      // dir 4 is (-1, -1), dir 5 (+1, +1).
      while (!w.inBounds(tx, ty) && (tx !== ax || ty !== ay)) {
        tx += DIRS[4]![0];
        ty += DIRS[4]![1];
      }
      while (!w.inBounds(ax, ay) && (tx !== ax || ty !== ay)) {
        ax += DIRS[5]![0];
        ay += DIRS[5]![1];
      }
      if (outside && w.inBounds(ax, ay)) this.cutRect(ax, ay, tx, ty);
      // The held object (lbl_105BA4A8) would adjust the point and add its own tiles here: not ported.
    }
    let changed = false;
    for (let i = 0; i < old.length; i++) {
      if (old[i] !== mask.bits[i]) {
        changed = true;
        break;
      }
    }
    if (changed) this.markChanged();
    this.valid = rebuild;
  }

  /** CTileRect [x0, x1) x [y0, y1), tiles inside the lot only. */
  private cutRect(x0: number, y0: number, x1: number, y1: number): void {
    const w = this.viewer.world;
    const mask = this.walls.cutawayMask;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (w.inBounds(x, y)) mask.set(x, y);
  }

  /** HouseViewer::ResetDynamicCutaway. */
  resetDynamicCutaway(): void {
    this.walls.cutawayMask.clear();
    this.valid = false;
    this.markChanged();
  }

  /**
   * HouseViewer::MouseTrack's cutaway part: the room under the cursor and
   * the first different room found below it within half a level height
   * (the room whose walls stand in front of the cursor) join the cutaway set.
   */
  mouseTrack(x: number, y: number): void {
    const v = this.viewer;
    if (x < 0 || y < 0 || x > v.viewW || y > v.viewH) return;
    if (!this.walls.dynamicCutaway) return;
    const w = v.world;
    const t = v.pointToWholeTile(x, y, v.level);
    if (!w.inInterior(t.x, t.y)) {
      this.resetDynamicCutaway();
      return;
    }
    const room0 = w.getRoom(t.x, t.y, v.level);
    let room2 = room0;
    const step = (8 << v.scale) / 2;
    for (let d = step; d < v.levelPx() / 2; d += step) {
      const t2 = v.pointToWholeTile(x, y + d, v.level);
      if (w.inInterior(t2.x, t2.y)) room2 = w.getRoom(t2.x, t2.y, v.level);
      if (room2 !== room0) break;
    }
    if (room0 < ROOM_DEGENERATE) this.insert(room0);
    if (room2 < ROOM_DEGENERATE) this.insert(room2);
    this.doDynamicCutaway(true);
  }

  /** cTSWinMgrW95::PumpMouseMoveMsg: replay the last mouse position. */
  private pumpMouseMove(): void {
    const c = this.hooks.cursor();
    if (c) this.mouseTrack(c.x, c.y);
  }

  /** HouseViewer::SetCutaway (walls down). */
  setCutaway(on: boolean): void {
    if (this.walls.cutaway === on) return;
    this.walls.cutaway = on;
    if (this.walls.dynamicCutaway) {
      this.resetDynamicCutaway();
      this.walls.dynamicCutaway = false;
    }
    this.viewer.dirty = true;
  }

  /** HouseViewer::SetDynamicCutaway. */
  setDynamicCutaway(on: boolean): void {
    if (this.walls.dynamicCutaway === on) return;
    this.walls.dynamicCutaway = on;
    this.walls.cutaway = false;
    this.set.length = 0;
    this.walls.cutawayMask.clear();
    this.markChanged();
    this.doDynamicCutaway(this.valid);
  }

  /** CPState::SetWallState's HouseViewer calls. */
  setWallState(state: WallState): void {
    if (state === WallState.Roof) {
      this.walls.drawRoof = true;
    } else {
      this.setCutaway(state === WallState.Down);
      this.setDynamicCutaway(state === WallState.Cutaway);
      this.walls.drawRoof = false;
    }
    this.viewer.dirty = true;
    this.pumpMouseMove();
  }

  /** HouseViewer::SetLevel's cutaway part (the level is already changed). */
  onLevel(_old: number): void {
    this.set.length = 0;
    if (this.walls.dynamicCutaway) this.resetDynamicCutaway();
    this.rooms.computeCutaway(this.viewer, this.viewer.level);
    if (this.walls.dynamicCutaway) this.doDynamicCutaway(this.valid);
    this.pumpMouseMove();
  }

  /** HouseViewer::SetRotation's cutaway part: view coordinates changed, recompute the matrices. */
  onRotation(): void {
    this.rooms.computeCutaway(this.viewer, this.viewer.level);
    if (this.walls.dynamicCutaway) this.doDynamicCutaway(this.valid);
    this.pumpMouseMove();
  }

  /** HouseViewer::SetScale's cutaway part. */
  onScale(): void {
    if (this.walls.dynamicCutaway) this.doDynamicCutaway(this.valid);
    this.pumpMouseMove();
  }

  /** CPState::UpdateWorldFromCPState (mode change, bit 2). */
  onModeChange(): void {
    this.doDynamicCutaway(this.valid);
  }

  /** HouseViewer::DoCommand(0xf0) + PrepareWorldForUpdate: the rooms were recomputed. */
  onRoomsChanged(): void {
    this.set.length = 0;
    this.doDynamicCutaway(this.valid);
  }

  /** HouseViewer::UpdateWorld: follow a selected sim who stands outside every frame. */
  updateWorld(): void {
    if (!this.walls.dynamicCutaway) return;
    const p = this.hooks.selectedPerson();
    const f = this.viewer.world.fixed;
    if (!p || p.x < 1 || p.x >= f.size - 1 || p.y < 1 || p.y >= f.size - 1) return;
    if ((f.flags[p.level - 1]!.u8(p.x, p.y) & 4) !== 0) this.doDynamicCutaway(this.valid);
  }

  /** Room ids in the cutaway set (debugging). */
  cutawaySet(): readonly number[] {
    return this.set;
  }
}

function or(dst: Uint8Array, src: Uint8Array): void {
  for (let i = 0; i < dst.length; i++) dst[i] = dst[i]! | src[i]!;
}
