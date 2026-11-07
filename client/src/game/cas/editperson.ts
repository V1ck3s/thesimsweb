/**
 * EditPerson: the appearance side of Create-a-Sim. Edits a person's body
 * strings (STR# 200 of the character file) the way the game does while a
 * person is designed (PersonFinder::BeginDesignAPerson .. EndDesignAPerson).
 *
 * Ported from the decompiled Mac build:
 *  - RegExpTree (AddRequired / AddOption / AddWildcard / SetPrefix /
 *    GetMatchingLength) and RegExpBestFit::TestString;
 *  - EditPerson::GetSuit (the animation manager's suit table minus "suit-*"),
 *    GetCachedList / GetCached{Formal,Swimwear,Lingerie,Winter,Fashion}List
 *    (one list per skin color x gender x age) and the matching
 *    GetAvailable{Body,Head,Formal,Swimwear,Lingerie,Winter,Fashion}Suits;
 *  - Set/Get/CountAvailable{Body,Head}Suit, SetGender / GetGender, SetAge /
 *    GetAge, SetColor / GetColor, GetSpecies;
 *  - UpdateSuits, ForceUpdateSuits (naked body, underwear, the 8 hands,
 *    entry 28), SetupNewSkins, SetupChildHDSkins, SetupVacationSkins,
 *    SetupFashionSkins;
 *  - Begin / End (fills missing outfits; End(false) restores the strings);
 *  - PersonFinder::SetupNewHDSkins; PersonFinder::Set{Gender,Age,Color,
 *    HeadSuit,BodySuit} (they forward with update = true);
 *  - the person-data side of SAnimator::ResetSuits (run where the game
 *    resets the instance's suits): PD[65] gender, PD[58] age, PD[60] skin
 *    index, PD[22] / PD[23] cleared.
 *
 * Not reproduced:
 *  - the walk orders: the game iterates a hash table of suits and the texture
 *    scanner's directory listing, whose orders are unknown here; both name
 *    lists are sorted alphabetically (this decides which suit is index 0 and
 *    which candidate wins a best-fit tie);
 *  - names are lowercased (the asset index keeps lowercased file names), so
 *    the written body strings are lowercase where the game keeps the file
 *    case. The game compares them case-insensitively;
 *  - the instance side lives with whoever shows the person: EditPerson calls
 *    onResetInstanceSuits where the game calls ResetInstanceSuits (end of
 *    ForceUpdateSuits, end of UpdateSuits for pets, the empty-list cases);
 *    PersonFinder::SetAge's killing and re-creating of the cXPerson is the
 *    Create-a-Sim screen's (cas/windesigncharacter.ts).
 *
 * Also ported: the clownie suits (Get/Count/SetClownieSuit,
 * GetCachedClownieList), which only Neighborhood::RefillFans (not ported)
 * uses.
 */

import { BodyStrings } from "../sims/bodystrings.js";
import { VBAnimMgr } from "../sims/vbanimmgr.js";

export type PersonColor = "lgt" | "med" | "drk";
export const PERSON_AGE_ADULT = 0;
export const PERSON_AGE_CHILD = 1;
export const PERSON_GENDER_MALE = 0;
export const PERSON_GENDER_FEMALE = 1;

/** lbl_105BA0B4: texture keys of the body string entries. */
const BODY_KEY = "BODY=";
const HEAD_KEY = "HEAD-HEAD=";
const HAND_KEY = "HAND=";

/** lbl_105BB858 string constants. */
const S = {
  empty: "",
  unknownColor: "???",
  genders: ["male", "female", "dogmale", "dogfemale", "catmale", "catfemale"],
  dog: "dog",
  kat: "kat",
  adultAge: "27",
  childAge: "9",
  child: "child",
  adult: "adult",
  added: "ADDED",
  none: "NONE",
  bodyTypes: ["skn", "fit", "fat"],
  fit: "fit",
  chd: "chd",
  cchd: "cchd",
  suitExcluded: "suit-",
  clownie: "B20",
  clownieExcluded: "B200",
} as const;

/** lbl_105BA094 / 098 / 09C: the three skin colors. */
const COLORS: readonly PersonColor[] = ["drk", "med", "lgt"];
/** PersonGlobals.iff STR# 0x2000 ("skin colors"): SAnimator::ResetSuits stores (index - 1). */
const SKIN_INDEX: Record<string, number> = { lgt: 1, drk: 2, med: 3 };

/** lbl_105BB850: the hand best fits of ForceUpdateSuits (texture prefix, side, pose). */
const HANDS: readonly [string, string, string][] = [
  ["G", "L", "O"],
  ["G", "R", "O"],
  ["H", "L", "O"],
  ["H", "R", "O"],
  ["H", "L", "C"],
  ["H", "R", "C"],
  ["H", "L", "P"],
  ["H", "R", "P"],
];
/** lbl_105BB84C: the body string each hand goes to (1-based). */
const HAND_ENTRIES = [29, 30, 18, 19, 22, 23, 20, 21];

/** Body string entries (1-based). */
const E = {
  skeleton: 1,
  body: 2,
  head: 3,
  gender: 13,
  age: 14,
  color: 15,
  naked: 16,
  underwear: 17,
  leftHand: 18,
  rightHand: 19,
  entry28: 28,
  formal: 0x1f,
  swimwear: 0x20,
  lingerie: 0x21,
  winter: 0x22,
  fashion: 0x23,
} as const;

/** lbl_105BEC88: RegExpBestFit's tie tolerance. */
const BEST_FIT_EPSILON = Math.fround(1e-4);

// --- RegExpTree ---------------------------------------------------------------

type RegExpNode = { kind: "req"; s: string } | { kind: "opt"; a: string; b: string } | { kind: "wild"; n: number };

/** Case folding of GetMatchingLength: only 'A'..'Z' are lowered. */
function fold(c: string): string {
  return c >= "A" && c <= "Z" ? c.toLowerCase() : c;
}

class RegExpTree {
  readonly nodes: RegExpNode[] = [];

  addRequired(s: string): this {
    this.nodes.push({ kind: "req", s });
    return this;
  }

  addOption(a: string, b: string): this {
    this.nodes.push({ kind: "opt", a, b });
    return this;
  }

  addWildcard(n: number): this {
    this.nodes.push({ kind: "wild", n });
    return this;
  }

  /** RegExpTree::SetPrefix: replaces the first node's string. */
  setPrefix(s: string): this {
    const n = this.nodes[0];
    if (n?.kind === "req") n.s = s;
    else if (n?.kind === "opt") n.a = s;
    return this;
  }

  clone(): RegExpTree {
    const t = new RegExpTree();
    for (const n of this.nodes) t.nodes.push({ ...n });
    return t;
  }

  /**
   * RegExpTree::GetMatchingLength: the longest prefix of `str` that matches
   * the whole node sequence (the original backtracks over every option),
   * 0 when nothing matches.
   */
  getMatchingLength(str: string): number {
    if (this.nodes.length === 0) return 0;
    let best = 0;
    const lit = (s: string, pos: number): number => {
      let i = 0;
      while (i < s.length && pos + i < str.length && fold(str[pos + i]!) === fold(s[i]!)) i++;
      return i === s.length ? pos + i : -1;
    };
    const walk = (k: number, pos: number): void => {
      const n = this.nodes[k];
      if (!n) {
        if (pos > best) best = pos;
        return;
      }
      if (n.kind === "wild") {
        if (n.n <= str.length - pos) walk(k + 1, pos + n.n);
        return;
      }
      const ends = n.kind === "req" ? [lit(n.s, pos)] : k === 0 ? [lit(n.a, pos)] : [lit(n.a, pos), lit(n.b, pos)];
      for (const e of ends) if (e >= 0) walk(k + 1, e);
    };
    walk(0, 0);
    return best;
  }
}

/** RegExpBestFit: keeps the string matching the largest share of its length. */
class RegExpBestFit {
  private ratio = 0;
  private length = 0;
  best = "";

  constructor(readonly tree: RegExpTree) {}

  /** RegExpBestFit::TestString */
  testString(s: string): void {
    const len = this.tree.getMatchingLength(s);
    if (len === 0) return;
    const r = Math.fround(len / s.length);
    if ((Math.abs(r - this.ratio) <= BEST_FIT_EPSILON && this.length < len) || this.ratio < r) {
      this.ratio = r;
      this.length = len;
      this.best = s;
    }
  }
}

// --- suit / texture pairs ---------------------------------------------------

/** SuitTex: a suit name and its "KEY=texture". */
interface SuitTex {
  suit: string;
  tex: string;
}

function suitTexStr(st: SuitTex): string {
  return `${st.suit},${st.tex}`;
}

function suitTexEq(a: SuitTex, b: SuitTex): boolean {
  return a.suit.toLowerCase() === b.suit.toLowerCase() && a.tex.toLowerCase() === b.tex.toLowerCase();
}

export type ListKind = "body" | "head" | "formal" | "swimwear" | "lingerie" | "winter" | "fashion";
/** The outfit lists of Get / Set / CountAvailable / SetToNextValid*ForBodyType. */
export type OutfitKind = Exclude<ListKind, "head">;

/** First letter of the outfit suits (GetAvailable*Suits). */
const OUTFIT_PREFIX: Record<Exclude<ListKind, "body" | "head">, string> = {
  formal: "F",
  swimwear: "S",
  lingerie: "L",
  winter: "W",
  fashion: "H",
};

/** Shared suit/texture name lists and the per (kind, skin, gender, age) caches (static in the game). */
interface Catalog {
  suits: string[];
  textures: string[];
  lists: Map<string, SuitTex[]>;
}

let catalog: Promise<Catalog> | null = null;

/** The catalog once loaded (EditPerson.beginLoaded). */
let loadedCatalog: Catalog | null = null;

function loadCatalog(mgr?: VBAnimMgr): Promise<Catalog> {
  catalog ??= (async () => {
    const m = mgr ?? (await VBAnimMgr.get());
    // The suits of the loose skin files, under their own names (LoadAllAnimations at startup).
    await m.loadLooseAnimations();
    // EditPerson::GetSuit: every suit but the "suit-*" ones.
    const suits = m
      .suitNames()
      .filter((s) => s.length < 5 || !s.startsWith(S.suitExcluded))
      .sort();
    loadedCatalog = { suits, textures: m.textureNames().sort(), lists: new Map() };
    return loadedCatalog;
  })();
  return catalog;
}

/** Loads the suit catalog EditPerson.beginLoaded needs. */
export function preloadEditPersonCatalog(): Promise<void> {
  return loadCatalog().then(() => undefined);
}

export class EditPerson {
  private strings: string[];
  private readonly original: string[];
  private readonly cache = new Map<ListKind, SuitTex[]>();
  /** +0x94: the clownie list, kept across SetGender / SetAge / SetColor (they only clear +0x78..+0x90). */
  private clownieList: SuitTex[] | null = null;
  /**
   * ResetInstanceSuits(selector, person): the person's instance re-reads its
   * suits (SAnimator::ResetSuits) and its head texture is marked dirty.
   * Installed by whoever shows the instance; nothing happens without one.
   */
  onResetInstanceSuits: (() => void) | null = null;

  private constructor(
    private readonly cat: Catalog,
    bodyStrings: readonly string[],
    readonly personData: Int16Array,
  ) {
    this.strings = [...bodyStrings];
    this.original = [...bodyStrings];
  }

  /** EditPerson::Begin (+ PersonFinder::BeginDesignAPerson): fills the outfits a person lacks. */
  static async begin(bodyStrings: readonly string[], personData: Int16Array, mgr?: VBAnimMgr): Promise<EditPerson> {
    const ep = new EditPerson(await loadCatalog(mgr), bodyStrings, personData);
    ep.beginFill();
    ep.original.splice(0, ep.original.length, ...ep.strings);
    return ep;
  }

  /** EditPerson::Begin without waiting: null until preloadEditPersonCatalog has finished. */
  static beginLoaded(bodyStrings: readonly string[], personData: Int16Array): EditPerson | null {
    if (!loadedCatalog) return null;
    const ep = new EditPerson(loadedCatalog, bodyStrings, personData);
    ep.beginFill();
    ep.original.splice(0, ep.original.length, ...ep.strings);
    return ep;
  }

  private beginFill(): void {
    if (this.get(E.body) === S.empty) return;
    const g = this.getGender();
    if (g > 1) return;
    if (this.isAdult()) {
      if (this.get(E.formal) === S.empty) this.setupNewSkins();
      if (this.get(E.fashion) === S.empty) this.setupFashionSkins();
    } else {
      if (this.get(E.formal) === S.empty) {
        this.set(E.formal, S.added);
        this.setupChildHDSkins();
      }
      if (this.get(E.fashion) === S.empty) this.set(E.fashion, S.added);
    }
    if (this.get(E.winter) === S.empty) this.setupVacationSkins();
  }

  /** EditPerson::End: keeps the edits (after a last UpdateSuits) or restores the strings. */
  end(save: boolean): void {
    if (save) this.updateSuits();
    else this.strings = [...this.original];
  }

  bodyStrings(): string[] {
    return [...this.strings];
  }

  // --- body string access (BodyStrings::SetBodyString / StringSetBase::GetString)

  private get(index: number): string {
    return this.strings[index - 1] ?? "";
  }

  private has(index: number): boolean {
    return index - 1 < this.strings.length;
  }

  private set(index: number, value: string): void {
    while (this.strings.length < index) this.strings.push("");
    this.strings[index - 1] = value;
  }

  private suitTex(index: number): SuitTex {
    const { suit, texture } = new BodyStrings(this.strings).getSuitAndTexture(index);
    return { suit, tex: texture };
  }

  /** atoi of entry 14. */
  private ageYears(): number {
    const n = Number.parseInt(this.get(E.age), 10);
    return Number.isNaN(n) ? 0 : n;
  }

  private isAdult(): boolean {
    return this.ageYears() >= 18;
  }

  /** GetColor: entry 15, "???" when the entry is missing. */
  private skin(): string {
    return this.has(E.color) ? this.get(E.color) : S.unknownColor;
  }

  /** The skin color the Setup*Skins best fits use: the person's if it is one of the three, else "lgt". */
  private fitSkin(): string {
    const s = this.skin().toLowerCase();
    return (COLORS as readonly string[]).includes(s) ? s : "lgt";
  }

  /** Body type of the body suit: characters 6..8 of its name ("fit", "fat", "skn", "chd"). */
  private bodyType(): string {
    return this.suitTex(E.body).suit.slice(6, 9);
  }

  private fitBodyType(): string {
    const t = this.bodyType();
    return (S.bodyTypes as readonly string[]).includes(t) ? t : S.fit;
  }

  private genderLetter(): string {
    const g = this.getGender();
    return g === PERSON_GENDER_FEMALE ? "f" : g === PERSON_GENDER_MALE ? "m" : "";
  }

  // --- species / gender / age / color -----------------------------------------

  /** EditPerson::GetSpecies: 0 person, 1 dog, 2 cat. */
  private getSpecies(): number {
    const g = this.get(E.gender).toLowerCase();
    if (g === "dogmale" || g === "dogfemale") return 1;
    if (g === "catmale" || g === "catfemale") return 2;
    return 0;
  }

  /** EditPerson::GetGender: index of entry 13 in male, female, dogmale, dogfemale, catmale; anything else is 5. */
  getGender(): number {
    const i = S.genders.indexOf(this.get(E.gender).toLowerCase() as (typeof S.genders)[number]);
    return i < 0 || i > 4 ? 5 : i;
  }

  /** PersonFinder::SetGender -> EditPerson::SetGender(g, update). */
  setGender(g: number, update = true): void {
    if (g === 2 || g === 3) this.set(E.skeleton, S.dog);
    else if (g === 4 || g === 5) this.set(E.skeleton, S.kat);
    const name = S.genders[g];
    if (name !== undefined) this.set(E.gender, name);
    this.cache.clear();
    if (update) this.updateSuits();
  }

  /** EditPerson::GetAge: PERSON_AGE_CHILD under 18. */
  getAge(): number {
    return this.isAdult() ? PERSON_AGE_ADULT : PERSON_AGE_CHILD;
  }

  /** PersonFinder::SetAge -> EditPerson::SetAge(age, update): entry 14 and, for people, the skeleton. */
  setAge(age: number, update = true): void {
    this.set(E.age, age === PERSON_AGE_ADULT ? S.adultAge : S.childAge);
    if (this.getSpecies() === 0) this.set(E.skeleton, age === PERSON_AGE_CHILD ? S.child : S.adult);
    this.cache.clear();
    if (update) this.updateSuits();
  }

  getColor(): PersonColor {
    return this.skin() as PersonColor;
  }

  /** PersonFinder::SetColor -> EditPerson::SetColor(c, update). */
  setColor(c: PersonColor, update = true): void {
    this.set(E.color, c);
    this.cache.clear();
    if (update) this.updateSuits();
  }

  // --- suit lists ----------------------------------------------------------------

  /** GetCachedList / GetCached*List: built once per skin x gender x age (and kind). */
  private list(kind: ListKind): SuitTex[] {
    let l = this.cache.get(kind);
    if (!l) {
      const key = `${kind}|${this.skin().toLowerCase()}|${this.getGender()}|${this.getAge()}`;
      l = this.cat.lists.get(key);
      if (!l) {
        l = this.getAvailable(kind);
        this.cat.lists.set(key, l);
      }
      this.cache.set(kind, l);
    }
    return l;
  }

  /** GetAvailable{Body,Head,Formal,...}Suits */
  private getAvailable(kind: ListKind): SuitTex[] {
    const g = this.getGender();
    const human = g === PERSON_GENDER_MALE || g === PERSON_GENDER_FEMALE;
    // Pets have one body list and no head / outfit lists.
    if (!human && kind !== "body") return [];
    const tree = new RegExpTree();
    let key = BODY_KEY;
    if (kind === "body") {
      tree.addRequired("B").addWildcard(3);
      if (human) {
        tree.addOption(g === PERSON_GENDER_FEMALE ? "f" : "m", "u");
        tree.addRequired(this.isAdult() ? "a" : "c");
        tree.addWildcard(3);
      } else {
        tree.addRequired(g < 4 ? S.dog : "cat");
      }
    } else {
      tree.addRequired(kind === "head" ? "c" : OUTFIT_PREFIX[kind]).addWildcard(3);
      tree.addOption(g === PERSON_GENDER_FEMALE ? "f" : "m", "u");
      tree.addRequired(this.isAdult() ? "a" : "c");
      if (kind === "head") key = HEAD_KEY;
      else tree.addWildcard(3);
    }
    const skin = this.skin();
    const out: SuitTex[] = [];
    for (const suit of this.cat.suits) {
      const n = tree.getMatchingLength(suit);
      if (n <= 0) continue;
      if (kind === "head" && (suit[1] === "t" || suit[1] === "T")) continue;
      const texTree = new RegExpTree().addRequired(suit.slice(0, n));
      if (human) texTree.addRequired(skin);
      for (const tex of this.cat.textures) {
        if (texTree.getMatchingLength(tex) > 0) out.push({ suit, tex: key + tex });
      }
    }
    return out;
  }

  private indexIn(kind: ListKind, entry: number): number {
    const st = this.suitTex(entry);
    return this.list(kind).findIndex((x) => suitTexEq(x, st));
  }

  countAvailableBodySuits(): number {
    return this.list("body").length;
  }

  countAvailableHeadSuits(): number {
    return this.list("head").length;
  }

  getBodySuit(): number {
    return this.indexIn("body", E.body);
  }

  getHeadSuit(): number {
    return this.indexIn("head", E.head);
  }

  /** EditPerson::SetBodySuit: -1 clears the entry; an index out of the list is ignored. */
  setBodySuit(i: number, update = true): void {
    this.setSuit("body", E.body, i, update);
  }

  /** EditPerson::SetHeadSuit */
  setHeadSuit(i: number, update = true): void {
    this.setSuit("head", E.head, i, update);
  }

  private setSuit(kind: ListKind, entry: number, i: number, update: boolean): void {
    let value = "";
    if (i !== -1) {
      const st = this.list(kind)[i];
      if (i < 0 || !st) return;
      value = suitTexStr(st);
    }
    this.set(entry, value);
    if (update) this.updateSuits();
  }

  /** The body string entry of an outfit list. */
  private static outfitEntry(kind: OutfitKind): number {
    return kind === "body" ? E.body : E[kind];
  }

  /** CountAvailable{Body,Formal,Swimwear,Lingerie,Winter,Fashion}Suits */
  countAvailable(kind: OutfitKind): number {
    return this.list(kind).length;
  }

  /** Get{Body,Formal,Swimwear,Lingerie,Winter,Fashion}Suit: the entry's index in its list, -1 when absent. */
  getOutfitSuit(kind: OutfitKind): number {
    return this.indexIn(kind, EditPerson.outfitEntry(kind));
  }

  /** Set{Body,Formal,Swimwear,Lingerie,Winter,Fashion}Suit */
  setOutfitSuit(kind: OutfitKind, i: number, update = true): void {
    this.setSuit(kind, EditPerson.outfitEntry(kind), i, update);
  }

  /**
   * SetToNextValid*SuitForBodyType / SetToPreviousValid*SuitForBodyType:
   * from the entry's index in its list, steps (wrapping) to the next suit
   * whose body type (suit name characters 6..8) is the current one's; a
   * pet's body takes the next suit of the list. Nothing changes when the
   * walk comes back to the start.
   */
  setToNextValidSuitForBodyType(kind: OutfitKind, forward: boolean, update = true): void {
    const list = this.list(kind);
    const n = list.length;
    const cur = this.indexIn(kind, EditPerson.outfitEntry(kind));
    const type = (list[cur]?.suit ?? this.suitTex(EditPerson.outfitEntry(kind)).suit).slice(6, 9).toLowerCase();
    const pet = kind === "body" && this.getGender() !== PERSON_GENDER_MALE && this.getGender() !== PERSON_GENDER_FEMALE;
    let i = cur;
    for (;;) {
      i += forward ? 1 : -1;
      if (i === cur) return;
      if (forward && i >= n) i = 0;
      if (!forward && i < 0) i = n - 1;
      if (n === 0 || i === cur) return;
      if (pet || list[i]!.suit.slice(6, 9).toLowerCase() === type) break;
    }
    this.setSuit(kind, EditPerson.outfitEntry(kind), i, update);
  }

  // --- clownie suits (Neighborhood::RefillFans' clowns) -----------------------------

  /**
   * EditPerson::GetAvailableClownieSuits: the suits matching "B20" + one
   * character (+ "m" / "u" for men, "f" / "u" for women) + "a" (+ three
   * characters for people), "B200*" excepted, each with every texture
   * whose name starts with the matched part of the suit (+ the skin color
   * for people), keyed "BODY=".
   */
  private getAvailableClownieSuits(): SuitTex[] {
    const g = this.getGender();
    const human = g === PERSON_GENDER_MALE || g === PERSON_GENDER_FEMALE;
    const tree = new RegExpTree().addRequired(S.clownie).addWildcard(1);
    const excluded = new RegExpTree().addRequired(S.clownieExcluded);
    if (g === PERSON_GENDER_FEMALE) {
      tree.addOption("f", "u");
      excluded.addOption("f", "u");
    } else if (g === PERSON_GENDER_MALE) {
      tree.addOption("m", "u");
      excluded.addOption("m", "u");
    }
    tree.addRequired("a");
    excluded.addRequired("a");
    if (human) {
      tree.addWildcard(3);
      excluded.addWildcard(3);
    }
    const skin = this.skin();
    const out: SuitTex[] = [];
    for (const suit of this.cat.suits) {
      const n = tree.getMatchingLength(suit);
      if (n <= 0 || excluded.getMatchingLength(suit) > 0) continue;
      const texTree = new RegExpTree().addRequired(suit.slice(0, n));
      if (human) texTree.addRequired(skin);
      for (const tex of this.cat.textures) {
        if (texTree.getMatchingLength(tex) > 0) out.push({ suit, tex: BODY_KEY + tex });
      }
    }
    return out;
  }

  /**
   * EditPerson::GetCachedClownieList: one list per skin color (the
   * SkinColorCache), child or adult, and male or not (+0x80 + (2 child +
   * (gender != 0)) * 4: every non-male gender shares the slot).
   */
  private cachedClownieList(): SuitTex[] {
    if (this.clownieList) return this.clownieList;
    const key = `clownie|${this.skin().toLowerCase()}|${this.isAdult() ? 0 : 1}|${this.getGender() !== 0 ? 1 : 0}`;
    let l = this.cat.lists.get(key);
    if (!l) {
      l = this.getAvailableClownieSuits();
      this.cat.lists.set(key, l);
    }
    this.clownieList = l;
    return l;
  }

  /** EditPerson::CountAvailableClownieSuits */
  countAvailableClownieSuits(): number {
    return this.cachedClownieList().length;
  }

  /** EditPerson::SetClownieSuit: the body (entry 2); -1 clears it, an index out of the list is ignored. */
  setClownieSuit(i: number, update = true): void {
    const list = this.cachedClownieList();
    let value = "";
    if (i !== -1) {
      const st = list[i];
      if (i < 0 || !st) return;
      value = suitTexStr(st);
    }
    this.set(E.body, value);
    if (update) this.updateSuits();
  }

  // --- UpdateSuits ---------------------------------------------------------------

  /** EditPerson::UpdateSuits: makes the outfits, naked body and hands follow the body / head. */
  updateSuits(): void {
    let body = this.indexIn("body", E.body);
    let head = 0;
    let formal = 0;
    let swim = 0;
    let ling = 0;
    let winter = 0;
    let fashion = 0;
    const g = this.getGender();
    const human = g === PERSON_GENDER_MALE || g === PERSON_GENDER_FEMALE;
    if (human) {
      head = this.indexIn("head", E.head);
      if (this.isAdult()) {
        formal = this.indexIn("formal", E.formal);
        swim = this.indexIn("swimwear", E.swimwear);
        ling = this.indexIn("lingerie", E.lingerie);
        winter = this.indexIn("winter", E.winter);
        fashion = this.indexIn("fashion", E.fashion);
      } else {
        this.set(E.formal, S.added);
        formal = 0;
        swim = this.indexIn("swimwear", E.swimwear);
        ling = this.indexIn("lingerie", E.lingerie);
        winter = this.indexIn("winter", E.winter);
        this.set(E.fashion, S.added);
        fashion = 0;
      }
    } else {
      for (const e of [E.head, E.formal, E.swimwear, E.lingerie, E.winter, E.fashion]) this.set(e, S.none);
    }

    // Outfits cut for another body type than the body suit's are dropped.
    if (body !== -1 && human) {
      const type = this.get(E.body).slice(6, 9);
      const typeOf = (e: number): string => this.get(e).slice(6, 9);
      const isType = (S.bodyTypes as readonly string[]).includes(type);
      if (this.isAdult()) {
        if (isType) {
          if (formal !== -1 && type !== typeOf(E.formal)) formal = -1;
          if (swim !== -1 && type !== typeOf(E.swimwear)) swim = -1;
          if (ling !== -1 && type !== typeOf(E.lingerie)) ling = -1;
          if (fashion !== -1 && type !== typeOf(E.fashion)) fashion = -1;
        }
      } else if (type === S.chd) {
        if (swim !== -1 && type !== typeOf(E.swimwear)) swim = -1;
        if (ling !== -1 && type !== typeOf(E.lingerie)) ling = -1;
      }
      if (isType || type === S.chd) {
        if (winter !== -1 && type !== typeOf(E.winter)) winter = -1;
      }
    }

    if (head === -1 || body === -1) {
      const heads = this.list("head");
      const bodies = this.list("body");
      if (heads.length > 0 && bodies.length > 0) {
        if (head === -1) this.set(E.head, suitTexStr(heads[0]!));
        if (body === -1) {
          if (human) {
            if (this.isAdult()) formal = swim = ling = winter = fashion = -1;
            else swim = ling = winter = -1;
          }
          this.set(E.body, suitTexStr(bodies[0]!));
          body = 0;
        }
      } else {
        for (const e of [E.body, E.head, E.leftHand, E.rightHand, E.naked, E.underwear]) this.set(e, S.empty);
        this.onResetInstanceSuits?.();
      }
    }

    if (formal === -1 || swim === -1 || ling === -1) {
      const fl = this.list("formal");
      const sl = this.list("swimwear");
      const ll = this.list("lingerie");
      if (fl.length > 0 && sl.length > 0 && ll.length > 0) {
        if (this.isAdult()) {
          if (formal === -1 && swim === -1 && ling === -1) this.setupNewSkins();
          else {
            this.set(E.formal, suitTexStr(fl[Math.max(0, formal)]!));
            this.set(E.swimwear, suitTexStr(sl[Math.max(0, swim)]!));
            this.set(E.lingerie, suitTexStr(ll[Math.max(0, ling)]!));
          }
        } else if (formal === 0 && swim === -1 && ling === -1) {
          this.setupChildHDSkins();
        } else {
          this.set(E.swimwear, suitTexStr(sl[Math.max(0, swim)]!));
          this.set(E.lingerie, suitTexStr(ll[Math.max(0, ling)]!));
        }
      } else {
        for (const e of [E.formal, E.swimwear, E.lingerie]) this.set(e, S.empty);
        this.onResetInstanceSuits?.();
      }
    }
    if (winter === -1) {
      if (this.list("winter").length < 1) {
        this.set(E.winter, S.empty);
        this.onResetInstanceSuits?.();
      } else this.setupVacationSkins();
    }
    if (fashion === -1) {
      if (this.list("fashion").length < 1) {
        this.set(E.fashion, S.empty);
        this.onResetInstanceSuits?.();
      } else this.setupFashionSkins();
    }
    // ForceUpdateSuits ends with ResetInstanceSuits; pets (genders 2..5) reset theirs here.
    if (human) this.forceUpdateSuits();
    else if (g < 6) this.onResetInstanceSuits?.();
    this.resetSuitsPersonData();
  }

  /** Texture best fit = the suit's tree followed by the skin color (Setup*Skins). */
  private withSkin(t: RegExpTree): RegExpTree {
    return t.clone().addRequired(this.fitSkin());
  }

  /** Runs suit and texture best fits over the two name lists. */
  private bestFits(suitFits: RegExpBestFit[], texFits: RegExpBestFit[]): void {
    for (const s of this.cat.suits) for (const f of suitFits) f.testString(s);
    for (const t of this.cat.textures) for (const f of texFits) f.testString(t);
  }

  private static outfit(suit: RegExpBestFit, tex: RegExpBestFit, key = BODY_KEY): string {
    return `${suit.best},${key}${tex.best}`;
  }

  /** Adult outfit tree: prefix, "100", gender, "a", body type. */
  private adultOutfitTree(prefix: string): RegExpTree {
    const t = new RegExpTree().addRequired(prefix).addRequired("100");
    const gl = this.genderLetter();
    if (gl) t.addRequired(gl);
    return t.addRequired("a").addRequired(this.fitBodyType());
  }

  /** EditPerson::SetupNewSkins: formal, swimwear and pajamas of an adult by best fit. */
  private setupNewSkins(): void {
    const trees = ["f", "s", "l"].map((p) => this.adultOutfitTree(p));
    const suits = trees.map((t) => new RegExpBestFit(t));
    const texs = trees.map((t) => new RegExpBestFit(this.withSkin(t)));
    this.bestFits(suits, texs);
    this.set(E.formal, EditPerson.outfit(suits[0]!, texs[0]!));
    this.set(E.swimwear, EditPerson.outfit(suits[1]!, texs[1]!));
    this.set(E.lingerie, EditPerson.outfit(suits[2]!, texs[2]!));
  }

  /** EditPerson::SetupChildHDSkins: swimwear and pajamas of a child. */
  private setupChildHDSkins(): void {
    const type = this.bodyType();
    const trees = ["s", "l"].map((p) => {
      const t = new RegExpTree().addRequired(p).addRequired("100");
      const gl = this.genderLetter();
      if (gl) t.addRequired(gl);
      return t.addRequired("c").addRequired(type);
    });
    const suits = trees.map((t) => new RegExpBestFit(t));
    const texs = trees.map((t) => new RegExpBestFit(this.withSkin(t)));
    this.bestFits(suits, texs);
    this.set(E.swimwear, EditPerson.outfit(suits[0]!, texs[0]!));
    this.set(E.lingerie, EditPerson.outfit(suits[1]!, texs[1]!));
  }

  /** EditPerson::SetupVacationSkins: the winter outfit. */
  private setupVacationSkins(): void {
    const t = new RegExpTree().addRequired("w").addRequired("100");
    const gl = this.genderLetter();
    if (gl) t.addRequired(gl);
    if (!this.isAdult()) t.addRequired(S.cchd);
    else t.addRequired("a").addRequired(this.fitBodyType());
    const suit = new RegExpBestFit(t);
    const tex = new RegExpBestFit(this.withSkin(t));
    this.bestFits([suit], [tex]);
    this.set(E.winter, EditPerson.outfit(suit, tex));
  }

  /** EditPerson::SetupFashionSkins: the fashion outfit ("h5??" suits). */
  private setupFashionSkins(): void {
    const t = new RegExpTree().addRequired("h").addRequired("5").addWildcard(2);
    const gl = this.genderLetter();
    if (gl) t.addRequired(gl);
    if (this.isAdult()) t.addRequired("a").addRequired(this.fitBodyType());
    const suit = new RegExpBestFit(t);
    const tex = new RegExpBestFit(this.withSkin(t));
    this.bestFits([suit], [tex]);
    this.set(E.fashion, EditPerson.outfit(suit, tex));
  }

  /** EditPerson::ForceUpdateSuits: naked body (16), underwear (17), entry 28 and the hands. */
  private forceUpdateSuits(): void {
    const bodySt = this.suitTex(E.body);
    const skin = this.skin();
    const type = bodySt.suit.slice(6, 9);
    // The body texture past "BODY=" and its 12-character base ("b002mafatlgt").
    const suffix = bodySt.tex.slice(BODY_KEY.length + 12);
    const gl = this.genderLetter();

    const nakedTree = new RegExpTree().addRequired("N").addOption("U", gl).addRequired(type);
    const nakedTexTree = nakedTree.clone().addRequired(skin).addOption(suffix, "");
    const naked = new RegExpBestFit(nakedTree);
    const nakedTex = new RegExpBestFit(nakedTexTree);
    const underTex = new RegExpBestFit(nakedTexTree.clone().setPrefix("U"));
    const e28 = new RegExpBestFit(nakedTree.clone().setPrefix("F"));
    const e28Tex = new RegExpBestFit(nakedTexTree.clone().setPrefix("F"));
    const hands = HANDS.map(
      ([prefix, side, pose]) =>
        new RegExpBestFit(
          new RegExpTree()
            .addRequired(prefix)
            .addOption("U", gl)
            .addOption("A", side)
            .addRequired(pose)
            .addOption(skin, "")
            .addOption(suffix, ""),
        ),
    );

    // Entry 28's suit is only tried until the naked body suit has a match.
    for (const s of this.cat.suits) {
      for (const f of [naked, e28]) {
        f.testString(s);
        if (f.best !== "") break;
      }
    }
    const texFits = [...hands, e28Tex, nakedTex, underTex];
    for (const t of this.cat.textures) for (const f of texFits) f.testString(t);

    this.set(E.naked, EditPerson.outfit(naked, nakedTex));
    const under = underTex.best === "" && !this.isAdult() ? nakedTex : underTex;
    this.set(E.underwear, EditPerson.outfit(naked, under));
    this.set(E.entry28, EditPerson.outfit(e28, e28Tex));

    let letter = "u";
    if (this.isAdult()) letter = this.getGender() === PERSON_GENDER_FEMALE ? "f" : this.getGender() === PERSON_GENDER_MALE ? "m" : "u";
    hands.forEach((h, i) => {
      const [, side, pose] = HANDS[i]!;
      this.set(HAND_ENTRIES[i]!, h.best === "" ? "" : `H${letter}${side}${pose},${HAND_KEY}${h.best}`);
    });
    this.onResetInstanceSuits?.();
  }

  /** The person-data side of SAnimator::ResetSuits. */
  private resetSuitsPersonData(): void {
    const pd = this.personData;
    pd[22] = 0;
    pd[23] = 0;
    const g = S.genders.indexOf(this.get(E.gender).toLowerCase() as (typeof S.genders)[number]);
    if (g >= 0) pd[65] = g;
    if (this.has(E.age)) pd[58] = this.ageYears();
    if (this.has(E.color)) pd[60] = SKIN_INDEX[this.get(E.color).toLowerCase()] ?? 0;
  }

  // --- escape character names (SAnimator::UpdateOutfitAndHands' costumes) ---------

  /**
   * EditPerson::BuildEscapeCharExpr: the literal runs of `pattern` are
   * required; "$b" requires the body type (characters 6..8 of the body
   * suit), "$g" is an option between the gender letter ("m", "f" for
   * women) and "u", "$c" requires the skin color (entry 15, "???" when
   * missing). Any other escaped character is dropped.
   */
  private buildEscapeCharExpr(pattern: string): RegExpTree {
    const t = new RegExpTree();
    const n = pattern.length;
    for (let i = 0; i < n; i++) {
      let next = pattern.indexOf("$", i);
      if (next < 0) next = n;
      if (i < next) {
        t.addRequired(pattern.slice(i, next));
        i = next - 1;
      } else if (i + 1 < n) {
        i++;
        const c = pattern[i]!;
        if (c === "b" || c === "B") t.addRequired(this.suitTex(E.body).suit.slice(6, 9));
        else if (c === "g" || c === "G") t.addOption(this.getGender() === PERSON_GENDER_FEMALE ? "f" : "m", "u");
        else if (c === "c" || c === "C") t.addRequired(this.has(E.color) ? this.get(E.color) : S.unknownColor);
      }
    }
    return t;
  }

  /** EditPerson::SelectEscapeCharSuit / SelectEscapeHeadSuit: the first suit (GetSuit order) the expression matches, "" when none. */
  selectEscapeCharSuit(pattern: string): string {
    const t = this.buildEscapeCharExpr(pattern);
    return this.cat.suits.find((s) => t.getMatchingLength(s) !== 0) ?? "";
  }

  selectEscapeHeadSuit(pattern: string): string {
    return this.selectEscapeCharSuit(pattern);
  }

  /**
   * EditPerson::SelectEscapeCharTexture (entry 2, "BODY=") and
   * SelectEscapeHeadTexture (entry 3, "HEAD-HEAD="): the expression
   * followed by an option between the person's own texture variant (its
   * texture past the key length of "BODY=" + 12, for both) and nothing,
   * best fit over the texture names; "" when nothing fits.
   */
  private selectEscapeTexture(pattern: string, entry: number, key: string): string {
    const t = this.buildEscapeCharExpr(pattern);
    t.addOption(this.suitTex(entry).tex.slice(BODY_KEY.length + 0xc), S.empty);
    const fit = new RegExpBestFit(t);
    for (const s of this.cat.textures) fit.testString(s);
    return fit.best === "" ? "" : key + fit.best;
  }

  selectEscapeCharTexture(pattern: string): string {
    return this.selectEscapeTexture(pattern, E.body, BODY_KEY);
  }

  selectEscapeHeadTexture(pattern: string): string {
    return this.selectEscapeTexture(pattern, E.head, HEAD_KEY);
  }

  /**
   * EditPerson::SelectEscapeHandTexture(state, s): "$h" becomes the hand
   * pose letter (lbl_105BDEF8 "OPC": open, pointing, closed), "$g" the
   * gender letter ("f" for women, "m" otherwise), prefixed with "HAND=".
   * The "$g" position is the one found before the "$h" replacement.
   */
  selectEscapeHandTexture(state: number, pattern: string): string {
    const h = pattern.indexOf("$h");
    const g = pattern.indexOf("$g");
    const letter = "OPC"[state] ?? "";
    let s = (g === -1 ? HAND_KEY : "") + (h < 0 ? pattern : pattern.slice(0, h) + letter + pattern.slice(h + 2));
    if (g !== -1) s = HAND_KEY + s.slice(0, g) + (this.getGender() === PERSON_GENDER_FEMALE ? "f" : "m") + s.slice(g + 2);
    return s;
  }

  /** PersonFinder::SetupNewHDSkins (on Done for adults): all outfits picked anew by best fit. */
  setupNewHDSkins(): void {
    if (this.isAdult()) {
      this.setupNewSkins();
      this.setupFashionSkins();
    } else {
      this.setupChildHDSkins();
    }
    this.setupVacationSkins();
  }
}
