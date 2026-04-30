# Decision: Approach A (clean-room reimplementation) vs Approach D (in-browser emulation)

> Live document — fill in as the spike runs. Final verdict at the bottom.

## Context

See `PLAN.md` §4 for the framing. Two approaches stayed on the table:

- **A** — Clean-room reimplementation in TypeScript + Rust/WASM (Simitone-like).
- **D** — Run the original `Sims.exe` inside an emulator compiled to WebAssembly.

## Spike scope

We benchmarked the two browser-side x86 emulators that came up as serious candidates:

- **Boxedwine** (Wine + Linux kernel emulated)
- **v86** (full PC hardware emulator, x86 → WASM JIT)

`retrowin32` was excluded upfront for being too immature for DirectX 6 games (per [its author's notes](https://neugierig.org/software/blog/2022/10/retrowin32.html)).

## Boxedwine

| Aspect | Result |
|---|---|
| Tested by | User (manually, on official demo apps) |
| Demo tested | Age of Empires (less demanding than Sims) |
| Verdict | **Disqualified** — already too slow on simpler titles |

No further benchmark needed: if AoE is unplayable, Sims is hopeless.

## v86

### Test 1 — Win98 snapshot, no Sims

| Aspect | Result |
|---|---|
| Setup | Public Win98 image + state file from `i.copy.sh` |
| Boot time | ~5 s from snapshot |
| Mouse / desktop responsiveness | Fluid (user observation) |
| Page liveness | rAF stable at monitor refresh rate (144 fps) |

✅ Win98 itself runs well in v86.

### Test 2 — Sims as secondary disk (`hdb`)

| Aspect | Result |
|---|---|
| Setup | 500 MiB FAT32 image, MBR + 1 partition, files copied with `mtools` |
| Result | **Win98 crashes** with `Invalid VxD dynamic link call from VMM(06) + 00001B6A to device "C001", service EA4` on cold boot |

❌ v86's `hdb` slot puts the second disk as **primary IDE slave** (same channel as the boot disk). Win98's IFSMGR/IOS does not handle this configuration cleanly in the emulated environment.

### Test 3 — Sims as ISO 9660 CD-ROM (secondary IDE master)

| Aspect | Result |
|---|---|
| Setup | ~410 MiB ISO 9660 with Joliet, attached via `cdrom` slot |
| Quick boot (snapshot + cold-attached CD) | _to fill_ |
| Cold boot (Win98 from scratch + CD) | _to fill_ |
| `Sims.exe` launch | _to fill_ |
| Title screen / main menu FPS | _to fill_ |
| Furnished lot FPS | _to fill_ |
| Audio | _to fill_ |
| Mouse latency | _to fill_ |
| Total bytes streamed for one play session | _to fill_ |
| Stability over 10 min | _to fill_ |

## Pass criteria for Approach D

- ≥ 25 FPS sustained on a furnished lot
- Audio without major glitches
- Input latency under 100 ms
- ISO downloadable in chunks under ~1.5 GiB total
- Stable for ≥ 10 min without crash

A single criterion missed → fall back to Approach A.

## Verdict

_To be filled at the end of test 3._
