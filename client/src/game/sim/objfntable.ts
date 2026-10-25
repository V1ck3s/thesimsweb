/**
 * ObjFnTable (ObjFnTable.cpp): an object definition's entry points, one
 * ObjFunction { +0 action tree, +2 check tree } per ObjEntryPoint.
 *
 * ObjSelector::GetFnTable loads the "OBJf" chunk whose id is the OBJD's
 * (ReconLoadObject: Recon header, then a count and, per entry, the check tree
 * then the action tree); without one (-0x62) BuildFromOldEntries copies the
 * tree ids stored in the OBJD itself.
 */

import { ReconBuffer } from "../world/reconbuffer.js";
import type { ObjSelector } from "../world/objselector.js";

/** ObjEntryPoint (Behavior.iff STR# 245 "entry points"). */
export const EP = {
  init: 0,
  main: 1,
  load: 2,
  cleanup: 3,
  queueSkipped: 4,
  allowIntersection: 5,
  wallAdjacencyChanged: 6,
  roomChanged: 7,
  dynamicMultiTileUpdate: 8,
  placement: 9,
  pickup: 10,
  userPlacement: 11,
  userPickup: 12,
  levelInfoRequest: 13,
  servingSurface: 14,
  portal: 15,
  gardening: 16,
  washHands: 17,
  prepareFood: 18,
  cook: 19,
  placeOnSurface: 20,
  dispose: 21,
  eat: 22,
  pickupFromSlot: 23,
  washDish: 24,
  eatingSurface: 25,
  sit: 26,
  stand: 27,
  clean: 28,
  repair: 29,
} as const;

/** OBJD byte offsets BuildFromOldEntries reads, by entry point. */
const OLD_ENTRIES = [
  0x56, 0x0a, 0x5e, 0x68, 0x78, 0x2a, 0x7c, 0x64, 0x9c, 0x58, 0x94, 0x60, 0x5a, 0x6a, 0x6e, 0x22, 0x0c, 0x18, 0x30, 0x32, 0x34, 0x36,
  0x38, 0x3a, 0x3c, 0x3e, 0x40, 0x42, 0x76, 0xa0,
] as const;

export class ObjFnTable {
  /** ObjFunction: [action tree, check tree]. */
  readonly fns: Array<[number, number]> = [];

  /** ObjFnTable::GetTreeID (the action tree; 0 = none). */
  getTreeID(ep: number): number {
    return this.fns[ep]?.[0] ?? 0;
  }

  /** The check tree (+2) of an entry point. */
  getCheckTreeID(ep: number): number {
    return this.fns[ep]?.[1] ?? 0;
  }

  /** ObjSelector::GetFnTable. */
  static forSelector(sel: ObjSelector): ObjFnTable {
    let t = cache.get(sel);
    if (!t) {
      t = new ObjFnTable();
      const payload = sel.res.get("OBJf", sel.objdId);
      if (payload) {
        const { buf } = ReconBuffer.fromChunk(payload);
        const n = buf.recon32();
        for (let i = 0; i < n; i++) {
          const check = buf.recon16();
          const action = buf.recon16();
          t.fns.push([action, check]);
        }
      } else {
        for (const o of OLD_ENTRIES) t.fns.push([sel.objd.i16(o), 0]);
      }
      cache.set(sel, t);
    }
    return t;
  }
}

const cache = new WeakMap<ObjSelector, ObjFnTable>();
