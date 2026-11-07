/**
 * cWinLivePopup / cWinLivePopupClient — the description popup that rises
 * above the control panel (options labels, camera buttons, Live mode pages),
 * and the cTSWinBtn "async" timer the panels use to open it on hover.
 *
 * cWinLivePopup (Init, RebuildBuffer, EnablePopup, DisablePopup, TSPaint):
 *  - 559 px wide (0x22f); the body text wraps between the panes:
 *    x 168..372 with both panes, 5 / 535 when a pane is missing; the height
 *    is the title line plus the wrapped description plus 24, at least 127;
 *  - the background is the popup tiles (system bitmap 5, kCatalogPopupBackTiles)
 *    drawn with BltEdge in 3x3 cells; pane 0 is (0, 0)-(168, 127), pane 1
 *    (372, 0)-(540, 127), each bitmap centered in its pane;
 *  - title in the size 10 table font at (x + 10, 12), description in the
 *    size 9 font right under it;
 *  - it sits right-aligned on its target window, just above it (50 px lower
 *    when the target is the 150 px tall Live panel), in the lot view;
 *  - opening slides it up from behind the panel over 250 ms (RampGenerator
 *    0 -> 1, the top rows hidden); closing slides it back down, then hides it
 *    and tells the client (which resets its button). With interface effects
 *    (BoboVision) on it fades instead (alpha = 255 * ramp).
 *
 * A pane (cWinLivePopupClient+0x2c, type at +0) is empty (0), an object (1,
 * SetObject / the constructor's ObjSelector arguments) or a bitmap (2,
 * SetBitmap). RebuildBuffer clears the z-buffer over each pane, then
 * DrawPane: a bitmap is centered in the pane; an object goes through
 * DrawObjectIcon (ObjectIcon.cpp): SetupDrawIconic draws only when the pane
 * lies inside the buffer, then cXObject::DrawIconic draws the object itself
 * from its sprites (no catalog picture) with graphic index +0x34 (0 for
 * SetObject), no IconProps (no shadow, no highlight), and the scale
 * SetSpecialScale stored at +0x4c when not 0 (else the largest of 3, 2, 1
 * that fits), centered in the pane. A part of a multi-tile object draws
 * nothing (DrawIconic only draws masters and single-tile objects).
 * SetObject and SetBitmap reset the special scale to 0.
 */

import { hudLayoutWidth, type GameContext } from "../context.js";
import { ObjectFolder } from "../world/objectfolder.js";
import type { ObjSelector } from "../world/objselector.js";
import { ObjectIcon } from "./buy/objecticon.js";
import { soundPlayer, UI } from "../audio/index.js";
import { getOptionsMgr } from "../optionsmgr.js";
import { ALIGN_LEFT, type FfnFont } from "../res/ffn.js";
import { DOUBLE_BYTE_UI, UI_LANGUAGE } from "../res/uires.js";
import { SYS_POPUP_TILES, TSWinCtrlMgr } from "../ui/ctrlmgr.js";
import { bltEdge } from "../ui/dlg.js";
import { ASYNC_ON_DOWN, ASYNC_ON_ENTER, ASYNC_ON_UP, CMD_ASYNC_EXIT, CMD_ASYNC_TIMEOUT, type TSWinBtn } from "../ui/btn.js";
import { UI_FONT_COLOR } from "../ui/syscolors.js";
import { Gfx, TSWin, type Rect } from "../ui/tswin.js";
import { CaptionBtn } from "./live/captionbtn.js";

/** cTSWinBtn::SendButtonCommand ids. */
export const CMD_CLICK = 1;
export { ASYNC_ON_DOWN, ASYNC_ON_ENTER, ASYNC_ON_UP, CMD_ASYNC_EXIT, CMD_ASYNC_TIMEOUT };

/** A captioned/bitmap button with cTSWinBtn's async timer (TSWinBtn.setAsync). */
export class AsyncBtn extends CaptionBtn {}

/** One of the two panes (cWinLivePopupClient+0x2c, 0x28 bytes each): a bitmap or a part of one, or an object. */
interface Pane {
  bitmap: ImageBitmap | null;
  /** SetBitmap(int, cTSBuffer*, cTSRect*): the part of the bitmap shown, null = all of it. */
  rect: Rect | null;
  /** +4 of a type 1 pane: the object (SetObject). */
  object: ObjSelector | null;
  /** +8: the graphic index DrawObjectIcon draws. */
  graphic: number;
  /** +0x20 (SetSpecialScale): DrawIconic's scale, 0 = the largest that fits. */
  scale: number;
}

const emptyPane = (): Pane => ({ bitmap: null, rect: null, object: null, graphic: 0, scale: 0 });

/** cXObject::DrawIconic's view of each selector (its sprites and draw groups), made once. */
const objectIcons = new Map<ObjSelector, Promise<ObjectIcon | null>>();
const readyIcons = new Map<ObjSelector, ObjectIcon | null>();

function objectIcon(sel: ObjSelector): Promise<ObjectIcon | null> {
  let p = objectIcons.get(sel);
  if (!p) {
    p = ObjectIcon.create(sel.res, sel.objdId).catch(() => null);
    p.then((icon) => readyIcons.set(sel, icon));
    objectIcons.set(sel, p);
  }
  return p;
}

/**
 * ObjectFolder::GetSelectorByGUID over the current neighborhood's folder
 * (cSimsApp+0x28): null for 0 or an unknown GUID.
 */
export async function popupObject(ctx: GameContext, guid: number): Promise<ObjSelector | null> {
  if (guid === 0) return null;
  const folder = await ObjectFolder.get(ctx.hooks?.neighborhoodDir?.() ?? "UserData");
  return folder.getSelectorByGUID(guid);
}

/** cWinLivePopupClient: what a popup shows and which button opened it. */
export class WinLivePopupClient {
  /** +4 / +0xc */
  name = "";
  desc = "";
  /** +0x14: the button the popup belongs to. */
  target: TSWinBtn | null = null;
  /** +0x18: owner tag ("options", "camera"). */
  kind = "";
  /** +0x80: reset the target button when the popup closes. */
  resetTargetOnClose = true;
  /** +0x7c */
  popup: WinLivePopup | null = null;
  readonly panes: [Pane, Pane] = [emptyPane(), emptyPane()];

  constructor(name = "", desc = "") {
    this.name = name;
    this.desc = desc;
  }

  /** cWinLivePopupClient::SetSpecialScale */
  setSpecialScale(pane: 0 | 1, scale: number): void {
    this.panes[pane].scale = scale;
  }

  /** cWinLivePopupClient::SetPopup */
  setPopup(p: WinLivePopup | null): void {
    if (!p && this.resetTargetOnClose) this.target?.setState(0);
    this.popup = p;
  }

  setName(s: string): void {
    this.name = s;
    this.popup?.rebuildBuffer();
  }

  setDesc(s: string): void {
    this.desc = s;
    this.popup?.rebuildBuffer();
  }

  /** cWinLivePopupClient::SetBitmap(int, cTSBuffer*[, cTSRect*]): null clears the pane. */
  setBitmap(pane: 0 | 1, bitmap: ImageBitmap | null, rect: Rect | null = null): void {
    this.panes[pane] = { ...emptyPane(), bitmap, rect };
    this.popup?.rebuildBuffer();
  }

  /**
   * cWinLivePopupClient::SetObject: null clears the pane. The object's
   * sprites load in the background; the popup is rebuilt once they are in.
   */
  setObject(pane: 0 | 1, sel: ObjSelector | null): void {
    this.panes[pane] = { ...emptyPane(), object: sel };
    if (sel && !readyIcons.has(sel)) {
      void objectIcon(sel).then(() => {
        if (this.panes[pane].object === sel) this.popup?.rebuildBuffer();
      });
    }
    this.popup?.rebuildBuffer();
  }

  /** cWinLivePopupClient::HasPane: the pane's type is not 0. */
  hasPane(pane: number): boolean {
    if (pane !== 0 && pane !== 1) return false;
    const p = this.panes[pane];
    return p.bitmap !== null || p.object !== null;
  }

  /** cWinLivePopupClient::DrawPane into the popup's buffer, inside `r`. */
  drawPane(pane: 0 | 1, g: Gfx, bufW: number, bufH: number, r: Rect): void {
    const { bitmap: bmp, rect: src, object, graphic, scale } = this.panes[pane];
    if (bmp) {
      // Centered when smaller than the pane.
      const s = src ?? { left: 0, top: 0, right: bmp.width, bottom: bmp.height };
      const bw = s.right - s.left;
      const bh = s.bottom - s.top;
      let x = r.left;
      let y = r.top;
      if (bw < r.right - r.left) x += Math.trunc((r.right - r.left - bw) / 2);
      if (bh < r.bottom - r.top) y += Math.trunc((r.bottom - r.top - bh) / 2);
      g.blitPart(bmp, s.left, s.top, bw, bh, x, y);
      return;
    }
    if (!object) return;
    // DrawObjectIcon: SetupDrawIconic fails unless the rectangle lies inside the buffer.
    if (r.left < 0 || r.top < 0 || r.right > bufW || r.bottom > bufH || r.left >= r.right || r.top >= r.bottom) return;
    // cXObject::DrawIconic returns at once for a part of a multi-tile object.
    if (object.objd.masterId !== 0 && object.objd.subIndex !== -1) return;
    const icon = readyIcons.get(object);
    icon?.draw(g.ctx, r.left, r.top, r.right - r.left, r.bottom - r.top, null, graphic, scale !== 0 ? scale : null);
  }
}

const POPUP_W = 0x22f;
const MIN_H = 0x7f;
const PANE_RECTS = [
  { left: 0, top: 0, right: 0xa8, bottom: 0x7f },
  { left: 0x174, top: 0, right: 0x21c, bottom: 0x7f },
];
const SLIDE_MS = 250;

interface Ramp {
  from: number;
  to: number;
  start: number;
}

export class WinLivePopup extends TSWin {
  private tiles: ImageBitmap | null = null;
  private titleFont: FfnFont | null = null;
  private bodyFont: FfnFont | null = null;
  private buffer: OffscreenCanvas | null = null;
  /** +0xd8 */
  private enabled = false;
  /** +0x108: closing (the ramp runs down). */
  private closing = false;
  private ramp: Ramp = { from: 0, to: 0, start: -Infinity };
  /** +0x104 */
  private client: WinLivePopupClient | null = null;
  /** +0x10c: the window the popup is attached to. */
  private targetWin: TSWin | null = null;

  constructor(readonly ctx: GameContext) {
    super();
  }

  /** cWinLivePopup::Init */
  override async init(): Promise<boolean> {
    const mgr = await TSWinCtrlMgr.get(this.ctx);
    this.tiles = mgr.systemBMP(SYS_POPUP_TILES);
    this.titleFont = mgr.tableFont(10);
    this.bodyFont = mgr.tableFont(9);
    this.setArea(this.area.left, this.area.top, this.area.left + POPUP_W, this.area.top + MIN_H);
    this.hideWindow();
    return true;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getClient(): WinLivePopupClient | null {
    return this.client;
  }

  /** cWinLivePopup::EnablePopup */
  enablePopup(client: WinLivePopupClient | null, target: TSWin): void {
    this.targetWin = target;
    if (this.enabled) return;
    this.enabled = true;
    // The popup lives in the lot view (cSimsApp+0x80): the target's top-level window.
    if (!this.parent) {
      const host = hostOf(target);
      host?.childAdd(this);
      // cWinPeople::Init adds it while cWinCPanel is being added (child_add_absolute inits the
      // child before listing it): it lies right behind the control panel, which hides its bottom
      // (the 50 extra rows of a double-byte UI).
      let panel: TSWin = target;
      while (panel.parent && panel.parent !== host) panel = panel.parent;
      if (host && panel.parent === host) {
        host.children.splice(host.children.indexOf(this), 1);
        host.children.splice(host.children.indexOf(panel) + 1, 0, this);
      }
    }
    this.showWindow();
    this.setClient(client);
    const now = performance.now();
    if (!this.closing) {
      soundPlayer.playUISound(UI.whoosh);
      this.ramp = { from: 0, to: 1, start: now };
    } else {
      this.ramp = { from: this.rampValue(now), to: 1, start: now };
      this.closing = false;
    }
  }

  /** cWinLivePopup::DisablePopup */
  disablePopup(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.ramp = { from: 1, to: 0, start: performance.now() };
    soundPlayer.playUISound(UI.whoosh);
    this.closing = true;
  }

  /** cWinLivePopup::SetClient */
  setClient(client: WinLivePopupClient | null): void {
    const old = this.client;
    if (old?.target && (!client || old.target !== client.target)) old.setPopup(null);
    this.client = client;
    client?.setPopup(this);
    this.rebuildBuffer();
  }

  /** cWinLivePopup::RebuildBuffer */
  rebuildBuffer(): void {
    const title = this.titleFont;
    const body = this.bodyFont;
    if (!title || !body) return;
    const c = this.client;
    let textLeft = 0;
    let textRight = 0x21c;
    let textBottom = MIN_H;
    if (c) {
      textLeft = c.hasPane(0) ? PANE_RECTS[0]!.right : 5;
      // Without a right pane the text reaches 0x217 (0x212 in Thai).
      textRight = c.hasPane(1) ? PANE_RECTS[1]!.left : UI_LANGUAGE === 0x13 ? 0x212 : 0x217;
      textBottom =
        title.height + body.calculateNumberOfLines(c.desc, textRight - textLeft) * body.height;
      if (textBottom + 0x18 < MIN_H) textBottom = 0x67;
    }
    // A double-byte UI makes the buffer 50 px taller: its bottom stays behind the 150 px high page.
    const h = textBottom + 0x18 + (DOUBLE_BYTE_UI ? 0x32 : 0);
    const buf = new OffscreenCanvas(POPUP_W, h);
    const g = new Gfx(buf.getContext("2d") as unknown as CanvasRenderingContext2D, 0, 0);
    if (this.tiles)
      bltEdge(
        g,
        this.tiles,
        Math.trunc(this.tiles.width / 3),
        Math.trunc(this.tiles.height / 3),
        POPUP_W,
        h,
        true,
      );
    this.setArea(this.area.left, this.area.top, this.area.left + POPUP_W, this.area.top + h);
    if (c) {
      PANE_RECTS.forEach((r0, i) => {
        const r = { ...r0 };
        let target = h;
        // The right pane is centered over the part above that band in a double-byte UI,
        // the left one over the part above the 1024-wide panel's 50 px band.
        if (i === 1 && DOUBLE_BYTE_UI) target -= 0x32;
        else if (i === 0 && hudLayoutWidth(this.ctx) === 0x400) target -= 0x32;
        const ph = r.bottom - r.top;
        if (ph < target) {
          let d = Math.trunc((target - ph) / 2) - r.top;
          r.top += d;
          r.bottom += d;
          if (h < r.bottom) {
            d = h - r.bottom;
            r.top += d;
            r.bottom += d;
          }
          d = Math.trunc((target - ph) / 2) - 5;
          r.top -= d;
          r.bottom += d;
        }
        if (c.hasPane(i)) c.drawPane(i as 0 | 1, g, POPUP_W, h, r);
      });
      const titleRect = {
        left: textLeft + 10,
        top: 12,
        right: textRight + 10,
        bottom: 12 + title.height,
      };
      title.drawTextPara(g.ctx, titleRect, c.name, ALIGN_LEFT, UI_FONT_COLOR);
      const descRect = {
        left: textLeft + 10,
        top: title.height + 12,
        right: textRight + 10,
        bottom: textBottom + 12,
      };
      body.drawTextPara(g.ctx, descRect, c.desc, ALIGN_LEFT, UI_FONT_COLOR);
    }
    this.buffer = buf;
    this.placeOverTarget();
  }

  /** End of RebuildBuffer: right-aligned on the target, just above it. */
  private placeOverTarget(): void {
    const t = this.targetWin;
    const host = this.parent;
    if (!t || !host) return;
    const to = t.absOrigin();
    const ho = host.absOrigin();
    let top = to.y - ho.y;
    const right = to.x - ho.x + t.getW();
    if (t.getH() === 0x96) top += 0x32;
    const w = this.getW();
    const h = this.getH();
    this.setArea(right - w, top - h, right, top);
  }

  private rampValue(now: number): number {
    const t = (now - this.ramp.start) / SLIDE_MS;
    if (t >= 1) return this.ramp.to;
    return this.ramp.from + (this.ramp.to - this.ramp.from) * Math.max(0, t);
  }

  private rampRunning(now: number): boolean {
    return now < this.ramp.start + SLIDE_MS;
  }

  /** The end of a close (TSPaint once the ramp is over). */
  override pump(nowMs: number): void {
    super.pump(nowMs);
    if (!this.enabled && this.closing && !this.rampRunning(nowMs)) {
      this.hideWindow();
      this.client?.setPopup(null);
      this.client = null;
      this.rebuildBuffer();
      this.closing = false;
    }
  }

  /** cWinLivePopup::TSPaint */
  override tsPaint(g: Gfx): void {
    const buf = this.buffer;
    const w = this.getW();
    const h = this.getH();
    if (!buf || w === 0 || h === 0) return;
    const now = performance.now();
    const running = this.rampRunning(now);
    if (!running && !this.enabled) return;
    const ramp = this.rampValue(now);
    if (!getOptionsMgr().getBoboVision()) {
      const off = running ? Math.trunc(0.5 + h * (1 - ramp)) : 0;
      g.blitPart(buf, 0, 0, w, h - off, 0, off);
    } else if (running) {
      const a = g.ctx.globalAlpha;
      g.ctx.globalAlpha = Math.trunc(0.5 + 255 * ramp) / 255;
      g.blit(buf, 0, 0);
      g.ctx.globalAlpha = a;
    } else {
      g.blit(buf, 0, 0);
    }
  }
}

/**
 * The click pattern of cWinPeople::TSOnCommand and its subpanels for a
 * button with a popup: open the popup on `client` for `owner` (EnablePopup),
 * close it when it already shows `target` (DisablePopup), else move it to
 * `target` (the previous target pops up, SetupClient, SetClient). `setup`
 * fills the client for its new target (SetupClient / UpdateClient).
 */
export function popupClick(
  popup: WinLivePopup,
  client: WinLivePopupClient,
  owner: TSWin,
  target: TSWinBtn,
  setup?: () => void,
): void {
  if (!popup.isEnabled()) {
    client.target = target;
    setup?.();
    popup.enablePopup(client, owner);
  } else if (popup.getClient()?.target === target) {
    popup.disablePopup();
  } else {
    if (client.target && client.target !== target) client.target.setState(0);
    client.target = target;
    setup?.();
    popup.setClient(client);
  }
}

/** The window right under the root that holds `w` (the lot view for the control panel). */
function hostOf(w: TSWin): TSWin | null {
  let cur: TSWin = w;
  while (cur.parent?.parent) cur = cur.parent;
  return cur.parent ? cur : null;
}
