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
 * 1000 * 0.76023). EndDesignAPerson kills the instance when its third
 * argument is set (cWinDesignCharacter's Done and Shutdown pass +0x119 ==
 * 0, the flag SetPerson's second argument sets: cWinDesignFamily passes
 * false, the cheat that designs the selected Sim in a lot true; Cancel
 * always kills).
 *
 * cWinVitaBtn::TSPaint draws the instance's SAnimator (cXPerson vtable
 * +0x94): the preview shows what the simulator plays on it.
 *
 * Neighborhood::UnloadHouse runs when the neighborhood screen comes up
 * (`CasLot.unloadHouse`, called by cWinNeighborhoodUL's init): the lot is
 * shared by every Create-a-Sim session of that screen and dropped when the
 * screen goes (a real lot is loaded then). House::LoadFile streams HOUS 0
 * into the game's one HouseViewer (HouseViewer::DoStream: zoom, scroll
 * origin, rotation, level), so the view's centermost tile is the one of
 * House00's saved camera on a view of the lot view's size
 * (cAnimDeviceSub::NewWorld: width x height - 100): `centermostStart`
 * computes it with a HouseViewer that is never drawn.
 *
 * The neighbors: Neighborhood::AddNewCharacter adds the new character's
 * neighbor to the one Neighborhood in memory, the one the simulator reads;
 * the port's simulator holds its own copy of the file, which `setNeighbor`
 * / `removeNeighbor` keep in step with the NeighborhoodStore (the
 * instance's LoadPersistentData then finds the neighbor: its id, and the
 * persistent data once EndDesignAPerson saved them).
 *
 * Port notes: the simulator does not run behind the neighborhood screen
 * (cSimsApp::Simulate): it runs while a design dialog is up (its pump);
 * with every object killed nothing else happens on the lot. The Tutorial
 * object LoadHouse may make (tutorial lots only) is not made.
 */

import { getLiveNeighborhood, setLiveNeighborhood } from "../data/nbhdstore.js";
import type { Neighbor } from "../data/neighborhood.js";
import type { PersonSim } from "../sim/person.js";
import type { WorldHooks } from "../sim/simmodule.js";
import { G, Simulator } from "../sim/simulator.js";
import { Compositor } from "../world/compositor.js";
import { FloorGraphicsMgr } from "../world/floors.js";
import { HouseViewer } from "../world/houseviewer.js";
import { ResFile } from "../world/iffres.js";
import { loadLotModule, type XObject } from "../world/objects.js";
import type { ObjectFolder } from "../world/objectfolder.js";
import { housePathOf } from "../world/moveout.js";
import { killObject, makeNewOutOfWorldObject } from "../world/tools/objectfactory.js";
import { Placement, type ObjectBehaviorHooks } from "../world/tools/placement.js";
import { readLotSize } from "../world/winlotview.js";
import { FixedWorld, RotatableWorld } from "../world/world.js";

/** lbl_105BC1FC + 0x57 */
const DESIGN_A_PERSON = "design-a-person";
/** BeginDesignAPerson's speed: 0.5 + lbl_105BC1F8[3] (1000) * lbl_105BC1F8[4] (0.7602339). */
const DESIGN_SPEED = Math.trunc(0.5 + 1000 * Math.fround(0.7602339386940002));
/** Global 9: the house family's number (Neighborhood::LoadHouse). */
const G_FAMILY = 9;

/** The house 0 the neighborhood screen keeps loaded (Neighborhood::UnloadHouse), by neighborhood. */
let house0: { dir: string; lot: Promise<CasLot | null> } | null = null;

export class CasLot {
  private constructor(
    readonly sim: Simulator,
    readonly placement: Placement,
    readonly folder: ObjectFolder,
    readonly fixed: FixedWorld,
    /** Where FindGoodLocation starts without a start position (world coordinates, fixed point). */
    private readonly centermost: { fx: number; fy: number },
  ) {}

  /**
   * Neighborhood::UnloadHouse (cSimsApp::ShowNbhdDialog): house 0 of
   * `nbhdDir` is loaded and kept until `release`. `gameW` x `gameH` is the
   * game's screen (the house viewer's size follows it). Resolves null when
   * the lot could not be loaded.
   */
  static unloadHouse(nbhdDir: string, gameW: number, gameH: number): Promise<CasLot | null> {
    const lot = CasLot.load(nbhdDir, gameW, gameH).catch((e: unknown) => {
      console.warn("[cas] house 0 not loaded: the preview plays the idle loop", e);
      return null;
    });
    house0 = { dir: nbhdDir, lot };
    return lot;
  }

  /** The house 0 of `nbhdDir` UnloadHouse loaded, if it is still the current lot. */
  static current(nbhdDir: string): Promise<CasLot | null> | null {
    return house0?.dir === nbhdDir ? house0.lot : null;
  }

  /** LoadHouse of another lot replaces house 0 (`lot`: what unloadHouse returned). */
  static release(lot: Promise<CasLot | null>): void {
    if (house0?.lot === lot) house0 = null;
  }

  /** LoadHouse(0) of `nbhdDir`, every object killed. */
  private static async load(nbhdDir: string, gameW: number, gameH: number): Promise<CasLot> {
    const house = await ResFile.open(housePathOf(nbhdDir, 0));
    const fixed = FixedWorld.load(house, readLotSize(house));
    const centermost = CasLot.centermostStart(house, fixed, gameW, gameH - 100);
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
    lot = new CasLot(sim, placement, folder, fixed, centermost);
    sim.module.worldHooks = lot.worldHooks();
    sim.postLoad();
    return lot;
  }

  /**
   * cXObject::FindGoodLocation's start without a position: GViewer::
   * GetCentermostTile (HouseViewer::ComputeCentermostTile: the view tile at
   * the middle of the viewer, level 1), the lot's center when that tile is
   * off the interior, turned back to world coordinates (RotateCoords by 4 -
   * rotation). The viewer holds what HouseViewer::DoStream read from HOUS 0
   * (the zoom, the scroll origin through SetOffsets, the rotation from
   * version 9, the level from 0x1d); a file without HOUS 0 leaves the
   * viewer as it was (unknown here: the lot's center then).
   */
  private static centermostStart(house: ResFile, fixed: FixedWorld, viewW: number, viewH: number): { fx: number; fy: number } {
    const world = new RotatableWorld(fixed);
    const lotCenter = (): { fx: number; fy: number } => {
      const half = world.size >> 1;
      const [fx, fy] = RotatableWorld.rotateCoords(((half + world.minX) << 4) | 8, ((half + world.minY) << 4) | 8, (4 - world.rotation) & 3, 0x400);
      return { fx, fy };
    };
    const b = house.get("HOUS", 0);
    if (!b || b.length < 28) return lotCenter();
    const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const version = d.getInt32(4, true);
    const scale = d.getInt32(16, true);
    const originX = d.getInt32(20, true);
    const originY = d.getInt32(24, true);
    if (version > 8 && b.length >= 30) world.setRotation(d.getInt16(28, true));
    const comp = new Compositor(viewW, viewH);
    try {
      const v = new HouseViewer(world, comp, new FloorGraphicsMgr(), viewW, viewH);
      v.buildMaxAltsTable();
      v.scale = scale >= 1 && scale <= 3 ? scale : 3;
      v.setOffsets(originX, originY);
      const c = v.pointToWholeTile(viewW >> 1, viewH >> 1, 1);
      if (!world.inInterior(c.x, c.y)) return lotCenter();
      const [fx, fy] = RotatableWorld.rotateCoords((c.x << 4) | 8, (c.y << 4) | 8, (4 - world.rotation) & 3, 0x400);
      return { fx, fy };
    } finally {
      comp.gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
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
    // cXObject::FindGoodLocation without a start: the view's centermost tile (see centermostStart).
    const pos = p.findGoodLocation(obj, this.centermost, 1, { emptyTile: true, buildable: false, random: null, sameRoom: true });
    if (!pos) {
      this.kill(obj);
      return null;
    }
    p.place(obj, pos, 1, null, 0, true);
    return this.sim.module.persons.find((x) => x.obj === obj) ?? null;
  }

  /**
   * The neighbor of a character in the simulator's Neighborhood
   * (Neighborhood::AddNewNeighbor, or SavePersistentData into it): added, or
   * replaced by `nb`.
   */
  setNeighbor(nb: Neighbor): void {
    const n = this.sim.module.nbhd;
    if (!n) return;
    const i = n.neighbors.findIndex((x) => (x.guid | 0) === (nb.guid | 0));
    if (i >= 0) n.neighbors[i] = nb;
    else n.neighbors.push(nb);
  }

  /** Neighborhood::RemoveNeighbor in the simulator's Neighborhood. */
  removeNeighbor(guid: number): void {
    const n = this.sim.module.nbhd;
    if (n) n.neighbors = n.neighbors.filter((x) => (x.guid | 0) !== (guid | 0));
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
