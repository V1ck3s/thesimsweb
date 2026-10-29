/**
 * cWinBudgetDlg / cWinBudgetRow: the budget window the view control's funds
 * button opens on a residential lot (cWinViewControl::TSOnCommand, run with
 * cSimsApp::DoSimsModalDialog while the simulation is blocked).
 *
 * From the decompiled classes (WinBudgetDlg.cpp, winbudgetrow.cpp):
 *  - Init: House::PrepareForBudgetWindow; a private buffer; the popup tiles
 *    (kCatalogPopupBackTiles) drawn as a frame (cTSBuffer::BltEdge, cells of
 *    a third of the bitmap, center filled: TSPaint); the OK button is
 *    kBudgetOK (4 frames), font TSAcquireFont(1, 20), caption offset by
 *    (2, 2) when pressed (SetCustomTextOffsets);
 *  - 20 cWinBudgetRows, indents and fonts from lbl_105BA980 / lbl_105BA97C
 *    (global font table entries 16, 10, 12 and 9); each row is as high as
 *    its font; the first goes to the position of UIText STR# 146 entry 0,
 *    each next one just below the previous one;
 *  - STR# 146 "budget" in order: 0 the rows' origin, 1 the right / bottom
 *    margins, 2 the OK label, 3 the title (row 0, centered), 4 / 5 the column
 *    headers (row 1), then label / tooltip pairs for rows 2..15 except 5 and
 *    14 (blank), then format / tooltip pairs for row 17 (funds), 19 (days
 *    since moving in) and 18 (net worth), those three centered;
 *  - the values: cSimulator::GetTodaysExpenses / GetExpensesHistory per
 *    ExpenseType (0 misc expenses, 1 job, 2 misc income, 3 food, 4 bills,
 *    5 services, 6 household items, 7 architecture), row 15 the sums; the
 *    section rows 2, 6, 10 get empty texts; SetCurValue / Set3DayValue store
 *    the negated amount (spending shows negative) as a money string;
 *  - cWinBudgetRow::ComputeWidths / SetWidths: three columns as wide as the
 *    widest caption (plus 12 per indent), 3-day and today texts of all
 *    rows; TSPaint draws the caption at indent * 12 + 30, the 3-day value at
 *    w1 + 60 and today's at w1 + w2 + 90, a negative value in red
 *    (lbl_105BA7B8); a row with a format string draws it with its value,
 *    centered; a centered row draws its caption centered;
 *  - the window is 40 (entry 1 x) wider than row 3 and 100 (entry 1 y)
 *    taller than the last row; the OK button is centered horizontally and
 *    vertically in that bottom margin;
 *  - Escape, Return or the OK button end the dialog (message 0x10).
 *
 * The caller centers the window in the main window.
 */

import type { GameContext } from "../context.js";
import type { FfnFont } from "../res/ffn.js";
import { LANG_FRENCH } from "../res/uires.js";
import { TSWinBtn } from "../ui/btn.js";
import { bltEdge, TSWinDlg } from "../ui/dlg.js";
import { hiliteColor, rgb, UI_FONT_COLOR } from "../ui/syscolors.js";
import { Gfx, TSWin } from "../ui/tswin.js";
import { makeMoneyString } from "./viewcontrol.js";

/** UIText STR# 146 (LoadUIStrings(0x92)). */
const STR_BUDGET = 0x92;
/** lbl_105BA980: each row's indent (12 px per step). */
const ROW_INDENTS = [0, 0, 0, 1, 1, 0, 0, 1, 1, 1, 1, 2, 2, 1, 0, 0, 0, 0, 0, 0] as const;
/** lbl_105BA97C: each row's font, entries of the global font table (lbl_105BA2E8). */
const ROW_FONTS = [16, 10, 12, 10, 10, 10, 12, 10, 10, 10, 10, 9, 9, 10, 10, 12, 12, 10, 10, 10] as const;
const ROW_COUNT = 20;
/** Rows Init leaves without a label (the loop over 2..15 skips them). */
const BLANK_ROWS = [5, 14];
/** cWinBudgetRow::SetIndent step and TSPaint's column offsets. */
const INDENT_STEP = 0xc;
const CAPTION_X = 0x1e;
const COL_3DAY_X = 0x3c;
const COL_TODAY_X = 0x5a;
/** cWinBudgetRow::SetWidths: the extra width beyond the three columns. */
const ROW_EXTRA_W = 0x78;
/** The rows' initial width (Init's SetArea). */
const ROW_INIT_W = 0x1cc;
/** lbl_105BA7B8 (InitSimsColors' red). */
const NEGATIVE_COLOR = rgb(0xd1, 0, 0);
/** TSAcquireFont(1, 0x14, 0, 0): the OK button's font. */
const OK_FONT_SIZE = 0x14;
/** SetCustomTextOffsets: the caption moves by (2, 2) in frame 1. */
const OK_TEXT_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [2, 2],
  [0, 0],
  [0, 0],
];

/** Rows of cWinBudgetDlg+0xd4.. used by Init. */
const enum Row {
  Title = 0,
  Header = 1,
  Income = 2,
  Job = 3,
  MiscIncome = 4,
  Expenses = 6,
  Bills = 7,
  Food = 8,
  Services = 9,
  Purchases = 10,
  Household = 11,
  Arch = 12,
  MiscExpenses = 13,
  Total = 15,
  Funds = 17,
  NetWorth = 18,
  Days = 19,
}

/** ExpenseType of each value row (cWinBudgetDlg::Init's Set3DayValue / SetCurValue pairs). */
const EXPENSE_ROWS: ReadonlyArray<readonly [Row, number]> = [
  [Row.Job, 1],
  [Row.MiscIncome, 2],
  [Row.Bills, 4],
  [Row.Food, 3],
  [Row.Services, 5],
  [Row.Household, 6],
  [Row.Arch, 7],
  [Row.MiscExpenses, 0],
];

/**
 * What the window reads from the lot (lbl_105B9CD4: the house, its
 * simulator and family); the lot view fills it.
 */
export interface BudgetSource {
  /** House::PrepareForBudgetWindow (the object and architecture values the net worth uses). */
  prepareForBudgetWindow(): Promise<void>;
  /** cSimulator::GetTodaysExpenses: 8 amounts by ExpenseType. */
  getTodaysExpenses(): number[];
  /** cSimulator::GetExpensesHistory: 8 amounts by ExpenseType. */
  getExpensesHistory(): number[];
  /** cSimulator::GetFunds */
  getFunds(): number;
  /** cSimulator::GetDaysRunning */
  getDaysRunning(): number;
  /** Family::GetNetWorth (Neighborhood::GetFamilyNetWorth) of the house's family. */
  getNetWorth(): number;
}

/** cTSLanguageUtility::MakeMoneyString as the window calls it. */
function money(amount: number): string {
  return makeMoneyString(amount, LANG_FRENCH);
}

export class WinBudgetRow extends TSWin {
  /** +0xcc / +0xd0: the negated 3-day and today values (red below 0). */
  private value3Day = 0;
  private valueCur = 0;
  /** +0xd4 */
  private indent = 0;
  /** +0xd8 */
  private font: FfnFont | null = null;
  /** +0xe0 / +0xe4: the first two columns' widths (SetWidths; +0xe8, the third, only sizes the row). */
  private w1 = 0;
  private w2 = 0;
  /** +0xec / +0xf0 */
  private text3Day = "";
  private textCur = "";
  /** +0xf4: the caption (or the format) is centered and the columns are not drawn. */
  centered = false;
  /** +0xf8 / +0xfc: a format string ("%s") and its value. */
  format = "";
  formatValue = "";
  caption = "";

  /** cWinBudgetRow::SetIndent */
  setIndent(n: number): void {
    this.indent = n;
  }

  /** cWinBudgetRow::SetFont: the row is as high as the font. */
  setFont(font: FfnFont): void {
    this.font = font;
    this.setArea(this.area.left, this.area.top, this.area.right, this.area.top + font.height);
  }

  /** cWinBudgetRow::Set3DayText */
  set3DayText(text: string): void {
    this.text3Day = text;
  }

  /** cWinBudgetRow::SetCurText */
  setCurText(text: string): void {
    this.textCur = text;
  }

  /** cWinBudgetRow::Set3DayValue */
  set3DayValue(v: number): void {
    this.value3Day = -v | 0;
    this.text3Day = money(this.value3Day);
  }

  /** cWinBudgetRow::SetCurValue */
  setCurValue(v: number): void {
    this.valueCur = -v | 0;
    this.textCur = money(this.valueCur);
  }

  /** cWinBudgetRow::ComputeWidths: [caption + indent, 3-day text, today text]; 0 for a centered row. */
  computeWidths(): [number, number, number] {
    const f = this.font;
    if (this.centered || !f) return [0, 0, 0];
    return [this.indent * INDENT_STEP + f.stringWidth(this.caption), f.stringWidth(this.text3Day), f.stringWidth(this.textCur)];
  }

  /** cWinBudgetRow::SetWidths */
  setWidths(w1: number, w2: number, w3: number): void {
    this.w1 = w1;
    this.w2 = w2;
    this.setArea(this.area.left, this.area.top, w1 + w2 + w3 + this.area.left + ROW_EXTRA_W, this.area.bottom);
  }

  /** cWinBudgetRow::TSPaint (drawn into the dialog's buffer). */
  override tsPaint(g: Gfx): void {
    const f = this.font;
    if (!f) return;
    if (this.format) {
      const text = this.format.replace("%s", this.formatValue);
      f.drawText(g.ctx, text, g.ox + Math.trunc((this.getW() - f.stringWidth(text)) / 2), g.oy, UI_FONT_COLOR);
      return;
    }
    if (this.centered) {
      f.drawText(g.ctx, this.caption, g.ox + Math.trunc((this.getW() - f.stringWidth(this.caption)) / 2), g.oy, UI_FONT_COLOR);
      return;
    }
    if (this.caption) f.drawText(g.ctx, this.caption, g.ox + this.indent * INDENT_STEP + CAPTION_X, g.oy, UI_FONT_COLOR);
    if (this.text3Day) f.drawText(g.ctx, this.text3Day, g.ox + this.w1 + COL_3DAY_X, g.oy, this.value3Day < 0 ? NEGATIVE_COLOR : UI_FONT_COLOR);
    if (this.textCur) f.drawText(g.ctx, this.textCur, g.ox + this.w1 + this.w2 + COL_TODAY_X, g.oy, this.valueCur < 0 ? NEGATIVE_COLOR : UI_FONT_COLOR);
  }
}

/** The OK button: kBudgetOK with the caption offset by (2, 2) while pressed. */
class BudgetOKButton extends TSWinBtn {
  override tsPaint(g: Gfx): void {
    if (this.image) g.blitPart(this.image, this.frameColumn() * this.getW(), 0, this.getW(), this.getH(), 0, 0);
    const f = this.font;
    if (!f || !this.caption) return;
    const col = this.frameColumn();
    const [dx, dy] = OK_TEXT_OFFSETS[col] ?? [0, 0];
    const x = ((this.getW() - f.stringWidth(this.caption)) >> 1) + dx;
    const y = ((this.getH() - f.height) >> 1) + dy;
    f.drawText(g.ctx, this.caption, g.ox + x, g.oy + y, hiliteColor(4, col));
  }
}

export class WinBudgetDlg extends TSWinDlg {
  /** The lot's data; without it the window shows zeros and CPState's funds. */
  static source: BudgetSource | null = null;
  /** +0xcc */
  private tiles: ImageBitmap | null = null;
  /** +0xd0 */
  private ok: BudgetOKButton | null = null;
  /** +0xd4..+0x120 */
  private readonly rows: WinBudgetRow[] = [];

  constructor(private readonly ctx: GameContext) {
    super();
  }

  /** cWinBudgetDlg::Init */
  override async init(): Promise<boolean> {
    const { ctx } = this;
    const src = WinBudgetDlg.source;
    await src?.prepareForBudgetWindow();
    this.tiles = await ctx.res.image("kCatalogPopupBackTiles");
    const { left, top } = this.area;
    this.setArea(left, top, left + 100, top + 100);

    const ok = new BudgetOKButton(1, await ctx.res.image("kBudgetOK"), 4, 1);
    ok.font = await ctx.fonts.acquire(OK_FONT_SIZE);
    ok.moveTo((this.getW() - ok.getW()) >> 1, this.getH() - ok.getH());
    this.childAdd(ok);
    this.ok = ok;

    let cell = 0;
    for (let i = 0; i < ROW_COUNT; i++) {
      const row = new WinBudgetRow();
      this.childAdd(row);
      row.setIndent(ROW_INDENTS[i]!);
      row.setArea(row.area.left, row.area.top, row.area.left + ROW_INIT_W, row.area.top);
      row.setFont(await ctx.fonts.acquire(ROW_FONTS[i]!));
      cell = Math.max(cell, row.getH());
      this.rows.push(row);
    }

    const s = (i: number): string => ctx.strings.get("UIText", STR_BUDGET, i);
    const origin = parsePoint(s(0));
    const margin = parsePoint(s(1));
    // The column layout (one cell per row), then each row under the previous one at its own height.
    this.rows.forEach((r, i) => r.moveTo(origin.x, origin.y + i * cell));
    for (let i = 1; i < ROW_COUNT; i++) {
      const prev = this.rows[i - 1]!;
      const r = this.rows[i]!;
      r.setArea(prev.area.left, prev.area.bottom, prev.area.left + r.getW(), prev.area.bottom + r.getH());
    }
    const row = (r: Row): WinBudgetRow => this.rows[r]!;
    let k = 2;
    ok.caption = s(k++);
    row(Row.Title).caption = s(k++);
    row(Row.Title).centered = true;
    row(Row.Header).set3DayText(s(k++));
    row(Row.Header).setCurText(s(k++));
    for (let i = 2; i < 0x10; i++) {
      if (BLANK_ROWS.includes(i)) continue;
      this.rows[i]!.caption = s(k++);
      this.rows[i]!.tooltip = s(k++);
    }
    for (const r of [Row.Funds, Row.Days, Row.NetWorth]) {
      row(r).format = s(k++);
      row(r).centered = true;
      row(r).tooltip = s(k++);
    }

    const today = src?.getTodaysExpenses() ?? new Array<number>(8).fill(0);
    const history = src?.getExpensesHistory() ?? new Array<number>(8).fill(0);
    for (const [r, type] of EXPENSE_ROWS) {
      row(r).set3DayValue(history[type] ?? 0);
      row(r).setCurValue(today[type] ?? 0);
    }
    const sum = (a: number[]): number => a.reduce((t, v) => (t + v) | 0, 0);
    row(Row.Total).set3DayValue(sum(history));
    row(Row.Total).setCurValue(sum(today));
    for (const r of [Row.Income, Row.Expenses, Row.Purchases]) {
      row(r).set3DayText("");
      row(r).setCurText("");
    }
    row(Row.Funds).formatValue = money(src ? src.getFunds() : ctx.state.getFunds());
    row(Row.Days).formatValue = String(src?.getDaysRunning() ?? 0);
    row(Row.NetWorth).formatValue = money(src?.getNetWorth() ?? 0);

    const widths = [0, 0, 0];
    for (const r of this.rows) r.computeWidths().forEach((w, i) => (widths[i] = Math.max(widths[i]!, w)));
    for (const r of this.rows) r.setWidths(widths[0]!, widths[1]!, widths[2]!);

    const w = margin.x + row(Row.Job).area.right;
    const h = margin.y + row(Row.Days).area.bottom;
    this.setArea(this.area.left, this.area.top, this.area.left + w, this.area.top + h);
    const okTop = h - margin.y + Math.trunc((margin.y - ok.getH()) / 2);
    ok.moveTo(Math.trunc((w - ok.getW()) / 2), okTop);
    return true;
  }

  /** cWinBudgetDlg::TSPaint: the tiles as a frame, center filled. */
  override tsPaint(g: Gfx): void {
    const t = this.tiles;
    if (t) bltEdge(g, t, Math.trunc(t.width / 3), Math.trunc(t.height / 3), this.getW(), this.getH(), true);
  }

  /** cWinBudgetDlg::TSOnKeyDown: Escape and Return press OK. */
  override tsOnKeyDown(key: string): boolean {
    if ((key === "Escape" || key === "Enter") && this.ok) return this.tsOnCommand(1, this.ok);
    return super.tsOnKeyDown(key);
  }

  /** cWinBudgetDlg::TSOnCommand: command 1 from the OK button ends the dialog (0x10). */
  override tsOnCommand(cmd: number, src: TSWin): boolean {
    if (cmd === 1) {
      if (src === this.ok) this.tsEndDialog(0);
      return true;
    }
    return super.tsOnCommand(cmd, src);
  }
}

/** StringPosToPoint: "(x;y)". */
function parsePoint(s: string): { x: number; y: number } {
  const m = /\((-?\d+);(-?\d+)\)/.exec(s);
  return m ? { x: parseInt(m[1]!, 10), y: parseInt(m[2]!, 10) } : { x: 0, y: 0 };
}
