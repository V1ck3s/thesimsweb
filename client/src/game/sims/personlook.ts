/**
 * What SAnimator::UpdateOutfitAndHands reads from its cXPerson, shared by the
 * simulation (which owns the person data) and the renderers (which dress the
 * VitaBoy): kept apart from the 3D code so the simulation does not load it.
 */

/** The cJob strings cXPerson::GetJobSuitTex reads (+0x284 male suit, +0x2d0 female suit, +0x31c texture, +0x368 accessory). */
export interface JobSuit {
  suit: string;
  femaleSuit: string;
  texture: string;
  accessory: string;
}

/**
 * The person's person data (outfit 8, costume offset 21, gestures 22 / 23,
 * job 56 / 57, age 58, gender 65), its job's suit strings and the
 * accessories its animations dressed (suit name -> texture spec).
 */
export interface PersonLook {
  readonly pd: Int16Array;
  /** cCareer::GetJobs()[level] strings of the person's career (`child`: level 0), null without a job. */
  job?(child: boolean): JobSuit | null;
  readonly accessories?: ReadonlyMap<string, string>;
}

/** The person each lot object stands for (set by the simulation's cXPerson), read by the lot renderer. */
export const personLooks = new WeakMap<object, PersonLook>();
