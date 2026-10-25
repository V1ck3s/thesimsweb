/**
 * WebGL2 stand-in for HouseViewer's render target: a color buffer plus the
 * 16-bit z-buffer the game's blitters test and write. Every blit carries the
 * same depth values the original computes (ZBufferLookup units, smaller =
 * nearer); the fragment shader writes them through gl_FragDepth so occlusion
 * is per pixel, exactly like the software z-buffer.
 *
 * Depth mapping: original values are ints that can leave [0, 0xffff] before
 * the 16-bit store; they map linearly to [0, 1] over [-32768, 98304) so the
 * order is preserved without wrapping. The depth test is LEQUAL like the
 * blitters' `newZ <= zbuf`.
 */

import { PX_ALPHA, PX_COLOR, PX_OPAQUE, type SpriteFrame } from "./spr.js";

const DEPTH_MIN = -32768;
const DEPTH_RANGE = 131072;
/** ClearZPixels value. */
export const Z_CLEAR = 0xffff;

/** Texture pair uploaded once per decoded frame and palette. */
export interface SpriteTex {
  width: number;
  height: number;
  /** RGBA: palette color, alpha = blend weight. */
  color: WebGLTexture;
  /** RG8: R = sprite z, G = PX_* mode * 64. */
  zmode: WebGLTexture;
  /** Which passes have pixels (skips empty draw calls). */
  hasOpaque: boolean;
  hasAlpha: boolean;
}

const VS = `#version 300 es
in vec2 aPos;
uniform vec4 uRect;   // x, y, w, h in target pixels
uniform vec2 uView;   // target size
uniform bool uFlip;
out vec2 vUV;
void main() {
  vec2 p = uRect.xy + aPos * uRect.zw;
  vUV = vec2(uFlip ? 1.0 - aPos.x : aPos.x, aPos.y);
  gl_Position = vec4(p.x / uView.x * 2.0 - 1.0, 1.0 - p.y / uView.y * 2.0, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUV;
uniform sampler2D uColor;
uniform sampler2D uZMode;
uniform sampler2D uTable;   // R32F lookup, 4096 wide
uniform int uMode;          // 0 z-sprite, 1 floor rows, 2 raw depth, 3 wall
uniform int uPass;          // 0 opaque (depth write), 1 alpha blend
uniform bool uAllowColorOnly;
uniform float uBase;        // base depth
uniform int uZLutOffset;    // z-sprite: table index of z = 0
uniform int uRowOffset;     // floor: table index of this sprite's first row
uniform float uTop;         // floor: target y of the sprite's first row
uniform float uViewH;
uniform int uRowIdx;        // wall: table index of the row term for target row 0
uniform int uColIdx[8];     // wall: per zone, table index of the column term for column 0
uniform float uZoneOff[8];  // wall: per zone depth offset
uniform float uLeft;        // wall: target x of the sprite's first column
out vec4 outColor;
float tableAt(int i) {
  return texelFetch(uTable, ivec2(i % 4096, i / 4096), 0).r;
}
void main() {
  vec4 c = texture(uColor, vUV);
  vec2 zm = texture(uZMode, vUV).rg;
  int mode = int(zm.g * 255.0 + 0.5) / 64;
  float depth;
  if (uMode == 2) {
    // Raw layer: color.rgb + 16-bit depth packed in zmode.rg.
    depth = floor(zm.r * 255.0 + 0.5) * 256.0 + floor(zm.g * 255.0 + 0.5);
    if (c.a == 0.0) discard;
    if (uPass != 0) discard;
  } else {
    if (mode == 0) discard;
    if (mode == ${PX_COLOR} && !uAllowColorOnly) discard;
    bool alphaPx = mode == ${PX_ALPHA};
    if ((uPass == 0) == alphaPx) discard;
    if (uMode == 0) {
      int z = int(zm.r * 255.0 + 0.5);
      depth = uBase + tableAt(uZLutOffset + z);
    } else if (uMode == 3) {
      // Wall: the sprite's z channel holds the zone (CutawayWallThickBlit), 0 for WallBlit.
      int k = int(zm.r * 255.0 + 0.5) & 7;
      int r = int(floor(uViewH - gl_FragCoord.y));
      int col = int(floor(gl_FragCoord.x)) - int(uLeft);
      depth = uBase + tableAt(uRowIdx - r) + tableAt(uColIdx[k] + col) + uZoneOff[k];
    } else {
      int r = int(floor(uViewH - gl_FragCoord.y)) - int(uTop);
      depth = uBase + tableAt(uRowOffset + r);
    }
  }
  gl_FragDepth = clamp((depth - ${DEPTH_MIN.toFixed(1)}) / ${DEPTH_RANGE.toFixed(1)}, 0.0, 1.0);
  outColor = c;
}`;

const UNIFORMS = [
  "uRect",
  "uView",
  "uFlip",
  "uColor",
  "uZMode",
  "uTable",
  "uMode",
  "uPass",
  "uAllowColorOnly",
  "uBase",
  "uZLutOffset",
  "uRowOffset",
  "uTop",
  "uViewH",
  "uRowIdx",
  "uColIdx",
  "uZoneOff",
  "uLeft",
] as const;

export class Compositor {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  private readonly prog: WebGLProgram;
  private readonly u = {} as Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>;
  private readonly quad: WebGLVertexArrayObject;
  private readonly tableTex: WebGLTexture;
  private table = new Float32Array(4096 * 16);
  private tableUsed = 0;
  private readonly tableSlots = new Map<string, number>();
  private tableDirty = true;
  /** Raw layer textures (terrain), reused across frames. */
  private rawColor: WebGLTexture | null = null;
  private rawZ: WebGLTexture | null = null;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = width;
    this.canvas.height = height;
    const gl = this.canvas.getContext("webgl2", { alpha: false, depth: true, antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL2 unavailable");
    this.gl = gl;
    this.prog = this.link(VS, FS);
    for (const n of UNIFORMS) {
      this.u[n] = gl.getUniformLocation(this.prog, n);
    }
    this.quad = gl.createVertexArray()!;
    gl.bindVertexArray(this.quad);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.prog, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.tableTex = gl.createTexture()!;
    gl.useProgram(this.prog);
    gl.uniform2f(this.u.uView!, width, height);
    gl.uniform1f(this.u.uViewH!, height);
    gl.uniform1i(this.u.uColor!, 0);
    gl.uniform1i(this.u.uZMode!, 1);
    gl.uniform1i(this.u.uTable!, 2);
    gl.viewport(0, 0, width, height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  private link(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const sh = (type: number, src: string): WebGLShader => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
    return p;
  }

  /** Register a lookup table (z-sprite or floor rows); returns its base index. */
  table1D(key: string, values: ArrayLike<number>): number {
    const have = this.tableSlots.get(key);
    if (have !== undefined) return have;
    const at = this.tableUsed;
    if (at + values.length > this.table.length) {
      const grown = new Float32Array(Math.ceil((at + values.length) / 4096 + 1) * 4096);
      grown.set(this.table);
      this.table = grown;
    }
    for (let i = 0; i < values.length; i++) this.table[at + i] = values[i]!;
    this.tableUsed = at + values.length;
    this.tableSlots.set(key, at);
    this.tableDirty = true;
    return at;
  }

  private uploadTable(): void {
    if (!this.tableDirty) return;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.tableTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 4096, this.table.length / 4096, 0, gl.RED, gl.FLOAT, this.table);
    this.tableDirty = false;
  }

  private texture(): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /** Upload a decoded frame with a 256-entry RGB palette. */
  uploadSprite(f: SpriteFrame, palette: Uint8Array): SpriteTex {
    const gl = this.gl;
    const n = f.width * f.height;
    const rgba = new Uint8Array(n * 4);
    const zm = new Uint8Array(n * 2);
    let hasOpaque = false;
    let hasAlpha = false;
    for (let i = 0; i < n; i++) {
      const idx = f.index[i]!;
      const mode = f.mode[i]!;
      if (mode === PX_ALPHA) hasAlpha = true;
      else if (mode !== 0) hasOpaque = true;
      rgba[i * 4] = palette[idx * 3]!;
      rgba[i * 4 + 1] = palette[idx * 3 + 1]!;
      rgba[i * 4 + 2] = palette[idx * 3 + 2]!;
      // 5-bit alpha blend weight (the alpha table averages a*8 .. a*8+7).
      rgba[i * 4 + 3] = mode === PX_ALPHA ? Math.min(255, Math.round(f.alpha[i]! * 8 + 3.5)) : mode === 0 ? 0 : 255;
      zm[i * 2] = f.z[i]!;
      zm[i * 2 + 1] = mode * 64;
    }
    const color = this.texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, f.width, f.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    const zmode = this.texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, f.width, f.height, 0, gl.RG, gl.UNSIGNED_BYTE, zm);
    return { width: f.width, height: f.height, color, zmode, hasOpaque, hasAlpha };
  }

  // --- frame ----------------------------------------------------------------

  clear(r: number, g: number, b: number): void {
    const gl = this.gl;
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(r / 255, g / 255, b / 255, 1);
    gl.clearDepth((Z_CLEAR - DEPTH_MIN) / DEPTH_RANGE);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  /** Clip rectangle (lbl_105BA5F4) in target pixels, or null for none. */
  setClip(r: { left: number; top: number; right: number; bottom: number } | null): void {
    const gl = this.gl;
    if (!r) {
      gl.disable(gl.SCISSOR_TEST);
      return;
    }
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(r.left, this.height - r.bottom, Math.max(0, r.right - r.left), Math.max(0, r.bottom - r.top));
  }

  private draw(tex: SpriteTex, x: number, y: number, flip: boolean, setup: () => void): void {
    const gl = this.gl;
    if (x >= this.width || y >= this.height || x + tex.width <= 0 || y + tex.height <= 0) return;
    gl.useProgram(this.prog);
    this.uploadTable();
    gl.bindVertexArray(this.quad);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex.color);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, tex.zmode);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.tableTex);
    gl.uniform4f(this.u.uRect!, x, y, tex.width, tex.height);
    gl.uniform1i(this.u.uFlip!, flip ? 1 : 0);
    setup();
    // Pass 0: opaque pixels with depth write; pass 1: alpha pixels blended.
    if (tex.hasOpaque) {
      gl.uniform1i(this.u.uPass!, 0);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    if (tex.hasAlpha) {
      gl.uniform1i(this.u.uPass!, 1);
      gl.depthMask(false);
      gl.enable(gl.BLEND);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
  }

  /**
   * Z-sprite blit (Spr2Decoder / ZSpriteBlit): pixel depth =
   * base + zLookup[z]; `zlut` is a table1D index of zLookup[0].
   */
  drawZSprite(tex: SpriteTex, x: number, y: number, flip: boolean, base: number, zlut: number): void {
    this.draw(tex, x, y, flip, () => {
      const gl = this.gl;
      gl.uniform1i(this.u.uMode!, 0);
      gl.uniform1i(this.u.uAllowColorOnly!, 0);
      gl.uniform1f(this.u.uBase!, base);
      gl.uniform1i(this.u.uZLutOffset!, zlut);
    });
  }

  /**
   * Floor blit (FloorBlit): pixel depth = base + rowTable[row]. `rows` is the
   * table1D index of the entry for the sprite's first row (y).
   */
  drawFloorSprite(tex: SpriteTex, x: number, y: number, flip: boolean, base: number, rows: number): void {
    this.draw(tex, x, y, flip, () => {
      const gl = this.gl;
      gl.uniform1i(this.u.uMode!, 1);
      gl.uniform1i(this.u.uAllowColorOnly!, 1);
      gl.uniform1f(this.u.uBase!, base);
      gl.uniform1i(this.u.uRowOffset!, rows);
      gl.uniform1f(this.u.uTop!, y);
    });
  }

  /**
   * Wall blit (WallBlit, CutawayWallThickBlit): color-only pixels whose depth
   * is base + table[rowIdx - row] + table[colIdx[k] + col] + zoneOff[k], with
   * row the target row, col the column within the sprite and k the sprite's
   * z value (0..7). The row term is the vertical lookup, the column term the
   * ortho wall lookup. The blitters test `newZ <= zbuf + 1`; callers pass
   * base - 1 so the LEQUAL test matches (the stored depth is then 1 lower).
   */
  drawWallSprite(tex: SpriteTex, x: number, y: number, base: number, rowIdx: number, colIdx: ArrayLike<number>, zoneOff: ArrayLike<number>): void {
    this.draw(tex, x, y, false, () => {
      const gl = this.gl;
      const ci = new Int32Array(8);
      const zo = new Float32Array(8);
      for (let k = 0; k < 8; k++) {
        ci[k] = colIdx[k] ?? colIdx[0] ?? 0;
        zo[k] = zoneOff[k] ?? 0;
      }
      gl.uniform1i(this.u.uMode!, 3);
      gl.uniform1i(this.u.uAllowColorOnly!, 1);
      gl.uniform1f(this.u.uBase!, base);
      gl.uniform1i(this.u.uRowIdx!, rowIdx);
      gl.uniform1iv(this.u.uColIdx!, ci);
      gl.uniform1fv(this.u.uZoneOff!, zo);
      gl.uniform1f(this.u.uLeft!, x);
    });
  }

  /** Full-target layer with its own 16-bit depth (terrain swatch output). */
  drawRaw(color: Uint32Array, depth: Uint16Array): void {
    const gl = this.gl;
    const w = this.width;
    const h = this.height;
    this.rawColor ??= this.texture();
    gl.bindTexture(gl.TEXTURE_2D, this.rawColor);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(color.buffer, color.byteOffset, w * h * 4));
    const zm = new Uint8Array(w * h * 2);
    for (let i = 0; i < w * h; i++) {
      const d = depth[i]!;
      zm[i * 2] = d >> 8;
      zm[i * 2 + 1] = d & 0xff;
    }
    this.rawZ ??= this.texture();
    gl.bindTexture(gl.TEXTURE_2D, this.rawZ);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, w, h, 0, gl.RG, gl.UNSIGNED_BYTE, zm);
    const tex: SpriteTex = { width: w, height: h, color: this.rawColor, zmode: this.rawZ, hasOpaque: true, hasAlpha: false };
    this.draw(tex, 0, 0, false, () => {
      gl.uniform1i(this.u.uMode!, 2);
    });
  }
}
