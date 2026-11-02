/**
 * cRoofLayer::RenderRoofPolys: the roof meshes of the roof layers below the
 * current level, drawn through the 3D device (the people's camera,
 * sims/camera.ts) into the lot's color and depth buffers. HouseViewer's
 * UpdateStaticLayer calls it after the static layer when the roof is shown
 * (HouseViewer +0x51, CPState wall state 8).
 *
 * Per roofed cell (row r, column c of the layer, rows / columns 1..126):
 *   - mesh and quarter turns from cRoofMeshFactory::GetRoofMesh;
 *   - the tile's terrain altitude: its top corner when the four corners are
 *     equal; on sloped ground only ramps are drawn, at the altitude of the
 *     neighbor their style points to (style 4: DIRS[6], 2: DIRS[7],
 *     1: DIRS[5], 8: DIRS[4]);
 *   - model transform = [T(-0.75, 0, -0.75) RotY(turns * 90 deg)
 *     T(0.75, 0, 0.75)] T(p) (row vectors, lbl_105C1500 / 1510 / 150C), with
 *     p = level * (0.5, 9.3005, 0.5) RotY(-90 deg * rotation)
 *       + (1.5 r, GetTileHeight * roof altitude + 3 * altitude / (2 sqrt 6), 1.5 c).
 *
 * Lighting: RenderRoofPolys takes the viewport's lights off and adds the
 * layer's own directional light (cRoofLayer::Init: white, intensity 1,
 * direction (-0.3, -1, -0.6), lbl_105C14F4); the viewport's ambient is the
 * one Viewport3D starts with (0, the people's LightingRig restores it after
 * each person). The material is DDDMaterialMgr's "white" (diffuse =
 * ambient = 1) with the roof texture (GameData/Roofs/<pattern>.bmp), flat
 * normals (Mesh3D::AddFace never shares vertices), point sampling (the
 * texture filter render states are never set). So a texel is
 * texture * min(1, max(0, N . -L)).
 */

import { readAssetFile } from "../../engine/assets.js";
import { AnimDeviceCamera, type SimView } from "../sims/camera.js";
import { mat4Mul, rotationTf, transformDir, transformPoint, translationTf, vec3Normalize, type Mat4, type Vec3 } from "../sims/math3d.js";
import { DEFAULT_DEPTH } from "../sims/renderer.js";
import { decodeImage, type RgbaImage } from "../res/bmp.js";
import type { HouseViewer } from "./houseviewer.js";
import { getRoofMesh, getRoofPattern, getRoofPitch, roofFactoryVersion, roofLayersOf, roofTextureMissing, roofTileHeight, ROOF_RAMP, ROOF_ROOFED, type RoofLayer } from "./roofs.js";
import { DIRS, type FixedWorld } from "./world.js";

const VS = `#version 300 es
in vec3 aPos;
in vec3 aNormal;
in vec2 aUV;
uniform mat4 uViewProj;
uniform vec2 uPixelFix;
uniform vec3 uLightDir;
uniform float uAmbient;
out vec2 vUV;
out vec3 vColor;
out float vZ;
void main() {
  vec4 c = uViewProj * vec4(aPos, 1.0);
  vZ = c.z / c.w;
  gl_Position = vec4(c.xy + uPixelFix * c.w, c.z * 2.0 - c.w, c.w);
  vColor = min(vec3(1.0), vec3(uAmbient) + vec3(max(0.0, dot(aNormal, -uLightDir))));
  vUV = aUV;
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vUV;
in vec3 vColor;
in float vZ;
uniform sampler2D uTex;
uniform float uDepthMin;
uniform float uDepthRange;
out vec4 outColor;
void main() {
  outColor = vec4(texture(uTex, vUV).rgb * vColor, 1.0);
  gl_FragDepth = clamp((vZ * 65535.0 - uDepthMin) / uDepthRange, 0.0, 1.0);
}`;

const fr = Math.fround;
/** lbl_105C14F4: the roof light's direction (Light::SetPlacement normalizes it). */
const LIGHT_DIR = vec3Normalize([-0.3, -1, -0.6]);
/** Viewport3D +0x1e8 as RenderRoofPolys finds it. */
const VIEWPORT_AMBIENT = 0;
/** lbl_105BA328: 1 / (2 sqrt 6), terrain altitude units to world units (times 3). */
const ALT_SCALE = fr(1 / (2 * Math.sqrt(6)));
/** ZBufferLookup +0x94: one level up, before the view rotation (see camera.ts rootTransform). */
const LEVEL_VECTOR: Vec3 = [0.5, fr(9.3 + 0.0005111772335393302), 0.5];
/** lbl_105C1500 / lbl_105C1510: a cell's mesh turns around its center. */
const PIVOT = 0.75;
/** Floats per vertex: position, normal, texture coordinates. */
const STRIDE = 8;

interface LayerMesh {
  key: string;
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  count: number;
}

export class RoofRenderer {
  private readonly prog: WebGLProgram;
  private readonly u: Record<string, WebGLUniformLocation | null> = {};
  private readonly meshes: Array<LayerMesh | null> = [null, null];
  private readonly textures = new Map<string, WebGLTexture | null>();
  private readonly loading = new Set<string>();
  private camera: AnimDeviceCamera | null = null;
  private cameraKey = "";

  constructor(readonly gl: WebGL2RenderingContext) {
    this.prog = link(gl, VS, FS);
    for (const n of ["uViewProj", "uPixelFix", "uLightDir", "uAmbient", "uTex", "uDepthMin", "uDepthRange"]) this.u[n] = gl.getUniformLocation(this.prog, n);
  }

  /** HouseViewer::UpdateStaticLayer's roof part: RenderRoofPolys of layers 0 .. level - 1. */
  draw(viewer: HouseViewer): void {
    const tex = this.texture(getRoofPattern(), viewer);
    if (!tex) return;
    const gl = this.gl;
    const view: SimView = {
      zoom: viewer.scale,
      rotation: viewer.world.rotation,
      originX: viewer.originX,
      originY: viewer.originY,
      width: viewer.viewW,
      height: viewer.viewH,
    };
    const cam = this.cameraFor(view);
    const roofs = roofLayersOf(viewer.world.fixed);
    const blend = gl.isEnabled(gl.BLEND);
    gl.useProgram(this.prog);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.uniformMatrix4fv(this.u["uViewProj"]!, false, cam.viewProjection);
    gl.uniform2f(this.u["uPixelFix"]!, 1 / view.width, -1 / view.height);
    gl.uniform3fv(this.u["uLightDir"]!, LIGHT_DIR);
    gl.uniform1f(this.u["uAmbient"]!, VIEWPORT_AMBIENT);
    gl.uniform1f(this.u["uDepthMin"]!, DEFAULT_DEPTH.depthMin);
    gl.uniform1f(this.u["uDepthRange"]!, DEFAULT_DEPTH.depthRange);
    gl.uniform1i(this.u["uTex"]!, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    for (let i = 0; i < Math.min(viewer.level, 2); i++) {
      const key = `${roofs.version}|${roofFactoryVersion()}|${view.rotation}`;
      const m = this.layerMesh(i, key, roofs.layers[i]!, viewer.world.fixed, view.rotation);
      if (m.count === 0) continue;
      gl.bindVertexArray(m.vao);
      gl.drawArrays(gl.TRIANGLES, 0, m.count);
    }
    gl.bindVertexArray(null);
    if (blend) gl.enable(gl.BLEND);
  }

  private cameraFor(view: SimView): AnimDeviceCamera {
    const key = `${view.zoom}|${view.rotation}|${view.originX}|${view.originY}|${view.width}|${view.height}`;
    if (key !== this.cameraKey || !this.camera) {
      this.camera = new AnimDeviceCamera(view);
      this.cameraKey = key;
    }
    return this.camera;
  }

  /** The layer's cells in world space (rebuilt when the roof, the factory or the rotation change). */
  private layerMesh(index: number, key: string, layer: RoofLayer, fixed: FixedWorld, rotation: number): LayerMesh {
    const gl = this.gl;
    let m = this.meshes[index];
    if (m && m.key === key) return m;
    const data = buildRoofPolys(layer, fixed, index + 1, rotation, getRoofPitch());
    if (!m) {
      const vao = gl.createVertexArray()!;
      const vbo = gl.createBuffer()!;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      const attrs: Array<[string, number, number]> = [
        ["aPos", 3, 0],
        ["aNormal", 3, 12],
        ["aUV", 2, 24],
      ];
      for (const [name, size, off] of attrs) {
        const loc = gl.getAttribLocation(this.prog, name);
        if (loc < 0) continue;
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE * 4, off);
      }
      gl.bindVertexArray(null);
      m = { key: "", vao, vbo, count: 0 };
      this.meshes[index] = m;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, m.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    m.key = key;
    m.count = data.length / STRIDE;
    return m;
  }

  /**
   * DDDTextureMgr::GetNewTexture (texture site GameData/Roofs): the pattern's
   * BMP. A missing texture makes the factory fall back to "r1_".
   */
  private texture(name: string, viewer: HouseViewer): WebGLTexture | null {
    const t = this.textures.get(name);
    if (t !== undefined) {
      if (t === null) roofTextureMissing(name);
      return t;
    }
    if (!this.loading.has(name)) {
      this.loading.add(name);
      void loadRoofImage(name).then((img) => {
        this.loading.delete(name);
        this.textures.set(name, img ? this.upload(img) : null);
        viewer.dirty = true;
      });
    }
    return null;
  }

  private upload(img: RgbaImage): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
}

async function loadRoofImage(name: string): Promise<RgbaImage | null> {
  if (!name) return null;
  try {
    const bytes = await readAssetFile(`Sims/GameData/Roofs/${name}.bmp`);
    return decodeImage(bytes, `${name}.bmp`);
  } catch {
    return null;
  }
}

/**
 * RenderRoofPolys' loop over a layer: every roofed cell's mesh, transformed
 * to world space (positions, rotated face normals, texture coordinates).
 */
export function buildRoofPolys(layer: RoofLayer, fixed: FixedWorld, level: number, rotation: number, pitch: number): Float32Array {
  const out: number[] = [];
  const tileHeight = roofTileHeight(pitch);
  const lv = transformDir(LEVEL_VECTOR, rotationTf(1, fr(0.5 * fr(Math.PI * -(rotation & 3))))).map((v) => fr(v * level)) as Vec3;
  const turnStep = fr(fr(90 * fr(Math.PI)) / 180);
  const alt = fixed.alt;
  const topAlt = (x: number, y: number, dflt: number): number => (fixed.outOfGrid(x, y) ? dflt : alt.data[alt.offset(x, y) + 1]!);
  const n = layer.n;
  for (let r = 1; r < n - 1; r++) {
    for (let c = 1; c < n - 1; c++) {
      const flags = layer.flags(r, c);
      if ((flags & ROOF_ROOFED) === 0) continue;
      const x = c >> 1;
      const y = r >> 1;
      const o = alt.offset(x, y);
      const d = alt.data;
      let a = d[o + 1]!;
      if (!(d[o] === d[o + 2] && d[o] === d[o + 1] && d[o] === d[o + 3])) {
        if ((flags & ROOF_RAMP) === 0) continue;
        const style = flags >> 4;
        const dir = style === 4 ? DIRS[6]! : style === 2 ? DIRS[7]! : style === 1 ? DIRS[5]! : style === 8 ? DIRS[4]! : null;
        if (dir) a = topAlt(x + dir[0], y + dir[1], a);
      }
      const { faces, turns } = getRoofMesh(flags);
      const height = fr(fr(tileHeight * layer.alt(r, c)) + fr(3 * fr(a * ALT_SCALE)));
      const pos: Vec3 = [fr(lv[0] + fr(3 * fr(r * 0.5))), fr(height + lv[1]), fr(lv[2] + fr(3 * fr(c * 0.5)))];
      let model: Mat4 = translationTf(pos);
      if (turns !== 0) {
        const spin = mat4Mul(mat4Mul(translationTf([-PIVOT, 0, -PIVOT]), rotationTf(1, fr(turns * turnStep))), translationTf([PIVOT, 0, PIVOT]));
        model = mat4Mul(spin, model);
      }
      for (const f of faces) {
        const v: Vec3[] = [0, 1, 2].map((k) => [f[k * 5]!, fr(f[k * 5 + 1]! * pitch), f[k * 5 + 2]!] as Vec3);
        const nrm = transformDir(faceNormal(v[0]!, v[1]!, v[2]!), model);
        for (let k = 0; k < 3; k++) {
          const p = transformPoint(v[k]!, model);
          out.push(p[0], p[1], p[2], nrm[0], nrm[1], nrm[2], f[k * 5 + 3]!, f[k * 5 + 4]!);
        }
      }
    }
  }
  return new Float32Array(out);
}

/** Mesh3D::ComputeVertexNormals for one face: normalize((v2 - v1) x (v0 - v1)). */
function faceNormal(v0: Vec3, v1: Vec3, v2: Vec3): Vec3 {
  const e1: Vec3 = [v0[0] - v1[0], v0[1] - v1[1], v0[2] - v1[2]];
  const e2: Vec3 = [v2[0] - v1[0], v2[1] - v1[1], v2[2] - v1[2]];
  return vec3Normalize([e2[1] * e1[2] - e2[2] * e1[1], e2[2] * e1[0] - e2[0] * e1[2], e2[0] * e1[1] - e2[1] * e1[0]]);
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const compile = (type: number, src: string): WebGLShader => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader error");
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link error");
  return p;
}
