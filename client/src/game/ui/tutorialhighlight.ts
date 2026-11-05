/**
 * cTSWinTutorialHighlight — the animated arrow the tutorial shows over a
 * window (cTSWin::HiliteForTutorial), and the window manager's single
 * instance (cTSWinMgrW95::SetTutorialHighlighter, +0x20c).
 *
 * cDDDSimsView's init creates it in the main window, hidden, with
 * kTutorialHighlightBMP (three frames side by side, transparent) at 6
 * frames per second (lbl_105BC0C8); the window is one frame wide
 * (SetBuffer). ShowWindow restarts the animation at frame 0 going forward;
 * each timer message (1000 / fps + 0.5 ms, lbl_105BD118) steps it and
 * reverses at both ends (0 1 2 1 0 ...).
 *
 * cTSWin::HiliteForTutorial(on): hidden when off or when the window is
 * hidden; else moved centered above the window (3 px gap), shown, pulled
 * to the front, with the standard cursor 0. cWinLotBtn::HiliteForTutorial
 * moves it 0x32 lower and gives it the arrow (standard cursor 4).
 *
 * Deviation: the original also sets window flag 0x10000 on it; that bit is
 * the modal flag of the web window manager (keys go to the front-most modal
 * window), so it is left clear.
 *
 * Also here (TutorialEffects.cpp): Tut_CheckForEvents, the UI events the
 * tutorial object waits for.
 */

import type { GameContext } from "../context.js";
import { TSWinBtn } from "./btn.js";
import { getStandardCursor } from "./cursor.js";
import { Gfx, TSWin } from "./tswin.js";
import { winMgr } from "./winmgr.js";
import type { WinLivePopup } from "../cpanel/livepopup.js";
import type { SimModule } from "../sim/simmodule.js";
import type { SimObject } from "../sim/xobject.js";
import { HouseViewer } from "../world/houseviewer.js";

/** lbl_105BC0C8: frames per second. */
const FPS = 6;
/** The bitmap's frame count (SetBuffer(..., 3, fps)). */
const FRAMES = 3;
/** lbl_105BD118: timer period = 1000 * (1 / fps) + 0.5. */
const PERIOD_MS = Math.trunc(1000 * (1 / FPS) + 0.5);

export class TSWinTutorialHighlight extends TSWin {
  /** +0xcc / +0xd0 / +0xd4 */
  private buffer: ImageBitmap | null = null;
  private frames = 0;
  private fps = 0;
  /** +0xd8: step (1 / -1); +0xdc: current frame; +0xe0: timer subscribed. */
  private step = 0;
  private frame = 0;
  private timerOn = false;
  private lastStepMs = 0;

  /** cTSWinTutorialHighlight::Init */
  override async init(): Promise<boolean> {
    this.winCursor = getStandardCursor(0);
    return true;
  }

  /** cTSWinTutorialHighlight::SetBuffer(buffer, frames, fps): one frame wide, the bitmap's height. */
  setBuffer(buffer: ImageBitmap | null, frames: number, fps: number): void {
    this.buffer = buffer;
    this.frames = frames;
    this.fps = fps;
    if (!buffer) return;
    const w = frames === 0 ? buffer.width : Math.trunc(buffer.width / frames);
    this.setArea(this.area.left, this.area.top, this.area.left + w, this.area.top + buffer.height);
  }

  /** cTSWinTutorialHighlight::ShowWindow */
  override showWindow(): void {
    if (!this.isVisible()) {
      this.frame = 0;
      this.step = 1;
      if (!this.timerOn && this.fps > 0) {
        this.timerOn = true;
        this.lastStepMs = performance.now();
      }
    }
    super.showWindow();
  }

  /** cTSWinTutorialHighlight::HideWindow */
  override hideWindow(): void {
    if (this.isVisible()) this.timerOn = false;
    super.hideWindow();
  }

  /** cTSWinTutorialHighlight::TSOnTimerMsg (driven by the pump at the subscribed period). */
  override pump(nowMs: number): void {
    if (this.timerOn && nowMs - this.lastStepMs >= PERIOD_MS) {
      this.lastStepMs = nowMs;
      if (this.step > 0) {
        if (this.frame === this.frames - 1) this.step = -1;
      } else if (this.step < 0 && this.frame === 0) {
        this.step = 1;
      }
      this.frame += this.step;
    }
    super.pump(nowMs);
  }

  /** cTSWinTutorialHighlight::TSPaint: frame `frame` of the strip. */
  override tsPaint(g: Gfx): void {
    const b = this.buffer;
    if (!b || this.frames === 0) return;
    const w = Math.trunc(b.width / this.frames);
    g.blitPart(b, this.frame * w, 0, w, b.height, 0, 0);
  }
}

/** cTSWinMgrW95 +0x20c */
let highlighter: TSWinTutorialHighlight | null = null;
let creating: Promise<TSWinTutorialHighlight> | null = null;

/**
 * The tutorial highlighter, made on first use as cDDDSimsView's init makes
 * it: in the main window, hidden, kTutorialHighlightBMP, 3 frames at 6 fps
 * (cTSWinMgrW95::SetTutorialHighlighter).
 */
export function getTutorialHighlighter(ctx: GameContext): Promise<TSWinTutorialHighlight> {
  creating ??= (async () => {
    const h = new TSWinTutorialHighlight();
    await h.init();
    winMgr.main.childAdd(h);
    h.hideWindow();
    h.setBuffer(await ctx.res.image("kTutorialHighlightBMP"), FRAMES, FPS);
    highlighter = h;
    return h;
  })();
  return creating;
}

/** cTSWinMgrW95 +0x20c's HideWindow (cDDDSimsView's Escape). */
export function hideTutorialHighlighter(): void {
  highlighter?.hideWindow();
}

/**
 * cTSWin::HiliteForTutorial(on) (vtable +0x168) for `win`; `lotBtn` adds
 * cWinLotBtn's override (0x32 lower, arrow cursor).
 */
export async function hiliteForTutorial(ctx: GameContext, win: TSWin, on: boolean, lotBtn = false): Promise<void> {
  const h = highlighter ?? (on ? await getTutorialHighlighter(ctx) : null);
  if (!h) return;
  if (!on || !win.isVisible()) {
    h.hideWindow();
    return;
  }
  const o = win.absOrigin();
  const x = o.x + Math.trunc((win.getW() - h.getW()) / 2);
  const y = o.y - (h.getH() + 3);
  h.setArea(x, y, x + h.getW(), y + h.getH());
  h.showWindow();
  h.parent?.childToFront(h);
  h.winCursor = getStandardCursor(0);
  if (lotBtn) {
    h.setArea(h.area.left, h.area.top + 0x32, h.area.right, h.area.bottom + 0x32);
    h.winCursor = getStandardCursor(4);
  }
}

/** FindButton(cTSWin *, int): depth first, the first button whose bitmap is resource `image`. */
function findButton(win: TSWin, image: ImageBitmap): TSWinBtn | null {
  for (const c of win.children) {
    if (c instanceof TSWinBtn && c.image === image) return c;
    const found = findButton(c, image);
    if (found) return found;
  }
  return null;
}

/**
 * The end of Tut_FlashPersonPanelButton / Tut_FlashRelButton: HiliteForTutorial
 * on the window the caller found (FindButton on the person's picture buffer,
 * FindRelButton), nothing when there is none.
 */
export async function tutFlashWindow(ctx: GameContext, win: TSWin | null, on: boolean): Promise<void> {
  if (win) await hiliteForTutorial(ctx, win, on);
}

/** Tut_FlashButtonByImageID(id, on): the arrow over the main window's button showing bitmap `id`. */
export async function tutFlashButtonByImageID(ctx: GameContext, id: number, on: boolean): Promise<void> {
  const image = await ctx.res.image(id).catch(() => null);
  const btn = image ? findButton(winMgr.main, image) : null;
  if (btn) await hiliteForTutorial(ctx, btn, on);
}

/** What Tut_CheckForEvents reads of the game around the tutorial object. */
export interface TutEventSource {
  readonly ctx: GameContext;
  /** ObjectModule (+0x14 of the app's house): the tutorial object, the simulator's globals, the neighbors. */
  readonly module: SimModule;
  /** cRotatableWorld +0x84 */
  rotation(): number;
  /** PersonFinder::GetPictureBuffer of a person (by GUID), null without one. */
  personPicture(guid: number): ImageBitmap | null;
}

/** lbl_105BBCAC: the tutorial object's trees and the live popup tags it waits on. */
const QUERY_WAIT_EVENT = "query wait event";
const GOT_WAIT_EVENT = "got wait event";
const POPUP_TAGS: Record<number, string> = { 2: "motives", 9: "rel", 11: "job", 13: "skill", 15: "per.ity" };

/** lbl_105BEEC0: the value the rotation / scroll events compare with (-1: none yet). */
let lastEventValue = -1;

/** cXObject::RunTree(tree by name, no stack object): its result, false without the tree or on error. */
function runTree(o: SimObject, name: string): boolean {
  const tree = o.behavior.getTreeID(name);
  if (tree === 0) return false;
  try {
    return o.runOneTickTree(o.behavior, 0, tree, null);
  } catch (e) {
    console.warn(`[tutorial] ${name} failed`, e);
    return false;
  }
}

/** FindButton(cTSWin *, int): depth first, the first button whose bitmap is resource `id`. */
function findButtonById(ctx: GameContext, win: TSWin, id: number): TSWinBtn | null {
  for (const c of win.children) {
    if (c instanceof TSWinBtn && c.image && ctx.res.idOf(c.image) === id) return c;
    const found = findButtonById(ctx, c, id);
    if (found) return found;
  }
  return null;
}

/**
 * Tut_CheckForEvents (cDDDSimsView's idle, before the simulation runs):
 * global 12 takes the resource id of the bitmap of the last button clicked
 * (lbl_105BA498, 0 without one). With a tutorial object, its "query wait
 * event" tree says whether it waits (false: the compared value is reset)
 * and leaves the event in its temp 0 (temp 1 the data); when the event has
 * happened its "got wait event" tree runs and the compared value is reset.
 * Events: 1 the control panel shown (CPState::GetCPMode 0); 2 / 9 / 11 /
 * 13 / 15 the live popup (cWinPeople +0x150) open on a client tagged
 * "motives" / "rel" / "job" / "skill" / "per.ity"; 14 that popup closed;
 * 4 the last button clicked shows bitmap temp 1; 5 its bitmap is the
 * picture of neighbor temp 1; 6 the view rotated, 7 scrolled
 * (HouseViewer::SetOffsets called) since the first check; 8 the button
 * showing bitmap temp 1 is down; 0, 3, 10, 12 and others never happen.
 */
export function tutCheckForEvents(src: TutEventSource, popup: WinLivePopup | null): void {
  const { ctx, module: m } = src;
  const tut = m.tutorialObject;
  const last = TSWinBtn.lastPressed;
  const lastId = last?.image ? (ctx.res.idOf(last.image) ?? 0) : 0;
  m.sim.globals[0xc] = (lastId << 16) >> 16;
  if (!tut) return;
  if (!runTree(tut, QUERY_WAIT_EVENT)) {
    lastEventValue = -1;
    return;
  }
  const event = tut.obj.temps[0]!;
  const data = tut.obj.temps[1]!;
  let fire = false;
  const client = popup?.isEnabled() ? popup.getClient() : null;
  switch (event) {
    case 1:
      fire = ctx.state.getCPMode() === 0;
      break;
    case 2:
    case 9:
    case 11:
    case 13:
    case 15:
      fire = client !== null && client.kind === POPUP_TAGS[event];
      break;
    case 14:
      fire = client === null;
      break;
    case 4:
      fire = last?.image != null && lastId === data;
      break;
    case 5: {
      const nb = last ? m.findNeighborByID(data) : null;
      const pic = nb ? src.personPicture(nb.guid) : null;
      fire = pic !== null && last?.image === pic;
      break;
    }
    case 6:
    case 7: {
      const v = event === 6 ? src.rotation() : HouseViewer.setOffsetsCount;
      if (lastEventValue === -1) lastEventValue = v;
      else fire = lastEventValue !== v;
      break;
    }
    case 8: {
      const b = findButtonById(ctx, winMgr.main, data);
      fire = b !== null && b.state !== 0;
      break;
    }
    default:
      break;
  }
  if (!fire) return;
  runTree(tut, GOT_WAIT_EVENT);
  lastEventValue = -1;
}
