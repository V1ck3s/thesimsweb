/**
 * HIT sound data files, as cHitMan / cHitIniFile read them.
 *
 * A sound "data directory" holds triples sharing a base name:
 *  - `.hit`: HIT bytecode ("HIT!" v1.8 + "TRAX"), executed by cTrackPlayer;
 *  - `.hsm`: the assembler's symbol file (`name value (0xhex)` per line), read
 *    by cHitMan::LoadSymbolFile; `.hot` values written `@name` resolve here;
 *  - `.hot`: an INI file (cHitIniFile) with the sections
 *      [TrackData]          label id = byte offset in the .hit (jump/call/if targets
 *                           and track entry points are label ids, not addresses),
 *      [EventMappingEquate] constants usable in the other sections,
 *      [GlobalHitList]      hitlist id = patch/sound object ids (`a-b` ranges),
 *      [Patch]              id = 0,name,"path",IsLooped,IsStreamed,Preload,Is3d,IsHeadRelative,
 *      [Track]              id = 0,name,vol,argsType,duckPri,controlGroup,spl,@tkd,patch,
 *      [EventMapping]       event name = kind,arg[,arg3,arg4,arg5].
 */

/** One code buffer: the whole .hit file (label addresses are file offsets). */
export interface HitCode {
  name: string;
  bytes: Uint8Array;
}

export interface HotPatch {
  id: number;
  name: string;
  /** Path relative to the game folder (cBoxX::AudioDataDir + the .hot path). */
  path: string;
  looped: boolean;
  streamed: boolean;
  preload: boolean;
  is3d: boolean;
  headRelative: boolean;
}

export interface HotTrack {
  id: number;
  name: string;
  volume: number;
  argsType: number;
  duckPri: number;
  controlGroup: number;
  spl: number;
  /** Label id of the track's entry point ([TrackData]). */
  trackData: number;
  patch: number;
}

/** cBoxXMappedEvent: `name=kind,arg,a3,a4,a5` (0 = keep the caller's value). */
export interface MappedEvent {
  kind: number;
  arg: number;
  a3: number;
  a4: number;
  a5: number;
}

export interface HotFile {
  trackData: Map<number, number>;
  patches: HotPatch[];
  tracks: HotTrack[];
  hitLists: Map<number, number[]>;
  events: Map<string, MappedEvent>;
}

/** cHitMan::LoadSymbolFile: `name value (0xhex)`. */
export function parseHsm(text: string): Map<string, number> {
  const syms = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\S+)\s+(-?\d+)/.exec(line);
    if (m?.[1] && m[2]) syms.set(m[1].toLowerCase(), Number(m[2]));
  }
  return syms;
}

/** Split an INI value on commas, honouring double quotes. */
function splitFields(v: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of v) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** cHitIniFile::IniStringValue: number, `@symbol` (.hsm) or equate; unknown = 0. */
function makeValue(equates: Map<string, number>, hsm: Map<string, number>) {
  return (s: string | undefined): number => {
    if (s === undefined) return 0;
    const t = s.trim();
    if (t === "") return 0;
    if (/^-?0x[0-9a-f]+$/i.test(t)) return parseInt(t, 16) | 0;
    if (/^-?\d+$/.test(t)) return parseInt(t, 10) | 0;
    const key = (t.startsWith("@") ? t.slice(1) : t).toLowerCase();
    return equates.get(key) ?? hsm.get(key) ?? 0;
  };
}

export function parseHot(text: string, hsm: Map<string, number>): HotFile {
  const sections = new Map<string, Array<[string, string]>>();
  let cur: Array<[string, string]> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";")) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec?.[1]) {
      cur = sections.get(sec[1].toLowerCase()) ?? [];
      sections.set(sec[1].toLowerCase(), cur);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0 || !cur) continue;
    cur.push([line.slice(0, eq).trim(), line.slice(eq + 1).trim()]);
  }
  const equates = new Map<string, number>();
  for (const [k, v] of sections.get("eventmappingequate") ?? []) equates.set(k.toLowerCase(), Number(v) | 0);
  const val = makeValue(equates, hsm);

  const trackData = new Map<number, number>();
  for (const [k, v] of sections.get("trackdata") ?? []) trackData.set(val(k), val(v));

  const hitLists = new Map<number, number[]>();
  for (const [k, v] of sections.get("globalhitlist") ?? []) {
    const ids: number[] = [];
    for (const part of v.split(",")) {
      const r = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(part);
      if (r?.[1] && r[2]) for (let i = Number(r[1]); i <= Number(r[2]); i++) ids.push(i);
      else if (part.trim()) ids.push(val(part));
    }
    hitLists.set(val(k), ids);
  }

  const patches: HotPatch[] = [];
  for (const [k, v] of sections.get("patch") ?? []) {
    const f = splitFields(v);
    const path = (f[2] ?? "").replace(/\//g, "\\");
    // cHitIniFile::IniFileCallbackPatch: IsStreamed is ignored under "sounddata\".
    const streamedFlag = val(f[4]) === 1 && !path.toLowerCase().includes("sounddata\\");
    patches.push({
      id: val(k),
      name: f[1] ?? "",
      path,
      looped: val(f[3]) === 1,
      streamed: streamedFlag,
      preload: val(f[5]) === 1,
      is3d: val(f[6]) === 1,
      headRelative: val(f[7]) === 1,
    });
  }

  const tracks: HotTrack[] = [];
  for (const [k, v] of sections.get("track") ?? []) {
    const f = splitFields(v);
    tracks.push({
      id: val(k),
      name: f[1] ?? "",
      volume: val(f[2]),
      argsType: val(f[3]),
      duckPri: val(f[4]),
      controlGroup: val(f[5]),
      spl: val(f[6]),
      trackData: val(f[7]),
      patch: val(f[8]),
    });
  }

  const events = new Map<string, MappedEvent>();
  for (const [k, v] of sections.get("eventmapping") ?? []) {
    const f = splitFields(v);
    events.set(k.toLowerCase(), { kind: val(f[0]), arg: val(f[1]), a3: val(f[2]), a4: val(f[3]), a5: val(f[4]) });
  }
  return { trackData, patches, tracks, hitLists, events };
}

/** Validate a .hit file ("HIT!", v1.8, "TRAX"). */
export function checkHit(bytes: Uint8Array): boolean {
  const s = String.fromCharCode(...bytes.subarray(0, 4)) + String.fromCharCode(...bytes.subarray(12, 16));
  return s === "HIT!TRAX";
}
