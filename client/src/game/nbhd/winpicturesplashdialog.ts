/**
 * cWinPictureSplashDialog (WinPictureSplashDialog.cpp) and the taxi splash of
 * cSimsApp::CreateTaxiDialog / RemoveTaxiDialog.
 *
 * The dialog is the picture and nothing else: the constructor keeps the
 * buffer and its size (+0xdc / +0xe0), Init takes a private buffer, clears
 * flag 4 and sets cursor 3 (the hourglass); TSBeginModal / DoLayout size the
 * window to the picture and center it in the main window; TSPaint blits it.
 *
 * CreateTaxiDialog(screen) removes the previous splash, loads the picture of
 * the transit screen (the "Big" 1024x768 one when the view is wider than 800),
 * adds the dialog to the lot view (cSimsApp+0x80, cDDDSimsView) and shows it;
 * it stays until RemoveTaxiDialog, which generic sim call 3 runs (on the lot
 * the sims arrive on). cSimsApp::eTransitScreens (jump table lbl_105BC2DC):
 *   0 kDTGo         downtown            4 kStudiotownFanGo   Studio Town (fans)
 *   1 kVacationGo   vacation (from a    5 kStudiotownGo      Studio Town
 *                   community lot)      6 kMagicLandGo       Magic Town
 *   2 kVacationGo2  vacation (from home) 7 kMagicLandHoleGo  Magic Town (hole)
 *   3 kNeighborhoodGo  a community lot of the neighborhood
 */

import type { GameContext } from "../context.js";
import { getStandardCursor } from "../ui/cursor.js";
import { TSWinDlg } from "../ui/dlg.js";
import { Gfx, TSWin } from "../ui/tswin.js";

/** [small, big] picture ids per cSimsApp::eTransitScreens. */
const TRANSIT_PICTURES: ReadonlyArray<readonly [number, number]> = [
  [0x1530, 0x1531], // kDTGo, kDTGoBig
  [0x157c, 0x157d], // kVacationGo
  [0x157e, 0x157f], // kVacationGo2
  [0x15e0, 0x15e1], // kNeighborhoodGo
  [0x1614, 0x1615], // kStudiotownFanGo
  [0x1612, 0x1613], // kStudiotownGo
  [0x1616, 0x1617], // kMagicLandGo
  [0x1618, 0x1619], // kMagicLandHoleGo
];

export const enum TransitScreen {
  Downtown = 0,
  Vacation = 1,
  Vacation2 = 2,
  Neighborhood = 3,
  StudiotownFan = 4,
  Studiotown = 5,
  Magictown = 6,
  MagictownHole = 7,
}

export class WinPictureSplashDialog extends TSWinDlg {
  constructor(private readonly picture: ImageBitmap) {
    super();
  }

  /** cWinPictureSplashDialog::Init: cursor 3 (the hourglass). */
  override async init(): Promise<boolean> {
    this.winCursor = getStandardCursor(3);
    return true;
  }

  /** DoLayout + CenterWindowInRect(main window) of TSBeginModal (also run when shown without a modal loop). */
  layout(container: TSWin): void {
    this.setArea(0, 0, this.picture.width, this.picture.height);
    this.centerWindowInRect({ left: 0, top: 0, right: container.getW(), bottom: container.getH() });
  }

  override tsPaint(g: Gfx): void {
    g.blit(this.picture, 0, 0);
  }

  /** The splash takes the clicks over it (nothing behind reacts). */
  override tsOnMouseDownL(): boolean {
    return true;
  }
  override tsOnMouseUpL(): boolean {
    return true;
  }
}

/** cSimsApp+0x78 */
let taxiDialog: WinPictureSplashDialog | null = null;

/** cSimsApp::CreateTaxiDialog: the transit picture over `view` (the lot view). */
export async function createTaxiDialog(ctx: GameContext, view: TSWin, screen: TransitScreen): Promise<void> {
  removeTaxiDialog();
  const ids = TRANSIT_PICTURES[screen];
  if (!ids) return;
  const picture = await ctx.res.image(view.getW() > 800 ? ids[1] : ids[0]).catch(() => null);
  if (!picture) return;
  const dlg = new WinPictureSplashDialog(picture);
  await dlg.init();
  dlg.layout(view);
  view.childAdd(dlg);
  view.childToFront(dlg);
  dlg.showWindow();
  taxiDialog = dlg;
}

/** cSimsApp::RemoveTaxiDialog */
export function removeTaxiDialog(): void {
  const dlg = taxiDialog;
  taxiDialog = null;
  dlg?.parent?.childDelete(dlg);
}

/** The splash up now (the lot change moves it onto the next lot view). */
export function currentTaxiDialog(): WinPictureSplashDialog | null {
  return taxiDialog;
}
