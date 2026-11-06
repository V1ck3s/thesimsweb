/**
 * Skill and Motion (VitaBoy animations) and the CFP keyframe data.
 *
 *   Skill (Skill::ReadFromFile): name, animationName (the .cfp file),
 *       duration (float, ms), distance (float), isMoving (int),
 *       translationCount, rotationCount, motionCount, Motion[motionCount]
 *   Motion (Motion::ReadFromFile): boneName, frameCount (int), duration (float),
 *       hasTranslation, hasRotation, translationOffset, rotationOffset (ints),
 *       hasProps (int) [Props], hasTimeProps (int) [TimeProps]
 *
 * Skill::Load reads "<animationName>.cfp": translationCount vec3s then
 * rotationCount quaternions, each stored as ReadCompressedFloats streams
 * (component-major). A ".bin" file with raw floats is the uncompressed
 * fallback the game tries second.
 */

import { CTGFile, readProps, readTimeProps, scanProps, scanTimeProps, type Props, type TextStream, type TimeProps } from "./ctgfile.js";

export class Motion {
  boneName = "";
  frameCount = 0;
  duration = 0;
  hasTranslation = 0;
  hasRotation = 0;
  translationOffset = 0;
  rotationOffset = 0;
  props: Props | null = null;
  timeProps: TimeProps | null = null;

  static read(f: CTGFile): Motion {
    const m = new Motion();
    m.boneName = f.readString();
    m.frameCount = f.readInteger();
    m.duration = f.readFloat();
    m.hasTranslation = f.readInteger();
    m.hasRotation = f.readInteger();
    m.translationOffset = f.readInteger();
    m.rotationOffset = f.readInteger();
    if (f.readInteger() !== 0) m.props = readProps(f);
    if (f.readInteger() !== 0) m.timeProps = readTimeProps(f);
    return m;
  }

  static scan(s: TextStream): Motion {
    const m = new Motion();
    m.boneName = s.line();
    m.frameCount = s.int();
    m.duration = s.float();
    m.hasTranslation = s.int();
    m.hasRotation = s.int();
    m.translationOffset = s.int();
    m.rotationOffset = s.int();
    if (s.int() !== 0) m.props = scanProps(s);
    if (s.int() !== 0) m.timeProps = scanTimeProps(s);
    return m;
  }
}

/** The millisecond clock (lbl_105BA230) as of the last VBAnimMgr.tryUnloadSkills. */
export const skillClock = { now: 0 };

export class Skill {
  name = "";
  animationName = "";
  duration = 0;
  distance = 0;
  isMoving = 0;
  translationCount = 0;
  rotationCount = 0;
  motions: Motion[] = [];
  /** Filled by load(): xyz per translation, xyzw per rotation. */
  translations: Float32Array | null = null;
  rotations: Float32Array | null = null;
  /**
   * +0x68: when a practice last used the skill (skillClock; 0: never).
   * The original sets it to 0 while practices are bound and to the clock
   * when the last one unbinds (Skill::UnbindPractice); the port's practices
   * are dropped without unbinding, so each Practice::Apply stamps it.
   * Skill::CanUnload / VBAnimMgr.tryUnloadSkills read it.
   */
  lastUse = 0;

  static read(f: CTGFile): Skill {
    const s = new Skill();
    s.name = f.readString();
    s.animationName = f.readString();
    s.duration = f.readFloat();
    s.distance = f.readFloat();
    s.isMoving = f.readInteger();
    s.translationCount = f.readInteger();
    s.rotationCount = f.readInteger();
    const n = f.readInteger();
    for (let i = 0; i < n; i++) s.motions.push(Motion.read(f));
    return s;
  }

  static scan(t: TextStream): Skill {
    const s = new Skill();
    s.name = t.line();
    s.animationName = t.line();
    s.duration = t.float();
    s.distance = t.float();
    s.isMoving = t.int();
    s.translationCount = t.int();
    s.rotationCount = t.int();
    const n = t.int();
    for (let i = 0; i < n; i++) s.motions.push(Motion.scan(t));
    return s;
  }

  /** Skill::Load with the bytes of the .cfp (compressed) or .bin (raw) file. */
  loadData(bytes: Uint8Array, compressed: boolean): void {
    const f = new CTGFile(bytes);
    if (compressed) {
      const counter = { bytes: 0 };
      this.translations = readCompressedFloats(f, this.translationCount, 3, counter);
      this.rotations = readCompressedFloats(f, this.rotationCount, 4, counter);
    } else {
      this.translations = new Float32Array(this.translationCount * 3);
      for (let i = 0; i < this.translations.length; i++) this.translations[i] = f.readFloat();
      this.rotations = new Float32Array(this.rotationCount * 4);
      for (let i = 0; i < this.rotations.length; i++) this.rotations[i] = f.readFloat();
    }
  }
}

let deltaTable: Float32Array | null = null;

/** InitFloatCompression: 253 deltas, 0.1 * sign(t) * t^4 for t in [-1, 1]. */
function floatDeltas(): Float32Array {
  if (deltaTable) return deltaTable;
  const fr = Math.fround;
  const t = new Float32Array(253);
  for (let i = 0; i < 253; i++) {
    const x = fr(2 * fr(i / 252) - 1);
    const sign = x < 0 ? -1 : 1;
    t[i] = fr(0.1 * fr(x * fr(x * fr(x * fr(sign * x)))));
  }
  deltaTable = t;
  return t;
}

/**
 * ReadCompressedFloats(file, out, count, components): for each component, a
 * stream of `count` values. Each code byte is a delta index (0..252), 0xff
 * (a raw float follows) or 0xfe (a 16-bit repeat count follows: the previous
 * value is kept for that many extra entries). The running value carries over
 * between components.
 */
export function readCompressedFloats(f: CTGFile, count: number, components: number, counter: { bytes: number }): Float32Array {
  const table = floatDeltas();
  const out = new Float32Array(count * components);
  let value = 0;
  let repeat = 0;
  for (let c = 0; c < components; c++) {
    for (let i = 0; i < count; i++) {
      if (repeat < 1) {
        const code = f.readByte();
        counter.bytes++;
        if (code === 0xff) {
          value = f.readFloat();
          counter.bytes += 4;
        } else if (code === 0xfe) {
          const lo = f.readByte();
          const hi = f.readByte();
          counter.bytes += 2;
          repeat = lo | (hi << 8);
        } else {
          value = Math.fround(value + table[code]!);
        }
      } else {
        repeat--;
      }
      out[c + i * components] = value;
    }
  }
  return out;
}
