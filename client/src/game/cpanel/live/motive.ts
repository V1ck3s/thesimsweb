/**
 * cWinMotive — one need of the Live mode "Needs" page: the need's name above a
 * 60 x 5 bar, green on the left (how full the need is), red/grey on the right.
 *
 * From the decompiled code (WinMotive.cpp):
 *  - a cTSWinBtn without image (SetImage(0, 4, 1)), 100 x 20 (Init), font
 *    lbl_105BA2E8[8], toggled on press and firing on press (+0xf0 = 2, +0xec = 1);
 *  - caption = first string of its STR# pair, centered in (0, (10 - charHeight) / 2, w, h);
 *  - the bar's top-left is (20, 12) (sinit); its green width is
 *    round(60 * (value + 100) / 200), clamped to 0..60 (TSPaint);
 *  - bar colors are recomputed in SetVal from t = clamp((value + 50) / 100, 0, 1):
 *      green = (64 - 64t, 93 + 109t, 95 - 38t),  red = (64 + 145u, 93 - 93u, 95 - 95u), u = 1 - t
 *    (t and u quantized to 1/255); the ramps between old and new color have
 *    equal ends, so the color switches at once;
 *  - a 1 px black divider ends the green part when the red part is wider than 1 px.
 *
 * Double-byte UI (CPState::IsDoubleByteUI): the button is 25 px high (30 in
 * Thai), the bar 6 px above its bottom (lbl_105BC444's y, Init), and the
 * caption is drawn in (0, top, w, h - 5) with top 2 in Korean (0x14), 3 in
 * Japanese (0x0f), else 0 (TSPaint).
 *
 * The popup client (+0x198) holds the need's name and description; cWinPeople
 * opens it on a click or, with quick tips, on hover.
 *
 * The delta meter (cWinDeltaMeter, +0x1a8) covers the button; Pump feeds one
 * cAverageHistory(10, 5) per person in the house (+0x1ac) with the rounded
 * motive, and SetPerson hands the selected person's to the meter.
 *
 * The constructor's two GUIDs (cWinPeople::Init: lbl_105BC498 for Sims,
 * lbl_105BC48C for pets) become the popup's object panes
 * (ObjectFolder::GetSelectorByGUID, the cWinLivePopupClient constructor),
 * and its two scales, when not 0, their SetSpecialScale.
 */

import type { GameContext } from "../../context.js";
import type { FfnFont } from "../../res/ffn.js";
import { ALIGN_CENTER } from "../../res/ffn.js";
import { DOUBLE_BYTE_UI, UI_LANGUAGE } from "../../res/uires.js";
import { BTN_TOGGLE_ON_DOWN, TSWinBtn } from "../../ui/btn.js";
import { hiliteColor, rgb } from "../../ui/syscolors.js";
import type { Gfx } from "../../ui/tswin.js";
import { popupObject, WinLivePopupClient } from "../livepopup.js";
import { ObjectFolder } from "../../world/objectfolder.js";
import { AverageHistory, WinDeltaMeter } from "./deltameter.js";

/** lbl_105BC444 (sinit WinMotive.cpp): bar top-left in the window (Init moves it down in a double-byte UI). */
const BAR_ORIGIN = { x: 20, y: 12 };
const LANG_JAPANESE = 0x0f;
const LANG_THAI = 0x13;
const LANG_KOREAN = 0x14;
const BAR_W = 60;
const BAR_H = 5;

/** int(0.5 + x) truncated toward zero, then & 0xff, as the PPC code converts colors. */
function channel(x: number): number {
  return Math.trunc(0.5 + x) & 0xff;
}

export class WinMotive extends TSWinBtn {
  /** cWinMotive+0x18c: displayed value, -100..100. */
  private val = 0;
  /** cWinMotive+0x190: person handle (family index here), -1 = none. */
  private person = -1;
  private green = "";
  private red = "";
  private captionFont: FfnFont | null = null;
  /** lbl_105BC444's y as Init leaves it. */
  private barY = BAR_ORIGIN.y;
  /** +0x198: the popup client (name, description; this button is its target). */
  readonly client: WinLivePopupClient;
  /** +0x1a8 */
  private readonly meter = new WinDeltaMeter();
  /** +0x1ac: one history per person in the house. */
  private readonly histories: AverageHistory[] = [];

  /**
   * cWinMotive(iter, motive, guid, guid, scale, scale): `name` and `desc` are
   * the two strings the constructor takes from the STR# iterator.
   */
  constructor(
    readonly ctx: GameContext,
    readonly name: string,
    readonly desc: string,
    /** cWinMotive+0x194: index into the person's motives. */
    readonly motive: number,
    /** The GUIDs of the popup's two object panes (0 = none). */
    objects: readonly [number, number] = [0, 0],
    /** Their special scales (0 = none). */
    scales: readonly [number, number] = [0, 0],
    /** cSimsApp+0x66 bits the scales need (0 = none): cWinPeople::Init passes the pets' only with ExpansionPack5. */
    scalesNeedPacks = 0,
  ) {
    super();
    this.caption = name;
    this.client = new WinLivePopupClient(name, desc);
    // The client's tag (+0x18, read by Tut_CheckForEvents).
    this.client.kind = "motives";
    this.client.target = this;
    this.resetHistory();
    // The original looks the selectors up synchronously; here they come in once the folder is open.
    ([0, 1] as const).forEach((pane) => {
      const guid = objects[pane];
      if (guid === 0) return;
      void popupObject(ctx, guid).then((sel) => {
        if (!sel) return;
        this.client.setObject(pane, sel);
        const packs = sel.folder instanceof ObjectFolder ? sel.folder.packs : 0;
        if (scales[pane] !== 0 && (packs & scalesNeedPacks) === scalesNeedPacks) this.client.setSpecialScale(pane, scales[pane]);
      }, () => undefined);
    });
  }

  override async init(): Promise<boolean> {
    this.captionFont = await this.ctx.fonts.acquire(8);
    this.font = this.captionFont;
    this.cols = 4;
    if (!DOUBLE_BYTE_UI) this.setArea(this.area.left, this.area.top, this.area.left + 100, this.area.top + 0x14);
    else {
      const h = UI_LANGUAGE === LANG_THAI ? 0x1e : 0x19;
      this.setArea(this.area.left, this.area.top, this.area.left + 100, this.area.top + h);
      this.barY = this.getH() - 6;
    }
    this.mode = BTN_TOGGLE_ON_DOWN;
    this.sendOnDown = true;
    this.meter.setArea(0, 0, this.getW(), this.getH());
    this.childAdd(this.meter);
    this.meter.setTopLefts({ x: BAR_ORIGIN.x - 0x14, y: this.barY }, { x: BAR_ORIGIN.x + 0x3d, y: this.barY });
    return true;
  }

  /** The histories grow to PersonFinder::CountPeopleInHouse. */
  private growHistories(): number {
    const n = this.ctx.state.family.length;
    while (this.histories.length < n) this.histories.push(new AverageHistory(10, 5));
    return n;
  }

  /** cWinMotive::SetPerson. */
  setPerson(person: number): void {
    this.growHistories();
    this.meter.setAverageHistory(person >= 0 ? (this.histories[person] ?? null) : null);
    this.person = person;
  }

  /**
   * cWinMotive::Pump: reads the person's motive (rounded half away from zero).
   * Renamed: TSWin.pump is the per-frame tick.
   */
  pumpMotive(): void {
    const round = (v: number): number => (v < 0 ? Math.trunc(v - 0.5) : Math.trunc(v + 0.5));
    const n = this.growHistories();
    for (let i = 0; i < n; i++) this.histories[i]!.addSample(round(this.ctx.state.family[i]?.motives[this.motive] ?? 0));
    if (this.person === -1) return;
    this.setVal(round(this.ctx.state.family[this.person]?.motives[this.motive] ?? 0));
    this.meter.triggerDeltas();
  }

  /** cWinMotive::GetGreenMagnitude. */
  private greenMagnitude(): number {
    return Math.min(1, Math.max(0, (this.val + 50) / 100));
  }

  /** cWinMotive::ResetHistory / the color part of SetVal. */
  private resetHistory(): void {
    const t = this.greenMagnitude();
    const u = channel(255 * (1 - t)) / 255;
    this.red = rgb(channel(u * 145 + 64), channel(u * -93 + 93), channel(u * -95 + 95));
    const g = channel(255 * t) / 255;
    this.green = rgb(channel(g * -64 + 64), channel(g * 109 + 93), channel(g * -38 + 95));
  }

  /** cWinMotive::SetVal. */
  setVal(v: number): void {
    if (v === this.val) return;
    this.val = v;
    this.resetHistory();
  }

  override tsPaint(g: Gfx): void {
    const font = this.captionFont;
    if (font && this.caption) {
      let top = Math.trunc((10 - font.height) / 2);
      let bottom = this.getH();
      if (DOUBLE_BYTE_UI) {
        top = UI_LANGUAGE === LANG_KOREAN ? 2 : UI_LANGUAGE === LANG_JAPANESE ? 3 : 0;
        bottom -= 5;
      }
      const rect = { left: g.ox, top: g.oy + top, right: g.ox + this.getW(), bottom: g.oy + bottom };
      font.drawTextPara(g.ctx, rect, this.caption, ALIGN_CENTER, hiliteColor(this.cols, this.frameColumn()));
    }
    let w = Math.trunc(0.5 + (BAR_W * (this.val + 100)) / 200);
    w = Math.min(BAR_W, Math.max(0, w));
    const { x } = BAR_ORIGIN;
    const y = this.barY;
    g.fill(x, y, w, BAR_H, this.green);
    g.fill(x + w, y, BAR_W - w, BAR_H, this.red);
    if (BAR_W - w > 1) g.fill(x + w - 1, y, 1, BAR_H, "#000000");
  }
}
