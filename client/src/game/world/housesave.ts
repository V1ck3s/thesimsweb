/**
 * Saving a lot: House::SaveFile and the write side of every chunk the house
 * file holds (cSimsApp::SaveGame -> Neighborhood::SaveHouse -> House::SaveFile).
 *
 * House::SaveFile writes, in this order (the IFF keeps chunk order):
 *   SIMI 1   cSimulator::DoStream            (ReconSaveObject, version 0x49)
 *   HOUS 1   SimpleReconObject<House>        (the house name, 12 ints)
 *   FLRm 0/1 FloorGraphicsMgr::SaveUsageMap  (world/usagemap.ts)
 *   WALm 0/1 WallGraphicsMgr::SaveUsageMap
 *   Arry *   cFixedWorld::Save               (c2DArray::WriteToDisk, RLE)
 *   objt 0   ObjectFolder::PrepareForModuleSave (ObjectSaveTypeTable, version 3)
 *   ObjM 1   ObjectModule::DoStream          (compressed, version 0x49)
 *   then GlobalDispatch(0x92): HOUS 0 (HouseViewer::DoStream) and the
 *   thumbnails (THMB / BMP_, HouseViewer::SaveThumbnail: world/thumbnail.ts),
 *   carried over from the loaded file when the caller renders none.
 * Every chunk gets flags 0x10 except the thumbnails (0), as in the files the
 * game writes. Chunks of the loaded file this save does not produce are kept.
 *
 * Values the port does not model are carried over from the loaded file:
 * SIMI's cursor and +0x9c, HOUS 1, HouseViewer's second cutaway byte, roof pitch and pattern,
 * and in each person record the animator's practices and dressing and the
 * tail (saved routes, interactions, object records); see docs/decomp/save-port.md.
 */

import { buildIff, decodeStrSet, parseIff, type IffChunk } from "../data/iff.js";
import { UI_LANGUAGE } from "../res/uires.js";
import { loadStringSet } from "../sim/behavior.js";
import { ObjFnTable, EP } from "../sim/objfntable.js";
import type { Simulator } from "../sim/simulator.js";
import type { SimObject } from "../sim/xobject.js";
import type { PersonSim } from "../sim/person.js";
import type { Behavior } from "../sim/behavior.js";
import type { FloorGraphicsMgr } from "./floors.js";
import type { HouseViewer } from "./houseviewer.js";
import type { ResFile } from "./iffres.js";
import type { ObjectFolder } from "./objectfolder.js";
import type { ObjectModule, XObject } from "./objects.js";
import type { ObjSelector } from "./objselector.js";
import type { PersonRecord, SavedInteraction } from "./personstream.js";
import { getSRandSeed } from "./random.js";
import { ReconBuffer } from "./reconbuffer.js";
import { clearLayoutHistory, type LayoutHistory } from "./housestats.js";
import { compactRecon, type ReconOut } from "./reconwriter.js";
import { getRoofPattern, getRoofPitch } from "./roofs.js";
import type { WallGraphicsMgr } from "./wallgraphics.js";
import { ARRAY_SIZE, type FixedWorld } from "./world.js";

/** The stream version this game writes (lbl_105B9CD4 +0x44). */
export const SAVE_VERSION = 0x49;
/** ObjectSaveTypeTable's stream version (PrepareForModuleSave). */
const OBJT_VERSION = 3;
/** Chunk flags of the resources House::SaveFile adds. */
const FLAGS = 0x10;

// --- c2DArray ---------------------------------------------------------------------

interface ArrayLike2D {
  readonly data: Uint8Array;
  readonly elemSize: number;
  readonly size: number;
}

/**
 * c2DArray::WriteToDisk with compression: the header (Recon16 0, Recon16 0,
 * ReconInt rows, columns, element size, compressed), then blocks of u16 n:
 * a run of at least 8 equal bytes is one repeated byte (n | 0x8000), the
 * bytes before it a literal block; blocks are at most 0x7fff bytes and each
 * is padded to an even offset with a zero byte. Elements are stored
 * little-endian (WriteToDisk byte-swaps 2 and 14-byte elements on the Mac),
 * which is how the world arrays hold them here.
 */
export function encodeC2DArray(rows: number, cols: number, elemSize: number, data: Uint8Array): Uint8Array {
  const out: number[] = [];
  const u32 = (x: number): void => {
    out.push(x & 0xff, (x >>> 8) & 0xff, (x >>> 16) & 0xff, (x >>> 24) & 0xff);
  };
  out.push(0, 0, 0, 0);
  u32(rows);
  u32(cols);
  u32(elemSize);
  u32(1);
  const end = data.length;
  let s = 0;
  while (s < end) {
    let q = s;
    let r = 1;
    while (q < end) {
      r = 1;
      while (q + r < end && data[q] === data[q + r]) r++;
      if (r > 7) break;
      q += r;
    }
    const run = q === s;
    const n = Math.min(run ? r : q - s, 0x7fff);
    out.push(n & 0xff, ((n >> 8) & 0x7f) | (run ? 0x80 : 0));
    if (run) out.push(data[s]!);
    else for (let i = 0; i < n; i++) out.push(data[s + i]!);
    if (out.length & 1) out.push(0);
    s += n;
  }
  return Uint8Array.from(out);
}

function arryChunk(id: number, label: string, a: ArrayLike2D): IffChunk {
  return { type: "Arry", id, flags: FLAGS, label, data: encodeC2DArray(a.size, a.size, a.elemSize, a.data) };
}

/**
 * cFixedWorld::Save: altitude, ground, then per level floors, the byte copy
 * of the floors (old saves' id 1 / 101), walls, the 8-byte copy of the walls
 * (id 2 / 102), objects and flags; then grass, target grass, pool and water.
 * The copies cover the lot (cFixedWorld +0x10) and are zero elsewhere.
 */
export function saveFixedWorld(fixed: FixedWorld, v = SAVE_VERSION): IffChunk[] {
  const out: IffChunk[] = [arryChunk(0, "altitude", fixed.alt), arryChunk(4, "ground", fixed.ground)];
  const levels = v < 0x17 ? 1 : 2;
  const n = fixed.size;
  for (let l = 0; l < levels; l++) {
    const base = (l + 1) * 100;
    const sfx = l === 0 ? "" : String(l + 1);
    const floors = fixed.floors[l]!;
    out.push(arryChunk(base - 89, `floors${sfx}`, floors));
    const floors8 = { data: new Uint8Array(ARRAY_SIZE * ARRAY_SIZE), elemSize: 1, size: ARRAY_SIZE };
    for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) floors8.data[x * ARRAY_SIZE + y] = floors.data[(x * ARRAY_SIZE + y) * 2]!;
    out.push(arryChunk(base - 99, "1", floors8));
    const walls = fixed.walls[l]!;
    out.push(arryChunk(base - 88, `walls${sfx}`, walls));
    const walls8 = { data: new Uint8Array(ARRAY_SIZE * ARRAY_SIZE * 8), elemSize: 8, size: ARRAY_SIZE };
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) {
        const i = x * ARRAY_SIZE + y;
        const s = i * 14;
        const d = i * 8;
        walls8.data[d] = walls.data[s]!;
        walls8.data[d + 1] = walls.data[s + 1]!;
        for (let k = 0; k < 6; k++) walls8.data[d + 2 + k] = walls.data[s + 2 + k * 2]!;
      }
    }
    out.push(arryChunk(base - 98, "1", walls8));
    out.push(arryChunk(base - 97, `objects${sfx}`, fixed.objects[l]!));
    out.push(arryChunk(base - 92, `flags${sfx}`, fixed.flags[l]!));
  }
  if (v >= 0x11) {
    out.push(arryChunk(6, "grass", fixed.grass), arryChunk(7, "target grass", fixed.targetGrass));
    if (v > 0x25) out.push(arryChunk(9, "Pool", fixed.pool));
    if (v > 0x34) out.push(arryChunk(10, "Water", fixed.water));
  }
  return out;
}

// --- SIMI -------------------------------------------------------------------------

/** cSimulator fields SIMI carries that the port does not model, read back from the loaded chunk. */
interface SimiCarry {
  cursor: number;
  f94: number;
  f9c: number;
  fa0: number;
  fa4: number;
  /** +0x184 then the five +0xe4 blocks: a "has 8" flag and its ints. */
  blocks: Array<{ full: number; values: number[] }>;
}

function readSimiCarry(payload: Uint8Array | null): SimiCarry {
  const c: SimiCarry = { cursor: 0, f94: 0, f9c: 0x1194, fa0: 0, fa4: 0, blocks: [] };
  for (let i = 0; i < 6; i++) c.blocks.push({ full: 1, values: new Array<number>(8).fill(0) });
  if (!payload) return c;
  try {
    const { buf, version: v } = ReconBuffer.fromChunk(payload);
    const n = v < 0x12 ? 0x10 : v < 0x41 ? 0x20 : 0x40;
    buf.recon16s(n);
    if (v < 0x12) buf.recon32();
    buf.recon32();
    c.cursor = buf.recon16();
    if (v > 1) buf.recon32();
    if (v > 0xd) {
      buf.recon32();
      buf.recon32();
    }
    if (v >= 0xf) c.f94 = buf.recon32();
    if (v >= 0x25) {
      c.f9c = buf.recon32();
      c.fa0 = buf.recon32();
      c.fa4 = buf.recon32();
    }
    if (v >= 0x26) {
      c.blocks = [];
      for (let b = 0; b < 6; b++) {
        const full = buf.recon32();
        const values = new Array<number>(8).fill(0);
        for (let i = 0; i < (full === 0 ? 7 : 8); i++) values[i] = buf.recon32();
        c.blocks.push({ full, values });
      }
    }
  } catch {
    // A short chunk keeps the defaults read so far.
  }
  return c;
}

/** The House::SaveFile values set on the simulator before it streams. */
export interface SimiSaveValues {
  /** cSimulator +0xa0 / +0xa4 (ObjectModule::ComputeStats, cFixedWorld::ComputeArchValue). */
  objectValue?: number;
  archValue?: number;
  /** cSimulator::ClearHistory ran (Neighborhood::MoveOut): the +0x184 and +0xe4 blocks are zero. */
  clearHistory?: boolean;
}

/** cSimulator::DoStream (write, version 0x49). */
export function saveSimulator(sim: Simulator, loaded: Uint8Array | null, extra: SimiSaveValues = {}): Uint8Array {
  const c = readSimiCarry(loaded);
  // DoStream folds +0x94 into the funds on load and clears it.
  const f94 = 0;
  return compactRecon(SAVE_VERSION, "SIMI", (w) => {
    w.recon16s(sim.globals);
    w.recon32(sim.tickCount);
    w.recon16(c.cursor);
    w.recon32(sim.funds);
    w.recon32(sim.seed);
    w.recon32(getSRandSeed());
    w.recon32(f94);
    w.recon32(c.f9c);
    w.recon32(extra.objectValue ?? c.fa0);
    w.recon32(extra.archValue ?? c.fa4);
    // DoStream writes the "full" flag as 1 (eight ints per block): the simulator's ExpenseReports.
    const blocks = extra.clearHistory
      ? c.blocks.map(() => ({ full: 1, values: new Array<number>(8).fill(0) }))
      : [sim.expenses, ...sim.expenseHistory].map((b) => ({ full: 1, values: [...b] }));
    for (const b of blocks) {
      w.recon32(b.full);
      for (let i = 0; i < (b.full === 0 ? 7 : 8); i++) w.recon32(b.values[i]!);
    }
  });
}

// --- HOUS 1 (House) -----------------------------------------------------------------

/**
 * SimpleReconObject<House>::DoStream (write, version 0x49): the house name,
 * then for each of the five past days and today the routing ticks (+0x34 +
 * 8i) and the ticks (+0x30 + 8i) of the layout history.
 */
export function saveHouseRecon(name: string, h: LayoutHistory): Uint8Array {
  return compactRecon(SAVE_VERSION, "HOUS", (w) => {
    w.reconString(name);
    for (let i = 0; i < 6; i++) {
      w.recon32(h.routing[i] ?? 0);
      w.recon32(h.ticks[i] ?? 0);
    }
  });
}

/** The house name HOUS 1 holds (version > 0x12; "" before). */
export function readHouseName(bytes: Uint8Array): string {
  const { buf, version } = ReconBuffer.fromChunk(bytes);
  return version > 0x12 ? buf.reconString() : "";
}

// --- HOUS 0 (HouseViewer) -----------------------------------------------------------

/** HouseViewer::DoStream (write; plain stream). */
export function saveHouseViewer(viewer: HouseViewer, rotation: number, loaded: Uint8Array | null): Uint8Array {
  // Carried: the +0x49 cutaway byte. The roof pitch and pattern are cRoofLayer's (roofs.ts).
  let low = 0;
  if (loaded && loaded.length >= 16) {
    try {
      low = ReconBuffer.fromChunk(loaded).buf.recon32() & 0xff;
    } catch {
      // keep the defaults
    }
  }
  return compactRecon(SAVE_VERSION, "HOUS", (w) => {
    w.recon32((viewer.cutaway ? 0x100 : 0) | (viewer.cutaway ? 0 : low));
    w.recon32(viewer.scale);
    w.recon32(viewer.originX);
    w.recon32(viewer.originY);
    w.recon16(rotation);
    w.recon16(viewer.level);
    w.recon16(viewer.drawRoof ? 1 : 0);
    w.reconFloat(getRoofPitch());
    w.reconString(getRoofPattern());
  });
}

// --- objt ------------------------------------------------------------------------------

/** One ObjectSaveTypeTable record (write side). */
interface SaveType {
  sel: ObjSelector;
  index: number;
  initVersion: number;
  mainVersion: number;
  name: string;
}

/**
 * Behavior::GetCumulativeTreeVersion: the tree's version << 16 plus the sum
 * of the versions of every tree it reaches through subroutine calls
 * (primitives > 0xff), itself included.
 */
export function cumulativeTreeVersion(b: Behavior, root: number): number {
  const stack = [root];
  const seen: number[] = [];
  while (stack.length) {
    const t = stack.pop()!;
    if (seen.includes(t)) continue;
    seen.push(t);
    const tree = b.getTree(t);
    if (!tree) continue;
    for (let i = 0; i < tree.count; i++) {
      const op = tree.primitive(tree.nodeOffset(i)) & 0x7fff;
      if (op > 0xff) stack.push(op);
    }
  }
  let v = (b.getTree(root)?.version ?? 0) << 16;
  for (const t of seen) v += b.getTree(t)?.version ?? 0;
  return v | 0;
}

/**
 * ObjSelector::GetCatalogResource's name: CATS (second string) or CTSS
 * string 1 in the game's language (cSimsApp +100, French here), else "*" +
 * the OBJD label.
 */
function catalogName(sel: ObjSelector): string {
  const id = sel.objd.i16(0x52);
  let name = "";
  const cats = sel.res.get("CATS", id);
  if (cats) {
    let z = cats.indexOf(0);
    if (z < 0) z = cats.length;
    let z2 = cats.indexOf(0, z + 1);
    if (z2 < 0) z2 = cats.length;
    name = z + 1 < cats.length ? new TextDecoder("windows-1252").decode(cats.subarray(z + 1, z2)) : "";
  } else {
    // StringSetMulti::GetString(1): the current language's string, no fallback.
    const ctss = sel.res.get("CTSS", id);
    if (ctss) {
      const format = ctss.length >= 2 ? ctss[0]! | (ctss[1]! << 8) : 0;
      name =
        format === 0xfffd
          ? (decodeStrSet(ctss).filter((e) => e.lang === UI_LANGUAGE)[0]?.value ?? "")
          : (loadStringSet(sel.res, id, "CTSS")?.[0] ?? "");
    }
  }
  return name || `*${sel.name}`;
}

/**
 * ObjectFolder::PrepareForModuleSave: every selector with instances in the
 * module gets the next save index (1..) in folder order (ObjSelector +0xa8);
 * ObjectSaveTypeTable::DoStream then lists them: GUID, init and main tree
 * versions, index, OBJD type, catalog name ("" for the parts of a
 * multi-tile object), OBJD +0x8c; a 0 GUID ends the table.
 */
function buildSaveTypes(
  objs: readonly XObject[],
  behaviorOf: ((sel: ObjSelector) => Behavior) | null,
  loaded: Map<number, { init: number; main: number; name: string; index: number }>,
  keepLoadedOrder: boolean,
): SaveType[] {
  const used = new Set<ObjSelector>();
  for (const o of objs) used.add(o.selector);
  // Folder order; the dev check can keep the loaded table's order instead (its folder's).
  const rank = (s: ObjSelector): number => (keepLoadedOrder ? (loaded.get(s.guid >>> 0)?.index ?? 0x10000 + s.index) : s.index);
  const sels = [...used].sort((a, b) => rank(a) - rank(b));
  return sels.map((sel, i) => {
    const prev = loaded.get(sel.guid >>> 0);
    let initVersion = prev?.init ?? 0;
    let mainVersion = prev?.main ?? 0;
    if (behaviorOf) {
      const b = behaviorOf(sel);
      const fns = ObjFnTable.forSelector(sel);
      initVersion = cumulativeTreeVersion(b, fns.getTreeID(EP.init));
      mainVersion = cumulativeTreeVersion(b, fns.getTreeID(EP.main));
    }
    const objd = sel.objd;
    const part = objd.masterId !== 0 && objd.subIndex !== -1;
    const name = part ? "" : catalogName(sel);
    return { sel, index: i + 1, initVersion, mainVersion, name };
  });
}

function saveTypeTable(types: readonly SaveType[]): Uint8Array {
  return compactRecon(OBJT_VERSION, "objt", (w) => {
    for (const t of types) {
      w.recon32(t.sel.guid);
      w.recon32(t.initVersion);
      w.recon32(t.mainVersion);
      w.recon16(t.index);
      w.recon16(t.sel.objd.objectType);
      w.reconString(t.name);
      w.recon32(t.sel.objd.originalGuid);
    }
    w.recon32(0);
  });
}

/** The loaded objt records by GUID (fallback tree versions when there is no simulator). */
function readLoadedTypes(payload: Uint8Array | null): Map<number, { init: number; main: number; name: string; index: number }> {
  const out = new Map<number, { init: number; main: number; name: string; index: number }>();
  if (!payload) return out;
  try {
    const { buf, version } = ReconBuffer.fromChunk(payload);
    for (let guid = buf.recon32() >>> 0; guid !== 0; guid = buf.recon32() >>> 0) {
      const init = version > 0 ? buf.recon32() : 0;
      const main = version > 0 ? buf.recon32() : 0;
      const index = buf.recon16();
      if (version >= 2) buf.recon16();
      const name = buf.reconString();
      if (version >= 3) buf.recon32();
      out.set(guid, { init, main, name, index });
    }
  } catch {
    // partial table
  }
  return out;
}

// --- ObjM ------------------------------------------------------------------------------

/** Where an object's run-time state comes from when saving. */
export interface ObjectStateSource {
  /** The simulator's object (live stack, sim flags, person state), null: the loaded state. */
  sim(id: number): SimObject | null;
  simFlags(id: number): number | null;
  selectorOfBehavior(b: Behavior | null): ObjSelector | null;
}

interface FrameOut {
  stackObj: number;
  rawTree: number;
  node: number;
  params: ArrayLike<number>;
  locals: ArrayLike<number>;
  state: number;
  selector: ObjSelector | null;
}

function liveFrames(o: SimObject, src: ObjectStateSource): { memBytes: number; frames: FrameOut[] } {
  const st = o.stack;
  const frames: FrameOut[] = [];
  for (let i = 0; i < st.getStackSize(); i++) {
    const e = st.getNthFrame(i)!;
    const p = e.paramsAt();
    const l = e.localsAt();
    frames.push({
      stackObj: e.stackObj,
      rawTree: e.rawTree,
      node: e.node,
      params: st.mem.subarray(p, p + e.numParams),
      locals: st.mem.subarray(l, l + e.numLocals),
      state: e.state,
      selector: src.selectorOfBehavior(e.behavior),
    });
  }
  return { memBytes: st.mem.length * 2, frames };
}

/** TreeStack::ReconStream (write, version > 0x19). */
function writeTreeStack(w: ReconOut, stack: { memBytes: number; frames: FrameOut[] }, typeIndex: (s: ObjSelector | null) => number): void {
  w.recon32(stack.frames.length);
  w.recon32(stack.memBytes);
  for (const f of stack.frames) {
    w.recon16(f.stackObj);
    w.recon16(f.rawTree === 0xffff ? 0xffff : f.rawTree & 0x7fff);
    w.recon16(f.node);
    w.recon8(f.locals.length);
    w.recon8(f.params.length);
    w.recon16s(f.params);
    w.recon16s(f.locals);
    w.recon32(f.state);
    // ObjectFolder::ReconBehavior: the save index of the behavior's selector.
    w.recon16(typeIndex(f.selector));
  }
}

/** RelMatrix::DoStream (write): always the -1 form, then DoPtrVectorStream of the arrays. */
function writeRelMatrix(w: ReconOut, rel: ReadonlyMap<number, readonly number[]>): void {
  w.recon32(-1);
  w.recon32(rel.size);
  for (const [key, values] of rel) {
    w.recon32(1);
    w.recon32(key);
    w.recon32(values.length);
    for (const x of values) w.recon32(x);
  }
}

/** cXObject::ReconStream (write). */
function writeXObject(w: ReconOut, o: XObject, stack: { memBytes: number; frames: FrameOut[] }, typeIndex: (s: ObjSelector | null) => number): void {
  // ReconHeader
  w.recon32(o.rect[2]);
  w.recon32(o.rect[3]);
  w.recon32(o.rect[0]);
  w.recon32(o.rect[1]);
  w.recon32(o.fx);
  w.recon32(o.fy);
  w.recon32(o.level);
  w.recon16(1);
  w.recon16(o.attributes.length);
  w.recon16s(o.attributes);
  w.recon16s(o.temps);
  w.recon16s(o.objectData);
  w.recon16(0);
  writeTreeStack(w, stack, typeIndex);
  writeRelMatrix(w, o.relations);
  // ReconSlots
  w.recon16(o.objectSlots.length);
  for (const s of o.objectSlots) {
    w.recon16(0);
    w.recon16(s.containedId);
  }
  w.recon16(o.spriteVisibility.length);
  w.recon16s(o.spriteVisibility);
}

/** cXMTObject::ReconStream / cXPortal::ReconStream after the cXObject part. */
function writeSubclass(w: ReconOut, o: XObject): void {
  if (o.kind !== "multiTile" && o.kind !== "portal") return;
  w.recon32(o.mt1a0);
  w.recon32(o.mt1a4);
  w.recon32(o.mt1a8);
  w.recon32(o.mtOffsetX);
  w.recon32(o.mtOffsetY);
  w.recon32(o.mtLevelOffset);
  w.recon16(o.mtLeadId);
  if (o.kind === "portal") {
    w.recon32(o.portalValues.length);
    for (const f of o.portalValues) w.reconFloat(f);
  }
}

const NO_INTERACTION: SavedInteraction = {
  i0: 0,
  uid: 0,
  person: 0,
  object1: 0,
  object2: 0,
  i10: 0,
  shorts: new Int16Array(4),
  i1c: 0,
  s20: 0,
  f24: 0,
  flags: 0,
};

/** Interaction::DoStream (write, v >= 0x3e). */
function writeInteraction(w: ReconOut, i: SavedInteraction | null): void {
  const x = i ?? NO_INTERACTION;
  w.recon32(x.i0);
  w.recon32(x.uid);
  w.recon16(x.person);
  w.recon16(x.object1);
  w.recon16(x.object2);
  w.recon32(x.i10);
  w.recon16s(x.shorts);
  w.recon32(x.i1c);
  w.recon16(x.s20);
  w.reconFloat(x.f24);
  w.recon32(x.flags);
}

/**
 * cXPerson::ReconStream after the cXObject part: SAnimator::ReconStream,
 * motives (16 + 16 floats), person data (0x100 shorts), the XRoute count,
 * the current and last interactions, the queue, the ObjectRecord vector and
 * the MotiveInc vector. Live values (motives, person data, motive
 * increments) come from the simulator's person when there is one.
 */
function writePerson(w: ReconOut, rec: PersonRecord | null, live: PersonSim | null, exists: (id: number) => boolean): void {
  const r = rec;
  // SAnimator::ReconStream
  const ints = r?.animInts ?? [0, 0];
  w.recon32(ints[0]);
  w.recon32(ints[1]);
  for (let i = 0; i < 5; i++) {
    const d = r?.dressing[i] ?? ["", ""];
    w.reconString(d[0]);
    w.reconString(d[1]);
  }
  const acc = r?.accessories ?? [];
  w.recon32(acc.length);
  for (const [a, b] of acc) {
    w.reconString(a);
    w.reconString(b);
  }
  for (let i = 0; i < 3; i++) w.reconString(r?.practices[i] ?? "");
  w.recon32(r?.animState ?? 0);
  const af = r?.animFloats ?? new Float32Array(9);
  for (let i = 0; i < 9; i++) w.reconFloat(af[i] ?? 0);
  const m = live ? live.motives : null;
  for (let i = 0; i < 16; i++) w.reconFloat(m ? m[i]! : (r?.motives[i] ?? 0));
  for (let i = 0; i < 16; i++) w.reconFloat(m ? m[16 + i]! : (r?.motives2[i] ?? 0));
  w.recon16s(live ? live.pd : (r?.personData ?? new Int16Array(0x100)));
  const t = r?.tail;
  w.recon32(t?.routeCount ?? 0);
  writeInteraction(w, t?.current ?? null);
  writeInteraction(w, t?.last ?? null);
  const q = t?.queue ?? [];
  w.recon32(q.length);
  for (const i of q) writeInteraction(w, i);
  const saved = live ? live.objectRecords.map((x) => ({ object: x.id, value: x.depth, flag: x.action })) : (t?.objectRecords ?? []);
  const recs = saved.filter((x) => x.object === 0 || exists(x.object));
  w.recon32(recs.length);
  for (const x of recs) {
    w.recon16(x.object);
    w.recon32(x.value);
    w.reconBool(x.flag);
  }
  const incs = live ? live.motiveIncs : (t?.motiveIncs ?? []);
  w.recon32(incs.length);
  for (const x of incs) {
    w.recon32(x.motive);
    w.reconFloat(x.delta);
    w.reconFloat(x.limit);
  }
}

/**
 * The module list order (+0x30 / cXObject +0xe0): loading appends
 * (AddObject(..., true)), run-time creation prepends. Objects of the loaded
 * order keep it; the others come first, latest first.
 */
export function moduleOrder(module: ObjectModule): XObject[] {
  const loadedAt = new Map(module.loadOrder.map((id, i) => [id, i]));
  const loaded: XObject[] = [];
  const created: XObject[] = [];
  let last = -1;
  for (const o of module.objects.values()) {
    const at = loadedAt.get(o.objectId);
    if (at !== undefined && at > last && (o.objFlags & 0x80) !== 0) {
      loaded.push(o);
      last = at;
    } else created.push(o);
  }
  return [...created.reverse(), ...loaded];
}

export interface ObjectModuleSave {
  objt: Uint8Array;
  objm: Uint8Array;
}

/** ObjectModule::Save: PrepareForModuleSave (objt), then ObjectModule::DoStream (ObjM). */
export async function saveObjectModule(
  module: ObjectModule,
  folder: ObjectFolder,
  src: ObjectStateSource | null,
  behaviorOf: ((sel: ObjSelector) => Behavior) | null,
  loadedObjt: Uint8Array | null,
  selectedPersonId: number,
  keepLoadedTypeOrder = false,
): Promise<ObjectModuleSave> {
  const objs = moduleOrder(module).filter((o) => !(src?.sim(o.objectId)?.killed ?? false));
  const ids = new Set(objs.map((o) => o.objectId));
  const types = buildSaveTypes(objs, behaviorOf, readLoadedTypes(loadedObjt), keepLoadedTypeOrder);
  const indexOf = new Map(types.map((t) => [t.sel, t.index]));
  const typeIndex = (s: ObjSelector | null): number => (s ? (indexOf.get(s) ?? 0) : 0);
  const ph = await folder.getPlaceholders();
  const placeholders = new Set([ph.standard, ph.person, ph.dog, ph.cat].filter((s): s is ObjSelector => s !== null));
  const v = SAVE_VERSION;
  const objm = compactRecon(v, "ObjM", (w) => {
    w.reconBool(true);
    w.enableCompression();
    for (const o of objs) {
      w.recon16(o.objectId);
      w.recon16(typeIndex(o.selector));
    }
    w.recon16(0);
    w.reconMark();
    for (const o of objs) {
      const live = src?.sim(o.objectId) ?? null;
      const stack = live
        ? liveFrames(live, src!)
        : {
            memBytes: o.savedStack?.memBytes ?? 0,
            frames: (o.savedStack?.frames ?? []).map((f) => ({
              stackObj: f.stackObj,
              rawTree: f.treeId,
              node: f.node,
              params: f.params,
              locals: f.locals,
              state: f.state,
              selector: f.selector,
            })),
          };
      writeXObject(w, o, stack, typeIndex);
      if (o.isPerson) writePerson(w, o.personRecord, live && "motiveIncs" in live ? (live as PersonSim) : null, (id) => ids.has(id));
      else writeSubclass(w, o);
      if (!placeholders.has(o.selector)) w.recon32(src?.simFlags(o.objectId) ?? o.simFlags);
      w.reconMark();
    }
    w.recon16(ids.has(selectedPersonId) ? selectedPersonId : 0);
    const trailer = module.trailerIds.filter((id) => id === 0 || ids.has(id));
    w.recon32(trailer.length);
    for (const id of trailer) w.recon16(id);
    w.reconString(module.trailerString);
  });
  return { objt: saveTypeTable(types), objm };
}

// --- the house file --------------------------------------------------------------------

export interface HouseSaveInput {
  /** The house file as loaded (carried chunks and values). */
  house: ResFile;
  fixed: FixedWorld;
  floors: FloorGraphicsMgr;
  walls: WallGraphicsMgr;
  module: ObjectModule;
  folder: ObjectFolder;
  sim: Simulator | null;
  viewer: HouseViewer | null;
  rotation: number;
  selectedPersonId: number;
  /** Stats House::SaveFile computes before streaming the simulator (null: carried). */
  stats?: { objectValue: number; archValue: number; global16: number; global25: number } | null;
  /** cSimulator::ClearHistory before the save (Neighborhood::MoveOut). */
  clearHistory?: boolean;
  /** House::ClearRouteHistory before the save (Neighborhood::MoveOut): HOUS 1 written with the cleared layout history. */
  clearRouteHistory?: boolean;
  /** Dev check: number the saved types in the loaded table's order (that of the folder which wrote it). */
  keepLoadedTypeOrder?: boolean;
  /**
   * GlobalDispatch(0x92)'s HouseViewer::SaveThumbnail / SaveUnleashedThumbnail
   * (world/thumbnail.ts), run after the other chunks; null: the loaded file's are carried.
   */
  thumbnails?: (() => IffChunk[]) | null;
}

/** House::SaveFile: the chunks of the new house file, in the original order. */
export async function buildHouseFile(input: HouseSaveInput): Promise<Uint8Array> {
  const { house, sim } = input;
  const loaded = parseIff(house.data);
  const made = new Map<string, IffChunk>();
  const put = (c: IffChunk): void => {
    made.set(`${c.type}:${c.id}`, c);
  };
  const order: IffChunk[] = [];
  const add = (c: IffChunk): void => {
    put(c);
    order.push(c);
  };
  // SIMI: House::SaveFile sets the lot size, the stats globals, then saves the simulator.
  const simi = house.get("SIMI", 1);
  if (sim) {
    sim.globals[0x17] = input.fixed.size;
    if (input.stats) {
      sim.globals[0x16] = input.stats.global16;
      sim.globals[0x25] = input.stats.global25;
    }
    const extra: SimiSaveValues = input.stats ? { objectValue: input.stats.objectValue, archValue: input.stats.archValue } : {};
    if (input.clearHistory) extra.clearHistory = true;
    add({ type: "SIMI", id: 1, flags: FLAGS, label: "", data: saveSimulator(sim, simi, extra) });
  } else if (simi) add({ type: "SIMI", id: 1, flags: FLAGS, label: "", data: simi.slice() });
  const hous1 = house.get("HOUS", 1);
  if (hous1) {
    // The layout history in memory (cSimulator.layoutHistory, House +0x30..+0x5c) when the lot ran.
    const layout = input.clearRouteHistory ? clearLayoutHistory() : (sim?.layoutHistory ?? null);
    const data = layout ? saveHouseRecon(readHouseName(hous1), layout) : hous1.slice();
    add({ type: "HOUS", id: 1, flags: FLAGS, label: "", data });
  }
  const [flr0, flr1] = input.floors.saveUsageMap(input.fixed);
  add({ type: "FLRm", id: 0, flags: FLAGS, label: "", data: flr0 });
  add({ type: "FLRm", id: 1, flags: FLAGS, label: "", data: flr1 });
  const [wal0, wal1] = input.walls.saveUsageMap(input.fixed);
  add({ type: "WALm", id: 0, flags: FLAGS, label: "", data: wal0 });
  add({ type: "WALm", id: 1, flags: FLAGS, label: "", data: wal1 });
  for (const c of saveFixedWorld(input.fixed)) add(c);
  const src: ObjectStateSource | null = sim
    ? {
        sim: (id) => sim.module.objects[id - 1] ?? null,
        simFlags: (id) => sim.module.simFlags[id - 1] ?? null,
        selectorOfBehavior: (b) => sim.module.selectorOfBehavior(b),
      }
    : null;
  const { objt, objm } = await saveObjectModule(
    input.module,
    input.folder,
    src,
    sim ? (s) => sim.module.behaviorOf(s) : null,
    house.get("objt", 0),
    input.selectedPersonId,
    input.keepLoadedTypeOrder ?? false,
  );
  add({ type: "objt", id: 0, flags: FLAGS, label: "", data: objt });
  add({ type: "ObjM", id: 1, flags: FLAGS, label: "", data: objm });
  // GlobalDispatch(0x92): the house viewer's chunk, then the thumbnails.
  const hous0 = house.get("HOUS", 0);
  if (input.viewer) add({ type: "HOUS", id: 0, flags: FLAGS, label: "", data: saveHouseViewer(input.viewer, input.rotation, hous0) });
  else if (hous0) add({ type: "HOUS", id: 0, flags: FLAGS, label: "", data: hous0.slice() });
  if (input.thumbnails) for (const c of input.thumbnails()) add(c);
  // Chunks of the loaded file not produced above (thumbnails, older chunks) keep their place after them.
  const replaced = new Set(["Arry", "FLRm", "WALm"]);
  for (const c of loaded) {
    const key = `${c.type}:${c.id}`;
    if (made.has(key) || replaced.has(c.type)) continue;
    // Old per-object saves ("Rcon") are superseded by ObjM.
    if (c.type === "Rcon") continue;
    order.push(c);
  }
  return buildIff(order);
}

/** For the dev checks: a byte string label. */
export function hexOf(b: Uint8Array, max = 64): string {
  return [...b.subarray(0, max)].map((x) => x.toString(16).padStart(2, "0")).join(" ");
}
