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
  pet UpdateSuits); Create a Sim re-applies the body strings to its preview
  animator. The age button re-creates the preview like PersonFinder::SetAge
  (kill + CreateInstance); the "design-a-person" tree it then runs is
  approximated by the idle the preview already plays. That tree (PersonGlobals
  BHAV 8308, run on the instance by BeginDesignAPerson and SetAge through
  Behavior::GetTreeID(lbl_105BC1FC + 0x57); without it the sim flag is cleared)
  sets person data 29 (motives static) to 1, then loops SEMI 0x16B ? "do idle"
  (8301) : "do new adult idle" (8330), i.e. the random idle animations of a lot.
  Running it needs the instance in a simulator (the CAS room lot), which the
  port's preview does not have; left as is. Checked again 2026-11-06:
  PersonFinder::CreateInstance makes the person with
  ObjectModule::MakeNewOutOfWorldObject in the module of app +0x14 (the
  loaded lot), cXObject::FindGoodLocation and the placement vtable call
  (+0x90; killed when no location is found); BeginDesignAPerson then starts
  the tree through the instance's vtable +0x3c (tree id from
  Behavior::GetTreeID on the selector's behavior, else ObjectModule::SetSimFlag
  (instance, 1, 0)) and sets cSimulator::SetSpeed. The port's Create a Sim
  has no lot, module or simulator (the preview is a bare SAnimator rendered by
  cWinVitaBtn), so porting this means running the CAS screens over a loaded
  lot with the persons as simulated objects whose animators the vita buttons
  draw: not done.

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
- If the page reloads in the middle of a design, the copied template stays behind as an orphan `User%05d.iff` with its neighbor. The game leaves the same orphans when it crashes.
