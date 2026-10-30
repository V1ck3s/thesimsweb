/**
 * Lot rollover popup (cWinLotPopup): the tooltip window of every lot button.
 *
 * SetHouseInfo builds the text and two buffers sized to it:
 *  - the address line: StreetNames.iff STR# 2001 maps the house number to a
 *    street (1-based index into STR# 2000, a "%s Street" format fed with the
 *    house number); without the file, NghRollover entry 7;
 *  - a blank line, then the body: UIText STR# 134 "NghRollover" entry chosen by
 *    GetPopupIndex (0 family, 1 empty residential lot, 6 tutorial house,
 *    17 community lot), filled with the lot name and description
 *    (Houses/NeighborhoodDesc.iff STR# 2000 + house, entries 1 and 2, defaults
 *    NghRollover 22 and 23), the lot value, or the family name, net worth and
 *    friend count.
 * Width: the address line's width clamped to [150, 320]; height: wrapped line
 * count times the font height; 25 px margins; while the text is taller than
 * 2/3 of the width the width grows by half (twice at most). Family members'
 * 25x25 thumbnails go in one or two rows under the text.
 *
 * The background is kHotspotPopupTiler drawn edge-and-tile in 3x3 cells
 * (cTSBuffer::BltEdge); its alpha channel is the popup's alpha
 * (Compose -> AlphaBlend), text included.
 */

import type { GameContext } from "../context.js";
import { loadCharacter, neighborByGuid } from "../data/neighborhood.js";
import { ALIGN_LEFT, type FfnFont } from "../res/ffn.js";
import { decodeImage } from "../res/bmp.js";
import { LANG_FRENCH } from "../res/uires.js";
import { Gfx, TSWin } from "../ui/tswin.js";
import { loadStrSet, makeMoneyString, Zone, type HouseInfo, type Neighborhood } from "./nghinterface.js";

/** UIText STR# 134 "NghRollover" */
const STR_ROLLOVER = 134;
const ROLLOVER_COUNT = 0x27;
const MARGIN = 0x19;
const THUMB = 0x19;

/** Popup indices of GetPopupIndex reachable from the regular neighborhood mode. */
const POPUP_FAMILY = 0;
const POPUP_EMPTY_RESIDENTIAL = 1;
const POPUP_TUTORIAL = 6;
const POPUP_COMMUNITY = 0x11;

/** The global UI font table entry the popup draws with (index 10 = 10 pt) and its color (InitSimsColors). */
const FONT_SIZE = 10;
const TEXT_COLOR = "rgb(195,205,205)";

/**
 * cWinLotPopup +0xf8: the Magic Town screen (set by cWinLotPopup(cWinMagicland *)),
 * read by GetMagicPopupIndex for its residential lots (90..92).
 */
export interface MagicPopupSource {
  /** cWinMagicland +0xcc: the screen's mode (0 regular, 1 move in, 2 bulldoze, 4 visit). */
  mode(): number;
  /** cWinMagicland +0xe0 / +0xe4: the magicoin cost of a lot (house 91: STR# 134 entry 32, else 33). */
  cost(house: number): number;
  /** GetMagicPopupIndex's first store: cWinMagicland +0xd8 = the cost of the lot shown (the fee Move In charges). */
  setFee(cost: number): void;
  /** GetFamilyInfo(+0xd4): the moving family's name, funds (budget + net worth) and Family::GetMagiCoins; null without one. */
  movingFamily(): Promise<{ name: string; funds: number; coins: number } | null>;
  /** cWinMagicland::CalculateFamilyTokens(family): 0 for -1. */
  familyCoins(familyNumber: number): Promise<number>;
}

/** wsprintf with %s / %d only. */
function sprintf(fmt: string, ...args: Array<string | number>): string {
  let i = 0;
  return fmt.replace(/%[sd]/g, () => String(args[i++] ?? ""));
}

/** SetHouseInfo's locals the Magic Town formats read (+0x2894 name, local_28b0 funds, local_28a8 coins). */
interface MagicValues {
  familyName: string;
  funds: number;
  coins: number;
}

export class WinLotPopup extends TSWin {
  private tiler: ImageBitmap | null = null;
  private font: FfnFont | null = null;
  private strings: string[] = [];
  /** The composed popup (cWinLotPopup+0xcc with the alpha of +0xd0). */
  private composed: OffscreenCanvas | null = null;
  private house: HouseInfo | null = null;
  private serial = 0;

  constructor(
    private readonly ctx: GameContext,
    private readonly nb: Neighborhood,
    /** cWinLotPopup+0xe8: the owning neighborhood screen's mode (0 = regular). */
    private readonly mode: () => number,
    /** cWinLotPopup+0xf8 (Magic Town only). */
    private readonly magic: MagicPopupSource | null = null,
  ) {
    super();
  }

  /** cWinLotPopup::Init */
  override async init(): Promise<boolean> {
    this.setArea(this.area.left, this.area.top, this.area.left + 200, this.area.top + 100);
    this.tiler = await this.ctx.res.image("kHotspotPopupTiler");
    this.strings = this.ctx.strings.list("UIText", STR_ROLLOVER);
    if (this.strings.length < ROLLOVER_COUNT) return false;
    this.font = await this.ctx.fonts.acquire(FONT_SIZE);
    this.hideWindow();
    return true;
  }

  currentHouse(): HouseInfo | null {
    return this.house;
  }

  /** The popup is drawn over the screen but never takes the mouse. */
  override windowFromPoint(): TSWin | null {
    return null;
  }

  /** cWinLotPopup::GetPopupIndex (regular neighborhood mode). */
  private getPopupIndex(h: HouseInfo): number {
    const mode = this.mode();
    if (h.isTutorial) return mode === 1 ? 8 : mode === 2 ? 9 : POPUP_TUTORIAL;
    if (h.familyNumber !== -1) return mode === 2 || mode === 3 ? 9 : POPUP_FAMILY;
    return this.nb.getZoningType(h.houseNumber) === Zone.Residential ? POPUP_EMPTY_RESIDENTIAL : POPUP_COMMUNITY;
  }

  /**
   * cWinLotPopup::GetMagicPopupIndex (Magic Town residential lots): stores
   * the lot's cost into cWinMagicland +0xd8 first. Visit mode: 28 empty, 34
   * occupied. Tutorial: 8 in move in, 9 in bulldoze, else 6. Occupied: 35 in
   * bulldoze, else 34 (with the family's magicoins). Empty: bulldoze 10 / 11
   * (house or not); move in: MovingInFamilyCanAffordMagic(value, cost)
   * 1 -> 31, -1 (neither) -> 37, -2 (coins short) -> 36, -3 (funds short)
   * -> 38, 0 (no family) keeps 34; other modes 29. `v` receives the values
   * the formats read (SetHouseInfo's locals).
   */
  private async getMagicPopupIndex(h: HouseInfo, cost: number, v: MagicValues): Promise<number> {
    const m = this.magic!;
    m.setFee(cost);
    const mode = m.mode();
    if (mode === 4) {
      if (h.familyNumber === -1) return 0x1c;
      v.coins = await m.familyCoins(h.familyNumber);
      return 0x22;
    }
    if (h.isTutorial) return mode === 1 ? 8 : mode === 2 ? 9 : 6;
    if (h.familyNumber !== -1) {
      v.coins = await m.familyCoins(h.familyNumber);
      return mode === 2 ? 0x23 : 0x22;
    }
    if (mode === 2) return h.hasHouse ? 10 : 0xb;
    if (mode !== 1) return 0x1d;
    const fam = await m.movingFamily();
    if (!fam) return 0x22;
    v.familyName = fam.name;
    v.coins = fam.coins;
    v.funds = fam.funds;
    const coinsOk = cost <= fam.coins;
    const fundsOk = h.value <= fam.funds;
    if (coinsOk && fundsOk) return 0x1f;
    if (!coinsOk && !fundsOk) return 0x25;
    return coinsOk ? 0x26 : 0x24;
  }

  /**
   * SetHouseInfo's town lots (21..30, 40..48, 81..89, 93..99): the address
   * line from <neighborhood>/Downtown.iff (Vacation.iff) STR# 128 entry 1
   * (first three lots) or 2 behind "%s " with the house number, else the
   * rollover entries 13 / 14 (Vacation 15 / 16, Studio Town 24 / 25, Magic
   * Town 27); then "%s\n%s" with the lot name and description from
   * Houses\DTDesc.iff (VIDesc, STDesc, MTDesc) STR# 2000 + house entries
   * 1 / 2 (defaults rollover 22 / 23). Null for other lots.
   */
  private async townText(h: HouseInfo): Promise<string | null> {
    const n = h.houseNumber;
    const s = this.strings;
    let first: { file: string | null; low: number; lowEntry: number; highEntry: number } | null = null;
    let desc = "";
    if (n >= 0x15 && n <= 0x1e) {
      first = { file: "Downtown.iff", low: 0x17, lowEntry: 13, highEntry: 14 };
      desc = "DTDesc.iff";
    } else if (n >= 0x28 && n <= 0x30) {
      first = { file: "Vacation.iff", low: 0x2a, lowEntry: 15, highEntry: 16 };
      desc = "VIDesc.iff";
    } else if (n >= 0x51 && n <= 0x59) {
      first = { file: null, low: 0x53, lowEntry: 24, highEntry: 25 };
      desc = "STDesc.iff";
    } else if (n >= 0x5d && n <= 0x63) {
      first = { file: null, low: 0x63, lowEntry: 27, highEntry: 27 };
      desc = "MTDesc.iff";
    }
    if (!first) return null;
    const num = String(n);
    let address = sprintf(s[n <= first.low ? first.lowEntry : first.highEntry]!, num);
    const custom = first.file ? await loadStrSet(`${this.nb.dir}/${first.file}`, 0x80, LANG_FRENCH) : null;
    if (custom) address = sprintf(`%s ${custom[n <= first.low ? 0 : 1] ?? ""}`, num);
    let name = s[22]!;
    let text = s[23]!;
    const d = await loadStrSet(`${this.nb.dir}/Houses/${desc}`, 2000 + n, LANG_FRENCH);
    if (d?.[0]) name = d[0];
    if (d?.[1]) text = d[1];
    return `${address}\n\n${name}\n${text}\n `;
  }

  private async address(house: number): Promise<string> {
    const num = String(house);
    const file = `${this.nb.dir}/StreetNames.iff`;
    const streets = await loadStrSet(file, 2000, LANG_FRENCH);
    const assignments = await loadStrSet(file, 2001, LANG_FRENCH);
    if (!streets || !assignments) return sprintf(this.strings[7]!, num);
    // StringSetMulti::GetString is 1-based.
    const street = Number.parseInt(assignments[house - 1] ?? "", 10) || 0;
    return sprintf(streets[street - 1] ?? "", num);
  }

  /** cWinLotPopup::SetHouseInfo */
  async setHouseInfo(h: HouseInfo | null): Promise<void> {
    const serial = ++this.serial;
    this.house = h;
    if (!h) {
      this.composed = null;
      return;
    }
    const font = this.font!;
    const s = this.strings;
    const town = await this.townText(h);
    let text = town ?? `${await this.address(h.houseNumber)}\n\n`;

    let name = s[22]!;
    let desc = s[23]!;
    if (this.nb.getZoningType(h.houseNumber) !== Zone.None) {
      const descFile = h.houseNumber >= 0x5a && h.houseNumber <= 0x63 ? "MTDesc.iff" : "NeighborhoodDesc.iff";
      const d = await loadStrSet(`${this.nb.dir}/Houses/${descFile}`, 2000 + h.houseNumber, LANG_FRENCH);
      if (d?.[0]) name = d[0];
      if (d?.[1]) desc = d[1];
    }
    desc += "\n ";

    const idx = this.getPopupIndex(h);
    const zone = this.nb.getZoningType(h.houseNumber);
    if (town !== null) {
      // Town lots are described by their address and the town's desc file only.
    } else if (zone === Zone.Community) {
      text += sprintf(s[idx]!, name, desc);
    } else if (zone === Zone.Residential && this.magic && h.houseNumber >= 0x5a && h.houseNumber <= 0x5c) {
      // The lbl_105BC754 formats of the Magic Town indices (see getMagicPopupIndex).
      const lang = LANG_FRENCH;
      const v: MagicValues = { familyName: "", funds: 0, coins: 0 };
      const cost = this.magic.cost(h.houseNumber);
      const i = await this.getMagicPopupIndex(h, cost, v);
      const money = (n: number): string => makeMoneyString(n, lang);
      const coins = String(v.coins);
      if (i === 0x1d || i === 0x1f) text += sprintf(s[i]!, name, desc, money(h.value), String(cost));
      else if (i === 0x24 || i === 0x25) text += sprintf(s[i]!, name, desc, money(h.value), String(cost), v.familyName, coins);
      else if (i === 0x26) text += sprintf(s[i]!, name, desc, money(h.value), String(cost), v.familyName, money(v.funds));
      else if (i === 0x22 || i === 0x23) text += sprintf(s[i]!, h.familyName, money(h.netWorth), coins, h.friends);
      else if (i === 0x1c) text += sprintf(s[i]!, name, desc);
      else text += s[i]!;
    } else if (zone === Zone.Residential) {
      const lang = LANG_FRENCH;
      if (idx === POPUP_FAMILY) text += sprintf(s[idx]!, h.familyName, makeMoneyString(h.netWorth, lang), h.friends);
      else if (idx === POPUP_EMPTY_RESIDENTIAL) text += sprintf(s[idx]!, name, desc, makeMoneyString(h.value, lang));
      else text += s[idx]!;
    }

    // Width of the first line, clamped, then grown until the text fits 2/3 of it.
    const firstLine = /^[^\r\n]*/.exec(text)![0];
    let w = font.stringWidth(firstLine);
    const members = await this.memberThumbnails(h);
    let textH = 0;
    let popupW = 0;
    let popupH = 0;
    let perRow = 0;
    for (let tries = 0; ; tries++) {
      w = Math.min(0x140, Math.max(0x96, w));
      textH = font.calculateNumberOfLines(text, w) * font.height;
      popupH = textH + 2 * MARGIN;
      perRow = 0;
      if (members.length) {
        perRow = Math.trunc(w / THUMB);
        popupH = textH + (perRow < members.length ? 0x6e : 0x55);
      }
      popupW = w + 2 * MARGIN;
      if (popupH < Math.trunc((popupW * 2) / 3) || tries > 1) break;
      w = Math.trunc((w * 3) / 2);
    }
    if (serial !== this.serial) return;

    this.setArea(this.area.left, this.area.top, this.area.left + popupW, this.area.top + popupH);
    const bkg = this.bltEdge(popupW, popupH);
    const out = new OffscreenCanvas(popupW, popupH);
    const g = out.getContext("2d")!;
    g.drawImage(bkg, 0, 0);
    font.drawTextPara(g as unknown as CanvasRenderingContext2D, { left: MARGIN, top: MARGIN, right: w + MARGIN, bottom: textH + MARGIN }, text, ALIGN_LEFT, TEXT_COLOR);

    // Member thumbnails: the first row holds perRow of them, the rest go on a second row.
    const twoRows = perRow < members.length;
    let x = MARGIN;
    let y = popupH - MARGIN - THUMB - (twoRows ? THUMB : 0);
    members.forEach((m, i) => {
      if (i === perRow) {
        x = MARGIN;
        y = popupH - MARGIN - THUMB;
      }
      if (m) g.drawImage(m, x, y);
      x += THUMB;
    });

    // The background alpha applies to everything (AlphaBlend with the +0xd0 alpha buffer).
    g.globalCompositeOperation = "destination-in";
    g.drawImage(bkg, 0, 0);
    this.composed = out;
  }

  private async memberThumbnails(h: HouseInfo): Promise<Array<ImageBitmap | null>> {
    const family = this.nb.getFamilyInHouse(h.houseNumber);
    if (!family) return [];
    return Promise.all(
      family.memberGuids.map(async (guid) => {
        const n = neighborByGuid(this.nb.data, guid);
        if (!n) return null;
        // PersonFinder::GetThumbnail: the character file's 25x25 BMP_ 2004.
        const c = await loadCharacter(this.nb.dir, n.name).catch(() => null);
        const bytes = c?.bitmaps.get(2004);
        if (!bytes) return null;
        const img = decodeImage(bytes, "thumb.bmp");
        return createImageBitmap(new ImageData(img.data, img.width, img.height));
      }),
    );
  }

  /** cTSBuffer::BltEdge with the tiler's top-left third as the cell size, center filled. */
  private bltEdge(w: number, h: number): OffscreenCanvas {
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext("2d")!;
    const t = this.tiler;
    if (!t) return c;
    const cw = Math.trunc(t.width / 3);
    const ch = Math.trunc(t.height / 3);
    const cell = (col: number, row: number, x: number, y: number, dw: number, dh: number): void => {
      // Tile the source cell over the destination rectangle.
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
    return c;
  }

  /** cWinLotPopup::TSPaint: the composed buffer from its top-left, clipped to the (unfurling) area. */
  override tsPaint(g: Gfx): void {
    const c = this.composed;
    if (!c) return;
    g.blitPart(c, 0, 0, Math.min(c.width, this.getW()), Math.min(c.height, this.getH()), 0, 0);
  }

  /** Composed size, before unfurling. */
  fullSize(): { w: number; h: number } {
    return { w: this.composed?.width ?? this.getW(), h: this.composed?.height ?? this.getH() };
  }
}
