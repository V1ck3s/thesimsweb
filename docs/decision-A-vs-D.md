# Decision: Approach A (clean-room reimplementation) vs Approach D (in-browser emulation)

## Context

See `PLAN.md` §4 for the framing. Two approaches stayed on the table:

- **A** — Clean-room reimplementation in TypeScript + Rust/WASM (Simitone-like).
- **D** — Run the original `Sims.exe` inside an emulator compiled to WebAssembly.

## Spike summary

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

✅ Win98 itself runs well in v86 from the snapshot.

### Test 2 — Sims as secondary disk (`hdb`)

| Aspect | Result |
|---|---|
| Setup | 500 MiB FAT32 image, MBR + 1 partition, files copied via `mtools` |
| Outcome | **Win98 crashes** with `Invalid VxD dynamic link call from VMM(06) + 00001B6A to device "C001", service EA4` on cold boot |

❌ v86 wires `hdb` as **primary IDE slave** (same channel as the boot disk). Win98's IFSMGR/IOS does not handle this configuration cleanly in the emulated environment.

### Test 3 — Sims as ISO 9660 CD-ROM (secondary IDE master)

| Aspect | Result |
|---|---|
| Setup | ~393 MiB ISO 9660 with Joliet, attached via `cdrom` slot |
| Quick boot (snapshot) + CD | **Crash**: `set_state` fails with `TypeError: can't access property 0, a is null` — the snapshot was captured without a CD device, restoration is incompatible with adding hardware |
| Cold boot + CD | **Freeze**: Win98 reaches the desktop, mouse stuck on busy cursor, no further activity (verified across 10+ minutes). The CD is not requested by the emulator (0.6 MiB streamed total). |
| Cold boot, **no CD** (control test) | ✅ Works — Win98 boots and the desktop is usable |

❌ The freeze is reproducible specifically when a CD is attached at cold boot. Most likely cause: Plug-and-Play detects the previously-unseen CD-ROM hardware and **blocks on driver installation** (Win98 wants to install an ATAPI driver from `.cab` files that aren't present in the copy.sh image — first-boot install dialog hung off-screen or waiting on user input).

## Pass criteria (from PLAN.md §0bis)

- ≥ 25 FPS sustained on a furnished lot — **never reached the game**
- Audio without major glitches — **never tested**
- Input latency under 100 ms — **never tested**
- ISO downloadable in chunks under ~1.5 GiB total — N/A
- Stable for ≥ 10 min without crash — **failed at boot**

Zero criteria reachable. Not a single screen of Sims rendered.

## What it would take to make Approach D work

Realistic remaining paths if we wanted to keep pursuing v86:

1. **Build our own Win98 image from scratch** in QEMU: install Win98 SE + DirectX 6 + Sims pre-installed, then export as v86-compatible image. ~half a day of manual work, requires legal Win98 media, ships a multi-hundred-MiB image we'd need to host. Even successful, we still face DirectX 6 software-rendering perf concerns and the unsolved audio stack (Miles Sound System).
2. **Modify the copy.sh image** to register an ATAPI driver beforehand so the new-hardware install doesn't hang. Requires writing into a live FAT volume and editing the registry — fragile.
3. **Hot-insert the CD after boot** via v86's runtime API. May trigger the same install dialog.

All three paths leave us with the same downstream uncertainties around DirectX 6, audio, performance under WASM JIT, and a 600+ MiB initial image to ship. The cost is now higher than the reimplementation itself.

## Verdict

**Approach D is rejected.** **Approach A** (clean-room reimplementation in TypeScript + Rust/WASM, Simitone-like) is retained as the project direction.

Authenticity guarantees stay as defined in PLAN.md §4.4:

1. Niotso wiki specs as primary reference.
2. Simitone / FreeSO / SneakyLib code read for understanding (clean-room — no copying).
3. Original game running in parallel (under Wine or Win11) as observation oracle.
4. Differential tests against TS1-FAR-Unpack, IFFSnooper, Simitone.

The spike is not wasted: the FAR/IFF parser work in Phase 2 is needed regardless, and the Sims ISO image we built is useful as a self-contained test fixture for asset loading.

## Date

Decided 2026-05-01 after Phase 0bis spike.
