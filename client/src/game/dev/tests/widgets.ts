/**
 * Dev test: generic widgets (text, list + scrollbar, sliders, check box,
 * tri-radio, system buttons with tooltips, message boxes).
 */

import type { GameContext } from "../../context.js";
import { TSWinCheck } from "../../ui/check.js";
import { TSWinCtrlMgr } from "../../ui/ctrlmgr.js";
import { IDCANCEL, IDNO, IDOK, IDYES, MB_OK, MB_YESNOCANCEL, TSWinMsgBox } from "../../ui/msgbox.js";
import { TSWinScrollbar } from "../../ui/scrollbar.js";
import { SLIDER_HORIZONTAL, SLIDER_VERTICAL, TSWinSlider } from "../../ui/slider.js";
import { rgb } from "../../ui/syscolors.js";
import { TSSystemButton } from "../../ui/systembutton.js";
import { TSWinText, WTF_MULTILINE } from "../../ui/text.js";
import { TSWinTextList } from "../../ui/textlist.js";
import { WinTriRadio } from "../../ui/triradio.js";
import { DefaultTTWindow } from "../../ui/ttwindow.js";
import { Gfx, TSWin } from "../../ui/tswin.js";
import type { WinMgr } from "../../ui/winmgr.js";

class Backdrop extends TSWin {
  override tsPaint(g: Gfx): void {
    g.fill(0, 0, this.getW(), this.getH(), rgb(0x30, 0x48, 0x60));
  }
}

const RESULT_NAMES: Record<number, string> = { [IDOK]: "OK", [IDCANCEL]: "Cancel", [IDYES]: "Yes", [IDNO]: "No" };

export async function mount(ctx: GameContext, mgr: WinMgr): Promise<void> {
  mgr.setDefaultTTWindow(await DefaultTTWindow.create(ctx.fonts));
  const cm = await TSWinCtrlMgr.get(ctx);
  const root = new Backdrop();
  root.setArea(0, 0, ctx.width, ctx.height);
  mgr.main.childAdd(root);

  const status = new TSWinText();
  status.setFont(cm.systemFont(0));
  status.setBackgroundOpaque(false);
  status.setWinTextFlag(WTF_MULTILINE, false);
  status.setArea(40, 720, 600, 740);
  status.setCaption("ready");
  root.childAdd(status);
  const log = (s: string): void => {
    status.setCaption(s);
    console.log(s);
  };

  // Texts: single line label, wrapped centered paragraph, opaque right-aligned.
  const label = new TSWinText();
  label.setCaption("cTSWinText: single line, DefaultLabel style");
  label.setFont(cm.systemFont(0));
  label.setAlignment(1);
  label.setBackgroundOpaque(false);
  label.setWinTextFlag(WTF_MULTILINE, false);
  label.fitWindowToText();
  label.moveTo(40, 10);
  root.childAdd(label);

  const para = new TSWinText();
  para.setArea(40, 60, 300, 160);
  para.setCaption(
    "Word-wrapped and centered (alignment 3): cTSFont::DrawTextPara cuts lines after spaces and hyphens; a newline\nforces a break.",
  );
  para.setFont(cm.systemFont(0));
  para.setAlignment(3);
  para.setFillColor(rgb(0, 0x28, 0x8c));
  root.childAdd(para);

  const shadow = new TSWinText();
  shadow.setArea(40, 170, 300, 196);
  shadow.setCaption("Right aligned, system font 1 (shadow)");
  shadow.setFont(cm.systemFont(1));
  shadow.setAlignment(5);
  shadow.setBackgroundOpaque(false);
  root.childAdd(shadow);

  // Text list with its scrollbar.
  const list = new TSWinTextList(ctx);
  list.setFont(cm.systemFont(0));
  list.visibleRows = 8;
  list.fillColor = rgb(0x10, 0x20, 0x30);
  list.setArea(340, 30, 560, 30);
  root.childAdd(list);
  await list.init();
  for (const s of ctx.strings.list("UIText", 152).concat(Array.from({ length: 14 }, (_, i) => `Item ${i + 1}`))) {
    list.push(s);
  }
  list.onSelect = (i) => log(`list select ${i}: ${list.get(i)}`);
  mgr.setFocus(list);

  // Standalone scrollbar and sliders.
  const sb = TSWinScrollbar.defaultScrollbar(cm, 0, SLIDER_HORIZONTAL);
  sb.setArea(340, 250, 560, 250 + sb.getH());
  sb.setMinimumValue(0);
  sb.setMaximumValue(10);
  sb.setPageSize(3);
  sb.onChange = (v) => log(`scrollbar ${v}`);
  root.childAdd(sb);

  const sh = TSWinSlider.defaultSlider(cm, 0, SLIDER_HORIZONTAL);
  sh.setArea(340, 290, 540, 290 + sh.getH());
  sh.setMaximumValue(10);
  sh.onChange = (v) => log(`slider H ${v}`);
  root.childAdd(sh);

  const sv = TSWinSlider.defaultSlider(cm, 0, SLIDER_VERTICAL);
  sv.setArea(600, 30, 600 + sv.getW(), 180);
  sv.setMaximumValue(10);
  sv.setValue(3);
  sv.onChange = (v) => log(`slider V ${v}`);
  root.childAdd(sv);

  // Check boxes and tri-radio.
  const check = TSWinCheck.defaultCheckBox(cm, 0, "cTSWinCheck (DefaultCheckBox)");
  check.moveTo(40, 215);
  root.childAdd(check);
  await check.init();
  check.onChange = (on) => log(`check ${on}`);

  const tri = new WinTriRadio(await ctx.res.image("kOptRadio"));
  tri.setArea(40, 270, 240, 300);
  root.childAdd(tri);
  await tri.init();
  tri.setArea(40, 270, 240, 270 + (tri.btns[0]?.getH() ?? 0));
  tri.setVal(1);
  tri.onChange = (v) => log(`triradio ${v}`);

  // System buttons with tooltips; they open message boxes.
  const ok = TSSystemButton.defaultPushBtn(cm, 0, "Message");
  ok.moveTo(40, 340);
  ok.tooltip = "Opens an MB_OK message box";
  ok.onClick = () => {
    void TSWinMsgBox.show(ctx, "A message box, with a text long enough to wrap over several lines.", "The Sims", MB_OK).then(
      (r) => log(`msgbox -> ${RESULT_NAMES[r] ?? r}`),
    );
  };
  root.childAdd(ok);

  const ync = TSSystemButton.defaultPushBtn(cm, 0, "Yes / No / Cancel");
  ync.moveTo(160, 340);
  ync.tooltip = "MB_YESNOCANCEL, default button 1 after 5 s";
  ync.onClick = () => {
    void TSWinMsgBox.show(ctx, "Save the game?", "Quit", MB_YESNOCANCEL, 1, 5000).then((r) =>
      log(`msgbox -> ${RESULT_NAMES[r] ?? r}`),
    );
  };
  root.childAdd(ync);

  const longBtn = TSSystemButton.defaultPushBtn(cm, 0, "A rather long caption for a push button");
  longBtn.moveTo(40, 390);
  longBtn.setArea(40, 390, 160, 390 + longBtn.getH());
  longBtn.tooltip = "Caption shrunk to size 8, then cut with an ellipsis";
  root.childAdd(longBtn);
}
