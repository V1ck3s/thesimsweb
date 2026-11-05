/**
 * Job subpanel of the Live panel (cWinSubpanelJob, with its cFlashyBtn and
 * cPerformanceBtn captions): career icon and job title, salary, performance
 * and friends needed on the left; the six job skills with their bars on the
 * right, the level the next promotion needs marked under each bar.
 *
 * Layout from the decompiled code (single-byte UI, WinSubpanelJob.cpp static
 * init): skill labels 62x16 at (93, 6 + 15 i), right-aligned, 7 pt; bars at
 * (157, 7 + 15 i), kJobSubBarsOff then kJobSubpanelBars clipped to 4 px per
 * skill level; the summary buttons stack from (3, 4): kJobIconGeneric (4
 * columns, 22 career rows) with the title under it, then kSalaryBtnBMP,
 * kPerformanceBtnBMP and kJobFriendSmileyBMP lines, each one font line high.
 * Strings: STR# 136 "JobSubpanelLabels" of Live.iff; career names and the
 * performance words from ExpansionShared/work.iff (see careers.ts).
 *
 * Person data (PersonFinder::GetData): job type 56, promotion level 57, age 58,
 * job performance 63, gender 65, skills 10..18.
 */

import { personGender, type PersonInfo } from "../../cpstate.js";
import type { GameContext } from "../../context.js";
import type { FfnFont } from "../../res/ffn.js";
import { LANG_FRENCH } from "../../res/uires.js";
import { getOptionsMgr } from "../../optionsmgr.js";
import { ASYNC_ON_ENTER, BTN_TOGGLE, CMD_ASYNC_EXIT } from "../../ui/btn.js";
import { rgb, UI_FONT_COLOR } from "../../ui/syscolors.js";
import { Gfx, TSWin } from "../../ui/tswin.js";
import { CaptionBtn } from "./captionbtn.js";
import { careerById, JobReq, jobName, jobShortName, loadCareers, type Career, type Job } from "./careers.js";
import { popupClick, type WinLivePopup, WinLivePopupClient } from "../livepopup.js";

/** cSimsApp language (+100); the client runs the French install. */
const UI_LANGUAGE = LANG_FRENCH;

const LIVE = "Live";
const STR_LABELS = 0x88;
/**
 * STR# 137 (cWinSubpanelJob::Init): (name, description) of the six skills
 * (+0xf4 / +0x100) and of the four summary lines (+0x10c / +0x118), then
 * the performance texts (+0x140, +0x144, +0x150 jobless), the job template
 * (+0x134, "$Start", "$End", "$CarTime"), the jobless salary text (+0x154),
 * +0x148, +0x14c and the top-of-the-career performance texts (+0x158..+0x168).
 */
const STR_POPUP = 0x89;
const POPUP = {
  perf1: 20,
  perf2: 21,
  perfJobless: 22,
  jobTemplate: 23,
  salaryJobless: 24,
  perf3: 25,
  perf4: 26,
  topPerf: [27, 28, 29, 30, 31],
} as const;
/** lbl_105C0E78..: performance steps of the popup text. */
const POPUP_PERF_STEPS = [-60, -30, 30, 60];
const WORK = "work";
/** STR# 0x1000 of work.iff, loaded by LoadCareers (cJob::GetPerformance). */
const STR_PERFORMANCE = 0x1000;

const PD_JOB_TYPE = 56;
const PD_JOB_LEVEL = 57;
const PD_AGE = 58;
const PD_JOB_PERFORMANCE = 63;

/** lbl_105BC5BC: person data index of each skill row. */
const SKILLS = [10, 12, 11, 17, 18, 15];
/** PersonFinder::GetSkillNeededToAdvance jump table: person data index -> JobReq. */
const SKILL_REQ: Record<number, JobReq> = {
  10: JobReq.Cooking,
  11: JobReq.Charisma,
  12: JobReq.Mechanical,
  15: JobReq.Creativity,
  17: JobReq.Body,
  18: JobReq.Logic,
};
/** lbl_105BC5B0 / lbl_105BC5B8 */
const SKILL_LABEL_X = 0x5d;
const SKILL_LABEL_Y = [6, 0x15, 0x24, 0x33, 0x42, 0x51];
const BAR_X = 0x9d;
const BAR_Y = [7, 0x16, 0x25, 0x34, 0x43, 0x52];
/** lbl_105BC594 positions, lbl_105BC58C sizes, lbl_105BC580 font (0 = 8 pt, 1 = 7 pt). */
const SUMMARY_POS = [
  [3, 4], [3, 0x2d], [3, 0x41], [3, 0x55],
] as const;
const SUMMARY_SIZE = [
  [0x5f, 0x2d], [0x5f, 0xf], [0x5f, 0xf], [0x5f, 0xf],
] as const;
const SUMMARY_FONT = [1, 0, 1, 1];
/** lbl_105BC584 */
const SUMMARY_IMAGE = ["kJobIconGeneric", "kSalaryBtnBMP", "kPerformanceBtnBMP", "kJobFriendSmileyBMP"];
/** kJobIconGeneric rows (one per career id). */
const JOB_ICON_ROWS = 0x16;

/** cJob::GetPerformance thresholds (lbl_105BDD94..A0). */
const PERFORMANCE_LEVELS = [-60, -30, 30, 60];

/** cFlashyBtn colors (+0x18c..+0x198) = lbl_105BA7C4. */
const FLASH_COLORS = [rgb(0, 0xca, 0x39), rgb(0, 0xca, 0x39), rgb(0, 0xca, 0x39), rgb(0, 0xca, 0x39)];
/** cWinSubpanelJob::TSPaint: SubscribeTimerMsg period. */
const FLASH_PERIOD_MS = 0x14d;

/** cTSLanguageUtility::GetThousandSeparator, by language id (see viewcontrol.ts). */
const THOUSAND_SEPARATOR = ["", ",", ",", ".", ".", ".", ".", ".", ".", ".", "", "", ",", ".", ".", ",", "", ",", ",", ",", ","];

/** cTSLanguageUtility::MakeMoneyString */
function makeMoneyString(amount: number, lang: number): string {
  const digits = String(Math.abs(amount));
  const sep = THOUSAND_SEPARATOR[lang] ?? ",";
  let out = "";
  let rest = digits.length;
  while (rest > 3) {
    const n = rest % 3 || 3;
    out += digits.slice(digits.length - rest, digits.length - rest + n) + sep;
    rest -= n;
  }
  out += digits.slice(digits.length - rest);
  return (amount < 0 ? "-" : "") + "$" + out;
}

/**
 * cFlashyBtn: a caption button that can blink its caption green
 * (TSOnTimerMsg toggles SetCustomHiliteColors every timer period).
 */
export class FlashyBtn extends CaptionBtn {
  private flashing = false;
  private flashOn = false;
  private nextFlash = 0;

  setFlashing(on: boolean): void {
    if (on === this.flashing) return;
    this.flashing = on;
    this.nextFlash = 0;
    if (!on && this.flashOn) {
      this.hiliteColors = null;
      this.flashOn = false;
    }
  }

  /** cFlashyBtn::TSOnTimerMsg */
  override pump(nowMs: number): void {
    super.pump(nowMs);
    if (!this.flashing) return;
    if (this.nextFlash === 0) this.nextFlash = nowMs + FLASH_PERIOD_MS;
    if (nowMs < this.nextFlash) return;
    this.nextFlash = nowMs + FLASH_PERIOD_MS;
    this.flashOn = !this.flashOn;
    this.hiliteColors = this.flashOn ? FLASH_COLORS : null;
  }
}

/** cPerformanceBtn: a caption too wide for one line is split, the first line right-aligned on the second. */
export class PerformanceBtn extends FlashyBtn {
  constructor(private readonly smallFont: FfnFont) {
    super();
  }

  /** cPerformanceBtn::CaptionDraw */
  protected override captionDraw(g: Gfx): void {
    const font = this.font;
    if (!font) return;
    const text = this.caption;
    const width = this.getW();
    if (font.calculateNumberOfLines(text, width) === 1) {
      super.captionDraw(g);
      return;
    }
    const n1 = font.calculateWordsToFitInWidth(text, 0, text.length, width);
    const line1 = text.slice(0, n1);
    const n2 = font.calculateWordsToFitInWidth(text, n1, text.length - n1, width);
    const line2 = text.slice(n1, n1 + n2);
    const w1 = font.stringWidth(line1);
    const w2 = font.stringWidth(line2);
    if (w2 < w1) {
      super.captionDraw(g);
      return;
    }
    const color = this.captionColorNow();
    const small = this.smallFont;
    small.drawText(g.ctx, line1, g.ox + w2 - w1, g.oy, color);
    small.drawText(g.ctx, line2, g.ox, g.oy + small.height, color);
  }
}

export class WinSubpanelJob extends TSWin {
  private bars: ImageBitmap | null = null;
  private barsOff: ImageBitmap | null = null;
  private titleFont: FfnFont | null = null;
  private careers: Career[] = [];
  /** +0xd4: skill labels; +0xe0: job, salary, performance, friends. */
  private readonly skillBtns: FlashyBtn[] = [];
  private readonly summaryBtns: FlashyBtn[] = [];
  /** STR# 136: title (+0x138), unemployed job / salary / performance (+0x128..), friends format (+0x13c). */
  private title = "";
  private unemployed = "";
  private noSalary = "";
  private noPerformance = "";
  private friendsFormat = "";
  /** cWinPeople+0x150: the Live panel's popup (set by WinPeople); +0x124 this page's client. */
  livePopup: WinLivePopup | null = null;
  private readonly client = new WinLivePopupClient();
  private popupTexts: string[] = [];
  /** +0x16c: kJobPopupComposite, 22 career pictures stacked. */
  private jobComposite: ImageBitmap | null = null;

  constructor(readonly ctx: GameContext) {
    super();
  }

  /** cWinSubpanelJob::Init */
  override async init(): Promise<boolean> {
    const { ctx } = this;
    const [bars, barsOff, font8, font7, titleFont, careers, ...images] = await Promise.all([
      ctx.res.image("kJobSubpanelBars"),
      ctx.res.image("kJobSubBarsOff"),
      ctx.fonts.acquire(8),
      ctx.fonts.acquire(7),
      ctx.fonts.acquire(UI_LANGUAGE === LANG_FRENCH ? 10 : 11),
      loadCareers(ctx.strings),
      ...SUMMARY_IMAGE.map((id) => ctx.res.image(id)),
    ]);
    this.bars = bars;
    this.barsOff = barsOff;
    this.titleFont = titleFont;
    this.careers = careers;
    // kJobPopupComposite (+0x16c) only feeds the summary popup.
    this.setArea(0, 0, 0x1ab, 100);
    const fonts = [font8, font7];

    const labels = ctx.strings.list(LIVE, STR_LABELS);
    if (!labels.length) return super.init();
    this.title = labels[0]!;
    for (let i = 0; i < 6; i++) {
      const btn = new FlashyBtn();
      btn.caption = labels[i + 1] ?? "";
      btn.setArea(SKILL_LABEL_X, SKILL_LABEL_Y[i]!, SKILL_LABEL_X + 0x3e, SKILL_LABEL_Y[i]! + 0x10);
      btn.mode = BTN_TOGGLE;
      btn.textRect = { left: 0, top: 0, right: 0x3e, bottom: 0x10 };
      btn.textAlignment = 2;
      btn.setImageKeepArea(null, 4, 0);
      btn.font = font7;
      this.childAdd(btn);
      this.skillBtns.push(btn);
    }
    this.unemployed = labels[7] ?? "";
    this.noSalary = labels[8] ?? "";
    this.noPerformance = labels[9] ?? "";
    this.friendsFormat = labels[10] ?? "";
    this.popupTexts = ctx.strings.list(LIVE, STR_POPUP);
    this.jobComposite = await ctx.res.image("kJobPopupComposite");

    for (let i = 0; i < 4; i++) {
      const btn = i === 2 ? new PerformanceBtn(font7) : new FlashyBtn();
      const image = images[i]!;
      const [w, h] = SUMMARY_SIZE[i]!;
      const [x, y] = SUMMARY_POS[i]!;
      const font = fonts[SUMMARY_FONT[i]!]!;
      let textLeft = 0;
      let textTop = 0;
      btn.setImageKeepArea(image, 4, i === 0 ? JOB_ICON_ROWS : 1);
      btn.font = font;
      btn.mode = BTN_TOGGLE;
      btn.setArea(x, y, x + w, y + h);
      const prev = this.summaryBtns[this.summaryBtns.length - 1];
      if (i === 0) {
        textTop = Math.trunc(image.height / JOB_ICON_ROWS);
        btn.setArea(x, y, x + w, y + textTop + font.height * 2);
      } else if (i === 3) {
        btn.setArea(x, y, x + w, y + font.height);
        btn.paraText = false;
        if (prev) btn.moveTo(prev.area.left, prev.area.bottom);
      } else {
        textLeft = Math.trunc(image.width / btn.cols) + 3;
        btn.setArea(x, y, x + w, y + font.height);
        if (i === 2) {
          btn.imageX = 0;
          btn.imageY = 0;
          btn.paraText = false;
        } else {
          btn.imageX = 0;
          btn.imageY = Math.trunc((btn.getH() - image.height) / 2);
        }
        if (prev) btn.moveTo(prev.area.left, prev.area.bottom);
      }
      btn.textRect = { left: textLeft, top: textTop, right: w, bottom: i === 2 ? textTop + font.height * 2 : h };
      btn.textAlignment = 0;
      this.childAdd(btn);
      this.summaryBtns.push(btn);
    }
    this.client.setName(this.popupTexts[0] ?? "");
    this.client.setDesc(this.popupTexts[1] ?? "");
    // The client's tag (+0x18, read by Tut_CheckForEvents): "job" (lbl_105BC5D4 + 0x1c).
    this.client.kind = "job";
    return super.init();
  }

  /** The panel repaints from CPState every frame. */
  updateViewFromCPState(): void {
    this.updateSummary(this.ctx.state.personGetSelected());
  }

  /** cWinSubpanelJob::SetQuickTips: the skill labels and summary lines open their popup on hover. */
  setQuickTips(on: boolean): void {
    const timeout = getOptionsMgr().getDefaultAsyncTimeout();
    for (const b of [...this.skillBtns, ...this.summaryBtns]) b.setAsync(on ? ASYNC_ON_ENTER : 0, timeout);
  }

  /**
   * cWinSubpanelJob::TSOnCommand: one skill label (or summary line) at a
   * time shows its popup (0x13, the async timeout, is a click); the second
   * click on the open item closes it, which releases the button.
   */
  override tsOnCommand(cmd: number, source: TSWin): boolean {
    if (cmd === CMD_ASYNC_EXIT) return true;
    const popup = this.livePopup;
    const skill = this.skillBtns.indexOf(source as FlashyBtn);
    if (skill >= 0) {
      this.skillBtns.forEach((b, i) => b.setState(i === skill ? 1 : 0));
      if (popup) {
        popupClick(popup, this.client, this, this.skillBtns[skill]!, () => {
          this.client.setName(this.popupTexts[2 * skill] ?? "");
          this.client.setDesc(this.popupTexts[2 * skill + 1] ?? "");
          this.client.kind = "skill";
          // The skills' object panes (lbl_105BC5C0 GUIDs) are all empty.
          this.client.setBitmap(0, null);
        });
      }
      return true;
    }
    const line = this.summaryBtns.indexOf(source as FlashyBtn);
    if (line >= 0) {
      if (popup) popupClick(popup, this.client, this, this.summaryBtns[line]!, () => this.setupSummaryClient(line));
      return true;
    }
    return super.tsOnCommand(cmd, source);
  }

  /** cWinSubpanelJob::SetupSummaryClient: job, salary, performance or friends line. */
  private setupSummaryClient(line: number): void {
    const p = this.ctx.state.personGetSelected();
    if (!p) return;
    const c = this.client;
    const t = (i: number): string => this.popupTexts[i] ?? "";
    const name = (i: number): string => t(12 + 2 * i);
    const desc = (i: number): string => t(13 + 2 * i);
    const job = this.getJob(p);
    c.setBitmap(1, null);
    // The tag: "job" for the job line, "perf" for the performance, "summary" for the others.
    c.kind = line === 0 ? "job" : line === 2 ? "perf" : "summary";
    if (line === 0) {
      // The career's picture: one of the 22 rows of kJobPopupComposite (row 0 when jobless).
      const comp = this.jobComposite;
      const rowH = comp ? Math.trunc(comp.height / JOB_ICON_ROWS) : 0;
      let row = 0;
      if (!job) {
        c.setName(name(0));
        c.setDesc(desc(0));
      } else {
        const hour = (h: number): string => `${h}:00`;
        const start = job.startHour;
        // cTSLanguageManager::MakeTimeString(hour, 0) of the start, end and carpool ((start + 23) % 24) hours.
        const text = t(POPUP.jobTemplate)
          .replace("$Start", hour(start))
          .replace("$End", hour(job.endHour))
          .replace("$CarTime", hour((start + 23) % 24));
        c.setName(jobName(job, personGender(p) === 1));
        c.setDesc(`${text}\n${job.description}`);
        const id = this.getCareer(p)?.id ?? 0;
        row = id === -1 ? 0xb : id;
      }
      if (comp && row >= 0 && row <= 0x15) c.setBitmap(0, comp, { left: 0, top: row * rowH, right: comp.width, bottom: (row + 1) * rowH });
      else c.setBitmap(0, null);
      return;
    }
    c.setName(name(line));
    c.setBitmap(0, null);
    if (line === 2) {
      if (!job) {
        c.setDesc(t(POPUP.perfJobless));
        return;
      }
      const perf = this.data(p, PD_JOB_PERFORMANCE);
      const step = POPUP_PERF_STEPS.filter((x) => perf >= x).length;
      const top = this.getNextJob(p) === null;
      const texts = [desc(2), t(POPUP.perf1), t(POPUP.perf2), t(POPUP.perf3), t(POPUP.perf4)];
      c.setDesc(top ? t(POPUP.topPerf[step]!) : texts[step]!);
      return;
    }
    if (line === 1 && !job) c.setDesc(t(POPUP.salaryJobless));
    else c.setDesc(desc(line));
  }

  // --- PersonFinder job queries ---------------------------------------------

  private data(p: PersonInfo | null, index: number): number {
    return p?.personData?.[index] ?? 0;
  }

  /** GetJobA's age test (person data 58 < 18); no person data = adult. */
  private isChild(p: PersonInfo): boolean {
    return p.personData !== undefined && this.data(p, PD_AGE) < 0x12;
  }

  /** PersonFinder::GetCareer */
  private getCareer(p: PersonInfo | null): Career | null {
    const type = this.data(p, PD_JOB_TYPE);
    return p && type !== 0 ? careerById(this.careers, type) : null;
  }

  /** PersonFinder::GetJobA: children are on the school track (-1), level 0. */
  private getJob(p: PersonInfo | null): Job | null {
    if (!p) return null;
    let type = this.data(p, PD_JOB_TYPE);
    let level = this.data(p, PD_JOB_LEVEL);
    if (this.isChild(p)) {
      type = -1;
      level = 0;
    }
    if (type === 0) return null;
    return careerById(this.careers, type)?.jobs[level] ?? null;
  }

  /** PersonFinder::GetNextJobInTrack */
  private getNextJob(p: PersonInfo | null): Job | null {
    const type = this.data(p, PD_JOB_TYPE);
    if (!p || type === 0) return null;
    return careerById(this.careers, type)?.jobs[this.data(p, PD_JOB_LEVEL) + 1] ?? null;
  }

  /** PersonFinder::GetSkillNeededToAdvance: the requirement, or 0 once reached. */
  private skillNeeded(p: PersonInfo | null, skill: number): number {
    const next = this.getNextJob(p);
    const req = SKILL_REQ[skill];
    if (!next || req === undefined) return 0;
    const min = next.minimumReq[req] ?? 0;
    return this.data(p, skill) < min ? min : 0;
  }

  /** PersonFinder::GetFriendsNeededToAdvance */
  private friendsNeeded(p: PersonInfo | null): number {
    const next = this.getNextJob(p);
    if (!next) return 0;
    const min = next.minimumReq[JobReq.Friends] ?? 0;
    return this.ctx.state.getFamilyFriendCount() < min ? min : 0;
  }

  /** cJob::GetPerformance */
  private performanceString(perf: number): string {
    let level = 1;
    for (const t of PERFORMANCE_LEVELS) if (perf >= t) level++;
    return this.ctx.strings.get(WORK, STR_PERFORMANCE, level - 1);
  }

  // --- painting ----------------------------------------------------------------

  /** cWinSubpanelJob::SetFriendsNeeded */
  private setFriendsNeeded(needed: number): void {
    const btn = this.summaryBtns[3];
    if (!btn) return;
    if (this.ctx.state.getFamilyFriendCount() < needed) {
      btn.showWindow();
      btn.caption = this.friendsFormat.replace(/%d/, String(needed));
      btn.imageX = (btn.font?.stringWidth(btn.caption) ?? 0) + 3;
      btn.imageY = 2;
    } else {
      btn.hideWindow();
    }
  }

  /** The summary captions (second half of cWinSubpanelJob::TSPaint). */
  private updateSummary(p: PersonInfo | null): void {
    const [jobBtn, salaryBtn, perfBtn] = this.summaryBtns;
    if (!jobBtn || !salaryBtn || !perfBtn) return;
    jobBtn.row = this.getCareer(p)?.id ?? 0;
    if (!p) return;
    const job = this.getJob(p);
    const female = personGender(p) === 1;
    jobBtn.caption = job ? jobShortName(job, female) : this.unemployed;
    salaryBtn.caption = job ? makeMoneyString(job.salary, UI_LANGUAGE) : this.noSalary;
    if (!job) {
      perfBtn.caption = this.noPerformance;
      perfBtn.setFlashing(false);
    } else {
      const perf = this.data(p, PD_JOB_PERFORMANCE);
      perfBtn.caption = this.performanceString(perf);
      perfBtn.setFlashing(perf < 0);
    }
    this.setFriendsNeeded(this.friendsNeeded(p));
  }

  /** cWinSubpanelJob::TSPaint */
  override tsPaint(g: Gfx): void {
    const p = this.ctx.state.personGetSelected();
    const bars = this.bars;
    const barsOff = this.barsOff;
    if (bars && barsOff && p) {
      SKILLS.forEach((skill, i) => {
        const x = BAR_X;
        const y = BAR_Y[i]!;
        const level = Math.min(10, Math.max(0, Math.trunc(this.data(p, skill) / 100)));
        g.blit(barsOff, x, y);
        if (level > 0) {
          const w = level * 4 <= bars.width && level !== 10 ? level * 4 : bars.width;
          g.blitPart(bars, 0, 0, w, bars.height, x, y);
        }
      });
    }
    this.titleFont?.drawText(g.ctx, this.title, g.ox + 0x23, g.oy + 3, UI_FONT_COLOR);
    this.updateSummary(p);
    if (p && bars) {
      SKILLS.forEach((skill, i) => {
        const needed = this.skillNeeded(p, skill);
        const btn = this.skillBtns[i];
        if (btn) btn.underline = needed > 0;
        if (needed <= 0) return;
        // An L under the bar: up at the needed level, back to 15 px left of the bar.
        const n = Math.trunc(needed / 100) * 4;
        const x = BAR_X + n - 1;
        const top = BAR_Y[i]!;
        const bottom = top + bars.height - 1;
        g.fill(x, top, 1, bottom - top + 1, UI_FONT_COLOR);
        g.fill(x - (n + 0xf), bottom, n + 0xf + 1, 1, UI_FONT_COLOR);
      });
    }
  }
}
