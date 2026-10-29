/**
 * Fame subpanel of the Live panel's job page (cWinSubpanelFame, Superstar):
 * shown instead of the job page for a jobless person with star points
 * (CPState::GetShowFameUIPanel). Left: the fame title (STR# 1 of fame.iff),
 * the fame bar, the fame level's title and the famous friends line; right:
 * the six skills of the fame track with their bars, the level the next fame
 * level needs marked under each bar (cFameTrack::GetSkillNeededToAdvance).
 *
 * Layout from the decompiled code (single-byte UI, WinSubpanelFame.cpp static
 * init): skill labels 62x16 at (145, 6 + 15 i) right-aligned (lbl_105BCC78),
 * the level label 102x16 at (3, 45); skill bars at (210, 7 + 15 i)
 * (lbl_105BCCAC, kJobSubBarsOff then kJobSubpanelBars clipped to 4 px per
 * skill level), the fame bar at (3, 30) (kFameSubBarsOff then
 * kFameSubpanelBars clipped to 8 px per fame level); the famous friends line
 * 120x15 at (3, 75) with kFameFriendSmileyBMP (lbl_105C33A8, 4 columns); the
 * title at (5, 0) (lbl_105BCCB0). Strings: STR# 1 of GameData/fame.iff (title,
 * 11 level titles, the friends format, 11 level popups, the friends popup)
 * and STR# 136 / 137 of Live.iff (skill labels and popups).
 *
 * Person data (PersonFinder::GetData): skills 10..18, family 0x3d, star
 * points 0x50, fame level 0x51.
 */

import type { GameContext } from "../../context.js";
import type { PersonInfo } from "../../cpstate.js";
import type { FfnFont } from "../../res/ffn.js";
import { LANG_FRENCH } from "../../res/uires.js";
import { getOptionsMgr } from "../../optionsmgr.js";
import { loadUIStringSet } from "../../sim/behavior.js";
import { loadFameScoring, type FameScoring } from "../../sim/fametrack.js";
import { ASYNC_ON_ENTER, BTN_TOGGLE, CMD_ASYNC_EXIT } from "../../ui/btn.js";
import { UI_FONT_COLOR } from "../../ui/syscolors.js";
import { Gfx, TSWin } from "../../ui/tswin.js";
import { ResFile } from "../../world/iffres.js";
import { popupClick, type WinLivePopup, WinLivePopupClient } from "../livepopup.js";
import { FlashyBtn } from "./job.js";

/** cSimsApp language (+100); the client runs the French install. */
const UI_LANGUAGE = LANG_FRENCH;

const LIVE = "Live";
/** STR# 136: the skill labels (entries 1..6). */
const STR_LABELS = 0x88;
/** STR# 137: (name, description) of the six skills. */
const STR_POPUP = 0x89;

/** STR# 1 of fame.iff, as cWinSubpanelFame::Init walks it. */
const FAME = {
  title: 0,
  levelTitles: 1,
  friendsFormat: 12,
  levelPopups: 13,
  friendsPopup: 37,
} as const;
const LEVELS = 11;

/** lbl_105BCCA8: person data of each skill row (cooking, mechanical, charisma, body, logic, creativity). */
const SKILLS = [10, 12, 11, 17, 18, 15];
/** lbl_105BCC78 (single-byte UI): skill labels, then the level label. */
const LABEL_POS = [[145, 6], [145, 21], [145, 36], [145, 51], [145, 66], [145, 81], [3, 45]] as const;
/** lbl_105BCCAC: skill bars, then the fame bar. */
const BAR_POS = [[210, 7], [210, 22], [210, 37], [210, 52], [210, 67], [210, 82], [3, 30]] as const;
/** lbl_105BCCA0 / lbl_105BCC98: the famous friends line. */
const FRIENDS_POS = [3, 75] as const;
const FRIENDS_SIZE = [120, 15] as const;
/** lbl_105BCCB0: the title. */
const TITLE_POS = [5, 0] as const;
/**
 * lbl_105BCCB8: the level popup's first pane by fame level. 0x11 / 0x12 /
 * 0x13 are kFameRunway / kFameMusicVideo / kFameMovieSet; the others are
 * catalog objects (GUIDs, cWinLivePopupClient::SetObject: not ported).
 */
const LEVEL_PANE = [0x6a8594ad, 0x4450e4e0, 0x1d772052, 0xf4126cc4, 0x4450e4e0, 0xf4126cc4, 0x1d772052, 0x11, 0x12, 0x13, 0x4b61d53e];
/** lbl_105BCC08 + 0x8a / + 0x87 (cFameTrack::GetFamousFriendCount). */
const HALF = [".0", ".5"];
/** lbl_105BB808: a famous friend counts half. */
const FRIEND_WEIGHT = 0.5;

export class WinSubpanelFame extends TSWin {
  private bars: ImageBitmap | null = null;
  private barsOff: ImageBitmap | null = null;
  private fameBars: ImageBitmap | null = null;
  private fameBarsOff: ImageBitmap | null = null;
  /** +0xdc / +0xe0 / +0xe4: kFameRunway, kFameMovieSet, kFameMusicVideo. */
  private runway: ImageBitmap | null = null;
  private movieSet: ImageBitmap | null = null;
  private musicVideo: ImageBitmap | null = null;
  private titleFont: FfnFont | null = null;
  /** +0xe8: the six skill labels and the level label (index 6). */
  private readonly labelBtns: FlashyBtn[] = [];
  /** +0xf4: the famous friends line. */
  private readonly summaryBtns: FlashyBtn[] = [];
  /** STR# 1 of fame.iff. */
  private fameTexts: string[] = [];
  /** STR# 137 of Live.iff. */
  private popupTexts: string[] = [];
  private scoring: FameScoring | null = null;
  /** cWinPeople+0x150: the Live panel's popup (set by WinPeople); +0x1b8 this page's client. */
  livePopup: WinLivePopup | null = null;
  private readonly client = new WinLivePopupClient();

  constructor(readonly ctx: GameContext) {
    super();
  }

  /** cWinSubpanelFame::Init */
  override async init(): Promise<boolean> {
    const { ctx } = this;
    const [bars, barsOff, fameBars, fameBarsOff, runway, movieSet, musicVideo, smiley, font7, titleFont, scoring, fameFile] = await Promise.all([
      ctx.res.image("kJobSubpanelBars"),
      ctx.res.image("kJobSubBarsOff"),
      ctx.res.image("kFameSubpanelBars"),
      ctx.res.image("kFameSubBarsOff"),
      ctx.res.image("kFameRunway"),
      ctx.res.image("kFameMovieSet"),
      ctx.res.image("kFameMusicVideo"),
      ctx.res.image("kFameFriendSmileyBMP"),
      ctx.fonts.acquire(7),
      ctx.fonts.acquire(UI_LANGUAGE === LANG_FRENCH ? 10 : 11),
      loadFameScoring(),
      ResFile.open("GameData/fame.iff").catch(() => null),
    ]);
    this.bars = bars;
    this.barsOff = barsOff;
    this.fameBars = fameBars;
    this.fameBarsOff = fameBarsOff;
    this.runway = runway;
    this.movieSet = movieSet;
    this.musicVideo = musicVideo;
    this.titleFont = titleFont;
    this.scoring = scoring;
    this.fameTexts = (fameFile && loadUIStringSet(fameFile, 1)) || [];
    this.setArea(0, 0, 0x1ab, 100);

    const labels = ctx.strings.list(LIVE, STR_LABELS);
    for (let i = 0; i < 7; i++) {
      const btn = new FlashyBtn();
      const [x, y] = LABEL_POS[i]!;
      const w = i === 6 ? 0x66 : 0x3e;
      btn.caption = i === 6 ? this.text(FAME.levelTitles + 1) : (labels[i + 1] ?? "");
      btn.setArea(x, y, x + w, y + 0x10);
      btn.mode = BTN_TOGGLE;
      btn.textRect = { left: 0, top: 0, right: w, bottom: 0x10 };
      btn.textAlignment = i === 6 ? 0 : 2;
      btn.setImageKeepArea(null, 4, 0);
      btn.font = font7;
      this.childAdd(btn);
      this.labelBtns.push(btn);
    }
    this.popupTexts = ctx.strings.list(LIVE, STR_POPUP);

    // The famous friends line: kFameFriendSmileyBMP (4 columns), the text after it, two lines high.
    const friends = new FlashyBtn();
    friends.setImageKeepArea(smiley, 4, 1);
    friends.font = font7;
    friends.mode = BTN_TOGGLE;
    const [fx, fy] = FRIENDS_POS;
    friends.setArea(fx, fy, fx + FRIENDS_SIZE[0], fy + font7.height);
    friends.paraText = false;
    friends.textRect = { left: Math.trunc(smiley.width / 4) + 3, top: 0, right: FRIENDS_SIZE[0], bottom: font7.height * 2 };
    friends.textAlignment = 0;
    this.childAdd(friends);
    this.summaryBtns.push(friends);
    return super.init();
  }

  private text(i: number): string {
    return this.fameTexts[i] ?? "";
  }

  /** The panel repaints from CPState every frame. */
  updateViewFromCPState(): void {
    const p = this.ctx.state.personGetSelected();
    this.updateFameLabel(p);
    this.setFriendsNeeded(p);
  }

  /** cWinSubpanelFame::SetQuickTips: the labels and the friends line open their popup on hover. */
  setQuickTips(on: boolean): void {
    const timeout = getOptionsMgr().getDefaultAsyncTimeout();
    for (const b of [...this.labelBtns, ...this.summaryBtns]) b.setAsync(on ? ASYNC_ON_ENTER : 0, timeout);
  }

  /**
   * cWinSubpanelFame::TSOnCommand: a skill (or the level label) shows its
   * popup, the friends line its own (SetupSummaryClient); a second click on
   * the open item closes it.
   */
  override tsOnCommand(cmd: number, source: TSWin): boolean {
    if (cmd === CMD_ASYNC_EXIT) return true;
    const popup = this.livePopup;
    const label = this.labelBtns.indexOf(source as FlashyBtn);
    if (label >= 0) {
      this.labelBtns.forEach((b, i) => b.setState(i === label ? 1 : 0));
      if (popup) popupClick(popup, this.client, this, this.labelBtns[label]!, () => this.setupLabelClient(label));
      return true;
    }
    const line = this.summaryBtns.indexOf(source as FlashyBtn);
    if (line >= 0) {
      if (popup) {
        popupClick(popup, this.client, this, this.summaryBtns[line]!, () => {
          // cWinSubpanelFame::SetupSummaryClient
          this.client.setName(this.text(FAME.friendsPopup + 2 * line));
          this.client.setDesc(this.text(FAME.friendsPopup + 2 * line + 1));
          this.client.setBitmap(0, null);
          this.client.setBitmap(1, null);
        });
      }
      return true;
    }
    return super.tsOnCommand(cmd, source);
  }

  /** The popup of a skill (+0x104 / +0x110) or of the level label (UpdateFamePopup: the level's text). */
  private setupLabelClient(i: number): void {
    const c = this.client;
    c.setBitmap(1, null);
    if (i < 6) {
      c.setName(this.popupTexts[2 * i] ?? "");
      c.setDesc(this.popupTexts[2 * i + 1] ?? "");
      // lbl_105BCCBC: the skills' panes are catalog objects (not ported).
      c.setBitmap(0, null);
      return;
    }
    const level = this.level(this.ctx.state.personGetSelected());
    const k = level >= 0 && level < LEVELS ? level : 1;
    c.setName(this.text(FAME.levelPopups + 2 * k));
    c.setDesc(this.text(FAME.levelPopups + 2 * k + 1));
    const pane = LEVEL_PANE[k] ?? 0;
    c.setBitmap(0, pane === 0x11 ? this.runway : pane === 0x12 ? this.musicVideo : pane === 0x13 ? this.movieSet : null);
  }

  // --- cFameTrack queries -----------------------------------------------------

  private data(p: PersonInfo | null, index: number): number {
    return p?.personData?.[index] ?? 0;
  }

  /** cFameTrack::GetFameLevelFromPerson: person data 0x51. */
  private level(p: PersonInfo | null): number {
    return this.data(p, 0x51);
  }

  /** cFameTrack::GetSkillNeededToAdvance: the level's skill level, 0 once the raw skill reaches it. */
  private skillNeeded(p: PersonInfo | null, k: number): number {
    const level = this.level(p);
    if (!this.scoring || level < 0 || level >= 0xc) return 0;
    const req = this.scoring.skills[k]?.[level] ?? 0;
    return this.data(p, SKILLS[k]!) < req * 100 ? req : 0;
  }

  /** cFameTrack::GetFriendsNeededToAdvance */
  private friendsNeeded(p: PersonInfo | null): number {
    const level = this.level(p);
    return this.scoring && level >= 0 && level < 0xc ? (this.scoring.friends[level] ?? 0) : 0;
  }

  /**
   * PersonFinder::GetFamousFriendCount (Neighborhood::GetFamousFriendCount):
   * the fame levels of the characters of another family sharing a daily
   * relationship of at least 25 both ways (see SimModule.famousFriendCount).
   */
  private famousFriendCount(p: PersonInfo): number {
    const fam = this.data(p, 0x3d);
    const daily = (from: PersonInfo, to: number | undefined): number | null => {
      const r = to === undefined ? undefined : from.relationships?.find((x) => x.other === to);
      return r?.values[0] ?? null;
    };
    let n = 0;
    for (const o of [...this.ctx.state.family, ...this.ctx.state.neighbors]) {
      const ofam = this.data(o, 0x3d);
      if (o === p || ofam === 0 || ofam === fam) continue;
      const ab = daily(p, o.neighborId);
      const ba = daily(o, p.neighborId);
      if (ab !== null && ba !== null && ab >= 25 && ba >= 25) n += this.data(o, 0x51);
    }
    return n;
  }

  /** cFameTrack::GetFamousFriendCount: the count, halved, as "n.0" / "n.5". */
  private famousFriendString(p: PersonInfo): string {
    const count = this.famousFriendCount(p);
    const f = count > 0 ? Math.fround(count * FRIEND_WEIGHT) : count;
    const whole = Math.trunc(f);
    return `${whole}${f - whole === 0 ? HALF[0] : HALF[1]}`;
  }

  // --- painting ----------------------------------------------------------------

  /** cWinSubpanelFame::UpdateFameLabel: the level label shows the level's title. */
  private updateFameLabel(p: PersonInfo | null): void {
    const level = this.level(p);
    const btn = this.labelBtns[6];
    if (btn && level >= 0 && level < LEVELS) btn.caption = this.text(FAME.levelTitles + level);
  }

  /**
   * cWinSubpanelFame::SetFriendsNeeded: "count (needed n)" while
   * cFameTrack::IsFriendsNeededShown is false (half the famous friends below
   * the level's need), else the count alone.
   */
  private setFriendsNeeded(p: PersonInfo | null): void {
    const btn = this.summaryBtns[0];
    if (!btn || !p) return;
    const count = this.famousFriendString(p);
    const needed = this.friendsNeeded(p);
    const met = needed <= Math.fround(this.famousFriendCount(p) * FRIEND_WEIGHT);
    btn.showWindow();
    btn.caption = met ? count : this.text(FAME.friendsFormat).replace("%s", count).replace("%d", String(needed));
  }

  /** cWinSubpanelFame::TSPaint (with PaintFameBar). */
  override tsPaint(g: Gfx): void {
    const p = this.ctx.state.personGetSelected();
    const { bars, barsOff } = this;
    if (bars && barsOff && p) {
      SKILLS.forEach((skill, i) => {
        const [x, y] = BAR_POS[i]!;
        const level = Math.min(10, Math.max(0, Math.trunc(this.data(p, skill) / 100)));
        g.blit(barsOff, x, y);
        if (level > 0) {
          const w = level * 4 <= bars.width && level !== 10 ? level * 4 : bars.width;
          g.blitPart(bars, 0, 0, w, bars.height, x, y);
        }
      });
    }
    this.titleFont?.drawText(g.ctx, this.text(FAME.title), g.ox + TITLE_POS[0], g.oy + TITLE_POS[1], UI_FONT_COLOR);
    if (p && bars) {
      SKILLS.forEach((_, i) => {
        const needed = this.skillNeeded(p, i);
        const btn = this.labelBtns[i];
        if (btn) btn.underline = needed > 0;
        if (needed <= 0) return;
        // An L under the bar: up at the needed level, back to 15 px left of the bar.
        const n = needed * 4;
        const [bx, top] = BAR_POS[i]!;
        const x = bx + n - 1;
        const bottom = top + bars.height - 1;
        g.fill(x, top, 1, bottom - top + 1, UI_FONT_COLOR);
        g.fill(x - (n + 0xf), bottom, n + 0xf + 1, 1, UI_FONT_COLOR);
      });
    }
    this.updateViewFromCPState();
    // PaintFameBar: kFameSubBarsOff, then kFameSubpanelBars over 8 px per fame level.
    const { fameBars, fameBarsOff } = this;
    if (fameBars && fameBarsOff && p) {
      const [x, y] = BAR_POS[6];
      const level = this.level(p);
      g.blit(fameBarsOff, x, y);
      if (level > 0) {
        const w = level * 8 <= fameBars.width && level !== 10 ? level * 8 : fameBars.width;
        g.blitPart(fameBars, 0, 0, w, fameBars.height, x, y);
      }
    }
  }
}
