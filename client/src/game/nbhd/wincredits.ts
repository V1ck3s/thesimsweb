/**
 * cWinCredits: the scrolling credits opened by the neighborhood's credits
 * button and Sims logo (and by cSimsApp::Quit when it is already open).
 *
 * From the decompiled class (WinCredits.cpp, Credit.cpp):
 *  - Init (cTSWinGenDlg style 0): a private buffer; the popup tiles
 *    (kCatalogPopupBackTiles); an OK button (cTSWinMsgBox::GetButtonLabel(3),
 *    cTSWinCtrlMgr default push button, id 0) centered horizontally, 20 px
 *    above the bottom; two bands: the top one (16, 100)-(w - 16, 140) where
 *    the credits fade out, the bottom one (16, h - 200)-(w - 16, h - 160) where
 *    they appear; the credit text font is entry 14 of the global font table;
 *    the clock starts 1 s after opening; the credits are the STR# of
 *    GameData/Credits.iff, one set per installed pack, newest first: 171
 *    Makin' Magic (0x80), 170 Superstar (0x40), 169 Unleashed (0x20), 167
 *    Vacation (8), 166 Hot Date (4), 165 House Party (2), then 168 Deluxe when
 *    0x10 is set, else 164 Livin' Large (1) and 163 the base game
 *    (InsertMacCredits adds nothing on Windows);
 *  - AddCredits: every line of every entry (split at CR / LF) is one Credit,
 *    a single text line (wrap width 32000) whose box is the line's width x the
 *    font height, placed centered horizontally on the bottom band's top; each
 *    starts 750 ms after the previous one; an entry ending with CR LF adds an
 *    empty credit;
 *  - Credit states: 0 waiting for its start time, 1 fading in (400 ms ramp
 *    0 -> 1), 2 rising with the scroll until its top reaches the top band
 *    (then clamped there), 3 fading out (400 ms ramp 1 -> 0), 4 gone
 *    (removed); 1 -> 2 when the ramp ends or 400 ms after the start;
 *  - TSPaint: the clock (Credit::GetCurTime) advances at most 50 ms per
 *    frame; the scroll offset is -(int)(0.035 * (now - start) + 0.5) (35 px
 *    per second). On the first frame, or after a 200 ms pause, the whole
 *    window is repainted with the tiles as a frame (cTSBuffer::BltEdge, cells
 *    of a third of the bitmap, center filled) and the background color is
 *    sampled from the buffer at (tiles width, tiles
 *    height); otherwise the screen between the bands' tops and bottoms is
 *    scrolled up by the offset delta (AnimDevice::ScrollPrimaryAsync) and the
 *    two bands are filled with the background color. Then every credit ticks
 *    and draws: fading credits blend the background color into the UI font
 *    color by the ramp, rising ones blend the UI font color toward white by a
 *    triangle of their height (0 at the bottom band, 1 halfway, 0 at the top
 *    band). With no credit left the dialog closes itself;
 *  - Escape, Return or any command close it (message 0x10).
 *
 * The caller plays the credits music and restores the neighborhood music;
 * neither Init nor Shutdown touches the sound.
 *
 * Nothing to port, with the reasons:
 *  - the AnimDevice "cadence": Init sets the 3D device's +0x70 (Windows
 *    +0x60) to 100, ShowWindow to 30, HideWindow / Shutdown back to 0. On
 *    Windows that value only feeds the present timer (FUN_005c8b39, called
 *    before each blit / flip with it): a new nonzero value sets its period to
 *    1 000 000 / value us, and the call returns the milliseconds left in the
 *    period, which every caller drops; nothing waits on it. The Mac
 *    AnimDevice never reads +0x70. The credits' pace comes from
 *    Credit::GetCurTime (50 ms steps at most) and the 35 px / s scroll,
 *    both ported;
 *  - the fill after AnimDevice::ScrollPrimaryAsync when the device is page
 *    flipping (IsFlipping): the private buffer's scrolled area (x 20 ..
 *    w - 20) is filled with the background color because the scroll went to
 *    the primary surface, not to the back buffer that the next flip shows.
 *    Here the window's own buffer is the picture that is scrolled and shown;
 *    there is no second page to repair.
 */

import type { GameContext } from "../context.js";
import type { FfnFont } from "../res/ffn.js";
import { TSWinBtn } from "../ui/btn.js";
import { TSWinCtrlMgr } from "../ui/ctrlmgr.js";
import { GENDLG_EDGE, TSWinGenDlg } from "../ui/gendlg.js";
import { TSSystemButton } from "../ui/systembutton.js";
import { bltEdge } from "../ui/dlg.js";
import { Gfx, type Rect, type TSWin } from "../ui/tswin.js";
import { ObjectFolder } from "../world/objectfolder.js";

/** lbl_105BC3DC */
const K_HALF = 0.5;
const K_ONE = 1.0;
const K_ZERO = 0.0;
const K_255 = 255.0;
const K_TWO = 2.0;
const K_MINUS_TWO = -2.0;
/** lbl_105BAA5C: scroll speed (px / ms). */
const SCROLL_SPEED = 0.035;
const FADE_MS = 400;
const CREDIT_SPACING_MS = 0x2ee;
const START_DELAY_MS = 1000;
const MAX_STEP_MS = 50;
const REPAINT_GAP_MS = 200;
/** Entry 14 of the global font table (lbl_105BA2E8 + 0x38). */
const CREDIT_FONT_SIZE = 14;
/** UIText STR# 152 entry 0: the OK label (cTSWinMsgBox::GetButtonLabel(3)). */
const LABELS_STR = 152;
/** Text color (lbl_105BA6F8, UI_FONT_COLOR). */
const TEXT_RGB: [number, number, number] = [0xc3, 0xcd, 0xcd];
const WHITE_RGB: [number, number, number] = [0xff, 0xff, 0xff];

/** Credits.iff STR# per pack bit, in Init's order. */
const PACK_CREDITS: ReadonlyArray<readonly [number, number]> = [
  [0x80, 171],
  [0x40, 170],
  [0x20, 169],
  [8, 167],
  [4, 166],
  [2, 165],
];

const enum CreditState {
  Waiting = 0,
  FadingIn = 1,
  Rising = 2,
  FadingOut = 3,
  Gone = 4,
}

interface Credit {
  state: CreditState;
  text: string;
  /** +8: the box (left, top, right, bottom), window coordinates. */
  rect: Rect;
  /** RampGenerator at +0x28: from -> to over [start, end]. */
  rampFrom: number;
  rampTo: number;
  rampStart: number;
  rampEnd: number;
  /** +0x3c: when the credit starts (clock ms). */
  startTime: number;
}

function blend(a: [number, number, number], b: [number, number, number], t: number): string {
  const k = Math.min(1, Math.max(0, t / 255));
  const c = (i: number): number => Math.round(a[i]! + (b[i]! - a[i]!) * k);
  return `rgb(${c(0)},${c(1)},${c(2)})`;
}

export class WinCredits extends TSWinGenDlg {
  private tiles: ImageBitmap | null = null;
  private font: FfnFont | null = null;
  private credits: Credit[] = [];
  /** +0x110 / +0x120: the top and bottom bands. */
  private topBand: Rect = { left: 0, top: 0, right: 0, bottom: 0 };
  private bottomBand: Rect = { left: 0, top: 0, right: 0, bottom: 0 };
  /** +0x148: the scroll start time. */
  private scrollStart = 0;
  /** +0x14c: the last paint's clock. */
  private lastPaint = 0;
  /** +0x150: the scroll offset. */
  private offset = 0;
  /** +0x144: repaint everything on the next frame. */
  private fullRepaint = true;
  /** lbl_105BAA54: Credit::GetCurTime's clock. */
  private clock = 0;
  private bkgColor: [number, number, number] = [0, 0, 0];
  private buffer: HTMLCanvasElement | null = null;
  private closed = false;

  constructor(ctx: GameContext) {
    super(ctx, GENDLG_EDGE);
  }

  override async init(): Promise<boolean> {
    if (!(await super.init())) return false;
    const { ctx } = this;
    this.tiles = await ctx.res.image("kCatalogPopupBackTiles");
    this.font = await ctx.fonts.acquire(CREDIT_FONT_SIZE);
    const mgr = await TSWinCtrlMgr.get(ctx);
    const w = this.getW();
    const h = this.getH();
    const ok = TSSystemButton.defaultPushBtn(mgr, 0, ctx.strings.get("UIText", LABELS_STR, 0));
    this.childAdd(ok);
    ok.moveTo(Math.trunc((w - ok.getW()) / 2), h - ok.getH() - 0x14);
    this.topBand = { left: 0x10, top: 100, right: w - 0x10, bottom: 0x8c };
    this.bottomBand = { left: 0x10, top: h - 200, right: w - 0x10, bottom: h - 0xa0 };

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    this.buffer = canvas;

    await ctx.strings.load("GameData/Credits.iff");
    const packs = (await ObjectFolder.get()).packs;
    const now = performance.now();
    let start = now + START_DELAY_MS;
    this.scrollStart = start;
    const add = (id: number): void => {
      for (const entry of ctx.strings.list("Credits", id)) start = this.addCredits(start, entry);
    };
    for (const [bit, id] of PACK_CREDITS) if (packs & bit) add(id);
    if (packs & 0x10) add(168);
    else {
      if (packs & 1) add(164);
      add(163);
    }
    return true;
  }

  /** cWinCredits::AddCredits (one string of the set). */
  private addCredits(start: number, entry: string): number {
    const lines = entry.split(/[\r\n]/);
    // The NULs left by the line ends separate the credits; runs of them are skipped.
    let first = true;
    for (const line of lines) {
      if (!first && line === "") continue;
      first = false;
      this.pushCredit(start, line);
      start += CREDIT_SPACING_MS;
    }
    if (entry.length > 1 && entry.endsWith("\r\n")) {
      this.pushCredit(start, "");
      start += CREDIT_SPACING_MS;
    }
    return start;
  }

  private pushCredit(start: number, text: string): void {
    const font = this.font!;
    const w = text ? font.stringWidth(text) : 0;
    const h = text ? font.height : 0;
    const left = this.bottomBand.left + Math.trunc((this.bottomBand.right - this.bottomBand.left - w) / 2);
    const top = this.bottomBand.top;
    this.credits.push({
      state: CreditState.Waiting,
      text,
      rect: { left, top, right: left + w, bottom: top + h },
      rampFrom: K_ZERO,
      rampTo: K_ZERO,
      rampStart: 0,
      rampEnd: 0,
      startTime: start,
    });
  }

  /** Credit::SetState */
  private setState(c: Credit, state: CreditState, now: number): void {
    c.state = state;
    if (state === CreditState.FadingIn || state === CreditState.FadingOut) {
      c.rampFrom = state === CreditState.FadingIn ? K_ZERO : K_ONE;
      c.rampTo = state === CreditState.FadingIn ? K_ONE : K_ZERO;
      c.rampStart = now;
      c.rampEnd = now + FADE_MS;
    }
  }

  private rampValue(c: Credit, now: number): number {
    if (now >= c.rampEnd) return c.rampTo;
    if (now <= c.rampStart) return c.rampFrom;
    return c.rampFrom + ((c.rampTo - c.rampFrom) * (now - c.rampStart)) / (c.rampEnd - c.rampStart);
  }

  /** Credit::Tick: false once the credit is gone. */
  private tick(c: Credit, clock: number, delta: number, now: number): boolean {
    if (c.state === CreditState.Rising) {
      c.rect.top += delta;
      c.rect.bottom += delta;
      if (c.rect.top <= this.topBand.top) {
        c.rect.bottom = this.topBand.top + (c.rect.bottom - c.rect.top);
        c.rect.top = this.topBand.top;
        this.setState(c, CreditState.FadingOut, now);
      }
    } else if (c.state === CreditState.Waiting) {
      if (c.startTime <= clock) this.setState(c, CreditState.FadingIn, now);
      return true;
    } else if (c.state === CreditState.FadingIn) {
      if (c.rampEnd <= now || c.startTime + FADE_MS <= clock) this.setState(c, CreditState.Rising, now);
    }
    if (c.state === CreditState.FadingOut && c.rampEnd <= now) {
      this.setState(c, CreditState.Gone, now);
      return false;
    }
    return true;
  }

  /** Credit::Draw: `t` is the credit's height between the bands (0 bottom, 1 top). */
  private draw(c: Credit, ctx: CanvasRenderingContext2D, t: number, now: number): void {
    if (c.rect.left >= c.rect.right || c.rect.top >= c.rect.bottom || c.state === CreditState.Waiting) return;
    let color: string;
    if (c.state === CreditState.Rising) {
      const a = t > K_HALF ? K_255 * (K_MINUS_TWO * t + K_TWO) + K_HALF : K_255 * (K_TWO * t) + K_HALF;
      color = blend(TEXT_RGB, WHITE_RGB, Math.trunc(a));
    } else {
      color = blend(this.bkgColor, TEXT_RGB, Math.trunc(K_255 * this.rampValue(c, now) + K_HALF));
    }
    this.font!.drawText(ctx, c.text, c.rect.left, c.rect.top, color);
  }

  /** Credit::GetCurTime */
  private curTime(now: number): number {
    if (this.clock === 0 || now - this.clock < MAX_STEP_MS + 1) this.clock = now;
    else this.clock += MAX_STEP_MS;
    return this.clock;
  }

  private scrollOffset(clock: number): number {
    const elapsed = clock - this.scrollStart;
    return elapsed < 0 ? this.offset : -Math.trunc(SCROLL_SPEED * elapsed + K_HALF);
  }

  override tsPaint(g: Gfx): void {
    const buf = this.buffer;
    const tiles = this.tiles;
    if (!buf || !tiles || this.closed) return;
    const bctx = buf.getContext("2d", { willReadFrequently: true })!;
    const w = this.getW();
    const h = this.getH();
    const now = performance.now();
    const clock = this.curTime(now);
    let full = this.fullRepaint;
    let delta = 0;
    if (!full) {
      const last = this.lastPaint;
      this.lastPaint = clock;
      if (clock - last < REPAINT_GAP_MS) {
        const prev = this.offset;
        this.offset = this.scrollOffset(clock);
        delta = this.offset - prev;
        // AnimDevice::ScrollPrimaryAsync: the rows between the bands move by delta.
        const top = Math.min(h, Math.max(this.topBand.top + delta, 0));
        const bottom = Math.min(h, Math.max(this.bottomBand.bottom + delta, 0));
        if (bottom > top && delta !== 0) bctx.drawImage(buf, 0, top - delta, w, bottom - top, 0, top, w, bottom - top);
        const bg = `rgb(${this.bkgColor.join(",")})`;
        for (const r of [this.topBand, this.bottomBand]) {
          bctx.fillStyle = bg;
          bctx.fillRect(r.left, r.top, r.right - r.left, r.bottom - r.top);
        }
      } else {
        full = true;
        const prev = this.offset;
        this.offset = this.scrollOffset(clock);
        delta = this.offset - prev;
      }
    }
    this.lastPaint = clock;
    if (full) {
      // cTSBuffer::BltEdge of the tiles (cells of a third of the bitmap), center filled.
      bltEdge(new Gfx(bctx, 0, 0), tiles, Math.trunc(tiles.width / 3), Math.trunc(tiles.height / 3), w, h, true);
      if (this.fullRepaint) {
        const px = bctx.getImageData(Math.min(w - 1, tiles.width), Math.min(h - 1, tiles.height), 1, 1).data;
        this.bkgColor = [px[0]!, px[1]!, px[2]!];
      }
    }
    for (let i = 0; i < this.credits.length; i++) {
      if (!this.tick(this.credits[i]!, clock, delta, now)) {
        this.credits.splice(i, 1);
        i--;
      }
    }
    const scale = K_ONE / (this.topBand.top - this.bottomBand.top);
    for (const c of this.credits) this.draw(c, bctx, scale * c.rect.top - this.bottomBand.top * scale, now);
    g.blit(buf, 0, 0);
    this.fullRepaint = false;
    if (this.credits.length === 0) this.close();
  }

  /** cWinCredits::Close: message 0x10 to itself. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.tsEndDialog(0);
  }

  override tsOnKeyDown(key: string): boolean {
    if (key === "Escape" || key === "Enter") {
      this.close();
      return true;
    }
    return super.tsOnKeyDown(key);
  }

  override tsOnCommand(cmd: number, source: TSWin): boolean {
    if (source instanceof TSWinBtn || cmd === 1) {
      this.close();
      return true;
    }
    return super.tsOnCommand(cmd, source);
  }
}
