/**
 * Control panel container (cWinCPanel).
 *
 * Geometry from the decompiled code (identical on Mac and PC):
 *  - the panel spans the lot view's width and its bottom 150 px
 *    (cSimsApp: SetArea(view.left, view.bottom - 150, view.right, view.bottom));
 *  - its top 50 px are transparent to the mouse (IsPointInWindowWindowCoordinates);
 *  - cWinCPanel::TSPaint (Windows 0050a673, Mac 10266680) paints kBackPatch
 *    (BackPatch.bmp, 52 x 100: the corner joining the view control's band to
 *    the subpanels; +0x100 Windows / +0xf8 Mac) at (168, 50) (DAT_006f35e0 /
 *    lbl_105BC3D0); kUniversalCPBkg (+0x104 / +0xfc) is handed to the subpanels;
 *  - subpanels sit at (220, 50), (width - 220) x 100; the Live panel is 50 px
 *    taller and starts at y = 0 (cWinCPanel::Init);
 *  - the view control gadget is reparented to the lot view, bottom-left
 *    (cWinCPanel::PostInit).
 *
 * Double-byte UI (CPState::IsDoubleByteUI, Mac cWinCPanel::Init / TSPaint /
 * IsPointInWindowWindowCoordinates): the Live pages are 150 px high
 * (people.ts). Init loads kTallSubpanel (TallSubPanel.TGA, 32-bit with
 * alpha), clones kUniversalCPBkg (+0x100) with the TGA's rows 50.. pasted at
 * (0x118, 0) (a Blt: opaque but the keyed alpha 0 pixels) and hands the
 * clone to cWinPeople; the TGA's top-left (width - 500) x 50 with its alpha
 * becomes +0x104, drawn at (0x208, 0) while the Live panel is shown:
 * composed with its alpha (times the Live panel's opacity) with interface
 * effects (GetBoboVision), else a Blt keyed on black (SetTransparency(0)). Its alpha, read at byte x - 0x231 + y * pitch, also takes the
 * clicks right of x 0x207 in the top 50 px while the People panel is up.
 */

import { getCursor } from "../ui/cursor.js";
import { Mode, type CPState, type DisposeItem } from "../cpstate.js";
import type { GameContext } from "../context.js";
import { Gfx, TSWin } from "../ui/tswin.js";
import { WinArch } from "./arch.js";
import { WinCamPanel } from "./campanel.js";
import { WinCatalog } from "./catalog.js";
import { WinDisposePopup } from "./disposepopup.js";
import { WinOptions } from "./options.js";
import { WinPeople } from "./people.js";
import { WinViewControl } from "./viewcontrol.js";
import { getOptionsMgr } from "../optionsmgr.js";
import { DOUBLE_BYTE_UI } from "../res/uires.js";
import { gimexUnpremultiply } from "../res/bmp.js";

/** cWinCPanel::PanelID */
export const enum PanelID {
  People = 0,
  Catalog = 1,
  Arch = 2,
  Options = 3,
  Dispose = 4,
  Camera = 5,
}

/** cWinCPanel.cpp static init (kBackPatch's position: lbl_105BC3D0, Windows DAT_006f35e0). */
export const SUBPANEL_ORIGIN = { x: 220, y: 50 };
const BACKGROUND_ORIGIN = { x: 168, y: 50 };
export const CPANEL_HEIGHT = 150;
/** Double-byte UI: where TSPaint draws kTallSubpanel's top part (+0x104). */
const TALL_TOP_X = 0x208;

const PANEL_FOR_MODE: Record<Mode, PanelID> = {
  [Mode.Build]: PanelID.Arch,
  [Mode.Buy]: PanelID.Catalog,
  [Mode.Live]: PanelID.People,
  [Mode.Options]: PanelID.Options,
  [Mode.Camera]: PanelID.Camera,
};

export class WinCPanel extends TSWin {
  viewControl!: WinViewControl;
  people!: WinPeople;
  catalog!: WinCatalog;
  arch!: WinArch;
  options!: WinOptions;
  camPanel!: WinCamPanel;
  /** +0xe8 */
  disposePopup!: WinDisposePopup;
  private panel = PanelID.People;
  /** +0xcd: the dispose popup replaces the mode's panel. */
  private disposeShown = false;
  /** +0x100 (Mac +0xf8): kBackPatch. */
  private background: ImageBitmap | null = null;
  /** Mac +0x104 (double-byte UI): the top of kTallSubpanel, with alpha and opaque (Blt without interface effects). */
  private tallTop: { alpha: ImageBitmap; opaque: ImageBitmap; mask: Uint8Array; pitch: number } | null = null;

  private readonly listener = (s: CPState): void => this.updateViewFromCPState(s);

  constructor(readonly ctx: GameContext) {
    super();
  }

  override async init(): Promise<boolean> {
    const { ctx } = this;
    this.background = await ctx.res.image("kBackPatch");
    // cWinCPanel::Init: SetCursor(GetCursor(0)), so that the lot view's tool cursor stops at the panel.
    this.winCursor = getCursor(0);
    const width = this.getW();

    this.viewControl = new WinViewControl(ctx);
    if (!(await this.viewControl.init())) return false;

    const place = async (win: TSWin, top: number, height: number): Promise<boolean> => {
      win.setArea(SUBPANEL_ORIGIN.x, top, width, top + height);
      if (!(await win.init())) return false;
      win.hideWindow();
      this.childAdd(win);
      return true;
    };
    this.arch = new WinArch(ctx);
    this.people = new WinPeople(ctx, DOUBLE_BYTE_UI ? await this.buildTallSubpanel(width) : null);
    if (this.tallTop) this.people.tallTopAlpha = { alpha: this.tallTop.mask, pitch: this.tallTop.pitch };
    this.catalog = new WinCatalog(ctx);
    this.options = new WinOptions(ctx);
    this.camPanel = new WinCamPanel(ctx);
    this.disposePopup = new WinDisposePopup(ctx);
    const ok =
      (await place(this.arch, SUBPANEL_ORIGIN.y, 100)) &&
      (await place(this.people, SUBPANEL_ORIGIN.y - 50, 150)) &&
      (await place(this.catalog, SUBPANEL_ORIGIN.y, 100)) &&
      (await place(this.options, SUBPANEL_ORIGIN.y, 100)) &&
      (await place(this.camPanel, SUBPANEL_ORIGIN.y, 100)) &&
      (await place(this.disposePopup, SUBPANEL_ORIGIN.y, 100));
    // Only listen once every subpanel exists (CPState::SetControlPanel).
    if (ok) {
      ctx.state.onChange(this.listener);
      ctx.state.disposeHandler = {
        enable: (item) => this.enableDisposePopup(item),
        disable: () => this.disableDisposePopup(),
      };
    }
    return ok;
  }

  /**
   * The double-byte part of cWinCPanel::Init: returns the people panel's
   * background (+0x100) and keeps the top part (+0x104).
   */
  private async buildTallSubpanel(width: number): Promise<ImageBitmap | null> {
    const { res } = this.ctx;
    const [bkg, tall] = await Promise.all([res.image("kUniversalCPBkg"), res.rgba(res.id("kTallSubpanel")).catch(() => null)]);
    if (!tall) return null;
    // LoadBuffer: GIMEXFactory's colours, the alpha in the alpha buffer, magenta (alpha 0) keyed out.
    gimexUnpremultiply(tall);
    const opaque = new Uint8ClampedArray(tall.data);
    for (let i = 3; i < opaque.length; i += 4) opaque[i] = opaque[i] === 0 ? 0 : 0xff;
    const tallOpaque = await createImageBitmap(new ImageData(opaque, tall.width, tall.height));
    const clone = new OffscreenCanvas(bkg.width, bkg.height);
    const cg = clone.getContext("2d")!;
    cg.drawImage(bkg, 0, 0);
    cg.drawImage(tallOpaque, 0, 0x32, tall.width, tall.height - 0x32, 0x118, 0, tall.width, tall.height - 0x32);
    const w = Math.max(0, Math.min(width - 500, tall.width));
    if (w > 0) {
      // +0x104 starts black; the Blt skips the keyed pixels and SetTransparency(0) keys black.
      const top = new ImageData(w, 0x32);
      const keyed = new ImageData(w, 0x32);
      const mask = new Uint8Array(w * 0x32);
      for (let y = 0; y < 0x32; y++) {
        for (let x = 0; x < w; x++) {
          const s = (y * tall.width + x) * 4;
          const d = (y * w + x) * 4;
          const a = tall.data[s + 3]!;
          mask[y * w + x] = a;
          if (a === 0) continue;
          top.data.set(tall.data.subarray(s, s + 4), d);
          const black = tall.data[s] === 0 && tall.data[s + 1] === 0 && tall.data[s + 2] === 0;
          keyed.data.set(tall.data.subarray(s, s + 3), d);
          keyed.data[d + 3] = black ? 0 : 0xff;
        }
      }
      const alpha = await createImageBitmap(top);
      const opaqueTop = await createImageBitmap(keyed);
      this.tallTop = { alpha, opaque: opaqueTop, mask, pitch: w };
    }
    return createImageBitmap(clone);
  }

  override shutdown(): void {
    this.ctx.state.offChange(this.listener);
    this.ctx.state.disposeHandler = null;
    this.viewControl.parent?.childDelete(this.viewControl);
    super.shutdown();
  }

  /** cWinCPanel::PostInit: the view control lives in the lot view, bottom-left. */
  postInit(): void {
    const view = this.parent;
    if (!view) return;
    const vc = this.viewControl;
    const top = view.getH() - vc.getH();
    // The panel's left edge: 0 in the original; the port's centred HUD moves the panel (ctx.hud).
    const left = this.area.left;
    vc.setArea(left, top, left + vc.getW(), top + vc.getH());
    view.childAdd(vc);
  }

  getPanel(): PanelID {
    return this.panel;
  }

  setPanel(id: PanelID): void {
    this.panel = id;
    const map: Array<[PanelID, TSWin]> = [
      [PanelID.People, this.people],
      [PanelID.Catalog, this.catalog],
      [PanelID.Arch, this.arch],
      [PanelID.Options, this.options],
      [PanelID.Camera, this.camPanel],
      [PanelID.Dispose, this.disposePopup],
    ];
    for (const [pid, win] of map) {
      if (pid === id) win.showWindow();
      else win.hideWindow();
    }
  }

  /** cWinCPanel::EnableDisposePopup */
  enableDisposePopup(item: DisposeItem): void {
    this.disposePopup.enablePopup(item);
    this.showDisposePopup(true);
  }

  /** cWinCPanel::DisableDisposePopup */
  disableDisposePopup(): void {
    this.showDisposePopup(false);
  }

  /** cWinCPanel::ShowDisposePopup: page 4, or back to the mode's page. */
  showDisposePopup(show: boolean): void {
    if (show === this.disposeShown) return;
    this.disposeShown = show;
    this.setPanel(show ? PanelID.Dispose : PANEL_FOR_MODE[this.ctx.state.getMode()]);
  }

  updateViewFromCPState(state: CPState): void {
    const want = this.disposeShown ? PanelID.Dispose : PANEL_FOR_MODE[state.getMode()];
    if (want !== this.panel || !this.isPanelVisible(want)) this.setPanel(want);
    this.viewControl.updateViewFromCPState();
    switch (state.getMode()) {
      case Mode.Build:
        this.arch.updateViewFromCPState();
        break;
      case Mode.Buy:
        this.catalog.updateViewFromCPState();
        break;
      case Mode.Live:
        this.people.updateViewFromCPState();
        break;
      case Mode.Options:
        this.options.updateViewFromCPState();
        break;
      case Mode.Camera:
        this.camPanel.updateViewFromCPState();
        break;
    }
  }

  private isPanelVisible(id: PanelID): boolean {
    const win = [this.people, this.catalog, this.arch, this.options, this.disposePopup, this.camPanel][id];
    return win?.isVisible() ?? false;
  }

  override tsPaint(g: Gfx): void {
    if (this.background) g.blit(this.background, BACKGROUND_ORIGIN.x, BACKGROUND_ORIGIN.y);
    const top = this.tallTop;
    if (top && this.people.isVisible()) {
      if (getOptionsMgr().getBoboVision()) {
        const a = g.ctx.globalAlpha;
        g.ctx.globalAlpha = this.people.getOpacity() / 255;
        g.blit(top.alpha, TALL_TOP_X, 0);
        g.ctx.globalAlpha = a;
      } else {
        g.blit(top.opaque, TALL_TOP_X, 0);
      }
    }
  }

  override isPointInWindowWindowCoordinates(x: number, y: number): boolean {
    if (y > 49 && x >= 0 && x < this.getW() && y < this.getH()) return true;
    const top = this.tallTop;
    if (!top || this.panel !== PanelID.People || x < TALL_TOP_X || y < 0 || y >= 0x32) return false;
    return (top.mask[x - 0x231 + y * top.pitch] ?? 0) > 0x80;
  }
}
