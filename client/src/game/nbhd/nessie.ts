/**
 * The neighborhood screen's Nessie (cWinNeighborhoodUL +0xf0..+0x104 and
 * DoNessie), an easter egg: the "nessie" cheat, or one chance in 1000 at each
 * TSOnTimerMsg (every second, when no Nessie is up), puts it in the river.
 *
 * From the decompiled code (cWinNeighborhoodUL::CheatCallback,
 * TSOnTimerMsg, DoNessie, PostChildDraw):
 *  - starting: +0xf0 on, +0xfc (step) and +0x104 (clock seen) -1, +0xf4 /
 *    +0xf8 (position) (0x76, 0x207); the cheat refuses a second one ("Sorry
 *    only one Nessie at a time.").
 *  - PostChildDraw runs DoNessie while +0xf0 is on, after the neighborhood
 *    number and before the filters. Step -1 loads kNess1 and takes the wave
 *    clock (+0x1dc). Each change of the wave clock moves one step on:
 *    0 plays "nessie_sfx" and shows kNess2, 1 kNess3, 2 moves the sprite 2
 *    left and 1 down (the next step once x is below 0x3d), 3 kNess2, 4 kNess1,
 *    5 ends it. The sprite is drawn at the screen offset (+0x130 / +0x134)
 *    plus the position on every DoNessie but the last one.
 */

import { soundPlayer, UI_SOURCE } from "../audio/index.js";
import type { GameContext } from "../context.js";
import type { Gfx } from "../ui/tswin.js";

/** kNess1..kNess3 */
const FRAMES = [0x13ba, 0x13bb, 0x13bc] as const;
const START_X = 0x76;
const START_Y = 0x207;
const SWIM_END_X = 0x3d;
const SOUND = "nessie_sfx";
export const NESSIE_BUSY = "Sorry only one Nessie at a time.";

/**
 * The ness*.bmp backgrounds are (255, 1, 255): cTSBuffer's 16-bit (5:6:5)
 * pixels make that the magenta key, so the key is matched at that precision.
 */
async function keyedImage(ctx: GameContext, id: number): Promise<ImageBitmap> {
  const img = await ctx.res.rgba(id);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i]! >> 3 === 31 && d[i + 1]! >> 2 === 0 && d[i + 2]! >> 3 === 31) d[i + 3] = 0;
  }
  return createImageBitmap(new ImageData(d, img.width, img.height));
}

export class Nessie {
  /** +0xf0 */
  active = false;
  /** +0xfc */
  private step = -1;
  /** +0x104 */
  private clock = -1;
  /** +0xf4 / +0xf8 */
  private x = START_X;
  private y = START_Y;
  /** +0x100: the frame shown (index into FRAMES). */
  private frame = 0;
  private images: Array<ImageBitmap | null> = [null, null, null];

  constructor(private readonly ctx: GameContext) {}

  /** CheatCallback "nessie" / TSOnTimerMsg's roll: false when one is already up. */
  start(): boolean {
    if (this.active) return false;
    this.active = true;
    this.step = -1;
    this.clock = -1;
    this.x = START_X;
    this.y = START_Y;
    FRAMES.forEach((id, i) => {
      if (this.images[i]) return;
      void keyedImage(this.ctx, id)
        .then((img) => (this.images[i] = img))
        .catch(() => null);
    });
    return true;
  }

  /** cWinNeighborhoodUL::DoNessie: `waveClock` is +0x1dc, (offX, offY) +0x130 / +0x134. */
  doNessie(g: Gfx, waveClock: number, offX: number, offY: number): void {
    if (!this.active) return;
    if (this.step < 0) {
      this.step = 0;
      this.frame = 0;
      this.clock = waveClock;
      this.draw(g, offX, offY);
    }
    if (this.clock === waveClock) {
      this.draw(g, offX, offY);
      return;
    }
    this.clock = waveClock;
    switch (this.step) {
      case 0:
        soundPlayer.playBySource(SOUND, UI_SOURCE);
        this.step = 1;
        this.frame = 1;
        break;
      case 1:
        this.step = 2;
        this.frame = 2;
        break;
      case 2:
        this.x -= 2;
        this.y += 1;
        this.draw(g, offX, offY);
        if (this.x < SWIM_END_X) this.step = 3;
        return;
      case 3:
        this.step = 4;
        this.frame = 1;
        break;
      case 4:
        this.step = 5;
        this.frame = 0;
        break;
      default:
        this.active = false;
        return;
    }
    this.draw(g, offX, offY);
  }

  private draw(g: Gfx, offX: number, offY: number): void {
    const img = this.images[this.frame];
    if (img) g.blit(img, offX + this.x, offY + this.y);
  }
}
