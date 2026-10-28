# Playtest: one family, one lot, one day (2026-10-28)

End-to-end session driven through real UI clicks (Playwright on Chromium, `game.html`, dev
servers on :5173 / :3000). The goal was a normal play session: boot, neighborhood, Create-a-Sim,
move in, Buy / Build, a day of Live mode (needs, job, carpool, bills, phone, taxi, NPCs), save,
reload.

## What was played

1. Boot → neighborhood → Create-a-Sim: family "Testeur" (Alain, Brigitte, two adults) → move
   into the empty lot 9.
2. Buy mode: fridge, toilet, single beds, shower, dining chairs, counter, table phone, wall
   phone. Build mode: walls (interior x 25..34, y 24..32), a front door (Vegas door), then a
   separate bathroom.
3. Live mode at speeds 1 and 3 for several sim days: eating, sleeping, toilet, shower, pie
   menus, Find a Job through the newspaper, carpool, phone (call a neighbor, call a taxi),
   saving.
4. Options → Save, back to the neighborhood, re-enter lot 9 → objects, funds and clock
   persisted.
5. House01 (`?house=1`) load to check the expansion "Help System" dialogs.

## Bugs found and fixed

| # | Symptom | Cause | Fix (original function) |
|---|---|---|---|
| 1 | Bought objects (bed, shower, toilet, chairs) never used autonomously; their lockout (object data 25) stuck at 350 / 30 / 20 / 50 | Run-time objects were added with sim flags 0xffff: TickAllObjects skipped them, so Main never ran and the lockout never counted down | `SimModule.addObject` sets flag 0x10000 like ObjectModule::MakeNewOutOfWorldObject (`sim/simmodule.ts`) |
| 2 | "Pay Bills", picking up plates, getting food stalled | Primitive 47 (Reach) not ported | cXPerson::TryReach, TryGetReachInfo, FindReachAnimationIndex, GetSlotHeight, cXObject::RunTree "CT - Grab" / "CT - Put" (`sim/person.ts`) |
| 3 | Vegas door, Retro chairs, Lodge counter vanished on every reload | Global 20 (Game Edition) was 0: the expansion objects' Load trees kill themselves when it is 0 | `Simulator.create` sets global 20 (folder packs, House::LoadFile / cSimulator::Init), 33 (Machine Level 2, Globs::Globs) and 32 = 0 (`sim/simulator.ts`, `world/winlotview.ts`, `world/moveout.ts`) |
| 4 | Find a Job did nothing; no game message ever appeared (job offers, "too tired", carpool notices, help system) | Dialog primitive 36: only the town pickers were ported, every other kind was auto-answered "true" without a window | ObjectDialog (SetParams, BtnPressed, ResultProcessed, Abort), ObjectModule::EnqueueObjectDialog / GetCurrentDialog / PostSim, cXObject::TryDialog result states, cWinPictureDialog + cWinTextWrap, cTSObjectDialog (`sim/objectdialog.ts`, `world/objectdialogshow.ts`, `ui/picturedialog.ts`, `ui/textwrap.ts`) |
| 5 | Job offer text would show raw `$JobOffer`, `$Job`, `$TimeLocal:2`... | cXObject::ParseUIString only handled `$Family` / `$Neighbor` | Full token list in ParseOneString order: $FamilyAssets, $Family, $Me, $Object, $Local, $Attrib, $NameAttrib, $NameLocal, $NeighborLocal, $Neighbor, $CatalogLocal, $TimeLocal, $JobOffer, $JobDesc, $Job (`sim/xobject.ts`); cCareer offer texts and cJob names / descriptions from LoadCareers (`sim/careers.ts`); ObjSelector::GetCatalogName / GetCatalogDescription (`world/objselector.ts`) |
| 6 | Pie menus in English ("Find a Job", "Read") | TTAs and action strings read the first language of format -3 sets | StringSetBase::GetString with the default language (French entries when present): `loadUIStringSet` (`sim/behavior.ts`), used by `sim/treetable.ts` and TryMakeActionString |
| 7 | Phone "Call..." did nothing | Dialog kind 0xa (CWinPhoneBook) not ported | TryDialog kind 0xa with ObjectModule +0xec (`phoneBook`), PostSim's phone book part, CWinPhoneBook (`ui/phonebook.ts`) |
| 8 | Several dialogs queued in one tick (House01 help system: Help, Downtown, Magic, Old Town, Studio Town, Vacation) froze the simulation | Each dialog held the simulator separately; nested holds restored the stub `simulate` | Dialogs are shown one after the other (PostSim loop) and `holdSimulator` is reference counted (`nbhd/transit.ts`) |
| 9 | Unported value "scope 24 neighbor data 2" (686 hits, Visit Generator) | Jump table of Neighborhood::GetNeighborData not resolved | Cases 2 (Neighbor +0xe8 = stored age, person data 0x3a), 7 and 8 (family +0x138 bits 0 / 1 when the family has a house) (`sim/simmodule.ts`) |
| 10 | "Social Tease 1.4", "Social Talk 1.4"... objects could pile up | (a) Persons had sim flag 8 (CanChooseAutonomously) forced on / never computed, so Find Best Interaction did not pick other sims and the social objects' life cycle differed; (b) killing an object did not run the original cleanup, so persons still running its trees kept object data 62 (people count) above 0 and SocialGlobals "Main" (0x2002), which kills the object when data 62 reaches 0, never fired | Flag 8 computed per object like cXObject::FinishReset / PostLoad (TTAB entry with autonomy < 100 and not flag 0x80; multi-tile parts defer to the lead part) (`sim/xobject.ts`, `sim/simulator.ts`); ObjectModule::KillObject: CleanupPeople(obj), obj->Cleanup(0), kill of slot contents, whole multi-tile groups (`sim/simmodule.ts`). Social objects verified to die after each interaction (House01 / 05) |
| 11 | Trash piles spread outside the house | cXObject::FindGoodLocation searched in rings and ignored the same-room flag | Faithful spiral (and line searches for directions 0 / 4 / 2 / 6), same-room test on the room map, random start; TryFindGoodLocation: modes 3 / 4 same room + object direction, other modes same room first then any room (`world/tools/placement.ts`, `sim/xobject.ts`). The number of piles is faithful: food disposal without a trash can (Global 343 "Create Trash Pile By Size"), full piles (attribute 0 > 8) refuse more, slobs drop piles |
| 12 | A sim stayed stuck on the outer tile of the front door after building | Entering Live mode did not call ObjectModule::InvalidateAllRoutes: persons kept their cached route and the portal Dijkstra cache predated the new walls / door | `invalidateAllRoutes` (cXPerson::InvalidateRoutes + cXPortal::DirtyAllRoutes) when the build / buy freeze ends (`sim/portals.ts`, `sim/simulator.ts`). Not reproduced afterwards on House05 / 07 |
| 13 | Object dialogs had no picture for persons and string pictures | ObjectDialog::SetParams picture modes 0 (person: PersonFinder::GetPictureBuffer first 45x45 cell), 2 (neighbor), 3 (BMP 5000 + n), 4 ("gz n", "gzi n", "my n", "guid n", "rel", "job n") | `sim/objectdialog.ts`, `world/objectdialogshow.ts` |
| 14 | "Ask for Lot" (NeighborhoodPhonePlugin) answered true without a picker | Dialog kind 8 | cWinNeighborhoodUL in picker mode (Visit mode, community lot → EndDialog(house), zoning 2 → CreateTaxiDialog(3)); module +0xf6 (`nbhd/transit.ts`, `nbhd/winneighborhoodul.ts`). Escape cancels (0) |
| 15 | No speech / thought balloon, relationship or topic icon over the sims | cXObject::TrySetBalloon (prim 41) only recorded; SpriteSlot not modelled | SpriteSlot fields and Tick (`world/slots.ts`), TrySetBalloon with IconGroup tables, cXObject::DrawSpriteSlot at the head registration (SAnimator::PrepReg slot 2) from GameData/Sprites.iff, speech pictures (`world/balloons.ts`, `sim/xobject.ts`) |
| 16 | Dressers "Change de vêtements", clothing racks, pet pen "Buy a Pet", Charms "Transform", SpellBook / Cookbook "Read" answered true without a window | TryDialog kinds 6, 9, 0xe, 0xc / 0xf and GenericSimCall 24 not ported | cWinClothingChoiceDlg / cWinPetSelectDlg / cWinTransformMeDlg + cWinVitaBtnSolo (`ui/outfitdlg.ts`, `cas/winvitabtnsolo.ts`), CWinMagicBook (`ui/magicbook.ts`), module +0xf8..+0x10c protocol, GenericSimCall 24 set suit with the lot person dressed again (`sim/xobject.ts`, `world/lotpeople.ts`) |
| 17 | Taxi never came after "Appeler taxi..." (lot 9); no Go Downtown / Vacation / Studio / Neighborhood phone entries; no NPC controller of the expansions on lots older than them | ObjectModule::UpdateSimObjects not ported: the template houses only carry the base game's controllers | `world/simobjects.ts`: every OBJD of type 7 / 0xc with OBJD +0x54 set gets exactly one instance (made out of the world, Init, then its Load tree as PostLoad does; duplicates killed). The folder index lists them (`ObjectFolder.simObjectGUIDs`, index version 2). Called before the family comes in (`world/winlotview.ts`) |
| 18 | Downtown: 186+ janitors and guests spawned, the taxi splash stayed up, the arriving sim stood in the middle of the lot | Global 3 (selected person) never set; generic sim calls 18 / 19 / 20 / 21 / 23 (lot change, arrival side) not ported; arrivals were placed by the view | cSimulator::DoCommand 0xe4 (`globals[3]`, `sim/simulator.ts`); `sim/lotcalls.ts` (18: first family member's instance, 19 / 20: companion tokens and PersonFinder::CreateDowntownSim, 21: motives / person data back from the type-2 tokens, 23: arrival clock tokens); an arriving family is made out of the world (`WinLotView.arrivalOutOfWorld`) and the ped marker brings it in |
| 19 | NPCs and visitors created at run time (paper carrier, welcome wagon, raccoon, mail carrier) froze at the portal | (a) no skeleton (only loaded persons got one); (b) the walk started before the asynchronous skeleton: SAnimator kept curAnim = walk loop with no practice; also `stop("main")` (Reset) kept curAnim | `Simulator.attachSkeleton` through `SimModule.onPersonMade`; `SAnimator.setCurAnim` fails (retries next tick) without a practice, `stop("main")` clears curAnim (`sim/personanim.ts`); new persons are drawn when they enter the world (`WinLotView.drawPerson`, body from the selector's STR# instead of a character file) |
| 20 | Visitors behaved as residents (autonomy on the controllers' "Jouer" / "Ecraser !", never "begin visiting") | Person type (person data 0x20) of the new persons stayed 0 | Neighborhood::UpdateInstanceVisitorTypes, run by MakeNewOutOfWorldObject's GlobalDispatch(0xe2) (`SimModule.updateInstanceVisitorTypes`); Create Object flag 4 (neighbor in the stack object: Neighborhood::GetNeighborSelector) and its "init visitor" tree (`sim/xobject.ts`) |
| 21 | Neighbor data 1 (TestMember) false for 3 of 4 family members | GUIDs above 0x7fffffff compared unsigned against signed | Both sides `\| 0` (`sim/simmodule.ts`) |
| 22 | Unported "scope 24 neighbor data 5 / 9" | Neighborhood::GetFriendCount / Family::GetFriendCount | Characters of a family with a daily relationship >= 25 both ways (`SimModule.neighborData`) |

Checked after the fixes (screenshots in the local scratch folder):
- Newspaper → "Chercher un emploi" → "l'Echo de SimCity" dialog with the expanded offer
  ("Voici le seul poste proposé dans le journal : laborantin ... Horaires : de 9:00 à 15:00
  Salaire : $200 par jour"), Oui / Non, then "Très bien ! Le transport arrivera à 8:00." Job
  person data (0x38 career, 0x39 level) set.
- With low mood, "Je n'ai vraiment pas envie de chercher du travail aujourd'hui..." (OK).
- Carpool: "Le transport pour Alain arrive dans environ une heure.", the car comes at 8:00,
  Alain walks to it with "Au travail" as his action.
- House01: the Help System yes/no dialog with its picture, then the five expansion messages one
  at a time; Enter closes each; the clock runs again after the last one.
- Phone → "Appeler voisin" → phone book "Alain ne connaît personne." (new family: faithful),
  Cancel answers false.
- Save → neighborhood → lot 9 again: funds, new wall phone, clock and day restored.
- Fixes 10 to 14, 4 sim hours each (probe running ticks directly, dialogs dismissed with
  Enter): House01 (to 21:10), House05, House07: no social or trash object accumulates ("Social
  Interactions" / "Social - Child" counts go back down), no tree error except "Visit
  Generator" code 1101 (tree 4100, NPC side); remaining unported values: `scope 23 room[temp0]`,
  `prim 20 functional tree 8 (person)`, `dialog picture "job"` (since ported), `scope 24 neighbor data 9`.
- Fix 15: House01, conversation balloon (102) with the Aliens topic (428) over a child's head at
  the near zoom, "+" relationship icon (616); House05 at the medium zoom, food topic (439) over
  Bernard. The balloons follow the head during the animations.
- Fixes 17 to 22, fresh lot 9 (`?nbhd=UserData5&house=9`, family Jeff / Diane / Daniel /
  Jennifer, fridge + table phone bought, dialogs auto-closed with Enter, speed 3, about 7 sim
  days): the expansion controllers and phone plugins exist after load; the newspaper carrier
  comes at 9:05, drops the paper and leaves by the other portal; the welcome wagon (Bella and
  Mortimer, person type 1) arrives at 9:20, visits and leaves around 10:35; raccoon, skunk,
  traveling salesman come and go; school bus each morning, children back in the afternoon;
  military jeep carpool at 6:00, back at 13:00 with "vous avez gagné $325" and the funds up.
- Fix 16 (House01): Jada → Dresser "Change de vêtements" (needs person data 8 = 0, i.e. in day
  clothes): "Veuillez choisir une tenue" window with Jada turning in 3D, next / previous suits,
  OK → GenericSimCall 24 writes the suit and Jada is redressed on the lot. SpellBook "Regarder
  sorts" only reaches kind 0xc when the sim carries the spell book's inventory tokens (nodes 5 /
  29), so CWinMagicBook was opened through the hook: "Grimoire familial Fez" (child: kid
  charms, 3 pages; adult: 21 spells, 6 pages, "Sort mystère" while not made), "Livre de cuisine
  Fez" (nectars, pictures). Transform and pet windows opened through the hook (no charm / pet on
  the test lots).

## Remaining problems

| Problem | Suspected cause |
|---|---|
| Mail carrier never seen; bills stay in the mailbox (out of the world) and are not fetched / paid autonomously | Fresh lot 9 with cheats on the motives, 7 sim days: MailBox "process" makes the Bills every few days (mailbox attr 1 counts them; one with amount 0 is killed at once, as in the original) and "create mail man" calls Schedule for the neighbor GUID 0xb2ebbf92, but no mail carrier was ever added. Not investigated further (Scheduler / PedPortal path for that neighbor) |
| Taxi round trip after fixes 18 to 20 not replayed | Before them: phone "Appeler taxi... / Aller en ville - $ 50", cab came, Jeff got in, town picker, lot 26 loaded. Arrival through the ped marker and the trip home are untested since |
| Visit Generator error 1101 (tree 4100 "is neighbor known?" node 4, nbrInStack[6]) | Not investigated |
| A fresh empty lot (fridge only) starves its family: Have A Meal stops at "grab food" without a counter, then social worker and Grim Reaper | Probably faithful (no counter), not compared with the original |
| CPState day stays 0 (the status scripts); the sim's days (globals 1 / 28) advance | `Simulator.syncFromState` only writes the time of day |
| Unported: generic sim call 12 (distance to the camera, car sounds), 26, 43; prim 35 user event; prim 10 tutorial; scope 23 room[temp0] | - |
| Catalog "?" for some doors / chairs | Missing catalog icons (BMP_ lookup), not investigated |
| Wall price $75 per segment looks high | Not checked against the original |
| Transform window shows the sim in its own clothes; outfits >= 0x13 (job, Magic Town, Studio Town costumes) are worn as the body suit | SAnimator::UpdateOutfitAndHands' costume branches (cXPerson / string tables) not ported (`cas/winvitabtnsolo.ts`) |
| Pet window not seen with a real pet; outfit previews stand idle | No pet on the test lots; BuildAdultAnimationList / AnimatePet replaced by the idle |
| Spell book items show their title instead of the ingredient pictures | cPickSpellItem's catalog icons not ported (`ui/magicbook.ts`) |
| Balloons are painted over the frame | The original draws them in the world with RenderParam::DepthTweak (a wall in front could hide one) |
| Not ported tokens: $TokenNameLocal, $FameTitleLocal, $Grade | Need SimInventory tokens' selectors, cFameTrack, cJob::GetGrade |
| Speed 3 is about 90 s per sim day | To compare with the original |

## Dev notes

- The dialogs queued during a tick are shown after it (microtask); the simulator is held from
  the first `show` until the queue is empty. Kind 0xa waits (instead of answering false) while
  the phone book is still up, because the web dialog is asynchronous.
- Automated tests that load a lot with "Help System" objects (House01) must dismiss the
  dialogs (Enter), otherwise the simulation stays paused, as in the original.
