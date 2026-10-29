/**
 * SAnimator (the person animator), the part that builds a person's
 * VitaBoy from its body strings and plays skills:
 *
 * - Animator::Initialize: FindSkeleton(body string 1), cloned per person.
 * - SAnimator::UpdateOutfitAndHands: head, body, accessory and hands for
 *   the person's outfit and hand gestures (sims/outfit.ts), redressed only
 *   when the outfit, costume offset or a gesture changed (the original runs
 *   it from SAnimator::Render each frame); the "dress" / "undress" props'
 *   accessories (SAnimator::Dress / Undress, +0x26c).
 * - Animator::StartSkill -> VitaBoy::StartPractice.
 */

import { BodyStrings, BS } from "./bodystrings.js";
import { PD, resolveOutfit } from "./outfit.js";
import type { PersonLook } from "./personlook.js";
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
  /** +0x1a8 outfit, +0x1ac costume offset, +0x1b0 / +0x1b4 gestures (and the accessories) last dressed for (null: never). */
  private dressedFor: string | null = null;
  /** The accessories dressed (suit name -> texture spec). */
  private worn = new Map<string, string>();
  /** UpdateOutfitAndHands runs one at a time (suits load asynchronously). */
  private dressing: Promise<void> = Promise.resolve();
  private look: PersonLook | null = null;

  private constructor(
    public bodyStrings: BodyStrings,
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

  /**
   * SAnimator::UpdateOutfitAndHands(force): dresses the person for `look`
   * (day clothes and open hands without one) unless nothing it depends on
   * changed since the last time. Resolves once dressed.
   */
  updateOutfitAndHands(look: PersonLook | null = this.look, force = false): Promise<void> {
    this.look = look;
    const pd = look?.pd;
    let key = pd ? [PD.outfit, PD.costumeOffset, PD.leftHand, PD.rightHand].map((i) => pd[i]).join(",") : "";
    for (const [s, t] of look?.accessories ?? []) key += `|${s},${t}`;
    if (!force && key === this.dressedFor) return this.dressing;
    this.dressedFor = key;
    this.dressing = this.dressing.then(() => this.dressOutfit(look)).catch((e: unknown) => console.warn("UpdateOutfitAndHands", e));
    return this.dressing;
  }

  private async dressOutfit(look: PersonLook | null): Promise<void> {
    const pd = look?.pd ?? new Int16Array(0x100);
    const job = look?.job;
    const o = await resolveOutfit(this.bodyStrings, pd, (child) => (job ? job(child) : null));
    const vb = this.vitaboy;
    // DressingRecord::Redress only when the suit or texture changed (suit_or_texture_changed);
    // "NONE" (pets' head entry) finds no suit and leaves the record as it is.
    const redress = (slot: string, suit: string, texture: string): Promise<boolean> => {
      const d = vb.dressings.get(slot);
      if (!suit || suit === "none" || (d && d.suit === suit && d.texture === texture)) return Promise.resolve(false);
      return vb.dress(slot, suit, texture);
    };
    const jobs: Array<Promise<boolean>> = [redress("head", o.head.suit, o.head.texture), redress("body", o.body.suit, o.body.texture)];
    // The accessory record (+0x254[1]): an empty suit takes the previous one off.
    if (o.accessory) jobs.push(redress("accessory", o.accessory, ""));
    else vb.undress("accessory");
    // SetHandSuit, both hands or none.
    if (o.lhand.suit && o.rhand.suit) jobs.push(redress("lhand", o.lhand.suit, o.lhand.texture), redress("rhand", o.rhand.suit, o.rhand.texture));
    await Promise.all(jobs);
    await this.syncAccessories(look?.accessories);
  }

  /** SAnimator::Dress / Undress: the accessories the animations' "dress" / "undress" props asked for. */
  private async syncAccessories(want: ReadonlyMap<string, string> | undefined): Promise<void> {
    for (const suit of [...this.worn.keys()]) {
      if (want?.has(suit)) continue;
      this.vitaboy.undress(`acc:${suit}`);
      this.worn.delete(suit);
    }
    if (!want) return;
    for (const [suit, texture] of want) {
      if (this.worn.get(suit) === texture) continue;
      this.worn.set(suit, texture);
      await this.vitaboy.dress(`acc:${suit}`, suit, texture);
    }
  }

  /** EditPerson::End on a person in the world: new body strings, then UpdateOutfitAndHands. */
  async setBodyStrings(strings: readonly string[]): Promise<void> {
    this.bodyStrings = new BodyStrings(strings);
    await this.updateOutfitAndHands(this.look, true);
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
