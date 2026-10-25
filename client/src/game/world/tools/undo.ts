/**
 * Undoable and UndoManager (cGameTools +8): every build mode change is an
 * Undoable submitted to the manager; Undo / Redo walk its two lists.
 *
 * Undoable states (+4): 0 new, 1 done, 2 undone, 3 failed. The virtual
 * CommitSelf (+0x20), UndoSelf (+0x24) and RedoSelf (+0x28) return 0 on
 * success. Pre / post sub-undoables are committed when added; an owner's
 * UndoSelf / RedoSelf runs them (Undoable::UndoPreSubs etc.), undoing in
 * reverse order.
 */

export const enum UndoState {
  New = 0,
  Done = 1,
  Undone = 2,
  Failed = 3,
}

export abstract class Undoable {
  /** +4 */
  state: UndoState = UndoState.New;
  /** +0xc / +0x18 */
  private readonly preSubs: Undoable[] = [];
  private readonly postSubs: Undoable[] = [];

  /** CommitSelf: performs the change the first time; 0 on success. */
  protected abstract commitSelf(): number;
  /** UndoSelf: reverts it; 0 on success. */
  protected abstract undoSelf(): number;
  /** RedoSelf: performs it again (CommitSelf by default). */
  protected redoSelf(): number {
    return this.commitSelf();
  }

  /** Undoable::GetState */
  getState(): UndoState {
    return this.state;
  }

  /** Undoable::Commit */
  commit(): number {
    const r = this.commitSelf();
    this.state = r === 0 ? UndoState.Done : UndoState.Failed;
    return r;
  }

  /** Undoable::UndoIt: commits a new undoable first, then UndoSelf (which runs the sub-undoables itself). */
  undoIt(): number {
    if (this.state === UndoState.New) {
      this.commit();
      if (this.getState() !== UndoState.Done) return 1;
    }
    const r = this.undoSelf();
    this.state = r === 0 ? UndoState.Undone : UndoState.Failed;
    return r;
  }

  /** Undoable::RedoIt */
  redoIt(): number {
    const r = this.redoSelf();
    this.state = r === 0 ? UndoState.Done : UndoState.Failed;
    return r;
  }

  /** Undoable::AddPreSubUndoable: committed now, undone after the owner. */
  addPreSubUndoable(u: Undoable): void {
    u.commit();
    this.preSubs.push(u);
  }

  /** Undoable::AddPostSubUndoable: committed now, undone before the owner. */
  addPostSubUndoable(u: Undoable): void {
    u.commit();
    this.postSubs.push(u);
  }

  private static undoList(list: readonly Undoable[]): boolean {
    for (let i = list.length - 1; i >= 0; i--) {
      const u = list[i]!;
      if (u.state === UndoState.New && u.commit() !== 0) return true;
      const r = u.undoSelf();
      u.state = r === 0 ? UndoState.Undone : UndoState.Failed;
      if (r !== 0) return true;
    }
    return false;
  }

  private static redoList(list: readonly Undoable[]): boolean {
    for (const u of list) {
      const r = u.redoSelf();
      u.state = r === 0 ? UndoState.Done : UndoState.Failed;
      if (r !== 0) return true;
    }
    return false;
  }

  /** Undoable::UndoPreSubs / UndoPostSubs / RedoPreSubs / RedoPostSubs (true on failure). */
  protected undoPreSubs(): boolean {
    return Undoable.undoList(this.preSubs);
  }
  protected undoPostSubs(): boolean {
    return Undoable.undoList(this.postSubs);
  }
  protected redoPreSubs(): boolean {
    return Undoable.redoList(this.preSubs);
  }
  protected redoPostSubs(): boolean {
    return Undoable.redoList(this.postSubs);
  }

  /** Undoable::FreeSubUndoables */
  freeSubUndoables(): void {
    this.preSubs.length = 0;
    this.postSubs.length = 0;
  }
}

/** An Undoable over two closures (small changes: funds, a single array write...). */
export class FnUndoable extends Undoable {
  constructor(
    private readonly doFn: () => number | void,
    private readonly undoFn: () => number | void,
  ) {
    super();
  }
  protected commitSelf(): number {
    return this.doFn() ?? 0;
  }
  protected undoSelf(): number {
    return this.undoFn() ?? 0;
  }
}

/** UndoManager (cGameTools +8). */
export class UndoManager {
  /** +4 undo list, +0x10 redo list. */
  private readonly undoList: Undoable[] = [];
  private readonly redoList: Undoable[] = [];
  /** GlobalDispatch(0xee): the undo / redo lists changed (cWinArch refreshes its buttons). */
  onChange: (() => void) | null = null;

  canUndo(): boolean {
    return this.undoList.length > 0;
  }

  canRedo(): boolean {
    return this.redoList.length > 0;
  }

  /** UndoManager::SubmitUndoable: commits it if needed, then makes it the last command. */
  submitUndoable(u: Undoable): void {
    if (u.getState() !== UndoState.Done && u.commit() !== 0) {
      this.flushCommandQueues();
      return;
    }
    if (u.getState() === UndoState.Done) {
      this.undoList.push(u);
      this.releaseRedoList();
    }
    this.onChange?.();
  }

  /** UndoManager::UndoLastCommand */
  undoLastCommand(): void {
    const u = this.undoList[this.undoList.length - 1];
    if (!u) return;
    if (u.undoIt() === 0) {
      this.redoList.push(u);
      this.undoList.pop();
    } else {
      this.releaseUndoList();
    }
    this.onChange?.();
  }

  /** UndoManager::RedoLastCommand */
  redoLastCommand(): void {
    const u = this.redoList[this.redoList.length - 1];
    if (!u) return;
    if (u.redoIt() === 0) {
      this.undoList.push(u);
      this.redoList.pop();
    } else {
      this.releaseRedoList();
    }
    this.onChange?.();
  }

  releaseRedoList(): void {
    this.redoList.length = 0;
  }

  releaseUndoList(): void {
    this.undoList.length = 0;
  }

  /** UndoManager::FlushCommandQueues */
  flushCommandQueues(): void {
    this.releaseUndoList();
    this.releaseRedoList();
  }
}
