/**
 * Skeleton and Bone (VitaBoy).
 *
 * File layout (Skeleton::ReadFromFile / Bone::ReadFromFile, CTGFile):
 *   Skeleton: name, boneCount, Bone[boneCount]
 *   Bone:     name, parentName ("NULL" for the root), hasProps (int) [Props],
 *             translation (3 floats), rotation (4 floats, x y z w),
 *             canTranslate, canRotate, canBlend, wiggleValue (ints), wigglePower (float)
 *
 * Quaternions are stored "conjugated": the identity is (0, 0, 0, -1).
 * Bone::UpdateTransform composes them exactly like the original, so the files
 * are used as they are.
 */

import { CTGFile, readProps, scanProps, type Props, type TextStream } from "./ctgfile.js";
import { quatMul, quatRotate, quatToM3, type Quat, type Vec3 } from "./math3d.js";

export class Bone {
  name = "";
  parentName = "";
  props: Props | null = null;
  /** +0x20 local translation, +0x2c local rotation (animated by practices). */
  translation: Vec3 = [0, 0, 0];
  rotation: Quat = [0, 0, 0, 1];
  canTranslate = 1;
  canRotate = 1;
  canBlend = 1;
  wiggleValue = 0;
  wigglePower = 0;
  parent: Bone | null = null;
  children: Bone[] = [];
  index = 0;
  /** +0x3c world position, +0x48 world rotation (stored convention), +0xb4 3x3 matrix. */
  worldPos: Vec3 = [0, 0, 0];
  worldRot: Quat = [0, 0, 0, 1];
  readonly matrix = new Float32Array(9);

  static read(f: CTGFile): Bone {
    const b = new Bone();
    b.name = f.readString();
    b.parentName = f.readString();
    if (f.readInteger() !== 0) b.props = readProps(f);
    b.translation = [f.readFloat(), f.readFloat(), f.readFloat()];
    b.rotation = [f.readFloat(), f.readFloat(), f.readFloat(), f.readFloat()];
    b.canTranslate = f.readInteger();
    b.canRotate = f.readInteger();
    b.canBlend = f.readInteger();
    b.wiggleValue = f.readInteger();
    b.wigglePower = f.readFloat();
    return b;
  }

  static scan(s: TextStream): Bone {
    const b = new Bone();
    b.name = s.line();
    b.parentName = s.line();
    if (s.int() !== 0) b.props = scanProps(s);
    b.translation = [s.float(), s.float(), s.float()];
    b.rotation = [s.float(), s.float(), s.float(), s.float()];
    b.canTranslate = s.int();
    b.canRotate = s.int();
    b.canBlend = s.int();
    b.wiggleValue = s.int();
    b.wigglePower = s.float();
    return b;
  }

  clone(): Bone {
    const b = new Bone();
    b.name = this.name;
    b.parentName = this.parentName;
    b.props = this.props;
    b.translation = [...this.translation];
    b.rotation = [...this.rotation];
    b.canTranslate = this.canTranslate;
    b.canRotate = this.canRotate;
    b.canBlend = this.canBlend;
    b.wiggleValue = this.wiggleValue;
    b.wigglePower = this.wigglePower;
    return b;
  }

  /**
   * Bone::UpdateTransform(parentPos, parentRot):
   *   worldRot = rotation * (parent.xyz, -parent.w), then w negated;
   *   worldPos = parentPos + R(parentRot) translation;
   *   matrix   = quattom3(worldRot.xyz, -worldRot.w)  (used as v * matrix);
   * then recurse into the children.
   */
  updateTransform(parentPos: Vec3, parentRot: Quat): void {
    const r = quatMul(this.rotation, [parentRot[0], parentRot[1], parentRot[2], -parentRot[3]]);
    r[3] = -r[3];
    this.worldRot = r;
    const t = quatRotate(parentRot, this.translation);
    this.worldPos = [Math.fround(parentPos[0] + t[0]), Math.fround(parentPos[1] + t[1]), Math.fround(parentPos[2] + t[2])];
    quatToM3([r[0], r[1], r[2], -r[3]], this.matrix);
    for (const c of this.children) c.updateTransform(this.worldPos, this.worldRot);
  }
}

export class Skeleton {
  name = "";
  bones: Bone[] = [];
  root: Bone | null = null;
  private readonly byName = new Map<string, Bone>();

  static read(f: CTGFile): Skeleton {
    const s = new Skeleton();
    s.name = f.readString();
    const n = f.readInteger();
    for (let i = 0; i < n; i++) s.addBone(Bone.read(f));
    return s;
  }

  static scan(t: TextStream): Skeleton {
    const s = new Skeleton();
    s.name = t.line();
    const n = t.int();
    for (let i = 0; i < n; i++) s.addBone(Bone.scan(t));
    return s;
  }

  /** Skeleton::AddBone: link to the parent by name; the first parentless bone is the root. */
  addBone(b: Bone): void {
    b.index = this.bones.length;
    this.bones.push(b);
    this.byName.set(b.name, b);
    const p = this.byName.get(b.parentName);
    if (p) {
      b.parent = p;
      p.children.push(b);
    } else if (!this.root) {
      this.root = b;
    }
  }

  findBone(name: string): Bone | undefined {
    return this.byName.get(name);
  }

  /** Skeleton::Clone: every animated person owns its copy. */
  clone(): Skeleton {
    const s = new Skeleton();
    s.name = this.name;
    for (const b of this.bones) s.addBone(b.clone());
    return s;
  }

  /** Skeleton::UpdateBoneTransforms: root from the origin with the identity rotation. */
  updateBoneTransforms(): void {
    this.root?.updateTransform([0, 0, 0], [0, 0, 0, 1]);
  }
}
