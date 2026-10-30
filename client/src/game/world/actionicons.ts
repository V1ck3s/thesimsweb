/**
 * The selected sim's action icons: cActionIcon windows (children of the lot
 * view, cDDDSimsView) and the cDDDSimsView code that lays them out
 * (UpdateActionIcons, DeleteActionIcon, ClearActionIcons, StartUserAction).
 *
 * PersonFinder::GetPersonActions lists the current action then the queued
 * ones; ConvertAction skips an action without an icon object (Interaction
 * +0xc) and pictures it with:
 *  - a person: PersonFinder::GetPictureBuffer, the 4 x 3 people button
 *    (BuildPersonBtn of the face BMP_ 2002);
 *  - an object: the master selector's catalog Product::ComposeBtnImage, the
 *    catalog template's first frame with the product picture (the object
 *    file's BMP_, else RenderCatalogShot) centered on it; no product leaves
 *    the icon without a picture: a dark grey square.
 * PersonAction +8 picks the frame half: the queued actions and a current
 * one whose person data 0x27 is clear get the plain frame, else the yellow
 * ring.
 *
 * cActionIcon::MakeActionBitmap draws a 45 x 45 picture: the source's cell
 * (column 0, row 1 of a 3 row image), then kIconFrame's half; the frame's
 * blue is its transparent color and its magenta corners become transparent
 * with the picture's own color key (CtrlMgr color 0). TSPaint blits it, with
 * kQueueCancelOverlay (the red cross) once the action is cancelled.
 *
 * Icons sit at (0x20 + 0x32 i, 0x20); one whose slot changes slides there in
 * 500 ms (StartAnimating, a constant time ramp); the icon of an action the
 * user just picked starts at the click (StartUserAction, cursor - 0x10). A
 * click (left or right) on an icon that is not sliding cancels its action
 * (PersonFinder::DeletePersonAction -> cXPerson::RemoveAction): "UI_queue_delete",
 * or "UI_error" when it fails or the selected sim is a pet. Each new icon
 * plays "UI_queued".
 */

import { composeBtnImage, generateGraphics } from "../cpanel/buy/objecticon.js";
import type { GameContext } from "../context.js";
import { soundPlayer, UI_SOURCE } from "../audio/index.js";
import { UI } from "../audio/uisound.js";
import { buildPersonBtn } from "../cpanel/live/peoplebuttons.js";
import { PDX, type Interaction, type PersonSim } from "../sim/person.js";
import type { SimObject } from "../sim/xobject.js";
import { getStandardCursor } from "../ui/cursor.js";
import { loadPicture } from "../ui/phonebook.js";
import { Gfx, TSWin } from "../ui/tswin.js";
import type { ObjSelector } from "./objselector.js";

/** cActionIcon's square (0x2d). */
const SIZE = 0x2d;
/** UpdateActionIcons: the first slot and the step between slots. */
const ORIGIN_X = 0x20;
const ORIGIN_Y = 0x20;
const STEP = 0x32;
/** StartAnimating's default duration (lbl_105BA75C). */
const SLIDE_MS = 500;
/** cActionIcon::Init: MakeFillColor(0x28, 0x28, 0x28), painted without a picture. */
const FILL = "rgb(40, 40, 40)";
/** BMP_ 2002 of a character file: its faces. */
const BMP_FACE = 2002;

/** The shared bitmaps (lbl_105BA758 kIconFrame, lbl_105BA760 kQueueCancelOverlay, CleanUp frees them). */
interface IconParts {
  /** kIconFrame without its blue and magenta. */
  frame: OffscreenCanvas;
  /** kIconFrame's magenta corners (opaque where the icon becomes transparent). */
  holes: OffscreenCanvas;
  cancel: ImageBitmap | null;
}

/** cActionIcon::MakeActionBitmap's source cell: columns by width, rows (and the row used) by height. */
function sourceCell(src: CanvasImageSource & { width: number; height: number }): { sw: number; sy: number; sh: number } {
  const cols = src.width === 0xb4 ? 4 : src.width === 0x10e ? 6 : 1;
  const rows = src.height === 0x87 ? 3 : 1;
  const row = src.height === 0x87 ? 1 : 0;
  const sh = Math.trunc(src.height / rows);
  return { sw: Math.trunc(src.width / cols), sy: sh * row, sh };
}

/**
 * cActionIcon (a cTSWin): one action of the selected person's queue.
 * Offsets: +0xd0 bitmap, +0xd4 source picture, +0xe8 sliding, +0xe9
 * cancelled, +0xec..+0xf8 slide from / to, +0xfc seen by the last update,
 * +0xfd placed, +0x100 action id, +0x104 person, +0x118 plain frame.
 */
export class ActionIcon extends TSWin {
  private picture: (CanvasImageSource & { width: number; height: number }) | null = null;
  private bitmap: OffscreenCanvas | null = null;
  private bitmapKey = "";
  animating = false;
  cancelled = false;
  seen = false;
  placed = false;
  private from = { x: 0, y: 0 };
  to = { x: 0, y: 0 };
  private rampStart = 0;
  private rampEnd = 0;
  action: Interaction | null = null;
  private person: PersonSim | null = null;
  plainFrame = true;

  constructor(
    private readonly parts: () => IconParts | null,
    action: Interaction | null,
    person: PersonSim | null,
  ) {
    super();
    // cActionIcon::Init: at (5, 5).
    this.setArea(5, 5, 5 + SIZE, 5 + SIZE);
    this.winCursor = getStandardCursor(4);
    this.setAction(action, person);
  }

  /** cActionIcon::SetAction: a fresh icon for `action` (null clears it). */
  setAction(action: Interaction | null, person: PersonSim | null): void {
    this.picture = null;
    this.bitmapKey = "";
    this.animating = false;
    this.cancelled = false;
    this.seen = false;
    this.placed = false;
    this.plainFrame = true;
    this.action = action;
    this.person = action ? person : null;
    this.setIcon(null);
    if (action) {
      this.cancelled = (action.flags & 0x100) !== 0;
      this.tooltip = action.name;
    } else {
      this.tooltip = "";
    }
  }

  /**
   * cActionIcon::SetIcon: the window takes the source's cell size (45 x 45
   * for the sizes MakeActionBitmap knows; others are dropped).
   */
  setIcon(picture: (CanvasImageSource & { width: number; height: number }) | null): void {
    const known = picture && (picture.width === SIZE || picture.width === 0xb4 || picture.width === 0x10e) && (picture.height === SIZE || picture.height === 0x87);
    if (picture !== this.picture) this.bitmapKey = "";
    this.picture = known ? picture : null;
    const { left, top } = this.area;
    this.setArea(left, top, left + SIZE, top + SIZE);
  }

  /** cActionIcon::MoveIcon: straight to (x, y). */
  moveIcon(x: number, y: number): void {
    this.from = { x, y };
    this.to = { x, y };
    this.animating = false;
    this.placed = true;
    this.setArea(x, y, x + SIZE, y + SIZE);
  }

  /** cActionIcon::StartAnimating: slides from where it is to (x, y) in `ms`. */
  startAnimating(x: number, y: number, now: number, ms = SLIDE_MS): void {
    this.from = { x: this.area.left, y: this.area.top };
    this.to = { x, y };
    this.animating = true;
    this.placed = true;
    this.rampStart = now;
    this.rampEnd = now + ms;
  }

  /** cActionIcon::AnimateIcon: from * (1 - v) + to * v + 0.5, v the ramp 0 -> 1. */
  animateIcon(now: number): void {
    if (!this.animating) return;
    if (now < this.rampEnd) {
      const v = Math.fround(1 - Math.fround((this.rampEnd - now) / (this.rampEnd - this.rampStart)));
      const x = Math.trunc(0.5 + this.to.x * v + this.from.x * (1 - v));
      const y = Math.trunc(0.5 + this.to.y * v + this.from.y * (1 - v));
      this.setArea(x, y, x + SIZE, y + SIZE);
    } else {
      this.setArea(this.to.x, this.to.y, this.to.x + SIZE, this.to.y + SIZE);
      this.animating = false;
    }
  }

  /**
   * cActionIcon::MakeActionBitmap(source, plain frame): the source's cell
   * over a transparent 45 x 45 buffer, then the frame half (the yellow one
   * when `plain` is false). Kept until the source or the frame changes.
   */
  private makeActionBitmap(): OffscreenCanvas | null {
    const src = this.picture;
    const parts = this.parts();
    if (!src || !parts) return null;
    const key = this.plainFrame ? "plain" : "ring";
    if (this.bitmap && this.bitmapKey === key) return this.bitmap;
    const c = (this.bitmap ??= new OffscreenCanvas(SIZE, SIZE));
    const g = c.getContext("2d")!;
    g.clearRect(0, 0, SIZE, SIZE);
    const { sw, sy, sh } = sourceCell(src);
    // cTSBuffer::Blt clips to the destination, it does not stretch.
    const w = Math.min(sw, SIZE);
    const h = Math.min(sh, SIZE);
    g.drawImage(src, 0, sy, w, h, 0, 0, w, h);
    const fx = this.plainFrame ? 0 : SIZE;
    g.globalCompositeOperation = "destination-out";
    g.drawImage(parts.holes, fx, 0, SIZE, SIZE, 0, 0, SIZE, SIZE);
    g.globalCompositeOperation = "source-over";
    g.drawImage(parts.frame, fx, 0, SIZE, SIZE, 0, 0, SIZE, SIZE);
    this.bitmapKey = key;
    return c;
  }

  /** cActionIcon::TSPaint */
  override tsPaint(g: Gfx): void {
    const bmp = this.makeActionBitmap();
    if (!bmp) {
      g.fill(0, 0, this.getW(), this.getH(), FILL);
      return;
    }
    g.blit(bmp, 0, 0);
    const cancel = this.parts()?.cancel;
    if (this.cancelled && cancel) g.blit(cancel, 0, 0);
  }

  /**
   * cActionIcon::TSOnMouseDownL / R: unless sliding, a pet's queue (person
   * data 0x41 above 1, without the lbl_105BA34C debug flag) refuses, else
   * the first click cancels the action (PersonFinder::DeletePersonAction).
   */
  private cancelAction(): boolean {
    if (this.animating) return true;
    const p = this.person;
    if (p && p.pd[PDX.gender]! > 1) {
      soundPlayer.playBySource(UI.error, UI_SOURCE);
    } else if (!this.cancelled) {
      this.cancelled = true;
      const ok = !!p && !!this.action && p.removeAction(this.action);
      soundPlayer.playBySource(ok ? UI.queueDelete : UI.error, UI_SOURCE);
    }
    return true;
  }

  override tsOnMouseDownL(): boolean {
    return this.cancelAction();
  }

  override tsOnMouseDownR(): boolean {
    return this.cancelAction();
  }
}

/** One entry of PersonFinder::GetPersonActions (PersonAction). */
interface PersonAction {
  action: Interaction;
  /** +4: the picture (null: none). */
  picture: (CanvasImageSource & { width: number; height: number }) | null;
  /** +8: plain frame. */
  plainFrame: boolean;
}

/** cDDDSimsView's action icon part. */
export class ActionIcons {
  /** cDDDSimsView +0x45b: the icons in queue order; +0x45e: the spare ones. */
  private icons: ActionIcon[] = [];
  private readonly spare: ActionIcon[] = [];
  /** +0x461..+0x465: the action StartUserAction announced and the cursor there. */
  private userAction: { action: Interaction; x: number; y: number } | null = null;
  private parts: IconParts | null = null;
  private partsLoading = false;
  private template: ImageBitmap | null = null;
  private peopleTemplate: ImageBitmap | null = null;
  /** Product::ComposeBtnImage of a master selector / the people button of a person (null: none). */
  private readonly pictures = new Map<ObjSelector | number, ImageBitmap | null>();
  private readonly loading = new Set<ObjSelector | number>();

  constructor(
    private readonly ctx: GameContext,
    private readonly view: TSWin,
  ) {}

  /** kIconFrame (its blue keyed out, the magenta corners kept apart), kQueueCancelOverlay and the button templates. */
  private async loadParts(): Promise<void> {
    const res = this.ctx.res;
    const [frame, cancel, template, peopleTemplate] = await Promise.all([
      res.image("kIconFrame"),
      res.image("kQueueCancelOverlay").catch(() => null),
      res.image("kCatalogTemplate").catch(() => null),
      res.image("kPeopleTemplate").catch(() => null),
    ]);
    const art = new OffscreenCanvas(frame.width, frame.height);
    const holes = new OffscreenCanvas(frame.width, frame.height);
    const g = art.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(frame, 0, 0);
    const img = g.getImageData(0, 0, art.width, art.height);
    const mask = new ImageData(art.width, art.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      // UIRes keyed the magenta already: those are the corners.
      if (d[i + 3] === 0) mask.data[i + 3] = 255;
      if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 255) d[i + 3] = 0;
    }
    g.putImageData(img, 0, 0);
    holes.getContext("2d")!.putImageData(mask, 0, 0);
    this.template = template;
    this.peopleTemplate = peopleTemplate;
    this.parts = { frame: art, holes, cancel };
  }

  /** The picture of an icon object (PersonFinder::ConvertAction), loaded on first use. */
  private pictureOf(o: SimObject): ImageBitmap | null {
    const sel = o.obj.selector;
    const key: ObjSelector | number = o.isPerson ? o.obj.selector.guid | 0 : sel.getMasterSelector();
    if (this.pictures.has(key)) return this.pictures.get(key)!;
    if (!this.loading.has(key) && this.parts) {
      this.loading.add(key);
      void (o.isPerson ? this.personPicture(o) : this.productPicture(key as ObjSelector))
        .catch(() => null)
        .then((pic) => {
          this.pictures.set(key, pic);
          this.loading.delete(key);
        });
    }
    return null;
  }

  /**
   * PersonFinder::GetPictureBuffer: BuildPersonBtn of the person's faces
   * (the neighbor's, else the BMP_ 2002 of its character file).
   */
  private async personPicture(o: SimObject): Promise<ImageBitmap | null> {
    const template = this.peopleTemplate;
    if (!template) return null;
    const st = this.ctx.state;
    const guid = o.obj.selector.guid | 0;
    const info = [...st.family, ...st.neighbors].find((q) => q.guid !== undefined && (q.guid | 0) === guid);
    if (info?.face) return buildPersonBtn(info.face, template);
    const bytes = o.obj.selector.res.get("BMP_", BMP_FACE);
    return bytes ? loadPicture(bytes, template) : null;
  }

  /**
   * Product::ComposeBtnImage of the master selector's catalog product
   * (Catalog::Init makes one for every selector that is neither a
   * multi-tile part nor a person).
   */
  private async productPicture(master: ObjSelector): Promise<ImageBitmap | null> {
    const template = this.template;
    if (!template || master.getIsMultiTileSubObject() || master.getIsPerson()) return null;
    const picture = await generateGraphics(master.res, master.objdId, master.objd.i16(0x52), master.getHasGraphics(), template);
    return composeBtnImage(template, picture);
  }

  /** PersonFinder::GetPersonActions: the current action, then the queue (actions without an icon object left out). */
  private personActions(p: PersonSim): PersonAction[] {
    const out: PersonAction[] = [];
    const convert = (a: Interaction, current: boolean): void => {
      const o = a.icon !== 0 ? p.module.getObject(a.icon) : null;
      if (!o) return;
      out.push({ action: a, picture: this.pictureOf(o), plainFrame: current ? p.pd[PDX.routingComplete] === 0 : true });
    };
    if (p.currentAction) convert(p.currentAction, true);
    for (const a of p.queue) convert(a, false);
    return out;
  }

  /** cDDDSimsView::StartUserAction: the picked action's icon will start at the cursor. */
  startUserAction(action: Interaction, x: number, y: number): void {
    this.userAction = { action, x, y };
    soundPlayer.playBySource(UI.queued, UI_SOURCE);
  }

  /**
   * cDDDSimsView::UpdateActionIcons (every frame, cDDDSimsView::Draw):
   * outside Live mode the icons leave the view; in Live mode, the icons
   * of actions still listed are refreshed, new actions get an icon (a spare
   * one when there is one), the others go (DeleteActionIcon), then each
   * icon moves or slides to its slot.
   */
  update(person: PersonSim | null, live: boolean, now: number): void {
    const view = this.view;
    if (!live) {
      for (const ic of this.icons) if (ic.parent === view) view.childRemove(ic);
      return;
    }
    if (!this.parts) {
      if (!this.partsLoading) {
        this.partsLoading = true;
        void this.loadParts().catch(() => {
          this.partsLoading = false;
        });
      }
    }
    for (const ic of this.icons) if (ic.parent !== view) view.childAdd(ic);
    const actions = person ? this.personActions(person) : [];
    for (const ic of this.icons) ic.seen = false;
    const order: ActionIcon[] = [];
    for (const pa of actions) {
      let ic = this.icons.find((i) => i.action === pa.action);
      if (ic) {
        ic.seen = true;
        ic.setIcon(pa.picture);
        ic.plainFrame = pa.plainFrame;
        ic.tooltip = pa.action.name;
        order.push(ic);
        continue;
      }
      ic = this.spare.pop();
      if (ic) {
        ic.setAction(pa.action, person);
        ic.showWindow();
      } else {
        ic = new ActionIcon(() => this.parts, pa.action, person);
      }
      view.childAdd(ic);
      ic.setIcon(pa.picture);
      ic.plainFrame = pa.plainFrame;
      this.icons.push(ic);
      soundPlayer.playBySource(UI.queued, UI_SOURCE);
      const u = this.userAction;
      if (u && u.action === pa.action) {
        this.userAction = null;
        ic.moveIcon(u.x - 0x10, u.y - 0x10);
        ic.placed = true;
      } else {
        ic.placed = false;
      }
      ic.seen = true;
      order.push(ic);
    }
    for (const ic of this.icons.filter((i) => !i.seen)) this.deleteActionIcon(ic);
    this.icons = [];
    let x = ORIGIN_X;
    for (const ic of order) {
      if (!ic.placed) ic.moveIcon(x, ORIGIN_Y);
      else if (ic.animating ? ic.to.x !== x || ic.to.y !== ORIGIN_Y : ic.area.left !== x || ic.area.top !== ORIGIN_Y) ic.startAnimating(x, ORIGIN_Y, now);
      this.icons.push(ic);
      x += STEP;
    }
    for (const ic of this.icons) ic.animateIcon(now);
  }

  /** cDDDSimsView::DeleteActionIcon: out of the view, kept as a spare. */
  private deleteActionIcon(ic: ActionIcon): void {
    if (ic.parent === this.view) this.view.childRemove(ic);
    ic.hideWindow();
    ic.setIcon(null);
    this.icons = this.icons.filter((i) => i !== ic);
    this.spare.push(ic);
  }

  /** cDDDSimsView::ClearActionIcons (cDDDSimsView::CleanUp). */
  clear(): void {
    for (const ic of [...this.icons, ...this.spare]) {
      if (ic.parent === this.view) this.view.childRemove(ic);
      ic.shutdown();
    }
    this.icons = [];
    this.spare.length = 0;
  }
}
