/**
 * cTSCursorManager: the game's cursors, by id, as CSS cursor values.
 *
 * cSimsApp::SetupWinCtrlMgr (Sims.exe 0x4efb69 area, Mac SetupWinCtrlMgr)
 * registers them from <data>/UIGraphics/shared/cursors/ (Sims.exe
 * 0x6ca530): RemoveCursor + AddCursor for ids 0 arrow, 3 hourglass, 2 edit,
 * then 4 finger and the tool cursors 6.. in the order of the table below.
 * cTSCursor::LoadCursorA is LoadCursorFromFileA, so every cursor is a 32 x 32
 * monochrome .cur file with its own hotspot (MOVEIN.cur is an icon file: its
 * hotspot fields read 0, 0). There are no cursor resources in Sims.exe and
 * no animated cursors.
 *
 * GetCursor (0x5e74ca) and GetStandardCursor (0x5e749a) look up the same
 * map: standard cursor 4 is finger.cur, not a system cursor.
 *
 * loadCursors() decodes the files once (the browser would drop the XOR
 * pixels of edit.cur and may ignore the hotspots) into PNG data URLs with
 * explicit hotspots; before that, getCursor() answers with the .cur file.
 */

const CURSOR_DIR = "/assets/Sims/UIGraphics/Shared/cursors/";

/** cSimsApp::SetupWinCtrlMgr: AddCursor(file, id). */
const CURSOR_FILES: Record<number, string> = {
  0: "Arrow.cur",
  3: "HOURGLASS.cur",
  2: "edit.cur",
  4: "finger.cur",
  6: "SimsDelete.cur",
  7: "SimsLevel.cur",
  8: "SimsLower.cur",
  10: "SimsMove.cur",
  0xb: "SimsPlace.cur",
  9: "SimsRaise.cur",
  0xc: "SimsRotate.cur",
  0xd: "SimsRotateNW.cur",
  0xe: "SimsRotateNE.cur",
  0xf: "SimsRotateSW.cur",
  0x10: "SimsRotateSE.cur",
  0x11: "LEFT.cur",
  0x12: "RIGHT.cur",
  0x13: "UP.cur",
  0x14: "DOWN.cur",
  0x15: "UPRIGHT.cur",
  0x16: "UPLEFT.cur",
  0x17: "DOWNRIGHT.cur",
  0x18: "DOWNLEFT.cur",
  0x19: "EXPLORE.cur",
  0x1a: "DEADEXPL.cur",
  0x1b: "Pan.cur",
  0x1d: "LivePerson.cur",
  0x1c: "LiveNothing.cur",
  0x2a: "LivePet.cur",
  0x2b: "LiveNothingPet.cur",
  0x1e: "LiveObjectAvail.cur",
  0x1f: "LiveObjectUnavail.cur",
  0x20: "ADDPTS.cur",
  0x21: "MOVEIN.cur",
  0x22: "BULLDOZE.cur",
  0x23: "SimsFlip.cur",
  0x24: "RemovePts.cur",
  0x25: "taxi.cur",
  0x26: "water.cur",
  0x27: "van.cur",
  0x28: "Rezone2.cur",
  0x29: "trolleybus.cur",
  0x2c: "limo.cur",
  0x2d: "tram.cur",
  0x2e: "hole.cur",
  0x2f: "balloon.cur",
};

/** Named ids (cTSCursor::StandardCursor and the ToolCursor values the code uses). */
export const enum CursorId {
  Arrow = 0,
  Edit = 2,
  Hourglass = 3,
  Finger = 4,
  /** cDDDSimsView::SetToolCursor: keep the current cursor. */
  Keep = 5,
}

/** cTSWin::HideCursor (flag 0x800): no cursor at all. */
export const HIDDEN_CURSOR = "none";

/** Decoded cursors (loadCursors), by id. */
const decoded = new Map<number, string>();

function fallback(id: number): string {
  return id === 3 ? "wait" : "default";
}

/** cTSCursorManager::GetCursor(id), or null when the id is not registered. */
export function getCursor(id: number): string | null {
  const d = decoded.get(id);
  if (d) return d;
  const f = CURSOR_FILES[id];
  return f ? `url("${CURSOR_DIR}${f}"), ${fallback(id)}` : null;
}

/** cTSCursorManager::GetStandardCursor: the same map as GetCursor. */
export function getStandardCursor(which: number): string | null {
  return getCursor(which);
}

/**
 * The game's cursor files, decoded to PNG data URLs with their hotspots
 * (LoadCursorFromFileA: the directory entry's hotspot, the first image).
 * Pixels the AND mask keeps with a set XOR bit invert the screen in
 * Windows (the edit cursor's I-beam); a browser cannot invert, so they are
 * drawn black with a white outline.
 */
export async function loadCursors(): Promise<void> {
  await Promise.all(
    Object.entries(CURSOR_FILES).map(async ([key, file]) => {
      const id = Number(key);
      try {
        const res = await fetch(CURSOR_DIR + file);
        if (!res.ok) return;
        const url = decodeCursor(new Uint8Array(await res.arrayBuffer()));
        if (url) decoded.set(id, `url("${url.png}") ${url.x} ${url.y}, ${fallback(id)}`);
      } catch {
        // Keep the .cur fallback.
      }
    }),
  );
}

/** One .cur / .ico image: a PNG data URL and its hotspot. */
function decodeCursor(b: Uint8Array): { png: string; x: number; y: number } | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 22 || dv.getUint16(0, true) !== 0 || dv.getUint16(4, true) < 1) return null;
  const hx = dv.getUint16(10, true);
  const hy = dv.getUint16(12, true);
  const off = dv.getUint32(18, true);
  if (off + 40 > b.length) return null;
  const hdr = dv.getUint32(off, true);
  const w = dv.getInt32(off + 4, true);
  const h = Math.trunc(dv.getInt32(off + 8, true) / 2);
  const bpp = dv.getUint16(off + 14, true);
  if (w <= 0 || h <= 0 || w > 256 || h > 256 || ![1, 4, 8, 24, 32].includes(bpp)) return null;
  const used = dv.getUint32(off + 32, true);
  const colors = bpp <= 8 ? used || 1 << bpp : 0;
  const pal = off + hdr;
  const xorBase = pal + colors * 4;
  const xorStride = (((w * bpp + 31) >> 5) << 2) >>> 0;
  const andBase = xorBase + xorStride * h;
  const andStride = (((w + 31) >> 5) << 2) >>> 0;
  if (andBase + andStride * h > b.length) return null;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d");
  if (!g) return null;
  const img = g.createImageData(w, h);
  const px = img.data;
  const inverted = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    // Bottom-up rows.
    const xr = xorBase + (h - 1 - y) * xorStride;
    const ar = andBase + (h - 1 - y) * andStride;
    for (let x = 0; x < w; x++) {
      const mask = (b[ar + (x >> 3)]! >> (7 - (x & 7))) & 1;
      let r: number;
      let gr: number;
      let bl: number;
      let a = 255;
      if (bpp <= 8) {
        const bit = x * bpp;
        const index = (b[xr + (bit >> 3)]! >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1);
        const p = pal + index * 4;
        [bl, gr, r] = [b[p] ?? 0, b[p + 1] ?? 0, b[p + 2] ?? 0];
      } else {
        const p = xr + x * (bpp >> 3);
        [bl, gr, r] = [b[p]!, b[p + 1]!, b[p + 2]!];
        if (bpp === 32) a = b[p + 3]!;
      }
      const o = (y * w + x) * 4;
      if (mask) {
        // Screen pixel kept (transparent) or inverted (XOR bits set).
        if (r | gr | bl) inverted[y * w + x] = 1;
        continue;
      }
      px[o] = r;
      px[o + 1] = gr;
      px[o + 2] = bl;
      px[o + 3] = a;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inverted[y * w + x]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || inverted[ny * w + nx]) continue;
          const o = (ny * w + nx) * 4;
          if (px[o + 3]) continue;
          px[o] = px[o + 1] = px[o + 2] = 255;
          px[o + 3] = 255;
        }
      }
      const o = (y * w + x) * 4;
      px[o] = px[o + 1] = px[o + 2] = 0;
      px[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return { png: canvas.toDataURL("image/png"), x: Math.min(hx, w - 1), y: Math.min(hy, h - 1) };
}
