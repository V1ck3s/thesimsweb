/**
 * Readers for VitaBoy's two file flavors.
 *
 * CTGFile (binary: .bcf, .bmf, .cfp, .ndx): integers and floats are 32-bit
 * little-endian (the PPC build byte-swaps them); strings are one length byte
 * (0xff = a 32-bit length follows) then the characters, no terminator.
 *
 * Text (.cmx, .skn): the istream readers (Skeleton/Suit/Skill::Prescan,
 * __rs(istream&, DeformableMesh&)) read names with getline and numbers with
 * operator>>. TextStream reproduces that: `line()` returns the next non-empty
 * line, numbers are whitespace-separated tokens spanning lines.
 */

const latin1 = new TextDecoder("latin1");

export class CTGFile {
  private readonly v: DataView;
  pos = 0;

  constructor(readonly bytes: Uint8Array) {
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** CTGFile::ReadString. */
  readString(): string {
    let n = this.readByte();
    if (n === 0xff) n = this.readInteger();
    const s = latin1.decode(this.bytes.subarray(this.pos, this.pos + n));
    this.pos += n;
    if (this.pos > this.bytes.length) throw new Error("CTGFile: read past end");
    return s;
  }

  readInteger(): number {
    const x = this.v.getInt32(this.pos, true);
    this.pos += 4;
    return x;
  }

  readFloat(): number {
    const x = this.v.getFloat32(this.pos, true);
    this.pos += 4;
    return x;
  }

  readByte(): number {
    const x = this.v.getUint8(this.pos);
    this.pos += 1;
    return x;
  }
}

export class TextStream {
  private readonly lines: string[];
  private li = 0;
  /** Tokens left over from a partially consumed line. */
  private pending: string[] = [];

  constructor(text: string) {
    this.lines = text.split(/\r?\n/);
  }

  static fromBytes(bytes: Uint8Array): TextStream {
    return new TextStream(latin1.decode(bytes));
  }

  /** getline, skipping empty lines (the readers loop until a non-empty one). */
  line(): string {
    this.pending = [];
    while (this.li < this.lines.length) {
      const l = this.lines[this.li++]!.replace(/^\r/, "").trim();
      if (l !== "") return l;
    }
    throw new Error("TextStream: unexpected end");
  }

  private token(): string {
    while (this.pending.length === 0) {
      if (this.li >= this.lines.length) throw new Error("TextStream: unexpected end");
      this.pending = this.lines[this.li++]!.trim().split(/\s+/).filter((t) => t !== "");
    }
    return this.pending.shift()!;
  }

  int(): number {
    return parseInt(this.token(), 10);
  }

  float(): number {
    return parseFloat(this.token());
  }
}

/** Props: string key/value pairs attached to bones, suits, skins and motions. */
export type Props = Map<string, string>;

/** Props::ReadFromFile: count, then (key, value) strings. */
export function readProps(f: CTGFile): Props {
  const p: Props = new Map();
  const n = f.readInteger();
  for (let i = 0; i < n; i++) {
    const k = f.readString();
    p.set(k, f.readString());
  }
  return p;
}

/** Props::Prescan (text): count, then key and value lines. */
export function scanProps(s: TextStream): Props {
  const p: Props = new Map();
  const n = s.int();
  for (let i = 0; i < n; i++) {
    const k = s.line();
    p.set(k, s.line());
  }
  return p;
}

/** TimeProps: Props keyed by a time in milliseconds (animation events). */
export type TimeProps = Map<number, Props>;

/** TimeProps::ReadFromFile: count, then (time, Props). */
export function readTimeProps(f: CTGFile): TimeProps {
  const tp: TimeProps = new Map();
  const n = f.readInteger();
  for (let i = 0; i < n; i++) {
    const t = f.readInteger();
    tp.set(t, readProps(f));
  }
  return tp;
}

export function scanTimeProps(s: TextStream): TimeProps {
  const tp: TimeProps = new Map();
  const n = s.int();
  for (let i = 0; i < n; i++) {
    const t = s.int();
    tp.set(t, scanProps(s));
  }
  return tp;
}
