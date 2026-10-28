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

## Remaining problems

| Problem | Suspected cause |
|---|---|
| Taxi never comes after "Appeler taxi..." | "Auto Call Cab" (Phone tree 8221) runs; its four Set To Next by GUID searches (nodes 20 / 21 / 39 / 43: GUIDs 0xa6f31853, 0xaba9df4a, 0xeaa79d86, 0xc61f8102) find nothing, then semi-global calls 320 / 424 / 469 / 479 / 492. Lot 9 lacks the objects House01 has (the "Help System - Downtown" family of controller objects). The original must add them to lots that predate the expansion (not found yet in the decomp); a taxi to Downtown and back could not be tested from lot 9 |
| A sim stays stuck on the outer tile of the front door (24, 28) and keeps retrying the toilet | Routing / portal (door) issue. `sim/routing.ts` was owned by another agent during the session and not touched |
| No NPC was seen (welcome wagon, paperboy, mail carrier); "Bills" objects stay out of the world (-1, -1) and the mailbox offers no interaction | The mailbox creates the bills (prim 42) but nobody delivers them. Probably the same missing controller objects as the taxi, or unported values (`scope 23 room[temp0]` 231 hits, `prim 20 functional tree 8 (person)` 307 hits, `scope 24 neighbor data 9` = Family::GetFriendCount). Bill payment could not be tested |
| "Social Tease 1.4", "Social Talk 1.4"... objects pile up (dozens) | The social interaction objects are not deleted when an interaction ends (likely an early return before their kill, or an interaction abort path) |
| Trash piles multiply, also outside the house | No trash can on the lot, but the amount and the spread outside look wrong; not investigated |
| The salary after the carpool returns was not confirmed | Funds rose by $730 during the first workday; the return at 15:00 was not observed (save / reload in between) |
| Catalog "?" for some doors / chairs | Missing catalog icons (BMP_ lookup), not investigated |
| Wall price $75 per segment looks high | Not checked against the original |
| Object dialog pictures: person pictures (PersonFinder::GetPictureBuffer) and mode 4 ("bmp" / "guid" / "rel" / "job" strings, e.g. the job popup composite) are not drawn | Not ported (`world/objectdialogshow.ts`, `sim/objectdialog.ts`) |
| Dialog kinds 6, 8, 9, 0xc, 0xe, 0xf (magic book, neighbor pickers, ...) answer true | Not ported (counted as unported prim 36) |
| Not ported tokens: $TokenNameLocal, $FameTitleLocal, $Grade | Need SimInventory tokens' selectors, cFameTrack, cJob::GetGrade |
| Speed 3 is about 90 s per sim day | To compare with the original |

## Dev notes

- The dialogs queued during a tick are shown after it (microtask); the simulator is held from
  the first `show` until the queue is empty. Kind 0xa waits (instead of answering false) while
  the phone book is still up, because the web dialog is asynchronous.
- Automated tests that load a lot with "Help System" objects (House01) must dismiss the
  dialogs (Enter), otherwise the simulation stays paused, as in the original.
