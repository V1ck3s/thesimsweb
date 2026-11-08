/**
 * The installation check: a game folder compared with the reference list of
 * a complete install of The Sims (public/gamefiles-reference.json, paths and
 * sizes only, written by scripts/gamefiles-reference.mjs from the Complete
 * Collection). Not part of the original. Used by the landing page, on the
 * server's game folder (its /api/manifest) or on the files imported into this
 * browser (engine/gamefiles.ts); scripts/check-game.mjs does the same from
 * the command line.
 *
 * A missing file is "game" (the program's data: the archives, GameData,
 * UIGraphics, the templates, the sounds) or "content" (skins, music, TV and
 * radio sounds: the game runs without them, with less). A file whose size
 * differs is reported apart: an install in another language or version has
 * some, a damaged copy too.
 */

export interface GameReference {
  /** The install the list was made from. */
  source: string;
  /** [path relative to the install folder, size in bytes or -1 for any]. */
  files: Array<[string, number]>;
}

export interface GameCheck {
  /** Files of the reference. */
  total: number;
  /** Reference files found. */
  present: number;
  /** Missing program data, by path. */
  missingGame: string[];
  /** Missing skins, music and sounds, by path. */
  missingContent: string[];
  /** Present with another size than the reference's. */
  otherSize: string[];
  source: string;
}

let reference: Promise<GameReference> | null = null;

/** The reference list (fetched once). */
export function loadGameReference(): Promise<GameReference> {
  reference ??= fetch("/gamefiles-reference.json").then(async (r) => {
    if (!r.ok) throw new Error(`gamefiles-reference.json: HTTP ${r.status}`);
    return (await r.json()) as GameReference;
  });
  reference.catch(() => (reference = null));
  return reference;
}

/** Skins, music and the TV / radio / ambient sounds: the game runs without them. */
export function isContentFile(path: string): boolean {
  const p = path.toLowerCase();
  return p.startsWith("music/") || /(^|\/)(skins|skinsbuy|tvstations)\//.test(p);
}

/**
 * Compares `files` (paths relative to the install folder, any case: the game
 * folder is case-insensitive) with the reference.
 */
export function checkGameFiles(files: Iterable<{ path: string; size: number }>, ref: GameReference): GameCheck {
  const sizes = new Map<string, number>();
  for (const f of files) sizes.set(f.path.toLowerCase(), f.size);
  const check: GameCheck = { total: ref.files.length, present: 0, missingGame: [], missingContent: [], otherSize: [], source: ref.source };
  for (const [path, size] of ref.files) {
    const have = sizes.get(path.toLowerCase());
    if (have === undefined) {
      (isContentFile(path) ? check.missingContent : check.missingGame).push(path);
      continue;
    }
    check.present++;
    if (size >= 0 && have !== size) check.otherSize.push(path);
  }
  return check;
}

/** The folders holding `paths`, with how many of them each holds, most first. */
export function groupByFolder(paths: readonly string[]): Array<{ folder: string; count: number; names: string[] }> {
  const groups = new Map<string, string[]>();
  for (const p of paths) {
    const i = p.lastIndexOf("/");
    const folder = i < 0 ? "" : p.slice(0, i);
    let g = groups.get(folder);
    if (!g) groups.set(folder, (g = []));
    g.push(p.slice(i + 1));
  }
  return [...groups].map(([folder, names]) => ({ folder, count: names.length, names })).sort((a, b) => b.count - a.count || a.folder.localeCompare(b.folder));
}
