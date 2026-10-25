/**
 * The build mode products of the catalog (Catalog::Init, Product,
 * Product::TestArchTool, Product::GenerateGraphics), the part of the game's
 * catalog that cWinArch shows.
 *
 * Catalog::Init builds one product list for buy and build mode:
 *  - every floor of FloorGraphicsMgr::BeginEnum / GetNextFloor: kind 2, arch
 *    tool 7 (floor), +0x34 the floor pattern, ProductButton +8 the pattern.
 *    The built-in floors 1..29 read price, name and description from
 *    GameData/Build.iff STR# 0x82 entries (p - 1) * 3 + 1..3;
 *  - the terrain tools (STR# 0x80 entries 1..12, three per tool): kind 5,
 *    arch tool 0, button +8 = 0 raise, 1 lower, 2 level, 3 grass; the button
 *    image is the tool's own 4-frame bitmap (kBldSbTl*), the product sheet
 *    shows kBldPopup*;
 *  - the wall styles (STR# 0x81): kind 3, arch tool 2, +0x2c pattern and
 *    +0x30 style: wall (0, 1), picket fence (0xf8, 2), iron railing
 *    (0xfa, 0xd), privacy fence (0xf9, 0xc), Italian railing (0xfb, 0xe),
 *    button +8 = 0, 1, 3, 2, 4;
 *  - every wallpaper of WallGraphicsMgr::BeginEnum / GetNextWallPaper
 *    (patterns 1..30 of walls.iff, STR# 0x83): kind 4, arch tool 3,
 *    +0x2c the pattern, button +8 = pattern + 1;
 *  - the hand (STR# 0x84): kind 5, arch tool 11, button +8 = 0;
 *  - pool and water (STR# 0x85 entries 1..3, 4..6): kind 5, arch tool 1,
 *    button +8 = 0, 1;
 *  - one object product per catalog selector (data/catalog.ts): kind 1.
 * Then the whole list is sorted by CatalogSortPred (price, then name).
 * Strings are 1-based in the original (StringSetBase::GetString), prices are
 * atoi of the first string of each triple.
 *
 * Product::TestArchTool: object products match through
 * cMoveTool::IsSelectorOfType (GUID lists cMoveTool's constructor fills
 * with the selectors whose OBJD room sort (+0x4e) is 0, by OBJD build mode
 * type (+0x8a) 1 door, 2 window, 3 stair, 4 plant, 5 fireplace, 6 column,
 * 7 pool equipment), the others when their arch tool (+0x28) is the tool
 * (floors also need FloorGraphicsMgr::IsLegalFloorPattern).
 *
 * Product::GenerateGraphics: the button picture is a 74x37 BMP_ (normal and
 * highlighted 37x37 halves) of the global renderer's file: floors.iff id =
 * pattern (1..29), walls.iff id = style for wall styles and pattern + 0x200
 * for wallpapers 0..30 / 0xf8..0xff; anything else is rendered by
 * RenderCatalogShot (not needed for the shipped patterns).
 *
 * Not ported: plugin floors and wallpapers (.flr / .wll files: their
 * pattern numbers come from the graphics managers' number pools and their
 * pictures from RenderCatalogShot).
 */

import { ArchTool, type ArchProduct } from "../cpstate.js";
import type { GameContext } from "../context.js";
import { decodeImage } from "../res/bmp.js";
import { ResFile } from "../world/iffres.js";
import { Renderer } from "../world/renderer.js";
import { PX_ALPHA, PX_NONE } from "../world/spr.js";
import { catalogSortPred, loadCatalog, OBJD, type Product } from "./catalog.js";

/** Product +0x14 */
export const enum ProductKind {
  Object = 1,
  Floor = 2,
  WallStyle = 3,
  Wallpaper = 4,
  Tool = 5,
}

/** Build.iff string sets. */
const STR_TERRAIN = 0x80;
const STR_WALL = 0x81;
const STR_FLOOR = 0x82;
const STR_WALLPAPER = 0x83;
const STR_HAND = 0x84;
const STR_POOL = 0x85;

/** FloorGraphicsMgr::Initialize: built-in floor patterns 1..0x1d. */
const BUILTIN_FLOORS = 0x1e;
/** WallGraphicsMgr::Initialize: built-in wallpapers 0..0x1e (BeginEnum skips 0) and 0xf8..0xff (GetNextWallPaper skips them). */
const BUILTIN_WALLPAPERS = 0x1f;

const ICON_W = 0x4a;
const ICON_H = 0x25;

/** Product::TestArchTool (jump table lbl_105BC0A0 -> cMoveTool::IsSelectorOfType): arch tool -> OBJD build mode type. */
const OBJECT_BUILD_TYPE: Partial<Record<ArchTool, number>> = {
  [ArchTool.Water]: 7,
  [ArchTool.Wall]: 6,
  [ArchTool.Stair]: 3,
  [ArchTool.Fireplace]: 5,
  [ArchTool.Plant]: 4,
  [ArchTool.Door]: 1,
  [ArchTool.Window]: 2,
};

/** cWinArch::UpdateViewFromCPState's jump table lbl_105BC33C: the ArchObjectSortPredicate type per arch tool (0: by price). */
export const ARCH_SORT_TYPE: Partial<Record<ArchTool, number>> = {
  [ArchTool.Water]: 9,
  [ArchTool.Wall]: 8,
  [ArchTool.Stair]: 5,
  [ArchTool.Fireplace]: 7,
  [ArchTool.Plant]: 6,
  [ArchTool.Door]: 3,
  [ArchTool.Window]: 4,
};

let floorsFile: Promise<ResFile> | null = null;
let wallsFile: Promise<ResFile> | null = null;

function floorsIff(): Promise<ResFile> {
  floorsFile ??= ResFile.open("GameData/floors.iff");
  return floorsFile;
}

function wallsIff(): Promise<ResFile> {
  wallsFile ??= ResFile.open("GameData/walls.iff");
  return wallsFile;
}

/** nsSMResFac::LoadBuffer(renderer file, id): a 74x37 BMP_ or null. */
async function loadBmp(file: Promise<ResFile>, id: number): Promise<ImageBitmap | null> {
  const bytes = (await file.catch(() => null))?.get("BMP_", id);
  if (!bytes) return null;
  try {
    const img = decodeImage(bytes, "catalog.bmp");
    if (img.width !== ICON_W || img.height !== ICON_H) return null;
    return await createImageBitmap(new ImageData(img.data, img.width, img.height));
  } catch {
    return null;
  }
}

interface ProductInit {
  toolIndex: number;
  wallpaper?: number;
  wallStyle?: number;
  floorStyle?: number;
  object?: Product;
  /** Kind 5: the button's own bitmap (Product::CreateButton(bitmap, 4)) and the sheet's picture (+0x38). */
  buttonImage?: number;
  popupImage?: number;
}

/** Product (build mode view): see the file comment. */
export class BuildProduct implements ArchProduct {
  /** ProductButton +8; cWinArch::UpdateViewFromCPState renumbers object products by their place in the tool's list. */
  toolIndex: number;
  readonly wallpaper: number;
  readonly wallStyle: number;
  readonly floorStyle: number;
  readonly object: Product | null;
  readonly buttonImage: number;
  readonly popupImage: number;
  private iconPromise: Promise<ImageBitmap | null> | null = null;

  constructor(
    readonly kind: ProductKind,
    /** +0x28 */
    readonly archTool: number,
    private readonly name: string,
    private readonly description: string,
    private readonly price: number,
    init: ProductInit,
  ) {
    this.toolIndex = init.toolIndex;
    // Product::Product: +0x2c = 0, +0x30 = 1.
    this.wallpaper = init.wallpaper ?? 0;
    this.wallStyle = init.wallStyle ?? 1;
    this.floorStyle = init.floorStyle ?? 0;
    this.object = init.object ?? null;
    this.buttonImage = init.buttonImage ?? 0;
    this.popupImage = init.popupImage ?? 0;
  }

  get guid(): number {
    return this.object?.guid ?? 0;
  }

  /** Product::GetPrice */
  getPrice(): number {
    return this.price;
  }

  /** Product::GetProductName */
  getProductName(): string {
    return this.name;
  }

  /** Product::GetDescription */
  getDescription(): string {
    return this.description;
  }

  /** Product::CanAfford */
  canAfford(funds: number): boolean {
    return this.price <= funds;
  }

  /** Product::GetCatalogRating: objects only. */
  getCatalogRating(i: number): number {
    return this.object?.getCatalogRating(i) ?? 0;
  }

  /** Product::TestArchTool */
  testArchTool(tool: ArchTool): boolean {
    if (this.kind === ProductKind.Object) {
      const type = OBJECT_BUILD_TYPE[tool];
      const o = this.object!;
      return type !== undefined && o.field(OBJD.roomSort) === 0 && o.field(OBJD.buildModeType) === type;
    }
    if (tool !== this.archTool) return false;
    // FloorGraphicsMgr::IsLegalFloorPattern: every enumerated floor is registered.
    return true;
  }

  /** Product::GenerateGraphics: the 74x37 button picture (null: kItemUnknown; tool products have none). */
  icon(): Promise<ImageBitmap | null> {
    this.iconPromise ??= this.generateGraphics();
    return this.iconPromise;
  }

  private generateGraphics(): Promise<ImageBitmap | null> {
    switch (this.kind) {
      case ProductKind.Object:
        return this.object!.icon();
      case ProductKind.Floor:
        return this.floorStyle > 0 && this.floorStyle < BUILTIN_FLOORS ? loadBmp(floorsIff(), this.floorStyle) : Promise.resolve(null);
      case ProductKind.WallStyle:
        return loadBmp(wallsIff(), this.wallStyle);
      case ProductKind.Wallpaper: {
        const p = this.wallpaper;
        const plugin = (p > 0x1e && p < 0xf8) || (p > 0xff && p < 0xffff);
        return plugin ? Promise.resolve(null) : loadBmp(wallsIff(), p + 0x200);
      }
      default:
        return Promise.resolve(null);
    }
  }

  /**
   * Product::DrawIcon for the product sheet (cWinCatalogPopup) of products
   * that are not objects, into (0, 0, w, h) of `g`.
   *  - tool products: the popup bitmap (+0x38), centered when smaller;
   *  - floors: DrawFloorIcon, the pattern's large-zoom sprite (scale 3,
   *    floors.iff SPR2 pattern + 0x200) at (w / 2 - 0x40, 2h / 3 - 0x2d), at
   *    full light (RenderParam::SetMaxAmbient);
   *  - wall styles and wallpapers: DrawWallIcon (WallManager::DrawIconic), not ported.
   */
  async drawPopupIcon(ctx: GameContext, g: CanvasRenderingContext2D, w: number, h: number): Promise<void> {
    if (this.kind === ProductKind.Tool) {
      if (!this.popupImage) return;
      const img = await ctx.res.image(this.popupImage).catch(() => null);
      if (!img) return;
      const x = img.width < w ? Math.trunc((w - img.width) / 2) : 0;
      const y = img.height < h ? Math.trunc((h - img.height) / 2) : 0;
      g.drawImage(img, x, y);
    } else if (this.kind === ProductKind.Floor && this.floorStyle > 0 && this.floorStyle < BUILTIN_FLOORS) {
      const file = await floorsIff().catch(() => null);
      if (file) drawFloorIcon(new Renderer(file), this.floorStyle + 0x200, g, w, h);
    }
  }
}

/** DrawFloorIcon: one floor sprite at scale 3, cRenderer::DrawFloor at full ambient light. */
function drawFloorIcon(r: Renderer, spriteId: number, g: CanvasRenderingContext2D, w: number, h: number): void {
  const f = r.frame(spriteId, 0);
  if (!f) return;
  const pal = r.palette(f.paletteId);
  const x0 = Math.trunc(w / 2) - 0x40;
  const y0 = Math.trunc((2 * h) / 3) - 0x2d;
  const img = g.getImageData(0, 0, w, h);
  const px = img.data;
  for (let sy = 0; sy < f.height; sy++) {
    const dy = y0 + sy;
    if (dy < 0 || dy >= h) continue;
    for (let sx = 0; sx < f.width; sx++) {
      const i = sy * f.width + sx;
      const mode = f.mode[i]!;
      if (mode === PX_NONE) continue;
      const dx = x0 + sx;
      if (dx < 0 || dx >= w) continue;
      const c = f.index[i]! * 3;
      const a = mode === PX_ALPHA ? f.alpha[i]! / 31 : 1;
      const q = (dy * w + dx) * 4;
      px[q] = px[q]! * (1 - a) + pal[c]! * a;
      px[q + 1] = px[q + 1]! * (1 - a) + pal[c + 1]! * a;
      px[q + 2] = px[q + 2]! * (1 - a) + pal[c + 2]! * a;
      px[q + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
}

/** The prices Catalog::Init also stores for the build tools (cost of a tile / wall segment). */
export interface BuildPrices {
  /** lbl_105BA524: the raise terrain tool's price. */
  terrain: number;
  /** lbl_105BA4CC[style]: wall style prices (style 0xff shares the wall tool's). */
  wallStyle: Map<number, number>;
  /** lbl_105BA4C8 */
  pool: number;
  /** lbl_105BA5C4 */
  water: number;
}

export interface BuildCatalog {
  /** Every product, in catalog order (CatalogSortPred). */
  products: BuildProduct[];
  prices: BuildPrices;
}

/** Catalog::Init, build mode part (plus the object products of the shared catalog). */
async function build(ctx: GameContext): Promise<BuildCatalog> {
  // GameData/Build.iff is loaded at boot (StdResFile "build").
  const set = (id: number): string[] => ctx.strings.list("Build", id);
  const triple = (s: string[], first: number): [number, string, string] => [
    parseInt(s[first - 1] ?? "", 10) || 0,
    s[first] ?? "",
    s[first + 1] ?? "",
  ];
  const products: BuildProduct[] = [];

  // FloorGraphicsMgr::GetNextFloor (built-in patterns; it stops when the strings run out).
  const floors = set(STR_FLOOR);
  for (let p = 1; p < BUILTIN_FLOORS; p++) {
    const first = (p - 1) * 3 + 1;
    if (floors.length < first + 2) break;
    const [price, name, desc] = triple(floors, first);
    products.push(new BuildProduct(ProductKind.Floor, ArchTool.Floor, name, desc, price, { toolIndex: p, floorStyle: p }));
  }

  const terrain = set(STR_TERRAIN);
  const terrainTools: Array<[string, string]> = [
    ["kBldSbTlTerrainUp", "kBldPopupTerrainUp"],
    ["kBldSbTlTerrainDown", "kBldPopupTerrainDown"],
    ["kBldSbTlTerrainLevel", "kBldPopupTerrainLevel"],
    ["kBldSbTlGrass", "kBldPopupGrass"],
  ];
  terrainTools.forEach(([btn, popup], i) => {
    const [price, name, desc] = triple(terrain, i * 3 + 1);
    products.push(
      new BuildProduct(ProductKind.Tool, ArchTool.Terrain, name, desc, price, {
        toolIndex: i,
        buttonImage: ctx.res.id(btn),
        popupImage: ctx.res.id(popup),
      }),
    );
  });
  const terrainPrice = triple(terrain, 1)[0];

  const walls = set(STR_WALL);
  const wallStylePrice = new Map<number, number>();
  // [STR# entry, wallpaper (+0x2c), style (+0x30), button +8]
  const wallStyles: Array<[number, number, number, number]> = [
    [1, 0, 1, 0],
    [4, 0xf8, 2, 1],
    [7, 0xfa, 0xd, 3],
    [10, 0xf9, 0xc, 2],
    [13, 0xfb, 0xe, 4],
  ];
  for (const [first, wallpaper, style, index] of wallStyles) {
    const [price, name, desc] = triple(walls, first);
    wallStylePrice.set(style, price);
    if (style === 1) wallStylePrice.set(0xff, price);
    products.push(new BuildProduct(ProductKind.WallStyle, ArchTool.Wall, name, desc, price, { toolIndex: index, wallpaper, wallStyle: style }));
  }

  // WallGraphicsMgr::GetNextWallPaper (built-in patterns 1..30).
  const papers = set(STR_WALLPAPER);
  for (let p = 1; p < BUILTIN_WALLPAPERS; p++) {
    const first = (p - 1) * 3 + 1;
    if (papers.length < first + 2) break;
    const [price, name, desc] = triple(papers, first);
    products.push(new BuildProduct(ProductKind.Wallpaper, ArchTool.Wallpaper, name, desc, price, { toolIndex: p + 1, wallpaper: p }));
  }

  const hand = triple(set(STR_HAND), 1);
  products.push(
    new BuildProduct(ProductKind.Tool, ArchTool.Hand, hand[1], hand[2], hand[0], {
      toolIndex: 0,
      buttonImage: ctx.res.id("kBldSbtlHand1"),
      popupImage: ctx.res.id("kBldPopupHand"),
    }),
  );

  const pool = set(STR_POOL);
  const poolTools: Array<[string, string]> = [
    ["kBldSbTlPool", "kBldPopupPool"],
    ["kBldSbTlWater", "kBldPopupWater"],
  ];
  const poolPrices = poolTools.map(([btn, popup], i) => {
    const [price, name, desc] = triple(pool, i * 3 + 1);
    products.push(
      new BuildProduct(ProductKind.Tool, ArchTool.Water, name, desc, price, {
        toolIndex: i,
        buttonImage: ctx.res.id(btn),
        popupImage: ctx.res.id(popup),
      }),
    );
    return price;
  });

  // The object products (Product::SetObject); build mode only shows the ones TestArchTool takes.
  const catalog = await loadCatalog();
  for (const o of catalog.products) {
    if (o.field(OBJD.roomSort) !== 0 || o.field(OBJD.buildModeType) === 0) continue;
    products.push(new BuildProduct(ProductKind.Object, -1, o.getProductName(), o.getDescription(), o.getPrice(), { toolIndex: 0, object: o }));
  }

  // Array.prototype.sort is stable; customsort's order of equal products is not known.
  products.sort(catalogSortPred);
  return {
    products,
    prices: { terrain: terrainPrice, wallStyle: wallStylePrice, pool: poolPrices[0] ?? 0, water: poolPrices[1] ?? 0 },
  };
}

let buildCatalog: Promise<BuildCatalog> | null = null;

/** CPState::GetCatalog, build mode products: built once. */
export function loadBuildCatalog(ctx: GameContext): Promise<BuildCatalog> {
  buildCatalog ??= build(ctx);
  return buildCatalog;
}

/**
 * ArchObjectSortPredicate(type): type 0 by price; otherwise products without
 * a selector by ProductButton +8 - 0x400 (so tool products come first, in
 * button order) and objects by cMoveTool::GetSortVal (their product's price).
 * Signed comparison.
 */
export function archObjectSort(type: number): (a: BuildProduct, b: BuildProduct) => number {
  const val = (p: BuildProduct): number => {
    if (type === 0 || p.object) return p.getPrice() | 0;
    return p.toolIndex - 0x400;
  };
  return (a, b) => val(a) - val(b);
}
