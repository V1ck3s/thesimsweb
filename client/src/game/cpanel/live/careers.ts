/**
 * Career tracks (LoadCareers / cCareer / cJob), read the way the game does:
 * ExpansionShared/Work.iff holds one CARR chunk per career and, per career id,
 * STR# <id> with the localized names (STR# <id + 1000> overrides the long
 * names when present).
 *
 * CARR (SimpleReconObject<cCareer>::DoStream + DoContainerStream<cJob>):
 *   +0 u32 0, +4 u32 0, +8 "RRAC", then a ReconBuffer stream:
 *   bool compressed, string career name, int32 job count, then per job
 *   int32 minimum requirements[10], int32 motive deltas[7], salary, start
 *   hour, end hour, car type, and five strings (name, suits).
 * Compressed ints use the field encoding: 1 bit "non zero", 2 bits width
 * code (6/11/21/32 bits for 32-bit values), then a sign-extended value, MSB
 * first. Strings restart at a byte boundary, NUL-terminated, padded so the
 * stream offset stays even.
 */

import { readStandaloneIff } from "../../../engine/assets.js";
import type { Strings } from "../../res/strings.js";
import { gameTextDecoder } from "../../res/codepage.js";

const WORK_IFF = "ExpansionShared/work.iff";
const STRINGS = "work";

/** cJob::GetMinimumReq index (JobReq). */
export const enum JobReq {
  Friends = 0,
  Cooking = 1,
  Mechanical = 2,
  Charisma = 3,
  Body = 4,
  Logic = 5,
  Creativity = 6,
}

export interface Job {
  minimumReq: number[];
  salary: number;
  startHour: number;
  endHour: number;
  carType: number;
  /** cJob+0x54 / +0xe0: long names (male, female). */
  name: string;
  femaleName: string;
  /** cJob+0x16c / +0x1f8: short names (male, female). */
  shortName: string;
  femaleShortName: string;
  /** cJob+0x3b4: job description (popup text). */
  description: string;
}

export interface Career {
  id: number;
  name: string;
  jobs: Job[];
}

/** cJob::GetName(female) */
export function jobName(job: Job, female: boolean): string {
  return female && job.femaleName ? job.femaleName : job.name;
}

/** cJob::GetShortName(female) */
export function jobShortName(job: Job, female: boolean): string {
  return female && job.femaleShortName ? job.femaleShortName : job.shortName;
}

class FieldReader {
  private bit = 8;
  private cur = 0;

  constructor(
    private readonly b: Uint8Array,
    private readonly start: number,
    public pos: number,
  ) {}

  private readBit(): number {
    if (this.bit === 8) {
      this.cur = this.b[this.pos++] ?? 0;
      this.bit = 0;
    }
    return (this.cur >> (7 - this.bit++)) & 1;
  }

  private bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.readBit();
    return v;
  }

  int32(): number {
    if (!this.readBit()) return 0;
    const width = [6, 11, 21, 32][this.bits(2)]!;
    const v = this.bits(width);
    return v >= 2 ** (width - 1) ? v - 2 ** width : v;
  }

  string(): string {
    this.bit = 8;
    let end = this.pos;
    while (end < this.b.length && this.b[end] !== 0) end++;
    const s = gameTextDecoder.decode(this.b.subarray(this.pos, end));
    this.pos = end + 1;
    if ((this.pos - this.start) & 1) this.pos++;
    return s;
  }
}

function parseCarr(bytes: Uint8Array, id: number): Career {
  const start = 12; // after the two zero words and "RRAC"
  const r = new FieldReader(bytes, start, start + 1); // + the "compressed" bool
  const name = r.string();
  const count = r.int32();
  const jobs: Job[] = [];
  for (let i = 0; i < count; i++) {
    const minimumReq = Array.from({ length: 10 }, () => r.int32());
    for (let m = 0; m < 7; m++) r.int32();
    const salary = r.int32();
    const startHour = r.int32();
    const endHour = r.int32();
    const carType = r.int32();
    const jobNameStr = r.string();
    for (let s = 0; s < 4; s++) r.string();
    jobs.push({
      minimumReq,
      salary,
      startHour,
      endHour,
      carType,
      name: jobNameStr,
      femaleName: "",
      shortName: jobNameStr,
      femaleShortName: "",
      description: "",
    });
  }
  return { id, name, jobs };
}

let careers: Promise<Career[]> | null = null;

/** LoadCareers: every CARR chunk, then the localized strings of each career. */
export function loadCareers(strings: Strings): Promise<Career[]> {
  careers ??= (async () => {
    const { data, chunks } = await readStandaloneIff(`Sims/${WORK_IFF}`);
    await strings.load(WORK_IFF);
    const list = chunks
      .filter((c) => c.kind === "CARR")
      // Resource ids are signed 16-bit (the school track is CARR -1); the chunk list gives them unsigned.
      .map((c) => parseCarr(data.subarray(c.dataStart, c.dataStart + c.dataLen), (c.id << 16) >> 16));
    for (const career of list) {
      // The school track (CARR -1) keeps its built-in names.
      if (career.id < 0 || !strings.list(STRINGS, career.id).length) continue;
      const str = (n: number): string => strings.get(STRINGS, career.id, n - 1);
      const long = strings.list(STRINGS, career.id + 1000).length > 0;
      const longStr = (n: number): string => strings.get(STRINGS, career.id + 1000, n - 1);
      career.name = str(1);
      career.jobs.forEach((job, j) => {
        if (j >= 10) return;
        job.shortName = str(4 + 2 * j);
        job.femaleShortName = str(0x18 + j);
        job.name = long ? longStr(4 + 2 * j) : str(4 + 2 * j + 1000);
        job.femaleName = long ? longStr(0x18 + j) : str(j + 0x400);
        job.description = str(5 + 2 * j);
      });
    }
    return list;
  })();
  return careers;
}

/** GetCareerByID */
export function careerById(list: Career[], id: number): Career | null {
  return list.find((c) => c.id === id) ?? null;
}
