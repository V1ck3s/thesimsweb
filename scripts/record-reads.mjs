#!/usr/bin/env node
// Records what the game downloads, for scripts/preload-list.mjs: every POST
// /api/ranges batch and GET /assets/ read, by phase (one URL each, in one
// browser profile), as [phase, "range" | "get", path, start, end].
//
//   PROFILE=<empty dir> node scripts/record-reads.mjs reads.json 15000 \
//     "http://localhost:3000/game.html?nbhd=UserData36" "http://localhost:3000/game.html?nbhd=UserData36&house=5"
//
// Needs playwright-core (not a dependency of the project: `npm i playwright-core`
// next to it) and Chrome at /usr/bin/google-chrome. A phase ends once no read was
// made for <quietMs>. Use a throwaway neighborhood (UserData36), never the player's.
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";
const [out, quiet, ...urls] = process.argv.slice(2);
const ctx = await chromium.launchPersistentContext(process.env.PROFILE, { executablePath: "/usr/bin/google-chrome", args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"], viewport: { width: 1024, height: 768 } });
const p = ctx.pages()[0] ?? (await ctx.newPage());
let phase = ""; const reads = []; let last = Date.now();
p.on("request", (r) => {
  const u = new URL(r.url());
  if (u.pathname === "/api/ranges" && r.method() === "POST") { last = Date.now(); for (const [path, s, e] of JSON.parse(r.postData()).ranges) reads.push([phase, "range", path, s, e]); }
  else if (u.pathname.startsWith("/assets/")) { last = Date.now(); reads.push([phase, "get", decodeURIComponent(u.pathname.slice(8)), r.headers().range ?? "", 0]); }
});
p.on("response", async (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/assets/") && !r.request().headers().range) { const len = Number((await r.allHeaders())["content-length"] ?? 0); const x = reads.findLast((v) => v[1] === "get" && v[2] === decodeURIComponent(u.pathname.slice(8))); if (x) x[4] = len; } });
p.on("pageerror", (e) => console.log("pageerror:", e.message));
for (const url of urls) {
  phase = url; const t0 = Date.now(); last = Date.now();
  await p.goto(url);
  // intro movie: a click skips it
  for (let i = 0; i < 6; i++) { await p.waitForTimeout(1500); await p.mouse.click(5, 5).catch(() => {}); }
  while (Date.now() - last < +quiet && Date.now() - t0 < 600000) await p.waitForTimeout(1000);
  await p.screenshot({ path: out.replace(/\.json$/, `-${urls.indexOf(url)}.png`) });
  console.log(url, "done in", Date.now() - t0, "ms,", reads.filter((r) => r[0] === url).length, "reads");
}
writeFileSync(out, JSON.stringify(reads));
await ctx.close();
