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
- Held-object hook (lbl_105BA4A8 vtable +0x4c / +0x48 in DoDynamicCutaway) not ported:
  belongs to the buy-mode placement tool.
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
