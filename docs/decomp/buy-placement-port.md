# Buy mode object placement port

Port of the buy mode tool (cGameTools tool 7, `cMoveTool`), the tile cursor
(`cXCursorObject`) and the object placement rules (`cXObject` / `cXMTObject`
placement, `PlacementSpec`, `TestAndPlace`) to `client/src/game/world/tools/`.

## Files

| File | Original | Content |
| --- | --- | --- |
| `tools/placement.ts` | cXObject, cXMTObject, PlacementSpec, ObjectIterator | `Placement`: TestAndPlace / TestPlacement / TestContainer / TestIntersection / CheckWallFlags / SectWall, CanPlace / Place / Pickup (single and multi-tile), UserCanPlace / UserPlace / UserPickup / UserCanPickup / UserCanDelete, Turn, AssignOffsets, GetCurrentValue, ShouldAutoRotate, GetFrontFaceDirection, `dayPassedDepreciation` |
| `tools/objectfactory.ts` | ObjectModule::AddObject / MakeNewOutOfWorldObject / KillObject, cXObject::JustBorn | new objects (multi-tile: lead + sub selectors), deletion |
| `tools/cursorobject.ts` | cXCursorObject, HouseViewer::RenderCursorObject, PalWrap monochrome dim | `XCursorObject` (Place, CanPlace, Turn, FaceDirection, DropObject, AttemptFloaterPlacement, KillFloater, MakeMouseObject), `CursorDrawer` |
| `tools/picking.ts` | HouseViewer::PointToObjectID | object under the mouse from recomputed draw rectangles |
| `tools/movetool.ts` | cMoveTool | SetParameter, Select, Deselect, Cancel, OnEnter/ExitWorld, Float, Drag, Click, Release (+ ctrl-delete), GrabObject, DropObject, TurnToWall, ResetGrabPoint, UpdatePlacementFeedback, ShowPlacementTip, OnKeyDown / OnKeyUp, OnChar (incl. `/` `?`), DoDispose, AdjustCutawayForTool |
| `tools/objectundo.ts` | ObjectUndoable, ObjectState, the object handle table (lbl_105BA56C) | create / move / delete undoables of the held object, contained objects as child undoables |

Wiring (`world/winlotview.ts`, `initBuyTool`): CPState's shop item
(`shopGetCatalogItem`, re-armed by `DIRTY_SHOP_ITEM`) -> `setParameter`; mouse
in buy mode -> Float / Drag / Click / Release; keys -> OnKeyDown / OnChar;
mouse enter / exit -> OnEnterWorld / OnExitWorld; tips drawn with a
`DefaultTTWindow` in `postChildDraw`; funds through `cSimulator::Spend`
(expense 6) when the simulator runs; sounds through `soundPlayer.playBySource`.
`HouseViewer.cursor` draws the cursor after the dynamic objects;
`lotobjects.ts` drawables follow the module live (new / moved / deleted
objects).

Simulation hooks (`ObjectBehaviorHooks`, set by the lot view from the VM):
`runInitTree` (a new object joins the SimModule, `SimObject.reset(false)` runs
its Init tree: placement flags, wall placement flags, rotation notches...),
`runCheckTree` (allow-intersection, place / pickup trees; stack object = the
other object id), `onKill`.

## Behaviour (from the decompiled code)

- Catalog pick: SetParameter -> mode 2, new purchase; keep buying when OBJD
  +0xc0 == 1 (chairs...) or shift is held at release.
- Float: point minus grab offset -> PointToTile -> view->world -> tile center
  (`& ~0xf | 8`); invalid: TurnToWall (Turn(i) / Turn(-i), i < 8 / notches),
  then the cursor shows at the unsnapped point with the floater dimmed
  (Monochromize 0.9: gray + 0x30 red). Mouse held > 6 px from the click:
  rotate to the drag quadrant (dx<0: dy<0 -> 6 else 4; else dy<0 -> 0 else 2).
- Keys: `,` `<` turn left, `.` `>` turn right, `/` `?` next slot of the
  container that takes the object, Delete / Backspace sell, Esc cancel,
  Ctrl (doors / windows) ctrl-delete.
- Undo: every held object has an ObjectUndoable (create with the price, or
  move); DropObject submits it, Deselect turns a held one into a delete,
  Esc = Cancel: UndoLastCommand + ReleaseRedoList. Killing through an
  ObjectState only takes the object out of the world; it is killed when
  the last state holding its handle goes (the undo lists are flushed when
  leaving buy / build mode, CPState::SetMode). A sale is undoable (charged
  back at the full value), a ctrl-deleted door too (at the refund).
- Doors / windows with Ctrl: the door (window) under the mouse is hilited;
  release sells it (80 %) as a delete undoable. The cutaway keeps the wall
  of the held door up (AdjustCutawayForTool). FlipPortal and its cursor
  (0x23) are dead code in both builds (+0x7a / +0xac never set).
- AttemptFloaterPlacement: in a multi-tile container the object faces the
  first side (container direction, then quarter turns) whose next tile has
  no obstacle (GetObstacleAtLocation; jump table lbl_105BB938).
- Click on an upper level with nothing under the mouse and no floor: tip
  0x1f. OBJD +0xc0 keep-buying is off on the tutorial lot (simulator +0x44,
  global 26).
- TestAndPlace's container test reads simulator +0x36 (global 19): in buy
  mode an object (no flag 0x2000) only goes in the (0, 0) slot of a
  container with several slots (error 3); people's hands take nothing
  outside live mode (0xd). SetLocation dispatches 0xf3 (old room, new room)
  for an object with a room impact (object data 7): RoomScoreChanged.
- Release: drop when valid and `running + price <= funds`; kaching, tip with
  the total (0x1a), FinalizePurchase; denied sound and tip otherwise
  (0x15 not enough money). Errors: UIText STR# 137, index code - 1.
- Sell: refund = current value (lead, halved if a part is broken);
  build items 80 % (`trunc(0.8 v + 0.5)`); non refundable 0 (explode sound).
- Sound events: UI_object_place, UI_object_move, UI_object_move_place,
  UI_object_rotate, UI_buy_moneyback, UI_moneyback, UI_archtool_delete,
  UI_error (cTool sounds rate-limited to 400 ms).

## Shortcuts / not ported

- Cursor objects are not put in the tile arrays; `cXCursorObject::CanPlace` is
  "every part on the lot".
- Without the simulator (`?nosim`), init-tree data is copied from another
  instance on the lot, else defaults (floor/terrain, quarter turns, movable).
  Multi-tile parts are always seeded that way (Reset runs Init on masterId 0
  only in the VM).
- Hilites (+0x4c, `setHiliteId`): every change clears the old object
  (SetHilite(+0x114 & 0xe)) and sets the new one (SetHilite(+0x114 & 0x1f
  | 1)): Float's hover and held object, Select's new purchase, Release's
  deleted door / window; Float's ctrl-delete door / window gets 0x11.
  cXObject::SetHilite sets the whole chain of a non-dynamic multi-tile
  object (ObjFnTable entry 8). Verified: the hovered dining table (both
  parts) is drawn bright, cleared when the hand leaves it.
  ResetGrabPoint's door / window offsets (lbl_105BA53C..48, Windows
  0x6e5770..7c) are never written: 0.
- PointToObjectID skips people (3D mesh rectangles).
- Purchase tip text: `§<amount>` (the control panel's money formatter is not
  ported).

## Next steps

- Save: new objects only live in the session (ObjectModule save not ported).
