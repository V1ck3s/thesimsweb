/**
 * The EA intro movie of the startup (Windows build: cSimsApp::Init and
 * FUN_004ef759; Mac: SimsPlayIntroMovies, cTSGraphicSystemW95's intro movie).
 *
 * - cSimsApp::Init clears the skip flag (DAT_006f29f7) and sets it when the
 *   command line has "skip_intro" (here `?skip_intro`); otherwise the movie
 *   plays over the splash screen at every start, and cSimsApp's
 *   IntroMovieEnded (Windows FUN_004ef9ba) then starts the load (StartSlowInit)
 *   and the load music (StartLoadMusic).
 * - The movie is Music/eag_<lang>.avi by the game language (cSimsApp +100):
 *   3 fr, 4 de, 5 it, 6 sp, 7 du, 8 dn, 9 sw, 0xb fi, 0xe br, 0x10 po, any
 *   other us (eag_no.avi ships but Norwegian gets eag_us.avi). A second play
 *   in the same run would take Music/simsintro.avi; the game plays it once.
 * - It fills the game window's client rect (DirectShow stream blitted to
 *   GetClientRect; the Mac sets the movie box to the game screen bounds).
 * - A mouse click or a key stops it (cTSMainWindowW95::TSOnMouseDownL /
 *   TSOnKeyDown -> cTSGraphicSystemW95::StopMovie).
 *
 * The AVIs are MS-MPEG4 v1 that browsers cannot decode: the server serves
 * them transcoded (server/src/routes/movies.ts, only when it has ffmpeg).
 * Without it, or offline, the movie is skipped. Browsers refusing to start
 * a sound before any user input get the movie muted.
 */

import { UI_LANGUAGE } from "../res/uires.js";

/** FUN_004ef759's switch on the language: the movie's suffix. */
const MOVIE_LANGUAGE: Readonly<Record<number, string>> = {
  0x3: "fr",
  0x4: "de",
  0x5: "it",
  0x6: "sp",
  0x7: "du",
  0x8: "dn",
  0x9: "sw",
  0xb: "fi",
  0xe: "br",
  0x10: "po",
};

/** Music/eag_<lang>.avi for a game language. */
export function introMovieName(lang: number): string {
  return `eag_${MOVIE_LANGUAGE[lang] ?? "us"}.avi`;
}

/** Plays the intro over `canvas` (the game window); resolves when it ends, is stopped or cannot play. */
export async function playIntroMovie(canvas: HTMLCanvasElement): Promise<void> {
  if (new URLSearchParams(location.search).has("skip_intro")) return;
  const res = await fetch(`/api/movie/${introMovieName(UI_LANGUAGE)}`).catch(() => null);
  if (!res?.ok) return;
  const blob = await res.blob().catch(() => null);
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.src = url;
  video.playsInline = true;
  Object.assign(video.style, { position: "fixed", objectFit: "fill", background: "#000", cursor: "none", zIndex: "1" });
  const place = (): void => {
    const r = canvas.getBoundingClientRect();
    Object.assign(video.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  };
  place();
  document.body.appendChild(video);
  window.addEventListener("resize", place);
  let stop = (_e: Event): void => {};
  try {
    await new Promise<void>((done) => {
      stop = (e: Event): void => {
        e.preventDefault();
        e.stopPropagation();
        done();
      };
      window.addEventListener("keydown", stop, { capture: true });
      video.addEventListener("pointerdown", stop);
      video.addEventListener("ended", () => done());
      video.addEventListener("error", () => done());
      video.play().catch(() => {
        video.muted = true;
        video.play().catch(() => done());
      });
    });
  } finally {
    window.removeEventListener("resize", place);
    window.removeEventListener("keydown", stop, { capture: true });
    video.pause();
    video.remove();
    URL.revokeObjectURL(url);
  }
}
