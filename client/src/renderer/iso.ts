/**
 * Minimal 2D-canvas isometric renderer — Phase 3 ramp.
 *
 * The Sims uses a classic 2:1 dimetric projection (often called "isometric"
 * but technically dimetric: the y-axis is squished). One tile is drawn as a
 * diamond `TILE_W × TILE_H` pixels, with `TILE_H = TILE_W / 2`.
 *
 * Tile (x, y) → screen (sx, sy):
 *   sx = (x - y) * TILE_W / 2 + originX
 *   sy = (x + y) * TILE_H / 2 + originY
 *
 * For now we only support a single zoom level + a rectangular tile grid
 * (no walls / no rotation). Just enough to drop a composited DGRP onto a
 * lot footprint.
 */

/** Same shape as the DGRP sprites returned by the WASM bindings. */
export interface IsoSpriteRef {
  spriteXOffset: number;
  spriteYOffset: number;
}

/** Decoded RGBA bitmap. */
export interface IsoBitmap {
  width: number;
  height: number;
  rgba: Uint8Array;
}

export interface IsoSceneSprite {
  bmp: IsoBitmap;
  sp: IsoSpriteRef;
  /** Tile coordinate of this sprite's anchor (object's footprint origin). */
  worldX: number;
  worldY: number;
}

/** Non-sprite entity rendered with a procedural shape — used for the Sim
 *  placeholder (we don't have CMX/BCF parsing yet) and any debug markers.
 *  Fractional `worldX`/`worldY` are honoured so a walking Sim slides smoothly
 *  between tiles. */
export interface IsoEntity {
  worldX: number;
  worldY: number;
  /** Visual shape. "sim" draws a head+body capsule; "marker" draws a small
   *  diamond useful for debugging. */
  kind: "sim" | "marker";
  /** Body fill (head is auto-derived to a slightly lighter shade). */
  color: string;
  /** Optional one-line text rendered above the entity. */
  label?: string;
}

export interface IsoCamera {
  /** Tile diamond width in pixels. Height = width / 2. */
  tileWidth: number;
  /** Tile (worldX, worldY) at the canvas centre. */
  centerX: number;
  centerY: number;
  /** 0 / 1 / 2 / 3 — number of 90° clockwise rotations applied to the world
   *  before projection. 0 = south-facing (the default TS1 view); 1 = west;
   *  2 = north; 3 = east. */
  rotation?: 0 | 1 | 2 | 3;
}

export interface IsoScene {
  /** Lot extent in tiles (square). */
  gridSize: number;
  sprites: IsoSceneSprite[];
  /** Procedural shapes (Sim placeholder, debug markers) rendered after the
   *  sprites in painter's order. */
  entities?: IsoEntity[];
  camera: IsoCamera;
}

const SKY = "#1f3340";
const GRID_LINE = "#2a4054";
const TILE_LIGHT = "#3b6e3b";
const TILE_DARK = "#326432";
const TILE_NORTH = "#d6ad3d"; // gold strip along world-Y=0 — flips after rotation
const TILE_EAST = "#bd5e3a"; // rust strip along world-X=N-1 — also flips

/** Project a tile coordinate to screen pixels.
 *
 *  Rotation is applied in tile-space *around* the camera centre before the
 *  isometric projection, so the same world (x, y) lands at a different screen
 *  position depending on `cam.rotation`. We use the centre of the lot grid
 *  (`gridSize / 2`) as the pivot — passed via `cam.centerX/centerY` — so a
 *  16×16 lot keeps spinning around its midpoint regardless of zoom.
 */
export function projectTileToScreen(
  x: number,
  y: number,
  cam: IsoCamera,
  canvas: HTMLCanvasElement,
): { sx: number; sy: number } {
  return projectTile(x, y, cam, canvas);
}

/** Inverse of {@link projectTileToScreen}: given a canvas pixel, return the
 *  (worldX, worldY) tile that contains it (rounded to integers). Returns
 *  fractional values too via `fx`/`fy` if the caller needs sub-tile precision.
 */
export function screenToTile(
  canvasX: number,
  canvasY: number,
  cam: IsoCamera,
  canvas: HTMLCanvasElement,
): { worldX: number; worldY: number; fx: number; fy: number } {
  const tw = cam.tileWidth;
  const dx = canvasX - canvas.width / 2;
  const dy = canvasY - canvas.height / 2;
  // From forward projection: dx = (lx - ly) * tw/2, dy = (lx + ly) * tw/4.
  let localX = dx / tw + (2 * dy) / tw;
  let localY = -dx / tw + (2 * dy) / tw;
  // Unrotate (the forward applies rotation in tile-space *before* projection,
  // so the inverse undoes it after the inverse projection).
  switch (cam.rotation ?? 0) {
    case 1: { const t = localX; localX = localY; localY = -t; break; }
    case 2: localX = -localX; localY = -localY; break;
    case 3: { const t = localX; localX = -localY; localY = t; break; }
    default: break;
  }
  const fx = localX + cam.centerX;
  const fy = localY + cam.centerY;
  return { worldX: Math.round(fx), worldY: Math.round(fy), fx, fy };
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
    case 1: {
      const t = localX;
      localX = -localY;
      localY = t;
      break;
    }
    case 2:
      localX = -localX;
      localY = -localY;
      break;
    case 3: {
      const t = localX;
      localX = localY;
      localY = -t;
      break;
    }
    default:
      break;
  }
  const sx = canvas.width / 2 + (localX - localY) * (tw / 2);
  const sy = canvas.height / 2 + (localX + localY) * (th / 2);
  return { sx, sy };
}

/** Draw a single filled diamond representing a floor tile. */
function drawTile(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  tileWidth: number,
  fill: string,
): void {
  const tw = tileWidth;
  const th = tw / 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy - th / 2);
  ctx.lineTo(cx + tw / 2, cy);
  ctx.lineTo(cx, cy + th / 2);
  ctx.lineTo(cx - tw / 2, cy);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = GRID_LINE;
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** Render an iso scene. Sky background + checkerboard floor + sprites sorted
 *  back-to-front by world (x + y) so painter's algorithm puts closer items
 *  on top. */
export function renderIso(canvas: HTMLCanvasElement, scene: IsoScene): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;

  // Sky.
  ctx.fillStyle = SKY;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Floor: draw tiles in back-to-front order (greater (x+y) on top).
  const cam = scene.camera;
  const N = scene.gridSize;
  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) {
      const { sx, sy } = projectTile(x, y, cam, canvas);
      // Two coloured edges (north & east in world space) make camera rotation
      // visible — the gold strip points to world-N regardless of camera angle.
      let fill = (x + y) % 2 === 0 ? TILE_LIGHT : TILE_DARK;
      if (y === 0) fill = TILE_NORTH;
      else if (x === N - 1) fill = TILE_EAST;
      drawTile(ctx, sx, sy, cam.tileWidth, fill);
    }
  }

  // Sort sprites *and* entities together by depth in *rotated* tile space.
  // Rotation flips which axis is "back" — without re-projecting we'd render
  // objects in the wrong order after a 180° camera spin.
  const depthOf = (worldX: number, worldY: number): number => {
    let lx = worldX - cam.centerX;
    let ly = worldY - cam.centerY;
    switch (cam.rotation ?? 0) {
      case 1: { const t = lx; lx = -ly; ly = t; break; }
      case 2: lx = -lx; ly = -ly; break;
      case 3: { const t = lx; lx = ly; ly = -t; break; }
      default: break;
    }
    return lx + ly;
  };
  type Drawable =
    | { type: "sprite"; ref: IsoSceneSprite; depth: number }
    | { type: "entity"; ref: IsoEntity; depth: number };
  const drawables: Drawable[] = [];
  for (const s of scene.sprites) {
    drawables.push({ type: "sprite", ref: s, depth: depthOf(s.worldX, s.worldY) });
  }
  for (const e of scene.entities ?? []) {
    drawables.push({ type: "entity", ref: e, depth: depthOf(e.worldX, e.worldY) });
  }
  drawables.sort((a, b) => a.depth - b.depth);

  for (const d of drawables) {
    if (d.type === "sprite") {
      const { sx, sy } = projectTile(d.ref.worldX, d.ref.worldY, cam, canvas);
      drawDgrpSprite(ctx, d.ref, sx, sy);
    } else {
      const { sx, sy } = projectTile(d.ref.worldX, d.ref.worldY, cam, canvas);
      drawEntity(ctx, d.ref, sx, sy, cam.tileWidth);
    }
  }
}

/** Procedural Sim placeholder: a vertical capsule with a head, scaled to the
 *  current tile size so it looks roughly proportional at any zoom level. */
function drawEntity(
  ctx: CanvasRenderingContext2D,
  e: IsoEntity,
  cx: number,
  cy: number,
  tileWidth: number,
): void {
  if (e.kind === "marker") {
    const r = Math.max(3, tileWidth / 8);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = e.color;
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,.5)";
    ctx.lineWidth = 1;
    ctx.stroke();
    return;
  }
  // "sim" — a 1.5-tile-tall capsule with a separate head circle.
  const bodyW = Math.max(6, tileWidth * 0.30);
  const bodyH = Math.max(14, tileWidth * 0.75);
  const headR = Math.max(4, tileWidth * 0.18);
  const baseY = cy + tileWidth / 8;
  const topY = baseY - bodyH;
  // Soft drop shadow under the feet.
  ctx.fillStyle = "rgba(0,0,0,.35)";
  ctx.beginPath();
  ctx.ellipse(cx, baseY + 1, bodyW * 0.7, bodyW * 0.25, 0, 0, Math.PI * 2);
  ctx.fill();
  // Body (rounded rect approx).
  ctx.fillStyle = e.color;
  ctx.beginPath();
  const r = bodyW / 2;
  ctx.moveTo(cx - r, baseY - r);
  ctx.lineTo(cx - r, topY + r);
  ctx.arc(cx, topY + r, r, Math.PI, 0, false);
  ctx.lineTo(cx + r, baseY - r);
  ctx.arc(cx, baseY - r, r, 0, Math.PI, false);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,.4)";
  ctx.lineWidth = 1;
  ctx.stroke();
  // Head — slightly lighter shade.
  ctx.fillStyle = lightenHex(e.color, 0.25);
  ctx.beginPath();
  ctx.arc(cx, topY - headR + 1, headR, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  if (e.label) {
    ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
    const text = e.label;
    const metrics = ctx.measureText(text);
    const padX = 4;
    const lblY = topY - headR * 2 - 6;
    ctx.fillStyle = "rgba(0,0,0,.65)";
    ctx.fillRect(cx - metrics.width / 2 - padX, lblY - 11, metrics.width + padX * 2, 14);
    ctx.fillStyle = "#cde";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, cx, lblY - 4);
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
  }
}

/** Mix a "#rrggbb" colour towards white by `t` (0..1). */
function lightenHex(hex: string, t: number): string {
  if (!hex.startsWith("#") || hex.length !== 7) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const mix = (c: number): number => Math.round(c + (255 - c) * t);
  const hh = (n: number): string => n.toString(16).padStart(2, "0");
  return `#${hh(mix(r))}${hh(mix(g))}${hh(mix(b))}`;
}

/** Composite a single SPR2 frame onto the canvas at the projected screen pos.
 *  The DGRP `sprite_x_offset`/`sprite_y_offset` express how the sprite's
 *  pre-rendered top-left aligns to its tile centre. Both are in *pixels*. */
function drawDgrpSprite(
  ctx: CanvasRenderingContext2D,
  s: IsoSceneSprite,
  cx: number,
  cy: number,
): void {
  const { bmp, sp } = s;
  // DGRP offsets are stored relative to the tile centre. Positive y goes
  // down in screen space.
  const drawX = Math.round(cx + sp.spriteXOffset);
  const drawY = Math.round(cy + sp.spriteYOffset);
  // Convert RGBA to ImageData.
  const img = ctx.createImageData(bmp.width, bmp.height);
  img.data.set(bmp.rgba);
  ctx.putImageData(img, drawX, drawY);
}
