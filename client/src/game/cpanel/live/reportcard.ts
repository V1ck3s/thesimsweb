/**
 * Job page of a child (cWinSubpanelReportCard): the page title and the
 * school grade.
 *
 * From the decompiled class (WinSubpanelReportCard.cpp):
 *  - cWinPeople::Init sets the page area before Init (the job page's area);
 *  - Init: Live.iff STR# 0x8b: the title (+0xcc), the popup's name (+0xd0)
 *    and description (+0xd4); one cFlashyBtn (+0xd8), font table entry 18
 *    (lbl_105BA2E8 + 0x48), no image (SetImage(0, 4, 0)), toggled on press
 *    and firing on press (+0xf0 = 2, +0xec = 1), as wide as the page and one
 *    font line high, centered vertically; its popup client (+0xe0) shows the
 *    school picture of the job page's kJobPopupComposite
 *    (cWinSubpanelJob::GetJobPopupComposite(0xb));
 *  - TSPaint: the title at the window's origin in font table entry 10
 *    (5 px lower in a double-byte UI); the caption is
 *    cJob::GetGrade(PersonFinder::GetJobPerformance(selected)) (for a
 *    child, person data 57) and blinks (cFlashyBtn timer, 0x14d ms) from
 *    grade 10 on (the failing grades); without a job (PersonFinder::GetJobA)
 *    the caption is the literal "No cJob Object!";
 *  - TSOnCommand: the button toggles the popup; 0x13 (quick tips timeout)
 *    is a click.
 */

import type { PersonInfo } from "../../cpstate.js";
import type { GameContext } from "../../context.js";
import type { FfnFont } from "../../res/ffn.js";
import { getOptionsMgr } from "../../optionsmgr.js";
import { getGrade, loadJobGrades } from "../../sim/careers.js";
import { ASYNC_ON_ENTER, BTN_TOGGLE_ON_DOWN, CMD_ASYNC_EXIT } from "../../ui/btn.js";
import { UI_FONT_COLOR } from "../../ui/syscolors.js";
import { Gfx, TSWin } from "../../ui/tswin.js";
import { popupClick, type WinLivePopup, WinLivePopupClient } from "../livepopup.js";
import { careerById, loadCareers, type Career, type Job } from "./careers.js";
import { FlashyBtn } from "./job.js";

const LIVE = "Live";
/** LoadUIStrings(0x8b): title, popup name, popup description. */
const STR_REPORT_CARD = 0x8b;
const TITLE_FONT = 10;
const GRADE_FONT = 18;
/** GetJobPopupComposite(0xb): the school row of kJobPopupComposite (22 rows). */
const SCHOOL_ROW = 0xb;
const JOB_ICON_ROWS = 0x16;
/** TSPaint: grades from this one on blink. */
const FLASH_GRADE = 10;
/** lbl_105BC5D8: the caption without a cJob. */
const NO_JOB = "No cJob Object!";

const PD_JOB_TYPE = 56;
const PD_JOB_LEVEL = 57;
const PD_AGE = 58;

export class WinSubpanelReportCard extends TSWin {
  private titleFont: FfnFont | null = null;
  private careers: Career[] = [];
  private grades: string[] = [];
  /** +0xcc / +0xd0 / +0xd4 */
  private title = "";
  /** +0xd8 */
  private btn: FlashyBtn | null = null;
  /** +0xe0 */
  private readonly client = new WinLivePopupClient();
  /** cWinPeople+0x150: the Live panel's popup (set by WinPeople). */
  livePopup: WinLivePopup | null = null;

  constructor(readonly ctx: GameContext) {
    super();
  }

  /** cWinSubpanelReportCard::Init */
  override async init(): Promise<boolean> {
    const { ctx } = this;
    const [titleFont, gradeFont, careers, grades, composite] = await Promise.all([
      ctx.fonts.acquire(TITLE_FONT),
      ctx.fonts.acquire(GRADE_FONT),
      loadCareers(ctx.strings),
      loadJobGrades(),
      ctx.res.image("kJobPopupComposite"),
    ]);
    this.titleFont = titleFont;
    this.careers = careers;
    this.grades = grades;
    const strs = ctx.strings.list(LIVE, STR_REPORT_CARD);
    this.title = strs[0] ?? "";

    const btn = new FlashyBtn();
    this.childAdd(btn);
    btn.font = gradeFont;
    btn.setImageKeepArea(null, 4, 0);
    btn.mode = BTN_TOGGLE_ON_DOWN;
    btn.sendOnDown = true;
    const h = gradeFont.height;
    const top = Math.trunc((this.getH() - h) / 2);
    btn.setArea(0, top, this.getW(), top + h);
    this.btn = btn;

    this.client.setName(strs[1] ?? "");
    this.client.setDesc(strs[2] ?? "");
    const rowH = Math.trunc(composite.height / JOB_ICON_ROWS);
    this.client.setBitmap(0, composite, { left: 0, top: SCHOOL_ROW * rowH, right: composite.width, bottom: (SCHOOL_ROW + 1) * rowH });
    return super.init();
  }

  /** cWinSubpanelReportCard::SetQuickTips */
  setQuickTips(on: boolean): void {
    this.btn?.setAsync(on ? ASYNC_ON_ENTER : 0, getOptionsMgr().getDefaultAsyncTimeout());
  }

  /** cWinSubpanelReportCard::TSOnCommand */
  override tsOnCommand(cmd: number, source: TSWin): boolean {
    if (cmd === CMD_ASYNC_EXIT) return true;
    if (source !== this.btn || !this.btn) return super.tsOnCommand(cmd, source);
    if (this.livePopup) popupClick(this.livePopup, this.client, this, this.btn);
    return true;
  }

  /** PersonFinder::GetJobA: a child is on the school track (-1), level 0. */
  private getJob(p: PersonInfo): Job | null {
    const data = p.personData;
    let type = data?.[PD_JOB_TYPE] ?? 0;
    let level = data?.[PD_JOB_LEVEL] ?? 0;
    if (data && (data[PD_AGE] ?? 0) < 0x12) {
      type = -1;
      level = 0;
    }
    if (type === 0) return null;
    return careerById(this.careers, type)?.jobs[level] ?? null;
  }

  /** cWinSubpanelReportCard::TSPaint */
  override tsPaint(g: Gfx): void {
    this.titleFont?.drawText(g.ctx, this.title, g.ox, g.oy, UI_FONT_COLOR);
    const btn = this.btn;
    const p = this.ctx.state.personGetSelected();
    if (!btn || !p) return;
    let caption = NO_JOB;
    if (this.getJob(p)) {
      // PersonFinder::GetJobPerformance: a child's is person data 57.
      const perf = p.personData?.[PD_JOB_LEVEL] ?? 0;
      caption = getGrade(this.grades, perf);
      btn.setFlashing(perf >= FLASH_GRADE);
    }
    btn.caption = caption;
  }
}
