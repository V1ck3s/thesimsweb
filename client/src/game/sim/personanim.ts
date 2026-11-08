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
 * data 0x16/0x17/0x1e, "discontinuity" stops the carry practice, sounds go
 * to sim/animsound.ts, "dress" / "undress" put an accessory on or off
 * (SAnimator::Dress / Undress: the lot renderer dresses `accessories`).
 *
 * Skills load asynchronously here (the original's VBAnimMgr loads them
 * synchronously): a skill not loaded yet keeps the primitive waiting.
 */

import { enterLiveModeHooks } from "../cpstate.js";
import { LoopMode, Practice } from "../sims/practice.js";
import type { Skeleton } from "../sims/skeleton.js";
import { type Skill, skillClock } from "../sims/skill.js";
import { SkillReadError, VBAnimMgr } from "../sims/vbanimmgr.js";

/** Animator::GetMilsPerTick (the walk engine's unit). */
export const MILS_PER_TICK = 42;
/**
 * Animator::GetMils per sim tick: trunc(1.2 * GetMilsPerTick) = 50 (the
 * clock SAnimator::Tick hands VitaBoy::AnimationTick), GetMilsPerTick alone
 * while SAnimator +0xa8 (Animate flag 0x80) is set.
 */
const ANIM_MILS_PER_TICK = Math.trunc(Math.fround(1.2) * MILS_PER_TICK);

/** SAnimator::CalcAngle(dx, dy): atan2(dy, dx) in [0, 2 pi). */
function calcAngle(dx: number, dy: number): number {
  const a = Math.atan2(dy, dx);
  return a < 0 ? a + 2 * Math.PI : a;
}

/** A direction wrapped into [0, 8). */
function wrap8f(d: number): number {
  let v = d;
  while (v >= 8) v -= 8;
  while (v < 0) v += 8;
  return v;
}

/** The person's direction from the animator's: wrap8(trunc(dir + 0.5)). */
function wrap8i(d: number): number {
  return ((Math.trunc(d + 0.5) % 8) + 8) % 8;
}

/** A turn wrapped into [-4, 4). */
function wrapPm4(t: number): number {
  let v = t;
  while (v >= 4) v -= 8;
  while (v < -4) v += 8;
  return v;
}

/**
 * SAnimator::FindTagTime(skill, key, value, &bone): the time of the first
 * time prop (motions in order, each one's props from the last) where
 * `key` = `value`, and the motion's bone; -1 when none.
 */
function findTagTime(skill: Skill, key: string, value: string): { time: number; bone: string } {
  for (const m of skill.motions) {
    if (!m.timeProps) continue;
    const entries = [...m.timeProps.entries()];
    for (let i = entries.length - 1; i >= 0; i--) {
      const [time, props] = entries[i]!;
      if (props.get(key) === value) return { time, bone: m.boneName };
    }
  }
  return { time: -1, bone: "" };
}

/** func_10595F30 (atoi): leading blanks, a sign, then decimal digits; 0 without any. */
function atoi(s: string): number {
  const m = /^\s*([+-]?\d+)/.exec(s);
  return m ? Number.parseInt(m[1]!, 10) | 0 : 0;
}

/** StartVitaBoy's walk loop measures (SAnimator +0x168..+0x174). */
interface WalkMeasures {
  phase1: number;
  phase2: number;
  stop1: number;
  stop2: number;
}

const walkLoopMeasures = new Map<string, WalkMeasures>();

/** SAnimator::SAnimator's +0x168..+0x174 (lbl_105BC8A8 + 0x28, 0). */
const NO_WALK_MEASURES: WalkMeasures = { phase1: 0, phase2: 0, stop1: 0, stop2: 0 };

/**
 * SAnimator::StartVitaBoy's walk loop measures: the phases of the
 * "anchor" = 1 / 2 tags (the feet), then the loop posed at each phase
 * (weight 1, on a copy of the skeleton): the stop distance there is
 * 16/3 x (the anchored foot's z - the other foot's z).
 */
function measureWalkLoop(skill: Skill, skeleton: Skeleton): WalkMeasures {
  const key = `${skill.name}|${skeleton.name}`;
  let m = walkLoopMeasures.get(key);
  if (m) return m;
  const t1 = findTagTime(skill, "anchor", "1");
  const t2 = findTagTime(skill, "anchor", "2");
  const phase1 = t1.time / skill.duration;
  const phase2 = t2.time / skill.duration;
  const sk = skeleton.clone();
  const b1 = sk.findBone(t1.bone);
  const b2 = sk.findBone(t2.bone);
  const practice = new Practice(skill, sk, LoopMode.Loop);
  practice.weight = 1;
  const pose = (phase: number): [number, number] => {
    practice.position = phase;
    practice.apply(0);
    sk.updateBoneTransforms();
    return [b1?.worldPos[2] ?? 0, b2?.worldPos[2] ?? 0];
  };
  const k = 16 / 3;
  const [z1b, z2b] = pose(phase2);
  const stop2 = k * z2b - k * z1b;
  const [z1a, z2a] = pose(phase1);
  const stop1 = k * z1a - k * z2a;
  m = { phase1, phase2, stop1, stop2 };
  walkLoopMeasures.set(key, m);
  return m;
}

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
        mgrPromise ??= VBAnimMgr.get().then((m) => {
          // An unloaded skill is read again on its next request.
          m.skillUnloaded.add((name) => {
            skills.delete(name);
            pending.delete(name);
          });
          return m;
        });
        mgr ??= await mgrPromise;
        // A skill whose files could not be read (the network) is not taken as missing: missing, the
        // person would play the "missing animation" in its place for the rest of the session (a sim
        // left sitting in a sofa whose sit / stand skills did not arrive); it is asked for again.
        const s = await mgr.findSkill(k).catch((e: unknown) => (e instanceof SkillReadError ? undefined : null));
        if (s === undefined) pending.delete(k);
        else skills.set(k, s);
      })(),
    );
  }
  return undefined;
}

/** VBAnimMgr::TryUnloadSkills (HouseViewer::UpdateWorld); nothing before the first skill request. */
export function tryUnloadSkills(nowMs: number): void {
  mgr?.tryUnloadSkills(nowMs);
}

// CPState::SetMode, entering Live mode: VBAnimMgr::TryUnloadAll(lbl_105BA230).
enterLiveModeHooks.add(() => mgr?.tryUnloadAll(skillClock.now));

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

  /** SAnimator::SetSpeed / the practice's rate: animation ms per real ms. */
  rate = 1;
  /** The practice's own clock (ms of animation time). */
  private local = 0;
  /** Practice +0x68 for looping practices (the end of a cycle). */
  loopEnded = false;

  /** Practice +0x68: done (held practices) or a cycle ended (looping ones). */
  get atEnd(): boolean {
    return this.practice.finished || this.loopEnded;
  }

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
    this.local = clock;
    this.practice.apply(clock);
    this.lastMs = backwards ? skill.duration + 1 : -1;
  }

  get done(): boolean {
    return this.practice.finished;
  }

  /** Advance to `clock`; returns the time props crossed, in order. */
  advance(dt: number): Array<Map<string, string>> {
    const p = this.practice;
    const before = p.position;
    this.local += dt * this.rate;
    p.apply(this.local);
    // Practice +0x68 for a looping practice: the loop came round this tick.
    this.loopEnded = p.loop === LoopMode.Loop && (p.speed >= 0 ? p.position < before : p.position > before);
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
/**
 * TileList::FindNearestPoint(point, idx): the point moved to the nearest
 * rounded point of the path's segments (the facing point's segment left
 * out): idx < 0 every segment, 0 the first, n > 0 the segment ending at
 * point n. It starts from the segments' first point; out of range, the
 * point is kept.
 */
export function findNearestPoint(path: readonly FollowPt[], px: number, py: number, idx: number): FollowPt {
  const last = path.length - 3;
  const lo = idx < 0 ? 0 : idx === 0 ? 0 : idx - 1;
  const hi = idx < 0 ? last : lo;
  if (lo < 0 || lo > last || hi < 0 || hi > last) return { fx: px, fy: py };
  let best: FollowPt = { fx: path[lo]!.fx, fy: path[lo]!.fy };
  let bd = (best.fx - px) ** 2 + (best.fy - py) ** 2;
  for (let i = lo; i <= hi; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    const vx = a.fx - b.fx;
    const vy = a.fy - b.fy;
    const l2 = Math.fround(vx * vx + vy * vy);
    let t = Math.fround(((px - b.fx) * vx + (py - b.fy) * vy) / l2);
    // A zero-length segment divides into NaN: t stays 0 (the comparisons fail).
    t = t >= 0 ? Math.min(t, 1) : 0;
    const qx = Math.trunc(Math.fround(0.5 + t * vx + b.fx));
    const qy = Math.trunc(Math.fround(0.5 + t * vy + b.fy));
    const d = (qx - px) ** 2 + (qy - py) ** 2;
    if (d < bd) {
      bd = d;
      best = { fx: qx, fy: qy };
    }
  }
  return best;
}

export interface AnimatorHost {
  setPersonData(index: number, value: number): void;
  record(kind: string, value: string | number): void;
  /** GetStdSkill's skill name for a StdAnimIdx (null: none). */
  stdSkillName(idx: number): string | null;
  /** ObjSelector::GetBodyStrings(0): the person's body strings (STR# OBJD +0x26, as edited). */
  bodyStrings(): readonly string[];
  /** A STR# of the person's semi-global file (Behavior::GetMiddleFile), null when missing. */
  middleStrings(id: number): readonly string[] | null;
  /** OBJD +0xcc of the person's object (bit 2: StartVitaBoy measures no walk loop). */
  objdFlags(): number;
  personData(index: number): number;
  objectData(index: number): number;
  /** cXObject +0x4c. */
  setDirection(dir: number): void;
  /** cXObject::CanPlace of the person at a position of its level (vtable +0x5c). */
  canPlace(fx: number, fy: number): boolean;
  /** cXObject::SetLocation (vtable +0x90). */
  setLocation(fx: number, fy: number): void;
  /** cXPerson's slot 1 (the hand) holds an object (Windows 0x00589fd2). */
  holding(): boolean;
  /** HandleVitaBoyAnimEvent's sound props (sim/animsound.ts); `forward`: the practice plays forward. */
  animSound(key: string, value: string, forward: boolean): void;
}

/** SAnimator +0x188 animation states. */
export const AS = {
  animating: 0,
  sitting: 1,
  sittingFloor: 2,
  standing: 3,
  standingTurn: 4,
  standingAdjust: 5,
  walkingStart: 6,
  walkingStop: 7,
  walkingTurn: 8,
  walking: 9,
  running: 10,
  runningStart: 11,
  runningStop: 12,
} as const;

/** SAnimator +0x180 follow states. */
export const FOLLOW = { ending: -1, neutral: 0, engaged: 1, arrived: 2, blocked: 3 } as const;

/** StdAnimIdx values used by the walk engine. */
export const STD = {
  sitLoop: 1,
  floorSitLoop: 2,
  standingLoop: 3,
  walkStart: 19,
  walkLoop: 20,
  runLoop: 21,
  runStart: 22,
  runStop: 23,
  walkStopLeft: 27,
  walkStopRight: 28,
  carry: 38,
} as const;

/** A path point (1/16 tile). */
export interface FollowPt {
  fx: number;
  fy: number;
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
  /** +0x26c: the accessories "dress" props put on (suit name -> texture spec, always empty). */
  readonly accessories = new Map<string, string>();

  constructor(readonly host: AnimatorHost) {}

  /**
   * +0xd8: set by Reset; the next GetSkill, StartReachAnimation or
   * ResolveSkillForPrimitive runs ResetSuits first (checkResetSuits).
   */
  private suitsResetPending = false;
  /**
   * Bumped by ResetSuits: UndressSuits took every suit off and +0x1a8 /
   * +0x1ac = -1 make the next UpdateOutfitAndHands (SAnimator::Render, the
   * lot renderer here) dress everything again (sims/sanimator.ts).
   */
  suitsVersion = 0;

  /**
   * SAnimator::ResetSuits (Mac 0x103585a0): UndressSuits (suitsVersion),
   * the body strings read again (ObjSelector::GetBodyStrings), the hand
   * gestures open (person data 0x16 / 0x17 := 0), then from the body
   * strings: the gender (13: "male" 0, "female" 1, "dogmale" 2,
   * "dogfemale" 3, "catmale" 4, "catfemale" 5; person data 65 unchanged
   * otherwise), the age (14, atoi; person data 58) and the skin color (15,
   * matched without case against the semi-global's STR# 0x2000 entries 2..:
   * person data 60 := entry - 1, 0 when none matches), then
   * ClearAccessories. The renderer redresses from the body strings.
   */
  resetSuits(): void {
    const bs = this.host.bodyStrings();
    this.host.setPersonData(0x16, 0);
    this.host.setPersonData(0x17, 0);
    const gender = bs[12];
    if (gender !== undefined) {
      const g = ["male", "female", "dogmale", "dogfemale", "catmale", "catfemale"].indexOf(gender.toLowerCase());
      if (g >= 0) this.host.setPersonData(65, g);
    }
    const age = bs[13];
    if (age !== undefined) this.host.setPersonData(58, atoi(age));
    const skin = bs[14];
    if (skin !== undefined) {
      const colors = this.host.middleStrings(0x2000) ?? [];
      let v = 0;
      for (let i = 2; i <= colors.length; i++) {
        if ((colors[i - 1] ?? "").toLowerCase() === skin.toLowerCase()) {
          v = i - 1;
          break;
        }
      }
      this.host.setPersonData(60, v);
    }
    this.accessories.clear();
    this.suitsVersion++;
  }

  /** The +0xd8 test of GetSkill / StartReachAnimation / ResolveSkillForPrimitive: ResetSuits once after a Reset. */
  checkResetSuits(): void {
    if (!this.suitsResetPending) return;
    this.suitsResetPending = false;
    this.resetSuits();
  }

  /** SAnimator::GetSkill(i)'s name: ResetSuits first when a Reset asked for it, then GetStdSkill. */
  private getSkillName(idx: number): string | null {
    this.checkResetSuits();
    return this.host.stdSkillName(idx);
  }

  /**
   * +0x19c: a reach animation (StartReachAnimation) or a main animation
   * started with TryAnimate flags 1 | 0x10 plays: no carry practice.
   */
  carryBlocked = false;
  /** +0x1a0: 0 empty-handed, 1 holding something (slot 1), 6 the carry practice is the trees' (TryAnimate flag 0x10). */
  carryMode = 0;
  /** +0x1a4: the carry practice UpdateCarryPractice runs (0 the standard carry loop, -1 none). */
  carryAnim = -1;

  /**
   * SAnimator::Reset's practices: the main, carry and background ones
   * stop, the carry state goes back to empty-handed (+0x1a0 = 0, +0x1a4 =
   * -1: the next tick's UpdateCarryPractice restarts the carry loop when
   * the person still holds something); +0xd8 = 1: the next skill lookup
   * runs ResetSuits.
   */
  reset(): void {
    this.suitsResetPending = true;
    // SAnimator::Reset: the walk fields, Standing (+0x188 = 3), the carry
    // fields (+0x1a0 = 0, +0x1a4 = -1), the background sit value (+0x190).
    this.pathIndex = -1;
    this.bgSit = -1;
    this.looping = false;
    this.pending = 0;
    this.stopping = false;
    this.walkActive = false;
    this.stopAt = 0;
    this.carryMode = 0;
    this.carryAnim = -1;
    this.state = AS.standing;
    // The follow state (+0x180): a walk under way is asked to end (+0x27c),
    // anything else goes back to neutral with the targets on the grid position.
    if (this.followState !== FOLLOW.neutral) {
      if (this.followState === FOLLOW.engaged || this.followState === FOLLOW.ending) {
        this.endAsked = true;
      } else {
        this.pathIndex = -1;
        this.path = [];
        this.stopAt = 0;
        this.tx = this.gridX;
        this.ty = this.gridY;
        this.tdir = this.dirF;
        this.state = AS.standing;
      }
      this.followState = FOLLOW.neutral;
    }
    // StopCurAnim, StopAnimation of the carry, main and background practices,
    // the event queue (+0x2c) erased, not animating (+0xa0).
    this.stop("main");
    this.stop("carry");
    this.stop("background");
    this.fade = null;
    this.events.length = 0;
    this.animating = false;
  }

  /**
   * SAnimator::UpdateCarryPractice (Mac 0x1034e5c0, Windows 0x005903a7),
   * from SAnimator::Tick: unless the trees own the carry practice (+0x1a0
   * = 6), a person holding something in slot 1 (and not reaching or
   * playing a full-body animation, +0x19c) plays StdAnimIdx 0x26
   * ("a2o-rarm-carry-loop") on the carry practice (+0x134, priority 10, on
   * top of the walk and the main animation); it stops when the hand empties.
   */
  private updateCarryPractice(): void {
    if (this.carryMode === 6) return;
    let want = -1;
    if (!this.carryBlocked) {
      this.carryMode = this.host.holding() ? 1 : 0;
      if (this.carryMode >= 1 && this.carryMode < 6) want = 0;
    }
    if (want === this.carryAnim) return;
    this.carry = null;
    if (want === 0) {
      const n = this.getSkillName(STD.carry);
      const sk = n ? requestSkill(n) : null;
      // The original loads the skill synchronously: until it is here, ask again next tick.
      if (sk === undefined) return;
      if (sk && !this.start("carry", sk, false, true)) return;
    }
    this.carryAnim = want;
  }

  /**
   * Set by the Animate / Reach primitives while the main skill they start
   * still loads (the original's VBAnimMgr loads it synchronously, in the
   * same tick); see settleLoadHold.
   */
  loadWait = false;
  /** Where the person is drawn while its main skill loads (null: where the simulation puts it). */
  private hold: { fx: number; fy: number; dir: number } | null = null;

  /**
   * After the person's tick: while the primitive waits for its skill, the
   * person stays drawn where it was before the tick (`drawn`), so a Snap
   * that ran just before the Animate (e.g. Beds.iff "get in": Snap onto the
   * bed, then the get-in animation) does not show the person on the bed in
   * its standing pose until the skill arrives; the original runs both
   * primitives and starts the animation in one tick.
   */
  settleLoadHold(drawn: { fx: number; fy: number; dir: number }): void {
    if (this.loadWait) this.hold ??= drawn;
    else this.hold = null;
    this.loadWait = false;
  }

  /** Uses `skeleton` (shared with the renderer's VitaBoy). */
  attach(skeleton: Skeleton): void {
    this.skeleton = skeleton;
    for (const slot of ["background", "main", "carry"] as const) {
      const t = this[slot];
      if (!t) continue;
      const n = new Track(t.skill, skeleton, t.practice.loop, t.practice.speed < 0, this.clock);
      n.practice.position = t.practice.position;
      n.interruptible = t.interruptible;
      n.rate = t.rate;
      this[slot] = n;
    }
  }

  /** SAnimator::StartSkill on a slot. */
  start(slot: "main" | "carry" | "background", skill: Skill, backwards: boolean, looping = slot !== "main"): Track | null {
    if (!this.skeleton) return null;
    const loop = looping ? LoopMode.Loop : LoopMode.Hold;
    const t = new Track(skill, this.skeleton, loop, backwards, this.clock);
    this[slot] = t;
    if (slot === "main") {
      this.mainName = skill.name;
      this.curAnim = -1;
    }
    return t;
  }

  stop(slot: "main" | "carry" | "background"): void {
    this[slot] = null;
    // The standard animation index names the main practice (StopCurAnim):
    // without this a walk stopped by a Reset keeps curAnim = walk loop with no
    // practice, never restarts it and the person stays frozen on its path.
    if (slot === "main") this.curAnim = -1;
  }

  /** Animator::Tick: advance the practices one tick and handle the crossed time props. */
  tick(): void {
    const mils = this.milsFlag ? MILS_PER_TICK : ANIM_MILS_PER_TICK;
    this.clock += mils;
    if (this.skeleton) this.updateCarryPractice();
    this.tickMovement();
    // Apply order: background (priority -10), main, carry (10) on top.
    for (const slot of ["background", "main", "carry"] as const) {
      const t = this[slot];
      if (!t) continue;
      for (const props of t.advance(mils)) this.handleProps(t, props);
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
        case "dress":
          // SAnimator::Dress(suit, ""): Undress(suit), then a new record.
          this.accessories.delete(value.toLowerCase());
          this.accessories.set(value.toLowerCase(), "");
          break;
        case "undress":
          this.accessories.delete(value.toLowerCase());
          break;
        case "sound":
        case "selectedsound":
        case "deselectedsound":
        case "footstep":
          this.host.animSound(key.toLowerCase(), value, t.practice.speed >= 0);
          break;
        default:
          break;
      }
    }
  }

  // --- following a path (SAnimator::Tick's movement states) -------------------------

  /** +0x180 follow state, +0x178 the path point walked to, +0x17c the path. */
  followState: number = FOLLOW.neutral;
  pathIndex = -1;
  path: FollowPt[] = [];
  /** +0x80 / +0x84 grid position (1/16 tile), +0x88 direction (45 degree units, 0..8). */
  gridX = 0;
  gridY = 0;
  dirF = 0;
  /** +0x1bc..+0x1c4 target, +0x1c8..+0x1d0 start, +0x1d4..+0x1dc saved final target. */
  private tx = 0;
  private ty = 0;
  private tdir = 0;
  private sx = 0;
  private sy = 0;
  private sdir = 0;
  private svx = 0;
  private svy = 0;
  private svdir = 0;
  /** +0x98 the std anim on the main practice (-1 none). */
  private curAnim = -1;
  /** +0x220 / +0x224 current (smoothed) and target walking scale. */
  private scale = 1.4;
  /** +0x1b8 stop deadline (animation ms; 0 none, -1 expired). */
  private stopAt = 0;
  /** +0x194 walk loop running, +0x27c EndFollow asked, +0x280 pending follow result, +0x284 stopping, +0x288 walk active. */
  private looping = false;
  private endAsked = false;
  private pending = 0;
  private stopping = false;
  private walkActive = false;
  /** +0x190: the sit value the background practice was started for. */
  private bgSit = -2;
  /** Practice::Fade of the main practice's weight (stop of a walk). */
  private fade: { from: number; to: number; at: number; ms: number } | null = null;

  /** SAnimator::IsFollowing. */
  isFollowing(): boolean {
    return this.followState !== FOLLOW.neutral;
  }

  /** SAnimator::IsInterruptable: animating / walking go by the main practice's flag; sitting and standing are; turns, adjusts, starts, stops are not. */
  isInterruptable(): boolean {
    const st = this.state;
    if (st === AS.animating || st === AS.walking || st === AS.running) return !this.main || this.main.interruptible;
    return st >= AS.sitting && st <= AS.standing;
  }

  /** SAnimator::BeginFollow: grid and targets from the person, speed 1, following point 0, Standing. */
  beginFollow(path: readonly FollowPt[], person: { fx: number; fy: number; dir: number }): void {
    this.gridX = this.tx = person.fx;
    this.gridY = this.ty = person.fy;
    this.dirF = this.tdir = person.dir;
    this.path = path.map((p) => ({ fx: p.fx, fy: p.fy }));
    this.pathIndex = 0;
    this.followState = FOLLOW.engaged;
    this.state = AS.standing;
    this.endAsked = false;
    this.pending = 0;
    this.stopAt = 0;
    this.stopping = false;
    // The walk skills (and the carry loop) load asynchronously here: ask for them now.
    for (const i of [STD.walkStart, STD.walkLoop, STD.runLoop, STD.runStart, STD.carry, 4, 5, 6, 7, 8, 9, 10]) {
      const n = this.getSkillName(i);
      if (n) requestSkill(n);
    }
  }

  /**
   * SAnimator::FollowOneStep: 2 while following; once arrived, the person
   * goes to the rounded grid position projected on the path
   * (TileList::FindNearestPoint over every segment; 1 placed, 0 when it
   * does not fit); 0 when blocked or not following.
   */
  followOneStep(): number {
    const f = this.followState;
    if (f === FOLLOW.engaged || f === FOLLOW.ending) return 2;
    if (f !== FOLLOW.arrived) return 0;
    this.host.setDirection(wrap8i(this.dirF));
    // The rounded grid position brought back onto the path (any segment).
    const pt = findNearestPoint(this.path, Math.trunc(0.5 + this.gridX), Math.trunc(0.5 + this.gridY), -1);
    const ok = this.host.canPlace(pt.fx, pt.fy);
    if (ok) this.host.setLocation(pt.fx, pt.fy);
    return ok ? 1 : 0;
  }

  /** SAnimator::EndFollow: back to Standing (follow neutral) unless still walking (then asked). */
  endFollow(): boolean {
    if (this.followState !== FOLLOW.engaged && this.followState !== FOLLOW.ending) {
      this.pathIndex = -1;
      this.followState = FOLLOW.neutral;
      this.path = [];
      this.stopAt = 0;
      this.tx = this.gridX;
      this.ty = this.gridY;
      this.tdir = this.dirF;
      if (this.state !== AS.sitting && this.state !== AS.sittingFloor && this.state !== AS.animating) this.state = AS.standing;
      return true;
    }
    this.endAsked = true;
    return false;
  }

  /** SAnimator::ForceLocation / SnapToGrid: the grid and targets take the person's position and direction. */
  forceLocation(person: { fx: number; fy: number; dir: number }): void {
    this.gridX = this.tx = person.fx;
    this.gridY = this.ty = person.fy;
    this.dirF = this.tdir = person.dir;
  }

  /** The animator's facing for the renderer while it moves the person (null when idle). */
  get followDir(): number | null {
    if (this.hold) return this.hold.dir;
    return this.followState === FOLLOW.neutral && (this.state < AS.standingTurn || this.state > AS.runningStop) ? null : wrap8f(this.dirF);
  }

  /** The animator's position for the renderer while it moves the person (null when idle). */
  get followPos(): FollowPt | null {
    if (this.hold) return { fx: this.hold.fx, fy: this.hold.fy };
    return this.followState === FOLLOW.neutral && (this.state < AS.standingTurn || this.state > AS.runningStop) ? null : { fx: this.gridX, fy: this.gridY };
  }

  private get isPet(): boolean {
    return this.host.personData(0x41) > 1;
  }

  /** SetDirection, and the person's direction (+0x4c = wrap8(trunc(dir + 0.5))). */
  private setDirection(d: number): void {
    this.dirF = wrap8f(d);
    this.host.setDirection(wrap8i(this.dirF));
  }

  /** SetCurAnim(std, loop): the standard skill on the main practice (false while it loads or is missing). */
  private setCurAnim(idx: number, looping: boolean): boolean {
    if (this.curAnim === idx && this.main) return true;
    const name = this.getSkillName(idx);
    const sk = name ? requestSkill(name) : null;
    if (!sk) {
      this.main = null;
      this.curAnim = -1;
      return false;
    }
    const t = this.start("main", sk, false, looping);
    // No skeleton yet (a person made at run time gets its own asynchronously):
    // as while the skill loads, nothing plays and the next tick asks again.
    if (!t) return false;
    t.interruptible = true;
    t.rate = this.scale;
    this.curAnim = idx;
    this.fade = null;
    return true;
  }

  /** StopCurAnim. */
  private stopCurAnim(): void {
    this.main = null;
    this.curAnim = -1;
    this.fade = null;
  }

  /** The main practice's progress (1 without one). */
  private progress(): number {
    return this.main ? this.main.practice.position : 1;
  }

  /** SAnimator::GetWalkingScale. */
  private walkingScale(): number {
    let f = 1;
    if (this.host.objectData(17) === 1) {
      const st = this.state;
      if (st === AS.animating) f = 8;
      else if (st >= 4 && st <= 9) f = this.isPet ? 0 : 8;
    }
    return f >= 0 ? f * 0.2 + 1.2 : f * 0.4 + 1.2;
  }

  /** SAnimator::StdAnimOffset(i): the ROOT translation at the last frame of a standard skill (zeros when it is not there). */
  private stdAnimOffset(i: number): [number, number, number] {
    const n = this.getSkillName(i);
    const sk = n ? requestSkill(n) : null;
    const m = sk?.motions.find((x) => x.boneName === "ROOT");
    const tr = sk?.translations;
    if (!m || !tr || m.frameCount === 0) return [0, 0, 0];
    const o = (m.translationOffset + m.frameCount - 1) * 3;
    return [tr[o]!, tr[o + 1]!, tr[o + 2]!];
  }

  /** StdAnimDist(i) x 16/3: a standard skill's distance in 1/16 tile (0 while it loads). */
  private stdDist(i: number): number {
    const n = this.getSkillName(i);
    const sk = n ? requestSkill(n) : null;
    return sk ? sk.distance * (16 / 3) : 0;
  }

  /** SAnimator::UpdateBackgroundPractice: the sit / floor sit / standing loop by person data 0. */
  private updateBackgroundPractice(): void {
    const sit = this.host.personData(0);
    if (sit === this.bgSit && this.background) return;
    const idx = sit === 1 ? STD.sitLoop : sit === 2 ? STD.floorSitLoop : STD.standingLoop;
    const n = this.getSkillName(idx);
    const sk = n ? requestSkill(n) : null;
    if (!sk) return;
    this.start("background", sk, false, true);
    this.bgSit = sit;
  }

  /** SAnimator +0xa8: Animate flag 0x80, the animation clock advances GetMilsPerTick (42) instead of 50 a tick. */
  milsFlag = false;
  /** SAnimator +0x294: Animate flag 0x40, the main practice plays at the walking scale. */
  practiceScaled = false;

  /** The movement part of SAnimator::Tick (prelude and states 1..12). */
  private tickMovement(): void {
    // Prelude: the background practice and the walking scale, smoothed by 0.2 a tick.
    if (this.skeleton) this.updateBackgroundPractice();
    const target = this.walkingScale();
    if (this.scale >= target - 0.2 && this.scale <= target + 0.2) this.scale = target;
    else if (target > this.scale) this.scale += 0.2;
    else this.scale = target;
    if (this.fade && this.main) {
      const k = Math.min(1, (this.clock - this.fade.at) / this.fade.ms);
      this.main.practice.weight = this.fade.from + (this.fade.to - this.fade.from) * k;
    }
    for (let guard = 0; guard < 16; guard++) {
      switch (this.state) {
        case AS.sitting:
        case AS.sittingFloor:
          if (this.main && (this.state === AS.sittingFloor || this.host.personData(0x4e) === 0)) {
            this.stopCurAnim();
            this.bgSit = -1;
            this.updateBackgroundPractice();
          }
          this.looping = this.walkActive = false;
          return;
        case AS.standing:
          if (!this.standing()) return;
          break;
        case AS.standingTurn:
        case AS.standingAdjust:
          if (!this.turning()) return;
          break;
        case AS.walkingStart:
        case AS.runningStart:
          if (!this.walkingStart()) return;
          break;
        case AS.walkingStop:
          if (!this.walkingStop()) return;
          break;
        case AS.walking:
        case AS.running:
          if (!this.walking()) return;
          break;
        case AS.runningStop:
          this.looping = this.walkActive = false;
          if (!this.main || this.main.atEnd) {
            this.state = AS.standing;
            break;
          }
          if (this.main) this.main.rate = this.scale;
          return;
        default:
          // Animating (0): with +0x294 the main practice plays at the walking scale
          // (Practice::SetScale, negated when the practice's speed is). WalkingTurn (8): nothing.
          if (this.state === AS.animating && this.practiceScaled && this.main) this.main.rate = this.scale;
          return;
      }
    }
  }

  /** Standing (3): arrival, snap, StandingAdjust or a StandingTurn towards the target. True: redispatch. */
  private standing(): boolean {
    this.tdir = wrap8f(this.tdir);
    this.dirF = wrap8f(this.dirF);
    const dTurn = this.tdir - this.dirF;
    const dirSame = Math.abs(dTurn) <= 1e-6;
    const atPos = Math.abs(this.tx - this.gridX) <= 1e-6 && Math.abs(this.ty - this.gridY) <= 1e-6;
    if (dirSame && atPos) {
      const f = this.followState;
      if (f === FOLLOW.neutral || f === FOLLOW.ending || f === FOLLOW.arrived || f === FOLLOW.blocked) {
        if (f !== FOLLOW.neutral) this.followState = FOLLOW.arrived;
        this.looping = this.walkActive = false;
        return false;
      }
      this.state = AS.walking;
      return true;
    }
    const dx = this.tx - this.gridX;
    const dy = this.ty - this.gridY;
    const dist = atPos ? 0 : Math.hypot(dx, dy);
    const turn = dirSame ? 0 : wrapPm4(dTurn);
    const pet = this.isPet;
    const turnMin = (pet ? 0.0625 : 0.25) / this.scale;
    const adjMax = pet ? 3.1 / 12 : 3.1;
    const snap = pet ? 0.5 / 5 : 0.5;
    if (Math.abs(turn) < turnMin) {
      if (dist < snap) {
        this.gridX = this.tx;
        this.gridY = this.ty;
        this.setDirection(this.tdir);
        return true;
      }
      if (dist < adjMax) {
        // StandingAdjust: a step in one of 8 directions. The target is moved back by the
        // anim's own offset (StdAnimOffset: its ROOT translation x and y, as both builds
        // take them), and the anim plays at a weight from the distance (0.5 .. 1 and over).
        const a = Math.atan2(dy, dx);
        const f = a / (2 * Math.PI) + 0.0625;
        const oct = Math.trunc(Math.floor(8 * (f - Math.floor(f))));
        const idx = [15, 13, 11, 12, 14, 16, 18, 17][oct] ?? 15;
        const [ox, oy] = this.stdAnimOffset(idx);
        this.setDirection(this.tdir);
        this.svx = this.tx;
        this.svy = this.ty;
        this.svdir = this.tdir;
        this.sx = this.gridX;
        this.sy = this.gridY;
        this.sdir = this.dirF;
        const c = Math.fround(Math.cos(a));
        const sn = Math.fround(Math.sin(a));
        this.tx -= ox * c + oy * sn;
        this.ty -= ox * sn + oy * c;
        let w = dist < 0.1 ? 0.5 : dist >= 1 ? 1 : dist / Math.hypot(ox, oy);
        if (w < 0.5) w = 0.5;
        this.setCurAnim(idx, false);
        if (this.main) {
          this.main.rate = this.scale;
          this.main.practice.weight = w;
        }
        this.state = AS.standingAdjust;
        return false;
      }
    }
    // StandingTurn: the turn anim nearest the turn; the rest of the turn is interpolated.
    let idx: number;
    let animTurn: number;
    if (turn < -3) [idx, animTurn] = [5, -4];
    else if (turn > 3) [idx, animTurn] = [4, 4];
    else if (turn >= -0.5 && turn <= 0.5) [idx, animTurn] = [10, 0];
    else if (turn > 0.5 && turn <= 1.5) [idx, animTurn] = [8, 1];
    else if (turn > 1.5) [idx, animTurn] = [6, 2];
    else if (turn >= -1.5) [idx, animTurn] = [9, -1];
    else [idx, animTurn] = [7, -2];
    this.svx = this.tx;
    this.svy = this.ty;
    this.svdir = this.tdir;
    this.sx = this.gridX;
    this.sy = this.gridY;
    this.sdir = this.dirF;
    this.tdir = this.dirF + (turn - animTurn);
    this.setCurAnim(idx, false);
    this.state = AS.standingTurn;
    return false;
  }

  /** StandingTurn (4) / StandingAdjust (5): interpolate by the anim's progress, then back to Standing at the saved target. */
  private turning(): boolean {
    this.looping = this.walkActive = false;
    const p = this.progress();
    if (p < 1 && this.main && !this.main.practice.finished) {
      this.setDirection(this.tdir * p + this.sdir * (1 - p));
      this.gridX = this.tx * p + this.sx * (1 - p);
      this.gridY = this.ty * p + this.sy * (1 - p);
      this.main.rate = this.scale;
      return false;
    }
    this.stopCurAnim();
    this.state = AS.standing;
    this.setDirection(this.svdir);
    this.tdir = this.dirF;
    this.gridX = this.tx = this.svx;
    this.gridY = this.ty = this.svy;
    return true;
  }

  /** WalkingStart (6) / RunningStart (11): the start anim carries the person one start distance ahead. */
  private walkingStart(): boolean {
    const run = this.state === AS.runningStart;
    const idx = run ? STD.runStart : STD.walkStart;
    if (this.curAnim !== idx) {
      if (!this.setCurAnim(idx, false)) {
        // Not loaded yet: straight to the loop.
        this.state = run ? AS.running : AS.walking;
        this.looping = this.walkActive = true;
        return true;
      }
      this.scale = this.walkingScale();
      if (this.main) this.main.rate = this.scale;
      const ang = ((this.dirF + 6) * 45 * Math.PI) / 180;
      const d = 16 * ((this.main?.skill.distance ?? 0) / 3);
      this.sx = this.gridX;
      this.sy = this.gridY;
      this.tx = this.gridX + d * Math.cos(ang);
      this.ty = this.gridY + d * Math.sin(ang);
    }
    this.looping = this.walkActive = false;
    if (this.main) this.main.rate = this.scale;
    const p = this.progress();
    if (p >= 0.95 || !this.main || this.main.practice.finished) {
      this.stopCurAnim();
      this.gridX = this.tx;
      this.gridY = this.ty;
      this.tdir = this.dirF;
      this.state = run ? AS.running : AS.walking;
      this.looping = this.walkActive = true;
      return true;
    }
    this.moveGrid(this.tx * p + this.sx * (1 - p), this.ty * p + this.sy * (1 - p));
    return false;
  }

  /** WalkingStop (7, swimming): interpolate, then Standing with the pending follow result. */
  private walkingStop(): boolean {
    const m = this.main;
    const p = m && !m.practice.finished ? (m.practice.speed < 0 ? 1 - m.practice.position : m.practice.position) : 1;
    this.looping = this.walkActive = false;
    if (p < 1 && m) {
      this.setDirection(this.sdir + p * wrapPm4(this.tdir - this.sdir));
      this.gridX = this.tx * p + this.sx * (1 - p);
      this.gridY = this.ty * p + this.sy * (1 - p);
      return false;
    }
    this.stopCurAnim();
    this.state = AS.standing;
    this.setDirection(this.svdir);
    this.tdir = this.dirF;
    this.gridX = this.tx = this.svx;
    this.gridY = this.ty = this.svy;
    this.applyPending();
    return true;
  }

  private applyPending(): void {
    if (this.pending === 1) this.followState = FOLLOW.ending;
    else if (this.pending === 2) this.followState = FOLLOW.arrived;
    else if (this.pending === 3) this.followState = FOLLOW.blocked;
  }

  /** The grid moves; the person follows only when it fits (start anims move the drawn position). */
  private moveGrid(x: number, y: number): void {
    this.gridX = x;
    this.gridY = y;
  }

  /**
   * Walking (9) / Running (10): steer towards a look-ahead point of the
   * path (half the loop's distance ahead), turning at most 0.2 a tick
   * (bigger turns stop for a StandingTurn); the person advances the loop's
   * distance per tick (x walking scale) and must fit at each step (else
   * follow state blocked). On the last segment the walk fades out and the
   * person snaps to the last point, then Standing faces the facing point.
   * True: redispatch.
   */
  private walking(): boolean {
    const path = this.path;
    const cnt = path.length;
    const last = cnt - 2;
    const walkStyle = this.host.objectData(17);
    const swim = this.host.personData(64) !== 0;
    const human = !this.isPet;
    const od9 = this.host.objectData(9);
    if (cnt < 2) {
      this.followState = FOLLOW.blocked;
      this.state = AS.standing;
      return false;
    }
    let target: { x: number; y: number } | null = null;
    let oneMore = false;
    for (let guard = 0; guard < 256 && !target; guard++) {
      const idx = Math.min(this.pathIndex, last);
      const pt = path[idx]!;
      const prev = idx === 0 ? pt : path[idx - 1]!;
      const segLen = Math.hypot(pt.fx - prev.fx, pt.fy - prev.fy);
      const d = Math.hypot(pt.fx - this.gridX, pt.fy - this.gridY);
      if (idx >= last) {
        const fp = path[cnt - 1]!;
        const face = wrap8f((calcAngle(fp.fx - pt.fx, fp.fy - pt.fy) * 8) / (2 * Math.PI) + 2);
        if (od9 !== 0) {
          const thr = 1.5 * (walkStyle === 1 ? 3 : 2);
          if (this.pending === 0 && d >= thr) {
            this.state = walkStyle === 1 ? AS.running : AS.walking;
            target = { x: pt.fx, y: pt.fy };
            break;
          }
          this.pending = 1;
          if (swim) return this.endWalk(pt.fx, pt.fy, face);
          this.tx = this.gridX;
          this.ty = this.gridY;
          this.state = AS.standing;
          this.followState = FOLLOW.ending;
          this.stopping = true;
          if (!this.main) return true;
          oneMore = true;
          return this.step(this.lastDx, this.lastDy, oneMore);
        }
        if (this.stopAt === 0) {
          const m = this.main;
          const p = m ? m.practice.position : 0;
          const inA = p < this.anchor2 || p >= this.anchor1;
          let stopD = inA ? this.stopDistA : this.stopDistB;
          if (!swim && walkStyle === 1) stopD *= 2;
          if (d <= stopD) {
            this.pending = 1;
            if (swim) return this.endWalk(pt.fx, pt.fy, face);
            if (!(m && !m.atEnd)) {
              const w = Math.max(stopD > 0 ? d / stopD : 0, 0.2);
              let ph = (inA ? this.anchor2 : this.anchor1) - p;
              if (ph < 1) ph += 1;
              const ms = Math.max(Math.trunc(ph * (m ? m.skill.duration / this.scale : 0)), 100);
              this.stopAt = this.clock + ms;
              if (m) this.fade = { from: m.practice.weight, to: w, at: this.clock, ms };
            }
          }
          target = { x: pt.fx, y: pt.fy };
          break;
        }
        if (this.stopAt > 0 && (walkStyle === 1 || d < 2 || this.clock >= this.stopAt)) {
          this.stopAt = -1;
          this.stopping = false;
          this.walkActive = false;
        }
        if (this.stopAt < 0) {
          this.gridX = this.tx = pt.fx;
          this.gridY = this.ty = pt.fy;
          this.tdir = face;
          this.state = AS.standing;
          this.followState = FOLLOW.ending;
          this.stopAt = 0;
          this.stopping = this.walkActive = false;
          this.stopCurAnim();
          return true;
        }
        target = { x: pt.fx, y: pt.fy };
        break;
      }
      // Not the last segment: look ahead along it.
      if (!this.main || this.main.atEnd) this.state = walkStyle === 1 ? AS.running : AS.walking;
      const step = segLen < 1e-6 ? 1 : 1 / segLen;
      let t = segLen * segLen > 0 ? 1 - ((this.gridX - pt.fx) * (prev.fx - pt.fx) + (this.gridY - pt.fy) * (prev.fy - pt.fy)) / (segLen * segLen) : 0;
      t = Math.min(1, Math.max(0, t));
      const r = 0.5 * (walkStyle === 0 ? this.halfWalk : this.halfRun);
      while (segLen > 0 && t < 1) {
        const sx = Math.trunc(prev.fx * (1 - t) + 0.5 + pt.fx * t);
        const sy = Math.trunc(prev.fy * (1 - t) + 0.5 + pt.fy * t);
        if ((sx - this.gridX) ** 2 + (sy - this.gridY) ** 2 >= r * r) {
          target = { x: sx, y: sy };
          break;
        }
        t += step;
      }
      if (!target) this.pathIndex++;
    }
    if (!target) return false;
    // STEER
    const vx = target.x - this.gridX;
    const vy = target.y - this.gridY;
    if (vx * vx + vy * vy <= 1e-6) return false;
    const head = wrap8f((calcAngle(vx, vy) * 8) / (2 * Math.PI) + 2);
    let dT = wrapPm4(head - this.dirF);
    let maxT = human ? 2 : 0.8;
    if (human && this.scale < 1) maxT /= this.scale;
    if (Math.abs(dT) >= maxT) {
      this.tx = this.gridX;
      this.ty = this.gridY;
      this.tdir = head;
      this.state = AS.standing;
      this.looping = false;
      return true;
    }
    let rate = human ? 0.2 : 0.057;
    if (this.scale < 1) rate /= this.scale;
    const clamped = Math.abs(dT) > rate;
    dT = Math.min(rate, Math.max(-rate, dT));
    this.setDirection(this.dirF + dT);
    const startD = walkStyle === 1 ? this.runStartDist : this.walkStartDist;
    if (!this.stopping && !this.looping && this.curAnim !== STD.runLoop && this.curAnim !== STD.walkLoop && (swim || (!clamped && vx * vx + vy * vy > startD * startD))) {
      this.state = walkStyle === 1 ? AS.runningStart : AS.walkingStart;
      return true;
    }
    this.looping = true;
    if (this.state === AS.running && walkStyle === 0) this.state = AS.walking;
    const anim = this.state === AS.walking ? STD.walkLoop : this.state === AS.running ? STD.runLoop : 0;
    const keep = this.main && this.main.skill.isMoving !== 0 ? this.main.practice.position : 0;
    if (anim !== 0 && this.curAnim !== anim && this.setCurAnim(anim, true) && this.main) this.main.practice.position = keep;
    if (this.main) this.main.rate = this.scale;
    const len = Math.sqrt(vx * vx + vy * vy <= 1e-6 ? 1 : vx * vx + vy * vy);
    const m = this.main;
    if (!m || m.skill.duration <= 0) return false;
    const perTick = ((16 * m.skill.distance) / 3) / (m.skill.duration / m.rate / MILS_PER_TICK);
    return this.step((vx * perTick) / len, (vy * perTick) / len, oneMore);
  }

  /** Where the last step did not fit (trace). */
  blockedAt: FollowPt | null = null;
  /** +0x28c / +0x290 the last step. */
  private lastDx = 0;
  private lastDy = 0;

  /** The STEP of Walking: the person moves to the rounded next position when it fits (else blocked). */
  private step(sdx: number, sdy: number, oneMore: boolean): boolean {
    this.walkActive = true;
    this.lastDx = sdx;
    this.lastDy = sdy;
    const nx = this.gridX + sdx;
    const ny = this.gridY + sdy;
    // TileList::FindNearestPoint(path, tp, idx): the placed point stays on the path's segments around idx.
    const near = findNearestPoint(this.path, Math.trunc(0.5 + nx), Math.trunc(0.5 + ny), this.pathIndex);
    const fx = near.fx;
    const fy = near.fy;
    if (!this.host.canPlace(fx, fy)) {
      this.followState = FOLLOW.blocked;
      this.blockedAt = { fx, fy };
      return false;
    }
    this.host.setLocation(fx, fy);
    this.gridX = nx;
    this.gridY = ny;
    if (this.endAsked && this.followState === FOLLOW.engaged && (!this.main || this.main.atEnd)) {
      if (this.host.personData(64) !== 0) {
        this.pending = 3;
        return this.endWalk(this.gridX, this.gridY, this.dirF);
      }
      this.followState = FOLLOW.blocked;
      return false;
    }
    if (oneMore) {
      this.tx = this.gridX;
      this.ty = this.gridY;
      this.tdir = this.dirF;
      return true;
    }
    return false;
  }

  /** ENDWALK (swimming): the walk start skill played backwards as the stop. */
  private endWalk(x: number, y: number, dir: number): boolean {
    this.sx = this.gridX;
    this.sy = this.gridY;
    this.sdir = this.dirF;
    this.svx = this.tx = x;
    this.svy = this.ty = y;
    this.svdir = this.tdir = dir;
    if (!this.walkActive) {
      this.state = AS.standing;
      this.applyPending();
      return true;
    }
    this.state = AS.walkingStop;
    const n = this.getSkillName(STD.walkStart);
    const sk = n ? requestSkill(n) : null;
    if (sk) this.start("main", sk, true, false);
    this.curAnim = STD.walkStart;
    return true;
  }

  /** StartVitaBoy's distances: start (+0x1f0 / +0x1fc), half loops (+0x1f8 / +0x1f4). */
  private get walkStartDist(): number {
    return this.stdDist(STD.walkStart);
  }
  private get runStartDist(): number {
    return this.stdDist(STD.runStart);
  }
  private get halfWalk(): number {
    return this.stdDist(STD.walkLoop) * 0.5;
  }
  private get halfRun(): number {
    return this.stdDist(STD.runLoop) * 0.5;
  }
  /**
   * The walk loop's foot phases (+0x168 / +0x16c: the "anchor" 1 / 2 tags
   * over the duration) and the stop distances at each (+0x170 / +0x174:
   * how far the anchored foot is ahead of the other one), measured as
   * SAnimator::StartVitaBoy does once the walk loop and the skeleton are
   * there (until then: phases 0 / 0.5, a quarter loop each); all 0 for an
   * object whose OBJD +0xcc has bit 2.
   */
  private get anchor1(): number {
    return this.walkMeasures()?.phase1 ?? 0;
  }
  private get anchor2(): number {
    return this.walkMeasures()?.phase2 ?? 0.5;
  }
  private get stopDistA(): number {
    return this.walkMeasures()?.stop1 ?? this.halfWalk * 0.5;
  }
  private get stopDistB(): number {
    return this.walkMeasures()?.stop2 ?? this.halfWalk * 0.5;
  }

  private walkMeasures(): WalkMeasures | null {
    // OBJD +0xcc bit 2 (NPC-FX): StartVitaBoy skips the measures, the constructor's zeros stay.
    if ((this.host.objdFlags() & 2) !== 0) return NO_WALK_MEASURES;
    const n = this.getSkillName(STD.walkLoop);
    const sk = n ? requestSkill(n) : null;
    return sk && this.skeleton ? measureWalkLoop(sk, this.skeleton) : null;
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
