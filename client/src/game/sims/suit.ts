/**
 * Suit and Skin (VitaBoy): a suit is a named set of skins, each skin a
 * deformable mesh attached to one bone.
 *
 *   Suit (Suit::ReadFromFile): name (lowercased), type (int), hasProps (int) [Props],
 *                              skinCount, Skin[skinCount]
 *   Skin (Skin::ReadFromFile): boneName, meshName, censorFlags (int), hasProps (int) [Props]
 *
 * The mesh is loaded on demand (VBAnimMgrMakeDressingData -> LoadDeformableMesh).
 */

import { readProps, scanProps, type CTGFile, type Props, type TextStream } from "./ctgfile.js";

export interface Skin {
  boneName: string;
  /** DeformableMesh file name without extension ("xskin-<suit>-<bone>-<part>"). */
  meshName: string;
  censorFlags: number;
  props: Props | null;
}

/**
 * lbl_105BA0DC: how long (ms) a suit no dressing wears stays loaded before
 * Suit::CanUnload lets it go. Globs::Globs sets 640000 when the machine has
 * 128 MB of memory or more (800000 below).
 */
const SUIT_UNLOAD_MS = 640000;

export class Suit {
  name = "";
  type = 0;
  props: Props | null = null;
  skins: Skin[] = [];
  /** +0x20's size: the dressings bound to the suit (Suit::NewDressing / UnbindDressing). */
  activeDressings = 0;
  /** +0x2c: the clock (lbl_105BA230) when the last dressing unbound (0: never). */
  lastUnbind = 0;

  /** Suit::NewDressing's bookkeeping: one more dressing holds the suit. */
  bindDressing(): void {
    this.activeDressings++;
  }

  /** Suit::UnbindDressing: when the last dressing goes, the clock is stamped. */
  unbindDressing(now: number): void {
    if (this.activeDressings <= 0) return;
    if (--this.activeDressings === 0) this.lastUnbind = now;
  }

  /**
   * Suit::CanUnload(now): only the manager holds it (reference count 1: no
   * dressing), a dressing has unbound, and SUIT_UNLOAD_MS have passed since.
   */
  canUnload(now: number): boolean {
    return this.activeDressings === 0 && this.lastUnbind !== 0 && this.lastUnbind + SUIT_UNLOAD_MS < now;
  }

  static read(f: CTGFile): Suit {
    const s = new Suit();
    s.name = f.readString().toLowerCase();
    s.type = f.readInteger();
    if (f.readInteger() !== 0) s.props = readProps(f);
    const n = f.readInteger();
    for (let i = 0; i < n; i++) {
      const boneName = f.readString();
      const meshName = f.readString();
      const censorFlags = f.readInteger();
      const props = f.readInteger() !== 0 ? readProps(f) : null;
      s.skins.push({ boneName, meshName, censorFlags, props });
    }
    return s;
  }

  static scan(t: TextStream): Suit {
    const s = new Suit();
    s.name = t.line().toLowerCase();
    s.type = t.int();
    if (t.int() !== 0) s.props = scanProps(t);
    const n = t.int();
    for (let i = 0; i < n; i++) {
      const boneName = t.line();
      const meshName = t.line();
      const censorFlags = t.int();
      const props = t.int() !== 0 ? scanProps(t) : null;
      s.skins.push({ boneName, meshName, censorFlags, props });
    }
    return s;
  }
}
