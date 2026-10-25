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
