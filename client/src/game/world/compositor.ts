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
uniform int uPass;          // 0 opaque, 1 alpha blend (both write depth)
uniform bool uAllowColorOnly;
uniform bool uNoAlpha;      // z-sprite: Spr2DecoderNoAlpha (alpha pixels drawn opaque, depth written)
uniform float uBase;        // base depth
uniform int uZLutOffset;    // z-sprite: table index of z = 0
uniform int uRowOffset;     // floor: table index of this sprite's first row
uniform float uTop;         // floor: target y of the sprite's first row
uniform float uViewH;
uniform int uRowIdx;        // wall: table index of the row term for target row 0
uniform int uColIdx[8];     // wall: per zone, table index of the column term for column 0
uniform float uZoneOff[8];  // wall: per zone depth offset
uniform float uLeft;        // wall: target x of the sprite's first column
uniform float uAmbientL;    // PalWrap dark map level 0..31, < 0 = full light (plain palette)
uniform int uLitN;          // lit blit: number of light maps (0 = plain blit)
uniform int uLitBase;       // lit blit: (int)(255 * ambient + 0.5)
uniform sampler2D uLit0;    // R8 light maps (Surface8)
uniform sampler2D uLit1;
uniform vec2 uLit0Org;      // target pixel of the maps' texel (0, 0)
uniform vec2 uLit1Org;
out vec4 outColor;
float litAt(sampler2D m, vec2 org) {
  ivec2 t = ivec2(floor(gl_FragCoord.x), int(floor(uViewH - gl_FragCoord.y))) - ivec2(org);
  ivec2 n = textureSize(m, 0);
  if (t.x < 0 || t.y < 0 || t.x >= n.x || t.y >= n.y) return 0.0;
  return floor(texelFetch(m, t, 0).r * 255.0 + 0.5);
}
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
    bool alphaPx = mode == ${PX_ALPHA} && !uNoAlpha;
    if ((uPass == 0) == alphaPx) discard;
    if (alphaPx && c.a == 0.0) discard;
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
  float level = uAmbientL;
  if (uLitN > 0 && uMode != 2) {
    // Lit*Blit: the light maps add to the ambient byte, clamped, then the
    // dark map row (level & 0xf8) / 8.
    float l = float(uLitBase) + litAt(uLit0, uLit0Org);
    if (uLitN > 1) l += litAt(uLit1, uLit1Org);
    level = floor(clamp(l, 0.0, 255.0) / 8.0);
  }
  if (level >= 0.0 && uMode != 2) {
    // PrecomputeDarkMap: per 5-bit channel, b + c * (max(b, L) - b) / 31 with
    // the night color (0, 0, 10) >> 3 as b.
    vec3 c5 = floor(c.rgb * 255.0 / 8.0 + 0.001);
    vec3 b = vec3(0.0, 0.0, 1.0);
    vec3 o = floor(0.5 + b + c5 * (max(b, vec3(level)) - b) / 31.0);
    c.rgb = o * 8.0 / 255.0;
  }
  gl_FragDepth = clamp((depth - ${DEPTH_MIN.toFixed(1)}) / ${DEPTH_RANGE.toFixed(1)}, 0.0, 1.0);
  outColor = c;
}`;

/** writeRegion's pass: the region's texels, skipping alpha 0 (no depth, no blending). */
const PATCH_FS = `#version 300 es
precision highp float;
uniform sampler2D uPatch;
uniform ivec2 uAt;
out vec4 outColor;
void main() {
  vec4 c = texelFetch(uPatch, ivec2(gl_FragCoord.xy) - uAt, 0);
  if (c.a == 0.0) discard;
  outColor = vec4(c.rgb, 1.0);
}`;

/**
 * DrawShadow(x, y, shadow, offset, w, h, rows, base): a shadow byte b with
 * offset + b < 0xf8 (clamped at 0) darkens the target pixel by the dark
 * map row (offset + b) >> 3 where base + rows[row] <= the z-buffer; the
 * z-buffer is not written. uDst holds the target under the rectangle.
 */
const SHADOW_FS = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUV;
uniform sampler2D uShadow;  // R8: the Surface8 bytes
uniform sampler2D uDst;     // the target's color under the rectangle
uniform sampler2D uTable;
uniform vec4 uRect;
uniform ivec2 uAt;          // GL origin of the uDst copy
uniform float uViewH;
uniform float uOffset;
uniform float uBase;
uniform int uRowOffset;
out vec4 outColor;
float tableAt(int i) {
  return texelFetch(uTable, ivec2(i % 4096, i / 4096), 0).r;
}
void main() {
  ivec2 t = ivec2(floor(vUV * uRect.zw));
  float lvl = uOffset + floor(texelFetch(uShadow, t, 0).r * 255.0 + 0.5);
  if (lvl >= 248.0) discard;
  float level = floor(max(lvl, 0.0) / 8.0);
  int r = int(floor(uViewH - gl_FragCoord.y)) - int(uRect.y);
  float depth = uBase + tableAt(uRowOffset + r);
  vec4 c = texelFetch(uDst, ivec2(gl_FragCoord.xy) - uAt, 0);
  vec3 c5 = floor(c.rgb * 255.0 / 8.0 + 0.001);
  vec3 b = vec3(0.0, 0.0, 1.0);
  vec3 o = floor(0.5 + b + c5 * (max(b, vec3(level)) - b) / 31.0);
  gl_FragDepth = clamp((depth - ${DEPTH_MIN.toFixed(1)}) / ${DEPTH_RANGE.toFixed(1)}, 0.0, 1.0);
  outColor = vec4(o * 8.0 / 255.0, 1.0);
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
  "uNoAlpha",
  "uBase",
  "uZLutOffset",
  "uRowOffset",
  "uTop",
  "uViewH",
  "uRowIdx",
  "uColIdx",
  "uZoneOff",
  "uLeft",
  "uAmbientL",
  "uLitN",
  "uLitBase",
  "uLit0",
  "uLit1",
  "uLit0Org",
  "uLit1Org",
] as const;

/** A light map placed on the target (see Compositor.light). */
export interface LitMap {
  tex: WebGLTexture;
  /** Target pixel of the map's (0, 0). */
  x: number;
  y: number;
}

/** readRegion's depth pass: the depth texel at uAt + the fragment, packed into 24 bits of RGB. */
const DEPTH_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID & 1) << 2) - 1.0, float((gl_VertexID & 2) << 1) - 1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;
const DEPTH_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uDepth;
uniform ivec2 uAt;
out vec4 outColor;
void main() {
  float v = floor(texelFetch(uDepth, uAt + ivec2(gl_FragCoord.xy), 0).r * 16777215.0 + 0.5);
  float hi = floor(v / 65536.0);
  float mid = floor((v - hi * 65536.0) / 256.0);
  float lo = v - hi * 65536.0 - mid * 256.0;
  outColor = vec4(hi, mid, lo, 255.0) / 255.0;
}`;

/**
 * The blend weight of an SPR2 alpha pixel as the Windows Spr2Decoder565 /
 * 555 (004bbca9, 004bdbcc, and their long-run helper 004bc271) use the
 * alpha byte: below 8 the pixel is skipped (0: discarded), above 0xf7 it is
 * drawn opaque, otherwise it is blended through the alpha table row
 * (alpha & 0x1f), which averages a * 8 .. a * 8 + 7 (InitAlphaZSpriteBlit,
 * 0049a42a). (The Mac decoders blend every alpha pixel by its 5-bit alpha.)
 */
function alphaWeight(a: number): number {
  if (a < 8) return 0;
  if (a > 0xf7) return 255;
  return Math.round((a & 0x1f) * 8 + 3.5);
}

type ClipRect = { left: number; top: number; right: number; bottom: number };

/** Compositor.swapRawState */
export interface RawLayerState {
  raw: Array<{ tex: WebGLTexture[]; fb: WebGLFramebuffer[] }>;
  rawCur: number;
  rawValid: boolean;
  rawW: number;
  rawH: number;
}

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
  /**
   * Ambient light level the next sprite draws use (RenderParam ambient ->
   * PalWrap::ChooseBestCLUT): 1 = the plain palette, otherwise colors go
   * through the dark map at level ((255 * ambient + 0.5) & 0xf8) / 8.
   */
  ambient = 1;
  /**
   * Lit blit for the next draws (LitFloorBlit / LitFloorAddBlit /
   * LitWallBlit / LitWallAddBlit): `base` = (int)(255 * ambient + 0.5) and one
   * or two light maps; null = the plain blit at `ambient`.
   */
  light: { base: number; maps: LitMap[] } | null = null;
  private readonly lightTex = new Map<object, WebGLTexture>();
  /**
   * Raw layer textures (terrain), reused across frames: two sets, so a
   * scrolled layer is copied shifted from one to the other on the GPU
   * (shiftRaw); `rawCur` is the one drawn. Each holds the colors for an
   * even and for an odd view origin row (the swatches dither by screen
   * row) and the depth, with their framebuffers.
   */
  private raw: Array<{ tex: WebGLTexture[]; fb: WebGLFramebuffer[] }> = [];
  private rawCur = 0;
  private rawW = 0;
  private rawH = 0;
  /** The current raw layer holds an upload for the target's size. */
  private rawValid = false;
  private rawZBytes: Uint16Array | null = null;
  /** drawWallSprite's uniform arrays (rewritten every call). */
  private readonly wallColIdx = new Int32Array(8);
  private readonly wallZoneOff = new Float32Array(8);
  /** Render target (color + depth texture) and the depth readback pass. */
  private readonly target: WebGLFramebuffer;
  private readonly colorRb: WebGLRenderbuffer;
  private readonly depthTex: WebGLTexture;
  private depthProg: WebGLProgram | null = null;
  private depthOut: WebGLFramebuffer | null = null;
  private depthOutRb: WebGLRenderbuffer | null = null;
  private depthOutSize = [1, 1];
  private patchProg: WebGLProgram | null = null;
  private shadowProg: WebGLProgram | null = null;
  private shadowDst: WebGLTexture | null = null;
  private shadowDstSize = [0, 0];
  private readonly shadowTex = new WeakMap<object, WebGLTexture>();
  /**
   * lbl_105BA240[0x39] clear (InitSpr2Decoder(1)): z-sprites go through the
   * Spr2DecoderNoAlpha* decoders, which draw an alpha pixel (SPR2 cmd 2) like
   * an opaque one (depth tested and written, alpha ignored).
   */
  spr2NoAlpha = false;
  private patchTex: WebGLTexture | null = null;

  constructor(
    /** The target size; changed by resize (HouseViewer::SetViewportHeight). */
    public width: number,
    public height: number,
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
    gl.uniform1i(this.u.uLit0!, 3);
    gl.uniform1i(this.u.uLit1!, 4);
    gl.viewport(0, 0, width, height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // The render target: a color buffer and a depth texture, so the z-buffer
    // can be read back (HouseViewer::PointToTile locks the z surface); the
    // default framebuffer's depth cannot be read in WebGL. present() copies
    // the color to the canvas.
    this.target = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target);
    this.colorRb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.colorRb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, width, height);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.colorRb);
    this.depthTex = this.texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT32F, width, height, 0, gl.DEPTH_COMPONENT, gl.FLOAT, null);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.depthTex, 0);
  }

  /**
   * cAnimDeviceSub::SetViewportHeight (Viewport3D::SetDimensions): the
   * target, its depth and the canvas take the new size; the next frame is
   * drawn whole.
   */
  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    const gl = this.gl;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.colorRb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, width, height);
    gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT32F, width, height, 0, gl.DEPTH_COMPONENT, gl.FLOAT, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target);
    gl.useProgram(this.prog);
    gl.uniform2f(this.u.uView!, width, height);
    gl.uniform1f(this.u.uViewH!, height);
    gl.viewport(0, 0, width, height);
    this.rawZBytes = null;
    this.rawValid = false;
  }

  /** The frame is finished: copy the target's color to the canvas. */
  present(): void {
    const gl = this.gl;
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.target);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, this.width, this.height, 0, 0, this.width, this.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target);
    this.applyScissor();
  }

  /**
   * The z-buffer value at a target pixel (ZBufferLookup units), or null where
   * nothing was drawn (Z_CLEAR). The depth texture is sampled by a one-pixel
   * pass that packs it into RGBA8, which is read back.
   */
  readDepth(px: number, py: number): number | null {
    const x = Math.trunc(px);
    const y = Math.trunc(py);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return null;
    const z = this.readRegion(x, y, 1, 1).depth[0]!;
    return z >= Z_CLEAR ? null : z;
  }

  /**
   * The target's color (RGBA, top row first) and z-buffer values
   * (ZBufferLookup units; Z_CLEAR where nothing was drawn) of a rectangle in
   * target pixels, which must lie inside the target. The depth texture is
   * sampled by a pass that packs it into RGBA8, which is read back.
   */
  readRegion(x: number, y: number, w: number, h: number): { color: Uint8Array; depth: Int32Array } {
    const gl = this.gl;
    const by = this.height - y - h;
    const flipRows = (src: Uint8Array): Uint8Array => {
      const out = new Uint8Array(src.length);
      for (let r = 0; r < h; r++) out.set(src.subarray((h - 1 - r) * w * 4, (h - r) * w * 4), r * w * 4);
      return out;
    };
    const raw = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target);
    gl.readPixels(x, by, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    const color = flipRows(raw);
    if (!this.depthProg) {
      this.depthProg = this.link(DEPTH_VS, DEPTH_FS);
      this.depthOut = gl.createFramebuffer();
      this.depthOutRb = gl.createRenderbuffer();
      this.depthOutSize = [0, 0];
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.depthOut);
    if (this.depthOutSize[0] !== w || this.depthOutSize[1] !== h) {
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthOutRb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.depthOutRb);
      this.depthOutSize = [w, h];
    }
    gl.viewport(0, 0, w, h);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(this.depthProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
    gl.uniform2i(gl.getUniformLocation(this.depthProg, "uAt"), x, by);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    // Not left on a unit while it is the target's depth (feedback loop).
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target);
    gl.viewport(0, 0, this.width, this.height);
    gl.enable(gl.DEPTH_TEST);
    this.applyScissor();
    const packed = flipRows(raw);
    const depth = new Int32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const d = (packed[i * 4]! * 65536 + packed[i * 4 + 1]! * 256 + packed[i * 4 + 2]!) / 16777215;
      depth[i] = Math.round(d * DEPTH_RANGE + DEPTH_MIN);
    }
    return { color, depth };
  }

  /**
   * Overwrite the target's color in a rectangle with `rgba` (top row first)
   * where its alpha is non-zero; the z-buffer is left as it is.
   */
  writeRegion(x: number, y: number, w: number, h: number, rgba: Uint8Array): void {
    const gl = this.gl;
    const by = this.height - y - h;
    this.patchProg ??= this.link(DEPTH_VS, PATCH_FS);
    this.patchTex ??= this.texture();
    const rows = new Uint8Array(rgba.length);
    for (let r = 0; r < h; r++) rows.set(rgba.subarray((h - 1 - r) * w * 4, (h - r) * w * 4), r * w * 4);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.patchTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, rows);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target);
    gl.viewport(x, by, w, h);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.depthMask(false);
    gl.useProgram(this.patchProg);
    gl.uniform1i(gl.getUniformLocation(this.patchProg, "uPatch"), 0);
    gl.uniform2i(gl.getUniformLocation(this.patchProg, "uAt"), x, by);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthMask(true);
    gl.viewport(0, 0, this.width, this.height);
    gl.enable(gl.DEPTH_TEST);
    this.applyScissor();
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
    // The quad's vertex array feeds attribute 0 in every program.
    gl.bindAttribLocation(p, 0, "aPos");
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
      rgba[i * 4 + 3] = mode === PX_ALPHA ? alphaWeight(f.alpha[i]!) : mode === 0 ? 0 : 255;
      zm[i * 2] = f.z[i]!;
      zm[i * 2 + 1] = mode * 64;
    }
    const color = this.texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, f.width, f.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    const zmode = this.texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, f.width, f.height, 0, gl.RG, gl.UNSIGNED_BYTE, zm);
    return { width: f.width, height: f.height, color, zmode, hasOpaque, hasAlpha };
  }

  /** R8 texture of a light map (Surface8), uploaded once per map object. */
  lightMapTexture(m: { width: number; height: number; data: Uint8Array }): WebGLTexture {
    let t = this.lightTex.get(m);
    if (t) return t;
    const gl = this.gl;
    t = this.texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, m.width, m.height, 0, gl.RED, gl.UNSIGNED_BYTE, m.data);
    this.lightTex.set(m, t);
    return t;
  }

  // --- frame ----------------------------------------------------------------

  clear(r: number, g: number, b: number): void {
    const gl = this.gl;
    this.userClip = null;
    this.applyScissor();
    gl.clearColor(r / 255, g / 255, b / 255, 1);
    gl.clearDepth((Z_CLEAR - DEPTH_MIN) / DEPTH_RANGE);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  /** setClip's rectangle, and the frame's (setFrameClip). */
  private userClip: ClipRect | null = null;
  private frameClip: ClipRect | null = null;

  /** Clip rectangle (lbl_105BA5F4) in target pixels, or null for none. */
  setClip(r: ClipRect | null): void {
    this.userClip = r;
    this.applyScissor();
  }

  /**
   * Not part of the original (perf): every draw of the frame, clears
   * included, stays inside `r` (null: the whole target). The picture in
   * picture renders the lot only where its window shows it.
   */
  setFrameClip(r: ClipRect | null): void {
    this.frameClip = r;
    this.applyScissor();
  }

  /** The scissor for setClip's rectangle within the frame clip. */
  private applyScissor(): void {
    const gl = this.gl;
    const a = this.userClip;
    const b = this.frameClip;
    const r = a && b ? { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) } : (a ?? b);
    if (!r) {
      gl.disable(gl.SCISSOR_TEST);
      return;
    }
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(r.left, this.height - r.bottom, Math.max(0, r.right - r.left), Math.max(0, r.bottom - r.top));
  }

  private draw(tex: SpriteTex, x: number, y: number, flip: boolean, setup: () => void, noAlpha = false): void {
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
    const a = this.ambient;
    gl.uniform1f(this.u.uAmbientL!, Math.abs(a - 1) > 1e-6 ? (Math.trunc(255 * a + 0.5) & 0xf8) / 8 : -1);
    const lit = this.light;
    gl.uniform1i(this.u.uLitN!, lit ? Math.min(2, lit.maps.length) : 0);
    if (lit) {
      gl.uniform1i(this.u.uLitBase!, lit.base);
      const m0 = lit.maps[0];
      const m1 = lit.maps[1] ?? m0;
      if (m0 && m1) {
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, m0.tex);
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, m1.tex);
        gl.uniform2f(this.u.uLit0Org!, m0.x, m0.y);
        gl.uniform2f(this.u.uLit1Org!, m1.x, m1.y);
      }
    }
    gl.uniform1i(this.u.uNoAlpha!, noAlpha ? 1 : 0);
    setup();
    // Pass 0: opaque pixels with depth write; pass 1: alpha pixels blended
    // (with noAlpha, the alpha pixels are drawn in pass 0).
    if (tex.hasOpaque || (noAlpha && tex.hasAlpha)) {
      gl.uniform1i(this.u.uPass!, 0);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    if (tex.hasAlpha && !noAlpha) {
      // The Windows decoders write the depth of a blended pixel too.
      gl.uniform1i(this.u.uPass!, 1);
      gl.enable(gl.BLEND);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
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
    }, this.spr2NoAlpha);
  }

  /**
   * DrawShadow(x, y, shadow, offset, w, h, rows, base) (101bc600): darkens
   * the target under a floor shadow (an 8-bit surface, see floorshadow.ts)
   * where the floor depth base + rowTable[row] is not behind the z-buffer.
   * `rows` is the table1D index of the entry for the shadow's first row.
   */
  drawShadow(shadow: { data: Uint8Array; pitch: number }, w: number, h: number, x: number, y: number, offset: number, base: number, rows: number): void {
    const gl = this.gl;
    if (w <= 0 || h <= 0 || x >= this.width || y >= this.height || x + w <= 0 || y + h <= 0) return;
    this.uploadTable();
    this.shadowProg ??= this.link(VS, SHADOW_FS);
    const p = this.shadowProg;
    let tex = this.shadowTex.get(shadow);
    if (!tex) {
      tex = this.texture();
      const bytes = new Uint8Array(w * h);
      for (let r = 0; r < h; r++) bytes.set(shadow.data.subarray(r * shadow.pitch, r * shadow.pitch + w), r * w);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, bytes);
      this.shadowTex.set(shadow, tex);
    }
    // The target under the rectangle, read by the fragment shader.
    this.shadowDst ??= this.texture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.shadowDst);
    if (this.shadowDstSize[0] !== w || this.shadowDstSize[1] !== h) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      this.shadowDstSize = [w, h];
    }
    const by = this.height - y - h;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target);
    const sx = Math.max(0, x);
    const sy = Math.max(0, by);
    const cw = Math.min(this.width, x + w) - sx;
    const ch = Math.min(this.height, by + h) - sy;
    if (cw <= 0 || ch <= 0) return;
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, sx - x, sy - by, sx, sy, cw, ch);
    gl.useProgram(p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.tableTex);
    const loc = (n: string): WebGLUniformLocation | null => gl.getUniformLocation(p, n);
    gl.uniform1i(loc("uShadow"), 0);
    gl.uniform1i(loc("uDst"), 1);
    gl.uniform1i(loc("uTable"), 2);
    gl.uniform2f(loc("uView"), this.width, this.height);
    gl.uniform1i(loc("uFlip"), 0);
    gl.uniform4f(loc("uRect"), x, y, w, h);
    gl.uniform2i(loc("uAt"), x, by);
    gl.uniform1f(loc("uViewH"), this.height);
    gl.uniform1f(loc("uOffset"), offset);
    gl.uniform1f(loc("uBase"), base);
    gl.uniform1i(loc("uRowOffset"), rows);
    gl.bindVertexArray(this.quad);
    gl.disable(gl.BLEND);
    gl.depthMask(false);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.depthMask(true);
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
      const ci = this.wallColIdx;
      const zo = this.wallZoneOff;
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

  /**
   * Not part of the original (perf): the target's colors in a rectangle, top
   * row first, opaque, ready for putImageData (reads w x h pixels instead of
   * copying the whole canvas).
   */
  readColor(x: number, y: number, w: number, h: number): ImageData {
    const gl = this.gl;
    const raw = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target);
    gl.readPixels(x, this.height - y - h, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    const out = new ImageData(w, h);
    const d = out.data;
    for (let r = 0; r < h; r++) d.set(raw.subarray((h - 1 - r) * w * 4, (h - r) * w * 4), r * w * 4);
    for (let i = 3; i < d.length; i += 4) d[i] = 255;
    return out;
  }

  /**
   * Not part of the original (perf): the raw layer's GPU state, swapped by a
   * second view drawn into this compositor (the picture in picture), so each
   * keeps its own uploaded terrain. `s` null starts an empty one. Returns the
   * state taken out.
   */
  swapRawState(s: RawLayerState | null): RawLayerState {
    const out: RawLayerState = { raw: this.raw, rawCur: this.rawCur, rawValid: this.rawValid, rawW: this.rawW, rawH: this.rawH };
    this.raw = s?.raw ?? [];
    this.rawCur = s?.rawCur ?? 0;
    this.rawValid = s?.rawValid ?? false;
    this.rawW = s?.rawW ?? 0;
    this.rawH = s?.rawH ?? 0;
    return out;
  }

  /** The raw layer textures at the target's size (allocated, contents undefined). */
  private ensureRaw(): void {
    const gl = this.gl;
    const w = this.width;
    const h = this.height;
    if (this.raw.length && this.rawW === w && this.rawH === h) return;
    for (const r of this.raw) {
      for (const t of r.tex) gl.deleteTexture(t);
      for (const f of r.fb) gl.deleteFramebuffer(f);
    }
    this.raw = [];
    for (let i = 0; i < 2; i++) {
      const tex: WebGLTexture[] = [];
      const fb: WebGLFramebuffer[] = [];
      for (const [fmt, ifmt] of [[gl.RGBA, gl.RGBA8], [gl.RGBA, gl.RGBA8], [gl.RG, gl.RG8]] as const) {
        const t = this.texture();
        gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, gl.UNSIGNED_BYTE, null);
        const f = gl.createFramebuffer()!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, f);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
        tex.push(t);
        fb.push(f);
      }
      this.raw.push({ tex, fb });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target);
    this.rawW = w;
    this.rawH = h;
    this.rawCur = 0;
    this.rawValid = false;
  }

  /**
   * Uploads the rectangle (x, y, w, h) of the raw layer: `even` / `odd` the
   * colors for an even / odd view origin row (RGBA8 packed), `depth` the
   * 16-bit depth, `w` x `h` pixels each.
   */
  uploadRaw(x: number, y: number, w: number, h: number, even: Uint32Array, odd: Uint32Array, depth: Uint16Array): void {
    const gl = this.gl;
    this.ensureRaw();
    const r = this.raw[this.rawCur]!;
    const n = w * h;
    gl.bindTexture(gl.TEXTURE_2D, r.tex[0]!);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(even.buffer, even.byteOffset, n * 4));
    gl.bindTexture(gl.TEXTURE_2D, r.tex[1]!);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(odd.buffer, odd.byteOffset, n * 4));
    // RG8 big-endian depth: one u16 store per pixel (the platform is little-endian).
    if (!this.rawZBytes || this.rawZBytes.length < n) this.rawZBytes = new Uint16Array(this.width * this.height);
    const zm = this.rawZBytes;
    for (let i = 0; i < n; i++) {
      const d = depth[i]!;
      zm[i] = (d >> 8) | ((d & 0xff) << 8);
    }
    gl.bindTexture(gl.TEXTURE_2D, r.tex[2]!);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RG, gl.UNSIGNED_BYTE, new Uint8Array(zm.buffer, 0, n * 2));
    if (x === 0 && y === 0 && w === this.width && h === this.height) this.rawValid = true;
  }

  /**
   * Not part of the original (perf): moves the raw layer's contents by
   * (dx, dy) pixels on the GPU (the view scrolled); the uncovered strips are
   * left for uploadRaw. False when there is no layer to move.
   */
  shiftRaw(dx: number, dy: number): boolean {
    if (!this.rawValid || this.rawW !== this.width || this.rawH !== this.height) return false;
    const gl = this.gl;
    const w = this.width;
    const h = this.height;
    const src = this.raw[this.rawCur]!;
    const dst = this.raw[1 - this.rawCur]!;
    const sx0 = Math.max(0, -dx);
    const sy0 = Math.max(0, -dy);
    const sx1 = Math.min(w, w - dx);
    const sy1 = Math.min(h, h - dy);
    gl.disable(gl.SCISSOR_TEST);
    if (sx1 > sx0 && sy1 > sy0) {
      for (let i = 0; i < src.fb.length; i++) {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src.fb[i]!);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.fb[i]!);
        gl.blitFramebuffer(sx0, sy0, sx1, sy1, sx0 + dx, sy0 + dy, sx1 + dx, sy1 + dy, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target);
    this.applyScissor();
    this.rawCur = 1 - this.rawCur;
    return true;
  }

  /**
   * Full-target layer with its own 16-bit depth (terrain swatch output):
   * `even` / `odd` as for uploadRaw, drawn for a view origin row of parity
   * `oddRow`. `changed` false redraws the layer as it is (uploaded or
   * shifted before).
   */
  drawRaw(even: Uint32Array, odd: Uint32Array, depth: Uint16Array, oddRow: boolean, changed = true): void {
    if (changed || !this.rawValid) this.uploadRaw(0, 0, this.width, this.height, even, odd, depth);
    const gl = this.gl;
    const r = this.raw[this.rawCur]!;
    const tex: SpriteTex = { width: this.width, height: this.height, color: r.tex[oddRow ? 1 : 0]!, zmode: r.tex[2]!, hasOpaque: true, hasAlpha: false };
    this.draw(tex, 0, 0, false, () => {
      gl.uniform1i(this.u.uMode!, 2);
    });
  }
}
