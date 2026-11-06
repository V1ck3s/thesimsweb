/**
 * The lot Create-a-Sim's people live in: house 0 of the neighborhood, as
 * the original keeps it loaded behind the neighborhood screens.
 *
 * cSimsApp::ShowNbhdDialog starts with Neighborhood::UnloadHouse, which is
 * LoadHouse(0): House::LoadFile of "<neighborhood>/Houses/House00.iff", the
 * family with number 0 as the house family, globals 9 (family) and 10
 * (house) := 0, funds 0, then (house 0) ObjectModule::KillAllObjects, and
 * ObjectModule::PostLoad over what is left (nothing). The lot is never
 * shown; its simulator runs (cSimsApp::Simulate) while the neighborhood and
 * the family screens are up.
 *
 * PersonFinder::CreateInstance makes a person there:
 * ObjectModule::MakeNewOutOfWorldObject(selector of the person's GUID) in
 * the module of app +0x14, cXObject::FindGoodLocation with no start (the
 * view's centermost tile; the lot's center when that tile is off the lot's
 * interior), level 1, empty tile, same room, direction -1, then
 * cXPerson::Place there on level 1 (vtable +0x90); with no location the
 * object is killed. PersonFinder::BeginDesignAPerson and SetAge then run
 * the instance's "design-a-person" tree (lbl_105BC1FC + 0x57, found with
 * Behavior::GetTreeID on the selector's behavior; PersonGlobals BHAV 8308)
 * through cXPerson::GosubObjectTree(instance, no params, tree), or clear
 * the instance's sim flag 1 when there is none, and BeginDesignAPerson sets
 * cSimulator::SetSpeed(0.5 + lbl_105BC1F8[3] * lbl_105BC1F8[4] = 0.5 +
 * 1000 * 0.76023). EndDesignAPerson kills the instance.
 *
 * cWinVitaBtn::TSPaint draws the instance's SAnimator (cXPerson vtable
 * +0x94): the preview shows what the simulator plays on it.
 *
 * Port notes: the headless lot is loaded when a Create-a-Sim session
 * starts (the port has no lot behind the neighborhood screen) and dropped
 * with it. The view's centermost tile is unknown without a view: the lot's
 * center is used. The new character's neighbor exists only in the
 * NeighborhoodStore until the family is finished, so the simulator's
 * neighborhood (read from disk) does not know it: LoadPersistentData finds
 * no neighbor, as for a person without one. The Tutorial object LoadHouse
 * may make (tutorial lots only) is not made.
 */

import { getLiveNeighborhood, setLiveNeighborhood } from "../data/nbhdstore.js";
import type { PersonSim } from "../sim/person.js";
import type { WorldHooks } from "../sim/simmodule.js";
import { G, Simulator } from "../sim/simulator.js";
import { ResFile } from "../world/iffres.js";
import { loadLotModule, type XObject } from "../world/objects.js";
import type { ObjectFolder } from "../world/objectfolder.js";
import { housePathOf } from "../world/moveout.js";
import { killObject, makeNewOutOfWorldObject } from "../world/tools/objectfactory.js";
import { Placement, type ObjectBehaviorHooks } from "../world/tools/placement.js";
import { readLotSize } from "../world/winlotview.js";
import { FixedWorld } from "../world/world.js";

/** lbl_105BC1FC + 0x57 */
const DESIGN_A_PERSON = "design-a-person";
/** BeginDesignAPerson's speed: 0.5 + lbl_105BC1F8[3] (1000) * lbl_105BC1F8[4] (0.7602339). */
const DESIGN_SPEED = Math.trunc(0.5 + 1000 * Math.fround(0.7602339386940002));
/** Global 9: the house family's number (Neighborhood::LoadHouse). */
const G_FAMILY = 9;

export class CasLot {
  private constructor(
    readonly sim: Simulator,
    readonly placement: Placement,
    readonly folder: ObjectFolder,
    readonly fixed: FixedWorld,
  ) {}

  /** Neighborhood::UnloadHouse: LoadHouse(0) of `nbhdDir`, every object killed. */
  static async load(nbhdDir: string): Promise<CasLot> {
    const house = await ResFile.open(housePathOf(nbhdDir, 0));
    const fixed = FixedWorld.load(house, readLotSize(house));
    const { module, folder } = await loadLotModule(house, fixed);
    let lot: CasLot | null = null;
    const hooks: ObjectBehaviorHooks = {
      runInitTree: (obj) => {
        const m = lot?.sim.module;
        if (!m) return false;
        try {
          m.addObject(obj, true);
        } catch (e) {
          console.warn("[cas] init tree failed", obj.selector.guid.toString(16), e);
          return false;
        }
        return true;
      },
      runCheckTree: (obj, entry, stackObj) => {
        const o = lot?.sim.module.getObject(obj.objectId);
        if (!o || o.obj !== obj || o.killed) return false;
        const tree = o.fnTable.getTreeID(entry);
        if (tree === 0) return false;
        try {
          return o.runCheckTree(o.behavior, stackObj, tree, null);
        } catch {
          return false;
        }
      },
      onKill: (obj) => lot?.sim.module.removeObject(obj),
      personData: (obj) => lot?.sim.module.persons.find((p) => p.obj === obj)?.pd ?? null,
      modeFreeze: () => lot?.sim.globals[G.modeFreeze] ?? 0,
    };
    const placement = new Placement(module, fixed, hooks);
    // ObjectModule::KillAllObjects (house 0), before PostLoad.
    for (const obj of [...module.objects.values()]) if (module.objects.get(obj.objectId) === obj) killObject(placement, obj);
    // The simulator's neighborhood is not the one the game keeps in memory (no lot is loaded).
    const live = getLiveNeighborhood();
    const sim = await Simulator.create(house, [], folder.packs, true);
    setLiveNeighborhood(live);
    sim.world = fixed;
    sim.globals[G_FAMILY] = 0;
    sim.globals[G.houseNumber] = 0;
    sim.setFunds(0);
    lot = new CasLot(sim, placement, folder, fixed);
    sim.module.worldHooks = lot.worldHooks();
    sim.postLoad();
    return lot;
  }

  /** The placement side of the simulator's primitives (the WinLotView's createObjectHooks without a view). */
  private worldHooks(): WorldHooks {
    const p = this.placement;
    return {
      selector: (guid) => this.folder.selectorByGUID(guid),
      make: (sel) => makeNewOutOfWorldObject(p, this.folder, sel),
      canPlace: (obj, pos, level, container, slot) => {
        p.error = 0;
        p.obstacle = null;
        return p.canPlace(obj, pos, level, container, slot);
      },
      place: (obj, pos, level, container, slot) => p.place(obj, pos, level, container, slot, true),
      moveTo: (obj, pos, level) => p.setLocation(obj, pos, level),
      pickup: (obj) => p.pickup(obj, true),
      turn: (obj, n) => p.turnObject(obj, n),
      findGoodLocation: (obj, start, level, opts) => p.findGoodLocation(obj, start, level, opts),
      kill: (obj) => this.kill(obj),
      lastError: () => ({ code: p.error, obstacle: p.obstacle?.objectId ?? 0 }),
    };
  }

  private kill(obj: XObject): void {
    if (this.placement.module.objects.get(obj.objectId) === obj) killObject(this.placement, obj);
  }

  /** PersonFinder::GetInstance: the person object of `guid` in the module. */
  getInstance(guid: number): PersonSim | null {
    return this.sim.module.persons.find((p) => !p.killed && (p.obj.selector.guid | 0) === (guid | 0)) ?? null;
  }

  /** ObjectModule::KillObject of the instance of `guid`, if any. */
  killInstance(guid: number): void {
    const ps = this.getInstance(guid);
    if (ps) this.kill(ps.obj);
  }

  /**
   * PersonFinder::CreateInstance. `bodyStrings` are the selector's body
   * strings as EditPerson left them (the original edits the selector's).
   */
  async createInstance(guid: number, bodyStrings: readonly string[]): Promise<PersonSim | null> {
    const sel = await this.folder.getSelectorByGUID(guid);
    if (!sel) return null;
    this.sim.module.bodyStringEdits.set(guid | 0, [...bodyStrings]);
    const p = this.placement;
    const obj = makeNewOutOfWorldObject(p, this.folder, sel);
    if (!obj) return null;
    // cXObject::FindGoodLocation without a start: the lot's center (no view, see the file comment).
    const half = this.fixed.size >> 1;
    const start = { fx: (half << 4) | 8, fy: (half << 4) | 8 };
    const pos = p.findGoodLocation(obj, start, 1, { emptyTile: true, buildable: false, random: null, sameRoom: true });
    if (!pos) {
      this.kill(obj);
      return null;
    }
    p.place(obj, pos, 1, null, 0, true);
    return this.sim.module.persons.find((x) => x.obj === obj) ?? null;
  }

  /** The body strings changed (EditPerson's ResetInstanceSuits on the instance: SAnimator::ResetSuits). */
  resetInstanceSuits(guid: number, bodyStrings: readonly string[]): void {
    this.sim.module.bodyStringEdits.set(guid | 0, [...bodyStrings]);
    this.getInstance(guid)?.animator.resetSuits();
  }

  /** BeginDesignAPerson / SetAge: the "design-a-person" tree on the instance (sim flag 1 cleared without one). */
  startDesignTree(ps: PersonSim): void {
    const tree = ps.behavior.getTreeID(DESIGN_A_PERSON);
    if (tree === 0) this.sim.module.setSimFlag(ps.id, 1, false);
    else ps.gosubObjectTree(ps, null, tree);
  }

  /** BeginDesignAPerson's cSimulator::SetSpeed. */
  setDesignSpeed(): void {
    this.sim.setSpeed(DESIGN_SPEED);
  }

  /** cSimsApp::Simulate */
  simulate(nowMs: number): void {
    this.sim.simulate(nowMs);
  }
}
