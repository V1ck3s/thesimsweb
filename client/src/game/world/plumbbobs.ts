/**
 * The plumb bobs: ObjectModule's part that keeps the diamond over the
 * selected person, the date bob over the person it is dating and the star
 * bobs over the other superstars (ObjectModule +0xcc..+0xe8).
 *
 * The bobs are real objects of the lot (ExpansionShared.far):
 *   PlumbBob.iff  GUID 0x2f726fff  "head-arrow"      (+0xcc)
 *   DateBob.iff   GUID 0x0baa71c5  "head-arrow-date" (+0xd0)
 *   StarBob.iff   GUID 0xe9337020  "head-star"       (+0xd4 in use, +0xe0 spare)
 * made out of the world (MakeNewOutOfWorldObject, object data flags |=
 * 0x4000) and placed (cXObject::Place(person location, person level,
 * person, 1, true)) in the person's third object slot, the "HEAD" slot
 * cXPerson::Initialize adds with flag 2. They are 3D objects (OBJD +0xcc
 * bit 0): sims/animator.ts draws them; their trees idle (the star bob's
 * "Get Excited" interactions are for the fans).
 *
 * - InitPlumbBobs (ObjectModule::PostLoad, after a save, OnEnterWorld when
 *   missing): the plumb bob and the date bob.
 * - OnSelectionChange(person): run by SetSelectedPerson for the person
 *   deselected (its flag already cleared) then the one selected. The
 *   selected person gets the plumb bob (picked up from the previous one
 *   first) and, when its person data 77 is negative, the date bob goes on
 *   person -data 77. With nobody selected both are picked up. A person not
 *   selected with a fame level (person data 81) above 9 gets a star bob when
 *   Superstar is installed (app +0x66 bit 0x40).
 * - OnStarPowerChange / OnAutoFollowChange: the same for one person, from
 *   UpdatePlumbBobs (HouseViewer's update) for the persons whose data 81 /
 *   77 were written (InterpValue: ObjectModule::SetStarSimDirty /
 *   SetAutofollowSimDirty), and at PostLoad for everyone.
 * - RecoverPlumbBobs(obj): obj itself when it is a bob (a person's GUID never
 *   matches: OnExitWorld(person) does nothing), a star going back to the
 *   spares, picked up (no notification).
 * - MakeStarPlumbBobs: 4 spare stars (2 when some are in use).
 * - PickupAndKillPlumbBobs (ObjectModule::Save, before writing the house):
 *   every bob killed out of the world, so no bob is saved.
 *
 * Faithful quirks kept: a fame level falling to 9 or less removes a date bob
 * from the person's head slot, not its star (OnStarPowerChange compares the
 * slot's GUID with 0x0baa71c5); OnEnterWorld's date bob goes on person
 * +data 77 when it is positive.
 */

import type { SimModule } from "../sim/simmodule.js";
import type { SimObject } from "../sim/xobject.js";
import type { ObjectFolder } from "./objectfolder.js";
import { OD, type XObject } from "./objects.js";
import type { ObjSelector } from "./objselector.js";
import { makeNewOutOfWorldObject } from "./tools/objectfactory.js";
import type { Placement } from "./tools/placement.js";

export const GUID_PLUMB_BOB = 0x2f726fff;
export const GUID_DATE_BOB = 0x0baa71c5;
export const GUID_STAR_BOB = 0xe9337020 | 0;

/** App +0x66 bit: Superstar installed (ExpansionPack6). */
const PACK_SUPERSTAR = 0x40;
/** Person data 77: the date's object id (negative while the selected person leads it). */
const PD_DATE = 0x4d;
/** Person data 81: the fame level (cFameTrack). */
const PD_FAME = 0x51;
/** Object data flags bit MakeNewOutOfWorldObject's callers set on the bobs. */
const FLAG_PLUMB_BOB = 0x4000;
/** The person's object slot the bobs go into (cXPerson::Initialize's "HEAD" slot, flag 2). */
const HEAD_SLOT = 2;
const HEAD_SLOT_FLAG = 2;

/** OBJD +0xcc bit 0: a 3D object (cXObject::Initialize3D makes its Animator). */
export function is3DObject(o: XObject): boolean {
  return (o.selector.objd.i16(0xcc) & 1) !== 0;
}

export interface PlumbBobHost {
  placement: Placement;
  folder: ObjectFolder;
  sim: SimModule;
  /** ObjectModule::KillOutOfWorldObject. */
  kill(obj: XObject): void;
}

export class PlumbBobs {
  /** +0xcc / +0xd0 */
  private bob: XObject | null = null;
  private dateBob: XObject | null = null;
  /** +0xd4: stars over persons; +0xe0: spares. */
  private readonly stars: XObject[] = [];
  private readonly spareStars: XObject[] = [];
  /** cXPerson +0x114 bit 1 as SetSelectedPerson leaves it. */
  private selected: XObject | null = null;
  /** ObjectModule +0x11: set once PostLoad ran. */
  private loaded = false;

  constructor(private readonly host: PlumbBobHost) {}

  /** The bobs' object files (the original folder holds them all). */
  async load(): Promise<void> {
    const f = this.host.folder;
    await Promise.all([GUID_PLUMB_BOB, GUID_DATE_BOB, GUID_STAR_BOB].map((g) => f.getSelectorByGUID(g >>> 0).catch(() => null)));
  }

  private selector(guid: number): ObjSelector | null {
    return this.host.folder.selectorByGUID(guid >>> 0);
  }

  private get superstar(): boolean {
    return (this.host.folder.packs & PACK_SUPERSTAR) !== 0;
  }

  private get(id: number): XObject | null {
    return this.host.placement.get(id);
  }

  private sim(o: XObject): SimObject | null {
    const s = this.host.sim.getObject(o.objectId);
    return s && s.obj === o ? s : null;
  }

  private pd(o: XObject, i: number): number {
    return this.sim(o)?.person?.personData[i] ?? 0;
  }

  /** The selected person, cXPerson::IsSelected. */
  isSelected(o: XObject): boolean {
    return this.selected === o;
  }

  /** MakeNewOutOfWorldObject of a bob, flagged 0x4000. */
  private make(guid: number): XObject | null {
    const sel = this.selector(guid);
    if (!sel) return null;
    const o = makeNewOutOfWorldObject(this.host.placement, this.host.folder, sel);
    if (o) o.objectData[OD.flags] = o.objectData[OD.flags]! | FLAG_PLUMB_BOB;
    return o;
  }

  /** The object in a person's HEAD slot (0 when none). */
  private headSlot(p: XObject): { flags: number; contained: number } | null {
    const s = p.objectSlots.length - 1 < HEAD_SLOT ? null : p.objectSlots[HEAD_SLOT];
    return s ? { flags: s.f1c, contained: s.containedId } : null;
  }

  /**
   * The block every On* function repeats: on a person inside the lot with a
   * HEAD slot, recover what the slot holds and place `bob` in it. True when
   * placed.
   */
  private placeOn(bob: XObject, p: XObject): boolean {
    const pl = this.host.placement;
    if (pl.outOfBounds(p.fx >> 4, p.fy >> 4)) return false;
    const slot = this.headSlot(p);
    if (!slot || (slot.flags & HEAD_SLOT_FLAG) === 0) return false;
    if (slot.contained !== 0) {
      const held = this.get(slot.contained);
      if (held) this.recoverPlumbBobs(held);
    }
    pl.place(bob, { fx: p.fx, fy: p.fy }, p.level, p, HEAD_SLOT - 1, true);
    return true;
  }

  /** The container a bob is placed in (PlacementSpec::PlacementSpec(obj) +0xc). */
  private containerOf(o: XObject): XObject | null {
    return this.host.placement.getPlacementSpec(o).container;
  }

  /** ObjectModule::InitPlumbBobs */
  initPlumbBobs(): void {
    if (this.bob) return;
    this.bob = this.make(GUID_PLUMB_BOB);
    this.dateBob = this.make(GUID_DATE_BOB);
  }

  /** ObjectModule::MakeStarPlumbBobs */
  private makeStarPlumbBobs(): void {
    if (this.spareStars.length !== 0 || !this.superstar) return;
    const n = this.stars.length === 0 ? 4 : 2;
    for (let i = 0; i < n; i++) {
      const s = this.make(GUID_STAR_BOB);
      if (s) this.spareStars.push(s);
    }
  }

  /** ObjectModule::RecoverPlumbBobs */
  recoverPlumbBobs(obj: XObject): void {
    if (!this.loaded) return;
    const guid = obj.selector.guid | 0;
    let o: XObject | null = obj;
    if (obj.isPerson) {
      const slot = this.headSlot(obj);
      o = slot && slot.contained > 0 ? this.get(slot.contained) : null;
    }
    if (!o) return;
    if (guid === GUID_STAR_BOB) {
      const i = this.stars.indexOf(o);
      if (i >= 0) {
        this.spareStars.push(o);
        this.stars.splice(i, 1);
      }
    } else if (guid !== GUID_DATE_BOB && guid !== GUID_PLUMB_BOB) {
      return;
    }
    this.host.placement.pickup(o, false);
  }

  /** ObjectModule::OnKill: a killed bob leaves the lists. */
  onKill(obj: XObject): void {
    if (!this.loaded) return;
    const guid = obj.selector.guid | 0;
    if (guid !== GUID_PLUMB_BOB && guid !== GUID_DATE_BOB && guid !== GUID_STAR_BOB) return;
    if (this.bob === obj) this.bob = null;
    if (this.dateBob === obj) this.dateBob = null;
    for (const list of [this.stars, this.spareStars]) {
      const i = list.indexOf(obj);
      if (i >= 0) list.splice(i, 1);
    }
    if (this.selected === obj) this.selected = null;
  }

  /** ObjectModule::OnExitWorld */
  onExitWorld(obj: XObject): void {
    this.recoverPlumbBobs(obj);
  }

  /** ObjectModule::OnEnterWorld */
  onEnterWorld(obj: XObject): void {
    if (!this.loaded) return;
    if (!this.bob) this.initPlumbBobs();
    if (!obj.isPerson) return;
    const selected = this.isSelected(obj);
    if (selected && this.bob) {
      if (this.containerOf(this.bob) !== obj) this.host.placement.pickup(this.bob, true);
      this.placeOn(this.bob, obj);
    }
    if (this.dateBob) {
      const d = this.pd(obj, PD_DATE);
      if (d > 0) {
        if (selected) this.host.placement.pickup(this.dateBob, true);
        const date = this.get(d);
        if (date) this.placeOn(this.dateBob, date);
      }
    }
    if (this.superstar && !selected && this.pd(obj, PD_FAME) > 9) this.placeStar(obj, false);
  }

  /**
   * A spare star (made when none is left) on `p`, kept in use when placed.
   * `popFirst`: OnStarPowerChange takes it off the spares before placing,
   * OnSelectionChange / OnEnterWorld only once placed.
   */
  private placeStar(p: XObject, popFirst: boolean): void {
    if (this.spareStars.length === 0) this.makeStarPlumbBobs();
    const star = this.spareStars[this.spareStars.length - 1];
    if (!star) return;
    if (popFirst) this.spareStars.pop();
    if (!this.placeOn(star, p)) return;
    this.stars.push(star);
    if (!popFirst) this.spareStars.pop();
  }

  /** ObjectModule::OnSelectionChange */
  onSelectionChange(obj: XObject | null): void {
    if (!obj || !this.loaded || !this.bob) return;
    const selected = this.isSelected(obj);
    if (obj.isPerson && selected) {
      if (this.containerOf(this.bob) !== obj) this.host.placement.pickup(this.bob, true);
      this.placeOn(this.bob, obj);
    }
    if (obj.isPerson && !this.selected) this.host.placement.pickup(this.bob, true);
    if (selected && obj.isPerson && this.dateBob) {
      const d = this.pd(obj, PD_DATE);
      if (d !== 0) {
        let date: XObject | null = null;
        if (d < 0) {
          date = this.get(-d);
          this.host.placement.pickup(this.dateBob, true);
        }
        if (date) this.placeOn(this.dateBob, date);
      }
    }
    if (!this.selected && this.dateBob) this.host.placement.pickup(this.dateBob, true);
    if (this.superstar && !selected && obj.isPerson && this.pd(obj, PD_FAME) > 9) this.placeStar(obj, false);
  }

  /** ObjectModule::OnStarPowerChange */
  onStarPowerChange(obj: XObject): void {
    if (!this.superstar || !obj.isPerson || this.isSelected(obj)) return;
    if (this.pd(obj, PD_FAME) > 9) {
      this.placeStar(obj, true);
      return;
    }
    const slot = this.headSlot(obj);
    if (!slot || (slot.flags & HEAD_SLOT_FLAG) === 0 || slot.contained === 0) return;
    const held = this.get(slot.contained);
    if (!held || (held.selector.guid | 0) !== GUID_DATE_BOB) return;
    this.host.placement.pickup(held, true);
    this.recoverPlumbBobs(held);
  }

  /** ObjectModule::OnAutoFollowChange */
  onAutoFollowChange(obj: XObject): void {
    if (!this.loaded || !this.bob || !this.dateBob) return;
    this.host.placement.pickup(this.dateBob, true);
    const d = this.pd(obj, PD_DATE);
    if (d === 0 || !this.isSelected(obj) || d > 0) return;
    const date = this.get(-d);
    if (date) this.placeOn(this.dateBob, date);
  }

  /** ObjectModule::UpdatePlumbBobs (HouseViewer's update, each frame). */
  updatePlumbBobs(): void {
    const m = this.host.sim;
    if (!m.plumbBobsDirty) return;
    for (const p of m.autofollowDirty.splice(0)) this.onAutoFollowChange(p.obj);
    for (const p of m.starDirty.splice(0)) this.onStarPowerChange(p.obj);
    m.plumbBobsDirty = false;
  }

  /** ObjectModule::SetSelectedPerson's bob part: the deselected person, then the selected one. */
  setSelectedPerson(p: XObject | null): void {
    const old = this.selected;
    if (old === p) return;
    this.selected = null;
    if (old) this.onSelectionChange(old);
    this.selected = p;
    if (p) this.onSelectionChange(p);
  }

  /** ObjectModule::PostLoad's bob part: InitPlumbBobs, OnSelectionChange(selected), OnStarPowerChange(everyone). */
  postLoad(selected: XObject | null): void {
    this.initPlumbBobs();
    this.loaded = true;
    this.selected = selected;
    this.onSelectionChange(selected);
    for (const p of this.host.sim.persons) if (!p.killed) this.onStarPowerChange(p.obj);
  }

  /** ObjectModule::PickupAndKillPlumbBobs (ObjectModule::Save, before the house is written). */
  pickupAndKillPlumbBobs(): void {
    const all = [this.bob, this.dateBob, ...this.stars, ...this.spareStars].filter((o): o is XObject => o !== null);
    this.bob = null;
    this.dateBob = null;
    this.stars.length = 0;
    this.spareStars.length = 0;
    for (const o of all) {
      this.host.placement.pickup(o, true);
      this.host.kill(o);
    }
  }

  /** ObjectModule::Save after the house is written: InitPlumbBobs, OnSelectionChange, OnStarPowerChange. */
  afterSave(): void {
    this.postLoad(this.selected);
  }
}
