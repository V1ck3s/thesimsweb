# Audit du 2026-11 : constats « faibles, non vérifiés »

L'audit complet du port contre le code décompilé (novembre 2026) a classé 86 écarts confirmés, tous
traités ou portés depuis (journal de `PLAN.md`, 2026-11-08), et 137 constats de faible gravité qu'aucun
vérificateur n'a relus. Ils sont listés ici tels que l'audit les a écrits : chacun reste à confirmer
contre le décompilé avant d'être corrigé (certains peuvent être faux). Les numéros sont ceux de la
liste de l'audit. Un constat corrigé est retiré d'ici et noté dans le journal.

Première partie (#0 à #52) vérifiée le 2026-11-08, seconde partie (#53 à #136) le 2026-11-09 : les
écarts réels sont corrigés et retirés, avec #57 (doublon de #30). Ceux qui restent portent une ligne
« vérifié » : écart voulu, faux, incertain, ou réel mais laissé de côté (raison donnée).

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

## xobject-dialog-text

- **#22** Dialog operand flag bit 0 (result ignored) with kinds 5/7/8/0xb/0xd makes a generic dialog, not the town window
  - Original : ObjectModule::EnqueueObjectDialog(cXObject*, StackElem*, DialogParam*) (100da970) dispatches on kind: 5 cWinDowntown, 8 cWinNeighborhoodUL/VC, 7 cWinVacation, 0xb cWinStudiotown, 0xd cWinMagicland, otherwise ObjectDialog. TryDialog calls it for these kinds …
  - Port : client/src/game/sim/xobject.ts:1704-1707: `if (op[7] & 1) { m.enqueueObjectDialog(this, elem, op); return PRIM_TRUE }` before looking at the kind. simmodule.ts:529 always builds an ObjectDialog.
  - vérifié 2026-11-08 : réel, mais aucun objet du jeu (tous les FAR et IFF) n'emploie le bit 0 avec ces genres : laissé tel quel.

## xperson-actions

- **#34** Current action and queue are not restored on load, and the saved tail is stale
  - Original : cXPerson::ReconStream with Interaction::DoStream (Mac 0x10093670): current (+0xa08), last (+0xa44) and the queue (+0x820, up to 8 interactions) are written from live state and rebuilt on load.
  - Port : client/src/game/world/housesave.ts:607-613 writePerson writes `t?.current / last / queue` (the tail read when the lot was loaded), not the live PersonSim. client/src/game/sim/person.ts:243-245 …
  - vérifié 2026-11-08 : écart voulu, documenté dans docs/decomp/save-port.md (la file d'actions relue n'est pas rechargée).

## xperson-route

- **#52** TryChangeLots does not set the current family to family 0 when going home
  - Original : TryChangeLots (10107120), house == -1 branch: `**(app+0x10) = Neighborhood::GetFamily(nbhd, 0)` before the family lookup. This sets the app's current family to family 0, the downtown family.
  - Port : transit.ts tryChangeLots (~285-296) only reads store.family(familyId). No current-family pointer is changed.
  - vérifié 2026-11-08 : incertain. Le pointeur de famille courante est bien écrit par l'original, mais le port ne l'utilise pas de la même façon.

## module-folder

- **#67** Pet persons are created without the pets-pack check
  - Original : ObjectModule::MakeNewOutOfWorldObject (100de1b0): for a person whose body-string 1 (skeleton) is "dog" or "kat", when app +0x66 has neither bit 0x20 nor 0x80, it returns 0 and creates nothing. ObjectModule::DoStream (100dede0) also swaps the dog and cat …
  - Port : world/tools/objectfactory.ts:119-160 (makeNewOutOfWorldObject) has no such gate. Only getPlaceholders (world/objectfolder.ts) handles dog/cat without the pack, for loading.
  - vérifié 2026-11-09 : réel mais laissé : le refus des personnes « dog » / « kat » sans le pack Unleashed ne se déclenche jamais avec l'édition complète (tous les packs présents).

## anim

- **#79** The 'anchor' time prop is not handled
  - Original : HandleVitaBoyAnimEvent 1034ca10, 'anchor': sets practice +0x70 = 0 and, for the main practice, practice +0x6c = bone and SAnimator +0x24 / +0x28. These are read by a foot-plant displacement block in the Tick states 6, 8, 9 and 10 (sub_1034F24C). That block …
  - Port : client/src/game/sim/personanim.ts handleProps has no 'anchor' case. The 'anchor' tags are used only by FindTagTime for the walk-loop foot phases (:94-103).
  - vérifié 2026-11-09 : écart voulu : lbl_105BAD9C n'est jamais écrit dans le binaire, le bloc qui utilise « anchor » est du code mort.

## draw

- **#88** Object flags +0x114 bit 4 (luminous) and bit 3 (dehilite) not honoured by DrawIso
  - Original : cXObject::DrawIso (100c6f70): per item, if (+0x114 & 1) Hilite=1 else 0; if !(+0x114 & 8) RenderParam +0x36 (DeHilite) = 0; if (+0x114 & 0x10) RenderParam +0x34 (Luminous) = 1. cMoveTool::UpdateHilite (cMoveTool.c:2619) sets SetHilite(... | 0x11), i.e. hilite …
  - Port : world/objectdraw.ts:173-175 only reads hiliteFlags & 1. The move tool's setHiliteId(id, 0x11) (tools/movetool.ts:624) stores bit 4, but the draw ignores it.
  - vérifié 2026-11-09 : faux : le seul setter du bit 4 (movetool, 0x11) pose aussi le bit 1, et le port dessine déjà en pleine lumière un sprite surligné ; rien ne pose le bit 3.
- **#94** SPR# / SPR2 lists with no usable palette fall back to a gray ramp, not the global CLUT
  - Original : SpriteListInfo::SpriteListInfo (Mac 101e6a90): for SPR# with version < 0x1f6 (502) or palette id < 0, and for SPR2 with a palette id < 0, the list uses the game's global CLUT (*(*lbl_105B9CD4 + 0x14)). Otherwise PaletteManager::GetPalette. The list's palette …
  - Port : world/renderer.ts:146 palette(): res.get('PALT', id) else GRAY_PALETTE. world/spr.ts:230 (decodeSprFrame) always takes hdr.palette, even for version 501 (and a negative SPR2 default palette).
  - vérifié 2026-11-09 : incertain : la disposition des SPR# < 0x1f6 du Mac diffère peut-être de celle du PC ; les listes du jeu s'affichent correctement.

## terrain-roof-pool

- **#98** Roofs are not regenerated when stairs are moved (only on ComputeRooms)
  - Original : cRoofLayer::DiscoverTilesToRoof (0x102d5600) blocks a level-1 cell when an object whose master OBJD +0x8a == 3 (stairs) is on a tile that has a level-2 object. GenerateRoof is called from cFixedWorld::ComputeRooms (cFixedWorld.c:1369-1372), which the original …
  - Port : client/src/game/world/roofs.ts:459-464 (generateRoofs, called only from computeRooms in rooms.ts:287). docs/decomp/roof-port.md 'Not ported / gaps' states that moving stairs alone does not regenerate …
  - vérifié 2026-11-09 : faux : l'original ne recalcule les pièces après un déplacement que si FixFloorForStairs a changé les sols (ou OBJD +0x8a == 6), comme le port.

## build-tools

- **#100** Wall tool cursor vertex placement is a plain bounds test, not the cursor object's own placement check
  - Original : cNewWallTool::SetCursorVertex (10176fe0): after moving to the new vertex it asks the Wall Cursor object, via virtual +0x5c (the same placement test cNewWallTool::Float uses), whether it can go there. If not, it kills the cursor and returns 0. Drag uses that …
  - Port : walltool.ts:228-231 `ok = v.x >= w.minX && v.x <= w.maxX && v.y >= w.minY && v.y <= w.maxY`, then `cursorShown = ok`.
  - vérifié 2026-11-09 : incertain : il faudrait porter l'objet « Wall Cursor » et son CanPlace ; les appelants testent déjà LegalWallTile.

## buy-tools

- **#104** MakeNewOutOfWorldObject has no veto for objects whose body string is "dog" or "kat"
  - Original : ObjectModule::MakeNewOutOfWorldObject (100de1b0), single-tile branch: GetBodyStrings(sel, 0) string #1 is compared against the strings at lbl_105BE53C ("dog") and lbl_105BE540 ("kat"). Unless House flags +0x66 have 0x20 or 0x80 set, a match returns 0 and no …
  - Port : client/src/game/world/tools/objectfactory.ts:111 (makeNewOutOfWorldObject) has no such check.
  - vérifié 2026-11-09 : réel mais laissé, même cause que #67 (veto inatteignable avec tous les packs).

## ui-framework

- **#113** Button command mode 2 (send on both press and release) cannot be expressed
  - Original : cTSWinBtn +0xec takes 0, 1 or 2. TSOnMouseDownL (Mac 0x10502ed0) sends the command on press when it is 1 or 2. TSOnMouseUpL (0x10502c70) sends it on release (and plays the up sound) when it is 0 or 2.
  - Port : client/src/game/ui/btn.ts: `sendOnDown` is a boolean. The release branch is `!this.sendOnDown && this.entered`, so the press-and-release case is not representable.
  - vérifié 2026-11-09 : faux : seules les valeurs 0 et 1 sont jamais écrites dans +0xec ; le booléen du port ne perd rien.

## nbhd

- **#118** setFamilyHouse does not apply LoadHouse's move-in refusal conditions
  - Original : Neighborhood::LoadHouse 100a7010 (param_3 > 0, param_2 != 0): the family moves in only if the house's zoning type (+0x170 table) is 1 (residential) and no family already has +0x110 or +0x13c == house; otherwise it returns -1 and nothing changes (no budget/lot …
  - Port : data/nbhdstore.ts:639 setFamilyHouse sets houseNumber, flags and the budget/netWorth swap unconditionally; the checks live only in the UI handlers (winneighborhoodul.ts:1247, wintown.ts:1035).
  - vérifié 2026-11-09 : faux : tous les appelants du port vérifient les mêmes conditions avant setFamilyHouse.

## save-load

- **#125** Neighborhood::Load clean-up steps are not ported (UpdateFamilyNumbers, NBRS neighbors without a character file, new Characters files, missing family 0)
  - Original : Neighborhood::Load (100ac9b0): removes any NBRS neighbor whose selector (+8) is null (RemoveNeighbor, which also clears its inventory tokens and its relationship arrays in the others). It calls AddNewNeighbor for every person/pet selector in the Characters …
  - Port : data/nbhdstore.ts open() and data/neighborhood.ts loadNeighborhood only parse the chunks. Family numbers are updated only in the mutating helpers (addToFamily, removeFamily, importFamily).
  - vérifié 2026-11-09 : réel, en partie corrigé le 2026-11-09 : UpdateFamilyNumbers est porté (NeighborhoodStore.open, loadNeighborhood). Reste la réconciliation avec le dossier Characters (RemoveNeighbor des voisins sans fichier, AddNewNeighbor des fichiers sans voisin, famille 0 créée) : laissée, car un fichier de personnage non trouvé par le port supprimerait un voisin des sauvegardes.

## app-loop

- **#135** The frame time is not clamped (TimeBase_Sims::SetNow)
  - Original : TimeBase_Sims::SetNow 0x10145e00, run by cTSFrameWork::OnIdle: the delta since the previous frame is capped to the max delta at +0x14 (the base time is moved forward by the cap only). Every Now() consumer (CPState::Update's PulseGenerators, tooltips, …
  - Port : ui/winmgr.ts:466 passes the raw requestAnimationFrame timestamp to main.pump. The simulator caps at 30 ticks (simulator.ts MAX_PULSES) but CPState.advanceMotivePulse (cpstate.ts ~line 410) and the UI …
  - vérifié 2026-11-09 : réel, en partie corrigé le 2026-11-09 : le simulateur (2000 ms) et le pouls des motivations de CPState plafonnent le pas ; l'horloge de la boucle de trames (tooltips, curseurs) reste celle du navigateur.

## Déjà corrigés pendant l'audit

- **#15** $TimeLocal token prints h:00 instead of GViewer::MakeTimeString : 7fd96b54 (makeTimeString)
- **#19** $TimeLocal does not use MakeTimeString (language and AM/PM format) : 7fd96b54 (makeTimeString)
- **#74** Animate flag 0x80 (+0xa8, clock without the 1.2 factor) is ignored : d9f6480 (ANIM_MILS_PER_TICK / milsFlag)
