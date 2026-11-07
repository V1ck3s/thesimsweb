# Family creation port (CAS)

## Data layer

Save side of family creation (client/src/game/data/). Everything written goes
through the dev server overlay (`data/files.ts`: `writeGameFile`,
`deleteGameFile`, `onGameFilesChanged`). Standalone IFFs under `Sims/UserData*`
are no longer kept in the IndexedDB asset cache (engine/assets.ts) and the
neighborhood screen's file cache is cleared on every write
(`clearIffFileCache` in nbhd/nghinterface.ts).

| File | Game code |
|---|---|
| `iff.ts` | iResFile layout: `parseIff`, `parseIffMapOrder` (rsmp order = iResFile type/index enumeration), `buildIff` (chunks then rsmp, offset at 60), `encodeStrSet`/`decodeStrSet` (format -3), `stringSetMultiSave` (StringSetMulti::SetString + Save merge rules) |
| `recon.ts` | `ReconWriter`, `encodeCp1252` |
| `character.ts` | StubObject::CreateNew of TemplatePerson (`createCharacterFile`), PersonFinder::EndDesignAPerson's writes (`saveCharacter`), cXPerson::RandomizeAllInterests (`randomizeAllInterests`, `needsInterests`) |
| `nbhdstore.ts` | `NeighborhoodStore`: Neighborhood::AddNewCharacter/AddNewNeighbor, DeleteCharacter/RemoveNeighbor, MakeNewFamily, AddToFamily, SavePersistentData, NghInterface GetUnhousedFamilies/RemoveFamily/SetFamilyName, LoadHouse's family part (`setFamilyHouse`), Save |
| `bmpwrite.ts` | BMP writer for the portraits |

Facts found in the binary / shipped files:

- New character: copy of `GameData/Objects/Objects.far` `People\TemplatePerson.iff`
  (GUID 0x7fd96b54) in its rsmp order; OBJD +0x1c = (timeGetTime() << 16) ^ rand(),
  +0x8c = template GUID, label "User%05d TemplatePerson" until SetName makes it
  "user%05d - <name>". File name: first free `User%05d.iff` from the per-session
  counter (Neighborhood +0x160, starts at 0). Neighbor slot: the *last* empty slot
  of the NBRS vector, else appended; id = slot + 1 (true for every shipped file).
- CTSS id = OBJD +0x52 (2000), STR# body strings id = OBJD +0x26 (200, label
  "bodystring", all entries language 1). CatalogResource::Save writes only the
  current language (French = 3) plus the languages already present in the chunk;
  the template has no CTSS, so a new character's CTSS holds language 3 only.
- Portraits: BMP_ 2002 "faces" 105x41, 2003 "rel. images" 200x40, 2004 "newimage"
  25x25, 2005 "speech_med" 16x16, 2006 "speech_large" 32x32, 2007 "web_image"
  45x45; all 24-bit bottom-up, 54-byte header, size fields 0. `encodeBmp` re-encodes
  the shipped ones byte-identically.
- Person data saved into the neighbor (Neighbor::GetPersistentDataFields(9)):
  2-7, 9-12, 13-18, 20, 26, 46-55, 56-58, 60, 61, 63, 65, 67-69, 74-76, 80-82.
  Zodiac (70) is not in the list. Neighbor pd version after a save: 9.
- PD[60] skin = index - 1 in PersonGlobals.iff STR# 8192 ("unknown", "lgt", "drk",
  "med"): lgt 1, drk 2, med 3. PD[58] = atoi(body string 14), PD[65] gender from
  body string 13 (SAnimator::ResetSuits).
- RandomizeAllInterests: bands {4, 3, 3} (lbl_105BBB34) for PD 46..55, values
  low rand%4, middle rand%3+4, high rand%4+7, x100; then bands {1, 2, 2} for
  PD 13, 14, 16, 20, 26.
- New family budget: NeighborhoodConstants "money for new family" = 20000.
- FAMI is always saved in version 9 (house, family number, budget, net worth,
  +0x120, flags, members (not for id 0), +0x13c, 6 shorts); FAMs through
  StringSetMulti. Move-in (Neighborhood::LoadHouse with a family): house number,
  flags = (flags & ~0xc) | 4, budget += netWorth - value, netWorth = value.

Deviations: Neighborhood::Save rewrites every chunk in the current version; we
write NBRS in the file's own version (byte-identical round trip verified on all
eight shipped Neighborhood.iff), FAMI/FAMs only for changed families, other
chunks verbatim. Files are rebuilt whole instead of iResFile's in-place edits
(no XXXX holes); string-set slack bytes are zero instead of heap garbage.
ObjectFolder (world/objectfolder.ts) caches its index per session: a character
file created this session is only indexed after a reload (its scan stamp
includes the manifest sizes, so the reload picks it up).

## EditPerson

`client/src/game/cas/editperson.ts` ports the body-string side of designing
a person (EditPerson.cpp, RegExpTree / RegExpBestFit, the PersonFinder
forwarders, the PD side of SAnimator::ResetSuits). API:
`EditPerson.begin(bodyStrings, personData)`, then synchronous
`get/setAge`, `get/setGender`, `get/setColor`, `countAvailable{Body,Head}Suits`,
`get/set{Body,Head}Suit`, `updateSuits`, `setupNewHDSkins`, `end(save)`,
`bodyStrings()`. Suit names come from `VBAnimMgr.suitNames()` (index suits +
loose skin `.cmx`), textures from `VBAnimMgr.textureNames()`.

Checked offline against the game's names (scratch script): a new adult male
from TemplatePerson gets `b001mafit_01,BODY=b001mafitlgt_relax`, naked /
underwear `nmfit_01,...`, hands `HmLO,HAND=huaolgt`..., entry 28
`fmfit_01,BODY=fmfitlgt_01`, outfits `f100mafit_original,...` .. fashion
`h552mafit_dude,...` — the same shapes as the shipped UserData characters.

Gaps:
- suit / texture walk orders are the game's hash table and directory
  listing; here both are sorted alphabetically (decides index 0 and best-fit
  ties). Names are lowercased.
- a child designed in CAS ends with empty entries 31..33 (UpdateSuits clears
  them when no child formal suit exists, exactly like the original); the game
  refills them (ADDED + SetupChildHDSkins) the next time EditPerson::Begin
  runs on that person — `EditPerson.begin` does the same.
- clownie suits are ported (Get/Count/SetClownieSuit, GetCachedClownieList:
  tree "B20" + f/u or m/u + "a", the "B200" tree excluded, list kept across
  gender / age / color like +0x94). Their only caller is Neighborhood::AddNewNPCSim
  for a template of OBJD type 0x1000 (TemplateNPCs/MMClownieGeneric.iff), i.e.
  RefillMagicSims (family 6000, Makin' Magic); RefillFans uses the generic 0x200
  template and body suits. Both are ported in `nbhd/townies.ts` (2026-11-05).
  Pets go through UpdateSuits' pet branch, which ends with ResetInstanceSuits.
- the instance side: `EditPerson.onResetInstanceSuits` is called where the game
  calls ResetInstanceSuits (empty lists, end of ForceUpdateSuits, end of the
  pet UpdateSuits). See "Design-a-person instance" below for the instance itself.

## Design-a-person instance

`client/src/game/cas/caslot.ts` (`CasLot`), used by `CasSession.lot()` and
cWinDesignCharacter's preview (2026-11-06).

Which lot: cSimsApp::ShowNbhdDialog starts with Neighborhood::UnloadHouse,
which is `LoadHouse(0)` (then house number 0, WallGraphicsMgr / FloorGraphicsMgr
UnloadAll). LoadHouse(0) loads `<neighborhood>/Houses/House00.iff` (every
shipped neighborhood has one), takes the family with number 0 as the house
family, sets globals 9 (family) and 10 (house) to 0 and the funds to 0, and for
house 0 runs ObjectModule::KillAllObjects before ObjectModule::PostLoad. So the
lot behind the neighborhood and family screens is House00 emptied of its
objects; it is never shown, its simulator keeps running (cSimsApp::Simulate).
app +0x14 (the module PersonFinder uses) is that lot's ObjectModule.

The person on it:

- PersonFinder::CreateInstance: ObjectModule::MakeNewOutOfWorldObject of the
  person's selector (ObjectFolder::GetSelectorByGUID), cXObject::FindGoodLocation
  with no start (local_28[0] = 0: GViewer::GetCentermostTile, the lot's center
  when that tile is off the interior), level 1, empty tile, same room,
  direction -1, then cXPerson::Place there (vtable +0x90, level 1); killed when
  no location is found.
- BeginDesignAPerson (when the person has no instance yet) and SetAge (after
  ObjectModule::KillObject of the old one) create it, then run the
  "design-a-person" tree (lbl_105BC1FC + 0x57; Behavior::GetTreeID on the
  selector's behavior: PersonGlobals BHAV 8308) with cXPerson::GosubObjectTree
  (instance, no params, tree) (vtable +0x3c), or ObjectModule::SetSimFlag
  (instance, 1, 0) without it. BeginDesignAPerson then sets cSimulator::SetSpeed
  (0.5 + lbl_105BC1F8[3] * [4] = 0.5 + 1000 * 0.7602339 = 760).
- EndDesignAPerson(person, save, kill, saveNeighborhood) kills the instance
  when `kill` is set: Done and Shutdown pass cWinDesignCharacter +0x119 == 0
  (+0x119 is SetPerson's second argument, 0 from the constructor;
  cWinDesignFamily calls SetPerson(person, false), only the cSimsApp cheat that
  designs the selected Sim on a lot passes true), Cancel always kills. Ported as
  `endDesignAPerson(p, save, isNew, kill, saveNeighborhood)` and
  `WinDesignCharacter.setPerson(p, keepInstance)`. BeginDesignAPerson's bool is
  never read (r4 unused in the asm).
- cWinVitaBtn::TSPaint draws the instance's SAnimator (cXPerson vtable +0x94)
  with VitaBoy::Render: the preview is what the simulator plays.
- Neighborhood::AddNewCharacter calls ObjectFolder::NewFileAdded on the new
  character file: ported as `ObjectFolder.newFileAdded` (world/objectfolder.ts),
  called by `CasSession.makeNewPerson`, so the new character has a selector
  this session (before, a file made this session was only indexed after a
  reload).

Port: `CasLot.unloadHouse` (called by cWinNeighborhoodUL's init for the main
screen, released by its shutdown; `CasSession.lot` uses it, or loads house 0
itself when a design screen is opened without the neighborhood screen) =
House::LoadFile (loadLotModule) + KillAllObjects +
`Simulator.create(..., deferPostLoad)` + PostLoad, with a Placement whose hooks
add new objects to the simulator (Init tree), and the simulator's world hooks
(like the headless ones of world/moveout.ts). The edited body strings reach the
simulator as the selector's (`SimModule.bodyStringEdits`: the original edits the
selector's own); a reset of suits runs `PersonAnimator.resetSuits` (person data
58 / 60 / 65 follow) and redresses the preview's VitaBoy. The preview's
SAnimator (dressed from the body strings) gives its skeleton to the instance's
animator (`attach`, as the lot view's bindSim), so the trees pose it. The
dialog's `pump` runs `cSimulator::Simulate` on the lot; it waits while an
instance is being made (the original creates the instance and starts its tree in
one call).

Checked (UserData30 copy, `?test=cas&screen=char` and the game's Create a
Family -> Create a Sim): one person in the module, person data 29 = 1, the stack
in "8334 do new adult left stand hips" / "8331 do new adult left stand" playing
`a2o-idle-neutral-lhips-*` and `a2o-idle-neutral-lstand-*`; child (person data
58 = 9, child skeleton), female (65 = 1), dark (60 = 2) follow; Cancel and Done
kill the instance (the module ends empty).

FindGoodLocation's start (GViewer::GetCentermostTile = HouseViewer::
ComputeCentermostTile, the view tile at the middle of the viewer, level 1; the
lot's center when off the interior; RotateCoords back by 4 - rotation): the
viewer holds what HouseViewer::DoStream read from House00's HOUS 0 (zoom,
SetOffsets of the scroll origin, rotation from version 9). `CasLot.centermostStart`
builds a HouseViewer of the lot view's size (width x height - 100) that is never
drawn and asks it; on the shipped House00 (zoom 1, origin (536, -238), rotation
1) at 1024x768 that is tile (36, 28) of the 64-tile lot, not the center.

The new person's neighbor: Neighborhood::AddNewCharacter adds it to the one
in-memory Neighborhood, which the simulator reads. The port's simulator has its
own NeighborhoodData; `CasLot.setNeighbor` / `removeNeighbor` mirror the
NeighborhoodStore at MakeNewPerson (and when house 0 comes after it),
EndDesignAPerson's SavePersistentData and DeletePerson, so the instance's
LoadPersistentData finds its neighbor id (and the saved data when an already
designed person is edited). EndDesignAPerson(save) with saveNeighborhood (the
design dialogs) then runs Neighborhood::Save: the neighbor is in
Neighborhood.iff from the person's Done on, before the family exists.

Gaps:
- The simulator of house 0 runs only while a design dialog pumps it
  (cSimsApp::Simulate runs it behind the neighborhood screen too; with every
  object killed nothing happens there).
- LoadHouse's Tutorial object (tutorial lots) is not made; not relevant to
  house 0 of the shipped neighborhoods.
- The preview VitaBoy is not redressed from the instance's outfit / hands
  person data (cWinVitaBtn calls VitaBoy::Render, not SAnimator::Render).

## Writing order of a character file ("user00177" names)

A family member showed as "user00177" (data/neighborhood.ts `loadCharacter` falls
back to the neighbor's short name when the character file has no CTSS). The
original never leaves a member's file nameless where it can be read:

- MakeNewPerson: StubObject::CreateNew writes the template copy (no CTSS) and
  NewFileAdded; nothing lists the person until Done.
- cWinDesignCharacter's Done: PersonFinder::SetName and SetDescription first
  (CatalogResource::Save: CTSS and the OBJD label written at once), then
  EndDesignAPerson: SavePersistentData + Neighborhood::Save, GenerateBitmaps
  (BMP_s), the instance killed, EditPerson::End (BodyStrings::Save). The port
  wrote everything in one go after generating the portraits, so a failure there
  (or a reload) left the file nameless; it now follows the original
  (`CasSession.setName` -> `saveCharacterName`, then `endDesignAPerson`; a
  portrait failure is logged and the rest is still written).
- Neighborhood::ImportFamily (the tutorial and every .FAM): in the member loop,
  right after AddNewCharacter (NewFileAdded), the body strings (STR# 200) and
  the catalog name / description (CTSS <id> + 2000, else the catalog resource
  <id>) go into the new file, before Neighborhood::Save; GenerateBitmaps comes
  after. The port saved the neighborhood first, then generated each member's
  portraits and only then wrote its strings, so the neighborhood screen (which
  reads the saved file while CheckForNewImports imports the tutorial in the
  background) showed the file names meanwhile, for good if the page went away.
  `importFamily` (nbhd/imports.ts) now writes the strings first and calls
  `ObjectFolder.newFileAdded` (the imported members had no selector this
  session before: the folder is built before the files exist).
- The game edits the selector in memory (catalog, body strings); the port
  rewrites the file, so `ObjectFolder.fileChanged` drops the file's selectors
  to be rebuilt from it (before, a person made this session kept the template's
  body strings and "*User%05d TemplatePerson" as catalog name on a lot entered
  in the same session).

The orphan files seen in the user's UserData (User00177 / User00178, 5011
bytes, template only, no neighbor) are persons whose design was interrupted by a
page reload (server log: PUT, then the page reloads); the game leaves the same
files when it crashes. A web-only cause of the same thing: an overlay folder
copied by hand while the server runs is not in the manifest until
`/api/manifest?refresh`, so AddNewCharacter sees its User%05d.iff names as free.

## Portraits

`client/src/game/cas/portraits.ts`: `generatePortraits(bodyStrings, res?) -> Map<BMP_ id, 24-bit BMP bytes>`
(PersonFinder::GenerateBitmaps with every bitmap type, save = true). Ported from `_global.c` (PeopleButtons.cpp):
MakePersonBtnImage (2002), MakeRelationshipBtnImage (2003), DrawPersonThumbnail (2004, on
kPeopleThumbnailBackground 0x6c), MakeSpeakingIcon 2/3 (2005/2006 on kSpeechMediumBmp/kSpeechLargeBmp),
MakeWebBtn (2007 on kWebPeopleTemplate 0x11fa), MakePersonHeadImage, GetHeadBindings, ShrinkWrap.
Arguments recovered from the asm (`asm/code/PeopleButtons.s`; the float angles go in f1/f2 so the ints
start at r6): every maker passes the fixed crop {76, 45, 122, 125} except the speaking icons
(fixed crop = NULL -> ShrinkWrap). Angles (lbl_105C0670..0694, degrees): faces yaw 0/9/-9 and turn
0/-7/7 (the three faces are three head angles, not moods), relationship / speaking -5/18.
Constants lbl_105BC1D4 = {0, 180, 100, 1, 0.5, 30, 0.05, -0.5}; 565 colors expand as r<<3, g<<2, b<<3
(checked on the shipped files: 0x000a -> (0, 0, 80)).

Checked side by side against User00174/00019/00028/00001 (UserData): sizes, backgrounds, framing and
angles match; a temporary dev page was used and removed.

Gaps: ScaleBitmap's exact filter kernel is approximated by a tent filter (radius 1/scale); the head is
rendered with the person renderer's lighting at ambient 1 (the game's ambient 1.0 saturates the white
material too, so texture colors come out unlit in both). Some shipped files have black cells (e.g.
User00174 faces 2, relationship heads 2 and 4): a quirk of the game's run, not reproduced.

## Screens

Each file's header comment lists the decompiled details it follows (positions, string entries, commands).

| File | Game class |
|---|---|
| `ui/textedit.ts` | cTSWinTextEdit2: word wrap, cursor moves (with Shift selection, Ctrl word moves), mouse selection with capture, Ctrl+X/C/V through the browser cut / copy / paste events, Ctrl+Z/Y undo / redo (snapshots merged within 3000 ms), Ctrl+A, insert / overwrite (Insert key), the vertical SYS_SCROLLBAR created when the text overflows, caret blink 500 ms, error / filter sounds (UI_Error, CAS sets UI_NHood_error). Posts 0x16 changed, 0x17 Return, 0x18 Escape and 0x19 Tab to `target` |
| `cas/zodiac.ts` | Zodiac.cpp (ComputeZodiacSign, SetZodiacSign, names from STR# 164) |
| `cas/winpersonalitywidget.ts` | cWinPersonalityWidget (LED bar, click left / right of the lit part) |
| `cas/winvitabtn.ts` | cWinVitaBtn (turning 3D person). It has its own WebGL2 canvas; `renderSimModel` was added to `sims/renderer.ts` for it |
| `cas/personfinder.ts` | `CasSession`: PersonFinder's MakeNewPerson / Begin- / EndDesignAPerson / DeletePerson over `NeighborhoodStore` |
| `cas/windesigncharacter.ts` | cWinDesignCharacter |
| `cas/windesignfamily.ts` | cWinDesignFamily and cWinDesignFamPeopleBtn |
| `cas/winpickfamily.ts` | cWinPickFamily, cPickFamilyList and cPickFamilyItem |
| `nbhd/winneighborhoodul.ts` | Move In button → `pickFamily()`; `startMoveIn` (command 0x20); `moveInModeLotHandler` |
| `main.ts` | `onMoveIn` → `Game.moveIn`, which runs LoadHouse's family part (`setFamilyHouse`), saves, then `enterLot` |

Flow: Move In opens cWinPickFamily, then the family is picked or created and Move In mode starts. A click on a residential lot then:

1. The tutorial lot shows message 16/17; a non-residential lot shows 12/13.
2. If HouseInfo+0x10 is 0 (SIMI global 21 set), message 2/3 is shown.
3. An occupied lot shows 14/15.
4. If the family's funds are below the lot value, message 2/3 is shown again.
5. Otherwise a yes/no "buy house" (0/1) or "buy lot" (6/7) question is asked. On yes, LoadGame runs.

The arrival (Neighborhood::LoadHouse, Mac 100a7010 / Windows 004282ec): the move in sets Family +0x138
bit 2; after the house file and PostLoad, LoadHouse clears it and runs SetCurrentHour(NeighborhoodConstants
"new family start hour", default 7, 0), cSimulator::ClearHistory, Resume, House::ClearRouteHistory and
ObjectModule::BroadcastMessage("reset lot", 0). There is no car: VisitGenerator.iff's "reset lot" (4111)
finds MailBox - Part A (0xef121974), makes every neighbor of family global 9 without an instance with
Create New Object Instance (mode 6, flag 4) and puts each by the mailbox with Find Location For mode 4
(from the mailbox, along its facing + 2), removing the ones that do not fit; the mailbox, NPCController
(paper girl), Bills, Fire and HelpSystem reset themselves. PersonFinder::CreateInstance (view center) only
makes members still missing. Port: `NeighborhoodStore.takeMoveInFlag`, `Game.moveIn` → `enterLot(house,
family)`, `WinLotView.moveIn` / `resetLotForMoveIn`, `SimModule.broadcastMessage`. Verified on a copy of
the game's UserData (Bonpote into lot 50): 7:00, the four members at the mailbox, $15,500 left.

The checks follow MoveInModeLotHandler in `cWinNeighborhoodUL.c`. The HouseInfo fields come from GetHouseFileInfo's out-pointers in `_global.c` (GetHouseInfo):

- +0x10 = no tutorial and global 21 == 0;
- +0x14 = global 26;
- +0x18 = global 22;
- +0x1c = value.

Keyboard focus: `WinMgr.doModalWin` focuses the dialog itself. The design screens therefore hand the focus to their name edit in `tsBeginModal`.

Dev:
- `game.html?test=cas[&screen=pick|family|char][&dir=UserData3]` opens one screen. `window.__cas.log` records `ready`, `person <file> <name>`, `family <id>` and `closed <result>`.
- `game.html?nbhd=UserData3` starts the game in another neighborhood (added to `main.ts`).
- With other agents editing files, Vite sometimes reloads the page in the middle of a scripted run. The run then has to be repeated.

Checked in the browser on UserData3:
- created Sims (name, traits, gender, suits, bio, the "points left" dialog);
- created a family of two, which appears in the picker after a reload;
- deleted a family from the picker (character files DELETEd, FAMI/FAMs dropped);
- moved into empty lot 79 ("Acheter la parcelle ?"): funds went from 20000 to 16500 and FAMI house = 79;
- after a reload, the neighborhood tooltip shows "Famille Testeur, $20.000", and entering the lot shows both portraits in the control panel.

Gaps:
- The Sims do not appear on the lot after moving in. Placing the family is the lot / simulation side: cSimsApp::LoadGame → Neighborhood::LoadHouse, which adds the people.
- Not ported:
  - DoFirstTimeTownies / RefillTownies / tourist families;
  - the lot view refresh (vtable +0x168) in the "buy house" branch;
  - the member tooltip windows (cPickFamilyPersonInfo);
  - the picker's first-run hint and scroll ramp;
  - FinishFamily's ExportFamilyHTML (an option).
- FinishFamily (NghInterface 1022aff0, called by Done with the new family and by Cancel with -1): Neighborhood::Save,
  then for a real family Neighborhood::ExportFamily into the neighborhood's Export folder
  (`NeighborhoodStore.exportFamily`). Checked on a throwaway copy of UserData: a family of one made in Create a
  Family gives `Export/<name>_<id>.FAM` with FAMI, FAMs, CTSS 1000, EXPi 0, uChr / CTSS / CTSS 2000 + id / BMP_ of
  the member, NBRS 1 and FINV 2. As the port lists every `Export/*.FAM` as importable, the new family is also
  offered for import.
- `TSWinTextEdit2`: double-click (TSOnMouseDoubleL) and the double-byte font paths are not ported.
- cWinDesignCharacter::Init: the first-name edit holds 16 in Japanese (0x0f), 25 otherwise; the
  original counts bytes (8 double-byte characters), the port characters.
- If the page reloads in the middle of a design, the copied template stays behind as an orphan `User%05d.iff` with its neighbor. The game leaves the same orphans when it crashes.
