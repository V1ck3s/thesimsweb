/**
 * Dev test: the SimAntics interpreter on a real lot, headless.
 * `?test=sim&house=UserData/Houses/House01.iff&ticks=600`
 * Loads the house's objects, builds the Simulator (saved tree stacks, Load
 * trees), runs `ticks` ticks and prints a per-object trace: current tree and
 * node, stack depth, primitives run, errors, idle counter; then the
 * primitive histogram, the unported features hit and the recorded events.
 * The result is also in `window.simTest`.
 */

import type { GameContext } from "../../context.js";
import { primitiveName } from "../../sim/names.js";
import { PersonSim } from "../../sim/person.js";
import { skillsSettled } from "../../sim/personanim.js";
import { Simulator } from "../../sim/simulator.js";
import type { WinMgr } from "../../ui/winmgr.js";
import { ResFile } from "../../world/iffres.js";
import { loadLotObjects, type XObject } from "../../world/objects.js";

export async function mount(_ctx: GameContext, _mgr: WinMgr): Promise<void> {
  const q = new URLSearchParams(location.search);
  const housePath = q.get("house") ?? "UserData/Houses/House01.iff";
  const ticks = Number(q.get("ticks") ?? 600);
  const pre = document.createElement("pre");
  pre.style.cssText = "position:absolute;inset:0;margin:0;padding:8px;overflow:auto;background:#111;color:#ddd;font:12px monospace;z-index:10";
  document.body.appendChild(pre);
  const out = (s: string): void => {
    pre.textContent += `${s}\n`;
  };
  out(`house ${housePath}, ${ticks} ticks`);
  const house = await ResFile.open(housePath);
  const objects = (await loadLotObjects(house)) as Map<number, XObject>;
  const t0 = performance.now();
  const sim = await Simulator.create(house, objects.values());
  const t1 = performance.now();
  const g = sim.globals;
  out(`loaded ${sim.module.list.length} objects (${sim.module.people.length} people) in ${(t1 - t0).toFixed(0)} ms; load errors ${sim.loadErrors.size}`);
  out(`clock ${g[0]}:${String(g[5]).padStart(2, "0")} day ${g[1]}/${g[7]}/${g[8]}, funds ${sim.funds}, speed ${g[16]} (${sim.period} ms/tick)`);
  out(`saved state: paused ${g[17]}, mode freeze ${g[19]}, house ${g[10]} -> running in live mode, unpaused`);
  sim.resume();
  g[19] = 0;
  for (const p of sim.module.persons) p.traceOn = true;
  for (const p of sim.module.persons) {
    const m = p.motives;
    out(`person ${p.id} ${p.obj.selector.name}: nb ${p.pd[0x1f]} age ${p.pd[0x3a]} motives ${[3, 5, 6, 7, 8, 9, 11, 13, 14, 15].map((i) => `${i}:${m[i]!.toFixed(1)}`).join(" ")} stack ${p.getStackSize()} ${p.behavior.getTreeName(p.getCurElem()?.getTreeID() ?? 0)}`);
  }
  let advanced = 0;
  // Skills load asynchronously: let them arrive every 10 ticks.
  for (let i = 0; i < ticks; i++) {
    if (sim.simulateOneTick()) advanced++;
    if (i % 10 === 9) await skillsSettled();
  }
  const t2 = performance.now();
  out(`ran ${ticks} ticks (${advanced} advanced the clock) in ${(t2 - t1).toFixed(0)} ms -> ${g[0]}:${String(g[5]).padStart(2, "0")}:${String(g[6]).padStart(2, "0")}`);
  out("");
  out("  id name                             tree                                  node depth   prims err  idle flags");
  const rows = sim.trace();
  for (const r of rows) {
    out(
      `${String(r.id).padStart(4)} ${r.name.slice(0, 32).padEnd(32)} ${r.tree.slice(0, 37).padEnd(37)} ${String(r.node).padStart(4)} ${String(r.depth).padStart(5)} ${String(r.prims).padStart(7)} ${String(r.errors).padStart(3)} ${String(r.idle).padStart(5)} ${r.flags.toString(16).padStart(5)}`,
    );
  }
  const hist = new Map<number, number>();
  const errs = new Map<number, number>();
  for (const o of sim.module.list) {
    for (const [op, n] of o.primCounts) hist.set(op, (hist.get(op) ?? 0) + n);
    for (const e of o.errors) errs.set(e.code, (errs.get(e.code) ?? 0) + 1);
  }
  out("");
  out("primitives run:");
  for (const [op, n] of [...hist].sort((a, b) => b[1] - a[1])) out(`  ${String(op).padStart(3)} ${primitiveName(op).padEnd(32)} ${n}`);
  out("");
  out(`errors by code: ${[...errs].map(([c, n]) => `${c}(0x${c.toString(16)}) x${n}`).join(", ") || "none"}`);
  const failing = sim.module.list.filter((o) => o.errors.length);
  for (const o of failing.slice(0, 40)) {
    const e = o.errors[0]!;
    out(`  ${o.id} ${o.obj.selector.name}: code 0x${e.code.toString(16)} in tree ${e.tree} ${o.behavior.getTreeName(e.tree)} node ${e.node} (x${o.errors.length})`);
  }
  for (const p of sim.module.persons) {
    const m = p.motives;
    out("");
    out(`person ${p.id} ${p.obj.selector.name}: motives ${[3, 5, 6, 7, 8, 9, 11, 13, 14, 15].map((i) => `${i}:${m[i]!.toFixed(1)}`).join(" ")}`);
    const frames: string[] = [];
    for (let i = 0; i < p.getStackSize(); i++) {
      const e = p.getNthElem(i)!;
      frames.push(`${e.behavior?.getTreeName(e.getTreeID()) ?? "?"}(${e.getTreeID()}):${e.node}`);
    }
    out(`  stack: ${frames.join(" > ")}`);
    out(`  last trace: ${p.trace.slice(-30).join(" | ")}`);
    for (const a of p.autonomyLog.filter((l) => !/find nap piece\(8196\):[67] /.test(l)).slice(0, 150)) out(`  autonomy: ${a}`);
  }
  out("");
  out("not ported (hits):");
  for (const [k, n] of sim.module.unported) out(`  ${k}: ${n}`);
  out("");
  const kinds = new Map<string, number>();
  for (const e of sim.module.events) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
  out(`recorded events: ${[...kinds].map(([k, n]) => `${k} x${n}`).join(", ") || "none"}`);
  const summary = {
    objects: sim.module.list.length,
    people: sim.module.people.length,
    ticking: rows.filter((r) => r.flags & 1).length,
    loadErrors: sim.loadErrors.size,
    advanced,
    prims: Object.fromEntries(hist),
    errors: Object.fromEntries(errs),
    unported: Object.fromEntries(sim.module.unported),
    events: Object.fromEntries(kinds),
    clock: [g[0], g[5], g[6]],
  };
  (window as unknown as { simTest: unknown }).simTest = { sim, summary, PersonSim };
  out("");
  out("done");
}
