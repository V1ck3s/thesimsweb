/**
 * cPickFamilyPersonInfo: the tooltip window of a family member's portrait
 * in the family picker (cPickFamilyItemMember) and in "Create a Family"
 * (cWinDesignFamPeopleBtn): name, five personality bars and the biography.
 *
 * From the decompiled class (PickFamilyPersonInfo.cpp):
 *  - Init: private buffer; name font lbl_105BA2E8[12], text font [10];
 *    kPickFamilyPersonInfoBkg (0x14b4); area (0, 0, 0x71, 0x7a); five
 *    cWinPersonality built like cWinPeople::BuildPersonalityButtons (widest
 *    text rect), each disabled (SetFlag(2, 0)), hilite column forced to 2
 *    (SetCol(2), +0xf0 = 3), laid out vertically from lbl_105BC6E0 = (3, 0x16)
 *    every lbl_105BC6DC.y = 0x13 px; the window widens to fit them;
 *  - SetPerson: each trait's SetPerson, the biography
 *    (PersonFinder::GetDescription) and the name (lbl_105BAB74 format), then
 *    Layout;
 *  - Layout: text column 200 px wide (wider if the name needs it), name at
 *    (15, 10), the traits 10 px under it, one every pitch px; the biography
 *    right of the traits (15 px gap) for as many lines as the traits are
 *    tall, the rest under the traits across the whole width (or under the
 *    text column only, for one short line); window = column right + 15 by
 *    name + max(text, traits) + rest + 30;
 *  - TSPaint: BltEdge of the background (cells a third of the bitmap,
 *    center filled), the name centered with a black shadow at (+1, +1), the
 *    biography left-aligned;
 *  - UnfurlToolTip(rect, t): bottom-left at (rect.left, rect.bottom), alpha
 *    255 * t + 0.5 (lbl_105BC6E4), drawn by BlitPrivateBufferToParent
 *    (nothing at 0, plain blit at 255, blended otherwise).
 *
 * Not resolved: lbl_105BAB74 is built by a static initializer from code we
 * could not read; the name is shown as is ("%s").
 */

import type { GameContext } from "../context.js";
import { WinPersonality, type TraitStrings } from "../cpanel/live/personality.js";
import { ALIGN_CENTER, ALIGN_LEFT, type FfnFont } from "../res/ffn.js";
import { bltEdge } from "../ui/dlg.js";
import { rgb, UI_FONT_COLOR } from "../ui/syscolors.js";
import { Gfx, TSWin, type Rect } from "../ui/tswin.js";

/** Live STR# 131 / 170: personality strings (title, then 7 per trait). */
const STR_PERSONALITY = 0x83;
const STR_PET_PERSONALITY = 0xaa;
/** cWinPeople::BuildPersonalityButtons trait order (person data indices). */
const TRAITS = [7, 6, 3, 5, 2];
/** lbl_105BC6E0 / lbl_105BC6DC */
const ORIGIN = { x: 3, y: 0x16 };
const STEP_Y = 0x13;
const BKG = 0x14b4;
const SHADOW = rgb(0, 0, 0);
/** Person data 65: values above 1 are pets. */
const PD_GENDER = 65;

/** What PersonFinder gives for one person. */
export interface PersonInfoData {
  name: string;
  bio: string;
  personData: ArrayLike<number>;
}

const emptyRect = (): Rect => ({ left: 0, top: 0, right: 0, bottom: 0 });

export class PickFamilyPersonInfo extends TSWin {
  private bkg: ImageBitmap | null = null;
  private nameFont: FfnFont | null = null;
  private textFont: FfnFont | null = null;
  private readonly traits: WinPersonality[] = [];
  /** +0x134 / +0x138 */
  private bio = "";
  private name = "";
  /** +0xe8: name rect; +0xf8: traits block; +0x108: biography; +0x118: the rest. */
  private nameRect = emptyRect();
  private block = emptyRect();
  private descRect = emptyRect();
  private restRect = emptyRect();
  /** +0x130: characters of the biography drawn in the text column. */
  private split = 0;
  /** +0xe4 */
  private alpha = 255;
  private buffer: HTMLCanvasElement | null = null;

  constructor(private readonly ctx: GameContext) {
    super();
  }

  /** The tooltip window, initialized. */
  static async create(ctx: GameContext): Promise<PickFamilyPersonInfo> {
    const w = new PickFamilyPersonInfo(ctx);
    await w.init();
    return w;
  }

  override async init(): Promise<boolean> {
    const { ctx } = this;
    [this.nameFont, this.textFont, this.bkg] = await Promise.all([ctx.fonts.acquire(12), ctx.fonts.acquire(10), ctx.res.image(BKG)]);
    this.setArea(0, 0, 0x71, 0x7a);
    const str = (id: number, i: number): string => ctx.strings.get("Live", id, i);
    const traitStrings = (id: number, t: number): TraitStrings => {
      const s = (k: number): string => str(id, 1 + 7 * t + k);
      return { name: s(0), levels: [s(1), s(2), s(3)], descs: [s(4), s(5), s(6)] };
    };
    for (const [t, trait] of TRAITS.entries()) {
      const w = new WinPersonality(ctx, traitStrings(STR_PERSONALITY, t), traitStrings(STR_PET_PERSONALITY, t), trait);
      await w.init();
      this.traits.push(w);
    }
    let widest: Rect = emptyRect();
    for (const w of this.traits) {
      const r = w.computeTextRect();
      if (widest.right - widest.left < r.right - r.left) widest = r;
    }
    this.traits.forEach((w, i) => {
      w.setTextRect(widest);
      w.enabled = false;
      w.fixedCol = 2;
      this.childAdd(w);
      w.moveTo(ORIGIN.x, ORIGIN.y + i * STEP_Y);
    });
    for (const w of this.traits) {
      if (this.getW() < w.area.right) this.setArea(this.area.left, this.area.top, this.area.left + w.area.left + w.getW(), this.area.bottom);
    }
    return true;
  }

  /** cPickFamilyPersonInfo::SetPerson */
  setPerson(p: PersonInfoData): void {
    const isPet = (p.personData[PD_GENDER] ?? 0) > 1;
    for (const w of this.traits) w.setPersonData(p.personData, isPet);
    this.bio = p.bio;
    this.name = p.name;
    this.layout();
  }

  /** cPickFamilyPersonInfo::Layout */
  private layout(): void {
    const nameFont = this.nameFont;
    const font = this.textFont;
    const p0 = this.traits[0];
    const p1 = this.traits[1];
    if (!nameFont || !font || !p0 || !p1) return;
    const pitch = p1.area.top - p0.area.top;
    const p0W = p0.getW();
    let textW = 200;
    const nameW = nameFont.stringWidth(this.name);
    if (p0W + 0xd7 < nameW) textW = nameW - p0W - 15;
    this.nameRect = { left: 15, top: 10, right: 15 + p0W + textW + 15, bottom: 10 + nameFont.height };
    const top = this.nameRect.bottom + 10;
    this.block = { left: 15, top, right: 15 + p0W, bottom: top + pitch * this.traits.length };
    this.traits.forEach((w, i) => w.moveTo(this.block.left, this.block.top + i * pitch));
    const left = this.block.right + 15;
    this.descRect = { left, top, right: left + textW, bottom: top };
    const lines = font.calculateNumberOfLines(this.bio, textW);
    const blockH = this.block.bottom - this.block.top;
    const fit = Math.ceil(blockH / font.height);
    const resize = (): void => {
      const textH = this.descRect.bottom - this.descRect.top;
      const nameH = this.nameRect.bottom - this.nameRect.top;
      const restH = this.restRect.bottom - this.restRect.top;
      const { left: l, top: t } = this.area;
      this.setArea(l, t, l + this.restRect.right - this.restRect.left + 30, t + nameH + Math.max(textH, blockH) + restH + 30);
    };
    if (fit < lines) {
      this.descRect.bottom = top + fit * font.height;
      let pos = 0;
      for (let i = 0; i < fit; i++) pos += font.calculateWordsToFitInWidth(this.bio, pos, this.bio.length - pos, textW);
      this.split = pos;
      const rest = this.bio.slice(pos);
      const r = { left: this.block.left, top: this.descRect.bottom, right: this.descRect.right, bottom: this.descRect.bottom };
      const restLines = font.calculateNumberOfLines(rest, r.right - r.left);
      r.bottom = r.top + restLines * font.height;
      this.restRect = r;
      resize();
      // One short line stays under the text column.
      if (restLines === 1 && font.stringWidth(rest) < textW) this.restRect.left = this.descRect.left;
    } else {
      this.descRect.bottom = top + lines * font.height;
      this.split = 0;
      this.restRect = { left: this.block.left, top: this.descRect.bottom, right: this.descRect.right, bottom: this.descRect.bottom };
      resize();
    }
  }

  /** cPickFamilyPersonInfo::UnfurlToolTip */
  unfurlToolTip(rect: Rect, t: number): void {
    const x = rect.left;
    const y = rect.bottom - this.getH();
    this.setArea(x, y, x + this.getW(), y + this.getH());
    this.alpha = Math.max(0, Math.min(255, Math.trunc(255 * t + 0.5)));
  }

  override tsPaint(g: Gfx): void {
    const bkg = this.bkg;
    if (bkg) bltEdge(g, bkg, Math.trunc(bkg.width / 3), Math.trunc(bkg.height / 3), this.getW(), this.getH(), true);
    const abs = (r: Rect, d = 0): Rect => ({ left: g.ox + r.left + d, top: g.oy + r.top + d, right: g.ox + r.right + d, bottom: g.oy + r.bottom + d });
    if (this.nameFont) {
      this.nameFont.drawTextPara(g.ctx, abs(this.nameRect, 1), this.name, ALIGN_CENTER, SHADOW);
      this.nameFont.drawTextPara(g.ctx, abs(this.nameRect), this.name, ALIGN_CENTER, UI_FONT_COLOR);
    }
    const font = this.textFont;
    if (!font) return;
    font.drawTextPara(g.ctx, abs(this.descRect), this.split ? this.bio.slice(0, this.split) : this.bio, ALIGN_LEFT, UI_FONT_COLOR);
    if (this.split) font.drawTextPara(g.ctx, abs(this.restRect), this.bio.slice(this.split), ALIGN_LEFT, UI_FONT_COLOR);
  }

  /** The window and its traits go through the private buffer (BlitPrivateBufferToParent). */
  override plot(ctx: CanvasRenderingContext2D, ox: number, oy: number): void {
    if (!this.isVisible() || this.alpha === 0) return;
    const w = this.getW();
    const h = this.getH();
    const buf = (this.buffer ??= document.createElement("canvas"));
    if (buf.width < w || buf.height < h) {
      buf.width = Math.max(buf.width, w);
      buf.height = Math.max(buf.height, h);
    }
    const b = buf.getContext("2d")!;
    b.clearRect(0, 0, buf.width, buf.height);
    const { left, top } = this.area;
    super.plot(b, -left, -top);
    ctx.save();
    ctx.globalAlpha = this.alpha / 255;
    ctx.drawImage(buf, 0, 0, w, h, ox + left, oy + top, w, h);
    ctx.restore();
  }
}
