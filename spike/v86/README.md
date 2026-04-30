# Spike v86 — feasibility of running The Sims through emulated Win98

## Goal

Decide whether **Approach D** (run the original `Sims.exe` inside an emulated Win98 in the browser via [v86](https://github.com/copy/v86)) is viable for the project, or whether we fall back to **Approach A** (clean-room reimplementation).

See `PLAN.md` §4 in the repo root for the full context.

## Status

- **Boxedwine**: disqualified (user tested empirically — too slow on official demos).
- **v86**: under test here.

## Setup (once)

```bash
# from spike/v86/
./setup.sh
```

This installs the `v86` npm package, shallow-clones the v86 source for its BIOS files, and copies them to `bios/`. Idempotent.

## Test 1 — vanilla Win98 boot

```bash
# from spike/v86/
npm run serve
# → http://localhost:8080/
```

Then open `http://localhost:8080/` in **Firefox** and click *Start Windows 98*.

Image and snapshot are streamed from `i.copy.sh` (the official v86 CDN). The state file restores a Win98 desktop in a few seconds, no install needed.

What to check :
- [ ] Does the desktop come up within ~30 seconds?
- [ ] Is the mouse responsive?
- [ ] Does opening the Start menu / a folder feel snappy?
- [ ] Try launching a small included app (e.g. *Hover!* or *FreeCell* if present).

If this is already painful, Sims has zero chance.

## Test 2 — Sims injected via secondary disk

(To set up after test 1 succeeds.)

Plan:
1. Build a FAT16 disk image containing the `Les Sims/` folder + a small `setup.bat`.
2. Mount as `hdb` in v86.
3. Inside Win98, copy `D:\Les Sims\` → `C:\Maxis\Les Sims\`.
4. Run `Sims.exe` (the no-CD crack).
5. Measure FPS, audio quality, input latency, RAM usage, total bytes streamed.

## Files

- `index.html` — minimal harness that boots Win98 from `i.copy.sh`.
- `bios/` — SeaBIOS + VGA BIOS copied from `v86-source/bios/`.
- `node_modules/v86/` — the v86 emulator (npm package).
- `v86-source/` — full source clone, kept for docs and future tweaks (gitignored).
