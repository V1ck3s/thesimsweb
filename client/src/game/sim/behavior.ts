/**
 * Behavior: the SimAntics code of one object definition (Behavior.cpp).
 *
 * Behavior(Language*, glob, priv, middle) keeps three resource files:
 *   [0] the global file (GameData/Global/Global.iff, ObjectFolder +0x2c),
 *   [1] the object's own IFF (private),
 *   [2] its semi-global file (GLOB chunk; ObjectFolder::AddSelector opens
 *       "<global folder><name>"), or none.
 * Behavior::GetResFile maps a tree / constants id to one of them:
 *   0x100..0xfff global, 0x1000..0x1fff private, 0x2000..0x2328 semi-global,
 *   anything else (primitives < 0x100 included) none.
 *
 * In-memory BHAV (BehaviorTree): +0 signature (0x8000..0x8002), +2 node count,
 * +4 tree type, +5 argument count, +6 local count, +7 flags, +8 tree version,
 * then 12-byte nodes from +0xc: +0 primitive (bit 15 = breakpoint), +2 true
 * target, +3 false target, +4..+0xb operands. Targets 0xfd / 0xfe / 0xff are
 * error / return true / return false. The Windows build reads the chunk as is
 * (little endian); the Mac build swizzles it to the same layout.
 *
 * In-memory BCON: +0 count byte, +1 flags byte (bit 7: the user may override
 * it, ObjResFile::GetOverride), then 16-bit constants.
 */

import type { ResFile } from "../world/iffres.js";

/** BHAV header size and node size (BehaviorTree / BehaviorNode). */
export const TREE_HEADER = 0xc;
export const NODE_SIZE = 0xc;

/** Node branch targets (TreeSim::DoNodeAction). */
export const TARGET_ERROR = 0xfd;
export const TARGET_TRUE = 0xfe;
export const TARGET_FALSE = 0xff;

/** A BHAV chunk as the interpreter reads it. */
export class BehaviorTree {
  readonly view: DataView;

  constructor(
    readonly id: number,
    readonly label: string,
    readonly bytes: Uint8Array,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** +0 */
  get signature(): number {
    return this.view.getInt16(0, true);
  }
  /** +2 */
  get count(): number {
    return this.view.getInt16(2, true);
  }
  /** +4 (4 = the start node comes from parameter 0). */
  get treeType(): number {
    return this.bytes[4] ?? 0;
  }
  /** +5 */
  get argCount(): number {
    return this.bytes[5] ?? 0;
  }
  /** +6 */
  get localCount(): number {
    return this.bytes[6] ?? 0;
  }
  /** +8 */
  get version(): number {
    return this.bytes.length >= 12 ? this.view.getInt32(8, true) : 0;
  }

  /** Byte offset of node `i` in `bytes` (Behavior::GetNodeRef), or -1. */
  nodeOffset(i: number): number {
    if (i < 0 || i >= this.count) return -1;
    return TREE_HEADER + i * NODE_SIZE;
  }

  /** BehaviorNode +0 (with the breakpoint bit). */
  primitive(off: number): number {
    return this.view.getUint16(off, true);
  }
  trueTarget(off: number): number {
    return this.bytes[off + 2] ?? TARGET_ERROR;
  }
  falseTarget(off: number): number {
    return this.bytes[off + 3] ?? TARGET_ERROR;
  }
}

/** Parsed resources are shared by every Behavior using the same file. */
const treeCache = new WeakMap<ResFile, Map<number, BehaviorTree | null>>();
const constCache = new WeakMap<ResFile, Map<number, Int16Array | null>>();
const strCache = new WeakMap<ResFile, Map<string, string[] | null>>();

/** BHAV `id` of `res` (iResFile::GetByID('BHAV', id)). */
export function loadTree(res: ResFile, id: number): BehaviorTree | null {
  let m = treeCache.get(res);
  if (!m) {
    m = new Map();
    treeCache.set(res, m);
  }
  let t = m.get(id);
  if (t === undefined) {
    const c = res.find("BHAV", id);
    t = c ? new BehaviorTree(id, c.label, res.payload(c)) : null;
    // Old 0x8000 / 0x8001 trees have the same 12-byte header (unused fields) and nodes.
    if (t && (t.signature & 0xffff) > 0x8002) t = null;
    m.set(id, t);
  }
  return t;
}

/** BCON `id` of `res` as [count | flags << 8, values...] (the in-memory layout read as shorts). */
export function loadConstants(res: ResFile, id: number): Int16Array | null {
  let m = constCache.get(res);
  if (!m) {
    m = new Map();
    constCache.set(res, m);
  }
  let k = m.get(id);
  if (k === undefined) {
    const b = res.get("BCON", id);
    if (b && b.length >= 2) {
      const n = b[0]!;
      k = new Int16Array(n + 1);
      k[0] = n | (b[1]! << 8);
      const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
      for (let i = 0; i < n && 2 + i * 2 + 1 < b.length; i++) k[i + 1] = v.getInt16(2 + i * 2, true);
    } else {
      k = null;
    }
    m.set(id, k);
  }
  return k;
}

const cp1252 = new TextDecoder("windows-1252");

/**
 * StringSetBase::Load + GetString for STR# `id`: formats 0 (Pascal), -1
 * (C strings), -2 (string + comment) and -3 (language code, string, comment).
 * For -3 only the entries of the first language are kept (the language
 * independent tree names the interpreter looks up are stored once per language).
 */
export function loadStringSet(res: ResFile, id: number, type = "STR#"): string[] | null {
  let m = strCache.get(res);
  if (!m) {
    m = new Map();
    strCache.set(res, m);
  }
  const key = `${type}:${id}`;
  let s = m.get(key);
  if (s === undefined) {
    const b = res.get(type, id);
    s = b ? parseStringSet(b) : null;
    m.set(key, s);
  }
  return s;
}

/** The STR# layout (also used by TTAs). */
export function parseStringSet(b: Uint8Array): string[] {
  if (b.length < 4) return [];
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const format = v.getInt16(0, true);
  const n = v.getUint16(2, true);
  let p = 4;
  const cstr = (): string => {
    const end = b.indexOf(0, p);
    const e = end < 0 ? b.length : end;
    const t = cp1252.decode(b.subarray(p, e));
    p = e + 1;
    return t;
  };
  const out: string[] = [];
  let lang = -1;
  for (let i = 0; i < n && p < b.length; i++) {
    if (format === 0) {
      const len = b[p]!;
      out.push(cp1252.decode(b.subarray(p + 1, p + 1 + len)));
      p += 1 + len;
    } else if (format === -1) {
      out.push(cstr());
    } else if (format === -2) {
      out.push(cstr());
      cstr();
    } else if (format === -3) {
      const code = b[p++]!;
      const t = cstr();
      cstr();
      if (lang === -1) lang = code;
      if (code === lang) out.push(t);
    } else {
      break;
    }
  }
  return out;
}

/** Behavior::GetTreeClass. */
export function getTreeClass(id: number): number {
  if (id >= 0 && id < 0x100) return 0;
  if (id >= 0x100 && id < 0x1000) return 1;
  if (id >= 0x2000 && id < 0x2329) return 3;
  if (id >= 0x1000 && id < 0x2000) return 2;
  return 0;
}

/** Behavior::GetBaseID. */
export function getBaseID(cls: number): number {
  if (cls === 2) return 0x1000;
  if (cls === 3) return 0x2000;
  if (cls === 1) return 0x100;
  return 0;
}

/** Search order of Behavior::GetTreeID(name) (lbl_1059A098): private, semi-global, global. */
const NAME_SEARCH = [2, 3, 1] as const;

export class Behavior {
  constructor(
    /** [0] */
    readonly glob: ResFile | null,
    /** [1] */
    readonly priv: ResFile,
    /** [2] */
    readonly middle: ResFile | null,
  ) {}

  /** Behavior::GetResFile. */
  getResFile(id: number): ResFile | null {
    if (id < 0x100 || id > 0x2328) return null;
    if (id <= 0xfff) return this.glob;
    if (id <= 0x1fff) return this.priv;
    return this.middle;
  }

  /** Behavior::GetTree. */
  getTree(id: number): BehaviorTree | null {
    const f = this.getResFile(id);
    return f ? loadTree(f, id) : null;
  }

  /** Behavior::GetNodeRef: the node's tree and byte offset, or null. */
  getNodeRef(treeId: number, node: number): { tree: BehaviorTree; off: number } | null {
    const t = this.getTree(treeId);
    if (!t) return null;
    const off = t.nodeOffset(node);
    return off < 0 ? null : { tree: t, off };
  }

  /**
   * Behavior::GetConstants(id, allowOverride). The user override of
   * flagged BCONs (ObjResFile::GetOverride) is not ported: the file's
   * constants are always used.
   */
  getConstants(id: number): Int16Array | null {
    const f = this.getResFile(id);
    return f ? loadConstants(f, id) : null;
  }

  /**
   * Behavior::GetTreeID(name): the BHAV whose chunk label is `name`, searched
   * in the private, semi-global then global file. The original first matches
   * with the resource language filter, then without; labels carry no
   * language here, so the second pass compares case-insensitively.
   */
  getTreeID(name: string): number {
    for (const pass of [0, 1]) {
      for (const cls of NAME_SEARCH) {
        const f = this.getResFile(getBaseID(cls));
        if (!f) continue;
        const lower = name.toLowerCase();
        const c = f.list("BHAV").find((k) => (pass === 0 ? k.label === name : k.label.toLowerCase() === lower));
        if (c) return c.id;
      }
    }
    return 0;
  }

  /**
   * Behavior::GetCumulativeTreeVersion: the root tree's version << 16 plus
   * the versions of every tree it reaches through subroutine calls
   * (primitives > 0xff), itself included. ObjSelector::GetInitTreeVersion /
   * GetMainTreeVersion apply it to entry points 0 / 1.
   */
  getCumulativeTreeVersion(root: number): number {
    const todo = [root];
    const seen: number[] = [];
    while (todo.length) {
      const id = todo.pop()!;
      if (seen.includes(id)) continue;
      seen.push(id);
      const t = this.getTree(id);
      if (!t) continue;
      for (let i = 0; i < t.count; i++) {
        const op = t.primitive(t.nodeOffset(i)) & 0x7fff;
        if (op > 0xff) todo.push(op);
      }
    }
    let v = (this.getTree(root)?.version ?? 0) << 16;
    for (const id of seen) v += this.getTree(id)?.version ?? 0;
    return v | 0;
  }

  /** Behavior::GetTreeName. */
  getTreeName(id: number): string {
    if (id === 0x7fff) return "";
    const f = this.getResFile(id);
    return f?.find("BHAV", id)?.label ?? "";
  }
}
