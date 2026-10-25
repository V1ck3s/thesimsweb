/**
 * SAnimator (the person animator), the part that builds a person's
 * VitaBoy from its body strings and plays skills:
 *
 * - Animator::Initialize: FindSkeleton(body string 1), cloned per person.
 * - SAnimator::UpdateOutfitAndHands: head (3), current outfit (2 for day
 *   clothes), and the hand suits for hand state 0 (open): left 18, right 19.
 * - Animator::StartSkill -> VitaBoy::StartPractice.
 */

import { BodyStrings, BS } from "./bodystrings.js";
import { LoopMode } from "./practice.js";
import { VBAnimMgr } from "./vbanimmgr.js";
import { VitaBoy } from "./vitaboy.js";

/** The standing idle each skeleton starts with in the test views. */
const IDLE: Readonly<Record<string, string>> = {
  adult: "a2o-idle-armsdown-breathe",
  child: "c2o-idle-armsdown-breathe",
  dog: "d2o-stand-breathe-loop",
  kat: "k2o-stand-breathe-loop",
};

export class SAnimator {
  private constructor(
    readonly bodyStrings: BodyStrings,
    readonly vitaboy: VitaBoy,
  ) {}

  get skeletonName(): string {
    return this.vitaboy.skeleton.name;
  }

  static async fromBodyStrings(strings: readonly string[], mgr?: VBAnimMgr): Promise<SAnimator | null> {
    const m = mgr ?? (await VBAnimMgr.get());
    const bs = new BodyStrings(strings);
    const skel = await m.findSkeleton(bs.get(BS.skeleton) || "adult");
    if (!skel) return null;
    const a = new SAnimator(bs, new VitaBoy(m, skel.clone()));
    await a.updateOutfitAndHands();
    return a;
  }

  /** Dress head, body and open hands from the body strings. */
  async updateOutfitAndHands(outfit: number = BS.body): Promise<void> {
    const slots: Array<[string, number]> = [
      ["head", BS.head],
      ["body", outfit],
      ["lhand", BS.leftHandOpen],
      ["rhand", BS.rightHandOpen],
    ];
    await Promise.all(
      slots.map(([slot, index]) => {
        const { suit, texture } = this.bodyStrings.getSuitAndTexture(index);
        // "NONE" (pets' head entry) means nothing to wear.
        return suit && suit !== "none" ? this.vitaboy.dress(slot, suit, texture) : Promise.resolve(false);
      }),
    );
  }

  /** Animator::StartSkill by name. */
  async startSkill(name: string, loop: LoopMode = LoopMode.Loop): Promise<boolean> {
    const skill = await this.vitaboy.mgr.findSkill(name);
    if (!skill) {
      console.warn(`missing skill ${name}`);
      return false;
    }
    this.vitaboy.startPractice(skill, loop);
    return true;
  }

  /** Start the skeleton's standing idle loop. */
  startIdle(): Promise<boolean> {
    const name = IDLE[this.skeletonName.toLowerCase()];
    return name ? this.startSkill(name) : Promise.resolve(false);
  }

  /** Advance the animation to `now` (ms) and deform the meshes. */
  update(now: number): void {
    this.vitaboy.update(now);
  }
}
