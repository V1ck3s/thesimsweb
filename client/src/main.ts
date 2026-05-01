import { createRenderer } from "./renderer/webgl.js";
import { drawHelloSims } from "./renderer/hello.js";
import { engine } from "./engine/wasm.js";
import { fetchManifest, readIffFromFar, readStandaloneIff } from "./engine/assets.js";

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
  const fakeIff = buildSyntheticIff();
  const manifest = wasm.parseFarManifest(fakeFar) as Array<{
    filename: string;
    sizeDecompressed: number;
    sizeCompressed: number;
    offset: number;
  }>;
  const payload = wasm.extractFarEntry(fakeFar, 0);
  const chunks = wasm.parseIffChunks(fakeIff) as Array<{
    kind: string;
    size: number;
    id: number;
    flags: number;
    dataStart: number;
    dataLen: number;
  }>;
  const { palt, spr2 } = buildSyntheticSpr2();
  const sprite = wasm.decodeSpr2Frame(spr2, palt, 0) as {
    width: number;
    height: number;
    rgba: Uint8Array;
  };
  console.info(
    `[engine] v${wasm.engine_version()} · far ${manifest.length} entries (${manifest[0]?.filename}, ${payload.length}B) · iff v${wasm.parseIffHeader(fakeIff)}, ${chunks.length} chunks (${chunks.map((c) => c.kind).join(",")}) · spr2 ${sprite.width}x${sprite.height} (${sprite.rgba.length}B RGBA)`,
  );
  void runRealAssetSmokeTest(wasm);
});

const HUD = document.getElementById("hud");
const SPRITE_CANVAS = document.getElementById("sprite-overlay") as HTMLCanvasElement | null;

function setHud(text: string): void {
  if (HUD) HUD.textContent = text;
}

async function runRealAssetSmokeTest(wasm: Awaited<ReturnType<typeof engine>>): Promise<void> {
  try {
    const manifest = await fetchManifest();
    const fars = manifest.files.filter((f) => f.kind === "far").length;
    const iffs = manifest.files.filter((f) => f.kind === "iff").length;
    setHud(`manifest: ${manifest.files.length} files · ${fars} FAR · ${iffs} IFF`);

    const floor = manifest.files.find((f) =>
      f.path.toLowerCase().endsWith("floors/floorjapanesetile.flr"),
    );
    if (!floor) {
      setHud(`manifest OK (${manifest.files.length} files) — no FloorJapaneseTile in install`);
      return;
    }

    const { data, chunks } = await readStandaloneIff(floor.path);
    const palt = chunks.find((c) => c.kind === "PALT" && c.id === 1);
    const spr2 = chunks.find((c) => c.kind === "SPR2");
    if (!palt || !spr2) {
      setHud(`${floor.path}: missing PALT(1) or SPR2`);
      return;
    }
    const paltData = data.subarray(palt.dataStart, palt.dataStart + palt.dataLen);
    const spr2Data = data.subarray(spr2.dataStart, spr2.dataStart + spr2.dataLen);
    const decoded = wasm.decodeSpr2Frame(spr2Data, paltData, 0) as {
      width: number;
      height: number;
      rgba: Uint8Array;
    };
    drawSpriteToOverlay(decoded);
    const catalogLine = await tryDecodeAlarmClock(wasm, manifest);
    const viewerLine = await tryRenderAlarmClockObject(wasm, manifest);
    setHud(
      `${floor.path} · ${chunks.length} chunks · sprite ${decoded.width}×${decoded.height} (${decoded.rgba.length}B RGBA)` +
        (catalogLine ? ` · ${catalogLine}` : "") +
        (viewerLine ? ` · ${viewerLine}` : ""),
    );
  } catch (err) {
    setHud(`real-asset smoke test failed: ${(err as Error).message}`);
    console.error(err);
  }
}

interface AlarmClockSummary {
  price: number;
  ttabId: number;
  type: number;
  guid: number;
  interactions: number;
  pieMenuLabels: number;
}

async function tryDecodeAlarmClock(
  wasm: Awaited<ReturnType<typeof engine>>,
  manifest: Awaited<ReturnType<typeof fetchManifest>>,
): Promise<string | null> {
  const objectsFar = manifest.files.find((f) =>
    f.path.toLowerCase().endsWith("objects/objects.far"),
  );
  if (!objectsFar) return null;
  try {
    const { data, chunks } = await readIffFromFar(objectsFar.path, "AlarmClock.iff");
    const objdChunk = chunks.find((c) => c.kind === "OBJD");
    const ttabChunk = chunks.find((c) => c.kind === "TTAB");
    const ttasChunk = chunks.find((c) => c.kind === "TTAs");
    if (!objdChunk || !ttabChunk || !ttasChunk) return null;
    const objd = wasm.parseObjd(
      data.subarray(objdChunk.dataStart, objdChunk.dataStart + objdChunk.dataLen),
    ) as { version: number; fields: number[]; guid: number };
    const ttab = wasm.parseTtab(
      data.subarray(ttabChunk.dataStart, ttabChunk.dataStart + ttabChunk.dataLen),
    ) as { version: number; interactions: unknown[] };
    const ttas = wasm.parseStrTable(
      data.subarray(ttasChunk.dataStart, ttasChunk.dataStart + ttasChunk.dataLen),
    ) as { version: number; entries: unknown[] };
    const summary: AlarmClockSummary = {
      price: objd.fields[16] ?? -1,
      ttabId: objd.fields[5] ?? -1,
      type: objd.fields[7] ?? -1,
      guid: objd.guid,
      interactions: ttab.interactions.length,
      pieMenuLabels: ttas.entries.length,
    };
    return `AlarmClock OBJDv${objd.version} guid=0x${summary.guid.toString(16)} price=${summary.price}§ TTABv${ttab.version}/${summary.interactions} interactions · TTAsv${ttas.version}/${summary.pieMenuLabels} labels`;
  } catch (err) {
    console.warn("[catalog] AlarmClock decode failed:", err);
    return null;
  }
}

interface DgrpSprite {
  sprChunkId: number;
  sprFrameNumber: number;
  spriteXOffset: number;
  spriteYOffset: number;
  objectZOffset: number;
  flags: number;
  objectXOffset: number;
  objectYOffset: number;
}

interface DgrpImage {
  directionFlags: number;
  zoomLevel: number;
  sprites: DgrpSprite[];
}

interface DecodedSprite {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/**
 * Compose AlarmClock's `BASE_GRAPHIC_ID` DGRP into the object viewer canvas.
 *
 * Uses the south-facing image (direction 0x10) at maximum zoom (3). Composites
 * each sprite at `(spriteXOffset, spriteYOffset)` relative to the canvas centre.
 * Returns a one-line summary for the HUD.
 */
async function tryRenderAlarmClockObject(
  wasm: Awaited<ReturnType<typeof engine>>,
  manifest: Awaited<ReturnType<typeof fetchManifest>>,
): Promise<string | null> {
  const objectsFar = manifest.files.find((f) =>
    f.path.toLowerCase().endsWith("objects/objects.far"),
  );
  if (!objectsFar) return null;
  try {
    const { data, chunks } = await readIffFromFar(objectsFar.path, "AlarmClock.iff");
    const objdChunk = chunks.find((c) => c.kind === "OBJD");
    if (!objdChunk) return null;
    const objd = wasm.parseObjd(
      data.subarray(objdChunk.dataStart, objdChunk.dataStart + objdChunk.dataLen),
    ) as { fields: number[] };
    const baseGraphicId = objd.fields[1] ?? 0;
    const dgrpChunk = chunks.find((c) => c.kind === "DGRP" && c.id === baseGraphicId);
    if (!dgrpChunk) return `no DGRP id=${baseGraphicId}`;

    const dgrp = wasm.parseDgrp(
      data.subarray(dgrpChunk.dataStart, dgrpChunk.dataStart + dgrpChunk.dataLen),
    ) as { version: number; images: DgrpImage[] };
    // Pick south-facing maximum zoom — the most face-on view.
    const image =
      dgrp.images.find((i) => i.directionFlags === 0x10 && i.zoomLevel === 3) ??
      dgrp.images[0];
    if (!image) return "DGRP empty";

    // Decode each sprite frame.
    const decoded: Array<{ sp: DgrpSprite; bmp: DecodedSprite }> = [];
    for (const sp of image.sprites) {
      const spr2Chunk = chunks.find((c) => c.kind === "SPR2" && c.id === sp.sprChunkId);
      if (!spr2Chunk) continue;
      const paltChunk = chunks.find((c) => c.kind === "PALT" && c.id === 0);
      if (!paltChunk) continue;
      try {
        const bmp = wasm.decodeSpr2Frame(
          data.subarray(spr2Chunk.dataStart, spr2Chunk.dataStart + spr2Chunk.dataLen),
          data.subarray(paltChunk.dataStart, paltChunk.dataStart + paltChunk.dataLen),
          sp.sprFrameNumber,
        ) as DecodedSprite;
        decoded.push({ sp, bmp });
      } catch (err) {
        console.warn(`[viewer] SPR2 ${sp.sprChunkId}#${sp.sprFrameNumber} decode failed:`, err);
      }
    }
    if (decoded.length === 0) return "no decodable sprites";

    composeObjectViewer(decoded);
    setObjectLabel(
      `AlarmClock · DGRP ${baseGraphicId} · dir=0x10 zoom=3 · ${decoded.length}/${image.sprites.length} sprites`,
    );
    return `viewer ${decoded.length} sprite(s)`;
  } catch (err) {
    console.warn("[viewer] AlarmClock render failed:", err);
    return `viewer err: ${(err as Error).message}`;
  }
}

const OBJECT_VIEWER_CANVAS = document.getElementById("object-viewer") as HTMLCanvasElement | null;
const OBJECT_LABEL = document.getElementById("object-label");

function setObjectLabel(text: string): void {
  if (OBJECT_LABEL) OBJECT_LABEL.textContent = text;
}

/** Composite decoded sprites onto the viewer canvas with their DGRP offsets. */
function composeObjectViewer(decoded: Array<{ sp: DgrpSprite; bmp: DecodedSprite }>): void {
  if (!OBJECT_VIEWER_CANVAS) return;
  const ctx = OBJECT_VIEWER_CANVAS.getContext("2d");
  if (!ctx) return;

  // Compute the bounding box of every sprite once positioned at its offset.
  // SPR2 offsets reference the centre of the compiled image; the viewer canvas
  // uses (W/2, H/2) as that centre. We size the canvas to fit, then clear.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { sp, bmp } of decoded) {
    const x0 = sp.spriteXOffset;
    const y0 = sp.spriteYOffset;
    if (x0 < minX) minX = x0;
    if (y0 < minY) minY = y0;
    if (x0 + bmp.width > maxX) maxX = x0 + bmp.width;
    if (y0 + bmp.height > maxY) maxY = y0 + bmp.height;
  }
  if (!Number.isFinite(minX)) return;

  const w = Math.max(64, Math.ceil(maxX - minX));
  const h = Math.max(64, Math.ceil(maxY - minY));
  OBJECT_VIEWER_CANVAS.width = w;
  OBJECT_VIEWER_CANVAS.height = h;
  ctx.clearRect(0, 0, w, h);
  // Z-order: paint by DGRP order (later sprites on top — matches the original engine).
  for (const { sp, bmp } of decoded) {
    const img = ctx.createImageData(bmp.width, bmp.height);
    img.data.set(bmp.rgba);
    const dx = sp.spriteXOffset - minX;
    const dy = sp.spriteYOffset - minY;
    ctx.putImageData(img, dx, dy);
  }
}

function drawSpriteToOverlay(decoded: { width: number; height: number; rgba: Uint8Array }): void {
  if (!SPRITE_CANVAS) return;
  SPRITE_CANVAS.width = decoded.width;
  SPRITE_CANVAS.height = decoded.height;
  const ctx = SPRITE_CANVAS.getContext("2d");
  if (!ctx) return;
  const img = ctx.createImageData(decoded.width, decoded.height);
  img.data.set(decoded.rgba);
  ctx.putImageData(img, 0, 0);
}

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

/**
 * Synthetic PALT (6 colors, index 5 = green) + SPR2 v1000 (1×1 frame, color-only,
 * single pixel using palette index 5). Mirrors the Rust integration test fixture.
 */
function buildSyntheticSpr2(): { palt: Uint8Array; spr2: Uint8Array } {
  const palt = new Uint8Array(16 + 3 * 6);
  const paltView = new DataView(palt.buffer);
  paltView.setUint32(0, 1, true); // version
  paltView.setUint32(4, 6, true); // count
  palt.set([0x00, 0xff, 0x00], 16 + 5 * 3); // index 5 = green

  const spr2 = new Uint8Array(12 + 4 + 16 + 2 + 2 + 2 + 2);
  const v = new DataView(spr2.buffer);
  v.setUint32(0, 1000, true); // SPR2 v1000
  v.setUint32(4, 1, true); // sprite_count = 1
  v.setUint32(8, 1, true); // default_palette = 1
  v.setUint32(12, 16, true); // offset_table[0] = 16 (relative to start of SPR2 data)
  // Frame at offset 16
  v.setUint16(16, 1, true); // width
  v.setUint16(18, 1, true); // height
  v.setUint32(20, 0x01, true); // flags = color only
  v.setUint16(24, 0xa3a3, true); // palette = use default
  v.setUint16(26, 0, true); // transparent_color = 0 (palette[0] = (0,0,0))
  v.setInt16(28, 0, true); // y_loc
  v.setInt16(30, 0, true); // x_loc
  // RLE: row cmd 0 (fill), block size = 6
  v.setUint16(32, 6, true);
  // Pixel cmd 6 (color only), count=1
  v.setUint16(34, (6 << 13) | 1, true);
  spr2.set([0x05, 0x00], 36); // color idx 5 + pad
  // End marker (cmd=5)
  v.setUint16(38, 5 << 13, true);
  return { palt, spr2 };
}

/** Synthetic IFF v2.5 with one BHAV chunk (size 80, 4 bytes of payload). */
function buildSyntheticIff(): Uint8Array {
  const headerLen = 64;
  const chunkHeaderLen = 76;
  const chunkSize = 80;
  const buf = new Uint8Array(headerLen + chunkSize);
  const view = new DataView(buf.buffer);
  buf.set(new TextEncoder().encode("IFF FILE 2.5:TYPE FOLLOWED BY SIZE\0 JAMIE DOORNBOS & MAXIS 1"), 0);
  view.setUint32(60, 0, false); // rsmp_offset = 0 (BE)
  buf.set(new TextEncoder().encode("BHAV"), headerLen); // chunk type
  view.setUint32(headerLen + 4, chunkSize, false); // size BE
  view.setUint16(headerLen + 8, 1, false); // id BE
  view.setUint16(headerLen + 10, 0x0010, false); // flags BE
  buf.set([0xde, 0xad, 0xbe, 0xef], headerLen + chunkHeaderLen); // payload
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
