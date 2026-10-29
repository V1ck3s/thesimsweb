/**
 * SAnimator::UpdateOutfitAndHands' choice of suits: what a person wears for
 * its current outfit (person data 8), costume trunk offset (21) and hand
 * gestures (22 left, 23 right).
 *
 * From the decompiled function (Mac 0x10352080, jump table lbl_105BC880 for
 * outfits 0..0x3c; the cases are only in the asm):
 *  - head: body string 3; hands: body strings 0x12 + 2 * gesture (left) and
 *    0x13 + 2 * gesture (right), gesture 3 = no hand ("nohandl" / "nohandr",
 *    texture "nohand"), out of 0..4 = open;
 *  - pets (gender bit 2 dog, bit 4 cat) always wear outfit 0 (person data 8
 *    is cleared);
 *  - 0 day clothes (2), 1 naked (16), 2 swimwear (0x20, else the old 17),
 *    3 job (cXPerson::GetJobSuitTex: the career level's cJob suit, texture
 *    and accessory), 4 formal (adults: 0x1f, else the old 0x1c with the
 *    gloves 0x1d / 0x1e; children 0x1c), 5 pajamas (0x21, else
 *    cXPerson::GetPajamasSuitTex), 6 / 7 skeleton (GetSkeletonSuitTex: body,
 *    head and hands; 7 the negative one), 8..0x10 costume trunk
 *    (GetCostumeTrunkSuitTex "ct-<name>-...-NN", NN = person data 21 + 1),
 *    0x11 winter (0x22), 0x12 fashion (0x23);
 *  - 0x13..0x3c: Studio Town and Magic Town costumes, escape character
 *    names resolved by EditPerson::SelectEscape* (body, and for most Magic
 *    Town ones head and hand textures; the mummy (0x37 / 0x38) takes its
 *    variant from person data 21 and clears the gestures; the donkey (0x39)
 *    only changes the head);
 *  - an empty body suit falls back to body string 2; the accessory record
 *    (+0x254[1]) wears the job accessory with an empty texture; the hands
 *    are dressed only when both hand suits are set.
 */

import { EditPerson } from "../cas/editperson.js";
import { BodyStrings, BS } from "./bodystrings.js";
import type { JobSuit } from "./personlook.js";

/** Person data read by UpdateOutfitAndHands (cXPerson +0x58c + 2 i). */
export const PD = {
  /** +0x59c */
  outfit: 8,
  /** +0x5b6 */
  costumeOffset: 21,
  /** +0x5b8 / +0x5ba */
  leftHand: 22,
  rightHand: 23,
  /** +0x5fc / +0x5fe */
  jobType: 56,
  jobLevel: 57,
  /** +0x600 */
  age: 58,
  /** +0x60e */
  gender: 65,
} as const;

/** A suit name and its body-string texture spec ("KEY=texture"). */
export interface SuitSpec {
  suit: string;
  texture: string;
}

/** The suits UpdateOutfitAndHands dresses. */
export interface OutfitSuits {
  head: SuitSpec;
  body: SuitSpec;
  /** The accessory record (job hats...): its texture is always empty. */
  accessory: string;
  lhand: SuitSpec;
  rhand: SuitSpec;
}

/** lbl_105BC8AC + 0x756.. : the costume trunk names of outfits 8..0x10. */
const TRUNK = ["toga", "cow", "luau", "rave", "cost", "nice", "swim", "pj", "disco"];

/** Outfits 0x13..0x36, 0x3a..0x3c: body suit / texture, head suit / texture, hand texture (lbl_105BC8AC + 0x781..). */
interface Costume {
  suit: string;
  tex: string;
  head?: [string, string];
  hand?: string;
}

const COSTUMES: ReadonlyMap<number, Costume> = new Map<number, Costume>([
  [0x13, { suit: "superstar$gaFit_movieactor1", tex: "superstar$gaFit$c_movieactor1" }],
  [0x14, { suit: "superstar$gaFit_movieactor2", tex: "superstar$gaFit$c_movieactor2" }],
  [0x15, { suit: "superstar$gaFit_movieactor3", tex: "superstar$gaFit$c_movieactor3" }],
  [0x16, { suit: "Superstar$gAfit_Doctor", tex: "Superstar$gAfit$c_Doctor" }],
  [0x17, { suit: "Superstar$gAfit_Relative", tex: "Superstar$gAfit$c_Relative" }],
  [0x18, { suit: "Runway$gAfit_Coffee", tex: "Runway$gAfit$c_Coffee" }],
  [0x19, { suit: "Runway$gAfit_Floral", tex: "Runway$gAfit$c_Floral" }],
  [0x1a, { suit: "Runway$gAfit_Architectural", tex: "Runway$gAfit$c_Architectural" }],
  [0x1b, { suit: "Runway$gAfit_Formal1", tex: "Runway$gAfit$c_Formal1" }],
  [0x1c, { suit: "Runway$gAfit_Formal2", tex: "Runway$gAfit$c_Formal2" }],
  [0x1d, { suit: "Runway$gAfit_Formal3", tex: "Runway$gAfit$c_Formal3" }],
  [0x1e, { suit: "Runway$gAfit_Lingerie1", tex: "Runway$gAfit$c_Lingerie1" }],
  [0x1f, { suit: "Runway$gAfit_Lingerie2", tex: "Runway$gAfit$c_Lingerie2" }],
  [0x20, { suit: "Runway$gAfit_Lingerie3", tex: "Runway$gAfit$c_Lingerie3" }],
  [0x21, { suit: "Superstar$gAfit_JumpSuit", tex: "Superstar$gAfit$c_JumpSuit" }],
  [0x22, { suit: "Superstar$gAfit_WetSuit", tex: "Superstar$gAfit$c_WetSuit" }],
  [0x23, { suit: "Superstar$gAFit_BackupDancerDance", tex: "Superstar$gAFit$c_BackupDancerDance" }],
  [0x24, { suit: "Superstar$gAfit_BackupDancerPop", tex: "Superstar$gAfit$c_BackupDancerPop" }],
  [0x25, { suit: "Superstar$gAfit_BackupDancerRock", tex: "Superstar$gAfit$c_BackupDancerRock" }],
  [0x26, { suit: "MagicMAFat_BeeKeeper", tex: "MagicMAFat_BeeKeeper", hand: "HUA$h_BeeKeeper" }],
  [0x27, { suit: "Magic$gAFit_BlueGenie", tex: "BMagic$gAFit_BlueGenie", head: ["CMagic$gAFit_BlueGenie", "CMagic$gA_BlueGenie"], hand: "H$gA$h_BlueGenie" }],
  [0x28, { suit: "MagicMAFit_Minotaur", tex: "BMagicMAFit_Minotaur", head: ["CMagicMAFit_Minotaur", "CMagicMAFit_Minotaur"], hand: "HMA$h_Minotaur" }],
  [0x29, { suit: "Magic$gAFit_Spookshow", tex: "Magic$gAFit$c_Spookshow" }],
  [0x2a, { suit: "Magic$gAFit_SideShow", tex: "Magic$gAFit$c_SideShow" }],
  [0x2b, { suit: "MagicFAFit_Vampire", tex: "MagicFAFit_Vampire", head: ["CMagicFAFit_Vampire", "CMagicFAFit_Vampire"], hand: "HFA$h_Vampire" }],
  [0x2c, { suit: "Magic$gAFit_Werewolf", tex: "Magic$gAFit_Werewolf", head: ["CMagic$gAFit_Werewolf", "CMagic$gAFit_Werewolf"], hand: "HMA$h_Werewolf" }],
  [0x2d, { suit: "MagicMAFit_Headless", tex: "MagicMAFit_Headless", head: ["CMagicMA_Headless", "CMagicMA_Headless"], hand: "HUA$h_Headless" }],
  [0x2e, { suit: "MagicMAFat_Troll", tex: "MagicMAFat_Troll", head: ["CMagicMAFat_Troll", "CMagicMAFat_Troll"], hand: "HUA$h_Troll" }],
  [0x2f, { suit: "MagicMAFat_Hunchback", tex: "MagicMAFat_Hunchback", head: ["CMagicMAFat_Hunchback", "CMagicMAFat_Hunchback"], hand: "HUA$h_Hunchback" }],
  [0x30, { suit: "Magic$gAFit_Sorcerer", tex: "Magic$gAFit_Sorcerer", head: ["CMagic$gAFit_Sorcerer", "CMagic$gAFit_Sorcerer"], hand: "HMA$h_Sorcerer" }],
  // The witch wears the hunchback's hands (as in the original).
  [0x31, { suit: "MagicFAFit_Witch", tex: "MagicFAFit_Witch", head: ["CMagicFAFit_Witch", "CMagicFAFit_Witch"], hand: "HUA$h_Hunchback" }],
  [0x32, { suit: "MagicFAFat_Ogress", tex: "BMagicFAFat_Ogress", head: ["CMagicFAFat_Ogress", "CMagicFAFat_Ogress"], hand: "HFA$h_Ogress" }],
  [0x33, { suit: "MagicFASkn_Crone", tex: "BMagicFASkn_Crone", head: ["CMagicFASkn_Crone", "CMagicFASkn_Crone"], hand: "HFA$h_Crone" }],
  [0x34, { suit: "MagicFASkn_Nymph", tex: "BMagicFASkn_Nymph", head: ["CMagicFASkn_Nymph", "CMagicFASkn_Nymph"], hand: "HUA$h_Nymph" }],
  [0x35, { suit: "MagicMCChd_Goblin", tex: "MagicMCChd_Goblin", head: ["CMagicMCChd_Goblin", "CMagicMCChd_Goblin"], hand: "HUC$h_Goblin" }],
  [0x36, { suit: "MagicFCChd_WizardGirl", tex: "MagicFCChd_WizardGirl", head: ["CMagicFC_WizardGirl", "CMagicFC_WizardGirl"], hand: "HFC$h_WizardGirl" }],
  [0x3a, { suit: "MagicMASkn_Vampire", tex: "MagicMASkn_Vampire", head: ["CMagicMASkn_Vampire", "CMagicMASkn_Vampire"], hand: "HMA$h_Vampire" }],
  [0x3b, { suit: "MagicMAFit_PrinceCharming", tex: "MagicMAFitlgt_PrinceCharming" }],
  [0x3c, { suit: "MagicMCChd_Skeleton", tex: "MagicMCChd_Skeleton", head: ["CMagicMCChd_Skeleton", "CMagicMCChd_Skeleton"], hand: "GUA$h_SkeletonChild" }],
]);

/** cXPerson::IsChild's test (age 1..17) as the suit helpers write it. */
function isChild(pd: ArrayLike<number>): boolean {
  const age = pd[PD.age] ?? 0;
  return age !== 0 && age < 0x12;
}

function isPet(pd: ArrayLike<number>): boolean {
  const g = pd[PD.gender] ?? 0;
  return (g & 2) !== 0 || (g & 4) !== 0;
}

/** StringBuffer::appendNum(n, 2). */
function num2(n: number): string {
  return String(n).padStart(2, "0");
}

/** EditPerson::SelectEscapeCharSuit / Texture of a body suit (EditPerson begun on the person, ended without saving). */
function escapeBody(ep: EditPerson, suit: string, tex: string): SuitSpec {
  return { suit: ep.selectEscapeCharSuit(suit), texture: ep.selectEscapeCharTexture(tex) };
}

/** cXPerson::GetCostumeTrunkSuitTex(name, offset): "ct-<name>-$gC-NN" (children) / "ct-<name>-$gAFit-NN", texture with "$c". */
function costumeTrunk(ep: EditPerson, pd: ArrayLike<number>, name: string): SuitSpec {
  const n = num2((pd[PD.costumeOffset] ?? 0) + 1);
  const [s, t] = isChild(pd) ? ["-$gC-", "-$gC$c-"] : ["-$gAFit-", "-$gAFit$c-"];
  return escapeBody(ep, `ct-${name}${s}${n}`, `ct-${name}${t}${n}`);
}

/** cXPerson::GetPajamasSuitTex: "pjs$gchd" (children) / "pajama$g$b", texture "pajama$g$c". */
function pajamas(ep: EditPerson, pd: ArrayLike<number>): SuitSpec {
  return escapeBody(ep, isChild(pd) ? "pjs$gchd" : "pajama$g$b", "pajama$g$c");
}

/** cXPerson::GetSkeletonSuitTex(negative): body, head and hand texture (lbl_105BBB7C + 0x26..). */
function skeleton(pd: ArrayLike<number>, negative: boolean): { body: SuitSpec; head: SuitSpec; hand: string } {
  const child = isChild(pd);
  const [bodyTex, headTex, handTex] = negative ? ["skeleneg_01", "c_skeleneg", "_GUAO_sneg"] : ["skeleton_01", "c_skeleton", "_GUAO_skel"];
  return {
    body: { suit: child ? "skeletonchd_01" : "skeleton_01", texture: `BODY=${bodyTex}` },
    head: { suit: child ? "c_kidskull" : "c_skeleton", texture: `HEAD-HEAD=${headTex}` },
    hand: `HAND=${handTex}`,
  };
}

/** cXPerson::GetJobSuitTex: the job's suit (cJob::GetSuit by gender; children use level 0), texture and accessory, escapes resolved. */
function jobSuit(ep: EditPerson, pd: ArrayLike<number>, job: JobSuit | null): { body: SuitSpec; accessory: string } {
  if (!job) return { body: { suit: "", texture: "" }, accessory: "" };
  const female = ((pd[PD.gender] ?? 0) & 1) !== 0;
  const suit = female && job.femaleSuit ? job.femaleSuit : job.suit;
  return { body: escapeBody(ep, suit, job.texture), accessory: job.accessory };
}

/**
 * The suits for `pd`'s outfit (SAnimator::UpdateOutfitAndHands). `job` gives
 * the career level's cJob strings for outfit 3 (the job level is 0 for a
 * child). Writes person data 8 := 0 for a pet and, for the mummy, the hand
 * gestures := 0, as the original does.
 */
export async function resolveOutfit(bs: BodyStrings, pd: Int16Array, job: (child: boolean) => JobSuit | null): Promise<OutfitSuits> {
  if (isPet(pd) && pd[PD.outfit] !== 0) pd[PD.outfit] = 0;
  const outfit = pd[PD.outfit]!;
  const gst = (i: number): SuitSpec => bs.getSuitAndTexture(i);
  const head = gst(BS.head);
  let accessory = "";
  const handIndex = (gesture: number, base: number): number => (gesture >= 0 && gesture <= 4 ? base + 2 * gesture : base);
  const lg = pd[PD.leftHand]!;
  const rg = pd[PD.rightHand]!;
  let rhand: SuitSpec = rg === 3 ? { suit: "nohandr", texture: "nohand" } : gst(handIndex(rg, 0x13));
  let lhand: SuitSpec = lg === 3 ? { suit: "nohandl", texture: "nohand" } : gst(handIndex(lg, 0x12));
  let body: SuitSpec;
  let ep: EditPerson | null = null;
  // EditPerson::Begin on the person (the costumes' escape names).
  const edit = async (): Promise<EditPerson> => (ep ??= await EditPerson.begin(bs.strings, pd.slice()));
  const emptyAt = (i: number): boolean => bs.get(i) === "";
  if (outfit >= 8 && outfit <= 0x10) body = costumeTrunk(await edit(), pd, TRUNK[outfit - 8]!);
  else if (outfit <= 0x12 || outfit > 0x3c) {
    switch (outfit) {
      case 1:
        body = gst(BS.nakedBody);
        break;
      case 2:
        body = gst(emptyAt(0x20) ? 0x11 : 0x20);
        break;
      case 3: {
        const j = jobSuit(await edit(), pd, job(isChild(pd)));
        body = j.body;
        accessory = j.accessory;
        break;
      }
      case 4: {
        const adult = (Number.parseInt(bs.get(14), 10) || 0) > 0x11;
        if (adult && emptyAt(0x1f)) {
          body = gst(0x1c);
          lhand = gst(0x1d);
          rhand = gst(0x1e);
        } else body = gst(adult ? 0x1f : 0x1c);
        break;
      }
      case 5:
        body = emptyAt(0x21) ? pajamas(await edit(), pd) : gst(0x21);
        break;
      case 6:
      case 7: {
        const s = skeleton(pd, outfit === 7);
        body = s.body;
        Object.assign(head, s.head);
        lhand = { suit: lhand.suit, texture: s.hand };
        rhand = { suit: rhand.suit, texture: s.hand };
        break;
      }
      case 0x11:
        body = gst(0x22);
        break;
      case 0x12:
        body = gst(0x23);
        break;
      default:
        body = gst(BS.body);
        break;
    }
  } else if (outfit === 0x39) {
    // The donkey: day clothes under a donkey head.
    const e = await edit();
    head.suit = e.selectEscapeHeadSuit("CMagicMAFat_Donkey");
    head.texture = e.selectEscapeHeadTexture("CMagicMAFat_Donkey");
    body = gst(BS.body);
  } else if (outfit === 0x37 || outfit === 0x38) {
    // The mummy: person data 21 picks full (0), headless (1), torso (2) or legs without hands (3).
    const e = await edit();
    pd[PD.leftHand] = 0;
    pd[PD.rightHand] = 0;
    const v = pd[PD.costumeOffset]!;
    let suit = "MagicMAFit_MummyFull";
    const headName = v >= 1 && v <= 3 ? "CMagicMA_Headless" : "CMagicMA_Mummy";
    let hand: string | null = "HUA$h_Mummy";
    if (v === 2) suit = "MagicMAFit_MummyTorso";
    else if (v === 3) {
      suit = "MagicMAFit_MummyLegs";
      lhand = { suit: "nohandl", texture: "nohand" };
      rhand = { suit: "nohandr", texture: "nohand" };
      hand = null;
    }
    body = escapeBody(e, suit, "MagicMAFit_Mummy");
    head.suit = e.selectEscapeHeadSuit(headName);
    head.texture = e.selectEscapeHeadTexture(headName);
    // The gestures read before they were cleared (+0x1b0 / +0x1b4).
    if (hand) {
      lhand = { suit: lhand.suit, texture: e.selectEscapeHandTexture(lg, hand) };
      rhand = { suit: rhand.suit, texture: e.selectEscapeHandTexture(rg, hand) };
    }
  } else {
    const c = COSTUMES.get(outfit)!;
    const e = await edit();
    body = escapeBody(e, c.suit, c.tex);
    if (c.head) {
      head.suit = e.selectEscapeHeadSuit(c.head[0]);
      head.texture = e.selectEscapeHeadTexture(c.head[1]);
    }
    if (c.hand) {
      lhand = { suit: lhand.suit, texture: e.selectEscapeHandTexture(lg, c.hand) };
      rhand = { suit: rhand.suit, texture: e.selectEscapeHandTexture(rg, c.hand) };
    }
  }
  if (!body.suit && outfit !== 0) body = gst(BS.body);
  return { head, body, accessory, lhand, rhand };
}
