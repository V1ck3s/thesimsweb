/**
 * People rendering (VitaBoy), ported from the game's animation library.
 *
 * Plugging into the lot renderer (world/):
 *
 *   const simsGl = await SimRenderer.create(gl);          // same WebGL2 context as the compositor
 *   const person = await loadPerson("UserData", "user00001");
 *   await person.startIdle();                              // or person.startSkill("a2o-...")
 *   // every frame, after the sprites were drawn into the same framebuffer:
 *   person.update(nowMs);
 *   simsGl.renderSim(person.vitaboy,
 *     { x: tileX + 0.5, y: tileY + 0.5, level: 1, alt: 0, direction: 4 },
 *     { zoom, rotation, originX, originY, width, height });
 *
 * - (originX, originY) are HouseViewer's offsets: the screen position of the
 *   top corner of view tile (0, 0) at level 1 (screen x = originX +
 *   (8 << zoom) * (vx - vy), y = originY + (4 << zoom) * (vx + vy)).
 * - Placement is in world (unrotated) tile coordinates; the camera applies
 *   the view rotation (SetCameraPosition pivots around the 64x64 grid).
 * - Depth: fragments write gl_FragDepth = (z16 + 32768) / 131072 where z16 is
 *   the game's z-buffer value (65535 * eye distance / P, see camera.ts), the
 *   mapping world/compositor.ts uses; pass `{ depth }` to renderSim if that
 *   mapping changes. Leave the depth test LEQUAL and the depth buffer intact
 *   between the sprite pass and renderSim.
 * - `renderSim` is the single-call form asked for by the lot view.
 */

import { loadBodyStrings } from "../data/neighborhood.js";
import type { SimPlacement, SimView } from "./camera.js";
import { SimRenderer, type RenderSimOptions } from "./renderer.js";
import { SAnimator } from "./sanimator.js";

export { AnimDeviceCamera, CAMERA_EYE, CAMERA_FAR, rootTransform, unitsPerPixel, type SimPlacement, type SimView } from "./camera.js";
export { BodyStrings, BS } from "./bodystrings.js";
export { LoopMode, Practice } from "./practice.js";
export { DEFAULT_DEPTH, SimRenderer, type DepthMapping, type RenderSimOptions } from "./renderer.js";
export { SAnimator } from "./sanimator.js";
export { VBAnimMgr } from "./vbanimmgr.js";
export { VitaBoy } from "./vitaboy.js";

/** A neighbor's person animator, dressed from its character file (UserData<N>/Characters/<name>.iff). */
export async function loadPerson(dir: string, shortName: string): Promise<SAnimator | null> {
  return SAnimator.fromBodyStrings(await loadBodyStrings(dir, shortName));
}

const renderers = new WeakMap<WebGL2RenderingContext, Promise<SimRenderer>>();

/**
 * Draw `sim` at `pos` facing `direction` (45 degree steps) for the given
 * zoom/rotation view. Shares one SimRenderer per GL context.
 */
export async function renderSim(
  gl: WebGL2RenderingContext,
  sim: SAnimator,
  pos: Omit<SimPlacement, "direction">,
  direction: number,
  view: SimView,
  opts: RenderSimOptions = {},
): Promise<void> {
  let r = renderers.get(gl);
  if (!r) {
    r = SimRenderer.create(gl);
    renderers.set(gl, r);
  }
  (await r).renderSim(sim.vitaboy, { ...pos, direction }, view, opts);
}
