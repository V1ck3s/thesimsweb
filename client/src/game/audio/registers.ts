/**
 * HIT register numbers, named as in the shipped symbol files
 * (SoundData/SimsSound.hsm). Register sets (cRegisterSet chains, cHitMan::Init):
 *  - 0x01..0x10 arguments and scratch (arg1..4, v1..v8, h1..h4), per player;
 *  - 0x11..0x2f track attributes, per player, defaults from the track
 *    definition then from the global table (TRACK_DEFAULTS);
 *  - 0x32..0x3e patch attributes, per player (PATCH_ATTR_DEFAULTS);
 *  - 0x5a..0x7f globals shared by every track (cHitMan::SetRegister).
 */
export const R = {
  arg1: 0x01,
  arg2: 0x02,
  arg3: 0x03,
  arg4: 0x04,
  priority: 0x11,
  vol: 0x12,
  extvol: 0x13,
  pan: 0x14,
  pitch: 0x15,
  paused: 0x16,
  duckpri: 0x19,
  Is3d: 0x1a,
  IsHeadRelative: 0x1b,
  X: 0x1e,
  Y: 0x1f,
  Z: 0x20,
  IsStreamed: 0x26,
  fade_dest: 0x28,
  fade_var: 0x29,
  fade_speed: 0x2a,
  Preload: 0x2b,
  IsLooped: 0x2c,
  fade_on: 0x2d,
  isplaying: 0x2e,
  source: 0x2f,
  patch: 0x32,
  target: 0x35,
  interrupt: 0x37,
  Spl: 0x39,
  SimSpeed: 0x64,
  main_songnum: 0x6e,
  main_musichitlistid: 0x6f,
  main_duckpri: 0x7b,
  main_vol: 0x7c,
} as const;

export const GLOBAL_FIRST = 0x5a;

/** lbl_105BACAC (track attributes, base 0x11), set by cHitMan::Init. */
export const TRACK_DEFAULTS = new Map<number, number>([
  [0x11, 0x20],
  [0x12, 0x400],
  [0x13, 0x400],
  [0x14, 0x200],
  [0x15, 0xe10],
  [0x1c, 100],
  [0x1d, 10000],
  [0x27, 1],
]);

/** lbl_105BAC90 (patch attributes, base 0x32). */
export const PATCH_ATTR_DEFAULTS = new Map<number, number>([
  [0x34, 0x78],
  [0x39, 0x14],
]);

/** lbl_105BAC78 copied into the global set (base 0x71). */
export const GLOBAL_DEFAULTS = new Map<number, number>([[0x7c, 0x400]]);
