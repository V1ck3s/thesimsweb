/**
 * cWinPeople — Live mode panel: family portraits, the mood gauge, the seven
 * page buttons and the pages (needs, personality, job, house,
 * relationships, interests).
 *
 * cWinCPanel gives it (220, 0)-(width, 150); everything above y = 50 is
 * transparent to the mouse (IsPointInWindowWindowCoordinates). Positions and
 * resource ids come from cWinPeople::Init and the WinPeople.cpp static
 * initializer (lbl_105BC4xx); the 1024-wide layout is used (pages 224 px wider).
 *
 * Panels (cWinPeople::Panel): 0 none, 1 mood (needs), 2 personality, 3 job,
 * 4 house, 5 relationships, 6 interests, 7 gifts.
 *
 * The description popup (cWinLivePopup, +0x150) opens on a click on a need,
 * a trait, the zodiac sign, a relationship, an interest, a gift or a job /
 * house label, or after the quick tips delay over one (SetQuickTips arms the
 * buttons' async timer; TSOnCommand 0x13 is handled as a click). It closes
 * when the mouse leaves the page (TSOnMouseMove / TSOnMouseExit) or the page
 * changes (SetPanel), which releases the button it belongs to.
 *
 * Not ported (no simulation yet or out of scope): pie menus (cTSPieMenu,
 * kPieFaceBkg), sounds, sim tracking (kTrackingTarget foreground, command
 * 0x1b), the family portrait popup (command 0x13 on a portrait), at-work /
 * frog portrait overlays (UpdateAtWorkStatus).
 */

import type { GameContext } from "../context.js";
import { soundPlayer, UI } from "../audio/index.js";
import { personGender, type CPState, type PersonInfo } from "../cpstate.js";
import { getOptionsMgr } from "../optionsmgr.js";
import { ASYNC_ON_DOWN, ASYNC_ON_ENTER, BTN_TOGGLE, CMD_ASYNC_EXIT, CMD_ASYNC_TIMEOUT, TSWinBtn } from "../ui/btn.js";
import { winMgr } from "../ui/winmgr.js";
import { TSWinText, WTF_MULTILINE } from "../ui/text.js";
import { Gfx, TSWin, type Rect } from "../ui/tswin.js";
import { WinSubpanelHouse } from "./live/house.js";
import { InterestsPanel } from "./live/interest.js";
import { WinMotive } from "./live/motive.js";
import { buildPersonBtn } from "./live/peoplebuttons.js";
import { computeZodiacSign, WinPersonality, type TraitStrings } from "./live/personality.js";
import { RelationshipsPanel } from "./live/relationship.js";
import { WinSubpanelFame } from "./live/fame.js";
import { WinSubpanelJob } from "./live/job.js";
import { WinSubpanelCatSkills, WinSubpanelDogSkills } from "./live/petskills.js";
import { WinSubpanelReportCard } from "./live/reportcard.js";
import { WinEditBio } from "./live/editbio.js";
import { GiftsPanel } from "./live/gifts.js";
import { popupClick, WinLivePopup, WinLivePopupClient } from "./livepopup.js";

export const enum LivePanel {
  None = 0,
  Mood = 1,
  Personality = 2,
  Job = 3,
  House = 4,
  Relationships = 5,
  Interests = 6,
  Gifts = 7,
}

/** Page buttons, in cWinPeople+0x154.. order: image (lbl_105BC4A4), position (lbl_105BC4A0), page. */
const PAGE_BUTTONS: ReadonlyArray<{ image: string; x: number; y: number; panel: LivePanel }> = [
  { image: "kMoodBtn", x: 0xca, y: 0x51, panel: LivePanel.Mood },
  { image: "kRelationshipBtn", x: 0x10d, y: 0x36, panel: LivePanel.Relationships },
  { image: "kJobBtn", x: 0x10d, y: 0x55, panel: LivePanel.Job },
  { image: "kHouseBtn", x: 0x10d, y: 0x74, panel: LivePanel.House },
  { image: "kPersonalityBtn", x: 0xed, y: 0x55, panel: LivePanel.Personality },
  { image: "kInterestBtn", x: 0xed, y: 0x36, panel: LivePanel.Interests },
  { image: "kGiftBtn", x: 0xed, y: 0x74, panel: LivePanel.Gifts },
];
const BTN_MOOD = 0;
const BTN_JOB = 2;
const BTN_INTEREST = 5;
const BTN_GIFT = 6;

/** Family portrait buttons (cWinPeople+0xf0) and their flow layout (lbl_105BC4CC, 45 px cells). */
const MAX_FAMILY = 8;
const FAMILY_AREA: Rect = { left: 9, top: 0x37, right: 0xbd, bottom: 0x96 };
const FAMILY_CELL = 0x2d;

/** lbl_105BC4B4: kLiveModeGauge; lbl_105BC4AC / lbl_105BC4B0: green / red mood bars. */
const GAUGE = { x: 0xc1, y: 0x32 };
const GREEN_BARS = { x: 0xcd, y: 0x35 };
const RED_BARS = { x: 0xcd, y: 0x7b };
/** lbl_105BC488 / lbl_105BC484: tooltip areas over the gauge (relative to GAUGE). */
const GAUGE_TIP_AREAS: Rect[] = [
  { left: 0xc, top: 4, right: 0x26, bottom: 0x1d },
  { left: 0xc, top: 0x48, right: 0x26, bottom: 0x60 },
];

/** lbl_105BC4E8 / lbl_105BC4E0: page area, moved to (300, 50); pages are 224 px wider at 1024. */
const PAGE_AREA: Rect = { left: 0, top: 0x32, right: 0x118, bottom: 0x96 };
const PAGE_ORIGIN = { x: 300, y: 0x32 };
const WIDE_SCREEN_EXTRA = 0xe0;
/** lbl_105BC4D8: page title position. */
const TITLE_ORIGIN = { x: 5, y: 0 };

/** lbl_105BC494: the motive each "Needs" bar shows (hunger, energy, comfort, fun, hygiene, social, bladder, room). */
const MOTIVES = [7, 5, 6, 15, 8, 14, 9, 13];
/** Overall mood: Motives[3] (PersonFinder::GetMotives + 0xc). */
const MOTIVE_MOOD = 3;
/** lbl_105BAAA4: person data index of each personality trait (neat, outgoing, active, playful, nice). */
const TRAITS = [7, 6, 3, 5, 2];
/** Person data 58: age (cXPerson+0x600); 1..17 is a child. */
const PD_AGE = 58;
/** Person data 70: zodiac sign (1..12, 0 = not computed yet). */
const PD_ZODIAC = 70;

/** STR# ids in Live.iff / UIText.iff. */
const STR_MOTIVES = 0x82;
const STR_PERSONALITY = 0x83;
const STR_MODE_TIPS = 0x86;
const STR_PET_PERSONALITY = 0xaa;
const STR_PET_MOTIVES = 0xb4;
const STR_MISC = 0x9a;
const STR_SIGNS = 0xa4;
/** UIText STR# 0xa5: name and description of each sign (cWinPeople::Init, +0x1c4 / +0x1f4). */
const STR_SIGN_TEXTS = 0xa5;

/**
 * GetCompatibleSigns / GetIncompatibleSigns: two signs each (lbl_105BBD7C /
 * lbl_105BBD84, 1-based), after the UIText STR# 0x9a entries 6 / 7 and
 * joined by ", " (lbl_105BBD80).
 */
const COMPATIBLE_SIGNS = [3, 2, 1, 7, 12, 6, 2, 8, 9, 4, 11, 9, 6, 4, 12, 5, 12, 10, 11, 2, 10, 9, 8, 3];
const INCOMPATIBLE_SIGNS = [4, 7, 6, 4, 10, 1, 3, 1, 10, 3, 5, 2, 12, 8, 7, 11, 7, 8, 5, 3, 8, 6, 5, 1];

/** CPState dirty bits cWinPeople reacts to (UpdateViewFromCPState / SetPanel). */
const DIRTY_FAMILY = 0x20080000;
const DIRTY_MOTIVES = 0x9;
const DIRTY_SELECTED = 0x8;
const DIRTY_PERSONALITY = 0x10008;
const DIRTY_LISTS = 0x6008008;
const PANEL_DIRTY: Record<LivePanel, number> = {
  [LivePanel.None]: 0,
  [LivePanel.Mood]: 0x1,
  [LivePanel.Personality]: 0x10000,
  [LivePanel.Job]: 0x20000,
  [LivePanel.House]: 0x40000,
  [LivePanel.Relationships]: 0x8000,
  [LivePanel.Interests]: 0x2000000,
  [LivePanel.Gifts]: 0x4000000,
};

/** Portrait row by mood (lbl_105BC4C8 + 0xc / + 0x10): 0 normal, 1 happy, 2 sad. */
const MOOD_LOW = -25;
const MOOD_HIGH = 25;

/**
 * CPState::GetShowFameUIPanel: with Superstar, a jobless person (career 0,
 * person data 56) with star points (person data 0x50) gets the fame page.
 */
function showFameUIPanel(p: PersonInfo): boolean {
  return (p.personData?.[56] ?? 0) === 0 && (p.personData?.[0x50] ?? 0) > 0;
}

function isChild(p: PersonInfo): boolean {
  const age = p.personData?.[PD_AGE];
  return age === undefined ? p.isChild : age !== 0 && age < 18;
}

/** The cTSWin flow layout cWinPeople::Init uses (left to right, wrapping at `right`). */
function flowLayout(wins: TSWin[], x0: number, y0: number, stepX: number, stepY: number, right: number, itemW: number): void {
  let x = x0;
  let y = y0;
  let row = 0;
  for (const w of wins) {
    if (!w.isVisible()) continue;
    w.moveTo(x, y);
    x += stepX;
    if (stepX === 0 || right < x + itemW) {
      x = x0;
      row++;
      y = y0 + row * stepY;
    }
  }
}

export class WinPeople extends TSWin {
  /** cWinPeople+0x3d: shown page. */
  private panel = LivePanel.None;
  /** cWinPeople+0x38: family slot of the person shown, -1 = none. */
  private personSlot = -1;
  private background: ImageBitmap | null = null;
  private gauge: ImageBitmap | null = null;
  private greenBars: ImageBitmap | null = null;
  private redBars: ImageBitmap | null = null;
  private template: ImageBitmap | null = null;
  private readonly familyBtns: TSWinBtn[] = [];
  private readonly pageBtns: TSWinBtn[] = [];
  /** Family portrait images (PersonFinder::GetPictureBuffer cache). */
  private readonly pictures = new Map<PersonInfo, ImageBitmap>();

  private readonly motivesWin = new TSWin();
  private readonly petMotivesWin = new TSWin();
  private readonly personalityWin = new TSWin();
  private readonly motives: WinMotive[] = [];
  private readonly petMotives: WinMotive[] = [];
  private readonly personalities: WinPersonality[] = [];
  private readonly zodiacBtn = new TSWinBtn();
  private job!: WinSubpanelJob;
  /** +0x114: the celebrity job page (cWinSubpanelFame). */
  private fame!: WinSubpanelFame;
  /** +0x10c / +0x110: the pets' job pages (cWinSubpanelDogSkills, cWinSubpanelCatSkills). */
  private dogSkills!: WinSubpanelDogSkills;
  private catSkills!: WinSubpanelCatSkills;
  /** +0x11c: a child's job page (cWinSubpanelReportCard). */
  private reportCard!: WinSubpanelReportCard;
  private house!: WinSubpanelHouse;
  private relationships!: RelationshipsPanel;
  private interests!: InterestsPanel;
  private gifts!: GiftsPanel;
  /** +0x150: the description popup, in the lot view. */
  private popup!: WinLivePopup;
  /** +0x1c0: the zodiac sign's popup client; +0x1c4 / +0x1f4 the signs' names and descriptions. */
  private readonly zodiacClient = new WinLivePopupClient();
  private readonly signNames: string[] = [];
  private readonly signDescs: string[] = [];

  constructor(readonly ctx: GameContext) {
    super();
  }

  override async init(): Promise<boolean> {
    const { ctx } = this;
    const { res, strings, fonts } = ctx;
    const str = (id: number, i: number): string => strings.get("Live", id, i);
    [this.gauge, this.background, this.greenBars, this.redBars, this.template] = await Promise.all([
      res.image("kLiveModeGauge"),
      res.image("kUniversalCPBkg"),
      res.image("kGreenbars"),
      res.image("kRedBars"),
      res.image("kPeopleTemplate"),
    ]);
    // Pie menus (cTSPieMenu x2 on kPieFaceBkg): not ported.

    for (let i = 0; i < MAX_FAMILY; i++) {
      const b = new TSWinBtn();
      b.mode = BTN_TOGGLE;
      b.sendOnDown = true;
      this.childAdd(b);
      this.familyBtns.push(b);
    }
    for (const [i, def] of PAGE_BUTTONS.entries()) {
      const b = new TSWinBtn(0, await res.image(def.image), 4, 1);
      b.moveTo(def.x, def.y);
      b.mode = BTN_TOGGLE;
      b.sendOnDown = true;
      b.tooltip = str(STR_MODE_TIPS, i);
      this.childAdd(b);
      this.pageBtns.push(b);
    }
    flowLayout(this.familyBtns, FAMILY_AREA.left, FAMILY_AREA.top, FAMILY_CELL, FAMILY_CELL, FAMILY_AREA.right, FAMILY_CELL);

    for (const w of [this.motivesWin, this.petMotivesWin, this.personalityWin]) {
      w.setArea(PAGE_AREA.left, PAGE_AREA.top, PAGE_AREA.right, PAGE_AREA.bottom);
      w.moveTo(PAGE_ORIGIN.x, PAGE_ORIGIN.y);
      this.childAdd(w);
    }
    const wide = ctx.width === 0x400 ? WIDE_SCREEN_EXTRA : 0;
    const placePage = async (win: TSWin, setArea: boolean): Promise<boolean> => {
      if (!(await win.init())) return false;
      if (setArea) {
        win.setArea(PAGE_AREA.left, PAGE_AREA.top, PAGE_AREA.right + wide, PAGE_AREA.bottom);
        win.moveTo(PAGE_ORIGIN.x, PAGE_ORIGIN.y);
      }
      this.childAdd(win);
      return true;
    };
    this.job = new WinSubpanelJob(ctx);
    this.fame = new WinSubpanelFame(ctx);
    this.dogSkills = new WinSubpanelDogSkills(ctx);
    this.catSkills = new WinSubpanelCatSkills(ctx);
    this.reportCard = new WinSubpanelReportCard(ctx);
    // cWinPeople::Init sets the report card's area before its Init (which centers the grade in it).
    this.reportCard.setArea(PAGE_AREA.left, PAGE_AREA.top, PAGE_AREA.right + wide, PAGE_AREA.bottom);
    this.reportCard.moveTo(PAGE_ORIGIN.x, PAGE_ORIGIN.y);
    this.relationships = new RelationshipsPanel(ctx);
    this.interests = new InterestsPanel(ctx);
    this.house = new WinSubpanelHouse(ctx);
    // cWinPeople+0x348: the gift popup client.
    this.gifts = new GiftsPanel(ctx, new WinLivePopupClient());
    if (
      !(await placePage(this.job, true)) ||
      !(await placePage(this.fame, true)) ||
      !(await placePage(this.dogSkills, true)) ||
      !(await placePage(this.catSkills, true)) ||
      !(await placePage(this.reportCard, false)) ||
      // The relationships, interests and gifts windows set the page area themselves (and build their lists).
      !(await placePage(this.relationships, false)) ||
      !(await placePage(this.interests, false)) ||
      !(await placePage(this.gifts, false)) ||
      !(await placePage(this.house, true))
    ) {
      return false;
    }

    // Needs: STR# 130 (Sims) and 180 (pets), a title then (name, description) per motive.
    for (const [set, id, win] of [
      [this.motives, STR_MOTIVES, this.motivesWin],
      [this.petMotives, STR_PET_MOTIVES, this.petMotivesWin],
    ] as const) {
      for (const [i, motive] of MOTIVES.entries()) {
        const m = new WinMotive(ctx, str(id, 1 + 2 * i), str(id, 2 + 2 * i), motive);
        // The social need's popup shows kSocialPopupIcon in its left pane.
        if (i === 5) m.client.setBitmap(0, await res.image("kSocialPopupIcon"));
        if (await m.init()) win.childAdd(m);
        set.push(m);
      }
      flowLayout(set, 0, 0x15, set[0]!.getW(), set[0]!.getH() - 1, 200, set[0]!.getW());
    }
    // cWinPeople+0x248 holds the title: STR# 130's, then overwritten by STR# 180's before use.
    const needsTitle = str(STR_PET_MOTIVES, 0);

    // Personality (BuildPersonalityButtons): STR# 131 / 170, title then 7 strings per trait.
    const traitStrings = (id: number, t: number): TraitStrings => {
      const s = (k: number): string => str(id, 1 + 7 * t + k);
      return { name: s(0), levels: [s(1), s(2), s(3)], descs: [s(4), s(5), s(6)] };
    };
    const personalityTitle = str(STR_PERSONALITY, 0);
    for (const [t, trait] of TRAITS.entries()) {
      const w = new WinPersonality(ctx, traitStrings(STR_PERSONALITY, t), traitStrings(STR_PET_PERSONALITY, t), trait);
      w.pictureOf = (i) => {
        const p = this.personAt(i);
        return p ? this.pictureBuffer(p) : null;
      };
      await w.init();
      this.personalities.push(w);
    }
    let widest: Rect = { left: 0, top: 0, right: 0, bottom: 0 };
    for (const w of this.personalities) {
      const r = w.computeTextRect();
      if (widest.right - widest.left < r.right - r.left) widest = r;
    }
    for (const w of this.personalities) {
      w.setTextRect(widest);
      this.personalityWin.childAdd(w);
    }
    flowLayout(this.personalities, 0xca - this.personalities[0]!.getW(), 8, 0, 0x12, 0, this.personalities[0]!.getW());

    // Zodiac sign (cWinPeople+0x1bc): a captioned button without image, font lbl_105BA2E8[12].
    this.zodiacBtn.font = await fonts.acquire(12);
    this.zodiacBtn.cols = 4;
    this.personalityWin.childAdd(this.zodiacBtn);
    // The signs' popup texts: name, then description + compatible and incompatible signs.
    await strings.load("GameData/UIText.iff");
    const signTexts = strings.list("UIText", STR_SIGN_TEXTS);
    const signName = (n: number): string => strings.get("UIText", STR_SIGNS, n - 1);
    for (let i = 0; i < 12; i++) {
      this.signNames.push(signTexts[2 * i] ?? "");
      const pair = (table: number[], prefix: number): string =>
        strings.get("UIText", STR_MISC, prefix) + signName(table[2 * i]!) + ", " + signName(table[2 * i + 1]!);
      this.signDescs.push(`${signTexts[2 * i + 1] ?? ""}\n${pair(COMPATIBLE_SIGNS, 6)}\n${pair(INCOMPATIBLE_SIGNS, 7)}`);
    }
    this.zodiacClient.target = this.zodiacBtn;

    this.interests.buildInterests();

    // Page titles: cTSWinText, font lbl_105BA2E8[11], at (5, 0), transparent, one line, fitted
    // to the text (vtable 0x1ec(0) = SetBackgroundOpaque, 0x1e4(2, 0) = SetWinTextFlag, 0x1d8).
    const titleFont = await fonts.acquire(11);
    for (const [win, caption, toBack] of [
      [this.motivesWin, needsTitle, false],
      [this.petMotivesWin, needsTitle, false],
      [this.personalityWin, personalityTitle, true],
    ] as const) {
      const t = new TSWinText();
      t.setFont(titleFont);
      t.moveTo(TITLE_ORIGIN.x, TITLE_ORIGIN.y);
      t.setBackgroundOpaque(false);
      t.setCaption(caption);
      win.childAdd(t);
      t.setWinTextFlag(WTF_MULTILINE, false);
      t.fitWindowToText();
      if (toBack) win.childToBack(t);
    }

    // Two tooltip-only windows over the mood gauge (UIText STR# 154, string 16).
    for (const r of GAUGE_TIP_AREAS) {
      const w = new TSWin();
      this.childAdd(w);
      w.setArea(r.left, r.top, r.right, r.bottom);
      w.moveTo(GAUGE.x + r.left, GAUGE.y + r.top);
      w.tooltip = strings.get("UIText", STR_MISC, 15);
    }

    // The popup lives in the lot view (cSimsApp+0x80); the pages share it.
    this.popup = new WinLivePopup(ctx);
    if (!(await this.popup.init())) return false;
    for (const page of [this.job, this.fame, this.dogSkills, this.catSkills, this.reportCard, this.house, this.relationships, this.interests]) {
      page.livePopup = this.popup;
    }

    this.setPerson(-1);
    this.setPanel(LivePanel.Mood);
    const options = getOptionsMgr();
    this.setQuickTips(options.getQuickTips());
    options.onChange((o) => this.setQuickTips(o.getQuickTips()));
    return true;
  }

  /**
   * cWinPeople::SetQuickTips: the needs, traits, relationships, interests
   * and zodiac sign open their popup on hover after the default async
   * timeout (flag 1) when quick tips are on; holding a portrait (flag 2)
   * opens the person's popup either way.
   */
  setQuickTips(on: boolean): void {
    const timeout = getOptionsMgr().getDefaultAsyncTimeout();
    const hover = on ? ASYNC_ON_ENTER : 0;
    for (const b of [...this.motives, ...this.petMotives, ...this.personalities, ...this.relationships.tiles, ...this.interests.tiles, this.zodiacBtn]) {
      b.setAsync(hover, timeout);
    }
    for (const b of this.familyBtns) b.setAsync(ASYNC_ON_DOWN, timeout);
    this.job.setQuickTips(on);
    this.fame.setQuickTips(on);
    this.dogSkills.setQuickTips(on);
    this.catSkills.setQuickTips(on);
    this.reportCard.setQuickTips(on);
    this.house.setQuickTips(on);
  }

  // --- pages -----------------------------------------------------------------

  private pageWindows(): TSWin[] {
    return [
      this.motivesWin,
      this.petMotivesWin,
      this.personalityWin,
      this.zodiacBtn,
      this.job,
      this.fame,
      this.dogSkills,
      this.catSkills,
      this.reportCard,
      this.relationships,
      this.house,
      this.interests,
      this.gifts,
    ];
  }

  /** Family index of the selected person (PersonFinder::GetSelected), -1 = none. */
  private selected(): number {
    return this.ctx.state.personGetSelected() ? this.ctx.state.selectedIndex() : -1;
  }

  /**
   * The job page of `p` (cWinPeople::SetPanel(3)): a child's report card, a
   * dog's (cXPerson+0x60e & 2) or a cat's (& 4) skills, else cWinSubpanelFame
   * when CPState::GetShowFameUIPanel, else cWinSubpanelJob.
   */
  private jobPage(p: PersonInfo): TSWin {
    if (isChild(p)) return this.reportCard;
    const gender = personGender(p);
    if (gender & 2) return this.dogSkills;
    if (gender & 4) return this.catSkills;
    return showFameUIPanel(p) ? this.fame : this.job;
  }

  /** The five job pages, shown one at a time. */
  private jobPages(): TSWin[] {
    return [this.job, this.fame, this.dogSkills, this.catSkills, this.reportCard];
  }

  private personAt(i: number): PersonInfo | null {
    return this.ctx.state.family[i] ?? null;
  }

  /** The person instance is a Sim (not a pet): cXPerson+0x60e < 2. */
  private isSim(i: number): boolean {
    const p = this.personAt(i);
    return p !== null && personGender(p) < 2;
  }

  /** cWinPeople::SetPanel. */
  setPanel(panel: LivePanel): void {
    if (panel !== this.panel) this.popup?.disablePopup();
    const prev = PAGE_BUTTONS.findIndex((d) => d.panel === this.panel);
    if (prev >= 0) this.pageBtns[prev]!.setState(0);
    if (panel === LivePanel.House && this.ctx.state.zoningType !== 1) panel = LivePanel.None;
    this.panel = panel;
    for (const w of this.pageWindows()) w.hideWindow();
    if (panel === LivePanel.None) return;

    const sel = this.selected();
    switch (panel) {
      case LivePanel.Mood:
        if (this.isSim(sel)) this.motivesWin.showWindow();
        else this.petMotivesWin.showWindow();
        for (const m of [...this.motives, ...this.petMotives]) m.setPerson(sel);
        break;
      case LivePanel.Personality:
        if (this.isSim(sel)) this.zodiacBtn.showWindow();
        this.personalityWin.showWindow();
        break;
      case LivePanel.Job: {
        const p = this.personAt(sel);
        if (p) this.jobPage(p).showWindow();
        break;
      }
      case LivePanel.House:
        this.house.showWindow();
        break;
      case LivePanel.Relationships:
        this.relationships.showWindow();
        break;
      case LivePanel.Interests:
        this.interests.showWindow();
        break;
      case LivePanel.Gifts:
        this.gifts.showWindow();
        this.gifts.buildGifts(sel);
        break;
    }
    this.ctx.state.setDirty(PANEL_DIRTY[panel]);
    const btn = PAGE_BUTTONS.findIndex((d) => d.panel === panel);
    this.pageBtns[btn]?.setState(1);
    this.updateViewFromCPState();
  }

  // --- person ----------------------------------------------------------------

  /** cWinPeople::SetPerson: `person` is a family index or -1. */
  private setPerson(person: number): void {
    const family = this.ctx.state.family;
    this.personSlot = person >= 0 && person < Math.min(family.length, MAX_FAMILY) ? person : -1;
    if (person === -1) return;
    const p = this.personAt(person);
    // Tooltips of the job / interests / gifts buttons (STR# 134, 1-based in the code).
    const tips = !p || personGender(p) >= 2 ? [7, 9, 9] : isChild(p) ? [8, 5, 6] : [2, 5, 6];
    const enabled = !!p && personGender(p) < 2;
    this.pageBtns[BTN_JOB]!.tooltip = this.ctx.strings.get("Live", STR_MODE_TIPS, tips[0]!);
    this.pageBtns[BTN_INTEREST]!.tooltip = this.ctx.strings.get("Live", STR_MODE_TIPS, tips[1]!);
    this.pageBtns[BTN_INTEREST]!.setEnabled(enabled);
    this.pageBtns[BTN_GIFT]!.tooltip = this.ctx.strings.get("Live", STR_MODE_TIPS, tips[2]!);
    this.pageBtns[BTN_GIFT]!.setEnabled(enabled);

    if (this.panel === LivePanel.Mood) {
      if (this.isSim(person)) {
        this.motivesWin.showWindow();
        this.petMotivesWin.hideWindow();
      } else {
        this.motivesWin.hideWindow();
        this.petMotivesWin.showWindow();
      }
      for (const m of [...this.motives, ...this.petMotives]) m.setPerson(person);
    }
    this.familyBtns.forEach((b, i) => b.setState(i === this.personSlot ? 1 : 0));
    // The open popup follows the person (UpdateClient).
    if (this.panel === LivePanel.Personality) for (const w of this.personalities) w.setPerson(person);
    if (this.panel === LivePanel.Job && p) {
      for (const w of this.jobPages()) w.hideWindow();
      this.jobPage(p).showWindow();
    }
    if (p) this.setZodiac(p);
    if (p && personGender(p) >= 2 && (this.panel === LivePanel.Interests || this.panel === LivePanel.Gifts)) {
      this.setPanel(LivePanel.Mood);
    }
  }

  /** The zodiac part of SetPerson: caption sized to the text, 5 px from the page's bottom-left. */
  private setZodiac(p: PersonInfo): void {
    const b = this.zodiacBtn;
    if (personGender(p) >= 2) {
      b.hideWindow();
      return;
    }
    b.showWindow();
    const data = p.personData;
    let sign = data?.[PD_ZODIAC] ?? 0;
    if (data && sign === 0) {
      sign = computeZodiacSign(data);
      data[PD_ZODIAC] = sign;
    }
    // GetZodiacName clamps to 1..12.
    sign = Math.min(12, Math.max(1, sign));
    b.caption = this.ctx.strings.get("UIText", STR_SIGNS, sign - 1);
    const font = b.font!;
    const w = font.stringWidth(b.caption);
    const h = font.height;
    const top = this.personalityWin.getH() - h - 5;
    b.setArea(5, top, 5 + w, top + h);
  }

  // --- CPState ---------------------------------------------------------------

  /** cWinPeople::UpdateViewFromCPState. */
  updateViewFromCPState(): void {
    const state: CPState = this.ctx.state;
    const dirty = state.dirty;
    const sel = this.selected();
    if (dirty & DIRTY_FAMILY) this.updateFamilyButtons();
    if (sel === -1) this.setPanel(LivePanel.None);
    else if (this.panel === LivePanel.None) this.setPanel(LivePanel.Mood);
    // Once, then once more per CPState+0x1f0 pulse still due.
    if (dirty & DIRTY_MOTIVES) {
      do {
        for (const m of [...this.motives, ...this.petMotives]) m.pumpMotive();
      } while (state.shouldPulseMotives());
    }
    if (this.personSlot === -1) {
      this.setPerson(sel);
    } else {
      if (dirty & DIRTY_PERSONALITY) {
        if (this.panel === LivePanel.Personality) for (const w of this.personalities) w.setPerson(sel);
        const p = this.personAt(sel);
        if (p && personGender(p) < 2) this.zodiacBtn.showWindow();
        else this.zodiacBtn.hideWindow();
      }
      if (dirty & DIRTY_LISTS) {
        if (this.panel === LivePanel.Relationships) void this.relationships.buildRelationships();
        else if (this.panel === LivePanel.Interests) this.interests.buildInterests();
        else if (this.panel === LivePanel.Gifts) this.gifts.buildGifts(sel);
      }
      if (dirty & DIRTY_SELECTED) this.setPerson(sel);
    }
    // Portrait row follows the overall mood.
    this.familyBtns.forEach((b, i) => {
      const p = this.personAt(i);
      if (!p) return;
      const mood = p.motives[MOTIVE_MOOD] ?? 0;
      b.row = mood < MOOD_LOW ? 2 : mood <= MOOD_HIGH ? 0 : 1;
    });
    this.job.updateViewFromCPState();
    this.fame.updateViewFromCPState();
    // cWinPeople::UpdateViewFromCPState: the job page follows GetShowFameUIPanel.
    const shown = this.panel === LivePanel.Job ? this.ctx.state.personGetSelected() : null;
    if (shown) {
      const page = this.jobPage(shown);
      for (const other of this.jobPages()) if (other !== page && other.isVisible()) other.hideWindow();
      if (!page.isVisible()) page.showWindow();
    }
    this.house.updateViewFromCPState();
  }

  /** The family part of UpdateViewFromCPState (dirty 0x20080000). */
  private updateFamilyButtons(): void {
    for (const b of this.familyBtns) b.hideWindow();
    const family = this.ctx.state.family;
    const n = Math.min(family.length, MAX_FAMILY);
    for (let i = 0; i < n; i++) {
      const p = family[i]!;
      const b = this.familyBtns[i]!;
      b.setImage(this.pictureBuffer(p), 4, 3);
      b.tooltip = personGender(p) < 3 ? p.firstName : `${p.firstName} ${p.lastName}`;
      b.showWindow();
    }
  }

  /** PersonFinder::GetPictureBuffer (cached). */
  private pictureBuffer(p: PersonInfo): ImageBitmap {
    let img = this.pictures.get(p);
    if (!img) {
      img = buildPersonBtn(p.face, this.template!);
      this.pictures.set(p, img);
    }
    return img;
  }

  // --- input -----------------------------------------------------------------

  /**
   * cWinPeople::TSOnCommand: command 1 (button pressed); 0x13 (async
   * timeout) is a click for everything but the portraits, whose person
   * popup is not ported; 0x14 is ignored.
   */
  override tsOnCommand(cmd: number, source: TSWin): boolean {
    if (cmd === CMD_ASYNC_EXIT) return true;
    const slot = this.familyBtns.indexOf(source as TSWinBtn);
    if (cmd === CMD_ASYNC_TIMEOUT && slot >= 0) return true;
    if (this.popupCommand(source)) return true;
    if (slot >= 0) {
      if (winMgr.isKeyDown("Control")) {
        void this.editBio(slot);
        return true;
      }
      this.personSlot = slot;
      this.ctx.state.setSelectedPerson(slot);
      this.setPerson(slot);
      return true;
    }
    const page = this.pageBtns.indexOf(source as TSWinBtn);
    if (page >= 0) {
      const def = PAGE_BUTTONS[page]!;
      const residential = def.panel !== LivePanel.House || this.ctx.state.zoningType === 1;
      if (this.personSlot !== -1 && residential) this.setPanel(def.panel);
      else {
        this.pageBtns[page]!.setState(0);
        soundPlayer.playUISound(UI.error);
      }
      return true;
    }
    return super.tsOnCommand(cmd, source);
  }

  /**
   * The Ctrl+click part of TSOnCommand: cWinEditBio(GetPersonInHouseIndex)
   * centered on the main window, run modally with the simulator blocked
   * (cDDDSimsView::SetBlockSimulator, cSimsApp::StopScrolling), destroyed;
   * the portrait is released unless it is the selected person's.
   */
  private async editBio(slot: number): Promise<void> {
    const p = this.personAt(slot);
    if (!p) return;
    const win = new WinEditBio(this.ctx, p);
    if (!(await win.init())) return;
    const main = winMgr.main;
    win.moveTo(
      Math.trunc((main.getW() - win.getW()) / 2),
      Math.trunc((main.getH() - win.getH()) / 2),
    );
    const hooks = this.ctx.hooks;
    hooks?.setBlockSimulator?.(true);
    await winMgr.doModalWin(win);
    hooks?.setBlockSimulator?.(false);
    if (this.ctx.state.selectedIndex() !== slot) this.familyBtns[slot]?.setState(0);
  }

  /** The Panel 1 / 2 / 7 part of TSOnCommand: the needs, traits, zodiac sign and gifts open their popup. */
  private popupCommand(source: TSWin): boolean {
    const popup = this.popup;
    if (this.panel === LivePanel.Mood) {
      const m = [...this.motives, ...this.petMotives].find((x) => x === source);
      if (m) popupClick(popup, m.client, this, m);
      return !!m;
    }
    if (this.panel === LivePanel.Personality) {
      const w = this.personalities.find((x) => x === source);
      if (w) {
        popupClick(popup, w.client, this, w, () => w.updateClient());
        return true;
      }
      if (source === this.zodiacBtn) {
        // GetSignFromName on the button's caption.
        const sign = Array.from({ length: 12 }, (_, i) => this.ctx.strings.get("UIText", STR_SIGNS, i)).indexOf(this.zodiacBtn.caption) + 1;
        if (sign > 0) {
          const c = this.zodiacClient;
          popupClick(popup, c, this, this.zodiacBtn, () => {
            c.setName(this.signNames[sign - 1] ?? "");
            c.setDesc(this.signDescs[sign - 1] ?? "");
          });
        }
        return true;
      }
      return false;
    }
    if (this.panel === LivePanel.Gifts) {
      const sel = this.selected();
      const g = this.gifts.gifts.find((x) => x === source);
      if (g) {
        popupClick(popup, g.client, this, g, () => g.setupClient());
        return true;
      }
      if (source === this.gifts.prevPage) this.gifts.prev(sel);
      else if (source === this.gifts.nextPage) this.gifts.next(sel);
      else if (this.gifts.sortPressed(source, sel)) this.ctx.state.setDirty(PANEL_DIRTY[LivePanel.Gifts]);
      else return false;
      return true;
    }
    return false;
  }

  /**
   * cWinPeople::TSOnMouseMove / TSOnMouseExit(Child): the popup closes once
   * the mouse leaves the panel, or the page area (300, 50)-(page right, 150)
   * for a page's popup.
   */
  override pump(nowMs: number): void {
    super.pump(nowMs);
    const popup = this.popup;
    if (!popup?.isEnabled() || !this.isVisibleAndAllParentsVisible()) return;
    const { x, y } = winMgr.cursorPosition();
    let root: TSWin = this;
    while (root.parent) root = root.parent;
    let inside = false;
    for (let w = root.windowFromPoint(x, y); w; w = w.parent) if (w === this) inside = true;
    const o = this.absOrigin();
    const lx = x - o.x;
    const ly = y - o.y;
    const right = PAGE_ORIGIN.x + PAGE_AREA.right + (this.ctx.width === 0x400 ? WIDE_SCREEN_EXTRA : 0);
    const inPage = lx >= PAGE_ORIGIN.x && ly >= PAGE_AREA.top && lx < right && ly < PAGE_AREA.bottom;
    if (!inside || !inPage) popup.disablePopup();
  }

  /** cWinPeople::IsPointInWindowWindowCoordinates: the top 50 px let clicks through. */
  override isPointInWindowWindowCoordinates(x: number, y: number): boolean {
    return y > 0x31 && x >= 0 && x < this.getW() && y < this.getH();
  }

  // --- paint -----------------------------------------------------------------

  /** cWinPeople::TSPaint: background band, mood gauge and mood bars. */
  override tsPaint(g: Gfx): void {
    if (this.background) g.blitPart(this.background, 0, 0, this.getW(), this.getH() - 50, 0, 50);
    const gauge = this.gauge;
    if (!gauge) return;
    g.blit(gauge, GAUGE.x, GAUGE.y);

    const sel = this.selected();
    let mood = 0;
    if (sel !== -1) {
      const m = this.personAt(sel)?.motives[MOTIVE_MOOD] ?? 0;
      mood = m >= 0 ? Math.trunc(m + 0.5) : Math.trunc(m - 0.5);
    }
    const f = (11 * (100 + mood)) / 201 - 5;
    const level = f >= 0 ? Math.min(5, Math.trunc(f + 0.5)) : Math.max(-5, Math.trunc(f - 0.5));
    const green = this.greenBars;
    const red = this.redBars;
    if (red && level < 0) {
      // Red bars grow down from their top, 5 px per step.
      g.blitPart(red, 0, 0, red.width, -5 * level, RED_BARS.x, RED_BARS.y);
    } else if (green && level > 0) {
      // Green bars grow up from their bottom.
      const skip = green.height - 5 * level;
      g.blitPart(green, 0, skip, green.width, green.height - skip, GREEN_BARS.x, GREEN_BARS.y + skip);
    } else if (green && red) {
      // Neutral: the last 2 rows of green and the first 2 of red.
      g.blitPart(green, 0, green.height - 2, green.width, 2, GREEN_BARS.x, GREEN_BARS.y + green.height - 2);
      g.blitPart(red, 0, 0, red.width, 2, RED_BARS.x, RED_BARS.y);
    }
  }
}
