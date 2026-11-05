/**
 * cWinDesignCharacter: the "Créer un Sim" screen (first name, biography,
 * adult / child, gender, skin tone, head and body cycling, the 3D preview,
 * the five personality bars with their 25 points and the star sign).
 *
 * From the decompiled class (WinDesignCharacter.cpp):
 *  - Init: background kDesignCharBkg centered in the window (+0x104/+0x108
 *    = the offset every position below is shifted by), the rest filled with
 *    the dialog color (TSPaint: PaintInsetDlgBorder); 11 bitmap buttons
 *    (lbl_105BC708, 4 frames, at the local_130 positions, tooltips STR# 130
 *    entries 0..10), Done / Cancel as cTSSystemButtons with
 *    kNghDefaultBtn, 200 px wide, centered on (200, 0x211) and (600, 0x211)
 *    (captions 11, 12); title (entry 15, size 16 font, centered, 6 px from
 *    the top), the trait buttons (BuildPersonalityBtns), the first-name
 *    edit (size 10 font, white, one line, 25 characters, flashing frame
 *    while empty, (0x113, 0x34) + (0, 0, 0xff, 0x19)) and its label (entry
 *    26, right-aligned 20 px before it), the biography edit (0x800
 *    characters, (0x16, 0x1a9) + (0, 0, 0x2f9, 0x60)) and its label
 *    (entries 24 / 25, two lines above), "PERSONNALITE" (entry 16, at
 *    lbl_105BC6F8), the star-sign button ((0x81, 0x122)-(0xf9, 0x136),
 *    tooltip 27) and the cWinVitaBtn (scale 5, at (0x26a, 0x91), 100 x 220);
 *  - BuildPersonalityBtns: five cWinPersonalityWidgets (entries 17..21,
 *    max caption "     "), LEDs from (0xe4, 0x83) every 0x20 px, font size
 *    12 for French / German (lbl_105B9CD4+100 in 3..4), else 14;
 *  - PrepareButtons: SanifySuits when the age / gender / skin changed,
 *    head / body arrows shown when there are 2+ choices, Done enabled with
 *    a non-blank name and suits, radio states, the biography caption, the
 *    traits written to the person data (lbl_105BAAA4 = [7, 6, 3, 5, 2],
 *    value x 100) and the star sign (shown once a point is spent);
 *  - TSOnCommand: see tsOnCommand below (the index memory at +0x1b8 keeps
 *    the head / body choice per gender x age).
 *
 * Not ported: the "body strings cheat" text (PrintBodyStrings).
 */

import type { GameContext } from "../context.js";
import { PD } from "../data/neighborhood.js";
import { UI_LANGUAGE } from "../res/uires.js";
import type { SAnimator } from "../sims/index.js";
import { TSWinBtn } from "../ui/btn.js";
import { TSWinCtrlMgr } from "../ui/ctrlmgr.js";
import { GENDLG_FILL, TSWinGenDlg } from "../ui/gendlg.js";
import { IDYES, MB_YESNO, TSWinMsgBox } from "../ui/msgbox.js";
import { HILITE_COLORS_4, rgb } from "../ui/syscolors.js";
import { TSSystemButton } from "../ui/systembutton.js";
import { TSWinText } from "../ui/text.js";
import { TE_CHANGED, TE_ESCAPE, TE_TAB, TSWinTextEdit2 } from "../ui/textedit.js";
import { Gfx, TSWin } from "../ui/tswin.js";
import { winMgr } from "../ui/winmgr.js";
import type { EditPerson, PersonColor } from "./editperson.js";
import type { CasPerson, CasSession } from "./personfinder.js";
import { WinPersonalityWidget, type PersonalityOwner } from "./winpersonalitywidget.js";
import { WinVitaBtn } from "./winvitabtn.js";
import { computeZodiacSign, getSignFromName, getZodiacName, PD_ZODIAC, setZodiacSign } from "./zodiac.js";

const STRINGS = 130;
const S = {
  firstCaption: 11,
  pointsTitle: 13,
  pointsMessage: 14,
  title: 15,
  personality: 16,
  firstTrait: 17,
  bio: 24,
  bioOf: 25,
  nameLabel: 26,
  zodiacTip: 27,
} as const;

/** lbl_105BC708 and the local_130 positions (top-left; Done / Cancel: center). */
const BUTTONS: Array<{ image: number; x: number; y: number }> = [
  { image: 5028, x: 0x1f1, y: 0x65 }, // adult
  { image: 5029, x: 0x196, y: 0x6f }, // child
  { image: 5035, x: 499, y: 0x112 }, // female
  { image: 5036, x: 400, y: 0x112 }, // male
  { image: 5037, x: 499, y: 0xca }, // dark
  { image: 5038, x: 0x1c4, y: 0xca }, // medium
  { image: 5039, x: 0x18c, y: 0xca }, // light
  { image: 5030, x: 0x244, y: 0x123 }, // previous body
  { image: 5032, x: 0x2d9, y: 0x123 }, // next body
  { image: 5030, x: 0x255, y: 0xa0 }, // previous head
  { image: 5032, x: 0x2ca, y: 0xa0 }, // next head
];
const SYSTEM_BUTTONS = [
  { x: 200, y: 0x211 },
  { x: 600, y: 0x211 },
];
const B = {
  adult: 0,
  child: 1,
  female: 2,
  male: 3,
  dark: 4,
  medium: 5,
  light: 6,
  bodyPrev: 7,
  bodyNext: 8,
  headPrev: 9,
  headNext: 10,
  done: 11,
  cancel: 12,
} as const;
/** Command ids of the buttons (any non-zero value: cTSWinGenDlg ends on id 0). */
const BUTTON_ID_BASE = 0x5000;

/** lbl_105BC6E8: star-sign button. */
const ZODIAC_RECT = { left: 0x81, top: 0x122, right: 0xf9, bottom: 0x136 };
/** lbl_105BC6F8: "PERSONNALITE" anchor. */
const PERSONALITY_LABEL = { x: 0xc6, y: 0x72 };
/** lbl_105BC6FC + lbl_105BC6F0: first-name edit. */
const NAME_EDIT = { x: 0x113, y: 0x34, w: 0xff, h: 0x19 };
/** lbl_105BC700 + lbl_105BC6EC: biography edit. */
const BIO_EDIT = { x: 0x16, y: 0x1a9, w: 0x2f9, h: 0x60 };
/** lbl_105BC704: 3D preview; lbl_105BC6F4: its scale. */
const VITA = { x: 0x26a, y: 0x91, w: 100, h: 220, scale: 5 };
/** lbl_105BC70C: points-left bar. */
const POINTS_BAR = { x: 0x75, y: 0x156 };
/** lbl_105BC714 / lbl_105BC710: first LED and the step between traits. */
const TRAITS = { x: 0xe4, y: 0x83, step: 0x20 };
/** lbl_105BAAA4: person data fields of the five traits (neat, outgoing, active, playful, nice). */
const TRAIT_FIELDS = [PD.neatPersonality, PD.outgoingPersonality, PD.activePersonality, PD.playfulPersonality, PD.nicePersonality];
/** cWinDesignCharacter+0x11c initial value. */
const TOTAL_POINTS = 25;
/** lbl_105BC718 + 0x29 / + 0x2f. */
const MAX_CAPTION = "     ";
/** lbl_105BC718 + 0x49 / + 0x5b. */
const SOUND_CYCLE_PARTS = "UI_CAC_CycleParts";
const SOUND_CYCLE_HEAD = "UI_CAC_Cyclehead";
/** lbl_105BA94C, lbl_105BA928 (InitSimsColors). */
const DLG_FILL = rgb(0, 0x32, 0);
const WHITE = rgb(0xff, 0xff, 0xff);
/** Points LED: pixels per point. */
const POINT_STEP = 6;

const SKINS: Record<number, PersonColor> = { [B.dark]: "drk", [B.medium]: "med", [B.light]: "lgt" };

/** Who hears about a finished new person (SetMessageTarget; message {3, 0x1f, person}). */
export interface DesignCharacterTarget {
  personDesigned(p: CasPerson): void;
}

export class WinDesignCharacter extends TSWinGenDlg implements PersonalityOwner {
  /** +0x11c */
  pointsLeft = TOTAL_POINTS;
  /** +0x1a0: the family's last name (the biography caption). */
  familyName = "";
  private target: DesignCharacterTarget | null = null;
  private person: CasPerson | null = null;
  /** +0x118: designing a new person (deleted on cancel). */
  private isNew = true;
  private edit: EditPerson | null = null;
  /** +0x120: the design was ended (saved or not). */
  private ended = false;
  private bkg: ImageBitmap | null = null;
  private pointsImage: ImageBitmap | null = null;
  private offX = 0;
  private offY = 0;
  private readonly buttons: TSWinBtn[] = [];
  private readonly widgets: WinPersonalityWidget[] = [];
  private nameEdit: TSWinTextEdit2 | null = null;
  private bioEdit: TSWinTextEdit2 | null = null;
  private bioLabel: TSWinText | null = null;
  private zodiacBtn: TSWinBtn | null = null;
  private vita: WinVitaBtn | null = null;
  /** +0x16c / +0x168: body and head choice; +0x170 gender, +0x174 skin, +0x178 adult. */
  private bodyIndex = 0;
  private headIndex = 0;
  private gender = 0;
  private skin = 0;
  private adult = 1;
  /** +0x1b8: body / head choice per [gender * 4 + adult * 2 + (0 body, 1 head)]. */
  private readonly memory = new Array<number>(8).fill(0);
  /** +0x1b4: SanifySuits pending. */
  private sanify = true;
  private animatorSerial = 0;
  /** The person's instance as the preview shows it (the cXPerson's animator). */
  private instance: SAnimator | null = null;
  /** The instance being (re)created, until it shows. */
  private creating: Promise<void> | null = null;
  /** Instance work left for the end of the current command (a re-creation covers a suit reset). */
  private instanceWork: "create" | "reset" | null = null;
  private pointsTitle = "";
  private pointsMessage = "";
  private bioCaption = "";
  private bioFormat = "";

  constructor(
    ctx: GameContext,
    private readonly session: CasSession,
  ) {
    super(ctx, GENDLG_FILL);
  }

  /** cWinDesignCharacter::SetMessageTarget */
  setMessageTarget(t: DesignCharacterTarget): void {
    this.target = t;
  }

  /** cWinDesignCharacter::SetPerson: edit an existing person. */
  setPerson(p: CasPerson): void {
    this.person = p;
    this.isNew = false;
  }

  private str(i: number): string {
    return this.ctx.strings.get("UIText", STRINGS, i);
  }

  override async init(): Promise<boolean> {
    const { ctx } = this;
    this.fillColor = DLG_FILL;
    this.bkg = await ctx.res.image("kDesignCharBkg");
    const bw = this.bkg.width;
    const bh = this.bkg.height;
    this.offX = bw < this.getW() ? (this.getW() - bw) >> 1 : 0;
    this.offY = bh < this.getH() ? (this.getH() - bh) >> 1 : 0;
    await super.init();
    const ox = this.offX;
    const oy = this.offY;
    const mgr = await TSWinCtrlMgr.get(ctx);
    const sysImage = await ctx.res.image("kNghDefaultBtn");
    const fonts = {
      f10: await ctx.fonts.acquire(10),
      f12: await ctx.fonts.acquire(12),
      f14: await ctx.fonts.acquire(14),
      f16: await ctx.fonts.acquire(16),
    };

    for (let i = 0; i < 13; i++) {
      if (i < 11) {
        const def = BUTTONS[i]!;
        const img = await ctx.res.image(def.image);
        const b = new TSWinBtn(BUTTON_ID_BASE + i, img, 4, 1);
        const fw = Math.trunc(img.width / 4);
        b.setArea(def.x + ox, def.y + oy, def.x + ox + fw, def.y + oy + img.height);
        b.tooltip = this.str(i);
        this.childAdd(b);
        this.buttons.push(b);
      } else {
        const p = SYSTEM_BUTTONS[i - 11]!;
        const b = new TSSystemButton(mgr, sysImage);
        b.id = BUTTON_ID_BASE + i;
        this.childAdd(b);
        b.setArea(b.area.left, b.area.top, b.area.left + 200, b.area.top + sysImage.height);
        // cTSSystemButton::CenterOn(x, y + h / 2)
        const cx = p.x + ox;
        const cy = p.y + oy + (sysImage.height >> 1);
        const left = cx - (b.getW() >> 1);
        const top = cy - (b.getH() >> 1);
        b.setArea(left, top, left + b.getW(), top + b.getH());
        b.setCaption(this.str(S.firstCaption + i - 11));
        this.buttons.push(b);
      }
    }

    const title = new TSWinText();
    title.setFont(fonts.f16);
    title.setArea(0, oy + 6, this.getW(), fonts.f16.height + 6 + oy);
    title.setCaption(this.str(S.title));
    title.setAlignment(2);
    title.setBackgroundOpaque(false);
    this.childAdd(title);

    this.bioCaption = this.str(S.bio);
    this.bioFormat = this.str(S.bioOf);
    const bioLabel = new TSWinText();
    bioLabel.setFont(fonts.f10);
    {
      const top = BIO_EDIT.y - fonts.f10.height * 2 + oy;
      const left = BIO_EDIT.x + ox;
      bioLabel.setArea(left, top, left + fonts.f10.textArea(this.bioFormat).w, top + fonts.f10.height);
    }
    bioLabel.setCaption(this.bioFormat);
    bioLabel.setBackgroundOpaque(false);
    this.childAdd(bioLabel);
    this.bioLabel = bioLabel;

    const nameLabel = this.label(fonts.f12, this.str(S.nameLabel));
    {
      const x = NAME_EDIT.x + ox - nameLabel.getW() - 20;
      nameLabel.moveTo(x, NAME_EDIT.y + oy);
    }
    const persLabel = this.label(fonts.f12, this.str(S.personality));
    // The original centers it with the name label's width.
    persLabel.moveTo(PERSONALITY_LABEL.x + ox - (nameLabel.getW() >> 1), PERSONALITY_LABEL.y + oy - persLabel.getH());

    this.pointsTitle = this.str(S.pointsTitle);
    this.pointsMessage = this.str(S.pointsMessage);
    this.buttons[B.child]!.setState(0);
    this.buttons[B.adult]!.setState(1);
    this.buttons[B.done]!.enabled = false;
    this.buttons[B.bodyPrev]!.overrideUISound(null, SOUND_CYCLE_PARTS);
    this.buttons[B.bodyNext]!.overrideUISound(null, SOUND_CYCLE_PARTS);
    this.buttons[B.headPrev]!.overrideUISound(null, SOUND_CYCLE_HEAD);
    this.buttons[B.headNext]!.overrideUISound(null, SOUND_CYCLE_HEAD);

    // HouseViewer::SetRotation(0) / SetScale(1): the preview's camera (WinVitaBtn).
    const vita = new WinVitaBtn(VITA.scale);
    vita.setArea(VITA.x + ox, VITA.y + oy, VITA.x + ox + VITA.w, VITA.y + oy + VITA.h);
    await vita.init();
    this.childAdd(vita);
    this.vita = vita;

    await this.buildPersonalityBtns(UI_LANGUAGE >= 3 && UI_LANGUAGE <= 4 ? fonts.f12 : fonts.f14);

    const name = new TSWinTextEdit2();
    name.setFont(fonts.f10);
    name.setTextColor(WHITE);
    name.setColors(DLG_FILL, WHITE, WHITE);
    name.setArea(NAME_EDIT.x + ox, NAME_EDIT.y + oy, NAME_EDIT.x + NAME_EDIT.w + ox, NAME_EDIT.y + NAME_EDIT.h + oy);
    name.target = this;
    name.setLinesAllowed(1);
    name.setCapacity(0x19);
    name.setFlashFrameOnEmpty(true);
    name.setDrawFrameOnFocus(false);
    // +0x18c: "UI_NHood_error" (lbl_105BC718 + 0x6c) for a refused insertion.
    name.errorSound = "UI_NHood_error";
    name.setTransparent(true);
    this.childAdd(name);
    this.nameEdit = name;
    winMgr.setFocus(name);

    const bio = new TSWinTextEdit2();
    bio.setFont(fonts.f10);
    bio.setTextColor(WHITE);
    bio.setColors(DLG_FILL, WHITE, WHITE);
    bio.setLinesAllowed(-1);
    bio.setArea(BIO_EDIT.x + ox, BIO_EDIT.y + oy, BIO_EDIT.x + BIO_EDIT.w + ox, BIO_EDIT.y + BIO_EDIT.h + oy);
    bio.target = this;
    bio.setFlashFrameOnEmpty(false);
    bio.setDrawFrameOnFocus(false);
    bio.setCapacity(0x800);
    bio.errorSound = "UI_NHood_error";
    bio.setTransparent(true);
    this.childAdd(bio);
    this.bioEdit = bio;

    const zodiac = new TSWinBtn(BUTTON_ID_BASE + 0x20, null, 4, 1);
    zodiac.font = fonts.f12;
    zodiac.hiliteColors = HILITE_COLORS_4;
    zodiac.setArea(ZODIAC_RECT.left + ox, ZODIAC_RECT.top + oy, ZODIAC_RECT.right + ox, ZODIAC_RECT.bottom + oy);
    zodiac.tooltip = this.str(S.zodiacTip);
    zodiac.enabled = false;
    this.childAdd(zodiac);
    this.zodiacBtn = zodiac;

    if (!this.person) this.person = await this.session.makeNewPerson();
    else name.setText(this.person.firstName);
    const p = this.person;
    this.pointsImage = await ctx.res.image("kPeoplePtsBuffer");
    if (!this.isNew) {
      this.widgets.forEach((w, i) => {
        const v = Math.trunc((p.personData[TRAIT_FIELDS[i]!] ?? 0) / 100);
        w.setValue(v);
        this.pointsLeft -= w.getValue();
      });
    }
    this.edit = await this.session.beginDesignAPerson(p);
    // BeginDesignAPerson: PersonFinder::CreateInstance; EditPerson's ResetInstanceSuits reaches it.
    this.edit.onResetInstanceSuits = () => this.scheduleInstance("reset");
    this.scheduleInstance("create");
    if (!this.isNew) {
      this.headIndex = this.edit.getHeadSuit();
      this.bodyIndex = this.edit.getBodySuit();
    } else {
      this.headIndex = 0;
      this.bodyIndex = 0;
    }
    this.ended = false;
    this.edit.setHeadSuit(this.headIndex);
    this.edit.setBodySuit(this.bodyIndex);
    this.prepareButtons();
    if (!this.isNew) bio.setText(p.bio);
    else for (const w of this.widgets) w.setValue(0);
    this.prepareButtons();
    return true;
  }

  private label(font: Parameters<TSWinText["setFont"]>[0], caption: string): TSWinText {
    const t = new TSWinText();
    t.setFont(font);
    t.setWinTextFlag(2, false);
    t.setCaption(caption);
    t.fitWindowToText();
    t.setBackgroundOpaque(false);
    this.childAdd(t);
    return t;
  }

  /** cWinDesignCharacter::BuildPersonalityBtns */
  private async buildPersonalityBtns(font: Parameters<WinPersonalityWidget["setFont"]>[0]): Promise<void> {
    for (let i = 0; i < 5; i++) {
      const w = new WinPersonalityWidget(this.ctx, this);
      w.id = BUTTON_ID_BASE + 0x10 + i;
      await w.init();
      this.childAdd(w);
      this.widgets.push(w);
      w.setFont(font);
      w.setMinCaption(this.str(S.firstTrait + i));
      w.setMaxCaption(MAX_CAPTION);
    }
    // Vertical flow from the first LED, one row every TRAITS.step pixels.
    this.widgets.forEach((w, i) => {
      w.moveTo(TRAITS.x + this.offX, TRAITS.y + this.offY + i * TRAITS.step);
      w.setLEDTopLeft(w.area.left, w.area.top);
    });
  }

  /** cWinDesignCharacter::SanifySuits */
  private sanifySuits(): void {
    const edit = this.edit;
    if (!edit) return;
    const bodies = edit.countAvailableBodySuits();
    const heads = edit.countAvailableHeadSuits();
    if (heads === 0) this.headIndex = -1;
    else if (this.headIndex < 0) this.headIndex = 0;
    else if (this.headIndex >= heads) this.headIndex = heads - 1;
    if (bodies === 0) this.bodyIndex = -1;
    else if (this.bodyIndex < 0) this.bodyIndex = 0;
    else if (this.bodyIndex >= bodies) this.bodyIndex = bodies - 1;
    edit.setBodySuit(this.bodyIndex);
    edit.setHeadSuit(this.headIndex);
  }

  /**
   * The instance cWinVitaBtn renders: ResetInstanceSuits re-dresses it from
   * the body strings (SAnimator::ResetSuits, the animation goes on);
   * PersonFinder::SetAge kills it and creates a new one (new skeleton) that
   * starts over. Both run once the command's suit changes are done.
   */
  private scheduleInstance(work: "create" | "reset"): void {
    const first = this.instanceWork === null;
    if (work === "create" || first) this.instanceWork = work;
    if (first) queueMicrotask(() => this.flushInstance());
  }

  private flushInstance(): void {
    const work = this.instanceWork;
    this.instanceWork = null;
    const p = this.person;
    const edit = this.edit;
    if (!p || !edit) return;
    if (work === "reset") {
      if (this.creating) void this.creating.then(() => this.instance?.setBodyStrings(edit.bodyStrings()));
      else void this.instance?.setBodyStrings(edit.bodyStrings());
      return;
    }
    const serial = ++this.animatorSerial;
    const creating = this.session.animator(p).then(async (a: SAnimator | null) => {
      if (serial !== this.animatorSerial || !a) return;
      await a.startIdle();
      this.instance = a;
      this.vita?.setPerson(a);
    });
    this.creating = creating;
    void creating.finally(() => {
      if (this.creating === creating) this.creating = null;
    });
  }

  /** cWinDesignCharacter::PrepareButtons */
  prepareButtons(): void {
    const edit = this.edit;
    const p = this.person;
    if (!edit || !p) return;
    if (this.sanify) {
      this.sanifySuits();
      this.sanify = false;
    }
    const name = this.nameEdit?.getText() ?? "";
    const named = name.length > 0 && name.trim().length > 0;
    const bodies = edit.countAvailableBodySuits();
    const heads = edit.countAvailableHeadSuits();
    const b = this.buttons;
    for (const i of [B.bodyPrev, B.bodyNext]) if (bodies < 2) b[i]!.hideWindow(); else b[i]!.showWindow();
    for (const i of [B.headPrev, B.headNext]) if (heads < 2) b[i]!.hideWindow(); else b[i]!.showWindow();
    b[B.done]!.enabled = named && bodies > 0 && heads > 0;
    for (const i of [B.bodyPrev, B.bodyNext, B.headPrev, B.headNext]) b[i]!.enabled = true;
    const adult = edit.getAge() === 0;
    b[B.adult]!.setState(adult ? 1 : 0);
    b[B.child]!.setState(adult ? 0 : 1);
    const male = edit.getGender() === 0;
    b[B.male]!.setState(male ? 1 : 0);
    b[B.female]!.setState(male ? 0 : 1);
    const color = edit.getColor();
    b[B.dark]!.setState(color === "drk" ? 1 : 0);
    b[B.medium]!.setState(color === "med" ? 1 : 0);
    b[B.light]!.setState(color !== "drk" && color !== "med" ? 1 : 0);

    const label = this.bioLabel;
    if (label?.font) {
      const caption = named ? this.bioFormat.replace("%s", `${name} ${this.familyName}`) : this.bioCaption;
      label.setArea(label.area.left, label.area.top, label.area.left + label.font.textArea(caption).w + 20, label.area.bottom);
      label.setCaption(caption);
    }

    this.widgets.forEach((w, i) => (p.personData[TRAIT_FIELDS[i]!] = w.getValue() * 100));
    const zodiac = this.zodiacBtn;
    if (zodiac) {
      if (this.pointsLeft < TOTAL_POINTS) {
        const sign = computeZodiacSign(p.personData);
        p.personData[PD_ZODIAC] = sign;
        zodiac.caption = `(${getZodiacName(this.ctx, sign)})`;
        zodiac.enabled = true;
      } else {
        zodiac.caption = "";
        zodiac.enabled = false;
      }
    }
  }

  /** Remembers the current choices before the age / gender / skin changes (the +0x1b8 table). */
  private remember(): void {
    const k = this.gender * 4 + this.adult * 2;
    this.memory[k] = this.bodyIndex;
    this.memory[k + 1] = this.headIndex;
  }

  private recall(): void {
    const k = this.gender * 4 + this.adult * 2;
    this.bodyIndex = this.memory[k] ?? 0;
    this.headIndex = this.memory[k + 1] ?? 0;
  }

  private cycle(which: "body" | "head", delta: number): void {
    const edit = this.edit;
    if (!edit) return;
    const count = which === "body" ? edit.countAvailableBodySuits() : edit.countAvailableHeadSuits();
    let i = (which === "body" ? this.bodyIndex : this.headIndex) + delta;
    if (i < 0) i = count - 1;
    else if (i >= count) i = 0;
    if (which === "body") this.bodyIndex = i;
    else this.headIndex = i;
    this.sanify = true;
    this.prepareButtons();
  }

  /** Done (+0x150): checks the points, saves the person, tells the target. */
  private async done(): Promise<void> {
    const p = this.person;
    if (!p || !this.edit || this.ended) return;
    const name = this.nameEdit?.getText() ?? "";
    if (this.pointsLeft > 0) {
      const r = await TSWinMsgBox.show(this.ctx, this.pointsMessage.replace("%s", name), this.pointsTitle, MB_YESNO);
      if (r !== IDYES) return;
    }
    p.firstName = name;
    p.bio = this.bioEdit?.getText() ?? "";
    this.widgets.forEach((w, i) => (p.personData[TRAIT_FIELDS[i]!] = w.getValue() * 100));
    if (this.edit.getAge() === 0) this.edit.setupNewHDSkins();
    this.ended = true;
    await this.session.endDesignAPerson(p, true, this.isNew);
    if (this.isNew) this.target?.personDesigned(p);
    this.tsEndDialog(1);
  }

  /** Cancel (+0x154), also Escape (Shutdown ends the design unsaved). */
  private async cancel(): Promise<void> {
    const p = this.person;
    if (p && !this.ended) {
      this.ended = true;
      await this.session.endDesignAPerson(p, false, this.isNew);
      if (this.isNew) await this.session.deletePerson(p);
    }
    this.tsEndDialog(0);
  }

  private zodiacClicked(): void {
    const p = this.person;
    const zodiac = this.zodiacBtn;
    if (!p || !zodiac || !zodiac.caption) return;
    const sign0 = getSignFromName(this.ctx, zodiac.caption.slice(1, -1));
    const sign = sign0 === 0 || sign0 + 1 > 12 ? 1 : sign0 + 1;
    zodiac.caption = `(${getZodiacName(this.ctx, sign)})`;
    setZodiacSign(p.personData, sign);
    this.pointsLeft = TOTAL_POINTS;
    this.widgets.forEach((w, i) => {
      w.setValue(Math.trunc((p.personData[TRAIT_FIELDS[i]!] ?? 0) / 100));
      this.pointsLeft -= w.getValue();
    });
  }

  override tsOnCommand(cmd: number, source: TSWin): boolean {
    const edit = this.edit;
    if (cmd === TE_CHANGED) {
      if (source === this.nameEdit) this.prepareButtons();
      return true;
    }
    if (cmd === TE_TAB) {
      winMgr.setFocus(source === this.nameEdit ? this.bioEdit : this.nameEdit);
      return true;
    }
    if (cmd === TE_ESCAPE) {
      void this.cancel();
      return true;
    }
    if (!edit || !(source instanceof TSWinBtn)) return true;
    const i = this.buttons.indexOf(source);
    switch (i) {
      case B.done:
        void this.done();
        break;
      case B.cancel:
        void this.cancel();
        break;
      case B.bodyPrev:
        this.cycle("body", -1);
        break;
      case B.bodyNext:
        this.cycle("body", 1);
        break;
      case B.headPrev:
        this.cycle("head", -1);
        break;
      case B.headNext:
        this.cycle("head", 1);
        break;
      case B.adult:
      case B.child:
        this.remember();
        this.adult = i === B.adult ? 1 : 0;
        this.recall();
        // PersonFinder::SetAge: EditPerson::SetAge, then the instance is killed and created again.
        edit.setAge(i === B.adult ? 0 : 1);
        this.scheduleInstance("create");
        this.sanify = true;
        this.prepareButtons();
        break;
      case B.female:
      case B.male:
        this.remember();
        this.gender = i === B.female ? 1 : 0;
        this.recall();
        edit.setGender(this.gender);
        this.sanify = true;
        this.prepareButtons();
        break;
      case B.dark:
      case B.medium:
      case B.light:
        this.remember();
        this.skin = i === B.dark ? 2 : i === B.medium ? 1 : 0;
        this.recall();
        edit.setColor(SKINS[i]!);
        this.sanify = true;
        this.prepareButtons();
        break;
      default:
        if (source === this.zodiacBtn) this.zodiacClicked();
    }
    return true;
  }

  override tsOnKeyDown(key: string): boolean {
    if (key === "Escape") {
      void this.cancel();
      return true;
    }
    return false;
  }

  /** The focus goes to the name edit once the dialog is up (DoModalWin focuses the dialog itself). */
  override tsBeginModal(): void {
    if (this.nameEdit) winMgr.setFocus(this.nameEdit);
  }

  override tsOnMouseDownL(x: number, y: number): boolean {
    if (this.nameEdit && this.nameEdit.getText().length === 0) winMgr.setFocus(this.nameEdit);
    return super.tsOnMouseDownL(x, y);
  }

  override tsPaint(g: Gfx): void {
    const w = this.getW();
    const h = this.getH();
    const bkg = this.bkg;
    if (!bkg) return;
    const ox = this.offX;
    const oy = this.offY;
    // PaintInsetDlgBorder: the four bands around the background.
    if (ox > 0 || oy > 0) {
      g.fill(0, 0, w, oy, DLG_FILL);
      g.fill(0, oy + bkg.height, w, h - oy - bkg.height, DLG_FILL);
      g.fill(0, oy, ox, bkg.height, DLG_FILL);
      g.fill(ox + bkg.width, oy, w - ox - bkg.width, bkg.height, DLG_FILL);
    }
    g.blit(bkg, ox, oy);
    const pts = this.pointsImage;
    if (pts) {
      const pw = Math.min(pts.width, this.pointsLeft * POINT_STEP);
      if (pw > 0) g.blitPart(pts, 0, 0, pw, pts.height, POINTS_BAR.x + ox, POINTS_BAR.y + oy);
    }
  }
}
