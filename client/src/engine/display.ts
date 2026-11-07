/**
 * The game's screen size (the original's display mode) and how the canvas
 * shows it in the page.
 *
 * The original sets its screen size once, at start (cSimsApp::PreFrameWorkInit):
 * the Mac build runs at 800 x 600, or 1024 x 768 with the "r1024x768" switch;
 * the Windows build asks DirectDraw for exactly that mode (cTSGraphicSystemW95::
 * Init, FUN_005ef53d matches the mode list), and the well-known widescreen
 * trick patches those numbers (this install's Sims.exe asks for 0x1400 x 0x5a0
 * = 5120 x 1440 unless "-r1024x768" is given). The main window, the lot view
 * and every window that places itself then read that size (their parent's
 * area, AnimDevice::GetBuffDims).
 *
 * The original draws one game pixel per screen pixel, so a large mode shows
 * the lot and the neighborhood far away and the panels small. The port keeps
 * the look of the default 1024 x 768 at any resolution instead: the game runs
 * at a size whose smaller side matches 1024 x 768 (gameSize: 5120 x 1440 ->
 * 2731 x 768, 3840 x 2160 -> 1365 x 768) and the canvas is scaled up to the
 * screen. Wider screens still show more of the lot left and right; zoom and
 * panels keep their default size, and the cost of drawing stays that of a
 * screen about 768 high. Sizes no larger than 1024 x 768 run as they are.
 *
 * - `?res=<w>x<h>` / `?res=auto` / `?res=window` in the game's URL, else the
 *   stored choice, else "window" (1024 x 768 is the original's default mode).
 * - "auto": the browser window's size when the game starts; a later resize
 *   only rescales the canvas.
 * - "window": the browser window's size, followed while the game runs (the
 *   windows lay themselves out again, game/main.ts Game.resizeScreen; a port
 *   addition, the original never changes its mode).
 * - `?hud=centred` / `?hud=full`, else the stored choice (off): the centred
 *   HUD (a port option, not in the original), see hudBand.
 */

/** The sizes offered on the landing page (any `?res=<w>x<h>` of at least 800 x 600 works too). */
export const RESOLUTIONS: ReadonlyArray<readonly [number, number]> = [
  [800, 600],
  [1024, 768],
  [1280, 720],
  [1280, 800],
  [1280, 1024],
  [1366, 768],
  [1440, 900],
  [1600, 900],
  [1680, 1050],
  [1920, 1080],
  [1920, 1200],
  [2560, 1080],
  [2560, 1440],
  [2560, 1600],
  [3440, 1440],
  [3840, 1600],
  [3840, 2160],
  [5120, 1440],
  [5120, 2160],
];

/** The original's default here (the Windows build with "-r1024x768"; the port has always run at it). */
export const DEFAULT_SCREEN = { w: 1024, h: 768 } as const;
/** The smallest screen the original's layouts are made for (the Mac build's default mode). */
export const MIN_SCREEN = { w: 800, h: 600 } as const;
/** The largest size accepted (the widescreen patch's 5120 x 1440 and the 5120 x 2160 above, with room). */
const MAX_SIDE = 7680;

/** A stored or URL choice: "auto", "window" or "<w>x<h>". */
export type ResolutionChoice = "auto" | "window" | `${number}x${number}`;

const RES_KEY = "thesimsweb.resolution";
const HUD_KEY = "thesimsweb.centredHud";

function parseChoice(s: string | null): ResolutionChoice | null {
  if (s === null) return null;
  const v = s.trim().toLowerCase();
  if (v === "auto" || v === "window") return v;
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(v);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (w < MIN_SCREEN.w || h < MIN_SCREEN.h || w > MAX_SIDE || h > MAX_SIDE) return null;
  return `${w}x${h}`;
}

function urlParam(name: string): string | null {
  try {
    return typeof location === "undefined" ? null : new URLSearchParams(location.search).get(name);
  } catch {
    return null;
  }
}

/** The chosen resolution: `?res=` in the page's URL, else the stored choice, else "window". */
export function readResolution(): ResolutionChoice {
  const q = parseChoice(urlParam("res"));
  if (q) return q;
  try {
    const stored = parseChoice(localStorage.getItem(RES_KEY));
    if (stored) return stored;
  } catch {
    // (storage blocked: the default)
  }
  return "window";
}

/** Keeps the player's choice for the next game start; false when the browser refuses to store it. */
export function storeResolution(choice: ResolutionChoice): boolean {
  try {
    localStorage.setItem(RES_KEY, choice);
    return true;
  } catch {
    return false;
  }
}

/** The centred HUD option: `?hud=centred|full`, else the stored choice, else off. */
export function readCentredHud(): boolean {
  const q = urlParam("hud");
  if (q === "centred" || q === "centered") return true;
  if (q === "full") return false;
  try {
    return localStorage.getItem(HUD_KEY) === "1";
  } catch {
    return false;
  }
}

export function storeCentredHud(on: boolean): boolean {
  try {
    localStorage.setItem(HUD_KEY, on ? "1" : "0");
    return true;
  } catch {
    return false;
  }
}

/** The browser window's size in device pixels (what "auto" and "window" fill). */
export function windowSize(): { w: number; h: number } {
  const dpr = window.devicePixelRatio || 1;
  return { w: Math.round(window.innerWidth * dpr), h: Math.round(window.innerHeight * dpr) };
}

/** The screen size a choice asks for (device pixels): a fixed size, or the window's. */
export function outputSize(choice: ResolutionChoice = readResolution()): { w: number; h: number } {
  if (choice === "auto" || choice === "window") return windowSize();
  const [w, h] = choice.split("x").map(Number) as [number, number];
  return { w, h };
}

/**
 * The size the game runs at for a screen of `out` pixels: the screen divided
 * by the scale at which 1024 x 768 just fits in it, so that the zoom and the
 * panels look as at 1024 x 768 (a 16:9 screen gives 1365 x 768, 32:9 gives
 * 2731 x 768, 5:4 gives 1024 x 819). A fixed size no larger than 1024 x 768
 * in either direction (the original's modes, 800 x 600) runs at its own size;
 * a window smaller than that (`fill`) is filled the same way, the game shrunk
 * to it.
 */
export function gameSize(out: { w: number; h: number }, fill = false): { w: number; h: number } {
  const s = Math.min(out.w / DEFAULT_SCREEN.w, out.h / DEFAULT_SCREEN.h);
  if (s <= 0) return { ...DEFAULT_SCREEN };
  if (s <= 1 && !fill) {
    return { w: Math.min(MAX_SIDE, Math.max(MIN_SCREEN.w, out.w)), h: Math.min(MAX_SIDE, Math.max(MIN_SCREEN.h, out.h)) };
  }
  return { w: Math.min(MAX_SIDE, Math.max(DEFAULT_SCREEN.w, Math.round(out.w / s))), h: Math.min(MAX_SIDE, Math.max(DEFAULT_SCREEN.h, Math.round(out.h / s))) };
}

/** The game's screen size for this start (or, with "window", for the window's size now). */
export function screenSize(choice: ResolutionChoice = readResolution()): { w: number; h: number } {
  return gameSize(outputSize(choice), choice === "auto" || choice === "window");
}

/**
 * The centred HUD's band (a port option): on a screen wider than 1024 the
 * control panel, the view control gadget and the picture-in-picture are
 * placed in a centred band 1024 wide, the 1024 x 768 interface (its Live
 * pages take their 1024 layouts, game/context.ts hudLayoutWidth), instead
 * of the screen's full width; the lot view still fills the screen. Off, the
 * band is the whole width, as in the original.
 */
export function hudBand(width: number, _height: number, centred: boolean): { left: number; right: number } {
  if (!centred || width <= DEFAULT_SCREEN.w) return { left: 0, right: width };
  const left = (width - DEFAULT_SCREEN.w) >> 1;
  return { left, right: left + DEFAULT_SCREEN.w };
}

const FULLSCREEN_KEY = "thesimsweb.fullscreen";

/**
 * The fullscreen option (a port setting): the game page asks the browser for
 * fullscreen (Element.requestFullscreen, at the first click or key, which the
 * browser requires) instead of relying on F11, whose toolbar slides back in
 * when the mouse reaches the top of the screen. `?fullscreen=1|0`, else the
 * stored choice, else off.
 */
export function readFullscreen(): boolean {
  const q = urlParam("fullscreen");
  if (q === "1" || q === "0") return q === "1";
  try {
    return localStorage.getItem(FULLSCREEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function storeFullscreen(on: boolean): boolean {
  try {
    localStorage.setItem(FULLSCREEN_KEY, on ? "1" : "0");
    return true;
  } catch {
    return false;
  }
}
