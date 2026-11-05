# Build mode: floor and wallpaper tools

Port of `cNewFloorTool` (tool id 5) and `cNewWallpaperTool` (tool id 3), with
their undoables, plus the plugin-aware `FloorGraphicsMgr` / `WallGraphicsMgr`.

## Files

| TS file | Original classes |
|---|---|
| `client/src/game/world/tools/floortool.ts` | `cNewFloorTool` |
| `client/src/game/world/tools/floorundo.ts` | `FloorUndoable`, `FloorChange` |
| `client/src/game/world/tools/wallpapertool.ts` | `cNewWallpaperTool` (+ the Wall Cursor drawable) |
| `client/src/game/world/tools/wallpaperundo.ts` | `WallpaperUndoable`, `WallpaperChangePacket` |
| `client/src/game/world/tools/worldedit.ts` | helpers: `cRotatableWorld::GetWall/SetWall`, `TileWalls::Rotate`, `cFixedWorld::SetWall/SetFloor`, `RoomManager::ResolveDiagonal`, pool layer |
| `client/src/game/world/floors.ts` | `FloorGraphicsMgr` (built-ins, plugins, FLRm usage map, `BeginEnum/GetNextFloor`) |
| `client/src/game/world/wallgraphics.ts` | `WallGraphicsMgr` (built-ins, plugins, WLLm usage map, `BeginEnum/GetNextWallPaper`) |

Both tools are registered in `BUILD_TOOLS` (`world/tools/buildtools.ts`).

## Behaviour (from the decompiled code)

### Floor
- Hover previews the floor under the cursor (the world is changed and the
  `FloorUndoable` keeps the old state; `UndoSelf` takes the preview back).
- Drag: rectangle from the anchor tile. Shift: the room under the cursor.
  Ctrl: delete (refund `trunc(0.8 * cost + 0.5)`, none on diagonal halves).
- Diagonal walls: `GetQuadrant` picks the half; halves stored in
  `styles[0]` (sides 1, 2) and `patterns[0]` (sides 3, 4), tile floor `0xff`.
  A half costs `cost / 2`.
- Not floorable: out of lot, `flags[0] & 0x20`, pool tiles, objects with
  placement flags forbidding floors (`OD.placementFlags & 1 / 2 / 0x200`).
- Tips: running total at the anchor tile, or UIText STR# 0x9a entry 3 when
  the player cannot afford it.
- Sounds: `UI_bld_dragtool_mousedown`, `UI_bld_dragtool_mouseup`, `UI_error`.

### Wallpaper
- Cursor is the "Wall Cursor" object (GUID 0x439, graphic 2), moved by
  `ModifyCursorPos` (`v += 100 >> (3 - scale)`), which XViewer applies to the
  mouse events and DoDynamicCutaway to the cursor (the tool's `modifyCursorPos`
  is the cutaway hook).
- Click/drag paints the nearest wall side; Shift paints the room's sides;
  Ctrl removes (refund of `0.8 *` old cost). Fences refuse (code 0x2e).
- Tips: `cMoveTool::ShowPlacementTip` codes (UIText STR# 137), money tip
  `§n`; "must be placed against a wall" when no wall.

### Graphics managers
- Strings: Build.iff STR# 0x82/0x86 (floors), 0x83/0x87 (walls).
- Plugin numbers: floors `[0x1e..0xfe]` then `[0x100..0xfffe]`, walls
  `[0x1f..0xf7]` then `[0x100..0xfffe]`.
- Plugin scan order: ExpansionPack, 2, 3, 4, Deluxe, 5, 6, 7,
  ExpansionShared `WallsAndFloors/`, then `GameData/Floors/` or `GameData/Walls/`.
- `loadUsageMap(house, fixed)` renumbers the house's FLRm/WLLm to the
  current numbering and rewrites the world (floors, diagonal halves, wall
  patterns).

## Known gaps

- `XViewer::MouseTrack` compares the full float tile point with the last
  point a tool's Drag stored (`lbl_105BA4A4`); `gametools.ts` compares tiles
  and records at mouse down, so a single click without moving never drags:
  a floor click alone paints nothing.
- `winlotview.ts` should call `floors.loadUsageMap(house, world.fixed)`.
- Diagonal floor halves are not drawn by the house viewer yet
  (`HouseViewer::RenderTerrainRow` draws each half through
  `cRenderer::DrawFloor` with scanline clipping).
- Tool mouse cursors (`SetToolCursor`) not wired.
- `cFixedWorld::SetWall` vertex analysis (`AnalyzeWallVertex`) skipped.
- `worldedit.ts` and `wallworld.ts` (wall tool port) are merged (2026-11-05): the wall primitives
  (TileWalls::Rotate, cFixedWorld::SetWall, the pattern slots, SetFloor, MayEditTile) live in
  `wallworld.ts`; `worldedit.ts` keeps the rotation-carrying `RotWalls` API on top of them. Checked
  equal to the old code on 100 000 random tiles (bytes written, rotated slots of present segments).
