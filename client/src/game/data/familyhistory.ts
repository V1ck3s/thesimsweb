/**
 * FamilyHistory (FAMh chunk, one per family, chunk id = the family id): the
 * vector of FamilyStat that Neighborhood::AddFamilyHistoryStat appends at
 * every midnight, at most 0x400 (AddNewStat drops the oldest first).
 *
 * FamilyHistory::DoStream: a ReconBool "compressed" (written true, then
 * ReconBuffer::EnableCompression), then DoContainerStream: a Recon32 count
 * and FamilyStat::DoStream per entry. ReconSaveObject writes version 1.
 *
 * FamilyStat (0x54 bytes), in stream (and DumpToFile column) order: 8
 * shorts (+0..+0xe), 2 ints (+0x10, +0x14; 16-bit below version 1), 7 shorts
 * (+0x18..+0x24), 6 ints (+0x28..+0x3c; 16-bit below version 1), 2 ints
 * (+0x40, +0x44), 5 shorts (+0x48..+0x50).
 */

import { ReconBuffer } from "../world/reconbuffer.js";
import { compactRecon, type ReconOut } from "../world/reconwriter.js";

/** FamilyStat fields in stream order (30 values). */
export type FamilyStat = Int32Array;

export const FAMILY_STAT_FIELDS = 30;

/** Field widths in stream order: 16 = short, 32 = int, "v" = int (16-bit below version 1). */
const LAYOUT: ReadonlyArray<16 | 32 | "v"> = [
  16, 16, 16, 16, 16, 16, 16, 16,
  "v", "v",
  16, 16, 16, 16, 16, 16, 16,
  "v", "v", "v", "v", "v", "v",
  32, 32,
  16, 16, 16, 16, 16,
];

/** FamilyHistory::AddNewStat: at 0x400 entries the first one goes. */
const MAX_STATS = 0x400;

/** The FAMh chunk tag (ReconSaveObject<FamilyHistory>, 0x46414d68). */
const TAG = "FAMh";
const VERSION = 1;

/** ReconLoadObject<FamilyHistory>: the chunk payload's stats. */
export function parseFamilyHistory(payload: Uint8Array): FamilyStat[] {
  const { buf, version } = ReconBuffer.fromChunk(payload);
  if (buf.reconBool()) buf.enableCompression();
  const n = buf.recon32();
  const out: FamilyStat[] = [];
  for (let i = 0; i < n; i++) {
    const s = new Int32Array(FAMILY_STAT_FIELDS);
    LAYOUT.forEach((w, k) => {
      s[k] = w === 32 || (w === "v" && version >= 1) ? buf.recon32() : buf.recon16();
    });
    out.push(s);
  }
  return out;
}

/** ReconSaveObject<FamilyHistory>(version 1): the chunk payload. */
export function serializeFamilyHistory(stats: readonly FamilyStat[]): Uint8Array {
  return compactRecon(VERSION, TAG, (w: ReconOut) => {
    w.reconBool(true);
    w.enableCompression();
    w.recon32(stats.length);
    for (const s of stats) {
      LAYOUT.forEach((width, k) => {
        if (width === 16) w.recon16(s[k]!);
        else w.recon32(s[k]!);
      });
    }
  });
}

/** FamilyHistory::AddNewStat. */
export function addNewStat(stats: FamilyStat[], stat: FamilyStat): void {
  if (stats.length > MAX_STATS - 1) stats.shift();
  stats.push(stat);
}

/** The Family fields holding its history: +0x140 the FAMh chunk read by LoadFamily, +0x144 the loaded history. */
export interface FamilyHistoryHolder {
  historyChunk?: Uint8Array | undefined;
  history?: FamilyStat[] | undefined;
}

/**
 * Family::GetHistory: made on first use from the chunk LoadFamily kept
 * (which is then let go), empty without one.
 */
export function getFamilyHistory(f: FamilyHistoryHolder): FamilyStat[] {
  if (!f.history) {
    f.history = f.historyChunk ? parseFamilyHistory(f.historyChunk) : [];
    f.historyChunk = undefined;
  }
  return f.history;
}
