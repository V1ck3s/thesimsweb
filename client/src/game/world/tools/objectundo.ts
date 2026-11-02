/**
 * ObjectUndoable and ObjectState (ObjectUndoable.cpp): a buy / build mode
 * object change as an Undoable. cMoveTool makes one for every object it
 * holds (+0x30): a new purchase (action 0, create, with the price), a
 * picked-up object (1, move), and Deselect turns a held object into a
 * delete (3). DropObject submits it to the UndoManager; Cancel takes it back
 * with UndoLastCommand. The ctrl-delete of doors and windows submits a
 * delete too.
 *
 * Two ObjectStates (+0x40 before, +0x64 after: CommitSelf) record where the
 * object stands: a handle into the object handle table (lbl_105BA56C), the
 * position, level, direction, container and slot, the selector. Killing
 * through a state (ObjectState::KillObject) only takes the object out of the
 * world (UserPickup): it stays in the module, held by its handle, until the
 * last state holding the handle goes (ObjectState::RemoveEntry kills an
 * object still out of the world then). The undoables are released by the
 * manager's lists (CPState::SetMode flushes them when leaving buy / build).
 *
 * The objects in the slots of the object (every part of a multi-tile one)
 * get their own ObjectUndoables with the same action (+0x2c), run after the
 * owner's own change.
 */

import type { ObjectFolder } from "../objectfolder.js";
import type { XObject } from "../objects.js";
import type { ObjSelector } from "../objselector.js";
import { EP, ObjFnTable } from "../../sim/objfntable.js";
import { killObject, makeNewOutOfWorldObject } from "./objectfactory.js";
import type { FPt, Placement } from "./placement.js";
import { Undoable } from "./undo.js";

/** ObjectUndoable::Action (+0x38). */
export const ObjectAction = {
  Create: 0,
  Move: 1,
  Delete: 3,
} as const;

/** The tool an ObjectUndoable charges or refunds through (+0x28: cTool +0x1c running total, +0x20 expense type). */
export interface ObjectUndoTool {
  expenseType: number;
  purchase(n: number): void;
  refund(n: number): void;
  finalizePurchase(): void;
}

/** ObjectHandleEntry (0x14 bytes): +0 object id, +4 references, +8 handle, +0xc object, +0x10 killed. */
interface HandleEntry {
  id: number;
  refs: number;
  handle: number;
  obj: XObject | null;
  killed: boolean;
}

/** The handle table lbl_105BA56C and the next handle lbl_105BF230, one per lot module. */
class HandleTable {
  readonly entries: HandleEntry[] = [];
  private next = 1;

  constructor(
    readonly p: Placement,
    readonly folder: ObjectFolder,
  ) {}

  /** ObjectState::GetHandle(id): the object's entry (made on first use), one more reference. */
  getHandle(id: number): number {
    if (id === 0) return 0;
    let e = this.entries.find((x) => x.id === id);
    if (!e) {
      e = { id, refs: 0, handle: this.next++, obj: this.p.get(id), killed: false };
      this.entries.push(e);
    }
    e.refs++;
    return e.handle;
  }

  byHandle(handle: number): HandleEntry | null {
    return handle === 0 ? null : (this.entries.find((x) => x.handle === handle) ?? null);
  }

  /** The entry's object while it is still the module's object of that id. */
  object(e: HandleEntry): XObject | null {
    const o = e.obj;
    return o && this.p.module.objects.get(e.id) === o ? o : null;
  }

  /** The state's reference goes; ObjectState::RemoveEntry at the last one. */
  releaseHandle(handle: number): void {
    const e = this.byHandle(handle);
    if (!e || --e.refs > 0) return;
    this.removeEntry(e);
  }

  /** ObjectState::RemoveEntry: an object left out of the world is killed. */
  private removeEntry(e: HandleEntry): void {
    const i = this.entries.indexOf(e);
    if (i >= 0) this.entries.splice(i, 1);
    const o = this.object(e);
    if (o && !this.p.isInWorld(o)) killObject(this.p, o);
    e.obj = null;
  }
}

const tables = new WeakMap<Placement, HandleTable>();

function handleTable(p: Placement, folder: ObjectFolder): HandleTable {
  let t = tables.get(p);
  if (!t) {
    t = new HandleTable(p, folder);
    tables.set(p, t);
  }
  return t;
}

/** ObjectState (0x24 bytes): +0 handle, +4 / +8 position, +0xc level, +0x10 direction, +0x14 container, +0x18 slot, +0x1c selector, +0x20 valid. */
class ObjectState {
  handle = 0;
  at: FPt = { fx: 0, fy: 0 };
  level = 0;
  dir = 0;
  containerId = 0;
  slot = 0;
  selector: ObjSelector | null = null;
  valid = false;

  constructor(private readonly t: HandleTable) {}

  private get p(): Placement {
    return this.t.p;
  }

  /** The state's object (the entry's, while it exists), or null. */
  object(): XObject | null {
    if (!this.valid) return null;
    const e = this.t.byHandle(this.handle);
    return e ? this.t.object(e) : null;
  }

  /**
   * ObjectState::AssignFromObject(id) (10179140): once only. A part of a
   * multi-tile object that is not dynamic (no entry point 8) stands for its
   * lead. Id 0 takes no handle and leaves the state invalid.
   */
  assignFromObject(id: number): boolean {
    if (this.valid) return false;
    if (id === 0) {
      this.handle = this.t.getHandle(0);
      return true;
    }
    let obj = this.p.get(id);
    if (!obj) return false;
    if (this.p.isMultiTile(obj) && ObjFnTable.forSelector(obj.selector).getTreeID(EP.dynamicMultiTileUpdate) === 0) {
      obj = this.p.chain(obj)[0]!;
    }
    this.handle = this.t.getHandle(obj.objectId);
    this.valid = true;
    // cXObject::GetPlacementInfo.
    const spec = this.p.getPlacementSpec(obj);
    this.at = { fx: spec.fx, fy: spec.fy };
    this.level = spec.level;
    this.containerId = spec.container?.objectId ?? 0;
    this.slot = spec.slot;
    this.selector = obj.selector;
    this.dir = obj.dir;
    return true;
  }

  /** ObjectState::KillObject (10178a40): UserPickup, the entry marked killed (the object lives on). */
  killObject(): boolean {
    if (!this.valid) return false;
    const e = this.t.byHandle(this.handle);
    if (!e) return false;
    const o = this.t.object(e);
    if (o) {
      this.p.userPickup(o);
      e.killed = true;
    }
    return true;
  }

  /**
   * ObjectState::CreateObject (10178c30): a killed object comes back (a
   * new one of the master selector when it is gone; it must get the same
   * id), then InvokeOntoObject; killed again when that fails.
   */
  createObject(): boolean {
    const e = this.t.byHandle(this.handle);
    if (!e) return false;
    if (!this.object()) {
      if (!this.selector) return false;
      const made = makeNewOutOfWorldObject(this.p, this.t.folder, this.selector.getMasterSelector());
      if (!made) return false;
      if (made.objectId !== e.id) return false;
      e.obj = made;
    }
    e.killed = false;
    const ok = this.invokeOntoObject();
    if (!ok) this.killObject();
    return ok;
  }

  /**
   * ObjectState::InvokeOntoObject (10178f00): the object is picked up,
   * turned (at most 8 turns) to the recorded direction and placed where
   * the state says (UserCanPlace, UserPlace).
   */
  invokeOntoObject(): boolean {
    const o = this.object();
    if (!o) return false;
    const p = this.p;
    p.userPickup(o);
    for (let i = 0; i < 8 && this.dir !== o.dir; i++) p.turnObject(o, 1);
    if (this.dir !== o.dir) return false;
    p.assignOffsets(o);
    let container: XObject | null = null;
    if (this.containerId !== 0) {
      container = p.get(this.containerId);
      if (!container) return false;
    }
    if (!p.userCanPlace(o, this.at, this.level, container, this.slot)) return false;
    p.userPlace(o, this.at, this.level, container, this.slot);
    return true;
  }

  /** ObjectState::~ObjectState. */
  release(): void {
    if (this.valid) this.t.releaseHandle(this.handle);
    this.valid = false;
    this.handle = 0;
  }
}

export class ObjectUndoable extends Undoable {
  /** +0x24: the money taken (create) or given back (delete), charged back by the undo. */
  value: number;
  /** +0x2c: the contained objects' undoables. */
  private readonly children: ObjectUndoable[] = [];
  /** +0x38 */
  private action: number;
  /** +0x3c: a build mode object (OBJD +0x8a != 0): expense type 7, else 6. */
  private readonly build: boolean;
  /** +0x40 / +0x64: before and after. */
  private readonly initial: ObjectState;
  private readonly final: ObjectState;

  /** ObjectUndoable::ObjectUndoable(id, action, value, tool) (10179ff0). */
  constructor(
    p: Placement,
    folder: ObjectFolder,
    id: number,
    action: number,
    value: number,
    private readonly tool: ObjectUndoTool,
  ) {
    super();
    const t = handleTable(p, folder);
    this.initial = new ObjectState(t);
    this.final = new ObjectState(t);
    this.action = action;
    this.initial.assignFromObject(id);
    this.value = value;
    const obj = this.initial.object();
    this.build = !!obj && obj.selector.objd.i16(0x8a) !== 0;
    // The slots of every part (the multi-tile chain from the lead).
    for (const part of obj ? p.chain(obj) : []) {
      for (const s of part.objectSlots.slice(1)) {
        const c = p.get(s.containedId);
        if (c) this.children.push(new ObjectUndoable(p, folder, c.objectId, action, 0, tool));
      }
    }
  }

  /** ObjectUndoable::SetAction (10179870): the undoable and its children. */
  setAction(action: number): void {
    this.action = action;
    for (const c of this.children) c.setAction(action);
  }

  /** The tool's purchase / refund of `n` (negative: refund) with the object's expense type, paid now. */
  private charge(n: number): void {
    const t = this.tool;
    const saved = t.expenseType;
    t.expenseType = this.build ? 7 : 6;
    if (n < 0) t.refund(-n);
    else t.purchase(n);
    t.finalizePurchase();
    t.expenseType = saved;
  }

  /** ObjectUndoable::CommitSelf (10179730): the after state (none for a delete), then the children. */
  protected commitSelf(): number {
    if (this.action === ObjectAction.Delete) this.final.assignFromObject(0);
    else this.final.assignFromObject(this.initial.object()?.objectId ?? 0);
    for (const c of this.children) c.commitSelf();
    return 0;
  }

  /** ObjectUndoable::UndoSelf (10179530). */
  protected undoSelf(): number {
    if (this.undoPreSubs()) return 1;
    let r: number;
    if (this.action === ObjectAction.Delete) {
      r = this.initial.createObject() ? 0 : 1;
      if (r === 0) this.charge(this.value);
    } else if (this.action === ObjectAction.Create) {
      r = this.initial.killObject() ? 0 : 1;
      if (r === 0) this.charge(-this.value);
    } else if (this.action > 0 && this.action < 3) {
      r = this.initial.invokeOntoObject() ? 0 : 1;
    } else {
      r = 1;
    }
    for (const c of this.children) c.undoSelf();
    if (r === 0 && this.undoPostSubs()) r = 1;
    return r;
  }

  /** ObjectUndoable::RedoSelf (10179300). */
  protected override redoSelf(): number {
    if (this.redoPostSubs()) return 1;
    let r: number;
    if (this.action === ObjectAction.Delete) {
      for (const c of this.children) c.redoSelf();
      r = this.initial.killObject() ? 0 : 1;
      if (r === 0) this.charge(-this.value);
    } else if (this.action === ObjectAction.Create) {
      r = this.final.createObject() ? 0 : 1;
      if (r === 0) this.charge(this.value);
    } else if (this.action > 0 && this.action < 3) {
      r = this.final.invokeOntoObject() ? 0 : 1;
    } else {
      r = 1;
    }
    if (this.action !== ObjectAction.Delete) for (const c of this.children) c.redoSelf();
    if (r === 0 && this.redoPreSubs()) r = 1;
    return r;
  }

  /** ObjectUndoable::~ObjectUndoable (10179cd0): the children, then both states. */
  protected override destroy(): void {
    for (const c of this.children) c.destroy();
    this.children.length = 0;
    this.final.release();
    this.initial.release();
    super.destroy();
  }
}
