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
| HOUS 1 | SimpleReconObject\<House\> | copied (name + 12 ints, not modeled) |
| FLRm 0/1 | FloorGraphicsMgr::SaveUsageMap | `FloorGraphicsMgr.saveUsageMap` + `usagemap.ts` |
| WALm 0/1 | WallGraphicsMgr::SaveUsageMap | `WallGraphicsMgr.saveUsageMap` |
| Arry × 18 | cFixedWorld::Save → c2DArray::WriteToDisk | `saveFixedWorld` / `encodeC2DArray` |
| objt 0 | ObjectFolder::PrepareForModuleSave (v3) | `saveTypeTable` |
| ObjM 1 | ObjectModule::DoStream v0x49 (compressed) | `saveObjectModule` |
| HOUS 0 | HouseViewer::DoStream (GlobalDispatch 0x92) | `saveHouseViewer` |
| THMB/BMP_ | HouseViewer::SaveThumbnail | **copied from the loaded file** (not regenerated) |

3. **Chunk metadata and leftovers:**
   - Flags are 0x10, except for the thumbnails, which are copied as they are.
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
  - HOUS 0: the +0x49 byte, roof pitch and roof pattern.
  - Per person: dressing, accessories, practices, and the tail (routes, interactions, queue, ObjectRecords).
  - The runtime does not reload the saved queue. A live queue is therefore not saved; the loaded one is written back.

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

## Gaps

- Thumbnails are not regenerated (HouseViewer::SaveThumbnail).
- People's persistent data is not saved to the neighborhood at save time. In the original, cXPerson does this at other moments.
- Unoccupied lots (family +0x10c == 0): the budget is not saved. The family export (`ExportFamily`) and `ExportUnoccupiedLot` are not ported.
- Save failure: the message uses UIText 0x99 entries 0xf/0x10, which is not verified visually.
- RelMatrix null entries are dropped when loading, so they are not written back.
