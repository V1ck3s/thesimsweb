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

export class Suit {
  name = "";
  type = 0;
  props: Props | null = null;
  skins: Skin[] = [];

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
