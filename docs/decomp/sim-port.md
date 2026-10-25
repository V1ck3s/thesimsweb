# SimAntics VM port (phases 1–2) — handoff

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

- Carrying (hand slot, Drop Onto 43): a snack is created out of the world
  and the sim does not visibly eat it; hunger does not rise from snacks.
- Routing: no people avoidance, stairs, room permissions, failure trees;
  turning is instant; no walk start / stop animations.
- ShouldInterrupt ignores motive emergencies; cancelling the running action
  queues the person's interaction 0x21 like the original.
- Social interactions (people are not pickable; relationship primitive
  person↔person, Test Sim Interacting With 37, set to next neighbor types)
  are unported. Kyle in House01 waits forever in a saved joke state.
- Error 0x44c in "Interaction - Flirt Suggestion" (saved state of the child).
- Pie menu: no head in the center, no sub-menus ("a/b" strings shown raw).
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

1. Carry / hand slots (Snap into person slots, Drop Onto, accessories) so
   food interactions complete; then sims eat.
2. People picking (3D bounds) → social pie menus; relationship person↔person,
   neighbor scopes, Test Sim Interacting With.
3. Routing fidelity (cRouter: people avoidance, walk start/stop/turns,
   failure trees, stairs), FindGoodLocation port, arrival by car on move-in.
4. Pie menu head (PopupHead) and sub-menus.
