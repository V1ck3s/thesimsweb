# Dynamic cutaway port (notes / handoff)

Sources: `HouseViewer.c` (DoDynamicCutaway 101c6520, ResetDynamicCutaway 101c63b0,
MouseTrack 101c7480, SetLevel/SetRotation/SetScale, UpdateWorld, PrepareWorldForUpdate,
DoCommand 0xf0), `cCutawaySet.c`, `RoomManager.c`, `Room.c` (IsOutside, ComputeCutawayMatrix,
AbsorbNewRoomList, Clear), `cFixedWorld.c` ComputeRooms 10156090 (asm `world.s` for the
diagonal half-tile enables).

## Data

- HouseViewer +0x48 cutaway (walls down), +0x49 dynamic cutaway, +0x1f8 "rooms valid"
  (last DoDynamicCutaway rebuilt the mask from the set), +0x1fc cCutawaySet (MRU vector of
  room ids, capacity 3: insert at front, pop_back when full), +0x204 BitMatrix64 mask
  (row = view y, bit = view x).
- Room (0x284 bytes): +0 id (u16, level in bits 10..11), +4 vector<CTilePt> tiles (world
  coords), +0x34 in use, +0x71/+0x72 outside cached, +0x7c BitMatrix64 cutaway matrix.
- RoomManager: +4 map<u16, Room*>, +0x14 map<CTilePt, (DiagonalNode, DiagonalNode)>
  (room1 +0x10, side1 +0x14, room2 +0x18, side2 +0x1c).
- cFixedWorld room arrays (+0x2c per level) are NOT saved in the house file: they are
  computed by cFixedWorld::ComputeRooms at load. Special values: 0xffff unvisited,
  0xfffe / 0xfffd one half of a diagonal tile claimed, 0xfffc queued, 0xfffb degenerate
  diagonal tile (two rooms, see the diagonal map).
- Flags array bit 0x04 = outside (flood from (0,0) not crossing non-fence walls), 0x02
  visited; 0x40 / 0x80 diagonal kind.

## Port

- `client/src/game/world/rooms.ts`: computeRooms (cFixedWorld::ComputeRooms parts 1 and 2;
  part 3, the flat-terrain bit 0, is not ported and the loaded bit is kept), RoomManager,
  Room (isOutside, computeCutawayMatrix).
- `client/src/game/world/cutaway.ts`: DynamicCutaway = HouseViewer's dynamic cutaway state
  and methods (doDynamicCutaway, resetDynamicCutaway, mouseTrack's cutaway part,
  setCutaway / setDynamicCutaway / setWallState as CPState::SetWallState calls them,
  level / rotation / scale hooks, UpdateWorld's per-frame call for an outside sim).
- WallManager.cutawayMask is the +0x204 mask; maskVersion is bumped on change.

## Gaps

- PointToTile(Point, true) is approximated by pointToWholeTile.
- Tool hook (lbl_105BA4A8 vtable +0x4c ModifyCursorPos / +0x48 AdjustCutawayForTool):
  ported (`CutawayHooks.tool`, `adjustCutawayForTool` = cTool's, cMoveTool's in movetool.ts,
  cNewWallpaperTool::ModifyCursorPos in wallpapertool.ts: the cursor point moves down
  100 >> (3 - scale) pixels before the tile 4 tiles back is cut).
- ScrollingStrategy::IsWaitingForClick assumed false.
- Room tile lists contain duplicates (tiles re-pushed while queued), exactly like the
  original flood; harmless for the cutaway.
- Doors / windows standing in cut walls are still drawn full height: the object side
  (which sprite a wall-mounted object uses when its wall is cut) is not ported.
- Room lighting (task 2: LightMapSet / Room::ComputeRoom / GetRoomAmbientLight,
  SetAmbientLightLevel for people) not started; lotpeople still uses PEOPLE_AMBIENT.

## Status (verified in the browser)

House01 (`?test=lot&house=UserData/Houses/House01.iff&center=34,27`): 8 rooms found;
cursor room + room below it cut, MRU of 3 rooms, outside cursor cuts a 4x4 block of the
back wall, rotations 0..3 x zooms 1..3 OK, Up/Down/Roof/Cutaway cycle OK.
`?house=1`: the selected sim's room is cut on entry (the Fez family is visible).
House02 level 2 OK (incl. diagonal walls).

## Follow-up 1: wall objects in cut walls

HouseViewer::RenderStaticRow (not DrawIso): a static object with object-data flag 0x400
(+0x5a) on a tile in the cutaway mask (or any tile with walls down) gets +0x8e = 1 for the
draw (no draw group) when, with the dynamic cutaway, the tile across its required segment
(cXObject::GetRequiredSegment: wall placement 1 -> seg 2, 4 -> seg 8, turned by dir/2, then
by the view rotation) is in the mask too, and it stands on the current level. Skipped while
the roof is drawn or CPState::ShouldAlwaysShowWallStuff (build mode + wall/door tool). The
cut wall draws the opening itself. Ported in objectdraw.ts (ObjectModuleDrawer.cutawayView,
WallManager passes as the view) + lotobjects.ts (flags, requiredSegment).

## Follow-up 2: room lighting (lighting.ts)

- Room::ComputeRoom lighting: outside = k(time of day) (global 4: 0 day 1.0, 1/3 0.5, 2 night 0)
  x LightingParameters+0xc (1.0); inside = min(k, win/100/(area/2)*k*30) + lamps/100/(area/2)*30,
  clamped (<0.01 -> 0, >0.99 -> 1). area +0x38 (2 per square tile, 1 per diagonal), window light
  +0x44 = lighting contribution (OD 51, +0xb0) of portals, lamp light +0x48 = other objects, both
  for objects with OD 40 (+0x9a) & 0x400, OD 29 >= 0, not hidden, over ObjectIterator (tile
  object + hierarchy children: next on tile and contained). Pool rooms 0.8.
- Tile byte maps (RoomManager +0x50): (int)(0.5 + 255 * ambient), 0xcc for pools.
- RoomManager::GetRoomAmbientLight ported incl. degenerate diagonal tiles.
- RenderParam::SetAmbientLightLevel clamps to [0.5 (lbl_105BA6A8), max] with max = 1.0 by day,
  0.8 otherwise (RoomManager::AllRoomsLightingChanged). This is why night is not black.
- Sprites: PalWrap::ChooseBestCLUT -> PrecomputeDarkMap: per 5-bit channel
  b + c * (max(b, L) - b) / 31, L = ((255 * a + 0.5) & 0xf8) / 8, b = night color (0,0,10)>>3;
  plain palette when a == 1. In the compositor shader (uAmbientL), set through
  Compositor.ambient by HouseViewer (floors / tile objects per tile), WallManager (per segment
  and vertex: approximated by the segment's tile, the original uses the wall's side rooms),
  dynamic objects per object. Lamps (contribution != 0, not portal) draw at full light
  (SetMaxAmbient).
- People: lotpeople uses viewer.ambientAt (Render3DObject).
- Terrain: setLatitudeByTimeOfDay on time-of-day change (cSimulator::SetCurrentHour 0xdd).
- Room score (2026-11-05, `lighting.ts`): Room::CollectTileStats (pool tiles +0x54, floored
  area +0x3c, walls +0x60 = segments whose style is 1, 3, 5..9, 0xf, 0x16, 0x17, wallpapered
  +0x64; diagonal tiles through lbl_105BBC14 {0x10: sides 2, 4; 0x20: 1, 3}, the half floors in
  TileWalls +0x08 / +0x14), CollectObjectStats (count +0x40, beds / bathroom objects, people
  +0x280 = OBJD type 2, lamps +0x27c = lights that are not portals, dirt +0x4c, room impact
  +0x50, good objects +0x54) and ComputeRoom's score +0x68 with the RoomScoreConstants (FCNS 3
  of Global.iff, defaults lbl_105BBC24; RoomScoreConstants::UpdateConstants once):
  inside wall% x 40 - 40 + floor% x 40 - 40 + impact x 10 / clamp(area, 10, 45)
  + min(area, 60) / 60 x 60 - 30 + ambient x 40 - 20, clamped to -100..100; outside
  impact x 2 + good x 1. RoomManager +0x4c = sum of the outside rooms' scores, +0x48 = +0x4c / 3
  + 0 (day) / -20 (dawn, dusk) / -50 (night), clamped; global 0x1b = the inside rooms' area.
- Overhead lights (Room +0x73): Room::SetOverheadLights from cXPerson::UpdateCurrentRoom (the
  new room on, the old one off once Room::GetPeopleCount is 0; person data 0x41 <= 1). Room::
  GetAmbientLight and ComputeRoom's tile map give 0.8 / 0xcc to an inside room with the flag,
  no lamp, people and an ambient below 0.8; SetOverheadLights dispatches 0xf1 (the room is
  computed again) and writes the tile bytes at once.
- Not ported: LightMapSet / LightLayer / Lit*Blit (lamp and window light pools on floors and
  walls). Lighting is recomputed only on
  time-of-day changes: RoomManager::RoomLightingChanged / ComputeRooms when objects change their
  lighting contribution (lamps switched by the VM) should call RoomLighting.compute again.
