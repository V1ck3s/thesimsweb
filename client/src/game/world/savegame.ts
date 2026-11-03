/**
 * cSimsApp::SaveGame / DoSave for the lot view, and the lot's dirty flag
 * (cSimsApp +0xbf).
 *
 * SaveGame on a residential lot is Neighborhood::SaveHouse: the resident
 * family's budget becomes the simulator's funds (Family +0x118, +0x138 bit 3
 * cleared), House::SaveFile writes <neighborhood>/Houses/HouseNN.iff
 * (world/housesave.ts; the stats ObjectModule::ComputeStats and
 * cFixedWorld::ComputeArchValue give go into the simulator's globals and
 * the family's +0x138 bits 0 / 1), then Neighborhood::Save. On a community
 * or town lot with sims on it only the visiting family's budget is kept and the
 * neighborhood saved (SaveAllPersistentDataForMatterTransferance: not ported).
 *
 * DoSave asks UIText STR# 0x99 entries 4 / 5 (message, title) with
 * Yes / No / Cancel when the lot is dirty: Cancel stays, Yes saves, No leaves.
 * The dirty flag here: the clock advanced, the funds changed or a buy /
 * build command was submitted, undone or redone since the lot was entered
 * or saved (the game sets it from most commands, cSimsApp::DoCommand).
 */

import type { GameContext } from "../context.js";
import { loadBuildCatalog } from "../data/buildcatalog.js";
import { writeGameFile } from "../data/files.js";
import { NeighborhoodStore } from "../data/nbhdstore.js";
import { PDX } from "../sim/person.js";
import { IDCANCEL, IDYES, MB_YESNOCANCEL, TSWinMsgBox } from "../ui/msgbox.js";
import { buildHouseFile, moduleOrder } from "./housesave.js";
import { summarizeHouseStats } from "./housestats.js";
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
    const familyId = store?.familyOfHouse(n);
    const zoning = sim?.module.zoning.get(n) ?? 1;
    // cSimsApp::SaveGame: with sims on the lot (global 0x20 clear), a town
    // lot (21..30, 81..89, 93..99), a community lot or a vacation lot no
    // family lives on is not saved; the visitors' money goes back to them.
    // Visited without sims (0x20 set, buy mode) it is saved as any lot.
    const visiting = (sim?.globals[32] ?? 0) !== 0;
    const townLot = (n >= 0x15 && n <= 0x1e) || (n >= 0x51 && n <= 0x59) || (n >= 0x5d && n <= 0x63);
    const vacationLot = n >= 0x28 && n <= 0x31;
    if (!visiting && (townLot || zoning === 2 || (vacationLot && familyId === undefined))) {
      if (store && sim) {
        const visitor = lv.selectedPerson();
        const fam = visitor ? store.family(visitor.pd[PDX.familyNumber] ?? 0) : undefined;
        if (fam) store.setFamilyLotSave(fam.id, sim.getFunds(), fam.flags);
        // Neighborhood::SaveAllPersistentDataForMatterTransferance: every neighbor with a person here.
        for (const p of sim.module.persons) if (p.person && !p.killed) store.savePersistentData(p.obj.selector.guid >>> 0, p.person.personData);
        await store.save();
      }
      markLotClean(lv);
      return true;
    }
    const prices = (await loadBuildCatalog(ctx)).prices;
    const fixed = viewer.world.fixed;
    const objects = new Map(moduleOrder(lot.module).map((o) => [o.objectId, o]));
    const st = summarizeHouseStats(objects, fixed, walls.gfx, viewer.floors, prices);
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
      if (familyId !== undefined && sim) store.setFamilyLotSave(familyId, sim.getFunds(), st.familyFlags);
      await store.save();
    }
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
