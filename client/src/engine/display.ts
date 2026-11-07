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
 * area, AnimDevice::GetBuffDims); nothing is laid out again while the game
 * runs. The port takes the size as a setting chosen on the landing page
 * (client/src/landing/main.ts), read once when the game starts: a change
 * applies at the next start, like the original's command line.
 *
 * - `?res=<w>x<h>` / `?res=auto` in the game's URL, else the stored choice,
 *   else 1024 x 768.
 * - "auto": the browser window's size, in pixels of a whole-number scale of
 *   the device pixels (see autoScreenSize), at least 800 x 600. Taken at start;
 *   a later window resize only rescales the canvas (the original's windows
 *   never lay themselves out again).
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

/** A stored or URL choice: "auto" or "<w>x<h>". */
export type ResolutionChoice = "auto" | `${number}x${number}`;

const RES_KEY = "thesimsweb.resolution";
const HUD_KEY = "thesimsweb.centredHud";

function parseChoice(s: string | null): ResolutionChoice | null {
  if (s === null) return null;
  const v = s.trim().toLowerCase();
  if (v === "auto") return "auto";
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

/** The chosen resolution: `?res=` in the page's URL, else the stored choice, else 1024 x 768. */
export function readResolution(): ResolutionChoice {
  const q = parseChoice(urlParam("res"));
  if (q) return q;
  try {
    const stored = parseChoice(localStorage.getItem(RES_KEY));
    if (stored) return stored;
  } catch {
    // (storage blocked: the default)
  }
  return `${DEFAULT_SCREEN.w}x${DEFAULT_SCREEN.h}`;
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

/**
 * Game pixels per device pixel side for "auto": a whole number, so that one
 * game pixel is a square of device pixels (no blur, no uneven columns).
 * devicePixelRatio 1 and 2 give 1 and 2 (the game's pixels are the page's CSS
 * pixels); 1.25 (Windows' 125 %) gives 1, the game then runs at the display's
 * real pixels, as the original does on that monitor; 1.5 gives 2.
 */
export function autoScale(dpr: number): number {
  return Math.max(1, Math.round(dpr));
}

/** "auto": the browser window's size in game pixels (autoScale), at least 800 x 600. */
export function autoScreenSize(): { w: number; h: number } {
  const dpr = window.devicePixelRatio || 1;
  const k = autoScale(dpr);
  const w = Math.floor((window.innerWidth * dpr) / k);
  const h = Math.floor((window.innerHeight * dpr) / k);
  return { w: Math.min(MAX_SIDE, Math.max(MIN_SCREEN.w, w)), h: Math.min(MAX_SIDE, Math.max(MIN_SCREEN.h, h)) };
}

/** The game's screen size for this start. */
export function screenSize(choice: ResolutionChoice = readResolution()): { w: number; h: number } {
  if (choice === "auto") return autoScreenSize();
  const [w, h] = choice.split("x").map(Number) as [number, number];
  return { w, h };
}

/**
 * The centred HUD's band (a port option): on a screen wider than 16:9 the
 * control panel, the view control gadget and the picture-in-picture are
 * placed in a centred 16:9 band (at least 1024 wide) instead of the screen's
 * full width; the lot view still fills the screen. Off, or on a screen no
 * wider than that, the band is the whole width, as in the original.
 */
export function hudBand(width: number, height: number, centred: boolean): { left: number; right: number } {
  if (!centred) return { left: 0, right: width };
  const w = Math.max(DEFAULT_SCREEN.w, Math.trunc((height * 16) / 9));
  if (w >= width) return { left: 0, right: width };
  const left = (width - w) >> 1;
  return { left, right: left + w };
}
