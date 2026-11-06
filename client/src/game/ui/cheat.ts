/**
 * The cheat console: cTSCheatCodeManager, cCheatCommandLine, cTSWinCheatHelp,
 * the main window's cheat widget (cTSMainWindowW95) and cSimsApp's cheats
 * (SimsAppCheat, RegisterCheats, AppCheatCallback).
 *
 * From the decompiled code:
 *  - cTSMainWindowW95::TSOnKeyDown: Ctrl+Shift+C (Ctrl+Shift+B when the app
 *    language is 0x10) shows the cheat widget (ShowCheatWidget(1): show, pull
 *    to front, focus). The widget is the cTSWinTextEdit2 cSimsApp::Init makes:
 *    (0x14, 0x14)-(0xdc, 0x29), font table entry 10, text lbl_105BA928 (white)
 *    on lbl_105BA924, 255 characters, one line, no frame on focus or empty.
 *    Return (0x17) runs ProcessCheat on its text (an empty text hides the
 *    widget) and hides the widget when it returns true; Escape (0x18) hides
 *    it. Hiding clears the text and gives the focus back.
 *  - cTSCheatCodeManager::ProcessCheat: the text is cut at ';' (the pieces
 *    end at the first empty one), each piece is a cCheatCommandLine (words
 *    split at ' ', kept as typed and lowercased). "!" repeats the previous
 *    cheat ("No previous cheat!" / "Sorry"); an unknown word shows "No such
 *    cheat!" / "Sorry"; the registered usage becomes the error message
 *    ("Usage: " + usage) before the callback runs; a callback returning false
 *    shows its error message under "Cheat Error". After the last piece the
 *    console reports success when that cheat counts as one (+0x1c; "help"
 *    clears it), which also sets AnyCheatUsed.
 *  - RegisterCheat: with the restriction on (the constructor's flag, the
 *    app's IsFinalShip = 1 in the shipped builds, Mac and PC) only the 27
 *    names of lbl_105BCE78 / PC 0x6d752c register; "help" itself is not one of
 *    them. `?devcheats` (dev) builds the manager unrestricted, as a debug
 *    build would.
 *  - cTSWinCheatHelp (SetupHelpList, created by cDDDSimsView::Init): 0x271 x
 *    300 at (50, 50), filled with cSimsApp::GetDialogFillColor (0, 0, 0x52);
 *    the cheat list (cTSWinTextList, font table entry 9, 12 rows, 250 x 250
 *    at (10, 10)), OK at (40, 250), Cancel at (180, 250) (DefaultPushBtn), the
 *    usage text (DefaultLabel, 0x154 x 0xd2 at (0x10e, 10)). Open(filter)
 *    lists the cheats containing the filter, selects the exact match or the
 *    first row, or shows "Sorry, no cheats match the search string."; OK puts
 *    "<cheat> " in the widget and shows it.
 *
 * The shipped list's cheats: autonomy, bubble_tweak, draw_all_frames,
 * interests, log_mask, move_objects, rosebud, rotation, route_balloons,
 * sim_speed, xyzzy, prepare_lot, history (the file becomes a download), grid,
 * draw_floorable (lbl_105BA690, initially on: the upper level's build grid),
 * draw_routes (lbl_105BA914: only written, nothing in the shipped build reads
 * it), map_edit (lbl_105BA68C: cTileTool, world/tools/tiletool.ts, becomes the
 * cheat tool in every mode, CPState::SetCheatTool, and the ground shows
 * cMapTileSwatch's overlay, world/terrain_maptile.ts), sim_log (sim/simlog.ts;
 * SimLog.txt becomes a download) and genable (the HouseViewer module switches,
 * cheatflags.ts) are ported here; the neighborhood screen's show_zones,
 * show_filter and nessie in nbhd/winneighborhoodul.ts.
 * Not ported, with what they do in the original:
 *  - tile_info on|off: cDDDSimsView::ShowTileInfo shows or hides cWinTileInfo,
 *    which the shipped build never sizes nor points at a tile (SetTile is only
 *    called from its own keys): nothing appears.
 *  - w <text>: cDDDSimsView::SetStalkerCamText makes the cStalkerCam, which
 *    every 10 s (stalk.ini can change it) renders a 320x240 snapshot of the
 *    lot with the text and the logo and saves it as SimsWebCam.jpg (F8 forces
 *    a shot, Shift+F8 clears the text): a file written every 10 s has no web
 *    equivalent.
 *  - genable's clear, full_draw, static_rows, static and old_clear switches
 *    (kept and reported by "genable status"): the original's static layer
 *    and damage refresh, which this renderer does not have.
 *  - damagelist, sweep: the damage rectangles (DDDDamageList) and the
 *    cWinSweepMeter profiler (cTimePartition samples), neither of which this
 *    renderer has.
 *  - edit_grass n: the tile tool's grass mode (cTileTool BumpGrass).
 *  - move_lots: see nbhd/winneighborhoodul.ts.
 * Not in the shipped list (only with `?devcheats`): every other APP_CHEATS /
 * GRAPHICS_CHEATS name logs "not ported"; also cTSWinMgrW95's own cheat, the
 * ExecCheatFile and object dialog cheats, memview (cWinMemView) and the
 * neighborhood's stream_fps / reload_neighborhood.
 */

import { readStandaloneIff } from "../../engine/assets.js";
import type { GameContext } from "../context.js";
import { cheatFlags } from "../cheatflags.js";
import { WallState } from "../cpstate.js";
import { SIM_LOG_STRINGS, simLog } from "../sim/simlog.js";
import { type FamilyStat, getFamilyHistory } from "../data/familyhistory.js";
import { ObjectFolder } from "../world/objectfolder.js";
import { Terrain } from "../world/terrain.js";
import type { FfnFont } from "../res/ffn.js";
import type { WinLotView } from "../world/winlotview.js";
import { TSWinCtrlMgr } from "./ctrlmgr.js";
import { TSWinGenDlg } from "./gendlg.js";
import { TSWinMsgBox } from "./msgbox.js";
import { rgb } from "./syscolors.js";
import { TSSystemButton } from "./systembutton.js";
import { TSWinText, WTF_MULTILINE } from "./text.js";
import { TE_ESCAPE, TE_RETURN, TSWinTextEdit2 } from "./textedit.js";
import { CMD_LIST_DOUBLE_CLICK, CMD_LIST_SELECT, TSWinTextList } from "./textlist.js";
import { Gfx, TSWin } from "./tswin.js";
import { winMgr } from "./winmgr.js";

/** lbl_105BCE74 strings. */
const S = {
  helpNull: "The cheat help window ptr is NULL!",
  helpUsageErr: "Usage: help, or help [partial command], or help [command]",
  noPrevious: "No previous cheat!",
  sorry: "Sorry",
  noSuchCheat: "No such cheat!",
  usagePrefix: "Usage: ",
  cheatError: "Cheat Error",
  unknown: "Unknown",
  noUsage: "<No Usage Info Registered>",
  help: "help",
  helpUsage: "help [command] - shows all commands, complete, or partial match",
} as const;

/** lbl_105BCE78 (Mac) / 0x6d752c (PC): the cheats a restricted manager registers. */
const ALLOWED = [
  "autonomy", "bubble_tweak", "draw_all_frames", "draw_floorable", "draw_routes", "genable", "grid",
  "history", "interests", "log_mask", "map_edit", "move_objects", "prepare_lot", "rosebud", "rotation",
  "route_balloons", "sim_log", "sim_speed", "sweep", "tile_info", "w", "xyzzy", "nessie", "show_zones",
  "show_filter", "move_lots", "damagelist",
];

/** cCheatCommandLine */
export class CheatCommandLine {
  /** +0x00: the words, lowercased. */
  args: string[] = [];
  /** +0x0c: the words as typed. */
  raw: string[] = [];
  /** +0x18 */
  errMsg: string = S.unknown;
  /** +0x1c: counts as a cheat (AnyCheatUsed); "help" clears it. */
  isCheat = true;

  /** cCheatCommandLine::cCheatCommandLine(char const *): strtok(" "). */
  static parse(text: string): CheatCommandLine {
    const c = new CheatCommandLine();
    for (const w of text.split(" ")) {
      if (!w) continue;
      c.raw.push(w);
      c.args.push(w.toLowerCase());
    }
    return c;
  }

  clone(): CheatCommandLine {
    const c = new CheatCommandLine();
    c.args = [...this.args];
    c.raw = [...this.raw];
    c.errMsg = this.errMsg;
    c.isCheat = this.isCheat;
    return c;
  }
}

/** bool (*)(cCheatCommandLine *, ulong); may wait for a modal window. */
export type CheatCallback = (cmd: CheatCommandLine, data: number) => boolean | Promise<boolean>;

/** cTSCheatCodeManager */
export class TSCheatCodeManager {
  /** +0x04: name -> callback, data (sorted on use, like the std::map). */
  private readonly cheats = new Map<string, { cb: CheatCallback; data: number }>();
  /** +0x14: name -> usage. */
  private readonly usage = new Map<string, string>();
  /** +0x24: the last cheat that ran. */
  private last = new CheatCommandLine();
  /** +0x49 */
  private anyUsed = false;
  /** +0x4c */
  private helpWin: TSWinCheatHelp | null = null;

  constructor(
    private readonly ctx: GameContext,
    /** +0x48: only the ALLOWED names register. */
    private readonly restricted: boolean,
  ) {
    this.registerCheat(S.help, (cmd) => this.cheatCodeMgrCallback(cmd), 0, S.helpUsage);
  }

  /** cTSCheatCodeManager::RegisterCheat (an existing name only gets a new callback and usage). */
  registerCheat(name: string, cb: CheatCallback, data: number, usage?: string): void {
    const key = name.toLowerCase();
    if (this.restricted && !ALLOWED.includes(key)) return;
    const existing = this.cheats.get(key);
    if (!existing) {
      this.cheats.set(key, { cb, data });
      this.usage.set(key, usage ?? S.noUsage);
    } else {
      existing.cb = cb;
      existing.data = data;
      if (this.usage.has(key)) this.usage.set(key, usage ?? S.noUsage);
    }
  }

  /** cTSCheatCodeManager::UnregisterCheat */
  unregisterCheat(name: string): void {
    const key = name.toLowerCase();
    this.cheats.delete(key);
    this.usage.delete(key);
  }

  /** cTSCheatCodeManager::AnyCheatUsed */
  anyCheatUsed(): boolean {
    return this.anyUsed;
  }

  /** The registered names in map order, with their usage. */
  list(): Array<{ name: string; usage: string }> {
    return [...this.cheats.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((name) => ({ name, usage: this.usage.get(name) ?? S.noUsage }));
  }

  private message(text: string, title: string): Promise<number> {
    return TSWinMsgBox.show(this.ctx, text, title);
  }

  /** cTSCheatCodeManager::ProcessCheat */
  async processCheat(text: string): Promise<boolean> {
    const lines: CheatCommandLine[] = [];
    for (const piece of text.slice(0, 255).split(";")) {
      if (!piece) break;
      lines.push(CheatCommandLine.parse(piece));
    }
    if (lines.length === 0) return false;
    for (let cmd of lines) {
      if (cmd.args.length < 1) return false;
      if (cmd.args[0] === "!") {
        if (this.last.args.length < 1) {
          await this.message(S.noPrevious, S.sorry);
          return false;
        }
        if (cmd.args.length === 1) cmd = this.last.clone();
        else cmd.args[0] = this.last.args[0]!;
      }
      const name = cmd.args[0]!;
      const entry = this.cheats.get(name);
      if (!entry) {
        await this.message(S.noSuchCheat, S.sorry);
        return false;
      }
      const usage = this.usage.get(name);
      if (usage !== undefined) cmd.errMsg = S.usagePrefix + usage;
      if (!(await entry.cb(cmd, entry.data))) {
        await this.message(cmd.errMsg, S.cheatError);
        return false;
      }
      this.last = cmd;
    }
    if (!this.last.isCheat) return false;
    this.anyUsed = true;
    return true;
  }

  /** cTSCheatCodeManager::SetupHelpList */
  async setupHelpList(font: FfnFont): Promise<void> {
    if (this.helpWin) return;
    const w = new TSWinCheatHelp(this.ctx, this, font);
    await w.init();
    w.hideWindow();
    this.helpWin = w;
  }

  /** cTSCheatCodeManager::CheatCodeMgrCallback ("help"). */
  private async cheatCodeMgrCallback(cmd: CheatCommandLine): Promise<boolean> {
    const help = this.helpWin;
    if (!help) {
      cmd.errMsg = S.helpNull;
      return false;
    }
    if (cmd.args.length === 1) help.open(null);
    else if (cmd.args.length === 2) help.open(cmd.args[1]!);
    else {
      cmd.errMsg = S.helpUsageErr;
      return false;
    }
    await winMgr.doModalWin(help);
    cmd.isCheat = false;
    return true;
  }
}

// --- cTSWinCheatHelp ----------------------------------------------------------

/** ___sinit__TSWinCheatHelp_cpp */
const HELP = {
  pos: { x: 0x32, y: 0x32 },
  size: { w: 0x271, h: 300 },
  listPos: { x: 10, y: 10 },
  listSize: { w: 0xfa, h: 0xfa },
  okPos: { x: 0x28, y: 0xfa },
  cancelPos: { x: 0xb4, y: 0xfa },
  textPos: { x: 0x10e, y: 10 },
  textSize: { w: 0x154, h: 0xd2 },
};
/** lbl_105BD084 */
const HELP_STR = {
  noMatch: "Sorry, no cheats match the search string.",
  ok: "OK",
  cancel: "Cancel",
  unknown: "<unknown>",
};
/** The list's +0xe0. */
const HELP_ROWS = 0xc;
/** cSimsApp::GetDialogFillColor */
const DIALOG_FILL = rgb(0, 0, 0x52);

/** cTSWinCheatHelp: the "help" cheat's list of cheats (a cTSWinGenDlg). */
export class TSWinCheatHelp extends TSWinGenDlg {
  /** +0x100 */
  private list: TSWinTextList | null = null;
  /** +0x104 / +0x108 */
  private ok: TSSystemButton | null = null;
  private cancel: TSSystemButton | null = null;
  /** +0x10c */
  private text: TSWinText | null = null;
  /** +0x11c: each row's index in the manager's map. */
  private rowIndex: number[] = [];

  constructor(
    ctx: GameContext,
    /** +0x110 */
    private readonly cheats: TSCheatCodeManager,
    /** +0x114 */
    private readonly font: FfnFont,
  ) {
    super(ctx);
  }

  /** cTSWinCheatHelp::Init */
  override async init(): Promise<boolean> {
    await super.init();
    const ctrl = await TSWinCtrlMgr.get(this.ctx);
    this.setArea(0, 0, HELP.size.w, HELP.size.h);
    this.moveTo(HELP.pos.x, HELP.pos.y);
    this.ok = TSSystemButton.defaultPushBtn(ctrl, 0, HELP_STR.ok);
    this.ok.moveTo(HELP.okPos.x, HELP.okPos.y);
    this.childAdd(this.ok);
    this.cancel = TSSystemButton.defaultPushBtn(ctrl, 0, HELP_STR.cancel);
    this.cancel.moveTo(HELP.cancelPos.x, HELP.cancelPos.y);
    this.childAdd(this.cancel);
    // cTSWinCtrlMgr::DefaultLabel(0, "<unknown>")
    const t = new TSWinText();
    t.setCaption(HELP_STR.unknown);
    t.setFont(ctrl.systemFont(0));
    t.setAlignment(1);
    t.setBackgroundOpaque(false);
    t.setWinTextFlag(WTF_MULTILINE, false);
    t.fitWindowToText();
    t.setArea(0, 0, HELP.textSize.w, HELP.textSize.h);
    t.moveTo(HELP.textPos.x, HELP.textPos.y);
    this.childAdd(t);
    this.text = t;
    const list = new TSWinTextList(this.ctx);
    list.setFont(this.font);
    list.visibleRows = HELP_ROWS;
    list.setArea(0, 0, HELP.listSize.w, HELP.listSize.h);
    list.moveTo(HELP.listPos.x, HELP.listPos.y);
    // TSPaint gives the list the dialog's fill color.
    list.fillColor = DIALOG_FILL;
    this.childAdd(list);
    await list.init();
    this.list = list;
    return true;
  }

  /** cTSWinCheatHelp::Open: lists the cheats containing `filter` (all when null). */
  open(filter: string | null): void {
    this.showWindow();
    const list = this.list;
    if (!list) return;
    list.clear();
    this.rowIndex = [];
    let match = -1;
    this.cheats.list().forEach(({ name }, i) => {
      if (filter !== null && !name.includes(filter)) return;
      list.insert(list.size(), name);
      this.rowIndex.push(i);
      if (filter !== null && name === filter) match = list.size() - 1;
    });
    if (match !== -1) list.select(match);
    else if (list.size() === 0) this.text?.setCaption(HELP_STR.noMatch);
    else list.select(0);
  }

  /** cTSWinCheatHelp::TSBeginModal: the focus goes to the list. */
  override tsBeginModal(): void {
    if (this.list) winMgr.setFocus(this.list);
  }

  /** cTSWinCheatHelp::TSOnKeyDown: Escape = Cancel, Return = OK (the focused list saw the key first). */
  override tsOnKeyDown(key: string): boolean {
    if (key === "Escape" || key === "Enter") {
      const b = key === "Escape" ? this.cancel : this.ok;
      if (b) this.tsOnCommand(1, b);
      return true;
    }
    return super.tsOnKeyDown(key);
  }

  /** cTSWinCheatHelp::TSOnCommand */
  override tsOnCommand(cmd: number, source: TSWin): boolean {
    if (cmd === CMD_LIST_DOUBLE_CLICK && source === this.list) {
      if (this.ok) this.tsOnCommand(1, this.ok);
      return true;
    }
    if (cmd === CMD_LIST_SELECT && source === this.list) {
      const row = this.list.getSelection();
      const index = this.rowIndex[row];
      if (row !== -1 && index !== undefined) {
        this.text?.setCaption(this.cheats.list()[index]?.usage ?? "");
        this.text?.setAlignment(0);
      } else {
        this.text?.setCaption("");
      }
      return true;
    }
    if (source === this.ok) {
      const list = this.list;
      if (list) {
        // cTSMainWindowW95::SetCheatWidgetText, ShowCheatWidget(1)
        cheatWidget?.setText(list.getSelection() === -1 ? "" : `${list.get(list.getSelection())} `);
        cheatWidget?.show();
      }
      this.close();
      return true;
    }
    if (source === this.cancel) {
      this.close();
      return true;
    }
    return super.tsOnCommand(cmd, source);
  }

  /** TSWinMsgPost(0x10): the modal loop ends and the window hides. */
  private close(): void {
    this.hideWindow();
    winMgr.endDialog(this, 0);
  }

  /** cTSWinCheatHelp::TSPaint: the whole window in the dialog fill color. */
  override tsPaint(g: Gfx): void {
    g.fill(0, 0, this.getW(), this.getH(), DIALOG_FILL);
  }
}

// --- the main window's cheat widget ---------------------------------------------

/** lbl_105BA924 (InitSimsColors). */
const WIDGET_FILL = rgb(0x40, 0x5d, 0x5f);
/** lbl_105BA928 (InitSimsColors). */
const WIDGET_TEXT = rgb(0xff, 0xff, 0xff);
const WIDGET_AREA = { left: 0x14, top: 0x14, right: 0xdc, bottom: 0x29 };

/** cTSMainWindowW95's cheat widget (+0xe4) and the commands it sends (+0xec: the focus to give back). */
class CheatWidget extends TSWin {
  private readonly edit = new TSWinTextEdit2();
  private savedFocus: TSWin | null = null;

  constructor(private readonly mgr: TSCheatCodeManager) {
    super();
  }

  async create(font: FfnFont): Promise<void> {
    const e = this.edit;
    e.setFont(font);
    e.setTextColor(WIDGET_TEXT);
    e.setColors(WIDGET_FILL, WIDGET_TEXT, WIDGET_TEXT);
    e.setArea(WIDGET_AREA.left, WIDGET_AREA.top, WIDGET_AREA.right, WIDGET_AREA.bottom);
    e.target = this;
    e.setCapacity(0xff);
    e.setLinesAllowed(1);
    e.setFlashFrameOnEmpty(false);
    e.setDrawFrameOnFocus(false);
    // cTSMainWindowW95::SetCheatWidget: a child of the main window, hidden.
    winMgr.main.childAdd(e);
    e.hideWindow();
  }

  setText(text: string): void {
    this.edit.setText(text.slice(0, 0xff));
  }

  /** cTSMainWindowW95::ShowCheatWidget(1) */
  show(): void {
    const e = this.edit;
    if (!e.isVisible()) this.savedFocus = winMgr.getFocus();
    e.showWindow();
    winMgr.main.childToFront(e);
    winMgr.setFocus(e);
  }

  /** cTSMainWindowW95::ShowCheatWidget(0) */
  hide(): void {
    const e = this.edit;
    if (!e.isVisible()) return;
    e.hideWindow();
    e.setText("");
    // +0xec: the focus the widget took goes back.
    winMgr.offerFocus(this.savedFocus);
    this.savedFocus = null;
  }

  /** cTSMainWindowW95::TSOnCommand: 0x18 (Escape) hides, 0x17 (Return) runs the text. */
  override tsOnCommand(cmd: number, source: TSWin): boolean {
    if (source !== this.edit) return false;
    if (cmd === TE_ESCAPE) {
      this.hide();
      return true;
    }
    if (cmd === TE_RETURN) {
      const text = this.edit.getText().slice(0, 0xff);
      if (!text) this.hide();
      else
        void this.mgr.processCheat(text).then((ok) => {
          if (ok) this.hide();
        });
      return true;
    }
    return false;
  }
}

let cheatWidget: CheatWidget | null = null;
let manager: TSCheatCodeManager | null = null;

/** cTSMainWindowW95::GetCheatCodeManager */
export function getCheatCodeManager(): TSCheatCodeManager | null {
  return manager;
}

// --- cSimsApp's cheats ----------------------------------------------------------

/** SimsAppCheat::Type: 0 any words, 1 none, 2 "on" / "off", 3 a number. */
const enum CT {
  Any = 0,
  None = 1,
  OnOff = 2,
  Number = 3,
}

/**
 * cSimsApp::RegisterCheats' SimsAppCheat table (id, type, name; arguments and
 * description are "" for all of them). A restricted manager keeps the ALLOWED ones.
 */
const APP_CHEATS: ReadonlyArray<readonly [number, CT, string]> = [
  [0, CT.None, "interests"], [1, CT.OnOff, "draw_routes"], [2, CT.OnOff, "draw_origins"],
  [3, CT.OnOff, "draw_floorable"], [4, CT.OnOff, "write_routes"], [5, CT.OnOff, "write_destlist"],
  [6, CT.Any, "sim_log"], [7, CT.Number, "grow_grass"], [8, CT.OnOff, "map_edit"], [9, CT.Number, "edit_grass"],
  [10, CT.OnOff, "move_objects"], [11, CT.Number, "lot_size"], [12, CT.Number, "rotation"], [13, CT.OnOff, "motives"],
  [14, CT.Number, "autonomy"], [15, CT.OnOff, "all_menus"], [16, CT.OnOff, "preview_anims"], [17, CT.Number, "house"],
  [18, CT.Number, "lot"], [19, CT.None, "dump_happy"], [20, CT.None, "dump_mc"], [21, CT.OnOff, "allow_inuse"],
  [22, CT.None, "prepare_lot"], [23, CT.Any, "swap_houses"], [24, CT.Any, "lot_border"], [25, CT.Number, "sim_speed"],
  [26, CT.Number, "set_hour"], [27, CT.Any, "w"], [28, CT.OnOff, "route_balloons"], [29, CT.None, "#import"],
  [30, CT.None, "#export"], [31, CT.None, "refresh_textures"], [32, CT.OnOff, "sound"], [33, CT.OnOff, "music"],
  [34, CT.OnOff, "obj_comp"], [35, CT.Any, "ngh"], [36, CT.OnOff, "cam_mode"], [37, CT.Any, "reload_people"],
  [38, CT.Any, "xyzzy"], [39, CT.Any, "plugh"], [40, CT.Any, "porntipsguzzardo"], [41, CT.OnOff, "visitor_control"],
  [42, CT.Any, "soundevent"], [42, CT.Any, "sev"], [43, CT.Any, "sound_bad"], [44, CT.Any, "sound_good"],
  [45, CT.Any, "restore_tut"], [46, CT.Any, "crash"], [47, CT.OnOff, "debug_social"], [48, CT.Any, "rebuild_cp"],
  [49, CT.Any, "assert"], [50, CT.Any, "refresh_faces"], [51, CT.Any, "edit_char"], [52, CT.OnOff, "draw_all_frames"],
  [53, CT.OnOff, "log_animations"], [54, CT.Number, "log_mask"], [55, CT.OnOff, "tile_info"], [56, CT.Any, "memview"],
  [57, CT.Number, "fam_test"], [58, CT.None, "water_tool"], [59, CT.Any, "cht"], [60, CT.Any, "shrink_text"],
  [61, CT.OnOff, "tutorial"], [62, CT.OnOff, "html"], [63, CT.OnOff, "browser_failsafe"], [64, CT.OnOff, "auto_level"],
  [65, CT.OnOff, "sound_log"], [66, CT.Any, "core_dump"], [67, CT.None, "hist_add"], [68, CT.Any, "history"],
  [69, CT.OnOff, "auto_reset"], [70, CT.OnOff, "sim_peek"], [71, CT.Any, "flush"], [72, CT.None, "save"],
  [73, CT.None, "quit"], [74, CT.Any, "import"], [75, CT.OnOff, "quats"], [76, CT.OnOff, "report_assets"],
  [77, CT.Number, "bubble_tweak"], [78, CT.Any, "rosebud"], [79, CT.Any, "save_careers"], [80, CT.Any, "save_tuning"],
  [81, CT.Any, "save_careers_txt"], [82, CT.Any, "ct"], [83, CT.Any, "dump_catalog_sorts"], [84, CT.Number, "set_level"],
  [85, CT.OnOff, "pet_control"], [86, CT.OnOff, "show_animations"], [87, CT.OnOff, "show_sounds"],
  [88, CT.OnOff, "make_dynamic"], [89, CT.OnOff, "fame_ui"], [90, CT.Any, "magic_book"], [91, CT.Any, "transform_me"],
  [92, CT.Number, "age_me"], [93, CT.Number, "person_me"], [94, CT.Any, "cook_book"], [95, CT.Number, "kid_me"],
  [96, CT.Number, "cat_me"], [97, CT.Number, "dog_me"], [98, CT.Number, "magic_tokens"], [99, CT.OnOff, "show_bodystrings"],
];

/** RegisterGraphicsCheats (lbl_105BBF34 names, lbl_105BBF38 usages); the graphics Callback's effects are debug rendering. */
const GRAPHICS_CHEATS: ReadonlyArray<readonly [string, string]> = [
  ["aa", "aa [on|off] - enables/disables sprite antialiasing"],
  ["lamps", "lamps [on|off] - enables/disables lamp effects on walls & floors"],
  ["shadows", "shadows [on|off] - enables/disables shadows under objects"],
  ["money", "money [amt] - sets current funds to amt"],
  ["grid", "grid [on|off] - enables/disables terrain grid drawing"],
  ["alt_add", "alt_add [amt] - add constant value to entire altitude layer"],
  ["offset_world", "offset_world [x_amt] [y_amt] - moves everything in world by specified x & y tile offsets"],
  ["edit_size", "edit_size [size] - sets flag layer to allow editing only with a central square, size x size"],
  ["sweep", "sweep on|off|all|none|'subsys_name' [show|hide]"],
  ["people_quality", "people_quality [low|medium|high]"],
  ["genable", "genable [default|status] | ([terrain | floors | walls | clear | objects | people | full_draw | static_rows | static | old_clear | all ] [on|off])"],
  ["sprites", "sprites [sims|vacation|alpha|depth|index]"],
  ["houseview_update", "houseview_update [sims|vacation|x]"],
  ["damagelist", "damagelist ([refresh | current | previous | all]) | [on|off]) - show damage lists"],
  ["scroll_bitmaps", "scroll_bitmaps ([on|off]) - write bitmaps while scrolling"],
  ["censor_bbox", "censor_bbox ([on|off]) - render censor bboxes"],
  ["starbob", "starbob ([on|off]) - replace standard plumbbob with star model"],
];

/** lbl_105BBF2C + 0x4cc. */
const ON_OFF_ONLY = '"on" and "off" are the only acceptable parameters.';

/**
 * GraphicsCheats.cpp's Callback: case 4 ("grid on|off", in the shipped list)
 * checks for exactly one "on" / "off" word, shows or hides the terrain's
 * grid overlay (cTerrain::ShowOverlay, when the world has a terrain) and
 * redraws the world (XViewer::IssueWorldDirty); case 10 is genable
 * (genableCheat). The other cases switch renderer debug features (sprite
 * decoder flags, damagelist, the sweep meter, people quality...) that this
 * port's renderer does not have: they only log.
 */
function graphicsCheatCallback(ctx: GameContext, host: CheatAppHost, cmd: CheatCommandLine, id: number): boolean {
  const name = GRAPHICS_CHEATS[id]?.[0] ?? "";
  if (name === "genable") return genableCheat(ctx, host, cmd);
  if (name !== "grid") {
    console.log(`not ported: graphics cheat "${name}"`);
    return true;
  }
  const arg = cmd.args[1];
  if (cmd.args.length !== 2 || (arg !== A.on && arg !== A.off)) {
    cmd.errMsg = ON_OFF_ONLY;
    return false;
  }
  const viewer = host.lotView()?.viewer ?? null;
  const terrain = viewer?.terrain;
  if (terrain instanceof Terrain) terrain.showOverlay(arg === A.on);
  if (viewer) viewer.dirty = true;
  return true;
}

/** lbl_105BBF2C + 0x640 .. 0x790: genable's words and status lines, in the status order. */
const GENABLE = {
  default: "default",
  status: "status",
  title: "Genable Status - Enabled HouseViewer Modules",
  yes: "true",
  no: "false",
  all: "all",
  modules: [
    ["terrain", "terrain", "Draw Terrain = %s\n"],
    ["floors", "floors", "Draw Floors = %s\n"],
    ["walls", "walls", "Draw Walls = %s\n"],
    ["clear", "clear", "Clear Refresh = %s\n"],
    ["objects", "objects", "Draw Objects = %s\n"],
    ["people", "people", "Draw People = %s\n"],
    ["fullDraw", "full_draw", "Full Draw = %s\n"],
    ["staticRows", "static_rows", "Draw Static Rows = %s\n"],
    ["static", "static", "Draw Static = %s\n"],
    ["oldClear", "old_clear", "Old Clear = %s\n"],
  ] as ReadonlyArray<readonly [keyof typeof cheatFlags.genable, string, string]>,
} as const;

/** "genable default" (the flags' initial values). */
const GENABLE_DEFAULT: typeof cheatFlags.genable = { ...cheatFlags.genable };

/**
 * The graphics Callback's case 10, "genable": "default" restores the
 * HouseViewer module switches, "status" lists them in a message box,
 * "<module> on|off" sets one ("all": every one but full_draw and old_clear);
 * then GViewer::DirtyAll. Anything else fails with the usage.
 */
function genableCheat(ctx: GameContext, host: CheatAppHost, cmd: CheatCommandLine): boolean {
  const g = cheatFlags.genable;
  const viewer = host.lotView()?.viewer ?? null;
  if (cmd.args.length === 2) {
    const w = cmd.args[1];
    if (w === GENABLE.default) {
      Object.assign(g, GENABLE_DEFAULT);
      if (viewer) viewer.dirty = true;
      return true;
    }
    if (w !== GENABLE.status) return false;
    const text = GENABLE.modules.map(([k, , line]) => line.replace("%s", g[k] ? GENABLE.yes : GENABLE.no)).join("");
    void TSWinMsgBox.show(ctx, text, GENABLE.title);
    return true;
  }
  if (cmd.args.length !== 3) return false;
  const v = cmd.args[2];
  if (v !== A.on && v !== A.off) return false;
  const on = v === A.on;
  const word = cmd.args[1];
  const m = GENABLE.modules.find(([, w]) => w === word);
  if (m) g[m[0]] = on;
  else if (word === GENABLE.all) {
    for (const [k] of GENABLE.modules) if (k !== "fullDraw" && k !== "oldClear") g[k] = on;
  } else return false;
  if (viewer) viewer.dirty = true;
  return true;
}

/** lbl_105BC2E0 strings used by AppCheatCallback. */
const A = {
  codeProblem: "Code problem",
  formatIs: 'Format is "',
  formatEnd: '".',
  oneParam: "Expected one parameter. ",
  on: "on",
  off: "off",
  cantParse: 'Couldn\'t parse parameter "',
  cantParseEnd: '". ',
  noParams: "Expected no parameters. ",
  digitsOnly: "Parameter should be digits only. ",
  noSelected: "No selected person!",
  equals: " = ",
  interestsTitle: "Selected Person Interests",
  rotationRange: "Rotation must be 0, 1, 2, or 3. ",
  nothingHappens: "Nothing happens here.",
  historyFile: "FamilyHistory.txt",
  prepareLot: "Prepare Lot",
} as const;

/** lbl_105BB860: FamilyHistory::DumpToFile's column titles ("%s\t" each, then "\n"). */
const HISTORY_COLUMNS = [
  "Lot#", "#Members", "#Adult Males", "#Adult Females", "#Kid Males", "#Kid Females", "#Workers", "#Objects",
  "Objects Value", "Architecture Value", "House Square Feet", "House Size", "Furnishings Rating", "Size Rating",
  "Yard Rating", "Upkeep Rating", "Layout Rating", "$Income", "$Bills", "$Food", "$Maintenance", "$Objects", "$Misc",
  "$Arch", "$Funds", "Romances Out", "Romances In", "Friends Out", "Friends In", "#Friends",
];

/** FamilyHistory::DumpToFile: the title row, then one row per FamilyStat ("%d\t" each field, then "\n"). */
function dumpFamilyHistory(stats: readonly FamilyStat[]): string {
  let text = `${HISTORY_COLUMNS.map((c) => `${c}\t`).join("")}\n`;
  for (const s of stats) text += `${[...s].map((v) => `${v}\t`).join("")}\n`;
  return text;
}

/** The file the original writes (fopen "w" in the game folder) is handed to the browser as a download. */
function downloadText(name: string, text: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
}

/** lbl_105BB814: RemoveComeSeeMeObjects' selector (ObjectFolder::GetSelectorByName, the OBJD label). */
const COME_SEE_ME = "comeandsee";
/** lbl_105BB97C: the objects PrepareAndTestLot wants on the lot (0-terminated in the original). */
const PREPARE_LOT_GUIDS = [0x81e6bef9, 0x865a6812, 0xef121974, 0xa4258067, 0xaed879c5] as const;
/** lbl_105BB990 + 0x187 / + 0x185. */
const NO_INSTANCE = "Lot doesn't have an instance of ";
/** cSimulator::PeriodToSimSpeed(cSimulator::MedPeriod() = 0x2a) = 760: the first speed button (CPState speeds are buttons here). */
const MED_SPEED_BUTTON = 1;

/**
 * AppCheatCallback case 22 ("prepare_lot"): Neighborhood::PrepareAndTestLot
 * (RemoveComeSeeMeObjects, then the first of the wanted objects missing from
 * the lot while the folder has it is reported), CPState rotation 0, unpaused,
 * the medium speed, zoom 2, walls cut away; every person's autonomy (person
 * data 0x24) 50 and person data 0x1d 0; ObjectModule::CleanupPeople(0); the
 * report, if any, in a "Prepare Lot" box. A map_edit tile tool is put away
 * (lbl_105BA68C cleared, CPState::SetCheatTool(0)).
 */
async function prepareLot(ctx: GameContext, host: CheatAppHost): Promise<boolean> {
  const sim = host.lotView()?.sim ?? null;
  let report = "";
  if (sim) {
    const m = sim.module;
    for (const o of [...m.list]) if (!o.killed && o.obj.selector.name.toLowerCase() === COME_SEE_ME) m.killObject(o);
    const folder = await ObjectFolder.get(ctx.hooks?.neighborhoodDir?.() ?? "UserData");
    for (const guid of PREPARE_LOT_GUIDS) {
      if (m.getInstances(guid | 0).some((o) => !o.killed)) continue;
      const sel = await folder.getSelectorByGUID(guid | 0);
      if (!sel) continue;
      report = `${NO_INSTANCE}${sel.name}.`;
      break;
    }
  }
  const s = ctx.state;
  s.setRotation(0);
  s.pause(false);
  s.setSpeed(MED_SPEED_BUTTON);
  s.setZoom(2);
  s.setWallState(WallState.Cutaway);
  // lbl_105BA68C: a map_edit tile tool is put away (CPState::SetCheatTool(0)).
  if (cheatFlags.mapEdit) {
    cheatFlags.mapEdit = false;
    s.setCheatTool(null);
  }
  if (sim) {
    for (const p of sim.module.persons) {
      p.pd[0x24] = 50;
      p.pd[0x1d] = 0;
    }
    for (const p of [...sim.module.people]) p.cleanup();
  }
  if (report) await TSWinMsgBox.show(ctx, report, A.prepareLot);
  return true;
}

/** lbl_105BC2E0 + 0x611 .. 0x641: sim_log's words and errors. */
const SIM_LOG = {
  begin: "begin",
  end: "end",
  already: "Simulation logging is already begun.\n",
  notYet: "Simulation logging has not yet begun.\n",
} as const;

/**
 * AppCheatCallback case 6 ("sim_log begin|end"): another word fails with the
 * usage ("Format is ..."), "begin" while logging and "end" while not fail
 * with their message; else SimLog::BeginLogging / EndLogging (SimLog.txt,
 * written to the game folder by the original, is handed over as a download).
 */
async function simLogCheat(ctx: GameContext, cmd: CheatCommandLine, format: string): Promise<boolean> {
  const arg = cmd.args[1] ?? "";
  const begin = arg === SIM_LOG.begin;
  if (!begin && arg !== SIM_LOG.end) {
    cmd.errMsg = format;
    return false;
  }
  if (begin && simLog.logging) {
    cmd.errMsg = SIM_LOG.already + format;
    return false;
  }
  if (!begin && !simLog.logging) {
    cmd.errMsg = SIM_LOG.notYet + format;
    return false;
  }
  if (begin) {
    simLog.beginLogging();
    return true;
  }
  downloadText(SIM_LOG_STRINGS.file, simLog.endLogging());
  await TSWinMsgBox.show(ctx, SIM_LOG_STRINGS.done, SIM_LOG_STRINGS.title);
  return true;
}

/** What the app cheats reach: the loaded lot (cSimsApp's simulator, views and CPState). */
export interface CheatAppHost {
  lotView(): WinLotView | null;
}

/** AppCheatCallback: checks the words against the cheat's type, then runs case `id`. */
async function appCheatCallback(ctx: GameContext, host: CheatAppHost, cmd: CheatCommandLine, id: number): Promise<boolean> {
  const cheat = APP_CHEATS.find((c) => c[0] === id);
  if (!cheat) {
    cmd.errMsg = A.codeProblem;
    return false;
  }
  const [, type, name] = cheat;
  // GetShortUsageStr: name + " " + arguments ("").
  const format = `${A.formatIs}${name} ${A.formatEnd}`;
  let on = false;
  let n = 0;
  if (type === CT.OnOff) {
    if (cmd.args.length !== 2) {
      cmd.errMsg = A.oneParam + format;
      return false;
    }
    const arg = cmd.args[1]!;
    if (arg !== A.on && arg !== A.off) {
      cmd.errMsg = A.cantParse + arg + A.cantParseEnd + format;
      return false;
    }
    on = arg === A.on;
  } else if (type === CT.None) {
    if (cmd.args.length !== 1) {
      cmd.errMsg = A.noParams + format;
      return false;
    }
  } else if (type === CT.Number) {
    if (cmd.args.length !== 2) {
      cmd.errMsg = A.oneParam + format;
      return false;
    }
    const arg = cmd.args[1]!;
    if (![...arg].every((c) => (c >= "0" && c <= "9") || c === "-")) {
      cmd.errMsg = A.digitsOnly + format;
      return false;
    }
    n = Number.parseInt(arg, 10) || 0;
  }
  const view = host.lotView();
  const sim = view?.sim ?? null;
  switch (id) {
    case 0: {
      // interests: the selected person's person data 0x2e..0x35 named by STR# 200 entries 0x2f..0x36.
      const person = view?.selectedPerson() ?? null;
      if (!person) {
        cmd.errMsg = A.noSelected;
        return false;
      }
      const names = await personDataLabels(ctx);
      if (names) {
        let text = "";
        for (let i = 0x2e; i < 0x36; i++) text += `${names[i + 1] ?? ""}${A.equals}${person.pd[i] ?? 0}\n`;
        await TSWinMsgBox.show(ctx, text, A.interestsTitle);
      }
      return true;
    }
    case 1:
      // lbl_105BA914: nothing in the shipped build reads it.
      cheatFlags.drawRoutes = on;
      return true;
    case 3:
      // lbl_105BA690 (the upper level's build grid), then GViewer::DirtyAll.
      cheatFlags.drawFloorable = on;
      if (view?.viewer) view.viewer.dirty = true;
      return true;
    case 6:
      return simLogCheat(ctx, cmd, format);
    case 8: {
      // lbl_105BA68C changes only through a working tool 8 (cGameTools::GetToolByID).
      if (cheatFlags.mapEdit === on) return true;
      const tool = view?.gameTools?.getToolByID(8) ?? null;
      if (!tool || !view) return true;
      cheatFlags.mapEdit = on;
      // GViewer::DirtyAll: the map overlay (HouseViewer::RenderStaticRow) appears or goes.
      if (view.viewer) view.viewer.dirty = true;
      if (on) tool.setParameter(0);
      ctx.state.setCheatTool(on ? 8 : null);
      return true;
    }
    case 10:
      cheatFlags.moveObjects = on;
      return true;
    case 12:
      if (n < 0 || n > 3) {
        cmd.errMsg = A.rotationRange + format;
        return false;
      }
      ctx.state.setRotation(n);
      return true;
    case 14:
      // Every person's person data 0x24 (cXPerson +0x5d4), the autonomy level ObjTestSim reads.
      if (sim) for (const p of sim.module.persons) p.pd[0x24] = n;
      return true;
    case 22:
      return prepareLot(ctx, host);
    case 25:
      ctx.state.setSpeed(n);
      return true;
    case 28:
      // Simulator global 25, bit 0.
      if (sim) sim.globals[0x19] = (sim.globals[0x19]! & ~1) | (on ? 1 : 0);
      return true;
    case 38:
      cmd.errMsg = A.nothingHappens;
      return false;
    case 52:
      cheatFlags.drawAllFrames = on;
      return true;
    case 54:
      cheatFlags.logMask = n;
      return true;
    case 68: {
      // cSimulator +0x10's Family (the lot's family, global 9) -> Family::GetHistory.
      const fn = sim?.globals[9] ?? 0;
      const fam = fn === 0 ? undefined : sim?.module.nbhd?.families.find((f) => f.chunkId === fn);
      if (!fam) return false;
      // StringBuffer "FamilyHistory.txt", or the second word as typed.
      const path = cmd.raw.length === 2 ? cmd.raw[1]! : A.historyFile;
      downloadText(path.slice(path.search(/[^\\/:]*$/)), dumpFamilyHistory(getFamilyHistory(fam)));
      return true;
    }
    case 77:
      cheatFlags.bubbleTweak = n;
      return true;
    case 78:
      // lbl_105BA350 (never set) would zero the funds instead.
      if (sim) {
        sim.setFunds(sim.getFunds() + 1000);
        // UpdateCPStateFromWorld's funds (the control panel shows them next frame).
        ctx.state.setFunds(sim.getFunds());
      }
      return true;
    default:
      console.log(`not ported: cheat "${name}" (AppCheatCallback case ${id})`);
      return true;
  }
}

/** StringSetBase::Load(..., 200): the person data names (Behavior.iff STR# 200). */
let personDataNames: Promise<string[] | null> | null = null;
function personDataLabels(ctx: GameContext): Promise<string[] | null> {
  personDataNames ??= (async () => {
    const { data, chunks } = await readStandaloneIff("Sims/GameData/Behavior.iff");
    const c = chunks.find((k) => k.kind === "STR#" && k.id === 200);
    return c ? ctx.strings.parse(data.subarray(c.dataStart, c.dataStart + c.dataLen)) : null;
  })();
  return personDataNames;
}

/**
 * cSimsApp::Init's cheat part (RegisterCheats, the cheat widget) and the
 * main window's key (cTSMainWindowW95::TSOnKeyDown). Call once at boot.
 */
export async function installCheatConsole(ctx: GameContext, host: CheatAppHost, restricted: boolean): Promise<TSCheatCodeManager> {
  const mgr = new TSCheatCodeManager(ctx, restricted);
  manager = mgr;
  GRAPHICS_CHEATS.forEach(([name, usage], i) => {
    mgr.registerCheat(name, (cmd, data) => graphicsCheatCallback(ctx, host, cmd, data), i, usage);
  });
  for (const [id, , name] of APP_CHEATS) {
    // GetUsageStr: name + " " + arguments + " - " + description.
    mgr.registerCheat(name, (cmd, data) => appCheatCallback(ctx, host, cmd, data), id, `${name}  - `);
  }
  const widget = new CheatWidget(mgr);
  await widget.create(await ctx.fonts.acquire(10));
  cheatWidget = widget;
  // cDDDSimsView::Init: SetupHelpList(font table entry 9).
  await mgr.setupHelpList(await ctx.fonts.acquire(9));
  // cTSMainWindowW95::TSOnKeyDown: Ctrl+Shift+C (B for app language 0x10; the French
  // build uses C) shows the widget; once up, its edit holds the focus and takes the keys.
  winMgr.mainKeyDown = (key) => {
    if (!(winMgr.isKeyDown("Control") && winMgr.isKeyDown("Shift") && (key === "c" || key === "C"))) return false;
    widget.show();
    return true;
  };
  return mgr;
}
