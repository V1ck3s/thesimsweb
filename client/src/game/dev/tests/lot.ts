/**
 * Dev test: the lot view full screen (1024x768) on a real house.
 * `?test=lot&house=UserData/Houses/House01.iff`.
 * Keys: arrows scroll, z / x zoom in / out, q / e (or , .) rotate,
 * PageUp / PageDown level, w cycles the wall state. Right click centers.
 * Optional: &center=x,y (world tile), &zoom=1..3, &rot=0..3.
 */

import type { GameContext } from "../../context.js";
import { WallState } from "../../cpstate.js";
import type { WinMgr } from "../../ui/winmgr.js";
import { WinLotView } from "../../world/winlotview.js";

export async function mount(ctx: GameContext, mgr: WinMgr): Promise<void> {
  const house = new URLSearchParams(location.search).get("house") ?? "UserData/Houses/House01.iff";
  const view = new WinLotView(ctx, house);
  view.setArea(0, 0, ctx.width, ctx.height);
  mgr.main.childAdd(view);
  if (!(await view.init())) throw new Error("lot view init failed");
  mgr.setFocus(view);
  // `&center=x,y` (world tile) scrolls there; `&zoom=1..3`, `&rot=0..3` set the view.
  const q = new URLSearchParams(location.search);
  const v = view.viewer!;
  if (q.get("zoom")) ctx.state.setZoom(Number(q.get("zoom")));
  if (q.get("rot")) ctx.state.setRotation(Number(q.get("rot")));
  const c = q.get("center")?.split(",").map(Number);
  if (c && c.length === 2) {
    const [vx, vy] = v.world.toView(c[0]!, c[1]!);
    v.scrollToTile((vx << 4) | 8, (vy << 4) | 8, v.level, false);
  }
  const st = ctx.state;
  const walls = [WallState.Up, WallState.Cutaway, WallState.Down, WallState.Roof];
  window.addEventListener("keydown", (e) => {
    switch (e.key) {
      case "z":
        st.zoomIn();
        break;
      case "x":
        st.zoomOut();
        break;
      case "q":
      case ",":
        st.rotateLeft();
        break;
      case "e":
      case ".":
        st.rotateRight();
        break;
      case "PageUp":
        st.setLevel(Math.min(2, st.getLevel() + 1));
        break;
      case "PageDown":
        st.setLevel(Math.max(1, st.getLevel() - 1));
        break;
      case "w":
        st.setWallState(walls[(walls.indexOf(st.getWallState()) + 1) % walls.length]!);
        break;
      default:
        return;
    }
    e.preventDefault();
  });
  (window as unknown as { lotView: WinLotView }).lotView = view;
}
