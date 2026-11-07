/**
 * VBAnimMgr: finds and loads VitaBoy resources by name.
 *
 * The game registers resource sites (GameData/Animation, GameData/Skins,
 * GameData/Textures and each expansion's archive), reads every ".ndx" index
 * (VBAnimMgr::LoadIndexFromFile) to learn which CMX file holds each skeleton,
 * suit and skill, and loads a CMX on first use (Envelope<T>::Load ->
 * VBAnimMgr::LoadAnimation). File kinds, as in the original:
 *
 *   "<file>.cmx"  -> binary "<file>.cmx.bcf" (CTGFile) or the text ".cmx" itself
 *   meshes        -> "<mesh>.bmf" (binary) else "<mesh>.skn" (text)   (LoadDeformableMesh)
 *   keyframes     -> "<animationName>.cfp" else ".bin"                 (Skill::Load)
 *   textures      -> "<texture>.bmp"                                   (DDDTextureMgr)
 *
 * The Complete Collection keeps most of these inside FAR archives; entries
 * are looked up by file name, case-insensitively, ignoring their folder.
 */

import { fetchManifest, readAssetFile, readFarEntry, readFarManifest } from "../../engine/assets.js";
import { decodeBmp, type RgbaImage } from "../res/bmp.js";
import { loadAnimationFromFile, loadAnimationFromStream, loadIndexFromFile, type AnimFile } from "./animfile.js";
import { DeformableMesh } from "./deformablemesh.js";
import type { Skeleton } from "./skeleton.js";
import { type Skill, skillClock } from "./skill.js";
import type { Suit } from "./suit.js";

/** Archives searched, in priority order (the base game first). */
const FARS = [
  "Sims/GameData/Animation/Animation.far",
  "Sims/GameData/Textures/Textures.far",
  "Sims/ExpansionShared/ExpansionShared.far",
  "Sims/ExpansionPack/ExpansionPack.far",
  "Sims/ExpansionPack2/ExpansionPack2.far",
  "Sims/ExpansionPack3/ExpansionPack3.far",
  "Sims/ExpansionPack4/ExpansionPack4.far",
  "Sims/ExpansionPack5/ExpansionPack5.far",
  "Sims/ExpansionPack6/ExpansionPack6.far",
  "Sims/ExpansionPack7/ExpansionPack7.far",
  "Sims/Deluxe/Deluxe.far",
];

/**
 * Loose folders searched before the archives (user skins live there): the
 * game's own, then the skin folders Sims.exe names ("Skins/",
 * "ExpansionShared/SkinsBuy/", "ExpansionShared/Skins/", "Deluxe/Skins/",
 * "ExpansionPack2..7/Skins/"; House Party's costume trunk textures are only
 * in ExpansionPack2/Skins).
 */
const LOOSE_DIRS = [
  "Sims/GameData/Skins/",
  "Sims/GameData/Animation/",
  "Sims/ExpansionShared/SkinsBuy/",
  "Sims/ExpansionShared/Skins/",
  "Sims/Deluxe/Skins/",
  ...[2, 3, 4, 5, 6, 7].map((n) => `Sims/ExpansionPack${n}/Skins/`),
];

const EXTS = new Set(["bcf", "cmx", "bmf", "skn", "cfp", "bin", "bmp", "ndx"]);

type Source = { far: string; entry: string } | { path: string };

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return (i >= 0 ? p.slice(i + 1) : p).toLowerCase();
}

function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

let instance: Promise<VBAnimMgr> | null = null;

/**
 * lbl_105BA0E4: how long (ms) a skill no practice uses stays loaded before
 * Skill::CanUnload lets it go. Globs::Globs sets 160000 when the machine has
 * 128 MB of memory or more (80000 below; any machine today).
 */
const SKILL_UNLOAD_MS = 160000;

export class VBAnimMgr {
  /** lowercased file name -> where it is. */
  private readonly files = new Map<string, Source>();
  /** lowercased resource name -> CMX file name (from the .ndx indexes). */
  private readonly skeletonIndex = new Map<string, string>();
  private readonly suitIndex = new Map<string, string>();
  private readonly skillIndex = new Map<string, string>();
  private readonly skeletons = new Map<string, Skeleton>();
  private readonly suits = new Map<string, Suit>();
  private readonly skills = new Map<string, Skill>();
  private readonly cmxCache = new Map<string, Promise<AnimFile | null>>();
  private readonly meshCache = new Map<string, Promise<DeformableMesh | null>>();
  private readonly textureCache = new Map<string, Promise<RgbaImage | null>>();
  private readonly skillData = new Map<Skill, Promise<boolean>>();
  /** The CMX file (cmxCache key) each skill was read from. */
  private readonly skillFile = new Map<Skill, string>();
  /** The CMX file (cmxCache key) each suit was read from. */
  private readonly suitFile = new Map<Suit, string>();
  /** lbl_105BADF0: the clock of the last TryUnloadSkills / TryUnloadSuits pass (one for both). */
  private lastUnloadPass = 0;
  /** Called with the (lowercased) name of each skill tryUnloadSkills unloads, for the caches holding skills by name. */
  readonly skillUnloaded = new Set<(name: string) => void>();

  /** The shared manager (VitaBoy::InitializeAll builds one at startup). */
  static get(): Promise<VBAnimMgr> {
    instance ??= VBAnimMgr.create();
    return instance;
  }

  private static async create(): Promise<VBAnimMgr> {
    const m = new VBAnimMgr();
    const manifest = await fetchManifest();
    const paths = new Set(manifest.files.map((f) => f.path));
    for (const dir of LOOSE_DIRS) {
      for (const p of paths) {
        if (!p.startsWith(dir) || p.slice(dir.length).includes("/")) continue;
        const n = baseName(p);
        if (EXTS.has(ext(n)) && !m.files.has(n)) m.files.set(n, { path: p });
      }
    }
    // Animator's site setup: after the game's own sites, each download directory
    // (ObjectFolder::GetDownloadDirectories) holding "<dir>/<dir>.far" joins the
    // indexed site (the Downloads/HPPottyPack stalls of the downtown lots).
    const downloads = [...paths]
      .filter((p) => {
        const m = /^Sims\/Downloads\/([^/]+)\/([^/]+)\.far$/i.exec(p);
        return !!m && m[1]!.toLowerCase() === m[2]!.toLowerCase();
      })
      .sort();
    const fars = [...FARS.filter((f) => paths.has(f)), ...downloads];
    const lists = await Promise.all(fars.map((f) => readFarManifest(f).catch(() => [])));
    const ndx: Array<{ far: string; entry: string }> = [];
    fars.forEach((far, i) => {
      for (const e of lists[i]!) {
        const n = baseName(e.filename);
        if (!EXTS.has(ext(n))) continue;
        if (ext(n) === "ndx") ndx.push({ far, entry: e.filename });
        else if (!m.files.has(n)) m.files.set(n, { far, entry: e.filename });
      }
    });
    // LoadIndexedAnimations: the first site to name a resource wins.
    for (const { far, entry } of ndx) {
      const idx = loadIndexFromFile(await readFarEntry(far, entry));
      for (const [k, v] of idx.skeletons) if (!m.skeletonIndex.has(k.toLowerCase())) m.skeletonIndex.set(k.toLowerCase(), v);
      for (const [k, v] of idx.suits) if (!m.suitIndex.has(k.toLowerCase())) m.suitIndex.set(k.toLowerCase(), v);
      for (const [k, v] of idx.skills) if (!m.skillIndex.has(k.toLowerCase())) m.skillIndex.set(k.toLowerCase(), v);
    }
    return m;
  }

  async readFile(name: string): Promise<Uint8Array | null> {
    const src = this.files.get(name.toLowerCase());
    if (!src) return null;
    if ("far" in src) return readFarEntry(src.far, src.entry);
    return readAssetFile(src.path).catch(() => null);
  }

  /** VBAnimMgr::LoadAnimation: "x.cmx" -> binary "x.cmx.bcf" if present, else the text file. */
  private loadCmx(file: string): Promise<AnimFile | null> {
    const key = file.toLowerCase();
    let p = this.cmxCache.get(key);
    if (!p) {
      p = (async () => {
        let a: AnimFile | null = null;
        const bin = await this.readFile(`${key}.bcf`);
        if (bin) a = loadAnimationFromFile(bin);
        else {
          const txt = await this.readFile(key);
          if (txt) a = loadAnimationFromStream(txt);
        }
        if (!a) return null;
        for (const s of a.skeletons) if (!this.skeletons.has(s.name.toLowerCase())) this.skeletons.set(s.name.toLowerCase(), s);
        for (const s of a.suits) {
          if (this.suits.has(s.name)) continue;
          this.suits.set(s.name, s);
          this.suitFile.set(s, key);
        }
        for (const s of a.skills) {
          if (this.skills.has(s.name.toLowerCase())) continue;
          this.skills.set(s.name.toLowerCase(), s);
          this.skillFile.set(s, key);
        }
        return a;
      })();
      this.cmxCache.set(key, p);
    }
    return p;
  }

  /**
   * VBAnimMgr::LoadAllAnimations' pass over the loose files of the skin
   * folders: every text ".cmx" there (without a binary ".cmx.bcf") is read and
   * its suits registered under the names written inside it. Downloaded skins
   * often name their suit after the texture ("C603MA_Patch.cmx" holds suit
   * "C603MAlgt_Patch"), so the file name is not the suit's name. Done once,
   * before the suit table is walked (EditPerson::GetSuit).
   */
  loadLooseAnimations(): Promise<void> {
    this.looseLoaded ??= (async () => {
      const files: string[] = [];
      for (const [n, src] of this.files) {
        if ("path" in src && n.endsWith(".cmx") && !this.files.has(`${n}.bcf`)) files.push(n);
      }
      await Promise.all(files.map((f) => this.loadCmx(f).catch(() => null)));
    })();
    return this.looseLoaded;
  }

  private looseLoaded: Promise<void> | null = null;

  /**
   * Names of the suits the manager knows (the animation manager's suit
   * table that EditPerson::GetSuit walks): every suit of the .ndx indexes
   * plus the suits read from the loose ".cmx" files (loadLooseAnimations
   * first). Lowercased.
   */
  suitNames(): string[] {
    const out = new Set(this.suitIndex.keys());
    for (const k of this.suits.keys()) out.add(k);
    return [...out];
  }

  /** Texture names (".bmp" files, extension dropped), the TextureScanner's directory contents. Lowercased. */
  textureNames(): string[] {
    const out: string[] = [];
    for (const n of this.files.keys()) if (n.endsWith(".bmp")) out.push(n.slice(0, -4));
    return out;
  }

  /** VBAnimMgr::FindSkeleton (shared, never animated: clone before use). */
  async findSkeleton(name: string): Promise<Skeleton | null> {
    const k = name.toLowerCase();
    if (!this.skeletons.has(k)) await this.loadCmx(this.skeletonIndex.get(k) ?? `${k}.cmx`);
    return this.skeletons.get(k) ?? null;
  }

  /**
   * VBAnimMgr::FindSuit. Suits missing from the indexes are looked up as
   * "<name>.cmx", then among the suits of every loose ".cmx" (the original
   * has read them all at startup, LoadAllAnimations).
   */
  async findSuit(name: string): Promise<Suit | null> {
    const k = name.toLowerCase();
    if (!this.suits.has(k)) await this.loadCmx(this.suitIndex.get(k) ?? `${k}.cmx`);
    if (!this.suits.has(k) && !this.suitIndex.has(k)) await this.loadLooseAnimations();
    return this.suits.get(k) ?? null;
  }

  /** VBAnimMgr::FindSkill, with its keyframes loaded (Skill::Load). */
  async findSkill(name: string): Promise<Skill | null> {
    const k = name.toLowerCase();
    if (!this.skills.has(k)) await this.loadCmx(this.skillIndex.get(k) ?? `${k}.cmx`);
    const s = this.skills.get(k);
    if (!s) return null;
    return (await this.loadSkillData(s)) ? s : null;
  }

  /**
   * VBAnimMgr::TryUnloadSkills(now) (HouseViewer::UpdateWorld, every frame):
   * at most once per clock value (lbl_105BADEC, the interval, is never set),
   * every loaded skill that Skill::CanUnload allows (used by a practice once,
   * none since SKILL_UNLOAD_MS) is unloaded (Envelope<Skill>::Unload): the
   * next findSkill reads it again. Practices still holding it keep their copy.
   * Its CMX file's parsed form is dropped too (the skeletons and suits it
   * held stay in their tables).
   */
  tryUnloadSkills(now: number): void {
    skillClock.now = now;
    if (!(this.lastUnloadPass < now)) return;
    this.lastUnloadPass = now;
    for (const [k, s] of this.skills) {
      if (!this.skillData.has(s) || s.lastUse === 0 || !(s.lastUse + SKILL_UNLOAD_MS < now)) continue;
      this.skills.delete(k);
      this.skillData.delete(s);
      const file = this.skillFile.get(s);
      if (file !== undefined) this.cmxCache.delete(file);
      this.skillFile.delete(s);
      for (const cb of this.skillUnloaded) cb(k);
    }
  }

  /**
   * VBAnimMgr::TryUnloadSuits(now): the same gate as tryUnloadSkills (the
   * one clock lbl_105BADF0, interval lbl_105BADEC never set), then every
   * loaded suit that Suit::CanUnload allows is unloaded (Envelope<Suit>::
   * Unload, Suit::Release): dropped from the table with its CMX file's parsed
   * form, and its skins' meshes (LoadDeformableMesh's cache) unless a suit
   * still loaded names them. Textures are DDDTextureMgr's and stay. A suit a
   * dressing wears is never unloaded (Suit::CanUnload).
   */
  tryUnloadSuits(now: number): void {
    if (!(this.lastUnloadPass < now)) return;
    this.lastUnloadPass = now;
    const dropped: Suit[] = [];
    for (const [k, s] of this.suits) {
      if (!s.canUnload(now)) continue;
      this.suits.delete(k);
      const file = this.suitFile.get(s);
      if (file !== undefined) this.cmxCache.delete(file);
      this.suitFile.delete(s);
      dropped.push(s);
    }
    if (dropped.length === 0) return;
    const kept = new Set<string>();
    for (const s of this.suits.values()) for (const skin of s.skins) kept.add(skin.meshName.toLowerCase());
    for (const s of dropped) {
      for (const skin of s.skins) {
        const m = skin.meshName.toLowerCase();
        if (!kept.has(m)) this.meshCache.delete(m);
      }
    }
  }

  /**
   * VBAnimMgr::TryUnloadAll(now) (CPState::SetMode on entering Live mode):
   * TryUnloadSkills(now), then TryUnloadSuits(now). Both passes share the
   * gate lbl_105BADF0 + lbl_105BADEC (0) < now, and the skills pass leaves
   * lbl_105BADF0 at now or above, so the suits pass returns at once (the
   * Mac 103865D0 and Windows 005a0410 builds alike): the game never unloads
   * a suit.
   */
  tryUnloadAll(now: number): void {
    this.tryUnloadSkills(now);
    this.tryUnloadSuits(now);
  }

  private loadSkillData(s: Skill): Promise<boolean> {
    let p = this.skillData.get(s);
    if (!p) {
      p = (async () => {
        const cfp = await this.readFile(`${s.animationName}.cfp`);
        if (cfp) {
          s.loadData(cfp, true);
          return true;
        }
        const bin = await this.readFile(`${s.animationName}.bin`);
        if (bin) {
          s.loadData(bin, false);
          return true;
        }
        console.warn(`Missing CFP file: ${s.animationName}`);
        return false;
      })();
      this.skillData.set(s, p);
    }
    return p;
  }

  /** VBAnimMgr::LoadDeformableMesh. */
  loadDeformableMesh(name: string): Promise<DeformableMesh | null> {
    const k = name.toLowerCase();
    let p = this.meshCache.get(k);
    if (!p) {
      p = (async () => {
        const bmf = await this.readFile(`${k}.bmf`);
        if (bmf) return DeformableMesh.read(bmf);
        const skn = await this.readFile(`${k}.skn`);
        return skn ? DeformableMesh.scan(skn) : null;
      })();
      this.meshCache.set(k, p);
    }
    return p;
  }

  /** Texture bitmap by name (".bmp"). */
  loadTexture(name: string): Promise<RgbaImage | null> {
    const k = name.toLowerCase();
    let p = this.textureCache.get(k);
    if (!p) {
      p = (async () => {
        const b = await this.readFile(`${k}.bmp`);
        if (!b) {
          console.warn(`missing texture ${name}`);
          return null;
        }
        return decodeBmp(b);
      })();
      this.textureCache.set(k, p);
    }
    return p;
  }
}
