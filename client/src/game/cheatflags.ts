/**
 * Globals the cheat commands write (cSimsApp's AppCheatCallback and the
 * graphics Callback store straight into these data-section labels).
 */

export const cheatFlags = {
  /** lbl_105BA244 ("move_objects on/off"): pick up, place and edit anywhere. */
  moveObjects: false,
  /** lbl_105BA388 ("bubble_tweak n"): cXPerson::DrawIso's RenderParam::DepthTweak around DrawSpriteSlot. */
  bubbleTweak: -65,
  /** lbl_105BA914 ("draw_routes on/off"): written only; nothing in the shipped Mac build reads it. */
  drawRoutes: false,
  /**
   * lbl_105BA690 ("draw_floorable on/off", initially 1): HouseViewer::RenderStaticRow
   * draws the build-mode grid on the floorable tiles of the upper level only while it is set.
   */
  drawFloorable: true,
  /** lbl_105BA68C ("map_edit on/off"): the tile tool is the cheat tool and the map overlay is drawn. */
  mapEdit: false,
  /** lbl_105BA438 ("draw_all_frames on/off"). */
  drawAllFrames: false,
  /** lbl_105BA904 ("log_mask n"). */
  logMask: 0,
  /**
   * The "genable" graphics cheat's HouseViewer module switches (lbl_105BA674 ..
   * lbl_105BA650, "genable default" values). terrain, floors, walls, objects and
   * people gate their passes in world/houseviewer.ts; clear, fullDraw,
   * staticRows, static and oldClear switch parts of the original's static
   * layer and damage refresh, which this renderer does not have (reported by
   * "genable status" only).
   */
  genable: {
    terrain: true,
    floors: true,
    walls: true,
    clear: true,
    objects: true,
    people: true,
    fullDraw: false,
    staticRows: true,
    static: true,
    oldClear: false,
  },
};
