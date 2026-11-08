# Audit du 2026-11 : constats « faibles, non vérifiés »

L'audit complet du port contre le code décompilé (novembre 2026) a classé 86 écarts confirmés, tous
traités ou portés depuis (journal de `PLAN.md`, 2026-11-08), et 137 constats de faible gravité qu'aucun
vérificateur n'a relus. Ils sont listés ici tels que l'audit les a écrits : chacun reste à confirmer
contre le décompilé avant d'être corrigé (certains peuvent être faux). Les numéros sont ceux de la
liste de l'audit. Un constat corrigé est retiré d'ici et noté dans le journal.

Première partie (#0 à #52) vérifiée le 2026-11-08 : les écarts réels sont corrigés et retirés, avec
#57 (doublon de #30). Ceux qui restent de cette partie portent une ligne « vérifié » : écart voulu,
incertain, ou réel mais laissé de côté (raison donnée).

## vm-core

- **#2** BCON user overrides are never applied (Behavior::GetConstants with the override flag)
  - Original : Behavior::GetConstants 0x10036f90: when the BCON flag bit 0x8000 is set and the caller passes true, it uses ObjResFile::GetOverride(id) in place of the file's constants. cTreeConstants::Load 0x10146610 does the same.
  - Port : client/src/game/sim/behavior.ts:getConstants, whose comment says the user override is not ported.
  - vérifié 2026-11-08 : écart voulu. L'override vient d'un tableur de réglage lu par ObjectFolder, absent des données du jeu (toujours vide).

## xobject-expr

- **#4** Writing person data 0x44 / 0x4a / 0x54 does not dirty head thumbnails (ObjSelector::SetHeadTextureDirty + CPState 0x20000000)
  - Original : InterpValue scopes 18/19/30/31 when the address is requested (0x100e4f14, 0x100e55a8, 0x100e50e4, 0x100e52dc): for person data 68, 74 and 84 (jump table 0x10601744 → sub_100e4fe8) it calls ObjSelector::SetHeadTextureDirty(this->selector, 1) (0x100f9ad0 → …
  - Port : client/src/game/sim/xobject.ts personData() (~line 648): only data 0x4d and 0x51 trigger follow-ups. 68, 74 and 84 are written with no thumbnail or CPState refresh. Nothing like 'dirty thumbnails' or …
  - vérifié 2026-11-08 : incertain. Le port n'a pas de cache de vignettes indexé sur ces champs ; effet visible probablement nul.
- **#5** Scope 38 (neighbor's OBJD) does not raise error 0x37 when the neighbor has no selector, and returns 0 when its object file is not loaded
  - Original : InterpValue scope 38 (0x100e64a4): FindNeighborByID(stackObj) → error 0x37 if missing; data range [0,0x6c) → error 0x23; then `if (neighbor+8 == NULL) error 0x37`; it reads halfword[data] from the selector's OBJD (+0x60).
  - Port : client/src/game/sim/xobject.ts:~625 (case 38): `m.worldHooks?.selector(nb.guid)` returns 0 when the selector is undefined. The comment notes that async loading makes this 0 meanwhile.
  - vérifié 2026-11-08 : écart voulu. Les erreurs 0x37 / 0x23 sont levées ; seul le 0 pendant le chargement asynchrone du fichier objet diffère (commenté dans le code).
- **#6** Behavior::GetConstants override (flag 0x8000 BCON → ObjResFile::GetOverride) not applied for scope 26
  - Original : InterpValue scope 26 (0x100e4a94) calls Behavior::GetConstants(id, true) (0x10036f90). If the BCON's first short has bit 0x8000 set and an ObjResFile BCONOverride exists (filled by ObjectFolder from a tuning spreadsheet, SetOverride 0x100f6810), the override …
  - Port : client/src/game/sim/behavior.ts:311-317 getConstants(): 'The user override of flagged BCONs is not ported', always the file's constants. xobject.ts:557 case 26 reads them.
  - vérifié 2026-11-08 : écart voulu, même cause que #2.

## xobject-prims-a

- **#12** Neighborhood::Save after call 19 / 20 is not done
  - Original : TryGenericSimCall entries 19 / 20 (0x100ea1dc / 0x100ea320): after RemoveTokenByIndex(idx, 1) the neighborhood file is saved (Neighborhood::Save).
  - Port : client/src/game/sim/lotcalls.ts:93-95 and the file header: the token removal is kept in memory only.
  - vérifié 2026-11-08 : écart voulu, documenté en tête de sim/lotcalls.ts (les inventaires restent en mémoire).

## xobject-prims-b

- **#16** Person created by Create New Object Instance never gets a neighbor (LoadInterestData / AddNewNeighbor)
  - Original : cXObject::TryCreateObject 100eca90 tail 100ed0e4: for a person object calls Neighborhood::LoadInterestData 100abbf0: finds the neighbor with the same selector; if none, AddNewNeighbor and store the id in person +0x5ca (person data 0x1f); else copies the …
  - Port : client/src/game/sim/xobject.ts:2218-2335 does not. SimModule.initPerson (sim/simmodule.ts:649-657) only loads a neighbor that already matches the GUID; otherwise person data 0x1f stays 0. …
  - vérifié 2026-11-08 : réel. Demande la persistance d'AddNewNeighbor, à faire avec le reste de la gestion des voisins.

## xobject-dialog-text

- **#22** Dialog operand flag bit 0 (result ignored) with kinds 5/7/8/0xb/0xd makes a generic dialog, not the town window
  - Original : ObjectModule::EnqueueObjectDialog(cXObject*, StackElem*, DialogParam*) (100da970) dispatches on kind: 5 cWinDowntown, 8 cWinNeighborhoodUL/VC, 7 cWinVacation, 0xb cWinStudiotown, 0xd cWinMagicland, otherwise ObjectDialog. TryDialog calls it for these kinds …
  - Port : client/src/game/sim/xobject.ts:1704-1707: `if (op[7] & 1) { m.enqueueObjectDialog(this, elem, op); return PRIM_TRUE }` before looking at the kind. simmodule.ts:529 always builds an ObjectDialog.
  - vérifié 2026-11-08 : réel, mais aucun objet du jeu (tous les FAR et IFF) n'emploie le bit 0 avec ces genres : laissé tel quel.

## xobject-lifecycle

- **#33** UpdateComeSeeMeObjects and GetAgeInMinutes have no port
  - Original : UpdateComeSeeMeObjects 100577c0 runs when CPState enters Live mode (CPState.c:1761). For type-4 in-world lead objects in certain zone ids it uses cXObject::GetAgeInMinutes 100bb1d0 == 0 and GetComeSeeMe to create a 'comeandsee' out-of-world object and set the …
  - Port : cpstate.ts:16 mentions the hook but registers nothing. No getAgeInMinutes exists. ui/cheat.ts only removes the 'comeandsee' objects.
  - vérifié 2026-11-08 : réel. Fonction entière à porter (objets « come and see me » à l'entrée en mode Vivre).

## xperson-actions

- **#34** Current action and queue are not restored on load, and the saved tail is stale
  - Original : cXPerson::ReconStream with Interaction::DoStream (Mac 0x10093670): current (+0xa08), last (+0xa44) and the queue (+0x820, up to 8 interactions) are written from live state and rebuilt on load.
  - Port : client/src/game/world/housesave.ts:607-613 writePerson writes `t?.current / last / queue` (the tail read when the lot was loaded), not the live PersonSim. client/src/game/sim/person.ts:243-245 …
  - vérifié 2026-11-08 : écart voulu, documenté dans docs/decomp/save-port.md (la file d'actions relue n'est pas rechargée).

## xperson-motives

- **#40** GViewer::SetHeadFee (floating fee / magic-coin / ticket text over the head) is not ported
  - Original : cXPerson::Simulate (10103160): if person data 1 (+0x58e) != 0, it calls GViewer::SetHeadFee (101b5e30) and clears it. SetHeadFee draws DrawHeadMagicTokens, DrawHeadTickets (and plays a sound) or DrawHeadText, depending on ranges of the value.
  - Port : sim/person.ts:323-324 comment: head text and head fee not ported. pd[1] is never consumed or cleared in simulate().
  - vérifié 2026-11-08 : en partie corrigé. Person data 1 est remis à 0 après chaque tick (comme l'original) ; le texte flottant au-dessus de la tête n'est pas dessiné.

## xperson-route

- **#52** TryChangeLots does not set the current family to family 0 when going home
  - Original : TryChangeLots (10107120), house == -1 branch: `**(app+0x10) = Neighborhood::GetFamily(nbhd, 0)` before the family lookup. This sets the app's current family to family 0, the downtown family.
  - Port : transit.ts tryChangeLots (~285-296) only reads store.family(familyId). No current-family pointer is changed.
  - vérifié 2026-11-08 : incertain. Le pointeur de famille courante est bien écrit par l'original, mais le port ne l'utilise pas de la même façon.

## routing

- **#53** ChooseStartingPoint tests candidate start tiles without the wall test
  - Original : XRoute::ChooseStartingPoint 10163d40. The call to EvalTileForGoal (asm 10163E9C) still has r5 = (k + chair.dir) & 7 from 10163E14, so the third argument is the direction. EvalTileForGoal therefore runs its wall-block tests (GetWallBlockFlagsAtTile with dir+4, …
  - Port : routing.ts:539: `this.evalTileForGoal(fx, fy, -1)` (dir -1 skips the wall test). The direction `d` is computed on line 534 but not passed.
- **#54** Port resets route result to 0 on a successful single-goal construction; original leaves it
  - Original : XRoute::ConstructGoals 10162d80, no-direction branch. On result 6 it inserts the goal and branches to the epilogue (asm 10162FF0..10163038 -> lbl_10163CF8) without writing +0x88. The result field is only written on failure paths.
  - Port : routing.ts:600 `this.result = 0;` on success.
- **#55** BuildGoalList large-room test counts tiles, not Room::GetArea
  - Original : XRoute::BuildGoalList 10165980: `Room::GetArea(room) > 0xfa` sets +0x98 (max goals) to 8. GetArea is half-tile accounting (diagonal-wall tiles count half, per roomStats).
  - Port : routing.ts:556-563 counts every tile of the room (`rooms.u16 === room`) and compares with 0xfa, instead of using roomStats().area as findPath does.

## space-rooms

- **#56** BeginningPortalTree numbers the new mark against portals in the portal's room, not the person's room
  - Original : cXPortal::BeginningPortalTree 10112b20. The loop that computes the next mark compares `*(short*)(param_2+0x84) == *(short*)(portal_q+0x84)`, where param_2 is the person. Only portals in the PERSON's room that already hold a mark 1001..1100 raise the new mark …
  - Port : client/src/game/sim/portals.ts:206 `if (room(q) !== room(portal)) continue;` compares against the portal's own room.
- **#58** Room ambient light and score are NaN instead of 0 / -100 when a room's half-area is 0
  - Original : Room::ComputeRoom 1011d940. With half = area/2 = 0 (a room of one diagonal half tile, +0x38 == 1), `window/100/half` is 0/0 = NaN in float. `if (fVar2 < fVar1)` is false and the NaN is kept. The test `if (0.01 <= d) {...} else d = 0.0` then falls into the …
  - Port : client/src/game/world/lighting.ts:466-470 `Math.min(k, NaN)` is NaN, and `d < 0.01` / `d > 0.99` are both false, so l.ambient stays NaN. roomAmbient() hands NaN to the renderer and to roomInfo. …
- **#59** FindPath refuses to route when the person's level differs from the room's level, and when the room has no tile found
  - Original : XRoute::FindPath 10164300. After comparing rooms it only asks RoomManager::GetRoom(person room). A null Room drops the goal and returns 0. A Room that exists is used as is: BuildRoomPartition builds from the room id's own level, and the room's recorded size …
  - Port : client/src/game/sim/routing.ts:~795 `me.level !== level` and `stats.tiles === 0` each call dropCurrentGoal() and return false (result left at its previous value).
- **#60** roomStats approximates the area of diagonal (0xfffb) tiles from neighbours instead of counting each room's tile list
  - Original : Room::CollectTileStats 1011d390 adds exactly 1 to +0x38 for each diagonal-split tile in the room's own tile list, once per room. Room::GetArea = +0x38/2. That area feeds XRoute::FindPath (limit-size test area > 99, density, budget goals*area+50, the …
  - Port : client/src/game/sim/spacepartition.ts:929-933 counts a 0xfffb tile as +1 for each of the left and right neighbours equal to the room. This is a heuristic that can add 0 or 2 instead of 1, e.g. when …

## module-folder

- **#61** Kill queue is processed even when the tick did not advance (paused / build / buy mode)
  - Original : ObjectModule::PostSim(param_2 = !advanced) (100dd040): the kill-queue drain (`while (+0x5c != 0) ... KillOutOfWorldObject`) sits inside `if (param_2 == 0)`, so it only runs when TickAllObjects returned true (time advanced).
  - Port : sim/simulator.ts:668 calls `this.module.runKillQueue()` unconditionally, including when `advanced` is false.
- **#62** AddToKillQueue does not pick the object up out of the world at queue time
  - Original : ObjectModule::AddToKillQueue (100dc3c0) calls vtable +0x58 (Pickup, arg 1) on the object (or its multi-tile lead) at once, clears or sets flag 0x1000 on +0x114, and only then queues the id. The world part is therefore already done when the queue is drained.
  - Port : sim/simmodule.ts:1019-1031 only records `{id, flag}` and sets `keepRecordObjects`. The comment says Pickup(1) is left to KillObject's world part.
- **#63** Module object list order differs: new objects go to the head in the original, by id in the port
  - Original : ObjectModule::AddObject (100dbb40) with param_4 == 0 (MakeNewOutOfWorldObject, cXCursorObject, cXObjectStream) links the new object at the head of the +0x30 list (`next = head; head = obj`). Only the stream load path (DoStream, param_4 = 1) appends at the …
  - Port : sim/simmodule.ts:574-578 (addObject) inserts runtime objects in id order ('The list stays in object id order'), and nextInList / list[0] (xobject.ts:2968-2982) follow it.
- **#64** Set To Next 'object on the same tile' ignores the tile hierarchy order
  - Original : ObjectIterator (House, tile) (100d63b0) starts at the tile's head object and ObjectIterator::operator++ (100d6240) walks its slot hierarchy via HierGetChild, depth first. This is how tile object lists are walked everywhere else (the port's own sim/routing.ts …
  - Port : sim/xobject.ts:2959-2968 (Set To Next kind 8) builds `here` with `m.list.filter(tileX/tileY/level)` in module list order and wraps.
- **#65** MakeNewOutOfWorldObject calls Reset(1) (with a tick); the port resets without the tick
  - Original : ObjectModule::MakeNewOutOfWorldObject (100de1b0) calls vtable +0x48 with 1 (cXObject::Reset(tick = 1)) after AddObject. That runs Init and then one simulate() of the new object, before sim flag 0x10000 is set. The multi-tile path calls Reset(1) on the last …
  - Port : sim/simmodule.ts:584 (addObject with runInit) calls `o.reset(false)`, and resetPart(false) for parts. finishReset(tick) only simulates when tick is true (sim/xobject.ts:296).
- **#66** No clamp of one frame's elapsed time to 2000 ms (TimeBase_Sims)
  - Original : TimeBase_Sims::SetNow (10145e00), run by cTSFrameWork::OnIdle each frame, advances the game clock by at most +0x14 = 2000 ms and folds the excess into an offset. cSimulator::Simulate reads this clock (lbl_105BA230) to accumulate time.
  - Port : Simulator.simulate(nowMs) (sim/simulator.ts:612-630) adds the raw `nowMs - lastMs`, capped only by MAX_PULSES = 30 and then `accumulated = 0`.
- **#67** Pet persons are created without the pets-pack check
  - Original : ObjectModule::MakeNewOutOfWorldObject (100de1b0): for a person whose body-string 1 (skeleton) is "dog" or "kat", when app +0x66 has neither bit 0x20 nor 0x80, it returns 0 and creates nothing. ObjectModule::DoStream (100dede0) also swaps the dog and cat …
  - Port : world/tools/objectfactory.ts:119-160 (makeNewOutOfWorldObject) has no such gate. Only getPlaceholders (world/objectfolder.ts) handles dog/cat without the pack, for loading.

## careers-nbhd-data

- **#68** Generic sim calls 34 / 36 (Promote / DemoteIfNeeded) do not run ObjectModule::OnStarPowerChange
  - Original : TryGenericSimCall entries 34 and 36 (asm ObjectSim.s 100EAE18 and 100EAED8): after cFameTrack::PromoteIfNeeded / DemoteIfNeeded they always call ObjectModule::OnStarPowerChange(person) (100d7670), which places or removes the star plumb bob when fame level > 9.
  - Port : sim/xobject.ts:1321-1338 calls promoteIfNeeded / demoteIfNeeded, which write pd[0x51] directly. The comment says OnStarPowerChange is 'not ported', but world/plumbbobs.ts:283 implements it, driven by …
- **#69** Persistent-data save in the simulator does not set the neighbor's data version to 9
  - Original : Neighborhood::SavePersistentData (Mac 100ab970) and SaveAllPersistentDataForMatterTransferance set Neighbor +0x18 = GetLatestPersDataVersion() (9) before copying the fields. LoadPersistentData (100abd30) only copies fields whose minimum version is <= that …
  - Port : sim/simmodule.ts:665 savePersistentData copies the fields into nb.personData but leaves nb.version (+0x18) unchanged; only the NeighborhoodStore copy gets pdVersion = 9 at save. sim/person.ts:302 …
- **#70** Job subpanel friends-needed uses the selected person's family friend count on community lots; the original always uses the lot's house family
  - Original : cWinSubpanelJob::SetFriendsNeeded (Mac 10298e90) and PersonFinder::GetFriendsNeededToAdvance (10236df0) call Family::GetFriendCount(House +0x10), the family the lot was loaded with (family 0 on community / town lots, so 0 friends).
  - Port : cpanel/live/job.ts friendsNeeded / setFriendsNeeded use ctx.state.getFamilyFriendCount(), which is SimModule.cpFamilyFriendCount: on non-residential lots it uses the selected person's own family (pd …
- **#71** TryChangeLots family branch writes nothing when the family cannot be found
  - Original : cXPerson::TryChangeLots (Mac 10107120): mode 1 sets iVar12 = Neighborhood::GetFamily(person +0x606); only a non-null family goes through the member loop; if GetFamily returns 0 the person's own tokens are written (iVar12 == 0 branch).
  - Port : nbhd/transit.ts:300 `family = store.family(familyId)?.memberGuids ?? []`; an empty array is truthy, so `if (!family)` is false and neither the own nor any member tokens are written (and the arrival …
- **#72** Neighborhood::LoadPersistentData's AddNewNeighbor for people without a neighbor is not ported
  - Original : Neighborhood::LoadPersistentData / LoadInterestData (Mac 100abd30 / 100abbf0): when no Neighbor has the person's GUID, AddNewNeighbor(selector) creates one and the person's +0x5ca (person data 0x1f, neighbor id) is set to it.
  - Port : sim/simmodule.ts:650 initPerson does `if (nb) p.loadPersistentData(nb)` and does nothing otherwise.
- **#73** Read-side Family parser (data/neighborhood.ts parseFami) mishandles pre-version-7 flag bits
  - Original : Family::DoStream (Mac 1006d710): for version < 3 flags |= 1; for version > 5 the second bool first clears bit 1 (`& ~2`) and then sets it from the stream.
  - Port : data/neighborhood.ts:160-168 starts flags at 0 (no |=1 for v<3) and ORs bit 1 for v>5 without clearing. data/nbhdstore.ts parseFamily has the correct logic; the two readers disagree.

## anim

- **#75** No 'missing animation tree' fallback when the background or carry skill cannot be started
  - Original : TryAnimate 10356c40, flag-1-only branch (background, +0x14) and flag-0x10-only branch (carry, +0x134): if StartSkill returns 0 it calls cXObject::RunTree(person, 'missing animation tree' entry, ...), the same as for the main practice.
  - Port : client/src/game/sim/person.ts:~795-815 only does `skill ? a.start(slot, skill, backwards) : null` for the background and carry slots. startMissingAnimation (:~871) is used only for main.
- **#76** The 'discontinuity' time prop stops the carry practice; the original only clears the fading practice
  - Original : HandleVitaBoyAnimEvent 1034ca10, 'discontinuity': `if (param_1[4] != 0) { VitaBoy::StopPractice(vitaboy); param_1[4] = 0; param_1[0x66] = 1; }`. +0x10 is the fading practice that StopAnimation keeps while the cross-fade flag lbl_105BADB8 is set. That flag is …
  - Port : client/src/game/sim/personanim.ts:581-583 `case "discontinuity": if (this.carry) this.carry = null;`
- **#77** Practices and time props ignore the per-bone priority gate of Practice::Apply
  - Original : Skeleton::UpdatePriorities 1035ec90 sorts practices by priority and writes the highest priority onto each bone it touches (Practice::UpdatePriority 10362970). Practice::Apply 10361960 skips an association when `bone.priority (+0x58) > practice.priority …
  - Port : client/src/game/sim/practice.ts:60-120 applies every association. client/src/game/sim/personanim.ts:549-552 Track.advance fires all of a motion's time props whatever the bone priority. Order is …
- **#78** UpdateBackgroundPractice: other sit values, the OBJD +0xcc bit 2 skip and the pet restart differ
  - Original : SAnimator::UpdateBackgroundPractice 1034e440 starts the background loop only if OBJD +0xcc bit 2 is clear. It maps person data 0 = 1 to std skill 1, 2 to std 2 and 0 to std 3; any other value (including -1) starts nothing. It starts the skill when there is …
  - Port : client/src/game/sim/personanim.ts:800-810 uses idx = sit === 1 ? sitLoop : sit === 2 ? floorSitLoop : standingLoop. Any other value starts the standing loop. The objdFlags bit-2 test is not applied.
- **#79** The 'anchor' time prop is not handled
  - Original : HandleVitaBoyAnimEvent 1034ca10, 'anchor': sets practice +0x70 = 0 and, for the main practice, practice +0x6c = bone and SAnimator +0x24 / +0x28. These are read by a foot-plant displacement block in the Tick states 6, 8, 9 and 10 (sub_1034F24C). That block …
  - Port : client/src/game/sim/personanim.ts handleProps has no 'anchor' case. The 'anchor' tags are used only by FindTagTime for the walk-loop foot phases (:94-103).

## sim-3d

- **#80** Room lamps do not light sims
  - Original : LightingRig::EngageLights (101d3650). After orienting the rig lights, it looks up the room at the sim's tile (ambient value < 0xfffb). For each of the room's lamp lights within the squared-distance cutoff it computes a falloff intensity, calls …
  - Port : client/src/game/sims/lighting.ts:87-93 (engageLights) builds only the stdlight directional light plus ambient. The file header says "Room lamps (point lights within 20 units) are not modelled". …
- **#81** Texture key is matched against the mesh's own name, not the Skin's mesh name
  - Original : DeformableMesh::Bind (1035bfe0). The "KEY=tex" spec's KEY is searched in *(this+8)+8. This+8 is the Skin* set by SetSkin, and Skin+8 is the mesh name read by Skin::ReadFromFile as its second string, i.e. the name the suit refers to. Without a match the mesh's …
  - Port : client/src/game/sims/deformablemesh.ts:136 uses `this.name.includes(key)`, which is the name stored in the .skn/.bmf header (read at :46 / :88). The Skin.meshName from the suit is not passed to …
- **#82** Portrait heads only dress body strings 2 and 3 and ignore the person's live HEAD bindings
  - Original : MakePersonHeadImage (10232a10) calls SAnimator::UpdateOutfitAndHands(1), then GetHeadBindings (10232720). It collects every skeleton binding of the person's live dressing records whose bone is "HEAD", including the head suit, the body suit chosen by the …
  - Port : client/src/game/cas/portraits.ts:150-172 (headPerson) builds a fresh VitaBoy from the raw body strings. It reads only BS.head (3) and BS.body (2), skips meshes whose boneName is not HEAD, and ignores …

## lotview

- **#83** HouseViewer::MouseTrack does not update the dynamic cutaway while the left button is held
  - Original : HouseViewer::MouseTrack 101c7480: the room search and cCutawaySet::insert are done only when param_3 == 0 and +0x49 is set. EdgeDetectScroller::OnMouseMove passes param_3 = GetKeyState(VK_LBUTTON) >> 31, so a held left button skips it.
  - Port : cutaway.ts:203-224 mouseTrack has no button test. winlotview.ts:2372-2379 calls it on every move, including while this.buttonDown (the left button) is held.
- **#84** Zoom and rotation during a smooth scroll ignore the scroll's destination
  - Original : HouseViewer::SetScale 101ce8f0 and SetRotation 101ce3a0: if the scroll flag is set (+0x17a), the origin is XSmoothScroller::GetEndX/GetEndY (the destination). The scroll is stopped and SetOffsets(end) is applied before the centermost tile is computed.
  - Port : houseviewer.ts:732-762 setScale and setRotation compute centerFixed() from the current, mid-scroll origin, then set this.scroll = null.
- **#85** ScrollToTile has no lot-bounds test
  - Original : HouseViewer::ScrollToTile 101cee00: if the tile (x>>4, y>>4) lies outside [+0x70..+0x74] x [+0x78..+0x7c] (the lot extent), or +0x68 is 0, nothing is scrolled. Only the level change is done.
  - Port : houseviewer.ts:666-676 scrollToTile always scrolls. Clamping comes only later from getOffsetsMinMax.
- **#86** Arrow-key scrolling ignores EdgeDetectScroller's guards (Shift/Ctrl, scroll state, key-held lock)
  - Original : EdgeDetectScroller::OnKeyDown 102123e0 (arrows 0x25-0x28): only acts when Shift and Ctrl are not down and state +4 != 1 (not already scrolling). It calls cWinPeople::StopTracking, sets +0x92 (arrow held), then AsyncScroll. While +0x92 is set, OnMouseDownL and …
  - Port : winlotview.ts:2323-2338: stopTracking() is called for any Arrow key, and asyncScroll fires with no Shift/Ctrl or state-1 test. There is no +0x92 lock on mouse presses (edgescroll.ts has no such …
- **#87** Go Here destination fraction ignores tile altitude
  - Original : HouseViewer::PointToTile(pt, true) 101cac70 (used by XViewer::MouseDown 1014eb80 to get the FTilePt handed to cObjPickerTool::TryClick): it interpolates the position inside the tile from the packed corner altitudes (cRotatableWorld::GetPackedAlt) and the …
  - Port : winlotview.ts:1261-1290 makeGoHereHelper solves the fraction with a flat-tile affine inverse of tileToPoint, which has no altitude term. The comment calls it 'GViewer::PointToTile(pt, true)'.

## draw

- **#88** Object flags +0x114 bit 4 (luminous) and bit 3 (dehilite) not honoured by DrawIso
  - Original : cXObject::DrawIso (100c6f70): per item, if (+0x114 & 1) Hilite=1 else 0; if !(+0x114 & 8) RenderParam +0x36 (DeHilite) = 0; if (+0x114 & 0x10) RenderParam +0x34 (Luminous) = 1. cMoveTool::UpdateHilite (cMoveTool.c:2619) sets SetHilite(... | 0x11), i.e. hilite …
  - Port : world/objectdraw.ts:173-175 only reads hiliteFlags & 1. The move tool's setHiliteId(id, 0x11) (tools/movetool.ts:624) stores bit 4, but the draw ignores it.
- **#89** Pool equipment (OBJD build mode type 7) not drawn at forced ambient level
  - Original : cXObject::DrawIso (100c6f70, asm 100C7308): if ObjSelector::GetMasterSelector(...)->OBJD +0x8a == 7 then RenderParam::SetAmbientLightLevel(1.0) (clamped to the 1.0 day / 0.8 night maximum) before drawing the item. 1.0 is read from lbl_105BB9EC +8 (mac.bin …
  - Port : world/objectdraw.ts:167-195 has no buildModeType === 7 case (the constant exists only in tools/pooltool.ts:67). The only forced-ambient case is fullBright.
- **#90** DrawIso draws the draw group even when OBJD +6 (base graphic) is 0
  - Original : cXObject::DrawIso (100c6f70): the whole draw group block is guarded by (+0x8e == 0 && *(short*)(OBJD + 6) != 0). OBJD +6 is baseGraphic in the port's ObjDefinition.
  - Port : world/objectdraw.ts:117 (drawIso) tests only hidden === 0. objselector.ts getDrawGroup(graphic) would load DGRP id 0 + graphic.
- **#91** Objects held in a person's slots 3, 4 and 5 are not placed at the registration points
  - Original : cXPerson::DrawIso (Mac 10107ae0): for object slots 1, 3, 4 and 5 of a person it calls SAnimator::PrepReg with registration 0, 3, 1 and 0 respectively, then draws the held object's DrawIso at that point. Nothing is drawn if PrepReg fails. The whole block is …
  - Port : world/winlotview.ts:867-882 placeHeld handles only obj.slotHierNumber === 1 and registration 0 (lotpeople.registrationPoint supports only slots 0 and 1). Other slots fall back to rp.setGridCoords at …
- **#92** Balloons are drawn over hidden people
  - Original : cXPerson::DrawIso (10107ae0) does everything, including the sprite slot pass, only if person +0x8e == 0 (else it returns the last damage). HouseViewer only calls Render3DObject for persons with +0x8e == 0.
  - Port : world/balloons.ts:216-240 (BalloonPainter.draw) tests only o.level > v.level and o.fx/fy < 0, then draws the slot for persons (so.isPerson branch) without checking o.hidden. LotPeople.draw does skip …
- **#93** ComputeTileZ clamps out-of-range rows; the original zeroes the depth
  - Original : ZBufferLookup::ComputeTileZ (Mac 101faff0): if the row (4<<scale)+(level-1)*levelPx+screenY is above (viewportTop - table margin +0x1c) or at or below viewportTop + (+0x28 height), then depthRow = that top bound and depth (+0x28) = 0; otherwise the table …
  - Port : world/renderparam.ts:103-119 and zbuffer.ts:135-138 (floorAt) clamp the index to the table and always compute a depth.
- **#94** SPR# / SPR2 lists with no usable palette fall back to a gray ramp, not the global CLUT
  - Original : SpriteListInfo::SpriteListInfo (Mac 101e6a90): for SPR# with version < 0x1f6 (502) or palette id < 0, and for SPR2 with a palette id < 0, the list uses the game's global CLUT (*(*lbl_105B9CD4 + 0x14)). Otherwise PaletteManager::GetPalette. The list's palette …
  - Port : world/renderer.ts:146 palette(): res.get('PALT', id) else GRAY_PALETTE. world/spr.ts:230 (decodeSprFrame) always takes hdr.palette, even for version 501 (and a negative SPR2 default palette).

## walls-floors-light

- **#95** Second pass of cut-wall end pieces uses the segment room's ambient instead of the outside room's
  - Original : Wall::Draw (Mac 0x102b57a0, lines ~1162-1171 and ~1527-1637): dVar31 = ambient of RoomManager::GetRoom(0) (outside room), dVar32 = ambient of the wall's room[side] (1.0 when none). Each pass calls SetAmbientLightLevel(dVar32); for the end-piece second pass …
  - Port : walls.ts:868 sets `viewer.comp.ambient = viewer.ambientAtTile(tile.x, tile.y, level)` once per segment and uses it for both passes of the loop (lines ~884-925), including the end-piece second pass.
- **#96** Dynamic cutaway of the selected sim ignores the sim's own room when it stands on a diagonal (degenerate) tile
  - Original : HouseViewer::DoDynamicCutaway (Mac 0x101c6520, mode 2 branch): the sim's room is its stored current room `*(ushort*)(person+0xaac) < 0xfffb` (UpdateCurrentRoom, set from object data 29, already resolved for diagonal tiles); that room's cutaway matrix is OR'ed …
  - Port : cutaway.ts:~150 `const id = w.fixed.rooms[p.level - 1]?.u16(p.x, p.y)` and `id < ROOM_DEGENERATE`; winlotview.ts:~380 only passes x, y, level (person.currentRoom is not passed).
- **#97** Room lamps do not light people (LightingRig point lights not modelled)
  - Original : LightingRig::EngageLights (Mac 0x101d3650): for the person's room, every light collected by Room::CollectObjectStats (light source 1, Room +0x0c / +0x10, up to 6) within squared distance <= lbl_105BBF70[2] is added to the viewport (intensity falloff 1/(k*(d2 …
  - Port : sims/lighting.ts engageLights uses only lights[0] (stdlight.lgt has a single light) scaled by the room ambient; the header comment says 'Room lamps (point lights within 20 units) are not modelled'. …

## terrain-roof-pool

- **#98** Roofs are not regenerated when stairs are moved (only on ComputeRooms)
  - Original : cRoofLayer::DiscoverTilesToRoof (0x102d5600) blocks a level-1 cell when an object whose master OBJD +0x8a == 3 (stairs) is on a tile that has a level-2 object. GenerateRoof is called from cFixedWorld::ComputeRooms (cFixedWorld.c:1369-1372), which the original …
  - Port : client/src/game/world/roofs.ts:459-464 (generateRoofs, called only from computeRooms in rooms.ts:287). docs/decomp/roof-port.md 'Not ported / gaps' states that moving stairs alone does not regenerate …

## build-tools

- **#99** Floor tool, floor-undo helpers and wallpaper tool ignore the build-anywhere cheat in MayEditTile and TileIsFloorable
  - Original : cRotatableWorld::MayEditTile (101722e0): `if (*lbl_105BA244 != 0) return 1;`. cNewFloorTool::TileIsFloorable (10171860) applies the same test inline: `if (*lbl_105BA244 == 0) editable = !(flags>>5 & 1) else editable = 1`. cNewFloorTool::ChangeFloor, …
  - Port : floortool.ts:94-98 tileIsFloorable does `if (fixed.flags[0].u8(wx,wy) & 0x20) return false` with no cheat test. floortool.ts:221 and 532 call worldedit.mayEditTile(world,x,y), which has no `anywhere` …
- **#100** Wall tool cursor vertex placement is a plain bounds test, not the cursor object's own placement check
  - Original : cNewWallTool::SetCursorVertex (10176fe0): after moving to the new vertex it asks the Wall Cursor object, via virtual +0x5c (the same placement test cNewWallTool::Float uses), whether it can go there. If not, it kills the cursor and returns 0. Drag uses that …
  - Port : walltool.ts:228-231 `ok = v.x >= w.minX && v.x <= w.maxX && v.y >= w.minY && v.y <= w.maxY`, then `cursorShown = ok`.
- **#101** Wallpaper room mode: a failed DoRoom during Drag sets the cannot-afford flag unconditionally, and Click keeps the flag across the reset. The port clears it both times
  - Original : cNewWallpaperTool::Drag (10175c90): when DoRoom fails it calls WallpaperUndoable::Reset (which clears +0x40) and then sets `undoable->+0x40 = 1`. cNewWallpaperTool::Click (10176090): on a DoRoom failure it saves CannotAfford() before Reset and re-sets +0x40 = …
  - Port : wallpapertool.ts:368-370 (drag) and 322-324 (click): `if (!this.doRoom(...)) this.undoable.reset();`. WallpaperUndoable.reset (wallpaperundo.ts:95-99) clears cannotAffordFlag, so the flag never …

## buy-tools

- **#102** TurnToWall for doors and windows (modes 3 and 4) uses the generic loop and misses the error 0x16 early exit
  - Original : cMoveTool::TurnToWall (1016d030). Modes 3 and 4: try Turn(i) for i = 1..3 and return 0 at once if the floater is valid. Also return 0 at once, leaving the object turned by i, if the placement error (lbl_105BA1A8) is 0x16. Otherwise Turn(-i) and continue. …
  - Port : client/src/game/world/tools/movetool.ts:719 (turnToWall): one loop `for i in 1..trunc(8/notches)-1` with turn(i), cursorValid check and turn(-i). No mode check and no 0x16 test.
- **#103** Cursor placement checks the price against funds minus the running total; the original uses raw funds
  - Original : cXCursorObject::Place (10097dc0) calls cSimulator::GetFunds() (raw funds) and sets error 0x15 and leaves the floater invalid when `funds < price && price != 0 && purchase flag`. Only cMoveTool::Release subtracts the running total (`runningTotal + price <= …
  - Port : movetool.ts:354 and :381 pass `() => this.host.getFunds() - this.runningTotal` as XCursorObject's funds; cursorobject.ts:171 uses it in place().
- **#104** MakeNewOutOfWorldObject has no veto for objects whose body string is "dog" or "kat"
  - Original : ObjectModule::MakeNewOutOfWorldObject (100de1b0), single-tile branch: GetBodyStrings(sel, 0) string #1 is compared against the strings at lbl_105BE53C ("dog") and lbl_105BE540 ("kat"). Unless House flags +0x66 have 0x20 or 0x80 set, a match returns 0 and no …
  - Port : client/src/game/world/tools/objectfactory.ts:111 (makeNewOutOfWorldObject) has no such check.

## cpanel-live

- **#105** Right-click on a relationship tile does not center the lot view on that Sim
  - Original : cWinRelationship::TSOnMouseDownR (10291c40): iVar1 = PersonFinder::GetInstance(otherGuid); if (iVar1 != 0) cXObject::CenterHouseViewOnMe(iVar1, 1); returns 1.
  - Port : client/src/game/cpanel/live/relationship.ts:26 says it is not ported, and WinRelationship has no right-button handler. The portrait right-click (TrackPerson, people.ts) is ported.
- **#106** Control panel page switches never fade, even with interface effects on
  - Original : cWinCPanel::SetPanel (10266050): for every page, if cOptionsMgr::GetBoboVision() is false it calls ShowWindow/HideWindow, otherwise AsyncShowHideWin(show, 0, 0), so pages fade in and out when interface effects are on.
  - Port : client/src/game/cpanel/cpanel.ts:200 setPanel always calls showWindow()/hideWindow(). Only options.ts and the whole-panel collapse in viewcontrol.ts use asyncShowHideWin.

## cpanel-buybuild

- **#107** Product buttons ignore the Quick Tips setting for their hover delay
  - Original : Product::CreateButton (Mac 0x10200b60): sets button +0x14c = 6 and +0x150 = lbl_105BA774, the value cOptionsMgr::SetQuickTips (0x10230e50) writes: 0xfa with quick tips on, 0x14d (333 ms) with them off.
  - Port : client/src/game/cpanel/buy/productbutton.ts:33 and :113 use the constant ASYNC_TIMEOUT_MS = 0xfa and never read getOptionsMgr().getDefaultAsyncTimeout(). The options, camera panel and roof panel code …
- **#108** Catalog drops objects without any sort, so FindProduct fails for them (dispose popup shows <Unknown>)
  - Original : Catalog::Init (Mac 0x101fdf40, object loop near the end): keeps every selector that is not a multi-tile sub-object and not a person, and that has graphics or interactions. Catalog::FindProduct (0x101fdeb0) then finds the product of any such selector. Sort …
  - Port : client/src/game/data/catalog.ts:410-412 (scanFile): adds an extra 'Objects without any catalog sort ... never show' filter (roomSort, functionSort, community sorts, buildModeType all 0 -> continue). …
- **#109** Catalog popup 'group activity' test does not match the original's TTAIndex lookup
  - Original : ObjSelector::HasGroupActions (Mac 0x100fa7d0): for each non-debug interaction i, searches the table for an entry j with j+0x18 == i+0x20 (TTAB TTAIndex of j == JoiningIndex of i, per TreeTableEntry::DoStream 0x1014c310) and counts a hit when one exists.
  - Port : client/src/game/cpanel/buy/catalogpopup.ts:112-114 hasGroupActions: joiningIndex >= 0 && joiningIndex < list.length, i.e. it treats JoiningIndex as a position in the list and never compares it with …
- **#110** Catalog popup looks up the TTAB only in the object's own file, without the original's fallbacks
  - Original : ObjSelector::AdultsOnly / ChildrenOnly / PetsOnly / CatsOnly / DogsOnly / HasGroupActions (Mac 0x100fb320, 0x100fb140, 0x100fabb0, 0x100fad80, 0x100faf60, 0x100fa7d0): tree table id = OBJD +0x0e. If it is -1, the master selector's id is used; any other …
  - Port : client/src/game/cpanel/buy/catalogpopup.ts:117-127 (interactions): file.get('TTAB', p.field(OBJD.treeTableId)) in the object's own file only, with no -1 or negative remap and no semi-global fallback. …
- **#111** Photos taken since the last save are kept when the lot is not saved (RevertScrapbook / CommitChanges not ported)
  - Original : Family.c calls cScrapbook::CommitChanges (Mac 0x1023f870, from Family.c:298) to record the next photo number (+0x238 = +0x14) and cScrapbook::RevertScrapbook (0x1023f8b0, Family.c:684) to delete every page whose number >= that mark. This runs when the player …
  - Port : client/src/game/cpanel/camscrapbook.ts:25-27 documents 'Not ported: RevertScrapbook / CommitChanges'. Scrapbook.addPhoto writes the JPG, thumbnail and TXT straight through writeGameFile, with no …

## ui-framework

- **#112** BTN_TOGGLE release logic does not match the original
  - Original : cTSWinBtn::TSOnMouseDownL (Mac 0x10502ed0) and TSOnMouseUpL (0x10502c70). For mode 1 the press sets state to 1 and records +0x5b = (state changed). On release, if +0xec != 1 and +0x5b is set the state is flipped back; otherwise it is left alone. A press on an …
  - Port : client/src/game/ui/btn.ts:263-271: `else if (this.entered && !this.changedOnDown) this.state = 0;` clears an already selected button on release inside it. `!entered && changedOnDown` is also tied to …
- **#113** Button command mode 2 (send on both press and release) cannot be expressed
  - Original : cTSWinBtn +0xec takes 0, 1 or 2. TSOnMouseDownL (Mac 0x10502ed0) sends the command on press when it is 1 or 2. TSOnMouseUpL (0x10502c70) sends it on release (and plays the up sound) when it is 0 or 2.
  - Port : client/src/game/ui/btn.ts: `sendOnDown` is a boolean. The release branch is `!this.sendOnDown && this.entered`, so the press-and-release case is not representable.
- **#114** 'money' graphics cheat is registered but only logs
  - Original : Graphics cheat Callback (Mac 0x101b4050) case 3: requires exactly one argument, checks that all characters are digits, then calls cSimulator::SetFunds(amount). Otherwise it sets the usage error text. Note the Windows build has no 'sets current funds' string, …
  - Port : client/src/game/ui/cheat.ts:577 lists "money" in GRAPHICS_CHEATS, but graphicsCheatCallback (about :606-622) only handles genable and grid, and logs 'not ported' for the rest.

## nbhd

- **#115** Bulldozing a Downtown / Vacation / Studio / Magic Town lot does not reset its name and description
  - Original : Neighborhood::MoveOut 100a8970 (bulldoze, param_3): opens Houses\DTDesc.iff for houses 0x15..0x1e, VIDesc.iff 0x28..0x30, STDesc.iff 0x51..0x59, MTDesc.iff 0x5a..0x63, NeighborhoodDesc.iff for residential/house 0 zones, and sets STR# 2000+house entries 1 and …
  - Port : Only nbhd/winneighborhoodul.ts:1348 clearLotDescription (always Houses/NeighborhoodDesc.iff, also for community-zoned lots). nbhd/wintown.ts:1319 evictModeLotHandler never clears the description.
- **#116** RemoveFamily(int) port deletes any member character and skips DeleteFamilyExport / refusal rules
  - Original : Global RemoveFamily(int) 1022acf0: for each member RemoveFromFamily, then only if the member's ObjSelector +0xb4 bits 2-3 == 1 (Characters folder) PersonFinder/Neighborhood::DeleteCharacter; then DeleteFamilyExport(family) (the Export/<name>_<id>.FAM file), …
  - Port : data/nbhdstore.ts:552 removeFamily: shifts every member out, calls store.deleteCharacter (473, no IsCharacter / source check) for all, never deletes the Export .FAM, and always save()s even when the …
- **#117** Neighborhood::LoadHouse does not drop families with no members
  - Original : Neighborhood::LoadHouse 100a7010 start: loop over the family vector; every family with CountMembers == 0 and id != 0 gets +0x110 = 0 and Neighborhood::RemoveFamily, repeated until none is left.
  - Port : main.ts:373 moveIn / enterLot and data/nbhdstore.ts: no pass removes empty families; unhousedFamilies() (nbhdstore.ts:619) lists them.
- **#118** setFamilyHouse does not apply LoadHouse's move-in refusal conditions
  - Original : Neighborhood::LoadHouse 100a7010 (param_3 > 0, param_2 != 0): the family moves in only if the house's zoning type (+0x170 table) is 1 (residential) and no family already has +0x110 or +0x13c == house; otherwise it returns -1 and nothing changes (no budget/lot …
  - Port : data/nbhdstore.ts:639 setFamilyHouse sets houseNumber, flags and the budget/netWorth swap unconditionally; the checks live only in the UI handlers (winneighborhoodul.ts:1247, wintown.ts:1035).
- **#119** Evict mode on the main screen does not re-highlight the tutorial lots afterwards
  - Original : cWinNeighborhoodUL::EvictModeLotHandler 104608d0 tail: after ReloadThumbnail, for every lot button with +0x1a0 != 0 and Neighborhood +0x12e (tutorial state) == 0 it calls HiliteForTutorial(1) (vtable +0x168).
  - Port : nbhd/winneighborhoodul.ts runEvict (~line 1362) only reloads the evicted lot's thumbnail.

## cas

- **#120** MakeNewFamily does not sort the family vector
  - Original : Neighborhood::MakeNewFamily (Mac 100ab070) inserts the new Family at the end of the vector (+0x154). When the vector has more than one entry it runs customsort with lbl_105BB988 (SortFamilyByCreation, 100adc50), so higher family numbers come first.
  - Port : client/src/game/data/nbhdstore.ts:515 (makeNewFamily) does families.push(...) and returns. sortFamiliesByCreation (nbhdstore.ts:504) is only called from nbhd/townies.ts, never from the …
- **#121** RemoveFamily saves the neighborhood even when Neighborhood::RemoveFamily refuses
  - Original : global RemoveFamily (Mac 1022acf0) calls Neighborhood::Save only when Neighborhood::RemoveFamily (100aaf80) returned 0 (family id != 0 and house number == 0). Otherwise it returns 0 without saving, but the members have already been taken out and their …
  - Port : client/src/game/data/nbhdstore.ts:552-567 (removeFamily) always ends with await this.save(). It skips the splice and chunk removal when f.id === 0 or houseNumber !== 0, but still saves.

## save-load

- **#122** Saved current/last interaction and the interaction queue are not restored on load; the live queue is not saved
  - Original : cXPerson::ReconStream (10102dd0) with v > 0x2a: Interaction::DoStream of +0xa08 (current) and +0xa44 (last), then the queue is rebuilt into the 8-slot ring at +0x820 (head +0xa00 / tail +0xa04). Loading restores the sim's pending actions, so the TreeStack …
  - Port : world/personstream.ts parses the tail, but sim/person.ts:243-245 restores only objectRecords and motiveIncs. currentAction, lastAction and queue stay empty. world/housesave.ts:writePerson writes back …
- **#123** Neighborhood::Save's tutorial-lot bookkeeping (+0x12c = house when global 26 is set) is not done
  - Original : Neighborhood::Save (100ac590): `if (sim global at +0x44 (global 26, tutorial) != 0) Neighborhood+0x12c = +0x164 (current house)`.
  - Port : world/savegame.ts saveGame only sets NGBH shorts[3] = 1. shorts[2] is set only by importFamily(tutorial) (nbhdstore.ts:1178) and cleared in nbhd/tutorial.ts.
- **#124** SIMI load restores the global random seed on every lot; the original does so only on residential lots
  - Original : cSimulator::DoStream (10130bd0), v > 0xd: reads +0xac and the SRand seed. Only if Neighborhood::GetZoningType(house) == 1 is SetSRandSeed(saved) called. Otherwise +0xac and the seed are set from timeGetTime().
  - Port : sim/simulator.ts:readSimi lines 254-285 always calls setSRandSeed(buf.recon32()) and keeps this.seed from the file (the comment says 'houses are' residential).
- **#125** Neighborhood::Load clean-up steps are not ported (UpdateFamilyNumbers, NBRS neighbors without a character file, new Characters files, missing family 0)
  - Original : Neighborhood::Load (100ac9b0): removes any NBRS neighbor whose selector (+8) is null (RemoveNeighbor, which also clears its inventory tokens and its relationship arrays in the others). It calls AddNewNeighbor for every person/pet selector in the Characters …
  - Port : data/nbhdstore.ts open() and data/neighborhood.ts loadNeighborhood only parse the chunks. Family numbers are updated only in the mutating helpers (addToFamily, removeFamily, importFamily).
- **#126** Photo album pages are written at once and never reverted when the lot is left without saving
  - Original : cScrapbook::CommitChanges (1023f870) records the page count at Neighborhood::Save / Family::SaveFamily. cScrapbook::RevertScrapbook (1023f8b0) deletes the pages added since, on leaving the lot without a save.
  - Port : cpanel/camscrapbook.ts (header comment: 'Not ported: RevertScrapbook / CommitChanges'). AddPhoto saves the page files immediately.
- **#127** Town/community/vacation branch of SaveGame clears the dirty flag; the original leaves it set
  - Original : cSimsApp::SaveGame (1024f010): the branches that only update the visitor family's budget and call Neighborhood::Save (downtown 21..30, studio 81..89, magic 93..98, zoning 2, vacation with no resident family) do not reach the `*(char*)(this+0xbf) = 0` that …
  - Port : world/savegame.ts:231 markLotClean(lv) runs in that branch.
- **#128** House save persists person data by GUID instead of by the person's neighbor id (person data 0x1f)
  - Original : cXPerson::PreSave (101084b0) -> Neighborhood::SavePersistentData (100ab970): the neighbor is looked up by the person's +0x5ca (person data 0x1f, neighbor id), not by GUID.
  - Port : world/savegame.ts:259 store.savePersistentData(p.obj.selector.guid, ...) and sim/simmodule.ts:663 savePersistentData use neighborByGuid / findNeighborByGUID. Only the matter-transfer path …

## audio

- **#129** cBoxX::Event kind 18 (fade a track out) not handled
  - Original : cBoxX::Event jump-table entry 0x12 (lbl_102DFEF4): `t = SoundObject(arg); speed = source ? source : 100; t->SetRegister(0x28 fade_dest, 0); t->SetRegister(0x29 fade_var, 0x13 extvol); t->SetRegister(0x2a fade_speed, speed); t[+0x1e7] = (a4 != 0); …
  - Port : boxx.ts:830 default -> false; no case 18.
- **#130** PlayBySource remembers the last source for the wrong events (inverted footstep test)
  - Original : cSoundPlayer::PlayBySource (Mac 10300550, asm in GameSound.s): `if (strncmp("footstep", name, 8) == 0 && source > 0) this->lastSource (+0x10) = source;`. Source -2 then reuses it. So only footstep events update it.
  - Port : soundplayer.ts:88 `if (!name.toLowerCase().startsWith("footstep") && source > 0) this.lastSource = source;`, the opposite condition.
- **#131** PlayPause on an already-active paused track un-pauses it in the original
  - Original : cTrackPlayer::PlayPause (Mac 1030afc0): when `active != 0 && IsPaused() != 0`, the else branch runs `paused (+0x1e0) = 1; return vtable[0x64] (Unpause)(this)`. Unpause clears the flag, unpauses the channel, sets nextTime = hitman time and adds the player to …
  - Port : trackplayer.ts:234 `if (this.active && this.pausedFlag) { this.pausedFlag = true; return; }` leaves the track paused.
- **#132** note / note_on loop flag also honours the track's own IsLooped register
  - Original : cSampleChannel::NoteOn (Mac 10305040): the loop flag is only the patch's register 0x2c, `Play(.., (-v|v)>>31, 1)` with `v = patch->RegisterVal(0x2c)`. cTrackPlayer::DoCommand note (0x10307110) never reads the track's own 0x2c.
  - Port : trackplayer.ts:193 `setLooped(this.registerVal(R.IsLooped) !== 0 || this.patchObj.registerVal(R.IsLooped) !== 0)`.

## app-loop

- **#133** EnterLiveMode's stats are not recomputed when entering Live mode
  - Original : House::EnterLiveMode 0x10083820, run by CPState::SetMode 0x10207900 on any change to Live: ClearRoomPartitions, AllRoomsScoreChanged, InvalidateAllRoutes, ComputeStats and ComputeArchValue. It updates the resident family's +0x138 bits 0 and 1, simulator +0xa0 …
  - Port : cpstate.ts:343 only calls enterLiveModeHooks, which have a single subscriber (sim/personanim.ts:168, VBAnimMgr.tryUnloadAll). The globals and family flags are only refreshed at midnight …
- **#134** LoadGame's ResetForVacation call for a Magic Town visit without arrivals is skipped
  - Original : cSimsApp::LoadGame 0x1024f7f0: in the branch (0x27<h<0x32 or zoning 2 or 0x5c<h<100) ObjectModule::ResetForVacation always runs after SetSpeed and Resume, before testing the arrival flags. Magic Town 0x5d..0x63 with zoning 0 and no arrival therefore resets, …
  - Port : nbhd/transit.ts:518-523: the `else` (no arrival) calls visit() and resetForVacation() only for 0x27<house<0x32. A Magic Town visit without an arrival, or a zoning-0 community lot, skips the reset …
- **#135** The frame time is not clamped (TimeBase_Sims::SetNow)
  - Original : TimeBase_Sims::SetNow 0x10145e00, run by cTSFrameWork::OnIdle: the delta since the previous frame is capped to the max delta at +0x14 (the base time is moved forward by the cap only). Every Now() consumer (CPState::Update's PulseGenerators, tooltips, …
  - Port : ui/winmgr.ts:466 passes the raw requestAnimationFrame timestamp to main.pump. The simulator caps at 30 ticks (simulator.ts MAX_PULSES) but CPState.advanceMotivePulse (cpstate.ts ~line 410) and the UI …
- **#136** Re-selecting the selected person does not stop tracking of another object
  - Original : CPState::SetSelectedPerson(int) 0x10204220: when the id equals PersonFinder::GetSelected(), if the person's instance is not the tracked object it calls cWinPeople::StopTracking, then CenterHouseViewOnMe(p, 1) and plays a sound. It always sets dirty bit 8.
  - Port : cpstate.ts:571 setSelectedPerson: for the same index it only calls viewer.centerOnSelected and returns, with no StopTracking and no dirty bit.

## Déjà corrigés pendant l'audit

- **#15** $TimeLocal token prints h:00 instead of GViewer::MakeTimeString : 7fd96b54 (makeTimeString)
- **#19** $TimeLocal does not use MakeTimeString (language and AM/PM format) : 7fd96b54 (makeTimeString)
- **#74** Animate flag 0x80 (+0xa8, clock without the 1.2 factor) is ignored : d9f6480 (ANIM_MILS_PER_TICK / milsFlag)
