/**
 * TreeTable / TreeTableEntry (TreeTable.cpp): an object's interaction table,
 * chunk "TTAB" (ObjDefinition +0x0a tree table id), with the menu strings in
 * the "TTAs" STR# of the same id (version >= 8).
 *
 * TreeTable::DoStream: count, version, (version > 8) a compression flag,
 * then the entries. TreeTableEntry::DoStream (version >= 6): action tree
 * (+2), check tree (+0), motive count (+4), flags (+0x14), string index
 * (+0x18), attenuation code (+0xc), attenuation value (+0x10, float),
 * autonomy threshold (+0x1c), joining index (+0x20), then per motive
 * (+8, 6 bytes each) +2 min, +4 delta, +0 personality; version 7 adds the
 * menu string. Before version 4 the string index is the entry index.
 * TreeTable::Load names the entries of version >= 8 from the TTAs string
 * (string index + 1), or the action tree's label when that string is
 * missing or empty (e.g. the Magic Town skeleton maid's "Dismiss" / "Fire":
 * its TTAs 129 strings are empty in every language).
 */

import { ReconBuffer } from "../world/reconbuffer.js";
import type { ResFile } from "../world/iffres.js";
import { loadUIStringSet } from "./behavior.js";

export interface TreeTableMotive {
  /** +0 */
  personality: number;
  /** +2 */
  min: number;
  /** +4 */
  delta: number;
}

export class TreeTableEntry {
  /** +0 */
  checkTree = 0;
  /** +2 */
  actionTree = 0;
  /** +8 (count at +4) */
  motives: TreeTableMotive[] = [];
  /** +0xc: attenuation code (3 by default). */
  attenuationCode = 3;
  /** +0x10 */
  attenuationValue = 0;
  /** +0x14 */
  flags = 0;
  /** +0x18 */
  stringIndex = 0;
  /** +0x1c (0x32 by default). */
  autonomyThreshold = 0x32;
  /** +0x20 (-1 by default). */
  joiningIndex = -1;
  /** +0x24 */
  name = "";
}

export class TreeTable {
  /** +0xc */
  entries: TreeTableEntry[] = [];
  version = 0;

  /** TreeTable::Load: null when the chunk is missing or its format is not supported. */
  static load(res: ResFile, id: number): TreeTable | null {
    const b = res.get("TTAB", id);
    if (!b || id === 0) return null;
    const t = new TreeTable();
    const buf = new ReconBuffer(b);
    const count = buf.recon16();
    t.version = buf.recon16();
    if (t.version > 8 && buf.reconBool()) buf.enableCompression();
    // TreeTableEntry::DoOldStream (versions < 6) is not ported.
    if (t.version < 6) return null;
    for (let i = 0; i < count; i++) {
      const e = new TreeTableEntry();
      e.actionTree = buf.recon16();
      e.checkTree = buf.recon16();
      const n = buf.recon32();
      e.flags = buf.recon32();
      e.stringIndex = buf.recon32();
      e.attenuationCode = buf.recon32();
      e.attenuationValue = buf.reconFloat();
      e.autonomyThreshold = buf.recon32();
      e.joiningIndex = buf.recon32();
      for (let k = 0; k < n; k++) {
        const min = buf.recon16();
        const delta = buf.recon16();
        const personality = buf.recon16();
        e.motives.push({ personality, min, delta });
      }
      if (t.version === 7) e.name = buf.reconString();
      t.entries.push(e);
    }
    if (t.version >= 8) {
      // The menu strings are shown: the UI language (StringSetBase::Load(false, true):
      // the English ones when the set has none). A missing or empty string falls back
      // to the action tree's BHAV label in the same file, "?<tree id>" without one.
      const names = loadUIStringSet(res, id, "TTAs") ?? [];
      for (const e of t.entries) {
        const s = names[e.stringIndex];
        e.name = s ? s : res.find("BHAV", e.actionTree)?.label || `?${e.actionTree}`;
      }
    }
    return t;
  }
}
