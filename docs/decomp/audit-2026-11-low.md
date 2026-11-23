# 2026-11 audit: "low severity, unverified" findings

The full audit of the port against the decompiled code (November 2026) classified 86 confirmed
discrepancies, all dealt with or ported since (git history, 2026-11-08), and 137 low-severity
findings that no verifier reviewed. They are listed here as the audit wrote them: each one still
has to be confirmed against the decompiled code before being fixed (some may be wrong). The numbers
are those of the audit's list. A fixed finding is removed from here and noted in the git history.

First part (#0 to #52) verified on 2026-11-08, second part (#53 to #136) on 2026-11-09: the real
discrepancies are fixed and removed, along with #57 (duplicate of #30). Those that remain carry a
"verified" line: intended discrepancy, false, uncertain, or real but set aside (reason given).

## vm-core

- **#2** BCON user overrides are never applied (Behavior::GetConstants with the override flag)
  - Original: Behavior::GetConstants 0x10036f90: when the BCON flag bit 0x8000 is set and the caller passes true, it uses ObjResFile::GetOverride(id) in place of the file's constants. cTreeConstants::Load 0x10146610 does the same.
  - Port: client/src/game/sim/behavior.ts:getConstants, whose comment says the user override is not ported.
  - verified 2026-11-08: intended discrepancy. The override comes from a tuning spreadsheet read by ObjectFolder, absent from the game data (always empty).

## xobject-expr

- **#4** Writing person data 0x44 / 0x4a / 0x54 does not dirty head thumbnails (ObjSelector::SetHeadTextureDirty + CPState 0x20000000)
  - Original: InterpValue scopes 18/19/30/31 when the address is requested (0x100e4f14, 0x100e55a8, 0x100e50e4, 0x100e52dc): for person data 68, 74 and 84 (jump table 0x10601744 → sub_100e4fe8) it calls ObjSelector::SetHeadTextureDirty(this->selector, 1) (0x100f9ad0 → …
  - Port: client/src/game/sim/xobject.ts personData() (~line 648): only data 0x4d and 0x51 trigger follow-ups. 68, 74 and 84 are written with no thumbnail or CPState refresh. Nothing like 'dirty thumbnails' or …
  - verified 2026-11-08: uncertain. The port has no thumbnail cache keyed on these fields; visible effect probably nil.
- **#5** Scope 38 (neighbor's OBJD) does not raise error 0x37 when the neighbor has no selector, and returns 0 when its object file is not loaded
  - Original: InterpValue scope 38 (0x100e64a4): FindNeighborByID(stackObj) → error 0x37 if missing; data range [0,0x6c) → error 0x23; then `if (neighbor+8 == NULL) error 0x37`; it reads halfword[data] from the selector's OBJD (+0x60).
  - Port: client/src/game/sim/xobject.ts:~625 (case 38): `m.worldHooks?.selector(nb.guid)` returns 0 when the selector is undefined. The comment notes that async loading makes this 0 meanwhile.
  - verified 2026-11-08: intended discrepancy. Errors 0x37 / 0x23 are raised; only the 0 during the asynchronous load of the object file differs (commented in the code).
- **#6** Behavior::GetConstants override (flag 0x8000 BCON → ObjResFile::GetOverride) not applied for scope 26
  - Original: InterpValue scope 26 (0x100e4a94) calls Behavior::GetConstants(id, true) (0x10036f90). If the BCON's first short has bit 0x8000 set and an ObjResFile BCONOverride exists (filled by ObjectFolder from a tuning spreadsheet, SetOverride 0x100f6810), the override …
  - Port: client/src/game/sim/behavior.ts:311-317 getConstants(): 'The user override of flagged BCONs is not ported', always the file's constants. xobject.ts:557 case 26 reads them.
  - verified 2026-11-08: intended discrepancy, same cause as #2.

## xobject-prims-a

- **#12** Neighborhood::Save after call 19 / 20 is not done
  - Original: TryGenericSimCall entries 19 / 20 (0x100ea1dc / 0x100ea320): after RemoveTokenByIndex(idx, 1) the neighborhood file is saved (Neighborhood::Save).
  - Port: client/src/game/sim/lotcalls.ts:93-95 and the file header: the token removal is kept in memory only.
  - verified 2026-11-08: intended discrepancy, documented at the top of sim/lotcalls.ts (inventories stay in memory).

## xobject-dialog-text

- **#22** Dialog operand flag bit 0 (result ignored) with kinds 5/7/8/0xb/0xd makes a generic dialog, not the town window
  - Original: ObjectModule::EnqueueObjectDialog(cXObject*, StackElem*, DialogParam*) (100da970) dispatches on kind: 5 cWinDowntown, 8 cWinNeighborhoodUL/VC, 7 cWinVacation, 0xb cWinStudiotown, 0xd cWinMagicland, otherwise ObjectDialog. TryDialog calls it for these kinds …
  - Port: client/src/game/sim/xobject.ts:1704-1707: `if (op[7] & 1) { m.enqueueObjectDialog(this, elem, op); return PRIM_TRUE }` before looking at the kind. simmodule.ts:529 always builds an ObjectDialog.
  - verified 2026-11-08: real, but no game object (all the FARs and IFFs) uses bit 0 with these kinds: left as is.

## xperson-actions

- **#34** Current action and queue are not restored on load, and the saved tail is stale
  - Original: cXPerson::ReconStream with Interaction::DoStream (Mac 0x10093670): current (+0xa08), last (+0xa44) and the queue (+0x820, up to 8 interactions) are written from live state and rebuilt on load.
  - Port: client/src/game/world/housesave.ts:607-613 writePerson writes `t?.current / last / queue` (the tail read when the lot was loaded), not the live PersonSim. client/src/game/sim/person.ts:243-245 …
  - verified 2026-11-08: intended discrepancy, documented in docs/decomp/save-port.md (the action queue read back is not reloaded).

## xperson-route

- **#52** TryChangeLots does not set the current family to family 0 when going home
  - Original: TryChangeLots (10107120), house == -1 branch: `**(app+0x10) = Neighborhood::GetFamily(nbhd, 0)` before the family lookup. This sets the app's current family to family 0, the downtown family.
  - Port: transit.ts tryChangeLots (~285-296) only reads store.family(familyId). No current-family pointer is changed.
  - verified 2026-11-08: uncertain. The current family pointer is indeed written by the original, but the port does not use it the same way.

## module-folder

- **#67** Pet persons are created without the pets-pack check
  - Original: ObjectModule::MakeNewOutOfWorldObject (100de1b0): for a person whose body-string 1 (skeleton) is "dog" or "kat", when app +0x66 has neither bit 0x20 nor 0x80, it returns 0 and creates nothing. ObjectModule::DoStream (100dede0) also swaps the dog and cat …
  - Port: world/tools/objectfactory.ts:119-160 (makeNewOutOfWorldObject) has no such gate. Only getPlaceholders (world/objectfolder.ts) handles dog/cat without the pack, for loading.
  - verified 2026-11-09: real but set aside: the refusal of "dog" / "kat" persons without the Unleashed pack never triggers with the complete edition (all packs present).

## anim

- **#79** The 'anchor' time prop is not handled
  - Original: HandleVitaBoyAnimEvent 1034ca10, 'anchor': sets practice +0x70 = 0 and, for the main practice, practice +0x6c = bone and SAnimator +0x24 / +0x28. These are read by a foot-plant displacement block in the Tick states 6, 8, 9 and 10 (sub_1034F24C). That block …
  - Port: client/src/game/sim/personanim.ts handleProps has no 'anchor' case. The 'anchor' tags are used only by FindTagTime for the walk-loop foot phases (:94-103).
  - verified 2026-11-09: intended discrepancy: lbl_105BAD9C is never written in the binary, the block that uses "anchor" is dead code.

## draw

- **#88** Object flags +0x114 bit 4 (luminous) and bit 3 (dehilite) not honoured by DrawIso
  - Original: cXObject::DrawIso (100c6f70): per item, if (+0x114 & 1) Hilite=1 else 0; if !(+0x114 & 8) RenderParam +0x36 (DeHilite) = 0; if (+0x114 & 0x10) RenderParam +0x34 (Luminous) = 1. cMoveTool::UpdateHilite (cMoveTool.c:2619) sets SetHilite(... | 0x11), i.e. hilite …
  - Port: world/objectdraw.ts:173-175 only reads hiliteFlags & 1. The move tool's setHiliteId(id, 0x11) (tools/movetool.ts:624) stores bit 4, but the draw ignores it.
  - verified 2026-11-09: false: the only setter of bit 4 (movetool, 0x11) also sets bit 1, and the port already draws a highlighted sprite in full light; nothing sets bit 3.
- **#94** SPR# / SPR2 lists with no usable palette fall back to a gray ramp, not the global CLUT
  - Original: SpriteListInfo::SpriteListInfo (Mac 101e6a90): for SPR# with version < 0x1f6 (502) or palette id < 0, and for SPR2 with a palette id < 0, the list uses the game's global CLUT (*(*lbl_105B9CD4 + 0x14)). Otherwise PaletteManager::GetPalette. The list's palette …
  - Port: world/renderer.ts:146 palette(): res.get('PALT', id) else GRAY_PALETTE. world/spr.ts:230 (decodeSprFrame) always takes hdr.palette, even for version 501 (and a negative SPR2 default palette).
  - verified 2026-11-09: uncertain: the layout of the Mac's SPR# < 0x1f6 may differ from the PC's; the game's lists display correctly.

## terrain-roof-pool

- **#98** Roofs are not regenerated when stairs are moved (only on ComputeRooms)
  - Original: cRoofLayer::DiscoverTilesToRoof (0x102d5600) blocks a level-1 cell when an object whose master OBJD +0x8a == 3 (stairs) is on a tile that has a level-2 object. GenerateRoof is called from cFixedWorld::ComputeRooms (cFixedWorld.c:1369-1372), which the original …
  - Port: client/src/game/world/roofs.ts:459-464 (generateRoofs, called only from computeRooms in rooms.ts:287). docs/decomp/roof-port.md 'Not ported / gaps' states that moving stairs alone does not regenerate …
  - verified 2026-11-09: false: the original only recomputes rooms after a move if FixFloorForStairs changed the floors (or OBJD +0x8a == 6), like the port.

## build-tools

- **#100** Wall tool cursor vertex placement is a plain bounds test, not the cursor object's own placement check
  - Original: cNewWallTool::SetCursorVertex (10176fe0): after moving to the new vertex it asks the Wall Cursor object, via virtual +0x5c (the same placement test cNewWallTool::Float uses), whether it can go there. If not, it kills the cursor and returns 0. Drag uses that …
  - Port: walltool.ts:228-231 `ok = v.x >= w.minX && v.x <= w.maxX && v.y >= w.minY && v.y <= w.maxY`, then `cursorShown = ok`.
  - verified 2026-11-09: uncertain: the "Wall Cursor" object and its CanPlace would have to be ported; callers already test LegalWallTile.

## buy-tools

- **#104** MakeNewOutOfWorldObject has no veto for objects whose body string is "dog" or "kat"
  - Original: ObjectModule::MakeNewOutOfWorldObject (100de1b0), single-tile branch: GetBodyStrings(sel, 0) string #1 is compared against the strings at lbl_105BE53C ("dog") and lbl_105BE540 ("kat"). Unless House flags +0x66 have 0x20 or 0x80 set, a match returns 0 and no …
  - Port: client/src/game/world/tools/objectfactory.ts:111 (makeNewOutOfWorldObject) has no such check.
  - verified 2026-11-09: real but set aside, same cause as #67 (veto unreachable with all packs).

## ui-framework

- **#113** Button command mode 2 (send on both press and release) cannot be expressed
  - Original: cTSWinBtn +0xec takes 0, 1 or 2. TSOnMouseDownL (Mac 0x10502ed0) sends the command on press when it is 1 or 2. TSOnMouseUpL (0x10502c70) sends it on release (and plays the up sound) when it is 0 or 2.
  - Port: client/src/game/ui/btn.ts: `sendOnDown` is a boolean. The release branch is `!this.sendOnDown && this.entered`, so the press-and-release case is not representable.
  - verified 2026-11-09: false: only the values 0 and 1 are ever written to +0xec; the port's boolean loses nothing.

## nbhd

- **#118** setFamilyHouse does not apply LoadHouse's move-in refusal conditions
  - Original: Neighborhood::LoadHouse 100a7010 (param_3 > 0, param_2 != 0): the family moves in only if the house's zoning type (+0x170 table) is 1 (residential) and no family already has +0x110 or +0x13c == house; otherwise it returns -1 and nothing changes (no budget/lot …
  - Port: data/nbhdstore.ts:639 setFamilyHouse sets houseNumber, flags and the budget/netWorth swap unconditionally; the checks live only in the UI handlers (winneighborhoodul.ts:1247, wintown.ts:1035).
  - verified 2026-11-09: false: all the port's callers check the same conditions before setFamilyHouse.

## save-load

- **#125** Neighborhood::Load clean-up steps are not ported (UpdateFamilyNumbers, NBRS neighbors without a character file, new Characters files, missing family 0)
  - Original: Neighborhood::Load (100ac9b0): removes any NBRS neighbor whose selector (+8) is null (RemoveNeighbor, which also clears its inventory tokens and its relationship arrays in the others). It calls AddNewNeighbor for every person/pet selector in the Characters …
  - Port: data/nbhdstore.ts open() and data/neighborhood.ts loadNeighborhood only parse the chunks. Family numbers are updated only in the mutating helpers (addToFamily, removeFamily, importFamily).
  - verified 2026-11-09: real, partly fixed on 2026-11-09: UpdateFamilyNumbers is ported (NeighborhoodStore.open, loadNeighborhood). Remaining is the reconciliation with the Characters folder (RemoveNeighbor for neighbors without a file, AddNewNeighbor for files without a neighbor, family 0 created): set aside, because a character file the port fails to find would delete a neighbor from saves.

## app-loop

- **#135** The frame time is not clamped (TimeBase_Sims::SetNow)
  - Original: TimeBase_Sims::SetNow 0x10145e00, run by cTSFrameWork::OnIdle: the delta since the previous frame is capped to the max delta at +0x14 (the base time is moved forward by the cap only). Every Now() consumer (CPState::Update's PulseGenerators, tooltips, …
  - Port: ui/winmgr.ts:466 passes the raw requestAnimationFrame timestamp to main.pump. The simulator caps at 30 ticks (simulator.ts MAX_PULSES) but CPState.advanceMotivePulse (cpstate.ts ~line 410) and the UI …
  - verified 2026-11-09: real, partly fixed on 2026-11-09: the simulator (2000 ms) and CPState's motive pulse cap the step; the frame loop's clock (tooltips, cursors) remains the browser's.

## Already fixed during the audit

- **#15** $TimeLocal token prints h:00 instead of GViewer::MakeTimeString : 7fd96b54 (makeTimeString)
- **#19** $TimeLocal does not use MakeTimeString (language and AM/PM format) : 7fd96b54 (makeTimeString)
- **#74** Animate flag 0x80 (+0xa8, clock without the 1.2 factor) is ignored : d9f6480 (ANIM_MILS_PER_TICK / milsFlag)
