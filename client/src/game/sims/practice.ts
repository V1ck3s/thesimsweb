/**
 * Practice: one skill playing on one skeleton (Skill::NewPractice,
 * Practice::Bind, Practice::Apply).
 *
 * Apply advances the play position by the elapsed time over the skill's
 * duration, wraps or clamps it by loop mode, and samples every bound motion:
 * frame = frameCount * position, translations lerped and rotations blended
 * (BlendQuats1) between the two surrounding frames. When the elapsed time
 * spans two frames or more the game skips interpolation and uses the lower
 * frame. A weight below 1 blends the result over the bone's current pose.
 */

import { blendQuats1, type Quat } from "./math3d.js";
import type { Bone, Skeleton } from "./skeleton.js";
import type { Motion, Skill } from "./skill.js";

export const LoopMode = {
  /** Play once and hold the last frame. */
  Hold: 0,
  Loop: 1,
  PingPong: 2,
} as const;
export type LoopMode = (typeof LoopMode)[keyof typeof LoopMode];

interface Association {
  bone: Bone;
  motion: Motion;
}

export class Practice {
  /** +0x28 play position in [0, 1]. */
  position = 0;
  /** +0x24 direction (sign of the speed). */
  speed = 1;
  /** +0x2c blend weight. */
  weight = 1;
  /** +0x3c set when a non-looping practice reached its end. */
  finished = false;
  private lastTime: number | null = null;
  private readonly assoc: Association[] = [];
  private readonly frameCount: number;

  constructor(
    readonly skill: Skill,
    skeleton: Skeleton,
    readonly loop: LoopMode = LoopMode.Loop,
  ) {
    for (const motion of skill.motions) {
      const bone = skeleton.findBone(motion.boneName);
      if (bone) this.assoc.push({ bone, motion });
    }
    this.frameCount = skill.motions[0]?.frameCount ?? 0;
  }

  /** Practice::Apply at time `now` (ms). */
  apply(now: number): void {
    const dt = this.lastTime === null ? 0 : now - this.lastTime;
    this.lastTime = now;
    const n = this.frameCount;
    const skill = this.skill;
    if (n === 0 || !skill.translations || !skill.rotations) return;
    const duration = skill.duration;
    if (Math.abs(this.speed) > 1e-6 && duration > 0) this.position += (this.speed < 0 ? -dt : dt) / duration;
    if (this.position < 0 || this.position > 1) {
      if (this.loop === LoopMode.Loop) {
        this.position -= Math.floor(this.position);
      } else if (this.loop === LoopMode.PingPong) {
        this.speed = -this.speed;
        const fr = this.position - Math.floor(this.position);
        this.position = 1 - fr;
      } else {
        this.position = this.position < 0 ? 0 : 1;
        this.finished = true;
      }
    }

    const fpos = n * this.position;
    let i0 = Math.floor(fpos);
    if (i0 < 0) i0 = 0;
    else if (i0 >= n) i0 = n - 1;
    let i1 = i0;
    let t = 0;
    const noInterp = 2 * (duration / n) <= dt;
    if (!noInterp) {
      i1 = i0 + 1;
      if (i1 >= n) i1 = this.loop === LoopMode.Loop ? 0 : i0;
      t = fpos - i0;
    }
    const tr = skill.translations;
    const ro = skill.rotations;
    const w = this.weight;
    for (const { bone, motion } of this.assoc) {
      if (motion.hasTranslation) {
        const a = (motion.translationOffset + i0) * 3;
        const b = (motion.translationOffset + i1) * 3;
        for (let c = 0; c < 3; c++) {
          const v = (1 - t) * tr[a + c]! + t * tr[b + c]!;
          bone.translation[c] = w >= 1 ? v : w * v + (1 - w) * bone.translation[c]!;
        }
      }
      if (motion.hasRotation) {
        const a = (motion.rotationOffset + i0) * 4;
        const b = (motion.rotationOffset + i1) * 4;
        const q0: Quat = [ro[a]!, ro[a + 1]!, ro[a + 2]!, ro[a + 3]!];
        const q1: Quat = [ro[b]!, ro[b + 1]!, ro[b + 2]!, ro[b + 3]!];
        let q = q0;
        if (1 - t > 0.01 && differs(q0, q1)) q = blendQuats1(1 - t, q0, q1);
        bone.rotation = w >= 1 ? q : differs(q, bone.rotation) ? blendQuats1(w, q, bone.rotation) : q;
      }
    }
  }
}

/** Any component further apart than 1e-5 (the comparison loops in Apply). */
function differs(a: Quat, b: Quat): boolean {
  for (let i = 0; i < 4; i++) if (Math.abs(a[i]! - b[i]!) > 1e-5) return true;
  return false;
}
