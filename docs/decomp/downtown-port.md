# Downtown, Vacation Island, Studio Town, Magic Town (town screens and lot changes)

Files:
- `client/src/game/nbhd/wintown.ts`: cWinDowntown / cWinVacation / cWinStudiotown / cWinMagicland
  (one class, `TOWNS` holds the per-town data)
- `client/src/game/nbhd/winpicturesplashdialog.ts`: cWinPictureSplashDialog,
  cSimsApp::CreateTaxiDialog / RemoveTaxiDialog
- `client/src/game/nbhd/transit.ts`: the TryDialog pickers, generic sim calls 3 and 17
  (cXPerson::TryChangeLots), SetChangeLotTrigger / SwitchLots flags, and the location part of
  cSimsApp::LoadGame
- Additive hooks: `SimModule.transitHooks` (sim/simmodule.ts) and the calls to them in
  `cXObject` prim 36 and `tryGenericSimCall` 3 / 17 (sim/xobject.ts)
- `main.ts`: `showTown`, `switchLots`, and in `enterLot`: `prepareArrival` and
  `applyLoadGameLocation`
- `world/savegame.ts`: SaveGame's visitor condition
- `nbhd/winlotpopup.ts`: the town lot popup text; `nbhd/nghinterface.ts`: `HouseInfo.lotTypeFlags`
- `data/nbhdstore.ts`: `setFamilyVacationLot` (Family +0x13c)

## Screens (cSimsApp::ShowNbhdDialog -> ShowDowntownDialog ...)

The neighborhood screen's end codes are -20 / -30 / -40 / -50. They open the town screen in
main-screen mode (constructor bool, +0x118 = 1). Inside a town screen, -20 (Exit) goes back to
DoNbhdScreen, and a house number loads that lot.

| town | class | houses (MapIndexToHouseNum) | background / water | tooltips STR# |
|---|---|---|---|---|
| Downtown | cWinDowntown | 23 22 21 27 26 25 24 30 29 28 | 0x14c8 / 0x1518..0x151d | 169 |
| Vacation | cWinVacation | 42 41 40 46 45 44 43 48 47 | 0x14c9 / 0x1522..0x1526, port + trees 0x1542/3 | 170 |
| Studio Town | cWinStudiotown | 81..89 | (no water) | 173 |
| Magic Town | cWinMagicland | 90..98 (90-92 residential) | 0x14ca / cMagiclandSprites water 0x1658..0x165d at (0, 0x3e) | 174 |

- The bar buttons are Exit, Internet, Logo (the French logo), Import and Bulldoze. Magic Town adds
  Move In at (200, 0).
- The Logo button opens cWinCredits.
- Evict mode uses UIText STR# 131 / 132.
- Missing houses are copied from `TemplateDowntown` and friends.
- Init plays the station or ambience sounds; Exit plays `bkground_fade`.
- Water:
  - Downtown and Vacation ping-pong over ticks 0..9, stepping when 1000 / elapsed <= 2 pi.
  - Magic Town steps when 1000 / elapsed <= 26 (lbl_1059C508) and shows a new frame every 5
    steps (cMagiclandSprites::DoWater).
  - The frames' key is (255, 1, 255) with speckles. It is keyed at 5:6:5 precision
    (`keyMagenta565`), as the 16-bit cTSBuffer does.
- Picker mode (+0x118 = 0):
  - The bar is kFilterToolbar 0x13b5 (Studio Town uses 0x13b6) with the kDTDlgBkg2 frame.
  - The filters come from STR# 171 and are enabled by the lot type (SIMI global 37, `lotTypeFlags`).
  - The title is a random pick from STR# 212 (213 for Vacation).
  - The filter is saved in localStorage `thesimsweb.townFilter.<town>`. The original keeps it in
    the registry.
- Lot popup: the address comes from `<dir>/Downtown.iff` (or Vacation.iff) STR# 128, or else from
  the rollover entries. The name and description come from Houses/DTDesc / VIDesc / STDesc /
  MTDesc STR# 2000 + house.

## Lot changes (see the header of transit.ts for the whole chain)

1. Prim 36 (cXObject::TryDialog) with operand byte 7 bit 0 clear, kinds 5 / 7 / 0xb / 0xd. The
   ObjectModule field (+0xee / +0xf0 / +0xf2 / +0xf4) is used like this:
   - At 0, the field becomes -1 and the prim returns PRIM_WAIT.
   - Once a house is set, temp 0 = house, the field goes back to 0, and the prim returns TRUE.
2. ObjectModule::PostSim:
   - Plays `bkground_fade` and `kill_all_objectsounds`.
   - Shows the town picker modally over the lot view. The simulator is held: `simulate` is stubbed
     and the timing reset afterwards.
   - A house in range is kept, and cSimsApp::CreateTaxiDialog runs with the taxi picture for that
     kind.
3. Generic call 17 runs cXPerson::TryChangeLots(temp0 house or -1 for home, temp1 hours,
   temp2 minutes, temp3 mode 0 single / 1 family):
   - Saves the persistent data through Neighborhood::SavePersistentData.
   - Computes the arrival clock.
   - Runs Neighborhood::Save.
   - Sets the trigger (`Game.switchLots`).
4. `Game.switchLots` = cSimsApp::SwitchLots:
   - Runs SaveGame.
   - Sets the +0x108 / +0x109 / +0x10a flags (`arrivalFor`).
   - Unloads the lot and runs LoadGame. The taxi splash moves onto the new lot view.
5. `prepareArrival` and `applyLoadGameLocation` = cSimsApp::LoadGame:
   - A member (+0x108 / +0x10a) is the CP family: Family::AddDowntownMember. Their family's
     funds and the arrival clock apply.
   - A family trip (+0x109) makes that family current and sets global 9. On vacation lots it
     also sets Family +0x13c and saves.
   - No flags on a lot nobody lives on (zoning 0 in a town range, or any zoned lot) means a
     visit:
     - global 0x20 = 1 (free funds), funds 0;
     - on vacation lots, and on any zoned lot, the hour is 10:00.
   - Back home on a residential lot: Family +0x13c is cleared and the funds come from the family
     budget.
   - Tail:
     - DisableLiveMode(visit).
     - DisableSave: on community and 93..99 lots it is !visit; otherwise it is on when there is
       no visit, no family and no arrival.
     - HideButtonsForLocation(visit), plus CPState dirty 0x8000000. The funds and friends
       displays hide.
     - A visit: buy mode and pause.
6. Generic call 3 is cSimsApp::RemoveTaxiDialog.

SaveGame (`world/savegame.ts`): with sims on the lot (global 0x20 = 0), these lots are not saved:
a town lot (21..30, 81..89, 93..99), a community lot, or a vacation lot no family lives on. In
that case only the visitors' budget is written. When a lot is visited without sims, it is saved
like any lot.

## Not ported / gaps

- TryDialog kind 8 (cWinNeighborhoodUL as a community lot picker, taxi 3).
- The SimInventory tokens: motives (type 2), the date (token 3) and the arrival clock (7 / 8).
  The clock rides along with the trigger. The mode 0 companion (the date) is not taken.
- Taxi choice:
  - Studio Town's 4 / 5 needs the asking person's star data (ObjectModule +0x110); 4 is used.
  - Magic Town's 6 / 7 needs the picker's +0xdc flag; 6 is used.
- PersonFinder::CreateDowntownSim makes the sim out of the world. Here `WinLotView.bringInFamily`
  places it next to the view center. The lot's own behaviors should bring it in.
- ObjectModule::ResetForVacation, CheckNeighborhoodFileLocked, Nessie and the cheats, Import.
- Magic Town extras:
  - Move In with magic coins (cWinPickFamily), shown as unported.
  - Clouds and balloons (cMagiclandSprites::DoClouds / DoBalloons).
- Studio Town cars.
- The cSimulator +0xe1 flag set by call 17. The lbl_105BA254 window message 3 / 0x10.
- `Neighborhood` (nghinterface) is cached in Game. Family +0x13c changes made through the store
  are not reflected in it until it reloads.

## Testing

- Town screens: on the neighborhood screen, the bar buttons at (538, 108) Downtown, (588, 108)
  Vacation, (638, 108) Studio and (688, 108) Magic. Exit is at (460, 108).
- The transit hooks can be called from the console:
  ```js
  const m = game.lotView.sim.module, p = m.persons[0];
  m.transitHooks.tryDialog(p, 5);         // picker; click a lot (taxi shown)
  m.transitHooks.tryDialog(p, 5);         // -> 1, p.obj.temps[0] = house
  p.obj.temps[1] = 1; m.transitHooks.genericSimCall(p, 17);   // go
  m.transitHooks.genericSimCall(m.persons[0], 3);             // taxi off
  // home: temps[0] = -1, then call 17 again
  ```
