# Saving a lot (cSimsApp::SaveGame / House::SaveFile)

Port of the house save path. Code: `client/src/game/world/{reconwriter,usagemap,housesave,housestats,savegame}.ts`.

## Call chain

- Options > Save → `ctx.hooks.saveGame` → `world/savegame.ts saveGame`, which ports `cSimsApp::SaveGame` (cSimsApp.c:4314).
  - On a residential lot it runs `Neighborhood::SaveHouse`:
    1. The resident family gets `budget = funds` and loses flag bit 3 (`+0x138 &= ~8`).
    2. `House::SaveFile` runs (House.c:403).
    3. `Neighborhood::Save` follows (`NeighborhoodStore.save`).
  - On a community lot (zoning 2), only the visiting family's budget is updated and the neighborhood saved.
- Options > Neighborhood → `isLotDirty`, then `doSave` (`cSimsApp::DoSave`, cSimsApp.c:4974).
  - The dialog is UIText STR# 0x99, entries 4 (message) and 5 (title), with Yes/No/Cancel.
  - Cancel stays on the lot. Yes saves, then leaves. No leaves.
- Dirty flag (cSimsApp +0xbf): the lot is dirty once the clock has ticked, the funds have changed, or a buy/build command has been submitted, undone or redone since the lot was entered or last saved (`WinLotView.editCount`).
  - The original sets this flag from most commands in `cSimsApp::DoCommand`.
- The file is written with `writeGameFile` to `<nbhd>/Houses/HouseNN.iff` (server overlay).

## House::SaveFile

1. **Stats** (`world/housestats.ts`):
   - `ObjectModule::ComputeStats` is ported from the asm (its jump table on object data 59).
   - `cFixedWorld::ComputeArchValue` is ported too.
   - The results go to: sim +0xa0 (objects), sim +0xa4 (arch + other), global 0x16 (lot has house), global 0x25 (transit flags), and family +0x138 bits 0/1.
   - Global 0x17 is set to the lot size.
2. **Chunks**, written in this order:

| Chunk | Original | Writer |
|---|---|---|
| SIMI 1 | cSimulator::DoStream v0x49 | `saveSimulator` |
| HOUS 1 | SimpleReconObject\<House\> | copied (name + 12 ints); rewritten by `saveHouseRecon` after ClearRouteHistory (MoveOut) |
| FLRm 0/1 | FloorGraphicsMgr::SaveUsageMap | `FloorGraphicsMgr.saveUsageMap` + `usagemap.ts` |
| WALm 0/1 | WallGraphicsMgr::SaveUsageMap | `WallGraphicsMgr.saveUsageMap` |
| Arry × 18 | cFixedWorld::Save → c2DArray::WriteToDisk | `saveFixedWorld` / `encodeC2DArray` |
| objt 0 | ObjectFolder::PrepareForModuleSave (v3) | `saveTypeTable` |
| ObjM 1 | ObjectModule::DoStream v0x49 (compressed) | `saveObjectModule` |
| HOUS 0 | HouseViewer::DoStream (GlobalDispatch 0x92) | `saveHouseViewer` |
| THMB 512, BMP_ 513/512, THMB 1024, BMP_ 1025/1024 | HouseViewer::SaveThumbnail / SaveUnleashedThumbnail | `saveHouseThumbnails` (`world/thumbnail.ts`), see "Thumbnails" |

3. **Chunk metadata and leftovers:**
   - Flags are 0x10, except for the thumbnails (0, label "Thumbnail" on the BMP_s, "" on the THMBs).
   - Arry labels are the c2DArray names, and `"1"` for the legacy copies (ids 1/2/101/102).
   - Any other chunk of the loaded file is kept after the generated ones.

## Formats ported

- **ReconBuffer write** (`reconwriter.ts`):
  - Compressed integers: a non-zero bit, then a 2-bit scheme index (the first scheme whose sign-extension mask matches), then n bits MSB-first.
  - Strings: the bit counter is reset, the C string is written, then padded to an even length. The pad byte is not written, so the original files contain garbage there.
  - ReconMark: patches the previous mark with the current position.
  - `ReconBuilder::Compact` header: `0, version, tag reversed`.
- **c2DArray RLE**: a run of 8 or more equal bytes becomes a repeat block (`n | 0x8000`). The bytes before it form a literal block. Blocks are at most 0x7fff bytes and padded to an even length with 0.
  - Checked in Python on 11,464 Arry chunks from every neighborhood: **all byte-identical**.
- **Usage maps**:
  - Patterns are marked from the floor arrays, and from wall segments using the original walk, which stops at 0x20.
  - Patterns are scanned from 0x1e (floors) or 0x1f (walls), skipping 0xff or 0xf8..0xff.
  - One entry per plugin file. The file name is lowercased.
- **objt**:
  - Every selector with instances gets an index in folder order (ObjSelector +0xa8).
  - Each record holds: GUID, `Behavior::GetCumulativeTreeVersion` for the init and main trees (ported), index, OBJD type, catalog name, and OBJD +0x8c.
  - Catalog name: CATS, or CTSS in French with no English fallback. If empty, `"*"` + the OBJD label. It is `""` for multi-tile parts.
- **ObjM**:
  - Header list, then a mark. Then, per object:
    - cXObject: the header with a constant 1, attributes, temps, data, a 0, the TreeStack, then RelMatrix (always the -1 form).
    - Slots: a 0 followed by the contained id. Then dynamic sprite flags.
    - The cXMTObject or cXPortal part, or for a person cXPerson: SAnimator, motives 16+16, person data 0x100, then XRoute count, current and last Interaction, queue, ObjectRecords and MotiveIncs.
    - The simFlags int (not written for placeholders), then a mark.
  - After the objects: the selected person, the +0x38 vector and the final string.
  - The reader `world/objects.ts` now keeps that trailer and the load order. `personstream.ts` keeps the animator's scalars and the tail.
- **Module order**: loaded objects keep the stream order. Objects created at run time are prepended, newest first (`AddObject(..., false)`).

## Where the values come from

- **Live, from the simulator:**
  - Tree stacks: frames from `TreeStack`; the behavior is resolved to its selector via `SimModule.selectorOfBehavior`.
  - simFlags.
  - For people: motives, person data and MotiveIncs.
  - Globals, tick count, funds and seed.
  - `getSRandSeed()`.
- **From the world module:** position, rect, data, attributes, slots and relations.
- **Carried over from the loaded file (not modeled):**
  - SIMI: cursor, +0x9c, and the int blocks at +0x184 and +0xe4.
  - HOUS 1.
  - HOUS 0: roof pitch and roof pattern. The +0x49 dynamic cutaway byte (low byte of the first int) is the
    current `WallManager.dynamicCutaway` on an in-game save (`dynamicCutaway` of `HouseSaveInput`);
    a save without a viewer (MoveOut) carries the whole chunk.
  - Per person: dressing, accessories, practices, and the route count of the tail.
  - The current and last interactions and the queue are restored at load (`PersonSim.restoreInteractions`, in `Simulator.postLoad`) and saved live (`PersonSim.savedInteraction`); the names come back from the tree table entry, as Interaction::GetName does.

## Checks (House01, UserData)

- **Unmodified lot loaded with `?nosim`**, with the type table kept in the loaded order (`keepLoadedTypeOrder`, a dev option):
  - Byte-identical: SIMI, HOUS 1, ObjM (50,252 compressed bytes), all non-plugin Arry chunks, and the thumbnails.
  - objt matches field for field; only the string pad bytes differ.
  - Chunk order is identical.
- **SIMI from a freshly created Simulator, before any tick:** byte-identical.
- **With the simulator running:** objt matches field for field. This includes the recomputed cumulative tree versions and the French names.
- **Expected differences:**
  - FLRm/WALm, and Arry floors/walls (11, 1, 12, 2): the loader renumbers plugin patterns to this session's numbering, as `LoadUsageMapAndUpdate` does.
  - HOUS 0: the view origin is clamped to our viewport.
  - objt in real folder order: our scan order differs from that of the machine that wrote the file.
- **In the browser:**
  - Built a wall segment (−75 §) and saved; after a reload, the wall and the funds are there.
  - Bought a plant (−120 §) and saved; after a reload, the object (id 202) and the funds 66,404 § are there.
  - The test overlay files were deleted afterwards.

## Thumbnails (HouseViewer::SaveThumbnail, `world/thumbnail.ts`)

- GlobalDispatch(0x92) on the HouseViewer writes HOUS 0, then (HouseViewer +0x4f, set by the constructor and
  never cleared) SaveThumbnail(file, 0x200) and SaveUnleashedThumbnail(file, 0x400). SaveLowMemoryThumbnail
  (BMP_ 612/613 copied from an application resource BMP_ 1000) writes nothing on the PC.
- SaveThumbnail: w = ((maxX - minX) + view width) >> (zoom + 1), h likewise (GetOffsetsMinMax at the current
  zoom), offsets maxX / maxY divided by 1 << (zoom - 1); daytime (cSimulator +0x18 = 0, terrain time of day,
  AllRoomsLightingChanged), terrain detail 2; two MakeThumbnail passes into one buffer: pass 0 the lot, pass 1
  adds the roof (+0x51, SetRoofDetail(2)). Each pass: ShrinkWrap (transparent margins), BMP_ 512 + pass =
  the cropped image (MakeMemoryBMP, 24-bit, header sizes 0). THMB 512 = ThumbnailInfo { x - left0, y - top0, z,
  left1 - left0, top1 - top0 }. Unleashed: size halved, scale 0.125 instead of 0.25, ids 0x400.
- MakeThumbnail: buffer (0.5 + w / f) x (0.5 + h / f) cleared to the transparent color (GetClearColor in
  thumbnail mode, +0x17c / +0x182), view rect = buffer, zoom 1, rotation 0, level 2, cutaway +0x48 and dynamic
  cutaway +0x49 off, SetOffsets, grid overlay hidden, **+0x50 set: RenderTerrainRow, RenderStaticRow and
  RenderDynamicObjects skip tiles with flag 0x20** (the road side). ThumbnailInfo: the average lot tile (flag 0x20
  clear) through TileToPoint (level 1, altitude 0) >> 2 (f 0.25) or >> 3 (f 0.125); z = +0x1f4 (GetOffsetsMinMax's
  lowest row term) shifted the same. Then ScaleBitmap(f): separable cubic 2|t|^3 - 3|t|^2 + 1 stretched by 1/f,
  mirrored edges, normalized weights, transparent pixels excluded, a pixel stays transparent under 0.46875 of
  opaque weight; buffers are 16-bit 555 (the shipped BMP_ colors are multiples of 8).
- Port: the lot view's HouseViewer renders the buffer in pieces of its own WebGL target (origin moved per piece,
  `readPixels`), with its state switched and restored like MakeThumbnail does. Additive hooks:
  `HouseViewer.thumbnailClearColor` (+0x17c / +0x182), `isThumbnailHidden` (+0x50, used by the row renderers and
  `ObjectModuleDrawer.drawDynamicObjects`), `getOffsetsMinMax(viewW, viewH)` returning `low` (+0x1f4);
  `WinLotView.terrain` made public. `buildHouseFile({ thumbnails })` calls it after HOUS 0; without it the loaded
  file's thumbnails are carried (dev checks).
- MoveOut: the original saves with its one HouseViewer holding the loaded lot (hidden behind the neighborhood
  screen). `withHouseThumbnails` opens a view (Compositor, HouseViewer, terrain, walls, objects, rooms and
  lighting, as WinLotView::init without the simulator and people) on the saved bytes at HOUS 0's zoom, renders
  the thumbnails and puts them after HOUS 0; the WebGL context is released afterwards.
- The neighborhood re-reads the house file: `writeGameFile` clears the IFF cache, and EvictFamily calls
  cWinLotBtn::ReloadThumbnail.
- Checked (UserData, overlay, deleted afterwards): saving House01 gives THMB 512 [159, 92, 2, 0, 0], BMP_ 512/513
  318 x 172, THMB 1024 [79, 45, 1, 0, 0], BMP_ 1024/1025 159 x 85: chunk order, BMP headers and sizes identical
  to the file the game itself saved; the transparent silhouette matches pixel for pixel, mean color difference
  3/255 (the lot changed since). Save 0.75-1.2 s (headless Chrome, swiftshader). Bulldozing house 3
  (moveOutHouse, 1.3 s): the neighborhood screen shows the empty lot.
- No people, as in the original: MakeThumbnail runs UpdateStaticLayer and RenderDynamicObjects only; the 3D
  objects (people's meshes, carried 3D objects) are drawn by Render3DObject, which only UpdateStaticDynamic,
  GenerateSnapshot and DrawPictureInPicture call. A person still gets cXPerson::DrawIso from the dynamic list
  (the sprite object in its hand; its sprite slots draw nothing at scale 1). House01, saved by the game with its
  family on the lot, has no person in BMP_ 512 / 513.
- Roof pass: RenderRoofPolys of both roof layers. The roof texture is loaded before the synchronous render
  (`prepareHouseThumbnails`, `HouseViewer.prepareRoof`); `withHouseThumbnails` also reads HOUS 0's roof
  settings (loadRoofSettings) and gives the roof generator the objects (stairs test), as WinLotView::init does.
- Terrain colors: SaveThumbnail calls cTerrain::SetColor (cSimulator global 10, the house number: sand, snow,
  leaves, soil, clouds or dirt) at time 0 and again with the restored time. The lot view now calls it too
  (Neighborhood::LoadHouse, cSimulator::SetCurrentHour), so the Vacation / Magic Town lots have their ground
  colors (`houseNumberOfPath`, terrain.ts).
- Water: RenderTerrainRow draws the water tiles inside the tile body that +0x50 skips on flag-0x20 tiles; the
  port does the same (House92: the pond matches).
- Checked against the game's files (2026-11-03, `withHouseThumbnails` on each UserData house at 1024 x 668):
  the houses written by this build (HOUS 0 version 0x49: House01, 04, 69, 92, 95, 99) give THMB 512, BMP_ 512
  / 513 sizes and silhouettes identical to the shipped ones (House92 mean color difference 2.6/255, House01
  2.0). Files written by older builds (HOUS 0 versions 0x3e..0x48) are one pixel wider at the left and right
  tips of the lot (THMB x one more), whatever the view size or saved zoom, which the port's output does not
  depend on: an older build's rendering, not a port difference. Before the roof fix, THMB dy was 0 where the
  game's files have -1 / -2 (House81, 85, 90): it now matches on House81 / 85.
- Pixel format (2026-11-06): the buffers are in the display format (App+0x34; 565 on the Windows display
  the port assumes). ScaleBitmap reads / writes them with Cvt565toRGB / CvtRGBto565 (format 2) or the 555
  pair (format 1), and SaveThumbnail's MakeMemoryBMP(..., true) turns 565 into 555 (pixel >> 1) only when
  writing the BMP_. The port used to cut the render to 555 before ScaleBitmap, so the filter averaged
  5-bit greens and truncated again: the green came out one 5-bit level low on about a quarter of the
  pixels. The terrain colors themselves were right.
- MakeThumbnail clears lbl_105BA240[0x39] (the anti-aliasing option) and calls InitSpr2Decoder(1) for the
  render: z-sprites go through Spr2DecoderNoAlpha*, which draw alpha pixels opaque with a depth write
  (Magic Town trees: opaque foliage in the game's thumbnails). The port sets `Compositor.spr2NoAlpha`
  while `thumbnailClearColor` is set (`HouseViewer.render`).
- Rotation (2026-11-06): SaveThumbnail / SaveUnleashedThumbnail take the offsets from GetOffsetsMinMax at
  the view's current rotation (the lot view's, or the one HouseViewer::DoStream read from HOUS 0 +0x1c);
  MakeThumbnail renders at rotation 0 but clamps those offsets for its buffer. At 1/4 the clamp range is a
  single row, at 1/8 it is four (House01: 144..148), so the 1/8 render moved by up to half a thumbnail pixel.
  `withHouseThumbnails` now sets HOUS 0's rotation (version > 8) like DoStream: House01 (saved at
  rotation 1) gives BMP_ 1024 / 1025 159 x 85 as the game's file (it was 158 x 86), silhouette identical,
  mean color difference 0.6 / 255; House01, 04, 69, 81, 85, 90, 92, 95, 99 now give the game's THMB and
  BMP_ sizes for both pairs.
- Gaps: House90: the roof generator leaves the upper terrace unroofed where the game
  roofs it (roofs.ts). Some objects differ from the game's thumbnails: Magic Town trees drawn pale, pumpkins
  darker (object rendering, also in the lot view).

## Neighborhood side of SaveGame / SaveHouse (`world/savegame.ts`)

- **House family** (`houseFamilyOf`): House +0x10 as Neighborhood::LoadHouse sets it, the first family whose
  +0x110 (house) or +0x13c (vacation lot) is the lot, else family 0. A vacation lot with its family on it
  therefore goes through SaveHouse, as in the original.
- **Town / community branch** (sims on the lot, global 32 clear): the selected person's family gets the funds as
  its budget (only +0x118: its flags are left alone), then `NeighborhoodStore.saveAllPersistentDataForMatterTransferance`
  (Neighborhood.c 100ab830): neighbors in order, the walk stopping at the first empty slot; the person on the lot
  with the neighbor's GUID copies its persistent fields into the neighbor its person data 0x1f names. Then
  Neighborhood::Save. The same SaveGame runs when leaving by taxi (cSimsApp::SwitchLots) and from DoSave (Options >
  Neighborhood, "Yes").
- **SaveHouse, before House::SaveFile** (`saveHouseBudget`, Neighborhood.c 100a6d00): a real family gets the funds
  and loses +0x138 bit 3 (bits 0 / 1 from ComputeStats, which House::SaveFile only sets when the family id is not 0).
  Family 0 gets budget 0, except on a town or community lot (21..30, 40..49, zoning 2, 81..89, 93..98) where it has
  a member: the family of that member's person on the lot (person data 0x3d) then gets family 0's budget and loses
  bit 3 (no neighborhood shipped has a family-0 member).
- **SaveHouse, after House::SaveFile** (`deleteUnhousedCharacters`): DeleteCharacter of every neighbor that is a
  character (ObjSelector +0xb4 bits 2-3 = 1, `ObjectFolder.sourceOfGUID`) with person data 0x3d (family) and 0x43
  (house) both 0, its people on the lot killed first; then Neighborhood::Save. The NPC neighbors (maid, townie
  templates...) also have family 0 / house 0 but come from the objects or downloads folders and are not touched. The
  original loops until none is left (a refused deletion would loop forever); the port walks the list once.
- **ExportUnoccupiedLot** (cSimsApp.c 102422e0), after SaveHouse when the lot was opened without sims (global 32):
  `Export/L<NN>` + `.rdt` (zoning 1), `.cmt` (zoning 2, not Magic Town), `.dtl`, `.stl`, `.mtl`, `.vil` (town lots);
  `L<NN>.<ext>` and `L<NN>.srf` are deleted, the saved house file is copied, and its STR# 2000 (StringSetBase:
  current language, empty comments, flags 0x10) gets entries 1 / 2 = the lot's name and description from
  `Houses/<DT|ST|MT|VI>Desc.iff` or `NeighborhoodDesc.iff` STR# 2000 + house (line breaks become spaces) and 3 = the
  house number. Strings at lbl_105BC2E0 + 0x321..0x3aa (mac.bin). The import side (`nbhd/imports.ts
  getLotImportInfo`) reads these three entries and BMP_ 512.
- **MoveOut** (`world/moveout.ts`) runs the same SaveHouse parts, House::ClearRouteHistory (HOUS 1 rewritten by
  `saveHouseRecon`: SimpleReconObject<House>::DoStream, name then six (+0x34, +0x30) pairs; the five past days at
  NeighborhoodConstants "fill value for layout history" 200, today 0), and LoadHouse's Tutorial object (GUID
  0xc3249a1d) and "import lot" broadcast (lbl_105BB990 + 0x13e, when the house file holds EXPi resources).
  `saveHouseRecon` re-encodes the shipped version 0x49 HOUS 1 chunks byte for byte (older versions differ only in
  the version word and the string pad byte).

## SaveGame's ExportFamily, LoadHouse's "import lot" (2026-11-05)

- cSimsApp::SaveGame (Mac 1024f010), after Neighborhood::SaveHouse succeeds: when the house family (House +0x10,
  `houseFamilyOf`) is not family 0 and GetZoningType(current house) == 1, Neighborhood::ExportFamily(<neighborhood
  dir> + GetStringConstant(0x57) "Export" + "/", family), result ignored; then, when FreeMem > 0xa00000 and
  cOptionsMgr::GetExportHTML, ExportFamilyHTML(family id); then ExportUnoccupiedLot when global 32.
  Port: `saveGame` (world/savegame.ts) calls `NeighborhoodStore.exportFamily` after `store.save()`, then
  `exportFamilyHTML` (nbhd/exporthtml.ts; FreeMem taken as above the limit) with the lot view, before
  `exportUnoccupiedLot`.
- The import list: the original's CycleThroughImports / CheckForNewImports only read <dir>/Import
  (cTSDirectory + pattern); GetImportInfoForFile checks only EXPi 0 and the FAMI it names. There is no filter of
  exported families in the original: it never looks at Export/. The port's web stand-in (the other
  neighborhoods' Export/*.FAM offered after Import/, nbhd/imports.ts) now leaves the current neighborhood's own
  Export/ out, so a save does not offer the family it just saved.
- Neighborhood::LoadHouse (Mac 100a7010): after the Tutorial object, the move-in "reset lot" and the person pass,
  BroadcastMessage("import lot", 0) (lbl_105BB990 + 0x13e) when the house file's count of EXPi resources (read
  before the file is closed) is not 0. WinLotView.init does the same after `resetLotForMoveIn`.

## Gaps

- Save failure: the message uses UIText 0x99 entries 0xf/0x10, which is not verified visually.
- RelMatrix null entries are dropped when loading, so they are not written back.
