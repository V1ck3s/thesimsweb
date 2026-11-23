# Light pools, pools / water and the pool / water tools: port notes

Status as of 2026-10-25. Everything here is ported from the Mac decomp
(`mac-pseudoc-annotated/`, `mac.bin` for constants). Read
[`porting-guide.md`](./porting-guide.md) and [`cutaway-port.md`](./cutaway-port.md) first.

## 1. Light pools (LightMapSet / LightLayer)

Files: `client/src/game/world/lightmaps.ts` (new), `lighting.ts`, `compositor.ts`,
`houseviewer.ts`, `wallrender.ts`, `walls.ts` (one call site).

### Data flow

1. `RoomLighting.compute()` (lighting.ts) clears its two `LightLayer`s (one per
   level). `collectObjectStats` (Room::CollectObjectStats) calls
   `RemoveLight` + `PositionLight` for every object with OD40 & 0x400, in the
   world, with an OD51 contribution != 0 and OD16 `lightSource == 1`.
   A contribution of 0 only calls `RemoveLight`.
2. `LightLayer` holds 64x64 `LightEntry` records of 4 int8: two (dx, dy)
   offsets, tile minus light, world coordinates (0x7f = none).
   - `PositionLight` fills the tiles of the light's room within
     `lightRadiusTiles()` = int(0.5 + 12 / 3) = 4. Degenerate diagonals of
     that room count too.
   - It keeps the 2 nearest lights.
   - LightingParameters come from `lbl_105BBF64`: radius 12, inner 3.2,
     outer 12; enabled flag +0x3a.
3. `HouseViewer.lightEntry(x, y, level)` comes from
   `RoomLighting.getLightEntry` (cRotatableWorld::GetLightEntry). It rotates
   the offsets into view space:
   - rot1 gives (-dy, dx)
   - rot2 gives (-dx, -dy)
   - rot3 gives (dy, -dx)
4. Floors (`setFloorLight`) and walls (`WallRenderer.setWallLight`) turn each
   valid entry into a light map plus an origin, stored in `comp.light`:
   - floors: ProcessFloorLightEntry
   - walls: ProcessWallLightEntry
     - segment 1 needs dx < 1: lat = -dy, dist = |dx|
     - segment 2 needs dy < 1: lat = dx, dist = |dy|
     - diagonal walls are never lit
5. The compositor's fragment shader adds the R8 map texels (`uLit0` /
   `uLit1`) to `int(255 * ambient + 0.5)`. It clamps to 0..255, then
   converts to the dark-map level `(level & 0xf8) / 8`, the same formula as
   PrecomputeDarkMap. This only runs when ambient != 1, like the lit
   blitters. Objects are not light-mapped (comp.light is null for them).

### Light maps (LightMapSet)

The original caches these maps in a file. Here `lightMapSet` builds them
lazily in memory.

- **FloorLightMap(scale):**
  - tile width `tileW = 0x80 >> (3 - s)`; the map is `W = tileW * 7` wide
    and `H = W / 2` high
  - the light is at height 5
  - value: `255 * (1/d² - 1/119) / (1/25 - 1/119)`
  - `floorOrigin(dx, dy)` gives col `tileW/2 * (dx - dy + 6)` and row
    `tileW/4 * (dx + dy + 6)`; range 3
- **CanonicalLightMap(i):**
  - `WallTileCount(i) * 64` wide (5, 5, 4, 3), 232 rows
  - the light is at (1.5, -(1.5 + 3i), 5); rows are flipped
- **ShearedLightMap(scale, type, i, lat):**
  - width `8 << s`
  - type 0 rows: `(r - ((4 << s) - 1)) << (3 - s) + sc / 2`
  - type 1 rows: `(r << (3 - s)) - (sc + 1) / 2`
  - negative laterals are mirrored
  - the map origin is the sprite y + `1 << s` (skip)

### Verified

Screenshots taken during the check (not kept in the repository): `l*-day/night`,
`lamp29_20-*`, `lamp30_26-*`, `down-*`.

- House01 at night, walls down (`state.setWallState(2)`): floor pools with
  banding rings around both lamps (GUIDs ac907541 at (29,20) and 9b067a8b at
  (30,26), contribution 75), plus pools on the walls.
- In daytime, ambient is 1, so there are no pools.
- Rooms with lamps clamp to 0.8 at night, so the pools are subtle (dark-map
  level 25 to 31).

### Not ported / to check

- Only `lightSource == 1` lights are positioned, and that is the original:
  Room::CollectObjectStats calls LightLayer::RemoveLight / PositionLight
  only for objects whose +0x6a (light source) is 1, and nothing else calls
  PositionLight. Windows (light source 0 in House01) only add their
  contribution to the room's window light (the ambient level). There is no
  outdoor light pool through windows to port (see roof-port.md).
- Floor halves of diagonal walls are drawn (HouseViewer.drawTileFloor, see
  roof-port.md), with their rooms' ambient and filtered light entries.
- No light maps on objects. I have not confirmed whether the original lights
  objects with maps; the DrawIso path I read uses only the ambient level.
- Light map file caching (the original's `.lmp` cache) is skipped; maps are
  built on first use (a few ms).

## 2. Pools and water (drawing)

Files: `client/src/game/world/pools.ts` (new), `houseviewer.ts`, `floors.ts`.

- `pools.ts`:
  - cPoolTile::Rotate: `rotateTileBits`, table lbl_105BA3B4
  - cPoolLayer::GetOverlappingSprite: CORNERS table lbl_105BBB9C
  - AddPool / RemovePool: dirs [2, 0, 3, 1], masks [8, 4, 2, 1]
  - ClearDeck
  - the sprite ids
  - Layer bytes:
    - 0xff: none
    - 0..0xf: pool, plus neighbor bits 1 (0,-1), 2 (-1,0), 4 (0,+1), 8 (+1,0)
    - 0x10: deck
- `HouseViewer.drawPoolTile` (RenderStaticRow, level 1, before objects):
  - global floor renderer sprite `0x400 + (s - 1) * 0x10 + rotated bits`;
    the deck is `0x0c + (s - 1) * 0x100`; inner corners are
    `0x430 + (s - 1) * 4 + k`
  - position: `RenderParam.setGridCoords` at the world tile center, minus
    (8 << s, 4 << s)
- `floors.ts` `drawFloor` now adds the frame's xLoc / yLoc to the position.
  The pool corner frames need it; other floors have 0.
- `HouseViewer.drawWaterTile` (RenderTerrainRow):
  - sprite `0x800 + rotated bits`, frame `3 - s`, drawn at
    (x - 1, y - (s == 3 ? 4 : 1))
  - floor-style depth at terrain Z + 0x50
  - the frame's transparent index is keyed out. SPR2 cmd-1 pixels skip the
    transparent test, so without the key the water draws magenta.
- Saved houses: FixedWorld.load reads Arry 9 / 10. House02 (pool, ladders,
  diving board) and House47 (lake + pool) render at zoom 2/3 and rotations
  0-3 (`shots/poolr*-0.png`, `water-0.png`).

To check: multi-tile ponds show a darker olive diamond around the water. Those
are the sprite's own non-keyed pixels (index != transparent index). It looks
intentional ("wet grass"), but nobody has compared it with the real game.

## 3. Pool and water tools (cPoolTool / cWaterTool)

Files: `client/src/game/world/tools/pooltool.ts` (new), `tools/buildtools.ts`
(registered for ToolId.Pool = 9 and ToolId.Water = 10), `houseviewer.ts`
(`applyDynamicPoolLayer` / `removeDynamicPoolLayer` and the water
equivalents). The Water panel buttons were already routed through
`GameTools.archSetCurrentTool` (button 0 for Pool, 1 for Water).

### Select and deselect

- **Select** copies the world layer into `original` (+0x3c) and `preview`
  (+0x38) and clears the world layer. The viewer then draws `preview`
  (ApplyDynamicPoolLayer).
- **Deselect** writes `preview` back and dispatches 0x91, which is
  `host.dirty.walls(1)`: pool rooms, cutaway, lighting.

### Gesture

1. **Float** previews one tile.
2. **Click** checks the tile and creates the undoable. Its "before" layer is
   the previous done undoable's "after" layer, else a clone of `original`.
3. **Drag** does the following:
   - restarts from `original`
   - takes back the previous charge
   - re-adds (or, with Ctrl, removes) the whole world rectangle from the
     click tile to the current tile
   - rebuilds the deck (AddDeck / CanSupportDeck; pools only)
4. **Release** submits the undoable, then FinalizePurchase and Kaching.
   Release calls Drag, but Drag returns at once because the button-released
   flag is set; that is also how the original behaves.

### Checks

**AllTilesPoolable** fails with one of these UIText STR# 137 codes (tip shows
entry code - 1):

| Code | Cause |
|------|-------|
| 1 | Tile outside the lot or not editable |
| 0x11 | Altitude differs from the click tile, or the click tile is not flat |
| 0xb | An object is on the tile (except hidden objects and windows) |
| 0x1d | Water is on the tile (pool tool) |
| 0x13 | A pool or deck is on the tile (water tool) |
| 7 | A diagonal wall, or a wall towards a neighbor that is pool or inside the rectangle |
| 0x15 / 0x19 | Not enough funds |

**AllTilesDepoolable** fails with:

| Code | Cause |
|------|-------|
| 0x2c | A person is in the pool room (pool tool) |
| 0x2d | Pool equipment (build type 7) is on the tile |
| 0x23 | Any other object is on the tile (water tool) |

### Money

- Price per tile:
  - the pool uses lbl_105BA4C8, default 100
  - water uses lbl_105BA5C4, default 15
  - both read from the catalog prices
- Removing pool tiles refunds `trunc(0.8 * n * price + 0.5)`
  (lbl_105BBE1C = 0.5, -0.8).
- Removing water is free.
- The cPoolUndoable / cWaterUndoable UndoSelf / RedoSelf swap the layers and
  money the same way. When the tool is selected, they write into the tool's
  `preview` / `original` instead of the world (lbl_105BA580 / lbl_105BA5BC).

### Verified on House01 (throwaway eval scripts)

All of these work: pool add, deck, inner corners, refunds, undo / redo,
delete, commit on deselect, and undo after deselect. The same goes for water
(`shots/pool-after.png`, `pool2-after.png`, `water-after.png`). The dragged
rectangles cost 400 / 100 / 100 for the pool and 60 / 15 / 15 for water.

### Deviations / open points

- The original draws the dynamic layer in `HouseViewer::RenderDynamicPoolLayer`
  (dynamic pass). The port draws it in the static pass, in place of the
  (then empty) world layer. It looks the same here because the port redraws
  everything.
- Room::IsPool for the person check reads the room's first tile in
  `original`. A person's room (person +0x84) is taken from the room of the
  tile they stand on.
- The tool cursor (`cDDDSimsView::SetToolCursor` 0 / 6) is only stored in
  `toolCursor`.
- Saving while the pool or water tool is selected: House::SaveFile calls
  XViewer::IssueToolSelection(0) after the stats and before
  cFixedWorld::Save; `savegame.ts` does the same (`gameTools.issueToolSelection(null)`),
  so the tool's Deselect writes its layer back first. Verified on House02
  (77 pool tiles: 0 while the tool is selected, 77 in the saved file).

## 4. Roofs

Ported: see [`roof-port.md`](./roof-port.md).

## 5. Object floor shadows and the SPR2 decoders (options "shadows" / "anti-aliasing")

- **Shadows** (lbl_105BA240[0x38], cOptionsMgr::SetShadows, key `s` in cDDDSimsView: both redraw the
  view). The flag is read by cXObject::DirtyShadow / Place / Pickup (floor dirtying) and by
  HouseViewer::RenderStaticRow (101c1450): after the tile's floor and pool tile, before its objects,
  cXObject::GetTileShadow of the tile's first object (the first along the sibling chain not hidden
  (+0x8e), without flag 4 (+0x5a), not of type 2 or 9, with a shadow id +0x184; id turned by its direction
  / 2 through lbl_105BA23C, brightness ObjSelector::GetShadowBrightness), the id turned again by the
  view rotation, FloorShadowMgr::GetShadow(id) of the scale, then DrawShadow(x, y, shadow, 0xff - (int)(255
  * ambient + 0.5) + brightness, w, h, floor rows, GetTerrainZ + (level - 1) * level step - row) at the
  tile center's RenderParam position minus half a tile (101bc600: a byte b with offset + b < 0xf8,
  clamped at 0, darkens by the dark map row (offset + b) >> 3 where the floor depth is not behind the
  z-buffer; no depth write). Port: `HouseViewer.drawTileShadow`, `ObjectModuleDrawer.getTileShadow`,
  `Compositor.drawShadow` (a pass that copies the target under the tile and darkens it with the dark map
  formula of the sprite shader). No other drawing reads the flag (the people's shadows are not
  sprites).
- **Anti-aliasing** (lbl_105BA240[0x39], cOptionsMgr::SetAA -> InitSpr2Decoder(1)): off, z-sprites go
  through Spr2DecoderNoAlpha* (alpha pixels drawn opaque, depth written). cOptionsMgr::DoStream sets it
  back on after reading it (Mac 10230250 and Windows 004e6646 alike), so in the game it is only off in
  MakeThumbnail (and through the "alpha off" cheat). Port: `Compositor.spr2NoAlpha`, set by
  `HouseViewer.render` from the option or the thumbnail mode.
- **Windows alpha decoders** (Spr2Decoder565 004bbca9 and its 16-pixel helper 004bc271; the 555 ones
  alike) differ from the Mac ones the port first followed: an alpha byte below 8 skips the pixel, above
  0xf7 draws it opaque, otherwise it is blended through the table row (alpha & 0x1f), and the pixel's
  depth is written in both cases (the Mac decoders blend every alpha pixel and never write its depth).
  The table (0049a42a) is built like the Mac InitAlphaZSpriteBlit. Port: `alphaWeight` and the alpha pass
  writing depth (compositor.ts). This changes how alpha pixels drawn later behind them are hidden
  (window glass, tree foliage).
