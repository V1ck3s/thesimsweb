/**
 * The lot side of the sound system while a lot is loaded:
 *  - cAudioInfo over the lot view (HouseViewer = GViewer, cRotatableWorld)
 *    and the simulator (globals, ObjectModule objects);
 *  - the sound primitives (cXObject::TryPlaySound / TryKillSounds) through
 *    SimModule.soundHooks;
 *  - cSoundPlayer::NotifyViewChange when the view scrolls, zooms or rotates
 *    (HouseViewer::UpdateWorld's scroll branch, CPState::SetZoom / ZoomIn /
 *    ZoomOut, HouseViewer::SetRotation) and NotifyHourChange on the hour
 *    (cSimsApp::DoCommand's clock command when the minute is 0). The
 *    original calls them from those places; here the view and the clock are
 *    watched every 50 ms instead.
 */

import type { Behavior } from "../sim/behavior.js";
import { PDX, type PersonSim } from "../sim/person.js";
import { G, type Simulator } from "../sim/simulator.js";
import type { HouseViewer } from "../world/houseviewer.js";
import type { RoomManager } from "../world/rooms.js";
import { RotatableWorld } from "../world/world.js";
import { setAudioInfo, type AudioInfoSource, type AudioScreenCoord, type AudioWorldCoord } from "./audioinfo.js";
import { soundPlayer } from "./soundplayer.js";

/** What the lot view hands over (WinLotView's viewer and simulator). */
export interface LotAudioView {
  viewer: HouseViewer | null;
  sim: Simulator | null;
  rooms: RoomManager | null;
}

/** World tile flag 0x04: outside (cFixedWorld::ComputeRooms' flood from (0, 0)). */
const FLAG_OUTSIDE = 4;

/** SoundInfo::GetInfo: the FWAV chunk `id` of a resource file, a C string (the event name). */
function soundInfo(file: { get(kind: string, id: number): Uint8Array | null } | null, id: number): string | null {
  const b = file?.get("FWAV", id);
  if (!b) return null;
  const end = b.indexOf(0);
  return new TextDecoder("latin1").decode(b.subarray(0, end < 0 ? b.length : end));
}

class LotAudioInfo implements AudioInfoSource {
  constructor(private readonly view: LotAudioView) {}

  private get viewer(): HouseViewer | null {
    return this.view.viewer;
  }

  lotNumber(): number {
    return this.view.sim?.globals[G.houseNumber] ?? 0;
  }

  simSpeed(): number {
    return this.view.sim?.globals[G.speed] ?? 0;
  }

  objectPosition(id: number): AudioWorldCoord | null {
    const o = id > 0 ? this.view.sim?.module.getObject(id) : null;
    return o ? { x: Math.trunc(o.obj.fx), y: Math.trunc(o.obj.fy), level: o.obj.level } : null;
  }

  objectData(id: number, index: number): number {
    const sim = this.view.sim;
    if (index === 4) return sim?.globals[G.hour] ?? 0;
    const o = id > 0 ? sim?.module.getObject(id) : null;
    if (!o) return index === 13 ? 100 : 0;
    if (index === 13) {
      // Room::GetArea of RoomManager::GetRoom(object +0x84): the room under the object.
      const level = o.obj.level;
      const id2 = this.view.viewer?.world.fixed.rooms[level - 1]?.u16(o.obj.fx >> 4, o.obj.fy >> 4) ?? 0;
      const room = this.view.rooms?.getRoom(id2) ?? null;
      return room ? room.tiles.length : 100;
    }
    if (!o.isPerson) return 0;
    const pd = (o as PersonSim).pd;
    const d10 = (i: number): number => Math.trunc(pd[i]! / 10);
    switch (index) {
      case 0:
        if ((pd[0x4a]! & 0xc) !== 0) return 1000;
        return pd[PDX.personAge]! < 0xc ? 2 : pd[PDX.gender]!;
      case 1:
        return pd[PDX.personAge]!;
      case 2:
        return d10(0xa);
      case 3:
        return d10(9);
      case 5:
        return d10(0xf);
      case 6:
        return d10(0xb);
      case 7:
        return d10(0xc);
      case 11:
        return d10(0x11);
      case 12:
        return d10(0x12);
      case 14:
        return Math.trunc((o as PersonSim).motives[3]! / 10);
      default:
        return index >= 15 && index <= 20 ? d10(index - 13) : 0;
    }
  }

  worldToScreen(c: AudioWorldCoord): AudioScreenCoord {
    const v = this.viewer;
    if (!v) return { h: 0, v: 0 };
    const [rx, ry] = RotatableWorld.rotateCoords(c.x, c.y, v.world.rotation, 0x400);
    return v.tileToPointF(rx, ry, c.level);
  }

  screenBottomRight(): AudioScreenCoord {
    const v = this.viewer;
    return v ? { h: v.viewW, v: v.viewH } : { h: 1, v: 1 };
  }

  viewerLevel(): number {
    return this.viewer?.level ?? 1;
  }

  zoomLevel(): number {
    return this.viewer?.scale ?? 3;
  }

  /**
   * cAudioInfo::OutdoorTileRatio: walk the screen in tile steps from the
   * tile under its top-left corner (GViewer::PointToTile at level 1, the flat
   * projection), one column per tile width (x + 1, y - 1), one row per half
   * tile height (x or y + 1 alternately), counting interior tiles of the
   * viewer's level with and without the outside flag.
   */
  outdoorTileRatio(): number {
    const v = this.viewer;
    if (!v) return 0;
    const s = v.scale;
    const hx = Math.trunc((0 - v.originX) / 2);
    const vy = 0 - v.originY;
    let a = (hx + vy) >> (s + 3);
    let b = (vy - hx) >> (s + 3);
    const level = v.level;
    const rows = Math.trunc(v.viewH / (4 << s));
    const cols = Math.trunc(v.viewW / (0x10 << s));
    let outside = 0;
    let inside = 0;
    for (let row = 0; row < rows; row++) {
      let x = a;
      let y = b;
      for (let col = 0; col < cols; col++) {
        if (v.world.inInterior(x, y)) {
          if (v.world.getFlags(x, y, level) & FLAG_OUTSIDE) outside++;
          else inside++;
        }
        x++;
        y--;
      }
      a += row & 1;
      b += (row + 1) & 1;
    }
    return inside + outside === 0 ? 0 : Math.trunc((100 * outside) / (inside + outside));
  }
}

/**
 * Hook the sound system to a loaded lot; returns the teardown (lot unload).
 * Also sends the first NotifyViewChange once the view exists.
 */
export function installLotAudio(view: LotAudioView): () => void {
  setAudioInfo(new LotAudioInfo(view));
  const hooks = {
    /** cXObject::TryPlaySound */
    playSound(behavior: Behavior | null, soundId: number, source: number): void {
      const name = soundInfo(behavior?.priv ?? null, soundId) ?? soundInfo(behavior?.glob ?? null, soundId);
      if (name) soundPlayer.playBySource(name, source);
    },
    /** cXObject::TryKillSounds */
    killSounds(source: number): void {
      soundPlayer.quietBySourceID(source);
    },
  };
  let hookedModule: Simulator["module"] | null = null;
  let lastView = "";
  let lastHour = -1;
  const poll = (): void => {
    const sim = view.sim;
    if (sim?.module && sim.module !== hookedModule) {
      hookedModule = sim.module;
      hookedModule.soundHooks = hooks;
    }
    const v = view.viewer;
    if (v) {
      const sig = `${v.originX},${v.originY},${v.scale},${v.world.rotation}`;
      if (sig !== lastView) {
        lastView = sig;
        soundPlayer.notifyViewChange();
      }
    }
    if (sim) {
      const hour = sim.globals[G.hour]!;
      if (lastHour !== -1 && hour !== lastHour) soundPlayer.notifyHourChange();
      lastHour = hour;
    }
  };
  poll();
  const timer = window.setInterval(poll, 50);
  return () => {
    window.clearInterval(timer);
    if (hookedModule) hookedModule.soundHooks = null;
    setAudioInfo(null);
  };
}
