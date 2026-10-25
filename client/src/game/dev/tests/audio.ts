/**
 * Dev test: the sound system (cSoundPlayer / cBoxX / cHitMan).
 *
 * A DOM panel lists the UI events, the mode music and the radio stations;
 * click to play (the first click also unlocks the browser's AudioContext).
 * A game button (TSWinBtn) is mounted too, to hear the cTSWinBtn sounds.
 *
 * `window.audioTest` exposes checks for the headless driver:
 *   audioTest.status()              loaded data, active tracks, recent files, errors
 *   await audioTest.analyzeUI()     decode every ui_* event's sample: duration, peak, rms, NaN
 *   await audioTest.analyze(path)   the same for one game file
 *   audioTest.play(name, source)    PlayBySource
 *   audioTest.mode(n)               cGameModeManager mode (3 hood, 1 buy, 2 build, 0 live)
 */

import { getOptionsMgr } from "../../optionsmgr.js";
import type { GameContext } from "../../context.js";
import { audioContext, loadBuffer } from "../../audio/audiosys.js";
import { MODE } from "../../audio/boxx.js";
import { SampleChannel, SamplePatch } from "../../audio/samplepatch.js";
import { soundPlayer } from "../../audio/soundplayer.js";
import { Track } from "../../audio/trackplayer.js";
import { UI } from "../../audio/uisound.js";
import { TSWinBtn } from "../../ui/btn.js";
import type { WinMgr } from "../../ui/winmgr.js";

interface SampleStats {
  path: string;
  duration: number;
  sampleRate: number;
  channels: number;
  peak: number;
  rms: number;
  nan: number;
}

async function analyze(path: string): Promise<SampleStats> {
  const buf = await loadBuffer(path);
  let peak = 0;
  let sum = 0;
  let nan = 0;
  let n = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const v = d[i]!;
      if (Number.isNaN(v)) {
        nan++;
        continue;
      }
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sum += v * v;
      n++;
    }
  }
  return {
    path,
    duration: Math.round(buf.duration * 1000) / 1000,
    sampleRate: buf.sampleRate,
    channels: buf.numberOfChannels,
    peak: Math.round(peak * 1000) / 1000,
    rms: Math.round(Math.sqrt(sum / Math.max(1, n)) * 10000) / 10000,
    nan,
  };
}

/** Event name -> the patch its track plays first (static: track's default patch). */
function eventPatch(name: string): string | null {
  const boxx = soundPlayer.boxx!;
  const ev = boxx.mappedEvent(name);
  if (!ev) return null;
  const t = boxx.hm.soundObject(ev.arg);
  if (!(t instanceof Track)) return null;
  const p = boxx.hm.soundObject(t.def.patch);
  return p instanceof SamplePatch ? p.path : null;
}

function status(): unknown {
  const boxx = soundPlayer.boxx;
  if (!boxx) return { ready: false };
  return {
    ready: true,
    context: audioContext().state,
    loaded: boxx.loaded,
    volumes: boxx.getVolumes(),
    mode: boxx.modes.mode,
    time: boxx.hm.time,
    active: boxx.hm.activePlayers().map((p) => ({
      track: p.def.id,
      name: p.def.name,
      patch: p.currentPatch()?.path ?? null,
      sounding: p.channelPlaying(),
    })),
    recent: SampleChannel.playLog.slice(-10).map((e) => e.path),
    errors: boxx.hm.errors.slice(-10),
  };
}

export async function mount(ctx: GameContext, mgr: WinMgr): Promise<void> {
  const options = getOptionsMgr();
  await soundPlayer.initialize(options);
  const boxx = soundPlayer.boxx!;

  const api = {
    status,
    analyze,
    async analyzeUI(): Promise<{ events: number; files: SampleStats[]; failed: string[] }> {
      const names = boxx.eventNames().filter((n) => n.startsWith("ui_"));
      const files: SampleStats[] = [];
      const failed: string[] = [];
      const seen = new Set<string>();
      for (const n of names) {
        const path = eventPatch(n);
        if (!path) {
          failed.push(`${n}: no patch`);
          continue;
        }
        if (seen.has(path.toLowerCase())) continue;
        seen.add(path.toLowerCase());
        try {
          files.push(await analyze(path));
        } catch (e) {
          failed.push(`${n}: ${String(e)}`);
        }
      }
      return { events: names.length, files, failed };
    },
    play: (name: string, source = -4) => soundPlayer.playBySource(name, source),
    mode: (m: number) => boxx.modes.setMode(m),
    eventPatch,
    events: () => boxx.eventNames(),
  };
  (window as unknown as { audioTest: typeof api }).audioTest = api;

  // A real game button: press = UI_click, press while disabled = UI_error.
  const btnImg = await ctx.res.image("kUniversalCPBkg").catch(() => null);
  if (btnImg) {
    const b = new TSWinBtn(1, btnImg, 1);
    b.setArea(700, 600, 700 + Math.min(200, btnImg.width), 600 + Math.min(100, btnImg.height));
    b.overrideUISound("UI_Nhood_rollover", null, null, null);
    b.uiSoundActions |= 4; // also on mouse enter
    mgr.main.childAdd(b);
  }

  // DOM panel (dev only).
  const panel = document.createElement("div");
  panel.style.cssText =
    "position:fixed;left:8px;top:8px;width:640px;max-height:90vh;overflow:auto;background:rgba(0,0,0,.85);color:#eee;font:12px monospace;padding:8px;z-index:10";
  document.body.appendChild(panel);
  const section = (title: string): HTMLDivElement => {
    const h = document.createElement("div");
    h.textContent = title;
    h.style.cssText = "margin:8px 0 4px;color:#ffd060";
    panel.appendChild(h);
    const d = document.createElement("div");
    panel.appendChild(d);
    return d;
  };
  const button = (parent: HTMLElement, label: string, fn: () => void): void => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = "margin:2px;font:11px monospace";
    b.onclick = fn;
    parent.appendChild(b);
  };

  const ui = section("UI sounds (PlayBySource, source -4)");
  for (const name of Object.values(UI)) button(ui, name, () => soundPlayer.playUISound(name));
  const allUi = section("all ui_* events");
  for (const name of boxx.eventNames().filter((n) => n.startsWith("ui_")).sort()) button(allUi, name, () => soundPlayer.playUISound(name));

  const music = section("mode music (cGameModeManager)");
  for (const [label, m] of [
    ["hood", MODE.Hood],
    ["buy", MODE.Buy],
    ["build", MODE.Build],
    ["live (fade out)", MODE.Live],
    ["family", MODE.Family],
    ["credits", MODE.Credits],
    ["downtown", MODE.Downtown],
    ["vacation", MODE.Vacation],
  ] as const)
    button(music, label, () => boxx.modes.setMode(m));
  button(music, "load music on", () => void soundPlayer.startLoadMusic(options));
  button(music, "load music off", () => soundPlayer.stopLoadMusic());

  const radio = section("radio / TV (object source 1000)");
  for (const ev of ["stereo_country", "stereo_rock", "stereo_jazz", "stereo_classical", "tv_action_cheap", "tv_romance_mod", "tv_cartoon_exp"])
    button(radio, ev, () => soundPlayer.playBySource(ev, 1000));
  button(radio, "next song", () => soundPlayer.playBySource("radio_next_song", 1000));
  button(radio, "off (quiet source)", () => soundPlayer.quietBySourceID(1000));
  button(radio, "kill all", () => soundPlayer.quietAll());

  const vol = section("volumes (cOptionsMgr, 0..10)");
  for (const [label, get, set] of [
    ["fx", () => options.getFXVolume(), (v: number) => options.setFXVolume(v)],
    ["music", () => options.getMusicVolume(), (v: number) => options.setMusicVolume(v)],
    ["vox", () => options.getVoxVolume(), (v: number) => options.setVoxVolume(v)],
  ] as const) {
    const row = document.createElement("div");
    const input = document.createElement("input");
    input.type = "range";
    input.min = "0";
    input.max = "10";
    input.value = String(get());
    input.oninput = () => set(Number(input.value));
    row.append(`${label} `, input);
    vol.appendChild(row);
  }

  const out = section("status");
  const pre = document.createElement("pre");
  pre.style.cssText = "white-space:pre-wrap;margin:0";
  out.appendChild(pre);
  window.setInterval(() => {
    pre.textContent = JSON.stringify(status(), null, 1);
  }, 500);
  console.log("audio test ready", boxx.loaded);
}
