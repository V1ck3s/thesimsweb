/**
 * Lot button (cWinLotBtn): one house thumbnail on a neighborhood map.
 *
 * LoadHouseInfo picks the bitmap pair (house, roof) and its THMB anchor: the
 * half-size pair (BMP_ 1024/1025, THMB 1024) on the Unleashed screen, the full
 * pair otherwise. The button image has two frames side by side:
 *   column 0: the house with the roof blitted at THMB (dx, dy),
 *   column 1: the house alone (roof "dissolved").
 * CenterOn places the button so that the THMB anchor (x, y + z) sits on the
 * lot location; without a THMB the button is centered on it.
 *
 * Hovering switches cTSWinBtn's column (2-column rule) and starts a 300 ms
 * constant-time ramp; ImageBlt cross-fades the previous column into the new
 * one with alpha = int(0.5 + 255 * ramp). When the owner refuses the dissolve
 * (cWinNeighborhoodUL::ShouldAllowRoofDissolve: nobody lives here) column 0 is
 * shown whatever the state. Drawing is clipped to the map (cWinLotBtn+0x220).
 */

import { TSWinBtn, UISOUND_DOWN, UISOUND_ENTER } from "../ui/btn.js";
import { WF_HIT_ALPHA, type Gfx, type Rect } from "../ui/tswin.js";
import { UI } from "../audio/index.js";
import { getHouseInfo, type HouseInfo, type Neighborhood, type Thmb } from "./nghinterface.js";
import type { GameContext } from "../context.js";
import { hiliteForTutorial } from "../ui/tutorialhighlight.js";

/** RampGenerator::SetupConstantTimeRamp duration used by CalcRowCol. */
const DISSOLVE_MS = 300;

/** What a lot button asks its neighborhood screen (cWinNeighborhood virtuals). */
export interface LotBtnOwner {
  shouldAllowRoofDissolve(btn: WinLotBtn): boolean;
  lotEntered(btn: WinLotBtn): void;
  lotExited(btn: WinLotBtn): void;
}

export class WinLotBtn extends TSWinBtn {
  info: HouseInfo | null = null;
  /** +0x1c8: the house number (HouseInfo+0x3c). */
  houseNumber = -1;
  /** +0x220: clip rectangle in the coordinates of the button's parent. */
  clip: Rect | null = null;
  /** +0x208 = the button image carries the roof frame. */
  private hasRoof = false;
  private anchor: Thmb | null = null;
  /** RampGenerator at +0x20c: value goes from `from` to 1 over DISSOLVE_MS from `start`. */
  private rampFrom = 1;
  private rampStart = -Infinity;
  private lastColumn = 0;

  constructor(
    private readonly owner: LotBtnOwner,
    private readonly nb: Neighborhood,
    /** +0x234: the owner is the Unleashed neighborhood (uses the half-size bitmaps). */
    private readonly small: boolean,
  ) {
    super(1);
    // cWinLotBtn::Init: SetFlag(0x200), clicks go through the lot's transparent pixels.
    this.setFlag(WF_HIT_ALPHA, true);
    // cWinLotBtn::Init: OverrideUISound(rollover, click), sounds on enter and down.
    this.overrideUISound(UI.nhoodRollover, UI.nhoodClick);
    this.uiSoundActions = UISOUND_ENTER | UISOUND_DOWN;
  }

  /** cWinLotBtn::HiliteForTutorial: cTSWin's arrow, 0x32 lower, with the arrow cursor. */
  hiliteForTutorial(ctx: GameContext, on: boolean): Promise<void> {
    return hiliteForTutorial(ctx, this, on, true);
  }

  /** cWinLotBtn::LoadHouseInfo */
  async loadHouseInfo(house: number): Promise<boolean> {
    const info = await getHouseInfo(this.nb, house);
    if (!info) return false;
    this.info = info;
    this.houseNumber = house;
    const thumb = this.small ? info.thumbSmall : info.thumb;
    const roof = this.small ? info.roofSmall : info.roof;
    this.anchor = this.small ? info.thmbSmall : info.thmb;
    if (!thumb) return false;
    if (!roof) {
      this.hasRoof = false;
      this.setImage(thumb, 1);
      return true;
    }
    // Frame size: the union of the house and the offset roof.
    const dx = this.anchor?.dx ?? 0;
    const dy = this.anchor?.dy ?? 0;
    const w = dx < 0 ? Math.max(thumb.width - dx, roof.width) : Math.max(thumb.width, roof.width + dx);
    const h = dy < 0 ? Math.max(thumb.height - dy, roof.height) : Math.max(thumb.height, roof.height + dy);
    const c = new OffscreenCanvas(w * 2, h);
    const g = c.getContext("2d")!;
    const hx = dx < 0 ? -dx : 0;
    const hy = dy < 0 ? -dy : 0;
    g.drawImage(thumb, hx, hy);
    g.drawImage(thumb, hx + w, hy);
    g.drawImage(roof, dx > 0 ? dx : 0, dy > 0 ? dy : 0);
    this.hasRoof = true;
    this.setImage(await createImageBitmap(c), 2);
    return true;
  }

  /** +0x230: the lot mode (cWinLotBtn::SetMode). */
  lotMode = 0;
  /** +0x248 / +0x24c: the image before Hilite, and whether a hilite is on. */
  private unhilited: ImageBitmap | null = null;
  private hilited = false;
  private hiliteSeq = 0;

  /**
   * cWinLotBtn::SetMode: mode 0 (regular) restores the rollover / click
   * sounds and plays them on enter and down (+0x148 = 5); modes 1 and 2
   * (move in / evict / rezone) only on enter (+0x148 = 1): the screen's
   * handlers play their own sounds.
   */
  setMode(mode: number): void {
    this.lotMode = mode;
    if (mode === 0) {
      this.overrideUISound(UI.nhoodRollover, UI.nhoodClick);
      this.uiSoundActions = UISOUND_ENTER | UISOUND_DOWN;
    } else if (mode === 1 || mode === 2) {
      this.uiSoundActions = UISOUND_ENTER;
    }
  }

  /** cWinLotBtn::HiliteForDisabled */
  hiliteForDisabled(on: boolean): void {
    this.hilite(on, 0xf2, 0, 0);
  }

  /** cWinLotBtn::HiliteForResidential */
  hiliteForResidential(on: boolean): void {
    this.hilite(on, 0, 200, 0);
  }

  /** cWinLotBtn::HiliteForCommunity */
  hiliteForCommunity(on: boolean): void {
    this.hilite(on, 0, 0, 0xff);
  }

  /** cWinLotBtn::HiliteForImport */
  hiliteForImport(on: boolean): void {
    this.hilite(on, 0xf2, 0xff, 0x1d);
  }

  /**
   * cWinLotBtn::Hilite: on, the button image is replaced by a copy where,
   * row by row from the left, every transparent pixel paints its opaque
   * right / left neighbors with the color (so the sprite gets a horizontal
   * outline; a right neighbor painted before its turn is then brightened
   * like the rest), and every opaque pixel is brightened (BrightenColor with
   * scale 1, offset 0.09: luma + 0.09 in YIQ, lbl_105BC74C). Off restores
   * the saved image. Turning it on while on does nothing.
   */
  hilite(on: boolean, r: number, g: number, b: number): void {
    if (on === this.hilited) return;
    const seq = ++this.hiliteSeq;
    if (!on) {
      this.hilited = false;
      if (this.unhilited) this.setImage(this.unhilited, this.cols);
      this.unhilited = null;
      return;
    }
    const img = this.image;
    if (!img) return;
    this.hilited = true;
    this.unhilited = img;
    const c = new OffscreenCanvas(img.width, img.height);
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, img.height);
    hilitePixels(data, r, g, b);
    ctx.putImageData(data, 0, 0);
    void createImageBitmap(c).then((bmp) => {
      if (seq === this.hiliteSeq && this.hilited) this.setImage(bmp, this.cols);
    });
  }

  /** cWinLotBtn::ReloadThumbnail: the house info and bitmaps again (after an evict or a rezone). */
  async reloadThumbnail(): Promise<void> {
    this.hilited = false;
    this.unhilited = null;
    this.hiliteSeq++;
    if (!(await this.loadHouseInfo(this.houseNumber))) return;
    const p = this.lotPoint();
    this.centerOn(p.x, p.y);
  }

  /** cWinLotBtn::CenterOn */
  centerOn(x: number, y: number): void {
    const w = this.getW();
    const h = this.getH();
    const a = this.anchor;
    if (!a) {
      const left = x - Math.trunc(w / 2);
      const top = y - Math.trunc(h / 2);
      this.setArea(left, top, left + w, top + h);
      return;
    }
    const left = x - a.x;
    const top = y - a.y - a.z;
    this.setArea(left, top, left + w, top + h);
  }

  /** The lot location adjusted by negative roof offsets, as passed to CenterOn by the owner. */
  lotPoint(): { x: number; y: number } {
    const info = this.info!;
    const a = this.anchor;
    return {
      x: info.lotX + (a && a.dx < 0 ? a.dx : 0),
      y: info.lotY + (a && a.dy < 0 ? a.dy : 0),
    };
  }

  private rampValue(now: number): number {
    const t = (now - this.rampStart) / DISSOLVE_MS;
    return t >= 1 ? 1 : this.rampFrom + (1 - this.rampFrom) * Math.max(0, t);
  }

  /** cWinLotBtn::CalcRowCol: restart the dissolve ramp when the column changes. */
  private calcRowCol(): void {
    const col = this.frameColumn();
    if (col === this.lastColumn) return;
    this.lastColumn = col;
    const now = performance.now();
    const v = this.rampValue(now);
    this.rampFrom = v < 1 ? 1 - v : 0;
    this.rampStart = now;
  }

  override tsOnMouseEnter(): void {
    super.tsOnMouseEnter();
    this.calcRowCol();
    this.owner.lotEntered(this);
  }

  override tsOnMouseExit(): void {
    super.tsOnMouseExit();
    this.calcRowCol();
    this.owner.lotExited(this);
  }

  override tsOnMouseMove(x: number, y: number): boolean {
    super.tsOnMouseMove(x, y);
    this.calcRowCol();
    return true;
  }

  /** cWinLotBtn::ImageBlt */
  override tsPaint(g: Gfx): void {
    const img = this.image;
    if (!img) return;
    const w = this.getW();
    const h = this.getH();
    const ctx = g.ctx;
    ctx.save();
    if (this.clip) {
      // The clip is in the parent's coordinates; g's origin is this button's.
      const px = g.ox - this.area.left;
      const py = g.oy - this.area.top;
      ctx.beginPath();
      ctx.rect(px + this.clip.left, py + this.clip.top, this.clip.right - this.clip.left, this.clip.bottom - this.clip.top);
      ctx.clip();
    }
    const allow = this.owner.shouldAllowRoofDissolve(this);
    const col = this.hasRoof && allow ? this.frameColumn() : 0;
    const v = this.rampValue(performance.now());
    if (!this.hasRoof || !allow || v >= 1) {
      g.blitPart(img, col * w, 0, w, h, 0, 0);
    } else {
      const alpha = Math.min(255, Math.max(0, Math.trunc(0.5 + 255 * v)));
      g.blitPart(img, (col === 0 ? 1 : 0) * w, 0, w, h, 0, 0);
      ctx.globalAlpha = alpha / 255;
      g.blitPart(img, col * w, 0, w, h, 0, 0);
    }
    ctx.restore();
  }
}

/** BrightenColor(rgb, 1.0, 0.09): RGB -> YIQ, Y + 0.09, back to RGB, clamped. */
function brighten(r: number, g: number, b: number): [number, number, number] {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const y = 1.0 * (0.114 * B + 0.299 * R + 0.587 * G) + 0.09;
  const u = 0.434 * B - 0.146 * R - 0.288 * G;
  const v = 0.617 * R - 0.517 * G - 0.1 * B;
  const clamp = (x: number): number => Math.trunc(255 * Math.min(1, Math.max(0, x)) + 0.5);
  return [clamp(1.136 * v - 0.001 * u + y), clamp(y - 0.396 * u - 0.578 * v), clamp(y + 2.041 * u - 0.002 * v)];
}

/** The pixel loop of cWinLotBtn::Hilite (transparent = alpha 0, the color key). */
function hilitePixels(img: ImageData, r: number, g: number, b: number): void {
  const { width: w, height: h, data: d } = img;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (d[i + 3] === 0) {
        const set = (j: number): void => {
          d[j] = r;
          d[j + 1] = g;
          d[j + 2] = b;
          d[j + 3] = 255;
        };
        if (x < w - 1 && d[i + 7] !== 0) set(i + 4);
        if (x > 0 && d[i - 1] !== 0) set(i - 4);
      } else {
        const [nr, ng, nb] = brighten(d[i]!, d[i + 1]!, d[i + 2]!);
        d[i] = nr;
        d[i + 1] = ng;
        d[i + 2] = nb;
      }
    }
  }
}
