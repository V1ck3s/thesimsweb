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

## Gaps

- Plugin floors / wallpapers (.flr / .wll): pattern numbers come from the
  graphics managers' number pools, pictures from RenderCatalogShot.
- RenderCatalogShot (objects without a BMP_ thumbnail show kItemUnknown).
- DrawWallIcon (product sheet picture of wall styles and wallpapers) and
  RenderCatalogShot kinds 3 / 4 (catalog picture of plugin wallpapers): both
  go through WallManager::DrawIconic (102b9270): a one-segment iconic Wall
  (Wall::BuildIconic between two Vertex objects, direction 6) set to the
  style / pattern, Wall::SetIconic(x = w / 2, y = ceil(3h / 4) + 0xe (-0x10
  for styles 2 / 0xd / 0xe, -2 for 0xc in DrawWallIcon; -0x10 for 2 / 0xc in
  RenderCatalogShot), scale 2), then Wall::Draw and Vertex::Draw of both
  vertices in iconic mode (Wall +0x48: pixel origin +0x4c / +0x50 instead of
  ComputePixelTopOfTile, RenderParam::SetState(3, 1, 1)), clipped to
  (-800, -600, 800, 600); the drawn rect is (x -+ 8 << s, y + (4 << s) -
  pixel shape height of walls.iff list style * 2 + (s - 1) * 0x200).
  `world/walls.ts` draws through the WebGL Compositor of the house view and
  has no iconic mode, so this needs an offscreen wall/vertex draw first.
- cRoofLayer itself: the roof panel calls `CPState.archRoofHooks` (null until
  the lot view installs it; then no pitch / pattern button is down).
- UI sounds.
