import { createRenderer } from "./renderer/webgl.js";
import { drawHelloSims } from "./renderer/hello.js";
import { engine } from "./engine/wasm.js";

function findCanvas(): HTMLCanvasElement {
  const el = document.getElementById("game");
  if (!(el instanceof HTMLCanvasElement)) {
    throw new Error("canvas#game not found");
  }
  return el;
}

const canvas = findCanvas();
const renderer = createRenderer(canvas);
drawHelloSims(renderer);

// Smoke-test the WASM bridge: load the engine, log version, run two parsers
// against synthetic buffers. If any of this throws the page surfaces it.
void engine().then((wasm) => {
  const fakeFar = new Uint8Array([0x46, 0x41, 0x52, 0x21, 0x62, 0x79, 0x41, 0x5a]); // "FAR!byAZ"
  const fakeIff = new Uint8Array(64);
  fakeIff.set(new TextEncoder().encode("IFF FILE 2.5:TY"), 0);
  console.info(
    `[engine] v${wasm.engine_version()} · checkFarMagic=${wasm.checkFarMagic(fakeFar)} · iffVersion=${wasm.parseIffHeader(fakeIff)}`,
  );
});

// Keep the canvas crisp at any DPR. The CSS already constrains layout.
function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.floor(canvas.clientWidth * dpr);
  const h = Math.floor(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    renderer.gl.viewport(0, 0, w, h);
    drawHelloSims(renderer);
  }
}

window.addEventListener("resize", resize);
queueMicrotask(resize);
