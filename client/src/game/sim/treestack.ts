/**
 * TreeStack / StackElem (TreeStack.cpp).
 *
 * TreeStack owns one memory block (+0 start, +4 end) and a vector of frame
 * pointers (+8). Frames are laid out back to back; a frame is 0x10 header
 * bytes followed by its parameters then its locals, rounded:
 *   size = ((locals + params + 3) * 2 & ~7) + 0x10.
 * MakeNewFrame doubles the block when it is full (0x200 bytes at least) and
 * zeroes only the new part, so a pushed frame's locals start with whatever a
 * popped frame left there. That memory is reproduced here as an Int16Array
 * arena so uninitialised locals read the same values.
 *
 * StackElem header (shorts):
 *   +0 tree id (bit 15: breakpoint, 0xffff = none)   +2 node index
 *   +4 stack object id                               +6 local count (byte)
 *   +7 parameter count (byte)                        +8 primitive state (int)
 *   +0xc Behavior*                                   +0x10 parameters, then locals
 */

import type { Behavior } from "./behavior.js";

/** Short offsets inside a frame. */
const F_TREE = 0;
const F_NODE = 1;
const F_STACKOBJ = 2;
const F_COUNTS = 3;
const F_STATE = 4;
const F_PARAMS = 8;

/** Frame size in shorts. */
function frameShorts(locals: number, params: number): number {
  return ((((locals + params + 3) * 2) & ~7) + 0x10) >> 1;
}

/** A frame: a view over the stack memory (StackElem*). */
export class StackElem {
  constructor(
    readonly stack: TreeStack,
    /** Short offset of the frame in `stack.mem`. */
    readonly at: number,
    /** Position in the frame vector. */
    readonly index: number,
  ) {}

  private get m(): Int16Array {
    return this.stack.mem;
  }

  /** Raw +0 (with the breakpoint bit). */
  get rawTree(): number {
    return this.m[this.at + F_TREE]! & 0xffff;
  }
  set rawTree(v: number) {
    this.m[this.at + F_TREE] = v;
  }
  /** StackElem::GetTreeID: -1 when the frame has no tree. */
  getTreeID(): number {
    const t = this.rawTree;
    return t === 0xffff ? -1 : t & 0x7fff;
  }
  get node(): number {
    return this.m[this.at + F_NODE]!;
  }
  set node(v: number) {
    this.m[this.at + F_NODE] = v;
  }
  get stackObj(): number {
    return this.m[this.at + F_STACKOBJ]!;
  }
  set stackObj(v: number) {
    this.m[this.at + F_STACKOBJ] = v;
  }
  /** +6 */
  get numLocals(): number {
    return this.m[this.at + F_COUNTS]! & 0xff;
  }
  /** +7 */
  get numParams(): number {
    return (this.m[this.at + F_COUNTS]! >> 8) & 0xff;
  }
  /** +8: non-zero while a primitive waits for a subtree it pushed. */
  get state(): number {
    return (this.m[this.at + F_STATE]! & 0xffff) | (this.m[this.at + F_STATE + 1]! << 16);
  }
  set state(v: number) {
    this.m[this.at + F_STATE] = v & 0xffff;
    this.m[this.at + F_STATE + 1] = v >> 16;
  }
  /** +0xc */
  get behavior(): Behavior | null {
    return this.stack.behaviors[this.index] ?? null;
  }
  set behavior(b: Behavior | null) {
    this.stack.behaviors[this.index] = b;
  }
  /** StackElem::GetParams: index of parameter 0 in `stack.mem`. */
  paramsAt(): number {
    return this.at + F_PARAMS;
  }
  /** StackElem::GetLocals. */
  localsAt(): number {
    return this.at + F_PARAMS + this.numParams;
  }
  getParam(i: number): number {
    return this.m[this.paramsAt() + i]!;
  }
  setParam(i: number, v: number): void {
    this.m[this.paramsAt() + i] = v;
  }
  getLocal(i: number): number {
    return this.m[this.localsAt() + i]!;
  }
}

/** The fields TreeStack::Push copies from its template frame. */
export interface FrameTemplate {
  rawTree: number;
  node: number;
  stackObj: number;
  numLocals: number;
  numParams: number;
  state: number;
  behavior: Behavior | null;
}

/** Where a pushed frame's parameters come from: `count` shorts of `src` from `at`. */
export interface ParamSource {
  src: ArrayLike<number>;
  at: number;
}

export class TreeStack {
  /** +0 / +4: the frame memory. */
  mem = new Int16Array(0);
  /** +8: frame offsets (shorts). */
  private frames: number[] = [];
  /** Behavior* of each frame (+0xc), by frame index. */
  behaviors: Array<Behavior | null> = [];
  private readonly elems: StackElem[] = [];

  /** TreeStack::GetStackSize. */
  getStackSize(): number {
    return this.frames.length;
  }

  /** TreeStack::GetNthFrame (null when out of range). */
  getNthFrame(n: number): StackElem | null {
    if (n < 0 || n >= this.frames.length) return null;
    let e = this.elems[n];
    if (!e || e.at !== this.frames[n]) {
      e = new StackElem(this, this.frames[n]!, n);
      this.elems[n] = e;
    }
    return e;
  }

  /** TreeStack::Reset: drops every frame (the memory is kept). */
  reset(): void {
    this.frames.length = 0;
    this.behaviors.length = 0;
  }

  /** TreeStack::Pop. */
  pop(): void {
    this.frames.pop();
    this.behaviors.length = this.frames.length;
  }

  /** TreeStack::GetMemUsed (shorts). */
  private memUsed(): number {
    const n = this.frames.length;
    if (n === 0) return 0;
    const last = this.frames[n - 1]!;
    const counts = this.mem[last + F_COUNTS]!;
    return last + frameShorts(counts & 0xff, (counts >> 8) & 0xff);
  }

  /** TreeStack::MakeNewFrame. */
  private makeNewFrame(shorts: number): number {
    const size = this.mem.length;
    const used = this.memUsed();
    if (size - used < shorts) {
      // Byte sizes in the original: double, or max(0x200, 2 * frame) bytes, rounded to 8.
      let bytes = size * 2 * 2;
      if (bytes === 0) bytes = Math.max(0x200, shorts * 2 * 2);
      bytes = (bytes + 7) & ~7;
      const mem = new Int16Array(bytes >> 1);
      mem.set(this.mem);
      this.mem = mem;
    }
    return used;
  }

  /** TreeStack::Push: a new frame copying `t`, its parameters from `params` (none: left as is). */
  push(t: FrameTemplate, params: ParamSource | null): StackElem {
    const at = this.makeNewFrame(frameShorts(t.numLocals, t.numParams));
    const m = this.mem;
    m[at + F_TREE] = t.rawTree === 0xffff ? 0xffff : t.rawTree & 0x7fff;
    m[at + F_NODE] = t.node;
    m[at + F_STACKOBJ] = t.stackObj;
    m[at + F_COUNTS] = (t.numLocals & 0xff) | ((t.numParams & 0xff) << 8);
    m[at + F_STATE] = t.state & 0xffff;
    m[at + F_STATE + 1] = t.state >> 16;
    m[at + 6] = 0;
    m[at + 7] = 0;
    if (params) {
      for (let i = 0; i < t.numParams; i++) m[at + F_PARAMS + i] = params.src[params.at + i] ?? 0;
    }
    this.frames.push(at);
    this.behaviors[this.frames.length - 1] = t.behavior;
    return this.getNthFrame(this.frames.length - 1)!;
  }

  /**
   * TreeStack::ReconStream (version > 0x18): frames as saved, laid out with
   * GetNewFrame in a block of the saved size.
   */
  restore(memBytes: number, frames: readonly SavedFrameData[]): void {
    this.mem = new Int16Array(Math.max(0, memBytes) >> 1);
    this.reset();
    for (const f of frames) {
      const at = this.memUsed();
      const need = at + frameShorts(f.locals.length, f.params.length);
      if (need > this.mem.length) {
        const mem = new Int16Array(need);
        mem.set(this.mem);
        this.mem = mem;
      }
      const m = this.mem;
      m[at + F_TREE] = f.treeId;
      m[at + F_NODE] = f.node;
      m[at + F_STACKOBJ] = f.stackObj;
      m[at + F_COUNTS] = (f.locals.length & 0xff) | ((f.params.length & 0xff) << 8);
      m[at + F_STATE] = f.state & 0xffff;
      m[at + F_STATE + 1] = f.state >> 16;
      m.set(f.params, at + F_PARAMS);
      m.set(f.locals, at + F_PARAMS + f.params.length);
      this.frames.push(at);
      this.behaviors[this.frames.length - 1] = f.behavior;
    }
  }
}

/** One frame of a saved tree stack, as TreeStack::ReconStream reads it. */
export interface SavedFrameData {
  treeId: number;
  node: number;
  stackObj: number;
  params: Int16Array;
  locals: Int16Array;
  state: number;
  behavior: Behavior | null;
}
