# Build mode control panel port (cWinArch, cWinRoofPanel, build catalog)

Files:

| TS | Original |
|---|---|
| `client/src/game/cpanel/arch.ts` | cWinArch (Init, UpdateViewFromCPState, TSOnCommand, TSPaint, SetRoofMode, PageLeft/Right, LowerPopup, mouse handlers) |
| `client/src/game/cpanel/arch/roofpanel.ts` | cWinRoofPanel (BuildButtons, TraverseRoofDirectory, BuildPatternButtons, SetCurPage, UpdateViewFromCPState, TSOnCommand) |
| `client/src/game/data/buildcatalog.ts` | Catalog::Init (build part), Product (TestArchTool, GenerateGraphics, DrawIcon), ArchObjectSortPredicate |
| `cpanel/buy/productbutton.ts` | ProductButton, now generic over the product (`ButtonProduct`) |
| `cpanel/buy/catalogpopup.ts` | cWinCatalogPopup, now takes any `PopupProduct` (non-object products draw their own picture) |

## Sources and constants

- Positions: `.__sinit__WinArch_cpp` (WinArch.s 0x1025A8A0): undo (0xe7, 0x15),
  redo (0xe7, 0x35), tool buttons lbl_105BA974 (control panel coordinates,
  TSPaint subtracts the panel x). Prev page (0x222 - x, 0x1a), next page
  (width - 0xe, 0x1a). Product grid from (0x152, 5), 45 px cells, up to
  (width - 4, 100): 10 x 2 = 20 per page at 1024 px.
- Tool bitmaps lbl_105BA96C = 0x42, 0x44, 0x46, 0x49, 0x4a, 0x4b, 0x43, 0x45,
  0x47, 0x48, 0x4c, 0x4d (in ArchTool order). Tooltips UIText STR# 0x8b.
- Toothpicks kBuildToothPick1/2 at (0x31, 6) / (0x13f, 6).
- Popup zone and roof panel area (0x13e, 5)-(width, 100).
- Product::TestArchTool jump table lbl_105BC0A0 -> cMoveTool::IsSelectorOfType
  types; cMoveTool's constructor fills the GUID lists (jump table
  lbl_105BBDAC) from OBJD +0x8a with room sort 0. Arch tool -> OBJD build type:
  water 7, wall 6 (columns), stair 3, fireplace 5, plant 4, door 1, window 2.
- UpdateViewFromCPState jump table lbl_105BC33C -> ArchObjectSortPredicate
  type (water 9, wall 8, stair 5, fireplace 7, plant 6, door 3, window 4,
  floor 0 = price). Non-object products sort by button +8 - 0x400 (signed),
  objects by cMoveTool::GetSortVal = their product's price.
- Build strings: GameData/Build.iff STR# 0x80 terrain, 0x81 walls, 0x82
  floors, 0x83 wallpapers, 0x84 hand, 0x85 pool/water, 0x86/0x87 plugin
  defaults. 1-based triples (price, name, description).
- CatalogSortPred: price then name (std::string compare; the strstr(name,
  "Lust") call in it is a leftover with no effect). The TS comparator
  lowercases names (pre-existing in data/catalog.ts).
- Roof: UIText STR# 0x93 positions "(x;y)" and tooltips; buttons
  lbl_105BC534 = 0xf3c, 0xf3d, 0xf3e, 100, 101, 0xf40; pitches lbl_105BC53C
  = {0.1 steep threshold, 0 flat, 0.4 shallow, 0.6 medium, 1 steep};
  textures GameData/Roofs/*.bmp, square powers of two (IsAllowableRoofTexture).

## ArchProduct values per tool

| Tool | kind | toolIndex (button +8) | other |
|---|---|---|---|
| 0 terrain | 5 | 0 raise, 1 lower, 2 level, 3 grass | |
| 1 water | 5 | 0 pool, 1 water | + kind 1 objects (OBJD type 7) |
| 2 wall | 3 | 0..4 | (wallpaper, wallStyle) = (0, 1) wall, (0xf8, 2) picket, (0xf9, 0xc) privacy [2], (0xfa, 0xd) iron [3], (0xfb, 0xe) Italian [4]; + kind 1 columns (type 6) |
| 3 wallpaper | 4 | pattern + 1 | wallpaper 1..30, wallStyle 1 |
| 4, 5, 6, 8, 9 | 1 | position in the tool's sorted list | guid (stair 3, fireplace 5, plant 4, door 1, window 2) |
| 7 floor | 2 | pattern | floorStyle 1..29 |
| 10 roof | - | - | CPState.archRoofHooks |
| 11 hand | 5 | 0 | |

Defaults (Product::Product): wallpaper 0, wallStyle 1, floorStyle 0.

## Wall pictures (WallManager::DrawIconic)

`world/walls.ts` (Wall / Vertex iconic mode, `WallManager.drawIconic`),
`world/wallicon.ts` (the 2D blitters), `data/buildcatalog.ts` (DrawWallIcon,
RenderCatalogShot kinds 3 / 4).

- WallManager::DrawIconic(x, y, scale, style, pattern, dir, rect) (102b9270):
  on the first call two Vertex objects (size / 2, size / 2, level 1) and
  (+ DIRS[dir]) and a Wall::BuildIconic between them (one segment, style 1,
  pattern 0; side and config bits from jump table lbl_105BC6A0 by
  direction); then Wall::SetWallStyle / SetWallPattern (both sides) /
  SetIconic, clip lbl_105BA5F4 = (-800, -600, 800, 600), Wall::Draw then
  Vertex::Draw of both vertices. The rect: x -/+ (8 << s), bottom
  y + (4 << s), top = bottom - height of the style's sprite
  (walls.iff style * 2 + (s - 1) * 0x200, frame 2; GetPixelShape is the
  frame's bounds).
- Wall::SetIconic: +0x48 = 1, +0x4c / +0x50 = (x, y), +0x54 scale; the
  vertices go to (x -/+ (8 << s), y + (4 << s)) for direction 6, else
  (x, y) and (x + (8 << s) (dx + dy), y + (4 << s) (dx - dy)) with d the
  tile step. Vertex::SetIconic: +0x50 = 1, +0x54 scale, +0x58 / +0x5c
  position, config = the wall's bit only (jump tables lbl_105BC684 first,
  lbl_105BC680 last vertex: wall slot and bit by direction), full = config
  (b = config for a fence), end caps precomputed.
- Wall::Draw iconic: RenderParam::SetState(3, 1, 1), every segment's top
  corner is (+0x4c, +0x50), altitude 0, ambient lbl_105BC690 = 1.0, no
  light entry. The iconic segment is never cut, so it is one WallBlit.
  Vertex::Draw iconic: top corner (+0x58, +0x5c), altitude 0; full-height
  top piece; end cap neighbour at (8 << s) (dx - dy), (4 << s) (dx + dy).
- The 2D blitter writes every opaque pixel: the original's z test cannot
  reject anything in this one-wall draw (state 3 depths). Vertex::Draw's
  ambient is RoomManager::GetRoom(0)'s, taken as full light.
- DrawWallIcon(style, pattern, buffer, rect) (product sheet, 0xa8 wide):
  DrawIconic(w / 2, trunc(3h / 4) + 0xe; - 0x10 for styles 2 / 0xd / 0xe,
  - 2 for 0xc; scale 2, direction 6).
- RenderCatalogShot kinds 3 / 4 (no BMP_: plugin wallpapers): DrawIconic
  into the 200x200 work buffer at (100, 150 + 0xe; 150 - 0x10 for styles
  2 / 0xc), scale 2, direction 6, then SquareOffAndShrink on the returned
  rect, on both template colors (`renderShots` in `cpanel/buy/objecticon.ts`,
  `ProductButton` asks `renderCatalogShot` of non-object products).
- Plugin wallpapers: Catalog::Init enumerates WallGraphicsMgr::BeginEnum /
  GetNextWallPaper / EndEnum (price, name, description it returns; button
  +8 = pattern + 1). The catalog has its own WallGraphicsMgr; plugin numbers
  are given in scan order, the same as the house's.
- Plugin floors: Catalog::Init enumerates FloorGraphicsMgr::BeginEnum /
  GetNextFloor / EndEnum (floors.iff 1..29, then the .flr files, 208 more
  with the expansions; button +8 = the pattern). A plugin floor has no BMP_:
  RenderCatalogShot kind 2 draws its scale 3 sprite (GetFloorGraphic, DrawFloor
  at full ambient) at (100 - 0x40, 2 * 200 / 3 - 0x2d), rectangle 0x80 x 0x40;
  the product sheet's DrawFloorIcon goes through GetFloorGraphic too. The
  catalog has its own FloorGraphicsMgr (same scan order as the house's).

## Gaps

- cRoofLayer itself: the roof panel calls `CPState.archRoofHooks` (null until
  the lot view installs it; then no pitch / pattern button is down).
- UI sounds.
