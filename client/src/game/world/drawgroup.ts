/**
 * DrawGroup (DGRP chunk): the sprite lists of one object graphic, one list per
 * (direction bit, zoom). Ported from DrawGroup::Load / ReadOldVersion /
 * GetItemList and the DrawGroupItemList / DrawGroupItem container streams.
 *
 * The chunk is a plain (uncompressed) ReconBuffer starting with a 16-bit
 * version. Versions >= 20003 store `count` DrawGroupItemLists (direction
 * flags, zoom, items); older ones store lists of typed records of which only
 * type -3 (a sprite) is kept.
 */

import { ReconBuffer } from "./reconbuffer.js";

/** DrawGroupItem (0x20 bytes): one sprite of an item list. */
export interface DrawGroupItem {
  /** [0] SPR2 chunk id in the object's IFF. */
  sprId: number;
  /** [1] frame within that SPR2. */
  frame: number;
  /** [2] / [3] pixel offsets added to the screen position. */
  xOff: number;
  yOff: number;
  /** [4] object z offset (tiles of height), [5] / [6] object x / y offsets (tiles). */
  objZ: number;
  objX: number;
  objY: number;
  /** [7] flags (DrawShape's flag byte: bit 0 = horizontally mirrored). */
  flags: number;
}

/** DrawGroupItemList (0x14 bytes). */
export interface DrawGroupItemList {
  /** +0xc: one bit per direction (bit (rotation * 2 + object direction) & 7). */
  dirFlags: number;
  /** +0x10: zoom level the list is drawn at (RenderParam scale). */
  zoom: number;
  items: DrawGroupItem[];
}

/** Item lists of versions before 20003 hold typed records; -3 is a sprite. */
const OLD_SPRITE_RECORD = -3;
/** First version written as container streams. */
const VERSION_CONTAINER = 20003;
/** Versions above this one carry the object x / y offsets. */
const VERSION_XY_OFFSETS = 20003;
/** Old versions above this one carry a z offset per record. */
const VERSION_OLD_Z = 20000;

export class DrawGroup {
  constructor(
    /** DGRP chunk id. */
    readonly id: number,
    /** Stream version (first 16-bit value). */
    readonly version: number,
    readonly lists: DrawGroupItemList[],
  ) {}

  /** DrawGroup::Load from the chunk payload. */
  static load(id: number, payload: Uint8Array): DrawGroup {
    const buf = new ReconBuffer(payload);
    const version = buf.recon16();
    const lists = version < VERSION_CONTAINER ? readOldVersion(buf, version) : readLists(buf, version);
    return new DrawGroup(id, version, lists);
  }

  /** DrawGroup::GetItemList: the first list with the direction bit set at this zoom. */
  getItemList(dirIndex: number, zoom: number): DrawGroupItemList | null {
    const bit = 1 << (dirIndex & 7);
    for (const l of this.lists) if (l.dirFlags & bit && l.zoom === zoom) return l;
    return null;
  }
}

/** DrawGroup::ReadOldVersion. */
function readOldVersion(buf: ReconBuffer, version: number): DrawGroupItemList[] {
  const lists: DrawGroupItemList[] = [];
  const nLists = buf.recon16();
  for (let i = 0; i < nLists; i++) {
    const nRecords = buf.recon16();
    const dirFlags = buf.recon8();
    const zoom = buf.recon8();
    const items: DrawGroupItem[] = [];
    for (let k = 0; k < nRecords; k++) {
      const type = buf.recon16();
      const sprId = buf.recon16();
      const frame = buf.recon16();
      const flags = buf.recon16();
      const xOff = buf.recon16();
      const yOff = buf.recon16();
      const objZ = version > VERSION_OLD_Z ? buf.reconFloat() : 0;
      if (type === OLD_SPRITE_RECORD) items.push({ sprId, frame, xOff, yOff, objZ, objX: 0, objY: 0, flags });
    }
    lists.push({ dirFlags, zoom, items });
  }
  return lists;
}

/** DoContainerStream<vector<DrawGroupItemList>> + DrawGroupItemList::DoStream. */
function readLists(buf: ReconBuffer, version: number): DrawGroupItemList[] {
  const lists: DrawGroupItemList[] = [];
  const nLists = buf.recon32();
  for (let i = 0; i < nLists; i++) {
    const dirFlags = buf.recon32();
    const zoom = buf.recon32();
    const items: DrawGroupItem[] = [];
    const nItems = buf.recon32();
    for (let k = 0; k < nItems; k++) {
      const sprId = buf.recon32();
      const frame = buf.recon32();
      const xOff = buf.recon32();
      const yOff = buf.recon32();
      const objZ = buf.reconFloat();
      const flags = buf.recon32();
      let objX = 0;
      let objY = 0;
      if (version > VERSION_XY_OFFSETS) {
        objX = buf.reconFloat();
        objY = buf.reconFloat();
      }
      items.push({ sprId, frame, xOff, yOff, objZ, objX, objY, flags });
    }
    lists.push({ dirFlags, zoom, items });
  }
  return lists;
}
