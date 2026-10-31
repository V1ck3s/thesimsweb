# SimAntics VM port (phases 1–5) — handoff

Port of the object simulation from the decompiled Mac build (cSimulator,
TreeSim, TreeStack, StackElem, Behavior, TreeTable, cXObject::Try*,
ObjectModule's sim part) into `client/src/game/sim/`. Logic is paraphrased;
no decompiled code is in the repo.

## Status

- The lot view (`WinLotView`) creates a `Simulator` after the objects load
  and ticks it in `pump()` at the CPState speed (buttons 1/2/3 → 42/14/2 ms
  per tick, max 30 ticks per frame). Mode freeze / pause come from CPState
  (`syncFromState`). Exposed as `game.lotView.sim`. `?nosim` keeps the lot
  static (debug comparison).
- Saved tree stacks are restored from the house file (ObjM per-object
  stream); objects without one get Init. The clock (globals 0/5/6) advances
  2 s per tick and is pushed into CPState (`setTime`), so the control panel
  clock and the lighting follow the sim.
- Headless test: `game.html?test=sim&house=UserData/Houses/House01.iff&ticks=3000`
  (`client/src/game/dev/tests/sim.ts`). House01, 3000 ticks: 529 objects,
  0 load errors, 0 tree errors, ~50 ms.
- People are kept in the module but **not ticked** (their sim flag is
  cleared): cXPerson's Main loop needs routing, animation, the interaction
  queue and person data/motives (cXPerson::ReconStream), not ported.

## File map

| File | Original | Contents |
|---|---|---|
| `sim/behavior.ts` | Behavior, BHAV/BCON/STR#/TTAs loaders | tree lookup private (0x1000) / semi-global (0x2000) / global (0x100), GetTreeID by name, constants |
| `sim/treestack.ts` | TreeStack, StackElem | frames as views over an Int16Array arena (params/locals), restore from save |
| `sim/treesim.ts` | TreeSim | Simulate (catches thrown error shorts), DoNodeAction, RunOneTickTree, RunCheckTree, Gosub, Reset; primitive limit |
| `sim/objfntable.ts` | OBJf / old OBJD entry points | entry point → tree id (action / check) |
| `sim/treetable.ts` | TreeTable, TreeTableEntry (TTAB v≥6) | interactions (not used yet: pie menu) |
| `sim/xobject.ts` | cXObject sim half | InterpValue (all scopes), TryExpression, TryElement dispatch, Try* primitives, Reset/Init, error handling |
| `sim/simmodule.ts` | ObjectModule sim part | sim flags/idle counters, kill queue, type attributes, Global.far resources, unported log |
| `sim/simulator.ts` | cSimulator | SIMI globals, clock, speed/pause, funds, random seed swap, TickAllObjects |
| `sim/names.ts` | TryElement table | primitive names for traces |
| `world/objects.ts` (additive) | cXObject::ReconStream | `savedStack` (tree stack), `relations` (RelMatrix) kept instead of skipped |
| `world/winlotview.ts` (additive) | — | `sim` field, `initSimulator`, ticking in `pump` |

## Primitive status (objects; person primitives throw error 5 on objects like the original)

| Op | Primitive | Status |
|---|---|---|
| 0 | Idle / sleep | ported |
| 1 | Generic sim call | 10/11 (buy/build disable, recorded), 28 (zoning) ported; others logged, true |
| 2 | Expression | ported (ops 0–20, all scopes; see below) |
| 4/5 | Grab / drop | logged, false |
| 7 | Refresh / update | ported (graphics → dirty) |
| 8 | Random | ported |
| 9 | Burn | logged, false |
| 10 | Tutorial | logged, true |
| 11/12 | Distance / direction to | ported |
| 13 | Push interaction | logged, false (needs person queue) |
| 14 | Find best object for function | logged, false |
| 15 | Breakpoint | ported (error 0x3e) |
| 16 | Find location for | logged, false |
| 18 | Kill object | ported (kill queue; view hides it) |
| 19 | Make new character | logged, false |
| 20 | Call functional tree | ported (person-only function 8 logged) |
| 21 | Show string | recorded |
| 23 | Play sound | recorded |
| 24 | Old relationship | logged, false |
| 25 | Budget | ported |
| 26 | Relationship | ported for objects (RelMatrix from the save); person↔person / neighbor: logged, false |
| 28 | Call named tree | ported |
| 31 | Set to next | types 0–4, 6, 8 ported; 5/7/9/10/11/12 logged, false |
| 32 | Test object type | ported |
| 33 | Find 5 worst motives | logged, false |
| 34/35 | UI effect / user event | recorded |
| 36 | Dialog | recorded, answered true (first button) |
| 41 | Set balloon | ported (cXObject::TrySetBalloon, `world/balloons.ts`) |
| 42 | Create object | logged, false (needs placement) |
| 43/46 | Drop onto / snap | logged, false |
| 48 | Kill sounds | recorded |
| 49 | Notify out of idle | ported |
| 50 | Action string | recorded |
| 51 | Inventory | logged, false |

Expression scopes not backed by data yet (logged, read 0): 23 room, 24
neighbor in stack object, 32 neighbor person data, 33 job data, 34
neighborhood data, 38 neighbor definition. Person data / motives of people
are zero placeholders. Type attributes (36/37) are per-session (the
original saves them with the neighborhood).

## Phase 2 — people (handoff)

Live mode plays: the family sims run their Main loop, decay motives, pick
objects autonomously, walk there and use them; the user can click an object
for a pie menu, queue interactions, see them as icons and cancel them.

### Files

- `world/personstream.ts` — cXPerson::ReconStream (SAnimator part, motives,
  person data) read by `ObjectModule.doStream` into `XObject.personRecord`.
- `sim/person.ts` — `PersonSim` (cXPerson): person data / motives, motive
  engine per tick (Motives::Sim every 60 ticks, MotiveInc, tick counter
  pd[27]), person primitives (Animate 44, Idle For Input 17, Set Motive
  Change 29, Find Best Action 3, Gosub Found Action 30, Look Towards 22,
  Goto Relative 27, Goto Routing Slot 45, Change Suit 6 recorded), Reset
  (cXPerson::Reset), interaction queue (AddAction, RemoveAction,
  ShouldInterrupt, SetCurrentAction), TestInteraction, autonomy scoring
  (MotiveEffects), pie menu entries (AppendInteractionsForMenu).
- `sim/personanim.ts` — SAnimator: main / carry / background practices at
  42 ms per tick, time props (xevt events, interruptible, hands, censor,
  discontinuity), skills loaded asynchronously (the primitive waits).
- `sim/routing.ts` — routing slots (SLOT type 3 → RoutingSlot, incl. the
  snap target +0x20), goals, A* over tiles, path following.
- `sim/motives.ts` — Motives::Sim, CalcHappy, PiecewiseFn, constants
  (`setMotiveConstants` from FCNS 1 / 5 / 6).
- `sim/floatconstants.ts` — FCNS loader (Global.iff FCNS 1, 2, 5, 6).
- `world/actionicons.ts` — the selected sim's action icons (cDDDSimsView /
  cActionIcon): current + queued, (0x20 + 0x32 i, 0x20), click = cancel.
  Cancelling the running action (cXPerson::RemoveAction) queues the
  person's interaction 0x21 ("Cancel interaction", priority 50) unless
  ShouldInterrupt, but with its icon object cleared (Interaction +0xc = 0,
  Windows 0x45d764 / Mac 0x10101da0), so it never gets an action icon;
  the cancelled icon keeps its red cross until the action ends.
- `world/lotpeople.ts` — `bindSim` (the sim's animator poses the VitaBoy
  skeleton, facing from `PersonSim.renderDir`), `addPerson` (move-in).
- `world/winlotview.ts` — sim hooks (`module.addObject` / `removeObject`),
  Live click → pie menu (`liveClick`), action icons, Create Object world
  hooks (`createObjectHooks`), `bringInFamily` (move-in).

### Constants (Global.iff FCNS)

FCNS 1 motive constants (energy span 180, wake hours 16, …), FCNS 2
autonomy (min score family / visitors 1e-7, sitting 1e-6, attenuation low
0.1 / moderate 0.3 / high 0.6, visitors 0.01 / 0.02 / 0.03, random
selection count 4). Ad effect enters the curves as `motive + effect * 0.001`
(rodata constant), so scores are tiny and the 1e-7 minimum is meaningful.

### Object-side additions (xobject.ts)

Push Interaction 13, Find 5 Worst Motives 33 (motives 5,6,7,8,9,13,14,15
sorted), Snap 46 (modes 0/3/4 routing slots incl. global SLOT 100, 1 on the
object, 2 in front; no wall / footprint checks), Create New Object Instance
42 (world side in the lot view; an object file not yet open makes the
primitive wait), cXMTObject::Reset (lead resets all parts, each part's Init
runs), `SimModule.addObject(obj, runInit)` / `removeObject` (buy / build
tools, undo of deletions), `prepareAll` (all 24 semi-global files opened at
start so run-time objects find their trees synchronously). XObject
initialize gives persons their five extra object slots (cXPerson::Initialize).

### Move-in

`bringInFamily`: a family member without a person object on the lot gets
one (PersonFinder::CreateInstance): MakeNewOutOfWorldObject → cXPerson::Reset
(persistent data from the neighbor, Init) → FindGoodLocation simplified as a
spiral from the view's centermost tile (level 1). The arrival by car / road
walk is not ported (they appear in place).

### Known gaps (phase 2)

Superseded by the phase 3 section below (carrying, social interactions,
pie menu sub-menus / head and ShouldInterrupt are now ported).

## Phase 3 — carrying, social interactions, pie menu

### Carrying (xobject.ts, winlotview.ts, placement.ts)

- `SimModule.worldHooks` (`WorldHooks`): the lot view gives the VM
  placement (CanPlace / Place / move / pick up / FindGoodLocation / kill) so
  primitives act on the real tile and slot chains. Headless runs keep the
  old "no world" fallbacks.
- Ported: Grab (4), Drop (5), Drop Onto (43), Find Functional Object (14),
  Find Good Location (16, modes 1–5; ring search in
  `Placement.findGoodLocation`), Create Object Instance (42, all modes of
  lbl_10601BC4), Snap (46: slot 0 of the stack object, routing slot snap
  targets, flag 0x800, object data 52 / 54 on failure), generic sim calls
  2 / 14 / 15.
- Held objects (slot 0 = hand, slot 1 = head) are drawn at
  SAnimator::PrepReg's registration point (`LotPeople.registrationPoint`:
  body strings 6/7 or 4/5, "Palm" / "Top" offsets).
- cXPerson::GosubObjectTree / StackJustPopped keep `objectRecords`
  (+0xab0, saved with the house) for Test Sim Interacting With (37).
- Verified on House01: snack (fridge → chips in hand → eat, hunger
  50 → 58) and meal (prepare at the counter, eat, trash via Find Good
  Location).

### Social interactions (person.ts, xobject.ts, simmodule.ts)

- People are pickable in Live mode (`LotPeople.screenRect`, projected bones)
  and are skipped in the drawing tile chains.
- Relationship (26) person↔person goes through the neighbor RelMatrix
  (keyed by person data 0x1f), object↔object through the object one;
  scope 24 (neighbor data 0, 1, 3, 4, 6) and 32 (neighbor person data).
- Set To Next: neighbor (5), neighbor of GUID (7), adjacent object (9),
  same family person (12).
- cXPerson::AddAction fully: TTAB flag 4 ("run immediately", every social
  entry) runs the action tree at once as a one-tick tree (lbl_105BE790
  guard, person data 33 = priority meanwhile, temps restored); lower
  priority queued interactions are dropped with their entry point 4;
  interaction flag 2 goes in front.
- ObjTestSim::TestInteraction: the scratch TreeTableEntry (lbl_105BA320,
  `Simulator.currentAd`, [personality, min, delta] per motive) is always
  valid; autonomy copies the entry in and scores the advertisements the
  check tree changed (scopes 12/28/29); another room makes the room ad's
  delta -min.
- cXObject::TryCallNamedTree: STR# indices are 1-based (StringSetBase::GetString).
- cXPerson::ShouldInterrupt: person data 71, queue head, and the motive
  emergencies (motive 7 / 9 below -99, motive 5 below -99 with person data
  65 <= 1) on a residential lot.
- Objects created by behaviors (Create Object Instance GUIDs) are loaded
  with the lot (`SimModule.createdObjectGUIDs`) so a one-tick tree can
  create them synchronously like the original's full ObjectFolder.
- Verified in the browser on House05 (Goth family): clicking Bella with
  Mortimer selected shows Dance / Hug / Kiss / Talk sub-menus, Wait,
  Cancel, Shoo, Pick up kids; Hug / Kiss run Person A / Person B trees on
  both sims (screenshot: they hug), social motive and relationship rise,
  no tree error. House01: the saved joke of Kyle / the child ends (0x44c
  was the unported person↔person relationship in "Adjust my STR to Person
  B").

### Pie menu (winlotview.ts `doMenu`, cas/portraits.ts)

- cObjPickerTool::DoMenu: "a/b" names go in sub-menu "a" (placed at its
  first entry); picking it pops the sub pie (same setup as the people pie,
  title = the sub-menu name) at the cursor; letting go near its center
  returns to the people pie, elsewhere cancels.
- PopupHead: the selected sim's head (MakePersonHeadImage, crop
  {76, 45, 122, 125}) is drawn at the pie center, as a still.

### Known gaps (phase 3)

- PopupHead is a still image: not animated, not turned toward the
  highlighted item, no zoom from the sim to the pie.
- DoMenu: no 12-item pages (-3), the people pie does not stay up (items
  disabled) under the sub pie.
- AddAction: an interaction queued while a "run immediately" one runs
  does not overwrite it (lbl_105BE790 copy); unique ids not ported.
- ObjTestSim: object data 50 → interaction flag 0x10 (hide) not ported.
- Set To Next types 10 (career) and 11 (neighborhood list) are unported.
- Walk start / stop and turning animations are still not ported; routing
  has no people avoidance, stairs or failure trees.
- Base-game houses (House05, House07) report, at load, error 0x44e in a
  few objects (lamps, paintings, counters: saved stacks naming nodes or
  trees their behavior lacks); not investigated.
- Headless (`?test=sim`, no world hooks): one run had sims hit 0xa in "do idle core"
  node 124 (stale container id: snapping does not place without a world).
- Action icons for person targets show an empty frame.
- Debug: `PersonSim.traceOn` fills `trace` and `autonomyLog` (decisions,
  routes, errors with stacks); the `?test=sim` page prints them.

## Phase 4 — routing, walking, pie menu head, remaining primitives

### Routing (sim/routing.ts, sim/portals.ts, person.ts)

- **RoutingSlot** (0x3c) with all fields (offset, multipliers standing /
  sitting / ground, flags, snap target, proximities, gradient, facing,
  resolution); `routingSlotFrom` = SlotLoader::Load for type 3. The SLOT
  reader now uses SlotDescriptor::SlotDescriptor's defaults (snap -1,
  proximities 16 (<< 4 below v10), gradient 0.1875, facing -2 towards,
  resolution 16): the old ones made "away" the default facing.
- **XRoute** (0x9c): ConstructGoals (TransformToWorldCoords, wedge rings
  per allowed direction, chairs probed in the 8 neighbours with their sit
  tree, OBJD +0x84 and their slot 1 occupant, score = 100 − |dist − opt| ×
  gradient + weight, +25 open side, +20 start point, ±10 random; failure
  codes → result 8/9/10/11/12/13; max 48 goals, 8 in rooms > 250 tiles,
  chairs kept then random picks), EvalTileForGoal, ChooseStartingPoint,
  BuildGoalList, ShouldIgnore, IsPersonSittingOnChairGoal,
  SetDirectionForGoalSearch, GetWallBlockFlagsAtTile, GetObstacleAtLocation,
  CalcShortDistance, ResolveRoomID.
- **FindPath (deviation)**: the original's SpacePartition / Path search is
  replaced by A* on a 4-unit lattice of the person's room (ResolveRoomID),
  SectWall for walls, cXObject::CanPlace for every footprint (tested facing
  the move's direction: person footprints depend on it), people the route
  ignores and goal chairs let through, objects with a route penalty (object
  data 10) cost 10, goals weighted (best − score) × 16; then line-of-sight
  shortening. Results look like the original's paths but are not
  byte-identical.
- **Room ids**: cXObject::SetLocation (Placement.setLocation) now resolves
  object data 29; the ObjectModule room update after ComputeRooms is
  `updateRoomIDs`, run before each plan. The simulator now works on the
  viewer's FixedWorld (it loaded its own copy, whose rooms were never
  computed).
- **Portals** (cXPortal): FindAvailRouteID, InitPortalRoute,
  GetDistToPortal (Dijkstra cached per source portal), FindBestPortal,
  BeginningPortalTree / FailedPortalTree (1001.. used marks, 1101 failed),
  GetOtherSide. Only portal parts with a portal tree are in the list (the
  middle steps of a staircase have none). Doors and stairs (levels) work
  through the objects' own portal trees.
- **cXPerson::TryGotoRoutingSlot**: the 21-state machine (jump table
  lbl_105BBB3C) with the routes stack (+0xaa0): plan, portals, standing up
  from a chair (stand tree 27 with the starting point's direction), the sit
  tree for chair goals, walking, blocked handling (replan while moving,
  AskOthersToMove, replan once, give up), "route waiting animation" /
  "route ask to move animation" trees, failure ("Route failure feedback"
  tree on the target, params result / blocker, when slot flag 0x4000),
  finish (footprint, CanPlace, face the last segment, person data 37 / 39 /
  62, object data 9). Sounds begin_route / end_route are recorded.
  TryGotoRelative builds its slot like the original (locations -2, -1,
  0..7 incl. odd ones, facing -1/-2/0..7, flags bits 1/2).
- **AskOthersToMove / MoveOutOfWay**: helper object 0x7c4 ("Destination -
  For Go Here & Shoo") made at the blocking person, routing slot to the
  sides of the asker's path (16..80, resolution 8, random scores; straight
  ahead when the sides fail), interaction 3 pushed with the asker's
  priority. The helper's slot 0 is overridden at run time (`slotOverrides`).
- **TryLookTowards** 1..3 now turn through the walk engine (path [me, me,
  facing point]) as in the original.

Verified in the browser (`game.html?house=1`, `?house=5`, `?house=7`,
`PersonSim.traceOn` route traces): people plan, walk and arrive; doors are
crossed through their portal trees (House01: door chains 105 → 119 to
reach room 1); House05 sims climb the stairs (portal 203 → room 1025);
blocked walks replan, ask others to move ("route ask to move animation"
runs) or give up with the failure tree; 0 tree errors over 150 s.
Remaining give-ups are mostly a person standing in a doorway (the
portal tree fails, then no other portal).

### Walk engine (personanim.ts: SAnimator::Tick states)

From `Tick__9SAnimatorFb` (Mac 0x1034F090..): Standing (arrival, snap,
StandingAdjust by octant std 11..18, StandingTurn std 4..10 with the
residual turn interpolated), WalkingStart / RunningStart (std 19 / 22,
one start distance ahead), Walking / Running (look-ahead at half a loop,
steering ≤ 0.2 dir units a tick, bigger turns stop for a StandingTurn,
per-tick advance = loop distance × 16/3 / (duration / scale / 42 ms),
TileList::FindNearestPoint, CanPlace each step → follow state blocked;
last segment: the loop fades out, then the final snap and the turn to the
facing point), WalkingStop (swimming only), Sitting (background practice).
BeginFollow / FollowOneStep / EndFollow / ForceLocation / IsInterruptable,
GetWalkingScale (1.4, ×2 run states, smoothed 0.2 a tick),
UpdateBackgroundPractice (std 3 / 1 / 2 by person data 0), GetStdSkill's
tables (Global.iff STR# 150..160: pool, child, male / female, adult).
Practices now have their own clock and rate (SetSpeed). The renderer draws
people at the animator's grid position while it moves them
(`LotPeople.bindSim` pos hook).

Not ported in the walk engine: the walk loop's foot phases and stop
distances (StartVitaBoy reads the "anchor" tags and the feet bones; taken
as phases 0 / 0.5 and a quarter loop), StdAnimOffset of the adjust anims
(the step is interpolated without the anim's own offset), the root-motion
correction (gated off in the original), the OBJD custom walk table.

### Pie menu (sims/popuphead.ts, ui/piemenu.ts, winlotview.ts `doMenu`)

- **PopupHead** (SAnimator::Start/Stop/StartSubmenu/StopSubmenu/
  SetAttitude/Nod/GetLocation/RenderPopupHead): the selected person's HEAD
  skins rendered live, anchored at the people pie's center, scaling in over
  400 ms (lbl_105BA3D0; the anchor drops 14 px). It tilts / turns toward the
  cursor (0.3/60 + sqrt(dist/2000)) and ±0.6 toward the highlighted spoke
  (the spoke from the item count, jump table 0x101111e4), eased with
  sqrt(0.9t + 0.1); ambient 1.0 when an item is highlighted, 0.8 otherwise.
  The original does not zoom from the sim: the head grows in place.
- **Round shadow** (HouseViewer::RenderRoundShadow): radius 0 → 100
  (lbl_105BA3D4) sliding between the pies over 400 ms, grayed pixels.
- **cObjPickerTool::DoMenu**: "a/b" sub menus, 12 entries per page; −3
  (Tab, cWinPeople::TSOnCommand char 9) shows the next page, wrapping. On a
  sub menu the people pie stays up with its items disabled (TSPaint skips
  them: only the head and title remain), the sub pie is titled with the
  label and popped at the item; −1 near its center returns to the people
  pie, elsewhere cancels; Escape → −1. MenuItemSelected (0xf): AddAction,
  Shift keeps the sub pie open and nods; MenuItemChanged (0xe) →
  SetPopupHeadAttitude. cTSPieMenu end mode (+0x170), popped-up / popup
  position getters, SetSubMenu, owner notifications (0x11 characters).
- Deviations: the head renders into an offscreen WebGL target (camera
  rotation 0, zoom 3) blitted at the anchor; cursor warping (SetCursorPos)
  is impossible in browsers; the shadow applies to the whole lot image.
  SetAttitude ignores its score (both builds); the nod length / attitude
  are never-written BSS, so a nod has no visible effect (as in the game).
- Gaps: Space (AdvanceSelectedPerson + −2), the neighbor picture in sub
  pies (MenuItemChanged, Interaction +0x14/+0x16), StartUserAction,
  DoDeniedSound, cancelling the pie when an object is deleted.

### Remaining primitives, tree version changes on load

Base-game houses (House05, House07) were saved with older object trees:
their saved stacks name trees / nodes the Complete Edition objects no longer
have (lamp 4109, painting 280 → 4096…), hence the 0x44e. The original
detects it at load:

- ObjectSaveTypeTable::DoStream (objt, version > 0) keeps, per type, the
  init / main cumulative tree versions (Behavior::GetCumulativeTreeVersion:
  root version << 16 + versions of every tree reached through subroutine
  calls) and sets ObjSelector +0xb4 bit 1 when they differ from the
  installed trees'; a version 0 table flags the person types.
- cXObject::PostLoad: bit set and lbl_105BA214 (1; a cheat stores into it)
  → ObjectModule::CleanupPeople + Cleanup(0) + Init; the standard
  placeholder → CleanupPeople + Cleanup(0).

Port: `SaveTypeTable.treeVersions` → `XObject.savedTreeVersions`,
`Behavior.getCumulativeTreeVersion`, `Simulator.treeVersionChanged`,
`Simulator.resetChangedTrees`, `SimModule.cleanupPeople`. House05 / House07:
0 load and tree errors; House01 (saved by CE): no type changed.

| Op | Primitive | Status |
|---|---|---|
| 24 | Old relationship (TryRelationship) | ported: get/set into a parameter, modes 0–3, flags 1 / 2, neighbor RelMatrix between people; errors 0x15, 0x1c, 8 |
| 31 | Set to next | types 10 career (work.iff CARR in index order) and 11 neighborhood house list (Neighborhood +0x11c) |
| 51 | Manage inventory (TryInventoryAction) | ported: actions 0–6, temps by 2-bit flag fields, GUID 0 = stack object's, flag 0x2000; `sim/inventory.ts`, NGBH inventories (`parseNgbh`); CPState dirty 0x4000000 recorded |

Expression scopes 33 (job data, cCareer::GetBehCareerData, `sim/careers.ts`)
and 34 (neighborhood data, read only) are ported.

Gaps: cXPerson::Cleanup(obj) is not ported (a person whose type changed goes
through cXObject::Cleanup → Reset); Set To Next 11's list is filled from a
vector nothing fills in the Mac build (always false); inventories are not
written back to the NGBH; an error thrown by HandleError → Cleanup → Init is
not caught in TickAllObjects (none in the original either).

## Phase 5 — FindPath, walk anchors, footsteps, pie menu, Cleanup

### Routing (`sim/spacepartition.ts`, `sim/routing.ts`)

- `XRoute::FindPath` is ported with its helpers: `RoutingParams`
  (goals, obstacles, room partition, start, no-goal point, limit / max size
  0x40 / 0x80, default weight 3 outdoors when not running, smoothing),
  `PenaltyRect` {l, t, r, b, w} (`BLOCKED` = 0x7fffffff), `SpacePartition`
  (Init, GetNode, GetIntersectingPartitionRect, ExpandRect,
  BuildSpatialSuccessorList, Count / GetNthSuccessor, MeasureDistance
  `(1 + dist) * ((w1 + w2 + 2) >> 1)`, EstimateDistanceToGoal,
  FindInterfaceRect / Point) and `Path` (InitPath, InitAST with node 0 start,
  node 1 goal, an A / B node pair per goal; FindSmallestOpenNode, OpenANode,
  DoOneSmooth with step `max(1, 100 / (pass + 1)^2)`, Run(budget) with
  budget `min(1000, goals * area + 50)`; big uncluttered rooms — area > 256,
  or density <= 0.2 and area > 99, or a ghost — are searched unlimited, then
  limited to 128).
- `BuildRoomPartition`: the room frame, walls between room tiles (styles 3,
  5, 6, 0xf, 0x17 passable), diagonal wall points, non-room tiles merged,
  inflated by 7; the residential outdoor "path" pass (floors weight 0, the
  off-lot flag 0x20 weight 10).
- Obstacles include the door wall-block strips (weight 10000); obstacles
  overlapping the person's own rect are skipped as in the original.
- The old 4-unit-grid A* is gone.
- Person width (lbl_105BA224) = 6: `placement.ts` ComputeRect now gives a
  person a 6-wide rect (0 for a ghost, pd[84] / pd[68] bit 0; mask minus
  pd[73] on even directions) instead of the OBJD 16. This was the cause of
  sims stuck in doors (error 7). TestIntersection: a person with pd[68] bit 0
  intersects nothing.
- `shouldIgnore` uses `placementContainer` (GetPlacementSpec: walk up while
  slotHierNumber == 0), so objects stacked on a tile (plant on a stand) are
  not taken as contained (fixed error 11 "blocked by plant").
- Results (2–3 min each, House01 / 05 / 07): FindPath ~0.3–0.4 ms average,
  ~6 ms max; no error 7 / 11, no tree errors. Remaining failures are game
  results: r13 (person in the way at an easel / bookshelf), and on House01
  ConstructGoals r8 (a computer goal blocked by a dining chair).

### Walk animation (`sim/personanim.ts`)

- `FindTagTime("anchor", "1" / "2")`: the walk loop's foot phases (t / dur)
  and stop distances `16/3 * (anchored foot z − other foot z)`, measured by
  practicing a clone skeleton at both phases (cached per skill + skeleton).
  Adult: phases 0.79 / 0.289, stops 10.63 / 10.77; child 0.778 / 0.222,
  5.90 / 6.77. They feed anchor1/2 (+0x168 / +0x16c) and stopDistA/B
  (+0x170 / +0x174).
- `StdAnimOffset` (ROOT translation of the last frame) for the standing
  adjust: `tx -= x cos a + y sin a; ty -= x sin a + y cos a` — both builds
  use x and y (y ≈ 3.02, the height): kept as is. Weight 0.5 below 0.1, 1 at
  ≥ 1, `d / |off.xy|` between, at least 0.5.

### Animation sounds (`sim/animsound.ts`)

- `SAnimator::HandleVitaBoyAnimEvent`: "sound" (on the person; out of the
  world pets only, as a UI sound), "selectedsound" / "deselectedsound",
  "footstep" n (1, 2 forward; −1, −2 backward) → `soundPlayer.playBySource`
  with the person's id.
- `GetFootSound`: plants / trash / ashes / roaches / puddles by GUID, pool
  deck, pool, floor 0xff, the floor pattern's sound (FloorGraphicsMgr::
  GetFloorSound through `animSoundEnv.floorSound`, set by the lot view);
  barefoot outfits 1, 2, 5, 6, 14; snow on houses 40..42, soft on 99; no step
  through a portal (pd 84 / 68 bit 0) or with pd[74] bit 3.

### Pie menu and selection (`world/winlotview.ts`, `ui/piemenu.ts`)

- Space in a pie (cWinPeople::TSOnCommand 0x20):
  `ObjectModule::AdvanceSelectedPerson` (next family member present on the
  lot, wrapping; CPState::SetSelectedPerson stands for the hilite bit,
  OnSelectionChange and GlobalDispatch 0xe4), then the popped pie (sub pie
  first) ends with −2; DoMenu returns true and liveClick makes the menu again
  for the new person on the same object (cObjPickerTool::TryClick's loop).
- Outside a pie (cObjPickerTool::OnChar, Live mode): Space advances and
  centers the view on the selected person (CenterHouseViewOnMe; here a jump,
  not smooth), N advances only.
- Dynamic menu items: `ObjTestSim::AppendInteractionsForMenu` /
  `IsMenuInProgress` / `MakeNewMenuItem` through `SimModule.menuInProgress`
  and `PersonSim.menuItemsFor` (returns `MenuItem` {entry, name, args}).
  Primitive 50 (`cXObject::TryMakeActionString`) in menu mode adds an item
  named by the private STR# entry after `ParseUIString` ("$Family",
  "$Neighbor", "$Local:n"; others left as is); its stack vars become the
  interaction's args (`makeInteraction(…, item)`). An entry whose check tree
  made items is not added itself. The phone's plugins now show as
  "Call Cab.../Go Downtown - $50" etc. instead of "Call Plugin". Outside a
  menu, primitive 50 is still recorded only (renaming the current action
  depends on lbl_105BA314, unknown).
- `cObjPickerTool::MenuItemChanged`: in a sub pie, an item with stack var
  1 set shows the neighbor (stack var 0)'s picture untitled
  (PersonFinder::GetPictureBuffer → `cActionIcon::MakeActionBitmap`:
  cell (0, 1) of BuildPersonBtn under kIconFrame's first half, 45 × 45);
  the last picture stays when a neighbor has none; no item brings back the
  backdrop and the title. `TSPieMenu.setBackgroundAndTitle` relays the
  window around the same center. Only the family and the people it knows
  have faces loaded.

### cXPerson::Cleanup (`sim/person.ts`)

- `PersonSim.cleanupFor(obj)` / `cleanup()` (Cleanup(0)): reentrancy guard
  (+0x114 0x800); when `obj` is null, an ObjectRecord or the action object,
  every record's frames are popped (StackJustPopped) and its object cleaned
  up (CleanupPeople + Cleanup(0)); the animations stop, routes cleared,
  sprite slots off, an out-of-lot person placed at the lot center or a good
  location near it, Main reset, entry point 3 run, pd 0 / 40 / 59 and object
  data 9 / 34 cleared, current action emptied. Then the queue (all, or the
  interactions with `obj`) is dropped, each running its object's entry
  point 4; last / current actions with `obj` forgotten; routes asking `obj`
  to move forget it.
- Not kept: the 0x1000 flags of +0x114, the interactions' +0xc object
  (+0xa14), the container branch of PlacementSpec.

### Deviations

- The room partition is cached by an FNV hash of the rooms / walls / floors
  arrays; object density is computed live.
- The person's position is still put in front of the path when the start
  differs from it.
- Anchors are measured on the skeleton at direction 0.

### Playtest fixes (2026-10-28): kill cleanup, autonomy flag, FindGoodLocation, routes

- **Sim flag 8 (CanChooseAutonomously)**: computed for every object, persons included, by
  `XObject.canChooseAutonomously()` (cXObject::FinishReset; set again in PostLoad): a TTAB entry
  with autonomy threshold < 100 and without flag 0x80; a multi-tile part whose OBJD +0x10 group
  is > 0 defers to the part with the negative group. Find Best Interaction only considers
  objects with this flag.
- **ObjectModule::KillObject** (`SimModule.killObject`, used by the kill queue and
  `removeObject`): whole multi-tile group, CleanupPeople(obj) (persons running the object's
  trees pop them, which releases object data 62), obj->Cleanup(0), recursive kill of the slot
  contents, then RemoveObject. Social objects ("Social Talk 1.4"...) rely on data 62 reaching 0.
- **cXObject::FindGoodLocation** (`world/tools/placement.ts`): spiral of the original (direction
  -1) or line search along x (directions 0 / 4) or y (2 / 6), alternating sides; same-room
  test on the room map; limit 0x1000 steps (size * 8 off lot). TryFindGoodLocation: modes 3 / 4
  same room with the reference object's direction (+2 for mode 4), other modes same room
  first, then without.
- **House::EnterLiveMode → ObjectModule::InvalidateAllRoutes** (`portals.invalidateAllRoutes`):
  when the build / buy freeze ends, persons' routes are invalidated and portal routes dirtied.
- **ObjectDialog pictures**: SetParams modes 0 (object or person picture), 2 (neighbor), 3 (BMP
  5000 + n), 4 (strings "gz", "gzi", "my", "guid", "rel", "job").
- **TryDialog kind 8**: community lot picker (cWinNeighborhoodUL picker mode), module +0xf6,
  then the taxi dialog. Kinds 6, 9, 0xc, 0xe, 0xf: see below.

### Balloons, outfit / pet / transform / magic book dialogs (2026-10-28)

- **SpriteSlot** (`world/slots.ts`, 0x3c bytes): z (+8), ticks (+0x10), sprite id (+0x14),
  picture selector (+0x18), frame count / frame / step / sub-tick (+0x1c..+0x28), balloon
  (+0x2c), overlay (+0x30), priority (+0x34), always shown (+0x38). A person gets one slot at
  z = 2.0. SpriteSlot::Tick (`tickSpriteSlot`, from cXObject::Simulate) counts the ticks down
  and steps the frame every 12 ticks.
- **cXObject::TrySetBalloon** (prim 41, `XObject.trySetBalloon`): operands icon group /
  index / balloon type / flags; IconGroup::GetSpriteID (lbl_105BB894: group → base SPR#
  [-, 100, 400, 200, 300, 500, 600, picture, 700, 800, 900], group 0 → lbl_105BB890),
  GetBalloonSpriteID (0 thought 100, 1 scream 101, 2 conversation 102), "not" overlay 103,
  group 7 = the stack object's (or neighbor's) master selector, priority test, duration in
  ticks (0: until cleared), always-shown flag.
- **cXObject::DrawSpriteSlot** (`world/balloons.ts`, `BalloonPainter`): GameData/Sprites.iff
  SPR# frame (3 - scale) + frame * 3; nothing at the far zoom; anchor (h - (8 << s) / 2,
  v - z * (2 << s) + (4 << s)); a person's anchor is SAnimator::PrepReg slot 2 (the head
  "Top"), so the balloon follows the 3D animation; persons draw it when the slot is
  "always" or the person is selected. Pictures: Product::GetSpeechImage (BMP_ catalog id +
  2000 / + 4000) or PersonFinder::GetSpeechIcon (character BMP_ 2005 / 2006), centered at
  (+0x20, -0x24) (near) / (+0x10, -0x12) (medium). Deviations: painted over the frame (no
  DepthTweak: walls never hide it); objects without speech images get their catalog icon on
  the kSpeechMediumBmp / kSpeechLargeBmp template instead of Product::RenderSpeechShot.
- **TryDialog kinds 6 / 0xe** (`tryOutfitDialog`): ObjectModule +0xf8 / +0xfa / +0xfc /
  +0x100; the window posts `index << 16 | 0xfffe` (OK) or `| 0xffff` (Cancel); true on -2
  with temp 0 := the index. **Kind 9** (`tryPetDialog`): +0x104 / +0x108 / +0x10c.
  **Kinds 0xc / 0xf** (`tryMagicBookDialog`): CWinMagicBook(person, kind == 0xf), true when
  closed (the original runs it modally inside the primitive; here the primitive waits).
- **Windows** (`ui/outfitdlg.ts`): cWinClothingChoiceDlg (UIText STR# 0xdc, scale 3.25),
  cWinPetSelectDlg (0xdd, 5.0), cWinTransformMeDlg (0x111, 3.25, cycles the 8 costumes of
  LookupCostume: male / female adult tables, child 0x35 / 0x36 / 0x3c), previous / next
  buttons kClothingDialogPrevious / Next, OK / Cancel, Enter / Escape.
  **cWinVitaBtnSolo** (`cas/winvitabtnsolo.ts`): the person copied in the outfit,
  EditPerson on its body strings, NextSuit / PreviousSuit / GetCurrentSuitIndex by outfit
  (body, swimwear, formal, lingerie, winter, fashion), UpdateTransform (turning people,
  still pets), camera zoom 2. **CWinMagicBook** (`ui/magicbook.ts`): magic.iff strings,
  spell / kid charm / recipe lists (4 per page, Back / Next, page label), title and
  description gated by "Magic - Has Made Spell/Recipe?", mode picture.
  Deviation: spell items show their title instead of the ingredient pictures (costumes and
  preview animations: see "Pets and outfits" below).
- **GenericSimCall 24** (set suit, `trySetSuitCall`): EditPerson on the person's body
  strings, the suit of list temp 0 := temp 1 (temp 1 := the previous one), EditPerson::End;
  the edited strings are kept by GUID (`SimModule.bodyStringEdits`) and the lot view dresses
  the person again (`WorldHooks.bodyStringsChanged` → `LotPeople.redress`).
- **ObjectDialog pictures "rel" and "job"**: "rel" = the first person the selected sim has a
  relationship with (family first, then daily value), its character BMP_ 2003 portrait;
  "job n" = row n of kJobPopupComposite (-1 → 0xb).

### Pets and outfits (2026-10-29)

- **GetStdSkill(cXPerson)** (`PersonSim.stdSkillName`): ObjSelector::GetCustomWalkAnimTable
  first, STR# 150 of the person's own object file (pets' character files carry their
  "d2o-" / "k2o-" stand, turn, walk and run skills there; humans have none), then the swimming
  tables (they override it), then child / gender / adult tables. This was bug U2 (pets used
  a2o-walking-loop). The walk engine's pet branches (turn, adjust, snap, walking scale) were
  already ported.
- **cXPerson::TryChangeSuit** (primitive 6, was a stub): scope 1 sets person data 8 (costume
  trunk outfits >= 8 draw their variant into person data 21: child 0 / 1, adult 0..9, another one
  when the outfit stays; other outfits clear it; flag 1 does nothing); scopes 0 / 2 take STR#
  0x130 entry index + 1 of the global / private file as an accessory to Dress (Undress with flag
  1). Errors 0x2f / 0x30.
- **SAnimator::UpdateOutfitAndHands** (`sims/outfit.ts`, `sims/sanimator.ts`; the switch cases are
  only in the asm, jump table lbl_105BC880, strings at lbl_105BC8AC + 0x73f.. and
  lbl_105BBB7C): head 3, hands 0x12 / 0x13 + 2 * gesture (person data 22 / 23; 3 = "nohandl" /
  "nohandr"), pets forced to outfit 0; 0 day, 1 naked (16), 2 swimwear (0x20 or 17), 3 job
  (GetJobSuitTex: cJob::GetSuit by gender, texture +0x31c, accessory +0x368 on the accessory
  record, child level 0), 4 formal (0x1f, or 0x1c + gloves 0x1d / 0x1e), 5 night wear (0x21 or
  GetPajamasSuitTex), 6 / 7 skeleton, 8..0x10 costume trunk ("ct-<name>-$gAFit-NN"), 0x11 / 0x12
  winter / fashion, 0x13..0x3c Studio Town / Magic Town costumes with EditPerson::SelectEscape*
  (body, head, hand textures; the mummy's variants by person data 21; the donkey's head only).
  Empty body suit → day clothes. Run by the lot renderer each frame (as SAnimator::Render does)
  through `personLooks` (sims/personlook.ts, set by PersonSim): redressed when person data
  8 / 21 / 22 / 23 or the accessories change. "dress" / "undress" animation props and primitive 6
  fill `PersonAnimator.accessories`; Cleanup's ResetSuits clears them and the gestures.
- VBAnimMgr also scans the loose skin folders Sims.exe names (ExpansionShared/Skins, Deluxe/Skins,
  ExpansionPack2..7/Skins): House Party's costume trunk textures are only in ExpansionPack2/Skins.
- **cWinVitaBtnSolo**: the outfit is UpdateOutfitAndHands on the copy's person data (costumes in
  the Transform window); Build{Adult,Child,Cat,Dog}AnimationList (lbl_105BC78C) and AnimatePet:
  the list's skills played once each in turn (a cat starts at 8), people and pets.
- Not ported: UpdateOutfitAndHands' OBJD flag 8 branch (objects with body strings: outfit + 1
  only), SAnimator::Reset → ResetSuits on the next skill (only Cleanup clears), the background
  practice restarted each tick for pets (their stand loop is still). The accessory record is
  undressed when the job accessory is empty (the original's Redress with an empty name is
  probably a no-op).

## Open questions / deviations

- `Reset` keeps containerId/slotNumber instead of recomputing placement.
- `nextMultiTilePart` approximates the part chain (module order).
- RunCheckTree restores the check-tree flag in a `finally` (the original
  restores it on the normal path only).
- At night the lot is very dark: lamps' light depends on their state, which
  the sim now drives; to check against the lighting port.

## Next steps

1. ParseUIString's other tokens ($FamilyAssets, $Object, $NameLocal,
   $TimeLocal, ...) and the non-menu primitive 50 (rename the current action).
2. ConstructGoals r8 on House01 (chair-direction goal blocked by a chair).
3. Arrival by car on move-in; smooth CenterHouseViewOnMe.
4. Tutorial (10), Set To Next 11 on Windows, inventories saved to NGBH.
