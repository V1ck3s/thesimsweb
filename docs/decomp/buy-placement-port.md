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
| `tools/movetool.ts` | cMoveTool | SetParameter, Select, Deselect, Cancel, OnEnter/ExitWorld, Float, Drag, Click, Release, GrabObject, DropObject, TurnToWall, UpdatePlacementFeedback, ShowPlacementTip, OnKeyDown, OnChar, DoDispose |

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
- Keys: `,` `<` turn left, `.` `>` turn right, Delete / Backspace sell,
  Esc cancel.
- Release: drop when valid and `running + price <= funds`; kaching, tip with
  the total (0x1a), FinalizePurchase; denied sound and tip otherwise
  (0x15 not enough money). Errors: UIText STR# 137, index code - 1.
- Sell: refund = current value (lead, halved if a part is broken);
  build items 80 % (`trunc(0.8 v + 0.5)`); non refundable 0 (explode sound).
- Sound events: UI_object_place, UI_object_move, UI_object_move_place,
  UI_object_rotate, UI_buy_moneyback, UI_moneyback, UI_archtool_delete,
  UI_error (cTool sounds rate-limited to 400 ms).

## Shortcuts / not ported

- No UndoManager: Esc on a picked-up object puts it back where it was
  (UserPlace at the recorded site) instead of UndoLastCommand. Deselect of a
  held existing object deletes it (the original submits a delete undoable).
- Cursor objects are not put in the tile arrays; `cXCursorObject::CanPlace` is
  "every part on the lot".
- Without the simulator (`?nosim`), init-tree data is copied from another
  instance on the lot, else defaults (floor/terrain, quarter turns, movable).
  Multi-tile parts are always seeded that way (Reset runs Init on masterId 0
  only in the VM).
- Not ported: hilites (SetHilite), tool cursors (UpdateCursor), CPState
  StartDisposing (sell value in the panel), build modes 3..9 (doors, windows,
  stairs, plants, fireplaces, columns, pool) and their ctrl-delete, container
  slot cycling with `/` `?`, the multi-tile container side jump table in
  AttemptFloaterPlacement, the "needs a floor" (0x1f) check on upper levels
  in Click, the community-lot keep-buying check (simulator +0x44).
- PointToObjectID skips people (3D mesh rectangles).
- Purchase tip text: `§<amount>` (the control panel's money formatter is not
  ported).

## Next steps

- Build mode tools reuse `MoveTool` modes 3..9 (SetParameter's build lists,
  ResetGrabPoint offsets for doors / windows, FlipPortal). FixFloorForStairs is
  ported (`movetool.ts`, U34).
- Undo (ObjectUndoable / UndoManager) for Esc and the build tools.
- Save: new objects only live in the session (ObjectModule save not ported).
