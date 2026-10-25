# SimAntics VM port (phase 1) — handoff

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

## Open questions / deviations

- Tree version change on load (+0xb4 bit 1 → reset) is not detected.
- `Reset` keeps containerId/slotNumber instead of recomputing placement.
- `nextMultiTilePart` approximates the part chain (module order).
- RunCheckTree restores the check-tree flag in a `finally` (the original
  restores it on the normal path only).
- Objects created or deleted by the buy tool are not added to / removed
  from the simulator yet (`SimModule` is built once from the loaded set).
- At night the lot is very dark: lamps' light depends on their state, which
  the sim now drives; to check against the lighting port.

## Next steps

1. cXPerson: load person data + motives (ReconStream after the SAnimator
   stream), port the person Main loop primitives (animate, go to relative /
   routing slot, look towards, idle for input, motive change).
2. Routing (cRouter) and animation playback hooked to `LotPeople`.
3. Interactions: TTAB (`treetable.ts`) → pie menu, interaction queue
   (Push interaction, Gosub found action), check trees.
4. Motive decay (person Main / global motive trees), Find 5 worst motives.
5. Create object + placement (shares the buy tool's Placement), sync with the
   buy tool's module edits.
6. Neighborhood (relationships, zoning, neighbor scopes, type attributes save).
