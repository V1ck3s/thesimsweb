/**
 * Dev test: the family living in house 1, standing side by side and playing
 * their idle loop, at the three zoom levels (top: far, bottom: near).
 * Query options: ?house=N, ?nbhd=UserData2, ?chars=user00019,user00028 (given
 * characters instead of a family), ?skill=<name> (instead of the idle).
 * Left/Right arrows rotate the view, Up/Down change the room ambient level.
 * The tile grid is drawn with HouseViewer's 2D formula (screen = origin +
 * ((8 << zoom) * (x - y), (4 << zoom) * (x + y))), so the 3D placement can be
 * checked against the sprite world: feet land on tile centers.
 */

import type { GameContext } from "../../context.js";
import { familyInHouse, loadCharacter, loadNeighborhood, neighborByGuid } from "../../data/neighborhood.js";
import { AnimDeviceCamera, SimRenderer, loadPerson, type SAnimator, type SimView } from "../../sims/index.js";
import { Gfx, TSWin } from "../../ui/tswin.js";
import type { WinMgr } from "../../ui/winmgr.js";

interface Member {
  name: string;
  anim: SAnimator;
}

/** Rows: zoom and the screen point the group's center lands on. */
const ROWS = [
  { zoom: 1, cx: 512, cy: 150 },
  { zoom: 2, cx: 512, cy: 330 },
  { zoom: 3, cx: 512, cy: 640 },
];

/** World tile around which the group stands (the middle of the lot grid). */
const CENTER = 32;

/** Unit tile vector a direction (45 degree steps) points to: 0 = -y, 2 = +x, 4 = +y, 6 = -x. */
function dirVector(d: number): [number, number] {
  const a = (d * Math.PI) / 4;
  return [Math.sin(a), -Math.cos(a)];
}

class SimsTestView extends TSWin {
  private readonly glCanvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private renderer: SimRenderer | null = null;
  members: Member[] = [];
  rotation = 0;
  /** Room ambient level; outdoor daylight on a lot is below the 1.0 maximum. */
  ambient = 0.6;
  status = "loading...";

  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    super();
    this.glCanvas = document.createElement("canvas");
    this.glCanvas.width = w;
    this.glCanvas.height = h;
    const gl = this.glCanvas.getContext("webgl2", { alpha: true, depth: true, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL2 unavailable");
    this.gl = gl;
  }

  override async init(): Promise<boolean> {
    this.renderer = await SimRenderer.create(this.gl);
    return true;
  }

  /** Screen delta of a one-tile step along a direction, at the current rotation. */
  private screenStep(d: number): { x: number; y: number } {
    const cam = new AnimDeviceCamera({ zoom: 3, rotation: this.rotation, originX: 0, originY: 0, width: this.w, height: this.h });
    const [dx, dy] = dirVector(d);
    const a = cam.project([0, 0, 0]);
    const b = cam.project([3 * dy, 0, 3 * dx]);
    return { x: b.x - a.x, y: b.y - a.y };
  }

  /** The direction whose step goes most toward `want` on screen. */
  private bestDirection(want: (s: { x: number; y: number }) => number): number {
    let best = 0;
    for (let d = 1; d < 8; d++) if (want(this.screenStep(d)) > want(this.screenStep(best))) best = d;
    return best;
  }

  /** Tile (x, y) of member i: a row across the screen. */
  private tileOf(i: number): { x: number; y: number } {
    const k = i - (this.members.length - 1) / 2;
    const [dx, dy] = dirVector(this.bestDirection((s) => s.x));
    return { x: CENTER + 0.5 + k * Math.round(dx), y: CENTER + 0.5 + k * Math.round(dy) };
  }

  /** View whose origin puts the group center at (cx, cy) for this zoom and rotation. */
  private viewFor(zoom: number, cx: number, cy: number): SimView {
    const base: SimView = { zoom, rotation: this.rotation, originX: 0, originY: 0, width: this.w, height: this.h };
    const p = new AnimDeviceCamera(base).project([3 * (CENTER + 0.5), 0, 3 * (CENTER + 0.5)]);
    return { ...base, originX: Math.round(cx - p.x), originY: Math.round(cy - p.y) };
  }

  override pump(nowMs: number): void {
    super.pump(nowMs);
    const r = this.renderer;
    if (!r) return;
    const gl = this.gl;
    gl.viewport(0, 0, this.w, this.h);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    for (const m of this.members) m.anim.update(nowMs);
    // Face the bottom of the screen (the camera).
    const direction = this.bestDirection((s) => s.y);
    for (const row of ROWS) {
      const view = this.viewFor(row.zoom, row.cx, row.cy);
      this.members.forEach((m, i) => {
        const t = this.tileOf(i);
        r.renderSim(m.anim.vitaboy, { x: t.x, y: t.y, level: 1, direction }, view, { ambient: this.ambient });
      });
    }
  }

  override tsPaint(g: Gfx): void {
    g.fill(0, 0, this.w, this.h, "#3a5a2a");
    const ctx = g.ctx;
    for (const row of ROWS) {
      const view = this.viewFor(row.zoom, row.cx, row.cy);
      // Tile corners by HouseViewer's 2D formula (the lattice is the same for every rotation).
      const corner = (vx: number, vy: number): [number, number] => [
        g.ox + view.originX + (8 << row.zoom) * (vx - vy) + 0.5,
        g.oy + view.originY + (4 << row.zoom) * (vx + vy) + 0.5,
      ];
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let k = CENTER - 4; k <= CENTER + 5; k++) {
        ctx.moveTo(...corner(CENTER - 4, k));
        ctx.lineTo(...corner(CENTER + 5, k));
        ctx.moveTo(...corner(k, CENTER - 4));
        ctx.lineTo(...corner(k, CENTER + 5));
      }
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.font = "12px sans-serif";
      ctx.fillText(`zoom ${row.zoom}`, g.ox + 8, g.oy + row.cy);
    }
    ctx.drawImage(this.glCanvas, g.ox, g.oy);
    ctx.fillStyle = "#fff";
    ctx.font = "12px sans-serif";
    const names = this.members.map((m) => `${m.name} (${m.anim.skeletonName})`).join(", ");
    ctx.fillText(`rotation ${this.rotation}  ambient ${this.ambient.toFixed(2)}  ${this.status}  ${names}`, g.ox + 8, g.oy + 16);
  }
}

export async function mount(ctx: GameContext, mgr: WinMgr): Promise<void> {
  const view = new SimsTestView(ctx.width, ctx.height);
  view.setArea(0, 0, ctx.width, ctx.height);
  mgr.main.childAdd(view);
  await view.init();
  window.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") view.rotation = (view.rotation + 3) & 3;
    else if (e.key === "ArrowRight") view.rotation = (view.rotation + 1) & 3;
    else if (e.key === "ArrowUp") view.ambient = Math.min(1, view.ambient + 0.1);
    else if (e.key === "ArrowDown") view.ambient = Math.max(0, view.ambient - 0.1);
  });
  const q = new URLSearchParams(location.search);
  const nbhd = await loadNeighborhood(q.get("nbhd") ?? "UserData");
  const add = async (shortName: string): Promise<void> => {
    const [ch, anim] = await Promise.all([loadCharacter(nbhd.dir, shortName), loadPerson(nbhd.dir, shortName)]);
    if (!anim) return;
    const skill = q.get("skill");
    if (!(skill && (await anim.startSkill(skill)))) await anim.startIdle();
    view.members.push({ name: ch.firstName, anim });
  };
  // ?chars=user00019,user00028 shows given characters instead of a family.
  const chars = q.get("chars");
  if (chars) {
    for (const c of chars.split(",")) await add(c);
    view.status = "";
    return;
  }
  const house = Number(q.get("house") ?? "1");
  const family = familyInHouse(nbhd, house);
  if (!family) {
    view.status = `no family in house ${house}`;
    return;
  }
  for (const guid of family.memberGuids) {
    const nb = neighborByGuid(nbhd, guid);
    if (nb) await add(nb.name);
  }
  view.status = `${family.name}:`;
}
