/**
 * BodyStrings: a person's appearance, STR# 200 ("bodystring") of the
 * character file. 1-based indices (StringSetBase):
 *
 *   1 skeleton ("adult", "child", "dog", "kat")
 *   2 body suit ("b006fafat_01,BODY=B006FAFatlgt_TT1"), 3 head suit
 *   4..7 registration bones (head, top, hand, palm)
 *   13 gender, 14 age, 15 skin tone ("lgt", "med", "drk")
 *   16 naked body, 17 swimwear, 18..23 hands (left/right x open, pointing, closed),
 *   28.. formal / pajamas / ... outfits
 *
 * An entry is "suit,TEXKEY=texture[;original]": GetSuitAndTexture splits it
 * into the lowercased suit name and "TEXKEY=texture" (texture lowercased).
 */

/** Indices used by SAnimator::UpdateOutfitAndHands. */
export const BS = {
  skeleton: 1,
  body: 2,
  head: 3,
  nakedBody: 16,
  /** Hand suits: left/right for hand states 0 (open) .. 4 (SAnimator: 0x12 + 2 * state). */
  leftHandOpen: 18,
  rightHandOpen: 19,
} as const;

export class BodyStrings {
  constructor(readonly strings: readonly string[]) {}

  get(index: number): string {
    return this.strings[index - 1] ?? "";
  }

  /** BodyStrings::GetSuitAndTexture(index, suit, texture, original). */
  getSuitAndTexture(index: number, original = false): { suit: string; texture: string } {
    const all = this.get(index);
    const semi = all.indexOf(";");
    let s: string;
    if (!original) s = semi >= 0 ? all.slice(0, semi) : all;
    else s = semi >= 0 ? all.slice(semi + 1) : "";
    const comma = s.indexOf(",");
    if (comma < 0) return { suit: s.toLowerCase(), texture: "" };
    const suit = s.slice(0, comma).toLowerCase();
    const rest = s.slice(comma + 1);
    const eq = rest.indexOf("=");
    const texture = eq < 0 ? rest.toLowerCase() : rest.slice(0, eq + 1) + rest.slice(eq + 1).toLowerCase();
    return { suit, texture };
  }
}
