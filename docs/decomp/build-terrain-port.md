# Build mode: terrain tools port

Ported from the Mac decompilation (`TerrainTools.s`, `GroundTool.s`, `LevelTool.s`,
`GrassTool.s`; pseudo-C `cDirtTool.c`, `cSimpleAltTool.c`, `cLevelDirtTool.c`,
`cGrassTool.c`, `TerrainUndoable.c`).

| Tool id | Original | TS |
|---|---|---|
| 0 / 1 | cSimpleAltTool (+0x50 = 1 / -1), base cDirtTool | `world/tools/simplealttool.ts`, `dirttool.ts` |
| 4 | cLevelDirtTool (base cDirtTool) | `world/tools/leveldirttool.ts` |
| 11 | cGrassTool (base cTool) | `world/tools/grasstool.ts` |
| — | TerrainUndoable | `world/tools/terrainundo.ts` |

Registered in `world/tools/buildtools.ts`. World helpers added to `RotatableWorld`
(`world/world.ts`): `setPackedAlt` (cRotatableWorld::SetPackedAlt, with the 12
neighbor corner copies), `getTargetGrass` / `setGrass` / `setTargetGrass`,
`mayEditTile` (flag 0x20 of the level 1 flags, or build-anywhere).

## Data read from the binary

- Sounds (lbl_105BBE54 + 9 / + 0x1a, lbl_105BBD8C + 9): `Ui_terrain_raise`,
  `Ui_terrain_lower`, `Ui_terrain_level`.
- Error tips: UIText STR# 0x95 entries 0..6 (cDirtTool::cDirtTool loads 7);
  UpdateErrorMessage's jump table lbl_105BBE50 maps error 1..6 to entries 0..5,
  8 to entry 6, 7 to the hard-coded "Area too large" (lbl_105BBE54 + 0x2b).
- Price of one altitude unit (lbl_105BA524): Catalog reads Build.iff STR# 0x80
  entry 0 ("1").
- lbl_105BF2F8 = 0xfb (ForceGrade clears flag bit 2).
- Neighbor tables: lbl_105BBE4C (vertex -> its 4 tiles: self, (-1,0), (-1,-1),
  (0,-1)), lbl_105BA590 (__sinit: DIRS[3], DIRS[1], DIRS[2], DIRS[0]).
- Terrain cursor object: GUID 0x2f39b7a6 (Cursors.iff), graphics 0 raise,
  1 lower, 2 error, 3 level anchor / grass, 4 level corner.

## Behavior summary

- Altitudes are PackedAlt byte 1 (a view tile's top corner). Max 0x40.
- Raise / lower: click = 1 unit; Shift reverses; Ctrl = 7 random corners
  (SGSRand(4) offsets) pulled toward the neighbors' average. Repeats 400 ms
  after the click, then every 100 ms of drag (RapidFire). Each Apply is paid
  immediately (Purchase + FinalizePurchase); failure restores the altitudes
  and plays the denied sound.
- ForceGrade: neighbors more than 5 units away are pulled to 5, recursively;
  extra units cost the altitude price.
- MayModifyTerrain: the 4 tiles around the corner must have no floor (levels
  1, 2), no wall, no water, no pool/deck, not be on the lot's second row, not
  hold an object without placement flag 0x100 (on slope), and be editable.
- Level: drag previews (apply, check funds, highlight green/red, restore);
  release applies. Multi-tile objects must be wholly inside (error 5), each
  multi-tile part met costs 5. Escape cancels.
- Changed corners turn the 4 tiles around them to dirt (grass 0x80).
- Grass: target grass and grass += 10 (Ctrl down: -50, Ctrl up: 50), free, no undo.
- Undo: TerrainUndoable snapshots altitude + grass at the click; undo/redo swap
  and refund / charge the cost through the tool.

## Shortcuts / gaps

- Terrain cursor objects are not real lot objects (no tile array entry); drawn by
  the tool's `drawOverlay` like cXCursorObject (see `cursorobject.ts`).
- cDirtTool::OnChar: 'o' (0xbc, grid overlay) and 'h' (800, cTerrain flatOnly)
  are ported; '1'..'9' (0x9a.., cTerrain renderer swaps) are not.
- cDDDSimsView::SetToolCursor / cTool::SetCursor (system cursor) not ported.
- DirtyTile / DirtyTileNeighborhood: the whole terrain is re-rendered.
- cPoolTool / cPoolUndoable / cWaterTool / cWaterUndoable: not ported (they need
  cPoolLayer / cWaterLayer edge computation, pool rooms and people checks,
  TileWalls::GetWallBetween, and the client does not draw pool or water tiles yet).

## map_edit: cTileTool and the map overlay (2026-11-06)

`world/tools/tiletool.ts` (cGameTools tool 8, registered in `buildtools.ts`), `world/terrain_maptile.ts`,
`cpstate.ts` (`setCheatTool`, `cheatToolActive`), `world/winlotview.ts`, `world/terrain.ts`, `ui/cheat.ts`.

- "map_edit on|off" (AppCheatCallback case 8): when lbl_105BA68C changes and tool 8 exists, the flag
  is set, GViewer::DirtyAll, and on: SetParameter(0) + CPState::SetCheatTool(tool); off:
  SetCheatTool(0). CPState +0x50 (a cheat tool is current) makes UpdateWorldFromCPState leave the
  tool alone in every mode, so the tile tool keeps the mouse in live, buy and build mode; turning it
  off gives the mode's tool back. prepare_lot clears the flag and the cheat tool.
- cTileTool: Float (Windows `Float__9cTileTool`: the interior tile under the mouse, state 1);
  Click lifts the ground flags (LiftGrid: flags & 0x20 of the 64 x 64 tiles), paints the opposite of
  the clicked tile's 0x20 flag, state 2 (3 with Shift: rectangle from the clicked tile, DropGrid
  first on each drag); Drag paints each new interior tile; Release with Ctrl drops the lifted layer
  back (undo). DropGrid writes the lifted byte (only 0x20) over every differing tile, clearing that
  tile's other flag bits, as the original does.
- Grass mode (2026-11-06): "edit_grass n" (AppCheatCallback case 9, not in the shipped cheat list:
  `?devcheats` only) takes tool 8 (nothing without it); n = 0 is SetCheatTool(0), else
  SetParameter((short)(n * 16 + 1)) and SetCheatTool(tool); lbl_105BA68C is not touched (no map
  overlay). With parameter & 0xf = 1, Click (after Float) and Drag call the global BumpGrass(tile,
  parameter >> 4): target grass + n clamped to -128..127 becomes the tile's target grass and grass,
  cTool::DirtyTile; no interior check (cGrassTool's BumpGrass has one); Release does nothing.
  Deviation: tiles outside the 64 x 64 arrays are skipped. Tested: "edit_grass -120" turns the lawn
  clicked to dirt.
- Tested in a lot (UserData32 House56, 2026-11-06): map_edit on draws the overlay and a click paints a
  tile white (0x20); map_edit off restores the grass; genable walls off hides the walls, genable status
  lists the switches; draw_floorable off removes the upper level's grid over the floorable tiles;
  sim_log begin / end hands SimLog.txt over and shows "Logging completed...".
- HouseViewer::RenderStaticRow draws cTerrain::DrawMapOverlay on every ground tile while the flag is
  set: cTerrain::Draw with cMapTileSwatch (+0x14) instead of the grass and no grid. cMapTileSwatch::
  Draw (asm): columns every 4 pixels, each topped by 4 black pixels, then every 4th row a pink
  (0xff8080) pixel and, 2 pixels right, white for a 0x20 tile or black. The column steps use the
  altitudes unscaled (laid for zoom 1, as in the original). Deviation: drawn in the terrain pass
  right after the grass (the terrain raster cache keys on the flag), so floors and objects always
  cover it, where the original draws it in the static row pass; DrawClipped is the same pattern cut
  per pixel to the clip rectangle (the original drops whole columns).
- draw_floorable (lbl_105BA690, initially 1) now gates the upper level's build grid
  (`houseviewer.ts` renderStaticRow), with GViewer::DirtyAll.
- genable (graphics cheat 10): terrain / floors / walls / objects / people switch the matching passes
  of `houseviewer.ts` (RenderTerrainRow, the floors, DrawWalls, the static row objects and
  RenderDynamicObjects, UpdateStaticDynamic's 3D people); with floors off the upper level shows the
  grid where floors were (RenderStaticRow). clear, full_draw, static_rows, static and old_clear are
  kept for "genable status" only (static layer / damage refresh not in this renderer).
