/**
 * Live mode "Relationships" page.
 *
 * WinRelationship is cWinRelationship (WinRelationship.cpp): one tile per
 * known Sim, 45 x 90, showing the other Sim's relationship picture (BMP_ 2003,
 * five moods side by side), the daily score, a 2 px daily bar, a 4 px lifetime
 * bar, the lifetime score and the friend / love icons.
 *
 * RelationshipsPanel is the window cWinPeople keeps at +0x104 with what
 * cWinPeople builds in it: the page buttons (cWinPeople::Init), the four sort
 * buttons (cWinPeople::InitRelationshipSorts), the caption, the tiles
 * (cWinPeople::BuildRelationships) and the clicks on them
 * (cWinPeople::TSOnCommand, Panel 5).
 *
 * The tiles share one popup client (cWinPeople+0x228); SetupClient fills it
 * with the STR# 132 texts of the lifetime level and the other Sim's name,
 * sign and description.
 *
 * Not ported: the delta meter (cWinDeltaMeter, change arrows) and
 * right-click centering the view on the Sim (cXObject::CenterHouseViewOnMe).
 */

import type { GameContext } from "../../context.js";
import type { PersonInfo } from "../../cpstate.js";
import { ALIGN_CENTER, type FfnFont } from "../../res/ffn.js";
import { BTN_TOGGLE, CMD_ASYNC_EXIT, TSWinBtn } from "../../ui/btn.js";
import { hiliteColor, rgb } from "../../ui/syscolors.js";
import { TSWinText, WTF_MULTILINE } from "../../ui/text.js";
import { type Gfx, TSWin } from "../../ui/tswin.js";
import { popupClick, type WinLivePopup, WinLivePopupClient } from "../livepopup.js";
import { computeZodiacSign } from "./personality.js";

/** "friendship threshold" (GameData/Global/Global.far, AutonomyConstants; 25 in code). */
const FRIENDSHIP_THRESHOLD = 50;

/** PersonFinder::eRelationTypes, chosen by the sort buttons. */
const enum RelationType {
  Family = 0,
  Friends = 1,
  Famous = 2,
  All = 3,
}

/** Person data indices read by PersonFinder::GetRelatedPeople (Behavior.iff STR# 200). */
const PD_FAMILY_NUMBER = 61;
const PD_FAME_SCORE = 81;

/** InitSimsColors: base (lbl_105BA924), red (lbl_105BA7B8), green (lbl_105BA7C4), text back (lbl_105BA950). */
const BAR_BASE: RGB = [0x40, 0x5d, 0x5f];
const BAR_RED: RGB = [0xd1, 0, 0];
const BAR_GREEN: RGB = [0, 0xca, 0x39];
const BAR_RED_HILITE: RGB = [0xff, 0, 0];
const BAR_GREEN_HILITE: RGB = [0, 0xff, 0];
const TEXT_BACK = rgb(0, 0, 0x4a);

/** cWinRelationship::TSPaint: both bars are 40 px wide (lbl_105BC52C + 4). */
const BAR_W = 40;

type RGB = [number, number, number];

/** PersonFinder::GetRelation result (PersonRelation). */
interface PersonRelation {
  /** +0: raw daily value (matrix entry 0). */
  value: number;
  /** +4: matrix entry 1 != 0 (heart). */
  crush: boolean;
  /** +5: both ways daily >= friendship threshold (smiley). */
  friends: boolean;
  /** +6: matrix entry 3 != 0 (deep heart). */
  love: boolean;
  /** +8: matrix entry 2 (lifetime), clamped to -100..100. */
  lifetime: number;
  /** +0xc: matrix entry 0 (daily), clamped to -100..100. */
  daily: number;
}

function row(from: PersonInfo, to: PersonInfo): number[] | null {
  if (to.neighborId === undefined) return null;
  return from.relationships?.find((r) => r.other === to.neighborId)?.values ?? null;
}

const clamp100 = (v: number): number => Math.max(-100, Math.min(100, v));

const NO_RELATION: PersonRelation = { value: 0, crush: false, friends: false, love: false, lifetime: 0, daily: 0 };

/** PersonFinder::GetRelation: the relationship matrix row of `from` for `to`. */
export function getRelation(from: PersonInfo, to: PersonInfo): PersonRelation {
  const rel = { ...NO_RELATION };
  const v = row(from, to);
  if (!v || v.length < 1) return rel;
  rel.value = v[0]!;
  rel.lifetime = clamp100(v.length < 3 ? 0 : v[2]!);
  rel.daily = clamp100(v[0]!);
  rel.crush = v.length > 1 && v[1] !== 0;
  rel.love = v.length > 3 && v[3] !== 0;
  if (rel.value >= FRIENDSHIP_THRESHOLD) {
    const back = row(to, from);
    rel.friends = !!back && back.length > 0 && back[0]! >= FRIENDSHIP_THRESHOLD;
  }
  return rel;
}

/** Person data 70: zodiac sign (1..12, 0 = not computed yet). */
const PD_ZODIAC = 70;

/**
 * cWinRelationship statics, read by the first constructor from STR# 132
 * after the caption: (name, description) of the five lifetime levels
 * (lbl_105BAAD8 / lbl_105BAADC), then the friends and crush texts
 * (lbl_105BAAE0..lbl_105BAAEC).
 */
interface RelTexts {
  names: string[];
  descs: string[];
  friendName: string;
  friendDesc: string;
  crushName: string;
  crushDesc: string;
}

function relTexts(ctx: GameContext): RelTexts {
  const s = (i: number): string => ctx.strings.get("Live", 0x84, i);
  return {
    names: [0, 1, 2, 3, 4].map((i) => s(1 + 2 * i)),
    descs: [0, 1, 2, 3, 4].map((i) => s(2 + 2 * i)),
    friendName: s(11),
    friendDesc: s(12),
    crushName: s(13),
    crushDesc: s(14),
  };
}

/** lbl_105BC524: the text of each lifetime step (-60, -20, 20, 60, 100). */
const LEVEL_TEXT = [0, 3, 1, 4, 2];

/** PersonFinder::GetFullName. */
function fullName(p: PersonInfo): string {
  return p.lastName ? `${p.firstName} ${p.lastName}` : p.firstName;
}

/** The 16-bit blend table (lbl_105BA5E0) as 8-bit math: level 0..31 from `a` to `b`. */
function blend(a: RGB, b: RGB, level: number): string {
  const c = a.map((x, i) => Math.trunc(x + ((b[i]! - x) * level) / 31));
  return rgb(c[0]!, c[1]!, c[2]!);
}

/** Bitmaps shared by every tile (cWinRelationship statics, loaded by the first Init). */
interface RelIcons {
  smiley: ImageBitmap;
  heart: ImageBitmap;
  heartDeep: ImageBitmap;
}
let relIcons: Promise<RelIcons> | null = null;

export class WinRelationship extends TSWinBtn {
  /** +0x18c: the other person, +0x190: the selected person. */
  private other: PersonInfo | null = null;
  private selected: PersonInfo | null = null;
  private rel: PersonRelation = NO_RELATION;
  private icons: RelIcons | null = null;
  private textFont: FfnFont | null = null;
  /** +0x1a4: the tiles' shared popup client. */
  client: WinLivePopupClient | null = null;

  constructor(readonly ctx: GameContext) {
    super();
    // SetImage(0, 4, 1): no bitmap, but the caption colors follow 4 frame columns.
    this.cols = 4;
    // +0xf0 = 1, +0xec = 1.
    this.mode = BTN_TOGGLE;
    this.sendOnDown = true;
  }

  override async init(): Promise<boolean> {
    const { res } = this.ctx;
    this.setArea(this.area.left, this.area.top, this.area.left + 0x2d, this.area.top + 0x5a);
    this.textFont = await this.ctx.fonts.acquire(7);
    relIcons ??= (async () => ({
      smiley: await res.image("kRelSmiley"),
      heart: await res.image("kRelHeart"),
      heartDeep: await res.image("kRelHeartDeep"),
    }))();
    this.icons = await relIcons;
    return true;
  }

  /** cWinRelationship::SetRelationship(other, selected). */
  setRelationship(other: PersonInfo, selected: PersonInfo): void {
    this.other = other;
    this.selected = selected;
    if (other === selected) return;
    const lifetime = this.rel.lifetime;
    this.rel = getRelation(selected, other);
    // The open popup follows a changed score.
    if (this.rel.lifetime !== lifetime && this.client?.target === this && this.state !== 0) this.setupClient();
  }

  /**
   * cWinRelationship::SetupClient: the first lifetime step (i + 1) * 40 - 100
   * at or above the lifetime score picks the texts; the middle one becomes
   * the crush or friends text. The description ends with "Name (Sign) -- "
   * and the other Sim's description.
   */
  setupClient(): void {
    const c = this.client;
    const other = this.other;
    if (!c || !other) return;
    const t = relTexts(this.ctx);
    const lifetime = this.rel.lifetime;
    for (let i = 0; i < 5; i++) {
      if (lifetime > Math.trunc(0.5 + ((i + 1) * 40 - 100))) continue;
      let who = other.firstName ? fullName(other) : "";
      if (who) {
        const data = other.personData;
        let sign = data?.[PD_ZODIAC] ?? 0;
        if (data && sign === 0) {
          sign = computeZodiacSign(data);
          data[PD_ZODIAC] = sign;
        }
        if (sign > 0) who += ` (${this.ctx.strings.get("UIText", 0xa4, Math.min(12, sign) - 1)})`;
        who += " -- ";
      }
      who += other.bio ?? "";
      const level = LEVEL_TEXT[i]!;
      let name = t.names[level] ?? "";
      let desc = t.descs[level] ?? "";
      if (level === 2) {
        if (this.rel.crush) [name, desc] = [t.crushName, t.crushDesc];
        else if (this.rel.friends) [name, desc] = [t.friendName, t.friendDesc];
      }
      if (desc) desc += "\n\n";
      c.setName(name);
      c.setDesc(desc + who);
      return;
    }
  }

  override tsPaint(g: Gfx): void {
    const font = this.textFont;
    const w = this.getW();
    const { lifetime, daily } = this.rel;
    // The relationship picture: one of five frames by lifetime score, centered.
    const pic = this.other?.relFace ?? null;
    let picH = 0;
    if (pic) {
      picH = pic.height;
      const fw = Math.trunc(pic.width / 5);
      const frame = Math.min(4, Math.trunc((lifetime + 100) / fw));
      g.blitPart(pic, frame * fw, 0, fw, pic.height, (w - fw) >> 1, 0);
    }
    if (!font) return;
    const textColor = hiliteColor(this.cols, this.frameColumn());
    const number = (text: string, left: number, top: number, right: number): void => {
      g.fill(left, top, right - left, font.height, TEXT_BACK);
      const rect = { left: g.ox + left, top: g.oy + top, right: g.ox + right, bottom: g.oy + top + font.height };
      font.drawTextPara(g.ctx, rect, text, ALIGN_CENTER, textColor);
    };
    // Daily score across the tile, just under the picture.
    const dailyTop = picH - 2;
    number(String(daily), 0, dailyTop, w);
    const barTop = dailyTop + font.height;

    // Bar colors follow the lifetime score; bright while hovered or pressed.
    const level = Math.trunc(0.5 + (255 * (lifetime + 100)) / 200);
    const lit = this.enabled && (this.entered || this.state !== 0);
    const green = blend(BAR_BASE, lit ? BAR_GREEN_HILITE : BAR_GREEN, level >> 3);
    const red = blend(BAR_BASE, lit ? BAR_RED_HILITE : BAR_RED, (255 - level) >> 3);
    const x0 = (w - BAR_W) >> 1;
    const right = (w + BAR_W) >> 1;
    const bar = (value: number, top: number, h: number): void => {
      const split = x0 + Math.trunc((BAR_W * (value + 100)) / 200);
      g.fill(x0, top, split - x0, h, green);
      g.fill(split, top, right - split, h, red);
      if (right - split > 1) g.fill(split - 1, top, 1, h, "#000000");
    };
    bar(daily, barTop, 2);
    bar(lifetime, barTop + 4, 4);
    // Lifetime score under the bars.
    const lifeTop = barTop + 8;
    number(String(lifetime), x0, lifeTop, x0 + BAR_W);

    // Mutual friends, then love (or crush) next to it.
    const icons = this.icons;
    if (!icons) return;
    const iconTop = lifeTop + font.height - 3 + 1;
    if (this.rel.friends) g.blit(icons.smiley, x0, iconTop);
    const heart = this.rel.love ? icons.heartDeep : this.rel.crush ? icons.heart : null;
    if (heart) g.blit(heart, x0 + icons.smiley.width + 3, iconTop);
  }
}

export class RelationshipsPanel extends TSWin {
  /** cWinPeople+0x18c / +0x190. */
  private prevPage!: TSWinBtn;
  private nextPage!: TSWinBtn;
  /** cWinPeople+0x194..0x1a0: family, friends, famous, all. */
  private sortFamily!: TSWinBtn;
  private sortFriends!: TSWinBtn;
  private sortFamous!: TSWinBtn;
  private sortAll!: TSWinBtn;
  /** cWinPeople+0x144: the tiles. */
  readonly tiles: WinRelationship[] = [];
  /** cWinPeople+0x150: the Live panel's popup (set by WinPeople); +0x228 the tiles' client. */
  livePopup: WinLivePopup | null = null;
  private readonly client = new WinLivePopupClient();
  /** cWinPeople+0x1b0: people listed (PersonFinder::GetRelatedPeople). */
  private related: PersonInfo[] = [];
  /** cWinPeople+0x188: current page. */
  private page = 0;
  /** cWinPeople+0x180: tiles per page (10 at 1024 x 768, else 5). */
  private readonly perPage: number;
  /** cWinPeople+0x24c: the page caption (STR# 132 entry 0, set by the first BuildRelationships). */
  private caption = "";
  /** Small font of the global table (lbl_105BA2E8 + 0x18). */
  private smallFont!: FfnFont;

  constructor(readonly ctx: GameContext) {
    super();
    this.perPage = ctx.width === 1024 ? 10 : 5;
  }

  override async init(): Promise<boolean> {
    const { ctx } = this;
    const { res, strings } = ctx;
    // cWinPeople::Init: the subpanel rect (0, 50, 280, 150), 224 px wider at
    // 1024 x 768, moved to (300, 50).
    this.setArea(0, 50, 280 + (ctx.width === 1024 ? 0xe0 : 0), 150);
    this.moveTo(300, 50);
    this.smallFont = await ctx.fonts.acquire(6);

    const pageButton = async (name: string): Promise<TSWinBtn> => {
      const b = new TSWinBtn(0, await res.image(name), 4, 1);
      b.sendOnDown = true;
      b.hideWindow();
      this.childAdd(b);
      return b;
    };
    this.prevPage = await pageButton("kCatalogPrevPage");
    this.nextPage = await pageButton("kCatalogNextPage");
    await this.initRelationshipSorts();
    await strings.load("GameData/UIText.iff");
    this.prevPage.tooltip = strings.get("UIText", 0x9a, 0);
    this.nextPage.tooltip = strings.get("UIText", 0x9a, 1);

    await this.buildRelationships();
    // cWinPeople::Init: the caption, small font, at (5, 0) (lbl_105BC4D8).
    const text = new TSWinText();
    text.setFont(this.smallFont);
    text.moveTo(5, 0);
    text.setBackgroundOpaque(false);
    text.setCaption(this.caption);
    text.setWinTextFlag(WTF_MULTILINE, false);
    text.fitWindowToText();
    this.childAdd(text);
    return true;
  }

  /** cWinPeople::InitRelationshipSorts. */
  private async initRelationshipSorts(): Promise<void> {
    const { res, strings } = this.ctx;
    const sortButton = async (name: string, state: number): Promise<TSWinBtn> => {
      const b = new TSWinBtn(0, await res.image(name), 4, 1);
      b.mode = BTN_TOGGLE;
      b.sendOnDown = true;
      this.childAdd(b);
      b.setState(state);
      return b;
    };
    this.sortFamily = await sortButton("kRelFamilySort", 0);
    this.sortFriends = await sortButton("kRelFriendSort", 0);
    // Disabled without the Superstar data (cSimsApp+0x66 bit 0x40); the
    // Complete Edition ships it.
    this.sortFamous = await sortButton("kRelFamousSort", 0);
    this.sortAll = await sortButton("kRelAllSort", 1);
    await strings.load("GameData/UIText.iff");
    const tips = [this.sortFamily, this.sortFriends, this.sortFamous, this.sortAll];
    tips.forEach((b, i) => (b.tooltip = strings.get("UIText", 0xf0, i)));
  }

  /** PersonFinder::GetRelatedPeople(selected, list, type). */
  private getRelatedPeople(selected: PersonInfo, type: RelationType): PersonInfo[] {
    const { state } = this.ctx;
    // PersonFinder knows the lot's family and the neighbors; one entry per neighbor id.
    const everyone: PersonInfo[] = [...state.family];
    for (const n of state.neighbors) {
      if (!everyone.some((p) => p.neighborId !== undefined && p.neighborId === n.neighborId)) everyone.push(n);
    }
    const out = everyone.filter((p) => {
      if (p === selected || p.neighborId === selected.neighborId) return false;
      if (!row(selected, p)) return false;
      switch (type) {
        case RelationType.Friends:
          return getRelation(selected, p).friends;
        case RelationType.Family:
          return selected.personData?.[PD_FAMILY_NUMBER] === p.personData?.[PD_FAMILY_NUMBER];
        case RelationType.Famous:
          return (p.personData?.[PD_FAME_SCORE] ?? 0) !== 0;
        default:
          return true;
      }
    });
    // PersonFinder::RelCompare: the lot's family first, then by daily
    // relationship with the selected Sim (highest first), then by index.
    const inFamily = (p: PersonInfo): boolean => state.family.includes(p);
    return out
      .map((p, i) => ({ p, i, fam: inFamily(p), value: getRelation(selected, p).value }))
      .sort((a, b) => Number(b.fam) - Number(a.fam) || b.value - a.value || a.i - b.i)
      .map((e) => e.p);
  }

  /** cWinPeople::BuildRelationships. */
  async buildRelationships(): Promise<void> {
    const { ctx } = this;
    while (this.tiles.length < this.perPage) {
      if (!this.caption) {
        await ctx.strings.load("GameData/Live.iff");
        this.caption = ctx.strings.get("Live", 0x84, 0);
      }
      const tile = new WinRelationship(ctx);
      tile.client = this.client;
      if (!(await tile.init())) return;
      tile.hideWindow();
      this.childAdd(tile);
      this.tiles.push(tile);
    }
    this.layoutRelationships();
  }

  /** The synchronous part of BuildRelationships, once the tiles exist. */
  private layoutRelationships(): void {
    const selected = this.ctx.state.personGetSelected();
    const types: Array<[TSWinBtn, RelationType]> = [
      [this.sortFamily, RelationType.Family],
      [this.sortFriends, RelationType.Friends],
      [this.sortFamous, RelationType.Famous],
    ];
    const pick = types.find(([b]) => b.state === 1);
    if (pick) this.related = selected ? this.getRelatedPeople(selected, pick[1]) : [];
    if (this.sortAll.state === 1) this.related = selected ? this.getRelatedPeople(selected, RelationType.All) : [];
    if (this.page < 0) this.page = 0;

    // Fill the page; an empty page past the first falls back one page.
    for (;;) {
      const first = this.page * this.perPage;
      if (first >= this.related.length && this.page > 0) {
        this.page--;
        continue;
      }
      this.tiles.forEach((tile, i) => {
        const p = this.related[first + i];
        if (p && selected) {
          tile.setRelationship(p, selected);
          tile.tooltip = fullName(p);
          tile.showWindow();
        } else {
          tile.hideWindow();
        }
      });
      break;
    }

    // Tiles flow left to right after the family sort button and the page button.
    const left = this.sortFamily.getW() + this.prevPage.getW() + 6;
    const top = 0x12;
    const limit = this.getW() - 2;
    let x = left;
    let y = top;
    let rows = 0;
    for (const tile of this.tiles) {
      if (!tile.isVisible()) continue;
      tile.moveTo(x, y);
      x += tile.getW();
      if (x + tile.getW() > limit) {
        x = left;
        rows++;
        y = top + rows * tile.getH();
      }
    }

    // Sort buttons stacked under the caption line.
    const fh = this.smallFont.height;
    this.sortFamily.moveTo(3, fh + 1);
    this.sortFriends.moveTo(2, fh + this.sortFamily.getH() + 2);
    this.sortFamous.moveTo(2, fh + this.sortFamily.getH() + this.sortFriends.getH() + 3);
    this.sortAll.moveTo(2, fh + this.sortFamily.getH() + this.sortFriends.getH() + this.sortFamous.getH() + 4);

    // Page buttons centered vertically below the caption line.
    const py = fh + ((this.getH() - fh - this.prevPage.getH()) >> 1);
    this.prevPage.moveTo(this.sortFamily.getW() + 4, py);
    this.nextPage.moveTo(this.getW() - this.nextPage.getW() - 2, py);
    if (this.page < 1) this.prevPage.hideWindow();
    else this.prevPage.showWindow();
    if ((this.page + 1) * this.perPage < this.related.length) this.nextPage.showWindow();
    else this.nextPage.hideWindow();
  }

  /** cWinPeople::TSOnCommand, Panel 5 part (0x13, the async timeout, is a click). */
  override tsOnCommand(cmd: number, source: TSWin): boolean {
    if (cmd === CMD_ASYNC_EXIT) return true;
    const tile = this.tiles.find((t) => t === source);
    if (tile) {
      // The popup follows the clicked tile; clicking it again closes it.
      if (this.livePopup) popupClick(this.livePopup, this.client, this.parent ?? this, tile, () => tile.setupClient());
      return true;
    }
    if (source === this.prevPage || source === this.nextPage) {
      // The page buttons close the popup (DisablePopup) before the page changes.
      this.livePopup?.disablePopup();
      this.page += source === this.prevPage ? -1 : 1;
      this.layoutRelationships();
      return true;
    }
    const sorts = [this.sortFamily, this.sortFriends, this.sortFamous, this.sortAll];
    if (sorts.includes(source as TSWinBtn)) {
      for (const b of sorts) if (b !== source) b.setState(0);
      this.page = 0;
      this.layoutRelationships();
      return true;
    }
    return super.tsOnCommand(cmd, source);
  }
}
