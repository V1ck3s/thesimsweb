/**
 * WebGL2 isometric renderer.
 *
 * Renders the **floor grid + sprites** with a per-pixel Z-buffer driven by
 * `gl_FragDepth`. Walls / entities / hover / ghosts continue to render on the
 * 2D Canvas overlay above this layer (`renderIso` honours the
 * `webglOwnsFloorSprites` flag and skips what we paint here).
 *
 * Pipeline:
 *   1. Two shader programs share the same depth-write trick:
 *        SOLID — colored quads (floor tiles).
 *        SPRITE — textured quads (DGRP frames blitted from a runtime atlas).
 *      Both write `v_depth` into `gl_FragDepth`, so the GPU sorts overlapping
 *      pixels by depth instead of relying on CPU-side painter's algorithm.
 *   2. Sprite atlas — greedy shelf packing into a CPU canvas, uploaded as one
 *      RGBA8 texture. New bitmaps grow the atlas; bitmaps already packed reuse
 *      cached UVs (keyed by `Uint8Array` identity, which DGRP loaders pin).
 *   3. Single `drawArrays(TRIANGLES)` per program per frame after rebuilding
 *      vertex data on the CPU. The vertex layout is `(sx, sy, depth, u, v)`
 *      for sprites and `(sx, sy, depth, r, g, b)` for floor.
 *
 * Depth normalisation: rotated tile-space `(x + y)` mapped into `[0.05, 0.95]`
 * with smaller = closer (camera-front). A small per-drawable epsilon breaks
 * ties so identical tile-sums never z-fight.
 */

import type { IsoBitmap, IsoCamera, IsoScene, IsoSceneSprite } from "./iso.js";

const SOLID_VERT_SRC = `#version 300 es
in vec2 a_pos;
in float a_depth;
in vec3 a_color;
uniform vec2 u_canvas;
out vec3 v_color;
out float v_depth;
void main() {
  vec2 clip = (a_pos / u_canvas) * 2.0 - 1.0;
  clip.y = -clip.y;
  gl_Position = vec4(clip, 0.0, 1.0);
  v_color = a_color;
  v_depth = a_depth;
}
`;

const SOLID_FRAG_SRC = `#version 300 es
precision mediump float;
in vec3 v_color;
in float v_depth;
out vec4 outColor;
void main() {
  gl_FragDepth = v_depth;
  outColor = vec4(v_color, 1.0);
}
`;

const SPRITE_VERT_SRC = `#version 300 es
in vec2 a_pos;
in float a_depth;
in vec2 a_uv;
uniform vec2 u_canvas;
out vec2 v_uv;
out float v_depth;
void main() {
  vec2 clip = (a_pos / u_canvas) * 2.0 - 1.0;
  clip.y = -clip.y;
  gl_Position = vec4(clip, 0.0, 1.0);
  v_uv = a_uv;
  v_depth = a_depth;
}
`;

const SPRITE_FRAG_SRC = `#version 300 es
precision mediump float;
in vec2 v_uv;
in float v_depth;
uniform sampler2D u_atlas;
out vec4 outColor;
void main() {
  vec4 c = texture(u_atlas, v_uv);
  if (c.a < 0.01) discard;
  gl_FragDepth = v_depth;
  outColor = c;
}
`;

interface AtlasEntry {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  width: number;
  height: number;
}

interface AtlasState {
  size: number;
  packX: number;
  packY: number;
  rowH: number;
  texture: WebGLTexture;
  /** Backing pixel store — single RGBA8 texture. */
  pixels: Uint8Array;
  /** Cache: bitmap rgba buffer identity → atlas placement. */
  entries: Map<Uint8Array, AtlasEntry>;
  dirty: boolean;
  full: boolean;
}

interface GLState {
  gl: WebGL2RenderingContext;
  // SOLID (floor) program
  solidProgram: WebGLProgram;
  solidPosLoc: number;
  solidDepthLoc: number;
  solidColorLoc: number;
  solidCanvasUniform: WebGLUniformLocation | null;
  solidVbo: WebGLBuffer;
  solidVao: WebGLVertexArrayObject;
  // SPRITE program
  spriteProgram: WebGLProgram;
  spritePosLoc: number;
  spriteDepthLoc: number;
  spriteUvLoc: number;
  spriteCanvasUniform: WebGLUniformLocation | null;
  spriteAtlasUniform: WebGLUniformLocation | null;
  spriteVbo: WebGLBuffer;
  spriteVao: WebGLVertexArrayObject;
  atlas: AtlasState;
}

let glState: GLState | null = null;

const ATLAS_SIZE = 2048;
const ATLAS_PADDING = 1;

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

function linkProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const program = gl.createProgram();
  if (!program) throw new Error("createProgram failed");
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`program link error: ${gl.getProgramInfoLog(program) ?? ""}`);
  }
  return program;
}

function createAtlas(gl: WebGL2RenderingContext): AtlasState {
  const tex = gl.createTexture();
  if (!tex) throw new Error("atlas texture alloc failed");
  const pixels = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE * 4);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    ATLAS_SIZE,
    ATLAS_SIZE,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    pixels,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return {
    size: ATLAS_SIZE,
    packX: 0,
    packY: 0,
    rowH: 0,
    texture: tex,
    pixels,
    entries: new Map(),
    dirty: false,
    full: false,
  };
}

/** Reserve space for a bitmap in the atlas, blit its pixels, return UVs.
 *  Returns null if the atlas is full (caller should fall back). */
function packBitmap(atlas: AtlasState, bmp: IsoBitmap): AtlasEntry | null {
  const cached = atlas.entries.get(bmp.rgba);
  if (cached) return cached;
  if (atlas.full) return null;
  const w = bmp.width;
  const h = bmp.height;
  const padded = ATLAS_PADDING * 2;
  if (w + padded > atlas.size || h + padded > atlas.size) {
    atlas.full = true;
    return null;
  }
  if (atlas.packX + w + padded > atlas.size) {
    atlas.packX = 0;
    atlas.packY += atlas.rowH + padded;
    atlas.rowH = 0;
  }
  if (atlas.packY + h + padded > atlas.size) {
    atlas.full = true;
    return null;
  }
  const dx = atlas.packX + ATLAS_PADDING;
  const dy = atlas.packY + ATLAS_PADDING;
  // Blit row-by-row into the backing pixel store.
  for (let row = 0; row < h; row += 1) {
    const srcStart = row * w * 4;
    const dstStart = ((dy + row) * atlas.size + dx) * 4;
    atlas.pixels.set(bmp.rgba.subarray(srcStart, srcStart + w * 4), dstStart);
  }
  atlas.packX += w + padded;
  if (h > atlas.rowH) atlas.rowH = h;
  atlas.dirty = true;
  const entry: AtlasEntry = {
    u0: dx / atlas.size,
    v0: dy / atlas.size,
    u1: (dx + w) / atlas.size,
    v1: (dy + h) / atlas.size,
    width: w,
    height: h,
  };
  atlas.entries.set(bmp.rgba, entry);
  return entry;
}

function uploadAtlasIfDirty(gl: WebGL2RenderingContext, atlas: AtlasState): void {
  if (!atlas.dirty) return;
  gl.bindTexture(gl.TEXTURE_2D, atlas.texture);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    atlas.size,
    atlas.size,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    atlas.pixels,
  );
  atlas.dirty = false;
}

function init(canvas: HTMLCanvasElement): GLState {
  const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: false });
  if (!gl) throw new Error("WebGL2 not available");
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  // ---- SOLID (floor) program ---------------------------------------------
  const solidProgram = linkProgram(gl, SOLID_VERT_SRC, SOLID_FRAG_SRC);
  const solidPosLoc = gl.getAttribLocation(solidProgram, "a_pos");
  const solidDepthLoc = gl.getAttribLocation(solidProgram, "a_depth");
  const solidColorLoc = gl.getAttribLocation(solidProgram, "a_color");
  const solidCanvasUniform = gl.getUniformLocation(solidProgram, "u_canvas");
  const solidVbo = gl.createBuffer();
  const solidVao = gl.createVertexArray();
  if (!solidVbo || !solidVao) throw new Error("solid VAO/VBO alloc failed");
  gl.bindVertexArray(solidVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, solidVbo);
  // Layout: x, y, depth, r, g, b — 6 floats = 24 bytes.
  const solidStride = 6 * 4;
  gl.enableVertexAttribArray(solidPosLoc);
  gl.vertexAttribPointer(solidPosLoc, 2, gl.FLOAT, false, solidStride, 0);
  gl.enableVertexAttribArray(solidDepthLoc);
  gl.vertexAttribPointer(solidDepthLoc, 1, gl.FLOAT, false, solidStride, 2 * 4);
  gl.enableVertexAttribArray(solidColorLoc);
  gl.vertexAttribPointer(solidColorLoc, 3, gl.FLOAT, false, solidStride, 3 * 4);
  gl.bindVertexArray(null);

  // ---- SPRITE program ----------------------------------------------------
  const spriteProgram = linkProgram(gl, SPRITE_VERT_SRC, SPRITE_FRAG_SRC);
  const spritePosLoc = gl.getAttribLocation(spriteProgram, "a_pos");
  const spriteDepthLoc = gl.getAttribLocation(spriteProgram, "a_depth");
  const spriteUvLoc = gl.getAttribLocation(spriteProgram, "a_uv");
  const spriteCanvasUniform = gl.getUniformLocation(spriteProgram, "u_canvas");
  const spriteAtlasUniform = gl.getUniformLocation(spriteProgram, "u_atlas");
  const spriteVbo = gl.createBuffer();
  const spriteVao = gl.createVertexArray();
  if (!spriteVbo || !spriteVao) throw new Error("sprite VAO/VBO alloc failed");
  gl.bindVertexArray(spriteVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, spriteVbo);
  // Layout: x, y, depth, u, v — 5 floats = 20 bytes.
  const spriteStride = 5 * 4;
  gl.enableVertexAttribArray(spritePosLoc);
  gl.vertexAttribPointer(spritePosLoc, 2, gl.FLOAT, false, spriteStride, 0);
  gl.enableVertexAttribArray(spriteDepthLoc);
  gl.vertexAttribPointer(spriteDepthLoc, 1, gl.FLOAT, false, spriteStride, 2 * 4);
  gl.enableVertexAttribArray(spriteUvLoc);
  gl.vertexAttribPointer(spriteUvLoc, 2, gl.FLOAT, false, spriteStride, 3 * 4);
  gl.bindVertexArray(null);

  const atlas = createAtlas(gl);
  return {
    gl,
    solidProgram,
    solidPosLoc,
    solidDepthLoc,
    solidColorLoc,
    solidCanvasUniform,
    solidVbo,
    solidVao,
    spriteProgram,
    spritePosLoc,
    spriteDepthLoc,
    spriteUvLoc,
    spriteCanvasUniform,
    spriteAtlasUniform,
    spriteVbo,
    spriteVao,
    atlas,
  };
}

function projectTile(
  x: number,
  y: number,
  cam: IsoCamera,
  canvas: HTMLCanvasElement,
): { sx: number; sy: number } {
  const tw = cam.tileWidth;
  const th = tw / 2;
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

function rotatedSum(worldX: number, worldY: number, cam: IsoCamera): number {
  let lx = worldX - cam.centerX;
  let ly = worldY - cam.centerY;
  switch (cam.rotation ?? 0) {
    case 1: { const t = lx; lx = -ly; ly = t; break; }
    case 2: { lx = -lx; ly = -ly; break; }
    case 3: { const t = lx; lx = ly; ly = -t; break; }
    default: break;
  }
  return lx + ly;
}

/** Map rotated tile-sum into a depth value in `(0, 1)`, with smaller = closer
 *  to the camera. Floor and sprites at the same tile-sum collide; an `epsilon`
 *  per drawable breaks ties. */
function normalizeDepth(rawSum: number, gridSize: number, epsilon: number): number {
  // raw is in [-2N, +2N]. Map to [0.05, 0.95] inverted so larger sum → smaller depth.
  const span = 4 * gridSize;
  const t = (rawSum + 2 * gridSize) / span; // ∈ [0, 1]
  const d = 0.95 - t * 0.9;
  return Math.max(0.001, Math.min(0.999, d + epsilon));
}

function hexToRgb(hex: string): [number, number, number] {
  if (hex.startsWith("#") && hex.length === 7) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    return [r, g, b];
  }
  const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(hex);
  if (m) return [+m[1]! / 255, +m[2]! / 255, +m[3]! / 255];
  return [1, 0, 1];
}

const TILE_LIGHT: [number, number, number] = [0x3b / 255, 0x6e / 255, 0x3b / 255];
const TILE_DARK: [number, number, number] = [0x32 / 255, 0x64 / 255, 0x32 / 255];
const TILE_NORTH: [number, number, number] = [0x6f / 255, 0x59 / 255, 0x2e / 255];
const TILE_EAST: [number, number, number] = [0x6a / 255, 0x36 / 255, 0x2a / 255];

const SKY_DEFAULT: [number, number, number] = [0x10 / 255, 0x18 / 255, 0x28 / 255];

const SKY_ANCHORS: ReadonlyArray<{ atMin: number; color: [number, number, number] }> = [
  { atMin: 0, color: [0x10, 0x14, 0x28] },
  { atMin: 5 * 60, color: [0x10, 0x14, 0x28] },
  { atMin: 6 * 60, color: [0x6a, 0x4a, 0x70] },
  { atMin: 7 * 60, color: [0xe8, 0xa0, 0x70] },
  { atMin: 9 * 60, color: [0x6e, 0xb6, 0xe8] },
  { atMin: 14 * 60, color: [0x4a, 0x9a, 0xd6] },
  { atMin: 18 * 60, color: [0x6e, 0xb6, 0xe8] },
  { atMin: 19 * 60, color: [0xea, 0x80, 0x60] },
  { atMin: 20 * 60, color: [0x4a, 0x36, 0x60] },
  { atMin: 22 * 60, color: [0x18, 0x1c, 0x36] },
  { atMin: 24 * 60, color: [0x10, 0x14, 0x28] },
];

function skyColorFor(timeMinutes: number | undefined): [number, number, number] {
  if (timeMinutes === undefined) return SKY_DEFAULT;
  const t = ((timeMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
  for (let i = 0; i < SKY_ANCHORS.length - 1; i += 1) {
    const a = SKY_ANCHORS[i]!;
    const b = SKY_ANCHORS[i + 1]!;
    if (t >= a.atMin && t <= b.atMin) {
      const span = b.atMin - a.atMin || 1;
      const f = (t - a.atMin) / span;
      const r = (a.color[0] + (b.color[0] - a.color[0]) * f) / 255;
      const g = (a.color[1] + (b.color[1] - a.color[1]) * f) / 255;
      const bl = (a.color[2] + (b.color[2] - a.color[2]) * f) / 255;
      return [r, g, bl];
    }
  }
  return SKY_DEFAULT;
}

function pushQuad(
  out: number[],
  topX: number,
  topY: number,
  rightX: number,
  rightY: number,
  bottomX: number,
  bottomY: number,
  leftX: number,
  leftY: number,
  depth: number,
  c: [number, number, number],
): void {
  // top, right, bottom, top, bottom, left.
  out.push(topX, topY, depth, c[0], c[1], c[2]);
  out.push(rightX, rightY, depth, c[0], c[1], c[2]);
  out.push(bottomX, bottomY, depth, c[0], c[1], c[2]);
  out.push(topX, topY, depth, c[0], c[1], c[2]);
  out.push(bottomX, bottomY, depth, c[0], c[1], c[2]);
  out.push(leftX, leftY, depth, c[0], c[1], c[2]);
}

function pushSpriteQuad(
  out: number[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  depth: number,
  e: AtlasEntry,
): void {
  // Two triangles: (x0,y0)-(x1,y0)-(x1,y1), (x0,y0)-(x1,y1)-(x0,y1).
  out.push(x0, y0, depth, e.u0, e.v0);
  out.push(x1, y0, depth, e.u1, e.v0);
  out.push(x1, y1, depth, e.u1, e.v1);
  out.push(x0, y0, depth, e.u0, e.v0);
  out.push(x1, y1, depth, e.u1, e.v1);
  out.push(x0, y1, depth, e.u0, e.v1);
}

function buildFloorVerts(
  scene: IsoScene,
  canvas: HTMLCanvasElement,
  out: number[],
): void {
  const cam = scene.camera;
  const N = scene.gridSize;
  const tw = cam.tileWidth;
  const th = tw / 2;
  let i = 0;
  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) {
      const { sx, sy } = projectTile(x, y, cam, canvas);
      const painted = scene.floorPaint?.get(y * N + x);
      let color: [number, number, number];
      if (painted) {
        color = hexToRgb(painted);
      } else if (y === 0) {
        color = TILE_NORTH;
      } else if (x === N - 1) {
        color = TILE_EAST;
      } else {
        color = (x + y) % 2 === 0 ? TILE_LIGHT : TILE_DARK;
      }
      // Floor sits at the deepest end of the same-tile depth slot, with a
      // tiny epsilon so the diamond is consistently behind same-tile sprites.
      const depth = normalizeDepth(rotatedSum(x, y, cam), N, 0.001 + i * 1e-6);
      i += 1;
      // Diamond corners.
      pushQuad(
        out,
        sx, sy - th / 2,
        sx + tw / 2, sy,
        sx, sy + th / 2,
        sx - tw / 2, sy,
        depth,
        color,
      );
    }
  }
}

function buildSpriteVerts(
  scene: IsoScene,
  canvas: HTMLCanvasElement,
  atlas: AtlasState,
  out: number[],
): { drawn: number; skipped: number } {
  const cam = scene.camera;
  const N = scene.gridSize;
  let drawn = 0;
  let skipped = 0;
  for (let i = 0; i < scene.sprites.length; i += 1) {
    const s = scene.sprites[i] as IsoSceneSprite;
    const entry = packBitmap(atlas, s.bmp);
    if (!entry) {
      skipped += 1;
      continue;
    }
    const { sx, sy } = projectTile(s.worldX, s.worldY, cam, canvas);
    const drawX = Math.round(sx + s.sp.spriteXOffset);
    const drawY = Math.round(sy + s.sp.spriteYOffset);
    // Sprites sit slightly in front of the floor at the same tile (epsilon
    // negative). The per-sprite tiebreaker `i * 1e-6` keeps overlapping
    // sprites stable.
    const depth = normalizeDepth(rotatedSum(s.worldX, s.worldY, cam), N, -0.0005 - i * 1e-6);
    pushSpriteQuad(out, drawX, drawY, drawX + entry.width, drawY + entry.height, depth, entry);
    drawn += 1;
  }
  return { drawn, skipped };
}

/**
 * Render the floor + sprites of an iso scene via WebGL2. Walls / entities /
 * hover / ghosts continue to render on the 2D Canvas overlay above this.
 *
 * Throws if WebGL2 isn't available; callers should fall back to `renderIso`.
 */
export function renderIsoWebGL(canvas: HTMLCanvasElement, scene: IsoScene): void {
  if (!glState) {
    glState = init(canvas);
  }
  const {
    gl,
    solidProgram,
    solidVbo,
    solidVao,
    solidCanvasUniform,
    spriteProgram,
    spriteVbo,
    spriteVao,
    spriteCanvasUniform,
    spriteAtlasUniform,
    atlas,
  } = glState;
  gl.viewport(0, 0, canvas.width, canvas.height);

  const sky = skyColorFor(scene.timeMinutes);
  gl.clearColor(sky[0], sky[1], sky[2], 1);
  gl.clearDepth(1.0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  // ---- Floor pass --------------------------------------------------------
  const floorVerts: number[] = [];
  buildFloorVerts(scene, canvas, floorVerts);
  if (floorVerts.length > 0) {
    gl.useProgram(solidProgram);
    gl.uniform2f(solidCanvasUniform, canvas.width, canvas.height);
    gl.bindVertexArray(solidVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, solidVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(floorVerts), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, floorVerts.length / 6);
    gl.bindVertexArray(null);
  }

  // ---- Sprite pass -------------------------------------------------------
  const spriteVerts: number[] = [];
  buildSpriteVerts(scene, canvas, atlas, spriteVerts);
  uploadAtlasIfDirty(gl, atlas);
  if (spriteVerts.length > 0) {
    gl.useProgram(spriteProgram);
    gl.uniform2f(spriteCanvasUniform, canvas.width, canvas.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, atlas.texture);
    gl.uniform1i(spriteAtlasUniform, 0);
    gl.bindVertexArray(spriteVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, spriteVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(spriteVerts), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, spriteVerts.length / 5);
    gl.bindVertexArray(null);
  }
}

/** Reset the cached WebGL state (e.g. on canvas resize/recreate). */
export function resetWebGLRenderer(): void {
  glState = null;
}

/** Diagnostic info exposed for the dev HUD. */
export function webglRendererStats(): { atlasUsed: number; atlasFull: boolean } | null {
  if (!glState) return null;
  return { atlasUsed: glState.atlas.entries.size, atlasFull: glState.atlas.full };
}
