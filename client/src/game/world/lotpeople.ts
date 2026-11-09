/**
 * The people of a lot: each person object of the house file (cXPerson) gets
 * its VitaBoy animator (SAnimator), dressed from its neighbor's character
 * file, and is drawn by the SimRenderer into the compositor's framebuffer
 * after the sprites (HouseViewer::RenderDynamicObjects draws people through
 * the 3D device with the shared z-buffer).
 *
 * Until the simulation runs, everyone plays the idle animation where the
 * house file left them.
 */

import { loadNeighborhood, neighborByGuid } from "../data/neighborhood.js";
import { loadPerson, personLooks, rootTransform, SAnimator, SimRenderer, type SimPlacement, type SimView } from "../sims/index.js";
import { Animator, AnimStyle } from "../sims/animator.js";
import { loadStringSet } from "../sim/behavior.js";
import { mat4Mul, quatRotate, transformPoint, translationTf, type Vec3 } from "../sims/math3d.js";
import { VERTEX_FLOATS } from "../sims/deformablemesh.js";
import type { Skeleton } from "../sims/skeleton.js";
import type { Compositor } from "./compositor.js";
import type { HouseViewer } from "./houseviewer.js";
import type { PlacedObject } from "./objects.js";
import { RotatableWorld } from "./world.js";

export interface LotPerson {
  obj: PlacedObject;
  anim: SAnimator;
  /** Set when the simulation drives the person (bindSim): its facing (45 degree units, fractional). */
  simDir?: () => number;
  /** Set when the simulation drives the person: the walk engine's position while it moves it (SAnimator +0x80/+0x84), null otherwise. */
  simPos?: () => { fx: number; fy: number } | null;
  /** Set when the simulation drives the person: its person data. */
  simData?: () => Int16Array;
}

/**
 * HouseViewer::Render3DObject's test: a person on the viewed level or below
 * is drawn on the lot's inner tiles only; one on the level above is drawn
 * while its person data 40 is set (on the stairs).
 */
function drawable(p: LotPerson, viewer: HouseViewer): boolean {
  const o = p.obj;
  if (o.fx < 0 || o.fy < 0 || o.hidden !== 0) return false;
  if (o.level <= viewer.level) {
    const n = viewer.world.size;
    const tx = o.fx >> 4;
    const ty = o.fy >> 4;
    if (tx >= 1 && ty >= 1 && tx < n - 1 && ty < n - 1) return true;
  }
  return o.level === viewer.level + 1 && (p.simData?.()[40] ?? 0) !== 0;
}

/** Where a person is drawn: the walk engine's grid position while it moves, else the object's. */
function drawPos(p: LotPerson): { fx: number; fy: number } {
  return p.simPos?.() ?? p.obj;
}

/**
 * ObjSelector::GetBodyStrings: the STR# (OBJD +0x26) of the person's own
 * object file, dressed. A neighbor's character file is that file too; the
 * NPCs (mail carrier, paper carrier, downtown staff...) have no character
 * file in the neighborhood folder, only their object file.
 */
async function animatorFromSelector(obj: PlacedObject): Promise<SAnimator | null> {
  const sel = obj.selector;
  const strings = loadStringSet(sel.res, sel.objd.i16(0x26));
  if (!strings?.length) return null;
  return SAnimator.fromBodyStrings(strings).catch(() => null);
}

/** The animator of a person object: its own object file (a neighbor's is its character file), else the character file by name. */
async function loadLotPerson(nbhdDir: string, nbhd: Awaited<ReturnType<typeof loadNeighborhood>>, obj: PlacedObject): Promise<SAnimator | null> {
  const anim = await animatorFromSelector(obj);
  if (anim) return anim;
  const nb = neighborByGuid(nbhd, obj.guid);
  return nb ? await loadPerson(nbhdDir, nb.name).catch(() => null) : null;
}

/** cXPerson::Initialize's third object slot ("HEAD", flag 2): where the plumb bobs go. */
const HEAD_SLOT = 2;
/** Object data 34: hidden. */
const OD_HIDDEN = 34;
/** Person data 74 bit 0: VitaBoy::SetRenderFlags' hide flag for the date and star bobs. */
const PD_RENDER_FLAGS = 0x4a;
/** Person data 30: censorship flags (the animations' "censor" event; SAnimator::GetPixelated). */
const PD_CENSOR = 0x1e;

export class LotPeople {
  /** cXObject::Initialize3D's animators of the 3D objects carried (null: none or failed; absent: loading). */
  private readonly animators = new Map<PlacedObject, Animator | null>();
  /** The real-time clock of the last update (lbl_105BA230). */
  private now = 0;
  /**
   * The lot view's object lookup (the HEAD slot's contents) and
   * cXPerson::GetMotive of a person; no 3D object is drawn until set.
   */
  objectById: ((id: number) => PlacedObject | null) | null = null;
  motive: ((person: PlacedObject, i: number) => number) | null = null;
  /**
   * Animator::SetPickingObject (lbl_105BADA4, turned on by cObjPickerTool::
   * Float) with the cursor's view point (Animator::Render's GetCursorPos):
   * null = picking off.
   */
  pickPoint: { x: number; y: number } | null = null;
  /**
   * Animator::PickedObject (lbl_105BADA0): the last 3D object drawn this
   * frame whose rendering changed the z-buffer at the cursor (null: none).
   */
  pickedObject: PlacedObject | null = null;
  /** The viewer of the draw in progress (Animator::Render's HouseViewer::PointToZ). */
  private drawingIn: HouseViewer | null = null;

  private constructor(
    private readonly renderer: SimRenderer,
    readonly people: LotPerson[],
  ) {}

  /**
   * Animators for the person objects that are neighbors of `nbhdDir`. Hidden
   * ones (object data 34, saved in the middle of an interaction that hides
   * them) are dressed too: they show once their trees clear it (draw).
   */
  static async load(comp: Compositor, nbhdDir: string, objects: Iterable<PlacedObject>): Promise<LotPeople> {
    const nbhd = await loadNeighborhood(nbhdDir);
    const renderer = await SimRenderer.create(comp.gl);
    const people: LotPerson[] = [];
    await Promise.all(
      [...objects]
        .filter((o) => o.isPerson && o.tileX > 0 && o.tileY > 0)
        .map(async (obj) => {
          const anim = await loadLotPerson(nbhdDir, nbhd, obj);
          if (!anim || !(await anim.startIdle())) return;
          people.push({ obj, anim });
        }),
    );
    return new LotPeople(renderer, people);
  }

  /** A person object that joined the lot (move-in, arrival): its animator, dressed from its character file. */
  async addPerson(nbhdDir: string, obj: PlacedObject): Promise<boolean> {
    if (this.people.some((x) => x.obj === obj)) return true;
    const nbhd = await loadNeighborhood(nbhdDir);
    const anim = await loadLotPerson(nbhdDir, nbhd, obj);
    if (!anim || !(await anim.startIdle())) return false;
    this.people.push({ obj, anim });
    return true;
  }

  /**
   * An object that died (ObjectModule::KillOutOfWorldObject deletes the
   * cXObject with its SAnimator / Animator): a person's animator, or a
   * carried 3D object's, goes. Visitors and walk-bys come and go all day;
   * kept, their VitaBoys piled up (memory, and every draw walked them).
   */
  onKill(obj: PlacedObject): void {
    const i = this.people.findIndex((x) => x.obj === obj);
    if (i >= 0) this.people.splice(i, 1);
    this.animators.delete(obj);
  }

  /**
   * The simulation animates `obj` from now on: its practices are dropped,
   * `attach` receives the VitaBoy skeleton (the sim's SAnimator poses it),
   * and `dir` gives the facing to draw. False when `obj` has no animator.
   */
  bindSim(obj: PlacedObject, attach: (skeleton: Skeleton) => void, dir: () => number, pos?: () => { fx: number; fy: number } | null, data?: () => Int16Array): boolean {
    const p = this.people.find((x) => x.obj === obj);
    if (!p) return false;
    p.anim.vitaboy.practices.length = 0;
    attach(p.anim.vitaboy.skeleton);
    p.simDir = dir;
    if (pos) p.simPos = pos;
    if (data) p.simData = data;
    return true;
  }

  /**
   * SAnimator::PrepReg's registration point (VitaBoy::FindRegistration) in
   * lot world space (VitaBoy units, level 1): slot 0 is body strings 6 / 7
   * (the hand bone and its "Palm" offset), slot 1 body strings 4 / 5 (the
   * head and "Top"). The named offset is RotationTf(Z, a) * TranslationTf(t)
   * (lbl_105C2224: Palm (pi, 0.5 0 0), Top (-pi/2, 0.8 0 0), HeadFake (-pi/2, 0.8 0 100),
   * Shoulder (pi, 0 0 1)), i.e. the point t in the bone's frame. Null when
   * the person has no such bone.
   */
  /** Where the person is drawn (its animator's follow position while walking), null when not shown here. */
  drawPosition(obj: PlacedObject): { fx: number; fy: number } | null {
    const p = this.people.find((x) => x.obj === obj);
    return p ? drawPos(p) : null;
  }

  registrationPoint(obj: PlacedObject, slot: number, rotation: number, alt: number): Vec3 | null {
    const p = this.people.find((x) => x.obj === obj);
    if (!p || (slot !== 0 && slot !== 1 && slot !== 3)) return null;
    const bs = p.anim.bodyStrings;
    // PrepReg 3 (+0x140, SetupRegistrations): the PELVIS bone, no offset.
    const bone = p.anim.vitaboy.skeleton.findBone(slot === 3 ? "PELVIS" : bs.get(slot === 0 ? 6 : 4));
    if (!bone) return null;
    const OFFSETS: Readonly<Record<string, Vec3>> = { palm: [0.5, 0, 0], top: [0.8, 0, 0], headfake: [0.8, 0, 100], shoulder: [0, 0, 1] };
    const t: Vec3 = slot === 3 ? [0, 0, 0] : (OFFSETS[bs.get(slot === 0 ? 7 : 5).toLowerCase()] ?? [0, 0, 0]);
    const r = quatRotate(bone.worldRot, t);
    const local: Vec3 = [bone.worldPos[0] + r[0], bone.worldPos[1] + r[1], bone.worldPos[2] + r[2]];
    const at = drawPos(p);
    const place = { x: at.fx / 16, y: at.fy / 16, level: 1, alt, direction: p.simDir ? p.simDir() : obj.dir };
    return transformPoint(local, rootTransform(place, rotation));
  }

  /** The person's body strings were edited (GenericSimCall 24, set suit): dress it again. */
  async redress(obj: PlacedObject, strings: readonly string[]): Promise<void> {
    const p = this.people.find((x) => x.obj === obj);
    if (p) await p.anim.setBodyStrings(strings);
  }

  update(nowMs: number): void {
    this.now = nowMs;
    // Sim-driven people have no practices here: this only deforms their meshes.
    for (const p of this.people) {
      // SAnimator::Render -> UpdateOutfitAndHands(false): redressed when the outfit, gestures or accessories changed.
      const look = personLooks.get(p.obj);
      if (look) void p.anim.updateOutfitAndHands(look);
      // SAnimator::UpdatePose / Render: UpdateCensorDressing.
      p.anim.updateCensorDressing(look?.pd[PD_CENSOR] ?? 0);
      p.anim.vitaboy.scale = look?.scale ?? 1;
      p.anim.update(nowMs);
    }
  }

  private static viewOf(viewer: HouseViewer): SimView {
    return {
      zoom: viewer.scale,
      rotation: viewer.world.rotation,
      originX: viewer.originX,
      originY: viewer.originY,
      width: viewer.viewW,
      height: viewer.viewH,
    };
  }

  /**
   * cXObject::GetLastDamage of a person (the screen rectangle its Draw3D
   * covered), [left, top, right, bottom]: the projected bones of its posed
   * skeleton, padded by the mesh's reach around them (0.35 world units).
   * Null when the person is not drawn.
   */
  screenRect(obj: PlacedObject, viewer: HouseViewer): [number, number, number, number] | null {
    const p = this.people.find((x) => x.obj === obj);
    if (!p || obj.level > viewer.level || obj.hidden !== 0) return null;
    const cam = this.renderer.cameraFor(LotPeople.viewOf(viewer));
    const at = drawPos(p);
    const root = rootTransform(
      { x: at.fx / 16, y: at.fy / 16, level: obj.level, alt: viewer.world.fixed.getFAlt(at.fx, at.fy), direction: p.simDir ? p.simDir() : obj.dir },
      viewer.world.rotation,
    );
    let r: [number, number, number, number] | null = null;
    for (const b of p.anim.vitaboy.skeleton.bones) {
      const s = cam.project(transformPoint(b.worldPos, root));
      if (!r) r = [s.x, s.y, s.x, s.y];
      else {
        r[0] = Math.min(r[0], s.x);
        r[1] = Math.min(r[1], s.y);
        r[2] = Math.max(r[2], s.x);
        r[3] = Math.max(r[3], s.y);
      }
    }
    if (!r) return null;
    const pad = 0.35 / cam.upp;
    return [Math.floor(r[0] - pad), Math.floor(r[1] - pad), Math.ceil(r[2] + pad), Math.ceil(r[3] + pad)];
  }

  /** Draw everyone on the levels up to the viewer's current level. */
  draw(viewer: HouseViewer): void {
    const view = LotPeople.viewOf(viewer);
    // HouseViewer::UpdateStaticDynamic: SetPickedObject(0) before the Render3DObject loop.
    this.pickedObject = null;
    this.drawingIn = viewer;
    for (const person of this.people) {
      const { obj, anim, simDir } = person;
      // Out of the world (in a car, at work, not arrived yet): not drawn. Neither is a hidden
      // person (+0x8e): HouseViewer::DoStaticToDynamicObjectTransitions lists only the 3D
      // objects with +0x8e == 0 for HouseViewer::Render3DObject.
      if (!drawable(person, viewer)) continue;
      const at = drawPos(person);
      // HouseViewer::Render3DObject: RoomManager::GetRoomAmbientLight at the person's view position.
      const [vx, vy] = RotatableWorld.rotateCoords(Math.round(at.fx), Math.round(at.fy), viewer.world.rotation, 0x400);
      const ambient = viewer.ambientAt(vx, vy, obj.level);
      const place: SimPlacement = {
        x: at.fx / 16,
        y: at.fy / 16,
        level: obj.level,
        alt: viewer.world.fixed.getFAlt(Math.round(at.fx), Math.round(at.fy)),
        direction: simDir ? simDir() : obj.dir,
      };
      // LightingRig::EngageLights: the lamps of the room at the person's root (world tile).
      const lamps = viewer.lighting?.roomLamps?.(Math.round(at.fx), Math.round(at.fy), obj.level) ?? [];
      this.picking(obj, () => this.renderer.renderSim(anim.vitaboy, place, view, { ambient, lamps }));
      this.drawHeadObject(person, place, view);
    }
    this.drawingIn = null;
  }

  /**
   * Animator::Render's picking (Mac 0x10475360, Windows 0x585fbd): while
   * picking is on and the cursor is in the view, the z-buffer value under the
   * cursor is read (HouseViewer::PointToZ) before and after the dressings are
   * drawn; when it changed, neither read being empty, the object becomes the
   * picked object. Otherwise the picked object is cleared.
   */
  private picking(obj: PlacedObject, render: () => void): void {
    const viewer = this.drawingIn;
    const at = this.pickPoint;
    if (!viewer || !at || at.x < 0 || at.y < 0 || at.x >= viewer.viewW || at.y >= viewer.viewH) {
      this.pickedObject = null;
      render();
      return;
    }
    const before = viewer.pointToZ(at.x, at.y);
    render();
    if (before === null) return;
    const after = viewer.pointToZ(at.x, at.y);
    if (after !== null && after !== before) this.pickedObject = obj;
  }

  /** Where draw() puts a person (null: not drawn), at `level` (the drawing level, or 1 for the RenderLoc frame). */
  private placementOf(person: LotPerson, viewer: HouseViewer, level: number): SimPlacement | null {
    const { obj, simDir } = person;
    if (!drawable(person, viewer)) return null;
    const at = drawPos(person);
    return {
      x: at.fx / 16,
      y: at.fy / 16,
      level,
      alt: viewer.world.fixed.getFAlt(Math.round(at.fx), Math.round(at.fy)),
      direction: simDir ? simDir() : obj.dir,
    };
  }

  /**
   * HouseViewer::RenderCensoredBlocks (101c5720, Windows 004ac916) with the
   * censor rectangle SAnimator::Render leaves (+0x228 / Windows +0x230): for
   * each person drawn whose censorship flags (person data 30) are set, the
   * screen bounding box of its censor dressing's vertices, as
   * (ftol(min), ftol(max + 0.999)) with y moved by -3 << (scale - 1); grown
   * by 1 / 2 / 4 pixels on each side and moved down 3 / 6 / 12 (scale
   * 1 / 2 / 3), it is censored (HouseViewer::Censor) behind the plane through
   * the censor point: the PELVIS bone (bone id 1) moved 1 unit toward the
   * camera (cAnimDeviceSub +0x180, the view direction scaled to
   * lbl_105BBEA8[9] = 1).
   */
  censor(viewer: HouseViewer): void {
    const view = LotPeople.viewOf(viewer);
    const cam = this.renderer.cameraFor(view);
    const s = viewer.scale;
    for (const person of this.people) {
      const flags = personLooks.get(person.obj)?.pd[PD_CENSOR] ?? 0;
      const dressing = person.anim.vitaboy.censor?.dressing;
      const place = flags !== 0 && dressing ? this.placementOf(person, viewer, person.obj.level) : null;
      if (!place || !dressing) continue;
      const root = rootTransform(place, view.rotation);
      let minX = 1e6;
      let minY = 1e6;
      let maxX = -1e6;
      let maxY = -1e6;
      let any = false;
      for (const m of dressing.meshes) {
        const out = m.binding.out;
        for (let i = 0; i < m.binding.mesh.realVertexCount; i++) {
          const o = i * VERTEX_FLOATS;
          const p = cam.project(transformPoint([out[o]!, out[o + 1]!, out[o + 2]!], root));
          minX = Math.min(minX, p.x);
          minY = Math.min(minY, p.y);
          maxX = Math.max(maxX, p.x);
          maxY = Math.max(maxY, p.y);
          any = true;
        }
      }
      if (!any) continue;
      const dy = -3 << (s - 1);
      let left = Math.trunc(minX);
      let top = Math.trunc(minY) + dy;
      let right = Math.trunc(maxX + 0.999);
      let bottom = Math.trunc(maxY + 0.999) + dy;
      if (left >= right || top >= bottom) continue;
      const [m, e] = s === 1 ? [1, 3] : s === 2 ? [2, 6] : s === 3 ? [4, 12] : [0, 0];
      top = top - m + e;
      left -= m;
      right += m;
      bottom = bottom + m + e;
      const pelvis = person.anim.vitaboy.skeleton.findBone("PELVIS");
      if (!pelvis) continue;
      const pt = transformPoint(pelvis.worldPos, rootTransform({ ...place, level: 1 }, view.rotation));
      const d = cam.camZ;
      viewer.censor(left, top, right - left, bottom - top, [pt[0] - d[0], pt[1] - d[1], pt[2] - d[2]], person.obj.level);
    }
  }

  /**
   * A 3D object in the person's HEAD slot (a plumb bob): SAnimator::
   * UpdatePose sets its root transform (the HEAD bone's position, then the
   * person's root transform) and its value (cXPerson::GetMotive(3), the
   * mood), then HouseViewer::Render3DObject draws it (Animator::Render).
   */
  private drawHeadObject(person: LotPerson, place: SimPlacement, view: SimView): void {
    const { obj } = person;
    const slot = obj.objectSlots.length - 1 < HEAD_SLOT ? undefined : obj.objectSlots[HEAD_SLOT];
    const held = slot && slot.containedId > 0 ? (this.objectById?.(slot.containedId) ?? null) : null;
    if (!held || (held.selector.objd.i16(0xcc) & 1) === 0 || !this.motive) return;
    if (!this.animators.has(held)) {
      this.animators.set(held, null);
      const strings = loadStringSet(held.selector.res, held.selector.objd.i16(0x26)) ?? [];
      void Animator.create(strings)
        .catch(() => null)
        .then((a) => this.animators.set(held, a));
      return;
    }
    const anim = this.animators.get(held);
    const head = person.anim.vitaboy.skeleton.findBone("HEAD");
    if (!anim || !head) return;
    // Animator::Render's hide flag for the date and star bobs: the carrier hidden or person data 74 bit 0.
    const pd = personLooks.get(obj)?.pd;
    if (anim.style !== AnimStyle.plumbBob && ((obj.objectData[OD_HIDDEN] ?? 0) !== 0 || ((pd?.[PD_RENDER_FLAGS] ?? 0) & 1) !== 0)) return;
    anim.root = mat4Mul(translationTf(head.worldPos), rootTransform(place, view.rotation));
    anim.value = Math.trunc(this.motive(obj, 3));
    this.picking(held, () => anim.render(this.renderer, view, this.now));
  }
}
