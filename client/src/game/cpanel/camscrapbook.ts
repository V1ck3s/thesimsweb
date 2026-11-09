/**
 * The family photo album: cScrapbook (Scrapbook.cpp, the pages on disk) and
 * cWinScrapbook (the album window of the camera panel and of a snapshot).
 *
 * cScrapbook (one per family, Family::GetScrapbook, loaded once):
 *  - the folder is <neighborhood>/PhotoAlbum/ (lbl_105BB85C), the file
 *    prefix Family::GetExportName = "<family name>_<family number>";
 *  - a page is three files: <prefix>_NNNN.jpg (the photo), <prefix>_NNNN_thumb.jpg
 *    (MakeJPEGThumbFileName, the photo scaled into 100 x 75) and
 *    <prefix>_NNNN.txt (the description, raw characters);
 *  - LoadScrapbook: the JPGs starting with the prefix (not the thumbnails)
 *    give the base numbers (ExtractBaseNum: the digits before the dot; the
 *    next photo takes the highest + 1), then every TXT starting with the
 *    prefix whose number has a JPG is a page (state 2: not loaded yet);
 *  - page states (cPage +0): 1 loaded / saved, 2 on disk, 3 description
 *    changed, 4 new photo; cPage::Save writes the TXT for 3 and 4, and for 4
 *    the photo (SaveGimex with the camera quality) and its thumbnail
 *    (SaveScaledGimex: 100 x 75, the height kept to the ratio above a
 *    width / height of 1.334, the width below 1.32);
 *  - AddPhoto: a new page at the end (description "No Description",
 *    UIText STR# 154 entry 4), saved at once, then reloaded from the files;
 *  - DeleteCurrentPage deletes the three files.
 *
 * Here the files go through the overlay (data/files.ts) and JPEGs are
 * encoded by the browser (Gimex's encoder is not ported: same size and
 * quality, other bytes).
 *
 * CommitChanges (Family::SaveFamily, each Neighborhood::Save) marks the
 * photos taken so far as kept (+0x238 := +0x14); RevertScrapbook (the
 * Family destructor: the neighborhood is dropped when the lot is left)
 * deletes the pages numbered from there on, so photos of a lot left without
 * saving go away.
 */

import { assetFetch, fetchManifest } from "../../engine/assets.js";
import type { GameContext } from "../context.js";
import { deleteGameFile, writeGameFile } from "../data/files.js";
import { neighborhoodSavedHooks } from "../data/nbhdstore.js";
import { loadNeighborhood, PD } from "../data/neighborhood.js";
import { Neighborhood, Zone } from "../nbhd/nghinterface.js";
import type { FfnFont } from "../res/ffn.js";
import { TSWinBtn } from "../ui/btn.js";
import { TSWinDlg } from "../ui/dlg.js";
import { IDYES, MB_YESNO, TSWinMsgBox } from "../ui/msgbox.js";
import { rgb, UI_FONT_COLOR } from "../ui/syscolors.js";
import { TSWinTextEdit2 } from "../ui/textedit.js";
import { Gfx, type TSWin, WF_NO_FOCUS } from "../ui/tswin.js";
import { winMgr } from "../ui/winmgr.js";
import { UI_LANGUAGE } from "../res/uires.js";
import { gameTextDecoder } from "../res/codepage.js";

/** lbl_105BB85C: the album folder under the neighborhood. */
const ALBUM_DIR = "PhotoAlbum/";
/** lbl_105BC20C strings. */
const THUMB_SUFFIX = "_thumb.jpg";
/** UIText STR# 154 (LoadUIStrings(0x9a)), GetString(4): "No Description". */
const STR_MISC = 154;
const NO_DESCRIPTION_ENTRY = 3;
/** cScrapbook::MakeCurThumb / cPage::Save: the thumbnail box and the ratio limits (lbl_105BC208). */
const THUMB_W = 100;
const THUMB_H = 0x4b;
const RATIO_WIDE = 1.334;
const RATIO_TALL = 1.32;
/** cPage +8 default (-1) becomes 0x5a when saved. */
const DEFAULT_QUALITY = 0x5a;

const enum PageState {
  Loaded = 1,
  OnDisk = 2,
  Described = 3,
  New = 4,
}

/** cScrapbook::cPage */
interface Page {
  state: PageState;
  /** +4: the photo (decoded JPEG). */
  photo: ImageBitmap | null;
  /** +8: JPEG quality. */
  quality: number;
  /** +0xc */
  description: string;
  /** +0x10 / +0x120 / +0x230: game-relative paths of the photo, its thumbnail and its description. */
  file: string;
  thumb: string;
  text: string;
  /** +0x340 */
  num: number;
  /** A new photo's pixels until they are saved. */
  pending: OffscreenCanvas | null;
}

/** The description files hold the game's 8-bit characters. */
function encodeText(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i] = c < 0x100 ? c : 0x3f;
  }
  return out;
}

/** cScrapbook::ExtractBaseNum: the digits right before the extension, -1 without. */
function extractBaseNum(name: string): number {
  const m = /(\d+)\.[^.]*$/.exec(name);
  return m ? Number.parseInt(m[1]!, 10) : -1;
}

/** MakeJPEGThumbFileName: <dir><photo name without extension>_thumb.jpg. */
function thumbFileName(dir: string, file: string): string {
  const name = file.slice(file.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return `${dir}${dot < 0 ? name : name.slice(0, dot)}${THUMB_SUFFIX}`;
}

/** The thumbnail size of SaveScaledGimex: 100 x 75, one side kept to the photo's ratio. */
function thumbSize(w: number, h: number): { w: number; h: number } {
  let tw = THUMB_W;
  let th = THUMB_H;
  const ratio = w / h;
  if (ratio > RATIO_WIDE) th = Math.trunc((h * 100) / w);
  if (ratio < RATIO_TALL) tw = Math.trunc((w * 0x4b) / h);
  return { w: tw, h: th };
}

async function encodeJpeg(src: CanvasImageSource, w: number, h: number, quality: number): Promise<Blob> {
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext("2d")!;
  g.imageSmoothingQuality = "high";
  g.drawImage(src, 0, 0, w, h);
  return c.convertToBlob({ type: "image/jpeg", quality: quality / 100 });
}

export class Scrapbook {
  private readonly pages: Page[] = [];
  /** +0xc */
  private cur = 0;
  /** +0x14: the number of the next photo. */
  private nextNum = 0;
  /** +0x238: the first photo number not committed (CommitChanges). */
  private committed = 0;

  private constructor(
    /** +0x18 / +0x128: the album folder (game-relative, with the trailing slash). */
    private readonly dir: string,
    /** Family::GetExportName */
    private readonly exportName: string,
    private readonly noDescription: string,
  ) {}

  /** cScrapbook::LoadScrapbook */
  static async load(ctx: GameContext, nbhdDir: string, exportName: string): Promise<Scrapbook> {
    const dir = `${nbhdDir}/${ALBUM_DIR}`;
    const book = new Scrapbook(dir, exportName, ctx.strings.get("UIText", STR_MISC, NO_DESCRIPTION_ENTRY) || "No Description");
    const prefix = `sims/${dir}`.toLowerCase();
    const names = (await fetchManifest()).files
      .filter((f) => f.path.toLowerCase().startsWith(prefix) && !f.path.slice(prefix.length).includes("/"))
      .map((f) => f.path.slice(prefix.length))
      .sort((a, b) => (a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0));
    const own = (n: string): boolean => n.toLowerCase().startsWith(exportName.toLowerCase());
    const photos = new Map<number, string>();
    for (const n of names) {
      const lower = n.toLowerCase();
      if (!own(n) || !lower.endsWith(".jpg") || lower.includes(THUMB_SUFFIX)) continue;
      const num = extractBaseNum(n);
      photos.set(num, n);
      book.nextNum = Math.max(book.nextNum, num + 1);
    }
    for (const n of names) {
      if (!own(n) || !n.toLowerCase().endsWith(".txt")) continue;
      const num = extractBaseNum(n);
      const photo = photos.get(num);
      if (photo === undefined) continue;
      book.pages.push({
        state: PageState.OnDisk,
        photo: null,
        quality: -1,
        description: book.noDescription,
        file: dir + photo,
        thumb: thumbFileName(dir, photo),
        text: dir + n,
        num,
        pending: null,
      });
    }
    book.committed = book.nextNum;
    return book;
  }

  /** cScrapbook::CommitChanges */
  commitChanges(): void {
    this.committed = this.nextNum;
  }

  /** cScrapbook::RevertScrapbook: every page numbered from +0x238 on is deleted (SetCurPage, DeleteCurrentPage). */
  async revertScrapbook(): Promise<void> {
    for (;;) {
      const i = this.pages.findIndex((p) => p.num >= this.committed);
      if (i < 0) return;
      this.setCurPage(i);
      await this.deleteCurrentPage();
    }
  }

  getPageCount(): number {
    return this.pages.length;
  }

  getCurPage(): number {
    return this.cur;
  }

  /** cScrapbook::SetCurPage: clamped to the pages. */
  setCurPage(i: number): void {
    this.cur = i < 0 || this.pages.length === 0 ? 0 : Math.min(i, this.pages.length - 1);
  }

  /** cScrapbook::GetFilename */
  getFilename(): string | null {
    return this.pages[this.cur]?.file ?? null;
  }

  /** cScrapbook::GetThumbFilename */
  getThumbFilename(): string | null {
    return this.pages[this.cur]?.thumb ?? null;
  }

  /**
   * cScrapbook::MakeCurThumb: the current page's photo (when loaded) saved
   * into its thumbnail file, scaled into 100 x 75 (SaveScaledGimex, the
   * page's quality, 0x5a when unset).
   */
  async makeCurThumb(): Promise<boolean> {
    const p = this.pages[this.cur];
    if (!p?.photo) return false;
    if (p.quality < 0) p.quality = DEFAULT_QUALITY;
    try {
      const t = thumbSize(p.photo.width, p.photo.height);
      const thumb = await encodeJpeg(p.photo, t.w, t.h, p.quality);
      await writeGameFile(p.thumb, new Uint8Array(await thumb.arrayBuffer()));
      return true;
    } catch (e) {
      console.warn("scrapbook: thumbnail failed", e);
      return false;
    }
  }

  /** cScrapbook::GetDescription (loads the page first). */
  getDescription(): string | null {
    return this.pages[this.cur]?.description ?? null;
  }

  /** cScrapbook::GetPhoto (loads the page first). */
  getPhoto(): ImageBitmap | null {
    return this.pages[this.cur]?.photo ?? null;
  }

  /** The cPage::Load that GetDescription / GetPhoto run on a page still on disk. */
  async loadCurrent(): Promise<void> {
    const p = this.pages[this.cur];
    if (p && p.state === PageState.OnDisk) await this.loadPage(p);
  }

  /** cScrapbook::SetDescription: the current page is rewritten at the next save. */
  setDescription(text: string): void {
    const p = this.pages[this.cur];
    if (!p) return;
    p.description = text;
    if (p.state !== PageState.New) p.state = PageState.Described;
  }

  /** cScrapbook::AddPhoto: a new last page, saved at once, then reloaded from its files. */
  async addPhoto(photo: OffscreenCanvas, quality: number): Promise<boolean> {
    const base = `${this.exportName}_${String(this.nextNum).padStart(4, "0")}`;
    const p: Page = {
      state: PageState.New,
      photo: null,
      quality,
      description: this.noDescription,
      file: `${this.dir}${base}.jpg`,
      thumb: `${this.dir}${base}${THUMB_SUFFIX}`,
      text: `${this.dir}${base}.txt`,
      num: this.nextNum,
      pending: photo,
    };
    this.pages.push(p);
    this.nextNum++;
    this.cur = this.pages.length - 1;
    if (!(await this.savePage(p))) {
      this.pages.pop();
      this.nextNum--;
      this.cur = Math.max(0, this.pages.length - 1);
      return false;
    }
    p.state = PageState.OnDisk;
    await this.loadPage(p);
    return true;
  }

  /** cScrapbook::DeleteCurrentPage: the page and its three files. */
  async deleteCurrentPage(): Promise<void> {
    const p = this.pages[this.cur];
    if (!p) return;
    // CTGFileManager::DeleteFileA: files of the read-only game folder stay (only the overlay's go).
    for (const f of [p.file, p.thumb, p.text]) await deleteGameFile(f).catch(() => undefined);
    this.pages.splice(this.cur, 1);
    if (this.cur >= this.pages.length) this.cur = this.pages.length - 1;
    if (this.cur < 0) this.cur = 0;
  }

  /** cScrapbook::SaveScrapbook: every page; true when all saved. */
  async saveScrapbook(): Promise<boolean> {
    let ok = 0;
    for (const p of this.pages) if (await this.savePage(p)) ok++;
    return ok === this.pages.length;
  }

  /** cScrapbook::cPage::Save */
  private async savePage(p: Page): Promise<boolean> {
    if (p.state !== PageState.Described && p.state !== PageState.New) return true;
    try {
      await writeGameFile(p.text, encodeText(p.description));
      if (p.state === PageState.New && p.pending) {
        const src = p.pending;
        if (p.quality < 0) p.quality = DEFAULT_QUALITY;
        const photo = await encodeJpeg(src, src.width, src.height, p.quality);
        await writeGameFile(p.file, new Uint8Array(await photo.arrayBuffer()));
        const t = thumbSize(src.width, src.height);
        const thumb = await encodeJpeg(src, t.w, t.h, p.quality);
        await writeGameFile(p.thumb, new Uint8Array(await thumb.arrayBuffer()));
        p.pending = null;
      }
      p.state = PageState.Loaded;
      return true;
    } catch (e) {
      console.warn("scrapbook: save failed", e);
      return false;
    }
  }

  /** cScrapbook::cPage::Load: the description file, then the photo. */
  private async loadPage(p: Page): Promise<boolean> {
    p.photo?.close();
    p.photo = null;
    p.description = "";
    const text = await assetFetch(`Sims/${p.text}`, { cache: "no-store" }).catch(() => null);
    if (!text?.ok) return false;
    p.description = gameTextDecoder.decode(await text.arrayBuffer());
    const img = await assetFetch(`Sims/${p.file}`, { cache: "no-store" }).catch(() => null);
    p.photo = img?.ok ? await createImageBitmap(await img.blob()).catch(() => null) : null;
    if (!p.photo) return false;
    p.state = PageState.Loaded;
    return true;
  }
}

/** Family +0x148, per neighborhood and export name. */
const scrapbooks = new Map<string, Promise<Scrapbook>>();

neighborhoodSavedHooks.add((dir) => {
  for (const [key, book] of scrapbooks) if (key.startsWith(`${dir}/`)) void book.then((b) => b.commitChanges()).catch(() => undefined);
});

/** ~Family for every family of the dropped neighborhood: RevertScrapbook, and the albums are read again next time. */
export async function revertScrapbooks(): Promise<void> {
  const books = [...scrapbooks.values()];
  scrapbooks.clear();
  for (const p of books) await (await p.catch(() => null))?.revertScrapbook();
}

/**
 * Family::GetScrapbook of the family HouseViewer::UpdateWorld and
 * cWinScrapbook::Init pick: on a residential lot the lot's family, elsewhere
 * the family of the selected person. null when there is none.
 */
export async function currentScrapbook(ctx: GameContext): Promise<Scrapbook | null> {
  const dir = ctx.hooks?.neighborhoodDir?.();
  if (!dir) return null;
  const house = ctx.state.houseNumber;
  const nb = await Neighborhood.load(dir);
  let family = nb.getZoningType(house) === Zone.Residential ? nb.getFamilyInHouse(house) : undefined;
  if (!family && nb.getZoningType(house) !== Zone.Residential) {
    const guid = ctx.state.personGetSelected()?.guid;
    const data = await loadNeighborhood(dir);
    const person = guid === undefined ? undefined : data.neighbors.find((n) => (n.guid | 0) === (guid | 0));
    const number = person?.personData?.[PD.familyNumber];
    family = number === undefined ? undefined : data.families.find((f) => f.familyNumber === number);
  }
  if (!family) return null;
  // Family::GetExportName: the family's name, "_", its number.
  const exportName = `${family.name}_${family.familyNumber}`;
  const key = `${dir}/${exportName}`;
  let book = scrapbooks.get(key);
  if (!book) {
    book = Scrapbook.load(ctx, dir, exportName);
    scrapbooks.set(key, book);
  }
  return book;
}

/** cWinCPanel::SetScrapbookOpen listeners (the camera panel's album button). */
export const scrapbookOpenListeners = new Set<(open: boolean) => void>();

/** UIText STR# 144 "ScrapStrs" (LoadUIStrings(0x90)). */
const STR_SCRAPBOOK = 0x90;
/** lbl_105BC540: kScrapDone, kScrapDelete, kScrapLeft, kScrapRight, kScrapHome, kScrapEnd. */
const BUTTON_IMAGES = [1201, 1202, 1203, 1204, 1205, 1206];
const enum Btn {
  Done = 0,
  Delete = 1,
  Previous = 2,
  Next = 3,
  First = 4,
  Last = 5,
}
/** lbl_105BA928 (InitSimsColors): white. */
const WHITE = rgb(0xff, 0xff, 0xff);
/** cTSWinBtn::SetFont: lbl_105BA2E8 + 0x30 (size 12) for language 7, else + 0x38 (size 14). */
const BUTTON_FONT_SIZE = UI_LANGUAGE === 7 ? 12 : 14;
/** lbl_105BA2E8 + 0x28 / + 0x48: the description and the empty album text. */
const EDIT_FONT_SIZE = 10;
const EMPTY_FONT_SIZE = 18;
const EDIT_CAPACITY = 0x1000;

/** StringPosToPoint: "(x;y)". */
function point(s: string | undefined): { x: number; y: number } {
  const m = /\(\s*(-?\d+)\s*;\s*(-?\d+)\s*\)/.exec(s ?? "");
  return { x: Number(m?.[1] ?? 0), y: Number(m?.[2] ?? 0) };
}

/**
 * cWinScrapbook: kScrapBack with the photo centered on a point, the
 * description edit under it and six buttons (Done, Delete, previous, next,
 * first, last), laid out from UIText STR# 144. Done stores the description
 * and saves the album, Delete asks first (cSimsApp::MessageDialog yes / no),
 * the arrows store the description and turn the page. The file name text
 * (a hidden cTSWinText) is not created.
 */
export class WinScrapbook extends TSWinDlg {
  /** +0xcc */
  private background: ImageBitmap | null = null;
  /** +0xd0..+0xe4 */
  private readonly btns: TSWinBtn[] = [];
  /** +0xec */
  private book: Scrapbook | null = null;
  /** +0xf0 */
  private edit: TSWinTextEdit2 | null = null;
  /** +0xf8 / +0xfc / +0x100 */
  private deleteTitle = "";
  private deleteText = "";
  private emptyText = "";
  /** +0x104 / +0x108: the photo's center. */
  private photoCenter = { x: 0, y: 0 };
  private emptyFont: FfnFont | null = null;
  /** lbl_105C0E40: the delete question is up. */
  private asking = false;

  constructor(private readonly ctx: GameContext) {
    super();
  }

  /** cWinScrapbook::Init */
  override async init(): Promise<boolean> {
    const { res, strings, fonts } = this.ctx;
    this.background = await res.image("kScrapBack");
    this.setSize(this.background.width, this.background.height);
    const table = strings.list("UIText", STR_SCRAPBOOK);
    let it = 0;
    const next = (): string => table[it++] ?? "";
    const [buttonFont, editFont, emptyFont] = await Promise.all([fonts.acquire(BUTTON_FONT_SIZE), fonts.acquire(EDIT_FONT_SIZE), fonts.acquire(EMPTY_FONT_SIZE)]);
    this.emptyFont = emptyFont;
    for (let i = 0; i < BUTTON_IMAGES.length; i++) {
      const b = new TSWinBtn(i + 1, await res.image(BUTTON_IMAGES[i]!), 4, 1);
      this.childAdd(b);
      const p = point(next());
      b.moveTo(p.x, p.y);
      if (i === Btn.Done || i === Btn.Delete) {
        b.caption = next();
        b.font = buttonFont;
      }
      b.tooltip = next();
      b.setFlag(WF_NO_FOCUS, true);
      this.btns.push(b);
    }
    const edit = new TSWinTextEdit2();
    edit.setFont(editFont);
    edit.setTextColor(WHITE);
    const size = point(next());
    const at = point(next());
    edit.setArea(at.x, at.y, at.x + size.x, at.y + size.y);
    edit.target = this;
    edit.setLinesAllowed(-1);
    edit.setColors(WHITE, WHITE, WHITE);
    edit.setCapacity(EDIT_CAPACITY);
    edit.setFlashFrameOnEmpty(false);
    edit.setDrawFrameOnFocus(false);
    edit.setTransparent(true);
    this.childAdd(edit);
    this.edit = edit;
    this.photoCenter = point(next());
    // The file name text: position, size, tooltip (hidden in the original).
    it += 3;
    this.deleteTitle = next();
    this.deleteText = next();
    this.emptyText = next();
    this.book = await currentScrapbook(this.ctx);
    if (!this.book) return false;
    await this.update();
    return true;
  }

  /** cWinScrapbook::TSBeginModal: the description gets the focus, the panel's album button goes down. */
  override tsBeginModal(): void {
    super.tsBeginModal();
    if (this.edit) winMgr.setFocus(this.edit);
    for (const l of scrapbookOpenListeners) l(true);
  }

  /** cWinScrapbook::TSEndModal */
  override tsEndModal(): void {
    super.tsEndModal();
    for (const l of scrapbookOpenListeners) l(false);
  }

  /** cWinScrapbook::Update: the page's description, the buttons the page allows. */
  private async update(): Promise<void> {
    const book = this.book;
    const edit = this.edit;
    if (!book || !edit) return;
    await book.loadCurrent();
    edit.setText(book.getDescription() ?? "");
    const cur = book.getCurPage();
    const count = book.getPageCount();
    this.btns[Btn.Previous]?.setEnabled(cur !== 0 && count !== 0);
    this.btns[Btn.First]?.setEnabled(cur !== 0 && count !== 0);
    this.btns[Btn.Next]?.setEnabled(cur < count - 1);
    this.btns[Btn.Last]?.setEnabled(cur < count - 1);
    this.btns[Btn.Delete]?.setEnabled(count !== 0);
    if (count === 0) edit.hideWindow();
  }

  /** cWinScrapbook::TSOnCommand */
  override tsOnCommand(cmd: number, src: TSWin): boolean {
    const i = this.btns.indexOf(src as TSWinBtn);
    if (i < 0 || cmd !== i + 1) return super.tsOnCommand(cmd, src);
    void this.onButton(i);
    return true;
  }

  private async onButton(i: number): Promise<void> {
    const book = this.book;
    if (!book) return;
    const text = this.edit?.getText() ?? "";
    switch (i) {
      case Btn.Done:
        book.setDescription(text);
        await book.saveScrapbook();
        this.tsEndDialog(0);
        return;
      case Btn.Delete: {
        if (this.asking) return;
        this.asking = true;
        try {
          if ((await TSWinMsgBox.show(this.ctx, this.deleteText, this.deleteTitle, MB_YESNO)) === IDYES) {
            await book.deleteCurrentPage();
            await book.saveScrapbook();
            if (book.getPageCount() === 0) {
              this.tsEndDialog(0);
              return;
            }
          }
          await this.update();
        } finally {
          this.asking = false;
        }
        return;
      }
      case Btn.Previous:
        book.setDescription(text);
        book.setCurPage(book.getCurPage() - 1);
        break;
      case Btn.Next:
        book.setDescription(text);
        book.setCurPage(book.getCurPage() + 1);
        break;
      case Btn.First:
        book.setDescription(text);
        book.setCurPage(0);
        break;
      case Btn.Last:
        book.setDescription(text);
        book.setCurPage(book.getPageCount());
        break;
    }
    await this.update();
  }

  /** cWinScrapbook::TSPaint: the background, then the photo centered on its point, or the empty album text. */
  override tsPaint(g: Gfx): void {
    if (!this.background) return;
    g.blit(this.background, 0, 0);
    const c = this.photoCenter;
    const photo = this.book?.getPhoto() ?? null;
    if (photo) {
      g.blit(photo, c.x - Math.trunc(photo.width / 2), c.y - Math.trunc(photo.height / 2));
    } else if (this.emptyFont) {
      const f = this.emptyFont;
      f.drawText(g.ctx, this.emptyText, g.ox + c.x - Math.trunc(f.stringWidth(this.emptyText) / 2), g.oy + c.y - Math.trunc(f.height / 2), UI_FONT_COLOR);
    }
  }
}

/** lbl_105C0272: one album at a time. */
let albumOpen = false;

/**
 * cDDDSimsView::TSOnCommand(0x1f): cWinScrapbook centered on the main
 * window, run modally (the camera panel's album button and the end of a
 * snapshot). Nothing opens without a family.
 */
export async function showScrapbook(ctx: GameContext): Promise<void> {
  if (albumOpen) return;
  albumOpen = true;
  try {
    const win = new WinScrapbook(ctx);
    if (!(await win.init())) return;
    const main = winMgr.main;
    win.moveTo(Math.trunc((main.getW() - win.getW()) / 2), Math.trunc((main.getH() - win.getH()) / 2));
    await winMgr.doModalWin(win);
  } finally {
    albumOpen = false;
  }
}
