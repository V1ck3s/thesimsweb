/**
 * Camera mode snapshots (the lot view side of the camera panel).
 *
 *  - HouseViewer::ComputeCameraFrame: the frame of the CPState camera size
 *    (CamGetWidth / CamGetHeight) sits on the cursor: centered horizontally
 *    (cursor x - w / 2 - 1 .. cursor x + w / 2 - 1), its bottom on the cursor
 *    (top = cursor y - h - 2), moved then clipped into the view rectangle
 *    (HouseViewer +0x28..+0x34). HouseViewer::UpdateWorld draws it in white
 *    (FrameRect 0xffffff) while the camera mode is on;
 *  - cDDDSimsView::TSOnMouseDownL in camera mode (the cursor over the view):
 *    HouseViewer::TakeAsyncSnapshot(frame inset by 1 pixel, open the album
 *    after, no description), which plays "ui_camera_photo" (the Windows
 *    build, FUN_004b17e5);
 *  - the next HouseViewer::UpdateWorld takes the rectangle (kept inside the
 *    screen buffer) out of the rendered frame into a new buffer, hands it to
 *    cScrapbook::AddPhoto with CPState::CamGetQualityValue, then posts
 *    command 0x1f to the view, which opens the album (cWinScrapbook) on the
 *    new photo. A medium photo is 398 x 300.
 * Here the rectangle is copied from the rendered lot view (the compositor's
 * canvas) right away.
 */

import { soundPlayer, UI, UI_SOURCE } from "../audio/index.js";
import type { GameContext } from "../context.js";
import type { Rect } from "../ui/tswin.js";
import { Gfx } from "../ui/tswin.js";
import { currentScrapbook, showScrapbook } from "./camscrapbook.js";

/** FrameRect's color. */
const FRAME_COLOR = "#ffffff";

/**
 * HouseViewer::ComputeCameraFrame for the cursor (x, y) in a view of
 * (0, 0, viewW, viewH). Right and bottom are exclusive.
 */
export function computeCameraFrame(ctx: GameContext, x: number, y: number, viewW: number, viewH: number): Rect {
  const w = ctx.state.camGetWidth();
  const h = ctx.state.camGetHeight();
  let left = x - Math.trunc(w / 2) - 1;
  let right = x + Math.trunc(w / 2) - 1;
  let top = y - h - 2;
  let bottom = y;
  if (left < 0) {
    right -= left;
    left = 0;
  } else if (right >= viewW) {
    const d = viewW - right - 1;
    left += d;
    right += d;
  }
  if (top < 0) {
    bottom -= top;
    top = 0;
  } else if (bottom >= viewH) {
    const d = viewH - bottom - 1;
    top += d;
    bottom += d;
  }
  left = Math.min(Math.max(left, 0), viewW);
  top = Math.min(Math.max(top, 0), viewH);
  right = Math.max(Math.min(right, viewW), 0);
  bottom = Math.max(Math.min(bottom, viewH), 0);
  return { left, top, right, bottom };
}

/** HouseViewer::UpdateWorld in camera mode: the frame in white. */
export function drawCameraFrame(g: Gfx, r: Rect): void {
  if (r.left < r.right && r.top < r.bottom) g.frame(r.left, r.top, r.right - r.left, r.bottom - r.top, FRAME_COLOR);
}

let shooting = false;

/**
 * cDDDSimsView::TSOnMouseDownL (camera mode) -> HouseViewer::TakeAsyncSnapshot
 * of the camera frame inset by 1 pixel, the album opened after.
 */
export async function takeCameraSnapshot(
  ctx: GameContext,
  view: HTMLCanvasElement | OffscreenCanvas,
  frame: Rect,
  size: { width: number; height: number } = view,
): Promise<void> {
  const r = { left: frame.left + 1, top: frame.top + 1, right: frame.right - 1, bottom: frame.bottom - 1 };
  await takeAsyncSnapshot(ctx, view, r, true, "", size);
}

/**
 * HouseViewer::TakeAsyncSnapshot(rect, openAlbum, description) ->
 * HouseViewer::UpdateWorld: the photo inside `rect` (view coordinates) of
 * the rendered `view`, added to the family album with the description
 * (cScrapbook::SetDescription, when not empty), then the album opens when
 * asked (the view's command 0x1f). Also cDDDSimsView::DoPictureInPicture's
 * auto snapshot (no album, the event's caption).
 */
export async function takeAsyncSnapshot(
  ctx: GameContext,
  view: HTMLCanvasElement | OffscreenCanvas,
  rect: Rect,
  openAlbum: boolean,
  description: string,
  /** The screen buffer's size within `view` (the lot view's canvas also has the picture in picture's strip). */
  size: { width: number; height: number } = view,
): Promise<void> {
  if (shooting) return;
  shooting = true;
  try {
    let r = rect;
    soundPlayer.playBySource(UI.cameraPhoto, UI_SOURCE);
    const w = r.right - r.left;
    const h = r.bottom - r.top;
    if (w <= 0 || h <= 0) return;
    // Kept inside the screen buffer.
    if (r.left < 0) r = { ...r, left: 0, right: w };
    if (r.top < 0) r = { ...r, top: 0, bottom: h };
    if (r.right > size.width) r = { ...r, left: size.width - w, right: size.width };
    if (r.bottom > size.height) r = { ...r, top: size.height - h, bottom: size.height };
    const photo = new OffscreenCanvas(w, h);
    photo.getContext("2d")!.drawImage(view, r.left, r.top, w, h, 0, 0, w, h);
    const book = await currentScrapbook(ctx);
    if (!book) return;
    await book.addPhoto(photo, ctx.state.camGetQualityValue());
    if (description) book.setDescription(description);
    // The view's command 0x1f: the album, on the new photo.
    if (openAlbum) await showScrapbook(ctx);
  } finally {
    shooting = false;
  }
}
