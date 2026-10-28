/**
 * cWinVitaBtnSolo: the turning 3D person of the outfit, pet and transform
 * dialogs (cWinClothingChoiceDlg, cWinPetSelectDlg, cWinTransformMeDlg),
 * shown in one outfit and able to step through the suits of that outfit.
 *
 * From the decompiled class:
 *  - the constructor takes the scale (lbl_105BCB50 = 3.25 for clothing,
 *    lbl_105BD1C8 = 3.25 for transform, lbl_105BCC18 = 5.0 for pets);
 *    Init starts the same sine generator as cWinVitaBtn (amplitude
 *    pi * 0.25, period 10 s);
 *  - SetPerson: a copy of the person (MakeNewOutOfWorldObject) wearing the
 *    outfit (person data 8 := outfit, SAnimator::UpdateOutfitAndHands), an
 *    EditPerson begun on its body strings; dogs (+0x60e bit 2) and cats
 *    (bit 4) are pets, a person aged 1..17 a child;
 *  - NextSuit / PreviousSuit / GetCurrentSuitIndex: by outfit (jump tables
 *    lbl_105BC780 / 784 / 788): 0 body, 2 swimwear, 4 formal, 5 lingerie,
 *    0x11 winter, 0x12 fashion -> EditPerson::SetToNextValid<Kind>Suit
 *    ForBodyType / SetToPreviousValid..., Get<Kind>Suit (-1 otherwise);
 *  - UpdateTransform: people RotationTf(Y, pi * 0.25 + sine) * ScaleTf *
 *    TranslationTf(the point (horizontal center, bottom - 0x14) at depth
 *    32767 back in world space); pets are not turned and stand at
 *    (center - 0x14, bottom - 0x32);
 *  - TSPaint: the camera at zoom 2, rotation 0 (cAnimDeviceSub::
 *    SetCameraPosition(2, 0, 0, 0)), ambient light white.
 *
 * Simplifications: the animation lists (BuildAdultAnimationList ...,
 * AnimatePet) are replaced by the skeleton's standing idle; the costumes of
 * SAnimator::UpdateOutfitAndHands' outfits 6.. (job, skeleton, Magic Town
 * and Studio Town costumes built from cXPerson / string tables) are not
 * ported: those outfits show the body suit.
 */

import { BodyStrings, BS, SAnimator, SimRenderer, type SimView } from "../sims/index.js";
import { mat4Mul, rotationTf, translationTf, type Mat4, type Vec3 } from "../sims/math3d.js";
import { Gfx, TSWin } from "../ui/tswin.js";
import { EditPerson, type OutfitKind } from "./editperson.js";

/** lbl_105BC77C: [0.25, 32767, 0.5] (rotation base in pi units, unprojected depth). */
const TURN = 0.25;
const DEPTH = 32767;
const PERIOD_MS = 10000;

/** SAnimator::Outfit -> the EditPerson list and body string entry (UpdateOutfitAndHands' jump table lbl_105BC880). */
const OUTFITS: ReadonlyMap<number, { kind: OutfitKind; entry: number }> = new Map([
  [0, { kind: "body", entry: BS.body }],
  [2, { kind: "swimwear", entry: 0x20 }],
  [4, { kind: "formal", entry: 0x1f }],
  [5, { kind: "lingerie", entry: 0x21 }],
  [0x11, { kind: "winter", entry: 0x22 }],
  [0x12, { kind: "fashion", entry: 0x23 }],
]);

/** Person data 65 (cXPerson +0x60e): bit 2 dog, bit 4 cat. */
const PD_GENDER = 65;

function scaleTf(s: number): Mat4 {
  const m = new Float32Array(16);
  m[0] = s;
  m[5] = s;
  m[10] = s;
  m[15] = 1;
  return m;
}

export class WinVitaBtnSolo extends TSWin {
  private person: SAnimator | null = null;
  /** +0x19c */
  private editPerson: EditPerson | null = null;
  /** +0x1a0 */
  outfit = 0;
  /** +0x208 dog, +0x209 cat, +0x20a adult, +0x20b child. */
  private dog = false;
  private cat = false;
  private canvas: HTMLCanvasElement | null = null;
  private renderer: SimRenderer | null = null;
  private start = 0;

  constructor(readonly scale: number) {
    super();
  }

  override async init(): Promise<boolean> {
    this.start = performance.now();
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (gl) {
      this.canvas = canvas;
      this.renderer = await SimRenderer.create(gl);
    }
    return true;
  }

  /** cWinVitaBtnSolo::SetPerson: the person's body strings and person data (copied), in `outfit`. */
  async setPerson(bodyStrings: readonly string[], personData: Int16Array, outfit: number): Promise<void> {
    const gender = personData[PD_GENDER]! & 0xffff;
    this.dog = (gender & 2) !== 0;
    this.cat = !this.dog && (gender & 4) !== 0;
    this.editPerson = await EditPerson.begin(bodyStrings, personData.slice());
    this.person = await SAnimator.fromBodyStrings(this.editPerson.bodyStrings());
    if (!this.person) return;
    await this.person.startIdle();
    await this.setOutfit(outfit);
  }

  /** cWinVitaBtnSolo::SetOutfit: person data 8 := outfit, then UpdateOutfitAndHands. */
  async setOutfit(outfit: number): Promise<void> {
    this.outfit = outfit;
    await this.redress();
  }

  /** SAnimator::UpdateOutfitAndHands with the edited body strings. */
  private async redress(): Promise<void> {
    const p = this.person;
    const ep = this.editPerson;
    if (!p || !ep) return;
    const bs = new BodyStrings(ep.bodyStrings());
    const entry = OUTFITS.get(this.outfit)?.entry ?? BS.body;
    const slots: Array<[string, number]> = [
      ["head", BS.head],
      ["body", entry],
      ["lhand", BS.leftHandOpen],
      ["rhand", BS.rightHandOpen],
    ];
    await Promise.all(
      slots.map(([slot, index]) => {
        let { suit, texture } = bs.getSuitAndTexture(index);
        if (slot === "body" && (!suit || suit === "added")) ({ suit, texture } = bs.getSuitAndTexture(BS.body));
        return suit && suit !== "none" ? p.vitaboy.dress(slot, suit, texture) : Promise.resolve(false);
      }),
    );
  }

  /** cWinVitaBtnSolo::GetCurrentSuitIndex */
  getCurrentSuitIndex(): number {
    const o = OUTFITS.get(this.outfit);
    if (!this.editPerson || !o) return -1;
    return this.editPerson.getOutfitSuit(o.kind);
  }

  /** cWinVitaBtnSolo::NextSuit */
  nextSuit(): void {
    this.stepSuit(true);
  }

  /** cWinVitaBtnSolo::PreviousSuit */
  previousSuit(): void {
    this.stepSuit(false);
  }

  private stepSuit(forward: boolean): void {
    const o = OUTFITS.get(this.outfit);
    if (!this.editPerson) return;
    if (o) this.editPerson.setToNextValidSuitForBodyType(o.kind, forward, true);
    void this.redress();
  }

  private view(): SimView {
    return { zoom: 2, rotation: 0, originX: 0, originY: 0, width: this.getW(), height: this.getH() };
  }

  /** cWinVitaBtnSolo::UpdateTransform */
  private updateTransform(now: number): Mat4 {
    const pet = this.dog || this.cat;
    let rot: Mat4 | null = null;
    if (!pet) {
      const sine = TURN * Math.PI * Math.sin((2 * Math.PI * (now - this.start)) / PERIOD_MS);
      rot = rotationTf(1, Math.fround(Math.PI * TURN + sine));
    }
    const feet = pet ? 0x32 : 0x14;
    const dx = pet ? -0x14 : 0;
    const cam = this.renderer!.cameraFor(this.view());
    // cAnimDeviceSub+0xa4: screen (x, y, depth) back to world space (orthographic camera).
    const a = (this.getW() / 2 + dx - (this.getW() >> 1)) * cam.upp;
    const b = ((this.getH() >> 1) - (this.getH() - feet)) * cam.upp;
    const c = ((DEPTH / 65535) * cam.projection[15]!) / cam.projection[10]!;
    const p: Vec3 = [0, 1, 2].map((i) => cam.eye[i]! + a * cam.camX[i]! + b * cam.camY[i]! + c * cam.camZ[i]!) as Vec3;
    const st = scaleTf(this.scale);
    return mat4Mul(rot ? mat4Mul(rot, st) : st, translationTf(p));
  }

  override tsPaint(g: Gfx): void {
    const person = this.person;
    const r = this.renderer;
    const canvas = this.canvas;
    if (!person || !r || !canvas) return;
    const w = this.getW();
    const h = this.getH();
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const now = performance.now();
    person.update(now);
    const gl = r.gl;
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    r.renderSimModel(person.vitaboy, this.updateTransform(now), this.view(), { ambient: 1 });
    g.ctx.drawImage(canvas, g.ox, g.oy);
  }
}
