/**
 * WebGL2 renderer for VitaBoy characters: the RenderDIPMesh path
 * (DrawIndexedPrimitive of each dressing's deformed vertices with its
 * texture) under the lot camera (camera.ts) and the person light rig
 * (lighting.ts).
 *
 * Vertices are deformed on the CPU like the original (VitaBoy::Deform) and
 * streamed to one buffer per mesh. Lighting is per vertex (Direct3D fixed
 * function, "white" material): color = texture * min(1, ambient + light * max(0, N . -L)).
 *
 * Depth: the fragment depth is the Direct3D 16-bit z value
 * (65535 * z_ndc, 0 at the eye, 65535 at the far plane) mapped to
 * gl_FragDepth = (z16 - depthMin) / depthRange, the same mapping the lot
 * compositor uses for its sprite z-buffer, so sims and sprites occlude each
 * other per pixel with an ordinary LEQUAL depth test.
 */

import type { RgbaImage } from "../res/bmp.js";
import { AnimDeviceCamera, rootTransform, type SimPlacement, type SimView } from "./camera.js";
import type { SkeletonBinding } from "./deformablemesh.js";
import { VERTEX_FLOATS } from "./deformablemesh.js";
import { engageLights, loadStdLights, type U3DLight } from "./lighting.js";
import type { VitaBoy } from "./vitaboy.js";
import { mat4Mul, type Mat4, type Vec3 } from "./math3d.js";

const VS = `#version 300 es
in vec3 aPos;
in vec3 aNormal;
in vec2 aUV;
uniform mat4 uModel;      // row-vector matrices uploaded as-is: M_gl * v == v * M
uniform mat4 uViewProj;
uniform vec2 uPixelFix;   // D3D pixel centers: +0.5 px right, +0.5 px down
uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform vec3 uAmbient;
uniform int uLampCount;
uniform vec3 uLampDir[6];
uniform vec3 uLampColor[6];
out vec2 vUV;
out vec3 vColor;
out float vZ;
void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vec3 n = normalize(mat3(uModel) * aNormal);
  vec4 c = uViewProj * world;
  vZ = c.z / c.w;
  gl_Position = vec4(c.xy + uPixelFix * c.w, c.z * 2.0 - c.w, c.w);
  vec3 lit = uAmbient + uLightColor * max(0.0, dot(n, -uLightDir));
  for (int i = 0; i < 6; i++) {
    if (i >= uLampCount) break;
    lit += uLampColor[i] * max(0.0, dot(n, -uLampDir[i]));
  }
  vColor = min(vec3(1.0), lit);
  vUV = aUV;
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vUV;
in vec3 vColor;
in float vZ;
uniform sampler2D uTex;
uniform bool uHasTex;
uniform float uUntextured;
uniform float uDepthMin;
uniform float uDepthRange;
out vec4 outColor;
void main() {
  vec3 t = uHasTex ? texture(uTex, vUV).rgb : vec3(uUntextured);
  outColor = vec4(t * vColor, 1.0);
  gl_FragDepth = clamp((vZ * 65535.0 - uDepthMin) / uDepthRange, 0.0, 1.0);
}`;

/** Depth mapping shared with the lot compositor (world/compositor.ts). */
export interface DepthMapping {
  depthMin: number;
  depthRange: number;
}

export const DEFAULT_DEPTH: DepthMapping = { depthMin: -32768, depthRange: 131072 };

/**
 * A light set up by the caller instead of the person rig (Animator::Render's
 * self-lit objects: one directional light and a colored viewport ambient).
 */
export interface ObjectLighting {
  /** Direction the light travels, world space, unit length. */
  direction: Vec3;
  color: Vec3;
  ambient: Vec3;
}

export interface RenderSimOptions {
  /** Room ambient level 0..1 (RenderParam::GetAmbientLightLevel). */
  ambient?: number;
  /** Replaces the light rig (the person lighting) when set. */
  lighting?: ObjectLighting;
  /** The lamp lights of the person's room (RoomLighting.roomLamps), world positions. */
  lamps?: readonly (readonly [number, number, number])[];
  depth?: DepthMapping;
}

interface MeshGpu {
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  ibo: WebGLBuffer;
  count: number;
  version: number;
}

export class SimRenderer {
  private readonly prog: WebGLProgram;
  private readonly u: Record<string, WebGLUniformLocation | null> = {};
  private readonly meshes = new WeakMap<SkeletonBinding, MeshGpu>();
  private readonly textures = new WeakMap<RgbaImage, WebGLTexture>();
  private lights: U3DLight[] = [];
  private camera: AnimDeviceCamera | null = null;
  private cameraKey = "";

  private constructor(readonly gl: WebGL2RenderingContext) {
    this.prog = link(gl, VS, FS);
    for (const n of ["uModel", "uViewProj", "uPixelFix", "uLightDir", "uLightColor", "uAmbient", "uLampCount", "uLampDir", "uLampColor", "uTex", "uHasTex", "uUntextured", "uDepthMin", "uDepthRange"]) {
      this.u[n] = gl.getUniformLocation(this.prog, n);
    }
  }

  static async create(gl: WebGL2RenderingContext): Promise<SimRenderer> {
    const r = new SimRenderer(gl);
    r.lights = await loadStdLights();
    return r;
  }

  /** cAnimDeviceSub::SetCameraPosition for this view (cached while unchanged). */
  cameraFor(view: SimView): AnimDeviceCamera {
    const key = `${view.zoom}|${view.rotation}|${view.originX}|${view.originY}|${view.width}|${view.height}`;
    if (key !== this.cameraKey || !this.camera) {
      this.camera = new AnimDeviceCamera(view);
      this.cameraKey = key;
    }
    return this.camera;
  }

  /**
   * Draw one character into the currently bound framebuffer (viewport =
   * view.width x view.height). Leaves the depth test enabled (LEQUAL, depth
   * writes on), face culling off and blending as it was.
   */
  renderSim(vb: VitaBoy, place: SimPlacement, view: SimView, opts: RenderSimOptions = {}): void {
    this.renderSimModel(vb, rootTransform(place, view.rotation), view, opts);
  }

  /** renderSim with an explicit root transform (Create-a-Sim's cWinVitaBtn, portraits). */
  renderSimModel(vb: VitaBoy, model: Mat4, view: SimView, opts: RenderSimOptions = {}): void {
    const gl = this.gl;
    const cam = this.cameraFor(view);
    const own = opts.lighting;
    // LightingRig::SetPosition: the person's root (the model's translation).
    const rig = own ? null : engageLights(this.lights, cam, opts.ambient ?? 1, [model[12]!, model[13]!, model[14]!], opts.lamps ?? []);
    const depth = opts.depth ?? DEFAULT_DEPTH;
    const blend = gl.isEnabled(gl.BLEND);
    gl.useProgram(this.prog);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    // The meshes are wound so that the visible side is clockwise in GL's
    // y-up window space; cull the other side (opaque, closed meshes).
    gl.enable(gl.CULL_FACE);
    gl.frontFace(gl.CW);
    gl.cullFace(gl.BACK);
    const s = vb.scale;
    gl.uniformMatrix4fv(this.u["uModel"]!, false, s === 1 ? model : mat4Mul(new Float32Array([s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1]), model));
    gl.uniformMatrix4fv(this.u["uViewProj"]!, false, cam.viewProjection);
    gl.uniform2f(this.u["uPixelFix"]!, 1 / view.width, -1 / view.height);
    gl.uniform3fv(this.u["uLightDir"]!, own ? own.direction : rig!.direction);
    gl.uniform3fv(this.u["uLightColor"]!, own ? own.color : rig!.color);
    gl.uniform3fv(this.u["uAmbient"]!, own ? own.ambient : [rig!.ambient, rig!.ambient, rig!.ambient]);
    const lamps = rig?.lamps ?? [];
    gl.uniform1i(this.u["uLampCount"]!, lamps.length);
    if (lamps.length) {
      gl.uniform3fv(this.u["uLampDir"]!, lamps.flatMap((l) => l.direction));
      gl.uniform3fv(this.u["uLampColor"]!, lamps.flatMap((l) => l.color));
    }
    // Without a texture Direct3D shows the lit material (white); people keep their grey placeholder.
    gl.uniform1f(this.u["uUntextured"]!, own ? 1 : 0.5);
    gl.uniform1f(this.u["uDepthMin"]!, depth.depthMin);
    gl.uniform1f(this.u["uDepthRange"]!, depth.depthRange);
    gl.uniform1i(this.u["uTex"]!, 0);
    gl.activeTexture(gl.TEXTURE0);
    for (const d of vb.dressings.values()) {
      for (const m of d.meshes) {
        const g = this.meshGpu(m.binding, vb.version);
        const tex = m.image ? this.texture(m.image) : null;
        gl.uniform1i(this.u["uHasTex"]!, tex ? 1 : 0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.bindVertexArray(g.vao);
        gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_SHORT, 0);
      }
    }
    gl.bindVertexArray(null);
    gl.disable(gl.CULL_FACE);
    gl.frontFace(gl.CCW);
    if (blend) gl.enable(gl.BLEND);
  }

  private meshGpu(b: SkeletonBinding, version: number): MeshGpu {
    const gl = this.gl;
    let g = this.meshes.get(b);
    const real = b.mesh.realVertexCount * VERTEX_FLOATS;
    if (!g) {
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      const vbo = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, b.out.subarray(0, real), gl.DYNAMIC_DRAW);
      const stride = VERTEX_FLOATS * 4;
      const attrs: Array<[string, number, number]> = [
        ["aPos", 3, 0],
        ["aNormal", 3, 12],
        ["aUV", 2, 24],
      ];
      for (const [name, size, off] of attrs) {
        const loc = gl.getAttribLocation(this.prog, name);
        if (loc < 0) continue;
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off);
      }
      const ibo = gl.createBuffer()!;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, b.mesh.faces, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      g = { vao, vbo, ibo, count: b.mesh.faces.length, version };
      this.meshes.set(b, g);
    } else if (g.version !== version) {
      gl.bindBuffer(gl.ARRAY_BUFFER, g.vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, b.out.subarray(0, real));
      g.version = version;
    }
    return g;
  }

  private texture(img: RgbaImage): WebGLTexture {
    const gl = this.gl;
    let t = this.textures.get(img);
    if (!t) {
      t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(img.data.buffer));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      this.textures.set(img, t);
    }
    return t;
  }
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
