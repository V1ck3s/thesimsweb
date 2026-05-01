import { linkProgram, type Renderer } from "./webgl.js";

const VS = `#version 300 es
in vec2 a_pos;
in vec3 a_color;
out vec3 v_color;
void main() {
  v_color = a_color;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FS = `#version 300 es
precision highp float;
in vec3 v_color;
out vec4 frag_color;
void main() {
  frag_color = vec4(v_color, 1.0);
}
`;

// Phase 0 placeholder: render a gradient triangle so we can confirm the
// WebGL pipeline is alive. The next phase will replace this with the
// isometric sprite renderer.
export function drawHelloSims(renderer: Renderer): void {
  const { gl } = renderer;
  const program = linkProgram(gl, VS, FS);
  gl.useProgram(program);

  const positions = new Float32Array([
    -0.6, -0.5, // bottom-left
    0.6, -0.5, // bottom-right
    0.0, 0.6, // top
  ]);
  const colors = new Float32Array([
    0.18, 0.42, 0.87, // blue
    0.4, 0.78, 0.4, // green
    0.93, 0.78, 0.18, // gold
  ]);

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  const posBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
  const posLoc = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

  const colorBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, colorBuf);
  gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);
  const colorLoc = gl.getAttribLocation(program, "a_color");
  gl.enableVertexAttribArray(colorLoc);
  gl.vertexAttribPointer(colorLoc, 3, gl.FLOAT, false, 0, 0);

  gl.clearColor(0.05, 0.05, 0.07, 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
