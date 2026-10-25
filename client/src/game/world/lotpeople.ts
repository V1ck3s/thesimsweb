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
import { loadPerson, SimRenderer, type SAnimator } from "../sims/index.js";
import type { Compositor } from "./compositor.js";
import type { HouseViewer } from "./houseviewer.js";
import type { PlacedObject } from "./objects.js";

/**
 * Ambient light for people. The original takes it from the room lightmaps
 * (HouseViewer::SetAmbientLightLevel), not ported yet; 0.6 matches daytime
 * interiors by eye.
 */
const PEOPLE_AMBIENT = 0.6;

export interface LotPerson {
  obj: PlacedObject;
  anim: SAnimator;
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

  update(nowMs: number): void {
    for (const p of this.people) p.anim.update(nowMs);
  }

  /** Draw everyone on the levels up to the viewer's current level. */
  draw(viewer: HouseViewer): void {
    const view = {
      zoom: viewer.scale,
      rotation: viewer.world.rotation,
      originX: viewer.originX,
      originY: viewer.originY,
      width: viewer.viewW,
      height: viewer.viewH,
    };
    for (const { obj, anim } of this.people) {
      if (obj.level > viewer.level) continue;
      this.renderer.renderSim(
        anim.vitaboy,
        { x: obj.fx / 16, y: obj.fy / 16, level: obj.level, alt: viewer.world.fixed.getFAlt(obj.fx, obj.fy), direction: obj.dir },
        view,
        { ambient: PEOPLE_AMBIENT },
      );
    }
  }
}
