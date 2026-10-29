/**
 * Control panel container (cWinCPanel).
 *
 * Geometry from the decompiled code (identical on Mac and PC):
 *  - the panel spans the lot view's width and its bottom 150 px
 *    (cSimsApp: SetArea(view.left, view.bottom - 150, view.right, view.bottom));
 *  - its top 50 px are transparent to the mouse (IsPointInWindowWindowCoordinates);
 *  - kUniversalCPBkg (PanelBack.bmp) is painted at (168, 50) (cWinCPanel::TSPaint);
 *  - subpanels sit at (220, 50), (width - 220) x 100; the Live panel is 50 px
 *    taller and starts at y = 0 (cWinCPanel::Init);
 *  - the view control gadget is reparented to the lot view, bottom-left
 *    (cWinCPanel::PostInit).
 */

import { getCursor } from "../ui/cursor.js";
import { Mode, type CPState } from "../cpstate.js";
import type { GameContext } from "../context.js";
import { Gfx, TSWin } from "../ui/tswin.js";
import { WinArch } from "./arch.js";
import { WinCamPanel } from "./campanel.js";
import { WinCatalog } from "./catalog.js";
import { WinOptions } from "./options.js";
import { WinPeople } from "./people.js";
import { WinViewControl } from "./viewcontrol.js";

/** cWinCPanel::PanelID */
export const enum PanelID {
  People = 0,
  Catalog = 1,
  Arch = 2,
  Options = 3,
  Dispose = 4,
  Camera = 5,
}

/** cWinCPanel.cpp static init. */
export const SUBPANEL_ORIGIN = { x: 220, y: 50 };
const BACKGROUND_ORIGIN = { x: 168, y: 50 };
export const CPANEL_HEIGHT = 150;

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
  private panel = PanelID.People;
  private background: ImageBitmap | null = null;

  private readonly listener = (s: CPState): void => this.updateViewFromCPState(s);

  constructor(readonly ctx: GameContext) {
    super();
  }

  override async init(): Promise<boolean> {
    const { ctx } = this;
    this.background = await ctx.res.image("kUniversalCPBkg");
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
    this.people = new WinPeople(ctx);
    this.catalog = new WinCatalog(ctx);
    this.options = new WinOptions(ctx);
    this.camPanel = new WinCamPanel(ctx);
    const ok =
      (await place(this.arch, SUBPANEL_ORIGIN.y, 100)) &&
      (await place(this.people, SUBPANEL_ORIGIN.y - 50, 150)) &&
      (await place(this.catalog, SUBPANEL_ORIGIN.y, 100)) &&
      (await place(this.options, SUBPANEL_ORIGIN.y, 100)) &&
      (await place(this.camPanel, SUBPANEL_ORIGIN.y, 100));
    // Only listen once every subpanel exists (CPState::SetControlPanel).
    if (ok) ctx.state.onChange(this.listener);
    return ok;
  }

  override shutdown(): void {
    this.ctx.state.offChange(this.listener);
    this.viewControl.parent?.childDelete(this.viewControl);
    super.shutdown();
  }

  /** cWinCPanel::PostInit: the view control lives in the lot view, bottom-left. */
  postInit(): void {
    const view = this.parent;
    if (!view) return;
    const vc = this.viewControl;
    const top = view.getH() - vc.getH();
    vc.setArea(0, top, vc.getW(), top + vc.getH());
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
    ];
    for (const [pid, win] of map) {
      if (pid === id) win.showWindow();
      else win.hideWindow();
    }
  }

  updateViewFromCPState(state: CPState): void {
    const want = PANEL_FOR_MODE[state.getMode()];
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
    const win = [this.people, this.catalog, this.arch, this.options, null, this.camPanel][id];
    return win?.isVisible() ?? false;
  }

  override tsPaint(g: Gfx): void {
    if (this.background) g.blit(this.background, BACKGROUND_ORIGIN.x, BACKGROUND_ORIGIN.y);
  }

  override isPointInWindowWindowCoordinates(x: number, y: number): boolean {
    return y > 49 && x >= 0 && x < this.getW() && y < this.getH();
  }
}
