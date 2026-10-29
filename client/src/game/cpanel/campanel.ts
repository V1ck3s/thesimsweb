/**
 * cWinCamPanel — Camera mode panel: snapshot size (small / medium / large /
 * custom), quality (low / medium / high) and the photo album button.
 *
 * Ported from the Mac build (cWinCamPanel.c, wincampanel.s for the
 * TSOnCommand jump table), checked against the Windows build.
 *  - UIText STR# 140 "cammodestrs": a "(x;y)" position then a tooltip per
 *    button, then the size popup's title and text and the quality popup's;
 *  - every button toggles and fires on press; the album button is a push
 *    button; the custom size button (cCustButton) is enabled only when the
 *    size is custom and shows "WxH" in the size 9 table font, with a black
 *    shadow, at the bottom of its image;
 *  - the description popup (cWinLivePopup) shows kCamPopupDetail or
 *    kCamPopupQualDetail; it opens after the async timeout on hover with
 *    quick tips on, or after a press otherwise (cTSWinBtn flags 1 / 6);
 *  - TSPaint: the control panel background, then two vertical toothpicks.
 * The album button opens cWinScrapbook (camscrapbook.ts); the snapshot
 * itself is taken by the lot view (camsnapshot.ts).
 * Not ported: the custom size tWinFlag 0x400.
 */

import { CameraQuality, CameraSize, DIRTY_CAMERA } from "../cpstate.js";
import type { GameContext } from "../context.js";
import { getOptionsMgr } from "../optionsmgr.js";
import { ALIGN_CENTER } from "../res/ffn.js";
import { BTN_PUSH, BTN_TOGGLE } from "../ui/btn.js";
import { TSWinCtrlMgr } from "../ui/ctrlmgr.js";
import { Gfx, TSWin } from "../ui/tswin.js";
import { winMgr } from "../ui/winmgr.js";
import { scrapbookOpenListeners, showScrapbook } from "./camscrapbook.js";
import {
  ASYNC_ON_DOWN,
  ASYNC_ON_ENTER,
  ASYNC_ON_UP,
  AsyncBtn,
  CMD_ASYNC_TIMEOUT,
  CMD_CLICK,
  WinLivePopup,
  WinLivePopupClient,
} from "./livepopup.js";

/** UIText STR# 140 "cammodestrs" (LoadUIStrings(0x8c)). */
const STR_CAMERA = 0x8c;

/** cWinCamPanel+0xd4 slots, and their images (lbl_105BC344). */
const enum Slot {
  Small = 0,
  Medium = 1,
  Large = 2,
  Custom = 3,
  Album = 4,
  QualLow = 5,
  QualMed = 6,
  QualHigh = 7,
  Count = 8,
}
const IMAGES = [
  "kCamFrameSmall",
  "kCamFrameMed",
  "kCamFrameLarge",
  "kCamFrameCust",
  "kCamViewAlbum",
  "kCamQualLow",
  "kCamQualMed",
  "kCamQualHigh",
];

/** cCustButton: its caption is drawn twice, black 1 px down-right, then in the hilite color. */
class CustButton extends AsyncBtn {
  protected override captionDraw(g: Gfx): void {
    const font = this.font;
    const r = this.textRect;
    if (!font || !r) return;
    const color = this.captionColorNow();
    for (const [d, c] of [
      [1, "#000000"],
      [0, color],
    ] as const) {
      const rect = {
        left: g.ox + r.left + d,
        top: g.oy + r.top + d,
        right: g.ox + r.right + d,
        bottom: g.oy + r.bottom + d,
      };
      font.drawTextPara(g.ctx, rect, this.caption, ALIGN_CENTER, c);
    }
  }
}

export class WinCamPanel extends TSWin {
  private readonly btns: AsyncBtn[] = [];
  /** +0xd0: the control panel background handed over by cWinCPanel (kUniversalCPBkg). */
  private background: ImageBitmap | null = null;
  /** +0x104 / +0x110 */
  private sizeDetail: ImageBitmap | null = null;
  private qualityDetail: ImageBitmap | null = null;
  /** +0x118 / +0x11c */
  private toothPick1: ImageBitmap | null = null;
  private toothPick2: ImageBitmap | null = null;
  /** +0xfc / +0x100 / +0x108 / +0x10c */
  private sizeTitle = "";
  private sizeText = "";
  private qualityTitle = "";
  private qualityText = "";
  /** +0xf4 / +0xf8 */
  private popup: WinLivePopup | null = null;
  private client: WinLivePopupClient | null = null;
  /** +0x114 */
  private quickTips = false;
  /** lbl_105C0A50: the album is open. */
  private static albumOpen = false;
  private mouseInside = false;
  /** cWinCPanel::SetScrapbookOpen reaches this panel. */
  private readonly onScrapbookOpen = (open: boolean): void => this.setScrapbookOpen(open);

  constructor(readonly ctx: GameContext) {
    super();
  }

  /** cWinCamPanel::Init */
  override async init(): Promise<boolean> {
    const { res, strings } = this.ctx;
    this.quickTips = getOptionsMgr().getQuickTips();
    [this.background, this.sizeDetail, this.qualityDetail, this.toothPick1, this.toothPick2] =
      await Promise.all([
        res.image("kUniversalCPBkg"),
        res.image("kCamPopupDetail"),
        res.image("kCamPopupQualDetail"),
        res.image("kCamToothPick1"),
        res.image("kCamToothPick2"),
      ]);
    const table = strings.list("UIText", STR_CAMERA);
    let it = 0;
    const next = (): string => table[it++] ?? "";
    for (let i = 0; i < Slot.Count; i++) {
      const b = i === Slot.Custom ? new CustButton(CMD_CLICK) : new AsyncBtn(CMD_CLICK);
      b.sendOnDown = true;
      b.mode = BTN_TOGGLE;
      b.setImage(await res.image(IMAGES[i]!), 4, 1);
      this.childAdd(b);
      const m = /\(\s*(-?\d+)\s*;\s*(-?\d+)\s*\)/.exec(next());
      b.moveTo(Number(m?.[1] ?? 0), Number(m?.[2] ?? 0));
      b.tooltip = next();
      this.btns.push(b);
    }
    this.btns[Slot.Album]!.mode = BTN_PUSH;
    // The custom size caption: centered on the bottom font line of the button.
    const cust = this.btns[Slot.Custom]!;
    const font = (await TSWinCtrlMgr.get(this.ctx)).tableFont(9);
    cust.font = font;
    cust.textRect = {
      left: 0,
      top: cust.getH() - font.height,
      right: cust.getW(),
      bottom: cust.getH(),
    };
    cust.textAlignment = 1;
    this.sizeTitle = next();
    this.sizeText = next();
    this.qualityTitle = next();
    this.qualityText = next();
    this.client = new WinLivePopupClient(this.sizeTitle, this.sizeText);
    this.client.setBitmap(0, this.sizeDetail);
    this.client.resetTargetOnClose = false;
    this.client.kind = "camera";

    this.popup = new WinLivePopup(this.ctx);
    if (!(await this.popup.init())) return false;
    this.setQuickTips(this.quickTips);
    scrapbookOpenListeners.add(this.onScrapbookOpen);
    return true;
  }

  /** cWinCamPanel::SetQuickTips: hover opens the popup; without quick tips a press does. */
  setQuickTips(on: boolean): void {
    this.quickTips = on;
    const timeout = getOptionsMgr().getDefaultAsyncTimeout();
    this.btns.forEach((b, i) => {
      if (i !== Slot.Album) b.setAsync(on ? ASYNC_ON_ENTER : ASYNC_ON_DOWN | ASYNC_ON_UP, timeout);
    });
  }

  /** cWinCamPanel::SetScrapbookOpen */
  setScrapbookOpen(open: boolean): void {
    this.btns[Slot.Album]?.setState(open ? 1 : 0);
  }

  /** cWinCamPanel::UpdateViewFromCPState */
  updateViewFromCPState(): void {
    const s = this.ctx.state;
    if (!(s.dirty & DIRTY_CAMERA)) return;
    const size = s.camGetSize();
    for (const i of [Slot.Small, Slot.Medium, Slot.Large, Slot.Custom])
      this.btns[i]?.setState((size as number) === i ? 1 : 0);
    const cust = this.btns[Slot.Custom];
    if (cust) {
      cust.setEnabled(size === CameraSize.Custom);
      cust.caption = size === CameraSize.Custom ? `${s.camGetWidth()}x${s.camGetHeight()}` : "";
    }
    const q = s.camGetQuality();
    this.btns[Slot.QualLow]?.setState(q === CameraQuality.Low ? 1 : 0);
    this.btns[Slot.QualMed]?.setState(q === CameraQuality.Medium ? 1 : 0);
    this.btns[Slot.QualHigh]?.setState(q === CameraQuality.High ? 1 : 0);
  }

  /** cWinCamPanel::SetupPopup */
  private setupPopup(i: number): void {
    const popup = this.popup;
    const client = this.client;
    const btn = this.btns[i];
    if (!popup || !client || !btn) return;
    const quality = [this.btns[Slot.QualLow], this.btns[Slot.QualMed], this.btns[Slot.QualHigh]];
    const t = client.target;
    if (
      popup.isEnabled() &&
      t &&
      i <= Slot.Custom &&
      quality.some((q) => q === t) &&
      !this.quickTips
    )
      t.setState(0);
    client.target = btn;
    if (!this.quickTips) btn.setState(1);
    if (i >= Slot.QualLow) {
      client.setName(this.qualityTitle);
      client.setDesc(this.qualityText);
      client.setBitmap(0, this.qualityDetail);
    } else {
      client.setName(this.sizeTitle);
      client.setDesc(this.sizeText);
      client.setBitmap(0, this.sizeDetail);
    }
    if (!popup.isEnabled()) popup.enablePopup(client, this);
  }

  /** cWinCamPanel::TSOnCommand */
  override tsOnCommand(cmd: number, src: TSWin): boolean {
    const i = this.btns.indexOf(src as AsyncBtn);
    if (cmd === CMD_ASYNC_TIMEOUT) {
      if (i !== -1) this.setupPopup(i);
      return true;
    }
    if (cmd !== CMD_CLICK) return super.tsOnCommand(cmd, src);
    if (i === -1) return false;
    if (this.popup?.isEnabled()) this.setupPopup(i);
    const s = this.ctx.state;
    const others = (a: Slot, b: Slot): void => {
      this.btns[a]?.setState(0);
      this.btns[b]?.setState(0);
    };
    switch (i) {
      case Slot.Small:
        others(Slot.Medium, Slot.Large);
        s.camSetSize(CameraSize.Small);
        break;
      case Slot.Medium:
        others(Slot.Small, Slot.Large);
        s.camSetSize(CameraSize.Medium);
        break;
      case Slot.Large:
        others(Slot.Small, Slot.Medium);
        s.camSetSize(CameraSize.Large);
        break;
      case Slot.Album:
        void this.openAlbum();
        break;
      case Slot.QualLow:
        others(Slot.QualMed, Slot.QualHigh);
        s.camSetQuality(CameraQuality.Low);
        break;
      case Slot.QualMed:
        others(Slot.QualLow, Slot.QualHigh);
        s.camSetQuality(CameraQuality.Medium);
        break;
      case Slot.QualHigh:
        others(Slot.QualLow, Slot.QualMed);
        s.camSetQuality(CameraQuality.High);
        break;
    }
    return true;
  }

  /** Command 1 on the album button: cWinScrapbook, centered and modal, once at a time. */
  private async openAlbum(): Promise<void> {
    if (WinCamPanel.albumOpen) return;
    WinCamPanel.albumOpen = true;
    try {
      if (this.ctx.hooks?.showScrapbook) await this.ctx.hooks.showScrapbook();
      else await showScrapbook(this.ctx);
    } finally {
      WinCamPanel.albumOpen = false;
    }
  }

  /** TSOnMouseExit / TSOnMouseExitChild: leaving the panel closes the popup (see WinOptions.pump). */
  override pump(nowMs: number): void {
    super.pump(nowMs);
    const inside = this.isVisibleAndAllParentsVisible() && this.containsCursor();
    if (this.mouseInside && !inside && this.popup?.isEnabled()) this.popup.disablePopup();
    this.mouseInside = inside;
  }

  private containsCursor(): boolean {
    const { x, y } = winMgr.cursorPosition();
    const o = winMgr.main.absOrigin();
    for (let w = winMgr.main.windowFromPoint(x - o.x, y - o.y); w; w = w.parent)
      if (w === this) return true;
    return false;
  }

  /** cWinCamPanel::TSPaint */
  override tsPaint(g: Gfx): void {
    if (this.background) g.blitPart(this.background, 0, 0, this.getW(), this.getH(), 0, 0);
    if (this.toothPick1) g.blit(this.toothPick1, 0x85, 6);
    if (this.toothPick2) g.blit(this.toothPick2, 0xce, 6);
  }

  override shutdown(): void {
    scrapbookOpenListeners.delete(this.onScrapbookOpen);
    if (this.popup) {
      this.popup.disablePopup();
      this.popup.parent?.childDelete(this.popup);
      this.popup = null;
    }
    super.shutdown();
  }
}
