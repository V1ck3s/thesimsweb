/**
 * The career tracks as the simulation reads them (LoadCareers, cCareer,
 * cJob): GetCareers / GetCareerByID for Set To Next type 10 and
 * cCareer::GetBehCareerData for expression scope 33. The control panel has
 * its own reader with the localized names (cpanel/live/careers.ts).
 *
 * LoadCareers reads every CARR chunk of ExpansionShared/work.iff by index
 * (the career id is the chunk id, a short), each with
 * SimpleReconObject<cCareer>::DoStream: compressed flag, name, then
 * DoContainerStream<cJob>: count, then per job ReconInt minimum
 * requirements[10] (+0), motive deltas[7] (+0x28), salary (+0x44), start
 * hour (+0x48), end hour (+0x4c), car type (+0x50) and five strings (+0x54,
 * +0x284, +0x2d0, +0x31c, +0x368).
 */

import { ResFile } from "../world/iffres.js";
import { ReconBuffer } from "../world/reconbuffer.js";

/** cJob (0x3b8 bytes in the original). */
export interface CareerJob {
  /** +0 */
  minimumReq: number[];
  /** +0x28 */
  motiveDeltas: number[];
  /** +0x44 */
  salary: number;
  /** +0x48 */
  startHour: number;
  /** +0x4c */
  endHour: number;
  /** +0x50 */
  carType: number;
  /** +0x54, +0x284, +0x2d0, +0x31c, +0x368 */
  strings: string[];
}

/** cCareer: +0 id, +4 jobs. */
export interface SimCareer {
  id: number;
  jobs: CareerJob[];
}

function readCareer(id: number, payload: Uint8Array): SimCareer {
  const { buf } = ReconBuffer.fromChunk(payload);
  if (buf.reconBool()) buf.enableCompression();
  buf.reconString();
  const n = buf.recon32();
  const jobs: CareerJob[] = [];
  for (let i = 0; i < n; i++) {
    const minimumReq = Array.from({ length: 10 }, () => buf.recon32());
    const motiveDeltas = Array.from({ length: 7 }, () => buf.recon32());
    const salary = buf.recon32();
    const startHour = buf.recon32();
    const endHour = buf.recon32();
    const carType = buf.recon32();
    const strings = Array.from({ length: 5 }, () => buf.reconString());
    jobs.push({ minimumReq, motiveDeltas, salary, startHour, endHour, carType, strings });
  }
  return { id, jobs };
}

/** LoadCareers (the CARR part): the careers in index order; none when work.iff is missing. */
export async function loadSimCareers(): Promise<SimCareer[]> {
  const work = await ResFile.open("ExpansionShared/work.iff").catch(() => null);
  if (!work) return [];
  const out: SimCareer[] = [];
  for (const c of work.list("CARR")) {
    try {
      out.push(readCareer((c.id << 16) >> 16, work.payload(c)));
    } catch {
      out.push({ id: (c.id << 16) >> 16, jobs: [] });
    }
  }
  return out;
}

/**
 * cCareer::GetBehCareerData(level, field): field 0 is the number of jobs;
 * otherwise, for a job level in range: 1 salary, 2..11 minimum
 * requirements 0..9, 12 start hour, 13 end hour, 14..20 motive deltas
 * 0..6, 21 car type, 22 whether its second string (+0x284) is not empty.
 * Null when the level or the field is out of range.
 */
export function getBehCareerData(career: SimCareer, level: number, field: number): number | null {
  if (field === 0) return career.jobs.length;
  if (level < 0 || level >= career.jobs.length) return null;
  const job = career.jobs[level]!;
  if (field === 1) return job.salary;
  if (field >= 2 && field <= 11) return job.minimumReq[field - 2]!;
  if (field === 12) return job.startHour;
  if (field === 13) return job.endHour;
  if (field >= 14 && field <= 20) return job.motiveDeltas[field - 14]!;
  if (field === 21) return job.carType;
  if (field === 22) return job.strings[1] ? 1 : 0;
  return null;
}
