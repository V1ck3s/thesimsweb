/**
 * cSimsApp::SaveGame / DoSave for the lot view, and the lot's dirty flag
 * (cSimsApp +0xbf).
 *
 * SaveGame on a residential lot is Neighborhood::SaveHouse (saveHouseBudget,
 * then House::SaveFile: world/housesave.ts writes <neighborhood>/Houses/HouseNN.iff;
 * the stats ObjectModule::ComputeStats and cFixedWorld::ComputeArchValue
 * give go into the simulator's globals and the resident family's +0x138 bits
 * 0 / 1; then deleteUnhousedCharacters and Neighborhood::Save), followed,
 * when the lot was opened without sims (global 32), by ExportUnoccupiedLot.
 * On a community or town lot with sims on it only the visiting family's
 * budget is kept, Neighborhood::SaveAllPersistentDataForMatterTransferance
 * runs and the neighborhood is saved. After saving a residential lot whose
 * house family (House +0x10) is not family 0, SaveGame exports it
 * (Neighborhood::ExportFamily into <neighborhood>/Export/), then, when
 * FreeMem() > 0xa00000 (taken as true) and the "export HTML" option is on,
 * ExportFamilyHTML (nbhd/exporthtml.ts: the family's web pages).
 *
 * DoSave asks UIText STR# 0x99 entries 4 / 5 (message, title) with
 * Yes / No / Cancel when the lot is dirty: Cancel stays, Yes saves, No leaves.
 * The dirty flag here: the clock advanced, the funds changed or a buy /
 * build command was submitted, undone or redone since the lot was entered
 * or saved (the game sets it from most commands, cSimsApp::DoCommand).
 */

import type { GameContext } from "../context.js";
import { loadBuildCatalog } from "../data/buildcatalog.js";
import { deleteGameFile, writeGameFile } from "../data/files.js";
import { buildIff, decodeStrSet, encodeStrSet, parseIff } from "../data/iff.js";
import { NeighborhoodStore } from "../data/nbhdstore.js";
import { exportFamilyHTML } from "../nbhd/exporthtml.js";
import { loadStrSet } from "../nbhd/nghinterface.js";
import { getOptionsMgr } from "../optionsmgr.js";
import { LANG_FRENCH } from "../res/uires.js";
import { PDX } from "../sim/person.js";
import { G, type Simulator } from "../sim/simulator.js";
import { IDCANCEL, IDYES, MB_YESNOCANCEL, TSWinMsgBox } from "../ui/msgbox.js";
import { buildHouseFile, moduleOrder } from "./housesave.js";
import { summarizeHouseStats } from "./housestats.js";
import type { ObjectFolder } from "./objectfolder.js";
import { prepareHouseThumbnails, saveHouseThumbnails } from "./thumbnail.js";
import type { WinLotView } from "./winlotview.js";

/** UIText STR# 0x99 (0-based entries): the "save before leaving?" message and title. */
const SAVE_STRINGS = 0x99;
const SAVE_ASK_MESSAGE = 3;
const SAVE_ASK_TITLE = 4;
/** Entries 0xf / 0x10 (1-based): SaveGame's failure message and title. */
const SAVE_FAILED_MESSAGE = 0xe;
const SAVE_FAILED_TITLE = 0xf;

interface Snapshot {
  tick: number;
  funds: number;
  edits: number;
}

const saved = new WeakMap<WinLotView, Snapshot>();

function snapshot(lv: WinLotView): Snapshot {
  return { tick: lv.sim?.tickCount ?? 0, funds: lv.sim?.getFunds() ?? 0, edits: lv.editCount };
}

/** Marks the lot clean (entering it, after a save). */
export function markLotClean(lv: WinLotView): void {
  saved.set(lv, snapshot(lv));
}

/** cSimsApp +0xbf. */
export function isLotDirty(lv: WinLotView | null): boolean {
  if (!lv?.house) return false;
  const s = saved.get(lv);
  if (!s) return false;
  const now = snapshot(lv);
  return now.tick !== s.tick || now.funds !== s.funds || now.edits !== s.edits;
}

/** "UserData/Houses/House01.iff" -> 1. */
function houseNumber(path: string): number {
  const m = /House(\d+)\.iff$/i.exec(path);
  return m ? parseInt(m[1]!, 10) : 0;
}

/** Town lots: Downtown 21..30, Vacation 40..49, Studio Town 81..89, Magic Town 93..98. */
const isDowntown = (n: number): boolean => n > 0x14 && n < 0x1f;
const isVacation = (n: number): boolean => n > 0x27 && n < 0x32;
const isStudioTown = (n: number): boolean => n > 0x50 && n < 0x5a;
const isMagicTown = (n: number): boolean => n > 0x5c && n < 99;

/**
 * House +0x10 as Neighborhood::LoadHouse sets it: the first family whose
 * house (+0x110) or vacation lot (+0x13c) is `house`, else family 0.
 */
export function houseFamilyOf(store: NeighborhoodStore, house: number): number {
  if (house !== 0) {
    for (const id of store.familyIds()) if (store.family(id)?.houseNumber === house || store.familyVacationLot(id) === house) return id;
  }
  return 0;
}

/**
 * Neighborhood::SaveHouse before House::SaveFile: the house family's
 * budget. A real family gets the simulator's funds and loses +0x138 bit 3
 * (its +0x138 bits 0 / 1 come from House::SaveFile's stats: `statFlags`).
 * Family 0 (nobody lives here) gets 0, except on a town or community lot
 * where it has a member: then the family of that member's person on the
 * lot (`familyOfPerson`, person data 0x3d) gets family 0's budget and loses
 * bit 3.
 */
export function saveHouseBudget(
  store: NeighborhoodStore,
  house: number,
  zoning: number,
  funds: number,
  statFlags: number,
  familyOfPerson: (guid: number) => number | null,
): void {
  const id = houseFamilyOf(store, house);
  const fam = store.family(id);
  if (!fam) return;
  if (fam.id !== 0) {
    store.setFamilyBudgetAndFlags(fam.id, funds, ((fam.flags & ~3) | (statFlags & 3)) & ~8);
    return;
  }
  const town = isDowntown(house) || isVacation(house) || zoning === 2 || isStudioTown(house) || isMagicTown(house);
  const member = town ? fam.memberGuids[0] : undefined;
  if (member === undefined) {
    store.setFamilyBudgetAndFlags(0, 0, fam.flags);
    return;
  }
  const familyNumber = familyOfPerson(member);
  const target = familyNumber === null ? undefined : store.family(familyNumber);
  if (target) store.setFamilyBudgetAndFlags(target.id, fam.budget, target.flags & ~8);
}

/**
 * Neighborhood::SaveHouse after House::SaveFile: Neighborhood::DeleteCharacter
 * of every character (Neighbor::IsCharacter: its definition comes from the
 * Characters folder, ObjSelector +0xb4 bits 2-3 = 1) of no family (person
 * data 0x3d) and no house (0x43); DeleteCharacter kills the people with its
 * GUID on the lot first (`kill`). The original loops until none is left; a
 * refused deletion (a family still lists the person) would loop forever
 * there, here it is skipped.
 */
export async function deleteUnhousedCharacters(store: NeighborhoodStore, folder: ObjectFolder, kill: (guid: number) => void): Promise<void> {
  for (const guid of store.charactersOfHouse(0)) {
    if (store.getPersonData(guid)[PDX.familyNumber] !== 0 || folder.sourceOfGUID(guid) !== 1) continue;
    kill(guid);
    await store.deleteCharacter(guid).catch(() => false);
  }
}

/** PersonFinder::GetHandle(guid) + GetInstance on a running lot: the person data of the person with that GUID. */
function personDataOnLot(sim: Simulator): (guid: number) => Int16Array | null {
  return (guid) => sim.module.persons.find((p) => p.person && !p.killed && p.obj.selector.guid >>> 0 === guid >>> 0)?.person?.personData ?? null;
}

/**
 * cSimsApp::ExportUnoccupiedLot, after saving a lot opened without sims:
 * the house file is copied to <neighborhood>/Export/L<NN> + the lot kind's
 * extension (.rdt residential, .cmt community, .dtl / .stl / .mtl / .vil
 * town lots; L<NN>.<ext> and L<NN>.srf are deleted first), and STR# 2000
 * of the copy (StringSetBase: the current language) gets entries 1 / 2,
 * the lot's name and description from Houses\<Town>Desc.iff (or
 * NeighborhoodDesc.iff) STR# 2000 + house in the current language (line
 * breaks of the description become spaces), and 3, the house number
 * ("%d"), which is what nbhd/imports.ts reads back.
 */
export async function exportUnoccupiedLot(nbhdDir: string, house: number, zoning: number, houseBytes: Uint8Array): Promise<void> {
  const base = `${nbhdDir}/Export/L${String(house).padStart(2, "0")}`;
  const community = zoning === 2 && !isMagicTown(house);
  let ext = "";
  if (zoning === 1) ext = ".rdt";
  else if (community) ext = ".cmt";
  else if (isDowntown(house)) ext = ".dtl";
  else if (isStudioTown(house)) ext = ".stl";
  else if (isMagicTown(house)) ext = ".mtl";
  else if (isVacation(house)) ext = ".vil";
  let desc: string | null = null;
  if (isDowntown(house)) desc = "DTDesc.iff";
  else if (isStudioTown(house)) desc = "STDesc.iff";
  else if (isMagicTown(house)) desc = "MTDesc.iff";
  else if (isVacation(house)) desc = "VIDesc.iff";
  else if (community || zoning === 1) desc = "NeighborhoodDesc.iff";
  // IFFResFile2::Delete of both names, then CopyFile of the house file.
  for (const path of [`${base}${ext}`, `${base}.srf`]) await deleteGameFile(path).catch(() => undefined);
  const strings = desc ? await loadStrSet(`${nbhdDir}/Houses/${desc}`, 2000 + house, LANG_FRENCH).catch(() => null) : null;
  const name = strings?.[0] ?? "";
  const description = (strings?.[1] ?? "").replace(/\n/g, " ");
  // StringSetBase::Load(2000) of the copy, SetString 1..3, Save.
  const chunks = parseIff(houseBytes);
  const old = chunks.find((c) => c.type === "STR#" && c.id === 2000);
  const all = old ? decodeStrSet(old.data) : [];
  const values = (all.some((e) => e.lang === LANG_FRENCH) ? all.filter((e) => e.lang === LANG_FRENCH) : all.filter((e) => e.lang === 1)).map((e) => e.value);
  values[0] = name;
  values[1] = description;
  values[2] = String(house);
  const data = encodeStrSet(values.map((value) => ({ lang: LANG_FRENCH, value: value ?? "", comment: "" })));
  if (old) old.data = data;
  else chunks.push({ type: "STR#", id: 2000, flags: 0x10, label: "", data });
  await writeGameFile(`${base}${ext}`, buildIff(chunks));
}

/** cSimsApp::SaveGame; resolves false when the save failed (the game's message was shown). */
export async function saveGame(ctx: GameContext, lv: WinLotView | null, nbhdDir: string): Promise<boolean> {
  const house = lv?.house;
  const viewer = lv?.viewer;
  const lot = lv?.lotObjects;
  const walls = lv?.wallManager;
  if (!lv || !house || !viewer || !lot || !walls) return false;
  const sim = lv.sim;
  const n = houseNumber(lv.housePath);
  // cSimsApp::SaveGame: cDDDSimsView::StartWatchCursor (the hourglass until the view paints after the save).
  lv.startWatchCursor();
  try {
    const store = await NeighborhoodStore.open(nbhdDir).catch(() => null);
    // SaveGame starts with Neighborhood +0x12e = 1: the tutorial lot loses its
    // arrow on the neighborhood screen once a game was saved.
    if (store && store.ngbh().shorts[3] !== 1) {
      store.ngbh().shorts[3] = 1;
      store.touchNgbh();
    }
    const zoning = sim?.module.zoning.get(n) ?? 1;
    // cSimsApp::SaveGame: with sims on the lot (global 32 clear), a town lot
    // (21..30, 81..89, 93..98), a community lot or a vacation lot no family
    // lives on is not saved; the visitors' money goes back to them. Opened
    // without sims (global 32 set, buy mode) it is saved as any lot.
    const noSims = (sim?.globals[G.freeFunds] ?? 0) !== 0;
    const townLot = isDowntown(n) || isStudioTown(n) || isMagicTown(n);
    if (!noSims && (townLot || zoning === 2 || (isVacation(n) && (!store || houseFamilyOf(store, n) === 0)))) {
      if (store && sim) {
        // The selected person's family (person data 0x3d) gets the funds as its budget.
        const visitor = lv.selectedPerson();
        const fam = visitor ? store.family(visitor.pd[PDX.familyNumber] ?? 0) : undefined;
        if (fam) store.setFamilyBudgetAndFlags(fam.id, sim.getFunds(), fam.flags);
        store.saveAllPersistentDataForMatterTransferance(personDataOnLot(sim));
        await store.save();
      }
      markLotClean(lv);
      return true;
    }
    const prices = (await loadBuildCatalog(ctx)).prices;
    const fixed = viewer.world.fixed;
    const objects = new Map(moduleOrder(lot.module).map((o) => [o.objectId, o]));
    const st = summarizeHouseStats(objects, fixed, walls.gfx, viewer.floors, prices);
    // Neighborhood::SaveHouse: the house family's budget, before House::SaveFile.
    if (store) {
      const familyOfPerson = (guid: number): number | null => (sim ? (personDataOnLot(sim)(guid)?.[PDX.familyNumber] ?? null) : null);
      saveHouseBudget(store, n, zoning, sim?.getFunds() ?? 0, st.familyFlags, familyOfPerson);
    }
    // The thumbnails' roof texture, before the save's synchronous part.
    await prepareHouseThumbnails(viewer);
    // House::SaveFile: XViewer::IssueToolSelection(0) after the stats, before the world is saved.
    // A pool or water tool keeps its pools out of the world layer while selected; Deselect puts them back.
    lv.gameTools?.issueToolSelection(null);
    const sel = lv.selectedPerson();
    // ObjectModule::Save: PickupAndKillPlumbBobs before the objects are written (no bob is
    // saved), then InitPlumbBobs / OnSelectionChange / OnStarPowerChange.
    lv.plumbBobs?.pickupAndKillPlumbBobs();
    const building = buildHouseFile({
      house,
      fixed,
      floors: viewer.floors,
      walls: walls.gfx,
      module: lot.module,
      folder: lot.folder,
      sim,
      viewer,
      rotation: viewer.world.rotation,
      selectedPersonId: sel ? sel.id : lot.module.selectedPersonId,
      stats: { objectValue: st.simA0, archValue: st.simA4, global16: st.lotHasHouse, global25: st.transitFilterFlags },
      thumbnails: () => saveHouseThumbnails({ viewer, walls, lighting: lv.lighting, terrain: lv.terrain, houseNumber: houseNumber(lv.housePath) }),
    });
    const bytes = await building.finally(() => lv.plumbBobs?.afterSave());
    await writeGameFile(lv.housePath, bytes);
    if (store) {
      // House::SaveFile's cXPerson::PreSave: Neighborhood::SavePersistentData of each person.
      if (sim) for (const p of sim.module.persons) if (p.person && !p.killed) store.savePersistentData(p.obj.selector.guid >>> 0, p.person.personData);
      await deleteUnhousedCharacters(store, lot.folder, (guid) => {
        if (sim) for (const p of [...sim.module.persons]) if (!p.killed && p.obj.selector.guid >>> 0 === guid >>> 0) sim.module.killObject(p);
      });
      await store.save();
      // The house family (House +0x10) when it is not family 0 and the lot is residential:
      // Neighborhood::ExportFamily(<dir>/Export/, family), result ignored.
      const family = houseFamilyOf(store, n);
      if (family !== 0 && zoning === 1) {
        if (!(await store.exportFamily(family))) console.warn(`[save] ExportFamily ${family} failed`);
        // FreeMem() > 0xa00000 (taken as true) and cOptionsMgr::GetExportHTML: ExportFamilyHTML.
        if (getOptionsMgr().getExportHTML()) await exportFamilyHTML(ctx, store, family, lv).catch((e: unknown) => console.warn(`[save] ExportFamilyHTML ${family} failed`, e));
      }
    }
    if (noSims) await exportUnoccupiedLot(nbhdDir, n, zoning, bytes);
    markLotClean(lv);
    return true;
  } catch (e) {
    console.error("[save] failed", e);
    const str = (i: number): string => ctx.strings.get("UIText", SAVE_STRINGS, i);
    await TSWinMsgBox.show(ctx, str(SAVE_FAILED_MESSAGE), str(SAVE_FAILED_TITLE));
    return false;
  } finally {
    lv.endWatchCursor();
  }
}

/** cSimsApp::DoSave: false when the player cancelled. */
export async function doSave(ctx: GameContext, lv: WinLotView | null, nbhdDir: string): Promise<boolean> {
  if (!isLotDirty(lv) || houseNumber(lv?.housePath ?? "") === 0) return true;
  const str = (i: number): string => ctx.strings.get("UIText", SAVE_STRINGS, i);
  const r = await TSWinMsgBox.show(ctx, str(SAVE_ASK_MESSAGE), str(SAVE_ASK_TITLE), MB_YESNOCANCEL);
  if (r === IDCANCEL) return false;
  if (r === IDYES && !(await saveGame(ctx, lv, nbhdDir))) return false;
  return true;
}
