/**
 * Globals the cheat commands write (cSimsApp's AppCheatCallback and the
 * graphics Callback store straight into these data-section labels).
 */

export const cheatFlags = {
  /** lbl_105BA244 ("move_objects on/off"): pick up, place and edit anywhere. */
  moveObjects: false,
  /** lbl_105BA388 ("bubble_tweak n"): cXPerson::DrawIso's RenderParam::DepthTweak around DrawSpriteSlot. */
  bubbleTweak: -65,
  /** lbl_105BA914 ("draw_routes on/off"): route drawing (debug overlay, not drawn). */
  drawRoutes: false,
  /** lbl_105BA690 ("draw_floorable on/off"): floorable tiles overlay (debug, not drawn). */
  drawFloorable: false,
  /** lbl_105BA438 ("draw_all_frames on/off"). */
  drawAllFrames: false,
  /** lbl_105BA904 ("log_mask n"). */
  logMask: 0,
};
