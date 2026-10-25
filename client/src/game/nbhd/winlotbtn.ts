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

import { TSWinBtn } from "../ui/btn.js";
import { WF_HIT_ALPHA, type Gfx, type Rect } from "../ui/tswin.js";
import { getHouseInfo, type HouseInfo, type Neighborhood, type Thmb } from "./nghinterface.js";

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
