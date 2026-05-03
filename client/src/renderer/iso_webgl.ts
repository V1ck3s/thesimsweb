/**
 * WebGL2 isometric renderer — scaffold.
 *
 * Status: **scaffold only**. Renders the floor grid (one solid-color quad per
 * tile) plus the sky background. Sprites, walls, entities are NOT rendered
 * here yet — for those, the 2D Canvas path (`renderIso`) remains the
 * reference implementation.
 *
 * The point of this module is to prove the WebGL2 pipeline works in the
 * build, give us a place to land batched sprite rendering with a per-pixel
 * Z-buffer, and document the path forward.
 *
 * To extend:
 *   1. Build a sprite atlas from the active LoadedObject DGRPs (one big
 *      RGBA8 texture + UV mapping table).
 *   2. Add a fragment shader that reads a Z-buffer texture sample and writes
 *      `gl_FragDepth` so the GPU does the painter's algorithm per pixel.
 *   3. Replace per-tile draw calls with one batched draw using gl.drawElements
 *      + a vertex buffer of (sx, sy, depth, atlasU, atlasV).
 */

import type { IsoCamera, IsoScene } from "./iso.js";

const VERT_SRC = `#version 300 es
  in vec2 a_pos;
  in vec3 a_color;
  uniform vec2 u_canvas;
  out vec3 v_color;
  void main() {
    // a_pos is in pixel space; convert to clip space.
    vec2 clip = (a_pos / u_canvas) * 2.0 - 1.0;
    clip.y = -clip.y;
    gl_Position = vec4(clip, 0.0, 1.0);
    v_color = a_color;
  }
`;

const FRAG_SRC = `#version 300 es
  precision mediump float;
  in vec3 v_color;
  out vec4 outColor;
  void main() {
    outColor = vec4(v_color, 1.0);
  }
`;

interface GLState {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  posLoc: number;
  colorLoc: number;
  canvasUniform: WebGLUniformLocation | null;
  vbo: WebGLBuffer;
  vao: WebGLVertexArrayObject;
}

let glState: GLState | null = null;

function compileShader(gl: WebGL2RenderingContext, type: GLenum, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("createShader failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "";
    gl.deleteShader(shader);
    throw new Error(`shader compile error: ${log}`);
  }
  return shader;
}

function init(canvas: HTMLCanvasElement): GLState {
  const gl = canvas.getContext("webgl2", { antialias: false });
  if (!gl) throw new Error("WebGL2 not available");

  const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
  const program = gl.createProgram();
  if (!program) throw new Error("createProgram failed");
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`program link error: ${gl.getProgramInfoLog(program) ?? ""}`);
  }

  const posLoc = gl.getAttribLocation(program, "a_pos");
  const colorLoc = gl.getAttribLocation(program, "a_color");
  const canvasUniform = gl.getUniformLocation(program, "u_canvas");

  const vbo = gl.createBuffer();
  const vao = gl.createVertexArray();
  if (!vbo || !vao) throw new Error("buffer/VAO alloc failed");
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  // Layout: [x, y, r, g, b], 5 floats per vertex.
  const stride = 5 * 4;
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(colorLoc);
  gl.vertexAttribPointer(colorLoc, 3, gl.FLOAT, false, stride, 2 * 4);
  gl.bindVertexArray(null);

  return { gl, program, posLoc, colorLoc, canvasUniform, vbo, vao };
}

function projectTile(
  x: number,
  y: number,
  cam: IsoCamera,
  canvas: HTMLCanvasElement,
): { sx: number; sy: number } {
  const tw = cam.tileWidth;
  const th = cam.tileWidth / 2;
  let localX = x - cam.centerX;
  let localY = y - cam.centerY;
  switch (cam.rotation ?? 0) {
    case 1: { const t = localX; localX = -localY; localY = t; break; }
    case 2: { localX = -localX; localY = -localY; break; }
    case 3: { const t = localX; localX = localY; localY = -t; break; }
    default: break;
  }
  const sx = canvas.width / 2 + (localX - localY) * (tw / 2);
  const sy = canvas.height / 2 + (localX + localY) * (th / 2);
  return { sx, sy };
}

function hexToRgb(hex: string): [number, number, number] {
  // Accepts #RRGGBB or rgb(r,g,b)
  if (hex.startsWith("#") && hex.length === 7) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    return [r, g, b];
  }
  const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(hex);
  if (m) return [+m[1]! / 255, +m[2]! / 255, +m[3]! / 255];
  return [1, 0, 1]; // magenta sentinel
}

const TILE_LIGHT: [number, number, number] = [0x3b / 255, 0x6e / 255, 0x3b / 255];
const TILE_DARK: [number, number, number] = [0x32 / 255, 0x64 / 255, 0x32 / 255];
const SKY_DEFAULT: [number, number, number] = [0x10 / 255, 0x18 / 255, 0x28 / 255];

/**
 * Render the iso scene's floor grid via WebGL2. Sprites/walls/entities are
 * delegated to the 2D Canvas path elsewhere; this WebGL2 path renders just
 * the floor + sky, so callers wanting "WebGL2 mode" overlay a 2D canvas on
 * top for the rest until the pipeline is fleshed out.
 *
 * Throws if WebGL2 isn't available; callers should fall back to `renderIso`.
 */
export function renderIsoWebGL(canvas: HTMLCanvasElement, scene: IsoScene): void {
  if (!glState) {
    glState = init(canvas);
  }
  const { gl, program, vbo, vao, canvasUniform } = glState;
  gl.viewport(0, 0, canvas.width, canvas.height);

  // Clear with sky color.
  gl.clearColor(...SKY_DEFAULT, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);

  // Build a vertex buffer of all floor tile diamonds.
  const cam = scene.camera;
  const N = scene.gridSize;
  const tw = cam.tileWidth;
  const th = tw / 2;
  // Each tile is a diamond → 2 triangles → 6 vertices × 5 floats.
  const verts: number[] = [];
  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) {
      const { sx, sy } = projectTile(x, y, cam, canvas);
      const painted = scene.floorPaint?.get(y * N + x);
      const color: [number, number, number] = painted
        ? hexToRgb(painted)
        : (x + y) % 2 === 0 ? TILE_LIGHT : TILE_DARK;
      // Diamond corners: top, right, bottom, left.
      const top = [sx, sy - th / 2];
      const right = [sx + tw / 2, sy];
      const bottom = [sx, sy + th / 2];
      const left = [sx - tw / 2, sy];
      // Triangle 1: top-right-bottom; triangle 2: top-bottom-left.
      for (const [px, py] of [top, right, bottom, top, bottom, left]) {
        verts.push(px!, py!, color[0], color[1], color[2]);
      }
    }
  }
  gl.useProgram(program);
  gl.uniform2f(canvasUniform, canvas.width, canvas.height);
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);
  gl.drawArrays(gl.TRIANGLES, 0, verts.length / 5);
  gl.bindVertexArray(null);
}

/** Reset the cached WebGL state (e.g. on canvas resize/recreate). */
export function resetWebGLRenderer(): void {
  glState = null;
}
