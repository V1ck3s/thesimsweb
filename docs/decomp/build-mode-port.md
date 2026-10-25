# Build mode port (cGameTools, cNewWallTool, WallUndoable, cXPortal walls)

Overview of the build mode as ported. Each part has its own notes:

- `build-panel-port.md`: cWinArch, cWinRoofPanel, build catalog.
- `build-terrain-port.md`: cDirtTool, cSimpleAltTool, cLevelDirtTool, cGrassTool, TerrainUndoable.
- `build-floor-wallpaper-port.md`: cNewFloorTool, cNewWallpaperTool, their undoables, FloorGraphicsMgr / WallGraphicsMgr.

This file covers the shared tool framework, the wall tool, doors and windows in walls, and how everything is wired.

## Tool framework (`client/src/game/world/tools/`)

| File | Original | Role |
|---|---|---|
| `tool.ts` | cTool | Base class: vtable defaults, running total, purchase / refund / FinalizePurchase, tool sounds (400 ms apart), tool tips. `ToolHost` is what the lot view gives the tools: world, placement, undo, funds, sounds, tips, strings, `ctx`, plus the `dirty.walls / wallsPreview / floors / terrain` refreshes. |
| `gametools.ts` | cGameTools, XViewer | The 12 tool slots, `SetCurrentToolByID`, `ArchSetCurrentTool` (table lbl_105BC0B8), and the mouse dispatch: Float / Click / Drag / Release, then kaching + FinalizePurchase when the running total is not zero. |
| `undo.ts` | Undoable, UndoManager | States 0 new, 1 done, 2 undone, 3 failed. `UndoIt` commits a new undoable, then calls UndoSelf; `RedoIt` calls RedoSelf. Sub-undoables are run by the owner's UndoSelf / RedoSelf, like in the original. `FreeSubUndoables`. |
| `buildtools.ts` | cGameTools::cGameTools | Registry of tool factories by id: 0 / 1 / 4 / 11 terrain, 2 wall, 3 wallpaper, 5 floor. |

XViewer::MouseTrack skips a Drag only when the fixed-point position equals the last point a Drag saw (lbl_105BA4A4), unless the tool is RapidFire. The position is reset on mouse down, so the MouseTrack that follows Click drags at the click point. The floor tool needs this to paint on a single click.

### CPState (`cpstate.ts`, additive)

- `ArchTool` enum (UIText STR# 139 order).
- Per-tool sub-tool (`archSubtools`).
- `archSetCurrentTool`: switches the wall state from Roof back to Up for doors and windows.
- `archUndo` / `archRedo` / `archCanUndo` / `archCanRedo`, through `archUndoHooks` (installed by the lot view on the UndoManager).
- Dirty bits 0x4 (undo), 0x10 (tool), 0x20 (sub-tool).
- `worldUpdateHook`: the lot view's `CPState::UpdateWorldFromCPState`. It re-applies `ArchSetCurrentTool` when the panel picks a default sub-tool inside `CPState::Update`.

### Lot view wiring (`winlotview.ts`)

- **Mode changes:**
  - Buy: tool 7 (cMoveTool), with the hand or the shop item.
  - Build: `archSetCurrentTool(tool, subtool)`.
  - Any other mode: no tool.
- **`wallsChanged(level)`**, i.e. GlobalDispatch(0x91): `WallManager.rebuildFromMap(level)`, then `computeRooms`, `rooms.computeCutaway`, `cutaway.onRoomsChanged`, and `lighting.compute`.
- **`wallsPreview(level)`**, i.e. WallManager::AsynchronousRebuild: only the wall graph is rebuilt while dragging.
- `Placement.onWallsChanged`: cXPortal style changes call `wallsChanged`.
- Floors: `floors.loadUsageMap(house, world.fixed)`, which renumbers FLRm plugin floors.

## cNewWallTool (`walltool.ts`)

**Mouse snapping.** Float, Click and Drag snap the mouse to the nearest grid point. The rule (lbl_105BBE04 = {1/16, 0.5, 0.25}) is: `if (f/16 - (f>>4) >= 0.5) f += 16`, then `vertex = f >> 4`.

**Mode.** The mode is taken from the keys at every event: Shift gives 2 (rectangle), Ctrl gives 1 (delete), otherwise 0 (draw). OnKeyDown and OnKeyUp of Shift / Ctrl replay the last event.

**SetParameter(style).** Style 1 is a wall: Click calls SetWallType(0xff, 0xff), a construction placeholder. Fences 2 / 0xc / 0xd / 0xe use patterns 0xf8 / 0xf9 / 0xfa / 0xfb.

**Click.** A click on a tile that is out of the lot or not editable gets tip 1 and the denied sound. Then:

- If the vertex tile is not legal: on level 2 and above (draw mode, tile flag bit 0 clear), tip 0x20 "needs a floor".
- On level 2 and above, the 4 tiles around the vertex (lbl_105BBDF8 = {8, 0, 4, 2}) need a floor, otherwise tip 0x20.
- Otherwise: SetOriginVertex, SetWallType, play `UI_bld_dragtool_mousedown` (not in delete mode).

**Drag.**

1. Compute the mode. If it changed, run ResetAll, then SetOriginVertex(origin).
2. Run ResetAll. This restores the preview through UndoSelf and refunds the running total.
3. If the snapped vertex is still the clicked one but the mouse moved more than half a tile, take the next vertex in the screen direction (`ComputeArtificialDragPoint`: atan(dv/dh) against ±π/8 and ±3π/8, picking a CTilePt::Dir).
4. Run AdjustEndpointVertex.
5. Move the cursor vertex, then `wallsPreview`.
6. Show a tip: the error, else 0x19 "cannot afford", else 0x1a with the cost.

**Release.**

- If the player cannot afford it: ResetAll.
- If there is a change: play `UI_bld_dragtool_mouseup` (the explode sound in delete mode), then CleanupWallpaper, SubmitUndoable, a new WallUndoable, and `walls(level)` (plus level 2 when on the ground floor).

**Wall cursor.** The "Wall Cursor" object (Cursors.iff, GUID 0x439) is drawn at the cursor vertex by `drawOverlay`. Its graphic is 0 for draw, 1 for delete and 3 for a rectangle (cNewWallTool::SetCursor).

**Prices.** lbl_105BA4CC (wall style prices) is filled from `loadBuildCatalog(ctx).prices.wallStyle` (Build.iff STR# 0x81). Style 0xff shares the price of style 1.

## WallUndoable (`wallundo.ts`)

**Preview.** The preview is the world itself:

- `Reset` undoes a dirty preview (UndoSelf), then copies the level's 64×64 wall records into the undoable.
- `DoLine` / `DoRectangle` call `ChangeTile`, which writes the world directly (cRotatableWorld::SetWall).
- `UndoSelf` / `RedoSelf` swap the copy with the world record by record. The copy therefore always holds the other state.
- UndoSelf refunds the cost and RedoSelf charges it again. When the undoable is not new, or the tool cannot afford, the change is also paid (FinalizePurchase) and `walls(level)` runs.

**Coordinates.** Everything is in view coordinates. A line walks tiles in a CTilePt::Dir:

| Dir | Segment touched |
|---|---|
| 0 / 1 | 0x01 |
| 2 / 3 | 0x02 |
| 4 / 5 | 0x20 |
| 6 / 7 | 0x10 |

- VertexToTile / TileToVertex come from jump tables lbl_105BBE68 / 6C: dirs 0 / 2 / 4 step by DIRS[dir], dir 6 steps by DIRS[0], dir 7 by DIRS[2], the others use the same point.
- `GetDirection` and `SnapToLine` are ported exactly, including the parity fix for diagonals.
- `DoRectangle` turns after each side with the table {2, 3, 1, 0, 7, 6, 4, 5} (lbl_105BBE78 / 74 / 70).

**CanChangeTile, delete mode.**

- The segment must be present. Diagonals can always be deleted.
- A door or window that UserCanDelete refuses blocks the delete (error 0x23).
- Any other object that hangs on the wall from either side blocks it (error 0xb). This uses wall placement flags 1 / 8 / 2 / 4 for segments 2 / 1 / 4 / 8 in the object's frame.

**CanChangeTile, draw mode, in order:**

1. LegalWallTile: both tiles inside the lot and editable (error 1). No visible person, and no object (or multi-tile part) in use (use count, OD 62, gives error 0xb).
2. FlatTile for non-fences: the 4 corners at the origin's altitude (error 0x11).
3. MayEditTile.
4. TileWalls::CanAdd: diagonals stand alone, and there is no ortho segment against a diagonal neighbor.
5. Tile flag bit 0 (floor or ground support) on one side, unless it is a fence on level 1 (error 0x20).
6. Object wall-block flags 0x100..0x800 on both sides (error 0xb). A diagonal is refused if the tile holds any object except type 9 (error 0xb). Pool on both sides gives error 0x1d.
7. A diagonal touching the vertex next to the segment.
8. CanAfford(price) for a new segment, which sets `cannotAfford`.

**ChangeTile.**

- **Adding a segment:**
  - Set the segment bit and the style.
  - Write the pattern on the front side: ortho slot, 0x10 side 4, or 0x20 side 1.
  - A diagonal clears its half floors.
  - A construction wall (0xff) also writes its pattern on the other side (the adjacent tile's opposite segment).
- **Removing a segment:** refund `trunc(-(0.8 × price - kill refund))`. A split diagonal floor (0xff) gets its floor back from the walls' half floor.
- **Door and window walls** (styles 3, 5, 6, 0xf, 0x16, 0x17): `KillArchitecturalObject` deletes the portal on that segment. It is refunded `trunc(0.8 × value + 0.5)` and becomes an ObjectUndoable delete (a post-sub in delete mode, a pre-sub otherwise). In delete mode, the copy's style is set back to 1, so an undo restores a plain wall and the door (whose placement then re-applies its style).

**CleanupWallpaper** runs over the whole level, in world coordinates:

- A construction wall (pattern 0xff) becomes style 1 with pattern 0, on each side.
- A fence gets its pattern on both sides.

**Wall writes** (`wallworld.ts`):

- `setFixedWall` ports cFixedWorld::SetWall: a diagonal record overwrites byte 0. For 0x04 / 0x08, it writes the neighbor's 0x01 / 0x02 style and placement, and clears the facing pattern when a segment goes.
- `rotateWalls` ports TileWalls::Rotate, covering segments, styles, patterns and placements. Diagonal sides turn by the lbl_105BA55C table (`((s - 1 + r) & 3) + 1`), and the half floors follow their sides.
- `getViewWall` / `setViewWall` port cRotatableWorld::GetWall / SetWall.

## Doors and windows (`placement.ts`, cXPortal)

They are placed by cMoveTool modes 3 (door) and 4 (window), set from the build lists by `SetParameter` (build item: 80 % refund, expense 7). cXPortal is ported for its wall:

- `Place` → `ApplyWallStyle`: each part that has a wall style (OBJD +0x5c, e.g. 0x16 / 0x17) and a required segment writes that style on the wall it hangs on.
- `Pickup` writes style 1 back before the parts leave.
- `CanPlace`: every such part needs a plain wall (style 1) there (error 0x16), and the head must be centered on its tile (error 3).

## Tested (headless Chrome, house 1, `gameTools.mouseDown/Track/Up` in eval)

- **Line wall:** 3 segments at §75. Funds 66599 → 66374, walls drawn grey and unpapered (`w-view.png`).
- **Rectangle with Shift:**
  - The 4 sides are drawn.
  - When a side reaches a non-editable tile (sidewalk row, error 1), the rectangle falls back to the last good corner, as in the original.
- **Ctrl delete:** 1 segment, +§60. Undo and redo through `CPState.archUndo / archRedo` restore funds and walls.
- **White fence:** pattern 0xf8 on both sides (`w-fence.png`).
- **Door in the house:** deleting its wall kills both door parts and refunds §84 (§60 + §24). Undo restores the wall (style 22) and the door; redo deletes them again.
- **Existing door picked up and put back:** its wall goes from style 22 to 1, then back to 22.
- **Regression checks:** a single floor click paints (-§5), and Buy mode still selects cMoveTool.

## Gaps

- **New doors and windows bought in Build mode** get no wall placement flags (OD 13 = 0) without their init tree. GetRequiredSegment is then 0, so their wall style is not applied and they are not required to stand in a wall. Doors already in the house have them (1 / 4). This needs the VM's init tree on new objects (`hooks.runInitTree`).
- **DeleteObjectUndoable** kills the object through `killObject` (the simulation drops it). An undo puts the same XObject back in the module and in the world, but the simulation does not get it back.
- **Not ported:**
  - pool and water tools (9, 10) ;
  - cTileTool (8) and cObjPickerTool (6) ;
  - roof editing (cRoofLayer; only the panel exists) ;
  - stairs and fireplaces checks beyond cMoveTool's ;
  - `cTool::AdjustCutawayForTool` ;
  - the system tool cursor (`SetToolCursor`).
- **Real pointer events in the test harness** do not reach the tools reliably (`pointerdown`), so the tests drive `GameTools` directly.
- **Duplicated helpers:** `worldedit.ts` (floor / wallpaper agent) duplicates parts of `wallworld.ts` (GetWall / SetWall / Rotate). The two should be merged.
