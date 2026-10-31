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
6. House01 → taxi → lot 25 (downtown) → pay phone "Rentrer" → House01, out through the shop
   door; ~30 sim hours downtown, ~5 sim hours each on House01, House05, House07 without stuck sims.

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
| 23 | Mail carrier and repo man never came; "Visit Generator" code 21 (tree 4106 node 5) | Global 9 (current family) and 10 (house number) were never set: the Scheduler's final check kills every visit unless a person with person data 61 = global 9 is on the lot | `applyLoadGameLocation` sets them like Neighborhood::LoadHouse (`nbhd/transit.ts`); the neighborhood is reloaded on each lot entry so a family that just moved in is seen (`main.ts`) |
| 24 | Persons stuck with error 62 (tree 0x208a node 29) after an object they held was killed | KillObject did not sever the hierarchy nor clear relationships | ObjectModule::KillOutOfWorldObject's HierSever on every holder and RelMatrix::RemoveArray; the tutorial object is cleared (`SimModule.killObject`) |
| 25 | "Visit Generator" error 1101 (tree 4100 node 4) | Too many primitives: the limit (lbl_105BA2EC) used the people on the lot | objects x 15 + 10000 + Neighborhood::GetNumCharacters^2 x 15, characters = neighbors from the Characters folder (selector source & 3 = 1) (`SimModule.updatePrimitiveLimit`, `ObjectFolder.sourceOfGUID`) |
| 26 | CPState day stayed 0 | Only the time of day was pushed | `Simulator.pushClock` (UpdateCPStateFromWorld) also writes the day (global 28) and is called by setCurrentHour and at lot start. The original control panel shows no date; the field only feeds the status scripts |
| 27 | Unported generic sim calls 12, 26, 43; prims 10, 35; scope 23 | - | 12: -(x + y) of the stack object's tile through CTilePt::BuildRotationLookup; 26: ObjectModule first person in the house (temp 0 / 1); 43: Family::LoadSpellsForFamily (FAMI v9 spells parsed); prim 10 cXObject::TryTutorial (ObjectModule::SetTutorialObject); prim 35 cXObject::TryUserEvent (3 states, LivePIP option, residential gate, speed 1, caption from STR# 0x131), without a window it centers the view when auto-centering is on; scope 23 Room::GetAmbientLight / IsOutside / GetLevel / GetArea (`sim/xobject.ts`, `sim/simmodule.ts`, `world/lighting.ts`, `world/winlotview.ts`) |
| 28 | Downtown (lot 25), "Appeler taxi / Rentrer": "goto door and face thru" fails, route failure feedback loops; Jeff, the Prude and the Janitor stuck for days in the shop door, routes fail with result 3 / 13 / 8 / 11 | SAnimator::FollowOneStep did not project the arrival point on the path: with the stale step direction and no clamp the sims drifted into the 7-unit inflated partition margins of the door tiles (e.g. 474,474), from where every route fails (3), and blocked the others (13) | `findNearestPoint` (TileList::FindNearestPoint: idx < 0 all segments, 0 the first, > 0 only segment idx - 1; +0.5 rounding, t clamped to [0, 1]) used by FollowOneStep (idx -1) and the step (`sim/personanim.ts`) |
| 29 | Route result 8 with the target itself as the blocker (pay phone, fish display case) | A stale route footprint (pd72 = 8, left by an interrupted "route in front of Person B", GenericSimCall 15) extended the sim's rect 8 units forward into the target | cXPerson::SetCurrentAction resets pd73 (rect recomputed), pd72, pd71, and pd38 / pd39 when the action has a target (`sim/person.ts`) |
| 30 | Blocked-route handling differed from the original | States 6 / 14 replanned / gave up early; MoveOutOfWay re-asked a sim already moving out of the way; finishRoute did not release the sims that asked | XRoute::TryGotoRoutingSlot states 6 (stage 0 wait, 1 AskOthersToMove → 14, 2 retry, 3 fail) and 14 ("route ask to move animation" then "route waiting animation" for 100 ticks); MoveOutOfWay false when already moving out of the way, records +0x80 / +0x90; finishRoute footprint (pd72 → pd73, CanPlace fail → result 1) and release of askers (+0x84 success) then RemoveAction (`sim/person.ts`, `sim/routing.ts`) |
| 31 | Catalog "?" for 27 products (Magic Town doors "Porte Bohémia Licornia", "Porte entrée-sortie", "Porte patibulaire", the AOL wicker dining chair and loveseat, sculptures, minigolf, buffet...) | Their object files carry no 74x37 BMP_ catalog picture: the original renders one | Product::GenerateGraphics' render path: RenderCatalogShot (two shots on the colors at the center of kCatalogTemplate frames 0 / 1, size template height - 8, cXObject::DrawIconic in a 200x200 buffer, SquareOffAndShrink, ScaleBitmap), kept in memory instead of written back into the file (`cpanel/buy/objecticon.ts`, `productbutton.ts`, buy and build catalogs) |
| 32 | Spell book / cookbook rows showed no ingredient pictures; kid charm and spell ids all 0 ("Sort mystère" everywhere) | cPickSpellItem not ported; the id lists (STR# 0xf / 0x10) were read from magic.iff | LoadMagicStrings reads STR# 3 / 4 / 5 / 7 / 0xf / 0x10 of the Magic Controller (GUID 0xb6c90029, MagicMasterSpells.iff); cPickSpellItem::Init / SetSpellID: three 45-wide ingredient buttons per row (x 0 / 0x44 / 0x88), Product::ComposeBtnImage of the ingredient's product or kCatalogTemplate1Frame, catalog name tooltip (`ui/magicbook.ts`) |
| 33 | Prim 35 with the window flag reported as unported | cWinPictureInPicture not ported | `world/winpictureinpicture.ts`: Open / Close / Fade / BuildImage / GetCenterOnPt, sizes 100 / 200 / 300 (lbl_105BC500), bottom right above the control panel, close box, timer, click scrolls the view to the event; HouseViewer::DrawPictureInPicture renders the lot with the window's scale and the object's level around the object, live each paint with the Live PIP option; caption (font table 12) at the bottom. Not ported: the scrapbook auto snapshot, BoboVision's animated show |
| 34 | Balloons painted over the frame (never hidden by walls) | Drawn on the 2D canvas after the render | Drawn into the world after the people (`HouseViewer.spriteSlots`), luminous, at the head registration depth + RenderParam::DepthTweak(-65) (lbl_105BA388, cXPerson::DrawIso), every pixel at z 0 (`world/balloons.ts`). Checked: a wall in front of the talking sims hides the lower part of the balloon |
| 35 | $TokenNameLocal, $FameTitleLocal, $Grade left as text | Not ported | ParseUIString order kept: $TokenNameLocal:n (this person's SimInventory token at local n, its catalog name; error 0x1c for a non-person), $FameTitleLocal:n (cFameTrack::GetTitleFromLevel, fame.iff STR# 1 entries 1..11, "" without a fame track), $Grade:n (cJob::GetGrade(n) of work.iff STR# 0x1001: the asm passes the number itself, not the local) (`sim/xobject.ts`, `sim/fametrack.ts`, `sim/careers.ts`) |

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
- Fixes 23 to 27: lot 9 with a few bought objects: mail carrier delivers, "Récupérer le courrier"
  drops the bill, "Payer les factures" pays it; left unpaid, the repo man comes, shows his dialog
  and takes a floor lamp. A copy of UserData House01 (Fez), 4.7 sim hours of direct ticks: no
  tree error (1101 gone), the only unported entry is the PIP window of prim 35, CPState day = 14
  = global 28.

- Pets and outfits (2026-10-29), throwaway `?nbhd=UserData8&house=69` (copy of UserData's
  neighborhood, Claire and her dog Luna): Luna walks, turns and stands with her d2o skills; "Jouer
  avec.../Caresser" plays a2d/d2a petstroke on both; the pet window shows Luna sitting, wagging,
  circling (AnimatePet). Claire: Dormir → TryChangeSuit → outfit 5, she changes and sleeps in her
  night wear; outfit 3 with a career = business suit; 2 / 4 / 6 / 8 (toga) / 0x13 / 0x18 / 0x27 /
  0x2c / 0x37 / 0x39 / 0x3c set by hand dress the swimsuit, formal, skeleton, costume trunk, Studio
  Town and Magic Town costumes (heads and hands included); the Transform window shows the costume.

## UI window audit (2026-10-29)

Every UI window class checked against the port (`docs/decomp/ui-coverage.md`); the missing ones a
player meets were ported and checked in Chrome (screenshots in the local scratch folder):

| Window | Where it shows | Checked |
|---|---|---|
| cWinBudgetDlg / cWinBudgetRow (`cpanel/budgetdlg.ts`) | funds button, residential lot | House01: 3-day / today columns per expense type, balance, "Total compte du ménage", "Valeur nette des biens", days; the simulation is held while it is up. The simulator now keeps the SIMI expense blocks (+0xe4 history, +0x184 today) and `spend()` records by type; the midnight shift reproduces the original's copy of day 1 into days 1..4 |
| cWinHelp (`cpanel/help.ts`) | "?" button | 30 topics, arrow keys, the last topic is remembered |
| Friend count dialog (STR# 162) | view control smiley | opens with the count fed (CPState.familyFriendCount: global 9 family's friends on a residential lot, else the selected person's person data 0x3d) |
| cWinSubpanelReportCard (`cpanel/live/reportcard.ts`) | job page of a child | House01, Max: "Bulletin 15/20", the "Notes" popup with the school picture. Fixed on the way: CARR ids were read unsigned, so the school career (-1) was never found |
| cWinSubpanelDogSkills / CatSkills (`cpanel/live/petskills.ts`) | job page of a pet | House69 copy, Luna: "Aptitudes des animaux"; the cat page ("Chasse") by changing the gender in memory |
| cWinEditBio (`cpanel/live/editbio.ts`) | Ctrl+click on a portrait | Jada's biography saved into her CTSS (throwaway copy) |
| cWinDeltaMeter (`cpanel/live/deltameter.ts`) | needs page | red / green arrows after a motive change; CPState now has both pulses (PulseGenerator +0x1f0 for the motives, +0x200 every 3 s at speed 1 setting dirty 0x6078000 for the panels). The relationship page now hosts its meter (+0x1a0) and pumps it, but cWinDeltaMeter(int) leaves the history at +0xe8 null, so the original never shows arrows there: kept |
| cWinDisposePopup (`cpanel/disposepopup.ts`) | holding a lot object in Buy mode | "Appuyer sur Suppr ou cliquer ici pour vendre Chaise El Tomayo pour $864", click sells (+$864), Escape restores the catalog |
| cWinEditDTLotDesc (`nbhd/wineditdtlotdesc.ts`) | saving / leaving an empty town lot | UserData6 copy, lot 22: "Chez Corinne", edited name and description written to DTDesc.iff and read back |
| cTSWinTutorialHighlight (`ui/tutorialhighlight.ts`) | tutorial lots, prim 34 effects 0 / 1 / 2 | forced on (no tutorial lot in the test neighborhoods); effects 1 / 2 flash the person panel's family button / the relationship page's button of the neighbor |
| Cheat console (`ui/cheat.ts`) | Ctrl+Shift+C | rosebud (+$1000, `rosebud;!;!` +$3000), "No such cheat!", xyzzy, interests, help window with `?devcheats`; the shipped build only registers 27 names (no "help", no "klapaucius" in this exe) |
| Ask-for-Lot picker filters (`nbhd/winneighborhoodul.ts`) | TryDialog kind 8 | `?test=nbhd&picker=1`: kFilterToolbar with the 7 filters (lodging disabled without a lodging lot), random title, filter icons over the matching community lots, blue outlines; a residential lot shows "Impossible de visiter" (STR# 0x104) |
| Neighborhood cheats | main neighborhood screen | `show_zones on` outlines the zones, `show_filter 2` the food icons |
| Shift smiley | family bin opened with Shift held | kPickFamilySmiley on each family row |

| Keyboard focus (`ui/winmgr.ts`, `ui/tswin.ts`) | modal dialogs, edit fields | keys go only to the focused window and bubble to its parents (cTSWin::TSOnKeyDown), up to cTSMainWindowW95::TSOnKeyDown (Ctrl+Shift+C); a mouse down gives focus to the clicked window unless WF_NO_FOCUS; DoModalWin focuses the modal window and restores the old focus. Arrows no longer scroll the lot behind a modal window; the per-window key forwarding workarounds (bio, lot description, family / character design, help) are gone |
| Family / lot imports (`nbhd/imports.ts`, `nbhd/winneighborhoodul.ts`) | neighborhood "Import" button | UserData9 copy: CycleThroughImports' dialog (STR# 143) for a .FAM in `Export/` and an uploaded one; imported families get new ids, character files (human / dog / cat templates by the uChr "dog" / "cat" entry), Gtab id remapping in the house file, portraits; lot 56 loaded with the imported family. Files can be dropped on the canvas or picked with a file input (web: written into the overlay's `Import/`); .rdt / .cmt lot imports follow CycleResidential / CommunityImports. Deviation: read-only `Export/` files cannot be deleted, so they are offered again on each cycle |
| Magic Town family picker (`cas/winpickfamily.ts`) | Magicland "Move In" family bin | `?test=cas&magic=1`: background 0x13b3, MagiCoins column (token type 7, GUID 0x99e81bec), shifted tips, the two hints for the first runs. The Magicland Move In flow itself is not ported |

Open points: the Magicland Move In flow, Tutorial.FAM's first-run import, the import charset
check and ReportMissingTextures, imports from the town screens.

## Remaining problems

| Problem | Suspected cause |
|---|---|
| Downtown clock "about twice as fast" | Not reproduced: 2 s of game time per tick on lot 25 and at home, speed 1 = 23.8 ticks/s and speed 3 = 450-480 ticks/s on both, one simulate() per frame after switchLots |
| Error 4 (random range 0) in DFController tree 4097 node 10 | Faithful: the range is the dance floor count (stack attribute 1) and the original TryRandom also fails on 0; only reached from the patterns when the count is not 0. Not reproduced in ~30 sim hours on lot 25 (0 dance floor tiles) |
| Error 62 at tree 8330 node 29 ("do new adult idle", holding an object) seen once on 5 townies downtown | Deliberate breakpoint in the BHAV; not reproduced in an A/B run (9000-33000 ticks), cause unknown |
| Repo man takes $1 controllers (music / pet) on a near-empty lot | Their price is 1 (MakeNewOutOfWorldObject); data-driven, probably faithful |
| A fresh empty lot (fridge only) starves its family: Have A Meal stops at "grab food" without a counter, then social worker and Grim Reaper | Probably faithful (no counter), not compared with the original |
| Wall price $75 per segment looks high | Faithful: Catalog::Init reads the price from Build.iff STR# 0x81 entry 1 in the UI language (StringSetBase::Load, GetString(-1)); the French entry is 75, the English one 70 (fences 10 / 45 / 35 / 45 in English, 10 / 50 / 40 / 50 in French) |
| Some catalog renders (RenderCatalogShot) look washed out / grey | Probably the sprite palette problem (U4, rendering); the shot has no shadow (ObjSelector::GetThumbnailHasShadow not ported) |
| Speed 3 is about 90 s per sim day | Faithful to the constants: SetSpeed's period = 172 - k x 171 ms with the buttons' k = 0.76023 / 0.92398 / 0.99415 (lbl_1059B8D8, lbl_1059A758), i.e. 42 / 14 / 2 ms per tick, 2 game seconds per tick: 30.2 min / 10.1 min / 86.4 s per sim day (speed 3 is capped by 30 ticks per frame, PulseGenerator::SetMaxPulses) |
| PIP window: an object's vertical shift is 0 | BuildImage shifts by the object's damage rectangle height (cXObject::GetLastDamage); a person's shift is ported. The level change does not recompute the cutaway |
| $TokenNameLocal needs the token's selector already opened | ObjectFolder.selectorByGUID is synchronous; an inventory object never opened in the session keeps the token |
| Spell list: expansion flags (ids 0x16 / 10) and the cookbook's "Has Made" filters (recipes 9 and 4) not applied | cPickSpellList::Init reads the app's +0x66 pack flags |

## Dev notes

- The dialogs queued during a tick are shown after it (microtask); the simulator is held from
  the first `show` until the queue is empty. Kind 0xa waits (instead of answering false) while
  the phone book is still up, because the web dialog is asynchronous.
- Automated tests that load a lot with "Help System" objects (House01) must dismiss the
  dialogs (Enter), otherwise the simulation stays paused, as in the original.

## User-reported bugs (2026-10-29)

Reported by the user after playing. Each is assigned to an agent; mark fixed ones here.

| # | Bug | Status |
|---|---|---|
| U1 | Second floor (level 2) missing on lots | fixed: the level 2 button was always disabled (CPState::HasBeenTo2ndLevel / Is2ndLevelFloorable read cFixedWorld+0x80 / +0x81, never set). ComputeRooms(2) now sets them (`rooms.ts` computeSecondLevelFlags) and the lot view copies them to CPState. Level 2 walls, floors, objects, stairs checked on House05 / House02 / House03, zooms 1-3, rotations 0-3, walls up / down, and with the view control button. ComputeRooms' floorable pass (flags bit 0) is ported too (`rooms.ts` computeFloorable): the recomputed bit 0 equals the one saved in all 25 UserData houses (both levels); House04 (one storey) in Build mode: four walls enable the level 2 button |
| U2 | Pets walk like humans | fixed (GetStdSkill's custom walk table: the pet's own STR# 150; verified on House69, Luna: d2o walk / turn / stand, pet interactions) |
| U3 | Camera mode (F4) screenshot does not work | fixed: the snapshot was not ported. Camera mode now draws the white frame on the cursor (HouseViewer::ComputeCameraFrame, CPState camera size), a click takes the frame inset by 1 px (398 x 300 for medium, as the original's files), plays `ui_camera_photo`, adds the page to the family album (cScrapbook::AddPhoto: `<nbhd>/PhotoAlbum/<Family>_<n>_NNNN.jpg` at the camera quality 20/50/90, `_thumb.jpg` 100 x 75, `.txt` description, through the overlay), then opens the album (cWinScrapbook: photo, description, Done / Delete / first / previous / next / last). The camera panel's album button opens it too. F1..F5 ported (cDDDSimsView::TSOnKeyDown, `cpanel/modekeys.ts`). Files: `cpanel/camsnapshot.ts`, `cpanel/camscrapbook.ts` |
| U4 | Some objects are grey (probably a color / palette problem) | fixed: SPR2 frames took their palette from the frame header (+8); SpriteListInfo::SpriteListInfo binds the list's palette (header +8) to every frame and never reads the frame field, which holds stale ids (0xfefe, 4, ...) in 466 object files (TVs, tubs, mailbox, outdoor trash, spa, closets, rugs, doors6, most Vacation objects...). Unknown ids fell back to a grey ramp. Lot and catalog checked (House01) |
| U5 | No free move: clicking the ground should offer "go here" | fixed: cObjPickerTool::TryClick on no object makes the "Destination - For Go Here & Shoo" object (GUID 0x7c4) out of the world, places it at the clicked point turned to world coordinates (FindGoodLocation, else the tile center; killed if CanPlace fails) and shows its menu; it is killed when nothing is picked (`winlotview.ts` makeGoHereHelper). The grass check for lot type 99 is not ported. The helper's pet commands (Bouge, Court, Est chassé(e), Shooed) are now hidden for people: ObjTestSim::TestInteraction clears the person's object data 50 (+0xae) before the check tree and flags the interaction 0x10 when the tree sets it, and AppendInteractionsForMenu drops 0x10 entries (their check trees 4108 / 4111 set it for non-pets). House01: only "Venir" is offered |
| U6 | Inventory menu (gift icon) is empty | fixed: the Gifts page (cWinGifts / cWinGift) is ported: the selected person's inventory (neighbor inventory tokens) with catalog icons, counts, prev / next and sort, and its Live popup (`cpanel/live/gifts.ts`, test page `?test=gifts`) |
| U7 | Studio Town and Magic Town neighborhood music missing | fixed: cGameModeManager::SetMode had no case for music modes 13..18 (`station_superstar`, `music_superstar_transition`, `music_magictown` + its river loop, Magic Town credits / build / buy). All cases ported from the Windows build (FUN_005752c4); the Magic Town credits play `music_magictown_credits`. Downtown and Vacation were already right. Enter: kill FadeAndKillTrackSlow then SetMainAndHitListKillFirst (the hood song stops, a town song starts); leave: `bkground_fade` (6.8 s fade) |
| U8 | Switching Buy mode → Build mode does not change the music (they have different music) | fixed (partly faithful): in the original Buy -> Build keeps the song that plays and only changes the folder of the next one (track 516 SetMainMusicSongAndHitList; MainMusicLoop is not interruptible and PlayPause of the paused track unpauses it; Magic Town Buy <-> Build is even skipped explicitly). Fixed around it: the HIT clock lagged behind under load (one tick per late setInterval: waits and the 6.8 s fade stretched, so going Live -> Buy soon after entering a lot resumed the neighborhood song); ticks now catch up on real time. Leaving Buy / Build for Live now kills the music at once (original), community and Magic Town lots get their station / Magic Town music in Buy and Build (CPState::UpdateWorldFromCPState), Build on a visited lot plays nothing |
| U9 | Hover popups (objects, motives, traits, anything) never open | fixed: plain tooltips already worked; the Live panel popups (cWinLivePopup) were missing. cTSWinBtn's async timer is ported (flags enter / down / up, 0x13 on timeout, 0x14 on exit), cWinPeople::SetQuickTips arms it from the quick tips option (0xfa / 0x14d ms) and 0x13 is a click. Popups: motives, personality (portrait crop), zodiac (sign text, compatible / incompatible signs), job (skills, career summary lines with the job composite picture, hours, salary, performance), house, interests, relationships (lifetime step text, sign, bio), gifts. The popup closes outside its page rect or when the page changes. In Live mode the lot view now shows the hovered person's first name (cObjPickerTool::Float). Not ported: object icon panes in the popups, the family portrait popup (person summary), the hilite outline of the hovered object. The catalog popup was already faithful (press / release, flags 6) |
| U10 | Double-clicking the selected sim should center the camera on it | fixed as in the original: CPState::SetSelectedPerson on the person already selected calls cXObject::CenterHouseViewOnMe(p, 1) (smooth scroll), so clicking the selected portrait centers the view. A double-click in the world does not center in the original (cTool::DoubleClick is two Clicks); Space already centers. The click sound is not played |
| U11 | Clicking an item in menus/lists (trait, object...) turns it light blue for good; the original does not | fixed: the list buttons are toggles whose state is reset by cWinLivePopupClient when the popup closes (DisablePopup -> target SetState(0)); popups never closed. Ported the popup toggle (open / close / switch target) for all the Live pages; checked on motives (state back to 0 once the mouse leaves) |
| U12 | The cursor does not change during actions (e.g. picking up an object in Buy mode) | fixed: cDDDSimsView::SetToolCursor (id 5 = keep) and the tools' cursors: cMoveTool::UpdateCursor (hand 10, place 0xb, can't grab 0xc, rotate 0xd..0x10, Ctrl on doors / windows 6), wall tool (delete 6), floor / wallpaper (0 / 6), water (0x26), cTool::Select resets to 0; Live mode follows cObjPickerTool::Float (LiveNothing 0x1c / pet 0x2b, LivePerson 0x1d / pet 0x2a, object with interactions 0x1e, none or off the lot 0x1f). cWinCPanel sets the arrow (GetCursor(0)) so the tool cursor stops at the panel (the rest of the cursor audit, 2026-10-31: U36 and `cursors.md`). Also: mouse downs on the panel's dead areas bubbled up to the lot view (the panel is its child) and clicked the world under it; they are now swallowed |
| U13 | Kyle and Jada (House01) have black portraits in the control panel | fixed (documented deviation): the data is damaged, not the port. Their BMP_ 2002 (User00109..User00174 in UserData, all of them) has a solid 0x000000 middle head: MakePersonBtnImage does not clear its buffer, so a head that failed to render was saved black, and cWinPeople shows that third (row 1) when the mood is above 25. The original only re-renders the faces when the thumbnails are dirty (PersonFinder::DirtyThumbnails -> GetPictureBuffer -> GenerateBitmaps(i, 1, 0), in memory). `loadCharacter` (data/neighborhood.ts) treats a blank third as such a dirty face and regenerates the 2002 in memory (never written), so every reader (control panel, phone book, dialogs, family picker) gets it. generatePortraits now leaves the faces buffer black, not magenta |
| U14 | Clicking a sim standing in front of the sofa or the easel picks the furniture | fixed: HouseViewer::PointToObjectID starts its tile walk at HouseViewer::PointToTile(pt, false), which reads the z-buffer at the point, unprojects it through the 3D camera (cAnimDeviceSub+0xa4) and, when HouseViewer::WorldToLevel gives the viewed level, takes that surface's tile; the port started from the floor tile (PointToWholeTile), behind the sim. The compositor now renders into a framebuffer with a depth texture (Compositor.present / readDepth), the picking is otherwise unchanged (rectangles, last on the tile wins). House01 (Chrome and Firefox): points on Kyle and Jada in front of the sofa pick them, the sofa and easel around them still pick. Not ported: PointToObjectID's mode 1 fallback test of the app's +0x1c / +0x36 short and the object definition's +0xb6 bit |

## Expansions playtest (2026-10-29)

House01 (Kyle, Jada) in a copy of UserData (`?nbhd=UserData9`, overlay, deleted afterwards),
driven through pie menu entries (the same code path as a click) and the real dialogs. To save
time, needs, skills (fame test) and magicoins (Magic Town test) were set from the console, and
some lot changes used generic call 17 directly when the sims could not walk to the phone (see
the routing problem below).

### What works

1. **Hot Date**: phone → Appeler voisin → phone book → Inviter... → Inviter en ville (type 1
   token) → taxi → downtown picker (lot 26); Kyle and Edmond arrive together. Talk (relationship
   up and kept), restaurant "Commander… / Plat du jour" with the date eating along, red roses
   bought ($200, type 0 token), pay phone "Rentrer" → home with the relationship, the date's
   memories and the roses (Gifts page). Giving the roses is refused by the data below
   relationship 50.
2. **Vacation**: phone "Partir en vacances" → picker → lot 48 with the whole family (-$500),
   check-in ($120), buffet, sleep, pay phone "Rentrer" → the family comes home, the clock tokens
   7 / 8 are consumed and the postcard token kept.
3. **Superstar**: "La Pipelette" tabloid → "Trouver un agent" → contract accepted: job 0, fame
   points 1, the agency's "Aller à Studio City" is free. Studio lot 83: open mic "Amuser" (a poor
   show gives the "work on it" dialog; with skills, the promotion dialog and person data
   0x50 / 0x51 / 0x52 = 2 / 1 / 1), Studio Town phone "Rentrer" → home with the fame kept.
4. **Makin' Magic**: Magic Town lot 93: the Dragon cart's "Troquer..." entries show once the sim
   has magicoins, "Friandise pour dragon" costs 5 coins and the ingredient token comes home; the
   clown portal "Rentrer à la maison" goes home. At home: wand charger "Ajouter.../Miel",
   "Charger.../Meilleures relations", then "Jeter.../Meilleures relations" on Jada (relationship
   98 → 100 both ways).

### Fixes

| Symptom | Cause | Fix (original function) |
|---|---|---|
| Downtown toilet stalls froze the sims ("missing skill a2o-toilet-stall-*") | The skills live in `Downloads/HPPottyPack/HPPottyPack.far`; only the game's own archives were indexed | VBAnimMgr also indexes each download directory's `<dir>/<dir>.far` (ObjectFolder::GetDownloadDirectories) (`sims/vbanimmgr.ts`) |
| Relationships, tokens and person data of a trip lost on the next lot | Neighborhood::Save rewrote the file's old NBRS / inventory; the live neighborhood was never written back | `NeighborhoodStore.save` takes the live neighborhood (rels, inventories, queued persistent data) (`data/nbhdstore.ts`, `sim/simmodule.ts` setLiveNeighborhood) |
| The date / family did not travel or lost their needs | cXPerson::TryChangeLots only half ported | Companion from the type 1 / 3 token, type 2 tokens (motives 0..6, person data 9..12, clock 7 / 8), Neighborhood::SavePersistentData of each member, then the save (`nbhd/transit.ts`) |
| Person data lost when a visitor leaves or the town lot is saved | Neighborhood::SavePersistentData / SaveAllPersistentDataForMatterTransferance / cXPerson::PreSave not ported | Generic call 25, tryKillObject on a person, SaveGame's town and residential branches (`sim/xobject.ts`, `world/savegame.ts`) |
| Vacation phone always offered every lot / families on vacation not tracked | Family +0x13c (vacation lot) not read; generic call 27 not ported | FAMI version > 7 field read, set on arrival; call 27 counts the free vacation lots (`data/neighborhood.ts`, `nbhd/transit.ts`, `sim/xobject.ts`) |
| False "Félicitations ... niveau supplémentaire" dialogs on every Studio Town visit | Generic call 34 (cFameTrack::PromoteIfNeeded) returned true | Ported with fame.iff's tables (STR# 4 / 5 / 6, skills lbl_105BB7FC, friend weight 0.5) and Neighborhood::GetFamousFriendCount (`sim/fametrack.ts`, `sim/simmodule.ts`) |
| Studio Town taxi splash always the fan one | Generic call 35 (ObjectModule +0x110, the person asking) not ported | Call 35 records the person; PostSim shows splash 5 for a star (person data 0x50 > 0, job 0) (`sim/xobject.ts`, `nbhd/transit.ts`) |
| Wand charger "Ajouter..." did nothing (32 unported hits) | Generic call 38 not ported | The numbers of STR# temp 0 entry temp 1 of the running tree's file into temps 1..7, count in temp 0 (`sim/xobject.ts`) |
| Functional tree 8 / scope 38 unported (62 / 2106 hits) | Not ported | Functional tree 8: entry point 0x1a for a person with person data 0x41 < 2; scope 38: FindNeighborByID(stack object), definition field (0..0x6c) of the neighbor's object (`sim/xobject.ts`) |
| Generic call 41 logged as unported | It jumps to the common exit | Returns true |
| Lot view black, SaveGame thumbnail error after a few lot changes | Each portrait generation made a new WebGL context ("Too many active WebGL contexts") | `generatePortraits` shares one head camera (`cas/portraits.ts`, minimal change in that area) |
| Vacation NPCs (mascot, janitor, maid, director) never appeared; "create object (no world)" during Simulator.postLoad | ObjectModule::PostLoad ran inside Simulator.create, before the lot view had its placement / world hooks; ObjectModule::ResetForVacation was not ported, so the controller's Init ("CT - Lot Reset": spawns when global 0x20 is 0) never ran on arrival | The lot view defers PostLoad until its placement exists (Neighborhood::LoadHouse runs it in the built world; `Simulator.create(..., deferPostLoad)`, `WinLotView.init`); ObjectModule::ResetForVacation (kill the persons, OBJD +0xc4 = 2 kill queue, = 1 Reset) is called by LoadGame's vacation / community / Magic Town branches before the arrivals, sparing the arriving family the port makes earlier (`sim/simmodule.ts`, `nbhd/transit.ts`). Lot 48 family trip: mascot, janitor, maid and director made once, director greeting, maid / janitor working; a plain visit (global 0x20 = 1) spawns none, as in the original |
| A queued interaction dropped by Idle For Input left its object unaware | cXPerson::TryIdleForInput runs the object's entry point 4 when the test fails, the action tree is missing or the push fails | Ported (`sim/person.ts`) |
| Studio Town movie set (lot 83) offered no entries; the visible set tiles did nothing | cXObject::GetInteractionLeader missing: only the invisible tiles 0,0 (interaction group -1) and 1,0 carry TTAB 129, every visible part (group 1) points to a missing TTAB 128. Also, HouseViewer::PointToObjectID's first-tile fallback in Live mode (global 19 = 0) takes only objects with OBJD +0xb6 bit 0 | `SimObject.getInteractionLeader` (ObjTestSim / cObjPickerTool::SetHiliteObject use the leader's tree table; liveClick and the hover menu go through it; CanChooseAutonomously shares it) (`sim/xobject.ts`, `world/winlotview.ts`); the fallback test with the mode (`world/tools/picking.ts`). Movie set "Jouer…": the full scene, choice dialog, result, star points 100 → 180 with fame level 9 (the set refuses below 9 on lot 83: "Je travaille avec de vraies célébrités", and with low motives). Photo shoot (lot 86, "Poser…/Maillot de bain") and recording (lot 84, "Enregistrer…/Rock") run to their result dialogs. The Photo Camera of lot 83 is decorative (empty TTAB) |
| False "Félicitations … niveau supplémentaire" at home for a level 10 star (Kyle, House01) | Generic call 36 (cFameTrack::DemoteIfNeeded, then OnStarPowerChange) fell to the unported default, which returns true. "Controller - Home Fame Decay" (ControllerStudioLot.iff, BHAV 0x1020) keeps the old level, calls 36, and on true shows the demotion dialog when the level fell, else the promotion one | Call 36 ported: one level less when the star points fall below the previous level's (`sim/fametrack.ts` demoteIfNeeded, `sim/xobject.ts`). Call 34 has no career guard in the original either |
| No fame page in the control panel for a star | cWinSubpanelFame not ported | `cpanel/live/fame.ts`: title, fame bar (kFameSubpanelBars), level title, the six skills against the next level's needs, famous friends; the people panel swaps it for the job page by CPState::GetShowFameUIPanel (star points > 0, job 0) (`cpanel/people.ts`) |
| Studio / Magic Town picker cursor always the taxi; Magic Town taxi splash always 6 | cWinStudiotown +0xd0 / cWinMagicland +0xdc not set; cursors 0x2d..0x2f not registered | PostSim sets the flag before the picker: Studio a star asking (limo 0x2c, else tram 0x2d), Magic global 34 "Lot Transit Info" != 0 (balloon 0x2f and splash 6, else hole 0x2e and splash 7); Vacation's picker cursor is the van 0x27 (`nbhd/wintown.ts` TownDef.pickerCursor, `nbhd/transit.ts`, `ui/cursor.ts`) |
| No plumb bob over the selected sim, no star / date bob | The plumb bobs are 3D objects (OBJD +0xcc bit 0, cXObject::Initialize3D: an Animator), not ported | `world/plumbbobs.ts`: ObjectModule::InitPlumbBobs (PlumbBob.iff 0x2f726fff, DateBob.iff 0x0baa71c5, MakeStarPlumbBobs from StarBob.iff 0xe9337020 in ExpansionPack6.far: 4 spares, 2 without the Superstar pack), OnSelectionChange, OnStarPowerChange (fame level > 9, non-selected), OnAutoFollowChange (date bob, person data 77), UpdatePlumbBobs (the dirty queues fed by InterpValue writes of person data 77 / 81: `sim/xobject.ts`, `sim/simmodule.ts`), PostLoad, the pickup before SaveGame and the put back after (`world/savegame.ts`), OnKill / OnEnter / OnExitWorld. Placed with cXObject::Place in the person's slot "HEAD"; drawn by `sims/animator.ts` (Animator::Render's self-lit branch: skeleton "root", styles head-arrow / head-arrow-date / head-star, color from the carrier's mood clamp(1.2 * mood / 100), own light along the camera turned by Y 80° X 30°, ambient 0.25 * color + 0.05, one turn every 2 s at (0, 3, 0) above the HEAD bone), depth-tested in the world (`world/lotpeople.ts`); sprite drawing skips 3D objects (`world/lotobjects.ts`). House01 (Chrome, Firefox): green bob over Kyle at the three zooms, red at mood -60, yellow-green at 10, the star bob over a non-selected level-10 star (Kyle once Jada is selected), the date bob (lavender) over Jada with person data 77 set. Faithful quirks kept: no mode-based hiding (the bob shows in Buy / Build / Camera, no such test in the code), OnStarPowerChange's low-fame branch removes the date bob GUID, not the star one; cFameTrack promotions do not call OnStarPowerChange (only PostLoad, Save and person data 81 writes) |
| No clouds / balloon over Magic Town, no cars in Studio Town | cMagiclandSprites::DoClouds / DoBalloons and cWinStudiotown's cars not ported | `nbhd/townsprites.ts`, drawn after the water by `nbhd/wintown.ts`: InitClouds (21 clouds, 8 / 9 / 16 never placed), AnimateClouds (move every 2 or 3 steps, the Compose2 mask offset +2 right of x 100, -3 left of 30, -255..-110; kMagictownFogA..C' TGA alpha + offset, <= 7 skipped, >= 248 copied, else (a >> 3) / 32: here cached per offset in steps of 8), clouds only above the Low terrain detail (+0x38c); InitBalloons / AnimateBalloon (ellipse 200 x 100 around (400, 300), angle 0.785 * (n % 1440) / 180, frames kMagictownBalloon1..16 every 35 steps); both on cWinMagicland's 26 Hz clock. Studio Town: InitCars (6 lanes, 13 / 11 / 10 / 8 / 7 / 5 cars, kStudiotownCar0..17), AnimateCarLane / AnimateCarNE / AnimateCarSW (following distance car width + 4, random speed changes, top speed +0x354 = 1, ages counted by TSPaint), on TSPaint's 20 Hz clock (lbl_105BCDF8). The cars are on from the constructor (+0x350); the "cars" cheat only says "Cars are already on." The sprites are clipped to the 800 x 600 map above that resolution |

### Remaining problems

| Problem | Notes |
|---|---|
| Sims in a doorway do not step aside on a crowded lot (House01 with ~20 guests); phone / tabloid / spellbook fail with "route failure" | Investigated (28 asks traced with 20 neighbors spawned on House01, Chrome): AskOthersToMove / MoveOutOfWay / AddAction / ShouldInterrupt / TryIdleForInput / the route states 6 and 14 match the original (Mac asm checked: priority = the asker's person data 33, strict `>` test, the 100-tick wait). Asked people with a lower priority do move ("Bouge" started 6 times out of 6 for idle or autonomous blockers). The other asks fail as in the original: blockers at the same or a higher priority (scaring ghosts "Effrayer" 100, a served meal "Mange" 50, user actions 50, idle wanderers 0 asked by idle wanderers 0), non-interruptible ones (person data 71: socials, a visitor knocking at the front door), or the move dropped by a higher-priority push (AddAction); after its 100-tick wait the asker gives up and removes the move (RemoveAction), so the blocker's queue looks empty. Note: neighbors spawned from the console include the dead sims of the neighborhood (person data 68 = ghost), whose scares run at priority 100. Only fix: TryIdleForInput now runs the object's entry point 4 ("queue skipped", the helper's cleanup) when a queued interaction is dropped |
| The tabloid / newspapers show only "Recycler" in the afternoon | Graphic 1 (old paper); their check trees need graphic 0 or 2. Probably faithful (a fresh paper comes in the morning), not compared |
| ObjectModule::OnStarPowerChange after a promotion / demotion | Fixed with the plumb bobs (see the fixes above) |
| "NPC - Vacation - Controller" made the mascot / janitor / maid / director before the world hooks existed | Fixed (see the fixes above) |
| A family member (Jada) once appeared downtown as a townie while living at home | Investigated 2026-10-30 (see "Magic Town move in, town imports, tutorial"): probably faithful. The walk-by filter of VisitGenerator.iff ("make walk by" 4116 -> "can this person visit?" 4102 -> "test - person at work?" 4119) only refuses a neighbor living on the current lot (neighbor data 6 == global 10), on the tutorial lot (neighborhood data 2), at work, or some children; nothing tests the travelling family, so a member left at home is a valid walk-by on a community lot. The port's GetNeighborData 6 / scope 34 match. Not fixed |
| Downtown "Have A Meal" from the expensive fridge repeats ($10 each) | Not compared with the original yet (possibly faithful: each meal is a new autonomous choice while hungry) |
| "missing skill listen normal apathetic" once after the agent contract | Not faithful after all (2026-10-30, see "Door deadlocks, autonomy filter, partner cleanup, anim tables"): the port read STR# 129 where GetObjectSkill picks 0x83 / 0x84 for an adult / child pair. Earlier note: Faithful data bug: SocialChild.iff (ExpansionShared.far) STR# 129 (adult animations) entry 73 is "Listen normal apathetic" (the child / mixed tables 130..132 have "C2C-listen-normal-apathetic" etc.); VBAnimMgr::FindSkill finds nothing in the original either. SAnimator::TryAnimate then runs the person's "missing animation tree" and starts GetSkill(0x25) on the main practice: now ported (`sim/person.ts` startMissingAnimation) |
| Magic Town clouds and balloons (cMagiclandSprites::DoClouds / DoBalloons), Studio Town cars | Fixed (see the fixes above) |

## Soak test (2026-10-30)

House01 (Kyle, Jada, their child Max) in a throwaway copy of UserData (`?nbhd=UserData9`, copied
through `PUT /api/files/...`, deleted at the end), headless Chrome (SwiftShader), speed 3, driven by
`~/simsweb-build/tools/soak.mjs`: dialogs answered with Enter (their text logged), the speed put
back to 3 when the game drops it (cXObject::TryUserEvent's GlobalDispatch(0x10c), faithful), a
health sample every 15 s (heap after a forced GC, object / person counts, tick and frame
histograms, tick spikes with the slowest object, new unported hits, tree errors, people made and
killed with the object running, people on the same tree for 3 sim hours), saves through
`ctx.hooks.saveGame` and a page reload between segments. Logs: `~/simsweb-build/scratch/soak/`.

Earlier work of the interrupted run (committed): cXObject::TryBurn (prim 9), per-object error
traces, indexed relationship lookups and a neighbor-by-id index, KillOutOfWorldObject deselecting
the selected person, FindGoodLocation's coordinate order. Firefox WebGL→2D copy 5.7 ms per frame.

### Segments

| Segment | Sim time | What | Numbers |
|---|---|---|---|
| A (before the fixes) | 14d 05:54 → 16d 05:54 | autonomous, save at the end | heap 314 → 411 MB, objects 580 → 633, up to 29 people on the lot, tick mean 0.11 → 0.47 ms, 30 ticks over 100 ms (route-failure searches with the crowd), House01.iff 566 150 → 578 492 bytes |
| 1 (fresh copy, visitor fix) | 14d 05:54 → 16d 09:11 | autonomous, save | heap 331 → 397 MB, objects 551 → 573, 2..10 people, tick mean 0.13 ms, 10 ticks over 50 ms, 2 tree errors (below), House01.iff 569 840 bytes |
| 2 (reload, LotPeople fix) | 16d 11:43 → 19d 11:35 | autonomous, save | heap 331 → 383 MB, objects 581 → 593, 2..9 people, tick mean 0.17 ms, 1 tick over 50 ms, 0 tree errors, funds 66 189 → 64 029 (bills paid), House01.iff 571 054 bytes |
| 3 (fresh copy) | 14d 05:54 → 18d 07:04 | autonomous | heap 331 → 419 MB; Kyle stuck in "Vibrer" (idle) for a day after Jada left the bed (not reproduced since) |
| S1 (fresh copy, player plan) | 14d 05:54 → 17d 09:07 | plan (`main-plan.json`): breakfast pushes at 6:00, Max homework / reading 16:30, bills 17:00, Kyle cooking skill 17:30, kiss / hug 18:30, "Vibrer" + "câlin" 21:00, job search, caterer + phone-book invitations on days 16 / 21; save | heap 330 → 430 MB, objects 582 → 640, tick mean 0.14 ms, 10 ticks over 20 ms, 1 over 50 ms, 1 tree error, House01.iff 576 100. Caterer ($350, then left: "no table or punch bowl", faithful), phone book (WinPhoneBook, invite / talk, refusal), Kyle +1 cooking, a star-contract offer, bills paid. Kiss / hug menus empty when the target was busy, "câlin" missing when Kyle was not in bed (menu tests, faithful) |
| S2 (reload of S1) | 17d 09:11 → 21d 12:08 | same plan; save | heap 350 → 398 MB, objects 676 → 690, tick mean 0.30 ms, 38 ticks of 20..50 ms, none over 50 ms, frame mean 87 ms (SwiftShader, many visitors and dogs). Max sent to military school 18d 11:04 (grades), Jada died 19d 23:46 (passed out, then starved). House01.iff 578 862 |
| S3 (reload of S2) | 21d 12:12 → 25d 12:49 | same plan, Kyle alone; save | heap 321 → 366 MB (+11 MB/day), objects 693 → 740, tick mean 0.13 ms, 5 tick spikes (20..50 ms), 1 tree error, bank reminder for unpaid bills, Jada's ghost walking at night (urn, faithful). House01.iff 583 488 |

S1 → S3 is 11.3 continuous sim days with two save / reload cycles; with the earlier segments the
lot ran about 22 sim days. Save files grow slowly (House01.iff 566 150 → 583 488 bytes over 11
days, Neighborhood.iff 180 628 → 183 232). The tick cost stays flat (mean 0.13..0.30 ms at speed 3).

### Fire (cXObject::TryBurn)

Second throwaway copy (`?nbhd=UserData10`). House01 has no stove, so a "Stove - Cheap" (GUID
0xeb686709) was made and placed from the console through the same world hooks the Create Object
primitive uses (no charge), and everyone's cooking skill (person data 10) set to 0; meals were
pushed through the fridge entries as a click would.

1. Stove in the kitchen (another room than the smoke alarm): the stove caught fire while cooking
   (TryBurn, a Fire object on its tile), the stove burned away (Ash, ReserveTile), the fire spread
   to 3 tiles, Max panicked ("Au feu !", Panic), no alarm (the detector is in another room, as in
   the original: it only watches its room) and no firefighter; the fires burned out about two sim
   hours later. No tree error.
2. Stove next to the living-room smoke alarm: fire at ~9:50, the firefighter NPC came through
   the pedestrian portal at 10:28 ("NPC Fire Fighter", extinguish core), Kyle panicked then ran
   "burn to death", the Grim Reaper came (create reaper), the fires were out at 11:52, the
   firefighter left at 13:15, the death dialog "Toutes nos condoléances ! Kyle vient de mourir"
   and an "Urn Stone Celebrity" (a star's urn) appeared. Generic call 6 (run by the reaper's
   ceremony) was the only unported hit: ported (neighbor check, error 0x37; the tool / main window
   refresh it posts is what the port's panels do on every pump).

### Findings and fixes

| Problem | Cause | Fix (original function) |
|---|---|---|
| Visitor flood: up to 29 people on House01 by midnight, the family unable to sleep ("failure sleep"), tick mean x4, route-failure spikes | House01's save holds an out-of-world Studio Town tourist car ("Car - Studio - Row 0 Tile 0", attribute 0 = 1). Its Main spawns three visitors (Spawn Visitor) and pushes them its "get out of cab" interaction: they spend their whole visit inside the car's tree (an ObjectRecord on the car). When a visitor left through the pedestrian portal (Remove Object Instance, operand flag 2 or 3), the port's cXPerson::Cleanup cleaned up every record object, so the car ran Cleanup(0) → Reset → Main again → three more visitors, every time anyone left | ObjectModule::AddToKillQueue(id, false) sets +0x114 bit 0x1000 (cXObject::TryKillObject passes `!(flags & 2)`), and cXPerson::Cleanup only cleans its record objects up when that bit is clear on itself (own cleanup) or on the object cleaned up for. Ported (`SimObject.keepRecordObjects`, `SimModule.addToKillQueue` also queues a multi-tile part's lead, `PersonSim.cleanupFor`). Visitors on the lot after the fix: 5..11 |
| Every visitor and walk-by kept its VitaBoy after leaving: heap +33 MB per sim day | `LotPeople` added a person's animator on entry (drawPerson) and never dropped it; killed people stayed in `people` (hidden by object data 34, still walked every frame) | `LotPeople.onKill`, called from the lot view's kill hook (KillOutOfWorldObject deletes the person with its SAnimator). Heap growth after the fix: about +17 MB per sim day (caches still warming, see below) |
| Game speed dropped to 1 several times a day | cXObject::TryUserEvent's GlobalDispatch(0x10c) (skunk, NPC events): faithful | the driver puts speed 3 back, as a player would |
| Studio car / "visitor leave" dialogs "Il se fait tard..." stop the clock while open | faithful (DoSimsModalDialog holds the simulation) | answered by the driver |
| Generic sim call 6 unported (the Grim Reaper's ceremony) | not ported | ported in `tryGenericSimCall`: Neighborhood::FindNeighborByID on the stack object (error 0x37), the tool / main window refresh is the port's per-pump UI update |

### Checked, faithful

- **Autonomy scoring** (the family lets its needs fall to -100, top scores around 0.01). Compared
  with MotiveEffects::GetInteractionScore (asm at 0x10096B40) and cXPerson::TryFindBestAction:
  the advertised value is `min + delta` (or `min + personality * delta / 1000`), scaled by 0.001
  (lbl_105BB934 = {0, 1000, 0.001, -100}) before it is added to the motive, the curve value is
  averaged over the curves, the score is `1 / (dist * attenuation + 1) * (ad - current)` (the 1 is
  lbl_105BBB78 +0x20), and FCNS 2 of Global.iff holds min score 1e-7, attenuations 0.1 / 0.3 /
  0.6, random count 4: the port matches. Small scores are normal; the ranking is what counts.
- **"Socials - Pet - Dog" objects pile up** (142 in the shipped House01 save, +37 per sim day
  here): out-of-world social objects idling in their Main loop (node 20: `attributes[3] > 2` keeps
  them alive, BHAV 0x1001 recomputes it from relationships). The Maxis save already holds 142 of
  them, so the original keeps them too. Not changed.

### Remaining

- **Route give-ups around House01's doors** (the main cause of the family's collapse): the
  driver's "gu" counter reaches 20..190 give-ups per 15 s sample for Kyle standing on
  "Door - Wood 2 part 2" (488,392) and Jada at 584,394 (inside "Door - Wood 2 part 1" #94's tile):
  route result 4 or 3 on a path that starts on the door tile (`488,390 488,392 488,408` →
  "arrived" at once, then an empty path). Sims that cannot leave the doorway miss beds and food,
  pass out ("failure sleep") and starve: Kyle died in segment 2, Jada in S2. Probably XRoute's
  start point or the portal choice when the person stands in a door's tile (room id of the door
  tile); not found yet.
- **Autonomy object filter not ported** (ported since, see "Door deadlocks..."): TryFindBestAction only looks at every object one call in
  four (`(lot +0x98 + person +0xf0) & 3`: 0 all objects, 1 within 7 tiles (lbl_105BBB78 +0x1c),
  2 / 3 objects with +0xf0 bit 0), all objects when the neighborhood zoning type is not 0; the port
  scores every object each time (more lenient, costs CPU).
- **Tree errors** (each resets the person, as in the original; Kyle's 0x15 fixed since, see "Door
  deadlocks..."): Kyle 0x15 in "Is either a Sim?"
  (Social - Child 1.5's "Set Soc&Rel to Person A") after Max left for military school mid-social,
  repeated 6 times over 10 sim hours from the same leftover social object; NPC Maid 0x15 in a
  Tabloid's "get paper to read" whose reader (Jada's ghost) was gone; Butler 0x15 in the trash
  compactor's pickup once; Jada 0x4 in Dance Floor Controller `Random(4097):10` (range 0) a few
  times.
- **Vibrer partner wait**: once (segment 3) Kyle stayed in "Vibrer" idle for a sim day after Jada
  left; not reproduced.
- **Heap**: +11..17 MB per sim day after the fixes, falling back on reload (S3: 321 → 366 MB in 4
  days). The collections that grow are caches filled on first use of an object kind (behaviors
  300 → 436, tree tables 272 → 322, parsed IFF chunks, action icons), no per-visitor leak left in
  the objects reachable from `window.game`.
- **Route-failure tick spikes** of 20..50 ms (`goto door and face thru`, `move from filled tile`,
  `goto nearby`), 5..40 per 4 sim days; over 100 ms only with the visitor flood (fixed).
- Unported animation names ("missing skill tease a", "giggle start/loop/stop", "scare b",
  "listen normal apathetic"): skeleton animations missing from the loaded sets. Fixed in the
  next section (wrong anim table: a port bug, not the data).

## Door deadlocks, autonomy filter, partner cleanup, anim tables (2026-10-30)

Throwaway copy `?nbhd=UserData11` (deleted at the end), headless Chrome, speed 3, soak driver
with extra hooks (scratch: `~/simsweb-build/scratch/route/`): every failed XRoute::FindPath of a
person (result 3) recorded with its RoutingParams (start, goals, obstacles near the person, the
room partition rectangles), and, after 6 failures at the same spot, the person's last routes and
those of the people near it.

### Door tiles (task: sims stuck at 488,392 / 584,394)

- **Not the door tile itself.** A sim teleported onto 488,390 / 488,392 / 584,394 (any facing,
  walking or running) plans and walks normally: the room id of a door tile is the room on its side
  (ResolveRoomID; the door's two parts are two objects in two rooms: "part 2" #115 at 488,392 in
  room 1, "part 1" #119 at 488,408 in room 2), ChooseStartingPoint is the person's position, the
  portal chosen is the door's part in the person's room. When the person stands idle on a door
  tile, its own "move away from door" tree (person main loop node 23) walks it off first.
- **Static map of the door tiles** (FindPath from every point of the tile, 8 facings, door slots 5
  "goto door and face thru" and 1 "goto other side"): only the starts inside the 7-unit inflated
  wall margin fail (y 394..399 except the 4-unit gap x 486..489 in front of the door; for door #94
  also x < 582, the wall west of room 7). The door's two-step crossing keeps people in the gap, so
  these starts are not reached by a normal walk. Faithful (BuildRoomPartition's inflation,
  SpacePartition::Init keeping a 1x1 start rectangle that cannot grow).
- **What the stuck runs showed** (the old trace `trace1`, and soak f1 / f4): the failing plans
  all had a *person* (or a lying one) in the way, never the door geometry:
  - f1: visitor Freddy stopped mid-crossing at 488,403 (in the door gap of room 2) facing the
    Superstar Butler at 486,409 who was waiting to cross the other way. Each one's start or goal is
    inside the other's inflated rectangle (BLOCKED, person +3 +3); each asks the other to move
    (AskOthersToMove) but MoveOutOfWay refuses when the asked person's top route has itself asked
    someone (+0x80), and the move-out-of-the-way interaction of the other is not taken while it
    runs the door's portal tree. 40 + 24 failures in a row, and Jada (504,408) could not reach the
    door behind them (35 failures).
  - f4: Max passed out on the bathroom floor (sleep anim) next to the door #94: a BLOCKED rectangle
    [575,361 .. 597,383] closes the only lane to the door gap; Kyle (584,360) and Jada (616,376)
    fail every plan out of the bathroom (604 failures in 3 sim hours).
  - `trace1` (Jada at 488,390 → door #115): the first step ("goto door and face thru", path
    488,390 → 488,392) "arrives" without moving (see below), then "goto other side" finds no path
    from 488,390, which works statically from there: most likely the butler (the only other person
    in room 1; its position was not logged) stood in the gap.
  These obstacle rules are the original's (XRoute::FindPath's loop checked against the Mac
  pseudo-C: person rectangle = ComputeRect with lbl_105BA224 = 6, objects overlapping the
  person's rectangle skipped with _IntersectRect, people and BLOCKED rectangles inflated by 3;
  ShouldIgnore only ignores +0x7c, people farther than lbl_105BBD58 +0x14, passable objects;
  MoveOutOfWay(person, route, path) and AskOthersToMove match). No port deviation found in the
  routing itself; the deadlocks need two people in a door at once, which the fixes below make
  rarer (stale partners no longer reset, fewer autonomous object scans).
- **Deviation left**: a walk-through-door step (object data 9 set) whose only segment is shorter
  than the 3-unit stop threshold ends without moving (SAnimator walking: `pending`, `oneMore`
  step with the last step's stale delta), e.g. "path 584,458 584,456 → arrived at 584,458". The
  next step ("goto other side") plans from there and works; not changed.

### Autonomy object filter (cXPerson::TryFindBestAction)

Ported: `filter = (cSimulator +0x98 ticks + person id) & 3`, 0 when the lot's zoning type is not 0
(not residential); 0 scores every object, 1 only those within 7 tiles (CalcShortDistance <=
lbl_105BBB78 +0x1c = 7.0, read from mac.bin), 2 objects with an even id, 3 odd ids (+0xf0 bit 0).
The person's own object is scored when it is a pet (person data 0x41 >= 2), as in the original
(the port skipped it always). Not ported (logged here): the Hot Date downtown / vacation filters
of the same loop (lots 40..49 or zoning 2: objects whose master OBJD +0x8a is 4 or 5 skipped;
on lots 40..49 with a family other than global 9, objects with object data 59 = 0x2e).

### cXPerson::Cleanup(obj): the interaction's icon person (+0xa14)

The original lets go of everything (records' frames popped, Main restarted, current action
emptied) when `obj` is one of the person's ObjectRecords **or the current interaction's icon
object (+0xa14)**, drops queued interactions whose object (+8) **or icon (+0xc)** is `obj`, and
zeroes the icon of the last / current action when only the icon matches. The port only tested
the records and the object. Effect: when Max left for military school mid-social (Kyle running
"Tease Scare - Person B" with Max as icon), Kyle kept his frames and later ran "Set Soc&Rel to
Person A" → "Is either a Sim?" with the gone Max as stack object: tree error 0x15, six times over
ten hours. Fixed (`PersonSim.cleanupFor`).

### Animation tables (GetObjectSkill)

"missing skill tease a / giggle start / giggle loop / giggle stop / scare b" (and "listen normal
apathetic") come from SocialChild.iff STR# 129, the *adult* table of the child socials object,
whose entries are placeholders ("Tease A", "Giggle Start", "Scare B", "Tickle A Start"...); the
real names are in STR# 130 C2C, 131 A2C, 132 C2A (Animation.far has a2c-/c2a-/c2c-giggle-start,
-scaree, -scarer...). The original's GetObjectSkill(object, person, index, other) picks 0x81 adult,
0x82 child, 0x83 adult to child, 0x84 child to adult from the person's age (+0x600 < 18) and,
for the main practice (neither flag 1 nor 0x10), the age of the current interaction's icon person
when the interaction is on that object. The port only had 0x81 / 0x82: an adult socializing with
a child read STR# 129. Fixed (`PersonSim.resolveSkillName`). Not a data bug.

### Validation

Two runs with all the fixes, fresh copies of House01: f5 14d → 18d (4 sim days) and v1 14d 08:42
→ 20d 06:25 (6 sim days). No family member stuck: the per-sample give-up counter stayed at 0..5
for Kyle and Jada (Max once 69 while dancing on the dance floor, not near a door), 167 / 646
failed person plans in all (visitors and NPCs mostly; f1 / f4 before the fixes: 621 in 2 days,
604 in 3 hours of a bathroom deadlock), no death; Max sent to military school 19d 11:00 (grades,
faithful) and removed at 19d 18:06 without any tree error for Kyle this time; no "missing skill";
the only tree error was Jada's 0x4 in the Dance Floor Controller's `Random(4097):10` (range 0, known).
Tick mean 0.17 ms. The deadlocks are random (f3, old code, 6 days without one), so this does not
prove they are gone: they need two people meeting head-on in a door, or a sim passing out in a
doorway, which the original allows too.

### Other 0x15 errors

- **Maid in the Tabloid's "get paper to read"** (node 2, run functional 5 on the paper's container,
  object data 2 = 440, Jada's ghost, gone): the paper's container id (written by cXObject::Place
  / Pickup / Reset only, as in the original) still named the dead ghost while the paper was not in
  its slots (else KillObject would have killed it with the ghost). Not reproduced; cause not found.
- **Butler / maid at the trash compactor's "pickup core"** (node 5, Call named tree on the
  compactor's slot 0 after the animation event): the plate the cleaner wanted is in the
  compactor's slot per its object data 2 when "get food" starts, slot 0 is empty when the event
  fires. Likely two cleaners on the same plate (the butler and the maid both run Clean Up). Not
  reproduced; not changed.

## Magic Town move in, town imports, tutorial (2026-10-30)

Throwaway copy of the game's UserData (`?nbhd=UserData21`, overlay, deleted afterwards), Chrome.

### Magic Town Move In (cWinMagicland mode 1)

- Move In button -> cWinPickFamily (magic town variant: MagiCoins column, magic hint text,
  `bkground_family` music then the town music), Move In mode (cursor 0x21, buttons), lot popups
  per cWinLotPopup::GetMagicPopupIndex (MovingInFamilyCanAffordMagic: 31 ok, 36 coins short, 37,
  38 funds short, 34 nobody), roof dissolve per cWinMagicland::ShouldAllowRoofDissolve,
  MoveInModeLotHandler (STR# 132: buy house / lot, too expensive, occupied, tutorial lot, not a
  Magic residential lot), "Acheter la maison ?" -> lot loaded with the family.
- Fee: cWinMagicland +0xd8 is written by GetMagicPopupIndex (`stw r26,0xd8(r7)`: the cost of the
  last popup's lot), costs are UIText STR# 134 entries 32 (1500, house 91) / 33 (1000). Verified:
  family 4 with 2000 MagiCoins moves onto lot 92, 1000 coins charged (SimInventory::
  RemoveCountTokens on the first inventory record of the first member, GetInventoryByNeighbourID
  semantics), funds 8213 after the house price.
- Deviation: the coins are charged just before the lot loads (the original charges in the same
  call chain, before LoadGame; no visible difference).

### Town imports (Downtown, Vacation, Studio Town, Magic Town)

- cWinNeighborhoodUL::CycleThroughImports per town: `*.dtl` (DTDesc.iff), `*.vil` (VIDesc.iff),
  `*.stl` (STDesc.iff), Magic Town `*.mtl` (MTDesc.iff, CycleCommunityImports) and `*.mtf`
  (families, CycleResidentialImports), titles STR# 169 entry 3 / 173 / 174. A lot file carries
  STR# 2000 (name, description, house) and BMP_ 0x200; Yes replaces the house file, writes the
  name / description into the town's description file and deletes the import; Delete asks
  (STR# 154) then deletes. Vacation refuses a lot a family is on (STR# 131 22 / 21).
- Verified with a synthetic `TestLot.mtl` (House94 + STR# 2000): dialog "Importer parcelle
  Magicland" with the picture, lot outlined; Oui -> House94 replaced, MTDesc updated, file gone.
  No real town lot file was available (the game ships none).
- Web: with an empty import folder the button opens the file picker (as the neighborhood's).

### Tutorial

- Tutorial.FAM import (cWinNeighborhoodUL::CheckForNewImports, silent), Reset Tutorial
  (cSimsApp::ResetTutorial, STR# 153 7/8/9), generic sim call 0 (Neighborhood::
  TutorialCompleted), Escape (Neighborhood::CancelTutorial), first run emulation of the installer
  (`firstRunTutorial`: run count 1 -> Tutorial.FAM copied into UserData/Import when the tutorial
  lot is free), run counts in cOptionsMgr (factory 1, +1 per launch).
- Fixed: the Tutorial object was never made. Tutorial.FAM carries global 26, not the object:
  Neighborhood::LoadHouse makes it (MakeNewOutOfWorldObject of GUID 0xc3249a1d, Objects.far
  Tutorial.iff) after PostLoad when NGBH +0x12a < 3, global 26 set and the cheat flag
  DAT_006e4a58 clear (`makeTutorialObject`).
- Fixed: object dialogs without a button (+0x39 clear, close box) are modeless in the original
  (cSimsApp::DoSimsModalDialog(win, false): ChildAdd to cDDDSimsView + TSBeginModal, no modal
  loop, no focus change, the simulation runs). The port ran them modally: the tutorial's "press
  Zoom in" could not be done and Escape never reached the lot view.
  `WinPictureDialog.runModeless`, `objectDialogHooks(ctx, sim, view)`.
- Fixed: simulator global 2 is the zoom (HouseViewer::SetScale -> GlobalDispatch(0xf9) ->
  cSimulator::DoCommand); the tutorial's "detect zoom" waits on it. WinLotView.setScale writes it.
- Verified on lot 7 (Nouvot family): "Bienvenue dans le didacticiel" -> OK -> modeless "Voici une
  vue générale..." with the arrow on the zoom button -> Zoom in -> "Voici le niveau moyen du
  zoom..."; Escape cancels (tutorial object killed, global 26 = 0).
- Not ported: cTutorialIcon (the tutorial dialog's icon / close animation, SetupDialog's +0x3c
  positioning), generic sim call 6 (Neighborhood::RemoveFromFamily of a neighbor, run at the
  tutorial's start) and 4 (logged).

## User-reported bugs, round 2 (2026-10-30)

| # | Bug | Status |
|---|---|---|
| U15 | Chachat family: Gina is invisible (also her head in the pie menu / when clicking something) | fixed: the House56 save has Gina inside the Magic Town clown portal (ClownPortal.iff "Interaction - Go to Magic Town", hidden, object data 34 = 1, until its tree unhides her after the trip). LotPeople.load skipped hidden people, so she never got a VitaBoy (no body, no pie head, bindSim failed) even once unhidden. Hidden people are now dressed and only skipped when drawing (DoStaticToDynamicObjectTransitions lists 3D objects with +0x8e == 0) |
| U16 | 7 avenue des Sims: a second, invisible sim (the original has only one sim there) | fixed: House07 (the tutorial lot) holds Bob and Betty; the Tutorial object's tree 0x1002 hides Betty, calls generic sim call 6 and removes her instance. Call 6 is Neighborhood::RemoveFromFamily (asm 100E96FC; Ghidra dropped it), which was a no-op here: Paulette stayed in the family panel with no body. Now ported (SimModule.removeFromFamily, CPState.removeFamilyMember, NeighborhoodStore saves the member list) |
| U17 | Same lot: the radio that should be on the table is invisible | fixed with U24: the boombox sits in the dining table's slot 1; contained objects are in no tile chain, and as static objects the port never drew them (lamps on tables, microwaves on counters too) |
| U18 | Clicking something with no action (grey cursor) should play a sound | fixed: cObjPickerTool::TryClick with an empty menu (and MenuItemSelected refused) calls cTool::DoDeniedSound: "UI_error" (lbl_105BBE58 + 0x5a), at most once per 400 ms (`WinLotView.doDeniedSound`) |
| U19 | Action queue icons (top left): not as pretty as the original, sometimes broken with invisible objects, no cancel cross | fixed: cActionIcon ported as child windows of the lot view (`world/actionicons.ts`): MakeActionBitmap (source cell, kIconFrame half with its magenta corners cut, yellow ring for a current action once person data 0x27 is set), Product::ComposeBtnImage of the master selector (catalog template + BMP_ / catalog shot) or the people button, dark grey square without a product, kQueueCancelOverlay red cross on cancel, 500 ms slides (StartAnimating) and the picked action starting at the cursor (StartUserAction), tooltips, arrow cursor, left / right click cancel with UI_queue_delete / UI_error (pets refuse), UI_queued per new icon. Actions without an icon object get no icon (ConvertAction) |
| U20 | Clicking the Live mode button a second time: black background where the panel was, instead of the game (the game runs under the panel) | fixed: cWinViewControl::SetMode calls HouseViewer::SetViewportHeight (lot view height - (panel height - 0x32) shown, full height collapsed); the compositor and view rectangle resize (`Compositor.resize`, `HouseViewer.setViewportHeight`), offsets kept so the view grows at the bottom. Bobo vision variant not ported |
| U21 | Many sounds of very bad quality: audio decoding/playback problem? | fixed: the XA decoder read the low nibble first and had no rounding (see "Sound fixes" below); DirectSound pan law |
| U22 | Lots of bird sounds: check against the original's ambience | checked: the fresh engine matches the decomp (2 cells at once by design, sim_amb min = max = 2); the harsh, noisy chirps came from the XA bug |
| U23 | The mailwoman's whistle differs (loops, odd quality) | fixed: XA decoding; ~cXObject / Cleanup now quiet the object's sounds (the looping mailbox_deliver_vox went on after she left) |
| U24 | Objects on other objects (bird cage, phone, anything on a table) are placed inside instead of on top: wrong slot position (Charmant family, probably everywhere) | fixed: cXObject::DrawIso's DrawObjectSlot pass ported (objectdraw.ts): every object slot's content is drawn from the container's RenderParam moved by the slot offset (turned by the container's direction, jump table lbl_105BB9D0) and raised by the slot z (SetHeight: 2.5 / 4 / 4.05), even when the container is hidden. Contained objects left the dynamic list (DoStaticToDynamicObjectTransitions skips objects with a PlacementSpec container), where they were drawn at their own location (the container's, cXObject::SetLocation) at floor height. Objects held by people keep placeHeld. Sim side unchanged: contained objects share the container's location, as in the original |
| U25 | House panel (Habitation): no information filled in | fixed: the panel was ported but CPState.houseStats was never filled. House::GetHouseStats + HouseStats getters ported (`getHouseStats` in `world/housestats.ts`): rooms' area / bed / bath objects (Room::CollectTileStats / CollectObjectStats), Global.iff STR# 505 size and furnishings curves (PiecewiseFn), yard (outside rooms' impact x 2 + good objects and pool tiles, x 0.33), upkeep (FillInObjectStats), layout from HOUS 1's route history. House::AddLayoutTick (cXPerson::Simulate) and its midnight shift are not ported: the layout score stays the saved one |
| U26 | Charmant: walls turn black when switching from Buy/Live to Build mode | fixed: GetCustomWallStyleID (door / window wall sprites) was never wired, so the Build-mode outline pass painted the whole cut stub (see below) |
| U27 | Build mode on level 2: the buildable-floor grid is missing | fixed (see below) |
| U28 | Mode music: switching between non-Live modes (Buy, Build, Camera, Options) cuts the music; only Live <-> others should change it, with a fade | fixed: the Windows cBoxX::Pause leaves MainMusicLoop playing (Options paused it); Live entry is a Kill from Buy / Build / Camera, a slow fade otherwise, as in the original (Windows Sims.exe, re-checked 2026-10-31; the Mac build is identical) |
| U29 | TV sounds very slowed down and low-pitched | fixed: the TV station tracks (TrkTvAction / Mystery / Romance / ComedyCartoon) set pitch 2400 before choosing a clip; the port turned the pitch into a rate relative to the file (2^((2400 - 3600) / 1200) = 0.5), so the 11025 Hz clips played at half speed, an octave down. cSampleChannel::SetPitch gives cTSSnd::SetFrequency an absolute frequency (22050 Hz at 3600, 11025 Hz at 2400), which does nothing until the sound's DirectSound buffer exists (first Play after cSamplePatch::CreateSnd): the clips play at their own 11025 Hz (see "Sound fixes") |

### Sound fixes (U21, U22, U23, U28, U29)

- XA (`crates/audio`): the original cWaveXA (Windows, FUN_005fc013) decodes the **high nibble
  first**, coefficients `{0, 240, 460, 392}` / `{0, 0, -208, -220}`, shift `20 - (h & 15)`,
  rounding `+0x80` before `>> 8`; the header is "XA" + 2 tag bytes, the output size, then a
  WAVEFORMATEX (`wFormatTag` at 0x08, `nChannels` at 0x0a). The decoder read the low nibble
  first (every sample pair swapped: harsh noise on every XA sound), did not round, took the
  channel count from `wFormatTag` and refused `XA\x12\0` (patched in TS before). Stereo XA
  (one file: `sting_crystalball.xa`) has one header byte per channel, then the rows interleaved
  by byte. Output trimmed to the declared size (loops). Checked sample for sample against
  `ffmpeg -f xa` (adpcm_ea_maxis_xa) on 91 random files from every FAR, mono and stereo, all tag
  variants: identical; same through the browser path (WASM -> WAV bytes).
- WAV: all 285 game WAVs are PCM 16-bit 22050 Hz (mono or stereo), no `smpl` loops: the
  browser decodes them as is. No UTK files in TS1. MP3s stream through `<audio>`.
- Pan: cTSSnd::SetPan is a DirectSound pan (`p * 20000 / 1024 - 10000` in 1/100 dB on the far
  side, nothing at the centre). The StereoPannerNode (equal-power: -3 dB at the centre, much
  gentler sides) is replaced by `DSPanner` (samplepatch.ts).
- Pitch (U29): cSampleChannel::SetPitch (Mac 0x103054b0, Windows 0x5802d4) passes an absolute
  frequency, `22050 * 1.0594631^((p - 3600) / 100)` Hz (constants lbl_105BC85C + 8 / + 0x10), to
  cTSSnd::SetFrequency (Mac 0x104db5b0, Windows 0x5f9471: clamp 100..100000, and **nothing** while
  the cTSSnd has no DirectSound buffer, +0x70 / +0x80). The buffer is made by cTSSnd::Load, which
  runs in cTSSnd::Play (or at cSamplePatch::CreateSnd for a Preload patch); the cTSSnd itself is
  made by cSamplePatch::AddRef (first reference, from cTrackPlayer::SetPatch) and freed by Release
  (FreeSnd). note / note_on call UpdateVolPan + SetPitch after cSampleChannel::NoteOn only for a
  streamed patch (register 0x26). The TV station tracks write pitch 2400 (= 11025 Hz) and then the
  patch: in the original the SetPitch at SetPatch hits a sound with no buffer yet and the clip
  plays at its own 11025 Hz (later SetFrequency calls would give 11025 Hz too). The port made the
  pitch a rate relative to the file and applied it after every play: 2^(-1) = 0.5, the clips at
  half speed, an octave down. The Superstar TV channels (ExpansionPack6, also 11025 Hz) keep 3600
  and played right. Now: SamplePatch.addRef / release / sndLoaded / sndFrequency, the rate is
  `(sndFrequency ?? file rate) / file rate` (file rate kept per decoded buffer, `fileSampleRate`,
  since decodeAudioData resamples to the context rate), and the post-note SetPitch is limited to
  streamed patches. MP3s (cTSSndDShow) are never re-pitched. Shipped formats (all FARs and
  folders): XA 22050 mono (17673) / stereo (2), XA 11025 mono (480, TV stations only), WAV PCM16
  22050 mono (44) / stereo (241), MP3 44100 stereo (141). One of each decoded through the browser
  path matches `ffmpeg` in rate, channels, duration and waveform (correlation >= 0.998 at lag 0,
  `~/simsweb-build/scratch/audio2/`). In lot 1, "Films d'action" on the TV: TV_ACTION_MUS5.XA
  buffer 15.42 s (ffprobe 15.418 s, 11025 Hz mono), playbackRate 1 (was 0.5).
- U22: cFreshPlayer::Update / ProbOfCellStarting / UpdatePlayerInfo / SetX/YPos,
  cFreshCellPlayer::Update / UpdatePan, kNotifyChange (ratio < 30 -> 0, x10; hour table / 13)
  and OutdoorTileRatio re-read: the port matches. sim_amb.fsc asks for min = max = 2 cells,
  one add attempt per bar (2 beats at 62 bpm): two sounds most of the time, in the original
  too. Measured on lot 1 (ratio 77, 5 h): 19 sample starts in 60 s, never more than 2 at once.
- U23: the mail carrier's `mailbox_deliver_vox` (MailCarrierF1.iff FWAV) runs
  tkd_generic_fm_smartlists then `loop` (back to the entry: cTrackPlayer::PlayPause sets the
  loop point to it): she sings VOX_sing_happyNPCF1/F3 until her sounds are quieted. ~cXObject
  and cXObject::Cleanup call cSoundPlayer::QuietBySourceID(id); the port did not (simmodule
  killObject, xobject cleanup), so the song went on after she left.
- U28: CPState::UpdateWorldFromCPState calls PauseSounds on every switch to a mode other than
  Live. The Windows cBoxX::Pause (FUN_00574972) exempts track 0x203 (MainMusicLoop) besides the
  UI tracks; the Mac build does not, and the port followed the Mac: Options (mode 7, no music
  change) left the song paused. Checked in headless Chrome: Buy -> Options -> Build -> Live
  keeps one song until Live. Leaving Buy / Build / Camera for Live kills MainMusicLoop at once
  (FUN_005752c4 case 0: vtable +0x38 = cTrackPlayer::Kill, cTSSndDShow::Stop has no fade);
  from Options / the neighborhood it fades (FadeAndKillTrackSlow). That is the original.
  Re-checked 2026-10-31 (user question "Mac or Windows?"): the cut is the Windows behaviour
  (Sims.exe disassembly: case 0/4/9 at 0x575365, previous mode 1/2/0x11/0x12 -> track 0x203
  `call [edx+0x38]`, cTrackPlayer vtable 0x671a74 +0x38 = Kill 0x57e037 -> cSampleChannel::NoteOff
  -> cTSSndDShow::Stop, no fade), identical on the Mac (0x102D916C). Camera is mode 2 (Build) in
  SimsSound.hot, and the bkground_* events are bare kSetMusicMode, so no HIT script fades either.
  The port already matches; no code change (details in audio-port.md, "Back to Live").

### U27: build-mode grid on upper levels (fixed)

- HouseViewer::RenderStaticRow: a tile with no floor on the current level, when that level is not
  1, the mode is build (CPState::GetMode() == 0), the render flag lbl_105BA690 is set (1, a debug
  toggle of the cheat console) and the tile is floorable (flags bit 0, cFixedWorld::ComputeRooms),
  gets cRenderer::DrawGrid at the floor's position. Level 1 has no such grid: its grid is the
  terrain overlay (cTerrain), which floors cover.
- cRenderer::DrawGrid / GridBlit: the shape of the global floor renderer's sprite
  (scale - 1) * 0x100 + 1, frame 0 (floor 1); only its pixel runs count. With r the row, c the
  column and h the sprite height: top edges (r + (c + 1) / 2 == h / 2, r - c / 2 == 1 - h / 2)
  white, bottom edges (== 3h / 2 - 1, == h / 2) and a dot where c & 3 == r & 3 in {0, 2} black;
  raw 16-bit colors (no ambient, no light pool), depth GetTerrainZ + (level - 1) * level step
  plus the floor table (DrawFloor's depth without its +0x41), written where not behind.
- Port: `HouseViewer.drawGrid` / `makeGridFrame` (sprite made once per scale), `isBuildMode`
  set by the lot view. The lot view also redraws when only the mode changes (Buy <-> Build:
  Wall::Draw and the grid read it).
- Checked on Charmant (house 69) in headless Chrome and Firefox: level 2 in build mode shows the
  grid over the house (dotted, white lines), none outside the floorable area, none on level 1,
  none in Live / Buy / Camera; Build L2 -> Camera / Buy drop to level 1 (cWinViewControl's rule)
  without a stale grid.

### U26: black walls on Build mode (fixed)

Reproduced with the user's view: Charmant (house 69), zoom 3, walls **down**, Build mode with the
wall tool (the default) or the hand. Every cut wall holding a window or door (style 0x16 / 0x17)
had its stub painted solid black; Buy / Live were fine. It also shows in the dynamic cutaway
wherever the cursor cuts such a wall (house 1). Measured as near-black pixel counts per frame
(+3400 at zoom 3 on Charmant's front, Build vs Buy).

Cause: Wall::Draw gives a cut door / window wall (flag 8) two passes in Build mode unless the
door or window tool is active (CPState::GetMode == 0 && ArchGetCurrentTool 8 / 9). Pass 0 draws
the wall pattern through the cut style; pass 1 draws the walls.iff colour pattern 0x6fe
(+0x100 per zoom, palette 1790, every pixel index 2 = black) through
GETCUSTOMSTYLE(style, cut): for 0x16 / 0x17 that is GetCustomWallStyleID, the portal's own wall
sprite (cXPortal::GetCustomWallStyleID = OBJD +0xa2, ids id .. id + 2 full, id + 3 .. id + 5 cut,
from the object's sprite file), i.e. the window / door **outline** the original shows on cut walls
in Build mode. `WallManager.customWallStyle` (the GetCustomWallStyleID hook) was never set, so
GETCUSTOMSTYLE fell back to the plain cut wall mask and pass 1 filled the whole stub in black.
DrawWall's blitter is WallBlit (Wall::Draw's last argument is always 0 from WallManager), so pass 1
does overwrite pass 0: the black is right, the mask was wrong. Not a palette issue: the pattern
lists are SPR# version 504 with their own PALT (the spr.ts SPR2 change does not touch them).

Fix:
- `customWallStyleOf` (lotobjects.ts) ports GetCustomWallStyleID: ObjectIterator over the world
  tile, the first cXPortal whose GetRequiredSegment equals the world segment gives its renderer
  (ObjSelector +8) and OBJD +0xa2; installed on the WallManager by the lot view and the
  thumbnail renderer.
- `WallManager.wallToolActive` (CPState::ShouldAlwaysShowWallStuff: Build + door / window tool)
  was never set either; the lot view now follows the tool, so with the door / window tool the
  cut walls skip the outline pass and the hidden wall objects are drawn full height, as in the
  original.

Checked (Chrome headless and Firefox, black-pixel counts per frame and screenshots):
house 69 zoom 3 in Up / Down / Cutaway / Roof x wall tool / window tool / hand, against Buy;
houses 1, 2 and 56 at load zoom in Down / Cutaway / Up x wall tool / door tool. No black stubs;
in Build with walls down or cut, doors and windows show as thin black outlines over the stubs
(the original's look), and the extra dark pixels left in those counts are those outlines.
The tall curtain windows of Charmant stay drawn full height in every mode (no object flag
0x400), as in the user's Buy screenshot.

## User-reported bugs, round 3 (2026-10-31)

| # | Bug | Status |
|---|---|---|
| U30 | When every sim is away at work, time does not switch to the temporary fast speed (x3) as in the original | fixed: cSimulator::Simulate's family-away speed (see below) |
| U31 | Holding the right mouse button and dragging should scroll the view (original), not implemented | fixed: EdgeDetectScroller's right drag (see below) |
| U32 | Chachat: the phone now sits on the table, but clicking it does nothing; you must click under it (the table) to get its actions | fixed: PointToObjectID takes slot contents where they are drawn (see below) |
| U33 | Buy catalog hover price: objects you can't afford must show the price in red | fixed: ProductButton::GetToolTipsWindow (Mac 0x102029f0) calls cDefaultTTWindow::SetColor(1) (red text) when cSimulator::GetFunds < the product's price, else 0; it is the only SetColor caller. The window manager now asks the hovered window for its color (`ToolTipColorSource`, `ui/winmgr.ts`) and ProductButton answers from the funds, for the Buy catalog and the Build catalog (`cpanel/buy/productbutton.ts`). cWinCatalogPopup only draws its red frame around the picture (already ported; the title's price keeps the font color) and cWinDisposePopup has no red. Checked in Chrome (house 6, stairs list): $850 red with funds 500, black with 5000 |
| U34 | Placing stairs fails with "the stairs must connect to floor tiles of the second level" when they should be placeable | fixed: cMoveTool::FixFloorForStairs (Mac 0x1016c980) was not ported. A stair's upper parts are on level 2: the landing (placement flags 0x1) needs a floor, else TestAndPlace fails with 0x29 (UIText STR# 137 "Doit être relié aux carrés au sol du deuxième niveau"); the parts above the steps (0x202) need none. In Float (mode 5), when the stairs do not fit, FixFloorForStairs takes the floor away under parts without bit 0 (TileIsUnfloorable, refund trunc(0.8 x price + 0.5)) and lays the build panel's floor style (CPState::ArchGetCurrentFloorStyle) under level 2 parts without 0x200 (TileIsFloorable: the ComputeRooms floorable flag, so above a room or near a floor; funds >= cost + the stairs' price), then places again; the FloorUndoable is the held object undoable's post sub-undoable, taken back by the next Float (FlushPostSubUndoables), Cancel and Deselect, kept by DropObject; Release ends with GlobalDispatch(0x91, 0) when floors changed (`world/tools/movetool.ts`, TileIsFloorable / TileIsUnfloorable shared from `floortool.ts`). Also WallUndoable's undo / redo now recompute the rooms of both levels (GlobalDispatch(0x91, 0)) so the level 2 floorable flags follow undone walls (`wallundo.ts`). Checked in Chrome (bamboo stairs): house 6 (one storey) 34 valid spots, among them outside against the walls with the landing floored inside on level 2; house 1 inside the rooms; house 2 (two storeys) 344 spots; house 4 (empty lot) none, error 0x29; moving away leaves no floor behind; dropping keeps the landing floor and pays stairs + floor |
| U35 | Cancelling an action adds a "cancel interaction" action to the queue, which the original (Windows) does not show | fixed: the original does queue it but hides it. cXPerson::RemoveAction (Windows FUN_0045d764, Mac 0x10101da0) on the current action: person data 33 = 0, interaction flag 0x100 (the icon's kQueueCancelOverlay red cross), then, unless ShouldInterrupt, Interaction(person, person, 0x21, 50) with its icon object (+0xc) cleared before AddAction; PersonFinder::ConvertAction skips an action without an icon object, so no icon appears. The port queued it with the person as icon object (a people-button icon). A queued action leaves the queue at once (its icon goes, the object's entry point 4 runs). Checked in Chrome (House01): 3 actions, cancel the third (icon gone), cancel the current (red cross, "Annuler interaction" queued with no icon, the sim drops the mailbox and goes on with the next one); one action alone: red cross, then the hidden 0x21 runs and the queue empties (`sim/person.ts`) |
| U36 | The action queue icon has a different cursor on hover than in the original; full cursor audit against the Windows build requested | fixed: cActionIcon::cActionIcon (0x4caa64) sets `GetStandardCursor(4)`, and GetStandardCursor is the same map as GetCursor: id 4 is finger.cur, not the arrow the port's table gave (the neighborhood / town lots in regular mode and the lot tutorial highlight had the same bug). Full audit in `cursors.md`: the cursor files are now decoded at boot (`loadCursors`, PNG + the files' hotspots, edit.cur's XOR I-beam drawn), the root default is the game's arrow, the capture window keeps its cursor, global cursors are forced / unforced (0x20000 on the lot view) and cleared during modal loops, the splash hides the cursor, the pie menu / message box / view control / PIP / magic book / design family / text edit / personality widget / progress dialog set theirs, camera and options modes put the arrow back, SaveGame runs StartWatchCursor, the edge zones show their arrows |

### U30: fast speed while the family is away (fixed)

- cSimulator::Simulate, before the ticks, on a residential lot (Neighborhood::GetZoningType == 1):
  when ObjectModule::IsFamilyMemberAwakeAndVisible is false and the speed is not suspended
  (+0x34, global 18, < 0), the speed is saved in global 18 and SetSpeed(1000) (1 ms per tick,
  above the speed 3 button's 994), then GlobalDispatch(0x109, 1); when a member is back, the
  saved speed comes back, global 18 = -1, GlobalDispatch(0x109, 0).
- IsFamilyMemberAwakeAndVisible: one of the lot's people that is not hidden (+0x8e, object
  data 34: at work / school, in the car), a Sim (person data 65 < 2, not a pet), awake
  (cXPerson::IsSleeping: motive 11 < 0.0) and a resident (person data 0x20 == 0). So the fast
  speed also runs when everyone sleeps.
- cSimulator::SetSpeed while suspended also stores the new speed in global 18: pressing a speed
  button during the fast speed sets that speed at once (CPState::UpdateWorldFromCPState only
  applies CPState's speed when it was set, dirty 0x40) and it is the one restored later.
- cSimsApp::DoCommand(0x109, on): cWinViewControl +0x1bc = on, UpdateSpeedMode(2): speed mode 3,
  the speed 3 button blinks every 500 ms (TSOnTimerMsg) unless speed 3 is the chosen one; the
  chosen speed's button stays lit (UpdateViewFromCPState uses cSimulator::GetSuspendedSpeed).
  A speed button press in Live mode clears +0x1bc (TSOnCommand). On return, mode 0 and the
  speed 3 button is unlit unless chosen (CleanupSpeedMode(3)).
- Port: `Simulator.updateSuspendedSpeed` / `isSuspended` / `getSuspendedSpeed` / `onSuspendChange`,
  `SimModule.isFamilyMemberAwakeAndVisible`, `WinViewControl.simulatorSuspended`,
  `CPState.speedSerial` (the simulator no longer forces the button speed every frame);
  holdSimulator's release only resets the timing (it used to call SetSpeed).
- Checked in Chrome on house 56 (one Sim, four pets): with the Sim hidden (object data 34 = 1,
  what the carpool does) the speed goes to 1000 with global 18 = 760, view control speed mode 3,
  the speed 1 button lit and the speed 3 button blinking; setting speed 2 meanwhile gives 924 at
  once and global 18 = 924; unhidden, the speed is 924 again, global 18 = -1, mode 0, speed 3 unlit.
  A real carpool departure was not observed: running the Chachat day at speed 3 from 8:09 to
  18:29 the Sim never left for work (to recheck on a lot with a working adult).
- Note: at load, the family members brought in by the lot (bringInFamily) are hidden for a moment,
  so the fast speed starts and stops within the first frames, as the same check would do in the
  original.

### U31: right-button drag scrolling (fixed)

cDDDSimsView's mouse handlers forward to its ScrollingStrategy (EdgeDetectScroller, vtable
+0x10 move, +0x20 / +0x24 right down / up):
- OnMouseDownR (capture): in Live mode a press on a person of the selected person's family
  (person data 0x3d) who is not a guest (person data 77 < 1), except on houses 21..30, selects
  them (CPState::SetSelectedPerson) and the release does nothing (state 2). Otherwise, without
  Shift, the press waits for a drag (+0x45, point +0x4c / +0x50).
- OnMouseMove: more than 8 pixels (+0x48) from the press on either axis starts the drag (+0x44):
  cDDDSimsView::SetAnchorPoint shows kExploreAnchor (4000) centered on the press point (drawn by
  TSPaint), cursor EXPLORE (0x19), StartScrolling. While dragging the velocity is 5 x (anchor -
  cursor) px/s (+0x5c = lbl_105BC0EC[8]), no ramp and no clamp (those are the edge zones'), and
  the cursor is Classify(v): DEADEXPL (0x1a) below 100 px/s, else the 8 arrows (0x11..0x18) with
  +-15 degree sectors around the axes. The edge zones are not checked while dragging.
- PreDraw moves the offsets by 0.5 + 0.001 x dt x v (dt capped at 100 ms), like the edge scroll.
- OnMouseUpR: a drag ends (StopScrolling: anchor released, global cursor cleared); a click that
  never dragged, with the left button up, is CenterView (as before). The capture is released.
- The cursors are SetGlobalCursor(..., 0) (not forced). cWinPeople::StopTracking /
  Animator::SetTrackedObject are not ported (no tracking camera yet).
- The neighborhood view has no right-button handler in the original (only cDDDSimsView,
  cTSPieMenu, cActionIcon, cWinRelationship...): nothing to port there.
- The pie menu takes the right button itself while open (cTSPieMenu), so it does not reach the view.
- Checked in Chrome on house 56: press at (500, 300), 5 px: no drag; 40 px right: drag, RIGHT
  cursor, the view scrolls ~200 px/s; up-left: UPLEFT cursor; release: drag off, cursor back;
  a right click without drag still centers. The anchor shows at the press point.

### U32: picking objects in slots (fixed)

HouseViewer::PointToObjectID walks the tile with ObjectIterator: the tile's object, then the
hierarchy depth first (slot 0 is the next object on the tile, slots 1.. the contents), and keeps
the last object whose GetLastDamage rectangle holds the point. The rectangle of an object in a
slot is where its container's DrawIso drew it (DrawObjectSlot: the container's position moved by
the slot offset, turned by the container's direction, raised by the slot's z), with its own
sprites. The port took the contained object's own location (the container's floor position), so
the phone's rectangle was on the floor under the table. `picking.ts` now walks the tile with the
drawing position (`tileObjectsDrawn`). The Live-mode leader rule (cXObject::GetInteractionLeader,
multi-tile groups) was already in place; cObjPickerTool tests the picked object itself, so the
phone on the table gives the phone's menu.
Checked in Chrome on house 56 (walls down, rotated, zoom 3): hovering the phone hilites it (id
11) and a click shows its pie (Services..., Appeler voisin, Appeler taxi..., Inviter à soirée);
the French lamp on the gift shop table (301), the kitchen sink in its counter (276), the wand
charger, the bird cage are picked over their tables (a screen scan of PointToObjectID). The lot
has no microwave on a counter; the sink in the counter is the same case.

