/**
 * The build mode products of the catalog (Catalog::Init, Product,
 * Product::TestArchTool, Product::GenerateGraphics), the part of the game's
 * catalog that cWinArch shows.
 *
 * Catalog::Init builds one product list for buy and build mode:
 *  - every floor of FloorGraphicsMgr::BeginEnum / GetNextFloor: kind 2, arch
 *    tool 7 (floor), +0x34 the floor pattern, ProductButton +8 the pattern.
 *    The built-in floors 1..29 read price, name and description from
 *    GameData/Build.iff STR# 0x82 entries (p - 1) * 3 + 1..3, the plugin
 *    .flr floors (patterns from the manager's number pool) their own STR# 0
 *    or the STR# 0x86 defaults;
 *  - the terrain tools (STR# 0x80 entries 1..12, three per tool): kind 5,
 *    arch tool 0, button +8 = 0 raise, 1 lower, 2 level, 3 grass; the button
 *    image is the tool's own 4-frame bitmap (kBldSbTl*), the product sheet
 *    shows kBldPopup*;
 *  - the wall styles (STR# 0x81): kind 3, arch tool 2, +0x2c pattern and
 *    +0x30 style: wall (0, 1), picket fence (0xf8, 2), iron railing
 *    (0xfa, 0xd), privacy fence (0xf9, 0xc), Italian railing (0xfb, 0xe),
 *    button +8 = 0, 1, 3, 2, 4;
 *  - every wallpaper of WallGraphicsMgr::BeginEnum / GetNextWallPaper
 *    (patterns 1..30 of walls.iff, STR# 0x83, then the plugin .wll files'
 *    patterns with their own strings): kind 4, arch tool 3, +0x2c the
 *    pattern, button +8 = pattern + 1, the price and strings it returns;
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
 * RenderCatalogShot: kind 2 (plugin floors) draws the pattern's scale 3
 * sprite (FloorGraphicsMgr::GetFloorGraphic, cRenderer::DrawFloor at full
 * ambient light) at (100 - 0x40, 2 * 200 / 3 - 0x2d), rectangle
 * (x, y, x + 0x80, y + 0x40); kinds 3 / 4 draw WallManager::DrawIconic (one
 * wall segment, scale 2, direction 6) at (100, 3 * 200 / 4 + 0xe; - 0x10
 * for styles 2 / 0xc) of the 200x200 work buffer.
 *
 * The floors and wallpapers come from a FloorGraphicsMgr / WallGraphicsMgr
 * of the catalog's own (the original's single global ones): their plugin
 * pattern numbers are handed out in the same scan order as the house's, so
 * they name the same patterns.
 */

import { renderShots } from "../cpanel/buy/objecticon.js";
import { ArchTool, type ArchProduct } from "../cpstate.js";
import type { GameContext } from "../context.js";
import { decodeImage } from "../res/bmp.js";
import { ResFile } from "../world/iffres.js";
import { FloorGraphicsMgr } from "../world/floors.js";
import type { Renderer } from "../world/renderer.js";
import { PX_ALPHA, PX_NONE } from "../world/spr.js";
import { WallGraphicsMgr } from "../world/wallgraphics.js";
import { IconicWallBlitter } from "../world/wallicon.js";
import { WallManager } from "../world/walls.js";
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
const STR_HAND = 0x84;
const STR_POOL = 0x85;

/** FloorGraphicsMgr::Initialize: built-in floor patterns 1..0x1d. */
const BUILTIN_FLOORS = 0x1e;

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

let wallGraphics: Promise<WallGraphicsMgr> | null = null;
let floorGraphics: Promise<FloorGraphicsMgr> | null = null;

/** The global FloorGraphicsMgr (lbl_105BA114) as the catalog sees it: floors.iff and the plugin floors. */
function catalogFloorGraphics(): Promise<FloorGraphicsMgr> {
  floorGraphics ??= (async () => {
    const gfx = new FloorGraphicsMgr();
    await gfx.initialize();
    return gfx;
  })();
  return floorGraphics;
}

/** The global WallGraphicsMgr (lbl_105BA118) as the catalog sees it: walls.iff and the plugin wallpapers. */
function catalogWallGraphics(): Promise<WallGraphicsMgr> {
  wallGraphics ??= (async () => {
    const gfx = new WallGraphicsMgr();
    await gfx.initialize();
    return gfx;
  })();
  return wallGraphics;
}

/** WallManager::DrawIconic of a wall style / pattern into `img` (scale 2, direction 6); the drawn rectangle. */
function drawIconicWall(gfx: WallGraphicsMgr, img: ImageData, x: number, y: number, style: number, pattern: number): { left: number; top: number; right: number; bottom: number } {
  return WallManager.drawIconic(new IconicWallBlitter(img, gfx.global), gfx, x, y, 2, style, pattern, 6);
}

/** RenderCatalogShot's work buffer size. */
const SHOT_BUFFER = 200;

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

  /** The object product whose picture RenderCatalogShot renders (object products only). */
  catalogObject(): Product | null {
    return this.kind === ProductKind.Object ? this.object : null;
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
   * RenderCatalogShot for floors, wall styles and wallpapers without a BMP_
   * (kinds 2..4): the scale 3 floor sprite at (100 - 0x40, 2 * 200 / 3 -
   * 0x2d), or DrawIconic at (100, 3 * 200 / 4 + 0xe), - 0x10 instead of
   * + 0xe for styles 2 / 0xc, on each template color; other kinds draw
   * nothing.
   */
  async renderCatalogShot(template: ImageBitmap): Promise<ImageBitmap | null> {
    if (this.kind === ProductKind.Floor) {
      const floor = (await catalogFloorGraphics()).getFloorGraphic(this.floorStyle, 3);
      if (!floor) return null;
      const x = Math.trunc(SHOT_BUFFER / 2) - 0x40;
      const y = Math.trunc((2 * SHOT_BUFFER) / 3) - 0x2d;
      return renderShots(template, (g) => {
        const img = g.getImageData(0, 0, SHOT_BUFFER, SHOT_BUFFER);
        drawFloorSprite(floor.renderer, floor.id, img, x, y);
        g.putImageData(img, 0, 0);
        return { left: x, top: y, right: x + 0x80, bottom: y + 0x40 };
      });
    }
    if (this.kind !== ProductKind.WallStyle && this.kind !== ProductKind.Wallpaper) return null;
    const gfx = await catalogWallGraphics();
    const style = this.wallStyle;
    const base = Math.trunc((SHOT_BUFFER * 3) / 4);
    const y = style === 2 || style === 0xc ? base - 0x10 : base + 0xe;
    return renderShots(template, (g) => {
      const img = g.getImageData(0, 0, SHOT_BUFFER, SHOT_BUFFER);
      const rect = drawIconicWall(gfx, img, Math.trunc(SHOT_BUFFER / 2), y, style, this.wallpaper);
      g.putImageData(img, 0, 0);
      return rect;
    });
  }

  /**
   * Product::DrawIcon for the product sheet (cWinCatalogPopup) of products
   * that are not objects, into (0, 0, w, h) of `g`.
   *  - tool products: the popup bitmap (+0x38), centered when smaller;
   *  - floors: DrawFloorIcon, the pattern's large-zoom sprite
   *    (FloorGraphicsMgr::GetFloorGraphic scale 3) at (w / 2 - 0x40,
   *    2h / 3 - 0x2d), at full light (RenderParam::SetMaxAmbient);
   *  - wall styles and wallpapers: DrawWallIcon.
   */
  async drawPopupIcon(ctx: GameContext, g: CanvasRenderingContext2D, w: number, h: number): Promise<void> {
    if (this.kind === ProductKind.Tool) {
      if (!this.popupImage) return;
      const img = await ctx.res.image(this.popupImage).catch(() => null);
      if (!img) return;
      const x = img.width < w ? Math.trunc((w - img.width) / 2) : 0;
      const y = img.height < h ? Math.trunc((h - img.height) / 2) : 0;
      g.drawImage(img, x, y);
    } else if (this.kind === ProductKind.Floor) {
      const floor = (await catalogFloorGraphics().catch(() => null))?.getFloorGraphic(this.floorStyle, 3);
      if (floor) drawFloorIcon(floor.renderer, floor.id, g, w, h);
    } else if (this.kind === ProductKind.WallStyle || this.kind === ProductKind.Wallpaper) {
      const gfx = await catalogWallGraphics().catch(() => null);
      if (gfx) drawWallIcon(gfx, this.wallStyle, this.wallpaper, g, w, h);
    }
  }
}

/**
 * DrawWallIcon(style, pattern, buffer, rect): WallManager::DrawIconic at
 * scale 2, direction 6, x = w / 2, y = 3h / 4 + 0xe (- 0x10 for styles 2,
 * 0xd and 0xe, - 2 for 0xc).
 */
function drawWallIcon(gfx: WallGraphicsMgr, style: number, pattern: number, g: CanvasRenderingContext2D, w: number, h: number): void {
  const base = Math.trunc((h * 3) / 4);
  let y = base + 0xe;
  if (style === 2 || style === 0xd || style === 0xe) y = base - 0x10;
  else if (style === 0xc) y = base - 2;
  const img = g.getImageData(0, 0, w, h);
  drawIconicWall(gfx, img, Math.trunc(w / 2), y, style, pattern);
  g.putImageData(img, 0, 0);
}

/** DrawFloorIcon: one floor sprite at scale 3, cRenderer::DrawFloor at full ambient light. */
function drawFloorIcon(r: Renderer, spriteId: number, g: CanvasRenderingContext2D, w: number, h: number): void {
  const img = g.getImageData(0, 0, w, h);
  drawFloorSprite(r, spriteId, img, Math.trunc(w / 2) - 0x40, Math.trunc((2 * h) / 3) - 0x2d);
  g.putImageData(img, 0, 0);
}

/** cRenderer::DrawFloor at full ambient light: frame 0 of a floor sprite with its top-left corner at (x0, y0) of `img`. */
function drawFloorSprite(r: Renderer, spriteId: number, img: ImageData, x0: number, y0: number): void {
  const f = r.frame(spriteId, 0);
  if (!f) return;
  const pal = r.palette(f.paletteId);
  const w = img.width;
  const h = img.height;
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

  // FloorGraphicsMgr::BeginEnum / GetNextFloor / EndEnum (built-in patterns 1..29, then the plugins; it stops when the strings run out).
  const floorGfx = await catalogFloorGraphics();
  floorGfx.beginEnum();
  for (let e = floorGfx.getNextFloor(); e; e = floorGfx.getNextFloor()) {
    products.push(new BuildProduct(ProductKind.Floor, ArchTool.Floor, e.name, e.description, e.cost, { toolIndex: e.pattern, floorStyle: e.pattern }));
  }
  floorGfx.endEnum();

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

  // WallGraphicsMgr::BeginEnum / GetNextWallPaper / EndEnum (built-in patterns 1..30, then the plugins).
  const gfx = await catalogWallGraphics();
  gfx.beginEnum();
  for (let e = gfx.getNextWallPaper(); e; e = gfx.getNextWallPaper()) {
    products.push(new BuildProduct(ProductKind.Wallpaper, ArchTool.Wallpaper, e.name, e.description, e.cost, { toolIndex: e.pattern + 1, wallpaper: e.pattern }));
  }
  gfx.endEnum();

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
