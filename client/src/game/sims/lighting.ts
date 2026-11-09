/**
 * Lights for people: U3DLightGroup ("GameData/Lights/stdlight.lgt") and the
 * LightingRig built from it (LightingRig::EngageLights).
 *
 * File (U3DLightGroup::ReadFromStream, little-endian):
 *   0xb0b0b0b0, count, then per light (U3DLight::ReadFromStream):
 *   magic (0xb0b0b0b0 or 0xb0b0b0b1), position (3 floats), direction (3 floats),
 *   type (int), color (3 floats), intensity (float), range (float), int, float,
 *   and 4 more floats when the magic is 0xb0b0b0b1.
 *
 * EngageLights orients each rig light's direction by the view rotation
 * (cAnimDeviceSub+0x12c), sets its intensity to the room ambient level and
 * sets the viewport's ambient light to that level too (LightingParameters
 * low/high = 0 and 1). With the "white" material (diffuse = ambient = 1)
 * Direct3D's vertex lighting gives  color = texture * min(1, A + A * max(0, N . -L)).
 *
 * Then the lamps of the person's room (Room::CollectObjectStats keeps the
 * first 6): a lamp more than 20 units away (d^2 > 400) is off; else a
 * ParallelPointLight from the lamp toward the person (SetPlacement), of
 * intensity 1 up to 15 units and 1 / (0.5 (d^2 - 225) + 1) beyond
 * (lbl_105BBF70 +4 / +8 / +0xc / +0x10), colour (1, 0.984, 0.82)
 * (lbl_105BFAC8..D0).
 */

import { readAssetFile } from "../../engine/assets.js";
import type { AnimDeviceCamera } from "./camera.js";
import { transformDir, vec3Normalize, type Vec3 } from "./math3d.js";

export interface U3DLight {
  position: Vec3;
  direction: Vec3;
  type: number;
  color: Vec3;
  intensity: number;
}

export function readLightGroup(bytes: Uint8Array): U3DLight[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const u32 = (): number => {
    const x = v.getUint32(o, true);
    o += 4;
    return x;
  };
  const f32 = (): number => {
    const x = v.getFloat32(o, true);
    o += 4;
    return x;
  };
  if (u32() !== 0xb0b0b0b0) throw new Error("lgt: bad magic");
  const n = u32();
  const out: U3DLight[] = [];
  for (let i = 0; i < n; i++) {
    const magic = u32();
    if (magic !== 0xb0b0b0b0 && magic !== 0xb0b0b0b1) throw new Error("lgt: bad light");
    const position: Vec3 = [f32(), f32(), f32()];
    const direction: Vec3 = [f32(), f32(), f32()];
    const type = u32();
    const color: Vec3 = [f32(), f32(), f32()];
    const intensity = f32();
    o += 12;
    if (magic === 0xb0b0b0b1) o += 16;
    out.push({ position, direction, type, color, intensity });
  }
  return out;
}

let stdLights: Promise<U3DLight[]> | null = null;

/** The standard rig (U3DLightGroup::Load("stdlight")). */
export function loadStdLights(): Promise<U3DLight[]> {
  stdLights ??= (async () => {
    const bytes = await readAssetFile("Sims/GameData/Lights/stdlight.lgt").catch(() => null);
    if (!bytes) return [];
    return readLightGroup(bytes);
  })();
  return stdLights;
}

/** What the vertex shader needs: one directional light, the lamps and the ambient level. */
export interface SimLighting {
  /** Direction the light travels, world space, unit length. */
  direction: Vec3;
  color: Vec3;
  ambient: number;
  /** The room's lamps that reach the person (at most 6): travel direction and colour x intensity. */
  lamps: { direction: Vec3; color: Vec3 }[];
}

/** LightingRig::EngageLights's lamp constants (lbl_105BBF70 +4 / +8 / +0xc / +0x10). */
const LAMP_I0 = 1;
const LAMP_CUTOFF = 400;
const LAMP_NEAR = 225;
const LAMP_FALLOFF = 0.5;
/** lbl_105BFAC8, lbl_105BFACC, lbl_105BFAD0. */
const LAMP_COLOR: Vec3 = [1, Math.fround(251 / 255), Math.fround(209 / 255)];

/**
 * LightingRig::EngageLights for one person. `roomAmbient` is the room's
 * ambient level (RenderParam::GetAmbientLightLevel, 1.0 by default; lower
 * indoors and at night).
 */
export function engageLights(
  lights: readonly U3DLight[],
  camera: AnimDeviceCamera,
  roomAmbient: number,
  position: Vec3 | null = null,
  lamps: readonly (readonly [number, number, number])[] = [],
): SimLighting {
  const l = lights[0];
  const dir: Vec3 = l ? vec3Normalize(transformDir(l.direction, camera.lightRotation)) : [0, -1, 0];
  const c: Vec3 = l ? l.color : [1, 1, 1];
  const level = Math.floor(0.5 + 255 * roomAmbient) / 255;
  const out: SimLighting["lamps"] = [];
  if (position) {
    const f = Math.fround;
    for (const p of lamps) {
      const d: Vec3 = [f(position[0] - p[0]), f(position[1] - p[1]), f(position[2] - p[2])];
      const d2 = f(f(f(d[2] * d[2]) + f(d[1] * d[1])) + f(d[0] * d[0]));
      if (d2 > LAMP_CUTOFF) continue;
      const intensity = d2 >= LAMP_NEAR ? f(LAMP_I0 / f(f(LAMP_FALLOFF * f(d2 - LAMP_NEAR)) + LAMP_I0)) : LAMP_I0;
      if (d2 === 0) continue;
      out.push({ direction: vec3Normalize(d), color: [LAMP_COLOR[0] * intensity, LAMP_COLOR[1] * intensity, LAMP_COLOR[2] * intensity] });
    }
  }
  return { direction: dir, color: [c[0] * roomAmbient, c[1] * roomAmbient, c[2] * roomAmbient], ambient: Math.min(1, level), lamps: out };
}
