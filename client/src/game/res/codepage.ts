/**
 * The game's character set. The original keeps every string (the STR# and
 * CTSS chunks, names typed by the player, the files it writes) as bytes in the
 * Windows code page of its language and draws those bytes with the font of
 * that language (cTSFontSys::TSAcquireFont, res/fonts.ts). The port keeps
 * strings as Unicode: they are decoded from the code page when read and
 * encoded back when drawn or written, so the fonts and the files see the
 * original's bytes.
 *
 * The code page of a language follows the fonts the original picks for it:
 * Polish draws Fonts/Polish (1250), Russian Fonts/Russian (1251), Japanese the
 * Shift-JIS fonts (932), Simplified Chinese font16gb (GB, 936), Traditional
 * Chinese font16b5 (Big5, 950), Thai font20th (874), Korean FONT12K
 * (KS X 1001, 949); Hebrew (1255) and the western languages draw VariableSans.
 * The strings of the game files agree (UIText.iff language 17 is GB, 18 is
 * Big5). cTSLanguageUtility::GetCharacterSetFromLanguage (nbhd/imports.ts),
 * which only compares the character sets of two languages, gives 950 to
 * language 17 and 936 to 18.
 */

import { UI_LANGUAGE } from "./uires.js";

/** The WHATWG encoding label of a language's code page. */
export function codePageLabel(lang: number): string {
  switch (lang) {
    case 12:
      return "windows-1255";
    case 13:
      return "windows-1251";
    case 15:
      return "shift_jis";
    case 16:
      return "windows-1250";
    case 17:
      return "gbk";
    case 18:
      return "big5";
    case 19:
      return "windows-874";
    case 20:
      return "euc-kr";
    default:
      return "windows-1252";
  }
}

/** Double-byte code pages: a lead byte and a trail byte per character outside ASCII. */
const DOUBLE_BYTE = new Set(["shift_jis", "gbk", "big5", "euc-kr"]);

class CodePage {
  readonly decoder: TextDecoder;
  readonly doubleByte: boolean;
  private table: Map<string, number> | null = null;

  constructor(readonly label: string) {
    this.decoder = new TextDecoder(label);
    this.doubleByte = DOUBLE_BYTE.has(label);
  }

  /** Character -> code (a byte, or lead << 8 | trail), built on first use from the decoder. */
  private codes(): Map<string, number> {
    if (this.table) return this.table;
    const t = new Map<string, number>();
    const add = (s: string, code: number): void => {
      if (s.length === 0 || s.includes("�") || t.has(s)) return;
      t.set(s, code);
    };
    const one = new Uint8Array(1);
    for (let b = 0; b < 256; b++) {
      one[0] = b;
      add(this.decoder.decode(one), b);
    }
    if (this.doubleByte) {
      const two = new Uint8Array(2);
      for (let lead = 0x81; lead < 0xff; lead++) {
        two[0] = lead;
        for (let trail = 0x40; trail < 0xff; trail++) {
          two[1] = trail;
          const s = this.decoder.decode(two);
          // A pair the code page does not map decodes to two characters (or a replacement one).
          if (s.length === 1) add(s, (lead << 8) | trail);
        }
      }
    }
    this.table = t;
    return t;
  }

  /** One character's code; "?" for a character the code page does not have. */
  code(ch: string): number {
    if (ch.length === 1 && ch.charCodeAt(0) < 0x80) return ch.charCodeAt(0);
    return this.codes().get(ch) ?? 0x3f;
  }

  encode(s: string): Uint8Array {
    const out: number[] = [];
    for (const ch of s) {
      const c = this.code(ch);
      if (c > 0xff) out.push(c >> 8, c & 0xff);
      else out.push(c);
    }
    return Uint8Array.from(out);
  }
}

const pages = new Map<string, CodePage>();

function codePage(lang: number): CodePage {
  const label = codePageLabel(lang);
  let p = pages.get(label);
  if (!p) {
    p = new CodePage(label);
    pages.set(label, p);
  }
  return p;
}

/** The game's code page (the UI language's). */
export const GAME_CODE_PAGE = codePageLabel(UI_LANGUAGE);

/** Decodes the game's bytes (strings, names, file text) to Unicode. */
export const gameTextDecoder: TextDecoder = codePage(UI_LANGUAGE).decoder;

/** The decoder of a language's code page. */
export function textDecoderFor(lang: number): TextDecoder {
  return codePage(lang).decoder;
}

/** Encodes a string as the game's bytes (characters the code page lacks become "?"). */
export function encodeGameText(s: string, lang = UI_LANGUAGE): Uint8Array {
  return codePage(lang).encode(s);
}

/**
 * The code of one character in the game's code page, as the fonts index
 * glyphs: a byte, or lead << 8 | trail for a double-byte character.
 */
export function gameCharCode(ch: string, lang = UI_LANGUAGE): number {
  return codePage(lang).code(ch);
}
