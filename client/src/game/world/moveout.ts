/**
 * The house file side of Neighborhood::MoveOut(house, bulldoze), run from
 * the neighborhood screen (cWinNeighborhoodUL::EvictFamily) without showing
 * the lot.
 *
 * The family side (Family +0x110 = 0, +0x138 bit 3 cleared, budget =
 * GetFamilyNetWorth, lot value 0) is NeighborhoodStore.moveOutFamily; it has
 * run when this starts, as in the original where MoveOut clears +0x110 and
 * saves the neighborhood before LoadHouse. Then:
 *
 * 1. Neighborhood::LoadHouse(house): House::LoadFile (the tile arrays, the
 *    floor / wall usage maps, the object module), ObjectModule::PostLoad (the
 *    simulator: Load / Init trees), and its person pass: people of no family
 *    whose person data 0x43 is another house, and people of a real family
 *    that has no house any more (the evicted one) are killed. Then the
 *    Tutorial object (GUID 0xc3249a1d) is made on a tutorial lot
 *    (nbhd/tutorial.ts makeTutorialObject) and, when the house file holds an
 *    EXPi resource (a lot that came with an imported family), every object's
 *    "import lot" tree runs. LoadHouse's move-in part ("reset lot") needs a
 *    family moving in, which never happens here (the house has none).
 * 2. ObjectModule::BroadcastMessage("evict lot", 0): every object's BHAV of
 *    that name runs once (Bills has one).
 * 3. Every object not held by another (PlacementSpec +0xc == 0) for which
 *    cXObject::IsDeletedByEvict holds is killed. On a bulldoze, also the
 *    objects out of the world whose OBJD +0x54 is 0, and those without
 *    movement flag 0x10 standing on a tile without flag 0x20.
 * 4. Bulldoze: on both levels, every inner tile (1 .. size - 2) without flag
 *    0x20 loses its floor and its walls (cFixedWorld::SetWall with an empty
 *    TileWalls); the pool layer is cleared (cPoolLayer::Clear).
 * 5. Funds 0, global 26 (tutorial house) 0, cSimulator::ClearHistory (the
 *    SIMI history blocks and global 28), House::ClearRouteHistory (HOUS 1:
 *    the layout history reset, world/housesave.ts saveHouseRecon),
 *    GlobalDispatch(0x91) (ComputeRooms).
 * 6. Bulldoze: Neighborhood::DeleteCharacter for each neighbor whose
 *    Neighbor +0xfa (person data 0x43) is the house, until one is refused;
 *    the person objects with that GUID are killed first.
 * 7. GViewer::SetLevel(1), then Neighborhood::SaveHouse
 *    (world/savegame.ts): the house family's budget (family 0, nobody living
 *    here any more: 0), House::SaveFile (the stats, then world/housesave.ts),
 *    then DeleteCharacter of the characters of no family and no house. The
 *    caller saves the neighborhood (Neighborhood::Save ends SaveHouse).
 *
 * The thumbnails SaveFile writes come from a view opened on the saved file
 * (world/thumbnail.ts withHouseThumbnails): the original renders them with
 * its one HouseViewer, which holds the loaded lot.
 */

import type { GameContext } from "../context.js";
import { loadBuildCatalog } from "../data/buildcatalog.js";
import { writeGameFile } from "../data/files.js";
import { buildIff, parseIff } from "../data/iff.js";
import type { NeighborhoodStore } from "../data/nbhdstore.js";
import { makeTutorialObject } from "../nbhd/tutorial.js";
import { PDX } from "../sim/person.js";
import type { WorldHooks } from "../sim/simmodule.js";
import { G, Simulator } from "../sim/simulator.js";
import { FloorGraphicsMgr } from "./floors.js";
import { buildHouseFile, moduleOrder } from "./housesave.js";
import { isDeletedByEvict, summarizeHouseStats } from "./housestats.js";
import { ResFile } from "./iffres.js";
import { loadLotModule, OD, type XObject } from "./objects.js";
import { computeRooms, RoomManager } from "./rooms.js";
import { deleteUnhousedCharacters, saveHouseBudget } from "./savegame.js";
import { TileWalls } from "./tilewalls.js";
import { withHouseThumbnails } from "./thumbnail.js";
import { killObject, makeNewOutOfWorldObject } from "./tools/objectfactory.js";
import { Placement } from "./tools/placement.js";
import { fixedSetWall, setFixedFloor } from "./tools/worldedit.js";
import { WallGraphicsMgr } from "./wallgraphics.js";
import { readLotSize } from "./winlotview.js";
import { FixedWorld } from "./world.js";

/** lbl_105BB990 + 0x1a8: the message MoveOut broadcasts. */
const EVICT_LOT = "evict lot";
/** lbl_105BB990 + 0x13e: the message LoadHouse broadcasts when the house file holds an EXPi resource. */
const IMPORT_LOT = "import lot";
/** cXObject +0xa0 bit 4: never deleted by an eviction (also spares a bulldozed tile's object). */
const MV_KEEP = 0x10;
/** Tile flag 0x20: the tile cannot be edited (the road side); a bulldoze leaves it. */
const TILE_LOCKED = 0x20;
/** Person data 0x43 (Neighbor +0xfa / cXPerson +0x612): the house a character belongs to. */
const PD_HOUSE = 0x43;
/** Families LoadHouse never treats as residents: townies, tourists and the other NPC groups. */
function isResidentFamilyId(id: number): boolean {
  return id !== 0 && id !== 2000 && !(id >= 3000 && id <= 3009) && id !== 4000 && id !== 5000 && id !== 5500 && id !== 6000;
}

/** "%sHouses/House%02d.iff" */
export function housePathOf(nbhdDir: string, house: number): string {
  return `${nbhdDir}/Houses/House${String(house).padStart(2, "0")}.iff`;
}

/** The lot as Neighborhood::LoadHouse leaves it, without a view. */
interface HeadlessLot {
  house: ResFile;
  fixed: FixedWorld;
  floors: FloorGraphicsMgr;
  walls: WallGraphicsMgr;
  module: Awaited<ReturnType<typeof loadLotModule>>["module"];
  folder: Awaited<ReturnType<typeof loadLotModule>>["folder"];
  sim: Simulator;
  placement: Placement;
}

/**
 * The placement side of the simulator's primitives for a lot nobody looks at
 * (the WinLotView's createObjectHooks without the redraws).
 */
function headlessWorldHooks(lot: Omit<HeadlessLot, "sim">): WorldHooks {
  const p = lot.placement;
  return {
    selector: (guid) => lot.folder.selectorByGUID(guid),
    make: (sel) => makeNewOutOfWorldObject(p, lot.folder, sel),
    canPlace: (obj, pos, level, container, slot) => {
      p.error = 0;
      p.obstacle = null;
      return p.canPlace(obj, pos, level, container, slot);
    },
    place: (obj, pos, level, container, slot) => p.place(obj, pos, level, container, slot, true),
    sectWall: (obj, pos, level) => p.sectWallAt(obj, pos, level),
    moveTo: (obj, pos, level) => p.setLocation(obj, pos, level),
    pickup: (obj) => p.pickup(obj, true),
    turn: (obj, n) => p.turnObject(obj, n),
    findGoodLocation: (obj, start, level, opts) => p.findGoodLocation(obj, start, level, opts),
    kill: (obj) => {
      if (lot.module.objects.get(obj.objectId) === obj) killObject(p, obj);
    },
    lastError: () => ({ code: p.error, obstacle: p.obstacle?.objectId ?? 0 }),
  };
}

/** House::LoadFile + ObjectModule::PostLoad (Neighborhood::LoadHouse's file part). */
async function loadHouseHeadless(path: string): Promise<HeadlessLot> {
  const house = await ResFile.open(path);
  const fixed = FixedWorld.load(house, readLotSize(house));
  const floors = new FloorGraphicsMgr();
  await floors.initialize();
  await floors.loadUsageMap(house, fixed);
  const walls = new WallGraphicsMgr();
  await walls.initialize();
  await walls.loadUsageMap(house, fixed);
  const { module, folder } = await loadLotModule(house, fixed);
  let sim: Simulator | null = null;
  const placement = new Placement(module, fixed, { onKill: (obj) => sim?.module.removeObject(obj) });
  sim = await Simulator.create(house, module.objects.values(), folder.packs);
  const lot = { house, fixed, floors, walls, module, folder, placement };
  sim.module.worldHooks = headlessWorldHooks(lot);
  return { ...lot, sim };
}

/** ObjectModule::KillObject (all parts; the simulator drops them through the placement hook). */
function kill(lot: HeadlessLot, obj: XObject): void {
  if (lot.module.objects.get(obj.objectId) === obj) killObject(lot.placement, obj);
}

/** The person data of a person object: the simulator's (persistent data applied), else the saved one. */
function personData(lot: HeadlessLot, obj: XObject): Int16Array | null {
  return lot.sim.module.persons.find((p) => p.obj === obj)?.pd ?? obj.personRecord?.personData ?? null;
}

/** Neighborhood::LoadHouse's person pass after PostLoad. */
function killStrayPeople(lot: HeadlessLot, store: NeighborhoodStore, house: number): void {
  for (const obj of [...lot.module.objects.values()]) {
    if (!obj.isPerson) continue;
    const pd = personData(lot, obj);
    if (!pd) continue;
    const family = pd[PDX.familyNumber]!;
    if (family === 0) {
      if (pd[PD_HOUSE] !== house) kill(lot, obj);
      continue;
    }
    const f = store.family(family);
    if (f && isResidentFamilyId(f.id) && f.houseNumber === 0) kill(lot, obj);
  }
}

/** ObjectModule::BroadcastMessage(name, param): each object's BHAV `name` runs once, from its own stack. */
function broadcastMessage(lot: HeadlessLot, name: string, param: number): void {
  const m = lot.sim.module;
  for (const o of [...m.list]) {
    if (o.killed) continue;
    const tree = o.behavior.getTreeID(name);
    if (tree === 0) continue;
    try {
      o.runOneTickTree(o.behavior, 0, tree, { src: [param, 0, 0, 0], at: 0 });
    } catch (e) {
      console.warn(`[moveout] ${name}: object ${o.id} failed`, e);
    }
  }
  m.runKillQueue();
}

/** PlacementSpec +0xc: the object holding this one's hierarchy (0 = none). */
function containerOf(lot: HeadlessLot, obj: XObject): XObject | null {
  return lot.placement.getPlacementSpec(obj).container;
}

/** Tile flags byte of an object's tile (an object out of the lot reads 0). */
function tileFlags(lot: HeadlessLot, obj: XObject): number {
  const f = lot.fixed;
  const x = obj.fx >> 4;
  const y = obj.fy >> 4;
  const a = f.flags[obj.level - 1];
  if (!a || x < 0 || y < 0 || x >= f.size || y >= f.size) return 0;
  return a.u8(x, y);
}

/** MoveOut's object pass: IsDeletedByEvict, and the bulldoze rules. */
function killEvictedObjects(lot: HeadlessLot, bulldoze: boolean): void {
  for (const obj of moduleOrder(lot.module)) {
    if (lot.module.objects.get(obj.objectId) !== obj || containerOf(lot, obj)) continue;
    let doomed = isDeletedByEvict(obj);
    if (!doomed && bulldoze) {
      const mv = obj.objectData[OD.movementFlags]!;
      if (!lot.placement.isInWorld(obj) && obj.selector.objd.i16(0x54) === 0) doomed = true;
      else if ((mv & MV_KEEP) === 0) doomed = (tileFlags(lot, obj) & TILE_LOCKED) === 0;
    }
    if (doomed) kill(lot, obj);
  }
}

/** MoveOut(bulldoze): floors, walls and the pool off the locked tiles. */
function bulldozeTiles(fixed: FixedWorld): void {
  const empty = new TileWalls();
  for (let level = 1; level <= 2; level++) {
    const flags = fixed.flags[level - 1]!;
    for (let y = 1; y < fixed.size - 1; y++) {
      for (let x = 1; x < fixed.size - 1; x++) {
        if (flags.u8(x, y) & TILE_LOCKED) continue;
        setFixedFloor(fixed, x, y, level, 0);
        fixedSetWall(fixed, x, y, level, { t: empty, rot: 0 });
      }
    }
  }
  // cPoolLayer::Clear: every tile of the lot rect becomes "no pool".
  for (let x = 0; x < fixed.size; x++) for (let y = 0; y < fixed.size; y++) fixed.pool.data[fixed.pool.offset(x, y)] = 0xff;
}

/** MoveOut(bulldoze): DeleteCharacter on the house's characters until one is refused. */
async function deleteHouseCharacters(lot: HeadlessLot, store: NeighborhoodStore, house: number): Promise<void> {
  for (const guid of store.charactersOfHouse(house)) {
    for (const obj of [...lot.module.objects.values()]) if (obj.isPerson && obj.guid >>> 0 === guid) kill(lot, obj);
    if (!(await store.deleteCharacter(guid).catch(() => false))) return;
  }
}

/** HOUS 0 (HouseViewer::DoStream): GViewer::SetLevel(1) before the save. */
function setSavedLevel(bytes: Uint8Array, level: number): Uint8Array {
  const chunks = parseIff(bytes);
  const hous = chunks.find((c) => c.type === "HOUS" && c.id === 0);
  if (!hous || hous.data.length < 32) return bytes;
  const v = new DataView(hous.data.buffer, hous.data.byteOffset, hous.data.byteLength);
  // version > 8 stores the rotation (short) after the four ints from 12; >= 0x1d the level.
  if (v.getInt32(4, true) < 0x1d) return bytes;
  v.setInt16(30, level, true);
  return buildIff(chunks);
}

/**
 * Neighborhood::MoveOut's house file part for `house` of the store's
 * neighborhood. Resolves false when the house could not be loaded or saved
 * (the caller then puts the family back, as MoveOut does).
 */
export async function moveOutHouse(ctx: GameContext, store: NeighborhoodStore, house: number, bulldoze: boolean, family = -1): Promise<boolean> {
  return evictHouse(ctx, store, house, bulldoze, false, family);
}

/**
 * Neighborhood::RemoveFromVacation's house file part (the family side,
 * NeighborhoodStore.removeFromVacation, has run): as MoveOut's, except that
 * global 9 (the house family) is zeroed after LoadHouse, every person not
 * held by another is killed after "evict lot", the evicted objects are only
 * killed on a bulldoze, and the funds are left as they are.
 */
export async function removeFromVacationHouse(ctx: GameContext, store: NeighborhoodStore, house: number, bulldoze: boolean): Promise<boolean> {
  return evictHouse(ctx, store, house, bulldoze, true);
}

async function evictHouse(ctx: GameContext, store: NeighborhoodStore, house: number, bulldoze: boolean, vacation: boolean, family = -1): Promise<boolean> {
  const path = housePathOf(store.dir, house);
  let lot: HeadlessLot;
  try {
    lot = await loadHouseHeadless(path);
  } catch (e) {
    console.error(`[moveout] LoadHouse ${path} failed`, e);
    return false;
  }
  const { sim, fixed } = lot;
  killStrayPeople(lot, store, house);
  // LoadHouse: the Tutorial object, then (the count of EXPi resources > 0) "import lot".
  await makeTutorialObject(lot.placement, lot.folder, sim.module, store.dir).catch((e: unknown) => console.warn("[moveout] tutorial object", e));
  if (parseIff(lot.house.data).some((c) => c.type === "EXPi")) broadcastMessage(lot, IMPORT_LOT, 0);
  if (vacation) sim.globals[9] = 0; // global 9: the house family
  // MoveOut: the evicted family's funds go into the simulator for "evict lot".
  if (family >= 0) sim.setFunds(store.familyBudget(family));
  broadcastMessage(lot, EVICT_LOT, 0);
  if (vacation) {
    // OBJD type 2 (a person) and held by nothing.
    for (const obj of moduleOrder(lot.module)) {
      if (lot.module.objects.get(obj.objectId) === obj && !containerOf(lot, obj) && obj.isPerson) kill(lot, obj);
    }
  }
  if (!vacation || bulldoze) killEvictedObjects(lot, bulldoze);
  if (bulldoze) bulldozeTiles(fixed);
  // MoveOut: the family keeps what the funds are after it, the lot's are 0, then the
  // family sells the lot (Family::GetNetWorth: budget + lot value, lot value 0).
  if (family >= 0) store.setFamilyBudget(family, sim.getFunds());
  if (!vacation) sim.setFunds(0);
  if (family >= 0) store.sellLot(family);
  sim.globals[26] = 0;
  sim.globals[G.daysRunning] = 0;
  computeRooms(fixed, new RoomManager(fixed));
  if (bulldoze) await deleteHouseCharacters(lot, store, house);
  try {
    const prices = (await loadBuildCatalog(ctx)).prices;
    const objects = new Map(moduleOrder(lot.module).map((o) => [o.objectId, o]));
    const st = summarizeHouseStats(objects, fixed, lot.walls, lot.floors, prices);
    // Neighborhood::SaveHouse: the house family's budget before House::SaveFile.
    const familyOfPerson = (guid: number): number | null => {
      const obj = [...lot.module.objects.values()].find((o) => o.isPerson && o.guid >>> 0 === guid >>> 0);
      return obj ? (personData(lot, obj)?.[PDX.familyNumber] ?? null) : null;
    };
    saveHouseBudget(store, house, sim.module.zoning.get(house) ?? 1, sim.getFunds(), st.familyFlags, familyOfPerson);
    const bytes = await buildHouseFile({
      house: lot.house,
      fixed,
      floors: lot.floors,
      walls: lot.walls,
      module: lot.module,
      folder: lot.folder,
      sim,
      viewer: null,
      rotation: 0,
      selectedPersonId: lot.module.selectedPersonId,
      stats: { objectValue: st.simA0, archValue: st.simA4, global16: st.lotHasHouse, global25: st.transitFilterFlags },
      clearHistory: true,
      clearRouteHistory: true,
    });
    // House::SaveFile's thumbnails (GlobalDispatch(0x92)), from a view of the saved lot.
    const saved = await withHouseThumbnails(path, setSavedLevel(bytes, 1), ctx.width, ctx.height - 100);
    await writeGameFile(path, saved);
    // SaveHouse after a successful House::SaveFile: the characters of no family and no house go.
    await deleteUnhousedCharacters(store, lot.folder, (guid) => {
      for (const obj of [...lot.module.objects.values()]) if (obj.isPerson && obj.guid >>> 0 === guid >>> 0) kill(lot, obj);
    });
  } catch (e) {
    console.error(`[moveout] SaveHouse ${path} failed`, e);
    return false;
  }
  return true;
}
