# SimAntics VM port (phases 1–3) — handoff

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
| 41 | Set balloon | recorded |
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

## Open questions / deviations

- Tree version change on load (+0xb4 bit 1 → reset) is not detected.
- `Reset` keeps containerId/slotNumber instead of recomputing placement.
- `nextMultiTilePart` approximates the part chain (module order).
- RunCheckTree restores the check-tree flag in a `finally` (the original
  restores it on the normal path only).
- At night the lot is very dark: lamps' light depends on their state, which
  the sim now drives; to check against the lighting port.

## Next steps

1. Routing fidelity (cRouter: people avoidance, walk start/stop/turns,
   failure trees, stairs), arrival by car on move-in.
2. PopupHead as a live 3D head (SAnimator::StartPopupHead, attitude / nod,
   turning toward the highlighted item).
3. Remaining Set To Next types (career, neighborhood list), inventory (51),
   old relationship (24), tutorial (10).
4. The 0x44e load errors of base-game houses.
