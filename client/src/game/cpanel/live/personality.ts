/**
 * cWinPersonality — one trait of the Live mode personality page: the trait
 * name right-aligned, then the kPersBkg slot filled with kHouseSubpanelBars
 * (4 px per point, 0..10 points).
 *
 * From the decompiled code (WinPersonality.cpp):
 *  - the constructor takes 7 strings per trait from STR# 131 (name, three level
 *    names, three level descriptions) and 7 from STR# 170 (the pet version);
 *    the caption is the Sim or pet name (SetPerson);
 *  - Init: SetImage(0, 4, 1), font lbl_105BA2E8[8], height = max(char height,
 *    kPersBkg height), width = kPersBkg width + caption width + 9;
 *  - cWinPeople::BuildPersonalityButtons then gives every trait the widest
 *    text rect (ComputeTextRect / SetTextRect): text in (0, 0, textW + 3, h),
 *    slot at x = textW + 6, both centered vertically against each other;
 *  - TSPaint: value = personData[trait] / 100 clamped to 0..10, kPersBkg at
 *    (slotX, slotY), then the first 4 * value columns of the bars at
 *    (slotX, slotY - 1); text drawn with DrawTextPara style 2 (right aligned)
 *    in the button's hilite color.
 *
 * The popup client (+0x194, UpdateClient) shows the level name and
 * description of the person's value (below 3, below 8, else the top level)
 * and the person's portrait.
 */

import type { GameContext } from "../../context.js";
import { personGender } from "../../cpstate.js";
import { ALIGN_RIGHT, type FfnFont } from "../../res/ffn.js";
import { BTN_TOGGLE_ON_DOWN, TSWinBtn } from "../../ui/btn.js";
import { hiliteColor } from "../../ui/syscolors.js";
import type { Gfx, Rect } from "../../ui/tswin.js";
import { WinLivePopupClient } from "../livepopup.js";

/** ComputeZodiacSign: personality profile of each sign (outgoing, nice, playful, neat, active). */
const ZODIAC_TRAITS = [6, 2, 5, 7, 3];
const ZODIAC_PROFILES = [
  [8, 3, 3, 5, 6], [5, 4, 8, 5, 3], [7, 3, 3, 4, 8], [3, 6, 4, 6, 6],
  [10, 3, 4, 4, 4], [2, 5, 3, 9, 6], [8, 7, 6, 2, 2], [5, 3, 3, 6, 8],
  [3, 4, 7, 2, 9], [4, 5, 8, 7, 1], [4, 6, 7, 4, 4], [3, 7, 3, 5, 7],
];

/** ComputeZodiacSign: the sign whose profile is closest to the person's traits. */
export function computeZodiacSign(data: Int16Array): number {
  let best = -1;
  let bestDist = 1e38;
  ZODIAC_PROFILES.forEach((profile, i) => {
    let d = 0;
    profile.forEach((v, k) => {
      const t = 0.01 * (data[ZODIAC_TRAITS[k]!] ?? 0) - v;
      d += t * t;
    });
    if (d < bestDist) {
      best = i + 1;
      bestDist = d;
    }
  });
  return best < 1 || best > 12 ? 1 : best;
}

/** Strings a trait takes from one STR# (constructor order). */
export interface TraitStrings {
  name: string;
  levels: [string, string, string];
  descs: [string, string, string];
}

export class WinPersonality extends TSWinBtn {
  /** cWinPersonality+0x190: person (family index), -1 = none. */
  private person = -1;
  private persBkg: ImageBitmap | null = null;
  private bars: ImageBitmap | null = null;
  private captionFont: FfnFont | null = null;
  /** +0x1e0..0x1ec: text rect; +0x1f0 / +0x1f4: slot offset. */
  private textRect: Rect = { left: 0, top: 0, right: 0, bottom: 0 };
  private slotX = 0;
  private slotY = 0;
  /** Person data of a Sim outside the family (SetPerson on a neighbor GUID), or null. */
  private data: ArrayLike<number> | null = null;
  /** cTSWinBtn::SetCol: the hilite column forced by the owner, -1 = from the state. */
  fixedCol = -1;
  /** +0x194: the popup client (this button is its target). */
  readonly client = new WinLivePopupClient();
  /** PersonFinder::GetPictureBuffer for the popup's portrait pane (set by the owner). */
  pictureOf: ((person: number) => ImageBitmap | null) | null = null;

  constructor(
    readonly ctx: GameContext,
    readonly sim: TraitStrings,
    readonly pet: TraitStrings,
    /** cWinPersonality+0x18c: person data index of the trait. */
    readonly trait: number,
  ) {
    super();
    this.caption = sim.name;
    this.client.target = this;
  }

  override async init(): Promise<boolean> {
    const { res, fonts } = this.ctx;
    [this.bars, this.persBkg, this.captionFont] = await Promise.all([
      res.image("kHouseSubpanelBars"),
      res.image("kPersBkg"),
      fonts.acquire(8),
    ]);
    this.font = this.captionFont;
    this.cols = 4;
    const { left, top } = this.area;
    const h = Math.max(this.captionFont.height, this.persBkg.height);
    const w = this.persBkg.width + this.captionFont.stringWidth(this.caption) + 9;
    this.setArea(left, top, left + w, top + h);
    this.mode = BTN_TOGGLE_ON_DOWN;
    this.sendOnDown = true;
    return true;
  }

  /** cWinPersonality::SetPerson: Sim or pet caption. */
  setPerson(person: number): void {
    this.person = person;
    if (person === -1) return;
    const p = this.ctx.state.family[person];
    const isPet = p !== undefined && personGender(p) > 1;
    this.caption = isPet ? this.pet.name : this.sim.name;
    this.updateClient();
  }

  /** cWinPersonality::UpdateClient: the level's name and description, then the portrait (45 x 45). */
  updateClient(): void {
    if (this.person === -1) return;
    const p = this.ctx.state.family[this.person];
    const value = Math.trunc((p?.personData?.[this.trait] ?? 0) / 100);
    const set = !p || personGender(p) > 1 ? this.pet : this.sim;
    const level = value < 3 ? 0 : value < 8 ? 1 : 2;
    this.client.setName(set.levels[level]);
    this.client.setDesc(set.descs[level]);
    const pic = this.pictureOf?.(this.person) ?? null;
    if (pic) this.client.setBitmap(0, pic, { left: 0, top: 0, right: 0x2d, bottom: 0x2d });
  }

  /** cWinPersonality::SetPerson with a neighbor (cPickFamilyPersonInfo): data read directly. */
  setPersonData(data: ArrayLike<number>, isPet: boolean): void {
    this.data = data;
    this.caption = isPet ? this.pet.name : this.sim.name;
  }

  /** cWinPersonality::ComputeTextRect. */
  computeTextRect(): Rect {
    const w = this.captionFont?.stringWidth(this.caption) ?? 0;
    return { left: 0, top: 0, right: w + 3, bottom: this.getH() };
  }

  /** cWinPersonality::SetTextRect. */
  setTextRect(r: Rect): void {
    const bkgH = this.persBkg?.height ?? 0;
    const baseline = this.captionFont?.baselineHeight() ?? 0;
    this.textRect = { ...r };
    this.slotX = r.right - r.left + 3;
    if (baseline < bkgH) {
      const d = Math.trunc((bkgH - baseline) / 2);
      this.textRect.top += d;
      this.textRect.bottom += d;
      this.slotY = 0;
    } else {
      this.slotY = Math.trunc((baseline - bkgH) / 2);
    }
    const { left, top, bottom } = this.area;
    this.setArea(left, top, left + this.slotX + (this.persBkg?.width ?? 0) + 3, bottom);
  }

  override tsPaint(g: Gfx): void {
    if (this.person === -1 && !this.data) return;
    const data = this.data ?? this.ctx.state.family[this.person]?.personData;
    const value = Math.min(10, Math.max(0, Math.trunc((data?.[this.trait] ?? 0) / 100)));
    if (this.bars && this.persBkg) {
      g.blit(this.persBkg, this.slotX, this.slotY);
      const w = Math.min(this.bars.width, value * 4);
      if (value > 0) g.blitPart(this.bars, 0, 0, w, this.bars.height, this.slotX, this.slotY - 1);
    }
    const font = this.captionFont;
    if (font) {
      const r = this.textRect;
      const rect = { left: g.ox + r.left, top: g.oy + r.top, right: g.ox + r.right, bottom: g.oy + r.bottom };
      font.drawTextPara(g.ctx, rect, this.caption, ALIGN_RIGHT, hiliteColor(this.cols, this.fixedCol >= 0 ? this.fixedCol : this.frameColumn()));
    }
  }
}
