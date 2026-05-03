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
  /** Cardinal facing direction, used to orient a face dot on the head. 0 = +x
   *  (east in unrotated tile space), then CCW: 1 = -y (north), 2 = -x (west),
   *  3 = +y (south). Undefined = no face dot. */
  facing?: 0 | 1 | 2 | 3;
  /** Extra screen-y offset (negative = up) added to the entity's body and head
   *  before drawing. Used for walk bob and similar tiny vertical motions
   *  without committing to a full skeleton. */
  verticalOffset?: number;
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
  /** Tile coordinate the cursor is currently hovering. Drawn last as a
   *  highlight outline so the user sees where their click will land. */
  hoverTile?: { worldX: number; worldY: number } | null;
  /** Per-tile floor color override. Key = `y * gridSize + x`. Tiles without
   *  an entry use the default checker pattern. */
  floorPaint?: Map<number, string>;
  /** Walls on the *north* edge of tile (x, y), keyed by `y * (gridSize + 1) + x`.
   *  y ∈ [0, gridSize] (gridSize = south boundary). x ∈ [0, gridSize - 1]. */
  wallsN?: Set<number>;
  /** Walls on the *west* edge of tile (x, y), same key scheme as `wallsN`.
   *  x ∈ [0, gridSize] (gridSize = east boundary). y ∈ [0, gridSize - 1]. */
  wallsW?: Set<number>;
  /** Doors share the wall key scheme. When a door overlaps a wall the renderer
   *  draws only the door frame (passable visualisation). */
  doorsN?: Set<number>;
  doorsW?: Set<number>;
  /** Optional ghost wall (orientation + tile coords) drawn semi-transparent so
   *  the user can see where their next click will land in wall-place mode. */
  ghostWall?: { orientation: "n" | "w"; tileX: number; tileY: number } | null;
  /** Game clock minutes-of-day (0..1440). When set, the sky background blends
   *  through dawn → day → dusk → night based on this value. */
  timeMinutes?: number;
}

const SKY = "#1f3340";
const GRID_LINE = "#2a4054";

/** Sample anchors for the four time-of-day phases. Linearly interpolated
 *  between adjacent anchors; the result is the canvas background fill. */
const SKY_ANCHORS: ReadonlyArray<{ atMin: number; color: [number, number, number] }> = [
  { atMin: 0,         color: [0x10, 0x14, 0x28] }, // midnight — deep navy
  { atMin: 5 * 60,    color: [0x10, 0x14, 0x28] }, // pre-dawn
  { atMin: 6 * 60,    color: [0x6a, 0x4a, 0x70] }, // dawn — purple
  { atMin: 7 * 60,    color: [0xe8, 0xa0, 0x70] }, // sunrise glow
  { atMin: 9 * 60,    color: [0x6e, 0xb6, 0xe8] }, // morning sky
  { atMin: 14 * 60,   color: [0x4a, 0x9a, 0xd6] }, // bright day
  { atMin: 18 * 60,   color: [0x6e, 0xb6, 0xe8] }, // late afternoon
  { atMin: 19 * 60,   color: [0xea, 0x80, 0x60] }, // sunset
  { atMin: 20 * 60,   color: [0x4a, 0x36, 0x60] }, // dusk
  { atMin: 22 * 60,   color: [0x18, 0x1c, 0x36] }, // night
  { atMin: 24 * 60,   color: [0x10, 0x14, 0x28] }, // wraps back to midnight
];

function skyColorForMinutes(minutes: number): string {
  const m = ((minutes % (24 * 60)) + 24 * 60) % (24 * 60);
  let prev = SKY_ANCHORS[0]!;
  let next = SKY_ANCHORS[SKY_ANCHORS.length - 1]!;
  for (let i = 0; i < SKY_ANCHORS.length - 1; i += 1) {
    const a = SKY_ANCHORS[i]!;
    const b = SKY_ANCHORS[i + 1]!;
    if (m >= a.atMin && m <= b.atMin) { prev = a; next = b; break; }
  }
  const span = next.atMin - prev.atMin || 1;
  const t = (m - prev.atMin) / span;
  const r = Math.round(prev.color[0] + (next.color[0] - prev.color[0]) * t);
  const g = Math.round(prev.color[1] + (next.color[1] - prev.color[1]) * t);
  const b = Math.round(prev.color[2] + (next.color[2] - prev.color[2]) * t);
  return `rgb(${r}, ${g}, ${b})`;
}
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

  // Sky — clock-driven if `timeMinutes` is provided, else the default navy.
  ctx.fillStyle = scene.timeMinutes !== undefined ? skyColorForMinutes(scene.timeMinutes) : SKY;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Floor: draw tiles in back-to-front order (greater (x+y) on top).
  const cam = scene.camera;
  const N = scene.gridSize;
  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) {
      const { sx, sy } = projectTile(x, y, cam, canvas);
      // Painted floor tiles override everything; otherwise we keep the
      // checker pattern with the gold/rust orientation strips so camera
      // rotation stays visible.
      let fill: string;
      const painted = scene.floorPaint?.get(y * N + x);
      if (painted) {
        fill = painted;
      } else if (y === 0) {
        fill = TILE_NORTH;
      } else if (x === N - 1) {
        fill = TILE_EAST;
      } else {
        fill = (x + y) % 2 === 0 ? TILE_LIGHT : TILE_DARK;
      }
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
    | { type: "entity"; ref: IsoEntity; depth: number }
    | { type: "wall"; orientation: "n" | "w"; tileX: number; tileY: number; depth: number; ghost: boolean; door: boolean };
  const drawables: Drawable[] = [];
  for (const s of scene.sprites) {
    drawables.push({ type: "sprite", ref: s, depth: depthOf(s.worldX, s.worldY) });
  }
  for (const e of scene.entities ?? []) {
    drawables.push({ type: "entity", ref: e, depth: depthOf(e.worldX, e.worldY) });
  }
  // Iterate over the union of walls and doors so a free-standing door without
  // a wall still renders. Using a Map(key → entry) lets us merge orientations
  // cheaply.
  const collectEdges = (
    walls: Set<number> | undefined,
    doors: Set<number> | undefined,
    orient: "n" | "w",
  ): void => {
    const seen = new Set<number>();
    if (walls) {
      for (const k of walls) {
        seen.add(k);
        const x = k % (N + 1);
        const y = Math.floor(k / (N + 1));
        const d = orient === "n" ? depthOf(x, y - 0.5) : depthOf(x - 0.5, y);
        const isDoor = doors?.has(k) ?? false;
        drawables.push({ type: "wall", orientation: orient, tileX: x, tileY: y, depth: d, ghost: false, door: isDoor });
      }
    }
    if (doors) {
      for (const k of doors) {
        if (seen.has(k)) continue;
        const x = k % (N + 1);
        const y = Math.floor(k / (N + 1));
        const d = orient === "n" ? depthOf(x, y - 0.5) : depthOf(x - 0.5, y);
        drawables.push({ type: "wall", orientation: orient, tileX: x, tileY: y, depth: d, ghost: false, door: true });
      }
    }
  };
  collectEdges(scene.wallsN, scene.doorsN, "n");
  collectEdges(scene.wallsW, scene.doorsW, "w");
  if (scene.ghostWall) {
    const g = scene.ghostWall;
    const dx = g.orientation === "n" ? 0 : -0.5;
    const dy = g.orientation === "n" ? -0.5 : 0;
    drawables.push({
      type: "wall",
      orientation: g.orientation,
      tileX: g.tileX,
      tileY: g.tileY,
      depth: depthOf(g.tileX + dx, g.tileY + dy),
      ghost: true,
      door: false,
    });
  }
  drawables.sort((a, b) => a.depth - b.depth);

  for (const d of drawables) {
    if (d.type === "sprite") {
      const { sx, sy } = projectTile(d.ref.worldX, d.ref.worldY, cam, canvas);
      drawDgrpSprite(ctx, d.ref, sx, sy);
    } else if (d.type === "entity") {
      const { sx, sy } = projectTile(d.ref.worldX, d.ref.worldY, cam, canvas);
      drawEntity(ctx, d.ref, sx, sy, cam.tileWidth, cam.rotation ?? 0);
    } else {
      drawWall(ctx, d.orientation, d.tileX, d.tileY, cam, canvas, d.ghost, d.door);
    }
  }

  // Hover highlight — drawn last so it sits above sprites and entities.
  if (scene.hoverTile) {
    const ht = scene.hoverTile;
    if (ht.worldX >= 0 && ht.worldY >= 0 && ht.worldX < N && ht.worldY < N) {
      const { sx, sy } = projectTile(ht.worldX, ht.worldY, cam, canvas);
      const tw = cam.tileWidth;
      const th = tw / 2;
      ctx.beginPath();
      ctx.moveTo(sx, sy - th / 2);
      ctx.lineTo(sx + tw / 2, sy);
      ctx.lineTo(sx, sy + th / 2);
      ctx.lineTo(sx - tw / 2, sy);
      ctx.closePath();
      ctx.strokeStyle = "rgba(255,255,255,.85)";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,.10)";
      ctx.fill();
    }
  }
}

/** Procedural Sim placeholder: a vertical capsule with a head, scaled to the
 *  current tile size so it looks roughly proportional at any zoom level.
 *  `camRotation` is needed to flip the face dot so a Sim facing world-east
 *  still appears to look east on screen after a 90° camera spin. */
function drawEntity(
  ctx: CanvasRenderingContext2D,
  e: IsoEntity,
  cx: number,
  cy: number,
  tileWidth: number,
  camRotation: 0 | 1 | 2 | 3,
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
  // Bob lifts the body+head; the shadow stays planted on the floor so the
  // motion reads as a hop instead of a teleport.
  const bobY = e.verticalOffset ?? 0;
  const baseY = cy + tileWidth / 8 + bobY;
  const topY = baseY - bodyH;
  // Soft drop shadow under the feet — anchored to floor (no bob).
  ctx.fillStyle = "rgba(0,0,0,.35)";
  ctx.beginPath();
  ctx.ellipse(cx, cy + tileWidth / 8 + 1, bodyW * 0.7, bodyW * 0.25, 0, 0, Math.PI * 2);
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
  const headCY = topY - headR + 1;
  ctx.fillStyle = lightenHex(e.color, 0.25);
  ctx.beginPath();
  ctx.arc(cx, headCY, headR, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  // Face dot — orient the head so the user sees which way the Sim is looking.
  // Walking direction is in tile-space; project a unit vector through the same
  // rotation the renderer applies so screen-east stays screen-east.
  if (e.facing !== undefined) {
    const facingRad = (e.facing * Math.PI) / 2;
    let dx = Math.cos(facingRad);
    let dy = -Math.sin(facingRad);
    switch (camRotation) {
      case 1: { const t = dx; dx = -dy; dy = t; break; }
      case 2: dx = -dx; dy = -dy; break;
      case 3: { const t = dx; dx = dy; dy = -t; break; }
      default: break;
    }
    const isoDX = (dx - dy) * 0.5;
    const isoDY = (dx + dy) * 0.25;
    const fr = headR * 0.55;
    const norm = Math.hypot(isoDX, isoDY) || 1;
    ctx.fillStyle = "rgba(0,0,0,.7)";
    ctx.beginPath();
    ctx.arc(cx + (isoDX / norm) * fr, headCY + (isoDY / norm) * fr, headR * 0.18, 0, Math.PI * 2);
    ctx.fill();
  }
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

/** Wall on the north or west edge of tile (x, y). Drawn as a parallelogram
 *  rising from the floor by `WALL_HEIGHT_RATIO * tileWidth` screen pixels. The
 *  floor edge is projected from the two tile-space corners; the top edge is
 *  the same minus a vertical screen-y offset so the wall stays cardinal-axis
 *  upright regardless of camera rotation. */
function drawWall(
  ctx: CanvasRenderingContext2D,
  orientation: "n" | "w",
  x: number,
  y: number,
  cam: IsoCamera,
  canvas: HTMLCanvasElement,
  ghost: boolean,
  door: boolean,
): void {
  const tw = cam.tileWidth;
  const wallH = tw * 0.6;
  let p1x: number;
  let p1y: number;
  let p2x: number;
  let p2y: number;
  if (orientation === "n") {
    p1x = x - 0.5; p1y = y - 0.5;
    p2x = x + 0.5; p2y = y - 0.5;
  } else {
    p1x = x - 0.5; p1y = y - 0.5;
    p2x = x - 0.5; p2y = y + 0.5;
  }
  const a = projectTile(p1x, p1y, cam, canvas);
  const b = projectTile(p2x, p2y, cam, canvas);
  const fillSide = ghost ? "rgba(180,140,110,.45)" : "#a8826a";
  const fillTop = ghost ? "rgba(220,190,160,.55)" : "#cba98b";
  const stroke = ghost ? "rgba(60,40,30,.5)" : "#5a3e2c";
  if (door) {
    // Door = two short jambs at the edge ends + a top lintel spanning the
    // gap. The middle ~60 % of the edge stays open so a Sim can walk through
    // and the room behind stays visible. We draw both jambs as mini walls,
    // then a thin lintel rectangle along the top of the would-be wall.
    const jambFrac = 0.18;
    const jamb1End = { sx: a.sx + (b.sx - a.sx) * jambFrac, sy: a.sy + (b.sy - a.sy) * jambFrac };
    const jamb2Start = { sx: a.sx + (b.sx - a.sx) * (1 - jambFrac), sy: a.sy + (b.sy - a.sy) * (1 - jambFrac) };
    const drawSlab = (s1: { sx: number; sy: number }, s2: { sx: number; sy: number }): void => {
      ctx.beginPath();
      ctx.moveTo(s1.sx, s1.sy);
      ctx.lineTo(s1.sx, s1.sy - wallH);
      ctx.lineTo(s2.sx, s2.sy - wallH);
      ctx.lineTo(s2.sx, s2.sy);
      ctx.closePath();
      ctx.fillStyle = fillSide;
      ctx.fill();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      ctx.stroke();
    };
    drawSlab(a, jamb1End);
    drawSlab(jamb2Start, b);
    // Lintel — thin band joining the two jamb tops (5 px tall).
    const lintelH = 5;
    const lintelTop = wallH;
    ctx.beginPath();
    ctx.moveTo(jamb1End.sx, jamb1End.sy - lintelTop);
    ctx.lineTo(jamb1End.sx, jamb1End.sy - lintelTop + lintelH);
    ctx.lineTo(jamb2Start.sx, jamb2Start.sy - lintelTop + lintelH);
    ctx.lineTo(jamb2Start.sx, jamb2Start.sy - lintelTop);
    ctx.closePath();
    ctx.fillStyle = fillTop;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.stroke();
    return;
  }
  // Plain wall — solid side face + top ribbon.
  ctx.beginPath();
  ctx.moveTo(a.sx, a.sy);
  ctx.lineTo(a.sx, a.sy - wallH);
  ctx.lineTo(b.sx, b.sy - wallH);
  ctx.lineTo(b.sx, b.sy);
  ctx.closePath();
  ctx.fillStyle = fillSide;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1;
  ctx.stroke();
  // Top ribbon — slightly lighter so the wall reads as 3D.
  ctx.beginPath();
  ctx.moveTo(a.sx, a.sy - wallH);
  ctx.lineTo(b.sx, b.sy - wallH);
  ctx.lineTo(b.sx, b.sy - wallH - 3);
  ctx.lineTo(a.sx, a.sy - wallH - 3);
  ctx.closePath();
  ctx.fillStyle = fillTop;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.stroke();
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
