/**
 * The simulation side of SAnimator (the person animator, cXPerson +0xa8c):
 * the practices the person plays (main +0xc, carry +0x134, background
 * +0x14), the animation event queue (+0x2c), and the Animate primitive
 * (SAnimator::TryAnimate / ResolveSkillForPrimitive).
 *
 * Time: animations advance by Animator::GetMilsPerTick (42 ms) per sim tick,
 * so they play at the simulation speed. Time props of the skill's motions
 * crossed during a tick are handled like SAnimator::HandleVitaBoyAnimEvent:
 * "xevt" queues an event, "interruptable"/"interruptible" set the
 * practice's interruptible flag, "lefthand"/"righthand"/"censor" set person
 * data 0x16/0x17/0x1e, "discontinuity" stops the carry practice; sounds and
 * dress/undress are recorded / ignored.
 *
 * Skills load asynchronously here (the original's VBAnimMgr loads them
 * synchronously): a skill not loaded yet keeps the primitive waiting.
 */

import { LoopMode, Practice } from "../sims/practice.js";
import type { Skeleton } from "../sims/skeleton.js";
import type { Skill } from "../sims/skill.js";
import { VBAnimMgr } from "../sims/vbanimmgr.js";

/** Animator::GetMilsPerTick. */
export const MILS_PER_TICK = 42;

/** Skill name -> loaded skill (null: missing), shared by every person. */
const skills = new Map<string, Skill | null>();
const pending = new Map<string, Promise<void>>();
let mgr: VBAnimMgr | null = null;
let mgrPromise: Promise<VBAnimMgr> | null = null;

/** The skill if loaded; undefined while it loads (the load starts), null when missing. */
export function requestSkill(name: string): Skill | null | undefined {
  const k = name.toLowerCase();
  if (skills.has(k)) return skills.get(k)!;
  if (!pending.has(k)) {
    pending.set(
      k,
      (async () => {
        mgrPromise ??= VBAnimMgr.get();
        mgr ??= await mgrPromise;
        const s = await mgr.findSkill(k).catch(() => null);
        skills.set(k, s);
      })(),
    );
  }
  return undefined;
}

/** Wait for every requested skill (tests). */
export async function skillsSettled(): Promise<void> {
  await Promise.all(pending.values());
}

/** A practice the animator plays, with its time cursor (for time props). */
class Track {
  readonly practice: Practice;
  /** Practice +0x68: interruptible. */
  interruptible = false;
  private lastMs: number;

  constructor(
    readonly skill: Skill,
    skeleton: Skeleton,
    loop: LoopMode,
    backwards: boolean,
    clock: number,
  ) {
    this.practice = new Practice(skill, skeleton, loop);
    if (backwards) {
      this.practice.speed = -1;
      this.practice.position = 1;
    }
    this.practice.apply(clock);
    this.lastMs = backwards ? skill.duration + 1 : -1;
  }

  get done(): boolean {
    return this.practice.finished;
  }

  /** Advance to `clock`; returns the time props crossed, in order. */
  advance(clock: number): Array<Map<string, string>> {
    const p = this.practice;
    p.apply(clock);
    const d = this.skill.duration;
    const now = p.position * d;
    const out: Array<Map<string, string>> = [];
    const forward = p.speed >= 0;
    const from = this.lastMs;
    const wrapped = forward ? now < from : now > from;
    const hit = (t: number): boolean => {
      if (forward) return wrapped ? t > from || t <= now : t > from && t <= now;
      return wrapped ? t < from || t >= now : t < from && t >= now;
    };
    for (const m of this.skill.motions) {
      if (!m.timeProps) continue;
      const times = [...m.timeProps.keys()].sort((a, b) => (forward ? a - b : b - a));
      for (const t of times) if (hit(t)) out.push(m.timeProps.get(t)!);
    }
    this.lastMs = now;
    return out;
  }
}

/** What the animator reports to the person (person data writes, sounds). */
export interface AnimatorHost {
  setPersonData(index: number, value: number): void;
  record(kind: string, value: string | number): void;
}

export class PersonAnimator {
  /** The skeleton the practices drive (the lot view's VitaBoy when attached). */
  skeleton: Skeleton | null = null;
  /** +0xc main, +0x134 carry, +0x14 background. */
  main: Track | null = null;
  carry: Track | null = null;
  background: Track | null = null;
  /** +0x2c anim events. */
  readonly events: number[] = [];
  /** +0xa0 animating (TryAnimate started its skill), +0xa4 events counted. */
  animating = false;
  eventCount = 0;
  /** +0x188 animation state (0 animating, 1..3 standing / sitting...). */
  state = 0;
  /** The animation clock (ms of animation time). */
  clock = 0;
  /** Name of the main skill (trace). */
  mainName = "";
  /** Called after the pose changed (the renderer redeforms). */
  onPose: (() => void) | null = null;

  constructor(readonly host: AnimatorHost) {}

  /** Uses `skeleton` (shared with the renderer's VitaBoy). */
  attach(skeleton: Skeleton): void {
    this.skeleton = skeleton;
    for (const slot of ["background", "main", "carry"] as const) {
      const t = this[slot];
      if (!t) continue;
      const n = new Track(t.skill, skeleton, t.practice.loop, t.practice.speed < 0, this.clock);
      n.practice.position = t.practice.position;
      n.interruptible = t.interruptible;
      this[slot] = n;
    }
  }

  /** SAnimator::StartSkill on a slot. */
  start(slot: "main" | "carry" | "background", skill: Skill, backwards: boolean, looping = slot !== "main"): Track | null {
    if (!this.skeleton) return null;
    const loop = looping ? LoopMode.Loop : LoopMode.Hold;
    const t = new Track(skill, this.skeleton, loop, backwards, this.clock);
    this[slot] = t;
    if (slot === "main") this.mainName = skill.name;
    return t;
  }

  stop(slot: "main" | "carry" | "background"): void {
    this[slot] = null;
  }

  /** Animator::Tick: advance the practices one tick and handle the crossed time props. */
  tick(): void {
    this.clock += MILS_PER_TICK;
    // Apply order: background (priority 10), main, carry (-10) on top.
    for (const slot of ["background", "main", "carry"] as const) {
      const t = this[slot];
      if (!t) continue;
      for (const props of t.advance(this.clock)) this.handleProps(t, props);
    }
    if (this.skeleton) {
      this.skeleton.updateBoneTransforms();
      this.onPose?.();
    }
  }

  /** SAnimator::HandleVitaBoyAnimEvent. */
  private handleProps(t: Track, props: Map<string, string>): void {
    for (const [key, value] of props) {
      const n = Number.parseInt(value, 10) || 0;
      switch (key.toLowerCase()) {
        case "xevt":
          this.events.push(n);
          break;
        case "interruptable":
        case "interruptible":
          t.interruptible = n !== 0;
          break;
        case "lefthand":
          this.host.setPersonData(0x16, n);
          break;
        case "righthand":
          this.host.setPersonData(0x17, n);
          break;
        case "censor":
          this.host.setPersonData(0x1e, n);
          break;
        case "discontinuity":
          if (this.carry) this.carry = null;
          break;
        case "sound":
          this.host.record("animSound", value);
          break;
        default:
          break;
      }
    }
  }

  /** SAnimator::DequeueAnimEvent. */
  dequeueEvent(): number | undefined {
    return this.events.shift();
  }

  /** IsAnimationDone(main). */
  isMainDone(): boolean {
    return !this.main || this.main.done;
  }
}
