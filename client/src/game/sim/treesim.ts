/**
 * TreeSim (TreeSim.cpp): the SimAntics interpreter loop shared by every
 * simulated object (cXObject derives from it).
 *
 * Fields (byte offsets of the original):
 *   +0x00 primitives run during the current Simulate (limit lbl_105BA2EC)
 *   +0x04 TreeStack
 *   +0x18 last transition (0xfe true / 0xff false, 0xfd initially)
 *   +0x1c last primitive result (bool)
 *   +0x20 default parameters (cXObject: its temps, +0x3a)
 *   +0x24 error code (0 = none)
 *   +0x28 vtable: TryElement +8, Error +0xc, StackJustPopped +0x10,
 *         HandleBreakpoint +0x14, Simulate +0x1c.
 *
 * Errors are C++ exceptions in the original (func_10587890 throws a short
 * code, Windows __CxxThrowException_8): TreeSim::Simulate catches them,
 * stores the code at +0x24, calls Error(code) and reports the tick as run.
 */

import { Behavior, BehaviorTree, TARGET_ERROR, TARGET_TRUE } from "./behavior.js";
import { TreeStack, type ParamSource, type StackElem } from "./treestack.js";

/** A SimAntics error (the thrown short). Codes are listed in sim-port.md. */
export class SimError extends Error {
  constructor(readonly code: number) {
    super(`SimAntics error ${code}`);
  }
}

/** Throw a SimAntics error (func_10587890 with lbl_105BBC98 / lbl_105BBB08). */
export function simThrow(code: number): never {
  throw new SimError(code);
}

/** TreeSim error codes thrown by the interpreter itself. */
export const ERR_STACK_UNDERFLOW = 0x3e9;
export const ERR_TREE_NOT_FOUND = 1000;
export const ERR_BAD_TRANSITION = 0x44c;
export const ERR_TOO_MANY_PRIMITIVES = 0x44d;
export const ERR_NODE_NOT_FOUND = 0x44e;
export const ERR_YIELD_IN_CHECK_TREE = 0x44f;

/** TryElement results. */
export const PRIM_FALSE = 0;
export const PRIM_TRUE = 1;
/** Stay on this node and end the object's tick. */
export const PRIM_WAIT = 2;
/** Continue without moving (the primitive pushed a frame). */
export const PRIM_CONTINUE = 3;
/** Error without a thrown code. */
export const PRIM_ERROR = -1;

/** Interpreter-wide state shared by every TreeSim (globals of the original). */
export const treeSimGlobals = {
  /** lbl_105BA2EC: primitives one object may run per tick (ObjectModule::AddObject sets it). */
  maxPrimitives: 10000,
  /** lbl_105BA314: 1 outside check trees (RunCheckTree clears it while it runs). */
  notInCheckTree: true,
};

export abstract class TreeSim {
  /** +0 */
  primitiveCount = 0;
  /** +4 */
  readonly stack = new TreeStack();
  /** +0x18 */
  lastTransition = TARGET_ERROR;
  /** +0x1c */
  lastResult = false;
  /** +0x24 */
  errorCode = 0;

  /** +0x20: where Gosub takes parameters when the caller gives none. */
  protected abstract defaultParams(): ParamSource;
  /** vtable +8 */
  abstract tryElement(elem: StackElem, tree: BehaviorTree, off: number): number;
  /** vtable +0xc */
  abstract error(code: number): void;
  /** vtable +0x10 (TreeSim's is empty). */
  stackJustPopped(): void {}

  /** TreeSim::GetStackSize */
  getStackSize(): number {
    return this.stack.getStackSize();
  }
  /** TreeSim::GetNthElem */
  getNthElem(n: number): StackElem | null {
    return this.stack.getNthFrame(n);
  }
  /** TreeSim::GetCurElem */
  getCurElem(): StackElem | null {
    return this.stack.getNthFrame(this.stack.getStackSize() - 1);
  }
  /** TreeSim::GetError */
  getError(): number {
    return this.errorCode;
  }
  /** TreeSim::GetLastTransition */
  getLastTransition(): boolean {
    return this.lastTransition === TARGET_TRUE;
  }

  /** TreeSim::GetMainSimElem: the frame below the first frame without a tree (the top when none). */
  getMainSimElem(): StackElem | null {
    const top = this.getStackSize() - 1;
    for (let i = 0; i <= top; i++) {
      if (this.getNthElem(i)!.getTreeID() === -1) return i - 1 === -1 ? null : this.getNthElem(i - 1);
    }
    return top === -1 ? null : this.getNthElem(top);
  }

  /** TreeSim::GetHighLevelAction: the lowest frame of the run of frames sharing the top frame's Behavior. */
  getHighLevelAction(): StackElem | null {
    const cur = this.getCurElem();
    if (!cur) return null;
    let i = this.getStackSize() - 2;
    while (i >= 0 && this.getNthElem(i)!.behavior === cur.behavior) i--;
    return i < 0 ? this.getNthElem(0) : this.getNthElem(i + 1);
  }

  /** TreeSim::GetCurrentPrimitive */
  getCurrentPrimitive(): number {
    const e = this.getCurElem();
    const ref = e?.behavior?.getNodeRef(e.getTreeID(), e.node);
    return ref ? ref.tree.primitive(ref.off) & 0x7fff : -1;
  }

  /** TreeSim::Initialize: TreeStack::Initialize only reserves memory. */
  initializeTreeSim(): void {}

  /**
   * TreeSim::Simulate: runs nodes until one yields (true) or the stack
   * breaks (false). A thrown error is caught: +0x24 = code, Error(code),
   * and the tick counts as run.
   */
  simulateTrees(): boolean {
    this.primitiveCount = 0;
    try {
      for (;;) {
        const r = this.doNodeAction(this.getCurElem());
        if (r === 1) return true;
        if (r === 2) return false;
      }
    } catch (e) {
      if (!(e instanceof SimError)) throw e;
      this.errorCode = e.code;
      this.error(e.code);
      return true;
    }
  }

  /** Pop the current frame (TreeStack::Pop + StackJustPopped), checking there is a caller. */
  private popFrame(): void {
    if (this.getStackSize() < 2) simThrow(ERR_STACK_UNDERFLOW);
    this.stack.pop();
    this.stackJustPopped();
  }

  /**
   * TreeSim::DoNodeAction. Returns 0 to keep going, 1 when the object's tick
   * is over (a primitive waits), 2 on an unexpected primitive result.
   */
  doNodeAction(elem: StackElem | null): number {
    if (!elem) simThrow(ERR_STACK_UNDERFLOW);
    const beh = elem.behavior;
    if (!beh) {
      this.popFrame();
      return 0;
    }
    // Breakpoints (+0 bit 15) are cleared by HandleBreakpoint, which then runs the node.
    if (elem.rawTree !== 0xffff && elem.rawTree & 0x8000) elem.rawTree = elem.rawTree & 0x7fff;
    const n = elem.node;
    if (n < 0 || n > 0xfa) {
      if (n === TARGET_ERROR || n < TARGET_ERROR || n > 0xff) simThrow(ERR_BAD_TRANSITION);
      // Return from this tree to the caller's node.
      this.popFrame();
      const caller = this.getCurElem()!;
      this.lastResult = n === TARGET_TRUE;
      if (caller.state === 0) {
        const ref = caller.behavior?.getNodeRef(caller.getTreeID(), caller.node) ?? null;
        if (!ref) simThrow(ERR_NODE_NOT_FOUND);
        const to = n === TARGET_TRUE ? ref.tree.trueTarget(ref.off) : ref.tree.falseTarget(ref.off);
        if (to === TARGET_ERROR) simThrow(ERR_BAD_TRANSITION);
        caller.node = to;
        this.lastTransition = to;
      }
      return 0;
    }
    const ref = beh.getNodeRef(elem.getTreeID(), n);
    if (!ref) simThrow(ERR_NODE_NOT_FOUND);
    const { tree, off } = ref;
    const raw = tree.primitive(off);
    if (raw & 0x8000) {
      // HandleBreakpoint: clears the bits and runs the node.
      tree.view.setUint16(off, raw & 0x7fff, true);
      return this.doNodeAction(elem);
    }
    if (++this.primitiveCount >= treeSimGlobals.maxPrimitives) simThrow(ERR_TOO_MANY_PRIMITIVES);
    if (raw < 0x100) {
      const r = this.tryElement(elem, tree, off);
      if (r === PRIM_TRUE || r === PRIM_FALSE) {
        const to = r === PRIM_TRUE ? tree.trueTarget(off) : tree.falseTarget(off);
        if (to === TARGET_ERROR) simThrow(ERR_BAD_TRANSITION);
        elem.node = to;
        this.lastTransition = to;
        this.lastResult = r === PRIM_TRUE;
        elem.state = 0;
        return 0;
      }
      if (r === PRIM_CONTINUE) return 0;
      if (r === PRIM_WAIT) return 1;
      return 2;
    }
    // A subroutine call: operands are its parameters unless both words are -1 (use the default ones).
    const allUnset = tree.view.getInt32(off + 4, true) === -1 && tree.view.getInt32(off + 8, true) === -1;
    const params: ParamSource | null = allUnset ? null : { src: shortsOf(tree.bytes), at: (off + 4) >> 1 };
    if (!this.gosub(null, params, raw)) {
      simThrow(beh.getTree(raw) ? ERR_TREE_NOT_FOUND : ERR_NODE_NOT_FOUND);
    }
    return 0;
  }

  /**
   * TreeSim::RunCheckTree: runs `treeId` to completion right now on a frame
   * above the current stack (a sentinel frame with no tree marks the
   * bottom). Returns the tree's result; primitives must not wait. Nothing
   * runs (false) while a tree error is pending (+0x24, cleared by Reset):
   * cXObject::HandleError's Cleanup does not run the object's Cleanup tree.
   */
  runCheckTree(beh: Behavior | null, stackObj: number, treeId: number, params: ParamSource | null): boolean {
    if (this.errorCode !== 0) return false;
    this.stack.push({ rawTree: 0xffff, node: 0, stackObj: 0, numLocals: 0, numParams: 0, state: 1, behavior: null }, null);
    if (!this.gosub(beh, params, treeId)) {
      this.stack.pop();
      this.stackJustPopped();
      return false;
    }
    this.getCurElem()!.stackObj = stackObj;
    const savedFlag = treeSimGlobals.notInCheckTree;
    treeSimGlobals.notInCheckTree = false;
    const savedCount = this.primitiveCount;
    this.primitiveCount = 0;
    // The original restores the flag and counter only on a normal exit (an
    // error thrown inside leaves lbl_105BA314 cleared); they are restored on
    // both paths here.
    try {
      for (;;) {
        const cur = this.getCurElem()!;
        if (cur.getTreeID() === -1) break;
        const r = this.doNodeAction(cur);
        if (r === 1 || r === 2) simThrow(ERR_YIELD_IN_CHECK_TREE);
      }
      this.stack.pop();
      this.stackJustPopped();
    } finally {
      this.primitiveCount = savedCount;
      treeSimGlobals.notInCheckTree = savedFlag;
    }
    return this.lastTransition === TARGET_TRUE;
  }

  /** TreeSim::RunOneTickTree is RunCheckTree. */
  runOneTickTree(beh: Behavior | null, stackObj: number, treeId: number, params: ParamSource | null): boolean {
    return this.runCheckTree(beh, stackObj, treeId, params);
  }

  /**
   * TreeSim::Gosub: pushes `treeId` of `beh` (the current frame's Behavior
   * when null) with the current frame's stack object.
   */
  gosub(beh: Behavior | null, params: ParamSource | null, treeId: number): boolean {
    const cur = this.getCurElem();
    const b = beh ?? cur?.behavior ?? null;
    if (!b) return false;
    const tree = b.getTree(treeId);
    if (!tree) return false;
    const src = params ?? this.defaultParams();
    let start = 0;
    if (tree.treeType === 4) {
      start = src.src[src.at] ?? 0;
      if (start >= tree.count) start = tree.count - 1;
    }
    if (start < 0 || start >= tree.count) return false;
    const sig = tree.signature;
    let locals: number;
    let args: number;
    if (sig < -0x7ffe) {
      // 0x8000 / 0x8001 trees: no locals (0x8001: header value, at most 4), four parameters (0x8001: at most 4).
      locals = sig === -0x7fff ? Math.min(tree.localCount, 4) : 0;
      args = sig === -0x7fff ? Math.min(tree.argCount, 4) : 4;
    } else {
      locals = tree.localCount;
      args = tree.argCount;
    }
    this.stack.push(
      {
        rawTree: treeId & 0xffff,
        node: start,
        stackObj: cur ? cur.stackObj : 0,
        numLocals: locals,
        numParams: args,
        state: 0,
        behavior: b,
      },
      src,
    );
    return true;
  }

  /** TreeSim::Reset: a new stack holding only `treeId`, error cleared. */
  resetTree(beh: Behavior | null, treeId: number): void {
    this.stack.reset();
    this.gosub(beh, { src: [0, 0, 0, 0, 0, 0, 0, 0], at: 0 }, treeId);
    this.errorCode = 0;
  }
}

const shortViews = new WeakMap<Uint8Array, Int16Array>();

/** The node bytes read as little-endian shorts (operands are copied as parameters). */
function shortsOf(bytes: Uint8Array): Int16Array {
  let s = shortViews.get(bytes);
  if (!s) {
    s = new Int16Array(bytes.length >> 1);
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < s.length; i++) s[i] = v.getInt16(i * 2, true);
    shortViews.set(bytes, s);
  }
  return s;
}
