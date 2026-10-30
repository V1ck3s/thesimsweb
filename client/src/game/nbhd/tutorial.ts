/**
 * The tutorial's neighborhood side (the lot side is data: the Tutorial object
 * of Objects.far runs it with prims 10 and 34 and generic sim call 0).
 *
 *  - cSimsApp::ResetTutorial (Options > Play > Reset Tutorial): AppStrings
 *    (UIText STR# 153) entry 8 / title 7 with OK / Cancel; OK and DoSave:
 *    <data>/UserData/Tutorial.FAM is copied into the import folder
 *    (CopyFile, then the read-only attribute cleared) and the game goes back
 *    to the neighborhood screen (DoNbhdScreen(1)); a failed copy shows entry
 *    9 / title 7.
 *  - cWinNeighborhoodUL::CheckForNewImports: Import/Tutorial.FAM is imported
 *    at once, without a dialog: GetImportInfoForFile, the lot zoned
 *    residential, ImportFamily (Neighborhood::ImportFamily sets +0x12c to the
 *    lot and +0x12e to 0: the lot gets the tutorial arrow); failure: the
 *    zoning back and "Couldn't import the family"; success with a lot:
 *    DoNbhdScreen(1). The installer puts the file there, so this is the first
 *    run's import; the web install has no installer, see firstRunTutorial.
 *  - Neighborhood::TutorialCompleted(n) (generic sim call 0 with n = 0):
 *    NGBH +0x12a = n + 1, +0x12c = 0; with n = 0 the house file's and the
 *    live simulator's global 26 (tutorial) are cleared.
 *  - Neighborhood::LoadHouse, after ObjectModule::PostLoad: when the cheat
 *    flag (DAT_006e4a58, cheat command 0x3d) is clear, NGBH +0x12a < 3 and
 *    the simulator's global 26 (tutorial) is set, a lot without the Tutorial
 *    object (Objects.far Tutorial.iff, GUID 0xc3249a1d) gets one out of the
 *    world (MakeNewOutOfWorldObject). Tutorial.FAM carries global 26, not
 *    the object: this is what starts the tutorial.
 *  - Neighborhood::CancelTutorial (Escape in the lot view): the tutorial
 *    object (ObjectModule::GetTutorialObject) runs its "cancel tutorial"
 *    tree and is killed; the tutorial arrow hides.
 */

import type { GameContext } from "../context.js";
import { NeighborhoodStore } from "../data/nbhdstore.js";
import { writeGameFile } from "../data/files.js";
import { IDOK, MB_OK, MB_OKCANCEL, TSWinMsgBox } from "../ui/msgbox.js";
import { getImportInfoForFile, importDir, importFamily } from "./imports.js";
import { Zone, type Neighborhood } from "./nghinterface.js";
import { fetchManifest } from "../../engine/assets.js";
import { getOptionsMgr } from "../optionsmgr.js";
import type { SimModule } from "../sim/simmodule.js";
import type { ObjectFolder } from "../world/objectfolder.js";
import type { Placement } from "../world/tools/placement.js";
import { makeNewOutOfWorldObject } from "../world/tools/objectfactory.js";

/** UIText STR# 153 "AppStrings": 7 title, 8 question, 9 failure (lbl_105C0880 / 087C / 0878). */
const STR_APP = 153;
const RESET_TITLE = 7;
const RESET_TEXT = 8;
const RESET_FAILED = 9;
/** lbl_105BC2E0 + 0x1621 / lbl_105BCD5C + 0x16a */
const TUTORIAL_FAM = "Tutorial.FAM";
/** FindDataDirectory + GetStringConstant(7): the shipped copy the reset reads. */
const TUTORIAL_SOURCE = `UserData/${TUTORIAL_FAM}`;
/** Objects.far Tutorial.iff (Neighborhood::LoadHouse, ObjectDialog). */
export const GUID_TUTORIAL = 0xc3249a1d;
/** NGBH +0x12a: tutorials completed; LoadHouse makes the object below 3. */
const MAX_TUTORIALS = 3;
/** Simulator global 26: the lot runs the tutorial. */
const GLOBAL_TUTORIAL = 26;
/** lbl_105BB990 + 0xc5: the tree the tutorial object runs when cancelled. */
const CANCEL_TUTORIAL = "cancel tutorial";
/** lbl_105BCD5C +0x177 / +0x192 */
const IMPORT_ERROR_TEXT = "Couldn't import the family";
const IMPORT_ERROR_TITLE = "Error";

async function fileExists(path: string): Promise<boolean> {
  const p = `sims/${path}`.toLowerCase();
  return (await fetchManifest()).files.some((f) => f.path.toLowerCase() === p);
}

/** CopyFileA of the shipped Tutorial.FAM into the import folder; false on failure. */
async function copyTutorialIntoImport(nbhdDir: string): Promise<boolean> {
  const res = await fetch(`/assets/Sims/${TUTORIAL_SOURCE}`, { cache: "no-store" }).catch(() => null);
  if (!res?.ok) return false;
  try {
    await writeGameFile(`${importDir(nbhdDir)}/${TUTORIAL_FAM}`, new Uint8Array(await res.arrayBuffer()));
    return true;
  } catch {
    return false;
  }
}

/**
 * cSimsApp::ResetTutorial. `doSave` is cSimsApp::DoSave (false when the
 * player cancelled), `showNeighborhood` DoNbhdScreen.
 */
export async function resetTutorial(ctx: GameContext, nbhdDir: string, doSave: () => Promise<boolean>, showNeighborhood: () => void): Promise<void> {
  const str = (i: number): string => ctx.strings.get("UIText", STR_APP, i);
  if ((await TSWinMsgBox.show(ctx, str(RESET_TEXT), str(RESET_TITLE), MB_OKCANCEL)) !== IDOK) return;
  if (!(await doSave())) return;
  if (!(await copyTutorialIntoImport(nbhdDir))) {
    await TSWinMsgBox.show(ctx, str(RESET_FAILED), str(RESET_TITLE), MB_OK);
    return;
  }
  showNeighborhood();
}

/**
 * The installer's part of the first run: a fresh install has Tutorial.FAM in
 * UserData\Import, so the first neighborhood screen imports it. The web game
 * has no installer: on the first run (cOptionsMgr::GetRunCount() == 1) the
 * shipped copy is put into the first neighborhood's import folder, when that
 * neighborhood has no tutorial lot (NGBH +0x12c) and nobody lives on the
 * file's lot (a run count reset must not evict a family). Resolves true when
 * it did.
 */
export async function firstRunTutorial(nbhdDir: string): Promise<boolean> {
  if (getOptionsMgr().getRunCount() !== 1 || nbhdDir !== "UserData") return false;
  const store = await NeighborhoodStore.open(nbhdDir).catch(() => null);
  if (!store || (store.ngbh().shorts[2] ?? 0) !== 0) return false;
  if (await fileExists(`${importDir(nbhdDir)}/${TUTORIAL_FAM}`)) return false;
  const info = await getImportInfoForFile(TUTORIAL_SOURCE);
  if (!info || store.familyOfHouse(info.house) !== undefined) return false;
  return copyTutorialIntoImport(nbhdDir);
}

/**
 * The Tutorial.FAM part of cWinNeighborhoodUL::CheckForNewImports. Resolves
 * true when the screen must be built again (DoNbhdScreen(1): a family came
 * onto a lot).
 */
export async function importTutorialIfPresent(ctx: GameContext, nb: Neighborhood): Promise<boolean> {
  const path = `${importDir(nb.dir)}/${TUTORIAL_FAM}`;
  if (!(await fileExists(path))) return false;
  const info = await getImportInfoForFile(path);
  if (!info) return false;
  const zone = nb.getZoningType(info.house);
  await nb.setZoningType(info.house, Zone.Residential);
  const house = await importFamily(nb.dir, info).catch((e: unknown) => (console.error("[tutorial]", e), null));
  if (house === null) {
    await nb.setZoningType(info.house, zone);
    await TSWinMsgBox.show(ctx, IMPORT_ERROR_TEXT, IMPORT_ERROR_TITLE, MB_OK);
    return false;
  }
  // cSimsApp::ReportMissingTextures is not ported.
  return info.house !== 0;
}

/**
 * The tutorial part of Neighborhood::LoadHouse (after ObjectModule::PostLoad,
 * so the object's Load tree does not run; MakeNewOutOfWorldObject runs its
 * Init). The cheat flag that disables it is never set here.
 */
export async function makeTutorialObject(p: Placement, folder: ObjectFolder, m: SimModule, nbhdDir: string): Promise<void> {
  if ((m.sim.globals[GLOBAL_TUTORIAL] ?? 0) === 0) return;
  const store = await NeighborhoodStore.open(nbhdDir).catch(() => null);
  if (!store || (store.ngbh().shorts[1] ?? 0) >= MAX_TUTORIALS) return;
  // ObjectModule::GetObjectByGUID
  if ([...p.module.objects.values()].some((o) => (o.selector.guid | 0) === (GUID_TUTORIAL | 0))) return;
  const sel = await folder.getSelectorByGUID(GUID_TUTORIAL).catch(() => null);
  if (!sel) return;
  // The Init tree may create objects synchronously: their files open first.
  m.behaviorOf(sel);
  await Promise.all([...m.createdObjectGUIDs()].map((g) => folder.getSelectorByGUID(g >>> 0).catch(() => null)));
  makeNewOutOfWorldObject(p, folder, sel);
}

/** Neighborhood::TutorialCompleted(n): NGBH +0x12a = n + 1, +0x12c = 0 (saved). */
export async function tutorialCompleted(nbhdDir: string, n: number): Promise<void> {
  const store = await NeighborhoodStore.open(nbhdDir);
  const shorts = store.ngbh().shorts;
  shorts[1] = n + 1;
  shorts[2] = 0;
  store.touchNgbh();
  await store.save();
}

/**
 * Neighborhood::CancelTutorial (cDDDSimsView::TSOnKeyDown, Escape): the
 * tutorial object runs its "cancel tutorial" tree (cXObject::RunTree, no
 * stack object) and ObjectModule::KillObject takes it away.
 */
export function cancelTutorial(m: SimModule): void {
  const o = m.tutorialObject;
  if (!o) return;
  const tree = o.behavior.getTreeID(CANCEL_TUTORIAL);
  if (tree !== 0) {
    try {
      o.runOneTickTree(o.behavior, 0, tree, null);
    } catch (e) {
      console.warn("[tutorial] cancel tutorial failed", e);
    }
  }
  m.killObject(o);
}
