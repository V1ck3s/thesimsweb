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
 *    SetCameraPosition(2, 0, 0, 0)), ambient light white, AnimatePet;
 *  - BuildAdult / Child / Cat / DogAnimationList (lbl_105BC78C): the skills
 *    the preview plays one after the other (+0x218, 0x104 bytes each; +0x214
 *    the last index); AnimatePet starts at the first one (a cat at index 8)
 *    on the first paint, then, when the practice is done (+0x3c), plays the
 *    next one (wrapping), once each (+0x40 looping := 0).
 *
 * The outfit itself is SAnimator::UpdateOutfitAndHands (sims/outfit.ts) on
 * the copy's person data, costumes included.
 */

import { LoopMode, SAnimator, SimRenderer, type SimView } from "../sims/index.js";
import { mat4Mul, rotationTf, translationTf, type Mat4, type Vec3 } from "../sims/math3d.js";
import { Gfx, TSWin } from "../ui/tswin.js";
import { EditPerson, type OutfitKind } from "./editperson.js";

/** lbl_105BC77C: [0.25, 32767, 0.5] (rotation base in pi units, unprojected depth). */
const TURN = 0.25;
const DEPTH = 32767;
const PERIOD_MS = 10000;

/** SAnimator::Outfit -> the EditPerson list NextSuit / PreviousSuit / GetCurrentSuitIndex step (jump tables lbl_105BC780..788). */
const OUTFITS: ReadonlyMap<number, OutfitKind> = new Map([
  [0, "body"],
  [2, "swimwear"],
  [4, "formal"],
  [5, "lingerie"],
  [0x11, "winter"],
  [0x12, "fashion"],
]);

/** Person data 65 (cXPerson +0x60e): bit 2 dog, bit 4 cat; 58 (+0x600) the age; 8 (+0x59c) the outfit. */
const PD_GENDER = 65;
const PD_AGE = 58;
const PD_OUTFIT = 8;

/** The preview animation lists (lbl_105BC78C). */
const ADULT_ANIMS = (male: boolean): string[] => [
  "a2o-heyyou1",
  "a2o-idle-armsdown-breathe",
  "a2o-mirror-admire-self-start",
  male ? "a2o-mirror-admire-self-loop2" : "a2o-mirror-admire-self-loop1",
  "a2o-mirror-admire-self-approve",
  "a2o-idle-armsdown-breathe",
  "a2o-idle-armsdown-breathe",
  "a2o-celebrate-short",
  "a2o-idle-armsdown-breathe",
  "a2o-idle-armsdown-breathe",
];
const CHILD_ANIMS = [
  "c2o-heyyou1",
  "c2o-idle-armsdown-breathe",
  "c2o-idle-armsdown-breathe",
  "c2o-mirror-admire-self-start",
  "c2o-mirror-admire-self-loop2",
  "c2o-mirror-admire-self-approve",
  "c2o-idle-armsdown-breathe",
  "c2o-idle-armsdown-breathe",
  "c2o-happy-clap",
  "c2o-idle-armsdown-breathe",
  "c2o-idle-armsdown-breathe",
  "c2o-idle-armsdown-breathe",
];
const CAT_ANIMS = [
  "k2o-stand-tailswish-loop-fast",
  "k2o-hiss-start",
  "k2o-hiss-loop",
  "k2o-hiss-sizing-up",
  "k2o-hiss-rhow-angry-one",
  "k2o-hiss-rhow-angry-long-low",
  "k2o-hiss-rhow-angry-long-high",
  "k2o-hiss-stop",
  "k2o-napfloor-stand-trans-sit",
  "k2o-sit-chase-tail-start",
  "k2o-sit-chase-tail-slow-loop",
  "k2o-sit-chase-tail-stop",
  "k2o-cleanself-start",
  "k2o-cleanself-fidget",
  "k2o-cleanself-cleanself-r-start",
  "k2o-cleanself-cleanself-r-pawlickslow",
  "k2o-cleanself-cleanself-r-pawlickchew",
  "k2o-cleanself-cleanself-r-flickear",
  "k2o-cleanself-cleanself-r-scratchnose",
  "k2o-cleanself-cleanself-r-stop",
  "k2o-napfloor-sit-trans-stand",
];
const DOG_ANIMS = [
  "d2o-sit-wag",
  "d2o-sit-wag-loop-slow",
  "d2o-sit-wag-stop",
  "d2o-sit-bark-start",
  "d2o-sit-bark",
  "d2o-sit-bark-stop",
  "d2o-napfloor-sit-trans-stand",
  "d2o-circle-start",
  "d2o-circle-fascinated",
  "d2o-circle-stop",
  "d2o-napfloor-stand-trans-sit",
  "d2o-sit-chase-tail-start",
  "d2o-sit-chase-tail-slow-loop",
  "d2o-sit-chase-tail-stop",
  "d2o-sit-scratchears-l-start",
  "d2o-sit-scratchears-l-loop-fast",
  "d2o-sit-scratchears-l-loop-flick",
  "d2o-sit-scratchears-l-stop",
];

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
  /** The copy's person data (MakeNewOutOfWorldObject's person). */
  private pd = new Int16Array(0x100);
  /** +0x218.. the animation list (+0x214: its last index), +0x210 the one playing (-1: none yet), +0x18c first paint. */
  private anims: readonly string[] = [];
  private animIndex = -1;
  private animFirst = false;
  /** A skill of the list is loading (VBAnimMgr::FindSkill is synchronous in the original). */
  private animLoading = false;
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
    this.pd = personData.slice();
    const gender = this.pd[PD_GENDER]! & 0xffff;
    this.dog = (gender & 2) !== 0;
    this.cat = !this.dog && (gender & 4) !== 0;
    this.outfit = outfit;
    this.pd[PD_OUTFIT] = outfit;
    this.editPerson = await EditPerson.begin(bodyStrings, this.pd.slice());
    this.person = await SAnimator.fromBodyStrings(this.editPerson.bodyStrings());
    if (!this.person) return;
    await this.person.updateOutfitAndHands({ pd: this.pd }, true);
    const age = this.pd[PD_AGE]!;
    if (this.dog) this.anims = DOG_ANIMS;
    else if (this.cat) this.anims = CAT_ANIMS;
    else if (age !== 0 && age < 0x12) this.anims = CHILD_ANIMS;
    else this.anims = ADULT_ANIMS(gender === 0);
    this.animIndex = -1;
    this.animFirst = true;
  }

  /** cWinVitaBtnSolo::SetOutfit: person data 8 := outfit, then UpdateOutfitAndHands. */
  async setOutfit(outfit: number): Promise<void> {
    this.outfit = outfit;
    this.pd[PD_OUTFIT] = outfit;
    await this.person?.updateOutfitAndHands({ pd: this.pd });
  }

  /** cWinVitaBtnSolo::GetCurrentSuitIndex */
  getCurrentSuitIndex(): number {
    const kind = OUTFITS.get(this.outfit);
    if (!this.editPerson || !kind) return -1;
    return this.editPerson.getOutfitSuit(kind);
  }

  /** cWinVitaBtnSolo::NextSuit */
  nextSuit(): void {
    this.stepSuit(true);
  }

  /** cWinVitaBtnSolo::PreviousSuit */
  previousSuit(): void {
    this.stepSuit(false);
  }

  /** EditPerson::SetToNext / PreviousValid<Kind>SuitForBodyType, then the person dressed from the edited strings. */
  private stepSuit(forward: boolean): void {
    const kind = OUTFITS.get(this.outfit);
    const ep = this.editPerson;
    if (!ep || !kind) return;
    ep.setToNextValidSuitForBodyType(kind, forward, true);
    void this.person?.setBodyStrings(ep.bodyStrings());
  }

  /** cWinVitaBtnSolo::AnimatePet (people and pets alike): the list's skills one after the other. */
  private animatePet(): void {
    const p = this.person;
    if (!p || this.animLoading || this.anims.length === 0) return;
    if (this.animFirst) {
      this.animFirst = false;
      if (this.animIndex === -1) this.animIndex = this.cat ? 8 : 0;
    } else {
      const cur = p.vitaboy.practices[0];
      if (this.animIndex === -1 || (cur && !cur.finished)) return;
      this.animIndex = this.animIndex + 1 > this.anims.length - 1 ? 0 : this.animIndex + 1;
    }
    this.animLoading = true;
    void p.startSkill(this.anims[this.animIndex]!, LoopMode.Hold).finally(() => {
      this.animLoading = false;
    });
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
    this.animatePet();
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
