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

// Smoke-test the WASM bridge: load the engine, log version, run the parsers
// against a synthetic FAR + IFF. If any of this throws the page surfaces it.
void engine().then((wasm) => {
  const fakeFar = buildSyntheticFar();
  const fakeIff = new Uint8Array(64);
  fakeIff.set(new TextEncoder().encode("IFF FILE 2.5:TY"), 0);
  const manifest = wasm.parseFarManifest(fakeFar) as Array<{
    filename: string;
    sizeDecompressed: number;
    sizeCompressed: number;
    offset: number;
  }>;
  const payload = wasm.extractFarEntry(fakeFar, 0);
  console.info(
    `[engine] v${wasm.engine_version()} · checkFarMagic=${wasm.checkFarMagic(fakeFar)} · iffVersion=${wasm.parseIffHeader(fakeIff)} · entries=${manifest.length} (${manifest[0]?.filename}, ${payload.length}B)`,
  );
});

/** Synthetic FAR v1 with one entry "hi.txt" → "HELLO!". Mirrors the unit-test fixture. */
function buildSyntheticFar(): Uint8Array {
  const buf = new Uint8Array(16 + 6 + 4 + 16 + 6);
  const view = new DataView(buf.buffer);
  buf.set(new TextEncoder().encode("FAR!byAZ"), 0);
  view.setUint32(8, 1, true);
  view.setUint32(12, 22, true); // manifest after 16B header + 6B payload
  buf.set(new TextEncoder().encode("HELLO!"), 16);
  view.setUint32(22, 1, true); // entry_count
  view.setUint32(26, 6, true); // size_decompressed
  view.setUint32(30, 6, true); // size_compressed
  view.setUint32(34, 16, true); // offset
  view.setUint32(38, 6, true); // filename_length
  buf.set(new TextEncoder().encode("hi.txt"), 42);
  return buf;
}

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
