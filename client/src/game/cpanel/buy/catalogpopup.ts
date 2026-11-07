/**
 * cWinCatalogPopup: the product sheet that slides up above the catalog.
 *
 * Init: 0x22f x 0x7f, the control manager's system bitmap 5
 * (kCatalogPopupBackTiles) as background, the global font table's size 8
 * (text) and size 10 (title) fonts, UIText STR# 160: the rating formats
 * (entries 1..14) and the restriction lines (15 adults, 16 children,
 * 17 group activity, 18 pets, 19 dogs, 20 cats).
 *
 * BuildMyBuffer:
 *  - the object picture (DrawDefaultObjectIcon) in (0, 0)-(0xa8, height);
 *  - at (0xb2, 0xc): name, " -- ", price, in the title font;
 *  - below, the description wrapped to width - 0xc (- 0x11 in Thai), then the non-zero
 *    ratings (motives as "%d" formats, skills as their name), one per line,
 *    then the age/species restriction and the group activity line, these in
 *    green (InitSimsColors lbl_105BA7C4);
 *  - height: the text's bottom + 0xc, at least 0x7f;
 *  - a red (255, 0, 0) 4 px outline inset by 4 around the picture when the
 *    family cannot afford the product;
 *  - placed right-aligned with the catalog, just above it, in the root window.
 * EnablePopup slides it in over 250 ms (RampGenerator, TSPaint shows the
 * buffer's top rows shifted down); entering it with the mouse hides it
 * (TSOnMouseEnter -> DisablePopup).
 */

import { soundPlayer, UI } from "../../audio/index.js";
import type { GameContext } from "../../context.js";
import { OBJD, Product } from "../../data/catalog.js";
import { makeMoneyString } from "../../nbhd/nghinterface.js";
import { ALIGN_LEFT, type FfnFont } from "../../res/ffn.js";
import { UI_LANGUAGE } from "../../res/uires.js";
import { SYS_POPUP_TILES, TSWinCtrlMgr } from "../../ui/ctrlmgr.js";
import { rgb, UI_FONT_COLOR } from "../../ui/syscolors.js";
import { Gfx, TSWin } from "../../ui/tswin.js";
import type { ResFile } from "../../world/iffres.js";
import { engine } from "../../../engine/wasm.js";
import { ObjectIcon } from "./objecticon.js";

const WIDTH = 0x22f;
const MIN_HEIGHT = 0x7f;
const ICON_W = 0xa8;
const TEXT_X = 0xb2;
const TEXT_Y = 0xc;
const MARGIN = 0xc;
/** UIText STR# 160 */
const STR_POPUP = 0xa0;
const SEPARATOR = " -- ";
const GREEN = rgb(0, 0xca, 0x39);
const RED = rgb(0xff, 0, 0);
const SLIDE_MS = 0xfa;

/**
 * What the sheet reads from a product: object products are data/catalog
 * Products (picture from the object's sprites, restrictions from its tree
 * table); the build mode tool, floor and wall products draw their own
 * picture (Product::DrawIcon) and have no ratings.
 */
export interface PopupProduct {
  getProductName(): string;
  getPrice(): number;
  getDescription(): string;
  getCatalogRating(i: number): number;
  canAfford(funds: number): boolean;
  /** Product::DrawIcon into (0, 0, w, h) of `g`. */
  drawPopupIcon?(ctx: GameContext, g: CanvasRenderingContext2D, w: number, h: number): Promise<void>;
}

/** Restriction kinds in BuildMyBuffer's order, with their STR# 160 entry (0-based). */
const enum Restriction {
  Adults = 0,
  Children = 1,
  Dogs = 2,
  Cats = 3,
  Pets = 4,
  None = 5,
}
const RESTRICTION_STR = [14, 15, 18, 19, 17];
const STR_GROUP = 16;

/** TTAB interaction flags tested by the ObjSelector age/species predicates. */
const TT_NO_CHILD = 1 << 4;
const TT_NO_ADULT = 1 << 6;
const TT_DEBUG = 1 << 7;
const TT_ALLOW_CATS = 1 << 9;
const TT_ALLOW_DOGS = 1 << 10;

interface Interaction {
  flags: number;
  joiningIndex: number;
}

/**
 * ObjSelector::AdultsOnly, ChildrenOnly, PetsOnly, CatsOnly, DogsOnly: every
 * visible (non-debug) interaction matches, and there is at least one.
 */
function every(list: Interaction[], ok: (f: number) => boolean): boolean {
  const visible = list.filter((i) => (i.flags & TT_DEBUG) === 0);
  return visible.length > 0 && visible.every((i) => ok(i.flags));
}

function restriction(list: Interaction[]): Restriction {
  const no = (f: number, b: number): boolean => (f & b) !== 0;
  if (every(list, (f) => no(f, TT_NO_CHILD) && !no(f, TT_ALLOW_CATS) && !no(f, TT_ALLOW_DOGS))) return Restriction.Adults;
  if (every(list, (f) => no(f, TT_NO_ADULT) && !no(f, TT_ALLOW_CATS) && !no(f, TT_ALLOW_DOGS))) return Restriction.Children;
  if (every(list, (f) => no(f, TT_NO_ADULT) && no(f, TT_NO_CHILD))) return Restriction.Pets;
  if (every(list, (f) => no(f, TT_NO_ADULT) && no(f, TT_NO_CHILD) && !no(f, TT_ALLOW_DOGS))) return Restriction.Cats;
  if (every(list, (f) => no(f, TT_NO_ADULT) && no(f, TT_NO_CHILD) && !no(f, TT_ALLOW_CATS))) return Restriction.Dogs;
  return Restriction.None;
}

/** ObjSelector::HasGroupActions: a visible interaction that joins another one of the table. */
function hasGroupActions(list: Interaction[]): boolean {
  return list.some((i) => (i.flags & TT_DEBUG) === 0 && i.joiningIndex >= 0 && i.joiningIndex < list.length);
}

/** The selector's tree table (OBJD +0x0e) in the object's own file. */
async function interactions(file: ResFile, p: Product): Promise<Interaction[]> {
  const id = p.field(OBJD.treeTableId);
  const data = file.get("TTAB", id);
  if (!data) return [];
  try {
    const wasm = await engine();
    const t = wasm.parseTtab(data) as { interactions: Interaction[] };
    return t.interactions.map((i) => ({ flags: i.flags, joiningIndex: i.joiningIndex | 0 }));
  } catch {
    return [];
  }
}

export class WinCatalogPopup extends TSWin {
  /** cWinCatalogPopup+0xe0 */
  shown = false;
  private product: PopupProduct | null = null;
  private owner: TSWin | null = null;
  private tiles: ImageBitmap | null = null;
  private textFont: FfnFont | null = null;
  private titleFont: FfnFont | null = null;
  private strings: string[] = [];
  private buffer: OffscreenCanvas | null = null;
  private slideStart = 0;
  private serial = 0;

  constructor(private readonly ctx: GameContext) {
    super();
  }

  override async init(): Promise<boolean> {
    const mgr = await TSWinCtrlMgr.get(this.ctx);
    this.tiles = mgr.systemBMP(SYS_POPUP_TILES);
    this.setArea(this.area.left, this.area.top, this.area.left + WIDTH, this.area.top + MIN_HEIGHT);
    this.textFont = mgr.tableFont(8);
    this.titleFont = mgr.tableFont(10);
    this.strings = this.ctx.strings.list("UIText", STR_POPUP);
    return true;
  }

  /** cWinCatalogPopup::EnablePopup */
  enablePopup(product: PopupProduct, owner: TSWin): void {
    this.shown = true;
    this.owner = owner;
    this.setProductInfo(product);
    const root = rootOf(owner);
    if (this.parent !== root) {
      root.childAdd(this);
      // PlayBySource("UI_whoosh" lbl_105BC3B8 + 5, -4)
      soundPlayer.playUISound(UI.whoosh);
      this.slideStart = performance.now();
    }
  }

  /** cWinCatalogPopup::DisablePopup */
  disablePopup(): void {
    this.shown = false;
    this.parent?.childRemove(this);
  }

  /** cWinCatalogPopup::SetProductInfo */
  setProductInfo(product: PopupProduct): void {
    this.product = product;
    void this.buildMyBuffer(product);
  }

  override tsOnMouseEnter(): void {
    this.disablePopup();
  }

  /** cWinCatalogPopup::BuildMyBuffer */
  private async buildMyBuffer(p: PopupProduct): Promise<void> {
    const serial = ++this.serial;
    const text = this.textFont!;
    const title = this.titleFont!;
    // The text's right edge: width - 0xc (width - 0x11 in Thai).
    const right = WIDTH - (UI_LANGUAGE === 0x13 ? 0x11 : MARGIN);
    const textW = right - TEXT_X;
    const lines = (s: string): number => (s ? text.calculateNumberOfLines(s, textW) : 0);

    const descTop = TEXT_Y + title.height;
    const descBottom = descTop + lines(p.getDescription()) * text.height;
    const ratings: string[] = [];
    for (let i = 0; i < 14; i++) {
      const v = p.getCatalogRating(i);
      if (v === 0) continue;
      const fmt = this.strings[i] ?? "";
      ratings.push(i < 7 ? fmt.replace("%d", String(v)) : fmt);
    }
    const ratingText = ratings.join("\n");
    const ratingBottom = descBottom + lines(ratingText) * text.height;

    const obj = p instanceof Product ? p : null;
    const file = obj ? await obj.openFile().catch(() => null) : null;
    if (serial !== this.serial) return;
    const list = obj && file ? await interactions(file, obj) : [];
    const restrict = restriction(list);
    const restrictBottom = ratingBottom + (restrict !== Restriction.None ? text.height : 0);
    const group = hasGroupActions(list);
    const groupBottom = restrictBottom + (group ? text.height : 0);
    const height = Math.max(MIN_HEIGHT, groupBottom + MARGIN);
    const icon = obj && file ? await ObjectIcon.create(file, obj.rec.objdId).catch(() => null) : null;
    if (serial !== this.serial) return;

    const c = new OffscreenCanvas(WIDTH, height);
    const g = c.getContext("2d") as unknown as CanvasRenderingContext2D;
    if (this.tiles) bltEdge(g, this.tiles, WIDTH, height);
    if (icon) icon.draw(g, 0, 0, ICON_W, height);
    else await p.drawPopupIcon?.(this.ctx, g, ICON_W, height);
    if (serial !== this.serial) return;

    // Title line: name, separator, price.
    let x = TEXT_X;
    const name = p.getProductName();
    title.drawText(g, name, x, TEXT_Y, UI_FONT_COLOR);
    x += title.stringWidth(name);
    title.drawText(g, SEPARATOR, x, TEXT_Y, UI_FONT_COLOR);
    x += title.stringWidth(SEPARATOR);
    title.drawText(g, makeMoneyString(p.getPrice(), UI_LANGUAGE), x, TEXT_Y, UI_FONT_COLOR);

    text.drawTextPara(g, { left: TEXT_X, top: descTop, right, bottom: descBottom }, p.getDescription(), ALIGN_LEFT, UI_FONT_COLOR);
    if (ratingBottom > descBottom) {
      text.drawTextPara(g, { left: TEXT_X, top: descBottom, right, bottom: ratingBottom }, ratingText, ALIGN_LEFT, GREEN);
    }
    if (restrict !== Restriction.None) {
      const s = this.strings[RESTRICTION_STR[restrict]!] ?? "";
      text.drawTextPara(g, { left: TEXT_X, top: ratingBottom, right, bottom: restrictBottom }, s, ALIGN_LEFT, GREEN);
    }
    if (group) {
      text.drawTextPara(g, { left: TEXT_X, top: restrictBottom, right, bottom: groupBottom }, this.strings[STR_GROUP] ?? "", ALIGN_LEFT, GREEN);
    }
    if (!p.canAfford(this.ctx.state.getFunds())) {
      g.fillStyle = RED;
      const [l, t, r, b] = [4, 4, ICON_W - 4, height - 4];
      g.fillRect(l, t, r - l, 4);
      g.fillRect(l, b - 4, r - l, 4);
      g.fillRect(l, t, 4, b - t);
      g.fillRect(r - 4, t, 4, b - t);
    }
    this.buffer = c;

    // Right-aligned with the catalog, its bottom on the catalog's top.
    const owner = this.owner;
    if (owner) {
      const o = owner.absOrigin();
      const left = o.x + owner.getW() - WIDTH;
      const top = o.y - height;
      this.setArea(left, top, left + WIDTH, top + height);
    }
  }

  override tsPaint(g: Gfx): void {
    const b = this.buffer;
    if (!b) return;
    const h = b.height;
    const t = (performance.now() - this.slideStart) / SLIDE_MS;
    const offset = t < 1 ? h - Math.trunc(h * t) : 0;
    g.blitPart(b, 0, 0, b.width, h - offset, 0, offset);
  }
}

function rootOf(w: TSWin): TSWin {
  let r = w;
  while (r.parent) r = r.parent;
  return r;
}

/** cTSBuffer 9-cell edge blit: corners, tiled edges and center, cells a third of the tiles bitmap. */
export function bltEdge(g: CanvasRenderingContext2D, t: ImageBitmap, w: number, h: number): void {
  const cw = Math.trunc(t.width / 3);
  const ch = Math.trunc(t.height / 3);
  const cell = (col: number, row: number, x: number, y: number, dw: number, dh: number): void => {
    for (let ty = 0; ty < dh; ty += ch) {
      for (let tx = 0; tx < dw; tx += cw) {
        const sw = Math.min(cw, dw - tx);
        const sh = Math.min(ch, dh - ty);
        g.drawImage(t, col * cw, row * ch, sw, sh, x + tx, y + ty, sw, sh);
      }
    }
  };
  const midW = w - 2 * cw;
  const midH = h - 2 * ch;
  cell(0, 0, 0, 0, cw, ch);
  cell(1, 0, cw, 0, midW, ch);
  cell(2, 0, w - cw, 0, cw, ch);
  cell(0, 1, 0, ch, cw, midH);
  cell(1, 1, cw, ch, midW, midH);
  cell(2, 1, w - cw, ch, cw, midH);
  cell(0, 2, 0, h - ch, cw, ch);
  cell(1, 2, cw, h - ch, midW, ch);
  cell(2, 2, w - cw, h - ch, cw, ch);
}
