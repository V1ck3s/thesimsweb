/**
 * Browser side of the sound system: the AudioContext (the game's
 * IDirectSound / cTSSndSys) and sample loading (cTSSnd::SetSoundFile).
 *
 * Browsers keep an AudioContext suspended until a user gesture. The context
 * is created on demand and `installUnlock()` resumes it on the first
 * pointerdown/keydown (capture phase, so it runs before the click handlers
 * that play the click sound). Channels started while suspended wait for the
 * resume instead of being dropped.
 *
 * Paths are game-relative ("SoundData\UI\ui_click.xa", "Music\Modes\Buy\buy1.mp3").
 * Samples under a folder that ships as a FAR archive are read from it
 * (SoundData\ -> SoundData/SoundData.far, ExpansionPackN\Sound\ -> .../Sound.far,
 * ExpansionPack\ -> ExpansionPack/ExpansionPack.far); everything else is a
 * loose file served under /assets/Sims/.
 */

import { assetObjectUrl, fetchManifest, readAssetFile, readFarEntry, type Manifest } from "../../engine/assets.js";
import { engine } from "../../engine/wasm.js";

export const GAME_ROOT = "Sims/";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

export function audioContext(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.connect(ctx.destination);
  }
  return ctx;
}

/** Output node every channel connects to. */
export function masterOut(): GainNode {
  audioContext();
  return master!;
}

export function audioUnlocked(): boolean {
  return ctx?.state === "running";
}

let unlockInstalled = false;
const unlockWaiters: Array<() => void> = [];

/** Resume the AudioContext on the first user gesture (browser autoplay policy). */
export function installUnlock(): void {
  if (unlockInstalled) return;
  unlockInstalled = true;
  const resume = (): void => {
    const c = audioContext();
    if (c.state === "running") return;
    void c.resume().then(() => {
      window.removeEventListener("pointerdown", resume, true);
      window.removeEventListener("keydown", resume, true);
      for (const w of unlockWaiters.splice(0)) w();
    });
  };
  window.addEventListener("pointerdown", resume, true);
  window.addEventListener("keydown", resume, true);
}

/** Resolves once the context runs (immediately when it already does). */
export function whenUnlocked(): Promise<void> {
  if (audioUnlocked()) return Promise.resolve();
  return new Promise((r) => unlockWaiters.push(r));
}

/**
 * cTSSnd::SetVolume: 0..1024 becomes a DirectSound attenuation in 1/100 dB,
 * linear in dB from -40 dB (1) to 0 dB (1024); 0 is silence (-100 dB).
 */
export function tsVolumeToGain(v: number): number {
  const c = Math.max(0, Math.min(0x400, v | 0));
  if (c === 0) return 0;
  if (c === 0x400) return 1;
  const mb = ((c * 4000) >> 10) - 4000;
  return Math.pow(10, mb / 2000);
}

// ---- files ------------------------------------------------------------------

const FARS: Array<[prefix: string, far: string]> = [
  ["sounddata\\", "SoundData/SoundData.far"],
  ["expansionshared\\sound\\", "ExpansionShared/Sound/Sound.far"],
  ["expansionpack4\\sound\\", "ExpansionPack4/Sound/Sound.far"],
  ["expansionpack5\\sound\\", "ExpansionPack5/Sound/Sound.far"],
  ["expansionpack6\\sound\\", "ExpansionPack6/Sound/Sound.far"],
  ["expansionpack7\\sound\\", "ExpansionPack7/Sound/Sound.far"],
  ["expansionpack\\", "ExpansionPack/ExpansionPack.far"],
];

let manifest: Promise<Manifest> | null = null;
let looseFiles: Promise<Map<string, string>> | null = null;

function files(): Promise<Map<string, string>> {
  looseFiles ??= (async () => {
    manifest ??= fetchManifest();
    const m = await manifest;
    const map = new Map<string, string>();
    for (const f of m.files) {
      if (f.path.startsWith(GAME_ROOT)) map.set(f.path.slice(GAME_ROOT.length).toLowerCase(), f.path.slice(GAME_ROOT.length));
    }
    return map;
  })();
  return looseFiles;
}

function toSlash(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

/**
 * cTSDirectory::ReadDirectorySpecificEntriesIntoStringList for one folder:
 * its immediate sub-folders and files (game-relative, original case), sorted.
 */
export async function listDir(dir: string): Promise<{ dirs: string[]; files: string[] }> {
  const all = await files();
  const base = `${toSlash(dir).toLowerCase().replace(/\/$/, "")}/`;
  const dirs = new Set<string>();
  const out: string[] = [];
  for (const [lower, orig] of all) {
    if (!lower.startsWith(base)) continue;
    const rest = orig.slice(base.length);
    const slash = rest.indexOf("/");
    if (slash < 0) out.push(orig);
    else dirs.add(orig.slice(0, base.length + slash));
  }
  return { dirs: [...dirs].sort((a, b) => a.localeCompare(b)), files: out.sort((a, b) => a.localeCompare(b)) };
}

/** URL of a loose game file, or null when the install has no such file. */
export async function looseUrl(path: string): Promise<string | null> {
  const orig = (await files()).get(toSlash(path).toLowerCase());
  // (a blob: URL when the game files are imported in this browser, GAME_FILES=client)
  return orig ? assetObjectUrl(GAME_ROOT + orig) : null;
}

/** Path under /assets/ of a loose game file ("Sims/..."), or null when the install has no such file. */
export async function loosePath(path: string): Promise<string | null> {
  const orig = (await files()).get(toSlash(path).toLowerCase());
  return orig ? GAME_ROOT + orig : null;
}

/** Bytes of a loose game file (cached across loads, engine/assets.ts readAssetFile), null when missing. */
export async function readLooseFile(path: string): Promise<Uint8Array | null> {
  const p = await loosePath(path);
  return p ? readAssetFile(p).catch(() => null) : null;
}

/** Raw bytes of a game sample, from its FAR archive or as a loose file. */
export async function readGameFile(path: string): Promise<Uint8Array> {
  const lower = path.replace(/\//g, "\\").toLowerCase();
  for (const [prefix, far] of FARS) {
    if (!lower.startsWith(prefix)) continue;
    try {
      return await readFarEntry(GAME_ROOT + far, path.replace(/\//g, "\\").slice(prefix.length));
    } catch {
      break; // fall back to a loose file
    }
  }
  const p = await loosePath(path);
  if (!p) throw new Error(`sound file not found: ${path}`);
  return readAssetFile(p);
}

function isXa(bytes: Uint8Array): boolean {
  return bytes[0] === 0x58 && bytes[1] === 0x41; // "XA"
}

const buffers = new Map<string, Promise<AudioBuffer>>();

/**
 * The file's own sample rate (WAVEFORMATEX nSamplesPerSec) per decoded
 * buffer: decodeAudioData resamples to the context rate, but the game's
 * frequencies (cTSSnd::GetFrequency / SetFrequency) are in the file's Hz.
 */
const fileRates = new WeakMap<AudioBuffer, number>();

/** nSamplesPerSec of the file a buffer was decoded from (11025 for the TV clips, 22050 for the rest). */
export function fileSampleRate(buf: AudioBuffer): number {
  return fileRates.get(buf) ?? buf.sampleRate;
}

/** nSamplesPerSec of a RIFF/WAVE file ("fmt " chunk), or 0. */
function wavSampleRate(b: Uint8Array): number {
  if (b.length < 12 || String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!) !== "RIFF") return 0;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let p = 12; p + 8 <= b.length; ) {
    const id = String.fromCharCode(b[p]!, b[p + 1]!, b[p + 2]!, b[p + 3]!);
    const size = v.getUint32(p + 4, true);
    if (id === "fmt " && p + 16 <= b.length) return v.getUint32(p + 12, true);
    p += 8 + size + (size & 1);
  }
  return 0;
}

/**
 * Decode a whole sample (XA through the WASM decoder, WAV/MP3 through the
 * browser). Cached per path, like cSamplePatch keeps its cTSSnd loaded.
 */
export function loadBuffer(path: string): Promise<AudioBuffer> {
  const key = path.toLowerCase();
  let p = buffers.get(key);
  if (!p) {
    p = (async () => {
      const bytes = await readGameFile(path);
      let wav: Uint8Array = bytes;
      if (isXa(bytes)) {
        const wasm = await engine();
        // cWaveXA::Init only checks "XA" and wFormatTag == 1; the tag bytes
        // after "XA" ("\0\0", "J\0", "\x12\0") do not change the layout.
        wav = (wasm.decodeXa(bytes) as { wav: Uint8Array }).wav;
      }
      const rate = wavSampleRate(wav);
      const copy = new ArrayBuffer(wav.byteLength);
      new Uint8Array(copy).set(wav);
      const buf = await audioContext().decodeAudioData(copy);
      if (rate > 0) fileRates.set(buf, rate);
      return buf;
    })();
    p.catch(() => buffers.delete(key));
    buffers.set(key, p);
  }
  return p;
}
