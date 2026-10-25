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
 * lot (zoning 2) only the visiting family's budget is kept and the
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
  try {
    const store = await NeighborhoodStore.open(nbhdDir).catch(() => null);
    const familyId = store?.familyOfHouse(n);
    const zoning = sim?.module.zoning.get(n) ?? 1;
    if (zoning === 2) {
      // A community lot: the visiting family's money goes back to it; the lot is not saved.
      if (store && sim) {
        const visitor = lv.selectedPerson();
        const fam = visitor ? store.family(visitor.pd[PDX.familyNumber] ?? 0) : undefined;
        if (fam) store.setFamilyLotSave(fam.id, sim.getFunds(), fam.flags);
        await store.save();
      }
      markLotClean(lv);
      return true;
    }
    const prices = (await loadBuildCatalog(ctx)).prices;
    const fixed = viewer.world.fixed;
    const objects = new Map(moduleOrder(lot.module).map((o) => [o.objectId, o]));
    const st = summarizeHouseStats(objects, fixed, walls.gfx, viewer.floors, prices);
    const sel = lv.selectedPerson();
    const bytes = await buildHouseFile({
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
    });
    await writeGameFile(lv.housePath, bytes);
    if (store) {
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
