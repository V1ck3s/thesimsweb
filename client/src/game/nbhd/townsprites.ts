/**
 * The town screens' moving decorations, drawn over the map by the screens'
 * PostChildDraw:
 *
 * - cMagiclandSprites (Makin' Magic, cWinMagicland): DoWater (ported in
 *   wintown.ts), DoClouds (21 mist clouds, kMagictownFogA..C, faded with
 *   Compose2) and DoBalloons (the hot-air balloon, kMagictownBalloon1..16,
 *   on an ellipse). Clouds only when the terrain detail is not Low
 *   (cWinMagicland +0x38c, from cOptionsMgr::GetTerrainDetail).
 * - cWinStudiotown's cars (Superstar): InitCars (6 lanes), AnimateCarLane /
 *   AnimateCarNE / AnimateCarSW / DrawCar (kStudiotownCar0..17). +0x350
 *   (the cars are on) is 1 from the constructor; the "cars [speed]" cheat
 *   (CheatCallback) only turns them on when they are off.
 *
 * Both animate only when the screen's TSPaint clock ticked since the last
 * draw (cMagiclandSprites +0x388, cWinStudiotown +0x358); here `step()` is
 * that tick and `draw()` the PostChildDraw part.
 */

import type { RgbaImage } from "../res/bmp.js";
import type { UIRes } from "../res/uires.js";
import type { Gfx } from "../ui/tswin.js";

/** rand_override's range (0..0x7fff). */
function rand(): number {
  return Math.floor(Math.random() * 0x8000);
}

/** cMagiclandSprites::CloudInfo (0x24 bytes). */
interface Cloud {
  x: number;
  y: number;
  /** 0: kMagictownFogC, 1: FogB, 2: FogA (DrawCloud's buffers +0x80 / +0x84 / +0x88). */
  type: number;
  counter: number;
  /** Compose2's mask offset, -255 (invisible) .. -110. */
  alpha: number;
  /** Moves every `speed` steps. */
  speed: number;
  resetX: number;
  resetY: number;
  dx: number;
}

/** Compose2 offsets are applied in steps of this (its blend has 32 levels, a >> 3). */
const ALPHA_QUANTUM = 8;

/** lbl_105BD1C4: the balloon's angle scale and frame ranges. */
const BALLOON_ANGLE_MUL = 0.785;
const BALLOON_ANGLE_DIV = 180;

export class MagiclandSprites {
  private readonly clouds: Cloud[] = [];
  /** cMagiclandSprites +0x80..+0x88: the mist pixels (their alpha is the Compose2 mask). */
  private fog: Array<RgbaImage | null> = [null, null, null];
  /** The faded mist per (type, quantized offset). */
  private readonly fogCache = new Map<number, OffscreenCanvas>();
  private balloon: ImageBitmap[] = [];
  /** cMagiclandSprites +4: BalloonInfo. */
  private readonly bal = { x: -100, y: 0, centerY: 300, centerX: 400, frame: 1, radius: 100, counter: 1 };

  constructor(private readonly cloudsOn: boolean) {
    this.initClouds();
  }

  /** LoadClouds / LoadBalloons. */
  async load(res: UIRes): Promise<void> {
    const fog = await Promise.all([0x1657, 0x1656, 0x1655].map((id) => res.rgba(id).catch(() => null)));
    this.fog = fog;
    const frames = await Promise.all(Array.from({ length: 16 }, (_, i) => res.image(0x1645 + i).catch(() => null)));
    this.balloon = frames.filter((f): f is ImageBitmap => f !== null);
  }

  /** cMagiclandSprites::InitClouds. */
  private initClouds(): void {
    for (let i = 0; i < 21; i++) {
      this.clouds.push({ x: 0, y: 0, type: rand() % 3, counter: 1, alpha: -110, speed: (rand() & 1) + 2, resetX: 0, resetY: 0, dx: 0 });
    }
    for (let i = 0; i < 8; i++) {
      const c = this.clouds[i]!;
      c.y = 0x3c + 16 * i;
      c.resetY = 0;
      c.x = 0x156 - 32 * i + i * (rand() % 5);
      c.resetX = 0x1ce - 32 * i;
      c.dx = 2;
    }
    for (let k = 10; k < 16; k++) {
      const i = k - 10;
      const c = this.clouds[k]!;
      c.y = i * 16 + 0x3c;
      c.resetY = 0;
      c.x = i * -0x30 + 0x11a + k * (rand() % 5);
      c.resetX = i * -0x30 + 0x1ce;
      c.dx = 3;
    }
    for (let k = 17; k < 21; k++) {
      const i = k - 17;
      const c = this.clouds[k]!;
      c.y = i * 10 + 0x3c;
      c.resetY = 0;
      c.x = i * (rand() % 5) + 0x8e;
      c.resetX = i * (rand() % 5) + 0x106;
      c.dx = 2;
    }
    // Clouds 8, 9 and 16 are never placed: dx 0, reset to x 0 with the
    // offset -255 every step, so never visible.
  }

  /** The animate half of DoClouds / DoBalloons (+0x388 set). */
  step(): void {
    if (this.cloudsOn) for (const c of this.clouds) this.animateCloud(c);
    this.animateBalloon();
  }

  /** cMagiclandSprites::AnimateClouds. */
  private animateCloud(c: Cloud): void {
    let { x, y, alpha } = c;
    if (c.counter % c.speed === 0) {
      x -= c.dx;
      y++;
    }
    if (x < 1) {
      x = c.resetX;
      alpha = -0xff;
      y = c.resetY;
      c.type = rand() % 3;
    }
    if (x >= 0x65) alpha += 2;
    else if (x < 0x1e) alpha -= 3;
    if (alpha < -0xfe) alpha = -0xff;
    if (alpha > -0x6f) alpha = -0x6e;
    c.alpha = alpha;
    c.counter++;
    c.x = x;
    c.y = y;
  }

  /** cMagiclandSprites::AnimateBalloon. */
  private animateBalloon(): void {
    const b = this.bal;
    const n = b.counter;
    const a = (BALLOON_ANGLE_MUL * (n % 0x5a0)) / BALLOON_ANGLE_DIV;
    const dy = Math.trunc(b.radius * Math.sin(a));
    const dx = Math.trunc(2 * b.radius * Math.cos(a));
    const tick = n % 0x23 === 0;
    let f = b.frame;
    if (a === 0) {
      if (tick) f = 2;
    } else if (a > 0 && a < 1.5 && f <= 5) {
      if (tick) f++;
    } else if (a > 1.5 && a < 3 && f <= 9) {
      if (tick) f++;
    } else if (a > 3 && a < 4.5 && f <= 13) {
      if (tick) f++;
    } else if (a > 4.5 && a < 5 && f <= 15) {
      if (tick) f++;
    } else if (a > 5 && a < 6) {
      if (f === 15) f = 0;
      if (tick) f++;
      if (f > 2) f = 2;
    }
    if (f > 14) f = 15;
    b.counter++;
    b.x = dx;
    b.y = dy;
    b.frame = f;
  }

  /** DoClouds then DoBalloons (DrawCloud / DrawBalloon), (ox, oy) the map's offset (+0x394 / +0x398). */
  draw(g: Gfx, ox: number, oy: number): void {
    if (this.cloudsOn) {
      for (const c of this.clouds) {
        const img = this.fadedFog(c.type, c.alpha);
        if (img) g.blit(img, ox + c.x, oy + c.y);
      }
    }
    const b = this.bal;
    const frame = this.balloon[b.frame];
    if (frame) g.blit(frame, ox + b.x + b.centerX, oy + b.y + b.centerY);
  }

  /**
   * Compose2's blend of a mist buffer: per pixel a = mask + offset; a <= 7
   * leaves the screen, a >= 248 copies, else mixes at (a >> 3) / 32.
   */
  private fadedFog(type: number, offset: number): OffscreenCanvas | null {
    const off = Math.round(offset / ALPHA_QUANTUM) * ALPHA_QUANTUM;
    if (off <= -0xf8) return null;
    const key = type * 1024 + (off + 512);
    let c = this.fogCache.get(key);
    if (c) return c;
    const src = this.fog[type];
    if (!src) return null;
    const out = new ImageData(src.width, src.height);
    const s = src.data;
    const d = out.data;
    for (let i = 0; i < s.length; i += 4) {
      const a = s[i + 3]! + off;
      if (a <= 7) continue;
      d[i] = s[i]!;
      d[i + 1] = s[i + 1]!;
      d[i + 2] = s[i + 2]!;
      d[i + 3] = a >= 0xf8 ? 255 : Math.round(((a >> 3) * 255) / 32);
    }
    c = new OffscreenCanvas(src.width, src.height);
    c.getContext("2d")?.putImageData(out, 0, 0);
    this.fogCache.set(key, c);
    return c;
  }
}

/** cWinStudiotown's carLaneInfo (0x60 bytes from +0x110): the per-car vectors and the lane constants. */
interface CarLane {
  /** +8 */
  x: number[];
  /** +0x14 */
  y: number[];
  /** +0x20 */
  speed: number[];
  /** +0x2c: steps since the car spawned (TSPaint's tick counts it up). */
  age: number[];
  /** +0x38: 1 for the car spawned after the lane's first respawn ("leader"). */
  lead: number[];
  /** +0x44: the car model, 0..8 (buffer model * 2 + (dir < 0)). */
  sprite: number[];
  /** +0x48 / +0x4c: the spawn point. */
  startY: number;
  startX: number;
  /** +0x50: the x a car respawns past. */
  bound: number;
  /** +0x54: 1 (towards SW: x down, y up), -1 (towards NE). */
  dir: number;
  /** +0x58 */
  count: number;
  /** +0x5c: the age past which a car may slow down at random. */
  patience: number;
}

/** InitCars' lanes: [start y, start x, bound, count, patience]; the first three go SW. */
const LANES: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [0x1d4, 0x326, 0x1a4, 13, 0x28],
  [0x1e0, 0x326, 0x1b8, 11, 0x23],
  [0x1ec, 0x326, 0x1db, 10, 0x1e],
  [0x25e, 0x21a, 0x330, 8, 0x14],
  [0x25e, 0x23e, 0x330, 7, 0xc],
  [0x25e, 0x262, 0x330, 5, 10],
];

export class StudiotownCars {
  private readonly lanes: CarLane[] = [];
  /** +0x35c: kStudiotownCar0..17. */
  private cars: Array<ImageBitmap | null> = [];
  /** +0x354: the top speed (the constructor's 1; the "cars" cheat takes 1..2). */
  private readonly maxSpeed = 1;

  constructor() {
    this.initCars();
  }

  async load(res: UIRes): Promise<void> {
    this.cars = await Promise.all(Array.from({ length: 18 }, (_, i) => res.image(0x161c + i).catch(() => null)));
  }

  /** cWinStudiotown::InitCars (the per-car initial values lbl_105C3454 / 58 / 5C are all 0). */
  private initCars(): void {
    LANES.forEach(([startY, startX, bound, count, patience], l) => {
      const dir = l < 3 ? 1 : -1;
      const lane: CarLane = { x: [], y: [], speed: [], age: [], lead: [], sprite: [], startY, startX, bound, dir, count, patience };
      for (let i = 0; i < count; i++) {
        const k = count - i;
        lane.lead.push(0);
        lane.x.push(startX + (dir < 1 ? k * 0x18 : -k * 0x18));
        lane.y.push(startY + (dir < 1 ? -k * 8 : k * 8));
        lane.sprite.push(Math.trunc((rand() % 18) / 2));
        lane.age.push(0);
        lane.speed.push(0);
      }
      this.lanes.push(lane);
    });
  }

  private width(lane: CarLane, i: number): number {
    const img = this.cars[lane.sprite[i]! * 2 + (lane.dir < 0 ? 1 : 0)];
    return (img?.width ?? 0) + 4;
  }

  /** TSPaint's tick (the +0x2c ages counted up) then PostChildDraw's AnimateCarLane with +0x358 set. */
  step(): void {
    for (const lane of this.lanes) for (let i = 0; i < lane.count; i++) lane.age[i]!++;
    for (const lane of this.lanes) this.animateCarLane(lane);
  }

  /** cWinStudiotown::AnimateCarLane (the respawns and moves; the drawing is draw()). */
  private animateCarLane(lane: CarLane): void {
    for (let i = 0; i < lane.count; i++) {
      const r = rand();
      const past = lane.dir < 1 ? lane.x[i]! > lane.bound : lane.x[i]! < lane.bound;
      if (past) {
        if (i < lane.count - 1) lane.lead[i + 1] = 1;
        lane.lead[i] = 0;
        lane.age[i] = 0;
        lane.x[i] = lane.startX;
        lane.y[i] = lane.startY;
        lane.speed[i] = this.maxSpeed;
        lane.sprite[i] = Math.trunc((r % 18) / 2);
      }
      this.animateCar(lane, i);
    }
  }

  /**
   * cWinStudiotown::AnimateCarNE (dir < 0) / AnimateCarSW: a car brakes
   * when the car ahead (the last one for car 0) is closer than its width
   * + 4, else speeds up 1 in 10 (1 in 40 for the lead car) up to the top
   * speed, and slows down 1 in 10 past the lane's patience age; then moves
   * 3 * speed along x and speed along y.
   */
  private animateCar(lane: CarLane, i: number): void {
    const ne = lane.dir < 0;
    const w = this.width(lane, i);
    const x = lane.x;
    const sp = lane.speed;
    const close = (back: number, front: number): boolean => (ne ? front - w < back && back <= front : back < front + w && front <= back);
    const brake = (k: number): void => {
      if (sp[k]! > 0) sp[k]!--;
    };
    const accelerate = (k: number): void => {
      if (sp[k]! < this.maxSpeed) sp[k]!++;
    };
    if (i < 1) {
      if (close(x[0]!, x[lane.count - 1]!)) brake(0);
      else if (rand() % 10 === 1 && lane.patience < lane.age[i]!) brake(i);
      else if (rand() % 10 === 1) accelerate(0);
    } else if (lane.lead[i] === 1) {
      if (rand() % 10 === 1 && lane.patience < lane.age[i]!) brake(i);
      else if (rand() % 0x28 === 1) accelerate(i);
    } else if (ne ? x[i - 1]! - w < x[i]! : x[i]! < w + x[i - 1]!) {
      brake(i);
    } else if (rand() % 10 === 1) {
      accelerate(i);
    }
    x[i] = x[i]! + (ne ? 3 : -3) * sp[i]!;
    lane.y[i] = lane.y[i]! + (ne ? -1 : 1) * sp[i]!;
  }

  /** AnimateCarLane's DrawCar calls, (ox, oy) the map's offset (+0x3c0 / +0x3c4). */
  draw(g: Gfx, ox: number, oy: number): void {
    for (const lane of this.lanes) {
      for (let i = 0; i < lane.count; i++) {
        const img = this.cars[lane.sprite[i]! * 2 + (lane.dir < 0 ? 1 : 0)];
        if (img) g.blit(img, ox + lane.x[i]!, oy + lane.y[i]!);
      }
    }
  }
}
