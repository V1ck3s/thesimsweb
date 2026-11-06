/**
 * Job page of a pet (cWinSubpanelDogSkills, cWinSubpanelCatSkills): the
 * page title and three trained skills with their bars.
 *
 * From the decompiled classes (WinSubpanelPetSkills.cpp static init, single
 * byte UI):
 *  - Init: kJobSubpanelBars / kJobSubBarsOff (the bars), the window
 *    (0, 0, 0x1ab, 100); Live.iff STR# 0xab: the title (+0xe4), then the three
 *    skill labels, each a cFlashyBtn 0x66 x 0x10 at lbl_105BCC5C = (0x67, 0x19),
 *    (0x67, 0x28), (0x67, 0x37), toggle, text rectangle (0, 0, 0x66, 0x10)
 *    right-aligned, no image, font table entry 7; STR# 0xac: (name,
 *    description) of each skill for the popup client (+0x100);
 *  - the cat page differs only by its first skill: STR# 0xab entry 4
 *    replaces the first label and STR# 0xac entries 6 / 7 its popup texts
 *    ("Hunter" instead of "Housebroken");
 *  - TSPaint: for the selected person, the skills' person data
 *    (lbl_105BCC68 = 10, 12, 11) / 100, clamped to 0..10: kJobSubBarsOff at
 *    lbl_105BCC64 = (0xcf, 0x1b), (0xcf, 0x2a), (0xcf, 0x39), then
 *    kJobSubpanelBars clipped to 4 px per level (the whole bitmap at 10 or
 *    when it is narrower); then cWinPeople::DrawSubpanelTitle at (0xd, 8)
 *    in font table entry 11;
 *  - double-byte UI (CPState::IsDoubleByteUI): kHouseSubpanelBars /
 *    kHouseSubBarsOff, labels at (0x67, 0x2d), (0x67, 0x41), (0x67, 0x55)
 *    (the per-language tables lbl_105BCC4C..lbl_105BCC60 are all equal),
 *    bars at lbl_105BCC48 = (0xcf, 0x33), (0xcf, 0x47), (0xcf, 0x5b); the
 *    title is at (0xd, 8) either way;
 *  - TSOnCommand: a skill label (command 1, or 0x13, the quick tips
 *    timeout) toggles its popup like the job page; the popup's object panes
 *    (lbl_105BCC6C GUIDs) are all 0.
 */

import type { GameContext } from "../../context.js";
import type { FfnFont } from "../../res/ffn.js";
import { getOptionsMgr } from "../../optionsmgr.js";
import { DOUBLE_BYTE_UI } from "../../res/uires.js";
import { ASYNC_ON_ENTER, BTN_TOGGLE, CMD_ASYNC_EXIT } from "../../ui/btn.js";
import { UI_FONT_COLOR } from "../../ui/syscolors.js";
import { Gfx, TSWin } from "../../ui/tswin.js";
import { popupClick, type WinLivePopup, WinLivePopupClient } from "../livepopup.js";
import { FlashyBtn } from "./job.js";

const LIVE = "Live";
/** LoadUIStrings(0xab): title, then the skill labels. */
const STR_LABELS = 0xab;
/** LoadUIStrings(0xac): (name, description) per skill. */
const STR_POPUP = 0xac;

/** lbl_105BCC68: person data of each skill. */
const SKILLS = [10, 12, 11];
/** lbl_105BCC5C: the labels' positions (double-byte: the language's table, Init). */
const LABEL_POS = DOUBLE_BYTE_UI
  ? ([[0x67, 0x2d], [0x67, 0x41], [0x67, 0x55]] as const)
  : ([[0x67, 0x19], [0x67, 0x28], [0x67, 0x37]] as const);
const LABEL_W = 0x66;
const LABEL_H = 0x10;
/** lbl_105BCC64: the bars' positions (lbl_105BCC48 double-byte). */
const BAR_POS = DOUBLE_BYTE_UI
  ? ([[0xcf, 0x33], [0xcf, 0x47], [0xcf, 0x5b]] as const)
  : ([[0xcf, 0x1b], [0xcf, 0x2a], [0xcf, 0x39]] as const);
/** DrawSubpanelTitle's offset and font table entry. */
const TITLE_POS = { x: 0xd, y: 8 };
const TITLE_FONT = 0xb;
const LABEL_FONT = 7;

class WinSubpanelPetSkills extends TSWin {
  private bars: ImageBitmap | null = null;
  private barsOff: ImageBitmap | null = null;
  private titleFont: FfnFont | null = null;
  /** +0xd4: the skill labels. */
  private readonly btns: FlashyBtn[] = [];
  /** +0xe4 */
  private title = "";
  /** +0xe8 / +0xf4: the popup names and descriptions. */
  private readonly names: string[] = [];
  private readonly descs: string[] = [];
  /** +0x100 */
  private readonly client = new WinLivePopupClient();
  /** cWinPeople+0x150: the Live panel's popup (set by WinPeople). */
  livePopup: WinLivePopup | null = null;

  constructor(
    readonly ctx: GameContext,
    /** The cat page's first skill comes after the dog's three. */
    private readonly cat: boolean,
  ) {
    super();
  }

  /** cWinSubpanelDogSkills::Init / cWinSubpanelCatSkills::Init */
  override async init(): Promise<boolean> {
    const { ctx } = this;
    const [bars, barsOff, titleFont, labelFont] = await Promise.all([
      ctx.res.image(DOUBLE_BYTE_UI ? "kHouseSubpanelBars" : "kJobSubpanelBars"),
      ctx.res.image(DOUBLE_BYTE_UI ? "kHouseSubBarsOff" : "kJobSubBarsOff"),
      ctx.fonts.acquire(TITLE_FONT),
      ctx.fonts.acquire(LABEL_FONT),
    ]);
    this.bars = bars;
    this.barsOff = barsOff;
    this.titleFont = titleFont;
    this.setArea(0, 0, 0x1ab, 100);

    const labels = ctx.strings.list(LIVE, STR_LABELS);
    if (!labels.length) return super.init();
    this.title = labels[0]!;
    for (let i = 0; i < SKILLS.length; i++) {
      const btn = new FlashyBtn();
      btn.caption = labels[i + 1] ?? "";
      btn.setArea(0, 0, LABEL_W, LABEL_H);
      btn.moveTo(LABEL_POS[i]![0], LABEL_POS[i]![1]);
      btn.mode = BTN_TOGGLE;
      btn.textRect = { left: 0, top: 0, right: LABEL_W, bottom: LABEL_H };
      btn.textAlignment = 2;
      btn.setImageKeepArea(null, 4, 0);
      btn.font = labelFont;
      this.childAdd(btn);
      this.btns.push(btn);
    }
    if (this.cat) this.btns[0]!.caption = labels[SKILLS.length + 1] ?? "";

    const popup = ctx.strings.list(LIVE, STR_POPUP);
    for (let i = 0; i < SKILLS.length; i++) {
      this.names.push(popup[2 * i] ?? "");
      this.descs.push(popup[2 * i + 1] ?? "");
    }
    if (this.cat) {
      this.names[0] = popup[2 * SKILLS.length] ?? "";
      this.descs[0] = popup[2 * SKILLS.length + 1] ?? "";
    }
    this.client.setName(this.names[0] ?? "");
    this.client.setDesc(this.descs[0] ?? "");
    return super.init();
  }

  /** SetQuickTips: the labels open their popup on hover. */
  setQuickTips(on: boolean): void {
    const timeout = getOptionsMgr().getDefaultAsyncTimeout();
    for (const b of this.btns) b.setAsync(on ? ASYNC_ON_ENTER : 0, timeout);
  }

  /** TSOnCommand: one label at a time shows its popup; the second click closes it. */
  override tsOnCommand(cmd: number, source: TSWin): boolean {
    if (cmd === CMD_ASYNC_EXIT) return true;
    const i = this.btns.indexOf(source as FlashyBtn);
    if (i < 0) return super.tsOnCommand(cmd, source);
    this.btns.forEach((b, k) => b.setState(k === i ? 1 : 0));
    const popup = this.livePopup;
    if (popup) {
      popupClick(popup, this.client, this, this.btns[i]!, () => {
        this.client.setName(this.names[i] ?? "");
        this.client.setDesc(this.descs[i] ?? "");
        this.client.setBitmap(0, null);
      });
    }
    return true;
  }

  /** TSPaint */
  override tsPaint(g: Gfx): void {
    const p = this.ctx.state.personGetSelected();
    const bars = this.bars;
    const barsOff = this.barsOff;
    if (bars && barsOff && p) {
      SKILLS.forEach((skill, i) => {
        const [x, y] = BAR_POS[i]!;
        const level = Math.min(10, Math.max(0, Math.trunc((p.personData?.[skill] ?? 0) / 100)));
        g.blit(barsOff, x, y);
        if (level > 0) {
          const w = level * 4 <= bars.width && level !== 10 ? level * 4 : bars.width;
          g.blitPart(bars, 0, 0, w, bars.height, x, y);
        }
      });
    }
    // cWinPeople::DrawSubpanelTitle
    this.titleFont?.drawText(g.ctx, this.title, g.ox + TITLE_POS.x, g.oy + TITLE_POS.y, UI_FONT_COLOR);
  }
}

/** cWinSubpanelDogSkills */
export class WinSubpanelDogSkills extends WinSubpanelPetSkills {
  constructor(ctx: GameContext) {
    super(ctx, false);
  }
}

/** cWinSubpanelCatSkills */
export class WinSubpanelCatSkills extends WinSubpanelPetSkills {
  constructor(ctx: GameContext) {
    super(ctx, true);
  }
}
