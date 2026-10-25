/**
 * The selected sim's action icons (cDDDSimsView's cActionIcon row): in Live
 * mode, the current action then the queued ones (PersonFinder::
 * GetPersonActions), left to right from (0x20, 0x20), 0x32 px apart. Each
 * icon is the picture of the interaction's icon object (MakeActionBitmap
 * frames the object's thumbnail); its tooltip is the interaction name, a
 * click cancels it (cXPerson::RemoveAction).
 *
 * Simplifications: the icons do not slide (StartAnimating / AnimateIcon), a
 * cancelled action is drawn dimmed rather than with the original's cross,
 * and people targets show a plain frame (no head picture).
 */

import { ObjectIcon } from "../cpanel/buy/objecticon.js";
import type { Interaction, PersonSim } from "../sim/person.js";
import type { Gfx } from "../ui/tswin.js";
import type { ObjSelector } from "./objselector.js";

const ORIGIN_X = 0x20;
const ORIGIN_Y = 0x20;
const STEP = 0x32;
const SIZE = 40;

export class ActionIcons {
  private readonly icons = new Map<ObjSelector, ObjectIcon | null>();
  private readonly pending = new Set<ObjSelector>();
  /** Asks for a repaint once an icon picture is ready. */
  onReady: (() => void) | null = null;

  /** The current action first, then the queue. */
  private actions(p: PersonSim): Interaction[] {
    return p.currentAction ? [p.currentAction, ...p.queue] : [...p.queue];
  }

  private icon(sel: ObjSelector): ObjectIcon | null {
    if (this.icons.has(sel)) return this.icons.get(sel)!;
    if (!this.pending.has(sel)) {
      this.pending.add(sel);
      void ObjectIcon.create(sel.res, sel.objdId)
        .catch(() => null)
        .then((ic) => {
          this.icons.set(sel, ic);
          this.onReady?.();
        });
    }
    return null;
  }

  paint(g: Gfx, p: PersonSim): void {
    const ctx = g.ctx;
    this.actions(p).forEach((a, i) => {
      const x = g.ox + ORIGIN_X + i * STEP;
      const y = g.oy + ORIGIN_Y;
      ctx.save();
      if (a.flags & 0x100) ctx.globalAlpha = 0.4;
      ctx.fillStyle = "rgb(0, 40, 140)";
      ctx.fillRect(x, y, SIZE, SIZE);
      const o = p.module.getObject(a.icon) ?? p.module.getObject(a.target);
      const ic = o && !o.isPerson ? this.icon(o.obj.selector) : null;
      if (ic) {
        ctx.beginPath();
        ctx.rect(x + 2, y + 2, SIZE - 4, SIZE - 4);
        ctx.clip();
        ic.draw(ctx, x + 2, y + 2, SIZE - 4, SIZE - 4);
      }
      ctx.restore();
      ctx.strokeStyle = i === 0 && p.currentAction === a ? "rgb(255, 255, 255)" : "rgb(165, 195, 214)";
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, SIZE - 1, SIZE - 1);
    });
  }

  /** The action under (x, y) (lot view coordinates), or null. */
  hit(p: PersonSim, x: number, y: number): Interaction | null {
    if (y < ORIGIN_Y || y >= ORIGIN_Y + SIZE) return null;
    const list = this.actions(p);
    const i = Math.floor((x - ORIGIN_X) / STEP);
    if (i < 0 || i >= list.length || x - ORIGIN_X - i * STEP >= SIZE) return null;
    return list[i]!;
  }
}
