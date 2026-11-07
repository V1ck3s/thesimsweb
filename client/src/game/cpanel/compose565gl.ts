/**
 * compose565 (cpanel/viewcontrol.ts: AlphaBlend_565_565_P5 through
 * InitAlphaZSpriteBlit's table) run on the GPU, with the same integer
 * arithmetic and the same table, so the pixels are identical.
 *
 * Why: the CPU version reads the screen canvas back under the view control
 * gadget every frame (getImageData), which on a GPU-backed canvas waits for
 * the GPU to finish the frame: 70 % of the main thread in a headed Chrome
 * profile, and it grows with the screen size. Here the parent's rectangle is
 * copied canvas to canvas (GPU to GPU where the browser can), blended by a
 * fragment shader looking the table up, and drawn back: nothing is read back
 * to the CPU. Falls back (returns false) where WebGL 2 is missing.
 */

const VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// texelFetch of RGBA8 gives v / 255 exactly; round back to the byte. Output
// bytes are written as b / 255, which an RGBA8 target stores exactly.
const FS = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform sampler2D uDst;
uniform sampler2D uSrc;
uniform usampler2D uAlpha;
uniform usampler2D uTable;
uniform ivec2 uSize;
uniform ivec2 uAlphaOrigin;
uniform ivec2 uSrcOrigin;
out vec4 outColor;
uvec3 bytes(vec4 c) { return uvec3(floor(c.rgb * 255.0 + 0.5)); }
uint blend(uint base, uint s, uint d) {
  return texelFetch(uTable, ivec2(int(((s >> 3u) << 5u) | (d >> 3u)), int(base)), 0).r << 3u;
}
void main() {
  ivec2 p = ivec2(int(gl_FragCoord.x), uSize.y - 1 - int(gl_FragCoord.y));
  uvec3 d = bytes(texelFetch(uDst, p, 0));
  uint a = texelFetch(uAlpha, p + uAlphaOrigin, 0).r;
  uvec3 o = d;
  if (a > 0xf7u) {
    o = bytes(texelFetch(uSrc, p + uSrcOrigin, 0));
  } else if (a >= 8u) {
    uvec3 s = bytes(texelFetch(uSrc, p + uSrcOrigin, 0));
    uint level = a >> 3u;
    o = uvec3(blend(level, s.r, d.r), blend(level, s.g, d.g), blend(level, s.b, d.b));
  }
  outColor = vec4(vec3(o) / 255.0, 1.0);
}`;

interface GlState {
  canvas: OffscreenCanvas;
  gl: WebGL2RenderingContext;
  dstTex: WebGLTexture;
  srcTex: WebGLTexture;
  alphaTex: WebGLTexture;
  u: Record<"size" | "alphaOrigin" | "srcOrigin", WebGLUniformLocation | null>;
  /** The parent's rectangle, copied canvas to canvas before the upload. */
  grab: OffscreenCanvasRenderingContext2D;
  alpha: Uint8Array | null;
}

export class Compose565GL {
  private st: GlState | null = null;
  private failed = false;

  /** `table`: the 32 x 32 x 32 blend table ([level][src][dst], 5-bit entries). */
  constructor(private readonly table: () => Uint8Array) {}

  private init(): GlState | null {
    if (this.st || this.failed) return this.st;
    this.failed = true;
    if (typeof OffscreenCanvas === "undefined") return null;
    const canvas = new OffscreenCanvas(1, 1);
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    const grab = new OffscreenCanvas(1, 1).getContext("2d", { alpha: false });
    if (!gl || !grab) return null;
    const shader = (type: number, src: string): WebGLShader | null => {
      const s = gl.createShader(type);
      if (!s) return null;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    };
    const vs = shader(gl.VERTEX_SHADER, VS);
    const fs = shader(gl.FRAGMENT_SHADER, FS);
    const prog = gl.createProgram();
    if (!vs || !fs || !prog) return null;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);
    gl.bindVertexArray(gl.createVertexArray());
    const tex = (unit: number, name: string): WebGLTexture => {
      const t = gl.createTexture()!;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(gl.getUniformLocation(prog, name), unit);
      return t;
    };
    const dstTex = tex(0, "uDst");
    const srcTex = tex(1, "uSrc");
    const alphaTex = tex(2, "uAlpha");
    tex(3, "uTable");
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, 1024, 32, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, this.table());
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    this.failed = false;
    this.st = {
      canvas,
      gl,
      dstTex,
      srcTex,
      alphaTex,
      u: {
        size: gl.getUniformLocation(prog, "uSize"),
        alphaOrigin: gl.getUniformLocation(prog, "uAlphaOrigin"),
        srcOrigin: gl.getUniformLocation(prog, "uSrcOrigin"),
      },
      grab,
      alpha: null,
    };
    return this.st;
  }

  /**
   * Blends `src` (read from (sx, sy)) over `ctx`'s (left, top, w, h) through
   * `alpha` (`aw` wide, read from (sx, sy) too) and draws the result there.
   * False when WebGL 2 is not available (the caller blends on the CPU).
   */
  compose(ctx: CanvasRenderingContext2D, src: OffscreenCanvas, left: number, top: number, w: number, h: number, alpha: Uint8Array, aw: number, sx: number, sy: number): boolean {
    const st = this.init();
    if (!st) return false;
    const { gl, canvas, grab } = st;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
    if (grab.canvas.width !== w || grab.canvas.height !== h) {
      grab.canvas.width = w;
      grab.canvas.height = h;
    }
    grab.drawImage(ctx.canvas, left, top, w, h, 0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, st.dstTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, grab.canvas);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, st.srcTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
    if (st.alpha !== alpha) {
      st.alpha = alpha;
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, st.alphaTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, aw, Math.trunc(alpha.length / aw), 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, alpha);
    }
    gl.uniform2i(st.u.size, w, h);
    gl.uniform2i(st.u.alphaOrigin, sx, sy);
    gl.uniform2i(st.u.srcOrigin, sx, sy);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    ctx.drawImage(canvas, 0, 0, w, h, left, top, w, h);
    return true;
  }
}
