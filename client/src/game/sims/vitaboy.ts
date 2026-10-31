/**
 * VitaBoy: one animated character (skeleton instance, dressings, practices).
 *
 * Per frame (Animator::UpdatePose / VitaBoy::Deform): Skeleton::ApplyPractices
 * sets the bones' local transforms from the playing skills,
 * Skeleton::UpdateBoneTransforms composes them from the root, and every
 * dressing deforms its meshes (DeformableMesh::TransformVertices + Blend).
 */

import type { RgbaImage } from "../res/bmp.js";
import type { SkeletonBinding } from "./deformablemesh.js";
import { LoopMode, Practice } from "./practice.js";
import type { Skeleton } from "./skeleton.js";
import type { Skill } from "./skill.js";
import type { VBAnimMgr } from "./vbanimmgr.js";

/** One skin of a worn suit (VBAnimMgrMakeDressingData's result) and its texture. */
export interface DressingMesh {
  binding: SkeletonBinding;
  image: RgbaImage | null;
}

/** Dressing: a suit bound to the skeleton (Dressing::Bind over the suit's skins). */
export interface Dressing {
  suit: string;
  texture: string;
  meshes: DressingMesh[];
}

export class VitaBoy {
  /** Worn suits by slot ("body", "head", "lhand", "rhand", ...). */
  readonly dressings = new Map<string, Dressing>();
  readonly practices: Practice[] = [];
  /**
   * SAnimator +0x248 / +0x24c: the censor suit's dressing (Skeleton::Dress
   * with the person's censorship flags as the skin mask) and that mask. Not
   * drawn: SAnimator::Render projects its vertices to place the censor
   * rectangle.
   */
  censor: { mask: number; dressing: Dressing } | null = null;
  /** Bumped whenever the deformed vertices change (renderers re-upload). */
  version = 0;

  constructor(
    readonly mgr: VBAnimMgr,
    /** Skeleton::Clone of the shared skeleton. */
    readonly skeleton: Skeleton,
  ) {
    skeleton.updateBoneTransforms();
  }

  /**
   * DressingRecord::Dress / Skeleton::Dress: wear `suitName` in `slot`
   * (replacing what was there) with a body-string texture spec ("KEY=name").
   */
  async dress(slot: string, suitName: string, texture: string): Promise<boolean> {
    if (!suitName) return false;
    const suit = await this.mgr.findSuit(suitName);
    if (!suit) {
      console.warn(`missing suit ${suitName}`);
      return false;
    }
    const meshes: DressingMesh[] = [];
    for (const skin of suit.skins) {
      if (!this.skeleton.findBone(skin.boneName)) continue;
      const mesh = await this.mgr.loadDeformableMesh(skin.meshName);
      if (!mesh) {
        console.warn(`missing mesh ${skin.meshName}`);
        continue;
      }
      const binding = mesh.bind(this.skeleton, texture || null);
      if (!binding) continue;
      binding.deform();
      meshes.push({ binding, image: await this.mgr.loadTexture(binding.texture) });
    }
    this.dressings.set(slot, { suit: suitName, texture, meshes });
    this.version++;
    return meshes.length > 0;
  }

  /**
   * Skeleton::Dress(suit, 0, 0, mask) -> Dressing::Bind: only the skins whose
   * censor flags (Skin +0x10) share a bit with `mask` are bound.
   */
  async dressCensor(suitName: string, mask: number): Promise<Dressing> {
    const suit = await this.mgr.findSuit(suitName);
    const meshes: DressingMesh[] = [];
    for (const skin of suit?.skins ?? []) {
      if ((skin.censorFlags & mask) === 0 || !this.skeleton.findBone(skin.boneName)) continue;
      const mesh = await this.mgr.loadDeformableMesh(skin.meshName);
      const binding = mesh?.bind(this.skeleton, null);
      if (!binding) continue;
      binding.deform();
      meshes.push({ binding, image: null });
    }
    return { suit: suitName, texture: "", meshes };
  }

  undress(slot: string): void {
    if (this.dressings.delete(slot)) this.version++;
  }

  /** VitaBoy::StartPractice with a loaded skill; replaces the running practices. */
  startPractice(skill: Skill, loop: LoopMode = LoopMode.Loop): Practice {
    const p = new Practice(skill, this.skeleton, loop);
    this.practices.length = 0;
    this.practices.push(p);
    return p;
  }

  /** Apply the practices at `now` (ms), update the bones and deform the meshes. */
  update(now: number): void {
    for (const p of this.practices) p.apply(now);
    this.skeleton.updateBoneTransforms();
    for (const d of this.dressings.values()) for (const m of d.meshes) m.binding.deform();
    if (this.censor) for (const m of this.censor.dressing.meshes) m.binding.deform();
    this.version++;
  }
}
