/**
 * FloatConstants (FCNS chunks of Global.iff, GlobalConstantsClient::GetFile):
 * named float constants, FloatConstantPair = name, value, description.
 * FCNS 1 / 5 / 6: the motive constants (MotiveConstantsClient, normal /
 * person data 0x41 bit 2 / bit 4), FCNS 2: autonomy (AutonomyConstantsClient).
 */

import type { ResFile } from "../world/iffres.js";
import { ReconBuffer } from "../world/reconbuffer.js";

export type FloatConstants = Map<string, number>;

/** FloatConstants::Load: an empty map when the chunk is missing. */
export function loadFloatConstants(res: ResFile | null, id: number): FloatConstants {
  const out: FloatConstants = new Map();
  const b = res?.get("FCNS", id);
  if (!b) return out;
  try {
    const { buf } = ReconBuffer.fromChunk(b);
    const n = buf.recon32();
    for (let i = 0; i < n; i++) {
      const name = buf.reconString();
      const value = buf.reconFloat();
      buf.reconString();
      out.set(name, value);
    }
  } catch {
    // A truncated chunk keeps what was read.
  }
  return out;
}

/** FloatConstants::Get with its default. */
export function fc(c: FloatConstants, name: string, def: number): number {
  return c.get(name) ?? def;
}

/**
 * lbl_105BA1F4: "friendship threshold" of FCNS 2, truncated to an int
 * (AutonomyConstantsClient::UpdateConstants; 25 when the file has no value,
 * 50 in the shipped Global.iff). Both daily relationships at least this make
 * two sims friends (PersonFinder::GetRelation, Neighborhood::GetFriendCount).
 */
export let friendshipThreshold = 25;

export function setFriendshipThreshold(c: FloatConstants): void {
  friendshipThreshold = Math.trunc(fc(c, "friendship threshold", 25));
}
