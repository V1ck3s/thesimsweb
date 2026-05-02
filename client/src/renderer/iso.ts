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

  // Sort sprites by depth in *rotated* tile space. Rotation flips which axis
  // is "back" — without re-projecting we'd render objects in the wrong order
  // after a 180° camera spin.
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
  const sorted = [...scene.sprites].sort(
    (a, b) => depthOf(a.worldX, a.worldY) - depthOf(b.worldX, b.worldY),
  );

  for (const s of sorted) {
    const { sx, sy } = projectTile(s.worldX, s.worldY, cam, canvas);
    drawDgrpSprite(ctx, s, sx, sy);
  }
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
