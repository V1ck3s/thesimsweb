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
import { loadPerson, rootTransform, SimRenderer, type SAnimator, type SimView } from "../sims/index.js";
import { quatRotate, transformPoint, type Vec3 } from "../sims/math3d.js";
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
}

/** Where a person is drawn: the walk engine's grid position while it moves, else the object's. */
function drawPos(p: LotPerson): { fx: number; fy: number } {
  return p.simPos?.() ?? p.obj;
}

export class LotPeople {
  private constructor(
    private readonly renderer: SimRenderer,
    readonly people: LotPerson[],
  ) {}

  /** Animators for the person objects that are neighbors of `nbhdDir`. */
  static async load(comp: Compositor, nbhdDir: string, objects: Iterable<PlacedObject>): Promise<LotPeople> {
    const nbhd = await loadNeighborhood(nbhdDir);
    const renderer = await SimRenderer.create(comp.gl);
    const people: LotPerson[] = [];
    await Promise.all(
      [...objects]
        .filter((o) => o.isPerson && o.hidden === 0 && o.tileX > 0 && o.tileY > 0)
        .map(async (obj) => {
          const nb = neighborByGuid(nbhd, obj.guid);
          if (!nb) return;
          const anim = await loadPerson(nbhdDir, nb.name).catch(() => null);
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
    const nb = neighborByGuid(nbhd, obj.guid);
    if (!nb) return false;
    const anim = await loadPerson(nbhdDir, nb.name).catch(() => null);
    if (!anim || !(await anim.startIdle())) return false;
    this.people.push({ obj, anim });
    return true;
  }

  /**
   * The simulation animates `obj` from now on: its practices are dropped,
   * `attach` receives the VitaBoy skeleton (the sim's SAnimator poses it),
   * and `dir` gives the facing to draw. False when `obj` has no animator.
   */
  bindSim(obj: PlacedObject, attach: (skeleton: Skeleton) => void, dir: () => number, pos?: () => { fx: number; fy: number } | null): boolean {
    const p = this.people.find((x) => x.obj === obj);
    if (!p) return false;
    p.anim.vitaboy.practices.length = 0;
    attach(p.anim.vitaboy.skeleton);
    p.simDir = dir;
    if (pos) p.simPos = pos;
    return true;
  }

  /**
   * SAnimator::PrepReg's registration point (VitaBoy::FindRegistration) in
   * lot world space (VitaBoy units, level 1): slot 0 is body strings 6 / 7
   * (the hand bone and its "Palm" offset), slot 1 body strings 4 / 5 (the
   * head and "Top"). The named offset is RotationTf(Z, a) * TranslationTf(t)
   * (lbl_105C2224: Palm (pi, 0.5 0 0), Top and HeadFake (-pi/2, 0.8 0 0),
   * Shoulder (pi, 0 0 1)), i.e. the point t in the bone's frame. Null when
   * the person has no such bone.
   */
  registrationPoint(obj: PlacedObject, slot: number, rotation: number, alt: number): Vec3 | null {
    const p = this.people.find((x) => x.obj === obj);
    if (!p || (slot !== 0 && slot !== 1)) return null;
    const bs = p.anim.bodyStrings;
    const bone = p.anim.vitaboy.skeleton.findBone(bs.get(slot === 0 ? 6 : 4));
    if (!bone) return null;
    const OFFSETS: Readonly<Record<string, Vec3>> = { palm: [0.5, 0, 0], top: [0.8, 0, 0], headfake: [0.8, 0, 0], shoulder: [0, 0, 1] };
    const t = OFFSETS[bs.get(slot === 0 ? 7 : 5).toLowerCase()] ?? [0, 0, 0];
    const r = quatRotate(bone.worldRot, t);
    const local: Vec3 = [bone.worldPos[0] + r[0], bone.worldPos[1] + r[1], bone.worldPos[2] + r[2]];
    const at = drawPos(p);
    const place = { x: at.fx / 16, y: at.fy / 16, level: 1, alt, direction: p.simDir ? p.simDir() : obj.dir };
    return transformPoint(local, rootTransform(place, rotation));
  }

  update(nowMs: number): void {
    // Sim-driven people have no practices here: this only deforms their meshes.
    for (const p of this.people) p.anim.update(nowMs);
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
    for (const person of this.people) {
      const { obj, anim, simDir } = person;
      if (obj.level > viewer.level) continue;
      const at = drawPos(person);
      // HouseViewer::Render3DObject: RoomManager::GetRoomAmbientLight at the person's view position.
      const [vx, vy] = RotatableWorld.rotateCoords(Math.round(at.fx), Math.round(at.fy), viewer.world.rotation, 0x400);
      const ambient = viewer.ambientAt(vx, vy, obj.level);
      this.renderer.renderSim(
        anim.vitaboy,
        { x: at.fx / 16, y: at.fy / 16, level: obj.level, alt: viewer.world.fixed.getFAlt(Math.round(at.fx), Math.round(at.fy)), direction: simDir ? simDir() : obj.dir },
        view,
        { ambient },
      );
    }
  }
}
